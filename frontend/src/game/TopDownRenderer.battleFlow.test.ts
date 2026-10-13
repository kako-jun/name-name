/**
 * TopDownRenderer の戦闘遷移の周辺挙動 (#784)。TopDownRenderer.battle.test.ts が扱わない観点:
 * 踏み込みトリガーの繰り延べ、戦闘中のタップ/スワイプ、ATB tick、リサイズ、クールダウン境界、リスナー解除。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { TopDownRenderer } from './TopDownRenderer'
import type { BattleEntity } from './spellDsl'
import type { RPGProject } from '../types/rpg'

const enemy = (): BattleEntity => ({
  id: 'slime',
  name: 'スライム',
  hp: 5,
  maxHp: 5,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
})

interface Internals {
  app: Record<string, unknown> & { stage: Container }
  initialized: boolean
  screenWidth: number
  screenHeight: number
  playerGridX: number
  playerGridY: number
  encounterCooldown: number
  isMoving: boolean
  pendingSwipe: string | null
  lastTickMs: number
  eventRunner: { run: ReturnType<typeof vi.fn>; isRunning: boolean } | null
  menuOverlay: { isShowing(): boolean; toggleMenu?: () => void } | null
  battleScreen: {
    opts: Record<string, unknown>
    tick: (ms: number) => void
    redraw: (w: number, h: number) => void
    engine: { getState(): { atb?: { partyGauge: number[] } } }
  } | null
  startBattle(enemies: BattleEntity[]): void
  tryMove(d: 'up' | 'down' | 'left' | 'right'): void
  handleSwipe(d: 'up' | 'down' | 'left' | 'right'): void
  handleTap(): void
  handleResize(): void
  onTick(): void
}

const ENCOUNTER_MAP = {
  width: 9,
  height: 9,
  tileSize: 32,
  tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
  encounterRate: 1,
  encounterGroups: ['slime'],
}
const MONSTERS = {
  slime: { id: 'slime', name: 'スライム', hp: 5, atk: 1, def: 0, agi: 1, exp: 1, gold: 1 },
}

function project(over: Partial<RPGProject> = {}): RPGProject {
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
    view: 'topdown',
    ...over,
  }
}

function field(over: Partial<RPGProject> = {}): Internals {
  const r = new TopDownRenderer()
  const i = r as unknown as Internals
  i.app = { stage: new Container() }
  i.screenWidth = 800
  i.screenHeight = 600
  r.load(project(over))
  i.initialized = true
  return i
}

/** エンカウント確定のマップ + 踏み込みトリガー (4,5) を持つフィールド */
function triggerField(extra: Partial<RPGProject> = {}): Internals {
  const i = field({
    map: ENCOUNTER_MAP,
    monsters: MONSTERS,
    rpgEvents: [{ name: 'scene1', commands: [] }],
    triggers: [{ x: 4, y: 5, auto: false, scene: 'scene1', once: false }],
    ...extra,
  })
  i.eventRunner = { run: vi.fn(), isRunning: false }
  return i
}

