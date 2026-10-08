import type { Action, ChatId, ModerationDecision } from '@skitarii/core'
import type { Api } from 'grammy'
import { GrammyError } from 'grammy'
import type { Repos } from '@skitarii/db'
import { appealKeyboard } from './appeal.js'
import type { IdempotencyRegistry } from './idempotency.js'
import type { Logger } from './logger.js'
import { isNonMemberTargetError } from './nonmember.js'
import { MUTE_ALL_PERMISSIONS } from './permissions.js'
import { callWithRetry } from './telegram-call.js'
import { isPrivateChatUnreachable, isUnpunishableTarget } from './telegram-errors.js'

/**
 * 处置执行。
 *
 * 职责边界：把已落库的决策施加到 Telegram，并给当事人发一条带申诉入口的处置通知。
 * 判定与落库在管线侧完成，这里不做任何分数或阈值判断。
 *
 * 执行序：删除动作「先投递通知、再施加动作」，其余动作「先施加动作、再投递通知」，最后回填 `executed`。
 * - 删除动作先发通知：群内回退通知要「回复被处置消息」，被处置消息必须还在，删掉后回复无从指向。
 *   投递前先读通知引用（`notice_*` 列），已有引用说明上次已经发过（崩溃重跑、补偿重投递），跳过投递；
 *   命中群内落点时重挂一次 TTL（计时只活在进程内存里，见 {@link sendNotice}）。
 *   删除被 Telegram 终结性拒绝时撤回那条已发出的通知（见 {@link retractNotice}），避免留下
 *   「已删除」的假消息与指向未生效处置的申诉入口；撤回是 best-effort，失败只记日志。
 * - 其余动作都保留先动作后通知：警示/禁言/封禁都不删消息，群内回复照常成立；禁言/封禁降级为删除时
 *   消息可能已被降级删除，`allow_sending_without_reply` 保证通知照发（无回复链接），文案仍按实际生效动作说。
 * - 动作失败（非终态）时不回填，决策留成「未执行」，重投递或人工补偿还能再试一次。
 *   删除动作在这个重试窗口内有固有不一致：通知已发出（声称已删除）而消息尚未删除（先通知后删的必然取舍）；
 *   补偿重试成功即收口，最终终结拒绝则撤回通知。窗口长度以补偿扫描的节奏为界，不做额外的一致性补偿。
 * - 通知失败（发送失败或 429 退避耗尽）不回滚已生效动作。warn 的通知就是动作，未确认送达会记录结果并通知 owner。
 *   通知不做人为丢弃：密集时照常尝试发送，由 Telegram 的 429 退避兜底（见 `telegram-call.ts`）。
 * - 通知先私聊当事人，不可达（未 /start、被拉黑）才回退群内；实际落点记录在决策上，供申诉编辑复用。
 *   回退到群里的通知随后被安排为 5 分钟后删除（见 `GROUP_NOTICE_TTL_MS`），私聊通知不受影响。
 * - 动作被 Telegram 终结性拒绝时不发新通知，但照旧回填 `executed`：终结意味着重试不会改变结果，
 *   留着不填只会让补偿扫描反复重投递。配置了 `notifyOwnerFailure` 时私聊 owner 一条失败通知。
 *
 * 幂等：动作与通知都在 `eventId:action` 的闸门内执行；决策已 `executed` 时直接跳过。
 *
 * 终态判定里有三个刻意保留的例外：
 * - 删除动作拿到「消息已不存在」的 400 时按成功处理，详见 {@link isAlreadyGoneTarget}；
 * - 禁言/封禁的目标是管理员或群主时降级为删除同一条消息，详见 {@link applyAction}；
 * - 禁言/封禁的目标已不在群里（400「非参与者」类文案，`isNonMemberTargetError`）时同样降级为删除：
 *   非成员策略对已离开者只能施加删除这一种仍有效的动作。
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

/**
 * 群内回退通知发送成功后的存活时长：到期自动删除。
 *
 * 为什么按「发送后」而不是「查看后」：Bot API 不提供已读/查看事件（群与私聊都没有），
 * 拿不到「当事人已看到」的信号，只能退化为从发送时刻起算的固定 TTL。私聊通知与 owner feed
 * 不适用本规则（见 {@link sendGroupNotice}）。
 *
 * 计时只活在进程内存里：进程重启会丢掉尚未触发的删除，部署窗口内极少数群内通知可能残留。
 * 这是有意接受的取舍——不为可丢的旁路通知引入持久化调度。
 */
