import { describe, expect, test } from 'vitest'
import { createIdempotencyRegistry } from './idempotency.js'

describe('幂等闸门', () => {
  test('同一键只执行一次，重复调用返回首次结果', async () => {
    const registry = createIdempotencyRegistry()
    let runs = 0
    const task = async () => {
      runs += 1
      return 'done'
    }

    expect(await registry.run('evt:delete', task)).toBe('done')
    expect(await registry.run('evt:delete', task)).toBe('done')

    expect(runs).toBe(1)
    expect(registry.has('evt:delete')).toBe(true)
  })

  test('不同动作是不同的键，互不影响', async () => {
    const registry = createIdempotencyRegistry()
    let runs = 0
    const task = async () => {
      runs += 1
    }

    await registry.run('evt:delete', task)
    await registry.run('evt:mute', task)

    expect(runs).toBe(2)
  })

  test('并发调用共享同一次执行', async () => {
    const registry = createIdempotencyRegistry()
    let runs = 0
    const task = async () => {
      runs += 1
      await Promise.resolve()
      return runs
    }

    const [first, second] = await Promise.all([
      registry.run('evt:ban', task),
      registry.run('evt:ban', task),
      registry.run('evt:ban', task),
    ])

    expect(runs).toBe(1)
    expect(first).toBe(1)
    expect(second).toBe(1)
  })

  test('执行失败后放行重试', async () => {
    let nowMs = 1_000
    const registry = createIdempotencyRegistry({ now: () => nowMs })
    let attempts = 0
    const failing = async () => {
      attempts += 1
      throw new Error('telegram 抖动')
    }

    await expect(registry.run('evt:mute', failing)).rejects.toThrow('telegram 抖动')
    // 让 rejected 处理链跑完（失败清键是异步挂在 catch 上的）。
    await Promise.resolve()
    expect(registry.has('evt:mute')).toBe(false)

    nowMs += 10
    await expect(registry.run('evt:mute', failing)).rejects.toThrow('telegram 抖动')
    expect(attempts).toBe(2)
  })

  test('超过 TTL 后重新执行，并按需淘汰旧键', async () => {
    let nowMs = 1_000
    const registry = createIdempotencyRegistry({ ttlMs: 1_000, now: () => nowMs })
    let runs = 0
    const task = async () => {
      runs += 1
    }

    await registry.run('evt:delete', task)
    nowMs += 999
    await registry.run('evt:delete', task)
    expect(runs).toBe(1)

    nowMs += 2_000
    expect(registry.has('evt:delete')).toBe(false)
    await registry.run('evt:delete', task)
    expect(runs).toBe(2)
  })

  test('未完成的任务不过期：超过 TTL 仍在执行时，后来的调用共享同一个 Promise', async () => {
    let nowMs = 1_000
    const registry = createIdempotencyRegistry({ ttlMs: 1_000, now: () => nowMs })
    let runs = 0
    let release: (() => void) | undefined
    const task = async () => {
      runs += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'done'
    }

    const first = registry.run('evt:delete', task)
    // 任务还在跑（Telegram 抖动 / 退避重试都可能拖过 TTL），此时键不能失效。
    nowMs += 5_000
    expect(registry.has('evt:delete')).toBe(true)
    const second = registry.run('evt:delete', task)

    release?.()
    expect(await Promise.all([first, second])).toEqual(['done', 'done'])
    expect(runs).toBe(1)

    // TTL 从 settle 时刻（nowMs = 6_000）起算：还没到期时后来的调用仍然不执行 task。
    let retries = 0
    const laterTask = async () => {
      retries += 1
    }
    nowMs += 999
    await registry.run('evt:delete', laterTask)
    expect(retries).toBe(0)

    nowMs += 2
    await registry.run('evt:delete', laterTask)
    expect(retries).toBe(1)
  })
})
