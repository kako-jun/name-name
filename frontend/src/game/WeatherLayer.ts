/**
 * 天候レイヤー (#706)。
 *
 * `[天候: 雨|雪|桜]` / `[天候: なし]` を管理する専用レイヤー。雨・雪・桜吹雪の粒を画面空間のオーバーレイとして降らせる
 * 単一スロット（新しい `set()` が前の天候を置換する。`StageFrontLayer` / `WallLayer` と同じ意味論）。
 *
 * - 物理演算なし。粒の位置は `weatherParticles.ts` の純粋関数が「固定シードの初期値 + 経過時間」から決定論的に出す。
 *   このクラスは「いつ計算するか」（`TimeController` の 16ms interval）と「結果をどの Graphics に当てるか」だけを持つ。
 *   時計は `EventImageLayer` のアンビエント演出と同じ `TimeController.now()`（動画書き出しでは仮想時間）。
 * - 描画は既存アセット不要の図形（雨=細い線、雪=円、桜=楕円の花びら）。粒ごとの `Graphics` は種類ごとに一度だけ描き、
 *   毎フレームは x/y/rotation/scale/alpha を書き換えるだけ（`clear()` や再描画をしないので毎フレームのジオメトリ生成・GC が出ない）。
 * - 画面空間のオーバーレイ。depth もカメラ射影も持たず、`CameraZoomController` のズームも受けない（`getLayers` に入れない）。
 * - 保存状態（`getState`）は「種類＋強さ」だけ（ADR-0002）。粒の位置・時計は保存しない。復元は同じ天候なら時計を
 *   巻き戻さず流し続け、違うときは経過 0 から降らせ直す。
 * - `prefers-reduced-motion: reduce` では降らせない（粒を隠す）。ただし動画書き出し中は視聴者の設定ではなく作品として
 *   出力するので降らせる。状態（`getState`）は設定に関わらず宣言どおり保つ。
 */
import { Container, Graphics } from 'pixi.js'
import type { WeatherKind } from '../types'
import type { WeatherState } from './GameState'
import { TimeController, defaultTimeController } from './TimeController'
import { prefersReducedMotion } from './boardFaceFlip'
import {
  clampWeatherIntensity,
  createWeatherParticleParams,
  evaluateWeatherParticle,
  weatherParticleCount,
  type WeatherParticleFrame,
  type WeatherParticleParams,
} from './weatherParticles'

/** 毎フレーム再計算する間隔（ms）。`EventImageLayer.ensureAmbientTimer` と同じ 16ms。 */
const WEATHER_FRAME_MS = 16

/** 種類ごとの粒の基準図形を `Graphics` に一度だけ描く。 */
function drawParticleShape(g: Graphics, kind: WeatherKind): void {
  if (kind === 'Rain') {
    g.rect(-0.7, -9, 1.4, 18).fill({ color: 0xcfe3ff })
  } else if (kind === 'Snow') {
    g.circle(0, 0, 2.4).fill({ color: 0xffffff })
  } else {
    g.ellipse(0, 0, 5.5, 3.2).fill({ color: 0xffb7c9 })
  }
}

