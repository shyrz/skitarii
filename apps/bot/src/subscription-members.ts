import { asChatId, asUserId, subscriptionSnapshotOf } from '@skitarii/core'
import type { MemberEventObservation, Repos } from '@skitarii/db'
import type { ChatMemberUpdated } from 'grammy/types'
import type { Logger } from './logger.js'

/**
 * 订阅成员事件记录（Phase 3b）。
 *
 * 只处理频道（`chat.type === 'channel'`）的 `chat_member` 更新：
 *
 * - 成员身份取 `new_chat_member.user.id`（不是 `from`，`from` 是操作人——可能是别的管理员）；
 * - 高频的成员状态变化不产生审核动作，也不调用任何权限处置接口；
 * - 无订阅证据的新免费成员**忽略**（不纳入台账）：证据只认「有效的 `until_date`」或
 *   「加入时的 invite_link 完整匹配本 Bot 新台账里的付费链接」；已有台账行继续跟踪退出/再加入/升管理员；
 * - 旧 subscriptions 表不算新台账的既有记录；
 * - 事件按 `(date, update_id)` 高水位条件写，乱序/重复事件不会覆盖较新事实；
 * - 日志只记 chatId/userId 与结果，不打印 invite_link。
 */

/** 事件记录器依赖。 */
export interface SubscriptionMemberRecorderDeps {
  repos: Repos
  logger: Logger
  now?: (() => Date) | undefined
}

/** 事件记录器。 */
export interface SubscriptionMemberRecorder {
  /**
   * 处理一条频道的 `chat_member` 更新。
   *
   * @param update 更新本体。
   * @param updateId 所在 Update 的 `update_id`（与事件时间共同构成高水位）。
   */
  handleChatMember(update: ChatMemberUpdated, updateId: number): Promise<void>
}

/**
 * 建立订阅成员事件记录器。
 *
 * @param deps 仓储、日志与时间源。
 * @returns 记录器。
 */
export function createSubscriptionMemberRecorder(deps: SubscriptionMemberRecorderDeps): SubscriptionMemberRecorder {
  const now = deps.now ?? (() => new Date())

  return {
    async handleChatMember(update, updateId): Promise<void> {
      const chat = update.chat
      // 只有频道有订阅链接；其他聊天的成员变化与本台账无关。
      if (chat.type !== 'channel') return

      const chatId = asChatId(String(chat.id))
      const userId = asUserId(update.new_chat_member.user.id)
      const newMember = update.new_chat_member
      const previousStatus = update.old_chat_member.status

      const snapshot = subscriptionSnapshotOf(newMember)
      const inviteLink = update.invite_link?.invite_link
      const matchedLink =
        inviteLink === undefined ? null : await deps.repos.subscriptionLinks.findByInviteLink(chatId, inviteLink)

      const existing = await deps.repos.subscriptionMembers.find(chatId, userId)
      // 无订阅证据的新成员忽略；已有台账行继续跟踪（即使这次没有付费证据）。
      if (existing === null && snapshot.expiresAt === null && matchedLink === null) {
        deps.logger.info(`忽略无订阅证据的新成员 chatId=${chatId} userId=${userId}`)
        return
      }

      // 明确的新一轮加入：旧状态是离开，或事件确实带加入链接。
      const isJoin = previousStatus === 'left' || previousStatus === 'kicked' || inviteLink !== undefined
      const evidence = snapshot.expiresAt !== null ? 'until_date' : matchedLink !== null ? 'owned_link' : null

      const observation: MemberEventObservation = {
        chatId,
        userId,
        state: snapshot.state,
        expiresAt: snapshot.expiresAt,
        evidence,
        // 明确的新一轮加入却无可匹配链接时置 null（不把旧来源当作本轮来源）。
        linkId: matchedLink?.id ?? null,
        isJoin,
        eventDate: update.date,
        eventUpdateId: updateId,
        observedAt: now(),
      }

      const outcome = await deps.repos.subscriptionMembers.applyEvent(observation)
      if (outcome !== 'ignored') {
        deps.logger.info(`订阅成员事件 ${outcome} chatId=${chatId} userId=${userId} state=${snapshot.state}`)
      }
    },
  }
}
