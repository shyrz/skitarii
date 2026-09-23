import type { ChatConfig, MessageFeatures, Rule, Signal, Verdict } from '@skitarii/core'

/**
 * 云端 LLM 复核的对外契约。本包只定义接口与类型，OpenAI 兼容协议的调用实现归 Phase 1 管线 lane。
 *
 * 设计约束：
 * - BYOK：`baseUrl` / `apiKey` / `model` 都由调用方从环境注入，本包不读环境变量、不持有全局配置。
 * - 复核是「可有可无」的一层：调用失败不能让审核停摆。失败以 `LlmError` 抛出，
 *   调用方捕获后不追加 `Signal`，让 `decide` 走灰色地带的待复核分支。
 */

/** 调用方注入的连接配置。 */
export interface LlmConfig {
  /** 服务根地址，OpenAI 兼容协议形如 `https://host/v1`；实现负责拼 `/chat/completions`。 */
  baseUrl: string
  apiKey: string
  model: string
  /** 单次请求超时（毫秒）。审核在消息路径上，必须短：超时就当作复核不可用。 */
  timeoutMs: number
}

/** 送审材料。只带判定所需的上下文，不带群成员身份等无关数据。 */
export interface JudgeInput {
  /** 归一化后的消息文本；调用方不得传原始文本，避免绕过归一化产生两套判定口径。 */
  text: string
  features: MessageFeatures
  /** 已经命中的规则信号，供模型解释「为什么这条消息可疑」。 */
  signals: Signal[]
  /** 群配置里的语言，决定提示词与期望输出语种。 */
  language: ChatConfig['language']
  /** 该群的规则集，帮助模型对齐本群的判定口径。 */
  rules: Rule[]
}

/** 复核结论。`rationale` 只用于申诉复盘与人工排查，不进任何自动化判定。 */
export interface JudgeResult {
  verdict: Verdict
  /** 0..1。`legit` 时表示「确信正常」的程度，同样参与 `scoreOf` 的最强结论比较。 */
  confidence: number
  /** 产出结论的模型名，写入 `llm_cache.model`。 */
  model: string
  rationale: string | null
}

/** 复核器。实现必须是纯 I/O 边界：进参数、出结论，不读写数据库、不改动消息。 */
export interface ModerationJudge {
  /**
   * 对一条消息做复核。
   *
   * @throws {LlmError} 网络失败、鉴权失败、超时、响应不符合协议。
   */
  judge(input: JudgeInput): Promise<JudgeResult>
}

/** 失败分类。调用方据此决定重试与告警策略，而不是解析错误文本。 */
export type LlmErrorKind =
  | 'auth'
  /** 429 或配额耗尽：过载，可退避重试。 */
  | 'rate-limit'
  | 'timeout'
  /** 响应不符合协议或模型输出无法解析成结论。 */
  | 'bad-response'
  /** 网络层失败：DNS、连接被拒、连接中断。 */
  | 'transport'

/** 复核失败的统一错误类型。 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind

  constructor(kind: LlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmError'
    this.kind = kind
  }
}

/**
 * OpenAI 兼容协议的消息体，仅覆盖本仓库用到的角色。
 * 独立于任何 SDK：协议形状即契约，换 SDK 或换供应商都不影响调用方。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 请求体。`response_format` 用 JSON 模式约束模型输出，具体 schema 由提示词约定并在实现处解析。 */
export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature: number
  response_format: { type: 'json_object' }
  max_tokens: number
}

/** 响应体。只声明本仓库读取的字段，其余字段由实现按需要自行扩展。 */
export interface ChatCompletionResponse {
  model: string
  choices: Array<{
    message: { role: 'assistant'; content: string | null }
    finish_reason: string
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}
