import { clamp01, type Verdict } from '@skitarii/core'
import { z } from 'zod'
import { buildJudgeMessages } from './prompt.js'
import { LlmError, type ChatCompletionRequest, type ChatCompletionResponse, type JudgeInput, type JudgeResult, type LlmConfig, type LlmErrorKind, type ModerationJudge } from './types.js'

/**
 * OpenAI 兼容 `/chat/completions` 的复核器实现。
 *
 * 边界职责：
 * - 只做「一次 HTTP 调用 + 响应解析」，不读环境变量、不碰数据库、不缓存。缓存是 `cached-judge.ts` 的职责。
 * - 所有失败都归一成 `LlmError`，调用方按 `kind` 决定重试与降级，不需要解析错误文本。
 * - 失败即抛，不返回「推测值」：复核层缺失时让 `decide` 走灰色地带的 `warn` 分支，
 *   比给一个编造的 verdict 更安全。
 *
 * 状态码到 `LlmErrorKind` 的映射（表驱动意图明确，调用方按 kind 分支）：
 * - 401 / 403 → `auth`（key 无效或无权限，重试无意义）
 * - 429 → `rate-limit`（配额或过载，可退避重试）
 * - 408 / 5xx → `transport`（上游暂时不可用，可重试）
 * - 其余 4xx → `bad-response`（请求本身有问题，例如模型名不存在）
 */

/** 请求固定参数。`temperature` 取 0：同一段文本必须在两次调用间得到相同结论，否则缓存与申诉复核都失去意义。 */
const REQUEST_TEMPERATURE = 0

/**
 * 补全上限。判定输出只有一个 JSON 对象（verdict + confidence + 一句话理由），
 * 200 token 足够，也能挡住模型「展开分析」把响应时间和费用放大一个量级。
 */
const MAX_COMPLETION_TOKENS = 200

/** 系统返回的补全体。只校验本仓库读取的字段，与 `types.ts` 的 `ChatCompletionResponse` 对齐。 */
const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ role: z.literal('assistant'), content: z.string().nullable() }),
        finish_reason: z.string(),
      }),
    )
    .min(1),
})

/** 模型输出的 JSON 结论。`rationale` 允许缺失或为 null：它只用于人工复盘，缺失不影响判定。 */
const judgementSchema = z.object({
  verdict: z.enum(['legit', 'spam', 'scam']),
  confidence: z.number(),
  rationale: z.string().nullish(),
})

/** 复核器的可选依赖。`fetch` 只在测试里替换，生产走全局实现。 */
export interface OpenAiJudgeOptions {
  /** HTTP 客户端。默认 `globalThis.fetch`（Node 18+ 内置）。 */
  fetch?: typeof globalThis.fetch
}

/**
 * 构造复核器。
 *
 * @param config 连接配置（BYOK，由调用方从环境注入）。
 * @param options 可选依赖注入。
 * @returns 复核器；每次调用发起一次 HTTP 请求。
 */
export function createOpenAiJudge(config: LlmConfig, options: OpenAiJudgeOptions = {}): ModerationJudge {
  const doFetch = options.fetch ?? globalThis.fetch
  const endpoint = `${config.baseUrl.replace(/\/+$/u, '')}/chat/completions`

  return {
    async judge(input: JudgeInput): Promise<JudgeResult> {
      const request: ChatCompletionRequest = {
        model: config.model,
        messages: buildJudgeMessages(input),
        temperature: REQUEST_TEMPERATURE,
        response_format: { type: 'json_object' },
        max_tokens: MAX_COMPLETION_TOKENS,
      }

      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw classifyFetchFailure(error, config)
      }

      if (!response.ok) {
        throw new LlmError(
          classifyHttpStatus(response.status),
          `复核请求失败：HTTP ${response.status} ${response.statusText}（model=${config.model}）`,
        )
      }

      const completion = await readCompletion(response, config)
      return readJudgement(completion, config)
    },
  }
}

/**
 * 解析 HTTP 响应体为补全对象。
 *
 * @param response 已确认 `ok` 的响应。
 * @param config 用于在响应缺少 `model` 时回填请求模型名。
 * @returns 补全对象；`model` 缺失时取请求模型。
 * @throws {LlmError} 响应体不是 JSON 或结构不符合协议时抛出 `bad-response`。
 */
async function readCompletion(response: Response, config: LlmConfig): Promise<ChatCompletionResponse> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new LlmError('bad-response', '复核响应体不是合法 JSON', { cause })
  }

  const parsed = completionSchema.safeParse(payload)
  if (!parsed.success) {
    throw new LlmError('bad-response', '复核响应不符合 OpenAI 兼容协议', { cause: parsed.error })
  }

  const choice = parsed.data.choices[0]
  if (choice === undefined) throw new LlmError('bad-response', '复核响应没有 choices')

  // 缺失 model 时回填请求模型：缓存行需要模型名，而协议允许服务端不回填该字段。
  return { model: parsed.data.model ?? config.model, choices: [choice] }
}

/**
 * 解析补全内容为复核结论。
 *
 * @param completion 补全对象。
 * @param config 连接配置，仅用于错误信息。
 * @returns 复核结论，`confidence` 已夹到 0..1。
 * @throws {LlmError} 内容为空、不是 JSON、或字段不符合结论 schema 时抛出 `bad-response`。
 */
function readJudgement(completion: ChatCompletionResponse, config: LlmConfig): JudgeResult {
  const choice = completion.choices[0]
  if (choice === undefined) throw new LlmError('bad-response', '复核响应没有 choices')

  const content = choice.message.content
  if (content === null || content.trim().length === 0) {
    throw new LlmError('bad-response', `复核响应内容为空（finish_reason=${choice.finish_reason}）`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(content)
  } catch (cause) {
    throw new LlmError('bad-response', `复核输出不是 JSON（model=${config.model}）`, { cause })
  }

  const parsed = judgementSchema.safeParse(payload)
  if (!parsed.success) throw new LlmError('bad-response', '复核输出缺 verdict 或 confidence', { cause: parsed.error })

  // 编译期对齐：schema 的 verdict 必须是领域 `Verdict`，新增取值时这里会失败。
  const verdict: Verdict = parsed.data.verdict
  const rationale = typeof parsed.data.rationale === 'string' ? parsed.data.rationale.trim() : ''

  return {
    verdict,
    confidence: clamp01(parsed.data.confidence),
    model: completion.model,
    rationale: rationale.length === 0 ? null : rationale,
  }
}

/**
 * 把 HTTP 状态码映射为失败分类。
 *
 * @param status 响应状态码。
 * @returns 失败分类。
 */
function classifyHttpStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 408 || status >= 500) return 'transport'
  return 'bad-response'
}

/**
 * 把 fetch 的 rejection 映射为失败分类。
 *
 * `AbortSignal.timeout` 触发的中止在 undici 里是 `TimeoutError`，手工中止是 `AbortError`，两者都算超时。
 * 其余（DNS 失败、连接被拒、连接中断）都归 `transport`。
 *
 * @param error 捕获到的异常。
 * @param config 连接配置，仅用于错误信息。
 * @returns 归一化的复核错误。
 */
function classifyFetchFailure(error: unknown, config: LlmConfig): LlmError {
  const name = error instanceof Error ? error.name : undefined
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LlmError('timeout', `复核请求超时：${config.timeoutMs}ms（model=${config.model}）`, { cause: error })
  }
  return new LlmError('transport', `复核请求网络层失败（model=${config.model}）`, { cause: error })
}
