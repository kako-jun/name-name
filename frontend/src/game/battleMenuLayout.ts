/**
 * 戦闘の候補窓・手のカーソルの座標 (#204)。純粋関数のみ（this / PixiJS に触れない）。
 * 状態の遷移は battleMenu.ts、描画は BattleMenuLayer.ts、ここは「どこに何を置くか」だけ。
 *
 * - 一覧窓はコマンド窓（下パネル左）に重ねて、その下端を揃えて上へ伸ばす。ログ帯には食い込まない
 * - 行が窓に収まらないときは先頭行をずらして（スクロール）見せる。窓は必ず画面内に収まる
 * - 手のカーソルは 1 コマ 2px のドット絵。敵は右側から左向き、味方は左側から右向き、一覧は行の左から右向き
 */
import type { MenuRow, MenuStack, MenuContext, MenuKind, TargetSide } from './battleMenu'
import { targetHands, targetScopeOf } from './battleMenu'
import { enemyForListRow, enemyListHighlightRows } from './battleTargetCursor'
import { estimateTextWidth, fitLabel, SIDE_GAP, SIDE_PADDING, type Rect } from './battleLayout'

export const MENU_ROW_HEIGHT = 28
export const MENU_FONT_SIZE = 16
export const MENU_PADDING_X = 12
export const MENU_PADDING_Y = 12
/** 一覧窓の最大の見える行数。それ以上は▲▼でスクロールする（絵を覆う範囲を抑える） */
export const MENU_MAX_ROWS = 4
/** 名前の省略判定に足す許容（浮動小数の誤差で、ちょうど入る名前が省略されないように） */
const LABEL_FIT_EPS = 0.01
/** 一覧窓がコマンド窓の外形から四方にはみ出す量（枠線の太さ・角丸の余白。窓の縁にコマンド窓の背景が見えないように） */
export const MENU_COMMAND_OVERHANG = 4
/** 行の左に置く手のぶんの余白 */
export const MENU_HAND_SLOT = 34
/** 名前と消費の間の最小の隙間 */
export const MENU_COST_GAP = 16
/** 名前が全部見えるようにする全角の文字数（7 文字以下の名前は省略されない。8 文字以上は 6 文字 + 「…」）。窓の幅の下限を決める */
export const MENU_NAME_MIN_CHARS = 7
/** 窓の上端・下端のスクロール帯の高さ（上下の余白に収める。行の決定領域には食い込まない。タップで 1 行ずつ） */
export const MENU_SCROLL_STRIP = MENU_PADDING_Y

/** 手のドット絵（右向き）。`X` が塗り。左向きは左右反転 */
export const HAND_BITMAP: readonly string[] = [
  '....XX........',
  '...XXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  'XXXXXXXXXXX...',
  'XXXXXXXXXX....',
  'XXXXXXXXXXX...',
  'XXXXXXXXX.....',
  '.XXXXXXX......',
]
export const HAND_PIXEL = 2
export const HAND_WIDTH = HAND_BITMAP[0].length * HAND_PIXEL
export const HAND_HEIGHT = HAND_BITMAP.length * HAND_PIXEL

/**
 * 指の先（右向きの手で最も右へ伸びる行）の縦の中心を、手の高さに対する割合で表す（0〜1）。
 * ビットマップの形から導く（右端の列に塗りがある行の中央。現行の絵では 2〜3 行目＝0.25）。
 * 手の枠の中心（0.5）より上にあるため、枠の中心を文字の縦中心に置くと指が文字より上に見える (#1188)
 */
export const HAND_FINGER_Y_RATIO: number = (() => {
  const w = Math.max(...HAND_BITMAP.map((r) => r.lastIndexOf('X')))
  const rows = HAND_BITMAP.map((r, i) => (r.lastIndexOf('X') === w ? i : -1)).filter((i) => i >= 0)
  return (rows[0] + rows[rows.length - 1] + 1) / 2 / HAND_BITMAP.length
})()

/**
 * 指の先が `textCenterY`（文字の縦中心）の真横に来る手の枠の上端 y。
 * ずらし量 = `height * (0.5 - HAND_FINGER_Y_RATIO)`（枠の中心合わせより下へ。手の高さ＝文字の大きさに追従する）
 */
