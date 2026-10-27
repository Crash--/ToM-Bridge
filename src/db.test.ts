import { describe, expect, it, vi } from "vitest";

import { closeDatabase, databaseUrl, openDatabase, withLock } from "./db.js";

const CONFIG = {
  engine: "pg" as const,
  host: "db.acme.example:5433",
  name: "tom db",
  user: "twake",
  password: "p@ss/word",
};

const log = {
  error: vi.fn(),
};

describe("databaseUrl", () => {
  it("encodes the credentials and the name, and keeps the port of the host", () => {
    expect(databaseUrl(CONFIG)).toBe("postgres://twake:p%40ss%2Fword@db.acme.example:5433/tom%20db");
  });

  it("verifies the certificate and the host name of the server with ssl", async () => {
    const database = openDatabase(
      {
        ...CONFIG,
        ssl: true,
      },
      log,
    );

    expect(database.sql.options.ssl).toBe("verify-full");
    await closeDatabase(database);
  });
});

describe("withLock", () => {
  it("runs nothing when the lock cannot be taken", async () => {
    const database = openDatabase(
      {
        ...CONFIG,
        host: "127.0.0.1:1",
      },
      log,
    );
    const fn = vi.fn();

    await expect(withLock(database, "space-1", fn)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(fn).not.toHaveBeenCalled();
    await closeDatabase(database);
  });
});
