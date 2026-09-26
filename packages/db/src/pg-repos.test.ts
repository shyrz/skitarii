import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asChatId, asUserId, type ChatConfig } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Db } from './client.js'
import { createPgRepos } from './pg-repos.js'
import type { MemberEventObservation } from './repos.js'
import * as schema from './schema.js'
import { SAMPLE_TEXT_MAX_LENGTH } from './schema.js'

/**
 * 仓储 SQL 的自测。
 *
 * 本机（以及 CI）没有可连的 Postgres，因此不连库、也不 mock 仓储：
 * 用真实的 drizzle 查询构造器 + 一个只记录 `unsafe(query, params)` 的假驱动，
 * 断言仓储真正发出去的 SQL 与参数。这样能验证三件事：
 * 1. 语句形状（幂等写的冲突目标、隐私条件、保留期条件）；
 * 2. 写入全部走参数占位符，用户可控文本不进 SQL 字面量；
 * 3. 行到领域对象的映射路径（读路径用预置行驱动）。
 *
 * 假驱动只需要 drizzle 构造期与执行期用到的两个成员：`options.parsers/serializers`（驱动构造里写入）
 * 与 `unsafe`（执行入口）。返回的 thenable 同时带 `values()`，覆盖「有字段映射」与「无字段」两条执行分支。
 */

interface RecordedQuery {
  query: string
  params: unknown[]
}

interface RecordingDb {
  db: Db
  recorded: RecordedQuery[]
}

/**
 * 构造记录型假驱动。
 *
 * @param rows 查询返回的行。读路径按原样返回；带字段映射的读路径（`returning`）只用到行数。
 * @param rowsPerCall 逐次查询的返回行；提供时优先于 `rows`（用于区分 insert/update 两条语句的返回）。
 * @returns drizzle 实例与已记录的语句列表。
 */
function createRecordingDb(rows: unknown[] = [], rowsPerCall?: unknown[][]): RecordingDb {
  const recorded: RecordedQuery[] = []
  const client = {
    options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
    unsafe(query: string, params: unknown[]) {
      recorded.push({ query, params })
      const callRows = rowsPerCall?.[recorded.length - 1] ?? rows
      // postgres.js 的 PendingQuery 是 thenable，同时提供 .values()（数组行模式）。
      const pending = Promise.resolve(callRows) as Promise<unknown> & { values: () => Promise<unknown> }
      pending.values = () => Promise.resolve(callRows)
      return pending
    },
  }

  return { db: drizzle(client as never, { schema }), recorded }
}

const chatConfigFixture: ChatConfig = {
  chatId: asChatId('-1001234567890'),
  title: '测试群',
  chatType: 'supergroup',
  linkedChatId: asChatId('-1009999999999'),
  language: 'zh',
  rules: [{ id: 'rule-1', kind: 'keyword', pattern: '广告', score: 0.4, actionHint: 'delete', enabled: true }],
  whitelist: [asUserId(7_000_000_001), asUserId(7_000_000_002)],
  passThreshold: 0.35,
  llmThreshold: 0.8,
  muteDurationMinutes: 60,
}

