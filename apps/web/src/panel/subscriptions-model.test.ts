import { describe, expect, test, vi } from 'vitest'
import { AuthError, SubscriptionApiError } from '../api.js'
import {
  CREATE_SUCCESS_TEXT,
  DISCARDED_INTENT_NOTICE,
  RENAME_SUCCESS_TEXT,
  REVOKE_SUCCESS_TEXT,
  createIntentStorageKey,
} from './subscriptions.js'
import type { IntentStorage } from './subscriptions.js'
import type {
  CreateSubscriptionLinkInput,
  RenameSubscriptionLinkInput,
  RevokeSubscriptionLinkInput,
  SubscriptionChannelDetailsDto,
  SubscriptionChannelDto,
  SubscriptionLinkDto,
  SubscriptionMemberDto,
  SubscriptionPage,
  SubscriptionMemberCountsDto,
  SubscriptionPageRequest,
  SubscriptionsApi,
} from '../api.js'
import { SubscriptionsModel, mergeItemsById } from './subscriptions-model.js'

/**
 * 订阅数据层的行为：分页去重、游标原样、换频道旧响应隔离、
 * 追加/刷新失败保留已有结果、操作后链接首页与 counts 独立刷新。
 */

const TIME = '2026-09-26T00:00:00.000Z'

function pageOf<T>(items: T[], nextCursor: string | null = null): SubscriptionPage<T> {
  return { items, nextCursor, serverTime: TIME }
}

function channelDto(chatId: string): SubscriptionChannelDto {
  return { chatId, title: `频道 ${chatId}`, chatType: 'channel', linkedChatId: null }
}

function detailsDto(
  chatId: string,
  counts: Partial<SubscriptionMemberCountsDto> = {},
): SubscriptionChannelDetailsDto {
  return {
    ...channelDto(chatId),
    visibility: 'private',
    canManageLinks: true,
    capabilityCheckedAt: TIME,
    capabilityErrorCode: null,
    counts: { known: 0, member: 0, left: 0, unknown: 0, ...counts },
    serverTime: TIME,
  }
}

function linkDto(id: string, chatId = '-1001'): SubscriptionLinkDto {
  return {
    id,
    chatId,
    requestId: `req-${id}`,
    name: id,
    priceStars: 100,
    periodSeconds: 2_592_000,
    inviteLink: `https://t.me/+${id}`,
    state: 'active',
    createdAt: TIME,
    updatedAt: TIME,
    revokedAt: null,
    version: 1,
  }
}

function memberDto(id: string, userId: number, chatId = '-1001'): SubscriptionMemberDto {
  return {
    id,
    chatId,
    userId,
    linkId: null,
    state: 'member',
    expiresAt: null,
    evidence: 'until_date',
    firstObservedAt: TIME,
    observedAt: TIME,
    observationSource: 'event',
    lastCheckedAt: null,
    lastCheckSucceededAt: null,
    lastCheckErrorCode: null,
  }
}

function fakeApi() {
  return {
    fetchChannels: vi.fn(
      async (_initData: string, _query?: SubscriptionPageRequest) =>
        pageOf<SubscriptionChannelDto>([channelDto('c1')]),
    ),
    fetchChannelDetails: vi.fn(async (chatId: string, _initData: string) => detailsDto(chatId)),
    fetchLinks: vi.fn(
      async (_chatId: string, _initData: string, _query?: SubscriptionPageRequest) =>
        pageOf<SubscriptionLinkDto>([]),
    ),
    fetchMembers: vi.fn(
      async (_chatId: string, _initData: string, _query?: SubscriptionPageRequest) =>
        pageOf<SubscriptionMemberDto>([]),
    ),
    createLink: vi.fn(
      async (
        _chatId: string,
        _initData: string,
        _input: CreateSubscriptionLinkInput,
      ) => ({ link: linkDto('generated'), replayed: false }),
    ),
    renameLink: vi.fn(
      async (
        _chatId: string,
        _linkId: string,
        _initData: string,
        _input: RenameSubscriptionLinkInput,
      ) => linkDto('generated'),
    ),
    revokeLink: vi.fn(
      async (
        _chatId: string,
        _linkId: string,
        _initData: string,
        _input: RevokeSubscriptionLinkInput,
      ) => linkDto('generated'),
    ),
  } satisfies SubscriptionsApi
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让已 resolve 的微任务链跑完（mock 实现都是 async）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 内存版 IntentStorage，替代 sessionStorage；dump 用于断言落盘内容与清理。 */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    dump: () => map,
  }
}

