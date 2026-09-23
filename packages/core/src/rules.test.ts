import { describe, expect, it } from 'vitest'
import { matchRules } from './rules.js'
import type { MessageFeatures, Rule } from './types.js'

const TEXT_FEATURES: MessageFeatures = { hasLink: false, mediaType: 'text', length: 12 }
const LINK_FEATURES: MessageFeatures = { hasLink: true, mediaType: 'text', length: 32 }

/** 规则构造器：只写与用例相关的字段，其余取固定默认值。 */
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

describe('matchRules: 匹配方式', () => {
  it('keyword 命中字面量子串', () => {
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ id: 'kw', score: 0.9 })])).toEqual([
      { kind: 'rule-hit', ruleId: 'kw', score: 0.9 },
    ])
    expect(matchRules('例行通知', TEXT_FEATURES, [ruleWith({})])).toEqual([])
  })

  it('regex 按正则源串匹配，支持 Unicode 属性写法', () => {
    const discount = ruleWith({ id: 're', kind: 'regex', pattern: '限时[0-9]折', score: 0.6 })
    expect(matchRules('限时8折', TEXT_FEATURES, [discount])).toEqual([{ kind: 'rule-hit', ruleId: 're', score: 0.6 }])

    const hanRun = ruleWith({ id: 'han', kind: 'regex', pattern: String.raw`\p{Script=Han}{3}`, score: 0.4 })
    expect(matchRules('大促销', TEXT_FEATURES, [hanRun])).toEqual([{ kind: 'rule-hit', ruleId: 'han', score: 0.4 }])
  })

  it('link-domain 按 host 精确匹配，含子域，不含后缀巧合', () => {
    const domainRule = ruleWith({ id: 'dom', kind: 'link-domain', pattern: 'spam.com', score: 0.8 })

    expect(matchRules('https://spam.com/x', LINK_FEATURES, [domainRule])).toEqual([
      { kind: 'rule-hit', ruleId: 'dom', score: 0.8 },
    ])
    expect(matchRules('https://a.spam.com/x', LINK_FEATURES, [domainRule])).toHaveLength(1)
    expect(matchRules('https://notspam.com/x', LINK_FEATURES, [domainRule])).toEqual([])
    expect(matchRules('https://spam.com.tw/x', LINK_FEATURES, [domainRule])).toEqual([])
  })

  it('link-domain 在没有链接时不判定', () => {
    const domainRule = ruleWith({ id: 'dom', kind: 'link-domain', pattern: 'spam.com', score: 0.8 })
    expect(matchRules('spam.com', TEXT_FEATURES, [domainRule])).toEqual([])
  })
})

describe('matchRules: 数据边界', () => {
  it('跳过未启用的规则', () => {
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ enabled: false })])).toEqual([])
  })

  it('坏正则只让该条规则失效，不外抛', () => {
    const rules = [ruleWith({ id: 'broken', kind: 'regex', pattern: '(' }), ruleWith({ id: 'ok', pattern: '免费' })]
    expect(matchRules('免费领取', TEXT_FEATURES, rules)).toEqual([{ kind: 'rule-hit', ruleId: 'ok', score: 0.5 }])
  })

  it('分数夹到 0..1', () => {
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ id: 'hot', score: 3 })])).toEqual([
      { kind: 'rule-hit', ruleId: 'hot', score: 1 },
    ])
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ id: 'cold', score: -1 })])).toEqual([
      { kind: 'rule-hit', ruleId: 'cold', score: 0 },
    ])
  })

  it('保留规则集中的相对顺序', () => {
    const rules = [ruleWith({ id: 'a', pattern: '免费', score: 0.2 }), ruleWith({ id: 'b', pattern: '领取', score: 0.3 })]
    expect(matchRules('免费领取', TEXT_FEATURES, rules)).toEqual([
      { kind: 'rule-hit', ruleId: 'a', score: 0.2 },
      { kind: 'rule-hit', ruleId: 'b', score: 0.3 },
    ])
  })
})
