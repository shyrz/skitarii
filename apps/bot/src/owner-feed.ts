import type { Action, ModerationDecision, Signal, UserId } from '@skitarii/core'
import type { Api } from 'grammy'
import type { Logger } from './logger.js'
import type { DecisionObservation } from './pipeline.js'

/**
 * owner 判定 feed 与处置失败通知。
 *
 * 测试期给 owner 一份逐条可读的判定流水：每条过审消息（含放行）私聊一条摘要，
 * 用来核对规则命中与复核结论，不必去群里对着消息猜。
 * 另有一路「处置失败」通知：动作被 Telegram 终结性拒绝后补偿扫描不会再动它，必须让 owner 看到。
 *
 * 两条路径共用 HTML 解析模式与转义口径：消息字段里有用户可控文本（群标题、正文、拒绝原因），
 * 不转义会让 owner 收到一条被 Telegram 当成标签解析的消息，甚至凭空多出链接。
 *
 * 渲染与发送分开：{@link formatDecisionFeed} 与 {@link formatFailureNotice} 是无 I/O 的纯函数，
 * 样式改动只动那两处；发送侧负责投递，渲染与投递失败一律只记日志：
 * 它们是观察手段，不能反过来影响审核链路。
 */

/** 内容行的截断上限（Unicode 码点）。按码点而非 UTF-16 长度截断，避免截出半个 emoji。 */
const TEXT_LIMIT = 100

/** 超级群 chatId 前缀。Bot API 用 `-100` 区分超级群与普通群，`t.me/c/` 链接只在超级群成立。 */
const SUPERGROUP_PREFIX = '-100'

/** 没有可见文本时的内容行占位。 */
const NO_TEXT = '（无文本）'

/** 判定摘要里的复核信号。`Signal` 的一个分支，单独取出便于按类型收窄。 */
type LlmSignal = Extract<Signal, { kind: 'llm' }>

/**
 * HTML 转义。只处理 Telegram HTML 解析模式会解读的三个字符：`&`、`<`、`>`。
 * `&` 必须最先替换，否则后续替换产生的 `&lt;` / `&gt;` 会被二次转义成 `&amp;lt;`。
 *
 * @param text 待转义文本。
 * @returns 可安全插进 HTML 消息的文本。
 */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 渲染一条判定摘要。
 *
 * 行序固定（用户定稿）：标题、群组、用户、命中、复核、决策、链接、内容。
 * 命中行按信号顺序列出命中规则的 id，复核行取第一条 LLM 信号，两者缺省时整行省略；
 * 链接行优先用评论深链，其次超级群的 `t.me/c/` 链接，普通群没有可用链接、整行省略。
 *
 * @param observation 判定数据，字段取读回的权威决策。
 * @param now 当前时刻，用于把 `mute` 的解禁时刻换算成剩余分钟数。
 * @returns 多行文本，行间 `\n`，无前后缀；以 `parse_mode: 'HTML'` 发送。
 */
export function formatDecisionFeed(observation: DecisionObservation, now: Date): string {
  const lines = [
    `📋 判定：${describeAction(observation.action, now)}（${observation.score.toFixed(2)}）`,
    `群组：${escapeHtml(observation.chatTitle)}`,
    `用户：<a href="tg://user?id=${observation.userId}">${observation.userId}</a>`,
  ]

  const ruleIds = observation.signals.flatMap((signal) => (signal.kind === 'rule-hit' ? [signal.ruleId] : []))
  if (ruleIds.length > 0) lines.push(`命中：${ruleIds.map((ruleId) => escapeHtml(ruleId)).join('、')}`)

  const review = observation.signals.find((signal): signal is LlmSignal => signal.kind === 'llm')
  if (review !== undefined) lines.push(`复核：${review.verdict}（${review.confidence.toFixed(2)}）`)

  lines.push(`决策：${observation.decisionId}`)

  const link = targetLink(observation)
  if (link !== null) lines.push(`链接：${link}`)

  lines.push(`内容：${escapeHtml(contentText(observation.text))}`)
  return lines.join('\n')
}

/**
 * 链接行的取值。
 *
 * 优先级：评论深链（频道帖子 + `?comment=`）优先，其次超级群的 `t.me/c/` 链接，
 * 普通群没有可用的公开链接、返回 `null` 让整行省略。
 *
 * @param observation 判定数据。
 * @returns 链接行内容，或 `null`。
 */
function targetLink(observation: DecisionObservation): string | null {
  const thread = observation.commentThread
  if (thread !== null) {
    return `https://t.me/${escapeHtml(thread.channelUsername)}/${thread.postId}?comment=${observation.messageId}`
  }
  if (!observation.chatId.startsWith(SUPERGROUP_PREFIX)) return null

  const internalId = observation.chatId.slice(SUPERGROUP_PREFIX.length)
  return `https://t.me/c/${internalId}/${observation.messageId}`
}

