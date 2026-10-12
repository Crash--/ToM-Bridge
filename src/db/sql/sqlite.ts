import type { Logger as PinoLogger } from "pino";
import type { Database, Statement } from "sqlite3";

import type { ColumnDefinition, ColumnInfo, DatabaseConfig, DbBackend, DbGetResult, ISQLCondition } from "../types";
import createTables from "./_createTables";
import SQL from "./sql";

export type SQLiteDatabase = Database;

export type SQLiteStatement = Statement;

class SQLite<T extends string> extends SQL<T> implements DbBackend<T> {
  declare db?: SQLiteDatabase;
  createDatabases(
    conf: DatabaseConfig,
    tables: Record<T, string>,
    indexes: Partial<Record<T, string[]>>,
    initializeValues: Partial<Record<T, Array<Record<string, string | number>>>>,
    logger: PinoLogger,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        createTables(this, tables, indexes, initializeValues, logger, resolve, reject);
      } else {
        import("sqlite3")
          .then((sqlite3) => {
            // @ts-expect-error
            if (!sqlite3.Database) sqlite3 = sqlite3.default;
            this.db = new sqlite3.Database(conf.database_host);
            const db = this.db;
            /* istanbul ignore if */
            if (!db) {
              throw new Error("Database not created");
            }
            logger.info("[Db:SQLite] connected.");
            createTables(this, tables, indexes, initializeValues, logger, resolve, reject);
          })
          .catch((e) => {
            /* istanbul ignore next */
            throw e;
          });
      }
    });
  }

  rawQuery(query: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        this.logger.error("[SQLite][rawQuery] DB not ready");
        reject(new Error("DB not ready"));
        return;
      }
      this.logger.debug(
        {
          query,
        },
        "[SQLite][rawQuery] Executing query",
      );
      this.db.run(query, (err) => {
        if (err === null || err === undefined) {
          this.logger.debug(
            {
              query,
            },
            "[SQLite][rawQuery] Query successful",
          );
          resolve();
        } else {
          this.logger.error(
            {
              query,
              error: err,
            },
            "[SQLite][rawQuery] Query failed",
          );
          reject(err);
        }
      });
    });
  }

  exists(table: T): Promise<number> {
    // @ts-expect-error sqlite_master not listed in Collections
    return this.getCount("sqlite_master", "name", table);
  }

  insert(table: T, values: Record<string, string | number>): Promise<DbGetResult> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
          },
          "[SQLite][insert] DB not ready",
        );
        throw new Error("Wait for database to be ready");
      }
      const names: string[] = [];
      const vals: Array<string | number> = [];
      Object.keys(values).forEach((k) => {
        names.push(k);
        vals.push(values[k]!);
      });
      const query = `INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map((_v) => "?").join(",")}) RETURNING *;`;
      this.logger.debug(
        {
          table,
          fields: names,
          query,
        },
        "[SQLite][insert] Executing",
      );
      const stmt = this.db.prepare(query);
      stmt.all(vals, (err: string, rows: Array<Record<string, string | number>>) => {
        /* istanbul ignore if */
        if (err !== null && err !== undefined) {
          this.logger.error(
            {
              table,
              fields: names,
              values: vals,
              query,
              error: err,
            },
            "[SQLite][insert] Failed",
          );
          reject(err);
        } else {
          this.logger.debug(
            {
              table,
              rowCount: rows.length,
            },
            "[SQLite][insert] Successful",
          );
          resolve(rows);
        }
      });
      stmt.finalize((err) => {
        if (err) {
          this.logger.error(
            {
              table,
              error: err,
            },
            "[SQLite][insert] Statement finalize failed",
          );
          reject(err);
        }
      });
    });
  }

  update(
    table: T,
    values: Record<string, string | number>,
    field: string,
    value: string | number,
  ): Promise<DbGetResult> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
            field,
          },
          "[SQLite][update] DB not ready",
        );
        throw new Error("Wait for database to be ready");
      }
      const names: string[] = [];
      const vals: Array<string | number> = [];
      Object.keys(values).forEach((k) => {
        names.push(k);
        vals.push(values[k]!);
      });
      vals.push(value);
      const query = `UPDATE ${table} SET ${names.join("=?,")}=? WHERE ${field}=? RETURNING *;`;
      this.logger.debug(
        {
          table,
          fields: names,
          whereField: field,
          query,
        },
        "[SQLite][update] Executing",
      );
      const stmt = this.db.prepare(query);
      stmt.all(vals, (err: string, rows: Array<Record<string, string | number>>) => {
        /* istanbul ignore if */
        if (err !== null && err !== undefined) {
          this.logger.error(
            {
              table,
              fields: names,
              whereField: field,
              query,
              error: err,
            },
            "[SQLite][update] Failed",
          );
          reject(err);
        } else {
          this.logger.debug(
            {
              table,
              rowCount: rows.length,
            },
            "[SQLite][update] Successful",
          );
          resolve(rows);
        }
      });
      stmt.finalize((err) => {
        if (err) {
          this.logger.error(
            {
              table,
              error: err,
            },
            "[SQLite][update] Statement finalize failed",
          );
          reject(err);
        }
      });
    });
  }

  // TODO : Merge update and updateAnd into one function that takes an array of conditions as argument
  updateAnd(
    table: T,
    values: Record<string, string | number>,
    condition1: {
      field: string;
      value: string | number;
    },
    condition2: {
      field: string;
      value: string | number;
    },
  ): Promise<DbGetResult> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
            conditions: [
              condition1.field,
              condition2.field,
            ],
          },
          "[SQLite][updateAnd] DB not ready",
        );
        throw new Error("Wait for database to be ready");
      }
      const names = Object.keys(values);
      const vals = Object.values(values);
      vals.push(condition1.value, condition2.value);

      const setClause = names.map((name) => `${name} = ?`).join(", ");
      const query = `UPDATE ${table} SET ${setClause} WHERE ${condition1.field} = ? AND ${condition2.field} = ? RETURNING *;`;
      this.logger.debug(
        {
          table,
          fields: names,
          whereFields: [
            condition1.field,
            condition2.field,
          ],
          query,
        },
        "[SQLite][updateAnd] Executing",
      );
      const stmt = this.db.prepare(query);

      stmt.all(vals, (err: string, rows: Array<Record<string, string | number>>) => {
        if (err !== null && err !== undefined) {
          this.logger.error(
            {
              table,
              fields: names,
              whereFields: [
                condition1.field,
                condition2.field,
              ],
              query,
              error: err,
            },
            "[SQLite][updateAnd] Failed",
          );
          reject(err);
        } else {
          this.logger.debug(
            {
              table,
              rowCount: rows.length,
            },
            "[SQLite][updateAnd] Successful",
          );
          resolve(rows);
        }
      });

      stmt.finalize((err) => {
        if (err) {
          this.logger.error(
            {
              table,
              error: err,
            },
            "UPDATE with AND conditions statement finalize failed",
          );
          reject(err);
        }
      });
    });
  }

  _get(
    tables: T[],
    fields?: string[],
    op1?: string,
    filterFields1?: Record<string, string | number | Array<string | number>>,
    op2?: string,
    linkop1?: string,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    op3?: string,
    linkop2?: string,
    filterFields3?: Record<string, string | number | Array<string | number>>,
    joinFields?: Record<string, string>,
    order?: string,
  ): Promise<DbGetResult> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        reject(new Error("Wait for database to be ready"));
      } else {
        let condition: string = "";
        const values: string[] = [];
        if (!fields || fields.length === 0) {
          fields = [
            "*",
          ];
        } else {
          // Generate aliases for fields containing periods
          fields = fields.map((field) => {
            if (field.includes(".")) {
              const alias = field.replace(/\./g, "_");
              return `${field} AS ${alias}`;
            }
            return field;
          });
        }

        let index: number = 0;

        const buildCondition = (
          op: string,
          filterFields: Record<string, string | number | Array<string | number>>,
        ): string => {
          let localCondition = "";

          Object.keys(filterFields)
            .filter(
              (key) =>
                filterFields[key] !== null &&
                filterFields[key] !== undefined &&
                filterFields[key].toString() !== [].toString(),
            )
            .forEach((key) => {
              localCondition += localCondition !== "" ? " AND " : "";
              if (Array.isArray(filterFields[key])) {
                localCondition += `(${(filterFields[key] as Array<string | number>)
                  .map((val) => {
                    index++;
                    values.push(val.toString());
                    return `${key}${op}$${index}`;
                  })
                  .join(" OR ")})`;
              } else {
                index++;
                values.push(filterFields[key]!.toString());
                localCondition += `${key}${op}$${index}`;
              }
            });
          return localCondition;
        };

        const condition1 =
          op1 && filterFields1 && Object.keys(filterFields1).length > 0 ? buildCondition(op1, filterFields1) : "";
        const condition2 =
          op2 && linkop1 && filterFields2 && Object.keys(filterFields2).length > 0
            ? buildCondition(op2, filterFields2)
            : "";
        const condition3 =
          op3 && linkop2 && filterFields3 && Object.keys(filterFields3).length > 0
            ? buildCondition(op3, filterFields3)
            : "";

        condition += condition1 !== "" ? `WHERE ${condition1}` : "";
        condition += condition2 !== "" ? (condition !== "" ? ` ${linkop1} ` : "WHERE ") + condition2 : "";
        condition += condition3 !== "" ? (condition !== "" ? ` ${linkop2} ` : "WHERE ") + condition3 : "";

        if (joinFields) {
          let joinCondition = "";
          Object.keys(joinFields)
            .filter((key) => joinFields[key] && joinFields[key].toString() !== [].toString())
            .forEach((key) => {
              joinCondition += joinCondition !== "" ? " AND " : "";
              joinCondition += `${key}=${joinFields[key]}`;
            });
          condition += condition !== "" ? " AND " : "WHERE ";
          condition += joinCondition;
        }

        if (order) condition += ` ORDER BY ${order}`;

        const query = `SELECT ${fields.join(",")} FROM ${tables.join(",")} ${condition}`;
        this.logger.debug(
          {
            tables,
            fields,
            condition,
            query,
          },
          "[SQLite][_get] Executing SELECT",
        );
        const stmt = this.db.prepare(query);
        stmt.all(values, (err: string, rows: Array<Record<string, string | number>>) => {
          /* istanbul ignore if */
          if (err !== null && err !== undefined) {
            this.logger.error(
              {
                tables,
                fields,
                condition,
                query,
                error: err,
              },
              "[SQLite][_get] SELECT failed",
            );
            reject(err);
          } else {
            this.logger.debug(
              {
                tables,
                rowCount: rows.length,
              },
              "[SQLite][_get] SELECT successful",
            );
            resolve(rows);
          }
        });
        stmt.finalize((err) => {
          if (err) {
            this.logger.error(
              {
                tables,
                error: err,
              },
              "[SQLite][_get] Statement finalize failed",
            );
            reject(err);
          }
        });
      }
    });
  }

  get(
    table: T,
    fields?: string[],
    filterFields?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._get(
      [
        table,
      ],
      fields,
      "=",
      filterFields,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      order,
    );
  }

  getJoin(
    tables: T[],
    fields?: string[],
    filterFields?: Record<string, string | number | Array<string | number>>,
    joinFields?: Record<string, string>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._get(
      tables,
      fields,
      "=",
      filterFields,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      joinFields,
      order,
    );
  }

  getHigherThan(
    table: T,
    fields?: string[],
    filterFields?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._get(
      [
        table,
      ],
      fields,
      ">",
      filterFields,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      order,
    );
  }

  getWhereEqualOrDifferent(
    table: T,
    fields?: string[],
    filterFields1?: Record<string, string | number | Array<string | number>>,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._get(
      [
        table,
      ],
      fields,
      "=",
      filterFields1,
      "<>",
      " OR ",
      filterFields2,
      undefined,
      undefined,
      undefined,
      undefined,
      order,
    );
  }

  getWhereEqualAndHigher(
    table: T,
    fields?: string[],
    filterFields1?: Record<string, string | number | Array<string | number>>,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._get(
      [
        table,
      ],
      fields,
      "=",
      filterFields1,
      ">",
      " AND ",
      filterFields2,
      undefined,
      undefined,
      undefined,
      undefined,
      order,
    );
  }

  _getMinMax(
    minmax: "MIN" | "MAX",
    tables: T[],
    targetField: string,
    fields?: string[],
    op1?: string,
    filterFields1?: Record<string, string | number | Array<string | number>>,
    op2?: string,
    linkop?: string,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    joinFields?: Record<string, string>,
    order?: string,
  ): Promise<DbGetResult> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        reject(new Error("Wait for database to be ready"));
      } else {
        let condition: string = "";
        const values: string[] = [];
        if (!fields || fields.length === 0) {
          fields = [
            "*",
          ];
        } else {
          // Generate aliases for fields containing periods
          fields = fields.map((field) => {
            if (field.includes(".")) {
              const alias = field.replace(/\./g, "_");
              return `${field} AS ${alias}`;
            }
            return field;
          });
        }
        const targetFieldAlias: string = targetField.replace(/\./g, "_");

        let index: number = 0;

        const buildCondition = (
          op: string,
          filterFields: Record<string, string | number | Array<string | number>>,
        ): string => {
          let localCondition = "";

          Object.keys(filterFields)
            .filter(
              (key) =>
                filterFields[key] !== null &&
                filterFields[key] !== undefined &&
                filterFields[key].toString() !== [].toString(),
            )
            .forEach((key) => {
              localCondition += localCondition !== "" ? " AND " : "";
              if (Array.isArray(filterFields[key])) {
                localCondition += `(${(filterFields[key] as Array<string | number>)
                  .map((val) => {
                    index++;
                    values.push(val.toString());
                    return `${key}${op}$${index}`;
                  })
                  .join(" OR ")})`;
              } else {
                index++;
                values.push(filterFields[key]!.toString());
                localCondition += `${key}${op}$${index}`;
              }
            });
          return localCondition;
        };

        const condition1 =
          op1 && filterFields1 && Object.keys(filterFields1).length > 0 ? buildCondition(op1, filterFields1) : "";
        const condition2 =
          op2 && linkop && filterFields2 && Object.keys(filterFields2).length > 0
            ? buildCondition(op2, filterFields2)
            : "";

        condition += condition1 !== "" ? `WHERE ${condition1}` : "";
        condition += condition2 !== "" ? (condition !== "" ? ` ${linkop} ` : "WHERE ") + condition2 : "";

        if (joinFields) {
          let joinCondition = "";
          Object.keys(joinFields)
            .filter((key) => joinFields[key] && joinFields[key].toString() !== [].toString())
            .forEach((key) => {
              joinCondition += joinCondition !== "" ? " AND " : "";
              joinCondition += `${key}=${joinFields[key]}`;
            });
          condition += condition !== "" ? " AND " : "WHERE ";
          condition += joinCondition;
        }

        if (order) condition += ` ORDER BY ${order}`;

        const query = `SELECT ${fields.join(
          ",",
        )}, ${minmax}(${targetField}) AS max_${targetFieldAlias} FROM ${tables.join(
          ",",
        )} ${condition} HAVING COUNT(*) > 0`; // HAVING COUNT(*) > 0 is to avoid returning a row with NULL values
        this.logger.debug(
          {
            tables,
            targetField,
            fields,
            condition,
            query,
          },
          `Executing ${minmax} query`,
        );
        const stmt = this.db.prepare(query);
        stmt.all(values, (err: string, rows: Array<Record<string, string | number>>) => {
          /* istanbul ignore if */
          if (err !== null && err !== undefined) {
            this.logger.error(
              {
                tables,
                targetField,
                fields,
                condition,
                query,
                error: err,
              },
              `${minmax} query failed`,
            );
            reject(err);
          } else {
            this.logger.debug(
              {
                tables,
                rowCount: rows.length,
              },
              `${minmax} query successful`,
            );
            resolve(rows);
          }
        });
        stmt.finalize((err) => {
          if (err) {
            this.logger.error(
              {
                tables,
                error: err,
              },
              `${minmax} statement finalize failed`,
            );
            reject(err);
          }
        });
      }
    });
  }

  getMaxWhereEqual(
    table: T,
    targetField: string,
    fields?: string[],
    filterFields?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._getMinMax(
      "MAX",
      [
        table,
      ],
      targetField,
      fields,
      "=",
      filterFields,
      undefined,
      undefined,
      undefined,
      undefined,
      order,
    );
  }

  getMaxWhereEqualAndLower(
    table: T,
    targetField: string,
    fields?: string[],
    filterFields1?: Record<string, string | number | Array<string | number>>,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._getMinMax(
      "MAX",
      [
        table,
      ],
      targetField,
      fields,
      "=",
      filterFields1,
      "<",
      " AND ",
      filterFields2,
      undefined,
      order,
    );
  }

  getMinWhereEqualAndHigher(
    table: T,
    targetField: string,
    fields?: string[],
    filterFields1?: Record<string, string | number | Array<string | number>>,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._getMinMax(
      "MIN",
      [
        table,
      ],
      targetField,
      fields,
      "=",
      filterFields1,
      ">",
      " AND ",
      filterFields2,
      undefined,
      order,
    );
  }

  getMaxWhereEqualAndLowerJoin(
    tables: T[],
    targetField: string,
    fields: string[],
    filterFields1?: Record<string, string | number | Array<string | number>>,
    filterFields2?: Record<string, string | number | Array<string | number>>,
    joinFields?: Record<string, string>,
    order?: string,
  ): Promise<DbGetResult> {
    return this._getMinMax(
      "MAX",
      tables,
      targetField,
      fields,
      "=",
      filterFields1,
      "<",
      " AND ",
      filterFields2,
      joinFields,
      order,
    );
  }

  match(
    table: T,
    fields: string[],
    searchFields: string[],
    value: string | number,
    order?: string,
  ): Promise<DbGetResult> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
          },
          "[SQLite][match] DB not ready",
        );
        reject(new Error("Wait for database to be ready"));
      } else {
        if (typeof searchFields !== "object")
          searchFields = [
            searchFields,
          ];
        if (typeof fields !== "object")
          fields = [
            fields,
          ];
        if (fields.length === 0)
          fields = [
            "*",
          ];
        const values = searchFields.map(() => `%${value}%`);
        let condition = searchFields.map((f) => `${f} LIKE ?`).join(" OR ");
        if (order) condition += ` ORDER BY ${order}`;
        const query = `SELECT ${fields.join(",")} FROM ${table} WHERE ${condition}`;
        this.logger.debug(
          {
            table,
            searchFields,
            value,
            fields,
            query,
          },
          "[SQLite][match] Executing LIKE query",
        );
        const stmt = this.db.prepare(query);
        stmt.all(values, (err: string, rows: Array<Record<string, string | number>>) => {
          /* istanbul ignore if */
          if (err !== null && err !== undefined) {
            this.logger.error(
              {
                table,
                searchFields,
                value,
                query,
                error: err,
              },
              "[SQLite][match] Query failed",
            );
            reject(err);
          } else {
            this.logger.debug(
              {
                table,
                rowCount: rows.length,
              },
              "[SQLite][match] Query successful",
            );
            resolve(rows);
          }
        });
        stmt.finalize((err) => {
          if (err) {
            this.logger.error(
              {
                table,
                error: err,
              },
              "[SQLite][match] Statement finalize failed",
            );
            reject(err);
          }
        });
      }
    });
  }

  deleteEqual(table: T, field: string, value: string | number): Promise<void> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
            field,
          },
          "[SQLite][deleteEqual] DB not ready",
        );
        reject(new Error("Wait for database to be ready"));
      } else {
        const query = `DELETE FROM ${table} WHERE ${field}=?`;
        this.logger.debug(
          {
            table,
            field,
            query,
          },
          "[SQLite][deleteEqual] Executing",
        );
        const stmt = this.db.prepare(query);
        stmt.all(
          [
            value,
          ],
          (err, _rows) => {
            /* istanbul ignore if */
            if (err !== null && err !== undefined) {
              this.logger.error(
                {
                  table,
                  field,
                  query,
                  error: err,
                },
                "DELETE failed",
              );
              reject(err);
            } else {
              this.logger.debug(
                {
                  table,
                  field,
                },
                "[SQLite][deleteEqual] Successful",
              );
              resolve();
            }
          },
        );
        stmt.finalize((err) => {
          if (err) {
            this.logger.error(
              {
                table,
                error: err,
              },
              "[SQLite][deleteEqual] Statement finalize failed",
            );
            reject(err);
          }
        });
      }
    });
  }

  deleteEqualAnd(
    table: T,
    condition1: {
      field: string;
      value: string | number | Array<string | number>;
    },
    condition2: {
      field: string;
      value: string | number | Array<string | number>;
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
          },
          "[SQLite][deleteEqualAnd] DB not ready",
        );
        reject(new Error("Wait for database to be ready"));
      } else {
        const query = `DELETE FROM ${table} WHERE ${condition1.field}=? AND ${condition2.field}=?`;
        this.logger.debug(
          {
            table,
            conditions: [
              condition1.field,
              condition2.field,
            ],
            query,
          },
          "[SQLite][deleteEqualAnd] Executing",
        );
        const stmt = this.db.prepare(query);
        stmt.all(
          [
            condition1.value,
            condition2.value,
          ],
          (err, _rows) => {
            /* istanbul ignore if */
            if (err !== null && err !== undefined) {
              this.logger.error(
                {
                  table,
                  conditions: [
                    condition1.field,
                    condition2.field,
                  ],
                  query,
                  error: err,
                },
                "[SQLite][deleteEqualAnd] Failed",
              );
              reject(err);
            } else {
              this.logger.debug(
                {
                  table,
                },
                "[SQLite][deleteEqualAnd] Successful",
              );
              resolve();
            }
          },
        );
        stmt.finalize((err) => {
          if (err) {
            this.logger.error(
              {
                table,
                error: err,
              },
              "DELETE with AND conditions statement finalize failed",
            );
            reject(err);
          }
        });
      }
    });
  }

  deleteLowerThan(table: T, field: string, value: string | number): Promise<void> {
    return new Promise((resolve, reject) => {
      /* istanbul ignore if */
      if (!this.db) {
        this.logger.error(
          {
            table,
            field,
          },
          "[SQLite][deleteLowerThan] DB not ready",
        );
        throw new Error("Wait for database to be ready");
      }
      const query = `DELETE FROM ${table} WHERE ${field}<?`;
      this.logger.debug(
        {
          table,
          field,
          query,
        },
        "[SQLite][deleteLowerThan] Executing",
      );
      const stmt = this.db.prepare(query);
      stmt.all(
        [
          value,
        ],
        (err) => {
          /* istanbul ignore if */
          if (err !== null && err !== undefined) {
            this.logger.error(
              {
                table,
                field,
                query,
                error: err,
              },
              "[SQLite][deleteLowerThan] Failed",
            );
            reject(err);
          } else {
            this.logger.debug(
              {
                table,
                field,
              },
              "[SQLite][deleteLowerThan] Successful",
            );
            resolve();
          }
        },
      );
      stmt.finalize((err) => {
        if (err) {
          this.logger.error(
            {
              table,
              error: err,
            },
            "DELETE with < condition statement finalize failed",
          );
          reject(err);
        }
      });
    });
  }

  /**
   * Delete from a table when a condition is met.
   *
   * @param {string} table - the table to delete from
   * @param {ISQLCondition | ISQLCondition[]} conditions - the list of filters, operators and values for sql conditions
   */
  deleteWhere(table: T, conditions: ISQLCondition | ISQLCondition[]): Promise<void> {
    // Adaptation of the method get, with the delete keyword, 'AND' instead of 'OR', and with filters instead of fields
    return new Promise((resolve, reject) => {
      // istanbul ignore if
      if (!this.db) {
        this.logger.error(
          {
            table,
          },
          "[SQLite][deleteWhere] DB not ready",
        );
        reject(new Error("Wait for database to be ready"));
      } else {
        if (!Array.isArray(conditions))
          conditions = [
            conditions,
          ];

        const values = conditions.map((c) => c.value);
        const filters = conditions.map((c) => c.field);
        const operators = conditions.map((c) => c.operator);

        let condition: string = "";
        if (values && values.length > 0 && filters.length === values.length) {
          // Verifies that values have at least one element, and as much filter names
          condition = filters.map((filt, i) => `${filt}${operators[i] ?? "="}?`).join(" AND ");
        }

        const query = `DELETE FROM ${table} WHERE ${condition}`;
        this.logger.debug(
          {
            table,
            conditions: filters,
            operators,
            query,
          },
          "[SQLite][deleteWhere] Executing",
        );
        const stmt = this.db.prepare(query);

        stmt.all(
          values, // The statement fills the values properly.
          (err: string) => {
            /* istanbul ignore if */
            if (err !== null && err !== undefined) {
              this.logger.error(
                {
                  table,
                  conditions: filters,
                  operators,
                  values,
                  query,
                  error: err,
                },
                "[SQLite][deleteWhere] Failed",
              );
              reject(err);
            } else {
              this.logger.debug(
                {
                  table,
                },
                "[SQLite][deleteWhere] Successful",
              );
              resolve();
            }
          },
        );
        stmt.finalize((err) => {
          if (err) {
            this.logger.error(
              {
                table,
                error: err,
              },
              "DELETE with WHERE conditions statement finalize failed",
            );
            reject(err);
          }
        });
      }
    });
  }

  async getTableColumns(table: T): Promise<ColumnInfo[]> {
    if (!this.db) {
      this.logger.error(
        {
          table,
        },
        "[SQLite][getTableColumns] DB not ready",
      );
      throw new Error("DB not ready");
    }

    const query = `PRAGMA table_info(${table})`;
    this.logger.debug(
      {
        table,
        query,
      },
      "[SQLite][getTableColumns] Executing",
    );

    /* Capture db reference to avoid undefined in callback */
    const db = this.db;

    return new Promise((resolve, reject) => {
      db.all(
        query,
        (
          err: Error | null,
          rows: Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
          }>,
        ) => {
          if (err) {
            this.logger.error(
              {
                table,
                query,
                error: err,
              },
              "[SQLite][getTableColumns] Failed",
            );
            reject(err);
            return;
          }

          const columns: ColumnInfo[] = rows.map((row) => ({
            name: row.name,
            type: row.type,
            defaultValue: row.dflt_value,
          }));

          this.logger.debug(
            {
              table,
              columnCount: columns.length,
            },
            "[SQLite][getTableColumns] Successful",
          );

          resolve(columns);
        },
      );
    });
  }

  /**
   * Validates an SQL identifier (table name, column name) to prevent injection.
   * Only allows alphanumeric characters and underscores, must start with letter or underscore.
   */
  #isValidIdentifier(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Quotes an SQL identifier using double quotes, escaping any internal double quotes.
   */
  #quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Validates column type against allowed SQL types.
   */
  #isValidColumnType(type: string): boolean {
    const typePattern =
      /^(varchar|char|text|int|integer|smallint|bigint|real|numeric|decimal|boolean|bool|date|time|timestamp|blob|json|jsonb)(\(\d+\))?$/i;
    return typePattern.test(type.trim());
  }

  async addColumn(table: T, column: ColumnDefinition): Promise<void> {
    if (!this.db) {
      this.logger.error(
        {
          table,
          column,
        },
        "[SQLite][addColumn] DB not ready",
      );
      throw new Error("DB not ready");
    }

    /* Validate identifiers to prevent SQL injection */
    if (!this.#isValidIdentifier(table)) {
      this.logger.error(
        {
          table,
          column,
        },
        "[SQLite][addColumn] Invalid table name",
      );
      throw new Error(`Invalid table name: ${table}`);
    }

    if (!this.#isValidIdentifier(column.name)) {
      this.logger.error(
        {
          table,
          column,
        },
        "[SQLite][addColumn] Invalid column name",
      );
      throw new Error(`Invalid column name: ${column.name}`);
    }

    if (!this.#isValidColumnType(column.type)) {
      this.logger.error(
        {
          table,
          column,
        },
        "[SQLite][addColumn] Invalid column type",
      );
      throw new Error(`Invalid column type: ${column.type}`);
    }

    /* Build query with quoted identifiers */
    const quotedTable = this.#quoteIdentifier(table);
    const quotedColumn = this.#quoteIdentifier(column.name);
    let query = `ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${column.type}`;

    /* Handle default value - use parameterized query for safety */
    const params: Array<string | number | null> = [];
    if (column.default !== undefined) {
      /*
       * SQLite doesn't support parameterized DEFAULT in ALTER TABLE,
       * so we must use literal values with proper escaping
       */
      if (column.default === null) {
        query += " DEFAULT NULL";
      } else if (typeof column.default === "number") {
        query += ` DEFAULT ${column.default}`;
      } else if (typeof column.default === "boolean") {
        query += ` DEFAULT ${column.default ? 1 : 0}`;
      } else {
        /* For strings, use parameterized query via prepared statement */
        params.push(column.default);
        query += " DEFAULT ?";
      }
    }

    /* Handle NOT NULL constraint if specified */
    if (column.notNull) {
      query += " NOT NULL";
    }

    this.logger.debug(
      {
        table,
        column,
        query,
        params,
      },
      "[SQLite][addColumn] Executing",
    );

    /* Capture db reference to avoid undefined in callback */
    const db = this.db;

    return new Promise((resolve, reject) => {
      /*
       * Note: SQLite ALTER TABLE doesn't support parameterized DEFAULT values.
       * If we have params, we need to use a workaround or fall back to escaping.
       * For now, we'll escape the string properly.
       */
      let finalQuery = query;
      if (params.length > 0 && typeof params[0] === "string") {
        /* Replace ? with properly escaped string literal */
        const escapedValue = params[0].replace(/'/g, "''");
        finalQuery = query.replace("?", `'${escapedValue}'`);
      }

      db.run(finalQuery, (err) => {
        if (err) {
          /* Check for duplicate column error - make idempotent */
          const errMessage = err.message?.toLowerCase() ?? "";
          if (errMessage.includes("duplicate column name")) {
            this.logger.debug(
              {
                table,
                column: column.name,
              },
              "[SQLite][addColumn] Column already exists (idempotent)",
            );
            resolve();
            return;
          }

          this.logger.error(
            {
              table,
              column,
              query: finalQuery,
              error: err,
            },
            "[SQLite][addColumn] Failed",
          );
          reject(err);
          return;
        }

        this.logger.info(
          {
            table,
            column: column.name,
          },
          "[SQLite][addColumn] Column added successfully",
        );
        resolve();
      });
    });
  }

  async ensureColumns(table: T, columns: ColumnDefinition[]): Promise<void> {
    const existingColumns = await this.getTableColumns(table);
    const existingNames = new Set(existingColumns.map((c) => c.name.toLowerCase()));

    const missingColumns = columns.filter((col) => !existingNames.has(col.name.toLowerCase()));

    if (missingColumns.length === 0) {
      this.logger.debug(
        {
          table,
        },
        "[SQLite][ensureColumns] All columns exist",
      );
      return;
    }

    this.logger.info(
      {
        table,
        columns: missingColumns.map((c) => c.name),
      },
      "[SQLite][ensureColumns] Adding missing columns",
    );

    for (const col of missingColumns) {
      await this.addColumn(table, col);
    }

    this.logger.info(
      {
        table,
      },
      "[SQLite][ensureColumns] All columns ensured",
    );
  }

  // A SQLite file serves one process, which orders its own work
  withLock<R>(_key: string, fn: () => Promise<R>): Promise<R> {
    return fn();
  }

  close(): void {
    this.db?.close();
  }
}

export default SQLite;
