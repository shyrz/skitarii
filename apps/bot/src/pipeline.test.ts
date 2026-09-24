import { asChatId, asUserId, type ChatConfig } from '@skitarii/core'
import { createCachedJudge, LlmError, type CachedJudge, type JudgeInput, type JudgeResult } from '@skitarii/llm'
import { describe, expect, test, vi } from 'vitest'
import type { ActionExecutor } from './executor.js'
import { createActionExecutor } from './executor.js'
import { defaultChatConfig } from './defaults.js'
import { contentHashOf } from './features.js'
import { deriveDecisionId, deriveEventId } from './ids.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { handleIncomingMessage, type CommentThread, type DecisionObservation } from './pipeline.js'
import { createRecordingApi, type RecordingApi } from './recording-api.js'
import { createTokenBucket } from './token-bucket.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)
const fixedNow = () => new Date('2026-09-23T10:00:00Z')

/** 判定用的群配置：一条中等分规则（灰色地带）、一条较高分规则（叠加后直接处置）。 */
const chatConfig: ChatConfig = {
  chatId,
  title: '测试群',
  language: 'zh',
  // pattern 必须是归一化后的形态：原文「加v」经 normalize 会变成「加微信」。
  rules: [
    { id: 'r-ad', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true },
    { id: 'r-rebate', kind: 'keyword', pattern: '刷单', score: 0.5, actionHint: 'mute', enabled: true },
  ],
  passThreshold: 0.3,
  llmThreshold: 0.8,
  muteDurationMinutes: 60,
}

interface JudgeStub {
  calls: JudgeInput[]
  judge: { judge(input: JudgeInput): Promise<JudgeResult> }
}

/**
 * 构造复核替身。
 *
 * @param outcome 每次调用返回的结论，或抛出的错误。
 * @returns 记录入参的替身。
 */
