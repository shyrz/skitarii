import type { Api } from 'grammy'
import type { Message } from 'grammy/types'

/**
 * Telegram API 的录制替身，仅测试使用。
 *
 * 覆盖审核链路会调到的几个方法：每个调用被记录下来，可注入失败以验证重试与终结策略。
 * 返回值的形状只保证调用方能走通（`sendMessage` 返回一个带 `message_id` 的对象），
 * 业务代码不读这些字段，因此不做完整模拟。
 */

/** 录制替身覆盖的方法名。 */
export type RecordedApiMethod =
  | 'sendMessage'
  | 'deleteMessage'
  | 'restrictChatMember'
  | 'banChatMember'
  | 'unbanChatMember'
  | 'answerCallbackQuery'
  | 'editMessageText'

const METHODS: readonly RecordedApiMethod[] = [
  'sendMessage',
  'deleteMessage',
  'restrictChatMember',
  'banChatMember',
  'unbanChatMember',
  'answerCallbackQuery',
  'editMessageText',
]

/** 录制的调用。 */
export interface RecordedCall {
  method: RecordedApiMethod
  args: unknown[]
}

/** 录制替身。 */
export interface RecordingApi {
  api: Api
  calls: RecordedCall[]
  /** 某个方法被调用的次数。 */
  countOf(method: RecordedApiMethod): number
  /** 某个方法最后一次调用的参数。 */
  lastArgsOf(method: RecordedApiMethod): unknown[] | undefined
}

/** 方法处理器：返回结果或抛错，不传则默认成功。 */
export type RecordingApiHandlers = Partial<Record<RecordedApiMethod, (...args: never[]) => unknown>>

/**
 * 建立录制替身。
 *
 * @param handlers 逐方法的处理器，可用来让某次调用抛错。
 * @returns 替身、调用记录与查询辅助。
 */
export function createRecordingApi(handlers: RecordingApiHandlers = {}): RecordingApi {
  const calls: RecordedCall[] = []
  const stub: Record<RecordedApiMethod, (...args: unknown[]) => Promise<unknown>> = Object.fromEntries(
    METHODS.map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args })
        const handler = handlers[method]
        if (handler !== undefined) return await (handler as (...inner: unknown[]) => unknown)(...args)
        return { message_id: 1 } satisfies Partial<Message>
      },
    ]),
  ) as Record<RecordedApiMethod, (...args: unknown[]) => Promise<unknown>>

  return {
    // 只实现了审核链路用到的方法，因此这里必须断言成完整的 Api。
    api: stub as unknown as Api,
    calls,
    countOf: (method) => calls.filter((call) => call.method === method).length,
    lastArgsOf: (method) => calls.filter((call) => call.method === method).at(-1)?.args,
  }
}
