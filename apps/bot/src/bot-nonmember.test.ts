import { asChatId, asUserId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import { GrammyError, type Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import { createBotRuntime } from './bot.js'
import { contentHashOf } from './features.js'
import { deriveDecisionId, deriveEventId } from './ids.js'
import type { Logger } from './logger.js'
import { NONMEMBER_INLINE_RULE_ID } from './pipeline.js'

/**
 * bot 适配层的非成员探测接线。
 *
 * 走真实的 grammY `handleUpdate`，用 transformer 拦截 Bot API：验证探测只在 `via_bot` 消息上发生、
 * 结果进入管线后走到非成员策略，而探测失败会回到原流程（失败开放）。探测本身的判定表由
 * `nonmember.test.ts` 单测覆盖；管线侧的策略分支由 `pipeline.test.ts` 覆盖。
 */

const GROUP_ID = -1_003_333_333_333
const USER_ID = 7_000_000_002
const chatId = asChatId(String(GROUP_ID))

const memberUser = { id: USER_ID, is_bot: false, first_name: '广告号' } as const

const botInfo = {
  id: 42,
  is_bot: true as const,
  first_name: 'Skitarii',
  username: 'skitarii_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

interface RecordedCall {
  method: string
  payload: unknown
}

interface Harness {
  bot: Bot
  store: InMemoryRepos
  calls: RecordedCall[]
  /** 设置 `getChatMember` 的结果：成员状态字符串，或要抛出的异常。 */
  setMemberProbe(outcome: string | Error): void
  /** 让 `banChatMember` 抛出指定错误（模拟 Telegram 拒绝封禁）。 */
  setBanFailure(error: Error): void
}

/** 组装真实 bot 与 API 拦截层；`getChatMember` 的返回由 `setMemberProbe` 控制。 */
function setup(): Harness {
  const store = createInMemoryRepos()
  const calls: RecordedCall[] = []
  let memberProbe: string | Error = 'member'
  let banFailure: Error | null = null

  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

  const runtime = createBotRuntime({
    botToken: '123456:TEST-TOKEN',
    repos: store.repos,
    llm: null,
    miniAppUrl: 'https://mini.example.com/app',
    ownerUserId: asUserId(1_000_000_001),
    ownerFeed: false,
    logger,
    now: () => new Date('2026-09-26T10:00:00Z'),
    sleep: async () => {},
  })

  runtime.bot.botInfo = botInfo
  runtime.bot.api.config.use((async (_prev: unknown, method: string, payload: unknown) => {
    calls.push({ method, payload })
    switch (method) {
      case 'getChat':
        return { ok: true, result: {} }
      case 'getChatMember': {
        if (memberProbe instanceof Error) throw memberProbe
        return { ok: true, result: { status: memberProbe } }
      }
      case 'sendMessage':
        return { ok: true, result: { message_id: 1 } }
      case 'deleteMessage':
      case 'restrictChatMember':
      case 'unbanChatMember':
        return { ok: true, result: true }
      case 'banChatMember': {
        if (banFailure !== null) throw banFailure
        return { ok: true, result: true }
      }
      default:
        throw new Error(`测试未拦截的 API 调用：${method}`)
    }
  }) as never)

  return {
    bot: runtime.bot,
    store,
    calls,
    setMemberProbe: (outcome) => {
      memberProbe = outcome
    },
    setBanFailure: (error) => {
      banFailure = error
    },
  }
}

/** 内联机器人用户（`message.via_bot`）。 */
const inlineBot = { id: 555_000_111, is_bot: true, first_name: 'Inline', username: 'inline_bot' } as const

/**
 * 群消息更新。
 *
 * @param options 消息 id、文本与是否为内联机器人代发。
 * @returns 可交给 `bot.handleUpdate` 的更新。
 */
function groupMessageUpdate(options: {
  updateId: number
  messageId: number
  text: string
  viaBot?: boolean
}): Update {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: 1_758_000_000,
      chat: { id: GROUP_ID, type: 'supergroup', title: '测试群' },
      from: memberUser,
      text: options.text,
      ...(options.viaBot === true ? { via_bot: inlineBot } : {}),
    },
  } as Update
}

/** 编辑后的群消息更新（Telegram 的编辑更新必带 `edit_date`）。 */
function editedGroupMessageUpdate(options: {
  updateId: number
  messageId: number
  text: string
  editDate: number
  viaBot?: boolean
}): Update {
  return {
    update_id: options.updateId,
    edited_message: {
      message_id: options.messageId,
      date: 1_758_000_000,
      edit_date: options.editDate,
      chat: { id: GROUP_ID, type: 'supergroup', title: '测试群' },
      from: memberUser,
      text: options.text,
      ...(options.viaBot === true ? { via_bot: inlineBot } : {}),
    },
  } as Update
}

/** 预置群配置：一条高分规则，命中即按 actionHint 直接删除。 */
async function seedChat(store: InMemoryRepos): Promise<void> {
  await store.repos.chats.upsert({
    chatId,
    title: '测试群',
    chatType: 'supergroup',
    linkedChatId: null,
    language: 'zh',
    rules: [{ id: 'r-ad', kind: 'keyword', pattern: '加微信', score: 0.9, actionHint: 'delete', enabled: true }],
    whitelist: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  })
}

/**
 * 预置一条带非成员标记的历史决策，把窗口计数推过封禁阈值。
 *
 * @param store 内存仓储。
 * @param index 决策序号（拼 id）。
 */
async function seedMarkerDecision(store: InMemoryRepos, index: number): Promise<void> {
  const suffix = String(index).padStart(4, '0')
  await store.repos.decisions.insert({
    id: `10000000-0000-4000-8000-00000000${suffix}`,
    eventId: `20000000-0000-4000-8000-00000000${suffix}`,
    chatId,
    userId: asUserId(USER_ID),
    action: { kind: 'delete' },
    score: 1,
    signals: [{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }],
    // 与 harness 的 now（10:00:00）同一个 1 小时窗口内。
    decidedAt: new Date('2026-09-26T09:30:00Z'),
    executed: true,
  })
}

describe('非成员探测（bot 接线）', () => {
  test('探测到 left：内联机器人消息走非成员策略（删除 + 标记信号）', async () => {
    const harness = setup()
    await seedChat(harness.store)
    harness.setMemberProbe('left')

    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 100, text: '加微信广告', viaBot: true }))

    const eventId = deriveEventId(chatId, 100)
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(eventId))
    // 正文本会命中 r-ad（0.9 直接删除），但策略分支不跑规则：信号只有标记、动作仍是删除。
    expect(decision?.signals).toEqual([{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }])
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
    expect(harness.calls.filter((call) => call.method === 'getChatMember')).toEqual([
      { method: 'getChatMember', payload: { chat_id: GROUP_ID, user_id: USER_ID } },
    ])
  })

  test('普通消息不探测成员：没有 getChatMember 调用', async () => {
    const harness = setup()
    await seedChat(harness.store)

    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 101, text: '今天上新' }))

    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 101)))
    expect(decision?.action).toEqual({ kind: 'pass' })
    expect(harness.calls.some((call) => call.method === 'getChatMember')).toBe(false)
  })

  test('探测失败（网络错误）失败开放：回到规则流程，不按非成员处置', async () => {
    const harness = setup()
    await seedChat(harness.store)
    harness.setMemberProbe(new Error('fetch failed'))

    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 102, text: '加微信广告', viaBot: true }))

    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 102)))
    expect(decision?.signals).toEqual([{ kind: 'rule-hit', ruleId: 'r-ad', score: 0.9 }])
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(harness.calls.filter((call) => call.method === 'getChatMember')).toHaveLength(1)
  })

  test('从未加入者被 400 PARTICIPANT_ID_INVALID 拒绝：视为非成员走策略', async () => {
    const harness = setup()
    await seedChat(harness.store)
    harness.setMemberProbe(
      new GrammyError(
        '调用失败',
        { ok: false, error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' },
        'getChatMember',
        {},
      ),
    )

    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 104, text: '加微信广告', viaBot: true }))

    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 104)))
    expect(decision?.signals).toEqual([{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }])
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
  })

  test('编辑消息同样探测：非成员的编辑消息按策略处置', async () => {
    const harness = setup()
    await seedChat(harness.store)
    harness.setMemberProbe('kicked')
    const editDate = 1_758_000_100

    await harness.bot.handleUpdate(
      editedGroupMessageUpdate({ updateId: 1, messageId: 103, text: '编辑后的广告', editDate, viaBot: true }),
    )

    const eventId = deriveEventId(chatId, 103, `edit:${editDate}:${contentHashOf('编辑后的广告').slice(0, 16)}`)
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision?.signals).toEqual([{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }])
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
    expect(harness.calls.filter((call) => call.method === 'getChatMember')).toHaveLength(1)
  })

  test('封禁被 400 USER_NOT_PARTICIPANT 拒绝：降级为删除，通知按「已删除」且 executed 置位', async () => {
    const harness = setup()
    await seedChat(harness.store)
    // 窗口内已有 3 条标记决策：本条走 ban。
    for (let index = 1; index <= 3; index += 1) {
      await seedMarkerDecision(harness.store, index)
    }
    harness.setMemberProbe('left')
    harness.setBanFailure(
      new GrammyError(
        '调用失败',
        { ok: false, error_code: 400, description: 'Bad Request: USER_NOT_PARTICIPANT' },
        'banChatMember',
        {},
      ),
    )

    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 105, text: '加微信广告', viaBot: true }))

    const eventId = deriveEventId(chatId, 105)
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(eventId))
    // 决策保留 ban（判定就是封禁），实际生效的是降级后的删除；终结处理不再重试，executed 照常回填。
    expect(decision?.action).toEqual({ kind: 'ban' })
    expect(decision?.executed).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'banChatMember')).toHaveLength(1)
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
    const notice = harness.calls.find((call) => call.method === 'sendMessage')
    // 通知文案按实际生效的动作：降级后说「已删除」，不能说「已移出」。
    expect(notice?.payload).toMatchObject({ text: expect.stringContaining('已删除') })
  })
})
