import { asChatId, matchRules, normalize } from '@skitarii/core'
import type { InlineKeyboardMarkup, Message, MessageEntity, User } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import { defaultChatConfig } from './defaults.js'
import { composeAnalysisText, extractFeatures, extractSenderIdentity } from './features.js'

/** 发送者构造器：只写与用例相关的字段，其余取固定默认值。 */
function userWith(overrides: Partial<User>): User {
  return { id: 7_000_000_001, is_bot: false, first_name: '小美', ...overrides }
}

/** 消息构造器：只写与用例相关的字段，其余取固定默认值。 */
function messageWith(overrides: Partial<Message>): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: 'group', title: '测试群' },
    ...overrides,
  }
}

/** 自定义表情实体。`length` 按 UTF-16 单元计（表情占位符为 2），默认单个字符。 */
function customEmoji(offset: number, length = 1): MessageEntity {
  return { type: 'custom_emoji', offset, length, custom_emoji_id: 'ce-1' }
}

/** 内联键盘构造器：每个参数是一行按钮的文本。按钮必须恰好带一种行为字段，统一给 `callback_data`。 */
function inlineKeyboard(...rows: string[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows.map((row) => row.map((text) => ({ text, callback_data: 'cb' }))) }
}

describe('发送者身份提取', () => {
  test('显示名与 @用户名用空格连接', () => {
    expect(extractSenderIdentity(userWith({ last_name: '张', username: 'official_usdt' }))).toBe('小美 张 @official_usdt')
  })

  test('无 username 时省略用户名段', () => {
    expect(extractSenderIdentity(userWith({ last_name: '张' }))).toBe('小美 张')
    expect(extractSenderIdentity(userWith({ first_name: '张三' }))).toBe('张三')
  })

  test('空段被过滤，全空时得到空身份', () => {
    expect(extractSenderIdentity(userWith({ last_name: '', username: '' }))).toBe('小美')
    expect(extractSenderIdentity(userWith({ first_name: '', last_name: '', username: '' }))).toBe('')
  })
})

describe('自定义表情计数', () => {
  test('统计 entities 与 caption_entities 中的 custom_emoji，其他实体不计', () => {
    const message = messageWith({
      entities: [customEmoji(0), { type: 'bold', offset: 4, length: 2 }, customEmoji(6)],
      caption_entities: [customEmoji(1)],
    })

    expect(extractFeatures(message, '🙂🙂🙂 你好 🙂').customEmojiCount).toBe(3)
  })

  test('没有 custom_emoji 实体时为 0', () => {
    const linkMessage = messageWith({ entities: [{ type: 'url', offset: 0, length: 6 }] })
    expect(extractFeatures(linkMessage, 't.me/x').customEmojiCount).toBe(0)
    expect(extractFeatures(messageWith({}), '你好').customEmojiCount).toBe(0)
  })
})

