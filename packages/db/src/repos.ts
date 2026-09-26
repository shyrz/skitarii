import type {
  Appeal,
  AppealState,
  ChatConfig,
  ChatId,
  ChatType,
  DailyAggregate,
  MessageEvent,
  ModerationDecision,
  Rule,
  RuleAction,
  Subscription,
  SubscriptionLink,
  SubscriptionMember,
  SubscriptionMemberEvidence,
  SubscriptionMemberState,
  SubscriptionOperationKind,
  UserId,
} from '@skitarii/core'
import type { LlmCacheEntry, LlmCacheInsert } from './schema.js'

/**
 * 仓储接口。本文件只固定调用面，PG 实现见 `pg-repos.ts`（`createPgRepos`），测试与本地跑批可换内存实现。
 *
 * 约定：
 * - 接口只讲领域类型（`@skitarii/core`），不暴露 drizzle 行类型；JSONB 列（规则集、信号）的解析与
 *   `ChatId` / `UserId` 的品牌构造都发生在实现内部的边界处。
 * - 行类型与领域类型的对齐是编译期强制的：实现里把行映射成领域对象时，任何枚举取值或字段类型
 *   与领域不一致都会直接编译失败，因此这里不额外维护重复的列类型。
 * - 方法的粒度为「一次业务动作一条语句」，调用方不拼 SQL，也不在 app 层做多表事务编排。
 * - 写入路径全部参数化（drizzle 的列值与条件都进占位符），任何用户可控文本都不拼进 SQL 字面量。
 *
 * 相对随包一起落地的接口，Phase 1 管线需要补了少量方法（`findById` / `attachSample` / `findWithSample` /
 * `findByDecisionId` / `countForDay` / `deleteOlderThan`）与一个参数（`resolve` 的结案人）：
 * 管线要读单条决策才能回滚、要在非放行处置后补写正文摘录、要按天在 SQL 侧做聚合、要按保留期清理。
 * 这些都不改 `@skitarii/core` 的类型与函数签名。
 */

/** 群配置可单独刷新的元数据。字段缺省表示「保持原值」，只影响本对象里出现的列。 */
export interface ChatMetadataPatch {
  title?: string
  chatType?: ChatType
  /** `null` 表示明确清空（如链接被解除）；缺省表示不改。 */
  linkedChatId?: ChatId | null
}

/**
 * 面板 PUT 用的规则/阈值补丁。
 * 只能改规则与阈值：标题、类型、linked 关系与语言由登记/刷新路径维护，不能被面板写回旧值。
 */
export interface ChatRulesPatch {
  rules: Rule[]
  passThreshold: number
  llmThreshold: number
  muteDurationMinutes: number
}

/** 群配置读写。 */
export interface ChatRepo {
  /** 按 `chatId` 覆盖写入配置（owner 在面板里的显式全量保存）。 */
  upsert(config: ChatConfig): Promise<void>
  /**
   * 首次登记：插入一条新配置；`chatId` 已存在时**什么都不做**。
   *
   * 「什么都不做」是硬语义：登记可能发生在 bot 被拉进群、收到频道帖或新群第一条消息时，
   * 而 owner 可能正在面板里改同一行的规则。不能用一份刚构造的默认配置去覆盖已经保存的规则，
   * 因此登记路径与 `upsert` 分开，冲突时以库里的行为准（调用方随后重读即可）。
   */
  register(config: ChatConfig): Promise<void>
  /** 未登记时返回 `null`，由调用方决定是否用默认配置注册。 */
  findByChatId(chatId: ChatId): Promise<ChatConfig | null>
  /**
   * 只更新元数据列（title / chatType / linkedChatId），其余字段（规则、阈值、语言）原样保留。
   *
   * 这是 title / type / linkedId 刷新路径的唯一入口：日常的登记刷新可能与 owner 的规则保存并发，
   * 用全量 `upsert` 会把调用方内存里的旧规则覆盖回去，因此元数据更新必须收敛到这条单列 UPDATE。
   * 目标行不存在时静默无操作（登记由 `register` 负责）。
   */
  updateMetadata(chatId: ChatId, patch: ChatMetadataPatch): Promise<void>
  /**
   * 只更新规则与阈值（面板 PUT 专用），不改 title / chatType / linkedChatId / language。
   *
   * 面板保存与 bot 的元数据刷新可能并发：面板读到的行可能已带旧元数据，若走全量写会把并发刷新
   * 回退。规则侧走这条单列 UPDATE 后，两条写路径互不覆盖（各写各的列）。
   */
  updateRulesConfig(chatId: ChatId, patch: ChatRulesPatch): Promise<void>
  /** 遍历所有群配置，供调度器与报表使用。 */
  listAll(): Promise<ChatConfig[]>
  /**
   * 频道的稳定分页：`chatType = 'channel'`，按 `chat_id` 固定 C 排序 ASC，`afterChatId` 为严格下界。
   * 订阅页的频道列表用它，不复用 `listAll` 后在应用层切片。
   */
  listChannelsPage(input: { afterChatId?: ChatId; limit: number }): Promise<ChatConfig[]>
}

