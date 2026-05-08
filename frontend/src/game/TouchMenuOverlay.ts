/**
 * RPG 向けのメニューオーバーレイ。
 *
 * 用途:
 * - #178 のシンプル版: 「はなす / とじる」を右下にポップアップさせる軽量メニュー
 * - #171 の DQ4 コマンドウィンドウ: 左上に 4×2 グリッドで 8 コマンドを並べ、選択した
 *   コマンドの右隣にサブメニューを開く（重ね方は後で実機調整、まずは動く形）
 *
 * 共通点: 「普段は隠れていてタップで出る、文字を直接タップして即決定（カーソル不要）」。
 * これは TouchMenuOverlay の根幹仕様。
 *
 * 違い: position（top-left / bottom-right）と layout（list / grid-4x2）と submenu の有無。
 *
 * 仮想パッドは出さない方針 (#178)。サブメニューは 1 段のみ対応（多段化は将来 #173 や #174
 * の戦闘メニューを実装するときに拡張）。
 */

import { Container, Graphics, Rectangle, Text as PixiText, TextStyle } from 'pixi.js'

export type MenuPosition = 'top-left' | 'bottom-right'
export type MenuLayout = 'list' | 'grid-4x2'

/** メニュー項目。submenu 指定で 1 段だけサブメニューが出せる */
export interface MenuItem {
  id: string
  label: string
  submenu?: ReadonlyArray<MenuItem>
}

/** #178 で使った最小メニュー */
export const DEFAULT_MENU_ITEMS: ReadonlyArray<MenuItem> = [
  { id: 'talk', label: 'はなす' },
  { id: 'close', label: 'とじる' },
]

/**
 * #171 DQ4 ファミコン版相当の 8 コマンド。
 * 順序・サブメニュー内容はプレースホルダ。実装が進む（#172/#174/#175）と中身が埋まる。
 */
export const DQ4_COMMANDS: ReadonlyArray<MenuItem> = [
  { id: 'talk', label: 'はなす' },
  {
    id: 'item',
    label: 'どうぐ',
    submenu: [{ id: 'item:none', label: '（なし）' }],
  },
  { id: 'examine', label: 'しらべる' },
  {
    id: 'status',
    label: 'つよさ',
    submenu: [{ id: 'status:hero', label: 'ゆうしゃ' }],
  },
  {
    id: 'tactics',
    label: 'さくせん',
    submenu: [
      { id: 'tactics:bravely', label: 'バッチリがんばれ' },
      { id: 'tactics:safely', label: 'いのちだいじに' },
      { id: 'tactics:no-spell', label: 'じゅもんつかうな' },
    ],
  },
  {
    id: 'spell',
    label: 'じゅもん',
    submenu: [{ id: 'spell:none', label: '（なし）' }],
  },
  {
    id: 'equip',
    label: 'そうび',
    submenu: [{ id: 'equip:hero', label: 'ゆうしゃ' }],
  },
  { id: 'door', label: 'とびら' },
]

const PADDING_X = 16
const PADDING_Y = 12
const ITEM_HEIGHT = 36
const ITEM_FONT_SIZE = 20
const SCREEN_MARGIN = 24
const SUBMENU_GAP = 6

interface ItemNode {
  item: MenuItem
  hit: Container
  text: PixiText
}

/** 項目テキストスタイル（モジュール共有、setItems で new し直さない） */
const ITEM_TEXT_STYLE = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: ITEM_FONT_SIZE,
  fill: 0xffffff,
  fontWeight: 'bold',
})

export interface TouchMenuOptions {
  items?: ReadonlyArray<MenuItem>
  position?: MenuPosition
  layout?: MenuLayout
}

export class TouchMenuOverlay extends Container {
  private bgPanel: Graphics
  private items: ItemNode[] = []
  /** サブメニュー描画用の独立コンテナ（メインパネルの右隣に出す） */
  private subContainer: Container
  private subBgPanel: Graphics
  private subItems: ItemNode[] = []
  /** 現在開いているサブメニューの親項目 */
  private activeSubItem: MenuItem | null = null

  private screenWidth: number
  private screenHeight: number
  private onSelect: (id: string) => void
  // PIXI Container 側に position: ObservablePoint があるため、別名で持つ
  private menuPosition: MenuPosition
  private layoutKind: MenuLayout

