import { asChatId, asUserId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos, type Repos } from '@skitarii/db'
import type { Bot } from 'grammy'
import type { Update, User } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import { createBotRuntime, TELEGRAM_ALLOWED_UPDATES } from './bot.js'
import type { Logger } from './logger.js'

/**
 * bot 适配层的频道/评论行为测试（Phase 3a）。
 *
 * 走真实的 grammY `Bot.handleUpdate`：更新先过中间件，再进管线与登记服务，
 * 验证的是「哪些更新会被处理、处理成什么」这一类只能在接线层看到的行为。
 * Bot API 用 grammY 的 transformer 拦截，测试不碰网络。
 */

const CHANNEL_ID = -1_001_111_111_111
const DISCUSSION_ID = -1_002_222_222_222
const ADMIN_ID = 7_000_000_001

const botUser = { id: 42, is_bot: true, first_name: 'Skitarii', username: 'skitarii_bot' }
const adminUser: User = { id: ADMIN_ID, is_bot: false, first_name: '管理员' }
const memberUser: User = { id: 7_000_000_002, is_bot: false, first_name: '普通用户' }

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
  logs: string[]
  /** 事件插入次数：不审的消息不允许落事件。 */
  eventInserts: () => number
}

/**
 * 组装真实 bot 与拦截层。
 *
 * @param getChat getChat 的返回值（缺省返回不带 linked_chat_id 的对象）。
 * @param wrapRepos 可选的仓储包装（用于注入故障，验证错误边界）。
 * @returns bot、内存仓储、API 调用记录与日志。
 */
function setup(
  getChat: (chatId: string) => unknown = () => ({}),
  wrapRepos?: (repos: Repos) => Repos,
): Harness {
  const store = createInMemoryRepos()
  const calls: RecordedCall[] = []
  const logs: string[] = []
  let eventInserts = 0

  const logger: Logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message) => logs.push(message),
  }

  const baseRepos = {
    ...store.repos,
    events: {
      ...store.repos.events,
      insert: async (event: Parameters<typeof store.repos.events.insert>[0]) => {
        eventInserts += 1
        await store.repos.events.insert(event)
      },
    },
  }
  const repos = wrapRepos === undefined ? baseRepos : wrapRepos(baseRepos)

  const runtime = createBotRuntime({
    botToken: '123456:TEST-TOKEN',
    repos,
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
        return { ok: true, result: getChat(String((payload as { chat_id: unknown }).chat_id)) }
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

  return { bot: runtime.bot, store, calls, logs, eventInserts: () => eventInserts }
}

/** bot 自己被加入/升管理员为频道的 `my_chat_member` 更新。 */
function channelMembershipUpdate(): Update {
  return {
    update_id: 1,
    my_chat_member: {
      chat: { id: CHANNEL_ID, type: 'channel', title: '测试频道' },
      from: botUser,
      date: 1_758_000_000,
      old_chat_member: { status: 'left', user: botUser },
      new_chat_member: { status: 'administrator', user: botUser },
    },
  } as Update
}

/** 频道帖更新。 */
function channelPostUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    channel_post: {
      message_id: updateId,
      date: 1_758_000_000,
      chat: { id: CHANNEL_ID, type: 'channel', title: '测试频道' },
      text,
    },
  } as Update
}

/**
 * 群消息更新。
 *
 * @param updateId 更新 id。
 * @param options 群、发送者、文本与形态开关。
 * @returns 可交给 `bot.handleUpdate` 的更新。
 */
function groupMessageUpdate(
  updateId: number,
  options: {
    chatId: number
    chatTitle: string
    messageId: number
    text: string
    from?: User
    /** 模拟频道自动转发到讨论组的根帖。 */
    autoForward?: boolean
    /** 模拟匿名管理员：没有 from，用 sender_chat 表示发言主体。 */
    senderChat?: boolean
  },
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: options.messageId,
      date: 1_758_000_000,
      chat: { id: options.chatId, type: 'supergroup', title: options.chatTitle },
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.senderChat === true
        ? { sender_chat: { id: options.chatId, type: 'supergroup', title: options.chatTitle } }
        : {}),
      ...(options.autoForward === true ? { is_automatic_forward: true } : {}),
      text: options.text,
    },
  } as Update
}

/** 预置一份群配置。 */
async function seedChat(
  store: InMemoryRepos,
  options: { chatId: ReturnType<typeof asChatId>; title: string; pattern: string },
): Promise<void> {
  await store.repos.chats.upsert({
    chatId: options.chatId,
    title: options.title,
    chatType: 'supergroup',
    linkedChatId: null,
    language: 'zh',
    rules: [{ id: 'r-delete', kind: 'keyword', pattern: options.pattern, score: 0.9, actionHint: 'delete', enabled: true }],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  })
}