/** 消息事件写入与保留期清理。 */
export interface MessageEventRepo {
  /**
   * 追加一条事件。同一 `id` 重复写入被忽略（幂等重放）。
   *
   * 调用方应使用由 `(chatId, messageId)` 派生的确定性 id（见 apps/bot 的 `deriveEventId`），
   * 这样 Telegram 重投递同一 update 时不会产生重复事件，后续决策与动作的幂等键也才有稳定来源。
   */
  insert(event: MessageEvent): Promise<void>
  /** 读取事件与它的正文摘录（可能为 `null`），供申诉页面回显处置对象。 */
  findWithSample(eventId: string): Promise<{ event: MessageEvent; sampleText: string | null } | null>
  /**
   * 批量读取多条事件的正文摘录（面板的处置队列与申诉队列共用）。
   *
   * 一条 `IN` 查询而不是逐条 `findWithSample`：面板一页几十条、跨群，逐条查就是 N+1。
   * 返回的 Map 只包含库里存在的事件；已被保留期清理的 id 不在 Map 里，调用方按 `null` 处理。
   *
   * @param eventIds 事件 id 列表；空数组直接返回空 Map，不发查询。
   */
  findSamples(eventIds: string[]): Promise<Map<string, string | null>>
  /**
   * 补写正文摘录。
   *
   * 实现必须保证「仅当该事件存在非 pass 决策时」才写入：这是隐私口径的落点，
   * 因此调用方要先落决策再调本方法（顺序由实现以 SQL 条件强制，写错顺序是静默无操作，不会写入放行消息的正文）。
   * 超长文本由实现按 `SAMPLE_TEXT_MAX_LENGTH` 截断。
   */
  attachSample(eventId: string, sampleText: string): Promise<void>
  /** 保留期清理：删除 `createdAt` 早于 `instant` 的事件，返回删除条数。 */
  deleteOlderThan(instant: Date): Promise<number>
}

