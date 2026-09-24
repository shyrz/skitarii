import {
  decide,
  matchRules,
  normalize,
  scoreOf,
  type Action,
  type ChatConfig,
  type ChatId,
  type MessageFeatures,
  type Signal,
  type UserId,
} from '@skitarii/core'
import type { Repos } from '@skitarii/db'
import type { CachedJudge } from '@skitarii/llm'
import { defaultChatConfig } from './defaults.js'
import type { ActionExecutor } from './executor.js'
import { contentHashOf } from './features.js'
import { deriveDecisionId, deriveEventId } from './ids.js'
import type { Logger } from './logger.js'

/**
 * 消息审核管线。一次入站消息从落库到执行的完整路径，是 Phase 1 的核心。
 *
 * 顺序（每一步的理由）：
 * 1. 落 MessageEvent。先落库再判定：判定崩了消息还在，事后能复盘，也不会因为群配置缺失丢事件。
 *    事件 id 由 `(chatId, messageId)` 派生，重投递天然幂等。
 * 2. 归一化 → 规则匹配 → `scoreOf` 分带。分数低于放行阈值不消耗 LLM 调用。
 * 3. 灰色地带（`passThreshold <= score < llmThreshold`）送复核：命中缓存就复用结论。
 *    复核失败只记日志，不追加信号，让 `decide` 走「待复核」的 warn 分支且不计累犯。这是既定口径：
 *    复核不可用时绝不能按 `actionHint` 直接动手，那等价于悄悄把 `llmThreshold` 降到 `passThreshold`。
 * 4. `decide` 出最终处置，落决策（同样用派生 id，重放不产生第二条）。
 * 5. 非放行处置补写正文摘录（是否补写以库里那条决策为准，不用本轮重算的档位），再交给执行器施加到 Telegram。
 * 6. 若配置了 `notifyOwner`，在施加动作前私聊 owner 一条判定摘要：摘要是「判定」而非「执行结果」，
 *    动作被 Telegram 拒绝也不改变它；只在决策尚未执行时发，重投递不会重复通知。
 */

/**
 * 前科回看窗口。
 *
 * 取 7 天的理由：这个窗口决定「累犯」的时间尺度。太短（几小时）会让常驻用户频繁触发加重，
 * 太长（几个月）则把早已改正的人一直当累犯。一周与「群内活跃周期」同阶，且与 `RECIDIVISM_THRESHOLD = 3`
 * 配合后，要求同一用户在一周内累计三次违规才加重。
 */
export const RECIDIVISM_WINDOW_DAYS = 7

/** 一天的毫秒数，用于把窗口天数换算成时间戳。 */
const DAY_MS = 24 * 60 * 60 * 1_000

/** 管线输入：由 bot 适配层从更新里提取的字段。刻意不传 grammY 的上下文，便于测试直接构造。 */
export interface IncomingMessage {
  chatId: ChatId
  chatTitle: string
  messageId: number
  userId: UserId
  /** 原文（正文或 caption）。是内容哈希与摘录的唯一来源。 */
  text: string
  features: MessageFeatures
}

/** 管线依赖。 */
export interface PipelineDeps {
  repos: Repos
  /** 复核器；`null` 表示未配置 LLM，灰色地带一律按「待复核」处理。 */
  judge: CachedJudge | null
  executor: ActionExecutor
  logger: Logger
  /**
   * 判定摘要的接收方（owner 判定 feed）。缺省时不发。实现必须自行吞掉发送失败，
   * 不能让它影响审核链路；见 `owner-feed.ts` 的 `createOwnerFeed`。
   */
  notifyOwner?: ((observation: DecisionObservation) => Promise<void>) | undefined
  /** 时间源，默认系统时间。显式允许 `undefined`，让调用方可以直接透传可选配置。 */
  now?: (() => Date) | undefined
}

/**
 * 一条判定的摘要数据，供 owner 判定 feed 渲染。
 *
 * 字段一律取读回的权威决策（`stored`）：重投递时本轮重算的档位与分数可能已经变化，
 * feed 说的是库里那条判定。`text` 是消息原文而非归一化文本，也不是落库摘录：
 * 放行消息不落摘录，但 feed 同样要能看到它。
 */
export interface DecisionObservation {
  chatId: ChatId
  chatTitle: string
  messageId: number
  userId: UserId
  /** 消息原文（正文或 caption）。 */
  text: string
  /** 判定信号，按产生顺序：规则命中在前、（灰色地带的）复核结论在后。 */
  signals: Signal[]
  /** 违规总分，0..1。 */
  score: number
  /** 最终处置。 */
  action: Action
  decisionId: string
}

/**
 * 处理一条入站消息：落库、判定、执行。
 *
 * @param deps 仓储、复核器、执行器与日志。
 * @param message 入站消息。
 */
