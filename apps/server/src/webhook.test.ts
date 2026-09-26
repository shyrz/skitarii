import { pollingStartOptions, TELEGRAM_ALLOWED_UPDATES, type Logger } from '@skitarii/bot'
import { describe, expect, test } from 'vitest'
import { registerWebhook, type WebhookApi } from './webhook.js'

/**
 * webhook 注册的行为测试：只关心提交给 Telegram 的地址、secret_token 与 allowed_updates，
 * 以及失败时进程不被拖垮。真实 `Api` 与日志出口都用替身，测试不碰网络。
 */

/** 一条日志记录。 */
interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
}

/**
 * 记录日志的替身。
 *
 * @param entries 记录落点，由调用方断言。
 * @returns 满足 `Logger` 接口的替身。
 */
function recordingLogger(entries: LogEntry[]): Logger {
  return {
    info: (message) => entries.push({ level: 'info', message }),
    warn: (message) => entries.push({ level: 'warn', message }),
    error: (message) => entries.push({ level: 'error', message }),
  }
}

/** 一次 `setWebhook` 调用的记录。 */
interface RecordedWebhookCall {
  url: string
  secretToken: string | undefined
  allowedUpdates: readonly string[] | undefined
}

/**
 * 记录 `setWebhook` 参数的 Bot API 替身。
 *
 * @param calls 调用落点，由调用方断言。
 * @returns 满足 `WebhookApi` 接口的替身。
 */
function recordingApi(calls: RecordedWebhookCall[]): WebhookApi {
  return {
    setWebhook: async (url, other) => {
      calls.push({ url, secretToken: other?.secret_token, allowedUpdates: other?.allowed_updates })
      return true
    },
  }
}

describe('webhook 注册', () => {
  test('地址由 publicUrl 拼出，secret_token 原样提交', async () => {
    const calls: RecordedWebhookCall[] = []
    await registerWebhook({
      api: recordingApi(calls),
      publicUrl: 'https://bot.example.com',
      secretToken: 's3cret',
      logger: recordingLogger([]),
    })

    expect(calls).toEqual([
      {
        url: 'https://bot.example.com/telegram/webhook',
        secretToken: 's3cret',
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
      },
    ])
  })

  test('allowed_updates 与长轮询入口同源，且覆盖既有与新增的处理类型', async () => {
    const calls: RecordedWebhookCall[] = []
    await registerWebhook({
      api: recordingApi(calls),
      publicUrl: 'https://bot.example.com',
      secretToken: 's3cret',
      logger: recordingLogger([]),
    })

    // 同一个常量对象：webhook 与长轮询共用一份名单，任何一侧新增类型都会同时生效。
    expect(calls[0]?.allowedUpdates).toBe(TELEGRAM_ALLOWED_UPDATES)
    expect(pollingStartOptions().allowed_updates).toBe(TELEGRAM_ALLOWED_UPDATES)
    // 既有更新一个都不能漏。
    expect(TELEGRAM_ALLOWED_UPDATES).toEqual([
      'message',
      'edited_message',
      'callback_query',
      'channel_post',
      'my_chat_member',
      'chat_member',
    ])
  })

  test('publicUrl 带尾部斜杠时不拼出双斜杠', async () => {
    const calls: RecordedWebhookCall[] = []
    await registerWebhook({
      api: recordingApi(calls),
      publicUrl: 'https://bot.example.com//',
      secretToken: 's3cret',
      logger: recordingLogger([]),
    })

    expect(calls).toEqual([
      {
        url: 'https://bot.example.com/telegram/webhook',
        secretToken: 's3cret',
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
      },
    ])
  })

  test('注册失败只记 warn，不向调用方抛错', async () => {
    const entries: LogEntry[] = []
    await expect(
      registerWebhook({
        api: {
          setWebhook: async () => {
            throw new Error('network down')
          },
        },
        publicUrl: 'https://bot.example.com',
        secretToken: 's3cret',
        logger: recordingLogger(entries),
      }),
    ).resolves.toBeUndefined()

    expect(entries.map((entry) => entry.level)).toEqual(['warn'])
    expect(entries[0]?.message).toContain('https://bot.example.com/telegram/webhook')
  })
})
