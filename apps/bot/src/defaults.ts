import type { ChatConfig, ChatId, Rule } from '@skitarii/core'

/**
 * 未登记群的默认配置。
 *
 * 为什么需要它：`chats` 表是配置的权威来源，但 bot 被拉进一个新群时没有任何一行配置。
 * 若此时跳过审核，新群会处于「无人看守」状态直到有人手动写库；对自用场景这是不可接受的运维负担。
 * 因此首次见到未登记的群时用这份默认配置注册，之后所有调整都改数据库行。
 *
 * 规则集的取向：中文群、保守起步。只收录「几乎不可能是正常讨论」的引流话术与拉人头用语，
 * 分数刻意压低（0.4 上下），让大多数命中落在灰色地带交给 LLM 复核，而不是直接处置。
 * 阈值 `passThreshold = 0.3`、`llmThreshold = 0.8`：单条弱命中先送审，两条叠加或一条强命中直接处置。
 */

/**
 * 默认规则。两条约定：
 * - `id` 用固定字符串：重建配置时不会产生新 id，历史信号仍能还原出规则。
 * - `pattern` 一律按**归一化后**的形态书写：`normalize` 会把「加v」改写成「加微信」，
 *   按原始写法写规则会永远匹配不上。新增规则前先本地跑一遍 `normalize`。
 */
const DEFAULT_RULES: readonly Rule[] = [
  { id: 'default-ad-wechat', kind: 'keyword', pattern: '加微信', score: 0.4, actionHint: 'delete', enabled: true },
  { id: 'default-ad-private', kind: 'keyword', pattern: '需要的私聊', score: 0.4, actionHint: 'delete', enabled: true },
  { id: 'default-ad-sale', kind: 'keyword', pattern: '低价出售', score: 0.4, actionHint: 'delete', enabled: true },
  { id: 'default-scam-rebate', kind: 'keyword', pattern: '刷单', score: 0.5, actionHint: 'mute', enabled: true },
  { id: 'default-scam-daily-pay', kind: 'keyword', pattern: '日结', score: 0.5, actionHint: 'mute', enabled: true },
  { id: 'default-scam-gamble', kind: 'keyword', pattern: '带单', score: 0.5, actionHint: 'mute', enabled: true },
  { id: 'default-link-telegram', kind: 'link-domain', pattern: 't.me', score: 0.4, actionHint: 'delete', enabled: true },
  { id: 'default-link-shortener', kind: 'link-domain', pattern: 'bit.ly', score: 0.5, actionHint: 'delete', enabled: true },
]

/** 默认禁言时长（分钟）。一小时足够让刷屏者停下，又不至于误伤后长时间无法发言。 */
const DEFAULT_MUTE_DURATION_MINUTES = 60

/**
 * 构造未登记群的默认配置。
 *
 * @param chatId 群标识。
 * @param title 群标题（Telegram update 里的当前标题）。
 * @param language 群语言，决定复核提示词与理由语种。
 * @returns 可直接 `upsert` 的配置。
 */
export function defaultChatConfig(chatId: ChatId, title: string, language: ChatConfig['language']): ChatConfig {
  return {
    chatId,
    title,
    language,
    // 复制一份：默认规则是模块级常量，不随调用方的改动漂移。
    rules: DEFAULT_RULES.map((rule) => ({ ...rule })),
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: DEFAULT_MUTE_DURATION_MINUTES,
  }
}
