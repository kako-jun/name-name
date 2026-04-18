/**
 * PixiJS ベースの一人称レイキャスティング RPG レンダラー。
 *
 * 見下ろしと同じ RPGProject を受け取り、同じタイルマップ・NPC を
 * 一人称視点で描画する。壁は TREE/WATER、NPC は距離ソート billboard。
 * 操作は WASD/矢印キー + Q/E（左右ストレイフ）、Enter/Space で正面 NPC と会話。
 */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { NPCData, RPGProject, TileType } from '../types/rpg'
import { RpgDialogBox } from './RpgDialogBox'
import {
  clampFrames,
  clearDemoSheetCache,
  directionToRow,
  loadNpcSpriteSheet,
  type NpcSpriteSheet,
} from './npcSpriteSheet'

/** NPC 歩行アニメのフレーム切替周期（ms）。TopDown と同じ値にして見た目を揃える */
const NPC_ANIM_PERIOD_MS = 500

interface NPCRuntime {
  data: NPCData
  x: number // tile-grid center (x + 0.5)
  y: number
  container: Container
  /** billboard sprite。初期状態は `Texture.WHITE` を `data.color` で tint した単色矩形。
   *  スプライトがロードされたら texture を差し替え、tint はフォグ用途に再利用する */
  sprite: Sprite
  /** 前方 z-buffer 遮蔽用の列単位マスク */
  mask: Graphics
  /** ロード済みのスプライトシート。null の場合は単色 billboard のまま */
  sheet: NpcSpriteSheet | null
  /** アニメ位相オフセット（ms） */
  phaseOffset: number
}

type DirectionLabel = 'up' | 'down' | 'left' | 'right'

export class RaycastRenderer {
  private app: Application
  private worldLayer: Container
  private npcLayer: Container
  private dialogBox: RpgDialogBox | null = null

  private worldGraphics: Graphics | null = null

  private mapTiles: number[][] = []
  private mapWidth = 0
  private mapHeight = 0
  /** スプライトシートセルサイズ（マップの tileSize と揃える）。NPC テクスチャ切り出しで使用 */
  private tileSize = 32

  private npcs: NPCRuntime[] = []

  // Player state (continuous)
  private playerX = 0
  private playerY = 0
  private playerAngle = 0 // radians; 0 = +x (right)

  private screenWidth = 0
  private screenHeight = 0

  // FOV 60°: 標準 FPS 相当（Doom/Wolf3D の 60° と同じ）。
  // 実装上はカメラ平面ベクトルの長さが tan(fov/2) で決まり、広すぎると魚眼歪みが強く、狭すぎると閉塞感が出る。
  private readonly fov = (Math.PI / 180) * 60
  // 1 列あたり 2px 幅で描画。1px だと本数が増えて CPU コストが重く、4px 以上だと縦縞が目立つため 2 を採用。
  private readonly stripeWidth = 2
  // 移動速度 3 tiles/s: 見下ろし版（TopDownRenderer）と同等の歩行感。速すぎると壁接触の判定違和感が出やすい。
  private readonly moveSpeed = 3
  // 旋回速度 3 rad/s: 1 回転に約 2.1 秒。FPS の標準より遅めだが、ADV で酔いにくいことを優先。
  private readonly rotSpeed = 3
  // フォグ上限 12 タイル: マップサイズ（通常 16x12 前後）に対して「遠くの壁は薄く霞む」ことを狙った値。
  // 大きくすると遠景まで鮮明に見えて没入感が減り、小さくすると視界が狭く感じる。
  private readonly fogMaxDist = 12
  // NPC スプライトサイズ算出時の深度下限。極小 transformY でスプライト高が青天井に肥大化するのを防ぐ。
  // 0.1 = 画面高の10倍まで許容 → drawStart/End の既存クランプで画面内に収まるサイズ。
  // 幾何的な位置（spriteScreenX）や z-buffer 比較には適用しない（遮蔽整合性のため）。
  private readonly npcSpriteMinDepth = 0.1

  private keys = new Set<string>()
  private lastTickMs = 0

  private resizeRaf: number | null = null
  private initialized = false

  constructor() {
    this.app = new Application()
    this.worldLayer = new Container()
    this.npcLayer = new Container()
    // zIndex で距離ソート（奥→手前）
    this.npcLayer.sortableChildren = true
  }

