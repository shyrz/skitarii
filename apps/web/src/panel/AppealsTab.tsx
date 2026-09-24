import { useCallback, useEffect, useState } from 'react'
import { ConflictError, NotFoundError, fetchPanelAppeals, resolvePanelAppeal } from '../api.js'
import type { PanelAppealDto, PanelResolution } from '../api.js'
import { ACTION_LABEL, ACTION_TONE, formatTime } from './util.js'

/**
 * 申诉页签：待处理队列（含网页内结案）+ 最近已结案。
 * 结案是二次确认的内联交互：第一次点只展开确认条，确认才发请求。
 */

/** 结案按钮文案与确认提示；撤销伴随权限回滚，确认语写明后果。 */
const RESOLUTION_TEXT: Record<PanelResolution, { button: string; confirm: string }> = {
  upheld: { button: '维持原处置', confirm: '确认维持原处理？' },
  overturned: { button: '撤销并解除限制', confirm: '确认撤销处置，并解除对该用户的限制？' },
}

export function AppealsTab({
  initData,
  onFatal,
}: {
  initData: string
  onFatal: (error: unknown) => boolean
}) {
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading')
  const [open, setOpen] = useState<PanelAppealDto[]>([])
  const [resolved, setResolved] = useState<PanelAppealDto[]>([])
  /** 正在二次确认的卡片；null 表示没有进行中的确认。 */
  const [confirming, setConfirming] = useState<{ id: string; resolution: PanelResolution } | null>(
    null,
  )
  /** 正在等待接口返回的申诉 id，期间禁用所有结案按钮。 */
  const [resolving, setResolving] = useState<string | null>(null)
  /** 结案结果提示（rollbackFailed 警告 / 并发冲突后的刷新说明 / 网络错误）。 */
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState('loading')
    setConfirming(null)
    try {
      // 一次取回（state=all），客户端按状态分组；接口本身按 createdAt 倒序
      const items = await fetchPanelAppeals(initData, 'all')
      setOpen(items.filter((a) => a.state === 'open'))
      setResolved(
        items
          .filter((a) => a.state !== 'open')
          .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt)),
      )
      setState('ready')
    } catch (error) {
      if (!onFatal(error)) setState('failed')
    }
  }, [initData, onFatal])

  useEffect(() => {
    void load()
  }, [load])

  const onResolve = useCallback(
    async (appeal: PanelAppealDto, resolution: PanelResolution) => {
      if (resolving !== null) return
      setResolving(appeal.id)
      setNotice(null)
      try {
        const result = await resolvePanelAppeal(appeal.id, initData, resolution)
        // 成功后本地搬运卡片，不必整单刷新
        setOpen((list) => list.filter((a) => a.id !== appeal.id))
        setResolved((list) => [
          { ...appeal, state: result.state, resolvedAt: new Date().toISOString() },
          ...list,
        ])
        if (result.rollbackFailed) {
          setNotice('已结案，但解除限制失败：请手动解禁或解封')
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          // 409：已被处理（含并发结案），以服务端为准刷新列表
          setNotice('这条申诉刚刚已被处理，列表已刷新。')
          await load()
        } else if (error instanceof NotFoundError) {
          setNotice('这条申诉或关联的处置记录不存在，列表已刷新。')
          await load()
        } else if (!onFatal(error)) {
          setNotice('操作失败，请检查网络后再试一次。')
        }
      } finally {
        setResolving(null)
        setConfirming(null)
      }
    },
    [initData, resolving, load, onFatal],
  )

  if (state === 'loading') {
    return (
      <div className="tab-pending">
        <div className="spinner" aria-hidden="true" />
        <p role="status">正在加载申诉…</p>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div className="tab-pending">
        <p>申诉列表没加载出来。</p>
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="stack">
      {notice !== null && (
        <section
          className="appeal-status"
          style={{ ['--tone' as string]: 'var(--tone-caution)' }}
          role="status"
        >
          <div>
            <p>{notice}</p>
          </div>
        </section>
      )}

      {open.length === 0 ? (
        <p className="empty-state">没有待处理的申诉。</p>
      ) : (
        open.map((appeal) => (
          <OpenAppealCard
            key={appeal.id}
            appeal={appeal}
            confirming={confirming?.id === appeal.id ? confirming.resolution : null}
            resolving={resolving !== null}
            onConfirmAsk={(resolution) => setConfirming({ id: appeal.id, resolution })}
            onCancel={() => setConfirming(null)}
            onResolve={(resolution) => void onResolve(appeal, resolution)}
          />
        ))
      )}

      {resolved.length > 0 && (
        <>
          <h2 className="section-title">最近已结案</h2>
          {resolved.map((appeal) => (
            <article className="list-card" key={appeal.id}>
              <div className="row-between">
                <span
                  className="badge"
                  style={{
                    ['--tone' as string]:
                      appeal.state === 'upheld' ? 'var(--tone-danger)' : 'var(--tone-success)',
                  }}
                >
                  {appeal.state === 'upheld' ? '已维持' : '已撤销'}
                </span>
                {appeal.resolvedAt !== null && (
                  <span className="list-time">{formatTime(appeal.resolvedAt)}</span>
                )}
              </div>
              <p className="list-line">
                {appeal.decision.chatTitle} · 用户 {appeal.userId} · 原处置：
                {ACTION_LABEL[appeal.decision.action]}
              </p>
            </article>
          ))}
        </>
      )}
    </div>
  )
}

function OpenAppealCard({
  appeal,
  confirming,
  resolving,
  onConfirmAsk,
  onCancel,
  onResolve,
}: {
  appeal: PanelAppealDto
  confirming: PanelResolution | null
  resolving: boolean
  onConfirmAsk: (resolution: PanelResolution) => void
  onCancel: () => void
  onResolve: (resolution: PanelResolution) => void
}) {
  return (
    <article className="list-card">
      <div className="row-between">
        <span
          className="badge"
          style={{ ['--tone' as string]: ACTION_TONE[appeal.decision.action] }}
        >
          {ACTION_LABEL[appeal.decision.action]}
        </span>
        <span className="list-time">{formatTime(appeal.createdAt)}</span>
      </div>
      <p className="list-line">
        {appeal.decision.chatTitle} · 用户 {appeal.userId} · 分数 {appeal.decision.score.toFixed(2)}
      </p>
      <div className="field">
        <p className="label">申诉理由</p>
        <p className="quote clamp">{appeal.note}</p>
      </div>
      {appeal.decision.sampleText !== null && (
        <div className="field">
          <p className="label">被处理的内容</p>
          <p className="quote clamp">{appeal.decision.sampleText}</p>
        </div>
      )}

      {confirming === null ? (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={resolving}
            onClick={() => onConfirmAsk('upheld')}
          >
            {RESOLUTION_TEXT.upheld.button}
          </button>
          <button
            type="button"
            className="btn"
            disabled={resolving}
            onClick={() => onConfirmAsk('overturned')}
          >
            {RESOLUTION_TEXT.overturned.button}
          </button>
        </div>
      ) : (
        <div className="confirm-box">
          <p className="confirm-text">{RESOLUTION_TEXT[confirming].confirm}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={resolving} onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              disabled={resolving}
              onClick={() => onResolve(confirming)}
            >
              {resolving ? '处理中…' : '确认'}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
