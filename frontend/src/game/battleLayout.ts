/**
 * RPG 戦闘画面のレイアウト計算 (#736)。純粋関数のみ（this / PixiJS に触れない）。
 *
 * `BattleScreen` の `layout: 'side'`（FF 系サイドビュー）で使う座標を、画面サイズ・味方数・敵数から返す。
 *
 *   +------------------------------------------+
 *   | [ログ帯: 直近 logLines 行（敵の数で可変）]  |  ← log
 *   |                                          |
 *   |  [敵]                  [味方]             |  ← enemies（左・2 行以上なら千鳥）/ party（右・左上→右下の斜め一列 #760）
 *   |  名前/HP                                  |  ← 敵だけ各スプライトの下にラベル（SpriteSlot.label）
 *   |     [敵]                  [味方]          |
 *   |                                          |
 *   +-----------+------------------------------+
 *   | たたかう じゅもん | ゆうしゃ HP 20/20 MP 4/4 |  ← command（2x2）/ status（味方全員分）
 *   | どうぐ   にげる   | ...                      |
 *   +-----------+------------------------------+
 *
 * `front`（既定・Undertale 風正面配置）は従来どおり `BattleScreen` 側の固定レイアウトで、ここは使わない。
 */

import type { BattleRow } from './spellDsl'
import type { CommandLayout } from './battleCommands'
import { computeAcrylicGeometry, resolveAcrylicParams, type AcrylicParams } from './spriteStyle'
import {
  applyDepthToGridSlots,
  clampEnemyWindowOverlap,
  computeEnemyGridLayout,
  emptyEnemyGridSlot,
  type EnemyFootprint,
  type EnemyGridSize,
  type EnemyGridSlot,
} from './enemyGrid'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** スプライト 1 体ぶんの配置枠。`x,y` は左上、`size` は正方形の一辺 */
export interface SpriteSlot {
  x: number
  y: number
  size: number
  /** 枠の幅。敵は `size`（正方形）、味方 (#760) は縦長で `size * 縦横比`（`size` は高さ） */
  width: number
  /** 敵のみ: 名前 + HP ラベルの矩形（スプライトの直下・画面絶対座標）。味方・潰れて置けない枠・幅が狭く文字が読めない枠では undefined */
  label?: Rect
  /**
   * 床に接する基準 y（スプライトの足元 `y + size`。ラベルの予約領域は含めない）。奥行き (#747) の縮尺と描画順（奥→手前）の基準。
   * 奥行きオフでも常に返す（値が大きいほど手前）
   */
  floor: number
  /** 奥行き (#747) の縮尺（`size` は縮尺後の値。奥行きオフ・最前列は 1） */
  scale: number
}

/**
 * 戦闘画面の浅い擬似 3D (#747)。地平線と床の面から、行ごとの縮尺と y を求める。
 * `perspective` が 0 のとき（または指定なし）は平面（現行どおり）。
 */
export interface BattleDepth {
  /** 地平線の高さ（画面高さに対する比 0〜1。0 = 画面の上端） */
  horizon: number
  /** 遠近の強さ（0 = 平面 〜 1 = 地平線の幾何どおり） */
  perspective: number
}

export interface SideBattleLayoutInput {
  width: number
  height: number
  partyCount: number
  enemyCount: number
  /** コマンドボタンの数（既定 4: たたかう/じゅもん/どうぐ/にげる） */
  commandCount?: number
  /**
   * コマンド窓の配置 (#204)。`grid`（既定・2 列グリッド）/ `cross`（十字: 上・左・右・下）。
   * `cross` はコマンドが 4 つのときだけ有効（それ以外は `grid`）
   */
  commandLayout?: CommandLayout
  /** 味方ごとの隊列 (#747)。味方の index 順。未指定・足りない分は前衛。`back` は右（敵から遠い側）へ半歩下げる */
  partyRows?: readonly (BattleRow | undefined)[]
  /** 敵ごとの立ち絵の縦横比（幅/高さ・#760）。未指定・足りない分は正方形（1） */
  enemyAspects?: readonly (number | undefined)[]
  /** 奥行き (#747)。未指定・perspective が 0 以下は平面（現行どおり） */
  depth?: BattleDepth | null
  /**
   * 敵がアクスタ (#737) のときの板のパラメータ (#838)。渡すと、板（余白＋線ぶん枠の外へ広がる）を含めた見た目の矩形で
   * 列ピッチ（隣の板と重ならない）と窓との重なり（許容量以下）を求める。未指定・null は素材そのまま（板なし）
   */
  enemyAcrylic?: AcrylicParams | null
  /**
   * 敵の絵の上端がメッセージ窓（ログ帯）の下へ入ってよい量 (#838)。各敵の枠の高さ（`size`）に対する比。
   * 0〜0.5 に丸め、未指定・不正は `SIDE_ENEMY_WINDOW_OVERLAP`（0.25）。窓は敵の手前に描かれるので、許容量までは隠れてよい（仕様）
   */
  enemyWindowOverlap?: number
  /**
   * 敵の見えないグリッド (#839 段4)。渡すと敵を従来の `computeFormation` でなくグリッド（`computeEnemyGridLayout`）に置く。
   * 未指定は従来の配置のまま（`enemyFootprints` / #838 の窓フィットも従来どおり）。
   * このとき `enemyAspects` / `enemyAcrylic` の窓フィットは使わず、窓との重なりは `enemyWindowOverlap`（窓の高さまでに絞る）で扱う
   */
  enemyGrid?: EnemyGridSize
  /**
   * グリッド時の敵ごとの占有（`placeEnemies` の結果 + サイズ区分 + 倍率）。敵の index 順。
   * null・足りない分は置けなかった敵＝大きさ 0 のスロット（後段が描かない）
   */
  enemyFootprints?: readonly (EnemyFootprint | null | undefined)[]
}

export interface SideBattleLayout {
  /** 画面上部のログ帯 */
  log: Rect
  /** ログ帯に出す行数（敵の数で可変・SIDE_LOG_MIN_LINES〜SIDE_LOG_MAX_LINES） */
  logLines: number
  /** 敵・味方スプライトを置くステージ領域（ログ帯と下パネルの間） */
  stage: Rect
  /** 敵スプライト枠（敵の並び順 = state.enemies の index 順） */
  enemies: SpriteSlot[]
  /** 味方スプライト枠（味方の並び順 = state.party の index 順） */
  party: SpriteSlot[]
  /** 下パネル左: コマンド全体 */
  command: Rect
  /** コマンドの各セル（`grid`: 2 列グリッド / `cross`: 上・左・右・下の順 = コマンドの並びの順） */
  commandCells: Rect[]
  /** 下パネル右: 味方 HP/MP パネル全体 */
  status: Rect
  /** 味方 1 人ぶんの行（party の index 順） */
  statusRows: Rect[]
  /** status 幅が狭く MP 表記を省く必要があるか */
  statusCompact: boolean
  /** 奥行きが有効か (#747)。有効なら敵・味方を `SpriteSlot.floor` の昇順（奥→手前）で描く */
  depthActive: boolean
}

