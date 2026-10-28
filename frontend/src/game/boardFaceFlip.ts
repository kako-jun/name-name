/**
 * シアターモードの大道具・背景板の「面の切り替え」(#704)。旧い面が Y 軸回りに 0°→90° で消え、
 * 新しい面が -90°→0° で現れる（伝統的な「回転する大道具で裏面に切り替わる」演出）。
 *
 * 角度の数式は `boardFlip.ts`（#707 の立ち絵ポーズ変更）をそのまま使う。ここは
 * - 回転を出してよいか（シアター限定・スキップ/書き出し/動きを減らす設定では即時）の判定（純粋関数）
 * - 経過時間から旧面・新面それぞれの板の見え方（可視・四隅）を求める純粋関数
 * - 2 枚の `PerspectiveMesh` を持って毎フレーム更新する小さな実行体 `BoardFaceFlipRun`
 * を提供する。`BackgroundBoardLayer` / `PropLayer` が共有する。
 *
 * ADR 0002: 入力は経過時間だけ（`TimeController.now()` との差）。`Math.random` も実時計も使わない。
 * 回転途中の状態はレイヤーの settled state（`getState()`）に持たない。
 */
import { PerspectiveMesh, type Container, type Filter, type Texture } from 'pixi.js'
import { computeBoardFlipCorners, computeBoardFlipFrame, type BoardFlipCorners } from './boardFlip'

/** 回転を有効にする条件。 */
export interface BoardFaceFlipConditions {
  /** `[カメラ: シアター]` か。ノベルは常に即時切替（後方互換）。 */
  isTheater: boolean
  /** スキップ前進中か。最終状態へ即時。 */
  skip: boolean
  /** 動画書き出し中か (#350)。書き出し（実時間駆動）では回さない。 */
  exporting: boolean
  /** OS の `prefers-reduced-motion: reduce` か。 */
  reducedMotion: boolean
  /** 回転の所要時間（ms）。0 以下は回さない。 */
  durationMs: number
}

/** 回転で見せてよいか。シアターのみ、スキップ・書き出し・動きを減らす設定・時間 0 では即時切替。 */
export function isBoardFaceFlipEnabled(c: BoardFaceFlipConditions): boolean {
  if (!c.isTheater || c.skip || c.exporting || c.reducedMotion) return false
  return Number.isFinite(c.durationMs) && c.durationMs > 0
}

/** 板 1 面の配置（`anchor=0.5` の Sprite と同じ: 中心 x, y と幅・高さ）。 */
export interface BoardFaceGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** ある時点での 1 面の見え方。 */
export interface BoardFaceFrame {
  visible: boolean
  corners: BoardFlipCorners | null
}

/**
 * 経過時間から旧面（`out`）と新面（`in`）の見え方を求める。`elapsedMs >= totalMs` では
 * 旧面は不可視・新面は可視で角度 0（= 回転の終わり）。
 */
export function computeBoardFaceFlipFrames(
  elapsedMs: number,
  totalMs: number,
  oldFace: BoardFaceGeometry,
  newFace: BoardFaceGeometry
): { old: BoardFaceFrame; next: BoardFaceFrame } {
  const corners = (g: BoardFaceGeometry, angleRad: number): BoardFlipCorners =>
    computeBoardFlipCorners(g.x, g.y + g.height / 2, g.width, g.height, angleRad)
  const o = computeBoardFlipFrame('out', elapsedMs, totalMs)
  const n = computeBoardFlipFrame('in', elapsedMs, totalMs)
  return {
    old: { visible: o.visible, corners: o.visible ? corners(oldFace, o.angleRad) : null },
    next: { visible: n.visible, corners: n.visible ? corners(newFace, n.angleRad) : null },
  }
}

let reducedMotionQuery: MediaQueryList | null | undefined

/** OS の `prefers-reduced-motion: reduce` が有効か。matchMedia が無い環境（jsdom 等）は false。 */
export function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    try {
      reducedMotionQuery =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-motion: reduce)')
          : null
    } catch {
      reducedMotionQuery = null
    }
  }
  return reducedMotionQuery?.matches === true
}

/**
 * 進行中の 1 回の回転。旧面・新面の 2 枚の `PerspectiveMesh` を所有し、`update(nowMs)` で
 * 見え方を反映する。`dispose()` は mesh と geometry を破棄する（`mesh.destroy()` は geometry を
 * 破棄しないため）。
 */
export class BoardFaceFlipRun {
  readonly oldMesh: PerspectiveMesh
  readonly newMesh: PerspectiveMesh
  private disposed = false

  constructor(
    oldTexture: Texture,
    newTexture: Texture,
    private oldFace: BoardFaceGeometry,
    private newFace: BoardFaceGeometry,
    private readonly startMs: number,
    readonly durationMs: number
  ) {
    this.oldMesh = new PerspectiveMesh({ texture: oldTexture })
    this.newMesh = new PerspectiveMesh({ texture: newTexture })
  }

  /** 輪郭などのフィルタを両方の mesh に付ける。 */
  setFilters(filters: Filter[] | null): void {
    if (this.disposed) return
    this.oldMesh.filters = filters
    this.newMesh.filters = filters
  }

  /** 新面の配置が変わった（ロード完了後の再配置）ときに差し替える。 */
  setNewFace(face: BoardFaceGeometry): void {
    this.newFace = face
  }

  /** 終わったか（経過 >= 所要時間）。 */
  isFinished(nowMs: number): boolean {
    return nowMs - this.startMs >= this.durationMs
  }

  /** `parent` の子 index `index` から旧面・新面の順に mesh を挿入する。 */
  attach(parent: Container, index: number): void {
    parent.addChildAt(this.oldMesh, index)
    parent.addChildAt(this.newMesh, index + 1)
  }

  update(nowMs: number): void {
    if (this.disposed) return
    const f = computeBoardFaceFlipFrames(
      nowMs - this.startMs,
      this.durationMs,
      this.oldFace,
      this.newFace
    )
    this.oldMesh.visible = f.old.visible
    this.newMesh.visible = f.next.visible
    if (f.old.corners) {
      const c = f.old.corners
      this.oldMesh.setCorners(c.x0, c.y0, c.x1, c.y1, c.x2, c.y2, c.x3, c.y3)
    }
    if (f.next.corners) {
      const c = f.next.corners
      this.newMesh.setCorners(c.x0, c.y0, c.x1, c.y1, c.x2, c.y2, c.x3, c.y3)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const mesh of [this.oldMesh, this.newMesh]) {
      if (mesh.destroyed) continue
      const geometry = mesh.geometry
      mesh.removeFromParent()
      mesh.destroy()
      geometry.destroy()
    }
  }
}
