import { describe, it, expect, vi } from 'vitest'
import { rollEncounter } from './RaycastRenderer'
import type { MonsterDef } from '../types'

const slime: MonsterDef = {
  id: 'slime',
  name: 'スライム',
  hp: 10,
  mp: 0,
  atk: 3,
  def: 1,
  agi: 2,
  exp: 2,
  gold: 1,
}

const ghost: MonsterDef = {
  id: 'ghost',
  name: 'ゴースト',
  hp: 14,
  mp: 0,
  atk: 5,
  def: 2,
  agi: 6,
  exp: 4,
  gold: 3,
}

describe('rollEncounter (Issue #172)', () => {
  it('rate=0 で常に null（街・室内）', () => {
    expect(
      rollEncounter({
        rate: 0,
        groups: ['slime'],
        masters: { slime },
        rng: () => 0,
      })
    ).toBeNull()
  })

  it('groups 空で常に null', () => {
    expect(
      rollEncounter({
        rate: 1,
        groups: [],
        masters: { slime },
        rng: () => 0,
      })
    ).toBeNull()
  })

  it('rate=1 で毎歩確実発火（rng=0 でも発火）', () => {
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(1)
    expect(enemies![0].id).toBe('slime')
  })

  it('rate=16 で rng>=1/16 ならハズレ', () => {
    expect(
      rollEncounter({
        rate: 16,
        groups: ['slime'],
        masters: { slime },
        rng: () => 0.5,
      })
    ).toBeNull()
  })

  it('rate=16 で rng<1/16 なら当選', () => {
    const enemies = rollEncounter({
      rate: 16,
      groups: ['slime'],
      masters: { slime },
      rng: () => 0.01,
    })
    expect(enemies).not.toBeNull()
  })

  it('複合グループ "slime+ghost" で 2 体パーティ', () => {
    let i = 0
    const rngs = [0, 0] // 1回目: roll <1/1 で当選、2回目: groups[0] 選択
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime+ghost'],
      masters: { slime, ghost },
      rng: () => rngs[i++ % rngs.length],
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(2)
    expect(enemies!.map((e) => e.id)).toEqual(['slime', 'ghost'])
  })

  it('未定義 ID は warning + スキップ', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['unknown_monster'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // own-property ルックアップ修正の確認（#368）。id が Object.prototype のプロパティ名と
  // 一致しても「未定義 ID」と同じ warning + スキップ扱いになる（関数オブジェクトを敵として
  // 組み立てない）。
  it('修正確認: id が "constructor" でも未定義 ID と同じ warning + スキップになる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['constructor'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('複合グループの一部が未定義でも残りで戦闘', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime+unknown'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(1)
    expect(enemies![0].id).toBe('slime')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('複数 groups から rng 値で重み均等選択', () => {
    let i = 0
    // 1回目: 抽選当選 (0.0 < 1/1), 2回目: groups[2] 選択 (0.99 * 3 = 2.97 → floor=2)
    const rngs = [0, 0.99]
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime', 'ghost', 'slime+ghost'],
      masters: { slime, ghost },
      rng: () => rngs[i++ % rngs.length],
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(2) // 'slime+ghost' = 2 体
  })

  it('生成された BattleEntity は maxHp/maxMp が hp/mp と同値で full 状態', () => {
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies![0].hp).toBe(slime.hp)
    expect(enemies![0].maxHp).toBe(slime.hp)
    expect(enemies![0].mp).toBe(slime.mp)
    expect(enemies![0].maxMp).toBe(slime.mp)
    expect(enemies![0].exp).toBe(slime.exp)
    expect(enemies![0].gold).toBe(slime.gold)
  })
})
