/**
 * ジョブの変換ルール (#876 段階 1)。`[ジョブ id]` の `変換: <タグ> => <トークン>[ <トークン>…]` が、そのジョブに就いている間だけ、
 * そのタグの特技・呪文（`[特技]` / `[呪文]` の `タグ:`）の**効果の文字列**にトークンを足す・上書きする。
 *
 * - トークンは既存の効果 DSL が持つ修飾（`回数=2` `確率=50` `type=fire` `レア率=…` `枠=…` `ぶんどる=…` 等の `キー=値`）をそのまま使う。新しい演算・語彙は作らない
 *   （同じキーが効果にあれば値を置き換え、無ければ末尾に足す。足した結果が `parseEffect` で解釈できない・足した修飾が無視される効果には無視して警告する）
 * - 効かせるのは効果の評価の**前**で、変換後の文字列を普通の効果として評価するだけ（乱数の消費順は評価側のまま）。builtin の特技・呪文は変換しない
 * - ジョブを持たない・変換が無い・タグが合わない特技・呪文は、渡した値のまま（`undefined` を返す）。従来と同一
 * - 変換が効いた特技・呪文には、使ったときの戦闘ログに「(〇〇ジョブの 効果)」を 1 行足す（`convertedBy`）
 */
import { parseEffect } from './spellDsl'

export interface JobConversion {
  tag: string
  tokens: string[]
}

/** `変換:` の行（`<タグ> => <トークン>…`）を解釈する。不正な行・トークンは警告にして捨てる */
export function parseConversions(lines: readonly string[] | undefined): {
  conversions: JobConversion[]
  warnings: string[]
} {
  const conversions: JobConversion[] = []
  const warnings: string[] = []
  for (const line of lines ?? []) {
    const at = line.indexOf('=>')
    const tag = at < 0 ? '' : line.slice(0, at).trim()
    if (tag === '') {
      warnings.push(`変換 '${line}': 「<タグ> => <トークン>」の形ではありません`)
      continue
    }
    const tokens: string[] = []
    for (const t of line
      .slice(at + 2)
      .trim()
      .split(/\s+/)
      .filter((s) => s !== '')) {
      if (/^[^\s=]+=\S+$/.test(t)) tokens.push(t)
      else warnings.push(`変換 '${line}': '${t}' は キー=値 の形ではないため無視した`)
    }
    if (tokens.length > 0) conversions.push({ tag, tokens })
    else warnings.push(`変換 '${line}': トークンがありません`)
  }
  return { conversions, warnings }
}

const warned = new Set<string>()
function warnOnce(msg: string): void {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(`[name-name] ${msg}`)
}

/**
 * 効果の文字列にトークンを足す・上書きする。変換できないトークン（解釈できない効果になる・足した修飾が無視される）は警告して飛ばす。
 * 効いたトークンが 1 つも無ければ `undefined`（効果は変わらない）
 */
export function convertEffect(
  effect: string,
  tokens: readonly string[],
  label: string
): string | undefined {
  let current = effect.trim()
  let changed = false
  for (const token of tokens) {
    const key = token.slice(0, token.indexOf('='))
    const parts = current.split(/\s+/)
    const at = parts.findIndex((p, i) => i > 0 && p.startsWith(key + '='))
    const next =
      at >= 0 ? parts.map((p, i) => (i === at ? token : p)).join(' ') : `${current} ${token}`
    if (next === current) continue
    const before = parseEffect(current)
    const after = parseEffect(next)
    if (!after || (after.warnings?.length ?? 0) > (before?.warnings?.length ?? 0)) {
      warnOnce(`${label}: 変換 '${token}' は効果 '${effect}' に足せないため無視した`)
      continue
    }
    current = next
    changed = true
  }
  return changed ? current : undefined
}

/**
 * 味方の現在のジョブ（`conversions` 付き）で、タグ `tags` の特技・呪文の効果 `effect` を変換する。
 * 変換が効いたときだけ `{ effect, convertedBy }`（`convertedBy` はジョブの名前）。それ以外は `undefined`（従来と同一）
 */
export function convertForJob(
  job: { id: string; name: string; conversions?: string[] } | undefined,
  tags: readonly string[] | undefined,
  effect: string | undefined,
  label: string
): { effect: string; convertedBy: string } | undefined {
  if (!job?.conversions || !tags || tags.length === 0 || effect === undefined) return undefined
  const { conversions, warnings } = parseConversions(job.conversions)
  for (const w of warnings) warnOnce(`ジョブ '${job.id}': ${w}`)
  let current = effect
  let changed = false
  for (const c of conversions) {
    if (!tags.includes(c.tag)) continue
    const next = convertEffect(current, c.tokens, `ジョブ '${job.id}' の ${label}`)
    if (next !== undefined) {
      current = next
      changed = true
    }
  }
  return changed ? { effect: current, convertedBy: job.name } : undefined
}
