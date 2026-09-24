import { GrammyError } from 'grammy'

/**
 * 「管理员/群主不可被限制」的 Telegram 拒绝文案判定。
 *
 * `restrictChatMember` / `banChatMember` 对群管理员返回
 * `Bad Request: user is an administrator of the chat`，对群主返回
 * `Bad Request: can't remove chat owner`。这是平台规则：bot 无论权限多高都无法对这两类身份禁言或封禁，
 * 重试与提权都不会改变结果，只能在业务侧改走别的动作（本仓库的做法是降级为删除消息）。
 *
 * 为什么单独成文件：executor 与 appeal 都要用这个判定（前者决定降级执行，后者决定撤销时跳过无意义的解禁），
 * 而 appeal 已经被 executor 导入（申诉键盘），判定留在任一侧都会形成循环导入。
 */

/** 命中即视为「目标不可被限制」的描述片段。 */
const UNPUNISHABLE_TARGET_PATTERN = /administrator of the chat|can't remove chat owner/iu

/**
 * 判断 Telegram 的 400 拒绝是不是「目标不可被限制」。
 *
 * 只有 400 才可能命中：429、403 等错误另有处置路径（重试或交由调用方终结），不在此列。
 *
 * @param error 捕获到的异常。
 * @returns 是 GrammyError、`error_code` 为 400 且描述命中时为 `true`（此时 `error` 一定是 GrammyError）。
 */
export function isUnpunishableTarget(error: unknown): error is GrammyError {
  return (
    error instanceof GrammyError && error.error_code === 400 && UNPUNISHABLE_TARGET_PATTERN.test(error.description)
  )
}
