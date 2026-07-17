/**
 * 選択肢UI (#146)
 *
 * PixiJS の Container 内にボタン（Graphics + Text）を縦並びで表示する。
 * ホバーでスケール拡大＋影、クリックで確定音＋選択コールバックを呼ぶ。
 *
 * 3 種類のスタイルバリエーション:
 *   - default:    現行ベースの濃紺＋淡い水色枠。動画用途で違和感なく使える落ち着き
 *   - soft:       パステルピンクの子供向け。柔らかい角丸＋太字
 *   - monochrome: 黒地白枠白文字のシリアス系。Noto Serif JP
 *
 * pixi-filters への依存は避けるため、影は半透明黒の矩形を背面に重ねて表現する。
 */

import { Container, Graphics, Rectangle, Text as PixiText, TextStyle, Ticker } from 'pixi.js'
import { ChoiceOption } from '../types'
import type { AudioManager } from './AudioManager'
import { hasOwn } from './ownProperty'
import type { DestroyOptions, FederatedPointerEvent } from 'pixi.js'

const BUTTON_WIDTH = 480
const BUTTON_HEIGHT = 52
const BUTTON_GAP = 16
const HOVER_SCALE = 1.05
const SHADOW_OFFSET = 4
const SHOW_FADE_MS = 240
const SHOW_STAGGER_MS = 18
const MAX_SHOW_STAGGER_MS = 260
const VIEWPORT_VERTICAL_MARGIN = 24
const TAP_MOVE_THRESHOLD_PX = 8

export type ChoiceStyleName = 'default' | 'soft' | 'monochrome'

interface ChoiceTheme {
  fillNormal: number
  fillHover: number
  fillRead: number
  fillReadHover: number
  borderNormal: number
  borderHover: number
  borderRead: number
  borderReadHover: number
  borderWidth: number
  textColor: number
  textReadColor: number
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  fontSize: number
  radius: number
  shadowColor: number
  shadowAlpha: number
}

interface ChoiceVisual {
  fill: number
  border: number
  text: number
}

const STYLE_THEMES: Record<ChoiceStyleName, ChoiceTheme> = {
  default: {
    fillNormal: 0x1a1a2e,
    fillHover: 0x16213e,
    fillRead: 0x2f3542,
    fillReadHover: 0x3d4658,
    borderNormal: 0xa8dadc,
    borderHover: 0xf1faee,
    borderRead: 0x9aa4b2,
    borderReadHover: 0xd1d5db,
    borderWidth: 2,
    textColor: 0xf1faee,
    textReadColor: 0xcbd5e1,
    fontFamily: "'Noto Sans JP', sans-serif",
    fontWeight: 'bold',
    fontSize: 20,
    radius: 8,
    shadowColor: 0x000000,
    shadowAlpha: 0.45,
  },
  // 子供向けバリエーション。パステルピンクで丸み強め＋太字
  soft: {
    fillNormal: 0xffe5ec,
    fillHover: 0xffd1dc,
    fillRead: 0xe8e1f0,
    fillReadHover: 0xded5ec,
    borderNormal: 0xffb3c1,
    borderHover: 0xff8fa3,
    borderRead: 0xb8a8ca,
    borderReadHover: 0x9d8bb8,
    borderWidth: 3,
    textColor: 0x5d2952,
    textReadColor: 0x5d536b,
    fontFamily: "'Noto Sans JP', sans-serif",
    fontWeight: 'bold',
    fontSize: 22,
    radius: 24,
    shadowColor: 0xff8fa3,
    shadowAlpha: 0.35,
  },
  // モノクロ＝シリアス系。明朝で可読性を上げる
  monochrome: {
    fillNormal: 0x000000,
    fillHover: 0x222222,
    fillRead: 0x2a2a2a,
    fillReadHover: 0x3a3a3a,
    borderNormal: 0xffffff,
    borderHover: 0xffffff,
    borderRead: 0x888888,
    borderReadHover: 0xbbbbbb,
    borderWidth: 2,
    textColor: 0xffffff,
    textReadColor: 0xbdbdbd,
    fontFamily: "'Noto Serif JP', serif",
    fontWeight: 'normal',
    fontSize: 20,
    radius: 0,
    shadowColor: 0xffffff,
    shadowAlpha: 0.15,
  },
}

