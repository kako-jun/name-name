/**
 * 背景ぼかし（#753）の縦グラデーション・マスクテクスチャの共有キャッシュ (#745)。
 *
 * マスクの TextureSource を destroy してはならない: Pixi はマスク用フィルタ（AlphaMaskEffect）を全画面で共有する
 * プールに戻して使い回す。プール内のフィルタは直前に使ったマスクの source を束ねたままで、その source を壊すと
 * 束縛が連鎖的に破棄され、次に作る画面（画面サイズ切替で BattleScreen を作り直す）の描画中に
 * `Cannot read properties of null (reading '0')` で落ちる。
 * そこで立ち上がり割合を量子化した値ごとに 1 枚だけ作って画面間で共有し、壊さない（1 x 小さな高さの画像で、種類は有限）。
 */
import type { Texture } from 'pixi.js'

/** 立ち上がり割合の量子化の刻み（これ未満の違いは同じ絵にする） */
export const DOF_MASK_RAMP_STEP = 0.01

/** 立ち上がり割合を刻みに丸める（キャッシュのキーと、絵を描くときの値に共通で使う） */
export function quantizeDofRamp(ramp: number): number {
  return Math.round(ramp / DOF_MASK_RAMP_STEP) * DOF_MASK_RAMP_STEP
}

const cache = new Map<number, Texture>()

/** 量子化した割合の共有テクスチャを返す。無ければ `build`（量子化後の割合を受ける）で作る。作れなかった（null）ときは覚えない */
export function getSharedDofMask(
  ramp: number,
  build: (quantizedRamp: number) => Texture | null
): Texture | null {
  const q = quantizeDofRamp(ramp)
  const key = Math.round(q / DOF_MASK_RAMP_STEP)
  const hit = cache.get(key)
  if (hit) return hit
  const tex = build(q)
  if (tex) cache.set(key, tex)
  return tex
}

/** テスト用: キャッシュを空にする（テクスチャは壊さない） */
export function resetSharedDofMasksForTest(): void {
  cache.clear()
}
