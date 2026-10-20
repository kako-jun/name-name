/** 敵が使う特技 (#834) の土台: 相対対象の解決・効果 DSL / builtin の再利用・MP なし・演出イベントの記録 */
import { describe, it, expect } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import { eventTimeline, sampleActor } from './battleMotion'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 5,
    maxMp: 5,
    atk: 5,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}
const rng = () => 0

function setup() {
  const party = [ent({ id: 'hero', name: 'ゆうしゃ' }), ent({ id: 'mage', name: 'まほうつかい' })]
  const enemies = [
    ent({ id: 'kraken', name: 'クラーケン', hp: 50, maxHp: 100 }),
    ent({ id: 'tentacle', name: 'しょくしゅ', hp: 40, maxHp: 100 }),
  ]
  const engine = new BattleEngine(party, enemies, { rng })
  return { engine, party, enemies }
}

const dmg = (target: string, effect = 'damage 10..10'): SkillExecution => ({
  name: 'すみはき',
  target,
  effect,
})

describe('performSkill: 相対対象の解決 (#834)', () => {
  it('敵が使う「相手単体」は味方側の最初の生存者に当たる', () => {
    const { engine, party, enemies } = setup()
    expect(engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'))).toBe(true)
    expect(party[0].hp).toBe(90)
    expect(party[1].hp).toBe(100)
    expect(enemies.map((e) => e.hp)).toEqual([50, 40])
  })

  it('対象の省略は相手単体。最初が倒れていれば次の生存者', () => {
    const { engine, party } = setup()
    party[0].hp = 0
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'x', target: '', effect: 'damage 7..7' }
    )
    expect(party[1].hp).toBe(93)
  })

  it('相手単体は明示した相手側の生存者に当たる。倒れている者・味方側の指定は無視して最初の生存者', () => {
    const { engine, party, enemies } = setup()
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'), { side: 'party', index: 1 })
    expect(party.map((p) => p.hp)).toEqual([100, 90])
    party[1].hp = 0
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'), { side: 'party', index: 1 })
    expect(party[0].hp).toBe(90)
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'), { side: 'enemy', index: 1 })
    expect(enemies.map((e) => e.hp)).toEqual([50, 40])
    expect(party[0].hp).toBe(80)
  })

  it('相手全体は相手側の生存者全員（倒れた者は除く）', () => {
    const { engine, party, enemies } = setup()
    party[1].hp = 0
    engine.performSkill({ side: 'enemy', index: 1 }, dmg('相手全体'))
    expect(party.map((p) => p.hp)).toEqual([90, 0])
    expect(enemies.map((e) => e.hp)).toEqual([50, 40])
  })

  it('自分は使った本人だけ', () => {
    const { engine, party, enemies } = setup()
    engine.performSkill({ side: 'enemy', index: 1 }, dmg('自分', 'heal 15..15'))
    expect(enemies.map((e) => e.hp)).toEqual([50, 55])
    expect(party.map((p) => p.hp)).toEqual([100, 100])
  })

  it('仲間単体 / 仲間全体は使った側（敵）の味方。味方（プレイヤー側）には及ばない', () => {
    const { engine, party, enemies } = setup()
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('仲間単体', 'heal 5..5'), {
      side: 'enemy',
      index: 1,
    })
    expect(enemies.map((e) => e.hp)).toEqual([50, 45])
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('仲間全体', 'heal 10..10'))
    expect(enemies.map((e) => e.hp)).toEqual([60, 55])
    expect(party.map((p) => p.hp)).toEqual([100, 100])
  })

  it('仲間単体の既定は使った側の最初の生存者', () => {
    const { engine, enemies } = setup()
    engine.performSkill({ side: 'enemy', index: 1 }, dmg('仲間単体', 'heal 5..5'))
    expect(enemies.map((e) => e.hp)).toEqual([55, 40])
  })

  it('同じ語彙をプレイヤー側が使えば「相手」は敵側（将来用の対称性）', () => {
    const { engine, party, enemies } = setup()
    engine.performSkill({ side: 'party', index: 0 }, dmg('相手全体'))
    expect(enemies.map((e) => e.hp)).toEqual([40, 30])
    expect(party.map((p) => p.hp)).toEqual([100, 100])
  })

  it('前後の空白は無視、未知の対象は相手単体', () => {
    const { engine, party } = setup()
    engine.performSkill({ side: 'enemy', index: 0 }, dmg(' 相手全体 '))
    expect(party.map((p) => p.hp)).toEqual([90, 90])
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('敵単体'))
    expect(party.map((p) => p.hp)).toEqual([80, 90])
  })
})

