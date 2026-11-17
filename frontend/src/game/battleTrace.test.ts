/**
 * 戦闘の内部トレース (#1197): 記録点・再現（トレースから BattleEngine を再実行して結果が一致する）・off の無害さ。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BattleEngine } from './battleEngine'
import { attachBattleTrace } from './battleTrace'
import type { BattleEntity } from './spellDsl'
import { configureTrace, resetTraceForTest, traceDump, type TraceEntry } from '../trace/trace'
import { extractBattles, firstMismatch, replayBattle } from '../trace/traceReplay'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: `NAME-${id}`,
    hp: 30,
    maxHp: 30,
    mp: 5,
    maxMp: 5,
    atk: 12,
    def: 1,
    agi: 5,
    ...over,
  }
}

const SPELL = { name: 'ファイア', mp: 2, target: '敵単体', effect: 'damage 20' }

afterEach(() => resetTraceForTest())

/** ATB の戦闘を、細かい tick と入力で最後まで進める */
function playOut(engine: BattleEngine): void {
  let guard = 0
  while (!engine.isOver() && guard++ < 5000) {
    const cur = engine.getCurrentActorIndex()
    if (cur >= 0) {
      if (guard % 3 === 0) engine.selectSpell(SPELL, 'e0')
      else engine.selectAttack()
    } else {
      engine.tick(16.7)
    }
  }
}

const compared = (es: readonly TraceEntry[]): TraceEntry[] =>
  es.filter((e) => ['b.act', 'b.hp', 'b.ko', 'b.rev', 'b.phase', 'b.actor'].includes(e.k))

