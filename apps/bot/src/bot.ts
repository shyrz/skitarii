import { asChatId, asUserId, type UserId } from '@skitarii/core'
import type { Repos } from '@skitarii/db'
import { createCachedJudge, createOpenAiJudge, type LlmConfig } from '@skitarii/llm'
import { Bot, type Context } from 'grammy'
import {
  APPEAL_CALLBACK_PATTERN,
  createAppealCallbackHandler,
  createAppealNotificationService,
  type AppealDeps,
  type AppealNotificationService,
} from './appeal.js'
import { createDecisionRetryService, type DecisionRetryService } from './decision-retry.js'
import { createActionExecutor } from './executor.js'
import { extractFeatures } from './features.js'
import { createIdempotencyRegistry } from './idempotency.js'
import { createLogger, type Logger } from './logger.js'
import { createOwnerFeed } from './owner-feed.js'
import { handleIncomingMessage, type PipelineDeps } from './pipeline.js'
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
 * 公开面同时提供 server 侧需要的运行时零件：`notifyOwnerOfAppeal`（申诉创建后私聊 owner）与
 * `createLogger`（两个进程共用同一套日志出口）。
 *
 * 需要补偿扫描的调用方用 {@link createBotRuntime}：它把 bot 与两个维护服务一起交出来，
 * 三者共享同一份执行器与幂等闸门（这是补偿不重复施加动作的前提）。
 */

export { createLogger } from './logger.js'
export type { Logger } from './logger.js'
export { notifyOwnerOfAppeal, APPEAL_CALLBACK_PATTERN, createAppealNotificationService } from './appeal.js'
export type { AppealDeps, AppealNotification, AppealNotificationService, AppealNotifyResult } from './appeal.js'
export { createDecisionRetryService, DECISION_RETRY_SCAN_LIMIT, STALE_DECISION_AGE_MS } from './decision-retry.js'
export type { DecisionRetryResult, DecisionRetryService } from './decision-retry.js'

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

/** bot 运行时：bot 实例与两个维护服务共用同一份执行器。 */
export interface BotRuntime {
  bot: Bot
  /**
   * 未执行决策的补偿扫描。与 bot 共用同一个 `ActionExecutor`（幂等闸门、限流桶），
   * 由 apps/server 的调度器在维护任务里调用。
   */
  retryDecisions: DecisionRetryService
  /** owner 通知的补发扫描（`open && notified_at is null`），同样由调度器调用。 */
  resendAppeals: AppealNotificationService
}

/**
 * 建立 bot 运行时。webhook 与补偿扫描都要用 bot 的进程，因此这里一次性把两者组装出来。
 *
 * @param options bot token、仓储、复核配置与运行参数。
 * @returns bot 实例与两个维护服务。
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

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        '这个是群组消息审核机器人。',
        '把它加入群或频道并授予删除消息、封禁用户的权限后开始工作。',
        '被误判的消息会附带申诉按钮，处理结果在 Mini App 里可见。',
      ].join('\n'),
    )
  })

  bot.on('message', async (ctx) => {
    const message = ctx.message
    const chat = ctx.chat
    const from = ctx.from

    // 只审群与超级群：私聊是命令与申诉通知的通道，频道消息（channel_post）不属于本节。
    if (chat.type !== 'group' && chat.type !== 'supergroup') return
    // 其他 bot 的消息不审：既避免 bot 互相触发，也避免把审核结果反馈给自动化流程。
    if (from === undefined || from.is_bot) return

    const text = message.text ?? message.caption ?? ''
    await handleIncomingMessage(pipelineDeps, {
      chatId: asChatId(String(chat.id)),
      chatTitle: chat.title,
      messageId: message.message_id,
      userId: asUserId(from.id),
      text,
      features: extractFeatures(message, text),
    })
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
  }
}

/**
 * 建立配置好的 bot 实例。
 *
 * 中间件：
 * - `message`：群与超级群里的每条消息走审核管线。私聊与频道消息不在 Phase 1 范围内。
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
