import { asChatId, asUserId, type ChatConfig } from '@skitarii/core'
import { createCachedJudge, LlmError, type CachedJudge, type JudgeInput, type JudgeResult } from '@skitarii/llm'
import { describe, expect, test, vi } from 'vitest'
import type { ActionExecutor } from './executor.js'
import { createActionExecutor } from './executor.js'
import { deriveDecisionId, deriveEventId } from './ids.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createInMemoryRepos, type InMemoryRepos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { handleIncomingMessage, type DecisionObservation } from './pipeline.js'
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

  test('相同内容在另一个群命中复核缓存，不再调用模型', async () => {
    const { store, judgeStub, executor, judge } = setup({ cacheJudge: true })
    await store.repos.chats.upsert(chatConfig)

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
      },
    ])
    expect(deletesAtNotify).toEqual([0])
    expect(recording.countOf('deleteMessage')).toBe(1)
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
function incoming(overrides: { text: string; messageId: number; chatId?: ReturnType<typeof asChatId> }) {
  const text = overrides.text
  return {
    chatId: overrides.chatId ?? chatId,
    chatTitle: '测试群',
    messageId: overrides.messageId,
    userId,
    text,
    features: { hasLink: false, mediaType: 'text' as const, length: Array.from(text).length },
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
