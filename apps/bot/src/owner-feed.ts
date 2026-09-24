import type { Action, Signal, UserId } from '@skitarii/core'
import type { Api } from 'grammy'
import type { Logger } from './logger.js'
import type { DecisionObservation } from './pipeline.js'

/**
 * owner 判定 feed。
 *
 * 测试期给 owner 一份逐条可读的判定流水：每条过审消息（含放行）私聊一条摘要，
 * 用来核对规则命中与复核结论，不必去群里对着消息猜。
 *
 * 渲染与发送分开：{@link formatDecisionFeed} 是无 I/O 的纯函数，样式改动只动那一处；
 * {@link createOwnerFeed} 负责把渲染结果发给 owner，渲染与投递失败一律只记日志：
 * feed 是观察手段，不能反过来影响审核链路。
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
 * 渲染一条判定摘要。
 *
 * 行序固定（用户定稿）：标题、群组、用户、命中、复核、决策、链接、内容。
 * 命中行按信号顺序列出命中规则的 id，复核行取第一条 LLM 信号，两者缺省时整行省略；
 * 链接行只在超级群出现（普通群的 id 拼不出 `t.me/c/` 链接）。
 *
 * @param observation 判定数据，字段取读回的权威决策。
 * @param now 当前时刻，用于把 `mute` 的解禁时刻换算成剩余分钟数。
 * @returns 多行文本，行间 `\n`，无前后缀。
 */
export function formatDecisionFeed(observation: DecisionObservation, now: Date): string {
  const lines = [
    `📋 判定：${describeAction(observation.action, now)}（${observation.score.toFixed(2)}）`,
    `群组：${observation.chatTitle}`,
    `用户：${observation.userId}`,
  ]

  const ruleIds = observation.signals.flatMap((signal) => (signal.kind === 'rule-hit' ? [signal.ruleId] : []))
  if (ruleIds.length > 0) lines.push(`命中：${ruleIds.join('、')}`)

  const review = observation.signals.find((signal): signal is LlmSignal => signal.kind === 'llm')
  if (review !== undefined) lines.push(`复核：${review.verdict}（${review.confidence.toFixed(2)}）`)

  lines.push(`决策：${observation.decisionId}`)

  if (observation.chatId.startsWith(SUPERGROUP_PREFIX)) {
    const internalId = observation.chatId.slice(SUPERGROUP_PREFIX.length)
    lines.push(`链接：https://t.me/c/${internalId}/${observation.messageId}`)
  }

  lines.push(`内容：${contentText(observation.text)}`)
  return lines.join('\n')
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
      await deps.api.sendMessage(deps.ownerUserId, formatDecisionFeed(observation, now()))
    } catch (error) {
      deps.logger.warn(
        `判定 feed 发送失败 ownerUserId=${deps.ownerUserId} decisionId=${observation.decisionId}`,
        error,
      )
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
  switch (action.kind) {
    case 'pass':
      return '放行'
    case 'warn':
      return '警示'
    case 'delete':
      return '删除'
    case 'ban':
      return '封禁'
    case 'mute': {
      const minutes = Math.max(1, Math.round((action.until.getTime() - now.getTime()) / 60_000))
      return `禁言 ${minutes} 分钟`
    }
    default: {
      const exhaustive: never = action
      throw new Error(`未知处置: ${JSON.stringify(exhaustive)}`)
    }
  }
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
