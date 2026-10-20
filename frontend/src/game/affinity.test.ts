/** 属性相性 (#872): 解決関数・ダメージ適用・呪文/特技/アイテム/即死への適用・既存挙動不変 */
import { describe, it, expect } from 'vitest'
import {
  normalizeAttrId,
  DEATH_CHANCE_CAP,
  deathSuccessRate,
  rollDeath,
  affinityField,
  applyAffinityToDamage,
  resolveAffinity,
  type AffinityKind,
  type BattleAffinity,
} from './affinity'
import { applyEffect, parseEffect, type BattleEntity, type EffectContext } from './spellDsl'
import { invokeBuiltinSpell } from './builtin'
import { BattleEngine } from './battleEngine'
import type { SkillExecution } from './battleEngine'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import { rollEncounter } from './encounter'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'テキ',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 5,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

function run(effect: string, target: BattleEntity, rng: () => number = () => 0) {
  const parsed = parseEffect(effect)!
  const amounts: Array<{ kind: string; amount: number }> = []
  const ctx: EffectContext = {
    caster: ent({ id: 'c' }),
    targets: [target],
    rng,
    onAmount: (_t, kind, amount) => amounts.push({ kind, amount }),
  }
  const log = applyEffect(parsed, ctx)
  return { log, amounts }
}

describe('resolveAffinity: 優先順位のデシジョンテーブル（1 属性を 4 欄の全部分集合に置く）', () => {
  const order: Array<[keyof BattleAffinity, AffinityKind]> = [
    ['absorb', 'absorb'],
    ['nullify', 'nullify'],
    ['halve', 'halve'],
    ['weak', 'weak'],
  ]
  for (let mask = 1; mask < 16; mask++) {
    const cols = order.filter((_, i) => mask & (1 << i))
    it(`欄 ${cols.map(([c]) => c).join('+')} → ${cols[0][1]}（最上位の欄で打ち切り）`, () => {
      const aff: BattleAffinity = {}
      for (const [c] of cols) aff[c] = ['fire']
      expect(resolveAffinity(aff, 'fire')).toBe(cols[0][1])
    })
  }
  it('どの欄にも無い属性は normal', () => {
    expect(resolveAffinity({ weak: ['ice'], absorb: ['thunder'] }, 'fire')).toBe('normal')
  })
})

describe('resolveAffinity: 境界・不正値', () => {
  const aff: BattleAffinity = { weak: ['ice'], nullify: ['death'] }
  it('相性なし・type なし・空 type は normal（無属性は相性の対象外）', () => {
    expect(resolveAffinity(undefined, 'ice')).toBe('normal')
    expect(resolveAffinity(aff, undefined)).toBe('normal')
    expect(resolveAffinity(aff, '')).toBe('normal')
    expect(resolveAffinity(aff, '  ')).toBe('normal')
  })
  it('全角の type（ＦＩＲＥ）も parser と同じく半角に寄せて比べる', () => {
    expect(resolveAffinity({ weak: ['fire'] }, 'ＦＩＲＥ')).toBe('weak')
    expect(resolveAffinity({ weak: ['thunder_2'] }, 'Ｔｈｕｎｄｅｒ＿２')).toBe('weak')
  })
  it('Rust が正規化しない文字は JS でも変換しない（半角カナ・丸数字・合字は NFKC しない）', () => {
    expect(normalizeAttrId('ﾎﾉｵ')).toBe('ﾎﾉｵ')
    expect(normalizeAttrId('①')).toBe('①')
    expect(normalizeAttrId('ﬁre')).toBe('ﬁre')
    expect(resolveAffinity({ weak: ['ホノオ'] }, 'ﾎﾉｵ')).toBe('normal')
    expect(resolveAffinity({ weak: ['1'] }, '①')).toBe('normal')
  })
  it('normalizeAttrId は Rust の表（全角英数・＿・－ だけ半角、小文字）と同じ', () => {
    expect(normalizeAttrId('ＦｉＲｅ０９＿ａ－Ｚ')).toBe('fire09_a-z')
    expect(normalizeAttrId('火')).toBe('火')
  })
  it('type の大小・前後空白は寄せて比べる', () => {
    expect(resolveAffinity(aff, 'ICE')).toBe('weak')
    expect(resolveAffinity(aff, ' ice ')).toBe('weak')
  })
  it('Object.prototype のメンバー名は一致しない (#368)', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'length']) {
      expect(resolveAffinity(aff, k)).toBe('normal')
    }
  })
  it('欄が配列でない（壊れたデータ）でも例外を投げず normal', () => {
    expect(resolveAffinity({ weak: 'ice' as unknown as string[] }, 'ice')).toBe('normal')
  })
  it('欄が空配列・undefined でも落ちない', () => {
    expect(resolveAffinity({ weak: [], halve: undefined }, 'ice')).toBe('normal')
  })
})

