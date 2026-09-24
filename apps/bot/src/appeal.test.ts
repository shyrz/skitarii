import { asChatId, asUserId, type Appeal, type ModerationDecision } from '@skitarii/core'
import { createInMemoryRepos, type InMemoryRepos, type Repos } from '@skitarii/db'
import { GrammyError } from 'grammy'
import type { Context } from 'grammy'
import { describe, expect, test, vi } from 'vitest'
import {
  createAppealCallbackHandler,
  createAppealNotificationService,
  createAppealRollbackService,
  notifyOwnerOfAppeal,
  resolveAppeal,
} from './appeal.js'
import type { Logger } from './logger.js'
import { createRecordingApi, type RecordingApi } from './recording-api.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

const ownerId = asUserId(1_000_000_001)
const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)
const decisionId = '9c8b7a65-1111-4222-8333-999900001111'
const appealId = 'a1b2c3d4-1111-4222-8333-555566667777'

/**
 * 预置一条决策、它的事件行与一条待处理申诉。
 *
 * @param store 内存仓储。
 * @param action 原处置。
 * @returns 申诉记录。
 */
async function seedAppeal(store: InMemoryRepos, action: ModerationDecision['action']): Promise<Appeal> {
  await store.repos.chats.upsert({
    chatId,
    title: '测试群',
    language: 'zh',
    rules: [],
    passThreshold: 0.3,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
  })
  await store.repos.events.insert({
    id: '3f1d0c9a-1111-4222-8333-444455556666',
    chatId,
    userId,
    messageId: 42,
    contentHash: 'h'.repeat(64),
    features: { hasLink: false, mediaType: 'text', length: 12, customEmojiCount: 0 },
    createdAt: new Date('2026-09-23T10:00:00Z'),
  })
  await store.repos.decisions.insert({
    id: decisionId,
    eventId: '3f1d0c9a-1111-4222-8333-444455556666',
    chatId,
    userId,
    action,
    score: 0.9,
    signals: [],
    decidedAt: new Date('2026-09-23T10:00:00Z'),
    executed: true,
  })

  const appeal: Appeal = {
    id: appealId,
    decisionId,
    userId,
    state: 'open',
    note: '这是我自己的闲置转让',
    createdAt: new Date('2026-09-23T10:05:00Z'),
    resolvedAt: null,
  }
  await store.repos.appeals.insert(appeal)
  return appeal
}

/**
 * 构造回调上下文替身。
 *
 * @param data callback_data。
 * @param fromId 点击者的 Telegram id。
 * @returns 上下文与其上的调用记录。
 */
function createContext(data: string, fromId: number) {
  const answers: Array<{ text?: string; show_alert?: boolean }> = []
  const edits: string[] = []
  const ctx = {
    callbackQuery: { data, message: { text: '🚨 新的申诉待处理' } },
    from: { id: fromId, is_bot: false, first_name: 'owner' },
    async answerCallbackQuery(payload?: { text?: string; show_alert?: boolean }) {
      answers.push(payload ?? {})
    },
    async editMessageText(text: string) {
      edits.push(text)
    },
  }
  return { ctx: ctx as unknown as Context, answers, edits }
}

/**
 * 组装回调处理器。
 *
 * @param store 内存仓储。
 * @returns 处理器与录制 api。
 */
function setup(store: InMemoryRepos) {
  const recording: RecordingApi = createRecordingApi()
  const handler = createAppealCallbackHandler({
    api: recording.api,
    repos: store.repos,
    ownerUserId: ownerId,
    logger: silentLogger,
  })
  return { handler, recording }
}

