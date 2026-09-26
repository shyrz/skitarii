import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AuthError,
  ForbiddenError,
  SubscriptionApiError,
  subscriptionsApi,
} from './api.js'

/**
 * 订阅端点客户端（phase3b-spec §5）的对外行为：
 * 凭据只走 X-Telegram-Init-Data header、游标原样传、请求体只含契约字段、
 * 错误按 error code 分类（owner 403 与 bot_permission_required 分开）。
 */

/** 用固定状态码与响应体替换全局 fetch。 */
function stubFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function lastCall(spy: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return spy.mock.calls[0] as unknown as [string, RequestInit]
}

/** 断言 promise 以 SubscriptionApiError 拒绝并取出该错误。 */
async function captureApiError(promise: Promise<unknown>): Promise<SubscriptionApiError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  )
  expect(outcome).toBeInstanceOf(SubscriptionApiError)
  return outcome as SubscriptionApiError
}

describe('订阅接口客户端：请求形状', () => {
  test('频道列表：limit/cursor 进查询串，游标原样不解析；凭据只在 header', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ chatId: '-1001', title: '频道一', chatType: 'channel', linkedChatId: null }],
            nextCursor: null,
            serverTime: '2026-09-26T00:00:00.000Z',
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', spy)

    const page = await subscriptionsApi.fetchChannels('init data+1', {
      limit: 50,
      cursor: 'eyJ2IjoxLCJyIjoiY2hhbm5lbHMifQ',
    })

    const [url, init] = lastCall(spy)
    expect(url).toBe(
      '/api/panel/subscriptions/channels?limit=50&cursor=eyJ2IjoxLCJyIjoiY2hhbm5lbHMifQ',
    )
    expect(url).not.toContain('initData')
    expect(init.headers).toEqual({ 'X-Telegram-Init-Data': 'init data+1' })
    expect(init.body).toBeUndefined()
    expect(page.items[0]?.chatId).toBe('-1001')
  })

  test('无游标时查询串只带 limit', async () => {
    const spy = vi.fn(async () => new Response('{"items":[],"nextCursor":null,"serverTime":"t"}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await subscriptionsApi.fetchLinks('-1001', 'i', { limit: 50 })

    expect(lastCall(spy)[0]).toBe('/api/panel/subscriptions/channels/-1001/links?limit=50')
  })

  test('频道详情：chatId 进路径并转义，header 携带凭据', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chatId: '-1001',
            title: '频道一',
            chatType: 'channel',
            linkedChatId: null,
            visibility: 'public',
            canManageLinks: true,
            capabilityCheckedAt: '2026-09-26T00:00:00.000Z',
            capabilityErrorCode: null,
            counts: { known: 0, member: 0, left: 0, unknown: 0 },
            serverTime: '2026-09-26T00:00:00.000Z',
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', spy)

    const details = await subscriptionsApi.fetchChannelDetails('-1001', 'i')

    expect(lastCall(spy)[0]).toBe('/api/panel/subscriptions/channels/-1001')
    expect(lastCall(spy)[1].headers).toEqual({ 'X-Telegram-Init-Data': 'i' })
    expect(details.visibility).toBe('public')
  })

  test('创建：POST body 只含 requestId/name/priceStars（不含周期与 initData）', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ link: { id: 'l1' }, replayed: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', spy)

    const result = await subscriptionsApi.createLink('-1001', 'init', {
      requestId: '11111111-2222-4333-8444-555566667777',
      name: '支持频道',
      priceStars: 100,
    })

    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/panel/subscriptions/channels/-1001/links')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'X-Telegram-Init-Data': 'init',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(init.body))).toEqual({
      requestId: '11111111-2222-4333-8444-555566667777',
      name: '支持频道',
      priceStars: 100,
    })
    expect(result.replayed).toBe(true)
  })

  test('改名：PATCH 只发 name/expectedVersion，响应解包 link', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ link: { id: 'l1', name: '新名', version: 3 } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', spy)

    const link = await subscriptionsApi.renameLink('-1001', 'l1', 'i', { name: '新名', expectedVersion: 2 })

    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/panel/subscriptions/channels/-1001/links/l1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ name: '新名', expectedVersion: 2 })
    expect(link.version).toBe(3)
  })

  test('撤销：POST 只发 expectedVersion，响应解包 link', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ link: { id: 'l1', state: 'revoked', version: 4 } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', spy)

    const link = await subscriptionsApi.revokeLink('-1001', 'l1', 'i', { expectedVersion: 3 })

    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/panel/subscriptions/channels/-1001/links/l1/revoke')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 3 })
    expect(link.state).toBe('revoked')
  })

  test('成员列表：limit/cursor 原样进查询串', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'm1',
                chatId: '-1001',
                userId: 42,
                linkId: null,
                state: 'member',
                expiresAt: null,
                evidence: 'until_date',
                firstObservedAt: '2026-09-26T00:00:00.000Z',
                observedAt: '2026-09-26T00:00:00.000Z',
                observationSource: 'event',
                lastCheckedAt: null,
                lastCheckSucceededAt: null,
                lastCheckErrorCode: null,
              },
            ],
            nextCursor: 'next-cursor',
            serverTime: '2026-09-26T00:00:00.000Z',
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', spy)

    const page = await subscriptionsApi.fetchMembers('-1001', 'i', {
      limit: 100,
      cursor: 'CURSOR==',
    })

    expect(lastCall(spy)[0]).toBe(
      '/api/panel/subscriptions/channels/-1001/members?limit=100&cursor=CURSOR%3D%3D',
    )
    expect(page.items[0]?.userId).toBe(42)
    expect(page.nextCursor).toBe('next-cursor')
  })
})

