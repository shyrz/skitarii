import type { Action, ModerationDecision } from '@skitarii/core'
import type { Api } from 'grammy'
import { GrammyError } from 'grammy'
import type { Repos } from '@skitarii/db'
import { appealKeyboard } from './appeal.js'
import type { IdempotencyRegistry } from './idempotency.js'
import type { Logger } from './logger.js'
import { MUTE_ALL_PERMISSIONS } from './permissions.js'
import { callWithRetry } from './telegram-call.js'
import { isPrivateChatUnreachable, isUnpunishableTarget } from './telegram-errors.js'

/**
 * 处置执行。
 *
 * 职责边界：把已落库的决策施加到 Telegram，并给当事人发一条带申诉入口的处置通知。
 * 判定与落库在管线侧完成，这里不做任何分数或阈值判断。
 *
 * 执行序：先施加动作，再发通知，最后回填 `executed`。
 * - 动作失败（非终态）时不回填，决策留成「未执行」，重投递或人工补偿还能再试一次。
 * - 通知失败（发送失败或 429 退避耗尽）不回滚动作，只在日志里留痕：动作已经生效，通知是可丢的。
 *   通知不做人为丢弃：密集时照常尝试发送，由 Telegram 的 429 退避兜底（见 `telegram-call.ts`）。
 * - 通知先私聊当事人，不可达（未 /start、被拉黑）才回退群内；实际落点记录在决策上，供申诉编辑复用。
 * - 动作被 Telegram 终结性拒绝时不发通知，但照旧回填 `executed`：终结意味着重试不会改变结果，
 *   留着不填只会让补偿扫描反复重投递。配置了 `notifyOwnerFailure` 时私聊 owner 一条失败通知。
 *
 * 幂等：动作与通知都在 `eventId:action` 的闸门内执行；决策已 `executed` 时直接跳过。
 *
 * 终态判定里有两个刻意保留的例外：
 * - 删除动作拿到「消息已不存在」的 400 时按成功处理，详见 {@link isAlreadyGoneTarget}；
 * - 禁言/封禁的目标是管理员或群主时降级为删除同一条消息，详见 {@link applyAction}。
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
  miniAppUrl: string
  logger: Logger
  /** 时间源，默认系统时间。显式允许 `undefined`，让调用方可以直接透传可选配置。 */
  now?: (() => Date) | undefined
  /** 429 退避用的 sleep，测试注入以避免真实等待。 */
  sleep?: ((ms: number) => Promise<void>) | undefined
  /**
   * 终结性拒绝后的私聊通知（处置失败通知）。缺省时不发。
   * 实现必须自行吞掉发送失败（见 `owner-feed.ts` 的 `createOwnerFailureNotifier`），
   * 这里还会再兜一层：通知是旁路，不能让它的异常打断 `executed` 回填。
   */
  notifyOwnerFailure?: ((decision: ModerationDecision, description: string) => Promise<void>) | undefined
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
 * 一次动作施加的结果。
 *
 * `applied` 带的是实际生效的动作：禁言/封禁遇到不可罚目标时会降级为删除，
 * 此时通知与完成日志都必须按这个动作说，不能看决策上的原动作（见 {@link applyAction}）。
 * `rejected` 表示 Telegram 终结性拒绝，决策可以回填 `executed` 但没有可通知的内容；
 * `description` 是拒绝原因，进入失败日志与 owner 私聊。
 */
