import { describe, expect, it, vi } from 'vitest'
import type { EventCommand, MonsterDef } from '../types'
import type { FieldTrigger } from './config'
import { collectBattlePreloadUrls, firstAutoBattleId, preloadBattleImages } from './battlePreload'

const battleCmd = (id: string): EventCommand => ({ type: 'Battle', id })
const talk = (): EventCommand => ({ type: 'Narration', text: ['……'] })
const auto = (event: string, once = true): FieldTrigger => ({ auto: true, event, once })

describe('firstAutoBattleId: 冒頭の戦闘の特定', () => {
  const events = new Map<string, EventCommand[]>([
    ['intro', [talk(), battleCmd('b1'), battleCmd('b2')]],
    ['talkonly', [talk()]],
    ['later', [battleCmd('b3')]],
  ])
  it('auto トリガーのイベントで最初に始まる戦闘の id', () => {
    expect(
      firstAutoBattleId({ sceneId: 's', triggers: [auto('intro')], events, resumedStart: false })
    ).toBe('b1')
  })
  it('戦闘の無い auto は飛ばして、次の auto の戦闘を見る', () => {
    expect(
      firstAutoBattleId({
        sceneId: 's',
        triggers: [auto('talkonly'), auto('later')],
        events,
        resumedStart: false,
      })
    ).toBe('b3')
  })
  it('踏み込みトリガー（auto でない）は対象外', () => {
    const step: FieldTrigger = { auto: false, event: 'intro', once: true, x: 1, y: 1, radius: 10 }
    expect(
      firstAutoBattleId({ sceneId: 's', triggers: [step], events, resumedStart: false })
    ).toBeUndefined()
  })
  it('セーブ再開の直後は auto を起こさないので先読みもしない', () => {
    expect(
      firstAutoBattleId({ sceneId: 's', triggers: [auto('intro')], events, resumedStart: true })
    ).toBeUndefined()
  })
  it('脚本が無い・イベントが無いときは undefined（例外にしない）', () => {
    expect(
      firstAutoBattleId({
        sceneId: 's',
        triggers: [auto('intro')],
        events: undefined,
        resumedStart: false,
      })
    ).toBeUndefined()
    expect(
      firstAutoBattleId({
        sceneId: 's',
        triggers: [auto('missing')],
        events,
        resumedStart: false,
      })
    ).toBeUndefined()
  })
})

describe('collectBattlePreloadUrls: 先読みする URL', () => {
  const monsters = {
    slime: { id: 'slime', name: 'S', hp: 1, atk: 1, def: 1, agi: 1, sprite: 'e/slime.png' },
    boss: {
      id: 'boss',
      name: 'B',
      hp: 1,
      atk: 1,
      def: 1,
      agi: 1,
      sprite: 'e/boss.png',
      poses: { idle: 'e/boss-idle.png', slash: 'e/boss-slash.png' },
    },
  } as unknown as Record<string, MonsterDef>
  const party = [
    { sprite: 'p/a.png', poses: { idle: 'p/a-idle.png', ready: 'p/a-ready.png' } },
    { sprite: 'p/b.png', poses: { idle: 'p/b-idle.png' }, weapon: { image: 'w/katana.png' } },
  ] as never[]

  it('背景 → 敵 → 味方 → エフェクト・UI の順で、重複しない', () => {
    const urls = collectBattlePreloadUrls({
      def: { enemies: 'boss+slime*2' },
      monsters,
      party,
      background: 'bg/battle.png',
      effectImages: ['fx/hit.png', 'p/a.png'],
      uiImages: ['ui/hand.png', undefined],
    })
    expect(urls).toEqual([
      'bg/battle.png',
      'e/boss.png',
      'e/boss-idle.png',
      'e/boss-slash.png',
      'e/slime.png',
      'p/a.png',
      'p/a-idle.png',
      'p/a-ready.png',
      'p/b.png',
      'p/b-idle.png',
      'w/katana.png',
      'fx/hit.png',
      'ui/hand.png',
    ])
  })
  it('知らない敵・継承の名前・敵の指定なしは黙って飛ばす（警告も例外も出さない）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      collectBattlePreloadUrls({
        def: { enemies: 'ghost+constructor+slime' },
        monsters,
        party: [],
      })
    ).toEqual(['e/slime.png'])
    expect(collectBattlePreloadUrls({ def: {}, monsters, party: [] })).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('preloadBattleImages: 失敗しても戦闘を妨げない', () => {
  it('1 枚が失敗しても残りを読み切り、例外を出さず、読めた枚数を返す', async () => {
    const loaded: string[] = []
    const n = await preloadBattleImages(['a', 'bad', 'c'], async (u) => {
      if (u === 'bad') throw new Error('HTTP 404')
      loaded.push(u)
    })
    expect(n).toBe(2)
    expect(loaded).toEqual(['a', 'c'])
  })
  it('全部失敗しても解決する', async () => {
    await expect(
      preloadBattleImages(['x', 'y'], () => Promise.reject(new Error('net')))
    ).resolves.toBe(0)
  })
  it('並列に読み始める（前の 1 枚の完了を待たない）', async () => {
    const started: string[] = []
    const gates: Array<() => void> = []
    const p = preloadBattleImages(['a', 'b', 'c'], (u) => {
      started.push(u)
      return new Promise<void>((r) => gates.push(r))
    })
    expect(started).toEqual(['a', 'b', 'c'])
    gates.forEach((g) => g())
    await expect(p).resolves.toBe(3)
  })
  it('URL が空でも解決する', async () => {
    await expect(preloadBattleImages([], vi.fn())).resolves.toBe(0)
  })
})
