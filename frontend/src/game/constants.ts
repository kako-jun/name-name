/**
 * ゲーム画面の基本サイズと画面比率定数
 *
 * Issue #136: 画面比率指定（16:9 / 4:3 / 9:16 縦 Shorts 用）
 *
 * - デフォルトは 16:9 (800×450)
 * - 論理解像度（PixiJS Canvas のサイズ）は ASPECT_RATIOS で管理
 * - CSS 側は NovelPlayer / RPGPlayer が aspect-ratio CSS で追従する
 */

/** サポートする画面比率の識別子 */
export type AspectRatio = '16:9' | '4:3' | '9:16'

/** 各比率の論理解像度（px）。16:9 / 4:3 は幅 800px 基準、9:16 は高さ 800px 基準 */
export const ASPECT_RATIOS: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 800, height: 450 },
  '4:3': { width: 800, height: 600 },
  '9:16': { width: 450, height: 800 },
}

/** デフォルトの画面比率 */
export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9'

/** デフォルトのゲーム画面幅 (後方互換用) */
export const GAME_WIDTH = ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].width
/** デフォルトのゲーム画面高さ (後方互換用) */
export const GAME_HEIGHT = ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].height

/**
 * 文字列を AspectRatio に変換する。未知の値はデフォルトにフォールバック。
 */
export function parseAspectRatio(s: string | undefined | null): AspectRatio {
  if (s === '16:9' || s === '4:3' || s === '9:16') return s
  return DEFAULT_ASPECT_RATIO
}

/**
 * frontmatter `aspect_ratio: auto`（#442）かどうかを判定する述語。
 *
 * true のとき、NovelPlayer は固定比率にロックせず、実ビューポート（コンテナ）の向きに応じて
 * `pickFluidAspectRatio` で '16:9' / '9:16' のどちらかを都度選び直す fluid モードを使う。
 * 既存の 3 値（16:9/4:3/9:16）を明示指定した作品は対象外（このモードには入らず従来どおり）。
 */
export function isAutoAspectRatio(s: string | undefined | null): boolean {
  return s === 'auto'
}

/**
 * 実ビューポート（コンテナ）の実測サイズから、fluid モード（`aspect_ratio: auto`）で使う
 * 離散 AspectRatio を選ぶ純粋関数 (#442)。
 *
 * `viewportWidth >= viewportHeight`（横長 **or ちょうど正方形**）→ '16:9'。
 * `viewportWidth < viewportHeight`（縦長）→ '9:16'。
 *
 * 正方形は横長側へ倒す。`novelLayout.ts` の `computeSplitLayoutRegions`（split_layout の
 * 画像/テキスト領域分割）も同じ `>=` 規約（正方形は横長側）を使う。ここで選んだ AspectRatio が
 * そのままキャンバスの論理解像度（`ASPECT_RATIOS[...]`）になり、`computeSplitLayoutRegions` は
 * その screenWidth/screenHeight を見て左右/上下を判定するため、2 つの関数の境界規約がズレると
 * 「キャンバスの実形」と「split_layout の領域分割」が矛盾する。どちらかを変える場合は
 * 必ずもう一方も揃えること（コード上は独立実装・意図的な軽い重複）。
 */
export function pickFluidAspectRatio(viewportWidth: number, viewportHeight: number): AspectRatio {
  return viewportWidth >= viewportHeight ? '16:9' : '9:16'
}
