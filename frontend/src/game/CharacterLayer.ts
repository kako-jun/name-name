/**
 * 立ち絵表示レイヤー
 *
 * PixiJS Container 上でキャラクター立ち絵の表示・表情変更・退場を管理する。
 */

import { Assets, Container, Sprite, Ticker } from 'pixi.js'
import type { Easing } from '../types'
import { applyEasing, resolveDelta } from './easing'
import { ASPECT_RATIOS } from './constants'

/** キャラクターの画面上の配置位置（screenWidth に対する比率） */
const CHARACTER_X_RATIO: Record<string, number> = {
  left: 150 / 800, // 0.1875
  center: 400 / 800, // 0.5
  right: 650 / 800, // 0.8125
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

/** 足元 Y 座標の比率（横長 450px 基準: 380/450 ≒ 0.844） */
const CHARACTER_Y_RATIO = 380 / ASPECT_RATIOS['16:9'].height

interface CharacterState {
  sprite: Sprite
  position: string
  expression: string
  /** 進行中アニメーション。null なら静的 */
  animation: ActiveAnimation | null
  /** フェードイン/アウトアニメーション。退場時は完了後に sprite を destroy する */
  fadeAnimation: FadeAnimation | null
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

export class CharacterLayer extends Container {
  private characters: Map<string, CharacterState> = new Map()
  /** アニメーション駆動用 ticker。動いているキャラがいないときは停止しておく */
  private animTicker: Ticker | null = null
  /** ticker.deltaMS の累計を保持してアニメ進行に使う */
  private elapsedMs: number = 0
  /** 足元 Y 座標（screenHeight * CHARACTER_Y_RATIO） */
  private readonly characterY: number
  /** X 座標テーブル（screenWidth * CHARACTER_X_RATIO[pos]） */
  private readonly positionX: Record<string, number>

  /**
   * @param screenWidth 論理画面幅（ASPECT_RATIOS から取得した値を渡す）
   * @param screenHeight 論理画面高さ（ASPECT_RATIOS から取得した値を渡す）
   */
  constructor(screenWidth: number, screenHeight: number) {
    super()
    this.characterY = screenHeight * CHARACTER_Y_RATIO
    this.positionX = {
      left: screenWidth * CHARACTER_X_RATIO.left,
      center: screenWidth * CHARACTER_X_RATIO.center,
      right: screenWidth * CHARACTER_X_RATIO.right,
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

    const state: CharacterState = {
      sprite,
      position: normalizedPosition,
      expression,
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
    }
    this.characters.set(character, state)
    if (state.fadeAnimation) this.ensureTicker()
    this.loadTexture(sprite, expression, assetBaseUrl)
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
    this.ensureTicker()
  }

  /** 進行中アニメーション（transform / fade いずれか）を 1 つでも持つキャラがいるか */
  hasActiveAnimation(): boolean {
    for (const s of this.characters.values()) {
      if (s.animation || s.fadeAnimation) return true
    }
    return false
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
              this.removeChild(state.sprite)
              state.sprite.destroy()
              this.characters.delete(name)
            }
          } else {
            anyActive = true
            state.sprite.alpha = f.fromAlpha + (f.toAlpha - f.fromAlpha) * tf
          }
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
    if (instant) {
      this.removeChild(state.sprite)
      state.sprite.destroy()
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
      this.removeChild(state.sprite)
      state.sprite.destroy()
    }
    this.characters.clear()
    this.maybeStopTicker()
  }

  /**
   * テクスチャをロードして Sprite に適用する
   */
  private loadTexture(sprite: Sprite, expression: string, assetBaseUrl: string): void {
    if (!assetBaseUrl) return

    const cleanExpression = expression.replace(/^\//, '')
    const url = `${assetBaseUrl}/images/${cleanExpression}.png`

    Assets.load(url)
      .then((texture) => {
        // destroy 後に解決した場合は反映しない（UAF 防止）
        if (sprite.destroyed) return
        sprite.texture = texture
      })
      .catch((err) => {
        console.warn('[name-name] 立ち絵の読み込みに失敗: ' + url, err)
      })
  }
}
