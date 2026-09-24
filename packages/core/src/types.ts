/**
 * 核心领域类型。本文件是全局唯一的类型权威：`packages/db` 的列类型、`packages/llm` 的判别结果、
 * 两个 app 的入参出参都从这里派生，不得在别处平行重写这些形状。
 *
 * 命名约定：领域内标识符一律为品牌字符串/数字，运行时就是 primitive，编译期不可互换，
 * 因此只能在系统边界（Telegram update、HTTP 请求、数据库行）经 `asChatId` / `asUserId` 构造。
 */

/** Telegram 群/频道标识。Bot API 里是 64 位整数（可为负数），这里统一为字符串以免精度丢失。 */
export type ChatId = string & { readonly __brand: 'ChatId' }

/** Telegram 用户标识。取值已超出 int32，故为 number 而非整数类型。 */
export type UserId = number & { readonly __brand: 'UserId' }

/**
 * 规则命中的建议动作，也是 `Action` 的档位来源。
 * 顺序即严重度顺序：pass < warn < delete < mute < ban，累犯加重依赖该顺序。
 */
export type RuleAction = 'pass' | 'warn' | 'delete' | 'mute' | 'ban'

/** 规则匹配方式。新增一种匹配方式时在 `rules.ts` 的匹配器表中登记，而不是加分支。 */
export type RuleKind = 'keyword' | 'regex' | 'link-domain' | 'sender-name' | 'custom-emoji'

/** LLM 复核结论。`legit` 表示判定为正常消息。 */
export type Verdict = 'legit' | 'spam' | 'scam'

/** 申诉状态。`open` 为待处理，其余为终态；不允许用布尔字段表达结案与否。 */
export type AppealState = 'open' | 'upheld' | 'overturned'

/** 订阅状态。`expired` 由到期清理任务写入，`revoked` 由人工撤销写入。 */
export type SubState = 'active' | 'expired' | 'revoked'

/** 单条审核规则。规则以数据形式存储，执行路径不含针对单个规则的硬编码分支。 */
export interface Rule {
  id: string
  kind: RuleKind
  /**
   * 匹配模式，含义由 `kind` 决定：keyword 为字面量子串，regex 为正则源串（目标是正文），
   * link-domain 为域名，sender-name 为正则源串（目标是发送者身份而非正文），
   * custom-emoji 为十进制最小计数（`customEmojiCount` 达到即命中）。
   */
  pattern: string
  /** 命中时贡献的违规分，0..1。多条命中累加，总分封顶 1。 */
  score: number
  /** 总分越过 `llmThreshold` 时直接执行的动作；灰色地带由 LLM 复核结果决定是否落到该动作。 */
  actionHint: RuleAction
  enabled: boolean
}

/**
 * 单个群的审核配置，`chats` 表一行。
 * `passThreshold <= llmThreshold` 是硬约束（见 `decide`），写入时校验。
 */
export interface ChatConfig {
  chatId: ChatId
  title: string
  language: 'zh' | 'en'
  rules: Rule[]
  /** 分数低于此值直接放行，不进 LLM。 */
  passThreshold: number
  /** 分数达到此值直接按 `actionHint` 处置，不进 LLM；介于两阈值之间才送 LLM 复核。 */
  llmThreshold: number
  /** 禁言时长，单位分钟；`decide` 用它算出 `Action.until`。 */
  muteDurationMinutes: number
}

/** 最终处置。`mute` 携带解禁时刻，故不能用「动作 + 可选时长」的散字段表达。 */
export type Action =
  | { kind: 'pass' }
  | { kind: 'warn' }
  | { kind: 'delete' }
  | { kind: 'mute'; until: Date }
  | { kind: 'ban' }

/** 决策依据。规则命中与 LLM 复核共用一个判别联合，便于持久化成 signals 数组。 */
export type Signal =
  | { kind: 'rule-hit'; ruleId: string; score: number }
  | { kind: 'llm'; verdict: Verdict; confidence: number }

/** 消息特征。正文默认不留存，审核与统计只依赖这些可枚举特征与内容哈希。 */
export interface MessageFeatures {
  hasLink: boolean
  mediaType: 'text' | 'photo' | 'video' | 'sticker' | 'other'
  length: number
  /** `custom_emoji` 实体数量。付费表情堆砌是广告号的常见特征（来源实测阈值 >5）。 */
  customEmojiCount: number
}

/** 消息事件。`contentHash` 用于 LLM 缓存与重复检测，原文不出现在任何持久化结构中。 */
export interface MessageEvent {
  /** uuid */
  id: string
  chatId: ChatId
  userId: UserId
  messageId: number
  /** sha256(原始文本)。正文默认不留存 */
  contentHash: string
  features: MessageFeatures
  createdAt: Date
}

/** 一次审核决策。`executed` 区分「已判定」与「已对 Telegram 施加动作」，便于崩溃后补偿执行。 */
export interface ModerationDecision {
  id: string
  eventId: string
  chatId: ChatId
  userId: UserId
  action: Action
  score: number
  signals: Signal[]
  decidedAt: Date
  executed: boolean
}

/**
 * 申诉记录。状态机只有 `open -> upheld | overturned` 一条路径，
 * `resolvedAt` 仅在终态出现，回写误伤样本以 `overturned` 为准。
 */
export interface Appeal {
  id: string
  decisionId: string
  userId: UserId
  state: AppealState
  note: string | null
  createdAt: Date
  resolvedAt: Date | null
}

/** 订阅门禁记录。`inviteLink` 来自官方 `createChatSubscriptionInviteLink`。 */
export interface Subscription {
  id: string
  chatId: ChatId
  userId: UserId
  inviteLink: string
  expiresAt: Date
  state: SubState
}

/** 日聚合。报表只读这张表，不对明细表做范围扫描。 */
export interface DailyAggregate {
  chatId: ChatId
  /** YYYY-MM-DD */
  date: string
  messageCount: number
  actionCount: number
  appealCount: number
  overturnedCount: number
}

/**
 * 把外部字符串收窄为 `ChatId`。只应在边界调用（Telegram update、HTTP 路径参数、数据库行）。
 * 不做格式校验：Telegram chat id 的合法性由来源保证，这里只承担品牌转换。
 */
export function asChatId(value: string): ChatId {
  return value as ChatId
}

/** 把外部数字收窄为 `UserId`。与 `asChatId` 同为边界构造器。 */
export function asUserId(value: number): UserId {
  return value as UserId
}
