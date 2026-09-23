import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

/**
 * Mini App 静态产物托管。
 *
 * 挂载约定：URL 前缀 `/app/` 对应 `apps/web/dist`。Vite 的 `base: './'` 让产物内部用相对路径，
 * 因此挂载点变化不需要重新构建。
 *
 * 两条安全/体验规则：
 * - 路径解析后必须仍在根目录内，`..` 逃逸（含百分号编码的形态）一律 404。
 * - 找不到文件且请求路径不像具体文件（没有扩展名）时回落到 `index.html`，
 *   让前端路由（如果它有）不会因为刷新页面而 404。
 */

/** 静态文件的扩展名 → Content-Type。未登记的扩展名按二进制流处理。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 找不到产物时使用的回退文件名。 */
export const SPA_FALLBACK_FILE = 'index.html'

/**
 * 判断请求路径是否指向具体文件。
 *
 * @param pathname URL 路径。
 * @returns 末段含扩展名时为 `true`。
 */
export function looksLikeFile(pathname: string): boolean {
  return extname(pathname).length > 0
}

/**
 * 解析请求路径到磁盘路径。
 *
 * @param root 静态根目录（绝对路径）。
 * @param pathname URL 路径（已含挂载前缀）。
 * @param prefix 挂载前缀，例如 `/app/`。
 * @returns 解析后的磁盘路径；路径逃逸出根目录时返回 `null`。
 */
export function resolveAssetPath(root: string, pathname: string, prefix: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(pathname.slice(prefix.length))
  } catch {
    // 百分号编码坏掉，按不存在处理。
    return null
  }

  const base = normalize(root)
  const candidate = normalize(join(base, relative))
  if (candidate !== base && !candidate.startsWith(base.endsWith(sep) ? base : base + sep)) return null
  return candidate
}

/**
 * 发送静态产物。
 *
 * @param options.root 静态根目录（绝对路径）。
 * @param options.pathname URL 路径。
 * @param options.prefix 挂载前缀。
 * @param options.response HTTP 响应。
 * @returns 无返回；响应已写出。
 */
export async function serveStatic(options: {
  root: string
  pathname: string
  prefix: string
  response: ServerResponse
}): Promise<void> {
  const { root, pathname, prefix, response } = options

  const candidate = resolveAssetPath(root, pathname, prefix)
  if (candidate === null) return respondNotFound(response)

  const file = await pickFile(candidate, pathname, normalize(root))
  if (file === null) return respondNotFound(response)

  const body = await readFile(file).catch(() => null)
  if (body === null) return respondNotFound(response)

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    // 产物文件名带哈希，但 index.html 不带；统一用短缓存 + 允许回源，避免用户拿到过期页面。
    'cache-control': 'public, max-age=300',
  })
  response.end(body)
}

/**
 * 选择要发送的文件：优先请求路径本身，其次目录下的 index.html，再次根目录的 SPA 回退。
 *
 * @param candidate 解析后的磁盘路径。
 * @param pathname 原始 URL 路径。
 * @param root 静态根目录。
 * @returns 可读文件的路径；都不存在时为 `null`。
 */
async function pickFile(candidate: string, pathname: string, root: string): Promise<string | null> {
  if (await isFile(candidate)) return candidate

  const asDirectoryIndex = join(candidate, SPA_FALLBACK_FILE)
  if (await isFile(asDirectoryIndex)) return asDirectoryIndex

  // 具体文件请求（有扩展名）缺文件就是 404，不回退：否则前端会拿到一份 HTML 当 JS 用。
  if (looksLikeFile(pathname)) return null

  const fallback = join(root, SPA_FALLBACK_FILE)
  return (await isFile(fallback)) ? fallback : null
}

/**
 * 判断路径是不是可读文件。
 *
 * @param path 磁盘路径。
 * @returns 是文件时为 `true`。
 */
async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null)
  return stats?.isFile() ?? false
}

/**
 * 统一的 404 响应。
 *
 * 产物不存在（还没跑 `pnpm build:web`）与路径不存在走同一条分支：对使用者都表现为“这个地址没有内容”。
 *
 * @param response HTTP 响应。
 */
function respondNotFound(response: ServerResponse): void {
  const payload = JSON.stringify({ error: 'not found' })
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}
