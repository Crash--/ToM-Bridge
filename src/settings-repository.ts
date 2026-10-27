import { eq, sql } from "drizzle-orm";
import type { Logger } from "matrix-appservice-bridge";

import type { Queries } from "./db.js";
import { usersettings } from "./schema.js";
import type { ISettingsPayload, StoredUserSettings } from "./types.js";

/**
 * Formats a Unix timestamp (milliseconds) as an ISO 8601 string.
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export class SettingsPayload implements ISettingsPayload {
  readonly #language?: string;
  readonly #timezone?: string;
  readonly #avatar?: string;
  readonly #last_name?: string;
  readonly #first_name?: string;
  readonly #email?: string;
  readonly #phone?: string;
  readonly #matrix_id: string;
  readonly #display_name?: string;

  constructor(jsonString: string) {
    const data = SettingsPayload.#parseJSON(jsonString);

    /* Validate required field */
    if (typeof data.matrix_id !== "string" || data.matrix_id.length === 0) {
      throw new Error("matrix_id is required and must be a non-empty string");
    }

    this.#matrix_id = data.matrix_id;

    /* Parse optional string fields */
    this.#language = SettingsPayload.#validateOptionalString(data.language, "language");
    this.#timezone = SettingsPayload.#validateOptionalString(data.timezone, "timezone");
    this.#avatar = SettingsPayload.#validateOptionalString(data.avatar, "avatar");
    this.#last_name = SettingsPayload.#validateOptionalString(data.last_name, "last_name");
    this.#first_name = SettingsPayload.#validateOptionalString(data.first_name, "first_name");
    this.#email = SettingsPayload.#validateOptionalString(data.email, "email");
    this.#phone = SettingsPayload.#validateOptionalString(data.phone, "phone");
    this.#display_name = SettingsPayload.#validateOptionalString(data.display_name, "display_name");
  }

  /* Parse and validate JSON string */
  static #parseJSON(jsonString: string): Record<string, unknown> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      throw new Error(`Invalid JSON string: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Parsed JSON must be an object");
    }

    return parsed as Record<string, unknown>;
  }

  /* Validate optional string field - treats null and undefined as absent */
  static #validateOptionalString(value: unknown, fieldName: string): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (typeof value !== "string") {
      throw new Error(`${fieldName} must be a string`);
    }

    return value;
  }

  /* Getters for all fields */
  get language(): string | undefined {
    return this.#language;
  }

  get timezone(): string | undefined {
    return this.#timezone;
  }

  get avatar(): string | undefined {
    return this.#avatar;
  }

  get last_name(): string | undefined {
    return this.#last_name;
  }

  get first_name(): string | undefined {
    return this.#first_name;
  }

  get email(): string | undefined {
    return this.#email;
  }

  get phone(): string | undefined {
    return this.#phone;
  }

  get matrix_id(): string {
    return this.#matrix_id;
  }

  get display_name(): string | undefined {
    return this.#display_name;
  }

  /* Create plain object from ISettingsPayload (validates and returns clean object) */
  static fromObject(obj: ISettingsPayload): ISettingsPayload {
    return new SettingsPayload(JSON.stringify(obj)).toObject();
  }

  /* Serialize back to JSON */
  toJSON(): string {
    return JSON.stringify({
      matrix_id: this.#matrix_id,
      ...(this.#language && {
        language: this.#language,
      }),
      ...(this.#timezone && {
        timezone: this.#timezone,
      }),
      ...(this.#avatar && {
        avatar: this.#avatar,
      }),
      ...(this.#last_name && {
        last_name: this.#last_name,
      }),
      ...(this.#first_name && {
        first_name: this.#first_name,
      }),
      ...(this.#email && {
        email: this.#email,
      }),
      ...(this.#phone && {
        phone: this.#phone,
      }),
      ...(this.#display_name && {
        display_name: this.#display_name,
      }),
    });
  }

  /* Get plain object representation */
  toObject(): ISettingsPayload {
    return {
      matrix_id: this.#matrix_id,
      ...(this.#language && {
        language: this.#language,
      }),
      ...(this.#timezone && {
        timezone: this.#timezone,
      }),
      ...(this.#avatar && {
        avatar: this.#avatar,
      }),
      ...(this.#last_name && {
        last_name: this.#last_name,
      }),
      ...(this.#first_name && {
        first_name: this.#first_name,
      }),
      ...(this.#email && {
        email: this.#email,
      }),
      ...(this.#phone && {
        phone: this.#phone,
      }),
      ...(this.#display_name && {
        display_name: this.#display_name,
      }),
    };
  }
}

/**
 * Repository for managing user settings persistence in the database.
 * Handles all database operations for storing and retrieving user settings,
 * including JSON serialization/deserialization and error handling.
 */
export class SettingsRepository {
  readonly #db: Queries;
  readonly #logger: Logger;

