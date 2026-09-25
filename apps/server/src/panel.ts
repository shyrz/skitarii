import { randomBytes } from 'node:crypto'
import {
  asChatId,
  type AppealState,
  type ChatConfig,
  type DailyAggregate,
  type ModerationDecision,
  type Rule,
  type RuleAction,
  type RuleKind,
  type Signal,
  type UserId,
} from '@skitarii/core'
import type { AppealResolution, Logger } from '@skitarii/bot'
import type { Repos } from '@skitarii/db'
import { z } from 'zod'
import type { ApiResponse } from './api.js'
import { verifyInitData } from './init-data.js'

/**
 * Mini App 面板 API（owner 专属）：跨群概览、报表序列、处置队列、申诉队列、网页内结案与群配置编辑。
 *
 * 与 `api.ts` 同一套写法：端点逻辑是返回 `{ status, body }` 的纯函数，`index.ts` 只做路由与
 * HTTP 翻译，这样鉴权、过滤、分页、状态码映射都能脱离服务器做行为测试。
 *
 * 鉴权口径（spec §1）：所有端点先验签 initData，验签失败 401 `init_data_invalid`；
 * 验签通过但不是 owner 时 403 `forbidden`，与 401 区分开让前端能给出不同提示。
 *
 * 性能口径（spec §2、§3.2）：所有列表都在 SQL 侧完成过滤、排序与 limit；
 * 群标题用 `chats.listAll` 一次建映射，正文摘录用 `events.findSamples` 一条 IN 查询批量取，禁止 N+1。
 */

/** 概览的统计窗口（含今天）。与 spec 的「近 7 日」一致。 */
const OVERVIEW_WINDOW_DAYS = 7

/**
 * 概览里 open 申诉的扫描上限。
 *
 * `openAppeals` 是每群的待处理计数，需要一个上界避免一次拉全表；自用规模下 1000 条远超真实积压量，
 * 触顶时计数会偏低（宁可少报也不做无界查询）。
 */
const OPEN_APPEAL_SCAN_LIMIT = 1_000

/** 列表端点默认与最大页大小（spec：默认 50，上限 100）。 */
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100

/** 报表序列的窗口范围与默认值（spec：默认 30，clamp 到 [7, 90]）。 */
const DEFAULT_SERIES_DAYS = 30
const MIN_SERIES_DAYS = 7
const MAX_SERIES_DAYS = 90

/** 一天的毫秒数。日聚合按 UTC 切日，与调度器的口径一致（见 README「日聚合按 UTC 切日」）。 */
const DAY_MS = 24 * 60 * 60 * 1_000

/** uuid 形态。非 uuid 交给 `uuid` 列比较会让 Postgres 直接报错，先挡在应用层（与 `api.ts` 同一判据）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** 可以精确过滤的处置档位；缺省与 `all` 另有含义。 */
const ACTION_FILTERS: ReadonlySet<string> = new Set(['pass', 'warn', 'delete', 'mute', 'ban'])

/** 申诉状态过滤取值。 */
const APPEAL_STATES: ReadonlySet<string> = new Set(['open', 'upheld', 'overturned'])

/** 保存配置时接受的规则条数上限：再多就该换配置方式，而不是继续手改面板。 */
const MAX_RULES = 100

/** 禁言时长上限（分钟）：30 天。防误输入，也避免成员被无限期留在禁言里。 */
const MAX_MUTE_DURATION_MINUTES = 43_200

/** 合法规则种类，与 `RuleKind` 一致。保存边界必须与引擎的认识一致，否则写进去的规则不会命中。 */
const RULE_KINDS: ReadonlySet<string> = new Set([
  'keyword',
  'regex',
  'link-domain',
  'sender-name',
  'custom-emoji',
  'emoji-count',
  'via-bot',
])

/** 合法处置档位，与 `RuleAction` 一致。 */
const RULE_ACTIONS: ReadonlySet<string> = new Set(['pass', 'warn', 'delete', 'mute', 'ban'])