  async init(container: HTMLElement): Promise<void> {
    const rect = container.getBoundingClientRect()
    this.screenWidth = Math.max(320, Math.floor(rect.width || 800))
    this.screenHeight = Math.max(240, Math.floor(rect.height || 600))

    await this.app.init({
      width: this.screenWidth,
      height: this.screenHeight,
      background: 0x000000,
      antialias: false,
    })

    container.appendChild(this.app.canvas as HTMLCanvasElement)

    this.worldGraphics = new Graphics()
    this.worldLayer.addChild(this.worldGraphics)
    this.app.stage.addChild(this.worldLayer)
    this.app.stage.addChild(this.npcLayer)

    this.dialogBox = new RpgDialogBox(this.screenWidth, this.screenHeight)
    this.app.stage.addChild(this.dialogBox)

    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('resize', this.handleResize)
    this.app.ticker.add(this.onTick)

    this.initialized = true
  }

  load(gameData: RPGProject): void {
    this.dialogBox?.hide()

    this.mapTiles = gameData.map.tiles
    this.mapWidth = gameData.map.width
    this.mapHeight = gameData.map.height
    this.tileSize = gameData.map.tileSize

    if (
      this.mapTiles.length !== this.mapHeight ||
      this.mapTiles.some((r) => r.length !== this.mapWidth)
    ) {
      console.warn('[RaycastRenderer] map tiles dimensions mismatch')
    }

    this.rebuildNpcObjects(gameData.npcs)

    // Player: tile center
    this.playerX = gameData.player.x + 0.5
    this.playerY = gameData.player.y + 0.5
    this.playerAngle = directionToAngle(gameData.player.direction)

    this.lastTickMs = performance.now()
    this.keys.clear()
  }

  /**
   * NPC オブジェクト（Container + Sprite + mask）をレイヤに作成する。
   * スプライト未指定 NPC は `Texture.WHITE` を `data.color` で tint した単色矩形のまま維持。
   * `sprite=...` 指定があれば非同期ロードし、完了後に texture を差し替える。
   */
  private rebuildNpcObjects(npcData: NPCData[]): void {
    // 既存を destroy
    for (const child of this.npcLayer.removeChildren()) {
      child.destroy({ children: true })
    }
    this.npcs = []

    const stride = NPC_ANIM_PERIOD_MS / Math.max(1, npcData.length)
    for (let i = 0; i < npcData.length; i++) {
      const data = npcData[i]
      const container = new Container()
      this.npcLayer.addChild(container)

      const sprite = new Sprite(Texture.WHITE)
      sprite.anchor.set(0.5)
      sprite.tint = data.color
      container.addChild(sprite)

      const mask = new Graphics()
      container.addChild(mask)
      sprite.mask = mask

      const npc: NPCRuntime = {
        data,
        x: data.x + 0.5,
        y: data.y + 0.5,
        container,
        sprite,
        mask,
        sheet: null,
        phaseOffset: i * stride,
      }
      this.npcs.push(npc)

      if (data.sprite) {
        this.loadNpcSprite(npc)
      }
    }
  }

  private async loadNpcSprite(npc: NPCRuntime): Promise<void> {
    const sheet = await loadNpcSpriteSheet(
      npc.data.sprite!,
      clampFrames(npc.data.frames),
      this.tileSize,
      npc.data.color,
      this.app.renderer
    )
    if (!this.initialized || npc.container.destroyed) return
    if (!sheet) return
    npc.sheet = sheet
    // 単色から実スプライトに差し替え。tint はフォグ適用用に再利用する（白で初期化）
    npc.sprite.texture = sheet.textures[directionToRow(npc.data.direction)][0]
    npc.sprite.tint = 0xffffff
  }

  destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('resize', this.handleResize)
    if (this.resizeRaf !== null) {
      cancelAnimationFrame(this.resizeRaf)
      this.resizeRaf = null
    }
    if (this.initialized) {
      this.app.ticker.remove(this.onTick)
      clearDemoSheetCache(this.app.renderer)
      this.app.destroy(true, { children: true })
      this.dialogBox = null
      this.initialized = false
    }
  }

  // --- 入力 ---

  private isEditableFocused(): boolean {
    const active = document.activeElement
    return !!(
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        (active as HTMLElement).isContentEditable)
    )
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.initialized) return
    if (this.isEditableFocused()) return

    if (this.dialogBox?.isShowing) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        this.dialogBox.hide()
      }
      return
    }

    // Enter/Space で正面会話
    if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault()
      this.tryTalk()
      return
    }

    const k = normalizeKey(e.key)
    if (isMovementKey(k)) {
      e.preventDefault()
      this.keys.add(k)
    }
  }

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (!this.initialized) return
    const k = normalizeKey(e.key)
    this.keys.delete(k)
  }

  private tryTalk(): void {
    // プレイヤーの向きベクトル (dx, dy) から直近1マスのタイルを確定し、
    // そのタイルに NPC がいれば会話を開始する。
    // 見下ろし版（TopDownRenderer）と同じく、斜め向きでも「直近タイル（= 単位ベクトル1歩先）」
    // のみを対象にするため、視線上の複数マス先の NPC には届かない。
    const dx = Math.cos(this.playerAngle)
    const dy = Math.sin(this.playerAngle)
    const tx = Math.floor(this.playerX + dx)
    const ty = Math.floor(this.playerY + dy)
    const npc = this.npcs.find((n) => Math.floor(n.x) === tx && Math.floor(n.y) === ty)
    if (npc) {
      this.dialogBox?.show(npc.data.name, npc.data.message)
    }
  }

  // --- リサイズ ---

  private handleResize = (): void => {
    if (!this.initialized) return
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
    })
  }

  // --- ティック ---

  private onTick = (): void => {
    const now = performance.now()
    const dt = Math.max(0, Math.min(0.1, (now - this.lastTickMs) / 1000))
    this.lastTickMs = now

    if (!this.dialogBox?.isShowing) {
      this.updateMovement(dt)
    }
    this.updateNpcAnimations(now)
    this.renderFrame()
  }

  private updateMovement(dt: number): void {
    // 回転
    if (this.keys.has('rot_left')) {
      this.playerAngle -= this.rotSpeed * dt
    }
    if (this.keys.has('rot_right')) {
      this.playerAngle += this.rotSpeed * dt
    }

    const dx = Math.cos(this.playerAngle)
    const dy = Math.sin(this.playerAngle)
    // 垂直（右手方向）= 角度 + π/2
    const sx = -dy
    const sy = dx

    let mx = 0
    let my = 0
    if (this.keys.has('forward')) {
      mx += dx
      my += dy
    }
    if (this.keys.has('back')) {
      mx -= dx
      my -= dy
    }
    if (this.keys.has('strafe_left')) {
      mx -= sx
      my -= sy
    }
    if (this.keys.has('strafe_right')) {
      mx += sx
      my += sy
    }

    const len = Math.hypot(mx, my)
    if (len > 0) {
      mx = (mx / len) * this.moveSpeed * dt
      my = (my / len) * this.moveSpeed * dt
      // XY 分離で壁ずり
      const nextX = this.playerX + mx
      if (this.isPassable(nextX, this.playerY)) {
        this.playerX = nextX
      }
      const nextY = this.playerY + my
      if (this.isPassable(this.playerX, nextY)) {
        this.playerY = nextY
      }
    }
  }

  private isPassable(x: number, y: number): boolean {
    const tx = Math.floor(x)
    const ty = Math.floor(y)
    if (ty < 0 || ty >= this.mapTiles.length) return false
    const row = this.mapTiles[ty]
    if (!row) return false
    if (tx < 0 || tx >= row.length) return false
    const tile = row[tx]
    if (tile === TileType.TREE || tile === TileType.WATER) return false
    // NPC 占有チェック
    if (this.npcs.some((n) => Math.floor(n.x) === tx && Math.floor(n.y) === ty)) {
      return false
    }
    return true
  }

  private isWallTile(tx: number, ty: number): boolean {
    if (ty < 0 || ty >= this.mapTiles.length) return true
    const row = this.mapTiles[ty]
    if (!row) return true
    if (tx < 0 || tx >= row.length) return true
    const tile = row[tx]
    return tile === TileType.TREE || tile === TileType.WATER
  }

  private getTile(tx: number, ty: number): number {
    if (ty < 0 || ty >= this.mapTiles.length) return TileType.TREE
    const row = this.mapTiles[ty]
    if (!row) return TileType.TREE
    if (tx < 0 || tx >= row.length) return TileType.TREE
    return row[tx]
  }

  // --- 描画（DDA レイキャスティング + billboard NPC） ---

  private renderFrame(): void {
    const g = this.worldGraphics
    if (!g) return
    g.clear()

    const w = this.screenWidth
    const h = this.screenHeight

    // 空・床のベタ塗り
    g.rect(0, 0, w, h / 2)
    g.fill(0x4477cc)
    g.rect(0, h / 2, w, h / 2)
    g.fill(0x555555)

    // カメラ設定: dir = 単位向き, plane = dir に垂直、長さは tan(fov/2)
    const dirX = Math.cos(this.playerAngle)
    const dirY = Math.sin(this.playerAngle)
    const planeLen = Math.tan(this.fov / 2)
    const planeX = -dirY * planeLen
    const planeY = dirX * planeLen

    const numStripes = Math.ceil(w / this.stripeWidth)
    const zBuffer = new Float32Array(numStripes)

    for (let i = 0; i < numStripes; i++) {
      const screenX = i * this.stripeWidth
      // cameraX: -1 (left) .. +1 (right)
      const cameraX = (2 * (screenX + this.stripeWidth / 2)) / w - 1
      const rayDirX = dirX + planeX * cameraX
      const rayDirY = dirY + planeY * cameraX

      // DDA
      let mapX = Math.floor(this.playerX)
      let mapY = Math.floor(this.playerY)

      const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX)
      const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY)

      let stepX: number
      let stepY: number
      let sideDistX: number
      let sideDistY: number

      if (rayDirX < 0) {
        stepX = -1
        sideDistX = (this.playerX - mapX) * deltaDistX
      } else {
        stepX = 1
        sideDistX = (mapX + 1.0 - this.playerX) * deltaDistX
      }
      if (rayDirY < 0) {
        stepY = -1
        sideDistY = (this.playerY - mapY) * deltaDistY
      } else {
        stepY = 1
        sideDistY = (mapY + 1.0 - this.playerY) * deltaDistY
      }

      let side = 0 // 0 = x-side, 1 = y-side
      let hit = false
      let hitTile = TileType.TREE
      // 最大距離ガード（想定: map の最大対角）
      const maxSteps = this.mapWidth + this.mapHeight + 4
      for (let s = 0; s < maxSteps; s++) {
        if (sideDistX < sideDistY) {
          sideDistX += deltaDistX
          mapX += stepX
          side = 0
        } else {
          sideDistY += deltaDistY
          mapY += stepY
          side = 1
        }
        if (this.isWallTile(mapX, mapY)) {
          hit = true
          hitTile = this.getTile(mapX, mapY)
          break
        }
      }

      let perpDist: number
      if (!hit) {
        perpDist = this.fogMaxDist + 1
      } else if (side === 0) {
        perpDist = sideDistX - deltaDistX
      } else {
        perpDist = sideDistY - deltaDistY
      }
      if (perpDist < 0.0001) perpDist = 0.0001

      zBuffer[i] = perpDist

      if (hit && perpDist <= this.fogMaxDist + 0.5) {
        const lineHeight = Math.floor(h / perpDist)
        let drawStart = Math.floor(-lineHeight / 2 + h / 2)
        let drawEnd = Math.floor(lineHeight / 2 + h / 2)
        if (drawStart < 0) drawStart = 0
        if (drawEnd > h) drawEnd = h

        const baseColor = wallColor(hitTile, side)
        const fog = Math.max(0, Math.min(1, 1 - perpDist / this.fogMaxDist))
        const color = applyFog(baseColor, fog)
        g.rect(screenX, drawStart, this.stripeWidth, drawEnd - drawStart)
        g.fill(color)
      }
    }

    // NPC billboard: Sprite + mask で描画。距離は zIndex でソート
    // 逆行列: [planeX dirX; planeY dirY]^-1
    const invDet = 1.0 / (planeX * dirY - dirX * planeY)
    const playerTileX = Math.floor(this.playerX)
    const playerTileY = Math.floor(this.playerY)
    for (const n of this.npcs) {
      // プレイヤーと同タイルに立っている NPC は描画不要（衝突判定で発生しないが保険）
      const npcTileX = Math.floor(n.x)
      const npcTileY = Math.floor(n.y)
      if (npcTileX === playerTileX && npcTileY === playerTileY) {
        n.container.visible = false
        continue
      }
      const rx = n.x - this.playerX
      const ry = n.y - this.playerY
      const transformX = invDet * (dirY * rx - dirX * ry)
      const transformY = invDet * (-planeY * rx + planeX * ry) // これが depth

      if (transformY <= 0.01) {
        n.container.visible = false
        continue
      }

      const spriteScreenX = Math.floor((w / 2) * (1 + transformX / transformY))
      // 位置と遮蔽判定には元の transformY、サイズのみ下限クランプ
      const clampedDepth = Math.max(transformY, this.npcSpriteMinDepth)
      const spriteHeight = Math.abs(Math.floor(h / clampedDepth))
      const spriteWidthPx = spriteHeight
      let drawStartY = Math.floor(-spriteHeight / 2 + h / 2)
      if (drawStartY < 0) drawStartY = 0
      let drawEndY = Math.floor(spriteHeight / 2 + h / 2)
      if (drawEndY > h) drawEndY = h
      let drawStartX = Math.floor(-spriteWidthPx / 2 + spriteScreenX)
      let drawEndX = Math.floor(spriteWidthPx / 2 + spriteScreenX)
      if (drawStartX < 0) drawStartX = 0
      if (drawEndX > w) drawEndX = w

      const fog = Math.max(0, Math.min(1, 1 - transformY / this.fogMaxDist))
      // フォグ:
      //  - スプライトロード済みの NPC は白 × fog（画像を暗くする）
      //  - 未ロード NPC は data.color × fog（単色 billboard のフォグ）
      if (n.sheet) {
        n.sprite.tint = applyFog(0xffffff, fog)
      } else {
        n.sprite.tint = applyFog(n.data.color, fog)
      }

      // Sprite 配置とサイズ
      n.sprite.x = spriteScreenX
      n.sprite.y = h / 2
      n.sprite.width = spriteWidthPx
      n.sprite.height = spriteHeight
      n.container.visible = true
      // 距離ソート: 遠い NPC ほど先に描く → zIndex を小さく
      n.container.zIndex = -transformY

      // mask 更新: zBuffer で遮蔽されていない列だけを可視にする
      n.mask.clear()
      let hasVisible = false
      for (let sx = drawStartX; sx < drawEndX; sx += this.stripeWidth) {
        const stripeIdx = Math.floor(sx / this.stripeWidth)
        if (stripeIdx < 0 || stripeIdx >= numStripes) continue
        if (transformY >= zBuffer[stripeIdx]) continue
        n.mask.rect(sx, drawStartY, this.stripeWidth, drawEndY - drawStartY)
        hasVisible = true
      }
      if (hasVisible) {
        n.mask.fill(0xffffff)
      } else {
        n.container.visible = false
      }
    }
  }

  /** NPC アイドル歩行アニメ（スプライトロード済み NPC のみ）。TopDown と同じ周期 / 位相方式 */
  private updateNpcAnimations(nowMs: number): void {
    for (const npc of this.npcs) {
      const sheet = npc.sheet
      if (!sheet) continue
      if (sheet.frames < 2) continue
      const frame = Math.floor((nowMs + npc.phaseOffset) / NPC_ANIM_PERIOD_MS) % sheet.frames
      const row = directionToRow(npc.data.direction)
      npc.sprite.texture = sheet.textures[row][frame]
    }
  }
}

