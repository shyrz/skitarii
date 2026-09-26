import { describe, expect, test } from 'vitest'
import { parseBotEnv } from './env.js'

/** 覆盖全部必填项的最小环境；单项测试按需覆盖。 */
const requiredEnv = {
  BOT_TOKEN: '123:abc',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/skitarii',
  MINI_APP_URL: 'https://example.com',
  OWNER_USER_ID: '42',
}

describe('APPEAL_SAMPLE_WRITEBACK 解析', () => {
  test('未设置默认关闭', () => {
    expect(parseBotEnv(requiredEnv).APPEAL_SAMPLE_WRITEBACK).toBe(false)
  })

  test('true 才启用，false 关闭', () => {
    expect(parseBotEnv({ ...requiredEnv, APPEAL_SAMPLE_WRITEBACK: 'true' }).APPEAL_SAMPLE_WRITEBACK).toBe(true)
    expect(parseBotEnv({ ...requiredEnv, APPEAL_SAMPLE_WRITEBACK: 'false' }).APPEAL_SAMPLE_WRITEBACK).toBe(false)
  })

  test('其他取值报错', () => {
    expect(() => parseBotEnv({ ...requiredEnv, APPEAL_SAMPLE_WRITEBACK: 'yes' })).toThrow(/APPEAL_SAMPLE_WRITEBACK/)
  })
})
