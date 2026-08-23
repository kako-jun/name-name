/**
 * NovelRenderer.restoreSnapshot(snapshot) のテスト (#460)。
 *
 * fluid（`aspect_ratio: auto`）モードで向きカテゴリが変わり NovelPlayer が renderer を
 * 再マウントする際 (#442)、旧 renderer の `getSnapshot()` をそのまま新 renderer へ渡して
 * 読み進め位置を引き継ぐための API。実装は restoreToScene 共通コア (#256) への薄いラッパーで、
 * loadFromSaveData と同じ「sceneId でシーンを探し、見つかれば restoreToScene / 見つからなければ
 * flags だけ復元して warn」という骨格を共有する。
 *
 * fixture・アクセサは NovelRenderer.startFrom.test.ts / NovelRenderer.loadFromSaveData.test.ts と
 * 同じスタイルに揃える。PixiJS 実描画・音声・アセット読込を伴う状態（backgroundPath / characters /
 * currentBgmPath の非 null）は jsdom では検証できないため、これらは null/空に固定し、実機
 * golden path に委ねる（CLAUDE.md ルール7）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { NovelGameState } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'

// --- fixture helpers（startFrom.test.ts / loadFromSaveData.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function condition(flag: string, events: Event[]): Event {
  return { Condition: { flag, events } }
}

const boolFlag = (b: boolean): FlagValue => ({ Bool: b })

/**
 * ensureContext の jsdom 制約回避（NovelRenderer.seekAdvance.test.ts の muteAudio と同じパターン）。
 * restoreSnapshot は #460 セルフレビュー M1 修正で内部的に audioManager.ensureContext() を呼ぶが、
 * jsdom には AudioContext が無いため呼ぶと ReferenceError になる。この呼び出し自体を検証する
 * M1 専用テストを除き、ensureContext を no-op spy に差し替えて実 AudioContext 構築を避ける。
 */
function muteAudio(r: NovelRenderer): void {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  muteAudio(r)
  r.setScenes(scenes)
  return r
}

/**
 * 複数シーンを 1 本の Event[] に線形連結する（PlayerScreen.flattenDocumentEvents /
 * NovelRenderer.linearAndJumpIndex.test.ts と同形）。マルチMD構成の K 系テストで、
 * setScenes ではなく setEvents + setJumpSceneIndex の実運用に近い経路を再現するために使う。
 */
function flatten(scenes: EventScene[]): Event[] {
  const events: Event[] = []
  let first = true
  for (const s of scenes) {
    if (!first) events.push('SceneTransition')
    first = false
    events.push(...s.events)
  }
  return events
}

