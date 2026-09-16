/**
 * 追うスポットライトレイヤー (#693)。
 *
 * `BackgroundBoardLayer`/`PropLayer` と同系統の設計（screenWidth/screenHeight を受け取る専用
 * `Container`、`getState()`/`restore()` で `NovelGameState.spotlight` を取り回す settled state
 * パターン）だが、画像をロードしない点が異なる: 白い中心から外周へ透明にフェードする正方形
 * canvas テクスチャを1枚だけ生成し、`Sprite.tint`（色）・`alpha`（ピーク不透明度）・
 * `width`/`height`（直径）で使い回す。`EventImageLayer` の `ambientEffects.buildDisplacementNoiseCanvas`
 * と同じ「Canvas 2D で1枚だけ生成 → `Texture.from()` → Sprite」パターンに倣う。
 *
 * PixiJS v8 の `FillGradient`（radial）+ `Graphics.fill()` も検討したが、内部で
 * `CanvasRenderingContext2D.createRadialGradient` を fill 時に即座に呼ぶため、jsdom
 * （`canvas` npm パッケージ未導入、`getContext('2d')` が `null`）のテスト環境で例外を投げる
 * ことが判明した（`ambientEffects.test.ts` が明記する既知の制約）。Sprite+tint 方式なら
 * `buildSpotlightGradientCanvas` が `ambientEffects.buildDisplacementNoiseCanvas` と同じ
 * `if (!ctx) return null` 防御的フォールバックを取れ、テスト環境でも例外を投げずに
 * 「描画だけ諦める」劣化ができる（実ブラウザでは通常どおり canvas 2D が使えるため無関係）。
 *
 * 対象キャラの現在座標は毎フレーム `CharacterLayer.getCurrentPosition()` に問い合わせる
 * （キャラの入場退場モーション #684・将来の立ち位置変更に追従するため、生成時点の座標を
 * 固定で保持しない、Issue #693 方針）。`target` が未指定、または対象キャラが現在表示されて
 * いない場合は画面中央に固定表示する。
 *
 * カメラモード非依存（`CameraMode` に関わらず機能する、#693 方針）。レイヤー順は
 * `CharacterLayer` の直後・`PropLayer` の前（docs/architecture.md「シアターモード構想」→
 * 「レイヤーモデル」節）。光源なのでキャラより手前・大道具より奥に出す。
 */
import { Container, Sprite, Texture } from 'pixi.js'
import type { CharacterLayer } from './CharacterLayer'
import { parseHexColor } from './novelLayout'
import { TimeController, defaultTimeController } from './TimeController'

/** `getState()` の戻り値。`NovelGameState.spotlight`（GameState.ts の `SpotlightState`）と同形。 */
export interface SpotlightLayerState {
  /** 追従対象キャラ名。`null` = 画面中央固定（追従しない）。 */
  target: string | null
  color: string
  /** 半径。画面幅に対する比率（`Event::Spotlight.radius` と同じ単位）。 */
  radius: number
}

/** グラデーションテクスチャの正方形サイズ（px）。`Sprite.width/height` で任意の直径に伸縮する。 */
const SPOTLIGHT_TEXTURE_SIZE = 256

/** 中心のピーク不透明度。additive blend と組み合わせて「光が当たる」見た目にする。 */
const SPOTLIGHT_PEAK_ALPHA = 0.45

/**
 * 白の中心から外周へ透明にフェードする正方形 canvas を1枚だけ構築する (#693)。
 * 色は焼き込まない（`Sprite.tint` で使い回すため常に白）。
 *
 * `ambientEffects.buildDisplacementNoiseCanvas` と同じ防御的フォールバック: `document` 未定義
 * （SSR 等）・`getContext('2d')` が `null`（jsdom に `canvas` npm パッケージ未導入の場合等）では
 * 例外を投げず `null` を返す。呼び出し側は `null` のとき描画を諦める（state 管理自体は継続）。
 */
function buildSpotlightGradientCanvas(size = SPOTLIGHT_TEXTURE_SIZE): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const r = size / 2
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)')
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return canvas
}

