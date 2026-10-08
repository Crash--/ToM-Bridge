import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

import { POSTER_LEVEL, type SpaceMatrix } from "./space-provisioner";

const BRIDGE_LEVEL = 100;

/**
 * What a member of the space sends in Twake Chat beyond messages: joining a
 * call (a state event, MatrixRTC), the commands of a bot (MSC4332), a poll
 * vote (MSC3381) and a resolved thread. At the state level of the bridge, a
 * member could not join a call.
 */
const MEMBER_EVENTS: Record<string, number> = {
  "org.matrix.msc3401.call.member": POSTER_LEVEL,
  "org.matrix.msc4332.commands": POSTER_LEVEL,
  "m.bot.commands": POSTER_LEVEL,
  "org.matrix.msc3381.poll.response": POSTER_LEVEL,
  "m.poll.response": POSTER_LEVEL,
  "app.twake.chat.thread_resolved": POSTER_LEVEL,
};

function errcodeOf(error: unknown): string | undefined {
  return (
    error as {
      errcode?: string;
    }
  ).errcode;
}

function isNotFound(error: unknown): boolean {
  return (
    (
      error as {
        statusCode?: number;
      }
    ).statusCode === 404
  );
}

/**
 * The bridge's Matrix spaces on one homeserver, managed by the bridge bot,
 * which must be a server admin to create accounts and join members.
 *
 * Each Matrix space carries the alias `#twake-space-<space id>`, and its General
 * room `#twake-space-<space id>-general`. The alias finds the room again from
 * the space id, and only one of two concurrent creations gets it.
 */
export class MatrixSpaces implements SpaceMatrix {
  readonly #client: MatrixClient;
  readonly #botUserId: string;
  readonly #domain: string;

  constructor(client: MatrixClient, botUserId: string, domain: string) {
    this.#client = client;
    this.#botUserId = botUserId;
    this.#domain = domain;
  }

