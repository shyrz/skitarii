import { createHash } from 'node:crypto'
import {
  asChatId,
  SUBSCRIPTION_NAME_MAX_LENGTH,
  SUBSCRIPTION_PERIOD_SECONDS,
  SUBSCRIPTION_PRICE_MAX_STARS,
  SUBSCRIPTION_PRICE_MIN_STARS,
  type ChatConfig,
  type SubscriptionLink,
  type SubscriptionMember,
  type UserId,
} from '@skitarii/core'
import type { ClaimResult, Repos } from '@skitarii/db'
import type { Logger } from '@skitarii/bot'
import type { ChatFullInfo, ChatMember } from 'grammy/types'
import { z } from 'zod'
import type { ApiResponse } from './api.js'
import { verifyInitData } from './init-data.js'

/**
 * Phase 3b owner 订阅管理接口（spec §5/§6）。
 *
 * 只做三件事：把 Telegram 的订阅链接能力包成受控的外部调用、把新台账的仓储语义翻译成 HTTP 契约、
 * 把不确定的结果如实告诉调用方。设计约束：
 *
 * - 凭据只从 `X-Telegram-Init-Data` header 读（由 `index.ts` 取出后传入），URL/body 不携带；
 * - 创建不套自动重试：先持久化 reservation 再调用 Telegram，任何「可能已成功」的路径都返回不确定，
 *   绝不用新 requestId 自动再发一次；
 * - 改名/撤销走 DB 条件写（claim + finish），撤销是终态、不复活；
 * - 日志只记受控错误码与 ID：Telegram 的错误对象可能回显 inviteLink，数据库唯一冲突也可能，
 *   因此下游异常一律不整对象打印。
 */

/** 分页默认值与上限（spec §5：默认 50，1..100，非法值 400，不静默截断）。 */
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

/** 游标串长度上限，超过即 400，防止把超长 JSON 塞进解码器。 */
const CURSOR_MAX_LENGTH = 1024

/** 创建占位超过该时长仍处于 creating 时，视为结果不确定，绝不自动重发。 */
const CREATE_UNKNOWN_AFTER_MS = 60_000

/** 单次 Telegram 调用的超时；超时按「结果不确定」处理。 */
const TELEGRAM_TIMEOUT_MS = 10_000

/** 路径参数：合法十进制 chatId。 */
const DECIMAL_PATTERN = /^-?\d+$/u

/** uuid 形态（linkId / requestId / operationToken）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Telegram 订阅链接能力的窄接口。实现见 `subscription-telegram.ts`（grammY），
 * 测试注入替身即可，不需要真实 Bot API，也不会扣 Stars。
 */
export interface SubscriptionTelegramPort {
  createChatSubscriptionInviteLink(input: {
    chatId: string
    name: string
    periodSeconds: number
    priceStars: number
  }): Promise<{ inviteLink: string; name: string | null; isRevoked: boolean }>
  editChatSubscriptionInviteLink(input: {
    chatId: string
    inviteLink: string
    name: string
  }): Promise<{ inviteLink: string; name: string | null; isRevoked: boolean }>
  revokeChatInviteLink(input: { chatId: string; inviteLink: string }): Promise<{ inviteLink: string; isRevoked: boolean }>
  getChat(chatId: string): Promise<ChatFullInfo>
  getChatMember(chatId: string, userId: number): Promise<ChatMember>
}

/** 受控的 Telegram 调用失败：只带错误分类与受控码，不带 description 等可能回显链接的文本。 */
export class TelegramSubscriptionError extends Error {
  readonly code: string
  readonly outcome: 'rejected' | 'rate_limited' | 'unavailable'
  readonly retryAfterSeconds: number | null

  constructor(options: { code: string; outcome: 'rejected' | 'rate_limited' | 'unavailable'; retryAfterSeconds?: number | null }) {
    super(`Telegram 调用失败：${options.code}`)
    this.name = 'TelegramSubscriptionError'
    this.code = options.code
    this.outcome = options.outcome
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

/** 订阅接口依赖。 */
export interface SubscriptionApiDeps {
  repos: Repos
  /** bot token，用于 initData 验签。 */
  botToken: string
  /** 面板唯一使用者；也是新链接的 ownerUserId。 */
  ownerUserId: UserId
  /**
   * bot 自己的用户 id（能力检查要查自己的成员身份）。
   * 用 getter 是因为 bot 初始化可能晚于依赖组装、也可能失败；取不到时能力检查会按不可确认处理。
   */
  botUserId: () => UserId
  telegram: SubscriptionTelegramPort
  logger: Logger
  now?: (() => Date) | undefined
  /** 单次 Telegram 调用超时（毫秒），默认 10000；测试可缩短。 */
  telegramTimeoutMs?: number | undefined
}

/* ---- 错误与响应 ---- */

/**
 * 统一 ApiError 响应。
 *
 * @param status HTTP 状态码。
 * @param code 受控错误码（spec §5 的取值集合）。
 * @param message 给用户看的短说明。
 * @param options.retryable 仅表示同一请求可安全重查/重试（不表示可换 requestId 再建）。
 * @param options.requestId 创建相关错误回带请求幂等键，便于前端关联。
 * @returns ApiResponse。
 */
function apiError(
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; requestId?: string } = {},
): ApiResponse {
  return {
    status,
    body: {
      error: code,
      message,
      retryable: options.retryable ?? false,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    },
  }
}

/** 只取异常类型名或受控码；绝不返回异常对象本体（可能含 inviteLink 或请求参数）。 */
function failureCode(error: unknown): string {
  if (error instanceof TelegramSubscriptionError) return error.code
  return error instanceof Error ? error.name : typeof error
}

/**
 * 记录外部调用失败：只写受控码与 ID。
 *
 * @param deps 订阅依赖。
 * @param action 受控动作名（如 create/rename/revoke/capability）。
 * @param identifiers 可打印的 ID（chatId/linkId/requestId）；不得包含邀请链接或 initData。
 * @param error 原始异常（只取分类，不打印本体）。
 */
function logFailure(deps: SubscriptionApiDeps, action: string, identifiers: string, error: unknown): void {
  deps.logger.warn(`订阅${action}失败 ${identifiers} code=${failureCode(error)}`)
}

/* ---- 验签与路径校验 ---- */

/** 验签 + owner 判定；401/403 都用统一 ApiError 形状。 */
function verifyOwner(deps: SubscriptionApiDeps, initData: string | null): { ok: true } | { ok: false; response: ApiResponse } {
  if (initData === null || initData.length === 0) {
    return { ok: false, response: apiError(401, 'init_data_invalid', '缺少或无效的身份凭据，请回到 Telegram 重新打开面板') }
  }
  const verified = verifyInitData(initData, { botToken: deps.botToken, now: deps.now?.() })
  if (!verified.ok) {
    deps.logger.warn(`订阅面板 initData 验签失败：${verified.reason}`)
    return { ok: false, response: apiError(401, 'init_data_invalid', '身份凭据无效或已过期，请回到 Telegram 重新打开面板') }
  }
  if (verified.data.userId !== deps.ownerUserId) {
    return { ok: false, response: apiError(403, 'forbidden', '仅管理员可用') }
  }
  return { ok: true }
}

/**
 * 读取并校验请求频道：必须是已登记且 `chatType = 'channel'` 的频道。
 *
 * @param deps 订阅依赖。
 * @param rawChatId 路径里的 chatId。
 * @returns 通过时给配置；不合法时给响应。
 */
async function requireChannel(
  deps: SubscriptionApiDeps,
  rawChatId: string,
): Promise<{ ok: true; chat: ChatConfig } | { ok: false; response: ApiResponse }> {
  if (!DECIMAL_PATTERN.test(rawChatId)) {
    return { ok: false, response: apiError(404, 'channel_not_found', '频道未登记或不在本面板范围') }
  }
  const chat = await deps.repos.chats.findByChatId(asChatId(rawChatId))
  if (chat === null) return { ok: false, response: apiError(404, 'channel_not_found', '频道未登记或不在本面板范围') }
  if (chat.chatType !== 'channel') {
    return { ok: false, response: apiError(400, 'channel_required', '该聊天不是频道，订阅链接只适用于频道') }
  }
  return { ok: true, chat }
}

/* ---- 分页 ---- */

interface PageResult<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * 解析 limit：缺省 50；必须是 1..100 的整数，非法值返回 null（由调用方回 400）。
 *
 * @param raw 查询串里的 limit。
 * @returns 合法页大小或 null。
 */
function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return DEFAULT_PAGE_LIMIT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) return null
  return parsed
}

