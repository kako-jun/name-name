/**
 * 新規開始 `startFrom` の持ち越しなし・DEV 警告の条件・遅延ロードの失敗系・後勝ち (#734 PR2, ADR 0003 §2・§3・§8)。
 *
 * `carryPolicyFor` の表の全項目（背景・地色・背景板・大道具・幕・紙人形輪郭・立ち絵・BGM・スポットライト・
 * カメラ）を「進行（jumpToScene）は持ち越す／新規開始は持ち越さない」の対で検証する。
 * 基本の契約は NovelRenderer.freshStart.test.ts が、状態の引き継ぎは同ファイルの対比テストが持つ。
 * 実描画（WebGL）は jsdom 対象外（CLAUDE.md ルール7 の実機 golden path に委ねる）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { Event, EventScene, FlagValue } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}
const bool = (b: boolean): FlagValue => ({ Bool: b })

/** 持ち越し候補を一通り積む前シーン。 */
function loadedScene(id: string): EventScene {
  return scene(id, [
    { Background: { path: 'bg.png' } },
    { BackgroundColor: { color: '#112233' } } as Event,
    { BackgroundBoard: { path: 'board.png', depth: 3 } } as Event,
    { Prop: { path: 'prop.png', depth: 2 } } as Event,
    { Curtain: { path: 'curtain.png', characters_in_front: false } } as Event,
    { PaperDollOutline: { enabled: true, color: '#abcdef', thickness: 3 } } as Event,
    { Spotlight: { target: 'せお', color: '#ffffff', radius: 0.3 } } as Event,
    {
      CameraMode: { mode: 'Theater', orientation: undefined, elevation: undefined },
    } as Event,
    { Bgm: { path: 'bgm.mp3', action: 'Play' } },
    {
      Enter: { character: 'せお', expression: 'theo/normal', position: '左' },
    } as Event,
    narration('loaded'),
  ])
}
const BARE = scene('bare', [narration('bare')])

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  r.setScenes(scenes)
  return r
}

interface Internals {
  initialized: boolean
  pendingEntry: unknown
  currentBackgroundColor: string | null
  consecutiveJumps: number
  confinedSceneIds: string[] | null
}
const internals = (r: NovelRenderer): Internals => r as unknown as Internals

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function craftSave(over: Partial<SaveSlotData>): SaveSlotData {
  return {
    slot: -1,
    sceneId: 'bare',
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: new Date().toISOString(),
    sceneName: null,
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  new SaveManager().deleteQuickSave()
})

