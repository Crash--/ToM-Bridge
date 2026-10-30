-- The tables as the bridge created them at start before Drizzle: a database it
-- already set up keeps its tables and rows, a new one gets them here.
CREATE TABLE IF NOT EXISTS "spaceclock" (
	"clock_key" varchar(255) PRIMARY KEY,
	"timestamp" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spaces" (
	"space_id" varchar(255) PRIMARY KEY,
	"organization_id" varchar(255),
	"room_id" varchar(255),
	"timestamp" bigint,
	"delete_at" bigint DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usersettings" (
	"matrix_id" varchar(255) PRIMARY KEY,
	"settings" jsonb,
	"version" integer DEFAULT 1,
	"timestamp" bigint DEFAULT 0,
	"request_id" varchar(255) DEFAULT '',
	"avatar_source" text,
	"avatar_mxc" text
);
--> statement-breakpoint
-- An older bridge added these columns at start, one release after another
ALTER TABLE "usersettings" ADD COLUMN IF NOT EXISTS "settings" jsonb;
--> statement-breakpoint
ALTER TABLE "usersettings" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "usersettings" ADD COLUMN IF NOT EXISTS "timestamp" bigint DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "usersettings" ADD COLUMN IF NOT EXISTS "request_id" varchar(255) DEFAULT '';
--> statement-breakpoint
ALTER TABLE "usersettings" ADD COLUMN IF NOT EXISTS "avatar_source" text;
--> statement-breakpoint
ALTER TABLE "usersettings" ADD COLUMN IF NOT EXISTS "avatar_mxc" text;
