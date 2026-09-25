/**
 * 申诉接口与 owner 面板接口（/api/panel/*）的客户端。initData 是 Telegram 签发的身份凭据：
 * GET 没有请求体，放在 query；POST 放在 body。后端两种携带方式都认。
 *
 * 错误分六类，UI 按类决定显示哪一屏：
 * - NotFoundError：404，记录不存在（申诉/决策/群找不到，或不属于当前账号），不可重试；
 * - ConflictError：409，申诉已结案（重复提交或并发处理），调用方应重新拉取展示既有状态；
 * - AuthError：401，凭据缺失/验签不过/过期，提示重新从 Telegram 进入；
 * - ForbiddenError：403，已验签但非 owner，仅面板接口会返回；
 * - InvalidRequestError：400，配置保存校验未通过，details 逐条指位（仅保存配置会返回）；
 * - 其余（网络失败、5xx、异常响应）：可重试。
 */

export type DecisionAction = 'warn' | 'delete' | 'mute' | 'ban'

export interface DecisionDto {
  id: string
  action: DecisionAction
  chatTitle: string
  createdAt: string
  sampleText: string
}

export type AppealStateDto = 'open' | 'upheld' | 'overturned'

export interface AppealDto {
  id: string
  state: AppealStateDto
  reason: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface AppealView {
  decision: DecisionDto
  appeal: AppealDto | null
}

export class NotFoundError extends Error {
  constructor() {
    super('记录不存在')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor() {
    super('已提交过申诉')
    this.name = 'ConflictError'
  }
}

/** 401：initData 缺失、验签不过或已过期。与网络故障分开归类，UI 才能给出「重新进入」而不是「检查网络」的提示。 */
export class AuthError extends Error {
  constructor() {
    super('身份验证失败')
    this.name = 'AuthError'
  }
}

/** 403：已验签但非 owner。只出现在面板接口；与 401 分开，因为重进 Telegram 也解决不了，要换账号。 */
export class ForbiddenError extends Error {
  constructor() {
    super('仅管理员可用')
    this.name = 'ForbiddenError'
  }
}

/** 400：配置保存校验未通过。details 逐条指出第几条规则的哪个字段，UI 原样列出。 */
export class InvalidRequestError extends Error {
  readonly details: string[]

