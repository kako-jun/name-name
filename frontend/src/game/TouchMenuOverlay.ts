/**
 * RPG 向けのメニューオーバーレイ。
 *
 * 用途:
 * - #178 のシンプル版: 「はなす / とじる」を右下にポップアップさせる軽量メニュー
 * - #171 の DQ4 コマンドウィンドウ: 左上に 2×4 グリッドで 8 コマンドを並べ、選択した
 *   コマンドの右隣にサブメニューを開く（重ね方は後で実機調整、まずは動く形）
 *
 * 共通点: 「普段は隠れていてタップで出る、文字を直接タップして即決定（カーソル不要）」。
 * これは TouchMenuOverlay の根幹仕様。
 *
 * 違い: position（top-left / bottom-right）と layout（list / grid-2x4 / grid-4x2）と
 * submenu の有無。
 *
 * 仮想パッドは出さない方針 (#178)。サブメニューは 1 段のみ対応（多段化は将来 #173 や #174
 * の戦闘メニューを実装するときに拡張）。
 */

import { Container, Graphics, Rectangle, Text as PixiText, TextStyle } from 'pixi.js'
import { suppressNextTouchTap } from './touchInput'

export type MenuPosition = 'top-left' | 'bottom-right'
export type MenuLayout = 'list' | 'grid-4x2' | 'grid-2x4'

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
 * 順序は FC 版 DQ4 の実機どおり 2 列 x 4 行:
 *
 *   はなす / じゅもん
 *   つよさ / どうぐ
 *   そうび / さくせん
 *   とびら / しらべる
 *
 * `as const` で id を literal union として抽出できるよう書く。consumer 側
 * （TopDownRenderer / RaycastRenderer の handleMenuSelect の switch）で網羅検査ができる。
 */
export const DQ4_COMMANDS = [
  { id: 'talk', label: 'はなす' },
  {
    id: 'spell',
    label: 'じゅもん',
    submenu: [{ id: 'spell:none', label: '（なし）' }],
  },
  {
    id: 'status',
    label: 'つよさ',
    submenu: [{ id: 'status:hero', label: 'ゆうしゃ' }],
  },
  {
    id: 'item',
    label: 'どうぐ',
    submenu: [{ id: 'item:none', label: '（なし）' }],
  },
  {
    id: 'equip',
    label: 'そうび',
    submenu: [{ id: 'equip:hero', label: 'ゆうしゃ' }],
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
  { id: 'door', label: 'とびら' },
  { id: 'examine', label: 'しらべる' },
] as const satisfies ReadonlyArray<MenuItem>

/** DQ4_COMMANDS のメイン項目 id の literal union（consumer の switch で網羅検査するため） */
export type Dq4MainCommandId = (typeof DQ4_COMMANDS)[number]['id']

/** submenu を持つ要素だけ抜き出して、その submenu の leaf id を union 化する */
type Dq4WithSubmenu = Extract<(typeof DQ4_COMMANDS)[number], { submenu: ReadonlyArray<unknown> }>

/** DQ4_COMMANDS のサブメニュー leaf id の literal union（'tactics:bravely' 等） */
export type Dq4SubCommandId = Dq4WithSubmenu['submenu'][number]['id']

/** メイン + サブ全ての DQ4 コマンド id */
export type Dq4CommandId = Dq4MainCommandId | Dq4SubCommandId

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

/**
 * メインパネルの矩形を純関数で計算する。テスト容易性のため export する。
 *
 * 列数: layout='grid-4x2' で 4、'grid-2x4' で 2、それ以外で 1。
 * 行数は項目数 ÷ 列数の切り上げ。
 * 配置: top-left は (SCREEN_MARGIN, SCREEN_MARGIN) 起点、bottom-right は画面右下から逆算。
 */
export function computeMainPanelLayout(input: {
  screenWidth: number
  screenHeight: number
  itemCount: number
  /** items 中で最も幅広いテキストの実測 px。0 なら panel が縮退して PADDING_X*2 のみ */
  maxTextWidth: number
  position: MenuPosition
  layout: MenuLayout
}): {
  panelX: number
  panelY: number
  panelWidth: number
  panelHeight: number
  cellWidth: number
  cellHeight: number
  columns: number
} {
  const columns = input.layout === 'grid-4x2' ? 4 : input.layout === 'grid-2x4' ? 2 : 1
  const rows = Math.max(1, Math.ceil(input.itemCount / columns))
  const cellWidth = input.maxTextWidth + PADDING_X
  const cellHeight = ITEM_HEIGHT
  const panelWidth = columns * cellWidth + PADDING_X
  const panelHeight = rows * cellHeight + PADDING_Y * 2

  let panelX: number
  let panelY: number
  if (input.position === 'top-left') {
    panelX = SCREEN_MARGIN
    panelY = SCREEN_MARGIN
  } else {
    panelX = input.screenWidth - panelWidth - SCREEN_MARGIN
    panelY = input.screenHeight - panelHeight - SCREEN_MARGIN
  }

  return { panelX, panelY, panelWidth, panelHeight, cellWidth, cellHeight, columns }
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
      hit.on('pointerdown', () => suppressNextTouchTap())
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
      hit.on('pointerdown', () => suppressNextTouchTap())
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
    // 多段サブメニューは現状未対応。サブ leaf 扱いで onSelect を一括発火する。
    // sub.submenu があっても無視する（呼び出し側が leaf id だけ気にすれば良い設計に倒す）。
    // 多段化が必要になったら #173/#174 戦闘メニュー実装時にネスト管理を追加する。
    this.onSelect(sub.id)
    this.hideMenu()
  }

  // ===== レイアウト計算 =====

  private layout(): void {
    if (this.items.length === 0) {
      this.bgPanel.clear()
      return
    }

    const maxTextWidth = Math.max(...this.items.map((n) => n.text.width))
    const { panelX, panelY, panelWidth, panelHeight, cellWidth, cellHeight, columns } =
      computeMainPanelLayout({
        screenWidth: this.screenWidth,
        screenHeight: this.screenHeight,
        itemCount: this.items.length,
        maxTextWidth,
        position: this.menuPosition,
        layout: this.layoutKind,
      })

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

  /** layout / layoutSubmenu の両方で再利用するための薄いラッパー */
  private computeMainPanel() {
    const maxTextWidth = Math.max(0, ...this.items.map((n) => n.text.width))
    return computeMainPanelLayout({
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      itemCount: this.items.length,
      maxTextWidth,
      position: this.menuPosition,
      layout: this.layoutKind,
    })
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
    // Y はメインの上端に揃え、下端はみ出しは上方向にスライドして吸収する。
    // それでも収まらない極小縦画面では SCREEN_MARGIN を侵食してでも上端に貼り付ける
    // （subY が負になることはない、最終的に max(SCREEN_MARGIN, ...) でクランプ）。
    const screenAvailable = this.screenHeight - SCREEN_MARGIN
    let subY = main.panelY
    if (subY + subPanelHeight > screenAvailable) {
      subY = screenAvailable - subPanelHeight
    }
    if (subY < SCREEN_MARGIN) {
      subY = SCREEN_MARGIN
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
