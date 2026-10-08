import { useState } from 'react'
import type { SubscriptionLinkDto } from '../api.js'
import type { CreateIntent } from './subscriptions.js'
import {
  DISCARD_UNCERTAIN_CONFIRM_TEXT,
  LINK_STATE_LABEL,
  LINK_STATE_TONE,
  PERIOD_LABEL,
  REVOKE_CONFIRM_TEXT,
  copyToClipboard,
  createConfirmText,
  formatPriceLine,
  linkDisplayName,
  linkStateNotice,
  validateCreateDraft,
} from './subscriptions.js'
import type { CreateSubmitResult, PageState } from './subscriptions-model.js'
import { formatTime } from './util.js'

export function SubscriptionLinksSection({
  channelTitle,
  createdLink,
  canWrite,
  links,
  createIntent,
  busy,
  onCreate,
  onRename,
  onRevoke,
  onDiscardIntent,
  onRefresh,
  onRetry,
  onLoadMore,
}: {
  channelTitle: string
  createdLink: SubscriptionLinkDto | null
  canWrite: boolean
  links: PageState<SubscriptionLinkDto>
  createIntent: CreateIntent | null
  busy: boolean
  onCreate: (name: string, priceStars: number) => Promise<CreateSubmitResult>
  onRename: (link: SubscriptionLinkDto, name: string) => Promise<boolean>
  onRevoke: (link: SubscriptionLinkDto) => Promise<boolean>
  onDiscardIntent: () => void
  onRefresh: () => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  const [formOpen, setFormOpen] = useState(false)
  const [formName, setFormName] = useState('')
  const [formPrice, setFormPrice] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmingCreate, setConfirmingCreate] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [renaming, setRenaming] = useState<{ linkId: string; draft: string } | null>(null)
  const [confirmingRevoke, setConfirmingRevoke] = useState<SubscriptionLinkDto | null>(null)
  const [copyState, setCopyState] = useState<Record<string, 'ok' | 'failed'>>({})

  const nameLength = [...formName].length
  const draftValidation = validateCreateDraft(formName, formPrice)
  const intentUncertain = createIntent?.uncertain === true
  const confirmingRevokeLinkId = confirmingRevoke?.id ?? null

  const askCreate = () => {
    const validation = validateCreateDraft(formName, formPrice)
    if (!validation.ok) {
      setFormError(validation.message)
      setConfirmingCreate(false)
      return
    }
    setFormError(null)
    setConfirmingDiscard(false)
    setConfirmingCreate(true)
  }

  const confirmCreate = async () => {
    const validation = validateCreateDraft(formName, formPrice)
    if (!validation.ok) {
      setFormError(validation.message)
      setConfirmingCreate(false)
      return
    }
    const result = await onCreate(formName, validation.priceStars)
    if (result === 'created' || result === 'replayed') {
      setFormName('')
      setFormPrice('')
      setFormError(null)
      setFormOpen(false)
    }
    setConfirmingCreate(false)
  }

  const askRename = (link: SubscriptionLinkDto) => {
    setRenaming({ linkId: link.id, draft: link.name })
    setConfirmingRevoke(null)
  }

  const saveRename = async (link: SubscriptionLinkDto) => {
    if (renaming === null || [...renaming.draft].length > 32) return
    if (await onRename(link, renaming.draft)) setRenaming(null)
  }

  const confirmRevoke = async () => {
    if (confirmingRevoke === null) return
    await onRevoke(confirmingRevoke)
    setConfirmingRevoke(null)
  }

  const copyLink = async (link: SubscriptionLinkDto) => {
    if (link.inviteLink === null) return
    const ok = await copyToClipboard(link.inviteLink)
    setCopyState((current) => ({ ...current, [link.id]: ok ? 'ok' : 'failed' }))
  }

  return (
    <section aria-label="订阅链接">
      <div className="row-between">
        <h2 className="section-title">订阅链接</h2>
        <button
          type="button"
          className="text-btn"
          disabled={busy || links.status === 'loading' || links.refreshing || links.loadingMore}
          onClick={onRefresh}
        >
          刷新
        </button>
      </div>

      {createdLink !== null && <div className="card" role="status"><p>{createdLink.state === 'active' ? '链接已创建，可以复制分享。' : `已确认原请求，链接当前${LINK_STATE_LABEL[createdLink.state]}。`}</p><p className="link-url">{createdLink.inviteLink}</p>{createdLink.state === 'active' && <button type="button" className="btn" onClick={() => void copyLink(createdLink)}>复制新链接</button>}{copyState[createdLink.id] === 'ok' && <p>已复制</p>}{copyState[createdLink.id] === 'failed' && <p>复制失败，请选择上面的链接文本复制。</p>}</div>}
      <details className="card" open={formOpen || intentUncertain} onToggle={event => setFormOpen(event.currentTarget.open)}><summary>新建订阅链接</summary>
      <article aria-label="创建订阅链接">
        <div className="field">
          <label className="label" htmlFor="subscription-link-name">
            链接名称（可留空，最多 32 个字符）
          </label>
          <input
            id="subscription-link-name"
            className="input"
            value={formName}
            disabled={busy || !canWrite || intentUncertain || confirmingCreate}
            onChange={(event) => setFormName(event.target.value)}
          />
          <p className={nameLength > 32 ? 'counter over' : 'counter'}>{nameLength}/32</p>
        </div>
        <div className="field">
          <label className="label" htmlFor="subscription-link-price">
            价格（Stars）
          </label>
          <input
            id="subscription-link-price"
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000}
            step={1}
            placeholder="1..10000"
            value={formPrice}
            disabled={busy || !canWrite || intentUncertain || confirmingCreate}
            onChange={(event) => setFormPrice(event.target.value)}
          />
        </div>
        <p className="list-sub">周期固定为{PERIOD_LABEL}；创建后价格与周期不能修改，仅名称可以改。</p>
        {draftValidation.ok && (
          <p className="list-sub">将创建：{formatPriceLine(draftValidation.priceStars)}</p>
        )}
        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        {confirmingCreate ? (
          <div className="confirm-box">
            <p className="confirm-text">
              {createConfirmText(channelTitle, formName, Number(formPrice))}
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setConfirmingCreate(false)}
              >
                取消
              </button>
              <button type="button" className="btn" disabled={busy || !canWrite || intentUncertain} onClick={() => void confirmCreate()}>
                {busy ? '创建中…' : '确认创建'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn" disabled={busy || !canWrite || intentUncertain} onClick={askCreate}>
            创建链接
          </button>
        )}

        {intentUncertain &&
          (confirmingDiscard ? (
            <div className="confirm-box">
              <p className="confirm-text">{DISCARD_UNCERTAIN_CONFIRM_TEXT}</p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setConfirmingDiscard(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingDiscard(false)
                    onDiscardIntent()
                  }}
                >
                  确认放弃
                </button>
              </div>
            </div>
          ) : (
            <div className="confirm-box">
              <p className="confirm-text">
                上次创建结果尚未确认。检查结果会使用原请求，不会重新创建链接。
              </p>
              {createIntent !== null && <p className="list-sub">
                {linkDisplayName(createIntent.payload.name)} · {formatPriceLine(createIntent.payload.priceStars)}
              </p>}
              <div className="btn-row">
                <button type="button" className="btn" disabled={busy}
                  onClick={() => {
                    if (createIntent !== null) void onCreate(createIntent.payload.name, createIntent.payload.priceStars)
                  }}>检查上次结果</button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setConfirmingDiscard(true)}
                >
                  放弃不确定请求
                </button>
              </div>
            </div>
          ))}
      </article></details>

      {links.status === 'loading' && links.items.length === 0 && (
        <div className="tab-pending">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在加载链接…</p>
        </div>
      )}
      {links.status === 'failed' && (
        <div className="tab-pending">
          <p>链接列表没加载出来。</p>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {links.refreshFailed && <p className="form-error">刷新失败，下面是上次的结果。</p>}
      {links.status === 'ready' && links.items.length === 0 && (
        <p className="empty-state">这个频道还没有通过本 Bot 创建过订阅链接。</p>
      )}

      {links.items.map((link) => (
        <LinkCard
          key={link.id}
          link={link}
          busy={busy}
          canWrite={canWrite}
          renaming={renaming?.linkId === link.id ? renaming.draft : null}
          confirmingRevoke={confirmingRevokeLinkId === link.id}
          copyState={copyState[link.id] ?? null}
          onRenameAsk={() => askRename(link)}
          onRenameDraft={(draft) =>
            setRenaming((current) => (current === null ? current : { ...current, draft }))
          }
          onCancelRename={() => setRenaming(null)}
          onRenameSave={() => void saveRename(link)}
          onRevokeAsk={() => {
            setConfirmingRevoke(link)
            setRenaming(null)
          }}
          onRevokeCancel={() => setConfirmingRevoke(null)}
          onRevokeConfirm={() => void confirmRevoke()}
          onCopy={() => void copyLink(link)}
        />
      ))}

      {links.nextCursor !== null && (
        <>
          {links.moreFailed && <p className="form-error">加载失败，再点一次重试。</p>}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={links.loadingMore || links.refreshing}
            onClick={onLoadMore}
          >
            {links.loadingMore ? '加载中…' : '加载更多链接'}
          </button>
        </>
      )}
    </section>
  )
}

