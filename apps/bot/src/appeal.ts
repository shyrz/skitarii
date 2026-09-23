import { asUserId, type Action, type Appeal, type ModerationDecision, type UserId } from '@skitarii/core'
import type { Api, Context, MiddlewareFn } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import type { Repos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { callWithRetry } from './telegram-call.js'
import { GRANT_ALL_PERMISSIONS } from './permissions.js'

/**
 * 申诉闭环：群内申诉入口、owner 私聊通知、owner 的「维持 / 撤销」回调。
 *
 * 链路：非放行处置在群里发一条带申诉按钮的通知（按钮 URL 携带 decisionId）→
 * 用户在 Mini App 里提交申诉 → server 落库并调用 {@link notifyOwnerOfAppeal} 私聊 owner →
 * owner 点按钮 → {@link createAppealCallbackHandler} 撤销（回滚权限）或维持。
 *
 * 撤销的回滚口径：`mute` 解禁、`ban` 解封，`delete` 与 `warn` 没有可回滚的权限状态
 * （消息已删除无法恢复），只把申诉状态改成 `overturned`，让误伤率统计与人工复盘能看到它。
 *
 * 通知的送达回执：`notifyOwnerOfAppeal` 返回 Telegram 是否接受，调用方据此回填
 * `appeals.notified_at`；没回填成功的申诉由 {@link createAppealNotificationService} 在调度器里补发。
 */

/** 回调数据的前缀与形状。`uphold` 维持原处置，`overturn` 撤销原处置。 */
export const APPEAL_CALLBACK_PATTERN = /^appeal:(?<appealId>[0-9a-f-]{36}):(?<outcome>uphold|overturn)$/u

/** 回调数据里的两个结果。 */
type AppealOutcome = 'uphold' | 'overturn'

/** owner 通知与回滚所需的依赖。 */
export interface AppealDeps {
  api: Api
  repos: Repos
  ownerUserId: UserId
  logger: Logger
}

/** 一条待通知的申诉。字段都已在调用方解析好，这里不再查库。 */
export interface AppealNotification {
  appealId: string
  userId: UserId
  reason: string
  chatTitle: string
  action: Action
  sampleText: string | null
  createdAt: Date
}

/**
 * 组装 Mini App 申诉链接。
 *
 * 格式由 Phase 1 契约固定：`${MINI_APP_URL}?startapp=${decisionId}`。
 * `MINI_APP_URL` 可以配置成 `https://t.me/<bot>/<app>` 这类 Mini App 直链：
 * Telegram 会在打开时注入 `initData`，并把 `startapp` 的值作为 `start_param` 交给页面。
 *
 * @param miniAppUrl Mini App 对外地址。
 * @param decisionId 决策 id。
 * @returns 可直接放进按钮的 URL。
 */
export function buildAppealUrl(miniAppUrl: string, decisionId: string): string {
  return `${miniAppUrl}?startapp=${decisionId}`
}

/**
 * 群内申诉按钮。用 `url` 而不是 `web_app`：`web_app` 按钮只在私聊里可用，
 * 而这条通知发在群里。
 *
 * @param miniAppUrl Mini App 对外地址。
 * @param decisionId 决策 id。
 * @returns inline 键盘。
 */
export function appealKeyboard(miniAppUrl: string, decisionId: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '提起申诉', url: buildAppealUrl(miniAppUrl, decisionId) }]] }
}

/**
 * owner 的「维持 / 撤销」按钮。
 *
 * @param appealId 申诉 id。
 * @returns inline 键盘。
 */
export function ownerDecisionKeyboard(appealId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '维持原处置', callback_data: `appeal:${appealId}:uphold` },
        { text: '撤销并恢复', callback_data: `appeal:${appealId}:overturn` },
      ],
    ],
  }
}

