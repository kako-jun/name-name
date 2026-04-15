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

import { Application, Container, Graphics, Sprite, Text as PixiText, TextStyle } from 'pixi.js'
import { DialogBox } from './DialogBox'
import { AudioManager } from './AudioManager'
import { Event } from '../types'

const GAME_WIDTH = 800
const GAME_HEIGHT = 600

/** Dialog / Narration から text を取り出すヘルパー */
function getTextEvent(
  event: Event
):
  | { type: 'dialog'; character: string | null; text: string[] }
  | { type: 'narration'; text: string[] }
  | null {
  if (typeof event === 'object' && event !== null) {
    if ('Dialog' in event) {
      return { type: 'dialog', character: event.Dialog.character, text: event.Dialog.text }
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
  private blackoutOverlay: Graphics
  private counterText: PixiText | null = null
  private displayEventCount = 0

  private events: Event[] = []
  private eventIndex = 0
  private textIndex = 0

  private initialized = false
  private onEndCallback: (() => void) | null = null
  private assetBaseUrl: string = ''
  private textureCache: Map<string, Sprite> = new Map()
  private audioManager: AudioManager

  constructor() {
    this.app = new Application()
    this.bgGraphics = new Graphics()
    this.bgContainer = new Container()
    this.blackoutOverlay = new Graphics()
    this.dialogBox = new DialogBox({
      screenWidth: GAME_WIDTH,
      screenHeight: GAME_HEIGHT,
    })
    this.audioManager = new AudioManager()
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

    // 暗転レイヤー
    this.blackoutOverlay.rect(0, 0, GAME_WIDTH, GAME_HEIGHT)
    this.blackoutOverlay.fill(0x000000)
    this.blackoutOverlay.visible = false
    this.app.stage.addChild(this.blackoutOverlay)

    // ダイアログボックス
    this.app.stage.addChild(this.dialogBox)

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

    // クリック/タップで進行
    this.app.canvas.addEventListener('pointerdown', this.handleAdvance)

    // キーボードで進行
    window.addEventListener('keydown', this.handleKeyDown)

    this.initialized = true
  }

  /**
   * イベントキューを設定して最初の表示イベントを表示
   */
  setEvents(events: Event[]): void {
    this.events = events
    this.eventIndex = 0
    this.textIndex = 0
    this.displayEventCount = events.filter((e) => getTextEvent(e) !== null).length
    this.textureCache.clear()
    this.audioManager.stopBgm(0)
    this.clearBackground()
    this.blackoutOverlay.visible = false
    this.processUntilNextTextEvent()
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
    window.removeEventListener('keydown', this.handleKeyDown)
    this.audioManager.destroy()
    this.dialogBox.dispose()
    this.app.destroy(true, { children: true })
    this.initialized = false
  }

  // --- private ---

  private handleAdvance = (): void => {
    this.audioManager.ensureContext()
    this.advance()
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    this.audioManager.ensureContext()
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
    }
  }

  /**
   * 次のテキスト / 次のイベントへ進む
   */
  private advance(): void {
    if (this.events.length === 0) return

    const current = this.events[this.eventIndex]
    const textEvt = getTextEvent(current)

    if (textEvt) {
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

    if (this.eventIndex >= this.events.length) {
      // 全イベント完了
      this.dialogBox.setDialog(null, '')
      this.dialogBox.setIndicatorVisible(false)
      this.updateCounter()
      this.onEndCallback?.()
      return
    }

    this.processUntilNextTextEvent()
    this.render()
  }

  /**
   * 1つ前の表示イベントに戻る
   */
  private goBack(): void {
    if (this.events.length === 0) return

    const current = this.events[this.eventIndex]
    const textEvt = getTextEvent(current)

    if (textEvt && this.textIndex > 0) {
      this.textIndex--
      this.render()
      return
    }

    // 前のイベントへ
    if (this.eventIndex > 0) {
      const oldEventIndex = this.eventIndex
      const oldTextIndex = this.textIndex

      this.eventIndex--
      this.textIndex = 0

      // 前の表示イベントを探す
      while (this.eventIndex > 0 && !getTextEvent(this.events[this.eventIndex])) {
        this.eventIndex--
      }

      if (!getTextEvent(this.events[this.eventIndex])) {
        // テキストイベントが見つからなかった — 何もしない
        this.eventIndex = oldEventIndex
        this.textIndex = oldTextIndex
        return
      }

      const prevEvt = getTextEvent(this.events[this.eventIndex])
      if (prevEvt) {
        // 最後のテキスト行を表示
        this.textIndex = prevEvt.text.length - 1
      }

      // 演出状態を先頭から再構築
      this.replayDirectivesUpTo(this.eventIndex)

      this.render()
    }
  }

  /**
   * 非テキストイベントを実行しながら次のテキストイベントまで進む
   */
  private processUntilNextTextEvent(): void {
    while (this.eventIndex < this.events.length) {
      if (getTextEvent(this.events[this.eventIndex])) break
      this.processDirective(this.events[this.eventIndex])
      this.eventIndex++
    }
  }

  /**
   * 演出イベント（Background, Blackout, SceneTransition）を実行する
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
      } else {
        this.audioManager.stopBgm()
      }
      return
    }
    if ('Se' in event) {
      const soundUrl = `${this.assetBaseUrl}/sounds/${event.Se.path.replace(/^\//, '')}`
      this.audioManager.playSe(soundUrl)
      return
    }
    // Exit, Wait, Flag, Condition 等は別Issue — スキップ
  }

  /**
   * 背景画像を設定する（アスペクト比維持でカバー）
   */
  private setBackground(path: string): void {
    this.bgContainer.removeChildren()

    if (!this.assetBaseUrl) return

    const cleanPath = path.replace(/^\//, '')
    const url = `${this.assetBaseUrl}/images/${cleanPath}`

    // キャッシュ済みの Sprite があればクローンして再利用（戻る操作時のフリッカー防止）
    const cached = this.textureCache.get(url)
    if (cached && cached.texture.valid) {
      const sprite = new Sprite(cached.texture)
      this.applyCoverFit(sprite)
      this.bgContainer.addChild(sprite)
      return
    }

    const sprite = Sprite.from(url)

    sprite.texture.source.on('loaded', () => {
      this.textureCache.set(url, sprite)
      this.applyCoverFit(sprite)
      this.bgContainer.addChild(sprite)
    })

    sprite.texture.source.on('error', () => {
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
    this.bgContainer.removeChildren()
  }

  /**
   * 先頭から targetIndex まで演出イベントを再実行して状態を再構築する
   */
  private replayDirectivesUpTo(targetIndex: number): void {
    this.clearBackground()
    this.blackoutOverlay.visible = false
    this.audioManager.stopBgm(0)

    // 最後の BGM イベントを見つけて再生する（SE はリプレイしない）
    let lastBgmEvent: Event | null = null
    for (let i = 0; i <= targetIndex; i++) {
      const ev = this.events[i]
      if (!getTextEvent(ev)) {
        if (typeof ev === 'object' && ev !== null && 'Bgm' in ev) {
          lastBgmEvent = ev
        } else {
          this.processDirective(ev)
        }
      }
    }
    if (lastBgmEvent) {
      this.processDirective(lastBgmEvent)
    }
  }

  /**
   * 現在のイベント/テキスト行を画面に反映
   */
  private render(): void {
    if (!this.initialized) return
    if (this.eventIndex >= this.events.length) return

    const current = this.events[this.eventIndex]
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
    const isLastEvent = this.eventIndex >= this.events.length - 1
    this.dialogBox.setIndicatorVisible(!(isLastText && isLastEvent))

    this.updateCounter()
  }

  private updateCounter(): void {
    if (!this.counterText) return
    const total = this.displayEventCount
    // 表示イベントの中での現在位置を計算
    let displayIndex = 0
    for (let i = 0; i < this.eventIndex && i < this.events.length; i++) {
      if (getTextEvent(this.events[i])) displayIndex++
    }
    if (this.eventIndex < this.events.length && getTextEvent(this.events[this.eventIndex])) {
      displayIndex++
    }
    this.counterText.text = `${displayIndex} / ${total}`
  }
}
