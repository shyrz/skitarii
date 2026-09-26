import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECIDIVISM_THRESHOLD, decide, scoreOf } from './decide.js'
import { asChatId } from './types.js'
import type { ChatConfig, Rule, Signal } from './types.js'

/** 规则构造器：只写与用例相关的字段。 */
function ruleWith(overrides: Partial<Rule>): Rule {
  return {
    id: 'r1',
    kind: 'keyword',
    pattern: '免费',
    score: 0.5,
    actionHint: 'delete',
    enabled: true,
    ...overrides,
  }
}

/** 配置构造器：两个阈值默认 0.4 / 0.8，落在灰色地带的分数是 0.4..0.8。 */
function configWith(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    chatId: asChatId('-1001234567890'),
    title: '测试群',
    chatType: 'supergroup',
    linkedChatId: null,
    language: 'zh',
    rules: [ruleWith({ id: 'r1', score: 0.5, actionHint: 'delete' })],
    passThreshold: 0.4,
    llmThreshold: 0.8,
    muteDurationMinutes: 60,
    ...overrides,
  }
}

function hit(ruleId: string, score: number): Signal {
  return { kind: 'rule-hit', ruleId, score }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('decide: 双阈值', () => {
  it('低于 passThreshold 直接放行，不看 actionHint', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.2, actionHint: 'ban' })] })
    expect(decide([hit('r1', 0.2)], config, { priorViolations: 0 })).toEqual({ kind: 'pass' })
  })

  it('恰好等于 passThreshold 不再放行，进入复核区间', () => {
    expect(decide([hit('r1', 0.4)], configWith(), { priorViolations: 0 })).toEqual({ kind: 'warn' })
  })

  it('达到 llmThreshold 直接按主导规则处置，不进复核', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.9, actionHint: 'delete' })] })
    expect(decide([hit('r1', 0.9)], config, { priorViolations: 0 })).toEqual({ kind: 'delete' })
  })

  it('恰好等于 llmThreshold 即直接处置', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.8, actionHint: 'mute' })] })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'))
    expect(decide([hit('r1', 0.8)], config, { priorViolations: 0 })).toEqual({
      kind: 'mute',
      until: new Date('2026-09-23T01:00:00.000Z'),
    })
  })

  it('单条都不够、累加后越过阈值，按主导规则处置', () => {
    const config = configWith({
      rules: [ruleWith({ id: 'a', score: 0.375, actionHint: 'warn' }), ruleWith({ id: 'b', score: 0.5, actionHint: 'delete' })],
    })
    expect(decide([hit('a', 0.375), hit('b', 0.5)], config, { priorViolations: 0 })).toEqual({ kind: 'delete' })
  })

  it('同分的主导规则取先命中者', () => {
    const config = configWith({
      rules: [ruleWith({ id: 'a', score: 0.9, actionHint: 'delete' }), ruleWith({ id: 'b', score: 0.9, actionHint: 'ban' })],
    })
    expect(decide([hit('a', 0.9), hit('b', 0.9)], config, { priorViolations: 0 })).toEqual({ kind: 'delete' })
  })
})

