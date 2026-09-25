import { describe, expect, it } from 'vitest'
import { normalize } from './normalize.js'
import { matchRules } from './rules.js'
import type { MessageFeatures, Rule } from './types.js'

const TEXT_FEATURES: MessageFeatures = { hasLink: false, mediaType: 'text', length: 12, customEmojiCount: 0, emojiCount: 0, viaBot: false }
const LINK_FEATURES: MessageFeatures = { ...TEXT_FEATURES, hasLink: true, length: 32 }

/** 带自定义表情计数的特征，只用于 custom-emoji 用例。 */
function emojiFeatures(count: number): MessageFeatures {
  return { ...TEXT_FEATURES, customEmojiCount: count }
}

/** 带表情总数的特征，只用于 emoji-count 用例（customEmojiCount 保持 0，两个字段互不影响）。 */
function emojiCountFeatures(count: number): MessageFeatures {
  return { ...TEXT_FEATURES, emojiCount: count }
}

/** via-bot 的命中态特征；不命中时直接用 TEXT_FEATURES。 */
const VIA_BOT_FEATURES: MessageFeatures = { ...TEXT_FEATURES, viaBot: true }

/** 不参与身份判定的空身份：只测正文规则时用它占位。 */
const NO_IDENTITY = ''

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
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ id: 'kw', score: 0.9 })], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'kw', score: 0.9 },
    ])
    expect(matchRules('例行通知', TEXT_FEATURES, [ruleWith({})], NO_IDENTITY)).toEqual([])
  })

  it('regex 按正则源串匹配，支持 Unicode 属性写法', () => {
    const discount = ruleWith({ id: 're', kind: 'regex', pattern: '限时[0-9]折', score: 0.6 })
    expect(matchRules('限时8折', TEXT_FEATURES, [discount], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 're', score: 0.6 },
    ])

    const hanRun = ruleWith({ id: 'han', kind: 'regex', pattern: String.raw`\p{Script=Han}{3}`, score: 0.4 })
    expect(matchRules('大促销', TEXT_FEATURES, [hanRun], NO_IDENTITY)).toEqual([{ kind: 'rule-hit', ruleId: 'han', score: 0.4 }])
  })

  it('link-domain 按 host 精确匹配，含子域，不含后缀巧合', () => {
    const domainRule = ruleWith({ id: 'dom', kind: 'link-domain', pattern: 'spam.com', score: 0.8 })

    expect(matchRules('https://spam.com/x', LINK_FEATURES, [domainRule], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'dom', score: 0.8 },
    ])
    expect(matchRules('https://a.spam.com/x', LINK_FEATURES, [domainRule], NO_IDENTITY)).toHaveLength(1)
    expect(matchRules('https://notspam.com/x', LINK_FEATURES, [domainRule], NO_IDENTITY)).toEqual([])
    expect(matchRules('https://spam.com.tw/x', LINK_FEATURES, [domainRule], NO_IDENTITY)).toEqual([])
  })

  it('link-domain 在没有链接时不判定', () => {
    const domainRule = ruleWith({ id: 'dom', kind: 'link-domain', pattern: 'spam.com', score: 0.8 })
    expect(matchRules('spam.com', TEXT_FEATURES, [domainRule], NO_IDENTITY)).toEqual([])
  })
})

describe('matchRules: sender-name', () => {
  it('按正则匹配身份文本（显示名与用户名），命中假客服与 USDT 组合名', () => {
    const rules = [
      ruleWith({ id: 'name-ad', kind: 'sender-name', pattern: '客服|助手', score: 0.4 }),
      ruleWith({ id: 'name-crypto', kind: 'sender-name', pattern: 'usdt|usdc', score: 0.4 }),
    ]

    // 归一化由管线负责；规则 pattern 面对的就是这份形态。
    const identity = normalize('【官方】usdt兑换客服小美')
    expect(matchRules('你好', TEXT_FEATURES, rules, identity)).toEqual([
      { kind: 'rule-hit', ruleId: 'name-ad', score: 0.4 },
      { kind: 'rule-hit', ruleId: 'name-crypto', score: 0.4 },
    ])
  })

  it('身份文本不参与正文规则，正文也不参与 sender-name 规则', () => {
    const textRule = ruleWith({ id: 'text', kind: 'keyword', pattern: '客服' })
    const nameRule = ruleWith({ id: 'name', kind: 'sender-name', pattern: '客服' })

    expect(matchRules('客服在线', TEXT_FEATURES, [nameRule], NO_IDENTITY)).toEqual([])
    expect(matchRules('你好', TEXT_FEATURES, [textRule], '客服小美')).toEqual([])
  })

  it('空身份不命中', () => {
    expect(matchRules('你好', TEXT_FEATURES, [ruleWith({ kind: 'sender-name', pattern: '客服' })], '')).toEqual([])
  })

  it('身份规则的坏正则只让该条规则失效，不外抛', () => {
    const rules = [
      ruleWith({ id: 'broken', kind: 'sender-name', pattern: '(' }),
      ruleWith({ id: 'ok', kind: 'sender-name', pattern: '客服' }),
    ]
    expect(matchRules('你好', TEXT_FEATURES, rules, '客服小美')).toEqual([{ kind: 'rule-hit', ruleId: 'ok', score: 0.5 }])
  })
})

