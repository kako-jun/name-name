/**
 * 戦闘の候補窓（一覧）と手のカーソルの描画 (#204)。座標・状態は battleMenu.ts / battleMenuLayout.ts が正本で、
 * ここは渡された `MenuView` を PixiJS に描くだけ（毎回作り直す。窓は数枚・行は数十なので十分軽い）。
 * パネルの見た目（dark / ff-blue）と文字スタイルは BattleScreen から借りる（`BattleMenuHost`）。
 */
import { Container, Graphics, Rectangle, Text as PixiText, type TextStyle } from 'pixi.js'
import {
  HAND_PIXEL,
  MENU_FONT_SIZE,
  MENU_PADDING_X,
  handCells,
  type HandPlacement,
  type MenuListView,
  type MenuScopeToggleView,
  type MenuTargetView,
  type MenuView,
} from './battleMenuLayout'
import type { TargetSide } from './battleMenu'
import { estimateTextWidth } from './battleLayout'
import { sampleMenuTransition, DEFAULT_MOTION_TIMING } from './battleMotion'

/** BattleScreen が提供する、見た目の共通部品と入力の通知先 */
export interface BattleMenuHost {
  makePanel(): Container
  /** `opaque` なら背景を不透明にする（下のコマンド窓の文字が透けないように） */
  drawPanel(panel: Container, x: number, y: number, w: number, h: number, opaque?: boolean): void
  textStyle(): TextStyle
  /** 一覧の行がタップされた（index は候補全体での位置） */
  onRowTap(index: number): void
  /** 一覧の上端・下端の▲▼がタップされた（delta = -1 で上、+1 で下へ 1 行スクロール） */
  onScroll(delta: number): void
  /** 対象がタップされた */
  onTargetTap(side: TargetSide, index: number): void
  /** 全体化の たんたい / ぜんたい の行がタップされた (#895。`all` = ぜんたい) */
  onScopeTap(all: boolean): void
  /** 窓の外（背景）がタップされた = キャンセル */
  onCancelTap(): void
}

const HAND_FILL = 0xffffff
const HAND_OUTLINE = 0x000000
const ROW_COLOR = 0xffffff
const ROW_DISABLED_COLOR = 0x808080
/** 一番上でない窓（下に隠れた一覧）を暗く描く */
const INACTIVE_ALPHA = 0.6
const MORE_MARK_COLOR = 0xffee66
/** 操作の案内の文字（画面下端の余白 16px に収まる大きさ） */
export const HINT_FONT_SIZE = 10
const HINT_COLOR = 0xdddddd
const HINT_BOTTOM = 3
/** 案内 1 行の高さの見積もり（文字の大きさ + 上下の余白。計測が使えない環境でも同じ値で配置できる） */
export const HINT_LINE_HEIGHT = HINT_FONT_SIZE + 4

export interface HintRect {
  x: number
  y: number
  w: number
  h: number
}

/** 案内と窓の間に空ける隙間 (px) */
export const HINT_GAP = 2

/** 案内の置き場所。`cx` は文字の中心 x、`bottom` は文字の下端 y */
export interface HintPlacement {
  cx: number
  bottom: number
}

/** 案内を左右に逃がすとき、画面の端に空ける余白 (px) */
const HINT_SIDE_MARGIN = 8

/**
 * 案内を置く位置を返す。窓（一覧窓は画面下端の余白まで伸びる）と交差しない位置が無ければ null＝出さない。
 * 優先順: 中央（既定。画面下端から `HINT_BOTTOM`）→ 窓の横の空きの中央（右、次に左）→ 窓の下端 + `HINT_GAP` の下。
 */
