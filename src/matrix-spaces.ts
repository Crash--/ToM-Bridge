import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

import { POSTER_LEVEL, type SpaceMatrix } from "./space-provisioner";

const BRIDGE_LEVEL = 100;

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
 * Each Matrix space carries the alias `#twake-space-<space id>`, which finds it
 * again from the space id, and which only one of two concurrent creations
 * gets.
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

  #alias(spaceId: string): string {
    return `#${this.#aliasName(spaceId)}:${this.#domain}`;
  }

  async findSpace(spaceId: string): Promise<string | null> {
    try {
      return await this.#client.resolveRoom(this.#alias(spaceId));
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async createSpace(spaceId: string, name: string): Promise<string> {
    try {
      return await this.#client.createRoom({
        name,
        room_alias_name: this.#aliasName(spaceId),
        preset: "private_chat",
        visibility: "private",
        creation_content: {
          type: "m.space",
        },
        initial_state: [
          {
            type: "m.room.history_visibility",
            state_key: "",
            content: {
              history_visibility: "shared",
            },
          },
        ],
        // Only the bridge changes membership and settings, so the room never drifts from the directory
        power_level_content_override: {
          users: {
            [this.#botUserId]: BRIDGE_LEVEL,
          },
          users_default: 0,
          events_default: POSTER_LEVEL,
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
      return this.#client.resolveRoom(this.#alias(spaceId));
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
    let changed = false;
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
