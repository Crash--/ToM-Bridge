import { fileURLToPath } from "node:url";

import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";

import { type CommitHookLog, createDb, type Db, migrateDb } from "@linagora/twake-node-server/postgres";

import type { DatabaseConfig } from "./types.js";

/** The queries of the bridge, on whichever Postgres driver runs them. */
export type Queries = PgAsyncDatabase<PgQueryResultHKT>;

export interface Database {
  readonly url: string;
  readonly sql: postgres.Sql;
  readonly db: Db;
}

// The space locks open connections outside the pool (see SPACE_EVENTS_AT_ONCE)
const POOL_MAX = 10;

const MIGRATIONS: string = fileURLToPath(new URL("../drizzle", import.meta.url));

/** The connection URL of the settings, whose host may carry the port, as `host:port`. */
export function databaseUrl(config: DatabaseConfig): string {
  const credentials = `${encodeURIComponent(config.user ?? "")}:${encodeURIComponent(config.password ?? "")}`;
  const url = `postgres://${credentials}@${config.host ?? "localhost"}/${encodeURIComponent(config.name ?? "")}`;
  // verify-full checks the certificate and the host name: postgres.js accepts any certificate with require
  return config.ssl ? `${url}?sslmode=verify-full` : url;
}

/** Connects lazily: the first query opens the pool. */
export function openDatabase(config: DatabaseConfig, log: CommitHookLog): Database {
  const url = databaseUrl(config);
  return {
    url,
    ...createDb(url, {
      log,
      poolMax: POOL_MAX,
    }),
  };
}

/** Brings the tables up to date, one replica at a time. */
export function migrate(database: Database): Promise<void> {
  return migrateDb(database.sql, MIGRATIONS);
}

/**
 * Holds a session advisory lock on `key` while `fn` runs: the pods of one
 * database run one `fn` per key at a time. The lock lives on a connection
 * opened for it and closed after, which releases it even when the connection
 * broke or a statement was cancelled. A pooled connection could not be closed
 * alone, and postgres.js crashes on a reserved one released after it broke.
 */
export async function withLock<R>(database: Database, key: string, fn: () => Promise<R>): Promise<R> {
  const session = postgres(database.url, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await session`SELECT pg_advisory_lock(hashtext('tom-bridge'), hashtext(${key}))`;
    return await fn();
  } finally {
    await session.end({
      timeout: 5,
    });
  }
}

export function closeDatabase(database: Database): Promise<void> {
  return database.sql.end({
    timeout: 5,
  });
}
