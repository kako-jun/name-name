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
import { Event, EventScene } from '../types'
import { GAME_WIDTH, GAME_HEIGHT } from './constants'

/** Dialog / Narration から text を取り出すヘルパー */
function getTextEvent(event: Event):
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

  constructor() {
    this.app = new Application()
    this.bgGraphics = new Graphics()
    this.bgContainer = new Container()
    this.characterLayer = new CharacterLayer()
    this.blackoutOverlay = new Graphics()
    this.dialogBox = new DialogBox({
      screenWidth: GAME_WIDTH,
      screenHeight: GAME_HEIGHT,
    })
    this.audioManager = new AudioManager()
    this.choiceOverlay = new ChoiceOverlay(GAME_WIDTH, GAME_HEIGHT)
    this.saveLoadOverlay = new SaveLoadOverlay(GAME_WIDTH, GAME_HEIGHT, this.saveManager)
    this.backlogOverlay = new BacklogOverlay(GAME_WIDTH, GAME_HEIGHT)
    this.seekBar = new SeekBar()
  }

  /**
   * PixiJS Application を初期化し、親要素に Canvas を挿入する
   */
  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
      background: 0x000000,
      antialias: true,
    })

    container.appendChild(this.app.canvas as HTMLCanvasElement)

    // 黒背景
    this.bgGraphics.rect(0, 0, GAME_WIDTH, GAME_HEIGHT)
    this.bgGraphics.fill(0x000000)
    this.app.stage.addChild(this.bgGraphics)

    // 背景画像コンテナ
    this.app.stage.addChild(this.bgContainer)

    // 立ち絵レイヤー
    this.app.stage.addChild(this.characterLayer)

    // 暗転レイヤー
    this.blackoutOverlay.rect(0, 0, GAME_WIDTH, GAME_HEIGHT)
    this.blackoutOverlay.fill(0x000000)
    this.blackoutOverlay.visible = false
    this.app.stage.addChild(this.blackoutOverlay)

    // ダイアログボックス
    this.app.stage.addChild(this.dialogBox)

    // シークバー（ダイアログボックスの下）
    this.seekBar.setOnSeek((index) => this.seekTo(index))
    this.app.stage.addChild(this.seekBar)

    // シーンカウンター
    const counterStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: 0xa8dadc,
      fontWeight: 'bold',
    })
    this.counterText = new PixiText({ text: '', style: counterStyle })
    this.counterText.x = GAME_WIDTH - 20
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
    this.choiceOverlay.hide()
    this.audioManager.stopBgm(0)
    this.clearBackground()
    this.characterLayer.clear()
    this.blackoutOverlay.visible = false
    this.currentBgmPath = null

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
   * リソース解放
   */
  destroy(): void {
    this.app.canvas.removeEventListener('pointerdown', this.handleAdvance)
    this.app.canvas.removeEventListener('wheel', this.handleWheel)
    window.removeEventListener('keydown', this.handleKeyDown)
    if (this.waitTimer) {
      clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.audioManager.destroy()
    this.characterLayer.clear()
    this.choiceOverlay.hide()
    this.saveLoadOverlay.hide()
    this.backlogOverlay.hide()
    this.dialogBox.dispose()
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

  private handleAdvance = (): void => {
    this.audioManager.ensureContext()
    if (this.backlogOverlay.visible) {
      this.backlogOverlay.hide()
      return
    }
    if (this.saveLoadOverlay.visible) return
    this.advance()
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
        this.advance()
        break
      case 'ArrowRight':
        this.advance()
        break
      case 'ArrowLeft':
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

    Assets.load(url)
      .then((texture: Texture) => {
        this.textureCache.set(url, texture)
        const sprite = new Sprite(texture)
        this.applyCoverFit(sprite)
        this.bgContainer.addChild(sprite)
      })
      .catch(() => {
        console.warn(`[name-name] 背景画像の読み込みに失敗: ${url}`)
      })
  }

  private applyCoverFit(sprite: Sprite): void {
    const scaleX = GAME_WIDTH / sprite.texture.width
    const scaleY = GAME_HEIGHT / sprite.texture.height
    const scale = Math.max(scaleX, scaleY)
    sprite.width = sprite.texture.width * scale
    sprite.height = sprite.texture.height * scale
    sprite.x = (GAME_WIDTH - sprite.width) / 2
    sprite.y = (GAME_HEIGHT - sprite.height) / 2
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
    this.dialogBox.setDialog(name, line)

    // 最後のテキスト行かつ最後のイベントならインジケーター非表示
    const isLastText = this.textIndex >= textEvt.text.length - 1
    const isLastEvent = this.eventIndex >= this.resolvedEvents.length - 1
    this.dialogBox.setIndicatorVisible(!(isLastText && isLastEvent))

    this.updateCounter()
    this.updateSeekBar()
  }

  private updateCounter(): void {
    if (!this.counterText) return
    const total = this.displayEventCount
    // 表示イベントの中での現在位置を計算
    let displayIndex = 0
    for (let i = 0; i < this.eventIndex && i < this.resolvedEvents.length; i++) {
      if (getTextEvent(this.resolvedEvents[i])) displayIndex++
    }
    if (
      this.eventIndex < this.resolvedEvents.length &&
      getTextEvent(this.resolvedEvents[this.eventIndex])
    ) {
      displayIndex++
    }
    this.counterText.text = `${displayIndex} / ${total}`
  }

  /**
   * シークバーの表示を更新する
   */
  private updateSeekBar(): void {
    // history.length - 1 が現在のインデックス（0-based）
    const current = Math.max(0, this.history.length - 1)
    const total = this.history.length
    this.seekBar.update(current, total)
  }
}
