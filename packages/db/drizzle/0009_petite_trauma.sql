CREATE TABLE "subscription_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"name" text NOT NULL,
	"price_stars" integer NOT NULL,
	"period_seconds" integer NOT NULL,
	"invite_link" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"operation_token" uuid,
	"operation_kind" text,
	"operation_started_at" timestamp with time zone,
	CONSTRAINT "subscription_links_price_range" CHECK ("subscription_links"."price_stars" >= 1 and "subscription_links"."price_stars" <= 10000),
	CONSTRAINT "subscription_links_name_length" CHECK (char_length("subscription_links"."name") <= 32),
	CONSTRAINT "subscription_links_period_fixed" CHECK ("subscription_links"."period_seconds" = 2592000),
	CONSTRAINT "subscription_links_state_valid" CHECK ("subscription_links"."state" in ('creating', 'active', 'revoked', 'create_unknown', 'create_failed')),
	CONSTRAINT "subscription_links_link_complete" CHECK ("subscription_links"."invite_link" is not null or "subscription_links"."state" not in ('active', 'revoked')),
	CONSTRAINT "subscription_links_revoked_at" CHECK (("subscription_links"."state" = 'revoked') = ("subscription_links"."revoked_at" is not null)),
	CONSTRAINT "subscription_links_operation_fields" CHECK ((("subscription_links"."operation_token" is null) = ("subscription_links"."operation_kind" is null)) and (("subscription_links"."operation_kind" is null) = ("subscription_links"."operation_started_at" is null)) and ("subscription_links"."operation_kind" is null or "subscription_links"."operation_kind" in ('rename', 'revoke')))
);
--> statement-breakpoint
CREATE TABLE "subscription_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"link_id" uuid,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone,
	"evidence" text NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observation_source" text NOT NULL,
	"last_event_date" bigint,
	"last_event_update_id" bigint,
	"reconciled_through" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_succeeded_at" timestamp with time zone,
	"last_check_error_code" text,
	"version" integer DEFAULT 0 NOT NULL,
	"check_token" uuid,
	"check_lease_until" timestamp with time zone,
	CONSTRAINT "subscription_members_state_valid" CHECK ("subscription_members"."state" in ('member', 'left', 'unknown')),
	CONSTRAINT "subscription_members_evidence_valid" CHECK ("subscription_members"."evidence" in ('until_date', 'owned_link')),
	CONSTRAINT "subscription_members_source_valid" CHECK ("subscription_members"."observation_source" in ('event', 'reconcile')),
	CONSTRAINT "subscription_members_event_high_water" CHECK (("subscription_members"."last_event_date" is null) = ("subscription_members"."last_event_update_id" is null))
);
--> statement-breakpoint
ALTER TABLE "subscription_links" ADD CONSTRAINT "subscription_links_chat_id_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_members" ADD CONSTRAINT "subscription_members_chat_id_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 复合外键引用的 (chat_id,id) 唯一索引必须先于外键建立：PostgreSQL 的 FK 只认已存在的唯一约束/唯一索引。
CREATE UNIQUE INDEX "subscription_links_chat_id_id_key" ON "subscription_links" USING btree ("chat_id","id");--> statement-breakpoint
ALTER TABLE "subscription_members" ADD CONSTRAINT "subscription_members_link_fk" FOREIGN KEY ("chat_id","link_id") REFERENCES "public"."subscription_links"("chat_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_links_owner_request_key" ON "subscription_links" USING btree ("owner_user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_links_invite_link_key" ON "subscription_links" USING btree ("invite_link") WHERE "subscription_links"."invite_link" is not null;--> statement-breakpoint
CREATE INDEX "subscription_links_chat_created_idx" ON "subscription_links" USING btree ("chat_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_members_chat_user_key" ON "subscription_members" USING btree ("chat_id","user_id");--> statement-breakpoint
CREATE INDEX "subscription_members_chat_first_idx" ON "subscription_members" USING btree ("chat_id","first_observed_at","id");--> statement-breakpoint
CREATE INDEX "subscription_members_scan_idx" ON "subscription_members" USING btree ("last_checked_at" NULLS FIRST,"id");