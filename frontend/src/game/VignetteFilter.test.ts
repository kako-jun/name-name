/**
 * VignetteFilter（#582 イベント絵アンビエント演出のビネットフィルタ）の単体テスト。
 *
 * pixi.js v8 の `Filter`/`Shader` は WebGL/WebGPU コンテキストが無い jsdom でもコンストラクタ自体は
 * 例外を投げない（プログラムのコンパイルは実際の render 時まで遅延される）。uniforms への値の
 * 反映は `resources.<name>.uniforms.<key>` 経由で読める（`Shader._buildResourceAccessor` が
 * getter を生やす）。EventImageLayer.test.ts が既に `new VignetteFilter()` を経由して
 * jsdom で動くことを間接的に確認しているが、ここでは VignetteFilter 単体で uniforms の反映を直接検証する。
 */
import { describe, expect, it } from 'vitest'
import { VignetteFilter } from './VignetteFilter'

interface VignetteUniformsView {
  uIntensity: number
  uInnerRadius: number
  uOuterRadius: number
}

/** private な resources 経由で uniforms の現在値を読むための internals ビュー。 */
function readUniforms(filter: VignetteFilter): VignetteUniformsView {
  const resources = (
    filter as unknown as {
      resources: { vignetteUniforms: { uniforms: VignetteUniformsView } }
    }
  ).resources
  return resources.vignetteUniforms.uniforms
}

describe('VignetteFilter: 既定値', () => {
  it('options 未指定時、既定値 (intensity=0.55, innerRadius=0.35, outerRadius=0.88) が uniforms に反映される', () => {
    const filter = new VignetteFilter()
    const uniforms = readUniforms(filter)
    expect(uniforms.uIntensity).toBe(0.55)
    expect(uniforms.uInnerRadius).toBe(0.35)
    expect(uniforms.uOuterRadius).toBe(0.88)
  })
})

describe('VignetteFilter: カスタム options', () => {
  it('カスタム options が既定値を上書きして uniforms に反映される', () => {
    const filter = new VignetteFilter({ intensity: 0.8, innerRadius: 0.2, outerRadius: 0.95 })
    const uniforms = readUniforms(filter)
    expect(uniforms.uIntensity).toBe(0.8)
    expect(uniforms.uInnerRadius).toBe(0.2)
    expect(uniforms.uOuterRadius).toBe(0.95)
  })

  it('一部だけ指定した場合、指定した値だけ上書きされ他は既定値のまま', () => {
    const filter = new VignetteFilter({ intensity: 0.9 })
    const uniforms = readUniforms(filter)
    expect(uniforms.uIntensity).toBe(0.9)
    expect(uniforms.uInnerRadius).toBe(0.35)
    expect(uniforms.uOuterRadius).toBe(0.88)
  })
})

describe('VignetteFilter: jsdom 環境でのコンストラクタ', () => {
  it('WebGL/WebGPU コンテキストが無い jsdom でも例外を投げずに構築が完了する', () => {
    expect(() => new VignetteFilter()).not.toThrow()
  })
})
