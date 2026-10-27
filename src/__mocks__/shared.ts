// Shared mock objects for the bridge's leaf dependencies. Test files register
// them via vi.mock() with these exact objects so every consumer (including
// cached module instances) sees the same mocks.
import { type Mock, vi } from "vitest";

type AnyFn = (...args: any[]) => any;
type MockFn = Mock<AnyFn>;

const sharedBridgeMethods: {
  run: MockFn;
  getBot: MockFn;
  getIntent: MockFn;
} = {
  run: vi.fn<AnyFn>().mockResolvedValue(undefined),
  getBot: vi.fn<AnyFn>().mockReturnValue({
    getUserId: vi.fn<AnyFn>().mockReturnValue("@bot:example.com"),
  }),
  getIntent: vi.fn<AnyFn>(),
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
  ensureRegistered: vi.fn<AnyFn>().mockResolvedValue(undefined),
  setDisplayName: vi.fn<AnyFn>().mockResolvedValue(undefined),
  setAvatarUrl: vi.fn<AnyFn>().mockResolvedValue(undefined),
  matrixClient: {
    adminApis: {
      synapse: {
        isSelfAdmin: vi.fn<AnyFn>().mockResolvedValue(true),
        upsertUser: vi.fn<AnyFn>().mockResolvedValue(undefined),
      },
    },
    uploadContentFromUrl: vi.fn<AnyFn>().mockResolvedValue("mxc://example.com/avatar123"),
    uploadContent: vi.fn<AnyFn>().mockResolvedValue("mxc://example.com/avatar123"),
  },
};
sharedBridgeMethods.getIntent.mockReturnValue(mockIntent);

type BridgeInstance = {
  run: MockFn;
  getBot: MockFn;
  getIntent: MockFn;
};

export const Bridge: Mock<AnyFn> & {
  new (_opts?: unknown): BridgeInstance;
} = vi.fn(function Bridge(_opts?: unknown) {
  return sharedBridgeMethods;
}) as Mock<AnyFn> & {
  new (_opts?: unknown): BridgeInstance;
};

export const Logger: Mock<AnyFn> & {
  configure: MockFn;
} = vi.fn(function Logger(_name?: string) {
  return {
    debug: vi.fn<AnyFn>(),
    info: vi.fn<AnyFn>(),
    warn: vi.fn<AnyFn>(),
    error: vi.fn<AnyFn>(),
  };
}) as Mock<AnyFn> & {
  configure: MockFn;
};
Logger.configure = vi.fn<AnyFn>();

export const Cli: MockFn = vi.fn(function Cli() {
  return {
    run: vi.fn<AnyFn>(),
  };
});

export const AppServiceRegistration: {
  generateToken: MockFn;
} = {
  generateToken: vi.fn<AnyFn>().mockReturnValue("mock-token"),
};

// @linagora/rabbitmq-client
export const RabbitMQClient: MockFn = vi.fn<AnyFn>();

// ./db
export const Database: MockFn = vi.fn<AnyFn>();
