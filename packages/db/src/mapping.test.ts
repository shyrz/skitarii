import { asChatId, asUserId, type Action, type Rule } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import {
  parseChatRules,
  toAction,
  toAppeal,
  toChatConfig,
  toDailyAggregate,
  toMessageEvent,
  toModerationDecision,
  toSubscription,
  truncateSampleText,
} from './mapping.js'
import { SAMPLE_TEXT_MAX_LENGTH, type AppealRow, type ChatRow, type DailyAggregateRow, type MessageEventRow, type ModerationDecisionRow, type SubscriptionRow } from './schema.js'

/** 一条合法规则，测试里按需覆写字段以构造坏数据。 */
const ruleFixture: Rule = {
  id: 'rule-1',
  kind: 'keyword',
  pattern: '广告',
  score: 0.4,
  actionHint: 'delete',
  enabled: true,
}

const chatRowFixture: ChatRow = {
  chatId: '-1001234567890',
  title: '测试群',
  language: 'zh',
  rules: [ruleFixture],
  passThreshold: 0.35,
  llmThreshold: 0.8,
  muteDurationMinutes: 60,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
}

const eventRowFixture: MessageEventRow = {
  id: '3f1d0c9a-1111-4222-8333-444455556666',
  chatId: '-1001234567890',
  userId: 7_000_000_001,
  messageId: 42,
  contentHash: 'a'.repeat(64),
  hasLink: true,
  mediaType: 'photo',
  length: 18,
  customEmojiCount: 3,
  emojiCount: 5,
  viaBot: true,
  sampleText: '低价出售会员，需要的私聊',
  createdAt: new Date('2026-09-23T10:00:00Z'),
}

const decisionRowFixture: ModerationDecisionRow = {
  id: '9c8b7a65-1111-4222-8333-999900001111',
  eventId: eventRowFixture.id,
  chatId: eventRowFixture.chatId,
  userId: eventRowFixture.userId,
  action: 'mute',
  actionUntil: new Date('2026-09-23T11:00:00Z'),
  score: 0.72,
  signals: [
    { kind: 'rule-hit', ruleId: 'rule-1', score: 0.4 },
    { kind: 'llm', verdict: 'spam', confidence: 0.8 },
  ],
  decidedAt: new Date('2026-09-23T10:00:01Z'),
  executed: true,
  noticeChatId: '-1001234567890',
  noticeMessageId: 77,
}

describe('JSONB 解析与行映射', () => {
  test('合规的规则集解析后逐字段保真', () => {
    expect(parseChatRules([ruleFixture])).toEqual([
      { id: 'rule-1', kind: 'keyword', pattern: '广告', score: 0.4, actionHint: 'delete', enabled: true },
    ])
  })

  test('未知的匹配方式被拒（不静默丢弃规则）', () => {
    expect(() => parseChatRules([{ ...ruleFixture, kind: 'fuzzy' }])).toThrow(ZodError)
  })

  test('sender-name 是合法的匹配方式（身份规则与正文规则共用一张表）', () => {
    expect(parseChatRules([{ ...ruleFixture, kind: 'sender-name', pattern: '客服|助手' }])).toEqual([
      { ...ruleFixture, kind: 'sender-name', pattern: '客服|助手' },
    ])
  })

  test('custom-emoji 是合法的匹配方式（pattern 为最小计数）', () => {
    expect(parseChatRules([{ ...ruleFixture, kind: 'custom-emoji', pattern: '6' }])).toEqual([
      { ...ruleFixture, kind: 'custom-emoji', pattern: '6' },
    ])
  })

  test('emoji-count 与 via-bot 是合法的匹配方式（via-bot 的 pattern 不使用）', () => {
    expect(
      parseChatRules([
        { ...ruleFixture, kind: 'emoji-count', pattern: '6' },
        { ...ruleFixture, kind: 'via-bot', pattern: '' },
      ]),
    ).toEqual([
      { ...ruleFixture, kind: 'emoji-count', pattern: '6' },
      { ...ruleFixture, kind: 'via-bot', pattern: '' },
    ])
  })

  test('分数越界的规则被拒（阈值口径不允许脏数据进入判定）', () => {
    expect(() => parseChatRules([{ ...ruleFixture, score: 1.5 }])).toThrow(ZodError)
  })

  test('群配置行映射成领域配置并保留全部字段', () => {
    const config = toChatConfig(chatRowFixture)
    expect(config).toEqual({
      chatId: '-1001234567890',
      title: '测试群',
      language: 'zh',
      rules: [ruleFixture],
      passThreshold: 0.35,
      llmThreshold: 0.8,
      muteDurationMinutes: 60,
    })
  })

  test('事件行映射出特征对象，且不带出正文摘录', () => {
    const event = toMessageEvent(eventRowFixture)
    expect(event.features).toEqual({ hasLink: true, mediaType: 'photo', length: 18, customEmojiCount: 3, emojiCount: 5, viaBot: true })
    expect(event.chatId).toBe(asChatId('-1001234567890'))
    expect(event.userId).toBe(asUserId(7_000_000_001))
    expect(Object.keys(event)).not.toContain('sampleText')
  })
})

