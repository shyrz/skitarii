import { asChatId, asUserId } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { AppealNotification } from '@skitarii/bot'
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createAppeal, getAppeal, type AppealApiDeps } from './api.js'

/**
 * 申诉 API 的行为测试。走的是 `api.ts` 导出的处理函数（HTTP 无关），
 * 因此验签、归属、重复提交这些契约点不需要起服务器就能断言。
 */

const BOT_TOKEN = '123456:TEST-TOKEN-abc'
const OWNER_ID = 1_000_000_001
const USER_ID = 7_000_000_001

const chatId = asChatId('-1001234567890')
const decisionId = '9c8b7a65-1111-4222-8333-999900001111'
const eventId = '3f1d0c9a-1111-4222-8333-444455556666'
const now = new Date('2026-09-23T12:00:00Z')

/**
 * 生成 initData（按协议文档独立实现签名过程）。
 *
 * @param userId 用户 id。
 * @param overrides 覆盖字段。
 * @returns 查询串形态的 initData。
 */
function signInitData(userId: number, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(now.getTime() / 1_000)),
    user: JSON.stringify({ id: userId, first_name: '测试' }),
    ...overrides,
  }
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  return [...Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`), `hash=${hash}`].join('&')
}

interface Harness {
  deps: AppealApiDeps
  store: InMemoryRepos
  notifications: AppealNotification[]
  /** 通知出口的返回：`true` 表示 Telegram 接受。测试里可翻转。 */
  notifyAcceptance: { accepted: boolean }
}

/**
 * 组装 API 依赖。
 *
 * @returns 依赖、内存仓储、通知记录与通知出口开关。
 */
function setup(): Harness {
  const store = createInMemoryRepos()
  const notifications: AppealNotification[] = []
  const notifyAcceptance = { accepted: true }

  return {
    store,
    notifications,
    notifyAcceptance,
    deps: {
      repos: store.repos,
      botToken: BOT_TOKEN,
      ownerUserId: asUserId(OWNER_ID),
      notifyAppeal: async (notification) => {
        notifications.push(notification)
        return notifyAcceptance.accepted
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => now,
    },
  }
}

/**
 * 预置一条已执行的处置与它的正文摘录。
 *
 * @param store 内存仓储。
 * @param userId 被处置的用户。
 */
async function seedDecision(store: InMemoryRepos, userId: number = USER_ID): Promise<void> {
  await store.repos.chats.upsert({
    chatId,
    title: '测试群',
    language: 'zh',
    rules: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  })
  await store.repos.events.insert({
    id: eventId,
    chatId,
    userId: asUserId(userId),
    messageId: 42,
    contentHash: 'h'.repeat(64),
    features: { hasLink: false, mediaType: 'text', length: 12 },
    createdAt: new Date('2026-09-23T10:00:00Z'),
  })
  await store.repos.decisions.insert({
    id: decisionId,
    eventId,
    chatId,
    userId: asUserId(userId),
    action: { kind: 'delete' },
    score: 0.9,
    signals: [{ kind: 'rule-hit', ruleId: 'rule-1', score: 0.9 }],
    decidedAt: new Date('2026-09-23T10:00:00Z'),
    executed: true,
  })
  await store.repos.events.attachSample(eventId, '低价出售会员，需要的私聊')
}

describe('GET /api/appeals/:decisionId', () => {
  test('当事人读取自己的处置：返回决策字段与空的申诉', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const response = await getAppeal(harness.deps, { decisionId, initData: signInitData(USER_ID) })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      decision: {
        id: decisionId,
        action: 'delete',
        actionUntil: null,
        chatTitle: '测试群',
        createdAt: new Date('2026-09-23T10:00:00Z'),
        sampleText: '低价出售会员，需要的私聊',
      },
      appeal: null,
    })
  })

  test('已提交的申诉以冻结的字段形状返回', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    await createAppeal(harness.deps, {
      initData: signInitData(USER_ID),
      decisionId,
      reason: '这是我自己的闲置转让',
    })

    const response = await getAppeal(harness.deps, { decisionId, initData: signInitData(USER_ID) })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      appeal: {
        state: 'open',
        reason: '这是我自己的闲置转让',
        createdAt: now,
        resolvedAt: null,
      },
    })
  })

  test('禁言处置把截止时刻放在 actionUntil（前端据此显示禁言到什么时候）', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    await harness.store.repos.decisions.insert({
      id: 'b0000000-0000-4000-8000-000000000001',
      eventId: 'c0000000-0000-4000-8000-000000000001',
      chatId,
      userId: asUserId(USER_ID),
      action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') },
      score: 0.8,
      signals: [],
      decidedAt: new Date('2026-09-23T10:00:00Z'),
      executed: true,
    })

    const response = await getAppeal(harness.deps, {
      decisionId: 'b0000000-0000-4000-8000-000000000001',
      initData: signInitData(USER_ID),
    })

    expect(response.body).toMatchObject({
      decision: { action: 'mute', actionUntil: new Date('2026-09-23T11:00:00Z') },
    })
  })

  test('owner 可以读别人被处置的详情', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const response = await getAppeal(harness.deps, { decisionId, initData: signInitData(OWNER_ID) })

    expect(response.status).toBe(200)
  })

  test('无关用户读取得到 404（不泄露处置是否存在）', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const response = await getAppeal(harness.deps, { decisionId, initData: signInitData(999) })

    expect(response).toEqual({ status: 404, body: { error: 'decision_not_found' } })
  })

  test('验签失败的 initData 得到 401', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    const tampered = signInitData(USER_ID).replace(encodeURIComponent('"id":7000000001'), encodeURIComponent('"id":999'))

    expect(await getAppeal(harness.deps, { decisionId, initData: tampered })).toEqual({
      status: 401,
      body: { error: 'init_data_invalid' },
    })
    expect(await getAppeal(harness.deps, { decisionId, initData: null })).toEqual({
      status: 401,
      body: { error: 'init_data_invalid' },
    })
  })

  test('非法 uuid 直接 404，不把坏参数送进数据库', async () => {
    const harness = setup()

    const response = await getAppeal(harness.deps, { decisionId: 'not-a-uuid', initData: signInitData(USER_ID) })

    expect(response).toEqual({ status: 404, body: { error: 'decision_not_found' } })
  })
})

describe('POST /api/appeals', () => {
  test('首次提交返回 201，落库为待处理并通知 owner', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const response = await createAppeal(harness.deps, {
      initData: signInitData(USER_ID),
      decisionId,
      reason: '  这是我自己的闲置转让  ',
    })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      appeal: { state: 'open', reason: '这是我自己的闲置转让', createdAt: now, resolvedAt: null },
    })
    // 通知里带的是处置上下文，供 owner 直接判断是否误判。
    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0]).toMatchObject({
      userId: USER_ID,
      chatTitle: '测试群',
      action: { kind: 'delete' },
      sampleText: '低价出售会员，需要的私聊',
      reason: '这是我自己的闲置转让',
    })
  })

  test('同一 decisionId 重复提交返回 409，且不重复通知', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    const body = { initData: signInitData(USER_ID), decisionId, reason: '误判' }

    expect((await createAppeal(harness.deps, body)).status).toBe(201)

    const second = await createAppeal(harness.deps, body)

    expect(second).toEqual({ status: 409, body: { error: 'appeal_exists' } })
    expect(harness.notifications).toHaveLength(1)
  })

  test('理由为空或超长返回 400，并列出问题字段', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const empty = await createAppeal(harness.deps, { initData: signInitData(USER_ID), decisionId, reason: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.body).toMatchObject({ error: 'invalid_request' })

    const tooLong = await createAppeal(harness.deps, {
      initData: signInitData(USER_ID),
      decisionId,
      reason: 'x'.repeat(501),
    })
    expect(tooLong.status).toBe(400)
    expect(harness.notifications).toEqual([])
  })

  test('验签失败返回 401，不落库', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const response = await createAppeal(harness.deps, {
      initData: 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef',
      decisionId,
      reason: '误判',
    })

    expect(response.status).toBe(401)
    expect(await harness.store.repos.appeals.findByDecisionId(decisionId)).toBeNull()
  })

  test('替别人的处置提交申诉得到 404', async () => {
    const harness = setup()
    await seedDecision(harness.store, 555)

    const response = await createAppeal(harness.deps, { initData: signInitData(USER_ID), decisionId, reason: '误判' })

    expect(response).toEqual({ status: 404, body: { error: 'decision_not_found' } })
    expect(harness.notifications).toEqual([])
  })

  test('通知出口抛错不影响 201（申诉已落库）', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    harness.deps.notifyAppeal = async () => {
      throw new Error('telegram 不可达')
    }

    const response = await createAppeal(harness.deps, { initData: signInitData(USER_ID), decisionId, reason: '误判' })

    expect(response.status).toBe(201)
    expect(await harness.store.repos.appeals.findByDecisionId(decisionId)).not.toBeNull()
  })

  test('通知被接受后回填 notified_at', async () => {
    const harness = setup()
    await seedDecision(harness.store)

    const response = await createAppeal(harness.deps, { initData: signInitData(USER_ID), decisionId, reason: '误判' })
    const appealId = (response.body as { appeal: { id: string } }).appeal.id

    expect(harness.notifications).toHaveLength(1)
    expect(harness.store.notifiedAtOf(appealId)).toEqual(now)
  })

  test('通知未被接受时回填留空，留给调度器的补发扫描', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    harness.notifyAcceptance.accepted = false

    const response = await createAppeal(harness.deps, { initData: signInitData(USER_ID), decisionId, reason: '误判' })
    const appealId = (response.body as { appeal: { id: string } }).appeal.id

    expect(response.status).toBe(201)
    expect(harness.store.notifiedAtOf(appealId)).toBeNull()
  })

  test('通知出口抛错时同样回填留空', async () => {
    const harness = setup()
    await seedDecision(harness.store)
    harness.deps.notifyAppeal = async () => {
      throw new Error('telegram 不可达')
    }

    const response = await createAppeal(harness.deps, { initData: signInitData(USER_ID), decisionId, reason: '误判' })
    const appealId = (response.body as { appeal: { id: string } }).appeal.id

    expect(harness.store.notifiedAtOf(appealId)).toBeNull()
  })
})
