import type { UserId } from '@skitarii/core'
import { GrammyError } from 'grammy'
import type { Api, Context, MiddlewareFn } from 'grammy'
import { isMessageGoneError } from './executor.js'
import type { Logger } from './logger.js'

/**
 * owner 判定 feed 的「删除消息」按钮回调。
 *
 * 发送侧在 `owner-feed.ts`：疑似违规（未被自动处置但带信号）的摘要在私聊里附这个按钮，
 * owner 点按后由本模块补删群里的原消息，并把摘要改成终态。
 *
 * 权限：只有 `OWNER_USER_ID` 本人能操作，其他人点按得到弹出提示、不做任何事。
 * 幂等：删除成功与「消息已不存在」都会把摘要改成终态（追加标记、清掉键盘）；
 * 重复点击不再叠加标记，但每次仍执行清键盘的编辑。
 * 消息是否「已经不在了」与 executor 共用 {@link isMessageGoneError}，两处不各写一份正则。
 */

/** 回调数据形状：`feeddel:<chatId>:<messageId>`；chatId 为群/超级群的负数 id，messageId 为正整数。 */
export const FEED_DELETE_CALLBACK_PATTERN = /^feeddel:(-?\d+):(\d+)$/u

/** 删除成功的终态标记。 */
const DELETED_MARKER = '✅ 已删除'

/** 「消息已不存在」的终态标记：目标已达成，按成功收尾。 */
const GONE_MARKER = '⚠️ 消息已不存在（可能已被删除）'

/** 终态标记集合：摘要里已出现任意一个，就说明这条消息已经收过尾。 */
const TERMINAL_MARKERS = [DELETED_MARKER, GONE_MARKER] as const

/** 错误描述截断上限（Unicode 码点）：Bot API 对 callback answer 文本的上限是 200 字符，留出安全余量。 */
const ERROR_TEXT_LIMIT = 180

/** 回调处理依赖。 */
export interface FeedDeleteDeps {
  /** Telegram api（只取 `deleteMessage`）。 */
  api: Pick<Api, 'deleteMessage'>
  /** 唯一可操作人：只有这个用户能点「删除消息」。 */
  ownerUserId: UserId
  logger: Logger
}

/**
 * 建立「删除消息」按钮的回调处理器。挂在 `bot.callbackQuery(FEED_DELETE_CALLBACK_PATTERN, handler)` 上。
 *
 * 点击流程：`deleteMessage(chatId, messageId)` →
 * 成功回「已删除」；Telegram 回「message not found / message to delete not found」时目标已达成，
 * 回「消息已不存在」；其他错误（权限不足、网络抖动等）弹出原因、保留键盘，owner 可重试。
 * 两条成功路径都会给摘要追加终态标记并清掉键盘，见 {@link settle}。
 *
 * 这里不做「删除前预检标记」来跳过删除：摘要正文是用户可控内容，可以伪造出标记文本，
 * 预检会让真正需要删除的消息被放过——安全优先，删除照常执行，收尾时才按标记判幂等。
 *
 * @param deps Telegram api、owner 与日志。
 * @returns grammY 中间件。
 */
export function createFeedDeleteCallbackHandler(deps: FeedDeleteDeps): MiddlewareFn<Context> {
  return async (ctx) => {
    const data = ctx.callbackQuery?.data
    const match = data === undefined ? null : FEED_DELETE_CALLBACK_PATTERN.exec(data)
    const chatId = match?.[1]
    const messageIdText = match?.[2]
    const from = ctx.from
    if (chatId === undefined || messageIdText === undefined || from === undefined) return

    if (from.id !== deps.ownerUserId) {
      await answerQuietly(ctx, deps, { text: '只有管理员可以操作', show_alert: true })
      return
    }

    const messageId = Number.parseInt(messageIdText, 10)
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      // 超出 Telegram 消息 id 的合法范围：回调数据被伪造或损坏，不能拿它去调删除。
      deps.logger.warn(`feed 删除回调的消息 id 非法 messageId=${messageIdText}`)
      return
    }

    try {
      await deps.api.deleteMessage(chatId, messageId)
    } catch (error) {
      if (isMessageGoneError(error)) {
        // 消息已经没了：删除的目标已经达成（人工删了、或上一次点击已经删过），按成功收尾。
        await settle(ctx, deps, GONE_MARKER, '消息已不存在')
        return
      }

      deps.logger.warn(`feed 删除消息失败 chatId=${chatId} messageId=${messageId}`, error)
      await answerQuietly(ctx, deps, { text: `删除失败：${describeError(error)}`, show_alert: true })
      return
    }

    await settle(ctx, deps, DELETED_MARKER, '已删除')
  }
}

