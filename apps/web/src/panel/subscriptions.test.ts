import { afterEach, describe, expect, test, vi } from 'vitest'
import { SubscriptionApiError } from '../api.js'
import {
  REVOKE_CONFIRM_TEXT,
  REVOKE_SUCCESS_TEXT,
  clearStoredIntent,
  copyToClipboard,
  createConfirmText,
  createIntentStorageKey,
  decideCreateIntent,
  expiryObservation,
  formatPriceLine,
  generateRequestId,
  linkDisplayName,
  linkStateNotice,
  loadStoredIntent,
  markCreateUncertain,
  memberLinkLabel,
  operationFailureNotice,
  parseStoredIntent,
  renameConfirmText,
  resolveIntentScope,
  saveStoredIntent,
  validateCreateDraft,
  visibilityNotice,
} from './subscriptions.js'
import type { CreateIntent, IntentStorage } from './subscriptions.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('展示口径', () => {
  test('价格行固定「每 30 天，N Stars」；空名称展示为未命名', () => {
    expect(formatPriceLine(100)).toBe('每 30 天，100 Stars')
    expect(linkDisplayName('')).toBe('（未命名）')
    expect(linkDisplayName('支持频道')).toBe('支持频道')
  })

  test('到期观测：缺失=未知；过去=等待核实；未来=时间', () => {
    const now = new Date('2026-09-26T00:00:00.000Z')

    expect(expiryObservation(null, now).kind).toBe('unknown')
    expect(expiryObservation(null, now).text).toContain('未知')

    const past = expiryObservation('2026-09-25T00:00:00.000Z', now)
    expect(past.kind).toBe('past')
    expect(past.text).toContain('已到观测期限')
    expect(past.text).toContain('等待核实')

    const future = expiryObservation('2026-10-26T00:00:00.000Z', now)
    expect(future.kind).toBe('future')
    expect(future.text).not.toContain('未知')
  })

  test('公开频道给出免费直入警告；unknown 说明未确认；私有不提示', () => {
    expect(visibilityNotice('public')?.text).toContain('免费直接加入')
    expect(visibilityNotice('unknown')?.text).toContain('尚未确认频道公开性')
    expect(visibilityNotice('private')).toBeNull()
  })

  test('create_unknown 提示人工核查；revoked 与确认文案统一：停止此链接的新加入、变化以 Telegram 为准', () => {
    expect(linkStateNotice('create_unknown')).toContain('人工核查')
    expect(linkStateNotice('revoked')).toBe(
      '已撤销：这条链接停止新的加入；已有订阅和续订如何变化以 Telegram 为准。',
    )
    expect(REVOKE_CONFIRM_TEXT).toBe(
      '确认撤销这条邀请链接？撤销后立即停止此链接的新加入；已有订阅和续订如何变化以 Telegram 为准。',
    )
    expect(REVOKE_SUCCESS_TEXT).toBe(
      '链接已撤销：停止此链接的新加入；已有订阅和续订如何变化以 Telegram 为准。',
    )
    // 撤销相关文案不得出现「不改变/不影响已有订阅」「不会取消已生效订阅」与退款保证
    for (const text of [
      linkStateNotice('revoked') ?? '',
      REVOKE_CONFIRM_TEXT,
      REVOKE_SUCCESS_TEXT,
      operationFailureNotice(new TypeError('fetch failed'), 'revoke').message,
    ]) {
      expect(text).not.toMatch(/退款/u)
      expect(text).not.toMatch(/不会取消已生效/u)
      expect(text).not.toMatch(/不影响已有订阅/u)
      expect(text).not.toMatch(/不改变已有订阅/u)
    }
    expect(linkStateNotice('active')).toBeNull()
  })

  test('成员可关联链接：无 linkId 不猜来源；不在当前列表时展示 ID', () => {
    const names = new Map([['l1', '支持频道']])
    expect(memberLinkLabel(null, names)).toContain('未关联')
    expect(memberLinkLabel('l1', names)).toBe('支持频道')
    expect(memberLinkLabel('l2', names)).toContain('l2')
  })
})

