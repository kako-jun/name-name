/**
 * テロップレイヤー (#674)。
 *
 * 汎用ディレクティブ `[テロップ: 本文, 位置=右下, 秒=4, 種別=しおり]` から駆動される、画面隅に
 * 短文を数秒表示して消える演出。エンジンは `text`/`kind` の中身を解釈しない（用途は作品側が決める）。
 * `EventImageLayer`/`ToastOverlay` と同じ「薄いラッパー」方針: このクラスは「いつ表示するか」
 * （復元中・スキップ中は表示しない等）を判断せず、`NovelRenderer.show()` 呼び出しに対して
 * スライドイン→保持→フェードアウトを描画するだけ。
 *
 * 演出: 指定位置へ横からスライドイン（既定 `TELOP_SLIDE_IN_MS`、`easing.ts` の `easeOut`）
 * → `seconds` 秒保持 → フェードアウト（`TELOP_FADE_OUT_MS`、線形。EventImageLayer の
 * `computeFadeAlpha` と同じ流儀）→ 破棄。**非同期**（呼び出し元の reveal/クリック待ちを一切
 * ブロックしない、内部で完結する）。
 *
 * 複数出現時は縦に積む（`novelLayout.ts` の `computeTelopGeometry` の `stackIndex`）。
 * 「新しいものが下」の意味論は `relayout()` が position ごとに解決する: 下端アンカー
 * （BottomLeft/BottomRight）は新しいものほど辺に近い段（index 0）、上端アンカー（TopLeft/TopRight）
 * は古いものほど辺に近い段（index 0）——どちらも新しいものが視覚的な「下」に来る。
 * 同時最大 `TELOP_MAX_STACK` 段、超過は古いものから即破棄（フェードなし）。
 *
 * アニメーション位相（スライドイン/保持/フェードアウトのどの段階か）は settled state を持たない
 * 一時状態としてこのクラスだけが保持する（ADR-0002 / dev-doctrine 規律1）。タイマーは
 * `EventImageLayer.fadeAnimation` と同じ `TimeController`（`this.time.setInterval`, 16ms 間隔）駆動。
 *
 * 下端アンカー（BottomLeft/BottomRight）は画面下部の丸ボタン行（DOM 固定 CSS px）に重ならないよう
 * `buttonRowHeightPx`（既定 `PLAYER_BUTTON_ROW_HEIGHT_PX`）ぶん余分にマージンを取る (#677)。
 * `setButtonRowHeightPx` で表示倍率補正後の値に更新できる（`SeekBar.setVerticalCenter` と同じ流儀）。
 *
 * 本文は `wordWrap: true` + `breakWords: true`（日本語は空白が無く breakWords 必須）で
 * `computeTelopMaxWidth(screenWidth)` から左右余白・アクセント縦線幅を差し引いた
 * `wordWrapWidth` に折り返す (#679)。帯の高さは実測 `text.height`（複数行なら行数ぶん高くなる）
 * から求め、スタック（同一 position の段積み）は各段の実測高さを累積して積む
 * （固定高さ1行分の前提を置かない）。
 */
import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'
import type { TelopPosition } from '../types'
import {
  computeTelopGeometry,
  computeTelopMaxWidth,
  PLAYER_BUTTON_ROW_HEIGHT_PX,
  TELOP_ACCENT_WIDTH_PX,
  TELOP_FADE_OUT_MS,
  TELOP_FONT_SCALE,
  TELOP_LINE_HEIGHT_RATIO,
  TELOP_MAX_STACK,
  TELOP_PADDING_X_PX,
  TELOP_SLIDE_IN_MS,
  TELOP_STACK_GAP_PX,
} from './novelLayout'
import { computeFadeAlpha, effectProgress } from './screenEffects'
import { easeOut } from './easing'
import { TimeController, defaultTimeController } from './TimeController'

/** テロップ下地の角丸半径 (px)。 */
const TELOP_BG_RADIUS = 8
/** テロップ下地の色（黒・半透明）。 */
const TELOP_BG_COLOR = 0x000000
const TELOP_BG_ALPHA = 0.6
/** テロップ本文の文字色。 */
const TELOP_TEXT_COLOR = 0xffffff

