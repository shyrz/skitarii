import { asChatId, asUserId } from '@skitarii/core'
import { GrammyError } from 'grammy'
import type { Context } from 'grammy'
import { describe, expect, test } from 'vitest'
import { createFeedDeleteCallbackHandler, FEED_DELETE_CALLBACK_PATTERN } from './feed-actions.js'
import type { Logger } from './logger.js'
import { feedDeleteKeyboard } from './owner-feed.js'
import { createRecordingApi } from './recording-api.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const ownerId = asUserId(1_000_000_001)
const chatId = '-1001692471411'
const messageId = 42
const callbackData = `feeddel:${chatId}:${messageId}`
const feedText = '📋 判定：警示（0.40）'

/** 摘要编辑的固定参数：显式空键盘清按钮，HTML 与发送侧一致。 */
const CLEAR_KEYBOARD = { reply_markup: { inline_keyboard: [] }, parse_mode: 'HTML' }

/**
 * 捕获 warn 的日志器。
 *
 * @returns 日志器与收到的 warn 记录。
 */
function warnCapture(): { logger: Logger; warnings: Array<{ message: string; error: unknown }> } {
  const warnings: Array<{ message: string; error: unknown }> = []
  return {
    logger: {
      info: () => {},
      warn: (message, error) => warnings.push({ message, error }),
      error: () => {},
    },
    warnings,
  }
}

/**
 * 构造回调上下文替身。
 *
 * @param options 点击者 id、callback_data、摘要文本、是否完全没有回调消息、编辑/回执注入的失败。
 * @returns 上下文、回执记录与 `editMessageText` 的完整调用参数。
 */
function createContext(options: {
  fromId: number
  data?: string
  text?: string | undefined
  omitMessage?: boolean
  editError?: unknown
  answerError?: unknown
}) {
  const answers: Array<{ text?: string; show_alert?: boolean }> = []
  const editCalls: unknown[][] = []
  const ctx = {
    callbackQuery: {
      data: options.data ?? callbackData,
      ...(options.omitMessage === true ? {} : { message: options.text === undefined ? {} : { text: options.text } }),
    },
    from: { id: options.fromId, is_bot: false, first_name: 'owner' },
    async answerCallbackQuery(payload?: string | { text?: string; show_alert?: boolean }) {
      if (options.answerError !== undefined) throw options.answerError
      answers.push(typeof payload === 'string' ? { text: payload } : (payload ?? {}))
    },
    async editMessageText(...args: unknown[]) {
      if (options.editError !== undefined) throw options.editError
      editCalls.push(args)
    },
  }
  return { ctx: ctx as unknown as Context, answers, editCalls }
}