describe('applyAffinityToDamage', () => {
  it.each([
    ['weak', 10, 20],
    ['weak', 0, 0],
    ['weak', 1, 2],
    ['halve', 10, 5],
    ['halve', 9, 4],
    ['halve', 2, 1],
    ['halve', 1, 1], // 最低 1
    ['halve', 0, 0], // 元が 0 なら 0 のまま
    ['nullify', 99, 0],
    ['normal', 7, 7],
    ['absorb', 7, 7], // 吸収は回復する量＝元の値
  ] as Array<[AffinityKind, number, number]>)('%s %i → %i', (kind, base, expected) => {
    expect(applyAffinityToDamage(kind, base)).toBe(expected)
  })
})

describe('affinityField', () => {
  it('無い・全欄空は {}（書かない敵の BattleEntity を変えない）', () => {
    expect(affinityField(undefined)).toEqual({})
    expect(affinityField({})).toEqual({})
    expect(affinityField({ weak: [], absorb: [] })).toEqual({})
  })
  it('空でない欄だけを複製して写す', () => {
    const src: BattleAffinity = { weak: ['ice'], halve: [], absorb: ['thunder'] }
    const out = affinityField(src) as { affinity: BattleAffinity }
    expect(out).toEqual({ affinity: { weak: ['ice'], absorb: ['thunder'] } })
    expect(out.affinity.weak).not.toBe(src.weak)
  })
})

