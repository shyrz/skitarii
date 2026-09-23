import type { Verdict } from '@skitarii/core'
import type { JudgeInput, JudgeResult, ModerationJudge } from './types.js'

/**
 * 复核缓存包装。
 *
 * 为什么要包一层而不是把缓存写进复核器：契约（`types.ts`）要求 `ModerationJudge`
 * 是纯 I/O 边界、不读写数据库。缓存需要一个键，而键是消息的 `contentHash`（原文的 sha256），
 * 只有管线知道，所以缓存落在包装函数上，由调用方把 hash 和送审材料一起传进来。
 *
 * 命中缓存的语义：同一段文本在任何一个群被判定过一次就复用结论，省掉一次 LLM 调用。
 * 这不会抹平群之间的规则差异：规则命中与 `decide` 每次照常执行，缓存只替代「复核」这一步。
 */

/** 缓存里一条结论的最小形状。与 `@skitarii/db` 的 `LlmCacheEntry` 结构兼容（那边多出时间戳列）。 */
export interface JudgeCacheRecord {
  contentHash: string
  verdict: Verdict
  confidence: number
  model: string
}

/**
 * 缓存读写端口。刻意只声明用到的两个方法而不是 import 仓储类型：
 * `packages/llm` 不依赖 `packages/db`，测试里传一个 Map 就能跑。
 */
export interface JudgeCache {
  /** 命中返回结论，未命中返回 `null`。 */
  get(contentHash: string): Promise<Omit<JudgeCacheRecord, 'contentHash'> | null>
  /** 回写结论。同一 `contentHash` 已存在时保留先前的值（幂等）。 */
  put(entry: JudgeCacheRecord): Promise<void>
}

/**
 * 带缓存的复核入口。签名比 `ModerationJudge` 多一个 `contentHash`：缓存键由管线提供。
 *
 * @param contentHash 消息原文的 sha256，来自 `MessageEvent.contentHash`。
 * @param input 送审材料。
 * @returns 复核结论；缓存命中时 `rationale` 为 `null`（缓存表不存理由）。
 * @throws {LlmError} 未命中缓存且复核失败时抛出，与 `ModerationJudge` 相同。
 */
export type CachedJudge = (contentHash: string, input: JudgeInput) => Promise<JudgeResult>

/**
 * 构造带缓存的复核器。
 *
 * 缓存读写失败（数据库抖动）会让整次复核失败并向上抛：调用方按「复核不可用」降级为 `warn`，
 * 与 LLM 直连失败的处理一致。不做静默兜底，否则数据库故障会表现为「判定成功率下降」而无人告警。
 *
 * @param deps 复核器与缓存端口。
 * @returns 带缓存的复核入口。
 */
export function createCachedJudge(deps: { judge: ModerationJudge; cache: JudgeCache }): CachedJudge {
  return async (contentHash, input) => {
    const cached = await deps.cache.get(contentHash)
    if (cached !== null) {
      return { verdict: cached.verdict, confidence: cached.confidence, model: cached.model, rationale: null }
    }

    const result = await deps.judge.judge(input)
    await deps.cache.put({
      contentHash,
      verdict: result.verdict,
      confidence: result.confidence,
      model: result.model,
    })

    return result
  }
}