export type ApplyOutcome = { kind: 'applied'; action: Action } | { kind: 'rejected'; description: string }

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
 * @param deps api、仓储、幂等闸门与日志。
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
        const outcome = await applyAction(deps, decision, context)
        // 终结性拒绝时不发群内通知：说「已删除」而实际没删是误导群成员，而且会给出一个指向不存在的处置的申诉入口。
        // 降级为删除时 outcome 带着实际生效的动作，文案随之改成「已删除」。
        if (outcome.kind === 'applied') {
          await sendNotice(deps, decision, outcome.action, now())
        } else {
          await notifyFailure(deps, decision, outcome.description)
        }
        await deps.repos.decisions.markExecuted(decision.id)
        // 降级时把实际动作也写进日志（如 action=mute effective=delete），否则日志会让人以为禁言真的生效了。
        const effective =
          outcome.kind === 'applied' && outcome.action.kind !== decision.action.kind
            ? ` effective=${outcome.action.kind}`
            : ''
        deps.logger.info(
          `处置完成 decisionId=${decision.id} chatId=${decision.chatId} action=${decision.action.kind}${effective}`,
        )
      })
    },
  }

  /**
   * 施加动作到 Telegram。
   *
   * 两个成功特例都源于「目标已经达成」：删除时消息已不存在（见 {@link isAlreadyGoneTarget}）；
   * 禁言/封禁时目标不可被限制（管理员/群主，见 {@link isUnpunishableTarget}），降级为删除消息。
   *
   * @param executorDeps 执行器依赖。
   * @param decision 决策。
   * @param context 执行上下文（删除动作需要消息 id）。
   * @returns 实际生效的动作；被 Telegram 终结性拒绝时为 `rejected`。
   * @throws {unknown} 非终结错误（网络错误、非 GrammyError）原样抛出，决策保持「未执行」等待重试。
   */
  async function applyAction(
    executorDeps: ActionExecutorDeps,
    decision: ModerationDecision,
    context: ExecutionContext,
  ): Promise<ApplyOutcome> {
    const { api, logger } = executorDeps
    try {
      switch (decision.action.kind) {
        case 'pass':
        case 'warn':
          // 放行与警示都不需要 API 调用：警示语就是处置通知本身（见 sendNotice）。
          return { kind: 'applied', action: decision.action }
        case 'delete':
          await callWithRetry(() => api.deleteMessage(decision.chatId, context.messageId), {
            ...retryOptions,
            label: 'deleteMessage',
          })
          return { kind: 'applied', action: decision.action }
        case 'mute': {
          const untilSeconds = Math.floor(decision.action.until.getTime() / 1_000)
          await callWithRetry(
            () =>
              api.restrictChatMember(decision.chatId, decision.userId, MUTE_ALL_PERMISSIONS, {
                until_date: untilSeconds,
              }),
            { ...retryOptions, label: 'restrictChatMember' },
          )
          return { kind: 'applied', action: decision.action }
        }
        case 'ban':
          await callWithRetry(() => api.banChatMember(decision.chatId, decision.userId), {
            ...retryOptions,
            label: 'banChatMember',
          })
          return { kind: 'applied', action: decision.action }
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
        return { kind: 'applied', action: decision.action }
      }
      // 管理员与群主不可被禁言/封禁（Telegram 平台限制），但消息本身仍可删除。降级 = 改用 delete 动作
      // 重新执行一次：删除路径的「已不存在」与终结判定原样复用，通知文案也随生效动作改成「已删除」。
      if (isUnpunishableTarget(error) && (decision.action.kind === 'mute' || decision.action.kind === 'ban')) {
        logger.info(
          `目标不可被限制（管理员/群主），${decision.action.kind === 'mute' ? '禁言' : '封禁'}降级为删除 decisionId=${decision.id} chatId=${decision.chatId}`,
        )
        return await applyAction(executorDeps, { ...decision, action: { kind: 'delete' } }, context)
      }
      if (isTerminalTelegramError(error)) {
        logger.warn(
          `Telegram 拒绝该动作，按终结处理 decisionId=${decision.id} action=${decision.action.kind}：${error.description}`,
        )
        return { kind: 'rejected', description: error.description }
      }
      throw error
    }
  }
}

/**
 * 发送处置通知：**先私聊当事人，不可达才回退群内**。
 *
 * 私聊优先的理由：处置结果直接递到当事人手里，群里不再出现一条匿名通知（完全静默）。
 * 私聊不可达（从未 /start、已拉黑 bot，或目标是 bot / 已注销账号）时回退群内通知，保留现状形态：匿名文案 + 申诉按钮。
 * 通知不做人为丢弃：密集时直接尝试发送，由 Telegram 的 429 退避兜底；其余失败（含退避耗尽）
 * 都按「通知可丢」处理：通知是旁路，不能反过来影响动作执行。
 *
 * 发送成功后记录通知引用（`notice_*` 列），申诉生命周期据此编辑原通知；记录失败只 warn。
 *
 * @param deps 执行器依赖。
 * @param decision 决策（取群、用户与 decisionId）。
 * @param action 实际生效的动作；降级时它与决策上的原动作不同（见 {@link applyAction}）。
 * @param instant 当前时刻（渲染禁言剩余分钟数）。
 */
async function sendNotice(
  deps: ActionExecutorDeps,
  decision: ModerationDecision,
  action: Action,
  instant: Date,
): Promise<void> {
  const dm = await sendDirectNotice(deps, decision, action, instant)
  // 只有「私聊不可达」才回退群内；其余私聊失败按通知可丢处理，不发群内。
  if (dm !== 'fallback') return
  await sendGroupNotice(deps, decision, action, instant)
}

/** 私聊投递结果：成功；回退群内（不可达）；失败（其余错误，通知可丢）。 */
type DirectNoticeOutcome = 'sent' | 'fallback' | 'failed'

/**
 * 私聊当事人。
 *
 * @param deps 执行器依赖。
 * @param decision 决策。
 * @param action 实际生效的动作。
 * @param instant 当前时刻。
 * @returns 投递结果，决定是否回退群内。
 */
