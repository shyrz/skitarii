import type { Repos } from '@skitarii/db'
import { idempotencyKeyOf, type ActionExecutor } from './executor.js'
import type { IdempotencyRegistry } from './idempotency.js'
import type { Logger } from './logger.js'

/**
 * 未执行决策的补偿扫描。
 *
 * 为什么需要它：管线「落决策 → 施加动作」之间有一次进程崩溃的窗口。崩溃后决策停在 `executed = false`，
 * 而 Telegram 不会重投递那条 update（更新已经确认过），这个动作就永远没人再施加了：用户看到处置通知
 * 却没有被禁言，或消息还挂在群里。调度器每小时扫一遍卡住的决策补执行，是这件事唯一的兜底。
 *
 * 与执行器的关系：必须复用 bot 进程里的同一个 `ActionExecutor` 实例（见 `bot.ts` 的 `createBotRuntime`），
 * 因为它的 `IdempotencyRegistry` 记着「本进程已经施加过哪些动作」。补偿扫描在动手前先查闸门，
 * 命中就跳过本轮：回填 `executed` 与写幂等键之间同样有窗口，跳过才是安全的行为。
 *
 * 这条路径不是「重放」：命令已经下发过一次，Telegram 侧的重复后果由闸门与仓库层的 `executed` 共同避免。
 */

/**
 * 「多久没执行算卡住」。
 *
 * 取 10 分钟的来历：正常路径上决策落库与动作施加之间的间隔是秒级（含 429 退避最多几分钟），
 * 留出足够余量后仍未被回填的，才值得动用补偿；窗口太短会让正在执行的决策被并发地再试一次。
 */
export const STALE_DECISION_AGE_MS = 10 * 60 * 1_000

/**
 * 补偿扫描重试窗口的上界（只补最近 24 小时内的决策）。
 *
 * 理由：一个永远失败的动作（bot 已被移出该群、用户已注销）若一直留在候选集里，会按判定时间升序
 * 长期占满扫描额度，把新产生的未执行决策挤出去。超过一天的未执行决策本身也早已失去时效
 * （禁言时长是小时级，消息通知早已翻页），留给人工处理。
 */
export const DECISION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000

/** 单轮扫描的条数上限：维护任务是小时级的，一次拉全表没有意义，剩下的一小时后再来。 */
export const DECISION_RETRY_SCAN_LIMIT = 50

/** 一轮补偿扫描的结果，用于日志与测试断言。 */
export interface DecisionRetryResult {
  /** 扫描到的候选决策数。 */
  scanned: number
  /** 交给执行器重试的条数（含执行器判定为终态的）。 */
  retried: number
  /** 幂等闸门已命中、本轮跳过的条数。 */
  skipped: number
  /** 找不到事件行、无法重建执行上下文的条数。 */
  orphaned: number
}

/** 补偿扫描服务。 */
export interface DecisionRetryService {
  /** 扫一轮卡住的决策并重试执行。 */
  runOnce(): Promise<DecisionRetryResult>
}

/** 补偿扫描依赖。 */
export interface DecisionRetryDeps {
  repos: Repos
  /** 与管线共用同一个实例：幂等闸门是「已经施加过」的唯一进程内证据。 */
  executor: ActionExecutor
  idempotency: IdempotencyRegistry
  logger: Logger
  /** 时间源，默认系统时间。显式允许 `undefined`，让调用方可以直接透传可选配置。 */
  now?: (() => Date) | undefined
  /** 单轮上限，默认 {@link DECISION_RETRY_SCAN_LIMIT}。 */
  limit?: number | undefined
}

/**
 * 建立补偿扫描服务。
 *
 * @param deps 仓储、执行器、幂等闸门、日志与时间源。
 * @returns 补偿扫描服务。
 */
export function createDecisionRetryService(deps: DecisionRetryDeps): DecisionRetryService {
  const now = deps.now ?? (() => new Date())
  const limit = deps.limit ?? DECISION_RETRY_SCAN_LIMIT

  return {
    async runOnce(): Promise<DecisionRetryResult> {
      const instant = now()
      const candidates = await deps.repos.decisions.listUnexecutedBetween(
        new Date(instant.getTime() - DECISION_RETRY_WINDOW_MS),
        new Date(instant.getTime() - STALE_DECISION_AGE_MS),
        limit,
      )

      let retried = 0
      let skipped = 0
      let orphaned = 0

      for (const decision of candidates) {
        if (deps.idempotency.has(idempotencyKeyOf(decision))) {
          skipped += 1
          continue
        }

        // 删除动作需要 message_id，执行上下文只能从事件行重建。
        const stored = await deps.repos.events.findWithSample(decision.eventId)
        if (stored === null) {
          // 事件已被保留期清理（30 天）连带删掉，而决策没执行。无法重建上下文，只能放弃；
          // 记录的用处是让运维知道有这类残留，而不是静默跳过。
          deps.logger.warn(`补偿扫描找不到事件行，无法重建上下文 decisionId=${decision.id} eventId=${decision.eventId}`)
          orphaned += 1
          continue
        }

        try {
          await deps.executor.execute(decision, { messageId: stored.event.messageId })
          retried += 1
        } catch (error) {
          // 单条失败不阻断其余：与维护任务的其他步骤同口径，下一轮会再试。
          deps.logger.warn(`补偿执行失败，留待下一轮 decisionId=${decision.id}`, error)
        }
      }

      return { scanned: candidates.length, retried, skipped, orphaned }
    },
  }
}