describe('battleTrace (#1197)', () => {
  it('off: 何も付かず、乱数は従来どおり（種なし）', () => {
    const e = new BattleEngine([ent('p0')], [ent('e0')], { atb: {} })
    expect(e.getRngSeed()).toBeUndefined()
    expect(attachBattleTrace(e)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(e, 'tick')).toBe(false)
  })

  it('on: 開始・入力・行動・HP の変化・倒れ・フェーズ・入力権の移動が記録される', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [ent('p0', { hp: 5, maxHp: 5, agi: 1 })],
      [ent('e0', { hp: 40, maxHp: 40, atk: 99, agi: 30 })],
      {
        atb: {},
      }
    )
    expect(typeof e.getRngSeed()).toBe('number')
    attachBattleTrace(e)
    let guard = 0
    while (!e.isOver() && guard++ < 2000) e.tick(100)
    const kinds = traceDump().session.entries.map((x) => x.k)
    expect(kinds).toContain('b.start')
    expect(kinds).toContain('b.act')
    expect(kinds).toContain('b.hp')
    expect(kinds).toContain('b.ko')
    expect(kinds).toContain('b.phase')
    const ko = traceDump().session.entries.find((x) => x.k === 'b.ko')
    expect(ko?.d).toMatchObject({ s: 0, i: 0 })
    const act = traceDump().session.entries.find((x) => x.k === 'b.act')
    // 行動 1 件に、対象・種類・HP の前後が入る
    expect((act?.d as { hits: unknown[][] }).hits[0].slice(0, 2)).toEqual([0, 0])
  })

  it('個人情報: 名前は開始の記録にも入らない', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine([ent('p0')], [ent('e0')], { atb: {} })
    attachBattleTrace(e)
    expect(JSON.stringify(traceDump())).not.toContain('NAME-')
  })

  it('毎フレームは取らない: 16.7ms の tick を 600 回呼んでも記録は数十件に収まる', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [ent('p0', { hp: 9999, maxHp: 9999 })],
      [ent('e0', { hp: 9999, maxHp: 9999, atk: 0 })],
      {
        atb: { mode: 'active' },
      }
    )
    attachBattleTrace(e)
    const before = traceDump().session.total
    for (let i = 0; i < 600; i++) e.tick(16.7)
    const added = traceDump().session.total - before
    expect(added).toBeLessThan(60)
  })

  it('再現: トレース JSON から再実行すると、行動・HP・倒れ・フェーズが一致する', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [ent('p0', { hp: 60, maxHp: 60 }), ent('p1', { hp: 60, maxHp: 60, agi: 8 })],
      [ent('e0', { hp: 90, maxHp: 90, atk: 14, agi: 6 })],
      { atb: {} }
    )
    attachBattleTrace(e)
    playOut(e)
    expect(e.isOver()).toBe(true)

    // JSON を経由する（実機から取り出した想定）
    const dump = JSON.parse(JSON.stringify(traceDump()))
    const battles = extractBattles(dump)
    expect(battles).toHaveLength(1)
    const r = replayBattle(battles[0], { spell: (ref) => (ref === SPELL.name ? SPELL : undefined) })
    expect(firstMismatch(battles[0].expected, r.produced)).toBeNull()
    expect(compared(battles[0].expected).length).toBeGreaterThan(5)
    expect(r.engine.getState().phase).toBe(e.getState().phase)
    expect(r.engine.getState().party.map((p) => p.hp)).toEqual(e.getState().party.map((p) => p.hp))
  })

  it('再現の検出力: 入力を 1 つ消すと不一致を返す（空虚なテストでないことの確認）', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [ent('p0', { hp: 60, maxHp: 60 })],
      [ent('e0', { hp: 90, maxHp: 90, atk: 14, agi: 6 })],
      {
        atb: {},
      }
    )
    attachBattleTrace(e)
    playOut(e)
    const battles = extractBattles(JSON.parse(JSON.stringify(traceDump())))
    const b = battles[0]
    const i = b.steps.findIndex((s) => s.k === 'b.cmd')
    b.steps.splice(i, 1)
    const r = replayBattle(b, { spell: () => SPELL })
    expect(firstMismatch(b.expected, r.produced)).not.toBeNull()
  })

  it('種のない戦闘（rng を注入）は再実行できないと明示して失敗する', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine([ent('p0')], [ent('e0')], { atb: {}, rng: () => 0 })
    attachBattleTrace(e)
    const b = extractBattles(traceDump())[0]
    expect(() => replayBattle(b)).toThrow(/乱数の種/)
  })

  it('同じエンジンに二度付けても記録は二重にならない（画面の作り直し）', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine([ent('p0')], [ent('e0', { hp: 1, maxHp: 1 })], { atb: {} })
    const a = attachBattleTrace(e)
    const b = attachBattleTrace(e)
    expect(b).toBe(a)
    e.tick(5000)
    const e0 = traceDump().session.entries.filter((x) => x.k === 'b.start')
    expect(e0).toHaveLength(1)
  })

  it('脚本の台詞・知らせの本文は記録しない（行動の ref は呪文・道具などのマスター名だけ）', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine([ent('p0', { mp: 1 })], [ent('e0')], { atb: {} })
    attachBattleTrace(e)
    // MP 不足の知らせ（notice）。label は文言
    while (e.getCurrentActorIndex() < 0) e.tick(100)
    e.selectSpell(SPELL, 'e0')
    const acts = traceDump()
      .session.entries.filter((x) => x.k === 'b.act')
      .map((x) => x.d as { k: string; ref: string | null })
    expect(acts.some((a) => a.k === 'notice')).toBe(true)
    for (const a of acts.filter((a) => a.k === 'notice')) expect(a.ref).toBeNull()
    expect(JSON.stringify(traceDump())).not.toContain('MPが')
  })

  it('再現: notifyBlocked（入力できない知らせ）も記録と再実行で一致する', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine([ent('p0')], [ent('e0', { hp: 90, maxHp: 90 })], { atb: {} })
    attachBattleTrace(e)
    while (e.getCurrentActorIndex() < 0) e.tick(100)
    e.notifyBlocked('つかえない')
    e.selectAttack()
    for (let i = 0; i < 300 && !e.isOver(); i++) e.tick(100)
    const b = extractBattles(JSON.parse(JSON.stringify(traceDump())))[0]
    expect(b.steps.some((s) => (s.d as { c?: string }).c === 'notifyBlocked')).toBe(true)
    const r = replayBattle(b)
    expect(firstMismatch(b.expected, r.produced)).toBeNull()
  })

  it('再現: セーブから再開した戦闘（初期ゲージ・待ちの順あり）がずれない', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [ent('p0', { agi: 3 }), ent('p1', { agi: 9 })],
      [ent('e0', { hp: 120, maxHp: 120, agi: 6 })],
      { atb: { initialGauges: { party: [700, 1000], enemies: [400] } }, restore: { atbQueue: [1] } }
    )
    attachBattleTrace(e)
    playOut(e)
    const b = extractBattles(JSON.parse(JSON.stringify(traceDump())))[0]
    const atb = (b.start.d as { atb: { g: number[][]; q: number[] } }).atb
    expect(atb.g).toEqual([[700, 1000], [400]])
    expect(atb.q).toEqual([1])
    const r = replayBattle(b, { spell: () => SPELL })
    expect(firstMismatch(b.expected, r.produced)).toBeNull()
  })

  it('再現: active 方式で 2 人が同時に満タン（同じ AGI）でも、まとめた経過時間で行動順がずれない', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [ent('p0', { agi: 7, hp: 400, maxHp: 400 }), ent('p1', { agi: 7, hp: 400, maxHp: 400 })],
      [ent('e0', { agi: 7, hp: 400, maxHp: 400 }), ent('e1', { agi: 7, hp: 400, maxHp: 400 })],
      { atb: { mode: 'active' } }
    )
    attachBattleTrace(e)
    let guard = 0
    while (!e.isOver() && guard++ < 4000) {
      e.tick(16.7)
      if (e.getCurrentActorIndex() >= 0) e.selectAttack()
    }
    const b = extractBattles(JSON.parse(JSON.stringify(traceDump())))[0]
    expect(b.expected.filter((x) => x.k === 'b.act').length).toBeGreaterThan(8)
    const r = replayBattle(b)
    expect(firstMismatch(b.expected, r.produced)).toBeNull()
  })

  it('再現: 満タン 3 人で番を連続して入れ替えても、行動順が記録どおりに再現される', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine(
      [
        ent('p0', { hp: 300, maxHp: 300 }),
        ent('p1', { hp: 300, maxHp: 300 }),
        ent('p2', { hp: 300, maxHp: 300 }),
      ],
      [ent('e0', { hp: 400, maxHp: 400, atk: 3, agi: 1 })],
      { atb: { initialGauges: { party: [1000, 1000, 1000] } } }
    )
    attachBattleTrace(e)
    e.tick(1) // 満タンの 3 人がコマンド待ちに並ぶ
    expect(e.getCurrentActorIndex()).toBe(0)
    expect(e.switchAtbActor(2)).toBe(true)
    expect(e.switchAtbActor(1)).toBe(true)
    expect(e.switchAtbActor(1)).toBe(false) // すでに番
    e.selectAttack() // 1 番が行動（次の番は 2）
    expect(e.switchAtbActor(0)).toBe(true)
    e.selectAttack() // 0 番が行動
    e.selectAttack() // 2 番が行動
    const entries = traceDump().session.entries
    const sw = entries
      .filter((x) => x.k === 'b.switch')
      .map((x) => x.d as { from: number; to: number })
    expect(sw.map((x) => [x.from, x.to])).toEqual([
      [0, 2],
      [2, 1],
      [2, 0],
    ])
    const actors = entries
      .filter((x) => x.k === 'b.act' && (x.d as { a: number[] }).a[0] === 0)
      .map((x) => (x.d as { a: number[] }).a[1])
    expect(actors).toEqual([1, 0, 2])
    const b = extractBattles(JSON.parse(JSON.stringify(traceDump())))[0]
    const r = replayBattle(b)
    expect(firstMismatch(b.expected, r.produced)).toBeNull()
    expect(
      r.produced
        .filter((x) => x.k === 'b.act' && (x.d as { a: number[] }).a[0] === 0)
        .map((x) => (x.d as { a: number[] }).a[1])
    ).toEqual([1, 0, 2])
  })

  it('切り替えが効かない場面（ターン制・コマンド待ちでない・ゲージ未満タン・倒れた味方）では b.switch を記録しない', () => {
    configureTrace(true, { storage: null })
    // ターン制（ATB でない）
    const t = new BattleEngine([ent('p0'), ent('p1')], [ent('e0')], {})
    attachBattleTrace(t)
    expect(t.switchAtbActor(1)).toBe(false)
    // ATB: コマンド待ちでない（誰も満タンでない）・未満タン・倒れた味方
    const a = new BattleEngine([ent('p0'), ent('p1', { hp: 0 }), ent('p2')], [ent('e0')], {
      atb: { initialGauges: { party: [1000, 1000, 100] } },
    })
    attachBattleTrace(a)
    expect(a.switchAtbActor(2)).toBe(false)
    expect(a.switchAtbActor(1)).toBe(false)
    expect(a.switchAtbActor(9)).toBe(false)
    expect(traceDump().session.entries.filter((x) => x.k === 'b.switch')).toEqual([])
  })

  it('switchActor の差し替え口が使える', () => {
    configureTrace(true, { storage: null })
    const e = new BattleEngine([ent('p0'), ent('p1')], [ent('e0')], {
      atb: { initialGauges: { party: [1000, 1000] } },
    })
    const t = attachBattleTrace(e)!
    t.switched({ from: 0, to: 1 })
    const b = extractBattles(JSON.parse(JSON.stringify(traceDump())))[0]
    const seen: unknown[] = []
    replayBattle(b, { switchActor: (_e, d) => seen.push([d.from, d.to]) })
    expect(seen).toEqual([[0, 1]])
  })
})
