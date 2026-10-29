/**
 * アクリルスタンド風スタイル (#737・#760) の PixiJS 部品（台座・板・板の mask・地面の影）の生成と配置。
 *
 * 戦闘画面（BattleScreen）とフィールド（fieldSample）で同じ見た目を共有するため、BattleScreen から切り出した。
 * 幾何（どこに何を置くか）は純粋関数 `computeAcrylicGeometry`（spriteStyle.ts）が正本で、ここは結果を各パーツへ反映するだけ。
 * 部品の持ち主（戦闘の EntityView・フィールドの図形）は `AcrylicParts` のフィールドをそのまま持つ。
 */

import { Container, Graphics, Sprite, type Texture } from 'pixi.js'
import { computeSlitY } from './acrylicBase'
import { getAcrylicBaseTexture, type AcrylicBaseTexture } from './acrylicBaseTexture'
import { createAcrylicPlateTexture, type AcrylicPlate } from './acrylicPlateTexture'
import { computeShadowTransform } from './acrylicShadow'
import type { AcrylicGeometry, AcrylicParams } from './spriteStyle'

/** acrylic の台座の色 (#737)。黒に近い円形台座（透明台座のテクスチャが作れない環境の Graphics 描き） */
export const ACRYLIC_BASE_COLOR = 0x111111

/**
 * 1 体ぶんの acrylic 部品。フィールド名は BattleScreen の EntityView と共通（EntityView がこれを継承する）。
 */
export interface AcrylicParts {
  /** 台座・影を描く Graphics と、スプライトの直下に敷く板のスプライト (#760)。画像読み込み成功まで null/非表示。板は canvas が使えない環境では null */
  acrylicBack: Graphics | null
  acrylicPlate: Sprite | null
  /** 透明アクリルの台座・影のスプライト (#760)。canvas が使えない環境では null（acrylicBack の Graphics で描く） */
  acrylicBase: Sprite | null
  /** 地面に落とす本体の影 (#760)。板を作れない環境では null */
  acrylicShadow: Sprite | null
  acrylicShadowFoot: { x: number; y: number }
  /** 板テクスチャの 1px が元画像の何 px か（板は縮小した解像度で作る） */
  acrylicPlateScale: number
  /** 板テクスチャ上で元画像の左上がある位置(px)。配置時にこのぶん左上へずらす */
  acrylicPlatePad: number
  acrylicBaseLayout: AcrylicBaseTexture['layout'] | null
}

/** 部品が何も無い状態。`back` を渡すと台座・影の Graphics を持つ（画像の読み込み後に attachAcrylicLayers で埋める） */
export function emptyAcrylicParts(back: Graphics | null): AcrylicParts {
  return {
    acrylicBack: back,
    acrylicPlate: null,
    acrylicBase: null,
    acrylicShadow: null,
    acrylicShadowFoot: { x: 0, y: 0 },
    acrylicPlateScale: 1,
    acrylicPlatePad: 0,
    acrylicBaseLayout: null,
  }
}

/**
 * 同じ画像（tex.source 単位）の板・影は 1 回だけ作って共有する (#760)。同じ敵が複数いても生成と GPU メモリは 1 組。
 * 作れなかった（null）結果も覚えて、同じ画像で作り直さない。解放は destroy でまとめて行う。
 */
export class AcrylicPlateCache {
  private cache = new Map<unknown, AcrylicPlate | null>()

  constructor(private readonly make: (tex: Texture) => AcrylicPlate | null) {}

  get(tex: Texture): AcrylicPlate | null {
    const key = tex.source
    if (this.cache.has(key)) return this.cache.get(key) ?? null
    const plate = this.make(tex)
    this.cache.set(key, plate)
    return plate
  }

  /** 板・影のテクスチャは自前で作ったものなので、TextureSource ごと（GPU・canvas）解放する */
  destroy(): void {
    for (const plate of this.cache.values()) {
      plate?.texture.destroy(true)
      plate?.shadow?.destroy(true)
    }
    this.cache.clear()
  }
}

/** 既定の部品生成（共有キャッシュの台座・パラメータどおりの板） */
export function makeAcrylicBase(params: AcrylicParams): AcrylicBaseTexture | null {
  return getAcrylicBaseTexture(params)
}
export function makeAcrylicPlate(tex: Texture, params: AcrylicParams): AcrylicPlate | null {
  return createAcrylicPlateTexture(tex, params)
}

export interface AttachAcrylicLayersArgs {
  /** 部品を子として積む箱 */
  container: Container
  parts: AcrylicParts
  /** 板の元にするスプライトの絵 */
  tex: Texture
  /** `container` の何番目から積むか（それより下は呼び出し側の層。台座 → 板 → 板の mask の順に積む） */
  startIndex: number
  makeBase: () => AcrylicBaseTexture | null
  plateFor: (tex: Texture) => AcrylicPlate | null
  /** 地面の影を置く層。null なら影のスプライトは作らない */
  shadowLayer: Container | null
}

/**
 * 台座・板・板の mask・地面の影を作って `parts` に入れる (#760)。画像（tex）が読み込めた後に 1 回呼ぶ。
 * 板は長辺 192px の作業解像度で 1 回だけ作り（同じ画像は共有）、mipmap で拡縮してスプライトの直下に敷く。作れない環境では板なし。
 * 戻り値は板（作れなければ null）と、次に積める `container` の index（スプライト本体は呼び出し側がここへ積む）。
 */
