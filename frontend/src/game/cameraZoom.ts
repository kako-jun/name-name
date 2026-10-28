/**
 * シアターモードのカメラズーム (#702)。
 *
 * 純粋関数 `computeZoomPose` と、それを複数レイヤー（背景板・立ち絵・スポットライト・大道具）の
 * `Container` の scale/position へ反映する `CameraZoomController` から成る。2D のスケール＋パンだけで
 * 実装する（別レンダラは入れない、#700）。
 *
 * 決定論（ADR 0002）: 保持する状態は `{ target, strength }`（宣言的な settled state）だけ。
 * 演出途中のポーズ（寄っている最中）は保存しない。通常再生では `TWEEN_MS` かけて寄り/戻りを
 * 補間するが、スキップ・セーブ復元・シーク・リセットでは `snap` で最終ポーズへ即時スナップする。
 */
import type { Container } from 'pixi.js'
import type { CameraMode, CameraZoom } from '../types'
import type { TimeController } from './TimeController'

/** `強さ:` 省略時の拡大倍率。 */
export const DEFAULT_ZOOM_STRENGTH = 1.6
/** 拡大倍率の下限（1 = 全景と同じ）。 */
export const MIN_ZOOM_STRENGTH = 1
/** 拡大倍率の上限。 */
export const MAX_ZOOM_STRENGTH = 4
/** 寄り/戻りの補間時間 (ms)。 */
export const ZOOM_TWEEN_MS = 450
/** 対象キャラが現れないまま経つと警告を出す時間 (ms)。ズームしてからキャラを登場させる書き方で警告が出ないよう猶予を持たせる。 */
export const ZOOM_MISSING_WARN_MS = 2000

export interface ZoomPose {
  scale: number
  x: number
  y: number
}

export const IDENTITY_ZOOM_POSE: ZoomPose = { scale: 1, x: 0, y: 0 }

/** `strength` を [MIN, MAX] にクランプする。null/NaN/非有限は既定倍率。 */
export function resolveZoomStrength(strength: number | null | undefined): number {
  if (strength == null || !Number.isFinite(strength)) return DEFAULT_ZOOM_STRENGTH
  return Math.min(MAX_ZOOM_STRENGTH, Math.max(MIN_ZOOM_STRENGTH, strength))
}

/**
 * ズーム状態とフォーカス点（レイヤーのローカル座標）から、レイヤー Container に適用する
 * scale/position を求める純粋関数。
 *
 * - `mode !== 'Theater'`、`zoom` が null、`focus` が null（対象キャラが居ない）→ 全景（identity）
 * - フォーカス点を画面中心へ寄せる。拡大後に画面外の空白が出ないよう、平行移動は
 *   `[screen - screen*scale, 0]` にクランプする（端のキャラに寄っても背景の外側は映らない）。
 */