/** 计数值规则（`custom-emoji` / `emoji-count`）的 pattern 形态：十进制最小计数。 */
const COUNT_PATTERN = /^\d+$/u

/**
 * 计数 pattern 是否合法：与引擎 `rules.ts` 的 `minimumCount` 完全同口径，多一层都不算宽——
 * 整体十进制加安全整数；20 位这类超长数字串解析超出安全整数范围，引擎按坏数据失效，
 * 保存边界同样拒绝，不让它写进去静默失效。
 */
function isCountPattern(pattern: string): boolean {
  return COUNT_PATTERN.test(pattern) && Number.isSafeInteger(Number(pattern))
}

/** 面板聚合计数。与 `DailyAggregate` 去掉主键字段后一一对应。 */
type DailyCounts = Omit<DailyAggregate, 'chatId' | 'date'>

/** 零计数。缺失日与空群都复用它，避免在响应里出现 `undefined`。 */
const ZERO_COUNTS: DailyCounts = { messageCount: 0, actionCount: 0, appealCount: 0, overturnedCount: 0 }

/** 复核信号。`Signal` 的一个分支，单独取出便于按类型收窄。 */
type LlmSignal = Extract<Signal, { kind: 'llm' }>

/** 面板 API 依赖。 */
export interface PanelApiDeps {
  repos: Repos
  /** bot token，用于 initData 验签。 */
  botToken: string
  /** 面板唯一使用者：验签后的 userId 必须等于它才放行。 */
  ownerUserId: UserId
  /**
   * 结案入口。`index.ts` 注入 `resolveAppeal` + bot api 的实现（与申诉通知同源）；
   * 测试注入替身即可断言 200 / 409 / 404 的映射，不必构造 Telegram 客户端。
   */
  resolveAppeal(appealId: string, outcome: 'uphold' | 'overturn'): Promise<AppealResolution>
  logger: Logger
  now?: () => Date
}

/**
 * 概览：今日与近 7 日的总计、每群计数与待处理申诉数。
 *
 * 每群一条 `aggregates.listRange`：群数量小（自用规模）且 spec 明确允许；
 * 换成一条 SQL 需要新增仓储方法，收益不成比例。
 *
 * @param deps 面板依赖。
 * @param query `initData` 来自查询串。
 * @returns 200 概览；401 / 403 鉴权失败。
 */
