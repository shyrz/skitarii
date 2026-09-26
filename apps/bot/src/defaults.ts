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
 *   按原始写法写规则会永远匹配不上。新增规则前先本地跑一遍 `normalize`（身份同样会被归一化）。
 *
 * 名字信号与来源工具的差异：n8n 工作流对可疑名字（Cyrillic/Arabic/中文广告词、用户名含 USDT）
 * 是命中即封，误杀面过大；这里只作 0.4 的计分信号，单条命中落在灰色地带，由 LLM 结合上下文判。
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
  {
    id: 'default-name-ad',
    kind: 'sender-name',
    pattern: '助手|速查|客服|空投|红包|内幕|主页|点我|资料|转账|返利|稳赚|必赢|带单',
    score: 0.4,
    actionHint: 'delete',
    enabled: true,
  },
  { id: 'default-name-crypto', kind: 'sender-name', pattern: 'usdt|usdc', score: 0.4, actionHint: 'delete', enabled: true },
  // 自定义表情堆砌。来源工具的实测阈值是 >5，这里取 6 作最小计数；单条命中 0.4，落在灰色地带。
  {
    id: 'default-emoji-burst',
    kind: 'custom-emoji',
    pattern: '6',
    score: 0.4,
    actionHint: 'delete',
    enabled: true,
  },
  // 表情总数（Unicode 表情 + 自定义表情）。阈值与 custom-emoji 一致：≥6 个自定义表情会同时命中
  // 两条规则（合计 0.8 直接处置），这是有意的语义收紧；普通 Unicode 表情墙在规则层此前完全隐形。
  {
    id: 'default-emoji-flood',
    kind: 'emoji-count',
    pattern: '6',
    score: 0.4,
    actionHint: 'delete',
    enabled: true,
  },
  // 经内联机器人发送（`via_bot` 存在）。inline bot 广告的正文通常是一屏表情或按钮，
  // 按钮 URL 不落正文、规则看不见；via-bot 信号与表情计数叠加后覆盖这条路径。
  // pattern 不使用，按约定留空串。单条命中 0.4，普通 @gif 使用落在灰色地带交复核判。
  {
    id: 'default-inline-bot',
    kind: 'via-bot',
    pattern: '',
    score: 0.4,
    actionHint: 'delete',
    enabled: true,
  },
  // 私有邀请链接比通用 t.me 域名（default-link-telegram）强得多：两条规则叠加命中 0.8 直接处置；
  // 该规则自身只贡献 0.4，单独命中（链接特征缺失时）仍落在灰色地带。
  {
    id: 'default-link-private-invite',
    kind: 'regex',
    pattern: String.raw`t\.me/\+[a-z0-9_-]{16}`,
    score: 0.4,
    actionHint: 'delete',
    enabled: true,
  },
  // bot 拉人头模式：`/start <推荐码> @xxxbot`。命中 0.5，单独落在灰色地带。
  {
    id: 'default-bot-referral',
    kind: 'regex',
    pattern: '/start [a-z0-9_-]+ @[a-z0-9_]*bot',
    score: 0.5,
    actionHint: 'delete',
    enabled: true,
  },
]

/** 默认禁言时长（分钟）。一小时足够让刷屏者停下，又不至于误伤后长时间无法发言。 */
const DEFAULT_MUTE_DURATION_MINUTES = 60

/**
 * 构造未登记群的默认配置。
 *
 * @param chatId 群/频道标识。
 * @param title 群标题（Telegram update 里的当前标题）。
 * @param language 群语言，决定复核提示词与理由语种。
 * @param chatType 聊天类型，来自 update 的 `chat.type`（不从发送者推断）。
 * @param linkedChatId Telegram 的 linked chat（频道 ↔ 讨论组）；未探测到时为 `null`。
 * @returns 可直接 `register` / `upsert` 的配置。
 */
export function defaultChatConfig(
  chatId: ChatId,
  title: string,
  language: ChatConfig['language'],
  chatType: ChatConfig['chatType'],
  linkedChatId: ChatId | null = null,
): ChatConfig {
  return {
    chatId,
    title,
    chatType,
    linkedChatId,
    language,
    // 复制一份：默认规则是模块级常量，不随调用方的改动漂移。
    rules: DEFAULT_RULES.map((rule) => ({ ...rule })),
    // 信任名单默认空：新群先按规则审，误伤多了再手工加人。
    whitelist: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: DEFAULT_MUTE_DURATION_MINUTES,
  }
}
