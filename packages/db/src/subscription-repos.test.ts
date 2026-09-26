import { asChatId, asUserId, type SubscriptionMember } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import { createInMemoryRepos, type InMemoryRepos } from './in-memory-repos.js'
import type { MemberEventObservation } from './repos.js'

/**
 * Phase 3b 新台账的内存实现行为测试。
 *
 * PG 的 SQL 形状在 `pg-repos.test.ts` 断言；这里覆盖两种实现必须逐字一致的语义：
 * 幂等请求、条件写/CAS、事件高水位与对账水位、失败不改事实、公平扫描与租约、稳定分页与计数。
 */

const chatId = asChatId('-1001234567890')
const ownerUserId = asUserId(1_000_000_001)
const userId = asUserId(7_000_000_002)
const now = new Date('2026-09-26T10:00:00Z')

const linkId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'

/** 预置一个 active 链接。 */
async function seedLink(store: InMemoryRepos): Promise<void> {
  const reserved = await store.repos.subscriptionLinks.reserveCreate({
    id: linkId,
    chatId,
    ownerUserId,
    requestId,
    requestHash: 'hash-1',
    name: '月度',
    priceStars: 500,
    periodSeconds: 2_592_000,
    createdAt: new Date('2026-09-26T09:00:00Z'),
  })
  expect(reserved.kind).toBe('reserved')
  await store.repos.subscriptionLinks.finishCreate(linkId, {
    inviteLink: 'https://t.me/+abcdefghijklmnop',
    finishedAt: new Date('2026-09-26T09:00:01Z'),
  })
}

/** 预置一个成员：有 until_date 证据。 */
async function seedMember(
  store: InMemoryRepos,
  overrides: Partial<MemberEventObservation> = {},
): Promise<SubscriptionMember> {
  const observation: MemberEventObservation = {
    chatId,
    userId,
    state: 'member',
    expiresAt: new Date('2026-10-26T10:00:00Z'),
    evidence: 'until_date',
    linkId: null,
    isJoin: true,
    eventDate: 1_758_000_000,
    eventUpdateId: 10,
    observedAt: new Date('2026-09-26T09:30:00Z'),
    ...overrides,
  }
  const outcome = await store.repos.subscriptionMembers.applyEvent(observation)
  expect(['inserted', 'updated']).toContain(outcome)
  const stored = await store.repos.subscriptionMembers.find(observation.chatId, observation.userId)
  if (stored === null) throw new Error('成员预置失败')
  return stored
}