/** 决策读写。 */
export interface DecisionRepo {
  /** 追加一条决策。同一 `id` 重复写入被忽略（幂等重放）。 */
  insert(decision: ModerationDecision): Promise<void>
  /** 按 id 读取。申诉回滚与崩溃补偿都需要它。 */
  findById(decisionId: string): Promise<ModerationDecision | null>
  /** 动作施加到 Telegram 后回填，崩溃恢复时据此找出未执行的决策。 */
  markExecuted(decisionId: string): Promise<void>
  /**
   * 未执行决策的补偿扫描输入：`executed = false` 且 `decidedAt` 落在 `[from, to)`，按判定时间升序、最多 `limit` 条。
   *
   * 上界（`to`）排除刚判定、可能正在执行的决策；下界（`from`）是重试窗口：一个永远失败的动作
   * （bot 被移出群）不该长期占住扫描额度，把新产生的未执行决策挤在后面。
   */
  listUnexecutedBetween(from: Date, to: Date, limit: number): Promise<ModerationDecision[]>
  /**
   * 跨群处置流（面板「处置」页）：`(decidedAt, id)` 倒序 + 复合游标分页。
   *
   * 过滤语义：
   * - `chatId` 缺省表示全部群；
   * - `action` 缺省表示「非放行」（`action != 'pass'`），`'all'` 表示不过滤，具体档位表示只取该档位；
   * - `before` 是复合游标：只取严格排在 `(before.decidedAt, before.id)` 之前的记录（首页不传）。
   *   时间戳单列在同毫秒并列时会漏条，因此用与排序键一致的 `id` 补全序。
   *
   * 排序与 limit 都写进 SQL：面板是跨群查询，不能在应用层拉全量再切片。
   */
  listRecent(filter: {
    chatId?: ChatId
    action?: 'all' | RuleAction
    before?: { decidedAt: Date; id: string }
    limit: number
  }): Promise<ModerationDecision[]>
  /**
   * 累犯加重的输入：该用户在该群、`since` 之后被判违规的决策数。
   * 放行决策不计入（`action = 'pass'` 被排除），否则正常发言会稀释前科。
   *
   * @param since 统计起点，通常取当前时间往前若干天；调用方负责决定「多久算一次前科」。
   */
  countPriorViolations(chatId: ChatId, userId: UserId, since: Date): Promise<number>
  /**
   * 记录处置通知的落点，供申诉生命周期编辑：提交申诉时改成「等待复核」、结案时改成终态，
   * 两处都要去掉申诉按钮。
   *
   * @param chatId 私聊优先时的用户 id，或回退群内时的群 id（字符串形态）。
   * @param messageId `sendMessage` 返回的消息 id。
   */
  markNoticeSent(decisionId: string, chatId: string, messageId: number): Promise<void>
  /**
   * 读取处置通知引用。
   *
   * @returns 记录过的落点；通知没发出去、记录失败或旧数据时为 `null`（编辑侧跳过，不报错）。
   */
  findNoticeRef(decisionId: string): Promise<{ chatId: string; messageId: number } | null>
}

/** 一条误伤样本：申诉撤销结案后回写给判定链路的记录。 */
export interface OverturnedSample {
  /** 被处置用户（原决策的当事人）。 */
  userId: UserId
  /** 原消息的内容哈希：内容白名单按「同人 + 同哈希」匹配。 */
  contentHash: string
  /** 原消息的正文摘录；撤销处置时若没有摘录（纯媒体等）为 `null`，few-shot 侧跳过。 */
  sampleText: string | null
  /** 结案时刻：白名单的 30 天窗口用它判定。 */
  resolvedAt: Date
}