export function placeHint(
  size: { w: number; h: number },
  width: number,
  height: number,
  windows: ReadonlyArray<HintRect>
): HintPlacement | null {
  const defBottom = height - HINT_BOTTOM
  const hits = (cx: number, bottom: number): boolean => {
    const left = cx - size.w / 2
    const right = cx + size.w / 2
    const top = bottom - size.h
    return windows.some(
      (r) =>
        r.x < right + HINT_GAP &&
        left < r.x + r.w + HINT_GAP &&
        r.y < bottom + HINT_GAP &&
        top < r.y + r.h + HINT_GAP
    )
  }
  const inScreen = (cx: number, bottom: number): boolean =>
    cx - size.w / 2 >= 0 && cx + size.w / 2 <= width && bottom <= height
  const candidates: HintPlacement[] = [{ cx: width / 2, bottom: defBottom }]
  const near = windows.filter((r) => r.y + r.h + HINT_GAP > defBottom - size.h)
  if (near.length > 0) {
    const maxRight = Math.max(...near.map((r) => r.x + r.w)) + HINT_GAP
    const minLeft = Math.min(...near.map((r) => r.x)) - HINT_GAP
    const rightSpan = [maxRight, width - HINT_SIDE_MARGIN]
    const leftSpan = [HINT_SIDE_MARGIN, minLeft]
    for (const [l, r] of [rightSpan, leftSpan]) {
      if (r - l >= size.w) candidates.push({ cx: (l + r) / 2, bottom: defBottom })
    }
    const maxBottom = Math.max(...near.map((r) => r.y + r.h))
    candidates.push({ cx: width / 2, bottom: maxBottom + HINT_GAP + size.h })
  }
  return candidates.find((c) => inScreen(c.cx, c.bottom) && !hits(c.cx, c.bottom)) ?? null
}

export class BattleMenuLayer extends Container {
  private host: BattleMenuHost
  private backdrop = new Graphics()
  private body = new Container()
  /** 操作の案内の置き場。窓（body）の開閉の動きには連動させず、窓が閉じ始めたらすぐ差し替える */
  private hintBox = new Container()
  /** 開閉アニメーション (#745): 長さ（0 = なし）・今の動き・開いた状態か・閉じ切ったあとに描く案内 */
  private transitionMs = 0
  private anim: { kind: 'open' | 'close'; elapsed: number } | null = null
  private opened = false
  private pendingClosed: { width: number; height: number; hint: string } | null = null

  constructor(host: BattleMenuHost) {
    super()
    this.host = host
    this.visible = false
    this.eventMode = 'passive'
    this.backdrop.eventMode = 'static'
    this.backdrop.on('pointertap', () => this.host.onCancelTap())
    this.addChild(this.backdrop, this.body, this.hintBox)
  }

  /**
   * 開閉アニメーションの長さ（ms。0 は即座に開閉＝従来）(#745)。窓が閉じたあとの状態を直接 `update` で描き直す経路は
   * アニメーションと独立（アニメーション中でも `view` が来れば開いた状態へ戻す）
   */
  setTransitionMs(ms: number): void {
    this.transitionMs = Number.isFinite(ms) && ms > 0 ? ms : 0
    if (this.transitionMs === 0) this.settleOpen()
  }

  /** 開閉の進み。`dt` ms 進め、閉じ切ったら窓の中身を片付けて案内だけ描く */
  tick(dt: number): void {
    if (this.anim === null) return
    this.anim.elapsed += Number.isFinite(dt) ? Math.max(0, dt) : 0
    const timing = { ...DEFAULT_MOTION_TIMING, menuMs: this.transitionMs }
    const sample = sampleMenuTransition(this.anim.kind, this.anim.elapsed, timing)
    if (!sample.done) {
      this.applyTransform(sample.alpha, sample.scale)
      return
    }
    const kind = this.anim.kind
    this.anim = null
    if (kind === 'open') {
      this.settleOpen()
      return
    }
    // 閉じ切った: 窓の中身を捨て、閉じている間に来た案内（あれば）を描く
    const pending = this.pendingClosed
    this.pendingClosed = null
    for (const c of this.body.removeChildren()) c.destroy({ children: true }) // 案内は閉じ始めに描き済みなので残す
    this.settleOpen()
    this.opened = false
    this.visible = !!pending && pending.hint !== ''
  }

