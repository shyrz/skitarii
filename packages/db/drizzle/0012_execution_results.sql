ALTER TABLE "moderation_decisions" ADD COLUMN "execution_state" text;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD COLUMN "effective_action" "action_kind";--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD COLUMN "execution_failure_reason" text;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_execution_result" CHECK (
      ("moderation_decisions"."execution_state" is null and "moderation_decisions"."effective_action" is null and "moderation_decisions"."execution_failure_reason" is null)
      or ("moderation_decisions"."executed" = true and "moderation_decisions"."execution_state" is not null and (
        ("moderation_decisions"."execution_state" = 'applied' and "moderation_decisions"."effective_action" is not null
          and ("moderation_decisions"."effective_action" = "moderation_decisions"."action" or ("moderation_decisions"."action" in ('mute', 'ban') and "moderation_decisions"."effective_action" = 'delete'))
          and "moderation_decisions"."execution_failure_reason" is null)
        or ("moderation_decisions"."execution_state" = 'rejected' and "moderation_decisions"."effective_action" is null
          and "moderation_decisions"."execution_failure_reason" is not null
          and "moderation_decisions"."execution_failure_reason" in ('telegram_rejected', 'warning_delivery_unconfirmed', 'cancelled_by_appeal'))
      )));