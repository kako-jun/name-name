/**
 * 立ち絵表示レイヤー
 *
 * PixiJS Container 上でキャラクター立ち絵の表示・表情変更・退場を管理する。
 */

import { Assets, Container, Graphics, Sprite, Text, TextStyle, Ticker } from 'pixi.js'
import type { Easing } from '../types'
import { applyEasing, resolveDelta } from './easing'
import { ensureFontLoaded } from './FontLoader'
import { TimeController, defaultTimeController } from './TimeController'
import {
  computeGlyphTransform,
  cursorVisible,
  isRevealEffect,
  layoutGlyphCenters,
  resolveCursor,
  resolveTransformEffect,
  resolveTypewriterMsPerChar,
  textEffectTotalDurationMs,
  type ResolvedCursor,
  type ResolvedTransformEffect,
  type TextEffectParams,
} from './textEffect'
import {
  layoutUnderline,
  parseColorToNumber,
  resolveUnderline,
  underlineScaleX,
  type ResolvedUnderline,
  type UnderlineParams,
} from './underline'
import { startTypewriter, tickTypewriter, type TypewriterState } from './typewriter'

/** キャラクターの画面上の配置位置（screenWidth に対する比率） */
const CHARACTER_X_RATIO: Record<string, number> = {
  left: 150 / 800, // 0.1875
  center: 400 / 800, // 0.5
  right: 650 / 800, // 0.8125
  // オフスクリーン位置（スクロールイン/アウトの初期/終了位置として使う）
  // スプライト中心の x。画像の半幅 (~400 logical) を考えると 1.5 にしないと右端が見える
  off_left: -400 / 800, // -0.5, 画像中心が画面左 0.5 分外
  off_right: 1200 / 800, // 1.5, 画像中心が画面右 0.5 分外
}

/**
 * 日本語表記の position を英語 key に正規化する。
 * パーサーは "中央" 等の日本語表記をそのまま position 文字列に流すため、
 * CharacterLayer 側で受ける必要がある (#133)。
 *
 * サポートする表記:
 *   - 英語: left / center / right
 *   - 英語ゆれ (case / 綴り): Left / Center / Centre / Right
 *   - 日本語 (左): 左 / 左寄り / 左端
 *   - 日本語 (中央): 中央 / 真ん中 / まんなか / 真中 / 中
 *   - 日本語 (右): 右 / 右寄り / 右端
 *
 * 未知の値が来たら CharacterLayer 側で center にフォールバックする。
 */
const POSITION_ALIASES_JA: Record<string, string> = {
  左: 'left',
  左寄り: 'left',
  左端: 'left',
  中央: 'center',
  真ん中: 'center',
  まんなか: 'center',
  真中: 'center',
  中: 'center',
  右: 'right',
  右寄り: 'right',
  右端: 'right',
  // オフスクリーン（スクロールイン/アウトの起点・終点）
  右外: 'off_right',
  画面外右: 'off_right',
  オフ右: 'off_right',
  左外: 'off_left',
  画面外左: 'off_left',
  オフ左: 'off_left',
}

const POSITION_ALIASES_EN: Record<string, string> = {
  Left: 'left',
  Center: 'center',
  Centre: 'center',
  Right: 'right',
}

export function normalizePosition(position: string): string {
  // 空文字 / null 相当は早期に center に倒す (review #152 nit)
  if (!position) return 'center'
  return POSITION_ALIASES_JA[position] ?? POSITION_ALIASES_EN[position] ?? position
}

/** 足元 Y 座標の比率（`characterY = screenHeight * CHARACTER_Y_RATIO`）。
 *  以前は 380/450 ≒ 0.844 (DialogBox の上端あたり) だったが、
 *  枠なし・教育動画モードでは立ち絵の下端を画面下端まで下げたほうが座りが良い。
 *  影響範囲: 全 game の立ち絵が画面下端まで下がる。既存 game が枠ありで足元位置を
 *  そのままにしたい場合は別途オプション化が要る。
 *  テストが期待値を直書きして陳腐化するのを防ぐため export する（#262）。 */
export const CHARACTER_Y_RATIO = 1.0

interface CharacterState {
  sprite: Sprite
  /** 立ち絵の上に表示する名前ラベル（off_right/off_left で登場したとき自動付与）。
   *  sprite と同じ x で追従する。退場時に一緒に destroy する。 */
  label?: Text
  position: string
  expression: string
  /** 進行中アニメーション。null なら静的 */
  animation: ActiveAnimation | null
  /** フェードイン/アウトアニメーション。退場時は完了後に sprite を destroy する */
  fadeAnimation: FadeAnimation | null
  /** グリフ単位の文字演出 (#268)。null なら適用なし（タイトルは単一 label 表示）。 */
  textEffect: TextEffectAnimation | null
  /** 下線ビーム (#270)。null なら適用なし。sprite の子として線を持つ。 */
  underline: UnderlineAnimation | null
  /** 2コマ自動切替 (expression が `*-a` なら `*-b` と 1 秒ごとに交互)。
   *  remove() / clear() で interval を必ずクリアする。TimeController 経由なので number。 */
  idleIntervalId?: number
  /** show() 時の assetBaseUrl。アニメ開始時に idle cycle を仕掛けるとき再利用する */
  assetBaseUrl: string
}

interface FadeAnimation {
  startMs: number
  durationMs: number
  fromAlpha: number
  toAlpha: number
  /** true なら 0 に到達した時点で sprite を破棄して characters Map から消す */
  destroyOnComplete: boolean
}

/**
 * 立ち絵のフェードイン/アウトのデフォルト時間 (ms)。
 * 仕様書 docs/spec/markdown-v0.1.md と数値を揃えて変更する。
 */
const DEFAULT_FADE_MS = 300

export interface AnimateParams {
  /** "+500" / "-200" / "400" / undefined */
  dx?: string
  dy?: string
  /** 度数 (degree)。"+360" / "180" / undefined */
  rotation?: string
  /** 1.0 = 等倍。undefined で変更なし */
  scale?: number
  duration_ms: number
  easing?: Easing
}

interface ActiveAnimation {
  startMs: number
  durationMs: number
  easing: Easing
  // 開始時点のスナップショット
  fromX: number
  fromY: number
  fromRotation: number
  fromScale: number
  // 終端値 (resolveDelta 適用後)
  toX: number
  toY: number
  toRotation: number
  toScale: number
}

