import { asChatId, matchRules } from '@skitarii/core'
import type { Message, MessageEntity, User } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import { defaultChatConfig } from './defaults.js'
import { extractFeatures, extractSenderIdentity } from './features.js'

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

    const flood = defaultChatConfig(asChatId('-1001234567890'), '测试群', 'zh').rules.filter(
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
