import {
  decide,
  matchRules,
  normalize,
  scoreOf,
  type Action,
  type ChatConfig,
  type ChatId,
  type ChatType,
  type MessageFeatures,
  type Signal,
  type UserId,
} from '@skitarii/core'
import type { OverturnedSample, Repos } from '@skitarii/db'
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
 *    事件 id 由 `(chatId, messageId)` 派生，重投递天然幂等；编辑消息额外带
 *    `edit:${editDate}:${内容哈希前 16 位}` 判别符，每次编辑是独立事件（各自产生决策），
 *    同一编辑的重投递仍幂等。`edit_date` 只有秒级粒度，必须把内容哈希一起放进判别符：
 *    同一秒内先编辑成正常内容、再改成违规内容时，若两次共用判别符，第二个事件会与第一个碰撞、
 *    被静默去重，违规内容留在群里却不再被处置。代价是编辑回退到早前内容时 id 与早前那次相同、
 *    跳过重审（同一状态已经审过，视为幂等）。
 * 2. 手工信任名单先于判定：`config.whitelist` 命中当前用户时直接落一条 pass 决策（score 0、signals 空）
 *    并返回，不查内容白名单、不跑规则、不调复核、不施加动作；名单外账号不受影响。编辑消息走同一条快速通道
 *    （事件判别符的差异只影响事件 id，不影响这里）。
 * 3. 归一化 → 规则匹配 → `scoreOf` 分带。分数低于放行阈值不消耗 LLM 调用。
 *    规则匹配同时看正文与发送者身份（后者只服务 sender-name 规则，不落库）。
 *    误伤样本回写开启（`appealSampleWriteback`，开发中功能）且「本会被处置」（规则分 ≥ `passThreshold`）
 *    时另读一次该群误伤样本：命中内容白名单（同人 + 同内容 + 30 天内被撤销过）直接放行；
 *    灰色地带送审时把最近的非空摘录作为复核样例。开关关闭时完全不读样本（白名单与样例都不生效）；
 *    开启时低于阈值的正常消息仍不查样本（零额外开销），查询失败按「无样本」降级。
 * 4. 灰色地带（`passThreshold <= score < llmThreshold`）送复核：命中缓存就复用结论。
 *    复核失败只记日志，不追加信号，让 `decide` 走「待复核」的 warn 分支且不计累犯。这是既定口径：
 *    复核不可用时绝不能按 `actionHint` 直接动手，那等价于悄悄把 `llmThreshold` 降到 `passThreshold`。
 * 5. `decide` 出最终处置，落决策（同样用派生 id，重放不产生第二条）。
 * 6. 非放行处置补写正文摘录（是否补写以库里那条决策为准，不用本轮重算的档位），再交给执行器施加到 Telegram。
 * 7. 若配置了 `notifyOwner`，在施加动作前私聊 owner 一条判定摘要：摘要是「判定」而非「执行结果」，
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

/**
 * 误伤样本的回看窗口（天）。
 *
 * 取 90 天：样本是「这个群实际误伤过什么形态」的经验，误判往往隔一段时间才以相似措辞复发，
 * 窗口太短会让样例刚积累就过期。查询带上限（{@link OVERTURNED_SAMPLE_LIMIT}），
 * 窗口放宽不会让单次读取变重。
 */
const OVERTURNED_SAMPLE_WINDOW_DAYS = 90

/**
 * 内容白名单的有效期（天）。
 *
 * 比样本回看窗口短得多：直接放行是强动作，只在「最近刚被撤销过」的强相关时间窗内生效；
 * 更早的误伤仍然进 few-shot，但不自动放行。
 */
const CONTENT_WHITELIST_WINDOW_DAYS = 30

/** 单次读取的误伤样本条数上限。白名单只看最近窗口，few-shot 也只用少数几条。 */
const OVERTURNED_SAMPLE_LIMIT = 20

/** 送进复核提示词的误伤样例条数上限（按最近优先取非空摘录）。 */
const MAX_FEW_SHOT_EXAMPLES = 5

