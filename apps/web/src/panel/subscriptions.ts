/**
 * 订阅页签的展示与交互口径（phase3b-spec §5、§7）。
 *
 * 这里只放可脱离 DOM 验证的纯逻辑：状态文案、到期观测文案、可见性提示、
 * 创建意图（requestId 复用/封禁）与失败提示映射。组件负责把它们接进界面，
 * 测试直接断言这些函数，避免用文字描述代替行为约束。
 */

import type {
  ChannelVisibility,
  SubscriptionLinkDto,
  SubscriptionLinkState,
  SubscriptionMemberCountsDto,
  SubscriptionMemberState,
} from '../api.js'
import {
  AuthError,
  ForbiddenError,
  NotFoundError,
  SubscriptionApiError,
} from '../api.js'
import { formatTime } from './util.js'

/** 服务端固定周期：仅 channel、2592000 秒。UI 只展示，不提供编辑入口。 */
export const PERIOD_LABEL = '每 30 天'

export function formatPriceLine(priceStars: number): string {
  return `${PERIOD_LABEL}，${priceStars} Stars`
}

/** 链接名称允许空串，展示时给一个明确的占位，不凭空编造名称。 */
export function linkDisplayName(name: string): string {
  return name === '' ? '（未命名）' : name
}

export const LINK_STATE_LABEL: Record<SubscriptionLinkState, string> = {
  creating: '创建中',
  active: '有效',
  revoked: '已撤销',
  create_unknown: '结果不确定',
  create_failed: '创建被拒',
}

export const LINK_STATE_TONE: Record<SubscriptionLinkState, string> = {
  creating: 'var(--tone-notice)',
  active: 'var(--tone-success)',
  revoked: 'var(--tone-caution)',
  create_unknown: 'var(--tone-danger)',
  create_failed: 'var(--tone-caution)',
}

/** 非 active 链接的行内处理提示；active 返回 null。措辞不承诺在途操作的结果。 */
export function linkStateNotice(state: SubscriptionLinkState): string | null {
  switch (state) {
    case 'creating':
      return '创建请求占位中：结果未确认前不会重复调用 Telegram。若长时间停留在这个状态，请刷新并到频道邀请链接里人工核查。'
    case 'create_unknown':
      return '结果不确定：Telegram 可能已经创建了这条链接，但本地没有确认。请先到频道邀请链接里人工核查，不要直接重复创建；确认后再人工处理。'
    case 'create_failed':
      return 'Telegram 明确拒绝了这个创建请求，不会自动重试。如需创建，请调整名称或价格后重新发起。'
    case 'revoked':
      return '已撤销：这条链接停止新的加入；已有订阅和续订如何变化以 Telegram 为准。'
    default:
      return null
  }
}

/* ---- 成员台账展示 ---- */

export const MEMBER_STATE_LABEL: Record<SubscriptionMemberState, string> = {
  member: '最近观测仍在频道',
  left: '已观测离开',
  unknown: '状态未知',
}

export const MEMBER_STATE_TONE: Record<SubscriptionMemberState, string> = {
  member: 'var(--tone-success)',
  left: 'var(--tone-caution)',
  unknown: 'var(--tone-danger)',
}

/**
 * counts 卡片文案。`member` 是「最后一次观测仍在频道」，
 * 不是付费会员总数，也不能当作到账或收入依据。
 */
export const COUNT_CARDS: { key: keyof SubscriptionMemberCountsDto; label: string; tone: string }[] =
  [
    { key: 'known', label: '台账成员合计', tone: 'var(--tone-notice)' },
    { key: 'member', label: '仍在频道（最近观测）', tone: 'var(--tone-success)' },
    { key: 'left', label: '已观测离开', tone: 'var(--tone-caution)' },
    { key: 'unknown', label: '状态未知', tone: 'var(--tone-danger)' },
  ]

export interface ExpiryObservation {
  kind: 'unknown' | 'past' | 'future'
  text: string
}

/**
 * 到期观测值展示。字段缺失不代表无限期、也不代表付款失效，只能显示“未知”；
 * 过去时间只表示到了观测期限、等待核实，不能据此推导退出或取消。
 */
