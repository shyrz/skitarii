import { TRADITIONAL_TO_SIMPLIFIED, WORD_REPLACEMENTS, type Replacement } from './normalize-map.js'

/**
 * CJK 反规避归一化：把「人肉眼读成同一个词、机器字符串却不同」的写法收敛到一个规范形态，
 * 让规则层与 LLM 层面对同一份稳定文本。上游拿到原始文本后应立即调用本函数，后续匹配一律针对返回值。
 *
 * 处理的规避手法，按处理顺序：
 * 1. 兼容字符：数学字母、圈号、合字等经 NFKC 回落（`𝗳𝗿𝗲𝗲` → `free`，全角 `ＦＲＥＥ` → `free`）。
 * 2. 零宽字符：零宽空格/连接符、BOM、变体选择符等直接删除（`广​告` → `广告`）。
 * 3. 大小写：统一小写，`VX` 与 `vx` 视为同一形态。
 * 4. 字母内数字替身：`b1tco1n` → `bitcoin`。
 * 5. 夹杂标点空白：夹在汉字之间、或汉字与字母之间起拆词作用的空白与标点被删除（`广 告`、`免！费`）。
 * 6. 单字简繁转换，再应用词表：繁体、谐音、形近、缩写收敛到规范词（`廣告` → `广告`，`薇信` → `微信`）。
 *    两步必须分先后：词表按简体书写，若与单字转换同批执行，`紙飛機` 会在词表跑完之后才变成 `纸飞机`。
 * 7. 收尾：折叠残余空白、去掉首尾空白。
 *
 * 不做的事：不改写域名与 URL 语法字符（`.`、`:`、`/`、`@`、`-` 等一律保留），
 * 因此 `spam.com` 不会被折叠成 `spamcom`，`link-domain` 规则仍然可用。
 *
 * @param text 原始消息文本。允许任意 Unicode；孤立代理对与未知脚本按原样保留。
 * @returns 规范形态文本。幂等：`normalize(normalize(x)) === normalize(x)`。
 */
export function normalize(text: string): string {
  const folded = foldLatin(stripInvisible(text.normalize('NFKC')).toLowerCase())
  const joined = dropWordSeparators(folded)
  const canonical = applyWordReplacements(toSimplified(joined))
  return canonical.replace(/\s+/gu, ' ').trim()
}

/**
 * 零宽与不可见格式字符。
 *
 * 组成：软连字符；蒙古文元音分隔符；零宽空格/非连接符/连接符/双向标记；词连接符与不可见运算符；
 * 双向隔离符与弃用格式符；BOM；变体选择符（emoji 的 U+FE0F 会让 `❤️` 与 `❤` 字符串不等）；
 * 韩文填充符（常被当作空白塞进词中）。
 *
 * 只与 `replace` 搭配使用，因此带 `g`；下文的判定用正则一律不带 `g`，
 * 因为 `test()` 在带 `g` 的正则上会推进 `lastIndex`，同一字符两次调用结果不同。
 */
const INVISIBLE_CHARS = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\u2066-\u206f\u3164\ufeff\ufe00-\ufe0f]/gu

/** 拆词用的空白与标点符号：Unicode 通用类别 P（标点）、S（符号）、Z（分隔符）。无 `g`，见上。 */
const WORD_SEPARATOR = /[\p{P}\p{S}\s]/u

/** 纯空白，用于区分「空白拆词」与「标点拆词」。 */
const WHITESPACE_ONLY = /^\s+$/u

/**
 * 方块字：汉字（含扩展区与兼容区）与日文假名。
 * 不含韩文：韩文用空格分词，丢空格会破坏词边界；中日文不用空格分词，丢空格只合并不拆分。
 */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * 字母内部的单个数字/符号替身。
 *
 * 只折叠左右都是字母的单个字符，理由是替身只在词内出现：
 * `b1tco1n`、`fr3e` 是规避写法，而 `free100`、`$100`、`gpt-4o` 里的数字是数据本身，
 * 无条件折叠会把它们变成 `freeioo` 之类的噪声并引入假命中。
 */
const LEET_CHAR = /(?<=[a-z])[0134578@$](?=[a-z])/g

