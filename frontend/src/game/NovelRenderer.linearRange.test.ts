/**
 * 線形連結のシーンを跨ぐ新規開始と、シーン境界での onSceneChange (#777)。
 *
 * 動画書き出しは `startFrom({sceneId})` で始まり、`onSceneChange` / `onEnd` で範囲の終端を判定する。
 * エントリ文書は「シーンの間に SceneTransition を挟んで flatten」したストリームで再生するので、
 * 線形につながった a→b→c で開始 a・終了 c を指定しても、a の末尾で止まらず c の末尾まで流れる。
 * VideoExporter の終端判定（終了シーンに入った後に別シーンへ変わる / onEnd）をここで再現して確かめる。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { findLinearSegments, resolveLinearSegments, segmentAt } from './sceneEntry'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}
function flatten(scenes: EventScene[]): Event[] {
  const events: Event[] = []
  scenes.forEach((s, i) => {
    if (i > 0) events.push('SceneTransition')
    events.push(...s.events)
  })
  return events
}
function advance(r: NovelRenderer): void {
  ;(r as unknown as { advance(): void }).advance()
}

/** VideoExporter と同じ終端判定: 終了シーンに入った後に別シーンへ変わる、または onEnd。 */
function recordRange(r: NovelRenderer, endSceneId: string) {
  const entered: string[] = []
  let visitedEnd = false
  let stoppedBy: string | null = null
  r.setOnSceneChange((id) => {
    entered.push(id)
    if (stoppedBy) return
    if (id === endSceneId) {
      visitedEnd = true
      return
    }
    if (visitedEnd) stoppedBy = `scene:${id}`
  })
  r.setOnEnd(() => {
    if (!stoppedBy) stoppedBy = 'end'
  })
  return { entered, stoppedBy: () => stoppedBy }
}

function linearRenderer() {
  const scenes = [
    scene('a', [narration('a-line')]),
    scene('b', [narration('b-line')]),
    scene('c', [narration('c-line')]),
  ]
  const r = new NovelRenderer()
  r.setEvents(flatten(scenes))
  r.setJumpSceneIndex(scenes)
  return { r, scenes }
}

