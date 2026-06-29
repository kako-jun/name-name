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

import { Container, Graphics, Text as PixiText, TextStyle, Ticker } from 'pixi.js'
import { ChoiceOption } from '../types'
import type { AudioManager } from './AudioManager'
import type { DestroyOptions } from 'pixi.js'

const BUTTON_WIDTH = 480
const BUTTON_HEIGHT = 52
const BUTTON_GAP = 16
const HOVER_SCALE = 1.05
const SHADOW_OFFSET = 4
const SHOW_FADE_MS = 240
const SHOW_STAGGER_MS = 18
const MAX_SHOW_STAGGER_MS = 260

export type ChoiceStyleName = 'default' | 'soft' | 'monochrome'

interface ChoiceTheme {
  fillNormal: number
  fillHover: number
  borderNormal: number
  borderHover: number
  borderWidth: number
  textColor: number
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  fontSize: number
  radius: number
  shadowColor: number
  shadowAlpha: number
}

const STYLE_THEMES: Record<ChoiceStyleName, ChoiceTheme> = {
  default: {
    fillNormal: 0x1a1a2e,
    fillHover: 0x16213e,
    borderNormal: 0xa8dadc,
    borderHover: 0xf1faee,
    borderWidth: 2,
    textColor: 0xf1faee,
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
    borderNormal: 0xffb3c1,
    borderHover: 0xff8fa3,
    borderWidth: 3,
    textColor: 0x5d2952,
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
    borderNormal: 0xffffff,
    borderHover: 0xffffff,
    borderWidth: 2,
    textColor: 0xffffff,
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
  if (name in STYLE_THEMES) {
    return STYLE_THEMES[name as ChoiceStyleName]
  }
  console.warn(
    `[name-name] choice_style "${name}" は未知のテーマです。default にフォールバックします。利用可能: ${Object.keys(
      STYLE_THEMES
    ).join(' / ')}`
  )
  return STYLE_THEMES.default
}

export class ChoiceOverlay extends Container {
  private onSelect: ((jump: string) => void) | null = null
  private audioManager: AudioManager | null = null
  private renderResolution = 1
  private fadeTicker: Ticker | null = null
  private fadeElapsedMs = 0
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
   * 選択肢を表示する。
   *
   * @param options 表示する選択肢
   * @param onSelect 確定時のコールバック
   * @param style   `default` / `soft` / `monochrome`。未指定 or 不明値は `default` 扱い
   */
  show(options: ChoiceOption[], onSelect: (jump: string) => void, style?: string | null): void {
    if (options.length === 0) return
    this.onSelect = onSelect
    this.stopFadeTicker()
    // 連続呼び出しで子オブジェクトが滞留しないよう明示 destroy する (#146 R1 S3)
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.lastHoverIdx = null
    // セーブデータからのロード直後など、最初のユーザー入力が選択肢クリックになる
    // ケースで AudioContext が未初期化のまま playSelectTone が無音になるのを防ぐ。
    // pointerdown 時点でも resume できるが、show 時にも保険で叩いておく (#146 R1 S2)
    this.audioManager?.ensureContext()

    const theme = resolveStyle(style)

    const totalHeight = options.length * BUTTON_HEIGHT + (options.length - 1) * BUTTON_GAP
    const startY = (this.screenHeight - totalHeight) / 2

    const textStyle = new TextStyle({
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      fill: theme.textColor,
      fontWeight: theme.fontWeight,
    })

    options.forEach((option, i) => {
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
      this.drawButton(bg, theme, theme.fillNormal, theme.borderNormal)
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
      buttonContainer.y = startY + i * (BUTTON_HEIGHT + BUTTON_GAP) + BUTTON_HEIGHT / 2

      buttonContainer.on('pointerover', () => {
        bg.clear()
        this.drawButton(bg, theme, theme.fillHover, theme.borderHover)
        buttonContainer.scale.set(HOVER_SCALE)
        // 同一ボタンで pointerover が連発しても再生しない (#146 R1 S1)
        if (this.lastHoverIdx !== i) {
          this.audioManager?.playHoverTone()
          this.lastHoverIdx = i
        }
      })

      buttonContainer.on('pointerout', () => {
        bg.clear()
        this.drawButton(bg, theme, theme.fillNormal, theme.borderNormal)
        buttonContainer.scale.set(1)
        if (this.lastHoverIdx === i) {
          this.lastHoverIdx = null
        }
      })

      buttonContainer.on('pointerdown', (e) => {
        e.stopPropagation()
        this.audioManager?.ensureContext()
        this.audioManager?.playSelectTone()
        this.onSelect?.(option.jump)
      })

      this.addChild(buttonContainer)
    })

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
      this.children.forEach((child, i) => {
        const delayMs = Math.min(i * SHOW_STAGGER_MS, MAX_SHOW_STAGGER_MS)
        const t = Math.min(1, Math.max(0, (this.fadeElapsedMs - delayMs) / SHOW_FADE_MS))
        child.alpha = t
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
}
