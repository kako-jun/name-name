/**
 * NovelRenderer の「線形再生」と「ジャンプ解決索引（jumpSceneIndex / setJumpSceneIndex）」
 * の単体テスト (#284)。
 *
 * 背景（退行と修正）:
 *   - M2 退行: PlayerScreen が scenes=（setScenes）に切り替えた結果、再生ストリームが
 *     scenes[0].events だけになり、多シーン作品が scene1 で停止していた。
 *   - 修正: 通常再生は events=（flattenDocumentEvents = 全シーンを 1 本に線形連結。
 *     シーン境界に 'SceneTransition' を挟む）で行い、advance() が scene1 → scene2 と
 *     自動進行する。クロスファイルのジャンプ解決は setJumpSceneIndex(allScenes) で
 *     別建てし、再生ストリームは置換しない。
 *
 * このファイルはその 2 点を renderer レベルで押さえる（PlayerScreen 全面モックでは観測不能）:
 *   1. 線形再生: setEvents(flatten) で scene1 の最終行 → advance で scene2 の本文に到達し、
 *      途中で onEnd しない（= scene1 で停止しない）。単一 script でも複数 script でも同じ。
 *   2. setJumpSceneIndex: 再生ストリームを変えずに allScenes を差し替え、jumpToScene が
 *      「再生ストリームに無い別 MD のシーン ID」をファイル横断で解決して到達する。
 *
 * startFrom.test.ts と同じく `new NovelRenderer()` の最小構成（init() なし）で行う。
 * PixiJS 実描画は対象外（CLAUDE.md ルール7 の実機 golden path に委ねる）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

// --- fixture helpers ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/**
 * 複数シーンを 1 本の Event[] に線形連結する（PlayerScreen.flattenDocumentEvents と同形）。
 * 2 つ目以降のシーンの前に 'SceneTransition' を挟む。
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

interface RendererInternals {
  eventIndex: number
  resolvedEvents: Event[]
  initialized: boolean
  pendingMissingScenes: Set<string>
  advance(): void
  characterLayer: {
    show(
      character: string,
      expression: string,
      position: string,
      assetBaseUrl: string,
      options?: { instant?: boolean }
    ): void
    characters: Map<
      string,
      {
        fadeAnimation: null | {
          toAlpha: number
          destroyOnComplete: boolean
        }
      }
    >
  }
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * `init()` 完了後の状態を模す (#460 セルフレビュー should S1 / #463 で resolveMissingSceneAndJump
 * にも同型ガードを追加した際の踏襲)。resolveMissingSceneAndJump は #463 で「resolver 解決後、
 * this.initialized が false なら即 return」というガードを持つため、resolver 経由の正常解決を
 * 検証するテストは実運用の `init()` 完了相当をこのフラグ操作で模す必要がある
 * （NovelRenderer.restoreSnapshot.test.ts の markInitialized と同じパターン）。
 */
function markInitialized(r: NovelRenderer): void {
  internals(r).initialized = true
}

