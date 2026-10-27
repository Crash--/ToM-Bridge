import { bigint, integer, jsonb, pgTable, text, varchar } from "drizzle-orm/pg-core";

import type { ISettingsPayload } from "./types.js";

/** The last settings of each user, and the avatar last uploaded for them. */
export const usersettings = pgTable("usersettings", {
  matrix_id: varchar("matrix_id", {
    length: 255,
  }).primaryKey(),
  settings: jsonb("settings").$type<ISettingsPayload>(),
  version: integer("version").default(1),
  timestamp: bigint("timestamp", {
    mode: "number",
  }).default(0),
  request_id: varchar("request_id", {
    length: 255,
  }).default(""),
  avatar_source: text("avatar_source"),
  avatar_mxc: text("avatar_mxc"),
});

/** When each change of a space was last applied, to ignore older events. */
export const spaceclock = pgTable("spaceclock", {
  clock_key: varchar("clock_key", {
    length: 255,
  }).primaryKey(),
  timestamp: bigint("timestamp", {
    mode: "number",
  }),
});

/** The Matrix space of each space, and when it is due for deletion. */
export const spaces = pgTable("spaces", {
  space_id: varchar("space_id", {
    length: 255,
  }).primaryKey(),
  organization_id: varchar("organization_id", {
    length: 255,
  }),
  room_id: varchar("room_id", {
    length: 255,
  }),
  timestamp: bigint("timestamp", {
    mode: "number",
  }),
  delete_at: bigint("delete_at", {
    mode: "number",
  }).default(0),
});
