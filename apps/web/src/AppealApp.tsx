import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AuthError, ConflictError, NotFoundError, fetchAppeal, submitAppeal } from './api.js'
import type { AppealDto, AppealView, DecisionAction } from './api.js'
import { getDecisionId, getInitData, getWebApp } from './telegram.js'

/** 申诉理由长度上限，与后端校验一致。 */
const REASON_MAX = 500

/** 动作类型 → 展示文案与色调。文案只陈述事实，不解释规则。 */
const ACTION_META: Record<
  DecisionAction,
  { badge: string; title: string; tone: string }
> = {
  warn: { badge: '警告', title: '你的发言收到了警告', tone: 'var(--tone-caution)' },
  delete: { badge: '消息已删除', title: '你的消息已被删除', tone: 'var(--tone-notice)' },
  mute: { badge: '禁言', title: '你已被禁言', tone: 'var(--tone-caution)' },
  ban: { badge: '封禁', title: '你已被封禁', tone: 'var(--tone-danger)' },
}

type Screen =
  | { kind: 'loading' }
  | { kind: 'no-param' }
  | { kind: 'no-credential' }
  | { kind: 'auth' }
  | { kind: 'not-found' }
  | { kind: 'failed'; detail: string }
  | { kind: 'ready'; view: AppealView }

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : timeFormatter.format(date)
}