export interface TelopShowOptions {
  text: string
  position: TelopPosition
  /** [1, 30] にクランプ済みの表示秒数（parser 側で解決済み）。 */
  seconds: number
  /** 任意の識別子。エンジンは意味を解釈せず保持のみ（当面見た目は共通）。 */
  kind?: string | null
  fontFamily: string
  /** 本文 font_size（px）。実際のテロップ文字サイズはこの `TELOP_FONT_SCALE` 倍。 */
  fontSize: number
  /** アクセント縦線の色。`NovelRenderer` が `seekbar_color` と同じ色解決で渡す。 */
  accentColor: number
}

interface TelopEntry {
  id: number
  position: TelopPosition
  kind: string | null
  fontSize: number
  accentColor: number
  textWidth: number
  /** 実測の本文高さ (px)。折り返して複数行になると増える (#679)。 */
  textHeight: number
  container: Container
  bg: Graphics
  accent: Graphics
  textObj: PixiText
  width: number
  height: number
  targetX: number
  targetY: number
  slideFromX: number
  /** 'in' フェーズの Y 補間の起点。show() 時点の初期 targetY で確定し、以後は変えない
   *  （X の slideFromX と同じ扱い。#674 セルフレビュー S3）。 */
  slideFromY: number
  phase: 'in' | 'hold' | 'out'
  phaseStartedAtMs: number
  interval: number | null
  holdTimer: number | null
}

export class TelopLayer extends Container {
  private entries: TelopEntry[] = []
  private nextId = 1
  private screenWidth: number
  private screenHeight: number
  /**
   * 下端アンカー（BottomLeft/BottomRight）の下部丸ボタン行ぶんの論理座標マージン (#677)。
   * 既定は表示倍率 1:1 の `PLAYER_BUTTON_ROW_HEIGHT_PX`。`NovelRenderer.syncTelopBottomMarginToButtons`
   * が `canvas.clientHeight` から求めた実倍率で割った値を `setButtonRowHeightPx` 経由で渡す
   * （`SeekBar.setVerticalCenter` と同じ流儀、#350）。
   */
  private buttonRowHeightPx = PLAYER_BUTTON_ROW_HEIGHT_PX

  constructor(
    screenWidth: number,
    screenHeight: number,
    private time: TimeController = defaultTimeController
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    // 旧 ToastOverlay と同じくクリックしても何も起きない（誤タップで本文が進むのを防ぐ、#674 仕様）。
    this.eventMode = 'none'
  }

  /**
   * 下部丸ボタン行の論理座標マージンを更新し、既存段を含めて即座に再配置する (#677)。
   * `NovelRenderer` が表示倍率の変化（resize/回転）を検知するたびに呼ぶ想定。
   * `canvas.clientHeight` のサブピクセル揺れ（レイアウト計算の丸め誤差等）で無意味な
   * relayout が頻発しないよう、差が 0.5px 未満なら no-op とする（#678）。
   */
  setButtonRowHeightPx(px: number): void {
    if (Math.abs(px - this.buttonRowHeightPx) < 0.5) return
    this.buttonRowHeightPx = px
    this.relayout()
  }

  /**
   * 画面リサイズ時に全段の幾何を再計算する。
   *
   * 本番の `NovelRenderer` からは呼ばれない（論理 screenWidth/Height はコンストラクタで固定・
   * `aspect_ratio: auto` の fluid モードは画面回転のたびに `NovelRenderer` ごと再マウントする
   * ため、既存インスタンスへの実行時リサイズは発生しない）。将来の実行時リサイズ対応と
   * 単体テスト（#674 セルフレビュー S2）のための API として残す。
   */
  resize(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.relayout()
  }

