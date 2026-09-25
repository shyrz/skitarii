/**
 * 面板视图的展示工具：动作/复核结论的中文文案、时间与日期格式化、趋势序列合并。
 * 与 AppealApp 的同名格式化逻辑各自独立——申诉视图要求零改动，这里不回头引用它。
 */

import type { PanelDecisionAction, PanelRuleKind, PanelSeriesPointDto } from '../api.js'

/** 动作档位 → 中文文案。只陈述事实，与申诉页措辞一致。 */
export const ACTION_LABEL: Record<PanelDecisionAction, string> = {
  pass: '放行',
  warn: '警告',
  delete: '删除',
  mute: '禁言',
  ban: '封禁',
}

/** 动作档位 → 徽章色调，沿用全局语义色。 */
export const ACTION_TONE: Record<PanelDecisionAction, string> = {
  pass: 'var(--tone-notice)',
  warn: 'var(--tone-caution)',
  delete: 'var(--tone-notice)',
  mute: 'var(--tone-caution)',
  ban: 'var(--tone-danger)',
}

/** LLM 复核结论 → 中文文案。键是后端 verdict 原值，未收录的值回退显示原文。 */
export const VERDICT_LABEL: Record<string, string> = {
  legit: '正常',
  spam: '垃圾信息',
  scam: '诈骗',
}

/** 规则匹配方式 → 中文标签（规则页签用；选项顺序即这里的书写顺序）。 */
export const RULE_KIND_LABEL: Record<PanelRuleKind, string> = {
  keyword: '关键词',
  regex: '正则',
  'link-domain': '域名',
  'sender-name': '发送者名',
  'custom-emoji': '表情计数',
  'emoji-count': '表情总数',
  'via-bot': '内联机器人',
}

/**
 * 规则动作档位 → 中文文案。与 ACTION_LABEL 分开：规则语境里 warn 写作「警示」，
 * 避免与处置记录里既成事实的「警告」措辞互相牵扯（phase2b-spec §2）。
 */
export const RULE_ACTION_LABEL: Record<PanelDecisionAction, string> = {
  pass: '放行',
  warn: '警示',
  delete: '删除',
  mute: '禁言',
  ban: '封禁',
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : timeFormatter.format(date)
}

/**
 * 把多个群的日序列按日期相加，得到「全部群」趋势。
 * 后端只提供单群序列端点；群数量小，前端并行拉取后合并。
 * 入参各序列升序连续（缺失日后端补零），合并结果同样升序。
 */
export function mergeSeries(list: PanelSeriesPointDto[][]): PanelSeriesPointDto[] {
  const byDate = new Map<string, PanelSeriesPointDto>()
  for (const days of list) {
    for (const day of days) {
      const acc = byDate.get(day.date)
      if (acc === undefined) {
        byDate.set(day.date, { ...day })
      } else {
        acc.messageCount += day.messageCount
        acc.actionCount += day.actionCount
        acc.appealCount += day.appealCount
        acc.overturnedCount += day.overturnedCount
      }
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