describe('mergeItemsById', () => {
  test('按 id 去重追加并保留原顺序', () => {
    expect(mergeItemsById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ])
  })
})

describe('频道分页', () => {
  test('start 幂等，首次请求带 initData 与默认 limit', async () => {
    const api = fakeApi()
    const model = new SubscriptionsModel(api, 'init', () => false)

    model.start()
    model.start()
    await flush()

    expect(api.fetchChannels).toHaveBeenCalledTimes(1)
    expect(api.fetchChannels).toHaveBeenCalledWith('init', { limit: 50 })
    expect(model.getState().channels.status).toBe('ready')
    expect(model.getState().channels.items.map((c) => c.chatId)).toEqual(['c1'])
  })

  test('加载更多用原游标原样请求，边界重复行按 id 去重', async () => {
    const api = fakeApi()
    api.fetchChannels.mockResolvedValueOnce(
      pageOf([channelDto('c1'), channelDto('c2')], 'cursor-1'),
    )
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.start()
    await flush()

    api.fetchChannels.mockResolvedValueOnce(pageOf([channelDto('c2'), channelDto('c3')], null))
    model.loadMoreChannels()
    await flush()

    expect(api.fetchChannels).toHaveBeenLastCalledWith('init', { limit: 50, cursor: 'cursor-1' })
    expect(model.getState().channels.items.map((c) => c.chatId)).toEqual(['c1', 'c2', 'c3'])
  })

  test('加载更多失败保留已有列表与游标', async () => {
    const api = fakeApi()
    api.fetchChannels.mockResolvedValueOnce(pageOf([channelDto('c1')], 'cursor-1'))
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.start()
    await flush()

    api.fetchChannels.mockRejectedValueOnce(new Error('boom'))
    model.loadMoreChannels()
    await flush()

    const channels = model.getState().channels
    expect(channels.items).toHaveLength(1)
    expect(channels.nextCursor).toBe('cursor-1')
    expect(channels.moreFailed).toBe(true)
    expect(channels.status).toBe('ready')
  })
})

describe('换频道竞态隔离', () => {
  test('快速切换频道：旧频道的详情/链接/成员响应全部丢弃，列表与游标清空', async () => {
    const api = fakeApi()
    const aDetails = deferred<SubscriptionChannelDetailsDto>()
    const bDetails = deferred<SubscriptionChannelDetailsDto>()
    const aLinks = deferred<SubscriptionPage<SubscriptionLinkDto>>()
    const bLinks = deferred<SubscriptionPage<SubscriptionLinkDto>>()
    const aMembers = deferred<SubscriptionPage<SubscriptionMemberDto>>()
    const bMembers = deferred<SubscriptionPage<SubscriptionMemberDto>>()
    api.fetchChannelDetails.mockImplementation((chatId: string) =>
      chatId === 'A' ? aDetails.promise : bDetails.promise,
    )
    api.fetchLinks.mockImplementation((chatId: string) =>
      chatId === 'A' ? aLinks.promise : bLinks.promise,
    )
    api.fetchMembers.mockImplementation((chatId: string) =>
      chatId === 'A' ? aMembers.promise : bMembers.promise,
    )
    const model = new SubscriptionsModel(api, 'init', () => false)

    model.selectChannel('A')
    model.selectChannel('B')
    expect(model.getState().links.items).toEqual([])

    // 先返回 B 的数据
    bDetails.resolve(detailsDto('B', { member: 5 }))
    bLinks.resolve(pageOf([linkDto('b1', 'B')]))
    bMembers.resolve(pageOf([memberDto('bm1', 7, 'B')]))
    await flush()

    // 迟到的 A 响应不得覆盖 B
    aDetails.resolve(detailsDto('A', { member: 9 }))
    aLinks.resolve(pageOf([linkDto('a1', 'A')], 'a-cursor'))
    aMembers.resolve(pageOf([memberDto('am1', 1, 'A')], 'a-cursor'))
    await flush()

    const state = model.getState()
    expect(state.chatId).toBe('B')
    expect(state.details.value?.chatId).toBe('B')
    expect(state.links.items.map((l) => l.id)).toEqual(['b1'])
    expect(state.links.nextCursor).toBeNull()
    expect(state.members.items.map((m) => m.id)).toEqual(['bm1'])
    expect(state.members.nextCursor).toBeNull()
  })
})