describe('NovelRenderer 線形再生 (#284 M2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 注意: getDebugState().eventText は「現在イベントの text[0]」を返す（textIndex には
  // 追従しない）。シーン跨ぎ進行を観測したいので各シーンは 1 行 Narration にして、
  // 1 回の advance で必ず次の Narration イベント（= 次シーン）へ進むようにする。
  it('flatten した複数シーンを setEvents で流すと scene1 の終わりで停止せず scene2 へ自動進行する', () => {
    const scenes: EventScene[] = [
      scene('s1', [narration('s1-line')]),
      scene('s2', [narration('s2-line')]),
      scene('s3', [narration('s3-line')]),
    ]
    const r = new NovelRenderer()
    const onEnd = vi.fn()
    r.onEnd(onEnd)

    r.setEvents(flatten(scenes))

    // 起点: scene1 の Narration
    expect(r.getDebugState().eventIndex).toBe(0)
    expect(r.getDebugState().eventText).toContain('s1-line')

    // scene1 を抜ける → SceneTransition を踏み越えて scene2 の本文に到達（= scene1 で停止しない）
    internals(r).advance()
    expect(r.getDebugState().eventText).toContain('s2-line')
    expect(onEnd).not.toHaveBeenCalled()

    // scene2 → scene3
    internals(r).advance()
    expect(r.getDebugState().eventText).toContain('s3-line')
    expect(onEnd).not.toHaveBeenCalled()

    // scene3 を抜けて初めて全イベント完了 = onEnd 1 回（途中で発火しない）
    internals(r).advance()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('単一 script（1 doc 内の多シーン）も線形に自動進行する（friday1930 相当の退行ガード）', () => {
    // friday1930-sample.md のように 1 つの MD 内に複数シーンがある作品。
    // scenes=（setScenes）に切り替える前の従来挙動 = 全シーン線形自動進行を維持する。
    const scenes: EventScene[] = [
      scene('prologue', [narration('朝の光')]),
      scene('village', [narration('村の朝')]),
    ]
    const r = new NovelRenderer()
    const onEnd = vi.fn()
    r.onEnd(onEnd)
    r.setEvents(flatten(scenes))

    expect(r.getDebugState().eventText).toContain('朝の光')
    // 1 回の advance で次シーンへ（scene1 で止まらない）
    internals(r).advance()
    expect(r.getDebugState().eventText).toContain('村の朝')
    expect(onEnd).not.toHaveBeenCalled()
  })
})

describe('NovelRenderer.setJumpSceneIndex クロスファイル解決 (#284 M2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('再生ストリームに無い別 MD のシーン ID へ jumpToScene で到達できる', () => {
    // 再生ストリーム = エントリ doc（entry-hub のみ）を線形 flatten。
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    // ジャンプ索引 = エントリ + 別 MD のシーン（far-scene）。far-scene は再生ストリームには無い。
    const jumpIndex: EventScene[] = [
      ...entryScenes,
      scene('far-scene', [narration('far-line-a', 'far-line-b')]),
    ]

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(jumpIndex)

    // 索引に別 MD のシーンが入っている
    expect(r.getAllSceneIds()).toEqual(['entry-hub', 'far-scene'])

    // 再生ストリームには無いシーンへジャンプ（→ far-scene）が成立し、到達する
    r.jumpToScene('far-scene')
    expect(r.getCurrentSceneId()).toBe('far-scene')
    expect(r.getDebugState().eventText).toContain('far-line-a')
  })

  it('通常の jumpToScene は前シーン立ち絵を即時 clear せず fade-out へ入れる', () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const jumpIndex: EventScene[] = [...entryScenes, scene('far-scene', [narration('far-line')])]
    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(jumpIndex)
    internals(r).characterLayer.show('せお', 'normal', '左', '', { instant: true })

    r.jumpToScene('far-scene')

    const seo = internals(r).characterLayer.characters.get('せお')
    expect(seo).toBeDefined()
    expect(seo!.fadeAnimation).toMatchObject({
      toAlpha: 0,
      destroyOnComplete: true,
    })
  })

  it('setJumpSceneIndex は再生ストリーム（resolvedEvents / 現在位置）を置換しない', () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-a', 'hub-b')])]
    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    // setEvents 直後の再生ストリームを退避
    const resolvedBefore = [...internals(r).resolvedEvents]
    const indexBefore = internals(r).eventIndex
    const textBefore = r.getDebugState().eventText

    // 別 MD を含む索引を後から差し替えても、再生中の events は変わらない
    r.setJumpSceneIndex([...entryScenes, scene('other', [narration('other-line')])])

    expect(internals(r).resolvedEvents).toEqual(resolvedBefore)
    expect(internals(r).eventIndex).toBe(indexBefore)
    expect(r.getDebugState().eventText).toBe(textBefore)
    // 索引だけは別 MD のシーンを含むよう更新される
    expect(r.getAllSceneIds()).toContain('other')
  })

  it('#314: 未ロード scene は resolver で追加索引を受け取り jumpToScene で到達する', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const farScene = scene('far-scene', [narration('far-line')])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resolver = vi.fn(async () => [...entryScenes, farScene])
    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    // #463: resolveMissingSceneAndJump に destroy 後ガード（!this.initialized なら早期return）を
    // 追加したため、resolver の正常解決を検証するにはこのテストでも init() 完了相当を模す必要がある。
    markInitialized(r)

    r.jumpToScene('far-scene')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('far-scene')
    expect(r.getAllSceneIds()).toEqual(['entry-hub', 'far-scene'])
    expect(r.getCurrentSceneId()).toBe('far-scene')
    expect(r.getDebugState().eventText).toContain('far-line')
  })

  // ===== #463: resolveMissingSceneAndJump の destroy 後ガード
  //   (resolveMissingSceneAndRestore の #460 S1 と同型のリスクへの対処) =====
  it('S1: missingSceneResolver の解決待ち中に destroy() されても、resolve 後に例外を投げず jump 処理も実行されない', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const farScene = scene('far-scene', [narration('far-line')])
    let resolveScenes: ((scenes: EventScene[]) => void) | undefined
    const resolver = vi.fn(
      () =>
        new Promise<EventScene[]>((resolve) => {
          resolveScenes = resolve
        })
    )

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.jumpToScene('far-scene')
    expect(resolver).toHaveBeenCalledWith('far-scene')

    // 連続remount想定: resolver がまだ解決していない間に、この renderer 自身が destroy() される。
    // NovelRenderer.restoreSnapshot.test.ts の S1 と同じ理由（jsdom には実 PixiJS canvas が無く
    // init() を最後まで実行できない）で、destroy() 自体は早期returnの安全な no-op になる。
    // そのため、実機で appInitialized 済みの場合に destroy() が行う「initialized = false」を
    // ここでは直接模して、ガードの分岐を実際に踏ませる。
    expect(() => r.destroy()).not.toThrow()
    internals(r).initialized = false

    // destroy 後に resolver が解決しても例外を投げない（ガードが無いと startScene 等が
    // 破棄済みの this.app.stage を触り得る）
    expect(() => {
      resolveScenes?.([...entryScenes, farScene])
    }).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // ガードにより setJumpSceneIndex/startScene 相当の処理が一切実行されない
    // → allScenes に far-scene が追加されず、currentSceneId も未設定のまま
    expect(r.getAllSceneIds()).toEqual(['entry-hub'])
    expect(r.getCurrentSceneId()).toBeNull()
  })

  // ===== #463 テスト設計横展開: resolveMissingSceneAndRestore 側の K2/K3/K4/K6 相当を
  //   resolveMissingSceneAndJump 側にも用意する（restore 側にはあるが jump 側に無かった漏れ）=====

  it('J-K2: missingSceneResolver が null を解決すると jump 処理は実行されず（getCurrentSceneId 不変）、例外も投げない', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => null)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    // 直接解決できる scene へ一度ジャンプしておき、「変化しない」ことを意味のある比較にする
    r.jumpToScene('entry-hub')
    const sceneBefore = r.getCurrentSceneId()

    expect(() => r.jumpToScene('ghost-route')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('ghost-route')
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    // null 解決は「lazy load 後も見つからない」ケースとは異なる分岐（scenes 自体が無い）なので warn しない
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('J-K3: resolver がシーンを返すが sceneId を含まない配列を解決すると console.warn が1回呼ばれ jump は実行されない', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const otherScene = scene('other-route', [narration('other-line')])
    // 'target-route' を含まない解決結果（別ファイルを誤って返す/typo 等の想定）
    const resolver = vi.fn(async () => [...entryScenes, otherScene])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    r.jumpToScene('entry-hub')
    const sceneBefore = r.getCurrentSceneId()

    r.jumpToScene('target-route')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('target-route')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
  })

  it('J-K4: missingSceneResolver が reject すると catch で warn され例外は外に漏れず、pendingMissingScenes は finally で削除される', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => {
      throw new Error('network error')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    expect(() => r.jumpToScene('target-route')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warnSpy).toHaveBeenCalled()
    // finally で pendingMissingScenes から削除されていなければ、以後同じ sceneId が
    // 永遠に「解決中」扱いのまま固着する（デッドロック）。削除済みであることを直接確認する。
    expect(internals(r).pendingMissingScenes.has('target-route')).toBe(false)
  })

  it('J-K4-destroy: destroy 後に missingSceneResolver が reject しても例外を投げず、warn も安全に発火する', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    let rejectScenes: ((err: Error) => void) | undefined
    const resolver = vi.fn(
      () =>
        new Promise<EventScene[]>((_resolve, reject) => {
          rejectScenes = reject
        })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.jumpToScene('far-scene')
    expect(resolver).toHaveBeenCalledWith('far-scene')

    // S1 と同じ想定: resolver 未解決中に destroy() される
    expect(() => r.destroy()).not.toThrow()
    internals(r).initialized = false

    // catch は await 直後の initialized チェックより前で reject を受け取るため、
    // destroy 後でも warn 自体は安全に発火する（例外は外に漏れない）
    expect(() => {
      rejectScenes?.(new Error('network error'))
    }).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warnSpy).toHaveBeenCalled()
    expect(r.getAllSceneIds()).toEqual(['entry-hub'])
    expect(r.getCurrentSceneId()).toBeNull()
  })

  it('J-K6: resolver 未解決中に同一 sceneId へ jumpToScene を2回連続で呼んでも resolver は1回しか呼ばれない', () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(() => new Promise<EventScene[]>(() => {})) // 意図的に未解決のまま保持

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.jumpToScene('far-scene')
    r.jumpToScene('far-scene') // 同一tick内の二重呼び出し（pendingMissingScenes 共有ガード）

    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('状態遷移: destroy 中に resolve され pendingMissingScenes が削除された後、同一 sceneId へ再度 jumpToScene を呼ぶと missingSceneResolver が再起動する（デッドロックしない）', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const farScene = scene('far-scene', [narration('far-line')])
    let resolveScenes: ((scenes: EventScene[]) => void) | undefined
    const resolver = vi.fn(
      () =>
        new Promise<EventScene[]>((resolve) => {
          resolveScenes = resolve
        })
    )

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    r.jumpToScene('far-scene')
    expect(resolver).toHaveBeenCalledTimes(1)

    // S1 と同じ手順: resolver 未解決中に destroy() → initialized=false を模す
    expect(() => r.destroy()).not.toThrow()
    internals(r).initialized = false
    resolveScenes?.([...entryScenes, farScene])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // ガードにより setJumpSceneIndex 相当は実行されないが、finally で
    // pendingMissingScenes からは削除されている（S1 と同じ結末）
    expect(r.getAllSceneIds()).toEqual(['entry-hub'])

    // 同一 sceneId へ再度 jumpToScene。pendingMissingScenes が残っていれば
    // ここで無視され resolver は永遠に再起動しない（デッドロック）が、削除済みのため再起動する。
    r.jumpToScene('far-scene')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('単一 script は索引が自ファイルのシーンのみ = jumpToScene の解決対象も自シーンに限る', () => {
    const selfScenes: EventScene[] = [
      scene('a', [narration('a-line')]),
      scene('b', [narration('b-line')]),
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.setEvents(flatten(selfScenes))
    r.setJumpSceneIndex(selfScenes)

    // 自ファイルのシーンへは解決して到達
    r.jumpToScene('b')
    expect(r.getCurrentSceneId()).toBe('b')
    expect(r.getDebugState().eventText).toContain('b-line')

    // 自ファイルに無いシーンは解決できない（従来どおり warn して no-op）
    r.jumpToScene('nonexistent')
    expect(warn).toHaveBeenCalled()
    // 直前の 'b' のまま（ジャンプ失敗で位置は変わらない）
    expect(r.getCurrentSceneId()).toBe('b')
  })
})
