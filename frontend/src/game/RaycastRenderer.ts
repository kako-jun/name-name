/**
 * PixiJS ベースの一人称レイキャスティング RPG レンダラー。
 *
 * 見下ろしと同じ RPGProject を受け取り、同じタイルマップ・NPC を
 * 一人称視点で描画する。壁は TREE/WATER、NPC は距離ソート billboard。
 * 操作は WASD/矢印キー + Q/E（左右ストレイフ）、Enter/Space で正面 NPC と会話。
 */

import { Application, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js'
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
import {
  computeEffectiveFogMaxDist,
  computeWallYRange,
  projectNpcToScreen,
  resolveCeilingHeight,
  resolveFloorHeight,
} from './raycastProjection'
import {
  clearDemoWallCache,
  clearStackedWallCache,
  computeWallTextureCrop,
  computeWallU,
  getStackedWallSheet,
  loadWallTexture,
  TEXTURE_HEIGHT as WALL_TEXTURE_HEIGHT,
  uToColumn,
  type WallTextureKind,
  type WallTextureSheet,
} from './wallTextureSheet'
import { formatHeightError, validateMapHeights } from './mapValidation'

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

  /** 壁ストライプの上端画面 Y を格納するバッファ（Issue #80 Phase 2）。
   *  NPC mask の壁高さ連動遮蔽で参照する。壁が描画されなかった列は `screenHeight`
   *  （= 遮蔽なし相当、min(segEndY, wallTopY) で制約がかからない値）で埋める。
   *  zBuffer と同じ index 対応で、ensureStripePool でサイズ同期される。 */
  private wallTopYBuffer: Float32Array = new Float32Array(0)

  /** 壁テクスチャ（TREE / WATER）。ロード完了後に使用、未ロード中は色ベタ fallback */
  private treeTexture: WallTextureSheet | null = null
  private waterTexture: WallTextureSheet | null = null

  private mapTiles: number[][] = []
  /** タイルごとの壁高さ（[y][x]、1.0 = 従来挙動）。undefined 時は全タイル 1.0 扱い（Issue #49 Phase 1） */
  private wallHeights?: number[][]
  /** タイルごとの床高さ（[y][x]、0.0 = 地面標準）。undefined 時は全タイル 0.0 扱い（Issue #84） */
  private floorHeights?: number[][]
  /** タイルごとの天井高さ（[y][x]、1.0 = 標準）。undefined 時は全タイル 1.0 扱い（Issue #87）。
   *  ジャンプ時の頭ぶつけ判定に使う。視覚的な天井レンダリングは別 Issue */
  private ceilingHeights?: number[][]
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
  /** ジャンプ由来のカメラ高さオフセット（タイル単位、足元の床面からの相対高）。
   *  0 = 床面、正でジャンプ中。Issue #80 Phase 2-2（旧 playerZ）。Issue #84 でリネーム。 */
  private playerJumpZ = 0
  /** プレイヤーの鉛直方向速度（タイル/秒）。正で上昇中、負で落下中。Issue #80 Phase 2-2 */
  private playerVZ = 0
  /** 現在踏んでいるタイルの床高さ（タイル単位、0 = 地面標準）。Issue #84。
   *  移動で踏みしめた瞬間に `resolveFloorHeight` で更新（補間なし）。
   *  カメラ総オフセット = playerGroundZ + playerJumpZ。 */
  private playerGroundZ = 0

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
  // ジャンプ初速 3.0 タイル/秒、重力 12.0 タイル/秒^2（Issue #80 Phase 2-2）。
  // 最高到達高 = v^2 / (2g) = 9 / 24 = 0.375 タイル分、滞空時間 = 2v/g = 0.5 秒。
  // 控えめだが視点が変わる感覚は十分得られる程度の設定。連続ジャンプ防止のため着地中のみ受け付ける。
  private readonly jumpInitialV = 3.0
  private readonly gravity = 12.0
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
    this.floorHeights = gameData.map.floorHeights
    this.ceilingHeights = gameData.map.ceilingHeights
    this.mapWidth = gameData.map.width
    this.mapHeight = gameData.map.height
    this.tileSize = gameData.map.tileSize

    if (
      this.mapTiles.length !== this.mapHeight ||
      this.mapTiles.some((r) => r.length !== this.mapWidth)
    ) {
      console.warn('[RaycastRenderer] map tiles dimensions mismatch')
    }
    const heightValidation = validateMapHeights(gameData.map)
    if (!heightValidation.ok) {
      for (const err of heightValidation.errors) {
        console.warn(`[RaycastRenderer] ${formatHeightError(err)} — falls back per cell`)
      }
    }

    this.rebuildNpcObjects(gameData.npcs)

    // Player: tile center
    this.playerX = gameData.player.x + 0.5
    this.playerY = gameData.player.y + 0.5
    this.playerAngle = directionToAngle(gameData.player.direction)
    // pitch は load() ごとに 0（水平）にリセット。データモデル化は将来 Issue
    this.playerPitch = 0
    // ジャンプ状態も load() ごとに地面・静止にリセット（Issue #80 Phase 2-2）
    this.playerJumpZ = 0
    this.playerVZ = 0
    // 初期タイルの床高さに合わせる（Issue #84）
    this.playerGroundZ = resolveFloorHeight(
      this.floorHeights,
      Math.floor(this.playerX),
      Math.floor(this.playerY)
    )

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
      //   4. clearStackedWallCache（Issue #93）→ clearDemoWallCache / clearDemoSheetCache の順で
      //      base RenderTexture を destroy(true)。これを app.destroy より後ろに置くのは、逆順だと
      //      cache の RenderTexture source を先に破棄してしまい、app.destroy で連鎖的に破棄済み
      //      source を参照する可能性があるため
      this.initialized = false
      this.treeTexture?.destroy()
      this.waterTexture?.destroy()
      this.treeTexture = null
      this.waterTexture = null
      const renderer = this.app.renderer
      this.app.destroy(true, { children: true })
      // Issue #93: stacked → demo の順で呼ぶ。
      // clearStackedWallCache は sheet.destroy() 経由で stacked RenderTexture（ownedBase）を
      // destroy(true) で解放する。stacked RT の columns 自身は stacked RT の source を参照する
      // ので、既に作成済み sheet が壊れるわけではない。ただし将来 stacked を rebuild する経路
      // （再入や遅延 destroy）では buildStackedWallTexture が base source を読む必要があり、
      // demo が先に壊れていると参照不能になる。安全側として stacked を先、demo を後にする。
      clearStackedWallCache(renderer)
      clearDemoWallCache(renderer)
      clearDemoSheetCache(renderer)
      this.stripeSprites = []
      this.zBuffer = new Float32Array(0)
      this.wallTopYBuffer = new Float32Array(0)
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
    // ジャンプは「押下時に1回だけ反応」する性質なので、keys set には載せず
    // handleKeyDown で直接処理する（連続キー入力で多重ジャンプしないよう e.repeat を弾く）
    if (k === 'jump') {
      e.preventDefault()
      if (!e.repeat) {
        this.tryJump()
      }
      return
    }
    if (isMovementKey(k)) {
      e.preventDefault()
      this.keys.add(k)
    }
  }

  /**
   * ジャンプ入力（Z キー押下時）。着地中（playerJumpZ === 0 かつ playerVZ === 0）にのみ
   * `jumpInitialV` を鉛直速度に与える。空中では無視されるため、ジャンプ中の二段ジャンプは不可。
   * Issue #80 Phase 2-2。床段差の上（playerGroundZ > 0）でもジャンプ可能（Issue #84）。
   */
  private tryJump(): void {
    if (this.playerJumpZ === 0 && this.playerVZ === 0) {
      this.playerVZ = this.jumpInitialV
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
      // ダイアログ表示中は updateMovement がスキップされるため、押されたままのキー
      // （移動・回転・pitch）が残留する。閉じた瞬間に意図しない挙動にならないよう一括クリア。
      // ジャンプは keys set ではなく handleKeyDown 直接処理 + dialog ガードで防がれているので対象外。
      this.keys.clear()
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
    if (target > 0 && this.wallTopYBuffer.length !== target) {
      this.wallTopYBuffer = new Float32Array(target)
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

    // 床段差（Issue #84）: 移動処理後、現在踏んでいるタイルの床高さに合わせる（瞬時切替・補間なし）。
    // 移動していない場合でも毎フレーム更新するが、同値代入になるだけで副作用はない。
    this.playerGroundZ = resolveFloorHeight(
      this.floorHeights,
      Math.floor(this.playerX),
      Math.floor(this.playerY)
    )

    // ジャンプ・重力（Issue #80 Phase 2-2）。
    // 着地中（playerJumpZ===0 かつ playerVZ===0）はスキップして無駄計算を避ける。
    // ジャンプは足元の床（playerGroundZ）からの相対高 playerJumpZ で管理するため、床段差の上でもジャンプ可能。
    // 壁衝突判定（isPassable）は変えない方針なので、空中でも壁の上には乗れない。
    if (this.playerJumpZ > 0 || this.playerVZ !== 0) {
      this.playerVZ -= this.gravity * dt
      this.playerJumpZ += this.playerVZ * dt
      // 頭ぶつけ（Issue #87）: 現在タイルの天井高さ（タイル単位）から足元の床高さ（playerGroundZ）を引いた値が
      // playerJumpZ の上限。超えたらその位置で止め、VZ を 0 にして即落下開始（跳ね返り無し、MVP）。
      // 天井が床より低い退化ケースは resolveCeilingHeight が 1 にフォールバックするので maxJumpZ > 0 が保証される
      // わけではない（playerGroundZ > 1 の床段差上では maxJumpZ が負になりうる）。その場合は頭ぶつけ判定が
      // 即発動してジャンプ自体が成立しないことになるが、MVP スコープでは許容する
      const tx = Math.floor(this.playerX)
      const ty = Math.floor(this.playerY)
      const ceiling = resolveCeilingHeight(this.ceilingHeights, tx, ty)
      const maxJumpZ = ceiling - this.playerGroundZ
      if (this.playerJumpZ >= maxJumpZ) {
        this.playerJumpZ = maxJumpZ
        if (this.playerVZ > 0) this.playerVZ = 0
      }
      if (this.playerJumpZ <= 0) {
        this.playerJumpZ = 0
        this.playerVZ = 0
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
    const rawPitchOffset = Math.round(Math.tan(this.playerPitch) * (h / 2))
    // 念のため [-h, h] にクランプ（pitch クランプ済みなので通常は ±0.4 rad ≈ ±42% h で収まる）
    const pitchOffsetPx = rawPitchOffset > h ? h : rawPitchOffset < -h ? -h : rawPitchOffset
    // ジャンプ（Issue #80 Phase 2-2）+ 床段差（Issue #84）→ カメラ高さ合算を Y px に換算。
    // totalCameraZ = playerGroundZ（足元の床高さ）+ playerJumpZ（ジャンプ相対高）
    // totalCameraZ が正でカメラが上 → 視点が高い → baseY が下シフト＝壁・NPC が下方向に見え、
    // プレイヤーが上から見下ろす感。符号規約は pitchOffsetPx と同じ（正で baseY が下シフト）。
    const totalCameraZ = this.playerGroundZ + this.playerJumpZ
    const rawCameraZOffset = Math.round(totalCameraZ * (h / 2))
    // pitch と同じく [-h, h] にクランプ（pitch との対称性、合算後の極端値を防ぐ）
    const cameraZOffsetPx = rawCameraZOffset > h ? h : rawCameraZOffset < -h ? -h : rawCameraZOffset
    // 描画関数に渡す合算オフセット。computeWallYRange / projectNpcToScreen の pitchOffsetPx 引数は
    // 「pitch 由来 + cameraZ 由来」の合算 Y シフトを受け取る契約に汎化済み（純粋関数側 JSDoc 参照）。
    const totalYOffsetPx = pitchOffsetPx + cameraZOffsetPx
    // 空・床ベタ塗りの境界 Y。Math.floor で整数化（h が奇数のときのサブピクセル値を避ける）+ [0, h] クランプ。
    const horizonY = Math.floor(h / 2 + totalYOffsetPx)
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
    const wallTopYBuffer = this.wallTopYBuffer
    // 壁を描画しなかった列は「遮蔽なし」扱いにするため screenHeight で埋める
    // （NPC mask 側で min(segEndY, wallTopY) と使うので、wallTopY=h なら制約がかからない）
    wallTopYBuffer.fill(h)

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
      // Issue #49 Phase 1 / #80 Phase 2: タイルごとの壁高さを適用。
      // wallHeight=1.0 なら従来挙動、0.5 なら腰高の柵、1.5 なら塔。
      // 地面位置（drawEndY）は wallHeight に依らず不変で、上端（drawStartY）が伸縮する。
      // Phase 2: 遠方カリングとフォグも壁高さに応じて伸長（高い塔はランドマークとして遠くまで見える）
      const wallHeight = hit ? this.getWallHeight(mapX, mapY) : 1
      const effectiveFogMax = computeEffectiveFogMaxDist(this.fogMaxDist, wallHeight)
      if (hit && perpDist <= effectiveFogMax + 0.5) {
        const lineHeight = Math.floor(h / perpDist)
        const fog = Math.max(0, Math.min(1, 1 - perpDist / effectiveFogMax))

        const { drawStartY, drawEndY } = computeWallYRange(
          lineHeight,
          wallHeight,
          h,
          totalYOffsetPx
        )
        const drawHeight = drawEndY - drawStartY

        // wallHeight<=0 で高さゼロ → 描画なし
        if (drawHeight <= 0) {
          stripeSprite.visible = false
          continue
        }

        // NPC mask の壁高さ連動遮蔽用に、実際に描画した壁の上端 Y を記録する（Issue #80 Phase 2）。
        // スプライト描画・ベタ塗り fallback の両経路で同じ drawStartY を書くので、この時点で一度だけ記録する
        wallTopYBuffer[i] = drawStartY

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
          // Issue #86 Phase 2-5: wallHeight<1 のとき texture 上端をクロップし、下部 wallHeight 分のみ
          // 1:1 スケールで表示する。pixel scale が wallHeight に依らず一定になり、レンガ模様が
          // 縦潰れしない。
          // Issue #93: wallHeight>1 のときは crop.tileCount に応じたスタックテクスチャ
          // （ベース 2 枚 or 3 枚を縦に並べた RenderTexture）から切り出して、タイリング描画する。
          // 引数は基底テクスチャ高さ（64）を渡す — frameY/frameHeight は tileCount*64 の座標系で
          // 返るので、スタックシートの列 source にそのまま frame として渡せる。
          const crop = computeWallTextureCrop(WALL_TEXTURE_HEIGHT, wallHeight)
          if (crop.frameHeight <= 0) {
            stripeSprite.visible = false
            continue
          }
          // tileCount=1 なら既存 sheet（ベース 1 枚）をそのまま使い、>=2 なら stacked sheet を取得。
          // stacked sheet は renderer ごと＋kind×tileCount ごとに WeakMap キャッシュされる。
          const wallKind: WallTextureKind = hitTile === TileType.WATER ? 'water' : 'tree'
          const effectiveSheet =
            crop.tileCount === 1
              ? sheet
              : getStackedWallSheet(this.app.renderer, wallKind, crop.tileCount)
          // effectiveSheet.columns[col] は base/stacked source を共有する派生 Texture なので、
          // source 経由で新しい frame を持つ Texture を都度 new する。前フレームの Texture は
          // GC に任せる（明示 destroy すると shared source を壊すリスクがあるため呼ばない）。
          const src = effectiveSheet.columns[col].source
          stripeSprite.texture = new Texture({
            source: src,
            frame: new Rectangle(col, crop.frameY, 1, crop.frameHeight),
          })
          stripeSprite.x = screenX
          // anchor.y=0 なので Sprite の上端を drawStartY に配置し、height で下端を決める。
          // wallHeight<1 のときは crop で texture 下部のみを取っているため、Sprite を drawHeight に
          // スケールしても pixel scale は通常時と同じ（lineHeight/textureHeight）。
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
        totalYOffsetPx
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

      // Sprite 配置とサイズ。anchor=(0.5,0.5) なので Y は baseY = h/2 + totalYOffsetPx に置く
      // （projectNpcToScreen の drawStartY/EndY と同じ baseY を共有させる。
      //  totalYOffsetPx = pitchOffsetPx + cameraZOffsetPx で pitch とジャンプを合算）
      n.sprite.x = spriteScreenX
      n.sprite.y = h / 2 + totalYOffsetPx
      n.sprite.width = spriteWidthPx
      n.sprite.height = spriteHeight
      n.container.visible = true
      // 距離ソート: 遠い NPC ほど先に描く → zIndex を小さく
      n.container.zIndex = -depth

      // mask 更新: zBuffer で遮蔽されていない列だけを可視にする。
      // Issue #80 Phase 2: 壁が前にあっても、壁の上端（wallTopYBuffer）より上にはみ出す部分は可視化する。
      //   低い壁（wallHeight=0.5）の奥にいる NPC の頭が壁の上から出る演出。
      // mask は npcLayer → container（ともに位置 0, 0）直下なので、rect 座標はキャンバス絶対座標と一致する
      n.mask.clear()
      let hasVisible = false
      for (let sx = drawStartX; sx < drawEndX; sx += this.stripeWidth) {
        const stripeIdx = Math.floor(sx / this.stripeWidth)
        if (stripeIdx < 0 || stripeIdx >= numStripes) continue
        let segEndY = drawEndY
        if (depth >= zBuffer[stripeIdx]) {
          // 壁が前にある列: 壁の上端（wallTopY）より上の部分のみ可視化
          const wallTopY = wallTopYBuffer[stripeIdx]
          if (wallTopY < segEndY) segEndY = wallTopY
          if (segEndY <= drawStartY) continue
        }
        n.mask.rect(sx, drawStartY, this.stripeWidth, segEndY - drawStartY)
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
    case 'z':
    case 'Z':
      return 'jump'
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
    k === 'pitch_down' ||
    k === 'jump'
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
