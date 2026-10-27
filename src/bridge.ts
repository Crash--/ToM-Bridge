import type { SynapseAdminApis } from "@vector-im/matrix-bot-sdk";
import { Bridge, type Intent, Logger } from "matrix-appservice-bridge";

import { RabbitMQClient } from "@linagora/rabbitmq-client";

import { createUserDeletedHandler } from "./account-eraser.js";
import { Database } from "./db/index.js";
import {
  DEFAULT_AVATAR_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_AVATAR_BYTES,
  type MatrixApis,
  type MatrixProfile,
  MatrixProfileUpdater,
} from "./matrix-profile-updater.js";
import { MatrixSpaces } from "./matrix-spaces.js";
import { SettingsRepository } from "./settings-repository.js";
import {
  createKeyedLock,
  createSpaceEventHandler,
  type KnownSpace,
  purgeDeletedSpaces,
  requestFirstSync,
  type SpaceClock,
  type SpaceLock,
  type SpaceRegistry,
} from "./space-provisioner.js";
import {
  type BridgeConfig,
  type CommonSettingsMessage,
  createLoggerAdapter,
  type ISettingsPayload,
  MessageParseError,
  type StoredUserSettings,
  SynapseAdminRetryMode,
  UserIdNotProvidedError,
  type UserSettingsTableName,
} from "./types.js";

// =============================================================================
// Message handling helpers (inlined from message-handler.ts)
// =============================================================================

/**
 * Represents a validated and parsed message ready for processing.
 */
interface ParsedMessage {
  userId: string;
  version: number;
  timestamp: number;
  requestId: string;
  source: string;
  payload: ISettingsPayload;
}

/**
 * Validates a CommonSettingsMessage and extracts required fields.
 */
function validateMessage(message: CommonSettingsMessage): ParsedMessage {
  if (!message.request_id) {
    throw new MessageParseError("Message missing required request_id field");
  }
  if (message.timestamp === undefined || message.timestamp === null) {
    throw new MessageParseError("Message missing required timestamp field");
  }
  if (!message.payload?.matrix_id) {
    throw new UserIdNotProvidedError();
  }
  return {
    userId: message.payload.matrix_id,
    version: message.version ?? 1,
    timestamp: message.timestamp,
    requestId: message.request_id,
    source: message.source,
    payload: message.payload,
  };
}

/**
 * Builds an AMQP URL from the structured rabbitmq config.
 */
function buildAmqpUrl(conf: BridgeConfig["rabbitmq"]): string {
  const protocol = conf.tls === true ? "amqps" : "amqp";
  return `${protocol}://${encodeURIComponent(conf.username)}:${encodeURIComponent(conf.password)}@${conf.host}:${conf.port}/${conf.vhost}`;
}

// =============================================================================
// Version management helpers (inlined from version-manager.ts)
// =============================================================================

/**
 * Formats a Unix timestamp (milliseconds) as an ISO 8601 string.
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const SPACE_EVENTS_AT_ONCE = 4;
// Each round means yet another update of the same user was saved meanwhile
const RECONCILE_ROUNDS = 5;

Logger.configure({
  console: (process.env.LOG_LEVEL as "info" | "debug" | "warn" | "error" | "trace" | "off" | undefined) || "info",
});

/**
 * CommonSettingsBridge handles synchronization of user settings between
 * an external system (via AMQP messages) and Matrix user profiles.
 * It listens for settings change messages and updates Matrix display names
 * and avatars accordingly.
 */
export class CommonSettingsBridge {
  readonly #config: BridgeConfig;
  readonly #log: Logger;
  #bridge!: Bridge;
  #botIntent!: Intent;
  #adminApis!: SynapseAdminApis;
  #db!: Database<UserSettingsTableName>;
  #client!: RabbitMQClient;
  #settingsRepository!: SettingsRepository;
  #profileUpdater!: MatrixProfileUpdater;
  #isDatabaseAvailable: boolean = false;
  #purgeTimer?: ReturnType<typeof setInterval>;