export async function handleIncomingMessage(deps: PipelineDeps, message: IncomingMessage): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const contentHash = contentHashOf(message.text)
  const eventId = deriveEventId(message.chatId, message.messageId)
  const decisionId = deriveDecisionId(eventId)

  await deps.repos.events.insert({
    id: eventId,
    chatId: message.chatId,
    userId: message.userId,
    messageId: message.messageId,
    contentHash,
    features: message.features,
    createdAt: now(),
  })

  const config = await loadConfig(deps, message)
  const normalized = normalize(message.text)
  const ruleSignals = matchRules(normalized, message.features, config.rules)
  const ruleScore = scoreOf(ruleSignals)

  const signals = await collectSignals(deps, {
    message,
    config,
    normalized,
    ruleSignals,
    ruleScore,
    contentHash,
  })

  // 放行带不必查前科：`decide` 在这一带直接放行，累犯次数影响不到结果，省一次查询。
  const priorViolations =
    ruleScore < config.passThreshold
      ? 0
      : await deps.repos.decisions.countPriorViolations(
          message.chatId,
          message.userId,
          new Date(now().getTime() - RECIDIVISM_WINDOW_DAYS * DAY_MS),
        )

  const action = decide(signals, config, { priorViolations })
  const decidedAt = now()

  await deps.repos.decisions.insert({
    id: decisionId,
    eventId,
    chatId: message.chatId,
    userId: message.userId,
    action,
    score: scoreOf(signals),
    signals,
    decidedAt,
    executed: false,
  })

  // 重新读一遍：重投递时 insert 是静默无操作，库里的决策与 `executed` 状态才是权威。
  const stored = await deps.repos.decisions.findById(decisionId)
  if (stored === null) throw new Error(`决策落库后读取不到 decisionId=${decisionId}`)

  // 摘录必须落在决策之后（数据库侧的条件是「同事件存在非 pass 决策」才允许写入），
  // 是否补摘录看库里的权威决策而不是本轮重算的 `action`：重投递时前科计数、复核缓存都可能已经变化，
  // 本轮算出的档位与库里那条可以不同，跟着重算结果走会出现「库里是放行却写了正文」或反之。
  if (stored.action.kind !== 'pass' && message.text.trim().length > 0) {
    await deps.repos.events.attachSample(eventId, message.text)
  }

  // 判定摘要发在动作之前：它反映「判定」本身，动作被 Telegram 拒绝（含降级为删除）都不应改变摘要内容。
  // 只在 `stored.executed === false` 时发：重投递时首投已经通知过，不重复发。
  if (deps.notifyOwner !== undefined && !stored.executed) {
    await deps.notifyOwner({
      chatId: stored.chatId,
      chatTitle: message.chatTitle,
      messageId: message.messageId,
      userId: stored.userId,
      text: message.text,
      signals: stored.signals,
      score: stored.score,
      action: stored.action,
      decisionId: stored.id,
    })
  }

  await deps.executor.execute(stored, { messageId: message.messageId })
}

/**
 * 读取群配置；未登记时写入默认配置并返回。
 *
 * @param deps 管线依赖。
 * @param message 入站消息。
 * @returns 群配置。
 */
async function loadConfig(deps: PipelineDeps, message: IncomingMessage): Promise<ChatConfig> {
  const existing = await deps.repos.chats.findByChatId(message.chatId)
  if (existing !== null) return existing

  deps.logger.info(`首次见到未登记的群，写入默认配置 chatId=${message.chatId}`)
  const config = defaultChatConfig(message.chatId, message.chatTitle, 'zh')
  await deps.repos.chats.upsert(config)
  return config
}

/**
 * 收集判定信号：规则命中，加上（灰色地带的）复核结论。
 *
 * @param deps 管线依赖。
 * @param context 本轮判定的中间结果。
 * @returns 送入 `decide` 的信号数组。
 */
async function collectSignals(
  deps: PipelineDeps,
  context: {
    message: IncomingMessage
    config: ChatConfig
    normalized: string
    ruleSignals: Signal[]
    ruleScore: number
    contentHash: string
  },
): Promise<Signal[]> {
  const { config, normalized, ruleSignals, ruleScore, contentHash, message } = context

  const inGreyZone = ruleScore >= config.passThreshold && ruleScore < config.llmThreshold
  if (!inGreyZone) return ruleSignals
  if (deps.judge === null) {
    deps.logger.warn(`未配置 LLM，灰色地带按待复核处理 chatId=${message.chatId} messageId=${message.messageId}`)
    return ruleSignals
  }
  if (normalized.trim().length === 0) return ruleSignals

  try {
    const result = await deps.judge(contentHash, {
      text: normalized,
      features: message.features,
      signals: ruleSignals,
      language: config.language,
      rules: config.rules,
    })
    return [...ruleSignals, { kind: 'llm', verdict: result.verdict, confidence: result.confidence }]
  } catch (error) {
    // 复核不可用：不追加信号，`decide` 会给出不计累犯的 warn。
    deps.logger.warn(`复核失败，按待复核处理 chatId=${message.chatId} messageId=${message.messageId}`, error)
    return ruleSignals
  }
}
