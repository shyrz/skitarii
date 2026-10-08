import { useCallback, useEffect, useRef, useState } from 'react'
import { ConflictError, NotFoundError, fetchPanelAppeals, resolvePanelAppeal } from '../api.js'
import { executionText } from '../execution.js'
import type { PanelAppealDto, PanelAppealPage, PanelResolution } from '../api.js'
import { ACTION_LABEL, ACTION_TONE, VERDICT_LABEL, formatTime } from './util.js'

type QueueState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; page: PanelAppealPage; pending: 'none' | 'refresh' | 'more'; error: string | null }

type Notice = { text: string; tone: 'notice' | 'caution' | 'danger' }

export function AppealsTab({ initData, chatId, queue, active, revision, onChanged, onBusyChange, onOpenRule, onFatal }: {
  initData: string
  chatId: string
  queue: 'open' | 'resolved'
  active: boolean
  revision: number
  onChanged: () => void
  onBusyChange: (busy: boolean) => void
  onOpenRule: (chatId: string, ruleId: string) => void
  onFatal: (error: unknown) => boolean
}) {
  const [state, setState] = useState<QueueState>({ kind: 'loading' })
  const [confirming, setConfirming] = useState<{ id: string; resolution: PanelResolution } | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const requestSeq = useRef(0)
  const reading = useRef(false)
  const writing = useRef(false)
  const loadedPages = useRef(1)
  const loadedKey = useRef('')
  const updatedAt = useRef(0)
  const seenRevision = useRef(-1)

  const load = useCallback(async (more?: PanelAppealPage['nextBefore']) => {
    if (reading.current) return
    const seq = ++requestSeq.current
    reading.current = true
    setState((current) => current.kind === 'ready'
      ? { ...current, pending: more ? 'more' : 'refresh', error: null }
      : { kind: 'loading' })
    try {
      let page: PanelAppealPage = { items: [], nextBefore: null }
      let cursor = more ?? undefined
      const pages = more ? 1 : loadedPages.current
      for (let index = 0; index < pages; index += 1) {
        const result = await fetchPanelAppeals(initData, {
          state: queue, ...(chatId === '' ? {} : { chatId }), ...(cursor ? { before: cursor } : {}),
        })
        if (seq !== requestSeq.current) return
        page = { items: [...page.items, ...result.items], nextBefore: result.nextBefore }
        cursor = result.nextBefore ?? undefined
        if (cursor === undefined) break
      }
      if (more) loadedPages.current += 1
      updatedAt.current = Date.now()
      if (seq !== requestSeq.current) return
      setState((current) => {
        const previous = more && current.kind === 'ready' ? current.page.items : []
        const ids = new Set(previous.map((item) => item.id))
        return { kind: 'ready', page: {
          items: [...previous, ...page.items.filter((item) => !ids.has(item.id))],
          nextBefore: page.nextBefore,
        }, pending: 'none', error: null }
      })
    } catch (error) {
      if (seq !== requestSeq.current || onFatal(error)) return
      setState((current) => current.kind === 'ready'
        ? { ...current, pending: 'none', error: '更新失败，保留当前记录。请重试。' }
        : { kind: 'failed' })
    } finally {
      if (seq === requestSeq.current) reading.current = false
    }
  }, [initData, queue, chatId, onFatal])

  useEffect(() => {
    const key = `${queue}:${chatId}`
    if (loadedKey.current !== key) {
      loadedKey.current = key
      loadedPages.current = 1
      updatedAt.current = 0
      setState({ kind: 'loading' })
      setConfirming(null)
      setNotice(null)
    }
    if (active && !writing.current && (Date.now() - updatedAt.current > 30_000 || seenRevision.current !== revision)) {
      seenRevision.current = revision
      void load()
    }
    return () => {
      requestSeq.current += 1
      reading.current = false
      setState(current => current.kind === 'ready' ? { ...current, pending: 'none' } : current)
    }
  }, [load, active, revision, queue, chatId])

  const onResolve = async (appeal: PanelAppealDto, resolution: PanelResolution) => {
    if (writing.current) return
    writing.current = true
    onBusyChange(true)
    requestSeq.current += 1
    reading.current = false
    setState((current) => current.kind === 'ready' ? { ...current, pending: 'none', error: null } : current)
    setResolving(appeal.id)
    setNotice(null)
    const removeFromQueue = async () => {
      setState((current) => current.kind === 'ready' ? {
        ...current, page: { ...current.page, items: current.page.items.filter((item) => item.id !== appeal.id) },
      } : current)
      if (state.kind === 'ready' && state.page.items.length === 1 && state.page.nextBefore !== null) {
        await load(state.page.nextBefore)
      }
    }
    try {
      const result = await resolvePanelAppeal(appeal.id, initData, resolution)
      setNotice({ tone: result.rollbackFailed ? 'caution' : 'notice',
        text: result.rollbackFailed ? '已撤销，解除限制仍待处理，请核实当前权限。'
          : result.state === 'upheld' ? '已维持原处置。' : '已撤销处置。已删除的消息不会恢复。' })
      await removeFromQueue()
      seenRevision.current = revision + 1
      onChanged()
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) {
        setNotice({ tone: 'caution', text: error instanceof ConflictError
          ? '这条申诉已被处理，可在已结案中查看结果。' : '记录已不可用，已从当前列表移除。' })
        await removeFromQueue()
        seenRevision.current = revision + 1
      onChanged()
      } else if (!onFatal(error)) setNotice({ tone: 'danger', text: '操作失败，当前申诉仍保留。请检查网络后重试。' })
    } finally {
      writing.current = false
      onBusyChange(false)
      setResolving(null)
      setConfirming(null)
    }
  }

  const busy = resolving !== null
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  return (
    <div className="stack">
      <div className="row-between">
        <p className="list-sub">{queue === 'open' ? '阅读证据后选择维持或撤销。' : '查看已结案申诉及权限恢复状态。'}</p>
        <button type="button" className="text-btn" disabled={busy || state.kind === 'loading' ||
          (state.kind === 'ready' && state.pending !== 'none')} onClick={() => void load()}>
          {state.kind === 'ready' && state.pending === 'refresh' ? '刷新中…' : '刷新'}
        </button>
      </div>
      {notice !== null && <section className="appeal-status"
        style={{ ['--tone' as string]: `var(--tone-${notice.tone})` }}
        role={notice.tone === 'danger' ? 'alert' : 'status'}><p>{notice.text}</p></section>}
      {state.kind === 'loading' && <p className="tab-pending" role="status">正在加载申诉…</p>}
      {state.kind === 'failed' && <div className="tab-pending">
        <p>申诉列表没加载出来。</p>
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>重试</button>
      </div>}
      {state.kind === 'ready' && <>
        {state.error !== null && <p className="form-error" role="alert">{state.error}</p>}
        {state.page.items.length === 0 && <p className="empty-state">
          {state.page.nextBefore !== null ? '本页已处理完，可继续加载。'
            : queue === 'open' ? '没有待处理的申诉。' : '没有已结案的申诉。'}
        </p>}
        {state.page.items.map((appeal) => <article className="list-card" key={appeal.id}>
          <div className="row-between">
            <span className="badge" style={{ ['--tone' as string]: ACTION_TONE[appeal.decision.action] }}>
              {appeal.state === 'open' ? ACTION_LABEL[appeal.decision.action]
                : appeal.state === 'upheld' ? '已维持' : '已撤销'}
            </span>
            <span className="list-time">{formatTime(appeal.resolvedAt ?? appeal.createdAt)}</span>
          </div>
          <p className="list-line">{appeal.decision.chatTitle} · 用户 {appeal.userId}</p>
          <p className="list-sub">原处置 {ACTION_LABEL[appeal.decision.action]}</p>
          <p className="list-sub">{executionText(appeal.decision.execution, appeal.decision.action)}</p>
          {appeal.rollbackPending && <p className="form-error" role="status">已撤销，解除限制仍待处理。系统会继续尝试，请核实当前权限。</p>}
          <p className="quote clamp">{appeal.note}</p>
          <details className="appeal-evidence">
            <summary>查看完整申诉与消息摘录</summary>
            <p className="label">申诉理由</p><p className="quote">{appeal.note}</p>
            <p className="label">判断依据</p>
            <p className="list-sub">分数 {appeal.decision.score.toFixed(2)}，不代表误判概率。</p>
            <p className="list-sub">{appeal.decision.llm === null ? '未进行模型复核' : `模型复核 ${VERDICT_LABEL[appeal.decision.llm.verdict] ?? appeal.decision.llm.verdict} · 置信度 ${Math.round(appeal.decision.llm.confidence * 100)}%`}</p>
            <div className="chips">{appeal.decision.ruleIds.map(id => <button type="button" className="chip" key={id} disabled={busy} onClick={() => onOpenRule(appeal.decision.chatId, id)}>{id}</button>)}</div>
            <p className="footnote">规则入口展示当前配置，可能与判定时不同。</p>
            <p className="label">已保存消息摘录</p>
            <p className="quote">{appeal.decision.sampleText ?? '未保存消息摘录。'}</p>
          </details>
          {appeal.state === 'open' && (confirming?.id === appeal.id ? <div className="confirm-box">
            <p className="confirm-text">{confirming.resolution === 'upheld' ? '确认维持原处置？'
              : '确认撤销处置？已生效的限制将尝试解除，已删除的消息不会恢复。'}</p>
            <div className="btn-row">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>取消</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void onResolve(appeal, confirming.resolution)}>
                {resolving === appeal.id ? '处理中…' : '确认'}
              </button>
            </div>
          </div> : <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => setConfirming({ id: appeal.id, resolution: 'upheld' })}>维持原处置</button>
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => setConfirming({ id: appeal.id, resolution: 'overturned' })}>
              撤销处置
            </button>
          </div>)}
        </article>)}
        {state.page.nextBefore !== null && <button type="button" className="btn btn-secondary"
          disabled={busy || state.pending !== 'none'} onClick={() => void load(state.page.nextBefore)}>
          {state.pending === 'more' ? '加载中…' : '加载更多'}
        </button>}
      </>}
    </div>
  )
}
