/**
 * PixiJS ベースのノベルレンダラー
 *
 * Event[] を受け取り、クリック/タップ/キーボードで進行する。
 * - Dialog/Narration: text[] の各要素を1つずつ表示（カノソ方式 = 一瞬表示）
 * - 改行 = テキスト送り、空行 = 改ページ（ボックス内テキストクリア）
 * - Background: 背景画像表示（アスペクト比維持カバー）
 * - Blackout: 暗転/暗転解除
 * - SceneTransition: 背景クリア + 暗転解除
 * - BGM: ループ再生、切り替え、フェードアウト停止
 * - SE: 単発再生（複数同時可）
 */

import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text as PixiText,
  Texture,
  TextStyle,
} from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'
import { DialogBox } from './DialogBox'
import { ensureFontLoaded } from './FontLoader'
import { AudioManager } from './AudioManager'
import {
  BackgroundFade,
  GameState,
  NovelGameState,
  StartFromOptions,
  Step,
  resolveEvents,
} from './GameState'
import { buildEdgeFadeMask, normalizeEdgeFade } from './edgeFadeMask'
import { VideoLayer } from './VideoLayer'
import { ChoiceOverlay } from './ChoiceOverlay'
import { SaveManager, SaveSlotData } from './SaveManager'
import { SaveLoadOverlay } from './SaveLoadOverlay'
import { BacklogOverlay } from './BacklogOverlay'
import { SeekBar } from './SeekBar'
import { computeDisplayIndex, findHistoryIndexForDisplayIndex } from './seekMapping'
import { Event, EventScene } from '../types'
import { ASPECT_RATIOS, type AspectRatio, parseAspectRatio } from './constants'
import { isRead, loadReadProgress, markRead } from './readProgress'
import { TimeController, defaultTimeController } from './TimeController'

/** Dialog / Narration から text を取り出すヘルパー */
export function getTextEvent(event: Event):
  | {
      type: 'dialog'
      character: string | null
      expression: string | null
      position: string | null
      text: string[]
    }
  | { type: 'narration'; text: string[] }
  | null {
  if (typeof event === 'object' && event !== null) {
    if ('Dialog' in event) {
      return {
        type: 'dialog',
        character: event.Dialog.character,
        expression: event.Dialog.expression,
        position: event.Dialog.position,
        text: event.Dialog.text,
      }
    }
    if ('Narration' in event) {
      return { type: 'narration', text: event.Narration.text }
    }
  }
  return null
}

/**
 * 各端の生 fade 値（parser / セーブデータ由来）を正規化して BackgroundFade | null を返す (#250)。
 *
 * 実体は #252 で `edgeFadeMask` の共通関数 `normalizeEdgeFade` に切り出した。
 * 既存の import 経路（`NovelRenderer` から）と既存テストを壊さないため、ここに再エクスポートを残す。
 */
export const normalizeBackgroundFade = normalizeEdgeFade

// playScript / startFrom で使う型を NovelRenderer 経由でも import できるよう再エクスポートする (#220)
export type { Step, StartFromOptions } from './GameState'

export class NovelRenderer {
  private app: Application
  /** init() 完了済みかのフラグ。React StrictMode 等で init 中に destroy が呼ばれたときの no-op 判定に使う */
  private appInitialized = false
  private dialogBox: DialogBox
  private bgGraphics: Graphics
  private bgContainer: Container
  /** 動画入力レイヤ (#252)。背景の直後・立ち絵の下に配置 */
  private videoLayer: VideoLayer
  private characterLayer: CharacterLayer
  private blackoutOverlay: Graphics
  private counterText: PixiText | null = null
  private displayEventCount = 0

  /** Condition 展開前の元イベント配列（Flag 変更時の再展開に使用） */
  private rawEvents: Event[] = []
  /** Condition 展開済みのフラットなイベント配列 */
  private resolvedEvents: Event[] = []
  private eventIndex = 0
  private textIndex = 0

  /** スナップショット履歴スタック（テキストイベント到達ごとに push） */
  private history: NovelGameState[] = []

  private initialized = false
  private onEndCallback: (() => void) | null = null
  /** 動画エクスポート用 (#228)。`jumpToScene` / `setScenes` でシーンが切り替わったときに呼ぶ */
  private onSceneChangeCallback: ((sceneId: string) => void) | null = null
  private assetBaseUrl: string = ''
  private textureCache: Map<string, Texture> = new Map()
  /** setBackground の非同期ロード用トークン。destroy / 再入 の race 回避に使う */
  private bgLoadToken = 0
  private audioManager: AudioManager

  /** ゲーム状態（フラグストア）— 章またぎで保持 */
  private gameState: GameState = new GameState()

  /** 選択肢オーバーレイ */
  private choiceOverlay: ChoiceOverlay

  /** 選択肢スタイル名 (#146)。frontmatter `choice_style:` の値。null なら default 扱い */
  private choiceStyle: string | null = null

  /** per-game デフォルトフォント (#147)。frontmatter `font_family:` の値。
   *  null なら DialogBox の組み込み既定 (`'Noto Sans JP', sans-serif`) を使う。
   *  per-line `[フォント:]` で個別 Dialog/Narration が上書き可能。 */
  private gameDefaultFontFamily: string | null = null

  /** runtime 既定フォント。Document.font_family / per-line 共に未指定のときの最終フォールバック (#147) */
  private static readonly RUNTIME_DEFAULT_FONT_FAMILY = "'Noto Sans JP', sans-serif"

  /** 直近で render した Dialog/Narration に紐付く resolved font family (#147 R1 M1)。
   *  ensureFontLoaded の Promise 解決時に「いま表示中の Dialog のフォントか」を判定する race guard 用。
   *  別の Dialog に進んだ後に古い family が `setFontFamily` で上書きされる事故を防ぐ。 */
  private currentResolvedFontFamily: string | null = null

  /** 選択肢表示中フラグ */
  private waitingForChoice = false
  /** 選択肢クリック直後の同フレーム advance を抑制するフラグ (#211) */
  private justSelectedChoice = false

  /** Wait イベント実行中フラグ */
  private waitingForWait = false

  /** playScript 実行中フラグ（再入ガード用 #220） */
  private isReplaying = false

  /** Wait タイマー（destroy 時キャンセル用）。TimeController 経由なので number */
  private waitTimer: number | null = null
  /** タイマー抽象化レイヤー (#228 動画エクスポート対応の土台) */
  private time: TimeController = defaultTimeController

  /** 全シーン情報（シーンジャンプ用） */
  private allScenes: EventScene[] = []

  /** セーブマネージャー */
  private saveManager: SaveManager = new SaveManager()

  /** セーブ/ロードオーバーレイ */
  private saveLoadOverlay!: SaveLoadOverlay

  /** バックログオーバーレイ */
  private backlogOverlay!: BacklogOverlay

  /** シークバー */
  private seekBar: SeekBar

  /** 現在のシーンID */
  private currentSceneId: string | null = null

  /** 現在の背景パス */
  private currentBackgroundPath: string | null = null

  /** 現在の背景端フェードマスク (#250)。なしなら null */
  private currentBackgroundFade: BackgroundFade | null = null

  /** 現在の背景に適用中のマスク Sprite (#250)。解放時に破棄する */
  private bgMaskSprite: Sprite | null = null

  /** 現在の BGM パス（スナップショット用） */
  private currentBgmPath: string | null = null

  /** 枠なしモードのデフォルト値（per-game 設定）。per-scene の DialogBorderless で上書きされる */
  private defaultDialogBorderless: boolean = false

  /** 論理画面幅（aspectRatio から決定） */
  private screenWidth: number
  /** 論理画面高さ（aspectRatio から決定） */
  private screenHeight: number

  /** オートモード ON/OFF (#139) */
  private autoMode: boolean = false
  /** オートモード待機タイマー（destroy 時・手動操作時にキャンセル） */
  private autoTimer: number | null = null
  /** オートモード待機時間 ms（settings.autoWaitMs から更新） */
  private autoWaitMs: number = 2500
  /** autoMode 変更時の React 側同期コールバック */
  private onAutoModeChange: ((on: boolean) => void) | null = null

  /** スキップモード ON/OFF (#140) */
  private skipMode: boolean = false
  /** スキップ連続進行タイマー */
  private skipTimer: number | null = null
  /** 既読進捗（display index の Set）。docKey が設定されている場合に使用 */
  private readProgress: Set<number> = new Set()
  /** 既読永続化のキー（undefined の場合はスキップ機能無効） */
  private docKey: string | undefined = undefined
  /** skipMode 変更時の React 側同期コールバック */
  private onSkipModeChange: ((on: boolean) => void) | null = null

