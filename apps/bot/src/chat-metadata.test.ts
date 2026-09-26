import { asChatId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { Api } from 'grammy'
import type { Chat, ChatMemberUpdated } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import { createChatMetadataService, type ChatMetadataService } from './chat-metadata.js'
import type { Logger } from './logger.js'

/**
 * 聊天元数据登记服务的行为测试（Phase 3a）。
 *
 * 覆盖四类风险：
 * 1. 登记走 `register`（冲突即放弃），绝不用默认配置覆盖 owner 已保存的规则；
 * 2. 刷新只走 `updateMetadata` 的单列路径，同样不碰规则；
 * 3. `getChat` 只在 linked 关系缺失时探测、有冷却窗口，失败降级且日志脱敏；
 * 4. 被移出/降权时不删除配置。
 */

const channelId = asChatId('-1001111111111')
const discussionId = asChatId('-1002222222222')
const groupId = asChatId('-1003333333333')

/** 记录日志的替身，便于断言「日志里没有秘密」。 */
function recordingLogger(messages: string[]): Logger {
  return {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  }
}

/** 构造频道对象。 */
function channelChat(): Chat {
  return { id: Number(channelId), type: 'channel', title: '测试频道' } as Chat
}

/** 构造讨论组（超级群）对象。 */
function discussionChat(): Chat {
  return { id: Number(discussionId), type: 'supergroup', title: '测试讨论组' } as Chat
}

/** 构造基础群对象。 */
function groupChat(): Chat {
  return { id: Number(groupId), type: 'group', title: '测试群' } as Chat
}

/** bot 自己。 */
const botUser = { id: 42, is_bot: true, first_name: 'Skitarii', username: 'skitarii_bot' }

/**
 * 构造 bot 自己的 `my_chat_member` 更新。
 *
 * @param chat 目标聊天。
 * @param status 新的成员状态。
 * @returns 更新对象（测试只需服务读取的字段）。
 */
function botMembershipUpdate(chat: Chat, status: 'member' | 'administrator' | 'left' | 'banned'): ChatMemberUpdated {
  return {
    chat,
    from: botUser,
    date: 1_758_000_000,
    old_chat_member: { status: 'left', user: botUser },
    new_chat_member: { status, user: botUser },
  } as ChatMemberUpdated
}

interface Harness {
  service: ChatMetadataService
  store: InMemoryRepos
  /** 每次 getChat 的目标（字符串形态）。 */
  getChatCalls: string[]
  /** 事件插入次数：频道帖与不审的消息不允许产生事件。 */
  eventInserts: number
  logs: string[]
}

/**
 * 组装服务与替身。
 *
 * @param getChat 每次 getChat 的返回值；抛出的 Error 会被原样抛给服务。
 * @param now 时间源。
 * @returns 服务、内存仓储、调用记录与日志。
 */
function setup(getChat: (chatId: string) => unknown = () => channelChat(), now: () => Date = () => new Date('2026-09-26T10:00:00Z')): Harness {
  const store = createInMemoryRepos()
  const logs: string[] = []
  const getChatCalls: string[] = []
  let eventInserts = 0

  const api = {
    getChat: async (chatId: number | string) => {
      getChatCalls.push(String(chatId))
      return getChat(String(chatId))
    },
  } as unknown as Pick<Api, 'getChat'>

  const repos = {
    ...store.repos,
    events: {
      ...store.repos.events,
      insert: async (event: Parameters<typeof store.repos.events.insert>[0]) => {
        eventInserts += 1
        await store.repos.events.insert(event)
      },
    },
  }

  const service = createChatMetadataService({ api, repos, logger: recordingLogger(logs), now })
  return {
    service,
    store,
    getChatCalls,
    get eventInserts() {
      return eventInserts
    },
    logs,
  }
}

describe('聊天元数据登记：my_chat_member', () => {
  test('bot 加入频道：登记 chatType=channel 与 getChat 返回的 linked 讨论组', async () => {
    const harness = setup(() => ({ ...channelChat(), linked_chat_id: Number(discussionId) }))

    await harness.service.handleMyChatMember(botMembershipUpdate(channelChat(), 'administrator'))

    const config = await harness.store.repos.chats.findByChatId(channelId)
    expect(config).toMatchObject({
      chatId: channelId,
      title: '测试频道',
      chatType: 'channel',
      linkedChatId: discussionId,
      language: 'zh',
    })
    // 新频道拿默认规则，而不是空规则集。
    expect(config?.rules.length).toBeGreaterThan(0)
    expect(harness.getChatCalls).toEqual([channelId])
    // 登记不审任何消息。
    expect(harness.eventInserts).toBe(0)
  })

  test('重复加入/升管理员：规则原样保留，linked 已有时不再请求 getChat', async () => {
    const harness = setup()
    await harness.store.repos.chats.register({
      chatId: channelId,
      title: '旧标题',
      chatType: 'supergroup',
      linkedChatId: discussionId,
      language: 'zh',
      rules: [{ id: 'r-owner', kind: 'keyword', pattern: '广告', score: 0.4, actionHint: 'delete', enabled: true }],
      whitelist: [],
      passThreshold: 0.2,
      llmThreshold: 0.6,
      muteDurationMinutes: 30,
    })

    await harness.service.handleMyChatMember(botMembershipUpdate(channelChat(), 'member'))

    const config = await harness.store.repos.chats.findByChatId(channelId)
    // 元数据刷新到 chat 里的真实值，owner 的规则与阈值一字不动。
    expect(config).toMatchObject({
      title: '测试频道',
      chatType: 'channel',
      linkedChatId: discussionId,
      rules: [{ id: 'r-owner', kind: 'keyword', pattern: '广告', score: 0.4, actionHint: 'delete', enabled: true }],
      passThreshold: 0.2,
      llmThreshold: 0.6,
      muteDurationMinutes: 30,
    })
    // linked 已登记：一条 getChat 都不发。
    expect(harness.getChatCalls).toEqual([])
  })

  test('被移出/降权：保留配置，不请求 getChat，也不删除行', async () => {
    const harness = setup()
    await harness.service.handleMyChatMember(botMembershipUpdate(channelChat(), 'administrator'))

    await harness.service.handleMyChatMember(botMembershipUpdate(channelChat(), 'left'))

    expect(await harness.store.repos.chats.findByChatId(channelId)).not.toBeNull()
    expect(harness.getChatCalls).toHaveLength(1)
  })

  test('基础群不探测 getChat（没有 linked 概念），chatType=group 直接落库', async () => {
    const harness = setup()

    await harness.service.handleMyChatMember(botMembershipUpdate(groupChat(), 'member'))

    expect(harness.getChatCalls).toEqual([])
    expect(await harness.store.repos.chats.findByChatId(groupId)).toMatchObject({ chatType: 'group', linkedChatId: null })
  })
})

describe('聊天元数据登记：channel_post', () => {
  test('未知频道只登记元数据：不产事件、不落帖子内容', async () => {
    const harness = setup(() => ({ ...channelChat(), linked_chat_id: Number(discussionId) }))

    await harness.service.handleChannelPost(channelChat())

    const config = await harness.store.repos.chats.findByChatId(channelId)
    expect(config).toMatchObject({ chatType: 'channel', linkedChatId: discussionId })
    // 频道帖不审、不落 message_events。
    expect(harness.eventInserts).toBe(0)
  })

  test('getChat 失败可恢复降级：登记照常，linked 留空，日志脱敏（不含 token）', async () => {
    const harness = setup(() => {
      throw new Error('Network request for https://api.telegram.org/bot123456:SECRET-TOKEN/getChat failed')
    })

    await harness.service.handleChannelPost(channelChat())

    const config = await harness.store.repos.chats.findByChatId(channelId)
    expect(config).toMatchObject({ chatType: 'channel', linkedChatId: null })
    expect(harness.eventInserts).toBe(0)
    // 只记类型名：错误 message 里可能带请求 URL（含 token），不允许进日志。
    expect(harness.logs.some((message) => message.includes('getChat 失败') && message.includes(channelId))).toBe(true)
    expect(harness.logs.join('\n')).not.toContain('SECRET-TOKEN')
  })

  test('冷却窗口内不重复请求 getChat：第二次频道帖不再探测', async () => {
    const harness = setup(() => {
      throw new Error('network down')
    })

    await harness.service.handleChannelPost(channelChat())
    await harness.service.handleChannelPost(channelChat())

    expect(harness.getChatCalls).toHaveLength(1)
  })

  test('标题变化只走元数据刷新：规则不被覆盖', async () => {
    const harness = setup(() => ({ ...channelChat(), linked_chat_id: Number(discussionId) }))
    await harness.service.handleChannelPost(channelChat())

    await harness.service.handleChannelPost({ ...channelChat(), title: '改过的频道名' } as Chat)

    const config = await harness.store.repos.chats.findByChatId(channelId)
    expect(config?.title).toBe('改过的频道名')
    expect(config?.rules.length).toBeGreaterThan(0)
    // linked 已登记，第二次不发 getChat。
    expect(harness.getChatCalls).toHaveLength(1)
  })
})

describe('聊天元数据登记：消息路径的兜底与 linked 补写', () => {
  test('syncLinkedChat 为讨论组补上指向频道的关系', async () => {
    const harness = setup(() => ({ ...discussionChat(), linked_chat_id: Number(channelId) }))
    await harness.store.repos.chats.register({
      chatId: discussionId,
      title: '测试讨论组',
      chatType: 'supergroup',
      linkedChatId: null,
      language: 'zh',
      rules: [],
      whitelist: [],
      passThreshold: 0.3,
      llmThreshold: 0.8,
      muteDurationMinutes: 60,
    })

    await harness.service.syncLinkedChat(discussionChat(), null)

    expect((await harness.store.repos.chats.findByChatId(discussionId))?.linkedChatId).toBe(channelId)
  })

  test('已有 linked 关系时 syncLinkedChat 直接跳过（不发 getChat）', async () => {
    const harness = setup()

    await harness.service.syncLinkedChat(discussionChat(), channelId)

    expect(harness.getChatCalls).toEqual([])
  })

  test('syncLinkedChat 失败静默降级：只记脱敏日志，不抛错', async () => {
    const harness = setup(() => {
      throw new Error('bot token 123456:SECRET-TOKEN')
    })
    await harness.store.repos.chats.register({
      chatId: discussionId,
      title: '测试讨论组',
      chatType: 'supergroup',
      linkedChatId: null,
      language: 'zh',
      rules: [],
      whitelist: [],
      passThreshold: 0.3,
      llmThreshold: 0.8,
      muteDurationMinutes: 60,
    })

    await expect(harness.service.syncLinkedChat(discussionChat(), null)).resolves.toBeUndefined()
    expect(harness.logs.join('\n')).not.toContain('SECRET-TOKEN')
  })

  test('ensureRegistered 登记未知群/频道且与 from 无关（基础群纯登记，不发 getChat）', async () => {
    const harness = setup()

    await harness.service.ensureRegistered(groupChat())

    expect(await harness.store.repos.chats.findByChatId(groupId)).toMatchObject({ chatType: 'group', linkedChatId: null })
    expect(harness.getChatCalls).toEqual([])
    expect(harness.eventInserts).toBe(0)
  })
})
