import { asChatId, asUserId, type UserId } from '@skitarii/core'
import type { Repos } from '@skitarii/db'
import { createCachedJudge, createOpenAiJudge, type LlmConfig } from '@skitarii/llm'
import { Bot, type Context, type PollingOptions } from 'grammy'
import type { Message, Update } from 'grammy/types'
import {
  APPEAL_CALLBACK_PATTERN,
  createAppealCallbackHandler,
  createAppealNotificationService,
  createAppealRollbackService,
  type AppealDeps,
  type AppealNotificationService,
  type AppealRollbackService,
} from './appeal.js'
import { createChatMetadataService } from './chat-metadata.js'
import { createDecisionRetryService, type DecisionRetryService } from './decision-retry.js'
import { createActionExecutor } from './executor.js'
import { contentHashOf, extractFeatures, extractSenderIdentity } from './features.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createLogger, type Logger } from './logger.js'
import { createOwnerFailureNotifier, createOwnerFeed } from './owner-feed.js'
import { handleIncomingMessage, type PipelineDeps } from './pipeline.js'
import { createSubscriptionMemberRecorder } from './subscription-members.js'
import { createTokenBucket } from './token-bucket.js'

/**
 * bot 组装。
 *
 * 本模块是 bot 的公开入口（`@skitarii/bot` 的 package entry）：`createBot` 返回一个配好中间件的
 * `Bot` 实例，调用方决定怎么驱动它：`src/index.ts` 用长轮询跑开发实例，
 * apps/server 用 `webhookCallback` 把它挂到 `/telegram/webhook`。
 *
 * 因此这里不做任何进程级副作用：不读环境变量、不建数据库连接、不 `start()`。
 *
 * 公开面同时提供 server 侧需要的运行时零件：`notifyOwnerOfAppeal`（申诉创建后私聊 owner）、
 * `resolveAppeal`（面板内结案，与回调按钮共用同一套权限回滚口径）与 `createLogger`（两个进程共用同一套日志出口）；
 * `createBotRuntime` 另外交出三条补偿扫描（决策执行、申诉通知、权限回滚）。
 *
 * 需要补偿扫描的调用方用 {@link createBotRuntime}：它把 bot 与三个维护服务一起交出来，
 * 三者共享同一份执行器与幂等闸门（这是补偿不重复施加动作的前提）。
 */

export { createLogger } from './logger.js'
export type { Logger } from './logger.js'
export {
  notifyOwnerOfAppeal,
  resolveAppeal,
  updateDecisionNotice,
  noticeStageText,
  createAppealNotificationService,
  createAppealRollbackService,
  APPEAL_CALLBACK_PATTERN,
} from './appeal.js'
export type {
  AppealDeps,
  AppealNoticeStage,
  AppealNotification,
  AppealNotificationService,
  AppealNotifyResult,
  AppealResolution,
  AppealRollbackResult,
  AppealRollbackService,
} from './appeal.js'
export { createDecisionRetryService, DECISION_RETRY_SCAN_LIMIT, STALE_DECISION_AGE_MS } from './decision-retry.js'
export type { DecisionRetryResult, DecisionRetryService } from './decision-retry.js'

/** 允许的更新类型名。与 Telegram `Update` 的键一致，`update_id` 不是可订阅的更新类型。 */
export type AllowedUpdate = Exclude<keyof Update, 'update_id'>

/**
 * 允许的更新类型。webhook 注册（`setWebhook`）与长轮询（`bot.start`）共用这一份，
 * 两个入口不允许各写一份名单，否则会悄悄漏收某种更新。
 *
 * 只列确有处理器的类型：`message` / `edited_message` 走审核管线，`callback_query` 走申诉回调，
 * `channel_post` 登记频道元数据，`my_chat_member` 跟踪 bot 自己加入/升管理员，
 * `chat_member` 驱动订阅成员台账（只读事实，不做权限处置）。
 * 不处理也不订阅 `edited_channel_post` 等其他类型，它们没有处理器，只会多几跳流量。
 */
export const TELEGRAM_ALLOWED_UPDATES: readonly AllowedUpdate[] = [
  'message',
  'edited_message',
  'callback_query',
  'channel_post',
  'my_chat_member',
  'chat_member',
] as const

