import type { MessageFeatures } from '@skitarii/core'
import type { Message } from 'grammy/types'
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