describe('feed「删除消息」回调', () => {
  test('owner 点按：删除消息、回执「已删除」，摘要追加标记并带显式空键盘', async () => {
    const recording = createRecordingApi()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const { ctx, answers, editCalls } = createContext({ fromId: ownerId, text: feedText })

    await handler(ctx, async () => {})

    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, messageId])
    expect(answers).toEqual([{ text: '已删除' }])
    expect(editCalls).toEqual([[`${feedText}\n\n✅ 已删除`, CLEAR_KEYBOARD]])
  })

  test('非 owner：只弹提示，不删除也不编辑', async () => {
    const recording = createRecordingApi()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const { ctx, answers, editCalls } = createContext({ fromId: ownerId + 1, text: feedText })

    await handler(ctx, async () => {})

    expect(recording.calls).toEqual([])
    expect(answers).toEqual([{ text: '只有管理员可以操作', show_alert: true }])
    expect(editCalls).toEqual([])
  })

  test.each(['Bad Request: message to delete not found', 'Bad Request: message not found'])(
    '「消息已不存在」按目标达成收尾：%s',
    async (description) => {
      const recording = createRecordingApi({
        deleteMessage: () => {
          throw new GrammyError(
            'Call to deleteMessage failed',
            { ok: false, error_code: 400, description },
            'deleteMessage',
            {},
          )
        },
      })
      const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
      const { ctx, answers, editCalls } = createContext({ fromId: ownerId, text: feedText })

      await handler(ctx, async () => {})

      expect(answers).toEqual([{ text: '消息已不存在' }])
      expect(editCalls).toEqual([[`${feedText}\n\n⚠️ 消息已不存在（可能已被删除）`, CLEAR_KEYBOARD]])
    },
  )

  test('其他 Telegram 错误：弹出原因、不编辑（键盘保留可重试）', async () => {
    const description = 'Bad Request: not enough rights to delete the message'
    const recording = createRecordingApi({
      deleteMessage: () => {
        throw new GrammyError(
          'Call to deleteMessage failed',
          { ok: false, error_code: 400, description },
          'deleteMessage',
          {},
        )
      },
    })
    const { logger, warnings } = warnCapture()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger })
    const { ctx, answers, editCalls } = createContext({ fromId: ownerId, text: feedText })

    await handler(ctx, async () => {})

    expect(answers).toEqual([{ text: `删除失败：${description}`, show_alert: true }])
    expect(editCalls).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(`feed 删除消息失败 chatId=${chatId} messageId=${messageId}`)
  })

  test('非 Telegram 错误（网络抖动）同样弹出原因', async () => {
    const recording = createRecordingApi({
      deleteMessage: () => {
        throw new Error('fetch failed')
      },
    })
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const { ctx, answers } = createContext({ fromId: ownerId, text: feedText })

    await handler(ctx, async () => {})

    expect(answers).toEqual([{ text: '删除失败：fetch failed', show_alert: true }])
  })

  test('幂等：摘要已含终态标记时删除照常执行，不再追加标记但仍清键盘', async () => {
    const recording = createRecordingApi()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const marked = `${feedText}\n\n✅ 已删除`
    const { ctx, answers, editCalls } = createContext({ fromId: ownerId, text: marked })

    await handler(ctx, async () => {})

    expect(recording.lastArgsOf('deleteMessage')).toEqual([chatId, messageId])
    expect(answers).toEqual([{ text: '已删除' }])
    expect(editCalls).toEqual([[marked, CLEAR_KEYBOARD]])
  })

  test('幂等：另一种终态标记已存在同样不再追加', async () => {
    const recording = createRecordingApi()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const marked = `${feedText}\n\n⚠️ 消息已不存在（可能已被删除）`
    const { ctx, editCalls } = createContext({ fromId: ownerId, text: marked })

    await handler(ctx, async () => {})

    expect(editCalls).toEqual([[marked, CLEAR_KEYBOARD]])
  })

  test('正文含标记文字但没有空行前缀：正常按本次结果追加', async () => {
    const recording = createRecordingApi()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const text = `${feedText} 转发的正文里写着 ✅ 已删除 这四个字`
    const { ctx, editCalls } = createContext({ fromId: ownerId, text })

    await handler(ctx, async () => {})

    expect(editCalls).toEqual([[`${text}\n\n✅ 已删除`, CLEAR_KEYBOARD]])
  })

  test('messageId 超出安全整数：不调用删除', async () => {
    const recording = createRecordingApi()
    const { logger, warnings } = warnCapture()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger })
    const { ctx, answers, editCalls } = createContext({
      fromId: ownerId,
      data: `feeddel:${chatId}:9007199254740993`,
      text: feedText,
    })

    await handler(ctx, async () => {})

    expect(recording.calls).toEqual([])
    expect(answers).toEqual([])
    expect(editCalls).toEqual([])
    expect(warnings.some((entry) => entry.message.includes('消息 id 非法'))).toBe(true)
  })

  test('回执失败只记 warn：摘要编辑照常执行', async () => {
    const recording = createRecordingApi()
    const { logger, warnings } = warnCapture()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger })
    const { ctx, answers, editCalls } = createContext({
      fromId: ownerId,
      text: feedText,
      answerError: new Error('query is too old'),
    })

    await handler(ctx, async () => {})

    expect(answers).toEqual([])
    expect(editCalls).toEqual([[`${feedText}\n\n✅ 已删除`, CLEAR_KEYBOARD]])
    expect(warnings.some((entry) => entry.message.includes('feed 回调回执失败'))).toBe(true)
  })

  test('失败原因超长时截断到 180 码点（回执整体不超过 200）', async () => {
    const description = `Bad Request: ${'x'.repeat(300)}`
    const recording = createRecordingApi({
      deleteMessage: () => {
        throw new GrammyError(
          'Call to deleteMessage failed',
          { ok: false, error_code: 400, description },
          'deleteMessage',
          {},
        )
      },
    })
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger: silentLogger })
    const { ctx, answers } = createContext({ fromId: ownerId, text: feedText })

    await handler(ctx, async () => {})

    // 描述截到 180 码点（含省略号），前缀「删除失败：」另算。
    expect(answers).toEqual([{ text: `删除失败：Bad Request: ${'x'.repeat(166)}…`, show_alert: true }])
    expect(Array.from(answers[0]?.text ?? '').length).toBeLessThanOrEqual(200)
  })

  test('回调消息不存在：只回执并记日志，不编辑', async () => {
    const recording = createRecordingApi()
    const { logger, warnings } = warnCapture()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger })
    const { ctx, answers, editCalls } = createContext({ fromId: ownerId, omitMessage: true })

    await handler(ctx, async () => {})

    expect(answers).toEqual([{ text: '已删除' }])
    expect(editCalls).toEqual([])
    expect(warnings.some((entry) => entry.message.includes('回调消息不存在'))).toBe(true)
  })

  test('摘要没有文本字段（媒体/不可访问）：跳过标记，回执照常', async () => {
    const recording = createRecordingApi()
    const { logger, warnings } = warnCapture()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger })
    const { ctx, answers, editCalls } = createContext({ fromId: ownerId, text: undefined })

    await handler(ctx, async () => {})

    expect(answers).toEqual([{ text: '已删除' }])
    expect(editCalls).toEqual([])
    expect(warnings.some((entry) => entry.message.includes('消息没有文本字段'))).toBe(true)
  })

  test('编辑失败只记 warn：回执照常返回', async () => {
    const recording = createRecordingApi()
    const { logger, warnings } = warnCapture()
    const handler = createFeedDeleteCallbackHandler({ api: recording.api, ownerUserId: ownerId, logger })
    const { ctx, answers } = createContext({
      fromId: ownerId,
      text: feedText,
      editError: new Error('Bad Request: message is not modified'),
    })

    await expect(handler(ctx, async () => {})).resolves.toBeUndefined()

    expect(answers).toEqual([{ text: '已删除' }])
    expect(warnings.some((entry) => entry.message.includes('feed 摘要编辑失败'))).toBe(true)
  })

  test('回调数据形状与发送侧键盘一致', () => {
    const keyboard = feedDeleteKeyboard(asChatId(chatId), messageId)
    const button = keyboard.inline_keyboard[0]?.[0]
    const data = button !== undefined && 'callback_data' in button ? (button.callback_data ?? '') : ''
    const match = FEED_DELETE_CALLBACK_PATTERN.exec(data)

    expect(match?.[1]).toBe(chatId)
    expect(match?.[2]).toBe(String(messageId))
  })
})
