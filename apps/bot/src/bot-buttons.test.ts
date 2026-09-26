import { asChatId, asUserId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import { createBotRuntime } from './bot.js'
import { contentHashOf } from './features.js'
import { deriveDecisionId, deriveEventId } from './ids.js'
import type { Logger } from './logger.js'

/**
 * bot 适配层的按钮文本审核测试。
 *
 * 走真实的 grammY `handleUpdate`：验证内联键盘的按钮文本确实被组合进分析文本并参与规则命中，
 * 而无按钮的消息行为不变。composition 的提取细节由 `features.test.ts` 单测覆盖，这里只验接线。
 * Bot API 用 grammY 的 transformer 拦截，测试不碰网络。
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
}

/** 组装真实 bot 与 API 拦截层。 */
function setup(): Harness {
  const store = createInMemoryRepos()
  const calls: RecordedCall[] = []

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
      case 'sendMessage':
        return { ok: true, result: { message_id: 1 } }
      case 'deleteMessage':
      case 'restrictChatMember':
      case 'banChatMember':
      case 'unbanChatMember':
        return { ok: true, result: true }
      default:
        throw new Error(`测试未拦截的 API 调用：${method}`)
    }
  }) as never)

  return { bot: runtime.bot, store, calls }
}

/**
 * 群消息更新。
 *
 * @param options 消息 id、文本与内联键盘按钮（按行给出）。
 * @returns 可交给 `bot.handleUpdate` 的更新。
 */
function groupMessageUpdate(options: { updateId: number; messageId: number; text: string; buttons?: string[][] }): Update {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: 1_758_000_000,
      chat: { id: GROUP_ID, type: 'supergroup', title: '测试群' },
      from: memberUser,
      text: options.text,
      ...(options.buttons === undefined ? {} : { reply_markup: inlineKeyboard(options.buttons) }),
    },
  } as Update
}

/** 编辑后的群消息更新（Telegram 的编辑更新必带 `edit_date`）。 */
function editedGroupMessageUpdate(options: {
  updateId: number
  messageId: number
  text: string
  buttons?: string[][]
  editDate: number
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
      ...(options.buttons === undefined ? {} : { reply_markup: inlineKeyboard(options.buttons) }),
    },
  } as Update
}

/** 内联键盘：每个参数是一行按钮的文本。 */
function inlineKeyboard(rows: string[][]): { inline_keyboard: Array<Array<{ text: string }>> } {
  return { inline_keyboard: rows.map((row) => row.map((text) => ({ text }))) }
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

describe('按钮文本进入审核（bot 接线）', () => {
  test('按钮标签命中规则：正文无关也处置，摘录含 (btn) 标记', async () => {
    const harness = setup()
    await seedChat(harness.store)

    await harness.bot.handleUpdate(
      groupMessageUpdate({ updateId: 1, messageId: 100, text: '今天上新', buttons: [['加微信']] }),
    )

    const eventId = deriveEventId(chatId, 100)
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(decision?.signals).toEqual([{ kind: 'rule-hit', ruleId: 'r-ad', score: 0.9 }])
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
    // 摘录取的是组合后的分析文本：按钮文本随消息一起留痕，复核时能看到判罚依据。
    expect(harness.store.sampleOf(eventId)).toBe('今天上新\n(btn)加微信')
  })

  test('标签边界不粘连：正文尾与标签头不拼成关键词，不处置', async () => {
    const harness = setup()
    await seedChat(harness.store)

    // 旧的全角段标记会被 normalize 拆掉，「加微」+「信点我」拼成「加微信」造成跨边界误判；
    // `(btn)` 保留边界，本条应直接放行。
    await harness.bot.handleUpdate(
      groupMessageUpdate({ updateId: 1, messageId: 103, text: '加微', buttons: [['信点我']] }),
    )

    const eventId = deriveEventId(chatId, 103)
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision?.action).toEqual({ kind: 'pass' })
    expect(decision?.signals).toEqual([])
    expect(harness.calls.some((call) => call.method === 'deleteMessage')).toBe(false)
  })

  test('无按钮的同文案消息行为不变：直接放行、不处置、无摘录', async () => {
    const harness = setup()
    await seedChat(harness.store)

    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 101, text: '今天上新' }))

    const eventId = deriveEventId(chatId, 101)
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision?.action).toEqual({ kind: 'pass' })
    expect(decision?.signals).toEqual([])
    expect(harness.calls.some((call) => call.method === 'deleteMessage')).toBe(false)
    expect(harness.store.sampleOf(eventId)).toBeNull()
  })

  test('编辑消息加上按钮后走同一组合口径：重新判定并处置', async () => {
    const harness = setup()
    await seedChat(harness.store)

    // 原消息正文正常：放行；评论/编辑共享的判别符里带内容哈希，编辑事件与它互不覆盖。
    await harness.bot.handleUpdate(groupMessageUpdate({ updateId: 1, messageId: 102, text: '今天上新' }))
    expect(
      (await harness.store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 102))))?.action,
    ).toEqual({ kind: 'pass' })

    const editDate = 1_758_000_100
    await harness.bot.handleUpdate(
      editedGroupMessageUpdate({ updateId: 2, messageId: 102, text: '今天上新', buttons: [['加微信']], editDate }),
    )

    const editEventId = deriveEventId(
      chatId,
      102,
      `edit:${editDate}:${contentHashOf('今天上新\n(btn)加微信').slice(0, 16)}`,
    )
    const decision = await harness.store.repos.decisions.findById(deriveDecisionId(editEventId))
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
  })
})
