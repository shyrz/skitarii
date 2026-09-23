import { asUserId } from '@skitarii/core'
import { createDb, createPgRepos } from '@skitarii/db'
import type { LlmConfig } from '@skitarii/llm'
import { createBot } from './bot.js'
import { parseBotEnv } from './env.js'
import { createLogger } from './logger.js'

/**
 * bot 进程入口（长轮询）。
 *
 * 生产部署走 apps/server 的 webhook（server 复用同一个 `createBot`），这个入口用于本地开发与排障：
 * 一条命令起一个机器人，不需要公网地址。
 *
 * 本文件只负责进程编排：解析环境、建连接、组装 bot、处理退出信号。
 */

const env = parseBotEnv(process.env)
const logger = createLogger('bot')

const handle = createDb(env.DATABASE_URL)
const repos = createPgRepos(handle.db)

const llm: LlmConfig | null =
  env.LLM_BASE_URL !== undefined && env.LLM_API_KEY !== undefined && env.LLM_MODEL !== undefined
    ? { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, timeoutMs: env.LLM_TIMEOUT_MS }
    : null

if (llm === null) logger.warn('未配置 LLM_*：灰色地带一律按待复核处理，不消耗云端调用')

const bot = createBot({
  botToken: env.BOT_TOKEN,
  repos,
  llm,
  miniAppUrl: env.MINI_APP_URL,
  ownerUserId: asUserId(env.OWNER_USER_ID),
  logger,
})

/**
 * 优雅退出：停掉长轮询后关数据库连接，进程自然结束。
 *
 * @param signal 触发退出的信号名，仅用于日志。
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`收到 ${signal}，停止轮询`)
  await bot.stop()
  await handle.close()
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

// 启动失败是最常见的运维问题（token 抄错、出口网络不通、数据库连不上），因此在这里给出可执行的排查方向并以退出码 1 结束，
// 让 systemd / 容器编排能按失败重启，而不是留一个静默存活的进程。
try {
  await bot.start({
    onStart: (info) => logger.info(`@${info.username} 已启动（长轮询）`),
  })
} catch (error) {
  logger.error('启动失败：确认 BOT_TOKEN 有效、DATABASE_URL 可达、能访问 api.telegram.org', error)
  process.exitCode = 1
}
