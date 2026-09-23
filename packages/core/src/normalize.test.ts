import { describe, expect, it } from 'vitest'
import { normalize } from './normalize.js'

/**
 * 断言一律写死期望字符串，不用快照：归一化的价值就在具体输出形态，
 * 快照会让「输出变了」和「有人手改快照」变得无法区分。
 */
describe('normalize: 全角与兼容字符', () => {
  it('全角 ASCII 折成半角并统一小写', () => {
    expect(normalize('ＦＲＥＥ')).toBe('free')
    expect(normalize('ＶＸ')).toBe('微信')
  })

  it('兼容字符经 NFKC 回落', () => {
    expect(normalize('𝗳𝗿𝗲𝗲')).toBe('free')
    expect(normalize('免费①')).toBe('免费1')
    expect(normalize('１００元')).toBe('100元')
  })
})

describe('normalize: 零宽字符', () => {
  it('删除零宽空格、零宽连接符与词中变体选择符', () => {
    expect(normalize('广\u200b告')).toBe('广告')
    expect(normalize('免\u200d费')).toBe('免费')
    expect(normalize('兼职\u2060刷单')).toBe('兼职刷单')
  })

  it('首尾 BOM 不残留', () => {
    expect(normalize('\ufeff广告')).toBe('广告')
  })
})

describe('normalize: 拆字型规避', () => {
  it('汉字之间的空白被删除', () => {
    expect(normalize('广 告')).toBe('广告')
    expect(normalize('兼 职 刷 单')).toBe('兼职刷单')
  })

  it('汉字之间的标点与符号被删除', () => {
    expect(normalize('广.告')).toBe('广告')
    expect(normalize('广·告')).toBe('广告')
    expect(normalize('广-告')).toBe('广告')
    expect(normalize('免🎁费')).toBe('免费')
  })

  it('换行与制表符同样被删除', () => {
    expect(normalize('免\n费\t领取')).toBe('免费领取')
  })

  it('汉字与字母之间的空白被删除', () => {
    expect(normalize('加 V')).toBe('加微信')
  })
})

describe('normalize: 标点夹杂', () => {
  it('全角标点夹在汉字之间时被删除', () => {
    expect(normalize('免！费！领！取')).toBe('免费领取')
    expect(normalize('免，费。领、取')).toBe('免费领取')
  })

  it('表情符号不阻断关键词，也不进入结果', () => {
    expect(normalize('免❤费')).toBe('免费')
  })
})

describe('normalize: 字母内替身', () => {
  it('折叠被字母夹住的单个数字与符号', () => {
    expect(normalize('b1tco1n')).toBe('bitcoin')
    expect(normalize('fr3e')).toBe('free')
    expect(normalize('p@ypal')).toBe('paypal')
  })

  it('不折叠数字本身有含义的写法', () => {
    expect(normalize('free100')).toBe('free100')
    expect(normalize('$100')).toBe('$100')
    expect(normalize('gpt-4o')).toBe('gpt-4o')
    expect(normalize('价格100元')).toBe('价格100元')
  })
})

describe('normalize: 词表替换', () => {
  it('形态相近与同音的微信写法收敛', () => {
    expect(normalize('薇信')).toBe('微信')
    expect(normalize('威信')).toBe('微信')
    expect(normalize('VX')).toBe('微信')
    expect(normalize('v 信')).toBe('微信')
  })

  it('繁体收敛为简体', () => {
    expect(normalize('廣告')).toBe('广告')
    expect(normalize('免費領取')).toBe('免费领取')
    expect(normalize('聯繫我們')).toBe('联系我们')
  })

  it('繁体词组经简繁转换后仍能命中词表', () => {
    expect(normalize('紙飛機')).toBe('电报')
  })
})

describe('normalize: 不误伤链接与英文', () => {
  it('URL 语法字符与域名原样保留', () => {
    expect(normalize('spam.com')).toBe('spam.com')
    expect(normalize('https://a.com/x-y?q=1')).toBe('https://a.com/x-y?q=1')
  })

  it('URL 旁的中文不受影响', () => {
    expect(normalize('免费领取 https://a.com 关注')).toBe('免费领取https://a.com关注')
  })

  it('英文词之间的空格保留并折叠多余空白', () => {
    expect(normalize('free    money')).toBe('free money')
    expect(normalize('free\nmoney')).toBe('free money')
  })
})

describe('normalize: 幂等', () => {
  it('二次归一化结果不变', () => {
    const once = normalize('廣 告：薇 信 b1tco1n')
    expect(normalize(once)).toBe(once)
  })
})
