import type { Logger } from "matrix-appservice-bridge";

import type { RabbitMQMessageProperties } from "@linagora/rabbitmq-client";

import { toSynapseLocalpart } from "./account-eraser";
import type { SpacesConfig } from "./types";

/** Power level of members allowed to post. Membership and settings stay at 100, the bridge's. */
export const POSTER_LEVEL = 50;

export const PROVISIONED_TYPE = "com.twake.chat.space.provisioned.v1";

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
  publish,
  domain,
  config,
  log,
}: Deps): (message: Record<string, unknown>, properties: RabbitMQMessageProperties) => Promise<void> {
  // A wrong mode would add someone else's account to the space, so an unknown one stops the bridge
  if (config.localpartFrom !== "uid" && config.localpartFrom !== "email") {
    throw new Error(`spaces.localpartFrom must be "uid" or "email", got ${JSON.stringify(config.localpartFrom)}`);
  }

  const twakeSpaceUserId = config.twakeSpaceUserId ?? `@twake-space:${domain}`;

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

  async function addMembers(roomId: string, spaceId: string, members: SpaceMember[], timestamp: number) {
    const levels: Record<string, number | null> = {};
    for (const member of members) {
      const matrixId = matrixIdOf(member);
      if (!matrixId) continue;
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

  async function onCreated(
    message: Record<string, unknown>,
    spaceId: string,
    organizationId: string,
    timestamp: number,
  ) {
    const name = requireString(message, "name");
    const roomId = (await matrix.findSpace(spaceId)) ?? (await matrix.createSpace(spaceId, name));

    await matrix.join(roomId, twakeSpaceUserId);
    const levels = await addMembers(roomId, spaceId, membersOf(message), timestamp);
    await matrix.setPowerLevels(roomId, {
      ...levels,
      [twakeSpaceUserId]: POSTER_LEVEL,
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
    const levels = await addMembers(roomId, spaceId, membersOf(message), timestamp);
    await matrix.setPowerLevels(roomId, levels);
  }

  async function onMemberRemoved(message: Record<string, unknown>, spaceId: string, timestamp: number) {
    const roomId = await requireSpace(spaceId);
    const levels: Record<string, number | null> = {};
    for (const member of membersOf(message)) {
      const matrixId = matrixIdOf(member);
      if (!matrixId) continue;
      if (await unlessStale(`${spaceId}/${matrixId}`, timestamp, () => matrix.kick(roomId, matrixId))) {
        levels[matrixId] = null;
      }
    }
    await matrix.setPowerLevels(roomId, levels);
  }

  async function handle(message: Record<string, unknown>, routingKey: string) {
    const organizationId = requireString(message, "organizationId");
    const spaceId = requireString(message, "id");
    const timestamp = Date.parse(requireString(message, "timestamp"));
    if (Number.isNaN(timestamp)) {
      throw new InvalidSpaceEvent("the event timestamp is not a date");
    }
    const event = eventName(routingKey, organizationId);

    switch (event) {
      case "created":
        await onCreated(message, spaceId, organizationId, timestamp);
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
      default:
        log.debug(`Ignoring space event ${event} for ${spaceId}`);
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
