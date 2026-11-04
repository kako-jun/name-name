/**
 * 魔法の全体化 (#895) のテスト。`全体化: 可` の敵単体の呪文だけ、戦闘中に「全体」へ切り替えられる。
 * 全体化するとダメージ基礎値と即死・状態付与の成功率を、生存対象数で割る。書かない魔法は完全に従来どおり。
 * 期待値は定数・関数を参照せず、リテラルで固定する（割り方を替えたらこのテストが落ちるように）。
 */
import { describe, expect, it } from 'vitest'
import { BattleEngine, type SpellExecution } from './battleEngine'
import { multiTargetDivisor, spreadDamageBase, spreadSuccessRate } from './battleLimits'
import { isSpreadableSpell, type BattleEntity } from './spellDsl'
import { buildBattleMenuData } from './fieldBattle'
import { parseMenuList } from '../battleSample/config'
import {
  EMPTY_STACK,
  buildMenuRows,
  confirm,
  menuHint,
  moveCursor,
  selectMarkTargets,
  setTargetAll,
  setTargetCursor,
  targetHands,
  targetScopeOf,
  targetSpecOf,
  type BattleSpellEntry,
  type MenuContext,
  type TargetWindow,
} from './battleMenu'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return { id, name: id, hp: 100, maxHp: 100, mp: 50, maxMp: 50, atk: 10, def: 0, agi: 5, ...over }
}

function seq(...vals: number[]): () => number {
  let i = 0
  return () => (i < vals.length ? vals[i++] : 0)
}

function engine(
  enemies: BattleEntity[],
  rng: () => number = () => 0
): { e: BattleEngine; hp: () => number[] } {
  const e = new BattleEngine([ent('a')], enemies, { rng })
  return { e, hp: () => e.getState().enemies.map((x) => x.hp) }
}

const three = () => [ent('s1'), ent('s2'), ent('s3')]
const fire = (effect: string, over: Partial<SpellExecution> = {}): SpellExecution => ({
  name: 'ほのお',
  mp: 3,
  target: '敵単体',
  multiTarget: true,
  effect,
  ...over,
})

describe('割り方の定数・関数 (#895)', () => {
  it('multiTargetDivisor は生存対象数そのもの。1 未満・非有限は 1', () => {
    expect([1, 2, 3, 8].map(multiTargetDivisor)).toEqual([1, 2, 3, 8])
    expect([0, -2, NaN, Infinity].map(multiTargetDivisor)).toEqual([1, 1, 1, 1])
  })
  it('spreadDamageBase は端数切り捨て・最低 1。0 以下と非有限は触らない。割る数 1 は素通し', () => {
    expect(spreadDamageBase(30, 3)).toBe(10)
    expect(spreadDamageBase(10, 3)).toBe(3)
    expect(spreadDamageBase(2, 3)).toBe(1)
    expect(spreadDamageBase(1, 5)).toBe(1)
    expect(spreadDamageBase(0, 3)).toBe(0)
    expect(spreadDamageBase(-4, 3)).toBe(-4)
    expect(spreadDamageBase(Infinity, 3)).toBe(Infinity)
    expect(spreadDamageBase(7, 1)).toBe(7)
  })
  it('spreadSuccessRate は割るだけ。割る数 1 は素通し', () => {
    expect(spreadSuccessRate(0.6, 2)).toBeCloseTo(0.3)
    expect(spreadSuccessRate(1, 4)).toBeCloseTo(0.25)
    expect(spreadSuccessRate(0.6, 1)).toBe(0.6)
  })
})

describe('isSpreadableSpell', () => {
  it('全体化: 可 かつ 敵単体（未指定・未知・空白付きも）だけ真', () => {
    expect(isSpreadableSpell({ target: '敵単体', multiTarget: true })).toBe(true)
    expect(isSpreadableSpell({ target: ' 敵単体 ', multiTarget: true })).toBe(true)
    expect(isSpreadableSpell({ target: 'なにか', multiTarget: true })).toBe(true)
    expect(isSpreadableSpell({ multiTarget: true })).toBe(true)
  })
  it('書かない・偽、もともと全体・味方・自分・マップは偽', () => {
    expect(isSpreadableSpell({ target: '敵単体' })).toBe(false)
    expect(isSpreadableSpell({ target: '敵単体', multiTarget: false })).toBe(false)
    for (const t of ['敵全体', '味方単体', '味方全体', '自分', 'マップ']) {
      expect(isSpreadableSpell({ target: t, multiTarget: true })).toBe(false)
    }
  })
})