export const SIDE_PADDING = 16
export const SIDE_GAP = 6
/** ログ帯の行数の下限・上限 */
export const SIDE_LOG_MIN_LINES = 2
export const SIDE_LOG_MAX_LINES = 4
/** ステージ（スプライト領域）の最小高さ。ログ行数はこれを優先して減らす（下限 SIDE_LOG_MIN_LINES） */
export const SIDE_MIN_STAGE_HEIGHT = 120
export const SIDE_LOG_LINE_HEIGHT = 20
export const SIDE_LOG_VERTICAL_PADDING = 16
/** コマンドセル 1 つの高さ */
export const SIDE_COMMAND_CELL_HEIGHT = 40
const SIDE_COMMAND_COLUMNS = 2
const SIDE_COMMAND_MIN_WIDTH = 144
const SIDE_COMMAND_MAX_WIDTH = 240
const SIDE_COMMAND_WIDTH_RATIO = 0.4
/** `cross` はコマンドがちょうどこの数のときだけ有効（上・左・右・下に 1 つずつ） */
const SIDE_COMMAND_CROSS_COUNT = 4
/** `cross` のセルの段数（上 / 左右 / 下） */
const SIDE_COMMAND_CROSS_ROWS = 3
/** `cross` の 1 段の最小高さ（ステージが潰れる小さい画面でだけ 1 段を縮める） */
export const SIDE_COMMAND_CROSS_MIN_CELL_HEIGHT = 28
/** 味方 1 人ぶんの status 行の標準高さ */
export const SIDE_STATUS_ROW_HEIGHT = 26
const SIDE_STATUS_VERTICAL_PADDING = 12
/** status 幅がこれ未満なら MP を省略（compact） */
export const SIDE_STATUS_COMPACT_WIDTH = 260
/** スプライト 1 体の最大一辺 */
export const SIDE_MAX_SPRITE_SIZE = 160
/** 同じ側の体数がこれを超えたら最低 2 列に並べる */
const SIDE_MAX_ROWS_PER_COLUMN = 3
/** 敵ラベル（名前 + HP の 2 行）の行高さ・行数・高さ・スプライトとの隙間 */
export const SIDE_LABEL_LINE_HEIGHT = 15
export const SIDE_LABEL_LINES = 2
export const SIDE_LABEL_HEIGHT = SIDE_LABEL_LINE_HEIGHT * SIDE_LABEL_LINES
export const SIDE_LABEL_GAP = 2
/** 縦長の stage で敵を下寄せにするとき、領域の上端を下げてよい上限（stage の高さに対する比）(#760) */
export const SIDE_PORTRAIT_ENEMY_MAX_DROP = 0.4
/** 敵の絵が窓（ログ帯）の下へ入ってよい量の既定 (#838)。敵の枠の高さに対する比。窓と多少かぶるほうが大きく立体感が出る（kako-jun 方針） */
export const SIDE_ENEMY_WINDOW_OVERLAP = 0.25
/** 窓への重なり許容量の上限 (#838)。顔が半分以上隠れる設定を作らせない */
export const SIDE_ENEMY_WINDOW_OVERLAP_MAX = 0.5
/** 敵の立ち絵の縦横比の丸め範囲 (#760) */
export const SIDE_ENEMY_ASPECT_MIN = 0.2
export const SIDE_ENEMY_ASPECT_MAX = 3
/** 敵 1 体の高さの上限 (#760)。味方より大きく見せるため従来の `SIDE_MAX_SPRITE_SIZE` より大きい */
export const SIDE_ENEMY_MAX_SIZE = 480
/** フォールバック四角（画像が無いとき）の枠内比率 */
const FALLBACK_X = 0.15
const FALLBACK_Y = 0.1
const FALLBACK_W = 0.7
const FALLBACK_H = 0.8
/** 千鳥（奥行きのずらし）の水平ずれ。スプライト一辺に対する比 */
export const SIDE_STAGGER_RATIO = 0.25
/** 後衛 (#747) を右（敵から遠い側）へ下げる水平ずれ。スプライト一辺に対する比（半歩） */
export const SIDE_BACK_ROW_SHIFT_RATIO = 0.5
/** 味方の斜め一列 (#760): 斜めのずらし量（1 人ぶんの x 送り）の下限・上限。スプライト一辺に対する比 */
export const SIDE_DIAGONAL_MIN_SHIFT_RATIO = 0.3
export const SIDE_DIAGONAL_MAX_SHIFT_RATIO = 0.75
/** 味方の斜め一列 (#760): 行間隔（y 送り）の下限・上限。立ち絵の高さに対する比。下限 0.3 = 上の人の顔（上 30%）が隠れない */
export const SIDE_PARTY_MIN_PITCH_RATIO = 0.3
export const SIDE_PARTY_MAX_PITCH_RATIO = 0.6
/** 敵へ領域を回すとき、味方の斜めのずらしをここまで詰める（高さに対する比。上限 0.75・下限 0.3 の間） */
export const SIDE_PARTY_COMFORT_SHIFT_RATIO = 0.5
/** 味方の立ち絵の高さの上限 */
export const SIDE_PARTY_MAX_HEIGHT = 320
/** 立ち絵の縦横比（幅/高さ）の既定（未読み込み・色四角）と丸め範囲 */
export const SIDE_DEFAULT_SPRITE_ASPECT = 0.5
/**
 * 側面戦闘の味方の枠に使う固定の基準縦横比 (#813)。人数・メンバー・各自の縦横比によらず枠の位置と大きさを
 * 同じにするための値。sit-by-me の基本ポーズ(ready)の縦横比 0.68〜1.00（中央値 約 0.86）を踏まえ、
 * 広すぎて立ち絵が小さくならない 0.8 とした。これより横長の絵は枠に収めて少し縮む
 */
export const SIDE_PARTY_FRAME_ASPECT = 0.8
export const SIDE_PARTY_ASPECT_MIN = 0.2
export const SIDE_PARTY_ASPECT_MAX = 1.5
/** 二分法の反復回数（列ピッチ・窓との重なり）と、収まり判定の許容誤差（列ピッチは px の浮動小数誤差、窓は 0.01px） */
const COLUMN_FIT_ITERATIONS = 32
const COLUMN_FIT_EPS = 1e-9
const WINDOW_FIT_ITERATIONS = 24
const WINDOW_FIT_EPS = 0.01

/** 敵の窓への重なり許容量 (#838) を 0〜`SIDE_ENEMY_WINDOW_OVERLAP_MAX` に丸める。未指定・非有限は既定 */
export function normalizeEnemyWindowOverlap(raw: number | undefined | null): number {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return SIDE_ENEMY_WINDOW_OVERLAP
  return Math.min(SIDE_ENEMY_WINDOW_OVERLAP_MAX, Math.max(0, raw))
}

/**
 * 敵の絵（アクスタの板を含む）の上端が窓の下端 `windowBottom` より上へはみ出す量のうち、許容量
 * （各敵の枠の高さ × `overlap`。窓の高さまで）を超える分の最大値 (#838)。0 以下なら全員が許容量以内
 */
export function measureWindowOver(
  slots: readonly SpriteSlot[],
  aspects: readonly (number | undefined)[] | undefined,
  params: AcrylicParams,
  window: Pick<Rect, 'y' | 'h'>,
  overlap: number
): number {
  const windowBottom = window.y + window.h
  let worst = 0
  slots.forEach((slot, i) => {
    if (!(slot.size > 0)) return
    const plate = computeEnemyPlateRect(slot, aspects?.[i], params)
    // 窓の上端より上（画面の外）へは出さない: 許容量は窓の高さまで
    worst = Math.max(worst, windowBottom - plate.y - Math.min(overlap * slot.size, window.h))
  })
  return worst
}

/** 奥行き (#747) の縮尺の下限（地平線に近い・地平線より上でも潰れない） */
export const DEPTH_MIN_SCALE = 0.3
/** `battle_perspective` だけ指定されたときの地平線の高さ（画面比）の既定 */
export const DEPTH_DEFAULT_HORIZON = 0.3

/** ログ帯の高さ */
export function computeSideLogHeight(lines: number = SIDE_LOG_MIN_LINES): number {
  return lines * SIDE_LOG_LINE_HEIGHT + SIDE_LOG_VERTICAL_PADDING
}

/**
 * 敵の数から欲しいログ行数を返す。1 ターンのログは「自分のこうげき（2 行）＋生きている敵 1 体あたり 2 行」
 * なので、敵が多いほど直近の自分の結果が流れて消えないよう行数を増やす（1 体=2 / 2 体=3 / 3 体以上=4）。
 */
export function desiredSideLogLines(enemyCount: number): number {
  const n = Math.max(0, Math.floor(enemyCount))
  return Math.min(SIDE_LOG_MAX_LINES, Math.max(SIDE_LOG_MIN_LINES, n + 1))
}

/** フォールバック四角（スプライト枠 `size` の左上を原点とした相対矩形） */
export function computeFallbackRect(size: number): Rect {
  return { x: size * FALLBACK_X, y: size * FALLBACK_Y, w: size * FALLBACK_W, h: size * FALLBACK_H }
}

/**
 * 敵がアクスタ (#737) のとき、画面に実際に描かれる板（スプライトの輪郭を余白＋線ぶん外へ広げた矩形）の範囲 (#838)。
 * `BattleScreen.placeEntityView` / `placeAcrylic` の配置を純粋関数で写したもの:
 * 正方形の箱（一辺 `max(size, width)`・下端を枠の下端に揃え・水平は枠の中央）の中に `computeAcrylicGeometry` で絵を置き、
 * 板は絵の長辺の `marginRatio + lineWidthRatio` 倍だけ外へ広がる（`acrylicPlate.computePlateLayout` の spread）。
 * 箱の中に予約された余白（px で頭打ち）より板の広がり（長辺比）が大きいぶんは、箱の外へはみ出す。
 * `aspect`: 立ち絵の縦横比（幅/高さ。丸め前の実際の比）。画像が無い（色四角）ときは板がないので `slot` の枠をそのまま返す。
 * 下端は枠の下端（板は台座に差し込まれ、枠の下へは出ない）。
 */
export function computeEnemyPlateRect(
  slot: Pick<SpriteSlot, 'x' | 'y' | 'size' | 'width'>,
  aspect: number | undefined,
  params: AcrylicParams
): Rect {
  const frame: Rect = { x: slot.x, y: slot.y, w: slot.width, h: slot.size }
  if (aspect === undefined || !(aspect > 0) || !Number.isFinite(aspect)) return frame
  if (!(slot.size > 0) || !(slot.width > 0)) return frame
  const p = resolveAcrylicParams(params)
  const box = Math.max(slot.size, slot.width)
  const baseX = slot.x - (box - slot.width) / 2
  const baseY = slot.y + slot.size - box
  const g = computeAcrylicGeometry(aspect, 1, box, p)
  const spread = (p.marginRatio + p.lineWidthRatio) * Math.max(g.sprite.width, g.sprite.height)
  const x = baseX + g.sprite.x - spread
  const y = baseY + g.sprite.y - spread
  const w = g.sprite.width + spread * 2
  return { x, y, w, h: Math.max(0, slot.y + slot.size - y) }
}