  /**
   * Creates a new CommonSettingsBridge instance.
   * @param config - The bridge configuration containing homeserver, database, and RabbitMQ settings
   */
  constructor(config: BridgeConfig) {
    this.#log = new Logger("CommonSettingsBridge");
    this.#log.debug("Initializing CommonSettingsBridge instance");
    this.#config = config;
    this.#initDatabase();
    this.#initRabbitMQClient();
    this.#log.debug("CommonSettingsBridge instance created");
  }

  /**
   * Initializes the database connection with the user settings table schema.
   * The database stores Matrix user IDs mapped to their settings JSON, version number,
   * timestamp, and request_id for idempotency.
   */
  #initDatabase(): void {
    this.#log.debug("Initializing database connection...");

    const dbConfig = {
      database_engine: this.#config.database.engine,
      database_host: this.#config.database.host ?? "localhost",
      database_name: this.#config.database.name,
      database_user: this.#config.database.user,
      database_password: this.#config.database.password,
      database_ssl: this.#config.database.ssl ?? false,
      database_vacuum_delay: this.#config.database.vacuumDelay ?? 3600,
    };

    this.#log.debug(
      `Database config: engine=${dbConfig.database_engine}, host=${dbConfig.database_host}, name=${dbConfig.database_name}, user=${dbConfig.database_user}, ssl=${dbConfig.database_ssl}, vacuumDelay=${dbConfig.database_vacuum_delay}s`,
    );

    const dbLogger = createLoggerAdapter(this.#log, "DB");

    const tables: Record<UserSettingsTableName, string> = {
      usersettings:
        "matrix_id varchar(255) PRIMARY KEY, settings jsonb, version int DEFAULT 1, timestamp bigint DEFAULT 0, request_id varchar(255) DEFAULT '', avatar_source text, avatar_mxc text",
      spaceclock: "clock_key varchar(255) PRIMARY KEY, timestamp bigint",
      spaces:
        "space_id varchar(255) PRIMARY KEY, organization_id varchar(255), room_id varchar(255), timestamp bigint, delete_at bigint DEFAULT 0",
    };

    this.#db = new Database<UserSettingsTableName>(dbConfig, dbLogger, tables);

    // Attach a no-op rejection handler eagerly so a DB that fails before
    // start() awaits `#db.ready` (after the slow bridge init) doesn't surface
    // as an unhandled rejection and kill the process. start() handles the
    // failure itself by falling back to degraded mode.
    this.#db.ready.catch(() => {});

    this.#log.debug("Database instance created");
  }

  /**
   * Initializes the RabbitMQ client. Subscription is established later in
   * `start()` once `init()` has opened the connection and channel.
   */
  #initRabbitMQClient(): void {
    this.#log.debug("Initializing RabbitMQ client...");

    const rabbitConfig = this.#config.rabbitmq;

    this.#log.debug(
      `RabbitMQ config: host=${rabbitConfig.host}, exchange=${rabbitConfig.exchange}, queue=${rabbitConfig.queue}, routingKey=${rabbitConfig.routingKey}`,
    );

    this.#client = new RabbitMQClient({
      url: buildAmqpUrl(rabbitConfig),
      prefetch: rabbitConfig.prefetch,
      maxRetries: rabbitConfig.maxRetries,
      retryDelay: rabbitConfig.retryDelay,
      logger: this.#log,
    });

    this.#log.debug("RabbitMQ client configured");
  }

  /**
   * Creates and configures the Matrix bridge instance.
   * The bridge is configured without an event handler since this service
   * only processes AMQP messages, not Matrix events.
   * @returns The configured Bridge instance
   */
  #initBridge(): Bridge {
    this.#log.debug("Initializing Matrix bridge...");
    this.#log.debug(
      `Bridge config: homeserverUrl=${this.#config.homeserverUrl}, domain=${
        this.#config.domain
      }, registration=${this.#config.registrationPath}`,
    );

    return new Bridge({
      homeserverUrl: this.#config.homeserverUrl,
      domain: this.#config.domain,
      registration: this.#config.registrationPath,
      disableStores: true,
      controller: {
        onEvent: () => {},
        onLog: (text: string, isError: boolean) => {
          if (isError) {
            this.#log.error(`[Bridge] ${text}`);
          } else {
            this.#log.debug(`[Bridge] ${text}`);
          }
        },
      },
    });
  }

  /**
   * Handles incoming AMQP messages containing user settings changes.
   * Implements idempotency checking and version-based ordering.
   * Message JSON parsing is done by the RabbitMQ client; malformed
   * payloads are routed to the DLQ before this handler is invoked.
   * @param message - The parsed settings message
   */
  async #handleMessage(message: Record<string, unknown>): Promise<void> {
    this.#log.debug("Received message");

    // Validation failures are deterministic: re-running on the same bytes will
    // fail the same way. Ack-and-drop instead of throwing, otherwise the client
    // library retries this message `maxRetries` times before DLQ'ing.
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.#log.error("Discarding message: payload root is not a JSON object");
      return;
    }

    let parsed: ParsedMessage;
    try {
      parsed = validateMessage(message as unknown as CommonSettingsMessage);
    } catch (err) {
      if (err instanceof MessageParseError || err instanceof UserIdNotProvidedError) {
        this.#log.error(`Discarding message: validation failed (${(err as Error).message})`);
        return;
      }
      throw err;
    }

    const { userId, version, timestamp, requestId, source, payload } = parsed;

    this.#log.info(
      `Processing update for ${userId} (source=${source}, v=${version}, req=${requestId}, ts=${formatTimestamp(
        timestamp,
      )})`,
    );

    /* Degraded mode - no database available */
    if (!this.#isDatabaseAvailable) {
      this.#log.debug(`Degraded mode: applying update for ${userId} without idempotency checks`);
      await this.#profileUpdater.processChanges(userId, payload);
      this.#log.info(`Successfully processed settings for user: ${userId} (degraded mode)`);
      return;
    }

    let saved: boolean;
    try {
      saved = await this.#settingsRepository.saveIfNewer(userId, payload, version, timestamp, requestId);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.#log.error(`Database error while saving ${userId}: ${errorMsg}`);

      // Switch to degraded mode for future messages
      this.#isDatabaseAvailable = false;
      this.#log.warn("==========================================");
      this.#log.warn("DATABASE ERROR - Switching to degraded mode");
      this.#log.warn("Future messages will bypass idempotency checks");
      this.#log.warn("==========================================");

      this.#log.info(`Processing ${userId} in degraded mode (no idempotency check)`);
      await this.#profileUpdater.processChanges(userId, payload);
      return;
    }

    const latest = await this.#settingsRepository.getUserSettings(userId);
    if (!saved) {
      this.#log.warn(
        latest?.request_id === requestId
          ? `Duplicate message for ${userId} (request_id=${requestId}), reconciling its Matrix profile`
          : `Stale update for ${userId} (stored: version=${latest?.version}, timestamp=${
              latest ? formatTimestamp(latest.timestamp) : "N/A"
            }; new: version=${version}, timestamp=${formatTimestamp(timestamp)}), reconciling its Matrix profile`,
      );
    }
    await this.#reconcile(userId, latest);
    this.#log.info(`Successfully processed settings for user: ${userId}`);
  }

  /**
   * Makes the Matrix profile show the latest settings in the database, the
   * source of truth, whatever became of the message: a failed or late write
   * to Matrix, a crash or a concurrent update may have left it behind them.
   * Writes only what the profile shows otherwise, then reads the settings
   * again until no update was saved meanwhile. Any error fails the message,
   * which is retried.
   */
  async #reconcile(userId: string, first: StoredUserSettings | null): Promise<void> {
    let latest = first;
    for (let round = 0; round < RECONCILE_ROUNDS; round++) {
      if (!latest) {
        return;
      }
      const uploaded = await this.#profileUpdater.reconcile(userId, latest.payload, latest.avatar ?? null);
      if (uploaded) {
        await this.#settingsRepository.saveAvatar(userId, uploaded.source, uploaded.mxc);
      }
      const after = await this.#settingsRepository.getUserSettings(userId);
      if (after?.version === latest.version && after.timestamp === latest.timestamp) {
        return;
      }
      latest = after;
    }
    this.#log.warn(
      `Settings of ${userId} changed during each of ${RECONCILE_ROUNDS} reconciliations, its Matrix profile may still be behind them`,
    );
  }

  /**
   * Converts the string configuration value for admin retry mode to the enum value.
   * Defaults to DISABLED if the configuration value is not recognized.
   * @returns The SynapseAdminRetryMode enum value
   */
  #getAdminRetryMode(): SynapseAdminRetryMode {
    const mode = this.#config.synapse?.adminRetryMode;
    const validModes = Object.values(SynapseAdminRetryMode);
    return validModes.includes(mode as SynapseAdminRetryMode)
      ? (mode as SynapseAdminRetryMode)
      : SynapseAdminRetryMode.DISABLED;
  }

  /**
   * Creates a MatrixApis implementation that wraps the bridge's Matrix operations.
   * @returns MatrixApis implementation
   */
  #createMatrixApis(): MatrixApis {
    return {
      getIntent: (userId: string) => this.#bridge.getIntent(userId),
      adminUpsertUser: async (userId: string, data: Record<string, string>) => {
        await this.#adminApis.upsertUser(userId, data);
      },
      botUploadContent: async (content: Buffer, contentType: string, fileName?: string) => {
        return await this.#botIntent.matrixClient.uploadContent(content, contentType, fileName);
      },
      // As the bot, already registered: an intent of the user would register it first, which a namespace may refuse
      getProfile: (userId: string): Promise<MatrixProfile> => this.#botIntent.getProfileInfo(userId, undefined, false),
    };
  }

  /**
   * Deactivates the account with erasure. A repeat succeeds, and Synapse
   * answers 404 for an account it does not know, which counts as erased.
   */
  async #eraseAccount(matrixId: string): Promise<void> {
    try {
      await this.#botIntent.matrixClient.doRequest(
        "POST",
        `/_synapse/admin/v1/deactivate/${encodeURIComponent(matrixId)}`,
        null,
        {
          erase: true,
        },
      );
    } catch (error) {
      if (
        (
          error as {
            statusCode?: number;
          }
        ).statusCode !== 404
      ) {
        throw error;
      }
      this.#log.warn(`Synapse does not know ${matrixId}, nothing to erase`);
    }
  }

  /**
   * Spaces need the database, and never read the degraded mode of the
   * settings: an event the database cannot answer fails and is retried, since
   * applied without its checks it could undo a newer one or revive a deleted space.
   */
  #createSpaceClock(): SpaceClock {
    return {
      latest: async (key) => {
        const rows = await this.#db.get(
          "spaceclock",
          [
            "timestamp",
          ],
          {
            clock_key: key,
          },
        );
        return rows.length > 0 ? Number(rows[0]?.timestamp) : null;
      },
      record: async (key, timestamp) => {
        // The change is already on the homeserver, so a failed write only loses the ordering check for this key
        try {
          const updated = await this.#db.update(
            "spaceclock",
            {
              timestamp,
            },
            "clock_key",
            key,
          );
          if (updated.length === 0) {
            await this.#db.insert("spaceclock", {
              clock_key: key,
              timestamp,
            });
          }
        } catch (error) {
          this.#log.warn(`Could not record ${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  /**
   * One event per space at a time: in this pod, then across the pods through
   * the database. An event the database cannot lock fails and is retried:
   * applied without the lock, it could run beside the pod that holds it.
   */
  #createSpaceLock(): SpaceLock {
    const inThisPod = createKeyedLock();
    return (key, fn) => inThisPod(key, () => this.#db.withLock(key, fn));
  }

  /** The Matrix space of each space, and when it is due for deletion. */
  #createSpaceRegistry(): SpaceRegistry {
    const fields = [
      "space_id",
      "organization_id",
      "room_id",
      "timestamp",
      "delete_at",
    ];
    const toSpace = (row: Record<string, unknown>): KnownSpace => ({
      spaceId: String(row.space_id),
      organizationId: String(row.organization_id),
      roomId: row.room_id ? String(row.room_id) : null,
      timestamp: Number(row.timestamp),
    });
    const rowOf = (space: KnownSpace): Record<string, string | number> => ({
      organization_id: space.organizationId,
      room_id: space.roomId ?? "",
      timestamp: space.timestamp,
    });
    const upsert = async (space: KnownSpace, values: Record<string, string | number>): Promise<void> => {
      const updated = await this.#db.update("spaces", values, "space_id", space.spaceId);
      if (updated.length === 0) {
        await this.#db.insert("spaces", {
          space_id: space.spaceId,
          delete_at: 0,
          ...values,
        });
      }
    };
    return {
      remember: (space) =>
        upsert(space, {
          ...rowOf(space),
          delete_at: 0,
        }),
      deletionOf: async (spaceId) => {
        const rows = await this.#db.get(
          "spaces",
          [
            "delete_at",
          ],
          {
            space_id: spaceId,
          },
        );
        const deleteAt = Number(rows[0]?.delete_at ?? 0);
        return deleteAt > 0 ? deleteAt : null;
      },
      scheduleDeletion: async (space, at) => {
        await upsert(space, {
          ...rowOf(space),
          delete_at: at,
        });
      },
      spacesOf: async (organizationId) => {
        const rows = await this.#db.get("spaces", fields, {
          organization_id: organizationId,
        });
        return rows.filter((row) => Number(row.delete_at) === 0).map(toSpace);
      },
      dueBy: async (time) => {
        const rows = await this.#db.getHigherThan("spaces", fields, {
          delete_at: 0,
        });
        return rows.filter((row) => Number(row.delete_at) <= time).map(toSpace);
      },
      forget: async (spaceId) => {
        await this.#db.deleteEqual("spaces", "space_id", spaceId);
      },
      hasSpaces: async (organizationId) => {
        const rows = organizationId
          ? await this.#db.get("spaces", fields, {
              organization_id: organizationId,
            })
          : await this.#db.getAll("spaces", fields);
        return rows.length > 0;
      },
    };
  }

  /**
   * Starts the bridge service.
   * Initializes the Matrix bridge, caches bot intent and admin APIs,
   * verifies admin privileges, waits for database readiness,
   * and starts the AMQP connector.
   */
  async start(): Promise<void> {
    this.#log.info("==========================================");
    this.#log.info("Common Settings Bridge Starting");
    this.#log.info("==========================================");

    try {
      this.#log.info("Initializing Matrix bridge...");
      this.#bridge = this.#initBridge();

      this.#log.debug("Running bridge on port 0 (disabled HTTP listener)...");
      await this.#bridge.run(0);
      this.#log.debug("Bridge started successfully");

      const botUserId = this.#bridge.getBot().getUserId();
      this.#log.info(`Bot user ID: ${botUserId}`);

      this.#log.debug("Ensuring bot is registered...");
      this.#botIntent = this.#bridge.getIntent(botUserId);
      await this.#botIntent.ensureRegistered();
      this.#log.debug("Bot registration confirmed");

      this.#log.debug("Initializing admin APIs...");
      this.#adminApis = this.#botIntent.matrixClient.adminApis.synapse;

      this.#log.debug("Checking admin privileges...");
      const isAdmin = await this.#adminApis.isSelfAdmin();
      if (isAdmin) {
        this.#log.info(`Bot ${botUserId} has admin privileges`);
      } else if (this.#config.deletion) {
        throw new Error(`Bot ${botUserId} must be a server admin to erase deleted accounts`);
      } else if (this.#config.spaces) {
        throw new Error(`Bot ${botUserId} must be a server admin to add space members`);
      } else {
        this.#log.warn(`Bot ${botUserId} does NOT have admin privileges`);
        this.#log.warn("Admin API fallback will not be available");
      }

      // OPTIONAL: Database (degrade gracefully if unavailable)
      try {
        this.#log.info("Waiting for database to be ready...");

        // Timeout to prevent indefinite hang
        const DB_READY_TIMEOUT_MS = 30000; // 30 seconds
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Database connection timeout after ${DB_READY_TIMEOUT_MS}ms`));
          }, DB_READY_TIMEOUT_MS);
        });

        await Promise.race([
          this.#db.ready,
          timeoutPromise,
        ]);
        this.#log.info("Database connection established");

        // Ensure all required columns exist (handles schema migrations)
        this.#log.info("Ensuring database schema is up to date...");
        await this.#db.ensureColumns("usersettings", [
          {
            name: "settings",
            type: "jsonb",
            default: null,
          },
          {
            name: "version",
            type: "int",
            default: 1,
          },
          {
            name: "timestamp",
            type: "bigint",
            default: 0,
          },
          {
            name: "request_id",
            type: "varchar(255)",
            default: "",
          },
          {
            name: "avatar_source",
            type: "text",
            default: null,
          },
          {
            name: "avatar_mxc",
            type: "text",
            default: null,
          },
        ]);
        this.#log.info("Database schema verified");

        // Initialize repository
        this.#log.debug("Initializing settings repository...");
        this.#settingsRepository = new SettingsRepository(this.#db, this.#log);
        this.#isDatabaseAvailable = true;
      } catch (error) {
        this.#log.warn("==========================================");
        if (this.#config.spaces) {
          throw new Error(`Spaces need the database: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
        this.#log.warn("DATABASE UNAVAILABLE - Running in degraded mode");
        this.#log.warn("Idempotency and version checks disabled");
        this.#log.warn(`Error: ${error instanceof Error ? error.message : String(error)}`);
        this.#log.warn("==========================================");
      }

      this.#log.debug("Initializing profile updater...");
      const retryMode = this.#getAdminRetryMode();
      const matrixApis = this.#createMatrixApis();
      this.#profileUpdater = new MatrixProfileUpdater(matrixApis, retryMode, this.#log, {
        maxSizeBytes: this.#config.synapse.avatarMaxSizeBytes ?? DEFAULT_MAX_AVATAR_BYTES,
        fetchTimeoutMs: this.#config.synapse.avatarFetchTimeoutMs ?? DEFAULT_AVATAR_FETCH_TIMEOUT_MS,
      });

      this.#log.info("Connecting RabbitMQ client...");
      await this.#client.init();
      try {
        const rabbitConfig = this.#config.rabbitmq;
        await this.#client.subscribe(
          rabbitConfig.exchange,
          rabbitConfig.routingKey ?? "#",
          rabbitConfig.queue,
          this.#handleMessage.bind(this),
        );

        const deletion = this.#config.deletion;
        if (deletion) {
          await this.#client.subscribe(
            deletion.exchange,
            deletion.routingKey,
            deletion.queue,
            createUserDeletedHandler(
              this.#eraseAccount.bind(this),
              this.#config.domain,
              deletion.localpartFrom,
              this.#log,
            ),
          );
          this.#log.info(`Erasing accounts on ${deletion.exchange} / ${deletion.routingKey}`);
        }

        const spaces = this.#config.spaces;
        if (spaces) {
          const matrix = new MatrixSpaces(this.#botIntent.matrixClient, botUserId, this.#config.domain, this.#log);
          const registry = this.#createSpaceRegistry();
          await this.#client.subscribe(
            spaces.exchange,
            spaces.routingKey,
            spaces.queue,
            createSpaceEventHandler({
              matrix,
              clock: this.#createSpaceClock(),
              lock: this.#createSpaceLock(),
              registry,
              publish: (type, event) =>
                this.#client.publish(spaces.activityExchange, type, event, {
                  messageId: event.id as string,
                }),
              domain: this.#config.domain,
              config: spaces,
              log: this.#log,
            }),
            // ponytail: each event holds a database connection for its space lock and queries on another,
            // so half the pool (pg's default of 10) at most; pass the lock's connection to the queries to go higher
            {
              concurrency: SPACE_EVENTS_AT_ONCE,
            },
          );
          this.#log.info(`Provisioning Matrix spaces from ${spaces.exchange} / ${spaces.routingKey}`);

          const purge = (): void => {
            purgeDeletedSpaces({
              matrix,
              registry,
              log: this.#log,
            }).catch((error) => {
              this.#log.warn(
                `Could not list the spaces to delete: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          };
          purge();
          this.#purgeTimer = setInterval(purge, PURGE_INTERVAL_MS).unref();

          const { syncRequestExchange } = spaces;
          if (syncRequestExchange) {
            await requestFirstSync({
              registry,
              publish: (routingKey, message) =>
                this.#client.publish(syncRequestExchange, routingKey, message, {
                  messageId: crypto.randomUUID(),
                }),
              organizationId: spaces.organizationId,
              log: this.#log,
            });
          }
        }
      } catch (subscribeError) {
        // Roll the connection back so the lib's auto-reconnect loop doesn't
        // keep a zombie session open after start() rejects.
        await this.#client.close().catch((closeErr) => {
          this.#log.warn(
            `Error closing client during rollback: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          );
        });
        throw subscribeError;
      }
      this.#log.info("RabbitMQ client ready");

      this.#log.info("------------------------------------------");
      this.#log.info("Common Settings Bridge Started");
      this.#log.info("------------------------------------------");
      this.#log.info("Service running. Waiting for messages...");
      this.#log.info("Press Ctrl+C to stop");
      this.#log.info("==========================================");
    } catch (error) {
      this.#log.error("==========================================");
      this.#log.error("FATAL ERROR DURING STARTUP:");
      this.#log.error(error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        this.#log.debug(`Stack trace: ${error.stack}`);
      }
      this.#log.error("==========================================");
      throw error;
    }
  }

  /**
   * Gracefully stops the bridge service.
   * Closes the AMQP connector and database connections.
   */
  async stop(): Promise<void> {
    this.#log.info("");
    this.#log.info("==========================================");
    this.#log.info("Shutdown signal received...");
    this.#log.info("==========================================");

    // Each resource closes in its own try block so a failure on one does not
    // skip the others (the lib's close() can throw on drain timeout).
    let firstError: unknown;
    clearInterval(this.#purgeTimer);

    if (this.#client) {
      this.#log.info("Closing RabbitMQ client...");
      try {
        await this.#client.close();
        this.#log.info("RabbitMQ client closed");
      } catch (error) {
        firstError ??= error;
        this.#log.error(`Error closing RabbitMQ client: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.#db) {
      this.#log.info("Closing database connection...");
      try {
        this.#db.close();
        this.#log.info("Database closed");
      } catch (error) {
        firstError ??= error;
        this.#log.error(`Error closing database: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.#log.info("==========================================");
    this.#log.info("Common Settings Bridge Stopped");
    this.#log.info("==========================================");

    if (firstError !== undefined) {
      throw firstError;
    }
  }
}