export async function getPanelOverview(
  deps: PanelApiDeps,
  query: { initData: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const now = deps.now?.() ?? new Date()
  const today = utcDate(now)
  const windowStart = utcDate(shiftUtcDays(now, -(OVERVIEW_WINDOW_DAYS - 1)))

  const [chats, openAppeals] = await Promise.all([
    deps.repos.chats.listAll(),
    deps.repos.appeals.listByStateWithDecision('open', OPEN_APPEAL_SCAN_LIMIT),
  ])

  const openByChat = new Map<string, number>()
  for (const { decision } of openAppeals) {
    openByChat.set(decision.chatId, (openByChat.get(decision.chatId) ?? 0) + 1)
  }

  const rows = await Promise.all(
    chats.map(async (chat) => {
      const range = await deps.repos.aggregates.listRange(chat.chatId, windowStart, today)
      const byDate = new Map(range.map((row) => [row.date, row]))
      return {
        chatId: chat.chatId,
        title: chat.title,
        today: dailyCountsOf(byDate.get(today)),
        last7d: sumDailyCounts(range.map(dailyCountsOf)),
        openAppeals: openByChat.get(chat.chatId) ?? 0,
      }
    }),
  )

  // 活跃在前；同分按 chatId 升序，让响应顺序确定（页面刷新不会换位）。
  rows.sort((a, b) => b.last7d.actionCount - a.last7d.actionCount || a.chatId.localeCompare(b.chatId))

  return {
    status: 200,
    body: {
      totals: {
        today: sumDailyCounts(rows.map((row) => row.today)),
        last7d: sumDailyCounts(rows.map((row) => row.last7d)),
      },
      chats: rows,
      serverTime: now,
    },
  }
}

/**
 * 某群的日序列：连续日期、缺失日补零、升序。
 *
 * @param deps 面板依赖。
 * @param query `chatId` 来自路径；`days` 来自查询串（缺省 30，clamp 到 [7, 90]）。
 * @returns 200 序列；401 / 403 鉴权失败。
 */
export async function getPanelSeries(
  deps: PanelApiDeps,
  query: { chatId: string; days: string | null; initData: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const now = deps.now?.() ?? new Date()
  const days = clampSeriesDays(query.days)
  const today = utcDate(now)
  const start = utcDate(shiftUtcDays(now, -(days - 1)))

  const range = await deps.repos.aggregates.listRange(asChatId(query.chatId), start, today)
  const byDate = new Map(range.map((row) => [row.date, row]))

  // 从最早的日期顺着生成，读映射补零：调度器可能还没算今天，序列仍必须连续。
  const series = Array.from({ length: days }, (_, index) => {
    const date = utcDate(shiftUtcDays(now, index - (days - 1)))
    return { date, ...dailyCountsOf(byDate.get(date)) }
  })

  return { status: 200, body: { chatId: query.chatId, days: series } }
}

/**
 * 处置队列：跨群按 `(decidedAt, id)` 倒序分页。
 *
 * 分页用 `limit + 1` 探测是否还有下一页：多取一条即可精确给出 `nextBefore`，
 * 不会出现「恰好整页时多请求一次空页」。游标是复合的：只按时间会在同毫秒并列时漏条，
 * `id` 提供与排序键一致的全序。
 *
 * @param deps 面板依赖。
 * @param query 查询串参数；`action` 缺省为非放行，`before` + `beforeId` 是上一页给出的复合游标（必须成对）。
 * @returns 200 列表；400 参数非法；401 / 403 鉴权失败。
 */
export async function getPanelDecisions(
  deps: PanelApiDeps,
  query: {
    initData: string | null
    chatId: string | null
    action: string | null
    limit: string | null
    before: string | null
    beforeId: string | null
  },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const action = parseActionFilter(query.action)
  if (action === 'invalid') return invalidRequest([`action 取值非法：${String(query.action)}`])
  const cursor = parseBeforeCursor(query.before, query.beforeId)
  if (cursor === 'invalid') {
    return invalidRequest([`before 与 beforeId 必须成对给出且格式合法：before=${String(query.before)} beforeId=${String(query.beforeId)}`])
  }

  const limit = clampListLimit(query.limit)
  const rows = await deps.repos.decisions.listRecent({
    ...(query.chatId === null || query.chatId.length === 0 ? {} : { chatId: asChatId(query.chatId) }),
    ...(action === undefined ? {} : { action }),
    ...(cursor === undefined ? {} : { before: cursor }),
    limit: limit + 1,
  })

  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const [chats, samples] = await Promise.all([
    deps.repos.chats.listAll(),
    deps.repos.events.findSamples(items.map((decision) => decision.eventId)),
  ])
  const titles = new Map(chats.map((chat) => [String(chat.chatId), chat.title]))
  const last = items.at(-1)

  return {
    status: 200,
    body: {
      items: items.map((decision) => serializeDecision(decision, titles, samples)),
      nextBefore: hasMore && last !== undefined ? { decidedAt: last.decidedAt, id: last.id } : null,
    },
  }
}

/**
 * 申诉队列：按创建时间倒序，带原处置摘要与正文摘录。
 *
 * @param deps 面板依赖。
 * @param query 查询串参数；`state` 缺省为 `open`，`all` 表示全部状态。
 * @returns 200 列表；400 参数非法；401 / 403 鉴权失败。
 */
export async function getPanelAppeals(
  deps: PanelApiDeps,
  query: { initData: string | null; state: string | null; limit: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const state = parseStateFilter(query.state)
  if (state === 'invalid') return invalidRequest([`state 取值非法：${String(query.state)}`])

  const rows = await deps.repos.appeals.listByStateWithDecision(state, clampListLimit(query.limit))
  const [chats, samples] = await Promise.all([
    deps.repos.chats.listAll(),
    deps.repos.events.findSamples(rows.map(({ decision }) => decision.eventId)),
  ])
  const titles = new Map(chats.map((chat) => [String(chat.chatId), chat.title]))

  return {
    status: 200,
    body: {
      items: rows.map(({ appeal, decision }) => ({
        id: appeal.id,
        userId: appeal.userId,
        state: appeal.state,
        note: appeal.note,
        createdAt: appeal.createdAt,
        resolvedAt: appeal.resolvedAt,
        decision: {
          id: decision.id,
          action: decision.action.kind,
          actionUntil: decision.action.kind === 'mute' ? decision.action.until : null,
          score: decision.score,
          chatId: decision.chatId,
          chatTitle: titles.get(String(decision.chatId)) ?? String(decision.chatId),
          sampleText: samples.get(decision.eventId) ?? null,
        },
      })),
    },
  }
}

/** 结案请求体。`resolution` 直接映射到申诉终态。 */
const resolveAppealBodySchema = z.object({
  initData: z.string().min(1),
  resolution: z.enum(['upheld', 'overturned']),
})

/**
 * 网页内结案：复用 bot 侧的 {@link PanelApiDeps.resolveAppeal}（含撤销时的权限回滚）。
 *
 * @param deps 面板依赖。
 * @param input `appealId` 来自路径，`body` 为未解析的请求体。
 * @returns 200 结案结果（含 `rollbackFailed`）；400 请求体非法；401 / 403 鉴权失败；
 *   404 申诉或关联决策不存在；409 已被处理（含并发）。
 */
export async function resolvePanelAppeal(
  deps: PanelApiDeps,
  input: { appealId: string; body: unknown },
): Promise<ApiResponse> {
  const parsed = resolveAppealBodySchema.safeParse(input.body)
  if (!parsed.success) {
    return invalidRequest(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))
  }

  const auth = verifyOwner(deps, parsed.data.initData)
  if (!auth.ok) return auth.response

  // 非 uuid 无法与 `uuid` 列比较，按「不存在」处理（与 `api.ts` 的判据一致）。
  if (!UUID_PATTERN.test(input.appealId)) return { status: 404, body: { error: 'appeal_not_found' } }

  const outcome = parsed.data.resolution === 'overturned' ? 'overturn' : 'uphold'
  const resolution = await deps.resolveAppeal(input.appealId, outcome)

  switch (resolution.kind) {
    case 'resolved':
      return { status: 200, body: { state: parsed.data.resolution, rollbackFailed: resolution.rollbackFailed } }
    case 'already_resolved':
      return { status: 409, body: { error: 'appeal_resolved' } }
    case 'missing':
      return { status: 404, body: { error: 'appeal_not_found' } }
  }
}

/**
 * 读取某群的审核配置（面板「规则」页签的初始数据）。
 *
 * 响应就是 `ChatConfig` 本体（字段与 `packages/core` 一一对应）；PUT 的响应按契约把同一形状包在
 * `config` 键下，两处不要混淆。
 *
 * @param deps 面板依赖。
 * @param query `chatId` 来自路径，`initData` 来自查询串。
 * @returns 200 配置；401 / 403 鉴权失败；404 群未登记。
 */
export async function getPanelChatConfig(
  deps: PanelApiDeps,
  query: { chatId: string; initData: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const config = await deps.repos.chats.findByChatId(asChatId(query.chatId))
  if (config === null) return { status: 404, body: { error: 'chat_not_found' } }

  return { status: 200, body: config }
}

/** PUT 请求体的结构校验。语义校验（阈值、时长、逐条规则）在 {@link validateConfigData} 里给可读 details。 */
const chatConfigBodySchema = z.object({
  initData: z.string().min(1),
  config: z.object({
    passThreshold: z.number(),
    llmThreshold: z.number(),
    muteDurationMinutes: z.number(),
    rules: z.array(
      z.object({
        id: z.string().optional(),
        kind: z.string(),
        pattern: z.string(),
        score: z.number(),
        actionHint: z.string(),
        enabled: z.boolean(),
      }),
    ),
  }),
})

/**
 * 保存某群的审核配置：全量替换规则与阈值，保留 `title` / `language`。
 *
 * 为什么全量替换：面板持有整份配置，逐条 diff 需要版本号与并发协调；单 owner 场景下
 * 「最后写入胜」更简单，也让「保存后立即生效」的语义没有中间态（管线每条消息读配置）。
 *
 * 校验分两层：结构（类型、必需字段）由 zod 挡；语义与规则内容由 {@link validateConfigData}
 * 逐条给 details（指出第几条规则的哪个字段），与 README「规则编译失败在保存接口暴露」的口径一致。
 *
 * @param deps 面板依赖。
 * @param input `chatId` 来自路径，`body` 为未解析的请求体。
 * @returns 200 保存后的配置（含服务端分配的规则 id）；400 校验失败；401 / 403 鉴权失败；404 群未登记。
 */
export async function putPanelChatConfig(
  deps: PanelApiDeps,
  input: { chatId: string; body: unknown },
): Promise<ApiResponse> {
  const parsed = chatConfigBodySchema.safeParse(input.body)
  if (!parsed.success) {
    return invalidRequest(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))
  }

  const auth = verifyOwner(deps, parsed.data.initData)
  if (!auth.ok) return auth.response

  // 契约顺序：结构 → 鉴权 → 群存在 → 语义。未知群优先于语义校验（bad config 的未知群也是 404），
  // 也不会在校验上白花时间。
  const existing = await deps.repos.chats.findByChatId(asChatId(input.chatId))
  if (existing === null) return { status: 404, body: { error: 'chat_not_found' } }

  const validation = validateConfigData(parsed.data.config)
  if (validation.details.length > 0) return invalidRequest(validation.details)

  // 保留面板不管理的字段：群标题与语言（语言切换不在本批范围内）。
  const next: ChatConfig = {
    ...existing,
    rules: validation.rules,
    passThreshold: parsed.data.config.passThreshold,
    llmThreshold: parsed.data.config.llmThreshold,
    muteDurationMinutes: parsed.data.config.muteDurationMinutes,
  }
  await deps.repos.chats.upsert(next)

  return { status: 200, body: { config: next } }
}

/** 语义校验的输入形状（zod 解析后的 config 部分）。 */
interface ConfigData {
  passThreshold: number
  llmThreshold: number
  muteDurationMinutes: number
  rules: Array<{
    id?: string | undefined
    kind: string
    pattern: string
    score: number
    actionHint: string
    enabled: boolean
  }>
}

/** 语义校验结果：`details` 非空即拒绝；成功时 `rules` 是补齐 id 后的规则集。 */
interface ConfigValidation {
  details: string[]
  rules: Rule[]
}

/**
 * 逐项校验配置数据，错误按「第 N 条规则的哪个字段」归位。
 *
 * 校验口径与引擎一致而不是更宽：`regex` / `sender-name` 必须能按 `u` 标志编译（引擎就这么编译），
 * `custom-emoji` / `emoji-count` 的 pattern 是十进制最小计数（含安全整数检查）；`via-bot` 不使用
 * pattern，允许空串且保存时把非空输入归一为空串（其余 kind 仍要求非空）。
 * 不在保存边界挡住，坏规则写进去只会在运行时静默失效。
 *
 * @param data 解析后的 config。
 * @returns 错误清单（空即通过）与补齐 id 的规则集（仅通过时有意义）。
 */
function validateConfigData(data: ConfigData): ConfigValidation {
  const details: string[] = []
  const { passThreshold, llmThreshold, muteDurationMinutes, rules } = data

  if (!(Number.isFinite(passThreshold) && Number.isFinite(llmThreshold) && 0 <= passThreshold && passThreshold <= llmThreshold && llmThreshold <= 1)) {
    details.push('阈值：需要满足 0 ≤ passThreshold ≤ llmThreshold ≤ 1')
  }
  if (!Number.isInteger(muteDurationMinutes) || muteDurationMinutes < 1 || muteDurationMinutes > MAX_MUTE_DURATION_MINUTES) {
    details.push(`muteDurationMinutes：需要 1..${MAX_MUTE_DURATION_MINUTES} 的整数（分钟）`)
  }
  if (rules.length > MAX_RULES) details.push(`rules：至多 ${MAX_RULES} 条，收到 ${rules.length} 条`)

  // 第一遍：校验 + 收集显式 id（重复只在显式 id 之间判定；缺省 id 在通过后才分配）。
  const usedIds = new Set<string>()
  for (const [index, rule] of rules.entries()) {
    const position = index + 1

    if (!RULE_KINDS.has(rule.kind)) details.push(`第 ${position} 条规则 kind 非法：${rule.kind}`)

    if (rule.pattern.trim().length === 0 && rule.kind !== 'via-bot') {
      details.push(`第 ${position} 条规则 pattern 不能为空`)
    } else if (rule.kind === 'regex' || rule.kind === 'sender-name') {
      if (!compilesUnicodeRegex(rule.pattern)) details.push(`第 ${position} 条规则正则无法编译：${rule.pattern}`)
    } else if ((rule.kind === 'custom-emoji' || rule.kind === 'emoji-count') && !isCountPattern(rule.pattern)) {
      details.push(`第 ${position} 条规则 ${rule.kind} 的 pattern 需为十进制最小计数：${rule.pattern}`)
    }

    if (!(Number.isFinite(rule.score) && rule.score >= 0 && rule.score <= 1)) {
      details.push(`第 ${position} 条规则 score 需要 0..1：${rule.score}`)
    }
    if (!RULE_ACTIONS.has(rule.actionHint)) {
      details.push(`第 ${position} 条规则 actionHint 非法：${rule.actionHint}`)
    }

    const id = rule.id?.trim() ?? ''
    if (id.length > 0) {
      if (usedIds.has(id)) details.push(`第 ${position} 条规则 id 重复：${id}`)
      usedIds.add(id)
    }
  }

  if (details.length > 0) return { details, rules: [] }

  // 第二遍：分配缺省 id 并落成领域类型（kind/actionHint 已在上面的集合里校验过）。
  const assigned = rules.map((rule) => {
    const id = rule.id?.trim() ?? ''
    return {
      id: id.length > 0 ? id : allocateCustomRuleId(usedIds),
      kind: rule.kind as RuleKind,
      // `via-bot` 不使用 pattern：非空与纯空白输入一律归一为空串，落库形状与引擎、面板一致。
      pattern: rule.kind === 'via-bot' ? '' : rule.pattern,
      score: rule.score,
      actionHint: rule.actionHint as RuleAction,
      enabled: rule.enabled,
    }
  })

  return { details, rules: assigned }
}

/** 按引擎的方式编译规则正则（`u` 标志）。坏正则在引擎里是静默不命中，保存边界必须显式拒绝。 */
function compilesUnicodeRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u')
    return true
  } catch {
    return false
  }
}

