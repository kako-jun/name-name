// #1020: 人物の形態（時期・車椅子）から poses・歩行絵を命名規則で導く純関数と、設定 JSON への展開。
import { describe, expect, it } from 'vitest'
import manifestText from '../../public/field/sit-character-forms.json?raw'
import {
  CORE_POSES,
  DERIVED_POSES,
  deriveWalkSprites,
  explainNoPoses,
  derivePoses,
  deriveWeaponKeys,
  expandCharacterForms,
  parseCharacterFormsManifest,
  pickPoseVariant,
  savedFormsOf,
  walkGait,
  type CharacterFormsManifest,
} from './characterForms'

const ROOT = 'http://h/assets/images/characters/'
const ALL = [...DERIVED_POSES]
const CORE = [...CORE_POSES]
const EXTRA = DERIVED_POSES.filter((x) => !CORE.includes(x)) // special・swing-*

/** 小さな合成の目録: a=人物単体版が揃う、b=plain だけ、c=人物単体版が欠ける（plain が揃う）、d=character の方が多いが不完全 */
const manifest: CharacterFormsManifest = {
  characters: {
    // 焼き込み版の plain が混じり得る人物（C001 相当）
    CB: {
      plainBaked: true,
      forms: {
        full: { poses: { plain: ALL, character: ALL }, walk: true },
        partial: { poses: { plain: ALL, character: ['idle', 'ready'] }, walk: true },
        onlyPlain: { poses: { plain: ALL }, walk: true },
        coreOnly: { poses: { plain: ALL, character: CORE }, walk: true },
      },
    },
    C9: {
      forms: {
        a: { poses: { plain: ALL, character: ALL }, walk: true },
        b: { poses: { plain: ALL }, walk: false },
        c: { poses: { plain: ALL, character: ['idle', 'ready'] }, walk: true },
        d: { poses: { plain: ['idle'], character: ['idle', 'ready', 'slash'] }, walk: false },
        coreOnly: { poses: { plain: ALL, character: CORE }, walk: true },
        plainCore: { poses: { plain: CORE, character: [...CORE.slice(1), ...EXTRA] }, walk: true },
        'e-wheelchair': { poses: { plain: ['idle', 'hurt'] }, walk: true },
      },
    },
  },
}

describe('pickPoseVariant（人物単体版の優先ルール）', () => {
  it('8 ポーズ揃った character があれば character', () =>
    expect(pickPoseVariant(manifest.characters.C9.forms.a)).toBe('character'))
  it('character が無ければ plain', () =>
    expect(pickPoseVariant(manifest.characters.C9.forms.b)).toBe('plain'))
  it('character が不完全で plain が揃うなら plain（版は混ぜない）', () =>
    expect(pickPoseVariant(manifest.characters.C9.forms.c)).toBe('plain'))
  it('どちらも不完全なら実在ポーズの多い方', () =>
    expect(pickPoseVariant(manifest.characters.C9.forms.d)).toBe('character'))
  it('基本 8 ポーズだけ（special・swing 無し）の character も揃っている扱いで character を選ぶ', () =>
    expect(pickPoseVariant(manifest.characters.C9.forms.coreOnly)).toBe('character'))
  it('基本 8 ポーズの欠けは special・swing で個数が 8 以上になっても揃っていない扱い（plain が揃えば plain）', () => {
    const e = manifest.characters.C9.forms.plainCore
    expect(e.poses.character!.length).toBeGreaterThanOrEqual(8)
    expect(pickPoseVariant(e)).toBe('plain')
  })
  it('基本 8 ポーズだけの plain も揃っている扱い', () =>
    expect(pickPoseVariant({ poses: { plain: CORE }, walk: false })).toBe('plain'))
  it('絵が 1 枚も無ければ undefined', () =>
    expect(pickPoseVariant({ poses: {}, walk: false })).toBeUndefined())
})