describe('decide: 灰色地带的 LLM 复核', () => {
  it('没有复核信号时给出待复核的 warn', () => {
    expect(decide([hit('r1', 0.5)], configWith(), { priorViolations: 0 })).toEqual({ kind: 'warn' })
  })

  it('复核判定为正常则放行', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.5, actionHint: 'delete' })] })
    const signals: Signal[] = [hit('r1', 0.5), { kind: 'llm', verdict: 'legit', confidence: 0.9 }]
    expect(decide(signals, config, { priorViolations: 0 })).toEqual({ kind: 'pass' })
  })

  it('复核判定为垃圾则落到主导规则的 actionHint', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.5, actionHint: 'delete' })] })
    const signals: Signal[] = [hit('r1', 0.5), { kind: 'llm', verdict: 'spam', confidence: 0.2 }]
    expect(decide(signals, config, { priorViolations: 0 })).toEqual({ kind: 'delete' })
  })

  it('高置信复核把总分推过阈值，同样处置', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.5, actionHint: 'mute' })] })
    const signals: Signal[] = [hit('r1', 0.5), { kind: 'llm', verdict: 'scam', confidence: 0.9 }]
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'))
    expect(decide(signals, config, { priorViolations: 0 })).toEqual({
      kind: 'mute',
      until: new Date('2026-09-23T13:00:00.000Z'),
    })
  })

  it('规则未命中时，复核判定违规用默认档位处置', () => {
    const signals: Signal[] = [{ kind: 'llm', verdict: 'scam', confidence: 0.95 }]
    expect(decide(signals, configWith(), { priorViolations: 0 })).toEqual({ kind: 'delete' })
  })

  it('信号里引用的规则已从配置删除时退到默认档位', () => {
    expect(decide([hit('已删除的规则', 0.9)], configWith(), { priorViolations: 0 })).toEqual({ kind: 'delete' })
  })
})

describe('decide: 累犯加重', () => {
  it('未达阈值不加重', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.9, actionHint: 'warn' })] })
    expect(decide([hit('r1', 0.9)], config, { priorViolations: 2 })).toEqual({ kind: 'warn' })
  })

  it('达到阈值后 warn 加重为 delete', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.9, actionHint: 'warn' })] })
    expect(decide([hit('r1', 0.9)], config, { priorViolations: RECIDIVISM_THRESHOLD })).toEqual({ kind: 'delete' })
  })

  it('达到阈值后 delete 加重为 mute，时长取自配置', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.9, actionHint: 'delete' })], muteDurationMinutes: 30 })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'))
    expect(decide([hit('r1', 0.9)], config, { priorViolations: 3 })).toEqual({
      kind: 'mute',
      until: new Date('2026-09-23T00:30:00.000Z'),
    })
  })

  it('达到阈值后 mute 加重为 ban', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.9, actionHint: 'mute' })] })
    expect(decide([hit('r1', 0.9)], config, { priorViolations: 5 })).toEqual({ kind: 'ban' })
  })

  it('ban 已是最高档，不再加重', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.9, actionHint: 'ban' })] })
    expect(decide([hit('r1', 0.9)], config, { priorViolations: 9 })).toEqual({ kind: 'ban' })
  })

  it('复核放行不因累犯被加重', () => {
    const config = configWith({ rules: [ruleWith({ id: 'r1', score: 0.5, actionHint: 'delete' })] })
    const signals: Signal[] = [hit('r1', 0.5), { kind: 'llm', verdict: 'legit', confidence: 0.8 }]
    expect(decide(signals, config, { priorViolations: 9 })).toEqual({ kind: 'pass' })
  })

  it('待复核的 warn 不参与加重', () => {
    expect(decide([hit('r1', 0.5)], configWith(), { priorViolations: 9 })).toEqual({ kind: 'warn' })
  })
})

describe('scoreOf: 合并口径', () => {
  it('规则分数累加并封顶 1', () => {
    expect(scoreOf([hit('a', 0.6), hit('b', 0.6)])).toBe(1)
    expect(scoreOf([hit('a', 0.25), hit('b', 0.25)])).toBe(0.5)
    expect(scoreOf([])).toBe(0)
  })

  it('复核判定为正常时不贡献分数', () => {
    expect(scoreOf([hit('a', 0.5), { kind: 'llm', verdict: 'legit', confidence: 0.9 }])).toBe(0.5)
  })

  it('多条复核信号只取置信度最高的一条', () => {
    expect(
      scoreOf([
        { kind: 'llm', verdict: 'spam', confidence: 0.25 },
        { kind: 'llm', verdict: 'scam', confidence: 0.5 },
        hit('a', 0.25),
      ]),
    ).toBe(0.75)
  })
})