/** restoreSnapshot 検証用の内部アクセサ（startFrom.test.ts と同じ） */
interface RendererInternals {
  history: unknown[]
  justSelectedChoice: boolean
  initialized: boolean
  pendingMissingScenes: Set<string>
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * `init()` 完了後の状態を模す (#460 セルフレビュー should S1)。
 *
 * restoreSnapshot（延いては resolveMissingSceneAndRestore）は実運用では必ず
 * `renderer.init(container)` 完了後にのみ呼ばれる（NovelPlayer.tsx の
 * `renderer.init(...).then(() => renderer.restoreSnapshot(...))`）。jsdom には実 PixiJS
 * canvas が無く `init()` を最後まで実行できないため、K系/S系テストでは init() 完了相当の
 * 状態をこのフラグ操作で模す（`this.initialized` のデフォルト値 false のままだと
 * resolveMissingSceneAndRestore の S1 ガードが常に早期returnし、正常系の解決すら
 * テストできなくなってしまう）。
 */
function markInitialized(r: NovelRenderer): void {
  internals(r).initialized = true
}

/**
 * jsdom セーフな NovelGameState スナップショットを作る（NovelPlayer.getSnapshot() の
 * 既定形＝NovelPlayer.test.tsx の MockRenderer.getSnapshot() 既定値と同じ形）。
 * アセット読込を伴うフィールドはデフォルトで null/空。over で上書きできる。
 */
function craftSnapshot(over: Partial<NovelGameState>): NovelGameState {
  return {
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    sentenceIndex: 0,
    flags: {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    storyEnded: false,
    ...over,
  }
}

const SCENES: EventScene[] = [
  // 2つ目の narration は adv（既定）で 2 行にしておく (#663)。restoreSnapshot は復元直後に
  // textIndex を「そのイベントの再計算後のページ数」にクランプするようになったため、1 行しか
  // 無いテキストへ textIndex: 1 を渡すテスト（R1/R10）は無条件に 0 へ丸められてしまう。
  scene('a', [narration('a1', 'a2', 'a3'), narration('a4', 'a5')]),
  scene('b', [narration('b1')]),
]

// flag 依存 Condition を含むシーン（resolvedEvents が flag で伸縮する）
const SCENES_COND: EventScene[] = [
  scene('cond', [
    narration('共通1'),
    condition('seen', [narration('分岐1'), narration('分岐2')]),
    narration('共通2'),
  ]),
]

describe('NovelRenderer.restoreSnapshot (#460)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ===== A. 正常系 =====

  it('R1: 有効な sceneId のスナップショットを渡すと getSnapshot() が渡した値と一致する', () => {
    const r = makeRenderer(SCENES)
    const snapshot = craftSnapshot({
      sceneId: 'a',
      eventIndex: 1,
      textIndex: 1,
      flags: { seen: boolFlag(true) },
    })
    r.restoreSnapshot(snapshot)
    const s = r.getSnapshot()
    expect(s.sceneId).toBe('a')
    expect(s.eventIndex).toBe(1)
    expect(s.textIndex).toBe(1)
    expect(s.flags).toEqual({ seen: boolFlag(true) })
  })

  it('R2: Condition 入りシーン + flags を渡すと resolveEvents 展開後の eventCount が正しい', () => {
    const r = makeRenderer(SCENES_COND)
    r.restoreSnapshot(craftSnapshot({ sceneId: 'cond', flags: { seen: boolFlag(true) } }))
    // 共通1 + (分岐1 + 分岐2) + 共通2 = 4 件
    expect(r.getDebugState().eventCount).toBe(4)
  })

  // ===== B. 状態遷移 =====

  it('R3: 復元後 history が現在位置 1 件にリセットされる', async () => {
    const r = makeRenderer(SCENES)
    await r.playScript([{ type: 'advance' }, { type: 'advance' }, { type: 'advance' }])
    expect(internals(r).history.length).toBeGreaterThan(1)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'b' }))
    expect(internals(r).history.length).toBe(1)
    expect(internals(r).history[0]).toEqual(r.getSnapshot())
  })

  it('R4: 復元後 justSelectedChoice が false にリセットされる', () => {
    const r = makeRenderer(SCENES)
    // 直前が choice 確定直後の状態を人為的に作る
    internals(r).justSelectedChoice = true
    r.restoreSnapshot(craftSnapshot({ sceneId: 'a' }))
    expect(internals(r).justSelectedChoice).toBe(false)
  })

