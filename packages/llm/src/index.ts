/**
 * `@skitarii/llm` 的公开表面：复核契约与类型、OpenAI 兼容实现、复核缓存包装。
 *
 * 上层只从这个入口取东西：`createOpenAiJudge` 负责协议与错误分类，
 * `createCachedJudge` 负责用 `contentHash` 复用结论，两者都不读环境变量。
 */

export { createCachedJudge } from './cached-judge.js'
export type { CachedJudge, JudgeCache, JudgeCacheRecord } from './cached-judge.js'
export { createOpenAiJudge } from './openai-judge.js'
export type { OpenAiJudgeOptions } from './openai-judge.js'
export { buildJudgeMessages } from './prompt.js'
export { LlmError } from './types.js'
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  JudgeInput,
  JudgeResult,
  LlmConfig,
  LlmErrorKind,
  ModerationJudge,
} from './types.js'