describe('频道与 linked discussion（bot 接线）', () => {
  test('my_chat_member：bot 加入频道即登记，linked 讨论组从 getChat 补全', async () => {
    const harness = setup(() => ({ linked_chat_id: DISCUSSION_ID }))

    await harness.bot.handleUpdate(channelMembershipUpdate())

    const config = await harness.store.repos.chats.findByChatId(asChatId(String(CHANNEL_ID)))
    expect(config).toMatchObject({ chatType: 'channel', linkedChatId: String(DISCUSSION_ID) })
    expect(harness.calls.map((call) => call.method)).toEqual(['getChat'])
    expect(harness.eventInserts()).toBe(0)
  })

  test('channel_post：只登记元数据，不审帖、不落内容，且不为每条帖子请求 getChat', async () => {
    const harness = setup(() => ({ linked_chat_id: DISCUSSION_ID }))

    await harness.bot.handleUpdate(channelPostUpdate(2, '加微信 频道广告贴'))
    await harness.bot.handleUpdate(channelPostUpdate(3, '第二个频道贴'))

    const config = await harness.store.repos.chats.findByChatId(asChatId(String(CHANNEL_ID)))
    expect(config).toMatchObject({ chatType: 'channel', linkedChatId: String(DISCUSSION_ID) })
    // 只探测过一次 getChat；没有审核动作、没有消息事件。
    expect(harness.calls.filter((call) => call.method === 'getChat')).toHaveLength(1)
    expect(harness.calls.some((call) => call.method === 'deleteMessage' || call.method === 'sendMessage')).toBe(false)
    expect(harness.eventInserts()).toBe(0)
  })

  test('频道自动转发的根帖跳过：管理员发送的镜像贴不产生事件与处置', async () => {
    const harness = setup()
    const discussionId = asChatId(String(DISCUSSION_ID))
    await seedChat(harness.store, { chatId: discussionId, title: '测试讨论组', pattern: '加微信' })

    // 频道「以管理员身份发言」时，讨论组里的转发根帖 from 是真实管理员：
    // 若只按发送者过滤，这条会被当成管理员的群内发言处置。
    await harness.bot.handleUpdate(
      groupMessageUpdate(4, {
        chatId: DISCUSSION_ID,
        chatTitle: '测试讨论组',
        messageId: 100,
        text: '加微信 频道贴原文',
        from: adminUser,
        autoForward: true,
      }),
    )

    expect(harness.eventInserts()).toBe(0)
    expect(harness.calls.some((call) => call.method === 'deleteMessage')).toBe(false)
    const counts = await harness.store.repos.aggregates.countForDay(
      discussionId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(counts).toEqual({ messageCount: 0, actionCount: 0, appealCount: 0, overturnedCount: 0 })

    // 普通用户的评论没有该标志，照常审核并处置。
    await harness.bot.handleUpdate(
      groupMessageUpdate(5, {
        chatId: DISCUSSION_ID,
        chatTitle: '测试讨论组',
        messageId: 101,
        text: '加微信 评论广告',
        from: memberUser,
      }),
    )

    expect(harness.eventInserts()).toBe(1)
    const after = await harness.store.repos.aggregates.countForDay(
      discussionId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(after.messageCount).toBe(1)
    expect(after.actionCount).toBe(1)
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
  })

  test('讨论组使用自身规则：频道规则不覆盖评论判定', async () => {
    const harness = setup()
    const channelId = asChatId(String(CHANNEL_ID))
    const discussionId = asChatId(String(DISCUSSION_ID))
    await seedChat(harness.store, { chatId: channelId, title: '测试频道', pattern: '频道专属词' })
    await seedChat(harness.store, { chatId: discussionId, title: '测试讨论组', pattern: '评论违规词' })

    // 评论命中「频道规则」的词：讨论组自己的规则没有命中，直接放行。
    await harness.bot.handleUpdate(
      groupMessageUpdate(6, {
        chatId: DISCUSSION_ID,
        chatTitle: '测试讨论组',
        messageId: 102,
        text: '频道专属词',
        from: memberUser,
      }),
    )

    const benign = await harness.store.repos.aggregates.countForDay(
      discussionId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(benign.messageCount).toBe(1)
    expect(benign.actionCount).toBe(0)
    expect(harness.calls.some((call) => call.method === 'deleteMessage')).toBe(false)

    // 命中讨论组自己的词才处置。
    await harness.bot.handleUpdate(
      groupMessageUpdate(7, {
        chatId: DISCUSSION_ID,
        chatTitle: '测试讨论组',
        messageId: 103,
        text: '评论违规词',
        from: memberUser,
      }),
    )

    const actioned = await harness.store.repos.aggregates.countForDay(
      discussionId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(actioned.actionCount).toBe(1)
    expect(harness.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
  })

  test('没有 from 的群消息不审，但仍按 update 里的类型登记群', async () => {
    const harness = setup()
    const discussionId = asChatId(String(DISCUSSION_ID))

    await harness.bot.handleUpdate(
      groupMessageUpdate(8, {
        chatId: DISCUSSION_ID,
        chatTitle: '测试讨论组',
        messageId: 104,
        text: '加微信 匿名管理员消息',
        senderChat: true,
      }),
    )

    const config = await harness.store.repos.chats.findByChatId(discussionId)
    // 登记不依赖 from：类型来自 chat.type，标题来自 chat.title。
    expect(config).toMatchObject({ chatType: 'supergroup', title: '测试讨论组' })
    expect(config?.rules.length).toBeGreaterThan(0)
    // 没有可审发送者：不落事件、不处置。
    expect(harness.eventInserts()).toBe(0)
    expect(harness.calls.some((call) => call.method === 'deleteMessage')).toBe(false)
  })

  test('allowed_updates 覆盖既有与新增的处理类型（与 webhook 注册同源）', () => {
    expect(TELEGRAM_ALLOWED_UPDATES).toEqual([
      'message',
      'edited_message',
      'callback_query',
      'channel_post',
      'my_chat_member',
      'chat_member',
    ])
  })

  test('chat_member：频道订阅成员的加入写入新台账（bot 接线）', async () => {
    const harness = setup()
    const memberId = memberUser.id
    const update = {
      update_id: 10,
      chat_member: {
        chat: { id: CHANNEL_ID, type: 'channel', title: '测试频道' },
        from: adminUser,
        date: 1_758_000_000,
        old_chat_member: { status: 'left', user: memberUser },
        new_chat_member: { status: 'member', user: memberUser, until_date: 1_791_000_000 },
      },
    } as Update

    await harness.bot.handleUpdate(update)

    const member = await harness.store.repos.subscriptionMembers.find(asChatId(String(CHANNEL_ID)), asUserId(memberId))
    expect(member?.state).toBe('member')
    expect(member?.evidence).toBe('until_date')
    expect(member?.expiresAt?.toISOString()).toBe(new Date(1_791_000_000 * 1_000).toISOString())
    // 操作人没有被记成成员。
    const operator = await harness.store.repos.subscriptionMembers.find(
      asChatId(String(CHANNEL_ID)),
      asUserId(adminUser.id),
    )
    expect(operator).toBeNull()
  })

  test('chat_member 处理失败只在处理器内记受控码/ID，不冒泡到全局 catch 打印原始异常', async () => {
    const inviteLink = 'https://t.me/+abcdefghijklmnop'
    const harness = setup(undefined, (repos) => ({
      ...repos,
      subscriptionMembers: {
        ...repos.subscriptionMembers,
        applyEvent: async () => {
          throw new Error(`Bad Request: invite link ${inviteLink} invalid`)
        },
      },
    }))

    await harness.bot.handleUpdate({
      update_id: 12,
      chat_member: {
        chat: { id: CHANNEL_ID, type: 'channel', title: '测试频道' },
        from: adminUser,
        date: 1_758_000_000,
        old_chat_member: { status: 'left', user: memberUser },
        new_chat_member: { status: 'member', user: memberUser, until_date: 1_791_000_000 },
        invite_link: {
          invite_link: inviteLink,
          creator: adminUser,
          creates_join_request: false,
          is_primary: false,
          is_revoked: false,
        },
      },
    } as Update)

    const text = harness.logs.join('\n')
    // 事件与原始异常都不进日志：只留受控异常类型名与 ID。
    expect(text).not.toContain('https://t.me/+')
    expect(text).not.toContain('Bad Request')
    expect(text).not.toContain('处理更新失败')
    expect(text).toContain('订阅成员事件处理失败')
    expect(text).toContain(`chatId=${CHANNEL_ID}`)
    expect(text).toContain(`userId=${memberUser.id}`)
    expect(text).toContain('code=Error')
  })

  test('sender_chat 消息（匿名管理员）不审也不处置，但群仍登记', async () => {
    const harness = setup()
    const discussionId = asChatId(String(DISCUSSION_ID))

    await harness.bot.handleUpdate(
      groupMessageUpdate(11, {
        chatId: DISCUSSION_ID,
        chatTitle: '测试讨论组',
        messageId: 200,
        text: '加微信 匿名管理员消息',
        from: adminUser,
        senderChat: true,
      }),
    )

    const config = await harness.store.repos.chats.findByChatId(discussionId)
    expect(config).toMatchObject({ chatType: 'supergroup' })
    // 不落事件、不处置，避免误罚匿名管理员。
    expect(harness.eventInserts()).toBe(0)
    expect(harness.calls.some((call) => call.method === 'deleteMessage' || call.method === 'sendMessage')).toBe(false)
  })

  test('登记链路不打印异常：所有更新都被处理，无 catch 兜底日志', async () => {
    const harness = setup(() => ({ linked_chat_id: DISCUSSION_ID }))

    await harness.bot.handleUpdate(channelMembershipUpdate())
    await harness.bot.handleUpdate(channelPostUpdate(9, '频道贴'))

    expect(harness.logs.filter((message) => message.includes('处理更新失败'))).toEqual([])
  })
})
