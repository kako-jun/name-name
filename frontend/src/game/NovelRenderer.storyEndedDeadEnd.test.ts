/**
 * 終劇は行き止まり (#815, kako-jun 決定 2026-10-20)。
 *
 * 終劇（storyEnded）では巻き戻せない。goBack()/seekTo() は storyEnded ガード（#386）で no-op、
 * SeekBar は無効表示（操作を受け付けない）にする。storyEnded が変わる全経路（自然消化・選択肢の圏外短絡・
 * セーブ復元で終劇に入る/終劇から出る・場面転換で解除）で SeekBar の状態が storyEnded と一致することを縛る。
 * SeekBar の無効表示そのもの（eventMode・alpha 等）は SeekBar.test.ts。ここは renderer との連動だけを見る。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { confineForTest } from '../test/confinement'
import { internals, type RendererInternals } from '../test/rendererInternals'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'

interface Local extends RendererInternals {
  seekBar: {
    isDisabled(): boolean
    isActive(): boolean
    clickRegion: { eventMode: string; emit(e: string, ...a: unknown[]): boolean }
  }
  applyState(s: NovelGameState): void
  transition: { isGated(k: string): boolean }
}

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})

function muteAudio(r: NovelRenderer) {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}
const bar = (r: NovelRenderer) => internals<Local>(r).seekBar

/** narration 3 つ（各 1 行）。tap 2 回で最後の本文、3 回目で終劇。 */
function threeLines(): NovelRenderer {
  const r = new NovelRenderer()
  muteAudio(r)
  r.setScenes([scene('s', [narration('一'), narration('二'), narration('三')])])
  return r
}

describe('NovelRenderer 終劇は行き止まり: SeekBar 連動 (#815)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('開始直後・本文中は SeekBar が有効（従来どおり）', () => {
    const r = threeLines()
    expect(bar(r).isDisabled()).toBe(false)
    expect(bar(r).clickRegion.eventMode).toBe('static')
    r.handleOutsideCanvasTap()
    expect(bar(r).isDisabled()).toBe(false)
  })

  it('終劇に達する直前（最後の本文）はまだ有効で、直後（終劇）に無効になる', () => {
    const r = threeLines()
    r.handleOutsideCanvasTap() // 一→二
    r.handleOutsideCanvasTap() // 二→三（最後の本文）
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(bar(r).isDisabled()).toBe(false)
    r.handleOutsideCanvasTap() // 三を読み切る → 終劇
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(bar(r).isDisabled()).toBe(true)
    expect(bar(r).clickRegion.eventMode).toBe('none')
  })

  it('通常本文中は seekTo で巻き戻せる（退行なし）', () => {
    const r = threeLines()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    expect(r.getSnapshot().eventIndex).toBe(2)
    r.seekTo(0)
    expect(r.getSnapshot().eventIndex).toBe(0)
    expect(bar(r).isDisabled()).toBe(false)
  })

  it('終劇後は SeekBar を叩いても active にならず、seekTo / goBack も位置を動かさない', () => {
    const r = threeLines()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    const before = r.getSnapshot()
    expect(before.storyEnded).toBe(true)
    bar(r).clickRegion.emit('pointerdown', { globalX: 100 })
    bar(r).clickRegion.emit('pointerdown', { globalX: 100 })
    expect(bar(r).isActive()).toBe(false)
    r.seekTo(0)
    const afterSeek = r.getSnapshot()
    expect(afterSeek.storyEnded).toBe(true)
    expect(afterSeek.eventIndex).toBe(before.eventIndex)
    r.goBack()
    const after = r.getSnapshot()
    expect(after.storyEnded).toBe(true)
    expect(after.eventIndex).toBe(before.eventIndex)
  })

  it('終劇後の goBack / seekTo は状態復元（applyState）自体を起こさない', () => {
    const r = threeLines()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    // ナビゲーション遷移ゲート（終劇フェード中など）が先に弾く経路と切り分けるため、ゲートは開けておく。
    vi.spyOn(internals<Local>(r).transition, 'isGated').mockReturnValue(false)
    const spy = vi.spyOn(internals<Local>(r), 'applyState')
    r.goBack()
    r.seekTo(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('終劇に入る時に SeekBar が active だったら解除される', () => {
    const r = threeLines()
    bar(r).clickRegion.emit('pointerdown', { globalX: 100 })
    expect(bar(r).isActive()).toBe(true)
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    expect(bar(r).isActive()).toBe(false)
  })

  it('選択肢が全て圏外のとき（短絡終劇）も無効になる', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([
      scene('entry', [
        narration('本文'),
        { Choice: { options: [{ text: '外へ', jump: 'out' }] } } as Event,
      ]),
      scene('out', [narration('外')]),
    ])
    confineForTest(r, ['entry'])
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(bar(r).isDisabled()).toBe(true)
  })

  it('セーブ復元（新規 renderer へ storyEnded=true を復元）で終劇状態に入ると無効', async () => {
    const src = threeLines()
    src.handleOutsideCanvasTap()
    src.handleOutsideCanvasTap()
    src.handleOutsideCanvasTap()
    const snap = src.getSnapshot()
    expect(snap.storyEnded).toBe(true)

    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('s', [narration('一'), narration('二'), narration('三')])])
    expect(bar(r).isDisabled()).toBe(false)
    await r.restoreSnapshot(snap)
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(bar(r).isDisabled()).toBe(true)
  })

  it('終劇状態から storyEnded=false の状態を復元すると SeekBar が有効に戻る', () => {
    const r = threeLines()
    r.handleOutsideCanvasTap()
    const mid = r.getSnapshot()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    r.handleOutsideCanvasTap()
    expect(bar(r).isDisabled()).toBe(true)
    internals<Local>(r).applyState(mid)
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(bar(r).isDisabled()).toBe(false)
  })

  it('場面転換（jumpToScene）で終劇が解除されると有効に戻る', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('a', [narration('一')]), scene('b', [narration('二'), narration('三')])])
    r.handleOutsideCanvasTap()
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(bar(r).isDisabled()).toBe(true)
    await r.jumpToScene('b')
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(bar(r).isDisabled()).toBe(false)
  })
})