describe('damage: 属性相性の適用 (#872)', () => {
  it('弱点は 2 倍（通知もログも 2 倍の値）', () => {
    const t = ent({ affinity: { weak: ['water'] } })
    const { log, amounts } = run('damage 10..10 type=water', t)
    expect(t.hp).toBe(80)
    expect(amounts).toEqual([{ kind: 'damage', amount: 20 }])
    expect(log).toEqual(['テキ に 20 のダメージ！'])
  })

  it('半減は切り捨て・最低 1', () => {
    const t = ent({ affinity: { halve: ['fire'] } })
    run('damage 9..9 type=fire', t)
    expect(t.hp).toBe(96)
    const t2 = ent({ affinity: { halve: ['fire'] } })
    const { amounts } = run('damage 1..1 type=fire', t2)
    expect(t2.hp).toBe(99)
    expect(amounts).toEqual([{ kind: 'damage', amount: 1 }])
  })

  it('無効は HP 不変・通知なし（戦闘側で MISS）・追加効果なし', () => {
    const t = ent({ affinity: { nullify: ['wind'] } })
    const { log, amounts } = run('damage 30..30 type=wind', t)
    expect(t.hp).toBe(100)
    expect(amounts).toEqual([])
    expect(log).toEqual(['テキ には きかなかった！'])
  })

  it('吸収は HP を回復（通知は heal・最大 HP で切る）', () => {
    const t = ent({ hp: 70, affinity: { absorb: ['thunder'] } })
    const { log, amounts } = run('damage 20..20 type=thunder', t)
    expect(t.hp).toBe(90)
    expect(amounts).toEqual([{ kind: 'heal', amount: 20 }])
    expect(log).toEqual(['テキ は 20 のダメージを吸収した！'])
    const t2 = ent({ hp: 95, affinity: { absorb: ['thunder'] } })
    run('damage 20..20 type=thunder', t2)
    expect(t2.hp).toBe(100) // maxHp を超えない
  })

  it('吸収は倒れている対象を生き返らせない', () => {
    const t = ent({ hp: 0, affinity: { absorb: ['thunder'] } })
    run('damage 20..20 type=thunder', t)
    expect(t.hp).toBe(0)
  })

  it('弱点で倒れたら「たおれた」', () => {
    const t = ent({ hp: 15, affinity: { weak: ['ice'] } })
    const { log } = run('damage 10..10 type=ice', t)
    expect(t.hp).toBe(0)
    expect(log).toEqual(['テキ に 20 のダメージ！', 'テキ は たおれた！'])
  })

  it('優先順位: 同じ属性が吸収と弱点に居れば吸収（データが壊れていても打ち切り）', () => {
    const t = ent({ hp: 50, affinity: { weak: ['fire'], absorb: ['fire'] } })
    run('damage 10..10 type=fire', t)
    expect(t.hp).toBe(60)
  })

  it('相性が該当しなければ従来の resist へフォールバック', () => {
    const t = ent({ affinity: { weak: ['ice'] }, resist: { fire: 0.5 } })
    run('damage 10..10 type=fire', t)
    expect(t.hp).toBe(95)
  })

  it('相性が該当したら resist は見ない（二重掛けしない）', () => {
    const t = ent({ affinity: { weak: ['fire'] }, resist: { fire: 0.5 } })
    run('damage 10..10 type=fire', t)
    expect(t.hp).toBe(80)
  })

  it('無属性（type なし）は相性があっても等倍', () => {
    const t = ent({ affinity: { weak: ['fire'], nullify: ['death'], absorb: ['none'] } })
    run('damage 10..10', t)
    expect(t.hp).toBe(90)
  })

  it('複数の対象に対象ごとの相性を当てる（乱数は 1 回だけ消費）', () => {
    const a = ent({ id: 'a', name: 'A', affinity: { weak: ['fire'] } })
    const b = ent({ id: 'b', name: 'B', affinity: { absorb: ['fire'] }, hp: 50 })
    const c = ent({ id: 'c', name: 'C' })
    let calls = 0
    const ctx: EffectContext = {
      caster: a,
      targets: [a, b, c],
      rng: () => (calls++, 0),
    }
    applyEffect(parseEffect('damage 8..12 type=fire')!, ctx)
    expect(calls).toBe(1)
    expect([a.hp, b.hp, c.hp]).toEqual([84, 58, 92])
  })
})

describe('既存挙動の不変（affinity を持たない敵）', () => {
  const effects = [
    'damage 8..14 type=fire',
    'damage 5..9',
    'damage_full',
    'heal 10..20',
    'damage 10..10 type=constructor',
  ]
  it.each(effects)('%s: affinity なし / 空の affinity で結果・乱数消費が同一', (e) => {
    const results = [undefined, {}, { weak: [], absorb: [] }].map((aff) => {
      let calls = 0
      const t = ent({ hp: 60, resist: { fire: 0.5 }, ...(aff ? { affinity: aff } : {}) })
      const out = run(e, t, () => (calls++, 0.37))
      return JSON.stringify({ hp: t.hp, out, calls })
    })
    expect(results[1]).toBe(results[0])
    expect(results[2]).toBe(results[0])
  })

  it('resist 経路のスナップショット: 半減・弱点・無効（0）・未登録', () => {
    const snap = (resist: Record<string, number> | undefined, type: string) => {
      const t = ent({ resist })
      const { log, amounts } = run(`damage 10..10 type=${type}`, t)
      return { hp: t.hp, log, amounts }
    }
    expect(snap({ fire: 0.5 }, 'fire')).toEqual({
      hp: 95,
      log: ['テキ に 5 のダメージ！'],
      amounts: [{ kind: 'damage', amount: 5 }],
    })
    expect(snap({ ice: 2 }, 'ice')).toEqual({
      hp: 80,
      log: ['テキ に 20 のダメージ！'],
      amounts: [{ kind: 'damage', amount: 20 }],
    })
    expect(snap({ wind: 0 }, 'wind')).toEqual({
      hp: 100,
      log: ['テキ に 0 のダメージ！'],
      amounts: [],
    })
    expect(snap({ fire: 0.5 }, 'ice')).toEqual({
      hp: 90,
      log: ['テキ に 10 のダメージ！'],
      amounts: [{ kind: 'damage', amount: 10 }],
    })
  })
})

