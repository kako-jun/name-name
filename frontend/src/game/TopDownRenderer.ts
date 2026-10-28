/**
 * PixiJS ベースの見下ろし型 RPG レンダラー。
 *
 * タイルマップ・プレイヤー・NPC を真上から描画し、キーボード入力で
 * プレイヤーをグリッド単位で動かす。隣接 NPC に Enter/Space で話しかけると
 * 会話ダイアログを表示する。RPG プレイモードのデフォルトビュー。
 */

import { Application, Assets, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { UiNpcData, UiRpgTrigger, RPGProject, TILE_COLORS_HEX, TileType } from '../types/rpg'
import type { MonsterDef, PartyMemberDef } from '../types'
import { DialogBox } from './DialogBox'
import { resolveNpcPortrait, stripExpressionDirectives } from './npcDialog'
import { resolveRpgImagePath } from './novelLayout'
import {
  NPC_ANIM_PERIOD_MS,
  clampFrames,
  clearDemoSheetCache,
  directionToRow,
  loadNpcSpriteSheet,
  type NpcSpriteSheet,
} from './npcSpriteSheet'
import {
  attachTouchInput,
  DIALOG_JUST_SHOWN_GUARD_MS,
  suppressNextTouchTap,
  type SwipeDirection,
} from './touchInput'
import { TouchMenuOverlay, DQ4_COMMANDS, type Dq4CommandId } from './TouchMenuOverlay'
import { rollEncounter } from './encounter'
import { EventRunner, type EventEmotionHost, type NpcMover } from './eventRunner'
import type { BattleScreen } from './BattleScreen'
import type { BattleEntity } from './spellDsl'
import type { BattleResult } from './loot'
import {
  DEFAULT_FIELD_BATTLE_SETTINGS,
  FieldInputGate,
  buildScriptedBattle,
  closeFieldBattle,
  openFieldBattle,
  readFieldBattleSettings,
  type FieldBattleSettings,
  type ScriptedBattleSetup,
} from './fieldBattle'
import type { BattleEffects } from './battleEffects'
import { loadBattleEffects } from './battleEffectsLoader'
import { FieldEmotionLayer } from './FieldEmotionLayer'
import { createFieldEmotionHost } from './fieldScript'
import { EMOTION_DEFAULT_DURATION_MS, type EmotionSheets, type EmotionTarget } from './fieldEmotion'
import {
  canShowTopDownEmotion,
  loadTopDownEmotionSheets,
  topDownEmotionContext,
  topDownEmotionHeads,
} from './topDownEmotion'
import { battleTransitionParams, isBattleTransitionEnabled } from './battleTransition'
import { FieldBattleTransition, type FieldBattleTransitionHooks } from './fieldBattleTransition'

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

/** 読み込み中に溜める `[感情:]` の上限 (#943) */
const MAX_PENDING_EMOTIONS = 32

/** 感情吹き出しの絵を読み込む。読めなかった種類は null（その種類は出さない。ゲームは止めない） (#943) */
async function loadEmotionTextures(sheets: EmotionSheets): Promise<Map<string, Texture | null>> {
  const textures = new Map<string, Texture | null>()
  await Promise.all(
    [...new Set(Object.values(sheets).map((sheet) => sheet.image))].map(async (image) => {
      try {
        textures.set(image, (await Assets.load(image)) as Texture)
      } catch (e) {
        console.warn(
          `[name-name] 感情吹き出しの画像を読めません（その種類は出しません）: ${e instanceof Error ? e.message : String(e)}`
        )
        textures.set(image, null)
      }
    })
  )
  return textures
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
  /** プロジェクトのアセットのベース URL (#746)。NPC スプライト・NPC 顔の画像パス解決に使う。未設定ならパスをそのまま読む */
  private assetBaseUrl: string | undefined = undefined
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
  /** パーティマスター。戦闘の味方に使う（RaycastRenderer と同じ） */
  private masterParty: Record<string, PartyMemberDef> = {}
  private masterPartyOrder: string[] = []
  private masterSpells: Record<string, import('../types').SpellDef> | undefined
  private masterSkills: Record<string, import('../types').SkillDef> | undefined
  private masterStatuses: Record<string, import('../types').StatusDef> | undefined
  private masterMagicites: Record<string, import('../types').MagiciteDef> | undefined
  private masterJobs: Record<string, import('../types').JobDef> | undefined
  /** アイテムマスター (#831)。戦利品のログの表示名だけに使う */
  private masterItems: Record<string, import('../types').ItemDef> | undefined
  /** 戦闘が終わって画面を畳んだ直後に結果（経験値・ゴールド・戦利品）を受け取るホスト側のハンドラ (#831) */
  private battleEndHandler: ((result: BattleResult) => void) | undefined
  /** 脚本制御の戦闘 (#741) の結果を待っている `startScriptedBattle` の解決関数。戦闘が普通に終わったときに結果で解決する */
  private scriptedResolve: ((result: BattleResult | null) => void) | null = null
  /** 戦闘画面の設定（frontmatter 由来）。読み方と既定値は fieldBattle.ts が正本 (#784) */
  private battleSettings: FieldBattleSettings = { ...DEFAULT_FIELD_BATTLE_SETTINGS }
  /** `battle_effects` (#941) の読み込み済み宣言と、再 load で古い読み込みを捨てるための世代 */
  private battleEffects: BattleEffects | undefined = undefined
  private battleEffectsToken = 0
  /** 感情吹き出し (#943)。`field_emotions` の宣言が読めたときだけ層を持つ（無ければ null＝`[感情:]` は警告して読み飛ばし）。再 load で古い読み込みを捨てる世代 */
  private emotionSheets: EmotionSheets | undefined = undefined
  private emotionLayer: FieldEmotionLayer | null = null
  private emotionToken = 0
  /** `field_emotions` の読み込み中か。読み込み中の `[感情:]` は `pendingEmotions` に溜める（上限 `MAX_PENDING_EMOTIONS`） */
  private emotionLoading = false
  private pendingEmotions: { target: string; kind: string; durationMs?: number; at: number }[] = []
  /** 吹き出しの絵の読み込み（テストで差し替える） */
  private loadEmotionTextures = loadEmotionTextures
  /** 戦闘画面。非 null の間はフィールドの入力・移動・エンカウント判定を止める (#784) */
  private battleScreen: BattleScreen | null = null
  /** 戦闘の開始・終了の画面遷移 (#830)。`battle_transition: ff` / `ff-mosaic` のときだけ使う。演出中の状態はここが private で持つ */
  private transition: FieldBattleTransition
  /** 戦闘をまたぐキー入力状態（押下中の矢印キー・離すまで無視・設定中の停止）(#204 / #784) */
  private inputGate = new FieldInputGate()
  /** エンカウントで戦闘に入った歩の踏み込みトリガー。戦闘終了後に発火する */
  private deferredStepTrigger: { x: number; y: number } | null = null
  private lastTickMs = 0

  private initialized = false
  private gameData: RPGProject | null = null

  constructor() {
    this.app = new Application()
    this.transition = new FieldBattleTransition(() => this.app.stage)
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
    this.eventRunner = this.createEventRunner(this.dialogBox, npcMover)

    // ミニマップは raycast 専用 (#149)。topdown は元々全体俯瞰で見えているので不要。

    // タッチメニュー: DQ4 ファミコン版相当の左上 2 列 x 4 行コマンドウィンドウ (#178 → #171)
    this.menuOverlay = new TouchMenuOverlay(
      this.screenWidth,
      this.screenHeight,
      this.handleMenuSelect,
      { items: DQ4_COMMANDS, position: 'top-left', layout: 'grid-2x4' }
    )
    this.app.stage.addChild(this.menuOverlay)

    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('blur', this.handleBlur)
    this.lastTickMs = performance.now()
    this.app.ticker.add(this.onTick)

    // スワイプ移動 + シングルタップでメニュー開閉 (#178)
    this.detachTouchInput = attachTouchInput(this.app.canvas as HTMLCanvasElement, {
      onSwipe: this.handleSwipe,
      onTap: this.handleTap,
    })

    this.initialized = true
  }

  /**
   * 戦闘の結果（経験値・ゴールド・獲得した戦利品、#831）を受け取るハンドラを登録する。
   * 戦闘画面を畳んだ直後（`battle_transition: ff` / `ff-mosaic` では暗転の最も暗い瞬間）に 1 戦闘につき 1 回呼ぶ。
   * エンジンは所持品を持たないので、反映や戦利品の画面を出すのはホスト側。強制終了（`load` / `destroy`）では呼ばない
   */
  setBattleEndHandler(handler: ((result: BattleResult) => void) | undefined): void {
    this.battleEndHandler = handler
  }

  /**
   * 脚本制御の戦闘 (`[戦闘 <id>]`、#741) を始める。`[イベント]` の `[戦闘: id]` が呼ぶほか、ホストが直接呼んでもよい。
   * 終わったら結果（`BattleResult.script` に結果フラグ・次のイベントが入る）で解決する。結果は `setBattleEndHandler` のハンドラにも渡る。
   * 始められなかった（宣言が無い・敵が組めない・すでに戦闘中）は null で解決する。戦闘中に `load` / `destroy` で強制終了されたときは解決しない
   */
  startScriptedBattle(id: string): Promise<BattleResult | null> {
    const def = this.gameData?.battleScripts
    if (!def || !Object.prototype.hasOwnProperty.call(def, id)) {
      console.warn(`[TopDownRenderer] 戦闘 '${id}' の宣言（[戦闘 ${id}]）が無い`)
      return Promise.resolve(null)
    }
    if (this.battleBusy || this.scriptedResolve) return Promise.resolve(null)
    const setup = buildScriptedBattle(
      def[id],
      this.masterMonsters,
      {
        party: this.masterParty,
        order: this.masterPartyOrder,
        spells: this.masterSpells,
        skills: this.masterSkills,
        statuses: this.masterStatuses,
        ...(this.masterMagicites ? { magicites: this.masterMagicites } : {}),
        ...(this.masterJobs ? { jobs: this.masterJobs } : {}),
        items: this.masterItems,
      },
      this.battleSettings.layout,
      Math.random
    )
    if (!setup) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.scriptedResolve = resolve
      if (!this.startBattle(setup.enemies, setup)) {
        this.scriptedResolve = null
        resolve(null)
      }
    })
  }

  /** アセットのベース URL を設定する (#746)。`load()` より前に呼ぶ */
  setAssetBaseUrl(url: string | undefined): void {
    this.assetBaseUrl = url
  }

  /** ゲームデータを読み込んで描画を開始する */
  load(gameData: RPGProject): void {
    // 戦闘中に再 load されたら戦闘画面を畳む（古い onClosed が新しいマップの状態を上書きしないよう強制終了）
    this.closeBattle()
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
    this.masterParty = gameData.party ?? {}
    this.masterPartyOrder = gameData.partyOrder ?? []
    this.masterSpells = gameData.spells
    this.masterSkills = gameData.skills
    this.masterStatuses = gameData.statuses
    this.masterMagicites = gameData.magicites
    this.masterJobs = gameData.jobs
    this.masterItems = gameData.items
    this.battleSettings = readFieldBattleSettings(gameData)
    // エフェクト重ね (#941)。JSON は非同期に読む（読み終わる前に始まった戦闘はエフェクトなし）
    this.battleEffects = undefined
    const effectsToken = ++this.battleEffectsToken
    // 古い読み込み（再 load・destroy 後に届いた結果）は世代トークンで捨てる。判定はここ 1 か所
    void loadBattleEffects(gameData.battleEffects, this.assetBaseUrl).then((e) => {
      if (effectsToken === this.battleEffectsToken) this.battleEffects = e
    })
    this.startEmotionLoad(gameData.fieldEmotions)
    this.encounterCooldown = 0
    this.deferredStepTrigger = null
    this.pendingSwipe = null
    this.lastTickMs = performance.now()
    this.inputGate.resetHeld()

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

  /**
   * 設定オーバーレイなど外側の UI が開いている間、入力を止める (#784)。true の間はフィールドの移動キーも
   * 戦闘のキー操作（BattleScreen の isInputSuspended 経由）も受け付けない。
   */
  setInputSuspended(suspended: boolean): void {
    this.inputGate.setSuspended(suspended)
  }

  /**
   * 戦闘の画面遷移 (#830) のフック。`onTransitionBeat(n)`＝開始のズーム各段の始まり（「ドゥン」の音のきっかけ）、
   * `interlude(outcome)`＝終了の黒の間に挟む追加画面（戦利品の画面 #831 用。既定は何も挟まない）。
   */
  setBattleTransitionHooks(hooks: FieldBattleTransitionHooks): void {
    this.transition.hooks = hooks
  }

  /** 戦闘の画面遷移の演出中（入力・移動・エンカウントを止める）か (#830) */
  private get battleBusy(): boolean {
    return this.battleScreen !== null || this.transition.active
  }

  /** リソース解放 */
  destroy(): void {
    this.closeBattle()
    this.battleEffectsToken++ // 読み込み中の battle_effects の結果を捨てる (#941)
    this.resetEmotions() // 読み込み中の field_emotions の結果も捨てる (#943)
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('blur', this.handleBlur)
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
      this.battleScreen = null
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
      resolveRpgImagePath(this.assetBaseUrl, npc.data.sprite!),
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

    // 押下中の矢印キーは戦闘開始時に BattleScreen へ渡す（戦闘中・停止中・repeat でも追跡する）(#784)
    this.inputGate.trackKeyDown(e.key)

    // キーリピートはすべて無視（ダイアログちらつき・移動過剰対策）
    if (e.repeat) return

    // 戦闘中はフィールドの操作を受け付けない（戦闘画面の矢印キーで裏のプレイヤーが動くのを防ぐ）(#784)
    if (this.battleBusy) return
    // 設定オーバーレイなど外側の UI が入力を止めている間は受け付けない
    if (this.inputGate.isSuspended) return
    // 戦闘終了時に押しっぱなしだったキーは、一度離されるまで移動に使わない
    // （TopDown は repeat を上で弾くので実質は保険。Raycast と規約を揃えて残す）
    if (this.inputGate.isReleaseGated(e.key)) return

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

  /** ウィンドウがフォーカスを失うと keyup が届かないので、押下状態を捨てる (#784) */
  private handleBlur = (): void => {
    this.inputGate.blur()
  }

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (!this.initialized) return
    this.inputGate.trackKeyUp(e.key)
  }

  private tryMove(direction: Direction): void {
    // inputLocked 中は移動を受け付けない。handleKeyDown / handleSwipe 側でもガードしているが、
    // 将来の呼び出し元追加時の安全網として tryMove 自体でも確認する (#198)
    if (this.inputLocked) return
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

    // 1 歩進んだので確率エンカウント抽選 (#191)。戦闘に入ったら踏み込みトリガーは戦闘後に回す
    if (this.maybeRollEncounter()) {
      this.deferredStepTrigger = { x: nx, y: ny }
      return
    }

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
   *
   * `load()` から呼ばれるため、マップを再訪（load 再呼び出し）するたびに実行される。
   * once=false の auto トリガーはマップ再訪のたびに発火する（意図的な仕様）。
   * once=true の auto トリガーは初回進入時のみ発火し、以後はフラグでスキップされる。
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
    if (!event) {
      console.warn(`[TopDownRenderer] trigger scene not found: "${trigger.scene}"`)
      return
    }
    if (trigger.once) {
      const key = triggerDoneKey(trigger.scene)
      if (localStorage.getItem(key)) return
      // EventRunner.run() は同期的にキューを設定して step() を呼ぶだけであり、
      // 例外を throw しない設計（eventRunner.ts: run() 参照）。
      // この前提のもと「run() の直前に書き込む」ことで
      // 「run が呼ばれたが onComplete が未発火」状態でもフラグが重複発火を防ぐ。
      localStorage.setItem(key, '1')
    }
    this.inputLocked = true
    this.eventRunner.run(event.commands, () => {
      this.inputLocked = false
    })
  }

  /** 1 歩ごとのエンカウント抽選。戦闘に入ったら true (#191 / #784) */
  private maybeRollEncounter(): boolean {
    if (this.battleBusy) return false // 戦闘中（開始・終了の演出中を含む）
    if (this.encounterCooldown > 0) {
      this.encounterCooldown -= 1
      return false
    }
    const enemies = rollEncounter({
      rate: this.encounterRate,
      groups: this.encounterGroups,
      masters: this.masterMonsters,
      rng: Math.random,
    })
    if (!enemies || enemies.length === 0) return false
    return this.startBattle(enemies)
  }

  /**
   * 戦闘画面を起動する (#784)。組み立て・キー規約・終了時の畳み方は RaycastRenderer と共通 (fieldBattle.ts)。
   * 終了（勝利・逃走・全滅）でフィールドに戻り、エンカウントのクールダウンを 3 歩セットする（RaycastRenderer と同方式）。
   */
  private startBattle(enemies: BattleEntity[], scripted?: ScriptedBattleSetup): boolean {
    if (this.battleBusy) return false // 多重起動防止
    if (enemies.length === 0) return false
    // キューされたスワイプは戦闘後に持ち越さない
    this.pendingSwipe = null
    const open = (): void => {
      this.battleScreen = openFieldBattle({
        stage: this.app.stage,
        width: this.screenWidth,
        height: this.screenHeight,
        settings: this.battleSettings,
        roster: {
          party: this.masterParty,
          order: this.masterPartyOrder,
          spells: this.masterSpells,
          skills: this.masterSkills,
          statuses: this.masterStatuses,
          ...(this.masterMagicites ? { magicites: this.masterMagicites } : {}),
          ...(this.masterJobs ? { jobs: this.masterJobs } : {}),
          items: this.masterItems,
        },
        enemies,
        ...(scripted ? { scripted } : {}),
        gate: this.inputGate,
        assetBaseUrl: this.assetBaseUrl,
        ...(this.battleEffects ? { effects: this.battleEffects } : {}),
        transition: this.transition,
        onClosed: (outcome, result) => {
          this.battleScreen = null
          this.pendingSwipe = null
          this.battleEndHandler?.(result)
          // 脚本制御の戦闘 (#741) を待っているイベントがあれば、結果で再開させる（ハンドラのあと）
          const resolve = this.scriptedResolve
          this.scriptedResolve = null
          resolve?.(result)
          // 戦闘直後 3 歩はエンカウントしない（DQ4 式の連続エンカウント抑止）
          this.encounterCooldown = 3
          // 戦闘に入った歩の踏み込みトリガーを、戦闘が終わってから発火する
          const deferred = this.deferredStepTrigger
          this.deferredStepTrigger = null
          // 全滅（defeat）では発火しない
          if (deferred && outcome !== 'defeat') this.checkStepTriggers(deferred.x, deferred.y)
        },
      })
    }
    if (isBattleTransitionEnabled(this.battleSettings.transition)) {
      this.transition.setParams(battleTransitionParams(this.battleSettings.transition))
      // 開始の演出 (#830): 操作キャラの画面上の位置を中心に 2 段ズームして暗転 → 戦闘画面
      // 発火は歩き出しの瞬間なので、歩いている間も追従するよう毎フレーム計算する
      const focus = (): { x: number; y: number } =>
        this.playerContainer
          ? { x: this.world.x + this.playerContainer.x, y: this.world.y + this.playerContainer.y }
          : { x: this.screenWidth / 2, y: this.screenHeight / 2 }
      this.transition.playEnter(this.screenWidth, this.screenHeight, focus, open)
      return true
    }
    open()
    return true
  }

  /** 戦闘画面があれば畳む（onClosed は呼ばない）。load() / destroy() 用 */
  private closeBattle(): void {
    this.transition.cancel()
    // 強制終了では、結果を待っていたイベントごと捨てる（古い続きが新しい状態で動かない）。解決はしない
    if (this.scriptedResolve) {
      this.scriptedResolve = null
      this.eventRunner?.destroy()
    }
    if (!this.battleScreen) return
    closeFieldBattle(this.app.stage, this.battleScreen)
    this.battleScreen = null
    this.deferredStepTrigger = null
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
          // EventRunner.run() は例外を throw しない設計のため、
          // run() の直前に書き込むことで重複発火を安全に防ぐ（fireTrigger と同方針）。
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
        resolveRpgImagePath(this.assetBaseUrl, resolveNpcPortrait(npc.data))
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
    if (this.battleBusy) return // 戦闘中（演出中を含む）はフィールドを動かさない (#784)
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
    if (this.battleBusy) return // 戦闘中（演出中を含む）はフィールドのメニューを開かない (#784)
    if (this.dialogBox?.isShowing) {
      // ダイアログを開いた直後 (< DIALOG_JUST_SHOWN_GUARD_MS) は advance / skip / hide すべて
      // 無視する。メニュー → tryTalk → dialog.show 直後、または EventRunner の Dialog/Narration
      // コマンドで dialog.show された直後に到達した tap で dialog がすぐ進む/閉じる事故を防ぐ。
      if (this.dialogBox.isJustShown(DIALOG_JUST_SHOWN_GUARD_MS)) {
        return
      }
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
    // 同一ジェスチャ内の漏れ tap で直後の handleTap が走らないよう、suppression を再延長する。
    // DialogBox.isJustShown は時刻ベースの保険、こちらは「同じ tap シーケンスは確実に弾く」一次防衛。
    suppressNextTouchTap(DIALOG_JUST_SHOWN_GUARD_MS)
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
      // 戦闘中に画面サイズが変わったら戦闘画面も再配置する
      this.battleScreen?.redraw(this.screenWidth, this.screenHeight)
      this.transition.resize(this.screenWidth, this.screenHeight)
      this.centerCamera()
    })
  }

  // --- ティック ---

  private onTick = (): void => {
    const now = performance.now()
    const dt = Math.max(0, Math.min(0.1, (now - this.lastTickMs) / 1000))
    this.lastTickMs = now
    // 戦闘中の時間を進める。ATB (#205) はゲージ（演出中も進む）、`battle_presentation: ff` (#745) は演出（モーション・ダメージ数字）。
    // 勝利・全滅を読ませる待機 (#745 分割4) も tick で進むので、dq の従来ターン制でも毎フレーム呼ぶ（呼ばないと戦闘画面が閉じない）。
    // 設定オーバーレイ中は入力と同様に進行も止める (#784)
    if (!this.inputGate.isSuspended) {
      this.battleScreen?.tick(dt * 1000)
      this.transition.tick(dt * 1000) // 開始・終了の画面遷移 (#830)
    }
    this.updateNpcAnimations(now)
    this.tickEmotions(dt * 1000)
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
        !this.battleBusy &&
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

  /** NPC イベントの実行器。`emotionHost` の配線（#943）もここ（テストから担保できるよう init から切り出している） */
  private createEventRunner(dialogBox: DialogBox, npcMover: NpcMover): EventRunner {
    return new EventRunner(
      dialogBox,
      npcMover,
      {
        startBattle: (id) => this.startScriptedBattle(id),
        findEvent: (name) => this.gameData?.rpgEvents?.find((e) => e.name === name)?.commands,
      },
      this.createEmotionHost()
    )
  }

  /** 感情吹き出しの層を捨てて世代を進める（再 load・destroy）。NPC の吹き出しはマップごとに消える (#943) */
  private resetEmotions(): void {
    this.emotionToken++
    this.emotionLayer?.destroy()
    this.emotionLayer = null
    this.emotionSheets = undefined
    this.emotionLoading = false
    this.pendingEmotions = []
  }

  /**
   * `field_emotions` を読んで層を作る (#943)。読み込み中に出た `[感情:]`（マップ進入時の auto トリガーなど）は
   * `pendingEmotions` に溜め、層ができた時点で残りの持続で再生する。失敗・宣言なしは溜めた分を捨てて警告を 1 回だけ出す
   */
  private startEmotionLoad(path: string | undefined): void {
    this.resetEmotions()
    if (!path) return
    const token = this.emotionToken
    this.emotionLoading = true
    const fail = (): void => {
      const dropped = this.pendingEmotions.length
      this.emotionLoading = false
      this.pendingEmotions = []
      if (dropped > 0)
        console.warn(
          `[name-name] field_emotions を読み込めなかったため、読み込み中の [感情:] ${dropped} 件を出せません`
        )
    }
    void loadTopDownEmotionSheets(path, this.assetBaseUrl).then(async (sheets) => {
      if (token !== this.emotionToken) return
      if (!sheets) return fail()
      const textures = await this.loadEmotionTextures(sheets)
      // 読み込み中に再 load・destroy されたら捨てる
      if (token !== this.emotionToken || !this.initialized) return
      this.emotionSheets = sheets
      this.emotionLayer = new FieldEmotionLayer(sheets, textures)
      this.world.addChild(this.emotionLayer)
      this.emotionLoading = false
      const pending = this.pendingEmotions
      this.pendingEmotions = []
      const host = this.createEmotionHost()
      const now = performance.now()
      for (const q of pending) {
        const base = q.durationMs ?? sheets[q.kind]?.durationMs ?? EMOTION_DEFAULT_DURATION_MS
        const remaining = Math.floor(base - (now - q.at))
        if (remaining > 0) host.showEmotion(q.target, q.kind, remaining)
      }
    })
  }

  /** EventRunner の `emotionHost`。対象名は「主人公／このマップの NPC の名前」で解決する (#943) */
  private createEmotionHost(): EventEmotionHost {
    const host = createFieldEmotionHost(
      () =>
        topDownEmotionContext(
          this.emotionSheets ?? {},
          this.gameData?.protagonist,
          this.npcs.map((n) => ({ id: n.data.id, name: n.data.name }))
        ),
      (target, kind, durationMs) => this.showEmotion(target as EmotionTarget, kind, durationMs),
      undefined,
      '[name-name]'
    )
    return {
      showEmotion: (target, kind, durationMs) => {
        // 読み込み中は宣言が分からない（「未宣言」と誤警告しない）。溜めて、層ができたら再生する
        if (this.emotionLoading) {
          if (this.pendingEmotions.length < MAX_PENDING_EMOTIONS)
            this.pendingEmotions.push({ target, kind, durationMs, at: performance.now() })
          return
        }
        host.showEmotion(target, kind, durationMs)
      },
    }
  }

  /** 脚本の `[感情:]` の出し口。戦闘中・同行者（TopDown に居ない）・別マップの NPC・絵が読めない種類は false */
  private showEmotion(target: EmotionTarget, kind: string, durationMs?: number): boolean {
    if (!this.emotionLayer) return false
    const npcIds = new Set(this.npcs.map((n) => n.data.id))
    if (!canShowTopDownEmotion(target, { battleBusy: this.battleBusy, npcIds })) return false
    return this.emotionLayer.show(target, kind, durationMs)
  }

  /** 吹き出しの時間を進めて人物の頭上に置き直す。戦闘中は消す。設定オーバーレイ中は他の進行と同じく止める */
  private tickEmotions(dtMs: number): void {
    const layer = this.emotionLayer
    if (!layer) return
    if (this.battleBusy) {
      layer.clear()
      return
    }
    if (this.inputGate.isSuspended) return
    const size = this.tileSize - 4
    layer.tick(
      dtMs,
      topDownEmotionHeads(
        this.playerContainer
          ? { x: this.playerContainer.x, y: this.playerContainer.y, height: size }
          : null,
        this.npcs.map((n) => ({
          id: n.data.id,
          x: n.container.x,
          y: n.container.y,
          height: n.sprite ? n.sprite.height : size,
        }))
      )
    )
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
