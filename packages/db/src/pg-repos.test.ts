import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asChatId, asUserId, type ChatConfig } from '@skitarii/core'
import { describe, expect, test } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Db } from './client.js'
import { createPgRepos } from './pg-repos.js'
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
 * @returns drizzle 实例与已记录的语句列表。
 */
function createRecordingDb(rows: unknown[] = []): RecordingDb {
  const recorded: RecordedQuery[] = []
  const client = {
    options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
    unsafe(query: string, params: unknown[]) {
      recorded.push({ query, params })
      // postgres.js 的 PendingQuery 是 thenable，同时提供 .values()（数组行模式）。
      const pending = Promise.resolve(rows) as Promise<unknown> & { values: () => Promise<unknown> }
      pending.values = () => Promise.resolve(rows)
      return pending
    },
  }

  return { db: drizzle(client as never, { schema }), recorded }
}

const chatConfigFixture: ChatConfig = {
  chatId: asChatId('-1001234567890'),
  title: '测试群',
  language: 'zh',
  rules: [{ id: 'rule-1', kind: 'keyword', pattern: '广告', score: 0.4, actionHint: 'delete', enabled: true }],
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

  test('群配置覆盖写入按 chat_id 冲突更新', async () => {
    const { repos, recorded } = createPgReposRecording()
    await repos.chats.upsert(chatConfigFixture)

    const [statement] = recorded
    expect(statement?.query).toContain('insert into "chats"')
    expect(statement?.query).toContain('on conflict ("chat_id") do update set')
    // jsonb 列在驱动层序列化成 JSON 字符串后作为单个参数传入。
    const params = statement?.params ?? []
    expect(params.slice(0, 3)).toEqual(['-1001234567890', '测试群', 'zh'])
    expect(JSON.parse(String(params[3]))).toEqual(chatConfigFixture.rules)
    expect(params.slice(4, 7)).toEqual([0.35, 0.8, 60])
    // 冲突更新分支重复一遍配置字段，最后一项是刷新过的 updated_at。
    expect(params.slice(7, 14)).toEqual(['测试群', 'zh', params[3], 0.35, 0.8, 60, params[13]])
    expect(String(params[13])).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
        'zh',
        chatConfigFixture.rules,
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
    // 跨群处置流的分页游标是 (decided_at, id)，索引必须带上 id 才能覆盖同毫秒并列的全序。
    expect(sql).toContain(
      'CREATE INDEX "moderation_decisions_decided_idx" ON "moderation_decisions" USING btree ("decided_at","id");',
    )
    expect(sql).toContain(`char_length("message_events"."sample_text") <= ${SAMPLE_TEXT_MAX_LENGTH}`)
    expect(sql).toContain('CREATE UNIQUE INDEX "appeals_decision_unique"')
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

  test('0007 snapshot 记录表情总数与 via-bot 列，journal 末尾指向它', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const last = journal.entries.at(-1)
    expect(last).toEqual({ idx: 7, tag: '0007_bitter_william_stryker', version: '7', when: expect.any(Number), breakpoints: true })

    const snapshot = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '0007_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<string, { columns: Record<string, { name: string; type: string; notNull: boolean; default?: unknown }> }>
    }
    const columns = snapshot.tables['public.message_events']?.columns
    expect(columns?.emoji_count).toEqual({ name: 'emoji_count', type: 'integer', primaryKey: false, notNull: true, default: 0 })
    expect(columns?.via_bot).toEqual({ name: 'via_bot', type: 'boolean', primaryKey: false, notNull: true, default: false })
  })
})

/**
 * 建立带记录能力的仓储聚合。
 *
 * @param rows 假驱动返回的行。
 * @returns 仓储、已记录语句与假驱动。
 */
function createPgReposRecording(rows: unknown[] = []): RecordingDb & { repos: ReturnType<typeof createPgRepos> } {
  const recording = createRecordingDb(rows)
  return { ...recording, repos: createPgRepos(recording.db) }
}