describe('写入语句的形状与参数化', () => {
  test('事件落库用占位符传值，并按主键忽略重放', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.events.insert({
      id: '3f1d0c9a-1111-4222-8333-444455556666',
      chatId: chatConfigFixture.chatId,
      userId: asUserId(7_000_000_001),
      messageId: 42,
      contentHash: 'a'.repeat(64),
      features: { hasLink: true, mediaType: 'photo', length: 18, customEmojiCount: 2, emojiCount: 5, viaBot: true },
      createdAt: new Date('2026-09-23T10:00:00Z'),
    })

    const [statement] = recorded
    expect(statement?.query).toContain('insert into "message_events"')
    expect(statement?.query).toContain('on conflict ("id") do nothing')
    // 时间列在驱动层被序列化成 ISO 字符串（drizzle 的 postgres-js 列映射），断言按实际发出的值写。
    expect(statement?.params).toEqual([
      '3f1d0c9a-1111-4222-8333-444455556666',
      '-1001234567890',
      7_000_000_001,
      42,
      'a'.repeat(64),
      true,
      'photo',
      18,
      2,
      5,
      true,
      '2026-09-23T10:00:00.000Z',
    ])
  })

  test('摘录补写带「存在非 pass 决策」的条件，并把超长文本截断后参数化传入', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.events.attachSample('3f1d0c9a-1111-4222-8333-444455556666', '炸'.repeat(500))

    const [statement] = recorded
    expect(statement?.query).toContain('update "message_events"')
    expect(statement?.query).toContain('exists')
    expect(statement?.query).toContain('"action" <>')
    expect(statement?.params).toEqual(['炸'.repeat(SAMPLE_TEXT_MAX_LENGTH), '3f1d0c9a-1111-4222-8333-444455556666', 'pass'])
  })

  test('放行决策不计入累犯统计', async () => {
    const { repos, recorded } = createPgReposRecording([[2]])
    const since = new Date('2026-09-16T00:00:00Z')
    const total = await repos.decisions.countPriorViolations(chatConfigFixture.chatId, asUserId(7_000_000_001), since)

    expect(total).toBe(2)
    const [statement] = recorded
    expect(statement?.query).toContain('count(*)')
    expect(statement?.query).toContain('"action" <>')
    expect(statement?.params).toEqual(['-1001234567890', 7_000_000_001, '2026-09-16T00:00:00.000Z', 'pass'])
  })

  test('结案只对未结案记录生效，条件更新在同一条语句里写「待回滚」标记', async () => {
    const appealId = 'a1b2c3d4-1111-4222-8333-555566667777'
    const resolvedAt = new Date('2026-09-23T10:30:00Z')

    const claimed = createPgReposRecording([[appealId]])
    const claimedResult = await claimed.repos.appeals.resolve(
      appealId,
      'overturned',
      resolvedAt,
      asUserId(1_000_000_001),
      true,
    )

    expect(claimedResult).toBe(true)
    const [statement] = claimed.recorded
    // 标记与状态同一条 UPDATE：结案与「待回滚」之间没有不可见的中间态。
    expect(statement?.query).toContain('set "state" = $1, "resolved_at" = $2, "resolved_by" = $3, "rollback_pending" = $4')
    expect(statement?.query).toContain('"state" = ')
    expect(statement?.query).toContain('returning')
    expect(statement?.params).toEqual([
      'overturned',
      '2026-09-23T10:30:00.000Z',
      1_000_000_001,
      true,
      appealId,
      'open',
    ])

    // 0 行（并发重复点击）时返回 false：调用方据此不再回滚权限、也不再报成功。
    const missed = createPgReposRecording([])
    expect(
      await missed.repos.appeals.resolve(appealId, 'overturned', resolvedAt, asUserId(1_000_000_001), true),
    ).toBe(false)
  })

  test('清除回滚标记与回滚补偿扫描的 SQL 形状', async () => {
    const appealId = 'a1b2c3d4-1111-4222-8333-555566667777'

    const cleared = createPgReposRecording([])
    await cleared.repos.appeals.clearRollbackPending(appealId)
    const [update] = cleared.recorded
    expect(update?.query).toContain('update "appeals"')
    expect(update?.query).toContain('set "rollback_pending" = $1')
    expect(update?.params).toEqual([false, appealId])

    const scan = createPgReposRecording([])
    expect(await scan.repos.appeals.listPendingRollback(20)).toEqual([])
    const [select] = scan.recorded
    expect(select?.query).toContain('"state" = $1')
    expect(select?.query).toContain('"rollback_pending" = $2')
    expect(select?.query).toContain('order by "appeals"."resolved_at" asc')
    expect(select?.query).toContain('limit')
    expect(select?.params).toEqual(['overturned', true, 20])
  })

  test('通知回填写 notified_at，补发扫描取 open 且未通知的申诉', async () => {
    const appealId = 'a1b2c3d4-1111-4222-8333-555566667777'
    const notifiedAt = new Date('2026-09-23T10:06:00Z')

    const backfill = createPgReposRecording([])
    await backfill.repos.appeals.markNotified(appealId, notifiedAt)

    const [update] = backfill.recorded
    expect(update?.query).toContain('update "appeals"')
    expect(update?.query).toContain('set "notified_at" = $1')
    expect(update?.params).toEqual(['2026-09-23T10:06:00.000Z', appealId])

    const scan = createPgReposRecording([])
    expect(await scan.repos.appeals.listPendingNotification(20)).toEqual([])

    const [select] = scan.recorded
    expect(select?.query).toContain('"notified_at" is null')
    expect(select?.query).toContain('order by "appeals"."created_at" asc')
    expect(select?.query).toContain('limit')
    expect(select?.params).toEqual(['open', 20])
  })

  test('申诉按决策唯一，重复提交在数据库层被忽略', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.appeals.insert({
      id: 'a1b2c3d4-1111-4222-8333-555566667777',
      decisionId: '9c8b7a65-1111-4222-8333-999900001111',
      userId: asUserId(7_000_000_001),
      state: 'open',
      note: '误判了',
      createdAt: new Date('2026-09-23T10:05:00Z'),
      resolvedAt: null,
    })

    const [statement] = recorded
    expect(statement?.query).toContain('insert into "appeals"')
    expect(statement?.query).toContain('on conflict ("decision_id") do nothing')
  })

  test('群配置覆盖写入按 chat_id 冲突更新，元数据列一并刷新', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.chats.upsert(chatConfigFixture)

    const [statement] = recorded
    expect(statement?.query).toContain('insert into "chats"')
    expect(statement?.query).toContain('on conflict ("chat_id") do update set')
    // 列顺序：chat_id / title / chat_type / linked_chat_id / language / rules / whitelist / 三个数值列。
    const params = statement?.params ?? []
    expect(params.slice(0, 5)).toEqual(['-1001234567890', '测试群', 'supergroup', '-1009999999999', 'zh'])
    // jsonb 列在驱动层序列化成 JSON 字符串后作为单个参数传入。
    expect(JSON.parse(String(params[5]))).toEqual(chatConfigFixture.rules)
    expect(JSON.parse(String(params[6]))).toEqual(chatConfigFixture.whitelist)
    expect(params.slice(7, 10)).toEqual([0.35, 0.8, 60])
    // 冲突更新分支重复一遍配置字段，最后一项是刷新过的 updated_at。
    expect(params.slice(10, 20)).toEqual([
      '测试群',
      'supergroup',
      '-1009999999999',
      'zh',
      params[5],
      params[6],
      0.35,
      0.8,
      60,
      params[19],
    ])
    expect(String(params[19])).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('首次登记用 on conflict do nothing：已存在的行绝不被默认配置覆盖', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.chats.register(chatConfigFixture)

    const [statement] = recorded
    expect(statement?.query).toContain('insert into "chats"')
    expect(statement?.query).toContain('on conflict ("chat_id") do nothing')
    // 没有任何 update 分支：登记不会触碰已有行的规则。
    expect(statement?.query).not.toContain('do update')
  })

  test('元数据刷新只清单列 UPDATE，规则与阈值不出现在语句里', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.chats.updateMetadata(chatConfigFixture.chatId, {
      title: '新标题',
      chatType: 'channel',
      linkedChatId: null,
    })

    const [statement] = recorded
    expect(statement?.query).toContain('update "chats"')
    expect(statement?.query).toContain('"title" = $1')
    expect(statement?.query).toContain('"chat_type" = $2')
    expect(statement?.query).toContain('"linked_chat_id" = $3')
    // 末尾固定刷新 updated_at，chat_id 只出现在 WHERE。
    expect(statement?.query).toContain('"updated_at" = $4')
    expect(statement?.query).toContain('where "chats"."chat_id" = $5')
    // 规则、阈值、语言都不在 SET 列表里（这是「不覆盖 owner 规则」的数据库层保证）。
    expect(statement?.query).not.toContain('"rules"')
    expect(statement?.query).not.toContain('"pass_threshold"')
    expect(statement?.query).not.toContain('"llm_threshold"')
    expect(statement?.query).not.toContain('"language"')
    expect(statement?.params?.slice(0, 3)).toEqual(['新标题', 'channel', null])
    expect(statement?.params?.[4]).toBe('-1001234567890')
  })

  test('元数据刷新未指定的字段不进 SET（避免无变化也写列）', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.chats.updateMetadata(chatConfigFixture.chatId, { title: '只改标题' })

    const [statement] = recorded
    expect(statement?.query).toContain('"title" = $1')
    expect(statement?.query).toContain('"updated_at" = $2')
    expect(statement?.query).not.toContain('"chat_type" =')
    expect(statement?.query).not.toContain('"linked_chat_id" =')
  })

  test('保留期清理按时间条件参数化删除', async () => {
    const { repos, recorded } = createPgReposRecording([['x'], ['y']])
    const cutoff = new Date('2026-08-24T00:00:00Z')
    const removedEvents = await repos.events.deleteOlderThan(cutoff)
    const removedCache = await repos.llmCache.deleteOlderThan(cutoff)

    expect(removedEvents).toBe(2)
    expect(removedCache).toBe(2)
    expect(recorded[0]?.query).toContain('delete from "message_events"')
    expect(recorded[0]?.params).toEqual(['2026-08-24T00:00:00.000Z'])
    expect(recorded[1]?.query).toContain('delete from "llm_cache"')
    expect(recorded[1]?.params).toEqual(['2026-08-24T00:00:00.000Z'])
  })
})