describe('エンジン: 全体化のダメージ', () => {
  it('opt-in なし（multiTarget を書かない）は scope=all を渡しても従来どおり単体（ログ・HP・MP が単体と一致）', () => {
    const a = engine(three())
    a.e.selectSpell(
      { name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 30..30' },
      undefined,
      'all'
    )
    const b = engine(three())
    b.e.selectSpell({ name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 30..30' })
    expect(a.hp()).toEqual([70, 100, 100])
    expect(a.hp()).toEqual(b.hp())
    expect(a.e.getState().log).toEqual(b.e.getState().log)
  })

  it('opt-in ありでも scope 省略 / single は従来どおり単体でフルダメージ', () => {
    const a = engine(three())
    a.e.selectSpell(fire('damage 30..30'), 's2')
    expect(a.hp()).toEqual([100, 70, 100])
    const b = engine(three())
    b.e.selectSpell(fire('damage 30..30'), 's3', 'single')
    expect(b.hp()).toEqual([100, 100, 70])
  })

  it('全体化: 生存している敵全員に当たり、基礎値を生存数で割る（30 / 3 = 10）。MP は不変', () => {
    const { e, hp } = engine(three())
    e.selectSpell(fire('damage 30..30'), 's2', 'all')
    expect(hp()).toEqual([90, 90, 90])
    expect(e.getState().party[0].mp).toBe(47) // 50 - 3（単体と同じ MP）
  })

  it('端数は切り捨て（10 / 3 = 3）、最低 1（2 / 3 → 1）', () => {
    const a = engine(three())
    a.e.selectSpell(fire('damage 10..10'), undefined, 'all')
    expect(a.hp()).toEqual([97, 97, 97])
    const b = engine(three())
    b.e.selectSpell(fire('damage 2..2'), undefined, 'all')
    expect(b.hp()).toEqual([99, 99, 99])
  })

  it('割る数は全体化した時点の生存数（倒れている敵は数えず、当たらない）', () => {
    const { e, hp } = engine([ent('s1'), ent('s2', { hp: 0 }), ent('s3')])
    e.selectSpell(fire('damage 30..30'), undefined, 'all')
    expect(hp()).toEqual([85, 0, 85]) // 30 / 2
  })

  it('生存 1 体なら割らない（単体と同じダメージ）', () => {
    const { e, hp } = engine([ent('s1', { hp: 0 }), ent('s2')])
    e.selectSpell(fire('damage 30..30'), undefined, 'all')
    expect(hp()).toEqual([0, 70])
  })

  it('属性相性・耐性は割ったあとの基礎値に掛かる（耐性 0.5: 30/3=10 → 5）', () => {
    const { e, hp } = engine([ent('s1', { resist: { fire: 0.5 } }), ent('s2'), ent('s3')])
    e.selectSpell(fire('damage 30..30 type=fire'), undefined, 'all')
    expect(hp()).toEqual([95, 90, 90])
  })

  it('敵全体の呪文は multiTarget を書いても割らない（もともと全体は単体化も全体化もしない）', () => {
    const { e, hp } = engine(three())
    e.selectSpell(fire('damage 30..30', { target: '敵全体' }), undefined, 'all')
    expect(hp()).toEqual([70, 70, 70])
  })

  it('味方単体の呪文には効かない（scope=all でも味方単体のまま）', () => {
    const { e } = engine(three())
    e.selectSpell(
      { name: 'ヒール', mp: 2, target: '味方単体', multiTarget: true, effect: 'heal 5..5' },
      'a',
      'all'
    )
    expect(e.getState().enemies.map((x) => x.hp)).toEqual([100, 100, 100])
  })

  it('複数ヒット（回数=2）は 1 ヒットごとに割る', () => {
    const { e, hp } = engine(three())
    e.selectSpell(fire('damage 30..30 回数=2'), undefined, 'all')
    expect(hp()).toEqual([80, 80, 80]) // (30/3) × 2 ヒット
  })
})

describe('エンジン: 全体化の成功率', () => {
  it('状態付与: 確率=60 は全体化で 2 体なら 30%。rng 0.4 は単体なら成功・全体化なら失敗', () => {
    const single = engine([ent('s1'), ent('s2')], seq(0.4, 0.4))
    single.e.selectSpell(fire('status poison 確率=60'), 's1')
    expect(single.e.getState().enemies[0].status?.poison).toBeGreaterThan(0)

    const spread = engine([ent('s1'), ent('s2')], seq(0.4, 0.4))
    spread.e.selectSpell(fire('status poison 確率=60'), 's1', 'all')
    expect(spread.e.getState().enemies.map((x) => x.status?.poison ?? 0)).toEqual([0, 0])
  })

  it('状態付与: rng 0.2（< 0.3）なら全体化でも全員に付く', () => {
    const { e } = engine([ent('s1'), ent('s2')], seq(0.2, 0.2))
    e.selectSpell(fire('status poison 確率=60'), undefined, 'all')
    expect(e.getState().enemies.every((x) => (x.status?.poison ?? 0) > 0)).toBe(true)
  })

  it('確率を書かない付与（必中）も全体化で 1/n になる（3 体: 約 33%）。rng 0.5 は失敗', () => {
    const { e } = engine(three(), seq(0.5, 0.5, 0.5))
    e.selectSpell(fire('status poison'), undefined, 'all')
    expect(e.getState().enemies.every((x) => x.status?.poison === undefined)).toBe(true)
  })

  it('成功率は相性補正のあとで割る（半減 ×0.5 かつ 2 体: 100% → 50% → 25%）', () => {
    const half = { affinity: { halve: ['death'] } } as Partial<BattleEntity>
    const a = engine([ent('s1', half), ent('s2', half)], seq(0.3, 0.3))
    a.e.selectSpell(fire('damage_full'), undefined, 'all')
    expect(a.hp()).toEqual([100, 100]) // 0.3 >= 0.25 で失敗
    const b = engine([ent('s1', half), ent('s2', half)], seq(0.2, 0.2))
    b.e.selectSpell(fire('damage_full'), undefined, 'all')
    expect(b.hp()).toEqual([0, 0]) // 0.2 < 0.25 で成功
  })

  it('即死: 2 体なら 50%。rng 0.6 は失敗・0.4 は成功。単体なら 100% で乱数を使わず必ず倒す', () => {
    const miss = engine([ent('s1'), ent('s2')], seq(0.6, 0.6))
    miss.e.selectSpell(fire('damage_full'), undefined, 'all')
    expect(miss.hp()).toEqual([100, 100])
    const hit = engine([ent('s1'), ent('s2')], seq(0.4, 0.4))
    hit.e.selectSpell(fire('damage_full'), undefined, 'all')
    expect(hit.hp()).toEqual([0, 0])
    const one = engine([ent('s1'), ent('s2')], seq(0.99))
    one.e.selectSpell(fire('damage_full'), 's1')
    expect(one.hp()).toEqual([0, 100])
  })
})

describe('エンジン: ATB でも動く', () => {
  it('ATB のコマンド待ちの味方が全体化した呪文を使える', () => {
    const e = new BattleEngine([ent('a', { agi: 100 })], three(), {
      rng: () => 0,
      atb: { mode: 'wait' },
    })
    e.tick(1000)
    expect(e.getState().phase).toBe('party-input')
    e.selectSpell(fire('damage 30..30'), undefined, 'all')
    expect(e.getState().enemies.map((x) => x.hp)).toEqual([90, 90, 90])
  })
})

describe('候補窓: 対象窓の たんたい / ぜんたい 切り替え', () => {
  const spells: BattleSpellEntry[] = [
    { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', multiTarget: true },
    { id: 'ice', name: 'こおり', mp: 3, target: '敵単体' },
    { id: 'meteor', name: 'メテオ', mp: 9, target: '敵全体', multiTarget: true },
  ]
  const party = [ent('a')]
  const enemies = [ent('s1'), ent('s2', { hp: 0 }), ent('s3')]
  const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({
    rows: buildMenuRows('spell', spells, party[0]),
    maxRows: 4,
    entries: spells,
    party,
    enemies,
    actorIndex: 0,
    ...over,
  })
  const open = (cursor: number) =>
    confirm([{ type: 'list', kind: 'spell', cursor, top: 0 }], ctx()).stack

  it('multiAllowed は 全体化: 可 の敵単体の呪文だけ（書かない呪文・敵全体は付かない）', () => {
    expect(targetSpecOf('spell', spells[0])).toEqual({
      side: 'enemy',
      scope: 'single',
      multiAllowed: true,
    })
    expect(targetSpecOf('spell', spells[1])).toEqual({ side: 'enemy', scope: 'single' })
    expect(targetSpecOf('spell', spells[2])).toEqual({ side: 'enemy', scope: 'all' })
  })

  it('左右キーで切り替わる（何度でも往復できる）。切り替えても確定まで MP は変わらない', () => {
    const s0 = open(0)
    const w0 = s0[1] as TargetWindow
    expect(targetScopeOf(w0)).toBe('single')
    const s1 = moveCursor(s0, 'right', ctx())
    expect(targetScopeOf(s1[1] as TargetWindow)).toBe('all')
    const s2 = moveCursor(s1, 'left', ctx())
    expect(targetScopeOf(s2[1] as TargetWindow)).toBe('single')
  })

  it('opt-in なしの呪文・敵全体では左右キーは何もしない（同じ stack を返す）', () => {
    const s = open(1)
    expect(moveCursor(s, 'right', ctx())).toBe(s)
    const m = open(2)
    expect(moveCursor(m, 'left', ctx())).toBe(m)
    expect(setTargetAll(s, true)).toBe(s)
  })

  it('全体化中は手が生存している敵全員に立ち、確定は scope=all で targetId を持たない', () => {
    const s = setTargetAll(open(0), true)
    const hands = targetHands(s[1] as TargetWindow, party, enemies, 0)
    expect(hands).toEqual([
      { side: 'enemy', index: 0 },
      { side: 'enemy', index: 2 },
    ])
    expect(selectMarkTargets(party, enemies, 0, s[1]).enemy).toEqual([true, false, true])
    const r = confirm(s, ctx())
    expect(r.action).toEqual({ kind: 'spell', entryIndex: 0, scope: 'all' })
    expect(r.stack).toEqual(EMPTY_STACK)
  })

  it('単体のまま確定すれば従来どおり targetId を持ち scope は付かない', () => {
    const r = confirm(open(0), ctx())
    expect(r.action).toEqual({ kind: 'spell', entryIndex: 0, targetId: 's1' })
  })

  it('全体化中は上下・タップで手を動かさない。単体に戻すと手は元の位置', () => {
    const all = setTargetAll(open(0), true)
    expect(moveCursor(all, 'down', ctx())).toBe(all)
    expect(setTargetCursor(all, 'enemy', 2, ctx())).toBe(all)
    const back = setTargetAll(all, false)
    expect((back[1] as TargetWindow).cursor).toBe(0)
  })

  it('生きている敵がいなければ全体化でも確定できない（empty）', () => {
    const s = setTargetAll(open(0), true)
    const dead = ctx({ enemies: [ent('s1', { hp: 0 })] })
    expect(confirm(s, dead).blocked).toBe('empty')
  })

  it('案内の文に たんたい / ぜんたい の切り替えが出る（暗黙の操作にしない）。絵文字は使わない', () => {
    const always = () => true
    const single = open(0)[1] as TargetWindow
    const all = setTargetAll(open(0), true)[1] as TargetWindow
    const plain = open(1)[1] as TargetWindow
    expect(menuHint(single, true, always)).toContain('ぜんたい')
    expect(menuHint(all, true, always)).toContain('たんたい')
    expect(menuHint(plain, true, always)).not.toContain('ぜんたい')
    // 短い文に落ちても切り替えの案内は残る
    const short = (t: string) => t.length <= 40
    expect(menuHint(single, true, short)).toContain('ぜんたい')
    for (const t of [menuHint(single, true, always), menuHint(all, true, always)]) {
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})

describe('マスター・サンプル設定から候補窓へ multiTarget が渡る', () => {
  it('buildBattleMenuData: 全体化: 可 の呪文だけ multiTarget: true が付く（書かない呪文は従来と同じ形）', () => {
    const spells = {
      fire: { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', multiTarget: true },
      ice: { id: 'ice', name: 'こおり', mp: 3, target: '敵単体' },
    }
    const party = [{ id: 'a', name: 'A', hp: 20, mp: 5, atk: 4, def: 2, agi: 3, level: 1 }]
    const roster = {
      party: {
        a: {
          ...party[0],
          learns: [
            { level: 1, spell: 'fire' },
            { level: 1, spell: 'ice' },
          ],
        },
      },
      spells,
    }
    const m = buildBattleMenuData(roster as never, [ent('a')])!
    expect(m.spells!.a[0]).toEqual({
      id: 'fire',
      name: 'ほのお',
      mp: 3,
      target: '敵単体',
      multiTarget: true,
    })
    expect(m.spells!.a[1]).toEqual({ id: 'ice', name: 'こおり', mp: 3, target: '敵単体' })
  })

  it('サンプル JSON の spells: multiTarget は true のときだけ写し、真偽以外はエラー', () => {
    const ok = parseMenuList<BattleSpellEntry>(
      [
        { name: 'ほのお', mp: 3, multiTarget: true },
        { name: 'こおり', mp: 3, multiTarget: false },
        { name: 'かぜ', mp: 3 },
      ],
      [],
      'spells'
    )
    expect(ok.ok && ok.value.map((e) => e.multiTarget)).toEqual([true, undefined, undefined])
    const bad = parseMenuList<BattleSpellEntry>(
      [{ name: 'ほのお', multiTarget: 'はい' }],
      [],
      'spells'
    )
    expect(bad.ok).toBe(false)
  })
})