  // ---- 画面効果 (#143) ----
  /** flash/fade 用全画面オーバーレイ Graphics */
  private effectOverlay: Graphics | null = null
  /** shake アニメーション用タイマー */
  private shakeTimer: number | null = null
  /** shake 開始時刻（ms） */
  private shakeStartMs: number = 0
  /** flash/fade アニメーション用タイマー */
  private effectTimer: number | null = null

  constructor(config?: { dialogBorderless?: boolean; aspectRatio?: AspectRatio }) {
    this.app = new Application()
    this.bgGraphics = new Graphics()
    this.bgContainer = new Container()
    const ratio = parseAspectRatio(config?.aspectRatio)
    this.screenWidth = ASPECT_RATIOS[ratio].width
    this.screenHeight = ASPECT_RATIOS[ratio].height
    this.characterLayer = new CharacterLayer(this.screenWidth, this.screenHeight, this.time)
    this.blackoutOverlay = new Graphics()
    this.defaultDialogBorderless = config?.dialogBorderless ?? false
    this.dialogBox = new DialogBox({
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      borderless: this.defaultDialogBorderless,
    })
    this.audioManager = new AudioManager()
    // 動画入力レイヤ (#252)。音声ミックスのため audioManager を注入する。
    this.videoLayer = new VideoLayer(this.screenWidth, this.screenHeight, this.audioManager)
    this.choiceOverlay = new ChoiceOverlay(this.screenWidth, this.screenHeight)
    // 選択肢の確定音／ホバー音を AudioManager で鳴らせるように注入 (#146)
    this.choiceOverlay.setAudioManager(this.audioManager)
    this.saveLoadOverlay = new SaveLoadOverlay(
      this.screenWidth,
      this.screenHeight,
      this.saveManager
    )
    this.backlogOverlay = new BacklogOverlay(this.screenWidth, this.screenHeight)
    this.seekBar = new SeekBar(this.screenWidth, this.screenHeight)
  }

