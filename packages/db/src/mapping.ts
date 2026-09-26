import {
  asChatId,
  asUserId,
  type Action,
  type Appeal,
  type ChatConfig,
  type DailyAggregate,
  type MessageEvent,
  type ModerationDecision,
  type Rule,
  type RuleAction,
  type Signal,
  type Subscription,
  type SubscriptionLink,
  type SubscriptionMember,
  type UserId,
} from '@skitarii/core'
import { z } from 'zod'
import { SAMPLE_TEXT_MAX_LENGTH, type AppealRow, type ChatRow, type DailyAggregateRow, type MessageEventRow, type ModerationDecisionRow, type SubscriptionLinkRow, type SubscriptionMemberRow, type SubscriptionRow } from './schema.js'

/**
 * 数据库行 ↔ 领域对象的映射边界。
 *
 * 这里是「外部数据进系统」的唯一收口：JSONB 列按 zod schema 解析成领域类型，
 * 字符串/数字列经 `asChatId` / `asUserId` 打上品牌，枚举列直接取值；列类型与领域联合类型
 * 由编译器对齐，任何一侧新增取值都会在这里编译失败。
 *
 * 解析失败一律抛错而不是回退默认值：坏数据应当让运维看见（日志里带事件 id 可定位），
 * 而不是让一条解析失败的消息静默按「无规则」放行。唯一例外是 `chats.whitelist`：
 * 它只是放行优化，坏数据失效即可，不能让整条判定链路失败（见 `parseChatWhitelist`）。
 */

/** `Rule[]` 的 JSONB 形状。与领域 `Rule` 的字段一一对应。 */
const ruleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['keyword', 'regex', 'link-domain', 'sender-name', 'custom-emoji', 'emoji-count', 'via-bot']),
  pattern: z.string(),
  score: z.number().min(0).max(1),
  actionHint: z.enum(['pass', 'warn', 'delete', 'mute', 'ban']),
  enabled: z.boolean(),
})

const ruleListSchema = z.array(ruleSchema)

/** `ChatConfig['whitelist']` 的 JSONB 形状：正安全整数的用户 ID 数组。 */
const whitelistSchema = z.array(
  z.custom<number>((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0),
)

/** `Signal[]` 的 JSONB 形状。判别字段是 `kind`，与领域联合一一对应。 */
const signalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rule-hit'), ruleId: z.string().min(1), score: z.number().min(0).max(1) }),
  z.object({ kind: z.literal('llm'), verdict: z.enum(['legit', 'spam', 'scam']), confidence: z.number().min(0).max(1) }),
])

const signalListSchema = z.array(signalSchema)

/**
 * 解析 `chats.rules`。
 *
 * @param value JSONB 列的原始值（`unknown`）。
 * @returns 领域规则集。
 * @throws {z.ZodError} 结构不符合 `Rule[]` 时抛出，附带首个错误路径。
 */
export function parseChatRules(value: unknown): Rule[] {
  const rules: Rule[] = ruleListSchema.parse(value)
  return rules
}

/**
 * 解析 `chats.whitelist`。
 *
 * 与 {@link parseChatRules} 的严格口径不同：信任名单是放行优化，坏数据只该让它失效，
 * 不能阻断判定——读取侧回落空数组，保持既有宽松口径。写入侧（面板）负责校验、去重与上限。
 *
 * @param value JSONB 列的原始值（`unknown`）。
 * @returns 领域白名单；非数字数组（含混入负数、小数、非安全整数）时为空数组。
 */
export function parseChatWhitelist(value: unknown): UserId[] {
  const parsed = whitelistSchema.safeParse(value)
  return parsed.success ? parsed.data.map((id) => asUserId(id)) : []
}

/**
 * `chats` 行 → 群配置。
 *
 * @param row 数据库行。
 * @returns 领域配置，`chatId` 已打品牌。
 */
export function toChatConfig(row: ChatRow): ChatConfig {
  return {
    chatId: asChatId(row.chatId),
    title: row.title,
    chatType: row.chatType,
    linkedChatId: row.linkedChatId === null ? null : asChatId(row.linkedChatId),
    language: row.language,
    rules: parseChatRules(row.rules),
    whitelist: parseChatWhitelist(row.whitelist),
    passThreshold: row.passThreshold,
    llmThreshold: row.llmThreshold,
    muteDurationMinutes: row.muteDurationMinutes,
  }
}

