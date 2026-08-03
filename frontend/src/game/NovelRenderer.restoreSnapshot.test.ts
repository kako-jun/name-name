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

/** restoreSnapshot 検証用の内部アクセサ（startFrom.test.ts と同じ） */
interface RendererInternals {
  history: unknown[]
  justSelectedChoice: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
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
  scene('a', [narration('a1', 'a2', 'a3'), narration('a4')]),
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
})
