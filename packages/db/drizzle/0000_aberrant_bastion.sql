CREATE TYPE "public"."action_kind" AS ENUM('pass', 'warn', 'delete', 'mute', 'ban');--> statement-breakpoint
CREATE TYPE "public"."appeal_state" AS ENUM('open', 'upheld', 'overturned');--> statement-breakpoint
CREATE TYPE "public"."chat_language" AS ENUM('zh', 'en');--> statement-breakpoint
CREATE TYPE "public"."llm_verdict" AS ENUM('legit', 'spam', 'scam');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('text', 'photo', 'video', 'sticker', 'other');--> statement-breakpoint
CREATE TYPE "public"."subscription_state" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"decision_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"state" "appeal_state" DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "appeals_resolved_at" CHECK (("appeals"."state" = 'open') = ("appeals"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"language" "chat_language" NOT NULL,
	"rules" jsonb NOT NULL,
	"pass_threshold" real NOT NULL,
	"llm_threshold" real NOT NULL,
	"mute_duration_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_thresholds_order" CHECK ("chats"."pass_threshold" >= 0 and "chats"."pass_threshold" <= "chats"."llm_threshold" and "chats"."llm_threshold" <= 1),
	CONSTRAINT "chats_mute_duration_positive" CHECK ("chats"."mute_duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_aggregates" (
	"chat_id" text NOT NULL,
	"date" date NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"action_count" integer DEFAULT 0 NOT NULL,
	"appeal_count" integer DEFAULT 0 NOT NULL,
	"overturned_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_aggregates_chat_id_date_pk" PRIMARY KEY("chat_id","date")
);
--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"verdict" "llm_verdict" NOT NULL,
	"confidence" real NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_cache_confidence_range" CHECK ("llm_cache"."confidence" >= 0 and "llm_cache"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"content_hash" text NOT NULL,
	"has_link" boolean NOT NULL,
	"media_type" "media_type" NOT NULL,
	"length" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"action" "action_kind" NOT NULL,
	"action_until" timestamp with time zone,
	"score" real NOT NULL,
	"signals" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"executed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "moderation_decisions_action_until" CHECK (("moderation_decisions"."action" = 'mute') = ("moderation_decisions"."action_until" is not null)),
	CONSTRAINT "moderation_decisions_score_range" CHECK ("moderation_decisions"."score" >= 0 and "moderation_decisions"."score" <= 1)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"invite_link" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" "subscription_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_decision_id_moderation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."moderation_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_aggregates" ADD CONSTRAINT "daily_aggregates_chat_id_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_chat_id_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appeals_decision_idx" ON "appeals" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "appeals_state_idx" ON "appeals" USING btree ("state");--> statement-breakpoint
CREATE INDEX "message_events_chat_created_idx" ON "message_events" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "message_events_chat_user_created_idx" ON "message_events" USING btree ("chat_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_decisions_event_idx" ON "moderation_decisions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "moderation_decisions_chat_decided_idx" ON "moderation_decisions" USING btree ("chat_id","decided_at");--> statement-breakpoint
CREATE INDEX "moderation_decisions_user_decided_idx" ON "moderation_decisions" USING btree ("chat_id","user_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_invite_link_key" ON "subscriptions" USING btree ("invite_link");--> statement-breakpoint
CREATE INDEX "subscriptions_chat_state_idx" ON "subscriptions" USING btree ("chat_id","state");