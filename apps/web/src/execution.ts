import type { Action, ExecutionResult } from '@skitarii/core'

export function executionText(result: ExecutionResult, original: Action['kind']): string {
  switch (result.kind) {
    case 'pending': return '等待执行或重试'
    case 'unknown': return '历史执行结果未记录'
    case 'applied': return result.action !== original ? '已降级为删除消息'
      : result.action === 'pass' ? '已放行' : '已执行'
    case 'rejected':
      switch (result.reason) {
        case 'telegram_rejected': return '执行失败：Telegram 拒绝了操作'
        case 'warning_delivery_unconfirmed': return '警告送达未确认'
        case 'cancelled_by_appeal': return '因申诉撤销，未执行处置'
      }
  }
}
