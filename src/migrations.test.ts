import { describe, expect, it } from "vitest";

import { openTestDatabase } from "./__mocks__/pglite.js";

// The tables and rows of a database the bridge set up before its migrations
const LEGACY = `
  CREATE TABLE usersettings(matrix_id varchar(255) PRIMARY KEY, settings jsonb, version int DEFAULT 1, timestamp bigint DEFAULT 0, request_id varchar(255) DEFAULT '');
  CREATE TABLE spaceclock(clock_key varchar(255) PRIMARY KEY, timestamp bigint);
  CREATE TABLE spaces(space_id varchar(255) PRIMARY KEY, organization_id varchar(255), room_id varchar(255), timestamp bigint, delete_at bigint DEFAULT 0);
  INSERT INTO usersettings VALUES ('@jdoe:acme.example', '{"matrix_id":"@jdoe:acme.example","display_name":"John"}', 3, 1000, 'req-3');
  INSERT INTO spaceclock VALUES ('s1/name', 2000);
  INSERT INTO spaces VALUES ('s1', 'acme', '!s1:acme.example', 2000, 0);
`;

// The same, set up by a bridge that stores the avatar it uploaded
const LEGACY_WITH_AVATAR = `
  CREATE TABLE usersettings(matrix_id varchar(255) PRIMARY KEY, settings jsonb, version int DEFAULT 1, timestamp bigint DEFAULT 0, request_id varchar(255) DEFAULT '', avatar_source text, avatar_mxc text);
  CREATE TABLE spaceclock(clock_key varchar(255) PRIMARY KEY, timestamp bigint);
  CREATE TABLE spaces(space_id varchar(255) PRIMARY KEY, organization_id varchar(255), room_id varchar(255), timestamp bigint, delete_at bigint DEFAULT 0);
  INSERT INTO usersettings VALUES ('@jdoe:acme.example', '{"matrix_id":"@jdoe:acme.example","display_name":"John"}', 3, 1761590000123, 'req-3', 'https://acme.example/jdoe.png', 'mxc://acme.example/jdoe');
`;

describe("migrations", () => {
  it("keep the avatar a bridge stored before them", async () => {
    const { client } = await openTestDatabase(LEGACY_WITH_AVATAR);

    const settings = await client.query<Record<string, unknown>>("SELECT * FROM usersettings");
    expect(settings.rows).toEqual([
      {
        matrix_id: "@jdoe:acme.example",
        settings: {
          matrix_id: "@jdoe:acme.example",
          display_name: "John",
        },
        version: 3,
        timestamp: 1761590000123,
        request_id: "req-3",
        avatar_source: "https://acme.example/jdoe.png",
        avatar_mxc: "mxc://acme.example/jdoe",
      },
    ]);
  });

  it("keep the tables and rows of a database the bridge set up before them", async () => {
    const { client } = await openTestDatabase(LEGACY);

    const settings = await client.query<Record<string, unknown>>("SELECT * FROM usersettings");
    expect(settings.rows).toEqual([
      {
        matrix_id: "@jdoe:acme.example",
        settings: {
          matrix_id: "@jdoe:acme.example",
          display_name: "John",
        },
        version: 3,
        timestamp: 1000,
        request_id: "req-3",
        avatar_source: null,
        avatar_mxc: null,
      },
    ]);
    expect((await client.query("SELECT * FROM spaceclock")).rows).toHaveLength(1);
    expect((await client.query("SELECT * FROM spaces")).rows).toHaveLength(1);
  });

  it("create the tables of a new database", async () => {
    const { client } = await openTestDatabase();

    const tables = await client.query<{
      table_name: string;
    }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "spaceclock",
      "spaces",
      "usersettings",
    ]);
  });
});