  // The directory matches space ids whatever their case, aliases do not
  #aliasName(spaceId: string): string {
    return `twake-space-${spaceId.toLowerCase()}`;
  }

  async #resolve(aliasName: string): Promise<string | null> {
    try {
      return await this.#client.resolveRoom(`#${aliasName}:${this.#domain}`);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  findSpace(spaceId: string): Promise<string | null> {
    return this.#resolve(this.#aliasName(spaceId));
  }

  findGeneral(spaceId: string): Promise<string | null> {
    return this.#resolve(`${this.#aliasName(spaceId)}-general`);
  }

  createSpace(spaceId: string, name: string): Promise<string> {
    return this.#createRoom(this.#aliasName(spaceId), {
      name,
      preset: "private_chat",
      creation_content: {
        type: "m.space",
      },
    });
  }

  async ensureGeneral(spaceId: string, spaceRoomId: string): Promise<string> {
    const via = [
      this.#domain,
    ];
    const roomId =
      (await this.findGeneral(spaceId)) ??
      (await this.#createRoom(`${this.#aliasName(spaceId)}-general`, {
        name: "General",
        // Anyone on the organization's homeserver can join; the room directory does not list it
        preset: "public_chat",
        initial_state: [
          {
            type: "m.space.parent",
            state_key: spaceRoomId,
            content: {
              via,
              canonical: true,
            },
          },
        ],
      }));

    // Checked on every call, since a failure right after the creation leaves the room out of the space
    const child = await this.#client.getRoomStateEvent(spaceRoomId, "m.space.child", roomId).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!child?.via) {
      await this.#client.sendStateEvent(spaceRoomId, "m.space.child", roomId, {
        via,
        suggested: true,
      });
    }
    return roomId;
  }

  async #createRoom(
    aliasName: string,
    {
      initial_state = [],
      ...options
    }: {
      name: string;
      preset: "private_chat" | "public_chat";
      creation_content?: Record<string, unknown>;
      initial_state?: {
        type: string;
        state_key: string;
        content: Record<string, unknown>;
      }[];
    },
  ): Promise<string> {
    try {
      return await this.#client.createRoom({
        ...options,
        room_alias_name: aliasName,
        visibility: "private",
        initial_state: [
          {
            type: "m.room.history_visibility",
            state_key: "",
            content: {
              history_visibility: "shared",
            },
          },
          ...initial_state,
        ],
        // Only the bridge invites, kicks and changes settings, so the room never drifts from the directory beyond who joins a public one
        power_level_content_override: {
          users: {
            [this.#botUserId]: BRIDGE_LEVEL,
          },
          users_default: 0,
          events_default: POSTER_LEVEL,
          events: MEMBER_EVENTS,
          state_default: BRIDGE_LEVEL,
          invite: BRIDGE_LEVEL,
          kick: BRIDGE_LEVEL,
          ban: BRIDGE_LEVEL,
          redact: BRIDGE_LEVEL,
        },
      });
    } catch (error) {
      if (errcodeOf(error) !== "M_ROOM_IN_USE") {
        throw error;
      }
      return this.#client.resolveRoom(`#${aliasName}:${this.#domain}`);
    }
  }

  async ensureUser(matrixId: string, displayName: string): Promise<void> {
    const path = `/_synapse/admin/v2/users/${encodeURIComponent(matrixId)}`;
    try {
      await this.#client.doRequest("GET", path);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      // Without a password: the person signs in through SSO, which maps to this same account
      await this.#client.doRequest("PUT", path, null, {
        displayname: displayName,
      });
    }
  }

  async join(roomId: string, matrixId: string): Promise<void> {
    await this.#client.doRequest("POST", `/_synapse/admin/v1/join/${encodeURIComponent(roomId)}`, null, {
      user_id: matrixId,
    });
  }

  async kick(roomId: string, matrixId: string): Promise<void> {
    let membership: string | undefined;
    try {
      ({ membership } = await this.#client.getRoomStateEvent(roomId, "m.room.member", matrixId));
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    if (membership === "join" || membership === "invite") {
      await this.#client.kickUser(matrixId, roomId);
    }
  }

  async setPowerLevels(roomId: string, levels: Record<string, number | null>): Promise<void> {
    const changes = Object.entries(levels);
    if (changes.length === 0) {
      return;
    }

    const powerLevels = await this.#client.getRoomStateEvent(roomId, "m.room.power_levels", "");
    const users: Record<string, number> = {
      ...powerLevels.users,
    };
    // Rooms created before MEMBER_EVENTS get them on their next change
    const events: Record<string, number> = {
      ...MEMBER_EVENTS,
      ...powerLevels.events,
    };
    let changed = Object.keys(events).length !== Object.keys(powerLevels.events ?? {}).length;
    for (const [matrixId, level] of changes) {
      if (level === null && matrixId in users) {
        delete users[matrixId];
        changed = true;
      } else if (level !== null && users[matrixId] !== level) {
        users[matrixId] = level;
        changed = true;
      }
    }

    if (changed) {
      await this.#client.sendStateEvent(roomId, "m.room.power_levels", "", {
        ...powerLevels,
        users,
        events,
      });
    }
  }

  async rename(roomId: string, name: string): Promise<void> {
    // Every sync renames, so an unchanged name sends nothing
    const current = await this.#client.getRoomStateEvent(roomId, "m.room.name", "").catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (current?.name === name) {
      return;
    }
    await this.#client.sendStateEvent(roomId, "m.room.name", "", {
      name,
    });
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.#client.sendStateEvent(roomId, "m.room.join_rules", "", {
      join_rule: "invite",
    });
  }

  async members(roomId: string): Promise<string[]> {
    const members = await this.#client.getRoomMembers(roomId, undefined, [
      "join",
      "invite",
    ]);
    return members.map((member) => member.membershipFor).filter((matrixId) => matrixId !== this.#botUserId);
  }

  async deleteSpace(roomId: string): Promise<void> {
    try {
      // Deleting also removes the room's aliases, and runs in the background on the homeserver
      await this.#client.doRequest("DELETE", `/_synapse/admin/v2/rooms/${encodeURIComponent(roomId)}`, null, {
        purge: true,
      });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}
