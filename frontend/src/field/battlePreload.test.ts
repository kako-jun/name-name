import { describe, expect, it, vi } from 'vitest'
import type { EventCommand, MonsterDef } from '../types'
import type { FieldTrigger } from './config'
import type { FieldSceneConfig } from './config'
import {
  collectBattlePreloadUrls,
  createFieldPreloader,
  firstAutoBattleId,
  neighborSceneIds,
  preloadBattleImages,
  sceneEncounterGroups,
} from './battlePreload'

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
      enemyGroups: ['boss+slime*2'],
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
        enemyGroups: ['ghost+constructor+slime'],
        monsters,
        party: [],
      })
    ).toEqual(['e/slime.png'])
    expect(collectBattlePreloadUrls({ enemyGroups: [undefined], monsters, party: [] })).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(collectBattlePreloadUrls({ enemyGroups: [], monsters, party: [] })).toEqual([])
    warn.mockRestore()
  })
  it('複数の群は全部の敵の和集合（重複なし・群の書いた順）で、undefined の群は飛ばす', () => {
    const urls = collectBattlePreloadUrls({
      enemyGroups: ['slime*2', undefined, 'boss+slime', ''],
      monsters,
      party,
      background: 'bg/battle.png',
      effectImages: ['fx/hit.png'],
      uiImages: ['ui/hand.png'],
    })
    expect(urls).toEqual([
      'bg/battle.png',
      'e/slime.png',
      'e/boss.png',
      'e/boss-idle.png',
      'e/boss-slash.png',
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
  it('脚本の戦闘の `,` `、` 区切りも + と同じに読む', () => {
    expect(
      collectBattlePreloadUrls({ enemyGroups: ['slime、boss,slime'], monsters, party: [] })
    ).toEqual(['e/slime.png', 'e/boss.png', 'e/boss-idle.png', 'e/boss-slash.png'])
  })
})

describe('sceneEncounterGroups: 場面のエンカウント群', () => {
  it('エンカウントなし (null) は空', () => {
    expect(sceneEncounterGroups({ encounter: null })).toEqual([])
  })
  it('率 0 は空（戦闘が起きないので読まない）', () => {
    expect(sceneEncounterGroups({ encounter: { rate: 0, groups: ['slime'] } as never })).toEqual([])
  })
  it('通常は群をそのまま（コピーを返す）', () => {
    const groups = ['M104+M148', 'slime*2']
    const enc = { rate: 0.1, groups } as never
    const out = sceneEncounterGroups({ encounter: enc })
    expect(out).toEqual(groups)
    expect(out).not.toBe(groups)
  })
})

describe('neighborSceneIds: 端の出口でつながる隣の場面', () => {
  const link = (to: string) => ({ to })
  const scenes = {
    a: { links: [link('b'), link('c'), link('b'), link('a'), link('ghost')] },
    b: { links: [link('a')] },
    c: { links: [] },
  } as unknown as Record<string, Pick<FieldSceneConfig, 'links'>>
  it('重複なし・書いた順で、自分自身と設定に無い行き先は除く', () => {
    expect(neighborSceneIds(scenes, 'a')).toEqual(['b', 'c'])
  })
  it('出口の無い場面は空', () => {
    expect(neighborSceneIds(scenes, 'c')).toEqual([])
  })
  it('知らない場面 id（継承の名前も）は空', () => {
    expect(neighborSceneIds(scenes, 'nope')).toEqual([])
    expect(neighborSceneIds(scenes, 'constructor')).toEqual([])
  })
})

describe('createFieldPreloader: 場面のまわりの先読み', () => {
  /** 外から解決・拒否できる Promise */
  interface Deferred {
    promise: Promise<unknown>
    resolve: () => void
    reject: () => void
  }
  const deferred = (): Deferred => {
    let resolve!: () => void
    let reject!: () => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = () => res(undefined)
      reject = () => rej(new Error('boom'))
    })
    return { promise, resolve, reject }
  }
  /** microtask を十分に回す */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const graph: Record<string, string[]> = { a: ['b', 'c'], b: ['a'], c: ['a'] }
  const urlsOf: Record<string, string[]> = {
    a: ['a1.png', 'a2.png'],
    b: ['b1.png', 'a1.png'],
    c: ['c1.png'],
  }
  function setup(over: Partial<Parameters<typeof createFieldPreloader>[0]> = {}) {
    const imageDefs = new Map<string, Deferred[]>()
    const sceneDefs = new Map<string, Deferred[]>()
    const imageCalls: string[] = []
    const sceneCalls: string[] = []
    const warn = vi.fn()
    const push = (m: Map<string, Deferred[]>, k: string): Promise<unknown> => {
      const d = deferred()
      m.set(k, [...(m.get(k) ?? []), d])
      return d.promise
    }
    const pre = createFieldPreloader({
      battleUrls: (id) => urlsOf[id] ?? [],
      loadImage: (u) => {
        imageCalls.push(u)
        return push(imageDefs, u)
      },
      loadScene: (id) => {
        sceneCalls.push(id)
        return push(sceneDefs, id)
      },
      neighbors: (id) => graph[id] ?? [],
      warn,
      ...over,
    })
    const last = (m: Map<string, Deferred[]>, k: string) => m.get(k)![m.get(k)!.length - 1]
    return { pre, imageCalls, sceneCalls, warn, imageDefs, sceneDefs, last }
  }

  it('段の順: 1 段目の絵が全部済むまで隣の場面を読まず、隣の場面が済むまで隣の絵を読まない', async () => {
    const t = setup()
    const p = t.pre.around('a')
    await flush()
    expect(t.imageCalls).toEqual(['a1.png', 'a2.png']) // 段の中は同時
    expect(t.sceneCalls).toEqual([])
    t.last(t.imageDefs, 'a1.png').resolve()
    await flush()
    expect(t.sceneCalls).toEqual([]) // a2 がまだ
    t.last(t.imageDefs, 'a2.png').resolve()
    await flush()
    expect(t.sceneCalls).toEqual(['b', 'c']) // 隣は同時
    expect(t.imageCalls).toEqual(['a1.png', 'a2.png'])
    t.last(t.sceneDefs, 'b').resolve()
    await flush()
    expect(t.imageCalls).toEqual(['a1.png', 'a2.png']) // c がまだ
    t.last(t.sceneDefs, 'c').resolve()
    await flush()
    // 3 段目: 隣の絵（a1.png は既に要求済みなので重ねない）
    expect(t.imageCalls).toEqual(['a1.png', 'a2.png', 'b1.png', 'c1.png'])
    t.last(t.imageDefs, 'b1.png').resolve()
    t.last(t.imageDefs, 'c1.png').resolve()
    await expect(p).resolves.toBeUndefined()
    expect(t.warn).not.toHaveBeenCalled()
  })

  it('新しい around が来たら、古い呼び出しは次の段へ進まない', async () => {
    const t = setup()
    const p1 = t.pre.around('a')
    await flush()
    const p2 = t.pre.around('c') // c の絵: c1.png
    await flush()
    t.imageDefs.forEach((ds) => ds.forEach((d) => d.resolve()))
    await flush()
    // a の隣 (b, c) は読まれず、c の隣 (a) だけが読まれる
    expect(t.sceneCalls).toEqual(['a'])
    t.sceneDefs.forEach((ds) => ds.forEach((d) => d.resolve()))
    await Promise.all([p1, p2])
    expect(t.sceneCalls).toEqual(['a'])
  })

  it('同じ絵・場面は 2 回目以降の around で重ねて要求しない', async () => {
    const t = setup()
    const p1 = t.pre.around('a')
    await flush()
    t.imageDefs.forEach((ds) => ds.forEach((d) => d.resolve()))
    await flush()
    t.sceneDefs.forEach((ds) => ds.forEach((d) => d.resolve()))
    await flush()
    t.imageDefs.forEach((ds) => ds.forEach((d) => d.resolve()))
    await p1
    const images = [...t.imageCalls]
    const scenes = [...t.sceneCalls]
    const p2 = t.pre.around('a')
    await p2
    expect(t.imageCalls).toEqual(images)
    expect(t.sceneCalls).toEqual(scenes)
  })

  it('失敗した絵は警告を 1 件出し、次の around で読み直す', async () => {
    const t = setup({ neighbors: () => [] })
    const p1 = t.pre.around('a')
    await flush()
    t.last(t.imageDefs, 'a1.png').reject()
    t.last(t.imageDefs, 'a2.png').resolve()
    await p1
    expect(t.warn).toHaveBeenCalledTimes(1)
    expect(t.warn.mock.calls[0][0]).toContain('a1.png')
    const p2 = t.pre.around('a')
    await flush()
    expect(t.imageCalls).toEqual(['a1.png', 'a2.png', 'a1.png']) // 失敗分だけ
    t.last(t.imageDefs, 'a1.png').resolve()
    await p2
    expect(t.warn).toHaveBeenCalledTimes(1)
  })

  it('失敗した場面は警告を出して先へ進み、次の around で読み直す', async () => {
    const t = setup({ battleUrls: () => [] })
    const p1 = t.pre.around('a')
    await flush()
    t.last(t.sceneDefs, 'b').reject()
    t.last(t.sceneDefs, 'c').resolve()
    await p1
    expect(t.warn).toHaveBeenCalledTimes(1)
    expect(t.warn.mock.calls[0][0]).toContain('b')
    const p2 = t.pre.around('a')
    await flush()
    expect(t.sceneCalls).toEqual(['b', 'c', 'b'])
    t.last(t.sceneDefs, 'b').resolve()
    await p2
  })

  it('battleUrls が例外を投げても解決し、警告する', async () => {
    const t = setup({
      battleUrls: () => {
        throw new Error('broken')
      },
    })
    await expect(t.pre.around('a')).resolves.toBeUndefined()
    expect(t.warn).toHaveBeenCalledTimes(1)
    expect(t.warn.mock.calls[0][0]).toContain('broken')
  })

  it('全部失敗しても解決する', async () => {
    const t = setup({
      loadImage: () => Promise.reject(new Error('net')),
      loadScene: () => Promise.reject(new Error('net')),
    })
    await expect(t.pre.around('a')).resolves.toBeUndefined()
    expect(t.warn).toHaveBeenCalled()
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
