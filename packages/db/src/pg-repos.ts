import { and, asc, count, desc, eq, exists, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { asChatId, asUserId, type ChatConfig, type ChatId } from '@skitarii/core'
import type { Db } from './client.js'
import {
  toAppeal,
  toChatConfig,
  toDailyAggregate,
  toMessageEvent,
  toModerationDecision,
  toSubscription,
  toSubscriptionLink,
  toSubscriptionMember,
  truncateSampleText,
} from './mapping.js'
import type { AggregateRepo, AppealRepo, ChatRepo, CheckClaim, CheckResult, ClaimResult, DailyCounts, DecisionRepo, LinkMutationResult, LlmCacheRepo, MemberEventObservation, MessageEventRepo, Repos, ReserveCreateOutcome, SubscriptionLinkRepo, SubscriptionMemberRepo, SubscriptionRepo } from './repos.js'
import {
  appeals,
  chats,
  dailyAggregates,
  llmCache,
  messageEvents,
  moderationDecisions,
  subscriptionLinks,
  subscriptionMembers,
  subscriptions,
} from './schema.js'

/**
 * 七个仓储的 Postgres 实现。
 *
 * 实现约定：
 * - 所有用户可控的值都走参数占位符（drizzle 的列值、`eq` / `lt` 等条件），SQL 里不出现字面量拼接；
 *   唯一的字面量是 DDL 常量（如摘录长度上限），它来自代码常量而不是输入。
 * - 行到领域对象的转换全部委托给 `mapping.ts`，本文件不做形状判断，只做 SQL 与调用面的对齐。
 * - 幂等写一律用 `on conflict do nothing`：重复的 `insert` 必须是可安全重放的静默操作，
 *   因为 Telegram 会重投递 update，崩溃恢复也会重放同一条记录。
 */

/**
 * 建立 PG 仓储聚合。
 *
 * @param db drizzle 实例（`createDb` 的产物）。
 * @returns 满足 `Repos` 的实现。实例无内部状态，可安全地在整个进程内复用。
 */
export function createPgRepos(db: Db): Repos {
  return {
    chats: createChatRepo(db),
    events: createMessageEventRepo(db),
    decisions: createDecisionRepo(db),
    appeals: createAppealRepo(db),
    subscriptions: createSubscriptionRepo(db),
    subscriptionLinks: createSubscriptionLinkRepo(db),
    subscriptionMembers: createSubscriptionMemberRepo(db),
    aggregates: createAggregateRepo(db),
    llmCache: createLlmCacheRepo(db),
  }
}

/**
 * `chats` 仓储。
 *
 * 三条写路径的职责边界：
 * - `upsert`：owner 在面板里的显式全量保存，覆盖配置字段并刷新元数据列；
 * - `register`：首次登记，冲突即放弃（绝不用默认配置覆盖 owner 已保存的规则）；
 * - `updateMetadata`：只清单列更新 title / chat_type / linked_chat_id，规则与阈值原样保留。
 *
 * @param db drizzle 实例。
 * @returns 群配置读写实现。
 */
function createChatRepo(db: Db): ChatRepo {
  return {
    async upsert(config): Promise<void> {
      await db
        .insert(chats)
        .values(chatConfigValues(config))
        .onConflictDoUpdate({
          target: chats.chatId,
          set: {
            title: config.title,
            chatType: config.chatType,
            linkedChatId: config.linkedChatId,
            language: config.language,
            rules: config.rules,
            whitelist: config.whitelist,
            passThreshold: config.passThreshold,
            llmThreshold: config.llmThreshold,
            muteDurationMinutes: config.muteDurationMinutes,
            updatedAt: new Date(),
          },
        })
    },

    async register(config): Promise<void> {
      await db.insert(chats).values(chatConfigValues(config)).onConflictDoNothing({ target: chats.chatId })
    },

    async findByChatId(chatId): Promise<ChatConfig | null> {
      const rows = await db.select().from(chats).where(eq(chats.chatId, chatId)).limit(1)
      const row = rows[0]
      return row === undefined ? null : toChatConfig(row)
    },

    async updateMetadata(chatId, patch): Promise<void> {
      const set: Partial<typeof chats.$inferInsert> = { updatedAt: new Date() }
      if (patch.title !== undefined) set.title = patch.title
      if (patch.chatType !== undefined) set.chatType = patch.chatType
      if (patch.linkedChatId !== undefined) set.linkedChatId = patch.linkedChatId
      await db.update(chats).set(set).where(eq(chats.chatId, chatId))
    },

    async updateRulesConfig(chatId, patch): Promise<void> {
      // 面板 PUT 专用：只写规则、白名单与阈值，绝不触碰 title / chat_type / linked_chat_id / language。
      await db
        .update(chats)
        .set({
          rules: patch.rules,
          whitelist: patch.whitelist,
          passThreshold: patch.passThreshold,
          llmThreshold: patch.llmThreshold,
          muteDurationMinutes: patch.muteDurationMinutes,
          updatedAt: new Date(),
        })
        .where(eq(chats.chatId, chatId))
    },

    async listAll() {
      const rows = await db.select().from(chats).orderBy(asc(chats.chatId))
      return rows.map(toChatConfig)
    },

    async listChannelsPage({ afterChatId, limit }) {
      const conditions = [eq(chats.chatType, 'channel')]
      if (afterChatId !== undefined) {
        // 游标边界与排序都固定 C 排序规则：默认 collation 可能给出与内存实现（UTF-16 码元序）和游标契约不同的顺序。
        conditions.push(sql`${chats.chatId} collate "C" > ${afterChatId} collate "C"`)
      }
      const rows = await db
        .select()
        .from(chats)
        .where(and(...conditions))
        .orderBy(asc(sql`${chats.chatId} collate "C"`))
        .limit(limit)
      return rows.map(toChatConfig)
    },
  }
}

/**
 * `ChatConfig` → `chats` 行的列值。insert 与 update 共用同一份，避免两条语句的字段清单漂移。
 *
 * @param config 领域配置。
 * @returns 可直接交给 drizzle 的列值对象。
 */
function chatConfigValues(config: ChatConfig): {
  chatId: string
  title: string
  chatType: ChatConfig['chatType']
  linkedChatId: string | null
  language: ChatConfig['language']
  rules: ChatConfig['rules']
  whitelist: ChatConfig['whitelist']
  passThreshold: number
  llmThreshold: number
  muteDurationMinutes: number
} {
  return {
    chatId: config.chatId,
    title: config.title,
    chatType: config.chatType,
    linkedChatId: config.linkedChatId,
    language: config.language,
    rules: config.rules,
    whitelist: config.whitelist,
    passThreshold: config.passThreshold,
    llmThreshold: config.llmThreshold,
    muteDurationMinutes: config.muteDurationMinutes,
  }
}

/**
 * `message_events` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 事件写入、摘录补写与保留期清理实现。
 */
function createMessageEventRepo(db: Db): MessageEventRepo {
  return {
    async insert(event): Promise<void> {
      await db
        .insert(messageEvents)
        .values({
          id: event.id,
          chatId: event.chatId,
          userId: event.userId,
          messageId: event.messageId,
          contentHash: event.contentHash,
          hasLink: event.features.hasLink,
          mediaType: event.features.mediaType,
          length: event.features.length,
          customEmojiCount: event.features.customEmojiCount,
          emojiCount: event.features.emojiCount,
          viaBot: event.features.viaBot,
          createdAt: event.createdAt,
        })
        .onConflictDoNothing({ target: messageEvents.id })
    },

    async findWithSample(eventId) {
      const rows = await db.select().from(messageEvents).where(eq(messageEvents.id, eventId)).limit(1)
      const row = rows[0]
      if (row === undefined) return null
      return { event: toMessageEvent(row), sampleText: row.sampleText }
    },

    async findSamples(eventIds) {
      // 空数组不发查询：`in ()` 在 SQL 里没有合法写法，直接给出空结果。
      if (eventIds.length === 0) return new Map()

      const rows = await db
        .select({ id: messageEvents.id, sampleText: messageEvents.sampleText })
        .from(messageEvents)
        .where(inArray(messageEvents.id, eventIds))
      return new Map(rows.map((row) => [row.id, row.sampleText]))
    },

    async attachSample(eventId, sampleText): Promise<void> {
      // 隐私口径写成 SQL 条件而不是调用方纪律：只有该事件存在非 pass 决策时才允许补写摘录。
      // 条件不满足时是静默无操作，因此写错顺序（先补摘录后落决策）不会泄漏放行消息的正文。
      await db
        .update(messageEvents)
        .set({ sampleText: truncateSampleText(sampleText) })
        .where(
          and(
            eq(messageEvents.id, eventId),
            exists(
              db
                .select({ id: moderationDecisions.id })
                .from(moderationDecisions)
                .where(and(eq(moderationDecisions.eventId, messageEvents.id), ne(moderationDecisions.action, 'pass'))),
            ),
          ),
        )
    },

    async deleteOlderThan(instant): Promise<number> {
      const deleted = await db.delete(messageEvents).where(lt(messageEvents.createdAt, instant)).returning({ id: messageEvents.id })
      return deleted.length
    },
  }
}

/**
 * `moderation_decisions` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 决策读写实现。
 */
function createDecisionRepo(db: Db): DecisionRepo {
  return {
    async insert(decision): Promise<void> {
      // 解禁时刻只在 mute 时存在，其余档位写 null：数据库的 CHECK 约束会挡住不一致的组合。
      const actionUntil = decision.action.kind === 'mute' ? decision.action.until : null
      await db
        .insert(moderationDecisions)
        .values({
          id: decision.id,
          eventId: decision.eventId,
          chatId: decision.chatId,
          userId: decision.userId,
          action: decision.action.kind,
          actionUntil,
          score: decision.score,
          signals: decision.signals,
          decidedAt: decision.decidedAt,
          executed: decision.executed,
        })
        .onConflictDoNothing({ target: moderationDecisions.id })
    },

    async findById(decisionId) {
      const rows = await db.select().from(moderationDecisions).where(eq(moderationDecisions.id, decisionId)).limit(1)
      const row = rows[0]
      return row === undefined ? null : toModerationDecision(row)
    },

    async markExecuted(decisionId): Promise<void> {
      await db.update(moderationDecisions).set({ executed: true }).where(eq(moderationDecisions.id, decisionId))
    },

    async listUnexecutedBetween(from, to, limit) {
      // 谓词是 (executed, decided_at)，现有索引都不覆盖它。未执行的决策是少数（正常路径当场执行并回填），
      // 加上 limit 与重试窗口，这个扫描在自用规模下不值得为它单加索引。
      const rows = await db
        .select()
        .from(moderationDecisions)
        .where(
          and(
            eq(moderationDecisions.executed, false),
            gte(moderationDecisions.decidedAt, from),
            lt(moderationDecisions.decidedAt, to),
          ),
        )
        .orderBy(asc(moderationDecisions.decidedAt))
        .limit(limit)
      return rows.map(toModerationDecision)
    },

    async listRecent(filter) {
      const conditions = []
      if (filter.chatId !== undefined) conditions.push(eq(moderationDecisions.chatId, filter.chatId))
      // 缺省 = 非放行；'all' = 不过滤；具体档位 = 精确匹配。
      if (filter.action === undefined) conditions.push(ne(moderationDecisions.action, 'pass'))
      else if (filter.action !== 'all') conditions.push(eq(moderationDecisions.action, filter.action))
      if (filter.before !== undefined) {
        const cursor = filter.before
        // 复合游标与排序键同形：先比时间，时间相同再比 id，保证同毫秒并列的记录不重不漏。
        conditions.push(
          or(
            lt(moderationDecisions.decidedAt, cursor.decidedAt),
            and(eq(moderationDecisions.decidedAt, cursor.decidedAt), lt(moderationDecisions.id, cursor.id)),
          ),
        )
      }

      const query = db.select().from(moderationDecisions)
      const filtered = conditions.length === 0 ? query : query.where(and(...conditions))
      const rows = await filtered
        .orderBy(desc(moderationDecisions.decidedAt), desc(moderationDecisions.id))
        .limit(filter.limit)
      return rows.map(toModerationDecision)
    },

    async countPriorViolations(chatId, userId, since): Promise<number> {
      const rows = await db
        .select({ total: count() })
        .from(moderationDecisions)
        .where(
          and(
            eq(moderationDecisions.chatId, chatId),
            eq(moderationDecisions.userId, userId),
            gte(moderationDecisions.decidedAt, since),
            ne(moderationDecisions.action, 'pass'),
          ),
        )
      return rows[0]?.total ?? 0
    },

    async markNoticeSent(decisionId, chatId, messageId): Promise<void> {
      // 无条件覆盖：同一条决策的通知引用只会有一个落点（私聊或群内二选一），重写是幂等的。
      await db
        .update(moderationDecisions)
        .set({ noticeChatId: chatId, noticeMessageId: messageId })
        .where(eq(moderationDecisions.id, decisionId))
    },

    async findNoticeRef(decisionId) {
      const rows = await db
        .select({
          noticeChatId: moderationDecisions.noticeChatId,
          noticeMessageId: moderationDecisions.noticeMessageId,
        })
        .from(moderationDecisions)
        .where(eq(moderationDecisions.id, decisionId))
        .limit(1)
      const row = rows[0]
      // 两列由同一次写入成对设置；只认两列都存在的记录（旧行两列都是 null）。
      if (row === undefined || row.noticeChatId === null || row.noticeMessageId === null) return null
      return { chatId: row.noticeChatId, messageId: row.noticeMessageId }
    },
  }
}

/**
 * `appeals` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 申诉读写实现。
 */
function createAppealRepo(db: Db): AppealRepo {
  return {
    async insert(appeal): Promise<void> {
      await db
        .insert(appeals)
        .values({
          id: appeal.id,
          decisionId: appeal.decisionId,
          userId: appeal.userId,
          state: appeal.state,
          note: appeal.note,
          createdAt: appeal.createdAt,
          resolvedAt: appeal.resolvedAt,
        })
        .onConflictDoNothing({ target: appeals.decisionId })
    },

    async findById(appealId) {
      const rows = await db.select().from(appeals).where(eq(appeals.id, appealId)).limit(1)
      const row = rows[0]
      return row === undefined ? null : toAppeal(row)
    },

    async findByDecisionId(decisionId) {
      const rows = await db.select().from(appeals).where(eq(appeals.decisionId, decisionId)).limit(1)
      const row = rows[0]
      return row === undefined ? null : toAppeal(row)
    },

    async resolve(appealId, state, resolvedAt, resolvedBy, rollbackPending): Promise<boolean> {
      // `state = 'open'` 是条件更新：并发重复点击只有一个调用会影响到行，其余得到 0 行。
      // rollback_pending 与状态同一条语句写入，结案与「待回滚」标记之间不留下不可见窗口。
      const updated = await db
        .update(appeals)
        .set({ state, resolvedAt, resolvedBy, rollbackPending })
        .where(and(eq(appeals.id, appealId), eq(appeals.state, 'open')))
        .returning({ id: appeals.id })
      return updated.length > 0
    },

    async clearRollbackPending(appealId): Promise<void> {
      // 无条件写 false：重复清除是幂等的，也不需要先读一次。
      await db.update(appeals).set({ rollbackPending: false }).where(eq(appeals.id, appealId))
    },

    async listPendingRollback(limit) {
      // `appeals_state_idx` 覆盖 state 条件；pending 只是少数残留，不值得再加部分索引。
      const rows = await db
        .select()
        .from(appeals)
        .where(and(eq(appeals.state, 'overturned'), eq(appeals.rollbackPending, true)))
        .orderBy(asc(appeals.resolvedAt))
        .limit(limit)
      return rows.map(toAppeal)
    },

    async listOverturnedSamples(chatId, since, limit) {
      // 一条 join 走完 appeals → decisions → events；事件经 decision.eventId 关联（两表无外键，
      // 但 eventId 由管线写入，值必然存在）。摘录列为 null 的行也要返回：白名单只看 hash。
      const rows = await db
        .select({
          userId: moderationDecisions.userId,
          contentHash: messageEvents.contentHash,
          sampleText: messageEvents.sampleText,
          resolvedAt: appeals.resolvedAt,
        })
        .from(appeals)
        .innerJoin(moderationDecisions, eq(appeals.decisionId, moderationDecisions.id))
        .innerJoin(messageEvents, eq(messageEvents.id, moderationDecisions.eventId))
        .where(
          and(
            eq(moderationDecisions.chatId, chatId),
            eq(appeals.state, 'overturned'),
            gte(appeals.resolvedAt, since),
          ),
        )
        // 同刻按 id 倒序兜底：样例顺序会进复核指纹，顺序必须确定（两实现同序）。
        .orderBy(desc(appeals.resolvedAt), desc(appeals.id))
        // limit 归一：负数与小数按 `max(0, trunc)` 处理，与内存实现同语义（PG 的 limit 负数会直接报错）。
        .limit(Math.max(0, Math.trunc(limit)))

      return rows.map((row) => ({
        userId: asUserId(row.userId),
        contentHash: row.contentHash,
        sampleText: row.sampleText,
        // `state='overturned'` 由 CHECK 保证 resolved_at 非空；类型上仍是可空的，兜到 epoch。
        resolvedAt: row.resolvedAt ?? new Date(0),
      }))
    },

    async listOpen(chatId) {
      // 申诉表没有 chat_id，按决策所属群过滤：innerJoin 而不是先查决策再逐条查申诉，避免 N+1。
      const rows = await db
        .select({ appeal: appeals })
        .from(appeals)
        .innerJoin(moderationDecisions, eq(appeals.decisionId, moderationDecisions.id))
        .where(and(eq(moderationDecisions.chatId, chatId), eq(appeals.state, 'open')))
        .orderBy(asc(appeals.createdAt))
      return rows.map((row) => toAppeal(row.appeal))
    },

    async listByStateWithDecision(state, limit) {
      // 单条 join 拿到申诉与它的决策：面板一次要一页，逐条回查决策就是 N+1。
      const joined = db
        .select({ appeal: appeals, decision: moderationDecisions })
        .from(appeals)
        .innerJoin(moderationDecisions, eq(appeals.decisionId, moderationDecisions.id))
      const filtered = state === null ? joined : joined.where(eq(appeals.state, state))
      const rows = await filtered.orderBy(desc(appeals.createdAt)).limit(limit)
      return rows.map((row) => ({ appeal: toAppeal(row.appeal), decision: toModerationDecision(row.decision) }))
    },

    async markNotified(appealId, notifiedAt): Promise<void> {
      // 无条件覆盖：重复回填同一个时刻是幂等的，不需要额外的条件。
      await db.update(appeals).set({ notifiedAt }).where(eq(appeals.id, appealId))
    },

    async listPendingNotification(limit) {
      // `appeals_state_idx` 覆盖 state 条件，未通知的 open 申诉在人工处理前一直留在结果里，靠 limit 收口。
      const rows = await db
        .select()
        .from(appeals)
        .where(and(eq(appeals.state, 'open'), isNull(appeals.notifiedAt)))
        .orderBy(asc(appeals.createdAt))
        .limit(limit)
      return rows.map(toAppeal)
    },
  }
}

/**
 * `subscriptions` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 订阅读写实现。
 */
function createSubscriptionRepo(db: Db): SubscriptionRepo {
  return {
    async insert(subscription): Promise<void> {
      await db
        .insert(subscriptions)
        .values({
          id: subscription.id,
          chatId: subscription.chatId,
          userId: subscription.userId,
          inviteLink: subscription.inviteLink,
          expiresAt: subscription.expiresAt,
          state: subscription.state,
        })
        .onConflictDoNothing({ target: subscriptions.inviteLink })
    },

    async revoke(subscriptionId): Promise<void> {
      await db.update(subscriptions).set({ state: 'revoked' }).where(eq(subscriptions.id, subscriptionId))
    },

    async listActive(chatId) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.chatId, chatId), eq(subscriptions.state, 'active')))
        .orderBy(asc(subscriptions.expiresAt))
      return rows.map(toSubscription)
    },

    async listExpiringBefore(instant) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.state, 'active'), lte(subscriptions.expiresAt, instant)))
        .orderBy(asc(subscriptions.expiresAt))
      return rows.map(toSubscription)
    },
  }
}