const ACRYLIC_BOX_FIT_ITERATIONS = 32

/**
 * 敵グリッド (#839 段4) のアクスタ用の箱の一辺を求める。`computeAcrylicGeometry` は正方形の箱が前提なので、
 * 占有領域 `frame`（幅 × 高さ）の足元中央に置く正方形のうち、次をすべて `frame` の内側に収める最大の一辺を返す。
 * (1) 板（絵を余白＋線ぶん外へ広げた矩形 = `computeEnemyPlateRect`）の左右と上端、(2) 台座・影の楕円の横幅（中心は `frame` の中央）。
 * 箱の下端は `frame` の下端に揃える。2x1 のような横長の占有では箱が高さ（短辺）を超えて幅いっぱいまで広がり、絵が占有領域を使い切る
 * （サイズ区分の大きさ差が画面に出る）。上限は `max(w, h)`。判定は一辺に対して単調に厳しくなるので二分法で求める。
 * `aspect` が無い（色四角）・不正なら板がないので `min(w, h)`。`frame` が潰れていれば 0。
 */
export function computeAcrylicBoxSize(
  frame: Pick<Rect, 'w' | 'h'>,
  aspect: number | undefined,
  params: AcrylicParams
): number {
  const lower = Math.min(frame.w, frame.h)
  if (!(lower > 0) || !Number.isFinite(lower)) return 0
  if (aspect === undefined || !(aspect > 0) || !Number.isFinite(aspect)) return lower
  const upper = Math.max(frame.w, frame.h)
  const p = resolveAcrylicParams(params)
  const fits = (size: number): boolean => {
    const slot = { x: (frame.w - size) / 2, y: frame.h - size, size, width: size }
    const plate = computeEnemyPlateRect(slot, aspect, p)
    if (!(plate.x >= -1e-6 && plate.x + plate.w <= frame.w + 1e-6 && plate.y >= -1e-6)) return false
    const g = computeAcrylicGeometry(aspect, 1, size, p)
    for (const e of [g.base, g.shadow]) if (e && 2 * e.rx > frame.w + 1e-6) return false
    return true
  }
  if (fits(upper)) return upper
  let lo = 0
  let hi = upper
  for (let i = 0; i < ACRYLIC_BOX_FIT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

const ELLIPSIS = '…'
/** 1 文字の描画幅の概算（全角=fontPx、半角=0.6*fontPx） */
function charWidth(ch: string, fontPx: number): number {
  return ch.charCodeAt(0) > 0xff ? fontPx : fontPx * 0.6
}
export function estimateTextWidth(text: string, fontPx: number): number {
  let w = 0
  for (const ch of text) w += charWidth(ch, fontPx)
  return w
}

/** 敵ラベルのフォントサイズと縁取りの太さ（BattleScreen の見た目と、読める幅の導出で共有） */
export const SIDE_LABEL_FONT_SIZE = 12
export const SIDE_LABEL_STROKE_WIDTH = 3
/** 1 列配置のラベル幅の上限（スプライト一辺に対する倍率。領域幅でも頭打ち） */
export const SIDE_LABEL_MAX_WIDTH_RATIO = 3
/**
 * ラベル矩形の幅がこれ未満だと、縁取りを引いた文字幅が HP 数値（「12/12」）の概算幅に届かず
 * 名前も HP も「…」程度しか入らない。その幅のラベルは置かない（スプライトは残す）。
 */
export const SIDE_LABEL_MIN_WIDTH = Math.ceil(
  estimateTextWidth('12/12', SIDE_LABEL_FONT_SIZE) + SIDE_LABEL_STROKE_WIDTH * 2
)
/** ラベルの幅が読める文字を入れられるか（純粋関数。入らない幅ならラベルごと省く） */
export function isLabelWidthReadable(labelWidth: number): boolean {
  return labelWidth >= SIDE_LABEL_MIN_WIDTH
}

/**
 * 敵ラベルの HP 行（「HP 12/12」）が省略されず読める、スプライト一辺の最小値。
 * 決め打ちでなく、HP 行の概算幅 + 縁取り両側分から導出する（約 64px）。
 * 列数はスプライトがこれに届く最小の列数を選ぶ。
 */
export const SIDE_READABLE_SPRITE_SIZE = Math.ceil(
  estimateTextWidth('HP 12/12', SIDE_LABEL_FONT_SIZE) + SIDE_LABEL_STROKE_WIDTH * 2
)

/**
 * `maxWidthPx` に収まるよう末尾を「…」で省略する（幅は概算）。収まるならそのまま。
 * 「…」すら入らないときは空文字。
 */
export function fitLabel(text: string, maxWidthPx: number, fontPx: number): string {
  if (estimateTextWidth(text, fontPx) <= maxWidthPx) return text
  const ell = charWidth(ELLIPSIS, fontPx)
  if (maxWidthPx < ell) return ''
  let out = ''
  let w = ell
  for (const ch of text) {
    const cw = charWidth(ch, fontPx)
    if (w + cw > maxWidthPx) break
    out += ch
    w += cw
  }
  return out + ELLIPSIS
}

/**
 * HP 行を `maxWidthPx` に収める。「HP 12/12」が入らなければ「HP 」を落として「12/12」を残し、
 * それでも入らないときだけ「…」で省略する（数値を優先して見せる）。
 */
export function fitHpLabel(hp: number, maxHp: number, maxWidthPx: number, fontPx: number): string {
  const nums = `${hp}/${maxHp}`
  const full = `HP ${nums}`
  if (estimateTextWidth(full, fontPx) <= maxWidthPx) return full
  return fitLabel(nums, maxWidthPx, fontPx)
}

/** コマンドセルの文字の左右余白（パネルの 2px 枠に触れないぶんを含む） */
export const SIDE_COMMAND_TEXT_PADDING = 8

/**
 * セル幅 `cellWidth` に、左右 `padding` を残して `texts` のどれも収まる最大のフォントサイズ（整数 px）を返す。
 * `maxFont` を上限とし、1 未満にはならない。幅は `estimateTextWidth` の概算。
 */
export function fitCommandFontSize(
  cellWidth: number,
  texts: string[],
  maxFont: number,
  padding: number
): number {
  const room = cellWidth - padding * 2
  let font = Math.floor(maxFont)
  while (font > 1 && texts.some((t) => estimateTextWidth(t, font) > room)) font--
  return Math.max(1, font)
}

/** 味方の斜め一列の最低枠数 (#813)。パーティがこれより少なくても、この枠数ぶんの位置・大きさで配置する */
export const SIDE_PARTY_MIN_SLOTS = 4

/**
 * 味方 (#760): FF6 式に左上から右下へ斜め一列に並べる純粋関数。`party[0]` が左上・以降 y は単調増加
 * （ステータス欄の行順と一致）。縮尺は掛けない。立ち絵は縦長なので枠を縦長（幅 = 高さ × 縦横比）にし、
 * 味方どうしは**上下に重ねてよい**（下の人ほど手前＝後から描く）。
 *
 * - `aspects[i]`: 枠の幅/高さ（`computeSideBattleLayout` は誰がいても固定の `SIDE_PARTY_FRAME_ASPECT` を渡す #813。
 *   単体で使うときは立ち絵の縦横比。未読み込み・不正は `SIDE_DEFAULT_SPRITE_ASPECT`=0.5、
 *   `SIDE_PARTY_ASPECT_MIN`〜`MAX` に丸める）。`slot.size` は高さ、`slot.width` は幅
 * - 高さ h = min(SIDE_PARTY_MAX_HEIGHT, 領域高さ / (1 + (人数-1) * 行間隔下限比 0.3),
 *   領域幅 / (最大幅比 * (1 + 後衛予約) + (人数-1) * ずらし下限比 0.3))
 * - 行間隔 pitch = min((領域高さ - h) / (人数-1), 0.6 * h)。下限 0.3h なので上の人の顔（上 30%）は下の人に隠れない
 * - 斜めのずらし dx = clamp((領域幅 - 最大幅 * (1 + 後衛予約)) / (人数-1), 0.3h, 0.75h)
 * - 後衛 (#747): 斜めの位置から右へ**その人の幅**の `SIDE_BACK_ROW_SHIFT_RATIO`(0.5) 倍。後衛が 1 人でもいれば
 *   最大幅の 0.5 倍ぶんの右余白を全員で予約するので領域から出ない
 * - 配置全体は領域内で水平・垂直とも中央寄せ
 */
export function computePartyDiagonal(
  region: Rect,
  count: number,
  rows?: readonly (BattleRow | undefined)[],
  aspects?: readonly (number | undefined)[],
  opts?: { height?: number }
): SpriteSlot[] {
  if (count <= 0) return []
  const regionW = Math.max(0, region.w)
  const regionH = Math.max(0, region.h)
  const aspect = (i: number): number => {
    const a = aspects?.[i]
    if (a === undefined || !Number.isFinite(a) || a <= 0) return SIDE_DEFAULT_SPRITE_ASPECT
    return Math.min(SIDE_PARTY_ASPECT_MAX, Math.max(SIDE_PARTY_ASPECT_MIN, a))
  }
  let maxAspect = 0
  for (let i = 0; i < count; i++) maxAspect = Math.max(maxAspect, aspect(i))
  const anyBack = !!rows && rows.slice(0, count).some((r) => r === 'back')
  const backShift = anyBack ? SIDE_BACK_ROW_SHIFT_RATIO : 0
  const steps = count - 1
  // `opts.height`: 高さを固定する（別の領域で決めた大きさを、狭めた領域でもそのまま使う。領域に収まる前提）
  const h =
    opts?.height !== undefined && Number.isFinite(opts.height)
      ? Math.max(0, opts.height)
      : Math.max(
          0,
          Math.min(
            SIDE_PARTY_MAX_HEIGHT,
            regionH / (1 + steps * SIDE_PARTY_MIN_PITCH_RATIO),
            regionW / (maxAspect * (1 + backShift) + steps * SIDE_DIAGONAL_MIN_SHIFT_RATIO)
          )
        )
  const pitch = steps > 0 ? Math.min((regionH - h) / steps, h * SIDE_PARTY_MAX_PITCH_RATIO) : 0
  const maxW = h * maxAspect
  const dx =
    steps > 0 && h > 0
      ? Math.min(
          SIDE_DIAGONAL_MAX_SHIFT_RATIO,
          Math.max(SIDE_DIAGONAL_MIN_SHIFT_RATIO, (regionW - maxW * (1 + backShift)) / steps / h)
        ) * h
      : 0
  const totalH = h + steps * pitch
  const originY = region.y + (regionH - totalH) / 2
  const slots: SpriteSlot[] = []
  for (let i = 0; i < count; i++) {
    const width = h * aspect(i)
    const back = rows?.[i] === 'back' ? width * SIDE_BACK_ROW_SHIFT_RATIO : 0
    const y = originY + i * pitch
    slots.push({ x: i * dx + back, y, size: h, width, floor: y + h, scale: 1 })
  }
  // 水平は、実際の左右端（各 slot の x と x + width の最小・最大）で領域の中央に寄せる。
  // 「最大幅 × 予約」で取ると、縦横比の大きい人が先頭のとき右側に空きが残って左へずれる (#760)。高さ・間隔は変えない
  // 左端は後衛のずらしを除いた斜めの位置（後衛 1 人でも「斜めの位置から右へ半歩」が保たれる）、右端は後衛のずらしを含める
  const left = Math.min(
    ...slots.map((sl, i) =>
      rows?.[i] === 'back' ? sl.x - sl.width * SIDE_BACK_ROW_SHIFT_RATIO : sl.x
    )
  )
  const right = Math.max(...slots.map((sl) => sl.x + sl.width))
  const shift = region.x + (regionW - (right - left)) / 2 - left
  for (const sl of slots) sl.x += shift
  return slots
}

/**
 * 敵側（`side: 'party'` は `computePartyDiagonal` へ委譲）の複数体を、領域内に千鳥で並べた枠を返す。
 *
 * - 列数は「3 体まで 1 列・4 体以上は 2 列」を下限に、スプライトが `SIDE_READABLE_SPRITE_SIZE` に届く
 *   **最小の列数**を採る（列優先で埋める）。どの列数でも届かないときだけ最大サイズになる列数（同率は少ない方）
 * - 一辺は「領域幅」「領域高さ」「SIDE_MAX_SPRITE_SIZE」の最小。領域が潰れていても 0 以上
 * - 2 行以上のとき奇数行を `SIDE_STAGGER_RATIO * size` だけずらして奥行きを出す。
 *   ずらす向きは「敵は右（味方側）へ・味方は左（敵側）へ」で、向かい合う陣形になる
 * - 配置全体は領域内で水平・垂直とも中央寄せ
 * - `withLabel`（敵側）: 各行の高さを `size + SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT` にして、スプライトの直下に
 *   ラベル矩形（`slot.label`）を返す。ラベルを入れるとスプライトが 0 に潰れるほど低い領域では、
 *   ラベルだけを省いてスプライトを残す（`slot.label` なし）
 * - 味方（`rows`）は `computePartyDiagonal` が扱う
 */
/** 敵の配置の調整 (#760)。省略は従来どおり（上限 `SIDE_MAX_SPRITE_SIZE`・読める大きさだけを目安に列数を選ぶ） */
export interface FormationOptions {
  /** 一辺（高さ）の上限。既定 `SIDE_MAX_SPRITE_SIZE` */
  maxSize?: number
  /** この高さ以上に届く最小の列数を選ぶ（どの列数でも届かなければ最大になる列数）。味方の立ち絵の高さを渡す */
  minSize?: number
  /**
   * 敵がアクスタ (#737) のときの板のパラメータ (#838)。渡すと列ピッチ（1 体ぶんの横幅）を、枠の幅でなく
   * 板（余白＋線ぶん外へ広がる）を含めた幅にして、同じ行の隣の板と重ならないようにする。省略は従来どおり（枠の幅）
   */
  plateParams?: AcrylicParams | null
}

export function computeFormation(
  region: Rect,
  count: number,
  side: 'enemy' | 'party',
  withLabel = false,
  rows?: readonly (BattleRow | undefined)[],
  aspects?: readonly (number | undefined)[],
  opts?: FormationOptions
): SpriteSlot[] {
  if (count <= 0) return []
  if (side === 'party') return computePartyDiagonal(region, count, rows, aspects)
  const regionW = Math.max(0, region.w)
  const regionH = Math.max(0, region.h)
  // 敵側だけ各行にラベル（隙間 + 名前/HP の 2 行）ぶんを予約する
  let extra = withLabel ? SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT : 0
  // 敵 (#760): 立ち絵の縦横比（幅/高さ）。size は高さ、枠の幅は size × 縦横比。全員が収まる列幅は最大の縦横比で決める。
  // 縦横比が不明（未指定）の敵は正方形（1）
  const enemyAspect = (i: number): number => {
    const a = aspects?.[i]
    return a !== undefined && Number.isFinite(a) && a > 0
      ? Math.min(SIDE_ENEMY_ASPECT_MAX, Math.max(SIDE_ENEMY_ASPECT_MIN, a))
      : 1
  }
  let maxAspect = 0
  for (let i = 0; i < count; i++) maxAspect = Math.max(maxAspect, enemyAspect(i))
  const maxSize = opts?.maxSize ?? SIDE_MAX_SPRITE_SIZE
  const wantSize = Math.max(SIDE_READABLE_SPRITE_SIZE, opts?.minSize ?? 0)
  // 1 体ぶんの横幅（列ピッチ）。既定は枠の幅（size × 最大の縦横比）。アクスタのときは、各敵の板（枠の幅より広がりうる）も入る幅 (#838)
  const plateParams = opts?.plateParams ?? null
  const cellWidthAt = (size: number): number => {
    let w = size * maxAspect
    if (!plateParams || !(size > 0)) return w
    for (let i = 0; i < count; i++) {
      const raw = aspects?.[i]
      if (raw === undefined || !Number.isFinite(raw) || raw <= 0) continue
      const frame = { x: 0, y: 0, size, width: size * enemyAspect(i) }
      w = Math.max(w, computeEnemyPlateRect(frame, raw, plateParams).w)
    }
    return w
  }
  const sizeFor = (columns: number): number => {
    const rowCount = Math.ceil(count / columns)
    const stagger = rowCount > 1 ? SIDE_STAGGER_RATIO : 0
    const byHeight = Math.min(regionH / rowCount - extra, maxSize)
    const plain = Math.max(0, Math.min(regionW / ((columns + stagger) * maxAspect), byHeight))
    if (!plateParams) return plain
    // 板を含めた幅は size に対して単調に増える。枠の幅だけで決めた大きさで板も収まるなら従来どおり（見た目を変えない）。
    // 収まらないときだけ、横に収まる最大の size を二分法で求める
    const fits = (size: number): boolean =>
      (columns + stagger) * cellWidthAt(size) <= regionW + COLUMN_FIT_EPS
    if (!(plain > 0) || fits(plain)) return plain
    let lo = 0
    let hi = plain
    for (let i = 0; i < COLUMN_FIT_ITERATIONS; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
    }
    return lo
  }
  const baseColumns = count > SIDE_MAX_ROWS_PER_COLUMN ? 2 : 1
  const pick = (): { columns: number; size: number } => {
    let best = { columns: baseColumns, size: sizeFor(baseColumns) }
    for (let c = baseColumns; c <= count; c++) {
      const size = sizeFor(c)
      if (size >= wantSize) return { columns: c, size }
      if (size > best.size) best = { columns: c, size }
    }
    return best
  }
  let { columns, size } = pick()
  // ラベルを入れると潰れてしまう低い領域では、ラベルだけ省いてスプライトを残す
  const labelDropped = withLabel && size <= 0
  if (labelDropped) {
    extra = 0
    ;({ columns, size } = pick())
  }
  const rowCount = Math.ceil(count / columns)
  const stagger = rowCount > 1 ? SIDE_STAGGER_RATIO : 0
  const cellW = cellWidthAt(size)
  const colPitch = cellW
  const totalW = colPitch * columns + cellW * stagger
  const totalH = (size + extra) * rowCount
  const originX = region.x + (regionW - totalW) / 2
  const originY = region.y + (regionH - totalH) / 2
  const slots: SpriteSlot[] = []
  for (let i = 0; i < count; i++) {
    const col = Math.floor(i / rowCount)
    const row = i % rowCount
    const odd = row % 2 === 1
    // 敵: 奇数行を右へ（味方側へ）ずらして千鳥にする
    const dx = stagger > 0 && odd ? cellW * stagger : 0
    const width = size * enemyAspect(i)
    // 列幅（cellW）の中で水平中央に置く
    const x = originX + col * colPitch + dx + (cellW - width) / 2
    const y = originY + row * (size + extra)
    const slot: SpriteSlot = { x, y, size, width, floor: y + size, scale: 1 }
    if (withLabel && !labelDropped && size > 0) {
      // 1 列は横に何も並ばないので領域幅（上限あり）まで広げ、多列は隣の列と重ならない列ピッチ(=size)まで
      const w = columns === 1 ? Math.min(regionW, cellW * SIDE_LABEL_MAX_WIDTH_RATIO) : cellW
      const lx =
        columns === 1
          ? Math.min(Math.max(x + width / 2 - w / 2, region.x), region.x + regionW - w)
          : x - (cellW - width) / 2
      // 名前も HP も読めない狭さ（「…」だけになる幅）ならラベルごと省く
      if (isLabelWidthReadable(w)) {
        slot.label = { x: lx, y: y + size + SIDE_LABEL_GAP, w, h: SIDE_LABEL_HEIGHT }
      }
    }
    slots.push(slot)
  }
  return slots
}

/**
 * 奥行き (#747): 床の基準 y（`floor`）から縮尺を求める純粋関数。
 *
 *   幾何の縮尺 = (floor - 地平線y) / (最前列の floor - 地平線y)   … 地平線から遠い（手前）ほど大きい
 *   縮尺 = 1 - perspective * (1 - 幾何の縮尺)                       … perspective 0 で平面、1 で幾何どおり
 *
 * 範囲は `DEPTH_MIN_SCALE`〜1。地平線が最前列より下（幾何が成り立たない）なら 1。入力のどれかが非有限なら 1。
 */
export function computeDepthScale(
  floor: number,
  frontFloor: number,
  horizonY: number,
  perspective: number
): number {
  // 非有限の入力（NaN / Infinity）は平面（1）に倒し、NaN を座標へ伝播させない
  if (![floor, frontFloor, horizonY, perspective].every(Number.isFinite)) return 1
  const p = Math.min(1, Math.max(0, perspective))
  const span = frontFloor - horizonY
  if (!(span > 0) || p <= 0) return 1
  const geo = Math.min(1, Math.max(DEPTH_MIN_SCALE, (floor - horizonY) / span))
  return Math.min(1, Math.max(DEPTH_MIN_SCALE, 1 - p * (1 - geo)))
}

/**
 * 奥行き (#747) をスロット群に適用する。各スロットを縮尺 `s` で、**元の予約領域の上端・水平中央を保って**縮める。
 * 縮んだ枠は元の予約領域（スプライト＋ラベル）の内側に収まるので、画面内・非重複・非負の不変条件は元のまま保たれる。
 * 上端を保つので、縮んだ枠の足元は元より上＝奥の行ほど地平線側へ上がる。敵ラベルは縮んだ足元の直下で、
 * 幅も縮尺に追従する（読めない幅になればラベルごと省く）。`floor` は元の値のまま（描画順の基準）。
 */
export function applyDepthToSlots(
  slots: readonly SpriteSlot[],
  frontFloor: number,
  horizonY: number,
  perspective: number
): SpriteSlot[] {
  return slots.map((slot) => {
    const s = computeDepthScale(slot.floor, frontFloor, horizonY, perspective)
    if (s >= 1) return slot
    const size = slot.size * s
    const width = slot.width * s
    const out: SpriteSlot = {
      x: slot.x + (slot.width - width) / 2,
      y: slot.y,
      size,
      width,
      floor: slot.floor,
      scale: s,
    }
    if (slot.label) {
      const w = slot.label.w * s
      if (isLabelWidthReadable(w)) {
        out.label = {
          x: slot.label.x + (slot.label.w - w) / 2,
          y: slot.y + size + SIDE_LABEL_GAP,
          w,
          h: slot.label.h,
        }
      }
    }
    return out
  })
}

/**
 * 味方の斜め一列 (#760) が実際に必要とする水平幅。右半分（幅 `halfWidth`）で求めた配置 `slots`（大きさはそれで決まる）から、
 * 斜めのずらしを高さの `SIDE_PARTY_COMFORT_SHIFT_RATIO` 倍まで詰めた幅を返す（半分を超えない）。
 * 幅は `computePartyDiagonal` の幅の式と同じ量（最大幅 × (1 + 後衛予約) + (人数 − 1) × ずらし）から求めるので、
 * この幅の領域へ高さ固定（`opts.height`）で配置し直しても、右半分での配置と大きさ・ずらしが一致する。
 * 味方の大きさは変えず、右半分の残りを敵へ回すために使う。味方 0 人は 0。`anyBack`: 後衛が 1 人でもいるか。
 */
export function partyRegionWidth(
  slots: readonly SpriteSlot[],
  halfWidth: number,
  anyBack = false
): number {
  if (slots.length === 0) return 0
  const h = slots[0].size
  const maxW = Math.max(...slots.map((s) => s.width))
  const steps = slots.length - 1
  const base = maxW * (1 + (anyBack ? SIDE_BACK_ROW_SHIFT_RATIO : 0))
  if (steps === 0 || !(h > 0)) return Math.min(halfWidth, base)
  // 右半分での斜めのずらし（computePartyDiagonal の dx と同じ式）
  const dxHalf =
    Math.min(
      SIDE_DIAGONAL_MAX_SHIFT_RATIO,
      Math.max(SIDE_DIAGONAL_MIN_SHIFT_RATIO, (halfWidth - base) / steps / h)
    ) * h
  const wanted = base + steps * Math.min(dxHalf, h * SIDE_PARTY_COMFORT_SHIFT_RATIO)
  return Math.min(halfWidth, Math.max(0, wanted))
}

/** 実際に使うコマンド窓の配置。`cross` はコマンドが 4 つのときだけ有効で、他は `grid` */
export function effectiveCommandLayout(
  layout: CommandLayout | undefined,
  commandCount: number
): CommandLayout {
  return layout === 'cross' && commandCount === SIDE_COMMAND_CROSS_COUNT ? 'cross' : 'grid'
}

/** コマンド窓の段数。`grid` は 2 列で折り返した行数、`cross` は 3 段（上 / 左右 / 下） */
export function commandRowCount(layout: CommandLayout, commandCount: number): number {
  return layout === 'cross'
    ? SIDE_COMMAND_CROSS_ROWS
    : Math.ceil(commandCount / SIDE_COMMAND_COLUMNS)
}

/**
 * コマンド窓 `command` の中のセル座標 (#204)。`commandCount` 個を `command` からはみ出さず重ならないように並べる。
 *
 * - `grid`: 2 列で左上から右下へ（0 1 / 2 3）
 * - `cross`（4 つのみ）: 幅の半分のセルを、上=0（中央）/ 左=1 / 右=2 / 下=3（中央）に置く。
 *   上・下は窓の幅の中央（左右の 1/4 ずつ空く）、左・右は窓の左半分・右半分。段は 3 等分。
 *   セルの幅は `grid` と同じなので、ラベルのフォントサイズは `grid` と同じ計算で収まる
 */
export function computeCommandCells(
  command: Rect,
  commandCount: number,
  layout: CommandLayout = 'grid'
): Rect[] {
  const count = Math.max(0, Math.floor(commandCount))
  const kind = effectiveCommandLayout(layout, count)
  const rows = commandRowCount(kind, count)
  const cellW = command.w / SIDE_COMMAND_COLUMNS
  const cellH = rows > 0 ? command.h / rows : 0
  const cells: Rect[] = []
  if (kind === 'cross') {
    const at = (col: number, row: number): Rect => ({
      x: command.x + col * cellW,
      y: command.y + row * cellH,
      w: cellW,
      h: cellH,
    })
    // 上・左・右・下（col は半セル単位: 0.5 = 中央）
    return [at(0.5, 0), at(0, 1), at(1, 1), at(0.5, 2)]
  }
  for (let i = 0; i < count; i++) {
    cells.push({
      x: command.x + (i % SIDE_COMMAND_COLUMNS) * cellW,
      y: command.y + Math.floor(i / SIDE_COMMAND_COLUMNS) * cellH,
      w: cellW,
      h: cellH,
    })
  }
  return cells
}

/**
 * サイドビュー戦闘画面の全座標を算出する。
 *
 * 下パネルの高さは「コマンド 2x2 の高さ」と「status 行（最低 4 行ぶん）」の大きい方。
 * 味方が 5 人以上になると下パネルが伸び、ステージ領域が縮む（高さが足りなくても負にならない）。
 */
export function computeSideBattleLayout(input: SideBattleLayoutInput): SideBattleLayout {
  const W = input.width
  const H = input.height
  const partyCount = Math.max(0, Math.floor(input.partyCount))
  const enemyCount = Math.max(0, Math.floor(input.enemyCount))
  const commandCount = Math.max(0, Math.floor(input.commandCount ?? 4))
  // #813: 味方が 1 人でもいれば、人数によらず最低 4 枠ぶんの位置・大きさ・下パネル高さで配置する（FF6 同様）。
  // 味方 0 人は何も置かない。5 人以上なら従来どおり人数ぶん
  const slotCount = partyCount > 0 ? Math.max(SIDE_PARTY_MIN_SLOTS, partyCount) : 0
  const depth = input.depth && input.depth.perspective > 0 ? input.depth : null
  const innerW = Math.max(0, W - SIDE_PADDING * 2)

  // 下: コマンド（左）+ status（右）
  const commandLayout = effectiveCommandLayout(input.commandLayout, commandCount)
  const commandRows = commandRowCount(commandLayout, commandCount)
  let commandCellH = SIDE_COMMAND_CELL_HEIGHT
  if (commandLayout === 'cross') {
    // cross は 3 段で窓が高くなるので、ログ最小行でもステージが最小高さを割る画面では 1 段を縮める（下限あり）。
    // grid はもともと 2 段で、ログ行数の削減だけで足りるので縮めない
    const maxBottom =
      H -
      SIDE_PADDING * 2 -
      SIDE_GAP * 2 -
      computeSideLogHeight(SIDE_LOG_MIN_LINES) -
      SIDE_MIN_STAGE_HEIGHT
    commandCellH = Math.min(
      SIDE_COMMAND_CELL_HEIGHT,
      Math.max(SIDE_COMMAND_CROSS_MIN_CELL_HEIGHT, maxBottom / commandRows)
    )
  }
  const commandNeeded = commandRows * commandCellH
  const statusNeeded = slotCount * SIDE_STATUS_ROW_HEIGHT + SIDE_STATUS_VERTICAL_PADDING
  const bottomH = Math.max(commandNeeded, statusNeeded)
  const bottomY = H - SIDE_PADDING - bottomH
  const commandW = Math.min(
    Math.max(W * SIDE_COMMAND_WIDTH_RATIO, SIDE_COMMAND_MIN_WIDTH),
    SIDE_COMMAND_MAX_WIDTH,
    innerW
  )
  const command: Rect = { x: SIDE_PADDING, y: bottomY, w: commandW, h: bottomH }
  const statusX = SIDE_PADDING + commandW + SIDE_GAP
  const status: Rect = {
    x: statusX,
    y: bottomY,
    w: Math.max(0, W - SIDE_PADDING - statusX),
    h: bottomH,
  }

  const commandCells = computeCommandCells(command, commandCount, commandLayout)

  const rowH =
    slotCount > 0
      ? Math.min(SIDE_STATUS_ROW_HEIGHT, (bottomH - SIDE_STATUS_VERTICAL_PADDING) / slotCount)
      : 0
  const statusRows: Rect[] = []
  for (let i = 0; i < partyCount; i++) {
    statusRows.push({
      x: status.x,
      y: status.y + SIDE_STATUS_VERTICAL_PADDING / 2 + i * rowH,
      w: status.w,
      h: rowH,
    })
  }

  // 上: ログ帯。行数は敵の数で決め、ステージが潰れるときは最小高さを優先して減らす
  const stageBottom = bottomY - SIDE_GAP
  // グリッド有効時 (#839 段4) は希望行数をグリッド容量（cols*rows）で決める。体数で行数が変わると stage 高さ→cell が
  // 体数で変わり、設計書 §3.8「体数不変」に反するため。グリッドなしは従来どおり敵の数で決める
  let logLines = desiredSideLogLines(
    input.enemyGrid ? input.enemyGrid.cols * input.enemyGrid.rows : enemyCount
  )
  while (
    logLines > SIDE_LOG_MIN_LINES &&
    stageBottom - (SIDE_PADDING + computeSideLogHeight(logLines) + SIDE_GAP) < SIDE_MIN_STAGE_HEIGHT
  ) {
    logLines--
  }
  const log: Rect = {
    x: SIDE_PADDING,
    y: SIDE_PADDING,
    w: innerW,
    h: computeSideLogHeight(logLines),
  }

  // 中: ステージ（左半分=敵 / 右半分=味方）
  const stageY = log.y + log.h + SIDE_GAP
  const stage: Rect = {
    x: SIDE_PADDING,
    y: stageY,
    w: innerW,
    h: Math.max(0, stageBottom - stageY),
  }
  // 味方 (#760): 大きさは従来どおり右半分を使うものとして決め、その斜め一列に必要な幅だけ右端に取る。残りはすべて敵へ回す
  const half = stage.w / 2
  const partyHalf: Rect = { x: stage.x + half, y: stage.y, w: half, h: stage.h }
  // #813: 4 人のときの斜め一列の枠で求め、味方は上の枠から順に入れる。空き枠は何も描かない（最後に切り捨てる）
  // 枠の縦横比は固定の基準縦横比。空き枠の隊列は前衛。誰がいるか・各自の縦横比で枠が変わらないように
  const partyRows = input.partyRows?.slice(0, partyCount)
  // 枠の幾何は固定の基準縦横比で求める（誰がいるか・各自の縦横比に依らない）
  const partyAspects: number[] = Array(slotCount).fill(SIDE_PARTY_FRAME_ASPECT)
  const halfSlots = computeFormation(partyHalf, slotCount, 'party', false, partyRows, partyAspects)
  const anyBack =
    !!input.partyRows && input.partyRows.slice(0, partyCount).some((r) => r === 'back')
  const partyW = partyRegionWidth(halfSlots, partyHalf.w, anyBack)
  const partyRegion: Rect = { x: stage.x + stage.w - partyW, y: stage.y, w: partyW, h: stage.h }
  const enemyRegion: Rect = { x: stage.x, y: stage.y, w: stage.w - partyW, h: stage.h }
  // 縦長の stage (#760): 敵のかたまりを下寄せにし、1 人目（左上）の頭・板とぶつかりにくくする。
  // 領域の下端は固定したまま上端を下げ、領域の縦中心を味方 party[1]〜party[2] の足元の中ほどに合わせる
  // （上端の下げ幅は stage 高さの `SIDE_PORTRAIT_ENEMY_MAX_DROP` 倍まで）。横長はそのまま
  if (stage.h > stage.w && halfSlots.length > 0) {
    const footA = halfSlots[Math.min(1, halfSlots.length - 1)].floor
    const footB = halfSlots[Math.min(2, halfSlots.length - 1)].floor
    const bottom = stage.y + stage.h
    const top = Math.min(
      Math.max(stage.y, ((footA + footB) / 2) * 2 - bottom),
      stage.y + stage.h * SIDE_PORTRAIT_ENEMY_MAX_DROP
    )
    enemyRegion.y = top
    enemyRegion.h = Math.max(0, bottom - top)
  }
  const partyHeight = halfSlots[0]?.size ?? 0

  const enemyPlate = input.enemyAcrylic ?? null
  // グリッド時 (#839 段4): 奥行きの縮尺の基準（グリッド最下行の下端。体数・空きに依らない）
  let gridFrontFloor: number | null = null
  let gridOverlap = 0
  const formEnemies = (region: Rect): SpriteSlot[] =>
    computeFormation(region, enemyCount, 'enemy', true, undefined, input.enemyAspects, {
      maxSize: SIDE_ENEMY_MAX_SIZE,
      minSize: partyHeight,
      plateParams: enemyPlate,
    })
  let enemies: SpriteSlot[]
  if (input.enemyGrid) {
    // 窓との重なり許容量は、延長ぶん（overlap * cell）が窓の高さを超えない範囲に絞る（cell が overlap に依るので閉形式で解く）
    const overlap = clampEnemyWindowOverlap(
      enemyRegion,
      input.enemyGrid,
      true,
      input.enemyWindowOverlap,
      log.h
    )
    gridOverlap = overlap
    const placedIdx: number[] = []
    const footprints: EnemyFootprint[] = []
    for (let i = 0; i < enemyCount; i++) {
      const fp = input.enemyFootprints?.[i]
      if (fp) {
        placedIdx.push(i)
        footprints.push(fp)
      }
    }
    const gl = computeEnemyGridLayout(enemyRegion, input.enemyGrid, footprints, {
      withLabel: true,
      windowOverlap: overlap,
    })
    const band = gl.cell > 0 ? SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT : 0
    gridFrontFloor = gl.grid.y + gl.grid.h - band
    const slots: EnemyGridSlot[] = Array.from({ length: enemyCount }, () =>
      emptyEnemyGridSlot(gl.grid.x, gridFrontFloor as number)
    )
    placedIdx.forEach((enemyIndex, k) => {
      slots[enemyIndex] = gl.slots[k]
    })
    enemies = slots
  } else {
    enemies = formEnemies(enemyRegion)
  }
  // 窓との重なり (#838): 敵の絵（アクスタの板を含む）の上端がログ帯の下へ入ってよいのは、各敵の枠の高さの
  // `enemyWindowOverlap`（既定 0.25）まで。超えるときだけ領域の上端を下げて収める（許容量以内なら何も変えない）。
  // 窓は敵の手前（上）に描かれるので、許容量までは隠れてよい（立体感）。領域の中で内容は中央寄せなので、上端を下げる
  if (!input.enemyGrid && enemyPlate && enemies.length > 0) {
    const overlap = normalizeEnemyWindowOverlap(input.enemyWindowOverlap)
    const overAt = (drop: number): { over: number; slots: SpriteSlot[] } => {
      const region: Rect = { ...enemyRegion, y: enemyRegion.y + drop, h: enemyRegion.h - drop }
      const slots = formEnemies(region)
      return { over: measureWindowOver(slots, input.enemyAspects, enemyPlate, log, overlap), slots }
    }
    if (overAt(0).over > WINDOW_FIT_EPS) {
      // 上端を下げるほど絵は下がる（または小さくなる）ので、はみ出しは単調に減る。収まる最小の下げ幅を二分法で求める
      let lo = 0
      let hi = enemyRegion.h
      for (let iter = 0; iter < WINDOW_FIT_ITERATIONS; iter++) {
        const mid = (lo + hi) / 2
        if (overAt(mid).over <= WINDOW_FIT_EPS) hi = mid
        else lo = mid
      }
      enemies = overAt(hi).slots
      enemyRegion.y += hi
      enemyRegion.h -= hi
    }
  }
  // 大きさは右半分で決めたもの（halfSlots[0].size）に固定する。狭めた領域で計算し直すと幅の制約で縮むため
  let party = computePartyDiagonal(partyRegion, slotCount, partyRows, partyAspects, {
    height: partyHeight,
  })
  if (depth) {
    // 奥行き (#747): 敵・味方で共通の地平線と、最前列（最も手前の floor）を基準に縮尺を求める
    // 空き枠も最前列の基準に含める（人数で縮尺が変わらないように）
    const all = [...enemies, ...party]
    if (all.length > 0 || gridFrontFloor !== null) {
      const frontFloor = Math.max(
        ...all.map((sl) => sl.floor),
        ...(gridFrontFloor !== null ? [gridFrontFloor] : [])
      )
      const horizonY = H * Math.min(1, Math.max(0, depth.horizon))
      enemies = input.enemyGrid
        ? applyDepthToGridSlots(
            enemies as EnemyGridSlot[],
            frontFloor,
            horizonY,
            depth.perspective,
            {
              bottom: log.y + log.h,
              overlap: gridOverlap,
            }
          )
        : applyDepthToSlots(enemies, frontFloor, horizonY, depth.perspective)
      party = applyDepthToSlots(party, frontFloor, horizonY, depth.perspective)
    }
  }
  // 空き枠（#813）は返さない。位置・大きさ・奥行きの縮尺は 4 枠ぶんで確定済み
  party = party.slice(0, partyCount)

  return {
    log,
    logLines,
    stage,
    enemies,
    party,
    command,
    commandCells,
    status,
    statusRows,
    statusCompact: status.w < SIDE_STATUS_COMPACT_WIDTH,
    depthActive: depth !== null,
  }
}

/**
 * テクスチャを長方形の枠 `boxW x boxH` に収める（contain・縦横比維持・中央寄せ）。#760 の縦長の味方枠用。
 * 寸法が不正（0 以下）なら枠いっぱい。
 */
export function computeContainFitRect(
  textureWidth: number,
  textureHeight: number,
  boxW: number,
  boxH: number
): { x: number; y: number; width: number; height: number } {
  if (!(textureWidth > 0) || !(textureHeight > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { x: 0, y: 0, width: Math.max(0, boxW), height: Math.max(0, boxH) }
  }
  const scale = Math.min(boxW / textureWidth, boxH / textureHeight)
  const width = textureWidth * scale
  const height = textureHeight * scale
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height }
}

/** frontmatter `battle_layout` の値を正規化する。`'side'` 以外（未指定・未知値含む）は `'front'` */
export type BattleLayoutMode = 'front' | 'side'
export function normalizeBattleLayout(raw: string | null | undefined): BattleLayoutMode {
  return raw?.trim().toLowerCase() === 'side' ? 'side' : 'front'
}

/**
 * frontmatter `battle_horizon` / `battle_perspective` を奥行き設定に正規化する (#747)。
 * `battle_perspective` が数値でない・0 以下・未指定なら null（平面＝現行どおり）。0〜1 に丸める。
 * `battle_horizon` が数値でない・未指定なら `DEPTH_DEFAULT_HORIZON`、0〜1 に丸める。
 */
export function normalizeBattleDepth(
  horizonRaw: string | null | undefined,
  perspectiveRaw: string | null | undefined
): BattleDepth | null {
  const num = (raw: string | null | undefined): number | null => {
    if (raw === null || raw === undefined || raw.trim() === '') return null
    const v = Number(raw.trim())
    return Number.isFinite(v) ? v : null
  }
  const perspective = num(perspectiveRaw)
  if (perspective === null || perspective <= 0) return null
  const horizon = num(horizonRaw)
  return {
    horizon: Math.min(1, Math.max(0, horizon ?? DEPTH_DEFAULT_HORIZON)),
    perspective: Math.min(1, perspective),
  }
}

/** パーティ定義の隊列 (#747) を正規化する。`back` / `後衛` / `後列`（大小無視）だけ後衛、それ以外（未指定含む）は前衛 */
export function normalizeBattleRow(raw: string | null | undefined): BattleRow {
  const v = raw?.trim().toLowerCase()
  return v === 'back' || v === '後衛' || v === '後列' ? 'back' : 'front'
}

// ---- status 欄の列 (#745) ----

/** status 行の文字サイズ */
export const SIDE_STATUS_FONT_SIZE = 14
/** status 行の左右余白（テキスト開始位置と、右端に残す余白） */
export const SIDE_STATUS_TEXT_PADDING = 12
/** 番の印 ▶（名前の左）の文字サイズ。幅は estimateTextWidth と同じ見積りで測る (#805) */
export const SIDE_STATUS_MARKER_FONT_SIZE = 7
/** ▶ の右端と名前の文字の間 */
export const SIDE_STATUS_MARKER_NAME_GAP = 3
/**
 * ATB のときの、名前の左の余白（▶ を置く場所）。基本は MIN だけ足し（どの幅でも枠から ▶ まで 4px 以上）、
 * 名前列に余裕がある幅では最小名前幅を割らない範囲で MAX まで広げる（枠から ▶ まで最大 8px。`computeStatusColumns` が余裕から決める）(#805)
 */
export const SIDE_STATUS_MARKER_GUTTER_MIN = 2
export const SIDE_STATUS_MARKER_GUTTER_MAX = 6
/** status 欄の左端から名前の文字の開始までの基本の余白（余裕で広がる前）。ATB のときは ▶ ぶんの最小を足す */
export function sideStatusLeftPadding(atb: boolean): number {
  return SIDE_STATUS_TEXT_PADDING + (atb ? SIDE_STATUS_MARKER_GUTTER_MIN : 0)
}
/** front 配置の名前（HP/MP の 1 行）が最低限使う幅の目安。これを超える余裕があれば ▶ の余白を広げる */
export const FRONT_STATS_TEXT_BUDGET = 260
/**
 * front 配置（HP/MP パネル）の、パネル左端から名前の文字の開始までの余白。ATB のとき基本は MIN だけ足し、
 * 1 行の文字に余裕がある幅（`innerWidth` = パネル幅 − 左右の文字余白）では MAX まで広げる（side と同じ考え方）(#805)
 */
export function frontStatsLeftPadding(innerWidth: number, atb: boolean): number {
  const base = sideStatusLeftPadding(atb)
  if (!atb) return base
  const slack = innerWidth - FRONT_STATS_TEXT_BUDGET
  const extra = Math.max(
    0,
    Math.min(SIDE_STATUS_MARKER_GUTTER_MAX - SIDE_STATUS_MARKER_GUTTER_MIN, slack)
  )
  return base + extra
}
/** ▶ の左端 x。名前列の x の手前に、▶ の幅（estimateTextWidth）と名前との間隔ぶん空ける */
export function sideStatusMarkerX(nameX: number): number {
  return nameX - SIDE_STATUS_MARKER_NAME_GAP - estimateTextWidth('▶', SIDE_STATUS_MARKER_FONT_SIZE)
}

/**
 * 「選択中」の印（アクスタ頭上の白い下向き三角 ▼）(#805)。大きさ・頭からの間隔は枠の一辺（unit）に対する比で、
 * 画面のスケールに追従する。FF6 ピクセルリマスターの 1080p 換算で、頭から約 10〜15px 離した小さな三角
 */
export const SELECT_MARK_WIDTH_RATIO = 0.1
export const SELECT_MARK_HEIGHT_RATIO = 0.07
export const SELECT_MARK_GAP_RATIO = 0.06
/** 小さな画面でも見えるよう、三角の幅・高さ・頭からの間隔の下限（px）。大きい画面は unit に比例 */
export const SELECT_MARK_MIN_WIDTH = 10
export const SELECT_MARK_MIN_HEIGHT = 8
export const SELECT_MARK_MIN_GAP = 4
/** 三角の上端と、上のログ窓の下端との最低の隙間（px）。窓にかかる分は三角を下げる */
export const SELECT_MARK_LOG_GAP = 2
/** ▼ の頂点（左上・右上・下の尖り）。`cx` は絵の中央 x、`headTop` は絵（板があれば板）の上端 y、`minTop` は三角の上端の下限 y（同じ座標系。上のログ窓の下端＋SELECT_MARK_LOG_GAP） */
export function computeSelectMarkTriangle(
  cx: number,
  headTop: number,
  unit: number,
  minTop = -Infinity
): number[] {
  const w = Math.max(SELECT_MARK_MIN_WIDTH, unit * SELECT_MARK_WIDTH_RATIO)
  const h = Math.max(SELECT_MARK_MIN_HEIGHT, unit * SELECT_MARK_HEIGHT_RATIO)
  // 上端が minTop（上のログ窓の下端＋隙間）より上にならないよう、必要なら下げる（大きさとログ窓との隙間は保ち、頭とは重なってよい）
  const tipY = Math.max(
    headTop - Math.max(SELECT_MARK_MIN_GAP, unit * SELECT_MARK_GAP_RATIO),
    minTop + h
  )
  return [cx - w / 2, tipY - h, cx + w / 2, tipY - h, cx, tipY]
}

/** 列と列の間 */
export const SIDE_STATUS_COLUMN_GAP = 8
/** 名前列に最低限確保する全角文字数。これに届かないときは MP → 見出し → HP の最大値 → ゲージ幅の順に削る */
export const SIDE_STATUS_MIN_NAME_CHARS = 3
/** ATB ゲージ（行の右端に置く短い棒）の幅。半角 4 文字ぶん */
export const SIDE_STATUS_GAUGE_WIDTH = Math.round(estimateTextWidth('0000', SIDE_STATUS_FONT_SIZE))
/** ATB ゲージの高さ */
export const SIDE_STATUS_GAUGE_HEIGHT = 3

export interface StatusColumn {
  /** 列の左端（画面絶対） */
  x: number
  w: number
}

/**
 * HP / MP の列。内部は「見出し | 現在値 | /最大値」の 3 つに分かれ、見出しは `x` に左寄せ、
 * 現在値は `curRight`（「/」の直前）に右寄せ、「/最大値」は `curRight` から左寄せで続ける（列の右端は `x + w`）。
 * 現在値の桁数が行ごとに違っても、見出しと「/」の x が全員そろう（FF5/6 と同じ）。
 * 最大値を省く段階（`showMaxHp` が false）では現在値が `x + w` に右寄せされる。
 */
export interface StatusValueColumn extends StatusColumn {
  /** 現在値テキストの右端（右寄せの基準 x） */
  curRight: number
}

export interface StatusColumns {
  name: StatusColumn
  hp: StatusValueColumn
  mp: StatusValueColumn | null
  gauge: StatusColumn | null
  /** HP / MP の数値の前に「HP 」「MP 」を付けるか */
  showLabels: boolean
  /** HP を「現在値/最大値」で出すか（false は現在値だけ。極端に狭い画面の最終手段） */
  showMaxHp: boolean
}

export interface StatusColumnsInput {
  /** status パネルの左端と幅 */
  x: number
  width: number
  /** 味方全員のうち最大の maxHp / maxMp（列幅を最長の数値に合わせる） */
  maxHp: number
  maxMp: number
  /** 幅が狭く MP を最初から出さない（`SideBattleLayout.statusCompact`） */
  compact: boolean
  /** ATB ゲージの列を付けるか */
  atb: boolean
  fontPx?: number
}

/** 極端に狭い画面でゲージを縮めてよい下限 */
export const SIDE_STATUS_GAUGE_MIN_WIDTH = 16

/**
 * status 欄の列（名前 / HP / MP / ATB ゲージ）の x と幅を求める。4 人とも同じ列を使うので、
 * 名前の長さで HP の位置がずれない。右端からゲージ → MP → HP と詰め、残りがすべて名前列になる。
 * 名前列が `SIDE_STATUS_MIN_NAME_CHARS` 文字ぶんに届かなければ、MP → 見出し → HP の最大値 → ゲージ幅の順に削って名前を残す。
 */
export function computeStatusColumns(input: StatusColumnsInput): StatusColumns {
  const font = input.fontPx ?? SIDE_STATUS_FONT_SIZE
  const leftBase = input.x + sideStatusLeftPadding(input.atb)
  const right = input.x + input.width - SIDE_STATUS_TEXT_PADDING
  const minName = SIDE_STATUS_MIN_NAME_CHARS * font
  const build = (
    withMp: boolean,
    labels: boolean,
    maxHpShown: boolean,
    gaugeW: number,
    extraLeft = 0
  ): StatusColumns => {
    const left = leftBase + extraLeft
    let edge = right
    let gauge: StatusColumn | null = null
    if (input.atb) {
      gauge = { x: edge - gaugeW, w: gaugeW }
      edge = gauge.x - SIDE_STATUS_COLUMN_GAP
    }
    // 値の列: 見出し（「MP 」） + 現在値の最大桁 + 「/最大値」。MP の最大値は常に出す
    const valueColumn = (maxValue: number, showMax: boolean, rightEdge: number) => {
      // 見出しと数字がくっつかないよう、見出しの後ろに列間と同じすき間（実フォントの「MP」は概算より広いので、これで実際に隙間が残る）を空ける
      const label = labels ? estimateTextWidth('MP', font) + SIDE_STATUS_COLUMN_GAP : 0
      const maxPart = showMax ? estimateTextWidth(`/${maxValue}`, font) : 0
      const curW = estimateTextWidth(`${maxValue}`, font)
      const w = label + curW + maxPart
      return { x: rightEdge - w, w, curRight: rightEdge - maxPart, labelPlusCur: label + curW }
    }
    let mp: StatusValueColumn | null = null
    if (withMp) {
      mp = valueColumn(input.maxMp, true, edge)
      edge = mp.x - SIDE_STATUS_COLUMN_GAP
    }
    const { labelPlusCur: hpLabelCur, ...hp } = valueColumn(input.maxHp, maxHpShown, edge)
    // 極端に狭いときも、HP 列が名前の左端（パネルの左余白）より左へ出ない。
    // 現在値の右端は、見出しと現在値の最大桁が重ならない位置までは右へ押し出す
    if (hp.x < left) {
      hp.w = Math.max(0, hp.x + hp.w - left)
      hp.x = left
      hp.curRight = Math.max(hp.curRight, left + hpLabelCur)
    }
    const nameW = Math.max(0, hp.x - SIDE_STATUS_COLUMN_GAP - left)
    return {
      name: { x: left, w: nameW },
      hp,
      mp,
      gauge,
      showLabels: labels,
      showMaxHp: maxHpShown,
    }
  }
  const G = SIDE_STATUS_GAUGE_WIDTH
  const tries: Array<[boolean, boolean, boolean, number]> = [
    ...(input.compact ? [] : [[true, true, true, G] as [boolean, boolean, boolean, number]]),
    [false, true, true, G],
    [false, false, true, G],
    [false, false, false, G],
  ]
  for (const [withMp, labels, maxHpShown, gaugeW] of tries) {
    const c = build(withMp, labels, maxHpShown, gaugeW)
    if (c.name.w >= minName) {
      // ATB: 名前列に余裕があるぶん（最小名前幅を割らない範囲）だけ、▶ の余白を MAX まで広げる。段階（省略）は変えない
      const extra = input.atb
        ? Math.min(
            SIDE_STATUS_MARKER_GUTTER_MAX - SIDE_STATUS_MARKER_GUTTER_MIN,
            c.name.w - minName
          )
        : 0
      return extra > 0 ? build(withMp, labels, maxHpShown, gaugeW, extra) : c
    }
  }
  return build(false, false, false, SIDE_STATUS_GAUGE_MIN_WIDTH)
}