describe('链接列表', () => {
  test('首页失败进入 failed，重试成功后恢复；追加成功按 id 去重', async () => {
    const api = fakeApi()
    api.fetchLinks.mockRejectedValueOnce(new Error('boom'))
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('-1001')
    await flush()
    expect(model.getState().links.status).toBe('failed')

    api.fetchLinks.mockResolvedValueOnce(pageOf([linkDto('l1'), linkDto('l2')], 'links-cursor'))
    model.retryLinks()
    await flush()

    expect(model.getState().links.status).toBe('ready')
    expect(model.getState().links.items.map((l) => l.id)).toEqual(['l1', 'l2'])

    api.fetchLinks.mockResolvedValueOnce(pageOf([linkDto('l2'), linkDto('l3')], null))
    model.loadMoreLinks()
    await flush()

    expect(api.fetchLinks).toHaveBeenLastCalledWith('-1001', 'init', {
      limit: 50,
      cursor: 'links-cursor',
    })
    expect(model.getState().links.items.map((l) => l.id)).toEqual(['l1', 'l2', 'l3'])
  })

  test('刷新失败保留已有列表，只标记 refreshFailed', async () => {
    const api = fakeApi()
    api.fetchLinks.mockResolvedValueOnce(pageOf([linkDto('l1')], 'links-cursor'))
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('-1001')
    await flush()

    api.fetchLinks.mockRejectedValueOnce(new Error('boom'))
    model.refreshLinks()
    await flush()

    const links = model.getState().links
    expect(links.status).toBe('ready')
    expect(links.items.map((l) => l.id)).toEqual(['l1'])
    expect(links.nextCursor).toBe('links-cursor')
    expect(links.refreshFailed).toBe(true)
  })

  test('操作成功后刷新链接首页（无游标）并独立重读 counts（详情）', async () => {
    const api = fakeApi()
    api.fetchLinks.mockResolvedValueOnce(pageOf([linkDto('l1')], 'links-cursor'))
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('-1001')
    await flush()
    const detailCallsBefore = api.fetchChannelDetails.mock.calls.length

    api.fetchLinks.mockResolvedValueOnce(pageOf([linkDto('l2', '-1001')], null))
    model.refreshAfterLinkChange()
    await flush()

    expect(api.fetchLinks).toHaveBeenLastCalledWith('-1001', 'init', { limit: 50 })
    expect(api.fetchChannelDetails.mock.calls.length).toBe(detailCallsBefore + 1)
    expect(model.getState().links.items.map((l) => l.id)).toEqual(['l2'])
    expect(model.getState().links.nextCursor).toBeNull()
  })

  test('操作后刷新：只有在频道匹配时才刷新，切频道途中不会刷错列表', async () => {
    const api = fakeApi()
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('B')
    await flush()

    api.fetchLinks.mockClear()
    api.fetchChannelDetails.mockClear()
    model.refreshAfterLinkChange('A')
    await flush()

    expect(api.fetchLinks).not.toHaveBeenCalled()
    expect(api.fetchChannelDetails).not.toHaveBeenCalled()
  })

  test('详情刷新失败保留上一次的 counts', async () => {
    const api = fakeApi()
    api.fetchChannelDetails.mockResolvedValueOnce(detailsDto('-1001', { known: 3, member: 2 }))
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('-1001')
    await flush()

    api.fetchChannelDetails.mockRejectedValueOnce(new Error('boom'))
    model.refreshDetails()
    await flush()

    const details = model.getState().details
    expect(details.status).toBe('ready')
    expect(details.value?.counts.known).toBe(3)
    expect(details.refreshFailed).toBe(true)
  })
})

describe('成员列表', () => {
  test('独立加载与分页；换频道前已清空', async () => {
    const api = fakeApi()
    api.fetchMembers.mockResolvedValueOnce(pageOf([memberDto('m1', 42)], 'members-cursor'))
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('-1001')
    await flush()

    expect(model.getState().members.items.map((m) => m.userId)).toEqual([42])

    api.fetchMembers.mockResolvedValueOnce(pageOf([memberDto('m1', 42), memberDto('m2', 43)], null))
    model.loadMoreMembers()
    await flush()

    expect(api.fetchMembers).toHaveBeenLastCalledWith('-1001', 'init', {
      limit: 50,
      cursor: 'members-cursor',
    })
    expect(model.getState().members.items.map((m) => m.userId)).toEqual([42, 43])
  })
})