/** 游标载荷：带版本与资源名，跨资源/跨频道一律拒绝。 */
type CursorPayload =
  | { v: 1; r: 'channels'; chatId: string }
  | { v: 1; r: 'links'; chatId: string; createdAt: string; id: string }
  | { v: 1; r: 'members'; chatId: string; firstObservedAt: string; id: string }

/** 每种资源允许出现的游标字段（白名单）：多余字段一律拒绝，游标只承载契约内的排序键与范围。 */
const CURSOR_FIELDS: Readonly<Record<CursorPayload['r'], readonly string[]>> = {
  channels: ['v', 'r', 'chatId'],
  links: ['v', 'r', 'chatId', 'createdAt', 'id'],
  members: ['v', 'r', 'chatId', 'firstObservedAt', 'id'],
}

/** 严格 ISO-8601 UTC 时间串：本服务只用 `Date.toISOString()` 的形态。 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

/**
 * 严格解析游标里的日期：格式、日历合法性与 epoch 下界都必须成立。
 *
 * `Date` 会把 `2026-02-30` 这类越界日历值顺延到下月，回写比对能把它挡掉；epoch < 0 拒绝 1970 前时间。
 *
 * @param value 游标里的原始字段值。
 * @returns 合法时返回原串（保证与 `toISOString()` 形态一致）；否则 null。
 */
function parseCursorInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) return null
  const parsed = new Date(value)
  const epoch = parsed.getTime()
  if (!Number.isFinite(epoch) || epoch < 0 || parsed.toISOString() !== value) return null
  return value
}

/**
 * 编码游标：base64url(JSON)。只承载排序键与范围，不承载凭据。
 *
 * @param payload 游标载荷。
 * @returns base64url 串。
 */
export function encodeSubscriptionCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * 解码并严格校验游标。
 *
 * @param raw 查询串里的 cursor。
 * @param resource 当前资源名。
 * @param chatId 当前路径的频道（跨频道游标拒绝）；`null` 表示该资源没有频道范围（频道列表）。
 * @returns 缺省为 `undefined`（首页）；合法为对应资源的载荷；非法为 `'invalid'`。
 */
function decodeSubscriptionCursor<R extends CursorPayload['r']>(
  raw: string | null,
  resource: R,
  chatId: string | null,
): Extract<CursorPayload, { r: R }> | undefined | 'invalid' {
  if (raw === null || raw.length === 0) return undefined
  if (raw.length > CURSOR_MAX_LENGTH) return 'invalid'

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return 'invalid'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'invalid'

  const payload = parsed as Record<string, unknown>
  const fields = CURSOR_FIELDS[resource]
  if (Object.keys(payload).length !== fields.length || !fields.every((field) => Object.hasOwn(payload, field))) {
    return 'invalid'
  }
  if (payload['v'] !== 1 || payload['r'] !== resource) return 'invalid'
  if (chatId !== null && payload['chatId'] !== chatId) return 'invalid'

  if (resource === 'channels') {
    const cursorChatId = payload['chatId']
    if (typeof cursorChatId !== 'string' || !DECIMAL_PATTERN.test(cursorChatId)) return 'invalid'
    return { v: 1, r: 'channels', chatId: cursorChatId } as Extract<CursorPayload, { r: R }>
  }

  const id = payload['id']
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return 'invalid'

  if (resource === 'links') {
    const createdAt = parseCursorInstant(payload['createdAt'])
    if (createdAt === null) return 'invalid'
    return { v: 1, r: 'links', chatId, createdAt, id } as Extract<CursorPayload, { r: R }>
  }

  const firstObservedAt = parseCursorInstant(payload['firstObservedAt'])
  if (firstObservedAt === null) return 'invalid'
  return { v: 1, r: 'members', chatId, firstObservedAt, id } as Extract<CursorPayload, { r: R }>
}

/**
 * 有界分页的公共计算：多取一条判断是否还有下一页。
 *
 * @param rows 仓储返回的 `limit + 1` 行。
 * @param limit 请求页大小。
 * @param cursorOf 由最后一条已返回行构造下一页游标。
 * @returns 页数据。
 */
