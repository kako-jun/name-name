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

  it('遅い操作 → slow-op', () => {
    const r = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((_s, n) => {
        if (n === 0) {
          const t = performance.now()
          while (performance.now() - t < 20) {
            /* 待つ */
          }
        }
      }),
      slowOpMs: 5,
      driveLimit: 0,
    })
    expect(kindsOf(r)).toContain('slow-op')
  })

  it('run 経由: ログの NaN と、勝敗と生存者の食い違い', () => {
    const log = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 0) s.log.push('S に NaN の ダメージ！')
      }),
      driveLimit: 0,
    })
    expect(kindsOf(log)).toContain('bad-log-text')
    const phase = runScenario(scenarioOf(), {
      engineFactory: fakeFactory((s, n) => {
        if (n === 0) s.enemies[0].hp = 0 // 敵が全滅したのに phase は party-input のまま
      }),
      driveLimit: 0,
    })
    expect(kindsOf(phase)).toContain('phase-mismatch')
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
    // 注入される乱数列は scenario.seed で決まる（同じ seed なら同じ、違えば違う）
    const firstRoll = (seed: number): number => {
      let v = -1
      runScenario(scenarioOf({ seed }), {
        engineFactory: fakeFactory((_s, n, rng) => {
          if (n === 0) v = rng()
        }),
        driveLimit: 0,
      })
      return v
    }
    expect(firstRoll(1)).toBe(firstRoll(1))
    expect(firstRoll(1)).not.toBe(firstRoll(2))
  })

  it('実行はシナリオを書き換えない（同じシナリオを何度走らせても同じ）', () => {
    const before = JSON.stringify(normal)
    runScenario(normal)
    expect(JSON.stringify(normal)).toBe(before)
  })

  it('負の耐性・負のダメージ範囲でも HP は最大 HP を超えず、ダメージ表示も負にならない（#877 で修正済みの壊れ）', () => {
    for (const [resist, effect] of [
      [{ fire: -1 }, 'damage 10..10 type=fire'],
      [undefined, 'damage -5..-1 type=fire'],
    ] as const) {
      const s: Scenario = scenarioOf({
        id: 'test/negative',
        party: [entity('a')],
        enemies: [entity('s', resist ? { resist } : {})],
        spells: [{ name: 'ほのお', mp: 0, target: '敵単体', effect }],
        ops: [{ t: 'spell', s: 0 }],
      })
      expect(kindsOf(runScenario(s))).toEqual([])
    }
  })
})

describe('失敗の JSON から再現できる', () => {
  it('失敗ファイルを JSON 化 → 読み戻し → 再実行で同じ違反になる（id 指定で 1 件）', () => {
    const broken: Scenario = scenarioOf({
      id: 'test/repro',
      seed: 7,
      enemies: [entity('s'), entity('t')],
      spells: [{ name: 'ほのお', mp: 0, target: '敵全体', effect: 'damage 5..9 type=fire' }],
      ops: [{ t: 'spell', s: 0 }, { t: 'attack' }],
    })
    // 実エンジンはもう壊れないので、2 回目の操作で HP を最大 HP 超えにする合成エンジンで壊す
    const options = {
      engineFactory: fakeFactory((s, n) => {
        if (n === 1) s.enemies[0].hp = s.enemies[0].maxHp + 1
      }),
      driveLimit: 0,
    }
    const first = runScenario(broken, options)
    expect(first.violations.length).toBeGreaterThan(0)
    const text = JSON.stringify(toFailureFile([broken], [first]))
    const [again] = scenariosFromJson(JSON.parse(text), 'test/repro')
    expect(runScenario(again, options)).toEqual(first)
    expect(scenariosFromJson(JSON.parse(text), 'no-such')).toEqual([])
    // 単体のシナリオ JSON もそのまま読める
    expect(scenariosFromJson(JSON.parse(JSON.stringify(broken)))[0].id).toBe('test/repro')
  })
})