describe('鉴权失败上升', () => {
  test('onFatal 接管的错误不落本地失败态', async () => {
    const api = fakeApi()
    const onFatal = vi.fn(() => true)
    api.fetchChannelDetails.mockRejectedValueOnce(new AuthError())
    const model = new SubscriptionsModel(api, 'init', onFatal)

    model.selectChannel('-1001')
    await flush()

    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(model.getState().details.status).toBe('loading')
  })
})

describe('在途操作与换频道隔离（延迟 promise）', () => {
  test('创建在途：切换频道被拒绝；成功后提示与刷新只落原频道', async () => {
    const api = fakeApi()
    const pending = deferred<{ link: SubscriptionLinkDto; replayed: boolean }>()
    api.createLink.mockReturnValueOnce(pending.promise)
    const model = new SubscriptionsModel(api, 'init', () => false, {
      storage: memoryStorage(),
      intentScope: 'u1',
    })
    model.selectChannel('A')
    await flush()
    api.fetchLinks.mockClear()
    api.fetchChannelDetails.mockClear()

    const creating = model.createLink('支持', 100)
    expect(model.getState().operation).toBe('creating')

    // 在途：切换频道被模型拒绝，旧请求结果不会落到新频道
    model.selectChannel('B')
    expect(model.getState().chatId).toBe('A')

    pending.resolve({ link: linkDto('l1', 'A'), replayed: false })
    expect(await creating).toBe('created')

    expect(model.getState().operation).toBe('idle')
    expect(model.getState().chatId).toBe('A')
    expect(model.getState().notice?.text).toBe(CREATE_SUCCESS_TEXT)
    expect(api.fetchLinks.mock.calls.length).toBeGreaterThan(0)
    for (const call of api.fetchLinks.mock.calls) expect(call[0]).toBe('A')
    for (const call of api.fetchChannelDetails.mock.calls) expect(call[0]).toBe('A')
  })

  test('改名在途：切换频道被拒绝；成功提示只写原频道', async () => {
    const api = fakeApi()
    const pending = deferred<SubscriptionLinkDto>()
    api.renameLink.mockReturnValueOnce(pending.promise)
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('A')
    await flush()

    const renaming = model.renameLink(linkDto('l1', 'A'), '新名')
    expect(model.getState().operation).toBe('renaming')

    model.selectChannel('B')
    expect(model.getState().chatId).toBe('A')

    pending.resolve(linkDto('l1', 'A'))
    expect(await renaming).toBe(true)
    expect(model.getState().operation).toBe('idle')
    expect(model.getState().chatId).toBe('A')
    expect(model.getState().notice?.text).toBe(RENAME_SUCCESS_TEXT)
  })

  test('撤销在途：切换频道被拒绝；成功提示只写原频道', async () => {
    const api = fakeApi()
    const pending = deferred<SubscriptionLinkDto>()
    api.revokeLink.mockReturnValueOnce(pending.promise)
    const model = new SubscriptionsModel(api, 'init', () => false)
    model.selectChannel('A')
    await flush()

    const revoking = model.revokeLink(linkDto('l1', 'A'))
    expect(model.getState().operation).toBe('revoking')

    model.selectChannel('B')
    expect(model.getState().chatId).toBe('A')

    pending.resolve(linkDto('l1', 'A'))
    expect(await revoking).toBe(true)
    expect(model.getState().operation).toBe('idle')
    expect(model.getState().chatId).toBe('A')
    expect(model.getState().notice?.text).toBe(REVOKE_SUCCESS_TEXT)
  })
})

