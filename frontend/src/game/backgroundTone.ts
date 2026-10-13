/**
 * 戦闘背景のトーン調整 (#753)。
 *
 * 背景スプライトにだけ、表示時のフィルタとして彩度・明度を落とし、キャラ/敵を浮き上がらせる。
 * 画像ファイルは編集しない。frontmatter `battle_background_tone: on|off`（既定 on）で無効化できる。
 *
 * このモジュールは純粋関数と定数だけを持つ（PixiJS に触れない）。フィルタの生成・破棄は BattleScreen 側。
 * 見た目は実機でライブ調整するので、調整対象の係数はここ一箇所に集める。
 */

export type BackgroundTone = 'on' | 'off'

/** 背景の彩度の倍率（1 = 元のまま、0 = 無彩色）。目視で調整する値 */
export const BACKGROUND_TONE_SATURATION = 0.6
/** 背景の明度の倍率（1 = 元のまま、0 = 真っ黒）。目視で調整する値 */
export const BACKGROUND_TONE_BRIGHTNESS = 0.75

/** frontmatter `battle_background_tone` の値を正規化する。`'off'` 以外（未指定・空・未知値含む）は `'on'` */
export function normalizeBackgroundTone(raw: string | null | undefined): BackgroundTone {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'off' ? 'off' : 'on'
}

/**
 * 彩度の倍率を PixiJS ColorMatrixFilter.saturate の amount に変換する。
 * Pixi の amount は 0 = 変化なし・-1 = 無彩色（倍率 s に対して amount = s - 1）。倍率は 0〜1 にクランプ、NaN は 1（変化なし）
 */
export function saturationToPixiAmount(multiplier: number): number {
  if (Number.isNaN(multiplier)) return 0
  return Math.min(1, Math.max(0, multiplier)) - 1
}
