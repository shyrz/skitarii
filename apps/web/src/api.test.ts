import { afterEach, describe, expect, test, vi } from 'vitest'
import { AuthError, ConflictError, NotFoundError, fetchAppeal, submitAppeal } from './api.js'

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
