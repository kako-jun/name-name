/**
 * RPG 向けの簡易メニューオーバーレイ (#178)。
 *
 * 仮想パッドではなく、画面上のテキスト項目を直接タップして選択する DQ 風のメニュー。
 * 現状は「はなす」「とじる」の 2 項目のみ。コマンドウィンドウ（#171）が実装されたら
 * そちらに統合・差し替えされる前提で、最小限の独立 UI として置く。
 *
 * - 画面右下に縦並びでテキスト項目を表示
 * - 各項目はクリック / タップで onSelect コールバックを発火
 * - showMenu() / hideMenu() で表示制御。表示中は eventMode='static' でヒットテストを有効化
 *
 * TopDownRenderer / RaycastRenderer の dialogBox の上に乗せる前提（addChild の順序で zIndex を制御）。
 */

import { Container, Graphics, Rectangle, Text as PixiText, TextStyle } from 'pixi.js'

export type MenuItemId = 'talk' | 'close'

export interface MenuItem {
  id: MenuItemId
  label: string
}

export const DEFAULT_MENU_ITEMS: ReadonlyArray<MenuItem> = [
  { id: 'talk', label: 'はなす' },
  { id: 'close', label: 'とじる' },
]

const PADDING_X = 20
const PADDING_Y = 14
const ITEM_HEIGHT = 44
const ITEM_FONT_SIZE = 22
const RIGHT_MARGIN = 24
const BOTTOM_MARGIN = 24

interface ItemNode {
  item: MenuItem
  /** タップ判定領域。透明 Container に hitArea を持たせる（描画コストなし） */
  hit: Container
  text: PixiText
}

/**
 * 全項目で共有するテキストスタイル。setItems 毎に new TextStyle するのは無駄なので
 * モジュール定数として 1 個だけ持つ（Pixi 内部で文字メトリクス計算が走る単位）。
 */
const ITEM_TEXT_STYLE = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: ITEM_FONT_SIZE,
  fill: 0xffffff,
  fontWeight: 'bold',
})

export class TouchMenuOverlay extends Container {
  private bgPanel: Graphics
  private items: ItemNode[] = []
  private screenWidth: number
  private screenHeight: number
  private onSelect: (id: MenuItemId) => void

  constructor(
    screenWidth: number,
    screenHeight: number,
    onSelect: (id: MenuItemId) => void,
    initialItems: ReadonlyArray<MenuItem> = DEFAULT_MENU_ITEMS
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.onSelect = onSelect
    this.bgPanel = new Graphics()
    this.addChild(this.bgPanel)
    this.setItems(initialItems)
    this.visible = false
  }

  setItems(items: ReadonlyArray<MenuItem>): void {
    // 既存ノードを破棄
    for (const node of this.items) {
      this.removeChild(node.hit)
      this.removeChild(node.text)
      node.hit.destroy()
      node.text.destroy()
    }
    this.items = []

    for (const item of items) {
      const text = new PixiText({ text: item.label, style: ITEM_TEXT_STYLE })
      // hitArea を持つ透明 Container でタップを受ける（描画なし、Graphics の塗り不要）
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointertap', () => {
        this.onSelect(item.id)
      })
      this.addChild(hit)
      this.addChild(text)
      this.items.push({ item, hit, text })
    }
    this.layout()
  }

  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.layout()
  }

  showMenu(): void {
    this.visible = true
    this.eventMode = 'static'
  }

  hideMenu(): void {
    this.visible = false
    this.eventMode = 'none'
  }

  isShowing(): boolean {
    return this.visible
  }

  private layout(): void {
    if (this.items.length === 0) {
      this.bgPanel.clear()
      return
    }

    // パネル幅: 最も長い項目に合わせて余白を足す
    let maxTextWidth = 0
    for (const node of this.items) {
      maxTextWidth = Math.max(maxTextWidth, node.text.width)
    }
    const panelWidth = maxTextWidth + PADDING_X * 2
    const panelHeight = this.items.length * ITEM_HEIGHT + PADDING_Y * 2

    const panelX = this.screenWidth - panelWidth - RIGHT_MARGIN
    const panelY = this.screenHeight - panelHeight - BOTTOM_MARGIN

    // 半透明黒背景 + 白枠（DQ 風）
    this.bgPanel.clear()
    this.bgPanel.roundRect(panelX, panelY, panelWidth, panelHeight, 6)
    this.bgPanel.fill({ color: 0x000000, alpha: 0.78 })
    this.bgPanel.stroke({ color: 0xffffff, width: 2 })

    // 各項目: hit area 矩形（描画なし）+ テキスト配置
    for (let i = 0; i < this.items.length; i++) {
      const node = this.items[i]
      const itemY = panelY + PADDING_Y + i * ITEM_HEIGHT
      node.hit.hitArea = new Rectangle(panelX, itemY, panelWidth, ITEM_HEIGHT)
      node.text.x = panelX + PADDING_X
      node.text.y = itemY + (ITEM_HEIGHT - node.text.height) / 2
    }
  }
}