describe('owner 处理申诉', () => {
  test('撤销禁言：恢复权限并结案为 overturned', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const { handler, recording } = setup(store)
    const { ctx, answers, edits } = createContext(`appeal:${appealId}:overturn`, ownerId)

    await handler(ctx, async () => {})

    const args = recording.lastArgsOf('restrictChatMember') ?? []
    expect(args[0]).toBe(chatId)
    expect(args[1]).toBe(userId)
    expect(args[2]).toMatchObject({ can_send_messages: true, can_invite_users: true })
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'overturned' })
    expect(store.resolvedByOf(appealId)).toBe(ownerId)
    expect(answers.at(-1)?.text).toBe('已撤销并恢复权限')
    expect(edits.at(-1)).toContain('已撤销（误判成立）')
  })

  test('撤销封禁：调用解封', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'ban' })
    const { handler, recording } = setup(store)
    const { ctx } = createContext(`appeal:${appealId}:overturn`, ownerId)

    await handler(ctx, async () => {})

    expect(recording.lastArgsOf('unbanChatMember')).toEqual([chatId, userId, { only_if_banned: true }])
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'overturned' })
  })

  test('撤销禁言遇到不可罚目标：没有权限可恢复，仍结案为 overturned', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const recording: RecordingApi = createRecordingApi({
      restrictChatMember: () => {
        throw new GrammyError(
          'Call to restrictChatMember failed',
          { ok: false, error_code: 400, description: 'Bad Request: user is an administrator of the chat' },
          'restrictChatMember',
          {},
        )
      },
    })
    const handler = createAppealCallbackHandler({
      api: recording.api,
      repos: store.repos,
      ownerUserId: ownerId,
      logger: silentLogger,
    })
    const { ctx, answers, edits } = createContext(`appeal:${appealId}:overturn`, ownerId)

    await handler(ctx, async () => {})

    // executor 本就禁言不了这个管理员，撤销时没有权限可恢复：结案照常，不落进「回滚失败」分支。
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'overturned' })
    expect(answers.at(-1)?.text).toBe('已撤销并恢复权限')
    expect(edits.at(-1)).toContain('已撤销（误判成立）')
  })

  test('撤销删除：消息无法恢复，只结案不调 Telegram', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    const { handler, recording } = setup(store)
    const { ctx } = createContext(`appeal:${appealId}:overturn`, ownerId)

    await handler(ctx, async () => {})

    expect(recording.calls).toEqual([])
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'overturned' })
  })

  test('维持：不改权限，结案为 upheld 并记录结案人', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const { handler, recording } = setup(store)
    const { ctx, answers } = createContext(`appeal:${appealId}:uphold`, ownerId)

    await handler(ctx, async () => {})

    expect(recording.calls).toEqual([])
    const appeal = await store.repos.appeals.findById(appealId)
    expect(appeal).toMatchObject({ state: 'upheld' })
    expect(appeal?.resolvedAt).toBeInstanceOf(Date)
    expect(store.resolvedByOf(appealId)).toBe(ownerId)
    expect(answers.at(-1)?.text).toBe('已维持原处置')
  })

  test('非 owner 点击被拒，且不改状态', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'ban' })
    const { handler, recording } = setup(store)
    const { ctx, answers } = createContext(`appeal:${appealId}:overturn`, 42)

    await handler(ctx, async () => {})

    expect(recording.calls).toEqual([])
    expect(answers.at(-1)).toEqual({ text: '只有管理员可以处理申诉', show_alert: true })
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'open' })
  })

  test('重复点击已结案的申诉不会翻转结论', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const { handler, recording } = setup(store)

    const first = createContext(`appeal:${appealId}:uphold`, ownerId)
    await handler(first.ctx, async () => {})
    const second = createContext(`appeal:${appealId}:overturn`, ownerId)
    await handler(second.ctx, async () => {})

    expect(recordedMethods(recording)).toEqual([])
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'upheld' })
    expect(second.answers.at(-1)?.text).toContain('已经处理过')
  })

  test('并发点击里抢不到结案的那次：不回滚权限、不报成功', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    // 模拟「另一次点击已经抢先结案」：条件更新影响到 0 行。
    const repos = {
      ...store.repos,
      appeals: { ...store.repos.appeals, resolve: async () => false },
    }
    const recording: RecordingApi = createRecordingApi()
    const handler = createAppealCallbackHandler({ api: recording.api, repos, ownerUserId: ownerId, logger: silentLogger })
    const { ctx, answers, edits } = createContext(`appeal:${appealId}:overturn`, ownerId)

    await handler(ctx, async () => {})

    // 不能答「已撤销并恢复权限」：真正结案的是另一次调用。
    expect(answers.at(-1)).toEqual({ text: '这条申诉已被处理过' })
    expect(edits).toEqual([])
    expect(recording.calls).toEqual([])
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'open' })
  })

  test('申诉不存在时给出提示', async () => {
    const store = createInMemoryRepos()
    const { handler } = setup(store)
    const { ctx, answers } = createContext(`appeal:${appealId}:overturn`, ownerId)

    await handler(ctx, async () => {})

    expect(answers.at(-1)).toEqual({ text: '这条申诉不存在', show_alert: true })
  })
})

