/**
 * タイトル画面オーバーレイ (#628 フェーズ2b)。
 *
 * name-name の恒久ルール（docs/operations/doctrine/name-name/guidelines/README.md 規律8）:
 * 「ゲーム画面（タイトル画面含む）は DOM(React) ではなく MD 構文デコード結果として PixiJS 描画
 * すべき」に従い、旧 `TitleOverlay.tsx`（DOM `<img>` + `<button>` 4 つ）を置き換える。
 *
 * `ChoiceOverlay`（選択肢 UI, #146）を実装パターンの土台にし、グリッド配置・スクロール・
 * 既読/未読アイコン等の複雑な機能を省いた「縦一列 4 ボタン固定」の単純版として作る。
 *
 * ロゴ画像自体は自前で `Assets.load` しない。`CharacterLayer.showImage()`（#628 フェーズ2a
 * で実装済みのピクセレート遷移機構を持つ）の呼び出しは `NovelRenderer.showTitleScreen()` が
 * 仲介する（`NovelRenderer` が既に `characterLayer`/`choiceOverlay` 等の複数レイヤーを
 * オーケストレーションしている既存の流儀に揃える）。このクラス自身は次の 3 つだけを担う:
 *   1. 背景の全面塗り（`dark` に応じた配色）
 *   2. ロゴ未読み込み/失敗時のフォールバックとして表示するタイトルテキスト
 *      （読み込み成否は `NovelRenderer` が `CharacterLayer.showImage()` の
 *      `onLoaded`/`onError` コールバックで検知し、`hideFallbackText()` を呼んで隠す）
 *   3. 新規開始 / つづきから / 設定 / 終了 の 4 ボタン
 *
 * アクセシビリティは DOM 実装からの移行に伴い一時後退した。`aria-label` 等の意味論は依然
 * 失われたままだが、キーボード操作経路（#633 フェーズA）は本クラスで復元済み: Tab/Shift+Tab・
 * ArrowUp/ArrowDown でのフォーカス移動（disabled ボタンはスキップ、末尾↔先頭で循環）、
 * Enter/Space でのフォーカス中ボタン実行、`Graphics` 枠線による visible focus 表示を持つ
 * （`handleKeyDown()` 参照）。`pointerover`/`pointerout` によるマウス hover 強調とは独立した
 * 別レイヤーの視覚表現とし、互いに干渉しない。
 * `ChoiceOverlay`（選択肢 UI, #146）のキーボード操作は別フェーズで対応する（#633 未対応）。
 */

import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'

const BUTTON_HEIGHT = 40
const BUTTON_GAP = 12
/** ボタン幅の下限・上限 (px)。screenWidth の半分を基準に、極端な横長/縦長でも読める範囲にクランプする。 */
const BUTTON_MIN_WIDTH = 160
const BUTTON_MAX_WIDTH = 280
const BUTTON_WIDTH_RATIO = 0.5
const BUTTON_RADIUS = 6
const HOVER_SCALE = 1.03

/** ボタン群を収める領域（画面下寄り）の上下端。ロゴ/タイトルテキストの下から画面下端手前まで。 */
const BUTTONS_AREA_TOP_RATIO = 0.42
const BUTTONS_AREA_BOTTOM_RATIO = 0.95

/** タイトルテキスト（ロゴ未読み込み時のフォールバック）の中心 Y。ロゴ画像の中心 Y と揃える
 *  （`NovelRenderer.showTitleScreen` が `characterLayer.showImage` に渡す y と同じ比率）。 */
export const TITLE_LOGO_Y_RATIO = 0.22

const TITLE_TEXT_FONT_SIZE = 32
const BUTTON_FONT_SIZE = 18

/** Tailwind 相当色（旧 DOM 版 TitleOverlay.tsx の indigo-600/500/900/400, gray-700/600/500/200 を踏襲）。 */
const COLOR_PRIMARY_FILL = 0x4f46e5 // indigo-600
const COLOR_PRIMARY_FILL_HOVER = 0x6366f1 // indigo-500
const COLOR_PRIMARY_FILL_DISABLED = 0x312e81 // indigo-900
const COLOR_PRIMARY_TEXT_DISABLED = 0x818cf8 // indigo-400
const COLOR_SECONDARY_FILL = 0x374151 // gray-700
const COLOR_SECONDARY_FILL_HOVER = 0x4b5563 // gray-600
const COLOR_SECONDARY_TEXT_DISABLED = 0x6b7280 // gray-500
const COLOR_TEXT_PRIMARY = 0xffffff
const COLOR_TEXT_SECONDARY = 0xe5e7eb // gray-200
const COLOR_BG_DARK = 0x111827 // gray-900
const COLOR_BG_LIGHT = 0x1e1b4b // indigo-950

