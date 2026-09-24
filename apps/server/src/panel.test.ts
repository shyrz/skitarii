import { asChatId, asUserId, type ChatConfig, type ChatId, type DailyAggregate, type ModerationDecision } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { AppealResolution } from '@skitarii/bot'
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  getPanelAppeals,
  getPanelDecisions,
  getPanelOverview,
  getPanelSeries,
  resolvePanelAppeal,
  type PanelApiDeps,
} from './panel.js'

/**
 * 面板 API 的行为测试。走 `panel.ts` 导出的纯函数，因此鉴权、过滤、分页与状态码映射
 * 不需要起 HTTP 服务器。结案入口注入替身：`resolveAppeal` 的语义由 apps/bot 的测试覆盖，
 * 这里只断言 200 / 409 / 404 的映射与入参传递。
 */

const BOT_TOKEN = '123456:TEST-TOKEN-abc'
const OWNER_ID = 1_000_000_001
const USER_ID = 7_000_000_001
const now = new Date('2026-09-23T12:00:00Z')

const chatId = asChatId('-1001234567890')
const otherChatId = asChatId('-1009999999999')
const appealId = 'a1b2c3d4-1111-4222-8333-555566667777'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 生成 initData（按协议文档独立实现签名过程，与 api.test.ts 同一套）。
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
  deps: PanelApiDeps
  store: InMemoryRepos
  /** 结案入口收到的调用。 */
  resolutions: Array<{ appealId: string; outcome: 'uphold' | 'overturn' }>
}

/**
 * 组装面板依赖。
 *
 * @param resolveResult 结案入口的返回；缺省为成功且未发生回滚失败。
 * @returns 依赖、内存仓储与结案调用记录。
 */
function setup(resolveResult: AppealResolution = { kind: 'resolved', rollbackFailed: false, resolvedAt: now }): Harness {
  const store = createInMemoryRepos()
  const resolutions: Harness['resolutions'] = []

  return {
    store,
    resolutions,
    deps: {
      repos: store.repos,
      botToken: BOT_TOKEN,
      ownerUserId: asUserId(OWNER_ID),
      resolveAppeal: async (id, outcome) => {
        resolutions.push({ appealId: id, outcome })
        return resolveResult
      },
      logger: silentLogger,
      now: () => now,
    },
  }
}

/** 群配置构造器。 */
function chatConfigFor(id: ChatId, title: string): ChatConfig {
  return { chatId: id, title, language: 'zh', rules: [], passThreshold: 0.3, llmThreshold: 0.8, muteDurationMinutes: 60 }
}

/** 预置一条日聚合。 */
async function seedAggregate(
  store: InMemoryRepos,
  id: ChatId,
  date: string,
  counts: Partial<Omit<DailyAggregate, 'chatId' | 'date'>> = {},
): Promise<void> {
  await store.repos.aggregates.upsert({
    chatId: id,
    date,
    messageCount: counts.messageCount ?? 0,
    actionCount: counts.actionCount ?? 0,
    appealCount: counts.appealCount ?? 0,
    overturnedCount: counts.overturnedCount ?? 0,
  })
}

/** 预置一条决策与它的事件行，可选写入正文摘录。 */
async function seedDecision(
  store: InMemoryRepos,
  decision: ModerationDecision,
  sampleText: string | null = null,
): Promise<void> {
  await store.repos.events.insert({
    id: decision.eventId,
    chatId: decision.chatId,
    userId: decision.userId,
    messageId: 1,
    contentHash: decision.eventId,
    features: { hasLink: false, mediaType: 'text', length: 4, customEmojiCount: 0 },
    createdAt: decision.decidedAt,
  })
  await store.repos.decisions.insert(decision)
  if (sampleText !== null) await store.repos.events.attachSample(decision.eventId, sampleText)
}

