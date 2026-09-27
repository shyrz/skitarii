import { describe, expect, test } from 'vitest'
import type { Rule } from '@skitarii/core'
import { missingDefaultRules } from './backfill-default-rules.js'
import { DEFAULT_RULES } from './defaults.js'

/** 规则构造器：只写与用例相关的字段，其余取固定默认值。 */
function customRule(overrides: Partial<Rule>): Rule {
  return {
    id: 'custom-1',
    kind: 'keyword',
    pattern: '自定义',
    score: 0.5,
    actionHint: 'delete',
    enabled: true,
    ...overrides,
  }
}

/** 按 id 取一条默认规则；取不到说明测试样本与 `DEFAULT_RULES` 脱节，直接失败。 */
function defaultRuleById(id: string): Rule {
  const found = DEFAULT_RULES.find((rule) => rule.id === id)
  if (found === undefined) throw new Error(`DEFAULT_RULES 中不存在 ${id}`)
  return found
}

describe('missingDefaultRules', () => {
  test('无缺失：全部默认规则已存在（含被手改过的）时返回空数组', () => {
    expect(missingDefaultRules([...DEFAULT_RULES])).toEqual([])

    // 判据是 id：owner 改过 score 的默认规则视为已覆盖，不会被回填覆盖。
    const tweaked = DEFAULT_RULES.map((rule) =>
      rule.id === 'default-ad-wechat' ? { ...rule, score: 0.9 } : { ...rule },
    )
    expect(missingDefaultRules(tweaked)).toEqual([])
  })

  test('全缺失：空规则集返回全部默认规则的副本', () => {
    const missing = missingDefaultRules([])

    expect(missing).toEqual(DEFAULT_RULES)
    expect(missing.map((rule) => rule.id)).toEqual(DEFAULT_RULES.map((rule) => rule.id))
    // 副本语义：模块级常量不随回填结果被改动。
    expect(missing[0]).not.toBe(DEFAULT_RULES[0])
  })

  test('混合：保留现有规则与顺序，缺失项按默认顺序追加到尾部', () => {
    const kept = defaultRuleById('default-scam-rebate')
    const custom = customRule({ id: 'custom-keep' })
    const existing: Rule[] = [custom, { ...kept, score: 0.9 }]

    const missing = missingDefaultRules(existing)
    const expectedIds = DEFAULT_RULES.filter((rule) => rule.id !== kept.id).map((rule) => rule.id)
    expect(missing.map((rule) => rule.id)).toEqual(expectedIds)

    const merged = [...existing, ...missing]
    expect(merged.map((rule) => rule.id)).toEqual([custom.id, kept.id, ...expectedIds])
    // 不产生重复 id：回填后每个 id 仍只出现一次。
    expect(new Set(merged.map((rule) => rule.id)).size).toBe(merged.length)
  })
})