describe('performSkill: 効果・MP・状態 (#834)', () => {
  it('効果 DSL を評価し、使った側の MP は消費しない', () => {
    const { engine, enemies } = setup()
    enemies[0].mp = 0
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'))
    expect(enemies[0].mp).toBe(0)
    const { engine: e2, enemies: en2 } = setup()
    e2.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'))
    expect(en2[0].mp).toBe(5)
  })

  it('builtin があれば builtin を評価する（呪文のレジストリを共有）', () => {
    const { engine, party } = setup()
    // zaraki は rng < 0.5 で即死
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'ぜんたいしんぱく', target: '相手全体', builtin: 'zaraki' }
    )
    expect(party.map((p) => p.hp)).toEqual([0, 0])
  })

  it('効果定義がなければ使用メッセージだけ出して成立する（MISS も警告ログも出さない）', () => {
    const { engine } = setup()
    expect(
      engine.performSkill({ side: 'enemy', index: 0 }, { name: 'にらむ', target: '相手単体' })
    ).toBe(true)
    expect(engine.getState().log.slice(-1)[0]).toMatch('にらむ を つかった')
    expect(engine.getState().log.join('')).not.toContain('効果定義なし')
    expect(engine.getState().events.slice(-1)[0].hits).toEqual([])
  })

  it('使えない: 倒れている・存在しない使い手は何もせず false（ログ・イベントも増えない）', () => {
    const { engine, party, enemies } = setup()
    enemies[0].hp = 0
    const total = engine.getState().eventTotal
    const logs = engine.getState().logTotal
    expect(engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'))).toBe(false)
    expect(engine.performSkill({ side: 'enemy', index: 9 }, dmg('相手単体'))).toBe(false)
    expect(party.map((p) => p.hp)).toEqual([100, 100])
    expect(engine.getState().eventTotal).toBe(total)
    expect(engine.getState().logTotal).toBe(logs)
  })

  it('フェーズ・勝敗は動かさない（呼び出し側の責務）', () => {
    const { engine, party } = setup()
    party.forEach((p) => (p.hp = 5))
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手全体'))
    expect(party.map((p) => p.hp)).toEqual([0, 0])
    expect(engine.getState().phase).toBe('party-input')
  })

  it('対象の解決は rng を使わない。効果 DSL の評価だけが消費する', () => {
    let calls = 0
    const counting = () => {
      calls++
      return 0
    }
    const party = [ent({ id: 'hero' }), ent({ id: 'mage' })]
    const enemies = [ent({ id: 'k' })]
    const engine = new BattleEngine(party, enemies, { rng: counting })
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'x', target: '相手全体', effect: 'damage 1..1' }
    )
    expect(calls).toBe(0) // min==max は乱数を引かない
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'x', target: '相手全体', effect: 'damage 1..9' }
    )
    expect(calls).toBe(1) // 効果 1 回の評価で 1 回（対象の数に依らない）
  })
})

