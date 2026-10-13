/**
 * ウィンドウ配色テーマ (#744)。
 *
 * 戦闘画面のパネル（ログ・コマンド・ステータス）の配色を frontmatter `window_style:` で切り替える。
 * `dark` は従来どおりの半透明黒（既定・後方互換）、`ff-blue` は FF6 風の青い**帯状**グラデーション
 * （上=明るい青 → 下=濃い紺。滑らかでなく段差のある横縞）に白文字＋黒い影を付ける。
 *
 * テーマは**色だけ**を持つ。寸法（パネルの大きさ・枠線の太さ）はテーマに持たせない。
 * このモジュールは純粋関数だけを持つ（this / PixiJS に触れない）。描画は BattleScreen 側が行う。
 * 見た目は実機でライブ調整するので、調整対象の定数はここに集める。
 */

export type WindowStyle = 'dark' | 'ff-blue'

/** frontmatter `window_style` の値を正規化する。`'ff-blue'` 以外（未指定・空・未知値含む）は `'dark'` */
export function normalizeWindowStyle(raw: string | null | undefined): WindowStyle {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'ff-blue' ? 'ff-blue' : 'dark'
}

/** ff-blue の帯の数（上から下へ段差を付けて塗り分ける横縞の本数） */
export const FF_BLUE_BAND_COUNT = 9
/** ff-blue グラデーションの上端の色（明るい青） */
export const FF_BLUE_TOP_COLOR = 0x4a5ad8
/** ff-blue グラデーションの下端の色（濃い紺） */
export const FF_BLUE_BOTTOM_COLOR = 0x000a50
/** ff-blue パネルの不透明度（帯が背景に透けすぎないよう、dark よりやや高め） */
export const FF_BLUE_PANEL_ALPHA = 0.95
/**
 * ff-blue の文字の影（黒）。距離は px、alpha は 0〜1。
 * distance は影のオフセットというサイズ値だが、文字の装飾でありパネル寸法には影響しないためテーマ側に置いて許容する。
 */
export const FF_BLUE_TEXT_SHADOW = {
  color: 0x000000,
  alpha: 1,
  blur: 0,
  distance: 2,
  angle: Math.PI / 4,
}

export interface Band {
  /** パネル上端からのオフセット(px) */
  y: number
  /** 帯の高さ(px) */
  h: number
  /** 帯の色（0xRRGGBB） */
  color: number
}

/** 2 色を t(0〜1) で線形補間する（チャンネルごとに丸める）。範囲外（±Infinity 含む）はクランプ、NaN は 0（= a） */
export function lerpColor(a: number, b: number, t: number): number {
  if (Number.isNaN(t)) t = 0
  t = Math.min(1, Math.max(0, t))
  const ch = (shift: number) => {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff
    return Math.round(ca + (cb - ca) * t) & 0xff
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * 高さ `height` のパネルを `bandCount` 本の横縞に分け、上=top → 下=bottom の色を段階的に割り当てて返す。
 * 帯の境界は整数 px に丸め、隙間・重なりが出ないよう最後の帯は下端まで埋める。
 * `height` は整数 px 前提（小数は切り捨てる）。
 * `height <= 0` または `bandCount < 1` は空配列。高さより帯数が多いときは帯数を高さまで減らす（高さ 0 の帯を作らない）。
 */
export function computeBands(
  height: number,
  bandCount: number = FF_BLUE_BAND_COUNT,
  top: number = FF_BLUE_TOP_COLOR,
  bottom: number = FF_BLUE_BOTTOM_COLOR
): Band[] {
  if (!Number.isFinite(height) || !Number.isFinite(bandCount)) return []
  const h = Math.floor(height)
  if (h <= 0 || bandCount < 1) return []
  const n = Math.min(Math.floor(bandCount), h)
  const bands: Band[] = []
  for (let i = 0; i < n; i++) {
    const y0 = Math.round((h * i) / n)
    const y1 = i === n - 1 ? h : Math.round((h * (i + 1)) / n)
    const t = n === 1 ? 0 : i / (n - 1)
    bands.push({ y: y0, h: y1 - y0, color: lerpColor(top, bottom, t) })
  }
  return bands
}