function LinkCard({
  link,
  busy,
  canWrite,
  renaming,
  confirmingRevoke,
  copyState,
  onRenameAsk,
  onRenameSave,
  onRenameDraft,
  onCancelRename,
  onRevokeAsk,
  onRevokeCancel,
  onRevokeConfirm,
  onCopy,
}: {
  link: SubscriptionLinkDto
  busy: boolean
  canWrite: boolean
  renaming: string | null
  confirmingRevoke: boolean
  copyState: 'ok' | 'failed' | null
  onRenameSave: () => void
  onRenameAsk: () => void
  onRenameDraft: (draft: string) => void
  onCancelRename: () => void
  onRevokeAsk: () => void
  onRevokeCancel: () => void
  onRevokeConfirm: () => void
  onCopy: () => void
}) {
  const notice = linkStateNotice(link.state)
  const renameTooLong = renaming !== null && [...renaming].length > 32
  return (
    <article className="list-card">
      <div className="row-between">
        <p className="list-title">{linkDisplayName(link.name)}</p>
        <span className="badge" style={{ ['--tone' as string]: LINK_STATE_TONE[link.state] }}>
          {LINK_STATE_LABEL[link.state]}
        </span>
      </div>
      <p className="list-line">{formatPriceLine(link.priceStars)}</p>
      <p className="list-sub">
        创建 {formatTime(link.createdAt)} · 更新 {formatTime(link.updatedAt)}
        {link.revokedAt !== null ? ` · 撤销 ${formatTime(link.revokedAt)}` : ''}
      </p>
      {notice !== null && <p className="list-sub">{notice}</p>}

      {link.inviteLink !== null && (
        <>
          <p className="link-url">{link.inviteLink}</p>
          {link.state === 'active' && (
            <>
              <div className="inline-actions">
                <button type="button" className="text-btn" disabled={busy} onClick={onCopy}>
                  复制链接
                </button>
                {copyState === 'ok' && <span className="list-sub">已复制</span>}
                {copyState === 'failed' && (
                  <span className="list-sub">复制失败，请长按或手动选择上面的链接文本。</span>
                )}
              </div>
              {renaming === null && !confirmingRevoke && (
                <div className="inline-actions">
                  <button type="button" className="text-btn" disabled={busy || !canWrite} onClick={onRenameAsk}>
                    改名
                  </button>
                  <button
                    type="button"
                    className="text-btn danger"
                    disabled={busy || !canWrite}
                    onClick={onRevokeAsk}
                  >
                    撤销
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {renaming !== null && (
        <div className="rule-edit">
          <input
            className="input"
            value={renaming}
            disabled={busy || !canWrite}
            onChange={(event) => onRenameDraft(event.target.value)}
            aria-label="新的链接名称"
          />
          <p className={renameTooLong ? 'counter over' : 'counter'}>{[...renaming].length}/32</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy || !canWrite} onClick={onCancelRename}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !canWrite || renameTooLong}
              onClick={onRenameSave}
            >
              {busy ? '保存中…' : '保存名称'}
            </button>
          </div>
        </div>
      )}

      {confirmingRevoke && (
        <div className="confirm-box">
          <p className="confirm-text">{REVOKE_CONFIRM_TEXT}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy || !canWrite} onClick={onRevokeCancel}>
              取消
            </button>
            <button type="button" className="btn" disabled={busy || !canWrite} onClick={onRevokeConfirm}>
              {busy ? '撤销中…' : '确认撤销'}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