describe('startFrom: carryPolicyFor の表の全項目（進行は持ち越し・新規開始は持ち越さない）', () => {
  it('前提: 前シーンが全項目を積んでいる', async () => {
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded' })
    const s = r.getSnapshot()
    expect(s.backgroundPath).toBe('bg.png')
    expect(s.backgroundColor).toBe('#112233')
    expect(s.backgroundBoards).toEqual([{ path: 'board.png', depth: 3 }])
    expect(s.props).toEqual([{ path: 'prop.png', depth: 2 }])
    expect(s.curtain).not.toBeNull()
    expect(s.paperDollOutline).toEqual({ color: '#abcdef', thickness: 3 })
    expect(s.currentBgmPath).toBe('bgm.mp3')
    expect(s.characters).toHaveLength(1)
    expect(s.spotlight).not.toBeNull()
    expect(s.cameraMode).toBe('Theater')
  })

  it('新規開始: 背景・背景板・大道具・幕・紙人形輪郭・立ち絵・BGM・スポットライト・カメラをすべて持ち越さない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded' })
    await r.startFrom({ sceneId: 'bare' })

    const s = r.getSnapshot()
    expect(s.sceneId).toBe('bare')
    expect(s.backgroundPath).toBeNull()
    expect(s.backgroundBoards).toEqual([])
    expect(s.props).toEqual([])
    expect(s.curtain).toBeNull()
    expect(s.paperDollOutline).toBeNull()
    expect(s.characters).toEqual([])
    expect(s.currentBgmPath).toBeNull()
    expect(s.spotlight).toBeNull()
    expect(s.cameraMode).toBe('Novel')
    expect(s.isBlackout).toBe(false)
    expect(s.eventImage).toBeNull()
    expect(s.video).toBeNull()
  })

  // 現状の固定（バグ候補として報告）: `[背景色:]`（#273）の地色は独立スロットで、新規開始でもクリアされない
  // （resetAndStartEvents の非 preserve 分岐が clearBackgroundColor を呼ばない。main の setEvents / restart も同じ）。
  // spec 446 行の「文脈を捨てる」一覧に地色は無く、spec 270 行は「明示的に塗り直すまで残る」とある。
  // 新規開始で地色も捨てる設計にするなら、この期待を null に反転する。
  it('現状: 地色（[背景色:]）は新規開始でも残る（spec の「文脈を捨てる」一覧に無い）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded' })
    expect(internals(r).currentBackgroundColor).toBe('#112233')
    await r.startFrom({ sceneId: 'bare' })
    expect(r.getSnapshot().backgroundColor).toBe('#112233')
  })

  it('対比: 進行（jumpToScene）は背景・地色・背景板・大道具・幕・紙人形輪郭・BGM を持ち越し、スポットライトとカメラは持ち越さない', async () => {
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded' })
    await r.jumpToScene('bare')

    const s = r.getSnapshot()
    expect(s.sceneId).toBe('bare')
    expect(s.backgroundPath).toBe('bg.png')
    expect(s.backgroundBoards).toEqual([{ path: 'board.png', depth: 3 }])
    expect(s.props).toEqual([{ path: 'prop.png', depth: 2 }])
    expect(s.curtain).not.toBeNull()
    expect(s.paperDollOutline).toEqual({ color: '#abcdef', thickness: 3 })
    expect(s.currentBgmPath).toBe('bgm.mp3')
    // スポットライト・カメラは進行でも既定へ戻る
    expect(s.spotlight).toBeNull()
    expect(s.cameraMode).toBe('Novel')
  })

  it('新規開始は flags も持ち越さない（省略時は空、指定すれば置換）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded', flags: { a: bool(true) } })
    await r.startFrom({ sceneId: 'bare' })
    expect(r.getSnapshot().flags).toEqual({})
  })

  it('新規開始: 終劇中でも、持ち越しなしで開始し直せる（storyEnded が解除され、最小の原稿でも状態が揃う）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded', confinedSceneIds: ['loaded'] })
    await r.jumpToScene('bare') // 圏外 → 終劇
    expect(r.getSnapshot().storyEnded).toBe(true)

    await r.startFrom({ sceneId: 'bare' })
    const s = r.getSnapshot()
    expect(s.storyEnded).toBe(false)
    expect(s.backgroundPath).toBeNull()
    expect(internals(r).confinedSceneIds).toBeNull()
  })
})

