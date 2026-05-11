/**
 * PixiJS ベースの見下ろし型 RPG レンダラー。
 *
 * タイルマップ・プレイヤー・NPC を真上から描画し、キーボード入力で
 * プレイヤーをグリッド単位で動かす。隣接 NPC に Enter/Space で話しかけると
 * 会話ダイアログを表示する。RPG プレイモードのデフォルトビュー。
 */

import { Application, Container, Graphics, Sprite } from 'pixi.js'
import { UiNpcData, UiRpgTrigger, RPGProject, TILE_COLORS_HEX, TileType } from '../types/rpg'
import type { MonsterDef } from '../types'
import { DialogBox } from './DialogBox'
import { resolveNpcPortrait, stripExpressionDirectives } from './npcDialog'
import {
  NPC_ANIM_PERIOD_MS,
  clampFrames,
  clearDemoSheetCache,
  directionToRow,
  loadNpcSpriteSheet,
  type NpcSpriteSheet,
} from './npcSpriteSheet'
import { attachTouchInput, type SwipeDirection } from './touchInput'
import { TouchMenuOverlay, DQ4_COMMANDS, type Dq4CommandId } from './TouchMenuOverlay'
import { rollEncounter } from './encounter'
import { EventRunner, type NpcMover } from './eventRunner'

type Direction = 'up' | 'down' | 'left' | 'right'

interface NPC {
  data: UiNpcData
  container: Container
  x: number
  y: number
  /** スプライト（未ロード or 未指定 or ロード失敗なら null → color 四角描画） */
  sprite: Sprite | null
  sheet: NpcSpriteSheet | null
  /** アニメ位相オフセット（ms）。NPC ごとにずらして画一感を防ぐ */
  phaseOffset: number
  /** 現在の向き（data.direction または 'down'） */
  direction: Direction
}

/** once=true トリガーの発火済みフラグを localStorage に保存するキーを生成する (#198) */
export function triggerDoneKey(sceneName: string): string {
  return `name-name-trigger-done-${sceneName}`
}

export class TopDownRenderer {
  private app: Application
  private mapLayer: Container
  private npcLayer: Container
  private playerLayer: Container
  private world: Container
  private dialogBox: DialogBox | null = null
  private menuOverlay: TouchMenuOverlay | null = null
  private eventRunner: EventRunner | null = null
  private inputLocked = false
  private detachTouchInput: (() => void) | null = null
  /** isMoving 中に来たスワイプを 1 件だけキューする。連続スワイプの取りこぼし防止 (#178) */
  private pendingSwipe: Direction | null = null

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

  /** 確率エンカウント (#191) */
  private encounterRate: number = 0
  private encounterGroups: string[] = []
  private masterMonsters: Record<string, MonsterDef> = {}
  /** 戦闘直後の連続エンカウント抑止カウンタ。残歩数だけ抽選をスキップする */
  private encounterCooldown: number = 0

  private initialized = false
  private gameData: RPGProject | null = null

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

    this.dialogBox = new DialogBox({
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      boxHeight: 120,
      fontSize: 18,
      bgColor: 0x000033,
      nameColor: 0xffe066,
      nameSeparateBox: false,
    })
    this.app.stage.addChild(this.dialogBox)

    // EventRunner: NPC イベントのコマンドキューを順に実行する (#197)
    const npcMover: NpcMover = {
      moveNpcTo: (name, x, y, speed) => this.moveNpcTo(name, x, y, speed),
    }
    this.eventRunner = new EventRunner(this.dialogBox, npcMover)

    // ミニマップは raycast 専用 (#149)。topdown は元々全体俯瞰で見えているので不要。

    // タッチメニュー: DQ4 ファミコン版相当の左上 8 コマンドウィンドウ (#178 → #171)
    this.menuOverlay = new TouchMenuOverlay(
      this.screenWidth,
      this.screenHeight,
      this.handleMenuSelect,
      { items: DQ4_COMMANDS, position: 'top-left', layout: 'grid-4x2' }
    )
    this.app.stage.addChild(this.menuOverlay)

    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('resize', this.handleResize)
    this.app.ticker.add(this.onTick)