export function expiryObservation(expiresAt: string | null, now: Date): ExpiryObservation {
  if (expiresAt === null) {
    return { kind: 'unknown', text: '未知（未观测到订阅到期时间）' }
  }
  const time = new Date(expiresAt).getTime()
  if (Number.isNaN(time)) {
    return { kind: 'unknown', text: '未知（到期时间无法解析）' }
  }
  if (time <= now.getTime()) {
    return { kind: 'past', text: `已到观测期限（${formatTime(expiresAt)}），等待核实` }
  }
  return { kind: 'future', text: formatTime(expiresAt) }
}

/** 成员的可关联链接：没有 id 说明本次加入未匹配到自建链接，不猜来源。 */
export function memberLinkLabel(linkId: string | null, names: ReadonlyMap<string, string>): string {
  if (linkId === null) return '未关联（本次加入未匹配到本 Bot 创建的付费链接）'
  return names.get(linkId) ?? `链接 ID ${linkId}（不在当前已加载列表）`
}

/* ---- 频道可见性提示 ---- */

export const VISIBILITY_LABEL: Record<ChannelVisibility, string> = {
  public: '公开',
  private: '私有',
  unknown: '尚未确认',
}

/** 公开频道必须提示免费直入；unknown 明确说明未确认，不把未知当私有。 */
export function visibilityNotice(
  visibility: ChannelVisibility,
): { tone: string; text: string } | null {
  if (visibility === 'public') {
    return {
      tone: 'var(--tone-caution)',
      text: '这是公开频道：任何人拿到频道链接都能免费直接加入，付费邀请链接不会阻止免费加入。',
    }
  }
  if (visibility === 'unknown') {
    return {
      tone: 'var(--tone-notice)',
      text: '尚未确认频道公开性：本次频道信息或权限读取失败；台账数据仍然显示，请刷新详情后再判断。',
    }
  }
  return null
}

/** 成员区固定说明。非实时观测台账，不代替 Telegram 的订阅管理。 */
export const OBSERVATION_DISCLAIMER =
  '仅展示 Bot 已观测的订阅相关成员，数据非实时；Telegram 管理订阅访问，时间到期不代表本台账已确认退出。'

/* ---- 确认文案（三种二次确认） ---- */

export function createConfirmText(channelTitle: string, name: string, priceStars: number): string {
  return `确认在频道「${channelTitle}」创建订阅链接？名称「${linkDisplayName(
    name,
  )}」；${formatPriceLine(priceStars)}。创建后价格与周期不能修改；公开频道的付费链接不会阻止免费直接加入。`
}

export function renameConfirmText(oldName: string, newName: string): string {
  return `确认把链接名称从「${linkDisplayName(oldName)}」改为「${linkDisplayName(
    newName,
  )}」？价格与周期不可修改。`
}

/**
 * 撤销确认：只承诺「停止此链接的新加入」，对已有订阅/续订不承诺任何结果，也不提退款。
 * 统一口径见 review 要求，勿再加回「不改变/不影响已有订阅」「不会取消已生效订阅」之类表述。
 */
export const REVOKE_CONFIRM_TEXT =
  '确认撤销这条邀请链接？撤销后立即停止此链接的新加入；已有订阅和续订如何变化以 Telegram 为准。'

export const REVOKE_SUCCESS_TEXT =
  '链接已撤销：停止此链接的新加入；已有订阅和续订如何变化以 Telegram 为准。'

export const RENAME_SUCCESS_TEXT = '链接名称已更新；价格与周期未变。'

export const CREATE_SUCCESS_TEXT = '订阅链接已创建。'

export const CREATE_REPLAY_TEXT = '这是此前同一请求的既有结果，直接展示，没有重复创建。'

export const CREATE_BLOCKED_NOTICE =
  '上一个创建请求结果不确定。请先到频道邀请链接里核查；确认没有产生新链接后，点「放弃不确定请求」再重新创建。'

export const DISCARDED_INTENT_NOTICE =
  '已放弃该请求。请先自行核查频道邀请链接，确认没有产生新链接后再发起新的创建。'

export const INTENT_STORAGE_DEGRADED_NOTICE =
  '浏览器存储不可用：这次创建意图无法跨刷新保留。请在同一页面内用同一请求重试，不要重复创建。'