const close = (i: Internals, outcome = 'victory') =>
  (i.battleScreen!.opts.onClose as (o: string) => void)(outcome)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('踏み込みトリガーの繰り延べ', () => {
  it('エンカウントしなかった歩では踏み込みトリガーが即発火する', () => {
    const i = triggerField()
    i.encounterCooldown = 5 // 抽選スキップ
    i.tryMove('down')
    expect(i.eventRunner!.run).toHaveBeenCalledTimes(1)
  })

  it('エンカウントした歩では戦闘中はトリガーが発火せず、戦闘終了後に 1 回発火する', () => {
    const i = triggerField()
    i.tryMove('down')
    expect(i.battleScreen).not.toBeNull()
    expect(i.eventRunner!.run).not.toHaveBeenCalled()
    close(i)
    expect(i.eventRunner!.run).toHaveBeenCalledTimes(1)
  })

  it.each(['victory', 'escaped', 'defeat'])(
    '戦闘の結果が %s でも繰り延べトリガーは発火する',
    (o) => {
      const i = triggerField()
      i.tryMove('down')
      close(i, o)
      expect(i.eventRunner!.run).toHaveBeenCalledTimes(1)
    }
  )

  it('トリガーの無いタイルでエンカウントしても戦闘後に何も発火せず落ちない', () => {
    const i = triggerField()
    i.tryMove('up') // (4,3) にトリガーなし
    expect(i.battleScreen).not.toBeNull()
    expect(() => close(i)).not.toThrow()
    expect(i.eventRunner!.run).not.toHaveBeenCalled()
  })

  it('繰り延べトリガーは 1 回限り（次の戦闘終了で再発火しない）', () => {
    const i = triggerField()
    i.tryMove('down')
    close(i)
    i.startBattle([enemy()])
    close(i)
    expect(i.eventRunner!.run).toHaveBeenCalledTimes(1)
  })

  it('load() し直すと未消化の繰り延べトリガーは捨てられる', () => {
    const i = triggerField()
    i.tryMove('down')
    const screen = i.battleScreen
    ;(i as unknown as { load(p: RPGProject): void }).load(project())
    // 旧画面の onClose が来ても、トリガー座標は消えている
    ;(screen!.opts.onClose as (o: string) => void)('victory')
    expect(i.eventRunner!.run).not.toHaveBeenCalled()
  })
})

describe('戦闘後のクールダウン境界と連続エンカウント', () => {
  it.each([2, 3, 4])(
    'encounterCooldown=%i のとき、ちょうど %i 歩スキップして次の歩で戦闘になる',
    (n) => {
      const i = field({ map: ENCOUNTER_MAP, monsters: MONSTERS })
      i.encounterCooldown = n
      const dirs = ['up', 'down'] as const
      let steps = 0
      while (!i.battleScreen && steps < 10) {
        i.isMoving = false
        i.tryMove(dirs[steps % 2])
        steps++
      }
      expect(steps).toBe(n + 1)
    }
  )

  it('戦闘終了 → 3 歩は歩いても戦闘にならず、4 歩目で再び戦闘になる', () => {
    const i = field({ map: ENCOUNTER_MAP, monsters: MONSTERS })
    i.startBattle([enemy()])
    close(i)
    const dirs = ['up', 'down'] as const
    for (let s = 0; s < 3; s++) {
      i.isMoving = false
      i.tryMove(dirs[s % 2])
      expect(i.battleScreen).toBeNull()
    }
    i.isMoving = false
    i.tryMove('down')
    expect(i.battleScreen).not.toBeNull()
  })

  it('戦闘中に startBattle を重ねても画面は 1 つで、最初の戦闘が維持される', () => {
    const i = field()
    i.startBattle([enemy()])
    const first = i.battleScreen
    i.startBattle([enemy()])
    expect(i.battleScreen).toBe(first)
    expect(i.app.stage.children.filter((c) => (c as unknown) === first)).toHaveLength(1)
    expect(i.app.stage.children).toHaveLength(1)
  })

  it('敵が空配列の startBattle は戦闘を始めない', () => {
    const i = field()
    i.startBattle([])
    expect(i.battleScreen).toBeNull()
  })
})