/** 规则 id 单级熵内的分配重试上限；理论上不可达，防御的是随机源异常。 */
const ALLOCATE_ID_MAX_ATTEMPTS = 100

/**
 * 分配 `custom-<8位十六进制>` 形态的规则 id，并登记进已用集合。
 *
 * 先按 8 位十六进制（4 字节）重试最多 {@link ALLOCATE_ID_MAX_ATTEMPTS} 次；单次提交至多 100 条规则，
 * 正常随机源下连续撞满 100 次理论上不可达，真发生说明随机源异常，此时把熵扩到 16 位（8 字节）再试
 * 同样次数。两级都撞满才抛错——那是坏掉的随机源才会走到的路径，调用方按 500 处理。
 *
 * @param used 本次提交里已出现（或已分配）的 id 集合（会被就地更新）。
 * @returns 未占用过的 id。
 */
function allocateCustomRuleId(used: Set<string>): string {
  for (const bytes of [4, 8] as const) {
    for (let attempt = 0; attempt < ALLOCATE_ID_MAX_ATTEMPTS; attempt += 1) {
      const candidate = `custom-${randomBytes(bytes).toString('hex')}`
      if (!used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }
  }
  throw new Error('规则 id 分配失败：随机源连续给出重复值')
}

/**
 * 验签并判定 owner。
 *
 * 401 与 403 分开：401 的前端动作是「重新从 Telegram 打开」（凭据无效/过期），
 * 403 是「仅管理员可用」（凭据有效但身份不对）。
 *
 * @param deps 面板依赖。
 * @param initData 原始 initData（可能为 `null`）。
 * @returns 通过时 `{ ok: true }`；失败时给出响应。
 */
function verifyOwner(deps: PanelApiDeps, initData: string | null): { ok: true } | { ok: false; response: ApiResponse } {
  if (initData === null || initData.length === 0) {
    return { ok: false, response: { status: 401, body: { error: 'init_data_invalid' } } }
  }

  const verified = verifyInitData(initData, { botToken: deps.botToken, now: deps.now?.() })
  if (!verified.ok) {
    deps.logger.warn(`面板 initData 验签失败：${verified.reason}`)
    return { ok: false, response: { status: 401, body: { error: 'init_data_invalid' } } }
  }

  if (verified.data.userId !== deps.ownerUserId) {
    return { ok: false, response: { status: 403, body: { error: 'forbidden' } } }
  }

  return { ok: true }
}

/**
 * 解析处置档位过滤。
 *
 * @param raw 查询串里的 `action`。
 * @returns 缺省（含空串）为 `undefined`（非放行）；`'all'`；具体档位；非法字面量返回 `'invalid'`。
 */
function parseActionFilter(raw: string | null): RuleAction | 'all' | undefined | 'invalid' {
  if (raw === null || raw.length === 0) return undefined
  if (raw === 'all') return 'all'
  if (ACTION_FILTERS.has(raw)) return raw as RuleAction
  return 'invalid'
}

/**
 * 解析申诉状态过滤。
 *
 * @param raw 查询串里的 `state`。
 * @returns 缺省（含空串）为 `'open'`；`'all'` 为 `null`；非法字面量返回 `'invalid'`。
 */
function parseStateFilter(raw: string | null): AppealState | null | 'invalid' {
  if (raw === null || raw.length === 0) return 'open'
  if (raw === 'all') return null
  if (APPEAL_STATES.has(raw)) return raw as AppealState
  return 'invalid'
}

/**
 * 解析复合分页游标。
 *
 * 游标是 `(decidedAt, id)`：同毫秒并列的记录靠 `id` 保持全序，单给时间会漏条。
 * 因此两者要么都给、要么都不给；缺一或格式非法都按 400 处理，不猜调用方的意图。
 *
 * @param rawBefore 查询串里的 `before`（ISO 8601）。
 * @param rawBeforeId 查询串里的 `beforeId`（uuid）。
 * @returns 两者都缺时为 `undefined`；合法时为游标对象；缺一或格式非法返回 `'invalid'`。
 */
function parseBeforeCursor(
  rawBefore: string | null,
  rawBeforeId: string | null,
): { decidedAt: Date; id: string } | undefined | 'invalid' {
  const hasBefore = rawBefore !== null && rawBefore.length > 0
  const hasBeforeId = rawBeforeId !== null && rawBeforeId.length > 0
  if (!hasBefore && !hasBeforeId) return undefined
  if (!hasBefore || !hasBeforeId) return 'invalid'

  const decidedAt = new Date(rawBefore)
  if (Number.isNaN(decidedAt.getTime())) return 'invalid'
  // 非 uuid 与 `uuid` 列比较会让 Postgres 报错，先挡在应用层（与决策 id 同一判据）。
  if (!UUID_PATTERN.test(rawBeforeId)) return 'invalid'

  return { decidedAt, id: rawBeforeId }
}

/**
 * clamp 页大小。
 *
 * @param raw 查询串里的 `limit`。
 * @returns 缺省与非数字为默认值 50，其余夹到 [1, 100]。
 */
function clampListLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIST_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, parsed))
}