describe('订阅接口客户端：错误按 error code 分类', () => {
  test('401 → AuthError（凭据失效，需重新从 Telegram 进入）', async () => {
    stubFetch(401, { error: 'init_data_invalid', message: '凭据无效', retryable: false })

    await expect(subscriptionsApi.fetchChannels('i')).rejects.toBeInstanceOf(AuthError)
  })

  test('403 且 error=forbidden → ForbiddenError（owner 全局屏）', async () => {
    stubFetch(403, { error: 'forbidden', message: '仅管理员可用', retryable: false })

    await expect(subscriptionsApi.fetchChannelDetails('-1001', 'i')).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  test('403 且 error=bot_permission_required → 保留 SubscriptionApiError，供频道内局部提示', async () => {
    stubFetch(403, { error: 'bot_permission_required', message: '缺少权限', retryable: false })

    const error = await captureApiError(
      subscriptionsApi.renameLink('-1001', 'l1', 'i', { name: 'x', expectedVersion: 1 }),
    )

    expect(error.code).toBe('bot_permission_required')
    expect(error).not.toBeInstanceOf(ForbiddenError)
  })

  test('409/502 携带 code、retryable 与 requestId', async () => {
    stubFetch(409, {
      error: 'create_outcome_unknown',
      message: '结果不确定',
      retryable: true,
      requestId: '11111111-2222-4333-8444-555566667777',
    })

    const apiError = await captureApiError(
      subscriptionsApi.createLink('-1001', 'i', { requestId: 'r', name: '', priceStars: 1 }),
    )

    expect(apiError.status).toBe(409)
    expect(apiError.code).toBe('create_outcome_unknown')
    expect(apiError.retryable).toBe(true)
    expect(apiError.requestId).toBe('11111111-2222-4333-8444-555566667777')
  })

  test('404 与 502 的 code 原样带出，消息用服务端文案', async () => {
    stubFetch(404, { error: 'channel_not_found', message: '频道不存在', retryable: false })
    const notFound = await captureApiError(subscriptionsApi.fetchLinks('-9999', 'i'))
    expect(notFound.code).toBe('channel_not_found')

    stubFetch(502, { error: 'telegram_outcome_unknown', message: '上游结果未知', retryable: true })
    const upstream = await captureApiError(
      subscriptionsApi.revokeLink('-1001', 'l1', 'i', { expectedVersion: 1 }),
    )
    expect(upstream.code).toBe('telegram_outcome_unknown')
    expect(upstream.message).toBe('上游结果未知')
  })

  test('响应体不是 JSON 时退回通用错误（带状态码）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })))

    const error = await captureApiError(subscriptionsApi.fetchMembers('-1001', 'i'))

    expect(error.code).toBe('')
    expect(error.status).toBe(502)
    expect(error.message).toContain('HTTP 502')
  })

  test('网络失败原样上抛，不被吞成状态错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    await expect(subscriptionsApi.fetchChannels('i')).rejects.toThrow('fetch failed')
  })
})
