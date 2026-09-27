import { asChatId, asUserId, type ChatConfig, type ChatId, type UserId } from '@skitarii/core'
import { createCachedJudge, LlmError, type CachedJudge, type JudgeInput, type JudgeResult } from '@skitarii/llm'
import { describe, expect, test, vi } from 'vitest'
import type { ActionExecutor } from './executor.js'
import { createActionExecutor } from './executor.js'
import { defaultChatConfig } from './defaults.js'
import { contentHashOf } from './features.js'
import { deriveDecisionId, deriveEventId } from './ids.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createInMemoryRepos, type ChatMetadataPatch, type InMemoryRepos } from '@skitarii/db'
import type { Logger } from './logger.js'
import { handleIncomingMessage, NONMEMBER_INLINE_RULE_ID, type CommentThread, type DecisionObservation } from './pipeline.js'
import { createRecordingApi, type RecordingApi } from './recording-api.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)
const fixedNow = () => new Date('2026-09-23T10:00:00Z')

/** 判定用的群配置：一条中等分规则（灰色地带）、一条较高分规则（叠加后直接处置）。 */
const chatConfig: ChatConfig = {
  chatId,
  title: '测试群',
  chatType: 'supergroup',
  linkedChatId: null,
  language: 'zh',
  // pattern 必须是归一化后的形态：原文「加v」经 normalize 会变成「加微信」。
  rules: [
    { id: 'r-ad', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true },
    { id: 'r-rebate', kind: 'keyword', pattern: '刷单', score: 0.5, actionHint: 'mute', enabled: true },
  ],
  whitelist: [],
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
    await store.repos.chats.upsert(defaultChatConfig(asChatId('-1009999999999'), '另一个群', 'zh', 'supergroup'))

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
    // 信任名单默认空：新群先按规则审。
    expect(registered?.whitelist).toEqual([])
  })

  test('首次登记记录 update 里的聊天类型（basic group 不落成 supergroup 默认值）', async () => {
    const { store, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '这个键盘手感不错', messageId: 143, chatId: asChatId('-1007777777777'), chatType: 'group' }),
    )

    const registered = await store.repos.chats.findByChatId(asChatId('-1007777777777'))
    expect(registered?.chatType).toBe('group')
    expect(registered?.linkedChatId).toBeNull()
  })

  test('历史行类型与 update 不一致时只清单列刷新类型与标题，规则原样保留', async () => {
    const { store, executor, judge } = setup()
    // 模拟迁移兼容值：库里是 supergroup，实际消息来自 basic group。
    await store.repos.chats.upsert({ ...chatConfig, chatType: 'supergroup', title: '旧标题' })

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '这个键盘手感不错', messageId: 144, chatType: 'group' }),
    )

    const refreshed = await store.repos.chats.findByChatId(chatId)
    expect(refreshed?.chatType).toBe('group')
    expect(refreshed?.title).toBe('测试群')
    // 规则与阈值是 owner 的领域，元数据刷新不许碰它们。
    expect(refreshed?.rules).toEqual(chatConfig.rules)
    expect(refreshed?.passThreshold).toBe(chatConfig.passThreshold)
  })

  test('已登记且类型/标题一致时不发元数据更新', async () => {
    const { store, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    let updates = 0
    const repos = {
      ...store.repos,
      chats: {
        ...store.repos.chats,
        updateMetadata: async (targetChatId: ReturnType<typeof asChatId>, patch: ChatMetadataPatch) => {
          updates += 1
          await store.repos.chats.updateMetadata(targetChatId, patch)
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '这个键盘手感不错', messageId: 145 }),
    )

    expect(updates).toBe(0)
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
  test('默认配置恰 15 条规则，两条新增规则字段固定', async () => {
    const { store, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '你好', messageId: 139 }),
    )

    const config = await store.repos.chats.findByChatId(chatId)
    expect(config?.rules).toHaveLength(15)
    // 两条新规则按字段全等断言：kind / pattern / 分数 / 动作 / 启用态任一项漂移都会在这里失败。
    expect(config?.rules).toContainEqual({
      id: 'default-emoji-flood',
      kind: 'emoji-count',
      pattern: '6',
      score: 0.4,
      actionHint: 'delete',
      enabled: true,
    })
    expect(config?.rules).toContainEqual({
      id: 'default-inline-bot',
      kind: 'via-bot',
      pattern: '',
      score: 0.4,
      actionHint: 'delete',
      enabled: true,
    })
  })

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

  test('样例复现：via bot + 100 个表情，0.8 直接处置', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '💰'.repeat(100), messageId: 140, emojiCount: 100, viaBot: true }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 140)))
    // 表情总数 0.4 + 内联机器人 0.4 = 0.8：两条弱信号叠加越过复核阈值，直接处置。
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'default-emoji-flood', score: 0.4 },
      { kind: 'rule-hit', ruleId: 'default-inline-bot', score: 0.4 },
    ])
    expect(decision?.score).toBe(0.8)
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(judgeStub.calls).toEqual([])
    expect(recording.countOf('deleteMessage')).toBe(1)
  })

  test('无 via 的纯表情墙：0.4 落在灰色地带，送复核判定', async () => {
    const { store, judgeStub, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '💰'.repeat(10), messageId: 141, emojiCount: 10 }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 141)))
    expect(judgeStub.calls).toHaveLength(1)
    // 送审材料只带规则命中（0.4），复核结论由模型给出。
    expect(judgeStub.calls[0]?.signals).toEqual([{ kind: 'rule-hit', ruleId: 'default-emoji-flood', score: 0.4 }])
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'default-emoji-flood', score: 0.4 },
      { kind: 'llm', verdict: 'spam', confidence: 0.9 },
    ])
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('普通文本零新信号：表情不足 6 个且无 via bot 时直接放行', async () => {
    const { store, judgeStub, executor, judge } = setup()

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '这个键盘手感不错', messageId: 142, emojiCount: 5 }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 142)))
    expect(decision?.signals).toEqual([])
    expect(decision?.action).toEqual({ kind: 'pass' })
    expect(judgeStub.calls).toEqual([])
  })
})

