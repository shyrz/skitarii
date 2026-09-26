/**
 * 订阅页签的数据层（phase3b-spec §7）：
 * - 频道分页 + 频道详情/链接/成员三条互相独立的加载链，换频道严格隔离旧响应；
 * - 创建/改名/撤销在模型内完成，操作在途时拒绝切换频道，成功/失败提示只落在发起频道；
 * - 创建意图（requestId）通过 sessionStorage 跨刷新保留：结果不确定时只能复用原 id
 *   重试或显式放弃后新建，绝不自动换 id 再建。
 *
 * 做成可注入 `SubscriptionsApi` 与存储的普通类：竞态、去重、意图语义都能脱离 DOM
 * 用替身按可控顺序验证，React 组件只负责订阅状态并渲染。
 */

import type {
  SubscriptionChannelDetailsDto,
  SubscriptionChannelDto,
  SubscriptionLinkDto,
  SubscriptionMemberDto,
  SubscriptionPage,
  SubscriptionPageRequest,
  SubscriptionsApi,
} from '../api.js'
import type {
  CreateIntent,
  CreatePayload,
  IntentStorage,
  OperationNotice,
} from './subscriptions.js'
import {
  CREATE_BLOCKED_NOTICE,
  CREATE_REPLAY_TEXT,
  CREATE_SUCCESS_TEXT,
  DISCARDED_INTENT_NOTICE,
  RENAME_SUCCESS_TEXT,
  REVOKE_SUCCESS_TEXT,
  clearStoredIntent,
  createIntentStorageKey,
  decideCreateIntent,
  generateRequestId,
  loadStoredIntent,
  markCreateUncertain,
  operationFailureNotice,
  saveStoredIntent,
} from './subscriptions.js'

/** 分页默认值，与后端默认一致（spec §5：默认 50，1..100）。 */
const PAGE_SIZE = 50

/** 单个列表的分页状态。 */
export interface PageState<T> {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  items: T[]
  nextCursor: string | null
  loadingMore: boolean
  moreFailed: boolean
  /** 已有首页数据时刷新失败的提示；不清空现有列表。 */
  refreshFailed: boolean
}

export interface LoadableState<T> {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  value: T | null
  refreshFailed: boolean
}

export type OperationKind = 'idle' | 'creating' | 'renaming' | 'revoking'

export interface SubscriptionsState {
  channels: PageState<SubscriptionChannelDto>
  chatId: string | null
  details: LoadableState<SubscriptionChannelDetailsDto>
  links: PageState<SubscriptionLinkDto>
  members: PageState<SubscriptionMemberDto>
  /** 频道内操作提示；切频道时清除，结果不确定的失败用 danger 色调。 */
  notice: OperationNotice | null
  /** 在途操作：非 idle 时频道切换被禁用，保证结果只落发起频道。 */
  operation: OperationKind
  /** 当前频道的创建意图；不确定时跨刷新保留，需显式放弃才能新建。 */
  createIntent: CreateIntent | null
  /** sessionStorage 不可用或写入失败时的降级提示。 */
  intentStorageDegraded: boolean
}

export interface SubscriptionsModelOptions {
  pageSize?: number
  storage?: IntentStorage | null
  /** UI 隔离作用域（用户 + 频道拼接存储键），不参与鉴权。 */
  intentScope?: string
}

export type CreateSubmitResult =
  | 'created'
  | 'replayed'
  | 'blocked'
  | 'uncertain'
  | 'failed'
  | 'skipped'

type PageMode = 'initial' | 'refresh' | 'more'

function idlePage<T>(): PageState<T> {
  return {
    status: 'idle',
    items: [],
    nextCursor: null,
    loadingMore: false,
    moreFailed: false,
    refreshFailed: false,
  }
}

function loadingPage<T>(): PageState<T> {
  return { ...idlePage<T>(), status: 'loading' }
}

/** 按键去重追加：翻页期间服务端若重复返回边界行，不会出现重复卡片。 */
export function mergeItemsByKey<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map((item) => key(item)))
  const merged = [...current]
  for (const item of incoming) {
    const itemKey = key(item)
    if (seen.has(itemKey)) continue
    seen.add(itemKey)
    merged.push(item)
  }
  return merged
}

/** 带 `id` 的列表（链接/成员）的去重追加。 */
export function mergeItemsById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return mergeItemsByKey(current, incoming, (item) => item.id)
}

function withCursor(limit: number, cursor: string | undefined): SubscriptionPageRequest {
  const query: SubscriptionPageRequest = { limit }
  if (cursor !== undefined) query.cursor = cursor
  return query
}