  constructor(
    screenWidth: number,
    screenHeight: number,
    onSelect: (id: string) => void,
    options: TouchMenuOptions = {}
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.onSelect = onSelect
    this.menuPosition = options.position ?? 'bottom-right'
    this.layoutKind = options.layout ?? 'list'

    this.bgPanel = new Graphics()
    this.addChild(this.bgPanel)

    this.subContainer = new Container()
    this.subContainer.visible = false
    this.subBgPanel = new Graphics()
    this.subContainer.addChild(this.subBgPanel)
    this.addChild(this.subContainer)

    this.setItems(options.items ?? DEFAULT_MENU_ITEMS)
    this.visible = false
  }

  setItems(items: ReadonlyArray<MenuItem>): void {
    this.closeSubmenu()
    for (const node of this.items) {
      this.removeChild(node.hit)
      this.removeChild(node.text)
      node.hit.destroy()
      node.text.destroy()
    }
    this.items = []

    for (const item of items) {
      const text = new PixiText({ text: item.label, style: ITEM_TEXT_STYLE })
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointertap', () => this.handleItemTap(item))
      this.addChild(hit)
      this.addChild(text)
      // bg より上、subContainer より下になるよう subContainer を最後に再 addChild
      this.items.push({ item, hit, text })
    }
    // サブコンテナを最前面に保つ
    this.removeChild(this.subContainer)
    this.addChild(this.subContainer)
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
    this.closeSubmenu()
    this.visible = false
    this.eventMode = 'none'
  }

  isShowing(): boolean {
    return this.visible
  }

  /**
   * メイン項目をタップしたときの振る舞い:
   * - submenu があれば開く（メインパネルは出したまま）
   * - submenu が無ければ onSelect を呼んでメニューを閉じる
   */
  private handleItemTap(item: MenuItem): void {
    if (item.submenu && item.submenu.length > 0) {
      this.openSubmenu(item)
    } else {
      this.onSelect(item.id)
      this.hideMenu()
    }
  }

  private openSubmenu(parent: MenuItem): void {
    if (!parent.submenu) return
    this.closeSubmenu()
    this.activeSubItem = parent

    for (const sub of parent.submenu) {
      const text = new PixiText({ text: sub.label, style: ITEM_TEXT_STYLE })
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointertap', () => this.handleSubItemTap(sub))
      this.subContainer.addChild(hit)
      this.subContainer.addChild(text)
      this.subItems.push({ item: sub, hit, text })
    }
    this.subContainer.visible = true
    this.layoutSubmenu()
  }

  private closeSubmenu(): void {
    for (const node of this.subItems) {
      this.subContainer.removeChild(node.hit)
      this.subContainer.removeChild(node.text)
      node.hit.destroy()
      node.text.destroy()
    }
    this.subItems = []
    this.activeSubItem = null
    this.subContainer.visible = false
    this.subBgPanel.clear()
  }

  private handleSubItemTap(sub: MenuItem): void {
    // サブの先にさらに submenu があれば開く（多段は将来）。今は 1 段で打ち止め。
    if (sub.submenu && sub.submenu.length > 0) {
      // 仮: 多段サブメニューは未対応。タップで上書きせずに親 submenu を差し替える
      this.openSubmenu(sub)
      return
    }
    this.onSelect(sub.id)
    this.hideMenu()
  }

  // ===== レイアウト計算 =====

  private layout(): void {
    if (this.items.length === 0) {
      this.bgPanel.clear()
      return
    }

    const { panelX, panelY, panelWidth, panelHeight, cellWidth, cellHeight, columns } =
      this.computeMainPanel()

    this.bgPanel.clear()
    this.bgPanel.roundRect(panelX, panelY, panelWidth, panelHeight, 6)
    this.bgPanel.fill({ color: 0x000000, alpha: 0.78 })
    this.bgPanel.stroke({ color: 0xffffff, width: 2 })

    for (let i = 0; i < this.items.length; i++) {
      const node = this.items[i]
      const col = i % columns
      const row = Math.floor(i / columns)
      const cellX = panelX + PADDING_X + col * cellWidth
      const cellY = panelY + PADDING_Y + row * cellHeight
      node.hit.hitArea = new Rectangle(cellX, cellY, cellWidth, cellHeight)
      node.text.x = cellX
      node.text.y = cellY + (cellHeight - node.text.height) / 2
    }

    if (this.activeSubItem) this.layoutSubmenu()
  }

