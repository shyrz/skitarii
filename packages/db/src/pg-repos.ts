import { and, asc, count, eq, exists, gte, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import type { ChatConfig, ChatId } from '@skitarii/core'
import type { Db } from './client.js'
import {
  toAppeal,
  toChatConfig,
  toDailyAggregate,
  toMessageEvent,
  toModerationDecision,
  toSubscription,
  truncateSampleText,
} from './mapping.js'
import type { AggregateRepo, AppealRepo, ChatRepo, DailyCounts, DecisionRepo, LlmCacheRepo, MessageEventRepo, Repos, SubscriptionRepo } from './repos.js'
import {
  appeals,
  chats,
  dailyAggregates,
  llmCache,
  messageEvents,
  moderationDecisions,
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
    aggregates: createAggregateRepo(db),
    llmCache: createLlmCacheRepo(db),
  }
}

/**
 * `chats` 仓储。
 *
 * @param db drizzle 实例。
 * @returns 群配置读写实现。
 */
function createChatRepo(db: Db): ChatRepo {
  return {
    async upsert(config): Promise<void> {
      await db
        .insert(chats)
        .values({
          chatId: config.chatId,
          title: config.title,
          language: config.language,
          rules: config.rules,
          passThreshold: config.passThreshold,
          llmThreshold: config.llmThreshold,
          muteDurationMinutes: config.muteDurationMinutes,
        })
        .onConflictDoUpdate({
          target: chats.chatId,
          set: {
            title: config.title,
            language: config.language,
            rules: config.rules,
            passThreshold: config.passThreshold,
            llmThreshold: config.llmThreshold,
            muteDurationMinutes: config.muteDurationMinutes,
            updatedAt: new Date(),
          },
        })
    },

    async findByChatId(chatId): Promise<ChatConfig | null> {
      const rows = await db.select().from(chats).where(eq(chats.chatId, chatId)).limit(1)
      const row = rows[0]
      return row === undefined ? null : toChatConfig(row)
    },

    async listAll() {
      const rows = await db.select().from(chats).orderBy(asc(chats.chatId))
      return rows.map(toChatConfig)
    },
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

    async resolve(appealId, state, resolvedAt, resolvedBy): Promise<boolean> {
      // `state = 'open'` 是条件更新：并发重复点击只有一个调用会影响到行，其余得到 0 行。
      const updated = await db
        .update(appeals)
        .set({ state, resolvedAt, resolvedBy })
        .where(and(eq(appeals.id, appealId), eq(appeals.state, 'open')))
        .returning({ id: appeals.id })
      return updated.length > 0
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
