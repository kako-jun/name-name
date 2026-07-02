/**
 * NovelRenderer.playScript(steps) のテスト (#220 Phase 1)。
 *
 * デバッグ用リプレイ API の検証。アセットロードを伴う描画は避け、
 * `new NovelRenderer()` → `setScenes(...)` → `playScript(...)` の最小構成で
 * イベント進行ロジック・msPerChar 退避復元・再入ガードを確認する。
 *
 * init() を呼ばないため `render()` は `if (!this.initialized) return` で描画を
 * スキップする。検証は getDebugState() / getSnapshot() / getCurrentSceneId() /
 * dialogBox.getMsPerChar() の公開 / 内部アクセサで行う（実描画・PixiJS は対象外、
 * CLAUDE.md ルール7 の実機 golden path に委ねる）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { clearReadProgress, loadReadSceneProgress } from './readProgress'
import type { Step } from './GameState'
import type { Event, EventScene } from '../types'

// --- fixture helpers ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function dialog(character: string, ...lines: string[]): Event {
  return { Dialog: { character, expression: null, position: null, text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** 単一シーン（ナレーション数行）を持つ renderer を作る */
function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** dialogBox の private msPerChar アクセサ（getMsPerChar）に到達するための型 */
interface RendererInternals {
  dialogBox: { getMsPerChar(): number; setMsPerChar(ms: number): void }
  jumpToScene(sceneId: string): void
  advance(): void
  isReplaying: boolean
  justSelectedChoice: boolean
  waitingForChoice: boolean
  choiceOverlay: { show: ReturnType<typeof vi.fn> }
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function getMsPerChar(r: NovelRenderer): number {
  return internals(r).dialogBox.getMsPerChar()
}

const SCENES_SINGLE: EventScene[] = [
  scene('start', [narration('行1', '行2', '行3'), dialog('A', 'せりふ1', 'せりふ2')]),
]

const SCENES_BRANCH: EventScene[] = [
  scene('start', [narration('intro')]),
  scene('left', [narration('左ルート')]),
  scene('right', [narration('右ルート')]),
]

describe('NovelRenderer.playScript (#220)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    clearReadProgress('novel-renderer-read-completion-test')
  })

  // ===== A. msPerChar 退避復元 =====

  it('1: 正常完了後に msPerChar が元値へ復元される', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    internals(r).dialogBox.setMsPerChar(30)
    await r.playScript([{ type: 'advance' }])
    expect(getMsPerChar(r)).toBe(30)
  })

  it('2: 再生中（wait await 中）は msPerChar=0 になっている', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_SINGLE)
    internals(r).dialogBox.setMsPerChar(50)

    const p = r.playScript([{ type: 'wait', ms: 100 }, { type: 'advance' }])
    // wait の await で停止している間: msPerChar は退避され 0 になっているはず
    await Promise.resolve()
    expect(getMsPerChar(r)).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    await p
    expect(getMsPerChar(r)).toBe(50)
  })

  it('3: 例外発生時も finally で元 msPerChar へ復元される', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    internals(r).dialogBox.setMsPerChar(40)
    // advance を spy で throw させる
    vi.spyOn(internals(r), 'advance').mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(r.playScript([{ type: 'advance' }])).rejects.toThrow('boom')
    expect(getMsPerChar(r)).toBe(40)
  })

  it('#366: scene 既読は本文開始時ではなく Choice 到達時に立つ', () => {
    const docKey = 'novel-renderer-read-completion-test'
    const r = makeRenderer([
      scene('cell', [
        narration('body'),
        { Choice: { options: [{ text: '戻る', jump: 'hub' }] } } as Event,
      ]),
      scene('hub', [narration('hub')]),
    ])
    internals(r).choiceOverlay.show = vi.fn()
    r.setDocKey(docKey)

    expect(loadReadSceneProgress(docKey).has('cell')).toBe(false)

    internals(r).advance()

    expect(loadReadSceneProgress(docKey).has('cell')).toBe(true)
  })

  it('#366: Choice が無い scene はスクリプト末尾到達時に既読になる', () => {
    const docKey = 'novel-renderer-read-completion-test'
    const r = makeRenderer([scene('ending', [narration('body')])])
    r.setDocKey(docKey)

    expect(loadReadSceneProgress(docKey).has('ending')).toBe(false)

    internals(r).advance()

    expect(loadReadSceneProgress(docKey).has('ending')).toBe(true)
  })

  it('4: 元 msPerChar が 0 のときも復元値 0（破壊しない）', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    internals(r).dialogBox.setMsPerChar(0)
    await r.playScript([{ type: 'advance' }])
    expect(getMsPerChar(r)).toBe(0)
  })

  // ===== B. 再入ガード =====

  it('5: wait 待機中に2本目の playScript を呼ぶと throw する', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_SINGLE)

    const first = r.playScript([{ type: 'wait', ms: 100 }])
    await Promise.resolve()
    // 1本目が wait 中（isReplaying=true）に2本目を呼ぶ
    await expect(r.playScript([{ type: 'advance' }])).rejects.toThrow(
      'playScript is already running'
    )

    await vi.advanceTimersByTimeAsync(100)
    await first
  })

  it('6: 正常完了後は再度 playScript を呼べる（isReplaying が戻っている）', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    await r.playScript([{ type: 'advance' }])
    expect(internals(r).isReplaying).toBe(false)
    // 2本目が throw せず完了する
    await expect(r.playScript([{ type: 'advance' }])).resolves.toBeUndefined()
  })

  // ===== C. advance =====

  it('7: advance 1件で textIndex が1つ進む', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    const before = r.getDebugState()
    expect(before.eventIndex).toBe(0)
    await r.playScript([{ type: 'advance' }])
    const after = r.getSnapshot()
    // narration（行1/行2/行3）の途中: 同イベント内で textIndex が進む
    expect(after.eventIndex).toBe(0)
    expect(after.textIndex).toBe(1)
  })

  it('8: advance 複数件で複数行/イベントを進む', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    // narration は 行1/行2/行3 の 3 行。advance 3 回で次イベント(Dialog index 1)へ進み、
    // 4 回目で Dialog の textIndex が 1 に進む。
    await r.playScript([
      { type: 'advance' },
      { type: 'advance' },
      { type: 'advance' },
      { type: 'advance' },
    ])
    const s = r.getSnapshot()
    expect(s.eventIndex).toBe(1) // Dialog イベントに到達
    expect(s.textIndex).toBe(1) // Dialog の 2 行目を表示中
  })

  it('9: シーン末尾を超過する advance でも例外を投げない（no-op / onEnd）', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    const onEnd = vi.fn()
    r.onEnd(onEnd)
    // narration 3行 + dialog 2行 = 5 行ぶん + 末尾超過ぶん多めに送る
    const steps: Step[] = Array.from({ length: 10 }, () => ({ type: 'advance' as const }))
    await expect(r.playScript(steps)).resolves.toBeUndefined()
    expect(onEnd).toHaveBeenCalled()
  })

  // ===== D. choice =====

  it('10: choice で waitingForChoice=false にリセットされ jump 先へ遷移する', async () => {
    const r = makeRenderer(SCENES_BRANCH)
    await r.playScript([{ type: 'choice', jump: 'left' }])
    expect(r.getCurrentSceneId()).toBe('left')
    expect(internals(r).waitingForChoice).toBe(false)
  })

  it('11: choice 直後に advance を続けても抑制されない（justSelectedChoice 残留なし, #211 退行ガード）', async () => {
    const r = makeRenderer(SCENES_BRANCH)
    // left は narration 1件のみ。choice 後の advance が効けば onEnd に到達する
    const onEnd = vi.fn()
    r.onEnd(onEnd)
    await r.playScript([{ type: 'choice', jump: 'left' }, { type: 'advance' }])
    expect(internals(r).justSelectedChoice).toBe(false)
    // advance が抑制されていなければ末尾 narration を送り終え onEnd 発火
    expect(onEnd).toHaveBeenCalled()
    expect(r.getCurrentSceneId()).toBe('left')
  })

  it('12: 存在しない jump の choice は currentSceneId を変えず後続 step を継続する（warn は出るが例外なし）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES_BRANCH)
    expect(r.getCurrentSceneId()).toBe('start')
    await expect(
      r.playScript([{ type: 'choice', jump: 'nonexistent' }, { type: 'advance' }])
    ).resolves.toBeUndefined()
    // jumpToScene の既存挙動: console.warn + no-op、currentSceneId は変わらない
    expect(r.getCurrentSceneId()).toBe('start')
    expect(warnSpy).toHaveBeenCalled()
  })

  // ===== E. wait（fake timers） =====

  it('13: wait は指定 ms 待ってから次 step へ進む', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_SINGLE)
    const advanceSpy = vi.spyOn(internals(r), 'advance')

    const p = r.playScript([{ type: 'wait', ms: 200 }, { type: 'advance' }])
    await Promise.resolve()
    // まだ 200ms 経っていないので advance は呼ばれていない
    expect(advanceSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(advanceSpy).toHaveBeenCalledTimes(1)
  })

  it('14: wait ms=0 でも解決して後続 step を実行する', async () => {
    const r = makeRenderer(SCENES_SINGLE)
    const advanceSpy = vi.spyOn(internals(r), 'advance')
    await r.playScript([{ type: 'wait', ms: 0 }, { type: 'advance' }])
    expect(advanceSpy).toHaveBeenCalledTimes(1)
  })

  // ===== F. 空・組み合わせ・ログ =====

  it('15: playScript([]) は副作用なし（state 不変・msPerChar 元値・warn/error なし）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = makeRenderer(SCENES_SINGLE)
    internals(r).dialogBox.setMsPerChar(25)
    const before = r.getSnapshot()

    await r.playScript([])

    expect(r.getSnapshot()).toEqual(before)
    expect(getMsPerChar(r)).toBe(25)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('16: advance→choice→advance 混在列で getSnapshot が決定論的（同入力→同結果）', async () => {
    const steps: Step[] = [
      { type: 'advance' },
      { type: 'choice', jump: 'right' },
      { type: 'advance' },
    ]
    const r1 = makeRenderer(SCENES_BRANCH)
    await r1.playScript(steps)
    const snap1 = r1.getSnapshot()

    const r2 = makeRenderer(SCENES_BRANCH)
    await r2.playScript(steps)
    const snap2 = r2.getSnapshot()

    expect(snap2).toEqual(snap1)
    expect(snap1.sceneId).toBe('right')
  })

  it('17: 正常 playScript 実行中に console.warn / console.error を呼ばない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = makeRenderer(SCENES_BRANCH)
    await r.playScript([{ type: 'advance' }, { type: 'choice', jump: 'left' }, { type: 'advance' }])
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
