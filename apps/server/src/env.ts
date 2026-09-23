import { z } from 'zod'

/**
 * server 进程的环境变量契约。
 *
 * 在进程启动时一次性解析，schema 即权威定义，类型由 `z.infer` 派生。
 * `PORT` 有默认值：本地起服务不需要额外配置。`LLM_*` 可选，理由同 bot 进程：
 * 未配置时复核层退化为「待复核」，审核链路照常工作。
 */
const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  BOT_TOKEN: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  MINI_APP_URL: z.string().min(1),
  /** 申诉处理的唯一负责人（Telegram 用户 id），与 bot 进程同一个值。 */
  OWNER_USER_ID: z.coerce.number().int().positive(),
  LLM_BASE_URL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  /** 复核请求超时（毫秒）。默认 30 秒：审查在消息路径上，宁可判不出来也不能卡住消息。 */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** 维护任务的执行间隔（毫秒），默认 1 小时。测试与手工排障可以调小。 */
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1_000),
})

/** 已校验的 server 环境变量。 */
export type ServerEnv = z.infer<typeof serverEnvSchema>

/**
 * 解析并校验环境变量。
 *
 * @param source 进程环境，通常是 `process.env`。
 * @throws {Error} 缺少必填项或某项非法时抛出，消息里逐条列出问题变量。
 */
export function parseServerEnv(source: NodeJS.ProcessEnv): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new Error(`环境变量不合法：\n${details}`)
  }
  return parsed.data
}
