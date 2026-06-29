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

    r.jumpToScene('far-scene')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('far-scene')
    expect(r.getAllSceneIds()).toEqual(['entry-hub', 'far-scene'])
    expect(r.getCurrentSceneId()).toBe('far-scene')
    expect(r.getDebugState().eventText).toContain('far-line')
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
