/**
 * PixiJS ベースの見下ろし型 RPG レンダラー。
 *
 * タイルマップ・プレイヤー・NPC を真上から描画し、キーボード入力で
 * プレイヤーをグリッド単位で動かす。隣接 NPC に Enter/Space で話しかけると
 * 会話ダイアログを表示する。RPG プレイモードのデフォルトビュー。
 */

import { Application, Container, Graphics } from 'pixi.js'
import { NPCData, RPGProject, TILE_COLORS_HEX, TileType } from '../types/rpg'
import { RpgDialogBox } from './RpgDialogBox'

type Direction = 'up' | 'down' | 'left' | 'right'

interface NPC {
  data: NPCData
  container: Container
  x: number
  y: number
}

export class TopDownRenderer {
  private app: Application
  private mapLayer: Container
  private npcLayer: Container
  private playerLayer: Container
  private world: Container
  private dialogBox: RpgDialogBox | null = null

  private playerContainer: Container | null = null
  private playerDirectionIndicator: Graphics | null = null

  private npcs: NPC[] = []
  private mapTiles: number[][] = []
  private tileSize = 32
  private mapWidth = 0
  private mapHeight = 0

  private playerGridX = 0
  private playerGridY = 0
  private playerDirection: Direction = 'down'

  private isMoving = false
  private moveStart = 0
  private moveFromX = 0
  private moveFromY = 0
  private moveToX = 0
  private moveToY = 0
  private readonly moveDuration = 150

  private screenWidth = 0
  private screenHeight = 0

  private resizeRaf: number | null = null

  private initialized = false

  constructor() {
    this.app = new Application()
    this.world = new Container()
    this.mapLayer = new Container()
    this.npcLayer = new Container()
    this.playerLayer = new Container()
  }

  /** PixiJS Application を初期化し、親要素に Canvas を挿入する */
  async init(container: HTMLElement): Promise<void> {
    const rect = container.getBoundingClientRect()
    this.screenWidth = Math.max(320, Math.floor(rect.width || 800))
    this.screenHeight = Math.max(240, Math.floor(rect.height || 600))

    await this.app.init({
      width: this.screenWidth,
      height: this.screenHeight,
      background: 0x1a4d1a,
      antialias: true,
    })

    container.appendChild(this.app.canvas as HTMLCanvasElement)

    this.world.addChild(this.mapLayer)
    this.world.addChild(this.npcLayer)
    this.world.addChild(this.playerLayer)
    this.app.stage.addChild(this.world)

    this.dialogBox = new RpgDialogBox(this.screenWidth, this.screenHeight)
    this.app.stage.addChild(this.dialogBox)

    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('resize', this.handleResize)
    this.app.ticker.add(this.onTick)

    this.initialized = true
  }

  /** ゲームデータを読み込んで描画を開始する */
  load(gameData: RPGProject): void {
    // 状態リセット
    this.isMoving = false
    this.moveStart = 0
    this.dialogBox?.hide()

    this.mapTiles = gameData.map.tiles
    this.tileSize = gameData.map.tileSize
    this.mapHeight = gameData.map.height
    this.mapWidth = gameData.map.width

    // マップ整合性チェック（警告のみ）
    if (
      this.mapTiles.length !== this.mapHeight ||
      this.mapTiles.some((r) => r.length !== this.mapWidth)
    ) {
      console.warn('[TopDownRenderer] map tiles dimensions mismatch')
    }

    this.playerGridX = gameData.player.x
    this.playerGridY = gameData.player.y
    this.playerDirection = gameData.player.direction

    this.drawMap()
    this.drawNPCs(gameData.npcs)
    this.drawPlayer()
    this.updatePlayerPosition(
      this.gridToPixelX(this.playerGridX),
      this.gridToPixelY(this.playerGridY)
    )
    this.centerCamera()
  }