describe('performSkill: 終了後・倒れた対象・蘇生 (#834)', () => {
  it('戦闘が終わっていれば false で、HP・ログ・イベントは変わらない', () => {
    for (const phase of ['victory', 'defeat', 'escaped'] as const) {
      const { engine, party } = setup()
      ;(engine.getState() as { phase: string }).phase = phase
      const total = engine.getState().eventTotal
      const logs = engine.getState().logTotal
      expect(engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手全体'))).toBe(false)
      expect(party.map((p) => p.hp)).toEqual([100, 100])
      expect(engine.getState().eventTotal).toBe(total)
      expect(engine.getState().logTotal).toBe(logs)
    }
  })

  it('仲間単体で明示した対象が倒れていても、蘇生でなければ最初の生存者に落ちる（死者は生き返らない）', () => {
    const { engine, enemies } = setup()
    enemies[1].hp = 0
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('仲間単体', 'heal 10..10'), {
      side: 'enemy',
      index: 1,
    })
    expect(enemies.map((e) => e.hp)).toEqual([60, 0])
  })

  it('蘇生の特技（効果 revive / builtin zaorik）は倒れた仲間を明示でき、省略時は最初の倒れた仲間', () => {
    const { engine, enemies } = setup()
    enemies[1].hp = 0
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('仲間単体', 'revive hp=half'), {
      side: 'enemy',
      index: 1,
    })
    expect(enemies[1].hp).toBeGreaterThan(0)
    enemies[1].hp = 0
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('仲間単体', 'revive'))
    expect(enemies[1].hp).toBeGreaterThan(0)
    enemies[1].hp = 0
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'いのり', target: '仲間単体', builtin: 'zaorik' }
    )
    expect(enemies[1].hp).toBeGreaterThan(0)
  })

  it('蘇生でも倒れた仲間がいなければ最初の生存者が対象になる', () => {
    const { engine, enemies } = setup()
    engine.performSkill({ side: 'enemy', index: 1 }, dmg('仲間単体', 'revive'))
    expect(enemies.map((e) => e.hp)).toEqual([50, 40])
    expect(engine.getState().events[0].hits[0].target).toEqual({ side: 'enemy', index: 0 })
  })
})

describe('performSkill: ログと演出イベント (#834)', () => {
  it('kind skill・label は特技名・message は {user} を置換した文・hits は結果を持つ', () => {
    const { engine } = setup()
    engine.performSkill(
      { side: 'enemy', index: 0 },
      {
        name: 'すみはき',
        target: '相手全体',
        effect: 'damage 10..10',
        message: '{user}は 墨を はいた！',
      }
    )
    const s = engine.getState()
    expect(s.eventTotal).toBe(1)
    const ev = s.events[0]
    expect(ev.kind).toBe('skill')
    expect(ev.label).toBe('すみはき')
    expect(ev.message).toBe('クラーケンは 墨を はいた！')
    expect(ev.actor).toEqual({ side: 'enemy', index: 0 })
    expect(ev.hits).toEqual([
      {
        target: { side: 'party', index: 0 },
        kind: 'damage',
        amount: 10,
        hpBefore: 100,
        hpAfter: 90,
      },
      {
        target: { side: 'party', index: 1 },
        kind: 'damage',
        amount: 10,
        hpBefore: 100,
        hpAfter: 90,
      },
    ])
    expect(s.log.slice(-3)).toEqual([
      'クラーケンは 墨を はいた！',
      'ゆうしゃ に 10 のダメージ！',
      'まほうつかい に 10 のダメージ！',
    ])
  })

  it('message が無ければ既定文、イベントに message は付かない。回復は heal', () => {
    const { engine } = setup()
    engine.performSkill({ side: 'enemy', index: 1 }, dmg('自分', 'heal 10..10'))
    const s = engine.getState()
    expect(s.log).toContain('しょくしゅ は すみはき を つかった！')
    const ev = s.events[0]
    expect('message' in ev).toBe(false)
    expect(ev.hits).toEqual([
      { target: { side: 'enemy', index: 1 }, kind: 'heal', amount: 10, hpBefore: 40, hpAfter: 50 },
    ])
  })

  it('演出の時間割: skill は構えの時間（呪文と同じ）・使い手は cast ポーズ', () => {
    const { engine } = setup()
    engine.performSkill({ side: 'enemy', index: 0 }, dmg('相手単体'))
    const tl = eventTimeline(engine.getState().events[0])
    expect(tl.duration).toBeGreaterThan(0)
    expect(sampleActor('skill', 0).pose).toBe('cast')
  })

  it('決定論的: 同じ状態・同じ rng 列なら同じ結果', () => {
    const run = () => {
      let i = 0
      const seq = [0.1, 0.9, 0.4, 0.7]
      const party = [ent({ id: 'hero' }), ent({ id: 'mage' })]
      const enemies = [ent({ id: 'k', name: 'K' })]
      const engine = new BattleEngine(party, enemies, { rng: () => seq[i++ % seq.length] })
      engine.performSkill(
        { side: 'enemy', index: 0 },
        { name: 'x', target: '相手全体', effect: 'damage 5..20' }
      )
      engine.performSkill(
        { side: 'enemy', index: 0 },
        { name: 'x', target: '相手単体', effect: 'damage 5..20' }
      )
      return { json: JSON.stringify(engine.getState()), hp: party.map((p) => p.hp) }
    }
    expect(run().json).toBe(run().json)
    // rng 列 0.1 → 6、0.9 → 19（5 + floor(r * 16)）。全体で 6、続く単体（先頭）で 19
    expect(run().hp).toEqual([75, 94])
  })
})

