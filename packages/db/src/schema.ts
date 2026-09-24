import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * 存储层 schema。七张表的职责与 `.workspace/plan.md` 的数据模型一一对应：
 * `chats` 配置、`message_events` 事件流水、`moderation_decisions` 决策、`appeals` 申诉、
 * `subscriptions` 订阅、`daily_aggregates` 日报表、`llm_cache` 复核缓存。
 *
 * 三条硬约定：
 * 1. 消息事件只保留 `content_hash` 与特征；正文唯一的落地形态是 `message_events.sample_text`（
 *    一条被判非放行的消息的原文摘录，供申诉复核看清处置对象）。摘录的存在由「同事件存在非 pass 决策」
 *    在 SQL 侧强制，见仓储的 `attachSample`。
 * 2. 列名 snake_case，与领域字段一一对应；枚举列的取值集合必须与 `@skitarii/core` 的联合类型一致，
 *    两侧脱钩会在仓储实现做行到领域对象的映射时编译报错。
 * 3. 不变量尽量写进 DDL（CHECK 约束），例如「mute 才有解禁时刻」「阈值必须有序」，
 *    让数据库挡住绕过应用的写入，而不是靠调用方自觉。
 *
 * 时间列一律 `timestamptz`，应用层传 `Date`；`chat_id` 用 text 是因为领域类型 `ChatId` 是字符串
 * （Telegram 的 64 位整数会超出 int4），`user_id` 用 bigint 保存为 number。
 * 主键 uuid 由应用生成（`crypto.randomUUID()`），不用数据库默认值，事件 id 在落库前就已存在。
 */

/** 群配置语言。与 `ChatConfig['language']` 一致。 */
export const chatLanguage = pgEnum('chat_language', ['zh', 'en'])

/** 消息媒体类型。与 `MessageFeatures['mediaType']` 一致。 */
export const mediaType = pgEnum('media_type', ['text', 'photo', 'video', 'sticker', 'other'])

/** 处置档位。与 `RuleAction` 一致；`mute` 的具体解禁时刻在 `action_until`。 */
export const actionKind = pgEnum('action_kind', ['pass', 'warn', 'delete', 'mute', 'ban'])

/** 复核结论。与 `Verdict` 一致。 */
export const llmVerdict = pgEnum('llm_verdict', ['legit', 'spam', 'scam'])

/** 申诉状态。与 `AppealState` 一致，只有 `open` 是未结案态。 */
export const appealState = pgEnum('appeal_state', ['open', 'upheld', 'overturned'])

/** 订阅状态。与 `SubState` 一致。 */
export const subscriptionState = pgEnum('subscription_state', ['active', 'expired', 'revoked'])

/**
 * 群配置。`rules` 与阈值拆开存：阈值是查询条件（筛出待审群、做报表），规则集是整块读取的 JSONB。
 * 阈值顺序与时长由 CHECK 约束保证，写入方不必重复校验业务不变量。
 */
export const chats = pgTable(
  'chats',
  {
    chatId: text('chat_id').primaryKey(),
    title: text('title').notNull(),
    language: chatLanguage('language').notNull(),
    /** `Rule[]` 的 JSONB 形态；读取时按 `unknown` 处理，由仓储解析成领域类型。 */
    rules: jsonb('rules').notNull(),
    passThreshold: real('pass_threshold').notNull(),
    llmThreshold: real('llm_threshold').notNull(),
    muteDurationMinutes: integer('mute_duration_minutes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chats_thresholds_order',
      sql`${table.passThreshold} >= 0 and ${table.passThreshold} <= ${table.llmThreshold} and ${table.llmThreshold} <= 1`,
    ),
    check('chats_mute_duration_positive', sql`${table.muteDurationMinutes} > 0`),
  ],
)

/**
 * 正文摘录的长度上限（字符，Unicode 码点）。
 *
 * 取 280 的来历：Telegram 单条消息上限 4096 字符，摘录不是正文留存的替代品，
 * 只需够人工在申诉里认出「被处置的是哪条消息」。280 是推文量级，一条典型垃圾广告的正文都在其内，
 * 而真实的长文（订阅帖、公告）会被截断，不会整段进入数据库。
 */
export const SAMPLE_TEXT_MAX_LENGTH = 280

/**
 * 消息事件流水。Append-only，不建外键：入站消息必须先落库，
 * 不能因为群配置还没登记（新入群的第一条消息）而丢事件。
 * 特征列展开成单列而不是 JSONB，是为了报表能直接聚合。
 */
