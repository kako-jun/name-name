/**
 * 装備変更画面 (#207)。
 *
 * フィールド画面の上にオーバーレイで表示する。「そうび → ゆうしゃ」から起動。
 *
 * レイアウト:
 *
 *   +---------------------------------------+
 *   |              ゆうしゃ                  |
 *   +---------------------------------------+
 *   |  武器  : どうのつるぎ     [変更]      |
 *   |  防具  :  (なし)          [変更]      |
 *   |  盾    : きのたて         [変更]      |
 *   |  兜    :  (なし)          [変更]      |
 *   +---------------------------------------+
 *   |                            [閉じる]   |
 *   +---------------------------------------+
 *
 * 「変更」タップで該当スロットの装備可能アイテム一覧をポップアップ。
 * 「外す」も選択肢に含む。アイテム選択で equip + ポップアップ閉じる。
 * スワイプ・キーボード対応は省略（最小 UX、タップ専用）。
 */

import { Container, Graphics, Rectangle, Text as PixiText, TextStyle } from 'pixi.js'
import type { ItemDef, PartyMemberDef } from '../types'
import {
  ALL_EQUIPMENT_SLOTS,
  equipItem,
  getEquippedItem,
  getEquippableItems,
  unequipItem,
  type EquipmentSlot,
  type MemberEquipment,
} from './equipmentState'

const DIM_ALPHA = 0.65
const PANEL_BG = 0x000000
const PANEL_BG_ALPHA = 0.92
const PANEL_STROKE = 0xffffff
const TEXT_COLOR = 0xffffff
const HOVER_BG = 0x444466

const TITLE_FONT_SIZE = 22
const ROW_FONT_SIZE = 18
const BUTTON_FONT_SIZE = 18

const TEXT_STYLE_TITLE = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: TITLE_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_ROW = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: ROW_FONT_SIZE,
  fill: TEXT_COLOR,
})
const TEXT_STYLE_BUTTON = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: BUTTON_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})

/** スロット名の日本語表記（UI 表示用） */
export const SLOT_LABEL_JA: Record<EquipmentSlot, string> = {
  weapon: '武器',
  armor: '防具',
  shield: '盾',
  helmet: '兜',
}

/** EquipmentScreen のレイアウト寸法。純粋関数で計算してユニットテスト可能にする (#207) */
export interface EquipmentLayout {
  panel: { x: number; y: number; width: number; height: number }
  title: { x: number; y: number }
  rows: Array<{ y: number; labelX: number; valueX: number; buttonX: number }>
  rowHeight: number
  closeButton: { x: number; y: number; width: number; height: number }
  popup: { x: number; y: number; width: number; height: number; itemHeight: number }
}

const PANEL_MARGIN = 32
const ROW_HEIGHT = 40
const TITLE_HEIGHT = 56
const FOOTER_HEIGHT = 56
const POPUP_ITEM_HEIGHT = 36
const POPUP_MAX_VISIBLE = 8

/**
 * 画面サイズから EquipmentScreen のレイアウトを計算する。
 *
 * パネルは画面中央に固定幅 480px（または画面幅 - 64px の小さい方）。
 * 4 行 + タイトル + フッター。ポップアップはパネル内に被せて中央配置。
 */
export function computeEquipmentLayout(screenWidth: number, screenHeight: number): EquipmentLayout {
  const panelWidth = Math.min(480, Math.max(280, screenWidth - PANEL_MARGIN * 2))
  const rowsTotal = ROW_HEIGHT * ALL_EQUIPMENT_SLOTS.length
  const panelHeight = TITLE_HEIGHT + rowsTotal + FOOTER_HEIGHT
  const panelX = Math.floor((screenWidth - panelWidth) / 2)
  const panelY = Math.floor((screenHeight - panelHeight) / 2)

  const rows = ALL_EQUIPMENT_SLOTS.map((_slot, i) => {
    const y = panelY + TITLE_HEIGHT + i * ROW_HEIGHT
    return {
      y,
      labelX: panelX + 20,
      valueX: panelX + 90,
      buttonX: panelX + panelWidth - 80,
    }
  })

  return {
    panel: { x: panelX, y: panelY, width: panelWidth, height: panelHeight },
    title: { x: panelX + Math.floor(panelWidth / 2), y: panelY + 20 },
    rows,
    rowHeight: ROW_HEIGHT,
    closeButton: {
      x: panelX + panelWidth - 90,
      y: panelY + panelHeight - 44,
      width: 80,
      height: 36,
    },
    popup: {
      x: panelX + 24,
      y: panelY + TITLE_HEIGHT,
      width: panelWidth - 48,
      height: Math.min(POPUP_MAX_VISIBLE, 6) * POPUP_ITEM_HEIGHT + 16,
      itemHeight: POPUP_ITEM_HEIGHT,
    },
  }
}

