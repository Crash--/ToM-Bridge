import type { Logger as PinoLogger } from "pino";

import type Pg from "./pg";
import type SQLite from "./sqlite";

function createTables<T extends string>(
  db: SQLite<T> | Pg<T>,
  tables: Record<T, string>,
  indexes: Partial<Record<T, string[]>>,
  initializeValues: Partial<Record<T, Array<Record<string, string | number>>>>,
  logger: PinoLogger,
  resolve: () => void,
  reject: (e: Error) => void,
): void {
  const promises: Array<Promise<void>> = [];
  (Object.keys(tables) as T[]).forEach((table: T) => {
    promises.push(
      new Promise<void>((_resolve, _reject) => {
        db.exists(table)
          .then((count) => {
            if (!count) {
              db.rawQuery(`CREATE TABLE ${table}(${tables[table]})`)
                .then(() =>
                  Promise.all(
                    (indexes[table] ? (indexes[table] as string[]) : []).map<Promise<unknown>>((index) =>
                      db.rawQuery(`CREATE INDEX i_${table}_${index} ON ${table} (${index})`).catch((e) => {
                        /* istanbul ignore next */
                        logger.error(e, `Index ${index}`);
                      }),
                    ),
                  ),
                )
                .then(() =>
                  Promise.all(
                    (initializeValues[table]
                      ? (initializeValues[table] as Array<Record<string, string | number>>)
                      : []
                    ).map<Promise<unknown>>((entry) => db.insert(table, entry)),
                  ),
                )
                .then(() => {
                  _resolve();
                })
                // istanbul ignore next
                .catch((e) => {
                  _reject(e);
                });
            } else {
              _resolve();
            }
          })
          /* istanbul ignore next */
          .catch(_reject);
      }),
    );
  });
  Promise.all(promises)
    .then(() => {
      resolve();
    })
    // istanbul ignore next
    .catch((e) => {
      logger.error(e, "Unable to create tables");
      reject(e);
    });
}

export default createTables;
