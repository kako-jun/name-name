/**
 * 戦闘コマンド窓の配置・表示名・十字キーの対応 (#204)。純粋関数のみ（this / PixiJS に触れない）。
 *
 * - 配置 `grid`（既定・2x2）/ `cross`（FF6 の「短縮」風の十字。上・左・右・下に 1 コマンドずつ）
 * - 表示名: コマンド id（attack / spell / item / escape）は固定のまま、label だけをゲームの設定から差し替える
 * - `cross` のキー: 矢印キー 1 押しでその方向のコマンドを決定する（上=たたかう・左=じゅもん・右=どうぐ・下=にげる）
 *
 * 座標の計算は battleLayout.ts の `computeCommandCells`、描画と入力の配線は BattleScreen.ts が行う。
 */

export type CommandId = 'attack' | 'spell' | 'item' | 'escape'
export type CommandLayout = 'grid' | 'cross'

/** コマンドの並び（グリッドの左上から右下 = 十字の 上・左・右・下 の順）と既定の表示名 */
export const COMMAND_DEFAULTS: ReadonlyArray<{ id: CommandId; label: string }> = [
  { id: 'attack', label: 'たたかう' },
  { id: 'spell', label: 'じゅもん' },
  { id: 'item', label: 'どうぐ' },
  { id: 'escape', label: 'にげる' },
]

/** 表示名の上書き。部分指定可（省略は既定の日本語） */
export type CommandLabels = Partial<Record<CommandId, string>>

const COMMAND_IDS: ReadonlySet<string> = new Set(COMMAND_DEFAULTS.map((c) => c.id))

/** frontmatter `battle_command_layout` の値を正規化する。`'cross'` 以外（未指定・空・未知値含む）は `'grid'`（大小無視） */
export function normalizeCommandLayout(raw: string | null | undefined): CommandLayout {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'cross' ? 'cross' : 'grid'
}

/**
 * frontmatter `battle_command_labels` を解釈する。`attack=斬る, spell=魔石` のように `id=表示名` をカンマ
 * （`,` / `，`）区切りで並べる。id は attack / spell / item / escape。未知の id・空の表示名・`=` のない項目は無視する。
 * 同じ id が複数あれば後のものが勝つ。有効な指定が 1 つもなければ undefined。
 */
export function parseCommandLabels(raw: string | null | undefined): CommandLabels | undefined {
  if (typeof raw !== 'string') return undefined
  const out: CommandLabels = {}
  let any = false
  for (const part of raw.split(/[,，]/)) {
    const m = /^\s*([A-Za-z]+)\s*[=＝]\s*(.*?)\s*$/.exec(part)
    if (!m) continue
    const id = m[1].toLowerCase()
    if (!COMMAND_IDS.has(id) || m[2] === '') continue
    out[id as CommandId] = m[2]
    any = true
  }
  return any ? out : undefined
}

/** 既定の並びに表示名の上書きを当てる。省略・空文字の id は既定のまま */
export function resolveCommandSpecs(
  labels?: CommandLabels | null
): Array<{ id: CommandId; label: string }> {
  return COMMAND_DEFAULTS.map((c) => {
    const o = labels?.[c.id]
    return { id: c.id, label: typeof o === 'string' && o.trim() !== '' ? o : c.label }
  })
}

/** `cross` の矢印キー（KeyboardEvent.key）→ コマンド id。矢印以外は undefined */
export function crossKeyToCommandId(key: string): CommandId | undefined {
  switch (key) {
    case 'ArrowUp':
      return 'attack'
    case 'ArrowLeft':
      return 'spell'
    case 'ArrowRight':
      return 'item'
    case 'ArrowDown':
      return 'escape'
    default:
      return undefined
  }
}
