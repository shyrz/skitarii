import { useCallback, useEffect, useRef, useState } from 'react'
import { InvalidRequestError, fetchPanelConfig, savePanelConfig } from '../api.js'
import type {
  PanelChatDto,
  PanelConfigDto,
  PanelConfigInput,
  PanelDecisionAction,
  PanelRuleDto,
  PanelRuleKind,
} from '../api.js'
import { RULE_ACTION_LABEL, RULE_KIND_LABEL } from './util.js'

/**
 * 规则页签：按群编辑阈值、禁言时长与规则集，保存后立即生效（管线每条消息读配置）。
 *
 * 编辑全部落在本地草稿上，「保存」才一次性 PUT 全量替换；保存返回后以服务端 config
 * 覆盖本地（拿到分配后的正式 id）。删除规则与结案确认同模式：第一次点只展开确认条。
 */

/** 选项直接取标签表的键，新增匹配方式时只改 util 一处，不会出现「有 kind 没选项」的漂移。 */
const RULE_KINDS = Object.keys(RULE_KIND_LABEL) as PanelRuleKind[]
const RULE_ACTIONS: PanelDecisionAction[] = ['pass', 'warn', 'delete', 'mute', 'ban']

/** 本地新增规则的 id 前缀：保存时置空串交给服务端分配，避免与正式 id 撞车。 */
const LOCAL_ID_PREFIX = 'local-'

/** 新增规则的默认档位（phase2b-spec §2）。 */
const NEW_RULE_DEFAULTS = { kind: 'keyword', score: 0.4, actionHint: 'delete', enabled: true } as const

/** 从服务端 config 抽出可编辑部分作为草稿。 */
function toDraft(config: PanelConfigDto): PanelConfigInput {
  return {
    passThreshold: config.passThreshold,
    llmThreshold: config.llmThreshold,
    muteDurationMinutes: config.muteDurationMinutes,
    rules: config.rules,
  }
}

