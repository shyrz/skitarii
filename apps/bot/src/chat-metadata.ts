import { asChatId, type ChatId, type ChatType } from '@skitarii/core'
import type { ChatMetadataPatch, Repos } from '@skitarii/db'
import type { Api } from 'grammy'
import type { Chat, ChatMemberUpdated } from 'grammy/types'
import { defaultChatConfig } from './defaults.js'
import type { Logger } from './logger.js'

/**
 * 聊天元数据登记：把 bot 所在的群/频道写进 `chats`，并按需刷新 title / chatType / linkedChatId。
 *
 * 三条入口：
 * - `my_chat_member`：bot 被加入或升为管理员时登记/刷新（被移出/降权时保留配置，不删除）；
 * - `channel_post`：频道帖只登记元数据，**不审核帖子、不落帖子内容**；
 * - `ensureRegistered`：普通群消息里没有可审发送者（匿名管理员等）时的兜底登记，登记不依赖 `from`。
 *
 * 三条硬约定：
 * 1. 登记只走 `ChatRepo.register`（冲突即放弃），绝不用一份新构造的默认配置覆盖 owner 已保存的规则；
 * 2. 刷新只走 `ChatRepo.updateMetadata`（单列 UPDATE），同样不触碰规则与阈值；
 * 3. `getChat` 只用于补全 linked chat 关系（Telegram 的 update 里不带这个字段），
 *    缺失时才探测、同一聊天有冷却窗口，失败只记一条脱敏日志并保留已知信息（可恢复降级）。
 */

/**
 * linked chat 探测的冷却窗口（毫秒）。
 *
 * `getChat` 只在该聊天还没有 linked 关系时发出：探测成功后值已落库，此后不再请求；
 * 失败或「暂时没有链接」时记下尝试时刻，窗口内不再重复请求，避免每条频道帖或评论都打一次 API。
 * 取 6 小时：链接关系（频道 ↔ 讨论组）是低频变更，短窗口没有收益，重启会自然清空该内存表。
 */
const LINKED_CHAT_LOOKUP_TTL_MS = 6 * 60 * 60 * 1_000

/** `getChat` 返回的完整聊天信息才带 `linked_chat_id`；基础 `Chat` 类型里没有这个字段。 */
type ChatWithLinkedId = Chat & { linked_chat_id?: number }

/** 元数据服务依赖。 */
export interface ChatMetadataDeps {
  api: Pick<Api, 'getChat'>
  repos: Repos
  logger: Logger
  /** 时间源，默认系统时间；冷却窗口用它计时。显式允许 `undefined`，便于直接透传可选配置。 */
  now?: (() => Date) | undefined
}

/** 聊天元数据登记服务。 */
export interface ChatMetadataService {
  /**
   * 处理 bot 自己的成员变更：加入或升为管理员时登记/刷新。
   * 被移出、降权或封禁时不删除配置：历史决策与申诉仍要读群配置，重新加入时也直接复用。
   *
   * @param update `my_chat_member` 更新。
   */
  handleMyChatMember(update: ChatMemberUpdated): Promise<void>
  /**
   * 处理频道帖：只登记/刷新频道元数据，不审核、不落帖子内容。
   *
   * @param chat 频道帖所属频道。
   */
  handleChannelPost(chat: Chat): Promise<void>
  /**
   * 登记并刷新一个群/频道的元数据（已登记时只更新出现差异的字段）。
   * 供「没有可审发送者」的消息路径使用：登记由 chat 决定，与 `from` 是否存在无关。
   *
   * @param chat Telegram 聊天对象。
   */
  ensureRegistered(chat: Chat): Promise<void>
  /**
   * 群消息路径的补充：当前记录的 linked 关系缺失时探测一次（带冷却）。
   * 失败或未链接都静默返回，不影响审核链路。
   *
   * @param chat Telegram 聊天对象。
   * @param currentLinkedChatId 刚读到的配置里的 linked 关系（避免为了判断再查一次库）。
   */
  syncLinkedChat(chat: Chat, currentLinkedChatId: ChatId | null): Promise<void>
}

/**
 * 建立聊天元数据服务。
 *
 * 冷却表是进程内状态：单进程部署下够用（README 的单进程假设），重启后允许对仍缺失的聊天重新探测。
 *
 * @param deps Bot API、仓储、日志与时间源。
 * @returns 元数据登记服务。
 */
