import type { Appeal, ModerationDecision, UserId } from '@skitarii/core'
import type { Repos } from '@skitarii/db'
import type { AppealNoticeStage, AppealNotification, Logger } from '@skitarii/bot'
import { z } from 'zod'
import { verifyInitData } from './init-data.js'

/**
 * Mini App 的申诉 API。契约在 Phase 1 冻结，UI 侧按 README 里的字段说明实现。
 *
 * - `GET /api/appeals/:decisionId?initData=...`：读一条处置与它的申诉。
 * - `POST /api/appeals`：body `{ initData, decisionId, reason }`，创建申诉。
 *
 * 为什么把处理逻辑写成返回 `{ status, body }` 的纯函数而不是直接写进 HTTP 处理器：
 * 这两条端点的判定（验签、归属、重复提交）是契约的一部分，必须能脱离 HTTP 服务器做行为测试。
 * `index.ts` 只负责把 HTTP 请求翻译成入参、把结果写回响应。
 *
 * 响应里的 `action` 是档位字符串（`warn | delete | mute | ban`），`mute` 的截止时刻另放
 * `actionUntil`：前端按档位选文案与图标，不需要为「带数据的动作」写判别逻辑，
 * 而截止时刻并没有因此丢失。字段清单与示例见 README 的「HTTP 接口」。
 */

/** 授权失败时的统一响应：不区分「不存在」与「无权访问」，避免泄露他人处置的存在性。 */
const NOT_FOUND_BODY = { error: 'decision_not_found' } as const

/** 请求体约束。`reason` 会写进申诉记录并展示给群主，因此限制长度上限。 */
const createAppealBodySchema = z.object({
  initData: z.string().min(1),
  decisionId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
})

/** uuid 形态。查询前必须校验：把非 uuid 字符串交给 `uuid` 列比较会让 Postgres 直接报错。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** HTTP 无关的响应。 */
export interface ApiResponse {
  status: number
  body: unknown
}

/** 申诉 API 依赖。 */
export interface AppealApiDeps {
  repos: Repos
  /** bot token，用于 initData 验签。 */
  botToken: string
  /** 申诉负责人：与处置当事人同样有权读取处置详情。 */
  ownerUserId: UserId
  /** 新申诉的通知出口（bot 私聊 owner）。`true` 表示 Telegram 接受；实现不抛出。 */
  notifyAppeal(notification: AppealNotification): Promise<boolean>
  /**
   * 申诉提交后更新原处置通知（切成「等待复核」并去掉申诉按钮）。
   * 实现在 bot 侧（`updateDecisionNotice`），由 `index.ts` 注入 bot api；best-effort，不抛出。
   */
  editNotice(decisionId: string, stage: AppealNoticeStage): Promise<void>
  logger: Logger
  now?: () => Date
}

/**
 * 读取一条处置与它的申诉。
 *
 * @param deps 仓储、验签密钥与日志。
 * @param query `decisionId` 来自路径，`initData` 来自查询串（本仓库对 GET 选定的传输方式）。
 * @returns 200 正常；401 验签失败；404 处置不存在或不属于请求者。
 */
export async function getAppeal(
  deps: AppealApiDeps,
  query: { decisionId: string; initData: string | null },
): Promise<ApiResponse> {
  const verified = verifyUser(deps, query.initData)
  if (!verified.ok) return verified.response

  const decision = await findAccessibleDecision(deps, query.decisionId, verified.userId)
  if (decision === null) return { status: 404, body: NOT_FOUND_BODY }

  const [context, appeal] = await Promise.all([
    loadContext(deps, decision),
    deps.repos.appeals.findByDecisionId(decision.id),
  ])

  return {
    status: 200,
    body: {
      decision: {
        id: decision.id,
        action: decision.action.kind,
        actionUntil: decision.action.kind === 'mute' ? decision.action.until : null,
        chatTitle: context.chatTitle,
        createdAt: decision.decidedAt,
        sampleText: context.sampleText,
      },
      appeal: appeal === null ? null : serializeAppeal(appeal),
    },
  }
}

/**
 * 创建一条申诉。
 *
 * @param deps 仓储、验签密钥、通知出口与日志。
 * @param body 原始请求体（未解析的 `unknown`，由本函数校验）。
 * @returns 201 创建成功；400 请求体不合法；401 验签失败；404 处置不存在或不属于请求者；409 该处置已有申诉。
 */