/** キーボードフォーカスの visible focus 表示（#633）。マウス hover の hoverFill とは独立した
 *  枠線描画で、「マウス hover とキーボード focus は別概念」であることを視覚的に区別する。 */
const COLOR_FOCUS_RING = 0xfacc15 // yellow-400
const FOCUS_RING_WIDTH = 3
const FOCUS_RING_INSET = 4

type ButtonVariant = 'primary' | 'secondary'

interface ButtonSpec {
  label: string
  onClick: () => void
  variant: ButtonVariant
  disabled: boolean
}

export interface TitleScreenShowOptions {
  /** ロゴ画像が無い/失敗時に表示するタイトル文字列 */
  title: string
  /** 既読データが存在するか（「つづきから」ボタンの有効/無効制御） */
  hasSaveData: boolean
  /** タイトル画面の暗さ。true で #111827（gray-900）、false で #1e1b4b（indigo-950）。
   *  旧 TitleOverlay.tsx の `dark` prop と同じ意味（プレイヤーテーマ）。 */
  dark?: boolean
  onNewGame: () => void
  onContinue: () => void
  onOpenSettings: () => void
  onBack: () => void
}

/** キーボードフォーカス移動対象のボタン1件分。disabled ボタンはナビゲーション対象から除外する（#633）。 */
interface FocusableButtonEntry {
  container: Container
  focusRing: Graphics
  onClick: () => void
  disabled: boolean
}

export class TitleScreenOverlay extends Container {
  private renderResolution = 1
  private titleText: PixiText | null = null
  /** キーボードフォーカス移動用のボタン一覧（show() ごとに作り直す。#633）。 */
  private buttonEntries: FocusableButtonEntry[] = []
  /** buttonEntries 内のフォーカス中インデックス。-1 はフォーカス対象なし（enabled ボタン皆無の異常系）。 */
  private focusedIndex = -1
  private currentButtonWidth = 0

  constructor(
    private screenWidth: number,
    private screenHeight: number
  ) {
    super()
    this.eventMode = 'static'
    this.visible = false
  }

  /**
   * Pixi Text は既定 resolution=1 で canvas 化されるため、DPR 描画時にボタン文字/タイトル文字が
   * 低解像度に見える。ChoiceOverlay.setRenderResolution と同じ狙い。
   */
  setRenderResolution(resolution: number): void {
    if (!(resolution > 0) || !Number.isFinite(resolution)) return
    this.renderResolution = resolution
  }