describe('行動を書かない敵の挙動は不変 (#834)', () => {
  it('performSkill を呼ばない限り、通常攻撃の rng 消費・イベントは従来どおり', () => {
    const calls: number[] = []
    const party = [ent({ id: 'hero' })]
    const enemies = [ent({ id: 'slime', atk: 8 })]
    const engine = new BattleEngine(party, enemies, {
      rng: () => {
        calls.push(1)
        return 0
      },
    })
    engine.selectAttack()
    // 味方の攻撃 1 回 + 敵の反撃 1 回 = 乱数 2 回、イベントは attack 2 件のみ
    expect(calls).toHaveLength(2)
    expect(engine.getState().events.map((e) => e.kind)).toEqual(['attack', 'attack'])
  })
})

describe('[特技] マスターデータ: 実 WASM パーサ経由 (#834)', () => {
  it('parseMarkdown → collectMasterData で skills に入り、呪文とは別。performSkill に渡せる', async () => {
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
        '[呪文 メラ]',
        '名前: メラ',
        'MP: 2',
        '効果: damage 8..14',
        '[/呪文]',
        '',
        '[特技 ink]',
        '名前: すみはき',
        '対象: 相手全体',
        '効果: damage 10..10',
        'メッセージ: {user}は 墨を はいた！',
        '予兆: ふるえている',
        '[/特技]',
        '',
      ].join('\n')
    )
    const m = collectMasterData(doc)
    expect(Object.keys(m.spells)).toEqual(['メラ'])
    expect(Object.keys(m.skills)).toEqual(['ink'])
    const sk = m.skills['ink']
    expect(sk).toMatchObject({
      name: 'すみはき',
      target: '相手全体',
      effect: 'damage 10..10',
      message: '{user}は 墨を はいた！',
      telegraph: 'ふるえている',
    })
    expect('mp' in sk).toBe(false)

    const { engine, party } = setup()
    engine.performSkill({ side: 'enemy', index: 0 }, sk)
    expect(party.map((p) => p.hp)).toEqual([90, 90])
    expect(engine.getState().events[0].message).toBe('クラーケンは 墨を はいた！')
  })
})

