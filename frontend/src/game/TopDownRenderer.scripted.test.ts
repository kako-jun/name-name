/**
 * TopDownRenderer の脚本制御の戦闘 (#741): `startScriptedBattle` / イベントの `[戦闘: id]` から、
 * 宣言どおりの敵・編成・脚本で戦闘画面が開き、終了で結果（結果フラグ・次のイベント）を返してイベントを再開する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { TopDownRenderer } from './TopDownRenderer'
import type { RPGProject } from '../types/rpg'
import type { BattleResult } from './loot'

interface Internals {
  app: { stage: Container }
  initialized: boolean
  screenWidth: number
  screenHeight: number
  encounterCooldown: number
  inputLocked: boolean
  eventRunner: { run(c: unknown[], done?: () => void): void; isRunning: boolean } | null
  battleScreen: {
    opts: { onClose: (o: string, r: BattleResult) => void; [k: string]: unknown }
    engine: {
      getState(): {
        party: { id: string }[]
        enemies: { id: string }[]
        script?: { id: string }
        phase: string
      }
      getResult(): BattleResult | null
      selectAttack(): void
      selectEscape(): void
    }
    tick(ms: number): void
  } | null
  dialogBox: { isShowing: boolean; hide(): void } | null
  startScriptedBattle(id: string): Promise<BattleResult | null>
  load(p: RPGProject): void
}

const MONSTERS = {
  boss: { id: 'boss', name: 'ボス', hp: 5, atk: 0, def: 0, agi: 1, exp: 3, gold: 2 },
}
const PARTY = {
  hero: { id: 'hero', name: 'ぼく', level: 1, hp: 30, mp: 0, atk: 99, def_value: 0, agi: 5 },
  ally: { id: 'ally', name: 'なかま', level: 1, hp: 30, mp: 0, atk: 9, def_value: 0, agi: 5 },
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
    monsters: MONSTERS,
    party: PARTY,
    partyOrder: ['hero', 'ally'],
    battleLayout: 'side',
    battleScripts: {
      duel: {
        id: 'duel',
        enemies: 'boss',
        party: ['hero'],
        rules: ['勝利時: フラグ=won=true 次=after'],
      },
      cut: { id: 'cut', enemies: 'boss', rules: ['固定: 結果=中断 上限ターン=1'] },
    },
    rpgEvents: [{ name: 'after', commands: [{ type: 'Narration', text: ['おわり'] }] }],
    ...over,
  } as RPGProject
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

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startScriptedBattle', () => {
  it('宣言どおりの敵・初期編成・脚本で戦闘画面が開き、終了で結果（フラグ・次）を返し、ハンドラにも渡る', async () => {
    const i = field()
    const ended: BattleResult[] = []
    ;(
      i as unknown as { setBattleEndHandler(h: (r: BattleResult) => void): void }
    ).setBattleEndHandler((r) => ended.push(r))
    const p = i.startScriptedBattle('duel')
    const st = i.battleScreen!.engine.getState()
    expect(st.enemies.map((e) => e.id)).toEqual(['boss'])
    expect(st.party.map((e) => e.id)).toEqual(['hero']) // 味方: hero だけ（ally は参戦待ち）
    expect(st.script?.id).toBe('duel')
    i.battleScreen!.engine.selectAttack() // atk 99 で一撃
    expect(i.battleScreen!.engine.getState().phase).toBe('victory')
    const result = i.battleScreen!.engine.getResult()!
    i.battleScreen!.opts.onClose('victory', result)
    const r = await p
    expect(r?.script).toEqual({ id: 'duel', flags: { won: true }, next: 'after' })
    expect(ended).toHaveLength(1)
    expect(ended[0]).toBe(r)
    expect(i.battleScreen).toBeNull()
  })

  it('中断（interrupted）でも解決する。戦闘後のクールダウンも張る', async () => {
    const i = field()
    const p = i.startScriptedBattle('cut')
    i.battleScreen!.engine.selectAttack()
    i.battleScreen!.opts.onClose('interrupted', i.battleScreen!.engine.getResult()!)
    expect((await p)?.outcome).toBe('interrupted')
    expect(i.encounterCooldown).toBe(3)
  })

  it('宣言が無い id・敵が組めない宣言・すでに戦闘中は、戦闘を始めず null で解決する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const i = field({
      battleScripts: {
        noenemy: { id: 'noenemy', rules: [] },
        ghost: { id: 'ghost', enemies: 'nobody', rules: [] },
        ok: { id: 'ok', enemies: 'boss', rules: [] },
      },
    })
    expect(await i.startScriptedBattle('missing')).toBeNull()
    expect(await i.startScriptedBattle('noenemy')).toBeNull()
    expect(await i.startScriptedBattle('ghost')).toBeNull()
    expect(i.battleScreen).toBeNull()
    void i.startScriptedBattle('ok')
    expect(i.battleScreen).not.toBeNull()
    expect(await i.startScriptedBattle('ok')).toBeNull() // 二重起動しない
    const none = field({ battleScripts: undefined })
    expect(await none.startScriptedBattle('ok')).toBeNull()
    // __proto__ / constructor という id でも落ちない
    expect(await i.startScriptedBattle('constructor')).toBeNull()
  })

  it('戦闘中に load() で強制終了されると解決せず、続きのイベントも動かさない', async () => {
    const i = field()
    let resolved = false
    void i.startScriptedBattle('duel').then(() => (resolved = true))
    i.load(project())
    await flush()
    expect(resolved).toBe(false)
    expect(i.battleScreen).toBeNull()
  })
})

describe('[戦闘: id] を含む [イベント] の再生', () => {
  it('イベントは戦闘の終了を待ち、`次=` のイベントへ分岐して再開する', async () => {
    const i = field({
      rpgEvents: [
        {
          name: 'go',
          commands: [
            { type: 'Battle', id: 'duel' },
            { type: 'Narration', text: ['捨てられる'] },
          ],
        },
        { name: 'after', commands: [{ type: 'Narration', text: ['おわり'] }] },
      ],
    })
    const shown: string[] = []
    i.dialogBox = {
      isShowing: false,
      hide: () => {},
      ...({
        show: (_n: string, t: string) => shown.push(t),
        isTyping: () => false,
        skipTypewriter: () => {},
        setMsPerChar: () => {},
      } as object),
    } as Internals['dialogBox']
    // イベントランナーは dialogBox を作成時に掴むので、差し替えた dialogBox で作り直す
    const { EventRunner } = await import('./eventRunner')
    const ctx = i as unknown as {
      eventRunner: unknown
      gameData: RPGProject
      startScriptedBattle: Internals['startScriptedBattle']
    }
    ctx.eventRunner = new EventRunner(
      i.dialogBox as never,
      { moveNpcTo: () => Promise.resolve() },
      {
        startBattle: (id) => ctx.startScriptedBattle(id),
        findEvent: (n) => ctx.gameData.rpgEvents?.find((e) => e.name === n)?.commands,
      }
    )
    ;(ctx.eventRunner as { run(c: unknown[]): void }).run(ctx.gameData.rpgEvents![0].commands)
    expect(i.battleScreen).not.toBeNull()
    i.battleScreen!.engine.selectAttack()
    i.battleScreen!.opts.onClose('victory', i.battleScreen!.engine.getResult()!)
    await flush()
    expect(shown).toEqual(['おわり'])
  })
})
