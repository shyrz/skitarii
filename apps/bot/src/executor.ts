import type { Action, ModerationDecision } from '@skitarii/core'
import type { Api } from 'grammy'
import { GrammyError } from 'grammy'
import type { Repos } from '@skitarii/db'
import { appealKeyboard } from './appeal.js'
import type { IdempotencyRegistry } from './idempotency.js'
import type { Logger } from './logger.js'
import { MUTE_ALL_PERMISSIONS } from './permissions.js'
import { callWithRetry } from './telegram-call.js'
import type { TokenBucket } from './token-bucket.js'

/**
 * 处置执行。
 *
 * 职责边界：把已落库的决策施加到 Telegram，并在群里发一条带申诉入口的处置通知。
 * 判定与落库在管线侧完成，这里不做任何分数或阈值判断。
 *
 * 执行序：先施加动作，再发通知，最后回填 `executed`。
 * - 动作失败（非终态）时不回填，决策留成「未执行」，重投递或人工补偿还能再试一次。
 * - 通知失败（限流桶空、编辑失败）不回滚动作，只在日志里留痕：动作已经生效，通知是可丢的。
 *
 * 幂等：动作与通知都在 `eventId:action` 的闸门内执行；决策已 `executed` 时直接跳过。
 *
 * 终态判定里有一个刻意保留的例外：删除动作拿到「消息已不存在」的 400 时按成功处理，
 * 详见 {@link isAlreadyGoneTarget}。
 */

/**
 * 执行上下文：决策之外必须由管线带来的信息。
 *
 * 刻意不带正文摘录：通知与动作都不需要它，摘录只走 `attachSample` 落库、
 * 只在申诉页面与 owner 通知里出现，不进入动作执行路径。
 */
export interface ExecutionContext {
  /** 被处置的消息 id（删除动作需要）。 */
  messageId: number
}