export class SubscriptionsModel {
  private state: SubscriptionsState = {
    channels: loadingPage(),
    chatId: null,
    details: { status: 'idle', value: null, refreshFailed: false },
    links: idlePage(),
    members: idlePage(),
    notice: null,
    operation: 'idle',
    createIntent: null,
    intentStorageDegraded: false,
  }

  private readonly listeners = new Set<() => void>()

  /** 每个加载链的请求序号：换频道或重新发起时递增，旧响应据此丢弃。 */
  private readonly guards = { channels: 0, details: 0, links: 0, members: 0 }

  private readonly pageSize: number
  private readonly storage: IntentStorage | null
  private readonly intentScope: string

  private started = false

  constructor(
    private readonly api: SubscriptionsApi,
    private readonly initData: string,
    private readonly onFatal: (error: unknown) => boolean,
    options: SubscriptionsModelOptions = {},
  ) {
    this.pageSize = options.pageSize ?? PAGE_SIZE
    this.storage = options.storage ?? null
    this.intentScope = options.intentScope ?? 'anon'
  }

  readonly getState = (): SubscriptionsState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private patch(patch: Partial<SubscriptionsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /* ---- 加载 ---- */

  /** 幂等启动：StrictMode 双调用也只会发一次频道首页请求。 */
  start(): void {
    if (this.started) return
    this.started = true
    void this.loadChannels('initial')
  }

  retryChannels(): void {
    void this.loadChannels('initial')
  }

  loadMoreChannels(): void {
    const current = this.state.channels
    if (current.nextCursor === null || current.loadingMore) return
    void this.loadChannels('more')
  }

  /**
   * 选择频道：清空详情/链接/成员并作废在途响应，然后各自加载首页。
   * 操作在途时拒绝切换（UI 同时禁用按钮），避免旧请求结果落到新频道。
   */
  selectChannel(chatId: string): void {
    if (this.state.operation !== 'idle') return
    if (chatId === this.state.chatId) return
    this.guards.details += 1
    this.guards.links += 1
    this.guards.members += 1
    this.patch({
      chatId,
      notice: null,
      details: { status: 'loading', value: null, refreshFailed: false },
      links: loadingPage(),
      members: loadingPage(),
      createIntent: loadStoredIntent(this.storage, this.intentKey(chatId), chatId),
    })
    void this.loadDetails(chatId)
    this.loadLinks(chatId, 'initial')
    this.loadMembers(chatId, 'initial')
  }

  retryDetails(): void {
    const chatId = this.state.chatId
    if (chatId === null) return
    void this.loadDetails(chatId)
  }

  refreshDetails(): void {
    this.retryDetails()
  }

  retryLinks(): void {
    const chatId = this.state.chatId
    if (chatId === null) return
    this.loadLinks(chatId, this.state.links.items.length === 0 ? 'initial' : 'refresh')
  }

  refreshLinks(): void {
    const chatId = this.state.chatId
    if (chatId === null) return
    this.loadLinks(chatId, 'refresh')
  }

  loadMoreLinks(): void {
    const chatId = this.state.chatId
    const current = this.state.links
    if (chatId === null || current.nextCursor === null || current.loadingMore) return
    this.loadLinks(chatId, 'more')
  }

  retryMembers(): void {
    const chatId = this.state.chatId
    if (chatId === null) return
    this.loadMembers(chatId, this.state.members.items.length === 0 ? 'initial' : 'refresh')
  }

  refreshMembers(): void {
    const chatId = this.state.chatId
    if (chatId === null) return
    this.loadMembers(chatId, 'refresh')
  }

  loadMoreMembers(): void {
    const chatId = this.state.chatId
    const current = this.state.members
    if (chatId === null || current.nextCursor === null || current.loadingMore) return
    this.loadMembers(chatId, 'more')
  }

  /* ---- 创建 / 改名 / 撤销 ---- */

  /**
   * 创建订阅链接。返回 'blocked' 表示存在结果不确定的旧意图且参数已变化，未发请求。
   * 同参数重试复用原 requestId；成功或明确失败清理意图，结果不确定则持久化为不确定。
   */
  async createLink(name: string, priceStars: number): Promise<CreateSubmitResult> {
    const chatId = this.state.chatId
    if (chatId === null || this.state.operation !== 'idle') return 'skipped'
    const payload: CreatePayload = { chatId, name, priceStars }
    const decision = decideCreateIntent(this.state.createIntent, payload, generateRequestId)
    if (decision.kind === 'blocked') {
      this.patch({ notice: { tone: 'caution', text: CREATE_BLOCKED_NOTICE } })
      return 'blocked'
    }

    this.patch({ operation: 'creating', notice: null, createIntent: decision.intent })
    // 先持久化再发请求：刷新丢失在途请求时，恢复出来的意图按「不确定」处理
    this.persistIntent(chatId, decision.intent)
    try {
      const result = await this.api.createLink(chatId, this.initData, {
        requestId: decision.intent.requestId,
        name: payload.name,
        priceStars: payload.priceStars,
      })
      this.clearIntent(chatId)
      if (this.state.chatId === chatId) {
        this.patch({
          notice: {
            tone: 'success',
            text: result.replayed ? CREATE_REPLAY_TEXT : CREATE_SUCCESS_TEXT,
          },
        })
      }
      this.refreshAfterLinkChange(chatId)
      return result.replayed ? 'replayed' : 'created'
    } catch (error) {
      if (this.onFatal(error)) return 'failed'
      const failure = operationFailureNotice(error, 'create')
      if (failure.uncertain) {
        const uncertain = markCreateUncertain(decision.intent)
        this.patch({ createIntent: uncertain })
        this.persistIntent(chatId, uncertain)
      } else if (!failure.retainIntent) {
        this.clearIntent(chatId)
      }
      if (this.state.chatId === chatId) {
        this.patch({
          notice: { tone: failure.uncertain ? 'danger' : 'caution', text: failure.message },
        })
      }
      if (failure.refresh) this.refreshAfterLinkChange(chatId)
      return failure.uncertain ? 'uncertain' : 'failed'
    } finally {
      this.finishOperation('creating')
    }
  }

  async renameLink(link: SubscriptionLinkDto, name: string): Promise<boolean> {
    const chatId = this.state.chatId
    if (chatId === null || link.chatId !== chatId || this.state.operation !== 'idle') return false
    this.patch({ operation: 'renaming', notice: null })
    try {
      await this.api.renameLink(chatId, link.id, this.initData, {
        name,
        expectedVersion: link.version,
      })
      if (this.state.chatId === chatId) {
        this.patch({ notice: { tone: 'success', text: RENAME_SUCCESS_TEXT } })
      }
      this.refreshAfterLinkChange(chatId)
      return true
    } catch (error) {
      return this.handleMutationFailure(error, 'rename', chatId)
    } finally {
      this.finishOperation('renaming')
    }
  }

  async revokeLink(link: SubscriptionLinkDto): Promise<boolean> {
    const chatId = this.state.chatId
    if (chatId === null || link.chatId !== chatId || this.state.operation !== 'idle') return false
    this.patch({ operation: 'revoking', notice: null })
    try {
      await this.api.revokeLink(chatId, link.id, this.initData, {
        expectedVersion: link.version,
      })
      if (this.state.chatId === chatId) {
        this.patch({ notice: { tone: 'success', text: REVOKE_SUCCESS_TEXT } })
      }
      this.refreshAfterLinkChange(chatId)
      return true
    } catch (error) {
      return this.handleMutationFailure(error, 'revoke', chatId)
    } finally {
      this.finishOperation('revoking')
    }
  }

  /** 用户人工核查后显式放弃不确定意图：清理存储后恢复「允许新建」。 */
  discardCreateIntent(): void {
    const chatId = this.state.chatId
    if (chatId === null || this.state.operation !== 'idle') return
    clearStoredIntent(this.storage, this.intentKey(chatId))
    this.patch({
      createIntent: null,
      notice: { tone: 'caution', text: DISCARDED_INTENT_NOTICE },
    })
  }

  /* ---- 内部实现 ---- */

  private intentKey(chatId: string): string {
    return createIntentStorageKey(this.intentScope, chatId)
  }

  /** finally 里恢复 idle。独立方法避免 TS 对 this.state.operation 的旧式收窄。 */
  private finishOperation(kind: OperationKind): void {
    if (this.state.operation === kind) this.patch({ operation: 'idle' })
  }

  private persistIntent(chatId: string, intent: CreateIntent): void {
    if (!saveStoredIntent(this.storage, this.intentKey(chatId), intent)) {
      if (!this.state.intentStorageDegraded) this.patch({ intentStorageDegraded: true })
    }
  }

  private clearIntent(chatId: string): void {
    clearStoredIntent(this.storage, this.intentKey(chatId))
    if (this.state.createIntent !== null) this.patch({ createIntent: null })
  }

  private handleMutationFailure(
    error: unknown,
    action: 'rename' | 'revoke',
    chatId: string,
  ): boolean {
    if (this.onFatal(error)) return false
    const failure = operationFailureNotice(error, action)
    if (this.state.chatId === chatId) {
      this.patch({ notice: { tone: failure.uncertain ? 'danger' : 'caution', text: failure.message } })
    }
    if (failure.refresh) this.refreshAfterLinkChange(chatId)
    return false
  }

  /**
   * 操作成功后：链接首页刷新重置分页，counts（频道详情）独立重读。
   * 传 expectedChatId 时只在仍停留在该频道才刷新，避免操作途中切频道后刷错列表。
   */
  refreshAfterLinkChange(expectedChatId?: string): void {
    const chatId = this.state.chatId
    if (chatId === null) return
    if (expectedChatId !== undefined && expectedChatId !== chatId) return
    this.loadLinks(chatId, 'refresh')
    void this.loadDetails(chatId)
  }

  private async loadChannels(mode: PageMode): Promise<void> {
    const current = this.state.channels
    const cursor = mode === 'more' ? current.nextCursor ?? undefined : undefined
    const seq = ++this.guards.channels
    this.patch({
      channels:
        mode === 'initial'
          ? loadingPage()
          : { ...current, loadingMore: mode === 'more', moreFailed: false, refreshFailed: false },
    })
    try {
      const page = await this.api.fetchChannels(this.initData, withCursor(this.pageSize, cursor))
      if (seq !== this.guards.channels) return
      const before = this.state.channels
      this.patch({
        channels: {
          status: 'ready',
          items:
            mode === 'more'
              ? mergeItemsByKey(before.items, page.items, (item) => item.chatId)
              : page.items,
          nextCursor: page.nextCursor,
          loadingMore: false,
          moreFailed: false,
          refreshFailed: false,
        },
      })
    } catch (error) {
      if (seq !== this.guards.channels) return
      if (this.onFatal(error)) return
      const before = this.state.channels
      this.patch({
        channels: {
          ...before,
          status: mode === 'initial' ? 'failed' : 'ready',
          loadingMore: false,
          moreFailed: mode === 'more',
          refreshFailed: mode === 'refresh',
        },
      })
    }
  }

  private async loadDetails(chatId: string): Promise<void> {
    const seq = ++this.guards.details
    const previous = this.state.details.value
    // 刷新时保留旧值展示；失败也不清空 counts，只标记 refreshFailed
    this.patch({
      details: {
        status: previous === null ? 'loading' : 'ready',
        value: previous,
        refreshFailed: false,
      },
    })
    try {
      const details = await this.api.fetchChannelDetails(chatId, this.initData)
      if (seq !== this.guards.details) return
      this.patch({ details: { status: 'ready', value: details, refreshFailed: false } })
    } catch (error) {
      if (seq !== this.guards.details) return
      if (this.onFatal(error)) return
      this.patch({
        details: {
          status: previous === null ? 'failed' : 'ready',
          value: previous,
          refreshFailed: previous !== null,
        },
      })
    }
  }

  private loadLinks(chatId: string, mode: PageMode): void {
    void this.loadListPage(
      'links',
      mode,
      () => this.state.links,
      (page) => this.patch({ links: page }),
      (cursor) => this.api.fetchLinks(chatId, this.initData, withCursor(this.pageSize, cursor)),
    )
  }

  private loadMembers(chatId: string, mode: PageMode): void {
    void this.loadListPage(
      'members',
      mode,
      () => this.state.members,
      (page) => this.patch({ members: page }),
      (cursor) => this.api.fetchMembers(chatId, this.initData, withCursor(this.pageSize, cursor)),
    )
  }

  /**
   * 列表加载的统一实现：
   * - initial 清空后加载首页，失败进入 failed；
   * - refresh 保留现有列表，失败只标记 refreshFailed；
   * - more 用原游标追加并按 id 去重，失败保留已有结果标记 moreFailed。
   */
  private async loadListPage<T extends { id: string }>(
    key: 'links' | 'members',
    mode: PageMode,
    read: () => PageState<T>,
    write: (page: PageState<T>) => void,
    fetchPage: (cursor: string | undefined) => Promise<SubscriptionPage<T>>,
  ): Promise<void> {
    const current = read()
    const cursor = mode === 'more' ? current.nextCursor ?? undefined : undefined
    const seq = ++this.guards[key]
    write(
      mode === 'initial'
        ? loadingPage<T>()
        : { ...current, loadingMore: mode === 'more', moreFailed: false, refreshFailed: false },
    )
    try {
      const page = await fetchPage(cursor)
      if (seq !== this.guards[key]) return
      const before = read()
      write({
        status: 'ready',
        items: mode === 'more' ? mergeItemsById(before.items, page.items) : page.items,
        nextCursor: page.nextCursor,
        loadingMore: false,
        moreFailed: false,
        refreshFailed: false,
      })
    } catch (error) {
      if (seq !== this.guards[key]) return
      if (this.onFatal(error)) return
      const before = read()
      write({
        ...before,
        status: mode === 'initial' ? 'failed' : 'ready',
        loadingMore: false,
        moreFailed: mode === 'more',
        refreshFailed: mode === 'refresh',
      })
    }
  }
}