export function attachAcrylicLayers(args: AttachAcrylicLayersArgs): {
  plate: AcrylicPlate | null
  nextIndex: number
} {
  const { container, parts, tex, makeBase, plateFor, shadowLayer } = args
  let idx = args.startIndex
  const base = makeBase()
  if (base) {
    parts.acrylicBase = new Sprite(base.texture)
    parts.acrylicBaseLayout = base.layout
    container.addChildAt(parts.acrylicBase, idx++)
  }
  const plate = plateFor(tex)
  if (plate) {
    const plateSprite = new Sprite(plate.texture)
    parts.acrylicPlate = plateSprite
    parts.acrylicPlatePad = plate.pad
    parts.acrylicPlateScale = plate.scale ?? 1
    if (plate.shadow && shadowLayer) {
      const sh = new Sprite(plate.shadow)
      parts.acrylicShadow = sh
      parts.acrylicShadowFoot = plate.foot ?? { x: 0, y: 0 }
      sh.pivot.set(parts.acrylicShadowFoot.x, parts.acrylicShadowFoot.y)
      shadowLayer.addChild(sh)
    }
    // 板を台座のスリットの高さで水平に切る mask (#760)。v8 では Sprite に子を足せないので、
    // 板の直後の兄弟として置く（座標は container と同じ）
    const mask = new Graphics()
    plateSprite.mask = mask
    container.addChildAt(plateSprite, idx++)
    container.addChildAt(mask, idx++)
  }
  return { plate, nextIndex: idx }
}

/**
 * 幾何 `g`（computeAcrylicGeometry の結果）を台座・板・mask・影の各パーツへ反映する (#737・#760)。
 * スプライト本体の位置・大きさは呼び出し側が置く（このなかでは触らない）。
 * - 台座: 共有テクスチャ（無ければ acrylicBack の Graphics）。
 * - 板: スプライトと同じ倍率（作業解像度ぶんを掛けて）で、pad ぶん外へ広げて敷く。台座のスリット（computeSlitY）で水平に切る mask を更新する。
 * - 影: 倍率・傾き・表示を更新する。**位置は置かない**（戻り値の足元を、呼び出し側が自分の座標系へ直して置く）。
 *   `mirrorShadow` は、影の親が左右反転しているとき true（反転しても影は光の向き＝右へ倒れたままにする）。
 * `texWidth` はスプライトの絵の幅（板の倍率の基準）。戻り値の足元 `foot` は、container 座標でのスプライト下端中央+浮き量。
 */
export function layoutAcrylicParts(
  parts: AcrylicParts,
  params: AcrylicParams,
  g: AcrylicGeometry,
  texWidth: number,
  mirrorShadow = false
): { foot: { x: number; y: number }; k: number } | undefined {
  const back = parts.acrylicBack
  if (!back) return undefined
  back.clear()
  const baseSprite = parts.acrylicBase
  if (baseSprite && parts.acrylicBaseLayout) {
    // 透明アクリルの台座と柔らかい影 (#760): 高解像度の共有テクスチャを縮小して敷く。影の幅が幾何の影に一致する
    const L = parts.acrylicBaseLayout
    const ref = g.shadow
    baseSprite.visible = !!(g.base && ref)
    if (g.base && ref) {
      const k = ref.rx / L.shadowRx
      baseSprite.scale.set(k)
      baseSprite.position.set(g.base.cx - L.cx * k, g.base.cy - L.cyTop * k)
    }
  } else {
    if (g.shadow) {
      back
        .ellipse(g.shadow.cx, g.shadow.cy, g.shadow.rx, g.shadow.ry)
        .fill({ color: 0x000000, alpha: params.shadowAlpha })
    }
    if (g.base) {
      back.ellipse(g.base.cx, g.base.cy, g.base.rx, g.base.ry).fill(ACRYLIC_BASE_COLOR)
    }
    if (g.highlight) {
      back
        .ellipse(g.highlight.cx, g.highlight.cy, g.highlight.rx, g.highlight.ry)
        .fill({ color: 0xffffff, alpha: params.highlightAlpha })
    }
  }
  const k = texWidth > 0 ? g.sprite.width / texWidth : 0
  const plate = parts.acrylicPlate
  if (plate) {
    // 板はスプライトと同じ倍率で縮小する（縮小した解像度で作った板を mipmap 付きで拡縮）。外へ pad ぶん広がる
    const ks = k * parts.acrylicPlateScale
    plate.scale.set(ks)
    plate.position.set(
      g.sprite.x - parts.acrylicPlatePad * ks,
      g.sprite.y - parts.acrylicPlatePad * ks
    )
    plate.visible = k > 0 && g.linePx > 0 && params.lineAlpha > 0
    // 板は台座に差し込まれているので、スリットの高さより下は見えない。スリットと同じ純粋関数の値で水平に切る (#760)。
    // スプライト本体の足元はクリップしない（mask は板だけ）
    const mask = (plate.mask ?? null) as Graphics | null
    if (mask) {
      const w = plate.texture.width * ks
      const fullH = plate.texture.height * ks
      // 台座が無い（hasBase=false）・縮尺 0 のときは切らない。mask は container 座標
      const clipY = g.base ? computeSlitY(g.base.cy, g.base.ry) : Infinity
      const h = ks > 0 ? Math.min(fullH, Math.max(0, clipY - plate.y)) : fullH
      mask.clear().rect(plate.x, plate.y, w, h).fill(0xffffff)
    }
  }
  const shadow = parts.acrylicShadow
  if (shadow) {
    // 本体の影 (#760): 足元（スプライト下端の中央）を基点に、縦につぶして右へ傾ける
    const t = computeShadowTransform(params, k * parts.acrylicPlateScale)
    shadow.scale.set(t.scaleX, t.scaleY)
    shadow.skew.x = mirrorShadow ? -t.skewX : t.skewX
    shadow.visible = k > 0 && params.castAlpha > 0
  }
  return {
    foot: { x: g.sprite.x + g.sprite.width / 2, y: g.sprite.y + g.sprite.height + g.liftPx },
    k,
  }
}
