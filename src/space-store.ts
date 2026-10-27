import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Logger } from "matrix-appservice-bridge";

import type { Queries } from "./db.js";
import { spaceclock, spaces } from "./schema.js";
import type { KnownSpace, SpaceClock, SpaceRegistry } from "./space-provisioner.js";

/**
 * When each change of a space was last applied. The change is already on the
 * homeserver when it is recorded, so a failed write only loses the ordering
 * check for its key.
 */
export function createSpaceClock(db: Queries, log: Logger): SpaceClock {
  return {
    latest: async (key) => {
      const [row] = await db
        .select({
          timestamp: spaceclock.timestamp,
        })
        .from(spaceclock)
        .where(eq(spaceclock.clock_key, key));
      return row ? Number(row.timestamp) : null;
    },
    record: async (key, timestamp) => {
      try {
        await db
          .insert(spaceclock)
          .values({
            clock_key: key,
            timestamp,
          })
          .onConflictDoUpdate({
            target: spaceclock.clock_key,
            set: {
              timestamp,
            },
          });
      } catch (error) {
        log.warn(`Could not record ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

function toSpace(row: typeof spaces.$inferSelect): KnownSpace {
  return {
    spaceId: row.space_id,
    organizationId: String(row.organization_id),
    roomId: row.room_id || null,
    timestamp: Number(row.timestamp),
  };
}

// A space with no deletion date, which a row of an older bridge may leave empty
const notDeleted = sql`coalesce(${spaces.delete_at}, 0) = 0`;

/** The Matrix space of each space, and when it is due for deletion. */
export function createSpaceRegistry(db: Queries): SpaceRegistry {
  const save = async (space: KnownSpace, deleteAt: number): Promise<void> => {
    const row = {
      organization_id: space.organizationId,
      room_id: space.roomId ?? "",
      timestamp: space.timestamp,
      delete_at: deleteAt,
    };
    await db
      .insert(spaces)
      .values({
        space_id: space.spaceId,
        ...row,
      })
      .onConflictDoUpdate({
        target: spaces.space_id,
        set: row,
      });
  };

  return {
    remember: (space) => save(space, 0),
    deletionOf: async (spaceId) => {
      const [row] = await db
        .select({
          deleteAt: spaces.delete_at,
        })
        .from(spaces)
        .where(eq(spaces.space_id, spaceId));
      const deleteAt = Number(row?.deleteAt ?? 0);
      return deleteAt > 0 ? deleteAt : null;
    },
    scheduleDeletion: (space, at) => save(space, at),
    spacesOf: async (organizationId) => {
      const rows = await db
        .select()
        .from(spaces)
        .where(and(eq(spaces.organization_id, organizationId), notDeleted));
      return rows.map(toSpace);
    },
    dueBy: async (time) => {
      const rows = await db
        .select()
        .from(spaces)
        .where(and(gt(spaces.delete_at, 0), lte(spaces.delete_at, time)));
      return rows.map(toSpace);
    },
    forget: async (spaceId) => {
      await db.delete(spaces).where(eq(spaces.space_id, spaceId));
    },
    hasSpaces: async (organizationId) => {
      const rows = await db
        .select({
          spaceId: spaces.space_id,
        })
        .from(spaces)
        .where(organizationId ? eq(spaces.organization_id, organizationId) : undefined)
        .limit(1);
      return rows.length > 0;
    },
  };
}