describe('plainBaked（焼き込み版が混じり得る人物は plain へ降格しない）', () => {
  const forms = manifest.characters.CB.forms
  it('8 ポーズ揃った character は使う', () =>
    expect(pickPoseVariant(forms.full, { plainBaked: true })).toBe('character'))
  it('基本 8 ポーズだけの character も降格せず character', () =>
    expect(pickPoseVariant(forms.coreOnly, { plainBaked: true })).toBe('character'))
  it('character が不完全・無いなら、plain が揃っていても導出しない', () => {
    expect(pickPoseVariant(forms.partial, { plainBaked: true })).toBeUndefined()
    expect(pickPoseVariant(forms.onlyPlain, { plainBaked: true })).toBeUndefined()
    expect(derivePoses(manifest, ROOT, 'CB', 'partial')).toBeUndefined()
    expect(derivePoses(manifest, ROOT, 'CB', 'onlyPlain')).toBeUndefined()
    expect(derivePoses(manifest, ROOT, 'CB', 'full')!.idle).toMatch(/CB-full-character-idle/)
  })
  it('plainBaked でない人物（C9）は従来どおり plain に降格する', () =>
    expect(derivePoses(manifest, ROOT, 'C9', 'c')!.idle).toMatch(/C9-c-idle\.webp$/))
  it('導けない理由を返す（焼き込み / 絵なし / 導ける・目録に無いは null）', () => {
    expect(explainNoPoses(manifest, 'CB', 'partial')).toMatch(/焼き込み版/)
    expect(explainNoPoses(manifest, 'C9', 'a')).toBeNull()
    expect(explainNoPoses(manifest, 'C9', 'zz')).toBeNull()
  })
  it('展開すると警告し、その味方は導出しない（手書きのまま）', () => {
    const r = expandCharacterForms(
      {
        characterForms: { root: ROOT, manifestUrl: 'm.json' },
        party: [{ name: 'B', character: 'CB', form: 'onlyPlain', sprite: 'old.png' }],
      },
      manifest
    )
    expect(r.warnings.join('\n')).toMatch(/CB\/onlyPlain.*焼き込み版/)
    expect((r.raw as { party: Record<string, unknown>[] }).party[0]).toEqual({
      name: 'B',
      character: 'CB',
      form: 'onlyPlain',
      sprite: 'old.png',
    })
  })
  it('目録の plainBaked が真偽値でなければ失敗', () =>
    expect(
      parseCharacterFormsManifest({ characters: { X: { plainBaked: 'y', forms: {} } } }).ok
    ).toBe(false))
})

describe('derivePoses / deriveWalkSprites（命名規則）', () => {
  it('character 版は {C}-{form}-character-{pose}.webp', () => {
    const p = derivePoses(manifest, ROOT, 'C9', 'a')!
    expect(Object.keys(p).sort()).toEqual([...ALL].sort())
    expect(p.slash).toBe('http://h/assets/images/characters/C9/poses/C9-a-character-slash.webp')
  })
  it('plain 版は {C}-{form}-{pose}.webp。実在しないポーズは作らない（エンジンが idle に落とす）', () => {
    const p = derivePoses(manifest, ROOT, 'C9', 'e-wheelchair')!
    expect(p).toEqual({
      idle: 'http://h/assets/images/characters/C9/poses/C9-e-wheelchair-idle.webp',
      hurt: 'http://h/assets/images/characters/C9/poses/C9-e-wheelchair-hurt.webp',
    })
    expect(p.down).toBeUndefined()
  })
  it('未知の人物・形態は undefined（own-property のみ。__proto__ / constructor でも落ちない）', () => {
    expect(derivePoses(manifest, ROOT, 'C0', 'a')).toBeUndefined()
    expect(derivePoses(manifest, ROOT, 'C9', 'zz')).toBeUndefined()
    expect(derivePoses(manifest, ROOT, 'constructor', 'a')).toBeUndefined()
    expect(derivePoses(manifest, ROOT, 'C9', '__proto__')).toBeUndefined()
  })
  it('歩行絵は 8 方向×3 コマ。揃っていない形態は undefined', () => {
    const w = deriveWalkSprites(manifest, ROOT, 'C9', 'a')!
    expect(Object.keys(w)).toEqual([
      'up',
      'down',
      'left',
      'right',
      'upLeft',
      'upRight',
      'downLeft',
      'downRight',
    ])
    expect(w.downLeft[2]).toBe(
      'http://h/assets/images/characters/C9/walk/C9-a-walk-downleft-3.webp'
    )
    expect(deriveWalkSprites(manifest, ROOT, 'C9', 'b')).toBeUndefined()
  })
  it('歩行周期: 立位は [0,1,2,1]・止まり 1、車椅子は既定のまま', () => {
    expect(walkGait('elementary')).toEqual({ cycle: [0, 1, 2, 1], idleFrame: 1 })
    expect(walkGait('elementary-wheelchair')).toBeUndefined()
    expect(walkGait('teen-wheelchair')).toBeUndefined()
  })
})

