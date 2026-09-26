import { describe, expect, test } from 'vitest'
import { parseServerEnv } from './env.js'

/** 覆盖全部必填项的最小环境；单项测试按需覆盖。 */
const requiredEnv = {
  BOT_TOKEN: '123:abc',
  WEBHOOK_SECRET: 'secret',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/skitarii',
  MINI_APP_URL: 'https://example.com',
  OWNER_USER_ID: '42',
}

describe('PORT 解析', () => {
  test('未设置时缺省 3000', () => {
    expect(parseServerEnv(requiredEnv).PORT).toBe(3000)
  })

  test('设置时以环境为准，字符串数字也能解析', () => {
    expect(parseServerEnv({ ...requiredEnv, PORT: '8123' }).PORT).toBe(8123)
  })
})

describe('OWNER_DEBUG_NOTIFY 解析', () => {
  test('未设置与 true 均视为开启', () => {
    expect(parseServerEnv(requiredEnv).OWNER_DEBUG_NOTIFY).toBe(true)
    expect(parseServerEnv({ ...requiredEnv, OWNER_DEBUG_NOTIFY: 'true' }).OWNER_DEBUG_NOTIFY).toBe(true)
  })

  test('false 关闭', () => {
    expect(parseServerEnv({ ...requiredEnv, OWNER_DEBUG_NOTIFY: 'false' }).OWNER_DEBUG_NOTIFY).toBe(false)
  })

  test('其他取值报错', () => {
    expect(() => parseServerEnv({ ...requiredEnv, OWNER_DEBUG_NOTIFY: 'no' })).toThrow(/OWNER_DEBUG_NOTIFY/)
  })
})

describe('APPEAL_SAMPLE_WRITEBACK 解析', () => {
  test('未设置默认关闭', () => {
    expect(parseServerEnv(requiredEnv).APPEAL_SAMPLE_WRITEBACK).toBe(false)
  })

  test('true 才启用，false 关闭', () => {
    expect(parseServerEnv({ ...requiredEnv, APPEAL_SAMPLE_WRITEBACK: 'true' }).APPEAL_SAMPLE_WRITEBACK).toBe(true)
    expect(parseServerEnv({ ...requiredEnv, APPEAL_SAMPLE_WRITEBACK: 'false' }).APPEAL_SAMPLE_WRITEBACK).toBe(false)
  })

  test('其他取值报错', () => {
    expect(() => parseServerEnv({ ...requiredEnv, APPEAL_SAMPLE_WRITEBACK: 'yes' })).toThrow(/APPEAL_SAMPLE_WRITEBACK/)
  })
})
