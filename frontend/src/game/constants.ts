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

/** 各比率の論理解像度（px）。幅基準は 800px で統一 */
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