/** 决策构造器：只写与用例相关的字段。 */
function decisionFixture(id: string, decidedAt: Date, overrides: Partial<ModerationDecision> = {}): ModerationDecision {
  return {
    id,
    eventId: `event-${id}`,
    chatId,
    userId: asUserId(USER_ID),
    action: { kind: 'delete' },
    score: 0.8,
    signals: [{ kind: 'rule-hit', ruleId: 'r-1', score: 0.8 }],
    decidedAt,
    executed: true,
    ...overrides,
  }
}

/** 申诉构造器：只写与用例相关的字段。 */
function appealFixture(id: string, decisionId: string, createdAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id,
    decisionId,
    userId: asUserId(USER_ID),
    state: 'open' as const,
    note: '误判了',
    createdAt,
    resolvedAt: null,
    ...overrides,
  }
}

const ownerInitData = (): string => signInitData(OWNER_ID)

describe('面板鉴权', () => {
  test('GET 端点缺 initData 一律 401', async () => {
    const { deps } = setup()

    const responses = await Promise.all([
      getPanelOverview(deps, { initData: null }),
      getPanelSeries(deps, { chatId, days: null, initData: null }),
      getPanelDecisions(deps, { initData: null, chatId: null, action: null, limit: null, before: null, beforeId: null }),
      getPanelAppeals(deps, { initData: null, state: null, limit: null }),
    ])

    for (const response of responses) {
      expect(response).toEqual({ status: 401, body: { error: 'init_data_invalid' } })
    }
  })

  test('验签失败 401，已验签但非 owner 403', async () => {
    const { deps } = setup()

    expect(await getPanelOverview(deps, { initData: 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef' })).toEqual({
      status: 401,
      body: { error: 'init_data_invalid' },
    })
    expect(await getPanelOverview(deps, { initData: signInitData(USER_ID) })).toEqual({
      status: 403,
      body: { error: 'forbidden' },
    })
  })

  test('结案端点：非 owner 403，非法请求体 400 先于鉴权', async () => {
    const { deps, resolutions } = setup()

    expect(
      await resolvePanelAppeal(deps, {
        appealId,
        body: { initData: signInitData(USER_ID), resolution: 'upheld' },
      }),
    ).toEqual({ status: 403, body: { error: 'forbidden' } })

    const invalid = await resolvePanelAppeal(deps, { appealId, body: { initData: ownerInitData(), resolution: 'nope' } })
    expect(invalid.status).toBe(400)
    expect(resolutions).toEqual([])
  })
})

describe('面板概览', () => {
  test('今日与近 7 日总计、每群计数与待处理申诉，按活跃度降序', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))
    await store.repos.chats.upsert(chatConfigFor(otherChatId, '乙群'))

    // 甲群：今天 10 条消息 3 次处置；昨天 5 条消息 1 次处置；窗口外的高计数必须被排除。
    await seedAggregate(store, chatId, '2026-09-23', { messageCount: 10, actionCount: 3, appealCount: 1 })
    await seedAggregate(store, chatId, '2026-09-22', { messageCount: 5, actionCount: 1 })
    await seedAggregate(store, chatId, '2026-09-16', { messageCount: 100, actionCount: 50 })
    // 乙群：只有今天一条。
    await seedAggregate(store, otherChatId, '2026-09-23', { messageCount: 4, actionCount: 1, overturnedCount: 2 })

    // 乙群两条待处理申诉；甲群一条已结案的不计入 open。
    await seedDecision(store, decisionFixture('d-open-1', new Date('2026-09-23T09:00:00Z'), { chatId: otherChatId }))
    await seedDecision(store, decisionFixture('d-open-2', new Date('2026-09-23T09:30:00Z'), { chatId: otherChatId }))
    await seedDecision(store, decisionFixture('d-upheld', new Date('2026-09-23T08:00:00Z')))
    await store.repos.appeals.insert(appealFixture('a-1', 'd-open-1', new Date('2026-09-23T09:05:00Z')))
    await store.repos.appeals.insert(appealFixture('a-2', 'd-open-2', new Date('2026-09-23T09:35:00Z')))
    await store.repos.appeals.insert(
      appealFixture('a-3', 'd-upheld', new Date('2026-09-23T08:05:00Z'), {
        state: 'upheld',
        resolvedAt: new Date('2026-09-23T08:10:00Z'),
      }),
    )

    const result = await getPanelOverview(deps, { initData: ownerInitData() })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      totals: {
        today: { messageCount: 14, actionCount: 4, appealCount: 1, overturnedCount: 2 },
        last7d: { messageCount: 19, actionCount: 5, appealCount: 1, overturnedCount: 2 },
      },
      chats: [
        {
          chatId,
          title: '甲群',
          today: { messageCount: 10, actionCount: 3, appealCount: 1, overturnedCount: 0 },
          last7d: { messageCount: 15, actionCount: 4, appealCount: 1, overturnedCount: 0 },
          openAppeals: 0,
        },
        {
          chatId: otherChatId,
          title: '乙群',
          today: { messageCount: 4, actionCount: 1, appealCount: 0, overturnedCount: 2 },
          last7d: { messageCount: 4, actionCount: 1, appealCount: 0, overturnedCount: 2 },
          openAppeals: 2,
        },
      ],
      serverTime: now,
    })
  })

  test('没有聚合数据时各群计数为零', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const result = await getPanelOverview(deps, { initData: ownerInitData() })

    expect(result.body).toMatchObject({
      totals: {
        today: { messageCount: 0, actionCount: 0, appealCount: 0, overturnedCount: 0 },
        last7d: { messageCount: 0, actionCount: 0, appealCount: 0, overturnedCount: 0 },
      },
      chats: [{ chatId, title: '甲群', openAppeals: 0 }],
    })
  })
})

