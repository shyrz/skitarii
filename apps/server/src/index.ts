import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { asUserId } from '@skitarii/core'
import { createLogger, createBotRuntime, notifyOwnerOfAppeal } from '@skitarii/bot'
import { createDb, createPgRepos } from '@skitarii/db'
import type { LlmConfig } from '@skitarii/llm'
import { webhookCallback } from 'grammy'
import { createAppeal, getAppeal, type AppealApiDeps } from './api.js'
import { parseServerEnv } from './env.js'
import { createScheduler } from './scheduler.js'
import { serveStatic } from './static.js'
import { registerWebhook } from './webhook.js'

/**
 * HTTP 进程入口：Telegram webhook、Mini App API、Mini App 静态托管、维护调度器的宿主。
 *
 * 本文件保持「路由表 + 分发 + 生命周期」三段，业务判定在 `api.ts`（申诉端点）、`static.ts`（产物托管）
 * 与 `scheduler.ts`（聚合与清理）里，各自可脱离 HTTP 服务器测试。
 *
 * 技术选型：用 `node:http` 而不是框架。本仓库冻结依赖，依赖清单里没有 HTTP 框架，
 * 而这一层只需要精确路由、前缀路由和 JSON 响应，不值得引入框架。
 */

const env = parseServerEnv(process.env)
const logger = createLogger('server')

const handle = createDb(env.DATABASE_URL)
const repos = createPgRepos(handle.db)

const llm: LlmConfig | null =
  env.LLM_BASE_URL !== undefined && env.LLM_API_KEY !== undefined && env.LLM_MODEL !== undefined
    ? { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, timeoutMs: env.LLM_TIMEOUT_MS }
    : null

if (llm === null) logger.warn('未配置 LLM_*：灰色地带一律按待复核处理，不消耗云端调用')

const ownerUserId = asUserId(env.OWNER_USER_ID)

// webhook 与申诉通知共用同一个 bot 实例：回调按钮由 Telegram 投递到 webhook，
// 通知则用同一个 token 发出，两者必须是同一个 bot。
// 运行时同时交出两个维护服务：补偿扫描与 bot 共享执行器/幂等闸门，补发扫描与申诉通知同源。
const runtime = createBotRuntime({ botToken: env.BOT_TOKEN, repos, llm, miniAppUrl: env.MINI_APP_URL, ownerUserId, logger })
const bot = runtime.bot

const appealApi: AppealApiDeps = {
  repos,
  botToken: env.BOT_TOKEN,
  ownerUserId,
  notifyAppeal: (notification) => notifyOwnerOfAppeal({ api: bot.api, repos, ownerUserId, logger }, notification),
  logger,
}

/** 静态产物的根目录：`apps/web/dist`（本文件在 `apps/server/src/`）。 */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))

/** 静态挂载前缀。产物用相对基址，改前缀不需要重新构建前端。 */
const STATIC_PREFIX = '/app/'

/** 请求体上限（字节）。这两个端点的 body 只有 initData、decisionId 与一小段理由。 */
const MAX_BODY_BYTES = 16 * 1024

/** 路由处理器。返回值被忽略；响应由处理器自己写，便于流式与静态文件复用同一签名。 */
type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void

/**
 * 路径匹配方式。
 * `exact` 匹配整条路径；`prefix` 匹配前缀，供 `/api/appeals/` 与 `/app/` 这类带参数的区段使用。
 */
type RouteTarget = { kind: 'exact'; path: string } | { kind: 'prefix'; path: string }

interface Route {
  method: 'GET' | 'POST'
  target: RouteTarget
  handler: Handler
}

/** 路径匹配器表：新增匹配方式只加一项，分发逻辑不变。 */
const PATH_MATCHERS: Readonly<Record<RouteTarget['kind'], (path: string, pathname: string) => boolean>> = {
  exact: (path, pathname) => pathname === path,
  prefix: (path, pathname) => pathname.startsWith(path),
}

// secretToken 交给 grammY 校验：它在 webhookCallback 里做常数时间比较并以 401 结束请求，
// 比在业务代码里再抄一遍「读 header + 比较」更不容易错。
const handleWebhook = webhookCallback(bot, 'http', { secretToken: env.WEBHOOK_SECRET })

/**
 * 路由表。加端点只加一行；顺序有意义，具体路径必须排在它所属的前缀路由之前。
 */
