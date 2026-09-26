import { TelegramSubscriptionError, type SubscriptionTelegramPort } from './subscriptions.js'
import type { CheckClaim, Repos } from '@skitarii/db'
import type { Logger } from '@skitarii/bot'
import type { ChatMember } from 'grammy/types'

/**
 * 订阅成员台账的对账：每 60 秒一轮、single-flight、有界并发地刷新已知成员的快照。
 *
 * 边界（spec §4.2）：
 * - 只查询已有台账行，不枚举频道成员、不调用任何权限处置接口（不 ban/kick/restrict）；
 * - 每轮最多 claim 50 行、最多 4 个并发、单次 Telegram 调用 10 秒超时；失败也推进 `lastCheckedAt`，
 *   按 `lastCheckedAt ASC NULLS FIRST` 公平轮转，持续失败的行不会霸占队首；
 * - claim 是数据库单条条件写，语句结束即提交，不跨 HTTP 持事务；租约 60 秒，崩溃后自然过期可再 claim；
 * - 429 时停止本轮新派发（已派发的收尾），未派发的 claim 以受控错误码释放租约，并按 retry_after 跳过后续轮次；
 * - 日志只记 ID 与受控错误码，绝不打印 Telegram 异常对象或 inviteLink。
 */

/** 对账默认参数（spec 固定值；测试可覆盖以缩短等待）。 */
const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_BATCH_LIMIT = 50
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_LEASE_MS = 60_000

/** 一轮对账的结果，供日志与测试断言。 */
export interface ReconcileRunResult {
  /** 本轮 claim 到的行数。 */
  claimed: number
  /** 成功应用快照的行数。 */
  applied: number
  /** 以失败结束（含 429 释放）的行数。 */
  failed: number
  /** CAS 过期（查询期间有事件写入）而被丢弃的行数。 */
  skipped: number
  /** 本轮遇到 429 并停止新派发。 */
  rateLimited: boolean
}

/** 对账依赖。 */
export interface SubscriptionReconcileDeps {
  repos: Repos
  /** 只用到 getChatMember：对账不调用任何写接口。 */
  telegram: Pick<SubscriptionTelegramPort, 'getChatMember'>
  logger: Logger
  now?: (() => Date) | undefined
  intervalMs?: number | undefined
  batchLimit?: number | undefined
  concurrency?: number | undefined
  timeoutMs?: number | undefined
  leaseMs?: number | undefined
}

/** 对账服务：独立生命周期（start/stop）与手动 runOnce（共用 single-flight）。 */
export interface SubscriptionReconciler {
  start(): void
  stop(): void
  /** 手动跑一轮；已有在途轮次时返回同一 promise（single-flight）。 */
  runOnce(): Promise<ReconcileRunResult>
  /** 当前是否有在途轮次。 */
  isRunning(): boolean
}

/**
 * 建立对账服务。
 *
 * @param deps 仓储、只读 Telegram 端口、日志与运行参数。
 * @returns 对账服务。
 */
