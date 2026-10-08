import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPanelDecisions } from '../api.js'
import { executionText } from '../execution.js'
import type {
  DecisionAction,
  PanelDecisionCursor,
  PanelDecisionDto,
  PanelDecisionFilter,
} from '../api.js'
import { ACTION_LABEL, ACTION_TONE, VERDICT_LABEL, formatTime } from './util.js'

/**
 * 处置页签：非放行决策流，时间倒序 + 加载更多，可按群与档位筛选。
 * 「仅处置」是后端默认（不传 action），「全部动作」才显式传 action=all。
 */

type ActionFilter = 'default' | 'all' | DecisionAction

const ACTION_OPTIONS: { value: ActionFilter; label: string }[] = [
  { value: 'default', label: '仅处置' },
  { value: 'all', label: '全部动作' },
  { value: 'warn', label: '警告' },
  { value: 'delete', label: '删除' },
  { value: 'mute', label: '禁言' },
  { value: 'ban', label: '封禁' },
]

const PAGE_SIZE = 50

function llmText(llm: PanelDecisionDto['llm']): string {
  if (llm === null) return '未复核'
  return `复核：${VERDICT_LABEL[llm.verdict] ?? llm.verdict} ${Math.round(llm.confidence * 100)}%`
}

export function DecisionsTab({
  initData,
  chatId,
  active,
  onOpenRule,
  onFatal,
}: {
  initData: string
  chatId: string
  active: boolean
  onOpenRule: (chatId: string, ruleId: string) => void
  onFatal: (error: unknown) => boolean
}) {
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading')
  const [items, setItems] = useState<PanelDecisionDto[]>([])
  const [nextBefore, setNextBefore] = useState<PanelDecisionCursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 加载更多失败只提示按钮上方一行，不顶掉已加载的列表。 */
  const [moreFailed, setMoreFailed] = useState(false)
  const [actionFilter, setActionFilter] = useState<ActionFilter>('default')
  const request = useRef<AbortController | null>(null)
  const loadedPages = useRef(1)
  const loadedKey = useRef('')
  const updatedAt = useRef(0)
  const [refreshing, setRefreshing] = useState(false)

  const buildFilter = useCallback(
    (before?: PanelDecisionCursor): PanelDecisionFilter => {
      const filter: PanelDecisionFilter = { limit: PAGE_SIZE }
      if (chatId !== '') filter.chatId = chatId
      if (actionFilter === 'all') filter.action = 'all'
      else if (actionFilter !== 'default') filter.action = actionFilter
      if (before !== undefined) filter.before = before
      return filter
    },
    [chatId, actionFilter],
  )

  const reload = useCallback(async () => {
    if (request.current !== null) return
    const current = new AbortController()
    request.current = current
    setRefreshing(true)
    setLoadingMore(false)
    setMoreFailed(false)
    try {
      const refreshed: PanelDecisionDto[] = []
      let cursor: PanelDecisionCursor | undefined
      let next: PanelDecisionCursor | null = null
      for (let index = 0; index < loadedPages.current; index += 1) {
        const page = await fetchPanelDecisions(initData, buildFilter(cursor), current.signal)
        if (current.signal.aborted) return
        refreshed.push(...page.items)
        next = page.nextBefore
        if (next === null) break
        cursor = next
      }
      setItems(refreshed)
      setNextBefore(next)
      updatedAt.current = Date.now()
      setState('ready')
    } catch (error) {
      if (!current.signal.aborted && !onFatal(error)) {
        setState(previous => previous === 'ready' ? previous : 'failed')
        setMoreFailed(true)
      }
    } finally {
      if (request.current === current) { request.current = null; setRefreshing(false) }
    }
  }, [initData, buildFilter, onFatal])

  useEffect(() => {
    const key = `${chatId}:${actionFilter}`
    if (loadedKey.current !== key) {
      loadedKey.current = key
      loadedPages.current = 1
      updatedAt.current = 0
      setItems([])
      setState('loading')
    }
    if (active && Date.now() - updatedAt.current > 30_000) void reload()
    return () => { request.current?.abort(); request.current = null; setRefreshing(false); setLoadingMore(false) }
  }, [reload, active, chatId, actionFilter])

  const loadMore = useCallback(async () => {
    if (nextBefore === null || request.current !== null) return
    const current = new AbortController()
    request.current = current
    setLoadingMore(true)
    setMoreFailed(false)
    try {
      const page = await fetchPanelDecisions(initData, buildFilter(nextBefore), current.signal)
      if (current.signal.aborted) return
      loadedPages.current += 1
      setItems((current) => [...current, ...page.items])
      setNextBefore(page.nextBefore)
    } catch (error) {
      if (!current.signal.aborted && !onFatal(error)) setMoreFailed(true)
    } finally {
      if (request.current === current) {
        request.current = null
        setLoadingMore(false)
      }
    }
  }, [initData, buildFilter, nextBefore, onFatal])

  return (
    <div className="stack">
      <div className="filter-row">
        <select
          className="select"
          value={actionFilter}
          onChange={(event) => { request.current?.abort(); setActionFilter(event.target.value as ActionFilter) }}
          aria-label="按档位筛选"
        >
          {ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" disabled={refreshing || loadingMore} onClick={() => void reload()}>{refreshing ? '更新中…' : '刷新'}</button>
      </div>
      {moreFailed && <p className="form-error" role="alert">更新失败，已保留当前记录。请重试。</p>}

      {state === 'loading' && (
        <div className="tab-pending">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在加载处置记录…</p>
        </div>
      )}
      {state === 'failed' && (
        <div className="tab-pending">
          <p>处置记录没加载出来。</p>
          <button type="button" className="btn btn-secondary" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}
      {state === 'ready' && items.length === 0 && (
        <p className="empty-state">没有符合条件的处置记录。</p>
      )}

      {state === 'ready' &&
        items.map((d) => (
          <article className="list-card" key={d.id}>
            <div className="row-between">
              <span className="badge" style={{ ['--tone' as string]: ACTION_TONE[d.action] }}>
                原判定 {ACTION_LABEL[d.action]}
                {d.actionUntil !== null ? `（至 ${formatTime(d.actionUntil)}）` : ''}
              </span>
              <span className="list-time">{formatTime(d.decidedAt)}</span>
            </div>
            <p className="list-line">
              {d.chatTitle} · 用户 {d.userId}
            </p>
            <p className="list-sub">
              {executionText(d.execution, d.action)}
            </p>
            <details><summary>查看消息摘录与判断依据</summary>
            <p className="list-sub">分数 {d.score.toFixed(2)} · {llmText(d.llm)}</p>
            {d.ruleIds.length > 0 && (
              <div className="chips" aria-label="命中规则">
                {d.ruleIds.map((id) => (
                  <button type="button" className="chip" key={id} onClick={() => onOpenRule(d.chatId, id)}>
                    {id}
                  </button>
                ))}
              </div>
            )}
            <p className="footnote">规则入口展示当前配置，可能与判定时不同。分数与置信度不代表误判概率。</p>
            <p className="quote">{d.sampleText ?? '未保存消息摘录。'}</p>
            <p className="footnote">仅显示处置时保存的摘录。</p>
            </details>
          </article>
        ))}

      {state === 'ready' && nextBefore !== null && (
        <>
          {moreFailed && <p className="form-error">加载失败，再点一次重试。</p>}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </>
      )}
    </div>
  )
}