describe('表情总数计数', () => {
  test('ZWJ 家庭表情按用户感知计 1：两个家庭 = 2', () => {
    const message = messageWith({})

    // 每个家庭由四个分量加零宽连接符组成，字素簇切分后各算一个，不再按码位计成 4。
    expect(extractFeatures(message, '👨‍👩‍👧‍👦👨‍👩‍👧‍👦').emojiCount).toBe(2)
    // 变体选择符与肤色修饰属于同一簇，不另计。
    expect(extractFeatures(message, '❤️').emojiCount).toBe(1)
    expect(extractFeatures(message, '👍🏽').emojiCount).toBe(1)
    expect(extractFeatures(message, '这个键盘手感不错').emojiCount).toBe(0)
  })

  test('6 个自定义表情（表情占位符）计 6，占位符不重复加', () => {
    const text = '💰'.repeat(6)
    const message = messageWith({
      entities: [customEmoji(0, 2), customEmoji(2, 2), customEmoji(4, 2), customEmoji(6, 2), customEmoji(8, 2), customEmoji(10, 2)],
    })
    const features = extractFeatures(message, text)

    expect(features.customEmojiCount).toBe(6)
    // 占位符本身就是 💰：簇计数已覆盖，实体不再补计。
    expect(features.emojiCount).toBe(6)
  })

  test('3 个自定义表情计 3，不命中默认 flood 阈值 6', () => {
    const text = '💰'.repeat(3)
    const message = messageWith({ entities: [customEmoji(0, 2), customEmoji(2, 2), customEmoji(4, 2)] })
    const features = extractFeatures(message, text)

    expect(features.customEmojiCount).toBe(3)
    expect(features.emojiCount).toBe(3)

    const flood = defaultChatConfig(asChatId('-1001234567890'), '测试群', 'zh', 'supergroup').rules.filter(
      (rule) => rule.id === 'default-emoji-flood',
    )
    expect(flood).toHaveLength(1)
    expect(matchRules(text, features, flood, '')).toEqual([])
  })

  test('Unicode 与自定义混合：不重复计也不漏计', () => {
    // '💰💰🙂'：两个 💰 占位符有实体、🙂 是普通表情，簇计数 3，实体全部被覆盖。
    const message = messageWith({ entities: [customEmoji(0, 2), customEmoji(2, 2)] })
    expect(extractFeatures(message, '💰💰🙂').emojiCount).toBe(3)

    // 非表情占位符（字母）在簇里没有痕迹，靠实体补计：'a' 的自定义表情 + 🙂 = 2。
    const letterPlaceholder = messageWith({ entities: [customEmoji(0, 1)] })
    expect(extractFeatures(letterPlaceholder, 'a🙂').emojiCount).toBe(2)
  })

  test('caption 侧同样覆盖：caption_entities 与 caption 文本配对', () => {
    // caption 里 'a' 是非表情占位符的自定义表情（补计 1），'🎉' 是普通表情（簇计 1）。
    const message = messageWith({ caption: 'a🎉', caption_entities: [customEmoji(0, 1)] })
    const features = extractFeatures(message, 'a🎉')

    expect(features.customEmojiCount).toBe(1)
    expect(features.emojiCount).toBe(2)
  })

  test('emojiCount 恒不小于 customEmojiCount', () => {
    const cases: Array<[string, Message]> = [
      ['💰💰', messageWith({ entities: [customEmoji(0, 2), customEmoji(2, 2)] })],
      ['ab', messageWith({ entities: [customEmoji(0, 1), customEmoji(1, 1)] })],
      ['a🎉', messageWith({ entities: [customEmoji(0, 1)] })],
      ['👨‍👩‍👧‍👦 你好', messageWith({})],
      ['', messageWith({})],
      ['🎉🎉', messageWith({ caption_entities: [customEmoji(0, 2), customEmoji(2, 2)] })],
    ]

    for (const [text, message] of cases) {
      const features = extractFeatures(message, text)
      expect(features.emojiCount).toBeGreaterThanOrEqual(features.customEmojiCount)
    }
  })
})

describe('via-bot 特征', () => {
  test('via_bot 存在（经内联机器人发送）时为 true', () => {
    const message = messageWith({ via_bot: userWith({ id: 8_000_000_001, is_bot: true, first_name: 'Gif' }) })
    expect(extractFeatures(message, '你好').viaBot).toBe(true)
  })

  test('普通消息与机器人自己发的消息（无 via_bot）都为 false', () => {
    expect(extractFeatures(messageWith({}), '你好').viaBot).toBe(false)
    // `from` 是机器人不等于 via_bot：这走的是 bot 自己的消息，不是经内联机器人转发。
    expect(extractFeatures(messageWith({ from: userWith({ is_bot: true }) }), '你好').viaBot).toBe(false)
  })
})