describe('误伤样本回写', () => {
  /**
   * 预置一条误伤样本：事件（可带摘录）+ 非放行决策 + 已撤销申诉。
   *
   * @param store 内存仓储。
   * @param options 事件内容哈希或原文（二选一）、当事人、结案时刻与摘录。
   */
  async function seedOverturnedSample(
    store: InMemoryRepos,
    options: {
      id: string
      text?: string
      contentHash?: string
      userId?: number
      resolvedAt: Date
      sampleText?: string | null
    },
  ): Promise<void> {
    const eventId = `ev-${options.id}`
    const targetUser = asUserId(options.userId ?? userId)
    await store.repos.events.insert({
      id: eventId,
      chatId,
      userId: targetUser,
      messageId: 1,
      contentHash: options.contentHash ?? contentHashOf(options.text ?? ''),
      features: { hasLink: false, mediaType: 'text', length: 4, customEmojiCount: 0, emojiCount: 0, viaBot: false },
      createdAt: options.resolvedAt,
    })
    await store.repos.decisions.insert({
      id: `dec-${options.id}`,
      eventId,
      chatId,
      userId: targetUser,
      action: { kind: 'delete' },
      score: 0.9,
      signals: [],
      decidedAt: options.resolvedAt,
      executed: true,
    })
    await store.repos.appeals.insert({
      id: options.id,
      decisionId: `dec-${options.id}`,
      userId: targetUser,
      state: 'overturned',
      note: null,
      createdAt: options.resolvedAt,
      resolvedAt: options.resolvedAt,
    })
    if (options.sampleText !== undefined && options.sampleText !== null) {
      await store.repos.events.attachSample(eventId, options.sampleText)
    }
  }

  test('内容白名单：同人同内容 30 天内被撤销过 → 直接放行，不调复核也不执行动作', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    await seedOverturnedSample(store, {
      id: 'sample-1',
      text: '加v推荐一个渠道',
      resolvedAt: new Date('2026-09-22T10:00:00Z'),
    })

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 200 }),
    )

    const eventId = deriveEventId(chatId, 200)
    const decision = await store.repos.decisions.findById(deriveDecisionId(eventId))
    // 规则分原样记录、保留命中信号作留痕；不升档、不调复核、不碰 Telegram。
    expect(decision).toMatchObject({
      action: { kind: 'pass' },
      score: 0.4,
      signals: [{ kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 }],
      executed: true,
    })
    expect(judgeStub.calls).toEqual([])
    expect(recording.calls).toEqual([])
    // 白名单命中仍落事件与决策，事后可回看。
    expect(await store.repos.events.findWithSample(eventId)).not.toBeNull()
  })

  test('白名单：异用户同内容不命中', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    await seedOverturnedSample(store, {
      id: 'sample-other',
      text: '加v推荐一个渠道',
      userId: 7_000_000_999,
      resolvedAt: new Date('2026-09-22T10:00:00Z'),
    })

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 201 }),
    )

    // 回到常规路径：灰色地带送复核，复核确认违规 → delete。
    expect(judgeStub.calls).toHaveLength(1)
    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 201)))
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('白名单：超过 30 天的撤销不再自动放行', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    await seedOverturnedSample(store, {
      id: 'sample-expired',
      text: '加v推荐一个渠道',
      resolvedAt: new Date('2026-08-23T10:00:00Z'),
    })

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 202 }),
    )

    expect(judgeStub.calls).toHaveLength(1)
    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 202)))
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('few-shot：灰色地带送审带上最近的误伤样例（跳过空摘录，最多 5 条）', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)

    // 最近的一条没有摘录（纯媒体），随后 6 条有摘录：只带最近 5 条非空，按最近优先。
    await seedOverturnedSample(store, {
      id: 'fs-null',
      contentHash: contentHashOf('空摘录样本'),
      resolvedAt: new Date('2026-09-23T09:00:00Z'),
      sampleText: null,
    })
    for (let index = 1; index <= 6; index += 1) {
      await seedOverturnedSample(store, {
        id: `fs-${index}`,
        contentHash: contentHashOf(`样例${index}`),
        resolvedAt: new Date(`2026-09-23T09:0${index}:00Z`),
        sampleText: `样例${index}`,
      })
    }

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 203 }),
    )

    expect(judgeStub.calls).toHaveLength(1)
    expect(judgeStub.calls[0]?.examples).toEqual(['样例6', '样例5', '样例4', '样例3', '样例2'])
  })

  test('开关关闭（默认）：不查样本、送审不带样例、内容白名单不生效', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    // 预置一条本可命中内容白名单、且带摘录的样本；开关关闭时它必须被完全忽略。
    await seedOverturnedSample(store, {
      id: 'sample-off',
      text: '加v推荐一个渠道',
      resolvedAt: new Date('2026-09-22T10:00:00Z'),
      sampleText: '此前的误伤摘录',
    })
    let sampleQueries = 0
    const repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        listOverturnedSamples: async () => {
          sampleQueries += 1
          return []
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '加v推荐一个渠道', messageId: 211 }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 211)))
    // 不查库：读取次数为零，送审材料里也没有样例（指纹与「无样本」一致）。
    expect(sampleQueries).toBe(0)
    expect(judgeStub.calls).toHaveLength(1)
    expect(judgeStub.calls[0]?.examples).toBeUndefined()
    // 内容白名单不生效：同人同内容也回到常规路径（复核确认违规 → delete），不直接放行。
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('样本查询失败降级为无样本，判定照常（warn）', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message)
      },
      error: () => {},
    }
    const repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        listOverturnedSamples: async () => {
          throw new Error('database is down')
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 204 }),
    )

    expect(judgeStub.calls).toHaveLength(1)
    expect(warnings.some((message) => message.includes('误伤样本读取失败'))).toBe(true)
    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 204)))
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('低于放行阈值的消息不查询样本、不调复核', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    let sampleQueries = 0
    const repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        listOverturnedSamples: async () => {
          sampleQueries += 1
          return []
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '这个键盘手感不错', messageId: 205 }),
    )

    expect(sampleQueries).toBe(0)
    expect(judgeStub.calls).toEqual([])
  })

  test('样本读取恰好一次：窗口为 now − 90 天、上限 20', async () => {
    const { store, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const queries: Array<{ chatId: unknown; since: Date; limit: number }> = []
    const repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        listOverturnedSamples: async (targetChatId: unknown, since: Date, limit: number) => {
          queries.push({ chatId: targetChatId, since, limit })
          return []
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 206 }),
    )

    expect(queries).toHaveLength(1)
    expect(queries[0]?.chatId).toBe(chatId)
    // fixedNow（2026-09-23T10:00:00Z）往前 90 天。
    expect(queries[0]?.since).toEqual(new Date('2026-06-25T10:00:00Z'))
    expect(queries[0]?.limit).toBe(20)
  })

  test('白名单：恰好在 30 天边界上仍命中（左闭区间）', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    // fixedNow 往前 30 天 = 2026-08-24T10:00:00Z。
    await seedOverturnedSample(store, {
      id: 'sample-boundary',
      text: '加v推荐一个渠道',
      resolvedAt: new Date('2026-08-24T10:00:00Z'),
    })

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 207 }),
    )

    expect(judgeStub.calls).toEqual([])
    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 207)))
    expect(decision?.action).toEqual({ kind: 'pass' })
  })

  test('信任名单：名单内账号直接放行，不查样本、不调复核、不执行动作', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert({ ...chatConfig, whitelist: [userId] })
    // 同内容的误伤样本也在库里：信任名单先于内容白名单判定，不应读它、也不保留规则命中。
    await seedOverturnedSample(store, {
      id: 'sample-trusted',
      text: '加v推荐一个渠道',
      resolvedAt: new Date('2026-09-22T10:00:00Z'),
    })

    let sampleQueries = 0
    const repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        listOverturnedSamples: async () => {
          sampleQueries += 1
          return []
        },
      },
    }
    const infos: string[] = []
    const logger: Logger = {
      info: (message: string) => {
        infos.push(message)
      },
      warn: () => {},
      error: () => {},
    }
    const observations: DecisionObservation[] = []

    await handleIncomingMessage(
      {
        repos,
        judge,
        executor,
        logger,
        now: fixedNow,
        appealSampleWriteback: true,
        notifyOwner: async (observation) => {
          observations.push(observation)
        },
      },
      incoming({ text: '加v推荐一个渠道', messageId: 208 }),
    )

    const eventId = deriveEventId(chatId, 208)
    const decision = await store.repos.decisions.findById(deriveDecisionId(eventId))
    // 分数与信号都归零：不经过规则与复核，也不执行任何动作；放行没有待施加的动作，executed 直接置位。
    expect(decision).toMatchObject({
      action: { kind: 'pass' },
      score: 0,
      signals: [],
      executed: true,
    })
    expect(sampleQueries).toBe(0)
    expect(judgeStub.calls).toEqual([])
    expect(recording.calls).toEqual([])
    // 快速通道直接放行、不经过判定，也就不发 owner 判定 feed。
    expect(observations).toEqual([])
    expect(store.sampleOf(eventId)).toBeNull()
    // info 日志带 decisionId，回看这条快速通道时能对上决策。
    expect(
      infos.some((message) => message.includes('信任名单命中') && message.includes(String(decision?.id))),
    ).toBe(true)
  })

  test('信任名单：名单外账号不受影响，照常走规则与复核', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert({ ...chatConfig, whitelist: [asUserId(7_000_000_999)] })
    const observations: DecisionObservation[] = []

    await handleIncomingMessage(
      {
        repos: store.repos,
        judge,
        executor,
        logger: silentLogger,
        now: fixedNow,
        appealSampleWriteback: true,
        notifyOwner: async (observation) => {
          observations.push(observation)
        },
      },
      incoming({ text: '加v推荐一个渠道', messageId: 209 }),
    )

    expect(judgeStub.calls).toHaveLength(1)
    // 对照：非白名单路径照常发判定 feed，证明替身接线有效，名单命中用例的「未调用」不是空断言。
    expect(observations).toHaveLength(1)
    expect(recording.countOf('deleteMessage')).toBe(1)
    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 209)))
    expect(decision?.signals).toEqual([
      { kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 },
      { kind: 'llm', verdict: 'spam', confidence: 0.9 },
    ])
    expect(decision?.action).toEqual({ kind: 'delete' })
  })

  test('信任名单：编辑消息同样直接放行（事件判别符不改变快速通道）', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert({ ...chatConfig, whitelist: [userId] })
    const editDate = 1_758_600_123
    const observations: DecisionObservation[] = []

    await handleIncomingMessage(
      {
        repos: store.repos,
        judge,
        executor,
        logger: silentLogger,
        now: fixedNow,
        appealSampleWriteback: true,
        notifyOwner: async (observation) => {
          observations.push(observation)
        },
      },
      incoming({ text: '加v推荐一个渠道', messageId: 210, editDate }),
    )

    const eventId = deriveEventId(
      chatId,
      210,
      `edit:${editDate}:${contentHashOf('加v推荐一个渠道').slice(0, 16)}`,
    )
    const decision = await store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision).toMatchObject({ action: { kind: 'pass' }, score: 0, signals: [] })
    expect(judgeStub.calls).toEqual([])
    expect(recording.calls).toEqual([])
    // 编辑消息同样走快速通道：事件判别符不同，但不产生 owner 判定 feed。
    expect(observations).toEqual([])
  })
})

