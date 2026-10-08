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
  requestFirstSync,
  type SpaceClock,
  type SpaceRegistry,
  SYNC_REQUESTED,
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
const GENERAL = "!general:acme.example";
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
    hasSpaces: (organizationId) =>
      Promise.resolve(
        [
          ...spaces.values(),
        ].some((space) => !organizationId || space.organizationId === organizationId),
      ),
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
    findGeneral: ReturnType<typeof mock>;
    ensureGeneral: ReturnType<typeof mock>;
    ensureUser: ReturnType<typeof mock>;
    join: ReturnType<typeof mock>;
    kick: ReturnType<typeof mock>;
    setPowerLevels: ReturnType<typeof mock>;
    rename: ReturnType<typeof mock>;
    members: ReturnType<typeof mock>;
    deleteSpace: ReturnType<typeof mock>;
    closeRoom: ReturnType<typeof mock>;
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
      findGeneral: mock(async () => null),
      ensureGeneral: mock(async () => GENERAL),
      ensureUser: mock(async () => {}),
      join: mock(async () => {}),
      kick: mock(async () => {}),
      setPowerLevels: mock(async () => {}),
      rename: mock(async () => {}),
      members: mock(async () => []),
      deleteSpace: mock(async () => {}),
      closeRoom: mock(async () => {}),
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

    it("creates the Matrix space and its General room, and joins TwakeSpace and the members to both", async () => {
      matrix.findSpace.mockResolvedValue(null);

      await handler()(created, properties("created"));

      expect(matrix.createSpace).toHaveBeenCalledWith(SPACE, "Design Sprint");
      expect(matrix.ensureGeneral).toHaveBeenCalledWith(SPACE, ROOM);
      expect(matrix.ensureUser).toHaveBeenCalledWith("@twakespace:acme.example", "TwakeSpace");
      expect(matrix.ensureUser).toHaveBeenCalledWith("@jdoe:acme.example", "John Doe");
      expect(matrix.ensureUser).toHaveBeenCalledWith("@vlee:acme.example", "vlee");
      expect(matrix.join.mock.calls).toEqual([
        [
          ROOM,
          "@twakespace:acme.example",
        ],
        [
          GENERAL,
          "@twakespace:acme.example",
        ],
        [
          ROOM,
          "@jdoe:acme.example",
        ],
        [
          GENERAL,
          "@jdoe:acme.example",
        ],
        [
          ROOM,
          "@vlee:acme.example",
        ],
        [
          GENERAL,
          "@vlee:acme.example",
        ],
      ]);
    });

    it("still provisions the members when TwakeSpace cannot be created (exclusive namespace)", async () => {
      matrix.ensureUser.mockImplementation((matrixId: string) =>
        matrixId === "@twakespace:acme.example"
          ? Promise.reject(
              Object.assign(new Error("M_EXCLUSIVE"), {
                errcode: "M_EXCLUSIVE",
              }),
            )
          : Promise.resolve(),
      );

      await handler()(created, properties("created"));

      expect(matrix.join).toHaveBeenCalledWith(ROOM, "@jdoe:acme.example");
      expect(matrix.setPowerLevels).toHaveBeenCalled();
    });

    it("lets editors and TwakeSpace post, and viewers only read", async () => {
      await handler()(created, properties("created"));

      expect(matrix.setPowerLevels).toHaveBeenCalledWith(ROOM, {
        "@jdoe:acme.example": 50,
        "@vlee:acme.example": null,
        "@twakespace:acme.example": 50,
      });
    });

    it("makes the admins of the space moderate its rooms", async () => {
      await handler()(
        spaceEvent({
          name: "Design Sprint",
          members: [
            {
              ...jdoe,
              role: "admin",
            },
          ],
          groups: [],
        }),
        properties("created"),
      );

      expect(matrix.setPowerLevels).toHaveBeenCalledWith(
        ROOM,
        expect.objectContaining({
          "@jdoe:acme.example": 75,
        }),
      );
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
      expect(matrix.setPowerLevels.mock.calls.filter(([room]) => room === ROOM).at(-1)).toEqual([
        ROOM,
        {
          "@vlee:acme.example": null,
          "@twakespace:acme.example": 50,
        },
      ]);
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

    it("adds and removes a member in General too", async () => {
      matrix.findGeneral.mockResolvedValue(GENERAL);
      const member = spaceEvent({
        members: [
          jdoe,
        ],
      });

      await handler()(member, properties("member.added"));
      await handler()(
        {
          ...member,
          timestamp: "2026-10-06T12:00:00.000Z",
        },
        properties("member.removed"),
      );

      expect(matrix.join).toHaveBeenCalledWith(GENERAL, "@jdoe:acme.example");
      expect(matrix.setPowerLevels).toHaveBeenCalledWith(GENERAL, {
        "@jdoe:acme.example": 50,
      });
      expect(matrix.kick).toHaveBeenCalledWith(GENERAL, "@jdoe:acme.example");
      expect(matrix.setPowerLevels).toHaveBeenCalledWith(GENERAL, {
        "@jdoe:acme.example": null,
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

  describe("deleted", () => {
    it("removes every member and keeps the Matrix space 30 days from the deletion", async () => {
      matrix.members.mockResolvedValue([
        "@twakespace:acme.example",
        "@jdoe:acme.example",
      ]);
      const deleted = spaceEvent({});

      await handler()(deleted, properties("deleted"));

      expect(matrix.kick.mock.calls).toEqual([
        [
          ROOM,
          "@twakespace:acme.example",
        ],
        [
          ROOM,
          "@jdoe:acme.example",
        ],
      ]);
      expect(await registry.deletionOf(SPACE)).toBe(Date.parse(deleted.timestamp) + RETENTION_MS);
      expect(matrix.deleteSpace).not.toHaveBeenCalled();
    });

    it("closes General before removing everyone, so no one joins it again", async () => {
      matrix.findGeneral.mockResolvedValue(GENERAL);
      matrix.members.mockResolvedValue([
        "@jdoe:acme.example",
      ]);

      await handler()(spaceEvent({}), properties("deleted"));

      expect(matrix.closeRoom.mock.calls).toEqual([
        [
          GENERAL,
        ],
      ]);
      expect(matrix.closeRoom.mock.invocationCallOrder[0]!).toBeLessThan(matrix.kick.mock.invocationCallOrder[0]!);
    });

    it("also removes everyone from General, whoever joined it on their own included", async () => {
      matrix.findGeneral.mockResolvedValue(GENERAL);
      matrix.members.mockImplementation(async (roomId: string) =>
        roomId === GENERAL
          ? [
              "@jdoe:acme.example",
              "@guest:acme.example",
            ]
          : [
              "@jdoe:acme.example",
            ],
      );

      await handler()(spaceEvent({}), properties("deleted"));

      expect(matrix.kick.mock.calls).toEqual([
        [
          ROOM,
          "@jdoe:acme.example",
        ],
        [
          GENERAL,
          "@jdoe:acme.example",
        ],
        [
          GENERAL,
          "@guest:acme.example",
        ],
      ]);
    });

    it("records the deletion of a space without a Matrix space, so a retried created stays out", async () => {
      matrix.findSpace.mockResolvedValue(null);
      const handle = handler();

      await handle(spaceEvent({}), properties("deleted"));
      await handle(
        spaceEvent({
          name: "Design Sprint",
          members: [
            jdoe,
          ],
        }),
        properties("created"),
      );

      expect(matrix.kick).not.toHaveBeenCalled();
      expect(matrix.createSpace).not.toHaveBeenCalled();
      expect(registry.spaces.get(SPACE)?.roomId).toBeNull();
    });

    it("ignores what arrives after the deletion, the deletion included", async () => {
      matrix.members.mockResolvedValue([
        "@jdoe:acme.example",
      ]);
      const handle = handler();
      await handle(spaceEvent({}), properties("deleted"));
      const deleteAt = await registry.deletionOf(SPACE);
      matrix.kick.mockClear();

      await handle(
        spaceEvent({
          members: [
            jdoe,
          ],
        }),
        properties("member.added"),
      );
      await handle(spaceEvent({}), properties("deleted"));

      expect(matrix.join).not.toHaveBeenCalled();
      expect(matrix.kick).not.toHaveBeenCalled();
      expect(await registry.deletionOf(SPACE)).toBe(deleteAt);
    });
  });

  describe("synced", () => {
    const synced = spaceEvent({
      name: "Design Sprint",
      members: [
        jdoe,
      ],
      groups: [],
    });

    it("creates a missing Matrix space and announces it", async () => {
      matrix.findSpace.mockResolvedValue(null);

      await handler()(synced, properties("synced"));

      expect(matrix.createSpace).toHaveBeenCalledWith(SPACE, "Design Sprint");
      expect(matrix.join).toHaveBeenCalledWith(ROOM, "@jdoe:acme.example");
      expect(publish).toHaveBeenCalledWith(PROVISIONED_TYPE, expect.anything());
      expect(registry.spaces.get(SPACE)).toMatchObject({
        organizationId: "acme",
        roomId: ROOM,
        timestamp: Date.parse(synced.timestamp),
      });
    });

    it("renames the Matrix space and removes who is no longer listed", async () => {
      matrix.members.mockResolvedValue([
        "@twakespace:acme.example",
        "@jdoe:acme.example",
        "@vlee:acme.example",
      ]);

      await handler()(synced, properties("synced"));

      expect(matrix.rename.mock.calls).toEqual([
        [
          ROOM,
          "Design Sprint",
        ],
      ]);
      expect(matrix.members).toHaveBeenCalledWith(ROOM);
      expect(matrix.members).not.toHaveBeenCalledWith(GENERAL);
      expect(matrix.kick.mock.calls).toEqual([
        [
          GENERAL,
          "@vlee:acme.example",
        ],
        [
          ROOM,
          "@vlee:acme.example",
        ],
      ]);
      for (const room of [
        ROOM,
        GENERAL,
      ]) {
        expect(matrix.setPowerLevels).toHaveBeenCalledWith(room, {
          "@jdoe:acme.example": 50,
          "@vlee:acme.example": null,
          "@twakespace:acme.example": 50,
        });
      }
    });

    it("still removes from General on a retry after its kick failed", async () => {
      matrix.members.mockResolvedValue([
        "@vlee:acme.example",
      ]);
      matrix.kick.mockRejectedValueOnce(new Error("Bad Gateway"));
      const handle = handler();

      await expect(handle(synced, properties("synced"))).rejects.toThrow("Bad Gateway");
      await handle(synced, properties("synced"));

      expect(matrix.kick.mock.calls).toEqual([
        [
          GENERAL,
          "@vlee:acme.example",
        ],
        [
          GENERAL,
          "@vlee:acme.example",
        ],
        [
          ROOM,
          "@vlee:acme.example",
        ],
      ]);
    });

    it("keeps a member added after the sync read the directory", async () => {
      matrix.members.mockResolvedValue([
        "@vlee:acme.example",
      ]);
      const handle = handler();
      await handle(
        spaceEvent({
          timestamp: "2026-10-06T10:00:00.000Z",
          members: [
            viewer,
          ],
        }),
        properties("member.added"),
      );

      await handle(synced, properties("synced"));

      expect(matrix.kick).not.toHaveBeenCalled();
    });
  });

  describe("sync.completed", () => {
    function completed(spaceIds: unknown) {
      return {
        organizationId: "acme",
        spaceIds,
        timestamp: "2026-10-06T09:12:44.512Z",
      };
    }

    function known(spaceId: string, timestamp: string, organizationId = "acme") {
      return registry.remember({
        spaceId,
        organizationId,
        roomId: `!${spaceId}:acme.example`,
        timestamp: Date.parse(timestamp),
      });
    }

    it("removes access to the spaces the sync no longer lists", async () => {
      matrix.members.mockResolvedValue([
        "@jdoe:acme.example",
      ]);
      await known("gone", "2026-10-01T00:00:00.000Z");
      await known(SPACE, "2026-10-01T00:00:00.000Z");
      await known("elsewhere", "2026-10-01T00:00:00.000Z", "globex");

      await handler()(
        completed([
          SPACE.toUpperCase(),
        ]),
        properties("sync.completed"),
      );

      expect(matrix.kick.mock.calls).toEqual([
        [
          "!gone:acme.example",
          "@jdoe:acme.example",
        ],
      ]);
      expect(await registry.deletionOf("gone")).not.toBeNull();
      expect(await registry.deletionOf(SPACE)).toBeNull();
      expect(await registry.deletionOf("elsewhere")).toBeNull();
    });

    it("keeps a space provisioned after the sync read the directory", async () => {
      await known("fresh", "2026-10-06T10:00:00.000Z");

      await handler()(completed([]), properties("sync.completed"));

      expect(await registry.deletionOf("fresh")).toBeNull();
    });

    it("drops an event without spaceIds instead of retrying it", async () => {
      await known("gone", "2026-10-01T00:00:00.000Z");

      await handler()(completed(undefined), properties("sync.completed"));

      expect(await registry.deletionOf("gone")).toBeNull();
    });

    it("drops an event with a malformed space id instead of deleting that space", async () => {
      await known("gone", "2026-10-01T00:00:00.000Z");

      await handler()(
        completed([
          {
            id: "gone",
          },
        ]),
        properties("sync.completed"),
      );

      expect(await registry.deletionOf("gone")).toBeNull();
    });
  });
});

describe("requestFirstSync", () => {
  it("requests a sync of the organization while the bridge knows none of its spaces", async () => {
    const registry = memoryRegistry();
    const publish = mock(() => Promise.resolve());

    await requestFirstSync({
      registry,
      publish,
      organizationId: "acme",
      log,
    });

    expect(publish).toHaveBeenCalledWith(SYNC_REQUESTED, {
      organizationId: "acme",
      timestamp: expect.any(String),
    });
  });

  it("requests a sync of every organization when none is configured", async () => {
    const publish = mock(() => Promise.resolve());

    await requestFirstSync({
      registry: memoryRegistry(),
      publish,
      log,
    });

    expect(publish).toHaveBeenCalledWith(SYNC_REQUESTED, {
      timestamp: expect.any(String),
    });
  });

  it("requests nothing once it knows a space, or without the database", async () => {
    const registry = memoryRegistry();
    await registry.remember({
      spaceId: "known",
      organizationId: "acme",
      roomId: ROOM,
      timestamp: 0,
    });
    const publish = mock(() => Promise.resolve());

    await requestFirstSync({
      registry,
      publish,
      organizationId: "acme",
      log,
    });
    await requestFirstSync({
      registry: {
        ...memoryRegistry(),
        hasSpaces: () => Promise.resolve(null),
      },
      publish,
      organizationId: "acme",
      log,
    });

    expect(publish).not.toHaveBeenCalled();
  });
});

describe("purgeDeletedSpaces", () => {
  it("deletes the Matrix spaces whose retention is over, and keeps a failed one for the next run", async () => {
    const registry = memoryRegistry();
    const space = (spaceId: string): KnownSpace => ({
      spaceId,
      organizationId: "acme",
      roomId: `!${spaceId}:acme.example`,
      timestamp: 0,
    });
    await registry.scheduleDeletion(space("due"), 1_000);
    await registry.scheduleDeletion(space("failing"), 1_000);
    await registry.scheduleDeletion(space("later"), 5_000);
    const matrix = {
      findGeneral: mock(async (spaceId: string) => (spaceId === "due" ? "!due-general:acme.example" : null)),
      deleteSpace: mock((roomId: string) =>
        roomId === "!failing:acme.example" ? Promise.reject(new Error("boom")) : Promise.resolve(),
      ),
    };

    await purgeDeletedSpaces(
      {
        matrix: matrix as never,
        registry,
        log,
      },
      2_000,
    );

    expect(matrix.deleteSpace.mock.calls).toEqual([
      [
        "!due-general:acme.example",
      ],
      [
        "!due:acme.example",
      ],
      [
        "!failing:acme.example",
      ],
    ]);
    expect([
      ...registry.spaces.keys(),
    ]).toEqual([
      "failing",
      "later",
    ]);
  });
});
