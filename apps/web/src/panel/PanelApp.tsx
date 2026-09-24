import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError, ForbiddenError, fetchPanelOverview } from '../api.js'
import type { PanelOverviewDto } from '../api.js'
import { getInitData, getWebApp } from '../telegram.js'
import { AppealsTab } from './AppealsTab.js'
import { DecisionsTab } from './DecisionsTab.js'
import { OverviewTab } from './OverviewTab.js'

/**
 * owner 管理台入口。首屏拉取概览，那次请求同时承担鉴权：
 * 401 → auth 屏，403 → forbidden 屏，网络/5xx → 可重试的失败屏。
 * 三个页签懒挂载、挂载后不卸载（display 切换），保住筛选条件与已加载数据。
 */

type TabKey = 'overview' | 'decisions' | 'appeals'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'decisions', label: '处置' },
  { key: 'appeals', label: '申诉' },
]

type PanelScreen =
  | { kind: 'loading' }
  | { kind: 'no-credential' }
  | { kind: 'auth' }
  | { kind: 'forbidden' }
  | { kind: 'failed'; detail: string }
  | { kind: 'ready'; overview: PanelOverviewDto }

export function PanelApp() {
  const [screen, setScreen] = useState<PanelScreen>({ kind: 'loading' })
  const [tab, setTab] = useState<TabKey>('overview')
  const [mounted, setMounted] = useState<ReadonlySet<TabKey>>(() => new Set<TabKey>(['overview']))
  const initDataRef = useRef('')

  const load = useCallback(async () => {
    const initData = getInitData()
    initDataRef.current = initData
    if (initData === '') {
      // 没有签名凭据，请求必然 401，直接给出可操作的提示
      setScreen({ kind: 'no-credential' })
      return
    }
    setScreen({ kind: 'loading' })
    try {
      const overview = await fetchPanelOverview(initData)
      setScreen({ kind: 'ready', overview })
    } catch (error) {
      if (error instanceof ForbiddenError) setScreen({ kind: 'forbidden' })
      else if (error instanceof AuthError) setScreen({ kind: 'auth' })
      else setScreen({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    // ready/expand 幂等，StrictMode 双调用无副作用
    const webApp = getWebApp()
    webApp?.ready()
    webApp?.expand()
    void load()
  }, [load])

  /** 页签内遇到 401/403 时上升到整屏状态（凭据过期可能发生在任意一次请求）。 */
  const onFatal = useCallback((error: unknown): boolean => {
    if (error instanceof ForbiddenError) {
      setScreen({ kind: 'forbidden' })
      return true
    }
    if (error instanceof AuthError) {
      setScreen({ kind: 'auth' })
      return true
    }
    return false
  }, [])

  const switchTab = useCallback((key: TabKey) => {
    setTab(key)
    setMounted((current) => (current.has(key) ? current : new Set(current).add(key)))
  }, [])

  if (screen.kind !== 'ready') {
    return <PanelStateScreen screen={screen} onRetry={() => void load()} />
  }

  const initData = initDataRef.current
  return (
    <main className="screen">
      <nav className="tabs" aria-label="面板页签">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={key === tab ? 'tab active' : 'tab'}
            aria-pressed={key === tab}
            onClick={() => switchTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div hidden={tab !== 'overview'}>
        <OverviewTab overview={screen.overview} initData={initData} onFatal={onFatal} />
      </div>
      {mounted.has('decisions') && (
        <div hidden={tab !== 'decisions'}>
          <DecisionsTab initData={initData} chats={screen.overview.chats} onFatal={onFatal} />
        </div>
      )}
      {mounted.has('appeals') && (
        <div hidden={tab !== 'appeals'}>
          <AppealsTab initData={initData} onFatal={onFatal} />
        </div>
      )}
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
          <h1>仅管理员可用</h1>
          <p>这个面板只对群主开放。如果你就是群主，请用群主自己的 Telegram 账号打开。</p>
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