function createJudgeStub(outcome: JudgeResult | Error): JudgeStub {
  const calls: JudgeInput[] = []
  return {
    calls,
    judge: {
      async judge(input: JudgeInput): Promise<JudgeResult> {
        calls.push(input)
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    },
  }
}

/**
 * 组装管线与其依赖。
 *
 * @param options 复核结果与是否启用缓存包装。
 * @returns 管线依赖与观察口。
 */
function setup(options: { judge?: JudgeStub; cacheJudge?: boolean } = {}) {
  const recording: RecordingApi = createRecordingApi()
  const store: InMemoryRepos = createInMemoryRepos()
  const judgeStub = options.judge ?? createJudgeStub({ verdict: 'spam', confidence: 0.9, model: 'stub', rationale: null })

  const judge: CachedJudge | null =
    options.cacheJudge === true
      ? createCachedJudge({ judge: judgeStub.judge, cache: store.repos.llmCache })
      : async (contentHash, input) => {
          void contentHash
          return judgeStub.judge.judge(input)
        }

  const executor: ActionExecutor = createActionExecutor({
    api: recording.api,
    repos: store.repos,
    idempotency: createIdempotencyRegistry(),
    outbound: createTokenBucket(),
    miniAppUrl: 'https://mini.example.com/app',
    logger: silentLogger,
    now: fixedNow,
    sleep: async () => {},
  })

  return { store, recording, judgeStub, executor, judge }
}

describe('消息管线', () => {
  test('低分消息直接放行：不查前科、不调复核、不碰 Telegram，也不留摘录', async () => {
    const { store, recording, judgeStub } = setup()
    await store.repos.chats.upsert(chatConfig)

    await withPipeline({ store, recording }, null, async (deps) => {
      await deps({ text: '这个键盘手感不错', messageId: 100 })
    })

    const eventId = deriveEventId(chatId, 100)
    const decision = await store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision).toMatchObject({ action: { kind: 'pass' }, score: 0, executed: true })
    expect(decision?.signals).toEqual([])
    expect(judgeStub.calls).toEqual([])
    expect(recording.calls).toEqual([])
    expect(store.sampleOf(eventId)).toBeNull()
  })

  test('灰色地带复核判违规：按主导规则处置、留摘录、发带申诉按钮的通知', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 101 }),
    )

    const eventId = deriveEventId(chatId, 101)
    const decision = await store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(judgeStub.calls).toHaveLength(1)
    // 送审的是归一化文本：规则命中与复核必须看同一份文本。
    expect(judgeStub.calls[0]?.text).toBe('加微信推荐一个渠道')
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 },
      { kind: 'llm', verdict: 'spam', confidence: 0.9 },
    ])
    // 0.4 + 0.9 越过 llmThreshold，落到主导规则的 actionHint。
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(decision?.executed).toBe(true)
    expect(store.sampleOf(eventId)).toBe('加v推荐一个渠道')
    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(1)
  })

  test('复核失败退化为待复核的 warn，且不因前科加重', async () => {
    const { store, executor, judge } = setup({
      judge: createJudgeStub(new LlmError('timeout', '复核请求超时：30000ms')),
    })
    await store.repos.chats.upsert(chatConfig)
    // 三条历史违规，正常情况下足以让 delete 加重成 mute。
    await seedPriorViolations(store, 3)

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 102 }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 102)))
    expect(decision?.action).toEqual({ kind: 'warn' })
    expect(decision?.signals).toEqual([{ kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 }])
    expect(store.sampleOf(deriveEventId(chatId, 102))).toBe('加v推荐一个渠道')
  })

  test('直接处置带不消耗复核调用', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)

    await withFrozenClock(async () => {
      await handleIncomingMessage(
        { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
        incoming({ text: '加v刷单日结', messageId: 103 }),
      )
    })

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 103)))
    expect(judgeStub.calls).toEqual([])
    // 两条命中累计 0.9，主导规则是分更高的 r-rebate（mute）；解禁时刻由 decide 读挂钟算出。
    expect(decision?.action).toEqual({ kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
  })

  test('累犯加重：三条前科把灰色地带的 delete 升为 mute', async () => {
    const { store, executor, judge } = setup({
      judge: createJudgeStub({ verdict: 'spam', confidence: 0.3, model: 'stub', rationale: null }),
    })
    await store.repos.chats.upsert(chatConfig)
    await seedPriorViolations(store, 3)

    await withFrozenClock(async () => {
      await handleIncomingMessage(
        { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
        incoming({ text: '加v推荐一个渠道', messageId: 104 }),
      )
    })

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 104)))
    // 0.4 + 0.3 = 0.7 仍在灰色地带，复核确认违规 → actionHint delete 加重一档为 mute。
    expect(decision?.action).toEqual({ kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
  })

  test('重投递同一条消息：事件与决策都不重复，动作只施加一次', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const deps = { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow }

    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 105 }))
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 105 }))

    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(1)
    const eventId = deriveEventId(chatId, 105)
    expect(store.sampleOf(eventId)).toBe('加v推荐一个渠道')
  })

  test('相同内容在另一个群、规则信号也相同：命中复核缓存，不再调用模型', async () => {
    const { store, judgeStub, executor, judge } = setup({ cacheJudge: true })
    await store.repos.chats.upsert(chatConfig)
    // 指纹覆盖语言与规则信号：只有两群的配置一致（命中同一条规则、同分、同语言）时才应命中缓存。
    await store.repos.chats.upsert({ ...chatConfig, chatId: asChatId('-1009999999999') })

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 106 }),
    )
    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 107, chatId: asChatId('-1009999999999') }),
    )

    expect(judgeStub.calls).toHaveLength(1)
  })

  test('相同内容但另一群的规则不同：信号进入指纹，缓存不复用（两次都调模型）', async () => {
    const { store, judgeStub, executor, judge } = setup({ cacheJudge: true })
    await store.repos.chats.upsert(chatConfig)
    // 第二个群用默认规则：同一条正文命中的 ruleId 与分数不同，送审材料不同，不该复用结论。
    await store.repos.chats.upsert(defaultChatConfig(asChatId('-1009999999999'), '另一个群', 'zh'))

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 106 }),
    )
    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 107, chatId: asChatId('-1009999999999') }),
    )

    expect(judgeStub.calls).toHaveLength(2)
  })

  test('未登记的群写入默认配置后照常审核', async () => {
    const { store, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '低价出售会员，需要的私聊', messageId: 108, chatId: asChatId('-1008888888888') }),
    )

    const registered = await store.repos.chats.findByChatId(asChatId('-1008888888888'))
    expect(registered).not.toBeNull()
    expect(registered?.language).toBe('zh')
    expect(registered?.rules.length).toBeGreaterThan(0)
  })

  test('重投递时按库里那条决策决定是否补摘录：库内是放行则不写正文', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const eventId = deriveEventId(chatId, 109)
    // 库里已有一条放行决策（首次判定落在放行带），而本轮重算会得到 delete：
    // 摘录的有无必须跟库里的决策一致，否则会写出「库里放行却留了正文」的记录。
    await store.repos.decisions.insert({
      id: deriveDecisionId(eventId),
      eventId,
      chatId,
      userId,
      action: { kind: 'pass' },
      score: 0,
      signals: [],
      decidedAt: new Date('2026-09-23T10:00:00Z'),
      executed: false,
    })
    let attachCalls = 0
    const repos = {
      ...store.repos,
      events: {
        ...store.repos.events,
        attachSample: async (id: string, text: string) => {
          attachCalls += 1
          await store.repos.events.attachSample(id, text)
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 109 }),
    )

    expect(attachCalls).toBe(0)
    expect(store.sampleOf(eventId)).toBeNull()
    expect(recording.countOf('deleteMessage')).toBe(0)
  })

  test('重投递时按库里那条决策决定是否补摘录：库内是非放行则补写正文', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const eventId = deriveEventId(chatId, 110)
    // 库里已有一条 delete 决策（已执行），本轮用一句低分文本重投递、会算出 pass：
    // 摘录仍然属于被处置的那条消息，必须按库里的档位补写。
    await store.repos.decisions.insert({
      id: deriveDecisionId(eventId),
      eventId,
      chatId,
      userId,
      action: { kind: 'delete' },
      score: 0.9,
      signals: [],
      decidedAt: new Date('2026-09-23T10:00:00Z'),
      executed: true,
    })
    let attachCalls = 0
    const repos = {
      ...store.repos,
      events: {
        ...store.repos.events,
        attachSample: async (id: string, text: string) => {
          attachCalls += 1
          await store.repos.events.attachSample(id, text)
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '这个键盘手感不错', messageId: 110 }),
    )

    expect(attachCalls).toBe(1)
    expect(store.sampleOf(eventId)).toBe('这个键盘手感不错')
    expect(recording.calls).toEqual([])
  })

  test('配置 notifyOwner：判定摘要在施加动作前发出，字段取库里的权威决策', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const observations: DecisionObservation[] = []
    const deletesAtNotify: number[] = []

    await handleIncomingMessage(
      {
        repos: store.repos,
        judge,
        executor,
        logger: silentLogger,
        now: fixedNow,
        notifyOwner: async (observation) => {
          observations.push(observation)
          // 时序：摘要在执行器施加动作之前发出。
          deletesAtNotify.push(recording.countOf('deleteMessage'))
        },
      },
      incoming({ text: '加v推荐一个渠道', messageId: 111 }),
    )

    expect(observations).toEqual([
      {
        chatId,
        chatTitle: '测试群',
        messageId: 111,
        userId,
        // feed 看原文，不是送审的归一化文本。
        text: '加v推荐一个渠道',
        signals: [
          { kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 },
          { kind: 'llm', verdict: 'spam', confidence: 0.9 },
        ],
        score: 1,
        action: { kind: 'delete' },
        decisionId: deriveDecisionId(deriveEventId(chatId, 111)),
        commentThread: null,
      },
    ])
    expect(deletesAtNotify).toEqual([0])
    expect(recording.countOf('deleteMessage')).toBe(1)
  })

  test('评论场景：commentThread 随判定摘要透传给 owner', async () => {
    const { store, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const observations: DecisionObservation[] = []
    const commentThread: CommentThread = { channelUsername: 'chan_pub', postId: 77 }

    await handleIncomingMessage(
      {
        repos: store.repos,
        judge,
        executor,
        logger: silentLogger,
        now: fixedNow,
        notifyOwner: async (observation) => {
          observations.push(observation)
        },
      },
      incoming({ text: '加v推荐一个渠道', messageId: 121, commentThread }),
    )

    expect(observations[0]?.commentThread).toEqual(commentThread)
  })

  test('重投递同一条消息：判定摘要只发一次', async () => {
    const { store, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const observations: DecisionObservation[] = []
    const deps = {
      repos: store.repos,
      judge,
      executor,
      logger: silentLogger,
      now: fixedNow,
      notifyOwner: async (observation: DecisionObservation) => {
        observations.push(observation)
      },
    }

    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 112 }))
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 112 }))

    expect(observations).toHaveLength(1)
  })

  test('未配置 notifyOwner：审核与执行路径照常', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 113 }),
    )

    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(recording.countOf('sendMessage')).toBe(1)
  })
})

