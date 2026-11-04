/** 戦闘設定 JSON の呪文 `multiTarget`（魔法の全体化、#895）と同梱の例 */
import { describe, it, expect } from 'vitest'
import multiSample from './__fixtures__/multi-target.json?raw'
import { buildBattleSetup, initialView, parseConfigText } from './config'
import { BattleEngine } from '../game/battleEngine'

describe('同梱の例 __fixtures__/multi-target.json (#895)', () => {
  it('読め、全体化できる呪文と できない呪文・敵全体が入っている', () => {
    const r = parseConfigText(multiSample, 'https://example.com/battle/multi-target.json')
    if (!r.ok) throw new Error(r.error)
    const by = Object.fromEntries(r.value.spells.map((s) => [s.id, s]))
    expect(by.fire.multiTarget).toBe(true)
    expect(by.ice.multiTarget).toBeUndefined()
    expect(by.meteor.target).toBe('敵全体')
    expect(r.value.enemies).toHaveLength(3)
  })

  it('例のファイア: 単体は 60、全体化は 60 / 3 = 20 ずつ（ブリザドは全体化できず単体のまま）', () => {
    const r = parseConfigText(multiSample, 'https://example.com/battle/multi-target.json')
    if (!r.ok) throw new Error(r.error)
    const make = () => {
      const setup = buildBattleSetup(r.value, initialView(r.value))
      return new BattleEngine(setup.party, setup.enemies, {
        rng: () => 0,
        statuses: setup.statuses,
      })
    }
    const fire = r.value.spells.find((s) => s.id === 'fire')!
    const ice = r.value.spells.find((s) => s.id === 'ice')!
    const a = make()
    a.selectSpell(fire, a.getState().enemies[0].id)
    expect(a.getState().enemies.map((e) => e.hp)).toEqual([240, 300, 300])
    const b = make()
    b.selectSpell(fire, undefined, 'all')
    expect(b.getState().enemies.map((e) => e.hp)).toEqual([280, 280, 280])
    const c = make()
    c.selectSpell(ice, undefined, 'all')
    expect(c.getState().enemies.map((e) => e.hp)).toEqual([240, 300, 300])
  })
})
