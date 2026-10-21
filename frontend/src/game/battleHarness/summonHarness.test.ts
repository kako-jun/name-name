/** 検証ハーネスの召喚獣の族 (#750): 生成の決定性・形、検出器 `summon-invariant`、召喚の演出の欠落の検出、実エンジンで壊れが出ないこと */
import { describe, expect, it } from 'vitest'
import type { BattleActionEvent } from '../battleEngine'
import { checkState, isBroken, type ViolationKind } from './detect'
import { entity, summonScenarios } from './generate'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone, type HarnessEngine, type Scenario } from './scenario'
import { baseState, fakeFactory, scenarioOf } from './testing'

const kindsWith = (events: BattleActionEvent[], summonCueIds?: string[]): ViolationKind[] => {
  const s = baseState([entity('a')], [entity('s')])
  s.events = events
  s.eventTotal = events.length
  return checkState(s, events, 0, {
    maxDamage: 9999,
    ...(summonCueIds ? { summonCueIds } : {}),
  }).map((v) => v.kind)
}
const ev = (over: Partial<BattleActionEvent> = {}): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind: 'skill',
  label: 'x',
  hits: [],
  ...over,
})

describe('summonScenarios: 生成', () => {
  const all = summonScenarios()

  it('決定的で、id は一意・`summon/` で始まり、JSON にそのまま書き出せる', () => {
    expect(all.length).toBeGreaterThan(150)
    expect(summonScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('summon/'))).toBe(true)
    for (const s of all.filter((_, i) => i % 13 === 0)) expect(clone(s)).toEqual(s)
  })

  it('演出の変種（なし・名前だけ・絵つき・左向き）× 呼び方（召喚・わざ・敵の特技）× ターン制/ATB を含む', () => {
    for (const n of ['no-cue', 'name-only', 'full', 'faces-left']) {
      expect(
        all.some((s) => s.id.split('/')[2] === n),
        n
      ).toBe(true)
    }
    for (const how of ['summon', 'ability', 'enemy-skill']) {
      expect(
        all.some((s) => s.id.split('/')[3] === how),
        how
      ).toBe(true)
    }
    expect(all.some((s) => s.atb)).toBe(true)
    expect(all.some((s) => !s.atb)).toBe(true)
    // 対照（演出なし）は cue を持たない
    for (const s of all.filter((x) => x.id.split('/')[2] === 'no-cue')) {
      const execs = [...Object.values(s.skills ?? {}), ...(s.summons ?? []), ...(s.abilities ?? [])]
      expect(execs.length).toBeGreaterThan(0)
      expect(execs.every((e) => e.cue === undefined)).toBe(true)
    }
  })
})

describe('buildSweep: 族 summon', () => {
  it('buildSweep の最後に足され、skip で除ける。直前の族のシナリオは変わらない', () => {
    const heavy = [
      'effect-matrix',
      'enemy-skill',
      'stack-order',
      'reaction-chain',
      'random',
      'status-matrix',
      'random-status',
      'damage-condition',
      'magicite',
      'loot',
      'script',
      'random-script',
      'equipment',
      'job',
    ] as const
    const cfg = { randomSeed: 1, randomCount: 0, randomStatusCount: 0 }
    const withIt = buildSweep({ ...cfg, skip: [...heavy] })
    const without = buildSweep({ ...cfg, skip: [...heavy, 'summon'] })
    const all = summonScenarios()
    expect(withIt.length - without.length).toBe(all.length)
    expect(withIt.slice(0, without.length)).toEqual(without)
    expect(without.every((s) => s.id.startsWith('equipment/'))).toBe(true)
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })
})

