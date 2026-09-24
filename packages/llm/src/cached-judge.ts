import { createHash } from 'node:crypto'
import type { Verdict } from '@skitarii/core'
import type { JudgeInput, JudgeResult, ModerationJudge } from './types.js'

/**
 * 复核缓存包装。
 *
 * 为什么要包一层而不是把缓存写进复核器：契约（`types.ts`）要求 `ModerationJudge`
 * 是纯 I/O 边界、不读写数据库。缓存需要一个键，而键要由管线手里的送审材料派生，
 * 所以缓存落在包装函数上，由调用方把正文的内容哈希和送审材料一起传进来。
 *
 * 缓存键是判定指纹（见 `judgeFingerprint`），覆盖提示词消费的全部输入：正文之外，
 * 同一条正文换一个发送者身份、语言、消息特征、规则命中组合或误伤样例都会得到不同的键。
 * 只按正文哈希缓存在身份之间复用结论：可疑身份能直接继承普通身份拿到的 legit，反之则误伤。
 * 指纹前缀在提示词口径变更时升版整体失效（当前 `v2`，相对 `v1` 纳入误伤样例）；库里存的仍是
 * 不可逆摘要，身份原文不落库（`llm_cache.content_hash` 列存的即是指纹，不是裸内容哈希）。
 *
 * 命中缓存的语义：同一份送审材料被判定过一次就复用结论，省掉一次 LLM 调用。
 * 这不会抹平群之间的规则差异：规则命中与 `decide` 每次照常执行，缓存只替代「复核」这一步；
 * 两群规则集不同、命中信号自然不同，送审材料（含信号）就是不同的键。
 */

/** 缓存里一条结论的最小形状。与 `@skitarii/db` 的 `LlmCacheEntry` 结构兼容（那边多出时间戳列）。 */
export interface JudgeCacheRecord {
  /**
   * 判定指纹。字段沿用数据库列名 `content_hash`（改列名要迁移，收益不抵成本），
   * 但存的是指纹而不是裸内容哈希，见模块顶部说明。
   */
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
  /** 按判定指纹命中返回结论，未命中返回 `null`。 */
  get(fingerprint: string): Promise<Omit<JudgeCacheRecord, 'contentHash'> | null>
  /** 回写结论。同一指纹已存在时保留先前的值（幂等）。 */
  put(entry: JudgeCacheRecord): Promise<void>
}

/**
 * 判定指纹：sha256(`v2|<正文内容哈希>|<发送者身份>|<语言>|<特征>|<信号>|<误伤样例 JSON>`) 的十六进制摘要。
 *
 * 覆盖范围与提示词消费的输入一一对应（`prompt.ts` 的 `buildJudgeMessages`）：
 * 正文（contentHash 是它的 sha256）、发送者身份、语言（决定 system 提示）、
 * 消息特征（`hasLink` / `mediaType` / `length` / `customEmojiCount`）、已命中信号
 * （rule-hit 记为 `r:<ruleId>:<score>`，llm 结论记为 `l:<verdict>:<confidence>`，按序逗号连接）
 * 与误伤样例（`JSON.stringify(examples ?? [])`，顺序敏感：样例按最近优先传入，换序即换键）。
 * 任何一项不同都不该复用结论，因此任何一项都必须进指纹。信号里的 ruleId 还隐含了
 * 「哪条规则命中」，两群规则集不同导致的信号差异会自然分键。
 *
 * `v2` 相对 `v1` 只多了样例一项：升级时旧缓存整体失效（等 30 天保留期清掉），
 * 避免用「没有样例」的结论回答「带样例」的请求。前缀留给未来提示词口径变更时再次整体失效。
 *
 * @param contentHash 消息原文的 sha256，来自 `MessageEvent.contentHash`。
 * @param input 送审材料。
 * @returns 十六进制判定指纹，直接作缓存键。
 */
function judgeFingerprint(contentHash: string, input: JudgeInput): string {
  const { hasLink, mediaType, length, customEmojiCount } = input.features
  const signals = input.signals
    .map((signal) =>
      signal.kind === 'rule-hit'
        ? `r:${signal.ruleId}:${signal.score}`
        : `l:${signal.verdict}:${signal.confidence}`,
    )
    .join(',')

  const payload = [
    'v2',
    contentHash,
    input.senderIdentity ?? '',
    input.language,
    String(hasLink),
    mediaType,
    String(length),
    String(customEmojiCount),
    signals,
    JSON.stringify(input.examples ?? []),
  ].join('|')

  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * 带缓存的复核入口。签名比 `ModerationJudge` 多一个 `contentHash`：正文之外的身份、
 * 特征与规则信号都在 `input` 里，缓存键由两者共同派生。
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
    const fingerprint = judgeFingerprint(contentHash, input)
    const cached = await deps.cache.get(fingerprint)
    if (cached !== null) {
      return { verdict: cached.verdict, confidence: cached.confidence, model: cached.model, rationale: null }
    }

    const result = await deps.judge.judge(input)
    await deps.cache.put({
      contentHash: fingerprint,
      verdict: result.verdict,
      confidence: result.confidence,
      model: result.model,
    })

    return result
  }
}