function paginate<T>(rows: T[], limit: number, cursorOf: (last: T) => string): PageResult<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null }
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return { items, nextCursor: last === undefined ? null : cursorOf(last) }
}

/* ---- DTO 序列化 ---- */

/** 链接 DTO：只暴露 spec §5 冻结的字段（内部操作占位不出现在响应里）。 */
function serializeLink(link: SubscriptionLink): Record<string, unknown> {
  return {
    id: link.id,
    chatId: link.chatId,
    requestId: link.requestId,
    name: link.name,
    priceStars: link.priceStars,
    periodSeconds: link.periodSeconds,
    inviteLink: link.inviteLink,
    state: link.state,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    version: link.version,
  }
}

/** 成员 DTO：观测事实 + 最近检查信息；不暴露 checkToken/lease 等内部字段。 */
function serializeMember(member: SubscriptionMember): Record<string, unknown> {
  return {
    id: member.id,
    chatId: member.chatId,
    userId: member.userId,
    linkId: member.linkId,
    state: member.state,
    expiresAt: member.expiresAt?.toISOString() ?? null,
    evidence: member.evidence,
    firstObservedAt: member.firstObservedAt.toISOString(),
    observedAt: member.observedAt.toISOString(),
    observationSource: member.observationSource,
    lastCheckedAt: member.lastCheckedAt?.toISOString() ?? null,
    lastCheckSucceededAt: member.lastCheckSucceededAt?.toISOString() ?? null,
    lastCheckErrorCode: member.lastCheckErrorCode,
  }
}

/** 频道 DTO。 */
function serializeChannel(chat: ChatConfig): Record<string, unknown> {
  return {
    chatId: chat.chatId,
    title: chat.title,
    chatType: 'channel',
    linkedChatId: chat.linkedChatId,
  }
}

/* ---- 能力检查 ---- */

type CapabilityReason = 'ok' | 'insufficient' | 'unavailable' | 'channel_required'

interface Capability {
  visibility: 'public' | 'private' | 'unknown'
  canManageLinks: boolean
  reason: CapabilityReason
  errorCode: string | null
}

/**
 * 用一次超时包装外部调用。
 *
 * @param promise 外部调用。
 * @param timeoutMs 超时毫秒。
 * @returns 调用结果；超时抛受控错误。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TelegramSubscriptionError({ code: 'timeout', outcome: 'unavailable' })),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 刷新频道可见性与 bot 权限：`getChat` + `getChatMember(bot 自身)`。
 *
 * 结果只是检查时的快照：获取失败为 `unknown` 且 `canManageLinks=false`，不把未知当私有；
 * 明确「有权限调用但权限不足」才算 insufficient（变更时 403），调用本身失败算 unavailable（502）。
 *
 * @param deps 订阅依赖。
 * @param chatId 频道。
 * @returns 能力快照。
 */
async function checkCapability(deps: SubscriptionApiDeps, chatId: string): Promise<Capability> {
  const timeoutMs = deps.telegramTimeoutMs ?? TELEGRAM_TIMEOUT_MS
  let visibility: Capability['visibility'] = 'unknown'
  let canManageLinks = false
  let reason: CapabilityReason = 'ok'
  let errorCode: string | null = null

  try {
    const chat = await withTimeout(deps.telegram.getChat(chatId), timeoutMs)
    if (chat.type !== 'channel') {
      // 明确不是频道：这是输入/登记不一致，不是查询故障；变更操作按 400 channel_required 处理。
      return { visibility: 'unknown', canManageLinks: false, reason: 'channel_required', errorCode: 'channel_required' }
    }
    visibility = chat.username !== undefined && chat.username.length > 0 ? 'public' : 'private'
  } catch (error) {
    reason = 'unavailable'
    errorCode = failureCode(error)
  }

  try {
    const member = await withTimeout(deps.telegram.getChatMember(chatId, deps.botUserId()), timeoutMs)
    canManageLinks =
      member.status === 'creator' ||
      (member.status === 'administrator' && member.can_invite_users === true)
    if (!canManageLinks) {
      reason = reason === 'ok' ? 'insufficient' : reason
      errorCode = errorCode ?? 'bot_permission_required'
    }
  } catch (error) {
    if (error instanceof TelegramSubscriptionError && error.code === 'permission_denied') {
      // 调用被明确拒绝（bot 不是管理员等）：这是「权限不足」而不是查询故障。
      reason = 'insufficient'
      errorCode = errorCode ?? 'bot_permission_required'
    } else {
      reason = 'unavailable'
      errorCode = errorCode ?? failureCode(error)
    }
  }

  // 任一能力查询失败都不宣称「可管理」：详情里 canManageLinks=false，避免用部分信息误导操作。
  if (reason === 'unavailable') canManageLinks = false

  return { visibility, canManageLinks, reason, errorCode }
}

/**
 * 变更操作前的能力校验：确认失败返回 403（明确不足）或 502（无法确认），都带受控码。
 *
 * @param deps 订阅依赖。
 * @param chatId 频道。
 * @returns 通过时为 null，否则为响应。
 */
async function requireCapability(deps: SubscriptionApiDeps, chatId: string): Promise<ApiResponse | null> {
  const capability = await checkCapability(deps, chatId)
  if (capability.reason === 'ok') return null
  if (capability.reason === 'insufficient') {
    return apiError(403, 'bot_permission_required', '机器人在这条频道没有管理邀请链接的权限（需要管理员且具备「邀请用户」权限）')
  }
  if (capability.reason === 'channel_required') {
    return apiError(400, 'channel_required', 'Telegram 确认该聊天不是频道，订阅链接只适用于频道')
  }
  return apiError(502, 'telegram_failed', '暂时无法确认机器人在该频道的权限，请稍后重试；台账数据不受影响')
}

/* ---- 处理函数 ---- */

/**
 * 未预期失败的统一响应：DB 等故障映射 500 internal_error，只记受控日志（不打印异常对象，
 * 数据库唯一冲突的 detail 可能回显 inviteLink）。
 *
 * @param deps 订阅依赖。
 * @param action 受控动作名。
 * @param identifiers 可打印 ID。
 * @returns 500 响应。
 */