describe('读语句', () => {
  test('按 chat_id 读取群配置并解析规则集', async () => {
    // 带字段映射的读走 postgres.js 的 .values()，行是「按 select 字段顺序排列的数组」。
    // 顺序与 `select "chat_id", "title", ...` 一致；列顺序变了这里会一起失败，属于预期的耦合。
    const { repos, recorded } = createPgReposRecording([
      [
        '-1001234567890',
        '测试群',
        'supergroup',
        '-1009999999999',
        'zh',
        chatConfigFixture.rules,
        chatConfigFixture.whitelist,
        0.35,
        0.8,
        60,
        new Date('2026-09-01T00:00:00Z'),
        new Date('2026-09-01T00:00:00Z'),
      ],
    ])
    const config = await repos.chats.findByChatId(chatConfigFixture.chatId)

    expect(config).toEqual(chatConfigFixture)
    expect(recorded[0]?.query).toContain('where "chats"."chat_id" = $1')
    expect(recorded[0]?.params).toEqual(['-1001234567890', 1])
  })

  test('按决策读取申诉，未提交时得到 null', async () => {
    const { repos, recorded } = createPgReposRecording()
    const appeal = await repos.appeals.findByDecisionId('9c8b7a65-1111-4222-8333-999900001111')

    expect(appeal).toBeNull()
    expect(recorded[0]?.query).toContain('where "appeals"."decision_id" = $1')
    expect(recorded[0]?.params).toEqual(['9c8b7a65-1111-4222-8333-999900001111', 1])
  })

  test('日计数用一条语句取四个数，全部经占位符', async () => {
    const { repos, recorded } = createPgReposRecording([
      { message_count: 120, action_count: 7, appeal_count: 2, overturned_count: 1 },
    ])
    const from = new Date('2026-09-22T00:00:00Z')
    const to = new Date('2026-09-23T00:00:00Z')
    const counts = await repos.aggregates.countForDay(chatConfigFixture.chatId, from, to)

    expect(counts).toEqual({ messageCount: 120, actionCount: 7, appealCount: 2, overturnedCount: 1 })
    expect(recorded).toHaveLength(1)
    const [statement] = recorded
    expect(statement?.query.match(/select count\(\*\)(?:::int)?/g)?.length).toBe(4)
    expect(statement?.query).toContain('"action" <>')
    expect(statement?.query).toContain('"state" =')
    expect(statement?.params).toEqual([
      '-1001234567890',
      from,
      to,
      '-1001234567890',
      from,
      to,
      '-1001234567890',
      from,
      to,
      '-1001234567890',
      from,
      to,
    ])
  })

  test('补偿扫描只取窗口内未执行的决策，按判定时间升序并限量', async () => {
    const { repos, recorded } = createPgReposRecording([])
    const from = new Date('2026-09-22T12:00:00Z')
    const to = new Date('2026-09-23T11:50:00Z')
    expect(await repos.decisions.listUnexecutedBetween(from, to, 50)).toEqual([])

    const [statement] = recorded
    expect(statement?.query).toContain('"executed" = $1')
    expect(statement?.query).toContain('order by "moderation_decisions"."decided_at" asc')
    expect(statement?.query).toContain('limit')
    expect(statement?.params).toEqual([false, '2026-09-22T12:00:00.000Z', '2026-09-23T11:50:00.000Z', 50])
  })

  test('跨群处置流按 (decidedAt, id) 倒序分页，缺省只取非放行', async () => {
    const { repos, recorded } = createPgReposRecording([])
    expect(await repos.decisions.listRecent({ limit: 50 })).toEqual([])

    const [statement] = recorded
    expect(statement?.query).toContain('from "moderation_decisions"')
    expect(statement?.query).toContain('"action" <> $1')
    expect(statement?.query).toContain(
      'order by "moderation_decisions"."decided_at" desc, "moderation_decisions"."id" desc',
    )
    expect(statement?.query).toContain('limit')
    expect(statement?.params).toEqual(['pass', 50])
  })

  test('跨群处置流：群、档位与复合游标都进 SQL 条件', async () => {
    const { repos, recorded } = createPgReposRecording([])
    const before = { decidedAt: new Date('2026-09-23T10:00:00Z'), id: '9c8b7a65-1111-4222-8333-999900001111' }
    await repos.decisions.listRecent({ chatId: chatConfigFixture.chatId, action: 'mute', before, limit: 20 })

    const [statement] = recorded
    // 指定档位时不再有「非放行」条件。
    expect(statement?.query).not.toContain('"action" <>')
    // 游标拆成「时间早于」或「时间相同且 id 更小」，与排序键同形。
    expect(statement?.query).toContain('or ')
    expect(statement?.query).toContain('"decided_at" < $3')
    expect(statement?.query).toContain('"decided_at" = $4 and "moderation_decisions"."id" < $5')
    expect(statement?.params).toEqual([
      '-1001234567890',
      'mute',
      '2026-09-23T10:00:00.000Z',
      '2026-09-23T10:00:00.000Z',
      '9c8b7a65-1111-4222-8333-999900001111',
      20,
    ])
  })

  test('通知引用写入与读取的 SQL 形状', async () => {
    const decisionId = '9c8b7a65-1111-4222-8333-999900001111'

    const written = createPgReposRecording([])
    await written.repos.decisions.markNoticeSent(decisionId, '-1001234567890', 77)
    const [update] = written.recorded
    expect(update?.query).toContain('update "moderation_decisions"')
    expect(update?.query).toContain('set "notice_chat_id" = $1, "notice_message_id" = $2')
    expect(update?.params).toEqual(['-1001234567890', 77, decisionId])

    // 读路径带字段映射：行按 select 字段顺序给数组。
    const read = createPgReposRecording([['123456789', 55]])
    expect(await read.repos.decisions.findNoticeRef(decisionId)).toEqual({ chatId: '123456789', messageId: 55 })
    expect(read.recorded[0]?.query).toContain('"notice_chat_id"')
    expect(read.recorded[0]?.query).toContain('where "moderation_decisions"."id" = $1')

    // 旧数据两列都是 null：视为没有引用，编辑侧跳过。
    const missing = createPgReposRecording([[null, null]])
    expect(await missing.repos.decisions.findNoticeRef(decisionId)).toBeNull()
  })

  test('批量摘录用一条 IN 查询，空数组不发查询', async () => {
    const { repos, recorded } = createPgReposRecording([
      ['e1', '摘录一'],
      ['e2', null],
    ])
    expect(await repos.events.findSamples(['e1', 'e2'])).toEqual(
      new Map([
        ['e1', '摘录一'],
        ['e2', null],
      ]),
    )

    const [statement] = recorded
    expect(statement?.query).toContain('in (')
    expect(statement?.params).toEqual(['e1', 'e2'])

    const empty = createPgReposRecording()
    expect(await empty.repos.events.findSamples([])).toEqual(new Map())
    expect(empty.recorded).toHaveLength(0)
  })

  test('申诉队列单条 join 取申诉与决策，state=null 时不过滤状态', async () => {
    const { repos, recorded } = createPgReposRecording([])
    expect(await repos.appeals.listByStateWithDecision('open', 20)).toEqual([])

    const [statement] = recorded
    expect(statement?.query).toContain('inner join "moderation_decisions"')
    expect(statement?.query).toContain('"appeals"."state" =')
    expect(statement?.query).toContain('order by "appeals"."created_at" desc')
    expect(statement?.query).toContain('limit')
    expect(statement?.params).toEqual(['open', 20])

    const all = createPgReposRecording([])
    await all.repos.appeals.listByStateWithDecision(null, 20)
    expect(all.recorded[0]?.query).not.toContain('"appeals"."state" =')
    expect(all.recorded[0]?.params).toEqual([20])
  })

  test('误伤样本用一条三表 join，倒序取时间窗内的撤销结案', async () => {
    // 带字段映射的读走 .values()：行按 select 字段顺序给数组。
    const { repos, recorded } = createPgReposRecording([
      [7_000_000_001, 'b'.repeat(64), '近期摘录', new Date('2026-09-23T10:10:00Z')],
    ])
    const since = new Date('2026-09-01T00:00:00Z')

    const samples = await repos.appeals.listOverturnedSamples(chatConfigFixture.chatId, since, 20)

    expect(samples).toEqual([
      {
        userId: asUserId(7_000_000_001),
        contentHash: 'b'.repeat(64),
        sampleText: '近期摘录',
        resolvedAt: new Date('2026-09-23T10:10:00Z'),
      },
    ])
    const [statement] = recorded
    // join 方向：申诉 → 决策（decision_id = id），决策 → 事件（event_id = id），群过滤在决策侧。
    expect(statement?.query).toContain('inner join "moderation_decisions" on "appeals"."decision_id" = "moderation_decisions"."id"')
    expect(statement?.query).toContain('inner join "message_events" on "message_events"."id" = "moderation_decisions"."event_id"')
    expect(statement?.query).toContain('"moderation_decisions"."chat_id" = $1')
    expect(statement?.query).toContain('"state" = $2')
    expect(statement?.query).toContain('"resolved_at" >= $3')
    expect(statement?.query).toContain('order by "appeals"."resolved_at" desc, "appeals"."id" desc')
    expect(statement?.query).toContain('limit')
    expect(statement?.params).toEqual(['-1001234567890', 'overturned', '2026-09-01T00:00:00.000Z', 20])
  })

  test('误伤样本的 limit 为负数或小数时按 max(0, trunc) 归一', async () => {
    const negative = createPgReposRecording([])
    await negative.repos.appeals.listOverturnedSamples(chatConfigFixture.chatId, new Date('2026-09-01T00:00:00Z'), -1)
    expect(negative.recorded[0]?.params.at(-1)).toBe(0)

    const fractional = createPgReposRecording([])
    await fractional.repos.appeals.listOverturnedSamples(chatConfigFixture.chatId, new Date('2026-09-01T00:00:00Z'), 2.9)
    expect(fractional.recorded[0]?.params.at(-1)).toBe(2)
  })
})

