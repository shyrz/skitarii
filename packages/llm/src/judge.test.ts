import type { JudgeInput, JudgeResult, LlmConfig } from './types.js'
import { describe, expect, test, vi } from 'vitest'
import { createCachedJudge, type JudgeCache, type JudgeCacheRecord } from './cached-judge.js'
import { createOpenAiJudge } from './openai-judge.js'

const config: LlmConfig = {
  baseUrl: 'https://llm.example.com/v1/',
  apiKey: 'test-key',
  model: 'gpt-4o-mini',
  timeoutMs: 5_000,
}

const input: JudgeInput = {
  text: '全网最低价会员年卡，需要的加v私聊',
  features: { hasLink: false, mediaType: 'text', length: 18 },
  signals: [{ kind: 'rule-hit', ruleId: 'rule-1', score: 0.4 }],
  language: 'zh',
  rules: [{ id: 'rule-1', kind: 'keyword', pattern: '加v', score: 0.4, actionHint: 'delete', enabled: true }],
}

/**
 * 构造一次补全响应。
 *
 * @param content 模型输出的字符串（通常是 JSON）。
 * @param overrides 覆盖响应体字段，用于构造协议异常。
 * @returns 真实 `Response` 对象（undici 的全局实现），与生产路径同形。
 */
function completionResponse(content: string | null, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * 构造必定返回给定响应的 fetch 替身，并记录请求。
 *
 * @param responder 根据调用序号返回响应或抛错。
 * @returns `fetch` 替身与已记录的请求。
 */
function createFetchStub(responder: (call: { url: string; init: RequestInit | undefined }) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    return await responder(call)
  }) as unknown as typeof globalThis.fetch
  return { stub, calls }
}

describe('OpenAI 兼容复核器', () => {
  test('把模型输出解析成结论，并带上服务端返回的模型名', async () => {
    const { stub, calls } = createFetchStub(() =>
      completionResponse('{"verdict":"spam","confidence":0.82,"rationale":"促销引流"}'),
    )
    const judge = createOpenAiJudge(config, { fetch: stub })

    const result = await judge.judge(input)

    expect(result).toEqual({
      verdict: 'spam',
      confidence: 0.82,
      model: 'gpt-4o-mini-2024-07-18',
      rationale: '促销引流',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://llm.example.com/v1/chat/completions')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.temperature).toBe(0)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages.at(-1).content).toContain('全网最低价会员年卡')
  })

  test('越界的 confidence 被夹到 0..1', async () => {
    const { stub } = createFetchStub(() => completionResponse('{"verdict":"scam","confidence":1.4}'))
    const result = await createOpenAiJudge(config, { fetch: stub }).judge(input)

    expect(result.confidence).toBe(1)
    expect(result.rationale).toBeNull()
  })

  test('缺少 rationale 时结论仍然成立', async () => {
    const { stub } = createFetchStub(() => completionResponse('{"verdict":"legit","confidence":0.6}'))
    const result = await createOpenAiJudge(config, { fetch: stub }).judge(input)

    expect(result.verdict).toBe('legit')
    expect(result.rationale).toBeNull()
  })

  test.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate-limit'],
    [500, 'transport'],
    [503, 'transport'],
    [400, 'bad-response'],
  ])('HTTP %i 映射为 %s', async (status, expectedKind) => {
    const { stub } = createFetchStub(() => new Response('{"error":{"message":"nope"}}', { status }))
    const judge = createOpenAiJudge(config, { fetch: stub })

    await expect(judge.judge(input)).rejects.toMatchObject({ name: 'LlmError', kind: expectedKind })
  })

  test('网络层失败归为 transport', async () => {
    const { stub } = createFetchStub(() => {
      throw new TypeError('fetch failed')
    })

    await expect(createOpenAiJudge(config, { fetch: stub }).judge(input)).rejects.toMatchObject({
      kind: 'transport',
    })
  })

  test('超时归为 timeout', async () => {
    const { stub } = createFetchStub(() => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })

    await expect(createOpenAiJudge(config, { fetch: stub }).judge(input)).rejects.toMatchObject({ kind: 'timeout' })
  })

  test('响应体不是 JSON 时归为 bad-response', async () => {
    const { stub } = createFetchStub(() => new Response('<html>gateway</html>', { status: 200 }))

    await expect(createOpenAiJudge(config, { fetch: stub }).judge(input)).rejects.toMatchObject({
      kind: 'bad-response',
    })
  })

  test('模型输出不是约定的结论结构时归为 bad-response', async () => {
    const { stub } = createFetchStub(() => completionResponse('{"verdict":"广告","confidence":0.9}'))

    await expect(createOpenAiJudge(config, { fetch: stub }).judge(input)).rejects.toMatchObject({
      kind: 'bad-response',
    })
  })

  test('模型把结论包在 markdown 代码块里也算解析失败（提示词已要求纯 JSON）', async () => {
    const { stub } = createFetchStub(() => completionResponse('```json\n{"verdict":"spam","confidence":0.9}\n```'))

    await expect(createOpenAiJudge(config, { fetch: stub }).judge(input)).rejects.toMatchObject({
      kind: 'bad-response',
    })
  })

  test('补全内容为空时归为 bad-response', async () => {
    const { stub } = createFetchStub(() => completionResponse(null, { choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }] }))

    await expect(createOpenAiJudge(config, { fetch: stub }).judge(input)).rejects.toMatchObject({
      kind: 'bad-response',
    })
  })

  test('送审消息里带规则命中的解释，且消息文本被标记包围', async () => {
    const { stub, calls } = createFetchStub(() => completionResponse('{"verdict":"legit","confidence":0.5}'))
    await createOpenAiJudge(config, { fetch: stub }).judge(input)

    const body = JSON.parse(String(calls[0]?.init?.body))
    const last = body.messages.at(-1)
    expect(last.content).toContain('keyword「加v」')
    expect(last.content).toContain('【待复核消息】')
    expect(body.messages[0].content).toContain('拉人头')
    // few-shot 三对 + system + 本次 user
    expect(body.messages).toHaveLength(8)
  })
})

