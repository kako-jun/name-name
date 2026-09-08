/**
 * シアターモードのカメラ射影計算（純粋関数）。
 *
 * `raycastProjection.ts`（一人称レイキャスティングの NPC 射影）と同じ設計パターンに従い、
 * PixiJS などの描画層に依存しない pure computation として切り出す。
 *
 * #681 のスコープ: この関数はカメラモード（novel/theater）・向き・奥行きから描画スケールを
 * 求める計算だけを担う。背景板・キャラへの実際の depth 値付与とそれをこの関数に通す配線は
 * 別 Issue（#683）のスコープ。現状 depth を持つ実体がないため、本モジュールはテストでのみ
 * 検証する（docs/architecture.md「シアターモード構想」参照）。
 */

import { CameraMode, CameraOrientation } from '../types'

/**
 * シアターモードの奥行き→スケール変換で使う基準距離 (#681)。
 *
 * カメラから depth=0 の面までの仮想距離（depth と同じ任意単位）。値が大きいほど depth の
 * 変化に対する縮小が緩やかになる。実際の depth 値の尺度（#683 で背景板/キャラに付与される
 * 予定）はまだ確定していないため、暫定的に docs/architecture.md の背景板 depth 例
 * （`空.png: depth 10` が最奥）に合わせて 10 を基準に採る。テストはこの定数を参照し、
 * 計算結果を直書きしない（doctrine: テスト陳腐化の予防）。
 */
export const THEATER_CAMERA_REFERENCE_DEPTH = 10

export interface CameraProjection {
  /**
   * 描画スケール倍率。1 = 原寸（novel の既定動作、または theater で depth=0）。
   * 0 に近いほど縮小（奥）。負値・0 以下にはならない（漸近するのみ）。
   */
  scale: number
}

/**
 * カメラモード・向き・奥行きから描画スケールを求める純粋関数 (#681)。
 *
 * - `mode === 'Novel'`: 常に `{ scale: 1 }`（正投影・奥行きによる縮小なし、既存描画と完全
 *   一致・非回帰）。`orientation`/`depth` の値に関わらず無視する
 *   （ノベルモードにカメラの向き・奥行きの概念はない）。
 * - `mode === 'Theater'`: 透視投影として depth に応じて縮小する。
 *   `scale = THEATER_CAMERA_REFERENCE_DEPTH / (THEATER_CAMERA_REFERENCE_DEPTH + clampedDepth)`
 *   という単調減少の双曲線モデル（depth=0 で scale=1、depth が増えるほど 0 に漸近する）。
 *   `depth` は `Math.max(0, depth)` にクランプする（負値・`NaN`/`Infinity` はカメラ手前/
 *   不正入力として scale=1 側、すなわち depth=0 扱いにフォールバックする）。
 *
 * `orientation`（客席/舞台）は現時点では scale に影響しない。向き反転時の座標系
 * （演者の背中越しに客席を見る構図の depth 解釈）はまだ設計されていない（#683 のスコープ）。
 * シグネチャにだけ持たせておき、実際の座標変換は depth 配線と合わせて別 Issue で設計する。
 */
export function computeCameraProjection(
  mode: CameraMode,
  orientation: CameraOrientation,
  depth: number
): CameraProjection {
  // 現時点では scale に影響しないが、将来の向き反転対応でシグネチャを変えずに済むよう
  // 引数として受け取っておく（#683 で座標系を設計してから使用する）。
  void orientation

  if (mode === 'Novel') {
    return { scale: 1 }
  }

  const clampedDepth = Number.isFinite(depth) ? Math.max(0, depth) : 0
  return {
    scale: THEATER_CAMERA_REFERENCE_DEPTH / (THEATER_CAMERA_REFERENCE_DEPTH + clampedDepth),
  }
}
