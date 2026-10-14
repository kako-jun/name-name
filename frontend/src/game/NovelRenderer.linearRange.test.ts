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

  it('途中のシーンから始めても先頭のシーンの BGM を持ち越さない（新規開始）', async () => {
    const mk = () => {
      const scenes = [
        scene('a', [{ Bgm: { action: 'Play', path: 'a.mp3' } } as Event, narration('a-line')]),
        scene('b', [narration('b-line')]),
        scene('c', [narration('c-line')]),
      ]
      const r = new NovelRenderer()
      r.setEvents(flatten(scenes))
      r.setJumpSceneIndex(scenes)
      return r
    }
    // 陽性対照: a から始めれば a の BGM が鳴る
    const fromA = mk()
    await fromA.startFrom({ sceneId: 'a' })
    expect(fromA.getSnapshot().currentBgmPath).toContain('a.mp3')
    // b から始めると a の [BGM:] は実行されない
    const fromB = mk()
    await fromB.startFrom({ sceneId: 'b' })
    expect(fromB.getDebugState().eventIndex).toBe(3)
    expect(fromB.getDebugState().eventText).toContain('b-line')
    expect(fromB.getSnapshot().currentBgmPath).toBeNull()
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

  it('最後のシーンから始めた後のセーブ（sceneId = null）から復元できる', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'c' })
    const snap = r.getSnapshot()
    expect(snap.sceneId).toBeNull()
    const other = new NovelRenderer()
    const scenes = [
      scene('a', [narration('a-line')]),
      scene('b', [narration('b-line')]),
      scene('c', [narration('c-line')]),
    ]
    other.setEvents(flatten(scenes))
    other.setJumpSceneIndex(scenes)
    const res = await other.restoreSnapshot(snap)
    expect(res.status).toBe('entered')
    expect(other.getDebugState().eventText).toContain('c-line')
    expect(other.getPlayheadSceneId()).toBe('c')
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

  it('最後のシーン c から始めても線形経路（ストリームの持ち主はエントリのまま）で、c の末尾で完走する', async () => {
    const { r } = linearRenderer()
    const rec = recordRange(r, 'c')
    await r.startFrom({ sceneId: 'c' })
    expect(r.getCurrentSceneId()).toBeNull()
    expect(r.getPlayheadSceneId()).toBe('c')
    expect(r.getDebugState().eventText).toContain('c-line')
    advance(r)
    expect(rec.entered).toEqual(['c'])
    expect(rec.stoppedBy()).toBe('end')
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

describe('線形連結の新規開始の追加ケース (#777 レビュー対応)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const flag = (name: string): Event => ({ Flag: { name, value: { Bool: true } } })
  const cond = (name: string, ...events: Event[]): Event => ({ Condition: { flag: name, events } })

  it('開始時の flags で [条件:] の展開が変わると、開始位置（startIndex）も変わる', async () => {
    const mk = () => {
      const scenes = [
        scene('a', [cond('x', narration('ax1'), narration('ax2')), narration('a1')]),
        scene('b', [narration('b1')]),
        scene('c', [narration('c1')]),
      ]
      const r = new NovelRenderer()
      r.setEvents(flatten(scenes))
      r.setJumpSceneIndex(scenes)
      return r
    }
    const off = mk()
    await off.startFrom({ sceneId: 'b' })
    expect(off.getDebugState().eventIndex).toBe(2)
    const on = mk()
    await on.startFrom({ sceneId: 'b', flags: { x: { Bool: true } } })
    expect(on.getDebugState().eventIndex).toBe(4)
    expect(on.getDebugState().eventText).toContain('b1')
  })

  it('再生中の Flag で前のシーンの [条件:] の展開が変わっても、現在位置はずれない（重複表示・二重通知なし）', async () => {
    const scenes = [
      scene('a', [cond('x', narration('ax1'), narration('ax2')), narration('a1')]),
      scene('b', [narration('b1'), flag('x'), narration('b2')]),
      scene('c', [narration('c1')]),
    ]
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    const rec = recordRange(r, 'c')
    await r.startFrom({ sceneId: 'b' })
    expect(r.getDebugState().eventText).toContain('b1')
    advance(r) // Flag を処理 → a の展開が伸びる。位置は b2 のまま
    expect(r.getDebugState().eventText).toContain('b2')
    expect(r.getPlayheadSceneId()).toBe('b')
    advance(r)
    expect(r.getDebugState().eventText).toContain('c1')
    expect(rec.entered).toEqual(['b', 'c'])
  })

  it('再生中の Flag で後続のシーンの [条件:] が伸びても、境界の通知は正しい（回帰ガード）', async () => {
    const scenes = [
      scene('a', [narration('a1'), flag('x')]),
      scene('b', [cond('x', narration('bx1')), narration('b1')]),
      scene('c', [narration('c1')]),
    ]
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    const rec = recordRange(r, 'c')
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    expect(r.getDebugState().eventText).toContain('bx1')
    expect(r.getPlayheadSceneId()).toBe('b')
    advance(r)
    expect(r.getDebugState().eventText).toContain('b1')
    advance(r)
    expect(r.getDebugState().eventText).toContain('c1')
    expect(rec.entered).toEqual(['a', 'b', 'c'])
  })

  it('空のシーンが挟まっても a→b(空)→c→d の範囲指定が効く', async () => {
    const scenes = [
      scene('a', [narration('a1')]),
      scene('b', []),
      scene('c', [narration('c1')]),
      scene('d', [narration('d1')]),
    ]
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    const rec = recordRange(r, 'd')
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    expect(r.getDebugState().eventText).toContain('c1')
    advance(r)
    expect(r.getDebugState().eventText).toContain('d1')
    advance(r)
    expect(rec.entered).toEqual(['a', 'b', 'c', 'd'])
    expect(rec.stoppedBy()).toBe('end')
  })

  it('復元後に c へ進むと onSceneChange("c") がちょうど1回', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'b' })
    const snap = r.getSnapshot()
    advance(r)
    await r.restoreSnapshot(snap)
    const entered: string[] = []
    r.setOnSceneChange((id) => entered.push(id))
    advance(r)
    expect(entered).toEqual(['c'])
  })

  it('境界1つにつき requestAutoSave が1回で、保存は本文位置', async () => {
    const { r } = linearRenderer()
    const saved: string[] = []
    vi.spyOn(r as unknown as { saveQuick(o: string): boolean }, 'saveQuick').mockImplementation(
      () => {
        saved.push(r.getDebugState().eventText ?? '')
        return true
      }
    )
    const spy = vi.spyOn(r, 'requestAutoSave')
    r.setOnSceneChange(() => r.requestAutoSave())
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    advance(r)
    expect(spy).toHaveBeenCalledTimes(3) // a（開始）, b, c
    expect(saved).toHaveLength(3)
    expect(saved[1]).toContain('b-line')
    expect(saved[2]).toContain('c-line')
  })

  it('閉じ込め（?scene=）の外のシーンに入る境界では終劇になり、通知も進行もしない', async () => {
    const { r } = linearRenderer()
    const rec = recordRange(r, 'b')
    const ended = vi.fn()
    r.setOnStoryEndedChange(ended)
    await r.startFrom({ sceneId: 'b', confinedSceneIds: ['b'] })
    advance(r) // b → c へ入る: 圏外なので終劇
    expect((r as unknown as { storyEnded: boolean }).storyEnded).toBe(true)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(true)
    expect(rec.entered).toEqual(['b'])
    expect(r.getDebugState().eventText ?? '').not.toContain('c-line')
  })

  it('閉じ込めなし（?debug_scene= 相当）なら後続へ流れる', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'b', confinedSceneIds: null })
    advance(r)
    expect(r.getDebugState().eventText).toContain('c-line')
  })

  it('セーブ一覧・デバッグ状態のシーンは再生位置のシーン、セーブデータの sceneId は持ち主のまま', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'b' })
    expect(r.getDebugState().sceneId).toBe('b')
    expect(r.getSnapshot().sceneId).toBeNull()
  })

  it('goBack で境界を戻ってから進むと通知が再発火する（シーク操作では発火しない）', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    const entered: string[] = []
    r.setOnSceneChange((id) => entered.push(id))
    ;(r as unknown as { goBack(): void }).goBack()
    expect(entered).toEqual([])
    advance(r)
    expect(entered).toEqual(['b'])
  })

  it('seekTo で境界を越えても通知は発火しない', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    advance(r)
    const entered: string[] = []
    r.setOnSceneChange((id) => entered.push(id))
    r.seekTo(0) // c から a へ（境界を2つ越えて戻る）
    expect(r.getDebugState().eventText).toContain('a-line')
    expect(r.getPlayheadSceneId()).toBe('a')
    expect(entered).toEqual([])
  })

  it('intermission のタブローの SceneTransition ではシーン通知しない', async () => {
    const { r } = linearRenderer()
    await r.startFrom({ sceneId: 'a' })
    const entered: string[] = []
    r.setOnSceneChange((id) => entered.push(id))
    // 境界の位置（eventIndex = 1）にあっても、タブローの命令列は本編のストリームではない
    ;(r as unknown as { eventIndex: number }).eventIndex = 1
    ;(r as unknown as { renderIntermissionTableau(e: Event[]): void }).renderIntermissionTableau([
      'SceneTransition',
    ])
    expect(entered).toEqual([])
  })
})