describe('编辑消息审核', () => {
  test('每次编辑产生独立事件与决策，同一编辑重投递不重复落库与执行', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const deps = { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow }
    const editDate = 1_758_627_000
    // 判别符的固定形态：编辑时间 + 内容哈希前 16 位。
    const discriminator = `edit:${editDate}:${contentHashOf('加v推荐一个渠道').slice(0, 16)}`

    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 120 }))
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 120, editDate }))
    // 同一编辑的 Telegram 重投递：派生 id 相同，事件与决策都是静默无操作。
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 120, editDate }))

    const counts = await store.repos.aggregates.countForDay(
      chatId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    // 原始消息 + 一次编辑共两条事件，重投递没有写出第三条。
    expect(counts.messageCount).toBe(2)
    expect(counts.actionCount).toBe(2)

    const editDecision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 120, discriminator)))
    expect(editDecision?.action).toEqual({ kind: 'delete' })
    expect(recording.countOf('deleteMessage')).toBe(2)
  })

  test('同一秒内两次不同内容的编辑：判别符含内容哈希，各自成事件与决策', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const deps = { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow }
    const editDate = 1_758_627_000

    // 绕过形态：先编辑成正常内容（放行），再在同一个 edit_date 秒内改成违规内容。
    // 两次判别符必须不同，否则第二次事件与第一次决策 id 碰撞、被静默去重，违规内容不再被处置。
    await handleIncomingMessage(deps, incoming({ text: '这个键盘手感不错', messageId: 121, editDate }))
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 121, editDate }))

    const counts = await store.repos.aggregates.countForDay(
      chatId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(counts.messageCount).toBe(2)

    const benignId = deriveDecisionId(
      deriveEventId(chatId, 121, `edit:${editDate}:${contentHashOf('这个键盘手感不错').slice(0, 16)}`),
    )
    const adId = deriveDecisionId(deriveEventId(chatId, 121, `edit:${editDate}:${contentHashOf('加v推荐一个渠道').slice(0, 16)}`))
    expect(benignId).not.toBe(adId)
    expect((await store.repos.decisions.findById(benignId))?.action).toEqual({ kind: 'pass' })
    expect((await store.repos.decisions.findById(adId))?.action).toEqual({ kind: 'delete' })
    expect(recording.countOf('deleteMessage')).toBe(1)
  })

  test('编辑回退到早前内容：复用当时的事件 id，跳过重审（幂等）', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const deps = { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow }
    const editDate = 1_758_627_000

    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 122, editDate }))
    await handleIncomingMessage(deps, incoming({ text: '这个键盘手感不错', messageId: 122, editDate }))
    // 回到与第一次相同的内容：判别符与第一次相同，决策已存在且已执行，不再重审、不重复施加动作。
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 122, editDate }))

    const counts = await store.repos.aggregates.countForDay(
      chatId,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(counts.messageCount).toBe(2)
    expect(recording.countOf('deleteMessage')).toBe(1)
  })
})

