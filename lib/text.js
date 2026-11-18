// memory-recall · lib/text.js
// 分词与 BM25。中文无空格，CJK 连续段切 bigram；拉丁段整词小写。
// 分词规则与 meow-memory 同类（NFKC + bigram），但实现独立，不 import 原插件。

const EN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my',
  'not', 'of', 'on', 'or', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will',
  'with', 'you', 'your',
])

const ZH_STOPWORDS = new Set([
  '这个', '那个', '一个', '我们', '你们', '他们', '什么', '怎么', '可以', '还是', '就是',
  '这样', '那样', '一下', '现在', '然后', '所以', '因为', '但是', '如果', '已经', '有点',
])

/** 一个码位是否属于需要 bigram 的表意文字区（CJK 汉字 / 假名 / 谚文）。 */
function isIdeographic(cp) {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  )
}

function isWordChar(cp) {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    cp === 0x5f // _
  )
}

/**
 * 文本 → token 数组。
 * @param {string} text 任意文本
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const cps = Array.from(text.normalize('NFKC'))
  const out = []
  let i = 0
  while (i < cps.length) {
    const cp = cps[i].codePointAt(0)

    if (isIdeographic(cp)) {
      let j = i + 1
      while (j < cps.length && isIdeographic(cps[j].codePointAt(0))) j++
      const run = cps.slice(i, j)
      for (let k = 0; k + 1 < run.length; k++) {
        const bigram = run[k] + run[k + 1]
        if (!ZH_STOPWORDS.has(bigram)) out.push(bigram)
      }
      i = j
      continue
    }

    if (isWordChar(cp)) {
      let j = i + 1
      while (j < cps.length && isWordChar(cps[j].codePointAt(0))) j++
      const word = cps.slice(i, j).join('').toLowerCase()
      if (word.length > 1 && !EN_STOPWORDS.has(word)) out.push(word)
      i = j
      continue
    }

    i++
  }
  return out
}

/** 文档的检索面：标题 + 正文 + 关键词。 */
export function docText(row) {
  return [row.title, row.content, row.keywords.join(' ')].join(' ').trim()
}

/**
 * BM25 打分（语料 = 本次候选集）。返回与 docs 等长的分数数组。
 * @param {string[]} queryTokens
 * @param {string[][]} docsTokens 每个文档的 token 数组
 * @param {{ k1?: number, b?: number }} [opts]
 * @returns {number[]}
 */
export function bm25(queryTokens, docsTokens, opts = {}) {
  const k1 = opts.k1 ?? 1.2
  const b = opts.b ?? 0.75
  const n = docsTokens.length
  const scores = new Array(n).fill(0)
  if (n === 0 || queryTokens.length === 0) return scores

  const docLen = docsTokens.map((t) => t.length)
  const avgLen = docLen.reduce((a, x) => a + x, 0) / n || 1

  const tf = docsTokens.map((tokens) => {
    const m = new Map()
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  })
  const df = new Map()
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)

  const qSet = new Set(queryTokens)
  for (let d = 0; d < n; d++) {
    let score = 0
    for (const t of qSet) {
      const f = tf[d].get(t) ?? 0
      if (f === 0) continue
      const dfi = df.get(t) ?? 0
      const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docLen[d]) / avgLen)))
    }
    scores[d] = score
  }
  return scores
}
