import { COUNT_CARDS, VISIBILITY_LABEL, visibilityNotice } from './subscriptions.js'
import type { LoadableState } from './subscriptions-model.js'
import type { SubscriptionChannelDetailsDto } from '../api.js'
import { formatTime } from './util.js'

/**
 * 频道详情卡：可见性/能力快照 + 成员观测计数。
 * counts 只是观测台账汇总，不叫付费会员总数；公开频道与未知可见性在此给出固定提示。
 */
export function SubscriptionChannelDetails({
  details,
  onRetry,
  onRefresh,
}: {
  details: LoadableState<SubscriptionChannelDetailsDto>
  onRetry: () => void
  onRefresh: () => void
}) {
  if (details.value === null) {
    return (
      <>
        {details.status === 'loading' && (
          <div className="tab-pending">
            <div className="spinner" aria-hidden="true" />
            <p role="status">正在加载频道详情…</p>
          </div>
        )}
        {details.status === 'failed' && (
          <div className="tab-pending">
            <p>频道详情没加载出来。</p>
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
      </>
    )
  }

  const value = details.value
  const visibility = visibilityNotice(value.visibility)
  return (
    <article className="card" aria-label="频道详情">
      <div className="row-between">
        <h2 className="section-title">{value.title}</h2>

      </div>
      <div className="field">
        <p className="label">频道可见性</p>
        <p className="value">{VISIBILITY_LABEL[value.visibility]}</p>
      </div>
      <div className="field">
        <p className="label">机器人的链接管理能力</p>
        <p className="value">
          {value.canManageLinks ? '可以管理链接' : value.capabilityErrorCode === 'bot_permission_required' ? '权限不足，请在 Telegram 为机器人开启邀请用户权限后刷新' : '能力尚未确认，请重新检查'}
        </p>
      </div>
      {details.refreshFailed && (
        <p className="form-error">详情刷新失败，下面是上次的检查结果。</p>
      )}

      {visibility !== null && (
        <div
          className="notice-banner"
          style={{ ['--tone' as string]: visibility.tone, marginTop: 12 }}
        >
          <span className="notice-dot" aria-hidden="true" />
          <p style={{ margin: 0 }}>{visibility.text}</p>
        </div>
      )}

      <details><summary>技术信息与观测计数</summary><p className="list-sub">频道 ID {value.chatId}</p><p className="list-sub">检查代码 {value.capabilityErrorCode ?? '无'}</p>
      {value.linkedChatId !== null && (
        <div className="field">
          <p className="label">关联讨论组</p>
          <p className="value">ID {value.linkedChatId}（仅作信息展示）</p>
        </div>
      )}
      <p className="list-sub">
        能力检查时间 {formatTime(value.capabilityCheckedAt)} · 数据快照 {formatTime(value.serverTime)}
      </p>
      <h3 className="section-title" style={{ marginTop: 16 }}>
        成员观测计数
      </h3>
      <div className="stat-grid" style={{ marginBottom: 0 }}>
        {COUNT_CARDS.map((card) => (
          <div className="stat-card" key={card.key} style={{ ['--tone' as string]: card.tone }}>
            <p className="stat-label">
              <span className="stat-dot" aria-hidden="true" />
              {card.label}
            </p>
            <p className="stat-num">{value.counts[card.key]}</p>
          </div>
        ))}
      </div>
      <p className="list-sub">计数是观测台账的独立汇总，不代表付费会员总数或收入。</p>

      </details>
      <button type="button" className="btn btn-secondary" disabled={details.refreshing} onClick={onRefresh}>
        {details.refreshing ? '检查中…' : '重新检查权限与计数'}
      </button>
    </article>
  )
}
