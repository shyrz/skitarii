import { useCallback, useEffect, useState } from 'react'
import { fetchPanelDecisions } from '../api.js'
import type {
  DecisionAction,
  PanelChatDto,
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
  chats,
  onFatal,
}: {
  initData: string
  chats: PanelChatDto[]
  onFatal: (error: unknown) => boolean
}) {
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading')
  const [items, setItems] = useState<PanelDecisionDto[]>([])
  const [nextBefore, setNextBefore] = useState<PanelDecisionCursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 加载更多失败只提示按钮上方一行，不顶掉已加载的列表。 */
  const [moreFailed, setMoreFailed] = useState(false)
  const [chatFilter, setChatFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState<ActionFilter>('default')

  const buildFilter = useCallback(
    (before?: PanelDecisionCursor): PanelDecisionFilter => {
      const filter: PanelDecisionFilter = { limit: PAGE_SIZE }
      if (chatFilter !== 'all') filter.chatId = chatFilter
      if (actionFilter === 'all') filter.action = 'all'
      else if (actionFilter !== 'default') filter.action = actionFilter
      if (before !== undefined) filter.before = before
      return filter
    },
    [chatFilter, actionFilter],
  )

  const reload = useCallback(async () => {
    setState('loading')
    setMoreFailed(false)
    try {
      const page = await fetchPanelDecisions(initData, buildFilter())
      setItems(page.items)
      setNextBefore(page.nextBefore)
      setState('ready')
    } catch (error) {
      if (!onFatal(error)) setState('failed')
    }
  }, [initData, buildFilter, onFatal])

  useEffect(() => {
    void reload()
  }, [reload])

  const loadMore = useCallback(async () => {
    if (nextBefore === null || loadingMore) return
    setLoadingMore(true)
    setMoreFailed(false)
    try {
      const page = await fetchPanelDecisions(initData, buildFilter(nextBefore))
      setItems((current) => [...current, ...page.items])
      setNextBefore(page.nextBefore)
    } catch (error) {
      if (!onFatal(error)) setMoreFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }, [initData, buildFilter, nextBefore, loadingMore, onFatal])

  return (
    <div className="stack">
      <div className="filter-row">
        <select
          className="select"
          value={chatFilter}
          onChange={(event) => setChatFilter(event.target.value)}
          aria-label="按群筛选"
        >
          <option value="all">全部群</option>
          {chats.map((chat) => (
            <option key={chat.chatId} value={chat.chatId}>
              {chat.title}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={actionFilter}
          onChange={(event) => setActionFilter(event.target.value as ActionFilter)}
          aria-label="按档位筛选"
        >
          {ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

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
                {ACTION_LABEL[d.action]}
                {d.actionUntil !== null ? `（至 ${formatTime(d.actionUntil)}）` : ''}
              </span>
              <span className="list-time">{formatTime(d.decidedAt)}</span>
            </div>
            <p className="list-line">
              {d.chatTitle} · 用户 {d.userId}
            </p>
            <p className="list-sub">
              分数 {d.score.toFixed(2)} · {d.executed ? '已执行' : '未执行'} · {llmText(d.llm)}
            </p>
            {d.ruleIds.length > 0 && (
              <div className="chips" aria-label="命中规则">
                {d.ruleIds.map((id) => (
                  <span className="chip" key={id}>
                    {id}
                  </span>
                ))}
              </div>
            )}
            {d.sampleText !== null && <p className="quote clamp">{d.sampleText}</p>}
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
