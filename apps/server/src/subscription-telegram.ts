import { GrammyError, type Api } from 'grammy'
import { TelegramSubscriptionError, type SubscriptionTelegramPort } from './subscriptions.js'

/**
 * grammY 适配层：把 Bot API 的订阅邀请链接方法与读取方法包成窄端口，并把失败分类成受控错误。
 *
 * 分类口径：
 * - 429 → `rate_limited`（带 retry_after；不打印 description）；
 * - 403 → `permission_denied`（明确未执行）；
 * - 其余 4xx → `telegram_rejected`（明确未执行，结果确定）；
 * - 5xx 与网络/未知异常 → `telegram_failed`（结果不确定）。
 *
 * 原始 `GrammyError` 的 description 可能回显链接或参数，因此这里只保留分类与错误码，
 * 不把 description 带出适配层，更没有日志调用。
 *
 * @param api grammY 的 `bot.api`。
 * @returns 订阅 Telegram 端口。
 */
export function createTelegramSubscriptionPort(api: Api): SubscriptionTelegramPort {
  return {
    async createChatSubscriptionInviteLink(input) {
      const link = await translate(() =>
        api.createChatSubscriptionInviteLink(input.chatId, input.periodSeconds, input.priceStars, {
          name: input.name,
        }),
      )
      return { inviteLink: link.invite_link, name: link.name ?? null, isRevoked: link.is_revoked }
    },

    async editChatSubscriptionInviteLink(input) {
      const link = await translate(() =>
        api.editChatSubscriptionInviteLink(input.chatId, input.inviteLink, { name: input.name }),
      )
      return { inviteLink: link.invite_link, name: link.name ?? null, isRevoked: link.is_revoked }
    },

    async revokeChatInviteLink(input) {
      const link = await translate(() => api.revokeChatInviteLink(input.chatId, input.inviteLink))
      return { inviteLink: link.invite_link, isRevoked: link.is_revoked }
    },

    async getChat(chatId) {
      return await translate(() => api.getChat(chatId))
    },

    async getChatMember(chatId, userId) {
      return await translate(() => api.getChatMember(chatId, userId))
    },  }
}

/**
 * 执行一次 Bot API 调用并归类失败。
 *
 * @param call 调用闭包。
 * @returns 调用结果。
 * @throws {TelegramSubscriptionError} 受控分类错误。
 */
async function translate<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof GrammyError) {
      if (error.error_code === 429) {
        throw new TelegramSubscriptionError({
          code: 'rate_limited',
          outcome: 'rate_limited',
          retryAfterSeconds: error.parameters.retry_after ?? null,
        })
      }
      if (error.error_code === 403) {
        throw new TelegramSubscriptionError({ code: 'permission_denied', outcome: 'rejected' })
      }
      if (error.error_code >= 500) {
        throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
      }
      throw new TelegramSubscriptionError({ code: 'telegram_rejected', outcome: 'rejected' })
    }
    // HttpError（网络失败）与其它未知异常：结果不确定。
    throw new TelegramSubscriptionError({ code: 'telegram_failed', outcome: 'unavailable' })
  }
}
