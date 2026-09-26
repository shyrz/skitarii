/**
 * 规则页签「信任名单」区块的纯逻辑与固定文案。
 *
 * 只放可脱离 DOM 验证的部分：输入解析、去重、上限与提示文案。
 * 上限与面板保存边界（`apps/server/src/panel.ts` 的 `MAX_WHITELIST`）保持一致；
 * 本地校验只为即时反馈，服务端仍是权威（保存失败时 details 原样展示）。
 */

/** 信任名单条数上限。与服务端保存边界一致，改一处必须同步另一处。 */
export const WHITELIST_MAX = 50

/** 区块说明（spec §4，照抄）。 */
export const WHITELIST_HINT = '名单内的账号不受审核，消息会直接放行。'

/** 风险提示（spec §4，照抄）。 */
export const WHITELIST_RISK = '只添加你完全信任的账号；账号被盗用时会绕过所有审核。'

/** 空态文案（spec §4，照抄）。 */
export const WHITELIST_EMPTY = '还没有信任账号。'

/** 输入非法时的统一提示：非数字、小数、负数与超出安全整数都归到这里。 */
const INPUT_INVALID_MESSAGE = '用户 ID 必须是正整数。'

/** 重复添加的提示。 */
const DUPLICATE_MESSAGE = '这个账号已经在名单里。'

export type AddWhitelistResult =
  | { ok: true; whitelist: number[] }
  | { ok: false; message: string }

/**
 * 把输入框文本解析成用户 ID 并追加进名单。
 *
 * 只接受 ASCII 十进制正整数：`+1`、`1.5`、`-1`、空串与超出安全整数的长数字串都拒绝并给同一条提示；
 * 已存在时报重复；去重后达到 {@link WHITELIST_MAX} 时报上限。成功返回新数组，不就地修改入参。
 *
 * @param current 当前名单（草稿）。
 * @param raw 输入框原文。
 * @returns 成功时的新名单；失败时的就地提示文案。
 */
export function addWhitelistUser(current: readonly number[], raw: string): AddWhitelistResult {
  const trimmed = raw.trim()
  if (!/^\d+$/u.test(trimmed)) return { ok: false, message: INPUT_INVALID_MESSAGE }

  const userId = Number(trimmed)
  if (!Number.isSafeInteger(userId) || userId <= 0) return { ok: false, message: INPUT_INVALID_MESSAGE }
  if (current.includes(userId)) return { ok: false, message: DUPLICATE_MESSAGE }
  if (current.length >= WHITELIST_MAX) {
    return { ok: false, message: `信任名单最多 ${WHITELIST_MAX} 个账号。` }
  }

  return { ok: true, whitelist: [...current, userId] }
}
