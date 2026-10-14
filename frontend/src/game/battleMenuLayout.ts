/**
 * 戦闘の候補窓・手のカーソルの座標 (#204)。純粋関数のみ（this / PixiJS に触れない）。
 * 状態の遷移は battleMenu.ts、描画は BattleMenuLayer.ts、ここは「どこに何を置くか」だけ。
 *
 * - 一覧窓はコマンド窓（下パネル左）に重ねて、その下端を揃えて上へ伸ばす。ログ帯には食い込まない
 * - 行が窓に収まらないときは先頭行をずらして（スクロール）見せる。窓は必ず画面内に収まる
 * - 手のカーソルは 1 コマ 2px のドット絵。敵は右側から左向き、味方は左側から右向き、一覧は行の左から右向き
 */
import type { MenuRow, MenuStack, MenuContext, MenuKind, TargetSide } from './battleMenu'
import { targetHands } from './battleMenu'
import { estimateTextWidth, fitLabel, SIDE_GAP, SIDE_PADDING, type Rect } from './battleLayout'

export const MENU_ROW_HEIGHT = 28
export const MENU_FONT_SIZE = 16
export const MENU_PADDING_X = 12
export const MENU_PADDING_Y = 12
/** 一覧窓の最大の見える行数。それ以上は▲▼でスクロールする（絵を覆う範囲を抑える） */
export const MENU_MAX_ROWS = 4
/** 行の左に置く手のぶんの余白 */
export const MENU_HAND_SLOT = 34
/** 名前と消費の間の最小の隙間 */
export const MENU_COST_GAP = 16
export const MENU_MIN_WIDTH = 140
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
  /** 敵・味方スプライトの枠（state.enemies / state.party と同じ index） */
  enemySlots: readonly Rect[]
  partySlots: readonly Rect[]
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

/** 一覧窓の矩形。幅は最長の行に合わせ、画面の右端（余白を除く）を越えない */
export function computeListWindowRect(g: MenuGeometry, rows: readonly MenuRow[]): ListWindowRect {
  const visibleRows = Math.max(1, Math.min(rows.length, listMaxRows(g)))
  const maxW = Math.max(0, g.width - SIDE_PADDING - g.command.x)
  // 幅はコマンド窓と同じ。狭いと窓の外にコマンドの文字がはみ出して見え、広いと味方のステータス欄や絵を覆う。
  // 入りきらない名前は buildMenuView が省略する
  const w = Math.min(g.command.w, maxW)
  const h = visibleRows * MENU_ROW_HEIGHT + MENU_PADDING_Y * 2
  const bottom = g.command.y + g.command.h
  return {
    rect: { x: g.command.x, y: Math.max(0, bottom - h), w, h },
    visibleRows,
  }
}

/** 手を `r` の隣に置く。敵は右側から左向き、味方は左側から右向き。画面内に収める */
export function computeTargetHand(
  side: TargetSide,
  r: Rect,
  width: number,
  height: number
): HandPlacement {
  const facing: HandFacing = side === 'enemy' ? 'left' : 'right'
  const rawX = side === 'enemy' ? r.x + r.w + 2 : r.x - HAND_WIDTH - 2
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
  rows: Array<MenuRow & { index: number; rect: Rect; selected: boolean }>
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

export interface MenuTargetView {
  type: 'target'
  hands: HandPlacement[]
  /** タップで対象を選ぶ当たり判定 */
  hits: Array<{ side: TargetSide; index: number; rect: Rect }>
}

export type MenuView = Array<MenuListView | MenuTargetView>

/** スタック全体を描画用の座標にする。一覧窓の下に対象窓が重なる順 */
export function buildMenuView(stack: MenuStack, ctx: MenuContext, g: MenuGeometry): MenuView {
  const out: MenuView = []
  stack.forEach((w, depthIndex) => {
    const active = depthIndex === stack.length - 1
    if (w.type === 'list') {
      // 対象選択の間は下の一覧を隠す（敵・味方の絵を覆わない。FF5/6 と同じ）
      if (!active) return
      const { rect, visibleRows } = computeListWindowRect(g, ctx.rows)
      const rows: MenuListView['rows'] = []
      for (let v = 0; v < visibleRows; v++) {
        const index = w.top + v
        const row = ctx.rows[index]
        if (!row) break
        const rowW = Math.max(0, rect.w - MENU_PADDING_X * 2 - MENU_HAND_SLOT)
        const costW = row.cost ? MENU_COST_GAP + estimateTextWidth(row.cost, MENU_FONT_SIZE) : 0
        rows.push({
          ...row,
          label: fitLabel(row.label, Math.max(0, rowW - costW), MENU_FONT_SIZE),
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
      if (r) hands.push(computeTargetHand(h.side, r, g.width, g.height))
    }
    const hits: MenuTargetView['hits'] = []
    const candidates = (side: TargetSide, list: readonly { hp: number }[]) => {
      list.forEach((e, index) => {
        const r = slotOf(side, index)
        if (!r) return
        if (w.spec.scope === 'single') {
          // target が示す側の、指せる者（生存者。蘇生は倒れた味方）だけ
          if (side !== w.side) return
          if (w.spec.revive ? e.hp > 0 : e.hp <= 0) return
          hits.push({ side, index, rect: r })
        } else if (w.spec.scope === 'all' && side === w.spec.side && e.hp > 0) {
          hits.push({ side, index, rect: r })
        } else if (w.spec.scope === 'self' && side === 'party' && index === ctx.actorIndex) {
          hits.push({ side, index, rect: r })
        }
      })
    }
    candidates('enemy', ctx.enemies)
    candidates('party', ctx.party)
    out.push({ type: 'target', hands, hits })
  })
  return out
}

/** 隙間の定数を layout 側と揃えて再公開（ログ帯の下端から一覧窓の上限を出すとき用） */
export const MENU_TOP_GAP = SIDE_GAP