describe('線形連結のシーンを跨ぐ新規開始 (#777)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('開始 a・終了 c: b, c で onSceneChange が発火し、c の末尾まで録画される', async () => {
    const { r } = linearRenderer()
    const rec = recordRange(r, 'c')
    const res = await r.startFrom({ sceneId: 'a' })
    expect(res).toEqual({ status: 'entered', sceneId: 'a' })
    expect(r.getDebugState().eventText).toContain('a-line')
    expect(r.getPlayheadSceneId()).toBe('a')

    advance(r)
    expect(r.getDebugState().eventText).toContain('b-line')
    expect(r.getPlayheadSceneId()).toBe('b')
    expect(rec.stoppedBy()).toBeNull()

    advance(r)
    expect(r.getDebugState().eventText).toContain('c-line')
    expect(r.getPlayheadSceneId()).toBe('c')
    expect(rec.stoppedBy()).toBeNull()

    advance(r) // c の末尾 → 全イベント完走
    expect(rec.entered).toEqual(['a', 'b', 'c'])
    expect(rec.stoppedBy()).toBe('end')
  })

  it('開始 b・終了 b: b だけ録画され、c へは進まない（b の後ろで止まる）', async () => {
    const { r } = linearRenderer()
    const rec = recordRange(r, 'b')
    const res = await r.startFrom({ sceneId: 'b' })
    expect(res).toEqual({ status: 'entered', sceneId: 'b' })
    expect(r.getDebugState().eventText).toContain('b-line')
    expect(rec.entered).toEqual(['b'])

    advance(r) // b を抜けて c へ入る → 終了シーンの後で別シーンへ変わった
    expect(rec.entered).toEqual(['b', 'c'])
    expect(rec.stoppedBy()).toBe('scene:c')
  })

  it('開始 a・終了 b: b の末尾（c に入る手前）で止まる', async () => {
    const { r } = linearRenderer()
    const rec = recordRange(r, 'b')
    await r.startFrom({ sceneId: 'a' })
    advance(r) // b
    expect(rec.stoppedBy()).toBeNull()
    advance(r) // c に入る → 範囲終了
    expect(rec.entered).toEqual(['a', 'b', 'c'])
    expect(rec.stoppedBy()).toBe('scene:c')
  })

  it('途中のシーンから始めても先頭のシーンの演出・立ち絵・BGM を持ち越さない（新規開始）', async () => {
    const scenes = [
      scene('a', [{ Bgm: { path: 'a.mp3' } } as unknown as Event, narration('a-line')]),
      scene('b', [narration('b-line')]),
      scene('c', [narration('c-line')]),
    ]
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    await r.startFrom({ sceneId: 'b' })
    expect(r.getDebugState().eventIndex).toBeGreaterThan(0)
    expect(r.getSnapshot().currentBgmPath).toBeNull()
  })

  it('保存は線形ストリームのまま（sceneId = エントリ(null) + eventIndex）で、復元できる', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'b' })
    const snap = r.getSnapshot()
    expect(snap.sceneId).toBeNull()
    advance(r)
    expect(r.getDebugState().eventText).toContain('c-line')
    const res = await r.restoreSnapshot(snap)
    expect(res.status).toBe('entered')
    expect(r.getDebugState().eventText).toContain('b-line')
    expect(r.getPlayheadSceneId()).toBe('b')
  })

  it('作者の [場面転換]（シーン内）はシーン境界ではなく、onSceneChange を発火しない', async () => {
    const scenes = [
      scene('a', [narration('a1'), 'SceneTransition', narration('a2')]),
      scene('b', [narration('b-line')]),
    ]
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    const rec = recordRange(r, 'b')
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    expect(r.getDebugState().eventText).toContain('a2')
    expect(r.getPlayheadSceneId()).toBe('a')
    expect(rec.entered).toEqual(['a'])
    advance(r)
    expect(rec.entered).toEqual(['a', 'b'])
  })

  it('選択肢・ジャンプで別シーンへ進む範囲指定は従来どおり（退行ガード）', async () => {
    const { r } = linearRenderer()
    const rec = recordRange(r, 'c')
    await r.startFrom({ sceneId: 'a' })
    // a の途中から c へ進行（選択肢の確定・[ジャンプ:] と同じ progress 入場）。b は飛ばす。
    r.jumpToScene('c')
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getPlayheadSceneId()).toBe('c')
    expect(r.getDebugState().eventText).toContain('c-line')
    expect(rec.entered).toEqual(['a', 'c'])
    expect(rec.stoppedBy()).toBeNull()
    // ジャンプ先 c のストリームは c の events だけなので、末尾で完走する
    advance(r)
    expect(rec.stoppedBy()).toBe('end')
  })

  it('最後のシーン c から始めると、従来どおり c がストリームの持ち主（続くシーンが無い）', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'c' })
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getPlayheadSceneId()).toBe('c')
    expect(r.getDebugState().eventText).toContain('c-line')
  })

  it('エントリ文書の外のシーン（線形ストリーム上にない）は従来どおりそのシーンの events だけを流す', async () => {
    const entry = [scene('a', [narration('a-line')]), scene('b', [narration('b-line')])]
    const other = scene('x', [narration('x-line')])
    const r = new NovelRenderer()
    r.setEvents(flatten(entry))
    r.setJumpSceneIndex([...entry, other])
    const onEnd = vi.fn()
    r.setOnEnd(onEnd)
    await r.startFrom({ sceneId: 'x' })
    expect(r.getCurrentSceneId()).toBe('x')
    expect(r.getPlayheadSceneId()).toBe('x')
    advance(r)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})

describe('findLinearSegments / resolveLinearSegments / segmentAt (#777)', () => {
  const a = scene('a', [narration('a')])
  const b = scene('b', [narration('b1'), narration('b2')])
  const c = scene('c', [narration('c')])

  it('flatten したストリームをシーン区間に分解する（他ファイルのシーンが先に並んでいても）', () => {
    const x = scene('x', [narration('x')])
    const stream = flatten([a, b, c])
    expect(findLinearSegments(stream, [x, a, b, c])).toEqual([
      { sceneId: 'a', start: 0, length: 1 },
      { sceneId: 'b', start: 2, length: 2 },
      { sceneId: 'c', start: 5, length: 1 },
    ])
  })

  it('照合できないところで打ち切る（エントリの先頭シーンだけのストリーム）', () => {
    expect(findLinearSegments(a.events, [a, b, c])).toEqual([{ sceneId: 'a', start: 0, length: 1 }])
  })

  it('展開後の境界と、位置が属するシーン', () => {
    const stream = flatten([a, b, c])
    const segs = findLinearSegments(stream, [a, b, c])
    const resolved = resolveLinearSegments(stream, segs, (events) => events.length)
    expect(resolved).toEqual([
      { sceneId: 'a', start: 0, separator: null },
      { sceneId: 'b', start: 2, separator: 1 },
      { sceneId: 'c', start: 5, separator: 4 },
    ])
    expect(segmentAt(resolved, 0)?.sceneId).toBe('a')
    expect(segmentAt(resolved, 1)?.sceneId).toBe('b') // 境界の SceneTransition は次のシーンに属す
    expect(segmentAt(resolved, 3)?.sceneId).toBe('b')
    expect(segmentAt(resolved, 5)?.sceneId).toBe('c')
  })
})
