import { z } from 'zod'

/**
 * bot 进程的环境变量契约。
 *
 * 在进程启动时一次性解析：配置错误要立刻崩，而不是等第一条消息到达才在管线深处失败。
 * schema 是这份契约的权威定义，类型由它派生（`z.infer`），不手写平行接口。
 *
 * `LLM_*` 在这里是可选的：LLM 未配置时审核管线退化为「规则 + 待复核」，而不是拒绝启动。
 */

/** 复核请求超时（毫秒）的默认值。审核在消息路径上，30 秒是「宁可判不出来也不能卡住消息」的上限。 */
const DEFAULT_LLM_TIMEOUT_MS = 30_000

const botEnvSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_LLM_TIMEOUT_MS),
  /** Mini App 对外地址，用于组装申诉按钮链接。 */
  MINI_APP_URL: z.string().min(1),
  /** 申诉处理的唯一负责人（Telegram 用户 id）。 */
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
})

/** 已校验的 bot 环境变量。 */
export type BotEnv = z.infer<typeof botEnvSchema>

/**
 * 解析并校验环境变量。
 *
 * @param source 进程环境，通常是 `process.env`。显式入参便于测试与本地跑批注入。
 * @throws {Error} 缺少必填项时抛出，消息里逐条列出缺失或非法的变量名。
 */
export function parseBotEnv(source: NodeJS.ProcessEnv): BotEnv {
  const parsed = botEnvSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new Error(`环境变量不合法：\n${details}`)
  }
  return parsed.data
}