export type NoticeTone = 'success' | 'caution' | 'danger'

export interface OperationNotice {
  tone: NoticeTone
  text: string
}

export const DISCARD_UNCERTAIN_CONFIRM_TEXT =
  '确认放弃这个结果不确定的创建请求？请先在 Telegram 频道的邀请链接里人工核查，确认没有产生新链接后再放弃；放弃后才能发起全新的创建请求。'

/* ---- 创建草稿校验 ---- */

export type CreateDraftValidation =
  | { ok: true; priceStars: number }
  | { ok: false; message: string }

/** 名称按 Unicode code point 计长（与后端一致），价格严格整数 1..10000。 */
export function validateCreateDraft(name: string, priceText: string): CreateDraftValidation {
  const nameLength = [...name].length
  if (nameLength > 32) {
    return { ok: false, message: `名称最多 32 个字符（当前 ${nameLength} 个）。` }
  }
  const priceStars = Number(priceText)
  if (
    priceText.trim() === '' ||
    !Number.isInteger(priceStars) ||
    priceStars < 1 ||
    priceStars > 10_000
  ) {
    return { ok: false, message: '价格必须是 1..10000 的整数 Stars。' }
  }
  return { ok: true, priceStars }
}

/* ---- 创建意图：requestId 复用与结果不确定封禁 ---- */

export interface CreatePayload {
  chatId: string
  name: string
  priceStars: number
}

export interface CreateIntent {
  requestId: string
  payload: CreatePayload
  /** 结果不确定：只能复用原 requestId 重试，禁止自动换新 id 再建。 */
  uncertain: boolean
}

export type CreateIntentDecision =
  | { kind: 'new'; intent: CreateIntent }
  | { kind: 'reuse'; intent: CreateIntent }
  | { kind: 'blocked'; intent: CreateIntent }

export function sameCreatePayload(a: CreatePayload, b: CreatePayload): boolean {
  return a.chatId === b.chatId && a.name === b.name && a.priceStars === b.priceStars
}

/**
 * 提交创建时的意图判定：
 * - 与上一次完全相同的参数 → 复用原 requestId（网络失败后重试不换 id）；
 * - 上次结果不确定且参数已变化 → 阻止，先让用户核查并显式放弃；
 * - 其余情况（首次、或上次已有明确结果）→ 生成新 requestId。
 */
export function decideCreateIntent(
  previous: CreateIntent | null,
  payload: CreatePayload,
  generateRequestId: () => string,
): CreateIntentDecision {
  if (previous !== null && sameCreatePayload(previous.payload, payload)) {
    return { kind: 'reuse', intent: previous }
  }
  if (previous !== null && previous.uncertain) {
    return { kind: 'blocked', intent: previous }
  }
  return { kind: 'new', intent: { requestId: generateRequestId(), payload, uncertain: false } }
}

export function markCreateUncertain(intent: CreateIntent): CreateIntent {
  return intent.uncertain ? intent : { ...intent, uncertain: true }
}

/** 生成创建请求的 requestId：优先原生 UUID，非安全上下文（HTTP 调试）退回 RFC 4122 v4 形态。 */
export function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (char) => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

/* ---- 失败提示映射 ---- */

export type SubscriptionAction = 'create' | 'rename' | 'revoke'

export interface OperationFailureNotice {
  message: string
  /** 结果不确定：禁止自动换 requestId 再建。 */
  uncertain: boolean
  /** 保留原创建意图，允许同 requestId 重试。 */
  retainIntent: boolean
  /** 服务端状态可能已变化，建议刷新链接首页与 counts。 */
  refresh: boolean
}

const UNCERTAIN_MESSAGE: Record<SubscriptionAction, string> = {
  create:
    '结果不确定：Telegram 可能已经创建了链接，但本地没有确认。请先到频道的邀请链接里人工核查；用同一请求重试是安全的（不会重复创建），确认没有新链接后再放弃该请求。',
  rename:
    '结果不确定：Telegram 可能已经接受了改名，但本地没有确认。请刷新链接列表核对；用同一请求重试设置同名可以接受。',
  revoke:
    '结果不确定：Telegram 可能已经撤销了链接，但本地没有确认。请刷新页面并在频道内核查后决定是否重试；已有订阅和续订如何变化以 Telegram 为准。',
}

