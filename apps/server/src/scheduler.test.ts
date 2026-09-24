import { asChatId, asUserId, type ChatId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos, type Repos } from '@skitarii/db'
import { describe, expect, test, vi } from 'vitest'
import { createScheduler, dateOf, DETAIL_RETENTION_DAYS, runMaintenance, windowOf } from './scheduler.js'

/**
 * 调度任务的行为测试：聚合数字与保留期清理都断言实际落库的结果，不看内部调用参数。
 * 仓储用内存实现（`@skitarii/db` 的 `createInMemoryRepos`），它的计数口径与 PG 版一致。
 */

const chatA = asChatId('-1001111111111')
const chatB = asChatId('-1002222222222')
const userId = asUserId(7_000_000_001)
const now = new Date('2026-09-23T12:00:00Z')
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 预置一个群配置。
 *
 * @param store 内存仓储。
 * @param chatId 群标识。
 * @param title 群标题。
 */
async function seedChat(store: InMemoryRepos, chatId: ChatId, title: string): Promise<void> {
  await store.repos.chats.upsert({
    chatId,
    title,
    language: 'zh',
    rules: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  })
}

/**
 * 预置一条消息事件。
 *
 * @param store 内存仓储。
 * @param chatId 群标识。
 * @param id 事件 id。
 * @param createdAt 落库时间。
 */
async function seedEvent(store: InMemoryRepos, chatId: ChatId, id: string, createdAt: Date): Promise<void> {
  await store.repos.events.insert({
    id,
    chatId,
    userId,
    messageId: Number(id.replaceAll('-', '').slice(-4)) || 1,
    contentHash: id,
    features: { hasLink: false, mediaType: 'text', length: 4, customEmojiCount: 0 },
    createdAt,
  })
}