describe('三种二次确认文案', () => {
  test('创建确认包含频道、周期、价格；改名确认包含新旧名称', () => {
    const create = createConfirmText('支持频道', '', 100)
    expect(create).toContain('支持频道')
    expect(create).toContain('每 30 天，100 Stars')
    expect(create).toContain('（未命名）')
    expect(create).toContain('不能修改')

    const rename = renameConfirmText('旧名', '新名')
    expect(rename).toContain('旧名')
    expect(rename).toContain('新名')
    expect(rename).toContain('价格与周期不可修改')
  })
})

describe('撤销失败提示', () => {
  test('结果不确定：要求刷新并核实后决定重试，不承诺无影响、不提退款', () => {
    const notice = operationFailureNotice(new TypeError('fetch failed'), 'revoke')
    expect(notice.message).toBe(
      '结果不确定：Telegram 可能已经撤销了链接，但本地没有确认。请刷新页面并在频道内核查后决定是否重试；已有订阅和续订如何变化以 Telegram 为准。',
    )
    expect(notice.uncertain).toBe(true)
    expect(notice.refresh).toBe(true)
  })

  test('telegram_failed：撤销结果未确认，按操作给文案且不承诺影响', () => {
    const notice = operationFailureNotice(
      new SubscriptionApiError({
        status: 502,
        code: 'telegram_failed',
        message: 'x',
        retryable: true,
        requestId: null,
      }),
      'revoke',
    )
    expect(notice.message).toBe(
      'Telegram 调用失败，撤销结果未确认。请刷新页面并在频道内核查后决定是否重试；已有订阅和续订如何变化以 Telegram 为准。',
    )
    expect(notice.refresh).toBe(true)
  })
})

describe('创建草稿校验（30 天 1..10000 Stars）', () => {
  test('整数 1..10000 通过，空值/0/10001/小数/非数拒绝', () => {
    expect(validateCreateDraft('', '1')).toEqual({ ok: true, priceStars: 1 })
    expect(validateCreateDraft('名字', '10000')).toEqual({ ok: true, priceStars: 10_000 })
    for (const bad of ['', '0', '10001', '1.5', 'abc', '-3']) {
      expect(validateCreateDraft('', bad).ok).toBe(false)
    }
  })

  test('名称按 code point 计长，33 个字符拒绝；32 个通过', () => {
    expect(validateCreateDraft('名'.repeat(32), '100').ok).toBe(true)
    const tooLong = validateCreateDraft('名'.repeat(33), '100')
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.message).toContain('32')
    // 补充平面字符（emoji）按 1 个 code point 计
    expect(validateCreateDraft('😀'.repeat(32), '1').ok).toBe(true)
  })
})

describe('创建意图：requestId 复用与结果不确定封禁', () => {
  const payload = { chatId: '-1001', name: '支持', priceStars: 100 }

  test('首次提交生成新 requestId', () => {
    const decision = decideCreateIntent(null, payload, () => 'req-1')
    expect(decision.kind).toBe('new')
    expect(decision.intent.requestId).toBe('req-1')
  })

  test('参数相同则复用原 requestId（网络失败重试不换 id）', () => {
    const previous: CreateIntent = { requestId: 'req-1', payload, uncertain: false }
    const decision = decideCreateIntent(previous, { ...payload }, () => 'req-2')
    expect(decision.kind).toBe('reuse')
    expect(decision.intent.requestId).toBe('req-1')
  })

  test('结果不确定且参数变化时阻止自动新建', () => {
    const previous = markCreateUncertain({ requestId: 'req-1', payload, uncertain: false })
    const decision = decideCreateIntent(previous, { ...payload, priceStars: 200 }, () => 'req-2')
    expect(decision.kind).toBe('blocked')
    expect(decision.intent.requestId).toBe('req-1')
  })

  test('结果不确定后同参数仍复用；放弃后（不再传 previous）才允许新 id', () => {
    const uncertain = markCreateUncertain({ requestId: 'req-1', payload, uncertain: false })
    expect(decideCreateIntent(uncertain, { ...payload }, () => 'req-2').kind).toBe('reuse')
    expect(decideCreateIntent(null, { ...payload }, () => 'req-3').intent.requestId).toBe('req-3')
  })

  test('更换频道视为不同意图', () => {
    const previous: CreateIntent = { requestId: 'req-1', payload, uncertain: false }
    const decision = decideCreateIntent(previous, { ...payload, chatId: '-2002' }, () => 'req-2')
    expect(decision.kind).toBe('new')
  })

  test('generateRequestId 生成 UUID 形态且互不相同', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    const first = generateRequestId()
    expect(first).toMatch(uuidPattern)
    expect(generateRequestId()).not.toBe(first)
  })
})

