import { describe, expect, it } from 'vitest'
import {
  alphaBoundsFraction,
  buildWeaponRig,
  computeWeaponPlacement,
  findCatalogAnchor,
  firstCatalogImage,
  normalizeWeaponSpec,
  parseAnchor,
  pickWeaponKeys,
  resolveWeaponForPose,
  type BattleWeaponSpec,
  type WeaponRig,
} from './battleWeapon'
import { posesField } from './battleMotion'
import { DUMMY_CATALOG, DUMMY_LAYERS } from './battleWeaponFixture'

const A = { x: 0.8, y: 0.8 }
const spec = (over: Partial<BattleWeaponSpec> = {}): BattleWeaponSpec => ({
  image: 'w/dummy-blade-a.webp',
  structure: 'standing',
  ...over,
})
const rigOf = (
  over: Partial<BattleWeaponSpec> = {},
  layers: unknown = DUMMY_LAYERS,
  cat: unknown = DUMMY_CATALOG
) => buildWeaponRig(spec(over), layers, cat) as WeaponRig

describe('poses の予約キー (#1027)', () => {
  it('weapon があれば取り出す（構造は既定 standing・大小無視）', () => {
    expect(normalizeWeaponSpec({ weapon: 'w.webp', idle: 'i.webp' })).toEqual({
      image: 'w.webp',
      structure: 'standing',
    })
    expect(
      normalizeWeaponSpec({
        WEAPON: ' w.webp ',
        'weapon-structure': 'Wheelchair',
        'weapon-anchor': '0.5 0.25',
        'weapon-layers': 'l.json',
        'weapon-catalog': 'c.json',
      })
    ).toEqual({
      image: 'w.webp',
      structure: 'wheelchair',
      anchor: { x: 0.5, y: 0.25 },
      layers: 'l.json',
      catalog: 'c.json',
    })
  })
  it('weapon が無い・空・poses が無いなら何も無い（従来不変）', () => {
    expect(normalizeWeaponSpec({ idle: 'i.webp' })).toBeUndefined()
    expect(normalizeWeaponSpec({ weapon: '  ' })).toBeUndefined()
    expect(normalizeWeaponSpec(undefined)).toBeUndefined()
    expect(posesField({ idle: 'i.webp' })).toEqual({ poses: { idle: 'i.webp' } })
    expect(posesField(undefined)).toEqual({})
  })
  it('posesField は ポーズと刀を同じ入力から別々に写す（刀キーはポーズに混ざらない）', () => {
    const f = posesField({ idle: 'i.webp', weapon: 'w.webp', 'weapon-layers': 'l.json' })
    expect(f.poses).toEqual({ idle: 'i.webp' })
    expect(f.weapon).toEqual({ image: 'w.webp', structure: 'standing', layers: 'l.json' })
    expect(posesField({ weapon: 'w.webp' }).poses).toBeUndefined()
  })
  it('柄アンカーの書式: 空白/スラッシュ区切り・0〜1 外や不正は無効', () => {
    expect(parseAnchor('0.9/0.85')).toEqual({ x: 0.9, y: 0.85 })
    expect(parseAnchor('1.2 0.5')).toBeUndefined()
    expect(parseAnchor('a b')).toBeUndefined()
    expect(parseAnchor('0.5')).toBeUndefined()
    expect(normalizeWeaponSpec({ weapon: 'w', 'weapon-anchor': 'zzz' })?.anchor).toBeUndefined()
  })
  it('pickWeaponKeys は刀のキーだけを抜く', () => {
    expect(pickWeaponKeys({ idle: 'a', weapon: 'b', 'weapon-structure': 'wheelchair' })).toEqual({
      weapon: 'b',
      'weapon-structure': 'wheelchair',
    })
  })
})