describe('分析文本组合（按钮文本）', () => {
  test('无按钮时原样返回正文', () => {
    expect(composeAnalysisText(messageWith({}), '这个键盘手感不错')).toBe('这个键盘手感不错')
  })

  test('按钮标签 trim 后逐行以 (btn) 前缀拼接在正文之后', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['  加微信  ', '点我'], ['频道']) })
    expect(composeAnalysisText(message, '今天上新')).toBe('今天上新\n(btn)加微信\n(btn)点我\n(btn)频道')
  })

  test('空标签与纯空白标签被跳过，全空时原样返回', () => {
    const mixed = messageWith({ reply_markup: inlineKeyboard(['', '   ', '加微信']) })
    expect(composeAnalysisText(mixed, '正文')).toBe('正文\n(btn)加微信')

    const blank = messageWith({ reply_markup: inlineKeyboard(['', ''], [' ']) })
    expect(composeAnalysisText(blank, '正文')).toBe('正文')
  })

  test('无正文时直接以 (btn) 行开头，不带前导换行', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['加微信', '点我']) })
    expect(composeAnalysisText(message, '')).toBe('(btn)加微信\n(btn)点我')
  })

  test('空 inline_keyboard 视作无按钮', () => {
    const message = messageWith({ reply_markup: { inline_keyboard: [] } })
    expect(composeAnalysisText(message, '正文')).toBe('正文')
  })

  test('最多取前 10 个标签', () => {
    const labels = Array.from({ length: 12 }, (_, index) => `按钮${index + 1}`)
    const message = messageWith({ reply_markup: inlineKeyboard(labels) })
    const lines = composeAnalysisText(message, '正文').split('\n')

    expect(lines[0]).toBe('正文')
    expect(lines.slice(1)).toEqual(labels.slice(0, 10).map((label) => `(btn)${label}`))
  })

  test('单个标签截断到 64 个 Unicode 码点，不拆散代理对', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['😀'.repeat(70)]) })
    const label = composeAnalysisText(message, '正文').split('\n')[1] ?? ''

    // 前缀之外仍是完整表情：按码点截断，不是半个代理对拼出的替换字符。
    expect(label).toBe(`(btn)${'😀'.repeat(64)}`)
  })

  test('非内联键盘（回复键盘 / 强制回复）不受影响', () => {
    // Telegram 的 `Message.reply_markup` 类型只有内联键盘，这里模拟协议退化形态做防御性验证。
    const replyKeyboard = messageWith({
      reply_markup: { keyboard: [[{ text: '加微信' }]], resize_keyboard: true } as unknown as InlineKeyboardMarkup,
    })
    expect(composeAnalysisText(replyKeyboard, '今天上新')).toBe('今天上新')

    const forceReply = messageWith({ reply_markup: { force_reply: true } as unknown as InlineKeyboardMarkup })
    expect(composeAnalysisText(forceReply, '今天上新')).toBe('今天上新')
  })

  test('caption 消息同样组合', () => {
    // caption 与按钮共存是媒体广告的常见形态；调用方传入的 base 就是 caption。
    const message = messageWith({ caption: '看图', reply_markup: inlineKeyboard(['加微信']) })
    expect(composeAnalysisText(message, message.caption ?? '')).toBe('看图\n(btn)加微信')
  })

  test('无正文只有按钮：mediaType 仍按原始文本判为 other，不被分析文本带偏', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['加微信']) })
    const text = composeAnalysisText(message, message.text ?? message.caption ?? '')

    expect(text).toBe('(btn)加微信')
    // 分析文本非空，但消息形态没有正文/caption：不能被误判为 text。
    expect(extractFeatures(message, text).mediaType).toBe('other')
    // 对照：有正文的消息照常是 text。
    expect(extractFeatures(messageWith({ text: '正文' }), '正文').mediaType).toBe('text')
  })
})

/** 链路用例共用的 keyword 规则：命中「加微信」即 0.4 分。 */
const AD_RULE = {
  id: 'r-ad',
  kind: 'keyword' as const,
  pattern: '加微信',
  score: 0.4,
  actionHint: 'delete' as const,
  enabled: true,
}

describe('分析文本 × 归一化 × 规则匹配（链路）', () => {
  test('(btn) 标记经归一化原样存活，每行按钮文本仍可分辨', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['加微信', '点我', '领取']) })
    const normalized = normalize(composeAnalysisText(message, '正文'))

    expect(normalized).toBe('正文 (btn)加微信 (btn)点我 (btn)领取')
  })

  test('无正文只有按钮：归一化后以 (btn) 开头，标签照常命中 keyword 规则', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['加微信']) })
    const text = composeAnalysisText(message, '')

    expect(normalize(text)).toBe('(btn)加微信')
    expect(matchRules(normalize(text), extractFeatures(message, text), [AD_RULE], '')).toEqual([
      { kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 },
    ])
  })

  test('标签边界不被粘连：正文尾「加微」与标签头「信点我」不拼成「加微信」', () => {
    const message = messageWith({ reply_markup: inlineKeyboard(['信点我']) })
    const text = composeAnalysisText(message, '加微')
    const normalized = normalize(text)

    // 旧的全角段标记会被归一化拆掉，两个词拼成「加微信」；(btn) 阻断粘连，跨边界不构成 keyword。
    expect(normalized).toBe('加微 (btn)信点我')
    expect(normalized).not.toContain('加微信')
    expect(matchRules(normalized, extractFeatures(message, text), [AD_RULE], '')).toEqual([])
  })
})
