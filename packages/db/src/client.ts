import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

/** Drizzle 实例类型。仓储实现只依赖它，不直接接触驱动 API。 */
export type Db = PostgresJsDatabase<typeof schema>

/** 连接句柄。进程退出前必须 `close()`，否则挂起的连接会让 bot 进程收不了尾。 */
export interface DbHandle {
  db: Db
  /** 逃生口：需要原生 SQL 或驱动级能力时使用，日常查询走 `db`。 */
  client: postgres.Sql
  close(): Promise<void>
}

/**
 * 建立数据库连接。
 *
 * 连接池上限取 10：本项目的写路径受 Telegram 限速约束（30 msg/s 全局），
 * 一个进程不需要更大的并发；bot 与 server 各自持有自己的池。
 *
 * @param databaseUrl Postgres 连接串，来自 `DATABASE_URL`。
 * @returns 连接句柄。
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, { max: 10 })
  return {
    db: drizzle(client, { schema }),
    client,
    close: () => client.end({ timeout: 5 }),
  }
}