describe('buildWeaponRig: 契約 JSON の読み取り', () => {
  it('柄アンカーは spec 優先、無ければ catalog のファイル名一致、どちらも無ければ null', () => {
    expect(rigOf().anchor).toEqual({ x: 0.8, y: 0.8 })
    expect(rigOf({ image: 'other/dummy-blade-b.webp' }).anchor).toEqual({ x: 0.9, y: 0.85 })
    expect(rigOf({ anchor: { x: 0.1, y: 0.2 } }).anchor).toEqual({ x: 0.1, y: 0.2 })
    expect(buildWeaponRig(spec({ image: 'nothing.webp' }), DUMMY_LAYERS, DUMMY_CATALOG)).toBeNull()
    expect(findCatalogAnchor(null, 'x')).toBeUndefined()
  })
  it('立位と車椅子で、高さ比・柄ターゲットが構造ごとに引ける（layers JSON だけから）', () => {
    const st = rigOf()
    const wc = rigOf({ structure: 'wheelchair' })
    expect(st.transforms.slash).toEqual({
      heightRatio: 0.52,
      rotationDeg: 45,
      handleTarget: { x: 0.56, y: 0.48 },
      flipX: false,
    })
    expect(wc.transforms.slash).toEqual({
      heightRatio: 0.4,
      rotationDeg: 45,
      handleTarget: { x: 0.45, y: 0.35 },
      flipX: false,
    })
  })
  it('ready は ready_weapon_transform（pose_layers.ready が配列でもよい）', () => {
    expect(rigOf().transforms.ready).toEqual({
      heightRatio: 0.7,
      rotationDeg: 0,
      handleTarget: { x: 0.4, y: 0.4 },
      flipX: false,
    })
    // オブジェクト形式の ready（flip_x・構造別を持つ）も読める
    const r = buildWeaponRig(
      spec({ anchor: A }),
      {
        pose_layers: {
          ready: {
            layers: ['character', 'weapon'],
            weapon_height_ratio: { standing: 0.45, wheelchair: 0.4 },
            rotation_deg: -205,
            handle_target: { standing: { x: 0.17, y: 0.25 }, wheelchair: { x: 0.28, y: 0.26 } },
            flip_x: false,
          },
        },
      },
      null
    )
    expect(r?.transforms.ready).toMatchObject({ heightRatio: 0.45, rotationDeg: -205 })
  })
  it('catalog の shared_pose_transforms は読まない（変換は layers だけ）', () => {
    const cat = {
      ...DUMMY_CATALOG,
      shared_pose_transforms: {
        poses: {
          slash: { rotation_deg: 99, weapon_height_ratio: 9, handle_target: { x: 0, y: 0 } },
        },
      },
    }
    expect(buildWeaponRig(spec(), DUMMY_LAYERS, cat)?.transforms.slash?.rotationDeg).toBe(45)
    expect(buildWeaponRig(spec(), null, cat)?.transforms.slash).toBeUndefined()
  })
  it('overrides JSON で刀ごとの差を項目単位に上書きできる（刀カタログ形・layers 形の両方、ファイル名一致のみ）', () => {
    const ov = {
      shared_pose_transforms: {
        poses: {
          slash: {
            candidate_overrides: {
              'dummy-blade-b.webp': {
                weapon_height_ratio: { standing: 0.48, wheelchair: 0.42 },
                handle_target: { standing: { x: 0.72, y: 0.48 }, wheelchair: { x: 0.62, y: 0.34 } },
              },
            },
          },
        },
      },
    }
    const b = buildWeaponRig(
      spec({ image: 'x/dummy-blade-b.webp' }),
      DUMMY_LAYERS,
      DUMMY_CATALOG,
      ov
    )
    expect(b?.transforms.slash).toMatchObject({
      heightRatio: 0.48,
      handleTarget: { x: 0.72, y: 0.48 },
      rotationDeg: 45,
    })
    const a = buildWeaponRig(spec(), DUMMY_LAYERS, DUMMY_CATALOG, ov)
    expect(a?.transforms.slash).toMatchObject({
      heightRatio: 0.52,
      handleTarget: { x: 0.56, y: 0.48 },
    })
    const lay = buildWeaponRig(spec(), DUMMY_LAYERS, DUMMY_CATALOG, {
      pose_layers: { ready: { weapon_height_ratio: 0.9 } },
    })
    expect(lay?.transforms.ready).toMatchObject({
      heightRatio: 0.9,
      handleTarget: { x: 0.4, y: 0.4 },
    })
    expect(normalizeWeaponSpec({ weapon: 'w', 'weapon-overrides': 'o.json' })?.overrides).toBe(
      'o.json'
    )
  })
  it('catalog の先頭の刀を既定にできる（catalog のあるディレクトリ基準）', () => {
    expect(firstCatalogImage(DUMMY_CATALOG, 'a/b/cat.json')).toBe('a/b/dummy-blade-a.webp')
    expect(firstCatalogImage(DUMMY_CATALOG, 'cat.json')).toBe('dummy-blade-a.webp')
    expect(firstCatalogImage({}, 'cat.json')).toBeUndefined()
    expect(normalizeWeaponSpec({ 'weapon-catalog': 'c.json' })).toEqual({
      structure: 'standing',
      catalog: 'c.json',
    })
  })
  it('step: 立位は flip_x と回転、車椅子は none（刀なし）', () => {
    expect(rigOf().transforms.step).toMatchObject({
      flipX: true,
      rotationDeg: 20,
      heightRatio: 0.4,
    })
    expect(rigOf({ structure: 'wheelchair' }).transforms.step).toBeNull()
  })
  it('swing-windup / swing-followthrough も layers から（構造別）', () => {
    const r = rigOf({ structure: 'wheelchair' })
    expect(r.transforms['swing-windup']).toEqual({
      heightRatio: 0.4,
      rotationDeg: -90,
      handleTarget: { x: 0.8, y: 0.26 },
      flipX: false,
    })
    expect(r.transforms['swing-followthrough']?.rotationDeg).toBe(90)
  })
  it('不完全な変換（高さ比か柄ターゲットが無い）は採用しない。JSON が不正でも落ちない', () => {
    const r = buildWeaponRig(
      spec({ anchor: A }),
      { pose_layers: { slash: { rotation_deg: 5 } } },
      null
    )
    expect(r?.transforms.slash).toBeUndefined()
    expect(buildWeaponRig(spec({ anchor: A }), 'zzz', 42)).toMatchObject({
      transforms: {},
      layers: {},
    })
  })
})

