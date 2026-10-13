/**
 * アクリルスタンド風の「透明な余白＋枠線」フィルタ (#737)。
 *
 * 紙人形輪郭（#699、`outlineFilter.ts`）は立ち絵の周りを白で塗る。こちらは逆で、スプライトの
 * 輪郭を外側へ `marginPx` だけ広げた領域は**透明のまま**（背景が見える）にし、その外側 `linePx` 幅の
 * リングだけを線色で描く。スプライト本体の色はそのまま通す。
 *
 *   ring = dilate(margin + line) − dilate(margin)   （dilate = 周囲 alpha の最大値）
 *
 * 太さは論理 px で指定する。フィルタ内部のテクスチャは解像度（`input.source.resolution`）倍の
 * 実 px なので、`apply()` でその倍率を掛けて換算する（高 DPR でも線が細くならない）。
 * `resolution: 'inherit'` でレンダラの解像度に合わせ、`padding` に余白＋線ぶんを取って切れないようにする。
 *
 * 周囲サンプリングは「余白の縁の円」と「余白+線の縁の円」を方向ごとに数段ずつ（段数・方向数は半径から
 * `computeEdgeSampling` が決め、1 ピクセルあたり 48 タップ以下）。内側と外側は同じ方向の sin/cos を共有する。
 * シェーダ・uniform の組み立ては pixi-filters の OutlineFilter（WebGL 経路）を手本にした。
 * WebGL 専用（GlProgram のみ）。レンダラは WebGL を優先して選ばれる（pixi.js v8 の既定順）。
 */
import {
  Color,
  Filter,
  GlProgram,
  defaultFilterVert,
  type ColorSource,
  type FilterSystem,
  type RenderSurface,
  type Texture,
} from 'pixi.js'
import { computeEdgeSampling } from './spriteStyle'

export const ACRYLIC_EDGE_FRAGMENT = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform vec2 uRadii;
uniform vec3 uRings;
uniform vec3 uColor;
uniform float uAlpha;
uniform vec4 uInputClamp;

const float TAU = 6.28318530718;
const int MAX_DIRS = 16;
const int MAX_IN = 2;
const int MAX_OUT = 2;

float alphaAt(vec2 offsetTexel) {
  vec2 p = vTextureCoord + offsetTexel * uTexel;
  return texture(uTexture, clamp(p, uInputClamp.xy, uInputClamp.zw)).a;
}

void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  float inner = src.a;
  float outer = src.a;
  float marginR = uRadii.x;
  float reachR = uRadii.y;
  for (int i = 0; i < MAX_DIRS; i++) {
    if (float(i) >= uRings.z) break;
    float a = float(i) * TAU / uRings.z;
    vec2 dir = vec2(cos(a), sin(a));
    for (int k = 1; k <= MAX_IN; k++) {
      if (float(k) > uRings.x) break;
      inner = max(inner, alphaAt(dir * (marginR * float(k) / uRings.x)));
    }
    for (int k = 1; k <= MAX_OUT; k++) {
      if (float(k) > uRings.y) break;
      outer = max(outer, alphaAt(dir * (marginR + (reachR - marginR) * float(k) / uRings.y)));
    }
  }
  outer = max(outer, inner);
  float lineA = uAlpha * outer * (1.0 - inner) * (1.0 - src.a);
  finalColor = src + vec4(uColor * lineA, lineA);
}
`

export interface AcrylicEdgeFilterOptions {
  /** 透明な余白の幅（論理 px） */
  marginPx: number
  /** 枠線の太さ（論理 px。余白の外側に付く） */
  linePx: number
  /** 線の色 */
  color: ColorSource
  /** 線の不透明度（0〜1） */
  alpha: number
}

interface AcrylicUniforms {
  uTexel: Float32Array
  uRadii: Float32Array
  uRings: Float32Array
  uColor: Float32Array
  uAlpha: number
}

export class AcrylicEdgeFilter extends Filter {
  private uniforms: AcrylicUniforms
  private marginPx = 0
  private linePx = 0

  constructor(options: AcrylicEdgeFilterOptions) {
    const glProgram = GlProgram.from({
      vertex: defaultFilterVert,
      fragment: ACRYLIC_EDGE_FRAGMENT,
      name: 'acrylic-edge-filter',
    })
    super({
      glProgram,
      resolution: 'inherit',
      resources: {
        acrylicUniforms: {
          uTexel: { value: new Float32Array(2), type: 'vec2<f32>' },
          uRadii: { value: new Float32Array(2), type: 'vec2<f32>' },
          uRings: { value: new Float32Array(3), type: 'vec3<f32>' },
          uColor: { value: new Float32Array(3), type: 'vec3<f32>' },
          uAlpha: { value: options.alpha, type: 'f32' },
        },
      },
    })
    this.uniforms = (
      this.resources as { acrylicUniforms: { uniforms: AcrylicUniforms } }
    ).acrylicUniforms.uniforms
    const [r, g, b] = new Color(options.color).toArray()
    this.uniforms.uColor[0] = r
    this.uniforms.uColor[1] = g
    this.uniforms.uColor[2] = b
    this.uniforms.uAlpha = options.alpha
    this.setWidths(options.marginPx, options.linePx)
  }

  /** 余白と線の太さ（論理 px）を更新する。padding も追従させる（再生成はしない） */
  setWidths(marginPx: number, linePx: number): void {
    this.marginPx = Math.max(0, marginPx)
    this.linePx = Math.max(0, linePx)
    this.padding = Math.ceil(this.marginPx + this.linePx) + 1
  }

  override apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean
  ): void {
    const res = input.source.resolution || 1
    this.uniforms.uTexel[0] = 1 / input.source.width
    this.uniforms.uTexel[1] = 1 / input.source.height
    this.uniforms.uRadii[0] = this.marginPx * res
    this.uniforms.uRadii[1] = (this.marginPx + this.linePx) * res
    const s = computeEdgeSampling(this.uniforms.uRadii[0], this.uniforms.uRadii[1])
    this.uniforms.uRings[0] = s.innerRings
    this.uniforms.uRings[1] = s.outerRings
    this.uniforms.uRings[2] = s.directions
    filterManager.applyFilter(this, input, output, clearMode)
  }
}
