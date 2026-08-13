/**
 * ビネットフィルタ (#582)。画面（イベント絵）周辺部の光量を落とす、pixi.js v8 の
 * カスタムフィルタ authoring パターン（`Filter` + `GlProgram`/`GpuProgram`）で実装した
 * 自前シェーダ。`pixi-filters` パッケージ（#582 で新規依存追加）には vignette 相当のフィルタが
 * 無い（`SimpleLightmapFilter` は `filterArea` 手当てが必要な legacy 実装で、素の
 * radial darkening 用途には過剰）ため、同パッケージ内の各フィルタ（`GrayscaleFilter`/
 * `AdjustmentFilter` 等）と同じ構造で自作する。
 *
 * 頂点シェーダは PixiJS フィルタ共通のパススルー実装（`pixi-filters` 内部の
 * `defaults/default2`（GLSL）/`defaults/default`（WGSL）と同一内容）。この2つは
 * `pixi-filters` の型定義（`index.d.ts`）からは export されておらず import できないため
 * （実行時の `index.mjs` にだけ裏口 export がある）、ここでは同一内容をインライン定義する。
 */
import { Filter, GlProgram, GpuProgram } from 'pixi.js'

const vertex = `in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;

    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`

const wgslVertex = `struct GlobalFilterUniforms {
  uInputSize:vec4<f32>,
  uInputPixel:vec4<f32>,
  uInputClamp:vec4<f32>,
  uOutputFrame:vec4<f32>,
  uGlobalFrame:vec4<f32>,
  uOutputTexture:vec4<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv : vec2<f32>
  };

fn filterVertexPosition(aPosition:vec2<f32>) -> vec4<f32>
{
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;

    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord( aPosition:vec2<f32> ) -> vec2<f32>
{
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(
  @location(0) aPosition : vec2<f32>,
) -> VSOutput {
  return VSOutput(
   filterVertexPosition(aPosition),
   filterTextureCoord(aPosition)
  );
}`

const fragment = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uIntensity;
uniform float uInnerRadius;
uniform float uOuterRadius;

void main()
{
    vec4 c = texture(uTexture, vTextureCoord);
    float dist = distance(vTextureCoord, vec2(0.5, 0.5));
    float vig = smoothstep(uInnerRadius, uOuterRadius, dist);
    float factor = 1.0 - vig * uIntensity;
    finalColor = vec4(c.rgb * factor, c.a);
}
`

const wgslFragment = `struct VignetteUniforms {
  uIntensity: f32,
  uInnerRadius: f32,
  uOuterRadius: f32,
};

@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> vignetteUniforms : VignetteUniforms;

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @builtin(position) position: vec4<f32>
) -> @location(0) vec4<f32> {
  var sample = textureSample(uTexture, uSampler, uv);
  let d = distance(uv, vec2<f32>(0.5, 0.5));
  let vig = smoothstep(vignetteUniforms.uInnerRadius, vignetteUniforms.uOuterRadius, d);
  let factor = 1.0 - vig * vignetteUniforms.uIntensity;
  return vec4<f32>(sample.rgb * factor, sample.a);
}
`

export interface VignetteFilterOptions {
  /** 最も暗くなる縁での減光率（0=無効、1=縁が真っ黒）。既定 0.55（moderate、#316 の方針を踏襲） */
  intensity?: number
  /** この距離（中心からの正規化距離、0〜0.707）までは無減光。既定 0.35 */
  innerRadius?: number
  /** この距離で最大減光に達する。既定 0.88 */
  outerRadius?: number
}

/**
 * Gymnasia の「暗闇+オレンジ色のろうそく光+ゆらぎ+ビネット」ルック向けビネットフィルタ (#582)。
 * 中心からの距離に応じて RGB を減光する。暖色 tint は乗せない（#316 で「背景まで色被りする」
 * ため NG と確定済み — 本フィルタは純粋な明度減衰のみ）。
 */
export class VignetteFilter extends Filter {
  constructor(options: VignetteFilterOptions = {}) {
    const { intensity = 0.55, innerRadius = 0.35, outerRadius = 0.88 } = options
    const gpuProgram = GpuProgram.from({
      vertex: { source: wgslVertex, entryPoint: 'mainVertex' },
      fragment: { source: wgslFragment, entryPoint: 'mainFragment' },
    })
    const glProgram = GlProgram.from({
      vertex,
      fragment,
      name: 'name-name-vignette-filter',
    })
    super({
      gpuProgram,
      glProgram,
      resources: {
        vignetteUniforms: {
          uIntensity: { value: intensity, type: 'f32' },
          uInnerRadius: { value: innerRadius, type: 'f32' },
          uOuterRadius: { value: outerRadius, type: 'f32' },
        },
      },
    })
  }
}
