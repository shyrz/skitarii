import { type Action, type Appeal, type ModerationDecision, type UserId } from '@skitarii/core'
import type { Api, Context, MiddlewareFn } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import type { Repos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { callWithRetry } from './telegram-call.js'
import { GRANT_ALL_PERMISSIONS } from './permissions.js'
import { isUnpunishableTarget } from './telegram-errors.js'

/**
 * 申诉闭环：群内申诉入口、owner 私聊通知、owner 的「维持 / 撤销」回调。
 *
 * 链路：非放行处置发一条带申诉按钮的通知（先私聊当事人，不可达回退群内；按钮 URL 携带 decisionId）→
 * 用户在 Mini App 里提交申诉 → server 落库并调用 {@link notifyOwnerOfAppeal} 私聊 owner →
 * owner 点按钮或在面板里结案 → {@link resolveAppeal} 撤销（回滚权限）或维持。
 *
 * 通知生命周期：提交申诉与结案都会把原通知编辑成状态行并去掉按钮（见 {@link updateDecisionNotice}），
 * 结案时另外私聊当事人一条结果通知（编辑不触发提醒）。
 *
 * 撤销的回滚口径：`mute` 解禁、`ban` 解封，`delete` 与 `warn` 没有可回滚的权限状态
 * （消息已删除无法恢复），只把申诉状态改成 `overturned`，让误伤率统计与人工复盘能看到它。
 * 不可罚目标（管理员/群主）同样没有可回滚的状态：executor 会把这类目标的禁言/封禁降级为删除，
 * 回滚时的「不可被限制」拒绝按无可恢复处理，不阻断结案（见 {@link rollbackAction}）。
 * 结案与回滚是两步动作，中间崩溃会留下 `rollback_pending` 标记，
 * 由 {@link createAppealRollbackService} 在调度器里补跑。
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
        { text: '撤销并解除限制', callback_data: `appeal:${appealId}:overturn` },
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
 * 结案结果。回调处理器与 server 面板 API 共用：
 * 面板把它映射成 200 / 409 / 404，回调把它映射成 owner 能看懂的中文提示。
 *
 * `resolved` 带 `resolvedAt`：它就是写库的那次结案时刻，调用方（回调的私聊修订）渲染时间戳必须用它，
 * 不能各自再取一次当前时间，否则同一次结案会出现两个时刻。
 */
export type AppealResolution =
  | { kind: 'resolved'; rollbackFailed: boolean; resolvedAt: Date }
  | { kind: 'already_resolved' }
  | { kind: 'missing' }

/**
 * 结案一条申诉：先条件更新抢结案，`overturn` 时回滚权限状态。
 *
 * 这是申诉结案的唯一权威入口：Telegram 回调按钮与 Mini App 面板都走它，两条路径的
 * 权限回滚口径必须一致，不能各写一遍。
 *
 * 崩溃窗口的处理：`overturn` 的结案与回滚不是原子操作，两者之间进程崩溃会让用户停在受限状态。
 * 因此 claim 时在同一条 UPDATE 里写入「待回滚」标记，回滚成功后才清除；中间崩溃留下的标记
 * 由 {@link createAppealRollbackService} 在调度器里补跑（解禁/解封都是幂等动作）。
 *
 * 语义：
 * - 申诉不存在，或关联决策不存在 → `missing`（面板按 404 回答，回调按对应文案提示）。
 * - 申诉已不是 `open`，或条件更新没抢到（并发点击）→ `already_resolved`，不写状态、不回滚权限。
 * - `overturn` 的回滚失败不抛出：结案已经写库，把 `rollbackFailed=true` 交给调用方提示人工处理，
 *   同时记 error 日志并保留「待回滚」标记等扫描重试。不可罚目标（管理员/群主）没有可回滚的状态，
 *   按成功处理（见 {@link rollbackAction}）。
 *
 * @param deps api、仓储、owner 与日志；结案人固定为 owner。
 * @param appealId 申诉 id。
 * @param outcome `uphold` 维持原处置，`overturn` 撤销并回滚权限。
 * @returns 三态结案结果。
 */
export async function resolveAppeal(
  deps: AppealDeps,
  appealId: string,
  outcome: AppealOutcome,
): Promise<AppealResolution> {
  const appeal = await deps.repos.appeals.findById(appealId)
  if (appeal === null) return { kind: 'missing' }
  // 已结案时不再查决策：调用方按「已被处理」回答，不需要知道决策是否还在。
  if (appeal.state !== 'open') return { kind: 'already_resolved' }

  const decision = await deps.repos.decisions.findById(appeal.decisionId)
  if (decision === null) return { kind: 'missing' }

  const resolvedAt = new Date()
  // 先抢结案再动手：上面的读是快照，两条路径可能同时通过它。
  // 条件更新（只有 open 才影响到行）是权威判定，抢不到的那次不写状态、不回滚权限，也不报成功。
  // `overturn` 时同一条 UPDATE 写入待回滚标记：没有它，结案与回滚之间的崩溃会永远留在受限状态。
  const claimed = await deps.repos.appeals.resolve(
    appealId,
    outcome === 'overturn' ? 'overturned' : 'upheld',
    resolvedAt,
    deps.ownerUserId,
    outcome === 'overturn',
  )
  if (!claimed) return { kind: 'already_resolved' }

  let rollbackFailed = false
  if (outcome === 'overturn') {
    try {
      await rollbackAction(deps, decision)
    } catch (error) {
      // 结案已经写入，权限回滚失败：不能报「已恢复」。把可执行的处置方向交给调用方，
      // 否则用户会一直停在禁言/封禁状态而没人知道。待回滚标记保持置位，扫描会继续重试；
      // 结案通知照发（记录层已经撤销，文案不承诺恢复消息内容）。
      deps.logger.error(`申诉已结案但权限回滚失败 appealId=${appealId} decisionId=${decision.id}`, error)
      rollbackFailed = true
    }

    if (!rollbackFailed) {
      try {
        await deps.repos.appeals.clearRollbackPending(appealId)
      } catch (error) {
        // 清除失败不改变结案结论：标记留着最多让扫描再回滚一次（解禁/解封幂等）。
        deps.logger.warn(`回滚标记清除失败，待扫描兜底 appealId=${appealId}`, error)
      }
    }
  }

  // 通知生命周期与结案私聊都是旁路：best-effort，失败只 warn，不影响结案结论。
  await updateDecisionNotice(deps, decision.id, outcome === 'overturn' ? 'overturned' : 'upheld')
  await notifyAppellant(deps, decision, outcome, rollbackFailed)

  deps.logger.info(`申诉已结案 appealId=${appealId} outcome=${outcome} by=${deps.ownerUserId}`)
  return { kind: 'resolved', rollbackFailed, resolvedAt }
}

/** 通知编辑的阶段：提交申诉、撤销结案、维持结案。 */
export type AppealNoticeStage = 'received' | 'overturned' | 'upheld'

/**
 * 通知在各阶段的文案。
 *
 * 群内保持匿名口径（不提当事人），私聊用第二人称。
 *
 * @param stage 生命周期阶段。
 * @param audience `group` 群内通知；`dm` 当事人私聊通知。
 * @returns 直接作为消息正文的文案。
 */
export function noticeStageText(stage: AppealNoticeStage, audience: 'group' | 'dm'): string {
  switch (stage) {
    case 'received':
      return audience === 'dm' ? '⏳ 已收到你的申诉，等待复核' : '⏳ 已收到申诉，等待复核'
    case 'overturned':
      return audience === 'dm' ? '✅ 你的申诉已通过，处理已撤销' : '✅ 已撤销（复核为误判）'
    case 'upheld':
      return audience === 'dm' ? '🚫 你的申诉未通过，原处理维持' : '🚫 已维持原处置'
    default: {
      const exhaustive: never = stage
      throw new Error(`未知通知阶段: ${String(exhaustive)}`)
    }
  }
}

/**
 * 更新处置通知：整条替换成阶段文案，并移除申诉按钮。
 *
 * 为什么整条替换而不是追加：阶段文案本身就是通知的当前状态，原通知已经作为一次推送送达过；
 * 追加会让「等待复核」残留在终态消息里。
 *
 * 去按钮必须显式传空 `inline_keyboard`：Telegram 省略 `reply_markup` 不会清掉旧键盘。
 *
 * best-effort：引用缺失（通知没发出去、记录失败或旧数据）或编辑失败只 warn，不抛出，
 * 提交申诉与结案的主流程都不受它影响。受众由通知落点判断：私聊记录的是用户 id（正数），
 * 群/超级群 id 恒为负数。
 *
 * @param deps api、仓储与日志（与 `resolveAppeal` 同源）。
 * @param decisionId 决策 id。
 * @param stage 要切换到的阶段。
 */
export async function updateDecisionNotice(
  deps: Pick<AppealDeps, 'api' | 'repos' | 'logger'>,
  decisionId: string,
  stage: AppealNoticeStage,
): Promise<void> {
  try {
    const ref = await deps.repos.decisions.findNoticeRef(decisionId)
    if (ref === null) {
      deps.logger.warn(`决策没有通知引用，跳过通知编辑 decisionId=${decisionId}`)
      return
    }

    const audience = ref.chatId.startsWith('-') ? 'group' : 'dm'
    await deps.api.editMessageText(ref.chatId, ref.messageId, noticeStageText(stage, audience), {
      reply_markup: { inline_keyboard: [] },
    })
  } catch (error) {
    deps.logger.warn(`通知编辑失败，跳过 decisionId=${decisionId} stage=${stage}`, error)
  }
}

/**
 * 结案后私聊当事人（发新消息，不依赖通知引用）。
 *
 * 为什么单独发新消息：编辑不触发通知，当事人需要一条真正的提醒；即使 `rollbackFailed` 也照发
 * （记录层已撤销，权限由补偿扫描/owner 兜底），文案不承诺恢复已删除的消息内容。
 * 不可达或失败只 warn。
 *
 * @param deps api 与日志。
 * @param decision 原决策（取当事人 id 与实际动作）。
 * @param outcome 结案结果。
 * @param rollbackFailed 解除限制是否失败；只影响 mute/ban 的措辞（「解除中」而非「已解除」）。
 */
async function notifyAppellant(
  deps: AppealDeps,
  decision: ModerationDecision,
  outcome: AppealOutcome,
  rollbackFailed: boolean,
): Promise<void> {
  const text = appellantResultText(decision.action.kind, outcome, rollbackFailed)

  try {
    await callWithRetry(() => deps.api.sendMessage(decision.userId, text), {
      logger: deps.logger,
      label: 'sendMessage(appeal-result)',
    })
  } catch (error) {
    deps.logger.warn(`结案通知发送失败，当事人可能未与 bot 私聊 userId=${decision.userId}`, error)
  }
}

/**
 * 结案私聊的文案。纯函数，便于断言。
 *
 * 只对「限制类动作」承诺解除限制：mute/ban 撤销成功说「已解除」，回滚失败说「解除中」（补偿扫描会重试）；
 * warn/delete 没有权限状态可恢复，只说原处理已撤销，不承诺恢复已删除的消息内容。
 *
 * @param actionKind 原处置档位。
 * @param outcome 结案结果。
 * @param rollbackFailed 解除限制是否失败。
 * @returns 给当事人的一句话。
 */
export function appellantResultText(
  actionKind: Action['kind'],
  outcome: AppealOutcome,
  rollbackFailed: boolean,
): string {
  if (outcome === 'uphold') return '你的申诉未通过：原处理维持。'
  if (actionKind !== 'mute' && actionKind !== 'ban') return '你的申诉已通过：原处理已撤销。'

  return rollbackFailed ? '你的申诉已通过：原处理已撤销，限制解除中。' : '你的申诉已通过：原处理已撤销，限制已解除。'
}

/** 回滚补偿一轮最多处理的申诉数。没清掉标记的记录会一直留在候选集里，因此必须有上界。 */
export const APPEAL_ROLLBACK_SCAN_LIMIT = 20

/** 一轮回滚补偿的结果，用于日志与测试断言。 */
export interface AppealRollbackResult {
  /** 扫描到的候选数。 */
  scanned: number
  /** 清除标记的条数（回滚成功，或决策缺失被清掉）。 */
  cleared: number
  /** 回滚失败、留待下一轮的条数。 */
  failed: number
}

/** 权限回滚的补偿服务。 */
export interface AppealRollbackService {
  /** 扫一轮「已撤销但权限未回滚」的申诉并补跑回滚。 */
  runOnce(): Promise<AppealRollbackResult>
}

/**
 * 建立权限回滚的补偿服务。
 *
 * 为什么需要它：`resolveAppeal` 的撤销是先结案、后回滚的两步动作，中途崩溃（进程被杀、数据库抖动）
 * 会让申诉停在 `overturned + rollback_pending`，权限永远不恢复。这个扫描按标记找回它们。
 *
 * 幂等性：解禁（恢复全量权限）与解封（`only_if_banned`）都是可重复执行的动作，
 * 即使与在途的 `resolveAppeal` 撞车、或对同一标记重跑多轮，结果都收敛到同一个终态。
 * 决策缺失（外键级联下不应出现）时清标记并告警，避免永远重试。
 *
 * @param deps api、仓储、owner 与日志；`limit` 为单轮上限。`now` 与补发服务同形（调用方统一透传时间源），
 *   本服务不写任何时间戳，读它与不读它结果一致。
 * @returns 补偿服务。
 */
export function createAppealRollbackService(
  deps: AppealDeps & { limit?: number | undefined; now?: (() => Date) | undefined },
): AppealRollbackService {
  const limit = deps.limit ?? APPEAL_ROLLBACK_SCAN_LIMIT

  return {
    async runOnce(): Promise<AppealRollbackResult> {
      const pending = await deps.repos.appeals.listPendingRollback(limit)
      let cleared = 0
      let failed = 0

      for (const appeal of pending) {
        const decision = await deps.repos.decisions.findById(appeal.decisionId)
        if (decision === null) {
          // 申诉有外键级联（决策被删会连带删除申诉），正常路径不可达；清标记避免卡住队列。
          deps.logger.warn(`待回滚申诉缺少关联决策，清除标记 appealId=${appeal.id}`)
          await deps.repos.appeals.clearRollbackPending(appeal.id)
          cleared += 1
          continue
        }

        try {
          await rollbackAction(deps, decision)
        } catch (error) {
          deps.logger.warn(`权限回滚补偿失败，留待下一轮 appealId=${appeal.id} decisionId=${decision.id}`, error)
          failed += 1
          continue
        }

        await deps.repos.appeals.clearRollbackPending(appeal.id)
        cleared += 1
      }

      return { scanned: pending.length, cleared, failed }
    },
  }
}

/**
 * 建立 owner 回调处理器。挂在 `bot.callbackQuery(APPEAL_CALLBACK_PATTERN, handler)` 上。
 *
 * 权限：只有 `OWNER_USER_ID` 本人能处理，其他人点击得到一条弹出提示，不写库。
 * 幂等：结案是条件更新，只有抢到 `open → 终态` 的那次调用会回滚权限并回复「已处理」，
 * 重复点击（含并发点击）得到「这条申诉已被处理过」，不会翻转已结案的结论。
 * 结案语义全部走 {@link resolveAppeal}，本函数只负责把结果翻译成按钮交互。
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

    // 文案要区分「申诉不存在 / 决策不存在 / 已结案 / 并发抢不到」四种情况，而 resolveAppeal 只返回三态；
    // 先做两处只读判断把前两种文案保住，状态变更（条件更新与回滚）仍全部由 resolveAppeal 执行。
    const appeal = await deps.repos.appeals.findById(appealId)
    if (appeal === null) {
      await ctx.answerCallbackQuery({ text: '这条申诉不存在', show_alert: true })
      return
    }
    if (appeal.state !== 'open') {
      await ctx.answerCallbackQuery({ text: `这条申诉已经处理过（${describeAppealState(appeal.state)}）` })
      return
    }

    const resolution = await resolveAppeal(deps, appealId, outcome)
    if (resolution.kind === 'missing') {
      await ctx.answerCallbackQuery({ text: '关联的处置记录已不存在', show_alert: true })
      return
    }
    if (resolution.kind === 'already_resolved') {
      await ctx.answerCallbackQuery({ text: '这条申诉已被处理过' })
      return
    }

    if (resolution.rollbackFailed) {
      await editOwnerMessage(ctx, outcome, resolution.resolvedAt)
      await ctx.answerCallbackQuery({ text: '已结案，但解除限制失败：请手动解禁或解封', show_alert: true })
      return
    }

    await editOwnerMessage(ctx, outcome, resolution.resolvedAt)
    await ctx.answerCallbackQuery({ text: outcome === 'overturn' ? '已撤销并解除限制' : '已维持原处置' })
  }
}

/**
 * 回滚处置带来的权限状态。
 *
 * 不可罚目标（管理员/群主）没有可回滚的权限状态：executor 已把这类目标的禁言/封禁降级为删除，
 * 撤销时解禁/解封必然被 Telegram 以「不可被限制」拒绝。此时记日志后正常返回，不让申诉结案中途失败；
 * 其余错误照旧抛出，由调用方走「已结案但恢复失败」分支提示 owner 手动处理。
 *
 * @param deps api 与日志。
 * @param decision 原决策。
 */
async function rollbackAction(deps: AppealDeps, decision: ModerationDecision): Promise<void> {
  const call = deps.api
  switch (decision.action.kind) {
    case 'mute':
      try {
        await callWithRetry(
          () => call.restrictChatMember(decision.chatId, decision.userId, GRANT_ALL_PERMISSIONS),
          { logger: deps.logger, label: 'restrictChatMember(unmute)' },
        )
      } catch (error) {
        if (!isUnpunishableTarget(error)) throw error
        deps.logger.info(
          `目标不可被限制（管理员/群主），没有可恢复的权限状态，跳过解禁 decisionId=${decision.id} chatId=${decision.chatId}`,
        )
      }
      return
    case 'ban':
      try {
        await callWithRetry(() => call.unbanChatMember(decision.chatId, decision.userId, { only_if_banned: true }), {
          logger: deps.logger,
          label: 'unbanChatMember',
        })
      } catch (error) {
        if (!isUnpunishableTarget(error)) throw error
        deps.logger.info(
          `目标不可被限制（管理员/群主），没有可恢复的权限状态，跳过解封 decisionId=${decision.id} chatId=${decision.chatId}`,
        )
      }
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
