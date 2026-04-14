import Phaser from 'phaser'
import { RPGProject, NPCData } from '../types/rpg'

interface NPC {
  sprite: Phaser.GameObjects.Rectangle
  x: number
  y: number
  message: string
  data: NPCData
}

export class RPGScene extends Phaser.Scene {
  private player?: Phaser.GameObjects.Container
  private playerSprite?: Phaser.GameObjects.Rectangle
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys
  private actionKey?: Phaser.Input.Keyboard.Key
  private playerGridX = 5
  private playerGridY = 5
  private tileSize = 32
  private readonly moveSpeed = 150
  private isMoving = false
  private playerDirection = 'down'

  // テキストウインドウ関連
  private textWindow?: Phaser.GameObjects.Container
  private textContent?: Phaser.GameObjects.Text
  private isShowingText = false
  private currentText = ''
  private fullText = ''
  private textIndex = 0
  private textTimer?: Phaser.Time.TimerEvent

  // マップとNPC
  private mapData: number[][] = []
  private npcs: NPC[] = []

  // タッチ/クリック操作
  private movePath: { x: number; y: number }[] = []
  private targetNPC: NPC | null = null

  // ゲームデータ
  private gameData?: RPGProject

  constructor() {
    super({ key: 'RPGScene' })
  }

  init(data: { gameData: RPGProject }) {
    // ゲームデータを受け取る
    this.gameData = data.gameData

    if (this.gameData) {
      // マップデータを設定
      this.mapData = this.gameData.map.tiles
      this.tileSize = this.gameData.map.tileSize

      // プレイヤー初期位置を設定
      this.playerGridX = this.gameData.player.x
      this.playerGridY = this.gameData.player.y
      this.playerDirection = this.gameData.player.direction
    }
  }

  preload() {
    // アセットがないので、スキップ
  }

  create() {
    // ゲームデータがない場合はデフォルトマップを使用
    if (!this.gameData) {
      console.warn('ゲームデータが見つかりません。デフォルトマップを使用します。')
      this.mapData = this.getDefaultMapData()
    }

    // 背景色
    this.cameras.main.setBackgroundColor('#1a4d1a')

    // マップを描画
    this.drawMap()

    // プレイヤーを作成
    this.createPlayer()

    // NPCを作成
    this.createNPCs()

    // テキストウインドウを作成
    this.createTextWindow()

    // 操作説明
    this.add
      .text(10, 10, '操作: タップで移動 / NPCをタップで会話', {
        fontSize: '14px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 5, y: 5 },
      })
      .setScrollFactor(0)
      .setDepth(100)

    // キーボード入力
    this.cursors = this.input.keyboard?.createCursorKeys()
    this.actionKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)

    // タッチ/クリック入力
    this.input.on('pointerdown', this.handlePointerDown, this)