export const messageEvents = pgTable(
  'message_events',
  {
    id: uuid('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    messageId: integer('message_id').notNull(),
    /** sha256(原始文本)，用于复核缓存与重复消息识别。 */
    contentHash: text('content_hash').notNull(),
    hasLink: boolean('has_link').notNull(),
    mediaType: mediaType('media_type').notNull(),
    length: integer('length').notNull(),
    /** `custom_emoji` 实体数量（`MessageFeatures['customEmojiCount']`）。付费表情堆砌是广告信号的来源。 */
    customEmojiCount: integer('custom_emoji_count').notNull().default(0),
    /**
     * 正文摘录（去掉首尾空白后截到 {@link SAMPLE_TEXT_MAX_LENGTH}）。空值表示「本条没有留下摘录」：
     * 放行的消息不留、纯媒体无文本的消息也没有。仅当该事件存在非 pass 决策时才允许写入。
     */
    sampleText: text('sample_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('message_events_sample_text_length', sql`char_length(${table.sampleText}) <= ${sql.raw(String(SAMPLE_TEXT_MAX_LENGTH))}`),
    index('message_events_chat_created_idx').on(table.chatId, table.createdAt),
    index('message_events_chat_user_created_idx').on(table.chatId, table.userId, table.createdAt),
  ],
)

/**
 * 审核决策。`executed` 支持崩溃后补偿：动作先落库再施加到 Telegram，失败时留可重试记录。
 * 同表不建外键，理由同 `message_events`：处置记录不能因配置缺失而写不进去。
 */
export const moderationDecisions = pgTable(
  'moderation_decisions',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    chatId: text('chat_id').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    action: actionKind('action').notNull(),
    actionUntil: timestamp('action_until', { withTimezone: true }),
    score: real('score').notNull(),
    /** `Signal[]` 的 JSONB 形态，保留判定依据以便申诉复核与误伤复盘。 */
    signals: jsonb('signals').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    executed: boolean('executed').notNull().default(false),
    /**
     * 处置通知的落点：私聊优先时是用户私聊（`notice_chat_id` 为用户 id 的字符串形态），
     * 私聊不可达回退群内时是群 id。申诉生命周期（提交 → 等待复核、结案 → 终态）要按这两个列编辑原通知。
     * 可空：通知是尽力投递的，没发出去或旧数据都没有引用，编辑侧跳过。
     */
    noticeChatId: text('notice_chat_id'),
    /** 通知消息 id，与 `notice_chat_id` 成对出现。 */
    noticeMessageId: integer('notice_message_id'),
  },
  (table) => [
    // 「mute 才带解禁时刻」的双向约束：既挡住 mute 缺时刻，也挡住非 mute 带时刻。
    check('moderation_decisions_action_until', sql`(${table.action} = 'mute') = (${table.actionUntil} is not null)`),
    check('moderation_decisions_score_range', sql`${table.score} >= 0 and ${table.score} <= 1`),
    index('moderation_decisions_event_idx').on(table.eventId),
    index('moderation_decisions_chat_decided_idx').on(table.chatId, table.decidedAt),
    // 累犯加重要按 (群, 用户, 时间) 数违规决策，索引与查询形状对齐，避免全表扫描。
    index('moderation_decisions_user_decided_idx').on(table.chatId, table.userId, table.decidedAt),
    // 面板的跨群处置流按 (decidedAt, id) 倒序分页，前面的复合索引都以 chat_id 打头，覆盖不到这条查询；
    // 带上 id 是给同毫秒的并列记录提供全序，游标才能不重不漏。
    index('moderation_decisions_decided_idx').on(table.decidedAt, table.id),
  ],
)

/**
 * 申诉。外键指向决策并级联删除：申诉脱离决策没有意义，决策被清理时一并带走。
 * `decision_id` 唯一：一条处置只允许一次申诉（重复提交由 API 以 409 拒绝），
 * 否则同一处置会被反复翻转，误伤率统计也会重复计数。
 * `resolved_at` / `resolved_by` 与 `state` 的对应关系由 CHECK 约束保证，
 * 状态机不会出现「已结案但没有结案时间或结案人」。
 * `notified_at` 是运维标记（owner 私聊是否已被接受），不属于状态机，因此不参与 CHECK。
 */
export const appeals = pgTable(
  'appeals',
  {
    id: uuid('id').primaryKey(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => moderationDecisions.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    state: appealState('state').notNull().default('open'),
    /** 申诉理由，来自 Mini App 表单，长度由 API 层限制在 1..500。 */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** 结案人（Telegram 用户 id）。Phase 1 只有 owner 能结案；留列是为了追责与日后的多管理员。 */
    resolvedBy: bigint('resolved_by', { mode: 'number' }),
    /**
     * owner 通知被 Telegram 接受的时刻。`null` 表示还没通知成功（创建后通知失败、或通知发出前进程崩溃），
     * 由调度器的补发扫描重试。不参与申诉状态机：结案只看 `state` / `resolved_at` / `resolved_by`。
     */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    /**
     * 撤销结案后权限尚未回滚完成的标记。
     *
     * 结案（`state → overturned`）与回滚（解禁/解封）是两个独立动作，中途崩溃会让权限永远停在受限状态：
     * 在 claim 的同一条 UPDATE 里把本列置 `true`，回滚成功后再清除；调度器的回滚补偿扫描按本列兜底重试。
     * 外键级联下它不应长期为 `true`（决策缺失时扫描会清标记并告警）。
     */
    rollbackPending: boolean('rollback_pending').notNull().default(false),
  },
  (table) => [
    check('appeals_resolved_at', sql`(${table.state} = 'open') = (${table.resolvedAt} is null)`),
    check('appeals_resolved_by', sql`(${table.state} = 'open') = (${table.resolvedBy} is null)`),
    uniqueIndex('appeals_decision_unique').on(table.decisionId),
    index('appeals_state_idx').on(table.state),
  ],
)

/**
 * 订阅门禁。邀请链接唯一：同一个 `createChatSubscriptionInviteLink` 结果只能对应一条记录。
 * 外键指向 `chats`：没有群配置就不该有订阅记录，这里可以安全依赖配置先存在。
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.chatId, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    inviteLink: text('invite_link').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    state: subscriptionState('state').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subscriptions_invite_link_key').on(table.inviteLink),
    index('subscriptions_chat_state_idx').on(table.chatId, table.state),
  ],
)

/**
 * 日聚合。报表唯一数据源，配合 `(chat_id, date)` 主键天然幂等：重算某天直接 upsert。
 * 外键指向 `chats`，聚合行只对已登记的群存在。
 */
export const dailyAggregates = pgTable(
  'daily_aggregates',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.chatId, { onDelete: 'cascade' }),
    /** YYYY-MM-DD，按群所在时区切日。 */
    date: date('date').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    actionCount: integer('action_count').notNull().default(0),
    appealCount: integer('appeal_count').notNull().default(0),
    overturnedCount: integer('overturned_count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.date] })],
)

/**
 * 复核缓存。键是判定指纹，不是裸内容哈希：指纹覆盖正文哈希、发送者身份、语言、消息特征与
 * 规则信号（派生见 `packages/llm/src/cached-judge.ts`），因此同一段正文换发送者或换命中组合
 * 会重新复核，身份原文不落库。缓存命中仍会走 `decide`，规则集的差异不会被缓存抹平。
 */
export const llmCache = pgTable(
  'llm_cache',
  {
    /** 判定指纹（sha256 摘要）；列名沿用 `content_hash`。 */
    contentHash: text('content_hash').primaryKey(),
    verdict: llmVerdict('verdict').notNull(),
    confidence: real('confidence').notNull(),
    /** 产出该结论的模型名，换模型后可据此失效旧缓存。 */
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('llm_cache_confidence_range', sql`${table.confidence} >= 0 and ${table.confidence} <= 1`)],
)

/** `chats` 行的读取形状。 */
export type ChatRow = typeof chats.$inferSelect
/** `chats` 行的写入形状。 */
export type ChatInsert = typeof chats.$inferInsert
/** `message_events` 行的读取形状。 */
export type MessageEventRow = typeof messageEvents.$inferSelect
/** `moderation_decisions` 行的读取形状。 */
export type ModerationDecisionRow = typeof moderationDecisions.$inferSelect
/** `appeals` 行的读取形状。 */
export type AppealRow = typeof appeals.$inferSelect
/** `subscriptions` 行的读取形状。 */
export type SubscriptionRow = typeof subscriptions.$inferSelect
/** `daily_aggregates` 行的读取形状。 */
export type DailyAggregateRow = typeof dailyAggregates.$inferSelect
/** `llm_cache` 行的读取形状。 */
export type LlmCacheEntry = typeof llmCache.$inferSelect
/** `llm_cache` 行的写入形状。 */
export type LlmCacheInsert = typeof llmCache.$inferInsert