  /**
   * Creates a new SettingsRepository instance.
   * @param db - Database instance for user settings operations
   * @param logger - Logger instance for diagnostic output
   */
  constructor(db: Queries, logger: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  /**
   * Retrieves existing user settings from the database.
   * Handles JSON parsing and returns null for missing or corrupted data.
   *
   * @param userId - The Matrix user ID to look up
   * @returns UserSettings object or null if user not found or data is corrupted
   * @throws Error if database query fails
   */
  async getUserSettings(userId: string): Promise<StoredUserSettings | null> {
    this.#logger.debug(`Looking up user settings for ${userId}`);

    try {
      const [dbRow] = await this.#db.select().from(usersettings).where(eq(usersettings.matrix_id, userId));

      if (!dbRow) {
        this.#logger.debug(`No existing settings found for ${userId}`);
        return null;
      }

      const settingsRaw = typeof dbRow.settings === "string" ? dbRow.settings : JSON.stringify(dbRow.settings);
      const parsedSettings = this.#safeParsePayload(settingsRaw);

      if (parsedSettings === null) {
        this.#logger.warn(`Settings for ${userId} in database are corrupted, treating as new user`);
        return null;
      }

      // Safely parse timestamp from DB (may be string or number)
      const rawTs = dbRow.timestamp;
      const tsNum = rawTs === null ? undefined : Number(rawTs);
      const validTimestamp = Number.isFinite(tsNum) ? tsNum! : 0;

      this.#logger.debug(
        `Found existing settings for ${userId}: version=${dbRow.version}, timestamp=${
          Number.isFinite(tsNum) ? formatTimestamp(tsNum!) : "unknown"
        }, request_id=${dbRow.request_id}`,
      );

      return {
        nickname: dbRow.matrix_id,
        payload: parsedSettings,
        version: dbRow.version ?? 1,
        timestamp: validTimestamp,
        request_id: dbRow.request_id ?? "",
        ...(dbRow.avatar_source && dbRow.avatar_mxc
          ? {
              avatar: {
                source: dbRow.avatar_source,
                mxc: dbRow.avatar_mxc,
              },
            }
          : {}),
      };
    } catch (error) {
      this.#logger.error(
        `Error retrieving settings for ${userId}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      throw error;
    }
  }

  /**
   * Saves user settings unless the stored ones are as recent or more, in one
   * statement, so that two updates of the same user written at once keep the
   * newer one.
   *
   * @param userId - The Matrix user ID
   * @param payload - The settings payload to persist
   * @param version - The version number of the settings
   * @param timestamp - The timestamp when settings were last modified
   * @param requestId - The unique request ID for idempotency tracking
   * @returns Whether the settings were saved
   * @throws Error if database operation fails
   */
  async saveIfNewer(
    userId: string,
    payload: ISettingsPayload,
    version: number,
    timestamp: number,
    requestId: string,
  ): Promise<boolean> {
    try {
      // The avatar columns stay out of the update: they describe the last upload, not these settings
      const written = await this.#db
        .insert(usersettings)
        .values({
          matrix_id: userId,
          settings: payload,
          version,
          timestamp,
          request_id: requestId,
        })
        .onConflictDoUpdate({
          target: usersettings.matrix_id,
          set: {
            settings: sql`excluded.settings`,
            version: sql`excluded.version`,
            timestamp: sql`excluded.timestamp`,
            request_id: sql`excluded.request_id`,
          },
          setWhere: sql`(${usersettings.version}, ${usersettings.timestamp}) < (excluded.version, excluded.timestamp)`,
        })
        .returning({
          matrixId: usersettings.matrix_id,
        });
      this.#logger.debug(
        `${written.length > 0 ? "Saved" : "Kept the newer stored"} settings for ${userId}: version=${version}, timestamp=${timestamp}, request_id=${requestId}`,
      );
      return written.length > 0;
    } catch (error) {
      this.#logger.error(
        `Failed to save settings for ${userId}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      throw error;
    }
  }

  /**
   * Remembers the mxc URL an avatar URL became once uploaded, so that the
   * avatar is not downloaded again while the Matrix profile shows it.
   * Whatever the version stored, as it describes the upload, not the settings.
   */
  async saveAvatar(userId: string, source: string, mxc: string): Promise<void> {
    await this.#db
      .update(usersettings)
      .set({
        avatar_source: source,
        avatar_mxc: mxc,
      })
      .where(eq(usersettings.matrix_id, userId));
  }

  /**
   * Parses a settings payload from database result, validating its fields.
   *
   * @param raw - The settings as JSON
   * @returns The parsed ISettingsPayload or null if parsing failed
   */
  #safeParsePayload(raw: string): ISettingsPayload | null {
    try {
      const parsed = new SettingsPayload(raw).toObject();
      // Log only non-PII identifier for debugging
      this.#logger.debug(`Successfully parsed settings payload for ${parsed.matrix_id}`);
      return parsed;
    } catch (error) {
      // Do not log raw payload to avoid PII exposure
      this.#logger.warn(
        `Failed to parse settings payload from database: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return null;
    }
  }
}