describe('startFrom: DEV 警告の出る・出ない条件 (ADR 0003 §8)', () => {
  it('テキストより前に [条件:] があるシーンでは出さない（条件の中の [背景:] を断定できない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cond = scene('cond', [
      { Condition: { flag: 'f', events: [{ Background: { path: 'x.png' } }] } } as Event,
      narration('t'),
    ])
    const r = makeRenderer([cond])
    await r.startFrom({ sceneId: 'cond' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('テキストの無い原稿では出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const silent = scene('silent', [{ Bgm: { path: 'a.mp3', action: 'Play' } }])
    const r = makeRenderer([silent])
    await r.startFrom({ sceneId: 'silent' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('[背景:] より前にテキストがあるシーンでは出す（Dialog でも同じ）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const late = scene('late', [
      narration('先に本文'),
      { Background: { path: 'late.png' } } as Event,
    ])
    const r = makeRenderer([late])
    await r.startFrom({ sceneId: 'late' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('エントリ（sceneId 省略）の新規開始でも、冒頭に [背景:] が無ければ出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.loadEvents([narration('entry-line')])
    await r.startFrom({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('エントリ')
  })

  it('進行（jumpToScene）では出さない（持ち越すので背景が無くても問題ない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded'), BARE])
    await r.startFrom({ sceneId: 'loaded' })
    await r.jumpToScene('bare')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('startFrom: 遅延ロード（失敗系）', () => {
  it('resolver が reject → resolver-error で失敗し、状態を一切変えない（flags・confinement・位置）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded')])
    internals(r).initialized = true
    await r.startFrom({
      sceneId: 'loaded',
      flags: { keep: bool(true) },
      confinedSceneIds: ['loaded'],
    })
    const before = r.getSnapshot()
    r.setMissingSceneResolver(() => Promise.reject(new Error('network')))

    await expect(
      r.startFrom({ sceneId: 'ghost', flags: { wiped: bool(true) }, confinedSceneIds: null })
    ).resolves.toEqual({ status: 'failed', reason: 'resolver-error' })

    expect(r.getSnapshot()).toEqual(before)
    expect(internals(r).confinedSceneIds).toEqual(['loaded'])
    expect(internals(r).pendingEntry).toBeNull()
  })

  it('resolver が同期 throw しても resolver-error として失敗する（Promise は reject しない）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([BARE])
    internals(r).initialized = true
    r.setMissingSceneResolver(() => {
      throw new Error('sync boom')
    })
    await expect(r.startFrom({ sceneId: 'ghost' })).resolves.toEqual({
      status: 'failed',
      reason: 'resolver-error',
    })
  })

  it('ロード後も対象シーンが不在（別のシーンしか返らない）なら not-found で失敗し、状態を変えない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([loadedScene('loaded')])
    internals(r).initialized = true
    await r.startFrom({ sceneId: 'loaded', flags: { keep: bool(true) } })
    const before = r.getSnapshot()
    r.setMissingSceneResolver(() => Promise.resolve([scene('other', [narration('o')])]))

    await expect(
      r.startFrom({ sceneId: 'ghost', flags: { wiped: bool(true) }, confinedSceneIds: ['x'] })
    ).resolves.toEqual({ status: 'failed', reason: 'not-found' })

    expect(r.getSnapshot()).toEqual(before)
    expect(internals(r).confinedSceneIds).toBeNull()
  })

  it('失敗後は入場中ゲートが下りる（pendingEntry が null に戻り、以後の進行を受け付ける）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([BARE, scene('next', [narration('n')])])
    internals(r).initialized = true
    const d = deferred<EventScene[] | null>()
    r.setMissingSceneResolver(() => d.promise)
    const p = r.startFrom({ sceneId: 'ghost' })
    expect(internals(r).pendingEntry).not.toBeNull()
    d.reject(new Error('x'))
    await p
    expect(internals(r).pendingEntry).toBeNull()
    await expect(r.jumpToScene('next')).resolves.toEqual({ status: 'entered', sceneId: 'next' })
  })

  it('未ロードのシーンへの新規開始の待機中は confinement も flags もまだ置き換わらず、確定は解決後（適用の直前）', async () => {
    const r = makeRenderer([BARE])
    internals(r).initialized = true
    const d = deferred<EventScene[] | null>()
    r.setMissingSceneResolver(() => d.promise)
    const p = r.startFrom({
      sceneId: 'route',
      flags: { f: bool(true) },
      confinedSceneIds: ['route'],
    })
    expect(internals(r).confinedSceneIds).toBeNull()
    expect(r.getSnapshot().flags).toEqual({})
    d.resolve([BARE, scene('route', [narration('r')])])
    await p
    expect(internals(r).confinedSceneIds).toEqual(['route'])
    expect(r.getSnapshot().flags).toEqual({ f: bool(true) })
  })
})