describe('创建意图跨刷新与清理（存储替身）', () => {
  const storedKey = createIntentStorageKey('u1', '-1001')

  test('网络失败持久化为不确定；新实例恢复后阻止换参数新建，同参数复用原 requestId，成功后清理', async () => {
    const storage = memoryStorage()
    const api = fakeApi()
    api.createLink.mockRejectedValueOnce(new TypeError('fetch failed'))
    const model = new SubscriptionsModel(api, 'init', () => false, {
      storage,
      intentScope: 'u1',
    })
    model.selectChannel('-1001')
    await flush()

    expect(await model.createLink('支持', 100)).toBe('uncertain')
    const intent = model.getState().createIntent
    expect(intent?.uncertain).toBe(true)

    // 落盘内容只含 requestId/name/priceStars/uncertain 与版本号
    expect(JSON.parse(storage.dump().get(storedKey) ?? '')).toEqual({
      v: 1,
      requestId: intent?.requestId,
      name: '支持',
      priceStars: 100,
      uncertain: true,
    })

    // 模拟刷新：新模型实例 + 同一 sessionStorage
    const api2 = fakeApi()
    const refreshed = new SubscriptionsModel(api2, 'init', () => false, {
      storage,
      intentScope: 'u1',
    })
    refreshed.selectChannel('-1001')
    expect(refreshed.getState().createIntent?.uncertain).toBe(true)

    // 换参数：被阻止且不发请求（不会自动新建）
    expect(await refreshed.createLink('支持', 200)).toBe('blocked')
    expect(api2.createLink).not.toHaveBeenCalled()

    // 同参数：复用原 requestId
    api2.createLink.mockResolvedValueOnce({ link: linkDto('l9'), replayed: true })
    expect(await refreshed.createLink('支持', 100)).toBe('replayed')
    expect(api2.createLink).toHaveBeenCalledWith('-1001', 'init', {
      requestId: intent?.requestId,
      name: '支持',
      priceStars: 100,
    })
    expect(storage.dump().has(storedKey)).toBe(false)
    expect(refreshed.getState().createIntent).toBeNull()
  })

  test('明确失败（create_failed）清理存储，允许重新发起', async () => {
    const storage = memoryStorage()
    const api = fakeApi()
    api.createLink.mockRejectedValueOnce(
      new SubscriptionApiError({
        status: 409,
        code: 'create_failed',
        message: '被拒',
        retryable: false,
        requestId: null,
      }),
    )
    const model = new SubscriptionsModel(api, 'init', () => false, { storage, intentScope: 'u1' })
    model.selectChannel('-1001')
    await flush()

    expect(await model.createLink('支持', 100)).toBe('failed')
    expect(model.getState().createIntent).toBeNull()
    expect(storage.dump().has(storedKey)).toBe(false)
  })

  test('存储写入失败：标记降级提示，内存意图仍可同 requestId 重试', async () => {
    const storage: IntentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => undefined,
    }
    const api = fakeApi()
    api.createLink.mockRejectedValueOnce(new TypeError('fetch failed'))
    const model = new SubscriptionsModel(api, 'init', () => false, { storage, intentScope: 'u1' })
    model.selectChannel('-1001')
    await flush()

    expect(await model.createLink('支持', 100)).toBe('uncertain')
    expect(model.getState().intentStorageDegraded).toBe(true)
    const requestId = model.getState().createIntent?.requestId

    api.createLink.mockResolvedValueOnce({ link: linkDto('l9'), replayed: false })
    expect(await model.createLink('支持', 100)).toBe('created')
    expect(api.createLink).toHaveBeenLastCalledWith('-1001', 'init', {
      requestId,
      name: '支持',
      priceStars: 100,
    })
  })

  test('显式放弃后清理存储，下一次用新 requestId 新建', async () => {
    const storage = memoryStorage()
    const api = fakeApi()
    api.createLink.mockRejectedValueOnce(new TypeError('fetch failed'))
    const model = new SubscriptionsModel(api, 'init', () => false, { storage, intentScope: 'u1' })
    model.selectChannel('-1001')
    await flush()

    await model.createLink('支持', 100)
    const oldRequestId = model.getState().createIntent?.requestId
    expect(oldRequestId).toBeDefined()

    model.discardCreateIntent()
    expect(model.getState().createIntent).toBeNull()
    expect(model.getState().notice?.text).toBe(DISCARDED_INTENT_NOTICE)
    expect(storage.dump().has(storedKey)).toBe(false)

    api.createLink.mockResolvedValueOnce({ link: linkDto('l9'), replayed: false })
    expect(await model.createLink('支持', 200)).toBe('created')
    const lastCall = api.createLink.mock.calls.at(-1)
    expect(lastCall?.[2].priceStars).toBe(200)
    expect(lastCall?.[2].requestId).toBeDefined()
    expect(lastCall?.[2].requestId).not.toBe(oldRequestId)
  })
})
