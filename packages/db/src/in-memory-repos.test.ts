import { asChatId, asUserId, type ChatId, type ModerationDecision, type UserId } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import { createInMemoryRepos, type InMemoryRepos } from './in-memory-repos.js'

/**
 * 内存实现的边界行为。
 *
 * PG 的 SQL 形状在 `pg-repos.test.ts` 里断言；这里只覆盖双实现必须逐字一致、且不依赖驱动的语义，
 * 以及那些在真库上反而不好构造的边界（不存在的决策、覆盖写）。
 */

const decisionId = '9c8b7a65-1111-4222-8333-999900001111'
const chatId = asChatId('-1001234567890')
const userId = asUserId(7_000_000_001)

/** 预置一条决策。 */
async function seedDecision(store: InMemoryRepos): Promise<void> {
  const decision: ModerationDecision = {
    id: decisionId,
    eventId: '3f1d0c9a-1111-4222-8333-444455556666',
    chatId,
    userId,
    action: { kind: 'delete' },
    score: 0.9,
    signals: [],
    decidedAt: new Date('2026-09-23T10:00:00Z'),
    executed: true,
  }
  await store.repos.decisions.insert(decision)
}

describe('内存实现：通知引用边界', () => {
  test('决策不存在时不写入（与 PG 的 UPDATE ... WHERE 对齐）', async () => {
    const store = createInMemoryRepos()

    await store.repos.decisions.markNoticeSent(decisionId, String(userId), 77)

    expect(await store.repos.decisions.findNoticeRef(decisionId)).toBeNull()
  })

  test('重复 mark 覆盖为最新一条（与 PG 的无条件 UPDATE 对齐）', async () => {
    const store = createInMemoryRepos()
    await seedDecision(store)

    await store.repos.decisions.markNoticeSent(decisionId, String(userId), 77)
    await store.repos.decisions.markNoticeSent(decisionId, String(chatId), 88)

    expect(await store.repos.decisions.findNoticeRef(decisionId)).toEqual({ chatId: String(chatId), messageId: 88 })
  })

  test('未记录的决策读取为 null（对应 PG 两列皆空）', async () => {
    const store = createInMemoryRepos()
    await seedDecision(store)

    expect(await store.repos.decisions.findNoticeRef(decisionId)).toBeNull()
  })
})

/** 预置一条误伤样本：事件（可带摘录）+ 非 pass 决策 + 已结案申诉。 */
async function seedSample(
  store: InMemoryRepos,
  options: {
    id: string
    chatId?: ChatId
    userId?: UserId
    contentHash: string
    resolvedAt: Date
    sampleText?: string | null
    state?: 'overturned' | 'upheld'
  },
): Promise<void> {
  const targetChat = options.chatId ?? chatId
  const targetUser = options.userId ?? userId
  await store.repos.events.insert({
    id: `ev-${options.id}`,
    chatId: targetChat,
    userId: targetUser,
    messageId: 1,
    contentHash: options.contentHash,
    features: { hasLink: false, mediaType: 'text', length: 4, customEmojiCount: 0 },
    createdAt: options.resolvedAt,
  })
  await store.repos.decisions.insert({
    id: `dec-${options.id}`,
    eventId: `ev-${options.id}`,
    chatId: targetChat,
    userId: targetUser,
    action: { kind: 'delete' },
    score: 0.9,
    signals: [],
    decidedAt: options.resolvedAt,
    executed: true,
  })
  await store.repos.appeals.insert({
    id: options.id,
    decisionId: `dec-${options.id}`,
    userId: targetUser,
    state: options.state ?? 'overturned',
    note: null,
    createdAt: options.resolvedAt,
    resolvedAt: options.resolvedAt,
  })
  if (options.sampleText !== undefined && options.sampleText !== null) {
    await store.repos.events.attachSample(`ev-${options.id}`, options.sampleText)
  }
}