export function createSubscriptionReconciler(deps: SubscriptionReconcileDeps): SubscriptionReconciler {
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS

  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<ReconcileRunResult> | null = null
  /** 429 的下次允许派发时刻（epoch 毫秒）；窗口内的轮次整轮跳过，不 claim 也不派发。 */
  let dispatchAllowedAt = 0

  /**
   * 单次查询超时包装；超时抛受控错误（结果按失败记录，不改成员事实）。
   *
   * @param promise Telegram 调用。
   * @param timeoutMs 超时毫秒（已解析的配置值）。
   * @returns 调用结果。
   */
  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timerHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timerHandle = setTimeout(
            () => reject(new TelegramSubscriptionError({ code: 'timeout', outcome: 'unavailable' })),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timerHandle !== undefined) clearTimeout(timerHandle)
    }
  }

  /**
   * 记录一次失败结果；写失败只记日志，不中断整轮。
   *
   * @param claim 本次 claim。
   * @param code 受控错误码。
   */
  async function finishFailed(claim: CheckClaim, code: string): Promise<void> {
    try {
      await deps.repos.subscriptionMembers.finishCheck(claim, {
        kind: 'failed',
        errorCode: code,
        checkedAt: now(),
      })
    } catch (error) {
      deps.logger.warn(
        `对账结果写入失败 chatId=${claim.chatId} userId=${claim.userId} code=${error instanceof Error ? error.name : typeof error}`,
      )
    }
  }

  /**
   * 跑一轮对账：claim → 有界并发查询 → finishCheck。
   *
   * @returns 本轮结果。
   */
  async function runBatch(): Promise<ReconcileRunResult> {
    const startedAt = now()
    // 上一次 429 指定的 retry_after 未到：整轮跳过，避免无派发地刷新手台账的尝试时刻。
    if (startedAt.getTime() < dispatchAllowedAt) {
      deps.logger.warn(`对账处于限流等待，跳过本轮 until=${new Date(dispatchAllowedAt).toISOString()}`)
      return { claimed: 0, applied: 0, failed: 0, skipped: 0, rateLimited: true }
    }
    // claim 的租约与尝试时刻由仓储负责取数据库 now()（spec §4.2）；这里的 now 只服务于内存实现与测试时钟。
    const claims = await deps.repos.subscriptionMembers.claimChecks({
      now: startedAt,
      limit: batchLimit,
      leaseMs,
    })
    if (claims.length === 0) return { claimed: 0, applied: 0, failed: 0, skipped: 0, rateLimited: false }

    const dispatched = new Set<number>()
    let nextIndex = 0
    let applied = 0
    let failed = 0
    let skipped = 0
    let rateLimited = false

    const worker = async (): Promise<void> => {
      for (;;) {
        if (rateLimited) return
        const index = nextIndex
        nextIndex += 1
        const claim = claims[index]
        if (claim === undefined) return
        dispatched.add(index)

        try {
          const member = await withTimeout(deps.telegram.getChatMember(claim.chatId, claim.userId), timeoutMs)
          const snapshot = snapshotOf(member)
          const outcome = await deps.repos.subscriptionMembers.finishCheck(claim, {
            kind: 'ok',
            state: snapshot.state,
            expiresAt: snapshot.expiresAt,
            returnedAt: now(),
          })
          // 查询期间有事件写入时 CAS 过期：结果丢弃，也不改事实。
          if (outcome === 'applied') applied += 1
          else skipped += 1
        } catch (error) {
          const code = controlledErrorCode(error)
          failed += 1
          if (error instanceof TelegramSubscriptionError && error.outcome === 'rate_limited') {
            // 429：停止本轮新派发，并按 retry_after 记录下次允许时刻；未给出秒数时只停本轮。
            rateLimited = true
            if (
              error.retryAfterSeconds !== null &&
              Number.isFinite(error.retryAfterSeconds) &&
              error.retryAfterSeconds > 0
            ) {
              dispatchAllowedAt = now().getTime() + error.retryAfterSeconds * 1_000
            }
          }
          await finishFailed(claim, code)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, () => worker()))

    // 未派发的 claim（429 之后的尾巴）：以受控错误码释放租约，尝试时刻保留，下一轮继续公平轮转。
    for (const [index, claim] of claims.entries()) {
      if (dispatched.has(index)) continue
      failed += 1
      await finishFailed(claim, 'rate_limited')
    }

    if (rateLimited) {
      deps.logger.warn(`对账遇到限流，本轮停止派发 claimed=${claims.length} applied=${applied} failed=${failed}`)
    }
    return { claimed: claims.length, applied, failed, skipped, rateLimited }
  }

  /**
   * single-flight 的 runOnce：已有在途轮次时返回同一 promise。
   *
   * @returns 本轮结果。
   */
  const runOnce = (): Promise<ReconcileRunResult> => {
    if (running !== null) return running
    running = runBatch().finally(() => {
      running = null
    })
    return running
  }

  return {
    start(): void {
      if (timer !== null) return
      const tick = (): void => {
        if (running !== null) {
          deps.logger.warn('上一轮订阅对账尚未结束，跳过本轮')
          return
        }
        void runOnce()
          .then((result) => {
            if (result.claimed > 0) {
              deps.logger.info(
                `订阅对账完成 claimed=${result.claimed} applied=${result.applied} failed=${result.failed} skipped=${result.skipped} rateLimited=${result.rateLimited}`,
              )
            }
          })
          .catch((error: unknown) => {
            deps.logger.warn(`订阅对账失败 code=${error instanceof Error ? error.name : typeof error}`)
          })
      }
      tick()
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
    },

    stop(): void {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },

    runOnce,

    isRunning(): boolean {
      return running !== null
    },
  }
}

/** 受控错误码：Telegram 分类优先，其余只取异常类型名。 */
function controlledErrorCode(error: unknown): string {
  if (error instanceof TelegramSubscriptionError) return error.code
  return error instanceof Error ? error.name : typeof error
}

/**
 * 把成员快照映射成台账事实。`restricted` 按 `is_member` 落到 member/left；
 * 无法识别的将来状态落到 `unknown`，不猜离开原因。
 *
 * @param member Telegram 成员对象。
 * @returns 领域状态与到期观测值。
 */
export function snapshotOf(member: ChatMember): { state: 'member' | 'left' | 'unknown'; expiresAt: Date | null } {
  switch (member.status) {
    case 'member':
      return { state: 'member', expiresAt: validUntilDate(member.until_date) }
    case 'administrator':
    case 'creator':
      return { state: 'member', expiresAt: null }
    case 'restricted':
      return { state: member.is_member ? 'member' : 'left', expiresAt: null }
    case 'left':
    case 'kicked':
      return { state: 'left', expiresAt: null }
    default:
      return { state: 'unknown', expiresAt: null }
  }
}

/** 校验 `until_date`（Unix 秒）：必须是有效正整数时间戳，否则视为未观测到。 */
function validUntilDate(value: number | undefined): Date | null {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return null
  return new Date(value * 1_000)
}
