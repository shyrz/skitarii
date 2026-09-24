import { asChatId, asUserId, type ModerationDecision } from '@skitarii/core'
import { GrammyError } from 'grammy'
import { describe, expect, test } from 'vitest'
import { createActionExecutor, noticeText } from './executor.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createInMemoryRepos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { createRecordingApi, type RecordingApi } from './recording-api.js'
import { retryAfterOf, backoffDelayMs } from './telegram-call.js'
import { createTokenBucket } from './token-bucket.js'

/** 静默日志，测试里不关心输出。 */
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)

/**
 * 构造一条待执行决策。
 *
 * @param overrides 覆盖字段。
 * @returns 决策对象。
 */
function decisionFixture(overrides: Partial<ModerationDecision> = {}): ModerationDecision {
  return {
    id: '9c8b7a65-1111-4222-8333-999900001111',
    eventId: '3f1d0c9a-1111-4222-8333-444455556666',
    chatId,
    userId,
    action: { kind: 'delete' },
    score: 0.9,
    signals: [{ kind: 'rule-hit', ruleId: 'rule-1', score: 0.9 }],
    decidedAt: new Date('2026-09-23T10:00:00Z'),
    executed: false,
    ...overrides,
  }
}

/**
 * 组装执行器与它依赖的替身。
 *
 * @param overrides 覆盖 api 处理器、限流桶容量等。
 * @returns 执行器、录制 api、内存仓储与依赖观察口。
 */
function setup(
  overrides: {
    handlers?: Parameters<typeof createRecordingApi>[0]
    capacity?: number
    logger?: Logger
    notifyOwnerFailure?: (decision: ModerationDecision, description: string) => Promise<void>
  } = {},
) {
  const recording: RecordingApi = createRecordingApi(overrides.handlers ?? {})
  const store = createInMemoryRepos()
  const idempotency = createIdempotencyRegistry()
  const outbound = createTokenBucket({ capacity: overrides.capacity ?? 3 })
  const sleeps: number[] = []
  const executor = createActionExecutor({
    api: recording.api,
    repos: store.repos,
    idempotency,
    outbound,
    miniAppUrl: 'https://mini.example.com/app',
    logger: overrides.logger ?? silentLogger,
    now: () => new Date('2026-09-23T10:00:00Z'),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    notifyOwnerFailure: overrides.notifyOwnerFailure,
  })

  return { executor, recording, store, idempotency, outbound, sleeps }
}

