import { asChatId, asUserId } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import type { Logger } from './logger.js'
import { createOwnerFeed, formatDecisionFeed } from './owner-feed.js'
import type { DecisionObservation } from './pipeline.js'
import { createRecordingApi } from './recording-api.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const ownerId = asUserId(1_000_000_001)
const decisionId = 'e5744f77-a4c0-507c-8306-00e89fa6858a'
const now = new Date('2026-09-23T10:00:00Z')

/** 用户定稿的完整样例。渲染与发送两处都按它逐字符断言。 */
const SAMPLE_FEED = [
  '📋 判定：删除（0.80）',
  '群组：测试群',
  '用户：123456789',
  '命中：default-ad-private、default-ad-sale',
  '复核：spam（0.92）',
  '决策：e5744f77-a4c0-507c-8306-00e89fa6858a',
  '链接：https://t.me/c/1692471411/42',
  '内容：低价出售各种账号 需要的私聊',
].join('\n')

/**
 * 构造判定数据。
 *
 * @param overrides 覆盖字段。
 * @returns 判定数据；缺省是超级群里的删除样例。
 */
function observation(overrides: Partial<DecisionObservation> = {}): DecisionObservation {
  return {
    chatId: asChatId('-1001692471411'),
    chatTitle: '测试群',
    messageId: 42,
    userId: asUserId(123456789),
    text: '低价出售各种账号 需要的私聊',
    signals: [
      { kind: 'rule-hit', ruleId: 'default-ad-private', score: 0.5 },
      { kind: 'rule-hit', ruleId: 'default-ad-sale', score: 0.3 },
      { kind: 'llm', verdict: 'spam', confidence: 0.92 },
    ],
    score: 0.8,
    action: { kind: 'delete' },
    decisionId,
    ...overrides,
  }
}

/**
 * 只取内容行，便于按字面值断言正文的折叠与截断。
 *
 * @param text 消息原文。
 * @returns 内容行。
 */
function contentLine(text: string): string {
  return formatDecisionFeed(observation({ text }), now).split('\n').at(-1) ?? ''
}

describe('判定 feed 渲染', () => {
  test('完整样例：逐字符渲染判定摘要', () => {
    expect(formatDecisionFeed(observation(), now)).toBe(SAMPLE_FEED)
  })

  test('放行、普通群、无命中无复核：命中行、复核行与链接行整行省略', () => {
    const text = formatDecisionFeed(
      observation({ chatId: asChatId('-123456789'), action: { kind: 'pass' }, score: 0, signals: [] }),
      now,
    )

    expect(text).toBe(
      [
        '📋 判定：放行（0.00）',
        '群组：测试群',
        '用户：123456789',
        `决策：${decisionId}`,
        '内容：低价出售各种账号 需要的私聊',
      ].join('\n'),
    )
  })

  test('仅有复核信号时补出复核行，规则命中按信号顺序连接', () => {
    const text = formatDecisionFeed(
      observation({
        signals: [
          { kind: 'llm', verdict: 'scam', confidence: 0.5 },
          { kind: 'rule-hit', ruleId: 'r-b', score: 0.2 },
          { kind: 'rule-hit', ruleId: 'r-a', score: 0.1 },
        ],
      }),
      now,
    )

    expect(text.split('\n')).toEqual([
      '📋 判定：删除（0.80）',
      '群组：测试群',
      '用户：123456789',
      '命中：r-b、r-a',
      '复核：scam（0.50）',
      `决策：${decisionId}`,
      '链接：https://t.me/c/1692471411/42',
      '内容：低价出售各种账号 需要的私聊',
    ])
  })

  test('禁言：分钟数按 until 与当前时刻计算，最少 1', () => {
    const thirtyMinutes = new Date(now.getTime() + 30 * 60_000)
    expect(formatDecisionFeed(observation({ action: { kind: 'mute', until: thirtyMinutes } }), now).split('\n')[0]).toBe(
      '📋 判定：禁言 30 分钟（0.80）',
    )

    const expired = new Date(now.getTime() - 5 * 60_000)
    expect(formatDecisionFeed(observation({ action: { kind: 'mute', until: expired } }), now).split('\n')[0]).toBe(
      '📋 判定：禁言 1 分钟（0.80）',
    )
  })

  test('内容折叠空白为单空格并 trim', () => {
    expect(contentLine('第一行\n\n\t第二行   结束 ')).toBe('内容：第一行 第二行 结束')
  })

  test('内容按 Unicode 码点截断到 100，超出补「…」', () => {
    expect(contentLine('字'.repeat(101))).toBe(`内容：${'字'.repeat(100)}…`)
    expect(contentLine('🙂'.repeat(101))).toBe(`内容：${'🙂'.repeat(100)}…`)
    expect(contentLine('字'.repeat(100))).toBe(`内容：${'字'.repeat(100)}`)
  })

  test('空文本与纯空白显示（无文本）', () => {
    expect(contentLine('')).toBe('内容：（无文本）')
    expect(contentLine(' \n\t ')).toBe('内容：（无文本）')
  })
})

describe('判定 feed 发送', () => {
  test('渲染后私聊 owner', async () => {
    const recording = createRecordingApi()
    const feed = createOwnerFeed({ api: recording.api, ownerUserId: ownerId, logger: silentLogger, now: () => now })

    await feed(observation())

    expect(recording.lastArgsOf('sendMessage')?.[0]).toBe(ownerId)
    expect(recording.lastArgsOf('sendMessage')?.[1]).toBe(SAMPLE_FEED)
  })

  test('发送失败只记 warn，永不抛出', async () => {
    const warnings: Array<{ message: string; error: unknown }> = []
    const logger: Logger = {
      info: () => {},
      warn: (message, error) => warnings.push({ message, error }),
      error: () => {},
    }
    const api = {
      async sendMessage(): Promise<never> {
        throw new Error('Bad Request: chat not found')
      },
    }
    const feed = createOwnerFeed({ api, ownerUserId: ownerId, logger, now: () => now })

    await expect(feed(observation())).resolves.toBeUndefined()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(`判定 feed 发送失败 ownerUserId=${ownerId} decisionId=${decisionId}`)
    expect(warnings[0]?.error).toBeInstanceOf(Error)
  })
})