export function AppealApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** 区分「本次刚提交成功」与「打开时已有申诉」，两者标题文案不同。 */
  const [justSubmitted, setJustSubmitted] = useState(false)
  const initDataRef = useRef('')

  const load = useCallback(async () => {
    const decisionId = getDecisionId()
    if (decisionId === null) {
      setScreen({ kind: 'no-param' })
      return
    }
    initDataRef.current = getInitData()
    if (initDataRef.current === '') {
      // Telegram 没把签名凭据带进来（脚本缺席且回退也拿不到），请求必然 401，直接给出可操作的提示。
      setScreen({ kind: 'no-credential' })
      return
    }
    setScreen({ kind: 'loading' })
    try {
      const view = await fetchAppeal(decisionId, initDataRef.current)
      setScreen({ kind: 'ready', view })
    } catch (error) {
      if (error instanceof NotFoundError) setScreen({ kind: 'not-found' })
      else if (error instanceof AuthError) setScreen({ kind: 'auth' })
      else setScreen({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    // ready/expand 幂等，StrictMode 双调用无副作用
    const webApp = getWebApp()
    webApp?.ready()
    webApp?.expand()
    void load()
  }, [load])

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const decisionId = getDecisionId()
      const trimmed = reason.trim()
      if (decisionId === null || trimmed === '' || trimmed.length > REASON_MAX || submitting) {
        return
      }
      setSubmitting(true)
      setSubmitError(null)
      try {
        const appeal = await submitAppeal(decisionId, initDataRef.current, trimmed)
        setScreen((current) =>
          current.kind === 'ready' ? { kind: 'ready', view: { ...current.view, appeal } } : current,
        )
        setJustSubmitted(true)
      } catch (error) {
        if (error instanceof ConflictError) {
          // 已有申诉：重新拉取，直接展示既有状态
          await load()
        } else {
          setSubmitError('提交失败，请检查网络后再试一次。')
        }
      } finally {
        setSubmitting(false)
      }
    },
    [reason, submitting, load],
  )

  if (screen.kind === 'loading') {
    return (
      <main className="screen">
        <div className="center-state">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在打开申诉页…</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'no-param') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>这条链接打不开</h1>
          <p>请从群消息里的申诉按钮进入本页。</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'not-found') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>没有找到这条处理记录</h1>
          <p>它不属于当前账号，或已被清理。这不是你的问题。如果刚换过 Telegram 账号，用原账号再打开一次。</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'no-credential') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>页面缺少登录凭据</h1>
          <p>请从群消息里的申诉按钮打开本页，不要把链接复制到外部浏览器。</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'auth') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>身份验证失败</h1>
          <p>凭据已过期或无效。回到群消息重新点「提起申诉」按钮即可刷新。</p>
        </div>
      </main>
    )
  }

  if (screen.kind === 'failed') {
    return (
      <main className="screen">
        <div className="center-state">
          <InfoIcon />
          <h1>内容没加载出来</h1>
          <p>网络似乎不太稳定，你的申诉还没有提交，重试不会重复。</p>
          <p className="detail">{screen.detail}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </div>
      </main>
    )
  }

  const { decision, appeal } = screen.view
  const meta = ACTION_META[decision.action]

  return (
    <main className="screen">
      <div className="stack">
        {appeal !== null ? (
          <AppealStatus appeal={appeal} justSubmitted={justSubmitted} />
        ) : (
          <header className="header">
            <span className="badge" style={{ ['--tone' as string]: meta.tone }}>
              <ActionIcon action={decision.action} />
              {meta.badge}
            </span>
            <h1>{meta.title}</h1>
            <p className="sub">如果认为这是误处理，可以在下面申诉，由群主复核。</p>
          </header>
        )}

        <section className="card" aria-label="处理详情">
          <div className="field">
            <p className="label">群组</p>
            <p className="value">{decision.chatTitle}</p>
          </div>
          <div className="field">
            <p className="label">时间</p>
            <p className="value">{formatTime(decision.createdAt)}</p>
          </div>
          <div className="field">
            <p className="label">被处理的内容</p>
            <p className="quote">{decision.sampleText}</p>
          </div>
        </section>

        {appeal === null && (
          <form className="form" onSubmit={(event) => void onSubmit(event)}>
            <label className="label" htmlFor="reason">
              申诉理由
            </label>
            <p className="hint">写清楚发生了什么，群主会看到这段话。</p>
            <textarea
              id="reason"
              className="textarea"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：这是正常的聊天内容，没有广告和链接。"
              disabled={submitting}
            />
            <p className={reason.length > REASON_MAX ? 'counter over' : 'counter'}>
              {reason.length}/{REASON_MAX}
            </p>
            {submitError !== null && <p className="form-error">{submitError}</p>}
            <button
              type="submit"
              className="btn"
              disabled={submitting || reason.trim() === '' || reason.length > REASON_MAX}
            >
              {submitting ? '提交中…' : '提交申诉'}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}

/** 申诉状态横幅：刚提交/待复核/两种终态，文案各不相同。 */
function AppealStatus({ appeal, justSubmitted }: { appeal: AppealDto; justSubmitted: boolean }) {
  if (appeal.state === 'open') {
    return (
      <section
        className="appeal-status"
        style={{ ['--tone' as string]: 'var(--tone-notice)' }}
        aria-label="申诉状态"
      >
        <span className="status-icon">
          <ClockIcon />
        </span>
        <div>
          <h1>{justSubmitted ? '申诉已提交' : '你已提交过申诉'}</h1>
          <p>正在等群主复核，不用重复提交。</p>
          <p className="time">提交于 {formatTime(appeal.createdAt)}</p>
        </div>
      </section>
    )
  }

  if (appeal.state === 'upheld') {
    return (
      <section
        className="appeal-status"
        style={{ ['--tone' as string]: 'var(--tone-danger)' }}
        aria-label="申诉状态"
      >
        <span className="status-icon">
          <CrossIcon />
        </span>
        <div>
          <h1>申诉未通过</h1>
          <p>群主复核后维持了原处理。还有疑问可以直接联系群主。</p>
          {appeal.resolvedAt !== null && <p className="time">复核于 {formatTime(appeal.resolvedAt)}</p>}
        </div>
      </section>
    )
  }

  return (
    <section
      className="appeal-status"
      style={{ ['--tone' as string]: 'var(--tone-success)' }}
      aria-label="申诉状态"
    >
      <span className="status-icon">
        <CheckIcon />
      </span>
      <div>
        <h1>申诉已通过</h1>
        <p>群主复核后撤销了原处理，给你添麻烦了。</p>
        {appeal.resolvedAt !== null && <p className="time">复核于 {formatTime(appeal.resolvedAt)}</p>}
      </div>
    </section>
  )
}

/* ---- 图标：单一 currentColor SVG，描边 1.5px 配正文/徽章字重 ---- */

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

function ActionIcon({ action }: { action: DecisionAction }) {
  switch (action) {
    case 'warn':
      return (
        <svg {...iconProps}>
          <path d="M12 4 2.5 20h19L12 4Z" />
          <path d="M12 10v4" />
          <path d="M12 17h.01" />
        </svg>
      )
    case 'delete':
      return (
        <svg {...iconProps}>
          <path d="M4 7h16" />
          <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          <path d="M6.5 7 7.5 20a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13" />
        </svg>
      )
    case 'mute':
      return (
        <svg {...iconProps}>
          <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
          <path d="m15 9 6 6" />
          <path d="m21 9-6 6" />
        </svg>
      )
    case 'ban':
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M5.5 5.5l13 13" />
        </svg>
      )
  }
}

function InfoIcon() {
  return (
    <svg {...iconProps} width={40} height={40} className="state-icon">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg {...iconProps} width={20} height={20}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg {...iconProps} width={20} height={20}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg {...iconProps} width={20} height={20}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </svg>
  )
}
