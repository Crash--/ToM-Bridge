import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { Logger } from "matrix-appservice-bridge";

import type { RabbitMQMessageProperties } from "@linagora/rabbitmq-client";

import {
  createSpaceEventHandler,
  eventName,
  type KnownSpace,
  PROVISIONED_TYPE,
  purgeDeletedSpaces,
  RETENTION_MS,
  type SpaceClock,
  type SpaceRegistry,
} from "./space-provisioner";
import type { SpacesConfig } from "./types";

const log = {
  info: mock(),
  warn: mock(),
  error: mock(),
  debug: mock(),
} as unknown as Logger;

const config: SpacesConfig = {
  exchange: "cs.instances.out.exchange",
  queue: "chat.space.acme.queue",
  routingKey: "twake.space.#.acme",
  activityExchange: "activity",
  localpartFrom: "uid",
};

const ROOM = "!space:acme.example";
const SPACE = "3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091";

const jdoe = {
  uuid: "6f1c0a52-8e3b-4d7f-a9c2-5b0e1d4f7a83",
  username: "jdoe",
  email: "John.Doe@acme.example",
  firstName: "John",
  lastName: "Doe",
  role: "editor",
};

const viewer = {
  uuid: "0d7e3b1a-2c4f-4e5a-8b9c-1f2e3d4c5b6a",
  username: "vlee",
  email: "vlee@acme.example",
  role: "viewer",
};

function properties(event: string): RabbitMQMessageProperties {
  return {
    exchange: "cs.instances.out.exchange",
    routingKey: `twake.space.${event}.acme`,
    headers: {},
  };
}

function spaceEvent(fields: Record<string, unknown>) {
  return {
    organizationId: "acme",
    id: SPACE,
    actor: "jsmith",
    timestamp: "2026-10-06T09:12:44.512Z",
    ...fields,
  };
}

function memoryClock(): SpaceClock {
  const applied = new Map<string, number>();
  return {
    latest: (key) => Promise.resolve(applied.get(key) ?? null),
    record: (key, timestamp) => {
      applied.set(key, timestamp);
      return Promise.resolve();
    },
  };
}

function memoryRegistry(): SpaceRegistry & {
  spaces: Map<
    string,
    KnownSpace & {
      deleteAt: number | null;
    }
  >;
} {
  const spaces = new Map<
    string,
    KnownSpace & {
      deleteAt: number | null;
    }
  >();
  return {
    spaces,
    remember: (space) => {
      spaces.set(space.spaceId, {
        ...space,
        deleteAt: spaces.get(space.spaceId)?.deleteAt ?? null,
      });
      return Promise.resolve();
    },
    deletionOf: (spaceId) => Promise.resolve(spaces.get(spaceId)?.deleteAt ?? null),
    scheduleDeletion: (space, at) => {
      spaces.set(space.spaceId, {
        ...space,
        deleteAt: at,
      });
      return Promise.resolve();
    },
    spacesOf: (organizationId) =>
      Promise.resolve(
        [
          ...spaces.values(),
        ].filter((space) => space.organizationId === organizationId && space.deleteAt === null),
      ),
    dueBy: (time) =>
      Promise.resolve(
        [
          ...spaces.values(),
        ].filter((space) => space.deleteAt !== null && space.deleteAt <= time),
      ),
    forget: (spaceId) => {
      spaces.delete(spaceId);
      return Promise.resolve();
    },
  };
}

describe("eventName", () => {
  it.each([
    [
      "twake.space.created.acme",
      "created",
    ],
    [
      "twake.space.member.role.changed.acme",
      "member.role.changed",
    ],
    [
      "twake.space.member.added",
      "member.added",
    ],
  ])("reads %p as %p", (routingKey, name) => {
    expect(eventName(routingKey, "acme")).toBe(name);
  });
});

