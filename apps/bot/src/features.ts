import type { MessageFeatures } from '@skitarii/core'
import type { Message, User } from 'grammy/types'
import { sha256Hex } from './ids.js'

/**
 * 从 grammY 的消息对象提取审核特征。
 *
 * 特征的定义权在 `@skitarii/core`：审核、统计与缓存只依赖这几个可枚举的值与内容哈希，
 * 原文只在内存中出现（唯一例外是非放行处置后的摘录，见 `packages/db` 的 `attachSample`）。
 */

/** 视为链接的实体类型。`text_link` 是隐藏 URL 的锚文本，`url` 是明文 URL。 */
const LINK_ENTITY_TYPES: ReadonlySet<string> = new Set(['url', 'text_link'])

/**
 * 裸域名识别：至少两段、最后一段是不少于两个字母的标签（TLD）。
 *
 * 比只查 Telegram 实体更宽：`t.me/xxx`、`bit.ly/xxx` 这类不带协议头的写法不会被识别成 `url` 实体，
 * 但它们在垃圾消息里很常见。末段必须是字母，避免把「1.5 折」这类价格数字当成域名。
 */
const BARE_HOST = /(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}/u

/**
 * 提取消息特征。
 *
 * @param message grammY 的消息对象。
 * @param text 消息文本（正文或 caption）；与 `contentHash` 的输入必须是同一份。
 * @returns 领域特征。`length` 按 Unicode 码点计（与用户观感一致），空文本为 0。
 */
export function extractFeatures(message: Message, text: string): MessageFeatures {
  return {
    hasLink: hasLink(message, text),
    mediaType: mediaTypeOf(message, text),
    length: Array.from(text).length,
    customEmojiCount: customEmojiCount(message),
  }
}

/**
 * 内容哈希：原文的 sha256，作 LLM 缓存键与重复消息识别。
 *
 * @param text 消息原文（正文或 caption）。
 * @returns 十六进制摘要。
 */
export function contentHashOf(text: string): string {
  return sha256Hex(text)
}

/**
 * 提取发送者身份文本：`first_name`、`last_name`、`@username` 用空格连接，空段省略。
 *
 * 返回的是**未归一化**的原文，由管线调用 `normalize` 后再交给 `sender-name` 规则，
 * 与正文共享同一套归一化口径。身份只存在于运行时：它不进 `MessageFeatures`、不落库，
 * 只有规则匹配与灰色地带的复核提示词会读到它。
 *
 * @param from 消息发送者。
 * @returns 身份文本；无 username 时只有显示名。
 */
export function extractSenderIdentity(from: User): string {
  const username = from.username === undefined || from.username.length === 0 ? '' : `@${from.username}`
  return [from.first_name, from.last_name ?? '', username].filter((part) => part.length > 0).join(' ')
}

/**
 * 判定是否含链接。
 *
 * @param message 消息对象。
 * @param text 消息文本。
 * @returns 有 URL 实体或文本里出现裸域名时为 `true`。
 */
function hasLink(message: Message, text: string): boolean {
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])]
  if (entities.some((entity) => LINK_ENTITY_TYPES.has(entity.type))) return true
  return BARE_HOST.test(text)
}

/**
 * 统计自定义表情数量。
 *
 * `custom_emoji` 是 Telegram 的付费自定义表情（任何用户可买的合法功能），
 * 单独出现不说明什么；但广告号常用它们把消息堆成一条表情墙来抢视觉，来源工作流的实测阈值是 >5。
 * 与 `hasLink` 一样同时数正文与 caption 上的实体。
 *
 * @param message 消息对象。
 * @returns `entities` 与 `caption_entities` 中 `custom_emoji` 实体的总数。
 */
function customEmojiCount(message: Message): number {
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])]
  return entities.filter((entity) => entity.type === 'custom_emoji').length
}

/**
 * 判定媒体类型。带 caption 的图片仍算 `photo`：媒体类型描述的是消息形态，不是文本来源。
 *
 * @param message 消息对象。
 * @param text 消息文本。
 * @returns 领域媒体类型。
 */
function mediaTypeOf(message: Message, text: string): MessageFeatures['mediaType'] {
  if (message.photo !== undefined) return 'photo'
  if (message.video !== undefined) return 'video'
  if (message.sticker !== undefined) return 'sticker'
  return text.length > 0 ? 'text' : 'other'
}
