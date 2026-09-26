import type { SubscriptionMemberState } from './types.js'

/**
 * 订阅成员快照的纯映射：Telegram 的成员对象/事件 → 台账状态与到期观测值。
 *
 * 放在 core 是因为 bot（事件）与 server（对账）都要用同一口径，两处各写一份必然漂移。
 * 输入只需要三个字段，不依赖 grammY 的类型，任何形状兼容的来源都能直接传入。
 */

/** 映射输入：与 Telegram `ChatMember` 的三个相关字段同形。 */
export interface SubscriptionMemberSnapshotInput {
  status: string
  /** 仅 `restricted` 有意义：是否仍在频道内。 */
  is_member?: boolean | undefined
  /** 仅 `ChatMemberMember`（订阅成员）可能携带的到期时间（Unix 秒）。 */
  until_date?: number | undefined
}

/** 映射结果。 */
export interface SubscriptionMemberSnapshot {
  state: SubscriptionMemberState
  /**
   * 最新成功快照观测到的订阅到期时间。
   * `null` 表示这次未观测到（字段缺失、其他身份类型或已离开），**不代表无限期或付款失效**。
   */
  expiresAt: Date | null
}

/**
 * 把成员快照映射成台账事实。
 *
 * 对照口径（spec §4.1）：member/administrator/creator → member；restricted 按 `is_member`；
 * left/kicked → left；无法识别的将来状态 → unknown（不猜离开原因，也不用 `expired` 表述）。
 *
 * @param member 成员快照。
 * @returns 状态与到期观测值。
 */
export function subscriptionSnapshotOf(member: SubscriptionMemberSnapshotInput): SubscriptionMemberSnapshot {
  switch (member.status) {
    case 'member':
      return { state: 'member', expiresAt: subscriptionExpiryOf(member.until_date) }
    case 'administrator':
    case 'creator':
      return { state: 'member', expiresAt: null }
    case 'restricted':
      return { state: member.is_member === true ? 'member' : 'left', expiresAt: null }
    case 'left':
    case 'kicked':
      return { state: 'left', expiresAt: null }
    default:
      return { state: 'unknown', expiresAt: null }
  }
}

/**
 * 校验 `until_date`（Unix 秒）：必须是有效正整数时间戳，否则视为未观测到。
 *
 * @param value Telegram 的 `until_date`。
 * @returns 到期时刻；无效或缺省为 `null`。
 */
export function subscriptionExpiryOf(value: number | undefined): Date | null {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return null
  return new Date(value * 1_000)
}
