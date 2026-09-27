import { GrammyError, type Api } from 'grammy'
import type { ChatMember } from 'grammy/types'
import { describe, expect, test } from 'vitest'
import type { Logger } from './logger.js'
import { probeNonMember } from './nonmember.js'

/**
 * 非成员探测的判定表与失败开放口径。
 *
 * 这里只覆盖纯判定；接线（只对 `via_bot` 消息探测、探测结果进入管线入参）由 `bot-nonmember.test.ts` 覆盖。
 */

const chatId = -1_003_333_333_333
const userId = 7_000_000_002

/** 记录 warn 的日志替身。 */
function collectingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message)
      },
      error: () => {},
    },
  }
}

/** 构造指定状态的成员快照；平台字段只保留判定需要的 `status`（探测只读它）。 */
function memberWithStatus(status: string): ChatMember {
  return { status, user: { id: userId, is_bot: false, first_name: '测试' } } as ChatMember
}

/** 返回固定成员快照、或抛出异常的 API 桩。 */
function apiReturning(outcome: ChatMember | Error): Pick<Api, 'getChatMember'> {
  return {
    async getChatMember() {
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

/** 构造 Telegram 的 API 拒绝。 */
function telegramError(errorCode: number, description: string): GrammyError {
  return new GrammyError('调用失败', { ok: false, error_code: errorCode, description }, 'getChatMember', {})
}

describe('非成员探测（getChatMember）', () => {
  test('left 与 kicked 判定为非成员', async () => {
    for (const status of ['left', 'kicked']) {
      const { logger } = collectingLogger()
      expect(await probeNonMember(apiReturning(memberWithStatus(status)), chatId, userId, logger)).toBe(true)
    }
  })

  test('member / administrator / creator / restricted 判定为成员', async () => {
    for (const status of ['member', 'administrator', 'creator', 'restricted']) {
      const { logger } = collectingLogger()
      expect(await probeNonMember(apiReturning(memberWithStatus(status)), chatId, userId, logger)).toBe(false)
    }
  })

  test('400 的 user not found / USER_NOT_PARTICIPANT / PARTICIPANT_ID_INVALID 及等价文案判定为非成员', async () => {
    const descriptions = [
      'Bad Request: user not found',
      'Bad Request: USER_NOT_PARTICIPANT',
      'Bad Request: PARTICIPANT_ID_INVALID',
      'Bad Request: participant_id_invalid',
      'Bad Request: participant not found',
    ]
    for (const description of descriptions) {
      const { logger } = collectingLogger()
      expect(await probeNonMember(apiReturning(telegramError(400, description)), chatId, userId, logger)).toBe(true)
    }
  })

  test('非 400 的 Telegram 错误与网络错误失败开放：返回 undefined 并 warn', async () => {
    const failures: Error[] = [
      telegramError(500, 'Internal Server Error'),
      telegramError(429, 'Too Many Requests: retry after 5'),
      new Error('fetch failed'),
    ]
    for (const failure of failures) {
      const { logger, warnings } = collectingLogger()
      expect(await probeNonMember(apiReturning(failure), chatId, userId, logger)).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('失败开放')
    }
  })

  test('未知成员状态失败开放：返回 undefined 并 warn', async () => {
    const { logger, warnings } = collectingLogger()

    // 平台将来新增状态时不能臆断成非成员。
    const unknown = memberWithStatus('future_status')
    expect(await probeNonMember(apiReturning(unknown), chatId, userId, logger)).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('成员状态未知')
  })

  test('探测超时失败开放：返回 undefined 并 warn（不等待底层请求）', async () => {
    const { logger, warnings } = collectingLogger()
    // 永不兑现的请求 + 5ms 超时：验证超时路径本身，不真实等待默认的 3 秒。
    const pending: Pick<Api, 'getChatMember'> = { getChatMember: () => new Promise<ChatMember>(() => {}) }

    expect(await probeNonMember(pending, chatId, userId, logger, 5)).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('超时')
    expect(warnings[0]).toContain('失败开放')
  })
})