/** 替身 → 字母。`1`→`i` 而非 `l`：词频上 `i` 更常见，`l1nk` 一类写法由词表覆盖。 */
const LEET_FOLD: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
}

/**
 * 单字简繁转换的正则：把表里的繁体字拼成一个字符类，一次扫描替换。
 * 逐字 replaceAll 需要上百次全文扫描，字符类只扫一遍；键全部是汉字，不含 `]`、`-`、`^`、`\`，
 * 直接拼进字符类是安全的（扩表时新增的键也必须是单个汉字）。
 */
const TRADITIONAL_CHAR = new RegExp(`[${Object.keys(TRADITIONAL_TO_SIMPLIFIED).join('')}]`, 'gu')

/** 词表按 `from` 长度降序应用：长词先替换，等价于最长匹配，避免短词吃掉长词的开头。 */
const WORDS_LONGEST_FIRST: readonly Replacement[] = [...WORD_REPLACEMENTS].sort((a, b) => b.from.length - a.from.length)

/**
 * 删除零宽与不可见格式字符。
 *
 * @param text 任意文本。
 * @returns 删除后的文本。
 */
function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS, '')
}

/**
 * 折叠字母内部的单字符替身，规则见 `LEET_CHAR`。
 *
 * @param text 已小写的文本。
 * @returns 折叠后的文本。
 */
function foldLatin(text: string): string {
  return text.replace(LEET_CHAR, (char) => LEET_FOLD[char] ?? char)
}

/**
 * 删除拆词标点与空白。
 *
 * 分三种情况，避免误伤 URL：
 * - 两侧都是方块字：整段标点/空白全删（`广 告`、`免！费`、`广.告`）。汉字之间的点号不可能是域名语法。
 * - 有一侧是方块字，且该段只有空白：删除（`加 v`、`免费 free`）。混合写法里的空格是拆词手段。
 * - 其余：原样保留该段，只把段内连续空白折成一个空格（`spam.com`、`https://a.com/x-y`、英文词间空格）。
 *
 * 刻意不做「任意标点一律删除」：那会把 `spam.com` 变成 `spamcom`，让域名规则失效。
 *
 * @param text 已折叠 leet 的文本。
 * @returns 删除或折叠拆词符后的文本。
 */
function dropWordSeparators(text: string): string {
  const chars = Array.from(text)
  const out: string[] = []
  let index = 0

  while (index < chars.length) {
    const char = chars[index] ?? ''
    if (!WORD_SEPARATOR.test(char)) {
      out.push(char)
      index += 1
      continue
    }

    let runEnd = index
    while (runEnd < chars.length && WORD_SEPARATOR.test(chars[runEnd] ?? '')) {
      runEnd += 1
    }

    const run = chars.slice(index, runEnd).join('')
    const before = out.at(-1)
    const after = chars[runEnd]
    const known = before !== undefined && after !== undefined
    const bothCjk = known && CJK_CHAR.test(before) && CJK_CHAR.test(after)
    const joinsMixedScript = known && WHITESPACE_ONLY.test(run) && (CJK_CHAR.test(before) || CJK_CHAR.test(after))

    if (bothCjk || joinsMixedScript) {
      index = runEnd
      continue
    }

    out.push(run.replace(/\s+/gu, ' '))
    index = runEnd
  }

  return out.join('')
}

/**
 * 单字简繁转换。方向唯一，不存在歧义，逐字查表即可。
 *
 * @param text 已完成标点折叠的文本。
 * @returns 转换后的文本。
 */
function toSimplified(text: string): string {
  return text.replace(TRADITIONAL_CHAR, (char) => TRADITIONAL_TO_SIMPLIFIED[char] ?? char)
}

/**
 * 依次应用词表（谐音、形近、缩写），得到规范词形。
 *
 * @param text 已转换为简体的文本。
 * @returns 替换后的文本。
 */
function applyWordReplacements(text: string): string {
  let result = text
  for (const { from, to } of WORDS_LONGEST_FIRST) {
    if (result.includes(from)) {
      result = result.replaceAll(from, to)
    }
  }
  return result
}