describe('订阅链接与成员仓储的 SQL 形状', () => {
  /** `subscription_links` 完整行（select 列顺序）。 */
  const linkRow = [
    '11111111-1111-4111-8111-111111111111',
    '-1001234567890',
    1_000_000_001,
    '22222222-2222-4222-8222-222222222222',
    'hash-1',
    '月度',
    500,
    2_592_000,
    'https://t.me/+abcdefghijklmnop',
    'active',
    new Date('2026-09-26T10:00:00Z'),
    new Date('2026-09-26T10:00:00Z'),
    null,
    2,
    null,
    null,
    null,
  ]

  /** `subscription_members` 完整行（select 列顺序）。 */
  const memberRow = [
    '33333333-3333-4333-8333-333333333333',
    '-1001234567890',
    7_000_000_002,
    '11111111-1111-4111-8111-111111111111',
    'member',
    new Date('2026-10-26T10:00:00Z'),
    'until_date',
    new Date('2026-09-26T09:00:00Z'),
    new Date('2026-09-26T10:00:00Z'),
    'event',
    1_758_000_000,
    42,
    null,
    null,
    null,
    null,
    3,
    null,
    null,
  ]

  const reserveInput = {
    id: '11111111-1111-4111-8111-111111111111',
    chatId: asChatId('-1001234567890'),
    ownerUserId: asUserId(1_000_000_001),
    requestId: '22222222-2222-4222-8222-222222222222',
    requestHash: 'hash-1',
    name: '月度',
    priceStars: 500,
    periodSeconds: 2_592_000,
    createdAt: new Date('2026-09-26T10:00:00Z'),
  }

  const observation: MemberEventObservation = {
    chatId: asChatId('-1001234567890'),
    userId: asUserId(7_000_000_002),
    state: 'member',
    expiresAt: new Date('2026-10-26T10:00:00Z'),
    evidence: 'until_date',
    linkId: null,
    isJoin: true,
    eventDate: 1_758_000_000,
    eventUpdateId: 42,
    observedAt: new Date('2026-09-26T10:00:00Z'),
  }

  test('创建占位按 (owner, request) 冲突即放弃，冲突时返回原行', async () => {
    const { repos, recorded } = createPgReposRecording([], [[], [linkRow]])
    const outcome = await repos.subscriptionLinks.reserveCreate(reserveInput)

    expect(outcome.kind).toBe('existing')
    expect(outcome.link.id).toBe(linkRow[0])
    expect(recorded[0]?.query).toContain('insert into "subscription_links"')
    expect(recorded[0]?.query).toContain('on conflict ("owner_user_id","request_id") do nothing')
    expect(recorded).toHaveLength(2)
  })

  test('finishCreate 只从 creating/create_unknown 迁移到 active', async () => {
    const { repos, recorded } = createPgReposRecording([[linkRow[0]]])
    const finished = await repos.subscriptionLinks.finishCreate(linkRow[0] as string, {
      inviteLink: 'https://t.me/+abcdefghijklmnop',
      finishedAt: new Date('2026-09-26T10:00:01Z'),
    })

    expect(finished).toBe(true)
    const [statement] = recorded
    // SET 的参数顺序按列定义（invite_link 在 state 前），不是对象字面量顺序。
    expect(statement?.query).toContain('"invite_link" = $1')
    expect(statement?.query).toContain('"state" = $2')
    expect(statement?.query).toContain('"state" in ($5, $6)')
    expect(statement?.params.slice(0, 2)).toEqual(['https://t.me/+abcdefghijklmnop', 'active'])
    expect(statement?.params.slice(4, 6)).toEqual(['creating', 'create_unknown'])
  })

  test('操作 claim 带 state/version/占位租约条件，并区分版本与活跃占位冲突', async () => {
    const claimed = createPgReposRecording([linkRow])
    const result = await claimed.repos.subscriptionLinks.claimMutation(
      asChatId('-1001234567890'),
      linkRow[0] as string,
      2,
      'rename',
      new Date('2026-09-26T10:05:00Z'),
    )
    expect(result.kind).toBe('claimed')
    const [statement] = claimed.recorded
    expect(statement?.query).toContain('update "subscription_links"')
    expect(statement?.query).toContain('"state" = $7')
    expect(statement?.query).toContain('"version" = $8')
    expect(statement?.query).toContain('"operation_started_at" < $9::timestamptz - interval \'60 seconds\'')
    expect(statement?.query).toContain('"operation_token" is null')

    // 版本不匹配：UPDATE 无返回，读回仍是旧行（version 2），expectedVersion 3 → conflict(version)。
    const conflicted = createPgReposRecording([], [[], [linkRow]])
    const conflict = await conflicted.repos.subscriptionLinks.claimMutation(
      asChatId('-1001234567890'),
      linkRow[0] as string,
      3,
      'revoke',
      new Date('2026-09-26T10:05:00Z'),
    )
    expect(conflict).toEqual({ kind: 'conflict', reason: 'version' })

    // 已撤销行：revoked。
    const revokedRow = [...linkRow]
    revokedRow[9] = 'revoked'
    revokedRow[12] = new Date('2026-09-26T10:00:00Z')
    const revoked = createPgReposRecording([], [[], [revokedRow]])
    expect(
      await revoked.repos.subscriptionLinks.claimMutation(
        asChatId('-1001234567890'),
        linkRow[0] as string,
        2,
        'rename',
        new Date('2026-09-26T10:05:00Z'),
      ),
    ).toEqual({ kind: 'revoked' })
  })

  test('finishMutation 要求同 token 且仍为 active（终态不复活）', async () => {
    const { repos, recorded } = createPgReposRecording([[linkRow[0]]])
    const ok = await repos.subscriptionLinks.finishMutation(
      linkRow[0] as string,
      '44444444-4444-4444-8444-444444444444',
      { kind: 'revoked', revokedAt: new Date('2026-09-26T10:06:00Z') },
      new Date('2026-09-26T10:06:00Z'),
    )
    expect(ok).toBe(true)
    const [statement] = recorded
    // SET 里清空三列占位 + WHERE 里匹配 token，因此 operation_token 出现两次。
    expect(statement?.query).toContain('"revoked_at" = $3')
    expect(statement?.query.match(/"operation_token" = \$\d+/g)).toHaveLength(2)
    expect(statement?.query).toContain('"state" = $')
  })

  test('成员 applyEvent：插入走 on conflict do nothing，更新走高水位条件与对账水位 CASE', async () => {
    const inserted = createPgReposRecording([[memberRow[0]]])
    expect(await inserted.repos.subscriptionMembers.applyEvent(observation)).toBe('inserted')
    expect(inserted.recorded[0]?.query).toContain('on conflict ("chat_id","user_id") do nothing')

    const updated = createPgReposRecording([], [[], [[memberRow[0]]]])
    expect(await updated.repos.subscriptionMembers.applyEvent(observation)).toBe('updated')
    const statement = updated.recorded[1]
    expect(statement?.query).toContain('update "subscription_members"')
    expect(statement?.query).toContain('case when')
    expect(statement?.query).toContain('reconciled_through')
    expect(statement?.query).toContain('coalesce')
    expect(statement?.query).toContain('> ("subscription_members"."last_event_date", "subscription_members"."last_event_update_id")')

    const ignored = createPgReposRecording([], [[], []])
    expect(await ignored.repos.subscriptionMembers.applyEvent(observation)).toBe('ignored')
  })

  test('成员 applyEvent（无证据）：跳过 INSERT 直接条件 UPDATE；无行返回 ignored 且不抛错', async () => {
    const noEvidence: MemberEventObservation = { ...observation, evidence: null, isJoin: false }

    // 已有行：保留历史 evidence 的 coalesce 仍在，事件仍可推进状态（例如离开/升管理员）。
    const updated = createPgReposRecording([], [[[memberRow[0]]]])
    expect(await updated.repos.subscriptionMembers.applyEvent(noEvidence)).toBe('updated')
    expect(updated.recorded).toHaveLength(1)
    expect(updated.recorded[0]?.query).toContain('update "subscription_members"')
    expect(updated.recorded[0]?.query).toContain('coalesce')
    expect(updated.recorded[0]?.query).not.toContain('insert into')

    // 不存在行：条件 UPDATE 零行 → ignored，不插入、不抛错。
    const missing = createPgReposRecording([], [[]])
    expect(await missing.repos.subscriptionMembers.applyEvent(noEvidence)).toBe('ignored')
    expect(missing.recorded).toHaveLength(1)
    expect(missing.recorded[0]?.query).toContain('update "subscription_members"')
  })

  test('对账 claim 用单条 UPDATE + 子查询 FOR UPDATE SKIP LOCKED，租约/尝试时刻取数据库 now()', async () => {
    // 返回行是 UPDATE 之后的值：last_checked_at / check_token 已按数据库 now() 写入。
    const claimedRow = [...memberRow]
    claimedRow[13] = new Date('2026-09-26T11:00:00Z')
    claimedRow[17] = '55555555-5555-4555-8555-555555555555'
    const { repos, recorded } = createPgReposRecording([claimedRow])
    const claims = await repos.subscriptionMembers.claimChecks({
      // 进程时钟刻意与数据库时刻不同：claim 的租约与查询开始时刻不得采用它。
      now: new Date('2026-09-26T10:00:00Z'),
      limit: 50,
      leaseMs: 60_000,
    })

    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      memberId: memberRow[0],
      version: memberRow[16],
      token: '55555555-5555-4555-8555-555555555555',
      requestStartedAt: new Date('2026-09-26T11:00:00Z'),
    })
    const [statement] = recorded
    expect(statement?.query).toContain('update "subscription_members"')
    expect(statement?.query).toContain('gen_random_uuid()')
    expect(statement?.query).toContain('for update skip locked')
    expect(statement?.query).toContain('nulls first')
    expect(statement?.query).toContain('"check_lease_until" <= now()')
    expect(statement?.query).toContain('"last_checked_at" = now()')
    expect(statement?.query).toContain('"check_lease_until" = now() + (')
    expect(statement?.params).toEqual([60_000, 50])
  })

  test('finishCheck：成功走 token+version 的 CAS 并推进水位；失败只写错误码', async () => {
    const claim = {
      memberId: memberRow[0] as string,
      chatId: asChatId('-1001234567890'),
      userId: asUserId(7_000_000_002),
      token: '55555555-5555-4555-8555-555555555555',
      version: 3,
      requestStartedAt: new Date('2026-09-26T11:00:00Z'),
    }

    const ok = createPgReposRecording([[memberRow[0]]])
    expect(
      await ok.repos.subscriptionMembers.finishCheck(claim, {
        kind: 'ok',
        state: 'left',
        expiresAt: null,
        returnedAt: new Date('2026-09-26T11:00:01Z'),
      }),
    ).toBe('applied')
    const [okStatement] = ok.recorded
    expect(okStatement?.query).toContain('"state" = $1')
    expect(okStatement?.query).toContain('"observation_source" = $')
    expect(okStatement?.query).toContain('"reconciled_through" = $')
    expect(okStatement?.query).toContain('"check_token" = $')
    expect(okStatement?.query).toContain('"version" = $')

    const failed = createPgReposRecording([[memberRow[0]]])
    expect(
      await failed.repos.subscriptionMembers.finishCheck(claim, {
        kind: 'failed',
        errorCode: 'rate_limited',
        checkedAt: new Date('2026-09-26T11:00:01Z'),
      }),
    ).toBe('applied')
    const [failedStatement] = failed.recorded
    expect(failedStatement?.query).toContain('"last_check_error_code" = $1')
    // 失败不写事实列。
    expect(failedStatement?.query).not.toContain('"state" =')
    expect(failedStatement?.query).not.toContain('"expires_at" =')

    const stale = createPgReposRecording([], [[], []])
    expect(
      await stale.repos.subscriptionMembers.finishCheck(claim, {
        kind: 'failed',
        errorCode: 'telegram_failed',
        checkedAt: new Date('2026-09-26T11:00:01Z'),
      }),
    ).toBe('stale')
  })

  test('成员 counts 用 SQL GROUP BY，分页用复合游标边界', async () => {
    const counts = createPgReposRecording([
      ['member', 3],
      ['left', 2],
    ])
    expect(await counts.repos.subscriptionMembers.countByState(asChatId('-1001234567890'))).toEqual({
      known: 5,
      member: 3,
      left: 2,
      unknown: 0,
    })
    expect(counts.recorded[0]?.query).toContain('group by "subscription_members"."state"')

    const page = createPgReposRecording([])
    await page.repos.subscriptionMembers.listPage({
      chatId: asChatId('-1001234567890'),
      before: { firstObservedAt: new Date('2026-09-26T10:00:00Z'), id: '33333333-3333-4333-8333-333333333333' },
      limit: 51,
    })
    const [statement] = page.recorded
    expect(statement?.query).toContain('"first_observed_at" < $2')
    expect(statement?.query).toContain('"first_observed_at" = $3')
    expect(statement?.query).toContain('"id" < $4')
    expect(statement?.query).toContain('order by "subscription_members"."first_observed_at" desc')
    expect(statement?.params).toEqual([
      '-1001234567890',
      '2026-09-26T10:00:00.000Z',
      '2026-09-26T10:00:00.000Z',
      '33333333-3333-4333-8333-333333333333',
      51,
    ])

    const links = createPgReposRecording([])
    await links.repos.subscriptionLinks.listPage({
      chatId: asChatId('-1001234567890'),
      before: { createdAt: new Date('2026-09-26T10:00:00Z'), id: '11111111-1111-4111-8111-111111111111' },
      limit: 51,
    })
    expect(links.recorded[0]?.query).toContain('"created_at" < $2')
    expect(links.recorded[0]?.query).toContain('order by "subscription_links"."created_at" desc')
  })

  test('频道分页只取 channel，比较与排序都固定 C 排序规则', async () => {
    const { repos, recorded } = createPgReposRecording([])
    await repos.chats.listChannelsPage({ afterChatId: asChatId('-1001234567890'), limit: 11 })

    const [statement] = recorded
    expect(statement?.query).toContain('"chat_type" = $1')
    expect(statement?.query).toContain('"chat_id" collate "C" > $2 collate "C"')
    expect(statement?.query).toContain('order by "chats"."chat_id" collate "C" asc')
    expect(statement?.params).toEqual(['channel', '-1001234567890', 11])
  })

  test('规则/白名单/阈值更新只写配置列，绝不碰元数据与语言列', async () => {
    const { repos, recorded } = createPgReposRecording([])
    await repos.chats.updateRulesConfig(asChatId('-1001234567890'), {
      rules: chatConfigFixture.rules,
      whitelist: chatConfigFixture.whitelist,
      passThreshold: 0.2,
      llmThreshold: 0.7,
      muteDurationMinutes: 30,
    })

    const [statement] = recorded
    expect(statement?.query).toContain('"rules" = $1')
    expect(statement?.query).toContain('"whitelist" = $2')
    expect(statement?.query).toContain('"pass_threshold" = $3')
    expect(statement?.query).toContain('"llm_threshold" = $4')
    expect(statement?.query).toContain('"mute_duration_minutes" = $5')
    expect(JSON.parse(String(statement?.params?.[1]))).toEqual(chatConfigFixture.whitelist)
    expect(statement?.query).not.toContain('"title" =')
    expect(statement?.query).not.toContain('"chat_type" =')
    expect(statement?.query).not.toContain('"linked_chat_id" =')
    expect(statement?.query).not.toContain('"language" =')
  })
})