describe('默认规则：名字信号与高精度正则', () => {
  test('私有邀请链接叠加 t.me 域名规则，0.8 直接处置', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: 't.me/+AbCdEf1234567890xy', messageId: 130, hasLink: true }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 130)))
    // 归一化后为 t.me/+abcdef1234567890xy：两条规则各 0.4，越过 llmThreshold 后直接处置。
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'default-link-telegram', score: 0.4 },
      { kind: 'rule-hit', ruleId: 'default-link-private-invite', score: 0.4 },
    ])
    expect(decision?.score).toBe(0.8)
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(judgeStub.calls).toEqual([])
    expect(recording.countOf('deleteMessage')).toBe(1)
  })

  test('bot 拉人头模式命中 0.5 送审，复核收到归一化发送者身份', async () => {
    const { store, judgeStub, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '/start abc123 @SomeBot', messageId: 131, senderIdentity: '张三' }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 131)))
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'default-bot-referral', score: 0.5 },
      { kind: 'llm', verdict: 'spam', confidence: 0.9 },
    ])
    expect(judgeStub.calls).toHaveLength(1)
    expect(judgeStub.calls[0]?.senderIdentity).toBe('张三')
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('名字命中与正文命中叠加到 0.8，不消耗复核调用', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加微信', messageId: 132, senderIdentity: '速查小助手' }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 132)))
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'default-ad-wechat', score: 0.4 },
      { kind: 'rule-hit', ruleId: 'default-name-ad', score: 0.4 },
    ])
    expect(decision?.score).toBe(0.8)
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(judgeStub.calls).toEqual([])
    expect(recording.countOf('deleteMessage')).toBe(1)
  })
})

