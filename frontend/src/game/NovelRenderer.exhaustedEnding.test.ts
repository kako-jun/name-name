/**
 * NovelRenderer の「選択肢を持たないシーンの記述が尽きた」終劇分岐のテスト (#470)。
 *
 * 従来 advance() は全イベント消化後、`onEndCallback` が登録されていればそれを呼ぶだけで
 * （VideoExporter 等の専用終了処理に委譲）、未登録時は何もせず「無反応で固まる」だけだった。
 * #470 でこの未登録ケースに #386 の `endStory()`（"to be continued..." 表示・BGM 停止・
 * 背景/立ち絵フェード）を流用するようにした。confinement 経由の正規終劇（choice が圏外シーンへ
 * ジャンプ → jumpToScene 内で endStory()）とは発生源が違うが、endStory() 自体は共通のため
 * 同じ終端状態に収束することを確認する。
 *
 * 駆動方式（NovelRenderer.confinement.test.ts / novel.test.ts と同形）:
 *   `new NovelRenderer()` → `setScenes(...)` の最小構成。dialog_style 未指定（adv 単線）で
 *   各 narration は1行のため、advance 1 回で次イベントへ進む。
 *   #467 と同じく advance() は handleAdvance() を経由するため audioManager.ensureContext() を
 *   muteAudio() で no-op 化する。
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

/** handleAdvance() 経由で叩かれる audioManager.ensureContext() を no-op にする（jsdom に AudioContext が無い）。 */
function muteAudio(r: NovelRenderer) {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

/** [選択] を持たない2イベントのシーンを全消化する（adv単線・各1行なので advance 2 回で末尾到達）。 */
function exhaustNoChoiceScene(r: NovelRenderer): void {
  r.handleOutsideCanvasTap() // event 0 -> 1
  r.handleOutsideCanvasTap() // event 1 -> 末尾到達
}

describe('NovelRenderer 選択肢なしシーンの終劇分岐 (#470)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('17: onEndCallback未登録+選択肢なしシーンの全イベント消化後、storyEnded=trueになりonStoryEndedChangeCallback(true)が発火する', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    const cb = vi.fn()
    r.setOnStoryEndedChange(cb)
    r.setScenes([scene('s', [narration('最初'), narration('最後')])])

    exhaustNoChoiceScene(r)

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(true)
  })

  it('18: onEndCallback登録済み(モック)で同じ経路を辿ると、onEndCallbackのみ呼ばれendStory()側の状態変化は起きない', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    const storyEndedCb = vi.fn()
    r.setOnStoryEndedChange(storyEndedCb)
    const onEnd = vi.fn()
    r.setOnEnd(onEnd) // VideoExporter 等が登録する専用終了処理を模す
    r.setScenes([scene('s', [narration('最初'), narration('最後')])])

    exhaustNoChoiceScene(r)

    expect(onEnd).toHaveBeenCalledTimes(1)
    // endStory() 側（"to be continued..." 表示・BGM停止等）には委譲しない = storyEnded は変化しない。
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(storyEndedCb).not.toHaveBeenCalled()
  })

  it('19: 全イベント消化後にもう一度呼んでも二重にendStoryの副作用が起きない(storyEndedガード)', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    const cb = vi.fn()
    r.setOnStoryEndedChange(cb)
    r.setScenes([scene('s', [narration('最初'), narration('最後')])])

    exhaustNoChoiceScene(r) // 末尾到達 → endStory() 発火、cb(true) 1回
    expect(cb).toHaveBeenCalledTimes(1)

    // 末尾到達後にさらに叩いても、advance() 冒頭の storyEnded ガードで即 return する。
    r.handleOutsideCanvasTap()
    r.advance()

    expect(cb).toHaveBeenCalledTimes(1)
    expect(r.getSnapshot().storyEnded).toBe(true)
  })

  it('20: 選択肢なし自然消化ケースが、既存のchoice経由confinementケースと同じ終端状態(storyEnded=true等)に収束する', () => {
    // ルートA (#470): 選択肢を持たないまま記述が尽きる自然消化。
    const naturalExhaustion = new NovelRenderer()
    muteAudio(naturalExhaustion)
    naturalExhaustion.setScenes([scene('s', [narration('最初'), narration('最後')])])
    exhaustNoChoiceScene(naturalExhaustion)

    // ルートB (#386): choice 経由で confinement 外シーンへジャンプする正規終劇。
    const confinementJump = new NovelRenderer()
    confinementJump.setScenes([
      scene('entry', [narration('本文')]),
      scene('out-scene', [narration('圏外')]),
    ])
    confinementJump.setConfinedSceneIds(['entry'])
    confinementJump.jumpToScene('out-scene')

    const snapA = naturalExhaustion.getSnapshot()
    const snapB = confinementJump.getSnapshot()

    expect(snapA.storyEnded).toBe(true)
    expect(snapB.storyEnded).toBe(true)
    expect(snapA.backgroundPath).toBeNull()
    expect(snapB.backgroundPath).toBeNull()
    expect(snapA.video).toBeNull()
    expect(snapB.video).toBeNull()
    expect(snapA.characters).toEqual([])
    expect(snapB.characters).toEqual([])
    expect(snapA.currentBgmPath).toBeNull()
    expect(snapB.currentBgmPath).toBeNull()
  })
})
