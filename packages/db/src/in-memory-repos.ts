import type {
  Appeal,
  AppealState,
  ChatConfig,
  ChatId,
  DailyAggregate,
  MessageEvent,
  ModerationDecision,
  Subscription,
  SubscriptionLink,
  SubscriptionMember,
  UserId,
} from '@skitarii/core'
import type { CheckClaim, ClaimResult, DailyCounts, MemberEventObservation, Repos, ReserveCreateOutcome } from './repos.js'
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
  /** 处置通知的落点（decisionId → 目标 + 消息 id）。PG 里是 `moderation_decisions.notice_*` 列，这里旁存。 */
  const noticeRefs = new Map<string, { chatId: string; messageId: number }>()
  const subscriptions = new Map<string, Subscription>()
  const subscriptionLinks = new Map<string, SubscriptionLink>()
  const subscriptionMembers = new Map<string, SubscriptionMember>()
  const aggregates = new Map<string, DailyAggregate>()
  const cache = new Map<string, LlmCacheEntry>()

  /** 聚合键：群 + 日期。 */
  const aggregateKey = (chatId: string, date: string): string => `${chatId}|${date}`

  /** 成员台账键：群 + 用户。 */
  const memberKey = (chatId: string, userId: number): string => `${chatId}|${userId}`

  /** 按幂等键读链接；`reserveCreate` 与仓储方法共用同一实现。 */
  const findLinkByRequestId = (ownerUserId: UserId, requestId: string): SubscriptionLink | null =>
    [...subscriptionLinks.values()].find(
      (link) => link.ownerUserId === ownerUserId && link.requestId === requestId,
    ) ?? null

  const repos: Repos = {
    chats: {
      async upsert(config: ChatConfig): Promise<void> {
        chats.set(config.chatId, config)
      },
      async register(config: ChatConfig): Promise<void> {
        // 与 PG 的 `on conflict do nothing` 对齐：已存在时保留库里那份，绝不用默认配置覆盖。
        if (chats.has(config.chatId)) return
        chats.set(config.chatId, config)
      },
      async findByChatId(chatId: ChatId): Promise<ChatConfig | null> {
        return chats.get(chatId) ?? null
      },
      async updateMetadata(chatId: ChatId, patch): Promise<void> {
        const stored = chats.get(chatId)
        if (stored === undefined) return
        // 与 PG 的单列 UPDATE 对齐：只覆盖 patch 里出现的字段，规则与阈值原样保留。
        chats.set(chatId, {
          ...stored,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.chatType !== undefined ? { chatType: patch.chatType } : {}),
          ...(patch.linkedChatId !== undefined ? { linkedChatId: patch.linkedChatId } : {}),
        })
      },
      async updateRulesConfig(chatId: ChatId, patch): Promise<void> {
        const stored = chats.get(chatId)
        if (stored === undefined) return
        // 与 PG 的单列 UPDATE 对齐：只覆盖规则与阈值，元数据与语言保持库里的值。
        chats.set(chatId, {
          ...stored,
          rules: patch.rules,
          passThreshold: patch.passThreshold,
          llmThreshold: patch.llmThreshold,
          muteDurationMinutes: patch.muteDurationMinutes,
        })
      },
      async listAll(): Promise<ChatConfig[]> {
        return [...chats.values()]
      },
      async listChannelsPage({ afterChatId, limit }): Promise<ChatConfig[]> {
        // 与 PG 的 `chat_type = 'channel' AND chat_id > $1 ORDER BY chat_id` 同序。
        return [...chats.values()]
          .filter((config) => config.chatType === 'channel')
          .filter((config) => afterChatId === undefined || config.chatId > afterChatId)
          .sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0))
          .slice(0, Math.max(0, Math.trunc(limit)))
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
      async markNoticeSent(decisionId: string, chatId: string, messageId: number): Promise<void> {
        // 与 PG 的 `UPDATE ... WHERE id = $1` 对齐：决策不存在时静默不写入。
        if (!decisions.has(decisionId)) return
        noticeRefs.set(decisionId, { chatId, messageId })
      },
      async findNoticeRef(decisionId: string): Promise<{ chatId: string; messageId: number } | null> {
        return noticeRefs.get(decisionId) ?? null
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
      async listOverturnedSamples(chatId, since, limit) {
        return [...appeals.values()]
          .filter(
            (appeal) =>
              appeal.state === 'overturned' && appeal.resolvedAt !== null && appeal.resolvedAt >= since,
          )
          // 同刻按 id 倒序兜底：与 PG 的 `ORDER BY resolved_at DESC, id DESC` 同序。
          .sort(
            (a, b) =>
              (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0) ||
              (a.id === b.id ? 0 : a.id > b.id ? -1 : 1),
          )
          .flatMap((appeal) => {
            const decision = decisions.get(appeal.decisionId)
            if (decision === undefined || decision.chatId !== chatId) return []
            const stored = events.get(decision.eventId)
            if (stored === undefined) return []
            return [
              {
                userId: decision.userId,
                contentHash: stored.event.contentHash,
                sampleText: stored.sampleText,
                // filter 已保证非空；`??` 只是让类型收窄，与 PG 的兜底一致。
                resolvedAt: appeal.resolvedAt ?? new Date(0),
              },
            ]
          })
          // limit 归一：负数与小数按 `max(0, trunc)` 处理（`slice(0, -1)` 会意外丢掉末尾一条）。
          .slice(0, Math.max(0, Math.trunc(limit)))
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

    subscriptionLinks: {
      async reserveCreate(input): Promise<ReserveCreateOutcome> {
        // 与 PG 的 `on conflict (owner_user_id, request_id) do nothing + 返回原行` 对齐。
        const existing = findLinkByRequestId(input.ownerUserId, input.requestId)
        if (existing !== null) return { kind: 'existing', link: existing }

        const link: SubscriptionLink = {
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
        }
        subscriptionLinks.set(link.id, link)
        return { kind: 'reserved', link }
      },
      async findByRequestId(ownerUserId: UserId, requestId: string): Promise<SubscriptionLink | null> {
        return findLinkByRequestId(ownerUserId, requestId)
      },
      async finishCreate(id: string, result): Promise<boolean> {
        const stored = subscriptionLinks.get(id)
        if (stored === undefined) return false
        if (stored.state !== 'creating' && stored.state !== 'create_unknown') return false
        subscriptionLinks.set(id, {
          ...stored,
          state: 'active',
          inviteLink: result.inviteLink,
          version: stored.version + 1,
          updatedAt: result.finishedAt,
        })
        return true
      },
      async markCreateOutcome(id: string, state: 'create_unknown' | 'create_failed', changedAt: Date): Promise<void> {
        const stored = subscriptionLinks.get(id)
        // 只从 creating 迁移：已完成的请求不会被迟到的失败结果改写。
        if (stored === undefined || stored.state !== 'creating') return
        subscriptionLinks.set(id, { ...stored, state, updatedAt: changedAt })
      },
      async findById(chatId: ChatId, id: string): Promise<SubscriptionLink | null> {
        const stored = subscriptionLinks.get(id)
        return stored !== undefined && stored.chatId === chatId ? stored : null
      },
      async findByInviteLink(chatId: ChatId, fullLink: string): Promise<SubscriptionLink | null> {
        return (
          [...subscriptionLinks.values()].find(
            (link) => link.chatId === chatId && link.inviteLink !== null && link.inviteLink === fullLink,
          ) ?? null
        )
      },
      async listPage({ chatId, before, limit }): Promise<SubscriptionLink[]> {
        return [...subscriptionLinks.values()]
          .filter((link) => link.chatId === chatId)
          .filter((link) => before === undefined || isBeforeTuple(link.createdAt, link.id, before.createdAt, before.id))
          .sort((a, b) => compareDesc(a.createdAt, a.id, b.createdAt, b.id))
          .slice(0, Math.max(0, Math.trunc(limit)))
      },
      async claimMutation(chatId, id, expectedVersion, kind, now): Promise<ClaimResult> {
        const stored = subscriptionLinks.get(id)
        if (stored === undefined || stored.chatId !== chatId) return { kind: 'missing' }
        if (stored.state === 'revoked') return { kind: 'revoked' }
        if (stored.state !== 'active') return { kind: 'conflict', reason: 'version' }
        if (stored.version !== expectedVersion) return { kind: 'conflict', reason: 'version' }
        if (
          stored.operationToken !== null &&
          stored.operationStartedAt !== null &&
          now.getTime() - stored.operationStartedAt.getTime() < MUTATION_LEASE_MS
        ) {
          return { kind: 'conflict', reason: 'in_progress' }
        }

        const token = crypto.randomUUID()
        const next: SubscriptionLink = {
          ...stored,
          operationToken: token,
          operationKind: kind,
          operationStartedAt: now,
          version: stored.version + 1,
          updatedAt: now,
        }
        subscriptionLinks.set(id, next)
        return { kind: 'claimed', token, link: next }
      },
      async finishMutation(id, operationToken, result, finishedAt): Promise<boolean> {
        const stored = subscriptionLinks.get(id)
        // 终态不可复活：revoked 行不再接受任何提交；token 不匹配的迟到结果同样作废。
        if (stored === undefined || stored.operationToken !== operationToken || stored.state !== 'active') return false

        const next: SubscriptionLink =
          result.kind === 'renamed'
            ? { ...stored, name: result.name }
            : { ...stored, state: 'revoked', revokedAt: result.revokedAt }
        subscriptionLinks.set(id, {
          ...next,
          operationToken: null,
          operationKind: null,
          operationStartedAt: null,
          version: stored.version + 1,
          updatedAt: finishedAt,
        })
        return true
      },
      async releaseMutation(id, operationToken): Promise<void> {
        const stored = subscriptionLinks.get(id)
        if (stored === undefined || stored.operationToken !== operationToken) return
        subscriptionLinks.set(id, { ...stored, operationToken: null, operationKind: null, operationStartedAt: null })
      },
    },

    subscriptionMembers: {
      async find(chatId: ChatId, userId: UserId): Promise<SubscriptionMember | null> {
        return subscriptionMembers.get(memberKey(chatId, userId)) ?? null
      },
      async applyEvent(observation): Promise<'inserted' | 'updated' | 'ignored'> {
        const key = memberKey(observation.chatId, observation.userId)
        const stored = subscriptionMembers.get(key)

        if (stored === undefined) {
          // 无肯定证据的事件不插入新行：资格判定在事件记录器；这里返回 ignored 而不是抛错，
          // 与 PG 实现（跳过 INSERT、条件 UPDATE 零行）语义一致。
          if (observation.evidence === null) return 'ignored'
          const inserted: SubscriptionMember = {
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
          }
          subscriptionMembers.set(key, inserted)
          return 'inserted'
        }

        // 高水位：更旧或相等重复的事件不覆盖事实。
        if (!isNewerEvent(observation, stored)) return 'ignored'

        // 迟到事件（所在秒不晚于成功对账开始秒）只推进高水位与 version，不改事实。
        const applyFacts = isNewerThanReconcile(observation.eventDate, stored.reconciledThrough)
        const next: SubscriptionMember = applyFacts
          ? {
              ...stored,
              state: observation.state,
              expiresAt: observation.expiresAt,
              observedAt: observation.observedAt,
              evidence: observation.evidence ?? stored.evidence,
              linkId: observation.isJoin
                ? observation.linkId
                : (observation.linkId ?? stored.linkId),
              observationSource: 'event',
            }
          : stored
        subscriptionMembers.set(key, {
          ...next,
          lastEventDate: observation.eventDate,
          lastEventUpdateId: observation.eventUpdateId,
          version: stored.version + 1,
        })
        return 'updated'
      },
      async listPage({ chatId, before, limit }): Promise<SubscriptionMember[]> {
        return [...subscriptionMembers.values()]
          .filter((member) => member.chatId === chatId)
          .filter(
            (member) =>
              before === undefined ||
              isBeforeTuple(member.firstObservedAt, member.id, before.firstObservedAt, before.id),
          )
          .sort((a, b) => compareDesc(a.firstObservedAt, a.id, b.firstObservedAt, b.id))
          .slice(0, Math.max(0, Math.trunc(limit)))
      },
      async countByState(chatId: ChatId) {
        const rows = [...subscriptionMembers.values()].filter((member) => member.chatId === chatId)
        const countOf = (state: SubscriptionMember['state']): number =>
          rows.filter((member) => member.state === state).length
        const member = countOf('member')
        const left = countOf('left')
        const unknown = countOf('unknown')
        return { known: member + left + unknown, member, left, unknown }
      },
      async claimChecks({ now, limit, leaseMs }): Promise<CheckClaim[]> {
        const eligible = [...subscriptionMembers.values()]
          .filter((member) => member.checkLeaseUntil === null || member.checkLeaseUntil.getTime() <= now.getTime())
          .sort((a, b) => {
            const aAt = a.lastCheckedAt?.getTime() ?? Number.NEGATIVE_INFINITY
            const bAt = b.lastCheckedAt?.getTime() ?? Number.NEGATIVE_INFINITY
            if (aAt !== bAt) return aAt - bAt
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          })
          .slice(0, Math.max(0, Math.trunc(limit)))

        return eligible.map((member) => {
          const token = crypto.randomUUID()
          const next: SubscriptionMember = {
            ...member,
            checkToken: token,
            checkLeaseUntil: new Date(now.getTime() + leaseMs),
            lastCheckedAt: now,
          }
          subscriptionMembers.set(memberKey(member.chatId, member.userId), next)
          return {
            memberId: member.id,
            chatId: member.chatId,
            userId: member.userId,
            token,
            version: member.version,
            requestStartedAt: now,
          }
        })
      },
      async finishCheck(claim, result): Promise<'applied' | 'stale'> {
        const stored = [...subscriptionMembers.values()].find((member) => member.id === claim.memberId)
        if (stored === undefined || stored.checkToken !== claim.token || stored.version !== claim.version) {
          return 'stale'
        }

        if (result.kind === 'ok') {
          subscriptionMembers.set(memberKey(stored.chatId, stored.userId), {
            ...stored,
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
            version: stored.version + 1,
          })
          return 'applied'
        }

        // 失败不改成员事实：只记错误码并释放租约（尝试时刻在 claim 时已推进）。
        subscriptionMembers.set(memberKey(stored.chatId, stored.userId), {
          ...stored,
          lastCheckErrorCode: result.errorCode,
          checkToken: null,
          checkLeaseUntil: null,
        })
        return 'applied'
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

/** 链接操作占位的租约（毫秒）：超过它未提交的占位可被新 token 替换，与 PG 的 `interval '60 seconds'` 对齐。 */
const MUTATION_LEASE_MS = 60_000

/**
 * `(time, id)` 是否严格排在复合游标之前（用于 `(createdAt, id)` / `(firstObservedAt, id)` 倒序分页）。
 *
 * @param time 记录时间。
 * @param id 记录 id。
 * @param beforeTime 游标时间。
 * @param beforeId 游标 id。
 * @returns 时间更早，或时间相同但 id 更小时为 `true`。
 */
function isBeforeTuple(time: Date, id: string, beforeTime: Date, beforeId: string): boolean {
  const byTime = time.getTime() - beforeTime.getTime()
  if (byTime !== 0) return byTime < 0
  return id < beforeId
}

/**
 * 与 SQL 的 `ORDER BY time DESC, id DESC` 同序。
 *
 * @param aTime 左记录时间。
 * @param aId 左记录 id。
 * @param bTime 右记录时间。
 * @param bId 右记录 id。
 * @returns 排序比较值。
 */
function compareDesc(aTime: Date, aId: string, bTime: Date, bId: string): number {
  const byTime = bTime.getTime() - aTime.getTime()
  if (byTime !== 0) return byTime
  if (aId === bId) return 0
  return aId > bId ? -1 : 1
}

/**
 * 事件高水位比较：`(eventDate, eventUpdateId)` 字典序是否严格新于已记录的事件。
 * 已有行没有事件高水位（来自对账插入）时任何事件都算新。
 *
 * @param observation 本次事件。
 * @param member 已存成员。
 * @returns 严格更新时为 `true`。
 */
function isNewerEvent(
  observation: MemberEventObservation,
  member: SubscriptionMember,
): boolean {
  if (member.lastEventDate === null || member.lastEventUpdateId === null) return true
  if (observation.eventDate !== member.lastEventDate) return observation.eventDate > member.lastEventDate
  return observation.eventUpdateId > member.lastEventUpdateId
}

/**
 * 事件是否携带可覆盖成功对账的事实：事件所在秒**晚于**对账开始所在秒才算新。
 * 同秒缺少精度，保守以成功查询为准（只推进高水位，不改事实）。
 *
 * @param eventDateSeconds Telegram 事件时间（秒）。
 * @param reconciledThrough 成功对账覆盖到的事实时刻；从未对账为 `null`。
 * @returns 可以应用事实时为 `true`。
 */
function isNewerThanReconcile(eventDateSeconds: number, reconciledThrough: Date | null): boolean {
  if (reconciledThrough === null) return true
  return eventDateSeconds > Math.floor(reconciledThrough.getTime() / 1_000)
}