describe("createSpaceEventHandler", () => {
  let matrix: {
    findSpace: ReturnType<typeof mock>;
    createSpace: ReturnType<typeof mock>;
    ensureUser: ReturnType<typeof mock>;
    join: ReturnType<typeof mock>;
    kick: ReturnType<typeof mock>;
    setPowerLevels: ReturnType<typeof mock>;
    rename: ReturnType<typeof mock>;
    members: ReturnType<typeof mock>;
    deleteSpace: ReturnType<typeof mock>;
  };
  let publish: ReturnType<typeof mock>;
  let clock: SpaceClock;
  let registry: ReturnType<typeof memoryRegistry>;

  function handler(overrides: Partial<SpacesConfig> = {}) {
    return createSpaceEventHandler({
      matrix,
      clock,
      registry,
      publish,
      domain: "acme.example",
      config: {
        ...config,
        ...overrides,
      },
      log,
    });
  }

  beforeEach(() => {
    matrix = {
      findSpace: mock(async () => ROOM),
      createSpace: mock(async () => ROOM),
      ensureUser: mock(async () => {}),
      join: mock(async () => {}),
      kick: mock(async () => {}),
      setPowerLevels: mock(async () => {}),
      rename: mock(async () => {}),
      members: mock(async () => []),
      deleteSpace: mock(async () => {}),
    };
    publish = mock(async () => {});
    clock = memoryClock();
    registry = memoryRegistry();
  });

  it("refuses an unknown localpartFrom", () => {
    expect(() =>
      handler({
        localpartFrom: "cn" as "uid",
      }),
    ).toThrow("spaces.localpartFrom");
  });

  describe("created", () => {
    const created = spaceEvent({
      name: "Design Sprint",
      members: [
        jdoe,
        viewer,
      ],
      groups: [],
    });

    it("creates the Matrix space and joins TwakeSpace and the members", async () => {
      matrix.findSpace.mockResolvedValue(null);

      await handler()(created, properties("created"));

      expect(matrix.createSpace).toHaveBeenCalledWith(SPACE, "Design Sprint");
      expect(matrix.ensureUser).toHaveBeenCalledWith("@twakespace:acme.example", "TwakeSpace");
      expect(matrix.ensureUser).toHaveBeenCalledWith("@jdoe:acme.example", "John Doe");
      expect(matrix.ensureUser).toHaveBeenCalledWith("@vlee:acme.example", "vlee");
      expect(matrix.join.mock.calls).toEqual([
        [
          ROOM,
          "@twakespace:acme.example",
        ],
        [
          ROOM,
          "@jdoe:acme.example",
        ],
        [
          ROOM,
          "@vlee:acme.example",
        ],
      ]);
    });

    it("lets editors, admins and TwakeSpace post, and viewers only read", async () => {
      await handler()(created, properties("created"));

      expect(matrix.setPowerLevels).toHaveBeenCalledWith(ROOM, {
        "@jdoe:acme.example": 50,
        "@vlee:acme.example": null,
        "@twakespace:acme.example": 50,
      });
    });

    it("names accounts after the email when the homeserver does", async () => {
      await handler({
        localpartFrom: "email",
      })(created, properties("created"));

      expect(matrix.join).toHaveBeenCalledWith(ROOM, "@john.doe:acme.example");
    });

    it("leaves out a member it cannot name and adds the others", async () => {
      await handler({
        localpartFrom: "email",
      })(
        {
          ...created,
          members: [
            {
              ...jdoe,
              uuid: "u-no-email",
              email: "nodomain",
            },
            jdoe,
          ],
        },
        properties("created"),
      );

      expect(matrix.join).toHaveBeenCalledWith(ROOM, "@john.doe:acme.example");
      expect(matrix.join).not.toHaveBeenCalledWith(ROOM, "@nodomai:acme.example");
      expect(publish).toHaveBeenCalled();
    });

    it("joins the configured TwakeSpace user", async () => {
      await handler({
        twakeSpaceUserId: "@feed:acme.example",
      })(created, properties("created"));

      expect(matrix.join).toHaveBeenCalledWith(ROOM, "@feed:acme.example");
    });

    it("announces the Matrix space on the activity exchange", async () => {
      await handler()(created, properties("created"));

      expect(publish).toHaveBeenCalledTimes(1);
      const [type, event] = publish.mock.calls[0]!;
      expect(type).toBe(PROVISIONED_TYPE);
      expect(event).toMatchObject({
        specversion: "1.0",
        source: "twake://chat",
        type: PROVISIONED_TYPE,
        twakeorg: "acme",
        data: {
          space_id: SPACE,
          resource: {
            kind: "matrix_space",
            id: ROOM,
          },
        },
      });
    });

    it("reuses the Matrix space on a redelivery and announces it again", async () => {
      await handler()(created, properties("created"));

      expect(matrix.createSpace).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it("leaves out a member whose role changed after the space was created", async () => {
      const h = handler();
      await h(
        spaceEvent({
          timestamp: "2026-10-06T10:00:00.000Z",
          members: [
            {
              ...jdoe,
              role: "viewer",
            },
          ],
        }),
        properties("member.role.changed"),
      );
      matrix.join.mockClear();

      await h(created, properties("created"));

      expect(matrix.join).not.toHaveBeenCalledWith(ROOM, "@jdoe:acme.example");
      expect(matrix.setPowerLevels).toHaveBeenLastCalledWith(ROOM, {
        "@vlee:acme.example": null,
        "@twakespace:acme.example": 50,
      });
    });
  });

  describe("member events", () => {
    it("adds a member with the level of their role", async () => {
      await handler()(
        spaceEvent({
          members: [
            jdoe,
          ],
        }),
        properties("member.added"),
      );

      expect(matrix.join).toHaveBeenCalledWith(ROOM, "@jdoe:acme.example");
      expect(matrix.setPowerLevels).toHaveBeenCalledWith(ROOM, {
        "@jdoe:acme.example": 50,
      });
    });

    it("fails, so it is retried, while the space has no Matrix space", async () => {
      matrix.findSpace.mockResolvedValue(null);

      await expect(
        handler()(
          spaceEvent({
            members: [
              jdoe,
            ],
          }),
          properties("member.added"),
        ),
      ).rejects.toThrow("has no Matrix space yet");
    });

    it("ignores a role change older than the last one applied", async () => {
      const h = handler();
      await h(
        spaceEvent({
          timestamp: "2026-10-06T10:00:00.000Z",
          members: [
            jdoe,
          ],
        }),
        properties("member.role.changed"),
      );
      matrix.setPowerLevels.mockClear();

      await h(
        spaceEvent({
          timestamp: "2026-10-06T09:00:00.000Z",
          members: [
            {
              ...jdoe,
              role: "viewer",
            },
          ],
        }),
        properties("member.role.changed"),
      );

      expect(matrix.setPowerLevels).toHaveBeenCalledWith(ROOM, {});
    });

    it("removes a member and their level", async () => {
      await handler()(
        spaceEvent({
          members: [
            jdoe,
          ],
        }),
        properties("member.removed"),
      );

      expect(matrix.kick).toHaveBeenCalledWith(ROOM, "@jdoe:acme.example");
      expect(matrix.setPowerLevels).toHaveBeenCalledWith(ROOM, {
        "@jdoe:acme.example": null,
      });
    });
  });

  it("renames the Matrix space", async () => {
    await handler()(
      spaceEvent({
        name: "Launch",
      }),
      properties("updated"),
    );

    expect(matrix.rename).toHaveBeenCalledWith(ROOM, "Launch");
  });

  it("ignores group events", async () => {
    await handler()(
      spaceEvent({
        groups: [
          {
            id: "g1",
            name: "Design",
            role: "editor",
          },
        ],
      }),
      properties("group.linked"),
    );

    expect(matrix.findSpace).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no organization",
      spaceEvent({
        organizationId: undefined,
      }),
    ],
    [
      "no space id",
      spaceEvent({
        id: undefined,
      }),
    ],
    [
      "a timestamp that is not a date",
      spaceEvent({
        timestamp: "yesterday",
      }),
    ],
    [
      "no members",
      spaceEvent({}),
    ],
  ])("drops an event with %s instead of retrying it", async (_, event) => {
    await handler()(event, properties("member.added"));

    expect(matrix.join).not.toHaveBeenCalled();
  });
});