function selfNegatingScenes(): EventScene[] {
  const flagOff: Event = { Flag: { name: 'x', value: { Bool: false } } }
  return [
    scene('a', [
      narration('a0'),
      { Condition: { flag: 'x', events: [narration('A'), flagOff, narration('B')] } },
      narration('C'),
    ]),
    scene('b', [narration('b1')]),
  ]
}

describe('再展開後のセーブから同じ位置・同じ進行を再現できる (#777)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  const cond = (name: string, ...events: Event[]): Event => ({ Condition: { flag: name, events } })
  const setFlag = (name: string, v: boolean): Event => ({ Flag: { name, value: { Bool: v } } })

  /** 同じ文書の新しい renderer を作る。 */
  function build(scenes: EventScene[]): NovelRenderer {
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    r.setDocKey('t777-save')
    return r
  }

  /** 各位置で保存 → 別インスタンスで復元（restoreSnapshot / quickLoad）→ 以降の本文と境界通知が一致する。 */
  async function expectRoundTrip(scenes: EventScene[], flags: Record<string, { Bool: boolean }>) {
    const text = (r: NovelRenderer) => (r.getDebugState().eventText ?? '').replace(/["\s]/g, '')
    // 元の進行を記録する（どの本文位置で、どのシーンに入ったか）
    const base = build(scenes)
    const enteredAt: { at: number; id: string }[] = []
    let trace: string[] = []
    base.setOnSceneChange((id) => enteredAt.push({ at: trace.length, id }))
    await base.startFrom({ sceneId: 'a', flags })
    trace = [text(base)]
    const snaps = [base.getSnapshot()]
    for (let i = 0; i < 12; i++) {
      advance(base)
      const t = text(base)
      if (t === '' || t === trace[trace.length - 1]) break
      trace.push(t)
      snaps.push(base.getSnapshot())
    }
    for (let k = 0; k < snaps.length; k++) {
      // restoreSnapshot
      const viaSnap = build(scenes)
      expect((await viaSnap.restoreSnapshot(snaps[k])).status).toBe('entered')
      expect(text(viaSnap)).toBe(trace[k])
      // quickLoad（実際にクイックセーブした位置から）
      localStorage.clear()
      const saver = build(scenes)
      await saver.restoreSnapshot(snaps[k])
      expect(saver.quickSave()).toBe(true)
      const viaLoad = build(scenes)
      expect((await viaLoad.quickLoad())?.status).toBe('entered')
      expect(text(viaLoad)).toBe(trace[k])
      // 以降の進行と境界通知が元と一致する
      for (const r of [viaSnap, viaLoad]) {
        const entered: string[] = []
        r.setOnSceneChange((id) => entered.push(id))
        const rest: string[] = []
        for (let j = k + 1; j < trace.length; j++) {
          advance(r)
          rest.push(text(r))
        }
        expect(rest).toEqual(trace.slice(k + 1))
        expect(entered).toEqual(enteredAt.filter((e) => e.at > k).map((e) => e.id))
      }
    }
    return trace
  }

  it('自己否定ブロック: Flag 直後〜ブロック外後続〜境界の各位置で、保存→復元が同じ本文と進行になる', async () => {
    const trace = await expectRoundTrip(selfNegatingScenes(), { x: { Bool: true } })
    expect(trace.slice(0, 4)).toEqual(['a0', 'A', 'C', 'b1'])
  })

  it('前方の [条件:] が Flag で変わっても、保存→復元で位置が重複・欠落しない', async () => {
    const scenes = [
      scene('a', [cond('x', narration('ax1'), narration('ax2')), narration('a1')]),
      scene('b', [narration('b1'), setFlag('x', true), narration('b2')]),
      scene('c', [narration('c1')]),
    ]
    const trace = await expectRoundTrip(scenes, {})
    expect(trace).toContain('b2')
    expect(trace.filter((t) => t === 'b1')).toHaveLength(1)
  })

  it('線形の境界をまたぐ進行（Flag で後続のシーンの展開が伸びる）も、保存→復元で一致する', async () => {
    const scenes = [
      scene('a', [narration('a1'), setFlag('x', true)]),
      scene('b', [cond('x', narration('bx1')), narration('b1')]),
      scene('c', [narration('c1')]),
    ]
    const trace = await expectRoundTrip(scenes, {})
    expect(trace.slice(0, 4)).toEqual(['a1', 'bx1', 'b1', 'c1'])
  })
})

describe('再展開は常に全体の展開と一致する・既読 (#777 再レビュー対応)', () => {
  const cond = (name: string, ...events: Event[]): Event => ({ Condition: { flag: name, events } })

  it('Flag 自身を囲む [条件:] が偽になると、ブロックの残りは消え（GUI 版の意味論）、外の後続と境界の通知は1回出る', async () => {
    const scenes = selfNegatingScenes()
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    const rec = recordRange(r, 'b')
    await r.startFrom({ sceneId: 'a', flags: { x: { Bool: true } } })
    const texts: string[] = []
    for (let i = 0; i < 6 && !rec.stoppedBy(); i++) {
      texts.push(r.getDebugState().eventText ?? '')
      advance(r)
    }
    expect(texts.map((t) => t.replace(/.*?(a0|A|B|C|b1).*/s, '$1'))).toEqual(['a0', 'A', 'C', 'b1'])
    expect(rec.entered).toEqual(['a', 'b'])
  })

  it('既存の再展開: 後続の [条件:] は新しい flags で評価される', async () => {
    const scenes = [
      scene('a', [
        narration('a0'),
        { Flag: { name: 'y', value: { Bool: true } } },
        cond('y', narration('Y')),
        narration('a1'),
      ]),
      scene('b', [narration('b1')]),
    ]
    const r = new NovelRenderer()
    r.setEvents(flatten(scenes))
    r.setJumpSceneIndex(scenes)
    await r.startFrom({ sceneId: 'a' })
    advance(r)
    expect(r.getDebugState().eventText).toContain('Y')
  })

  it('線形ストリームで、読み終えたシーンが境界で既読になる（持ち主 null でも）', async () => {
    const { r } = linearRenderer()
    r.setDocKey('t777-read')
    await r.startFrom({ sceneId: 'a' })
    const read = (r as unknown as { readSceneProgress: Set<string> }).readSceneProgress
    expect(read.has('a')).toBe(false)
    advance(r) // b に入る
    expect(read.has('a')).toBe(true)
    expect(read.has('b')).toBe(false)
    advance(r) // c に入る
    expect(read.has('b')).toBe(true)
    localStorage.clear()
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

  it('空のシーンは長さ 0 の区間になり、後ろのシーンも続く（a→b(空)→c→d）', () => {
    const e = scene('e', [])
    const d = scene('d', [narration('d')])
    const stream = flatten([a, e, c, d])
    expect(findLinearSegments(stream, [a, e, c, d]).map((x) => x.sceneId)).toEqual([
      'a',
      'e',
      'c',
      'd',
    ])
    const resolved = resolveLinearSegments(
      stream,
      findLinearSegments(stream, [a, e, c, d]),
      (ev) => ev.length
    )
    expect(resolved.map((x) => [x.sceneId, x.separator, x.start])).toEqual([
      ['a', null, 0],
      ['e', 1, 2],
      ['c', 2, 3],
      ['d', 4, 5],
    ])
  })

  it('文字列イベントだけのシーンが他にあっても、先頭一致の取り違えで連鎖を失わない', () => {
    const p = scene('p', ['CurtainUp'])
    const q = scene('q', ['CurtainUp'])
    const stream = flatten([q, c])
    // allScenes の先頭に別ファイルの p（同じ内容）があっても、q→c の連鎖を採る
    expect(findLinearSegments(stream, [p, q, c]).map((x) => x.sceneId)).toEqual(['q', 'c'])
  })
})