function internalError(deps: SubscriptionApiDeps, action: string, identifiers: string): ApiResponse {
  deps.logger.warn(`订阅${action}失败 ${identifiers} code=internal`)
  return apiError(500, 'internal_error', '服务器内部错误，请稍后重试', { retryable: true })
}

/**
 * `GET /channels`：已登记频道的稳定分页（chatId 固定 C 排序）。
 *
 * @param deps 订阅依赖。
 * @param query initData / limit / cursor。
 * @returns 200 页数据；400 非法参数；401 / 403 鉴权失败。
 */
export async function listSubscriptionChannels(
  deps: SubscriptionApiDeps,
  query: { initData: string | null; limit: string | null; cursor: string | null },
): Promise<ApiResponse> {
  try {
    return await runListSubscriptionChannels(deps, query)
  } catch {
    return internalError(deps, 'channels', '')
  }
}

/**
 * `GET /channels/:chatId`：频道详情（可见性/权限快照 + 全量 counts）。
 *
 * @param deps 订阅依赖。
 * @param query chatId / initData。
 * @returns 200 详情；400 / 404；401 / 403。
 */
export async function getSubscriptionChannel(
  deps: SubscriptionApiDeps,
  query: { chatId: string; initData: string | null },
): Promise<ApiResponse> {
  try {
    return await runGetSubscriptionChannel(deps, query)
  } catch {
    return internalError(deps, 'channel', `chatId=${query.chatId}`)
  }
}

/**
 * `GET /channels/:chatId/links`：链接分页（含占位/失败行）。
 *
 * @param deps 订阅依赖。
 * @param query chatId / initData / limit / cursor。
 * @returns 200 页数据；400 / 404；401 / 403。
 */
export async function listSubscriptionLinks(
  deps: SubscriptionApiDeps,
  query: { chatId: string; initData: string | null; limit: string | null; cursor: string | null },
): Promise<ApiResponse> {
  try {
    return await runListSubscriptionLinks(deps, query)
  } catch {
    return internalError(deps, 'links', `chatId=${query.chatId}`)
  }
}

/**
 * `GET /channels/:chatId/members`：成员台账分页（不可变首发时间倒序）。
 *
 * @param deps 订阅依赖。
 * @param query chatId / initData / limit / cursor。
 * @returns 200 页数据；400 / 404；401 / 403。
 */
export async function listSubscriptionMembers(
  deps: SubscriptionApiDeps,
  query: { chatId: string; initData: string | null; limit: string | null; cursor: string | null },
): Promise<ApiResponse> {
  try {
    return await runListSubscriptionMembers(deps, query)
  } catch {
    return internalError(deps, 'members', `chatId=${query.chatId}`)
  }
}

/**
 * `POST /channels/:chatId/links`：创建订阅链接。
 *
 * 顺序：校验 → 查 requestId（完成请求直接 replay，不要求权限）→ 能力校验 → reserveCreate →
 * 仅 reserved 的调用者发一次 Telegram create → finishCreate。全程不自动重试。
 *
 * @param deps 订阅依赖。
 * @param input chatId / initData / 未解析 body。
 * @returns 201 新建；200 重放；400/404/409/502；401/403；500 未预期失败。
 */
export async function createSubscriptionLink(
  deps: SubscriptionApiDeps,
  input: { chatId: string; initData: string | null; body: unknown },
): Promise<ApiResponse> {
  try {
    return await runCreateSubscriptionLink(deps, input)
  } catch {
    return internalError(deps, 'create', `chatId=${input.chatId}`)
  }
}

/**
 * `PATCH /channels/:chatId/links/:linkId`：只改名（价格与周期不可编辑）。
 *
 * @param deps 订阅依赖。
 * @param input chatId / linkId / initData / 未解析 body。
 * @returns 200 更新后链接；400/404/409/502；401/403；500 未预期失败。
 */
export async function renameSubscriptionLink(
  deps: SubscriptionApiDeps,
  input: { chatId: string; linkId: string; initData: string | null; body: unknown },
): Promise<ApiResponse> {
  try {
    return await runRenameSubscriptionLink(deps, input)
  } catch {
    return internalError(deps, 'rename', `chatId=${input.chatId} linkId=${input.linkId}`)
  }
}

/**
 * `POST /channels/:chatId/links/:linkId/revoke`：撤销链接。
 *
 * 先 Telegram revoke 并验证返回的原链接与 `is_revoked=true`，再提交本地状态；DB 提交失败不返回 200。
 *
 * @param deps 订阅依赖。
 * @param input chatId / linkId / initData / 未解析 body。
 * @returns 200 更新后链接（含已撤销的重放）；400/404/409/502；401/403；500 未预期失败。
 */
export async function revokeSubscriptionLink(
  deps: SubscriptionApiDeps,
  input: { chatId: string; linkId: string; initData: string | null; body: unknown },
): Promise<ApiResponse> {
  try {
    return await runRevokeSubscriptionLink(deps, input)
  } catch {
    return internalError(deps, 'revoke', `chatId=${input.chatId} linkId=${input.linkId}`)
  }
}

/**
 * `GET /channels` 的实现体（外层只做错误兜底）。
 *
 * @param deps 订阅依赖。
 * @param query initData / limit / cursor。
 * @returns 响应。
 */