describe('失败提示映射', () => {
  test('bot_permission_required 是频道内权限提示，不触发整屏', () => {
    const notice = operationFailureNotice(
      new SubscriptionApiError({
        status: 403,
        code: 'bot_permission_required',
        message: '缺少权限',
        retryable: false,
        requestId: null,
      }),
      'rename',
    )
    expect(notice.message).toContain('权限')
    expect(notice.uncertain).toBe(false)
  })

  test('结果不确定的错误：标记 uncertain、保留意图并要求刷新', () => {
    for (const code of ['create_outcome_unknown', 'telegram_outcome_unknown', 'persistence_after_telegram_failed']) {
      const notice = operationFailureNotice(
        new SubscriptionApiError({ status: 502, code, message: 'x', retryable: true, requestId: null }),
        'create',
      )
      expect(notice.uncertain, code).toBe(true)
      expect(notice.retainIntent, code).toBe(true)
      expect(notice.refresh, code).toBe(true)
      expect(notice.message, code).toContain('人工核查')
    }
  })

  test('网络错误按结果不确定处理（可能已送达 Telegram）', () => {
    const notice = operationFailureNotice(new TypeError('fetch failed'), 'create')
    expect(notice.uncertain).toBe(true)
    expect(notice.retainIntent).toBe(true)
  })

  test('create_failed 明确失败：不保留意图，可以重新发起', () => {
    const notice = operationFailureNotice(
      new SubscriptionApiError({
        status: 409,
        code: 'create_failed',
        message: '被拒',
        retryable: false,
        requestId: null,
      }),
      'create',
    )
    expect(notice.uncertain).toBe(false)
    expect(notice.retainIntent).toBe(false)
  })

  test('version_conflict / link_revoked 提示刷新', () => {
    const conflict = operationFailureNotice(
      new SubscriptionApiError({ status: 409, code: 'version_conflict', message: 'x', retryable: false, requestId: null }),
      'rename',
    )
    expect(conflict.refresh).toBe(true)
    expect(conflict.message).toContain('刷新')

    const revoked = operationFailureNotice(
      new SubscriptionApiError({ status: 409, code: 'link_revoked', message: 'x', retryable: false, requestId: null }),
      'revoke',
    )
    expect(revoked.refresh).toBe(true)
  })

  test('invalid_request 直接采用服务端消息', () => {
    const notice = operationFailureNotice(
      new SubscriptionApiError({ status: 400, code: 'invalid_request', message: 'name 过长', retryable: false, requestId: null }),
      'create',
    )
    expect(notice.message).toBe('name 过长')
    expect(notice.retainIntent).toBe(false)
  })
})

describe('复制链接（仅用户点击时调用）', () => {
  test('剪贴板可用且写入成功返回 true', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyToClipboard('https://t.me/+abc')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://t.me/+abc')
  })

  test('写入失败返回 false，由 UI 回退到可手动选择的文本', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied')
        }),
      },
    })

    await expect(copyToClipboard('https://t.me/+abc')).resolves.toBe(false)
  })

  test('剪贴板不可用返回 false，不抛错', async () => {
    vi.stubGlobal('navigator', {})

    await expect(copyToClipboard('https://t.me/+abc')).resolves.toBe(false)
  })
})

