/**
 * 申诉接口客户端。initData 是 Telegram 签发的身份凭据：
 * GET 没有请求体，放在 query；POST 放在 body。后端两种携带方式都认。
 *
 * 错误分三类，UI 按类决定显示哪一屏：
 * - NotFoundError：404，记录不存在或不属于当前账号，不可重试；
 * - ConflictError：409，已提交过申诉，调用方应重新拉取展示既有申诉；
 * - 其余（网络失败、5xx、异常响应）：可重试。
 */

export type DecisionAction = 'warn' | 'delete' | 'mute' | 'ban'

export interface DecisionDto {
  id: string
  action: DecisionAction
  chatTitle: string
  createdAt: string
  sampleText: string
}

export type AppealStateDto = 'open' | 'upheld' | 'overturned'

export interface AppealDto {
  id: string
  state: AppealStateDto
  reason: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface AppealView {
  decision: DecisionDto
  appeal: AppealDto | null
}

export class NotFoundError extends Error {
  constructor() {
    super('记录不存在')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor() {
    super('已提交过申诉')
    this.name = 'ConflictError'
  }
}

/** 把非 2xx 响应映射成上面的错误类型；永远抛错。 */
function throwForStatus(res: Response): never {
  if (res.status === 404) throw new NotFoundError()
  if (res.status === 409) throw new ConflictError()
  throw new Error(`请求失败（HTTP ${res.status}）`)
}

export async function fetchAppeal(decisionId: string, initData: string): Promise<AppealView> {
  const url = `/api/appeals/${encodeURIComponent(decisionId)}?initData=${encodeURIComponent(initData)}`
  const res = await fetch(url)
  if (!res.ok) throwForStatus(res)
  return (await res.json()) as AppealView
}

export async function submitAppeal(
  decisionId: string,
  initData: string,
  reason: string,
): Promise<AppealDto> {
  const res = await fetch('/api/appeals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, decisionId, reason }),
  })
  if (!res.ok) throwForStatus(res)
  const body = (await res.json()) as { appeal: AppealDto }
  return body.appeal
}
