import type { Logger } from "matrix-appservice-bridge";

import type { RabbitMQMessageProperties } from "@linagora/rabbitmq-client";

import { toSynapseLocalpart } from "./account-eraser";
import type { SpacesConfig } from "./types";

/** Power level of members allowed to post. Membership and settings stay at 100, the bridge's. */
export const POSTER_LEVEL = 50;

export const PROVISIONED_TYPE = "com.twake.chat.space.provisioned.v1";

/** How long a deleted space's Matrix space is kept, without members, before it is purged. */
export const RETENTION_MS: number = 30 * 24 * 60 * 60 * 1000;

const ROUTING_KEY_PREFIX = "twake.space.";

type Role = "viewer" | "editor" | "admin";

interface SpaceMember {
  readonly uuid: string;
  readonly username: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly role: Role;
}

interface NamedMember extends SpaceMember {
  readonly matrixId: string;
}

/** What the bridge does on the homeserver, as the bridge bot. */
export interface SpaceMatrix {
  findSpace(spaceId: string): Promise<string | null>;
  /** Creates the space's Matrix space, or returns the one a concurrent delivery created. */
  createSpace(spaceId: string, name: string): Promise<string>;
  ensureUser(matrixId: string, displayName: string): Promise<void>;
  join(roomId: string, matrixId: string): Promise<void>;
  /** Removes a member, doing nothing when they are not in the room. */
  kick(roomId: string, matrixId: string): Promise<void>;
  /** Sets each user's power level, null taking it back to the default. */
  setPowerLevels(roomId: string, levels: Record<string, number | null>): Promise<void>;
  rename(roomId: string, name: string): Promise<void>;
  /** The joined and invited members, the bridge bot left out. */
  members(roomId: string): Promise<string[]>;
  /** Deletes the room and purges its history, doing nothing when it is gone. */
  deleteSpace(roomId: string): Promise<void>;
}

/** A space the bridge gave a Matrix space, as of the event that last provisioned it. */
export interface KnownSpace {
  readonly spaceId: string;
  readonly organizationId: string;
  /** Null for a space deleted before it got a Matrix space. */
  readonly roomId: string | null;
  readonly timestamp: number;
}

/**
 * The bridge's spaces, kept to find the ones a sync no longer lists and the
 * ones whose Matrix space is due for deletion. Space ids are lowercased.
 */
export interface SpaceRegistry {
  remember(space: KnownSpace): Promise<void>;
  /** When the space's Matrix space gets deleted, or null when it is not being deleted. */
  deletionOf(spaceId: string): Promise<number | null>;
  scheduleDeletion(space: KnownSpace, at: number): Promise<void>;
  /** The organization's spaces that are not being deleted. */
  spacesOf(organizationId: string): Promise<KnownSpace[]>;
  dueBy(time: number): Promise<KnownSpace[]>;
  forget(spaceId: string): Promise<void>;
}

/**
 * The last applied timestamp of each part of a space. Space events reach the
 * bridge's pods in any order, so an older one must not undo a newer one.
 */
export interface SpaceClock {
  latest(key: string): Promise<number | null>;
  record(key: string, timestamp: number): Promise<void>;
}

export type PublishActivity = (type: string, event: Record<string, unknown>) => Promise<void>;

interface Deps {
  readonly matrix: SpaceMatrix;
  readonly clock: SpaceClock;
  readonly registry: SpaceRegistry;
  readonly publish: PublishActivity;
  readonly domain: string;
  readonly config: SpacesConfig;
  readonly log: Logger;
}

class InvalidSpaceEvent extends Error {}

/**
 * The event name, from a routing key ldap-rest published (`twake.space.<event>`)
 * or the control plane forwarded to one tenant (`twake.space.<event>.<organizationId>`).
 */
export function eventName(routingKey: string, organizationId: string): string {
  if (!routingKey.startsWith(ROUTING_KEY_PREFIX)) {
    throw new InvalidSpaceEvent(`${routingKey} is not a space event`);
  }
  const name = routingKey.slice(ROUTING_KEY_PREFIX.length);
  const tenantSuffix = `.${organizationId}`;
  return name.endsWith(tenantSuffix) ? name.slice(0, -tenantSuffix.length) : name;
}

