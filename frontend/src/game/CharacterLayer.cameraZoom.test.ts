/**
 * CharacterLayer の zoom × split_layout 合成 (#702)。
 * 合成式: p' = z.s * (split.s * p + split.t) + z.t（ズームが外側、split が内側）。
 */
import { describe, expect, it } from 'vitest'
import { CharacterLayer, computeCharacterLayerSplitTransform } from './CharacterLayer'

const REGION = { x: 400, y: 0, width: 400, height: 450 }
const Z = { scale: 2, x: -120, y: -60 }
const IDENT = { scale: 1, x: 0, y: 0 }

function layer() {
  return new CharacterLayer(800, 450)
}

describe('CharacterLayer zoom × split_layout (#702)', () => {
  it('60: identity ズーム + split 無し = 従来と同一（scale 1・原点）', () => {
    const l = layer()
    l.setZoomPose(IDENT)
    expect([l.scale.x, l.scale.y, l.position.x, l.position.y]).toEqual([1, 1, 0, 0])
  })

  it('60: identity ズーム + split 有 = split のみ', () => {
    const l = layer()
    l.setSplitLayoutRegion(REGION)
    l.setZoomPose(IDENT)
    const t = computeCharacterLayerSplitTransform(800, 450, REGION)
    expect(l.scale.x).toBeCloseTo(t.scale, 9)
    expect(l.position.x).toBeCloseTo(t.x, 9)
    expect(l.position.y).toBeCloseTo(t.y, 9)
  })

  it('61: ズーム有 + split 無し = z.s / z.t', () => {
    const l = layer()
    l.setZoomPose(Z)
    expect([l.scale.x, l.scale.y, l.position.x, l.position.y]).toEqual([2, 2, -120, -60])
  })

  it('62: ズーム有 + split 有 = z.s*split.s / z.s*split.t + z.t', () => {
    const l = layer()
    l.setSplitLayoutRegion(REGION)
    l.setZoomPose(Z)
    const t = computeCharacterLayerSplitTransform(800, 450, REGION)
    expect(l.scale.x).toBeCloseTo(Z.scale * t.scale, 9)
    expect(l.scale.y).toBeCloseTo(Z.scale * t.scale, 9)
    expect(l.position.x).toBeCloseTo(Z.scale * t.x + Z.x, 9)
    expect(l.position.y).toBeCloseTo(Z.scale * t.y + Z.y, 9)
  })

  it('63: 適用順（split→zoom と zoom→split）で結果が同じ', () => {
    const a = layer()
    a.setSplitLayoutRegion(REGION)
    a.setZoomPose(Z)
    const b = layer()
    b.setZoomPose(Z)
    b.setSplitLayoutRegion(REGION)
    expect([b.scale.x, b.scale.y, b.position.x, b.position.y]).toEqual([
      a.scale.x,
      a.scale.y,
      a.position.x,
      a.position.y,
    ])
  })

  it('63: setSplitLayoutRegion(null) でズームのみ維持される', () => {
    const l = layer()
    l.setSplitLayoutRegion(REGION)
    l.setZoomPose(Z)
    l.setSplitLayoutRegion(null)
    expect([l.scale.x, l.position.x, l.position.y]).toEqual([2, -120, -60])
    expect(l.getSplitLayoutRegion()).toBeNull()
  })

  it('63: ズームを identity に戻すと split のみに戻る（逆方向）', () => {
    const l = layer()
    l.setSplitLayoutRegion(REGION)
    l.setZoomPose(Z)
    l.setZoomPose(IDENT)
    const t = computeCharacterLayerSplitTransform(800, 450, REGION)
    expect(l.scale.x).toBeCloseTo(t.scale, 9)
    expect(l.position.x).toBeCloseTo(t.x, 9)
  })

  it('点の写像: ローカル点 p は split→zoom の順で画面座標へ写る（合成式の実測）', () => {
    const l = layer()
    l.setSplitLayoutRegion(REGION)
    l.setZoomPose(Z)
    const t = computeCharacterLayerSplitTransform(800, 450, REGION)
    const p = { x: 100, y: 200 }
    const expectX = Z.scale * (t.scale * p.x + t.x) + Z.x
    const expectY = Z.scale * (t.scale * p.y + t.y) + Z.y
    expect(l.scale.x * p.x + l.position.x).toBeCloseTo(expectX, 9)
    expect(l.scale.y * p.y + l.position.y).toBeCloseTo(expectY, 9)
  })
})

describe('CharacterLayer.getZoomFocus (#702)', () => {
  function withState(
    l: CharacterLayer,
    name: string,
    sprite: { x: number; y: number; height: number }
  ) {
    ;(l as unknown as { characters: Map<string, unknown> }).characters.set(name, { sprite })
  }

  it('未登場・テクスチャ未読み込み（高さ 0）は null、読み込み後は体の中心', () => {
    const l = layer()
    expect(l.getZoomFocus('A')).toBeNull()
    withState(l, 'A', { x: 10, y: 100, height: 0 })
    expect(l.getZoomFocus('A')).toBeNull()
    withState(l, 'A', { x: 10, y: 100, height: 60 })
    expect(l.getZoomFocus('A')).toEqual({ x: 10, y: 70 })
  })
})