/**
 * style 名からテーマを解決する (#146)。
 * 未指定 / 空文字 / 未知値はすべて `default` フォールバック。
 * 未知値のときのみ console.warn を出して typo に気付けるようにする
 * （null / undefined / "" / "default" は警告なし）。
 *
 * 単独 export しているのはユニットテスト用途。
 */
export function resolveStyle(name?: string | null): ChoiceTheme {
  if (!name || name === 'default') {
    return STYLE_THEMES.default
  }
  // own-property のみ見る (#368)。`in` 演算子は Object.prototype も辿ってしまい、脚本側の
  // 自由記述である name（frontmatter `choice_style:` の生文字列）が `constructor` 等と一致すると
  // `name in STYLE_THEMES` が誤って true になり、後続の `STYLE_THEMES[name]` が
  // ChoiceTheme ではなく Object コンストラクタ関数等を返してしまう。
  if (hasOwn(STYLE_THEMES, name)) {
    return STYLE_THEMES[name as ChoiceStyleName]
  }
  console.warn(
    `[name-name] choice_style "${name}" は未知のテーマです。default にフォールバックします。利用可能: ${Object.keys(
      STYLE_THEMES
    ).join(' / ')}`
  )
  return STYLE_THEMES.default
}

export function resolveChoiceVisual(
  theme: ChoiceTheme,
  alreadyRead: boolean,
  hover: boolean
): ChoiceVisual {
  if (alreadyRead) {
    return {
      fill: hover ? theme.fillReadHover : theme.fillRead,
      border: hover ? theme.borderReadHover : theme.borderRead,
      text: theme.textReadColor,
    }
  }
  return {
    fill: hover ? theme.fillHover : theme.fillNormal,
    border: hover ? theme.borderHover : theme.borderNormal,
    text: theme.textColor,
  }
}

export class ChoiceOverlay extends Container {
  private onSelect: ((jump: string) => void) | null = null
  private onScrollableChange: ((scrollable: boolean) => void) | null = null
  private audioManager: AudioManager | null = null
  private renderResolution = 1
  private fadeTicker: Ticker | null = null
  private fadeElapsedMs = 0
  private contentContainer: Container | null = null
  private buttonContainers: Container[] = []
  private scrollOffset = 0
  private maxScroll = 0
  private viewportY = 0
  private dragPointerId: number | null = null
  private dragLastY = 0
  private pressPointerId: number | null = null
  private pressStartX = 0
  private pressStartY = 0
  // 直前にホバー音を鳴らしたボタン index。マウスがボタン境界をジリジリ動いて
  // pointerover が連続発火しても、別ボタンへ移動した時だけ再生するための記録 (#146 R1 S1)
  private lastHoverIdx: number | null = null

  constructor(
    private screenWidth: number,
    private screenHeight: number
  ) {
    super()
    this.eventMode = 'static'
  }

  /**
   * クリック確定音／ホバー音を鳴らすために AudioManager を注入する (#146)。
   * 未注入のときは無音（テスト等で AudioManager を渡さない構成にも耐える）。
   */
  setAudioManager(audio: AudioManager | null): void {
    this.audioManager = audio
  }

  /**
   * Pixi Text は既定 resolution=1 で canvas 化されるため、DPR 描画時に選択肢文字だけ
   * 低解像度に見える。Renderer の resolution を渡して、ボタン内 Text を同じ密度で描く。
   */
  setRenderResolution(resolution: number): void {
    if (!(resolution > 0) || !Number.isFinite(resolution)) return
    this.renderResolution = resolution
  }