async function sendDirectNotice(
  deps: ActionExecutorDeps,
  decision: ModerationDecision,
  action: Action,
  instant: Date,
): Promise<DirectNoticeOutcome> {
  const target = String(decision.userId)

  try {
    const message = await callWithRetry(
      () =>
        deps.api.sendMessage(decision.userId, noticeText(action, instant, 'dm'), {
          reply_markup: appealKeyboard(deps.miniAppUrl, decision.id),
        }),
      { logger: deps.logger, label: 'sendMessage(dm-notice)' },
    )
    await recordNoticeRef(deps, decision, target, message.message_id)
    return 'sent'
  } catch (error) {
    if (isPrivateChatUnreachable(error)) {
      deps.logger.info(`当事人私聊不可达，回退群内通知 decisionId=${decision.id}`)
      return 'fallback'
    }
    deps.logger.warn(`当事人私聊通知发送失败 decisionId=${decision.id}`, error)
    return 'failed'
  }
}

/**
 * 群内通知（回退形态）：匿名文案 + 申诉按钮，现状不变。
 *
 * @param deps 执行器依赖。
 * @param decision 决策。
 * @param action 实际生效的动作。
 * @param instant 当前时刻。
 */
async function sendGroupNotice(
  deps: ActionExecutorDeps,
  decision: ModerationDecision,
  action: Action,
  instant: Date,
): Promise<void> {
  const text = noticeText(action, instant, 'group')
  try {
    const message = await callWithRetry(
      () => deps.api.sendMessage(decision.chatId, text, { reply_markup: appealKeyboard(deps.miniAppUrl, decision.id) }),
      { logger: deps.logger, label: 'sendMessage(notice)' },
    )
    await recordNoticeRef(deps, decision, decision.chatId, message.message_id)
  } catch (error) {
    deps.logger.warn(`处置通知发送失败 decisionId=${decision.id}`, error)
  }
}

/**
 * 记录通知引用。记录失败只 warn：引用缺失时申诉生命周期的编辑会跳过，不影响主流程。
 *
 * @param deps 执行器依赖。
 * @param decision 决策。
 * @param chatId 通知落点（私聊为用户 id、回退时是群 id，均为字符串形态）。
 * @param messageId 通知消息 id。
 */
async function recordNoticeRef(
  deps: ActionExecutorDeps,
  decision: ModerationDecision,
  chatId: string,
  messageId: number,
): Promise<void> {
  try {
    await deps.repos.decisions.markNoticeSent(decision.id, chatId, messageId)
  } catch (error) {
    deps.logger.warn(`通知引用记录失败，后续编辑将跳过 decisionId=${decision.id}`, error)
  }
}

/**
 * 终结性拒绝后私聊 owner。
 *
 * 迟到的失败通知比不通知好：终态决策不再被补偿扫描接手，owner 只能靠这条私聊知道有人需要人工处理。
 * 通知是旁路：未配置时跳过，实现抛错时吞掉并记 warn，`executed` 回填不受影响。
 *
 * @param deps 执行器依赖。
 * @param decision 被拒绝的决策。
 * @param description Telegram 返回的拒绝原因。
 */
async function notifyFailure(deps: ActionExecutorDeps, decision: ModerationDecision, description: string): Promise<void> {
  if (deps.notifyOwnerFailure === undefined) return

  try {
    await deps.notifyOwnerFailure(decision, description)
  } catch (error) {
    deps.logger.warn(`处置失败通知失败 decisionId=${decision.id}`, error)
  }
}

/**
 * 通知文案。纯函数，便于断言。
 *
 * 两个受众两套口气：群内匿名（现状不变，避免把被处置者点名示众），
 * 私聊第二人称（对接当事人的处置结果）。禁言时长都按剩余分钟数渲染。
 *
 * @param action 处置。
 * @param instant 当前时刻。
 * @param audience `group` 群内匿名；`dm` 私聊当事人（第二人称）。
 * @returns 目标受众可见的文案。
 */
export function noticeText(action: Action, instant: Date, audience: 'group' | 'dm'): string {
  switch (action.kind) {
    case 'pass':
      return ''
    case 'warn':
      return audience === 'dm'
        ? '⚠️ 请注意群规：你发的这条消息疑似违规，请勿重复发送。'
        : '⚠️ 请注意群规：这条消息疑似违规，请勿重复发送。'
    case 'delete':
      return audience === 'dm' ? '🚫 已删除你的违规消息。' : '🚫 已删除一条违规消息。'
    case 'ban':
      return audience === 'dm' ? '⛔ 已将你移出本群。' : '⛔ 已将违规用户移出本群。'
    case 'mute': {
      const minutes = Math.max(1, Math.round((action.until.getTime() - instant.getTime()) / 60_000))
      return audience === 'dm' ? `🔇 已对你禁言 ${minutes} 分钟。` : `🔇 已禁言违规用户 ${minutes} 分钟。`
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
 * 调用方必须先问 {@link isAlreadyGoneTarget} 与 {@link isUnpunishableTarget}：那两类 400 分别代表
 * 「目标已达成」与「可以降级为删除」，都不该按终结失败处理。
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