describe('selectSkill: 味方の「わざ」(#873)', () => {
  const ability = (target: string, effect = 'damage 10..10'): SkillExecution => ({
    name: 'きりさく',
    target,
    effect,
  })

  it('相手単体: targetId の敵に当たり、MP は減らず、ログと skill イベントが残り、ターンが敵へ進む', () => {
    const { engine, party, enemies } = setup()
    const total = engine.getState().eventTotal
    expect(engine.selectSkill(ability('相手単体'), 'tentacle')).toBe(true)
    expect(enemies.map((e) => e.hp)).toEqual([50, 30])
    expect(party[0].mp).toBe(5)
    expect(
      engine.getState().log.some((l) => l.includes('ゆうしゃ は きりさく を つかった！'))
    ).toBe(true)
    expect(engine.getState().eventTotal).toBeGreaterThan(total)
    expect(engine.getState().events.some((e) => e.kind === 'skill')).toBe(true)
  })

  it('targetId 省略は最初の生存者、倒れた敵を指しても生存者に落ちる', () => {
    const { engine, enemies } = setup()
    enemies[0].hp = 0
    engine.selectSkill(ability('相手単体'), 'kraken')
    expect(enemies.map((e) => e.hp)).toEqual([0, 30])
  })

  it('相手全体は敵全員、仲間単体は targetId の味方、自分は使い手本人', () => {
    const { engine, party, enemies } = setup()
    party[1].hp = 10
    engine.selectSkill(ability('相手全体', 'damage 5..5'))
    expect(enemies.map((e) => e.hp)).toEqual([45, 35])
    const s2 = setup()
    s2.party[1].hp = 10
    s2.engine.selectSkill(ability('仲間単体', 'heal 20..20'), 'mage')
    expect(s2.party[1].hp).toBe(30) // 敵ターンの反撃は使い手（先頭）に向かう
    const s3 = setup()
    s3.party[0].hp = 50
    s3.engine.selectSkill(ability('自分', 'heal 20..20'))
    expect(s3.party[0].hp).toBeGreaterThan(50) // 回復 +20 のあと敵ターンの被弾ぶんは引かれる
  })

  it('入力待ちでないフェーズ・終了後は何もせず false', () => {
    const { engine, enemies } = setup()
    ;(engine.getState() as { phase: string }).phase = 'victory'
    expect(engine.selectSkill(ability('相手単体'))).toBe(false)
    expect(enemies.map((e) => e.hp)).toEqual([50, 40])
  })

  it('敵の「受けた=物理」はわざにも成立する（物理で反撃する敵が、わざを受けても反撃する）', () => {
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', hp: 500, maxHp: 500 })
    const boss = ent({
      id: 'boss',
      name: 'ボス',
      hp: 900,
      maxHp: 900,
      atk: 0,
      counters: ['条件=受けた=物理 候補=lance'],
    })
    const lance: SkillExecution = {
      name: 'こおりのやり',
      target: '相手単体',
      effect: 'damage 20..20',
    }
    const eng = new BattleEngine([hero], [boss], { rng, skills: { lance } })
    eng.selectSkill(ability('相手単体', 'damage 3..3'))
    const kinds = eng.getState().events.map((e) => `${e.actor.side}:${e.kind}`)
    expect(kinds.slice(0, 2)).toEqual(['party:skill', 'enemy:skill']) // わざ → 反撃
    expect(hero.hp).toBeLessThan(500 - 19)
    // 魔法では反撃しない（カテゴリは magic）
    const hero2 = ent({ id: 'hero', hp: 500, maxHp: 500, mp: 9 })
    const boss2 = ent({
      id: 'boss',
      hp: 900,
      maxHp: 900,
      atk: 0,
      counters: ['条件=受けた=物理 候補=lance'],
    })
    const eng2 = new BattleEngine([hero2], [boss2], { rng, skills: { lance } })
    eng2.selectSpell({ name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 3..3' })
    expect(eng2.getState().events.some((e) => e.actor.side === 'enemy' && e.kind === 'skill')).toBe(
      false
    )
  })
})
