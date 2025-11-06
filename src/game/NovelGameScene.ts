import Phaser from 'phaser'
import { ScriptRow } from '../types'

export class NovelGameScene extends Phaser.Scene {
  private scriptData: ScriptRow[] = []
  private currentIndex = 0
  private textBox!: Phaser.GameObjects.Graphics
  private characterNameText!: Phaser.GameObjects.Text
  private expressionText!: Phaser.GameObjects.Text
  private dialogueText!: Phaser.GameObjects.Text
  private continueIndicator!: Phaser.GameObjects.Text
  private sceneCounterText!: Phaser.GameObjects.Text

  constructor() {
    super({ key: 'NovelGameScene' })
  }

  init(data: { scriptData: ScriptRow[]; startIndex?: number }) {
    this.scriptData = data.scriptData || []
    this.currentIndex = data.startIndex ?? 0
  }

  create() {
    const { width, height } = this.cameras.main

    // 背景グラデーション
    const gradient = this.add.graphics()
    gradient.fillGradientStyle(0x667eea, 0x667eea, 0x764ba2, 0x764ba2, 1)
    gradient.fillRect(0, 0, width, height)

    // キャラクター表示エリア
    const characterY = height * 0.4

    this.characterNameText = this.add
      .text(width / 2, characterY, '', {
        fontSize: '48px',
        color: '#ffffff',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 4,
        shadow: {
          offsetX: 2,
          offsetY: 2,
          color: '#000000',
          blur: 4,
          fill: true,
        },
      })
      .setOrigin(0.5)

    this.expressionText = this.add
      .text(width / 2, characterY + 60, '', {
        fontSize: '24px',
        color: '#a8dadc',
        fontStyle: 'italic',
      })
      .setOrigin(0.5)

    // テキストボックス
    const textBoxY = height - 200
    this.textBox = this.add.graphics()
    this.textBox.fillStyle(0x000000, 0.8)
    this.textBox.fillRoundedRect(20, textBoxY, width - 40, 180, 10)

    this.textBox.lineStyle(3, 0xf1faee, 1)
    this.textBox.strokeRoundedRect(20, textBoxY, width - 40, 180, 10)

    // セリフテキスト
    this.dialogueText = this.add.text(50, textBoxY + 30, '', {
      fontSize: '20px',
      color: '#ffffff',
      wordWrap: { width: width - 100 },
      lineSpacing: 8,
    })

    // 続きインジケーター
    this.continueIndicator = this.add
      .text(width - 60, height - 40, '▼', {
        fontSize: '28px',
        color: '#a8dadc',
      })
      .setOrigin(0.5)

    // アニメーション
    this.tweens.add({
      targets: this.continueIndicator,
      y: height - 35,
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })

    // シーンカウンター
    this.sceneCounterText = this.add
      .text(width - 20, 20, '', {
        fontSize: '18px',
        color: '#a8dadc',
        fontStyle: 'bold',
      })
      .setOrigin(1, 0)

    // クリックイベント
    this.input.on('pointerdown', () => {
      this.nextScene()
    })

    // キーボードイベント
    this.input.keyboard?.on('keydown-SPACE', () => {
      this.nextScene()
    })
    this.input.keyboard?.on('keydown-ENTER', () => {
      this.nextScene()
    })
    this.input.keyboard?.on('keydown-LEFT', () => {
      this.previousScene()
    })
    this.input.keyboard?.on('keydown-RIGHT', () => {
      this.nextScene()
    })

    this.updateDisplay()
  }

  private updateDisplay() {
    if (this.currentIndex < 0 || this.currentIndex >= this.scriptData.length) {
      return
    }

    const scene = this.scriptData[this.currentIndex]

    this.characterNameText.setText(scene.character || '')
    this.expressionText.setText(scene.expression ? `(${scene.expression})` : '')
    this.dialogueText.setText(scene.text || '')
    this.sceneCounterText.setText(`${this.currentIndex + 1} / ${this.scriptData.length}`)
  }

  private nextScene() {
    if (this.currentIndex < this.scriptData.length - 1) {
      this.currentIndex++
      this.updateDisplay()
    }
  }

  private previousScene() {
    if (this.currentIndex > 0) {
      this.currentIndex--
      this.updateDisplay()
    }
  }
}