async function runListSubscriptionChannels(
  deps: SubscriptionApiDeps,
  query: { initData: string | null; limit: string | null; cursor: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const limit = parseLimit(query.limit)
  if (limit === null) return apiError(400, 'invalid_request', 'limit 必须是 1..100 的整数')

  const cursor = decodeSubscriptionCursor(query.cursor, 'channels', null)
  if (cursor === 'invalid') return apiError(400, 'invalid_cursor', '分页游标无效，请刷新后重试')

  const afterChatId = cursor === undefined ? undefined : asChatId(cursor.chatId)
  const rows = await deps.repos.chats.listChannelsPage({
    ...(afterChatId === undefined ? {} : { afterChatId }),
    limit: limit + 1,
  })
  const page = paginate(rows, limit, (last) => encodeSubscriptionCursor({ v: 1, r: 'channels', chatId: last.chatId }))

  return {
    status: 200,
    body: {
      items: page.items.map(serializeChannel),
      nextCursor: page.nextCursor,
      serverTime: nowIso(deps),
    },
  }
}

/**
 * `GET /channels/:chatId`：频道详情（可见性/权限快照 + 全量 counts）。
 *
 * @param deps 订阅依赖。
 * @param query chatId / initData。
 * @returns 200 详情；400 / 404；401 / 403。
 */
async function runGetSubscriptionChannel(
  deps: SubscriptionApiDeps,
  query: { chatId: string; initData: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const channel = await requireChannel(deps, query.chatId)
  if (!channel.ok) return channel.response

  const now = deps.now?.() ?? new Date()
  const [capability, counts] = await Promise.all([
    checkCapability(deps, query.chatId),
    deps.repos.subscriptionMembers.countByState(channel.chat.chatId),
  ])

  return {
    status: 200,
    body: {
      ...serializeChannel(channel.chat),
      visibility: capability.visibility,
      canManageLinks: capability.canManageLinks,
      capabilityCheckedAt: now.toISOString(),
      capabilityErrorCode: capability.errorCode,
      counts,
      serverTime: now.toISOString(),
    },
  }
}

/**
 * `GET /channels/:chatId/links`：链接分页（含占位/失败行）。
 *
 * @param deps 订阅依赖。
 * @param query chatId / initData / limit / cursor。
 * @returns 200 页数据；400 / 404；401 / 403。
 */
async function runListSubscriptionLinks(
  deps: SubscriptionApiDeps,
  query: { chatId: string; initData: string | null; limit: string | null; cursor: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const channel = await requireChannel(deps, query.chatId)
  if (!channel.ok) return channel.response

  const limit = parseLimit(query.limit)
  if (limit === null) return apiError(400, 'invalid_request', 'limit 必须是 1..100 的整数')

  const cursor = decodeSubscriptionCursor(query.cursor, 'links', query.chatId)
  if (cursor === 'invalid') return apiError(400, 'invalid_cursor', '分页游标无效，请刷新后重试')

  const rows = await deps.repos.subscriptionLinks.listPage({
    chatId: channel.chat.chatId,
    ...(cursor === undefined ? {} : { before: { createdAt: new Date(cursor.createdAt), id: cursor.id } }),
    limit: limit + 1,
  })
  const page = paginate(rows, limit, (last) =>
    encodeSubscriptionCursor({
      v: 1,
      r: 'links',
      chatId: query.chatId,
      createdAt: last.createdAt.toISOString(),
      id: last.id,
    }),
  )

  return {
    status: 200,
    body: { items: page.items.map(serializeLink), nextCursor: page.nextCursor, serverTime: nowIso(deps) },
  }
}

/**
 * `GET /channels/:chatId/members`：成员台账分页（不可变首发时间倒序）。
 *
 * @param deps 订阅依赖。
 * @param query chatId / initData / limit / cursor。
 * @returns 200 页数据；400 / 404；401 / 403。
 */
async function runListSubscriptionMembers(
  deps: SubscriptionApiDeps,
  query: { chatId: string; initData: string | null; limit: string | null; cursor: string | null },
): Promise<ApiResponse> {
  const auth = verifyOwner(deps, query.initData)
  if (!auth.ok) return auth.response

  const channel = await requireChannel(deps, query.chatId)
  if (!channel.ok) return channel.response

  const limit = parseLimit(query.limit)
  if (limit === null) return apiError(400, 'invalid_request', 'limit 必须是 1..100 的整数')

  const cursor = decodeSubscriptionCursor(query.cursor, 'members', query.chatId)
  if (cursor === 'invalid') return apiError(400, 'invalid_cursor', '分页游标无效，请刷新后重试')

  const rows = await deps.repos.subscriptionMembers.listPage({
    chatId: channel.chat.chatId,
    ...(cursor === undefined
      ? {}
      : { before: { firstObservedAt: new Date(cursor.firstObservedAt), id: cursor.id } }),
    limit: limit + 1,
  })
  const page = paginate(rows, limit, (last) =>
    encodeSubscriptionCursor({
      v: 1,
      r: 'members',
      chatId: query.chatId,
      firstObservedAt: last.firstObservedAt.toISOString(),
      id: last.id,
    }),
  )

  return {
    status: 200,
    body: { items: page.items.map(serializeMember), nextCursor: page.nextCursor, serverTime: nowIso(deps) },
  }
}

/* ---- 创建 ---- */

/** 创建请求体的结构校验：严格拒绝额外字段。 */
const createBodySchema = z.strictObject({
  requestId: z.string(),
  name: z.string(),
  priceStars: z.number(),
})

/** 改名的结构校验。 */
const renameBodySchema = z.strictObject({
  name: z.string(),
  expectedVersion: z.number(),
})

/** 撤销的结构校验。 */
const revokeBodySchema = z.strictObject({
  expectedVersion: z.number(),
})

/**
 * 创建请求的规范化摘要：字段顺序固定，改名不影响它。
 *
 * @param input 参与 hash 的原始请求字段。
 * @returns sha256 十六进制摘要。
 */
function createRequestHash(input: {
  ownerUserId: UserId
  chatId: string
  name: string
  priceStars: number
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ownerUserId: input.ownerUserId,
        chatId: input.chatId,
        name: input.name,
        priceStars: input.priceStars,
        periodSeconds: SUBSCRIPTION_PERIOD_SECONDS,
      }),
    )
    .digest('hex')
}

/**
 * 对已存在的创建请求给出重放或受控冲突响应。
 *
 * @param deps 订阅依赖。
 * @param existing 已有链接。
 * @param hash 本次请求的 hash。
 * @param requestId 本次请求幂等键。
 * @param now 当前时刻。
 * @returns 响应，或 `null` 表示调用方继续尝试 reserve（状态已从 creating 转为不确定等）。
 */
async function resolveExistingCreate(
  deps: SubscriptionApiDeps,
  existing: SubscriptionLink,
  hash: string,
  requestId: string,
  now: Date,
): Promise<ApiResponse | null> {
  if (existing.requestHash !== hash) {
    return apiError(409, 'request_conflict', '这个 requestId 已用于参数不同的创建请求，为避免重复创建已拒绝', {
      requestId,
    })
  }
  switch (existing.state) {
    case 'active':
    case 'revoked':
      // 已完成（含后来被撤销）的请求：直接重放已保存结果，不要求仍有 Telegram 权限。
      return { status: 200, body: { link: serializeLink(existing), replayed: true } }
    case 'create_failed':
      return apiError(409, 'create_failed', 'Telegram 明确拒绝了这个创建请求，不会自动重试', { requestId })
    case 'create_unknown':
      return apiError(409, 'create_outcome_unknown', '该创建请求结果不确定：Telegram 可能已创建链接，请人工核查后处理', {
        requestId,
        retryable: true,
      })
    case 'creating': {
      const age = now.getTime() - existing.createdAt.getTime()
      if (age < CREATE_UNKNOWN_AFTER_MS) {
        return apiError(409, 'operation_in_progress', '这个创建请求正在处理中，请稍后用同一请求重试', {
          requestId,
          retryable: true,
        })
      }
      // 60 秒以上仍 creating：视作结果不确定，绝不自动重发；落一个不确定状态供后续识别。
      try {
        await deps.repos.subscriptionLinks.markCreateOutcome(existing.id, 'create_unknown', now)
      } catch (error) {
        logFailure(deps, 'create-unknown-persist', `linkId=${existing.id}`, error)
      }
      return apiError(409, 'create_outcome_unknown', '该创建请求超过 60 秒仍未确认：Telegram 可能已创建链接，请人工核查后处理', {
        requestId,
        retryable: true,
      })
    }
  }
}

/**
 * `POST /channels/:chatId/links`：创建订阅链接。
 *
 * 顺序：校验 → 查 requestId（完成请求直接 replay，不要求权限）→ 能力校验 → reserveCreate →
 * 仅 reserved 的调用者发一次 Telegram create → finishCreate。全程不自动重试。
 *
 * @param deps 订阅依赖。
 * @param input chatId / initData / 未解析 body。
 * @returns 201 新建；200 重放；400/404/409/502；401/403。
 */
async function runCreateSubscriptionLink(
  deps: SubscriptionApiDeps,
  input: { chatId: string; initData: string | null; body: unknown },
): Promise<ApiResponse> {
  // 先验签再读 body：缺/坏凭据时即使 body 不合法也必须回 401，不向未鉴权请求反馈参数校验结果。
  const auth = verifyOwner(deps, input.initData)
  if (!auth.ok) return auth.response

  const parsed = createBodySchema.safeParse(input.body)
  if (!parsed.success) {
    return apiError(400, 'invalid_request', '请求体不合法：需要 requestId/name/priceStars，且不接受额外字段')
  }
  const { requestId, name, priceStars } = parsed.data
  if (!UUID_PATTERN.test(requestId)) return apiError(400, 'invalid_request', 'requestId 必须是 UUID')
  if ([...name].length > SUBSCRIPTION_NAME_MAX_LENGTH) {
    return apiError(400, 'invalid_request', `name 最多 ${SUBSCRIPTION_NAME_MAX_LENGTH} 个字符`)
  }
  if (
    !Number.isInteger(priceStars) ||
    priceStars < SUBSCRIPTION_PRICE_MIN_STARS ||
    priceStars > SUBSCRIPTION_PRICE_MAX_STARS
  ) {
    return apiError(
      400,
      'invalid_request',
      `priceStars 必须是 ${SUBSCRIPTION_PRICE_MIN_STARS}..${SUBSCRIPTION_PRICE_MAX_STARS} 的整数`,
    )
  }

  const channel = await requireChannel(deps, input.chatId)
  if (!channel.ok) return channel.response

  const now = deps.now?.() ?? new Date()
  const hash = createRequestHash({ ownerUserId: deps.ownerUserId, chatId: input.chatId, name, priceStars })

  const existing = await deps.repos.subscriptionLinks.findByRequestId(deps.ownerUserId, requestId)
  if (existing !== null) {
    const replay = await resolveExistingCreate(deps, existing, hash, requestId, now)
    if (replay !== null) return replay
  }

  // 能力校验在 reservation 之前：权限不足不留下无法处理的 creating 占位。
  const capabilityFailure = await requireCapability(deps, input.chatId)
  if (capabilityFailure !== null) return capabilityFailure

  const reserved = await deps.repos.subscriptionLinks.reserveCreate({
    id: crypto.randomUUID(),
    chatId: channel.chat.chatId,
    ownerUserId: deps.ownerUserId,
    requestId,
    requestHash: hash,
    name,
    priceStars,
    periodSeconds: SUBSCRIPTION_PERIOD_SECONDS,
    createdAt: now,
  })
  if (reserved.kind === 'existing') {
    // 并发：另一个请求（或本请求的重试）先占了幂等键，走同一套重放/冲突判定。
    const replay = await resolveExistingCreate(deps, reserved.link, hash, requestId, now)
    return (
      replay ??
      apiError(409, 'operation_in_progress', '这个创建请求正在处理中，请稍后用同一请求重试', {
        requestId,
        retryable: true,
      })
    )
  }

  const link = reserved.link
  const timeoutMs = deps.telegramTimeoutMs ?? TELEGRAM_TIMEOUT_MS
  let created: { inviteLink: string }
  try {
    created = await withTimeout(
      deps.telegram.createChatSubscriptionInviteLink({
        chatId: input.chatId,
        name,
        periodSeconds: SUBSCRIPTION_PERIOD_SECONDS,
        priceStars,
      }),
      timeoutMs,
    )
  } catch (error) {
    const classified = classifyTelegramFailure(error)
    if (classified.outcome === 'rejected') {
      // Telegram 明确拒绝：结果确定，记 create_failed；写失败也不能假装成功。
      try {
        await deps.repos.subscriptionLinks.markCreateOutcome(link.id, 'create_failed', deps.now?.() ?? new Date())
      } catch (persistError) {
        logFailure(deps, 'create-failed-persist', `linkId=${link.id}`, persistError)
        return apiError(502, 'persistence_after_telegram_failed', '创建被拒绝且本地状态保存失败，请刷新核对', { requestId })
      }
      return apiError(409, 'create_failed', 'Telegram 明确拒绝了这个创建请求，请调整参数后重新发起', { requestId })
    }

    // 网络超时、5xx、进程崩溃窗口：结果不确定，绝不用同一请求自动重发。
    try {
      await deps.repos.subscriptionLinks.markCreateOutcome(link.id, 'create_unknown', deps.now?.() ?? new Date())
    } catch (persistError) {
      logFailure(deps, 'create-unknown-persist', `linkId=${link.id}`, persistError)
      return apiError(
        502,
        'persistence_after_telegram_failed',
        'Telegram 可能已创建链接，但本地状态保存失败；请先到频道邀请链接里人工核查，不要直接重复创建',
        { requestId, retryable: true },
      )
    }
    return apiError(
      502,
      'telegram_outcome_unknown',
      'Telegram 调用结果不确定：可能已创建链接，请先到频道邀请链接里人工核查，不要直接重复创建',
      { requestId, retryable: true },
    )
  }

  const finishedAt = deps.now?.() ?? new Date()
  let finished: boolean
  try {
    finished = await deps.repos.subscriptionLinks.finishCreate(link.id, {
      inviteLink: created.inviteLink,
      finishedAt,
    })
  } catch (error) {
    logFailure(deps, 'create-finish', `linkId=${link.id}`, error)
    return apiError(
      502,
      'persistence_after_telegram_failed',
      'Telegram 已创建链接，但本地保存失败；请先到频道邀请链接里人工核查',
      { requestId },
    )
  }
  if (!finished) {
    return apiError(
      502,
      'persistence_after_telegram_failed',
      'Telegram 已创建链接，但本地状态未确认；请先到频道邀请链接里人工核查',
      { requestId },
    )
  }

  return {
    status: 201,
    body: {
      link: serializeLink({
        ...link,
        state: 'active',
        inviteLink: created.inviteLink,
        version: link.version + 1,
        updatedAt: finishedAt,
      }),
      replayed: false,
    },
  }
}

/* ---- 改名与撤销 ---- */

/** 把 claim 的结果翻译成 HTTP 响应。 */
function claimFailureResponse(result: Exclude<ClaimResult, { kind: 'claimed' }>): ApiResponse {
  switch (result.kind) {
    case 'missing':
      return apiError(404, 'link_not_found', '链接不存在或不在该频道下')
    case 'revoked':
      return apiError(409, 'link_revoked', '这条链接已经撤销，不能再改名或撤销')
    case 'conflict':
      return result.reason === 'version'
        ? apiError(409, 'version_conflict', '链接状态已变化，请刷新后重试')
        : apiError(409, 'operation_in_progress', '这条链接正有一个操作在进行，请稍后重试')
  }
}

/**
 * 非 active 链接对改名/撤销的受控响应。
 *
 * @param link 链接。
 * @returns 409/400 响应；active 返回 null。
 */
function requireActiveLink(link: SubscriptionLink): ApiResponse | null {
  switch (link.state) {
    case 'active':
      return null
    case 'revoked':
      return apiError(409, 'link_revoked', '这条链接已经撤销，不能再改名或撤销')
    case 'creating':
      return apiError(409, 'operation_in_progress', '链接仍在创建中，请稍后再试', { requestId: link.requestId })
    case 'create_unknown':
      return apiError(409, 'create_outcome_unknown', '创建结果不确定，请先人工核查再处理', {
        requestId: link.requestId,
        retryable: true,
      })
    case 'create_failed':
      return apiError(409, 'create_failed', '这条链接创建被拒，不能再改名或撤销', { requestId: link.requestId })
  }
}

/**
 * `PATCH /channels/:chatId/links/:linkId`：只改名（价格与周期不可编辑）。
 *
 * @param deps 订阅依赖。
 * @param input chatId / linkId / initData / 未解析 body。
 * @returns 200 更新后链接；400/404/409/502；401/403。
 */
async function runRenameSubscriptionLink(
  deps: SubscriptionApiDeps,
  input: { chatId: string; linkId: string; initData: string | null; body: unknown },
): Promise<ApiResponse> {
  // 先验签再读 body：缺/坏凭据时即使 body 不合法也必须回 401。
  const auth = verifyOwner(deps, input.initData)
  if (!auth.ok) return auth.response

  const parsed = renameBodySchema.safeParse(input.body)
  if (!parsed.success) {
    return apiError(400, 'invalid_request', '请求体不合法：需要 name/expectedVersion，且不接受额外字段')
  }
  const { name, expectedVersion } = parsed.data
  if ([...name].length > SUBSCRIPTION_NAME_MAX_LENGTH) {
    return apiError(400, 'invalid_request', `name 最多 ${SUBSCRIPTION_NAME_MAX_LENGTH} 个字符`)
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return apiError(400, 'invalid_request', 'expectedVersion 必须是非负整数')
  }

  const channel = await requireChannel(deps, input.chatId)
  if (!channel.ok) return channel.response

  if (!UUID_PATTERN.test(input.linkId)) return apiError(404, 'link_not_found', '链接不存在或不在该频道下')

  const link = await deps.repos.subscriptionLinks.findById(channel.chat.chatId, input.linkId)
  if (link === null) return apiError(404, 'link_not_found', '链接不存在或不在该频道下')
  const notActive = requireActiveLink(link)
  if (notActive !== null) return notActive
  if (link.inviteLink === null) return apiError(500, 'internal_error', '链接缺少 inviteLink，数据异常')

  const capabilityFailure = await requireCapability(deps, input.chatId)
  if (capabilityFailure !== null) return capabilityFailure

  const now = deps.now?.() ?? new Date()
  const claim = await deps.repos.subscriptionLinks.claimMutation(
    channel.chat.chatId,
    link.id,
    expectedVersion,
    'rename',
    now,
  )
  if (claim.kind !== 'claimed') return claimFailureResponse(claim)

  const timeoutMs = deps.telegramTimeoutMs ?? TELEGRAM_TIMEOUT_MS
  try {
    const edited = await withTimeout(
      deps.telegram.editChatSubscriptionInviteLink({
        chatId: input.chatId,
        inviteLink: link.inviteLink,
        name,
      }),
      timeoutMs,
    )
    if (edited.inviteLink !== link.inviteLink) {
      // 返回了别的链接：不采信，也不写本地。
      await releaseQuietly(deps, link.id, claim.token)
      return apiError(502, 'telegram_failed', 'Telegram 返回的链接与本地不一致，已放弃本次改名')
    }
    const finishedAt = deps.now?.() ?? new Date()
    const finished = await deps.repos.subscriptionLinks.finishMutation(
      link.id,
      claim.token,
      { kind: 'renamed', name },
      finishedAt,
    )
    if (!finished) {
      await releaseQuietly(deps, link.id, claim.token)
      return apiError(502, 'persistence_after_telegram_failed', '改名可能已在 Telegram 生效，但本地保存失败；请刷新核对后重试同名设置')
    }
    return {
      status: 200,
      body: {
        link: serializeLink({
          ...claim.link,
          name,
          operationToken: null,
          operationKind: null,
          operationStartedAt: null,
          version: claim.link.version + 1,
          updatedAt: finishedAt,
        }),
      },
    }
  } catch (error) {
    logFailure(deps, 'rename', `linkId=${link.id}`, error)
    await releaseQuietly(deps, link.id, claim.token)
    if (classifyTelegramFailure(error).outcome === 'rejected') {
      return apiError(502, 'telegram_failed', 'Telegram 拒绝了这个改名请求，本地未做修改；请刷新后核对')
    }
    return apiError(502, 'telegram_outcome_unknown', '改名结果不确定：Telegram 可能已接受，请刷新核对；重试设置同名可以接受', {
      retryable: true,
    })
  }
}

/**
 * `POST /channels/:chatId/links/:linkId/revoke`：撤销链接。
 *
 * 先 Telegram revoke 并验证返回的原链接与 `is_revoked=true`，再提交本地状态；DB 提交失败不返回 200。
 *
 * @param deps 订阅依赖。
 * @param input chatId / linkId / initData / 未解析 body。
 * @returns 200 更新后链接（含已撤销的重放）；400/404/409/502；401/403。
 */
async function runRevokeSubscriptionLink(
  deps: SubscriptionApiDeps,
  input: { chatId: string; linkId: string; initData: string | null; body: unknown },
): Promise<ApiResponse> {
  // 先验签再读 body：缺/坏凭据时即使 body 不合法也必须回 401。
  const auth = verifyOwner(deps, input.initData)
  if (!auth.ok) return auth.response

  const parsed = revokeBodySchema.safeParse(input.body)
  if (!parsed.success) {
    return apiError(400, 'invalid_request', '请求体不合法：需要 expectedVersion，且不接受额外字段')
  }
  const { expectedVersion } = parsed.data
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return apiError(400, 'invalid_request', 'expectedVersion 必须是非负整数')
  }

  const channel = await requireChannel(deps, input.chatId)
  if (!channel.ok) return channel.response

  if (!UUID_PATTERN.test(input.linkId)) return apiError(404, 'link_not_found', '链接不存在或不在该频道下')

  const link = await deps.repos.subscriptionLinks.findById(channel.chat.chatId, input.linkId)
  if (link === null) return apiError(404, 'link_not_found', '链接不存在或不在该频道下')

  // 已在 DB 确认为 revoked：直接 200，忽略过时的 expectedVersion，不再调用官方。
  if (link.state === 'revoked') return { status: 200, body: { link: serializeLink(link) } }
  const notActive = requireActiveLink(link)
  if (notActive !== null) return notActive
  if (link.inviteLink === null) return apiError(500, 'internal_error', '链接缺少 inviteLink，数据异常')

  const capabilityFailure = await requireCapability(deps, input.chatId)
  if (capabilityFailure !== null) return capabilityFailure

  const now = deps.now?.() ?? new Date()
  const claim = await deps.repos.subscriptionLinks.claimMutation(
    channel.chat.chatId,
    link.id,
    expectedVersion,
    'revoke',
    now,
  )
  if (claim.kind !== 'claimed') return claimFailureResponse(claim)

  const timeoutMs = deps.telegramTimeoutMs ?? TELEGRAM_TIMEOUT_MS
  try {
    const revoked = await withTimeout(
      deps.telegram.revokeChatInviteLink({ chatId: input.chatId, inviteLink: link.inviteLink }),
      timeoutMs,
    )
    if (revoked.inviteLink !== link.inviteLink || revoked.isRevoked !== true) {
      // 没有拿到「原链接已撤销」的确认：不能假装撤销成功。
      await releaseQuietly(deps, link.id, claim.token)
      return apiError(502, 'telegram_failed', 'Telegram 未返回明确的撤销确认，本地未做修改；请人工核查后再重试')
    }

    const finishedAt = deps.now?.() ?? new Date()
    const finished = await deps.repos.subscriptionLinks.finishMutation(
      link.id,
      claim.token,
      { kind: 'revoked', revokedAt: finishedAt },
      finishedAt,
    )
    if (!finished) {
      await releaseQuietly(deps, link.id, claim.token)
      return apiError(502, 'persistence_after_telegram_failed', '撤销可能已在 Telegram 生效，但本地保存失败；请刷新核对后重试')
    }
    return {
      status: 200,
      body: {
        link: serializeLink({
          ...claim.link,
          state: 'revoked',
          revokedAt: finishedAt,
          operationToken: null,
          operationKind: null,
          operationStartedAt: null,
          version: claim.link.version + 1,
          updatedAt: finishedAt,
        }),
      },
    }
  } catch (error) {
    logFailure(deps, 'revoke', `linkId=${link.id}`, error)
    await releaseQuietly(deps, link.id, claim.token)
    if (classifyTelegramFailure(error).outcome === 'rejected') {
      return apiError(502, 'telegram_failed', 'Telegram 拒绝了撤销请求，本地未做修改；请在频道里人工核查后重试')
    }
    return apiError(502, 'telegram_outcome_unknown', '撤销结果不确定：Telegram 可能已撤销，请刷新核对；重试撤销是安全的', {
      retryable: true,
    })
  }
}

/**
 * 释放占位；失败只记日志（占位过期后会被新 token 替换，不会卡死）。
 *
 * @param deps 订阅依赖。
 * @param linkId 链接 id。
 * @param token 本次 claim 的 token。
 */
async function releaseQuietly(deps: SubscriptionApiDeps, linkId: string, token: string): Promise<void> {
  try {
    await deps.repos.subscriptionLinks.releaseMutation(linkId, token)
  } catch (error) {
    logFailure(deps, 'release', `linkId=${linkId}`, error)
  }
}

/** 把异常归类为 rejected（确定未执行）或其它（结果不确定/限流）。 */
function classifyTelegramFailure(error: unknown): { outcome: 'rejected' | 'rate_limited' | 'unavailable' } {
  if (error instanceof TelegramSubscriptionError) return { outcome: error.outcome }
  return { outcome: 'unavailable' }
}

/** 当前时刻的 ISO 串。 */
function nowIso(deps: SubscriptionApiDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}
