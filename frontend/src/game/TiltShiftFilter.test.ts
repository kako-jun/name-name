/**
 * TiltShiftFilter (#885) の単体テスト。VignetteFilter.test.ts と同様、jsdom ではコンパイルされず
 * コンストラクタと uniforms の反映だけを検証する。
 */
import { describe, expect, it } from 'vitest'
import { TiltShiftFilter } from './TiltShiftFilter'
import {
  TILT_SHIFT_DEFAULT_PARAMS,
  TILT_SHIFT_GOLDEN_ANGLE,
  TILT_SHIFT_SAMPLE_COUNT,
} from './tiltShift'

interface TiltUniformsView {
  uFocus: number
  uMaxBlur: number
}
function readUniforms(filter: TiltShiftFilter): TiltUniformsView {
  return (filter as unknown as { resources: { tiltUniforms: { uniforms: TiltUniformsView } } })
    .resources.tiltUniforms.uniforms
}

describe('TiltShiftFilter (#885)', () => {
  it('既定パラメータが uniforms に反映され、padding は 0', () => {
    const f = new TiltShiftFilter()
    const u = readUniforms(f)
    expect(u.uFocus).toBe(TILT_SHIFT_DEFAULT_PARAMS.focusRatio)
    expect(u.uMaxBlur).toBe(TILT_SHIFT_DEFAULT_PARAMS.maxBlurPx)
    expect(f.padding).toBe(0)
  })
  it('カスタムパラメータが反映される', () => {
    const u = readUniforms(new TiltShiftFilter({ focusRatio: 0.2, maxBlurPx: 14 }))
    expect(u.uFocus).toBe(0.2)
    expect(u.uMaxBlur).toBe(14)
  })
  it('GLSL・WGSL のサンプル数が定数と一致する', () => {
    const f = new TiltShiftFilter() as unknown as {
      glProgram: { fragment: string }
      gpuProgram: { fragment: { source: string } }
    }
    expect(f.glProgram.fragment).toContain(`const int SAMPLES = ${TILT_SHIFT_SAMPLE_COUNT};`)
    expect(f.gpuProgram.fragment.source).toContain(`let n = ${TILT_SHIFT_SAMPLE_COUNT};`)
  })
  it('focusRatio は 0〜1 にクランプされて uniforms に入る（純関数と一致）', () => {
    expect(readUniforms(new TiltShiftFilter({ focusRatio: 3, maxBlurPx: 5 })).uFocus).toBe(1)
    expect(readUniforms(new TiltShiftFilter({ focusRatio: -3, maxBlurPx: 5 })).uFocus).toBe(0)
    expect(readUniforms(new TiltShiftFilter({ focusRatio: NaN, maxBlurPx: 5 })).uFocus).toBe(0)
  })
  it('GLSL・WGSL の黄金角が共有定数と一致し、WGSL は分岐内で暗黙微分のサンプルを使わない', () => {
    const f = new TiltShiftFilter() as unknown as {
      glProgram: { fragment: string }
      gpuProgram: { fragment: { source: string } }
    }
    expect(f.glProgram.fragment).toContain(`const float GOLDEN = ${TILT_SHIFT_GOLDEN_ANGLE};`)
    expect(f.gpuProgram.fragment.source).toContain(`f32(i) * ${TILT_SHIFT_GOLDEN_ANGLE}`)
    expect(f.gpuProgram.fragment.source).not.toMatch(/textureSample\(/)
  })
  it('縦位置は入力テクスチャの uv ではなくフレーム内 0..1 で取る（テクスチャがフレームより大きい場合の下端ぼけ欠落の回帰）', () => {
    const f = new TiltShiftFilter() as unknown as {
      glProgram: { fragment: string }
      gpuProgram: { fragment: { source: string } }
    }
    expect(f.glProgram.fragment).toContain('uOutputFrame.zw * uInputSize.zw')
    expect(f.glProgram.fragment).toContain('vTextureCoord.y / frameSize.y')
    expect(f.gpuProgram.fragment.source).toContain('gfu.uOutputFrame.zw * gfu.uInputSize.zw')
    expect(f.gpuProgram.fragment.source).toContain('uv.y / frameSize.y')
  })
})