describe('目録 JSON の検証', () => {
  it('同梱の目録が通り、C001〜C004 を持つ', () => {
    const r = parseCharacterFormsManifest(JSON.parse(manifestText))
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value.characters)).toEqual(['C001', 'C002', 'C003', 'C004'])
  })
  it('同梱の目録: 寺町の 4 人（C002 小学生車椅子・C001/C003/C004 小学生）は 8 ポーズ揃い、C001 は人物単体版', () => {
    const r = parseCharacterFormsManifest(JSON.parse(manifestText))
    if (!r.ok) throw new Error(r.error)
    for (const [c, f] of [
      ['C002', 'elementary-wheelchair'],
      ['C001', 'elementary'],
      ['C003', 'elementary'],
      ['C004', 'elementary'],
    ]) {
      const e = r.value.characters[c].forms[f]
      expect(pickPoseVariant(e)).toBeDefined()
      expect(derivePoses(r.value, ROOT, c, f)).toBeDefined()
      expect(e.walk).toBe(true)
    }
    expect(r.value.characters.C001.plainBaked).toBe(true)
    expect(pickPoseVariant(r.value.characters.C001.forms.elementary)).toBe('character')
    // C001 の teen-wheelchair は plain だけ（焼き込み版かもしれない）なので導出しない。C002 の plain は人物のみなので導出する
    expect(derivePoses(r.value, ROOT, 'C001', 'teen-wheelchair')).toBeUndefined()
    expect(derivePoses(r.value, ROOT, 'C002', 'teen-wheelchair')).toBeDefined()
    // C001 の kindergarten / uniform は歩行絵が無い（walk: false）ので、主人公にすると警告
    expect(deriveWalkSprites(r.value, ROOT, 'C001', 'uniform')).toBeUndefined()
    expect(pickPoseVariant(r.value.characters.C002.forms['elementary-wheelchair'])).toBe('plain')
  })
  it('不正な形は理由つきで失敗', () => {
    expect(parseCharacterFormsManifest(null).ok).toBe(false)
    expect(parseCharacterFormsManifest({ characters: { C1: {} } }).ok).toBe(false)
    expect(
      parseCharacterFormsManifest({
        characters: { C1: { forms: { a: { poses: { plain: ['x'] }, walk: true } } } },
      }).ok
    ).toBe(false)
    expect(
      parseCharacterFormsManifest({ characters: { C1: { forms: { a: { poses: {}, walk: 1 } } } } })
        .ok
    ).toBe(false)
  })
})

describe('savedFormsOf（セーブの party[].form）', () => {
  it('id → form。形式の違う項目は読み飛ばす', () => {
    expect(
      savedFormsOf({
        party: [
          { id: 'party1', form: 'teen' },
          { id: 'party2' },
          { id: 3, form: 'x' },
          { id: 'p', form: '' },
          null,
        ],
      })
    ).toEqual({ party1: 'teen' })
    expect(savedFormsOf(undefined)).toEqual({})
    expect(savedFormsOf({ party: 'x' })).toEqual({})
  })
})

