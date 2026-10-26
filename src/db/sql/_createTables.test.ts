import pino from "pino";
import { describe, expect, it } from "vitest";

import createTables from "./_createTables.js";

/** One database shared by replicas: creating a table twice fails, and the lock has one holder at a time. */
function sharedDatabase() {
  const created = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exists: async (table: string) => created.has(table),
    rawQuery: (query: string) => {
      const table = /^CREATE TABLE (\w+)/.exec(query)?.[1];
      if (table && created.has(table)) {
        return Promise.reject(new Error(`duplicate key value violates unique constraint "pg_type_typname_nsp_index"`));
      }
      if (table) {
        created.add(table);
      }
      return Promise.resolve();
    },
    insert: async () => [],
    withLock: <R>(_key: string, fn: () => Promise<R>): Promise<R> => {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    },
  };
}

function start(db: ReturnType<typeof sharedDatabase>): Promise<void> {
  return new Promise((resolve, reject) => {
    createTables(
      db as unknown as Parameters<typeof createTables>[0],
      {
        usersettings: "matrix_id varchar(255) PRIMARY KEY",
        spaces: "space_id varchar(255) PRIMARY KEY",
      },
      {},
      {},
      pino({
        level: "silent",
      }),
      resolve,
      reject,
    );
  });
}

describe("createTables", () => {
  it("creates each table once when replicas start together", async () => {
    const db = sharedDatabase();

    await Promise.all([
      start(db),
      start(db),
    ]);

    expect(await db.exists("usersettings")).toBe(true);
    expect(await db.exists("spaces")).toBe(true);
  });
});
