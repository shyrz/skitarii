ALTER TABLE "message_events" ADD COLUMN "emoji_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "via_bot" boolean DEFAULT false NOT NULL;