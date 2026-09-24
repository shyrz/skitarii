import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { INIT_DATA_MAX_AGE_SECONDS, verifyInitData } from './init-data.js'

/**
 * 验签向量的构造。
 *
 * 刻意在测试里按协议文档重新实现一遍签名（而不是复用被测代码）：如果实现的拼串口径与协议不符，
 * 独立构造的向量会按文档通过、被测实现无法通过，测试就会失败。HMAC 的口径是「除 hash 外全部字段」，
 * `signature` 在内；「排除 hash 与 signature」是第三方 Ed25519 校验的规则，不要混用。
 */

const BOT_TOKEN = '123456:TEST-TOKEN-abc'

/**
 * 生成一份 initData。
 *
 * @param fields 除 `hash` 外的字段。
 * @param options.signature 附加的 `signature` 字段值；与其它字段一样参与 data-check-string。
 * @returns 查询串形态的 initData。
 */
function signInitData(fields: Record<string, string>, options: { signature?: string } = {}): string {
  const signed = options.signature === undefined ? fields : { ...fields, signature: options.signature }
  const dataCheckString = Object.entries(signed)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  const encoded = Object.entries(signed).map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  encoded.push(`hash=${hash}`)
  return encoded.join('&')
}

const now = new Date('2026-09-23T12:00:00Z')

/**
 * 构造一份未过期的字段集合。
 *
 * @param overrides 覆盖字段。
 * @returns 字段表。
 */
function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(now.getTime() / 1_000) - 60),
    query_id: 'AAF-test-query',
    user: JSON.stringify({ id: 7_000_000_001, first_name: '张三', username: 'zhangsan' }),
    ...overrides,
  }
}

describe('initData 验签', () => {
  test('合法签名通过，并给出用户、签发时间与 startapp 参数', () => {
    const initData = signInitData(fields({ start_param: '9c8b7a65-1111-4222-8333-999900001111' }))

    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.userId).toBe(7_000_000_001)
    expect(result.data.startParam).toBe('9c8b7a65-1111-4222-8333-999900001111')
    expect(result.data.authDate).toEqual(new Date(Math.floor(now.getTime() / 1_000) * 1_000 - 60_000))
  })

  test('篡改 user 字段被拒（签名覆盖全部字段，只改一处就失效）', () => {
    const initData = signInitData(fields()).replace(
      encodeURIComponent(JSON.stringify({ id: 7_000_000_001, first_name: '张三', username: 'zhangsan' })),
      encodeURIComponent(JSON.stringify({ id: 9_999_999_999, first_name: '李四' })),
    )

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now })).toEqual({ ok: false, reason: 'bad-signature' })
  })

  test('篡改 auth_date 被拒', () => {
    const initData = signInitData(fields()).replace(
      `auth_date=${encodeURIComponent(fields().auth_date ?? '')}`,
      'auth_date=1',
    )

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now })).toEqual({ ok: false, reason: 'bad-signature' })
  })

  test('带 signature 字段的 initData 通过（signature 参与 HMAC 拼串）', () => {
    const initData = signInitData(fields(), { signature: 'ZmFrZS1lZDI1NTE5LXNpZ25hdHVyZQ' })

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now }).ok).toBe(true)
  })

  test('真实向量（官方仓库 2024-12）：signature 参与拼串才对得上，排它口径必被拒', () => {
    // 来源：Telegram-Mini-Apps/init-data-golang README 的 HMAC 示例，token、initData 与 hash 三者同源。
    // 该向量的 hash 只有把 signature 计入拼串才能对上；把 signature 排除的变体（旧实现的错误口径）必然失败。
    const vectorToken = '7342037359:AAHI25ES9xCOMPokpYoz-p8XVrZUdygo2J4'
    const vector =
      'user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%20%2B%20-%20%3F%20%5C%2F%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2F4FPEE4tmP3ATHa57u6MqTDih13LTOiMoKoLDRG4PnSA.svg%22%7D&chat_instance=8134722200314281151&chat_type=private&auth_date=1733509682&signature=TYJxVcisqbWjtodPepiJ6ghziUL94-KNpG8Pau-X7oNNLNBM72APCpi_RKiUlBvcqo5L-LAxIc3dnTzcZX_PDg&hash=a433d8f9847bd6addcc563bff7cc82c89e97ea0d90c11fe5729cae6796a36d73'
    const vectorNow = new Date(1733509682_000 + 60_000)

    const result = verifyInitData(vector, { botToken: vectorToken, now: vectorNow })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.userId).toBe(279058397)

    // 排它口径的 hash（把 signature 排除在拼串外算出的 digest）必须被拒。
    const excludeDigest = '661132da6274f4fe74c7513fca7777fb203f7f9c575352383743c0e9403a57e9'
    const tampered = vector.replace(
      'hash=a433d8f9847bd6addcc563bff7cc82c89e97ea0d90c11fe5729cae6796a36d73',
      `hash=${excludeDigest}`,
    )
    expect(verifyInitData(tampered, { botToken: vectorToken, now: vectorNow })).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  test('超过有效期的 initData 被拒', () => {
    const stale = Math.floor(now.getTime() / 1_000) - INIT_DATA_MAX_AGE_SECONDS - 1
    const initData = signInitData(fields({ auth_date: String(stale) }))

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now })).toEqual({ ok: false, reason: 'expired' })
  })

  test('有效期边界：刚好在窗口内的仍然通过', () => {
    const edge = Math.floor(now.getTime() / 1_000) - INIT_DATA_MAX_AGE_SECONDS
    const initData = signInitData(fields({ auth_date: String(edge) }))

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now }).ok).toBe(true)
  })

  test('有效期窗口是 1 小时：一小时零一分前的 initData 会被拒', () => {
    const tooOld = Math.floor(now.getTime() / 1_000) - 3_661
    const initData = signInitData(fields({ auth_date: String(tooOld) }))

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now })).toEqual({ ok: false, reason: 'expired' })
  })

  test('缺少 hash 与结构非法分别给出明确原因', () => {
    expect(verifyInitData('auth_date=1&user=%7B%7D', { botToken: BOT_TOKEN, now })).toEqual({
      ok: false,
      reason: 'missing-hash',
    })
    expect(verifyInitData('not-a-query-string', { botToken: BOT_TOKEN, now })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  test('缺 user 字段时算结构非法（无法确认请求者）', () => {
    const initData = signInitData({ auth_date: String(Math.floor(now.getTime() / 1_000)) })

    expect(verifyInitData(initData, { botToken: BOT_TOKEN, now })).toEqual({ ok: false, reason: 'malformed' })
  })

  test('换一个 bot token 就验不过（签名与 token 绑定）', () => {
    const initData = signInitData(fields())

    expect(verifyInitData(initData, { botToken: '999:OTHER', now })).toEqual({ ok: false, reason: 'bad-signature' })
  })

  test('含特殊字符的用户名不破坏验签（值按 decodeURIComponent 还原）', () => {
    const initData = signInitData(fields({ user: JSON.stringify({ id: 42, first_name: 'a+b c/中文' }) }))

    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.userId).toBe(42)
  })
})
