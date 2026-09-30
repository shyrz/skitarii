import { asChatId, asUserId, type ModerationDecision } from '@skitarii/core'
import { GrammyError } from 'grammy'
import { describe, expect, test } from 'vitest'
import { createActionExecutor, GROUP_NOTICE_TTL_MS, noticeText, type Schedule } from './executor.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createInMemoryRepos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { createRecordingApi, type RecordingApi } from './recording-api.js'
import { retryAfterOf, backoffDelayMs } from './telegram-call.js'

/** 静默日志，测试里不关心输出。 */
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)

/**
 * 通知消息 id：私聊与群内刻意取不同值。
 *
 * 录制替身的默认返回值（`message_id: 1`）会被两条投递路径共用，撤回/删除断言就可能张冠李戴——
 * 换了落点也照样通过。桩里显式区分后，断言 message id 即可验证落点与消息的一致性。
 */
const DM_NOTICE_ID = 11
const GROUP_NOTICE_ID = 22

/** 一次被安排、尚未执行的定时任务。 */
interface ScheduledTask {
  delayMs: number
  task: () => Promise<void>
}

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
 * @param overrides 覆盖 api 处理器与日志等。
 * @returns 执行器、录制 api、内存仓储与依赖观察口。
 */
function setup(
  overrides: {
    handlers?: Parameters<typeof createRecordingApi>[0]
    logger?: Logger
    notifyOwnerFailure?: (decision: ModerationDecision, description: string) => Promise<void>
    schedule?: Schedule
  } = {},
) {
  const recording: RecordingApi = createRecordingApi(overrides.handlers ?? {})
  const store = createInMemoryRepos()
  const idempotency = createIdempotencyRegistry()
  const sleeps: number[] = []
  const scheduled: ScheduledTask[] = []
  const executor = createActionExecutor({
    api: recording.api,
    repos: store.repos,
    idempotency,
    miniAppUrl: 'https://mini.example.com/app',
    logger: overrides.logger ?? silentLogger,
    now: () => new Date('2026-09-23T10:00:00Z'),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    schedule:
      overrides.schedule ??
      ((delayMs, task) => {
        scheduled.push({ delayMs, task })
      }),
    notifyOwnerFailure: overrides.notifyOwnerFailure,
  })

  return { executor, recording, store, idempotency, sleeps, scheduled }
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

  test('删除动作先投递通知、后执行删除（群内回复需要消息还在）', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 私聊尝试 → 群内回复式通知 → 删除被处置消息：通知必须早于删除，回复才指得向那条消息。
    expect(recording.calls.map((call) => call.method)).toEqual(['sendMessage', 'sendMessage', 'deleteMessage'])
    expect(recording.calls[1]?.args[0]).toBe(chatId)
    expect(recording.calls[2]?.args).toEqual([chatId, 42])
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
    const { executor, recording, store } = setup({
      handlers: { sendMessage: () => ({ message_id: DM_NOTICE_ID }) },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 只有一条私聊通知，群内没有任何消息。
    expect(recording.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1)
    expect(recording.lastArgsOf('sendMessage')?.[0]).toBe(userId)
    // 引用落库，供申诉生命周期编辑。
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({
      chatId: String(userId),
      messageId: DM_NOTICE_ID,
    })
  })

  test.each([
    [403, "Forbidden: bot can't initiate conversation with a user"],
    [403, 'Forbidden: bot was blocked by the user'],
    [400, 'Bad Request: chat not found'],
  ])('私聊不可达（%i %s）→ 回退群内通知', async (errorCode, description) => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError('failed', { ok: false, error_code: errorCode, description }, 'sendMessage', {})
          }
          return { message_id: GROUP_NOTICE_ID }
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
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({ chatId, messageId: GROUP_NOTICE_ID })
  })

  test('群内回退通知回复被处置消息，并容忍回复目标已不在', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    const groupCall = recording.calls.find((call) => call.method === 'sendMessage' && call.args[0] === chatId)
    expect(groupCall?.args[2]).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: '提起申诉' }]] },
      // 回复被处置消息；allow_sending_without_reply 让消息已被删（如降级删除）时通知照发。
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    })
  })

  test('bot 目标私聊必然失败（chat not found）→ 回退群内通知，不再静默丢弃', async () => {
    const botTarget = asUserId(7_000_000_003)
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === botTarget) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
      },
    })
    const decision = decisionFixture({ userId: botTarget })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 对 bot 的私聊是平台级必然失败：通知要落到群里，处置本身照常完成。
    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(chatId)
    expect(String(args[1])).toBe('🚫 已删除一条违规消息。')
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({ chatId, messageId: GROUP_NOTICE_ID })
  })

  test('群内回退通知：发送成功后安排 5 分钟定时删除，触发任务即删除该条通知', async () => {
    const { executor, recording, store, scheduled } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(GROUP_NOTICE_TTL_MS).toBe(5 * 60_000)
    expect(scheduled).toHaveLength(1)
    const pending = scheduled[0]
    expect(pending?.delayMs).toBe(GROUP_NOTICE_TTL_MS)

    await pending?.task()

    // 删除的是群内通知（GROUP_NOTICE_ID），不是被处置的原消息（42）。
    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, GROUP_NOTICE_ID])
  })

  test('定时删除遇到「消息已不在」：按达成处理，info 且不抛', async () => {
    const infos: string[] = []
    const logger: Logger = {
      info: (message) => {
        infos.push(message)
      },
      warn: () => {},
      error: () => {},
    }
    const { executor, store, scheduled } = setup({
      logger,
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
        deleteMessage: (_target, messageId) => {
          if (messageId === GROUP_NOTICE_ID) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
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

    await expect(scheduled[0]?.task()).resolves.toBeUndefined()

    expect(infos).toContainEqual(expect.stringContaining('群内通知已不在'))
  })

  test('定时删除遇到其他错误：warn 且不抛', async () => {
    const warnings: string[] = []
    const logger: Logger = {
      info: () => {},
      warn: (message) => {
        warnings.push(message)
      },
      error: () => {},
    }
    const { executor, store, scheduled } = setup({
      logger,
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
        deleteMessage: (_target, messageId) => {
          if (messageId === GROUP_NOTICE_ID) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the chat' },
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

    await expect(scheduled[0]?.task()).resolves.toBeUndefined()

    expect(warnings).toContainEqual(expect.stringContaining('群内通知删除失败'))
  })

  test('私聊通知成功：不安排定时删除', async () => {
    const { executor, store, scheduled } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(scheduled).toHaveLength(0)
  })

  test('群内通知发送失败：不安排定时删除', async () => {
    const { executor, store, scheduled } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          throw new Error('群内发送失败')
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(scheduled).toHaveLength(0)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('私聊其余失败按通知可丢处理，不回退群内', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: () => {
          throw new GrammyError(
            'failed',
            { ok: false, error_code: 400, description: 'Bad Request: message text is empty' },
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

  test('已投递过通知的删除决策：跳过重复投递，照常执行删除与收尾', async () => {
    const { executor, recording, store, scheduled } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)
    // 模拟上次运行发出私聊通知后、回填 executed 前中断（崩溃重跑 / 补偿重投递）。
    await store.repos.decisions.markNoticeSent(decision.id, String(userId), DM_NOTICE_ID)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('sendMessage')).toBe(0)
    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, 42])
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
    // 引用保持原样：没有被新通知覆盖。私聊句柄不安排 TTL。
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({
      chatId: String(userId),
      messageId: DM_NOTICE_ID,
    })
    expect(scheduled).toHaveLength(0)
  })

  test('ref-guard 命中群内句柄：重挂 TTL，补偿重试后通知仍会按时删除', async () => {
    const { executor, recording, store, scheduled } = setup()
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)
    // 上次投递了群内通知但 TTL 没挂上（投递后、调度前崩溃），或进程已重启（计时只活在内存里）。
    await store.repos.decisions.markNoticeSent(decision.id, chatId, GROUP_NOTICE_ID)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('sendMessage')).toBe(0)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delayMs).toBe(GROUP_NOTICE_TTL_MS)

    await scheduled[0]?.task()

    // 删除的是重挂 TTL 的那条群内通知，不是被处置的原消息（42）。
    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, GROUP_NOTICE_ID])
  })

  test('ref-guard 命中的引用落点无法识别：warn 后忽略，不撤回也不重挂 TTL', async () => {
    const warnings: string[] = []
    const logger: Logger = {
      info: () => {},
      warn: (message) => {
        warnings.push(message)
      },
      error: () => {},
    }
    const { executor, recording, store, scheduled } = setup({
      logger,
      handlers: {
        sendMessage: () => ({ message_id: DM_NOTICE_ID }),
        deleteMessage: (_target, messageId) => {
          if (messageId === 42) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
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
    // 脏引用：落点既不是群也不是当事人（例如串了别的决策）。
    await store.repos.decisions.markNoticeSent(decision.id, '9000000001', 55)

    await executor.execute(decision, { messageId: 42 })

    expect(warnings).toContainEqual(expect.stringContaining('通知引用落点无法识别'))
    // 不拿脏引用去删陌生消息：撤回只针对本次投递的通知（DM_NOTICE_ID），且删除动作先试过 42。
    const deletedMessageIds = recording.calls
      .filter((call) => call.method === 'deleteMessage')
      .map((call) => call.args[1])
    expect(deletedMessageIds).toEqual([42, DM_NOTICE_ID])
    expect(scheduled).toHaveLength(0)
    // 脏引用被本次投递的新落点覆盖，供后续申诉编辑使用。
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({
      chatId: String(userId),
      messageId: DM_NOTICE_ID,
    })
  })

  test('删除非终结失败后重试：不重复发通知，重试成功即收口', async () => {
    let attempts = 0
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: () => ({ message_id: DM_NOTICE_ID }),
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
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    // 第一次：通知已发（声称已删除）、删除失败（非终结），决策保持未执行等补偿重试。
    await expect(executor.execute(decision, { messageId: 42 })).rejects.toThrow('Forbidden')
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: false })
    expect(await store.repos.decisions.findNoticeRef(decision.id)).toEqual({
      chatId: String(userId),
      messageId: DM_NOTICE_ID,
    })

    // 补偿重试：ref-guard 命中，跳过重复投递；删除成功，回填 executed 收口。
    await executor.execute(decision, { messageId: 42 })

    expect(recording.countOf('sendMessage')).toBe(1)
    expect(recording.countOf('deleteMessage')).toBe(2)
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
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

  test('警示/禁言/封禁保持先动作后通知的顺序', async () => {
    // 三种动作都不删消息，被处置消息还在，群内回复照常成立，因此不需要提前通知。
    const muteSetup = setup()
    const mute = decisionFixture({ action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') } })
    await muteSetup.store.repos.decisions.insert(mute)
    await muteSetup.executor.execute(mute, { messageId: 42 })
    expect(muteSetup.recording.calls.map((call) => call.method)).toEqual(['restrictChatMember', 'sendMessage'])

    const banSetup = setup()
    const ban = decisionFixture({ action: { kind: 'ban' } })
    await banSetup.store.repos.decisions.insert(ban)
    await banSetup.executor.execute(ban, { messageId: 42 })
    expect(banSetup.recording.calls.map((call) => call.method)).toEqual(['banChatMember', 'sendMessage'])
  })

  test('放行决策不碰 Telegram，只回填已执行', async () => {
    const { executor, recording, store } = setup()
    const decision = decisionFixture({ action: { kind: 'pass' }, score: 0.1 })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    expect(recording.calls).toHaveLength(0)
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

  test('其他 400 视为终结：撤回动作前发出的通知，不误报已处置', async () => {
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: () => ({ message_id: DM_NOTICE_ID }),
        deleteMessage: (_target, messageId) => {
          if (messageId === 42) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
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

    // 动作前先发了私聊通知（DM_NOTICE_ID），被终结拒绝后撤回；不误报已处置，也不留下失效的申诉入口。
    expect(recording.calls.map((call) => call.method)).toEqual(['sendMessage', 'deleteMessage', 'deleteMessage'])
    expect(recording.lastArgsOf('deleteMessage')).toEqual([userId, DM_NOTICE_ID])
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('删除被终结性拒绝：撤回已投递的群内通知，owner 失败通知照旧', async () => {
    const failures: string[] = []
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
        deleteMessage: (_target, messageId) => {
          if (messageId === 42) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
              'deleteMessage',
              {},
            )
          }
          return { ok: true }
        },
      },
      notifyOwnerFailure: async (_decision, description) => {
        failures.push(description)
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 群内回复式通知（GROUP_NOTICE_ID）先落群、删除被拒后立即撤回；owner 失败私聊照旧。
    expect(recording.calls.map((call) => call.method)).toEqual([
      'sendMessage',
      'sendMessage',
      'deleteMessage',
      'deleteMessage',
    ])
    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, GROUP_NOTICE_ID])
    expect(failures).toEqual(['Bad Request: not enough rights to delete the message'])
    expect(await store.repos.decisions.findById(decision.id)).toMatchObject({ executed: true })
  })

  test('撤回通知失败只记日志，不影响 executed 回填', async () => {
    const warnings: string[] = []
    const logger: Logger = {
      info: () => {},
      warn: (message) => {
        warnings.push(message)
      },
      error: () => {},
    }
    const { executor, store } = setup({
      logger,
      handlers: {
        sendMessage: () => ({ message_id: DM_NOTICE_ID }),
        deleteMessage: (_target, messageId) => {
          if (messageId === 42) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
              'deleteMessage',
              {},
            )
          }
          // 撤回私聊通知时失败（如对方拉黑 bot）。
          throw new GrammyError(
            'failed',
            { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
            'deleteMessage',
            {},
          )
        },
      },
    })
    const decision = decisionFixture()
    await store.repos.decisions.insert(decision)

    await expect(executor.execute(decision, { messageId: 42 })).resolves.toBeUndefined()

    expect(warnings).toContainEqual(expect.stringContaining('未生效处置的通知撤回失败'))
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

  test('禁言降级为删除：通知在动作后照发，回复目标已删也不被拦', async () => {
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
        sendMessage: (target) => {
          if (target === userId) {
            throw new GrammyError(
              'failed',
              { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
              'sendMessage',
              {},
            )
          }
          return { message_id: GROUP_NOTICE_ID }
        },
      },
    })
    const decision = decisionFixture({ action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') } })
    await store.repos.decisions.insert(decision)

    await executor.execute(decision, { messageId: 42 })

    // 顺序不变（动作→通知），但降级删除已经把消息 42 删了：回复参数保留 allow_sending_without_reply，
    // Telegram 不会因「回复目标不存在」拒绝，通知照发、只是丢链接；文案按实际生效的删除说。
    expect(recording.calls.map((call) => call.method)).toEqual([
      'restrictChatMember',
      'deleteMessage',
      'sendMessage',
      'sendMessage',
    ])
    const groupCall = recording.calls.find((call) => call.method === 'sendMessage' && call.args[0] === chatId)
    expect(String(groupCall?.args[1])).toBe('🚫 已删除一条违规消息。')
    expect(groupCall?.args[2]).toMatchObject({
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    })
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

  test('终结性拒绝时私聊 owner：带决策与拒绝原因，已撤回动作前的通知', async () => {
    const failures: Array<{ decision: ModerationDecision; description: string }> = []
    const { executor, recording, store } = setup({
      handlers: {
        sendMessage: () => ({ message_id: DM_NOTICE_ID }),
        deleteMessage: (_target, messageId) => {
          if (messageId === 42) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
              'deleteMessage',
              {},
            )
          }
          return { ok: true }
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
    // 动作前发的私聊通知（DM_NOTICE_ID）被撤回，群里不留假消息；决策仍是终态。
    expect(recording.lastArgsOf('deleteMessage')).toEqual([userId, DM_NOTICE_ID])
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
        deleteMessage: (_target, messageId) => {
          if (messageId === 42) {
            throw new GrammyError(
              'Call to deleteMessage failed',
              { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete the message' },
              'deleteMessage',
              {},
            )
          }
          return { ok: true }
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
