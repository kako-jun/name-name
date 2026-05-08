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
import { AudioManager } from './AudioManager'
import { GameState, NovelGameState, resolveEvents } from './GameState'
import { ChoiceOverlay } from './ChoiceOverlay'
import { SaveManager, SaveSlotData } from './SaveManager'
import { SaveLoadOverlay } from './SaveLoadOverlay'
import { BacklogOverlay } from './BacklogOverlay'
import { SeekBar } from './SeekBar'
import { computeDisplayIndex, findHistoryIndexForDisplayIndex } from './seekMapping'
import { Event, EventScene } from '../types'
import { ASPECT_RATIOS, type AspectRatio, parseAspectRatio } from './constants'

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

export class NovelRenderer {
  private app: Application
  /** init() 完了済みかのフラグ。React StrictMode 等で init 中に destroy が呼ばれたときの no-op 判定に使う */
  private appInitialized = false
  private dialogBox: DialogBox
  private bgGraphics: Graphics
  private bgContainer: Container
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
  private assetBaseUrl: string = ''
  private textureCache: Map<string, Texture> = new Map()
  /** setBackground の非同期ロード用トークン。destroy / 再入 の race 回避に使う */
  private bgLoadToken = 0
  private audioManager: AudioManager

  /** ゲーム状態（フラグストア）— 章またぎで保持 */
  private gameState: GameState = new GameState()

  /** 選択肢オーバーレイ */
  private choiceOverlay: ChoiceOverlay

  /** 選択肢表示中フラグ */
  private waitingForChoice = false

  /** Wait イベント実行中フラグ */
  private waitingForWait = false

  /** Wait タイマー（destroy 時キャンセル用） */
  private waitTimer: ReturnType<typeof setTimeout> | null = null

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
  private autoTimer: ReturnType<typeof setTimeout> | null = null
  /** オートモード待機時間 ms（settings.autoWaitMs から更新） */
  private autoWaitMs: number = 2500
  /** autoMode 変更時の React 側同期コールバック */
  private onAutoModeChange: ((on: boolean) => void) | null = null

