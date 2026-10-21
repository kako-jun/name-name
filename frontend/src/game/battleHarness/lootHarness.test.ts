/** 検証ハーネスの戦利品の族と `loot-invariant` (#831) */
import { describe, expect, it } from 'vitest'
import { checkState, type DetectOptions } from './detect'
import { entity, lootMatrix, STEAL_EFFECTS } from './generate'
import { runScenario } from './run'
import { realEngineFactory } from './scenario'
import { buildSweep } from './sweep'
import { baseState } from './testing'
import type { BattleState } from '../battleEngine'
import type { LootEntry } from '../loot'

const entry = (over: Partial<LootEntry> = {}): LootEntry => ({
  itemId: 'potion',
  count: 1,
  via: 'steal',
  rare: false,
  enemyId: 's',
  enemyName: 'S',
  ...over,
})

const OPTS: DetectOptions = {
  maxDamage: 9999,
  loot: { s: { normal: ['potion'], rare: ['elixir'], drops: ['ether'], limit: 2 } },
}

function stateWith(loot: LootEntry[] | undefined, phase: BattleState['phase'] = 'party-input') {
  const st = baseState([entity('a')], [entity('s')], phase)
  if (phase === 'victory') st.enemies[0].hp = 0
  if (loot) st.loot = loot
  return st
}

const kinds = (s: BattleState, opts = OPTS) =>
  checkState(s, [], 0, opts)
    .filter((v) => v.kind === 'loot-invariant')
    .map((v) => v.detail)

describe('checkState: 戦利品の不変条件 (#831)', () => {
  it('loot が無ければ何も見ない。宣言どおりの品は違反なし', () => {
    expect(kinds(stateWith(undefined))).toEqual([])
    expect(
      kinds(
        stateWith(
          [
            entry(),
            entry({ itemId: 'elixir', rare: true }),
            entry({ itemId: 'ether', via: 'drop', count: 3 }),
          ],
          'victory'
        )
      )
    ).toEqual([])
  })

  it('宣言に無い品・枠の違い・宣言していない敵を検出する', () => {
    expect(kinds(stateWith([entry({ itemId: 'zzz' })]))[0]).toContain('zzz')
    expect(kinds(stateWith([entry({ itemId: 'elixir' })]))[0]).toContain('通常枠')
    expect(kinds(stateWith([entry({ itemId: 'potion', rare: true })]))[0]).toContain('レア枠')
    expect(kinds(stateWith([entry({ enemyId: 'nobody' })]))[0]).toContain('宣言していない敵')
    expect(kinds(stateWith([entry({ itemId: 'x', via: 'drop' })], 'victory'))[0]).toContain(
      '宣言に無いドロップ'
    )
  })

  it('勝利でないのにドロップ・ドロップに rare・盗めた回数の上限超・順序違反', () => {
    expect(kinds(stateWith([entry({ itemId: 'ether', via: 'drop' })], 'escaped'))[0]).toContain(
      '勝利でない'
    )
    expect(
      kinds(stateWith([entry({ itemId: 'ether', via: 'drop', rare: true })], 'victory'))[0]
    ).toContain('rare')
    expect(kinds(stateWith([entry(), entry(), entry()]))[0]).toContain('3 回盗めた')
    expect(
      kinds(stateWith([entry({ itemId: 'ether', via: 'drop' }), entry()], 'victory'))
    ).toContain('ドロップのあとにぬすんだ品が積まれた')
  })

  it('個数が 1〜99 の整数でない・空配列の loot', () => {
    for (const count of [0, -1, 1.5, 100, NaN]) {
      expect(kinds(stateWith([entry({ count })])).join('|'), String(count)).toContain('count')
    }
    expect(kinds(stateWith([]))[0]).toContain('空配列')
  })
})

describe('戦利品の族', () => {
  it('件数が直積どおり・id が一意・JSON 化できる・既定の総当たりに入り、skip で外せる', () => {
    const all = lootMatrix()
    // 効果 × (敵単体/敵全体は戦利品 8 種、味方単体/味方全体/自分は 1 種) × 加算 4 × 敵の HP 2 × ターン制/ATB 2
    expect(all).toHaveLength(STEAL_EFFECTS.length * (2 * 8 + 3) * 4 * 2 * 2)
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(JSON.parse(JSON.stringify(all[0]))).toEqual(all[0])
    expect(all.every((s) => s.id.startsWith('loot/'))).toBe(true)
    const withLoot = buildSweep({ randomSeed: 1, randomCount: 0, randomStatusCount: 0 })
    expect(withLoot.some((s) => s.id.startsWith('loot/'))).toBe(true)
    const skipped = buildSweep({
      randomSeed: 1,
      randomCount: 0,
      randomStatusCount: 0,
      skip: ['loot'],
    })
    expect(skipped.some((s) => s.id.startsWith('loot/'))).toBe(false)
  })

  it('間引いた実行で壊れが出ず、盗み・ドロップが実際に起きている', () => {
    const all = lootMatrix()
    let stole = 0
    let dropped = 0
    for (let i = 0; i < all.length; i += 17) {
      const r = runScenario(all[i])
      expect(
        r.violations.filter((v) => v.kind === 'loot-invariant'),
        all[i].id
      ).toEqual([])
      expect(
        r.violations.filter((v) => v.kind !== 'stalemate'),
        all[i].id
      ).toEqual([])
    }
    // 代表: 確率なし・両方の枠・加算なし・敵の HP 20 → 盗めて、勝てばドロップ
    const s = all.find((x) => x.id === 'loot/turn/e0/敵単体/both/bonus0/hp20')!
    const eng = realEngineFactory(s, () => 0.5)
    eng.selectSpell(s.spells[0])
    const state = eng.getState()
    stole += state.loot?.filter((l) => l.via === 'steal').length ?? 0
    dropped += state.loot?.filter((l) => l.via === 'drop').length ?? 0
    expect(stole).toBe(1)
    expect(dropped).toBe(0)
  })
})
