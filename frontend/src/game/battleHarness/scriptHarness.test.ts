/** 検証ハーネスの脚本制御の族と `script-*` の検出 (#741 / #863) */
import { describe, expect, it } from 'vitest'
import { checkState, fingerprint, isBroken, type DetectOptions } from './detect'
import { entity } from './generate'
import { randomScriptScenarios, scriptMatrix } from './scriptFamily'
import { runScenario } from './run'
import { buildSweep } from './sweep'
import { baseState, fakeFactory, scenarioOf } from './testing'
import type { EngineFactory } from './scenario'
import type { BattleState } from '../battleEngine'

const OPTS: DetectOptions = { maxDamage: 9999, script: { ruleCount: 3 } }
const PLAIN: DetectOptions = { maxDamage: 9999 }

const kinds = (s: BattleState, opts: DetectOptions = OPTS) =>
  checkState(s, [], 0, opts)
    .filter((v) => v.kind === 'script-invariant')
    .map((v) => v.detail)

function scripted(over: Partial<NonNullable<BattleState['script']>> = {}): BattleState {
  const st = baseState([entity('hero'), entity('ally')], [entity('boss')])
  st.script = { id: 's', turn: 0, fired: [], joined: [], fled: [], ...over }
  return st
}

describe('checkState: 脚本の不変条件 (script-invariant)', () => {
  it('整合した状態は違反なし', () => {
    expect(kinds(scripted())).toEqual([])
    expect(kinds(scripted({ turn: 5, fired: [0, 2], joined: ['ally'] }))).toEqual([])
  })

  it('turn・fired・joined・fled・hpFloor の食い違いを検出する', () => {
    expect(kinds(scripted({ turn: -1 }))[0]).toContain('turn')
    expect(kinds(scripted({ turn: 1.5 }))[0]).toContain('turn')
    expect(kinds(scripted({ fired: [0, 0] }))[0]).toContain('fired')
    expect(kinds(scripted({ fired: [3] }))[0]).toContain('範囲外')
    expect(kinds(scripted({ fired: [-1] }))[0]).toContain('範囲外')
    expect(kinds(scripted({ joined: ['ghost'] }))[0]).toContain('ghost')
    expect(kinds(scripted({ joined: ['ally', 'ally'] }))[0]).toContain('joined')
    expect(kinds(scripted({ fled: [0] }))[0]).toContain('HP が 0 でない') // boss は生きている
    expect(kinds(scripted({ fled: [5] }))[0]).toContain('範囲外')
    const f = scripted()
    f.enemies[0].hpFloor = 0
    expect(kinds(f)[0]).toContain('hpFloor')
    f.enemies[0].hpFloor = 1.5
    expect(kinds(f)[0]).toContain('hpFloor')
    f.enemies[0].hpFloor = f.enemies[0].maxHp + 1
    expect(kinds(f)[0]).toContain('hpFloor')
    f.enemies[0].hpFloor = f.enemies[0].maxHp
    expect(kinds(f)).toEqual([])
  })

  it('逃げた敵（HP 0）は正しい。脚本のある戦闘に state.script が無いのは違反', () => {
    const st = scripted({ fled: [0] })
    st.enemies[0].hp = 0
    expect(kinds(st)).toEqual([])
    expect(kinds(baseState([entity('a')], [entity('s')]))[0]).toContain('state.script が無い')
  })

  it('脚本の無い戦闘: state.script・interrupted・hpFloor があれば違反。無ければ何も言わない', () => {
    expect(kinds(baseState([entity('a')], [entity('s')]), PLAIN)).toEqual([])
    const a = baseState([entity('a')], [entity('s')])
    a.script = { id: 'x', turn: 0, fired: [], joined: [], fled: [] }
    expect(kinds(a, PLAIN)[0]).toContain('state.script がある')
    const b = baseState([entity('a')], [entity('s')], 'interrupted')
    expect(kinds(b, PLAIN)[0]).toContain('interrupted')
    const c = baseState([entity('a')], [entity('s')])
    c.party[0].hpFloor = 1
    expect(kinds(c, PLAIN)[0]).toContain('hpFloor')
  })
})

describe('checkState: 脚本が決めた勝敗は生存者と食い違ってよい', () => {
  it('脚本のある戦闘の victory（敵が生きている）・defeat（味方が生きている）・interrupted は違反でない', () => {
    for (const phase of ['victory', 'defeat', 'interrupted'] as const) {
      const st = scripted()
      st.phase = phase
      expect(
        checkState(st, [], 0, OPTS).filter((v) => v.kind === 'phase-mismatch'),
        phase
      ).toEqual([])
    }
  })

  it('脚本の無い戦闘では従来どおり食い違いを検出する（旧挙動不変）', () => {
    const v = baseState([entity('a')], [entity('s')], 'victory')
    expect(checkState(v, [], 0, PLAIN).some((x) => x.kind === 'phase-mismatch')).toBe(true)
    const d = baseState([entity('a')], [entity('s')], 'defeat')
    expect(checkState(d, [], 0, PLAIN).some((x) => x.kind === 'phase-mismatch')).toBe(true)
  })

  it('脚本のある戦闘でも、終わっていないのに全員倒れているのは進行不能として検出する', () => {
    const st = scripted()
    st.enemies[0].hp = 0
    expect(checkState(st, [], 0, OPTS).some((x) => x.kind === 'phase-mismatch')).toBe(true)
  })
})