describe('実エンジンで走らせる（全件）', () => {
  it('壊れが無く、演出つきの行動にだけ summon が付く', () => {
    for (const s of summonScenarios()) {
      const r = runScenario(s)
      expect(
        r.violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })
})

describe('checkState: 召喚獣の演出の不変条件 (summon-invariant)', () => {
  const cue = { id: 'b1', name: 'うみ' }
  it('宣言した id の演出が skill のイベントに付くのは正常', () => {
    expect(kindsWith([ev({ summon: cue })], ['b1'])).toEqual([])
    expect(
      kindsWith(
        [ev({ summon: { ...cue, image: 'a.webp', se: 'a.ogg', imaginary: true, faces: 'left' } })],
        ['b1']
      )
    ).toEqual([])
  })
  it('宣言していないシナリオに summon が付いたら検出する（旧挙動不変の検査）', () => {
    expect(kindsWith([ev({ summon: cue })])).toContain('summon-invariant')
    expect(kindsWith([ev()])).toEqual([])
  })
  it('宣言していない id・skill 以外のイベントは検出する', () => {
    expect(kindsWith([ev({ summon: { ...cue, id: 'zz' } })], ['b1'])).toContain('summon-invariant')
    expect(kindsWith([ev({ kind: 'attack', summon: cue })], ['b1'])).toContain('summon-invariant')
  })
  it('名前・id が空、画像/効果音が空、想像が偽、向きが left 以外は検出する', () => {
    const bad = (c: unknown): ViolationKind[] =>
      kindsWith([ev({ summon: c as BattleActionEvent['summon'] })], ['b1', ''])
    expect(bad({ id: 'b1', name: '' })).toContain('summon-invariant')
    expect(bad({ id: '', name: 'x' })).toContain('summon-invariant')
    expect(bad({ ...cue, image: '' })).toContain('summon-invariant')
    expect(bad({ ...cue, se: 1 })).toContain('summon-invariant')
    expect(bad({ ...cue, imaginary: false })).toContain('summon-invariant')
    expect(bad({ ...cue, faces: 'right' })).toContain('summon-invariant')
    expect(bad('x')).toContain('summon-invariant')
  })
  it('壊れとして数える', () => {
    expect(isBroken({ kind: 'summon-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})

describe('runScenario: 召喚の演出の欠落の検出', () => {
  const cue = { id: 'b1', name: 'うみ' }
  /** 召喚のたびに skill イベントを積む合成エンジン。`attach` が false なら演出を付けない */
  const factory = (attach: boolean) => {
    const base = fakeFactory(() => {})
    return (scenario: Scenario, rng: () => number): HarnessEngine => {
      const engine = base(scenario, rng)
      engine.selectSummon = (s) => {
        const st = engine.getState() as ReturnType<typeof baseState>
        st.events.push({
          seq: st.eventTotal++,
          actor: { side: 'party', index: 0 },
          kind: 'skill',
          label: s.name,
          hits: [],
          ...(attach ? { summon: cue } : {}),
        })
        st.party[0].summoned = true
        return true
      }
      return engine
    }
  }
  const sc = (): Scenario =>
    scenarioOf({
      summons: [{ name: 'うみ', target: '相手全体', mp: 0, cue }],
      ops: [{ t: 'summon', m: 0 }],
    })

  it('演出の元を持つ魔石の召喚に、同じ id の演出が付いていれば違反なし', () => {
    const r = runScenario(sc(), { engineFactory: factory(true), driveLimit: 0 })
    expect(r.violations).toEqual([])
  })
  it('付いていなければ検出する', () => {
    const r = runScenario(sc(), { engineFactory: factory(false), driveLimit: 0 })
    expect(r.violations.map((v) => v.kind)).toEqual(['summon-invariant'])
    expect(r.violations[0].detail).toContain('b1')
  })
  it('演出の元を持たない召喚は、付いていなくてよい', () => {
    const plain = scenarioOf({
      summons: [{ name: 'うみ', target: '相手全体', mp: 0 }],
      ops: [{ t: 'summon', m: 0 }],
    })
    expect(runScenario(plain, { engineFactory: factory(false), driveLimit: 0 }).violations).toEqual(
      []
    )
  })
})
