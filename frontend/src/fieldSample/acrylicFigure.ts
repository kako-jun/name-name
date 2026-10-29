/**
 * フィールドの歩行スプライト用アクスタ部品 (sit-by-me#58 / #861)。`spriteStyle: "acrylic"` のときだけ使う。
 *
 * 絵そのもの（Sprite）は従来どおり main.ts が足元（スプライト下端中心）基準で置く。ここは**その下**に敷く
 * 透明アクリルの板・台座・地面の影を、同じ足元に合わせて描く追加の層で、足元座標・歩行判定・移動速度には関与しない。
 * 部品の生成と配置は戦闘と共有（game/acrylicParts.ts）。幾何は computeAcrylicGeometry が正本。
 */
import { Container, Graphics, type Texture } from 'pixi.js'
import {
  AcrylicPlateCache,
  attachAcrylicLayers,
  emptyAcrylicParts,
  layoutAcrylicParts,
  makeAcrylicBase,
  makeAcrylicPlate,
  type AcrylicParts,
} from '../game/acrylicParts'
import type { AcrylicBaseTexture } from '../game/acrylicBaseTexture'
import type { AcrylicPlate } from '../game/acrylicPlateTexture'
import {
  computeAcrylicGeometry,
  resolveAcrylicParams,
  type AcrylicGeometry,
  type AcrylicParams,
} from '../game/spriteStyle'

/**
 * 絵の表示高さ `targetHeight`（画面 px）で描くときの、アクスタの幾何を求める。
 * 幾何は枠の一辺 `size` に対する比率で決まるので、絵の高さがちょうど `targetHeight` になる `size` を探す
 * （余白・線の最小 px があるため完全な比例ではない。数回の反復で収束させ、残りの差は呼び出し側が一様な倍率で吸収する）。
 * 戻り値の `geometry.sprite.height` が `targetHeight` に近い。絵の寸法が不正（0 以下）なら null
 */
export function fitAcrylicGeometry(
  texWidth: number,
  texHeight: number,
  targetHeight: number,
  params: AcrylicParams
): { size: number; geometry: AcrylicGeometry } | null {
  if (!(texWidth > 0) || !(texHeight > 0) || !(targetHeight > 0)) return null
  let size = targetHeight * 1.6
  let g = computeAcrylicGeometry(texWidth, texHeight, size, params)
  for (let i = 0; i < 4 && g.sprite.height > 0; i++) {
    size *= targetHeight / g.sprite.height
    g = computeAcrylicGeometry(texWidth, texHeight, size, params)
  }
  if (!(g.sprite.height > 0)) return null
  return { size, geometry: g }
}

export interface FieldAcrylicFigureOptions {
  /** 板・台座の生成を差し替える（テスト用。canvas の無い環境で使う） */
  makeBase?: () => AcrylicBaseTexture | null
  makePlate?: (tex: Texture) => AcrylicPlate | null
}

/** 1 人ぶんのアクスタ部品。`display` を world に（絵の Sprite の直前に）追加し、毎フレーム `update` を呼ぶ */
export class FieldAcrylicFigure {
  readonly display = new Container()
  private readonly params: AcrylicParams
  private readonly parts: AcrylicParts
  private readonly shadowBox = new Container()
  private readonly plates: AcrylicPlateCache
  private readonly opts: FieldAcrylicFigureOptions
  private attached = false
  private shownPlate: AcrylicPlate | null = null

  constructor(params?: Partial<AcrylicParams>, opts: FieldAcrylicFigureOptions = {}) {
    this.params = resolveAcrylicParams(params)
    this.opts = opts
    const makePlate = opts.makePlate ?? ((tex: Texture) => makeAcrylicPlate(tex, this.params))
    this.plates = new AcrylicPlateCache(makePlate)
    const back = new Graphics()
    this.parts = emptyAcrylicParts(back)
    // 影（最下層）→ 台座・影の Graphics → 台座 → 板 → 板の mask の順
    this.display.addChild(this.shadowBox, back)
    this.display.visible = false
  }

  /** 配置済みの部品（テスト・検証用） */
  get layers(): AcrylicParts {
    return this.parts
  }

  /**
   * 足元 (x, y) にアクスタを置く。`tex` は今コマの絵、`height` は絵の表示高さ（画面 px。main.ts が絵に使う値と同じ）、
   * `flipped` は絵を左右反転して描くとき true（板・台座・影も同じ足元で反転する。影は光の向きのまま右へ倒れる）。
   */
  update(tex: Texture, height: number, flipped: boolean, x: number, y: number): void {
    const fit = fitAcrylicGeometry(tex.width, tex.height, height, this.params)
    if (!fit) {
      this.display.visible = false
      return
    }
    if (!this.attached) {
      this.attached = true
      const att = attachAcrylicLayers({
        container: this.display,
        parts: this.parts,
        tex,
        startIndex: 2,
        makeBase: () => (this.opts.makeBase ? this.opts.makeBase() : makeAcrylicBase(this.params)),
        plateFor: (t) => this.plates.get(t),
        shadowLayer: this.shadowBox,
      })
      this.shownPlate = att.plate
    }
    // コマ（絵）が変わったら板・影のテクスチャを差し替える
    const plate = this.plates.get(tex)
    if (plate && plate !== this.shownPlate && this.parts.acrylicPlate) {
      this.shownPlate = plate
      this.parts.acrylicPlate.texture = plate.texture
      this.parts.acrylicPlatePad = plate.pad
      this.parts.acrylicPlateScale = plate.scale ?? 1
      const sh = this.parts.acrylicShadow
      if (sh && plate.shadow) {
        sh.texture = plate.shadow
        this.parts.acrylicShadowFoot = plate.foot ?? { x: 0, y: 0 }
        sh.pivot.set(this.parts.acrylicShadowFoot.x, this.parts.acrylicShadowFoot.y)
      }
    }
    const g = fit.geometry
    const laid = layoutAcrylicParts(this.parts, this.params, g, tex.width, flipped)
    if (this.parts.acrylicShadow && laid)
      this.parts.acrylicShadow.position.set(laid.foot.x, laid.foot.y)
    // 絵の高さを height にぴったり合わせる一様な倍率（≒1）。足元（絵の下端中央）を pivot にして (x, y) へ置く
    const sc = height / g.sprite.height
    this.display.scale.set(flipped ? -sc : sc, sc)
    this.display.pivot.set(fit.size / 2, g.sprite.y + g.sprite.height)
    this.display.position.set(x, y)
    this.display.visible = true
  }

  /** 板・影のテクスチャは自前で作ったものなので、TextureSource ごと解放する（台座は共有キャッシュなので壊さない） */
  destroy(): void {
    this.plates.destroy()
    this.display.destroy({ children: true })
  }
}
