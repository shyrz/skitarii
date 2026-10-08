import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError, ForbiddenError, fetchPanelOverview } from '../api.js'
import type { PanelOverviewDto } from '../api.js'
import { getInitData, getWebApp } from '../telegram.js'
import { AppealsTab } from './AppealsTab.js'
import { DecisionsTab } from './DecisionsTab.js'
import { OverviewTab } from './OverviewTab.js'
import { RulesTab } from './RulesTab.js'
import type { RulesHandle } from './RulesTab.js'
import { SubscriptionsTab } from './SubscriptionsTab.js'
import type { SubscriptionsHandle } from './SubscriptionsTab.js'

/**
 * owner 管理台入口。首屏拉取概览，那次请求同时承担鉴权：
 * 401 → auth 屏，403 → forbidden 屏，网络/5xx → 可重试的失败屏。
 * 页签懒挂载、挂载后不卸载（display 切换），保住筛选条件与已加载数据。
 */

type View = { page: 'overview' | 'review' | 'objects' }
  | { page: 'rules'; chatId: string; ruleId?: string }
  | { page: 'subscriptions'; chatId: string }
type ReviewSection = 'open' | 'decisions' | 'resolved'
type Navigation = { view: View; scope?: string; section?: ReviewSection }
type ReturnPoint = Navigation & { y: number; focus: HTMLElement | null }
type NavigationRequest = { target: Navigation; mode: 'push' | 'root' | 'back'; from: ReturnPoint }

type PanelScreen =
  | { kind: 'loading' }
  | { kind: 'no-credential' }
  | { kind: 'auth' }
  | { kind: 'forbidden' }
  | { kind: 'failed'; detail: string }
  | { kind: 'ready'; overview: PanelOverviewDto }

