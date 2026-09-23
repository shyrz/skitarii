/**
 * 处置动作的幂等闸门。
 *
 * 需要它是因为 Telegram 的重投递与进程内的重试都可能让同一个动作被请求两次，而
 * 「删除一条已被删除的消息」「再次禁言同一用户」在 Telegram 侧不是无害操作：前者报 400，
 * 后者会把禁言时间重置。闸门的键是 `eventId + action`，与事件 id 一样是确定性的。
 *
 * 行为：
 * - 第一次调用按 `task` 执行；执行期间到达的相同键的调用共享同一个 Promise（并发去重）。
 * - 未完成的任务不过期：TTL 从 `task` 成功 settle 的时刻起算。执行耗时可能超过 TTL（Telegram 抖动、
 *   429 退避叠加），若从发起时刻起算，键会在任务还没结束时失效，后来的调用会重复施加同一个动作。
 * - 执行成功后键在 TTL 内保留，期间重复调用直接返回首次结果，不再执行 `task`。
 * - 执行失败时立即删除键：失败通常意味着「动作没施加」，此时必须允许重试。
 *
 * 与数据库侧的 `moderation_decisions.executed` 是两层防线：这里挡进程内的重复，
 * 数据库那层挡跨进程、跨重启的重复（崩溃恢复后重新读决策时看 `executed`）。
 */

/** 键在成功执行后保留的时长。 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

/** 幂等闸门。 */
export interface IdempotencyRegistry {
  /**
   * 按 `key` 执行一次。
   *
   * @param key 幂等键，约定为 `${eventId}:${action}`。
   * @param task 首次调用时执行的动作。
   * @returns `task` 的返回值；重复调用返回首次执行的结果。
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T>
  /** 该键是否「已受理」：正在执行中，或已成功执行且仍在保留期内。补偿扫描据此跳过本轮。 */
  has(key: string): boolean
  /** 当前保留的键数量，用于日志与泄漏排查。 */
  size(): number
}

/**
 * 建立幂等闸门。
 *
 * @param options.ttlMs 成功后的保留时长，默认 {@link DEFAULT_IDEMPOTENCY_TTL_MS}。
 * @param options.now 时间源，默认 `Date.now`，测试可注入。
 * @returns 幂等闸门实例。
 */
export function createIdempotencyRegistry(options: { ttlMs?: number; now?: () => number } = {}): IdempotencyRegistry {
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS
  const now = options.now ?? Date.now
  /** `expiresAt` 为 `null` 表示任务尚未结束：pending 项不参与过期淘汰。 */
  const entries = new Map<string, { result: Promise<unknown>; expiresAt: number | null }>()

  /**
   * 清掉已过期的键。只在写入路径上顺手做，避免为它单开定时器；
   * 键的数量与「窗口内的处置数」同阶，不需要更复杂的淘汰策略。
   */
  function sweep(instant: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= instant) entries.delete(key)
    }
  }

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const instant = now()
      const existing = entries.get(key)
      // pending 或仍在保留期：共享首次执行的结果（同一个 Promise）。
      if (existing !== undefined && (existing.expiresAt === null || existing.expiresAt > instant)) {
        return existing.result as Promise<T>
      }
      if (existing !== undefined) entries.delete(key)

      sweep(instant)

      // 先占键再调用 task：占位时 result 是临时值，同步返回后立刻换成真实 Promise。
      // 这样同步抛错的 task 不会把垃圾条目留在表里（见下面的 catch）。
      const entry: { result: Promise<unknown>; expiresAt: number | null } = { result: Promise.resolve(), expiresAt: null }
      entries.set(key, entry)

      let result: Promise<T>
      try {
        result = task()
      } catch (error) {
        entries.delete(key)
        throw error
      }
      entry.result = result

      // 成功后才起算 TTL：从 settle 时刻起算，执行本身可以比 TTL 长。
      result.then(
        () => {
          entry.expiresAt = now() + ttlMs
        },
        () => {
          // 失败即放行重试：把失败也缓存住会让一次瞬时故障永久吞掉这条处置。
          if (entries.get(key) === entry) entries.delete(key)
        },
      )

      return result
    },

    has(key: string): boolean {
      const entry = entries.get(key)
      if (entry === undefined) return false
      return entry.expiresAt === null || entry.expiresAt > now()
    },

    size(): number {
      return entries.size
    },
  }
}