/**
 * clamp 报表窗口天数。
 *
 * @param raw 查询串里的 `days`。
 * @returns 缺省与非数字为默认值 30，其余夹到 [7, 90]。
 */
function clampSeriesDays(raw: string | null): number {
  if (raw === null) return DEFAULT_SERIES_DAYS
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return DEFAULT_SERIES_DAYS
  return Math.min(MAX_SERIES_DAYS, Math.max(MIN_SERIES_DAYS, parsed))
}

/** 400 响应里 `details` 的条数上限；超出时截断并追加一行汇总，避免把整份请求体回显给前端。 */
const MAX_DETAILS = 50

/** 400 响应。字段错误清单与 `api.ts` 的 `invalid_request` 同形，超过上限时截断并汇总。 */
function invalidRequest(details: string[]): ApiResponse {
  if (details.length <= MAX_DETAILS) return { status: 400, body: { error: 'invalid_request', details } }

  const kept = details.slice(0, MAX_DETAILS)
  return {
    status: 400,
    body: {
      error: 'invalid_request',
      details: [...kept, `…等 ${details.length - MAX_DETAILS} 条其他错误`],
    },
  }
}

/** UTC 切日的 `YYYY-MM-DD`。 */
function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

/** 在 UTC 轴上平移天数。跨月与夏令时都不影响：只加固定毫秒数并仍按 UTC 取日期。 */
function shiftUtcDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS)
}

