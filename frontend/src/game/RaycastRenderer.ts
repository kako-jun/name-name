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
  NPC_ANIM_PERIOD_MS,
  clampFrames,
  clearDemoSheetCache,
  directionToRow,
  loadNpcSpriteSheet,
  type NpcSpriteSheet,
} from './npcSpriteSheet'
import { computeWallYRange, projectNpcToScreen } from './raycastProjection'
import {
  clearDemoWallCache,
  computeWallU,
  loadWallTexture,
  uToColumn,
  type WallTextureSheet,
} from './wallTextureSheet'

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

/**
 * y-side（side=1）壁の基底シェード色。
 * 立体感維持のため 0.7 倍で暗めにした白を `applyFog` のベースにする。
 * 毎フレーム `darken(0xffffff, 0.7)` を呼ぶのは無駄なのでモジュール定数に昇格。
 */
const SIDE_SHADE_BASE = darken(0xffffff, 0.7)

export class RaycastRenderer {
  private app: Application
  private worldLayer: Container
  private wallSpritesContainer: Container
  private npcLayer: Container
  private dialogBox: RpgDialogBox | null = null

  private worldGraphics: Graphics | null = null

  /** 壁用ストライプ Sprite プール。index = stripe index。texture/tint/visible を毎フレーム更新する。
   *  不変条件: `wallSpritesContainer.children[i] === this.stripeSprites[i]`（ensureStripePool が維持） */
  private stripeSprites: Sprite[] = []

  /** 壁ストライプの perpDist を格納する z-buffer。NPC billboard の遮蔽判定で参照。
   *  stripe プールと一緒にサイズ同期して再利用（毎フレーム new を避ける） */
  private zBuffer: Float32Array = new Float32Array(0)

  /** 壁テクスチャ（TREE / WATER）。ロード完了後に使用、未ロード中は色ベタ fallback */
  private treeTexture: WallTextureSheet | null = null
  private waterTexture: WallTextureSheet | null = null

  private mapTiles: number[][] = []
  /** タイルごとの壁高さ（[y][x]、1.0 = 従来挙動）。undefined 時は全タイル 1.0 扱い（Issue #49 Phase 1） */
  private wallHeights?: number[][]
  private mapWidth = 0
  private mapHeight = 0
  /** スプライトシートセルサイズ（マップの tileSize と揃える）。NPC テクスチャ切り出しで使用 */
  private tileSize = 32

  private npcs: NPCRuntime[] = []

  // Player state (continuous)
  private playerX = 0
  private playerY = 0
  private playerAngle = 0 // radians; 0 = +x (right)
  /** プレイヤーの上下視線（rad）。正で上向き（画面中央が下にシフト）。Issue #80 Phase 2 */
  private playerPitch = 0

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
  // pitch 速度 1.5 rad/s: 旋回より遅め。最大 ±0.4 rad なので押しっぱなしで約 0.27 秒で端に到達する程度。
  // Issue #80 Phase 2: PageUp/PageDown キーで連続変化させる。
  private readonly pitchSpeed = 1.5
  // pitch クランプ ±0.4 rad（≒ ±23°）。Lodev 方式の `Math.tan(pitch) * h/2` でも 0.4 rad で
  // h/2 の約 42% シフトに収まり、画面外破綻を起こさない目安。広げすぎると床/天井が破綻して見える。
  private readonly pitchMaxAbs = 0.4
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
    this.wallSpritesContainer = new Container()
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
    // 空・床は worldGraphics（奥）、壁ストライプ Sprite は wallSpritesContainer（手前）。
    // NPC は npcLayer（さらに手前）で stage 直下。worldLayer との分離は従来通り
    this.worldLayer.addChild(this.worldGraphics)
    this.worldLayer.addChild(this.wallSpritesContainer)
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
    this.wallHeights = gameData.map.wallHeights
    this.mapWidth = gameData.map.width
    this.mapHeight = gameData.map.height
    this.tileSize = gameData.map.tileSize

    if (
      this.mapTiles.length !== this.mapHeight ||
      this.mapTiles.some((r) => r.length !== this.mapWidth)
    ) {
      console.warn('[RaycastRenderer] map tiles dimensions mismatch')
    }
    if (
      this.wallHeights &&
      (this.wallHeights.length !== this.mapHeight ||
        this.wallHeights.some((r) => r.length !== this.mapWidth))
    ) {
      console.warn('[RaycastRenderer] wallHeights dimensions mismatch (falls back to 1.0 per cell)')
    }

    this.rebuildNpcObjects(gameData.npcs)

