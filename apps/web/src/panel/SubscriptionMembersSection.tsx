import type { SubscriptionMemberDto } from '../api.js'
import { MEMBER_STATE_LABEL, MEMBER_STATE_TONE, OBSERVATION_DISCLAIMER, expiryObservation, memberLinkLabel } from './subscriptions.js'
import type { PageState } from './subscriptions-model.js'
import { formatTime } from './util.js'

/** 成员观测台账：非实时数据，只展示 Bot 观测到的事实；刷新本身失败时不破坏已有列表。 */
export function SubscriptionMembersSection({
  members,
  linkNames,
  onRefresh,
  onRetry,
  onLoadMore,
}: {
  members: PageState<SubscriptionMemberDto>
  linkNames: ReadonlyMap<string, string>
  onRefresh: () => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  return (
    <section aria-label="成员观测台账">
      <div className="row-between">
        <h2 className="section-title">成员观测台账</h2>
        <button
          type="button"
          className="text-btn"
          disabled={members.status === 'loading'}
          onClick={onRefresh}
        >
          刷新
        </button>
      </div>
      <p className="list-sub">{OBSERVATION_DISCLAIMER}</p>

      {members.status === 'loading' && members.items.length === 0 && (
        <div className="tab-pending">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在加载成员台账…</p>
        </div>
      )}
      {members.status === 'failed' && (
        <div className="tab-pending">
          <p>成员台账没加载出来。</p>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {members.refreshFailed && <p className="form-error">刷新失败，下面是上次的结果。</p>}
      {members.status === 'ready' && members.items.length === 0 && (
        <p className="empty-state">还没有观测到与该频道订阅相关的成员。</p>
      )}

      {members.items.map((member) => (
        <MemberCard key={member.id} member={member} linkNames={linkNames} />
      ))}

      {members.nextCursor !== null && (
        <>
          {members.moreFailed && <p className="form-error">加载失败，再点一次重试。</p>}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={members.loadingMore}
            onClick={onLoadMore}
          >
            {members.loadingMore ? '加载中…' : '加载更多成员'}
          </button>
        </>
      )}
    </section>
  )
}

function MemberCard({
  member,
  linkNames,
}: {
  member: SubscriptionMemberDto
  linkNames: ReadonlyMap<string, string>
}) {
  const expiry = expiryObservation(member.expiresAt, new Date())
  return (
    <article className="list-card">
      <div className="row-between">
        <p className="list-title">用户 {member.userId}</p>
        <span className="badge" style={{ ['--tone' as string]: MEMBER_STATE_TONE[member.state] }}>
          {MEMBER_STATE_LABEL[member.state]}
        </span>
      </div>
      <p className="list-line">到期观测：{expiry.text}</p>
      <p className="list-sub">可关联链接：{memberLinkLabel(member.linkId, linkNames)}</p>
      <p className="list-sub">
        最后观测 {formatTime(member.observedAt)} · 来源{' '}
        {member.observationSource === 'event' ? '事件' : '对账轮询'}
      </p>
      <p className="list-sub">
        最近检查成功{' '}
        {member.lastCheckSucceededAt !== null ? formatTime(member.lastCheckSucceededAt) : '尚未成功'}
        {member.lastCheckErrorCode !== null ? ` · 最近检查失败：${member.lastCheckErrorCode}` : ''}
      </p>
    </article>
  )
}
