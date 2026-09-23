import type { Action, ChatConfig, RuleAction, Signal, Verdict } from './types.js'

/**
 * 违规决策计数达到该值时，后续非放行处置加重一档。
 * 「达 3 次」是运营口径（同一用户在同一群的累计违规数），调整它等于调整对累犯的惩罚力度。
 */
export const RECIDIVISM_THRESHOLD = 3

/** 加重一档的链：warn → delete → mute → ban。`pass` 不在链上，放行不是处罚。 */
const ESCALATION: Readonly<Record<RuleAction, RuleAction>> = {
  pass: 'pass',
  warn: 'delete',
  delete: 'mute',
  mute: 'ban',
  ban: 'ban',
}

/** 命中规则已被删除、或消息只被 LLM 判违规时的默认处置档位。取 `delete`：可人工恢复，比 `ban` 有回旋余地。 */
const DEFAULT_ACTION_HINT: RuleAction = 'delete'

/** LLM 结论对总分的贡献。`legit` 记 0：复核否定的语义是「分数不该因这次判定而升高」。 */
const LLM_SCORE_WEIGHT: Readonly<Record<Verdict, (confidence: number) => number>> = {
  legit: () => 0,
  spam: (confidence) => clamp01(confidence),
  scam: (confidence) => clamp01(confidence),
}

/** 灰色地带里 LLM 结论的走向。复核判定为正常则放行，判定违规则按主导规则的 actionHint 处置。 */
const GREY_ZONE_OUTCOME: Readonly<Record<Verdict, 'pass' | 'confirm'>> = {
  legit: 'pass',
  spam: 'confirm',
  scam: 'confirm',
}

/** 把任意数值夹到 0..1。分数口径的唯一收口点，规则分数与 LLM 置信度都经它清洗。 */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 合并信号得到 0..1 的违规总分。
 *
 * 规则命中逐条累加（每条先夹到 0..1，总分封顶 1）；
 * LLM 结论只取最强的一条计入，避免同一条消息多次送审时分数被重复叠加。
 *
 * @param signals 规则命中与（可选的）LLM 复核信号。
 * @returns 违规总分，0..1。
 */
export function scoreOf(signals: Signal[]): number {
  let ruleScore = 0
  for (const signal of signals) {
    if (signal.kind === 'rule-hit') ruleScore += clamp01(signal.score)
  }

  const judgement = strongestJudgement(signals)
  const llmScore = judgement === undefined ? 0 : LLM_SCORE_WEIGHT[judgement.verdict](judgement.confidence)

  return clamp01(ruleScore + llmScore)
}

/**
 * 按双阈值把信号映射为最终处置。
 *
 * 分支语义与 `ChatConfig` 的两个阈值一一对应：
 * - `score < passThreshold`：放行，不消耗 LLM 调用。
 * - `score >= llmThreshold`：直接执行主导规则的 `actionHint`，不消耗 LLM 调用。
 * - 其余（灰色地带）：由复核结论接管。`legit` 放行，`spam` / `scam` 落到主导规则的 `actionHint`。
 *   如果调用方还没拿到复核信号（LLM 不可用、缓存未命中尚未回填），返回 `warn` 作为待复核处置：
 *   灰色地带的定义就是「规则分数不足以定案」，此时直接按 `actionHint` 动手会让 `llmThreshold` 失去意义
 *   （等价于把阈值降到 `passThreshold`）。该 `warn` 不参与累犯加重，因为没有复核结论支撑。
 *
 * 累犯加重：`history.priorViolations >= RECIDIVISM_THRESHOLD` 时，非放行处置沿 warn → delete → mute → ban 加重一档。
 *
 * 本函数只在生成 `mute` 时读挂钟（算出解禁时刻），其余路径完全由入参决定。
 *
 * @param signals 规则命中，加上复核结论（若有）。
 * @param config 群的规则集与阈值。
 * @param history `priorViolations` 为该用户在该群的累计违规决策数，由调用方查询后传入。
 * @returns 最终处置。
 */
export function decide(signals: Signal[], config: ChatConfig, history: { priorViolations: number }): Action {
  const score = scoreOf(signals)
  if (score < config.passThreshold) return { kind: 'pass' }

  const hint = dominantActionHint(signals, config)
  if (score >= config.llmThreshold) return toAction(escalate(hint, history), config)

  const judgement = strongestJudgement(signals)
  if (judgement === undefined) return { kind: 'warn' }
  if (GREY_ZONE_OUTCOME[judgement.verdict] === 'pass') return { kind: 'pass' }

  return toAction(escalate(hint, history), config)
}

/**
 * 取最强的一条复核结论：confidence 最高者，同分取先出现的。
 * 同一条消息正常只会有一条复核信号，出现多条时（例如重试）以最高置信度为准，结果是确定的。
 *
 * @param signals 全部信号。
 * @returns 复核结论；没有任何 LLM 信号时为 `undefined`。
 */
function strongestJudgement(signals: Signal[]): { verdict: Verdict; confidence: number } | undefined {
  let best: { verdict: Verdict; confidence: number } | undefined

  for (const signal of signals) {
    if (signal.kind !== 'llm') continue
    const confidence = clamp01(signal.confidence)
    if (best === undefined || confidence > best.confidence) {
      best = { verdict: signal.verdict, confidence }
    }
  }

  return best
}

/**
 * 主导规则决定用哪个 `actionHint`：分数最高的命中规则，同分取先命中者。
 * 规则已从配置里删除时退到 `DEFAULT_ACTION_HINT`，保证历史信号仍可复现出处置。
 *
 * @param signals 全部信号。
 * @param config 当前配置，用于把 `ruleId` 还原成规则。
 * @returns 处置档位。
 */
function dominantActionHint(signals: Signal[], config: ChatConfig): RuleAction {
  let dominantId: string | undefined
  let dominantScore = -1

  for (const signal of signals) {
    if (signal.kind !== 'rule-hit') continue
    const score = clamp01(signal.score)
    if (score > dominantScore) {
      dominantScore = score
      dominantId = signal.ruleId
    }
  }

  if (dominantId === undefined) return DEFAULT_ACTION_HINT
  return config.rules.find((rule) => rule.id === dominantId)?.actionHint ?? DEFAULT_ACTION_HINT
}

/**
 * 累犯加重：达到阈值时沿 `ESCALATION` 升一档。
 *
 * @param hint 本次处置档位。
 * @param history 该用户的累计违规数。
 * @returns 加重后的档位。
 */
function escalate(hint: RuleAction, history: { priorViolations: number }): RuleAction {
  return history.priorViolations >= RECIDIVISM_THRESHOLD ? ESCALATION[hint] : hint
}

/**
 * 把档位落成带数据的处置。`mute` 需要具体解禁时刻，因此在这里读取当前时间。
 *
 * @param hint 处置档位。
 * @param config 提供禁言时长。
 * @returns 最终处置。
 */
function toAction(hint: RuleAction, config: ChatConfig): Action {
  switch (hint) {
    case 'pass':
      return { kind: 'pass' }
    case 'warn':
      return { kind: 'warn' }
    case 'delete':
      return { kind: 'delete' }
    case 'mute':
      return { kind: 'mute', until: new Date(Date.now() + config.muteDurationMinutes * 60_000) }
    case 'ban':
      return { kind: 'ban' }
    default: {
      const exhaustive: never = hint
      throw new Error(`未支持的处置档位: ${String(exhaustive)}`)
    }
  }
}
