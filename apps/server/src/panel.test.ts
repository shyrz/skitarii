import { asChatId, asUserId, type ChatConfig, type ChatId, type DailyAggregate, type ModerationDecision } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { AppealResolution } from '@skitarii/bot'
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  getPanelAppeals,
  getPanelChatConfig,
  getPanelDecisions,
  getPanelOverview,
  getPanelSeries,
  putPanelChatConfig,
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
  return {
    chatId: id,
    title,
    chatType: 'supergroup',
    linkedChatId: null,
    language: 'zh',
    rules: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  }
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
    features: { hasLink: false, mediaType: 'text', length: 4, customEmojiCount: 0, emojiCount: 0, viaBot: false },
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

/** PUT 的合法 config 基线：一条关键词规则。 */
function configPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
    rules: [{ id: 'rule-1', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true }],
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
      getPanelChatConfig(deps, { chatId, initData: null }),
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

    // 配置端点走同一套鉴权：PUT 体里带非 owner 的 initData 也是 403，且不落库。
    const config = configPayload()
    expect(
      await putPanelChatConfig(deps, { chatId, body: { initData: signInitData(USER_ID), config } }),
    ).toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(await getPanelChatConfig(deps, { chatId, initData: signInitData(USER_ID) })).toEqual({
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
          chatType: 'supergroup',
          linkedChatId: null,
          today: { messageCount: 10, actionCount: 3, appealCount: 1, overturnedCount: 0 },
          last7d: { messageCount: 15, actionCount: 4, appealCount: 1, overturnedCount: 0 },
          openAppeals: 0,
        },
        {
          chatId: otherChatId,
          title: '乙群',
          chatType: 'supergroup',
          linkedChatId: null,
          today: { messageCount: 4, actionCount: 1, appealCount: 0, overturnedCount: 2 },
          last7d: { messageCount: 4, actionCount: 1, appealCount: 0, overturnedCount: 2 },
          openAppeals: 2,
        },
      ],
      serverTime: now,
    })
  })

  test('概览带只读的 chatType / linkedChatId（频道行原样透出登记事实）', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert({
      ...chatConfigFor(chatId, '示例频道'),
      chatType: 'channel',
      linkedChatId: asChatId('-1009999999999'),
    })

    const result = await getPanelOverview(deps, { initData: ownerInitData() })

    expect(result.body).toMatchObject({
      chats: [{ chatId, chatType: 'channel', linkedChatId: '-1009999999999' }],
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

describe('面板规则配置', () => {
  test('读取：返回与 ChatConfig 同形的字段', async () => {
    const { deps, store } = setup()
    const seeded = chatConfigFor(chatId, '甲群')
    await store.repos.chats.upsert(seeded)

    const result = await getPanelChatConfig(deps, { chatId, initData: ownerInitData() })

    expect(result).toEqual({ status: 200, body: seeded })
  })

  test('读取：未登记的群 404', async () => {
    const { deps } = setup()

    expect(await getPanelChatConfig(deps, { chatId, initData: ownerInitData() })).toEqual({
      status: 404,
      body: { error: 'chat_not_found' },
    })
  })

  test('保存：全量替换规则与阈值，保留 title/language，缺省 id 由服务端分配', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: {
        initData: ownerInitData(),
        config: configPayload({
          passThreshold: 0.25,
          llmThreshold: 0.7,
          muteDurationMinutes: 120,
          rules: [
            { id: 'keep-me', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true },
            { id: '', kind: 'regex', pattern: String.raw`t\.me/\+[a-z0-9_-]{16}`, score: 0.4, actionHint: 'delete', enabled: true },
            { kind: 'custom-emoji', pattern: '6', score: 0.4, actionHint: 'delete', enabled: false },
          ],
        }),
      },
    })

    expect(result.status).toBe(200)
    const config = (result.body as { config: ChatConfig }).config
    expect(config).toMatchObject({
      chatId,
      title: '甲群',
      language: 'zh',
      passThreshold: 0.25,
      llmThreshold: 0.7,
      muteDurationMinutes: 120,
    })
    // 全量相等：显式 id 保留，缺省与空串各分配一个 custom id，其余字段一项不漏。
    expect(config.rules).toEqual([
      { id: 'keep-me', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true },
      {
        id: expect.stringMatching(/^custom-[0-9a-f]{8}$/),
        kind: 'regex',
        pattern: String.raw`t\.me/\+[a-z0-9_-]{16}`,
        score: 0.4,
        actionHint: 'delete',
        enabled: true,
      },
      {
        id: expect.stringMatching(/^custom-[0-9a-f]{8}$/),
        kind: 'custom-emoji',
        pattern: '6',
        score: 0.4,
        actionHint: 'delete',
        enabled: false,
      },
    ])
    expect(config.rules[1]?.id).not.toBe(config.rules[2]?.id)
    // 落库的就是返回的那份：管线每条消息读它，「保存后立即生效」由此成立。
    expect(await store.repos.chats.findByChatId(chatId)).toEqual(config)
  })

  test('保存：保留 chatType / linkedChatId 等面板不管理的元数据', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert({
      ...chatConfigFor(chatId, '示例频道'),
      chatType: 'channel',
      linkedChatId: asChatId('-1009999999999'),
    })

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload({ passThreshold: 0.2, llmThreshold: 0.7 }) },
    })

    expect(result.status).toBe(200)
    const config = (result.body as { config: ChatConfig }).config
    expect(config.chatType).toBe('channel')
    expect(config.linkedChatId).toBe('-1009999999999')
    // 落库也保留：全量保存不能把登记的类型/linked 关系冲成默认值。
    const stored = await store.repos.chats.findByChatId(chatId)
    expect(stored?.chatType).toBe('channel')
    expect(stored?.linkedChatId).toBe('-1009999999999')
  })

  test('保存只写规则/阈值：不走 upsert，且不覆盖写之前的并发元数据刷新', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert({
      ...chatConfigFor(chatId, '旧标题'),
      chatType: 'supergroup',
      linkedChatId: null,
    })

    let upsertCalls = 0
    let rulesWrites = 0
    const repos = {
      ...store.repos,
      chats: {
        ...store.repos.chats,
        upsert: async () => {
          upsertCalls += 1
        },
        updateRulesConfig: async (targetChatId: ReturnType<typeof asChatId>, patch: Parameters<typeof store.repos.chats.updateRulesConfig>[1]) => {
          rulesWrites += 1
          // 模拟 bot 的元数据刷新发生在面板读取之后、落库之前。
          await store.repos.chats.updateMetadata(targetChatId, {
            title: '并发刷新后的标题',
            chatType: 'channel',
            linkedChatId: asChatId('-1009999999999'),
          })
          await store.repos.chats.updateRulesConfig(targetChatId, patch)
        },
      },
    }

    const result = await putPanelChatConfig(
      { ...deps, repos },
      { chatId, body: { initData: ownerInitData(), config: configPayload({ passThreshold: 0.2, llmThreshold: 0.7 }) } },
    )

    expect(result.status).toBe(200)
    expect(upsertCalls).toBe(0)
    expect(rulesWrites).toBe(1)
    const stored = await store.repos.chats.findByChatId(chatId)
    // 元数据保住并发刷新的结果；规则用本次保存的值。
    expect(stored?.title).toBe('并发刷新后的标题')
    expect(stored?.chatType).toBe('channel')
    expect(stored?.linkedChatId).toBe('-1009999999999')
    expect(stored?.rules).toEqual((result.body as { config: ChatConfig }).config.rules)
    expect(stored?.passThreshold).toBe(0.2)
  })

  test('保存：emoji-count 与 via-bot 合法；via-bot 允许空 pattern', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: {
        initData: ownerInitData(),
        config: configPayload({
          rules: [
            { id: 'r-emoji', kind: 'emoji-count', pattern: '6', score: 0.4, actionHint: 'delete', enabled: true },
            { id: 'r-via', kind: 'via-bot', pattern: '', score: 0.4, actionHint: 'delete', enabled: true },
          ],
        }),
      },
    })

    expect(result.status).toBe(200)
    expect((result.body as { config: ChatConfig }).config.rules).toEqual([
      { id: 'r-emoji', kind: 'emoji-count', pattern: '6', score: 0.4, actionHint: 'delete', enabled: true },
      { id: 'r-via', kind: 'via-bot', pattern: '', score: 0.4, actionHint: 'delete', enabled: true },
    ])
  })

  test('保存：via-bot 的 pattern 非空或纯空白时归一为空串', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: {
        initData: ownerInitData(),
        config: configPayload({
          rules: [
            { id: 'r-via-filled', kind: 'via-bot', pattern: 'some-pattern', score: 0.4, actionHint: 'delete', enabled: true },
            { id: 'r-via-blank', kind: 'via-bot', pattern: '   ', score: 0.4, actionHint: 'delete', enabled: true },
          ],
        }),
      },
    })

    expect(result.status).toBe(200)
    const config = (result.body as { config: ChatConfig }).config
    // 此 kind 不使用 pattern：两种脏输入都落成空串，落库形状与响应一致。
    expect(config.rules.map((rule) => rule.pattern)).toEqual(['', ''])
    expect(await store.repos.chats.findByChatId(chatId)).toEqual(config)
  })

  test('保存：未知群 404，且不隐式创建', async () => {
    const { deps, store } = setup()

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload() },
    })

    expect(result).toEqual({ status: 404, body: { error: 'chat_not_found' } })
    expect(await store.repos.chats.findByChatId(chatId)).toBeNull()
  })

  test('保存：未知群即使配置明显非法也先 404（结构 → 鉴权 → 群存在 → 语义）', async () => {
    const { deps, store } = setup()

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload({ passThreshold: 0.9, llmThreshold: 0.1 }) },
    })

    expect(result).toEqual({ status: 404, body: { error: 'chat_not_found' } })
    expect(await store.repos.chats.findByChatId(chatId)).toBeNull()
  })

  /** 校验用例的规则基线；覆盖某一字段时用 `{ ...ruleBase, ... }`。 */
  const ruleBase = { id: 'rule-1', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true }

  test('阈值越界：400 的 detail 与契约文案逐字一致', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload({ passThreshold: -0.1 }) },
    })

    expect(result).toEqual({
      status: 400,
      body: { error: 'invalid_request', details: ['阈值：需要满足 0 ≤ passThreshold ≤ llmThreshold ≤ 1'] },
    })
  })

  test.each<[string, Record<string, unknown>, string]>([
    ['阈值乱序', { passThreshold: 0.9, llmThreshold: 0.3 }, '阈值：需要满足'],
    ['时长非整数', { muteDurationMinutes: 1.5 }, 'muteDurationMinutes：需要 1..43200'],
    ['时长超上限', { muteDurationMinutes: 43_201 }, 'muteDurationMinutes：需要 1..43200'],
    [
      '规则超过 100 条',
      { rules: Array.from({ length: 101 }, (_, index) => ({ ...ruleBase, id: `r-${index}` })) },
      'rules：至多 100 条，收到 101 条',
    ],
    ['规则 id 重复', { rules: [ruleBase, { ...ruleBase }] }, '第 2 条规则 id 重复'],
    ['kind 非法', { rules: [{ ...ruleBase, kind: 'fuzzy' }] }, '第 1 条规则 kind 非法'],
    ['正则无法编译', { rules: [{ ...ruleBase, kind: 'regex', pattern: '(' }] }, '第 1 条规则正则无法编译'],
    ['sender-name 正则无法编译', { rules: [{ ...ruleBase, kind: 'sender-name', pattern: '(' }] }, '第 1 条规则正则无法编译'],
    [
      'custom-emoji pattern 非计数',
      { rules: [{ ...ruleBase, kind: 'custom-emoji', pattern: 'abc' }] },
      '第 1 条规则 custom-emoji',
    ],
    [
      'emoji-count pattern 非计数',
      { rules: [{ ...ruleBase, kind: 'emoji-count', pattern: '6个' }] },
      '第 1 条规则 emoji-count',
    ],
    [
      'emoji-count pattern 超出安全整数（与引擎同口径失效）',
      { rules: [{ ...ruleBase, kind: 'emoji-count', pattern: '9'.repeat(20) }] },
      '第 1 条规则 emoji-count',
    ],
    ['pattern 为空', { rules: [{ ...ruleBase, pattern: '' }] }, '第 1 条规则 pattern 不能为空'],
    ['pattern 纯空白', { rules: [{ ...ruleBase, pattern: '   ' }] }, '第 1 条规则 pattern 不能为空'],
    ['score 越界', { rules: [{ ...ruleBase, score: 1.5 }] }, '第 1 条规则 score 需要 0..1'],
    ['actionHint 非法', { rules: [{ ...ruleBase, actionHint: 'banana' }] }, '第 1 条规则 actionHint 非法'],
  ])('校验失败：%s → 400 且 details 指位', async (_name, overrides, expected) => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload(overrides) },
    })

    expect(result.status).toBe(400)
    expect((result.body as { details: string[] }).details.join('\n')).toContain(expected)
    // 校验失败不落库：群配置还是原样。
    expect((await store.repos.chats.findByChatId(chatId))?.passThreshold).toBe(0.3)
  })

  test('校验错误超过 50 条：截断并追加汇总行', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))
    // 60 条坏规则 × 3 个字段错误 = 180 条，足以触发截断。
    const badRules = Array.from({ length: 60 }, (_, index) => ({
      id: `bad-${index}`,
      kind: 'fuzzy',
      pattern: 'x',
      score: 1.5,
      actionHint: 'banana',
      enabled: true,
    }))

    const result = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload({ rules: badRules }) },
    })

    expect(result.status).toBe(400)
    const details = (result.body as { details: string[] }).details
    // 保留前 50 条，最后一行是汇总（50 + 1）。
    expect(details).toHaveLength(51)
    expect(details[0]).toBe('第 1 条规则 kind 非法：fuzzy')
    expect(details[49]).toBe('第 17 条规则 score 需要 0..1：1.5')
    expect(details.at(-1)).toBe('…等 130 条其他错误')
  })

  test('保存：请求体结构不对 400（缺 config / rules 不是数组）', async () => {
    const { deps, store } = setup()
    await store.repos.chats.upsert(chatConfigFor(chatId, '甲群'))

    const missing = await putPanelChatConfig(deps, { chatId, body: { initData: ownerInitData() } })
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ error: 'invalid_request' })
    // 结构错误同样给出字段路径，前端能指到具体位置。
    expect((missing.body as { details: string[] }).details.some((detail) => detail.startsWith('config:'))).toBe(true)

    const wrongType = await putPanelChatConfig(deps, {
      chatId,
      body: { initData: ownerInitData(), config: configPayload({ rules: '不是数组' }) },
    })
    expect(wrongType.status).toBe(400)
    expect((wrongType.body as { details: string[] }).details.some((detail) => detail.startsWith('config.rules'))).toBe(true)
  })
})
