/**
 * 新規開始 `startFrom` の契約 (#734 PR2, ADR 0003 §2・§3)。
 *
 * 遅延ロードを通ること・不在なら状態を変えないこと・flags と confinement が適用の前に確定すること・
 * 持ち越さないこと・`target: 'entry'`・開始しない読み込み（`loadEvents` / `loadScenes`）を検証する。
 * 実描画（WebGL）は jsdom 対象外（CLAUDE.md ルール7 の実機 golden path に委ねる）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { ChoiceOption, Event, EventScene, FlagValue } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function background(path: string): Event {
  return { Background: { path } }
}
function bgm(path: string): Event {
  return { Bgm: { path, action: 'Play' } }
}
function wait(ms: number): Event {
  return { Wait: { ms } }
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}
const bool = (b: boolean): FlagValue => ({ Bool: b })

/** 冒頭がテキストの Choice シーン。全 option が圏外だと先回り終劇する (#398)。 */
function choiceScene(id: string, options: ChoiceOption[]): EventScene {
  return scene(id, [{ Choice: { options } } as Event])
}

interface Internals {
  waitingForWait: boolean
  history: unknown[]
  pendingEntry: unknown
  consecutiveJumps: number
  confinedSceneIds: string[] | null
  initialized: boolean
}
const internals = (r: NovelRenderer): Internals => r as unknown as Internals

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  r.setScenes(scenes)
  return r
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const HUB = scene('hub', [background('hub.png'), bgm('hub.mp3'), narration('hub')])
const ROUTE = scene('route', [background('route.png'), narration('route-line')])

describe('startFrom: 新規開始の契約 (#734 PR2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    new SaveManager().deleteQuickSave()
  })

  it('未ロードのシーンを missingSceneResolver で解決して入場する（Promise が entered で解決する）', async () => {
    const r = makeRenderer([HUB])
    internals(r).initialized = true
    const d = deferred<EventScene[] | null>()
    r.setMissingSceneResolver(() => d.promise)

    const p = r.startFrom({ sceneId: 'route', flags: { f: bool(true) } })
    // 解決中は入場中ゲートが立ち、状態はまだ変わらない
    expect(internals(r).pendingEntry).not.toBeNull()
    expect(r.getCurrentSceneId()).not.toBe('route')

    d.resolve([HUB, ROUTE])
    await expect(p).resolves.toEqual({ status: 'entered', sceneId: 'route' })
    expect(r.getCurrentSceneId()).toBe('route')
    expect(r.getSnapshot().flags).toEqual({ f: bool(true) })
    expect(internals(r).pendingEntry).toBeNull()
  })

  it('不在（resolver が null / resolver 無し）なら failed を返し、状態を一切変えない（flags・confinement・storyEnded）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([HUB])
    internals(r).initialized = true
    await r.startFrom({ sceneId: 'hub', flags: { keep: bool(true) }, confinedSceneIds: ['hub'] })
    const before = r.getSnapshot()

    // resolver 無し
    await expect(
      r.startFrom({ sceneId: 'ghost', flags: { wiped: bool(true) }, confinedSceneIds: null })
    ).resolves.toEqual({ status: 'failed', reason: 'not-found' })
    // resolver が null を返す
    r.setMissingSceneResolver(() => Promise.resolve(null))
    await expect(
      r.startFrom({ sceneId: 'ghost', flags: { wiped: bool(true) }, confinedSceneIds: null })
    ).resolves.toEqual({ status: 'failed', reason: 'not-found' })

    expect(r.getSnapshot().flags).toEqual(before.flags)
    expect(r.getCurrentSceneId()).toBe('hub')
    expect(internals(r).confinedSceneIds).toEqual(['hub']) // 成功時にだけ置き換わる
  })

  it('confinement は成功時に入場属性として置き換わる（省略・null なら解除）', async () => {
    const r = makeRenderer([HUB, ROUTE])
    await r.startFrom({ sceneId: 'route', confinedSceneIds: ['route'] })
    expect(internals(r).confinedSceneIds).toEqual(['route'])
    await r.startFrom({ sceneId: 'hub' })
    expect(internals(r).confinedSceneIds).toBeNull()
  })

  it('confinement は適用の前に確定する: 冒頭が全 option 圏外の Choice なら、その場で終劇する (#398)', async () => {
    const r = makeRenderer([
      HUB,
      choiceScene('gate', [
        { text: 'a', jump: 'hub' },
        { text: 'b', jump: 'elsewhere' },
      ]),
    ])
    const ended = vi.fn()
    r.setOnStoryEndedChange(ended)
    await r.startFrom({ sceneId: 'gate', confinedSceneIds: ['gate'] })
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(ended).toHaveBeenCalledWith(true)
  })

  it('終劇中に新規開始すると解除され、endStory が二重発火ガードで潰れない（再び先回り終劇できる）', async () => {
    const gate = choiceScene('gate', [{ text: 'a', jump: 'hub' }])
    const r = makeRenderer([HUB, gate])
    const ended = vi.fn()
    r.setOnStoryEndedChange(ended)
    await r.startFrom({ sceneId: 'gate', confinedSceneIds: ['gate'] })
    expect(r.getSnapshot().storyEnded).toBe(true)

    // 終劇中に別の局面から新規開始 → 解除される
    await r.startFrom({ sceneId: 'hub' })
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(ended).toHaveBeenLastCalledWith(false)

    // 同じ終劇する局面へ再び新規開始 → もう一度終劇が発火する
    ended.mockClear()
    await r.startFrom({ sceneId: 'gate', confinedSceneIds: ['gate'] })
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(ended).toHaveBeenCalledWith(true)
  })

  it('背景・BGM をクリアし、ハブの currentBackgroundPath を持ち込まない（対象シーンが背景を持たないとき）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bare = scene('bare', [narration('bare')])
    const r = makeRenderer([HUB, bare])
    await r.startFrom({ sceneId: 'hub' })
    expect(r.getSnapshot().backgroundPath).toBe('hub.png')
    expect(r.getSnapshot().currentBgmPath).toBe('hub.mp3')

    await r.startFrom({ sceneId: 'bare' })
    expect(r.getSnapshot().backgroundPath).toBeNull()
    expect(r.getSnapshot().currentBgmPath).toBeNull()
    expect(r.getSnapshot().characters).toEqual([])
  })

  it('進行（jumpToScene）は従来どおり背景・BGM を持ち越す（新規開始との対比）', async () => {
    const bare = scene('bare', [narration('bare')])
    const r = makeRenderer([HUB, bare])
    await r.startFrom({ sceneId: 'hub' })
    await r.jumpToScene('bare')
    expect(r.getSnapshot().backgroundPath).toBe('hub.png')
    expect(r.getSnapshot().currentBgmPath).toBe('hub.mp3')
  })

  it('consecutiveJumps を 0 に戻す', async () => {
    const r = makeRenderer([HUB, ROUTE])
    internals(r).consecutiveJumps = 7
    await r.startFrom({ sceneId: 'route' })
    expect(internals(r).consecutiveJumps).toBe(0)
  })

  it('DEV: 対象シーンが最初のテキストまでに [背景:] を持たないと警告する（持つなら警告しない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bare = scene('bare', [narration('bare')])
    const r = makeRenderer([HUB, bare])
    await r.startFrom({ sceneId: 'hub' })
    expect(warn).not.toHaveBeenCalled()
    await r.startFrom({ sceneId: 'bare' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[背景:]')
  })

  it("sceneId 省略（target 'entry'）はエントリ文書の先頭から始まり、flags を置換する", async () => {
    const r = makeRenderer([HUB, ROUTE])
    await r.startFrom({ sceneId: 'route', flags: { old: bool(true) } })
    expect(r.getCurrentSceneId()).toBe('route')

    await expect(r.startFrom({ flags: { fresh: bool(true) } })).resolves.toEqual({
      status: 'entered',
      sceneId: 'hub',
    })
    expect(r.getCurrentSceneId()).toBe('hub')
    expect(r.getSnapshot().flags).toEqual({ fresh: bool(true) })
    expect(r.getSnapshot().backgroundPath).toBe('hub.png')
  })

  it('位置指定（途中局面）も遅延ロードを通り、history は [snapshot] から始まる', async () => {
    const r = makeRenderer([HUB])
    internals(r).initialized = true
    r.setMissingSceneResolver(() => Promise.resolve([HUB, ROUTE]))
    await expect(r.startFrom({ sceneId: 'route', eventIndex: 1 })).resolves.toEqual({
      status: 'entered',
      sceneId: 'route',
    })
    expect(r.getSnapshot().eventIndex).toBe(1)
    expect(internals(r).history).toHaveLength(1)
  })
})

