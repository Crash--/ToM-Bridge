import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { openTestDatabase } from "./__mocks__/pglite.js";
import {
  AppServiceRegistration,
  Bridge,
  Cli,
  Logger,
  RabbitMQClient as MockRabbitMQClient,
  closeDatabase as mockCloseDatabase,
  migrate as mockMigrate,
  openDatabase as mockOpenDatabase,
  withLock as mockWithLock,
} from "./__mocks__/shared.js";
import { type MatrixProfile, MatrixProfileUpdater } from "./matrix-profile-updater.js";
import { SettingsRepository } from "./settings-repository.js";
import type { BridgeConfig, ISettingsPayload, StoredUserSettings } from "./types.js";

type AnyFn = (...args: any[]) => any;

/** The usersettings row behind the repository spies, and the Matrix profile behind the intent. */
class FakeWorld {
  stored: StoredUserSettings | null = null;
  shownName?: string;
  shownAvatar?: string;

  readonly read = (): Promise<StoredUserSettings | null> => Promise.resolve(this.stored);

  // The conditional write, which leaves the avatar columns as they are
  readonly save = (
    nickname: string,
    payload: ISettingsPayload,
    version: number,
    timestamp: number,
    request_id: string,
  ): Promise<boolean> => {
    const stored = this.stored;
    const newer = !stored || version > stored.version || (version === stored.version && timestamp > stored.timestamp);
    if (newer) {
      this.stored = {
        ...stored,
        nickname,
        payload,
        version,
        timestamp,
        request_id,
      };
    }
    return Promise.resolve(newer);
  };

  readonly saveAvatar = (_userId: string, source: string, mxc: string): Promise<void> => {
    this.stored = this.stored && {
      ...this.stored,
      avatar: {
        source,
        mxc,
      },
    };
    return Promise.resolve();
  };

  readonly setName = (name: string): Promise<void> => {
    this.shownName = name;
    return Promise.resolve();
  };

  readonly setAvatar = (url: string): Promise<void> => {
    this.shownAvatar = url;
    return Promise.resolve();
  };

  readonly profile = (): Promise<MatrixProfile> =>
    Promise.resolve({
      displayname: this.shownName,
      avatar_url: this.shownAvatar,
    });
}

function settingsUpdate(version: number, name: string, requestId: string, avatar?: string): Record<string, unknown> {
  return {
    source: "test-app",
    request_id: requestId,
    timestamp: 1640995200000,
    version,
    payload: {
      matrix_id: "@user:example.com",
      display_name: name,
      ...(avatar
        ? {
            avatar,
          }
        : {}),
    },
  };
}

// Register the shared leaf-dependency mocks for this test file. The real
// SettingsRepository and MatrixProfileUpdater run against these mocks and are
// observed through prototype spies below.
vi.mock("matrix-appservice-bridge", () => ({
  AppServiceRegistration,
  Bridge,
  Cli,
  Logger,
}));
vi.mock("@linagora/rabbitmq-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@linagora/rabbitmq-client")>()),
  RabbitMQClient: MockRabbitMQClient,
}));
vi.mock("./db.js", () => ({
  openDatabase: mockOpenDatabase,
  migrate: mockMigrate,
  withLock: mockWithLock,
  closeDatabase: mockCloseDatabase,
}));

const { CommonSettingsBridge } = await import("./bridge.js");