/** 申诉读写。 */
export interface AppealRepo {
  /** 追加一条申诉。同一 `decisionId` 重复插入被忽略（数据库层唯一约束，见 `appeals_decision_unique`）。 */
  insert(appeal: Appeal): Promise<void>
  findById(appealId: string): Promise<Appeal | null>
  /** 按决策读取。Mini App 的「一条处置至多一次申诉」与重复提交的判定都靠它。 */
  findByDecisionId(decisionId: string): Promise<Appeal | null>
  /**
   * 结案。状态参数用 `Exclude` 排除了 `open`：结案不能把状态退回未处理。
   * 只对仍处于 `open` 的记录生效（条件写在 SQL 的 WHERE 里），因此重复点击不会翻转已结案的结论。
   *
   * `rollbackPending` 与状态在**同一条 UPDATE** 里写入：撤销结案时置 `true`，让「已结案但权限未回滚」
   * 的窗口在数据库中可见；维持或不撤销时写 `false`。原子性由这一条语句保证，调用方不需要补写。
   *
   * @param resolvedBy 结案人（Phase 1 恒为 owner）。
   * @param rollbackPending 结案后是否还有权限需要回滚（仅 `overturn` 为 `true`）。
   * @returns 本次调用是否真的结了案：实际影响行数为 0（并发重复点击、记录已结案）时为 `false`。
   *   调用方据此决定是否回滚权限与回复「已撤销」，而不是把别人的结案再演一遍。
   */
  resolve(
    appealId: string,
    state: Exclude<AppealState, 'open'>,
    resolvedAt: Date,
    resolvedBy: UserId,
    rollbackPending: boolean,
  ): Promise<boolean>
  /** 清除「待回滚」标记。回滚成功或决策缺失时调用；无条件写 `false`，重复调用幂等。 */
  clearRollbackPending(appealId: string): Promise<void>
  /**
   * 回滚补偿扫描的输入：`state = 'overturned'` 且 `rollback_pending = true` 的申诉，
   * 按结案时间升序（先结案的先补），最多 `limit` 条。未清标记的记录会一直留在候选集里，必须有上界。
   */
  listPendingRollback(limit: number): Promise<Appeal[]>
  /**
   * 误伤样本回写的数据源：某群 `since` 之后撤销结案的申诉，带原消息的正文摘录，按结案时间倒序。
   *
   * 一条 join（appeals → moderation_decisions → message_events）而不是分步查询：它在消息判定路径上，
   * 每多一次往返都是延迟。返回全部行（含 `sampleText` 为 `null` 的）：内容白名单只看 hash，
   * few-shot 侧自行过滤非空。
   *
   * 行里带 `resolvedAt`：内容白名单的有效期（30 天）比 few-shot 窗口（90 天）短，
   * 调用方要用它做二次判定，单查一次数据必须带上结案时刻。
   *
   * @param since 结案时间下界。
   * @param limit 单次上限，调用方负责给一个有限值。
   */
  listOverturnedSamples(chatId: ChatId, since: Date, limit: number): Promise<OverturnedSample[]>
  /** 某群的待处理申诉，按创建时间升序。 */
  listOpen(chatId: ChatId): Promise<Appeal[]>
  /**
   * 面板申诉队列：按创建时间倒序取一组申诉与它们的决策（单条 join，禁止逐条回查）。
   *
   * @param state `null` 表示全部状态；否则只取该状态。
   * @param limit 单页上限，调用方负责 clamp。
   */
  listByStateWithDecision(
    state: AppealState | null,
    limit: number,
  ): Promise<{ appeal: Appeal; decision: ModerationDecision }[]>
  /**
   * 回填 owner 通知时刻：`notified_at` 只表示「Telegram 接受了那条私聊」，
   * 不参与申诉状态机。调度器据此找出「已提交但还没通知成功」的申诉补发。
   *
   * @param notifiedAt 通知被接受（或补发成功）的时刻。
   */
  markNotified(appealId: string, notifiedAt: Date): Promise<void>
  /**
   * 补发扫描的输入：`state = 'open'` 且 `notified_at is null` 的申诉，按创建时间升序、最多 `limit` 条。
   * 未通知的申诉在人工处理前一直留在结果里，因此必须有上界，避免一次维护把整表拉出来。
   */
  listPendingNotification(limit: number): Promise<Appeal[]>
}

/** 订阅读写。 */
export interface SubscriptionRepo {
  insert(subscription: Subscription): Promise<void>
  /** 撤销：状态置 `revoked`。已过期的记录不需要撤销。 */
  revoke(subscriptionId: string): Promise<void>
  listActive(chatId: ChatId): Promise<Subscription[]>
  /** 到期清理任务的输入：`expiresAt` 早于 `instant` 且仍为 active 的记录。 */
  listExpiringBefore(instant: Date): Promise<Subscription[]>
}

/* ---- Phase 3b：订阅链接与成员台账 ---- */

/** 创建请求的持久占位输入。`requestHash` 是原始创建请求的规范化摘要，改名不改它。 */
export interface ReserveCreateInput {
  id: string
  chatId: ChatId
  ownerUserId: UserId
  requestId: string
  requestHash: string
  name: string
  priceStars: number
  periodSeconds: number
  createdAt: Date
}

/** `reserveCreate` 结果：`reserved` 表示本次插入成功（调用者有权发外部创建）；`existing` 返回原行。 */
export type ReserveCreateOutcome = { kind: 'reserved' | 'existing'; link: SubscriptionLink }

/** `finishCreate` 的成功输入：Telegram 返回的完整链接。 */
export interface CreateFinishResult {
  inviteLink: string
  finishedAt: Date
}

