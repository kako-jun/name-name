/**
 * 数の述語 (#871)。「数の性質」を条件にする式を、敵の条件（受けたダメージ）と、将来の対象指定（味方側の算術型、#876）が
 * **同じ語彙**で書けるように切り出した純粋関数。状態を持たず、乱数を使わない。
 *
 * 書式（`<主語>` は呼び出し側が先に取り除く。ここが受け取るのは主語より後ろ）:
 * - `=奇数` / `=偶数`
 * - `=3の倍数`（N は 1 以上の整数。`の` は省略可）
 * - `<N` `<=N` `>N` `>=N` `=N`（閾値・ちょうどの値。N は 0 以上の整数）
 * - 桁数: 主語に `桁数` を付けた場合は、数ではなくその 10 進の桁数（0 は 1 桁）を比較する（`桁数>=3`）。
 *   桁数の述語は比較だけを許す（`桁数=奇数` は書けない）
 *
 * 0 は偶数で、どんな N の倍数でもある（数学どおり）。負の数は偶奇・倍数を絶対値で見る（ダメージは非負なので通常は現れない）。
 */

export type CompareOp = '<' | '<=' | '>' | '>=' | '='

export type NumberPredicate =
  | { kind: 'parity'; parity: 'odd' | 'even' }
  | { kind: 'multiple'; of: number }
  | { kind: 'compare'; op: CompareOp; n: number }

const OP_RE = '(<=|>=|<|>|==|=)'
const PREDICATE_RE = new RegExp(`^${OP_RE}\\s*(.+)$`)

function toOp(raw: string): CompareOp {
  return raw === '==' ? '=' : (raw as CompareOp)
}

/** 比較演算 */
export function compareNumbers(left: number, op: CompareOp, right: number): boolean {
  switch (op) {
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    case '=':
      return left === right
  }
}

/**
 * 主語を除いた述語の文字列（`=奇数` `>=100` `=3の倍数` など）を解釈する。解釈できなければ理由の文字列を返す。
 * `compareOnly` が true（桁数など）のときは、奇数・偶数・倍数を不正にする
 */
export function parseNumberPredicate(raw: string, compareOnly = false): NumberPredicate | string {
  const m = PREDICATE_RE.exec(raw.trim())
  if (!m) return `'${raw.trim()}' は 演算子（< <= > >= =）で始まる必要があります`
  const op = toOp(m[1])
  const rhs = m[2].trim()
  if (/^\d+$/.test(rhs)) {
    const n = Number(rhs)
    if (!Number.isSafeInteger(n)) return `数 '${rhs}' が大きすぎます`
    return { kind: 'compare', op, n }
  }
  if (compareOnly) return `'${rhs}' は 0 以上の整数ではありません`
  if (op !== '=') return `奇数・偶数・倍数は = でだけ書けます（'${raw.trim()}'）`
  if (rhs === '奇数') return { kind: 'parity', parity: 'odd' }
  if (rhs === '偶数') return { kind: 'parity', parity: 'even' }
  const mult = /^(\d+)\s*の?\s*倍数$/.exec(rhs)
  if (mult) {
    const of = Number(mult[1])
    if (!Number.isSafeInteger(of) || of < 1) return `倍数 '${rhs}' の N は 1 以上の整数が必要です`
    return { kind: 'multiple', of }
  }
  return `'${rhs}' は 奇数 / 偶数 / N の倍数 / 0 以上の整数のいずれかです`
}

/** 述語を値に当てる。値が整数でない（NaN・小数）ときは常に false（安全側） */
export function matchesNumber(value: number, p: NumberPredicate): boolean {
  if (!Number.isInteger(value)) return false
  switch (p.kind) {
    case 'parity':
      return p.parity === 'odd' ? Math.abs(value) % 2 === 1 : Math.abs(value) % 2 === 0
    case 'multiple':
      return Math.abs(value) % p.of === 0
    case 'compare':
      return compareNumbers(value, p.op, p.n)
  }
}

/** 10 進の桁数（0 は 1 桁。符号は数えない） */
export function digitCount(value: number): number {
  return String(Math.trunc(Math.abs(value))).length
}