describe('面板报表序列', () => {
  test('连续日期升序、缺失日补零', async () => {
    const { deps, store } = setup()
    await seedAggregate(store, chatId, '2026-09-23', { messageCount: 3, actionCount: 1 })
    await seedAggregate(store, chatId, '2026-09-20', { messageCount: 7, appealCount: 2 })

    const result = await getPanelSeries(deps, { chatId, days: '7', initData: ownerInitData() })
    const body = result.body as { chatId: string; days: Array<Record<string, unknown>> }

    expect(result.status).toBe(200)
    expect(body.chatId).toBe(chatId)
    expect(body.days.map((day) => day.date)).toEqual([
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
    ])
    expect(body.days[3]).toEqual({
      date: '2026-09-20',
      messageCount: 7,
      actionCount: 0,
      appealCount: 2,
      overturnedCount: 0,
    })
    expect(body.days[6]).toEqual({
      date: '2026-09-23',
      messageCount: 3,
      actionCount: 1,
      appealCount: 0,
      overturnedCount: 0,
    })
    expect(body.days[0]).toEqual({
      date: '2026-09-17',
      messageCount: 0,
      actionCount: 0,
      appealCount: 0,
      overturnedCount: 0,
    })
  })

  test('days 默认 30 并 clamp 到 [7, 90]', async () => {
    const { deps } = setup()

    const daysOf = async (days: string | null) => {
      const result = await getPanelSeries(deps, { chatId, days, initData: ownerInitData() })
      return (result.body as { days: unknown[] }).days.length
    }

    expect(await daysOf(null)).toBe(30)
    expect(await daysOf('abc')).toBe(30)
    expect(await daysOf('3')).toBe(7)
    expect(await daysOf('999')).toBe(90)
  })

  test('未登记的群返回全零序列，仍是连续日期', async () => {
    const { deps } = setup()

    const result = await getPanelSeries(deps, { chatId: '-1000000000000', days: '7', initData: ownerInitData() })
    const body = result.body as { days: Array<Record<string, unknown>> }

    expect(body.days).toHaveLength(7)
    expect(body.days.every((day) => day.messageCount === 0 && day.actionCount === 0)).toBe(true)
  })
})

