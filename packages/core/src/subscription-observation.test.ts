import { describe, expect, test } from 'vitest'
import { subscriptionExpiryOf, subscriptionSnapshotOf } from './subscription-observation.js'

/**
 * 订阅成员快照映射的纯函数测试：口径必须与 bot 事件、server 对账两侧共享，不允许各自解释。
 */
describe('订阅成员快照映射', () => {
  test('member 带有效 until_date：精确到期时刻', () => {
    expect(subscriptionSnapshotOf({ status: 'member', until_date: 1_791_000_000 })).toEqual({
      state: 'member',
      expiresAt: new Date(1_791_000_000 * 1_000),
    })
  })

  test('member 不带 until_date：字段缺失不代表无限期，映射成 null', () => {
    expect(subscriptionSnapshotOf({ status: 'member' })).toEqual({ state: 'member', expiresAt: null })
  })

  test('administrator/creator 视作 member，但到期观测值为 null（不是 subscriber 快照）', () => {
    expect(subscriptionSnapshotOf({ status: 'administrator' })).toEqual({ state: 'member', expiresAt: null })
    expect(subscriptionSnapshotOf({ status: 'creator' })).toEqual({ state: 'member', expiresAt: null })
    // 即便快照里带了 until_date（例如禁言时长），身份类型不是 member 时也不当作订阅到期。
    expect(subscriptionSnapshotOf({ status: 'restricted', is_member: true, until_date: 1_791_000_000 })).toEqual({
      state: 'member',
      expiresAt: null,
    })
  })

  test('restricted 按 is_member 落 member/left；left/kicked 一律 left（不用 expired 表述）', () => {
    expect(subscriptionSnapshotOf({ status: 'restricted', is_member: true })).toEqual({ state: 'member', expiresAt: null })
    expect(subscriptionSnapshotOf({ status: 'restricted', is_member: false })).toEqual({ state: 'left', expiresAt: null })
    expect(subscriptionSnapshotOf({ status: 'left' })).toEqual({ state: 'left', expiresAt: null })
    expect(subscriptionSnapshotOf({ status: 'kicked' })).toEqual({ state: 'left', expiresAt: null })
  })

  test('无法识别的将来状态落 unknown，不猜离开原因', () => {
    expect(subscriptionSnapshotOf({ status: 'future_status' })).toEqual({ state: 'unknown', expiresAt: null })
  })

  test('until_date 只接受有效正整数时间戳', () => {
    expect(subscriptionExpiryOf(undefined)).toBeNull()
    expect(subscriptionExpiryOf(0)).toBeNull()
    expect(subscriptionExpiryOf(-1)).toBeNull()
    expect(subscriptionExpiryOf(1.5)).toBeNull()
    expect(subscriptionExpiryOf(1_791_000_000)).toEqual(new Date(1_791_000_000 * 1_000))
  })
})