/**
 * 回执并把摘要改成终态：追加标记、清掉键盘。
 *
 * 顺序固定：先回执再编辑，回执是 best-effort（见 {@link answerQuietly}），失败不能挡住摘要收尾。
 * 编辑始终带显式空键盘——与 `appeal.ts` 同口径，不依赖「省略 `reply_markup` 会移除键盘」的平台语义；
 * 同时沿用发送侧的 HTML 解析模式，否则摘要里的 `<a>` 标签会被当成纯文本显示。
 *
 * 幂等判定要求标记带 `\n\n` 前缀：摘要正文用户可以操控，正文里碰巧出现同样的文字不算收尾证据；
 * 任意终态标记已存在时只清键盘、不追加，避免重复点击叠加文案。
 *
 * @param ctx 回调上下文。
 * @param deps 依赖（日志）。
 * @param marker 本次分支的终态标记。
 * @param answer 回执文案。
 */
async function settle(ctx: Context, deps: FeedDeleteDeps, marker: string, answer: string): Promise<void> {
  await answerQuietly(ctx, deps, answer)

  const message = ctx.callbackQuery?.message
  if (message === undefined) {
    deps.logger.warn(`feed 摘要不可编辑：回调消息不存在 marker=${marker}`)
    return
  }
  const original = message.text
  if (original === undefined) {
    deps.logger.warn(`feed 摘要不可编辑：消息没有文本字段 marker=${marker}`)
    return
  }

  const marked = TERMINAL_MARKERS.some((terminal) => original.includes(`\n\n${terminal}`))
  const newText = marked ? original : `${original}\n\n${marker}`

  try {
    await ctx.editMessageText(newText, { reply_markup: { inline_keyboard: [] }, parse_mode: 'HTML' })
  } catch (error) {
    deps.logger.warn(`feed 摘要编辑失败，不影响删除回执 marker=${marker}`, error)
  }
}

/**
 * 回执 owner 的点按：失败只记 warn。
 *
 * 回执失败（回调过期、网络抖动）不该阻断删除结论的收尾——摘要编辑才是留给 owner 的持久化结果。
 *
 * @param ctx 回调上下文。
 * @param deps 依赖（日志）。
 * @param payload 回执文案或完整回执参数。
 */
async function answerQuietly(
  ctx: Context,
  deps: FeedDeleteDeps,
  payload: string | { text: string; show_alert?: boolean },
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(payload)
  } catch (error) {
    deps.logger.warn('feed 回调回执失败', error)
  }
}

/**
 * 把异常渲染成给 owner 看的一行字，并按码点截断到 {@link ERROR_TEXT_LIMIT}。
 *
 * Telegram 的拒绝原因取 `GrammyError.description`（与 executor 的失败通知同口径），
 * 网络类异常取 `Error.message`，其余兜底成字符串。截断是必要的：Bot API 对
 * `answerCallbackQuery.text` 的上限是 200 字符，超限会让整条回执发送失败。
 *
 * @param error 捕获到的异常。
 * @returns 一行描述，长度不超过 {@link ERROR_TEXT_LIMIT} 个码点。
 */
function describeError(error: unknown): string {
  const text =
    error instanceof GrammyError ? error.description : error instanceof Error ? error.message : String(error)
  const codePoints = Array.from(text)
  if (codePoints.length <= ERROR_TEXT_LIMIT) return text

  // 省略号占一个码点，截断结果保持在 ERROR_TEXT_LIMIT 以内。
  return `${codePoints.slice(0, ERROR_TEXT_LIMIT - 1).join('')}…`
}
