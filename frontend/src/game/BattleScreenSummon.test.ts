/**
 * BattleScreen の「しょうかん」(#889): コマンド summon が候補窓を開き、対象選択 → 確定でエンジンの selectSummon に届く。
 * 呼び済み・MP 不足はグレーで、確定するとエンジンが理由を知らせる（状態は変わらない）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import 'pixi.js/events'
import type { Container } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleMenuData, MenuStack } from './battleMenu'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 5,
    maxMp: 5,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

const MENU: BattleMenuData = {
  summons: {
    a: [
      {
        id: 'sea',
        name: 'うみの主',
        target: '相手全体',
        mp: 0,
        effect: 'damage 12..12',
        message: '{user} は うみの主 を よびだした！',
      },
      { id: 'tiger', name: 'ひのとら', target: '相手単体', mp: 3, effect: 'damage 30..30' },
    ],
  },
}

interface Internals {
  destroyed: boolean
  menuStack: MenuStack
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(opts: BattleScreenOptions = {}, party: BattleEntity[] = [ent('a')]) {
  const enemies = [ent('s1', { atk: 0 }), ent('s2', { atk: 0 })]
  const engine = new BattleEngine(party, enemies, { rng: () => 0 })
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    commandLayout: 'cross',
    commands: ['attack', 'summon', 'spell', 'item', 'escape'],
    menu: structuredClone(MENU),
    ...opts,
  })
  created.push(s)
  return { s, engine, enemies }
}

function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  globalThis.dispatchEvent(e)
  return e
}
const types = (s: BattleScreen) => I(s).menuStack.map((w) => w.type)
const labels = (s: BattleScreen) =>
  (s as unknown as { commands: Array<{ id: string; text: { text: string } }> }).commands.map(
    (c) => `${c.id}:${c.text.text}`
  )

afterEach(() => {
  for (const s of created.splice(0)) if (!I(s).destroyed) s.destroy({ children: true })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('コマンド「しょうかん」(#889)', () => {
  it('commands に書いたとき、既定の表示名「しょうかん」で並ぶ（書かなければ出ない）', () => {
    const { s } = build()
    expect(labels(s)).toEqual([
      'attack:たたかう',
      'summon:しょうかん',
      'spell:じゅもん',
      'item:どうぐ',
      'escape:にげる',
    ])
    const { s: plain } = build({ commands: undefined })
    expect(labels(plain)).toEqual([
      'attack:たたかう',
      'spell:じゅもん',
      'item:どうぐ',
      'escape:にげる',
    ])
  })

  it('一覧 → （全体召喚は）対象窓 → 確定で全員に当たり、召喚済みの印が立つ。MP 0 の召喚は MP を使わない', () => {
    const { s, engine, enemies } = build({ commands: ['summon', 'attack', 'spell', 'item'] })
    press('ArrowUp') // 1 番目 = summon
    expect(types(s)).toEqual(['list'])
    expect(I(s).menuStack[0]).toMatchObject({ kind: 'summon' })
    press('Enter') // うみの主（相手全体）
    expect(types(s)).toEqual(['list', 'target'])
    press('Enter')
    expect(types(s)).toEqual([])
    expect(enemies.map((e) => e.hp)).toEqual([88, 88])
    const st = engine.getState()
    expect(st.party[0].summoned).toBe(true)
    expect(st.party[0].mp).toBe(5)
    expect(st.log.some((l) => l.includes('A は うみの主 を よびだした！'))).toBe(true)
  })

  it('単体の召喚は敵を選んで確定。MP を消費する', () => {
    const { engine, enemies } = build({ commands: ['summon', 'attack', 'spell', 'item'] })
    press('ArrowUp')
    press('ArrowDown') // ひのとら
    press('Enter')
    press('ArrowDown') // 2 体目へ
    press('Enter')
    expect(enemies.map((e) => e.hp)).toEqual([100, 70])
    expect(engine.getState().party[0].mp).toBe(2)
  })

  it('呼んだあとは一覧の全行がグレー。確定するとエンジンが理由を知らせ、窓は閉じず・手番も進まない', () => {
    const { s, engine, enemies } = build({ commands: ['summon', 'attack', 'spell', 'item'] })
    press('ArrowUp')
    press('Enter')
    press('Enter') // うみの主を呼ぶ
    const hpAfter = enemies.map((e) => e.hp)
    press('ArrowUp') // もう一度開く
    expect(types(s)).toEqual(['list'])
    press('Enter') // グレー行を確定
    expect(types(s)).toEqual(['list']) // 窓は閉じない
    const st = engine.getState()
    expect(st.log[st.log.length - 1]).toBe('このたたかいでは もう よべない！')
    expect(enemies.map((e) => e.hp)).toEqual(hpAfter)
    expect(st.phase).toBe('party-input')
  })

  it('MP 不足の召喚はグレー。確定すると「MPが たりない！」で、印は立たない', () => {
    const { s, engine } = build({ commands: ['summon', 'attack', 'spell', 'item'] }, [
      ent('a', { mp: 2 }),
    ])
    press('ArrowUp')
    press('ArrowDown') // ひのとら（MP 3）
    press('Enter')
    expect(types(s)).toEqual(['list'])
    const st = engine.getState()
    expect(st.log[st.log.length - 1]).toBe('MPが たりない！')
    expect(st.party[0].summoned).toBeUndefined()
  })

  it('召喚の候補が無い味方は、しょうかんを選んでも何も起きない', () => {
    const { s, engine } = build(
      { commands: ['summon', 'attack', 'spell', 'item'], menu: structuredClone(MENU) },
      [ent('z')]
    )
    press('ArrowUp')
    expect(types(s)).toEqual([])
    expect(engine.getState().log).toHaveLength(1)
  })

  it('Escape で一覧から戻れる。タップ（ボタン）でも一覧が開く', () => {
    const { s } = build({ commands: ['summon', 'attack', 'spell', 'item'] })
    const first = (s as unknown as { commands: Array<{ hit: Container }> }).commands[0].hit
    first.emit('pointertap', {} as never)
    expect(types(s)).toEqual(['list'])
    press('Escape')
    expect(types(s)).toEqual([])
  })
})