/**
 * グリフ単位の文字演出の進行状態 (#268)。
 *
 * タイトル label を 1 文字ずつ Text に分解して container に並べ、ticker で
 * 各グリフの transform/alpha を毎フレーム純粋計算（textEffect.ts）して適用する。
 * 効果完了後も container を保持し、後続 `[アニメ target=Title]` が sprite を動かすと
 * container が追従する（container は sprite の子）。
 *
 * 中間状態は持たない（ADR 0002）: 進行は startMs からの経過 ms で都度計算する。
 * 復元時は applyTextEffectResting で「効果完了済み = 全グリフ整列」状態にする。
 */
interface TextEffectAnimation {
  /** sprite の子として並ぶグリフ Text 群を束ねる container。整列レイアウト済み。 */
  container: Container
  /**
   * 1 文字ごとのグリフと、その整列位置（restX/restY）を明示保持する。
   * 毎フレームの補間オフセットは restX/restY を基準に足し込む（モンキーパッチ排除 #268）。
   */
  glyphs: Array<{ glyph: Text; restX: number; restY: number }>
  /** transform 系（爆発等）の解決済みパラメータ。reveal 系では null。 */
  transform: ResolvedTransformEffect | null
  /** reveal 系（タイプ）の typewriter 状態。transform 系では null。 */
  typewriter: TypewriterState | null
  /** reveal の 1 文字あたり ms（typewriter 駆動用）。 */
  msPerChar: number
  /** 効果開始時刻（elapsedMs 基準）。transform 進行の起点。 */
  startMs: number
  /** 効果全体の所要 ms（最後のグリフが整列し終わるまで）。ticker 停止判定用。 */
  totalMs: number
  /** 整列確定（settleTextEffect）済みか。完了後に毎フレーム再 settle しないためのラッチ。 */
  settled: boolean
  /** 点滅カーソル (#271)。null ならカーソルなし。reveal 系（タイプ）かつ cursor=on のときだけ持つ。
   *  settle 後もカーソルだけは点滅し続ける（render-only の小例外）。 */
  cursor: CursorState | null
}

/**
 * タイプ末尾の点滅カーソル状態 (#271)。
 *
 * reveal head（表示済み末尾グリフの右端）に縦矩形 Graphics を置き、`cursorVisible` の
 * 純関数で点滅させる。タイプ完了後も末尾位置に固定して点滅し続ける（closing.html 忠実）。
 * ADR0002: 点滅位相は render-only でセーブ対象外。位置はタイプ完了位置に固定。
 * skip(instant) 時はカーソルなしの静止全表示に畳む（gfx を非表示にする）。
 */
interface CursorState {
  /** カーソル本体の縦矩形 Graphics（container の子）。 */
  gfx: Graphics
  /** 点滅周期 (ms)。半周期で表示/非表示。 */
  blinkMs: number
  /** 点滅起点（elapsedMs 基準）。startMs と揃え、export 再現のため仮想時間で算出する。 */
  blinkStartMs: number
}

/**
 * 下線ビーム (#270) の進行状態。
 *
 * 対象テキスト幅にフィットする横線（Pixi Graphics の矩形）を sprite の子として置き、
 * ticker で `underlineScaleX` の純関数値を scale.x に当てて左から伸ばす。
 * 矩形は左端基準で描画し、pivot/位置で transform-origin 左を実現する。
 *
 * 中間状態は持たない（ADR0002）: 進行は startMs からの経過 ms で都度計算する。
 * 復元・skip 時は scale.x=1（伸び切り）の静止状態にする。
 */
interface UnderlineAnimation {
  /** 線本体の Graphics（左端基準で矩形を描画済み。scale.x で伸長する）。 */
  gfx: Graphics
  /** 解決済みパラメータ（色/太さ/duration/easing）。 */
  resolved: ResolvedUnderline
  /** 効果開始時刻（elapsedMs 基準）。 */
  startMs: number
  /** 伸長アニメ所要 ms（resolved.durationMs）。ticker 停止判定用。 */
  durationMs: number
  /** 伸び切り確定済みか。完了後に毎フレーム再 settle しないためのラッチ。 */
  settled: boolean
}

export class CharacterLayer extends Container {
  private characters: Map<string, CharacterState> = new Map()
  /** アニメーション駆動用 ticker。動いているキャラがいないときは停止しておく */
  private animTicker: Ticker | null = null
  /** ticker.deltaMS の累計を保持してアニメ進行に使う */
  private elapsedMs: number = 0
  /** 足元 Y 座標（screenHeight * CHARACTER_Y_RATIO） */
  private readonly characterY: number
  /** auto-scale 計算のために screenWidth / screenHeight を保持 */
  private readonly screenWidth: number
  private readonly screenHeight: number
  /** X 座標テーブル（screenWidth * CHARACTER_X_RATIO[pos]） */
  private readonly positionX: Record<string, number>
  /** タイマーの抽象化 (動画エクスポート用 virtual モード対応) */
  private readonly time: TimeController

  /**
   * @param screenWidth 論理画面幅（ASPECT_RATIOS から取得した値を渡す）
   * @param screenHeight 論理画面高さ（ASPECT_RATIOS から取得した値を渡す）
   */
  constructor(
    screenWidth: number,
    screenHeight: number,
    time: TimeController = defaultTimeController
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.time = time
    this.characterY = screenHeight * CHARACTER_Y_RATIO
    this.positionX = {
      left: screenWidth * CHARACTER_X_RATIO.left,
      center: screenWidth * CHARACTER_X_RATIO.center,
      right: screenWidth * CHARACTER_X_RATIO.right,
      off_left: screenWidth * CHARACTER_X_RATIO.off_left,
      off_right: screenWidth * CHARACTER_X_RATIO.off_right,
    }
  }

