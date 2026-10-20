/**
 * 戦闘コマンド窓の配置・表示名・十字キーの対応 (#204)。純粋関数のみ（this / PixiJS に触れない）。
 *
 * - 配置 `grid`（既定・2x2）/ `cross`（FF6 の「短縮」風の十字。上・左・右・下に 1 コマンドずつ）
 * - 表示名: コマンド id（attack / skill / spell / item / escape）は固定のまま、label だけをゲームの設定から差し替える
 * - 構成と順序 (#873): frontmatter `battle_commands: skill, spell, item, escape` で、使うコマンドの列と順序を変えられる
 *   （未指定は attack / spell / item / escape）。新しいコマンドの種類は `skill`（わざ）だけで、特殊なコマンドは足さない
 * - `cross` のキー: 矢印キー 1 押しでその**位置**のコマンドを決定する（1 番目=上・2 番目=左・3 番目=右・4 番目=下。
 *   既定の並びでは 上=たたかう・左=じゅもん・右=どうぐ・下=にげる）
 *
 * 座標の計算は battleLayout.ts の `computeCommandCells`、描画と入力の配線は BattleScreen.ts が行う。
 */

export type CommandId = 'attack' | 'skill' | 'spell' | 'item' | 'escape'
export type CommandLayout = 'grid' | 'cross'

/** コマンド id ごとの既定の表示名 */
export const COMMAND_DEFAULT_LABELS: Readonly<Record<CommandId, string>> = {
  attack: 'たたかう',
  skill: 'わざ',
  spell: 'じゅもん',
  item: 'どうぐ',
  escape: 'にげる',
}

/** 既定のコマンドの並び（グリッドの左上から右下 = 十字の 上・左・右・下 の順）と既定の表示名。`battle_commands` 未指定のとき */
export const COMMAND_DEFAULTS: ReadonlyArray<{ id: CommandId; label: string }> = (
  ['attack', 'spell', 'item', 'escape'] as const
).map((id) => ({ id, label: COMMAND_DEFAULT_LABELS[id] }))

/** 表示名の上書き。部分指定可（省略は既定の日本語） */
export type CommandLabels = Partial<Record<CommandId, string>>

const COMMAND_IDS: ReadonlySet<string> = new Set(Object.keys(COMMAND_DEFAULT_LABELS))

/** frontmatter `battle_command_layout` の値を正規化する。`'cross'` 以外（未指定・空・未知値含む）は `'grid'`（大小無視） */
export function normalizeCommandLayout(raw: string | null | undefined): CommandLayout {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'cross' ? 'cross' : 'grid'
}

/**
 * frontmatter `battle_command_labels` を解釈する。`attack=斬る, spell=魔石` のように `id=表示名` をカンマ
 * （`,` / `，`）区切りで並べる。id は attack / skill / spell / item / escape。未知の id・空の表示名・`=` のない項目は無視する。
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

/**
 * frontmatter `battle_commands` を解釈する (#873)。`skill, spell, item, escape` のように id をカンマ（`,` / `，`）区切りで
 * 並べる（順序＝配置順。大小無視）。未知の id・空の項目は無視し、同じ id は最初のものだけ残す。
 * 有効な id が 1 つも無ければ undefined（既定の attack / spell / item / escape のまま）。
 */
export function parseCommandIds(raw: string | null | undefined): CommandId[] | undefined {
  if (typeof raw !== 'string') return undefined
  const out: CommandId[] = []
  for (const part of raw.split(/[,，]/)) {
    const id = part.trim().toLowerCase()
    if (!COMMAND_IDS.has(id) || out.includes(id as CommandId)) continue
    out.push(id as CommandId)
  }
  return out.length > 0 ? out : undefined
}

/** コマンドの並び（`ids` 未指定・空は既定の 4 つ）に表示名の上書きを当てる。省略・空文字の id は既定のまま */
export function resolveCommandSpecs(
  labels?: CommandLabels | null,
  ids?: readonly CommandId[] | null
): Array<{ id: CommandId; label: string }> {
  const order: readonly CommandId[] =
    ids && ids.length > 0 ? ids : COMMAND_DEFAULTS.map((c) => c.id)
  return order.map((id) => {
    const o = labels?.[id]
    return { id, label: typeof o === 'string' && o.trim() !== '' ? o : COMMAND_DEFAULT_LABELS[id] }
  })
}

/**
 * `cross` の矢印キー（KeyboardEvent.key）→ コマンド id。並びの位置で決まる（0 番目=↑・1 番目=←・2 番目=→・3 番目=↓）。
 * `ids` 未指定は既定の並び。矢印以外・並びに無い位置は undefined
 */
export function crossKeyToCommandId(
  key: string,
  ids?: readonly CommandId[] | null
): CommandId | undefined {
  const order: readonly CommandId[] =
    ids && ids.length > 0 ? ids : COMMAND_DEFAULTS.map((c) => c.id)
  switch (key) {
    case 'ArrowUp':
      return order[0]
    case 'ArrowLeft':
      return order[1]
    case 'ArrowRight':
      return order[2]
    case 'ArrowDown':
      return order[3]
    default:
      return undefined
  }
}
