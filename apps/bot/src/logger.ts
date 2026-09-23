/**
 * bot 进程的日志出口。
 *
 * 本仓库的依赖清单里没有日志库，`console` 是 Phase 1 的临时实现：所有业务代码只依赖 `Logger` 接口，
 * 接入结构化日志（pino 一类）时只替换 `createLogger`，调用点不动。
 *
 * 约定：日志消息带作用域前缀与关键 id（eventId / decisionId / chatId），
 * 排查一次误判或一次执行失败时不需要去猜是哪条消息。
 */

/** 日志接口。`error` 为可选的原始异常，实现负责序列化它。 */
export interface Logger {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

/**
 * 建立带作用域前缀的日志器。
 *
 * @param scope 作用域名，通常是模块名，例如 `bot`、`pipeline`、`executor`。
 * @returns 日志器。
 */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`
  return {
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message, error) => console.warn(`${prefix} ${message}`, ...formatDetail(error)),
    error: (message, error) => console.error(`${prefix} ${message}`, ...formatDetail(error)),
  }
}

/**
 * 把可选的错误对象整理成参数列表。`undefined` 时不追加空参数，避免日志里出现悬空的 `undefined`。
 *
 * @param error 原始异常。
 * @returns 可直接展开进 console 调用的参数。
 */
function formatDetail(error: unknown): [] | [unknown] {
  return error === undefined ? [] : [error]
}