  /**
   * キャラクター立ち絵を表示する。既に表示中なら position / expression を更新する。
   *
   * 新規表示時は alpha 0 から DEFAULT_FADE_MS かけてフェードインする（#177）。
   * セーブからの復元やスキップモードなど瞬時表示が望ましい場合は `options.instant: true` を渡す。
   * 退場アニメ中の同名キャラを再 show すると、フェードアウトを取り消してフェードインに切り替える。
   *
   * フェードイン進行中（destroyOnComplete=false）の同名キャラへの再 show は、position / expression
   * が同じなら no-op、異なれば即時切替（フェード進行はそのまま継続）。フェード自体を再起動する
   * ユースケースは現状想定していないため、明示的な「フェードリスタート」API は持たない。
   */
  show(
    character: string,
    expression: string,
    position: string,
    assetBaseUrl: string,
    options?: { instant?: boolean }
  ): void {
    const normalizedPosition = normalizePosition(position)
    const instant = options?.instant === true
    const existing = this.characters.get(character)

    if (existing) {
      // 退場フェード中の再 show: フェードアウトを取り消して再フェードイン（または即時表示）に倒す
      if (existing.fadeAnimation?.destroyOnComplete) {
        if (instant) {
          existing.sprite.alpha = 1
          existing.fadeAnimation = null
        } else {
          existing.fadeAnimation = {
            startMs: this.elapsedMs,
            durationMs: DEFAULT_FADE_MS,
            fromAlpha: existing.sprite.alpha,
            toAlpha: 1,
            destroyOnComplete: false,
          }
          this.ensureTicker()
        }
      }

      // 表情が同じで位置も同じなら何もしない（フェード状態は上で解消済み）
      if (existing.expression === expression && existing.position === normalizedPosition) return

      // 位置変更
      if (existing.position !== normalizedPosition) {
        const x = this.positionX[normalizedPosition] ?? this.positionX['center']
        existing.sprite.x = x
        existing.position = normalizedPosition
      }

      // 表情変更
      if (existing.expression !== expression) {
        this.loadTexture(existing.sprite, expression, assetBaseUrl)
        existing.expression = expression
      }
      return
    }

    // 新規表示
    const x = this.positionX[normalizedPosition] ?? this.positionX['center']
    const sprite = new Sprite()
    sprite.anchor.set(0.5, 1)
    sprite.x = x
    sprite.y = this.characterY
    sprite.alpha = instant ? 1 : 0
    this.addChild(sprite)

    // off_right/off_left で登場した立ち絵には名前ラベルを上に自動付与する。
    // llll-ll-media の「車の画像と同じ幅で上に名前」を実現するため。
    // sprite と同じ x を毎フレーム追従させるので、アニメ時も自然に一緒に動く。
    let label: Text | undefined
    if (normalizedPosition === 'off_right' || normalizedPosition === 'off_left') {
      const labelFont = 'bellpoke_font, sans-serif'
      label = new Text({
        text: character,
        style: new TextStyle({ fontFamily: labelFont, fontSize: 48, fill: 0xffffff }),
      })
      label.anchor.set(0.5, 1)
      label.x = sprite.x
      label.y = this.screenHeight * 0.18 // 画面上から 18% の位置 (label の下端)
      label.alpha = instant ? 1 : 0
      this.addChild(label)
      const labelRef = label
      void ensureFontLoaded(labelFont)
        .then(() => {
          if (labelRef.destroyed) return
          labelRef.style = new TextStyle({ fontFamily: labelFont, fontSize: 48, fill: 0xffffff })
        })
        .catch(() => {})
    }

    const state: CharacterState = {
      sprite,
      label,
      position: normalizedPosition,
      expression,
      assetBaseUrl,
      animation: null,
      fadeAnimation: instant
        ? null
        : {
            startMs: this.elapsedMs,
            durationMs: DEFAULT_FADE_MS,
            fromAlpha: 0,
            toAlpha: 1,
            destroyOnComplete: false,
          },
      textEffect: null,
      underline: null,
    }
    this.characters.set(character, state)
    if (state.fadeAnimation) this.ensureTicker()
    this.loadTexture(sprite, expression, assetBaseUrl, label)
  }