describe('resolveWeaponForPose: ポーズごとの切り替えとフォールバック', () => {
  it('ready / slash / special は人物の前に刀、変換はポーズ別', () => {
    const r = rigOf()
    expect(resolveWeaponForPose(r, 'ready')?.transform.heightRatio).toBe(0.7)
    expect(resolveWeaponForPose(r, 'slash')?.transform.rotationDeg).toBe(45)
    expect(resolveWeaponForPose(r, 'special')?.transform.rotationDeg).toBe(-20)
    expect(resolveWeaponForPose(r, 'slash')?.front).toBe(true)
  })
  it('idle / hurt / down / victory / cast は刀なし（layers に weapon が無い・書いていないポーズ）', () => {
    const r = rigOf()
    for (const p of ['idle', 'hurt', 'down', 'cast', 'victory'] as const) {
      expect(resolveWeaponForPose(r, p)).toBeNull()
    }
  })
  it('車椅子の step は刀なし、立位の step は反転した刀', () => {
    expect(resolveWeaponForPose(rigOf({ structure: 'wheelchair' }), 'step')).toBeNull()
    expect(resolveWeaponForPose(rigOf(), 'step')?.transform.flipX).toBe(true)
  })
  it('変換が無い構えのポーズは ready の変換に倒れる／ready も無ければ刀なし', () => {
    const r = buildWeaponRig(
      spec({ anchor: A }),
      {
        pose_layers: { ready: ['character', 'weapon'] },
        ready_weapon_transform: DUMMY_LAYERS.ready_weapon_transform,
      },
      null
    ) as WeaponRig // swing 系の変換が無い
    expect(r.transforms['swing-windup']).toBeUndefined()
    expect(resolveWeaponForPose(r, 'swing-windup')?.transform).toEqual(r.transforms.ready)
    const noReady = buildWeaponRig(spec({ anchor: A }), { pose_layers: {} }, null) as WeaponRig
    expect(resolveWeaponForPose(noReady, 'swing-windup')).toBeNull()
    expect(resolveWeaponForPose(noReady, 'ready')).toBeNull()
  })
  it('重ね順: weapon が character より前なら人物の後ろ', () => {
    const r = buildWeaponRig(
      spec({ anchor: A }),
      {
        pose_layers: {
          slash: {
            layers: ['weapon', 'character'],
            weapon_height_ratio: 0.5,
            handle_target: { x: 0.5, y: 0.5 },
          },
        },
      },
      null
    ) as WeaponRig
    expect(resolveWeaponForPose(r, 'slash')?.front).toBe(false)
  })
})

describe('computeWeaponPlacement: 柄・高さ比・回転・反転', () => {
  const rect = { x: 10, y: 20, width: 100, height: 200 }
  const tex = { width: 50, height: 40 }
  const base = { heightRatio: 0.5, rotationDeg: 0, handleTarget: { x: 0.25, y: 0.5 }, flipX: false }
  it('柄ターゲットは人物の絵の矩形に対する比（柄の位置がそこに置かれる）', () => {
    const p = computeWeaponPlacement(base, tex, rect)
    expect(p.x).toBeCloseTo(10 + 0.25 * 100)
    expect(p.y).toBeCloseTo(20 + 0.5 * 200)
  })
  it('刀の高さ = 高さ比 × 人物の絵の高さ（縦横等倍）', () => {
    const p = computeWeaponPlacement(base, tex, rect)
    expect(p.scaleY * tex.height).toBeCloseTo(0.5 * 200)
    expect(p.scaleX).toBeCloseTo(p.scaleY)
  })
  it('flip_x は x 拡大率だけ負、回転は反時計回りが正（pixi では符号反転）', () => {
    const f = computeWeaponPlacement({ ...base, flipX: true, rotationDeg: 90 }, tex, rect)
    expect(f.scaleX).toBeLessThan(0)
    expect(f.scaleY).toBeGreaterThan(0)
    expect(f.rotation).toBeCloseTo(-Math.PI / 2)
    expect(computeWeaponPlacement({ ...base, rotationDeg: -45 }, tex, rect).rotation).toBeCloseTo(
      Math.PI / 4
    )
  })
  it('人物の絵が大きくなれば刀も比例して大きくなる（縮尺に追従）', () => {
    const a = computeWeaponPlacement(base, tex, rect)
    const b = computeWeaponPlacement(base, tex, { ...rect, width: 200, height: 400 })
    expect(b.scaleY / a.scaleY).toBeCloseTo(2)
  })
})

describe('alphaBoundsFraction', () => {
  it('不透明部分の範囲を比で返す。全透明は全体', () => {
    const w = 4
    const h = 4
    const d = new Uint8Array(w * h * 4)
    d[(1 * w + 2) * 4 + 3] = 255
    d[(2 * w + 3) * 4 + 3] = 255
    expect(alphaBoundsFraction(d, w, h)).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.5 })
    expect(alphaBoundsFraction(new Uint8Array(w * h * 4), w, h)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})
