// A Postgres in memory, with the bridge's migrations applied: the tests of the
// queries run their real SQL against it.
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Queries } from "../db.js";

export const MIGRATIONS: string = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function openTestDatabase(before?: string): Promise<{
  client: PGlite;
  db: Queries;
}> {
  const client = new PGlite();
  if (before) {
    await client.exec(before);
  }
  const db = drizzle({
    client,
  });
  await migrate(db, {
    migrationsFolder: MIGRATIONS,
  });
  return {
    client,
    db: db as unknown as Queries,
  };
}