/**
 * 私聊通知 owner 有新的申诉待处理。
 *
 * 失败不抛出：申诉已经落库，丢一条通知不该让 Mini App 的提交接口失败。
 * 最常见的失败是 owner 从未与 bot 私聊过（Telegram 返回 403），日志里给出可执行的排查方向。
 * 返回 `false` 的申诉会留在 `appeals.notified_at is null` 的集合里，等调度器的补发扫描重试；
 * 因此调用方必须在拿到 `true` 之后才回填送达时刻。
 *
 * @param deps api、owner 与日志。
 * @param notification 申诉内容。
 * @returns Telegram 是否接受了这条私聊（`sendMessage` 未抛错即视为接受）。
 */
export async function notifyOwnerOfAppeal(deps: AppealDeps, notification: AppealNotification): Promise<boolean> {
  const text = [
    '🚨 新的申诉待处理',
    '',
    `群：${notification.chatTitle}`,
    `处置：${describeAction(notification.action, new Date())}`,
    `用户：${notification.userId}`,
    `摘录：${notification.sampleText ?? '（无摘录）'}`,
    `理由：${notification.reason}`,
    `提交时间：${notification.createdAt.toISOString()}`,
  ].join('\n')

  try {
    await callWithRetry(
      () =>
        deps.api.sendMessage(deps.ownerUserId, text, {
          reply_markup: ownerDecisionKeyboard(notification.appealId),
        }),
      { logger: deps.logger, label: 'sendMessage(owner)' },
    )
    return true
  } catch (error) {
    deps.logger.warn('通知 owner 失败：确认 owner 已与 bot 私聊过（/start）', error)
    return false
  }
}

/** 补发扫描一次最多处理的申诉数。未通知的申诉在人工处理前会一直留在候选集里，因此必须有上界。 */
export const APPEAL_NOTIFY_SCAN_LIMIT = 20

/** 一轮补发扫描的结果，用于日志与测试断言。 */
export interface AppealNotifyResult {
  /** 扫描到的候选数。 */
  scanned: number
  /** 补发成功（Telegram 接受）并回填了 `notified_at` 的条数。 */
  sent: number
  /** 补发失败、留待下一轮的条数（含关联决策已不存在、无法重建通知的条数）。 */
  failed: number
}

/** owner 通知的补发服务。 */
export interface AppealNotificationService {
  /** 扫一轮 `open && notified_at is null` 的申诉并补发通知。 */
  runOnce(): Promise<AppealNotifyResult>
}

/**
 * 建立 owner 通知的补发服务。
 *
 * 为什么需要它：`createAppeal` 里的通知失败后申诉仍是 `open`，而 Mini App 的重提交会被 409 挡住，
 * 于是这条申诉会静默地没人处理。补发扫描让「通知」这件事具备重试语义，代价是可能的重复私聊。
 *
 * 重复私聊为什么可接受：回填 `notified_at` 发生在 `sendMessage` 返回之后，两步之间进程崩溃或数据库
 * 抖动会留下「通知已发、回填未落」的记录，下一轮再发一次。重复的是同一条申诉提醒，owner 点第二个
 * 按钮也只会得到「已被处理过」，不会翻转结论；相比静默丢失，重复是更小的代价。
 *
 * @param deps api、仓储、owner 与日志；`limit` 为单轮上限。
 * @returns 补发服务。
 */
export function createAppealNotificationService(
  deps: AppealDeps & { limit?: number | undefined; now?: (() => Date) | undefined },
): AppealNotificationService {
  const limit = deps.limit ?? APPEAL_NOTIFY_SCAN_LIMIT
  const now = deps.now ?? (() => new Date())

  return {
    async runOnce(): Promise<AppealNotifyResult> {
      const pending = await deps.repos.appeals.listPendingNotification(limit)
      let sent = 0
      let failed = 0

      for (const appeal of pending) {
        const notification = await rebuildNotification(deps, appeal)
        if (notification === null) {
          // 关联决策已被保留期清理连带删除时才会走到这里（申诉有外键级联，正常不会出现）。
          deps.logger.warn(`申诉缺少关联决策，无法补发通知 appealId=${appeal.id}`)
          failed += 1
          continue
        }

        if (!(await notifyOwnerOfAppeal(deps, notification))) {
          failed += 1
          continue
        }

        await deps.repos.appeals.markNotified(appeal.id, now())
        sent += 1
      }

      return { scanned: pending.length, sent, failed }
    },
  }
}