    // スワイプ移動 + シングルタップでメニュー開閉 (#178)
    this.detachTouchInput = attachTouchInput(this.app.canvas as HTMLCanvasElement, {
      onSwipe: this.handleSwipe,
      onTap: this.handleTap,
    })

    this.initialized = true
  }

  /** ゲームデータを読み込んで描画を開始する */
  load(gameData: RPGProject): void {
    // 状態リセット
    this.isMoving = false
    this.moveStart = 0
    this.dialogBox?.hide()
    this.inputLocked = false
    this.gameData = gameData

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

    // エンカウント設定 (#191)
    this.encounterRate = gameData.map.encounterRate ?? 0
    this.encounterGroups = gameData.map.encounterGroups ?? []
    this.masterMonsters = gameData.monsters ?? {}
    this.encounterCooldown = 0

    this.drawMap()
    this.drawNPCs(gameData.npcs)
    this.drawPlayer()
    this.updatePlayerPosition(
      this.gridToPixelX(this.playerGridX),
      this.gridToPixelY(this.playerGridY)
    )
    this.centerCamera()

    // マップ進入時 auto トリガー発火 (#198)
    this.fireAutoTriggers()
  }

  /**
   * 設定（テキスト速度・音量）を反映。Issue #138。
   * TopDownRenderer は現状 BGM/SE を持たないが、将来 AudioManager を統合した
   * 際の API 互換のため bgmVolume / seVolume も受け取る。
   */
  applySettings(settings: { msPerChar: number; bgmVolume: number; seVolume: number }): void {
    this.dialogBox?.setMsPerChar(settings.msPerChar)
    // BGM / SE は未実装。引数は将来用。
    void settings.bgmVolume
    void settings.seVolume
  }

  /** リソース解放 */
  destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('resize', this.handleResize)
    if (this.detachTouchInput) {
      this.detachTouchInput()
      this.detachTouchInput = null
    }
    if (this.resizeRaf !== null) {
      cancelAnimationFrame(this.resizeRaf)
      this.resizeRaf = null
    }
    if (this.initialized) {
      this.app.ticker.remove(this.onTick)
      // renderer 参照を先に保持してから app.destroy（children 連鎖で Sprite / 内部 Texture が破棄される）。
      // その後に cache 側の RenderTexture（source 共有元）を破棄 — 順序を逆にすると source を先に
      // destroy してしまい、子 Sprite が既に破棄済み source を再参照して壊れる可能性がある
      const renderer = this.app.renderer
      this.app.destroy(true, { children: true })
      clearDemoSheetCache(renderer)
      this.inputLocked = false
      this.eventRunner?.destroy()
      this.eventRunner = null
      this.dialogBox = null
      this.menuOverlay = null
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

  private drawNPCs(npcData: UiNpcData[]): void {
    this.clearLayer(this.npcLayer)
    this.npcs = []
    for (let i = 0; i < npcData.length; i++) {
      const data = npcData[i]
      const container = new Container()
      container.x = this.gridToPixelX(data.x)
      container.y = this.gridToPixelY(data.y)
      this.npcLayer.addChild(container)

      // color 四角は常に置いておく（スプライトがロードされるまでの placeholder を兼ねる）
      const rect = new Graphics()
      const size = this.tileSize - 4
      rect.rect(-size / 2, -size / 2, size, size)
      rect.fill(data.color)
      rect.stroke({ width: 2, color: 0x8b0000 })
      container.addChild(rect)

      // phaseOffset: アニメ周期内を NPC 数で等分した位相差を与え、全員が同時に足踏みして画一的に見えるのを防ぐ
      const stride = NPC_ANIM_PERIOD_MS / Math.max(1, npcData.length)
      const npc: NPC = {
        data,
        container,
        x: data.x,
        y: data.y,
        sprite: null,
        sheet: null,
        phaseOffset: i * stride,
        direction: data.direction ?? 'down',
      }
      this.npcs.push(npc)

      // sprite が指定されていれば非同期ロード → 完了したら rect を隠して Sprite を差し込む
      if (data.sprite) {
        this.loadNpcSprite(npc, rect)
      }
    }
  }

  private async loadNpcSprite(npc: NPC, placeholder: Graphics): Promise<void> {
    const sheet = await loadNpcSpriteSheet(
      npc.data.sprite!,
      clampFrames(npc.data.frames),
      this.tileSize,
      npc.data.color,
      this.app.renderer
    )
    // load 完了時点で NPC が破棄されていたら何もしない
    if (!this.initialized || npc.container.destroyed) return
    if (!sheet) return // 失敗時は color 四角のまま

    npc.sheet = sheet
    const sprite = new Sprite(sheet.textures[directionToRow(npc.direction)][0])
    sprite.anchor.set(0.5)
    npc.container.addChild(sprite)
    npc.sprite = sprite
    // placeholder を隠す
    placeholder.visible = false
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
        if (this.inputLocked && this.eventRunner?.isRunning) {
          this.eventRunner.advance()
        } else if (this.dialogBox.isTyping()) {
          // typewriter 表示中なら全文表示にスキップ、完了済みなら閉じる (#150)
          this.dialogBox.skipTypewriter()
        } else {
          this.dialogBox.hide()
        }
      }
      return
    }

    // イベントランナー実行中は移動・メニューをブロック (#197)
    if (this.inputLocked && this.eventRunner?.isRunning) {
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

    // 1 歩進んだので確率エンカウント抽選 (#191)
    this.maybeRollEncounter()

    // タイル踏み込みトリガー検出 (#198)
    this.checkStepTriggers(nx, ny)
  }

  /**
   * タイル踏み込み時にstepトリガーを照合し、マッチしたイベントを発火する (#198)
   */
  private checkStepTriggers(x: number, y: number): void {
    const triggers = this.gameData?.triggers
    if (!triggers || !this.eventRunner) return
    for (const trigger of triggers) {
      if (trigger.auto) continue
      if (trigger.x !== x || trigger.y !== y) continue
      this.fireTrigger(trigger)
    }
  }

  /**
   * マップ進入時にautoトリガーを全て発火する (#198)
   */
  private fireAutoTriggers(): void {
    const triggers = this.gameData?.triggers
    if (!triggers || !this.eventRunner) return
    for (const trigger of triggers) {
      if (!trigger.auto) continue
      this.fireTrigger(trigger)
    }
  }

  /**
   * トリガーのイベントを実行する。once=trueの場合は発火済みならスキップ (#198)
   */
  private fireTrigger(trigger: UiRpgTrigger): void {
    if (!this.eventRunner || !this.gameData) return
    const event = this.gameData.rpgEvents?.find((e) => e.name === trigger.scene)
    if (!event) return
    if (trigger.once) {
      const key = triggerDoneKey(trigger.scene)
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
    }
    this.inputLocked = true
    this.eventRunner.run(event.commands, () => {
      this.inputLocked = false
    })
  }

  private maybeRollEncounter(): void {
    if (this.encounterCooldown > 0) {
      this.encounterCooldown -= 1
      return
    }
    const enemies = rollEncounter({
      rate: this.encounterRate,
      groups: this.encounterGroups,
      masters: this.masterMonsters,
      rng: Math.random,
    })
    if (enemies && enemies.length > 0) {
      // TopDown では戦闘画面を RaycastRenderer のように持っていないため、
      // 現時点では console.info で記録するにとどめ、将来 BattleScreen 統合時に実装する。
      // TODO: BattleScreen 統合時は「エンカウント検出時」ではなく「戦闘終了（onClose）時」に
      //       encounterCooldown = 3 をセットするよう変更すること（RaycastRenderer と同方式にする）
      console.info(
        '[TopDownRenderer] encounter!',
        enemies.map((e) => e.name)
      )
      this.encounterCooldown = 3
    }
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
    if (this.inputLocked) return
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
    if (npc) {
      if (npc.data.scene) {
        if (!this.eventRunner) return
        const event = this.gameData?.rpgEvents?.find((e) => e.name === npc.data.scene)
        if (!event) return
        const trigger = this.gameData?.triggers?.find((t) => t.scene === npc.data.scene)
        const isOnce = trigger?.once ?? false
        if (isOnce) {
          const key = triggerDoneKey(npc.data.scene)
          if (localStorage.getItem(key)) return
          // run が確実に呼ばれる直前に書き込む
          localStorage.setItem(key, '1')
        }
        this.inputLocked = true
        this.eventRunner.run(event.commands, () => {
          this.inputLocked = false
        })
        return
      }
      this.dialogBox?.show(
        npc.data.name,
        stripExpressionDirectives(npc.data.message),
        resolveNpcPortrait(npc.data)
      )
    }
  }

  // --- タッチ入力 (#178) ---

  /**
   * スワイプ方向に応じて「向き変更 + 1 マス移動の試行」を行う。
   * tryMove 内部で playerDirection は先に更新されるため、移動できない場合（壁・NPC）でも
   * その方向に向きが変わる（DQ 同様）。ダイアログ表示中は移動を抑止する（向き変更も行わない）。
   */
  private handleSwipe = (direction: SwipeDirection): void => {
    if (!this.initialized) return
    if (this.inputLocked && this.eventRunner?.isRunning) return
    if (this.dialogBox?.isShowing) {
      // ダイアログ中のスワイプはダイアログ操作と分離。誤爆防止のため何もしない。
      return
    }
    if (this.menuOverlay?.isShowing()) {
      // メニュー表示中のスワイプはメニューを閉じる（誤って外側をなぞった場合の救済）
      this.menuOverlay.hideMenu()
      return
    }
    if (this.isMoving) {
      // 連続スワイプを取りこぼさないよう、最後の入力 1 件だけキューする。
      // 最後勝ちにすることで「速くスワイプし続けると古い方向に進む」違和感を避ける。
      this.pendingSwipe = direction
      return
    }
    this.tryMove(direction)
  }

  /**
   * タップは状態によって振る舞いが変わる:
   *   - ダイアログ表示中: typewriter 進行中なら全文表示にスキップ、完了済みなら閉じる
   *   - メニュー項目自身のタップ: メニュー側でハンドルされる（ここには来ない）
   *   - メニュー外のタップ: メニュー表示中なら閉じる
   *   - 通常時: メニューを開く
   */
  private handleTap = (): void => {
    if (!this.initialized) return
    if (this.dialogBox?.isShowing) {
      if (this.inputLocked && this.eventRunner?.isRunning) {
        this.eventRunner.advance()
      } else if (this.dialogBox.isTyping()) {
        this.dialogBox.skipTypewriter()
      } else {
        this.dialogBox.hide()
      }
      return
    }
    if (this.menuOverlay?.isShowing()) {
      this.menuOverlay.hideMenu()
      return
    }
    this.menuOverlay?.showMenu()
  }

  /**
   * DQ4 8 コマンド + サブメニューの選択結果を受ける (#171)。
   * 未実装コマンドは console.info で識別ログのみ。
   * 実機能は #172/#173/#174/#175 が揃ってから埋める。
   */
  private handleMenuSelect = (rawId: string): void => {
    this.menuOverlay?.hideMenu()
    const id = rawId as Dq4CommandId
    switch (id) {
      case 'talk':
        this.tryTalk()
        return
      case 'examine':
        // TODO #173 内装と連動: 足元タイルを調べる（隠しアイテム / 看板読み）
        console.info('[TopDownRenderer] しらべる: 未実装')
        return
      case 'door':
        // TODO #173 内装と連動: 正面の鍵付きドアを開く（鍵アイテム参照）
        console.info('[TopDownRenderer] とびら: 未実装')
        return
      case 'item':
      case 'status':
      case 'tactics':
      case 'spell':
      case 'equip':
        // 親をそのまま選んだ場合（submenu が空のときに来うる）。今は no-op
        return
      case 'item:none':
      case 'spell:none':
      case 'status:hero':
      case 'equip:hero':
      case 'tactics:bravely':
      case 'tactics:safely':
      case 'tactics:no-spell':
        // サブ leaf は機能 Issue で実装。今は識別ログのみ。
        console.info(`[TopDownRenderer] sub menu '${id}' は未実装`)
        return
      default: {
        // 網羅検査: 新しい id を増やしたら ここで型エラーになる
        const _exhaustive: never = id
        void _exhaustive
        console.info(`[TopDownRenderer] menu select '${rawId}' は未実装`)
      }
    }
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
      this.menuOverlay?.redraw(this.screenWidth, this.screenHeight)
      this.centerCamera()
    })
  }

  // --- ティック ---

  private onTick = (): void => {
    const now = performance.now()
    this.updateNpcAnimations(now)
    if (!this.isMoving) return
    const t = Math.min(1, (now - this.moveStart) / this.moveDuration)
    const x = this.moveFromX + (this.moveToX - this.moveFromX) * t
    const y = this.moveFromY + (this.moveToY - this.moveFromY) * t
    this.updatePlayerPosition(x, y)
    this.centerCamera()
    if (t >= 1) {
      this.isMoving = false
      // キューされたスワイプがあれば次の移動を即座に発火（連続スワイプの滑らかさ）#178
      if (
        this.pendingSwipe &&
        !this.inputLocked &&
        !this.dialogBox?.isShowing &&
        !this.menuOverlay?.isShowing()
      ) {
        const next = this.pendingSwipe
        this.pendingSwipe = null
        this.tryMove(next)
      } else {
        this.pendingSwipe = null
      }
    }
  }

  /** NPC アニメ: アイドル足踏みだけ。位相オフセットで画一感を防ぐ */
  private updateNpcAnimations(nowMs: number): void {
    for (const npc of this.npcs) {
      if (!npc.sprite || !npc.sheet) continue
      const frames = npc.sheet.frames
      if (frames < 2) continue
      const frame = Math.floor((nowMs + npc.phaseOffset) / NPC_ANIM_PERIOD_MS) % frames
      const row = directionToRow(npc.direction)
      npc.sprite.texture = npc.sheet.textures[row][frame]
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

  /** NPC をグリッド単位でアニメ移動させる。完了したら resolve する Promise を返す (#197) */
  private moveNpcTo(name: string, tx: number, ty: number, speed: number): Promise<void> {
    return new Promise((resolve) => {
      const npc = this.npcs.find((n) => n.data.name === name)
      if (!npc) {
        resolve()
        return
      }
      const TILE = this.tileSize
      const pxPerMs = (TILE * speed) / 1000

      const moveNextTile = (): void => {
        if (npc.x === tx && npc.y === ty) {
          resolve()
          return
        }
        const dx = Math.sign(tx - npc.x)
        const dy = Math.sign(ty - npc.y)
        const fromX = npc.container.x
        const fromY = npc.container.y
        npc.x += dx
        npc.y += dy
        const toX = this.gridToPixelX(npc.x)
        const toY = this.gridToPixelY(npc.y)

        // 向き更新
        if (dx === 1) npc.direction = 'right'
        else if (dx === -1) npc.direction = 'left'
        else if (dy === 1) npc.direction = 'down'
        else if (dy === -1) npc.direction = 'up'

        const dist = TILE
        const duration = dist / pxPerMs
        const start = performance.now()

        const tick = (): void => {
          if (!this.initialized || npc.container.destroyed) {
            resolve()
            return
          }
          const elapsed = performance.now() - start
          const t = Math.min(elapsed / duration, 1)
          npc.container.x = fromX + (toX - fromX) * t
          npc.container.y = fromY + (toY - fromY) * t
          if (t < 1) {
            requestAnimationFrame(tick)
          } else {
            npc.container.x = toX
            npc.container.y = toY
            moveNextTile()
          }
        }
        requestAnimationFrame(tick)
      }
      moveNextTile()
    })
  }
}
