/**
 * 窓の題名 (#1226)。窓の上辺の線を左寄りで切り、その切れ目に題名の文字を載せる（FF の窓の題名と同じ見た目）。
 * 窓の rect・行の rect は変えない（線を切って文字を載せるだけ）。戦闘専用ではなく、どの窓でも使える汎用の部品。
 */
import { estimateTextWidth } from './battleLayout'

/** 窓の角丸の半径 (px)。BattleScreen のパネルと題名の切れ目の計算で共有 */
export const PANEL_CORNER_RADIUS = 6
/** 題名の左端を、窓の左端から離す距離 (px)。角丸の半径より大きくして、切れ目が角にかからないようにする */
export const WINDOW_TITLE_LEFT = 16
/** 題名の文字の左右に空ける線の切れ目の余白 (px) */
export const WINDOW_TITLE_PAD = 6
/** 題名の文字の大きさ。一覧の行と同じ大きさにそろえる */
export const WINDOW_TITLE_FONT_SIZE = 12

/** 上辺の線の切れ目（画面の x 座標。`x0` から `x1` まで線を描かない） */
export interface PanelGap {
  x0: number
  x1: number
}

export interface WindowTitlePlacement {
  /** 文字の左端 x */
  textX: number
  /** 文字の中心 y（窓の上辺の線の上） */
  centerY: number
  /** 文字の幅（描く側が計測できたときはそちらを渡す） */
  textW: number
  /** 切れ目。窓が狭くて文字が入らないときは null（題名を出さない） */
  gap: PanelGap | null
}

/**
 * 題名の置き場所。文字は窓の上辺の線の上に縦中央でのせ、切れ目は文字の幅 + 左右の余白。
 * 右端の角（`radius`）にかかる幅しか取れないときは null＝出さない（題名で窓を壊さない）。
 * `textW` を省くと文字の幅は概算（`estimateTextWidth`）。
 */
export function placeWindowTitle(
  rect: { x: number; y: number; w: number },
  text: string,
  radius: number = PANEL_CORNER_RADIUS,
  textW: number = estimateTextWidth(text, WINDOW_TITLE_FONT_SIZE)
): WindowTitlePlacement | null {
  if (text === '' || !Number.isFinite(textW) || textW <= 0) return null
  const x0 = rect.x + WINDOW_TITLE_LEFT - WINDOW_TITLE_PAD
  const x1 = rect.x + WINDOW_TITLE_LEFT + textW + WINDOW_TITLE_PAD
  // 右の角の手前までしか切らない
  if (x1 > rect.x + rect.w - radius) return null
  return { textX: rect.x + WINDOW_TITLE_LEFT, centerY: rect.y, textW, gap: { x0, x1 } }
}