/** 链接变更 claim 的结果。`conflict` 区分版本不匹配与已有活跃操作。 */
export type ClaimResult =
  | { kind: 'claimed'; token: string; link: SubscriptionLink }
  | { kind: 'missing' }
  | { kind: 'revoked' }
  | { kind: 'conflict'; reason: 'version' | 'in_progress' }

/** `finishMutation` 的结果：改名或撤销。 */
export type LinkMutationResult =
  | { kind: 'renamed'; name: string }
  | { kind: 'revoked'; revokedAt: Date }

/** 链接读写。条件写全部落在单条 SQL 上，不靠进程内互斥保证正确性。 */
export interface SubscriptionLinkRepo {
  /** 插入创建占位；`(ownerUserId, requestId)` 冲突时返回原行（insert-on-conflict 返回语义）。 */
  reserveCreate(input: ReserveCreateInput): Promise<ReserveCreateOutcome>
  /** 按幂等键读取（重放与冲突判定用；不要求仍有 Telegram 权限）。 */
  findByRequestId(ownerUserId: UserId, requestId: string): Promise<SubscriptionLink | null>
  /** creating/create_unknown → active；返回是否真的写入。 */
  finishCreate(id: string, result: CreateFinishResult): Promise<boolean>
  /** 明确失败或结果不确定时落状态；只从 `creating` 迁移。 */
  markCreateOutcome(id: string, state: 'create_unknown' | 'create_failed', changedAt: Date): Promise<void>
  findById(chatId: ChatId, id: string): Promise<SubscriptionLink | null>
  /** 完整链接精确匹配（成员来源关联用）。 */
  findByInviteLink(chatId: ChatId, fullLink: string): Promise<SubscriptionLink | null>
  /**
   * 分页：`(createdAt, id)` 倒序，`before` 为严格元组上界。
   * 调用方传 `limit + 1` 以判断是否还有下一页。
   */
  listPage(input: { chatId: ChatId; before?: { createdAt: Date; id: string }; limit: number }): Promise<SubscriptionLink[]>
  /**
   * 原子占位一次改名/撤销：仅 `state = 'active'`、版本匹配且无未过期占位时可 claim。
   * 占位超过 60 秒可被新 token 替换；版本不匹配与占位冲突都返回 `conflict`。
   */
  claimMutation(
    chatId: ChatId,
    id: string,
    expectedVersion: number,
    kind: SubscriptionOperationKind,
    now: Date,
  ): Promise<ClaimResult>
  /**
   * 提交操作结果：必须持有同一 token 且行仍为 `active`。
   * revoked 是终态：迟到的 rename 结果不能复活它。
   */
  finishMutation(id: string, operationToken: string, result: LinkMutationResult, finishedAt: Date): Promise<boolean>
  /** 释放未提交的占位（外部调用失败/不确定后允许立即重试）。 */
  releaseMutation(id: string, operationToken: string): Promise<void>
}

/** 成员事件观测：由 bot 的 `chat_member` 处理器构造。 */
export interface MemberEventObservation {
  chatId: ChatId
  userId: UserId
  state: SubscriptionMemberState
  expiresAt: Date | null
  /** 本次观测到的肯定证据；`null` 表示保留历史证据，且不插入新行（无行时 applyEvent 返回 ignored）。 */
  evidence: SubscriptionMemberEvidence | null
  /** 本次可关联的链接；`isJoin` 为真且无匹配时必须写 null（不把旧来源当本轮来源）。 */
  linkId: string | null
  /** 是否明确发生新一轮加入（旧状态为 left/kicked，或事件带 invite_link）。 */
  isJoin: boolean
  /** Telegram 秒级事件时间与 update id，用于高水位比较。 */
  eventDate: number
  eventUpdateId: number
  observedAt: Date
}

/** 对账 claim：token + 捕获取时的事实 version + 查询开始时刻。 */
export interface CheckClaim {
  memberId: string
  chatId: ChatId
  userId: UserId
  token: string
  version: number
  requestStartedAt: Date
}

/** 对账结果：成功事实或受控错误码。 */
export type CheckResult =
  | { kind: 'ok'; state: SubscriptionMemberState; expiresAt: Date | null; returnedAt: Date }
  | { kind: 'failed'; errorCode: string; checkedAt: Date }

