import { useEffect, useState, useSyncExternalStore } from 'react'
import { subscriptionsApi } from '../api.js'
import { getWebApp } from '../telegram.js'
import { SubscriptionChannelDetails } from './SubscriptionChannelDetails.js'
import { SubscriptionChannelPicker } from './SubscriptionChannelPicker.js'
import { SubscriptionLinksSection } from './SubscriptionLinksSection.js'
import { SubscriptionMembersSection } from './SubscriptionMembersSection.js'
import { SubscriptionsModel } from './subscriptions-model.js'
import {
  INTENT_STORAGE_DEGRADED_NOTICE,
  OBSERVATION_DISCLAIMER,
  browserIntentStorage,
  indexLinkNames,
  resolveIntentScope,
} from './subscriptions.js'
import type { NoticeTone } from './subscriptions.js'

/**
 * 订阅页签入口（phase3b-spec §7）：只负责组装数据层与四个子区块。
 * 401/403 owner 鉴权交给 onFatal 上升整屏；403 bot_permission_required 留在当前频道提示。
 * 创建意图的持久化作用域只用于 UI 隔离（用户 + 频道），不授予任何权限，服务端仍独立鉴权。
 */
const TONE_VAR: Record<NoticeTone, string> = {
  success: 'var(--tone-success)',
  caution: 'var(--tone-caution)',
  danger: 'var(--tone-danger)',
}

export function SubscriptionsTab({
  initData,
  onFatal,
}: {
  initData: string
  /** 401/403 上升到整屏状态；返回 true 表示已接管，本页不要再画局部错误。 */
  onFatal: (error: unknown) => boolean
}) {
  const [model] = useState(
    () =>
      new SubscriptionsModel(subscriptionsApi, initData, onFatal, {
        storage: browserIntentStorage(),
        intentScope: resolveIntentScope(getWebApp()?.initDataUnsafe.user?.id),
      }),
  )
  const state = useSyncExternalStore(model.subscribe, model.getState)

  useEffect(() => {
    // 幂等；页签挂载后由 PanelApp 保持常驻，不随切换卸载
    model.start()
  }, [model])

  const busy = state.operation !== 'idle'

  return (
    <div className="stack">
      <div className="notice-banner" style={{ ['--tone' as string]: 'var(--tone-notice)' }}>
        <span className="notice-dot" aria-hidden="true" />
        <p style={{ margin: 0 }}>{OBSERVATION_DISCLAIMER}</p>
      </div>

      {state.intentStorageDegraded && (
        <div className="notice-banner" style={{ ['--tone' as string]: 'var(--tone-caution)' }}>
          <span className="notice-dot" aria-hidden="true" />
          <p style={{ margin: 0 }}>{INTENT_STORAGE_DEGRADED_NOTICE}</p>
        </div>
      )}

      {state.notice !== null && (
        <section
          className="appeal-status"
          style={{ ['--tone' as string]: TONE_VAR[state.notice.tone] }}
          role={state.notice.tone === 'success' ? 'status' : 'alert'}
        >
          <div>
            <p>{state.notice.text}</p>
          </div>
        </section>
      )}

      <SubscriptionChannelPicker
        channels={state.channels}
        selectedChatId={state.chatId}
        disabled={busy}
        onSelect={(chatId) => model.selectChannel(chatId)}
        onRetry={() => model.retryChannels()}
        onLoadMore={() => model.loadMoreChannels()}
      />

      {state.chatId === null ? (
        <p className="empty-state">先选择一个频道，再查看订阅链接与成员观测台账。</p>
      ) : (
        <>
          <SubscriptionChannelDetails
            details={state.details}
            onRetry={() => model.retryDetails()}
            onRefresh={() => model.refreshDetails()}
          />

          <SubscriptionLinksSection
            key={state.chatId}
            channelTitle={state.details.value?.title ?? state.chatId}
            links={state.links}
            createIntent={state.createIntent}
            busy={busy}
            onCreate={(name, priceStars) => model.createLink(name, priceStars)}
            onRename={(link, name) => model.renameLink(link, name)}
            onRevoke={(link) => model.revokeLink(link)}
            onDiscardIntent={() => model.discardCreateIntent()}
            onRefresh={() => model.refreshLinks()}
            onRetry={() => model.retryLinks()}
            onLoadMore={() => model.loadMoreLinks()}
          />

          <SubscriptionMembersSection
            members={state.members}
            linkNames={indexLinkNames(state.links.items)}
            onRefresh={() => model.refreshMembers()}
            onRetry={() => model.retryMembers()}
            onLoadMore={() => model.loadMoreMembers()}
          />
        </>
      )}
    </div>
  )
}