describe('带缓存的复核器', () => {
  /** 内存缓存替身，记录读写次数。 */
  function createMemoryCache(seed: JudgeCacheRecord | null = null) {
    const store = new Map<string, JudgeCacheRecord>()
    if (seed !== null) store.set(seed.contentHash, seed)
    const puts: JudgeCacheRecord[] = []
    const cache: JudgeCache = {
      async get(contentHash) {
        return store.get(contentHash) ?? null
      },
      async put(entry) {
        puts.push(entry)
        if (!store.has(entry.contentHash)) store.set(entry.contentHash, entry)
      },
    }
    return { cache, puts }
  }

  test('命中缓存时不调用复核器，直接复用结论且不带理由', async () => {
    const { cache } = createMemoryCache({
      contentHash: 'hash-1',
      verdict: 'scam',
      confidence: 0.91,
      model: 'gpt-4o-mini-2024-07-18',
    })
    const judge = { judge: vi.fn<() => Promise<JudgeResult>>() }
    const cached = createCachedJudge({ judge, cache })

    const result = await cached('hash-1', input)

    expect(result).toEqual({
      verdict: 'scam',
      confidence: 0.91,
      model: 'gpt-4o-mini-2024-07-18',
      rationale: null,
    })
    expect(judge.judge).not.toHaveBeenCalled()
  })

  test('未命中时调用复核器并按 contentHash 回写', async () => {
    const { cache, puts } = createMemoryCache()
    const judge = {
      judge: vi.fn(async () => ({ verdict: 'spam' as const, confidence: 0.77, model: 'gpt-4o-mini', rationale: '推广' })),
    }
    const cached = createCachedJudge({ judge, cache })

    const result = await cached('hash-2', input)

    expect(result).toEqual({ verdict: 'spam', confidence: 0.77, model: 'gpt-4o-mini', rationale: '推广' })
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(puts).toEqual([{ contentHash: 'hash-2', verdict: 'spam', confidence: 0.77, model: 'gpt-4o-mini' }])
  })

  test('第二次相同内容直接走缓存，不再调用复核器', async () => {
    const { cache, puts } = createMemoryCache()
    const judge = {
      judge: vi.fn(async () => ({
        verdict: 'legit' as const,
        confidence: 0.6,
        model: 'gpt-4o-mini',
        rationale: '个人闲置转让',
      })),
    }
    const cached = createCachedJudge({ judge, cache })

    const first = await cached('hash-3', input)
    const second = await cached('hash-3', input)

    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(puts).toHaveLength(1)
    expect(second).toEqual({ ...first, rationale: null })
  })

  test('复核失败时不写缓存，错误原样抛出', async () => {
    const { cache, puts } = createMemoryCache()
    const failure = new Error('boom')
    const judge = {
      judge: vi.fn(async () => {
        throw failure
      }),
    }
    const cached = createCachedJudge({ judge, cache })

    await expect(cached('hash-4', input)).rejects.toBe(failure)
    expect(puts).toEqual([])
  })
})