describe('matchRules: custom-emoji', () => {
  it('达到最小计数即命中', () => {
    const rule = ruleWith({ id: 'emoji', kind: 'custom-emoji', pattern: '6' })

    expect(matchRules('你好', emojiFeatures(6), [rule], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'emoji', score: 0.5 },
    ])
    expect(matchRules('你好', emojiFeatures(7), [rule], NO_IDENTITY)).toHaveLength(1)
    expect(matchRules('你好', emojiFeatures(5), [rule], NO_IDENTITY)).toEqual([])
  })

  it('前导零按数值解析：06 等同 6', () => {
    const rule = ruleWith({ id: 'emoji-padded', kind: 'custom-emoji', pattern: '06' })

    expect(matchRules('你好', emojiFeatures(6), [rule], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'emoji-padded', score: 0.5 },
    ])
    expect(matchRules('你好', emojiFeatures(5), [rule], NO_IDENTITY)).toEqual([])
  })

  it('pattern 必须整体是十进制数字：非法数据静默不命中（与坏正则同类行为）', () => {
    // '-1' 经 Number.parseInt 会解析成 -1 并命中任何非负计数，必须按坏数据失效；
    // 超长数字串解析结果超出安全整数范围，同样失效。
    const patterns = ['-1', '6abc', '6.5', '', ' 6 ', '+6', '很多', '9'.repeat(20)]
    const rules = patterns.map((pattern, index) => ruleWith({ id: `bad-${index}`, kind: 'custom-emoji', pattern }))

    expect(matchRules('你好', emojiFeatures(100), rules, NO_IDENTITY)).toEqual([])
  })
})

describe('matchRules: emoji-count', () => {
  it('达到最小计数即命中，低于阈值不命中', () => {
    const rule = ruleWith({ id: 'flood', kind: 'emoji-count', pattern: '6' })

    expect(matchRules('你好', emojiCountFeatures(6), [rule], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'flood', score: 0.5 },
    ])
    expect(matchRules('你好', emojiCountFeatures(100), [rule], NO_IDENTITY)).toHaveLength(1)
    expect(matchRules('你好', emojiCountFeatures(5), [rule], NO_IDENTITY)).toEqual([])
  })

  it('pattern 必须整体是十进制数字：坏数据静默不命中（与 custom-emoji 同口径）', () => {
    const patterns = ['-1', '6abc', '6.5', '', ' 6 ', '+6', '很多', '9'.repeat(20)]
    const rules = patterns.map((pattern, index) => ruleWith({ id: `bad-${index}`, kind: 'emoji-count', pattern }))

    expect(matchRules('你好', emojiCountFeatures(100), rules, NO_IDENTITY)).toEqual([])
  })

  it('只看 emojiCount，不被 customEmojiCount 顶替', () => {
    const rule = ruleWith({ id: 'flood', kind: 'emoji-count', pattern: '6' })

    expect(matchRules('你好', emojiFeatures(100), [rule], NO_IDENTITY)).toEqual([])
  })
})

describe('matchRules: via-bot', () => {
  it('匹配 viaBot 特征；pattern 内容（含坏数据）不影响结果', () => {
    const rules = [
      ruleWith({ id: 'via-empty', kind: 'via-bot', pattern: '' }),
      ruleWith({ id: 'via-junk', kind: 'via-bot', pattern: '(((' }),
    ]

    expect(matchRules('你好', VIA_BOT_FEATURES, rules, NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'via-empty', score: 0.5 },
      { kind: 'rule-hit', ruleId: 'via-junk', score: 0.5 },
    ])
    expect(matchRules('你好', TEXT_FEATURES, rules, NO_IDENTITY)).toEqual([])
  })
})

describe('matchRules: 数据边界', () => {
  it('跳过未启用的规则', () => {
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ enabled: false })], NO_IDENTITY)).toEqual([])
  })

  it('坏正则只让该条规则失效，不外抛', () => {
    const rules = [ruleWith({ id: 'broken', kind: 'regex', pattern: '(' }), ruleWith({ id: 'ok', pattern: '免费' })]
    const signals = matchRules('免费领取', TEXT_FEATURES, rules, NO_IDENTITY)

    // 坏规则的 ruleId 不能出现在信号里：否则运维会误以为它在工作。
    expect(signals.map((signal) => (signal.kind === 'rule-hit' ? signal.ruleId : ''))).not.toContain('broken')
    expect(signals).toEqual([{ kind: 'rule-hit', ruleId: 'ok', score: 0.5 }])
  })

  it('分数夹到 0..1', () => {
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ id: 'hot', score: 3 })], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'hot', score: 1 },
    ])
    expect(matchRules('免费领取', TEXT_FEATURES, [ruleWith({ id: 'cold', score: -1 })], NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'cold', score: 0 },
    ])
  })

  it('保留规则集中的相对顺序', () => {
    const rules = [ruleWith({ id: 'a', pattern: '免费', score: 0.2 }), ruleWith({ id: 'b', pattern: '领取', score: 0.3 })]
    expect(matchRules('免费领取', TEXT_FEATURES, rules, NO_IDENTITY)).toEqual([
      { kind: 'rule-hit', ruleId: 'a', score: 0.2 },
      { kind: 'rule-hit', ruleId: 'b', score: 0.3 },
    ])
  })
})