export class LightingLayer extends Container {
  /** `null` は canvas 2D 未対応環境（jsdom 等）でテクスチャ構築に失敗した場合。描画は諦める。 */
  private readonly sprite: Sprite | null
  private state: SpotlightLayerState | null = null
  private tickerId: number | null = null

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    private readonly characterLayer: CharacterLayer,
    private readonly time: TimeController = defaultTimeController
  ) {
    super()
    // 光の演出は入力を奪わない（誤タップで本文が進むのを防ぐ、他の演出レイヤーと同じ規律）。
    this.eventMode = 'none'
    const canvas = buildSpotlightGradientCanvas()
    if (canvas) {
      const sprite = new Sprite(Texture.from(canvas))
      sprite.anchor.set(0.5, 0.5)
      // 加算合成で「光が当たる」見た目にする（単純な半透明の白い円だとただの汚れに見える）。
      sprite.blendMode = 'add'
      sprite.alpha = SPOTLIGHT_PEAK_ALPHA
      sprite.visible = false
      this.addChild(sprite)
      this.sprite = sprite
    } else {
      this.sprite = null
    }
  }

  /**
   * スポットライトを点灯する（`[スポットライト: ...]`）。既に点灯中なら上書きする。
   * `color` の空文字は白にフォールバックする（`parseHexColor` の既定と同じ規律）。
   * `radius` の非有限値/負値は 0 にクランプする（parser 側は緩く受け取るだけなので、ここが
   * フロント側の最終防御。`BackgroundBoard`/`Prop` の depth クランプと同じ方針）。
   */
  set(target: string | null, color: string, radius: number): void {
    this.state = {
      target,
      color: color || '#ffffff',
      radius: Number.isFinite(radius) ? Math.max(0, radius) : 0.2,
    }
    if (this.sprite) this.sprite.visible = true
    this.ensureTicker()
    this.redraw()
  }

  /** 消灯する（`[スポットライト消灯]`）。 */
  clear(): void {
    this.state = null
    this.stopTicker()
    if (this.sprite) this.sprite.visible = false
  }

  /**
   * 完成済みスナップショット（`NovelGameState.spotlight`）へ宣言的に復元する
   * （goBack/seekTo/セーブ復元/任意局面起動、`BackgroundBoardLayer.restore`/`PropLayer.restore`
   * と同じ役割）。`null` は消灯。
   */
  restore(state: SpotlightLayerState | null): void {
    if (state) {
      this.set(state.target, state.color, state.radius)
    } else {
      this.clear()
    }
  }

  /** 現在の点灯状態を settled state として返す（`NovelGameState.spotlight` 用）。 */
  getState(): SpotlightLayerState | null {
    return this.state ? { ...this.state } : null
  }

  private ensureTicker(): void {
    if (this.tickerId != null) return
    this.tickerId = this.time.setInterval(() => this.redraw(), 16)
  }

  private stopTicker(): void {
    if (this.tickerId != null) {
      this.time.clearInterval(this.tickerId)
      this.tickerId = null
    }
  }

  /**
   * 対象キャラの現在座標（未指定/未表示なら画面中央）へ再配置する。ticker から毎フレーム
   * 呼ばれる（追従のため、キャラが動いていなくても呼び続ける——`PropLayer`/`BackgroundBoardLayer`
   * のスライドイン専用 ticker と違い、スポットライトは点灯中ずっと「今の位置」を問い合わせ
   * 続ける必要がある）。`sprite` が `null`（canvas 2D 未対応環境）でも state 管理は継続する。
   */
  private redraw(): void {
    if (!this.state) return
    const pos = this.state.target ? this.characterLayer.getCurrentPosition(this.state.target) : null
    const cx = pos ? pos.x : this.screenWidth / 2
    const cy = pos ? pos.y : this.screenHeight / 2
    if (!this.sprite) return
    this.sprite.tint = parseHexColor(this.state.color)
    this.sprite.position.set(cx, cy)
    const diameterPx = Math.max(2, this.state.radius * this.screenWidth * 2)
    this.sprite.width = diameterPx
    this.sprite.height = diameterPx
  }
}
