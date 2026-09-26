import { describe, expect, test } from 'vitest'
import {
  WHITELIST_EMPTY,
  WHITELIST_HINT,
  WHITELIST_MAX,
  WHITELIST_RISK,
  addWhitelistUser,
} from './whitelist.js'

describe('信任名单文案', () => {
  test('区块说明、风险提示与空态按 spec §4 照抄', () => {
    expect(WHITELIST_HINT).toBe('名单内的账号不受审核，消息会直接放行。')
    expect(WHITELIST_RISK).toBe('只添加你完全信任的账号；账号被盗用时会绕过所有审核。')
    expect(WHITELIST_EMPTY).toBe('还没有信任账号。')
  })
})

describe('信任名单本地校验', () => {
  test('合法正整数追加到末尾，且不就地修改原数组', () => {
    const current = [7_000_000_001]
    const result = addWhitelistUser(current, '7000000002')

    expect(result).toEqual({ ok: true, whitelist: [7_000_000_001, 7_000_000_002] })
    expect(current).toEqual([7_000_000_001])
  })

  test('首尾空白被忽略；纯数字串按十进制解析', () => {
    expect(addWhitelistUser([], '  42  ')).toEqual({ ok: true, whitelist: [42] })
  })

  test.each(['', '   ', 'abc', '1.5', '-1', '+1', '١٢٣', '9007199254740993'])(
    '非正安全整数（%j）给同一条提示且不改名单',
    (raw) => {
      expect(addWhitelistUser([], raw)).toEqual({ ok: false, message: '用户 ID 必须是正整数。' })
    },
  )

  test('重复账号就地提示，不减也不加', () => {
    expect(addWhitelistUser([42], '42')).toEqual({ ok: false, message: '这个账号已经在名单里。' })
  })

  test('去重后达到上限时拒绝并提示上限', () => {
    const full = Array.from({ length: WHITELIST_MAX }, (_, index) => index + 1)

    expect(addWhitelistUser(full, String(WHITELIST_MAX + 1))).toEqual({
      ok: false,
      message: `信任名单最多 ${WHITELIST_MAX} 个账号。`,
    })
    // 上限内的最后一个位置仍可添加。
    expect(addWhitelistUser(full.slice(0, -1), String(WHITELIST_MAX))).toEqual({
      ok: true,
      whitelist: full,
    })
  })
})
