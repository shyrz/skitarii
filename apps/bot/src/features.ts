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
 * `mediaType` 是例外：它按消息自带的原始正文/caption 判定，不用传入的分析文本——
 * 无正文、只有按钮的消息分析文本非空，按分析文本判会把这类消息误标为 `text`。
 *
 * @param message grammY 的消息对象。
 * @param text 分析文本（正文/caption + 按钮文本，见 {@link composeAnalysisText}）；与 `contentHash` 的输入必须是同一份。
 * @returns 领域特征。`length` 按 Unicode 码点计（与用户观感一致），空文本为 0。
 */
export function extractFeatures(message: Message, text: string): MessageFeatures {
  return {
    hasLink: hasLink(message, text),
    mediaType: mediaTypeOf(message),
    length: Array.from(text).length,
    customEmojiCount: customEmojiCount(message),
    emojiCount: emojiCount(message, text),
    viaBot: message.via_bot !== undefined,
  }
}

/**
 * 内容哈希：分析文本的 sha256，作 LLM 缓存键与重复消息识别。
 *
 * @param text 分析文本（正文/caption + 按钮文本，见 {@link composeAnalysisText}）。
 * @returns 十六进制摘要。
 */
export function contentHashOf(text: string): string {
  return sha256Hex(text)
}

/**
 * 按钮文本行标记：每个按钮标签独占一行、以此开头。
 *
 * 为什么不用 `【按钮】` 之类的全角段标记：`normalize` 会把夹在汉字之间的标点整段删除，
 * 段标记会被拆词折叠整段吃掉，相邻正文与标签还会粘连；`(btn)` 是 ASCII 括号 + 拉丁字母，
 * 与两侧汉字组合时不属于「两侧都是方块字」的折叠条件，经归一化原样存活
 * （分隔换行折叠为空格，标记本身不丢），规则匹配与复核都看得见按钮来源。
 */
const BUTTON_LABEL_MARKER = '(btn)'

/** 进入分析文本的按钮上限。键盘可以塞很多行，取前 10 个足以覆盖广告载荷又不让文本无界膨胀。 */
const MAX_BUTTON_LABELS = 10

/** 单个按钮标签的截断长度（Unicode 码点）：与正文按码点计的口径一致。 */
const MAX_BUTTON_LABEL_CODE_POINTS = 64

/**
 * 组合审核分析文本：正文/caption 之后逐行追加内联键盘的按钮文本，每行以 `(btn)` 开头。
 *
 * 广告号常把联系方式、引流话术放进按钮（正文只留一句人话），只审正文会漏判；
 * 组合后的文本进入归一化、规则匹配、复核提示词、内容哈希、feed 与摘录。按钮文本不是正文，
 * 每行用 `(btn)` 前缀标出来源，便于人与模型区分。只取内联键盘（`inline_keyboard`），
 * 回复键盘、强制回复等形态是客户端 UI，不携带可审文本，原样返回 base。
 *
 * 提取口径：按行展平后 `trim`、跳过空串、最多取前 10 个，单个标签截断到 64 个 Unicode 码点
 * （按码点切，不拆散代理对）。没有按钮或有效标签为空时原样返回 base——不插入空标记行；
 * base 为空时不带前导换行，直接以首个 `(btn)` 行开头。
 *
 * @param message 消息对象。
 * @param baseText 正文或 caption；无文本时为 `''`。
 * @returns 分析文本。
 */
export function composeAnalysisText(message: Message, baseText: string): string {
  const replyMarkup = message.reply_markup
  if (replyMarkup === undefined || !('inline_keyboard' in replyMarkup)) return baseText

  const labels = replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.text.trim())
    .filter((label) => label.length > 0)
    .slice(0, MAX_BUTTON_LABELS)
    .map((label) => Array.from(label).slice(0, MAX_BUTTON_LABEL_CODE_POINTS).join(''))
  if (labels.length === 0) return baseText

  const markerLines = labels.map((label) => `${BUTTON_LABEL_MARKER}${label}`).join('\n')
  return baseText.length === 0 ? markerLines : `${baseText}\n${markerLines}`
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
 * @param text 分析文本（正文/caption + 按钮文本）。
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

/** `Extended_Pictographic` 属性（表情码位）。不带 `g`：每次 `test` 独立、无 `lastIndex` 状态。 */
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u

/**
 * 字素簇切分器（默认区域设置）。模块级复用：构造有一定开销，而 `segment` 每调用
 * 返回独立迭代器，无共享状态。字素簇即「用户感知的一个字符」。
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * 统计表情总数，按用户感知口径：每个表情恰计一次。
 *
 * 先按字素簇切分，统计包含 `\p{Extended_Pictographic}` 的簇数：ZWJ 序列（👨‍👩‍👧‍👦）、
 * 肤色修饰与变体选择符都属于同一簇，只计 1；`custom-emoji` 那种按码位逐一计数会把
 * 一个家庭表情算成四个人。
 *
 * Telegram 把自定义表情替换成正文里的占位符：占位符本身是表情（常见形态）时已被簇计数覆盖，
 * 不再重复计入；占位符不是表情（如字母、数字）时该自定义表情在簇计数里没有任何痕迹，
 * 按 `custom_emoji` 实体补计 1。因此 `emojiCount >= customEmojiCount` 恒成立。
 *
 * `text` 是调用方给出的分析文本（正文/caption + 按钮文本，与 `contentHash` 的输入同一份），
 * 本函数不读 `message.caption`；caption 上的实体从 `caption_entities` 取，与文本侧保持一致。
 *
 * @param message 消息对象。
 * @param text 分析文本（正文/caption + 按钮文本）。
 * @returns 表情总数。
 */
function emojiCount(message: Message, text: string): number {
  let count = 0
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (EXTENDED_PICTOGRAPHIC.test(segment)) count += 1
  }

  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])]
  return (
    count +
    entities.filter(
      (entity) =>
        entity.type === 'custom_emoji' &&
        !EXTENDED_PICTOGRAPHIC.test(text.slice(entity.offset, entity.offset + entity.length)),
    ).length
  )
}

/**
 * 判定媒体类型。带 caption 的图片仍算 `photo`：媒体类型描述的是消息形态，不是文本来源。
 *
 * 用消息自带的原始正文/caption（`message.text ?? message.caption`）而不是传入的分析文本：
 * 无正文、只有按钮的消息分析文本非空，按分析文本判会被误标为 `text`（形态其实是 `other`）。
 *
 * @param message 消息对象。
 * @returns 领域媒体类型。
 */
function mediaTypeOf(message: Message): MessageFeatures['mediaType'] {
  if (message.photo !== undefined) return 'photo'
  if (message.video !== undefined) return 'video'
  if (message.sticker !== undefined) return 'sticker'
  return (message.text ?? message.caption ?? '').length > 0 ? 'text' : 'other'
}