/**
 * 频道评论场景的深链锚点。
 *
 * 讨论组里的评论通过回复一条「频道帖子的转发」挂到原帖下；只有用频道用户名 + 帖子 id 拼出的
 * `t.me/<channel>/<post>?comment=<messageId>` 才能点进评论上下文，`t.me/c/` 链接在评论场景打不开目标。
 */
export interface CommentThread {
  /** 被评论频道的公开用户名（不含 `@`）。 */
  channelUsername: string
  /** 原频道帖子的消息 id。 */
  postId: number
}

/** 管线输入：由 bot 适配层从更新里提取的字段。刻意不传 grammY 的上下文，便于测试直接构造。 */
export interface IncomingMessage {
  chatId: ChatId
  chatTitle: string
  /**
   * 聊天类型，来自 update 的 `chat.type`。登记新群与刷新历史行类型只认这个值，
   * 不从发送者（可能缺失 `from`）推断。
   */
  chatType: ChatType
  messageId: number
  userId: UserId
  /** 分析文本：正文/caption + 内联键盘按钮文本，见 `composeAnalysisText`。是内容哈希与摘录的唯一来源。 */
  text: string
  features: MessageFeatures
  /**
   * Telegram `edit_date`（Unix 秒）；新消息为 `null`。编辑更新缺失该字段时，
   * bot 层会给出内容哈希派生的兜底值，保证同一编辑的重投递幂等（见 `bot.ts`）。
   * 它只参与事件判别符（与内容哈希前 16 位拼接），不参与判定。
   */
  editDate: number | null
  /** 发送者身份原文（显示名与 `@用户名`）；由管线负责 `normalize`，不落库。 */
  senderIdentity: string
  /** 评论的深链锚点；非评论场景为 `null`。 */
  commentThread: CommentThread | null
}