export async function createAppeal(deps: AppealApiDeps, body: unknown): Promise<ApiResponse> {
  const parsed = createAppealBodySchema.safeParse(body)
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        details: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    }
  }

  const verified = verifyUser(deps, parsed.data.initData)
  if (!verified.ok) return verified.response

  const decision = await findAccessibleDecision(deps, parsed.data.decisionId, verified.userId)
  if (decision === null) return { status: 404, body: NOT_FOUND_BODY }

  const existing = await deps.repos.appeals.findByDecisionId(decision.id)
  if (existing !== null) return { status: 409, body: { error: 'appeal_exists' } }

  const now = deps.now ?? (() => new Date())
  const appeal: Appeal = {
    id: crypto.randomUUID(),
    decisionId: decision.id,
    userId: verified.userId,
    state: 'open',
    note: parsed.data.reason,
    createdAt: now(),
    resolvedAt: null,
  }

  await deps.repos.appeals.insert(appeal)

  // 唯一约束是并发下的兜底：若同时进来两个提交，第二次的 insert 会被静默忽略，
  // 这时库里的申诉 id 与我们手上的不同，按 409 回答，而不是假装创建成功。
  const stored = await deps.repos.appeals.findByDecisionId(decision.id)
  if (stored === null || stored.id !== appeal.id) return { status: 409, body: { error: 'appeal_exists' } }

  const context = await loadContext(deps, decision)

  // 先编辑原通知、后通知 owner：owner 收到私聊后可能立刻结案，编辑必须赶在结案编辑之前，
  // 否则「等待复核」会覆盖终态文案（两段都是 best-effort，失败只记日志）。
  try {
    await deps.editNotice(decision.id, 'received')
  } catch (error) {
    deps.logger.warn(`通知编辑调用失败 decisionId=${decision.id}`, error)
  }

  try {
    const accepted = await deps.notifyAppeal({
      appealId: appeal.id,
      userId: appeal.userId,
      reason: parsed.data.reason,
      chatTitle: context.chatTitle,
      action: decision.action,
      sampleText: context.sampleText,
      createdAt: appeal.createdAt,
    })
    // 只有 Telegram 确认接受才回填 `notified_at`：没回填的申诉会被调度器的补发扫描再捞起来，
    // 否则「通知失败」会静默变成「没人处理」。
    if (accepted) await deps.repos.appeals.markNotified(appeal.id, now())
  } catch (error) {
    // 申诉已经落库，通知失败不该让客户端看到失败并重复提交。
    deps.logger.warn(`申诉通知失败 appealId=${appeal.id}`, error)
  }

  return { status: 201, body: { appeal: serializeAppeal(appeal) } }
}

/**
 * 验签并统一失败响应。
 *
 * @param deps API 依赖。
 * @param initData 原始 initData（可能为 `null`）。
 * @returns 通过时给出用户 id；失败时给出响应。
 */
function verifyUser(
  deps: AppealApiDeps,
  initData: string | null,
): { ok: true; userId: UserId } | { ok: false; response: ApiResponse } {
  if (initData === null) return { ok: false, response: { status: 401, body: { error: 'init_data_invalid' } } }

  const verified = verifyInitData(initData, { botToken: deps.botToken, now: deps.now?.() })
  if (!verified.ok) {
    deps.logger.warn(`initData 验签失败：${verified.reason}`)
    return { ok: false, response: { status: 401, body: { error: 'init_data_invalid' } } }
  }

  return { ok: true, userId: verified.data.userId }
}

/**
 * 按 id 读取处置，并校验请求者的可见性。
 *
 * 可见性：处置当事人本人，或申诉负责人（owner）。其余一律当作不存在处理（404），
 * 这样别人无法通过遍历 id 来探测群里发生过哪些处置。
 *
 * @param deps API 依赖。
 * @param decisionId 处置 id。
 * @param userId 请求者。
 * @returns 可见的决策；不可见时为 `null`。
 */
async function findAccessibleDecision(
  deps: AppealApiDeps,
  decisionId: string,
  userId: UserId,
): Promise<ModerationDecision | null> {
  if (!UUID_PATTERN.test(decisionId)) return null

  const decision = await deps.repos.decisions.findById(decisionId)
  if (decision === null) return null
  if (decision.userId !== userId && userId !== deps.ownerUserId) return null

  return decision
}

/**
 * 读取展示所需的上下文：群标题与正文摘录。
 *
 * @param deps API 依赖。
 * @param decision 处置。
 * @returns 群标题（未登记时退化为 chatId 字符串）与摘录（可能为 `null`）。
 */
async function loadContext(
  deps: AppealApiDeps,
  decision: ModerationDecision,
): Promise<{ chatTitle: string; sampleText: string | null }> {
  const [chat, event] = await Promise.all([
    deps.repos.chats.findByChatId(decision.chatId),
    deps.repos.events.findWithSample(decision.eventId),
  ])

  return { chatTitle: chat?.title ?? String(decision.chatId), sampleText: event?.sampleText ?? null }
}

/**
 * 申诉的对外序列化。GET 与 POST 共用同一形状，字段与 README 的契约一致。
 *
 * @param appeal 申诉。
 * @returns 可直接 JSON 化的对象；`reason` 对应领域里的 `note`。
 */
function serializeAppeal(appeal: Appeal): {
  id: string
  state: Appeal['state']
  reason: string | null
  createdAt: Date
  resolvedAt: Date | null
} {
  return {
    id: appeal.id,
    state: appeal.state,
    reason: appeal.note,
    createdAt: appeal.createdAt,
    resolvedAt: appeal.resolvedAt,
  }
}