/** 装備が変わったときに呼ぶコールバック。memberId とその直後の equipment を渡す */
export type EquipChangeHandler = (memberId: string, equipment: MemberEquipment) => void

export interface EquipmentScreenOptions {
  /** 装備変更時のコールバック */
  onEquipChanged?: EquipChangeHandler
  /** 「閉じる」タップ時のコールバック */
  onClose?: () => void
}

export class EquipmentScreen extends Container {
  private screenWidth: number
  private screenHeight: number
  private opts: EquipmentScreenOptions

  private masterItems: Record<string, ItemDef>
  private masterParty: Record<string, PartyMemberDef>
  private partyEquipment: Map<string, MemberEquipment>

  private dim: Graphics
  private panel: Graphics
  private popup: Container | null = null
  private currentMemberId: string | null = null

  constructor(
    screenWidth: number,
    screenHeight: number,
    masterItems: Record<string, ItemDef>,
    masterParty: Record<string, PartyMemberDef>,
    partyEquipment: Map<string, MemberEquipment>,
    opts: EquipmentScreenOptions = {}
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.masterItems = masterItems
    this.masterParty = masterParty
    this.partyEquipment = partyEquipment
    this.opts = opts

    this.dim = new Graphics()
    this.panel = new Graphics()
    this.addChild(this.dim)
    this.addChild(this.panel)
    this.visible = false
  }

  /** 装備画面を表示する。memberId は masterParty にあるパーティメンバー ID */
  show(memberId: string): void {
    if (!this.masterParty[memberId]) {
      console.warn(`[EquipmentScreen] unknown memberId '${memberId}', ignoring`)
      return
    }
    this.currentMemberId = memberId
    this.visible = true
    this.rebuild()
  }

  hide(): void {
    this.visible = false
    this.currentMemberId = null
    this.closePopup()
  }

