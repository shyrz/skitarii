/**
 * 群内出站消息的令牌桶。
 *
 * 存在理由：Telegram 对单个群/频道的出站消息有约 20 条/分钟的限制，超发会拿到 429 并连带影响
 * 处置动作的调用。警示语与处置通知属于「可丢」消息：动作已经施加，通知只是告知，
 * 因此宁可少发一条，也不能为了发提示而拖慢或阻塞审核路径。
 *
 * 实现是每个群一个桶，惰性重建：桶只在发消息时出现，进程重启即重置（限速窗口以分钟计，
 * 重启后从满桶开始是可接受的，因为重启本身已经隔开了突发）。
 */

/** 桶的默认容量：允许一条处置连着发（动作通知 + 可能的后续提示）而不等待。 */
export const DEFAULT_BUCKET_CAPACITY = 3

/** 默认补充速率（条/分钟），取 Telegram 群级上限 20 的安全值。 */
export const DEFAULT_REFILL_PER_MINUTE = 20

/** 令牌桶。 */
export interface TokenBucket {
  /**
   * 尝试取一个令牌。
   *
   * @param key 桶的标识（这里是 chatId）。
   * @returns 取到为 `true`；桶空为 `false`，调用方应放弃本次发送。
   */
  tryTake(key: string): boolean
  /** 当前可用的令牌数（含小数），用于日志与测试。 */
  tokensLeft(key: string): number
}

/**
 * 建立令牌桶集合。
 *
 * @param options.capacity 桶容量，默认 {@link DEFAULT_BUCKET_CAPACITY}。
 * @param options.refillPerMinute 每分钟补充数，默认 {@link DEFAULT_REFILL_PER_MINUTE}。
 * @param options.now 时间源，默认 `Date.now`。
 * @returns 令牌桶。
 */
export function createTokenBucket(
  options: { capacity?: number; refillPerMinute?: number; now?: () => number } = {},
): TokenBucket {
  const capacity = options.capacity ?? DEFAULT_BUCKET_CAPACITY
  const refillPerMinute = options.refillPerMinute ?? DEFAULT_REFILL_PER_MINUTE
  const now = options.now ?? Date.now
  const buckets = new Map<string, { tokens: number; updatedAt: number }>()

  /**
   * 按经过的时间补充令牌。
   *
   * @param bucket 桶状态，原地更新。
   * @param instant 当前时间。
   */
  function refill(bucket: { tokens: number; updatedAt: number }, instant: number): void {
    const elapsedMinutes = (instant - bucket.updatedAt) / 60_000
    if (elapsedMinutes <= 0) return
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMinutes * refillPerMinute)
    bucket.updatedAt = instant
  }

  return {
    tryTake(key: string): boolean {
      const instant = now()
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: instant }
      refill(bucket, instant)

      if (bucket.tokens < 1) {
        buckets.set(key, bucket)
        return false
      }

      bucket.tokens -= 1
      buckets.set(key, bucket)
      return true
    },

    tokensLeft(key: string): number {
      const instant = now()
      const bucket = buckets.get(key)
      if (bucket === undefined) return capacity
      refill(bucket, instant)
      return bucket.tokens
    },
  }
}