describe('fingerprint: 脚本のターンを含む', () => {
  it('HP が同じでもターンが進めば指紋が変わる（上限ターンまで押し続ける戦闘をロックと取り違えない）', () => {
    const a = scripted({ turn: 1 })
    const b = scripted({ turn: 2 })
    expect(fingerprint(a)).not.toBe(fingerprint(b))
    // 脚本の無い戦闘の指紋は、脚本の項が null のまま（従来と同じ入力で同じ）
    const p = baseState([entity('a')], [entity('s')])
    expect(fingerprint(p)).toBe(fingerprint(baseState([entity('a')], [entity('s')])))
  })
})

describe('runScenario: scriptExpect（必ず決着・期待の終わり方・ターン上限）', () => {
  /** 脚本のある戦闘の形（最初から state.script を持つ）にした合成エンジンの工場 */
  const withScript =
    (inner: EngineFactory): EngineFactory =>
    (sc, rng) => {
      const e = inner(sc, rng)
      const st = e.getState() as BattleState
      st.script = { id: 's', turn: 0, fired: [], joined: [], fled: [] }
      return e
    }
  /** 3 操作目で決着する合成エンジン */
  const ending = (phase: BattleState['phase'], turn: number): EngineFactory =>
    withScript(
      fakeFactory((state, n) => {
        if (n >= 2) {
          state.phase = phase
          if (state.script) state.script.turn = turn
        }
      })
    )
  const idle = (): EngineFactory => withScript(fakeFactory(() => {}))

  it('決着しない（何もしない）脚本のシナリオは script-no-end', () => {
    const r = runScenario(
      scenarioOf({ script: { id: 's', rules: [] }, scriptExpect: { ends: ['victory'] } }),
      { engineFactory: idle(), driveLimit: 30, lockRepeat: 1000 }
    )
    expect(r.violations.some((v) => v.kind === 'script-no-end')).toBe(true)
    expect(r.violations.filter(isBroken).length).toBeGreaterThan(0)
  })

  it('期待しない終わり方は script-outcome。期待どおり・ターン内なら違反なし', () => {
    const base = scenarioOf({
      script: { id: 's', rules: [] },
      scriptExpect: { ends: ['victory'], maxTurn: 5 },
    })
    const bad = runScenario(base, { engineFactory: ending('defeat', 1) })
    expect(bad.violations.some((v) => v.kind === 'script-outcome')).toBe(true)
    const over = runScenario(base, { engineFactory: ending('victory', 6) })
    expect(over.violations.some((v) => v.detail.includes('上限'))).toBe(true)
    const ok = runScenario(base, { engineFactory: ending('victory', 5) })
    expect(ok.violations.filter((v) => v.kind.startsWith('script-'))).toEqual([])
  })

  it('scriptExpect の無いシナリオ・driveLimit 0 は決着を要求しない', () => {
    const none = runScenario(scenarioOf({ script: { id: 's', rules: [] } }), {
      engineFactory: idle(),
      driveLimit: 5,
      lockRepeat: 1000,
    })
    expect(none.violations.some((v) => v.kind === 'script-no-end')).toBe(false)
    const noDrive = runScenario(
      scenarioOf({ script: { id: 's', rules: [] }, scriptExpect: { ends: ['victory'] } }),
      { engineFactory: idle(), driveLimit: 0 }
    )
    expect(noDrive.violations.some((v) => v.kind === 'script-no-end')).toBe(false)
  })
})

describe('脚本の族（本物のエンジン）', () => {
  it('シナリオ id は一意で JSON に書き出せ、脚本の期待を持つ', () => {
    const all = [...scriptMatrix(), ...randomScriptScenarios(1, 50)]
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    for (const s of all) {
      expect(s.id.startsWith('script/') || s.id.startsWith('random-script/')).toBe(true)
      expect(s.script).toBeDefined()
      expect(s.scriptExpect).toBeDefined()
      expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    }
  })

  it('総当たりは全件が決着し、壊れが 0（勝敗固定が膠着しない・床をすり抜けない）', () => {
    const results = scriptMatrix().map((s) => runScenario(s))
    const broken = results.filter((r) => r.violations.some(isBroken))
    expect(broken.map((r) => `${r.id}: ${r.violations[0].detail}`)).toEqual([])
    expect(results.every((r) => r.metrics.ended)).toBe(true)
  })

  it('固定した結果で終わる（勝利・敗北・中断それぞれ）', () => {
    const byWord = (w: string) =>
      scriptMatrix()
        .filter((s) => s.id.startsWith(`script/fixed/${w}/`))
        .map((s) => runScenario(s).metrics.finalPhase)
    expect(new Set(byWord('勝利'))).toEqual(new Set(['victory']))
    expect(new Set(byWord('敗北'))).toEqual(new Set(['defeat']))
    expect(new Set(byWord('中断'))).toEqual(new Set(['interrupted']))
  })

  it('ランダム合成（seed 固定）は壊れ 0・同じ seed なら同じ結果', () => {
    const run = () => randomScriptScenarios(3, 150).map((s) => runScenario(s))
    const a = run()
    expect(a.filter((r) => r.violations.some(isBroken)).map((r) => r.id)).toEqual([])
    expect(JSON.stringify(a)).toBe(JSON.stringify(run()))
  })

  it('buildSweep: script / random-script は HARNESS_SKIP で外せる。外すと既存の族だけになる', () => {
    const all = buildSweep({
      randomSeed: 1,
      randomCount: 3,
      randomStatusCount: 3,
      randomScriptCount: 4,
    })
    const skipped = buildSweep({
      randomSeed: 1,
      randomCount: 3,
      randomStatusCount: 3,
      randomScriptCount: 4,
      skip: ['script', 'random-script'],
    })
    expect(all.length - skipped.length).toBe(scriptMatrix().length + 4)
    expect(
      skipped.some((s) => s.id.startsWith('script/') || s.id.startsWith('random-script/'))
    ).toBe(false)
  })
})