/**
 * `message_events` 行 → 消息事件。摘录列不在这里映射：它只服务于申诉页面，
 * 需要时由 `findWithSample` 单独取出，避免「顺手带出正文」成为默认路径。
 *
 * @param row 数据库行。
 * @returns 领域事件。
 */
export function toMessageEvent(row: MessageEventRow): MessageEvent {
  return {
    id: row.id,
    chatId: asChatId(row.chatId),
    userId: asUserId(row.userId),
    messageId: row.messageId,
    contentHash: row.contentHash,
    features: {
      hasLink: row.hasLink,
      mediaType: row.mediaType,
      length: row.length,
      customEmojiCount: row.customEmojiCount,
      emojiCount: row.emojiCount,
      viaBot: row.viaBot,
    },
    createdAt: row.createdAt,
  }
}

/**
 * 决策的档位列 + 解禁时刻列 → 领域处置。
 *
 * 两个列在领域里是同一个判别联合，因此映射必须联合判断：`mute` 缺 `action_until`
 * 说明 DDL 的 CHECK 被绕过（或代码写坏了），此时抛错而不是造一个 `until` 为空的禁言。
 *
 * @param action `moderation_decisions.action` 列。
 * @param until `moderation_decisions.action_until` 列。
 * @returns 领域处置。
 * @throws {Error} `mute` 与 `action_until` 不匹配时抛出。
 */
export function toAction(action: RuleAction, until: Date | null): Action {
  switch (action) {
    case 'pass':
      return { kind: 'pass' }
    case 'warn':
      return { kind: 'warn' }
    case 'delete':
      return { kind: 'delete' }
    case 'ban':
      return { kind: 'ban' }
    case 'mute':
      if (until === null) throw new Error('mute 决策缺少 action_until')
      return { kind: 'mute', until }
    default: {
      const exhaustive: never = action
      throw new Error(`未知处置档位: ${String(exhaustive)}`)
    }
  }
}

/**
 * `moderation_decisions` 行 → 领域决策。
 *
 * @param row 数据库行。
 * @returns 领域决策，`signals` 已解析成 `Signal[]`。
 */
export function toModerationDecision(row: ModerationDecisionRow): ModerationDecision {
  const signals: Signal[] = signalListSchema.parse(row.signals)
  return {
    id: row.id,
    eventId: row.eventId,
    chatId: asChatId(row.chatId),
    userId: asUserId(row.userId),
    action: toAction(row.action, row.actionUntil),
    score: row.score,
    signals,
    decidedAt: row.decidedAt,
    executed: row.executed,
  }
}

/**
 * `appeals` 行 → 领域申诉。结案人列不进领域类型（`Appeal` 的权威形状在 core），
 * 需要时由调用方读数据库行或另加查询。
 *
 * @param row 数据库行。
 * @returns 领域申诉。
 */
export function toAppeal(row: AppealRow): Appeal {
  return {
    id: row.id,
    decisionId: row.decisionId,
    userId: asUserId(row.userId),
    state: row.state,
    note: row.note,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  }
}

/**
 * `subscriptions` 行 → 领域订阅。
 *
 * @param row 数据库行。
 * @returns 领域订阅。
 */
export function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    chatId: asChatId(row.chatId),
    userId: asUserId(row.userId),
    inviteLink: row.inviteLink,
    expiresAt: row.expiresAt,
    state: row.state,
  }
}

/**
 * `subscription_links` 行 → 领域链接。
 *
 * 状态、操作占位与日期列直接透传：DDL 的 CHECK 已保证取值合法与三字段同空性，
 * 这里不做二次默认（脏数据应当编译期/运行期可见，而不是被静默改写）。
 *
 * @param row 数据库行。
 * @returns 领域链接。
 */