  /**
   * 進行中の transform アニメーション (animate()) が走っている間だけ
   * `-a` / `-b` を 1 秒ごとに交互させる。停止状態では `-a` 固定。
   * 呼び出し側は animate() の開始/終了タイミングで呼ぶ。
   */
  private startIdleCycle(character: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state || state.idleIntervalId) return
    const match = state.expression.match(/^(.+)-a$/)
    if (!match) return
    const basename = match[1]
    let frame: 'a' | 'b' = 'a'
    const intervalId = this.time.setInterval(() => {
      const cur = this.characters.get(character)
      if (!cur || cur.sprite.destroyed) {
        this.time.clearInterval(intervalId)
        return
      }
      frame = frame === 'a' ? 'b' : 'a'
      const nextExpression = `${basename}-${frame}`
      cur.expression = nextExpression
      this.loadTexture(cur.sprite, nextExpression, assetBaseUrl, cur.label)
    }, 1000)
    state.idleIntervalId = intervalId
  }

  private stopIdleCycle(character: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state || !state.idleIntervalId) return
    this.time.clearInterval(state.idleIntervalId)
    state.idleIntervalId = undefined
    // 停止後は必ず -a に戻す
    const match = state.expression.match(/^(.+)-[ab]$/)
    if (match) {
      const aExpression = `${match[1]}-a`
      if (state.expression !== aExpression) {
        state.expression = aExpression
        this.loadTexture(state.sprite, aExpression, assetBaseUrl, state.label)
      }
    }
  }

  /**
   * 動画タイトルを画面中央に表示する。
   * 既に Title があれば text を差し替える。空文字なら即時退場。
   * `[アニメ target=Title]` で普通の立ち絵と同じ規則で動かせる。
   */
  showTitle(text: string, fontFamily: string, position?: string): void {
    const NAME = 'Title'
    const existing = this.characters.get(NAME)
    if (text.length === 0) {
      if (existing) this.remove(NAME, { instant: true })
      return
    }
    if (existing) {
      // テキスト差し替え時は進行中のグリフ演出を破棄し、単一 label 表示へ戻す。
      // （グリフは古いテキストのままなので残すと不整合になる）#268
      this.clearTextEffect(existing)
      // 下線も対象テキスト幅に依存するため破棄する（#270）。
      this.clearUnderline(existing)
      if (existing.label && !existing.label.destroyed) {
        existing.label.text = text
        existing.label.style = new TextStyle({ fontFamily, fontSize: 64, fill: 0xffffff })
        existing.label.visible = true
      }
      // position が指定されていれば再配置する (再度別 position から登場させる用途)
      if (position) {
        const normalized = normalizePosition(position)
        const newX = this.positionX[normalized] ?? this.screenWidth * 0.5
        existing.sprite.x = newX
        if (existing.label && !existing.label.destroyed) {
          existing.label.x = newX
        }
        existing.position = normalized
        // 進行中の transform アニメがあれば破棄 (位置が壊れるので)
        existing.animation = null
      }
      return
    }
    // sprite は不可視 (no texture) のアンカー。CharacterState を保つために置く。
    const normalizedPosition = position ? normalizePosition(position) : 'center'
    const initialX = this.positionX[normalizedPosition] ?? this.screenWidth * 0.5
    const sprite = new Sprite()
    sprite.x = initialX
    sprite.y = this.screenHeight * 0.5
    sprite.alpha = 1
    this.addChild(sprite)

    const label = new Text({
      text,
      style: new TextStyle({ fontFamily, fontSize: 64, fill: 0xffffff }),
    })
    label.anchor.set(0.5, 0.5)
    label.x = sprite.x
    label.y = sprite.y
    this.addChild(label)
    // フォントが Google Fonts / @font-face で非同期ロードの場合、初回は fallback で
    // ベイクされるため、ロード完了後に style を再適用してグリフを差し替える
    void ensureFontLoaded(fontFamily)
      .then(() => {
        if (label.destroyed) return
        label.style = new TextStyle({ fontFamily, fontSize: 64, fill: 0xffffff })
      })
      .catch(() => {})

    this.characters.set(NAME, {
      sprite,
      label,
      position: normalizedPosition,
      expression: '',
      assetBaseUrl: '',
      animation: null,
      fadeAnimation: null,
      textEffect: null,
      underline: null,
    })
  }

  /**
   * 表情のみを差し替える（位置はそのまま）
   */
  changeExpression(character: string, expression: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state) return
    if (state.expression === expression) return
    state.expression = expression
    this.loadTexture(state.sprite, expression, assetBaseUrl)
  }

  /**
   * キャラクター（または立ち絵スロット内のオブジェクト）にアニメーションを適用する (#134)。
   *
   * fire-and-forget: 呼び出し側はアニメ完了を待たずに次のイベントへ進める。
   * 子供向け動画用途で「車が回転しながら横移動」「寿司が降ってくる」等を実現。
   *
   * 既存アニメーションがあれば現在位置を起点に上書きする。
   *
   * @param character ターゲット名 (show で使った character 名と一致)
   * @param params アニメパラメータ
   */
  animate(character: string, params: AnimateParams): void {
    const state = this.characters.get(character)
    if (!state) return
    const sprite = state.sprite
    const fromX = sprite.x
    const fromY = sprite.y
    const fromRotation = sprite.rotation
    const fromScale = sprite.scale.x // x/y 等しい想定 (uniform scale)

    // resolveDelta は数値文字列を相対/絶対解釈して target を返す
    const toX = resolveDelta(params.dx, fromX)
    const toY = resolveDelta(params.dy, fromY)
    // rotation はパーサー側で度数。PixiJS は radian なので変換
    const targetDegrees = resolveDelta(params.rotation, (fromRotation * 180) / Math.PI)
    const toRotation = (targetDegrees * Math.PI) / 180
    const toScale = params.scale !== undefined ? params.scale : fromScale

    const durationMs = Math.max(0, params.duration_ms | 0)
    if (durationMs === 0) {
      // 即時適用
      sprite.x = toX
      sprite.y = toY
      sprite.rotation = toRotation
      sprite.scale.set(toScale, toScale)
      state.animation = null
      this.maybeStopTicker()
      return
    }

    state.animation = {
      startMs: this.elapsedMs,
      durationMs,
      easing: params.easing ?? 'Linear',
      fromX,
      fromY,
      fromRotation,
      fromScale,
      toX,
      toY,
      toRotation,
      toScale,
    }
    // アニメ開始時に 2 コマ idle を回す（停止時は -a 固定なので、ここで切替を始める）
    this.startIdleCycle(character, state.assetBaseUrl)
    this.ensureTicker()
  }

  /** タイトル label の現在のフォント・サイズ・色を引き継ぐための定数。 */
  private static readonly TITLE_FONT_SIZE = 64
  private static readonly TITLE_FILL = 0xffffff

  /**
   * グリフ Text の表示幅を測る。PixiJS のテキスト計測に依存する。
   *
   * canvas が無い環境（jsdom など計測不能・非有限値・0 幅）では fontSize ベースの
   * 近似 advance（全角想定で fontSize * 0.6）にフォールバックする。レイアウトが
   * 0 幅で潰れて全グリフが重なる事故を防ぐ防御。実ブラウザでは正しい幅が返る。
   */
  private measureGlyphWidth(t: Text): number {
    let w = 0
    try {
      w = t.width
    } catch {
      w = 0
    }
    if (!Number.isFinite(w) || w <= 0) {
      return CharacterLayer.TITLE_FONT_SIZE * 0.6
    }
    return w
  }

  /**
   * グリフ単位の文字演出を適用する (#268)。
   *
   * 対象（CharacterLayer 上の identifier。例 "Title"）の label をグリフ Text 列に
   * 分解して同位置にレイアウトし、ticker で各グリフを `i*間隔` 遅延の enter アニメ。
   * reveal 系（タイプ）は typewriter.ts を this.time 駆動で 1 文字ずつ表示。
   *
   * fire-and-forget: 呼び出し側は完了を待たず次イベントへ進む。
   * 効果完了後も container を保持するため、後続 `[アニメ target=Title]` が効く。
   *
   * @param instant true なら即時完了状態（全グリフ整列・不透明）にする。
   *   セーブ復元・スキップ時に演出を飛ばすため（ADR 0002: 中間状態を持たない）。
   * @returns フォント確定後のグリフ構築まで含めた完了 Promise。fire-and-forget の
   *   呼び出し側は無視してよい（`void` で破棄）。テストは await して構築完了を待てる。
   */
  applyTextEffect(
    target: string,
    params: TextEffectParams,
    options?: { instant?: boolean }
  ): Promise<void> {
    const state = this.characters.get(target)
    if (!state || !state.label || state.label.destroyed) return Promise.resolve()

    const sourceText = state.label.text
    if (sourceText.length === 0) return Promise.resolve()

    // 既存の演出があれば破棄してから貼り直す（テキスト・パラメータ変更時の再適用）
    this.clearTextEffect(state)

    const fontFamily =
      state.label.style instanceof TextStyle
        ? state.label.style.fontFamily
        : ('sans-serif' as string | string[])

    // フォントが Web フォント遅延ロードの場合、未ロード状態で measure すると fallback
    // フォントの字形で幅が測られて字間がずれる（showTitle の label 再適用と同じ問題 #268）。
    // グリフの分解・幅計測・レイアウト・アニメ開始を ensureFontLoaded 完了後に行い、
    // 確定したフォントで measure する。既ロード時は microtask で即解決し実質遅延ゼロ。
    // fire-and-forget の呼び出し側契約は維持（呼び出し側は完了 Promise を無視できる）。
    const fontName = Array.isArray(fontFamily) ? fontFamily[0] : fontFamily
    return ensureFontLoaded(fontName)
      .catch(() => {})
      .then(() => {
        // 待っている間に対象が退場・テキスト差し替えされていたら何もしない。
        const cur = this.characters.get(target)
        if (cur !== state) return
        if (!state.label || state.label.destroyed) return
        if (state.label.text !== sourceText) return
        this.buildTextEffect(state, sourceText, fontFamily, params, options)
      })
  }

  /**
   * フォント確定後にグリフ列を構築して演出をセットする（applyTextEffect の後半）。
   * 純粋なレイアウト計算（中心 x）は textEffect.layoutGlyphCenters に委譲する。
   */
  private buildTextEffect(
    state: CharacterState,
    sourceText: string,
    fontFamily: string | string[],
    params: TextEffectParams,
    options?: { instant?: boolean }
  ): void {
    // 競合で既に別の演出が貼られている場合があるため、ここでも一度畳んでから貼り直す。
    this.clearTextEffect(state)

    // グリフ Text を生成し、行全体を中央寄せでレイアウトする。
    const container = new Container()
    // sprite の子にすることで、後続 [アニメ] による sprite の transform が container に波及する。
    state.sprite.addChild(container)

    const chars = Array.from(sourceText) // サロゲートペア対応で code point 単位に分解
    const texts: Text[] = []
    const widths: number[] = []
    for (const ch of chars) {
      const t = new Text({
        text: ch,
        style: new TextStyle({
          fontFamily,
          fontSize: CharacterLayer.TITLE_FONT_SIZE,
          fill: CharacterLayer.TITLE_FILL,
        }),
      })
      t.anchor.set(0.5, 0.5)
      container.addChild(t)
      texts.push(t)
      widths.push(this.measureGlyphWidth(t))
    }
    // 各グリフ中心 x は純関数で算出（行全体を container 原点で中央寄せ）。
    // 整列位置 (restX/restY) を明示保持して、補間オフセットは毎フレーム足し込む。
    const centers = layoutGlyphCenters(widths)
    const glyphs = texts.map((t, i) => {
      t.x = centers[i]
      t.y = 0
      return { glyph: t, restX: centers[i], restY: 0 }
    })

    // 元の単一 label は隠す（グリフ列が見た目を担う）。
    if (state.label && !state.label.destroyed) state.label.visible = false

    const reveal = isRevealEffect(params)
    let effect: TextEffectAnimation
    if (reveal) {
      const msPerChar = resolveTypewriterMsPerChar(params)
      // #271: 点滅カーソル。reveal かつ cursor=on のときだけ縦矩形 Graphics を作る。
      const cursor = this.buildCursor(container, params)
      effect = {
        container,
        glyphs,
        transform: null,
        typewriter: startTypewriter(sourceText),
        msPerChar,
        startMs: this.elapsedMs,
        totalMs: msPerChar * chars.length,
        settled: false,
        cursor,
      }
    } else {
      const resolved = resolveTransformEffect(params)
      effect = {
        container,
        glyphs,
        transform: resolved,
        typewriter: null,
        msPerChar: 0,
        startMs: this.elapsedMs,
        totalMs: textEffectTotalDurationMs(resolved, glyphs.length),
        settled: false,
        cursor: null,
      }
    }
    state.textEffect = effect

    if (options?.instant) {
      // 即時完了: 全グリフを整列・不透明にして演出を畳む（中間状態を持たない）。
      // カーソルは破棄する（skip 時はカーソルなしの静止全表示、#271 ADR0002）。
      this.settleTextEffect(state, true)
      return
    }

    // 初期フレームを即時反映してから ticker を回す（最初の 1 フレームのチラつき防止）。
    this.updateTextEffectFrame(effect, 0)
    this.ensureTicker()
  }

  /**
   * 点滅カーソル (#271) の縦矩形 Graphics を作る（reveal かつ cursor=on のときのみ）。
   *
   * グリフ高さに合わせた細い縦棒。色は `カーソル色` 指定 > 文字色 (#268 と同じ TITLE_FILL)。
   * container の子にして reveal head（表示済み末尾グリフの右端）に毎フレーム追従させる。
   * `null` を返したら呼び出し側はカーソルなしの従来挙動になる。
   */
  private buildCursor(container: Container, params: TextEffectParams): CursorState | null {
    const resolved: ResolvedCursor = resolveCursor(params)
    if (!resolved.enabled) return null
    const colorNum =
      resolved.color !== undefined
        ? parseColorToNumber(resolved.color, CharacterLayer.TITLE_FILL)
        : CharacterLayer.TITLE_FILL
    // 縦棒の太さ・高さはグリフサイズに比例。closing.html は border-right 2px 相当。
    const width = Math.max(2, Math.round(CharacterLayer.TITLE_FONT_SIZE * 0.04))
    const height = CharacterLayer.TITLE_FONT_SIZE
    const gfx = new Graphics()
    // 左端基準・縦中央基準で矩形を描く（rect の中心が原点に来るよう左上を負方向に置く）。
    gfx.rect(0, -height / 2, width, height).fill(colorNum)
    container.addChild(gfx)
    return {
      gfx,
      blinkMs: resolved.blinkMs,
      // 点滅起点は効果開始と揃える（仮想時間で算出 → export 再現）。
      blinkStartMs: this.elapsedMs,
    }
  }

  /**
   * カーソルを reveal head（表示済み末尾グリフの右端）に置き、点滅状態を反映する (#271)。
   * 表示文字が 0 のときは先頭グリフ左端へ。`cursorVisible` 純関数で点滅を決める。
   */
  private positionCursor(effect: TextEffectAnimation): void {
    const cursor = effect.cursor
    if (!cursor || cursor.gfx.destroyed) return
    const shown = effect.typewriter ? effect.typewriter.displayedCharCount : effect.glyphs.length
    let headX: number
    let headY: number
    if (effect.glyphs.length === 0) {
      headX = 0
      headY = 0
    } else if (shown <= 0) {
      // まだ 1 文字も出ていない: 先頭グリフの左端。
      const first = effect.glyphs[0]
      headX = first.restX - first.glyph.width / 2
      headY = first.restY
    } else {
      // 表示済み末尾グリフの右端。
      const last = effect.glyphs[Math.min(shown, effect.glyphs.length) - 1]
      headX = last.restX + last.glyph.width / 2
      headY = last.restY
    }
    cursor.gfx.x = headX
    cursor.gfx.y = headY
    const elapsed = this.elapsedMs - cursor.blinkStartMs
    cursor.gfx.visible = cursorVisible(elapsed, cursor.blinkMs)
  }

  /**
   * グリフ演出の 1 フレームを純粋計算（textEffect.ts / typewriter.ts）して各グリフへ適用する。
   * @param deltaMS このフレームの経過時間（typewriter の累積駆動用）。
   * @returns まだ進行中なら true、完了していれば false。
   */
  private updateTextEffectFrame(effect: TextEffectAnimation, deltaMS: number): boolean {
    if (effect.transform) {
      const elapsed = this.elapsedMs - effect.startMs
      for (let i = 0; i < effect.glyphs.length; i++) {
        const { glyph, restX, restY } = effect.glyphs[i]
        const gt = computeGlyphTransform(effect.transform, elapsed, i)
        glyph.x = restX + gt.offsetX
        glyph.y = restY + gt.offsetY
        glyph.rotation = gt.rotationRad
        glyph.scale.set(gt.scale, gt.scale)
        glyph.alpha = gt.alpha
      }
      return elapsed < effect.totalMs
    }
    if (effect.typewriter) {
      // reveal: typewriter を deltaMS で累積駆動し、displayedCharCount まで可視。
      const next = tickTypewriter(effect.typewriter, deltaMS, effect.msPerChar)
      effect.typewriter = next
      for (let i = 0; i < effect.glyphs.length; i++) {
        effect.glyphs[i].glyph.visible = i < next.displayedCharCount
      }
      // カーソルは reveal head に追従して点滅（タイプ中）。
      this.positionCursor(effect)
      return next.displayedCharCount < effect.glyphs.length
    }
    return false
  }

  /**
   * グリフ演出を「効果完了済み（全グリフ整列・不透明・全可視）」の静止状態にする。
   * container/glyphs は保持したまま、進行アニメだけ畳む。復元・即時完了に使う。
   *
   * @param instant true（skip/復元）ならカーソルを破棄して「カーソルなしの静止全表示」に畳む
   *   (#271 ADR0002: skip 時はカーソルなし)。false（通常完了）ならカーソルは末尾に固定して
   *   点滅し続ける（closing.html 忠実）— カーソルは settle 後も生かす小例外。
   */
  private settleTextEffect(state: CharacterState, instant = false): void {
    const effect = state.textEffect
    if (!effect) return
    for (const { glyph, restX, restY } of effect.glyphs) {
      glyph.x = restX
      glyph.y = restY
      glyph.rotation = 0
      glyph.scale.set(1, 1)
      glyph.alpha = 1
      glyph.visible = true
    }
    if (effect.typewriter) {
      effect.typewriter = { ...effect.typewriter, displayedCharCount: effect.glyphs.length, acc: 0 }
    }
    if (effect.cursor) {
      if (instant) {
        // skip/復元: カーソルなしの静止全表示に畳む。
        this.destroyCursor(effect)
      } else {
        // 通常完了: カーソルを末尾位置に固定。点滅は settle 後も ticker が継続する。
        this.positionCursor(effect)
      }
    }
    // 進行を終えたので transform/typewriter の駆動は不要だが、container は保持する。
    // settled ラッチを立てて、以後 ticker が毎フレーム再 settle しないようにする。
    // （カーソルがある場合のみ ticker はカーソル点滅のために回り続ける — isTextEffectActive 参照。）
    effect.settled = true
  }

  /** カーソル Graphics を破棄する (#271)。skip / 演出破棄時に呼ぶ。 */
  private destroyCursor(effect: TextEffectAnimation): void {
    const cursor = effect.cursor
    if (!cursor) return
    if (!cursor.gfx.destroyed) {
      effect.container.removeChild(cursor.gfx)
      cursor.gfx.destroy()
    }
    effect.cursor = null
  }

  /**
   * グリフ演出を完全に破棄し、単一 label 表示へ戻す（テキスト差し替え・退場時）。
   */
  private clearTextEffect(state: CharacterState): void {
    const effect = state.textEffect
    if (!effect) return
    this.destroyCursor(effect)
    for (const { glyph } of effect.glyphs) {
      effect.container.removeChild(glyph)
      glyph.destroy()
    }
    if (!effect.container.destroyed) {
      state.sprite.removeChild(effect.container)
      effect.container.destroy()
    }
    state.textEffect = null
    if (state.label && !state.label.destroyed) state.label.visible = true
  }

  /**
   * 下線ビーム (#270) を対象テキストに適用する。
   *
   * 対象（CharacterLayer 上の identifier。例 "Title"）の label の実 measure 幅にフィットする
   * 横線を直下に置き、scale.x 0→1 で左から伸ばす（opening.html の drawLine 相当）。
   * 線は sprite の子にするため、後続 `[アニメ target=Title]` が sprite を動かすと追従する。
   *
   * fire-and-forget: 呼び出し側は完了を待たず次イベントへ進む。
   * 幅 measure は fallback フォントずれを避けるため ensureFontLoaded 後に行う。
   *
   * @param instant true（skip/復元）なら伸び切り（scale.x=1）の静止線にする（ADR0002）。
   * @returns フォント確定後の線構築まで含めた完了 Promise。fire-and-forget は無視してよい。
   */
  applyUnderline(
    target: string,
    params: UnderlineParams,
    options?: { instant?: boolean }
  ): Promise<void> {
    const state = this.characters.get(target)
    if (!state || !state.label || state.label.destroyed) return Promise.resolve()
    const label = state.label
    const sourceText = label.text
    if (sourceText.length === 0) return Promise.resolve()

    // 既存の下線があれば破棄してから貼り直す（テキスト・パラメータ変更時の再適用）。
    this.clearUnderline(state)

    const fontFamily =
      label.style instanceof TextStyle
        ? label.style.fontFamily
        : ('sans-serif' as string | string[])
    const fontName = Array.isArray(fontFamily) ? fontFamily[0] : fontFamily
    return ensureFontLoaded(fontName)
      .catch(() => {})
      .then(() => {
        // 待っている間に対象が退場・テキスト差し替えされていたら何もしない。
        const cur = this.characters.get(target)
        if (cur !== state) return
        if (!state.label || state.label.destroyed) return
        if (state.label.text !== sourceText) return
        this.buildUnderline(state, params, options)
      })
  }

  /**
   * フォント確定後に下線 Graphics を構築して適用する（applyUnderline の後半）。
   * 幾何計算（左端 x・y・幅）は underline.layoutUnderline に委譲する。
   */
  private buildUnderline(
    state: CharacterState,
    params: UnderlineParams,
    options?: { instant?: boolean }
  ): void {
    this.clearUnderline(state)
    const label = state.label
    if (!label || label.destroyed) return

    const resolved = resolveUnderline(params)
    // 対象テキストの実 measure 幅・高さ。anchor 0.5 のため sprite-local 中心は (0,0)。
    const textWidth = this.measureGlyphWidth(label)
    const textHeight = (() => {
      let h = 0
      try {
        h = label.height
      } catch {
        h = 0
      }
      return Number.isFinite(h) && h > 0 ? h : CharacterLayer.TITLE_FONT_SIZE
    })()
    // テキスト下端の sprite-local y（中心 0 から下へ半分）。
    const textBottomY = textHeight / 2
    // offset 未指定時の自動余白: フォントサイズの数 %（テキスト下端と線の間の隙間）。
    const autoOffset = Math.round(CharacterLayer.TITLE_FONT_SIZE * 0.1)
    const geom = layoutUnderline(textWidth, textBottomY, resolved, autoOffset)

    const gfx = new Graphics()
    // 矩形をローカル原点 (0,0) を左端として描く。scale.x はローカル原点基準で効くため、
    // gfx 自体を線の左端位置 (geom.x, geom.y) に置けば scale.x 0→1 が「左固定で右へ伸びる」になる。
    gfx.rect(0, 0, geom.width, geom.thickness).fill(resolved.colorNum)
    gfx.x = geom.x
    gfx.y = geom.y
    state.sprite.addChild(gfx)

    const anim: UnderlineAnimation = {
      gfx,
      resolved,
      startMs: this.elapsedMs,
      durationMs: resolved.durationMs,
      settled: false,
    }
    state.underline = anim

    if (options?.instant) {
      // 即時完了: 伸び切り（scale.x=1）の静止線にする（中間状態を持たない）。
      this.settleUnderline(state)
      return
    }
    // 初期フレーム（scale.x=0）を反映してから ticker を回す。
    this.updateUnderlineFrame(anim)
    this.ensureTicker()
  }

  /**
   * 下線の 1 フレームを純粋計算（underline.underlineScaleX）して scale.x に当てる。
   * @returns まだ伸長中なら true、伸び切ったら false。
   */
  private updateUnderlineFrame(anim: UnderlineAnimation): boolean {
    if (anim.gfx.destroyed) return false
    const elapsed = this.elapsedMs - anim.startMs
    const sx = underlineScaleX(elapsed, anim.resolved)
    anim.gfx.scale.x = sx
    return elapsed < anim.durationMs
  }

  /** 下線を伸び切り（scale.x=1）の静止状態にする。復元・即時完了に使う。 */
  private settleUnderline(state: CharacterState): void {
    const anim = state.underline
    if (!anim) return
    if (!anim.gfx.destroyed) anim.gfx.scale.x = 1
    anim.settled = true
  }

  /** 下線 Graphics を完全に破棄する（テキスト差し替え・退場時）。 */
  private clearUnderline(state: CharacterState): void {
    const anim = state.underline
    if (!anim) return
    if (!anim.gfx.destroyed) {
      if (!state.sprite.destroyed) state.sprite.removeChild(anim.gfx)
      anim.gfx.destroy()
    }
    state.underline = null
  }

  /** 進行中アニメーション（transform / fade / textEffect / underline いずれか）を持つキャラがいるか */
  hasActiveAnimation(): boolean {
    for (const s of this.characters.values()) {
      if (s.animation || s.fadeAnimation) return true
      if (s.textEffect && this.isTextEffectActive(s.textEffect)) return true
      if (s.underline && this.isUnderlineActive(s.underline)) return true
    }
    return false
  }

  /** グリフ演出がまだ進行中か（完了済みなら container は保持するが ticker は止めてよい）。 */
  private isTextEffectActive(effect: TextEffectAnimation): boolean {
    // 完了後もカーソル（点滅）があれば ticker を回し続ける（#271 小例外）。
    // settle 後の cursor は render-only で、点滅し続けるため駆動が要る。
    if (effect.cursor) return true
    // 整列確定済みなら、たとえ未完了でも駆動不要（settle 後は静止状態を保つだけ）。
    if (effect.settled) return false
    if (effect.transform) return this.elapsedMs - effect.startMs < effect.totalMs
    if (effect.typewriter) return effect.typewriter.displayedCharCount < effect.glyphs.length
    return false
  }

  /** 下線ビームがまだ進行中か（伸び切れば ticker は止めてよい）。 (#270) */
  private isUnderlineActive(underline: UnderlineAnimation): boolean {
    if (underline.settled) return false
    return this.elapsedMs - underline.startMs < underline.durationMs
  }

  private ensureTicker(): void {
    if (this.animTicker) return
    const ticker = new Ticker()
    ticker.add(() => {
      this.elapsedMs += ticker.deltaMS
      let anyActive = false
      // 退場フェード完了で characters Map から削除する可能性があるため、entries を先にコピーする。
      // （Map 自体の iteration は delete に対して安全だが、コピー方が読みやすいので採用）
      const entries = Array.from(this.characters.entries())
      for (const [name, state] of entries) {
        const a = state.animation
        if (a) {
          const t = (this.elapsedMs - a.startMs) / a.durationMs
          if (t >= 1) {
            state.sprite.x = a.toX
            state.sprite.y = a.toY
            state.sprite.rotation = a.toRotation
            state.sprite.scale.set(a.toScale, a.toScale)
            state.animation = null
            // アニメ終了 → 2 コマ切替を止めて -a に戻す
            this.stopIdleCycle(name, state.assetBaseUrl)
          } else {
            anyActive = true
            const eased = applyEasing(a.easing, t)
            state.sprite.x = a.fromX + (a.toX - a.fromX) * eased
            state.sprite.y = a.fromY + (a.toY - a.fromY) * eased
            state.sprite.rotation = a.fromRotation + (a.toRotation - a.fromRotation) * eased
            const sc = a.fromScale + (a.toScale - a.fromScale) * eased
            state.sprite.scale.set(sc, sc)
          }
        }

        const f = state.fadeAnimation
        if (f) {
          const tf = (this.elapsedMs - f.startMs) / f.durationMs
          if (tf >= 1) {
            state.sprite.alpha = f.toAlpha
            state.fadeAnimation = null
            if (f.destroyOnComplete) {
              if (state.idleIntervalId) this.time.clearInterval(state.idleIntervalId)
              this.clearTextEffect(state) // グリフ container/glyphs を破棄 (#268)
              this.clearUnderline(state) // 下線 gfx を破棄 (#270)
              this.removeChild(state.sprite)
              state.sprite.destroy()
              if (state.label) {
                this.removeChild(state.label)
                state.label.destroy()
                state.label = undefined
              }
              this.characters.delete(name)
            }
          } else {
            anyActive = true
            state.sprite.alpha = f.fromAlpha + (f.toAlpha - f.fromAlpha) * tf
            if (state.label) state.label.alpha = state.sprite.alpha
          }
        }

        // グリフ単位の文字演出 (#268) を毎フレーム純粋計算で駆動する。
        // 整列確定済み（settled）の effect は毎フレーム再 settle せず読み飛ばす（空回り回避 nit）。
        // settle は「進行 → 完了」へ遷移したフレームの 1 回だけで足りる。
        const te = state.textEffect
        if (te && !te.settled) {
          const stillRunning = this.updateTextEffectFrame(te, ticker.deltaMS)
          if (stillRunning) {
            anyActive = true
          } else {
            // 完了 → 整列状態に確定（container は保持し後続 [アニメ] が効く）。
            // 通常完了 = instant 引数なし（カーソルは末尾固定で点滅継続）。
            this.settleTextEffect(state)
          }
        } else if (te && te.cursor) {
          // settle 済みでもカーソルがあれば点滅だけ駆動し続ける（#271 render-only の小例外）。
          this.positionCursor(te)
          anyActive = true
        }

        // 下線ビーム (#270) を毎フレーム純粋計算で駆動する。
        const ul = state.underline
        if (ul && !ul.settled) {
          const stillRunning = this.updateUnderlineFrame(ul)
          if (stillRunning) {
            anyActive = true
          } else {
            // 完了 → 伸び切り（scale.x=1）に確定。
            this.settleUnderline(state)
          }
        }

        // 名前ラベルを sprite に追従させる（x のみ。y は loadTexture で画像高さに合わせて固定済み）
        if (state.label) {
          state.label.x = state.sprite.x
        }
      }
      if (!anyActive) {
        this.maybeStopTicker()
      }
    })
    ticker.start()
    this.animTicker = ticker
  }

  private maybeStopTicker(): void {
    if (!this.animTicker) return
    if (this.hasActiveAnimation()) return
    this.animTicker.stop()
    this.animTicker.destroy()
    this.animTicker = null
  }

  /**
   * キャラクターを退場させる。
   *
   * デフォルトでは alpha 1 → 0 のフェードアウト後に sprite を破棄する（#177）。
   * 即時退場が必要な場合は `options.instant: true`（旧挙動と等価）。
   */
  remove(character: string, options?: { instant?: boolean }): void {
    const state = this.characters.get(character)
    if (!state) return
    const instant = options?.instant === true
    if (state.idleIntervalId) {
      this.time.clearInterval(state.idleIntervalId)
      state.idleIntervalId = undefined
    }
    if (instant) {
      this.clearTextEffect(state) // グリフ container/glyphs を破棄 (#268)
      this.clearUnderline(state) // 下線 gfx を破棄 (#270)
      this.removeChild(state.sprite)
      state.sprite.destroy()
      if (state.label) {
        this.removeChild(state.label)
        state.label.destroy()
        state.label = undefined
      }
      this.characters.delete(character)
      this.maybeStopTicker()
      return
    }
    state.fadeAnimation = {
      startMs: this.elapsedMs,
      durationMs: DEFAULT_FADE_MS,
      fromAlpha: state.sprite.alpha,
      toAlpha: 0,
      destroyOnComplete: true,
    }
    this.ensureTicker()
  }

  /**
   * 現在表示中のキャラクター情報を返す（スナップショット用）
   */
  getCharacterStates(): Array<{ name: string; expression: string; position: string }> {
    const result: Array<{ name: string; expression: string; position: string }> = []
    for (const [name, state] of this.characters) {
      result.push({ name, expression: state.expression, position: state.position })
    }
    return result
  }

  /**
   * 全キャラクターを削除する
   */
  clear(): void {
    for (const [, state] of this.characters) {
      if (state.idleIntervalId) this.time.clearInterval(state.idleIntervalId)
      this.clearTextEffect(state) // グリフ container/glyphs を破棄 (#268)
      this.clearUnderline(state) // 下線 gfx を破棄 (#270)
      this.removeChild(state.sprite)
      state.sprite.destroy()
      if (state.label) {
        this.removeChild(state.label)
        state.label.destroy()
      }
    }
    this.characters.clear()
    this.maybeStopTicker()
  }

  /**
   * テクスチャをロードして Sprite に適用する
   */
  private loadTexture(
    sprite: Sprite,
    expression: string,
    assetBaseUrl: string,
    label?: Text
  ): void {
    if (!assetBaseUrl) return

    const cleanExpression = expression.replace(/^\//, '')
    const url = `${assetBaseUrl}/images/${cleanExpression}.png`

    Assets.load(url)
      .then((texture) => {
        // destroy 後に解決した場合は反映しない（UAF 防止）
        if (sprite.destroyed) return
        // テクスチャが論理画面より大きければ、画面内に収まるよう自動スケール
        // (llll-ll-media の車のように 1600x900 級の素材を 800x450 論理画面に乗せるため)
        const sw = this.screenWidth
        const sh = this.screenHeight
        if (texture.width > sw || texture.height > sh) {
          const scale = Math.min(sw / texture.width, sh / texture.height)
          sprite.scale.set(scale)
        } else {
          sprite.scale.set(1)
        }
        // ラベルを車の幅に収める。
        // - natural width が車幅を超えたら縮小、収まっていれば等倍のまま (大きくしない)
        // - label.anchor=(0.5, 1) なので label.x = sprite.x で水平方向は中央揃え
        if (label && !label.destroyed) {
          const spriteW = sprite.width
          label.scale.set(1, 1)
          const naturalW = label.width
          if (naturalW > spriteW && naturalW > 0) {
            const s = spriteW / naturalW
            label.scale.set(s, s)
          }
        }
        sprite.texture = texture
      })
      .catch((err) => {
        console.warn('[name-name] 立ち絵の読み込みに失敗: ' + url, err)
      })
  }
}
