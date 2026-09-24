import type { DailyAggregate } from '@skitarii/core'
import type { Repos } from '@skitarii/db'
import type {
  AppealNotificationService,
  AppealRollbackService,
  DecisionRetryService,
  Logger,
} from '@skitarii/bot'

/**
 * 进程内调度器：日聚合重算、保留期清理，以及三条「兜底重试」扫描。
 *
 * 为什么放在 server 进程：它已经有数据库连接并且常驻，而 bot 进程可能以长轮询方式跑在开发机上。
 * 两个进程都跑调度器会重复计算（`upsert` 幂等，不致命但浪费连接），因此约定只有 server 启动它。
 *
 * 两个维护任务不要求实时：重算是小时级，清理是天级。用 `setInterval` 而不是 cron 是刻意的选择：
 * 自用部署只有一两个进程，多引入一个调度组件不值得；`unref` 让定时器不阻止进程退出。
 *
 * 三条补偿扫描（未执行决策、未通知申诉、未完成回滚）由 bot 侧提供：它们的实现要复用 bot 的执行器、
 * 申诉通知与权限回滚逻辑，见 `@skitarii/bot` 的 `createBotRuntime`。未提供时跳过对应步骤（测试与不驱动 bot 的场景）。
 */

/**
 * 明细保留期（天）。
 *
 * 30 天的来历：申诉在处置当天就会提交（Mini App 入口就在通知里），处理通常也在几天内完成，
 * 30 天给了「事后复盘一次误判」足够的时间窗，同时让消息事件与复核缓存这两张增长最快的表
 * 保持在一个月的规模。缩小它不会破坏功能（申诉页只读已存在的摘录），放大它要先确认隐私口径。
 */
export const DETAIL_RETENTION_DAYS = 30

/** 聚合重算的间隔（毫秒）。小时级足够让看板「差不多是新的」，又不至于反复扫表。 */
export const DEFAULT_ROLLUP_INTERVAL_MS = 60 * 60 * 1_000

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1_000

/** 维护任务的执行结果，用于日志与测试断言。 */
export interface MaintenanceResult {
  /** 重算覆盖的日期（UTC，YYYY-MM-DD），昨天与今天。 */
  dates: string[]
  /** 写入的聚合行数。 */
  rolledUp: number
  /** 清理掉的消息事件数。 */
  purgedEvents: number
  /** 清理掉的复核缓存条目数。 */
  purgedCacheEntries: number
  /** 补偿扫描重新执行（含判定为终态）的决策数。 */
  retriedDecisions: number
  /** 补发成功的 owner 申诉通知数。 */
  resentAppeals: number
  /** 权限回滚补偿清掉标记的申诉数。 */
  retriedRollbacks: number
}

/** 调度器依赖。 */
export interface SchedulerDeps {
  repos: Repos
  logger: Logger
  /** 未执行决策的补偿扫描（bot 提供，与执行器共享幂等闸门）。不提供则跳过。 */
  retryDecisions?: DecisionRetryService | undefined
  /** 未通知申诉的补发扫描（bot 提供）。不提供则跳过。 */
  resendAppeals?: AppealNotificationService | undefined
  /** 已撤销但权限未回滚的补偿扫描（bot 提供）。不提供则跳过。 */
  retryRollbacks?: AppealRollbackService | undefined
  /** 时间源，默认系统时间。 */
  now?: (() => Date) | undefined
  /** 重算间隔，默认 {@link DEFAULT_ROLLUP_INTERVAL_MS}。 */
  intervalMs?: number | undefined
}

/** 调度器。 */
export interface Scheduler {
  /** 立即跑一次，然后按间隔重复。 */
  start(): void
  /** 停止定时器（在途的执行不会被中断）。 */
  stop(): void
  /** 手工触发一次维护，返回结果。 */
  runOnce(): Promise<MaintenanceResult>
}

/**
 * 建立调度器。
 *
 * @param deps 仓储、日志、三条补偿扫描与时间源。
 * @returns 调度器。
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: ReturnType<typeof setInterval> | null = null
  /** 上一轮是否还在跑。定时器只负责触发，不负责排队：一轮没跑完时直接跳过这一拍。 */
  let inFlight = false

  const runOnce = (): Promise<MaintenanceResult> => runMaintenance(deps)

  /**
   * 定时触发的一轮。
   *
   * 为什么要守卫：一轮维护的耗时随群数量与 Telegram 延迟变化，可能超过间隔（尤其是把 `intervalMs`
   * 调小的排障场景）。不守卫的话，后一轮会在前一轮还没提交完时叠加执行，聚合与清理重复扫表，
   * 三条补偿扫描还可能对同一条决策/申诉并发动手。宁可丢一拍，也不要并发跑两轮。
   */
  const tick = (): void => {
    if (inFlight) {
      deps.logger.warn('上一轮维护尚未结束，跳过本轮')
      return
    }

    inFlight = true
    void runOnce()
      .then((result) => deps.logger.info(formatResult(result)))
      .catch((error: unknown) => deps.logger.error('维护任务失败', error))
      .finally(() => {
        inFlight = false
      })
  }

  return {
    start(): void {
      if (timer !== null) return
      tick()

      timer = setInterval(tick, deps.intervalMs ?? DEFAULT_ROLLUP_INTERVAL_MS)
      // 定时器不该阻止进程退出：收到信号时由 shutdown 流程负责收尾。
      timer.unref?.()
    },

    stop(): void {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },

    runOnce,
  }
}

