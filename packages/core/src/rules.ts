import { clamp01 } from './decide.js'
import type { MessageFeatures, Rule, RuleKind, Signal } from './types.js'

/** 匹配器入参。`normalized` 必须是 `normalize` 的输出，规则 pattern 也按同一形态编写。 */
interface MatchInput {
  normalized: string
  features: MessageFeatures
}

/** 单种匹配方式的实现：纯判定，不产出分数（分数由规则自身携带）。 */
type RuleMatcher = (pattern: string, input: MatchInput) => boolean

/**
 * 匹配方式注册表。新增一种 `RuleKind` 时只在此登记，`matchRules` 与调用方都不改；
 * 这正是「规则是数据不是分支表」的落点：规则数量与匹配方式数量都不应出现在控制流里。
 */
const MATCHERS: Readonly<Record<RuleKind, RuleMatcher>> = {
  keyword: (pattern, { normalized }) => pattern.length > 0 && normalized.includes(pattern),
  regex: (pattern, { normalized }) => testRegex(normalized, pattern),
  'link-domain': (pattern, { normalized, features }) => features.hasLink && matchesDomain(normalized, pattern),
}

/** 域名判定用的 host 形状：至少一个点，标签由字母、数字、连字符组成。端口、路径、查询串不在匹配内。 */
const HOST_TOKEN = /[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu

/**
 * 对归一化文本逐条求值启用中的规则，产出规则命中信号。
 *
 * 前提：`rules` 已在系统边界校验过形状（见 `packages/db` 对 `chats.rules` 的解析），
 * 函数内部不再做结构校验，只兜住单条规则自身的坏数据（例如写坏的正则），
 * 保证一条坏规则不会让整条消息的审核流程抛错。
 *
 * @param normalized `normalize` 的输出。
 * @param features 消息特征；`link-domain` 规则依赖 `hasLink`。
 * @param rules 群的规则集。`enabled === false` 的规则被跳过，不改动入参数组。
 * @returns 命中信号，顺序与 `rules` 中的相对顺序一致，`score` 已夹到 0..1。
 */
export function matchRules(normalized: string, features: MessageFeatures, rules: Rule[]): Signal[] {
  const input: MatchInput = { normalized, features }
  const signals: Signal[] = []

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!MATCHERS[rule.kind](rule.pattern, input)) continue
    signals.push({ kind: 'rule-hit', ruleId: rule.id, score: clamp01(rule.score) })
  }

  return signals
}

/**
 * 正则规则判定。
 *
 * 以 `u` 标志编译：规则里可以用 `\p{Script=Han}` 一类 Unicode 属性，但 `\-` 之类在 `u` 下非法的写法会编译失败。
 * 编译失败按「不命中」处理并在边界处（规则保存接口）暴露，理由见 `matchRules` 的说明。
 *
 * @param text 归一化文本。
 * @param pattern 正则源串，不含标志与定界符。
 * @returns 是否命中。
 */
function testRegex(text: string, pattern: string): boolean {
  if (pattern.length === 0) return false
  try {
    return new RegExp(pattern, 'u').test(text)
  } catch {
    return false
  }
}

/**
 * 域名规则判定。按 host 语义比较，而不是子串包含：
 * `spam.com` 命中 `spam.com` 与 `a.spam.com`（子域），不命中 `notspam.com`（后缀巧合）与 `spam.com.tw`（另一个域名）。
 *
 * 文本里的候选 host 直接从归一化文本里取，因此规则 pattern 与文本两侧都不需要转义处理，比较是纯字符串操作。
 *
 * @param text 归一化文本。
 * @param pattern 域名，按规范形态小写书写。
 * @returns 是否存在属于该域名（含子域）的 host。
 */
function matchesDomain(text: string, pattern: string): boolean {
  const domain = pattern.toLowerCase()
  if (domain.length === 0) return false

  const hosts = text.match(HOST_TOKEN)
  if (hosts === null) return false

  const suffix = `.${domain}`
  return hosts.some((host) => host === domain || host.endsWith(suffix))
}
