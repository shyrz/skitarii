import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  fetchAppeal,
  fetchPanelAppeals,
  fetchPanelDecisions,
  fetchPanelOverview,
  fetchPanelSeries,
  resolvePanelAppeal,
  submitAppeal,
} from './api.js'

/** 用固定状态码与响应体替换全局 fetch。只断言对外行为：错误分类与请求形状。 */
function stubFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('申诉接口客户端', () => {
  test('200 返回处置与申诉视图', async () => {
    stubFetch(200, {
      decision: { id: 'd1', action: 'delete', chatTitle: '测试群', createdAt: '2026-01-01T00:00:00Z', sampleText: 'x' },
      appeal: null,
    })

    const view = await fetchAppeal('d1', 'init')

    expect(view.decision.action).toBe('delete')
    expect(view.appeal).toBeNull()
  })

  test('initData 随查询串携带，特殊字符被转义', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await fetchAppeal('dec-1', 'a+b c')

    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe('/api/appeals/dec-1?initData=a%2Bb%20c')
  })

  test('404、409、401 分别归类为三种可分支的错误', async () => {
    stubFetch(404)
    await expect(fetchAppeal('d', 'i')).rejects.toBeInstanceOf(NotFoundError)

    stubFetch(409)
    await expect(submitAppeal('d', 'i', '理由')).rejects.toBeInstanceOf(ConflictError)

    stubFetch(401)
    await expect(fetchAppeal('d', 'i')).rejects.toBeInstanceOf(AuthError)
  })

  test('其他状态码抛通用错误并带上状态码', async () => {
    stubFetch(500)

    await expect(fetchAppeal('d', 'i')).rejects.toThrow('HTTP 500')
  })

  test('网络失败原样上抛，不被吞成状态错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    await expect(fetchAppeal('d', 'i')).rejects.toThrow('fetch failed')
  })
})

describe('面板接口客户端', () => {
  test('概览：解析 totals 与 chats，initData 随查询串携带', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            totals: {
              today: { messageCount: 1, actionCount: 2, appealCount: 3, overturnedCount: 4 },
              last7d: { messageCount: 10, actionCount: 20, appealCount: 30, overturnedCount: 40 },
            },
            chats: [
              {
                chatId: '-1001',
                title: '测试群',
                today: { messageCount: 1, actionCount: 1, appealCount: 0, overturnedCount: 0 },
                last7d: { messageCount: 7, actionCount: 7, appealCount: 1, overturnedCount: 1 },
                openAppeals: 2,
              },
            ],
            serverTime: '2026-09-24T00:00:00Z',
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', spy)

    const overview = await fetchPanelOverview('init')

    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe('/api/panel/overview?initData=init')
    expect(overview.totals.today.actionCount).toBe(2)
    expect(overview.chats[0]?.openAppeals).toBe(2)
  })

  test('趋势：chatId 进路径，days 进查询串', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await fetchPanelSeries('-1001', 30, 'a+b c')

    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe(
      '/api/panel/chats/-1001/series?initData=a%2Bb+c&days=30',
    )
  })

  test('处置：筛选与复合游标进查询串，解析 items 与 nextBefore', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'd1',
                chatId: '-1001',
                chatTitle: '测试群',
                userId: 42,
                action: 'mute',
                actionUntil: '2026-09-25T00:00:00Z',
                score: 0.85,
                executed: true,
                decidedAt: '2026-09-24T01:00:00Z',
                ruleIds: ['r1'],
                llm: { verdict: 'spam', confidence: 0.9 },
                sampleText: 'x',
              },
            ],
            nextBefore: { decidedAt: '2026-09-24T01:00:00Z', id: '9c8b7a65-1111-4222-8333-999900001111' },
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', spy)

    const page = await fetchPanelDecisions('i', {
      chatId: '-1001',
      action: 'all',
      limit: 20,
      before: { decidedAt: '2026-09-24T02:00:00Z', id: 'a1b2c3d4-1111-4222-8333-555566667777' },
    })

    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe(
      '/api/panel/decisions?initData=i&chatId=-1001&action=all&limit=20&before=2026-09-24T02%3A00%3A00Z&beforeId=a1b2c3d4-1111-4222-8333-555566667777',
    )
    expect(page.items[0]?.llm?.verdict).toBe('spam')
    expect(page.nextBefore).toEqual({ decidedAt: '2026-09-24T01:00:00Z', id: '9c8b7a65-1111-4222-8333-999900001111' })
  })

  test('处置：无筛选时只带 initData，由后端默认「仅非放行」', async () => {
    const spy = vi.fn(async () => new Response('{"items":[],"nextBefore":null}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await fetchPanelDecisions('i')

    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe('/api/panel/decisions?initData=i')
  })

  test('申诉：state 与 limit 进查询串，返回 items 本体', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'a1',
                userId: 42,
                state: 'open',
                note: '误伤',
                createdAt: '2026-09-24T00:00:00Z',
                resolvedAt: null,
                decision: {
                  id: 'd1',
                  action: 'delete',
                  actionUntil: null,
                  score: 0.6,
                  chatId: '-1001',
                  chatTitle: '测试群',
                  sampleText: 'x',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', spy)

    const items = await fetchPanelAppeals('i', 'all', 10)

    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe(
      '/api/panel/appeals?initData=i&state=all&limit=10',
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.decision.chatTitle).toBe('测试群')
  })

  test('结案：POST body 携带 initData 与 resolution，解析 rollbackFailed', async () => {
    const spy = vi.fn(
      async () => new Response('{"state":"overturned","rollbackFailed":true}', { status: 200 }),
    )
    vi.stubGlobal('fetch', spy)

    const result = await resolvePanelAppeal('a1', 'init', 'overturned')

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/panel/appeals/a1/resolve')
    expect(JSON.parse(String(init.body))).toEqual({ initData: 'init', resolution: 'overturned' })
    expect(result.rollbackFailed).toBe(true)
  })

  test('401、403、404、409 分别归类为四种可分支的错误', async () => {
    stubFetch(401)
    await expect(fetchPanelOverview('i')).rejects.toBeInstanceOf(AuthError)

    stubFetch(403)
    await expect(fetchPanelOverview('i')).rejects.toBeInstanceOf(ForbiddenError)

    stubFetch(404)
    await expect(resolvePanelAppeal('a', 'i', 'upheld')).rejects.toBeInstanceOf(NotFoundError)

    stubFetch(409)
    await expect(resolvePanelAppeal('a', 'i', 'upheld')).rejects.toBeInstanceOf(ConflictError)
  })

  test('其他状态码抛通用错误并带上状态码', async () => {
    stubFetch(500)

    await expect(fetchPanelDecisions('i')).rejects.toThrow('HTTP 500')
  })
})