describe('处置执行', () => {
  test('删除动作按群与消息 id 调用 Telegram，并回填已执行', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, 42])
    expect(recording.countOf('sendMessage')).toBe(1)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('当事人私聊通知带申诉按钮，URL 携带 decisionId', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(userId)
    expect(String(args[1])).toBe('🚫 已删除你的违规消息。')
    expect(args[2]).toEqual({
      reply_markup: {
        inline_keyboard: [[{ text: '提起申诉', url: `https://mini.example.com/app?startapp=${decision.id}` }]],
      },
    })
  })

  test('私聊成功：群内完全静默，并记录通知引用', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 只有一条私聊通知，群内没有任何消息。
    expect(recording.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1)
    expect(recording.lastArgsOf('sendMessage')?.[0]).toBe(userId)
    // 引用落库，供申诉生命周期编辑。
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({
      chatId: String(userId),
      messageId: 1,
    })
  })

  test.each([
    ["Forbidden: bot can't initiate conversation with a user"],
    ['Forbidden: bot was blocked by the user'],
  ])('私聊不可达（%s）→ 回退群内通知', async (description) => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError('failed', { ok: false, error_code: 403, description }, 'sendMessage', {})
          }
          return { message_id: 9 }
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(chatId)
    expect(String(args[1])).toBe('🚫 已删除一条违规消息。')
    expect(args[2]).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: '提起申诉' }]] },
    })
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({ chatId, messageId: 9 })
  })

  test('私聊其余失败按通知可丢处理，不回退群内', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: () => {
          throw new GrammyError(
            'failed',
            { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
            'sendMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 只有那次失败的私聊尝试：不回退群内，也不影响动作与 executed。
    expect(recording.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toBeNull()
  })

  test('私聊限流 → 回退群内；群内也限流 → 两边都跳过', async () => {
    const limited = setup()
    // 把当事人私聊桶的令牌耗光，群桶仍是满的。
    for (let index = 0; index < 3; index += 1) limited.outbound.tryTake(String(userId))
    const first = decisionFixture()
    await limited.store.repos.decisions.insert(first)
    await limited.executor.execute(first, { messageId: 42 })

    expect(limited.recording.lastArgsOf('sendMessage')?.[0]).toBe(chatId)

    const allLimited = setup({ capacity: 0 })
    const second = decisionFixture()
    await allLimited.store.repos.decisions.insert(second)
    await allLimited.executor.execute(second, { messageId: 42 })

    expect(allLimited.recording.countOf('sendMessage')).toBe(0)
    expect(await allLimited.store.repos.decisions.findNoticeRef(second.id)).toBeNull()
  })

  test('通知引用记录失败只 warn，不影响执行完成', async () => {
    const warnings: string[] = []
    const logger: Logger = {
      info: () => {},
      warn: (message) => {
        warnings.push(message)
      },
      error: () => {},
    }
    const { store } = setup({ logger })
    const repos = {
      ...store.repos,
      decisions: {
        ...store.repos.decisions,
        markNoticeSent: async () => {
          throw new Error('database is down')
        },
      },
    }
    const executorWithFailingRepo = createActionExecutor({
      api: createRecordingApi().api,
      repos,
      idempotency: createIdempotencyRegistry(),
      outbound: createTokenBucket(),
      miniAppUrl: 'https://mini.example.com/app',
      logger,
      now: () => new Date('2026-09-23T10:00:00Z'),
      sleep: async () => {},
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executorWithFailingRepo.execute(decision, { messageId: 42 })

    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
    expect(warnings.some((message) => message.includes('通知引用记录失败'))).toBe(true)
  })

  test('重复执行同一决策只生效一次（幂等键 = eventId + action）', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })
    await executor.execute(decision, { messageId: 42 })
    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(1)
  })

  test('并发重投递共享同一次执行，不会重复删除', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await Promise.all([
      executor.execute(decision, { messageId: 42 }),
      executor.execute(decision, { messageId: 42 }),
    ])

    expect(recording.countOf('deleteMessage')).toBe(1)
  })

  test('已回填 executed 的决策直接跳过', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture({ executed: true })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.calls).toHaveLength(0)
  })

  test('禁言带解禁时刻与完整权限集合', async () => {
    const { executor, recording, store } = setup()
    const until = new Date('2026-09-23T11:00:00Z')
    const decision = decisionFixture({ action: { kind: 'mute', until } })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    const args = recording.lastArgsOf('restrictChatMember') ?? []
    expect(args[0]).toBe(chatId)
    expect(args[1]).toBe(userId)
    expect(args[2]).toMatchObject({ can_send_messages: false })
    expect(args[3]).toEqual({ until_date: Math.floor(until.getTime() / 1_000) })
    expect(String((recording.lastArgsOf('sendMessage') ?? [])[1])).toContain('已对你禁言 60 分钟')
    // 禁言成功就没有降级：消息本身不删。
    expect(recording.countOf('deleteMessage')).toBe(0)
  })

  test('封禁走 banChatMember，警示不发任何 API 动作', async () => {
    const banSetup = setup()
    const ban = decisionFixture({ action: { kind: 'ban' } })
    await banSetup.store.repos.decisions.insert(ban)
    await banSetup.executor.execute(ban, { messageId: 42 })
    expect(banSetup.recording.lastArgsOf('banChatMember')).toEqual([chatId, userId])

    const warnSetup = setup()
    const warn = decisionFixture({ action: { kind: 'warn' } })
    await warnSetup.store.repos.decisions.insert(warn)
    await warnSetup.executor.execute(warn, { messageId: 42 })
    expect(warnSetup.recording.calls.map((call) => call.method)).toEqual(['sendMessage'])
    expect(String((warnSetup.recording.lastArgsOf('sendMessage') ?? [])[1])).toContain('请注意群规')
  })

  test('放行决策不碰 Telegram，只回填已执行', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture({ action: { kind: 'pass' }, score: 0.1 })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.calls).toHaveLength(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('出站限流时放弃通知但动作照常施加', async () => {
    const { executor, recording, store } = setup({ capacity: 0 })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('429 按 retry_after 退避后重试成功', async () => {
    let attempts = 0
    const { executor, recording, store, sleeps } = setup({
      handlers: {
        deleteMessage: () => {
          attempts += 1
          if (attempts === 1) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } },
              'deleteMessage',
              {},
            )
          }
          return { ok: true }
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(attempts).toBe(2)
    // 两次调用都被记录：第一次 429、第二次成功。退避后不再重复发送通知。
    expect(recording.countOf('deleteMessage')).toBe(2)
    expect(recording.countOf('sendMessage')).toBe(1)
    // retry_after 2s + 500ms 缓冲，再叠加 0..20% 抖动。
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_500)
    expect(sleeps[0]).toBeLessThanOrEqual(3_000)
  })

  test('429 以外的 Telegram 错误向上抛出，决策保持未执行等待重试', async () => {
    const { executor, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the chat' },
            'deleteMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await expect(executor.execute(decision, { messageId: 42 })).rejects.toThrow('Forbidden')
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: false })
  })

  test('其他 400 视为终结：不再重试，也不误报已处置', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
            'deleteMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('删除时消息已不在（message to delete not found）视为目标达成：照发通知并回填', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
            'deleteMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 消息已经没了，目标达成：通知照发，用户不丢申诉入口。
    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(1)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('删除时消息已不在（message not found）同样按目标达成处理', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description: 'Bad Request: message not found' },
            'deleteMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('sendMessage')).toBe(1)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('非删除动作的 400 仍然是终结：不发通知，只回填已执行', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        restrictChatMember: () => {
          throw new GrammyError(
            'Call to restrictChatMember failed',
            { ok: false, error_code: 400, description: 'Bad Request: not enough rights to restrict the chat member' },
            'restrictChatMember',
            {},
          )
        },
      },
    })
    const decision = decisionFixture({ action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') } })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('sendMessage')).toBe(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('禁言被「用户是管理员」拒绝：降级为删除消息并通知「已删除」', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        restrictChatMember: () => {
          throw new GrammyError(
            'Call to restrictChatMember failed',
            { ok: false, error_code: 400, description: 'Bad Request: user is an administrator of the chat' },
            'restrictChatMember',
            {},
          )
        },
      },
    })
    const decision = decisionFixture({ action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') } })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 管理员不可被禁言，但广告消息仍能删掉：通知按实际生效的动作说「已删除」。
    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, 42])
    expect(String((recording.lastArgsOf('sendMessage') ?? [])[1])).toBe('🚫 已删除你的违规消息。')
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('封禁被「不能移除群主」拒绝：同样降级为删除', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        banChatMember: () => {
          throw new GrammyError(
            'Call to banChatMember failed',
            { ok: false, error_code: 400, description: "Bad Request: can't remove chat owner" },
            'banChatMember',
            {},
          )
        },
      },
    })
    const decision = decisionFixture({ action: { kind: 'ban' } })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, 42])
    expect(String((recording.lastArgsOf('sendMessage') ?? [])[1])).toBe('🚫 已删除你的违规消息。')
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('禁言被拒且降级删除也被终结拒绝：不发通知，仍回填已执行', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        restrictChatMember: () => {
          throw new GrammyError(
            'Call to restrictChatMember failed',
            { ok: false, error_code: 400, description: 'Bad Request: user is an administrator of the chat' },
            'restrictChatMember',
            {},
          )
        },
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
            'deleteMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture({ action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') } })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 降级删除也没成功：不误报「已删除」，决策仍是终态，不再无限重试。
    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('终结性拒绝时私聊 owner：带决策与拒绝原因', async () => {
    const failures: Array<{ decision: ModerationDecision; description: string }> = []
    const { executor, recording, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
            'deleteMessage',
            {},
          )
        },
      },
      notifyOwnerFailure: async (decision, description) => {
        failures.push({ decision, description })
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(failures).toEqual([
      { decision, description: 'Bad Request: not enough rights to delete the message' },
    ])
    // 群内不发假通知；决策仍是终态。
    expect(recording.countOf('sendMessage')).toBe(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('失败通知自身抛错不影响 executed 回填', async () => {
    const warnings: Array<{ message: string; error: unknown }> = []
    const logger: Logger = {
      info: () => {},
      warn: (message, error) => warnings.push({ message, error }),
      error: () => {},
    }
    const { executor, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
            'deleteMessage',
            {},
          )
        },
      },
      logger,
      notifyOwnerFailure: async () => {
        throw new Error('owner 私聊不可达')
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await expect(executor.execute(decision, { messageId: 42 })).resolves.toBeUndefined()

    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining('Telegram 拒绝该动作'),
      `处置失败通知失败 decisionId=${decision.id}`,
    ])
  })

  test('非终态错误不触发失败通知（抛出交给补偿扫描重试）', async () => {
    const failures: unknown[] = []
    const { executor, store } = setup({
      handlers: {
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the chat' },
            'deleteMessage',
            {},
          )
        },
      },
      notifyOwnerFailure: async (decision, description) => {
        failures.push({ decision, description })
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await expect(executor.execute(decision, { messageId: 42 })).rejects.toThrow('Forbidden')

    expect(failures).toEqual([])
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: false })
  })
})

