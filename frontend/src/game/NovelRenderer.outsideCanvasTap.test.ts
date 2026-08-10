/**
 * NovelRenderer.handleOutsideCanvasTap() の単体テスト (#467)。
 *
 * letterbox/pillarbox の黒帯（canvas 外側）タップ用の公開 API。実装は内部で
 * `handleAdvance()`（canvas 自身の pointerdown リスナーと同じ処理）をそのまま呼ぶだけなので、
 * advance() 相当の前進・各種ガード（storyEnded / waitingForChoice / 未初期化）がそのまま
 * 効くことを確認する。
 *
 * 駆動方式（NovelRenderer.seekAdvance.test.ts と同形）:
 *   `new NovelRenderer()` のみ（init は呼ばない＝PixiJS app は構築されるが canvas 化しない）。
 *   handleAdvance() は audioManager.ensureContext() を呼ぶが jsdom には AudioContext が無いため
 *   muteAudio() で no-op 化する。
 *
 * fixture は confinement.test.ts / novel.test.ts と同じ narration/scene ヘルパー・
 * dialog_style 未指定（= adv 単線、各 narration は1行なので advance 1 回で次イベントへ進む）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface OutsideTapInternals {
  waitingForChoice: boolean
  resolvedEvents: Event[]
}
function internals(r: NovelRenderer): OutsideTapInternals {
  return r as unknown as OutsideTapInternals
}

/** handleAdvance() 経由で叩かれる audioManager.ensureContext() を no-op にする（jsdom に AudioContext が無い）。 */
function muteAudio(r: NovelRenderer) {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

describe('NovelRenderer.handleOutsideCanvasTap (#467)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1: 正常系 — 呼ぶと advance 相当でテキストが1つ進む（eventIndex が前進する）', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('s', [narration('一文目'), narration('二文目')])])
    expect(r.getSnapshot().eventIndex).toBe(0)

    r.handleOutsideCanvasTap()

    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('2: storyEnded=true の状態で呼んでも何も進まない（getSnapshot() が不変）', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('entry', [narration('本文')]), scene('out-scene', [narration('圏外')])])
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene') // 圏外ジャンプ → endStory() → storyEnded=true（#386）
    expect(r.getSnapshot().storyEnded).toBe(true)
    const before = r.getSnapshot()

    r.handleOutsideCanvasTap()

    expect(r.getSnapshot()).toEqual(before)
  })

  it('3: 選択肢表示中（waitingForChoice相当）に呼んでも進まない', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('s', [narration('一文目'), narration('二文目')])])
    internals(r).waitingForChoice = true

    r.handleOutsideCanvasTap()

    expect(r.getSnapshot().eventIndex).toBe(0)
  })

  it('4: resolvedEvents.length===0（setScenes未実行=未初期化）で呼んでも例外を投げない', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    expect(internals(r).resolvedEvents.length).toBe(0)

    expect(() => r.handleOutsideCanvasTap()).not.toThrow()
  })
})