  /**
   * スクロール可能な選択肢リスト（#339）の表示状態が変わるたびに呼ばれるコールバックを設定する。
   *
   * このリストは縦方向ドラッグ（`handleDragMove` の `deltaY`）で操作するため、呼び出し側
   * （NovelRenderer）は scrollable=true の間だけ canvas の touch-action を 'none' に戻す必要がある。
   * 'pan-y' のままだと、ブラウザがその縦ドラッグをネイティブスクロールとして横取りしてしまい
   * （`pointercancel` でジェスチャが中断される）、リストが操作できなくなる (#434)。
   *
   * ChoiceOverlay 自身は「ロック」という概念を持たず、自分がスクロール可能かどうか（`scrollable`
   * = `maxScroll > 0`）を知っているだけ。touch-action をどう扱うかは呼び出し側（NovelRenderer）の
   * 責務であり、その変換ロジックはここには持たない。
   */
  setOnScrollableChange(callback: (scrollable: boolean) => void): void {
    this.onScrollableChange = callback
  }

  /**
   * 選択肢を表示する。
   *
   * @param options 表示する選択肢
   * @param onSelect 確定時のコールバック
   * @param style   `default` / `soft` / `monochrome`。未指定 or 不明値は `default` 扱い
   */
  show(
    options: ChoiceOption[],
    onSelect: (jump: string) => void,
    style?: string | null,
    readJumps?: ReadonlySet<string>
  ): void {
    if (options.length === 0) return
    this.onSelect = onSelect
    this.stopFadeTicker()
    // 連続呼び出しで子オブジェクトが滞留しないよう明示 destroy する (#146 R1 S3)
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.lastHoverIdx = null
    this.resetScrollState()
    // セーブデータからのロード直後など、最初のユーザー入力が選択肢クリックになる
    // ケースで AudioContext が未初期化のまま playSelectTone が無音になるのを防ぐ。
    // pointerdown 時点でも resume できるが、show 時にも保険で叩いておく (#146 R1 S2)
    this.audioManager?.ensureContext()

    const theme = resolveStyle(style)

    const totalHeight = options.length * BUTTON_HEIGHT + (options.length - 1) * BUTTON_GAP
    const maxViewportHeight = Math.max(
      BUTTON_HEIGHT,
      this.screenHeight - VIEWPORT_VERTICAL_MARGIN * 2
    )
    const viewportHeight = Math.min(totalHeight, maxViewportHeight)
    this.maxScroll = Math.max(0, totalHeight - viewportHeight)
    const scrollable = this.maxScroll > 0
    // touch-action の scroll-lock 通知 (#434)。詳細は setOnScrollableChange 参照。
    this.onScrollableChange?.(scrollable)
    const startY = (this.screenHeight - totalHeight) / 2

    if (scrollable) {
      this.viewportY = (this.screenHeight - viewportHeight) / 2
      this.hitArea = new Rectangle(0, this.viewportY, this.screenWidth, viewportHeight)
      const contentContainer = new Container()
      this.contentContainer = contentContainer
      const mask = new Graphics()
      mask.rect(0, this.viewportY, this.screenWidth, viewportHeight)
      mask.fill(0xffffff)
      // PixiJS v8 ではオブジェクトを `.mask` に割り当てた時点で通常描画から自動的に
      // 除外される。ここで renderable=false を付けるとステンシルにマスク形状が書き込まれず、
      // クリップ領域が空になって選択肢が一切描画されなくなる (#339 regression)。
      this.addChild(mask)
      contentContainer.mask = mask
      this.on('pointerdown', this.handleDragStart)
      this.on('pointermove', this.handleDragMove)
      this.on('pointerup', this.handleDragEnd)
      this.on('pointerupoutside', this.handleDragEnd)
      this.on('pointercancel', this.handleDragEnd)
    }

    options.forEach((option, i) => {
      const alreadyRead = readJumps?.has(option.jump) ?? false
      const normalVisual = resolveChoiceVisual(theme, alreadyRead, false)
      const textStyle = new TextStyle({
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize,
        fill: normalVisual.text,
        fontWeight: theme.fontWeight,
      })
      const buttonContainer = new Container()
      buttonContainer.eventMode = 'static'
      buttonContainer.cursor = 'pointer'
      buttonContainer.alpha = 0

      // pivot を中央に置いて scale 拡大時にボタン中心が動かないようにする
      buttonContainer.pivot.set(BUTTON_WIDTH / 2, BUTTON_HEIGHT / 2)

      // 影レイヤ（pixi-filters 依存回避のため半透明矩形で代用）
      const shadow = new Graphics()
      shadow.roundRect(SHADOW_OFFSET, SHADOW_OFFSET, BUTTON_WIDTH, BUTTON_HEIGHT, theme.radius)
      shadow.fill({ color: theme.shadowColor, alpha: theme.shadowAlpha })
      buttonContainer.addChild(shadow)

      const bg = new Graphics()
      this.drawButton(bg, theme, normalVisual.fill, normalVisual.border)
      buttonContainer.addChild(bg)

      const label = new PixiText({
        text: option.text,
        style: textStyle,
        resolution: this.renderResolution,
        roundPixels: true,
      })
      label.x = BUTTON_WIDTH / 2
      label.y = BUTTON_HEIGHT / 2
      label.anchor.set(0.5, 0.5)
      buttonContainer.addChild(label)

      // pivot を中央に動かしたため、ボタン中心を所定位置に置く
      buttonContainer.x = this.screenWidth / 2
      buttonContainer.y = scrollable
        ? i * (BUTTON_HEIGHT + BUTTON_GAP) + BUTTON_HEIGHT / 2
        : startY + i * (BUTTON_HEIGHT + BUTTON_GAP) + BUTTON_HEIGHT / 2

      buttonContainer.on('pointerover', () => {
        const hoverVisual = resolveChoiceVisual(theme, alreadyRead, true)
        bg.clear()
        this.drawButton(bg, theme, hoverVisual.fill, hoverVisual.border)
        buttonContainer.scale.set(HOVER_SCALE)
        // 同一ボタンで pointerover が連発しても再生しない (#146 R1 S1)
        if (this.lastHoverIdx !== i) {
          this.audioManager?.playHoverTone()
          this.lastHoverIdx = i
        }
      })

      buttonContainer.on('pointerout', () => {
        bg.clear()
        this.drawButton(bg, theme, normalVisual.fill, normalVisual.border)
        buttonContainer.scale.set(1)
        if (this.lastHoverIdx === i) {
          this.lastHoverIdx = null
        }
      })

      const selectChoice = (e: FederatedPointerEvent) => {
        e.stopPropagation()
        this.audioManager?.ensureContext()
        this.audioManager?.playSelectTone()
        this.onSelect?.(option.jump)
      }
      buttonContainer.on('pointerdown', (e) => {
        this.pressPointerId = e.pointerId
        this.pressStartX = e.global.x
        this.pressStartY = e.global.y
        if (scrollable) {
          this.handleDragStart(e)
        }
        e.stopPropagation()
      })
      buttonContainer.on('pointerup', (e) => {
        if (this.pressPointerId !== e.pointerId) return
        const dx = e.global.x - this.pressStartX
        const dy = e.global.y - this.pressStartY
        if (scrollable) {
          this.handleDragEnd(e)
        }
        this.clearChoicePress()
        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD_PX) return
        selectChoice(e)
      })
      buttonContainer.on('pointerupoutside', (e) => {
        if (this.pressPointerId === e.pointerId) {
          if (scrollable) {
            this.handleDragEnd(e)
          }
          this.clearChoicePress()
        }
      })
      buttonContainer.on('pointercancel', (e) => {
        if (this.pressPointerId === e.pointerId) {
          if (scrollable) {
            this.handleDragEnd(e)
          }
          this.clearChoicePress()
        }
      })

      if (this.contentContainer) {
        this.contentContainer.addChild(buttonContainer)
      } else {
        this.addChild(buttonContainer)
      }
      this.buttonContainers.push(buttonContainer)
    })
    if (scrollable && this.contentContainer) {
      this.addChild(this.contentContainer)
      this.applyScrollOffset()
    }