/** 成员台账读写。 */
export interface SubscriptionMemberRepo {
  find(chatId: ChatId, userId: UserId): Promise<SubscriptionMember | null>
  /**
   * 以 `(eventDate, eventUpdateId)` 高水位条件写事实；更旧/重复事件返回 `ignored`。
   * 事件所在秒不晚于 `reconciledThrough` 时只推进高水位与 version，不改事实。
   */
  applyEvent(observation: MemberEventObservation): Promise<'inserted' | 'updated' | 'ignored'>
  /** 分页：不可变 `(firstObservedAt, id)` 倒序；调用方传 `limit + 1`。 */
  listPage(input: {
    chatId: ChatId
    before?: { firstObservedAt: Date; id: string }
    limit: number
  }): Promise<SubscriptionMember[]>
  /** SQL 侧聚合的计数；`known` 为三状态之和，独立于分页。 */
  countByState(chatId: ChatId): Promise<{ known: number; member: number; left: number; unknown: number }>
  /**
   * 公平 claim 一批待对账成员：`lastCheckedAt ASC NULLS FIRST, id ASC`，跳过未过期租约，
   * 原子推进 `lastCheckedAt` 并写入 token（不递增事实 version）。
   */
  claimChecks(input: { now: Date; limit: number; leaseMs: number }): Promise<CheckClaim[]>
  /** 提交对账结果：仅 token 匹配且 version 未变时应用；失败不改成员事实。 */
  finishCheck(claim: CheckClaim, result: CheckResult): Promise<'applied' | 'stale'>
}

/** 某群某天四个计数的组合，供调度器拼成 `DailyAggregate`。 */
export type DailyCounts = Omit<DailyAggregate, 'chatId' | 'date'>

/** 日聚合读写。 */
export interface AggregateRepo {
  /** 覆盖写入某群某天的聚合，供重算任务幂等重跑。 */
  upsert(aggregate: DailyAggregate): Promise<void>
  /**
   * 报表区间查询。
   *
   * @param from YYYY-MM-DD，闭区间起点
   * @param to YYYY-MM-DD，闭区间终点
   */
  listRange(chatId: ChatId, from: string, to: string): Promise<DailyAggregate[]>
  /**
   * 在 SQL 侧数出某群某时间窗内的四个计数（不在应用层拉明细再统计，避免无边界查询）。
   *
   * 口径：
   * - `messageCount`：窗口内落库的消息事件数。
   * - `actionCount`：窗口内判定的非放行决策数。
   * - `appealCount`：窗口内提交的申诉数（按申诉创建时间归属，与决策时间无关）。
   * - `overturnedCount`：窗口内结案且被撤销的申诉数（按结案时间归属，这样误伤率与处置同期可见）。
   *
   * @param from 窗口起点（含）。
   * @param to 窗口终点（不含）。
   */
  countForDay(chatId: ChatId, from: Date, to: Date): Promise<DailyCounts>
}

/** 复核缓存读写。 */
export interface LlmCacheRepo {
  get(contentHash: string): Promise<LlmCacheEntry | null>
  /** 已存在同一 `contentHash` 时保留先写入的结论：同一条文本的判定应当稳定，换模型靠保留期清理失效。 */
  put(entry: LlmCacheInsert): Promise<void>
  /** 保留期清理：删除创建时间早于 `instant` 的缓存条目，返回删除条数。 */
  deleteOlderThan(instant: Date): Promise<number>
}

/** 仓储聚合。管线的依赖注入点：测试与本地跑批可以换成内存实现。 */
export interface Repos {
  chats: ChatRepo
  events: MessageEventRepo
  decisions: DecisionRepo
  appeals: AppealRepo
  subscriptions: SubscriptionRepo
  /** Phase 3b 新台账：订阅链接。 */
  subscriptionLinks: SubscriptionLinkRepo
  /** Phase 3b 新台账：成员。 */
  subscriptionMembers: SubscriptionMemberRepo
  aggregates: AggregateRepo
  llmCache: LlmCacheRepo
}
