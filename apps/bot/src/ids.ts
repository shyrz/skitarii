import { createHash } from 'node:crypto'
import type { ChatId } from '@skitarii/core'

/**
 * 确定性标识符。
 *
 * 为什么不用 `crypto.randomUUID()`：Telegram 会重投递未及时确认的 update，同一 `(chatId, messageId)`
 * 可能两次进入管线。若事件 id 随机，就会写出两条事件、两条决策，动作也会施加两次。
 * 从 `(chatId, messageId)` 派生 id 后，落库的 `on conflict do nothing` 与执行侧的幂等键都自然成立。
 *
 * 派生值是合法 uuid（版本位置 5、变体位按 RFC 4122 置位），因此可以直接写进 `uuid` 列。
 */

/** sha256 十六进制摘要。用于 `content_hash`（原文）与确定性 id 的输入。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 由 `(chatId, messageId, discriminator?)` 派生事件 id。
 *
 * 同一条新消息永远得到同一个 id。编辑消息由管线传入判别符（`edit:<编辑时间>:<内容哈希前 16 位>`）：
 * 同一编辑的 Telegram 重投递得到同一 id（幂等），同秒内不同内容的编辑各自得到不同 id。
 * 判别符为 `null` / `undefined` 时哈希输入与不带判别符的历史实现完全一致，既有事件 id 不变。
 *
 * @param chatId 群标识（字符串形态的 Telegram chat id）。
 * @param messageId 消息 id。
 * @param discriminator 编辑等「同一条消息的多个版本」的判别符；新消息省略。
 * @returns uuid 形态的事件 id。
 */
export function deriveEventId(chatId: ChatId, messageId: number, discriminator?: string | null): string {
  const base = `message-event:${chatId}:${messageId}`
  const input = discriminator === undefined || discriminator === null ? base : `${base}:${discriminator}`
  return uuidFromHash(sha256Hex(input))
}

/**
 * 由事件 id 派生决策 id：一条事件对应一条决策，重放时不会产生第二条。
 *
 * @param eventId 事件 id。
 * @returns uuid 形态的决策 id。
 */
export function deriveDecisionId(eventId: string): string {
  return uuidFromHash(sha256Hex(`moderation-decision:${eventId}`))
}

/**
 * 把 sha256 摘要压成 uuid 形态。
 *
 * 校验位不是装饰：`uuid` 列会做格式校验，随手截断 32 位十六进制串是写不进去的。
 *
 * @param hash 十六进制摘要（至少 32 位）。
 * @returns 8-4-4-4-12 形态的 uuid。
 */
function uuidFromHash(hash: string): string {
  const version = `5${hash.slice(13, 16)}`
  const variantNibble = ((Number.parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  const variant = `${variantNibble}${hash.slice(17, 20)}`
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${version}-${variant}-${hash.slice(20, 32)}`
}