describe('expandCharacterForms（設定 JSON への展開）', () => {
  const cfg = () => ({
    characterForms: { root: ROOT, manifestUrl: 'm.json' },
    player: { character: 'C9', height: 150 },
    party: [
      { name: 'A', character: 'C9', form: 'a', sprite: 'old.png' },
      { name: 'B', id: 'bee', character: 'C9', form: 'b' },
      { name: 'No', hp: 1 },
    ],
  })
  const parts = (r: ReturnType<typeof expandCharacterForms>) =>
    r.raw as { player: Record<string, unknown>; party: Record<string, unknown>[] }

  it('characterForms が無い設定は何もしない（同じオブジェクトを返す）', () => {
    const raw = { party: [] }
    expect(expandCharacterForms(raw, manifest).raw).toBe(raw)
  })
  it('既定の形態で poses を埋め、手書きの sprite は外す。character の無い者は触らない。入力は書き換えない', () => {
    const input = cfg()
    const r = parts(expandCharacterForms(input, manifest))
    expect((r.party[0].poses as Record<string, string>).idle).toMatch(/C9-a-character-idle\.webp$/)
    expect(r.party[0].sprite).toBeUndefined()
    expect((r.party[1].poses as Record<string, string>).idle).toMatch(/C9-b-idle\.webp$/)
    expect(r.party[2]).toEqual({ name: 'No', hp: 1 })
    expect(input.party[0].sprite).toBe('old.png')
    expect((input.player as Record<string, unknown>).sprites).toBeUndefined()
  })
  it('主人公の歩行絵は同じ人物の味方（先頭）の形態から導く', () => {
    const r = parts(expandCharacterForms(cfg(), manifest))
    expect((r.player.sprites as Record<string, string[]>).up[0]).toMatch(/C9-a-walk-up-1\.webp$/)
    expect(r.player.cycle).toEqual([0, 1, 2, 1])
    expect(r.player.idleFrame).toBe(1)
    expect(r.player.height).toBe(150)
  })
  it('セーブの form（メンバー id 指定。id 省略は party1…）が既定に優先する', () => {
    const r = parts(expandCharacterForms(cfg(), manifest, { party1: 'c', bee: 'a' }))
    expect((r.party[0].poses as Record<string, string>).idle).toMatch(/C9-c-idle\.webp$/) // c は character 不完全→plain
    expect((r.party[1].poses as Record<string, string>).idle).toMatch(/C9-a-character-idle\.webp$/)
    expect((r.player.sprites as Record<string, string[]>).up[0]).toMatch(/C9-c-walk-up-1\.webp$/)
  })
  it('セーブの form が目録に無ければ警告して既定に戻す', () => {
    const r = expandCharacterForms(cfg(), manifest, { party1: 'nope' })
    expect(r.warnings.join('\n')).toMatch(/C9\/nope/)
    expect((parts(r).party[0].poses as Record<string, string>).idle).toMatch(/C9-a-character-idle/)
  })
  it('歩行絵が無い形態（b）の主人公は警告して sprites を埋めない', () => {
    const c = cfg()
    c.party = [{ name: 'B', character: 'C9', form: 'b', sprite: '' }]
    const r = expandCharacterForms(c, manifest)
    expect(r.warnings.join('\n')).toMatch(/歩行絵 C9\/b/)
    expect(parts(r).player.sprites).toBeUndefined()
  })
  it('形態の無い味方・root が無い設定は警告して手を入れない', () => {
    const c = cfg()
    c.party = [{ name: 'X', character: 'C9' } as never]
    expect(expandCharacterForms(c, manifest).warnings.join('\n')).toMatch(/form がありません/)
    const bad = { ...cfg(), characterForms: {} }
    expect(expandCharacterForms(bad, manifest).warnings.join('\n')).toMatch(/root/)
  })
})