  /** 1段追加する。既存の段を押し出さず、position ごとに独立して積む。 */
  show(options: TelopShowOptions): void {
    const { text, position, seconds, kind, fontFamily, fontSize, accentColor } = options

    const wordWrapWidth = this.computeWordWrapWidth()
    const textObj = new PixiText({
      text,
      style: new TextStyle({
        fontFamily,
        fontSize: fontSize * TELOP_FONT_SCALE,
        fill: TELOP_TEXT_COLOR,
        wordWrap: true,
        wordWrapWidth,
        breakWords: true,
      }),
    })
    textObj.anchor.set(0, 0.5)

    const bg = new Graphics()
    const accent = new Graphics()
    const container = new Container()
    container.addChild(bg)
    container.addChild(accent)
    container.addChild(textObj)

    const entry: TelopEntry = {
      id: this.nextId++,
      position,
      kind: kind ?? null,
      fontSize,
      accentColor,
      textWidth: this.measureTextWidth(textObj, fontSize, wordWrapWidth),
      textHeight: this.measureTextHeight(textObj, fontSize, wordWrapWidth),
      container,
      bg,
      accent,
      textObj,
      width: 0,
      height: 0,
      targetX: 0,
      targetY: 0,
      slideFromX: 0,
      slideFromY: 0,
      phase: 'in',
      phaseStartedAtMs: this.time.now(),
      interval: null,
      holdTimer: null,
    }

    this.entries.push(entry)
    this.addChild(container)
    this.evictOverflow(position)
    this.relayout()
    // Y 補間の起点を確定する（この時点の targetY = 初期の定位置。以後の relayout で
    // stackIndex がずれても slideFromY 自体は変えない。X の slideFromX と同じ扱い、#674 S3）。
    entry.slideFromY = entry.targetY

    // relayout() が確定させた slideFromX/slideFromY から、画面外→定位置へスライドインを開始する。
    container.x = entry.slideFromX
    container.y = entry.slideFromY
    container.alpha = 1
    entry.phaseStartedAtMs = this.time.now()
    entry.interval = this.time.setInterval(() => this.updateFrame(entry), 16)

    entry.holdTimer = this.time.setTimeout(
      () => {
        entry.holdTimer = null
        this.startFadeOut(entry)
      },
      TELOP_SLIDE_IN_MS + seconds * 1000
    )
  }

  /** 全段を即座に消去する（復元・シーン切替時）。フェードなし。 */
  clear(): void {
    for (const entry of this.entries) {
      this.stopInterval(entry)
      if (entry.holdTimer != null) {
        this.time.clearTimeout(entry.holdTimer)
        entry.holdTimer = null
      }
      this.removeChild(entry.container)
      entry.container.destroy({ children: true })
    }
    this.entries = []
  }

  /**
   * アクセント縦線色を変更し、表示中の全段の縦線を新色で描き直す (#674 セルフレビュー Q1)。
   * `NovelRenderer.setSeekBarColor()` が SeekBar と同じ色解決で呼ぶ。以後 `show()` する新規の
   * 段にも引き続き使われるよう、次に渡される `TelopShowOptions.accentColor` の解決元
   * （`NovelRenderer` 側）もこの色を反映する前提——このメソッド自体は「今表示中の段」の
   * 見た目だけを即時更新する。
   */
  setAccentColor(color: number): void {
    for (const entry of this.entries) {
      entry.accentColor = color
      this.redrawEntryBackground(entry)
    }
  }

  /**
   * `wordWrapWidth`（左右余白・アクセント縦線幅を差し引いた本文の折り返し幅）を算出する (#679)。
   * `computeTelopMaxWidth(screenWidth)` が帯全体の最大幅、そこから `TelopLayer` 自身が持つ
   * 左右余白 (`TELOP_PADDING_X_PX`×2) とアクセント縦線幅 (`TELOP_ACCENT_WIDTH_PX`) を引く。
   */
  private computeWordWrapWidth(): number {
    return computeTelopMaxWidth(this.screenWidth) - TELOP_PADDING_X_PX * 2 - TELOP_ACCENT_WIDTH_PX
  }