describe('创建意图的存储（sessionStorage 替身）', () => {
  const chatId = '-1001'
  const key = createIntentStorageKey('u7', chatId)
  const intent: CreateIntent = {
    requestId: '11111111-2222-4333-8444-555566667777',
    payload: { chatId, name: '支持', priceStars: 100 },
    uncertain: true,
  }

  function memoryStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed))
    const storage: IntentStorage & { dump: () => Map<string, string> } = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value)
      },
      removeItem: (key) => {
        map.delete(key)
      },
      dump: () => map,
    }
    return storage
  }

  test('存储键按用户作用域与频道隔离', () => {
    expect(createIntentStorageKey('u7', '-1001')).not.toBe(createIntentStorageKey('u7', '-2002'))
    expect(createIntentStorageKey('u7', '-1001')).not.toBe(createIntentStorageKey('u8', '-1001'))
    expect(resolveIntentScope(7)).toBe('u7')
    expect(resolveIntentScope(undefined)).toBe('anon')
    expect(resolveIntentScope(-1)).toBe('anon')
  })

  test('只写 requestId/name/priceStars/uncertain，不含 initData 或邀请链接', () => {
    const storage = memoryStorage()
    expect(saveStoredIntent(storage, key, intent)).toBe(true)

    const raw = storage.dump().get(key) ?? ''
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['name', 'priceStars', 'requestId', 'uncertain', 'v'])
    expect(raw).not.toContain('initData')
    expect(raw).not.toContain('t.me')
  })

  test('读取校验通过后恢复意图；存储里非不确定的记录在刷新后按不确定处理', () => {
    const storage = memoryStorage({
      [key]: JSON.stringify({
        v: 1,
        requestId: intent.requestId,
        name: '支持',
        priceStars: 100,
        uncertain: false,
      }),
    })

    const loaded = loadStoredIntent(storage, key, chatId)
    expect(loaded?.requestId).toBe(intent.requestId)
    expect(loaded?.uncertain).toBe(true)
  })

  test('脏值（坏 JSON、缺字段、越界价格、坏 UUID、超长名称）一律丢弃并清理', () => {
    const dirty = [
      '{not json',
      JSON.stringify({ v: 1, requestId: intent.requestId, name: 'x', priceStars: 100 }),
      JSON.stringify({ v: 2, requestId: intent.requestId, name: 'x', priceStars: 100, uncertain: true }),
      JSON.stringify({ v: 1, requestId: 'not-a-uuid', name: 'x', priceStars: 100, uncertain: true }),
      JSON.stringify({ v: 1, requestId: intent.requestId, name: 'x'.repeat(33), priceStars: 100, uncertain: true }),
      JSON.stringify({ v: 1, requestId: intent.requestId, name: 'x', priceStars: 0, uncertain: true }),
      JSON.stringify({ v: 1, requestId: intent.requestId, name: 'x', priceStars: 1.5, uncertain: true }),
      JSON.stringify({ v: 1, requestId: intent.requestId, name: 'x', priceStars: 100, uncertain: 'yes' }),
    ]
    for (const raw of dirty) {
      expect(parseStoredIntent(raw, chatId)).toBeNull()
      const storage = memoryStorage({ [key]: raw })
      expect(loadStoredIntent(storage, key, chatId)).toBeNull()
      expect(storage.dump().has(key)).toBe(false)
    }
  })

  test('存储写入/读取抛错时不崩溃：保存返回 false，读取当作无意图', () => {
    const storage: IntentStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }

    expect(saveStoredIntent(storage, key, intent)).toBe(false)
    expect(loadStoredIntent(storage, key, chatId)).toBeNull()
    expect(() => clearStoredIntent(storage, key)).not.toThrow()
  })
})
