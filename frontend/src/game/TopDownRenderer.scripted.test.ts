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
        nextPage: () => false,
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

describe('魔石 (#889) は脚本の戦闘でも効く', () => {
  const SEA = {
    id: 'sea',
    name: 'うみのませき',
    summon: 'うみの主',
    elements: ['water'],
    target: '相手全体',
    effect: 'damage 30..30 type=water',
    equipBonus: 'atk+50, hp+30',
  }
  const withSea = (rules: string[]): Partial<RPGProject> => ({
    magicites: { sea: SEA },
    party: {
      hero: { ...PARTY.hero, def: 0, magicites: ['sea'] },
      ally: { ...PARTY.ally, def: 0, magicites: ['sea'] },
    },
    battleScripts: {
      duel: { id: 'duel', enemies: 'boss', party: ['hero'], rules },
    },
  })
  type Member = { id: string; atk: number; maxHp: number; attackElements?: string[] }
  const members = (i: Internals): Member[] =>
    (i.battleScreen!.engine.getState() as unknown as { party: Member[] }).party
  const menuSummons = (i: Internals): Record<string, unknown[]> =>
    (i.battleScreen!.opts as unknown as { menu?: { summons?: Record<string, unknown[]> } }).menu
      ?.summons ?? {}

  it('味方: で選んだ初期編成にも、装備ボーナス・属性・召喚が効く', () => {
    const i = field(withSea(['台詞: 条件=開始 文=はじまり']))
    void i.startScriptedBattle('duel')
    const [hero] = members(i)
    expect(hero.id).toBe('hero')
    expect(hero.atk).toBe(PARTY.hero.atk + 50)
    expect(hero.maxHp).toBe(PARTY.hero.hp + 30)
    expect(hero.attackElements).toEqual(['water'])
    expect(menuSummons(i).hero).toHaveLength(1)
  })

  it('途中参戦する味方にも、装備ボーナス・属性・召喚が効く', () => {
    const i = field(withSea(['参戦: 条件=開始 対象=ally']))
    void i.startScriptedBattle('duel')
    const ally = members(i).find((m) => m.id === 'ally')
    expect(ally).toBeDefined()
    expect(ally!.atk).toBe(PARTY.ally.atk + 50)
    expect(ally!.maxHp).toBe(PARTY.ally.hp + 30)
    expect(ally!.attackElements).toEqual(['water'])
    expect(menuSummons(i).ally).toHaveLength(1)
  })

  describe('装備品 (#207) と魔石の両方', () => {
    const GEAR = {
      items: {
        sword: {
          id: 'sword',
          name: 'つるぎ',
          kind: '武器',
          equipBonus: 'atk+8',
          abilities: ['slash'],
        },
        plate: {
          id: 'plate',
          name: 'よろい',
          kind: '鎧',
          equipBonus: 'def+5, hp+20',
          elements: ['fire'],
        },
      },
      skills: {
        slash: { id: 'slash', name: 'きりさく', target: '相手単体', effect: 'damage 5..5' },
      },
    } as unknown as Partial<RPGProject>
    const geared = (rules: string[]): Partial<RPGProject> => {
      const base = withSea(rules)
      const party = base.party as unknown as Record<string, Record<string, unknown>>
      return {
        ...base,
        ...GEAR,
        party: {
          hero: { ...party.hero, equipment: ['sword', 'plate'] },
          ally: { ...party.ally, equipment: ['sword', 'plate'] },
        },
      } as unknown as Partial<RPGProject>
    }
    type Gear = Member & { def: number; affinity?: { halve?: string[] } }
    const check = (m: Gear | undefined, base: { atk: number; hp: number }): void => {
      expect(m).toBeDefined()
      expect(m!.atk).toBe(base.atk + 50 + 8) // 魔石 + 武器
      expect(m!.maxHp).toBe(base.hp + 30 + 20) // 魔石 + 鎧
      expect(m!.def).toBe(5)
      expect(m!.attackElements).toEqual(['water']) // 鎧の属性は攻撃に乗らない
      expect(m!.affinity?.halve).toContain('fire') // 鎧の属性で火に強い（半減）
    }
    const skillsOf = (i: Internals): Record<string, { id: string }[]> =>
      (i.battleScreen!.opts as unknown as { menu?: { skills?: Record<string, { id: string }[]> } })
        .menu?.skills ?? {}

    it('味方: で選んだ初期編成: 武器・鎧の能力値と耐性・わざ、魔石が全部効く', () => {
      const i = field(geared(['台詞: 条件=開始 文=はじまり']))
      void i.startScriptedBattle('duel')
      check(members(i)[0] as Gear, PARTY.hero)
      expect(skillsOf(i).hero?.map((e) => e.id)).toEqual(['slash'])
      expect(menuSummons(i).hero).toHaveLength(1)
    })

    it('途中参戦する味方にも、全部効く', () => {
      const i = field(geared(['参戦: 条件=開始 対象=ally']))
      void i.startScriptedBattle('duel')
      check(members(i).find((m) => m.id === 'ally') as Gear, PARTY.ally)
      expect(skillsOf(i).ally?.map((e) => e.id)).toEqual(['slash'])
      expect(menuSummons(i).ally).toHaveLength(1)
    })
  })

  it('魔石を宣言しないゲームは従来どおり（ボーナス・属性なし）', () => {
    const i = field({
      battleScripts: { duel: { id: 'duel', enemies: 'boss', party: ['hero'], rules: [] } },
    })
    void i.startScriptedBattle('duel')
    const [hero] = members(i)
    expect(hero.atk).toBe(PARTY.hero.atk)
    expect(hero.attackElements).toBeUndefined()
  })
})