const ROUTES: readonly Route[] = [
  { method: 'GET', target: { kind: 'exact', path: '/healthz' }, handler: handleHealth },
  { method: 'POST', target: { kind: 'exact', path: '/telegram/webhook' }, handler: handleWebhook },
  { method: 'POST', target: { kind: 'exact', path: '/api/appeals' }, handler: handleCreateAppeal },
  { method: 'GET', target: { kind: 'prefix', path: '/api/appeals/' }, handler: handleGetAppeal },
  { method: 'GET', target: { kind: 'prefix', path: STATIC_PREFIX }, handler: handleStatic },
]

/**
 * 健康检查。只表示进程活着，不探数据库：探活逻辑与依赖检查分开，避免依赖抖动导致实例被重启。
 */
function handleHealth(_request: IncomingMessage, response: ServerResponse): void {
  respondJson(response, 200, { status: 'ok' })
}

/**
 * Mini App 读取处置与申诉。
 *
 * initData 走查询串（`?initData=...`）：GET 没有 body，而把凭据放进自定义 header 会让前端多做一层处理。
 * 契约见 README。
 */
async function handleGetAppeal(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const decisionId = url.pathname.slice('/api/appeals/'.length)
  const result = await getAppeal(appealApi, { decisionId, initData: url.searchParams.get('initData') })
  respondJson(response, result.status, result.body)
}

/** 创建申诉：body `{ initData, decisionId, reason }`。 */
async function handleCreateAppeal(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request)
  const result = await createAppeal(appealApi, body)
  respondJson(response, result.status, result.body)
}

/** Mini App 静态产物。 */
async function handleStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  await serveStatic({ root: WEB_DIST, pathname: url.pathname, prefix: STATIC_PREFIX, response })
}

/**
 * 读取并解析 JSON 请求体。
 *
 * @param request 入站请求。
 * @returns 解析结果；超限或不是合法 JSON 时返回 `undefined`（由调用方按 400 处理）。
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 写 JSON 响应。
 *
 * @param response 响应对象
 * @param status HTTP 状态码
 * @param body 将被 `JSON.stringify` 的响应体
 */
function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/**
 * 按路由表分发请求。
 *
 * @param request 入站请求
 * @param response 出站响应
 */
async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method === 'POST' ? 'POST' : 'GET'
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const route = ROUTES.find(
    (candidate) => candidate.method === method && PATH_MATCHERS[candidate.target.kind](candidate.target.path, pathname),
  )

  if (route === undefined) {
    respondJson(response, 404, { error: 'not found' })
    return
  }

  await route.handler(request, response)
}

const server = createServer((request, response) => {
  dispatch(request, response).catch((error: unknown) => {
    logger.error(`请求处理失败 ${request.method ?? ''} ${request.url ?? ''}`, error)
    if (!response.headersSent) {
      respondJson(response, 500, { error: 'internal error' })
    } else {
      response.end()
    }
  })
})

const scheduler = createScheduler({
  repos,
  logger,
  intervalMs: env.MAINTENANCE_INTERVAL_MS,
  retryDecisions: runtime.retryDecisions,
  resendAppeals: runtime.resendAppeals,
})

/**
 * 优雅退出：停调度器、停止接受新连接、关数据库连接，等在途请求收尾后退出。
 *
 * @param signal 触发退出的信号名，仅用于日志。
 */
function shutdown(signal: string): void {
  logger.info(`收到 ${signal}，停止监听`)
  scheduler.stop()
  server.close(() => {
    void handle.close().finally(() => process.exit(0))
  })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

// 先初始化 bot：让 `getMe` 在启动阶段完成，第一个 webhook 请求就不必等它；失败不阻断启动，
// webhookCallback 会在首个请求时再试一次，网络恢复后自动可用。
try {
  await bot.init()
  logger.info(`webhook 已就绪：@${bot.botInfo.username}`)
} catch (error) {
  logger.warn('bot 初始化失败（可能是网络或 token 问题），将在首个 webhook 请求时重试', error)
}

// PUBLIC_URL 非空才注册：本地开发与内网跑没有公网地址，注册只会徒增失败日志。
// 注册函数内部吞掉失败（只记 warn），进程照常启动；Telegram 侧保留原有地址，等下次重启再对。
if (env.PUBLIC_URL !== undefined) {
  await registerWebhook({ api: bot.api, publicUrl: env.PUBLIC_URL, secretToken: env.WEBHOOK_SECRET, logger })
}

scheduler.start()

server.listen(env.PORT, () => {
  logger.info(`监听 http://localhost:${env.PORT}，Mini App 产物目录 ${WEB_DIST}`)
})
