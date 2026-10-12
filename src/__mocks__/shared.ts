// Shared mock objects for the bridge's leaf dependencies. Test files register
// them via mock.module() with these exact objects so every consumer (including
// cached module instances) sees the same mocks.
import { mock, type Mock } from "bun:test";

type AnyFn = (...args: any[]) => any;
type MockFn = Mock<AnyFn>;

const sharedBridgeMethods: {
  run: MockFn;
  getBot: MockFn;
  getIntent: MockFn;
} = {
  run: mock<AnyFn>().mockResolvedValue(undefined),
  getBot: mock<AnyFn>().mockReturnValue({
    getUserId: mock<AnyFn>().mockReturnValue("@bot:example.com"),
  }),
  getIntent: mock<AnyFn>(),
};

export const mockIntent: {
  ensureRegistered: MockFn;
  setDisplayName: MockFn;
  setAvatarUrl: MockFn;
  matrixClient: {
    adminApis: {
      synapse: {
        isSelfAdmin: MockFn;
        upsertUser: MockFn;
      };
    };
    uploadContentFromUrl: MockFn;
    uploadContent: MockFn;
  };
} = {
  ensureRegistered: mock<AnyFn>().mockResolvedValue(undefined),
  setDisplayName: mock<AnyFn>().mockResolvedValue(undefined),
  setAvatarUrl: mock<AnyFn>().mockResolvedValue(undefined),
  matrixClient: {
    adminApis: {
      synapse: {
        isSelfAdmin: mock<AnyFn>().mockResolvedValue(true),
        upsertUser: mock<AnyFn>().mockResolvedValue(undefined),
      },
    },
    uploadContentFromUrl: mock<AnyFn>().mockResolvedValue("mxc://example.com/avatar123"),
    uploadContent: mock<AnyFn>().mockResolvedValue("mxc://example.com/avatar123"),
  },
};
sharedBridgeMethods.getIntent.mockReturnValue(mockIntent);

type BridgeInstance = {
  run: MockFn;
  getBot: MockFn;
  getIntent: MockFn;
};

export const Bridge: Mock<AnyFn> & { new (_opts?: unknown): BridgeInstance } = mock(
  function Bridge(_opts?: unknown) {
    return sharedBridgeMethods;
  },
) as Mock<AnyFn> & { new (_opts?: unknown): BridgeInstance };

export const Logger: Mock<AnyFn> & { configure: MockFn } = mock(function Logger(_name?: string) {
  return {
    debug: mock<AnyFn>(),
    info: mock<AnyFn>(),
    warn: mock<AnyFn>(),
    error: mock<AnyFn>(),
  };
}) as Mock<AnyFn> & { configure: MockFn };
Logger.configure = mock<AnyFn>();

export const Cli: MockFn = mock(function Cli() {
  return { run: mock<AnyFn>() };
});

export const AppServiceRegistration: { generateToken: MockFn } = {
  generateToken: mock<AnyFn>().mockReturnValue("mock-token"),
};

// @linagora/rabbitmq-client
export const RabbitMQClient: MockFn = mock<AnyFn>();
// What the space events throw to reach the dead-letter queue: the mocked module still exports the real one
export { DeadLetterError } from "@linagora/rabbitmq-client";

// ./db
export const Database: MockFn = mock<AnyFn>();