/**
 * 从库里重建一条 owner 通知。
 *
 * 补发路径不能依赖「创建申诉时的上下文」：那时读到的群标题、摘录只存在内存里，
 * 而补发可能发生在进程重启之后，必须按申诉与决策的关联重新读一遍。
 *
 * @param deps api、仓储、owner 与日志。
 * @param appeal 待补发的申诉。
 * @returns 通知内容；关联决策不存在时为 `null`。
 */
async function rebuildNotification(deps: AppealDeps, appeal: Appeal): Promise<AppealNotification | null> {
  const decision = await deps.repos.decisions.findById(appeal.decisionId)
  if (decision === null) return null

  const [chat, event] = await Promise.all([
    deps.repos.chats.findByChatId(decision.chatId),
    deps.repos.events.findWithSample(decision.eventId),
  ])

  return {
    appealId: appeal.id,
    userId: appeal.userId,
    reason: appeal.note ?? '（未填写）',
    chatTitle: chat?.title ?? String(decision.chatId),
    action: decision.action,
    sampleText: event?.sampleText ?? null,
    createdAt: appeal.createdAt,
  }
}

/**
 * 建立 owner 回调处理器。挂在 `bot.callbackQuery(APPEAL_CALLBACK_PATTERN, handler)` 上。
 *
 * 权限：只有 `OWNER_USER_ID` 本人能处理，其他人点击得到一条弹出提示，不写库。
 * 幂等：结案是条件更新，只有抢到 `open → 终态` 的那次调用会回滚权限并回复「已处理」，
 * 重复点击（含并发点击）得到「这条申诉已被处理过」，不会翻转已结案的结论。
 *
 * @param deps api、仓储、owner 与日志。
 * @returns grammY 中间件。
 */
export function createAppealCallbackHandler(deps: AppealDeps): MiddlewareFn<Context> {
  return async (ctx) => {
    const data = ctx.callbackQuery?.data
    const match = data === undefined ? null : APPEAL_CALLBACK_PATTERN.exec(data)
    const appealId = match?.groups?.appealId
    const outcome = match?.groups?.outcome as AppealOutcome | undefined
    const from = ctx.from
    if (appealId === undefined || outcome === undefined || from === undefined) return

    if (from.id !== deps.ownerUserId) {
      await ctx.answerCallbackQuery({ text: '只有管理员可以处理申诉', show_alert: true })
      return
    }

    const appeal = await deps.repos.appeals.findById(appealId)
    if (appeal === null) {
      await ctx.answerCallbackQuery({ text: '这条申诉不存在', show_alert: true })
      return
    }
    if (appeal.state !== 'open') {
      await ctx.answerCallbackQuery({ text: `这条申诉已经处理过（${describeAppealState(appeal.state)}）` })
      return
    }

    const decision = await deps.repos.decisions.findById(appeal.decisionId)
    if (decision === null) {
      await ctx.answerCallbackQuery({ text: '关联的处置记录已不存在', show_alert: true })
      return
    }

    const resolvedAt = new Date()
    // 先抢结案再动手：上面的 `state !== 'open'` 读到的是快照，两次点击可能都通过它。
    // 条件更新（只有 open 才影响到行）是权威判定，抢不到的那次不写状态、不回滚权限，也不报成功。
    const claimed = await deps.repos.appeals.resolve(
      appealId,
      outcome === 'overturn' ? 'overturned' : 'upheld',
      resolvedAt,
      asUserId(from.id),
    )
    if (!claimed) {
      await ctx.answerCallbackQuery({ text: '这条申诉已被处理过' })
      return
    }

    if (outcome === 'overturn') {
      try {
        await rollbackAction(deps, decision)
      } catch (error) {
        // 结案已经写入，权限回滚失败：不能报「已恢复」。把可执行的处置方向交给 owner，
        // 否则用户会一直停在禁言/封禁状态而没人知道。
        deps.logger.error(`申诉已结案但权限回滚失败 appealId=${appealId} decisionId=${decision.id}`, error)
        await editOwnerMessage(ctx, outcome, resolvedAt)
        await ctx.answerCallbackQuery({ text: '已结案，但恢复权限失败：请手动解禁或解封', show_alert: true })
        return
      }
    }

    deps.logger.info(`申诉已结案 appealId=${appealId} outcome=${outcome} by=${from.id}`)
    await editOwnerMessage(ctx, outcome, resolvedAt)
    await ctx.answerCallbackQuery({ text: outcome === 'overturn' ? '已撤销并恢复权限' : '已维持原处置' })
  }
}

