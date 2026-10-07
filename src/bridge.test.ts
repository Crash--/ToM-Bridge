import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from "bun:test";

import { MatrixProfileUpdater } from "./matrix-profile-updater";
import { SettingsRepository } from "./settings-repository";
import type { BridgeConfig, ISettingsPayload, StoredUserSettings } from "./types";
import {
  AppServiceRegistration,
  Bridge,
  Cli,
  Database as MockDatabase,
  Logger,
  RabbitMQClient as MockRabbitMQClient,
} from "./__mocks__/shared";

type AnyFn = (...args: any[]) => any;

// Register the shared leaf-dependency mocks for this test file. The real
// SettingsRepository and MatrixProfileUpdater run against these mocks and are
// observed through prototype spies below.
mock.module("matrix-appservice-bridge", () => ({ AppServiceRegistration, Bridge, Cli, Logger }));
mock.module("@linagora/rabbitmq-client", () => ({ RabbitMQClient: MockRabbitMQClient }));
mock.module("./db", () => ({ Database: MockDatabase }));

const { CommonSettingsBridge } = await import("./bridge");

describe("CommonSettingsBridge", () => {
  let bridge: InstanceType<typeof CommonSettingsBridge>;
  let mockConfig: BridgeConfig;
  let mockBridgeInstance: InstanceType<typeof Bridge>;
  let mockIntent: any;
  let mockDatabase: {
    ready: Promise<void>;
    get: Mock<AnyFn>;
    insert: Mock<AnyFn>;
    update: Mock<AnyFn>;
    getHigherThan: Mock<AnyFn>;
    deleteEqual: Mock<AnyFn>;
    close: Mock<AnyFn>;
    ensureColumns: Mock<AnyFn>;
  };
  let mockClient: {
    init: Mock<AnyFn>;
    subscribe: Mock<AnyFn>;
    publish: Mock<AnyFn>;
    close: Mock<AnyFn>;
  };
  let spyGetUserSettings: Mock<AnyFn>;
  let spySaveSettings: Mock<AnyFn>;
  let spyProcessChanges: Mock<AnyFn>;
  let mockAdminApis: any;

  beforeEach(() => {
    mock.clearAllMocks();

    // Setup config
    mockConfig = {
      homeserverUrl: "https://matrix.example.com",
      domain: "example.com",
      registrationPath: "/path/to/registration.yaml",
      database: {
        engine: "pg",
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

    // Mock database
    mockDatabase = {
      ready: Promise.resolve(),
      get: mock(),
      insert: mock(),
      update: mock(),
      getHigherThan: mock().mockResolvedValue([]),
      deleteEqual: mock().mockResolvedValue(undefined),
      close: mock(),
      ensureColumns: mock().mockResolvedValue(undefined),
    } as any;
    MockDatabase.mockImplementation(() => mockDatabase);

    // Mock RabbitMQ client
    mockClient = {
      init: mock().mockResolvedValue(undefined),
      subscribe: mock().mockResolvedValue(undefined),
      publish: mock().mockResolvedValue(undefined),
      close: mock().mockResolvedValue(undefined),
    } as any;
    MockRabbitMQClient.mockImplementation(() => mockClient);

    // Mock admin APIs
    mockAdminApis = {
      isSelfAdmin: mock().mockResolvedValue(true),
      upsertUser: mock().mockResolvedValue(undefined),
    };

    // Mock Intent
    mockIntent = {
      ensureRegistered: mock().mockResolvedValue(undefined),
      setDisplayName: mock().mockResolvedValue(undefined),
      setAvatarUrl: mock().mockResolvedValue(undefined),
      matrixClient: {
        adminApis: {
          synapse: mockAdminApis,
        },
        uploadContentFromUrl: mock().mockResolvedValue("mxc://example.com/avatar123"),
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
    spyGetUserSettings = spyOn(SettingsRepository.prototype, "getUserSettings");
    spySaveSettings = spyOn(SettingsRepository.prototype, "saveSettings");
    spyProcessChanges = spyOn(MatrixProfileUpdater.prototype, "processChanges");

    // Mock global fetch: the real MatrixProfileUpdater downloads avatars
    global.fetch = mock(() =>
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
    spySaveSettings.mockRestore();
    spyProcessChanges.mockRestore();
  });

  describe("constructor", () => {
    it("should initialize bridge instance with config", () => {
      bridge = new CommonSettingsBridge(mockConfig);

      expect(bridge).toBeInstanceOf(CommonSettingsBridge);
      expect(MockDatabase).toHaveBeenCalledWith(
        expect.objectContaining({
          database_engine: "pg",
          database_host: "localhost",
          database_name: "testdb",
          database_user: "testuser",
          database_password: "testpass",
        }),
        expect.any(Object),
        expect.objectContaining({
          usersettings: expect.any(String),
        }),
      );
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

    it("should wait for database to be ready", async () => {
      const readyPromise = Promise.resolve();
      mockDatabase.ready = readyPromise;

      await bridge.start();

      await expect(readyPromise).resolves.toBeUndefined();
    });

    it("should initialize settings repository", async () => {
      await bridge.start();

      const handleMessageFn = (mockClient.subscribe as Mock<AnyFn>).mock.calls[0]![3];
      mockDatabase.get.mockResolvedValue([]);
      await handleMessageFn({
        source: "test-app",
        nickname: "@user:example.com",
        request_id: "req-1",
        timestamp: 1,
        version: 1,
        payload: { matrix_id: "@user:example.com" },
      });

      expect(mockDatabase.get).toHaveBeenCalledWith(
        "usersettings",
        ["matrix_id", "settings", "version", "timestamp", "request_id"],
        { matrix_id: "@user:example.com" },
      );
    });

    it("should initialize profile updater with fallback retry mode", async () => {
      await bridge.start();

      const handleMessageFn = (mockClient.subscribe as Mock<AnyFn>).mock.calls[0]![3];
      mockDatabase.get.mockResolvedValue([
        {
          matrix_id: "@user:example.com",
          settings: JSON.stringify({ matrix_id: "@user:example.com", display_name: "Old Name" }),
          version: 1,
          timestamp: Date.now() - 1000,
          request_id: "req-old",
        },
      ]);
      mockIntent.setDisplayName.mockRejectedValueOnce({ errcode: "M_FORBIDDEN", message: "Forbidden" });

      await handleMessageFn({
        source: "test-app",
        nickname: "@user:example.com",
        request_id: "req-2",
        timestamp: Date.now(),
        version: 2,
        payload: { matrix_id: "@user:example.com", display_name: "New Name" },
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
        mockIntent.matrixClient.doRequest = mock().mockResolvedValue({});
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
          resolveRoom: mock().mockResolvedValue("!space:example.com"),
          doRequest: mock().mockResolvedValue({}),
          getRoomStateEvent: mock().mockResolvedValue({
            users: {},
          }),
          sendStateEvent: mock().mockResolvedValue("$event"),
          getRoomMembers: mock().mockResolvedValue([]),
        });
        mockDatabase.get.mockResolvedValue([]);
        mockDatabase.update.mockResolvedValue([]);
        mockDatabase.insert.mockResolvedValue([]);
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
            queueArguments: {
              "x-single-active-consumer": true,
            },
            concurrency: 1,
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

        expect(mockDatabase.insert).toHaveBeenCalledWith("spaceclock", {
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

        expect(mockDatabase.insert).toHaveBeenCalledWith("spaces", {
          space_id: "3b9e2c71",
          organization_id: "acme",
          room_id: "!space:example.com",
          timestamp: Date.parse(created.timestamp),
          delete_at: expect.any(Number),
        });
      });

      it("purges the Matrix spaces whose retention is over", async () => {
        mockDatabase.getHigherThan.mockResolvedValue([
          {
            space_id: "gone",
            organization_id: "acme",
            room_id: "!gone:example.com",
            timestamp: 0,
            delete_at: 1,
          },
        ]);

        await startWithSpaces();
        await Bun.sleep(0);

        expect(mockIntent.matrixClient.doRequest).toHaveBeenCalledWith(
          "DELETE",
          "/_synapse/admin/v2/rooms/!gone%3Aexample.com",
          null,
          {
            purge: true,
          },
        );
        expect(mockDatabase.deleteEqual).toHaveBeenCalledWith("spaces", "space_id", "gone");
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

      expect(mockDatabase.close).toHaveBeenCalled();
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
      expect(mockDatabase.close).toHaveBeenCalled();
    });
  });

  describe("#handleMessage orchestration", () => {
    let handleMessageFn: (message: Record<string, unknown>) => Promise<void>;
    let mockUserSettings: StoredUserSettings | null;
    let mockPayload: ISettingsPayload;

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

    it("should discard duplicate messages (same request_id)", async () => {
      mockUserSettings = {
        nickname: "@user:example.com",
        payload: mockPayload,
        version: 1,
        timestamp: 1640991600000,
        request_id: "req-123",
      };
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spyProcessChanges).not.toHaveBeenCalled();
      expect(spySaveSettings).not.toHaveBeenCalled();
    });

    it("should discard stale updates (lower version)", async () => {
      mockUserSettings = {
        nickname: "@user:example.com",
        payload: mockPayload,
        version: 5,
        timestamp: 1640998800000,
        request_id: "req-999",
      };
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spyProcessChanges).not.toHaveBeenCalled();
      expect(spySaveSettings).not.toHaveBeenCalled();
    });

    it("should process changes for new user", async () => {
      mockUserSettings = null;
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spyProcessChanges).toHaveBeenCalledWith("@user:example.com", null, mockPayload);
    });

    it("should process changes for existing user with higher version", async () => {
      const oldPayload: ISettingsPayload = {
        matrix_id: "@user:example.com",
        display_name: "Old Name",
        avatar: "https://example.com/old-avatar.jpg",
        email: "old@example.com",
        phone: "+9876543210",
        language: "en",
        timezone: "UTC",
        last_name: "Doe",
        first_name: "John",
      };
      mockUserSettings = {
        nickname: "@user:example.com",
        payload: oldPayload,
        version: 1,
        timestamp: 1640991600000,
        request_id: "req-old",
      };
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spyProcessChanges).toHaveBeenCalledWith("@user:example.com", oldPayload, mockPayload);
    });

    it("should save settings for new user", async () => {
      mockUserSettings = null;
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spySaveSettings).toHaveBeenCalledWith(
        "@user:example.com",
        mockPayload,
        2,
        1640995200000,
        "req-123",
        true,
      );
    });

    it("should save settings for existing user", async () => {
      mockUserSettings = {
        nickname: "@user:example.com",
        payload: mockPayload,
        version: 1,
        timestamp: 1640991600000,
        request_id: "req-old",
      };
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      expect(spySaveSettings).toHaveBeenCalledWith(
        "@user:example.com",
        mockPayload,
        2,
        1640995200000,
        "req-123",
        false,
      );
    });

    it("should execute orchestration steps in correct order", async () => {
      mockUserSettings = {
        nickname: "@user:example.com",
        payload: {
          matrix_id: "@user:example.com",
          display_name: "Old Name",
          avatar: "https://example.com/old.jpg",
          email: "old@example.com",
          phone: "+9999999999",
          language: "en",
          timezone: "UTC",
          last_name: "Doe",
          first_name: "John",
        },
        version: 1,
        timestamp: 1640991600000,
        request_id: "req-old",
      };
      spyGetUserSettings.mockResolvedValue(mockUserSettings);

      await handleMessageFn(buildMessage());

      const getSettingsOrder = spyGetUserSettings.mock.invocationCallOrder[0]!;
      const processChangesOrder = spyProcessChanges.mock.invocationCallOrder[0]!;
      const saveSettingsOrder = spySaveSettings.mock.invocationCallOrder[0]!;

      expect(getSettingsOrder).toBeDefined();
      expect(processChangesOrder).toBeDefined();
      expect(saveSettingsOrder).toBeDefined();

      expect(getSettingsOrder).toBeLessThan(processChangesOrder);
      expect(processChangesOrder).toBeLessThan(saveSettingsOrder);
    });
  });
});