export function handTopForFingerAt(textCenterY: number, height: number): number {
  return textCenterY - height * HAND_FINGER_Y_RATIO
}

export type HandFacing = 'left' | 'right'

/** 手の左上と向き。幅・高さは `HAND_WIDTH` / `HAND_HEIGHT` */
export interface HandPlacement {
  x: number
  y: number
  facing: HandFacing
}

/** 手のドット（`HAND_PIXEL` 四方の塗り）の左上。原点は手の左上、向きに応じて反転済み */
export function handCells(facing: HandFacing): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  HAND_BITMAP.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== 'X') continue
      const cx = facing === 'right' ? x : row.length - 1 - x
      out.push({ x: cx * HAND_PIXEL, y: y * HAND_PIXEL })
    }
  })
  return out
}

/** 窓の配置に使う画面の寸法。BattleScreen の layoutSide が作る */
export interface MenuGeometry {
  width: number
  height: number
  /** コマンド窓（下パネル左） */
  command: Rect
  /** 一覧窓の上限（ログ帯の下端 + 隙間） */
  top: number
  /**
   * 窓の右端がこれを越えない（味方ステータス欄の HP 列の左。HP の数字を途中で切らない）。
   * 未指定は制限なし。コマンド窓の外形は必ず覆うので、その幅が下限
   */
  avoidX?: number
  /** 敵・味方スプライトの枠（state.enemies / state.party と同じ index） */
  enemySlots: readonly Rect[]
  partySlots: readonly Rect[]
  /**
   * 入り切らない名前の扱い (#1183)。未指定・`ellipsis` は従来どおり末尾を「…」で省略。`scroll` は省略せず全文を渡し、
   * 窓（`labelClipW`）でクリップしてゆっくり横スクロールさせる。窓の寸法は変えない（直交）
   */
  textOverflow?: 'ellipsis' | 'scroll'
  /**
   * 対象選択の出し方 (#1189)。`ff` は敵を指す手を敵の左から右向きに出す（FF4/5 SNES・ピクセルリマスターと同じ。味方は従来から左から右向き）。
   * 未指定は従来どおり敵の右から左向き
   */
  targetCursor?: 'ff'
  /**
   * 敵名ウィンドウ（#954）の見えている行 (#1189)。`battle_target_cursor: ff` で窓が出ているときだけ BattleScreen が渡す。
   * 敵を指す対象選択の間、指されている敵が入る行を明るい帯で強調し（FF ピクセルリマスターと同じ。行に手は出さない）、
   * 行のタップでその行の敵を指す（敵の絵の手と同じ敵）。`rect` は行の帯、`members` はその行に入る生きている敵の index（`state.enemies` の並び）
   */
  enemyListRows?: ReadonlyArray<{ rect: Rect; members: readonly number[] }>
}

/** 一覧窓に同時に見える行数（最低 1） */
export function listMaxRows(g: MenuGeometry): number {
  const avail = g.command.y + g.command.h - g.top - MENU_PADDING_Y * 2
  return Math.max(1, Math.min(MENU_MAX_ROWS, Math.floor(avail / MENU_ROW_HEIGHT)))
}

export interface ListWindowRect {
  rect: Rect
  /** 見える行数 */
  visibleRows: number
}

/**
 * 消費欄に予約する幅 (#1224)。窓の大きさは中身（種類・消費の桁数）で変えない（FF は変えない）。
 * 消費は 3 文字（魔法の MP 3 桁「123」、どうぐの個数「×99」）までを想定し、広い方を常に予約する。
 * 消費の値に上限はなく、これより長い消費（「×100」・MP 1000 など）は窓を広げず、その行の名前が `buildMenuView` の `fitLabel` で短くなる
 * （窓の大きさが固定なのが仕様。FF と同じ）
 */
export const MENU_COST_RESERVE_W = Math.max(
  estimateTextWidth('999', MENU_FONT_SIZE),
  estimateTextWidth('×99', MENU_FONT_SIZE)
)