/** 502 telegram_failed 的按操作文案：不承诺撤销/改名的实际影响，只说明需要核查与重试口径。 */
const TELEGRAM_FAILED_MESSAGE: Record<SubscriptionAction, string> = {
  create:
    'Telegram 调用失败，结果未确认。请刷新链接列表核对后再决定是否重试；用同一请求重试不会重复创建。',
  rename:
    'Telegram 调用失败，改名结果未确认。请刷新链接列表核对；用同一请求重试设置同名可以接受。',
  revoke:
    'Telegram 调用失败，撤销结果未确认。请刷新页面并在频道内核查后决定是否重试；已有订阅和续订如何变化以 Telegram 为准。',
}

/** 把操作失败映射成频道内提示；401/403 owner 鉴权应由 onFatal 提前接管。 */
export function operationFailureNotice(error: unknown, action: SubscriptionAction): OperationFailureNotice {
  if (error instanceof SubscriptionApiError) {
    switch (error.code) {
      case 'bot_permission_required':
        return {
          message:
            '机器人在这条频道没有管理邀请链接的权限（需要是管理员且具备「邀请用户」权限）。请在 Telegram 调整权限后重试；台账数据不受影响。',
          uncertain: false,
          retainIntent: true,
          refresh: false,
        }
      case 'create_outcome_unknown':
      case 'telegram_outcome_unknown':
      case 'persistence_after_telegram_failed':
        return { message: UNCERTAIN_MESSAGE[action], uncertain: true, retainIntent: true, refresh: true }
      case 'request_conflict':
        return {
          message:
            '这个 requestId 已用于参数不同的请求，为避免重复创建已被拒绝。请刷新链接列表核对，确认后放弃原请求再重新发起。',
          uncertain: false,
          retainIntent: true,
          refresh: true,
        }
      case 'operation_in_progress':
        return {
          message: '这条链接正有一个操作在进行，请稍后重试。',
          uncertain: false,
          retainIntent: true,
          refresh: true,
        }
      case 'link_revoked':
        return {
          message: '这条链接已经撤销，不能再改名或重复撤销；请刷新列表核对。',
          uncertain: false,
          retainIntent: false,
          refresh: true,
        }
      case 'version_conflict':
        return {
          message: '链接状态已经变化（可能被其他操作更新），请刷新后重试。',
          uncertain: false,
          retainIntent: true,
          refresh: true,
        }
      case 'create_failed':
        return {
          message: 'Telegram 明确拒绝了这个创建请求，不会自动重试。请调整名称或价格后重新发起。',
          uncertain: false,
          retainIntent: false,
          refresh: false,
        }
      case 'telegram_failed':
        return {
          message: TELEGRAM_FAILED_MESSAGE[action],
          uncertain: action === 'create',
          retainIntent: action === 'create',
          refresh: true,
        }
      case 'channel_not_found':
      case 'link_not_found':
        return {
          message: '频道或链接不存在（可能已不在本面板范围），请刷新。',
          uncertain: false,
          retainIntent: false,
          refresh: true,
        }
      case 'invalid_request':
      case 'invalid_cursor':
      case 'channel_required':
        return { message: error.message, uncertain: false, retainIntent: false, refresh: false }
      default:
        return {
          message: error.message,
          uncertain: false,
          retainIntent: true,
          refresh: error.status >= 500,
        }
    }
  }
  if (error instanceof NotFoundError) {
    return { message: '频道或链接不存在（可能已不在本面板范围），请刷新。', uncertain: false, retainIntent: false, refresh: true }
  }
  if (error instanceof ForbiddenError) {
    return { message: '仅管理员可用。', uncertain: false, retainIntent: false, refresh: false }
  }
  if (error instanceof AuthError) {
    return {
      message: '身份验证失败，请回到 Telegram 重新打开面板。',
      uncertain: false,
      retainIntent: false,
      refresh: false,
    }
  }
  // 网络错误等未知失败：请求可能已经到达 Telegram，按结果不确定处理
  return { message: UNCERTAIN_MESSAGE[action], uncertain: true, retainIntent: true, refresh: true }
}