function requireString(message: Record<string, unknown>, field: string): string {
  const value = message[field];
  if (typeof value !== "string" || value === "") {
    throw new InvalidSpaceEvent(`the event has no ${field}`);
  }
  return value;
}

function membersOf(message: Record<string, unknown>): SpaceMember[] {
  const { members } = message;
  if (!Array.isArray(members)) {
    throw new InvalidSpaceEvent("the event has no members");
  }
  return members as SpaceMember[];
}

function displayNameOf(member: SpaceMember): string {
  return (
    [
      member.firstName,
      member.lastName,
    ]
      .filter(Boolean)
      .join(" ") || member.username
  );
}

function levelOf(role: Role): number | null {
  return role === "viewer" ? null : POSTER_LEVEL;
}

/**
 * Builds the handler for the space events of one homeserver. It creates each
 * space's Matrix space, keeps its members and their power levels in line with
 * their roles, and announces the room on the activity exchange.
 *
 * Group events are left out: ldap-rest also publishes a member event for each
 * user whose role a group changes.
 */
export function createSpaceEventHandler({
  matrix,
  clock,
  registry,
  publish,
  domain,
  config,
  log,
}: Deps): (message: Record<string, unknown>, properties: RabbitMQMessageProperties) => Promise<void> {
  // A wrong mode would add someone else's account to the space, so an unknown one stops the bridge
  if (config.localpartFrom !== "uid" && config.localpartFrom !== "email") {
    throw new Error(`spaces.localpartFrom must be "uid" or "email", got ${JSON.stringify(config.localpartFrom)}`);
  }

  const twakeSpaceUserId = config.twakeSpaceUserId ?? `@twakespace:${domain}`;

  /** Null for a member the SSO mapping cannot name, who is left out instead of the whole event. */
  function matrixIdOf(member: SpaceMember): string | null {
    let login: string | undefined;
    if (config.localpartFrom === "uid") {
      login = member.username;
    } else {
      const at = typeof member.email === "string" ? member.email.indexOf("@") : -1;
      login = at > 0 ? member.email.slice(0, at) : undefined;
    }
    if (!login) {
      log.error(`Leaving out member ${member.uuid}: no ${config.localpartFrom === "uid" ? "username" : "email"}`);
      return null;
    }
    return `@${toSynapseLocalpart(login)}:${domain}`;
  }

  /** Applies the change only when nothing newer was applied to the same key. */
  async function unlessStale(key: string, timestamp: number, apply: () => Promise<void>): Promise<boolean> {
    const clockKey = key.toLowerCase();
    const latest = await clock.latest(clockKey);
    if (latest !== null && latest > timestamp) {
      return false;
    }
    await apply();
    await clock.record(clockKey, timestamp);
    return true;
  }

  function named(members: SpaceMember[]): NamedMember[] {
    return members.flatMap((member) => {
      const matrixId = matrixIdOf(member);
      return matrixId
        ? [
            {
              ...member,
              matrixId,
            },
          ]
        : [];
    });
  }

  async function addMembers(roomId: string, spaceId: string, members: NamedMember[], timestamp: number) {
    const levels: Record<string, number | null> = {};
    for (const member of members) {
      const { matrixId } = member;
      const applied = await unlessStale(`${spaceId}/${matrixId}`, timestamp, async () => {
        await matrix.ensureUser(matrixId, displayNameOf(member));
        await matrix.join(roomId, matrixId);
      });
      if (applied) {
        levels[matrixId] = levelOf(member.role);
      }
    }
    return levels;
  }

  async function requireSpace(spaceId: string): Promise<string> {
    const roomId = await matrix.findSpace(spaceId);
    if (!roomId) {
      // Thrown so the event is retried: its created event may still be on its way
      throw new Error(`space ${spaceId} has no Matrix space yet`);
    }
    return roomId;
  }

  /** Removes the members a sync no longer lists, unless they were added after it. */
  async function removeUnlisted(roomId: string, spaceId: string, listed: Set<string>, timestamp: number) {
    const levels: Record<string, number | null> = {};
    for (const matrixId of await matrix.members(roomId)) {
      if (listed.has(matrixId) || matrixId === twakeSpaceUserId) continue;
      if (await unlessStale(`${spaceId}/${matrixId}`, timestamp, () => matrix.kick(roomId, matrixId))) {
        levels[matrixId] = null;
      }
    }
    return levels;
  }

  /**
   * Gives the space its Matrix space and members. A sync carries the whole
   * space, so it also renames the Matrix space and removes who is not listed.
   */
  async function provision(
    message: Record<string, unknown>,
    spaceId: string,
    organizationId: string,
    timestamp: number,
    whole: boolean,
  ) {
    const name = requireString(message, "name");
    const found = await matrix.findSpace(spaceId);
    const roomId = found ?? (await matrix.createSpace(spaceId, name));
    if (found && whole) {
      await unlessStale(`${spaceId}/name`, timestamp, () => matrix.rename(roomId, name));
    }

    // An app service user only exists once its app service registers it, which TwakeSpace may not have done yet
    await matrix.ensureUser(twakeSpaceUserId, "TwakeSpace");
    await matrix.join(roomId, twakeSpaceUserId);
    const members = named(membersOf(message));
    const levels = await addMembers(roomId, spaceId, members, timestamp);
    if (whole) {
      Object.assign(
        levels,
        await removeUnlisted(roomId, spaceId, new Set(members.map((member) => member.matrixId)), timestamp),
      );
    }
    await matrix.setPowerLevels(roomId, {
      ...levels,
      [twakeSpaceUserId]: POSTER_LEVEL,
    });
    await registry.remember({
      spaceId: spaceId.toLowerCase(),
      organizationId,
      roomId,
      timestamp,
    });

    // Published again on a redelivery, with the same room, so TwakeSpace gets it whatever failed before
    await publish(PROVISIONED_TYPE, {
      specversion: "1.0",
      id: crypto.randomUUID(),
      source: "twake://chat",
      type: PROVISIONED_TYPE,
      time: new Date().toISOString(),
      twakeorg: organizationId,
      data: {
        space_id: spaceId,
        resource: {
          kind: "matrix_space",
          id: roomId,
        },
      },
    });
    log.info(`Space ${spaceId} is the Matrix space ${roomId}`);
  }

  async function onUpdated(message: Record<string, unknown>, spaceId: string, timestamp: number) {
    const { name } = message;
    if (typeof name !== "string" || name === "") {
      return;
    }
    const roomId = await requireSpace(spaceId);
    await unlessStale(`${spaceId}/name`, timestamp, () => matrix.rename(roomId, name));
  }

  async function onMemberChanged(message: Record<string, unknown>, spaceId: string, timestamp: number) {
    const roomId = await requireSpace(spaceId);
    const levels = await addMembers(roomId, spaceId, named(membersOf(message)), timestamp);
    await matrix.setPowerLevels(roomId, levels);
  }

  async function onMemberRemoved(message: Record<string, unknown>, spaceId: string, timestamp: number) {
    const roomId = await requireSpace(spaceId);
    const levels: Record<string, number | null> = {};
    for (const { matrixId } of named(membersOf(message))) {
      if (await unlessStale(`${spaceId}/${matrixId}`, timestamp, () => matrix.kick(roomId, matrixId))) {
        levels[matrixId] = null;
      }
    }
    await matrix.setPowerLevels(roomId, levels);
  }

  /** Removes every member at once, and keeps the Matrix space until its deletion is due. */
  async function removeAccess(space: KnownSpace, deletedAt: number) {
    const { roomId } = space;
    if (roomId) {
      for (const matrixId of await matrix.members(roomId)) {
        await matrix.kick(roomId, matrixId);
      }
    }
    await registry.scheduleDeletion(space, deletedAt + RETENTION_MS);
    log.info(`Space ${space.spaceId} is deleted, its Matrix space ${roomId ?? "(none)"} goes in 30 days`);
  }

  async function onDeleted(spaceId: string, organizationId: string, timestamp: number) {
    // Recorded even without a Matrix space, so a created event still being retried cannot bring it back
    await removeAccess(
      {
        spaceId: spaceId.toLowerCase(),
        organizationId,
        roomId: await matrix.findSpace(spaceId),
        timestamp,
      },
      timestamp,
    );
  }

  /** A space provisioned after the sync read the directory is not in its list, and stays. */
  async function onSyncCompleted(message: Record<string, unknown>, organizationId: string, timestamp: number) {
    const { spaceIds } = message;
    // An id dropped here would read as unlisted and delete that space
    if (!Array.isArray(spaceIds) || !spaceIds.every((id) => typeof id === "string")) {
      throw new InvalidSpaceEvent("the event has no valid spaceIds");
    }
    const listed = new Set(spaceIds.map((id: string) => id.toLowerCase()));
    for (const space of await registry.spacesOf(organizationId)) {
      if (!listed.has(space.spaceId) && space.timestamp < timestamp) {
        await removeAccess(space, timestamp);
      }
    }
  }

  async function onSpaceEvent(
    event: string,
    message: Record<string, unknown>,
    organizationId: string,
    timestamp: number,
  ) {
    const spaceId = requireString(message, "id");
    // A deleted space id is never used again, so whatever arrives after the deletion is late
    if ((await registry.deletionOf(spaceId.toLowerCase())) !== null) {
      log.info(`Ignoring ${event} for the deleted space ${spaceId}`);
      return;
    }

    switch (event) {
      case "created":
      case "synced":
        await provision(message, spaceId, organizationId, timestamp, event === "synced");
        break;
      case "updated":
        await onUpdated(message, spaceId, timestamp);
        break;
      case "member.added":
      case "member.role.changed":
        await onMemberChanged(message, spaceId, timestamp);
        break;
      case "member.removed":
        await onMemberRemoved(message, spaceId, timestamp);
        break;
      case "deleted":
        await onDeleted(spaceId, organizationId, timestamp);
        break;
      default:
        log.debug(`Ignoring space event ${event} for ${spaceId}`);
    }
  }

  async function handle(message: Record<string, unknown>, routingKey: string) {
    const organizationId = requireString(message, "organizationId");
    const timestamp = Date.parse(requireString(message, "timestamp"));
    if (Number.isNaN(timestamp)) {
      throw new InvalidSpaceEvent("the event timestamp is not a date");
    }
    const event = eventName(routingKey, organizationId);

    if (event === "sync.completed") {
      await onSyncCompleted(message, organizationId, timestamp);
    } else if (!event.startsWith("group.") && event !== "sync.requested") {
      await onSpaceEvent(event, message, organizationId, timestamp);
    } else {
      log.debug(`Ignoring space event ${event}`);
    }
  }

  return async (message, properties) => {
    try {
      await handle(message, properties.routingKey);
    } catch (error) {
      // Retrying the same bytes fails the same way, so the event is dropped instead
      if (error instanceof InvalidSpaceEvent) {
        log.error(`Discarding space event on ${properties.routingKey}: ${error.message}`);
        return;
      }
      throw error;
    }
  };
}

/** A space whose deletion fails stays due, and is tried again on the next run. */
export async function purgeDeletedSpaces(
  { matrix, registry, log }: Pick<Deps, "matrix" | "registry" | "log">,
  now: number = Date.now(),
): Promise<void> {
  for (const space of await registry.dueBy(now)) {
    try {
      if (space.roomId) {
        await matrix.deleteSpace(space.roomId);
      }
      await registry.forget(space.spaceId);
      log.info(`Deleted the Matrix space ${space.roomId} of space ${space.spaceId}`);
    } catch (error) {
      log.warn(
        `Could not delete the Matrix space ${space.roomId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
