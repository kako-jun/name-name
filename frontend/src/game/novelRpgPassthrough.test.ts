/**
 * ノベル側のセーブ/スナップショット/startFrom が RPG 状態 (#1021) を解釈せず持ち回すことのテスト。
 */
import { describe, expect, it } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { gameStateToSaveSlot, saveSlotToGameState } from './novelLayout'
import { buildRpgSaveSlot, type RpgSaveState } from './rpgSave'
import type { EventScene } from '../types'

const rpg: RpgSaveState = {
  version: 1,
  party: [{ id: 'party1', hp: 3 }],
  items: { potion: 1 },
  equipment: { party1: ['sword'] },
  gold: 77,
  field: { sceneId: 'temple', x: 10, y: 20, facing: 'downRight' },
  battle: {
    enemies: [{ id: 'slime', hp: 2 }],
    atb: { partyGauge: [1000], enemyGauge: [0], queue: [0] },
  },
}

const scenes: EventScene[] = [
  { id: 'start', title: 's', view: 'TopDown', events: [{ Narration: { text: ['x'] } }] },
]

describe('RPG 状態の持ち回し', () => {
  it('SaveSlotData → NovelGameState → SaveSlotData で rpg が変わらない', () => {
    const slot = buildRpgSaveSlot(rpg, { slot: 0, savedAt: 'x' })
    const state = saveSlotToGameState(slot, null)
    expect(state.rpg).toEqual(rpg)
    const back = gameStateToSaveSlot(state, { slot: 0, savedAt: 'x', sceneName: null })
    expect(back.rpg).toEqual(rpg)
  })

  it('rpg を持たないセーブはキー自体を出さない（従来の JSON のまま）', () => {
    const slot = buildRpgSaveSlot(rpg)
    delete slot.rpg
    const state = saveSlotToGameState(slot, null)
    expect('rpg' in state).toBe(false)
    expect('rpg' in gameStateToSaveSlot(state, { slot: 0, savedAt: 'x', sceneName: null })).toBe(
      false
    )
  })

  it('startFrom({ rpg }) の入場後に getSnapshot().rpg で読める。次の startFrom（rpg なし）で持ち越さない', async () => {
    const r = new NovelRenderer()
    r.setScenes(scenes)
    const res = await r.startFrom({ sceneId: 'start', rpg })
    expect(res.status).toBe('entered')
    expect(r.getSnapshot().rpg).toEqual(rpg)
    // 複製を持つ（渡した側の書き換えが漏れない）
    rpg.gold = 1
    expect(r.getSnapshot().rpg!.gold).toBe(77)
    rpg.gold = 77
    await r.startFrom({ sceneId: 'start' })
    expect('rpg' in r.getSnapshot()).toBe(false)
  })

  it('検証に通らない rpg を渡した startFrom は invalid-rpg で失敗し、状態を変えない', async () => {
    const r = new NovelRenderer()
    r.setScenes(scenes)
    await r.startFrom({ sceneId: 'start', rpg })
    const bad = { ...rpg, gold: -1 } as RpgSaveState
    const res = await r.startFrom({ sceneId: 'start', rpg: bad })
    expect(res).toEqual({ status: 'failed', reason: 'invalid-rpg' })
    expect(r.getSnapshot().rpg).toEqual(rpg)
  })

  it('入場に失敗した startFrom は rpg を変えない', async () => {
    const r = new NovelRenderer()
    r.setScenes(scenes)
    await r.startFrom({ sceneId: 'start', rpg })
    const res = await r.startFrom({ sceneId: 'no-such-scene' })
    expect(res.status).toBe('failed')
    expect(r.getSnapshot().rpg).toEqual(rpg)
  })
})