/**
 * 长轮询启动选项。抽成函数是为了让「与 webhook 同源」可被测试直接断言，而不是只写在入口文件里。
 *
 * @returns 传给 `bot.start` 的选项片段（`onStart` 等由调用方补全）。
 */
export function pollingStartOptions(): Pick<PollingOptions, 'allowed_updates'> {
  return { allowed_updates: TELEGRAM_ALLOWED_UPDATES }
}

/** `createBot` 的入参。 */
export interface CreateBotOptions {
  botToken: string
  /** 仓储聚合（由调用方建好，server 侧还要用它读申诉）。 */
  repos: Repos
  /** LLM 连接配置。`null` 表示未配置：灰色地带退化为「待复核」，审核不停摆。 */
  llm: LlmConfig | null
  /** Mini App 对外地址，用于组装申诉按钮。 */
  miniAppUrl: string
  /** 申诉处理的唯一负责人：只有这个用户能点「维持 / 撤销」。 */
  ownerUserId: UserId
  /**
   * owner 判定 feed 开关。测试期默认开启：每条过审消息（含放行）私聊 owner 一条判定摘要；
   * 显式传 `false` 关闭（对应 `OWNER_DEBUG_NOTIFY=false`）。
   */
  ownerFeed?: boolean
  logger?: Logger
  /** 时间源，默认系统时间。 */
  now?: (() => Date) | undefined
  /** 429 退避的 sleep，测试可注入。 */
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/** bot 运行时：bot 实例与三个维护服务共用同一份执行器。 */
export interface BotRuntime {
  bot: Bot
  /**
   * 未执行决策的补偿扫描。与 bot 共用同一个 `ActionExecutor`（幂等闸门、限流桶），
   * 由 apps/server 的调度器在维护任务里调用。
   */
  retryDecisions: DecisionRetryService
  /** owner 通知的补发扫描（`open && notified_at is null`），同样由调度器调用。 */
  resendAppeals: AppealNotificationService
  /** 撤销结案后权限未回滚的补偿扫描（`overturned && rollback_pending`），同样由调度器调用。 */
  retryRollbacks: AppealRollbackService
}

/**
 * Telegram 官方服务账号的用户 id（777000）。
 *
 * 频道自动转发到讨论组的消息以它作为发送者：内容来自频道帖子本身，审核它既没有意义也删不掉原帖，
 * 因此在新消息与编辑消息的处理入口一并过滤（来源 n8n 工作流同样排除该账号）。
 */
const TELEGRAM_SERVICE_ACCOUNT_ID = 777_000

/**
 * 建立 bot 运行时。webhook 与补偿扫描都要用 bot 的进程，因此这里一次性把两者组装出来。
 *
 * @param options bot token、仓储、复核配置与运行参数。
 * @returns bot 实例与三个维护服务。
 */
export function createBotRuntime(options: CreateBotOptions): BotRuntime {
  const logger = options.logger ?? createLogger('bot')
  const bot = new Bot(options.botToken)

  const judge =
    options.llm === null
      ? null
      : createCachedJudge({ judge: createOpenAiJudge(options.llm), cache: options.repos.llmCache })

  // 幂等闸门与限流桶只建一份：补偿扫描必须与管线共用它们，否则「本进程已施加动作、回填还没落库」
  // 的决策会被再施加一次（二次禁言会把解禁时刻重置）。
  const idempotency = createIdempotencyRegistry()
  const executor = createActionExecutor({
    api: bot.api,
    repos: options.repos,
    idempotency,
    outbound: createTokenBucket(),
    miniAppUrl: options.miniAppUrl,
    logger,
    now: options.now,
    sleep: options.sleep,
    // 终结性拒绝后补偿扫描不会再接这条决策，私聊 owner 让失败有人看见。
    notifyOwnerFailure: createOwnerFailureNotifier({ api: bot.api, ownerUserId: options.ownerUserId, logger }),
  })

  const pipelineDeps: PipelineDeps = {
    repos: options.repos,
    judge,
    executor,
    logger,
    now: options.now,
    // 判定 feed 默认开启：测试期 owner 要逐条核对判定结果，显式 false 才关闭。
    notifyOwner:
      options.ownerFeed === false
        ? undefined
        : createOwnerFeed({ api: bot.api, ownerUserId: options.ownerUserId, logger, now: options.now }),
  }

  const chatMetadata = createChatMetadataService({
    api: bot.api,
    repos: options.repos,
    logger,
    now: options.now,
  })

  const subscriptionMembers = createSubscriptionMemberRecorder({
    repos: options.repos,
    logger,
    now: options.now,
  })

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        '这个是群组消息审核机器人。',
        '把它加入群或频道并授予删除消息、封禁用户的权限后开始工作。',
        '被误判的消息会附带申诉按钮，处理结果在 Mini App 里可见。',
      ].join('\n'),
    )
  })

  /**
   * 审核一条群消息：过滤、提取、提交管线。新消息与编辑消息共用同一个入口，避免两份过滤逻辑漂移。
   *
   * 只审群与超级群：私聊是命令与申诉通知的通道，频道消息（`channel_post`）不属于本节。
   * 其他 bot 的消息不审：既避免 bot 互相触发，也避免把审核结果反馈给自动化流程。
   * 频道自动转发到讨论组的根帖（`is_automatic_forward`）不审：它是频道帖子的镜像，
   * 处置它删不掉原帖，且发送者可能是真实管理员，按普通发言审会误伤（见下）。
   * Telegram 服务账号（777000）的消息不审：那是历史形态的自动转发，与之并列过滤。
   * 没有可审发送者（匿名管理员、以聊天身份发言等 `from` 缺失的消息）不审，但仍登记群元数据：
   * 登记只依赖 `chat`，不能被 `from` 的空缺挡住。
   *
   * @param ctx 更新上下文。
   * @param message 待审消息（新消息或编辑后的消息）。
   * @param editDate 编辑时间（Unix 秒）；新消息为 `null`。
   */
  async function moderateMessage(ctx: Context, message: Message, editDate: number | null): Promise<void> {
    const chat = ctx.chat
    if (chat === undefined) return
    if (chat.type !== 'group' && chat.type !== 'supergroup') return

    // 自动转发的根帖必须在发送者判断之前跳过：频道「以管理员身份发言」时 from 是真实用户，
    // 放过去会把频道帖子当群内发言处置（误伤管理员、也删不到原帖）。
    if (message.is_automatic_forward === true) return

    const from = ctx.from
    if (
      from === undefined ||
      from.is_bot ||
      from.id === TELEGRAM_SERVICE_ACCOUNT_ID ||
      // 以频道/聊天身份发送（sender_chat 存在）的消息不审：匿名管理员会以群身份发言，
      // 按普通用户处置会误罚管理员；自动转发的根帖已在上方单独跳过。
      message.sender_chat !== undefined
    ) {
      // 无发送者时只做聊天级登记：新群的第一条消息恰好是匿名管理员发言时，群配置不应缺位。
      await chatMetadata.ensureRegistered(chat)
      return
    }

    const text = message.text ?? message.caption ?? ''
    // 频道评论：讨论组里的评论通过回复一条「频道帖子转发」挂到原帖下，只有频道用户名 + 帖子 id
    // 拼出的深链才点得进评论上下文（t.me/c 链接在评论区打不开目标）。拿不到频道用户名时退回 null。
    const forwardOrigin = message.reply_to_message?.forward_origin
    const commentThread =
      forwardOrigin?.type === 'channel' && forwardOrigin.chat.username !== undefined
        ? { channelUsername: forwardOrigin.chat.username, postId: forwardOrigin.message_id }
        : null

    const config = await handleIncomingMessage(pipelineDeps, {
      chatId: asChatId(String(chat.id)),
      chatTitle: chat.title,
      chatType: chat.type,
      messageId: message.message_id,
      userId: asUserId(from.id),
      text,
      features: extractFeatures(message, text),
      editDate,
      senderIdentity: extractSenderIdentity(from),
      commentThread,
    })

    // 讨论组 ↔ 频道的 linked 关系只登记事实：评论仍按讨论组自身的规则审，频道规则不会覆盖讨论组。
    await chatMetadata.syncLinkedChat(chat, config.linkedChatId)
  }

  bot.on('message', async (ctx) => {
    await moderateMessage(ctx, ctx.message, null)
  })

  bot.on('edited_message', async (ctx) => {
    const message = ctx.editedMessage
    const text = message.text ?? message.caption ?? ''
    // Telegram 的编辑更新必带 edit_date；若协议退化导致缺失，用内容哈希前 16 位构造稳定数值兜底：
    // 管线随后还会在判别符里拼上内容哈希（`edit:${editDate}:${内容哈希前 16 位}`），两项组合后
    // 同一编辑的重投递仍得到同一事件 id，内容不同的编辑各自成事件。
    const editDate = message.edit_date ?? Number.parseInt(contentHashOf(text).slice(0, 16), 16)
    await moderateMessage(ctx, message, editDate)
  })

  // 频道帖只登记频道元数据（类型、标题、linked 讨论组）：不审帖子、不落帖子内容。
  bot.on('channel_post', async (ctx) => {
    await chatMetadata.handleChannelPost(ctx.channelPost.chat)
  })

  // bot 自己被加入群/频道或升为管理员时登记/刷新；被移出或降权时保留配置（历史决策与申诉仍要读）。
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.update.my_chat_member
    if (update === undefined) return
    await chatMetadata.handleMyChatMember(update)
  })

  // 频道成员事件 → 订阅成员台账。只用事实：不调用任何权限处置接口，无证据的新免费成员被忽略。
  bot.on('chat_member', async (ctx) => {
    const update = ctx.update.chat_member
    if (update === undefined) return
    try {
      await subscriptionMembers.handleChatMember(update, ctx.update.update_id)
    } catch (error) {
      // 单条成员事件失败不冒泡到全局 catch：事件可能携带 invite_link、异常也可能回显它，
      // 日志只留受控异常类型名与 ID（chatId/userId）。
      logger.warn(
        `订阅成员事件处理失败 chatId=${String(update.chat.id)} userId=${update.new_chat_member.user.id} code=${error instanceof Error ? error.name : typeof error}`,
      )
    }
  })

  const appealDeps: AppealDeps = {
    api: bot.api,
    repos: options.repos,
    ownerUserId: options.ownerUserId,
    logger,
  }

  bot.callbackQuery(APPEAL_CALLBACK_PATTERN, createAppealCallbackHandler(appealDeps))

  /**
   * 更新级错误兜底：单条更新失败不能让进程退出，否则一次 Telegram 抖动就会丢掉整个机器人。
   * 致命错误（token 失效、网络不可达）由 `bot.start()` 的 rejection 处理。
   */
  bot.catch((error: { ctx: Context; error: unknown }) => {
    logger.error(`处理更新失败 update_id=${String(error.ctx.update.update_id)}`, error.error)
  })

  return {
    bot,
    retryDecisions: createDecisionRetryService({
      repos: options.repos,
      executor,
      idempotency,
      logger,
      now: options.now,
    }),
    resendAppeals: createAppealNotificationService({ ...appealDeps, now: options.now }),
    retryRollbacks: createAppealRollbackService({ ...appealDeps, now: options.now }),
  }
}

/**
 * 建立配置好的 bot 实例。
 *
 * 中间件：
 * - `message`：群与超级群里的每条消息走审核管线。私聊不在范围内；频道自动转发的根帖与无发送者消息只登记元数据。
 * - `edited_message`：编辑后的群消息重走同一条管线；每次编辑产生独立事件与决策。
 * - `channel_post`：只登记频道元数据（类型、标题、linked 讨论组），不审帖子、不落帖子内容。
 * - `my_chat_member`：bot 被加入/升为管理员时登记或刷新群/频道元数据；被移出/降权时保留配置。
 * - `callbackQuery`：owner 的申诉处理回调。
 * - `command('start')`：介绍语与申诉说明。
 * - `catch`：单条更新失败不退出进程。
 *
 * @param options bot token、仓储、复核配置与运行参数。
 * @returns grammY 的 `Bot` 实例。
 */
export function createBot(options: CreateBotOptions): Bot {
  return createBotRuntime(options).bot
}
