/**
 * ハーネスの実行 (#877 段階 3) のテスト: 合成エンジンで「ロック・無限ループ・例外・NaN・負 HP」を仕込み、検出できること。
 * 実エンジンの正常な戦闘で誤検出しないこと・seed 固定で結果が再現すること・失敗の JSON から再現できること。
 */
import { describe, expect, it } from 'vitest'
import { entity } from './generate'
import { pushEvent, fakeFactory, scenarioOf } from './testing'
import { runScenario } from './run'
import { scenariosFromJson, toFailureFile } from './report'
import type { Scenario } from './scenario'

const kindsOf = (r: ReturnType<typeof runScenario>) => r.violations.map((v) => v.kind)

describe('runScenario: わざと壊した合成エンジンを検出する', () => {
  it('2 回目の操作で HP が NaN になる → non-finite（opIndex 1）', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 1) s.enemies[0].hp = NaN
      }),
      driveLimit: 0,
    })
    expect(kindsOf(r)).toContain('non-finite')
    expect(r.violations.find((v) => v.kind === 'non-finite')?.opIndex).toBe(1)
  })

  it('HP が負・maxHp 超過になる', () => {
    const neg = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 0) s.party[0].hp = -5
      }),
      driveLimit: 0,
    })
    expect(kindsOf(neg)).toContain('negative-hp')
    const over = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 0) s.party[0].hp = 101
      }),
      driveLimit: 0,
    })
    expect(kindsOf(over)).toContain('hp-over-max')
  })

  it('ダメージ上限違反（10000）を検出し、指標に 1 行動の合計ダメージが入る', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 0) {
          pushEvent(s, [
            {
              target: { side: 'enemy', index: 0 },
              kind: 'damage',
              amount: 10000,
              hpBefore: 100,
              hpAfter: 100,
            },
          ])
        }
      }),
      driveLimit: 0,
    })
    expect(kindsOf(r)).toContain('damage-over-cap')
    expect(r.metrics.maxEventDamage).toBe(10000)
  })

  it('ロック: 何も起きない（HP・状態・イベントが変わらない）まま決着しない → lock', () => {
    const r = runScenario(scenarioOf(), { engineFactory: fakeFactory(() => {}), lockRepeat: 5 })
    expect(kindsOf(r)).toEqual(['lock'])
    expect(r.metrics.ended).toBe(false)
  })

  it('膠着: 行動は起きる（イベントが増える）が HP が変わらない → stalemate（lock ではない）', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s) => {
        pushEvent(s, [])
      }),
      lockRepeat: 5,
    })
    expect(kindsOf(r)).toEqual(['stalemate'])
  })

  it('無限ループ: 1 操作で乱数を際限なく消費する → rng-budget（ハングせず止まる）', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((_s, _n, rng) => {
        for (;;) rng()
      }),
      rngBudgetPerOp: 1000,
    })
    expect(kindsOf(r)).toEqual(['rng-budget'])
    expect(r.violations[0].opIndex).toBe(0)
  })

  it('イベントの洪水（1 操作でイベントが閾値超）→ event-flood', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 0) for (let i = 0; i < 50; i++) pushEvent(s, [])
      }),
      eventFloodLimit: 10,
      driveLimit: 0,
    })
    expect(kindsOf(r)).toContain('event-flood')
  })

  it('エンジンが例外を投げる → exception（以降の操作は打ち切り）', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((_s, n) => {
        if (n === 1) throw new Error('boom')
      }),
    })
    expect(kindsOf(r)).toEqual(['exception'])
    expect(r.violations[0].detail).toContain('boom')
    expect(r.metrics.opsRun).toBe(2)
  })

  it('同じ種類の違反は maxPerKind 件まで', () => {
    const r = runScenario(
      scenarioOf({ ops: Array.from({ length: 10 }, () => ({ t: 'attack' as const })) }),
      {
        engineFactory: fakeFactory((s) => {
          s.party[0].hp = -1
        }),
        driveLimit: 0,
        maxPerKind: 2,
      }
    )
    expect(r.violations.filter((v) => v.kind === 'negative-hp')).toHaveLength(2)
  })
})

describe('runScenario: 実エンジン', () => {
  const normal: Scenario = scenarioOf({
    id: 'test/normal',
    seed: 42,
    party: [entity('a', { atk: 30 }), entity('b', { atk: 30 })],
    enemies: [entity('s', { hp: 80, maxHp: 80 }), entity('t', { hp: 80, maxHp: 80 })],
    spells: [{ name: 'ほのお', mp: 1, target: '敵全体', effect: 'damage 5..9 type=fire 回数=3' }],
    ops: [{ t: 'spell', s: 0 }, { t: 'attack' }, { t: 'attack' }],
  })

  it('正常な戦闘（従来ターン制・ATB wait / active）は違反なしで決着する', () => {
    for (const atb of [undefined, { mode: 'wait' as const }, { mode: 'active' as const }]) {
      const r = runScenario({ ...normal, atb })
      expect(r.violations).toEqual([])
      expect(r.metrics.ended).toBe(true)
    }
  })

  it('seed 固定で結果（違反・指標）が完全に再現する', () => {
    const a = runScenario({ ...normal, atb: { mode: 'active' } })
    const b = runScenario({ ...normal, atb: { mode: 'active' } })
    expect(b).toEqual(a)
    const c = runScenario({ ...normal, seed: 43, atb: { mode: 'active' } })
    expect(c.id).toBe(a.id) // seed が違っても実行できる（結果が同じとは限らない）
  })

  it('実行はシナリオを書き換えない（同じシナリオを何度走らせても同じ）', () => {
    const before = JSON.stringify(normal)
    runScenario(normal)
    expect(JSON.stringify(normal)).toBe(before)
  })

  it('既知の壊れ（負の耐性で HP が maxHp を超える）を実エンジンで検出する', () => {
    const broken: Scenario = scenarioOf({
      id: 'test/negative-resist',
      party: [entity('a')],
      enemies: [entity('s', { resist: { fire: -1 } })],
      spells: [{ name: 'ほのお', mp: 0, target: '敵単体', effect: 'damage 10..10 type=fire' }],
      ops: [{ t: 'spell', s: 0 }],
    })
    expect(kindsOf(runScenario(broken))).toContain('hp-over-max')
  })
})

describe('失敗の JSON から再現できる', () => {
  it('失敗ファイルを JSON 化 → 読み戻し → 再実行で同じ違反になる（id 指定で 1 件）', () => {
    const broken: Scenario = scenarioOf({
      id: 'test/repro',
      seed: 7,
      enemies: [entity('s', { resist: { fire: -1 } }), entity('t')],
      spells: [{ name: 'ほのお', mp: 0, target: '敵全体', effect: 'damage 5..9 type=fire' }],
      ops: [{ t: 'spell', s: 0 }, { t: 'attack' }],
    })
    const first = runScenario(broken)
    expect(first.violations.length).toBeGreaterThan(0)
    const text = JSON.stringify(toFailureFile([broken], [first]))
    const [again] = scenariosFromJson(JSON.parse(text), 'test/repro')
    expect(runScenario(again)).toEqual(first)
    expect(scenariosFromJson(JSON.parse(text), 'no-such')).toEqual([])
    // 単体のシナリオ JSON もそのまま読める
    expect(scenariosFromJson(JSON.parse(JSON.stringify(broken)))[0].id).toBe('test/repro')
  })
})
