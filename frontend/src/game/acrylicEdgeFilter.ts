/**
 * アクリルスタンド風の「透明な余白＋枠線」フィルタ (#737)。
 *
 * 紙人形輪郭（#699、`outlineFilter.ts`）は立ち絵の周りを白で塗る。こちらは逆で、スプライトの
 * 輪郭を外側へ `marginPx` だけ広げた領域は**透明のまま**（背景が見える）にし、その外側 `linePx` 幅の
 * リングだけを線色で描く。スプライト本体の色はそのまま通す。
 *
 *   ring = dilate(margin + line) − dilate(margin)   （dilate = 周囲 alpha の最大値）
 *
 * 単位（DPR 換算）:
 * - `marginPx` / `linePx` / `padding` は**論理 px**。pixi.js 8 のフィルタ入力テクスチャは
 *   `source.width` が論理幅、`source.pixelWidth` が実ピクセル幅（= 論理幅 × resolution）。
 * - サンプルの変位は `computeEdgeOffsets(margin, line, resolution)` が**実 px**で返す（配置は論理 px で決め、
 *   resolution 倍して実 px にする）。シェーダは変位に `uTexel = 1 / pixelWidth` を掛けて UV にする。
 *   よって UV 上の変位は論理 px で見て `margin + line` ぴったりになり、resolution に依存しない。
 *   `padding`（論理 px）はその到達距離を囲むので、リングがフィルタ矩形の外へはみ出して切れることもない。
 * - `resolution: 'inherit'` でレンダラの解像度に合わせる。
 *
 * サンプリング配置（間隔・角度のずらし・範囲）はすべて純粋関数 `computeEdgeOffsets`（spriteStyle.ts）が決め、
 * シェーダは「内側の列と外側の列の alpha の最大値」を取って合成するだけにしてある（配置をテストできるように）。
 * シェーダ・uniform の組み立ては pixi-filters の OutlineFilter（WebGL 経路）と MultiColorReplaceFilter（配列 uniform）を手本にした。
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
import {
  EDGE_MAX_INNER_TAPS,
  EDGE_MAX_OUTER_TAPS,
  computeEdgeOffsets,
  type EdgeOffset,
} from './spriteStyle'

export const ACRYLIC_EDGE_FRAGMENT = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform vec2 uCounts;
uniform vec2 uInner[${EDGE_MAX_INNER_TAPS}];
uniform vec2 uOuter[${EDGE_MAX_OUTER_TAPS}];
uniform vec3 uColor;
uniform float uAlpha;
uniform vec4 uInputClamp;

const int MAX_INNER = ${EDGE_MAX_INNER_TAPS};
const int MAX_OUTER = ${EDGE_MAX_OUTER_TAPS};

// 変位は実ピクセル。uTexel(= 1/pixelWidth, 1/pixelHeight) を掛けて UV にする
float alphaAt(vec2 offsetPx) {
  vec2 p = vTextureCoord + offsetPx * uTexel;
  return texture(uTexture, clamp(p, uInputClamp.xy, uInputClamp.zw)).a;
}

void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  // innerMax: 余白の内側に本体があるか。outerMax: 余白+線の範囲に本体があるか（本体自身も含む）
  float innerMax = src.a;
  float outerMax = src.a;
  for (int i = 0; i < MAX_INNER; i++) {
    if (float(i) >= uCounts.x) break;
    innerMax = max(innerMax, alphaAt(uInner[i]));
  }
  for (int i = 0; i < MAX_OUTER; i++) {
    if (float(i) >= uCounts.y) break;
    outerMax = max(outerMax, alphaAt(uOuter[i]));
  }
  outerMax = max(outerMax, innerMax);
  // ring = clamp(outerMax - innerMax, 0, 1)。余白の内側（innerMax が高い）では 0 = 透明のまま
  float ring = clamp(outerMax - innerMax, 0.0, 1.0);
  // 本体の不透明なところ・半透明の縁には線を重ねない（本体を上書きしない）
  float lineA = uAlpha * ring * (1.0 - src.a);
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
  uCounts: Float32Array
  uInner: Float32Array
  uOuter: Float32Array
  uColor: Float32Array
  uAlpha: number
}

/** 変位列を uniform 配列へ書く。使わない末尾は 0 に戻す（counts で打ち切るので影響はない） */
function writeOffsets(dst: Float32Array, offsets: readonly EdgeOffset[]): void {
  dst.fill(0)
  for (let i = 0; i < offsets.length; i++) {
    dst[i * 2] = offsets[i][0]
    dst[i * 2 + 1] = offsets[i][1]
  }
}

export class AcrylicEdgeFilter extends Filter {
  private uniforms: AcrylicUniforms
  private marginPx = 0
  private linePx = 0
  /** 前回 uniform を組んだときの入力。変わらない間は配列を作り直さない（毎フレーム生成しない） */
  private sampledKey = { margin: -1, line: -1, res: -1 }

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
          uCounts: { value: new Float32Array(2), type: 'vec2<f32>' },
          uInner: {
            value: new Float32Array(2 * EDGE_MAX_INNER_TAPS),
            type: 'vec2<f32>',
            size: EDGE_MAX_INNER_TAPS,
          },
          uOuter: {
            value: new Float32Array(2 * EDGE_MAX_OUTER_TAPS),
            type: 'vec2<f32>',
            size: EDGE_MAX_OUTER_TAPS,
          },
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
    // 論理幅 `source.width` ではなく実ピクセル幅で割る（変位は実 px。上のファイル先頭コメント参照）
    this.uniforms.uTexel[0] = 1 / input.source.pixelWidth
    this.uniforms.uTexel[1] = 1 / input.source.pixelHeight
    const res = input.source.resolution || 1
    if (
      this.sampledKey.margin !== this.marginPx ||
      this.sampledKey.line !== this.linePx ||
      this.sampledKey.res !== res
    ) {
      this.sampledKey = { margin: this.marginPx, line: this.linePx, res }
      const o = computeEdgeOffsets(this.marginPx, this.linePx, res)
      this.uniforms.uCounts[0] = o.inner.length
      this.uniforms.uCounts[1] = o.outer.length
      writeOffsets(this.uniforms.uInner, o.inner)
      writeOffsets(this.uniforms.uOuter, o.outer)
    }
    filterManager.applyFilter(this, input, output, clearMode)
  }
}