/**
 * 回滚处置带来的权限状态。
 *
 * @param deps api 与日志。
 * @param decision 原决策。
 */
async function rollbackAction(deps: AppealDeps, decision: ModerationDecision): Promise<void> {
  const call = deps.api
  switch (decision.action.kind) {
    case 'mute':
      await callWithRetry(
        () => call.restrictChatMember(decision.chatId, decision.userId, GRANT_ALL_PERMISSIONS),
        { logger: deps.logger, label: 'restrictChatMember(unmute)' },
      )
      return
    case 'ban':
      await callWithRetry(() => call.unbanChatMember(decision.chatId, decision.userId, { only_if_banned: true }), {
        logger: deps.logger,
        label: 'unbanChatMember',
      })
      return
    case 'pass':
    case 'warn':
    case 'delete':
      // 没有可回滚的权限状态：消息已删除或被警示过，撤销只体现在申诉状态与统计上。
      return
    default: {
      const exhaustive: never = decision.action
      throw new Error(`未知处置: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * 把 owner 私聊里的原通知改成「已处理」形态并去掉按钮。
 *
 * 编辑失败（消息过旧、内容未变）只记日志：结案已经写库，按钮残留不会造成错误状态，
 * 因为重复点击会被幂等检查挡住。
 *
 * @param ctx 回调上下文。
 * @param outcome 处理结果。
 * @param resolvedAt 结案时间。
 */
async function editOwnerMessage(ctx: Context, outcome: AppealOutcome, resolvedAt: Date): Promise<void> {
  const original = ctx.callbackQuery?.message?.text ?? ''
  const label = outcome === 'overturn' ? '✅ 已撤销（误判成立）' : '🚫 已维持原处置'
  try {
    await ctx.editMessageText(`${original}\n\n【处理结果】${label} ${resolvedAt.toISOString()}`)
  } catch {
    // 编辑失败不影响结案结果，忽略。
  }
}

/**
 * 把处置渲染成中文短语，供通知与日志使用。
 *
 * @param action 领域处置。
 * @param now 计算禁言剩余时间用的当前时刻；显式传入以保持函数可测。
 * @returns 中文描述，禁言带剩余分钟数。
 */
export function describeAction(action: Action, now: Date): string {
  switch (action.kind) {
    case 'pass':
      return '放行'
    case 'warn':
      return '警示'
    case 'delete':
      return '删除消息'
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
 * 申诉状态的中文描述。
 *
 * @param state 申诉状态。
 * @returns 中文短语。
 */
export function describeAppealState(state: Appeal['state']): string {
  switch (state) {
    case 'open':
      return '待处理'
    case 'upheld':
      return '维持原处置'
    case 'overturned':
      return '已撤销'
    default: {
      const exhaustive: never = state
      throw new Error(`未知申诉状态: ${String(exhaustive)}`)
    }
  }
}