/** 链接操作占位的租约（与内存实现和 spec 的 60 秒对齐）。 */
const LINK_MUTATION_LEASE_SQL = sql`interval '60 seconds'`

/**
 * `subscription_links` 仓储。
 *
 * 条件写全部落在单条 UPDATE 上（无进程内互斥）：claim 与 finish 的 CAS 语义由 SQL 的 WHERE 保证，
 * 唯一键（幂等请求、非空链接）由数据库兜底。
 * 注意：唯一索引冲突的数据库错误可能回显 invite_link 的值，因此调用方日志只记受控码与 id。
 *
 * @param db drizzle 实例。
 * @returns 链接读写实现。
 */
function createSubscriptionLinkRepo(db: Db): SubscriptionLinkRepo {
  const findRowByRequestId = async (ownerUserId: number, requestId: string) => {
    const rows = await db
      .select()
      .from(subscriptionLinks)
      .where(and(eq(subscriptionLinks.ownerUserId, ownerUserId), eq(subscriptionLinks.requestId, requestId)))
      .limit(1)
    return rows[0] ?? null
  }

  return {
    async reserveCreate(input): Promise<ReserveCreateOutcome> {
      const inserted = await db
        .insert(subscriptionLinks)
        .values({
          id: input.id,
          chatId: input.chatId,
          ownerUserId: input.ownerUserId,
          requestId: input.requestId,
          requestHash: input.requestHash,
          name: input.name,
          priceStars: input.priceStars,
          periodSeconds: input.periodSeconds,
          inviteLink: null,
          state: 'creating',
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          revokedAt: null,
          version: 0,
          operationToken: null,
          operationKind: null,
          operationStartedAt: null,
        })
        .onConflictDoNothing({ target: [subscriptionLinks.ownerUserId, subscriptionLinks.requestId] })
        .returning()
      const row = inserted[0]
      if (row !== undefined) return { kind: 'reserved', link: toSubscriptionLink(row) }

      // 冲突：返回已存在的那一行（调用方据此走重放/冲突判定）。
      const existing = await findRowByRequestId(input.ownerUserId, input.requestId)
      if (existing === null) throw new Error('创建占位冲突但读不到原行')
      return { kind: 'existing', link: toSubscriptionLink(existing) }
    },

    async findByRequestId(ownerUserId, requestId) {
      const row = await findRowByRequestId(ownerUserId, requestId)
      return row === null ? null : toSubscriptionLink(row)
    },

    async finishCreate(id, result): Promise<boolean> {
      const rows = await db
        .update(subscriptionLinks)
        .set({
          state: 'active',
          inviteLink: result.inviteLink,
          version: sql`${subscriptionLinks.version} + 1`,
          updatedAt: result.finishedAt,
        })
        .where(and(eq(subscriptionLinks.id, id), inArray(subscriptionLinks.state, ['creating', 'create_unknown'])))
        .returning({ id: subscriptionLinks.id })
      return rows.length > 0
    },

    async markCreateOutcome(id, state, changedAt): Promise<void> {
      // 只从 creating 迁移；已完成请求不会被迟到的失败结果改写。
      await db
        .update(subscriptionLinks)
        .set({ state, updatedAt: changedAt })
        .where(and(eq(subscriptionLinks.id, id), eq(subscriptionLinks.state, 'creating')))
    },

    async findById(chatId, id) {
      const rows = await db
        .select()
        .from(subscriptionLinks)
        .where(and(eq(subscriptionLinks.chatId, chatId), eq(subscriptionLinks.id, id)))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : toSubscriptionLink(row)
    },

    async findByInviteLink(chatId, fullLink) {
      const rows = await db
        .select()
        .from(subscriptionLinks)
        .where(and(eq(subscriptionLinks.chatId, chatId), eq(subscriptionLinks.inviteLink, fullLink)))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : toSubscriptionLink(row)
    },

    async listPage({ chatId, before, limit }) {
      const conditions = [eq(subscriptionLinks.chatId, chatId)]
      if (before !== undefined) {
        // 严格元组上界，与 `ORDER BY created_at DESC, id DESC` 同形（同毫秒不漏不重）。
        conditions.push(
          or(
            lt(subscriptionLinks.createdAt, before.createdAt),
            and(eq(subscriptionLinks.createdAt, before.createdAt), lt(subscriptionLinks.id, before.id)),
          )!,
        )
      }
      const rows = await db
        .select()
        .from(subscriptionLinks)
        .where(and(...conditions))
        .orderBy(desc(subscriptionLinks.createdAt), desc(subscriptionLinks.id))
        .limit(limit)
      return rows.map(toSubscriptionLink)
    },

    async claimMutation(chatId, id, expectedVersion, kind, now): Promise<ClaimResult> {
      const token = crypto.randomUUID()
      const rows = await db
        .update(subscriptionLinks)
        .set({
          operationToken: token,
          operationKind: kind,
          operationStartedAt: now,
          version: sql`${subscriptionLinks.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptionLinks.chatId, chatId),
            eq(subscriptionLinks.id, id),
            eq(subscriptionLinks.state, 'active'),
            eq(subscriptionLinks.version, expectedVersion),
            // 无占位，或占位已过期（超过 60 秒可被替换）；NULL 比较为假，需显式 is null 分支。
            or(
              isNull(subscriptionLinks.operationToken),
              lt(sql`${subscriptionLinks.operationStartedAt}`, sql`${now}::timestamptz - ${LINK_MUTATION_LEASE_SQL}`),
            )!,
          ),
        )
        .returning()
      const claimedRow = rows[0]
      if (claimedRow !== undefined) return { kind: 'claimed', token, link: toSubscriptionLink(claimedRow) }

      // 未 claim 成功：读回区分 missing / revoked / 版本冲突 / 活跃占位。
      const existing = await db
        .select()
        .from(subscriptionLinks)
        .where(and(eq(subscriptionLinks.chatId, chatId), eq(subscriptionLinks.id, id)))
        .limit(1)
      const row = existing[0]
      if (row === undefined) return { kind: 'missing' }
      if (row.state === 'revoked') return { kind: 'revoked' }
      if (row.version !== expectedVersion) return { kind: 'conflict', reason: 'version' }
      return { kind: 'conflict', reason: 'in_progress' }
    },

    async finishMutation(id, operationToken, result: LinkMutationResult, finishedAt): Promise<boolean> {
      const rows = await db
        .update(subscriptionLinks)
        .set({
          ...(result.kind === 'renamed'
            ? { name: result.name }
            : { state: 'revoked' as const, revokedAt: result.revokedAt }),
          operationToken: null,
          operationKind: null,
          operationStartedAt: null,
          version: sql`${subscriptionLinks.version} + 1`,
          updatedAt: finishedAt,
        })
        // 终态不可复活：只有仍为 active 且持有同一 token 的提交才生效。
        .where(
          and(
            eq(subscriptionLinks.id, id),
            eq(subscriptionLinks.operationToken, operationToken),
            eq(subscriptionLinks.state, 'active'),
          ),
        )
        .returning({ id: subscriptionLinks.id })
      return rows.length > 0
    },

    async releaseMutation(id, operationToken): Promise<void> {
      await db
        .update(subscriptionLinks)
        .set({ operationToken: null, operationKind: null, operationStartedAt: null })
        .where(and(eq(subscriptionLinks.id, id), eq(subscriptionLinks.operationToken, operationToken)))
    },
  }
}

/**
 * `subscription_members` 仓储。
 *
 * 事件写入分两步（insert-on-conflict → 高水位条件 UPDATE），两步都在数据库层原子：
 * 已有行时只有 `(last_event_date, last_event_update_id)` 严格更新的写入才会生效；
 * `reconciledThrough` 所在秒及更旧的事件只推进高水位与 version，不改事实，避免覆盖在途对账。
 *
 * @param db drizzle 实例。
 * @returns 成员台账读写实现。
 */
function createSubscriptionMemberRepo(db: Db): SubscriptionMemberRepo {
  return {
    async find(chatId, userId) {
      const rows = await db
        .select()
        .from(subscriptionMembers)
        .where(and(eq(subscriptionMembers.chatId, chatId), eq(subscriptionMembers.userId, userId)))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : toSubscriptionMember(row)
    },

    async applyEvent(observation: MemberEventObservation): Promise<'inserted' | 'updated' | 'ignored'> {
      // 只有带肯定证据的事件才尝试插入：无证据（例如已跟踪成员的离开/升级）直接走下面的条件 UPDATE，
      // 不存在该行时 UPDATE 零行返回 ignored，不抛错（与内存实现一致）。
      if (observation.evidence !== null) {
        const inserted = await db
          .insert(subscriptionMembers)
          .values({
            id: crypto.randomUUID(),
            chatId: observation.chatId,
            userId: observation.userId,
            linkId: observation.linkId,
            state: observation.state,
            expiresAt: observation.expiresAt,
            evidence: observation.evidence,
            firstObservedAt: observation.observedAt,
            observedAt: observation.observedAt,
            observationSource: 'event',
            lastEventDate: observation.eventDate,
            lastEventUpdateId: observation.eventUpdateId,
            reconciledThrough: null,
            lastCheckedAt: null,
            lastCheckSucceededAt: null,
            lastCheckErrorCode: null,
            version: 0,
            checkToken: null,
            checkLeaseUntil: null,
          })
          .onConflictDoNothing({ target: [subscriptionMembers.chatId, subscriptionMembers.userId] })
          .returning({ id: subscriptionMembers.id })
        if (inserted[0] !== undefined) return 'inserted'
      }

      // 已存在：只有严格更新的事件能改事实；同秒或更旧的事件被忽略。
      const applyFacts = sql<boolean>`(${subscriptionMembers.reconciledThrough} is null or ${observation.eventDate}::bigint > floor(extract(epoch from ${subscriptionMembers.reconciledThrough})))`
      const updated = await db
        .update(subscriptionMembers)
        .set({
          state: sql`case when ${applyFacts} then ${observation.state}::text else ${subscriptionMembers.state} end`,
          expiresAt: sql`case when ${applyFacts} then ${observation.expiresAt}::timestamptz else ${subscriptionMembers.expiresAt} end`,
          observedAt: sql`case when ${applyFacts} then ${observation.observedAt}::timestamptz else ${subscriptionMembers.observedAt} end`,
          // 本次没有肯定证据时保留历史证据。
          evidence: sql`case when ${applyFacts} then coalesce(${observation.evidence}::text, ${subscriptionMembers.evidence}) else ${subscriptionMembers.evidence} end`,
          // 明确的新一轮加入：无匹配链接时置 null，不把旧来源当作本轮来源；否则保留/补全。
          linkId: sql`case when ${applyFacts} then (case when ${observation.isJoin} then ${observation.linkId}::uuid else coalesce(${observation.linkId}::uuid, ${subscriptionMembers.linkId}) end) else ${subscriptionMembers.linkId} end`,
          observationSource: sql`case when ${applyFacts} then 'event' else ${subscriptionMembers.observationSource} end`,
          lastEventDate: sql`${observation.eventDate}::bigint`,
          lastEventUpdateId: sql`${observation.eventUpdateId}::bigint`,
          version: sql`${subscriptionMembers.version} + 1`,
        })
        .where(
          and(
            eq(subscriptionMembers.chatId, observation.chatId),
            eq(subscriptionMembers.userId, observation.userId),
            or(
              isNull(subscriptionMembers.lastEventDate),
              sql`(${observation.eventDate}::bigint, ${observation.eventUpdateId}::bigint) > (${subscriptionMembers.lastEventDate}, ${subscriptionMembers.lastEventUpdateId})`,
            )!,
          ),
        )
        .returning({ id: subscriptionMembers.id })
      return updated.length > 0 ? 'updated' : 'ignored'
    },

    async listPage({ chatId, before, limit }) {
      const conditions = [eq(subscriptionMembers.chatId, chatId)]
      if (before !== undefined) {
        conditions.push(
          or(
            lt(subscriptionMembers.firstObservedAt, before.firstObservedAt),
            and(
              eq(subscriptionMembers.firstObservedAt, before.firstObservedAt),
              lt(subscriptionMembers.id, before.id),
            ),
          )!,
        )
      }
      const rows = await db
        .select()
        .from(subscriptionMembers)
        .where(and(...conditions))
        .orderBy(desc(subscriptionMembers.firstObservedAt), desc(subscriptionMembers.id))
        .limit(limit)
      return rows.map(toSubscriptionMember)
    },

    async countByState(chatId) {
      // SQL 侧聚合，不用有界列表长度冒充全量计数。
      const rows = await db
        .select({ state: subscriptionMembers.state, total: count() })
        .from(subscriptionMembers)
        .where(eq(subscriptionMembers.chatId, chatId))
        .groupBy(subscriptionMembers.state)

      let member = 0
      let left = 0
      let unknown = 0
      for (const row of rows) {
        if (row.state === 'member') member = Number(row.total)
        else if (row.state === 'left') left = Number(row.total)
        else if (row.state === 'unknown') unknown = Number(row.total)
      }
      return { known: member + left + unknown, member, left, unknown }
    },

    async claimChecks({ now, limit, leaseMs }): Promise<CheckClaim[]> {
      // 单条 UPDATE：子查询按公平顺序（last_checked_at NULLS FIRST, id）锁定可 claim 的行，
      // 行级 `gen_random_uuid()` 给每行独立 token；语句结束即提交，不跨后续 HTTP 持事务。
      // 租约与尝试时刻一律用数据库 `now()`（spec §4.2）：多实例部署时各自的进程时钟不参与裁决。
      const claimable = sql`
        select ${subscriptionMembers.id} from ${subscriptionMembers}
        where (${subscriptionMembers.checkLeaseUntil} is null or ${subscriptionMembers.checkLeaseUntil} <= now())
        order by ${subscriptionMembers.lastCheckedAt} asc nulls first, ${subscriptionMembers.id} asc
        limit ${limit}
        for update skip locked
      `
      const rows = await db
        .update(subscriptionMembers)
        .set({
          checkToken: sql`gen_random_uuid()`,
          checkLeaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
          lastCheckedAt: sql`now()`,
        })
        .where(sql`${subscriptionMembers.id} in (${claimable})`)
        .returning()
      return rows.map((row) => ({
        memberId: row.id,
        chatId: asChatId(row.chatId),
        userId: asUserId(row.userId),
        token: row.checkToken ?? '',
        version: row.version,
        // 查询开始时刻取数据库写入的 last_checked_at；假驱动等返回行缺列时退回调用方时间。
        requestStartedAt: row.lastCheckedAt ?? now,
      }))
    },

    async finishCheck(claim: CheckClaim, result: CheckResult): Promise<'applied' | 'stale'> {
      const cas = and(
        eq(subscriptionMembers.id, claim.memberId),
        eq(subscriptionMembers.checkToken, claim.token),
        eq(subscriptionMembers.version, claim.version),
      )

      if (result.kind === 'ok') {
        const rows = await db
          .update(subscriptionMembers)
          .set({
            state: result.state,
            expiresAt: result.expiresAt,
            // 成功查询以查询开始时刻为观测时刻，并推进对账水位。
            observedAt: claim.requestStartedAt,
            observationSource: 'reconcile',
            reconciledThrough: claim.requestStartedAt,
            lastCheckSucceededAt: result.returnedAt,
            lastCheckErrorCode: null,
            checkToken: null,
            checkLeaseUntil: null,
            version: sql`${subscriptionMembers.version} + 1`,
          })
          .where(cas)
          .returning({ id: subscriptionMembers.id })
        return rows.length > 0 ? 'applied' : 'stale'
      }

      // 失败不改成员事实：只写受控错误码并释放租约（尝试时刻已在 claim 时推进）。
      const rows = await db
        .update(subscriptionMembers)
        .set({ lastCheckErrorCode: result.errorCode, checkToken: null, checkLeaseUntil: null })
        .where(cas)
        .returning({ id: subscriptionMembers.id })
      return rows.length > 0 ? 'applied' : 'stale'
    },
  }
}

/**
 * `daily_aggregates` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 日聚合读写实现。
 */
function createAggregateRepo(db: Db): AggregateRepo {
  return {
    async upsert(aggregate): Promise<void> {
      await db
        .insert(dailyAggregates)
        .values(aggregate)
        .onConflictDoUpdate({
          target: [dailyAggregates.chatId, dailyAggregates.date],
          set: {
            messageCount: aggregate.messageCount,
            actionCount: aggregate.actionCount,
            appealCount: aggregate.appealCount,
            overturnedCount: aggregate.overturnedCount,
          },
        })
    },

    async listRange(chatId, from, to) {
      const rows = await db
        .select()
        .from(dailyAggregates)
        .where(and(eq(dailyAggregates.chatId, chatId), gte(dailyAggregates.date, from), lte(dailyAggregates.date, to)))
        .orderBy(asc(dailyAggregates.date))
      return rows.map(toDailyAggregate)
    },

    async countForDay(chatId: ChatId, from: Date, to: Date): Promise<DailyCounts> {
      // 一条语句里四个标量子查询：调度器每次重算都要跑一遍，拆成四条会多三次往返，
      // 而这里没有事务语义，单语句读到的是一致快照。计数走 (chat_id, created_at) 一类索引，
      // appeals 侧经 decision_id 关联到决策再按 chat_id 过滤。
      // 计数一律 cast 成 int4：int8 的驱动解析结果依赖连接层配置，不赌它的默认值。
      const rows = await db.execute<{
        message_count: number
        action_count: number
        appeal_count: number
        overturned_count: number
      }>(sql`
        select
          (select count(*)::int from ${messageEvents}
            where ${messageEvents.chatId} = ${chatId}
              and ${messageEvents.createdAt} >= ${from}
              and ${messageEvents.createdAt} < ${to}) as message_count,
          (select count(*)::int from ${moderationDecisions}
            where ${moderationDecisions.chatId} = ${chatId}
              and ${moderationDecisions.decidedAt} >= ${from}
              and ${moderationDecisions.decidedAt} < ${to}
              and ${moderationDecisions.action} <> 'pass') as action_count,
          (select count(*)::int from ${appeals}
            join ${moderationDecisions} on ${moderationDecisions.id} = ${appeals.decisionId}
            where ${moderationDecisions.chatId} = ${chatId}
              and ${appeals.createdAt} >= ${from}
              and ${appeals.createdAt} < ${to}) as appeal_count,
          (select count(*)::int from ${appeals}
            join ${moderationDecisions} on ${moderationDecisions.id} = ${appeals.decisionId}
            where ${moderationDecisions.chatId} = ${chatId}
              and ${appeals.state} = 'overturned'
              and ${appeals.resolvedAt} >= ${from}
              and ${appeals.resolvedAt} < ${to}) as overturned_count
      `)

      const row = rows[0]
      if (row === undefined) return { messageCount: 0, actionCount: 0, appealCount: 0, overturnedCount: 0 }
      return {
        messageCount: row.message_count,
        actionCount: row.action_count,
        appealCount: row.appeal_count,
        overturnedCount: row.overturned_count,
      }
    },
  }
}

/**
 * `llm_cache` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 复核缓存读写与清理实现。
 */
function createLlmCacheRepo(db: Db): LlmCacheRepo {
  return {
    async get(contentHash) {
      const rows = await db.select().from(llmCache).where(eq(llmCache.contentHash, contentHash)).limit(1)
      return rows[0] ?? null
    },

    async put(entry): Promise<void> {
      // 保留先写入的结论：同一段文本的判定要稳定，否则同一条消息在两次调用间可能得到不同处置。
      await db.insert(llmCache).values(entry).onConflictDoNothing({ target: llmCache.contentHash })
    },

    async deleteOlderThan(instant): Promise<number> {
      const deleted = await db.delete(llmCache).where(lt(llmCache.createdAt, instant)).returning({ contentHash: llmCache.contentHash })
      return deleted.length
    },
  }
}