    this.visible = true
    this.alpha = 1
    this.startFadeIn()
  }

  /**
   * 選択肢を非表示にする。
   * 子の Container / Graphics / Text は明示的に destroy してリスナーと
   * GPU リソースを解放する (#146 R1 S3)。
   */
  hide(): void {
    this.stopFadeTicker()
    this.visible = false
    this.alpha = 1
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.onSelect = null
    this.lastHoverIdx = null
    this.resetScrollState()
    // 非表示になった時点でスクロール可能状態ではなくなるので、無条件で scroll-lock を解除する (#434)。
    this.onScrollableChange?.(false)
  }

  override destroy(options?: DestroyOptions): void {
    this.stopFadeTicker()
    super.destroy(options)
  }

  private drawButton(
    g: Graphics,
    theme: ChoiceTheme,
    fillColor: number,
    borderColor: number
  ): void {
    g.roundRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, theme.radius)
    g.fill(fillColor)
    g.stroke({ color: borderColor, width: theme.borderWidth })
  }

  private startFadeIn(): void {
    this.fadeElapsedMs = 0
    const ticker = new Ticker()
    ticker.add(() => {
      this.fadeElapsedMs += ticker.deltaMS
      let allDone = true
      this.buttonContainers.forEach((button, i) => {
        const delayMs = Math.min(i * SHOW_STAGGER_MS, MAX_SHOW_STAGGER_MS)
        const t = Math.min(1, Math.max(0, (this.fadeElapsedMs - delayMs) / SHOW_FADE_MS))
        button.alpha = t
        if (t < 1) allDone = false
      })
      if (allDone) {
        this.stopFadeTicker()
      }
    })
    ticker.start()
    this.fadeTicker = ticker
  }

  private stopFadeTicker(): void {
    if (!this.fadeTicker) return
    this.fadeTicker.stop()
    this.fadeTicker.destroy()
    this.fadeTicker = null
  }

  handleWheel(deltaY: number): boolean {
    return this.scrollBy(deltaY)
  }

  private scrollBy(deltaY: number): boolean {
    if (this.maxScroll <= 0) return false
    const before = this.scrollOffset
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + deltaY))
    this.applyScrollOffset()
    return this.scrollOffset !== before
  }

  private applyScrollOffset(): void {
    if (!this.contentContainer) return
    this.contentContainer.y = this.viewportY - this.scrollOffset
  }

  private handleDragStart = (e: FederatedPointerEvent): void => {
    if (this.maxScroll <= 0) return
    this.dragPointerId = e.pointerId
    this.dragLastY = e.global.y
  }

  private handleDragMove = (e: FederatedPointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return
    const y = e.global.y
    const delta = this.dragLastY - y
    this.dragLastY = y
    if (this.scrollBy(delta)) {
      e.stopPropagation()
    }
  }

  private handleDragEnd = (e: FederatedPointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return
    this.dragPointerId = null
  }

  private clearChoicePress(): void {
    this.pressPointerId = null
    this.pressStartX = 0
    this.pressStartY = 0
  }

  private resetScrollState(): void {
    this.off('pointerdown', this.handleDragStart)
    this.off('pointermove', this.handleDragMove)
    this.off('pointerup', this.handleDragEnd)
    this.off('pointerupoutside', this.handleDragEnd)
    this.off('pointercancel', this.handleDragEnd)
    this.contentContainer = null
    this.buttonContainers = []
    this.scrollOffset = 0
    this.maxScroll = 0
    this.viewportY = 0
    this.dragPointerId = null
    this.dragLastY = 0
    this.clearChoicePress()
    this.hitArea = null
  }
}
