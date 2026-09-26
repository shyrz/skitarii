import { asChatId, asUserId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { ChatMember } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import type { Logger } from '@skitarii/bot'
import { TelegramSubscriptionError } from './subscriptions.js'
import { createSubscriptionReconciler, type SubscriptionReconcileDeps } from './subscription-reconcile.js'

/**
 * 订阅对账服务测试（spec §4.2/§8）。
 *
 * 覆盖：成功/失败结果写入、CAS 过期、失败不改事实、公平轮转（>50）、租约、429 停派发、
 * 超时、single-flight 与生命周期；并锁定「只调用 getChatMember，不做任何权限处置」。
 */

const chatId = asChatId('-1001234567890')
const now = new Date('2026-09-26T12:00:00Z')

/** 记录日志的替身。 */
function recordingLogger(messages: string[]): Logger {
  return {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  }
}

interface FakeTelegram {
  calls: Array<{ chatId: string; userId: number }>
  handler: (chatId: string, userId: number) => unknown
  port: Pick<SubscriptionReconcileDeps['telegram'], 'getChatMember'>
}

/** 组装对账依赖；默认 handler 立即返回 member 快照。 */
function setup(options: {
  handler?: (chatId: string, userId: number) => unknown
  concurrency?: number
  timeoutMs?: number
  batchLimit?: number
  intervalMs?: number
} = {}): {
  deps: SubscriptionReconcileDeps
  store: InMemoryRepos
  telegram: FakeTelegram
  logs: string[]
  reconciler: ReturnType<typeof createSubscriptionReconciler>
  /** 推进注入时钟（retry_after 窗口等时限断言用）。 */
  advance: (ms: number) => void
} {
  const store = createInMemoryRepos()
  const logs: string[] = []
  let currentNow = now
  const calls: FakeTelegram['calls'] = []
  const telegram: FakeTelegram = {
    calls,
    handler:
      options.handler ??
      (() =>
        ({
          status: 'member',
          user: { id: 1, is_bot: false, first_name: '成员' },
          until_date: 1_791_000_000,
        }) as ChatMember),
    port: {
      getChatMember: async (targetChatId, userId) => {
        calls.push({ chatId: String(targetChatId), userId })
        return (await telegram.handler(String(targetChatId), userId)) as ChatMember
      },
    },
  }

  const deps: SubscriptionReconcileDeps = {
    repos: store.repos,
    telegram: telegram.port,
    logger: recordingLogger(logs),
    now: () => currentNow,
    concurrency: options.concurrency ?? 4,
    timeoutMs: options.timeoutMs ?? 50,
    batchLimit: options.batchLimit ?? 50,
    intervalMs: options.intervalMs ?? 60_000,
  }

  return {
    deps,
    store,
    telegram,
    logs,
    reconciler: createSubscriptionReconciler(deps),
    advance: (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms)
    },
  }
}

/** 预置一个有 until_date 证据的成员。 */
async function seedMember(store: InMemoryRepos, userId: number, eventUpdateId = 1): Promise<void> {
  await store.repos.subscriptionMembers.applyEvent({
    chatId,
    userId: asUserId(userId),
    state: 'member',
    expiresAt: new Date('2026-10-26T10:00:00Z'),
    evidence: 'until_date',
    linkId: null,
    isJoin: true,
    eventDate: 1_758_000_000,
    eventUpdateId,
    observedAt: new Date('2026-09-26T09:00:00Z'),
  })
}

