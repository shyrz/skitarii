DROP INDEX "appeals_decision_idx";--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "resolved_by" bigint;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "sample_text" text;--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_decision_unique" ON "appeals" USING btree ("decision_id");--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_resolved_by" CHECK (("appeals"."state" = 'open') = ("appeals"."resolved_by" is null));--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_sample_text_length" CHECK (char_length("message_events"."sample_text") <= 280);