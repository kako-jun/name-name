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
  type MenuTargetView,
  type MenuView,
} from './battleMenuLayout'
import type { TargetSide } from './battleMenu'

/** BattleScreen が提供する、見た目の共通部品と入力の通知先 */
export interface BattleMenuHost {
  makePanel(): Container
  drawPanel(panel: Container, x: number, y: number, w: number, h: number): void
  textStyle(): TextStyle
  /** 一覧の行がタップされた（index は候補全体での位置） */
  onRowTap(index: number): void
  /** 対象がタップされた */
  onTargetTap(side: TargetSide, index: number): void
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

export class BattleMenuLayer extends Container {
  private host: BattleMenuHost
  private backdrop = new Graphics()
  private body = new Container()

  constructor(host: BattleMenuHost) {
    super()
    this.host = host
    this.visible = false
    this.eventMode = 'passive'
    this.backdrop.eventMode = 'static'
    this.backdrop.on('pointertap', () => this.host.onCancelTap())
    this.addChild(this.backdrop, this.body)
  }

  /** 窓を描き直す。`view` が空なら全体を隠し、入力も通す */
  update(view: MenuView, width: number, height: number): void {
    for (const c of this.body.removeChildren()) c.destroy({ children: true })
    this.visible = view.length > 0
    this.backdrop.clear()
    if (view.length === 0) {
      this.backdrop.hitArea = null
      return
    }
    // 窓の外のタップは全面で受けてキャンセルにする（下のコマンドに漏らさない）
    this.backdrop.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.001 })
    this.backdrop.hitArea = new Rectangle(0, 0, width, height)
    for (const v of view) {
      if (v.type === 'list') this.drawList(v)
      else this.drawTarget(v)
    }
  }

  private drawList(v: MenuListView): void {
    const win = new Container()
    win.alpha = v.active ? 1 : INACTIVE_ALPHA
    // 窓の中のタップは背景（キャンセル）へ届かせない
    win.eventMode = 'static'
    const panel = this.host.makePanel()
    win.addChild(panel)
    this.host.drawPanel(panel, v.rect.x, v.rect.y, v.rect.w, v.rect.h)
    for (const row of v.rows) {
      const color = row.disabled ? ROW_DISABLED_COLOR : ROW_COLOR
      const label = new PixiText({ text: row.label, style: this.styled(color) })
      label.anchor.set(0, 0.5)
      label.x = row.rect.x
      label.y = row.rect.y + row.rect.h / 2
      win.addChild(label)
      if (row.cost) {
        const cost = new PixiText({ text: row.cost, style: this.styled(color) })
        cost.anchor.set(1, 0.5)
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
  }

  private moreMark(mark: string, x: number, y: number, anchorY: number): PixiText {
    const t = new PixiText({ text: mark, style: this.styled(MORE_MARK_COLOR, 10) })
    t.anchor.set(1, anchorY)
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
