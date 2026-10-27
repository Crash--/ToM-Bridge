import type { PGlite } from "@electric-sql/pglite";
import type { Logger } from "matrix-appservice-bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openTestDatabase } from "./__mocks__/pglite.js";
import { SettingsRepository } from "./settings-repository.js";
import type { ISettingsPayload } from "./types.js";

const USER = "@user:example.com";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function payload(display_name: string): ISettingsPayload {
  return {
    matrix_id: USER,
    display_name,
    language: "en",
  };
}

let client: PGlite;
let repository: SettingsRepository;

beforeEach(async () => {
  const database = await openTestDatabase();
  client = database.client;
  repository = new SettingsRepository(database.db, logger);
});

describe("SettingsRepository.getUserSettings", () => {
  it("reads the stored settings, with the avatar last uploaded", async () => {
    await repository.saveIfNewer(USER, payload("Jane"), 2, 200, "req-2");
    await repository.saveAvatar(USER, "https://workspace.example.com/jane.png", "mxc://example.com/jane");

    expect(await repository.getUserSettings(USER)).toEqual({
      nickname: USER,
      payload: payload("Jane"),
      version: 2,
      timestamp: 200,
      request_id: "req-2",
      avatar: {
        source: "https://workspace.example.com/jane.png",
        mxc: "mxc://example.com/jane",
      },
    });
  });

  it("knows no settings for a user never saved", async () => {
    expect(await repository.getUserSettings(USER)).toBeNull();
  });

  it("takes settings it cannot read as none", async () => {
    await client.query(`INSERT INTO usersettings (matrix_id, settings) VALUES ($1, '{"display_name": 42}')`, [
      USER,
    ]);

    expect(await repository.getUserSettings(USER)).toBeNull();
  });

  it("fails when the database does", async () => {
    await client.close();

    await expect(repository.getUserSettings(USER)).rejects.toThrow();
  });
});

describe("SettingsRepository.saveIfNewer", () => {
  it("saves settings newer than the stored ones, and only those", async () => {
    expect(await repository.saveIfNewer(USER, payload("v2"), 2, 200, "req-2")).toBe(true);
    expect(await repository.saveIfNewer(USER, payload("v1"), 1, 300, "req-1")).toBe(false);
    expect(await repository.saveIfNewer(USER, payload("v2"), 2, 200, "req-2")).toBe(false);
    expect(await repository.saveIfNewer(USER, payload("v2 later"), 2, 250, "req-3")).toBe(true);
    expect(await repository.saveIfNewer(USER, payload("v3"), 3, 10, "req-4")).toBe(true);

    expect((await repository.getUserSettings(USER))?.payload.display_name).toBe("v3");
  });

  it("keeps the avatar of the last upload over newer settings", async () => {
    await repository.saveIfNewer(USER, payload("v1"), 1, 100, "req-1");
    await repository.saveAvatar(USER, "https://workspace.example.com/jane.png", "mxc://example.com/jane");
    await repository.saveIfNewer(USER, payload("v2"), 2, 200, "req-2");

    expect((await repository.getUserSettings(USER))?.avatar?.mxc).toBe("mxc://example.com/jane");
  });

  it("fails when the database does", async () => {
    await client.close();

    await expect(repository.saveIfNewer(USER, payload("v1"), 1, 100, "req-1")).rejects.toThrow();
  });
});
