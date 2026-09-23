import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { looksLikeFile, resolveAssetPath, serveStatic } from './static.js'

/** 捕获响应的替身：静态托管只用到 `writeHead` 与 `end`。 */
interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * 构造响应替身。
 *
 * @returns 替身与捕获结果。
 */
function createResponse(): { response: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      captured.headers = headers ?? {}
      return response
    },
    end(body?: string | Buffer) {
      captured.body = typeof body === 'string' ? body : (body?.toString('utf8') ?? '')
    },
  }
  return { response: response as unknown as ServerResponse, captured }
}

describe('路径解析', () => {
  test('前缀之后的路径拼到根目录下', () => {
    expect(resolveAssetPath('/srv/dist', '/app/assets/index-abc.js', '/app/')).toBe('/srv/dist/assets/index-abc.js')
    expect(resolveAssetPath('/srv/dist', '/app/', '/app/')).toBe('/srv/dist')
  })

  test('阻止路径逃逸（含百分号编码形态）', () => {
    expect(resolveAssetPath('/srv/dist', '/app/../../etc/passwd', '/app/')).toBeNull()
    expect(resolveAssetPath('/srv/dist', '/app/%2e%2e/%2e%2e/etc/passwd', '/app/')).toBeNull()
    expect(resolveAssetPath('/srv/dist', '/app/%zz', '/app/')).toBeNull()
  })

  test('有扩展名才算具体文件（决定要不要回退到 index.html）', () => {
    expect(looksLikeFile('/app/assets/index.js')).toBe(true)
    expect(looksLikeFile('/app/appeal/9c8b7a65-1111-4222-8333-999900001111')).toBe(false)
  })
})

describe('静态托管', () => {
  let root = ''

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skitarii-static-'))
    await writeFile(join(root, 'index.html'), '<!doctype html><title>mini app</title>')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'index-abc.js'), 'export const x = 1')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('根路径返回 index.html', async () => {
    const { response, captured } = createResponse()

    await serveStatic({ root, pathname: '/app/', prefix: '/app/', response })

    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(captured.body).toContain('mini app')
  })

  test('带扩展名的资源按类型返回', async () => {
    const { response, captured } = createResponse()

    await serveStatic({ root, pathname: '/app/assets/index-abc.js', prefix: '/app/', response })

    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(captured.body).toBe('export const x = 1')
  })

  test('前端路由路径回退到 index.html', async () => {
    const { response, captured } = createResponse()

    await serveStatic({ root, pathname: '/app/appeal/9c8b7a65', prefix: '/app/', response })

    expect(captured.status).toBe(200)
    expect(captured.body).toContain('mini app')
  })

  test('缺失的资源与逃逸路径都回 404', async () => {
    const missing = createResponse()
    await serveStatic({ root, pathname: '/app/assets/missing.js', prefix: '/app/', response: missing.response })
    expect(missing.captured.status).toBe(404)

    const escape = createResponse()
    await serveStatic({ root, pathname: '/app/../../etc/hosts', prefix: '/app/', response: escape.response })
    expect(escape.captured.status).toBe(404)
  })

  test('产物目录不存在时 404（还没跑 pnpm build:web）', async () => {
    const { response, captured } = createResponse()

    await serveStatic({ root: join(root, 'nope'), pathname: '/app/', prefix: '/app/', response })

    expect(captured.status).toBe(404)
  })
})
