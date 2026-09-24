import type {
  Appeal,
  AppealState,
  ChatConfig,
  ChatId,
  DailyAggregate,
  MessageEvent,
  ModerationDecision,
  Subscription,
  UserId,
} from '@skitarii/core'
import type { DailyCounts, Repos } from './repos.js'
import { truncateSampleText } from './mapping.js'
import type { LlmCacheEntry, LlmCacheInsert } from './schema.js'

/**
 * 内存仓储。
 *
 * 用途：单元测试与本地跑批（见 `repos.ts` 对「测试与本地跑批可以换成内存实现」的约定）。
 * PG 实现（`createPgRepos`）才是运行时权威，
 * 特别是「摘录只在存在非 pass 决策时写入」「申诉按 decision_id 唯一」这类不变量在那边由 DDL 与 SQL 保证，
 * 这里只做行为等价的近似，供不依赖真实数据库的测试使用。
 *
 * 时间戳一律用调用方传入的值，不做 `Date.now()` 兜底：测试要能完全控制时间轴。
 */

/** 内存仓储的附加观察口，仅测试使用。 */
export interface InMemoryRepos {
  repos: Repos
  /** 读取某条申诉的结案人（领域类型里没有这个字段，PG 里是 `appeals.resolved_by` 列）。 */
  resolvedByOf(appealId: string): UserId | null
  /** 读取某条申诉的 owner 通知时刻（对应 PG 的 `appeals.notified_at`）。 */
  notifiedAtOf(appealId: string): Date | null
  /** 直接读取某条事件的摘录，绕过领域类型的裁剪。 */
  sampleOf(eventId: string): string | null
}

/**
 * 建立内存仓储。
 *
 * @returns 内存仓储与两个观察口。
 */
