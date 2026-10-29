/**
 * フィールドの歩行スプライト用アクスタ部品 (sit-by-me#58 / #861)。`spriteStyle: "acrylic"` のときだけ使う。
 *
 * 絵そのもの（Sprite）は従来どおり main.ts が足元（スプライト下端中心）基準で置く。ここは**その下**に敷く
 * 透明アクリルの板・台座・地面の影を、同じ足元に合わせて描く追加の層で、足元座標・歩行判定・移動速度には関与しない。
 * 部品の生成と配置は戦闘と共有（game/acrylicParts.ts）。幾何は computeAcrylicGeometry が正本。
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js'
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
 * 台座・影の大きさは**表示高さだけ**で決める（#861「大きさは一定」）。そのため枠の一辺 `size` は、縦横比 1:1 の基準の絵
 * （縦基準で収まる）で「絵の高さがちょうど `targetHeight` になる `size`」を探して固定し（余白・線の最小 px があるため
 * 完全な比例ではない。数回の反復で収束させ、残りの差は呼び出し側が一様な倍率で吸収する）、実際の絵は同じ高さ・同じ足元で
 * 横幅だけ縦横比どおりに置く。横長の絵（コマ送りで縦横比が変わる素材を含む）でも台座は伸び縮みせず、絵が台座より横へはみ出すだけ。
 * 戻り値の `geometry.sprite.height` が `targetHeight` に近い。寸法が不正（0 以下）なら null
 */
export function fitAcrylicGeometry(
  texWidth: number,
  texHeight: number,
  targetHeight: number,
  params: AcrylicParams
): { size: number; geometry: AcrylicGeometry } | null {
  if (!(texWidth > 0) || !(texHeight > 0) || !(targetHeight > 0)) return null
  let size = targetHeight * 1.6
  let ref = computeAcrylicGeometry(1, 1, size, params)
  for (let i = 0; i < 4 && ref.sprite.height > 0; i++) {
    size *= targetHeight / ref.sprite.height
    ref = computeAcrylicGeometry(1, 1, size, params)
  }
  if (!(ref.sprite.height > 0)) return null
  // 実際の絵: 基準と同じ高さ・同じ足元（下端）で、幅は縦横比どおり（中央）
  const height = ref.sprite.height
  const width = (texWidth / texHeight) * height
  const sprite = {
    x: (size - width) / 2,
    y: ref.sprite.y + ref.sprite.height - height,
    width,
    height,
  }
  return { size, geometry: { ...ref, sprite } }
}

/**
 * `spriteStyle` から、主人公・同行者のアクスタ部品を作る（main.ts の配線をテストできるよう取り出した）。
 * `"acrylic"` のときだけ作り、それ以外（未指定・`"none"`）は null＝従来描画。同行者は設定があるときだけ
 */
export function createFieldStands(
  style: 'acrylic' | undefined,
  hasCompanion: boolean
): { player: FieldAcrylicFigure | null; companion: FieldAcrylicFigure | null } {
  if (style !== 'acrylic') return { player: null, companion: null }
  return {
    player: new FieldAcrylicFigure(),
    companion: hasCompanion ? new FieldAcrylicFigure() : null,
  }
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
  private baseAttached = false
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

  /** 今コマの板・影を部品へ反映する。板・影のスプライトは、最初に作れた絵のときに作る（最初の絵で作れなくても後のコマで作る） */
  private applyPlate(tex: Texture, plate: AcrylicPlate | null): void {
    if (!plate) return
    if (!this.parts.acrylicPlate) {
      attachAcrylicLayers({
        container: this.display,
        parts: this.parts,
        tex,
        startIndex: this.display.children.length,
        makeBase: () => null,
        plateFor: () => plate,
        shadowLayer: this.shadowBox,
      })
      this.shownPlate = plate
    } else if (plate !== this.shownPlate) {
      this.shownPlate = plate
      this.parts.acrylicPlate.texture = plate.texture
      this.parts.acrylicPlatePad = plate.pad
      this.parts.acrylicPlateScale = plate.scale ?? 1
    }
    if (!plate.shadow) return
    const foot = plate.foot ?? { x: 0, y: 0 }
    let sh = this.parts.acrylicShadow
    if (!sh) {
      sh = new Sprite(plate.shadow)
      this.parts.acrylicShadow = sh
      this.shadowBox.addChild(sh)
    } else sh.texture = plate.shadow
    this.parts.acrylicShadowFoot = foot
    sh.pivot.set(foot.x, foot.y)
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
    if (!this.baseAttached) {
      this.baseAttached = true
      // 台座だけ先に積む（板・影は絵ごとに作れたとき applyPlate が積む）
      attachAcrylicLayers({
        container: this.display,
        parts: this.parts,
        tex,
        startIndex: 2,
        makeBase: () => (this.opts.makeBase ? this.opts.makeBase() : makeAcrylicBase(this.params)),
        plateFor: () => null,
        shadowLayer: this.shadowBox,
      })
    }
    // コマ（絵）が変わったら板・影のテクスチャを差し替える。作れなかった絵（null）では前の絵の板・影を残さず隠す
    const plate = this.plates.get(tex)
    this.applyPlate(tex, plate)
    const g = fit.geometry
    const laid = layoutAcrylicParts(this.parts, this.params, g, tex.width, flipped)
    const shadow = this.parts.acrylicShadow
    if (shadow && laid) shadow.position.set(laid.foot.x, laid.foot.y)
    // layoutAcrylicParts が出し入れした表示を、この絵に板・影があるかで上書きする
    if (this.parts.acrylicPlate && !plate) this.parts.acrylicPlate.visible = false
    if (shadow && !plate?.shadow) shadow.visible = false
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
