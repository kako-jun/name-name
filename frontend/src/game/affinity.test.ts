/** 属性相性 (#872): 解決関数・ダメージ適用・呪文/特技/アイテム/即死への適用・既存挙動不変 */
import { describe, it, expect } from 'vitest'
import {
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
  it('半減・弱点の death は即死に意味が無いので見ない（即死する）', () => {
    for (const aff of [{ halve: ['death'] }, { weak: ['death'] }]) {
      const t = ent({ affinity: aff })
      run('damage_full', t)
      expect(t.hp).toBe(0)
    }
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
  it('特技: 敵が味方に使う特技にも相性が効く（味方側の affinity）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500, affinity: { weak: ['ink'] } })
    const boss = ent({ id: 'boss', name: 'ボス' })
    const e = new BattleEngine([hero], [boss], { rng })
    const sk: SkillExecution = {
      name: 'すみ',
      target: '相手単体',
      effect: 'damage 10..10 type=ink',
    }
    e.performSkill({ side: 'enemy', index: 0 }, sk)
    expect(e.getState().party[0].hp).toBe(480)
    expect(lastHit(e)).toMatchObject({ kind: 'damage', amount: 20 })
  })
  it('アイテム: damage 効果にも相性が効く', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500, affinity: { absorb: ['fire'] } })
    hero.hp = 400
    const e = new BattleEngine([hero], [ent({ id: 'boss' })], { rng })
    e.selectItem({ name: 'ほのおのたま', effect: 'damage 30..30 type=fire' }, 'hero')
    // 直後に敵の通常攻撃が入るので、アイテム行動の記録（events[0]）で見る
    expect(lastHit(e)).toMatchObject({ kind: 'heal', amount: 30, hpBefore: 400, hpAfter: 430 })
  })
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