export function createInMemoryRepos(): InMemoryRepos {
  const chats = new Map<string, ChatConfig>()
  const events = new Map<string, { event: MessageEvent; sampleText: string | null }>()
  const decisions = new Map<string, ModerationDecision>()
  const appeals = new Map<string, Appeal>()
  const resolvedBy = new Map<string, UserId>()
  const notifiedAtBy = new Map<string, Date>()
  /** 撤销结案后权限尚未回滚的申诉 id。PG 里是 `appeals.rollback_pending` 列，这里旁存。 */
  const rollbackPendingIds = new Set<string>()
  const subscriptions = new Map<string, Subscription>()
  const aggregates = new Map<string, DailyAggregate>()
  const cache = new Map<string, LlmCacheEntry>()

  /** 聚合键：群 + 日期。 */
  const aggregateKey = (chatId: string, date: string): string => `${chatId}|${date}`

  const repos: Repos = {
    chats: {
      async upsert(config: ChatConfig): Promise<void> {
        chats.set(config.chatId, config)
      },
      async findByChatId(chatId: ChatId): Promise<ChatConfig | null> {
        return chats.get(chatId) ?? null
      },
      async listAll(): Promise<ChatConfig[]> {
        return [...chats.values()]
      },
    },

    events: {
      async insert(event: MessageEvent): Promise<void> {
        if (events.has(event.id)) return
        events.set(event.id, { event, sampleText: null })
      },
      async findWithSample(eventId: string) {
        const stored = events.get(eventId)
        return stored === undefined ? null : { event: stored.event, sampleText: stored.sampleText }
      },
      async findSamples(eventIds: string[]): Promise<Map<string, string | null>> {
        const samples = new Map<string, string | null>()
        for (const eventId of eventIds) {
          const stored = events.get(eventId)
          if (stored !== undefined) samples.set(eventId, stored.sampleText)
        }
        return samples
      },
      async attachSample(eventId: string, sampleText: string): Promise<void> {
        const stored = events.get(eventId)
        if (stored === undefined) return
        // 与 PG 版一致：只有存在非 pass 决策时才允许留摘录。
        const hasNonPassDecision = [...decisions.values()].some(
          (decision) => decision.eventId === eventId && decision.action.kind !== 'pass',
        )
        if (!hasNonPassDecision) return
        stored.sampleText = truncateSampleText(sampleText)
      },
      async deleteOlderThan(instant: Date): Promise<number> {
        let removed = 0
        for (const [id, stored] of events) {
          if (stored.event.createdAt < instant) {
            events.delete(id)
            removed += 1
          }
        }
        return removed
      },
    },

    decisions: {
      async insert(decision: ModerationDecision): Promise<void> {
        if (decisions.has(decision.id)) return
        decisions.set(decision.id, decision)
      },
      async findById(decisionId: string): Promise<ModerationDecision | null> {
        return decisions.get(decisionId) ?? null
      },
      async markExecuted(decisionId: string): Promise<void> {
        const stored = decisions.get(decisionId)
        if (stored !== undefined) decisions.set(decisionId, { ...stored, executed: true })
      },
      async listUnexecutedBetween(from: Date, to: Date, limit: number): Promise<ModerationDecision[]> {
        return [...decisions.values()]
          .filter(
            (decision) =>
              !decision.executed && decision.decidedAt >= from && decision.decidedAt < to,
          )
          .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime())
          .slice(0, limit)
      },
      async listRecent(filter): Promise<ModerationDecision[]> {
        return [...decisions.values()]
          .filter((decision) => {
            if (filter.chatId !== undefined && decision.chatId !== filter.chatId) return false
            // 缺省 = 非放行；'all' = 不过滤；具体档位 = 精确匹配。
            if (filter.action === undefined) {
              if (decision.action.kind === 'pass') return false
            } else if (filter.action !== 'all' && decision.action.kind !== filter.action) {
              return false
            }
            if (filter.before !== undefined && !isBeforeCursor(decision, filter.before)) return false
            return true
          })
          .sort(compareRecentDesc)
          .slice(0, filter.limit)
      },
      async countPriorViolations(chatId: ChatId, userId: UserId, since: Date): Promise<number> {
        return [...decisions.values()].filter(
          (decision) =>
            decision.chatId === chatId &&
            decision.userId === userId &&
            decision.decidedAt >= since &&
            decision.action.kind !== 'pass',
        ).length
      },
    },

    appeals: {
      async insert(appeal: Appeal): Promise<void> {
        if ([...appeals.values()].some((existing) => existing.decisionId === appeal.decisionId)) return
        appeals.set(appeal.id, appeal)
      },
      async findById(appealId: string): Promise<Appeal | null> {
        return appeals.get(appealId) ?? null
      },
      async findByDecisionId(decisionId: string): Promise<Appeal | null> {
        return [...appeals.values()].find((appeal) => appeal.decisionId === decisionId) ?? null
      },
      async resolve(
        appealId: string,
        state: Exclude<AppealState, 'open'>,
        resolvedAt: Date,
        by: UserId,
        rollbackPending: boolean,
      ): Promise<boolean> {
        const stored = appeals.get(appealId)
        if (stored === undefined || stored.state !== 'open') return false
        appeals.set(appealId, { ...stored, state, resolvedAt })
        resolvedBy.set(appealId, by)
        // 「待回滚」标记旁存：领域类型不承载运维标记，与 resolvedBy / notifiedAt 同一先例。
        if (rollbackPending) rollbackPendingIds.add(appealId)
        else rollbackPendingIds.delete(appealId)
        return true
      },
      async clearRollbackPending(appealId: string): Promise<void> {
        rollbackPendingIds.delete(appealId)
      },
      async listPendingRollback(limit: number): Promise<Appeal[]> {
        return [...appeals.values()]
          .filter((appeal) => appeal.state === 'overturned' && rollbackPendingIds.has(appeal.id))
          .sort((a, b) => (a.resolvedAt?.getTime() ?? 0) - (b.resolvedAt?.getTime() ?? 0))
          .slice(0, limit)
      },
      async listOpen(chatId: ChatId): Promise<Appeal[]> {
        return [...appeals.values()]
          .filter((appeal) => appeal.state === 'open' && decisions.get(appeal.decisionId)?.chatId === chatId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      },
      async listByStateWithDecision(state, limit) {
        return [...appeals.values()]
          .filter((appeal) => state === null || appeal.state === state)
          .flatMap((appeal) => {
            const decision = decisions.get(appeal.decisionId)
            return decision === undefined ? [] : [{ appeal, decision }]
          })
          .sort((a, b) => b.appeal.createdAt.getTime() - a.appeal.createdAt.getTime())
          .slice(0, limit)
      },
      async markNotified(appealId: string, notifiedAt: Date): Promise<void> {
        if (appeals.has(appealId)) notifiedAtBy.set(appealId, notifiedAt)
      },
      async listPendingNotification(limit: number): Promise<Appeal[]> {
        return [...appeals.values()]
          .filter((appeal) => appeal.state === 'open' && !notifiedAtBy.has(appeal.id))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
      },
    },

    subscriptions: {
      async insert(subscription: Subscription): Promise<void> {
        subscriptions.set(subscription.id, subscription)
      },
      async revoke(subscriptionId: string): Promise<void> {
        const stored = subscriptions.get(subscriptionId)
        if (stored !== undefined) subscriptions.set(subscriptionId, { ...stored, state: 'revoked' })
      },
      async listActive(chatId: ChatId): Promise<Subscription[]> {
        return [...subscriptions.values()].filter(
          (subscription) => subscription.chatId === chatId && subscription.state === 'active',
        )
      },
      async listExpiringBefore(instant: Date): Promise<Subscription[]> {
        return [...subscriptions.values()].filter(
          (subscription) => subscription.state === 'active' && subscription.expiresAt <= instant,
        )
      },
    },

    aggregates: {
      async upsert(aggregate: DailyAggregate): Promise<void> {
        aggregates.set(aggregateKey(aggregate.chatId, aggregate.date), aggregate)
      },
      async listRange(chatId: ChatId, from: string, to: string): Promise<DailyAggregate[]> {
        return [...aggregates.values()]
          .filter((row) => row.chatId === chatId && row.date >= from && row.date <= to)
          .sort((a, b) => a.date.localeCompare(b.date))
      },
      async countForDay(chatId: ChatId, from: Date, to: Date): Promise<DailyCounts> {
        const decisionsInWindow = [...decisions.values()].filter(
          (decision) => decision.chatId === chatId && decision.decidedAt >= from && decision.decidedAt < to,
        )
        const appealsInWindow = [...appeals.values()].filter((appeal) => {
          if (decisions.get(appeal.decisionId)?.chatId !== chatId) return false
          return appeal.createdAt >= from && appeal.createdAt < to
        })
        const overturnedInWindow = [...appeals.values()].filter((appeal) => {
          if (decisions.get(appeal.decisionId)?.chatId !== chatId) return false
          if (appeal.state !== 'overturned' || appeal.resolvedAt === null) return false
          return appeal.resolvedAt >= from && appeal.resolvedAt < to
        })

        return {
          messageCount: [...events.values()].filter(
            (stored) => stored.event.chatId === chatId && stored.event.createdAt >= from && stored.event.createdAt < to,
          ).length,
          actionCount: decisionsInWindow.filter((decision) => decision.action.kind !== 'pass').length,
          appealCount: appealsInWindow.length,
          overturnedCount: overturnedInWindow.length,
        }
      },
    },

    llmCache: {
      async get(contentHash: string): Promise<LlmCacheEntry | null> {
        return cache.get(contentHash) ?? null
      },
      async put(entry: LlmCacheInsert): Promise<void> {
        if (cache.has(entry.contentHash)) return
        cache.set(entry.contentHash, { ...entry, createdAt: entry.createdAt ?? new Date(0) })
      },
      async deleteOlderThan(instant: Date): Promise<number> {
        let removed = 0
        for (const [hash, entry] of cache) {
          if (entry.createdAt < instant) {
            cache.delete(hash)
            removed += 1
          }
        }
        return removed
      },
    },
  }

  return {
    repos,
    resolvedByOf: (appealId) => resolvedBy.get(appealId) ?? null,
    notifiedAtOf: (appealId) => notifiedAtBy.get(appealId) ?? null,
    sampleOf: (eventId) => events.get(eventId)?.sampleText ?? null,
  }
}

/**
 * 与 SQL 的 `ORDER BY decided_at DESC, id DESC` 同序。
 *
 * uuid 都是小写十六进制加固定位置的连字符，字符串比较即字节序比较，因此 JS 侧不需要额外规范化。
 *
 * @param a 左记录。
 * @param b 右记录。
 * @returns 排序比较值。
 */
function compareRecentDesc(a: ModerationDecision, b: ModerationDecision): number {
  const byTime = b.decidedAt.getTime() - a.decidedAt.getTime()
  if (byTime !== 0) return byTime
  if (a.id === b.id) return 0
  return a.id > b.id ? -1 : 1
}

/**
 * 判断记录是否严格排在复合游标 `(decidedAt, id)` 之前。
 *
 * @param decision 记录。
 * @param cursor 游标。
 * @returns 时间更早，或时间相同但 id 更小时为 `true`。
 */
function isBeforeCursor(decision: ModerationDecision, cursor: { decidedAt: Date; id: string }): boolean {
  const byTime = decision.decidedAt.getTime() - cursor.decidedAt.getTime()
  if (byTime !== 0) return byTime < 0
  return decision.id < cursor.id
}
