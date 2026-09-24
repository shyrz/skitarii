import {
  asChatId,
  type AppealState,
  type DailyAggregate,
  type ModerationDecision,
  type RuleAction,
  type Signal,
  type UserId,
} from '@skitarii/core'
import type { AppealResolution, Logger } from '@skitarii/bot'
import type { Repos } from '@skitarii/db'
import { z } from 'zod'
import type { ApiResponse } from './api.js'
import { verifyInitData } from './init-data.js'

/**
 * Mini App 面板 API（owner 专属）：跨群概览、报表序列、处置队列、申诉队列与网页内结案。
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

/** 400 响应。字段错误清单与 `api.ts` 的 `invalid_request` 同形。 */
function invalidRequest(details: string[]): ApiResponse {
  return { status: 400, body: { error: 'invalid_request', details } }
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