describe('订阅对账：成功与失败', () => {
  test('空台账：一轮 0 claim，不调用 Telegram', async () => {
    const { reconciler, telegram } = setup()
    const result = await reconciler.runOnce()
    expect(result).toEqual({ claimed: 0, applied: 0, failed: 0, skipped: 0, rateLimited: false })
    expect(telegram.calls).toHaveLength(0)
  })

  test('成功：observedAt/reconciledThrough 用查询开始时刻，lastCheckSucceededAt 用返回时刻，version 递增', async () => {
    const { reconciler, store } = setup()
    await seedMember(store, 101)

    const result = await reconciler.runOnce()

    expect(result).toMatchObject({ claimed: 1, applied: 1, failed: 0, skipped: 0 })
    const member = await store.repos.subscriptionMembers.find(chatId, asUserId(101))
    expect(member?.state).toBe('member')
    expect(member?.expiresAt?.toISOString()).toBe(new Date(1_791_000_000 * 1_000).toISOString())
    expect(member?.observedAt.toISOString()).toBe(now.toISOString())
    expect(member?.reconciledThrough?.toISOString()).toBe(now.toISOString())
    expect(member?.lastCheckSucceededAt?.toISOString()).toBe(now.toISOString())
    expect(member?.observationSource).toBe('reconcile')
    expect(member?.lastCheckedAt?.toISOString()).toBe(now.toISOString())
    expect(member?.lastCheckErrorCode).toBeNull()
    expect(member?.checkToken).toBeNull()
    expect(member?.version).toBe(1)
  })

  test('失败：只写受控错误码并释放租约，不改 state/expiresAt/observedAt', async () => {
    const { reconciler, store } = setup({
      handler: () => {
        throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
      },
    })
    await seedMember(store, 102)
    const before = await store.repos.subscriptionMembers.find(chatId, asUserId(102))

    const result = await reconciler.runOnce()

    expect(result).toMatchObject({ claimed: 1, applied: 0, failed: 1 })
    const member = await store.repos.subscriptionMembers.find(chatId, asUserId(102))
    expect(member?.state).toBe(before?.state)
    expect(member?.expiresAt?.toISOString()).toBe(before?.expiresAt?.toISOString())
    expect(member?.observedAt.toISOString()).toBe(before?.observedAt.toISOString())
    expect(member?.lastCheckErrorCode).toBe('telegram_failed')
    expect(member?.checkToken).toBeNull()
    expect(member?.lastCheckedAt?.toISOString()).toBe(now.toISOString())
    expect(member?.version).toBe(before?.version)
  })

  test('查询期间事件写入 → CAS 过期：结果丢弃、计 skipped、事件事实保留', async () => {
    const { reconciler, store } = setup({
      handler: async () => {
        // 查询在途时写入一个更新事件。
        await store.repos.subscriptionMembers.applyEvent({
          chatId,
          userId: asUserId(103),
          state: 'left',
          expiresAt: null,
          evidence: null,
          linkId: null,
          isJoin: true,
          eventDate: 1_758_000_500,
          eventUpdateId: 9,
          observedAt: new Date('2026-09-26T12:00:00Z'),
        })
        return { status: 'member', user: { id: 1, is_bot: false, first_name: '成员' } } as ChatMember
      },
    })
    await seedMember(store, 103)

    const result = await reconciler.runOnce()

    expect(result).toMatchObject({ claimed: 1, applied: 0, skipped: 1 })
    expect((await store.repos.subscriptionMembers.find(chatId, asUserId(103)))?.state).toBe('left')
  })

  test('超时按受控错误码记录，不覆盖事实', async () => {
    const { reconciler, store } = setup({
      timeoutMs: 5,
      handler: () => new Promise(() => {}),
    })
    await seedMember(store, 104)

    const result = await reconciler.runOnce()

    expect(result.failed).toBe(1)
    expect((await store.repos.subscriptionMembers.find(chatId, asUserId(104)))?.lastCheckErrorCode).toBe('timeout')
  })
})