  /**
   * PixiJS Application を初期化し、親要素に Canvas を挿入する
   */
  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      width: this.screenWidth,
      height: this.screenHeight,
      background: 0x000000,
      antialias: true,
    })
    this.appInitialized = true

    container.appendChild(this.app.canvas as HTMLCanvasElement)

    // 黒背景
    this.bgGraphics.rect(0, 0, this.screenWidth, this.screenHeight)
    this.bgGraphics.fill(0x000000)
    this.app.stage.addChild(this.bgGraphics)

    // 背景画像コンテナ
    this.app.stage.addChild(this.bgContainer)

    // 動画入力レイヤー (#252)。背景の直後・立ち絵の下に配置（背景の上、キャラの下）。
    this.app.stage.addChild(this.videoLayer)

    // 立ち絵レイヤー
    this.app.stage.addChild(this.characterLayer)

    // 暗転レイヤー
    this.blackoutOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.blackoutOverlay.fill(0x000000)
    this.blackoutOverlay.visible = false
    this.app.stage.addChild(this.blackoutOverlay)

    // 画面効果オーバーレイ（#143: flash/fade — blackout より上、dialog より下）
    // fill 色は startFlash/startFade で毎回 clear() → fill(color) し直すため初期値は任意
    this.effectOverlay = new Graphics()
    this.effectOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.effectOverlay.fill(0x000000)
    this.effectOverlay.alpha = 0
    this.effectOverlay.visible = false
    this.app.stage.addChild(this.effectOverlay)

    // ダイアログボックス
    this.app.stage.addChild(this.dialogBox)

    // シークバー（ダイアログボックスの下）
    this.seekBar.setOnSeek((displayIndex) => this.seekToTextEventDisplayIndex(displayIndex))
    this.app.stage.addChild(this.seekBar)
    // デフォルトで非表示。マウスがキャンバス下端付近に来たら表示する (簡易ホバー)
    this.seekBar.visible = false
    if (this.app.canvas) {
      const canvas = this.app.canvas as HTMLCanvasElement
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect()
        const yRatio = (e.clientY - rect.top) / rect.height
        this.seekBar.visible = yRatio > 0.78
      })
      canvas.addEventListener('mouseleave', () => {
        this.seekBar.visible = false
      })
    }

    // シーンカウンター
    const counterStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: 0xa8dadc,
      fontWeight: 'bold',
    })
    this.counterText = new PixiText({ text: '', style: counterStyle })
    this.counterText.x = this.screenWidth - 20
    this.counterText.y = 16
    this.counterText.anchor.set(1, 0)
    // カウンターはデバッグ HUD 側で出すので Pixi 側では非表示にしておく
    this.counterText.visible = false
    this.app.stage.addChild(this.counterText)

    // 選択肢オーバーレイ（カウンターより上に配置）
    this.choiceOverlay.visible = false
    this.app.stage.addChild(this.choiceOverlay)

    // セーブ/ロードオーバーレイ
    this.app.stage.addChild(this.saveLoadOverlay)

    // バックログオーバーレイ
    this.app.stage.addChild(this.backlogOverlay)

    // クリック/タップで進行
    this.app.canvas.addEventListener('pointerdown', this.handleAdvance)

    // キーボードで進行
    window.addEventListener('keydown', this.handleKeyDown)

    // バックログスクロール
    this.app.canvas.addEventListener('wheel', this.handleWheel, { passive: false })

    this.initialized = true
  }

  /**
   * イベントキューを設定して最初の表示イベントを表示
   */
  /**
   * 動画エクスポート (#228) 等で時刻を仮想モードに切り替えるためのアクセサ。
   * 通常 (live) では何もしなくて良い。
   */
  getTimeController(): TimeController {
    return this.time
  }

  /**
   * デバッグ用: 現在の実行状態を返す。開発時の HUD 表示に使う。
   */
  getDebugState(): {
    eventIndex: number
    eventCount: number
    eventKind: string
    eventText?: string
    autoMode: boolean
    waitingForChoice: boolean
    waitingForWait: boolean
    currentResolvedFontFamily: string | null
    sceneId: string | null
    audioWarning: string | null
    characters: Array<{
      name: string
      expression: string
      position: string
      x: number
      y: number
      scale: number
    }>
  } {
    const current = this.resolvedEvents[this.eventIndex]
    let kind = '(none)'
    let text: string | undefined
    if (current && typeof current === 'object') {
      kind = Object.keys(current)[0] ?? '(unknown)'
      // 本文を見えるところまで取り出す
      const v = (current as Record<string, unknown>)[kind]
      if (v && typeof v === 'object') {
        const maybeText = (
          v as { text?: unknown; line?: unknown; path?: unknown; target?: unknown }
        ).text
        if (Array.isArray(maybeText) && maybeText.length > 0)
          text = JSON.stringify(maybeText[0]).slice(0, 120)
        else if (typeof (v as { line?: unknown }).line === 'string')
          text = (v as { line: string }).line
        else if (typeof (v as { path?: unknown }).path === 'string')
          text = (v as { path: string }).path
        else if (typeof (v as { target?: unknown }).target === 'string')
          text = (v as { target: string }).target
      }
    }
    const chars = this.characterLayer.getCharacterStates().map((s) => {
      // 私的フィールドへの最小アクセス: x/y/scale をスナップショット
      const inner = this.characterLayer as unknown as {
        characters: Map<string, { sprite: { x: number; y: number; scale: { x: number } } }>
      }
      const st = inner.characters.get(s.name)
      return {
        name: s.name,
        expression: s.expression,
        position: s.position,
        x: st?.sprite.x ?? -1,
        y: st?.sprite.y ?? -1,
        scale: st?.sprite.scale.x ?? -1,
      }
    })
    return {
      eventIndex: this.eventIndex,
      eventCount: this.resolvedEvents.length,
      eventKind: kind,
      eventText: text,
      autoMode: this.autoMode,
      waitingForChoice: this.waitingForChoice,
      waitingForWait: this.waitingForWait,
      currentResolvedFontFamily: this.currentResolvedFontFamily,
      sceneId: this.currentSceneId ?? null,
      audioWarning: this.audioManager.getLastWarning(),
      characters: chars,
    }
  }

  setEvents(events: Event[]): void {
    // PixiJS v8 の Assets.load で取得した Texture は Assets の内部キャッシュに残り続けるため、
    // キャッシュ済みURLを Assets.unload で解放してから textureCache をクリアする
    const urls = Array.from(this.textureCache.keys())
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err) => {
      console.warn('[name-name] テクスチャの解放に失敗', err)
    })
    this.textureCache.clear()
    this.resetAndStartEvents([...events])
  }

  /**
   * 同じ scenario を最初から再開する (texture cache は維持)。
   * 動画モードの「新規開始」直後に AudioContext を起動してから冒頭の voice 付き event を
   * 再走させる用途。setEvents() は texture を Assets.unload するため、render と並行すると
   * Pixi が `Cannot read properties of null (reading 'alphaMode')` で落ちる。restart() は
   * texture を維持するため安全。
   */
  restart(): void {
    if (this.rawEvents.length === 0) return
    this.resetAndStartEvents([...this.rawEvents])
  }

  /**
   * 全シーンを設定して最初のシーンから開始する
   */
  setScenes(scenes: EventScene[]): void {
    this.allScenes = scenes
    this.gameState.clear()
    if (scenes.length > 0) {
      this.currentSceneId = scenes[0].id
      this.setEvents(scenes[0].events)
      this.onSceneChangeCallback?.(scenes[0].id)
    }
  }

  /**
   * 指定シーンにジャンプする
   */
  jumpToScene(sceneId: string): void {
    const scene = this.allScenes.find((s) => s.id === sceneId)
    if (!scene) {
      console.warn(`[name-name] シーンが見つからない: ${sceneId}`)
      return
    }
    this.currentSceneId = sceneId
    this.resetAndStartEvents([...scene.events])
    this.onSceneChangeCallback?.(sceneId)
  }

  /** 現在表示中のシーンID (#228 動画エクスポート用) */
  getCurrentSceneId(): string | null {
    return this.currentSceneId
  }

  /** 登録済みシーンIDの一覧（順序保持）(#228 動画エクスポート UI 用) */
  getAllSceneIds(): string[] {
    return this.allScenes.map((s) => s.id)
  }

  /** 描画 canvas を取得する (#228 `captureStream` 用) */
  getCanvas(): HTMLCanvasElement | null {
    return (this.app?.canvas as HTMLCanvasElement | undefined) ?? null
  }

  /** AudioManager にアクセスする (#228 動画エクスポートの音声配線用) */
  getAudioManager(): AudioManager {
    return this.audioManager
  }

  /**
   * 動画 export 用に動画レイヤを頭出しする (#252)。
   * 録画開始（recorder.start）の前に呼び、表示中の動画を currentTime=0 へ seek して
   * ready を待ってから再生し直す。これで録画の先頭から動画が正しく映る/鳴る。
   * 動画が無ければ即解決。
   */
  async prepareVideosForExport(): Promise<void> {
    await this.videoLayer.prepareForExport()
  }

  /** シーン切り替えコールバックを登録する (#228) */
  setOnSceneChange(cb: ((sceneId: string) => void) | null): void {
    this.onSceneChangeCallback = cb
  }

  /**
   * 現在登録されている onEnd を取り出して null クリアする (#228 動画エクスポート用)。
   * VideoExporter が録画中に onEnd を占有する間、既存のリスナを退避するために使う。
   */
  takeOnEnd(): (() => void) | null {
    const prev = this.onEndCallback
    this.onEndCallback = null
    return prev
  }

  /**
   * 現在登録されている onSceneChange を取り出して null クリアする (#228 動画エクスポート用)。
   */
  takeOnSceneChange(): ((sceneId: string) => void) | null {
    const prev = this.onSceneChangeCallback
    this.onSceneChangeCallback = null
    return prev
  }

  /**
   * イベント配列をリセットし、最初のテキストイベントまで進めて描画する
   */
  private resetAndStartEvents(events: Event[]): void {
    this.waitingForChoice = false
    this.waitingForWait = false
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
    if (this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
      this.skipTimer = null
    }
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.effectOverlay) {
      this.effectOverlay.alpha = 0
      this.effectOverlay.visible = false
    }
    this.choiceOverlay.hide()
    this.audioManager.stopBgm(0)
    this.clearBackground()
    this.characterLayer.clear()
    this.blackoutOverlay.visible = false
    this.currentBgmPath = null
    // シーン遷移時にダイアログを明示的にクリアする（前シーンの残留テキスト防止 #217）
    this.dialogBox.clearText()
    // per-scene [枠なし]/[枠あり] はシーン遷移でデフォルト値にリセット
    this.dialogBox.setBorderless(this.defaultDialogBorderless)

    // 元イベントを保持し、Condition をフラグに基づいて展開
    this.rawEvents = events
    this.resolvedEvents = resolveEvents(events, this.gameState)
    this.eventIndex = 0
    this.textIndex = 0
    this.history = []
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length
    this.processUntilNextTextEvent()

    // 最初のテキストイベントに立ち絵情報があれば表示
    if (this.eventIndex < this.resolvedEvents.length) {
      this.showCharacterFromDialog(this.resolvedEvents[this.eventIndex])
    }

    // 最初のテキストイベントのスナップショットを記録
    this.pushSnapshot()

    this.render()
  }

  /**
   * 背景画像のベースURLを設定する
   */
  setAssetBaseUrl(url: string): void {
    this.assetBaseUrl = url
    // 動画レイヤも同じベース URL で相対パスを URL 化するため伝播する (#252)
    this.videoLayer.setAssetBaseUrl(url)
  }

  /**
   * 選択肢スタイルを設定する (#146)。
   * frontmatter `choice_style:` の値（`default` / `soft` / `monochrome` 等）を渡す。
   * null/undefined のときは default 扱い。
   */
  setChoiceStyle(style: string | null | undefined): void {
    this.choiceStyle = style ?? null
  }

  /**
   * per-game デフォルトフォントを設定する (#147)。
   * frontmatter `font_family:` の値（CSS の font-family 文字列）を渡す。
   * null/undefined のときは runtime 既定 (`'Noto Sans JP', sans-serif`) にフォールバック。
   *
   * 設定された family は描画前に [フォント:] per-line override が無い場合に Dialog/Narration へ
   * 適用される。フォントロードは描画時に lazy に行われる。
   */
  setFontFamily(family: string | null | undefined): void {
    this.gameDefaultFontFamily = family ?? null
    // per-game default は描画時に適用するため、ここでは即時に DialogBox を切り替えない。
    // 早期に切り替えると未ロードのフォントで bake されるため、render() 側で
    // ensureFontLoaded → setFontFamily の順を担保する。
    // バックログは per-line を再現せず per-game フォントだけを反映する (#147 R1 S1)。
    this.backlogOverlay.setFontFamily(family ?? null)
  }

  /**
   * 終了コールバック
   */
  onEnd(callback: () => void): void {
    this.onEndCallback = callback
  }

  /** 終了コールバックを設定する（null で解除可能）(#228 動画エクスポート復元用) */
  setOnEnd(callback: (() => void) | null): void {
    this.onEndCallback = callback
  }

  /**
   * 設定（テキスト速度・音量）をリアルタイムに反映する。
   * voiceVolume は voice 専用 masterGain 実装後に対応予定 (#144 follow-up)。
   */
  applySettings(settings: {
    msPerChar: number
    bgmVolume: number
    seVolume: number
    autoWaitMs?: number
  }): void {
    this.dialogBox.setMsPerChar(settings.msPerChar)
    this.audioManager.setBgmVolume(settings.bgmVolume)
    this.audioManager.setSeVolume(settings.seVolume)
    if (settings.autoWaitMs !== undefined) {
      this.autoWaitMs = settings.autoWaitMs
    }
  }

  /**
   * オートモードの ON/OFF を切り替える (#139)。
   * OFF にした場合は待機中のオートタイマーをキャンセルする。
   * React 側から呼ぶ場合は setAutoMode、renderer 内部から呼ぶ場合も同じメソッドを使う。
   */
  setAutoMode(on: boolean): void {
    if (this.autoMode === on) return
    this.autoMode = on
    if (!on) {
      if (this.autoTimer) {
        this.time.clearTimeout(this.autoTimer)
        this.autoTimer = null
      }
      // オートモード OFF 時はボイスを停止する（onEnded が誤発火しないよう）
      this.audioManager.stopVoice()
    }
    // React state との同期。コールバック内で setAutoMode が再度呼ばれても
    // 同値 no-op（上の早期 return）で無限ループを防いでいる。
    this.onAutoModeChange?.(on)
  }

  /** オートモード変更コールバックを登録する（NovelPlayer が setAutoMode(false) を検知するため） */
  setOnAutoModeChange(cb: (on: boolean) => void): void {
    this.onAutoModeChange = cb
  }

  /** オートモードの現在状態を取得する */
  isAutoMode(): boolean {
    return this.autoMode
  }

  /**
   * 既読永続化キーを設定する (#140)。
   * 設定するとスキップモードが有効になり、既読進捗を localStorage から読み込む。
   */
  setDocKey(docKey: string): void {
    this.docKey = docKey
    this.readProgress = loadReadProgress(docKey)
  }

  /**
   * スキップモードの ON/OFF を切り替える (#140)。
   * OFF にした場合はスキップタイマーをキャンセルする。
   */
  setSkipMode(on: boolean): void {
    if (this.skipMode === on) return
    this.skipMode = on
    if (on) {
      // スキップモードとオートモードは排他: スキップ ON 時にオートを解除 (#140)
      this.setAutoMode(false)
    }
    if (!on && this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
      this.skipTimer = null
    }
    this.onSkipModeChange?.(on)
  }

  /** スキップモード変更コールバックを登録する */
  setOnSkipModeChange(cb: (on: boolean) => void): void {
    this.onSkipModeChange = cb
  }

  /** スキップモードの現在状態を取得する */
  isSkipMode(): boolean {
    return this.skipMode
  }

  /**
   * リソース解放
   */
  destroy(): void {
    if (!this.appInitialized) {
      // React StrictMode では init() が走り切る前に unmount が来る場合がある。
      // その時 this.app.canvas は undefined のため触ると落ちる。何もせず終了。
      return
    }
    this.app.canvas.removeEventListener('pointerdown', this.handleAdvance)
    this.app.canvas.removeEventListener('wheel', this.handleWheel)
    window.removeEventListener('keydown', this.handleKeyDown)
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
    if (this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
      this.skipTimer = null
    }
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    // 動画レイヤを破棄（video 要素解放・AudioManager から detach・Sprite/Texture/mask 破棄）(#252)。
    // audioManager.destroy() より前に呼んで detach を確実に通す。
    this.videoLayer.remove()
    this.audioManager.destroy()
    this.characterLayer.clear()
    this.choiceOverlay.hide()
    this.saveLoadOverlay.hide()
    this.backlogOverlay.hide()
    this.dialogBox.dispose()
    // GPU テクスチャのリーク防止: Assets.unload で内部キャッシュから解放
    const urls = Array.from(this.textureCache.keys())
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err) => {
      console.warn('[name-name] テクスチャの解放に失敗', err)
    })
    this.textureCache.clear()
    // canvas 由来マスクテクスチャの GPU リソースを解放する (#250)
    this.disposeBgMask()
    this.app.destroy(true, { children: true })
    this.initialized = false
  }

  // ---- 画面効果メソッド (#143) ----

  /**
   * 16進カラーコード（"#rrggbb"）を PixiJS の 0xRRGGBB 数値に変換する。
   * パース失敗時は 0xffffff を返す。
   */
  private parseHexColor(hex: string): number {
    const clean = hex.replace('#', '')
    const n = parseInt(clean, 16)
    return isNaN(n) ? 0xffffff : n
  }

  /**
   * 画面シェイク演出 (#143)。
   * sin 波ベースの決定論的な揺れ。stage の position を直接動かして実現する。
   */
  private startShake(intensityPx: number, durationMs: number): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    this.shakeStartMs = performance.now()

    const FPS = 60
    const intervalMs = 1000 / FPS

    const tick = (): void => {
      const elapsed = performance.now() - this.shakeStartMs
      const progress = Math.min(elapsed / durationMs, 1)
      // 減衰 sin 波: 残り時間に比例して振幅を絞る
      const decay = 1 - progress
      const offsetX = Math.sin(elapsed * 0.05) * intensityPx * decay
      const offsetY = Math.cos(elapsed * 0.037) * intensityPx * decay * 0.6
      this.app.stage.position.set(offsetX, offsetY)

      if (progress < 1) {
        this.shakeTimer = this.time.setTimeout(tick, intervalMs)
      } else {
        this.app.stage.position.set(0, 0)
        this.shakeTimer = null
      }
    }
    tick()
  }

  /**
   * フラッシュ演出 (#143)。
   * effectOverlay を指定色で alpha ピーク → 0 にフェードアウトする。
   */
  private startFlash(colorHex: string, peakAlpha: number, durationMs: number): void {
    if (!this.effectOverlay) return
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }

    const color = this.parseHexColor(colorHex)
    this.effectOverlay.clear()
    this.effectOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.effectOverlay.fill(color)
    this.effectOverlay.alpha = peakAlpha
    this.effectOverlay.visible = true

    const startMs = performance.now()
    const FPS = 60
    const intervalMs = 1000 / FPS

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      const progress = Math.min(elapsed / durationMs, 1)
      if (!this.effectOverlay) return
      this.effectOverlay.alpha = peakAlpha * (1 - progress)
      if (progress >= 1) {
        this.effectOverlay.visible = false
        this.effectOverlay.alpha = 0
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
      }
    }, intervalMs)
  }

  /**
   * フェード演出 (#143)。
   * effectOverlay を指定色・指定アルファ範囲で補間する。
   * target: "bg"（背景のみ）は将来拡張。現状は "all" と同じ全画面オーバーレイ。
   */
  private startFade(
    _target: string,
    colorHex: string,
    fromAlpha: number,
    toAlpha: number,
    durationMs: number
  ): void {
    if (!this.effectOverlay) return
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }

    const color = this.parseHexColor(colorHex)
    this.effectOverlay.clear()
    this.effectOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.effectOverlay.fill(color)
    this.effectOverlay.alpha = fromAlpha
    this.effectOverlay.visible = true

    const startMs = performance.now()
    const FPS = 60
    const intervalMs = 1000 / FPS

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      const progress = Math.min(elapsed / durationMs, 1)
      if (!this.effectOverlay) return
      this.effectOverlay.alpha = fromAlpha + (toAlpha - fromAlpha) * progress
      if (progress >= 1) {
        this.effectOverlay.alpha = toAlpha
        // toAlpha が 0 なら不可視に戻す
        if (toAlpha <= 0) {
          this.effectOverlay.visible = false
        }
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
      }
    }, intervalMs)
  }

  /**
   * 現在のゲーム状態のスナップショットを返す
   */
  getSnapshot(): NovelGameState {
    return {
      sceneId: this.currentSceneId,
      eventIndex: this.eventIndex,
      textIndex: this.textIndex,
      flags: this.gameState.toJSON(),
      backgroundPath: this.currentBackgroundPath,
      backgroundFade: this.currentBackgroundFade,
      video: this.videoLayer.getState(),
      isBlackout: this.blackoutOverlay.visible,
      characters: this.characterLayer.getCharacterStates(),
      currentBgmPath: this.currentBgmPath,
    }
  }

  /**
   * 次のテキスト / 次のイベントへ進む
   */
  advance(): void {
    if (this.resolvedEvents.length === 0) return
    if (this.waitingForChoice || this.waitingForWait) return

    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)

    if (textEvt) {
      // 現在表示中のテキストをバックログに記録
      const currentLine = textEvt.text[this.textIndex] ?? ''
      const character = textEvt.type === 'dialog' ? textEvt.character : null
      this.backlogOverlay.addEntry(character, currentLine)

      this.textIndex++
      if (this.textIndex < textEvt.text.length) {
        // まだテキスト行が残っている
        this.render()
        return
      }
    }

    // 次のイベントへ
    this.eventIndex++
    this.textIndex = 0

    if (this.eventIndex >= this.resolvedEvents.length) {
      // 全イベント完了
      this.dialogBox.setDialog(null, '')
      this.dialogBox.setIndicatorVisible(false)
      this.updateCounter()
      this.onEndCallback?.()
      return
    }

    this.processUntilNextTextEvent()
    // テキストイベントに立ち絵情報があれば表示
    if (this.eventIndex < this.resolvedEvents.length) {
      this.showCharacterFromDialog(this.resolvedEvents[this.eventIndex])
    }

    // スナップショットを記録
    this.pushSnapshot()

    this.render()
  }

  /**
   * デバッグ用リプレイ API (#220 Phase 1)。
   *
   * シーン+操作列（Step[]）を順に適用して任意の状態を再現する。
   * - `advance`: クリック相当。`this.advance()` を呼ぶ
   * - `choice`: 選択肢の確定パスと同等にフラグを整合させてから直接 `jumpToScene(jump)` する
   *   （Choice オーバーレイの表示はスキップする）
   * - `wait`: ms ミリ秒だけ待つ（将来の非同期イベント用）
   *
   * デバッグ/テスト用のリプレイ API。再生中は msPerChar=0（タイプライター即スキップ）とし、
   * 完了時・例外時とも元の msPerChar に必ず復元する（try/finally）。
   * 完了は Promise で通知し、その後は通常操作に戻る。
   *
   * choice の jump 先が存在しない場合は jumpToScene の既存挙動に従い console.warn して
   * no-op となる（例外は投げない）。
   * 既知の制限: 不正な jump を指定した choice ステップでは、表示中の Choice オーバーレイが
   * 残る場合がある（デバッグ用途のため許容）。
   *
   * 同時実行は非対応。実行中（wait 待機中など）の再呼び出しは throw する。
   */
  async playScript(steps: Step[]): Promise<void> {
    if (this.isReplaying) throw new Error('playScript is already running')
    this.isReplaying = true
    const savedMsPerChar = this.dialogBox.getMsPerChar()
    this.dialogBox.setMsPerChar(0)
    try {
      for (const step of steps) {
        switch (step.type) {
          case 'advance':
            this.advance()
            break
          case 'choice':
            // 選択肢確定パス（ChoiceOverlay のコールバック）と同じフラグ整合を保つ。
            // justSelectedChoice は同フレーム advance 抑制用だが、playScript は
            // 同期的に進むため即リセットしてよい。
            this.justSelectedChoice = false
            // jump 成功時は resetAndStartEvents が false にするが、jump 失敗（存在しない
            // シーン）時は resetAndStartEvents が呼ばれないため、ここで明示的にリセットする。
            this.waitingForChoice = false
            this.jumpToScene(step.jump)
            break
          case 'wait':
            await new Promise<void>((resolve) => this.time.setTimeout(resolve, step.ms))
            break
        }
      }
    } finally {
      this.dialogBox.setMsPerChar(savedMsPerChar)
      this.isReplaying = false
    }
  }

  /**
   * 1つ前の表示イベントに戻る（スナップショットベースの宣言的復元）
   */
  goBack(): void {
    if (this.resolvedEvents.length === 0) return
    if (this.waitingForChoice || this.waitingForWait) return

    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)

    if (textEvt && this.textIndex > 0) {
      this.textIndex--
      this.render()
      return
    }

    // 前のスナップショットへ（現在の分を pop して、その前に戻る）
    if (this.history.length > 1) {
      this.history.pop()
      const prevState = this.history[this.history.length - 1]
      this.applyState(prevState)
      this.render()
    }
  }

  /**
   * 履歴の任意位置にジャンプする（シークバーから呼ばれる）
   */
  seekTo(historyIndex: number): void {
    if (historyIndex < 0 || historyIndex >= this.history.length) return
    if (this.waitingForChoice || this.waitingForWait) return

    // シーク操作時はスキップモードを解除する (#140): ユーザーが特定箇所を見たくてシークしているため
    this.setSkipMode(false)
    // シーク操作時はボイスを停止する（再生中のボイスが残留しないよう）
    this.audioManager.stopVoice()

    // 履歴を指定位置まで切り詰める（アンドゥスタック方式: 戻った地点から再進行すると新しい履歴が積まれる）
    this.history = this.history.slice(0, historyIndex + 1)
    const targetState = this.history[historyIndex]
    this.applyState(targetState)
    this.render()
  }

  // --- private ---

  /**
   * スナップショットを履歴に push する
   */
  private pushSnapshot(): void {
    if (
      this.eventIndex < this.resolvedEvents.length &&
      getTextEvent(this.resolvedEvents[this.eventIndex])
    ) {
      this.history.push(this.getSnapshot())
    }
  }

  /**
   * スナップショットから状態を宣言的に復元する
   */
  private applyState(state: NovelGameState): void {
    // 画面効果をリセット（シーク・バック時に演出が残留しないよう）
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    this.app.stage.position.set(0, 0)
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.effectOverlay) {
      this.effectOverlay.alpha = 0
      this.effectOverlay.visible = false
    }

    // フラグ復元
    this.gameState.fromJSON(state.flags)

    // インデックス復元
    this.eventIndex = state.eventIndex
    this.textIndex = state.textIndex

    // 背景復元
    if (state.backgroundPath) {
      this.setBackground(state.backgroundPath, state.backgroundFade)
    } else {
      this.clearBackground()
    }

    // 動画レイヤ復元 (#252)。clearBackground / setBackground は背景のみを扱い
    // 動画には触れないため（show が単一スロットを置換、なしなら remove）、背景復元の後に行う。
    this.videoLayer.restore(state.video)

    // 暗転復元
    this.blackoutOverlay.visible = state.isBlackout

    // 立ち絵復元（フェードインは入れず、スナップショット時点の状態を即時表示する #177）
    this.characterLayer.clear()
    for (const ch of state.characters) {
      this.characterLayer.show(ch.name, ch.expression, ch.position, this.assetBaseUrl, {
        instant: true,
      })
    }

    // BGM復元
    if (state.currentBgmPath) {
      const soundUrl = `${this.assetBaseUrl}/sounds/${state.currentBgmPath.replace(/^\//, '')}`
      this.audioManager.playBgm(soundUrl)
      this.currentBgmPath = state.currentBgmPath
    } else {
      this.audioManager.stopBgm(0)
      this.currentBgmPath = null
    }
  }

  /**
   * rawEvents を現在のフラグ状態で再展開し、eventIndex を維持する。
   * Flag イベント処理後に呼ばれ、後続の Condition が新しいフラグ値で評価される。
   */
  private reResolveEvents(): void {
    const oldIndex = this.eventIndex
    this.resolvedEvents = resolveEvents(this.rawEvents, this.gameState)
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length

    // 再展開で配列長が変わった場合、eventIndex を安全な範囲に収める
    if (oldIndex >= this.resolvedEvents.length) {
      this.eventIndex = Math.max(0, this.resolvedEvents.length - 1)
    }
    // 再展開前と同じイベントを指しているか確認（Flag イベント自体は展開で位置が変わらない）
    // Flag は Condition の外にあるため、Flag の位置は再展開で変動しない
  }

  /**
   * typewriter 表示中なら全文表示にスキップ、完了済みなら次イベントへ進む (#137)。
   * advance() / クリック / Enter / Space / ArrowRight 共通の入力ハンドラから呼ぶ。
   *
   * 呼び出し元は必ず先に setAutoMode(false) してから本メソッドを呼ぶこと。
   * skipTypewriter() 内は onTypingDone を破棄するが、この時点では autoMode がすでに
   * false になっているため、次の render() でコールバックがセットされず自動進行しない。
   */
  private advanceOrSkipTypewriter(): void {
    if (this.dialogBox.isTyping()) {
      this.dialogBox.skipTypewriter()
      return
    }
    this.advance()
  }

  private handleAdvance = (): void => {
    if (this.justSelectedChoice) {
      this.justSelectedChoice = false
      return
    }
    this.audioManager.ensureContext()
    if (this.backlogOverlay.visible) {
      this.backlogOverlay.hide()
      return
    }
    if (this.saveLoadOverlay.visible) return
    // 手動クリック/タップでオートモード・スキップモードをキャンセル (#139 #140)
    this.setAutoMode(false)
    this.setSkipMode(false)
    this.advanceOrSkipTypewriter()
  }

  private handleWheel = (e: WheelEvent): void => {
    if (this.backlogOverlay.visible) {
      e.preventDefault()
      this.backlogOverlay.handleWheel(e.deltaY)
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.justSelectedChoice) {
      this.justSelectedChoice = false
      return
    }
    this.audioManager.ensureContext()

    // Escape: 開いているオーバーレイを閉じる
    if (e.key === 'Escape') {
      if (this.backlogOverlay.visible) {
        this.backlogOverlay.hide()
        return
      }
      if (this.saveLoadOverlay.visible) {
        this.saveLoadOverlay.hide()
        return
      }
      return
    }

    // バックログ表示中のキー操作
    if (this.backlogOverlay.visible) {
      switch (e.key) {
        case 'b':
        case 'B':
          this.backlogOverlay.hide()
          break
        case 'ArrowUp':
          e.preventDefault()
          this.backlogOverlay.handleKeyScroll('up')
          break
        case 'ArrowDown':
          e.preventDefault()
          this.backlogOverlay.handleKeyScroll('down')
          break
      }
      return
    }

    // セーブ/ロードオーバーレイ表示中は入力を無視
    if (this.saveLoadOverlay.visible) return

    // オーバーレイが開いていない場合のキー操作
    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault()
        // 手動キー操作でオートモード・スキップモードをキャンセル (#139 #140)
        this.setAutoMode(false)
        this.setSkipMode(false)
        this.advanceOrSkipTypewriter()
        break
      case 'ArrowRight':
        this.setAutoMode(false)
        this.setSkipMode(false)
        this.advanceOrSkipTypewriter()
        break
      case 'ArrowLeft':
        this.setAutoMode(false)
        this.setSkipMode(false)
        this.goBack()
        break
      case 's':
      case 'S':
        if (!this.waitingForChoice) {
          this.openSaveMenu()
        }
        break
      case 'l':
      case 'L':
        if (!this.waitingForChoice) {
          this.openLoadMenu()
        }
        break
      case 'b':
      case 'B':
        if (!this.waitingForChoice) {
          this.backlogOverlay.toggle()
        }
        break
    }
  }

  /**
   * 非テキストイベントを実行しながら次のテキストイベントまで進む
   */
  private processUntilNextTextEvent(): void {
    while (this.eventIndex < this.resolvedEvents.length) {
      if (getTextEvent(this.resolvedEvents[this.eventIndex])) break
      this.processDirective(this.resolvedEvents[this.eventIndex])
      // Choice / Wait は進行を止める
      if (this.waitingForChoice || this.waitingForWait) break
      this.eventIndex++
    }
  }

  /**
   * 演出イベント（Background, Blackout, SceneTransition）を実行する
   *
   * Condition は resolvedEvents では既に展開済みなので、ここでは処理しない。
   */
  private processDirective(event: Event): void {
    if (typeof event === 'string') {
      if (event === 'SceneTransition') {
        this.clearBackground()
        // 場面転換では動画レイヤも背景と同じ扱いでクリアする (#252)
        this.videoLayer.remove()
        this.blackoutOverlay.visible = false
      }
      if (event === 'VideoExit') {
        // [動画退場] で動画レイヤをクリア (#252)
        this.videoLayer.remove()
      }
      return
    }
    if ('Background' in event) {
      const bg = event.Background
      this.setBackground(
        bg.path,
        normalizeBackgroundFade({
          top: bg.fade_top,
          bottom: bg.fade_bottom,
          left: bg.fade_left,
          right: bg.fade_right,
        })
      )
      return
    }
    if ('Video' in event) {
      // 動画入力レイヤ (#252)。URL 構築は VideoLayer 側（assetBaseUrl + '/videos/' + path）に委譲し、
      // ここでは相対パスをそのまま渡す。背景の setBackground と同じ責務分担で、
      // セーブ/スナップショットには相対パスが保持される（ドメイン変更後のロードでも壊れない）。
      const v = event.Video
      if (this.assetBaseUrl) {
        this.videoLayer.show(v.path, {
          position: v.position,
          scale: v.scale,
          loop: v.loop,
          mute: v.mute,
          fade: normalizeBackgroundFade({
            top: v.fade_top,
            bottom: v.fade_bottom,
            left: v.fade_left,
            right: v.fade_right,
          }),
        })
      }
      return
    }
    if ('Blackout' in event) {
      this.blackoutOverlay.visible = event.Blackout.action === 'On'
      return
    }
    if ('Bgm' in event) {
      if (event.Bgm.action === 'Play' && event.Bgm.path) {
        const soundUrl = `${this.assetBaseUrl}/sounds/${event.Bgm.path.replace(/^\//, '')}`
        // fade_ms (#145): 指定があれば fade-in、未指定なら即時再生
        this.audioManager.playBgm(soundUrl, event.Bgm.fade_ms ?? undefined)
        this.currentBgmPath = event.Bgm.path
      } else {
        // fade_ms (#145): 指定があればその ms で fade-out、未指定は AudioManager 既定 (1000ms)
        if (event.Bgm.fade_ms != null) {
          this.audioManager.stopBgm(event.Bgm.fade_ms)
        } else {
          this.audioManager.stopBgm()
        }
        this.currentBgmPath = null
      }
      return
    }
    if ('Se' in event) {
      const soundUrl = `${this.assetBaseUrl}/sounds/${event.Se.path.replace(/^\//, '')}`
      // fade_ms (#145): 指定があれば fade-in、未指定なら即時再生
      this.audioManager.playSe(soundUrl, event.Se.fade_ms ?? undefined)
      return
    }
    if ('Flag' in event) {
      this.gameState.setFlag(event.Flag.name, event.Flag.value)
      // フラグ変更により後続の Condition の評価結果が変わる可能性がある。
      // 現在のシーンの元イベントを再取得して resolvedEvents を再計算する。
      this.reResolveEvents()
      return
    }
    if ('Choice' in event) {
      // 選択肢に到達したらスキップモードを解除（手動選択が必要） (#140)
      this.setSkipMode(false)
      this.waitingForChoice = true
      this.choiceOverlay.show(
        event.Choice.options,
        (jump: string) => {
          // 同フレームの advance を抑制。jumpToScene が例外を投げても次の
          // イベントループで確実にリセットされるよう setTimeout(0) を使う (#211)
          this.justSelectedChoice = true
          this.time.setTimeout(() => {
            this.justSelectedChoice = false
          }, 0)
          this.waitingForChoice = false
          this.choiceOverlay.hide()
          this.jumpToScene(jump)
        },
        this.choiceStyle
      )
      return
    }
    if ('ExpressionChange' in event) {
      this.characterLayer.changeExpression(
        event.ExpressionChange.character,
        event.ExpressionChange.expression,
        this.assetBaseUrl
      )
      return
    }
    if ('Exit' in event) {
      // スキップモード中はフェードを抑制して即時退場（既読を素早く流す UX に揃える）#177
      this.characterLayer.remove(event.Exit.character, { instant: this.skipMode })
      return
    }
    if ('Animate' in event) {
      // 立ち絵アニメ (#134) — fire-and-forget。完了を待たず次へ進む。
      this.characterLayer.animate(event.Animate.target, {
        dx: event.Animate.dx,
        dy: event.Animate.dy,
        rotation: event.Animate.rotation,
        scale: event.Animate.scale,
        duration_ms: event.Animate.duration_ms,
        easing: event.Animate.easing,
      })
      return
    }
    if ('DialogBorderless' in event) {
      // 文字ウィンドウ枠の ON/OFF (#135)
      this.dialogBox.setBorderless(event.DialogBorderless.borderless)
      return
    }
    if ('TitleShow' in event) {
      // 動画タイトル中央表示 (llll-ll-media 用)
      const ts = (event as { TitleShow: { text: string; font_family?: string; position?: string } })
        .TitleShow
      const font =
        ts.font_family ?? this.gameDefaultFontFamily ?? NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
      this.characterLayer.showTitle(ts.text, font, ts.position)
      return
    }
    if ('Shake' in event) {
      // 画面シェイク (#143) — fire-and-forget
      this.startShake(event.Shake.intensity_px, event.Shake.duration_ms)
      return
    }
    if ('Flash' in event) {
      // フラッシュ (#143) — fire-and-forget
      this.startFlash(event.Flash.color, event.Flash.alpha, event.Flash.duration_ms)
      return
    }
    if ('Fade' in event) {
      // フェード (#143) — fire-and-forget
      this.startFade(
        event.Fade.target,
        event.Fade.color,
        event.Fade.from_alpha,
        event.Fade.to_alpha,
        event.Fade.duration_ms
      )
      return
    }
    if ('Wait' in event) {
      // 進行を停止し、指定ミリ秒後に再開（eventIndex のインクリメントはコールバック内で行う）
      // Wait 中もスキップを停止する（Wait を無視するのは仕様違反） (#140)
      this.setSkipMode(false)
      this.waitingForWait = true
      this.waitTimer = this.time.setTimeout(() => {
        this.waitTimer = null
        if (!this.initialized) return
        this.waitingForWait = false
        this.eventIndex++
        this.processUntilNextTextEvent()
        if (this.eventIndex < this.resolvedEvents.length) {
          this.showCharacterFromDialog(this.resolvedEvents[this.eventIndex])
        }
        this.pushSnapshot()
        this.render()
      }, event.Wait.ms)
      return
    }
  }

  /**
   * Dialog イベントに立ち絵情報（expression + position）があれば表示する
   */
  private showCharacterFromDialog(event: Event): void {
    const textEvt = getTextEvent(event)
    if (!textEvt || textEvt.type !== 'dialog') return
    if (!textEvt.expression || !textEvt.position || !textEvt.character) return
    this.characterLayer.show(
      textEvt.character,
      textEvt.expression,
      textEvt.position,
      this.assetBaseUrl,
      // スキップモード中はフェードを抑制（既読シーンの高速進行で違和感を出さない）#177
      { instant: this.skipMode }
    )
  }

  /**
   * 背景画像を設定する（アスペクト比維持でカバー）。
   * fade を渡すと端フェードマスク (#250) を適用する。
   */
  private setBackground(path: string, fade?: BackgroundFade | null): void {
    this.currentBackgroundPath = path
    this.currentBackgroundFade = normalizeBackgroundFade(fade)
    this.disposeBgMask()
    this.bgContainer.removeChildren()

    if (!this.assetBaseUrl) return

    const cleanPath = path.replace(/^\//, '')
    const url = `${this.assetBaseUrl}/images/${cleanPath}`

    // ロード要求ごとにトークンを更新し、古い非同期完了による UAF / race を防ぐ。
    // キャッシュヒットで同期描画する場合も必ず進めること。さもないと直前に
    // 走っていた別背景の Assets.load().then が後から解決し、即描画した背景の上に
    // 古い sprite+fade を addChild してしまう。
    const token = ++this.bgLoadToken

    // キャッシュ済みの Texture があれば再利用（戻る操作時のフリッカー防止）
    const cached = this.textureCache.get(url)
    if (cached) {
      const sprite = new Sprite(cached)
      this.applyCoverFit(sprite)
      this.bgContainer.addChild(sprite)
      this.applyEdgeFadeMask(sprite)
      return
    }

    Assets.load(url)
      .then((texture) => {
        if (token !== this.bgLoadToken) return
        if (!this.initialized) return
        this.textureCache.set(url, texture)
        const sprite = new Sprite(texture)
        this.applyCoverFit(sprite)
        this.bgContainer.addChild(sprite)
        this.applyEdgeFadeMask(sprite)
      })
      .catch((err) => {
        console.warn('[name-name] 背景画像の読み込みに失敗: ' + url, err)
      })
  }

  private applyCoverFit(sprite: Sprite): void {
    const scaleX = this.screenWidth / sprite.texture.width
    const scaleY = this.screenHeight / sprite.texture.height
    const scale = Math.max(scaleX, scaleY)
    sprite.width = sprite.texture.width * scale
    sprite.height = sprite.texture.height * scale
    sprite.x = (this.screenWidth - sprite.width) / 2
    sprite.y = (this.screenHeight - sprite.height) / 2
  }

  /**
   * 現在の currentBackgroundFade に基づいて端フェードマスク (#250) を sprite に適用する。
   * フェード指定がなければ何もしない（従来動作）。
   */
  private applyEdgeFadeMask(sprite: Sprite): void {
    // #252 で共通ユーティリティ buildEdgeFadeMask に切り出した（VideoLayer と共有）。
    const maskSprite = buildEdgeFadeMask(
      this.currentBackgroundFade,
      this.screenWidth,
      this.screenHeight
    )
    if (!maskSprite) return
    this.bgMaskSprite = maskSprite
    this.bgContainer.addChild(maskSprite)
    sprite.mask = maskSprite
  }

  /** 背景マスク Sprite と そのテクスチャを破棄する (#250)。メモリリーク防止 */
  private disposeBgMask(): void {
    if (this.bgMaskSprite) {
      this.bgMaskSprite.removeFromParent()
      // canvas 由来のテクスチャは textureCache に乗らないので確実に破棄する
      this.bgMaskSprite.destroy({ texture: true, textureSource: true })
      this.bgMaskSprite = null
    }
  }

  /**
   * 背景画像をクリアする
   */
  private clearBackground(): void {
    this.currentBackgroundPath = null
    this.currentBackgroundFade = null
    this.disposeBgMask()
    this.bgContainer.removeChildren()
    // 動画レイヤも背景と同じ扱いでクリアする (#252)
    this.videoLayer.remove()
  }

  // --- クイックセーブ / クイックロード (#142) ---

  /**
   * 現在のゲーム状態をクイックセーブスロットに保存する。
   * 選択肢・Wait 待機中は保存しない（不整合状態を避けるため）。
   * 成功したら true、保存できない状態なら false を返す。
   */
  quickSave(): boolean {
    if (this.waitingForChoice || this.waitingForWait) return false

    const sceneName = this.currentSceneId
      ? (this.allScenes.find((s) => s.id === this.currentSceneId)?.title ?? null)
      : null

    const snapshot = this.getSnapshot()
    const data: SaveSlotData = {
      slot: -1, // クイックセーブはスロット番号不使用
      sceneId: snapshot.sceneId,
      eventIndex: snapshot.eventIndex,
      textIndex: snapshot.textIndex,
      flags: snapshot.flags,
      backgroundPath: snapshot.backgroundPath,
      backgroundFade: snapshot.backgroundFade,
      video: snapshot.video,
      isBlackout: snapshot.isBlackout,
      characters: snapshot.characters,
      currentBgmPath: snapshot.currentBgmPath,
      savedAt: new Date().toISOString(),
      sceneName,
    }
    this.saveManager.quickSave(data)
    return true
  }

  /**
   * クイックセーブスロットからゲーム状態を復元する。
   * 選択肢・Wait 待機中はロードしない（不整合状態を避けるため）。
   * データがない・復元できない場合は false を返す。
   */
  quickLoad(): boolean {
    if (this.waitingForChoice || this.waitingForWait) return false
    const data = this.saveManager.quickLoad()
    if (!data) return false
    this.loadFromSaveData(data)
    return true
  }

  /**
   * クイックセーブデータが存在するか返す。
   */
  hasQuickSave(): boolean {
    return this.saveManager.hasQuickSave()
  }

  /**
   * セーブメニューを表示する
   */
  private openSaveMenu(): void {
    this.saveLoadOverlay.showSave((slot: number) => {
      const sceneName = this.currentSceneId
        ? (this.allScenes.find((s) => s.id === this.currentSceneId)?.title ?? null)
        : null

      const snapshot = this.getSnapshot()
      const data: SaveSlotData = {
        slot,
        sceneId: snapshot.sceneId,
        eventIndex: snapshot.eventIndex,
        textIndex: snapshot.textIndex,
        flags: snapshot.flags,
        backgroundPath: snapshot.backgroundPath,
        backgroundFade: snapshot.backgroundFade,
        video: snapshot.video,
        isBlackout: snapshot.isBlackout,
        characters: snapshot.characters,
        currentBgmPath: snapshot.currentBgmPath,
        savedAt: new Date().toISOString(),
        sceneName,
      }
      this.saveManager.save(slot, data)
    })
  }

  /**
   * ロードメニューを表示する
   */
  private openLoadMenu(): void {
    this.saveLoadOverlay.showLoad((data: SaveSlotData) => {
      this.loadFromSaveData(data)
    })
  }

  /**
   * セーブデータからゲーム状態を復元する（applyState ベースの宣言的復元）
   */
  private loadFromSaveData(data: SaveSlotData): void {
    // フラグを復元
    this.gameState.fromJSON(data.flags)

    if (!data.sceneId) return

    // シーンを探す
    const scene = this.allScenes.find((s) => s.id === data.sceneId)
    if (!scene) {
      console.warn(`[name-name] セーブデータのシーンが見つからない: ${data.sceneId}`)
      return
    }

    this.currentSceneId = data.sceneId

    // 選択肢状態をリセット
    this.waitingForChoice = false
    this.waitingForWait = false
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.choiceOverlay.hide()

    // 元イベントを保持し、Condition をフラグに基づいて展開
    this.rawEvents = [...scene.events]
    this.resolvedEvents = resolveEvents(this.rawEvents, this.gameState)
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length

    // NovelGameState を構築して applyState で宣言的に復元
    const state: NovelGameState = {
      sceneId: data.sceneId,
      eventIndex: data.eventIndex,
      textIndex: data.textIndex,
      flags: data.flags,
      backgroundPath: data.backgroundPath,
      backgroundFade: normalizeBackgroundFade(data.backgroundFade),
      // 動画レイヤ (#252)。後方互換: 古いセーブには無い → null（動画なし）。
      video: data.video ?? null,
      isBlackout: data.isBlackout ?? false,
      characters: data.characters ?? [],
      currentBgmPath: data.currentBgmPath ?? null,
    }
    this.applyState(state)

    // 履歴をリセット（ロード後は現在位置のみ）
    this.history = [this.getSnapshot()]

    this.render()
  }

  /**
   * sceneId と flags を直接指定して任意の状態からシーンを開始する (#220 Phase 2)。
   *
   * デバッグ/テスト用。history をリセットする（呼び出し後は現在位置のみ）。
   * 指定フラグは置換であり merge ではない（省略時は空でクリア）。
   * 復元は applyState に委譲し、新規の描画/状態ロジックは持たない。
   *
   * - 存在しない sceneId は完全な no-op（flags も含め一切状態を変えない）。
   * - eventIndex/textIndex は範囲チェックしない（呼び出し側責任。範囲外でもクラッシュ
   *   はしないが未定義位置になる）。
   * - playScript 実行中の呼び出しは想定外（デバッグ API 同士の同時使用は非対応）。
   */
  startFrom(opts: StartFromOptions): void {
    const flags = opts.flags ?? {}

    // シーンを探す。無ければ完全な no-op（この時点で flags/index/history を一切触らない）
    const scene = this.allScenes.find((s) => s.id === opts.sceneId)
    if (!scene) {
      console.warn(`[name-name] startFrom: シーンが見つからない: ${opts.sceneId}`)
      return
    }

    // フラグを設定（置換セマンティクス。loadFromSaveData と同じ）。
    // resolveEvents が flags に依存するため、必ず resolveEvents より前に設定する。
    this.gameState.fromJSON(flags)

    this.currentSceneId = opts.sceneId

    // 選択肢/待機状態をリセット
    this.waitingForChoice = false
    this.waitingForWait = false
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.choiceOverlay.hide()

    // 元イベントを保持し、Condition をフラグに基づいて展開
    this.rawEvents = [...scene.events]
    this.resolvedEvents = resolveEvents(this.rawEvents, this.gameState)
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length

    // 最小 NovelGameState を構築して applyState で宣言的に復元
    const state: NovelGameState = {
      sceneId: opts.sceneId,
      eventIndex: opts.eventIndex ?? 0,
      textIndex: opts.textIndex ?? 0,
      flags,
      backgroundPath: null,
      backgroundFade: normalizeBackgroundFade(undefined),
      video: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
    }
    this.applyState(state)

    // 履歴をリセット（デバッグ開始後は現在位置のみ）
    this.history = [this.getSnapshot()]

    this.render()
  }

  /**
   * 現在のイベント/テキスト行を画面に反映
   */
  private render(): void {
    if (!this.initialized) return
    if (this.eventIndex >= this.resolvedEvents.length) return

    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)

    if (!textEvt) {
      this.dialogBox.clearText()
      return
    }

    const line = textEvt.text[this.textIndex] ?? ''
    const displayIndex = computeDisplayIndex(this.eventIndex, this.resolvedEvents)

    // スキップモード処理 (#140): 既読チェックはマーク前に行う
    if (this.skipMode && this.docKey) {
      if (!isRead(this.readProgress, displayIndex)) {
        // 未読到達 → スキップ終了（現在の行は表示して待機）
        this.setSkipMode(false)
      } else {
        // 既読 → 即 advance をスケジュール
        this.scheduleSkipStep()
      }
    }

    // 既読マーク (#140): チェック後にマーク（次回以降は既読として扱う）
    if (this.docKey) {
      markRead(this.docKey, this.readProgress, displayIndex)
    }

    // 空行 = 改ページ（テキストクリア後に次行へ自動進行はしない。空表示する）
    const name = textEvt.type === 'dialog' ? textEvt.character : null

    // per-line voice 再生 (#144): 最初のテキスト行でのみ再生
    let voicePath: string | null = null
    let perLineFontFamily: string | null = null
    if (typeof current === 'object' && current !== null) {
      if ('Dialog' in current) {
        if (this.textIndex === 0) {
          voicePath = current.Dialog.voice_path ?? null
        }
        perLineFontFamily = current.Dialog.font_family ?? null
      } else if ('Narration' in current) {
        if (this.textIndex === 0) {
          voicePath = current.Narration.voice_path ?? null
        }
        perLineFontFamily = current.Narration.font_family ?? null
      }
    }

    if (voicePath) {
      const voiceUrl = `${this.assetBaseUrl}/sounds/${voicePath.replace(/^\//, '')}`
      // voice は fire-and-forget で再生する。autoAdvance は typing onDone / [待機] が決定する。
      // 以前は voice 終了で scheduleAutoAdvance を呼んでいたが、これだと voice の長さで
      // 中央ホールド時間が伸びてしまい「決まった時間で次へ進む」設計と合わなかった。
      // voice が長くて次イベントが先に来ると stopVoice で切られるが、短句ナレ用途ではOK。
      this.audioManager.playVoice(voiceUrl)
    }

    // フォント解決 (#147): per-line override → per-game default → runtime default の優先順
    const resolvedFontFamily =
      perLineFontFamily ?? this.gameDefaultFontFamily ?? NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
    this.currentResolvedFontFamily = resolvedFontFamily
    // フォント未ロードのままで TextStyle に当てると fallback で bake されるため、
    // 非同期ロードしてから DialogBox に反映する。先に既存フォントで描画しておくと
    // 完了後に自然にグリフが置き換わる（pixi v8 は style 差し替えで再 bake する）。
    void ensureFontLoaded(resolvedFontFamily)
      .then(() => {
        // 非同期完了の race ガード (#147 R1 M1): 解決時点の resolvedFontFamily と
        // 「いま表示中の」currentResolvedFontFamily が一致するときだけ適用する。
        // ユーザーが連続 advance してフォント A → B と進んだ場合、A のロード完了で
        // B の表示中に A を上書きしてしまう事故を防ぐ。
        // 文字列比較なので A → A → A の連続は弾かれない（同 family 適用は no-op で害なし）。
        if (this.currentResolvedFontFamily !== resolvedFontFamily) return
        this.dialogBox.setFontFamily(resolvedFontFamily)
      })
      .catch((err) => {
        console.warn('[name-name] フォントロードに失敗', resolvedFontFamily, err)
      })

    // オートモード時はタイピング完了後に autoWaitMs 待機してから自動進行 (#139)。
    // voice 有無に関わらず typing onDone で進める (voice は fire-and-forget)。
    const onTypingDone = this.autoMode ? () => this.scheduleAutoAdvance() : null
    this.dialogBox.setDialog(name, line, onTypingDone)

    // 最後のテキスト行かつ最後のイベントならインジケーター非表示
    const isLastText = this.textIndex >= textEvt.text.length - 1
    const isLastEvent = this.eventIndex >= this.resolvedEvents.length - 1
    this.dialogBox.setIndicatorVisible(!(isLastText && isLastEvent))

    this.updateCounter()
    this.updateSeekBar()
  }

  /**
   * スキップモード: 既読行を高速スキップする (#140)。
   * タイプライターをスキップしてから advance() を setTimeout(0) で呼ぶ。
   * Choice / Wait 到達時は processDirective() 内で setSkipMode(false) が呼ばれるため、
   * タイマー発火時に skipMode が false になっており advance() は通常呼び出しになる。
   * 同一イベントの複数 text 行は同じ displayIndex を持つため、
   * 2 行目以降も「既読」として扱い全行をスキップする（意図的な設計）。
   */
  private scheduleSkipStep(): void {
    if (!this.skipMode) return
    if (this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
    }
    this.skipTimer = this.time.setTimeout(() => {
      this.skipTimer = null
      if (!this.skipMode) return
      // タイプライター中なら全文スキップ（skipTypewriter は onTypingDone を破棄するため
      // オートモードとの二重 advance は起きない）
      if (this.dialogBox.isTyping()) {
        this.dialogBox.skipTypewriter()
      }
      this.advance()
    }, 0)
  }

  /**
   * オートモード: autoWaitMs 後に advance() を呼ぶタイマーをセット (#139)。
   * 選択肢待ち・Wait 待ち中は発動しない。
   */
  private scheduleAutoAdvance(): void {
    if (!this.autoMode) return
    if (this.waitingForChoice || this.waitingForWait) return
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
    }
    this.autoTimer = this.time.setTimeout(() => {
      this.autoTimer = null
      if (this.autoMode && !this.waitingForChoice && !this.waitingForWait) {
        this.advance()
      }
    }, this.autoWaitMs)
  }

  private updateCounter(): void {
    if (!this.counterText) return
    const displayIndex = computeDisplayIndex(this.eventIndex, this.resolvedEvents)
    this.counterText.text = `${displayIndex} / ${this.displayEventCount}`
  }

  /**
   * シークバーの表示を更新する。Counter と同じ「テキストイベント表示位置」で動く。
   * (旧実装は history.length - 1 / history.length で常に ratio≈1 になりバーが
   *  満タンに張り付いていた #125)
   */
  private updateSeekBar(): void {
    const displayIndex = computeDisplayIndex(this.eventIndex, this.resolvedEvents)
    // 0-based に変換し SeekBar に渡す。SeekBar は ratio = current/(total-1) を計算する。
    const current = Math.max(0, displayIndex - 1)
    const total = this.displayEventCount
    this.seekBar.update(current, total)
  }

  /**
   * SeekBar からのクリック (テキストイベント表示 index 0-based) を
   * 適切な history index にマップして seekTo する。
   *
   * - 訪問済み (history に対応エントリあり) → そこへ巻き戻し
   * - 未訪問 (前方ジャンプ) → forward-play は未実装なので no-op。
   *   TODO: 将来 visual hint (DialogBox 上の小フラッシュ等) を出して
   *   「無効操作」とユーザーに伝えるか検討する
   */
  private seekToTextEventDisplayIndex(displayIndex: number): void {
    const historyIdx = findHistoryIndexForDisplayIndex(
      displayIndex,
      this.resolvedEvents,
      this.history
    )
    if (historyIdx < 0) return
    this.seekTo(historyIdx)
  }
}