    // Player: tile center
    this.playerX = gameData.player.x + 0.5
    this.playerY = gameData.player.y + 0.5
    this.playerAngle = directionToAngle(gameData.player.direction)
    // pitch は load() ごとに 0（水平）にリセット。データモデル化は将来 Issue
    this.playerPitch = 0

    this.lastTickMs = performance.now()
    this.keys.clear()

    // 壁テクスチャを非同期ロード（完了まではベタ塗り fallback）。
    // 同じ RaycastRenderer で load() が複数回呼ばれても、wallTextureSheet 側の
    // WeakMap キャッシュにより RenderTexture は使い回される
    this.ensureWallTextures().catch((e) => {
      console.warn('[RaycastRenderer] wall textures load failed:', e)
    })
  }

  private async ensureWallTextures(): Promise<void> {
    const renderer = this.app.renderer
    const [tree, water] = await Promise.all([
      loadWallTexture('tree', renderer),
      loadWallTexture('water', renderer),
    ])
    // destroy とのレース: await 中に destroy が走った場合、今ロードしたシートは
    // 代入せず即座に破棄する（そうしないと columns がリークする）
    if (!this.initialized) {
      tree?.destroy()
      water?.destroy()
      return
    }
    // 既存シートを先に destroy してから差し替える（load() 再呼び出し時のリーク対策）
    this.treeTexture?.destroy()
    this.waterTexture?.destroy()
    this.treeTexture = tree
    this.waterTexture = water
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
      // 順序:
      //   1. initialized=false → 進行中の async ロードが完了したとき「代入せず破棄」ルートに流す
      //   2. 派生 columns Texture を destroy（base source は共有なので壊さない）
      //   3. app.destroy で Sprite / Container / Renderer を破棄
      //   4. clearDemoWallCache / clearDemoSheetCache で base RenderTexture を destroy(true)
      //      これを app.destroy より後ろに置くのは、逆順だと cache の RenderTexture source を
      //      先に破棄してしまい、app.destroy で連鎖的に破棄済み source を参照する可能性があるため
      this.initialized = false
      this.treeTexture?.destroy()
      this.waterTexture?.destroy()
      this.treeTexture = null
      this.waterTexture = null
      const renderer = this.app.renderer
      this.app.destroy(true, { children: true })
      clearDemoWallCache(renderer)
      clearDemoSheetCache(renderer)
      this.stripeSprites = []
      this.zBuffer = new Float32Array(0)
      this.dialogBox = null
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
      // 画面幅が変わると numStripes も変わるので、余剰分を destroy して寸法を合わせる
      this.ensureStripePool(Math.ceil(this.screenWidth / this.stripeWidth))
    })
  }

  /**
   * 壁ストライプ Sprite プールを必要数まで増減する。
   * 足りない分は新規生成して wallSpritesContainer に addChild、
   * 余剰分は destroy して配列から削除する。
   *
   * 不変条件: `wallSpritesContainer.children[i] === this.stripeSprites[i]`（index 対応）。
   * ここでは末尾追加・末尾削除のみ行うためこの対応が維持される。
   * 他所で wallSpritesContainer.addChild/removeChild を直接触る場合はこの対応が壊れるので注意。
   *
   * Sprite の `width` setter は scale 計算を伴うため、毎フレーム呼ぶとコスト大。
   * ストライプ幅は不変（stripeWidth）なので生成時に一度だけセットし、毎フレームは
   * `height` のみ更新する。
   *
   * zBuffer サイズも同時に同期する（毎フレーム new を避ける）。
   */
  private ensureStripePool(target: number): void {
    while (this.stripeSprites.length < target) {
      const s = new Sprite(Texture.WHITE)
      // anchor.y=0: Sprite の上端を drawStartY に合わせる（Issue #49 Phase 1 で wallHeight 対応のため
      // 「中央寄せで高さ固定」から「上端 drawStartY、height = drawEndY - drawStartY」方式に移行）。
      // 中央寄せ方式だと wallHeight ≠ 1 のとき中心が壁中央からズレるため、上端基準にすれば
      // 純粋関数 `computeWallYRange` 側で Y 範囲を完結させられる。
      s.anchor.set(0, 0)
      s.visible = false
      // texture は 1px 幅 → `scale.x = stripeWidth` が実質セットされる（width setter 経由）
      s.width = this.stripeWidth
      this.wallSpritesContainer.addChild(s)
      this.stripeSprites.push(s)
    }
    while (this.stripeSprites.length > target) {
      const s = this.stripeSprites.pop()
      if (s) {
        s.destroy()
      }
    }
    if (target > 0 && this.zBuffer.length !== target) {
      this.zBuffer = new Float32Array(target)
    }
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

    // pitch（上下視線、Issue #80 Phase 2）
    // PageUp = 上を見る = playerPitch を増加（baseY が下にシフト → 空が広く見える）
    if (this.keys.has('pitch_up')) {
      this.playerPitch += this.pitchSpeed * dt
    }
    if (this.keys.has('pitch_down')) {
      this.playerPitch -= this.pitchSpeed * dt
    }
    // ±pitchMaxAbs にクランプ
    if (this.playerPitch > this.pitchMaxAbs) this.playerPitch = this.pitchMaxAbs
    else if (this.playerPitch < -this.pitchMaxAbs) this.playerPitch = -this.pitchMaxAbs

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

  /**
   * タイル座標 (tx, ty) の壁高さを取得する（Issue #49 Phase 1）。
   * wallHeights が未指定、該当行/セルが未定義、有限数でない場合は 1.0（従来挙動）を返す。
   */
  private getWallHeight(tx: number, ty: number): number {
    const grid = this.wallHeights
    if (!grid) return 1
    const row = grid[ty]
    if (!row) return 1
    const v = row[tx]
    if (typeof v !== 'number' || !Number.isFinite(v)) return 1
    return v
  }

  // --- 描画（DDA レイキャスティング + billboard NPC） ---

  private renderFrame(): void {
    const g = this.worldGraphics
    if (!g) return
    g.clear()

    const w = this.screenWidth
    const h = this.screenHeight

    // pitch（上下視線、Issue #80 Phase 2）→ 画面中央 Y のシフト px。
    // Lodev 方式の `Math.tan(pitch) * h/2`。pitch 正で baseY が下にシフト → 空が広く見える＝視線が上向き。
    // 空・床の分割位置 / 壁 Y 範囲 / NPC Y 範囲のすべてに同じオフセットを適用する。
    const rawPitchOffset = Math.round(Math.tan(this.playerPitch) * (h / 2))
    // 念のため [-h, h] にクランプ（pitch クランプ済みなので通常は ±0.4 rad ≈ ±42% h で収まる）
    const pitchOffsetPx = rawPitchOffset > h ? h : rawPitchOffset < -h ? -h : rawPitchOffset
    // 空・床ベタ塗りの境界 Y。[0, h] にクランプして負/超過の高さを避ける。
    const horizonY = h / 2 + pitchOffsetPx
    const horizonClamped = horizonY < 0 ? 0 : horizonY > h ? h : horizonY

    // 空・床のベタ塗り（pitch に応じて分割位置を上下に動かす）
    if (horizonClamped > 0) {
      g.rect(0, 0, w, horizonClamped)
      g.fill(0x4477cc)
    }
    if (horizonClamped < h) {
      g.rect(0, horizonClamped, w, h - horizonClamped)
      g.fill(0x555555)
    }

    // カメラ設定: dir = 単位向き, plane = dir に垂直、長さは tan(fov/2)
    const dirX = Math.cos(this.playerAngle)
    const dirY = Math.sin(this.playerAngle)
    const planeLen = Math.tan(this.fov / 2)
    const planeX = -dirY * planeLen
    const planeY = dirX * planeLen

    const numStripes = Math.ceil(w / this.stripeWidth)

    // 壁 Sprite プールと zBuffer を必要数まで確保（lazy 成長、毎フレーム new を避ける）
    this.ensureStripePool(numStripes)
    const zBuffer = this.zBuffer

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

      const stripeSprite = this.stripeSprites[i]
      if (hit && perpDist <= this.fogMaxDist + 0.5) {
        const lineHeight = Math.floor(h / perpDist)
        const fog = Math.max(0, Math.min(1, 1 - perpDist / this.fogMaxDist))

        // Issue #49 Phase 1: タイルごとの壁高さを適用。
        // wallHeight=1.0 なら従来挙動、0.5 なら腰高の柵、1.5 なら塔。
        // 地面位置（drawEndY）は wallHeight に依らず不変で、上端（drawStartY）が伸縮する。
        const wallHeight = this.getWallHeight(mapX, mapY)
        const { drawStartY, drawEndY } = computeWallYRange(lineHeight, wallHeight, h, pitchOffsetPx)
        const drawHeight = drawEndY - drawStartY

        // wallHeight<=0 で高さゼロ → 描画なし
        if (drawHeight <= 0) {
          stripeSprite.visible = false
          continue
        }

        // 個別判定: 該当 kind のシートだけが揃っていれば Sprite を使う。
        // 「両方揃ってから切替」のフラグ方式だと、片方だけロード成功したケースで
        // 不必要に fallback を続けてしまうため、stripe ごとに判断する。
        // 注意: 将来 TREE/WATER 以外の壁タイル種別を追加する場合は、ここの
        // 分岐と ensureWallTextures のロード対象も忘れずに増やすこと。
        // 現状は WATER 以外を tree シート扱いにフォールバックしている。
        const sheet: WallTextureSheet | null =
          hitTile === TileType.WATER ? this.waterTexture : this.treeTexture
        if (sheet) {
          // テクスチャストライプ方式: Sprite プールの texture/位置/tint を更新
          const u = computeWallU(
            side as 0 | 1,
            perpDist,
            this.playerX,
            this.playerY,
            rayDirX,
            rayDirY
          )
          const col = uToColumn(u, sheet.width)
          // y-side は従来同様に 0.7 倍で暗めにしてから fog 適用（立体感の維持）。
          // 値はモジュール定数（SIDE_SHADE_BASE）で 1 度だけ計算してある。
          const shadedBase = side === 1 ? SIDE_SHADE_BASE : 0xffffff
          stripeSprite.texture = sheet.columns[col]
          stripeSprite.x = screenX
          // anchor.y=0 なので Sprite の上端を drawStartY に配置し、height で下端を決める。
          // wallHeight に応じて Sprite.scale.y が縮尺されるため、テクスチャは縦に圧縮/伸張される。
          // Phase 1 の要件は「段差が見える」ことなので、上端クロップではなく全体スケール方式を採用。
          stripeSprite.y = drawStartY
          // width は ensureStripePool で 1 度だけ設定済み（毎フレーム scale 計算を避ける）
          stripeSprite.height = drawHeight
          stripeSprite.tint = applyFog(shadedBase, fog)
          stripeSprite.visible = true
        } else {
          // ロード前 fallback: 従来のベタ塗り（worldGraphics）
          stripeSprite.visible = false
          const baseColor = wallColor(hitTile, side)
          const color = applyFog(baseColor, fog)
          g.rect(screenX, drawStartY, this.stripeWidth, drawHeight)
          g.fill(color)
        }
      } else {
        stripeSprite.visible = false
      }
    }

    // NPC billboard: Sprite + mask で描画。距離は zIndex でソート
    for (const n of this.npcs) {
      const proj = projectNpcToScreen(
        { x: n.x, y: n.y },
        { x: this.playerX, y: this.playerY },
        { x: dirX, y: dirY },
        { x: planeX, y: planeY },
        { width: w, height: h },
        this.npcSpriteMinDepth,
        pitchOffsetPx
      )
      if (!proj) {
        n.container.visible = false
        continue
      }

      const {
        screenX: spriteScreenX,
        spriteHeight,
        spriteWidthPx,
        depth,
        drawStartX,
        drawEndX,
        drawStartY,
        drawEndY,
      } = proj

      const fog = Math.max(0, Math.min(1, 1 - depth / this.fogMaxDist))
      // フォグ:
      //  - スプライトロード済みの NPC は白 × fog（画像を暗くする）
      //  - 未ロード NPC は data.color × fog（単色 billboard のフォグ）
      if (n.sheet) {
        n.sprite.tint = applyFog(0xffffff, fog)
      } else {
        n.sprite.tint = applyFog(n.data.color, fog)
      }

      // Sprite 配置とサイズ。anchor=(0.5,0.5) なので Y は baseY = h/2 + pitchOffsetPx に置く
      // （projectNpcToScreen の drawStartY/EndY と同じ baseY を共有させる）
      n.sprite.x = spriteScreenX
      n.sprite.y = h / 2 + pitchOffsetPx
      n.sprite.width = spriteWidthPx
      n.sprite.height = spriteHeight
      n.container.visible = true
      // 距離ソート: 遠い NPC ほど先に描く → zIndex を小さく
      n.container.zIndex = -depth

      // mask 更新: zBuffer で遮蔽されていない列だけを可視にする。
      // mask は npcLayer → container（ともに位置 0, 0）直下なので、rect 座標はキャンバス絶対座標と一致する
      n.mask.clear()
      let hasVisible = false
      for (let sx = drawStartX; sx < drawEndX; sx += this.stripeWidth) {
        const stripeIdx = Math.floor(sx / this.stripeWidth)
        if (stripeIdx < 0 || stripeIdx >= numStripes) continue
        if (depth >= zBuffer[stripeIdx]) continue
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
    case 'PageUp':
      return 'pitch_up'
    case 'PageDown':
      return 'pitch_down'
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
    k === 'strafe_right' ||
    k === 'pitch_up' ||
    k === 'pitch_down'
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