/** 执行器依赖。 */
export interface ActionExecutorDeps {
  api: Api
  repos: Repos
  idempotency: IdempotencyRegistry
  /** 群内通知的限流桶，键是 chatId。 */
  outbound: TokenBucket
  miniAppUrl: string
  logger: Logger
  /** 时间源，默认系统时间。显式允许 `undefined`，让调用方可以直接透传可选配置。 */
  now?: (() => Date) | undefined
  /** 429 退避用的 sleep，测试注入以避免真实等待。 */
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/** 处置执行器。 */
export interface ActionExecutor {
  /**
   * 执行一条决策。
   *
   * @param decision 已落库的决策（`executed === false`）。
   * @param context 执行上下文。
   */
  execute(decision: ModerationDecision, context: ExecutionContext): Promise<void>
}

/**
 * 决策的幂等键。
 *
 * 执行器与补偿扫描必须用同一个键：补偿扫描若用另一个键去查闸门，就会把「本进程已经施加过、
 * 但 `executed` 回填还没落库」的动作再施加一次（二次禁言会重置解禁时刻）。
 *
 * @param decision 决策。
 * @returns `${eventId}:${action}`。
 */
export function idempotencyKeyOf(decision: ModerationDecision): string {
  return `${decision.eventId}:${decision.action.kind}`
}

/**
 * 建立执行器。
 *
 * @param deps api、仓储、幂等闸门、限流桶与日志。
 * @returns 执行器。
 */
export function createActionExecutor(deps: ActionExecutorDeps): ActionExecutor {
  const now = deps.now ?? (() => new Date())
  const retryOptions = { logger: deps.logger, sleep: deps.sleep }

  return {
    async execute(decision, context): Promise<void> {
      if (decision.executed) {
        deps.logger.info(`决策已执行，跳过重复处置 decisionId=${decision.id}`)
        return
      }

      if (decision.action.kind === 'pass') {
        // 放行也要回填 executed：崩溃恢复时「未执行的决策」应当只剩真正待施加的动作。
        await deps.repos.decisions.markExecuted(decision.id)
        return
      }

      await deps.idempotency.run(idempotencyKeyOf(decision), async () => {
        const applied = await applyAction(deps, decision, context)
        // 动作没生效（被 Telegram 终结性拒绝）时不发通知：说「已删除」而实际没删是误导群成员，
        // 而且会给出一个指向不存在的处置的申诉入口。
        if (applied) await sendNotice(deps, decision, now())
        await deps.repos.decisions.markExecuted(decision.id)
        deps.logger.info(
          `处置完成 decisionId=${decision.id} chatId=${decision.chatId} action=${decision.action.kind}`,
        )
      })
    },
  }

  /**
   * 施加动作到 Telegram。
   *
   * @param executorDeps 执行器依赖。
   * @param decision 决策。
   * @param context 执行上下文（删除动作需要消息 id）。
   * @returns 动作是否生效：被 Telegram 终结性拒绝（400）时为 `false`，删除时目标消息已不存在时为 `true`。
   */
  async function applyAction(
    executorDeps: ActionExecutorDeps,
    decision: ModerationDecision,
    context: ExecutionContext,
  ): Promise<boolean> {
    const { api, logger } = executorDeps
    try {
      switch (decision.action.kind) {
        case 'pass':
        case 'warn':
          // 放行与警示都不需要 API 调用：警示语就是处置通知本身（见 sendNotice）。
          return true
        case 'delete':
          await callWithRetry(() => api.deleteMessage(decision.chatId, context.messageId), {
            ...retryOptions,
            label: 'deleteMessage',
          })
          return true
        case 'mute': {
          const untilSeconds = Math.floor(decision.action.until.getTime() / 1_000)
          await callWithRetry(
            () =>
              api.restrictChatMember(decision.chatId, decision.userId, MUTE_ALL_PERMISSIONS, {
                until_date: untilSeconds,
              }),
            { ...retryOptions, label: 'restrictChatMember' },
          )
          return true
        }
        case 'ban':
          await callWithRetry(() => api.banChatMember(decision.chatId, decision.userId), {
            ...retryOptions,
            label: 'banChatMember',
          })
          return true
        default: {
          const exhaustive: never = decision.action
          throw new Error(`未知处置: ${JSON.stringify(exhaustive)}`)
        }
      }
    } catch (error) {
      // 「要删的消息已经不在了」= 删除的目标已达成，不是失败：继续发通知，保住申诉入口。
      if (isAlreadyGoneTarget(error, decision.action)) {
        logger.info(
          `消息已不存在，删除目标视为达成 decisionId=${decision.id} chatId=${decision.chatId}：${error.description}`,
        )
        return true
      }
      if (isTerminalTelegramError(error)) {
        logger.warn(
          `Telegram 拒绝该动作，按终结处理 decisionId=${decision.id} action=${decision.action.kind}：${error.description}`,
        )
        return false
      }
      throw error
    }
  }
}

/**
 * 发送群内处置通知，附带 Mini App 申诉入口。
 *
 * 限流桶取不到令牌时直接放弃本次发送：通知是可丢的，为它排队会拖慢审核路径。
 * 通知不重复消息正文：群成员看得到原消息，摘要摘录属于申诉页面与 owner。
 *
 * @param deps 执行器依赖。
 * @param decision 决策。
 * @param instant 当前时刻（渲染禁言剩余分钟数）。
 */
async function sendNotice(deps: ActionExecutorDeps, decision: ModerationDecision, instant: Date): Promise<void> {
  if (!deps.outbound.tryTake(decision.chatId)) {
    deps.logger.warn(`出站限流，跳过处置通知 chatId=${decision.chatId} decisionId=${decision.id}`)
    return
  }

  const text = noticeText(decision.action, instant)
  try {
    await callWithRetry(
      () => deps.api.sendMessage(decision.chatId, text, { reply_markup: appealKeyboard(deps.miniAppUrl, decision.id) }),
      { logger: deps.logger, label: 'sendMessage(notice)' },
    )
  } catch (error) {
    deps.logger.warn(`处置通知发送失败 decisionId=${decision.id}`, error)
  }
}

/**
 * 通知文案。纯函数，便于断言。
 *
 * @param action 处置。
 * @param instant 当前时刻。
 * @returns 群里可见的文案。
 */
export function noticeText(action: Action, instant: Date): string {
  switch (action.kind) {
    case 'pass':
      return ''
    case 'warn':
      return '⚠️ 请注意群规：这条消息疑似违规，请勿重复发送。'
    case 'delete':
      return '🚫 已删除一条违规消息。'
    case 'ban':
      return '⛔ 已将违规用户移出本群。'
    case 'mute': {
      const minutes = Math.max(1, Math.round((action.until.getTime() - instant.getTime()) / 60_000))
      return `🔇 已禁言违规用户 ${minutes} 分钟。`
    }
    default: {
      const exhaustive: never = action
      throw new Error(`未知处置: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * 判断是不是「再试也没用」的 Telegram 错误。
 *
 * 400 覆盖了这些终结场景：消息过旧无法删除、bot 权限不足、用户是匿名管理员。
 * 区别对待它们能让决策不再无限重试，同时把原因留在日志里。
 *
 * 调用方必须先问 {@link isAlreadyGoneTarget}：那类 400 的目标已经达成，不算失败。
 *
 * @param error 捕获到的异常。
 * @returns 非 400 的 API 错误与网络错误返回 `false`。
 */
function isTerminalTelegramError(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 400
}

/** 「目标消息已经不在了」的 400 描述：`deleteMessage` 用前者，其余按消息 id 操作的方法用后者。 */
const TARGET_GONE_PATTERN = /message(?: to delete)? not found/u

/**
 * 判断删除动作是不是「消息本来就没了」。
 *
 * 处置的目标只是让这条消息从群里消失，Telegram 回「message to delete not found」或「message not found」
 * 说明目标已达成（人工删了、上一条 update 已经删过、或两次重投递撞在一起）。把它当失败会让决策停在
 * 「未执行」，而终结处理又会吞掉通知，受处置的用户因此看不到申诉按钮——目标已经达成，不该丢申诉入口。
 * 其余 400（权限不足、消息过旧、bot 被移出群）仍然是失败：那些场景下消息还在群里，说「已删除」是误导。
 *
 * @param error 捕获到的异常。
 * @param action 本次决策的处置。
 * @returns 删除动作且描述命中「message not found」时为 `true`（此时 `error` 一定是 GrammyError）。
 */
function isAlreadyGoneTarget(error: unknown, action: Action): error is GrammyError {
  if (action.kind !== 'delete') return false
  if (!(error instanceof GrammyError) || error.error_code !== 400) return false
  return TARGET_GONE_PATTERN.test(error.description)
}