  private computeMainPanel(): {
    panelX: number
    panelY: number
    panelWidth: number
    panelHeight: number
    cellWidth: number
    cellHeight: number
    columns: number
  } {
    let maxTextWidth = 0
    for (const node of this.items) {
      maxTextWidth = Math.max(maxTextWidth, node.text.width)
    }

    const columns = this.layoutKind === 'grid-4x2' ? 4 : 1
    const rows = Math.ceil(this.items.length / columns)
    const cellWidth = maxTextWidth + PADDING_X
    const cellHeight = ITEM_HEIGHT
    const panelWidth = columns * cellWidth + PADDING_X
    const panelHeight = rows * cellHeight + PADDING_Y * 2

    let panelX: number
    let panelY: number
    if (this.menuPosition === 'top-left') {
      panelX = SCREEN_MARGIN
      panelY = SCREEN_MARGIN
    } else {
      panelX = this.screenWidth - panelWidth - SCREEN_MARGIN
      panelY = this.screenHeight - panelHeight - SCREEN_MARGIN
    }

    return { panelX, panelY, panelWidth, panelHeight, cellWidth, cellHeight, columns }
  }

  /**
   * サブメニューはメインパネルの右隣（top-left 時）/ 左隣（bottom-right 時）に出す。
   * 画面端をはみ出す場合は反対側に折り返す。
   *
   * 重なり方は #171 で「サブメニュー stack を完全再現したい」とコメントあり。
   * 現状の実装は最低限「メインの隣に独立パネルを並べる」だけで、DQ4 のサブが
   * メインに重なる（サブが手前で一部被る）挙動は未対応。後で訂正する前提で
   * シンプル並列にしている。
   */
  private layoutSubmenu(): void {
    if (!this.activeSubItem || this.subItems.length === 0) return
    const main = this.computeMainPanel()

    let maxSubTextWidth = 0
    for (const node of this.subItems) {
      maxSubTextWidth = Math.max(maxSubTextWidth, node.text.width)
    }
    const subCellWidth = maxSubTextWidth + PADDING_X
    const subPanelWidth = subCellWidth + PADDING_X
    const subPanelHeight = this.subItems.length * ITEM_HEIGHT + PADDING_Y * 2

    // サブパネルの優先位置: メインの右隣（top-left）/ 左隣（bottom-right）
    let subX: number
    if (this.menuPosition === 'top-left') {
      subX = main.panelX + main.panelWidth + SUBMENU_GAP
      // 右側にはみ出すなら左に折り返す
      if (subX + subPanelWidth > this.screenWidth - SCREEN_MARGIN) {
        subX = main.panelX - subPanelWidth - SUBMENU_GAP
      }
    } else {
      subX = main.panelX - subPanelWidth - SUBMENU_GAP
      if (subX < SCREEN_MARGIN) {
        subX = main.panelX + main.panelWidth + SUBMENU_GAP
      }
    }
    let subY = main.panelY
    // 下にはみ出す場合は上方向にスライド
    if (subY + subPanelHeight > this.screenHeight - SCREEN_MARGIN) {
      subY = Math.max(SCREEN_MARGIN, this.screenHeight - SCREEN_MARGIN - subPanelHeight)
    }

    this.subBgPanel.clear()
    this.subBgPanel.roundRect(subX, subY, subPanelWidth, subPanelHeight, 6)
    this.subBgPanel.fill({ color: 0x000000, alpha: 0.85 })
    this.subBgPanel.stroke({ color: 0xffffff, width: 2 })

    for (let i = 0; i < this.subItems.length; i++) {
      const node = this.subItems[i]
      const cellY = subY + PADDING_Y + i * ITEM_HEIGHT
      node.hit.hitArea = new Rectangle(subX, cellY, subPanelWidth, ITEM_HEIGHT)
      node.text.x = subX + PADDING_X
      node.text.y = cellY + (ITEM_HEIGHT - node.text.height) / 2
    }
  }
}