describe('即死 (damage_full / zaraki) の即死耐性: 属性 id death (#872)', () => {
  it('耐性なしは従来どおり即死（HP 全部）', () => {
    const t = ent({ hp: 77 })
    const { amounts } = run('damage_full', t)
    expect(t.hp).toBe(0)
    expect(amounts).toEqual([{ kind: 'damage', amount: 77 }])
  })
  it('無効: death は効かない（HP 不変・通知なし）', () => {
    const t = ent({ affinity: { nullify: ['death'] } })
    const { log, amounts } = run('damage_full', t)
    expect(t.hp).toBe(100)
    expect(amounts).toEqual([])
    expect(log).toEqual(['テキ には きかなかった！'])
  })
  it('吸収: death も効かない（回復はしない）', () => {
    const t = ent({ hp: 40, affinity: { absorb: ['death'] } })
    const { amounts } = run('damage_full', t)
    expect(t.hp).toBe(40)
    expect(amounts).toEqual([])
  })
  it('death 以外の無効は即死を止めない', () => {
    const t = ent({ affinity: { nullify: ['fire'] } })
    run('damage_full', t)
    expect(t.hp).toBe(0)
  })
  it('death の相性は通常の damage には影響しない', () => {
    const t = ent({ affinity: { nullify: ['death'] } })
    run('damage 10..10', t)
    expect(t.hp).toBe(90)
  })
  it('既存の resist: {death: 0} は damage_full では従来どおり見ない（未決のため変えない）', () => {
    const t = ent({ resist: { death: 0 } })
    run('damage_full', t)
    expect(t.hp).toBe(0)
  })
  it('zaraki: death の無効・吸収は rng に関係なく効かない / 相性なしは従来どおり', () => {
    for (const aff of [{ nullify: ['death'] }, { absorb: ['death'] }]) {
      const t = ent({ affinity: aff })
      const log = invokeBuiltinSpell('zaraki', { caster: t, targets: [t], rng: () => 0 })
      expect(t.hp).toBe(100)
      expect(log).toEqual(['テキ には きかなかった！'])
    }
    const plain = ent()
    invokeBuiltinSpell('zaraki', { caster: plain, targets: [plain], rng: () => 0 })
    expect(plain.hp).toBe(0)
    const resisted = ent({ resist: { death: 0 } })
    invokeBuiltinSpell('zaraki', { caster: resisted, targets: [resisted], rng: () => 0 })
    expect(resisted.hp).toBe(100)
  })
})

