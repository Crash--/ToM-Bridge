import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";

import Database from "./database.js";
import type { DbGetResult } from "./types.js";

type Table = "usersettings";

let db: Database<Table>;

async function openDatabase(): Promise<Database<Table>> {
  const opened = new Database<Table>(
    {
      database_engine: "sqlite",
      database_host: ":memory:",
      database_vacuum_delay: 3600,
    },
    pino({
      level: "silent",
    }),
    {
      usersettings:
        "matrix_id varchar(255) PRIMARY KEY, settings jsonb, version int DEFAULT 1, timestamp bigint DEFAULT 0, request_id varchar(255) DEFAULT ''",
    },
  );
  await opened.ready;
  return opened;
}

function write(version: number, timestamp: number, requestId: string): Promise<DbGetResult> {
  return db.upsertIfNewer(
    "usersettings",
    {
      matrix_id: "@jdoe:example.com",
      settings: JSON.stringify({
        version,
      }),
      version,
      timestamp,
      request_id: requestId,
    },
    "matrix_id",
    [
      "version",
      "timestamp",
    ],
  );
}

async function stored(): Promise<Record<string, unknown> | undefined> {
  const rows = await db.get(
    "usersettings",
    [
      "version",
      "timestamp",
      "request_id",
    ],
    {
      matrix_id: "@jdoe:example.com",
    },
  );
  return rows[0];
}

describe("Database.upsertIfNewer on SQLite", () => {
  beforeEach(async () => {
    db = await openDatabase();
  });

  it("inserts the first row", async () => {
    expect(await write(2, 200, "r2")).toHaveLength(1);
    expect(await stored()).toEqual({
      version: 2,
      timestamp: 200,
      request_id: "r2",
    });
  });

  it("keeps a newer row over an older version, whatever its timestamp", async () => {
    await write(2, 200, "r2");

    expect(await write(1, 300, "r1")).toHaveLength(0);
    expect(await stored()).toMatchObject({
      version: 2,
      request_id: "r2",
    });
  });

  it("writes nothing for the same version and timestamp", async () => {
    await write(2, 200, "r2");

    expect(await write(2, 200, "r2")).toHaveLength(0);
  });

  it("replaces the row with the same version and a later timestamp, or a higher version", async () => {
    await write(2, 200, "r2");

    expect(await write(2, 250, "r3")).toHaveLength(1);
    expect(await write(3, 10, "r4")).toHaveLength(1);
    expect(await stored()).toEqual({
      version: 3,
      timestamp: 10,
      request_id: "r4",
    });
  });
});
