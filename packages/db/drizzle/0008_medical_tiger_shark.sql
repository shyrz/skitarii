CREATE TYPE "public"."chat_type" AS ENUM('group', 'supergroup', 'channel');--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "chat_type" "chat_type" DEFAULT 'supergroup' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "linked_chat_id" text;