function directionToAngle(d: DirectionLabel): number {
  switch (d) {
    case 'up':
      return -Math.PI / 2
    case 'down':
      return Math.PI / 2
    case 'left':
      return Math.PI
    case 'right':
      return 0
  }
}

function normalizeKey(key: string): string {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'forward'
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'back'
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'rot_left'
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'rot_right'
    case 'q':
    case 'Q':
      return 'strafe_left'
    case 'e':
    case 'E':
      return 'strafe_right'
    default:
      return ''
  }
}

function isMovementKey(k: string): boolean {
  return (
    k === 'forward' ||
    k === 'back' ||
    k === 'rot_left' ||
    k === 'rot_right' ||
    k === 'strafe_left' ||
    k === 'strafe_right'
  )
}

function wallColor(tile: number, side: number): number {
  // side=1（y-side）はやや暗めにする
  let base: number
  switch (tile) {
    case TileType.WATER:
      base = 0x4169e1
      break
    case TileType.TREE:
    default:
      base = 0x1a3a1a
      break
  }
  if (side === 1) {
    return darken(base, 0.7)
  }
  return base
}

function darken(color: number, factor: number): number {
  const r = Math.max(0, Math.min(255, Math.floor(((color >> 16) & 0xff) * factor)))
  const g = Math.max(0, Math.min(255, Math.floor(((color >> 8) & 0xff) * factor)))
  const b = Math.max(0, Math.min(255, Math.floor((color & 0xff) * factor)))
  return (r << 16) | (g << 8) | b
}

function applyFog(color: number, fog: number): number {
  // fog=1 → 元の色、fog=0 → ほぼ黒
  return darken(color, fog)
}