describe('expandCharacterForms（同行者の歩行絵。#1119）', () => {
  type Cfg = Record<string, unknown>
  const base = (companion: Cfg, party: Cfg[] = []): Cfg => ({
    characterForms: { root: ROOT, manifestUrl: 'm.json' },
    player: { character: 'C9', form: 'a', height: 150 },
    companion,
    party,
  })
  const comp = (r: ReturnType<typeof expandCharacterForms>) =>
    (r.raw as { companion: Record<string, unknown> }).companion
  const up1 = (c: Record<string, unknown>) => (c.sprites as Record<string, string[]>).up[0]

  it('companion.form から 8 方向×3 コマを導き、立位の歩行周期を入れる。入力は書き換えない', () => {
    const input = base({ character: 'C9', form: 'c', name: 'Z', height: 140 })
    const r = expandCharacterForms(input, manifest)
    const c = comp(r)
    expect(up1(c)).toMatch(/C9-c-walk-up-1\.webp$/)
    expect(Object.keys(c.sprites as object)).toHaveLength(8)
    expect(c.cycle).toEqual([0, 1, 2, 1])
    expect(c.idleFrame).toBe(1)
    expect(c.name).toBe('Z')
    expect(c.height).toBe(140)
    expect((input.companion as Cfg).sprites).toBeUndefined()
    expect(r.warnings).toEqual([])
  })
  it('同じ人物の味方の形態が companion.form に優先する', () => {
    const r = expandCharacterForms(
      base({ character: 'C9', form: 'c' }, [{ name: 'A', character: 'C9', form: 'a' }]),
      manifest
    )
    expect(up1(comp(r))).toMatch(/C9-a-walk-up-1\.webp$/)
  })
  it('セーブの形態も味方経由で効く', () => {
    const r = expandCharacterForms(
      base({ character: 'C9', form: 'a' }, [{ name: 'A', character: 'C9', form: 'a' }]),
      manifest,
      { party1: 'c' }
    )
    expect(up1(comp(r))).toMatch(/C9-c-walk-up-1\.webp$/)
  })
  it('車椅子の形態は既定の周期のまま（cycle・idleFrame を入れない）', () => {
    const c = comp(expandCharacterForms(base({ character: 'C9', form: 'e-wheelchair' }), manifest))
    expect(up1(c)).toMatch(/C9-e-wheelchair-walk-up-1\.webp$/)
    expect(c.cycle).toBeUndefined()
    expect(c.idleFrame).toBeUndefined()
  })
  it('cycle 指定は尊重する', () => {
    const c = comp(
      expandCharacterForms(base({ character: 'C9', form: 'a', cycle: [0, 2] }), manifest)
    )
    expect(c.cycle).toEqual([0, 2])
    expect(c.idleFrame).toBeUndefined()
    expect(up1(c)).toMatch(/walk-up-1/)
  })
  it('目録に無い人物・形態、歩行絵の無い形態、form 無しは警告して sprites を埋めない', () => {
    for (const [companion, re] of [
      [{ character: 'NOPE', form: 'a' }, /companion の歩行絵 NOPE\/a/],
      [{ character: 'C9', form: 'nope' }, /companion の歩行絵 C9\/nope/],
      [{ character: 'C9', form: 'b' }, /companion の歩行絵 C9\/b/],
      [{ character: 'C9' }, /companion に form/],
    ] as [Cfg, RegExp][]) {
      const r = expandCharacterForms(base(companion), manifest)
      expect(r.warnings.join('\n')).toMatch(re)
      expect(comp(r).sprites).toBeUndefined()
      expect(comp(r)).toEqual(companion)
    }
  })
  it('人物の指定が無い同行者・手書きの sprites がある同行者は触らない', () => {
    const noChar = { name: 'Z', height: 100 }
    const r1 = expandCharacterForms(base(noChar), manifest)
    expect(comp(r1)).toBe(noChar)
    expect(r1.warnings).toEqual([])
    const hand = { character: 'C9', form: 'a', sprites: { up: ['x', 'y', 'z'] } }
    const r2 = expandCharacterForms(base(hand), manifest)
    expect(comp(r2)).toBe(hand)
    expect(r2.warnings).toEqual([])
  })
  it('同行者が無い設定、characterForms が無い設定は従来どおり', () => {
    const c = base({ character: 'C9', form: 'a' })
    delete c.companion
    expect('companion' in (expandCharacterForms(c, manifest).raw as object)).toBe(false)
    const raw = { companion: { character: 'C9', form: 'a' } }
    expect(expandCharacterForms(raw, manifest).raw).toBe(raw)
  })
  it('同行者の歩行絵 12 枚（4 方向×3 コマ）の URL', () => {
    const c = comp(expandCharacterForms(base({ character: 'C9', form: 'a' }), manifest))
    const s = c.sprites as Record<string, string[]>
    const urls = ['up', 'down', 'left', 'right'].flatMap((d) => s[d])
    expect(urls).toHaveLength(12)
    expect(urls[0]).toBe(`${ROOT}C9/walk/C9-a-walk-up-1.webp`)
    expect(urls).toContain(`${ROOT}C9/walk/C9-a-walk-down-2.webp`)
    expect(urls).toContain(`${ROOT}C9/walk/C9-a-walk-left-1.webp`)
    expect(urls[11]).toBe(`${ROOT}C9/walk/C9-a-walk-right-3.webp`)
    expect(urls).toContain(`${ROOT}C9/walk/C9-a-walk-right-3.webp`)
  })
})