  /**
   * `.width` は canvas 2D context が使えない環境（jsdom のユニットテスト等）で例外を投げることが
   * ある（`ToastOverlay.measureTextSize` / `CharacterLayer.measureGlyphWidth` と同じ既知の防御）。
   * その場合は `文字数 × fontSize×TELOP_FONT_SCALE×0.95` の近似幅を、`wordWrapWidth` で
   * クランプして返す（折り返しが起きる本文は最長行が概ね `wordWrapWidth` 一杯になる想定、#679）。
   */
  private measureTextWidth(textObj: PixiText, fontSize: number, wordWrapWidth: number): number {
    try {
      return textObj.width
    } catch {
      const approxCharWidth = fontSize * TELOP_FONT_SCALE * 0.95
      const naturalWidth = textObj.text.length * approxCharWidth
      return Math.min(naturalWidth, wordWrapWidth)
    }
  }

  /**
   * `.height` も `.width` と同じ理由（jsdom に canvas 2D context が無い）で例外を投げることが
   * ある。その場合は近似の1行幅から折り返し後の概算行数を出し、1行の高さ
   * （`computeTelopBandHeight` と同じ式）に掛けてフォールバックする (#679)。
   */
  private measureTextHeight(textObj: PixiText, fontSize: number, wordWrapWidth: number): number {
    try {
      return textObj.height
    } catch {
      const approxCharWidth = fontSize * TELOP_FONT_SCALE * 0.95
      const naturalWidth = textObj.text.length * approxCharWidth
      const lineHeight = fontSize * TELOP_FONT_SCALE * TELOP_LINE_HEIGHT_RATIO
      const lines = Math.max(1, Math.ceil(naturalWidth / wordWrapWidth))
      return lines * lineHeight
    }
  }

  private evictOverflow(position: TelopPosition): void {
    const group = this.entries.filter((e) => e.position === position)
    const overflowCount = group.length - TELOP_MAX_STACK
    if (overflowCount <= 0) return

    // 最古（配列先頭側）から overflowCount 件をまとめて破棄し、除去は1回の filter で行う
    // （#674 セルフレビュー N-2。挙動は従来のループ版と同一）。
    const toEvict = group.slice(0, overflowCount)
    for (const oldest of toEvict) {
      this.stopInterval(oldest)
      if (oldest.holdTimer != null) {
        this.time.clearTimeout(oldest.holdTimer)
      }
      this.removeChild(oldest.container)
      oldest.container.destroy({ children: true })
    }
    const evictIds = new Set(toEvict.map((e) => e.id))
    this.entries = this.entries.filter((e) => !evictIds.has(e.id))
  }

  /**
   * position ごとに段（アンカー辺からの累積オフセット）を割り当てて幾何を再計算する。
   * 「新しいものが下」の意味論（どちらの辺アンカーでも新しいものが視覚的な下に来る）は、
   * 下端アンカーだけ配列を逆順にして解決する（クラス doc 冒頭参照）。
   *
   * 各段のオフセットは「これより手前（アンカー辺に近い側）の全段の実測 `height + GAP` の
   * 累積」で求める (#679)。`computeTelopGeometry` 自体は前段の高さを知らない純粋関数なので、
   * ここ（呼び出し側）で `stackOffsetPx` を順に積み上げてから渡す——折り返しで各段の高さが
   * バラバラでも、固定の等間隔ではなく実測高さどおりに積む。
   *
   * `resize()` で `screenWidth` が変わり `wordWrapWidth` が変化した場合、既存段の折り返しも
   * 追従させるため `textObj.style.wordWrapWidth` を更新し textWidth/textHeight を再測定する
   * (#679)。変化がない通常の relayout（show/evict/setAccentColor 等）では無駄な再測定をしない。
   */
  private relayout(): void {
    const wordWrapWidth = this.computeWordWrapWidth()
    const positions: TelopPosition[] = ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']
    for (const position of positions) {
      const group = this.entries.filter((e) => e.position === position)
      const isBottom = position === 'BottomLeft' || position === 'BottomRight'
      const ordered = isBottom ? [...group].reverse() : group
      let stackOffsetPx = 0
      ordered.forEach((entry) => {
        if (entry.textObj.style.wordWrapWidth !== wordWrapWidth) {
          entry.textObj.style.wordWrapWidth = wordWrapWidth
          entry.textWidth = this.measureTextWidth(entry.textObj, entry.fontSize, wordWrapWidth)
          entry.textHeight = this.measureTextHeight(entry.textObj, entry.fontSize, wordWrapWidth)
        }
        const geometry = computeTelopGeometry({
          screenWidth: this.screenWidth,
          screenHeight: this.screenHeight,
          position,
          stackOffsetPx,
          textWidth: entry.textWidth,
          textHeight: entry.textHeight,
          buttonRowHeightPx: this.buttonRowHeightPx,
        })
        entry.targetX = geometry.x
        entry.targetY = geometry.y
        entry.slideFromX = geometry.slideFromX
        entry.width = geometry.width
        entry.height = geometry.height
        this.redrawEntryBackground(entry)
        // スライドイン中は定位置ではなくアニメーション補間に任せる（updateFrame が毎フレーム
        // container.x/y を書き換える。X は slideFromX、Y は slideFromY を起点に targetX/Y へ
        // 補間する、#674 S3）。保持/フェードアウト中の段は resize/積み直しで即座に
        // 新しい定位置へスナップする（reflow アニメーションは持たない、#674 スコープ外）。
        if (entry.phase !== 'in') {
          entry.container.x = entry.targetX
          entry.container.y = entry.targetY
        }
        stackOffsetPx += geometry.height + TELOP_STACK_GAP_PX
      })
    }
  }