describe('即死の成功率: death の相性で変わる (#872)', () => {
  it('上限は 0.99（定数 1 か所）', () => {
    expect(DEATH_CHANCE_CAP).toBe(0.99)
  })

  // 4 欄 + 相性なし × 既定の成功率（100% / 50% / 境界 0% / 30% / 80%）
  const table: Array<[AffinityKind, number, number]> = [
    ['normal', 1, 1],
    ['normal', 0.5, 0.5],
    ['normal', 0, 0],
    ['nullify', 1, 0],
    ['nullify', 0.5, 0],
    ['absorb', 1, 0],
    ['absorb', 0.5, 0],
    ['halve', 1, 0.5],
    ['halve', 0.5, 0.25],
    ['halve', 0, 0],
    // 弱点: ×2 を上限 0.99 で頭打ち。ただし元の率を下回らない（既定 100% は弱点でも 100%）
    ['weak', 1, 1],
    ['weak', 0.5, 0.99],
    ['weak', 0.3, 0.6],
    ['weak', 0.8, 0.99],
    ['weak', 0.99, 0.99],
    ['weak', 0, 0],
  ]
  it.each(table)('%s × 既定 %d → %d', (kind, base, expected) => {
    expect(deathSuccessRate(kind, base)).toBeCloseTo(expected, 10)
  })

  it('rollDeath: 境界（率 1 以上・0 以下は乱数を使わない）', () => {
    let calls = 0
    const rng = () => (calls++, 0.5)
    expect(rollDeath(1, rng)).toBe(true)
    expect(rollDeath(1.5, rng)).toBe(true)
    expect(rollDeath(0, rng)).toBe(false)
    expect(rollDeath(-1, rng)).toBe(false)
    expect(calls).toBe(0)
  })
  it('rollDeath: 0 < 率 < 1 は乱数を 1 回だけ使い、rng < 率 で成功（境界: rng = 率は失敗）', () => {
    let calls = 0
    const at = (v: number) => () => (calls++, v)
    expect(rollDeath(0.5, at(0))).toBe(true)
    expect(rollDeath(0.5, at(0.4999))).toBe(true)
    expect(rollDeath(0.5, at(0.5))).toBe(false)
    expect(rollDeath(0.5, at(0.99))).toBe(false)
    expect(calls).toBe(4)
  })

  describe('damage_full（既定 100%）', () => {
    const hit = (aff: BattleAffinity | undefined, r: number) => {
      let calls = 0
      const t = ent({ ...(aff ? { affinity: aff } : {}) })
      const { amounts } = run('damage_full', t, () => (calls++, r))
      return { hp: t.hp, calls, amounts }
    }
    it('相性なし・弱点（100% のまま）は乱数を使わず確実に即死', () => {
      expect(hit(undefined, 0.999)).toMatchObject({ hp: 0, calls: 0 })
      expect(hit({ weak: ['death'] }, 0.999)).toMatchObject({ hp: 0, calls: 0 })
    })
    it('無効・吸収は乱数を使わず確実に失敗（MISS: 通知なし）', () => {
      for (const aff of [{ nullify: ['death'] }, { absorb: ['death'] }]) {
        expect(hit(aff, 0)).toEqual({ hp: 100, calls: 0, amounts: [] })
      }
    })
    it('半減: 成功率 50%。乱数を 1 回使い、rng 固定で成功・失敗の両方', () => {
      const ok = hit({ halve: ['death'] }, 0.49)
      expect(ok).toMatchObject({ hp: 0, calls: 1 })
      const ng = hit({ halve: ['death'] }, 0.5)
      expect(ng).toEqual({ hp: 100, calls: 1, amounts: [] })
    })
  })

  describe('zaraki（既定 50%）', () => {
    const cast = (aff: BattleAffinity | undefined, r: number) => {
      let calls = 0
      const t = ent({ ...(aff ? { affinity: aff } : {}) })
      invokeBuiltinSpell('zaraki', { caster: t, targets: [t], rng: () => (calls++, r) })
      return { hp: t.hp, calls }
    }
    it('相性なしは従来どおり（rng 1 回・< 0.5 で成功）', () => {
      expect(cast(undefined, 0.49)).toEqual({ hp: 0, calls: 1 })
      expect(cast(undefined, 0.5)).toEqual({ hp: 100, calls: 1 })
    })
    it('半減 25%・弱点 99%', () => {
      expect(cast({ halve: ['death'] }, 0.24)).toEqual({ hp: 0, calls: 1 })
      expect(cast({ halve: ['death'] }, 0.25)).toEqual({ hp: 100, calls: 1 })
      expect(cast({ weak: ['death'] }, 0.98)).toEqual({ hp: 0, calls: 1 })
      expect(cast({ weak: ['death'] }, 0.99)).toEqual({ hp: 100, calls: 1 })
    })
    it('無効・吸収は乱数を使わず効かない', () => {
      expect(cast({ nullify: ['death'] }, 0)).toEqual({ hp: 100, calls: 0 })
      expect(cast({ absorb: ['death'] }, 0)).toEqual({ hp: 100, calls: 0 })
    })
  })

  it('エンジン経由: 半減デスの失敗は MISS・成功は倒れる', () => {
    const mk = (r: number) => {
      const hero = ent({ id: 'hero', hp: 500, maxHp: 500, mp: 9, maxMp: 9 })
      const boss = ent({ id: 'boss', affinity: { halve: ['death'] } })
      const e = new BattleEngine([hero], [boss], { rng: () => r })
      e.selectSpell({ name: 'デス', mp: 1, target: '敵単体', effect: 'damage_full' })
      return e
    }
    const ng = mk(0.9)
    expect(ng.getState().enemies[0].hp).toBe(100)
    expect(ng.getState().events[0].hits[0].kind).toBe('miss')
    const ok = mk(0.1)
    expect(ok.getState().enemies[0].hp).toBe(0)
  })
})