describe('迁移产物', () => {
  test('迁移链里包含各阶段新增的列、约束与索引', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const sql = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => readFileSync(join(migrationsDir, file), 'utf8'))
      .join('\n')

    expect(sql).toContain('ADD COLUMN "sample_text" text;')
    expect(sql).toContain('ADD COLUMN "resolved_by" bigint;')
    expect(sql).toContain('ADD COLUMN "notified_at" timestamp with time zone;')
    expect(sql).toContain('ADD COLUMN "custom_emoji_count" integer DEFAULT 0 NOT NULL;')
    expect(sql).toContain('ADD COLUMN "emoji_count" integer DEFAULT 0 NOT NULL;')
    expect(sql).toContain('ADD COLUMN "via_bot" boolean DEFAULT false NOT NULL;')
    expect(sql).toContain('ADD COLUMN "rollback_pending" boolean DEFAULT false NOT NULL;')
    expect(sql).toContain('ADD COLUMN "notice_chat_id" text;')
    expect(sql).toContain('ADD COLUMN "notice_message_id" integer;')
    // 频道登记批次：聊天类型与 linked discussion 关系。历史行按 supergroup 兼容（DEFAULT 非空）。
    expect(sql).toContain('CREATE TYPE "public"."chat_type" AS ENUM(\'group\', \'supergroup\', \'channel\');')
    expect(sql).toContain('ADD COLUMN "chat_type" "chat_type" DEFAULT \'supergroup\' NOT NULL;')
    expect(sql).toContain('ADD COLUMN "linked_chat_id" text;')
    // 订阅批次：两张新表 + 幂等/分页/扫描索引 + 复合外键；旧 subscriptions 表不 drop。
    expect(sql).toContain('CREATE TABLE "subscription_links"')
    expect(sql).toContain('CREATE TABLE "subscription_members"')
    expect(sql).toContain('CREATE UNIQUE INDEX "subscription_links_owner_request_key"')
    expect(sql).toContain('CREATE UNIQUE INDEX "subscription_links_invite_link_key" ON "subscription_links" USING btree ("invite_link") WHERE "subscription_links"."invite_link" is not null;')
    expect(sql).toContain('CREATE UNIQUE INDEX "subscription_members_chat_user_key"')
    expect(sql).toContain('CREATE INDEX "subscription_members_scan_idx" ON "subscription_members" USING btree ("last_checked_at" NULLS FIRST,"id");')
    expect(sql).toContain('FOREIGN KEY ("chat_id","link_id") REFERENCES "public"."subscription_links"("chat_id","id")')
    expect(sql).toContain('CONSTRAINT "subscription_links_link_complete" CHECK')
    expect(sql).toContain('CONSTRAINT "subscription_members_event_high_water" CHECK')
    expect(sql).not.toContain('DROP TABLE "subscriptions"')
    // 跨群处置流的分页游标是 (decided_at, id)，索引必须带上 id 才能覆盖同毫秒并列的全序。
    expect(sql).toContain(
      'CREATE INDEX "moderation_decisions_decided_idx" ON "moderation_decisions" USING btree ("decided_at","id");',
    )
    expect(sql).toContain(`char_length("message_events"."sample_text") <= ${SAMPLE_TEXT_MAX_LENGTH}`)
    expect(sql).toContain('CREATE UNIQUE INDEX "appeals_decision_unique"')
    // 信任名单批次：chats 多一列 jsonb 数字数组，默认空数组（历史行自动获得 `[]`）。
    expect(sql).toContain('ADD COLUMN "whitelist" jsonb DEFAULT \'[]\'::jsonb NOT NULL;')
  })

  test('journal 与迁移文件一致：每个 tag 都有同名 SQL，序号连续', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }

    expect(journal.entries.map((entry) => entry.idx)).toEqual(journal.entries.map((_, index) => index))
    for (const entry of journal.entries) {
      expect(readdirSync(migrationsDir)).toContain(`${entry.tag}.sql`)
      expect(readdirSync(join(migrationsDir, 'meta'))).toContain(`${String(entry.idx).padStart(4, '0')}_snapshot.json`)
    }
  })

  test('0009 snapshot 记录订阅链接/成员表，journal 保留 0009 与 0008', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const entry = journal.entries[9]
    expect(entry).toEqual({ idx: 9, tag: '0009_petite_trauma', version: '7', when: expect.any(Number), breakpoints: true })
    // 3a 的 0008 不被覆盖。
    expect(journal.entries[8]).toEqual({
      idx: 8,
      tag: '0008_medical_tiger_shark',
      version: '7',
      when: expect.any(Number),
      breakpoints: true,
    })

    const snapshot = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '0009_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<string, { columns: Record<string, { name: string; type: string; notNull: boolean; default?: unknown }> }>
    }
    const linkColumns = snapshot.tables['public.subscription_links']?.columns
    expect(linkColumns?.owner_user_id?.notNull).toBe(true)
    expect(linkColumns?.request_id?.type).toBe('uuid')
    expect(linkColumns?.period_seconds?.type).toBe('integer')
    expect(linkColumns?.version?.default).toBe(0)
    expect(linkColumns?.invite_link?.notNull).toBe(false)

    const memberColumns = snapshot.tables['public.subscription_members']?.columns
    expect(memberColumns?.chat_id?.notNull).toBe(true)
    expect(memberColumns?.user_id?.type).toBe('bigint')
    expect(memberColumns?.last_event_date?.type).toBe('bigint')
    expect(memberColumns?.check_token?.type).toBe('uuid')
    // 旧订阅表仍在快照里（不 drop、不 rename）。
    expect(snapshot.tables['public.subscriptions']).toBeDefined()
  })

  test('0010 snapshot 记录 chats.whitelist（jsonb 默认空数组），journal 末尾指向它且保留 0009', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const last = journal.entries.at(-1)
    expect(last).toMatchObject({ idx: 10, version: '7', breakpoints: true })
    // 3b 的 0009 不被覆盖。
    expect(journal.entries[9]).toEqual({
      idx: 9,
      tag: '0009_petite_trauma',
      version: '7',
      when: expect.any(Number),
      breakpoints: true,
    })

    const tag = last?.tag ?? ''
    expect(tag).toMatch(/^0010_/u)
    const sql0010 = readFileSync(join(migrationsDir, `${tag}.sql`), 'utf8')
    expect(sql0010).toContain('ADD COLUMN "whitelist" jsonb DEFAULT \'[]\'::jsonb NOT NULL;')
    // 只加列：不改既有配置列，也不引入新的 DDL 约束。
    expect(sql0010).not.toContain('DROP')
    expect(sql0010).not.toContain('"rules"')

    const snapshot = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '0010_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<string, { columns: Record<string, { name: string; type: string; notNull: boolean; default?: unknown }> }>
    }
    expect(snapshot.tables['public.chats']?.columns.whitelist).toEqual({
      name: 'whitelist',
      type: 'jsonb',
      primaryKey: false,
      notNull: true,
      default: "'[]'::jsonb",
    })
  })

  test('0009 迁移只建新表：不 drop/alter 旧 subscriptions，且没有跨 HTTP 的 DB 事务用法', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const sql0009 = readFileSync(join(migrationsDir, '0009_petite_trauma.sql'), 'utf8')
    // 旧表名（带引号的精确串）不出现；没有 DROP/ALTER。
    expect(sql0009).not.toContain('"subscriptions"')
    expect(sql0009).not.toContain('DROP')
    expect(sql0009).not.toContain('ALTER TABLE "subscriptions"')
    expect(sql0009).not.toContain('ALTER TABLE "chats"')

    // 仓储实现不使用事务 API：claim/finish 都是单条语句，语句结束即提交，不跨 HTTP 持事务。
    const reposSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pg-repos.ts'), 'utf8')
    expect(reposSource).not.toContain('.transaction(')
  })

  test('0009 复合外键引用的唯一索引先于外键建立（真实 PG 的 FK 只认已存在的唯一索引）', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const sql0009 = readFileSync(join(migrationsDir, '0009_petite_trauma.sql'), 'utf8')
    const uniqueIndexAt = sql0009.indexOf('CREATE UNIQUE INDEX "subscription_links_chat_id_id_key"')
    const foreignKeyAt = sql0009.indexOf('CONSTRAINT "subscription_members_link_fk"')

    expect(uniqueIndexAt).toBeGreaterThanOrEqual(0)
    expect(foreignKeyAt).toBeGreaterThanOrEqual(0)
    expect(uniqueIndexAt).toBeLessThan(foreignKeyAt)
  })

  test('0008 snapshot 记录聊天类型与 linked_chat_id 列', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const snapshot = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '0008_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<string, { columns: Record<string, { name: string; type: string; notNull: boolean; default?: unknown }> }>
      enums: Record<string, { name: string; values: string[] }>
    }
    const columns = snapshot.tables['public.chats']?.columns
    expect(columns?.chat_type).toEqual({
      name: 'chat_type',
      type: 'chat_type',
      typeSchema: 'public',
      primaryKey: false,
      notNull: true,
      default: "'supergroup'",
    })
    expect(columns?.linked_chat_id).toEqual({ name: 'linked_chat_id', type: 'text', primaryKey: false, notNull: false })
    expect(snapshot.enums['public.chat_type']?.values).toEqual(['group', 'supergroup', 'channel'])
  })
})

/**
 * 建立带记录能力的仓储聚合。
 *
 * @param rows 假驱动返回的行。
 * @param rowsPerCall 逐次查询的返回行（区分 insert/update 两条语句的返回）。
 * @returns 仓储、已记录语句与假驱动。
 */
function createPgReposRecording(
  rows: unknown[] = [],
  rowsPerCall?: unknown[][],
): RecordingDb & { repos: ReturnType<typeof createPgRepos> } {
  const recording = createRecordingDb(rows, rowsPerCall)
  return { ...recording, repos: createPgRepos(recording.db) }
}
