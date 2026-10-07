import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

import { MatrixSpaces } from "./matrix-spaces";

const ROOM = "!space:acme.example";
const SPACE = "3b9e2c71";

function matrixError(statusCode: number, errcode: string) {
  return Object.assign(new Error(errcode), {
    statusCode,
    errcode,
  });
}

describe("MatrixSpaces", () => {
  let client: {
    resolveRoom: ReturnType<typeof mock>;
    createRoom: ReturnType<typeof mock>;
    doRequest: ReturnType<typeof mock>;
    getRoomStateEvent: ReturnType<typeof mock>;
    sendStateEvent: ReturnType<typeof mock>;
    kickUser: ReturnType<typeof mock>;
    getRoomMembers: ReturnType<typeof mock>;
  };
  let spaces: MatrixSpaces;

  beforeEach(() => {
    client = {
      resolveRoom: mock(async () => ROOM),
      createRoom: mock(async () => ROOM),
      doRequest: mock(async () => ({})),
      getRoomStateEvent: mock(async () => ({})),
      sendStateEvent: mock(async () => "$event"),
      kickUser: mock(async () => {}),
      getRoomMembers: mock(async () => []),
    };
    spaces = new MatrixSpaces(client as unknown as MatrixClient, "@bot:acme.example", "acme.example");
  });

  it("finds a space by its alias", async () => {
    expect(await spaces.findSpace(SPACE)).toBe(ROOM);
    expect(client.resolveRoom).toHaveBeenCalledWith(`#twake-space-${SPACE}:acme.example`);
  });

  it("finds a space whatever the case of its id", async () => {
    await spaces.findSpace("Team-ONE");
    expect(client.resolveRoom).toHaveBeenCalledWith("#twake-space-team-one:acme.example");
  });

  it("finds no space when the alias is unknown", async () => {
    client.resolveRoom.mockRejectedValue(matrixError(404, "M_NOT_FOUND"));

    expect(await spaces.findSpace(SPACE)).toBeNull();
  });

  it("creates an unencrypted Matrix space only the bridge manages", async () => {
    await spaces.createSpace(SPACE, "Design Sprint");

    const [options] = client.createRoom.mock.calls[0]!;
    expect(options).toMatchObject({
      name: "Design Sprint",
      room_alias_name: `twake-space-${SPACE}`,
      creation_content: {
        type: "m.space",
      },
      power_level_content_override: {
        users: {
          "@bot:acme.example": 100,
        },
        events_default: 50,
        invite: 100,
        kick: 100,
      },
    });
    expect(JSON.stringify(options)).not.toContain("m.room.encryption");
  });

  it("returns the space a concurrent delivery created", async () => {
    client.createRoom.mockRejectedValue(matrixError(400, "M_ROOM_IN_USE"));

    expect(await spaces.createSpace(SPACE, "Design Sprint")).toBe(ROOM);
  });

  it("creates an account Synapse does not know", async () => {
    client.doRequest.mockImplementationOnce(() => Promise.reject(matrixError(404, "M_NOT_FOUND")));

    await spaces.ensureUser("@jdoe:acme.example", "John Doe");

    expect(client.doRequest).toHaveBeenLastCalledWith("PUT", "/_synapse/admin/v2/users/%40jdoe%3Aacme.example", null, {
      displayname: "John Doe",
    });
  });

  it("leaves an existing account as it is", async () => {
    await spaces.ensureUser("@jdoe:acme.example", "John Doe");

    expect(client.doRequest).toHaveBeenCalledTimes(1);
  });

  it("joins a member through the admin API", async () => {
    await spaces.join(ROOM, "@jdoe:acme.example");

    expect(client.doRequest).toHaveBeenCalledWith("POST", "/_synapse/admin/v1/join/!space%3Aacme.example", null, {
      user_id: "@jdoe:acme.example",
    });
  });

  it("does not kick someone who already left", async () => {
    client.getRoomStateEvent.mockResolvedValue({
      membership: "leave",
    });

    await spaces.kick(ROOM, "@jdoe:acme.example");

    expect(client.kickUser).not.toHaveBeenCalled();
  });

  it("kicks a joined member", async () => {
    client.getRoomStateEvent.mockResolvedValue({
      membership: "join",
    });

    await spaces.kick(ROOM, "@jdoe:acme.example");

    expect(client.kickUser).toHaveBeenCalledWith("@jdoe:acme.example", ROOM);
  });

  it("changes only the users it is given", async () => {
    client.getRoomStateEvent.mockResolvedValue({
      users: {
        "@bot:acme.example": 100,
        "@vlee:acme.example": 50,
      },
      events_default: 50,
    });

    await spaces.setPowerLevels(ROOM, {
      "@jdoe:acme.example": 50,
      "@vlee:acme.example": null,
    });

    expect(client.sendStateEvent).toHaveBeenCalledWith(ROOM, "m.room.power_levels", "", {
      users: {
        "@bot:acme.example": 100,
        "@jdoe:acme.example": 50,
      },
      events_default: 50,
    });
  });

  it("sends nothing when the levels already match", async () => {
    client.getRoomStateEvent.mockResolvedValue({
      users: {
        "@jdoe:acme.example": 50,
      },
    });

    await spaces.setPowerLevels(ROOM, {
      "@jdoe:acme.example": 50,
      "@vlee:acme.example": null,
    });

    expect(client.sendStateEvent).not.toHaveBeenCalled();
  });

  it("renames only when the name changed", async () => {
    client.getRoomStateEvent.mockResolvedValue({
      name: "Design Sprint",
    });

    await spaces.rename(ROOM, "Design Sprint");
    expect(client.sendStateEvent).not.toHaveBeenCalled();

    await spaces.rename(ROOM, "Design Review");
    expect(client.sendStateEvent).toHaveBeenCalledWith(ROOM, "m.room.name", "", {
      name: "Design Review",
    });
  });

  it("lists the joined and invited members without the bridge bot", async () => {
    client.getRoomMembers.mockResolvedValue([
      {
        membershipFor: "@bot:acme.example",
      },
      {
        membershipFor: "@jdoe:acme.example",
      },
    ]);

    expect(await spaces.members(ROOM)).toEqual([
      "@jdoe:acme.example",
    ]);
    expect(client.getRoomMembers).toHaveBeenCalledWith(ROOM, undefined, [
      "join",
      "invite",
    ]);
  });

  it("deletes and purges a space, and takes an unknown one as deleted", async () => {
    await spaces.deleteSpace(ROOM);
    expect(client.doRequest).toHaveBeenCalledWith("DELETE", "/_synapse/admin/v2/rooms/!space%3Aacme.example", null, {
      purge: true,
    });

    client.doRequest.mockRejectedValue(matrixError(404, "M_NOT_FOUND"));
    await spaces.deleteSpace(ROOM);
  });
});