describe('订阅对账：有界、公平与 429', () => {
  test('每轮最多 50 行；失败行也推进 lastCheckedAt，下一轮轮到剩余行', async () => {
    const { reconciler, store, telegram } = setup({ batchLimit: 50 })
    for (let index = 0; index < 55; index += 1) {
      await seedMember(store, 200 + index, index + 1)
    }

    const first = await reconciler.runOnce()
    expect(first.claimed).toBe(50)
    expect(telegram.calls).toHaveLength(50)

    // 未轮到的 5 行在下一轮优先被覆盖（公平推进，不饿死）。
    const checkedInFirst = new Set(telegram.calls.map((call) => call.userId))
    const remaining = Array.from({ length: 55 }, (_, index) => 200 + index).filter((id) => !checkedInFirst.has(id))
    expect(remaining).toHaveLength(5)

    const second = await reconciler.runOnce()
    expect(second.claimed).toBe(50)
    const secondRoundIds = new Set(telegram.calls.slice(50).map((call) => call.userId))
    for (const id of remaining) expect(secondRoundIds.has(id)).toBe(true)

    // 第三轮继续轮转（全量参与，不是只扫失败行）。
    const third = await reconciler.runOnce()
    expect(third.claimed).toBe(50)
  })

  test('429：停止本轮新派发；retry_after 窗口内整轮跳过，窗口结束后恢复', async () => {
    const { reconciler, store, telegram, advance } = setup({
      concurrency: 1,
      handler: () => {
        throw new TelegramSubscriptionError({ code: 'rate_limited', outcome: 'rate_limited', retryAfterSeconds: 7 })
      },
    })
    for (let index = 0; index < 5; index += 1) await seedMember(store, 300 + index, index + 1)

    const result = await reconciler.runOnce()

    expect(result.rateLimited).toBe(true)
    expect(telegram.calls).toHaveLength(1)
    expect(result.failed).toBe(5)
    // 已派发行的错误码优先是 rate_limited（429 响应本身），未派发行也记 rate_limited。
    const members = await store.repos.subscriptionMembers.listPage({ chatId, limit: 10 })
    expect(members.every((member) => member.lastCheckErrorCode === 'rate_limited')).toBe(true)
    expect(members.every((member) => member.checkToken === null)).toBe(true)
    expect(members.every((member) => member.lastCheckedAt !== null)).toBe(true)

    // retry_after 未到：不 claim、不派发，也不推进尝试时刻。
    const during = await reconciler.runOnce()
    expect(during).toEqual({ claimed: 0, applied: 0, failed: 0, skipped: 0, rateLimited: true })
    expect(telegram.calls).toHaveLength(1)
    const untouched = await store.repos.subscriptionMembers.listPage({ chatId, limit: 10 })
    expect(untouched.every((member) => member.lastCheckedAt?.toISOString() === now.toISOString())).toBe(true)

    // 窗口结束：重新 claim 全部（受控失败不丢行）。
    advance(7_000)
    const next = await reconciler.runOnce()
    expect(next.claimed).toBe(5)
    expect(telegram.calls).toHaveLength(2)
  })

  test('并发上限内的已派发调用收尾，不会超过 4 个', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { reconciler, store } = setup({
      concurrency: 4,
      handler: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
        return { status: 'left', user: { id: 1, is_bot: false, first_name: '成员' } } as ChatMember
      },
    })
    for (let index = 0; index < 12; index += 1) await seedMember(store, 400 + index, index + 1)

    await reconciler.runOnce()

    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  test('未过期租约的行不会被再次 claim（崩溃恢复靠租约过期）', async () => {
    const { reconciler, store } = setup()

    await seedMember(store, 500)
    const claims = await store.repos.subscriptionMembers.claimChecks({ now, limit: 10, leaseMs: 60_000 })
    expect(claims).toHaveLength(1)

    const result = await reconciler.runOnce()
    expect(result.claimed).toBe(0)
  })

  test('两个 worker 共享同一仓储：同一行不会被同时处理，轮次间无重复', async () => {
    const store = createInMemoryRepos()
    for (let index = 0; index < 6; index += 1) await seedMember(store, 700 + index, index + 1)

    const active = new Set<number>()
    let overlapped = false
    const makePort = () => ({
      getChatMember: async (_chatId: string, userId: number) => {
        if (active.has(userId)) overlapped = true
        active.add(userId)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active.delete(userId)
        return { status: 'left', user: { id: 1, is_bot: false, first_name: '成员' } } as ChatMember
      },
    })
    const logs: string[] = []
    const first = createSubscriptionReconciler({
      repos: store.repos,
      telegram: makePort(),
      logger: recordingLogger(logs),
      now: () => now,
      concurrency: 2,
      timeoutMs: 50,
    })
    const second = createSubscriptionReconciler({
      repos: store.repos,
      telegram: makePort(),
      logger: recordingLogger(logs),
      now: () => now,
      concurrency: 2,
      timeoutMs: 50,
    })

    const [a, b] = await Promise.all([first.runOnce(), second.runOnce()])

    expect(overlapped).toBe(false)
    expect(a.claimed + b.claimed).toBe(6)
  })

  test('到期观测值在过去不会触发任何处置：只读快照，状态照旧', async () => {
    const { reconciler, store, telegram } = setup()
    // 预置一个已经过了观测期限的成员。
    await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId: asUserId(800),
      state: 'member',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
      evidence: 'until_date',
      linkId: null,
      isJoin: true,
      eventDate: 1_758_000_000,
      eventUpdateId: 1,
      observedAt: new Date('2026-09-26T09:00:00Z'),
    })

    await reconciler.runOnce()

    const member = await store.repos.subscriptionMembers.find(chatId, asUserId(800))
    // 快照说仍在频道：状态保持 member，到期观测值按快照更新；没有任何 ban/kick/restrict。
    expect(member?.state).toBe('member')
    expect(telegram.calls).toHaveLength(1)
    expect(Object.keys(telegram.port)).toEqual(['getChatMember'])
  })
})

describe('订阅对账：single-flight、生命周期与只读边界', () => {
  test('runOnce 共用 single-flight：并发调用返回同一 promise', async () => {
    const { reconciler, store } = setup({
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { status: 'left', user: { id: 1, is_bot: false, first_name: '成员' } } as ChatMember
      },
    })
    await seedMember(store, 600)

    const first = reconciler.runOnce()
    const second = reconciler.runOnce()

    expect(reconciler.isRunning()).toBe(true)
    expect(first).toBe(second)
    await first
    expect(reconciler.isRunning()).toBe(false)
  })

  test('start/stop 生命周期：定时轮询可停，停止后不再新增调用', async () => {
    const { reconciler, store, telegram } = setup({ intervalMs: 15 })
    await seedMember(store, 601)

    reconciler.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const afterStart = telegram.calls.length
    expect(afterStart).toBeGreaterThanOrEqual(2)

    reconciler.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(telegram.calls.length).toBe(afterStart)
  })

  test('只调用 getChatMember：对账端口没有 ban/kick/restrict 任何接口', async () => {
    const { reconciler, store, telegram } = setup()
    await seedMember(store, 602)
    await reconciler.runOnce()

    expect(Object.keys(telegram.port)).toEqual(['getChatMember'])
    expect(telegram.calls).toHaveLength(1)
  })

  test('对账日志只含受控码与计数，不打印异常对象', async () => {
    const { reconciler, store, logs } = setup({
      handler: () => {
        throw new Error('secret invite link https://t.me/+abcdefghijklmnop')
      },
    })
    await seedMember(store, 603)
    await reconciler.runOnce()

    expect(logs.join('\n')).not.toContain('https://t.me/+')
    expect(logs.join('\n')).not.toContain('secret')
  })
})