describe('resolveAppeal 结案语义', () => {
  test('维持：resolved 且无需回滚，结案人与状态落库', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    const recording = createRecordingApi()

    const resolution = await resolveAppeal(
      { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger },
      appealId,
      'uphold',
    )

    expect(resolution).toMatchObject({ kind: 'resolved', rollbackFailed: false, resolvedAt: expect.any(Date) })
    expect(recording.calls).toEqual([])
    const appeal = await store.repos.appeals.findById(appealId)
    expect(appeal).toMatchObject({ state: 'upheld' })
    expect(appeal?.resolvedAt).toBeInstanceOf(Date)
    expect(store.resolvedByOf(appealId)).toBe(ownerId)
  })

  test('撤销禁言：回滚权限后 resolved', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const recording = createRecordingApi()

    const resolution = await resolveAppeal(
      { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger },
      appealId,
      'overturn',
    )

    expect(resolution).toMatchObject({ kind: 'resolved', rollbackFailed: false, resolvedAt: expect.any(Date) })
    expect(recording.lastArgsOf('restrictChatMember')?.[0]).toBe(chatId)
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'overturned' })
  })

  test('已结案的申诉返回 already_resolved，不改状态', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    await store.repos.appeals.resolve(appealId, 'upheld', new Date('2026-09-23T10:10:00Z'), ownerId, false)
    const recording = createRecordingApi()

    const resolution = await resolveAppeal(
      { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger },
      appealId,
      'overturn',
    )

    expect(resolution).toEqual({ kind: 'already_resolved' })
    expect(recording.calls).toEqual([])
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'upheld' })
  })

  test('并发下抢不到条件更新：返回 already_resolved，不回滚权限', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const repos = {
      ...store.repos,
      appeals: { ...store.repos.appeals, resolve: async () => false },
    }
    const recording = createRecordingApi()

    const resolution = await resolveAppeal({ api: recording.api, repos, ownerUserId: ownerId, logger: silentLogger }, appealId, 'overturn')

    expect(resolution).toEqual({ kind: 'already_resolved' })
    expect(recording.calls).toEqual([])
  })

  test('申诉不存在或关联决策不存在：返回 missing', async () => {
    const store = createInMemoryRepos()
    const recording = createRecordingApi()
    const deps = { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger }

    expect(await resolveAppeal(deps, appealId, 'uphold')).toEqual({ kind: 'missing' })

    await seedAppeal(store, { kind: 'delete' })
    const orphaned = { ...store.repos, decisions: { ...store.repos.decisions, findById: async () => null } }
    expect(await resolveAppeal({ ...deps, repos: orphaned }, appealId, 'uphold')).toEqual({ kind: 'missing' })
    // 决策缺失时连结案都不发生。
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'open' })
  })

  test('回滚失败不抛出：resolved 且 rollbackFailed=true，写 error 日志', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const errors: unknown[] = []
    const logger: Logger = {
      info: () => {},
      warn: () => {},
      error: (message, error) => errors.push({ message, error }),
    }
    const recording: RecordingApi = createRecordingApi({
      restrictChatMember: () => {
        throw new GrammyError(
          'Call to restrictChatMember failed',
          { ok: false, error_code: 503, description: 'Service Unavailable' },
          'restrictChatMember',
          {},
        )
      },
    })

    const resolution = await resolveAppeal({ api: recording.api, repos: store.repos, ownerUserId: ownerId, logger }, appealId, 'overturn')

    expect(resolution).toMatchObject({ kind: 'resolved', rollbackFailed: true, resolvedAt: expect.any(Date) })
    // 结案仍是终态：面板与回调都要提示「已结案但恢复失败，请手动处理」。
    expect(await store.repos.appeals.findById(appealId)).toMatchObject({ state: 'overturned' })
    expect(errors).toHaveLength(1)
    expect(String((errors[0] as { message: string }).message)).toContain('权限回滚失败')
  })

  test('回调的私聊修订使用结案时刻，不另取当前时间', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    // claim 之后、修订私聊之前把时钟推前一分钟：编辑文案里的时间必须仍是写库的那次结案时刻。
    const repos: Repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        async resolve(appealId, state, resolvedAt, by, rollbackPending) {
          const claimed = await store.repos.appeals.resolve(appealId, state, resolvedAt, by, rollbackPending)
          vi.advanceTimersByTime(60_000)
          return claimed
        },
      },
    }
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-23T10:20:00Z') })
    try {
      const recording: RecordingApi = createRecordingApi()
      const handler = createAppealCallbackHandler({ api: recording.api, repos, ownerUserId: ownerId, logger: silentLogger })
      const { ctx, edits } = createContext(`appeal:${appealId}:overturn`, ownerId)

      await handler(ctx, async () => {})

      expect(edits.at(-1)).toContain('2026-09-23T10:20:00.000Z')
      expect(await store.repos.appeals.findById(appealId)).toMatchObject({
        resolvedAt: new Date('2026-09-23T10:20:00.000Z'),
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('回滚补偿（rollback_pending）', () => {
  /** 建一个只记录 warn 的日志替身。 */
  function warnCapture(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = []
    return {
      warnings,
      logger: {
        info: () => {},
        warn: (message) => {
          warnings.push(message)
        },
        error: () => {},
      },
    }
  }

  test('撤销在 claim 的同一次更新里置「待回滚」，回滚成功后清除', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const observed: boolean[] = []
    const repos: Repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        async resolve(appealId, state, resolvedAt, by, rollbackPending) {
          observed.push(rollbackPending)
          return store.repos.appeals.resolve(appealId, state, resolvedAt, by, rollbackPending)
        },
      },
    }
    const recording = createRecordingApi()

    await resolveAppeal({ api: recording.api, repos, ownerUserId: ownerId, logger: silentLogger }, appealId, 'overturn')

    expect(observed).toEqual([true])
    expect(await store.repos.appeals.listPendingRollback(10)).toEqual([])
  })

  test('维持不置「待回滚」标记', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    const observed: boolean[] = []
    const repos: Repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        async resolve(appealId, state, resolvedAt, by, rollbackPending) {
          observed.push(rollbackPending)
          return store.repos.appeals.resolve(appealId, state, resolvedAt, by, rollbackPending)
        },
      },
    }
    const recording = createRecordingApi()

    await resolveAppeal({ api: recording.api, repos, ownerUserId: ownerId, logger: silentLogger }, appealId, 'uphold')

    expect(observed).toEqual([false])
    expect(await store.repos.appeals.listPendingRollback(10)).toEqual([])
  })

  test('回滚失败：标记保留，补偿扫描补跑后清除', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    let failNext = true
    const recording: RecordingApi = createRecordingApi({
      restrictChatMember: () => {
        if (failNext) {
          throw new GrammyError(
            'Call to restrictChatMember failed',
            { ok: false, error_code: 503, description: 'Service Unavailable' },
            'restrictChatMember',
            {},
          )
        }
        return { ok: true }
      },
    })
    const deps = { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger }

    const resolution = await resolveAppeal(deps, appealId, 'overturn')

    expect(resolution).toMatchObject({ kind: 'resolved', rollbackFailed: true })
    const pending = await store.repos.appeals.listPendingRollback(10)
    expect(pending.map((appeal) => appeal.id)).toEqual([appealId])

    failNext = false
    const service = createAppealRollbackService({ ...deps, limit: 10 })
    expect(await service.runOnce()).toEqual({ scanned: 1, cleared: 1, failed: 0 })
    expect(await store.repos.appeals.listPendingRollback(10)).toEqual([])
  })

  test('清除标记失败只记 warn：结案结论不变，标记留给扫描兜底', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    const repos: Repos = {
      ...store.repos,
      appeals: {
        ...store.repos.appeals,
        clearRollbackPending: async () => {
          throw new Error('database is down')
        },
      },
    }
    const { logger, warnings } = warnCapture()
    const recording = createRecordingApi()

    const resolution = await resolveAppeal({ api: recording.api, repos, ownerUserId: ownerId, logger }, appealId, 'overturn')

    expect(resolution).toMatchObject({ kind: 'resolved', rollbackFailed: false })
    expect(warnings.some((message) => message.includes('回滚标记清除失败'))).toBe(true)
    // 底层标记仍在：扫描会再回滚一次，解禁/解封幂等。
    expect((await store.repos.appeals.listPendingRollback(10)).map((appeal) => appeal.id)).toEqual([appealId])
  })

  test('补偿扫描：回滚失败留待下一轮，不清标记', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'ban' })
    await store.repos.appeals.resolve(appealId, 'overturned', new Date('2026-09-23T10:10:00Z'), ownerId, true)
    const recording: RecordingApi = createRecordingApi({
      unbanChatMember: () => {
        throw new GrammyError(
          'Call to unbanChatMember failed',
          { ok: false, error_code: 503, description: 'Service Unavailable' },
          'unbanChatMember',
          {},
        )
      },
    })
    const { logger, warnings } = warnCapture()
    const service = createAppealRollbackService({ api: recording.api, repos: store.repos, ownerUserId: ownerId, logger, limit: 10 })

    expect(await service.runOnce()).toEqual({ scanned: 1, cleared: 0, failed: 1 })
    expect(warnings.some((message) => message.includes('权限回滚补偿失败'))).toBe(true)
    expect((await store.repos.appeals.listPendingRollback(10)).map((appeal) => appeal.id)).toEqual([appealId])
  })

  test('补偿扫描：决策缺失时清标记并告警，不卡住队列', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    await store.repos.appeals.resolve(appealId, 'overturned', new Date('2026-09-23T10:10:00Z'), ownerId, true)
    const repos: Repos = {
      ...store.repos,
      decisions: { ...store.repos.decisions, findById: async () => null },
    }
    const { logger, warnings } = warnCapture()
    const recording = createRecordingApi()
    const service = createAppealRollbackService({ api: recording.api, repos, ownerUserId: ownerId, logger, limit: 10 })

    expect(await service.runOnce()).toEqual({ scanned: 1, cleared: 1, failed: 0 })
    expect(warnings.some((message) => message.includes('缺少关联决策'))).toBe(true)
    expect(recording.calls).toEqual([])
    expect(await store.repos.appeals.listPendingRollback(10)).toEqual([])
  })

  test('补偿扫描只处理 pending，维持与已清除的申诉不在候选集', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'mute', until: new Date('2026-09-23T11:00:00Z') })
    await store.repos.appeals.resolve(appealId, 'overturned', new Date('2026-09-23T10:10:00Z'), ownerId, false)
    const recording = createRecordingApi()
    const service = createAppealRollbackService({
      api: recording.api,
      repos: store.repos,
      ownerUserId: ownerId,
      logger: silentLogger,
      limit: 10,
    })

    expect(await service.runOnce()).toEqual({ scanned: 0, cleared: 0, failed: 0 })
    expect(recording.calls).toEqual([])
  })
})