/**
 * 一覧窓の矩形。寸法は画面の形 `g` だけで決まり、中身（行数・種類・消費の桁数）に依存しない (#1224)。
 * 高さは常に `listMaxRows(g)` 行ぶん（行が足りなければ空き行は空白、多ければ▲▼でスクロール）。
 * 幅は消費欄を固定幅で予約し、画面の右端（余白を除く）を越えない
 */
export function computeListWindowRect(g: MenuGeometry): ListWindowRect {
  const visibleRows = listMaxRows(g)
  const x = Math.max(0, g.command.x - MENU_COMMAND_OVERHANG)
  const maxW = Math.max(0, g.width - (SIDE_PADDING - MENU_COMMAND_OVERHANG) - x)
  // 幅はコマンド窓と同じを基本にする（狭いと窓の外にコマンドの文字がはみ出して見え、広いと味方のステータス欄や絵を覆う）。
  // ただし名前が最低 MENU_NAME_MIN_CHARS 文字ぶん読める幅を下限にする（縦長の画面ではコマンド窓が狭く、消費を引くと名前が残らない）。
  // この場合は味方ステータス欄の名前列に少し重なるが、HP の数字は切らない（avoidX で HP 列の左に止める）。入りきらない名前は buildMenuView が省略する
  const costW = MENU_COST_RESERVE_W
  // 切り上げる（小数の誤差で、ちょうど MENU_NAME_MIN_CHARS 文字ぶんの幅に 1px 未満届かず省略されるのを防ぐ）
  const need = Math.ceil(
    MENU_PADDING_X * 2 +
      MENU_HAND_SLOT +
      costW +
      MENU_COST_GAP +
      MENU_NAME_MIN_CHARS * MENU_FONT_SIZE
  )
  const minW = Math.min(g.command.w + MENU_COMMAND_OVERHANG * 2, maxW)
  const limit = g.avoidX === undefined ? maxW : Math.max(0, g.avoidX - x)
  const w = Math.max(minW, Math.min(need, maxW, limit))
  // 行が少なくてもコマンド窓の枠の外形（枠線・余白ぶん上下左右に MENU_COMMAND_OVERHANG はみ出す）全体を覆う高さにする。
  // 窓の上にコマンドの文字や背景が顔を出さない。余白は下側
  const h = Math.max(
    visibleRows * MENU_ROW_HEIGHT + MENU_PADDING_Y * 2,
    g.command.h + MENU_COMMAND_OVERHANG * 2
  )
  const bottom = Math.min(g.height, g.command.y + g.command.h + MENU_COMMAND_OVERHANG)
  return {
    rect: { x, y: Math.max(0, bottom - h), w, h },
    visibleRows,
  }
}

/**
 * 手を `r` の隣に置く。敵は右側から左向き、味方は左側から右向き。画面内に収める。
 * `fromLeft`（`battle_target_cursor: ff`。#1189）なら敵も左側から右向き（FF と同じく、手は常に右を指す）
 */
export function computeTargetHand(
  side: TargetSide,
  r: Rect,
  width: number,
  height: number,
  fromLeft = false
): HandPlacement {
  const right = side === 'enemy' && !fromLeft
  const facing: HandFacing = right ? 'left' : 'right'
  const rawX = right ? r.x + r.w + 2 : r.x - HAND_WIDTH - 2
  const rawY = r.y + r.h / 2 - HAND_HEIGHT / 2
  return {
    x: Math.max(0, Math.min(rawX, width - HAND_WIDTH)),
    y: Math.max(0, Math.min(rawY, height - HAND_HEIGHT)),
    facing,
  }
}

export interface MenuListView {
  type: 'list'
  kind: MenuKind
  rect: Rect
  /** 見えている行（index は候補全体での位置） */
  rows: Array<
    MenuRow & {
      index: number
      rect: Rect
      selected: boolean
      /** `scroll` で名前が窓に入り切らないときだけ付く。label は全文で、この幅（名前の領域）でクリップして流す (#1183) */
      labelClipW?: number
    }
  >
  /** 選択中の行の左の手。選択中の行がスクロールで見えていなければ null */
  hand: HandPlacement | null
  moreAbove: boolean
  moreBelow: boolean
  /** タップで一覧を 1 行ずつスクロールする帯（窓の上端・下端）。スクロールできないときは null */
  scrollUp: Rect | null
  scrollDown: Rect | null
  /** いちばん上の窓か（下に隠れた窓は暗く描く） */
  active: boolean
}

