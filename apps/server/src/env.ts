import { z } from 'zod'

/**
 * server 进程的环境变量契约。
 *
 * 在进程启动时一次性解析，schema 即权威定义，类型由 `z.infer` 派生。
 * `PORT` 有默认值：本地起服务不需要额外配置，部署平台（Zeabur 等）注入自己的值。
 * `PUBLIC_URL` 可选：非空时启动阶段自动注册 webhook，空串等同未配置。
 * `LLM_*` 可选，理由同 bot 进程：未配置时复核层退化为「待复核」，审核链路照常工作。
 */
const serverEnvSchema = z.object({
  /** HTTP 监听端口。缺省 3000，Zeabur 一类平台会用注入的 PORT 覆盖。 */
  PORT: z.coerce.number().int().positive().default(3000),
  BOT_TOKEN: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  MINI_APP_URL: z.string().min(1),
  /**
   * 服务对外根地址（带协议）。非空时启动阶段把 Telegram webhook 注册到
   * `${PUBLIC_URL}/telegram/webhook`；缺省或空串则跳过，保留 Telegram 侧已有地址。
   *
   * 空串按未配置处理：部署平台的变量表单把「留空」注入成空串，要求先删掉变量才肯启动过于苛刻。
   */
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim())),
  /** 申诉处理的唯一负责人（Telegram 用户 id），与 bot 进程同一个值。 */
  OWNER_USER_ID: z.coerce.number().int().positive(),
  /**
   * owner 判定 feed 开关（测试期观察用）。未设置或 `true` 开启，`false` 关闭；
   * 只接受 'true' / 'false'，其他取值在启动阶段报错。
   */
  OWNER_DEBUG_NOTIFY: z.enum(['true', 'false']).optional().transform((value) => value !== 'false'),
  /**
   * 误伤样本回写开关（开发中功能，默认关闭）。只接受 'true' / 'false'；
   * 未设置与 'false' 都关闭，`'true'` 才启用。
   */
  APPEAL_SAMPLE_WRITEBACK: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
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