describe('维护任务', () => {
  test('按群重算昨天与今天的四个计数', async () => {
    const store = createInMemoryRepos()
    await seedChat(store, chatA, '甲群')
    await seedChat(store, chatB, '乙群')

    // 昨天（2026-09-22 UTC）：3 条消息、2 条决策（1 条非放行）、1 条申诉（已撤销）。
    await seedEvent(store, chatA, 'a1', new Date('2026-09-22T01:00:00Z'))
    await seedEvent(store, chatA, 'a2', new Date('2026-09-22T02:00:00Z'))
    await seedEvent(store, chatA, 'a3', new Date('2026-09-22T23:59:00Z'))
    await store.repos.decisions.insert({
      id: 'd1',
      eventId: 'a1',
      chatId: chatA,
      userId,
      action: { kind: 'delete' },
      score: 0.9,
      signals: [],
      decidedAt: new Date('2026-09-22T01:01:00Z'),
      executed: true,
    })
    await store.repos.decisions.insert({
      id: 'd2',
      eventId: 'a2',
      chatId: chatA,
      userId,
      action: { kind: 'pass' },
      score: 0.1,
      signals: [],
      decidedAt: new Date('2026-09-22T02:01:00Z'),
      executed: true,
    })
    await store.repos.appeals.insert({
      id: 'p1',
      decisionId: 'd1',
      userId,
      state: 'overturned',
      note: '误判',
      createdAt: new Date('2026-09-22T03:00:00Z'),
      resolvedAt: new Date('2026-09-22T03:30:00Z'),
    })
    // 前一天的越界样本：不该被算进 09-22。
    await seedEvent(store, chatA, 'a0', new Date('2026-09-21T23:59:59Z'))

    // 今天（2026-09-23）：1 条消息，无处置。
    await seedEvent(store, chatA, 'a4', new Date('2026-09-23T05:00:00Z'))
    // 乙群：1 条消息，1 条非放行决策，1 条未结案申诉。
    await seedEvent(store, chatB, 'b1', new Date('2026-09-22T10:00:00Z'))
    await store.repos.decisions.insert({
      id: 'd3',
      eventId: 'b1',
      chatId: chatB,
      userId,
      action: { kind: 'mute', until: new Date('2026-09-22T11:00:00Z') },
      score: 0.8,
      signals: [],
      decidedAt: new Date('2026-09-22T10:01:00Z'),
      executed: true,
    })
    await store.repos.appeals.insert({
      id: 'p2',
      decisionId: 'd3',
      userId,
      state: 'open',
      note: '不服',
      createdAt: new Date('2026-09-22T11:00:00Z'),
      resolvedAt: null,
    })

    const result = await runMaintenance({ repos: store.repos, logger: silentLogger, now: () => now })

    expect(result.dates).toEqual(['2026-09-22', '2026-09-23'])
    expect(result.rolledUp).toBe(4)

    expect(await store.repos.aggregates.listRange(chatA, '2026-09-22', '2026-09-22')).toEqual([
      {
        chatId: chatA,
        date: '2026-09-22',
        messageCount: 3,
        actionCount: 1,
        appealCount: 1,
        overturnedCount: 1,
      },
    ])
    expect(await store.repos.aggregates.listRange(chatA, '2026-09-23', '2026-09-23')).toEqual([
      { chatId: chatA, date: '2026-09-23', messageCount: 1, actionCount: 0, appealCount: 0, overturnedCount: 0 },
    ])
    expect(await store.repos.aggregates.listRange(chatB, '2026-09-22', '2026-09-22')).toEqual([
      { chatId: chatB, date: '2026-09-22', messageCount: 1, actionCount: 1, appealCount: 1, overturnedCount: 0 },
    ])
  })

  test('重跑同样的时间点得到同样的数字（upsert 幂等）', async () => {
    const store = createInMemoryRepos()
    await seedChat(store, chatA, '甲群')
    await seedEvent(store, chatA, 'a1', new Date('2026-09-22T01:00:00Z'))

    await runMaintenance({ repos: store.repos, logger: silentLogger, now: () => now })
    await runMaintenance({ repos: store.repos, logger: silentLogger, now: () => now })

    const rows = await store.repos.aggregates.listRange(chatA, '2026-09-22', '2026-09-23')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.messageCount).toBe(1)
  })

  test('单个群重算失败不阻断其他群', async () => {
    const store = createInMemoryRepos()
    await seedChat(store, chatA, '甲群')
    await seedChat(store, chatB, '乙群')
    await seedEvent(store, chatA, 'a1', new Date('2026-09-22T01:00:00Z'))
    await seedEvent(store, chatB, 'b1', new Date('2026-09-22T01:00:00Z'))

    // 只让乙群的计数失败：调度应当跳过它并完成其余工作。
    const repos: Repos = {
      ...store.repos,
      aggregates: {
        ...store.repos.aggregates,
        countForDay: async (chatId, from, to) => {
          if (chatId === chatB) throw new Error('计数失败')
          return store.repos.aggregates.countForDay(chatId, from, to)
        },
      },
    }

    const result = await runMaintenance({ repos, logger: silentLogger, now: () => now })

    expect(result.rolledUp).toBe(2)
    expect(await store.repos.aggregates.listRange(chatA, '2026-09-22', '2026-09-22')).toHaveLength(1)
    expect(await store.repos.aggregates.listRange(chatB, '2026-09-22', '2026-09-22')).toHaveLength(0)
  })

  test('按保留期清理明细：超过 30 天的消息事件与缓存条目被删掉', async () => {
    const store = createInMemoryRepos()
    await seedChat(store, chatA, '甲群')

    const stale = new Date(now.getTime() - (DETAIL_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000)
    const fresh = new Date(now.getTime() - (DETAIL_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000)
    await seedEvent(store, chatA, 'old', stale)
    await seedEvent(store, chatA, 'new', fresh)
    await store.repos.llmCache.put({
      contentHash: 'old-hash',
      verdict: 'spam',
      confidence: 0.9,
      model: 'gpt-4o-mini',
      createdAt: stale,
    })
    await store.repos.llmCache.put({
      contentHash: 'new-hash',
      verdict: 'spam',
      confidence: 0.9,
      model: 'gpt-4o-mini',
      createdAt: fresh,
    })

    const result = await runMaintenance({ repos: store.repos, logger: silentLogger, now: () => now })

    expect(result.purgedEvents).toBe(1)
    expect(result.purgedCacheEntries).toBe(1)
    expect(await store.repos.events.findWithSample('old')).toBeNull()
    expect(await store.repos.events.findWithSample('new')).not.toBeNull()
    expect(await store.repos.llmCache.get('old-hash')).toBeNull()
    expect(await store.repos.llmCache.get('new-hash')).not.toBeNull()
  })

  test('补偿扫描与通知补发的结果进入本轮统计', async () => {
    const store = createInMemoryRepos()
    await seedChat(store, chatA, '甲群')

    const result = await runMaintenance({
      repos: store.repos,
      logger: silentLogger,
      now: () => now,
      retryDecisions: { runOnce: async () => ({ scanned: 3, retried: 2, skipped: 1, orphaned: 0 }) },
      resendAppeals: { runOnce: async () => ({ scanned: 2, sent: 1, failed: 1 }) },
    })

    expect(result.retriedDecisions).toBe(2)
    expect(result.resentAppeals).toBe(1)
  })

  test('两条补偿扫描失败只记日志，聚合与清理照常完成', async () => {
    const store = createInMemoryRepos()
    await seedChat(store, chatA, '甲群')
    await seedEvent(store, chatA, 'a1', new Date('2026-09-22T01:00:00Z'))

    const result = await runMaintenance({
      repos: store.repos,
      logger: silentLogger,
      now: () => now,
      retryDecisions: {
        runOnce: async () => {
          throw new Error('补偿失败')
        },
      },
      resendAppeals: {
        runOnce: async () => {
          throw new Error('补发失败')
        },
      },
    })

    expect(result.rolledUp).toBe(2)
    expect(result.retriedDecisions).toBe(0)
    expect(result.resentAppeals).toBe(0)
    expect(await store.repos.aggregates.listRange(chatA, '2026-09-22', '2026-09-22')).toHaveLength(1)
  })
})

describe('调度节拍', () => {
  test('上一轮维护未结束时跳过本轮', async () => {
    const store = createInMemoryRepos()
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let listCalls = 0
    const repos: Repos = {
      ...store.repos,
      chats: {
        ...store.repos.chats,
        listAll: async () => {
          listCalls += 1
          await gate
          return []
        },
      },
    }
    const warnings: string[] = []
    const scheduler = createScheduler({
      repos,
      logger: {
        info: () => {},
        warn: (message) => {
          warnings.push(message)
        },
        error: () => {},
      },
      intervalMs: 1,
    })

    scheduler.start()
    // 第一轮卡在 listAll 上，之后的每一拍都应当被守卫跳过（而不是再开一轮）。
    await vi.waitFor(
      () => {
        if (!warnings.some((message) => message.includes('跳过本轮'))) throw new Error('还没有跳过任何一拍')
      },
      { timeout: 500, interval: 5 },
    )

    scheduler.stop()
    releaseGate?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listCalls).toBe(1)
  })
})

describe('日期换算', () => {
  test('按 UTC 切日', () => {
    expect(dateOf(new Date('2026-09-23T00:00:00Z'))).toBe('2026-09-23')
    expect(dateOf(new Date('2026-09-23T23:59:59Z'))).toBe('2026-09-23')
  })

  test('日期窗口是左闭右开的一天', () => {
    expect(windowOf('2026-09-22')).toEqual({
      from: new Date('2026-09-22T00:00:00.000Z'),
      to: new Date('2026-09-23T00:00:00.000Z'),
    })
  })
})
