/**
 * frontmatter `trace` / 一枚絵フィールドの設定 `trace` (#1197) の正規化。未指定・空・不正値は off（現行）。
 * 不正値は警告する（`warn=false` は警告だけ止める）
 */
export type TraceSetting = 'on' | 'off'

export function normalizeTrace(raw: string | null | undefined, warn = true): TraceSetting {
  if (typeof raw !== 'string' || raw.trim() === '') return 'off'
  const v = raw.trim().toLowerCase()
  if (v === 'on' || v === 'off') return v
  if (warn) console.warn(`trace '${raw}' は on / off のどちらでもないため off にした`)
  return 'off'
}
