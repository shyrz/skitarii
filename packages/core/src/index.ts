/**
 * `@skitarii/core` 的公开表面。上层只从这个入口取领域类型与纯函数，
 * 不直接 import 内部文件，便于日后重排实现。
 */

export { decide, clamp01, RECIDIVISM_THRESHOLD, scoreOf } from './decide.js'
export { normalize } from './normalize.js'
export { TRADITIONAL_TO_SIMPLIFIED, WORD_REPLACEMENTS } from './normalize-map.js'
export type { Replacement } from './normalize-map.js'
export { matchRules } from './rules.js'
export { subscriptionExpiryOf, subscriptionSnapshotOf } from './subscription-observation.js'
export type { SubscriptionMemberSnapshot, SubscriptionMemberSnapshotInput } from './subscription-observation.js'
export type {
  Action,
  Appeal,
  AppealState,
  ChatConfig,
  ChatId,
  ChatType,
  DailyAggregate,
  MessageEvent,
  MessageFeatures,
  ModerationDecision,
  Rule,
  RuleAction,
  RuleKind,
  Signal,
  SubState,
  Subscription,
  SubscriptionLink,
  SubscriptionLinkState,
  SubscriptionMember,
  SubscriptionMemberEvidence,
  SubscriptionMemberState,
  SubscriptionObservationSource,
  SubscriptionOperationKind,
  UserId,
  Verdict,
} from './types.js'
export {
  SUBSCRIPTION_NAME_MAX_LENGTH,
  SUBSCRIPTION_PERIOD_SECONDS,
  SUBSCRIPTION_PRICE_MAX_STARS,
  SUBSCRIPTION_PRICE_MIN_STARS,
} from './types.js'
export { asChatId, asUserId } from './types.js'