/** 全体化の切り替え窓 (#895)。「たんたい」「ぜんたい」の 2 行。対象窓のあいだ、隠れた一覧窓と同じ位置・大きさで 2 行（残りは空行）を常に出す */
export interface MenuScopeToggleView {
  rect: Rect
  rows: Array<{ label: string; all: boolean; selected: boolean; rect: Rect }>
  /** 選択中の行の左の手 */
  hand: HandPlacement
}

export interface MenuTargetView {
  type: 'target'
  hands: HandPlacement[]
  /** タップで対象を選ぶ当たり判定 */
  hits: Array<{ side: TargetSide; index: number; rect: Rect }>
  /** 敵名ウィンドウで強調する行の帯 (#1189。`battle_target_cursor: ff` のときだけ付く) */
  highlights?: Rect[]
  /** 全体化できる呪文のときだけ付く (#895)。たんたい / ぜんたい の切り替え窓 */
  toggle?: MenuScopeToggleView
}

/** 全体化の切り替え窓の行の表示名 (#895)。UI は絵文字を使わずテキスト */
export const SCOPE_TOGGLE_LABELS = { single: 'たんたい', all: 'ぜんたい' } as const

export type MenuView = Array<MenuListView | MenuTargetView>

/** スタック全体を描画用の座標にする。一覧窓の下に対象窓が重なる順 */
export function buildMenuView(stack: MenuStack, ctx: MenuContext, g: MenuGeometry): MenuView {
  const out: MenuView = []
  stack.forEach((w, depthIndex) => {
    const active = depthIndex === stack.length - 1
    if (w.type === 'list') {
      // 対象選択の間は下の一覧を隠す（敵・味方の絵を覆わない。FF5/6 と同じ）
      if (!active) return
      const { rect, visibleRows } = computeListWindowRect(g)
      const rows: MenuListView['rows'] = []
      for (let v = 0; v < visibleRows; v++) {
        const index = w.top + v
        const row = ctx.rows[index]
        if (!row) break
        const rowW = Math.max(0, rect.w - MENU_PADDING_X * 2 - MENU_HAND_SLOT)
        const costW = row.cost ? MENU_COST_GAP + estimateTextWidth(row.cost, MENU_FONT_SIZE) : 0
        const labelW = Math.max(0, rowW - costW)
        const scrolls =
          g.textOverflow === 'scroll' &&
          estimateTextWidth(row.label, MENU_FONT_SIZE) > labelW + LABEL_FIT_EPS
        rows.push({
          ...row,
          label: scrolls ? row.label : fitLabel(row.label, labelW + LABEL_FIT_EPS, MENU_FONT_SIZE),
          ...(scrolls ? { labelClipW: labelW } : {}),
          index,
          selected: index === w.cursor,
          rect: {
            x: rect.x + MENU_PADDING_X + MENU_HAND_SLOT,
            y: rect.y + MENU_PADDING_Y + v * MENU_ROW_HEIGHT,
            w: Math.max(0, rect.w - MENU_PADDING_X * 2 - MENU_HAND_SLOT),
            h: MENU_ROW_HEIGHT,
          },
        })
      }
      const sel = rows.find((r) => r.selected)
      out.push({
        type: 'list',
        kind: w.kind,
        rect,
        rows,
        hand: sel
          ? {
              x: rect.x + MENU_PADDING_X,
              y: sel.rect.y + MENU_ROW_HEIGHT / 2 - HAND_HEIGHT / 2,
              facing: 'right',
            }
          : null,
        moreAbove: w.top > 0,
        moreBelow: w.top + visibleRows < ctx.rows.length,
        scrollUp: w.top > 0 ? { x: rect.x, y: rect.y, w: rect.w, h: MENU_SCROLL_STRIP } : null,
        scrollDown:
          w.top + visibleRows < ctx.rows.length
            ? { x: rect.x, y: rect.y + rect.h - MENU_SCROLL_STRIP, w: rect.w, h: MENU_SCROLL_STRIP }
            : null,
        active,
      })
      return
    }
    const slotOf = (side: TargetSide, index: number): Rect | undefined =>
      (side === 'enemy' ? g.enemySlots : g.partySlots)[index]
    const hands: HandPlacement[] = []
    for (const h of targetHands(w, ctx.party, ctx.enemies, ctx.actorIndex)) {
      const r = slotOf(h.side, h.index)
      if (r) hands.push(computeTargetHand(h.side, r, g.width, g.height, g.targetCursor === 'ff'))
    }
    const hits: MenuTargetView['hits'] = []
    // 敵名ウィンドウの行 (#1189): 指されている敵が入る行を強調し、行のタップでその行の敵を指す（絵の手と同じ敵）
    const highlights: Rect[] = []
    const listRows = g.enemyListRows
    const enemySideScope =
      (targetScopeOf(w) === 'single' && w.side === 'enemy' && !w.spec.revive) ||
      (targetScopeOf(w) === 'all' && w.spec.side === 'enemy')
    if (listRows && enemySideScope) {
      const targets = targetHands(w, ctx.party, ctx.enemies, ctx.actorIndex)
        .filter((h) => h.side === 'enemy')
        .map((h) => h.index)
      for (const row of enemyListHighlightRows(
        listRows.map((r) => r.members),
        targets
      ))
        highlights.push(listRows[row].rect)
      listRows.forEach((r, row) => {
        const index = enemyForListRow(
          listRows.map((x) => x.members),
          row,
          w.cursor
        )
        if (index >= 0) hits.push({ side: 'enemy', index, rect: r.rect })
      })
    }
    const candidates = (side: TargetSide, list: readonly { hp: number }[]) => {
      list.forEach((e, index) => {
        const r = slotOf(side, index)
        if (!r) return
        const scope = targetScopeOf(w)
        if (scope === 'single') {
          // target が示す側の、指せる者（生存者。蘇生は倒れた味方）だけ
          if (side !== w.side) return
          if (w.spec.revive ? e.hp > 0 : e.hp <= 0) return
          hits.push({ side, index, rect: r })
        } else if (scope === 'all' && side === w.spec.side && e.hp > 0) {
          hits.push({ side, index, rect: r })
        } else if (scope === 'self' && side === 'party' && index === ctx.actorIndex) {
          hits.push({ side, index, rect: r })
        }
      })
    }
    candidates('enemy', ctx.enemies)
    candidates('party', ctx.party)
    const view: MenuTargetView = {
      type: 'target',
      hands,
      hits,
      ...(highlights.length > 0 ? { highlights } : {}),
    }
    if (w.spec.multiAllowed) {
      // 全体化の切り替え窓 (#895)。隠れた一覧窓と同じ位置・大きさ（行は 2 つ、残りは空行）に出し、手が今の状態の行を指す
      const labels = [
        { label: SCOPE_TOGGLE_LABELS.single, all: false },
        { label: SCOPE_TOGGLE_LABELS.all, all: true },
      ]
      const { rect } = computeListWindowRect(g)
      const rowRect = (i: number): Rect => ({
        x: rect.x + MENU_PADDING_X + MENU_HAND_SLOT,
        y: rect.y + MENU_PADDING_Y + i * MENU_ROW_HEIGHT,
        w: Math.max(0, rect.w - MENU_PADDING_X * 2 - MENU_HAND_SLOT),
        h: MENU_ROW_HEIGHT,
      })
      const cur = w.all === true ? 1 : 0
      view.toggle = {
        rect,
        rows: labels.map((l, i) => ({ ...l, selected: i === cur, rect: rowRect(i) })),
        hand: {
          x: rect.x + MENU_PADDING_X,
          y: rowRect(cur).y + MENU_ROW_HEIGHT / 2 - HAND_HEIGHT / 2,
          facing: 'right',
        },
      }
    }
    out.push(view)
  })
  return out
}

/** 隙間の定数を layout 側と揃えて再公開（ログ帯の下端から一覧窓の上限を出すとき用） */
export const MENU_TOP_GAP = SIDE_GAP