export class WeatherLayer extends Container {
  /** 粒の描画物を入れる箱。reduced-motion の表示切替はこちらで行い、レイヤー自身の `visible`（タイトル画面の隠し等）と干渉させない。 */
  private readonly particleBox = new Container()
  private current: WeatherState | null = null
  private params: WeatherParticleParams[] = []
  private sprites: Graphics[] = []
  private readonly frame: WeatherParticleFrame = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
  /** 天候を張った時刻（`time.now()` 基準）。経過時間の起点。 */
  private startMs = 0
  private timer: number | null = null
  private exporting = false

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    private readonly time: TimeController = defaultTimeController
  ) {
    super()
    // 天候そのものはクリックしても何も起きない（誤タップで本文が進むのを防ぐ。他の演出レイヤーと同じ）。
    this.eventMode = 'none'
    this.addChild(this.particleBox)
  }

  /**
   * 天候を張る。既存の天候があれば置換する（単一スロット）。同じ種類・強さで張り直しても時計は戻さない
   * （降り続ける）。強さは範囲へクランプする。
   */
  set(kind: WeatherKind, intensity: number): void {
    const next: WeatherState = { kind, intensity: clampWeatherIntensity(intensity) }
    const same =
      this.current !== null &&
      this.current.kind === next.kind &&
      this.current.intensity === next.intensity
    if (same) return
    this.arm(next)
  }

  /** 天候を消す（`[天候: なし]` / `[場面転換]` / 新規開始 / 終劇 / 破棄）。Graphics を破棄しタイマーを止める。 */
  clear(): void {
    this.stopTimer()
    this.destroySprites()
    this.params = []
    this.current = null
  }

  /**
   * 完成済みスナップショット（`NovelGameState.weather`）へ宣言的に復元する（goBack/seekTo/セーブ復元/任意局面起動）。
   * 同じ天候が降っていればそのまま流し続け、違う・止まっているときは経過 0 から降らせ直す。粒の位置は保存しない。
   */
  restore(state: WeatherState | null): void {
    if (!state) {
      this.clear()
      return
    }
    this.set(state.kind, state.intensity)
  }

  /** 現在の天候を settled state として返す。reduced-motion で隠れていても宣言された事実を返す（ADR-0002）。 */
  getState(): WeatherState | null {
    return this.current ? { ...this.current } : null
  }

  /** 動画書き出し中か。書き出し中は reduced-motion に関わらず降らせる（作品として出力するため）。 */
  setExporting(exporting: boolean): void {
    this.exporting = exporting
    if (this.current) this.updateFrame()
  }

  /** 生きている粒の数（テスト・検証用）。 */
  particleCount(): number {
    return this.sprites.length
  }

  /** 粒を描いた Graphics の一覧（テスト・検証用）。 */
  getParticleGraphics(): readonly Graphics[] {
    return this.sprites
  }

  /** 粒が実際に見える状態か（天候あり、かつ reduced-motion で隠れていない。テスト・検証用）。 */
  isParticlesVisible(): boolean {
    return this.current !== null && this.particleBox.visible
  }

  /** 定期更新が動いているか（テスト・検証用）。 */
  isRunning(): boolean {
    return this.timer !== null
  }

  private arm(next: WeatherState): void {
    const sameKind = this.current?.kind === next.kind
    this.stopTimer()
    this.current = next
    if (!sameKind) {
      this.destroySprites()
      this.params = []
    }
    this.resizePool(next)
    this.startMs = this.time.now()
    this.timer = this.time.setInterval(() => this.updateFrame(), WEATHER_FRAME_MS)
    this.updateFrame()
  }

  /** 粒の数を強さに合わせる。足りなければ作り、余れば破棄する（既存の粒は使い回す）。 */
  private resizePool(state: WeatherState): void {
    const n = weatherParticleCount(state.kind, state.intensity)
    while (this.sprites.length > n) {
      const g = this.sprites.pop()!
      g.removeFromParent()
      g.destroy()
      this.params.pop()
    }
    while (this.sprites.length < n) {
      const i = this.sprites.length
      const g = new Graphics()
      drawParticleShape(g, state.kind)
      this.particleBox.addChild(g)
      this.sprites.push(g)
      this.params.push(createWeatherParticleParams(state.kind, i))
    }
  }

  private destroySprites(): void {
    for (const g of this.sprites) {
      g.removeFromParent()
      g.destroy()
    }
    this.sprites = []
  }

  private stopTimer(): void {
    if (this.timer === null) return
    this.time.clearInterval(this.timer)
    this.timer = null
  }

  /** 現在時刻から全粒の位置を再計算して反映する。reduced-motion のときは隠して計算しない。 */
  private updateFrame(): void {
    const cur = this.current
    if (!cur) return
    const hidden = !this.exporting && prefersReducedMotion()
    this.particleBox.visible = !hidden
    if (hidden) return
    const elapsed = this.time.now() - this.startMs
    const f = this.frame
    for (let i = 0; i < this.sprites.length; i++) {
      evaluateWeatherParticle(
        cur.kind,
        this.params[i],
        elapsed,
        this.screenWidth,
        this.screenHeight,
        f
      )
      const g = this.sprites[i]
      g.position.set(f.x, f.y)
      g.rotation = f.rotation
      g.scale.set(f.scale)
      g.alpha = f.alpha
    }
  }

  /** 破棄時。タイマーと粒を片付ける。 */
  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    this.clear()
    super.destroy(options)
  }
}
