import { asChatId, asUserId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { ChatMemberUpdated } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import type { Logger } from './logger.js'
import { createSubscriptionMemberRecorder } from './subscription-members.js'

/**
 * 订阅成员事件记录器测试（Phase 3b spec §8）。
 *
 * 覆盖：成员身份取事件成员而非操作人、无证据忽略、until_date 独立纳入、自建链接匹配、
 * 掩码不关联、left 表述、旧/重复事件忽略、同秒按 update_id、已知成员继续跟踪、非频道跳过。
 */

const chatId = asChatId('-1001111111111')
const memberUserId = 7_000_000_002
const adminUserId = 7_000_000_001

const linkId = '11111111-1111-4111-8111-111111111111'
const inviteLink = 'https://t.me/+abcdefghijklmnop'

/** 记录日志的替身。 */
function recordingLogger(messages: string[]): Logger {
  return {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  }
}

/**
 * 构造频道的成员更新。
 *
 * @param options 新旧状态、操作人、邀请链接与时间。
 * @returns 更新对象。
 */
function chatMemberUpdate(options: {
  oldStatus: string
  newStatus: string
  untilDate?: number
  isMember?: boolean
  inviteLink?: string
  date?: number
  fromId?: number
  userId?: number
}): ChatMemberUpdated {
  const user = { id: options.userId ?? memberUserId, is_bot: false, first_name: '成员' }
  return {
    chat: { id: Number(chatId), type: 'channel', title: '测试频道' },
    from: { id: options.fromId ?? adminUserId, is_bot: false, first_name: '管理员' },
    date: options.date ?? 1_758_000_000,
    old_chat_member: { status: options.oldStatus, user },
    new_chat_member: {
      status: options.newStatus,
      user,
      ...(options.untilDate === undefined ? {} : { until_date: options.untilDate }),
      ...(options.isMember === undefined ? {} : { is_member: options.isMember }),
    },
    ...(options.inviteLink === undefined ? {} : { invite_link: { invite_link: options.inviteLink } }),
  } as ChatMemberUpdated
}

interface Harness {
  store: InMemoryRepos
  recorder: ReturnType<typeof createSubscriptionMemberRecorder>
  logs: string[]
}

/** 组装记录器与内存仓储。 */
function setup(): Harness {
  const store = createInMemoryRepos()
  const logs: string[] = []
  const recorder = createSubscriptionMemberRecorder({
    repos: store.repos,
    logger: recordingLogger(logs),
    now: () => new Date('2026-09-26T10:00:00Z'),
  })
  return { store, recorder, logs }
}

/** 预置一个 ACTIVE 自建链接。 */
async function seedLink(store: InMemoryRepos): Promise<void> {
  await store.repos.subscriptionLinks.reserveCreate({
    id: linkId,
    chatId,
    ownerUserId: asUserId(1_000_000_001),
    requestId: '22222222-2222-4222-8222-222222222222',
    requestHash: 'hash-1',
    name: '月度',
    priceStars: 500,
    periodSeconds: 2_592_000,
    createdAt: new Date('2026-09-26T09:00:00Z'),
  })
  await store.repos.subscriptionLinks.finishCreate(linkId, {
    inviteLink,
    finishedAt: new Date('2026-09-26T09:00:01Z'),
  })
}

describe('订阅成员事件记录', () => {
  test('成员身份取 new_chat_member.user.id，而不是操作人 from', async () => {
    const { store, recorder } = setup()

    await recorder.handleChatMember(
      chatMemberUpdate({
        oldStatus: 'left',
        newStatus: 'member',
        untilDate: 1_791_000_000,
        fromId: adminUserId,
        userId: memberUserId,
      }),
      100,
    )

    const member = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))
    expect(member).not.toBeNull()
    expect(member?.userId).toBe(memberUserId)
    expect(member?.state).toBe('member')
    expect(member?.evidence).toBe('until_date')
    expect(member?.expiresAt?.toISOString()).toBe(new Date(1_791_000_000 * 1_000).toISOString())
    expect(member?.linkId).toBeNull()
    // 操作人没有被记成成员。
    expect(await store.repos.subscriptionMembers.find(chatId, asUserId(adminUserId))).toBeNull()
  })

  test('无证据的新免费成员被忽略，不落台账', async () => {
    const { store, recorder, logs } = setup()

    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'left', newStatus: 'member' }), 101)

    expect(await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))).toBeNull()
    expect(logs.some((message) => message.includes('忽略无订阅证据'))).toBe(true)
  })

  test('自建付费链接完整匹配时纳入并设置 linkId；掩码链接不关联', async () => {
    const { store, recorder } = setup()
    await seedLink(store)

    await recorder.handleChatMember(
      chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', inviteLink }),
      102,
    )
    const matched = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))
    expect(matched?.linkId).toBe(linkId)
    expect(matched?.evidence).toBe('owned_link')
    expect(matched?.expiresAt).toBeNull()

    // 掩码（别人创建的链接）不匹配：另一个用户无 until_date → 忽略。
    await recorder.handleChatMember(
      chatMemberUpdate({
        oldStatus: 'left',
        newStatus: 'member',
        inviteLink: 'https://t.me/+XXXXXXXXXXXXXXXX',
        userId: memberUserId + 1,
      }),
      103,
    )
    expect(await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId + 1))).toBeNull()
  })

  test('left 说成 left 而不是 expired；到期观测值随完整快照清空，可再次缩短', async () => {
    const { store, recorder } = setup()
    await recorder.handleChatMember(
      chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', untilDate: 1_791_000_000 }),
      104,
    )

    // 后续 member 状态更新不带 until_date：字段缺失只代表这次未观测到，值为 null。
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'member', newStatus: 'member' }), 105)
    const cleared = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))
    expect(cleared?.expiresAt).toBeNull()
    expect(cleared?.state).toBe('member')

    // 主动离开：state=left，不用 expired 表述。
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'member', newStatus: 'left' }), 106)
    const left = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))
    expect(left?.state).toBe('left')
    expect(left?.expiresAt).toBeNull()
    expect(JSON.stringify(left)).not.toContain('expired')
  })

  test('旧事件与重复事件被忽略；同秒按 update_id 更新', async () => {
    const { store, recorder } = setup()
    await recorder.handleChatMember(
      chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', untilDate: 1_791_000_000, date: 100 }),
      200,
    )
    const first = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))

    // 更旧事件：忽略。
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'member', newStatus: 'left', date: 99 }), 201)
    expect((await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId)))?.state).toBe('member')
    // 同秒更小 update_id：忽略。
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'member', newStatus: 'left', date: 100 }), 199)
    expect((await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId)))?.state).toBe('member')
    // 同秒更大 update_id：应用。
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'member', newStatus: 'left', date: 100 }), 201)
    const updated = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))
    expect(updated?.state).toBe('left')
    expect(updated?.version).toBe((first?.version ?? 0) + 1)
  })

  test('已有台账但本次无付费字段的成员继续跟踪（升管理员 → member）', async () => {
    const { store, recorder } = setup()
    await seedLink(store)
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', inviteLink }), 300)

    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'member', newStatus: 'administrator' }), 301)

    const admin = await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId))
    expect(admin?.state).toBe('member')
    // 历史来源保留（本次不是新一轮加入）。
    expect(admin?.linkId).toBe(linkId)
  })

  test('restricted 按 is_member 落到 member/left；非频道更新直接跳过', async () => {
    const { store, recorder } = setup()
    // 先以 until_date 证据纳入（restricted 的 until_date 是禁言时长，不作为订阅证据）。
    await recorder.handleChatMember(
      chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', untilDate: 1_791_000_000 }),
      400,
    )
    await recorder.handleChatMember(
      chatMemberUpdate({ oldStatus: 'member', newStatus: 'restricted', isMember: true, untilDate: 1_791_000_000 }),
      401,
    )
    expect((await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId)))?.state).toBe('member')

    await recorder.handleChatMember(
      chatMemberUpdate({ oldStatus: 'restricted', newStatus: 'restricted', isMember: false, untilDate: 1_791_000_000 }),
      402,
    )
    expect((await store.repos.subscriptionMembers.find(chatId, asUserId(memberUserId)))?.state).toBe('left')

    // 非频道：不处理（直接用超级群对象）。
    const supergroupUpdate = {
      ...chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', untilDate: 1_791_000_000, userId: memberUserId + 5 }),
      chat: { id: Number(chatId), type: 'supergroup', title: '群' },
    } as ChatMemberUpdated
    await recorder.handleChatMember(supergroupUpdate, 403)
    await expect(store.repos.subscriptionMembers.listPage({ chatId, limit: 10 })).resolves.toHaveLength(1)
  })

  test('记录器日志不包含邀请链接', async () => {
    const { store, recorder, logs } = setup()
    await seedLink(store)
    await recorder.handleChatMember(chatMemberUpdate({ oldStatus: 'left', newStatus: 'member', inviteLink }), 500)

    expect(logs.join('\n')).not.toContain(inviteLink)
    expect(store.repos.subscriptionMembers).toBeDefined()
  })
})

/** 结构性约束：记录器对外只暴露只读事实处理入口，没有任何权限处置方法。 */
test('成员记录器只暴露 handleChatMember（无踢人/限制入口）', () => {
  const store = createInMemoryRepos()
  const recorder = createSubscriptionMemberRecorder({ repos: store.repos, logger: recordingLogger([]) })
  expect(Object.keys(recorder)).toEqual(['handleChatMember'])
})