  it('R5: 別シーンを開いた状態から restoreSnapshot で指定シーンへ遷移する', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'b' })
    expect(r.getCurrentSceneId()).toBe('b')

    r.restoreSnapshot(craftSnapshot({ sceneId: 'a', eventIndex: 1 }))
    expect(r.getCurrentSceneId()).toBe('a')
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  // ===== C. 異常系: sceneId null（restoreToScene を通さない分岐） =====

  it('R6: sceneId: null → fromJSON(flags) のみ実行され currentSceneId/history は不変、console.warn は呼ばれない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a', flags: { old: boolFlag(true) } })
    const sceneBefore = r.getCurrentSceneId()
    const historyLenBefore = internals(r).history.length

    r.restoreSnapshot(craftSnapshot({ sceneId: null, flags: { fresh: boolFlag(true) } }))

    expect(r.getSnapshot().flags).toEqual({ fresh: boolFlag(true) })
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(internals(r).history.length).toBe(historyLenBefore)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ===== D. 異常系: シーン未発見（フラグだけ復元 + warn） =====

  it('R7: 存在しない sceneId → flags のみ復元され console.warn が1回呼ばれる。currentSceneId/history は不変', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const sceneBefore = r.getCurrentSceneId()
    const historyLenBefore = internals(r).history.length

    r.restoreSnapshot(craftSnapshot({ sceneId: 'ghost', flags: { restored: boolFlag(true) } }))

    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(internals(r).history.length).toBe(historyLenBefore)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  // ===== E. 境界値 =====

  it('R8: flags: {}（空）でも例外を投げない', () => {
    const r = makeRenderer(SCENES)
    expect(() => r.restoreSnapshot(craftSnapshot({ sceneId: 'a', flags: {} }))).not.toThrow()
  })

  it('R12: sceneId: ""（空文字）は null と同じ分岐に落ちる（warn は呼ばれず、シーン未発見扱いにもならない）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const sceneBefore = r.getCurrentSceneId()

    r.restoreSnapshot(craftSnapshot({ sceneId: '', flags: { f: boolFlag(true) } }))

    expect(r.getSnapshot().flags).toEqual({ f: boolFlag(true) })
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ===== F. ログ =====

  it('R9: 正常系（R1相当）で console.warn/console.error が一切呼ばれない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = makeRenderer(SCENES)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'a', eventIndex: 1, flags: { ok: boolFlag(true) } }))

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // ===== G. 決定論 =====

  it('R10: 同一 snapshot を同一 allScenes の2つの renderer にそれぞれ restoreSnapshot すると getSnapshot() の結果が一致する', () => {
    const snapshot = craftSnapshot({
      sceneId: 'a',
      eventIndex: 1,
      textIndex: 1,
      flags: { x: boolFlag(true) },
    })
    const r1 = makeRenderer(SCENES)
    r1.restoreSnapshot(snapshot)
    const r2 = makeRenderer(SCENES)
    r2.restoreSnapshot(snapshot)
    expect(r2.getSnapshot()).toEqual(r1.getSnapshot())
  })

  // ===== H. 過去の事故パターン =====

  it('R11: setScenes/setEvents 未実行（allScenes 空）の状態で restoreSnapshot を呼んでも例外を投げない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new NovelRenderer() // setScenes/setEvents を呼ばない
    muteAudio(r)
    expect(() => r.restoreSnapshot(craftSnapshot({ sceneId: 'a' }))).not.toThrow()
  })

  it('R13: destroy() 後に getSnapshot() を呼んでも例外を投げない', () => {
    const r = makeRenderer(SCENES)
    r.destroy()
    expect(() => r.getSnapshot()).not.toThrow()
  })

  // ===== I. セルフレビュー修正 (#460 must M1): AudioContext 初期化 =====
  //
  // restoreSnapshot は NovelPlayer のマウント effect（ユーザー操作を伴わない非同期コールバック）
  // から新規 renderer インスタンスに対して呼ばれるため、AudioManager.ensureContext() が一度も
  // 呼ばれておらず ctx が null のまま。この状態で BGM 復元（applyState 内 playBgm）を呼んでも
  // playBgm は ctx が無いと即 return し、BGM がサイレントに止まったまま復帰しない。
  // restoreSnapshot が ensureContext() を呼ぶことを検証する（実際に AudioContext が resume される
  // かどうかはブラウザの自動再生ポリシー依存のため、実機確認が別途必要）。
  it('M1: restoreSnapshot 呼び出し時に audioManager.ensureContext() が呼ばれる', () => {
    const r = makeRenderer(SCENES)
    // makeRenderer 内の muteAudio() が既に ensureContext を no-op spy に差し替え済み
    // （jsdom には AudioContext が無いため実装は呼べない）。ここではその spy の呼び出しを検証する。
    const ensureContextMock = vi.mocked(r.getAudioManager().ensureContext)
    ensureContextMock.mockClear()

    r.restoreSnapshot(craftSnapshot({ sceneId: 'a' }))

    expect(ensureContextMock).toHaveBeenCalled()
  })

  it('M1: sceneId が見つからない場合でも ensureContext() は呼ばれる（early return より前に呼ぶ設計）', () => {
    const r = makeRenderer(SCENES)
    const ensureContextMock = vi.mocked(r.getAudioManager().ensureContext)
    ensureContextMock.mockClear()

    r.restoreSnapshot(craftSnapshot({ sceneId: 'ghost' }))

    expect(ensureContextMock).toHaveBeenCalled()
  })

  // ===== J. セルフレビュー修正 (#460 must M2): storyEnded 重複 postMessage 防止 =====
  //
  // restoreSnapshot は新規 construct された renderer インスタンス（this.storyEnded は常に
  // デフォルト false）に対して呼ばれる。applyState 側に「storyEnded の値が変化した時だけ
  // onStoryEndedChangeCallback を発火する」ガードを入れても、素朴に this.storyEnded の初期値
  // false のまま比較すると「true で復元＝変化あり」と誤判定されるため、restoreSnapshot は
  // restoreToScene を呼ぶ前に this.storyEnded を復元先の値へ直接セットしておく（結果、
  // applyState 側の比較は常に「変化なし」になり、fluid 再マウントのたびに終劇 postMessage
  // （NovelPlayer 側）が重複送信されるのを防ぐ）。
  it('M2: storyEnded:true のスナップショットを新規 renderer に restoreSnapshot しても、onStoryEndedChangeCallback は発火しない', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'a', storyEnded: true }))

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(cb).not.toHaveBeenCalled()
  })

  it('M2: storyEnded:false のスナップショットを新規 renderer に restoreSnapshot してもコールバックは発火しない（デフォルト値のままなので変化なし）', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'a', storyEnded: false }))

    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(cb).not.toHaveBeenCalled()
  })

  // ===== K. マルチMD遅延ロード対応（#460 再発修正） =====
  //
  // Gymnasia のような hub(entry doc) + ルート別 md 構成では、fluid 再マウント直後の新 renderer の
  // allScenes には entry doc のシーンしか無く、ルート側の sceneId はまだ遅延ロードされていない。
  // jumpToScene → resolveMissingSceneAndJump（NovelRenderer.linearAndJumpIndex.test.ts の #314）と
  // 対になる、restoreSnapshot 版の missingSceneResolver 経由解決を検証する。

  it('K1: allScenes に無い sceneId でも missingSceneResolver 経由でロードされ復元できる（マルチMD再現）', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const routeScene = scene('r01-01', [narration('route-line-a', 'route-line-b')])
    const resolver = vi.fn(async () => [...entryScenes, routeScene])

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    // 新規 renderer 直後は allScenes に route-scene がまだ無い（マルチMD遅延ロード前の状態）
    expect(r.getAllSceneIds()).toEqual(['entry-hub'])

    r.restoreSnapshot(
      craftSnapshot({ sceneId: 'r01-01', eventIndex: 1, flags: { seen: boolFlag(true) } })
    )
    // resolveMissingSceneAndRestore は fire-and-forget（restoreSnapshot 自体は void）なので
    // resolver の Promise 解決をマイクロタスクとして待つ（#314 と同じ待ち方）。
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('r01-01')
    expect(r.getAllSceneIds()).toEqual(['entry-hub', 'r01-01'])
    expect(r.getCurrentSceneId()).toBe('r01-01')
    expect(r.getSnapshot().eventIndex).toBe(1)
    expect(r.getSnapshot().flags).toEqual({ seen: boolFlag(true) })
  })

  it('K2: missingSceneResolver が null を返す（解決失敗）→ flags のみ復元され console.warn が呼ばれる', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => null)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    r.startFrom({ sceneId: 'entry-hub' })
    const sceneBefore = r.getCurrentSceneId()

    r.restoreSnapshot(
      craftSnapshot({ sceneId: 'ghost-route', flags: { restored: boolFlag(true) } })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('ghost-route')
    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('K3: resolver がシーンを返すが目的の sceneId が含まれない → flags のみ復元され warn される', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const otherScene = scene('other-route', [narration('other-line')])
    // 'target-route' を含まない解決結果（別ファイルを誤って返す/typo 等の想定）
    const resolver = vi.fn(async () => [...entryScenes, otherScene])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'target-route', flags: { x: boolFlag(true) } }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(r.getSnapshot().flags).toEqual({ x: boolFlag(true) })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('K4: resolver が例外を投げる → flags のみ復元され warn される（例外を外に漏らさない）', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => {
      throw new Error('network error')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    expect(() =>
      r.restoreSnapshot(craftSnapshot({ sceneId: 'target-route', flags: { y: boolFlag(true) } }))
    ).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(r.getSnapshot().flags).toEqual({ y: boolFlag(true) })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('K5: 遅延解決経由の復元でも M2 と同様 storyEnded の重複コールバックは発火しない', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const routeScene = scene('r01-01', [narration('route-line')])
    const resolver = vi.fn(async () => [...entryScenes, routeScene])
    const cb = vi.fn()

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    r.setOnStoryEndedChange(cb)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'r01-01', storyEnded: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(cb).not.toHaveBeenCalled()
  })

  it('K6: 同一 sceneId への restoreSnapshot 二重呼び出しでも resolver は重複起動しない（pendingMissingScenes 共有ガード）', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const routeScene = scene('r01-01', [narration('route-line')])
    const resolver = vi.fn(async () => [...entryScenes, routeScene])

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.restoreSnapshot(craftSnapshot({ sceneId: 'r01-01' }))
    r.restoreSnapshot(craftSnapshot({ sceneId: 'r01-01' })) // 同一tick内の二重呼び出し
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(r.getCurrentSceneId()).toBe('r01-01')
  })

  // ===== L. セルフレビュー修正 (#460 should S1/S2): 連続remount中の非同期解決 =====
  //
  // K1-K6 はいずれも単発remount→単発非同期解決のみを検証しており、「非同期解決が完了する前に
  // さらに次のremount（destroy）が来る」ケースが未検証だった。

  it('S1: missingSceneResolver の解決待ち中に destroy() されても、resolve 後に例外を投げず復元処理も実行されない', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const routeScene = scene('r01-01', [narration('route-line')])
    let resolveScenes: ((scenes: EventScene[]) => void) | undefined
    const resolver = vi.fn(
      () =>
        new Promise<EventScene[]>((resolve) => {
          resolveScenes = resolve
        })
    )

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.restoreSnapshot(
      craftSnapshot({ sceneId: 'r01-01', eventIndex: 1, flags: { seen: boolFlag(true) } })
    )
    expect(resolver).toHaveBeenCalledWith('r01-01')

    // 連続remount想定: resolver がまだ解決していない間に、この renderer 自身が destroy() される。
    // R13 と同じ理由（jsdom には実 PixiJS canvas が無く init() を最後まで実行できない）で、この
    // テスト環境では appInitialized が立っておらず destroy() 自体は早期returnの安全な no-op になる
    // （React StrictMode の unmount-before-init 対応と同じ経路）。そのため、実機で appInitialized
    // 済みの場合に destroy() が行う「initialized = false」をここでは直接模して、S1 ガードの分岐を
    // 実際に踏ませる。
    expect(() => r.destroy()).not.toThrow()
    internals(r).initialized = false

    // destroy 後に resolver が解決しても例外を投げない（S1 ガードが無いと applyState 等が
    // 破棄済みの this.app.stage を触り得る）
    expect(() => {
      resolveScenes?.([...entryScenes, routeScene])
    }).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // S1 ガードにより setJumpSceneIndex/restoreToScene 相当の処理が一切実行されない
    // → allScenes に route scene が追加されず、currentSceneId も未設定のまま
    expect(r.getAllSceneIds()).toEqual(['entry-hub'])
    expect(r.getCurrentSceneId()).toBeNull()
  })

  it('S2: pendingMissingScenes に既に同一 sceneId が入っている状態で restoreSnapshot を呼ぶと、resolver は起動されず flags だけが渡した値に更新される', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => entryScenes)

    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    r.startFrom({ sceneId: 'entry-hub' })
    const sceneBefore = r.getCurrentSceneId()

    // jumpToScene 側の resolveMissingSceneAndJump が同一 sceneId を既に解決中、という状況を再現
    // （#460 セルフレビュー S2: この分岐にヒットするケースだけ flags すら復元されていなかった）
    internals(r).pendingMissingScenes.add('r01-01')

    r.restoreSnapshot(craftSnapshot({ sceneId: 'r01-01', flags: { restored: boolFlag(true) } }))

    // このガードは await を経ないため、fromJSON(flags) は同期的に完了している
    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
    // restoreToScene は呼ばれていない（currentSceneId は変化しない）
    expect(r.getCurrentSceneId()).toBe(sceneBefore)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolver).not.toHaveBeenCalled()
  })

  // ===== M. #663 fluid remount textIndex クランプ =====
  //
  // fluid（`aspect_ratio: auto`）で画面幅が向きカテゴリを跨ぐと NovelPlayer は新しい
  // gameWidth/gameHeight で NovelRenderer を作り直し、旧 renderer の getSnapshot() を
  // restoreSnapshot() でそのまま渡す (#442)。novel かつ sentence_per_page:false（既定）は
  // ページ折り返しがテキスト領域の高さに依存するため、新レイアウトでは同じイベントでも
  // ページ数が変わり得る。applyState() は #663 で「復元直後の textIndex を現イベントの
  // 再計算後ページ数へクランプする」防御を追加した。ここではその境界値と、fluid remount の
  // 実バグ経路そのもの（novel で2 renderer 間の aspectRatio 差し替え）を検証する。

  // B系: adv（既定・sentence_per_page:false）はページ数が textEvt.text.length に固定される
  // （幅非依存）ため、renderer を作り直さず単一 renderer への restoreSnapshot だけで
  // クランプの境界値（`>=` 取り違え検出）を検証できる。eventIndex:0 にダミーイベントを
  // 挟み、eventIndex:1 の3行 adv イベントを対象にすることで「クランプは textIndex だけに
  // 作用し eventIndex は無変更」も同時に確認する。
  const B_SCENES: EventScene[] = [scene('clamp', [narration('pre'), narration('l1', 'l2', 'l3')])]

  it('T-B1: textIndex===pageCount-1（境界内）はクランプされず値を保持する', () => {
    const r = makeRenderer(B_SCENES)
    r.restoreSnapshot(craftSnapshot({ sceneId: 'clamp', eventIndex: 1, textIndex: 2 }))
    const s = r.getSnapshot()
    expect(s.textIndex).toBe(2)
    expect(s.eventIndex).toBe(1)
  })

  it('T-B2: textIndex===pageCount（境界）は pageCount-1 にクランプされる（`>=`取り違え検出の本丸）', () => {
    const r = makeRenderer(B_SCENES)
    r.restoreSnapshot(craftSnapshot({ sceneId: 'clamp', eventIndex: 1, textIndex: 3 }))
    const s = r.getSnapshot()
    expect(s.textIndex).toBe(2)
    // クランプは textIndex だけに作用する（eventIndex は無変更・#461 との独立性）
    expect(s.eventIndex).toBe(1)
  })

  it('T-B3: textIndex===pageCount+1（境界外）も同じく pageCount-1 にクランプされる', () => {
    const r = makeRenderer(B_SCENES)
    r.restoreSnapshot(craftSnapshot({ sceneId: 'clamp', eventIndex: 1, textIndex: 4 }))
    expect(r.getSnapshot().textIndex).toBe(2)
  })

  // F系: novel（sentence_per_page:false）は改頁がテキスト領域の高さに依存する。#663 の実バグ
  // 経路（fluid remount で新 renderer インスタンスが作られる）を、aspectRatio が異なる
  // 2つの renderer 間の restoreSnapshot で再現する（NovelRenderer.novel.test.ts の
  // measureNovelCap() パターンを流用）。16:9（横長・テキスト領域が低い→cap 小）と
  // 9:16（縦長・テキスト領域が高い→cap 大）の組み合わせで、同じ文数でもページ数が変わる
  // ことを利用する。
  function capFor(aspectRatio: '16:9' | '9:16'): number {
    const probe = new NovelRenderer({ aspectRatio })
    probe.setDialogStyle('novel')
    return (
      probe as unknown as { dialogBox: { novelMaxLinesPerPage(): number } }
    ).dialogBox.novelMaxLinesPerPage()
  }
  const CAP_16_9 = capFor('16:9')
  const CAP_9_16 = capFor('9:16')
  // 16:9 の cap ちょうど3ページになる文数（NovelRenderer.novel.test.ts の
  // sentencesForThreePages と同じ式）。9:16 はテキスト領域が縦に広く cap が大きいため、
  // 同じ文数がより少ないページ数に収まる（各テストの前提を明示的に assert する）。
  const FLUID_N = CAP_16_9 * 2 + 1
  const FLUID_TEXT = Array.from({ length: FLUID_N }, (_, k) => `${k + 1}。`).join('')
  const FLUID_SCENES: EventScene[] = [scene('fluid', [narration(FLUID_TEXT)])]
  const oldPageCountNarrow = Math.ceil(FLUID_N / CAP_16_9) // 16:9 での改頁数（3 になるよう構成）
  const newPageCountWide = Math.ceil(FLUID_N / CAP_9_16) // 9:16 での改頁数（cap 増でページ減）

  it('T-F2: novel×fluid remount(16:9→9:16、ページ数減少)で旧textIndexが新pageCount以上になりクランプされる（#663実バグ経路の直接再現）', () => {
    // 前提: 9:16 は cap が大きく、同じ文数でもページ数が減る（本テスト成立条件）
    expect(newPageCountWide).toBeLessThan(oldPageCountNarrow)

    const oldTextIndex = oldPageCountNarrow - 1 // 旧レイアウト（16:9）での最終ページ
    const oldR = new NovelRenderer({ aspectRatio: '16:9' })
    muteAudio(oldR)
    oldR.setDialogStyle('novel')
    oldR.setScenes(FLUID_SCENES)
    oldR.restoreSnapshot(
      craftSnapshot({ sceneId: 'fluid', eventIndex: 0, textIndex: oldTextIndex })
    )
    const oldSnapshot = oldR.getSnapshot()
    expect(oldSnapshot.textIndex).toBe(oldTextIndex) // 旧レイアウトでは境界内（no-op）

    // fluid remount: 新しい aspectRatio の renderer インスタンスへ旧 snapshot をそのまま渡す
    const newR = new NovelRenderer({ aspectRatio: '9:16' })
    muteAudio(newR)
    newR.setDialogStyle('novel')
    newR.setScenes(FLUID_SCENES)
    newR.restoreSnapshot(oldSnapshot)

    expect(newR.getSnapshot().textIndex).toBe(newPageCountWide - 1)
  })

  it('T-F1: novel×fluid remount(9:16→16:9、ページ数増加)は旧textIndexが新pageCount未満のままクランプされない（T-F2との対）', () => {
    expect(newPageCountWide).toBeLessThan(oldPageCountNarrow)

    const oldTextIndex = newPageCountWide - 1 // 9:16（少ないページ数）での最終ページ
    const oldR = new NovelRenderer({ aspectRatio: '9:16' })
    muteAudio(oldR)
    oldR.setDialogStyle('novel')
    oldR.setScenes(FLUID_SCENES)
    oldR.restoreSnapshot(
      craftSnapshot({ sceneId: 'fluid', eventIndex: 0, textIndex: oldTextIndex })
    )
    const oldSnapshot = oldR.getSnapshot()
    expect(oldSnapshot.textIndex).toBe(oldTextIndex)

    const newR = new NovelRenderer({ aspectRatio: '16:9' })
    muteAudio(newR)
    newR.setDialogStyle('novel')
    newR.setScenes(FLUID_SCENES)
    newR.restoreSnapshot(oldSnapshot)

    // 新レイアウト(16:9)はページ数が増える方向なので旧 textIndex はそのまま有効範囲内 → no-op
    expect(newR.getSnapshot().textIndex).toBe(oldTextIndex)
  })

  // ===== N. #663 クランプの外側ガード（非適用ケースの回帰）=====

  it('T-Z1: pageCount===0（adv・text:[]）はクランプをスキップし例外を投げない', () => {
    const r = makeRenderer([scene('z1', [narration()])]) // text: [] の adv イベント
    expect(() =>
      r.restoreSnapshot(craftSnapshot({ sceneId: 'z1', eventIndex: 0, textIndex: 0 }))
    ).not.toThrow()
    expect(r.getSnapshot().textIndex).toBe(0)
  })

  it('T-Z2: 非テキストイベント（BackgroundColor）は外側ガードにより textIndex が無変更', () => {
    const r = makeRenderer([
      scene('z2', [narration('l1'), { BackgroundColor: { color: '#000000' } }]),
    ])
    r.restoreSnapshot(craftSnapshot({ sceneId: 'z2', eventIndex: 1, textIndex: 5 }))
    expect(r.getSnapshot().textIndex).toBe(5)
  })

  it('T-Z3: eventIndex が resolvedEvents.length 以上でも例外を投げず textIndex は無変更', () => {
    const r = makeRenderer([scene('z3', [narration('only')])])
    expect(() =>
      r.restoreSnapshot(craftSnapshot({ sceneId: 'z3', eventIndex: 99, textIndex: 5 }))
    ).not.toThrow()
    expect(r.getSnapshot().textIndex).toBe(5)
  })

  it('T-L1: クランプ発火（T-F2と同じ fluid remount 経路）でも console.warn/console.error は呼ばれない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const oldR = new NovelRenderer({ aspectRatio: '16:9' })
    muteAudio(oldR)
    oldR.setDialogStyle('novel')
    oldR.setScenes(FLUID_SCENES)
    oldR.restoreSnapshot(
      craftSnapshot({ sceneId: 'fluid', eventIndex: 0, textIndex: oldPageCountNarrow - 1 })
    )
    const newR = new NovelRenderer({ aspectRatio: '9:16' })
    muteAudio(newR)
    newR.setDialogStyle('novel')
    newR.setScenes(FLUID_SCENES)
    newR.restoreSnapshot(oldR.getSnapshot())

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
