import { asChatId, asUserId, type ChatId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { ChatFullInfo, ChatMember } from 'grammy/types'
import {
  createSubscriptionLink,
  getSubscriptionChannel,
  listSubscriptionChannels,
  listSubscriptionLinks,
  listSubscriptionMembers,
  renameSubscriptionLink,
  revokeSubscriptionLink,
  TelegramSubscriptionError,
  type SubscriptionApiDeps,
  type SubscriptionTelegramPort,
} from './subscriptions.js'

/**
 * 订阅 owner HTTP 契约测试（spec §5/§6/§8）。
 *
 * 走纯函数处理层 + 内存仓储 + 假 Telegram 端口：验证状态码/载荷、幂等与不确定结果的语义、
 * 条件写冲突、稳定分页、凭据与日志安全、以及「不调用任何权限处置接口」。
 */

const BOT_TOKEN = '123456:TEST-TOKEN-abc'
const OWNER_ID = 1_000_000_001
const BOT_ID = 42
const CHAT_ID = '-1001234567890'
const OTHER_CHAT_ID = '-1009999999999'
const GROUP_ID = '-1005555555555'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const LINK_ID = '11111111-1111-4111-8111-111111111111'
const INVITE_LINK = 'https://t.me/+abcdefghijklmnop'

const chatId = asChatId(CHAT_ID)
const otherChatId = asChatId(OTHER_CHAT_ID)
const groupId = asChatId(GROUP_ID)

let currentNow = new Date('2026-09-26T12:00:00Z')

/** 记录日志的替身。 */
interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
}

/** 测试内可变时钟。 */
function advance(ms: number): void {
  currentNow = new Date(currentNow.getTime() + ms)
}

/**
 * 生成 initData（与 panel.test.ts 同一套独立实现）。
 *
 * @param userId 用户 id。
 * @param at 签名时刻。
 * @returns 查询串形态 initData。
 */