describe('内存实现：误伤样本', () => {
  test('只取该群时间窗内的撤销结案，按结案时间倒序、限量，摘录可空', async () => {
    const store = createInMemoryRepos()
    const since = new Date('2026-09-01T00:00:00Z')

    await seedSample(store, { id: 's-new', contentHash: 'h-new', resolvedAt: new Date('2026-09-23T10:00:00Z'), sampleText: '新摘录' })
    await seedSample(store, { id: 's-old', contentHash: 'h-old', resolvedAt: new Date('2026-09-21T10:00:00Z'), sampleText: null })
    // 以下三条都不该出现：维持结案、窗口外、别的群。
    await seedSample(store, { id: 's-upheld', contentHash: 'h-up', resolvedAt: new Date('2026-09-22T10:00:00Z'), sampleText: 'x', state: 'upheld' })
    await seedSample(store, { id: 's-expired', contentHash: 'h-ex', resolvedAt: new Date('2026-08-01T10:00:00Z'), sampleText: 'y' })
    await seedSample(store, { id: 's-other', contentHash: 'h-ot', resolvedAt: new Date('2026-09-22T10:00:00Z'), sampleText: 'z', chatId: asChatId('-1009999999999') })

    const samples = await store.repos.appeals.listOverturnedSamples(chatId, since, 5)

    expect(samples).toEqual([
      { userId, contentHash: 'h-new', sampleText: '新摘录', resolvedAt: new Date('2026-09-23T10:00:00Z') },
      { userId, contentHash: 'h-old', sampleText: null, resolvedAt: new Date('2026-09-21T10:00:00Z') },
    ])

    // limit 作用于倒序后的前几条。
    expect((await store.repos.appeals.listOverturnedSamples(chatId, since, 1)).map((sample) => sample.contentHash)).toEqual(['h-new'])
  })

  test('决策存在但事件行缺失时跳过该样本（与 PG 的 join 语义一致）', async () => {
    const store = createInMemoryRepos()
    await store.repos.decisions.insert({
      id: 'dec-orphan',
      eventId: 'ev-missing',
      chatId,
      userId,
      action: { kind: 'delete' },
      score: 0.9,
      signals: [],
      decidedAt: new Date('2026-09-23T10:00:00Z'),
      executed: true,
    })
    await store.repos.appeals.insert({
      id: 's-orphan',
      decisionId: 'dec-orphan',
      userId,
      state: 'overturned',
      note: null,
      createdAt: new Date('2026-09-23T10:00:00Z'),
      resolvedAt: new Date('2026-09-23T10:00:00Z'),
    })

    expect(await store.repos.appeals.listOverturnedSamples(chatId, new Date('2026-09-01T00:00:00Z'), 5)).toEqual([])
  })

  test('resolvedAt 恰好等于 since 时命中（左闭区间）', async () => {
    const store = createInMemoryRepos()
    const since = new Date('2026-09-01T00:00:00Z')
    await seedSample(store, { id: 's-edge', contentHash: 'h-edge', resolvedAt: since, sampleText: '边界样本' })

    const samples = await store.repos.appeals.listOverturnedSamples(chatId, since, 5)

    expect(samples.map((sample) => sample.contentHash)).toEqual(['h-edge'])
  })

  test('同刻结案按 id 倒序（与 PG 的 ORDER BY resolved_at DESC, id DESC 同序）', async () => {
    const store = createInMemoryRepos()
    const resolvedAt = new Date('2026-09-23T10:00:00Z')
    await seedSample(store, { id: 'sample-a', contentHash: 'h-a', resolvedAt })
    await seedSample(store, { id: 'sample-b', contentHash: 'h-b', resolvedAt })

    const samples = await store.repos.appeals.listOverturnedSamples(chatId, new Date('2026-09-01T00:00:00Z'), 5)

    // id 更大的在前（'sample-b' > 'sample-a'）。
    expect(samples.map((sample) => sample.contentHash)).toEqual(['h-b', 'h-a'])
  })

  test('limit 为 0、负数或小数时按 max(0, trunc) 归一', async () => {
    const store = createInMemoryRepos()
    const since = new Date('2026-09-01T00:00:00Z')
    await seedSample(store, { id: 'sample-1', contentHash: 'h-1', resolvedAt: new Date('2026-09-23T10:00:00Z') })
    await seedSample(store, { id: 'sample-2', contentHash: 'h-2', resolvedAt: new Date('2026-09-22T10:00:00Z') })

    expect(await store.repos.appeals.listOverturnedSamples(chatId, since, 0)).toEqual([])
    expect(await store.repos.appeals.listOverturnedSamples(chatId, since, -1)).toEqual([])
    expect((await store.repos.appeals.listOverturnedSamples(chatId, since, 1.9)).map((sample) => sample.contentHash)).toEqual(['h-1'])
  })
})