/** 聚合行 → 领域计数；缺失行为零。 */
function dailyCountsOf(row: DailyAggregate | undefined): DailyCounts {
  if (row === undefined) return { ...ZERO_COUNTS }
  return {
    messageCount: row.messageCount,
    actionCount: row.actionCount,
    appealCount: row.appealCount,
    overturnedCount: row.overturnedCount,
  }
}

/** 计数逐项求和。 */
function sumDailyCounts(rows: readonly DailyCounts[]): DailyCounts {
  const total = { ...ZERO_COUNTS }
  for (const row of rows) {
    total.messageCount += row.messageCount
    total.actionCount += row.actionCount
    total.appealCount += row.appealCount
    total.overturnedCount += row.overturnedCount
  }
  return total
}

/** 处置的对外序列化。字段表见 README 的 panel 端点说明。 */
function serializeDecision(
  decision: ModerationDecision,
  titles: ReadonlyMap<string, string>,
  samples: ReadonlyMap<string, string | null>,
): Record<string, unknown> {
  const llm = decision.signals.find((signal): signal is LlmSignal => signal.kind === 'llm')

  return {
    id: decision.id,
    chatId: decision.chatId,
    chatTitle: titles.get(String(decision.chatId)) ?? String(decision.chatId),
    userId: decision.userId,
    action: decision.action.kind,
    actionUntil: decision.action.kind === 'mute' ? decision.action.until : null,
    score: decision.score,
    executed: decision.executed,
    decidedAt: decision.decidedAt,
    ruleIds: decision.signals.flatMap((signal) => (signal.kind === 'rule-hit' ? [signal.ruleId] : [])),
    llm: llm === undefined ? null : { verdict: llm.verdict, confidence: llm.confidence },
    sampleText: samples.get(decision.eventId) ?? null,
  }
}