describe('内存实现：订阅链接台账', () => {
  test('同一 (owner, requestId) 重放返回原行，不产生第二行', async () => {
    const store = createInMemoryRepos()
    const input = {
      id: linkId,
      chatId,
      ownerUserId,
      requestId,
      requestHash: 'hash-1',
      name: '月度',
      priceStars: 500,
      periodSeconds: 2_592_000,
      createdAt: now,
    }

    const first = await store.repos.subscriptionLinks.reserveCreate(input)
    const second = await store.repos.subscriptionLinks.reserveCreate({ ...input, id: 'different-id' })

    expect(first.kind).toBe('reserved')
    expect(second.kind).toBe('existing')
    expect(second.link.id).toBe(linkId)
  })

  test('finishCreate 之后 reserveCreate 重放仍是同一 active 行；requestHash 不因改名变化', async () => {
    const store = createInMemoryRepos()
    await seedLink(store)

    const replay = await store.repos.subscriptionLinks.reserveCreate({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      chatId,
      ownerUserId,
      requestId,
      requestHash: 'hash-1',
      name: '改名后的名字',
      priceStars: 500,
      periodSeconds: 2_592_000,
      createdAt: now,
    })

    expect(replay.kind).toBe('existing')
    expect(replay.link.state).toBe('active')
    expect(replay.link.requestHash).toBe('hash-1')
    expect(replay.link.inviteLink).toBe('https://t.me/+abcdefghijklmnop')
  })

  test('markCreateOutcome 只从 creating 迁移，已完成的行不被迟到结果改写', async () => {
    const store = createInMemoryRepos()
    await store.repos.subscriptionLinks.reserveCreate({
      id: linkId,
      chatId,
      ownerUserId,
      requestId,
      requestHash: 'hash-1',
      name: '',
      priceStars: 1,
      periodSeconds: 2_592_000,
      createdAt: now,
    })

    await store.repos.subscriptionLinks.markCreateOutcome(linkId, 'create_unknown', now)
    expect((await store.repos.subscriptionLinks.findById(chatId, linkId))?.state).toBe('create_unknown')

    // create_unknown 可继续 finish 到 active。
    expect(
      await store.repos.subscriptionLinks.finishCreate(linkId, {
        inviteLink: 'https://t.me/+xyz',
        finishedAt: now,
      }),
    ).toBe(true)

    await store.repos.subscriptionLinks.markCreateOutcome(linkId, 'create_failed', now)
    expect((await store.repos.subscriptionLinks.findById(chatId, linkId))?.state).toBe('active')
  })

  test('claimMutation：版本不匹配 → conflict(version)，活跃占位 → conflict(in_progress)，撤销后 → revoked', async () => {
    const store = createInMemoryRepos()
    await seedLink(store)

    const claimed = await store.repos.subscriptionLinks.claimMutation(chatId, linkId, 1, 'rename', now)
    expect(claimed.kind).toBe('claimed')
    if (claimed.kind !== 'claimed') return

    // 版本已被 claim 递增；再用旧版本 claim → version 冲突。
    expect(await store.repos.subscriptionLinks.claimMutation(chatId, linkId, 1, 'revoke', now)).toEqual({
      kind: 'conflict',
      reason: 'version',
    })
    // 同版本但占位未过期 → in_progress。
    expect(await store.repos.subscriptionLinks.claimMutation(chatId, linkId, 2, 'revoke', now)).toEqual({
      kind: 'conflict',
      reason: 'in_progress',
    })
    // 占位超过 60 秒可被替换。
    const later = new Date(now.getTime() + 61_000)
    expect((await store.repos.subscriptionLinks.claimMutation(chatId, linkId, 2, 'revoke', later)).kind).toBe('claimed')
  })

  test('finishMutation：token 不匹配或已撤销时不生效，revoked 不复活', async () => {
    const store = createInMemoryRepos()
    await seedLink(store)
    const claim = await store.repos.subscriptionLinks.claimMutation(chatId, linkId, 1, 'revoke', now)
    if (claim.kind !== 'claimed') throw new Error('claim 失败')

    // 错 token：不生效。
    expect(await store.repos.subscriptionLinks.finishMutation(linkId, 'wrong-token', { kind: 'revoked', revokedAt: now }, now)).toBe(false)
    // 正确 token：生效。
    expect(await store.repos.subscriptionLinks.finishMutation(linkId, claim.token, { kind: 'revoked', revokedAt: now }, now)).toBe(true)

    const revoked = await store.repos.subscriptionLinks.findById(chatId, linkId)
    expect(revoked?.state).toBe('revoked')
    expect(revoked?.revokedAt?.toISOString()).toBe(now.toISOString())

    // 迟到的 rename 提交不能复活 revoked。
    expect(
      await store.repos.subscriptionLinks.finishMutation(linkId, claim.token, { kind: 'renamed', name: '迟到' }, now),
    ).toBe(false)
    expect((await store.repos.subscriptionLinks.findById(chatId, linkId))?.state).toBe('revoked')
  })

  test('releaseMutation 只释放自己的占位', async () => {
    const store = createInMemoryRepos()
    await seedLink(store)
    const claim = await store.repos.subscriptionLinks.claimMutation(chatId, linkId, 1, 'rename', now)
    if (claim.kind !== 'claimed') throw new Error('claim 失败')

    await store.repos.subscriptionLinks.releaseMutation(linkId, 'other')
    expect((await store.repos.subscriptionLinks.findById(chatId, linkId))?.operationToken).toBe(claim.token)
    await store.repos.subscriptionLinks.releaseMutation(linkId, claim.token)
    expect((await store.repos.subscriptionLinks.findById(chatId, linkId))?.operationToken).toBeNull()
  })

  test('链接分页按 (createdAt,id) 倒序，同毫秒不漏不重、可翻页', async () => {
    const store = createInMemoryRepos()
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const id = `0000000${index}-0000-4000-8000-000000000000`
      ids.push(id)
      await store.repos.subscriptionLinks.reserveCreate({
        id,
        chatId,
        ownerUserId,
        requestId: `0000000${index}-0000-4000-8000-00000000000${index}`,
        requestHash: 'h',
        name: '',
        priceStars: 1,
        periodSeconds: 2_592_000,
        createdAt: new Date('2026-09-26T10:00:00Z'),
      })
    }

    const first = await store.repos.subscriptionLinks.listPage({ chatId, limit: 3 })
    expect(first.map((link) => link.id)).toEqual([ids[4], ids[3], ids[2]])
    const last = first[first.length - 1]
    if (last === undefined) throw new Error('缺行')
    const second = await store.repos.subscriptionLinks.listPage({
      chatId,
      before: { createdAt: last.createdAt, id: last.id },
      limit: 3,
    })
    expect(second.map((link) => link.id)).toEqual([ids[1], ids[0]])
  })
})