/* ---- 复制（仅用户点击触发） ---- */

/** 复制链接文本。失败返回 false，由 UI 回退到可选中的文本，不吞掉原因也不上报内容。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 供组件按 linkId 查找名称；独立导出便于测试。 */
export function indexLinkNames(links: SubscriptionLinkDto[]): Map<string, string> {
  return new Map(links.map((link) => [link.id, linkDisplayName(link.name)]))
}

/* ---- 创建意图的跨刷新持久化（sessionStorage；仅 UI 隔离，不参与鉴权） ---- */

const INTENT_STORAGE_VERSION = 1

/** requestId 只认 UUID 形态，脏值一律丢弃，避免把错误 id 发回服务端。 */
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** sessionStorage 的最小接口；测试注入 Map 替身即可，不依赖 DOM。 */
export interface IntentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 浏览器环境的 sessionStorage；不可用（隐私模式、非浏览器）时返回 null。 */
export function browserIntentStorage(): IntentStorage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

/**
 * 存储作用域：优先用 Telegram 提供、本端未验签的 user id 做隔离，取不到时退回 anon。
 * 它只区分「这个浏览器会话下哪个用户在看」，不授予任何权限；服务端仍独立验签与鉴权。
 */
export function resolveIntentScope(userId: number | null | undefined): string {
  if (userId !== null && userId !== undefined && Number.isSafeInteger(userId) && userId > 0) {
    return `u${userId}`
  }
  return 'anon'
}

export function createIntentStorageKey(scope: string, chatId: string): string {
  return `skitarii.subscription-intent.v1.${scope}.${chatId}`
}

/**
 * 解析并校验存储值；格式不对返回 null，由调用方清理，防脏值变成可用的 requestId。
 */
export function parseStoredIntent(raw: string | null, chatId: string): CreateIntent | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as {
    v?: unknown
    requestId?: unknown
    name?: unknown
    priceStars?: unknown
    uncertain?: unknown
  }
  if (record.v !== INTENT_STORAGE_VERSION) return null
  if (typeof record.requestId !== 'string' || !REQUEST_ID_PATTERN.test(record.requestId)) return null
  if (typeof record.name !== 'string' || [...record.name].length > 32) return null
  if (
    typeof record.priceStars !== 'number' ||
    !Number.isInteger(record.priceStars) ||
    record.priceStars < 1 ||
    record.priceStars > 10_000
  ) {
    return null
  }
  if (typeof record.uncertain !== 'boolean') return null
  return {
    requestId: record.requestId,
    payload: { chatId, name: record.name, priceStars: record.priceStars },
    uncertain: record.uncertain,
  }
}

/**
 * 读取并校验存储的创建意图。
 * 存储记录只可能在请求在途或结果不确定时留下（成功/明确失败都会清理），
 * 所以刷新后一律按「结果不确定」处理，禁止自动换 requestId 新建。
 */
export function loadStoredIntent(
  storage: IntentStorage | null,
  key: string,
  chatId: string,
): CreateIntent | null {
  if (storage === null) return null
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const intent = parseStoredIntent(raw, chatId)
    if (intent === null) {
      storage.removeItem(key)
      return null
    }
    return intent.uncertain ? intent : { ...intent, uncertain: true }
  } catch {
    return null
  }
}

/** 只写 requestId/名称/价格/状态；不写 initData，也不写邀请链接。失败返回 false 由 UI 降级提示。 */
export function saveStoredIntent(
  storage: IntentStorage | null,
  key: string,
  intent: CreateIntent,
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(
      key,
      JSON.stringify({
        v: INTENT_STORAGE_VERSION,
        requestId: intent.requestId,
        name: intent.payload.name,
        priceStars: intent.payload.priceStars,
        uncertain: intent.uncertain,
      }),
    )
    return true
  } catch {
    return false
  }
}

export function clearStoredIntent(storage: IntentStorage | null, key: string): void {
  if (storage === null) return
  try {
    storage.removeItem(key)
  } catch {
    // 清理失败不改变内存状态；下次进入频道读到脏记录也会被校验丢弃
  }
}