export function computeZoomPose(
  mode: CameraMode,
  zoom: CameraZoom | null,
  focus: { x: number; y: number } | null,
  screenWidth: number,
  screenHeight: number
): ZoomPose {
  if (mode !== 'Theater' || !zoom || !focus) return IDENTITY_ZOOM_POSE
  const scale = resolveZoomStrength(zoom.strength)
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
  const x = clamp(screenWidth / 2 - focus.x * scale, screenWidth - screenWidth * scale, 0)
  const y = clamp(screenHeight / 2 - focus.y * scale, screenHeight - screenHeight * scale, 0)
  return { scale, x, y }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** easeOutCubic */
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export interface CameraZoomHost {
  /** ズームを掛けるレイヤー（背景板・スポットライト・大道具）。立ち絵は `applyCharacterPose` 経由。 */
  getLayers(): Container[]
  /** 立ち絵レイヤーへのポーズ適用。 */
  applyCharacterPose(pose: ZoomPose): void
  /** 対象キャラの現在位置（レイヤーのローカル座標）。居なければ null。 */
  getFocus(target: string): { x: number; y: number } | null
  getScreenSize(): { width: number; height: number }
  /**
   * split_layout (#442) が有効か。有効なときズームは無効（常に全景）。立ち絵レイヤーが領域内へ
   * 縮小されるのでフォーカス座標とテキスト領域の扱いが成立しないため。
   */
  isSplitLayoutActive(): boolean
  /** スキップ中か。スキップ中は登場・退場でも補間せず即時に最終ポーズへ切り替える。 */
  isSkipMode(): boolean
}

function samePose(a: ZoomPose, b: ZoomPose): boolean {
  return a.scale === b.scale && a.x === b.x && a.y === b.y
}

/**
 * 現在のズーム状態に追従してレイヤーの変換を更新する。ズーム中は 16ms 間隔の ticker で
 * フォーカス点を問い合わせ直す（歩行中・後から登場したキャラにも追従する）。全景に戻り補間が
 * 終わったら ticker を止める。対象キャラの登場・退場（フォーカスの有無の切り替わり）では現在の
 * ポーズから補間し直す（飛ばない）。split_layout 有効中は常に全景（警告は1回）。
 */
export class CameraZoomController {
  private mode: CameraMode = 'Novel'
  private zoom: CameraZoom | null = null
  private current: ZoomPose = IDENTITY_ZOOM_POSE
  private tweenFrom: ZoomPose = IDENTITY_ZOOM_POSE
  private tweenStart = 0
  private tweening = false
  private tickerId: number | null = null
  private hadFocus = false
  private missingSince: number | null = null
  private warnedTarget: string | null = null
  private warnedSplit = false
  private disposed = false
  private suppressed = false

  constructor(
    private readonly host: CameraZoomHost,
    private readonly time: TimeController
  ) {}

  /** 現在の宣言的ズーム状態。 */
  getZoom(): CameraZoom | null {
    return this.mode === 'Theater' ? this.zoom : null
  }

  /** 現在適用中のポーズ（テスト・検証用）。 */
  getPose(): ZoomPose {
    return this.current
  }

  /**
   * ズーム状態を更新する。`snap: true`（スキップ・復元・リセット）は最終ポーズへ即時スナップ、
   * それ以外は `ZOOM_TWEEN_MS` で補間する。dispose 後は何もしない。
   */
  set(mode: CameraMode, zoom: CameraZoom | null, snap: boolean): void {
    if (this.disposed) return
    this.mode = mode
    this.zoom = mode === 'Theater' ? zoom : null
    this.warnedTarget = null
    this.missingSince = null
    if (this.zoom && this.host.isSplitLayoutActive() && !this.warnedSplit) {
      this.warnedSplit = true
      console.warn('[カメラ] split_layout が有効なためズームは無効です（全景のまま表示します）')
    }
    const target = this.targetPose()
    this.hadFocus = this.hasFocus()
    if (snap) {
      this.tweening = false
      this.apply(target)
    } else if (samePose(this.current, target)) {
      this.tweening = false
    } else {
      this.startTween()
    }
    if (this.zoom || this.tweening) this.ensureTicker()
    else this.stopTicker()
  }

  /**
   * 一時的にズームを無効にする（タイトル画面表示中など）。状態は保ったまま、切り替えは補間なしで
   * 即時に反映する。
   */
  setSuppressed(suppressed: boolean): void {
    if (this.disposed || this.suppressed === suppressed) return
    this.suppressed = suppressed
    this.tweening = false
    this.apply(this.targetPose())
  }

  /** ticker を破棄する（renderer destroy 用）。以後の `set` は無視される。 */
  dispose(): void {
    this.disposed = true
    this.stopTicker()
  }

  private startTween(): void {
    this.tweenFrom = this.current
    this.tweenStart = this.time.now()
    this.tweening = true
  }

  private hasFocus(): boolean {
    return !!this.zoom && this.host.getFocus(this.zoom.target) !== null
  }

  private targetPose(): ZoomPose {
    if (this.suppressed || this.host.isSplitLayoutActive()) return IDENTITY_ZOOM_POSE
    const { width, height } = this.host.getScreenSize()
    const focus = this.zoom ? this.host.getFocus(this.zoom.target) : null
    return computeZoomPose(this.mode, this.zoom, focus, width, height)
  }

  /** 対象が一定時間現れないままのときだけ警告する（同一対象につき1回）。 */
  private checkMissing(): void {
    const z = this.zoom
    if (!z || this.hadFocus) {
      this.missingSince = null
      return
    }
    const now = this.time.now()
    if (this.missingSince === null) this.missingSince = now
    if (this.warnedTarget !== z.target && now - this.missingSince >= ZOOM_MISSING_WARN_MS) {
      this.warnedTarget = z.target
      console.warn(
        `[カメラ] ズーム対象のキャラ「${z.target}」が表示されていないため全景のままにします`
      )
    }
  }

  private tick = (): void => {
    const focused = this.hasFocus()
    if (focused !== this.hadFocus) {
      // 登場・退場: 現在のポーズから補間し直す（飛ばない）。
      this.hadFocus = focused
      if (this.host.isSkipMode()) this.tweening = false
      else this.startTween()
    }
    this.checkMissing()
    const target = this.targetPose()
    if (this.tweening) {
      const t = Math.min(1, (this.time.now() - this.tweenStart) / ZOOM_TWEEN_MS)
      const e = ease(t)
      this.apply({
        scale: lerp(this.tweenFrom.scale, target.scale, e),
        x: lerp(this.tweenFrom.x, target.x, e),
        y: lerp(this.tweenFrom.y, target.y, e),
      })
      if (t >= 1) this.tweening = false
    } else {
      this.apply(target)
    }
    if (!this.zoom && !this.tweening) this.stopTicker()
  }

  private apply(pose: ZoomPose): void {
    if (samePose(pose, this.current)) return
    this.current = pose
    for (const layer of this.host.getLayers()) {
      layer.scale.set(pose.scale)
      layer.position.set(pose.x, pose.y)
    }
    this.host.applyCharacterPose(pose)
  }

  private ensureTicker(): void {
    if (this.tickerId != null) return
    this.tickerId = this.time.setInterval(this.tick, 16)
  }

  private stopTicker(): void {
    if (this.tickerId != null) {
      this.time.clearInterval(this.tickerId)
      this.tickerId = null
    }
  }
}