describe('startFrom: 後勝ち（遅延ロード中に別の入場が来る）', () => {
  function lazyRenderer() {
    const r = makeRenderer([BARE, scene('next', [narration('n')])])
    internals(r).initialized = true
    const d = deferred<EventScene[] | null>()
    r.setMissingSceneResolver(() => d.promise)
    return { r, d }
  }
  const ROUTE = scene('route', [narration('route')])

  it('startFrom vs 進行: 待っている新規開始は superseded。flags・confinement は適用されず、進行が勝つ', async () => {
    const { r, d } = lazyRenderer()
    const first = r.startFrom({
      sceneId: 'route',
      flags: { f: bool(true) },
      confinedSceneIds: ['route'],
    })
    // 進行（読み込み済みの next）は同期で適用され、世代を進めて先に確定する。
    const jumped = r.jumpToScene('next')
    await expect(jumped).resolves.toEqual({ status: 'entered', sceneId: 'next' })
    d.resolve([BARE, ROUTE])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('next')
    expect(r.getSnapshot().flags).toEqual({})
    expect(internals(r).confinedSceneIds).toBeNull()
  })

  it('startFrom vs 復元: 待っている新規開始は superseded。復元の結果が残る', async () => {
    const { r, d } = lazyRenderer()
    const first = r.startFrom({ sceneId: 'route', confinedSceneIds: ['route'] })
    await expect(
      r.restoreSnapshot({ ...r.getSnapshot(), sceneId: 'next', flags: { s: bool(true) } })
    ).resolves.toEqual({ status: 'entered', sceneId: 'next' })
    d.resolve([BARE, ROUTE])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('next')
    expect(r.getSnapshot().flags).toEqual({ s: bool(true) })
    expect(internals(r).confinedSceneIds).toBeNull()
  })

  it('startFrom vs 別の startFrom: 先に来た待機中の新規開始は superseded、後の startFrom だけが適用される', async () => {
    const { r, d } = lazyRenderer()
    const first = r.startFrom({
      sceneId: 'route',
      flags: { a: bool(true) },
      confinedSceneIds: ['route'],
    })
    const second = r.startFrom({ sceneId: 'next', flags: { b: bool(true) } })
    await expect(second).resolves.toEqual({ status: 'entered', sceneId: 'next' })
    d.resolve([BARE, ROUTE])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('next')
    expect(r.getSnapshot().flags).toEqual({ b: bool(true) })
    expect(internals(r).confinedSceneIds).toBeNull()
    expect(internals(r).pendingEntry).toBeNull()
  })

  it('startFrom 待機中のクイックロードは入場中ゲートで弾かれ（null）、待機中の新規開始は影響を受けず入場する', async () => {
    const { r, d } = lazyRenderer()
    new SaveManager().quickSave(craftSave({ sceneId: 'next', flags: { q: bool(true) } }))
    const first = r.startFrom({ sceneId: 'route', flags: { a: bool(true) } })
    await expect(r.quickLoad('quick')).resolves.toBeNull()
    d.resolve([BARE, ROUTE])
    await expect(first).resolves.toEqual({ status: 'entered', sceneId: 'route' })
    expect(r.getSnapshot().flags).toEqual({ a: bool(true) })
  })

  it('新規開始の待機中は入場中ゲートが立ち、クイックセーブを受け付けない（解決後に下りる）', async () => {
    const { r, d } = lazyRenderer()
    const p = r.startFrom({ sceneId: 'route' })
    expect(internals(r).pendingEntry).not.toBeNull()
    expect(r.quickSave()).toBe(false)
    d.resolve([BARE, ROUTE])
    await p
    expect(internals(r).pendingEntry).toBeNull()
  })

  it('destroy 後に解決した新規開始は何も適用せず superseded（flags・confinement を触らない）', async () => {
    const { r, d } = lazyRenderer()
    const p = r.startFrom({
      sceneId: 'route',
      flags: { f: bool(true) },
      confinedSceneIds: ['route'],
    })
    internals(r).initialized = false
    d.resolve([BARE, ROUTE])
    await expect(p).resolves.toEqual({ status: 'superseded' })
    expect(r.getSnapshot().flags).toEqual({})
    expect(internals(r).confinedSceneIds).toBeNull()
  })
})