/** 管线依赖。 */
export interface PipelineDeps {
  repos: Repos
  /** 复核器；`null` 表示未配置 LLM，灰色地带一律按「待复核」处理。 */
  judge: CachedJudge | null
  executor: ActionExecutor
  logger: Logger
  /**
   * 误伤样本回写开关（开发中功能，默认关闭）。关闭时不读误伤样本：
   * 内容白名单不命中、送审不携带 few-shot 样例（等价于样本为空）；开启后与既有行为一致。
   */
  appealSampleWriteback?: boolean
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
 * feed 说的是库里那条判定。`text` 是分析文本而非归一化文本，也不是落库摘录：
 * 放行消息不落摘录，但 feed 同样要能看到它。
 */
export interface DecisionObservation {
  chatId: ChatId
  chatTitle: string
  messageId: number
  userId: UserId
  /** 分析文本：正文/caption + 内联键盘按钮文本，见 `composeAnalysisText`。 */
  text: string
  /** 判定信号，按产生顺序：规则命中在前、（灰色地带的）复核结论在后。 */
  signals: Signal[]
  /** 违规总分，0..1。 */
  score: number
  /** 最终处置。 */
  action: Action
  decisionId: string
  /** 评论的深链锚点；由入站消息透传，非评论场景为 `null`。 */
  commentThread: CommentThread | null
}

/**
 * 处理一条入站消息：落库、判定、执行。
 *
 * @param deps 仓储、复核器、执行器与日志。
 * @param message 入站消息。
 * @returns 本条消息使用的群配置（读回或登记后的权威版本）。
 *   调用方（bot 层）可以据此决定是否需要补充 linked discussion 关系，而不必再查一次库。
 */
export async function handleIncomingMessage(deps: PipelineDeps, message: IncomingMessage): Promise<ChatConfig> {
  const now = deps.now ?? (() => new Date())
  const contentHash = contentHashOf(message.text)
  const eventId = deriveEventId(
    message.chatId,
    message.messageId,
    message.editDate === null ? undefined : `edit:${message.editDate}:${contentHash.slice(0, 16)}`,
  )
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

  // 手工信任名单先于其余判定：命中即直接放行，跳过样本查询、规则、复核与执行。
  // 事件与决策照常落库（pass）供回看；`executed` 直接置位，放行没有待施加的动作，也不该落进补偿扫描。
  if (config.whitelist.includes(message.userId)) {
    await deps.repos.decisions.insert({
      id: decisionId,
      eventId,
      chatId: message.chatId,
      userId: message.userId,
      action: { kind: 'pass' },
      score: 0,
      signals: [],
      decidedAt: now(),
      executed: true,
    })
    deps.logger.info(
      `信任名单命中，直接放行 chatId=${message.chatId} userId=${message.userId} messageId=${message.messageId} decisionId=${decisionId}`,
    )
    return config
  }

  const normalized = normalize(message.text)
  const identity = normalize(message.senderIdentity)
  const ruleSignals = matchRules(normalized, message.features, config.rules, identity)
  const ruleScore = scoreOf(ruleSignals)

  // 样本回写默认关闭：关闭时按无样本处理（不查库、白名单不命中、送审不带样例）。
  // 开启时也只对「本会被处置」的消息找样本：低于放行阈值的正常消息不付出这次查询。
  const samples =
    deps.appealSampleWriteback !== true || ruleScore < config.passThreshold
      ? []
      : await loadOverturnedSamples(deps, message, now)

  // 内容白名单命中就直接放行：跳过复核与 `decide` 的累犯升档，但事件与决策照常落库（事后可回看）。
  const whitelisted = isWhitelisted(samples, message, contentHash, now)
  if (whitelisted) {
    deps.logger.info(
      `内容白名单命中，直接放行 chatId=${message.chatId} userId=${message.userId} messageId=${message.messageId}`,
    )
  }

  const signals = whitelisted
    ? ruleSignals
    : await collectSignals(deps, {
        message,
        config,
        normalized,
        identity,
        ruleSignals,
        ruleScore,
        contentHash,
        samples,
      })

  // 放行带与前科无关；白名单命中的结局是放行，也不必查。
  const priorViolations =
    whitelisted || ruleScore < config.passThreshold
      ? 0
      : await deps.repos.decisions.countPriorViolations(
          message.chatId,
          message.userId,
          new Date(now().getTime() - RECIDIVISM_WINDOW_DAYS * DAY_MS),
        )

  const action = whitelisted ? { kind: 'pass' as const } : decide(signals, config, { priorViolations })
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
      commentThread: message.commentThread,
    })
  }

  await deps.executor.execute(stored, { messageId: message.messageId })

  return config
}

/**
 * 读取该群最近的误伤样本。
 *
 * 失败按「无可用样本」降级：样本只是优化（少误判、少调模型），读不到不能阻断判定。
 *
 * @param deps 管线依赖。
 * @param message 入站消息（取群）。
 * @param now 时间源。
 * @returns 按结案时间倒序的样本；失败时为空数组。
 */
async function loadOverturnedSamples(
  deps: PipelineDeps,
  message: IncomingMessage,
  now: () => Date,
): Promise<OverturnedSample[]> {
  try {
    return await deps.repos.appeals.listOverturnedSamples(
      message.chatId,
      new Date(now().getTime() - OVERTURNED_SAMPLE_WINDOW_DAYS * DAY_MS),
      OVERTURNED_SAMPLE_LIMIT,
    )
  } catch (error) {
    deps.logger.warn(`误伤样本读取失败，按无样本处理 chatId=${message.chatId}`, error)
    return []
  }
}

/**
 * 内容白名单判定：样本里存在同人、同内容哈希、且结案在白名单窗口内的记录。
 *
 * 不做「正文相似」之类的模糊匹配：哈希全等是唯一不会引入新误伤的判据。
 *
 * @param samples 本轮读取的样本（倒序，白名单不依赖顺序）。
 * @param message 入站消息（取用户）。
 * @param contentHash 本条消息的内容哈希。
 * @param now 时间源。
 * @returns 是否命中白名单。
 */