    // カメラ設定
    const mapWidth = this.mapData[0].length * this.tileSize
    const mapHeight = this.mapData.length * this.tileSize
    this.cameras.main.setBounds(0, 0, mapWidth, mapHeight)
    this.cameras.main.startFollow(this.player!, true, 0.1, 0.1)
  }

  private drawMap() {
    const colors = {
      0: 0x2d5016, // 草地（濃い緑）
      1: 0x8b7355, // 道（茶色）
      2: 0x1a3a1a, // 木（暗い緑）
      3: 0x4169e1, // 水（青）
    }

    for (let y = 0; y < this.mapData.length; y++) {
      for (let x = 0; x < this.mapData[y].length; x++) {
        const tileType = this.mapData[y][x]
        const color = colors[tileType as keyof typeof colors]

        this.add
          .rectangle(
            x * this.tileSize + this.tileSize / 2,
            y * this.tileSize + this.tileSize / 2,
            this.tileSize,
            this.tileSize,
            color
          )
          .setStrokeStyle(1, 0x000000, 0.2)
      }
    }
  }

  private createPlayer() {
    const x = this.playerGridX * this.tileSize + this.tileSize / 2
    const y = this.playerGridY * this.tileSize + this.tileSize / 2

    this.player = this.add.container(x, y)

    // プレイヤーの見た目（青い四角）
    this.playerSprite = this.add.rectangle(0, 0, 28, 28, 0x0000ff)
    this.playerSprite.setStrokeStyle(2, 0x000080)

    // 向きを示す三角形
    const direction = this.add.triangle(0, 10, 0, 0, -5, 8, 5, 8, 0xffffff)

    this.player.add([this.playerSprite, direction])
    this.player.setDepth(10)
  }

  private createNPCs() {
    if (!this.gameData) return

    this.gameData.npcs.forEach(npcData => {
      const x = npcData.x * this.tileSize + this.tileSize / 2
      const y = npcData.y * this.tileSize + this.tileSize / 2

      const sprite = this.add.rectangle(x, y, 28, 28, npcData.color)
      sprite.setStrokeStyle(2, 0x8b0000)
      sprite.setDepth(5)

      this.npcs.push({
        sprite,
        x: npcData.x,
        y: npcData.y,
        message: npcData.message,
        data: npcData,
      })
    })
  }

  private createTextWindow() {
    const windowHeight = 120
    const windowY = 600 - windowHeight - 10

    this.textWindow = this.add.container(10, windowY)
    this.textWindow.setScrollFactor(0)
    this.textWindow.setDepth(1000)
    this.textWindow.setVisible(false)

    // ウインドウ背景
    const bg = this.add.rectangle(0, 0, 780, windowHeight, 0x000080)
    bg.setOrigin(0, 0)
    bg.setStrokeStyle(4, 0xffffff)

    // テキスト
    this.textContent = this.add.text(20, 20, '', {
      fontSize: '20px',
      color: '#ffffff',
      wordWrap: { width: 740 },
      lineSpacing: 8,
    })

    this.textWindow.add([bg, this.textContent])
  }

  private showText(text: string) {
    if (this.isShowingText) return

    this.isShowingText = true
    this.fullText = text
    this.currentText = ''
    this.textIndex = 0

    this.textWindow?.setVisible(true)

    // 1文字ずつ表示するタイマー
    this.textTimer = this.time.addEvent({
      delay: 50, // 50msごとに1文字
      callback: () => {
        if (this.textIndex < this.fullText.length) {
          this.currentText += this.fullText[this.textIndex]
          this.textContent?.setText(this.currentText)
          this.textIndex++
        } else {
          this.textTimer?.destroy()
        }
      },
      loop: true,
    })
  }

  private hideText() {
    // テキスト表示が終わっていない場合は、全文を一気に表示
    if (this.textIndex < this.fullText.length) {
      this.textTimer?.destroy()
      this.currentText = this.fullText
      this.textContent?.setText(this.currentText)
      this.textIndex = this.fullText.length
      return
    }

    // テキストを閉じる
    this.textWindow?.setVisible(false)
    this.isShowingText = false
    this.currentText = ''
    this.fullText = ''
    this.textIndex = 0
  }

  private checkNPCInteraction() {
    // プレイヤーの前方のタイルを計算
    let checkX = this.playerGridX
    let checkY = this.playerGridY

    switch (this.playerDirection) {
      case 'up':
        checkY -= 1
        break
      case 'down':
        checkY += 1
        break
      case 'left':
        checkX -= 1
        break
      case 'right':
        checkX += 1
        break
    }

    // NPCがいるかチェック
    const npc = this.npcs.find(n => n.x === checkX && n.y === checkY)
    if (npc) {
      this.showText(npc.message)
    }
  }

  private canMoveTo(gridX: number, gridY: number): boolean {
    // マップの範囲外チェック
    if (
      gridY < 0 ||
      gridY >= this.mapData.length ||
      gridX < 0 ||
      gridX >= this.mapData[0].length
    ) {
      return false
    }

    // 通行不可タイル（木と水）
    const tile = this.mapData[gridY][gridX]
    if (tile === 2 || tile === 3) {
      return false
    }

    // NPCがいるかチェック
    const hasNPC = this.npcs.some(npc => npc.x === gridX && npc.y === gridY)
    if (hasNPC) {
      return false
    }

    return true
  }

  private movePlayer(direction: string) {
    if (this.isMoving || this.isShowingText) return

    let newGridX = this.playerGridX
    let newGridY = this.playerGridY

    switch (direction) {
      case 'up':
        newGridY -= 1
        break
      case 'down':
        newGridY += 1
        break
      case 'left':
        newGridX -= 1
        break
      case 'right':
        newGridX += 1
        break
    }

    if (!this.canMoveTo(newGridX, newGridY)) {
      this.playerDirection = direction
      return
    }

    this.playerDirection = direction
    this.playerGridX = newGridX
    this.playerGridY = newGridY

    const targetX = newGridX * this.tileSize + this.tileSize / 2
    const targetY = newGridY * this.tileSize + this.tileSize / 2

    this.isMoving = true

    this.tweens.add({
      targets: this.player,
      x: targetX,
      y: targetY,
      duration: this.moveSpeed,
      ease: 'Linear',
      onComplete: () => {
        this.isMoving = false
      },
    })
  }

  update() {
    if (!this.cursors) return

    // テキスト表示中
    if (this.isShowingText) {
      if (Phaser.Input.Keyboard.JustDown(this.actionKey!)) {
        this.hideText()
      }
      return
    }

    // 自動移動パスがある場合
    if (this.movePath.length > 0 && !this.isMoving) {
      this.processMovePath()
      return
    }

    // アクションキー
    if (Phaser.Input.Keyboard.JustDown(this.actionKey!)) {
      this.checkNPCInteraction()
      return
    }

    // 移動中は入力を受け付けない
    if (this.isMoving) return

    // キーボード移動処理
    if (this.cursors.up.isDown) {
      this.movePlayer('up')
    } else if (this.cursors.down.isDown) {
      this.movePlayer('down')
    } else if (this.cursors.left.isDown) {
      this.movePlayer('left')
    } else if (this.cursors.right.isDown) {
      this.movePlayer('right')
    }
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    // テキスト表示中はタップでテキストを進める
    if (this.isShowingText) {
      this.hideText()
      return
    }

    // ワールド座標に変換
    const worldX = pointer.worldX
    const worldY = pointer.worldY

    // グリッド座標に変換
    const gridX = Math.floor(worldX / this.tileSize)
    const gridY = Math.floor(worldY / this.tileSize)

    // NPCをタップしたかチェック
    const tappedNPC = this.npcs.find(npc => npc.x === gridX && npc.y === gridY)
    if (tappedNPC) {
      // NPCの隣まで移動するパスを探索
      const path = this.findPathToNPC(tappedNPC)
      if (path) {
        this.movePath = path
        this.targetNPC = tappedNPC
      }
      return
    }

    // タップした場所まで移動するパスを探索
    const path = this.findPath(this.playerGridX, this.playerGridY, gridX, gridY)
    if (path && path.length > 0) {
      this.movePath = path
      this.targetNPC = null
    }
  }

  private findPath(
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): { x: number; y: number }[] | null {
    // 目的地が通行不可の場合
    if (!this.canMoveTo(endX, endY)) {
      return null
    }

    // BFS（幅優先探索）で経路探索
    const queue: { x: number; y: number; path: { x: number; y: number }[] }[] = []
    const visited = new Set<string>()

    queue.push({ x: startX, y: startY, path: [] })
    visited.add(`${startX},${startY}`)

    const directions = [
      { dx: 0, dy: -1 }, // up
      { dx: 0, dy: 1 }, // down
      { dx: -1, dy: 0 }, // left
      { dx: 1, dy: 0 }, // right
    ]

    while (queue.length > 0) {
      const current = queue.shift()!

      if (current.x === endX && current.y === endY) {
        return current.path
      }

      for (const dir of directions) {
        const nextX = current.x + dir.dx
        const nextY = current.y + dir.dy
        const key = `${nextX},${nextY}`

        if (!visited.has(key) && this.canMoveTo(nextX, nextY)) {
          visited.add(key)
          queue.push({
            x: nextX,
            y: nextY,
            path: [...current.path, { x: nextX, y: nextY }],
          })
        }
      }

      // 経路が長すぎる場合は中断（パフォーマンス対策）
      if (visited.size > 200) {
        return null
      }
    }

    return null
  }

  private findPathToNPC(npc: NPC): { x: number; y: number }[] | null {
    // NPCの隣接するタイルを探す
    const directions = [
      { dx: 0, dy: -1 }, // up
      { dx: 0, dy: 1 }, // down
      { dx: -1, dy: 0 }, // left
      { dx: 1, dy: 0 }, // right
    ]

    let shortestPath: { x: number; y: number }[] | null = null
    let shortestLength = Infinity

    for (const dir of directions) {
      const targetX = npc.x + dir.dx
      const targetY = npc.y + dir.dy

      if (this.canMoveTo(targetX, targetY)) {
        const path = this.findPath(this.playerGridX, this.playerGridY, targetX, targetY)
        if (path && path.length < shortestLength) {
          shortestPath = path
          shortestLength = path.length
        }
      }
    }

    return shortestPath
  }

  private processMovePath() {
    if (this.movePath.length === 0) return

    const nextPos = this.movePath[0]

    // 次の位置への方向を決定
    const dx = nextPos.x - this.playerGridX
    const dy = nextPos.y - this.playerGridY

    let direction = 'down'
    if (dy < 0) direction = 'up'
    else if (dy > 0) direction = 'down'
    else if (dx < 0) direction = 'left'
    else if (dx > 0) direction = 'right'

    // 移動を実行
    this.playerDirection = direction
    this.playerGridX = nextPos.x
    this.playerGridY = nextPos.y

    const targetX = nextPos.x * this.tileSize + this.tileSize / 2
    const targetY = nextPos.y * this.tileSize + this.tileSize / 2

    this.isMoving = true

    this.tweens.add({
      targets: this.player,
      x: targetX,
      y: targetY,
      duration: this.moveSpeed,
      ease: 'Linear',
      onComplete: () => {
        this.isMoving = false
        this.movePath.shift()

        // パスの最後に到達し、対象NPCがいる場合は会話
        if (this.movePath.length === 0 && this.targetNPC) {
          this.showText(this.targetNPC.message)
          this.targetNPC = null
        }
      },
    })
  }

  private getDefaultMapData(): number[][] {
    return [
      [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 3, 3, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 3, 3, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 3, 3, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    ]
  }
}
