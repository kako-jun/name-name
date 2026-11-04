// #1020: 人物の形態（時期・車椅子）から poses・歩行絵を命名規則で導く純関数と、設定 JSON への展開。
import { describe, expect, it } from 'vitest'
import manifestText from '../../public/field-sample/sit-character-forms.json?raw'
import {
  DERIVED_POSES,
  deriveWalkSprites,
  derivePoses,
  expandCharacterForms,
  parseCharacterFormsManifest,
  pickPoseVariant,
  savedFormsOf,
  walkGait,
  type CharacterFormsManifest,
} from './characterForms'

const ROOT = 'http://h/assets/images/characters/'
const ALL = [...DERIVED_POSES]

/** 小さな合成の目録: a=人物単体版が揃う、b=plain だけ、c=人物単体版が欠ける（plain が揃う）、d=character の方が多いが不完全 */
const manifest: CharacterFormsManifest = {
  characters: {
    C9: {
      forms: {
        a: { poses: { plain: ALL, character: ALL }, walk: true },
        b: { poses: { plain: ALL }, walk: false },
        c: { poses: { plain: ALL, character: ['idle', 'ready'] }, walk: true },
        d: { poses: { plain: ['idle'], character: ['idle', 'ready', 'slash'] }, walk: false },
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
  it('絵が 1 枚も無ければ undefined', () =>
    expect(pickPoseVariant({ poses: {}, walk: false })).toBeUndefined())
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
  it('同梱の目録: 寺町サンプルの 4 人（C002 小学生車椅子・C001/C003/C004 小学生）は 8 ポーズ揃い、C001 は人物単体版', () => {
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
    expect(pickPoseVariant(r.value.characters.C001.forms.elementary)).toBe('character')
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