export function RulesTab({
  initData,
  chats,
  onFatal,
}: {
  initData: string
  chats: PanelChatDto[]
  onFatal: (error: unknown) => boolean
}) {
  const [chatId, setChatId] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed' | 'ready'>('idle')
  const [saved, setSaved] = useState<PanelConfigDto | null>(null)
  const [draft, setDraft] = useState<PanelConfigInput | null>(null)
  /** 脏标记：任何编辑操作置位，保存成功/放弃/换群时复位。 */
  const [dirty, setDirty] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 400 的逐条校验错误，或非校验类保存失败的单行提示。 */
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const localCounter = useRef(0)
  /** 请求序号：快速换群时旧响应靠它识别并丢弃，不覆盖新群的草稿。 */
  const loadSeq = useRef(0)

  const load = useCallback(
    async (id: string) => {
      const seq = ++loadSeq.current
      setStatus('loading')
      setNotice(null)
      setSaveErrors([])
      setEditingId(null)
      setConfirmingDelete(null)
      try {
        const config = await fetchPanelConfig(id, initData)
        if (seq !== loadSeq.current) return // 期间已换群，丢弃过期响应
        setSaved(config)
        setDraft(toDraft(config))
        setDirty(false)
        setStatus('ready')
      } catch (error) {
        if (seq !== loadSeq.current) return
        if (!onFatal(error)) setStatus('failed')
      }
    },
    [initData, onFatal],
  )

  useEffect(() => {
    if (chatId === '') {
      // 作废在途请求：取消选择后，旧群的响应不应再落到界面上
      loadSeq.current += 1
      setStatus('idle')
      return
    }
    void load(chatId)
  }, [chatId, load])

  /** 更新草稿并标脏；所有编辑操作走这一个口子。 */
  const mutate = useCallback((fn: (current: PanelConfigInput) => PanelConfigInput) => {
    setDraft((current) => (current === null ? current : fn(current)))
    setDirty(true)
    setNotice(null)
  }, [])

  const updateRule = useCallback(
    (id: string, patch: Partial<PanelRuleDto>) => {
      mutate((current) => ({
        ...current,
        rules: current.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      }))
    },
    [mutate],
  )

  const addRule = useCallback(() => {
    localCounter.current += 1
    const id = `${LOCAL_ID_PREFIX}${localCounter.current}`
    mutate((current) => ({
      ...current,
      rules: [...current.rules, { id, pattern: '', ...NEW_RULE_DEFAULTS }],
    }))
    // 新规则直接进编辑态，引导先填 pattern
    setEditingId(id)
    setConfirmingDelete(null)
  }, [mutate])

  const removeRule = useCallback(
    (id: string) => {
      mutate((current) => ({ ...current, rules: current.rules.filter((r) => r.id !== id) }))
      setConfirmingDelete(null)
      setEditingId((current) => (current === id ? null : current))
    },
    [mutate],
  )

  const onSave = useCallback(async () => {
    if (draft === null || !dirty || saving) return
    setSaving(true)
    setSaveErrors([])
    setNotice(null)
    try {
      const config = await savePanelConfig(chatId, initData, {
        ...draft,
        // 本地新增规则的 id 交给服务端分配；`via-bot` 的 pattern 统一置空（与后端归一逻辑同口径）。
        rules: draft.rules.map((r) => ({
          ...r,
          id: r.id.startsWith(LOCAL_ID_PREFIX) ? '' : r.id,
          pattern: r.kind === 'via-bot' ? '' : r.pattern,
        })),
      })
      // 以服务端返回为准：拿到分配后的正式 id，本地草稿与服务端对齐
      setSaved(config)
      setDraft(toDraft(config))
      setDirty(false)
      setEditingId(null)
      setConfirmingDelete(null)
      setNotice('已保存，立即生效')
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        setSaveErrors(error.details.length > 0 ? error.details : ['配置校验未通过，请检查后再保存。'])
      } else if (!onFatal(error)) {
        setSaveErrors(['保存失败，请检查网络后再试一次。'])
      }
    } finally {
      setSaving(false)
    }
  }, [chatId, initData, draft, dirty, saving, onFatal])

  const onDiscard = useCallback(() => {
    if (saved === null) return
    setDraft(toDraft(saved))
    setDirty(false)
    setEditingId(null)
    setConfirmingDelete(null)
    setSaveErrors([])
    setNotice(null)
  }, [saved])

  return (
    <div className="stack">
      {chats.length === 0 ? (
        <p className="empty-state">还没有已登记的群。把机器人拉进群后会自动登记。</p>
      ) : (
        <select
          className="select"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
          disabled={saving}
          aria-label="选择要配置的群"
        >
          <option value="">选择群…</option>
          {chats.map((chat) => (
            <option key={chat.chatId} value={chat.chatId}>
              {chat.title}
            </option>
          ))}
        </select>
      )}

      {status === 'idle' && chats.length > 0 && (
        <p className="empty-state">先选择一个群，再编辑它的规则与阈值。</p>
      )}
      {status === 'loading' && (
        <div className="tab-pending">
          <div className="spinner" aria-hidden="true" />
          <p role="status">正在加载配置…</p>
        </div>
      )}
      {status === 'failed' && (
        <div className="tab-pending">
          <p>配置没加载出来。</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load(chatId)}>
            重试
          </button>
        </div>
      )}

      {status === 'ready' && draft !== null && (
        <>
          <section className="card" aria-label="阈值">
            <div className="threshold-grid">
              <div className="field">
                <label className="label" htmlFor="pass-threshold">
                  放行阈值
                </label>
                <input
                  id="pass-threshold"
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.passThreshold}
                  disabled={saving}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber
                    if (!Number.isNaN(value)) {
                      mutate((current) => ({ ...current, passThreshold: value }))
                    }
                  }}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="llm-threshold">
                  复核阈值
                </label>
                <input
                  id="llm-threshold"
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.llmThreshold}
                  disabled={saving}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber
                    if (!Number.isNaN(value)) {
                      mutate((current) => ({ ...current, llmThreshold: value }))
                    }
                  }}
                />
              </div>
            </div>
            {/* 语义说明按实际值渲染（不固定小数位），显示值与保存值保持一致 */}
            <p className="list-sub">
              低于 {String(draft.passThreshold)} 放行；{String(draft.passThreshold)}–
              {String(draft.llmThreshold)} 交 LLM 复核；≥ {String(draft.llmThreshold)}{' '}
              直接处置。
            </p>
            <div className="field">
              <label className="label" htmlFor="mute-duration">
                禁言时长（分钟）
              </label>
              <input
                id="mute-duration"
                className="input"
                type="number"
                min={1}
                max={43200}
                step={1}
                value={draft.muteDurationMinutes}
                disabled={saving}
                onChange={(event) => {
                  const value = event.target.valueAsNumber
                  if (!Number.isNaN(value)) {
                    mutate((current) => ({ ...current, muteDurationMinutes: value }))
                  }
                }}
              />
            </div>
            <p className="list-sub">保存后立即生效。</p>
          </section>

          <section aria-label="规则列表">
            <h2 className="section-title">规则（{draft.rules.length}）</h2>
            {draft.rules.length === 0 && (
              <p className="empty-state">这个群还没有规则，点下方「新增规则」。</p>
            )}
            {draft.rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                editing={editingId === rule.id}
                confirmingDelete={confirmingDelete === rule.id}
                disabled={saving}
                onEdit={() => {
                  setEditingId(editingId === rule.id ? null : rule.id)
                  setConfirmingDelete(null)
                }}
                onChange={(patch) => updateRule(rule.id, patch)}
                onDeleteAsk={() => {
                  setConfirmingDelete(rule.id)
                  setEditingId(null)
                }}
                onDeleteCancel={() => setConfirmingDelete(null)}
                onDeleteConfirm={() => removeRule(rule.id)}
              />
            ))}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving}
              onClick={addRule}
            >
              新增规则
            </button>
            <p className="footnote">
              规则按归一化后的形态书写（如「加v」会被归一为「加微信」）。
            </p>
          </section>

          <section aria-label="保存">
            {notice !== null && (
              <section
                className="appeal-status"
                style={{ ['--tone' as string]: 'var(--tone-success)' }}
                role="status"
              >
                <div>
                  <p>{notice}</p>
                </div>
              </section>
            )}
            {saveErrors.length > 0 && (
              <div className="save-errors" role="alert">
                {saveErrors.map((message, index) => (
                  // 服务端 details 可能含重复文案，key 带上序号
                  <p className="form-error" key={`${index}-${message}`}>
                    {message}
                  </p>
                ))}
              </div>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!dirty || saving}
                onClick={onDiscard}
              >
                放弃
              </button>
              <button
                type="button"
                className="btn"
                disabled={!dirty || saving}
                onClick={() => void onSave()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function RuleCard({
  rule,
  editing,
  confirmingDelete,
  disabled,
  onEdit,
  onChange,
  onDeleteAsk,
  onDeleteCancel,
  onDeleteConfirm,
}: {
  rule: PanelRuleDto
  editing: boolean
  confirmingDelete: boolean
  disabled: boolean
  onEdit: () => void
  onChange: (patch: Partial<PanelRuleDto>) => void
  onDeleteAsk: () => void
  onDeleteCancel: () => void
  onDeleteConfirm: () => void
}) {
  /** `via-bot` 是布尔特征规则，pattern 不参与判定：输入禁用并给出说明，避免填了却不生效。 */
  const ignoresPattern = rule.kind === 'via-bot'

  return (
    <article className="list-card">
      <div className="row-between">
        <span className="rule-head">
          <label className="switch">
            <input
              type="checkbox"
              checked={rule.enabled}
              disabled={disabled}
              onChange={(event) => onChange({ enabled: event.target.checked })}
              aria-label="启用这条规则"
            />
            <span className="track" aria-hidden="true" />
          </label>
          <span className="chip">{RULE_KIND_LABEL[rule.kind]}</span>
        </span>
        {!editing && (
          <span className="rule-actions">
            <button type="button" className="text-btn" disabled={disabled} onClick={onEdit}>
              编辑
            </button>
            <button
              type="button"
              className="text-btn danger"
              disabled={disabled}
              onClick={onDeleteAsk}
            >
              删除
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <div className="rule-edit">
          <div className="rule-edit-row">
            <select
              className="select"
              value={rule.kind}
              disabled={disabled}
              onChange={(event) => {
                const kind = event.target.value as PanelRuleKind
                // 切到 `via-bot` 时把 pattern 一并置空：此 kind 不使用 pattern，留着旧值会误导。
                onChange(kind === 'via-bot' ? { kind, pattern: '' } : { kind })
              }}
              aria-label="匹配方式"
            >
              {RULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {RULE_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={rule.actionHint}
              disabled={disabled}
              onChange={(event) => onChange({ actionHint: event.target.value as PanelDecisionAction })}
              aria-label="动作"
            >
              {RULE_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {RULE_ACTION_LABEL[action]}
                </option>
              ))}
            </select>
          </div>
          <input
            className="input mono"
            value={rule.pattern}
            disabled={disabled || ignoresPattern}
            placeholder="匹配内容"
            onChange={(event) => onChange({ pattern: event.target.value })}
            aria-label="匹配内容"
          />
          {ignoresPattern && <p className="list-sub">此匹配方式不使用 pattern</p>}
          <div className="rule-edit-row">
            <input
              className="input"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={rule.score}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.valueAsNumber
                if (!Number.isNaN(value)) onChange({ score: value })
              }}
              aria-label="违规分"
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled}
              onClick={onEdit}
            >
              完成
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="rule-pattern">{rule.pattern === '' ? '（未填写）' : rule.pattern}</p>
          <p className="list-sub">
            分数 {rule.score.toFixed(2)} · 动作 {RULE_ACTION_LABEL[rule.actionHint]}
            {rule.enabled ? '' : ' · 已停用'}
          </p>
        </>
      )}

      {confirmingDelete && (
        <div className="confirm-box">
          <p className="confirm-text">确认删除这条规则？保存后才会真正生效。</p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled}
              onClick={onDeleteCancel}
            >
              取消
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={onDeleteConfirm}>
              确认删除
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
