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
export type RuleKind =
  | 'keyword'
  | 'regex'
  | 'link-domain'
  | 'sender-name'
  | 'custom-emoji'
  | 'emoji-count'
  | 'via-bot'

/** LLM 复核结论。`legit` 表示判定为正常消息。 */
export type Verdict = 'legit' | 'spam' | 'scam'

/** 申诉状态。`open` 为待处理，其余为终态；不允许用布尔字段表达结案与否。 */
export type AppealState = 'open' | 'upheld' | 'overturned'

/** 订阅状态。`expired` 由到期清理任务写入，`revoked` 由人工撤销写入。 */
export type SubState = 'active' | 'expired' | 'revoked'

/**
 * 已登记的聊天类型。只登记群、超级群与频道：私聊是命令与通知的通道，不产生配置行。
 * 与 Telegram 的 `chat.type` 相比刻意不含 `private`，让「不给私聊建配置」成为类型层的事实。
 */
export type ChatType = 'group' | 'supergroup' | 'channel'

/** 单条审核规则。规则以数据形式存储，执行路径不含针对单个规则的硬编码分支。 */
export interface Rule {
  id: string
  kind: RuleKind
  /**
   * 匹配模式，含义由 `kind` 决定：keyword 为字面量子串，regex 为正则源串（目标是正文），
   * link-domain 为域名，sender-name 为正则源串（目标是发送者身份而非正文），
   * custom-emoji / emoji-count 为十进制最小计数（`customEmojiCount` / `emojiCount` 达到即命中），
   * via-bot 不使用 pattern（留空串）。
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
  /**
   * 聊天类型，来自 Telegram 更新里的 `chat.type`（登记时写入）或管理员的 `my_chat_member` 刷新。
   * 历史行在迁移时按 `supergroup` 兼容，由后续的登记/刷新路径修正（见 README「频道与讨论组」）。
   */
  chatType: ChatType
  /**
   * Telegram 的 linked chat（频道 ↔ 讨论组，双向）：频道行指向它的讨论组，讨论组行指向它所属的频道。
   * 未链接或尚未探测到时为 `null`。它只是登记事实，不参与审核：评论按讨论组自身的规则审。
   */
  linkedChatId: ChatId | null
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
  /**
   * 表情总数，按用户感知每个表情恰计一次：含 `\p{Extended_Pictographic}` 的字素簇计数
   * （ZWJ 序列如家庭表情计 1），加上未被占位符覆盖的自定义表情实体。
   * 普通 Unicode 表情墙在规则层此前是完全隐形的；`customEmojiCount` 是它的下界。
   */
  emojiCount: number
  /** 消息是否经内联机器人发送（`message.via_bot` 存在）。`from` 仍是普通用户，规则层看不到发送者差异。 */
  viaBot: boolean
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

/**
 * 旧的订阅门禁记录。`inviteLink` 来自官方 `createChatSubscriptionInviteLink`。
 *
 * Phase 3b 起新台账拆成 {@link SubscriptionLink} 与 {@link SubscriptionMember}；旧表、旧类型与旧数据保留，
 * 不做自动迁移，也不作为新台账的「既有记录」参与成员跟踪。
 */
export interface Subscription {
  id: string
  chatId: ChatId
  userId: UserId
  inviteLink: string
  expiresAt: Date
  state: SubState
}

/**
 * 订阅链接状态机。
 * `creating` 是持久化请求占位；`create_unknown` 表示外部可能成功但本地未确认；
 * `create_failed` 只在 Telegram 明确拒绝时写入；`active` / `revoked` 必须有完整 `inviteLink`。
 */
export type SubscriptionLinkState = 'creating' | 'active' | 'revoked' | 'create_unknown' | 'create_failed'

/** 链接上正在进行的远端操作种类。同一时刻至多一个。 */
export type SubscriptionOperationKind = 'rename' | 'revoke'

/**
 * 频道订阅邀请链接（由本 Bot 的 `createChatSubscriptionInviteLink` 创建）。
 *
 * 价格与周期不可编辑，`requestHash` 只是原始创建请求的规范化摘要，永远不随改名变化：
 * 同一个 `requestId` 换成不同参数必须被识别为冲突，而不是「重放」。
 */
export interface SubscriptionLink {
  id: string
  chatId: ChatId
  /** 创建者（本部署的 owner，也是唯一的面板使用者）。 */
  ownerUserId: UserId
  /** 客户端生成的幂等键。 */
  requestId: string
  /** 原始创建请求的规范化 JSON 的 sha256；改名不改它。 */
  requestHash: string
  name: string
  priceStars: number
  periodSeconds: number
  /** `active` / `revoked` 必有完整链接，其余状态允许为空。 */
  inviteLink: string | null
  state: SubscriptionLinkState
  createdAt: Date
  updatedAt: Date
  revokedAt: Date | null
  /** 乐观并发版本；每次条件写递增。 */
  version: number
  /** 进行中操作的占位 token；同一时刻至多一个操作。 */
  operationToken: string | null
  operationKind: SubscriptionOperationKind | null
  operationStartedAt: Date | null
}

/** 成员台账状态。`left` 只表示观测到离开频道，不表示订阅到期（禁止用 `expired` 表述）。 */
export type SubscriptionMemberState = 'member' | 'left' | 'unknown'

/** 纳入台账的最近肯定证据：订阅到期字段，或匹配到自建付费链接。保留历史依据，不代表当前付款或链路。 */
export type SubscriptionMemberEvidence = 'until_date' | 'owned_link'

/** 事实采样来源：Telegram 成员事件，或定期对账快照。 */
export type SubscriptionObservationSource = 'event' | 'reconcile'

/**
 * 订阅成员台账。只收录 Bot 有订阅证据的已知成员（或以 `until_date` 观测到订阅的成员）；
 * 不枚举历史全量订户，也不把「曾走付费链接」当作当前付款凭证。
 */
export interface SubscriptionMember {
  id: string
  chatId: ChatId
  userId: UserId
  /** 最近可关联的加入来源链接；无法匹配/未关联时为 `null`。 */
  linkId: string | null
  state: SubscriptionMemberState
  /** 最新成功快照观测到的订阅到期时间；缺失表示「本次未观测到」，不代表无限期或付款失效。 */
  expiresAt: Date | null
  evidence: SubscriptionMemberEvidence
  /** 首次纳入时刻，不可变。 */
  firstObservedAt: Date
  /** 最后一次成功事实采样时刻。 */
  observedAt: Date
  observationSource: SubscriptionObservationSource
  /** 事件高水位（Telegram 秒 + update id）；无事件来源时为 `null`。 */
  lastEventDate: number | null
  lastEventUpdateId: number | null
  /** 成功对账覆盖到的事实时刻；用于丢弃更旧的事件。 */
  reconciledThrough: Date | null
  /** 最后一次对账尝试时刻（失败也推进）。 */
  lastCheckedAt: Date | null
  lastCheckSucceededAt: Date | null
  /** 受控错误码；失败不改成员事实。 */
  lastCheckErrorCode: string | null
  version: number
  /** 对账租约 token 与到期时刻；内部操作字段，HTTP DTO 不暴露。 */
  checkToken: string | null
  checkLeaseUntil: Date | null
}

/** 固定订阅周期（秒），Telegram 当前只接受 2592000。 */
export const SUBSCRIPTION_PERIOD_SECONDS = 2_592_000

/** 链接名称的最大长度（Unicode code point，Telegram 限制 0..32）。 */
export const SUBSCRIPTION_NAME_MAX_LENGTH = 32

/** 每周期价格的下限（Stars）。 */
export const SUBSCRIPTION_PRICE_MIN_STARS = 1

/** 每周期价格的上限（Stars）。 */
export const SUBSCRIPTION_PRICE_MAX_STARS = 10_000

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