  /** 親レイアウトが変わったとき呼ぶ */
  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    if (this.visible) this.rebuild()
  }

  /** 現在開いている画面の equipment を返す（テスト・debug 用） */
  getCurrentEquipment(): MemberEquipment | null {
    if (!this.currentMemberId) return null
    return this.partyEquipment.get(this.currentMemberId) ?? null
  }

  private rebuild(): void {
    // 既存子要素（dim / panel 以外）をクリア
    for (let i = this.children.length - 1; i >= 0; i--) {
      const child = this.children[i]
      if (child !== this.dim && child !== this.panel) {
        this.removeChild(child)
        child.destroy({ children: true })
      }
    }
    this.popup = null

    const memberId = this.currentMemberId
    if (!memberId) return
    const member = this.masterParty[memberId]
    if (!member) return

    const layout = computeEquipmentLayout(this.screenWidth, this.screenHeight)

    // 暗いオーバーレイ
    this.dim.clear()
    this.dim.rect(0, 0, this.screenWidth, this.screenHeight).fill({
      color: 0x000000,
      alpha: DIM_ALPHA,
    })
    // dim 自体をタップ無効化（ポップアップで使うので panel 外をふさぐ）
    this.dim.eventMode = 'static'
    this.dim.hitArea = new Rectangle(0, 0, this.screenWidth, this.screenHeight)

    // パネル
    this.panel.clear()
    this.panel
      .rect(layout.panel.x, layout.panel.y, layout.panel.width, layout.panel.height)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ width: 2, color: PANEL_STROKE })

    // タイトル
    const title = new PixiText({ text: member.name, style: TEXT_STYLE_TITLE })
    title.anchor.set(0.5, 0)
    title.x = layout.title.x
    title.y = layout.title.y
    this.addChild(title)

    // 4 スロット行
    const equipment = this.partyEquipment.get(memberId) ?? {}
    for (let i = 0; i < ALL_EQUIPMENT_SLOTS.length; i++) {
      const slot = ALL_EQUIPMENT_SLOTS[i]
      const row = layout.rows[i]

      const label = new PixiText({ text: SLOT_LABEL_JA[slot], style: TEXT_STYLE_ROW })
      label.x = row.labelX
      label.y = row.y + 8
      this.addChild(label)

      const equipped = getEquippedItem(equipment, slot, this.masterItems)
      const valueText = equipped ? equipped.name : '（なし）'
      const value = new PixiText({ text: valueText, style: TEXT_STYLE_ROW })
      value.x = row.valueX
      value.y = row.y + 8
      this.addChild(value)

      const changeBtn = this.makeButton('変更', () => this.openPopup(slot))
      changeBtn.x = row.buttonX
      changeBtn.y = row.y + 4
      this.addChild(changeBtn)
    }

    // 閉じるボタン
    const closeBtn = this.makeButton('閉じる', () => {
      this.hide()
      this.opts.onClose?.()
    })
    closeBtn.x = layout.closeButton.x
    closeBtn.y = layout.closeButton.y
    this.addChild(closeBtn)
  }

  /** 装備候補ポップアップを開く */
  private openPopup(slot: EquipmentSlot): void {
    this.closePopup()
    const memberId = this.currentMemberId
    if (!memberId) return

    const layout = computeEquipmentLayout(this.screenWidth, this.screenHeight)
    const items = getEquippableItems(memberId, slot, this.masterItems)
    const itemHeight = layout.popup.itemHeight
    // 「外す」を 1 件挿入するので +1
    const rowCount = items.length + 1
    const popupHeight = Math.min(POPUP_MAX_VISIBLE, rowCount) * itemHeight + 16
    const popupWidth = layout.popup.width

    const popup = new Container()
    const bg = new Graphics()
    bg.rect(layout.popup.x, layout.popup.y, popupWidth, popupHeight)
      .fill({ color: 0x111122, alpha: 0.98 })
      .stroke({ width: 2, color: PANEL_STROKE })
    bg.eventMode = 'static'
    bg.hitArea = new Rectangle(layout.popup.x, layout.popup.y, popupWidth, popupHeight)
    popup.addChild(bg)

    const rows: Array<{ label: string; onTap: () => void }> = [
      {
        label: '（外す）',
        onTap: () => {
          this.applyChange((eq) => unequipItem(eq, slot))
        },
      },
      ...items.map((item) => ({
        label: this.formatItemLabel(item),
        onTap: () => this.applyChange((eq) => equipItem(eq, slot, item.id)),
      })),
    ]

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const y = layout.popup.y + 8 + i * itemHeight
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.hitArea = new Rectangle(layout.popup.x + 4, y, popupWidth - 8, itemHeight)
      hit.on('pointertap', () => row.onTap())
      const hover = new Graphics()
      const drawHover = (alpha: number): void => {
        hover.clear()
        if (alpha > 0) {
          hover
            .rect(layout.popup.x + 4, y, popupWidth - 8, itemHeight)
            .fill({ color: HOVER_BG, alpha })
        }
      }
      hit.on('pointerover', () => drawHover(0.6))
      hit.on('pointerout', () => drawHover(0))
      const text = new PixiText({ text: row.label, style: TEXT_STYLE_ROW })
      text.x = layout.popup.x + 16
      text.y = y + 6
      popup.addChild(hover)
      popup.addChild(hit)
      popup.addChild(text)
    }

    this.addChild(popup)
    this.popup = popup
  }

  private closePopup(): void {
    if (this.popup) {
      this.removeChild(this.popup)
      this.popup.destroy({ children: true })
      this.popup = null
    }
  }

  /**
   * 装備変更を不変更新で反映し、コールバックを発火する。
   * 装備行の再描画も rebuild() で行う。
   */
  private applyChange(mutator: (eq: MemberEquipment) => MemberEquipment): void {
    const memberId = this.currentMemberId
    if (!memberId) return
    const prev = this.partyEquipment.get(memberId) ?? {}
    const next = mutator(prev)
    this.partyEquipment.set(memberId, next)
    this.opts.onEquipChanged?.(memberId, next)
    this.closePopup()
    this.rebuild()
  }

  /** アイテムの表示ラベル（名前 + bonus 表示） */
  private formatItemLabel(item: ItemDef): string {
    const parts: string[] = [item.name]
    if (typeof item.atk_bonus === 'number') {
      parts.push(item.atk_bonus >= 0 ? `+${item.atk_bonus}攻` : `${item.atk_bonus}攻`)
    }
    if (typeof item.def_bonus === 'number') {
      parts.push(item.def_bonus >= 0 ? `+${item.def_bonus}守` : `${item.def_bonus}守`)
    }
    return parts.join(' ')
  }

  /** ボタン用の小さなヘルパー。背景 + ラベル + tap 領域を 1 個の Container にまとめる */
  private makeButton(label: string, onTap: () => void): Container {
    const c = new Container()
    const bg = new Graphics()
    bg.rect(0, 0, 80, 36).fill({ color: 0x223344 }).stroke({ width: 1, color: PANEL_STROKE })
    const text = new PixiText({ text: label, style: TEXT_STYLE_BUTTON })
    text.anchor.set(0.5, 0.5)
    text.x = 40
    text.y = 18
    c.addChild(bg)
    c.addChild(text)
    c.eventMode = 'static'
    c.cursor = 'pointer'
    c.hitArea = new Rectangle(0, 0, 80, 36)
    c.on('pointertap', onTap)
    return c
  }
}