describe('loadEvents / loadScenes: 開始しない読み込み (#734 PR2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    new SaveManager().deleteQuickSave()
  })

  it('loadEvents はエントリ冒頭の演出（[待機]）を実行しない（setEvents との対比）', () => {
    const r = new NovelRenderer()
    r.loadEvents([wait(500), narration('after')])
    expect(internals(r).waitingForWait).toBe(false)
    expect(internals(r).history).toHaveLength(0)

    const r2 = new NovelRenderer()
    r2.setEvents([wait(500), narration('after')])
    expect(internals(r2).waitingForWait).toBe(true)
  })

  it('loadEvents の直後でも quickLoad は入口ガードに弾かれず復元できる (#620 の根治)', async () => {
    const r = new NovelRenderer()
    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    r.setJumpSceneIndex([scene('a', [wait(500), narration('a1')]), scene('b', [narration('b1')])])
    r.loadEvents([wait(500), narration('entry')])
    const save: SaveSlotData = {
      slot: -1,
      sceneId: 'b',
      eventIndex: 0,
      textIndex: 0,
      flags: {},
      backgroundPath: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      savedAt: new Date().toISOString(),
      sceneName: null,
    }
    new SaveManager().quickSave(save)
    await expect(r.quickLoad('auto')).resolves.toEqual({ status: 'entered', sceneId: 'b' })
    expect(r.getCurrentSceneId()).toBe('b')
  })

  it('loadEvents した文書が startFrom({}) の entry になる（loadScenes は scenes[0] が entry）', async () => {
    const r = new NovelRenderer()
    r.loadEvents([narration('entry-line')])
    await expect(r.startFrom({})).resolves.toEqual({ status: 'entered', sceneId: null })
    expect(r.getSnapshot().eventIndex).toBe(0)

    const r2 = new NovelRenderer()
    r2.loadScenes([HUB, ROUTE])
    await expect(r2.startFrom({})).resolves.toEqual({ status: 'entered', sceneId: 'hub' })
    expect(r2.getCurrentSceneId()).toBe('hub')
  })

  it('getQuickSaveFlags はクイックセーブの flags を返す（無ければ null）', () => {
    const r = new NovelRenderer()
    expect(r.getQuickSaveFlags()).toBeNull()
    new SaveManager().quickSave({
      slot: -1,
      sceneId: 'a',
      eventIndex: 0,
      textIndex: 0,
      flags: { m: bool(true) },
      backgroundPath: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      savedAt: new Date().toISOString(),
      sceneName: null,
    })
    expect(r.getQuickSaveFlags()).toEqual({ m: bool(true) })
  })
})
