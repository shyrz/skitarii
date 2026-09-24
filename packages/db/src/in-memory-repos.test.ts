import { asChatId, asUserId, type ModerationDecision } from '@skitarii/core'
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
