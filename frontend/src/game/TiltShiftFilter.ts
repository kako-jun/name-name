/**
 * チルトシフトフィルタ (#885)。フィールド最終合成の上下端を、行ごとの半径で 1 パスにぼかす自前シェーダ。
 * 半径の式は `tiltShift.ts` の `tiltShiftBlurRadius` と同じ（中心からの距離 |2y-1| を smoothstep）。
 * 頂点シェーダは `VignetteFilter.ts` と同じ PixiJS フィルタ共通のパススルー実装。
 *
 * フィルタの入力は filterArea（画面全体に固定する）。入力テクスチャが出力フレームより大きいことがあるので、
 * 縦位置は vTextureCoord ではなく「フレーム内の 0..1」（vTextureCoord / (uOutputFrame.zw * uInputSize.zw)）で取る。
 */
import { Filter, GlProgram, GpuProgram } from 'pixi.js'
import {
  TILT_SHIFT_DEFAULT_PARAMS,
  TILT_SHIFT_GOLDEN_ANGLE,
  TILT_SHIFT_SAMPLE_COUNT,
  clampFocusRatio,
  type TiltShiftParams,
} from './tiltShift'

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

const fragment = `precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform float uFocus;
uniform float uMaxBlur;

const int SAMPLES = ${TILT_SHIFT_SAMPLE_COUNT};
const float GOLDEN = ${TILT_SHIFT_GOLDEN_ANGLE};

void main()
{
    // 純関数 tiltShiftBlurRadius との差: radius < 0.05（サブピクセル）は等倍サンプルで早期 return する（純関数は微小な正の値を返す）
    // 入力テクスチャが出力フレームより大きいことがある（プールの丸め）ので、uv ではなくフレーム内の縦位置 0..1 で距離を取る
    vec2 frameSize = uOutputFrame.zw * uInputSize.zw;
    float d = abs(2.0 * (vTextureCoord.y / frameSize.y) - 1.0);
    float radius = uMaxBlur * smoothstep(uFocus, 1.0, d);
    if (radius < 0.05) {
        finalColor = texture(uTexture, vTextureCoord);
        return;
    }
    vec4 sum = vec4(0.0);
    for (int i = 0; i < SAMPLES; i++) {
        float r = sqrt((float(i) + 0.5) / float(SAMPLES));
        float a = float(i) * GOLDEN;
        vec2 off = vec2(cos(a), sin(a)) * r * radius * uInputSize.zw;
        sum += texture(uTexture, clamp(vTextureCoord + off, 0.5 * uInputSize.zw, frameSize - 0.5 * uInputSize.zw));
    }
    finalColor = sum / float(SAMPLES);
}
`

const wgslFragment = `struct GlobalFilterUniforms {
  uInputSize:vec4<f32>,
  uInputPixel:vec4<f32>,
  uInputClamp:vec4<f32>,
  uOutputFrame:vec4<f32>,
  uGlobalFrame:vec4<f32>,
  uOutputTexture:vec4<f32>,
};
struct TiltUniforms {
  uFocus: f32,
  uMaxBlur: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> tilt : TiltUniforms;

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @builtin(position) position: vec4<f32>
) -> @location(0) vec4<f32> {
  let frameSize = gfu.uOutputFrame.zw * gfu.uInputSize.zw;
  let d = abs(2.0 * (uv.y / frameSize.y) - 1.0);
  let radius = tilt.uMaxBlur * smoothstep(tilt.uFocus, 1.0, d);
  if (radius < 0.05) {
    return textureSampleLevel(uTexture, uSampler, uv, 0.0);
  }
  var sum = vec4<f32>(0.0);
  let n = ${TILT_SHIFT_SAMPLE_COUNT};
  for (var i = 0; i < n; i++) {
    let r = sqrt((f32(i) + 0.5) / f32(n));
    let a = f32(i) * ${TILT_SHIFT_GOLDEN_ANGLE};
    let off = vec2<f32>(cos(a), sin(a)) * r * radius * gfu.uInputSize.zw;
    sum += textureSampleLevel(uTexture, uSampler, clamp(uv + off, 0.5 * gfu.uInputSize.zw, frameSize - 0.5 * gfu.uInputSize.zw), 0.0);
  }
  return sum / f32(n);
}
`

/** 画面全体（filterArea を画面に固定して使う）の上下端をぼかすフィルタ */
export class TiltShiftFilter extends Filter {
  constructor(params: TiltShiftParams = TILT_SHIFT_DEFAULT_PARAMS) {
    const gpuProgram = GpuProgram.from({
      vertex: { source: wgslVertex, entryPoint: 'mainVertex' },
      fragment: { source: wgslFragment, entryPoint: 'mainFragment' },
    })
    const glProgram = GlProgram.from({ vertex, fragment, name: 'name-name-tilt-shift-filter' })
    super({
      gpuProgram,
      glProgram,
      resources: {
        tiltUniforms: {
          uFocus: { value: clampFocusRatio(params.focusRatio), type: 'f32' },
          uMaxBlur: { value: params.maxBlurPx, type: 'f32' },
        },
      },
    })
    // フィルタ領域の端でカーネルが欠けないよう、最大半径ぶんの余白は取らず画面端はクランプで受ける
    this.padding = 0
  }
}