export const GROUP_NOTICE_TTL_MS = 5 * 60_000

/**
 * 延迟执行一次任务。
 *
 * 供群内通知的定时删除用（见 {@link GROUP_NOTICE_TTL_MS}）。实现负责在延迟后调用 `task`，
 * 并保证任务异常不会变成未处理拒绝。
 */
export type Schedule = (delayMs: number, task: () => Promise<void>) => void

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
   * 延迟任务调度器，用于群内通知的定时删除（见 {@link GROUP_NOTICE_TTL_MS}）。
   * 默认真实定时器：`setTimeout` 加 `unref`（不阻止进程退出），任务异常吞掉并 warn；
   * 测试注入 fake 记录任务、手动触发，避免 5 分钟真实等待。
   */
  schedule?: Schedule | undefined
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
  const schedule = deps.schedule ?? createTimerSchedule(deps.logger)

  return {
    async execute(decision, context): Promise<void> {
      if (decision.executed) {
        deps.logger.info(`决策已执行，跳过重复处置 decisionId=${decision.id}`)
        return
      }

      await deps.idempotency.run(idempotencyKeyOf(decision), async () => {
        const current = await deps.repos.decisions.findById(decision.id)
        if (current === null || current.executed) return
        decision = current
        const appeal = await deps.repos.appeals.findByDecisionId(decision.id)
        if (appeal?.state === 'overturned') {
          await deps.repos.decisions.completeExecution(decision.id, { kind: 'rejected', reason: 'cancelled_by_appeal' })
          return
        }
        if (decision.action.kind === 'pass') {
          await deps.repos.decisions.completeExecution(decision.id, { kind: 'applied', action: 'pass' })
          return
        }
        const instant = now()
        // 删除先通知后删：群内回退通知要回复被处置消息，消息必须还在。其余动作的通知仍在动作后发。
        const notice =
          decision.action.kind === 'delete'
            ? await sendNotice(deps, decision, decision.action, instant, schedule, context)
            : null

        const outcome = await applyAction(deps, decision, context)
        // 终结性拒绝时不发新通知：说「已删除」而实际没删是误导群成员，而且会给出一个指向不存在的处置的申诉入口。
        // 降级为删除时 outcome 带着实际生效的动作，文案随之改成「已删除」。
        if (outcome.kind === 'applied') {
          // 删除的通知已在动作前投递；降级为删除的禁言/封禁不在此列，它们按实际生效的动作在动作后通知。
          if (decision.action.kind !== 'delete') {
            const delivered = await sendNotice(deps, decision, outcome.action, instant, schedule, context)
            if (outcome.action.kind === 'warn' && delivered === null) {
              await deps.repos.decisions.completeExecution(decision.id, { kind: 'rejected', reason: 'warning_delivery_unconfirmed' })
              await notifyFailure(deps, decision, '警告送达未确认')
              return
            }
          }
        } else {
          // 删除没生效，撤回动作前发出的通知（best-effort），避免群里留下假消息与失效的申诉入口。
          if (notice !== null) await retractNotice(deps, decision, notice)
        }
        await deps.repos.decisions.completeExecution(decision.id, outcome.kind === 'applied'
          ? { kind: 'applied', action: outcome.action.kind }
          : { kind: 'rejected', reason: 'telegram_rejected' })
        if (outcome.kind === 'rejected') await notifyFailure(deps, decision, outcome.description)
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
   * 三个成功特例都源于「目标已经达成」：删除时消息已不存在（见 {@link isAlreadyGoneTarget}）；
   * 禁言/封禁时目标不可被限制（管理员/群主，见 {@link isUnpunishableTarget}）或目标已不在群里
   * （见 {@link isNonMemberTargetError}），降级为删除消息——消息本身仍可删除。
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
      // 目标已不在群里（从未加入或已离开）：封禁/禁言没有可施加的对象，Telegram 回「非参与者」类 400。
      // 与上一分支同路径降级为删除：非成员策略在目标离群后仍能生效的动作只有删除消息。
      if (isNonMemberTargetError(error) && (decision.action.kind === 'mute' || decision.action.kind === 'ban')) {
        logger.info(
          `目标不在群里，${decision.action.kind === 'mute' ? '禁言' : '封禁'}降级为删除 decisionId=${decision.id} chatId=${decision.chatId}`,
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
 * 默认定时器实现：延迟到点后执行一次任务。
 *
 * `unref` 让等待中的计时不阻止进程退出（与 `scheduler.ts` 的处理一致）；任务自身已有兜底，
 * 这里再吞一层 rejection，避免未处理拒绝把进程带崩。
 *
 * @param logger 日志。
 * @returns 可注入的调度函数。
 */
function createTimerSchedule(logger: Logger): Schedule {
  return (delayMs, task) => {
    const timer = setTimeout(() => {
      void task().catch((error: unknown) => {
        logger.warn(`定时任务执行失败（已忽略）delayMs=${delayMs}`, error)
      })
    }, delayMs)
    timer.unref?.()
  }
}

/**
 * 已投递通知的句柄。
 *
 * 删除动作被终结性拒绝时要用它撤回那条通知（见 {@link retractNotice}），因此必须带落点与消息 id；
 * `audience` 用于日志措辞与取舍说明（群内形态另有 TTL 定时删除兜底，私聊形态没有）。
 */
interface NoticeHandle {
  /** 通知落点：私聊为当事人 id（数字），群内回退为群 id（字符串）。 */
  chatId: string | number
  /** 通知消息 id。 */
  messageId: number
  /** 落点形态。 */
  audience: 'dm' | 'group'
}

/**
 * 发送处置通知：**先私聊当事人，不可达才回退群内**；返回已投递通知的句柄。
 *
 * 私聊优先的理由：处置结果直接递到当事人手里，群里不再出现一条匿名通知（完全静默）。
 * 私聊不可达（从未 /start、已拉黑 bot，或目标是 bot / 已注销账号）时回退群内通知：匿名文案 + 申诉按钮，
 * 并以「回复被处置消息」的形式落群（见 {@link sendGroupNotice}）；私聊通知不回复——跨聊天无法回复。
 *
 * 投递前先查通知引用（见 {@link findDeliveredNotice}）：引用已在说明这条通知已经发过。
 * 删除动作的通知在动作前发出，崩溃重跑与补偿重投递都会重放 `execute`，没有这道守卫就会重复发，
 * 因此命中时跳过投递，直接返回已有引用的句柄（终结性拒绝时照常可撤回）。
 *
 * 通知不做人为丢弃：密集时直接尝试发送，由 Telegram 的 429 退避兜底；其余失败（含退避耗尽）
 * 返回 null；执行器对 warn 记录送达未确认，其他动作仍保留实际执行结果。
 *
 * 发送成功后记录通知引用（`notice_*` 列），申诉生命周期据此编辑原通知；记录失败只 warn。
 *
 * @param deps 执行器依赖。
 * @param decision 决策（取群、用户与 decisionId）。
 * @param action 实际生效的动作；降级时它与决策上的原动作不同（见 {@link applyAction}）。
 * @param instant 当前时刻（渲染禁言剩余分钟数）。
 * @param schedule 延迟任务调度器（群内通知的定时删除用）。
 * @param context 执行上下文（群内通知回复被处置消息需要消息 id）。
 * @returns 已投递通知的句柄；跳过投递（引用已在）时返回已发通知的句柄；投递失败时为 `null`。
 */
async function sendNotice(
  deps: ActionExecutorDeps,
  decision: ModerationDecision,
  action: Action,
  instant: Date,
  schedule: Schedule,
  context: ExecutionContext,
): Promise<NoticeHandle | null> {
  const delivered = await findDeliveredNotice(deps, decision)
  if (delivered !== null) {
    // 群内通知的 TTL 只挂在进程内存里（见 GROUP_NOTICE_TTL_MS）：投递后、调度前崩溃，或重启后的
    // 补偿重试，都会让这条通知失去定时删除。命中群内句柄时重挂一次；重复删除无害（「已不在」按达成）。
    // 私聊通知没有 TTL，不安排。
    if (delivered.audience === 'group') {
      scheduleGroupNoticeDeletion(deps, decision.chatId, delivered.messageId, schedule)
    }
    deps.logger.info(`通知已投递过，跳过重复发送 decisionId=${decision.id} audience=${delivered.audience}`)
    return delivered
  }

  const dm = await sendDirectNotice(deps, decision, action, instant)
  if (dm.kind === 'sent') return dm.handle
  // 只有「私聊不可达」才回退群内；其余私聊失败按通知可丢处理，不发群内。
  if (dm.kind === 'failed') return null
  return await sendGroupNotice(deps, decision, action, instant, schedule, context)
}

/**
 * 查这条决策已经投递过的通知。
 *
 * 引用命中即「已经发过」：删除动作的通知在动作前投递，崩溃重跑与补偿重投递会重放 `execute`，
 * 守卫据此避免重复发送（否则引用还会被覆盖成最后一条，申诉编辑指向新消息）。命中时按落点重建句柄，
 * 调用方据此撤回（见 {@link retractNotice}）或重挂群内通知的 TTL（见 {@link sendNotice}）。
 *
 * 只认两种可识别的落点：`String(decision.chatId)` 是群内回退通知；`String(decision.userId)` 且为
 * 正整数形态是当事人私聊。其余落点（脏数据、串了决策）无法归属，按「没有有效引用」处理：
 * warn 后返回 `null`，既不用于撤回、也不重挂 TTL，后续照常投递（新落点覆盖这条引用）——
 * 不臆断落点去删一条陌生消息。
 *
 * 读取失败同样只 warn、按「尚未投递」处理：守卫是去重优化，读失败不该挡住动作执行；
 * 极端情况下重复发一条通知，且旧通知可能失去 TTL，与「通知可丢」的既有口径同量级。
 *
 * @param deps 执行器依赖。
 * @param decision 决策。
 * @returns 已有引用且落点可识别时返回对应句柄，否则 `null`。
 */
async function findDeliveredNotice(deps: ActionExecutorDeps, decision: ModerationDecision): Promise<NoticeHandle | null> {
  let ref: { chatId: string; messageId: number } | null
  try {
    ref = await deps.repos.decisions.findNoticeRef(decision.id)
  } catch (error) {
    deps.logger.warn(`通知引用读取失败，按尚未投递处理 decisionId=${decision.id}`, error)
    return null
  }
  if (ref === null) return null

  if (ref.chatId === String(decision.chatId)) {
    return { chatId: decision.chatId, messageId: ref.messageId, audience: 'group' }
  }
  if (ref.chatId === String(decision.userId) && DIRECT_CHAT_ID_PATTERN.test(ref.chatId)) {
    return { chatId: decision.userId, messageId: ref.messageId, audience: 'dm' }
  }
  deps.logger.warn(`通知引用落点无法识别，忽略该引用 decisionId=${decision.id} chatId=${ref.chatId}`)
  return null
}

/** 当事人私聊落点的形态：Telegram 用户 id 的字符串形态是正整数。 */
const DIRECT_CHAT_ID_PATTERN = /^[1-9]\d*$/u

/** 私聊投递结果：成功（带可撤回句柄）；回退群内（不可达）；失败（其余错误，通知可丢）。 */
type DirectNoticeOutcome = { kind: 'sent'; handle: NoticeHandle } | { kind: 'fallback' } | { kind: 'failed' }

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
    return { kind: 'sent', handle: { chatId: decision.userId, messageId: message.message_id, audience: 'dm' } }
  } catch (error) {
    if (isPrivateChatUnreachable(error)) {
      deps.logger.info(`当事人私聊不可达，回退群内通知 decisionId=${decision.id}`)
      return { kind: 'fallback' }
    }
    deps.logger.warn(`当事人私聊通知发送失败 decisionId=${decision.id}`, error)
    return { kind: 'failed' }
  }
}

/**
 * 群内通知（回退形态）：匿名文案 + 申诉按钮，并以「回复被处置消息」的形式发送。
 *
 * 回复对象是被处置的那条消息（`context.messageId`）：删除动作的通知在此之后才执行删除，
 * 所以消息还在；禁言/封禁降级为删除时消息可能已被降级删除，`allow_sending_without_reply`
 * 让通知照发、只是没有回复链接。
 *
 * 发送成功并记录引用后，安排一次 TTL 删除（见 {@link GROUP_NOTICE_TTL_MS}）：只有这条回退到
 * 群里的通知会被删，私聊通知与 owner feed 不动。删除不清理通知引用——申诉编辑
 * （`updateDecisionNotice`）本就是 best-effort，引用在而消息已删只会 warn 后跳过。
 *
 * @param deps 执行器依赖。
 * @param decision 决策。
 * @param action 实际生效的动作。
 * @param instant 当前时刻。
 * @param schedule 延迟任务调度器。
 * @param context 执行上下文（提供回复目标消息 id）。
 * @returns 已投递通知的句柄；发送失败时为 `null`（通知可丢，动作照常）。
 */
async function sendGroupNotice(
  deps: ActionExecutorDeps,
  decision: ModerationDecision,
  action: Action,
  instant: Date,
  schedule: Schedule,
  context: ExecutionContext,
): Promise<NoticeHandle | null> {
  const text = noticeText(action, instant, 'group')
  try {
    const message = await callWithRetry(
      () =>
        deps.api.sendMessage(decision.chatId, text, {
          reply_markup: appealKeyboard(deps.miniAppUrl, decision.id),
          reply_parameters: { message_id: context.messageId, allow_sending_without_reply: true },
        }),
      { logger: deps.logger, label: 'sendMessage(notice)' },
    )
    await recordNoticeRef(deps, decision, decision.chatId, message.message_id)
    scheduleGroupNoticeDeletion(deps, decision.chatId, message.message_id, schedule)
    return { chatId: decision.chatId, messageId: message.message_id, audience: 'group' }
  } catch (error) {
    deps.logger.warn(`处置通知发送失败 decisionId=${decision.id}`, error)
    return null
  }
}

/**
 * 撤回已投递的通知：删除动作被终结性拒绝时调用（见 `execute`）。
 *
 * 删除的通知在动作前发出，动作没生效时这条「已删除」就是假消息，附带一个指向无效处置的申诉入口，
 * 必须收回。**单次尝试、不重试**：撤回是旁路清理，失败只记日志，不影响 `executed` 回填与 owner 失败通知。
 * 「消息已不在」（见 {@link isMessageGoneError}）按达成处理：TTL 定时删除或人工已经删过。
 * 群内形态撤回失败时，那条通知仍会走既有的 5 分钟 TTL 删除兜底；私聊形态没有兜底，残留在当事人私聊里。
 *
 * @param deps 执行器依赖（取 api 与日志）。
 * @param decision 决策（日志用）。
 * @param notice 待撤回通知的句柄。
 */
async function retractNotice(deps: ActionExecutorDeps, decision: ModerationDecision, notice: NoticeHandle): Promise<void> {
  try {
    await deps.api.deleteMessage(notice.chatId, notice.messageId)
    deps.logger.info(
      `未生效处置的通知已撤回 decisionId=${decision.id} audience=${notice.audience} messageId=${notice.messageId}`,
    )
  } catch (error) {
    if (isMessageGoneError(error)) {
      deps.logger.info(
        `未生效处置的通知已不在，撤回视为达成 decisionId=${decision.id} audience=${notice.audience} messageId=${notice.messageId}`,
      )
      return
    }
    deps.logger.warn(
      `未生效处置的通知撤回失败 decisionId=${decision.id} audience=${notice.audience} messageId=${notice.messageId}`,
      error,
    )
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
 * 安排群内通知的定时删除：**单次尝试、不重试**，失败只记日志、不向上抛。
 *
 * - 「消息已不在」（见 {@link isMessageGoneError}）按达成处理：人工删过或同 id 已删过，记 info 即可；
 * - 其他错误记 warn：通知是可丢的旁路，删除失败不该影响任何主流程。
 *
 * @param deps 执行器依赖（取 api 与日志）。
 * @param chatId 群 id。
 * @param messageId 通知消息 id。
 * @param schedule 延迟任务调度器。
 */
function scheduleGroupNoticeDeletion(
  deps: ActionExecutorDeps,
  chatId: ChatId,
  messageId: number,
  schedule: Schedule,
): void {
  schedule(GROUP_NOTICE_TTL_MS, async () => {
    try {
      await deps.api.deleteMessage(chatId, messageId)
      deps.logger.info(`群内通知已按时删除 chatId=${chatId} messageId=${messageId}`)
    } catch (error) {
      if (isMessageGoneError(error)) {
        deps.logger.info(`群内通知已不在，删除视为达成 chatId=${chatId} messageId=${messageId}`)
        return
      }
      deps.logger.warn(`群内通知删除失败 chatId=${chatId} messageId=${messageId}`, error)
    }
  })
}

/**
 * 终结性拒绝或警告送达未确认后私聊 owner。
 *
 * 迟到的失败通知比不通知好：终态决策不再被补偿扫描接手，owner 可通过私聊或面板的持久结果发现待核实问题。
 * 通知是旁路：未配置时跳过，实现抛错时吞掉并记 warn，`executed` 回填不受影响。
 *
 * @param deps 执行器依赖。
 * @param decision 需要核实的决策。
 * @param description 拒绝原因或警告送达未确认的说明。
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
 * 判断 Telegram 的 400 拒绝是不是「目标消息已经不在了」。
 *
 * 只按错误判断、不看动作，是这条判定唯一的一份实现：executor 的删除动作（{@link isAlreadyGoneTarget}）
 * 在它之上叠加「仅 delete」的动作门控；owner feed 的「删除消息」按钮（`feed-actions.ts`）本就只做删除，
 * 直接复用。两处不各写一份正则，避免日后漂移。
 *
 * @param error 捕获到的异常。
 * @returns 是 GrammyError、`error_code` 为 400 且描述命中时为 `true`（此时 `error` 一定是 GrammyError）。
 */
export function isMessageGoneError(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 400 && TARGET_GONE_PATTERN.test(error.description)
}

/**
 * 判断删除动作是不是「消息本来就没了」。
 *
 * 分层：400 与描述的判定在 {@link isMessageGoneError}，这里只加动作门控——只有删除动作
 * 才谈得上「消息不在也算目标达成」。
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
  return action.kind === 'delete' && isMessageGoneError(error)
}