describe('戦闘中のタップ / スワイプ', () => {
  it('戦闘中のスワイプでプレイヤーは動かず、キューも残らない', () => {
    const i = field()
    i.startBattle([enemy()])
    const before = [i.playerGridX, i.playerGridY]
    i.handleSwipe('down')
    expect([i.playerGridX, i.playerGridY]).toEqual(before)
    expect(i.pendingSwipe).toBeNull()
  })

  it('対照: 戦闘していなければスワイプで動く', () => {
    const i = field()
    const before = [i.playerGridX, i.playerGridY]
    i.handleSwipe('down')
    expect([i.playerGridX, i.playerGridY]).not.toEqual(before)
  })

  it('戦闘中のタップでフィールドのメニューを開かない', () => {
    const i = field()
    const toggle = vi.fn()
    i.menuOverlay = { isShowing: () => false, toggleMenu: toggle, showMenu: toggle } as never
    i.startBattle([enemy()])
    i.handleTap()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('移動中にキューされたスワイプは、戦闘開始で破棄され戦闘後に持ち越されない', () => {
    const i = field()
    i.isMoving = true
    i.handleSwipe('left')
    expect(i.pendingSwipe).toBe('left')
    i.startBattle([enemy()])
    expect(i.pendingSwipe).toBeNull()
    close(i)
    expect(i.pendingSwipe).toBeNull()
  })
})

describe('TopDown の ATB tick 配線', () => {
  function tickAt(i: Internals, from: number, to: number) {
    i.lastTickMs = from
    vi.spyOn(performance, 'now').mockReturnValue(to)
    i.onTick()
  }

  it('ATB 戦闘中は onTick が経過ミリ秒を BattleScreen.tick に渡し、ゲージが進む', () => {
    const i = field({ battleAtb: { mode: 'active' } })
    i.startBattle([enemy()])
    const spy = vi.spyOn(i.battleScreen!, 'tick')
    tickAt(i, 1000, 1050)
    expect(spy).toHaveBeenCalledWith(50)
    expect(i.battleScreen!.engine.getState().atb!.partyGauge[0]).toBeGreaterThan(0)
  })

  it('1 フレームの経過は 100ms に丸められる（タブ復帰などの巨大 dt）', () => {
    const i = field({ battleAtb: { mode: 'active' } })
    i.startBattle([enemy()])
    const spy = vi.spyOn(i.battleScreen!, 'tick')
    tickAt(i, 0, 60000)
    expect(spy).toHaveBeenCalledWith(100)
  })

  it('時計が巻き戻っても負の dt は渡さない（0）', () => {
    const i = field({ battleAtb: { mode: 'active' } })
    i.startBattle([enemy()])
    const spy = vi.spyOn(i.battleScreen!, 'tick')
    tickAt(i, 2000, 1000)
    expect(spy).toHaveBeenCalledWith(0)
  })

  it('従来ターン制の戦闘では tick を呼んでもゲージ状態が生まれない', () => {
    const i = field()
    i.startBattle([enemy()])
    tickAt(i, 0, 50)
    expect(i.battleScreen!.engine.getState().atb).toBeUndefined()
  })

  it('戦闘していなければ onTick は BattleScreen を触らず落ちない', () => {
    const i = field()
    expect(() => tickAt(i, 0, 50)).not.toThrow()
  })

  it('戦闘終了後の onTick は旧画面に tick を送らない', () => {
    const i = field({ battleAtb: { mode: 'active' } })
    i.startBattle([enemy()])
    const spy = vi.spyOn(i.battleScreen!, 'tick')
    close(i)
    tickAt(i, 0, 50)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('リサイズ時の戦闘再配置', () => {
  function withCanvas(i: Internals, w: number, h: number) {
    i.app.canvas = { parentElement: { getBoundingClientRect: () => ({ width: w, height: h }) } }
    i.app.renderer = { resize: vi.fn() }
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb()
      return 1
    })
  }

  it('戦闘中のリサイズで BattleScreen.redraw に新しい画面サイズが渡る', () => {
    const i = field()
    withCanvas(i, 1000, 700)
    i.startBattle([enemy()])
    const spy = vi.spyOn(i.battleScreen!, 'redraw')
    i.handleResize()
    expect(spy).toHaveBeenCalledWith(1000, 700)
  })

  it('最小サイズ 320x240 に丸められた値が渡る', () => {
    const i = field()
    withCanvas(i, 100, 100)
    i.startBattle([enemy()])
    const spy = vi.spyOn(i.battleScreen!, 'redraw')
    i.handleResize()
    expect(spy).toHaveBeenCalledWith(320, 240)
  })

  it('戦闘していないリサイズは落ちない', () => {
    const i = field()
    withCanvas(i, 1000, 700)
    expect(() => i.handleResize()).not.toThrow()
  })
})

describe('リスナーの解除', () => {
  it('destroy が keydown / keyup / resize / blur を window から外す', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const r = new TopDownRenderer()
    r.destroy()
    const types = remove.mock.calls.map((c) => c[0])
    for (const t of ['keydown', 'keyup', 'resize', 'blur']) expect(types).toContain(t)
  })
})