export function createChatMetadataService(deps: ChatMetadataDeps): ChatMetadataService {
  const now = deps.now ?? (() => new Date())
  /** chatId → 上次 getChat 尝试时刻（毫秒）。 */
  const linkedLookupAttempts = new Map<string, number>()

  /**
   * 探测 linked chat。三态返回把「拿到值」「确认没有链接」与「这次没探测/失败」分开：
   * 只有前者才值得写库。
   *
   * @param chatId 目标聊天。
   * @returns 新拿到的 linkedChatId；确认无链接为 `null`；冷却中或请求失败为 `undefined`。
   */
  async function resolveLinkedChatId(chatId: ChatId): Promise<ChatId | null | undefined> {
    const attemptAt = linkedLookupAttempts.get(chatId)
    const nowMs = now().getTime()
    if (attemptAt !== undefined && nowMs - attemptAt < LINKED_CHAT_LOOKUP_TTL_MS) return undefined

    linkedLookupAttempts.set(chatId, nowMs)
    try {
      const full = (await deps.api.getChat(chatId)) as ChatWithLinkedId
      return full.linked_chat_id === undefined ? null : asChatId(String(full.linked_chat_id))
    } catch (error) {
      // 只记脱敏摘要：错误原文可能带请求 URL（含 token），日志里不允许出现凭据。
      deps.logger.warn(
        `getChat 失败，保留已知元数据待下次刷新 chatId=${chatId} reason=${failureName(error)}`,
      )
      return undefined
    }
  }

  /**
   * 按聊天类型决定是否值得探测 linked chat：基础群没有 linked 概念，直接返回 `null`。
   *
   * @param chatType 聊天类型。
   * @param chatId 目标聊天。
   * @returns 探测结果或 `null`。
   */
  async function resolveLinkedChatIdOf(chatType: ChatType, chatId: ChatId): Promise<ChatId | null | undefined> {
    if (chatType === 'group') return null
    return await resolveLinkedChatId(chatId)
  }

  /**
   * 登记未知聊天；已登记时只清单列刷新有差异的元数据。
   *
   * @param chat Telegram 聊天对象（类型为群/超级群/频道）。
   */
  async function ensureRegisteredAndRefresh(chat: Chat): Promise<void> {
    const registered = registeredChatOf(chat)
    if (registered === null) return
    const { chatType, title } = registered

    const chatId = asChatId(String(chat.id))
    const existing = await deps.repos.chats.findByChatId(chatId)

    if (existing === null) {
      const linkedChatId = (await resolveLinkedChatIdOf(chatType, chatId)) ?? null
      deps.logger.info(`登记新聊天 chatId=${chatId} chatType=${chatType}`)
      await deps.repos.chats.register(defaultChatConfig(chatId, title, 'zh', chatType, linkedChatId))
      return
    }

    // 只把有差异的字段放进 patch：没有变化时一条 UPDATE 都不发。
    const patch: ChatMetadataPatch = {}
    if (existing.title !== title) patch.title = title
    if (existing.chatType !== chatType) patch.chatType = chatType
    if (existing.linkedChatId === null) {
      const linked = await resolveLinkedChatIdOf(chatType, chatId)
      if (linked !== undefined && linked !== null) patch.linkedChatId = linked
    }
    if (Object.keys(patch).length > 0) await deps.repos.chats.updateMetadata(chatId, patch)
  }

  return {
    async handleMyChatMember(update): Promise<void> {
      const chat = update.chat
      if (registeredChatOf(chat) === null) return

      const status = update.new_chat_member.status
      if (status !== 'member' && status !== 'administrator') {
        deps.logger.info(`bot 已离开或失去管理权限，保留既有配置 chatId=${chat.id} status=${status}`)
        return
      }

      await ensureRegisteredAndRefresh(chat)
    },

    async handleChannelPost(chat): Promise<void> {
      // 频道帖只登记元数据：不审帖子、不落 message_events（频道内容审核不在本批范围）。
      if (registeredChatOf(chat)?.chatType !== 'channel') return
      await ensureRegisteredAndRefresh(chat)
    },

    async ensureRegistered(chat): Promise<void> {
      await ensureRegisteredAndRefresh(chat)
    },

    async syncLinkedChat(chat, currentLinkedChatId): Promise<void> {
      // 只有讨论组（超级群）的「指向频道」关系需要补：频道侧走 channel_post / my_chat_member。
      if (registeredChatOf(chat)?.chatType !== 'supergroup' || currentLinkedChatId !== null) return

      const chatId = asChatId(String(chat.id))
      try {
        const linked = await resolveLinkedChatId(chatId)
        if (linked === undefined || linked === null) return
        await deps.repos.chats.updateMetadata(chatId, { linkedChatId: linked })
      } catch (error) {
        // 补关系是增强项，失败不能扩散到审核链路。
        deps.logger.warn(`linked discussion 关系补写失败 chatId=${chatId} reason=${failureName(error)}`)
      }
    },
  }
}

/**
 * 把 Telegram 的聊天对象收窄为「已登记的聊天」：私聊不产生配置行，返回 `null`。
 * 同时把标题带出来：非私聊协议上必有 `title`，收窄后类型也是确定的。
 *
 * @param chat Telegram 聊天对象。
 * @returns 类型与标题；私聊为 `null`。
 */
export function registeredChatOf(chat: Chat): { chatType: ChatType; title: string } | null {
  switch (chat.type) {
    case 'group':
    case 'supergroup':
    case 'channel':
      return { chatType: chat.type, title: chat.title }
    case 'private':
      return null
  }
}

/**
 * 只取异常类型名的脱敏摘要。
 *
 * 不用 `error.message`：网络层错误的 message 或 cause 可能携带请求 URL，而 Bot API 的 URL 里带 token。
 * 类型名（HttpError / GrammyError / TypeError）足以定位排查方向，具体原因去 API 侧日志看。
 *
 * @param error 捕获的异常。
 * @returns 异常类型名或 `typeof` 结果。
 */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
