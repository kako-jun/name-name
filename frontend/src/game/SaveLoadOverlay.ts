/**
 * セーブ/ロードメニューUI
 *
 * PixiJS Container で3スロットを縦に並べ、セーブ/ロードを行う。
 * エクスポート/インポートボタンも表示する。
 */

import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'
import { SaveManager, SaveSlotData } from './SaveManager'

const SLOT_WIDTH = 520
const SLOT_HEIGHT = 72
const SLOT_GAP = 16
const SLOT_RADIUS = 8
const BUTTON_WIDTH = 200
const BUTTON_HEIGHT = 44
const BUTTON_GAP = 16

const NORMAL_COLOR = 0x1a1a2e
const HOVER_COLOR = 0x16213e
const BORDER_COLOR = 0xa8dadc
const HOVER_BORDER_COLOR = 0xf1faee
const EMPTY_TEXT_COLOR = 0x666666
const OVERLAY_ALPHA = 0.7

export class SaveLoadOverlay extends Container {
  private screenWidth: number
  private screenHeight: number
  private mode: 'save' | 'load' = 'save'
  private saveManager: SaveManager
  private onSave: ((slot: number) => void) | null = null
  private onLoad: ((data: SaveSlotData) => void) | null = null

  constructor(screenWidth: number, screenHeight: number, saveManager: SaveManager) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.saveManager = saveManager
    this.eventMode = 'static'
    this.visible = false
  }

  /**
   * セーブモードで表示する
   */
  showSave(onSave: (slot: number) => void): void {
    this.mode = 'save'
    this.onSave = onSave
    this.onLoad = null
    this.rebuild()
    this.visible = true
  }

  /**
   * ロードモードで表示する
   */
  showLoad(onLoad: (data: SaveSlotData) => void): void {
    this.mode = 'load'
    this.onLoad = onLoad
    this.onSave = null
    this.rebuild()
    this.visible = true
  }

  /**
   * メニューを閉じる
   */
  hide(): void {
    this.visible = false
    this.removeChildren()
    this.onSave = null
    this.onLoad = null
  }

  private rebuild(): void {
    this.removeChildren()

    // 半透明黒背景
    const bg = new Graphics()
    bg.rect(0, 0, this.screenWidth, this.screenHeight)
    bg.fill({ color: 0x000000, alpha: OVERLAY_ALPHA })
    bg.eventMode = 'static'
    bg.on('pointerdown', (e) => e.stopPropagation())
    this.addChild(bg)

    // タイトル
    const titleStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 28,
      fill: 0xf1faee,
      fontWeight: 'bold',
    })
    const titleText = new PixiText({
      text: this.mode === 'save' ? 'SAVE' : 'LOAD',
      style: titleStyle,
    })
    titleText.x = this.screenWidth / 2
    titleText.y = 40
    titleText.anchor.set(0.5, 0)
    this.addChild(titleText)

    // スロット一覧
    const slots = this.saveManager.listSlots()
    const slotsStartY = 100

    const slotTextStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xf1faee,
    })
    const emptyTextStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: EMPTY_TEXT_COLOR,
    })

    for (let i = 0; i < 3; i++) {
      const slotData = slots[i]
      const slotContainer = new Container()
      slotContainer.eventMode = 'static'
      slotContainer.x = (this.screenWidth - SLOT_WIDTH) / 2
      slotContainer.y = slotsStartY + i * (SLOT_HEIGHT + SLOT_GAP)

      const isEmpty = slotData === null
      const isClickable = this.mode === 'save' || !isEmpty

      if (isClickable) {
        slotContainer.cursor = 'pointer'
      }

      const slotBg = new Graphics()
      this.drawSlot(slotBg, NORMAL_COLOR, BORDER_COLOR)
      slotContainer.addChild(slotBg)

      // スロット番号
      const numberText = new PixiText({
        text: `Slot ${i + 1}`,
        style: slotTextStyle,
      })
      numberText.x = 16
      numberText.y = 14
      slotContainer.addChild(numberText)

      if (isEmpty) {
        const emptyLabel = new PixiText({
          text: '--- 空きスロット ---',
          style: emptyTextStyle,
        })
        emptyLabel.x = 16
        emptyLabel.y = 42
        slotContainer.addChild(emptyLabel)
      } else {
        const sceneName = slotData.sceneName ?? '不明なシーン'
        const date = new Date(slotData.savedAt)
        const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

        const infoText = new PixiText({
          text: `${sceneName}    ${dateStr}`,
          style: slotTextStyle,
        })
        infoText.x = 16
        infoText.y = 42
        slotContainer.addChild(infoText)
      }

      if (isClickable) {
        slotContainer.on('pointerover', () => {
          slotBg.clear()
          this.drawSlot(slotBg, HOVER_COLOR, HOVER_BORDER_COLOR)
        })
        slotContainer.on('pointerout', () => {
          slotBg.clear()
          this.drawSlot(slotBg, NORMAL_COLOR, BORDER_COLOR)
        })
        slotContainer.on('pointerdown', (e) => {
          e.stopPropagation()
          if (this.mode === 'save') {
            this.onSave?.(i)
          } else if (slotData) {
            this.onLoad?.(slotData)
          }
          this.hide()
        })
      }

      this.addChild(slotContainer)
    }

    // エクスポート/インポートボタン
    const buttonY = slotsStartY + 3 * (SLOT_HEIGHT + SLOT_GAP) + 16
    const buttonTextStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: 0xf1faee,
      fontWeight: 'bold',
    })

    // エクスポートボタン
    const exportBtn = this.createButton('エクスポート', buttonTextStyle, () => {
      const json = this.saveManager.exportJSON()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'name-name-save.json'
      a.click()
      URL.revokeObjectURL(url)
    })
    exportBtn.x = this.screenWidth / 2 - BUTTON_WIDTH - BUTTON_GAP / 2
    exportBtn.y = buttonY
    this.addChild(exportBtn)

    // インポートボタン
    const importBtn = this.createButton('インポート', buttonTextStyle, () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          const text = reader.result as string
          const success = this.saveManager.importJSON(text)
          if (success) {
            this.rebuild()
          } else {
            console.warn('[name-name] セーブデータのインポートに失敗')
          }
        }
        reader.readAsText(file)
      }
      input.click()
    })
    importBtn.x = this.screenWidth / 2 + BUTTON_GAP / 2
    importBtn.y = buttonY
    this.addChild(importBtn)

    // 閉じるボタン
    const closeBtn = this.createButton('閉じる', buttonTextStyle, () => {
      this.hide()
    })
    closeBtn.x = (this.screenWidth - BUTTON_WIDTH) / 2
    closeBtn.y = buttonY + BUTTON_HEIGHT + BUTTON_GAP
    this.addChild(closeBtn)
  }

  private createButton(
    label: string,
    textStyle: TextStyle,
    onClick: () => void,
  ): Container {
    const container = new Container()
    container.eventMode = 'static'
    container.cursor = 'pointer'

    const bg = new Graphics()
    bg.roundRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, 6)
    bg.fill(NORMAL_COLOR)
    bg.stroke({ color: BORDER_COLOR, width: 2 })
    container.addChild(bg)

    const text = new PixiText({ text: label, style: textStyle })
    text.x = BUTTON_WIDTH / 2
    text.y = BUTTON_HEIGHT / 2
    text.anchor.set(0.5, 0.5)
    container.addChild(text)

    container.on('pointerover', () => {
      bg.clear()
      bg.roundRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, 6)
      bg.fill(HOVER_COLOR)
      bg.stroke({ color: HOVER_BORDER_COLOR, width: 2 })
    })
    container.on('pointerout', () => {
      bg.clear()
      bg.roundRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, 6)
      bg.fill(NORMAL_COLOR)
      bg.stroke({ color: BORDER_COLOR, width: 2 })
    })
    container.on('pointerdown', (e) => {
      e.stopPropagation()
      onClick()
    })

    return container
  }

  private drawSlot(g: Graphics, fillColor: number, borderColor: number): void {
    g.roundRect(0, 0, SLOT_WIDTH, SLOT_HEIGHT, SLOT_RADIUS)
    g.fill(fillColor)
    g.stroke({ color: borderColor, width: 2 })
  }
}