  /** リソース解放 */
  destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('resize', this.handleResize)
    if (this.resizeRaf !== null) {
      cancelAnimationFrame(this.resizeRaf)
      this.resizeRaf = null
    }
    if (this.initialized) {
      this.app.ticker.remove(this.onTick)
      this.app.destroy(true, { children: true })
      this.dialogBox = null
      this.initialized = false
    }
  }

  /** layer の既存子要素を destroy してから remove する（GPU リソースリーク防止） */
  private clearLayer(layer: Container): void {
    for (const child of layer.removeChildren()) {
      child.destroy()
    }
  }

  // --- 描画 ---

  private drawMap(): void {
    this.clearLayer(this.mapLayer)
    // 色ごとに単一 Graphics にまとめて描画（タイル数分の Graphics 生成を避ける）
    const byColor = new Map<number, Array<[number, number]>>()
    for (let y = 0; y < this.mapTiles.length; y++) {
      const row = this.mapTiles[y]
      for (let x = 0; x < row.length; x++) {
        const tileType = row[x] as TileType
        const color = TILE_COLORS_HEX[tileType] ?? TILE_COLORS_HEX[TileType.GRASS]
        const list = byColor.get(color) ?? []
        list.push([x, y])
        byColor.set(color, list)
      }
    }
    const fillG = new Graphics()
    const strokeG = new Graphics()
    // 色ごとに rect を積んで fill（同色まとめバッチ）
    for (const [color, cells] of byColor) {
      for (const [x, y] of cells) {
        fillG.rect(x * this.tileSize, y * this.tileSize, this.tileSize, this.tileSize)
      }
      fillG.fill(color)
    }
    // 注: pixi v8 の Graphics は fill ごとにパスをリセットするため、上の各 fill で
    //     直前の rect 群だけが塗られる
    // grid stroke はマップ全体を一筆で
    for (let y = 0; y < this.mapTiles.length; y++) {
      const row = this.mapTiles[y]
      for (let x = 0; x < row.length; x++) {
        strokeG.rect(x * this.tileSize, y * this.tileSize, this.tileSize, this.tileSize)
      }
    }
    strokeG.stroke({ width: 1, color: 0x000000, alpha: 0.2 })
    this.mapLayer.addChild(fillG)
    this.mapLayer.addChild(strokeG)
  }

  private drawNPCs(npcData: NPCData[]): void {
    this.clearLayer(this.npcLayer)
    this.npcs = []
    for (const data of npcData) {
      const container = new Container()
      const rect = new Graphics()
      const size = this.tileSize - 4
      rect.rect(-size / 2, -size / 2, size, size)
      rect.fill(data.color)
      rect.stroke({ width: 2, color: 0x8b0000 })
      container.addChild(rect)
      container.x = this.gridToPixelX(data.x)
      container.y = this.gridToPixelY(data.y)
      this.npcLayer.addChild(container)
      this.npcs.push({ data, container, x: data.x, y: data.y })
    }
  }

  private drawPlayer(): void {
    this.clearLayer(this.playerLayer)
    const container = new Container()
    const body = new Graphics()
    const size = this.tileSize - 4
    body.rect(-size / 2, -size / 2, size, size)
    body.fill(0x0066ff)
    body.stroke({ width: 2, color: 0x001a66 })
    container.addChild(body)

    const indicator = new Graphics()
    container.addChild(indicator)

    this.playerContainer = container
    this.playerDirectionIndicator = indicator
    this.playerLayer.addChild(container)
    this.updateDirectionIndicator()
  }

  private updateDirectionIndicator(): void {
    const g = this.playerDirectionIndicator
    if (!g) return
    g.clear()
    const reach = this.tileSize / 2 - 2
    const half = 4
    let p: number[]
    switch (this.playerDirection) {
      case 'up':
        p = [0, -reach, -half, -reach + half + 2, half, -reach + half + 2]
        break
      case 'down':
        p = [0, reach, -half, reach - half - 2, half, reach - half - 2]
        break
      case 'left':
        p = [-reach, 0, -reach + half + 2, -half, -reach + half + 2, half]
        break
      case 'right':
        p = [reach, 0, reach - half - 2, -half, reach - half - 2, half]
        break
    }
    g.poly([p[0], p[1], p[2], p[3], p[4], p[5]])
    g.fill(0xffffff)
  }

  // --- 入力 ---

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.initialized) return

    // キーリピートはすべて無視（ダイアログちらつき・移動過剰対策）
    if (e.repeat) return

    // input/textarea/contentEditable にフォーカスがあるときはキー奪取しない
    const active = document.activeElement
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        (active as HTMLElement).isContentEditable)
    ) {
      return
    }

    if (this.dialogBox?.isShowing) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        this.dialogBox.hide()
      }
      return
    }

    if (this.isMoving) return

    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        e.preventDefault()
        this.tryMove('up')
        break
      case 'ArrowDown':
      case 's':
      case 'S':
        e.preventDefault()
        this.tryMove('down')
        break
      case 'ArrowLeft':
      case 'a':
      case 'A':
        e.preventDefault()
        this.tryMove('left')
        break
      case 'ArrowRight':
      case 'd':
      case 'D':
        e.preventDefault()
        this.tryMove('right')
        break
      case ' ':
      case 'Enter':
        e.preventDefault()
        this.tryTalk()
        break
    }
  }

  private tryMove(direction: Direction): void {
    this.playerDirection = direction
    this.updateDirectionIndicator()

    let nx = this.playerGridX
    let ny = this.playerGridY
    switch (direction) {
      case 'up':
        ny -= 1
        break
      case 'down':
        ny += 1
        break
      case 'left':
        nx -= 1
        break
      case 'right':
        nx += 1
        break
    }

    if (!this.canMoveTo(nx, ny)) return

    this.moveFromX = this.gridToPixelX(this.playerGridX)
    this.moveFromY = this.gridToPixelY(this.playerGridY)
    this.moveToX = this.gridToPixelX(nx)
    this.moveToY = this.gridToPixelY(ny)
    this.moveStart = performance.now()
    this.playerGridX = nx
    this.playerGridY = ny
    this.isMoving = true
  }

  private canMoveTo(x: number, y: number): boolean {
    if (y < 0 || y >= this.mapTiles.length) return false
    const row = this.mapTiles[y]
    if (x < 0 || x >= row.length) return false
    const tile = row[x]
    if (tile === TileType.TREE || tile === TileType.WATER) return false
    if (this.npcs.some((n) => n.x === x && n.y === y)) return false
    return true
  }

  private tryTalk(): void {
    let tx = this.playerGridX
    let ty = this.playerGridY
    switch (this.playerDirection) {
      case 'up':
        ty -= 1
        break
      case 'down':
        ty += 1
        break
      case 'left':
        tx -= 1
        break
      case 'right':
        tx += 1
        break
    }
    const npc = this.npcs.find((n) => n.x === tx && n.y === ty)
    if (npc) this.dialogBox?.show(npc.data.name, npc.data.message)
  }

  // --- リサイズ ---

  private handleResize = (): void => {
    if (!this.initialized) return
    // ドラッグリサイズ中の連続発火を requestAnimationFrame で間引く
    if (this.resizeRaf !== null) return
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = null
      if (!this.initialized) return
      const parent = (this.app.canvas as HTMLCanvasElement).parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      this.screenWidth = Math.max(320, Math.floor(rect.width || 800))
      this.screenHeight = Math.max(240, Math.floor(rect.height || 600))
      this.app.renderer.resize(this.screenWidth, this.screenHeight)
      this.dialogBox?.redraw(this.screenWidth, this.screenHeight)
      this.centerCamera()
    })
  }

  // --- ティック ---

  private onTick = (): void => {
    if (!this.isMoving) return
    const now = performance.now()
    const t = Math.min(1, (now - this.moveStart) / this.moveDuration)
    const x = this.moveFromX + (this.moveToX - this.moveFromX) * t
    const y = this.moveFromY + (this.moveToY - this.moveFromY) * t
    this.updatePlayerPosition(x, y)
    this.centerCamera()
    if (t >= 1) {
      this.isMoving = false
    }
  }

  private updatePlayerPosition(x: number, y: number): void {
    if (!this.playerContainer) return
    this.playerContainer.x = x
    this.playerContainer.y = y
  }

  private centerCamera(): void {
    if (!this.playerContainer) return
    const mapPxWidth = this.mapWidth * this.tileSize
    const mapPxHeight = this.mapHeight * this.tileSize

    let camX = this.screenWidth / 2 - this.playerContainer.x
    let camY = this.screenHeight / 2 - this.playerContainer.y

    // マップが画面より大きいときだけクランプ
    if (mapPxWidth > this.screenWidth) {
      camX = Math.min(0, Math.max(this.screenWidth - mapPxWidth, camX))
    } else {
      camX = (this.screenWidth - mapPxWidth) / 2
    }
    if (mapPxHeight > this.screenHeight) {
      camY = Math.min(0, Math.max(this.screenHeight - mapPxHeight, camY))
    } else {
      camY = (this.screenHeight - mapPxHeight) / 2
    }

    this.world.x = camX
    this.world.y = camY
  }

  private gridToPixelX(gx: number): number {
    return gx * this.tileSize + this.tileSize / 2
  }

  private gridToPixelY(gy: number): number {
    return gy * this.tileSize + this.tileSize / 2
  }
}
