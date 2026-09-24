import type { Message, MessageEntity, User } from 'grammy/types'
import { describe, expect, test } from 'vitest'
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

/** 自定义表情实体。 */
function customEmoji(offset: number): MessageEntity {
  return { type: 'custom_emoji', offset, length: 1, custom_emoji_id: 'ce-1' }
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
