/**
 * `@skitarii/db` 的公开表面：schema 表与行类型、连接工厂、仓储接口。
 * 上层不直接 import 内部文件。
 */

export { createDb } from './client.js'
export type { Db, DbHandle } from './client.js'
export { createInMemoryRepos } from './in-memory-repos.js'
export type { InMemoryRepos } from './in-memory-repos.js'
export { truncateSampleText } from './mapping.js'
export { createPgRepos } from './pg-repos.js'
export type {
  AggregateRepo,
  AppealRepo,
  ChatRepo,
  DailyCounts,
  DecisionRepo,
  LlmCacheRepo,
  MessageEventRepo,
  Repos,
  SubscriptionRepo,
} from './repos.js'
export * from './schema.js'
