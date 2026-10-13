/**
 * RPG 戦闘画面のレイアウト計算 (#736)。純粋関数のみ（this / PixiJS に触れない）。
 *
 * `BattleScreen` の `layout: 'side'`（FF 系サイドビュー）で使う座標を、画面サイズ・味方数・敵数から返す。
 *
 *   +------------------------------------------+
 *   | [ログ帯: 直近 logLines 行（敵の数で可変）]  |  ← log
 *   |                                          |
 *   |  [敵]                       [味方]        |  ← enemies（左）/ party（右）。複数体は千鳥配置
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
  /** 敵のみ: 名前 + HP ラベルの矩形（スプライトの直下・画面絶対座標）。味方・潰れて置けない枠では undefined */
  label?: Rect
}

export interface SideBattleLayoutInput {
  width: number
  height: number
  partyCount: number
  enemyCount: number
  /** コマンドボタンの数（既定 4: たたかう/じゅもん/どうぐ/にげる） */
  commandCount?: number
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
  /** コマンドの各セル（2 列グリッド） */
  commandCells: Rect[]
  /** 下パネル右: 味方 HP/MP パネル全体 */
  status: Rect
  /** 味方 1 人ぶんの行（party の index 順） */
  statusRows: Rect[]
  /** status 幅が狭く MP 表記を省く必要があるか */
  statusCompact: boolean
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
/** スプライトの一辺がこれに届く最小の列数を選ぶ（届く列数が無ければ最大サイズの列数） */
export const SIDE_MIN_SPRITE_SIZE = 36
/** フォールバック四角（画像が無いとき）の枠内比率 */
const FALLBACK_X = 0.15
const FALLBACK_Y = 0.1
const FALLBACK_W = 0.7
const FALLBACK_H = 0.8
/** 千鳥（奥行きのずらし）の水平ずれ。スプライト一辺に対する比 */
export const SIDE_STAGGER_RATIO = 0.25

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
 * `name` + `suffix`（HP など必ず見せたい部分）を `maxWidthPx` に収める。名前側だけ省略する。
 * suffix 自体が収まらないときは全体を fitLabel する。
 */
export function fitNameWithSuffix(
  name: string,
  suffix: string,
  maxWidthPx: number,
  fontPx: number
): string {
  const room = maxWidthPx - estimateTextWidth(suffix, fontPx)
  if (room <= 0) return fitLabel(name + suffix, maxWidthPx, fontPx)
  return fitLabel(name, room, fontPx) + suffix
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

/**
 * ある側（敵 or 味方）の複数体を、領域内に千鳥で並べた枠を返す。
 *
 * - 列数は「3 体まで 1 列・4 体以上は 2 列」を下限に、スプライトが `SIDE_MIN_SPRITE_SIZE` に届く
 *   **最小の列数**を採る（列優先で埋める）。どの列数でも届かないときだけ最大サイズになる列数（同率は少ない方）
 * - 一辺は「領域幅」「領域高さ」「SIDE_MAX_SPRITE_SIZE」の最小。領域が潰れていても 0 以上
 * - 2 行以上のとき奇数行を `SIDE_STAGGER_RATIO * size` だけずらして奥行きを出す。
 *   ずらす向きは「敵は右（味方側）へ・味方は左（敵側）へ」で、向かい合う陣形になる
 * - 配置全体は領域内で水平・垂直とも中央寄せ
 * - `withLabel`（敵側）: 各行の高さを `size + SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT` にして、スプライトの直下に
 *   ラベル矩形（`slot.label`）を返す。ラベルを入れるとスプライトが 0 に潰れるほど低い領域では、
 *   ラベルだけを省いてスプライトを残す（`slot.label` なし）
 */
export function computeFormation(
  region: Rect,
  count: number,
  side: 'enemy' | 'party',
  withLabel = false
): SpriteSlot[] {
  if (count <= 0) return []
  const regionW = Math.max(0, region.w)
  const regionH = Math.max(0, region.h)
  // 敵側だけ各行にラベル（隙間 + 名前/HP の 2 行）ぶんを予約する
  let extra = withLabel ? SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT : 0
  const sizeFor = (columns: number): number => {
    const rows = Math.ceil(count / columns)
    const stagger = rows > 1 ? SIDE_STAGGER_RATIO : 0
    return Math.max(
      0,
      Math.min(regionW / (columns + stagger), regionH / rows - extra, SIDE_MAX_SPRITE_SIZE)
    )
  }
  const baseColumns = count > SIDE_MAX_ROWS_PER_COLUMN ? 2 : 1
  const pick = (): { columns: number; size: number } => {
    let best = { columns: baseColumns, size: sizeFor(baseColumns) }
    for (let c = baseColumns; c <= count; c++) {
      const size = sizeFor(c)
      if (size >= SIDE_MIN_SPRITE_SIZE) return { columns: c, size }
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
  const rows = Math.ceil(count / columns)
  const stagger = rows > 1 ? SIDE_STAGGER_RATIO : 0
  const totalW = size * (columns + stagger)
  const totalH = (size + extra) * rows
  const originX = region.x + (regionW - totalW) / 2
  const originY = region.y + (regionH - totalH) / 2
  const slots: SpriteSlot[] = []
  for (let i = 0; i < count; i++) {
    const col = Math.floor(i / rows)
    const row = i % rows
    const odd = row % 2 === 1
    // 敵: 奇数行を右へ / 味方: 偶数行を右へ（= 奇数行が相対的に左＝敵側へ寄る）
    const shifted = side === 'enemy' ? odd : !odd
    const dx = stagger > 0 && shifted ? size * stagger : 0
    const x = originX + col * size + dx
    const y = originY + row * (size + extra)
    const slot: SpriteSlot = { x, y, size }
    if (withLabel && !labelDropped && size > 0) {
      slot.label = { x, y: y + size + SIDE_LABEL_GAP, w: size, h: SIDE_LABEL_HEIGHT }
    }
    slots.push(slot)
  }
  return slots
}

/**
 * サイドビュー戦闘画面の全座標を算出する。
 *
 * 下パネルの高さは「コマンド 2x2 の高さ」と「味方全員ぶんの status 行」の大きい方。
 * 味方が増えると下パネルが伸び、ステージ領域が縮む（高さが足りなくても負にならない）。
 */
export function computeSideBattleLayout(input: SideBattleLayoutInput): SideBattleLayout {
  const W = input.width
  const H = input.height
  const partyCount = Math.max(0, Math.floor(input.partyCount))
  const enemyCount = Math.max(0, Math.floor(input.enemyCount))
  const commandCount = Math.max(0, Math.floor(input.commandCount ?? 4))
  const innerW = Math.max(0, W - SIDE_PADDING * 2)

  // 下: コマンド（左）+ status（右）
  const commandRows = Math.ceil(commandCount / SIDE_COMMAND_COLUMNS)
  const commandNeeded = commandRows * SIDE_COMMAND_CELL_HEIGHT
  const statusNeeded = partyCount * SIDE_STATUS_ROW_HEIGHT + SIDE_STATUS_VERTICAL_PADDING
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

  const cellW = commandW / SIDE_COMMAND_COLUMNS
  const cellH = commandRows > 0 ? bottomH / commandRows : 0
  const commandCells: Rect[] = []
  for (let i = 0; i < commandCount; i++) {
    commandCells.push({
      x: command.x + (i % SIDE_COMMAND_COLUMNS) * cellW,
      y: command.y + Math.floor(i / SIDE_COMMAND_COLUMNS) * cellH,
      w: cellW,
      h: cellH,
    })
  }

  const rowH =
    partyCount > 0
      ? Math.min(SIDE_STATUS_ROW_HEIGHT, (bottomH - SIDE_STATUS_VERTICAL_PADDING) / partyCount)
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
  let logLines = desiredSideLogLines(enemyCount)
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
  const half = stage.w / 2
  const enemyRegion: Rect = { x: stage.x, y: stage.y, w: half, h: stage.h }
  const partyRegion: Rect = { x: stage.x + half, y: stage.y, w: half, h: stage.h }

  return {
    log,
    logLines,
    stage,
    enemies: computeFormation(enemyRegion, enemyCount, 'enemy', true),
    party: computeFormation(partyRegion, partyCount, 'party'),
    command,
    commandCells,
    status,
    statusRows,
    statusCompact: status.w < SIDE_STATUS_COMPACT_WIDTH,
  }
}

/**
 * テクスチャを正方形の枠 `box` に収める（contain・縦横比維持・中央寄せ・枠からはみ出さない）。
 * 戻り値の `x,y` は枠の左上を原点とした画像の左上座標。テクスチャ寸法が不正（0 以下）なら枠いっぱい。
 */
export function computeContainFit(
  textureWidth: number,
  textureHeight: number,
  box: number
): { x: number; y: number; width: number; height: number } {
  if (!(textureWidth > 0) || !(textureHeight > 0) || !(box > 0)) {
    return { x: 0, y: 0, width: Math.max(0, box), height: Math.max(0, box) }
  }
  const scale = Math.min(box / textureWidth, box / textureHeight)
  const width = textureWidth * scale
  const height = textureHeight * scale
  return { x: (box - width) / 2, y: (box - height) / 2, width, height }
}

/** frontmatter `battle_layout` の値を正規化する。`'side'` 以外（未指定・未知値含む）は `'front'` */
export type BattleLayoutMode = 'front' | 'side'
export function normalizeBattleLayout(raw: string | null | undefined): BattleLayoutMode {
  return raw?.trim().toLowerCase() === 'side' ? 'side' : 'front'
}