describe('owner 通知', () => {
  test('通知发到 owner 私聊，带维持与撤销按钮，返回已接受', async () => {
    const store = createInMemoryRepos()
    const recording: RecordingApi = createRecordingApi()

    await expect(
      notifyOwnerOfAppeal(
        { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger },
        {
          appealId,
          userId,
          reason: '这是我自己的闲置转让',
          chatTitle: '测试群',
          action: { kind: 'delete' },
          sampleText: '低价出售会员',
          createdAt: new Date('2026-09-23T10:05:00Z'),
        },
      ),
    ).resolves.toBe(true)

    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(ownerId)
    expect(String(args[1])).toContain('测试群')
    expect(String(args[1])).toContain('低价出售会员')
    expect(args[2]).toEqual({
      reply_markup: {
        inline_keyboard: [
          [
            { text: '维持原处置', callback_data: `appeal:${appealId}:uphold` },
            { text: '撤销并恢复', callback_data: `appeal:${appealId}:overturn` },
          ],
        ],
      },
    })
  })

  test('通知失败不抛出：owner 未私聊过 bot 时返回未接受', async () => {
    const store = createInMemoryRepos()
    const recording: RecordingApi = createRecordingApi({
      sendMessage: () => {
        throw new Error('Forbidden: bot can not initiate conversation with a user')
      },
    })

    await expect(
      notifyOwnerOfAppeal(
        { api: recording.api, repos: store.repos, ownerUserId: ownerId, logger: silentLogger },
        {
          appealId,
          userId,
          reason: '误判',
          chatTitle: '测试群',
          action: { kind: 'warn' },
          sampleText: null,
          createdAt: new Date('2026-09-23T10:05:00Z'),
        },
      ),
    ).resolves.toBe(false)
  })
})

