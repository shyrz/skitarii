import type { SubscriptionChannelDto } from '../api.js'
import type { PageState } from './subscriptions-model.js'

/** 频道选择列表：独立分页、加载更多、重试；操作在途时禁用切换，保证结果只落原频道。 */
export function SubscriptionChannelPicker({
  channels,
  selectedChatId,
  disabled,
  onSelect,
  onRetry,
  onLoadMore,
}: {
  channels: PageState<SubscriptionChannelDto>
  selectedChatId: string | null
  disabled: boolean
  onSelect: (chatId: string) => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  return (
    <section aria-label="频道选择">
      <h2 className="section-title">频道</h2>
      {channels.status === 'loading' && channels.items.length === 0 && (
        <div className="tab-pending">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在加载频道…</p>
        </div>
      )}
      {channels.status === 'failed' && (
        <div className="tab-pending">
          <p>频道列表没加载出来。</p>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {channels.items.length > 0 && (
        <div className="channel-list">
          {channels.items.map((channel) => (
            <button
              key={channel.chatId}
              type="button"
              className={channel.chatId === selectedChatId ? 'channel-item active' : 'channel-item'}
              aria-pressed={channel.chatId === selectedChatId}
              disabled={disabled}
              onClick={() => onSelect(channel.chatId)}
            >
              <span className="channel-name">{channel.title}</span>
              <span className="channel-meta">
                ID {channel.chatId}
                {channel.linkedChatId !== null
                  ? ` · 关联讨论组 ${channel.linkedChatId}（仅作信息展示，不会对其调整权限）`
                  : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {channels.status === 'ready' && channels.items.length === 0 && (
        <p className="empty-state">还没有已登记的频道。把机器人设为频道管理员后会自动登记。</p>
      )}
      {channels.refreshFailed && <p className="form-error">频道列表刷新失败，下面是上次的结果。</p>}
      {disabled && selectedChatId !== null && (
        <p className="list-sub">有操作正在进行，完成后才能切换频道。</p>
      )}
      {channels.nextCursor !== null && (
        <>
          {channels.moreFailed && <p className="form-error">加载失败，再点一次重试。</p>}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={channels.loadingMore}
            onClick={onLoadMore}
          >
            {channels.loadingMore ? '加载中…' : '加载更多频道'}
          </button>
        </>
      )}
    </section>
  )
}