  /** 窓を描き直す。`view` が空なら全体を隠し、入力も通す（開閉アニメーションが有効なら、閉じる動きのあとで隠す） */
  update(view: MenuView, width: number, height: number, hint = ''): void {
    const open = view.length > 0
    if (!open && this.anim?.kind === 'close') {
      // 閉じている最中に来た更新: 動きは続け、案内だけ差し替える
      this.pendingClosed = { width, height, hint }
      this.clearHint()
      this.drawHint(hint, width, height, [])
      return
    }
    if (!open && this.transitionMs > 0 && this.opened && this.body.children.length > 0) {
      // 開いていた窓を、中身を残したまま閉じる動きへ。入力は通す（backdrop を外し、行のタップも受けない）
      this.backdrop.clear()
      this.backdrop.hitArea = null
      this.backdrop.eventMode = 'none'
      this.body.interactiveChildren = false
      this.pendingClosed = { width, height, hint }
      // 開く途中で閉じるときは、今の alpha から閉じ始める（飛ばない）。案内は窓の動きを待たずにすぐ差し替える
      this.anim = { kind: 'close', elapsed: this.continuedElapsed('close') }
      this.opened = false
      this.visible = true
      this.clearHint()
      this.drawHint(hint, width, height, [])
      return
    }
    this.clearBody()
    this.visible = open || hint !== ''
    this.backdrop.clear()
    if (!open) {
      this.anim = null
      this.opened = false
      this.settleOpen()
      this.backdrop.hitArea = null
      this.drawHint(hint, width, height, [])
      return
    }
    // 窓の外のタップは全面で受けてキャンセルにする（下のコマンドに漏らさない）
    this.backdrop.eventMode = 'static'
    this.body.interactiveChildren = true
    this.backdrop.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.001 })
    this.backdrop.hitArea = new Rectangle(0, 0, width, height)
    for (const v of view) {
      if (v.type === 'list') this.drawList(v)
      else this.drawTarget(v)
    }
    this.drawHint(
      hint,
      width,
      height,
      view.flatMap((v) => (v.type === 'list' ? [v.rect] : []))
    )
    // 閉じている状態（または閉じる途中）から開いたときだけ、開く動きを始める。開いている最中の描き直しでは動きを続ける
    if (this.transitionMs > 0 && (!this.opened || this.anim?.kind === 'close')) {
      this.centerOf(view)
      // 閉じる途中から開き直すときは、今の alpha から続ける（alpha 0 へ飛ばない）
      const from = this.continuedElapsed('open')
      this.anim = { kind: 'open', elapsed: from }
      const first = sampleMenuTransition('open', from, {
        ...DEFAULT_MOTION_TIMING,
        menuMs: this.transitionMs,
      })
      this.applyTransform(first.alpha, first.scale)
    } else if (this.anim?.kind === 'open') {
      this.centerOf(view)
      const timing = { ...DEFAULT_MOTION_TIMING, menuMs: this.transitionMs }
      const cur = sampleMenuTransition('open', this.anim.elapsed, timing)
      this.applyTransform(cur.alpha, cur.scale)
    } else {
      this.settleOpen()
    }
    this.opened = true
    this.pendingClosed = null
  }

  private clearBody(): void {
    for (const c of this.body.removeChildren()) c.destroy({ children: true })
    this.clearHint()
  }

  private clearHint(): void {
    for (const c of this.hintBox.removeChildren()) c.destroy({ children: true })
  }

  /** 今の動きの途中の alpha から続けるための、動きの経過 ms（イージングの逆算。動きが無ければ始点 0） */
  private continuedElapsed(kind: 'open' | 'close'): number {
    if (this.anim === null) return 0
    const a = Math.min(1, Math.max(0, this.body.alpha))
    const p = kind === 'open' ? 1 - Math.sqrt(1 - a) : 1 - Math.sqrt(a)
    return p * this.transitionMs
  }

  /** 拡大・縮小の中心を、一覧窓の外接矩形の中心にする（一覧が無ければ原点のまま＝alpha だけ効く） */
  private centerOf(view: MenuView): void {
    const lists = view.flatMap((v) => (v.type === 'list' ? [v.rect] : []))
    if (lists.length === 0) {
      this.body.pivot.set(0, 0)
      this.body.position.set(0, 0)
      return
    }
    const x0 = Math.min(...lists.map((r) => r.x))
    const y0 = Math.min(...lists.map((r) => r.y))
    const x1 = Math.max(...lists.map((r) => r.x + r.w))
    const y1 = Math.max(...lists.map((r) => r.y + r.h))
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    this.body.pivot.set(cx, cy)
    this.body.position.set(cx, cy)
  }

  private applyTransform(alpha: number, scale: number): void {
    this.body.alpha = alpha
    this.body.scale.set(scale)
  }

  /** 開き切った（動きのない）状態に戻す */
  private settleOpen(): void {
    this.body.alpha = 1
    this.body.scale.set(1)
    if (this.anim === null) {
      this.body.pivot.set(0, 0)
      this.body.position.set(0, 0)
    }
  }

  /**
   * 操作の案内（画面の下端の余白に小さく中央寄せ。タップは受けない）。
   * 窓が下端の余白まで伸びて案内と交差するときは `placeHint` で窓を避けた位置へ逃がし、置けなければ出さない
   */
  private drawHint(
    hint: string,
    width: number,
    height: number,
    windows: ReadonlyArray<HintRect>
  ): void {
    if (hint === '') return
    const t = new PixiText({ text: hint, style: this.styled(HINT_COLOR, HINT_FONT_SIZE) })
    t.anchor.set(0.5, 1)
    t.eventMode = 'none'
    const at = placeHint(
      { w: estimateTextWidth(hint, HINT_FONT_SIZE), h: HINT_LINE_HEIGHT },
      width,
      height,
      windows
    )
    if (at === null) {
      t.destroy()
      return
    }
    t.x = at.cx
    t.y = at.bottom
    this.hintBox.addChild(t)
  }

  private drawList(v: MenuListView): void {
    const win = new Container()
    win.alpha = v.active ? 1 : INACTIVE_ALPHA
    // 窓の中のタップは背景（キャンセル）へ届かせない
    win.eventMode = 'static'
    const panel = this.host.makePanel()
    win.addChild(panel)
    this.host.drawPanel(panel, v.rect.x, v.rect.y, v.rect.w, v.rect.h, true)
    for (const row of v.rows) {
      const color = row.disabled ? ROW_DISABLED_COLOR : ROW_COLOR
      const label = new PixiText({ text: row.label, style: this.styled(color) })
      label.anchor.set(0, 0.5)
      label.eventMode = 'none' // 文字はタップを受けない（行の判定へ通す）
      label.x = row.rect.x
      label.y = row.rect.y + row.rect.h / 2
      win.addChild(label)
      if (row.cost) {
        const cost = new PixiText({ text: row.cost, style: this.styled(color) })
        cost.anchor.set(1, 0.5)
        cost.eventMode = 'none'
        cost.x = row.rect.x + row.rect.w
        cost.y = label.y
        win.addChild(cost)
      }
      if (v.active) {
        const hit = new Container()
        hit.eventMode = 'static'
        hit.cursor = 'pointer'
        hit.hitArea = new Rectangle(v.rect.x, row.rect.y, v.rect.w, row.rect.h)
        hit.on('pointertap', () => this.host.onRowTap(row.index))
        win.addChild(hit)
      }
    }
    // 行より後に足して、窓の端では行よりスクロール帯を優先する
    const strip = (r: { x: number; y: number; w: number; h: number } | null, delta: number) => {
      if (!r || !v.active) return
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.hitArea = new Rectangle(r.x, r.y, r.w, r.h)
      hit.on('pointertap', () => this.host.onScroll(delta))
      win.addChild(hit)
    }
    strip(v.scrollUp, -1)
    strip(v.scrollDown, 1)
    if (v.moreAbove)
      win.addChild(this.moreMark('▲', v.rect.x + v.rect.w - MENU_PADDING_X, v.rect.y + 4, 0))
    if (v.moreBelow) {
      win.addChild(
        this.moreMark('▼', v.rect.x + v.rect.w - MENU_PADDING_X, v.rect.y + v.rect.h - 4, 1)
      )
    }
    if (v.hand) win.addChild(this.hand(v.hand))
    this.body.addChild(win)
  }

  private drawTarget(v: MenuTargetView): void {
    const layer = new Container()
    for (const h of v.hits) {
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.hitArea = new Rectangle(h.rect.x, h.rect.y, h.rect.w, h.rect.h)
      hit.on('pointertap', () => this.host.onTargetTap(h.side, h.index))
      layer.addChild(hit)
    }
    for (const h of v.hands) layer.addChild(this.hand(h))
    this.body.addChild(layer)
    if (v.toggle) this.drawScopeToggle(v.toggle)
  }

  /** 全体化の切り替え窓 (#895)。隠れた一覧窓の位置に「たんたい / ぜんたい」の 2 行を常に出す。行のタップでも切り替わる */
  private drawScopeToggle(t: MenuScopeToggleView): void {
    const win = new Container()
    // 窓の中のタップは背景（キャンセル）へ届かせない
    win.eventMode = 'static'
    const panel = this.host.makePanel()
    win.addChild(panel)
    this.host.drawPanel(panel, t.rect.x, t.rect.y, t.rect.w, t.rect.h, true)
    for (const row of t.rows) {
      const label = new PixiText({
        text: row.label,
        style: this.styled(row.selected ? ROW_COLOR : ROW_DISABLED_COLOR),
      })
      label.anchor.set(0, 0.5)
      label.eventMode = 'none'
      label.x = row.rect.x
      label.y = row.rect.y + row.rect.h / 2
      win.addChild(label)
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.hitArea = new Rectangle(t.rect.x, row.rect.y, t.rect.w, row.rect.h)
      hit.on('pointertap', () => this.host.onScopeTap(row.all))
      win.addChild(hit)
    }
    win.addChild(this.hand(t.hand))
    this.body.addChild(win)
  }

  private moreMark(mark: string, x: number, y: number, anchorY: number): PixiText {
    const t = new PixiText({ text: mark, style: this.styled(MORE_MARK_COLOR, 10) })
    t.anchor.set(1, anchorY)
    // 記号はタップを受けない（下のスクロール帯へ通す）
    t.eventMode = 'none'
    t.x = x
    t.y = y
    return t
  }

  private styled(fill: number, size = MENU_FONT_SIZE): TextStyle {
    const s = this.host.textStyle()
    s.fill = fill
    s.fontSize = size
    return s
  }

  /** 手のドット絵。黒い縁（1 ドットぶん外へ広げた塗り）の上に白を重ねる */
  private hand(p: HandPlacement): Graphics {
    const g = new Graphics()
    // 手はタップを受けない（行・対象の判定へ通す。親が static だと手が当たり判定に参加して止めてしまう）
    g.eventMode = 'none'
    const cells = handCells(p.facing)
    for (const c of cells) {
      g.rect(p.x + c.x - 1, p.y + c.y - 1, HAND_PIXEL + 2, HAND_PIXEL + 2).fill({
        color: HAND_OUTLINE,
      })
    }
    for (const c of cells) {
      g.rect(p.x + c.x, p.y + c.y, HAND_PIXEL, HAND_PIXEL).fill({ color: HAND_FILL })
    }
    return g
  }
}
