import { asChatId, asUserId, type ModerationDecision } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import { GrammyError } from 'grammy'
import { describe, expect, test } from 'vitest'
import { createDecisionRetryService, DECISION_RETRY_WINDOW_MS, STALE_DECISION_AGE_MS } from './decision-retry.js'
import { createActionExecutor } from './executor.js'
import { createIdempotencyRegistry } from './idempotency.js'
import type { Logger } from './logger.js'
import { createRecordingApi, type RecordingApi } from './recording-api.js'

/**
 * 补偿扫描的行为测试：卡住的决策按仓库里的 `executed` 与幂等闸门决定是否重试，
 * 执行上下文（message_id）从事件行重建。断言看实际调用的 Telegram 方法与落库状态。
 */

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)
const now = new Date('2026-09-23T12:00:00Z')

/** 一个「卡住」的判定时刻：比判定阈值再早 5 分钟，落在重试窗口中间。 */
const staleDecidedAt = new Date(now.getTime() - STALE_DECISION_AGE_MS - 5 * 60_000)

/**
 * 组装补偿扫描与其依赖。
 *
 * @returns 服务、内存仓储、录制 api、幂等闸门与执行器（服务与执行器共用后者）。
 */
function setup() {
  const recording: RecordingApi = createRecordingApi()
  const store: InMemoryRepos = createInMemoryRepos()
  const idempotency = createIdempotencyRegistry()
  const executor = createActionExecutor({
    api: recording.api,
    repos: store.repos,
    idempotency,
    miniAppUrl: 'https://mini.example.com/app',
    logger: silentLogger,
    now: () => now,
    sleep: async () => {},
  })
  const service = createDecisionRetryService({
    repos: store.repos,
    executor,
    idempotency,
    logger: silentLogger,
    now: () => now,
  })

  return { service, store, recording, idempotency, executor }
}

/**
 * 预置一条消息事件。
 *
 * @param store 内存仓储。
 * @param id 事件 id。
 * @param messageId 消息 id（重建执行上下文用）。
 */
async function seedEvent(store: InMemoryRepos, id: string, messageId: number): Promise<void> {
  await store.repos.events.insert({
    id,
    chatId,
    userId,
    messageId,
    contentHash: id,
    features: { hasLink: false, mediaType: 'text', length: 4, customEmojiCount: 0, emojiCount: 0, viaBot: false },
    createdAt: new Date('2026-09-23T10:00:00Z'),
  })
}

/**
 * 预置一条决策。
 *
 * @param store 内存仓储。
 * @param overrides 覆盖字段。
 * @returns 决策对象。
 */
async function seedDecision(
  store: InMemoryRepos,
  overrides: Partial<ModerationDecision> & { id: string; eventId: string },
): Promise<ModerationDecision> {
  const decision: ModerationDecision = {
    chatId,
    userId,
    action: { kind: 'delete' },
    score: 0.9,
    signals: [],
    decidedAt: staleDecidedAt,
    executed: false,
    ...overrides,
  }
  await store.repos.decisions.insert(decision)
  return decision
}

describe('未执行决策的补偿扫描', () => {
  test('补执行卡住的决策：从事件行重建上下文，交给同一个执行器', async () => {
    const { service, store, recording } = setup()
    await seedEvent(store, 'event-1', 42)
    await seedDecision(store, { id: 'decision-1', eventId: 'event-1' })

    const result = await service.runOnce()

    expect(result).toEqual({ scanned: 1, retried: 1, skipped: 0, orphaned: 0 })
    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, 42])
    expect(recording.countOf('sendMessage')).toBe(1)
    expect(await store.repos.decisions.findById('decision-1')).toMatchObject({ executed: true })
  })

  test('刚判定的决策不在补偿范围内（避免和正在执行的管线抢同一个动作）', async () => {
    const { service, store, recording } = setup()
    await seedEvent(store, 'event-1', 42)
    await seedDecision(store, {
      id: 'decision-1',
      eventId: 'event-1',
      decidedAt: new Date(now.getTime() - 60_000),
    })

    const result = await service.runOnce()

    expect(result.scanned).toBe(0)
    expect(recording.calls).toEqual([])
    expect(await store.repos.decisions.findById('decision-1')).toMatchObject({ executed: false })
  })

  test('超出重试窗口的决策不再补偿（永不成功的老决策不该占住扫描额度）', async () => {
    const { service, store, recording } = setup()
    await seedEvent(store, 'event-1', 42)
    await seedDecision(store, {
      id: 'decision-1',
      eventId: 'event-1',
      decidedAt: new Date(now.getTime() - DECISION_RETRY_WINDOW_MS - 60_000),
    })

    expect((await service.runOnce()).scanned).toBe(0)
    expect(recording.calls).toEqual([])
  })

  test('幂等闸门已命中时跳过本轮，不重复施加动作', async () => {
    const { service, store, recording, idempotency } = setup()
    await seedEvent(store, 'event-1', 42)
    await seedDecision(store, { id: 'decision-1', eventId: 'event-1' })
    // 模拟「本进程已经施加过动作、但回填还没落库」：闸门里有键，库里还没 executed。
    await idempotency.run('event-1:delete', async () => {})

    const result = await service.runOnce()

    expect(result).toEqual({ scanned: 1, retried: 0, skipped: 1, orphaned: 0 })
    expect(recording.calls).toEqual([])
  })

  test('找不到事件行时记为 orphaned，不猜执行上下文', async () => {
    const { service, store, recording } = setup()
    await seedDecision(store, { id: 'decision-1', eventId: 'event-missing' })

    const result = await service.runOnce()

    expect(result).toEqual({ scanned: 1, retried: 0, skipped: 0, orphaned: 1 })
    expect(recording.calls).toEqual([])
  })

  test('补执行成功后再次运行不会重复施加', async () => {
    const { service, store, recording } = setup()
    await seedEvent(store, 'event-1', 42)
    await seedDecision(store, { id: 'decision-1', eventId: 'event-1' })

    await service.runOnce()
    const second = await service.runOnce()

    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(1)
    expect(second.scanned).toBe(0)
  })

  test('单条失败不阻断其余：失败的留在未执行状态等下一轮', async () => {
    let attempts = 0
    const recording: RecordingApi = createRecordingApi({
      deleteMessage: () => {
        attempts += 1
        if (attempts === 1) {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the chat' },
            'deleteMessage',
            {},
          )
        }
        return { ok: true }
      },
    })
    const store: InMemoryRepos = createInMemoryRepos()
    const idempotency = createIdempotencyRegistry()
    const executor = createActionExecutor({
      api: recording.api,
      repos: store.repos,
      idempotency,
      miniAppUrl: 'https://mini.example.com/app',
      logger: silentLogger,
      now: () => now,
      sleep: async () => {},
    })
    const service = createDecisionRetryService({ repos: store.repos, executor, idempotency, logger: silentLogger, now: () => now })

    await seedEvent(store, 'event-1', 42)
    await seedEvent(store, 'event-2', 43)
    await seedDecision(store, { id: 'decision-1', eventId: 'event-1', decidedAt: staleDecidedAt })
    await seedDecision(store, {
      id: 'decision-2',
      eventId: 'event-2',
      decidedAt: new Date(staleDecidedAt.getTime() + 1_000),
    })

    const result = await service.runOnce()

    expect(result.scanned).toBe(2)
    expect(result.retried).toBe(1)
    expect(await store.repos.decisions.findById('decision-1')).toMatchObject({ executed: false })
    expect(await store.repos.decisions.findById('decision-2')).toMatchObject({ executed: true })
  })
})
