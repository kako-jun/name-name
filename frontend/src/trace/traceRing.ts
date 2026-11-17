/**
 * 内部トレースログ (#1197) のリングバッファと、記録値の無害化。
 * DOM・時計・保存先に触れない純粋な部品（テストしやすいよう trace.ts から切り出す）。
 */

/** 記録 1 件。n = 通し番号（セッション内）、t = 記録開始からの ms、k = 種別、d = 要点（無害化済み） */
export interface TraceEntry {
  n: number
  t: number
  k: string
  d?: TraceValue
}

/** 記録できる値。数値・短い文字列・真偽・null と、それらの配列・オブジェクトだけ（関数・循環・クラス実体は入れない） */
export type TraceValue =
  | number
  | string
  | boolean
  | null
  | TraceValue[]
  | { [key: string]: TraceValue }

/** 既定の保持件数。1 件約 100〜300 バイトで、満杯でも JSON は数百 KB に収まる */
export const TRACE_CAPACITY = 2000

/** 文字列の最大長。長い文はそもそも記録しない方針の保険（画像パス程度は十分入る） */
export const TRACE_MAX_STRING = 120

/** 深さの上限。これより深い入れ子は捨てる（循環参照・巨大オブジェクトの保険） */
const MAX_DEPTH = 5
/** 配列の最大要素数 */
const MAX_ARRAY = 64

/**
 * 個人情報になりうる自由文のキー。名前入力・合言葉・台詞本文などは、値の中身を見ずにキーで落とす。
 * 小文字化して比較する。
 */
const DENY_KEYS = new Set([
  'name',
  'text',
  'label',
  'message',
  'password',
  'pass',
  'passphrase',
  'input',
  'line',
  'title',
  'email',
])

/** 値を記録できる形にする。関数・undefined・非有限数・深すぎる入れ子・自由文のキーは落とす */
export function sanitizeTraceValue(v: unknown, depth = 0): TraceValue | undefined {
  if (v === null) return null
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined
    case 'boolean':
      return v
    case 'string':
      return v.length > TRACE_MAX_STRING ? v.slice(0, TRACE_MAX_STRING) + '…' : v
    case 'object': {
      if (depth >= MAX_DEPTH) return undefined
      if (Array.isArray(v)) {
        const out: TraceValue[] = []
        for (let i = 0; i < v.length && i < MAX_ARRAY; i++) {
          const s = sanitizeTraceValue(v[i], depth + 1)
          out.push(s === undefined ? null : s)
        }
        return out
      }
      const out: { [key: string]: TraceValue } = {}
      for (const key of Object.keys(v as object)) {
        if (DENY_KEYS.has(key.toLowerCase())) continue
        const s = sanitizeTraceValue((v as Record<string, unknown>)[key], depth + 1)
        if (s !== undefined) out[key] = s
      }
      return out
    }
    default:
      return undefined
  }
}

/** 固定長のリングバッファ。満杯になったら古いものから上書きする */
export class TraceRing {
  private readonly buf: (TraceEntry | undefined)[]
  private head = 0
  private count = 0
  private seq = 0

  constructor(readonly capacity: number = TRACE_CAPACITY) {
    this.buf = new Array<TraceEntry | undefined>(Math.max(1, Math.floor(capacity)))
  }

  /** 次に付く通し番号（= これまでに積んだ総数） */
  get total(): number {
    return this.seq
  }

  get size(): number {
    return this.count
  }

  push(t: number, k: string, d?: TraceValue): TraceEntry {
    const e: TraceEntry = d === undefined ? { n: this.seq, t, k } : { n: this.seq, t, k, d }
    this.seq++
    this.buf[this.head] = e
    this.head = (this.head + 1) % this.buf.length
    if (this.count < this.buf.length) this.count++
    return e
  }

  /** 古い順に取り出す（コピー） */
  toArray(): TraceEntry[] {
    const out: TraceEntry[] = []
    const start = (this.head - this.count + this.buf.length) % this.buf.length
    for (let i = 0; i < this.count; i++)
      out.push(this.buf[(start + i) % this.buf.length] as TraceEntry)
    return out
  }

  clear(): void {
    this.buf.fill(undefined)
    this.head = 0
    this.count = 0
    this.seq = 0
  }
}
