import { GrammyError, type Api } from 'grammy'
import type { Logger } from './logger.js'

/**
 * 非成员探测：判断一条经内联机器人发送的消息的发送者是否已不在本群成员列表里。
 *
 * 为什么单独成模块：探测由管线惰性调用（见 `handleIncomingMessage`，信任名单命中者不触发），
 * 判定表、超时与失败开放口径需要独立单测；而 `bot.ts` 是包入口（导出面即公开 API），不为测试往那里加内部函数。
 * 「目标不在群里」的判定同时被执行器复用（封禁/禁言撞上它时降级为删除）。
 *
 * 调用时机（调用方负责）：只在 `via_bot` 消息上、信任名单未命中时调用一次；普通消息不付出这次 API 往返。
 * 真实主因是频道评论区：非成员不必加入讨论组就能对频道帖发评论，评论落进讨论组后在这里被探测。
 */

/**
 * 探测超时（毫秒）。
 *
 * 取 3 秒：探测在消息判定路径上，一次 API 往返不该把处理拖到 Telegram 重投递窗口里；
 * 超时与网络错误同样失败开放（按成员处理），这里只决定「等多久算没有结论」。
 */
export const NONMEMBER_PROBE_TIMEOUT_MS = 3_000

/**
 * Telegram「该用户不在本聊天里」的 400 描述片段。
 *
 * 从未加入过的用户没有成员行，`getChatMember` 的拒绝形态不止一种：`user not found`（从未与 bot 交互、
 * 账号已注销）、`USER_NOT_PARTICIPANT`（接口判定非参与者）、`PARTICIPANT_ID_INVALID`（拿不到参与者）。
 * 三者都等价于「无法证明其在群」，一并视为非成员。
 */
const NON_MEMBER_ERROR_PATTERN = /user not found|user_not_participant|participant_id_invalid|participant not found/iu

/**
 * 判断 Telegram 的拒绝是不是「该用户不在本聊天里」。
 *
 * 探测与执行器共用同一判定：前者把它当成非成员证据（{@link probeNonMember}），
 * 后者把对这类目标的封禁/禁言降级为删除（见 `executor.ts` 的 `applyAction`）。
 *
 * @param error 捕获到的异常。
 * @returns 是 GrammyError、`error_code` 为 400 且描述命中时为 `true`。
 */
export function isNonMemberTargetError(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 400 && NON_MEMBER_ERROR_PATTERN.test(error.description)
}

/** 探测超时的哨兵错误：只用于把日志原因写清楚，不参与判定（超时一律失败开放）。 */
class ProbeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`getChatMember 超时（${timeoutMs}ms）`)
    this.name = 'ProbeTimeoutError'
  }
}

/**
 * 探测发送者是否为非成员。
 *
 * 判定口径（锁定）：
 * - `left` / `kicked` → 非成员（`true`）；
 * - `member` / `administrator` / `creator` / `restricted` → 成员（`false`）；
 * - Telegram 400 且描述命中 {@link NON_MEMBER_ERROR_PATTERN} → 非成员（`true`）；
 * - 超时、其余异常（网络抖动、5xx、429）与未知成员状态 → `undefined` 失败开放并记 `warn`：
 *   探测只用来加强处置，查不到不能反过来把正常成员当非成员处置（一次抖动不该导致封禁）。
 *
 * @param api 取成员的 API 面（真实调用传 `bot.api`，测试传最小桩）。
 * @param chatId 目标群/超级群 id。
 * @param userId 发送者用户 id。
 * @param logger 日志出口。
 * @param timeoutMs 超时上限，默认 {@link NONMEMBER_PROBE_TIMEOUT_MS}；测试注入短值以避免真实等待。
 * @returns 非成员为 `true`、成员为 `false`、探测失败为 `undefined`。
 */
export async function probeNonMember(
  api: Pick<Api, 'getChatMember'>,
  chatId: number | string,
  userId: number,
  logger: Logger,
  timeoutMs: number = NONMEMBER_PROBE_TIMEOUT_MS,
): Promise<boolean | undefined> {
  try {
    const member = await withTimeout(api.getChatMember(chatId, userId), timeoutMs)
    // 先落到 string：平台出现类型上没有的新状态时也要走 default 分支，而不是被收窄成 `never`。
    const status: string = member.status
    switch (status) {
      case 'left':
      case 'kicked':
        return true
      case 'member':
      case 'administrator':
      case 'creator':
      case 'restricted':
        return false
      default:
        // 认不出来的状态同样失败开放：不臆断非成员。
        logger.warn(`成员状态未知，按成员处理 chatId=${chatId} userId=${userId} status=${status}`)
        return undefined
    }
  } catch (error) {
    if (isNonMemberTargetError(error)) return true
    // 超时与网络错误都是「探测不可用」：一律失败开放，只把原因分开写进日志。
    const reason = error instanceof ProbeTimeoutError ? `超时（${error.timeoutMs}ms）` : '失败'
    logger.warn(`非成员探测${reason}，按成员处理（失败开放） chatId=${chatId} userId=${userId}`, error)
    return undefined
  }
}

/**
 * 给探测调用套一层超时。
 *
 * Promise.race 不取消底层请求：超时后不再等它的结果，它的兑现或拒绝由 race 的处理器接住，
 * 不会变成未处理拒绝；定时器在底层先返回与超时两条路径上都会清掉，不留下挂起的句柄。
 *
 * @param promise 待限时的请求。
 * @param timeoutMs 超时上限。
 * @returns 请求结果；超时抛 {@link ProbeTimeoutError}。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
