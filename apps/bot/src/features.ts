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
 * 自定义表情的实体切片同样按原始文本（见 {@link emojiCount}）。
 *
 * @param message grammY 的消息对象。
 * @param text 分析文本（正文/caption、转发来源行与按钮文本，见 {@link composeAnalysisText}）；与 `contentHash` 的输入必须是同一份。
 * @returns 领域特征。`length` 按 Unicode 码点计（与用户观感一致），空文本为 0。
 */
export function extractFeatures(message: Message, text: string): MessageFeatures {
  // 实体 offset 只对消息自带的原始正文/caption 有意义：分析文本会把按钮行与来源行拼在正文之后，
  // 不再与实体坐标系对齐。两者都缺的消息没有可切片的原文（实体也不该存在），取空串。
  const originalText = message.text ?? message.caption ?? ''
  return {
    hasLink: hasLink(message, text),
    mediaType: mediaTypeOf(message),
    length: Array.from(text).length,
    customEmojiCount: customEmojiCount(message),
    emojiCount: emojiCount(message, text, originalText),
    viaBot: message.via_bot !== undefined,
  }
}

/**
 * 内容哈希：分析文本的 sha256，作 LLM 缓存键与重复消息识别。
 *
 * @param text 分析文本（正文/caption、转发来源行与按钮文本，见 {@link composeAnalysisText}）。
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

/** 来源行标记前缀：`(fwd)ch:`、`(fwd)grp:`、`(fwd)title:`、`(fwd)user:`、`(fwd)hidden:`、`(fwd)sig:`。 */
const FORWARD_ORIGIN_MARKER = '(fwd)'

/**
 * 组合审核分析文本：正文/caption 之后逐行追加按钮行，最后追加转发来源行。
 *
 * 广告号常把联系方式、引流话术放进按钮或转发来源名（频道标题、群名、原发送者名）里，
 * 正文只留一句人话，只审正文会漏判；组合后的文本进入归一化、规则匹配、复核提示词、
 * 内容哈希、feed 与摘录。顺序固定为：正文/caption → 按钮行 → 来源行（仅转发消息有）。
 *
 * 为什么来源行放在最后：摘录只取分析文本的前 280 个码点（`sample_text`）、owner feed 也只展示
 * 内容开头，正文必须占据开头，超长来源名不能挤掉正文预算；放末尾也顺带消掉了「来源值 + 正文」
 * 的粘连面——`normalize` 会把两侧汉字之间的纯空白分隔整段删除，来源在前时标题会和正文粘成一个词
 * （跨边界假命中，也污染来源值本身）。放在正文之后，每一段、每一行的起点都是自带 ASCII 标记的
 * 按钮/来源行，标记里的字母让分隔串原样存活，值与值之间不再粘连。
 *
 * 标记用 ASCII 括号 + 拉丁字母而不是 `【来源】` 一类全角段标记：全角标点夹在汉字之间会被
 * `normalize` 当拆词符整段删除，标记会被吃掉、相邻值还会粘连；`(fwd)` 与 `(btn)` 同理原样存活。
 *
 * 提取口径：来源值折叠空白再 `trim`，为空时不产生该行，不插入空标记行（与按钮行一致）；
 * 无来源的取值口径见 {@link forwardOriginLines}。按钮只取内联键盘（`inline_keyboard`），
 * 回复键盘、强制回复等形态是客户端 UI，不携带可审文本。无按钮且无来源时原样返回 base。
 *
 * @param message 消息对象。
 * @param baseText 正文或 caption；无文本时为 `''`。
 * @returns 分析文本。
 */
export function composeAnalysisText(message: Message, baseText: string): string {
  const blocks: string[] = []
  if (baseText.length > 0) blocks.push(baseText)

  const buttonLines = buttonLabelLines(message.reply_markup)
  if (buttonLines.length > 0) blocks.push(buttonLines.join('\n'))

  const originLines = forwardOriginLines(message.forward_origin)
  if (originLines.length > 0) blocks.push(originLines.join('\n'))

  return blocks.join('\n')
}

/**
 * 渲染转发来源行，按 `forward_origin` 的判别联合逐类取值：
 * - `channel`：有公开用户名时用户名与频道标题各成一行，无用户名时标题放进 `ch:` 行；
 *   有作者签名时追加一行 `(fwd)sig:`。
 * - `chat`：同上，用 `grp:`（匿名管理员以聊天身份发言的转发来源）。
 * - `user`：原名（`first_name`/`last_name` 空格连接），有 `@username` 时附上。
 * - `hidden_user`：`sender_user_name`（平台只给显示名/署名、不给账号，且不可验证）。
 *
 * @param origin 消息的转发来源；非转发消息为 `undefined`。
 * @returns 来源行；无来源或字段值为空时为空数组。
 */
function forwardOriginLines(origin: Message['forward_origin']): string[] {
  if (origin === undefined) return []

  switch (origin.type) {
    case 'channel':
      return [...chatSourceLines('ch', origin.chat), ...fieldLine('sig', origin.author_signature ?? '')]
    case 'chat':
      return chatSourceLines('grp', origin.sender_chat)
    case 'user':
      return fieldLine('user', renderUserName(origin.sender_user))
    case 'hidden_user':
      return fieldLine('hidden', origin.sender_user_name)
  }
}