  constructor(config?: { dialogBorderless?: boolean; aspectRatio?: AspectRatio }) {
    this.app = new Application()
    this.bgGraphics = new Graphics()
    this.bgContainer = new Container()
    this.characterLayer = new CharacterLayer()
    this.blackoutOverlay = new Graphics()
    this.defaultDialogBorderless = config?.dialogBorderless ?? false
    const ratio = parseAspectRatio(config?.aspectRatio)
    this.screenWidth = ASPECT_RATIOS[ratio].width
    this.screenHeight = ASPECT_RATIOS[ratio].height
    this.dialogBox = new DialogBox({
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      borderless: this.defaultDialogBorderless,
    })
    this.audioManager = new AudioManager()
    this.choiceOverlay = new ChoiceOverlay(this.screenWidth, this.screenHeight)
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

    // 立ち絵レイヤー
    this.app.stage.addChild(this.characterLayer)

    // 暗転レイヤー
    this.blackoutOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.blackoutOverlay.fill(0x000000)
    this.blackoutOverlay.visible = false
    this.app.stage.addChild(this.blackoutOverlay)

    // ダイアログボックス
    this.app.stage.addChild(this.dialogBox)

    // シークバー（ダイアログボックスの下）
    this.seekBar.setOnSeek((displayIndex) => this.seekToTextEventDisplayIndex(displayIndex))
    this.app.stage.addChild(this.seekBar)

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
   * 全シーンを設定して最初のシーンから開始する
   */
  setScenes(scenes: EventScene[]): void {
    this.allScenes = scenes
    this.gameState.clear()
    if (scenes.length > 0) {
      this.currentSceneId = scenes[0].id
      this.setEvents(scenes[0].events)
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
  }

  /**
   * イベント配列をリセットし、最初のテキストイベントまで進めて描画する
   */
  private resetAndStartEvents(events: Event[]): void {
    this.waitingForChoice = false
    this.waitingForWait = false
    if (this.waitTimer) {
      clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    if (this.autoTimer) {
      clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
    this.choiceOverlay.hide()
    this.audioManager.stopBgm(0)
    this.clearBackground()
    this.characterLayer.clear()
    this.blackoutOverlay.visible = false
    this.currentBgmPath = null
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
  }

  /**
   * 終了コールバック
   */
  onEnd(callback: () => void): void {
    this.onEndCallback = callback
  }

  /**
   * 設定（テキスト速度・音量）をリアルタイムに反映する。
   * voiceVolume は #144 voice 実装後に対応予定。
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
    if (!on && this.autoTimer) {
      clearTimeout(this.autoTimer)
      this.autoTimer = null
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
      clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    if (this.autoTimer) {
      clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
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
    this.app.destroy(true, { children: true })
    this.initialized = false
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
    // フラグ復元
    this.gameState.fromJSON(state.flags)

    // インデックス復元
    this.eventIndex = state.eventIndex
    this.textIndex = state.textIndex

    // 背景復元
    if (state.backgroundPath) {
      this.setBackground(state.backgroundPath)
    } else {
      this.clearBackground()
    }

    // 暗転復元
    this.blackoutOverlay.visible = state.isBlackout

    // 立ち絵復元
    this.characterLayer.clear()
    for (const ch of state.characters) {
      this.characterLayer.show(ch.name, ch.expression, ch.position, this.assetBaseUrl)
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
    this.audioManager.ensureContext()
    if (this.backlogOverlay.visible) {
      this.backlogOverlay.hide()
      return
    }
    if (this.saveLoadOverlay.visible) return
    // 手動クリック/タップでオートモードをキャンセル (#139)
    this.setAutoMode(false)
    this.advanceOrSkipTypewriter()
  }

  private handleWheel = (e: WheelEvent): void => {
    if (this.backlogOverlay.visible) {
      e.preventDefault()
      this.backlogOverlay.handleWheel(e.deltaY)
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
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
        // 手動キー操作でオートモードをキャンセル (#139)
        this.setAutoMode(false)
        this.advanceOrSkipTypewriter()
        break
      case 'ArrowRight':
        this.setAutoMode(false)
        this.advanceOrSkipTypewriter()
        break
      case 'ArrowLeft':
        this.setAutoMode(false)
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
        this.blackoutOverlay.visible = false
      }
      return
    }
    if ('Background' in event) {
      this.setBackground(event.Background.path)
      return
    }
    if ('Blackout' in event) {
      this.blackoutOverlay.visible = event.Blackout.action === 'On'
      return
    }
    if ('Bgm' in event) {
      if (event.Bgm.action === 'Play' && event.Bgm.path) {
        const soundUrl = `${this.assetBaseUrl}/sounds/${event.Bgm.path.replace(/^\//, '')}`
        this.audioManager.playBgm(soundUrl)
        this.currentBgmPath = event.Bgm.path
      } else {
        this.audioManager.stopBgm()
        this.currentBgmPath = null
      }
      return
    }
    if ('Se' in event) {
      const soundUrl = `${this.assetBaseUrl}/sounds/${event.Se.path.replace(/^\//, '')}`
      this.audioManager.playSe(soundUrl)
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
      this.waitingForChoice = true
      this.choiceOverlay.show(event.Choice.options, (jump: string) => {
        this.waitingForChoice = false
        this.choiceOverlay.hide()
        this.jumpToScene(jump)
      })
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
      this.characterLayer.remove(event.Exit.character)
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
    if ('Wait' in event) {
      // 進行を停止し、指定ミリ秒後に再開（eventIndex のインクリメントはコールバック内で行う）
      this.waitingForWait = true
      this.waitTimer = setTimeout(() => {
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
      this.assetBaseUrl
    )
  }

  /**
   * 背景画像を設定する（アスペクト比維持でカバー）
   */
  private setBackground(path: string): void {
    this.currentBackgroundPath = path
    this.bgContainer.removeChildren()

    if (!this.assetBaseUrl) return

    const cleanPath = path.replace(/^\//, '')
    const url = `${this.assetBaseUrl}/images/${cleanPath}`

    // キャッシュ済みの Texture があれば再利用（戻る操作時のフリッカー防止）
    const cached = this.textureCache.get(url)
    if (cached) {
      const sprite = new Sprite(cached)
      this.applyCoverFit(sprite)
      this.bgContainer.addChild(sprite)
      return
    }

    // ロード要求ごとにトークンを更新し、古い非同期完了による UAF / race を防ぐ
    const token = ++this.bgLoadToken
    Assets.load(url)
      .then((texture) => {
        if (token !== this.bgLoadToken) return
        if (!this.initialized) return
        this.textureCache.set(url, texture)
        const sprite = new Sprite(texture)
        this.applyCoverFit(sprite)
        this.bgContainer.addChild(sprite)
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
   * 背景画像をクリアする
   */
  private clearBackground(): void {
    this.currentBackgroundPath = null
    this.bgContainer.removeChildren()
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
      clearTimeout(this.waitTimer)
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

    // 空行 = 改ページ（テキストクリア後に次行へ自動進行はしない。空表示する）
    const name = textEvt.type === 'dialog' ? textEvt.character : null
    // オートモード時はタイピング完了後に autoWaitMs 待機してから自動進行 (#139)
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
   * オートモード: autoWaitMs 後に advance() を呼ぶタイマーをセット (#139)。
   * 選択肢待ち・Wait 待ち中は発動しない。
   */
  private scheduleAutoAdvance(): void {
    if (!this.autoMode) return
    if (this.waitingForChoice || this.waitingForWait) return
    if (this.autoTimer) {
      clearTimeout(this.autoTimer)
    }
    this.autoTimer = setTimeout(() => {
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
