import { useCallback, useEffect, useRef, useState } from 'react'
import { executionText } from '../execution.js'
import { fetchPanelSeries } from '../api.js'
import type { DailyCountsDto, PanelChatDto, PanelOverviewDto, PanelSeriesPointDto } from '../api.js'
import { TrendChart } from './TrendChart.js'
import { mergeSeries } from './util.js'

/**
 * 工作台展示待处理申诉、需核实记录与统计，提供审核和对象入口。
 * PanelApp 管理概览刷新；趋势筛选与序列请求由本组件维护。
 */

const TOTAL_CARDS: { key: keyof DailyCountsDto; label: string; tone: string }[] = [
  { key: 'messageCount', label: '消息', tone: 'var(--tone-notice)' },
  { key: 'actionCount', label: '处置', tone: 'var(--tone-caution)' },
  { key: 'appealCount', label: '申诉', tone: 'var(--tone-danger)' },
  { key: 'overturnedCount', label: '撤销', tone: 'var(--tone-success)' },
]

type SeriesState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; points: PanelSeriesPointDto[] }

export function OverviewTab({
  overview,
  initData,
  onFatal,
  refreshing,
  onRefresh,
  onOpenAppeals,
  onOpenObject,
  onOpenReview,
}: {
  overview: PanelOverviewDto
  initData: string
  refreshing: boolean
  onRefresh: () => void
  onOpenAppeals: (chatId: string) => void
  onOpenReview: (chatId: string, section: 'decisions' | 'resolved') => void
  onOpenObject: (chat: PanelChatDto) => void
  /** 401/403 上升到整屏状态；返回 true 表示已接管，调用方不要再画内联错误。 */
  onFatal: (error: unknown) => boolean
}) {
  const [days, setDays] = useState<7 | 30>(7)
  const [chatId, setChatId] = useState('all')
  const [series, setSeries] = useState<SeriesState>({ kind: 'loading' })
  const request = useRef<AbortController | null>(null)

  const loadSeries = useCallback(async () => {
    request.current?.abort()
    const current = new AbortController()
    request.current = current
    setSeries({ kind: 'loading' })
    try {
      const points =
        chatId === 'all'
          ? // 「全部群」没有专门端点：逐群拉取后按日期相加（群数量小，spec §2 允许）
            mergeSeries(
              await Promise.all(
                overview.chats.map((chat) =>
                  fetchPanelSeries(chat.chatId, days, initData, current.signal).then((res) => res.days),
                ),
              ),
            )
          : (await fetchPanelSeries(chatId, days, initData, current.signal)).days
      if (current.signal.aborted) return
      setSeries({ kind: 'ready', points })
    } catch (error) {
      if (!current.signal.aborted && !onFatal(error)) setSeries({ kind: 'failed' })
    }
  }, [chatId, days, initData, overview.chats, onFatal])

  useEffect(() => {
    void loadSeries()
    return () => request.current?.abort()
  }, [loadSeries])

  return (
    <div className="stack">
      <section className="card" aria-label="待处理">
        <div className="row-between"><h2 className="section-title">待处理申诉</h2><button type="button" className="text-btn" disabled={refreshing} onClick={onRefresh}>{refreshing ? '更新中…' : '刷新'}</button></div>
        <p className="footnote">更新于 {new Date(overview.serverTime).toLocaleString('zh-CN')}</p>
        <p className="stat-num">{overview.chats.reduce((sum, chat) => sum + chat.openAppeals, 0)}</p>
        <button type="button" className="btn" onClick={() => onOpenAppeals('')}>查看待处理申诉</button>
        {overview.chats.filter(chat => chat.openAppeals > 0).map(chat => <button type="button" className="object-card list-card" key={chat.chatId} onClick={() => onOpenAppeals(chat.chatId)}>{chat.title} · {chat.openAppeals} 条待处理</button>)}
      </section>
      <section className="card" aria-label="需要核实">
        <h2 className="section-title">需要核实</h2>
        <p className="footnote">执行记录检查近 7 日，权限恢复检查仍待处理的已撤销申诉。</p>
        {overview.attention.executionIssues.map(issue => <div className="list-card" key={issue.id}>
          <p>{overview.chats.find(chat => chat.chatId === issue.chatId)?.title ?? issue.chatId} · 用户 {issue.userId}</p>
          <p className="list-sub">{executionText(issue.execution, issue.action)}</p>
          <button type="button" className="text-btn" onClick={() => onOpenReview(issue.chatId, 'decisions')}>查看本群处置记录</button>
        </div>)}
        {overview.attention.moreExecutionIssues && <p className="footnote">这里只展示最近 10 条异常记录。</p>}
        {overview.attention.pendingRollbackCount > 0 && <button type="button" className="btn btn-secondary" onClick={() => onOpenReview('', 'resolved')}>已结案中有 {overview.attention.pendingRollbackCount}{overview.attention.morePendingRollback ? '+' : ''} 条权限恢复待处理</button>}
        {overview.attention.executionIssues.length === 0 && overview.attention.pendingRollbackCount === 0 && <p className="list-sub">检查范围内未发现已记录的执行失败或待恢复权限。</p>}
      </section>
      <section aria-label="总计">
        <div className="stat-grid">
          {TOTAL_CARDS.map((card) => (
            <div className="stat-card" key={card.key} style={{ ['--tone' as string]: card.tone }}>
              <p className="stat-label">
                <span className="stat-dot" aria-hidden="true" />
                {card.label}
              </p>
              <p className="stat-num">{overview.totals.today[card.key]}</p>
              <p className="stat-sub">近 7 日 {overview.totals.last7d[card.key]}</p>
            </div>
          ))}
        </div>
      </section>

      <details className="card"><summary>查看统计趋势</summary><section aria-label="趋势">
        <div className="row-between">
          <h2 className="section-title">趋势</h2>
          <div className="seg" role="group" aria-label="时间范围">
            {([7, 30] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={days === value ? 'active' : ''}
                aria-pressed={days === value}
                onClick={() => { if (days !== value) { request.current?.abort(); setDays(value) } }}
              >
                {value} 日
              </button>
            ))}
          </div>
        </div>
        <select
          className="select"
          value={chatId}
          onChange={(event) => { request.current?.abort(); setChatId(event.target.value) }}
          aria-label="按群筛选"
        >
          <option value="all">全部群</option>
          {overview.chats.map((chat) => (
            <option key={chat.chatId} value={chat.chatId}>
              {chat.title}
            </option>
          ))}
        </select>
        {series.kind === 'loading' && (
          <div className="tab-pending">
            <div className="spinner" aria-hidden="true" />
          </div>
        )}
        {series.kind === 'failed' && (
          <div className="tab-pending">
            <p>趋势数据没加载出来。</p>
            <button type="button" className="btn btn-secondary" onClick={() => void loadSeries()}>
              重试
            </button>
          </div>
        )}
        {series.kind === 'ready' && <TrendChart points={series.points} />}
      </section>

      </details>

      <section aria-label="各群情况">
        <h2 className="section-title">各群情况</h2>
        {overview.chats.length === 0 ? (
          <p className="empty-state">还没有接入任何群。</p>
        ) : (
          overview.chats.map((chat) => (
            <div className="list-card" key={chat.chatId}>
              <div className="row-between">
                <p className="list-title">{chat.title}</p>
                {chat.openAppeals > 0 && (
                  <span className="badge" style={{ ['--tone' as string]: 'var(--tone-caution)' }}>
                    {chat.openAppeals} 条待处理申诉
                  </span>
                )}
              </div>
              <p className="list-sub">
                今日消息 {chat.today.messageCount} · 处置 {chat.today.actionCount}
              </p>
              <button type="button" className="text-btn" onClick={() => onOpenObject(chat)}>{chat.chatType === 'channel' ? '管理订阅' : '管理群设置'}</button>
            </div>
          ))
        )}
      </section>

      <p className="footnote">统计按 UTC 自然日汇总，每小时滚动，今日数据可能滞后。待处理申诉数量在刷新后更新。</p>
    </div>
  )
}