describe('处置映射', () => {
  test('mute 带解禁时刻', () => {
    const action: Action = toAction('mute', new Date('2026-09-23T11:00:00Z'))
    expect(action).toEqual({ kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
  })

  test('mute 缺解禁时刻时抛错，不造半截禁言', () => {
    expect(() => toAction('mute', null)).toThrow('mute 决策缺少 action_until')
  })

  test('非 mute 档位忽略解禁时刻列', () => {
    expect(toAction('ban', null)).toEqual({ kind: 'ban' })
    expect(toAction('pass', null)).toEqual({ kind: 'pass' })
  })

  test('决策行映射出已解析的信号数组', () => {
    const decision = toModerationDecision(decisionRowFixture)
    expect(decision.action).toEqual({ kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    expect(decision.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'rule-1', score: 0.4 },
      { kind: 'llm', verdict: 'spam', confidence: 0.8 },
    ])
    expect(decision.executed).toBe(true)
  })

  test('信号里的未知结论被拒（复核结果不允许拼错还进库）', () => {
    expect(() =>
      toModerationDecision({ ...decisionRowFixture, signals: [{ kind: 'llm', verdict: '广告', confidence: 0.9 }] }),
    ).toThrow(ZodError)
  })
})

describe('申诉、订阅与聚合映射', () => {
  const appealRow: AppealRow = {
    id: 'a1b2c3d4-1111-4222-8333-555566667777',
    decisionId: decisionRowFixture.id,
    userId: decisionRowFixture.userId,
    state: 'overturned',
    note: '这是我自己的闲置转让',
    createdAt: new Date('2026-09-23T10:05:00Z'),
    resolvedAt: new Date('2026-09-23T10:30:00Z'),
    resolvedBy: 1_000_000_001,
    notifiedAt: new Date('2026-09-23T10:05:01Z'),
    rollbackPending: false,
  }

  test('申诉行映射成领域申诉，结案人列不进领域类型', () => {
    const appeal = toAppeal(appealRow)
    expect(appeal).toEqual({
      id: appealRow.id,
      decisionId: decisionRowFixture.id,
      userId: asUserId(decisionRowFixture.userId),
      state: 'overturned',
      note: '这是我自己的闲置转让',
      createdAt: new Date('2026-09-23T10:05:00Z'),
      resolvedAt: new Date('2026-09-23T10:30:00Z'),
    })
    expect(Object.keys(appeal)).not.toContain('resolvedBy')
  })

  test('订阅行映射保真', () => {
    const row: SubscriptionRow = {
      id: 'sub-1',
      chatId: chatRowFixture.chatId,
      userId: decisionRowFixture.userId,
      inviteLink: 'https://t.me/+abc',
      expiresAt: new Date('2026-10-23T00:00:00Z'),
      state: 'active',
      createdAt: new Date('2026-09-23T00:00:00Z'),
    }
    expect(toSubscription(row)).toEqual({
      chatId: asChatId(chatRowFixture.chatId),
      userId: asUserId(decisionRowFixture.userId),
      id: 'sub-1',
      inviteLink: 'https://t.me/+abc',
      expiresAt: new Date('2026-10-23T00:00:00Z'),
      state: 'active',
    })
  })

  test('日聚合行映射保真', () => {
    const row: DailyAggregateRow = {
      chatId: chatRowFixture.chatId,
      date: '2026-09-22',
      messageCount: 120,
      actionCount: 7,
      appealCount: 2,
      overturnedCount: 1,
    }
    expect(toDailyAggregate(row)).toEqual({
      chatId: asChatId(chatRowFixture.chatId),
      date: '2026-09-22',
      messageCount: 120,
      actionCount: 7,
      appealCount: 2,
      overturnedCount: 1,
    })
  })
})

describe('正文摘录截断', () => {
  test('短文本原样保留（去掉首尾空白）', () => {
    expect(truncateSampleText('  低价出售会员  ')).toBe('低价出售会员')
  })

  test('超长文本截到 280 个码点', () => {
    const truncated = truncateSampleText('a'.repeat(400))
    expect(truncated).toHaveLength(280)
    expect(truncated).toBe('a'.repeat(280))
  })

  test('按码点截断，不把表情符号切成半个代理对', () => {
    // 282 个码点，第 280 个是代理对。按 UTF-16 单元切会留下孤立高代理，读出来是乱码。
    const truncated = truncateSampleText('字'.repeat(279) + '😀' + '尾巴')
    expect(truncated).toBe('字'.repeat(279) + '😀')
  })

  test('滤掉 NUL 与控制字符（Postgres 的 text 列拒绝 NUL，写入会中断管线）', () => {
    expect(truncateSampleText('低价\u0000出售\u0007会员')).toBe('低价出售会员')
    // DEL 与 C1 区间同样清掉：它们在申诉页上只会显示成乱码。
    expect(truncateSampleText('a\u007fb\u009fc')).toBe('abc')
  })

  test('保留制表符与换行（正文排版的一部分）', () => {
    expect(truncateSampleText('第一行\n第二行\r\n\t缩进')).toBe('第一行\n第二行\r\n\t缩进')
  })

  test('全是控制字符时得到空摘录，而不是长度为 1 的脏字符', () => {
    expect(truncateSampleText('\u0000\u0001\u0002')).toBe('')
  })

  test('过滤后再按码点截断，长度上限不受影响', () => {
    const text = 'a\u0000'.repeat(400)
    expect(truncateSampleText(text)).toHaveLength(SAMPLE_TEXT_MAX_LENGTH)
  })
})