describe('申诉通知补发', () => {
  test('扫描到未通知的申诉后补发并回填 notified_at', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    const recording: RecordingApi = createRecordingApi()
    const service = createAppealNotificationService({
      api: recording.api,
      repos: store.repos,
      ownerUserId: ownerId,
      logger: silentLogger,
      now: () => new Date('2026-09-23T10:06:00Z'),
    })

    const result = await service.runOnce()

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0 })
    const args = recording.lastArgsOf('sendMessage') ?? []
    expect(args[0]).toBe(ownerId)
    // 通知内容按库里的申诉与决策重建：理由取自 note，摘录取自事件行。
    expect(String(args[1])).toContain('这是我自己的闲置转让')
    expect(String(args[1])).toContain('测试群')
    expect(store.notifiedAtOf(appealId)).toEqual(new Date('2026-09-23T10:06:00Z'))

    // 回填之后不再出现在候选集里。
    expect(await service.runOnce()).toEqual({ scanned: 0, sent: 0, failed: 0 })
    expect(recording.countOf('sendMessage')).toBe(1)
  })

  test('补发失败不回填，下一轮会重试', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    let failNext = true
    const recording: RecordingApi = createRecordingApi({
      sendMessage: () => {
        if (failNext) throw new Error('Forbidden: bot was blocked by the user')
        return { message_id: 1 }
      },
    })
    const service = createAppealNotificationService({
      api: recording.api,
      repos: store.repos,
      ownerUserId: ownerId,
      logger: silentLogger,
    })

    expect(await service.runOnce()).toEqual({ scanned: 1, sent: 0, failed: 1 })
    expect(store.notifiedAtOf(appealId)).toBeNull()

    failNext = false
    expect(await service.runOnce()).toEqual({ scanned: 1, sent: 1, failed: 0 })
    expect(store.notifiedAtOf(appealId)).toBeInstanceOf(Date)
    expect(recording.countOf('sendMessage')).toBe(2)
  })

  test('已结案的申诉不再补发（owner 已经处理过它）', async () => {
    const store = createInMemoryRepos()
    await seedAppeal(store, { kind: 'delete' })
    await store.repos.appeals.resolve(appealId, 'upheld', new Date('2026-09-23T10:10:00Z'), ownerId, false)
    const recording: RecordingApi = createRecordingApi()
    const service = createAppealNotificationService({
      api: recording.api,
      repos: store.repos,
      ownerUserId: ownerId,
      logger: silentLogger,
    })

    expect(await service.runOnce()).toEqual({ scanned: 0, sent: 0, failed: 0 })
    expect(recording.calls).toEqual([])
  })
})

/**
 * 收窄录制记录里的方法名列表。
 *
 * @param recording 录制 api。
 * @returns 已调用的方法名。
 */
function recordedMethods(recording: RecordingApi): string[] {
  return recording.calls.map((call) => call.method)
}
