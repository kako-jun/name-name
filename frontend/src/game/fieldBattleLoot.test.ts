/**
 * 戦闘の結果（経験値・ゴールド・戦利品）がホストへ渡る配線 (#831)。
 * BattleScreen の onClose → openFieldBattle の onClosed → レンダラーの setBattleEndHandler まで。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { DEFAULT_FIELD_BATTLE_SETTINGS, FieldInputGate, openFieldBattle } from './fieldBattle'
import { RaycastRenderer } from './RaycastRenderer'
import { TopDownRenderer } from './TopDownRenderer'
import { RESULT_HOLD_DQ_MS } from './battleResult'
import type { BattleEntity } from './spellDsl'
import type { PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'
import type { BattleResult } from './loot'

const member = (id: string): PartyMemberDef => ({
  id,
  name: id,
  hp: 20,
  mp: 5,
  atk: 400,
  def: 2,
  agi: 3,
})

const droppingEnemy = (): BattleEntity => ({
  id: 'slime',
  name: 'スライム',
  hp: 5,
  maxHp: 5,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
  exp: 4,
  gold: 6,
  loot: { drops: ['potion 個数=2'] },
})

interface Handle {
  handleCommand(id: string): void
  tick(ms: number): void
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openFieldBattle の結果', () => {
  it('onClosed の第 2 引数に outcome・経験値・ゴールド・戦利品が入る', () => {
    const onClosed = vi.fn()
    const screen = openFieldBattle({
      stage: new Container(),
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS },
      roster: {
        party: { hero: member('hero') },
        order: ['hero'],
        items: { potion: { id: 'potion', name: 'ポーション', kind: '回復' } },
      },
      enemies: [droppingEnemy()],
      gate: new FieldInputGate(),
      onClosed,
    }) as unknown as Handle & { engine: { getState(): { log: string[] } } }
    screen.handleCommand('attack')
    screen.tick(RESULT_HOLD_DQ_MS)
    expect(onClosed).toHaveBeenCalledTimes(1)
    const [outcome, result] = onClosed.mock.calls[0] as ['victory', BattleResult]
    expect(outcome).toBe('victory')
    expect(result).toMatchObject({
      outcome: 'victory',
      exp: 4,
      gold: 6,
      items: [{ itemId: 'potion', count: 2 }],
    })
    expect(result.loot[0]).toMatchObject({ via: 'drop', enemyId: 'slime' })
    // アイテムマスターの名前がログに使われる
    expect(screen.engine.getState().log).toContain('ポーション ×2 を てに いれた！')
  })

  it('戦利品を宣言しない敵は loot が空の結果になる（従来どおり）', () => {
    const onClosed = vi.fn()
    const e = droppingEnemy()
    delete e.loot
    const screen = openFieldBattle({
      stage: new Container(),
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS },
      roster: { party: { hero: member('hero') }, order: ['hero'] },
      enemies: [e],
      gate: new FieldInputGate(),
      onClosed,
    }) as unknown as Handle
    screen.handleCommand('attack')
    screen.tick(RESULT_HOLD_DQ_MS)
    expect(onClosed.mock.calls[0][1]).toMatchObject({ loot: [], items: [], exp: 4, gold: 6 })
  })
})

function project(view: 'topdown' | 'raycast'): RPGProject {
  return {
    name: 't',
    version: '1.0.0',
    map: {
      width: 9,
      height: 9,
      tileSize: 32,
      tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
    },
    player: { x: 4, y: 4, direction: 'down' },
    npcs: [],
    view,
    party: { hero: member('hero') },
    partyOrder: ['hero'],
    items: { potion: { id: 'potion', name: 'ポーション', kind: '回復' } },
  }
}

describe.each([
  ['TopDownRenderer', 'topdown' as const],
  ['RaycastRenderer', 'raycast' as const],
])('%s の setBattleEndHandler', (_n, view) => {
  function make() {
    const r = view === 'topdown' ? new TopDownRenderer() : new RaycastRenderer()
    const f = r as unknown as {
      app: { stage: Container }
      initialized: boolean
      screenWidth: number
      screenHeight: number
      startBattle(e: BattleEntity[]): unknown
      battleScreen: Handle | null
      ensureWallTextures?: () => Promise<void>
      advanceTurnAnim?: () => void
      updateMovement?: () => void
      updateNpcAnimations?: () => void
      renderFrame?: () => void
    }
    f.app = { stage: new Container() }
    f.screenWidth = 800
    f.screenHeight = 600
    if (view === 'raycast') {
      f.ensureWallTextures = async () => {}
      f.advanceTurnAnim = () => {}
      f.updateMovement = () => {}
      f.updateNpcAnimations = () => {}
      f.renderFrame = () => {}
    }
    r.load(project(view))
    f.initialized = true
    return { r, f }
  }

  it('戦闘が終わって画面を畳んだ直後に結果を 1 回だけ受け取る。ハンドラ未登録でも壊れない', () => {
    const { r, f } = make()
    const handler = vi.fn()
    r.setBattleEndHandler(handler)
    f.startBattle([droppingEnemy()])
    expect(handler).not.toHaveBeenCalled()
    f.battleScreen!.handleCommand('attack')
    f.battleScreen!.tick(RESULT_HOLD_DQ_MS)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({
      outcome: 'victory',
      items: [{ itemId: 'potion', count: 2 }],
    })
    expect(f.battleScreen).toBeNull()

    const second = make()
    second.f.startBattle([droppingEnemy()])
    second.f.battleScreen!.handleCommand('attack')
    expect(() => second.f.battleScreen!.tick(RESULT_HOLD_DQ_MS)).not.toThrow()
  })

  it('戦闘中に load() で強制終了したときはハンドラを呼ばない', () => {
    const { r, f } = make()
    const handler = vi.fn()
    r.setBattleEndHandler(handler)
    f.startBattle([droppingEnemy()])
    r.load(project(view))
    expect(handler).not.toHaveBeenCalled()
  })
})
