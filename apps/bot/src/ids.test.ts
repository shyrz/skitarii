import { describe, expect, test } from 'vitest'
import { deriveDecisionId, deriveEventId, sha256Hex } from './ids.js'
import { createTokenBucket } from './token-bucket.js'
import { asChatId } from '@skitarii/core'

describe('确定性 id', () => {
  test('同一群同一条消息派生出同一个 uuid，不同消息不同', () => {
    const first = deriveEventId(asChatId('-1001234567890'), 42)
    const second = deriveEventId(asChatId('-1001234567890'), 42)
    const other = deriveEventId(asChatId('-1001234567890'), 43)

    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })

  test('决策 id 由事件 id 派生，保持一对一', () => {
    const eventId = deriveEventId(asChatId('-1001234567890'), 42)

    expect(deriveDecisionId(eventId)).toBe(deriveDecisionId(eventId))
    expect(deriveDecisionId(eventId)).not.toBe(eventId)
  })

  test('编辑事件 id：同一编辑重投递同 id，不同编辑不同 id', () => {
    const chatId = asChatId('-1001234567890')

    expect(deriveEventId(chatId, 42, 'edit:1758627000')).toBe(deriveEventId(chatId, 42, 'edit:1758627000'))
    expect(deriveEventId(chatId, 42, 'edit:1758627000')).not.toBe(deriveEventId(chatId, 42, 'edit:1758627001'))
    expect(deriveEventId(chatId, 42, 'edit:1758627000')).not.toBe(deriveEventId(chatId, 42))
  })

  test('不带判别符的派生值与历史实现逐字节一致（既有事件 id 不变）', () => {
    // 回归样本取自引入判别符之前的实现：改动哈希输入会让既有事件的幂等键全部失效。
    expect(deriveEventId(asChatId('-1001234567890'), 42)).toBe('bf3a40d3-8798-5de5-b784-e76dab6e8a06')
    expect(deriveEventId(asChatId('-1001234567890'), 42, null)).toBe('bf3a40d3-8798-5de5-b784-e76dab6e8a06')
  })

  test('内容哈希是原文的 sha256（归一化不会改变缓存键的含义）', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('出站令牌桶', () => {
  test('容量用尽后拒绝发送，按时间补充后恢复', () => {
    let nowMs = 0
    const bucket = createTokenBucket({ capacity: 3, refillPerMinute: 20, now: () => nowMs })

    expect(bucket.tryTake('chat-1')).toBe(true)
    expect(bucket.tryTake('chat-1')).toBe(true)
    expect(bucket.tryTake('chat-1')).toBe(true)
    expect(bucket.tryTake('chat-1')).toBe(false)

    // 20 条/分钟 = 3 秒一条。
    nowMs += 3_000
    expect(bucket.tryTake('chat-1')).toBe(true)
    expect(bucket.tryTake('chat-1')).toBe(false)
  })

  test('每个群一个桶，互不消耗', () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerMinute: 20, now: () => 0 })

    expect(bucket.tryTake('chat-1')).toBe(true)
    expect(bucket.tryTake('chat-1')).toBe(false)
    expect(bucket.tryTake('chat-2')).toBe(true)
  })

  test('空闲不会把令牌堆过容量上限', () => {
    let nowMs = 0
    const bucket = createTokenBucket({ capacity: 2, refillPerMinute: 20, now: () => nowMs })

    nowMs += 600_000
    expect(bucket.tokensLeft('chat-1')).toBe(2)
  })
})