/**
 * 跑一轮维护：重算昨天与今天的聚合，按保留期清理明细，然后跑三条补偿扫描。
 *
 * 单个群或单个步骤失败只记日志并继续：调度是尽力而为，下一轮会重来，
 * 不该因为一个群的坏数据让其他群的数据也停止更新。
 *
 * @param deps 调度器依赖。
 * @returns 本轮结果。
 */
export async function runMaintenance(deps: SchedulerDeps): Promise<MaintenanceResult> {
  const now = deps.now ?? (() => new Date())
  const instant = now()
  const dates = [dateOf(new Date(instant.getTime() - DAY_MS)), dateOf(instant)]

  const chats = await deps.repos.chats.listAll()
  let rolledUp = 0

  for (const date of dates) {
    const { from, to } = windowOf(date)
    for (const chat of chats) {
      try {
        const counts = await deps.repos.aggregates.countForDay(chat.chatId, from, to)
        const aggregate: DailyAggregate = { chatId: chat.chatId, date, ...counts }
        await deps.repos.aggregates.upsert(aggregate)
        rolledUp += 1
      } catch (error) {
        deps.logger.warn(`聚合重算失败 chatId=${chat.chatId} date=${date}`, error)
      }
    }
  }

  const cutoff = new Date(instant.getTime() - DETAIL_RETENTION_DAYS * DAY_MS)
  let purgedEvents = 0
  let purgedCacheEntries = 0
  try {
    purgedEvents = await deps.repos.events.deleteOlderThan(cutoff)
  } catch (error) {
    deps.logger.warn('消息事件清理失败', error)
  }
  try {
    purgedCacheEntries = await deps.repos.llmCache.deleteOlderThan(cutoff)
  } catch (error) {
    deps.logger.warn('复核缓存清理失败', error)
  }

  let retriedDecisions = 0
  if (deps.retryDecisions !== undefined) {
    try {
      const result = await deps.retryDecisions.runOnce()
      retriedDecisions = result.retried
      if (result.scanned > 0) {
        deps.logger.info(
          `补偿扫描完成 scanned=${result.scanned} retried=${result.retried} skipped=${result.skipped} orphaned=${result.orphaned}`,
        )
      }
    } catch (error) {
      deps.logger.warn('未执行决策的补偿扫描失败', error)
    }
  }

  let resentAppeals = 0
  if (deps.resendAppeals !== undefined) {
    try {
      const result = await deps.resendAppeals.runOnce()
      resentAppeals = result.sent
      if (result.scanned > 0) {
        deps.logger.info(
          `申诉通知补发完成 scanned=${result.scanned} sent=${result.sent} failed=${result.failed}`,
        )
      }
    } catch (error) {
      deps.logger.warn('未通知申诉的补发扫描失败', error)
    }
  }

  let retriedRollbacks = 0
  if (deps.retryRollbacks !== undefined) {
    try {
      const result = await deps.retryRollbacks.runOnce()
      retriedRollbacks = result.cleared
      if (result.scanned > 0) {
        deps.logger.info(
          `权限回滚补偿完成 scanned=${result.scanned} cleared=${result.cleared} failed=${result.failed}`,
        )
      }
    } catch (error) {
      deps.logger.warn('权限回滚补偿扫描失败', error)
    }
  }

  return { dates, rolledUp, purgedEvents, purgedCacheEntries, retriedDecisions, resentAppeals, retriedRollbacks }
}

/**
 * 把时刻换算成 UTC 日期串（YYYY-MM-DD）。
 *
 * 取舍：Phase 1 用 UTC 切日。群配置里没有时区字段（`ChatConfig` 是冻结形状），
 * 而自用场景的群集中在同一时区，UTC 切日的偏差只影响看板上「昨天/今天」的边界，
 * 不影响误伤率一类比值。加时区支持要动配置形状，留到 Phase 2。
 *
 * @param instant 时刻。
 * @returns YYYY-MM-DD。
 */
export function dateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

/**
 * 把日期串换算成左闭右开的时间窗。
 *
 * @param date YYYY-MM-DD。
 * @returns `from` 为当天 00:00:00Z，`to` 为次日 00:00:00Z。
 */
export function windowOf(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00.000Z`)
  return { from, to: new Date(from.getTime() + DAY_MS) }
}

/**
 * 把结果整理成一行日志。
 *
 * @param result 维护结果。
 * @returns 可读的单行摘要。
 */
function formatResult(result: MaintenanceResult): string {
  return [
    `维护完成 dates=${result.dates.join(',')}`,
    `rolledUp=${result.rolledUp}`,
    `purgedEvents=${result.purgedEvents}`,
    `purgedCache=${result.purgedCacheEntries}`,
    `retriedDecisions=${result.retriedDecisions}`,
    `resentAppeals=${result.resentAppeals}`,
    `retriedRollbacks=${result.retriedRollbacks}`,
  ].join(' ')
}