/**
 * 建立判定 feed 的发送器。
 *
 * 渲染与发送的任何失败都只记 warn 并正常返回：feed 是测试期的观察手段，不能因为 owner
 * 从没和 bot 私聊过（403）之类的投递问题让审核管线失败，更不能拖住动作执行。
 *
 * @param deps Telegram api（只取 `sendMessage`）、owner 用户 id、日志与时间源。
 * @returns 接收一条判定、向 owner 私聊摘要的发送器；永不抛出。
 */
export function createOwnerFeed(deps: {
  api: Pick<Api, 'sendMessage'>
  ownerUserId: UserId
  logger: Logger
  now?: (() => Date) | undefined
}): (observation: DecisionObservation) => Promise<void> {
  const now = deps.now ?? (() => new Date())

  return async (observation) => {
    try {
      await deps.api.sendMessage(deps.ownerUserId, formatDecisionFeed(observation, now()), { parse_mode: 'HTML' })
    } catch (error) {
      deps.logger.warn(
        `判定 feed 发送失败 ownerUserId=${deps.ownerUserId} decisionId=${observation.decisionId}`,
        error,
      )
    }
  }
}

/**
 * 渲染处置失败通知：动作、群、决策 id 与 Telegram 的拒绝原因。
 *
 * 拒绝原因来自 Telegram 的英文描述，可能回显输入里的文本，因此与其他字段一样统一转义。
 *
 * @param decision 被终结性拒绝的决策。
 * @param description Telegram 返回的错误描述（`GrammyError.description`）。
 * @returns 多行文本，行间 `\n`；以 `parse_mode: 'HTML'` 发送。
 */
export function formatFailureNotice(decision: ModerationDecision, description: string): string {
  return [
    `⚠️ 处置失败：${actionLabel(decision.action)}`,
    `群：${escapeHtml(decision.chatId)}`,
    `决策：${decision.id}`,
    `原因：${escapeHtml(description)}`,
  ].join('\n')
}

/**
 * 建立处置失败通知器。
 *
 * 只在动作被 Telegram 终结性拒绝后调用：终态意味着补偿扫描不会再重试，这条决策的结果不该只躺在日志里。
 * 非终态错误不走这里（抛出交给补偿扫描重试）；降级成功与「消息已不存在」按成功处理，也不通知。
 * 与判定 feed 相同的容错口径：渲染与发送失败只记 warn，绝不抛出。
 *
 * @param deps Telegram api（只取 `sendMessage`）、owner 用户 id 与日志。
 * @returns 接收决策与拒绝原因的通知器；永不抛出。
 */
export function createOwnerFailureNotifier(deps: {
  api: Pick<Api, 'sendMessage'>
  ownerUserId: UserId
  logger: Logger
}): (decision: ModerationDecision, description: string) => Promise<void> {
  return async (decision, description) => {
    try {
      await deps.api.sendMessage(deps.ownerUserId, formatFailureNotice(decision, description), { parse_mode: 'HTML' })
    } catch (error) {
      deps.logger.warn(`处置失败通知发送失败 ownerUserId=${deps.ownerUserId} decisionId=${decision.id}`, error)
    }
  }
}

/**
 * 处置的中文短标签（不带时长）。判定摘要与失败通知共用，保证两条消息说同一个档位。
 *
 * @param action 领域处置。
 * @returns 中文短语。
 */
function actionLabel(action: Action): string {
  switch (action.kind) {
    case 'pass':
      return '放行'
    case 'warn':
      return '警示'
    case 'delete':
      return '删除'
    case 'ban':
      return '封禁'
    case 'mute':
      return '禁言'
    default: {
      const exhaustive: never = action
      throw new Error(`未知处置: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * 把处置渲染成中文短语。
 *
 * 禁言按 `until` 与当前时刻的差值取整分钟，最少 1：与群内通知、owner 通知保持同一口径（四舍五入），
 * 已经过期的解禁时刻也不会渲染成「0 分钟」。
 *
 * @param action 领域处置。
 * @param now 当前时刻。
 * @returns 中文短语。
 */
function describeAction(action: Action, now: Date): string {
  if (action.kind !== 'mute') return actionLabel(action)

  const minutes = Math.max(1, Math.round((action.until.getTime() - now.getTime()) / 60_000))
  return `禁言 ${minutes} 分钟`
}

/**
 * 渲染内容行的正文：`\s+` 折叠为单空格并 trim，按 Unicode 码点截断到 {@link TEXT_LIMIT}。
 *
 * @param text 消息原文。
 * @returns 摘要文本；无可见内容时为 {@link NO_TEXT}。
 */
function contentText(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return NO_TEXT

  const codePoints = Array.from(collapsed)
  if (codePoints.length <= TEXT_LIMIT) return collapsed
  return `${codePoints.slice(0, TEXT_LIMIT).join('')}…`
}
