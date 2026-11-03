/**
 * TiltShiftFilter (#885) の単体テスト。VignetteFilter.test.ts と同様、jsdom ではコンパイルされず
 * コンストラクタと uniforms の反映だけを検証する。
 */
import { describe, expect, it } from 'vitest'
import { TiltShiftFilter } from './TiltShiftFilter'
import { TILT_SHIFT_DEFAULT_PARAMS, TILT_SHIFT_SAMPLE_COUNT } from './tiltShift'

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
})
