import { TELEGRAM_ALLOWED_UPDATES, type Logger } from '@skitarii/bot'
import type { Api } from 'grammy'

/** 注册 webhook 用到的 Bot API 面。测试传替身即可，不必构造真 `Api`。 */
export type WebhookApi = Pick<Api, 'setWebhook'>

/**
 * 把 Telegram 的更新投递地址指向本服务的 `/telegram/webhook`。
 *
 * 幂等：Telegram 的 `setWebhook` 是替换语义（一个 bot 只保留一个地址），每次启动重新注册一遍即可，
 * 既不需要先查询当前状态，也不需要持久化注册记录。
 * 失败不抛错：注册依赖外部网络，失败时 Telegram 侧保留旧地址、进程照常启动（本地没公网地址就是这种情况），
 * 这里只记一条 warn，等下次重启或手工注册恢复。
 *
 * `allowed_updates` 取自 bot 包的同一份常量（长轮询入口也用它）：只订阅有处理器的更新类型，
 * 避免「手工注册一份、长轮询另一份」的漂移导致漏收 channel_post / my_chat_member。
 *
 * @param options.api Bot API 客户端，通常是 `bot.api`。
 * @param options.publicUrl 服务对外根地址，例如 `https://bot.example.com`；尾部斜杠会被去掉。
 * @param options.secretToken 提交给 Telegram 的 `secret_token`，须与 `webhookCallback` 校验的值一致。
 * @param options.logger 日志出口。
 */
export async function registerWebhook(options: {
  api: WebhookApi
  publicUrl: string
  secretToken: string
  logger: Logger
}): Promise<void> {
  const url = `${options.publicUrl.replace(/\/+$/, '')}/telegram/webhook`
  try {
    await options.api.setWebhook(url, {
      secret_token: options.secretToken,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    })
    options.logger.info(`已向 Telegram 注册 webhook：${url}`)
  } catch (error) {
    options.logger.warn(`webhook 注册失败，Telegram 侧仍指向旧地址，重启或手工注册可恢复：${url}`, error)
  }
}
