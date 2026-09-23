import { createHmac, timingSafeEqual } from 'node:crypto'
import { asUserId, type UserId } from '@skitarii/core'

/**
 * Telegram Mini App `initData` 验签。
 *
 * 协议（Bot API 文档的 Validating data received via the Mini App）：Telegram 用 bot token 派生的密钥
 * 对一组字段做 HMAC-SHA256，签名放在 `hash` 字段里。校验步骤：
 * 1. `secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)`，注意密钥与消息的位置是反的。
 * 2. `data_check_string` = 除 `hash` 与 `signature` 外的字段按 `key=value` 排序后用 `\n` 连接。
 * 3. `HMAC_SHA256(key=secret_key, message=data_check_string)` 的十六进制值必须等于 `hash`。
 *
 * 两个容易踩的点：
 * - `signature`（Telegram 给第三方校验用的 Ed25519 签名）不参与 data-check-string，必须排除，
 *   否则带 signature 的 initData 一律验不过。
 * - 字段值要按 `decodeURIComponent` 解码后再拼串，且**不能**把 `+` 当成空格
 *   （`URLSearchParams` 会这么做，所以这里手写解析）；Telegram 用 `encodeURIComponent` 编码。
 *
 * 时效：`auth_date` 与当前时间相差超过 1 小时即拒绝。上限取 1 小时的来历：Mini App 每次打开都会拿到
 * 新的 initData，正常使用中用户无感；而窗口越长，被截获的 initData 可用来冒充的时间越久。
 * `/api/appeals` 只有「提交申诉」与「读取处置」两个动作，页面重新加载就会换一份 initData，
 * 不需要留出「打开一次用一天」的长窗口。
 */

/** 允许的 initData 有效期（秒）。 */
export const INIT_DATA_MAX_AGE_SECONDS = 60 * 60

/** 允许的时钟偏移（秒）：客户端时间比服务端快一点不该导致验签失败。 */
const CLOCK_SKEW_SECONDS = 60

/** 验签失败的原因。用于日志与响应体，不对外暴露可用于伪造的细节。 */
export type InitDataFailure = 'malformed' | 'missing-hash' | 'bad-signature' | 'expired'

/** 验签通过的结果。 */
export interface VerifiedInitData {
  /** 发起请求的用户。 */
  userId: UserId
  /** Telegram 签发时间。 */
  authDate: Date
  /** `startapp` 参数，即 Mini App 的入口参数（这里是 decisionId）。 */
  startParam: string | null
}

/** 验签结果。 */
export type InitDataVerification = { ok: true; data: VerifiedInitData } | { ok: false; reason: InitDataFailure }

/** `user` 字段里本仓库需要的部分。 */
interface InitDataUser {
  id: number
}

/**
 * 校验 initData。
 *
 * @param initData 原始查询串（`Telegram.WebApp.initData` 或 URL 里的 `initData` 参数）。
 * @param options.botToken bot token，来自环境变量。
 * @param options.now 当前时间，默认系统时间；显式传入便于测试。
 * @returns 通过时给出用户与签发时间；失败时给出原因。
 */
export function verifyInitData(
  initData: string,
  options: { botToken: string; now?: Date | undefined },
): InitDataVerification {
  const fields = parseFields(initData)
  if (fields === null) return { ok: false, reason: 'malformed' }

  const hash = fields.get('hash')
  if (hash === undefined || hash.length === 0) return { ok: false, reason: 'missing-hash' }

  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')

  const secretKey = createHmac('sha256', 'WebAppData').update(options.botToken).digest()
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest()
  if (!equalInConstantTime(expected, hash)) return { ok: false, reason: 'bad-signature' }

  const authDateSeconds = Number(fields.get('auth_date'))
  if (!Number.isFinite(authDateSeconds)) return { ok: false, reason: 'malformed' }

  const now = options.now ?? new Date()
  const ageSeconds = Math.floor(now.getTime() / 1_000) - authDateSeconds
  if (ageSeconds > INIT_DATA_MAX_AGE_SECONDS || ageSeconds < -CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' }
  }

  const user = parseUser(fields.get('user'))
  if (user === null) return { ok: false, reason: 'malformed' }

  return {
    ok: true,
    data: {
      userId: asUserId(user.id),
      authDate: new Date(authDateSeconds * 1_000),
      startParam: fields.get('start_param') ?? null,
    },
  }
}

/**
 * 手写解析 `a=1&b=2` 形态的查询串。
 *
 * 不用 `URLSearchParams`：它会把 `+` 解码成空格，而 Telegram 的编码里 `+` 是字面量。
 *
 * @param initData 原始查询串。
 * @returns 字段表；结构非法（没有 `=`、百分号编码坏掉）时返回 `null`。
 */
function parseFields(initData: string): Map<string, string> | null {
  const fields = new Map<string, string>()
  for (const pair of initData.split('&')) {
    if (pair.length === 0) continue
    const separator = pair.indexOf('=')
    if (separator < 0) return null
    try {
      fields.set(decodeURIComponent(pair.slice(0, separator)), decodeURIComponent(pair.slice(separator + 1)))
    } catch {
      return null
    }
  }
  return fields.size === 0 ? null : fields
}

/**
 * 解析 `user` 字段（JSON 字符串）。
 *
 * @param raw 字段原始值。
 * @returns 含整数 `id` 的用户；缺失或格式不对时返回 `null`。
 */
function parseUser(raw: string | undefined): InitDataUser | null {
  if (raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { id?: unknown }
    if (typeof candidate.id !== 'number' || !Number.isInteger(candidate.id)) return null
    return { id: candidate.id }
  } catch {
    return null
  }
}

/**
 * 常数时间比较签名。
 *
 * 长度不等时直接判定失败：长度本身就足以区分，无需再做逐字节比较。
 *
 * @param expected 服务端算出的摘要。
 * @param provided 请求带来的十六进制签名。
 * @returns 是否相等。
 */
function equalInConstantTime(expected: Buffer, provided: string): boolean {
  const providedBuffer = Buffer.from(provided, 'hex')
  if (providedBuffer.length !== expected.length) return false
  return timingSafeEqual(expected, providedBuffer)
}