describe('戦闘エンジン経由: 呪文・特技・アイテム (#872)', () => {
  const rng = () => 0
  function engineWith(enemy: Partial<BattleEntity>) {
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', mp: 50, maxMp: 50, hp: 500, maxHp: 500 })
    const e = new BattleEngine([hero], [ent({ id: 'boss', name: 'ボス', ...enemy })], { rng })
    return e
  }
  const spell = (effect: string) => ({ name: 'まほう', mp: 1, target: '敵単体', effect })
  const lastHit = (e: BattleEngine) => e.getState().events[0].hits[0]

  it('呪文: 弱点は 2 倍のダメージ数字', () => {
    const e = engineWith({ affinity: { weak: ['water'] } })
    e.selectSpell(spell('damage 10..10 type=water'))
    expect(e.getState().enemies[0].hp).toBe(80)
    expect(lastHit(e)).toMatchObject({ kind: 'damage', amount: 20 })
  })
  it('呪文: 半減', () => {
    const e = engineWith({ affinity: { halve: ['fire'] } })
    e.selectSpell(spell('damage 10..10 type=fire'))
    expect(lastHit(e)).toMatchObject({ kind: 'damage', amount: 5 })
  })
  it('呪文: 無効は MISS', () => {
    const e = engineWith({ affinity: { nullify: ['wind'] } })
    e.selectSpell(spell('damage 10..10 type=wind'))
    expect(e.getState().enemies[0].hp).toBe(100)
    expect(lastHit(e).kind).toBe('miss')
  })
  it('呪文: 吸収は heal の数字（満タンでも計算上の量）', () => {
    const e = engineWith({ affinity: { absorb: ['thunder'] } })
    e.selectSpell(spell('damage 10..10 type=thunder'))
    expect(e.getState().enemies[0].hp).toBe(100)
    expect(lastHit(e)).toMatchObject({ kind: 'heal', amount: 10 })
    const e2 = engineWith({ hp: 60, affinity: { absorb: ['thunder'] } })
    e2.selectSpell(spell('damage 10..10 type=thunder'))
    expect(e2.getState().enemies[0].hp).toBe(70)
    expect(lastHit(e2)).toMatchObject({ kind: 'heal', amount: 10, hpBefore: 60, hpAfter: 70 })
  })
  it('呪文: 即死 (damage_full) の death 無効は MISS', () => {
    const e = engineWith({ affinity: { nullify: ['death'] } })
    e.selectSpell(spell('damage_full'))
    expect(e.getState().enemies[0].hp).toBe(100)
    expect(lastHit(e).kind).toBe('miss')
  })
  it('特技: 味方が敵に使う特技にも相性が効く（敵の affinity）', () => {
    const e = engineWith({ affinity: { weak: ['ink'] } })
    const sk: SkillExecution = {
      name: 'すみ',
      target: '相手単体',
      effect: 'damage 10..10 type=ink',
    }
    e.performSkill({ side: 'party', index: 0 }, sk)
    expect(e.getState().enemies[0].hp).toBe(80)
    expect(lastHit(e)).toMatchObject({ kind: 'damage', amount: 20 })
  })
  it('特技: 吸収も敵の affinity で効く', () => {
    const e = engineWith({ hp: 60, affinity: { absorb: ['fire'] } })
    e.performSkill(
      { side: 'party', index: 0 },
      { name: 'ひ', target: '相手単体', effect: 'damage 30..30 type=fire' }
    )
    expect(e.getState().enemies[0].hp).toBe(90)
    expect(lastHit(e)).toMatchObject({ kind: 'heal', amount: 30, hpBefore: 60, hpAfter: 90 })
  })
  // アイテムの damage 効果も同じ applyEffect を通る（上の applyEffect 直接テストが担保）。
  // エンジンの selectItem は味方単体だけを対象にするので、敵の affinity を試すエンジン経由のテストは作れない
  it('通常攻撃は相性を見ない（未対応）', () => {
    const e = engineWith({ affinity: { nullify: ['death', 'fire'], absorb: ['thunder'] } })
    e.selectAttack()
    expect(e.getState().enemies[0].hp).toBeLessThan(100)
  })
})