  constructor(details: string[]) {
    super('配置校验未通过')
    this.name = 'InvalidRequestError'
    this.details = details
  }
}

/** 把非 2xx 响应映射成上面的错误类型；永远抛错。 */
function throwForStatus(res: Response): never {
  if (res.status === 404) throw new NotFoundError()
  if (res.status === 409) throw new ConflictError()
  if (res.status === 401) throw new AuthError()
  if (res.status === 403) throw new ForbiddenError()
  throw new Error(`请求失败（HTTP ${res.status}）`)
}

export async function fetchAppeal(decisionId: string, initData: string): Promise<AppealView> {
  const url = `/api/appeals/${encodeURIComponent(decisionId)}?initData=${encodeURIComponent(initData)}`
  const res = await fetch(url)
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as AppealView
}

export async function submitAppeal(
  decisionId: string,
  initData: string,
  reason: string,
): Promise<AppealDto> {
  const res = await fetch('/api/appeals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, decisionId, reason }),
  })
  if (!res.ok) throwForStatus(res)
  const body = (await res.json()) as { appeal: AppealDto }
  return body.appeal
}

/* ---- 面板接口（/api/panel/*，owner 专属；契约见 phase2-spec §2） ---- */

/** 四计数：消息 / 处置 / 申诉 / 撤销。概览与趋势共用同一形状。 */
export interface DailyCountsDto {
  messageCount: number
  actionCount: number
  appealCount: number
  overturnedCount: number
}

export interface PanelChatDto {
  chatId: string
  title: string
  today: DailyCountsDto
  last7d: DailyCountsDto
  openAppeals: number
}

export interface PanelOverviewDto {
  totals: { today: DailyCountsDto; last7d: DailyCountsDto }
  chats: PanelChatDto[]
  serverTime: string
}

/** 趋势序列的一天。date 为 'YYYY-MM-DD'，后端保证升序且连续（缺失日补零）。 */
export interface PanelSeriesPointDto extends DailyCountsDto {
  date: string
}

export interface PanelSeriesDto {
  chatId: string
  days: PanelSeriesPointDto[]
}

/** 面板里的决策动作比申诉视图多一档 pass：处置流筛选「全部动作」时会出现放行记录。 */
export type PanelDecisionAction = DecisionAction | 'pass'

export interface PanelDecisionDto {
  id: string
  chatId: string
  chatTitle: string
  userId: number
  action: PanelDecisionAction
  /** 禁言的解禁时刻；其余动作或永久处置为 null。 */
  actionUntil: string | null
  score: number
  executed: boolean
  decidedAt: string
  ruleIds: string[]
  llm: { verdict: string; confidence: number } | null
  sampleText: string | null
}

/** 处置流的复合分页游标：`(decidedAt, id)`。同毫秒并列的记录靠 `id` 保持全序，缺一会漏条。 */
export interface PanelDecisionCursor {
  decidedAt: string
  id: string
}

export interface PanelDecisionPage {
  items: PanelDecisionDto[]
  /** 还有更多时为最后一条的复合游标，原样回传 `before` 翻页（两个查询参数成对携带）。 */
  nextBefore: PanelDecisionCursor | null
}

export interface PanelDecisionFilter {
  chatId?: string
  /** 省略为「仅非放行」；'all' 含放行；具体档位只看该动作。 */
  action?: 'all' | DecisionAction
  before?: PanelDecisionCursor
  limit?: number
}

export type PanelAppealStateFilter = AppealStateDto | 'all'

export interface PanelAppealDto {
  id: string
  userId: number
  state: AppealStateDto
  /** 申诉理由。 */
  note: string
  createdAt: string
  resolvedAt: string | null
  decision: {
    id: string
    action: PanelDecisionAction
    actionUntil: string | null
    score: number
    chatId: string
    chatTitle: string
    sampleText: string | null
  }
}

export type PanelResolution = 'upheld' | 'overturned'

export interface PanelResolveResult {
  state: 'upheld' | 'overturned'
  /** true 表示已结案但回滚权限失败，需要人工解禁/解封。 */
  rollbackFailed: boolean
}

/** 面板接口的查询串：initData 必带，其余参数只在有值时携带，保持请求形状干净便于排查。 */
function panelQuery(initData: string, extra: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  params.set('initData', initData)
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

export async function fetchPanelOverview(initData: string): Promise<PanelOverviewDto> {
  const res = await fetch(`/api/panel/overview?${panelQuery(initData, {})}`)
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as PanelOverviewDto
}

export async function fetchPanelSeries(
  chatId: string,
  days: number,
  initData: string,
): Promise<PanelSeriesDto> {
  const res = await fetch(
    `/api/panel/chats/${encodeURIComponent(chatId)}/series?${panelQuery(initData, { days })}`,
  )
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as PanelSeriesDto
}

export async function fetchPanelDecisions(
  initData: string,
  filter: PanelDecisionFilter = {},
): Promise<PanelDecisionPage> {
  const query = panelQuery(initData, {
    chatId: filter.chatId,
    action: filter.action,
    limit: filter.limit,
    // 复合游标拆成两个参数：后端要求成对出现，缺一即 400。
    before: filter.before?.decidedAt,
    beforeId: filter.before?.id,
  })
  const res = await fetch(`/api/panel/decisions?${query}`)
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as PanelDecisionPage
}

export async function fetchPanelAppeals(
  initData: string,
  state: PanelAppealStateFilter = 'open',
  limit = 50,
): Promise<PanelAppealDto[]> {
  const res = await fetch(`/api/panel/appeals?${panelQuery(initData, { state, limit })}`)
  if (!res.ok) throwForStatus(res)
  const body = (await res.json()) as { items: PanelAppealDto[] }
  return body.items
}

export async function resolvePanelAppeal(
  appealId: string,
  initData: string,
  resolution: PanelResolution,
): Promise<PanelResolveResult> {
  const res = await fetch(`/api/panel/appeals/${encodeURIComponent(appealId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, resolution }),
  })
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as PanelResolveResult
}

/* ---- 规则/阈值配置（phase2b-spec §1；保存后立即生效） ---- */

export type PanelRuleKind =
  | 'keyword'
  | 'regex'
  | 'link-domain'
  | 'sender-name'
  | 'custom-emoji'
  | 'emoji-count'
  | 'via-bot'

export interface PanelRuleDto {
  /** 新增规则传空串，由服务端分配 `custom-<8位十六进制>`。 */
  id: string
  kind: PanelRuleKind
  pattern: string
  score: number
  actionHint: PanelDecisionAction
  enabled: boolean
}

export interface PanelConfigDto {
  chatId: string
  title: string
  language: string
  passThreshold: number
  llmThreshold: number
  muteDurationMinutes: number
  rules: PanelRuleDto[]
}

/** PUT 请求体的 config：阈值与规则全量替换；chatId/title/language 由服务端保留，不在 body 里。 */
export interface PanelConfigInput {
  passThreshold: number
  llmThreshold: number
  muteDurationMinutes: number
  rules: PanelRuleDto[]
}

export async function fetchPanelConfig(chatId: string, initData: string): Promise<PanelConfigDto> {
  const res = await fetch(
    `/api/panel/chats/${encodeURIComponent(chatId)}/config?${panelQuery(initData, {})}`,
  )
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as PanelConfigDto
}

export async function savePanelConfig(
  chatId: string,
  initData: string,
  config: PanelConfigInput,
): Promise<PanelConfigDto> {
  const res = await fetch(`/api/panel/chats/${encodeURIComponent(chatId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, config }),
  })
  if (res.status === 400) {
    // 只有 error 为 invalid_request 的 400 才是配置校验错误，details 逐条带到 UI；
    // 其他 400（代理、网关等）按通用错误处理，不误分为校验失败。
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; details?: unknown }
    if (body.error === 'invalid_request') {
      const details = Array.isArray(body.details)
        ? body.details.filter((d): d is string => typeof d === 'string')
        : []
      throw new InvalidRequestError(details)
    }
  }
  if (!res.ok) throwForStatus(res)
  const body = (await res.json()) as { config: PanelConfigDto }
  return body.config
}