describe('面板处置队列', () => {
  test('默认只返回非放行并按判定时间倒序，群标题、规则与复核结论都带上', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))
    await seedDecision(
      store,
      decisionFixture('d-1', new Date('2026-09-23T10:00:00Z'), {
        signals: [
          { kind: 'rule-hit', ruleId: 'r-a', score: 0.4 },
          { kind: 'llm', verdict: 'spam', confidence: 0.9 },
        ],
      }),
      '低价出售会员',
    )
    await seedDecision(store, decisionFixture('d-2', new Date('2026-09-23T11:00:00Z'), { action: { kind: 'mute', until: new Date('2026-09-23T12:00:00Z') } }))
    await seedDecision(store, decisionFixture('d-pass', new Date('2026-09-23T12:30:00Z'), { action: { kind: 'pass' }, score: 0 }))

    const result = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: null,
      action: null,
      limit: null,
      before: null, beforeId: null,
    })
    const body = result.body as { items: Array<Record<string, unknown>>; nextBefore: unknown }

    expect(result.status).toBe(200)
    expect(body.items.map((item) => item.id)).toEqual(['d-2', 'd-1'])
    expect(body.nextBefore).toBeNull()
    expect(body.items[1]).toEqual({
      id: 'd-1',
      chatId,
      chatTitle: '甲群',
      userId: USER_ID,
      action: 'delete',
      actionUntil: null,
      score: 0.8,
      executed: true,
      decidedAt: new Date('2026-09-23T10:00:00Z'),
      ruleIds: ['r-a'],
      llm: { verdict: 'spam', confidence: 0.9 },
      sampleText: '低价出售会员',
    })
    expect(body.items[0]).toMatchObject({
      action: 'mute',
      actionUntil: new Date('2026-09-23T12:00:00Z'),
      ruleIds: ['r-1'],
      llm: null,
      sampleText: null,
    })
  })

  test('分页：limit + 1 探测下一页，复合游标取最后一条的 (decidedAt, id)', async () => {
    const { deps, store } = setup()
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'
    const thirdId = '33333333-3333-4333-8333-333333333333'
    await seedDecision(store, decisionFixture(firstId, new Date('2026-09-23T10:00:00Z')))
    await seedDecision(store, decisionFixture(secondId, new Date('2026-09-23T11:00:00Z')))
    await seedDecision(store, decisionFixture(thirdId, new Date('2026-09-23T12:00:00Z')))

    const first = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: null,
      action: null,
      limit: '2',
      before: null, beforeId: null,
    })
    const firstBody = first.body as { items: Array<{ id: string }>; nextBefore: { decidedAt: Date; id: string } | null }
    expect(firstBody.items.map((item) => item.id)).toEqual([thirdId, secondId])
    expect(firstBody.nextBefore).toEqual({ decidedAt: new Date('2026-09-23T11:00:00Z'), id: secondId })

    const second = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: null,
      action: null,
      limit: '2',
      before: '2026-09-23T11:00:00.000Z',
      beforeId: secondId,
    })
    const secondBody = second.body as { items: Array<{ id: string }>; nextBefore: unknown }
    expect(secondBody.items.map((item) => item.id)).toEqual([firstId])
    expect(secondBody.nextBefore).toBeNull()
  })

  test('同毫秒并列的记录跨页不重不漏（limit=1 两页取回全部）', async () => {
    const { deps, store } = setup()
    const lowerId = 'aaaaaaaa-1111-4111-8111-111111111111'
    const higherId = 'bbbbbbbb-2222-4222-8222-222222222222'
    const decidedAt = new Date('2026-09-23T11:00:00.000Z')
    await seedDecision(store, decisionFixture(lowerId, decidedAt))
    await seedDecision(store, decisionFixture(higherId, decidedAt))

    const first = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: null,
      action: null,
      limit: '1',
      before: null, beforeId: null,
    })
    const firstBody = first.body as { items: Array<{ id: string }>; nextBefore: { decidedAt: Date; id: string } | null }
    // 时间相同按 id 倒序：先给 id 更大的那条。
    expect(firstBody.items.map((item) => item.id)).toEqual([higherId])
    expect(firstBody.nextBefore).toEqual({ decidedAt, id: higherId })

    const second = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: null,
      action: null,
      limit: '1',
      before: decidedAt.toISOString(),
      beforeId: higherId,
    })
    const secondBody = second.body as { items: Array<{ id: string }>; nextBefore: unknown }
    expect(secondBody.items.map((item) => item.id)).toEqual([lowerId])
    expect(secondBody.nextBefore).toBeNull()
  })

  test('摘录边界：事件行不存在、或存在但没有摘录，sampleText 都是 null', async () => {
    const { deps, store } = setup()
    // 决策还在但事件行已被保留期清理（外键不覆盖 message_events）。
    await store.repos.decisions.insert(decisionFixture('d-orphan', new Date('2026-09-23T10:00:00Z')))
    // 事件行存在但没有摘录（放行或纯媒体）。
    await seedDecision(store, decisionFixture('d-nosample', new Date('2026-09-23T11:00:00Z')))

    const result = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: null,
      action: null,
      limit: null,
      before: null, beforeId: null,
    })
    const body = result.body as { items: Array<{ id: string; sampleText: string | null }> }

    expect(body.items.map((item) => [item.id, item.sampleText])).toEqual([
      ['d-nosample', null],
      ['d-orphan', null],
    ])
  })

  test('过滤：action=all 含放行、具体档位精确匹配、chatId 与 limit clamp', async () => {
    const { deps, store } = setup()
    await seedDecision(store, decisionFixture('d-1', new Date('2026-09-23T10:00:00Z')))
    await seedDecision(store, decisionFixture('d-2', new Date('2026-09-23T11:00:00Z'), { action: { kind: 'mute', until: new Date('2026-09-23T12:00:00Z') } }))
    await seedDecision(store, decisionFixture('d-3', new Date('2026-09-23T12:00:00Z'), { chatId: otherChatId, action: { kind: 'pass' } }))

    const all = await getPanelDecisions(deps, { initData: ownerInitData(), chatId: null, action: 'all', limit: null, before: null, beforeId: null })
    expect((all.body as { items: unknown[] }).items).toHaveLength(3)

    const mutes = await getPanelDecisions(deps, { initData: ownerInitData(), chatId: null, action: 'mute', limit: null, before: null, beforeId: null })
    expect((mutes.body as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual(['d-2'])

    const otherChat = await getPanelDecisions(deps, {
      initData: ownerInitData(),
      chatId: otherChatId,
      action: 'all',
      limit: null,
      before: null, beforeId: null,
    })
    expect((otherChat.body as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual(['d-3'])

    // limit=0 clamp 到 1。
    const clamped = await getPanelDecisions(deps, { initData: ownerInitData(), chatId: null, action: 'all', limit: '0', before: null, beforeId: null })
    expect((clamped.body as { items: unknown[] }).items).toHaveLength(1)
  })

  test('非法 action 与非法游标返回 400', async () => {
    const { deps } = setup()
    const cursorId = '9c8b7a65-1111-4222-8333-999900001111'
    const base = { initData: ownerInitData(), chatId: null, action: null, limit: null }

    const badAction = await getPanelDecisions(deps, { ...base, action: '广告', before: null, beforeId: null })
    expect(badAction.status).toBe(400)
    expect(badAction.body).toMatchObject({ error: 'invalid_request' })

    // 游标必须成对：只给时间或只给 id 都拒绝。
    expect((await getPanelDecisions(deps, { ...base, before: '2026-09-23T11:00:00Z', beforeId: null })).status).toBe(400)
    expect((await getPanelDecisions(deps, { ...base, before: null, beforeId: cursorId })).status).toBe(400)
    // 时间或 id 格式非法同样拒绝。
    expect((await getPanelDecisions(deps, { ...base, before: '昨天', beforeId: cursorId })).status).toBe(400)
    expect((await getPanelDecisions(deps, { ...base, before: '2026-09-23T11:00:00Z', beforeId: 'not-a-uuid' })).status).toBe(400)
  })
})

describe('面板申诉队列', () => {
  test('默认只看待处理，带原处置摘要与摘录；state=all 返回全部', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))
    await seedDecision(store, decisionFixture('d-1', new Date('2026-09-23T10:00:00Z'), { action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') } }), '需要处理的原文')
    await seedDecision(store, decisionFixture('d-2', new Date('2026-09-23T10:30:00Z')))
    await store.repos.appeals.insert(appealFixture('a-1', 'd-1', new Date('2026-09-23T10:05:00Z')))
    await store.repos.appeals.insert(
      appealFixture('a-2', 'd-2', new Date('2026-09-23T10:35:00Z'), {
        state: 'overturned',
        resolvedAt: new Date('2026-09-23T10:40:00Z'),
      }),
    )

    const open = await getPanelAppeals(deps, { initData: ownerInitData(), state: null, limit: null })
    const openBody = open.body as { items: Array<Record<string, unknown>> }
    expect(openBody.items.map((item) => item.id)).toEqual(['a-1'])
    expect(openBody.items[0]).toEqual({
      id: 'a-1',
      userId: USER_ID,
      state: 'open',
      note: '误判了',
      createdAt: new Date('2026-09-23T10:05:00Z'),
      resolvedAt: null,
      decision: {
        id: 'd-1',
        action: 'mute',
        actionUntil: new Date('2026-09-23T11:00:00Z'),
        score: 0.8,
        chatId,
        chatTitle: '甲群',
        sampleText: '需要处理的原文',
      },
    })

    const all = await getPanelAppeals(deps, { initData: ownerInitData(), state: 'all', limit: '1' })
    const allBody = all.body as { items: Array<Record<string, unknown>> }
    // 按创建时间倒序 + limit。
    expect(allBody.items.map((item) => item.id)).toEqual(['a-2'])

    const badState = await getPanelAppeals(deps, { initData: ownerInitData(), state: 'pending', limit: null })
    expect(badState.status).toBe(400)
  })
})

describe('面板结案', () => {
  test('撤销成功：200 返回 overturned 与 rollbackFailed=false，并把 outcome 翻译给 resolveAppeal', async () => {
    const { deps, resolutions } = setup({ kind: 'resolved', rollbackFailed: false, resolvedAt: now })

    const result = await resolvePanelAppeal(deps, {
      appealId,
      body: { initData: ownerInitData(), resolution: 'overturned' },
    })

    expect(result).toEqual({ status: 200, body: { state: 'overturned', rollbackFailed: false } })
    expect(resolutions).toEqual([{ appealId, outcome: 'overturn' }])
  })

  test('回滚失败：200 返回 rollbackFailed=true（前端提示手动处理）', async () => {
    const { deps } = setup({ kind: 'resolved', rollbackFailed: true, resolvedAt: now })

    const result = await resolvePanelAppeal(deps, {
      appealId,
      body: { initData: ownerInitData(), resolution: 'upheld' },
    })

    expect(result).toEqual({ status: 200, body: { state: 'upheld', rollbackFailed: true } })
  })

  test('已被处理（含并发）409，申诉或决策不存在 404', async () => {
    const already = setup({ kind: 'already_resolved' })
    expect(
      await resolvePanelAppeal(already.deps, { appealId, body: { initData: ownerInitData(), resolution: 'upheld' } }),
    ).toEqual({ status: 409, body: { error: 'appeal_resolved' } })

    const missing = setup({ kind: 'missing' })
    expect(
      await resolvePanelAppeal(missing.deps, { appealId, body: { initData: ownerInitData(), resolution: 'upheld' } }),
    ).toEqual({ status: 404, body: { error: 'appeal_not_found' } })
  })

  test('非 uuid 的 id 直接 404，不把非法值交给 resolveAppeal', async () => {
    const { deps, resolutions } = setup()

    const result = await resolvePanelAppeal(deps, {
      appealId: 'not-a-uuid',
      body: { initData: ownerInitData(), resolution: 'upheld' },
    })

    expect(result).toEqual({ status: 404, body: { error: 'appeal_not_found' } })
    expect(resolutions).toEqual([])
  })

  test('请求体缺字段 400', async () => {
    const { deps } = setup()

    const result = await resolvePanelAppeal(deps, { appealId, body: { initData: ownerInitData() } })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: 'invalid_request' })
  })
})