function isWhitelisted(
  samples: readonly OverturnedSample[],
  message: IncomingMessage,
  contentHash: string,
  now: () => Date,
): boolean {
  const earliest = now().getTime() - CONTENT_WHITELIST_WINDOW_DAYS * DAY_MS
  return samples.some(
    (sample) =>
      sample.userId === message.userId &&
      sample.contentHash === contentHash &&
      sample.resolvedAt.getTime() >= earliest,
  )
}

/**
 * 读取群配置；未登记时登记默认配置并返回权威版本。
 *
 * 首次登记用 `register`（冲突即放弃）而不是 `upsert`：新群第一条消息可能与 owner 在面板里的保存并发，
 * 全量覆盖会把刚保存的规则冲掉。登记后重读一次，以库里的行为准（并发下可能由别处先写入）。
 *
 * 已登记的群在类型/标题与 update 不一致时补一次元数据刷新：历史行迁移时统一按 `supergroup` 兼容，
 * 真实类型由这里（以及 `my_chat_member` / `channel_post`）修正，且只走 `updateMetadata` 单列更新，
 * 不碰规则。
 *
 * @param deps 管线依赖。
 * @param message 入站消息。
 * @returns 群配置。
 */
async function loadConfig(deps: PipelineDeps, message: IncomingMessage): Promise<ChatConfig> {
  const existing = await deps.repos.chats.findByChatId(message.chatId)
  if (existing !== null) {
    if (existing.chatType === message.chatType && existing.title === message.chatTitle) return existing

    await deps.repos.chats.updateMetadata(message.chatId, {
      chatType: message.chatType,
      title: message.chatTitle,
    })
    return { ...existing, chatType: message.chatType, title: message.chatTitle }
  }

  deps.logger.info(`首次见到未登记的群，写入默认配置 chatId=${message.chatId}`)
  const config = defaultChatConfig(message.chatId, message.chatTitle, 'zh', message.chatType, null)
  await deps.repos.chats.register(config)
  return (await deps.repos.chats.findByChatId(message.chatId)) ?? config
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
    identity: string
    ruleSignals: Signal[]
    ruleScore: number
    contentHash: string
    /** 本轮读到的误伤样本（倒序）；只用于给复核提供样例。 */
    samples: readonly OverturnedSample[]
  },
): Promise<Signal[]> {
  const { config, normalized, identity, ruleSignals, ruleScore, contentHash, message, samples } = context

  const inGreyZone = ruleScore >= config.passThreshold && ruleScore < config.llmThreshold
  if (!inGreyZone) return ruleSignals
  if (deps.judge === null) {
    deps.logger.warn(`未配置 LLM，灰色地带按待复核处理 chatId=${message.chatId} messageId=${message.messageId}`)
    return ruleSignals
  }
  if (normalized.trim().length === 0) return ruleSignals

  // 样例按最近优先取非空摘录：样本本身已按结案时间倒序，`slice` 即取最近 5 条有正文的。
  // 纯空白摘录与空串一样跳过（避免占满 5 条额度）。
  const examples = samples
    .flatMap((sample) => {
      const text = sample.sampleText
      return text !== null && text.trim().length > 0 ? [text] : []
    })
    .slice(0, MAX_FEW_SHOT_EXAMPLES)

  try {
    const result = await deps.judge(contentHash, {
      text: normalized,
      features: message.features,
      signals: ruleSignals,
      language: config.language,
      rules: config.rules,
      // 空身份不带：让「没有身份可用」与「身份是空串」在送审材料里表现一致。
      ...(identity.length > 0 ? { senderIdentity: identity } : {}),
      // 没有样例时不带该字段：指纹对 `[]` 与「缺省」是同一个键，但送审材料保持最小。
      ...(examples.length > 0 ? { examples } : {}),
    })
    return [...ruleSignals, { kind: 'llm', verdict: result.verdict, confidence: result.confidence }]
  } catch (error) {
    // 复核不可用：不追加信号，`decide` 会给出不计累犯的 warn。
    deps.logger.warn(`复核失败，按待复核处理 chatId=${message.chatId} messageId=${message.messageId}`, error)
    return ruleSignals
  }
}
