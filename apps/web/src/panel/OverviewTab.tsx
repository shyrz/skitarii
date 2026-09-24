import { useCallback, useEffect, useState } from 'react'
import { fetchPanelSeries } from '../api.js'
import type { DailyCountsDto, PanelOverviewDto, PanelSeriesPointDto } from '../api.js'
import { TrendChart } from './TrendChart.js'
import { mergeSeries } from './util.js'

/**
 * 概览页签：总计卡 + 趋势图 + 群列表。
 * overview 数据由 PanelApp 的首屏请求传入（那次请求同时承担鉴权），本组件只负责趋势序列。
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
}: {
  overview: PanelOverviewDto
  initData: string
  /** 401/403 上升到整屏状态；返回 true 表示已接管，调用方不要再画内联错误。 */
  onFatal: (error: unknown) => boolean
}) {
  const [days, setDays] = useState<7 | 30>(7)
  const [chatId, setChatId] = useState('all')
  const [series, setSeries] = useState<SeriesState>({ kind: 'loading' })

  const loadSeries = useCallback(async () => {
    setSeries({ kind: 'loading' })
    try {
      const points =
        chatId === 'all'
          ? // 「全部群」没有专门端点：逐群拉取后按日期相加（群数量小，spec §2 允许）
            mergeSeries(
              await Promise.all(
                overview.chats.map((chat) =>
                  fetchPanelSeries(chat.chatId, days, initData).then((res) => res.days),
                ),
              ),
            )
          : (await fetchPanelSeries(chatId, days, initData)).days
      setSeries({ kind: 'ready', points })
    } catch (error) {
      if (!onFatal(error)) setSeries({ kind: 'failed' })
    }
  }, [chatId, days, initData, overview.chats, onFatal])

  useEffect(() => {
    void loadSeries()
  }, [loadSeries])

  return (
    <div className="stack">
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

      <section className="card" aria-label="趋势">
        <div className="row-between">
          <h2 className="section-title">趋势</h2>
          <div className="seg" role="group" aria-label="时间范围">
            {([7, 30] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={days === value ? 'active' : ''}
                aria-pressed={days === value}
                onClick={() => setDays(value)}
              >
                {value} 日
              </button>
            ))}
          </div>
        </div>
        <select
          className="select"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
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
            </div>
          ))
        )}
      </section>

      <p className="footnote">统计每小时滚动，今日数据可能滞后。</p>
    </div>
  )
}
