/** 武器レイヤー (#1027): sit-by-me の実データ（C001〜C004）を buildWeaponRig に読ませて、既知の値を固定する */
import { describe, expect, it } from 'vitest'
import {
  buildWeaponRig,
  computeWeaponPlacement,
  resolveWeaponForPose,
  type BattleWeaponSpec,
  type WeaponRig,
  type WeaponStructure,
} from './battleWeapon'
import {
  CATALOG_C001,
  CATALOG_C002,
  CATALOG_C003,
  CATALOG_C004,
  LAYERS_C001,
  LAYERS_C002,
  LAYERS_C003,
  LAYERS_C004,
} from './__fixtures__/sitByMeBattleWeapon'

const ODENTA = 'w/C001-odenta-mitsuyo-candidate.webp'
const ONIMARU = 'w/C001-onimaru-kunitsuna-candidate.webp'

const rig = (
  layers: unknown,
  catalog: unknown,
  image: string,
  structure: WeaponStructure,
  overrides?: unknown
): WeaponRig => {
  const spec: BattleWeaponSpec = { image, structure }
  const r = buildWeaponRig(spec, layers, catalog, overrides)
  expect(r).not.toBeNull()
  return r as WeaponRig
}

describe('sit-by-me の実データ (#1027)', () => {
  it('柄アンカーは catalog の同じファイル名から引く（C001 は刀ごと・C002 は全刀 0.82）', () => {
    expect(rig(LAYERS_C001, CATALOG_C001, ODENTA, 'standing').anchor).toEqual({
      x: 0.846,
      y: 0.836,
    })
    expect(rig(LAYERS_C001, CATALOG_C001, ONIMARU, 'standing').anchor).toEqual({
      x: 0.935,
      y: 0.87,
    })
    expect(
      rig(LAYERS_C002, CATALOG_C002, 'w/C002-muramasa-candidate.webp', 'standing').anchor
    ).toEqual({ x: 0.82, y: 0.82 })
  })

  it('C002 standing の ready は ready_weapon_transform（高さ比 0.45・回転 -205・柄ターゲット (0.17,0.25)）', () => {
    const r = rig(LAYERS_C002, CATALOG_C002, 'w/C002-heshikiri-hasebe-candidate.webp', 'standing')
    expect(resolveWeaponForPose(r, 'ready')).toEqual({
      transform: {
        heightRatio: 0.45,
        rotationDeg: -205,
        handleTarget: { x: 0.17, y: 0.25 },
        flipX: false,
      },
      front: true,
    })
  })

  it('C002 standing の ready の置き場所: 回転 -205 は Pixi では +205 度（時計回り）・柄ターゲットは人物の絵の比', () => {
    const r = rig(LAYERS_C002, CATALOG_C002, 'w/C002-heshikiri-hasebe-candidate.webp', 'standing')
    const tr = resolveWeaponForPose(r, 'ready')!.transform
    const p = computeWeaponPlacement(
      tr,
      { width: 100, height: 400 },
      { x: 10, y: 20, width: 200, height: 800 }
    )
    expect(p.rotation).toBeCloseTo((205 * Math.PI) / 180)
    expect(p.x).toBeCloseTo(10 + 0.17 * 200)
    expect(p.y).toBeCloseTo(20 + 0.25 * 800)
    expect(p.scaleY).toBeCloseTo((0.45 * 800) / 400)
    expect(p.scaleX).toBeCloseTo(p.scaleY)
  })

  it('C002 wheelchair の ready は構造別の値（0.4・(0.28,0.26)）を引く', () => {
    const r = rig(LAYERS_C002, CATALOG_C002, 'w/C002-heshikiri-hasebe-candidate.webp', 'wheelchair')
    const t = resolveWeaponForPose(r, 'ready')!.transform
    expect(t.heightRatio).toBe(0.4)
    expect(t.handleTarget).toEqual({ x: 0.28, y: 0.26 })
  })

  it('C001 standing の step は flip_x=true・回転 25・柄ターゲット (0.7,0.38)・高さ比 0.42', () => {
    const r = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'standing')
    expect(resolveWeaponForPose(r, 'step')!.transform).toEqual({
      heightRatio: 0.42,
      rotationDeg: 25,
      handleTarget: { x: 0.7, y: 0.38 },
      flipX: true,
    })
  })

  it('C001 の slash は構造別オブジェクト（standing 0.52 / wheelchair 0.42）を引く', () => {
    const st = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'standing')
    const wc = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'wheelchair')
    expect(resolveWeaponForPose(st, 'slash')!.transform.heightRatio).toBe(0.52)
    expect(resolveWeaponForPose(st, 'slash')!.transform.handleTarget).toEqual({ x: 0.56, y: 0.48 })
    expect(resolveWeaponForPose(wc, 'slash')!.transform.heightRatio).toBe(0.42)
    expect(resolveWeaponForPose(wc, 'slash')!.transform.handleTarget).toEqual({ x: 0.5, y: 0.34 })
  })

  it('C001 の swing は #165 でクロップし直した値（windup 110 度・followthrough は構造別の回転 175/165、高さ比 0.42）', () => {
    const st = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'standing')
    const wc = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'wheelchair')
    const t = (r: WeaponRig, pose: 'swing-windup' | 'swing-followthrough') =>
      resolveWeaponForPose(r, pose)!.transform
    expect(t(st, 'swing-windup')).toMatchObject({
      heightRatio: 0.42,
      rotationDeg: 110,
      flipX: false,
    })
    expect(t(st, 'swing-windup').handleTarget).toEqual({ x: 0.86, y: 0.19 })
    expect(t(wc, 'swing-windup').handleTarget).toEqual({ x: 0.8, y: 0.22 })
    expect(t(st, 'swing-followthrough')).toMatchObject({ heightRatio: 0.42, rotationDeg: 175 })
    expect(t(wc, 'swing-followthrough')).toMatchObject({ heightRatio: 0.42, rotationDeg: 165 })
    expect(t(st, 'swing-followthrough').handleTarget).toEqual({ x: 0.15, y: 0.51 })
    expect(t(wc, 'swing-followthrough').handleTarget).toEqual({ x: 0.15, y: 0.43 })
  })
  it('C001 の slash の刀別 override は blade-candidates.json を overrides に渡したときだけ効く（onimaru のみ）', () => {
    const none = rig(LAYERS_C001, CATALOG_C001, ONIMARU, 'standing')
    expect(resolveWeaponForPose(none, 'slash')!.transform.heightRatio).toBe(0.52)

    const st = rig(LAYERS_C001, CATALOG_C001, ONIMARU, 'standing', CATALOG_C001)
    expect(resolveWeaponForPose(st, 'slash')!.transform).toMatchObject({
      heightRatio: 0.48,
      handleTarget: { x: 0.72, y: 0.48 },
    })
    const wc = rig(LAYERS_C001, CATALOG_C001, ONIMARU, 'wheelchair', CATALOG_C001)
    expect(resolveWeaponForPose(wc, 'slash')!.transform).toMatchObject({
      heightRatio: 0.42,
      handleTarget: { x: 0.62, y: 0.34 },
    })
    // 別の刀（odenta）は override に当たらず共通値のまま
    const other = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'standing', CATALOG_C001)
    expect(resolveWeaponForPose(other, 'slash')!.transform.heightRatio).toBe(0.52)
  })

  it('C001 / C002 の車椅子 step は刀なし', () => {
    const c1 = rig(LAYERS_C001, CATALOG_C001, ODENTA, 'wheelchair')
    const c2 = rig(LAYERS_C002, CATALOG_C002, 'w/C002-muramasa-candidate.webp', 'wheelchair')
    expect(resolveWeaponForPose(c1, 'step')).toBeNull()
    expect(resolveWeaponForPose(c2, 'step')).toBeNull()
  })

  it('C003 / C004 の車椅子は刀なし（standing の値しか持たない）', () => {
    const cases: [unknown, unknown, string][] = [
      [LAYERS_C003, CATALOG_C003, 'w/C003-nagasone-kotetsu-candidate.webp'],
      [LAYERS_C004, CATALOG_C004, 'w/C004-shichishito-candidate.webp'],
    ]
    for (const [layers, catalog, image] of cases) {
      const wc = rig(layers, catalog, image, 'wheelchair')
      for (const p of ['ready', 'step', 'slash', 'special'] as const) {
        expect(resolveWeaponForPose(wc, p)).toBeNull()
      }
      // 同じ人物の standing には刀が出る
      const st = rig(layers, catalog, image, 'standing')
      expect(resolveWeaponForPose(st, 'slash')).not.toBeNull()
    }
  })
})