  /** 下地（角丸半透明黒）とアクセント縦線（左端）を、現在の width/height で引き直す。 */
  private redrawEntryBackground(entry: TelopEntry): void {
    entry.bg.clear()
    entry.bg.roundRect(0, 0, entry.width, entry.height, TELOP_BG_RADIUS)
    entry.bg.fill({ color: TELOP_BG_COLOR, alpha: TELOP_BG_ALPHA })

    entry.accent.clear()
    entry.accent.rect(0, 0, TELOP_ACCENT_WIDTH_PX, entry.height)
    entry.accent.fill(entry.accentColor)

    entry.textObj.x = TELOP_ACCENT_WIDTH_PX + TELOP_PADDING_X_PX
    entry.textObj.y = entry.height / 2
  }

  private startFadeOut(entry: TelopEntry): void {
    entry.phase = 'out'
    entry.phaseStartedAtMs = this.time.now()
    if (entry.interval == null) {
      entry.interval = this.time.setInterval(() => this.updateFrame(entry), 16)
    }
  }

  private updateFrame(entry: TelopEntry): void {
    if (entry.phase === 'in') {
      const elapsed = this.time.now() - entry.phaseStartedAtMs
      const t = easeOut(effectProgress(elapsed, TELOP_SLIDE_IN_MS))
      entry.container.x = entry.slideFromX + (entry.targetX - entry.slideFromX) * t
      // Y も X と同じ扱いで補間する（#674 S3）: 積み直しで stackIndex がずれて targetY が
      // 変わっても、slideFromY（show() 時点で確定した初期定位置）から現在の targetY へ
      // 毎フレーム補間し、瞬間移動しない。
      entry.container.y = entry.slideFromY + (entry.targetY - entry.slideFromY) * t
      if (elapsed >= TELOP_SLIDE_IN_MS) {
        entry.container.x = entry.targetX
        entry.container.y = entry.targetY
        entry.phase = 'hold'
        this.stopInterval(entry)
      }
      return
    }
    if (entry.phase === 'out') {
      const elapsed = this.time.now() - entry.phaseStartedAtMs
      const { alpha, done } = computeFadeAlpha(elapsed, 1, 0, TELOP_FADE_OUT_MS)
      entry.container.alpha = alpha
      if (done) {
        this.destroyEntry(entry)
      }
    }
  }

  private destroyEntry(entry: TelopEntry): void {
    this.stopInterval(entry)
    if (entry.holdTimer != null) {
      this.time.clearTimeout(entry.holdTimer)
      entry.holdTimer = null
    }
    this.entries = this.entries.filter((e) => e.id !== entry.id)
    this.removeChild(entry.container)
    entry.container.destroy({ children: true })
    this.relayout()
  }

  private stopInterval(entry: TelopEntry): void {
    if (entry.interval != null) {
      this.time.clearInterval(entry.interval)
      entry.interval = null
    }
  }
}
