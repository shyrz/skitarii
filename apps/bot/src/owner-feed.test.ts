import { asChatId, asUserId, type ModerationDecision } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import type { Logger } from './logger.js'
import { createOwnerFailureNotifier, createOwnerFeed, formatDecisionFeed, formatFailureNotice } from './owner-feed.js'
import type { DecisionObservation } from './pipeline.js'
import { createRecordingApi } from './recording-api.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const ownerId = asUserId(1_000_000_001)
const decisionId = 'e5744f77-a4c0-507c-8306-00e89fa6858a'
const now = new Date('2026-09-23T10:00:00Z')

/** 用户定稿的完整样例（HTML 解析模式）。渲染与发送两处都按它逐字符断言。 */
const SAMPLE_FEED = [
  '📋 判定：删除（0.80）',
  '群组：测试群',
  '用户：<a href="tg://user?id=123456789">123456789</a>',
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
    commentThread: null,
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
        '用户：<a href="tg://user?id=123456789">123456789</a>',
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
      '用户：<a href="tg://user?id=123456789">123456789</a>',
      '命中：r-b、r-a',
      '复核：scam（0.50）',
      `决策：${decisionId}`,
      '链接：https://t.me/c/1692471411/42',
      '内容：低价出售各种账号 需要的私聊',
    ])
  })

  test('评论场景：优先渲染频道帖子深链，压过超级群的回退链接', () => {
    const text = formatDecisionFeed(
      observation({ commentThread: { channelUsername: 'chan_pub', postId: 77 } }),
      now,
    )

    expect(text.split('\n')).toContain('链接：https://t.me/chan_pub/77?comment=42')
    expect(text).not.toContain('t.me/c/')
  })

  test('普通群即使带 commentThread 也渲染评论深链', () => {
    // 评论场景必然发生在讨论组（超级群），这里断言的是分支优先级本身。
    const text = formatDecisionFeed(
      observation({
        chatId: asChatId('-123456789'),
        commentThread: { channelUsername: 'chan_pub', postId: 77 },
      }),
      now,
    )

    expect(text.split('\n')).toContain('链接：https://t.me/chan_pub/77?comment=42')
  })

  test('HTML 转义：群标题、规则 id 与正文里的标签与 & 原样可见', () => {
    const text = formatDecisionFeed(
      observation({
        chatTitle: '<b>测试</b> & 群',
        text: '<script>alert(1)</script> & "ok"',
        signals: [{ kind: 'rule-hit', ruleId: 'r<1>', score: 0.4 }],
      }),
      now,
    )

    expect(text.split('\n')).toEqual([
      '📋 判定：删除（0.80）',
      '群组：&lt;b&gt;测试&lt;/b&gt; &amp; 群',
      '用户：<a href="tg://user?id=123456789">123456789</a>',
      '命中：r&lt;1&gt;',
      `决策：${decisionId}`,
      '链接：https://t.me/c/1692471411/42',
      '内容：&lt;script&gt;alert(1)&lt;/script&gt; &amp; "ok"',
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
  test('渲染后私聊 owner（HTML 解析模式）', async () => {
    const recording = createRecordingApi()
    const feed = createOwnerFeed({ api: recording.api, ownerUserId: ownerId, logger: silentLogger, now: () => now })

    await feed(observation())

    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(ownerId)
    expect(args[1]).toBe(SAMPLE_FEED)
    expect(args[2]).toEqual({ parse_mode: 'HTML' })
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

/** 一条被终结性拒绝的决策，用于失败通知用例。 */
const rejectedDecision: ModerationDecision = {
  id: '9c8b7a65-1111-4222-8333-999900001111',
  eventId: '3f1d0c9a-1111-4222-8333-444455556666',
  chatId: asChatId('-1001234567890'),
  userId: asUserId(123456789),
  action: { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') },
  score: 0.9,
  signals: [],
  decidedAt: new Date('2026-09-23T10:00:00Z'),
  executed: false,
}

describe('处置失败通知', () => {
  test('渲染群、动作、决策 id 与拒绝原因，字段一律转义', () => {
    expect(formatFailureNotice(rejectedDecision, 'Bad Request: not enough rights <admin> & 权限不足')).toBe(
      [
        '⚠️ 处置失败：禁言',
        '群：-1001234567890',
        '决策：9c8b7a65-1111-4222-8333-999900001111',
        '原因：Bad Request: not enough rights &lt;admin&gt; &amp; 权限不足',
      ].join('\n'),
    )
  })

  test('私聊 owner，HTML 解析模式', async () => {
    const recording = createRecordingApi()
    const notifier = createOwnerFailureNotifier({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })

    await notifier(rejectedDecision, 'Bad Request: not enough rights')

    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(ownerId)
    expect(String(args[1])).toContain('⚠️ 处置失败：禁言')
    expect(String(args[1])).toContain('原因：Bad Request: not enough rights')
    expect(args[2]).toEqual({ parse_mode: 'HTML' })
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
    const notifier = createOwnerFailureNotifier({ api, ownerUserId: ownerId, logger })

    await expect(notifier(rejectedDecision, 'Bad Request: not enough rights')).resolves.toBeUndefined()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(`处置失败通知发送失败 ownerUserId=${ownerId} decisionId=${rejectedDecision.id}`)
    expect(warnings[0]?.error).toBeInstanceOf(Error)
  })
})