/**
 * 非成员经内联机器人发消息的锁定策略。
 *
 * 与常规判定完全分叉：命中时跳过内容白名单、规则匹配、复核与前科查询，只按窗口计数给出 delete / ban。
 * 成员探测在 bot 层（`nonmember.test.ts` 与 `bot-nonmember.test.ts` 覆盖），这里只构造管线入参。
 */
describe('非成员经内联机器人发消息', () => {
  /**
   * 预置一条带非成员标记的历史决策，用于把窗口计数推过封禁阈值。
   *
   * @param store 内存仓储。
   * @param index 决策序号（拼 id）。
   * @param decidedAt 判定时刻。
   */
  async function seedMarkerDecision(store: InMemoryRepos, index: number, decidedAt: Date): Promise<void> {
    const suffix = String(index).padStart(4, '0')
    await store.repos.decisions.insert({
      id: `10000000-0000-4000-8000-00000000${suffix}`,
      eventId: `20000000-0000-4000-8000-00000000${suffix}`,
      chatId,
      userId,
      action: { kind: 'delete' },
      score: 1,
      signals: [{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }],
      decidedAt,
      executed: true,
    })
  }

  test('非成员经内联机器人发消息：直接删除并落固定分数与标记信号，规则/复核/样本/前科都不参与', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    let sampleQueries = 0
    let priorQueries = 0
    const ruleHitQueries: Array<{ ruleId: string; since: Date }> = []
    const repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        listOverturnedSamples: async () => {
          sampleQueries += 1
          return []
        },
      },
      decisions: {
        ...store.repos.decisions,
        countPriorViolations: async () => {
          priorQueries += 1
          return 0
        },
        countRuleHitsSince: async (targetChatId: ChatId, targetUserId: UserId, ruleId: string, since: Date) => {
          ruleHitQueries.push({ ruleId, since })
          return store.repos.decisions.countRuleHitsSince(targetChatId, targetUserId, ruleId, since)
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow, appealSampleWriteback: true },
      incoming({ text: '加v推荐一个渠道', messageId: 300, viaBot: true, senderNonMemberProbe: async () => true }),
    )

    const eventId = deriveEventId(chatId, 300)
    const decision = await store.repos.decisions.findById(deriveDecisionId(eventId))
    expect(decision).toMatchObject({
      action: { kind: 'delete' },
      score: 1,
      signals: [{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }],
      executed: true,
    })
    // 窗口 = now − 1 小时；计数锚点必须是标记 ruleId。
    expect(ruleHitQueries).toEqual([{ ruleId: NONMEMBER_INLINE_RULE_ID, since: new Date('2026-09-23T09:00:00Z') }])
    expect(sampleQueries).toBe(0)
    expect(priorQueries).toBe(0)
    expect(judgeStub.calls).toEqual([])
    expect(recording.countOf('deleteMessage')).toBe(1)
    // 非放行处置照常补写摘录：共享尾部对策略命中与常规判定一视同仁。
    expect(store.sampleOf(eventId)).toBe('加v推荐一个渠道')
  })

  test('窗口内已发满 3 条：第 4 条直接封禁，不再删除消息', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    for (let index = 1; index <= 3; index += 1) {
      await seedMarkerDecision(store, index, new Date('2026-09-23T09:30:00Z'))
    }
    const observations: DecisionObservation[] = []

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
      incoming({ text: '再发一条', messageId: 301, viaBot: true, senderNonMemberProbe: async () => true }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 301)))
    expect(decision).toMatchObject({ action: { kind: 'ban' }, score: 1, executed: true })
    expect(recording.countOf('banChatMember')).toBe(1)
    expect(recording.countOf('deleteMessage')).toBe(0)
    // owner 判定摘要复用共享尾部：字段取库里的权威决策。
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      action: { kind: 'ban' },
      score: 1,
      signals: [{ kind: 'rule-hit', ruleId: NONMEMBER_INLINE_RULE_ID, score: 1 }],
    })
  })

  test('窗口外的历史标记不计数：1 小时前的 3 条不影响本次判定', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    for (let index = 1; index <= 3; index += 1) {
      await seedMarkerDecision(store, index, new Date('2026-09-23T08:59:59Z'))
    }

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '再发一条', messageId: 302, viaBot: true, senderNonMemberProbe: async () => true }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 302)))
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(recording.countOf('banChatMember')).toBe(0)
  })

  test('编辑消息同样走策略：每次编辑是独立决策，照常计入窗口', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    for (let index = 1; index <= 3; index += 1) {
      await seedMarkerDecision(store, index, new Date('2026-09-23T09:30:00Z'))
    }
    const editDate = 1_758_630_000

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '编辑后的广告', messageId: 303, editDate, viaBot: true, senderNonMemberProbe: async () => true }),
    )

    const eventId = deriveEventId(chatId, 303, `edit:${editDate}:${contentHashOf('编辑后的广告').slice(0, 16)}`)
    expect((await store.repos.decisions.findById(deriveDecisionId(eventId)))?.action).toEqual({ kind: 'ban' })
    expect(recording.countOf('banChatMember')).toBe(1)
  })

  test('探针确认是成员、缺探针或没有 via bot：照常走规则与复核，且只在 via bot 时调用探针', async () => {
    const { store, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    const deps = { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow }
    let probes = 0
    const memberProbe = async (): Promise<boolean> => {
      probes += 1
      return false
    }
    const nonMemberProbe = async (): Promise<boolean> => {
      probes += 1
      return true
    }

    // 探针确认是成员：回到原流程。
    await handleIncomingMessage(
      deps,
      incoming({ text: '加v推荐一个渠道', messageId: 304, viaBot: true, senderNonMemberProbe: memberProbe }),
    )
    // 有 via bot 但调用方没给探针：同样按成员处理。
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 305, viaBot: true }))
    // 没有 via bot：即使给了探针也不调用（惰性 + 条件不成立），照常走规则。
    await handleIncomingMessage(deps, incoming({ text: '加v推荐一个渠道', messageId: 307, senderNonMemberProbe: nonMemberProbe }))

    expect(probes).toBe(1)
    expect(judgeStub.calls).toHaveLength(3)
    for (const messageId of [304, 305, 307]) {
      const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, messageId)))
      // 规则命中在前、复核结论在后：策略标记从未出现。
      expect(decision?.signals[0]).toEqual({ kind: 'rule-hit', ruleId: 'r-ad', score: 0.4 })
      expect(decision?.signals).toHaveLength(2)
      expect(decision?.action).toEqual({ kind: 'delete' })
    }
  })

  test('信任名单优先：名单内账号经内联机器人发消息仍直接放行，探针与窗口计数都不触发', async () => {
    const { store, recording, judgeStub, executor, judge } = setup()
    await store.repos.chats.upsert({ ...chatConfig, whitelist: [userId] })
    let ruleHitQueries = 0
    let probes = 0
    const repos = {
      ...store.repos,
      decisions: {
        ...store.repos.decisions,
        countRuleHitsSince: async (...args: Parameters<typeof store.repos.decisions.countRuleHitsSince>) => {
          ruleHitQueries += 1
          return store.repos.decisions.countRuleHitsSince(...args)
        },
      },
    }

    await handleIncomingMessage(
      { repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({
        text: '加v推荐一个渠道',
        messageId: 306,
        viaBot: true,
        senderNonMemberProbe: async () => {
          probes += 1
          return true
        },
      }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 306)))
    expect(decision).toMatchObject({ action: { kind: 'pass' }, score: 0, signals: [], executed: true })
    // 惰性探针：名单命中在探测之前返回，一次 API 往返都不付出。
    expect(probes).toBe(0)
    expect(ruleHitQueries).toBe(0)
    expect(judgeStub.calls).toEqual([])
    expect(recording.calls).toEqual([])
  })

  test('窗口左闭：恰在 1 小时前的 3 条标记仍计数（第 4 条封禁）', async () => {
    const { store, recording, executor, judge } = setup()
    await store.repos.chats.upsert(chatConfig)
    // 决策时刻为 fixedNow（10:00:00），窗口起点恰为 09:00:00：左闭区间上这些记录全部计入。
    for (let index = 1; index <= 3; index += 1) {
      await seedMarkerDecision(store, index, new Date('2026-09-23T09:00:00Z'))
    }

    await handleIncomingMessage(
      { repos: store.repos, judge, executor, logger: silentLogger, now: fixedNow },
      incoming({ text: '再发一条', messageId: 308, viaBot: true, senderNonMemberProbe: async () => true }),
    )

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 308)))
    expect(decision?.action).toEqual({ kind: 'ban' })
    expect(recording.countOf('banChatMember')).toBe(1)
  })

  test('重投递：本轮窗口计数升档也不改写已落库的决策（stored 权威，不重复通知/执行）', async () => {
    const { store, recording, executor, judge } = setup()
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
    const deliver = () =>
      handleIncomingMessage(
        deps,
        incoming({ text: '第一条', messageId: 309, viaBot: true, senderNonMemberProbe: async () => true }),
      )

    await deliver()
    // 首投后窗口内又累计 3 条同标记决策：重投递本轮会算出 ban，但库里那条 delete 已经执行。
    for (let index = 1; index <= 3; index += 1) {
      await seedMarkerDecision(store, index, new Date('2026-09-23T09:30:00Z'))
    }
    await deliver()

    const decision = await store.repos.decisions.findById(deriveDecisionId(deriveEventId(chatId, 309)))
    expect(decision?.action).toEqual({ kind: 'delete' })
    expect(recording.countOf('banChatMember')).toBe(0)
    // 动作与判定摘要都只发生一次：重投递不再执行，也不重复通知。
    expect(recording.countOf('deleteMessage')).toBe(1)
    expect(observations).toHaveLength(1)
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
  chatType?: ChatConfig['chatType']
  editDate?: number
  senderIdentity?: string
  hasLink?: boolean
  customEmojiCount?: number
  emojiCount?: number
  viaBot?: boolean
  /** 非成员探测结果：缺省表示未探测/探测失败（失败开放）。 */
  /** 非成员惰性探针：缺省表示调用方没给探针（按成员处理）。 */
  senderNonMemberProbe?: () => Promise<boolean | undefined>
  commentThread?: CommentThread
}) {
  const text = overrides.text
  return {
    chatId: overrides.chatId ?? chatId,
    chatTitle: '测试群',
    chatType: overrides.chatType ?? ('supergroup' as const),
    messageId: overrides.messageId,
    userId,
    text,
    features: {
      hasLink: overrides.hasLink ?? false,
      mediaType: 'text' as const,
      length: Array.from(text).length,
      customEmojiCount: overrides.customEmojiCount ?? 0,
      emojiCount: overrides.emojiCount ?? 0,
      viaBot: overrides.viaBot ?? false,
    },
    ...(overrides.senderNonMemberProbe === undefined ? {} : { senderNonMemberProbe: overrides.senderNonMemberProbe }),
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