describe('刀の指定（#1035。目録から導く）', () => {
  const WROOT = 'http://h/assets/images/weapons'
  const wm: CharacterFormsManifest = {
    characters: {
      CW: {
        weapon: {
          default: 'CW-muramasa-candidate.webp',
          images: ['CW-honebami-candidate.webp', 'CW-muramasa-candidate.webp'],
        },
        forms: {
          a: { poses: { plain: ALL }, walk: true },
          'a-wheelchair': { poses: { plain: ALL }, walk: true },
        },
      },
      CN: { forms: { a: { poses: { plain: ALL }, walk: true } } },
    },
  }
  const keys = (c: string, f: string, w?: string) => deriveWeaponKeys(wm, ROOT, WROOT, c, f, w)

  it('既定の刀・layers・カタログ・構造を命名規則で導く（立位は standing）', () => {
    expect(keys('CW', 'a')).toEqual({
      weapon: 'http://h/assets/images/weapons/CW/CW-muramasa-candidate.webp',
      'weapon-structure': 'standing',
      'weapon-layers': 'http://h/assets/images/characters/CW/battle-layers.json',
      'weapon-catalog': 'http://h/assets/images/weapons/CW/CW-blade-candidates.json',
    })
  })
  it('車椅子の形態は wheelchair（step は layers 側で刀なし）', () => {
    expect(keys('CW', 'a-wheelchair')?.['weapon-structure']).toBe('wheelchair')
  })
  it('刀を slug で選べる。候補に無ければ undefined', () => {
    expect(keys('CW', 'a', 'honebami')?.weapon).toMatch(/CW-honebami-candidate\.webp$/)
    expect(keys('CW', 'a', 'CW-honebami-candidate.webp')?.weapon).toMatch(/honebami/)
    expect(keys('CW', 'a', 'nothing')).toBeUndefined()
  })
  it('刀の項目が無い人物（C001 相当）・未知の人物は刀なし（{}）', () => {
    expect(keys('CN', 'a')).toEqual({})
    expect(keys('ZZ', 'a')).toEqual({})
    expect(keys('constructor', 'a')).toEqual({})
  })
  it('展開: weaponRoot があれば poses に刀の予約キーが入る。存在しない時期はエラーにならず導出しない', () => {
    const cfg = {
      characterForms: { root: ROOT, weaponRoot: WROOT, manifestUrl: 'm.json' },
      party: [
        { name: 'A', character: 'CW', form: 'a-wheelchair' },
        { name: 'B', character: 'CW', form: 'a', weapon: 'honebami' },
        { name: 'C', character: 'CN', form: 'a' },
        { name: 'D', character: 'CW', form: 'midlife' },
        { name: 'E', character: 'CW', form: 'a', weapon: 'bogus' },
      ],
    }
    const r = expandCharacterForms(cfg, wm)
    const party = (r.raw as { party: Record<string, unknown>[] }).party
    const poses = (i: number) => party[i].poses as Record<string, string>
    expect(poses(0)['weapon-structure']).toBe('wheelchair')
    expect(poses(0).idle).toMatch(/CW-a-wheelchair-idle\.webp$/)
    expect(poses(1).weapon).toMatch(/honebami/)
    expect(party[1]).not.toHaveProperty('weapon')
    expect(poses(2).weapon).toBeUndefined()
    expect(party[3].poses).toBeUndefined() // 存在しない時期: 手書きのまま・刀も付けない
    expect(poses(4).weapon).toMatch(/muramasa/) // 不明な刀は警告して既定へ
    expect(r.warnings.join('\n')).toMatch(/midlife/)
    expect(r.warnings.join('\n')).toMatch(/bogus/)
  })
  it('weaponRoot が無い設定は刀を導かない（従来どおり）', () => {
    const cfg = {
      characterForms: { root: ROOT, manifestUrl: 'm.json' },
      party: [{ name: 'A', character: 'CW', form: 'a' }],
    }
    const poses = (
      expandCharacterForms(cfg, wm).raw as { party: { poses: Record<string, string> }[] }
    ).party[0].poses
    expect(poses.weapon).toBeUndefined()
  })
  it('目録の weapon が不正（default が images に無い等）なら失敗', () => {
    const bad = { characters: { C1: { weapon: { default: 'x', images: ['y'] }, forms: {} } } }
    expect(parseCharacterFormsManifest(bad).ok).toBe(false)
  })
  it('目録の catalogOverrides の人物は weapon-overrides にカタログを指す', () => {
    const m2: CharacterFormsManifest = {
      characters: {
        CW: {
          ...wm.characters.CW,
          weapon: { ...wm.characters.CW.weapon!, catalogOverrides: true },
        },
      },
    }
    expect(deriveWeaponKeys(m2, ROOT, WROOT, 'CW', 'a')?.['weapon-overrides']).toBe(
      'http://h/assets/images/weapons/CW/CW-blade-candidates.json'
    )
    expect(keys('CW', 'a')).not.toHaveProperty('weapon-overrides')
  })
  it('同梱の目録: 既定の刀は C001=odenta-mitsuyo・C002=muramasa・C003=nagasone-kotetsu・C004=shichishito（C001 だけ overrides つき）。swing も全員導く（#165 解消後）', () => {
    const r = parseCharacterFormsManifest(JSON.parse(manifestText))
    if (!r.ok) throw new Error(r.error)
    const m = r.value
    const want = {
      C001: 'odenta-mitsuyo',
      C002: 'muramasa',
      C003: 'nagasone-kotetsu',
      C004: 'shichishito',
    }
    for (const [c, slug] of Object.entries(want)) {
      const k = deriveWeaponKeys(m, ROOT, WROOT, c, 'elementary')
      expect(k?.weapon).toContain(`-${slug}-`)
      expect(k?.['weapon-layers']).toBe(`${ROOT.replace(/\/$/, '')}/${c}/battle-layers.json`)
      expect(k !== undefined && 'weapon-overrides' in k).toBe(c === 'C001')
    }
    expect(
      deriveWeaponKeys(m, ROOT, WROOT, 'C002', 'elementary-wheelchair')?.['weapon-structure']
    ).toBe('wheelchair')
    for (const c of ['C001', 'C002'])
      expect(derivePoses(m, ROOT, c, 'elementary')).toHaveProperty('swing-windup')
  })
})