export function toSubscriptionLink(row: SubscriptionLinkRow): SubscriptionLink {
  return {
    id: row.id,
    chatId: asChatId(row.chatId),
    ownerUserId: asUserId(row.ownerUserId),
    requestId: row.requestId,
    requestHash: row.requestHash,
    name: row.name,
    priceStars: row.priceStars,
    periodSeconds: row.periodSeconds,
    inviteLink: row.inviteLink,
    // 文本列受 DDL 的 CHECK 约束；这里按领域联合类型收窄（取值集合两侧必须一致）。
    state: row.state as SubscriptionLink['state'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
    version: row.version,
    operationToken: row.operationToken,
    operationKind: row.operationKind as SubscriptionLink['operationKind'],
    operationStartedAt: row.operationStartedAt,
  }
}

/**
 * `subscription_members` 行 → 领域成员。
 *
 * `linkId` 是 uuid 列，这里保持字符串形态（领域里它不是 `ChatId` 品牌）；
 * `lastEventDate` / `lastEventUpdateId` 由 CHECK 保证同空性。
 *
 * @param row 数据库行。
 * @returns 领域成员。
 */
export function toSubscriptionMember(row: SubscriptionMemberRow): SubscriptionMember {
  return {
    id: row.id,
    chatId: asChatId(row.chatId),
    userId: asUserId(row.userId),
    linkId: row.linkId,
    // 三个文本列都受 DDL CHECK 约束，按领域联合类型收窄。
    state: row.state as SubscriptionMember['state'],
    expiresAt: row.expiresAt,
    evidence: row.evidence as SubscriptionMember['evidence'],
    firstObservedAt: row.firstObservedAt,
    observedAt: row.observedAt,
    observationSource: row.observationSource as SubscriptionMember['observationSource'],
    lastEventDate: row.lastEventDate,
    lastEventUpdateId: row.lastEventUpdateId,
    reconciledThrough: row.reconciledThrough,
    lastCheckedAt: row.lastCheckedAt,
    lastCheckSucceededAt: row.lastCheckSucceededAt,
    lastCheckErrorCode: row.lastCheckErrorCode,
    version: row.version,
    checkToken: row.checkToken,
    checkLeaseUntil: row.checkLeaseUntil,
  }
}

/**
 * `daily_aggregates` 行 → 日聚合。
 *
 * @param row 数据库行。
 * @returns 日聚合；`date` 列的 `YYYY-MM-DD` 形态由驱动保证，这里不做二次格式化。
 */
export function toDailyAggregate(row: DailyAggregateRow): DailyAggregate {
  return {
    chatId: asChatId(row.chatId),
    date: row.date,
    messageCount: row.messageCount,
    actionCount: row.actionCount,
    appealCount: row.appealCount,
    overturnedCount: row.overturnedCount,
  }
}

/**
 * 截断正文摘录：先滤掉 NUL 与控制字符，再去掉首尾空白（否则摘录可能整段都是换行），
 * 最后按 Unicode 码点截到长度上限。
 *
 * 过滤控制字符的理由：Postgres 的 `text` 列拒绝 NUL（`\u0000`），写入会直接抛错并中断 attachSample
 * 所在的管线路径；其余 C0/C1 控制字符（终端转义、退格、垂直制表符）没有展示价值，留在申诉页里只会
 * 变成乱码。`\t`、`\n`、`\r` 是正文排版的一部分，保留。
 *
 * 按码点而不是 UTF-16 单元截断：`String.prototype.slice` 会把表情符号切成半个代理对，
 * 存进 `text` 列虽然不报错，但读出来是乱码。
 *
 * @param text 消息原文。
 * @returns 可直接写入 `message_events.sample_text` 的摘录。
 */
export function truncateSampleText(text: string): string {
  const chars = Array.from(text.replace(CONTROL_CHARACTERS, '').trim())
  if (chars.length <= SAMPLE_TEXT_MAX_LENGTH) return chars.join('')
  return chars.slice(0, SAMPLE_TEXT_MAX_LENGTH).join('')
}

/**
 * 需要滤掉的控制字符：NUL、除 `\t`（\u0009）`\n`（\u000a）`\r`（\u000d）之外的 C0、
 * DEL（\u007f）与 C1（\u0080-\u009f）。
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