function signInitData(userId: number, at: Date = currentNow): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(at.getTime() / 1_000)),
    user: JSON.stringify({ id: userId, first_name: '测试' }),
  }
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  return [...Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`), `hash=${hash}`].join('&')
}

const ownerInitData = (): string => signInitData(OWNER_ID)
const strangerInitData = (): string => signInitData(7_000_000_009)

/**
 * 复刻服务端的规范化创建请求摘要（测试用它给同一 requestId 预置 creating 行）。
 *
 * @param name 链接名。
 * @param priceStars 价格。
 * @param targetChatId 频道。
 * @returns sha256 摘要。
 */
function requestHashOf(name: string, priceStars: number, targetChatId: string = CHAT_ID): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ownerUserId: OWNER_ID,
        chatId: targetChatId,
        name,
        priceStars,
        periodSeconds: 2_592_000,
      }),
    )
    .digest('hex')
}

/** 假 Telegram 端口的调用记录与方法处理器。 */
interface FakePort {
  port: SubscriptionTelegramPort
  calls: Array<{ method: string; args: unknown[] }>
  handlers: {
    create: (input: { chatId: string; name: string; periodSeconds: number; priceStars: number }) => unknown
    edit: (input: { chatId: string; inviteLink: string; name: string }) => unknown
    revoke: (input: { chatId: string; inviteLink: string }) => unknown
    getChat: (chatId: string) => unknown
    getChatMember: (chatId: string, userId: number) => unknown
  }
}

/** 默认成功结果。 */
function defaultHandlers(): FakePort['handlers'] {
  return {
    create: () => ({ inviteLink: INVITE_LINK, name: '月度', isRevoked: false }),
    edit: () => ({ inviteLink: INVITE_LINK, name: '改名', isRevoked: false }),
    revoke: () => ({ inviteLink: INVITE_LINK, isRevoked: true }),
    getChat: () =>
      ({ id: Number(CHAT_ID), type: 'channel', title: '示例频道', username: 'demo_channel' }) as ChatFullInfo,
    getChatMember: () =>
      ({
        status: 'administrator',
        user: { id: BOT_ID, is_bot: true, first_name: 'Skitarii' },
        can_be_edited: false,
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: true,
        can_manage_video_chats: true,
        can_restrict_members: true,
        can_promote_members: false,
        can_change_info: true,
        can_invite_users: true,
        can_post_stories: false,
        can_edit_stories: false,
        can_delete_stories: false,
      }) as ChatMember,
  }
}

/** 组装依赖与假端口。 */
function setup(): {
  deps: SubscriptionApiDeps
  store: InMemoryRepos
  fake: FakePort
  logs: LogEntry[]
} {
  const store = createInMemoryRepos()
  const calls: FakePort['calls'] = []
  const handlers = defaultHandlers()
  const fake: FakePort = {
    calls,
    handlers,
    port: {
      createChatSubscriptionInviteLink: async (input) => {
        calls.push({ method: 'createChatSubscriptionInviteLink', args: [input] })
        return (await handlers.create(input)) as { inviteLink: string; name: string | null; isRevoked: boolean }
      },
      editChatSubscriptionInviteLink: async (input) => {
        calls.push({ method: 'editChatSubscriptionInviteLink', args: [input] })
        return (await handlers.edit(input)) as { inviteLink: string; name: string | null; isRevoked: boolean }
      },
      revokeChatInviteLink: async (input) => {
        calls.push({ method: 'revokeChatInviteLink', args: [input] })
        return (await handlers.revoke(input)) as { inviteLink: string; isRevoked: boolean }
      },
      getChat: async (targetChatId) => {
        calls.push({ method: 'getChat', args: [targetChatId] })
        return (await handlers.getChat(targetChatId)) as ChatFullInfo
      },
      getChatMember: async (targetChatId, userId) => {
        calls.push({ method: 'getChatMember', args: [targetChatId, userId] })
        return (await handlers.getChatMember(targetChatId, userId)) as ChatMember
      },
    },
  }

  const logs: LogEntry[] = []

  const deps: SubscriptionApiDeps = {
    repos: store.repos,
    botToken: BOT_TOKEN,
    ownerUserId: asUserId(OWNER_ID),
    botUserId: () => asUserId(BOT_ID),
    telegram: fake.port,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    now: () => currentNow,
    telegramTimeoutMs: 50,
  }

  return { deps, store, fake, logs }
}

/** 预置频道/群配置。 */
async function seedChats(store: InMemoryRepos): Promise<void> {
  const base = {
    language: 'zh' as const,
    rules: [],
    whitelist: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  }
  await store.repos.chats.upsert({
    ...base,
    chatId,
    title: '示例频道',
    chatType: 'channel',
    linkedChatId: asChatId(OTHER_CHAT_ID),
  })
  await store.repos.chats.upsert({ ...base, chatId: otherChatId, title: '另一个频道', chatType: 'channel', linkedChatId: null })
  await store.repos.chats.upsert({ ...base, chatId: groupId, title: '普通群', chatType: 'supergroup', linkedChatId: null })
}

/** 直接预置一条 active 链接。 */
async function seedActiveLink(
  store: InMemoryRepos,
  options: { chatId?: ChatId; id?: string; name?: string; createdAt?: Date } = {},
): Promise<void> {
  const targetChat = options.chatId ?? chatId
  const id = options.id ?? LINK_ID
  await store.repos.subscriptionLinks.reserveCreate({
    id,
    chatId: targetChat,
    ownerUserId: asUserId(OWNER_ID),
    requestId: REQUEST_ID,
    requestHash: requestHashOf(options.name ?? '月度', 500, String(targetChat)),
    name: options.name ?? '月度',
    priceStars: 500,
    periodSeconds: 2_592_000,
    createdAt: options.createdAt ?? new Date('2026-09-26T10:00:00Z'),
  })
  await store.repos.subscriptionLinks.finishCreate(id, {
    inviteLink: INVITE_LINK,
    finishedAt: new Date('2026-09-26T10:00:01Z'),
  })
}

/** 创建请求体。 */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: REQUEST_ID, name: '月度', priceStars: 500, ...overrides }
}

describe('订阅端点鉴权', () => {
  test('缺失/无效/过期 initData 一律 401，验签通过但非 owner 403', async () => {
    const { deps } = setup()
    const requests = [
      () => listSubscriptionChannels(deps, { initData: null, limit: null, cursor: null }),
      () => getSubscriptionChannel(deps, { chatId: CHAT_ID, initData: null }),
      () => listSubscriptionLinks(deps, { chatId: CHAT_ID, initData: null, limit: null, cursor: null }),
      () => listSubscriptionMembers(deps, { chatId: CHAT_ID, initData: null, limit: null, cursor: null }),
      () => createSubscriptionLink(deps, { chatId: CHAT_ID, initData: null, body: createBody() }),
      () =>
        renameSubscriptionLink(deps, { chatId: CHAT_ID, linkId: LINK_ID, initData: null, body: { name: 'x', expectedVersion: 1 } }),
      () => revokeSubscriptionLink(deps, { chatId: CHAT_ID, linkId: LINK_ID, initData: null, body: { expectedVersion: 1 } }),
    ]

    for (const request of requests) {
      const result = await request()
      expect(result.status).toBe(401)
      expect(result.body).toMatchObject({ error: 'init_data_invalid', retryable: false })
    }

    // 过期（auth_date 超过 1 小时）。
    const expired = signInitData(OWNER_ID, new Date(currentNow.getTime() - 2 * 60 * 60 * 1_000))
    expect((await listSubscriptionChannels(deps, { initData: expired, limit: null, cursor: null })).status).toBe(401)

    // 篡改 hash 的无效凭据。
    const tampered = ownerInitData().replace(/hash=.*/u, 'hash=deadbeef')
    expect((await listSubscriptionChannels(deps, { initData: tampered, limit: null, cursor: null })).status).toBe(401)

    const stranger = strangerInitData()
    expect((await listSubscriptionChannels(deps, { initData: stranger, limit: null, cursor: null })).status).toBe(403)
    expect((await getSubscriptionChannel(deps, { chatId: CHAT_ID, initData: stranger })).body).toMatchObject({
      error: 'forbidden',
    })
  })

  test('创建 body 里的 initData 属于额外字段：严格拒绝（凭据只走 header）', async () => {
    const { deps, store } = setup()
    await seedChats(store)

    const result = await createSubscriptionLink(deps, {
      chatId: CHAT_ID,
      initData: ownerInitData(),
      body: createBody({ initData: ownerInitData() }),
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: 'invalid_request' })
  })

  test('POST/PATCH 先验签后读 body：缺/坏凭据 + 非法 body 一定是 401，不泄露参数校验', async () => {
    const { deps, store } = setup()
    await seedChats(store)

    const requests = [
      // 无凭据 + body 不是对象。
      () => createSubscriptionLink(deps, { chatId: CHAT_ID, initData: null, body: 'not-json' }),
      // 坏凭据 + 多余字段。
      () =>
        renameSubscriptionLink(deps, {
          chatId: CHAT_ID,
          linkId: LINK_ID,
          initData: 'invalid=1',
          body: { name: 'x', expectedVersion: 1, extra: true },
        }),
      // 坏凭据 + 非法 expectedVersion。
      () => revokeSubscriptionLink(deps, { chatId: CHAT_ID, linkId: LINK_ID, initData: 'invalid=1', body: { expectedVersion: -1 } }),
    ]

    for (const request of requests) {
      const result = await request()
      expect(result.status).toBe(401)
      expect(result.body).toMatchObject({ error: 'init_data_invalid', retryable: false })
    }
  })
})

describe('订阅端点校验与频道范围', () => {
  test('非频道 400 channel_required；未登记/非法 chatId 404 channel_not_found', async () => {
    const { deps, store } = setup()
    await seedChats(store)

    expect((await listSubscriptionLinks(deps, { chatId: GROUP_ID, initData: ownerInitData(), limit: null, cursor: null })).body).toMatchObject(
      { error: 'channel_required' },
    )
    expect((await getSubscriptionChannel(deps, { chatId: '-1000000000001', initData: ownerInitData() })).status).toBe(404)
    expect((await listSubscriptionChannels(deps, { initData: ownerInitData(), limit: null, cursor: null })).status).toBe(200)
  })

  test('getChat 明确返回非 channel：变更操作 400 channel_required（不再 502）；详情保留台账并标能力码', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)
    fake.handlers.getChat = () => ({ id: Number(CHAT_ID), type: 'group', title: '其实不是频道' }) as ChatFullInfo
    const initData = ownerInitData()

    const created = await createSubscriptionLink(deps, {
      chatId: CHAT_ID,
      initData,
      body: createBody({ requestId: '44444444-4444-4444-8444-444444444444' }),
    })
    expect(created.status).toBe(400)
    expect(created.body).toMatchObject({ error: 'channel_required' })

    const renamed = await renameSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData,
      body: { name: 'x', expectedVersion: 1 },
    })
    expect(renamed.status).toBe(400)
    expect(renamed.body).toMatchObject({ error: 'channel_required' })

    const revoked = await revokeSubscriptionLink(deps, { chatId: CHAT_ID, linkId: LINK_ID, initData, body: { expectedVersion: 1 } })
    expect(revoked.status).toBe(400)
    expect(revoked.body).toMatchObject({ error: 'channel_required' })
    // 明确非频道时没有任何订阅链接副作用。
    expect(fake.calls.some((call) => call.method !== 'getChat' && call.method !== 'getChatMember')).toBe(false)

    // 详情不隐藏既有台账：仍 200，但能力码说明 Telegram 侧不是频道。
    const details = await getSubscriptionChannel(deps, { chatId: CHAT_ID, initData })
    expect(details.status).toBe(200)
    expect(details.body).toMatchObject({
      visibility: 'unknown',
      canManageLinks: false,
      capabilityErrorCode: 'channel_required',
    })
  })

  test('创建参数：价格 0/10001/小数、name 超 33 code point、未知字段、缺字段都 400', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    const initData = ownerInitData()

    for (const body of [
      createBody({ priceStars: 0 }),
      createBody({ priceStars: 10_001 }),
      createBody({ priceStars: 1.5 }),
      createBody({ priceStars: '500' }),
      createBody({ name: '字'.repeat(33) }),
      createBody({ extra: true }),
      { requestId: REQUEST_ID, priceStars: 500 },
      createBody({ requestId: 'not-a-uuid' }),
      createBody({ periodSeconds: 2_592_000 }),
    ]) {
      const result = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData, body })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: 'invalid_request' })
    }
  })

  test('跨频道 linkId 一律 404（改名/撤销）', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    await seedActiveLink(store)
    const initData = ownerInitData()

    expect(
      (await renameSubscriptionLink(deps, { chatId: OTHER_CHAT_ID, linkId: LINK_ID, initData, body: { name: 'x', expectedVersion: 1 } }))
        .status,
    ).toBe(404)
    expect(
      (await revokeSubscriptionLink(deps, { chatId: OTHER_CHAT_ID, linkId: LINK_ID, initData, body: { expectedVersion: 1 } }))
        .status,
    ).toBe(404)
  })

  test('limit 非法（0/101/小数/非数字）400，不静默截断', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    for (const limit of ['0', '101', '2.5', 'abc']) {
      const result = await listSubscriptionLinks(deps, { chatId: CHAT_ID, initData: ownerInitData(), limit, cursor: null })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: 'invalid_request' })
    }
  })
})

describe('创建链接：幂等、不确定与副作用失败', () => {
  test('成功：能力校验后 reserve，只发一次 create，201 active；周期固定 2592000', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)

    const result = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })

    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ replayed: false, link: { state: 'active', inviteLink: INVITE_LINK, priceStars: 500, periodSeconds: 2_592_000 } })
    const createCalls = fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.args[0]).toMatchObject({ chatId: CHAT_ID, name: '月度', priceStars: 500, periodSeconds: 2_592_000 })
    expect((await store.repos.subscriptionLinks.findByRequestId(asUserId(OWNER_ID), REQUEST_ID))?.state).toBe('active')
  })

  test('同 requestId + 同载荷重放 200，不再调用 Telegram', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    const initData = ownerInitData()
    const first = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData, body: createBody() })
    expect(first.status).toBe(201)

    advance(1_000)
    const replay = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData, body: createBody() })

    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ replayed: true, link: { state: 'active', inviteLink: INVITE_LINK } })
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(1)
  })

  test('同 requestId + 不同载荷 409 request_conflict，不调用 Telegram', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    const initData = ownerInitData()
    await createSubscriptionLink(deps, { chatId: CHAT_ID, initData, body: createBody() })
    fake.calls.length = 0

    const conflict = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData, body: createBody({ name: '别的名字' }) })

    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ error: 'request_conflict', requestId: REQUEST_ID })
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)
  })

  test('并发 creating（<60s）409 operation_in_progress；超过 60s 视作 create_unknown，绝不重发', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await store.repos.subscriptionLinks.reserveCreate({
      id: LINK_ID,
      chatId,
      ownerUserId: asUserId(OWNER_ID),
      requestId: REQUEST_ID,
      requestHash: requestHashOf('月度', 500),
      name: '月度',
      priceStars: 500,
      periodSeconds: 2_592_000,
      createdAt: currentNow,
    })

    const inProgress = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(inProgress.status).toBe(409)
    expect(inProgress.body).toMatchObject({ error: 'operation_in_progress' })
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)

    advance(61_000)
    const unknown = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(unknown.status).toBe(409)
    expect(unknown.body).toMatchObject({ error: 'create_outcome_unknown', requestId: REQUEST_ID })
    expect((await store.repos.subscriptionLinks.findById(chatId, LINK_ID))?.state).toBe('create_unknown')
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)
  })

  test('Telegram 明确拒绝：409 create_failed 并落状态；同请求重试直接返回该结果', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    fake.handlers.create = () => {
      throw new TelegramSubscriptionError({ code: 'telegram_rejected', outcome: 'rejected' })
    }

    const failed = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(failed.status).toBe(409)
    expect(failed.body).toMatchObject({ error: 'create_failed' })
    expect((await store.repos.subscriptionLinks.findByRequestId(asUserId(OWNER_ID), REQUEST_ID))?.state).toBe('create_failed')

    fake.calls.length = 0
    const replay = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(replay.status).toBe(409)
    expect(replay.body).toMatchObject({ error: 'create_failed' })
    expect(fake.calls).toHaveLength(0)
  })

  test('Telegram 结果不确定：502 telegram_outcome_unknown 并落 create_unknown；不自动重发', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    fake.handlers.create = () => {
      throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
    }

    const unknown = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(unknown.status).toBe(502)
    expect(unknown.body).toMatchObject({ error: 'telegram_outcome_unknown', retryable: true })
    expect((await store.repos.subscriptionLinks.findByRequestId(asUserId(OWNER_ID), REQUEST_ID))?.state).toBe('create_unknown')

    fake.calls.length = 0
    const retry = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({ error: 'create_outcome_unknown' })
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)
  })

  test('Telegram 成功但 DB 保存失败：502 persistence_after_telegram_failed，绝不返回 201', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    const repos = {
      ...store.repos,
      subscriptionLinks: {
        ...store.repos.subscriptionLinks,
        finishCreate: async () => {
          throw new Error('db down')
        },
      },
    }

    const result = await createSubscriptionLink({ ...deps, repos }, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })

    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'persistence_after_telegram_failed' })
  })

  test('Telegram 结果不确定且 create_unknown 落库也失败：502 persistence_after_telegram_failed，旧 creating 继续阻止重发', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    fake.handlers.create = () => {
      throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
    }
    const repos = {
      ...store.repos,
      subscriptionLinks: {
        ...store.repos.subscriptionLinks,
        markCreateOutcome: async () => {
          throw new Error('db down')
        },
      },
    }

    const unknown = await createSubscriptionLink({ ...deps, repos }, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(unknown.status).toBe(502)
    expect(unknown.body).toMatchObject({ error: 'persistence_after_telegram_failed', retryable: true })
    // 旧 creating 占位仍在：同请求重试不会再次调用 Telegram。
    expect((await store.repos.subscriptionLinks.findByRequestId(asUserId(OWNER_ID), REQUEST_ID))?.state).toBe('creating')
    fake.calls.length = 0
    advance(1_000)
    const retry = await createSubscriptionLink({ ...deps, repos }, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({ error: 'operation_in_progress' })
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)
  })

  test('reservation 写失败：500 internal_error，且不调用 Telegram', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    const repos = {
      ...store.repos,
      subscriptionLinks: {
        ...store.repos.subscriptionLinks,
        reserveCreate: async () => {
          throw new Error('db down')
        },
      },
    }

    const result = await createSubscriptionLink({ ...deps, repos }, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })

    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ error: 'internal_error' })
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)
  })

  test('bot 权限不足 403；能力查询失败 502，且都不留下 creating 占位', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    fake.handlers.getChatMember = () =>
      ({
        status: 'member',
        user: { id: BOT_ID, is_bot: true, first_name: 'Skitarii' },
      }) as ChatMember

    const denied = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ error: 'bot_permission_required' })
    expect(await store.repos.subscriptionLinks.findByRequestId(asUserId(OWNER_ID), REQUEST_ID)).toBeNull()

    fake.handlers.getChat = () => {
      throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
    }
    const unavailable = await createSubscriptionLink(deps, { chatId: CHAT_ID, initData: ownerInitData(), body: createBody() })
    expect(unavailable.status).toBe(502)
    expect(unavailable.body).toMatchObject({ error: 'telegram_failed' })
    expect(await store.repos.subscriptionLinks.findByRequestId(asUserId(OWNER_ID), REQUEST_ID)).toBeNull()
    expect(fake.calls.filter((call) => call.method === 'createChatSubscriptionInviteLink')).toHaveLength(0)
  })
})

describe('改名与撤销：条件写与终态', () => {
  test('改名只发送 name，成功后本地 name 与 version 更新', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)

    const result = await renameSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { name: '新名字', expectedVersion: 1 },
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ link: { name: '新名字', state: 'active' } })
    const editCall = fake.calls.find((call) => call.method === 'editChatSubscriptionInviteLink')
    expect(editCall?.args[0]).toEqual({ chatId: CHAT_ID, inviteLink: INVITE_LINK, name: '新名字' })
    expect((await store.repos.subscriptionLinks.findById(chatId, LINK_ID))?.name).toBe('新名字')
  })

  test('版本冲突 409 version_conflict；活跃占位 409 operation_in_progress；都不调用 Telegram', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)

    const versionConflict = await renameSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { name: 'x', expectedVersion: 99 },
    })
    expect(versionConflict.body).toMatchObject({ error: 'version_conflict' })

    // 制造未过期占位。
    await store.repos.subscriptionLinks.claimMutation(chatId, LINK_ID, 1, 'rename', currentNow)
    const inProgress = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 2 },
    })
    expect(inProgress.body).toMatchObject({ error: 'operation_in_progress' })
    expect(fake.calls.filter((call) => call.method === 'editChatSubscriptionInviteLink' || call.method === 'revokeChatInviteLink')).toHaveLength(0)
  })

  test('撤销：先 Telegram 后 DB，成功返回 revoked；之后改名一律 409 link_revoked（不复活）', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)

    const result = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 1 },
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ link: { state: 'revoked' } })
    expect(fake.calls.some((call) => call.method === 'revokeChatInviteLink')).toBe(true)

    fake.calls.length = 0
    const renameAfter = await renameSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { name: '复活', expectedVersion: 3 },
    })
    expect(renameAfter.body).toMatchObject({ error: 'link_revoked' })
    expect(fake.calls).toHaveLength(0)
  })

  test('重复撤销已 revoked：直接 200，忽略过时 expectedVersion，不再调用 Telegram', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)
    await revokeSubscriptionLink(deps, { chatId: CHAT_ID, linkId: LINK_ID, initData: ownerInitData(), body: { expectedVersion: 1 } })
    fake.calls.length = 0

    const replay = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 0 },
    })

    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ link: { state: 'revoked' } })
    expect(fake.calls).toHaveLength(0)
  })

  test('撤销返回值未确认原链接/is_revoked：502 telegram_failed，本地仍 active 且可重试', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)
    fake.handlers.revoke = () => ({ inviteLink: 'https://t.me/+other', isRevoked: false })

    const result = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 1 },
    })

    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'telegram_failed' })
    expect((await store.repos.subscriptionLinks.findById(chatId, LINK_ID))?.state).toBe('active')

    // 失败后占位已释放：可立即重试；claim 会推进 version，前端刷新后拿到新版本再提交。
    fake.handlers.revoke = () => ({ inviteLink: INVITE_LINK, isRevoked: true })
    const retry = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 2 },
    })
    expect(retry.status).toBe(200)
  })

  test('撤销结果不确定：502 telegram_outcome_unknown，本地不改事实', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)
    await seedActiveLink(store)
    fake.handlers.revoke = () => {
      throw new TelegramSubscriptionError({ code: 'timeout', outcome: 'unavailable' })
    }

    const result = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 1 },
    })

    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'telegram_outcome_unknown', retryable: true })
    expect((await store.repos.subscriptionLinks.findById(chatId, LINK_ID))?.state).toBe('active')
  })

  test('改名成功但 DB 提交失败：502 persistence_after_telegram_failed，本地旧值保留', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    await seedActiveLink(store)
    const repos = {
      ...store.repos,
      subscriptionLinks: {
        ...store.repos.subscriptionLinks,
        finishMutation: async () => false,
      },
    }

    const result = await renameSubscriptionLink(
      { ...deps, repos },
      { chatId: CHAT_ID, linkId: LINK_ID, initData: ownerInitData(), body: { name: '新名字', expectedVersion: 1 } },
    )

    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'persistence_after_telegram_failed' })
    expect((await store.repos.subscriptionLinks.findById(chatId, LINK_ID))?.name).toBe('月度')
  })

  test('creating/create_unknown/create_failed 链接不可改名或撤销', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    await store.repos.subscriptionLinks.reserveCreate({
      id: LINK_ID,
      chatId,
      ownerUserId: asUserId(OWNER_ID),
      requestId: REQUEST_ID,
      requestHash: 'h',
      name: '月度',
      priceStars: 500,
      periodSeconds: 2_592_000,
      createdAt: currentNow,
    })

    const rename = await renameSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { name: 'x', expectedVersion: 0 },
    })
    expect(rename.body).toMatchObject({ error: 'operation_in_progress' })

    await store.repos.subscriptionLinks.markCreateOutcome(LINK_ID, 'create_unknown', currentNow)
    const revoke = await revokeSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData: ownerInitData(),
      body: { expectedVersion: 0 },
    })
    expect(revoke.body).toMatchObject({ error: 'create_outcome_unknown' })
  })
})

describe('列表、详情与稳定分页', () => {
  test('频道列表只列已登记 channel，按 chatId 排序并可翻页', async () => {
    const { deps, store } = setup()
    await seedChats(store)

    const first = await listSubscriptionChannels(deps, { initData: ownerInitData(), limit: '1', cursor: null })
    expect(first.status).toBe(200)
    const firstBody = first.body as { items: Array<{ chatId: string }>; nextCursor: string | null }
    expect(firstBody.items).toHaveLength(1)
    expect(firstBody.nextCursor).not.toBeNull()

    const second = await listSubscriptionChannels(deps, {
      initData: ownerInitData(),
      limit: '1',
      cursor: firstBody.nextCursor,
    })
    const secondBody = second.body as { items: Array<{ chatId: string }> }
    expect(secondBody.items[0]?.chatId).not.toBe(firstBody.items[0]?.chatId)
    // 群不在频道列表里。
    const all = await listSubscriptionChannels(deps, { initData: ownerInitData(), limit: '10', cursor: null })
    expect((all.body as { items: unknown[] }).items).toHaveLength(2)
  })

  test('链接分页：同毫秒不漏不重、跨频道/跨资源/坏游标 400', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    // 三条链接，createdAt 完全相同：靠 id 提供全序。
    for (let index = 0; index < 3; index += 1) {
      await store.repos.subscriptionLinks.reserveCreate({
        id: `0000000${index}-0000-4000-8000-000000000000`,
        chatId,
        ownerUserId: asUserId(OWNER_ID),
        requestId: `3333333${index}-3333-4333-8333-333333333333`,
        requestHash: `h${index}`,
        name: `链接${index}`,
        priceStars: 100,
        periodSeconds: 2_592_000,
        createdAt: new Date('2026-09-26T10:00:00Z'),
      })
    }

    const page1 = await listSubscriptionLinks(deps, { chatId: CHAT_ID, initData: ownerInitData(), limit: '2', cursor: null })
    const body1 = page1.body as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(body1.items).toHaveLength(2)
    expect(body1.nextCursor).not.toBeNull()

    const page2 = await listSubscriptionLinks(deps, {
      chatId: CHAT_ID,
      initData: ownerInitData(),
      limit: '2',
      cursor: body1.nextCursor,
    })
    const body2 = page2.body as { items: Array<{ id: string }> }
    expect(body2.items).toHaveLength(1)
    expect(body2.items.map((item) => item.id)).not.toContain(body1.items[0]?.id)
    expect(body2.items.map((item) => item.id)).not.toContain(body1.items[1]?.id)

    // 跨频道游标拒绝。
    const cross = await listSubscriptionLinks(deps, {
      chatId: CHAT_ID,
      initData: ownerInitData(),
      limit: '1',
      cursor: Buffer.from(
        JSON.stringify({ v: 1, r: 'links', chatId: OTHER_CHAT_ID, createdAt: '2026-09-26T10:00:00.000Z', id: LINK_ID }),
        'utf8',
      ).toString('base64url'),
    })
    expect(cross.body).toMatchObject({ error: 'invalid_cursor' })

    // 跨资源游标拒绝。
    const wrongResource = await listSubscriptionLinks(deps, {
      chatId: CHAT_ID,
      initData: ownerInitData(),
      limit: '1',
      cursor: Buffer.from(
        JSON.stringify({ v: 1, r: 'members', chatId: CHAT_ID, firstObservedAt: '2026-09-26T10:00:00.000Z', id: LINK_ID }),
        'utf8',
      ).toString('base64url'),
    })
    expect(wrongResource.body).toMatchObject({ error: 'invalid_cursor' })

    // 坏 JSON / 超长 / 版本不符。
    for (const cursor of [
      'not-base64-json',
      'a'.repeat(1025),
      Buffer.from(JSON.stringify({ v: 2, r: 'links', chatId: CHAT_ID }), 'utf8').toString('base64url'),
    ]) {
      const bad = await listSubscriptionLinks(deps, { chatId: CHAT_ID, initData: ownerInitData(), limit: '1', cursor })
      expect(bad.status).toBe(400)
      expect(bad.body).toMatchObject({ error: 'invalid_cursor' })
    }
  })

  test('游标严格校验：多余字段、channels 缺/非法 chatId、宽松或越界日期一律 400', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    const encode = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

    const cases: Array<{ scope: 'channels' | 'links' | 'members'; cursor: string }> = [
      // links：多余字段。
      {
        scope: 'links',
        cursor: encode({ v: 1, r: 'links', chatId: CHAT_ID, createdAt: '2026-09-26T10:00:00.000Z', id: LINK_ID, extra: true }),
      },
      // channels：缺 chatId。
      { scope: 'channels', cursor: encode({ v: 1, r: 'channels' }) },
      // channels：chatId 不是合法十进制。
      { scope: 'channels', cursor: encode({ v: 1, r: 'channels', chatId: 'abc' }) },
      // links：日期不是严格 ISO 形态。
      { scope: 'links', cursor: encode({ v: 1, r: 'links', chatId: CHAT_ID, createdAt: '2026-09-26', id: LINK_ID }) },
      // links：日历越界（Date 会顺延，必须拒绝）。
      {
        scope: 'links',
        cursor: encode({ v: 1, r: 'links', chatId: CHAT_ID, createdAt: '2026-02-30T00:00:00.000Z', id: LINK_ID }),
      },
      // members：epoch 为负（1970 前）属越界。
      {
        scope: 'members',
        cursor: encode({ v: 1, r: 'members', chatId: CHAT_ID, firstObservedAt: '1969-12-31T23:59:59.999Z', id: LINK_ID }),
      },
    ]

    for (const { scope, cursor } of cases) {
      const result =
        scope === 'channels'
          ? await listSubscriptionChannels(deps, { initData: ownerInitData(), limit: '1', cursor })
          : scope === 'links'
            ? await listSubscriptionLinks(deps, { chatId: CHAT_ID, initData: ownerInitData(), limit: '1', cursor })
            : await listSubscriptionMembers(deps, { chatId: CHAT_ID, initData: ownerInitData(), limit: '1', cursor })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: 'invalid_cursor' })
    }

    // 合法 channels 游标（严格形态）仍可翻页：确认白名单没有误伤正常载荷。
    const ok = await listSubscriptionChannels(deps, {
      initData: ownerInitData(),
      limit: '1',
      cursor: encode({ v: 1, r: 'channels', chatId: CHAT_ID }),
    })
    expect(ok.status).toBe(200)
  })

  test('成员分页按 firstObservedAt 倒序；counts 是全量聚合而不是当前页长度', async () => {
    const { deps, store } = setup()
    await seedChats(store)
    for (let index = 0; index < 3; index += 1) {
      await store.repos.subscriptionMembers.applyEvent({
        chatId,
        userId: asUserId(7_000_000_100 + index),
        state: 'member',
        expiresAt: null,
        evidence: 'until_date',
        linkId: null,
        isJoin: true,
        eventDate: 1_758_000_000,
        eventUpdateId: index + 1,
        observedAt: new Date(`2026-09-26T09:0${index}:00Z`),
      })
    }

    const page = await listSubscriptionMembers(deps, { chatId: CHAT_ID, initData: ownerInitData(), limit: '1', cursor: null })
    const body = page.body as { items: unknown[]; nextCursor: string | null }
    expect(body.items).toHaveLength(1)
    expect(body.nextCursor).not.toBeNull()

    const details = await getSubscriptionChannel(deps, { chatId: CHAT_ID, initData: ownerInitData() })
    expect((details.body as { counts: unknown }).counts).toEqual({ known: 3, member: 3, left: 0, unknown: 0 })
  })

  test('频道详情：public/private/unknown 与 canManageLinks 快照', async () => {
    const { deps, store, fake } = setup()
    await seedChats(store)

    const publicView = await getSubscriptionChannel(deps, { chatId: CHAT_ID, initData: ownerInitData() })
    expect(publicView.body).toMatchObject({
      visibility: 'public',
      canManageLinks: true,
      capabilityErrorCode: null,
      linkedChatId: OTHER_CHAT_ID,
    })

    fake.handlers.getChat = () => ({ id: Number(CHAT_ID), type: 'channel', title: '私有频道' }) as ChatFullInfo
    const privateView = await getSubscriptionChannel(deps, { chatId: CHAT_ID, initData: ownerInitData() })
    expect(privateView.body).toMatchObject({ visibility: 'private' })

    fake.handlers.getChat = () => {
      throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
    }
    const unknownView = await getSubscriptionChannel(deps, { chatId: CHAT_ID, initData: ownerInitData() })
    expect(unknownView.status).toBe(200)
    expect(unknownView.body).toMatchObject({ visibility: 'unknown', canManageLinks: false, capabilityErrorCode: 'telegram_failed' })
  })
})

describe('凭据与日志安全', () => {
  test('成功与失败路径的日志都不含邀请链接或 initData', async () => {
    const { deps, store, fake, logs } = setup()
    await seedChats(store)
    const initData = ownerInitData()

    await createSubscriptionLink(deps, { chatId: CHAT_ID, initData, body: createBody() })
    fake.handlers.edit = () => {
      throw new TelegramSubscriptionError({ code: 'telegram_rejected', outcome: 'rejected' })
    }
    await renameSubscriptionLink(deps, {
      chatId: CHAT_ID,
      linkId: LINK_ID,
      initData,
      body: { name: '改名', expectedVersion: 1 },
    })
    // 上游异常 message 里带链接与凭据：服务只记类型名。
    fake.handlers.revoke = () => {
      throw new Error(`Bad Request: invite link ${INVITE_LINK} invalid, initData=${initData}`)
    }
    await revokeSubscriptionLink(deps, { chatId: CHAT_ID, linkId: LINK_ID, initData, body: { expectedVersion: 2 } })

    const text = logs.map((entry) => entry.message).join('\n')
    expect(text).not.toContain(INVITE_LINK)
    expect(text).not.toContain(initData)
    expect(text).not.toContain(BOT_TOKEN)
  })

  test('Telegram 端口只有读与订阅链接方法：不存在踢人/限制接口', () => {
    const { fake } = setup()
    expect(Object.keys(fake.port).sort()).toEqual([
      'createChatSubscriptionInviteLink',
      'editChatSubscriptionInviteLink',
      'getChat',
      'getChatMember',
      'revokeChatInviteLink',
    ])
  })
})