describe('重试判定与文案', () => {
  test('非 GrammyError 与没有 retry_after 的 429 都不进退避', () => {
    expect(retryAfterOf(new Error('boom'))).toBeNull()
    expect(
      retryAfterOf(
        new GrammyError(
          'failed',
          { ok: false, error_code: 429, description: 'Too Many Requests' },
          'sendMessage',
          {},
        ),
      ),
    ).toBeNull()
  })

  test('退避带 500ms 缓冲与 0..20% 抖动', () => {
    // 抖动为 0 时就是 retry_after + 缓冲；为 1 时到达上限（多等 20%）。
    expect(backoffDelayMs(2_000, () => 0)).toBe(2_500)
    expect(backoffDelayMs(2_000, () => 1)).toBe(3_000)
    expect(backoffDelayMs(2_000, () => 0.5)).toBe(2_750)
    // 抖动只加不减：不会早于 Telegram 给的下限到达。
    expect(backoffDelayMs(0, () => 0)).toBe(500)
  })

  test('处置文案带剩余禁言分钟数，两个受众两套口气', () => {
    const instant = new Date('2026-09-23T10:00:00Z')
    expect(noticeText({ kind: 'mute', until: new Date('2026-09-23T10:30:00Z') }, instant, 'group')).toBe(
      '🔇 已禁言违规用户 30 分钟。',
    )
    expect(noticeText({ kind: 'mute', until: new Date('2026-09-23T10:30:00Z') }, instant, 'dm')).toBe(
      '🔇 已对你禁言 30 分钟。',
    )
    expect(noticeText({ kind: 'warn' }, instant, 'dm')).toBe('⚠️ 请注意群规：你发的这条消息疑似违规，请勿重复发送。')
    expect(noticeText({ kind: 'delete' }, instant, 'dm')).toBe('🚫 已删除你的违规消息。')
    expect(noticeText({ kind: 'ban' }, instant, 'dm')).toBe('⛔ 已将你移出本群。')
    expect(noticeText({ kind: 'ban' }, instant, 'group')).toBe('⛔ 已将违规用户移出本群。')
    expect(noticeText({ kind: 'pass' }, instant, 'group')).toBe('')
  })
})