  show(opts: TitleScreenShowOptions): void {
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.titleText = null
    this.buttonEntries = []
    this.focusedIndex = -1

    const dark = opts.dark ?? false
    const bg = new Graphics()
    bg.rect(0, 0, this.screenWidth, this.screenHeight)
    bg.fill(dark ? COLOR_BG_DARK : COLOR_BG_LIGHT)
    this.addChild(bg)

    // フォールバックタイトルテキスト。ロゴ画像 (`CharacterLayer.showImage()`) の読み込み成否は
    // このクラスの管轄外（NovelRenderer が onLoaded/onError で hideFallbackText を呼ぶ）ため、
    // 常に描画しておき、読み込み成功時だけ後から隠す（旧 DOM 版の「画像 or テキスト」を
    // 「テキストを先に出し、画像ロード成功で隠す」という到達順序の違いだけの等価な表現）。
    const titleStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: TITLE_TEXT_FONT_SIZE,
      fill: COLOR_TEXT_PRIMARY,
      fontWeight: 'bold',
    })
    const titleText = new PixiText({
      text: opts.title,
      style: titleStyle,
      resolution: this.renderResolution,
      roundPixels: true,
    })
    titleText.anchor.set(0.5, 0.5)
    titleText.x = this.screenWidth / 2
    titleText.y = this.screenHeight * TITLE_LOGO_Y_RATIO
    this.addChild(titleText)
    this.titleText = titleText

    const buttonSpecs: ButtonSpec[] = [
      { label: '新規開始', onClick: opts.onNewGame, variant: 'primary', disabled: false },
      {
        label: 'つづきから',
        onClick: opts.onContinue,
        variant: 'primary',
        disabled: !opts.hasSaveData,
      },
      { label: '設定', onClick: opts.onOpenSettings, variant: 'secondary', disabled: false },
      { label: '終了', onClick: opts.onBack, variant: 'secondary', disabled: false },
    ]

    const buttonWidth = Math.max(
      BUTTON_MIN_WIDTH,
      Math.min(BUTTON_MAX_WIDTH, this.screenWidth * BUTTON_WIDTH_RATIO)
    )
    this.currentButtonWidth = buttonWidth
    const totalButtonsHeight =
      buttonSpecs.length * BUTTON_HEIGHT + (buttonSpecs.length - 1) * BUTTON_GAP
    const areaTop = this.screenHeight * BUTTONS_AREA_TOP_RATIO
    const areaBottom = this.screenHeight * BUTTONS_AREA_BOTTOM_RATIO
    const areaHeight = Math.max(0, areaBottom - areaTop)
    const startY = areaTop + Math.max(0, (areaHeight - totalButtonsHeight) / 2)

    buttonSpecs.forEach((spec, i) => {
      const container = new Container()
      container.eventMode = spec.disabled ? 'none' : 'static'
      container.cursor = spec.disabled ? 'default' : 'pointer'
      container.pivot.set(buttonWidth / 2, BUTTON_HEIGHT / 2)
      container.x = this.screenWidth / 2
      container.y = startY + i * (BUTTON_HEIGHT + BUTTON_GAP) + BUTTON_HEIGHT / 2

      const normalFill = this.resolveFill(spec.variant, spec.disabled, false)
      const hoverFill = this.resolveFill(spec.variant, spec.disabled, true)
      const textColor = this.resolveTextColor(spec.variant, spec.disabled)

      const bgGraphics = new Graphics()
      this.drawButtonBackground(bgGraphics, buttonWidth, normalFill)
      container.addChild(bgGraphics)

      const label = new PixiText({
        text: spec.label,
        style: new TextStyle({
          fontFamily: "'Noto Sans JP', sans-serif",
          fontSize: BUTTON_FONT_SIZE,
          fill: textColor,
          fontWeight: 'bold',
        }),
        resolution: this.renderResolution,
        roundPixels: true,
      })
      label.anchor.set(0.5, 0.5)
      label.x = buttonWidth / 2
      label.y = BUTTON_HEIGHT / 2
      container.addChild(label)

      // キーボード focus 表示専用の枠線レイヤー（#633）。label より上に重ねるが、外周の
      // stroke のみでラベル文字は隠さない。マウス hover の hoverFill 切り替え（下記）とは
      // 完全に独立した仕組みで、show() 直後は未描画（clear() 済み = 何も見えない）。
      const focusRing = new Graphics()
      container.addChild(focusRing)

      if (!spec.disabled) {
        container.on('pointerover', () => {
          bgGraphics.clear()
          this.drawButtonBackground(bgGraphics, buttonWidth, hoverFill)
          container.scale.set(HOVER_SCALE)
        })
        container.on('pointerout', () => {
          bgGraphics.clear()
          this.drawButtonBackground(bgGraphics, buttonWidth, normalFill)
          container.scale.set(1)
        })
        container.on('pointertap', () => {
          spec.onClick()
        })
      }

      this.buttonEntries.push({
        container,
        focusRing,
        onClick: spec.onClick,
        disabled: spec.disabled,
      })

      this.addChild(container)
    })

    // 有効な最初のボタン（通常は0=新規開始）へフォーカスをリセットする（#633）。
    // focusedIndex を一旦 -1 に固定してから setFocusedIndex() を呼ぶことで、buttonEntries が
    // 総入れ替えされた（Graphics インスタンスが変わった）にもかかわらず「インデックス値が
    // たまたま前回と同じだから」という理由で早期 return され新しい focusRing に描画し損ねる
    // 事故を避ける。
    this.focusedIndex = -1
    const firstEnabledIndex = this.buttonEntries.findIndex((b) => !b.disabled)
    this.setFocusedIndex(firstEnabledIndex)

    this.visible = true
    this.alpha = 1
  }

  /**
   * TitleScreenOverlay 表示中のキーボード操作（#633）。呼び出し元（NovelRenderer.handleKeyDown）が
   * titleScreenOverlay.visible === true の間、window keydown を丸ごとここへ委譲する。
   * 戻り値 true = このキー入力を処理済み（呼び出し元はゲーム内ショートカットを一切発火させない）。
   */
  handleKeyDown(key: string, shiftKey = false): boolean {
    switch (key) {
      case 'Tab':
        this.moveFocus(shiftKey ? -1 : 1)
        return true
      case 'ArrowDown':
        this.moveFocus(1)
        return true
      case 'ArrowUp':
        this.moveFocus(-1)
        return true
      case 'Enter':
      case ' ':
        this.activateFocusedButton()
        return true
      default:
        return false
    }
  }

  private activateFocusedButton(): void {
    const entry = this.buttonEntries[this.focusedIndex]
    if (entry && !entry.disabled) entry.onClick()
  }

  /** disabled ボタンをスキップしつつ、末尾↔先頭で循環してフォーカスを1つ移動する。 */
  private moveFocus(direction: 1 | -1): void {
    const enabledIndices = this.buttonEntries.reduce<number[]>((acc, entry, i) => {
      if (!entry.disabled) acc.push(i)
      return acc
    }, [])
    if (enabledIndices.length === 0) return

    const currentPos = enabledIndices.indexOf(this.focusedIndex)
    const basePos = currentPos === -1 ? 0 : currentPos
    const nextPos = (basePos + direction + enabledIndices.length) % enabledIndices.length
    this.setFocusedIndex(enabledIndices[nextPos])
  }

  private setFocusedIndex(index: number): void {
    if (index === this.focusedIndex) return
    const prev = this.buttonEntries[this.focusedIndex]
    if (prev) prev.focusRing.clear()
    this.focusedIndex = index
    const next = this.buttonEntries[this.focusedIndex]
    if (next) this.drawFocusRing(next.focusRing)
  }

  private drawFocusRing(g: Graphics): void {
    g.clear()
    g.roundRect(
      -FOCUS_RING_INSET,
      -FOCUS_RING_INSET,
      this.currentButtonWidth + FOCUS_RING_INSET * 2,
      BUTTON_HEIGHT + FOCUS_RING_INSET * 2,
      BUTTON_RADIUS + FOCUS_RING_INSET
    )
    g.stroke({ color: COLOR_FOCUS_RING, width: FOCUS_RING_WIDTH })
  }

  /**
   * ロゴ画像 (`CharacterLayer.showImage()` 経由) の読み込みに成功した通知を受け、
   * フォールバックのタイトルテキストを隠す。`NovelRenderer.showTitleScreen()` の
   * `onLoaded` コールバックから呼ばれる想定。
   */
  hideFallbackText(): void {
    if (this.titleText) this.titleText.visible = false
  }

  hide(): void {
    this.visible = false
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.titleText = null
    this.buttonEntries = []
    this.focusedIndex = -1
  }

  private drawButtonBackground(g: Graphics, width: number, fillColor: number): void {
    g.roundRect(0, 0, width, BUTTON_HEIGHT, BUTTON_RADIUS)
    g.fill(fillColor)
  }

  private resolveFill(variant: ButtonVariant, disabled: boolean, hover: boolean): number {
    if (disabled) {
      return variant === 'primary' ? COLOR_PRIMARY_FILL_DISABLED : COLOR_SECONDARY_FILL
    }
    if (variant === 'primary') {
      return hover ? COLOR_PRIMARY_FILL_HOVER : COLOR_PRIMARY_FILL
    }
    return hover ? COLOR_SECONDARY_FILL_HOVER : COLOR_SECONDARY_FILL
  }

  private resolveTextColor(variant: ButtonVariant, disabled: boolean): number {
    if (disabled) {
      return variant === 'primary' ? COLOR_PRIMARY_TEXT_DISABLED : COLOR_SECONDARY_TEXT_DISABLED
    }
    return variant === 'primary' ? COLOR_TEXT_PRIMARY : COLOR_TEXT_SECONDARY
  }
}