describe('実 WASM パーサ → 戦闘への組み立て (#872)', () => {
  it('弱点:/半減:/無効:/吸収: が BattleEntity.affinity に写り、書かない敵は affinity を持たない', async () => {
    const doc = await parseMarkdown(
      [
        '---',
        'engine: name-name',
        'chapter: 1',
        'title: t',
        '---',
        '',
        '## data: マスター',
        '',
        '[モンスター boss]',
        '名前: ボス',
        'HP: 100',
        '弱点: Water, ICE',
        '半減: fire',
        '無効: wind、death',
        '吸収: thunder',
        '[/モンスター]',
        '',
        '[モンスター plain]',
        '名前: ふつう',
        'HP: 5',
        '[/モンスター]',
        '',
      ].join('\n')
    )
    const m = collectMasterData(doc)
    const boss = m.monsters['boss']
    expect(boss.affinity).toEqual({
      weak: ['water', 'ice'],
      halve: ['fire'],
      nullify: ['wind', 'death'],
      absorb: ['thunder'],
    })
    expect('affinity' in m.monsters['plain']).toBe(false)
    const [b, p] = rollEncounter({
      rate: 1,
      groups: ['boss+plain'],
      masters: m.monsters,
      rng: () => 0,
    })!
    expect(b.affinity).toEqual(boss.affinity)
    expect('affinity' in p).toBe(false)
    // 実パース経路の敵に呪文を撃つ
    const t = b
    run('damage 10..10 type=water', t)
    expect(t.hp).toBe(80)
  })
})

describe('吸収で計算量が 0 のとき (#872)', () => {
  it('エンジン経由では MISS 表示（仕様）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500, mp: 9, maxMp: 9 })
    const boss = ent({ id: 'boss', hp: 50, affinity: { absorb: ['fire'] } })
    const e = new BattleEngine([hero], [boss], { rng: () => 0 })
    e.selectSpell({ name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 0..0 type=fire' })
    expect(e.getState().enemies[0].hp).toBe(50)
    expect(e.getState().events[0].hits[0]).toMatchObject({ kind: 'miss', amount: 0 })
  })
  it('回復・通知・ログを出さない', () => {
    const t = ent({ hp: 50, affinity: { absorb: ['fire'] } })
    const { log, amounts } = run('damage 0..0 type=fire', t)
    expect(t.hp).toBe(50)
    expect(amounts).toEqual([])
    expect(log).toEqual([])
  })
})