/**
 * 在冻结的挂钟下执行：`decide` 生成 `mute` 时会读 `Date.now()` 算解禁时刻，
 * 冻结后断言才能写成确定的字面量。只冻结 `Date`，不碰定时器（幂等闸门用的是 `Date.now`）。
 *
 * @param body 被测逻辑。
 */
async function withFrozenClock(body: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-23T10:00:00Z') })
  try {
    await body()
  } finally {
    vi.useRealTimers()
  }
}

/**
 * 把管线依赖包成「只跑一条消息」的辅助，用于不需要观察执行的用例。
 *
 * @param parts 仓储与录制 api。
 * @param judge 复核器。
 * @param body 接收执行函数的回调。
 */
async function withPipeline(
  parts: { store: InMemoryRepos; recording: RecordingApi },
  judge: CachedJudge | null,
  body: (run: (message: { text: string; messageId: number }) => Promise<void>) => Promise<void>,
): Promise<void> {
  const executor: ActionExecutor = createActionExecutor({
    api: parts.recording.api,
    repos: parts.store.repos,
    idempotency: createIdempotencyRegistry(),
    outbound: createTokenBucket(),
    miniAppUrl: 'https://mini.example.com/app',
    logger: silentLogger,
    now: fixedNow,
    sleep: async () => {},
  })

  await body(async (message) => {
    await handleIncomingMessage(
      { repos: parts.store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming(message),
    )
  })
}

/**
 * 构造入站消息。
 *
 * @param overrides 覆盖字段。
 * @returns 管线输入。
 */
function incoming(overrides: {
  text: string
  messageId: number
  chatId?: ReturnType<typeof asChatId>
  editDate?: number
  senderIdentity?: string
  hasLink?: boolean
  customEmojiCount?: number
  commentThread?: CommentThread
}) {
  const text = overrides.text
  return {
    chatId: overrides.chatId ?? chatId,
    chatTitle: '测试群',
    messageId: overrides.messageId,
    userId,
    text,
    features: {
      hasLink: overrides.hasLink ?? false,
      mediaType: 'text' as const,
      length: Array.from(text).length,
      customEmojiCount: overrides.customEmojiCount ?? 0,
    },
    editDate: overrides.editDate ?? null,
    senderIdentity: overrides.senderIdentity ?? '',
    commentThread: overrides.commentThread ?? null,
  }
}

/**
 * 预置若干条历史违规决策，用于触发累犯加重。
 *
 * @param store 内存仓储。
 * @param count 条数。
 */
async function seedPriorViolations(store: InMemoryRepos, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-8000-00000000000${index}`
    await store.repos.decisions.insert({
      id,
      eventId: `10000000-0000-4000-8000-00000000000${index}`,
      chatId,
      userId,
      action: { kind: 'delete' },
      score: 0.9,
      signals: [],
      decidedAt: new Date('2026-09-22T10:00:00Z'),
      executed: true,
    })
  }
}
