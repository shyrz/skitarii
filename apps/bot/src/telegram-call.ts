import { GrammyError } from 'grammy'
import type { Logger } from './logger.js'

/**
 * Telegram API 调用的重试包装。
 *
 * 只处理一种可恢复失败：429（限流）。Telegram 在 429 响应里给出 `retry_after`（秒），
 * 按它退避是官方建议的做法；其余错误（权限不足、消息已被删除、网络层失败）立即抛出，
 * 由调用方决定是终结还是让决策保持「未执行」等待重投递。
 *
 * 退避在 `retry_after` 之上再加 0..20% 的随机抖动：同一时刻被限流的多个调用（并发处置、跨群群发）
 * 会拿到同一个 `retry_after`，若都按精确值醒来就会同步重试，把限流窗口再撞一次；
 * 抖动把重试时刻摊开，代价只是最多晚 20% 出发。
 *
 * 为什么不用 `@grammyjs/auto-retry` 插件：本仓库冻结依赖，插件不在清单里，
 * 而需要的只有「读 retry_after 后 sleep 重试」这一条规则。
 */

/** 遇到 429 时最多尝试的次数（含首次）。 */
export const DEFAULT_MAX_ATTEMPTS = 3

/** 在 `retry_after` 之上额外等待的毫秒数：Telegram 的秒级取整可能让我们提前一点点到达。 */
const RETRY_AFTER_BUFFER_MS = 500

/** 抖动的比例上限：退避时长的 0..20%。 */
const JITTER_RATIO = 0.2

/**
 * 计算一次 429 退避的等待时长。
 *
 * @param retryAfterMs Telegram 给出的等待毫秒数。
 * @param random 0..1 的随机源，默认 `Math.random`；测试注入固定值以获得确定性。
 * @returns `retry_after + 缓冲` 再叠加 0..20% 抖动后的毫秒数。
 */
export function backoffDelayMs(retryAfterMs: number, random: () => number = Math.random): number {
  const base = retryAfterMs + RETRY_AFTER_BUFFER_MS
  return Math.round(base * (1 + random() * JITTER_RATIO))
}

/** 重试依赖。 */
export interface RetryOptions {
  logger: Logger
  /** 调用标签，用于日志，例如 `deleteMessage`。 */
  label: string
  /** 最大尝试次数，默认 {@link DEFAULT_MAX_ATTEMPTS}。 */
  maxAttempts?: number
  /** sleep 实现，默认 `setTimeout`，测试可注入以避免真实等待。 */
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/**
 * 执行一次 Telegram API 调用，遇 429 按 `retry_after` 退避重试。
 *
 * @param call 实际调用（`() => api.xxx(...)`）。
 * @param options 日志、标签与重试参数。
 * @returns 调用结果。
 * @throws {GrammyError} 非 429 的 API 错误，或重试次数耗尽后的 429。
 * @throws {unknown} 网络层错误原样抛出。
 */
export async function callWithRetry<T>(call: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const sleep = options.sleep ?? defaultSleep

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      const retryAfterMs = retryAfterOf(error)
      if (retryAfterMs === null || attempt >= maxAttempts) throw error

      const delayMs = backoffDelayMs(retryAfterMs)
      options.logger.warn(`${options.label} 被限流，${delayMs}ms 后重试（第 ${attempt} 次）`)
      await sleep(delayMs)
    }
  }
}

/**
 * 读取 429 响应里的 `retry_after`。
 *
 * @param error 捕获到的异常。
 * @returns 需要等待的毫秒数；不是 429 时为 `null`。
 */
export function retryAfterOf(error: unknown): number | null {
  if (!(error instanceof GrammyError)) return null
  if (error.error_code !== 429) return null
  const retryAfterSeconds = error.parameters.retry_after
  if (typeof retryAfterSeconds !== 'number' || retryAfterSeconds < 0) return null
  return retryAfterSeconds * 1_000
}

/**
 * 默认的等待实现。
 *
 * @param ms 等待毫秒数。
 * @returns 等待完成的 Promise。
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
