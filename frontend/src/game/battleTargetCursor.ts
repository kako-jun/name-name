/**
 * 戦闘の対象選択・番の印の出し方 (#1189)。純粋関数のみ（this / PixiJS に触れない）。
 * frontmatter `battle_target_cursor`（JSON `battle.targetCursor`）:
 * - `off`（既定）= 従来どおり。対象には手（敵は右から左向き）と頭上の ▼、番の味方には頭上の ▼ と名前の左の黄色い ▶（対象選択の間は番の ▼ を隠す）
 * - `ff` = FF（SNES・ピクセルリマスター）の出し方。対象は手のカーソルだけで指し（▼ は出さない）、手は敵でも左から右向き。
 *   敵名ウィンドウ（#954）の対象の行を明るい帯で強調し、行のタップでもその敵を指す。番の味方は頭上の ▼（と名前の黄色）だけで示し、
 *   対象選択の間も ▼ を出したまま。ステータス窓の名前の左の ▶・▷ は出さない（FF に横向きの三角の印は無い。調査は #1189）
 * 他の設定（敵名ウィンドウ・ATB・窓の配置など）とは直交で、窓の寸法・配置は変えない。
 */
export type BattleTargetCursorMode = 'off' | 'ff'

/** frontmatter `battle_target_cursor` / JSON `targetCursor` の正規化。未指定・空は `off`、不正値は警告して `off`（`warn=false` は警告だけ止める） */
export function normalizeBattleTargetCursor(
  raw: string | null | undefined,
  warn = true
): BattleTargetCursorMode {
  if (typeof raw !== 'string' || raw.trim() === '') return 'off'
  const v = raw.trim().toLowerCase()
  if (v === 'ff') return 'ff'
  if (v === 'off') return 'off'
  if (warn) console.warn(`battle_target_cursor '${raw}' は off / ff ではないため off にした`)
  return 'off'
}

/** 対象選択の間、対象の頭上に ▼ を出すか（出すときは番の味方の ▼ を隠す＝従来）。`ff` は対象を手だけで指し、番の味方の ▼ を出したままにする */
export function showsTargetSelectMark(mode: BattleTargetCursorMode): boolean {
  return mode !== 'ff'
}

/** 番の味方の名前の左に ▶（と切り替え可能な味方の ▷）を出すか。`ff` は頭上の ▼ だけで番を示す */
export function showsStatusTurnMarker(mode: BattleTargetCursorMode): boolean {
  return mode !== 'ff'
}

/**
 * 敵名ウィンドウで明るい帯で強調する行（`targets` の敵が入る行。重複なし・行の順）。行に手は出さない（FF ピクセルリマスターと同じ）。
 * `rowMembers` は行ごとの生きている敵の index（`aggregateEnemyList` の `members`）。呼び出し側が渡した行（見えている行）だけを見る
 */
export function enemyListHighlightRows(
  rowMembers: readonly (readonly number[])[],
  targets: readonly number[]
): number[] {
  const out: number[] = []
  rowMembers.forEach((m, row) => {
    if (m.some((i) => targets.includes(i))) out.push(row)
  })
  return out
}

/**
 * 敵名ウィンドウの行をタップしたときに指す敵。いま指している敵がその行に入っていればそのまま（同名の別の個体へ飛ばない）、
 * 入っていなければ行の先頭（最初に現れた生存者）。行が無ければ -1
 */
export function enemyForListRow(
  rowMembers: readonly (readonly number[])[],
  row: number,
  current: number
): number {
  const m = rowMembers[row]
  if (!m || m.length === 0) return -1
  return m.includes(current) ? current : m[0]
}