describe('内存实现：订阅成员台账', () => {
  test('事件按 (date, update_id) 高水位：重复与更旧事件被忽略，同秒按 update_id', async () => {
    const store = createInMemoryRepos()
    const member = await seedMember(store)

    const older = await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'left',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: false,
      eventDate: member.lastEventDate ?? 0,
      eventUpdateId: (member.lastEventUpdateId ?? 0) - 1,
      observedAt: now,
    })
    expect(older).toBe('ignored')

    const sameSecondOlder = await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'left',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: false,
      eventDate: member.lastEventDate ?? 0,
      eventUpdateId: member.lastEventUpdateId ?? 0,
      observedAt: now,
    })
    expect(sameSecondOlder).toBe('ignored')

    const sameSecondNewer = await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'left',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: true,
      eventDate: member.lastEventDate ?? 0,
      eventUpdateId: (member.lastEventUpdateId ?? 0) + 1,
      observedAt: now,
    })
    expect(sameSecondNewer).toBe('updated')
    const left = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(left?.state).toBe('left')
    expect(left?.expiresAt).toBeNull()
    expect(left?.version).toBe(member.version + 1)
  })

  test('无证据且不存在的新行返回 ignored，不落库、不抛错（资格判定在记录器）', async () => {
    const store = createInMemoryRepos()

    const outcome = await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'member',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: true,
      eventDate: 1,
      eventUpdateId: 1,
      observedAt: now,
    })

    expect(outcome).toBe('ignored')
    expect(await store.repos.subscriptionMembers.find(chatId, userId)).toBeNull()
  })

  test('无证据的离开/升级事件对已有行仍可更新，并保留历史 evidence', async () => {
    const store = createInMemoryRepos()
    await seedMember(store, { evidence: 'until_date', expiresAt: new Date('2026-10-26T10:00:00Z') })

    const outcome = await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'left',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: false,
      eventDate: 1_758_000_900,
      eventUpdateId: 90,
      observedAt: now,
    })

    expect(outcome).toBe('updated')
    const stored = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(stored?.state).toBe('left')
    expect(stored?.expiresAt).toBeNull()
    // 本次没有肯定证据：历史 evidence 保留。
    expect(stored?.evidence).toBe('until_date')
  })

  test('明确新一轮加入且无匹配链接时 linkId 置 null；普通状态更新保留历史 linkId', async () => {
    const store = createInMemoryRepos()
    await seedMember(store, { linkId })

    // 非加入事件：保留历史来源。
    await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'member',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: false,
      eventDate: 1_758_000_100,
      eventUpdateId: 11,
      observedAt: now,
    })
    expect((await store.repos.subscriptionMembers.find(chatId, userId))?.linkId).toBe(linkId)

    // 明确的新一轮加入但无可匹配链接：清空来源。
    await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'member',
      expiresAt: new Date('2026-11-26T10:00:00Z'),
      evidence: 'until_date',
      linkId: null,
      isJoin: true,
      eventDate: 1_758_000_200,
      eventUpdateId: 12,
      observedAt: now,
    })
    const rejoined = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(rejoined?.linkId).toBeNull()
    expect(rejoined?.expiresAt?.toISOString()).toBe('2026-11-26T10:00:00.000Z')
    expect(rejoined?.evidence).toBe('until_date')
  })

  test('成功对账后，同秒的迟到事件只推进高水位与 version，不改事实', async () => {
    const store = createInMemoryRepos()
    const member = await seedMember(store)
    const requestStartedAt = new Date('2026-09-26T10:00:00Z')
    const claim = (
      await store.repos.subscriptionMembers.claimChecks({ now: requestStartedAt, limit: 1, leaseMs: 60_000 })
    )[0]
    if (claim === undefined) throw new Error('claim 失败')
    expect(
      await store.repos.subscriptionMembers.finishCheck(claim, {
        kind: 'ok',
        state: 'left',
        expiresAt: null,
        returnedAt: new Date('2026-09-26T10:00:01Z'),
      }),
    ).toBe('applied')
    const reconciled = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(reconciled?.state).toBe('left')
    expect(reconciled?.reconciledThrough?.toISOString()).toBe(requestStartedAt.toISOString())

    // 事件时间与对账开始同秒（甚至更早）：事实不变，只推进高水位。
    const stale = await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'member',
      expiresAt: new Date('2026-10-26T10:00:00Z'),
      evidence: 'until_date',
      linkId: null,
      isJoin: true,
      eventDate: Math.floor(requestStartedAt.getTime() / 1_000),
      eventUpdateId: (member.lastEventUpdateId ?? 0) + 5,
      observedAt: now,
    })
    expect(stale).toBe('updated')
    const afterStale = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(afterStale?.state).toBe('left')
    expect(afterStale?.expiresAt).toBeNull()
    expect(afterStale?.linkId).toBe(member.linkId)
    expect(afterStale?.version).toBe((reconciled?.version ?? 0) + 1)

    // 晚于对账开始秒的事件可以应用。
    await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'member',
      expiresAt: new Date('2026-10-26T10:00:00Z'),
      evidence: 'until_date',
      linkId: null,
      isJoin: true,
      eventDate: Math.floor(requestStartedAt.getTime() / 1_000) + 1,
      eventUpdateId: 99,
      observedAt: now,
    })
    expect((await store.repos.subscriptionMembers.find(chatId, userId))?.state).toBe('member')
  })

  test('对账成功用查询开始时刻做观测值与水位；失败只写错误码，不改事实', async () => {
    const store = createInMemoryRepos()
    const member = await seedMember(store)
    const requestStartedAt = new Date('2026-09-26T11:00:00Z')

    const failedClaim = (
      await store.repos.subscriptionMembers.claimChecks({ now: requestStartedAt, limit: 1, leaseMs: 60_000 })
    )[0]
    if (failedClaim === undefined) throw new Error('claim 失败')
    expect(
      await store.repos.subscriptionMembers.finishCheck(failedClaim, {
        kind: 'failed',
        errorCode: 'telegram_failed',
        checkedAt: new Date('2026-09-26T11:00:01Z'),
      }),
    ).toBe('applied')
    const afterFailure = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(afterFailure?.state).toBe(member.state)
    expect(afterFailure?.expiresAt?.toISOString()).toBe(member.expiresAt?.toISOString())
    expect(afterFailure?.observedAt.toISOString()).toBe(member.observedAt.toISOString())
    expect(afterFailure?.lastCheckErrorCode).toBe('telegram_failed')
    expect(afterFailure?.lastCheckedAt?.toISOString()).toBe(requestStartedAt.toISOString())
    expect(afterFailure?.version).toBe(member.version)

    const okClaim = (
      await store.repos.subscriptionMembers.claimChecks({ now: new Date('2026-09-26T12:00:00Z'), limit: 1, leaseMs: 60_000 })
    )[0]
    if (okClaim === undefined) throw new Error('claim 失败')
    await store.repos.subscriptionMembers.finishCheck(okClaim, {
      kind: 'ok',
      state: 'member',
      expiresAt: null,
      returnedAt: new Date('2026-09-26T12:00:01Z'),
    })
    const afterOk = await store.repos.subscriptionMembers.find(chatId, userId)
    expect(afterOk?.observedAt.toISOString()).toBe('2026-09-26T12:00:00.000Z')
    expect(afterOk?.reconciledThrough?.toISOString()).toBe('2026-09-26T12:00:00.000Z')
    expect(afterOk?.lastCheckSucceededAt?.toISOString()).toBe('2026-09-26T12:00:01.000Z')
    expect(afterOk?.lastCheckErrorCode).toBeNull()
  })

  test('查询期间事件写入会使在途结果 stale（version 变化）', async () => {
    const store = createInMemoryRepos()
    await seedMember(store)
    const claim = (
      await store.repos.subscriptionMembers.claimChecks({ now: new Date('2026-09-26T12:00:00Z'), limit: 1, leaseMs: 60_000 })
    )[0]
    if (claim === undefined) throw new Error('claim 失败')

    await store.repos.subscriptionMembers.applyEvent({
      chatId,
      userId,
      state: 'left',
      expiresAt: null,
      evidence: null,
      linkId: null,
      isJoin: true,
      eventDate: 1_758_001_000,
      eventUpdateId: 50,
      observedAt: new Date('2026-09-26T12:00:01Z'),
    })

    expect(
      await store.repos.subscriptionMembers.finishCheck(claim, {
        kind: 'ok',
        state: 'member',
        expiresAt: null,
        returnedAt: new Date('2026-09-26T12:00:02Z'),
      }),
    ).toBe('stale')
    expect((await store.repos.subscriptionMembers.find(chatId, userId))?.state).toBe('left')
  })

  test('claimChecks：跳过未过期租约、公平推进 lastCheckedAt、失败也参与下一轮', async () => {
    const store = createInMemoryRepos()
    for (let index = 0; index < 3; index += 1) {
      await seedMember(store, {
        userId: asUserId(7_000_000_100 + index),
        eventDate: 1_758_000_000,
        eventUpdateId: index + 1,
      })
    }

    const first = await store.repos.subscriptionMembers.claimChecks({ now: new Date('2026-09-26T12:00:00Z'), limit: 2, leaseMs: 60_000 })
    expect(first).toHaveLength(2)
    // 未过期租约的行不会被再次 claim。
    const second = await store.repos.subscriptionMembers.claimChecks({ now: new Date('2026-09-26T12:00:30Z'), limit: 5, leaseMs: 60_000 })
    expect(second).toHaveLength(1)
    expect(second[0]?.memberId).not.toBe(first[0]?.memberId)

    // 失败也推进 lastCheckedAt：租约过期后回到队尾，但仍在候选集里。
    const third = await store.repos.subscriptionMembers.claimChecks({ now: new Date('2026-09-26T12:02:00Z'), limit: 5, leaseMs: 60_000 })
    expect(third).toHaveLength(3)
  })

  test('计数是独立聚合，不受分页影响', async () => {
    const store = createInMemoryRepos()
    await seedMember(store, { userId: asUserId(1), state: 'member' })
    await seedMember(store, { userId: asUserId(2), state: 'left', eventUpdateId: 11 })
    await seedMember(store, { userId: asUserId(3), state: 'unknown', eventUpdateId: 12 })

    expect(await store.repos.subscriptionMembers.countByState(chatId)).toEqual({
      known: 3,
      member: 1,
      left: 1,
      unknown: 1,
    })
    expect(await store.repos.subscriptionMembers.listPage({ chatId, limit: 1 })).toHaveLength(1)
  })
})