/**
 * 频道/群组来源行：有公开用户名时用户名与标题各成一行，标题不再被用户名遮蔽。
 *
 * 只取用户名会把标题整个丢掉——载荷藏在频道标题里、用户名看起来正常时就会漏判；
 * 两个值也可能互相矛盾（改过名的频道），都送进分析文本由规则与模型自行权衡。无用户名时
 * 标题直接放进 `ch:`/`grp:` 行，保留「来源是什么」的一段描述；标题为空时不产生 `title:` 行。
 *
 * @param kind 来源类型标记：频道用 `ch`，群组用 `grp`。
 * @param chat 来源聊天（`username`/`title` 都可能缺失）。
 * @returns 来源行；两个值都为空时为空数组。
 */
function chatSourceLines(kind: 'ch' | 'grp', chat: { username?: string | undefined; title?: string | undefined }): string[] {
  const username = chat.username
  if (username === undefined || username.length === 0) return fieldLine(kind, chat.title ?? '')
  return [...fieldLine(kind, `@${username}`), ...fieldLine('title', chat.title ?? '')]
}

/**
 * 单个来源字段行：`(fwd)<字段>:<值>`。
 *
 * 值先折叠空白再 `trim`：来源名可能带 CR/LF（协议退化或构造的更新），原样拼接会伪造出新的
 * `(btn)`/`(fwd)` 行或 `【待复核消息】` 式段落边界；折叠后一个字段始终占一行。
 *
 * @param field 字段名（`ch`/`grp`/`title`/`user`/`hidden`/`sig`）。
 * @param value 字段值（用户名、标题、名字或签名）。
 * @returns 单元素数组；值折叠后为空时为空数组。
 */
function fieldLine(field: string, value: string): string[] {
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  return trimmed.length === 0 ? [] : [`${FORWARD_ORIGIN_MARKER}${field}:${trimmed}`]
}

/**
 * 展平内联键盘为逐行按钮行，每行以 `(btn)` 开头。
 *
 * 口径：按行展平后 `trim`、跳过空串、最多取前 10 个，单个标签截断到 64 个 Unicode 码点
 * （按码点切，不拆散代理对）。没有按钮或有效标签为空时返回空数组——不插入空标记行。
 *
 * @param replyMarkup 消息的 `reply_markup`。
 * @returns 按钮行；无内联键盘或有效标签时为空数组。
 */
function buttonLabelLines(replyMarkup: Message['reply_markup']): string[] {
  if (replyMarkup === undefined || !('inline_keyboard' in replyMarkup)) return []

  return replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.text.trim())
    .filter((label) => label.length > 0)
    .slice(0, MAX_BUTTON_LABELS)
    .map((label) => `${BUTTON_LABEL_MARKER}${Array.from(label).slice(0, MAX_BUTTON_LABEL_CODE_POINTS).join('')}`)
}

/**
 * 提取**当前发送者**的身份文本：`first_name`、`last_name`、`@username` 用空格连接，空段省略。
 *
 * 返回的是**未归一化**的原文，由管线调用 `normalize` 后再交给 `sender-name` 规则，
 * 与正文共享同一套归一化口径。当前发送者身份只存在于运行时：它不进 `MessageFeatures`、
 * 不落库，只有规则匹配与灰色地带的复核提示词会读到它。这里与转发来源复用同一渲染
 * （{@link renderUserName}）只为口径一致，两者的生命周期不同，见该函数。
 *
 * @param from 消息发送者。
 * @returns 身份文本；无 username 时只有显示名。
 */
export function extractSenderIdentity(from: User): string {
  return renderUserName(from)
}

/**
 * 渲染用户显示名：`first_name`、`last_name`、`@username` 用空格连接，空段省略。
 *
 * 两个调用方的生命周期刻意分开：
 * - 当前发送者 → {@link extractSenderIdentity}：只进规则匹配与复核提示词，**不落库**。
 * - 转发来源的原发送者 → `(fwd)user:` 行：渲染进分析文本，会随之进入内容哈希、复核提示词，
 *   并可能随非放行处置进入 `sample_text` 摘录。这一点是隐私口径的新增面，README 有说明。
 *
 * @param user 用户或转发来源里的原发送者。
 * @returns 显示名与 `@用户名`；无 username 时只有显示名。
 */
function renderUserName(user: User): string {
  const username = user.username === undefined || user.username.length === 0 ? '' : `@${user.username}`
  return [user.first_name, user.last_name ?? '', username].filter((part) => part.length > 0).join(' ')
}

/**
 * 判定是否含链接。
 *
 * @param message 消息对象。
 * @param text 分析文本（正文/caption、转发来源行与按钮文本）。
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
 * `text` 是调用方给出的分析文本（正文/caption、转发来源行与按钮文本，与 `contentHash` 的输入同一份），
 * 字素计数按它统计（按钮与来源名里的表情同样计入）。`originalText` 是与实体 offset 同坐标系的
 * 原始正文/caption：`custom_emoji` 实体的补计必须切它，不能切分析文本——分析文本在正文之后拼接了
 * 按钮行与来源行，按分析文本切片会错位（错位片段几乎总不是 pictographic，占位符本身是表情时
 * 会被误判成未覆盖、重复补计）。caption 上的实体从 `caption_entities` 取，与原始文本配对。
 *
 * @param message 消息对象。
 * @param text 分析文本（正文/caption、转发来源行与按钮文本）。
 * @param originalText 与实体 offset 同坐标系的原始正文/caption，见 {@link extractFeatures}。
 * @returns 表情总数。
 */
function emojiCount(message: Message, text: string, originalText: string): number {
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
        !EXTENDED_PICTOGRAPHIC.test(originalText.slice(entity.offset, entity.offset + entity.length)),
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