describe("CommonSettingsBridge", () => {
  let bridge: InstanceType<typeof CommonSettingsBridge>;
  let mockConfig: BridgeConfig;
  let mockBridgeInstance: InstanceType<typeof Bridge>;
  let mockIntent: any;
  // The database the bridge queries
  let client: PGlite;
  let mockClient: {
    init: Mock<AnyFn>;
    subscribe: Mock<AnyFn>;
    publish: Mock<AnyFn>;
    close: Mock<AnyFn>;
  };
  let spyGetUserSettings: Mock<AnyFn>;
  let spySaveIfNewer: Mock<AnyFn>;
  let spyProcessChanges: Mock<AnyFn>;
  let mockAdminApis: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup config
    mockConfig = {
      homeserverUrl: "https://matrix.example.com",
      domain: "example.com",
      registrationPath: "/path/to/registration.yaml",
      database: {
        host: "localhost",
        name: "testdb",
        user: "testuser",
        password: "testpass",
      },
      rabbitmq: {
        host: "localhost",
        port: 5672,
        username: "guest",
        password: "guest",
        vhost: "/",
        exchange: "test-exchange",
        queue: "test-queue",
        routingKey: "test.routing.key",
      },
      synapse: {
        adminRetryMode: "fallback",
      },
    };

    const database = await openTestDatabase();
    client = database.client;
    mockOpenDatabase.mockReturnValue({
      db: database.db,
    });
    mockMigrate.mockResolvedValue(undefined);
    mockWithLock.mockImplementation((_database: unknown, _key: string, fn: () => Promise<unknown>) => fn());
    mockCloseDatabase.mockResolvedValue(undefined);

    // Mock RabbitMQ client
    mockClient = {
      init: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;
    // biome-ignore lint/complexity/useArrowFunction: called with new
    MockRabbitMQClient.mockImplementation(function () {
      return mockClient;
    });

    // Mock admin APIs
    mockAdminApis = {
      isSelfAdmin: vi.fn().mockResolvedValue(true),
      upsertUser: vi.fn().mockResolvedValue(undefined),
    };

    // Mock Intent
    mockIntent = {
      ensureRegistered: vi.fn().mockResolvedValue(undefined),
      setDisplayName: vi.fn().mockResolvedValue(undefined),
      setAvatarUrl: vi.fn().mockResolvedValue(undefined),
      matrixClient: {
        adminApis: {
          synapse: mockAdminApis,
        },
        uploadContentFromUrl: vi.fn().mockResolvedValue("mxc://example.com/avatar123"),
      },
    } as any;

    // The Bridge mock is handled by the manual mock in __mocks__
    // Create an instance to access the shared mock methods
    const tempBridge = new Bridge({} as any);
    mockBridgeInstance = {
      run: tempBridge.run,
      getBot: tempBridge.getBot,
      getIntent: tempBridge.getIntent,
    } as any;

    // Get the shared mockIntent from the Bridge's getIntent mock
    mockIntent = mockBridgeInstance.getIntent() as any;

    // Update mockAdminApis to reference the mockIntent's admin APIs
    mockAdminApis = mockIntent.matrixClient.adminApis.synapse;

    // Spy on the real repository / updater prototypes
    spyGetUserSettings = vi.spyOn(SettingsRepository.prototype, "getUserSettings");
    spySaveIfNewer = vi.spyOn(SettingsRepository.prototype, "saveIfNewer");
    spyProcessChanges = vi.spyOn(MatrixProfileUpdater.prototype, "processChanges");

    // Mock global fetch: the real MatrixProfileUpdater downloads avatars
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) => {
            if (name === "content-length") return "1000";
            if (name === "content-type") return "image/png";
            return null;
          },
        },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1000)),
      }),
    ) as any;
  });

  afterEach(() => {
    spyGetUserSettings.mockRestore();
    spySaveIfNewer.mockRestore();
    spyProcessChanges.mockRestore();
  });

  describe("constructor", () => {
    it("should initialize bridge instance with config", () => {
      bridge = new CommonSettingsBridge(mockConfig);

      expect(bridge).toBeInstanceOf(CommonSettingsBridge);
      expect(mockOpenDatabase).toHaveBeenCalledWith(mockConfig.database, expect.any(Object));
    });

    it("should initialize RabbitMQ client with URL built from config", () => {
      bridge = new CommonSettingsBridge(mockConfig);

      expect(MockRabbitMQClient).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "amqp://guest:guest@localhost:5672//",
        }),
      );
    });
  });

  describe("start()", () => {
    beforeEach(() => {
      bridge = new CommonSettingsBridge(mockConfig);
    });

    it("should initialize Matrix bridge", async () => {
      await bridge.start();

      expect(mockBridgeInstance.run).toHaveBeenCalledWith(0);
    });

    it("should ensure bot is registered", async () => {
      await bridge.start();

      expect(mockBridgeInstance.getBot).toHaveBeenCalled();
      expect(mockBridgeInstance.getIntent).toHaveBeenCalledWith("@bot:example.com");
      expect(mockIntent.ensureRegistered).toHaveBeenCalled();
    });

    it("should check admin privileges", async () => {
      await bridge.start();

      expect(mockAdminApis.isSelfAdmin).toHaveBeenCalled();
    });

    it("should migrate the database before handling messages", async () => {
      await bridge.start();

      expect(mockMigrate.mock.invocationCallOrder[0]).toBeLessThan(mockClient.subscribe.mock.invocationCallOrder[0]!);
    });

    it("logs an error and runs in degraded mode when the database refuses the migration", async () => {
      mockMigrate.mockRejectedValueOnce(
        Object.assign(new Error("permission denied for database tom_db"), {
          name: "PostgresError",
          code: "42501",
        }),
      );

      await bridge.start();

      const log = Logger.mock.results.at(-1)!.value;
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("DATABASE MIGRATION FAILED: permission denied for database tom_db"),
      );
      expect(log.warn).toHaveBeenCalledWith("DATABASE NOT MIGRATED - Running in degraded mode");
    });

    it("runs in degraded mode without an error when the database does not answer", async () => {
      mockMigrate.mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        }),
      );

      await bridge.start();

      const log = Logger.mock.results.at(-1)!.value;
      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith("DATABASE UNAVAILABLE - Running in degraded mode");
    });

    it("should initialize settings repository", async () => {
      await bridge.start();

      const handleMessageFn = (mockClient.subscribe as Mock<AnyFn>).mock.calls[0]![3];
      await handleMessageFn({
        source: "test-app",
        nickname: "@user:example.com",
        request_id: "req-1",
        timestamp: 1,
        version: 1,
        payload: {
          matrix_id: "@user:example.com",
        },
      });

      expect((await client.query("SELECT matrix_id FROM usersettings")).rows).toEqual([
        {
          matrix_id: "@user:example.com",
        },
      ]);
    });

    it("should initialize profile updater with fallback retry mode", async () => {
      await bridge.start();

      const handleMessageFn = (mockClient.subscribe as Mock<AnyFn>).mock.calls[0]![3];
      mockIntent.setDisplayName.mockRejectedValueOnce({
        errcode: "M_FORBIDDEN",
        message: "Forbidden",
      });

      await handleMessageFn({
        source: "test-app",
        nickname: "@user:example.com",
        request_id: "req-2",
        timestamp: Date.now(),
        version: 2,
        payload: {
          matrix_id: "@user:example.com",
          display_name: "New Name",
        },
      });

      // FALLBACK retry mode: M_FORBIDDEN on the intent API falls back to the admin API
      expect(mockAdminApis.upsertUser).toHaveBeenCalledWith("@user:example.com", {
        displayname: "New Name",
      });
    });

    it("should init RabbitMQ client and subscribe to the configured queue", async () => {
      await bridge.start();

      expect(mockClient.init).toHaveBeenCalled();
      expect(mockClient.subscribe).toHaveBeenCalledWith(
        "test-exchange",
        "test.routing.key",
        "test-queue",
        expect.any(Function),
      );
    });

    it("should default routingKey to '#' when omitted from config", async () => {
      const configNoRouting = {
        ...mockConfig,
        rabbitmq: {
          ...mockConfig.rabbitmq,
          routingKey: undefined,
        },
      };
      const newBridge = new CommonSettingsBridge(configNoRouting as unknown as typeof mockConfig);
      await newBridge.start();

      expect(mockClient.subscribe).toHaveBeenCalledWith("test-exchange", "#", "test-queue", expect.any(Function));
    });

    it("should not subscribe to deletions when deletion is not configured", async () => {
      await bridge.start();

      expect(mockClient.subscribe).toHaveBeenCalledTimes(1);
    });

    describe("with deletion configured", () => {
      const deletion = {
        exchange: "auth",
        routingKey: "user.deleted",
        queue: "chat.user.deleted.queue",
        localpartFrom: "uid",
      } as const;

      beforeEach(() => {
        mockIntent.matrixClient.doRequest = vi.fn().mockResolvedValue({});
      });

      const startWithDeletion = async (): Promise<(message: Record<string, unknown>) => Promise<void>> => {
        await new CommonSettingsBridge({
          ...mockConfig,
          deletion,
        }).start();
        const call = mockClient.subscribe.mock.calls.find(([exchange]) => exchange === "auth");
        return call?.[3];
      };

      it("subscribes to the deletion binding", async () => {
        expect(await startWithDeletion()).toBeInstanceOf(Function);
        expect(mockClient.subscribe).toHaveBeenCalledWith(
          "auth",
          "user.deleted",
          "chat.user.deleted.queue",
          expect.any(Function),
        );
      });

      it("deactivates the account with erasure", async () => {
        const handler = await startWithDeletion();
        await handler({
          userId: "alice",
        });

        expect(mockIntent.matrixClient.doRequest).toHaveBeenCalledWith(
          "POST",
          "/_synapse/admin/v1/deactivate/%40alice%3Aexample.com",
          null,
          {
            erase: true,
          },
        );
      });

      it("refuses to start when the bot is not a server admin", async () => {
        mockAdminApis.isSelfAdmin.mockResolvedValueOnce(false);

        await expect(
          new CommonSettingsBridge({
            ...mockConfig,
            deletion,
          }).start(),
        ).rejects.toThrow("must be a server admin");
      });

      it("counts an account Synapse does not know as erased", async () => {
        const handler = await startWithDeletion();
        mockIntent.matrixClient.doRequest.mockRejectedValueOnce({
          statusCode: 404,
        });

        await expect(
          handler({
            userId: "alice",
          }),
        ).resolves.toBeUndefined();
      });

      it("fails on any other Synapse error, so the message is retried", async () => {
        const handler = await startWithDeletion();
        mockIntent.matrixClient.doRequest.mockRejectedValueOnce({
          statusCode: 500,
        });

        await expect(
          handler({
            userId: "alice",
          }),
        ).rejects.toEqual({
          statusCode: 500,
        });
      });
    });

    describe("with spaces configured", () => {
      const spaces = {
        exchange: "cs.instances.out.exchange",
        routingKey: "twake.space.#.acme",
        queue: "chat.space.acme.queue",
        activityExchange: "activity",
        localpartFrom: "uid",
      } as const;

      const created = {
        organizationId: "acme",
        id: "3b9e2c71",
        name: "Design Sprint",
        members: [],
        timestamp: "2026-10-06T09:12:44.512Z",
      };

      beforeEach(() => {
        Object.assign(mockIntent.matrixClient, {
          resolveRoom: vi.fn().mockResolvedValue("!space:example.com"),
          doRequest: vi.fn().mockResolvedValue({}),
          getRoomStateEvent: vi.fn().mockResolvedValue({
            users: {},
          }),
          sendStateEvent: vi.fn().mockResolvedValue("$event"),
          getRoomMembers: vi.fn().mockResolvedValue([]),
        });
      });

      const startWithSpaces = async (): Promise<
        (message: Record<string, unknown>, properties: Record<string, unknown>) => Promise<void>
      > => {
        await new CommonSettingsBridge({
          ...mockConfig,
          spaces,
        }).start();
        const call = mockClient.subscribe.mock.calls.find(([, routingKey]) => routingKey === spaces.routingKey);
        return call?.[3];
      };

      it("subscribes to the tenant's space events", async () => {
        expect(await startWithSpaces()).toBeInstanceOf(Function);
        expect(mockClient.subscribe).toHaveBeenCalledWith(
          "cs.instances.out.exchange",
          "twake.space.#.acme",
          "chat.space.acme.queue",
          expect.any(Function),
          {
            concurrency: 4,
          },
        );
      });

      it("announces the Matrix space on the activity exchange", async () => {
        const handler = await startWithSpaces();
        await handler(created, {
          routingKey: "twake.space.created.acme",
          headers: {},
        });

        expect(mockClient.publish).toHaveBeenCalledWith(
          "activity",
          "com.twake.chat.space.provisioned.v1",
          expect.objectContaining({
            data: {
              space_id: "3b9e2c71",
              resource: {
                kind: "matrix_space",
                id: "!space:example.com",
              },
            },
          }),
          {
            messageId: expect.any(String),
          },
        );
      });

      it("does not start without the database", async () => {
        mockMigrate.mockRejectedValue(new Error("connection refused"));

        await expect(
          new CommonSettingsBridge({
            ...mockConfig,
            spaces,
          }).start(),
        ).rejects.toThrow("Spaces need the database, the bridge does not start without it: connection refused");
      });

      it("fails an event the database cannot check, so it is retried, and keeps the settings going", async () => {
        const handler = await startWithSpaces();
        await client.close();

        await expect(
          handler(created, {
            routingKey: "twake.space.created.acme",
            headers: {},
          }),
        ).rejects.toMatchObject({
          cause: {
            message: "PGlite is closed",
          },
        });
        expect(mockClient.publish).not.toHaveBeenCalled();
      });

      it("applies an event under the lock of its space, shared by the pods", async () => {
        const handler = await startWithSpaces();
        mockWithLock.mockImplementation((_database: unknown, _key: string, fn: () => Promise<unknown>) => {
          expect(mockClient.publish).not.toHaveBeenCalled();
          return fn();
        });

        await handler(created, {
          routingKey: "twake.space.created.acme",
          headers: {},
        });

        expect(mockWithLock).toHaveBeenCalledWith(expect.anything(), "3b9e2c71", expect.any(Function));
        expect(mockClient.publish).toHaveBeenCalledTimes(1);
      });

      it("fails an event whose space the database cannot lock, so it is retried", async () => {
        const handler = await startWithSpaces();
        mockWithLock.mockRejectedValue(new Error("canceling statement due to lock timeout"));

        await expect(
          handler(created, {
            routingKey: "twake.space.created.acme",
            headers: {},
          }),
        ).rejects.toThrow("lock timeout");
        expect(mockClient.publish).not.toHaveBeenCalled();
      });

      it("fails an event that failed under the lock, without applying it again", async () => {
        const handler = await startWithSpaces();
        mockClient.publish.mockRejectedValue(new Error("RabbitMQ is down"));

        await expect(
          handler(created, {
            routingKey: "twake.space.created.acme",
            headers: {},
          }),
        ).rejects.toThrow("RabbitMQ is down");
        expect(mockClient.publish).toHaveBeenCalledTimes(1);
      });

      it("records the members it applied, to ignore older events", async () => {
        const handler = await startWithSpaces();
        await handler(
          {
            ...created,
            members: [
              {
                uuid: "u1",
                username: "jdoe",
                email: "jdoe@example.com",
                role: "editor",
              },
            ],
          },
          {
            routingKey: "twake.space.member.added.acme",
            headers: {},
          },
        );

        expect((await client.query("SELECT clock_key, timestamp FROM spaceclock")).rows).toContainEqual({
          clock_key: "3b9e2c71/@jdoe:example.com",
          timestamp: Date.parse(created.timestamp),
        });
      });

      it("keeps a deleted space until its retention is over", async () => {
        const handler = await startWithSpaces();
        await handler(created, {
          routingKey: "twake.space.deleted.acme",
          headers: {},
        });

        expect((await client.query("SELECT * FROM spaces")).rows).toEqual([
          {
            space_id: "3b9e2c71",
            organization_id: "acme",
            room_id: "!space:example.com",
            timestamp: Date.parse(created.timestamp),
            delete_at: expect.any(Number),
          },
        ]);
      });

      it("purges the Matrix spaces whose retention is over", async () => {
        await client.query(
          "INSERT INTO spaces (space_id, organization_id, room_id, timestamp, delete_at) VALUES ('gone', 'acme', '!gone:example.com', 0, 1)",
        );

        await startWithSpaces();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockIntent.matrixClient.doRequest).toHaveBeenCalledWith(
          "DELETE",
          "/_synapse/admin/v2/rooms/!gone%3Aexample.com",
          null,
          {
            purge: true,
          },
        );
        expect((await client.query("SELECT space_id FROM spaces")).rows).toEqual([]);
      });

      it("requests a sync of its organization once subscribed, while it knows no space", async () => {
        await new CommonSettingsBridge({
          ...mockConfig,
          spaces: {
            ...spaces,
            syncRequestExchange: "space",
            organizationId: "acme",
          },
        }).start();

        expect(mockClient.publish).toHaveBeenCalledWith(
          "space",
          "twake.space.sync.requested",
          {
            organizationId: "acme",
            timestamp: expect.any(String),
          },
          {
            messageId: expect.any(String),
          },
        );
        expect(mockClient.subscribe.mock.invocationCallOrder.at(-1)).toBeLessThan(
          mockClient.publish.mock.invocationCallOrder[0]!,
        );
      });

      it("refuses to start when the bot is not a server admin", async () => {
        mockAdminApis.isSelfAdmin.mockResolvedValueOnce(false);

        await expect(
          new CommonSettingsBridge({
            ...mockConfig,
            spaces,
          }).start(),
        ).rejects.toThrow("must be a server admin");
      });
    });

    it("should close the RabbitMQ client if subscribe() fails after init() succeeded", async () => {
      mockClient.subscribe.mockRejectedValueOnce(new Error("PRECONDITION_FAILED"));

      const newBridge = new CommonSettingsBridge(mockConfig);
      await expect(newBridge.start()).rejects.toThrow("PRECONDITION_FAILED");

      expect(mockClient.init).toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
    });

    it("should handle startup errors", async () => {
      const error = new Error("Startup failed");
      mockBridgeInstance.run.mockRejectedValueOnce(error);

      const newBridge = new CommonSettingsBridge(mockConfig);
      await expect(newBridge.start()).rejects.toThrow("Startup failed");
    });
  });

  describe("stop()", () => {
    beforeEach(async () => {
      bridge = new CommonSettingsBridge(mockConfig);
      await bridge.start();
    });

    it("should close RabbitMQ client", async () => {
      await bridge.stop();

      expect(mockClient.close).toHaveBeenCalled();
    });

    it("should close database connection", async () => {
      await bridge.stop();

      expect(mockCloseDatabase).toHaveBeenCalled();
    });

    it("should handle shutdown errors", async () => {
      const error = new Error("Shutdown failed");
      mockClient.close.mockRejectedValue(error);

      await expect(bridge.stop()).rejects.toThrow("Shutdown failed");
    });

    it("should still close the database even if RabbitMQ client.close() rejects", async () => {
      mockClient.close.mockRejectedValueOnce(new Error("drain timeout"));

      await expect(bridge.stop()).rejects.toThrow("drain timeout");

      expect(mockClient.close).toHaveBeenCalled();
      expect(mockCloseDatabase).toHaveBeenCalled();
    });
  });

  describe("#handleMessage orchestration", () => {
    let handleMessageFn: (message: Record<string, unknown>) => Promise<void>;
    let mockUserSettings: StoredUserSettings | null;
    let mockPayload: ISettingsPayload;
    // A stored row and a Matrix profile that keep their state, for updates of one user handled at once
    let world: FakeWorld;
    let spySaveAvatar: Mock<AnyFn>;

    const buildMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      source: "test-app",
      request_id: "req-123",
      timestamp: 1640995200000,
      version: 2,
      payload: mockPayload,
      ...overrides,
    });

    beforeEach(async () => {
      bridge = new CommonSettingsBridge(mockConfig);

      await bridge.start();

      const subscribeCall = (mockClient.subscribe as Mock<AnyFn>).mock.calls[0]!;
      handleMessageFn = subscribeCall[3];

      mockPayload = {
        matrix_id: "@user:example.com",
        display_name: "John Doe",
        avatar: "https://example.com/avatar.jpg",
        email: "john@example.com",
        phone: "+1234567890",
        language: "en",
        timezone: "UTC",
        last_name: "Doe",
        first_name: "John",
      };

      world = new FakeWorld();
      spyGetUserSettings.mockImplementation(world.read);
      spySaveIfNewer.mockImplementation(world.save);
      spySaveAvatar = vi.spyOn(SettingsRepository.prototype, "saveAvatar").mockImplementation(world.saveAvatar);
      mockIntent.setDisplayName.mockImplementation(world.setName);
      mockIntent.setAvatarUrl.mockImplementation(world.setAvatar);
      mockIntent.getProfileInfo.mockImplementation(world.profile);
    });

    afterEach(() => {
      spySaveAvatar.mockRestore();
    });

    it("should ack-and-drop a message missing request_id (no retry storm)", async () => {
      const message = buildMessage({
        request_id: undefined,
      });

      await expect(handleMessageFn(message)).resolves.toBeUndefined();
      expect(spyGetUserSettings).not.toHaveBeenCalled();
      expect(spyProcessChanges).not.toHaveBeenCalled();
    });

    it("should ack-and-drop a message missing matrix_id in payload", async () => {
      const message = buildMessage({
        version: 1,
        payload: {
          display_name: "Test",
        },
      });

      await expect(handleMessageFn(message)).resolves.toBeUndefined();
      expect(spyGetUserSettings).not.toHaveBeenCalled();
      expect(spyProcessChanges).not.toHaveBeenCalled();
    });

    it("should ack-and-drop a non-object payload root", async () => {
      await expect(handleMessageFn(null as unknown as Record<string, unknown>)).resolves.toBeUndefined();
      await expect(handleMessageFn(42 as unknown as Record<string, unknown>)).resolves.toBeUndefined();
      await expect(handleMessageFn([] as unknown as Record<string, unknown>)).resolves.toBeUndefined();
      expect(spyGetUserSettings).not.toHaveBeenCalled();
      expect(spyProcessChanges).not.toHaveBeenCalled();
    });

    it("should get user settings from repository", async () => {
      mockUserSettings = null;
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spyGetUserSettings).toHaveBeenCalledWith("@user:example.com");
    });

    it("should save the whole payload it received, which carries every setting", async () => {
      mockUserSettings = {
        nickname: "@user:example.com",
        payload: mockPayload,
        version: 1,
        timestamp: 1640991600000,
        request_id: "req-old",
      };
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spySaveIfNewer).toHaveBeenCalledWith("@user:example.com", mockPayload, 2, 1640995200000, "req-123");
    });

    it("should save before reading the settings it puts on Matrix", async () => {
      spyGetUserSettings.mockResolvedValue(null);

      await handleMessageFn(buildMessage());

      expect(spySaveIfNewer.mock.invocationCallOrder[0]!).toBeLessThan(spyGetUserSettings.mock.invocationCallOrder[0]!);
      expect(spyProcessChanges).not.toHaveBeenCalled();
    });

    it("ends on the newer settings when the older ones reach Matrix last", async () => {
      let releaseOlder!: () => void;
      const olderHeld = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      mockIntent.setDisplayName.mockImplementationOnce(async (name: string) => {
        await olderHeld;
        await world.setName(name);
      });

      const older = handleMessageFn(settingsUpdate(1, "Older Name", "req-1"));
      await vi.waitFor(() => expect(mockIntent.setDisplayName).toHaveBeenCalledWith("Older Name"));
      await handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"));
      expect(world.shownName).toBe("Newer Name");

      releaseOlder();
      await older;

      expect(world.stored?.version).toBe(2);
      expect(world.shownName).toBe("Newer Name");
    });

    it("refuses settings older than the stored ones, and writes nothing to Matrix that shows the stored ones", async () => {
      await handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"));
      mockIntent.setDisplayName.mockClear();

      await handleMessageFn(settingsUpdate(1, "Older Name", "req-1"));

      expect(world.stored?.version).toBe(2);
      expect(mockIntent.setDisplayName).not.toHaveBeenCalled();
    });

    it("puts the stored settings back on a Matrix behind them, even from a refused update", async () => {
      await handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"));
      world.shownName = "Name from before";

      await handleMessageFn(settingsUpdate(1, "Older Name", "req-1"));

      expect(world.stored?.version).toBe(2);
      expect(world.shownName).toBe("Newer Name");
    });

    it("does not download an unchanged avatar again", async () => {
      const avatar = "https://workspace.example.com/avatar/user.png";

      await handleMessageFn(settingsUpdate(1, "Name", "req-1", avatar));
      await handleMessageFn(settingsUpdate(2, "Name", "req-2", avatar));

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(world.stored?.avatar?.source).toBe(avatar);
      expect(world.shownAvatar).toBe(world.stored?.avatar?.mxc);
    });

    it("writes nothing to Matrix again for a duplicate of settings it already shows", async () => {
      await handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"));
      mockIntent.setDisplayName.mockClear();

      await handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"));

      expect(mockIntent.setDisplayName).not.toHaveBeenCalled();
    });

    it("puts saved settings on Matrix when their first delivery failed there", async () => {
      mockIntent.setDisplayName.mockRejectedValueOnce(new Error("Synapse is down"));
      await expect(handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"))).rejects.toThrow("Synapse is down");
      expect(world.shownName).toBeUndefined();

      await handleMessageFn(settingsUpdate(2, "Newer Name", "req-2"));

      expect(world.shownName).toBe("Newer Name");
    });

    it("ends on the newest settings when an update is saved while an older one goes through", async () => {
      await handleMessageFn(settingsUpdate(1, "Alice", "req-1"));
      expect(world.shownName).toBe("Alice");

      // v3 is held before its write until v2 has gone all the way through
      const save = spySaveIfNewer.getMockImplementation()!;
      let releaseV3!: () => void;
      const v3Held = new Promise<void>((resolve) => {
        releaseV3 = resolve;
      });
      spySaveIfNewer.mockImplementation(async (...args: unknown[]) => {
        if (args[2] === 3) await v3Held;
        return save(...args);
      });

      const v3 = handleMessageFn(settingsUpdate(3, "Alice", "req-3"));
      await vi.waitFor(() =>
        expect(spySaveIfNewer).toHaveBeenCalledWith(
          "@user:example.com",
          expect.anything(),
          3,
          expect.anything(),
          "req-3",
        ),
      );
      await handleMessageFn(settingsUpdate(2, "Bob", "req-2"));
      expect(world.shownName).toBe("Bob");
      releaseV3();
      await v3;

      expect(world.stored?.version).toBe(3);
      expect(world.shownName).toBe("Alice");
    });

    it("repairs Matrix with the next update after a write that failed through every retry", async () => {
      await handleMessageFn(settingsUpdate(1, "Alice", "req-1"));
      mockIntent.setDisplayName.mockRejectedValue(new Error("Synapse is down"));
      for (let i = 0; i < 3; i++) {
        await expect(handleMessageFn(settingsUpdate(2, "Bob", "req-2"))).rejects.toThrow("Synapse is down");
      }
      // message goes to the DLQ; Synapse is back
      mockIntent.setDisplayName.mockImplementation(world.setName);

      // next update: another setting changes, the name stays Bob
      await handleMessageFn(settingsUpdate(3, "Bob", "req-3"));

      expect(world.stored?.version).toBe(3);
      expect(world.shownName).toBe("Bob");
    });

    it("repairs Matrix after a crash between the write and Matrix, whatever comes in first", async () => {
      await handleMessageFn(settingsUpdate(1, "Alice", "req-1"));
      mockIntent.setDisplayName.mockRejectedValueOnce(new Error("pod killed"));
      await expect(handleMessageFn(settingsUpdate(2, "Bob", "req-2"))).rejects.toThrow("pod killed");

      await handleMessageFn(settingsUpdate(3, "Bob", "req-3"));
      await handleMessageFn(settingsUpdate(2, "Bob", "req-2"));

      expect(world.shownName).toBe("Bob");
    });

    it("fails a message whose read fails while it reconciles, and repairs Matrix on its redelivery", async () => {
      let releaseP!: () => void;
      const pHeld = new Promise<void>((resolve) => {
        releaseP = resolve;
      });
      mockIntent.setDisplayName.mockImplementationOnce(async (name: string) => {
        await pHeld;
        await world.setName(name);
      });
      const p = handleMessageFn(settingsUpdate(1, "Alice", "req-1"));
      await vi.waitFor(() => expect(mockIntent.setDisplayName).toHaveBeenCalledWith("Alice"));
      await handleMessageFn(settingsUpdate(2, "Bob", "req-2"));
      expect(world.shownName).toBe("Bob");
      spyGetUserSettings.mockRejectedValueOnce(new Error("pg read failed"));
      releaseP();
      await expect(p).rejects.toThrow("pg read failed");
      expect(world.shownName).toBe("Alice");

      await handleMessageFn(settingsUpdate(1, "Alice", "req-1"));
      expect(world.stored?.version).toBe(2);
      expect(world.shownName).toBe("Bob");
    });

    it("writes and downloads nothing for a duplicate or a stale update while Matrix shows the stored avatar", async () => {
      const avatar = "https://workspace.example.com/avatar/user.png";
      await handleMessageFn(settingsUpdate(2, "Name", "req-2", avatar));
      (global.fetch as Mock<AnyFn>).mockClear();
      mockIntent.setDisplayName.mockClear();
      mockIntent.setAvatarUrl.mockClear();
      spySaveAvatar.mockClear();

      await handleMessageFn(settingsUpdate(2, "Name", "req-2", avatar));
      await handleMessageFn(settingsUpdate(1, "Old", "req-1", "https://workspace.example.com/old.png"));

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockIntent.setDisplayName).not.toHaveBeenCalled();
      expect(mockIntent.setAvatarUrl).not.toHaveBeenCalled();
      expect(spySaveAvatar).not.toHaveBeenCalled();
    });

    it("downloads the avatar of settings saved before the avatar columns once, then not again", async () => {
      const avatar = "https://workspace.example.com/avatar/user.png";
      world.stored = {
        nickname: "@user:example.com",
        payload: {
          matrix_id: "@user:example.com",
          display_name: "Name",
          avatar,
        },
        version: 1,
        timestamp: 1640995200000,
        request_id: "req-1",
      };
      world.shownName = "Name";
      world.shownAvatar = "mxc://example.com/uploaded-by-main";

      await handleMessageFn(settingsUpdate(2, "Name", "req-2", avatar));
      await handleMessageFn(settingsUpdate(3, "Name", "req-3", avatar));

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("puts the stored settings back over a profile changed in Matrix", async () => {
      const avatar = "https://workspace.example.com/avatar/user.png";
      await handleMessageFn(settingsUpdate(1, "Name", "req-1", avatar));
      world.shownAvatar = "mxc://example.com/set-in-element";
      world.shownName = "Set in Element";

      await handleMessageFn(settingsUpdate(2, "Name", "req-2", avatar));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(world.shownName).toBe("Name");
      expect(world.shownAvatar).not.toBe("mxc://example.com/set-in-element");
    });

    it("stops reconciling after five rounds while the settings keep changing", async () => {
      let n = 1;
      spyGetUserSettings.mockImplementation(() => {
        n++;
        return Promise.resolve({
          nickname: "@user:example.com",
          payload: {
            matrix_id: "@user:example.com",
            display_name: `Name ${n}`,
          },
          version: n,
          timestamp: 1,
          request_id: `req-${n}`,
        });
      });
      mockIntent.getProfileInfo.mockClear();

      await handleMessageFn(settingsUpdate(1, "Name", "req-1"));

      expect(mockIntent.getProfileInfo).toHaveBeenCalledTimes(5);
      expect(spyGetUserSettings).toHaveBeenCalledTimes(6);
    });

    it("reads the profile as the bridge bot, so a user outside its namespace still gets the admin API", async () => {
      const outsideTheNamespace = {
        errcode: "M_EXCLUSIVE",
        message: "Invalid user localpart for this application service.",
      };
      // The intent of the user cannot register it, as for a namespace that leaves the users out
      const userIntent = {
        ...mockIntent,
        getProfileInfo: vi.fn().mockRejectedValue(outsideTheNamespace),
        setDisplayName: vi.fn().mockRejectedValue(outsideTheNamespace),
      };
      const getIntent = mockBridgeInstance.getIntent as Mock<AnyFn>;
      getIntent.mockImplementation((userId: string) => (userId === "@user:example.com" ? userIntent : mockIntent));

      try {
        await handleMessageFn(settingsUpdate(1, "Name", "req-1"));
      } finally {
        getIntent.mockImplementation(() => mockIntent);
      }

      expect(userIntent.getProfileInfo).not.toHaveBeenCalled();
      expect(mockAdminApis.upsertUser).toHaveBeenCalledWith("@user:example.com", {
        displayname: "Name",
      });
    });
  });
});
