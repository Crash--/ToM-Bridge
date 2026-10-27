import type { Logger } from "matrix-appservice-bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openTestDatabase } from "./__mocks__/pglite.js";
import type { Queries } from "./db.js";
import type { KnownSpace } from "./space-provisioner.js";
import { createSpaceClock, createSpaceRegistry } from "./space-store.js";

const log = {
  warn: vi.fn(),
} as unknown as Logger;

function space(spaceId: string, organizationId = "acme"): KnownSpace {
  return {
    spaceId,
    organizationId,
    roomId: `!${spaceId}:acme.example`,
    timestamp: 1000,
  };
}

let db: Queries;

beforeEach(async () => {
  ({ db } = await openTestDatabase());
});

describe("createSpaceClock", () => {
  it("knows no time for a change never recorded, then the last one recorded", async () => {
    const clock = createSpaceClock(db, log);

    expect(await clock.latest("s1/name")).toBeNull();
    await clock.record("s1/name", 1000);
    await clock.record("s1/name", 2000);

    expect(await clock.latest("s1/name")).toBe(2000);
  });
});

describe("createSpaceRegistry", () => {
  it("lists the spaces of an organization that are not being deleted", async () => {
    const registry = createSpaceRegistry(db);
    await registry.remember(space("kept"));
    await registry.remember(space("other", "globex"));
    await registry.scheduleDeletion(space("deleted"), 5000);

    expect((await registry.spacesOf("acme")).map(({ spaceId }) => spaceId)).toEqual([
      "kept",
    ]);
    expect(await registry.deletionOf("deleted")).toBe(5000);
    expect(await registry.deletionOf("kept")).toBeNull();
  });

  it("cancels a deletion when the space is remembered again", async () => {
    const registry = createSpaceRegistry(db);
    await registry.scheduleDeletion(space("back"), 5000);
    await registry.remember(space("back"));

    expect(await registry.deletionOf("back")).toBeNull();
  });

  it("finds the spaces due by a time, and forgets them", async () => {
    const registry = createSpaceRegistry(db);
    await registry.scheduleDeletion(space("due"), 5000);
    await registry.scheduleDeletion(space("later"), 9000);
    await registry.remember(space("kept"));

    expect((await registry.dueBy(6000)).map(({ spaceId }) => spaceId)).toEqual([
      "due",
    ]);
    await registry.forget("due");
    expect(await registry.deletionOf("due")).toBeNull();
    expect(await registry.hasSpaces("acme")).toBe(true);
    expect(await registry.hasSpaces("globex")).toBe(false);
  });

  it("reads a space deleted before it got a Matrix space as having no room", async () => {
    const registry = createSpaceRegistry(db);
    await registry.remember({
      ...space("roomless"),
      roomId: null,
    });

    expect((await registry.spacesOf("acme"))[0]?.roomId).toBeNull();
  });
});