export function PanelApp() {
  const [screen, setScreen] = useState<PanelScreen>({ kind: 'loading' })
  const [view, setView] = useState<View>({ page: 'overview' })
  const [scope, setScope] = useState('')
  const [section, setSection] = useState<ReviewSection>('open')
  const [mounted, setMounted] = useState(() => new Set<string>(['overview']))
  const [pendingNavigation, setPendingNavigation] = useState<NavigationRequest | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const initDataRef = useRef('')
  const refreshInFlight = useRef(false)
  const refreshInvalidated = useRef(false)
  const lastUpdated = useRef(0)
  const history = useRef<ReturnPoint[]>([])
  const positions = useRef(new Map<string, ReturnPoint>())
  const restoring = useRef<ReturnPoint | null>(null)
  const rulesRef = useRef<RulesHandle>(null)
  const subscriptionsRef = useRef<SubscriptionsHandle>(null)

  const onFatal = useCallback((error: unknown): boolean => {
    if (error instanceof ForbiddenError) { setScreen({ kind: 'forbidden' }); return true }
    if (error instanceof AuthError) { setScreen({ kind: 'auth' }); return true }
    return false
  }, [])

  const load = useCallback(async () => {
    const initData = getInitData()
    initDataRef.current = initData
    if (initData === '') { setScreen({ kind: 'no-credential' }); return }
    setScreen({ kind: 'loading' })
    try {
      const overview = await fetchPanelOverview(initData)
      const groups = overview.chats.filter(chat => chat.chatType !== 'channel')
      let savedScope = ''
      try { savedScope = sessionStorage.getItem(`skitarii:review-scope:${getWebApp()?.initDataUnsafe.user?.id ?? 'anon'}`) ?? '' } catch {}
      setScope(groups.some(chat => chat.chatId === savedScope) ? savedScope : groups.length === 1 ? groups[0]!.chatId : '')
      lastUpdated.current = Date.now()
      setScreen({ kind: 'ready', overview })
    } catch (error) {
      if (!onFatal(error)) setScreen({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }, [onFatal])

  const refreshOverview = useCallback(async (invalidate = false): Promise<void> => {
    if (refreshInFlight.current) {
      if (invalidate) refreshInvalidated.current = true
      return
    }
    refreshInFlight.current = true
    setRefreshing(true)
    setRefreshError(null)
    try {
      const overview = await fetchPanelOverview(initDataRef.current)
      if (refreshInvalidated.current) return
      lastUpdated.current = Date.now()
      setScreen(current => current.kind === 'ready' ? { kind: 'ready', overview } : current)
    } catch (error) {
      if (!onFatal(error)) setRefreshError('更新失败，保留上次数据。')
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
      if (refreshInvalidated.current) {
        refreshInvalidated.current = false
        void refreshOverview()
      }
    }
  }, [onFatal])

  useEffect(() => {
    document.title = 'Skitarii 管理台'
    getWebApp()?.ready()
    getWebApp()?.expand()
    void load()
  }, [load])

  const selectScope = (id: string) => {
    setScope(id)
    try { sessionStorage.setItem(`skitarii:review-scope:${getWebApp()?.initDataUnsafe.user?.id ?? 'anon'}`, id) } catch {}
  }

  const navigate = (target: Navigation, push = true) => {
    if (reviewBusy) return
    const point: ReturnPoint = { view, scope, section, y: window.scrollY, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null }
    setMounted(current => new Set(current).add(target.view.page).add(target.section === 'decisions' ? 'decisions' : 'appeals'))
    setPendingNavigation({ target, mode: push ? 'push' : 'root', from: point })
  }

  useEffect(() => {
    if (pendingNavigation === null) return
    const { target: navigation, mode, from } = pendingNavigation
    const target = navigation.view
    const accepted = target.page === 'rules' ? rulesRef.current?.selectChat(target.chatId, target.ruleId)
      : target.page === 'subscriptions' ? subscriptionsRef.current?.selectChannel(target.chatId) : true
    if (accepted === undefined) return
    if (accepted) {
      positions.current.set(from.view.page, from)
      if (mode === 'push') { history.current.push(from); restoring.current = null }
      else if (mode === 'root') { history.current = []; restoring.current = positions.current.get(target.page) ?? null }
      else restoring.current = history.current.pop() ?? null
      if (navigation.scope !== undefined) {
        setScope(navigation.scope)
        try { sessionStorage.setItem(`skitarii:review-scope:${getWebApp()?.initDataUnsafe.user?.id ?? 'anon'}`, navigation.scope) } catch {}
      }
      if (navigation.section !== undefined) setSection(navigation.section)
      setView(target)
    } else setRefreshError('当前对象正在保存，请完成后再切换。')
    setPendingNavigation(null)
  }, [pendingNavigation])

  useEffect(() => {
    const target = restoring.current
    restoring.current = null
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, target?.y ?? 0)
      if (target?.focus?.isConnected) target.focus.focus({ preventScroll: true })
    })
    if (view.page === 'overview' && Date.now() - lastUpdated.current > 30_000) void refreshOverview()
    return () => cancelAnimationFrame(frame)
  }, [view, refreshOverview])

  const goBack = () => {
    if (reviewBusy) return
    const previous = history.current.at(-1)
    if (previous === undefined) { navigate({ view: { page: 'overview' } }, false); return }
    setMounted(current => new Set(current).add(previous.view.page))
    setPendingNavigation({ target: previous, mode: 'back', from: { view, scope, section, y: window.scrollY, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null } })
  }

  useEffect(() => {
    const back = getWebApp()?.BackButton
    if (!back) return
    if (history.current.length > 0 || view.page === 'rules' || view.page === 'subscriptions') back.show()
    else back.hide()
    back.onClick(goBack)
    return () => { back.offClick(goBack); back.hide() }
  })

  const onAppealChanged = useCallback(() => {
    setRevision(value => value + 1)
    void refreshOverview(true)
  }, [refreshOverview])

  if (screen.kind !== 'ready') return <PanelStateScreen screen={screen} onRetry={() => void load()} />
  const { overview } = screen
  const groups = overview.chats.filter(chat => chat.chatType !== 'channel')
  const activeRoot = view.page === 'overview' ? 'overview' : view.page === 'review' ? 'review' : 'objects'
  const initData = initDataRef.current
  return (
    <main className="screen panel-screen">
      <header className="row-between panel-heading">
        <h1>{view.page === 'overview' ? '工作台' : view.page === 'review' ? '审核' : view.page === 'objects' ? '群与频道' : view.page === 'rules' ? '群设置' : '频道订阅'}</h1>
        {(history.current.length > 0 || view.page === 'rules' || view.page === 'subscriptions') && <button type="button" className="text-btn" disabled={reviewBusy} onClick={goBack}>返回</button>}
      </header>
      {refreshError !== null && <p className="form-error" role="alert">{refreshError}</p>}
      <div hidden={view.page !== 'overview'}>
        <OverviewTab overview={overview} initData={initData} onFatal={onFatal} refreshing={refreshing}
          onRefresh={() => void refreshOverview()}
          onOpenReview={(chatId, section) => navigate({ view: { page: 'review' }, scope: chatId, section })}
          onOpenAppeals={chatId => navigate({ view: { page: 'review' }, scope: chatId, section: 'open' })}
          onOpenObject={chat => navigate({ view: { page: chat.chatType === 'channel' ? 'subscriptions' : 'rules', chatId: chat.chatId } })} />
      </div>
      <div hidden={view.page !== 'review'}>
        <div className="review-controls">
          <select className="select" aria-label="审核范围" value={scope} disabled={reviewBusy} onChange={event => selectScope(event.target.value)}>
            <option value="">全部群</option>
            {groups.map(chat => <option key={chat.chatId} value={chat.chatId}>{chat.title}</option>)}
          </select>
          <div className="seg" role="group" aria-label="审核任务">
            {(['open', 'decisions', 'resolved'] as const).map(key => <button type="button" key={key} disabled={reviewBusy}
              className={section === key ? 'active' : ''} aria-pressed={section === key}
              onClick={() => { setSection(key); setMounted(current => new Set(current).add(key === 'decisions' ? 'decisions' : 'appeals')) }}>
              {key === 'open' ? '待处理申诉' : key === 'decisions' ? '处置记录' : '已结案'}
            </button>)}
          </div>
        </div>
        {mounted.has('appeals') && <div hidden={section === 'decisions'}>
          <AppealsTab initData={initData} chatId={scope} queue={section === 'resolved' ? 'resolved' : 'open'}
            active={view.page === 'review' && section !== 'decisions'} revision={revision}
            onChanged={onAppealChanged} onBusyChange={setReviewBusy} onFatal={onFatal}
            onOpenRule={(chatId, ruleId) => navigate({ view: { page: 'rules', chatId, ruleId } })} />
        </div>}
        {mounted.has('decisions') && <div hidden={section !== 'decisions'}>
          <DecisionsTab initData={initData} chatId={scope} active={view.page === 'review' && section === 'decisions'}
            onOpenRule={(chatId, ruleId) => navigate({ view: { page: 'rules', chatId, ruleId } })} onFatal={onFatal} />
        </div>}
      </div>
      <div hidden={view.page !== 'objects'} className="stack">
        {overview.chats.length === 0 && <p className="empty-state">还没有接入群或频道。</p>}
        {overview.chats.map(chat => <button type="button" className="list-card object-card" key={chat.chatId}
          onClick={() => navigate({ view: { page: chat.chatType === 'channel' ? 'subscriptions' : 'rules', chatId: chat.chatId } })}>
          <span className="list-title">{chat.title}</span><span className="list-sub">{chat.chatType === 'channel' ? '频道 · 订阅链接与成员' : '群 · 规则与信任名单'}</span>
        </button>)}
      </div>
      {mounted.has('rules') && <div hidden={view.page !== 'rules'}>
        <RulesTab ref={rulesRef} initData={initData} chats={groups} onFatal={onFatal}
          onSelected={chatId => setView(current => current.page === 'rules' && current.chatId !== chatId ? { page: 'rules', chatId } : current)}
          onOpenReview={chatId => navigate({ view: { page: 'review' }, scope: chatId, section: 'decisions' })} />
      </div>}
      {mounted.has('subscriptions') && <div hidden={view.page !== 'subscriptions'}>
        <SubscriptionsTab ref={subscriptionsRef} initData={initData} onFatal={onFatal}
          onSelected={chatId => setView(current => current.page === 'subscriptions' && current.chatId !== chatId ? { page: 'subscriptions', chatId } : current)}
          onOpenDiscussion={chatId => navigate({ view: { page: 'review' }, scope: chatId, section: 'decisions' })} />
      </div>}
      <nav className="primary-nav" aria-label="主导航">
        {([['overview', '工作台'], ['review', '审核'], ['objects', '群与频道']] as const).map(([page, label]) =>
          <button key={page} type="button" className={activeRoot === page ? 'active' : ''} aria-current={activeRoot === page ? 'page' : undefined}
            disabled={reviewBusy} onClick={() => navigate({ view: { page }, section }, false)}>{label}</button>)}
      </nav>
    </main>
  )
}

/** 面板级整屏状态，复用申诉页的居中状态版式。 */
function PanelStateScreen({ screen, onRetry }: { screen: PanelScreen; onRetry: () => void }) {
  if (screen.kind === 'loading') {
    return (
      <main className="screen">
        <div className="center-state">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在打开管理台…</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'no-credential') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>页面缺少登录凭据</h1>
          <p>请从 Telegram 内打开本页，不要把链接复制到外部浏览器。</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'auth') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>身份验证失败</h1>
          <p>凭据已过期或无效。回到 Telegram 重新打开面板即可刷新。</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'forbidden') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>仅负责人可用</h1>
          <p>这个面板只对配置中的负责人账号开放，请使用该 Telegram 账号进入。</p>
        </div>
      </main>
    )
  }

  return (
    <main className="screen">
      <div className="center-state">
        <InfoIcon />
        <h1>内容没加载出来</h1>
        <p>网络似乎不太稳定，重试不会重复操作。</p>
        {screen.kind === 'failed' && <p className="detail">{screen.detail}</p>}
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      </div>
    </main>
  )
}

function InfoIcon() {
  return (
    <svg
      width={40}
      height={40}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="state-icon"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}
