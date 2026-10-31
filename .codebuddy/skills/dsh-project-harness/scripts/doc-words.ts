/**
 * The one definition of what a document's size is measured in, shared by the budget
 * gate and the bootstrap seed. The two must agree by construction: a ceiling seeded
 * under one definition and enforced under another is unsatisfiable or trivial, and
 * neither failure names the counting rule as its cause.
 */

/**
 * CJK ideographs: the unified block, its extension A, and the compatibility block.
 * Chinese and Japanese prose carries no word delimiters, so this is the only
 * stable machine unit for it.
 */
const CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/**
 * A document's word count: whitespace-delimited tokens plus one word per CJK
 * ideograph. A token-only count reads a Chinese paragraph as a single word, so a
 * ceiling sized for English prose would pass Chinese documents at any length.
 */
export function countDocWords(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean).length
  const ideographs = text.match(CJK_IDEOGRAPH)?.length ?? 0
  return tokens + ideographs
}
