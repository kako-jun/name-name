/**
 * NovelRenderer.startFrom(opts) のテスト (#220 Phase 2)。
 *
 * sceneId / flags / eventIndex / textIndex を直接指定して任意の状態から
 * シーンを開始するデバッグ API の検証。playScript.test.ts と同じく
 * `new NovelRenderer()` → `setScenes(...)` → `startFrom(...)` の最小構成で行い、
 * 描画・PixiJS 実描画は対象外（CLAUDE.md ルール7 の実機 golden path に委ねる）。
 *
 * 検証は getSnapshot() / getDebugState() / getCurrentSceneId() / 内部アクセサ
 * （history・waitTimer 等）で行う。背景アセットを伴うシーンは避け、
 * Narration / Dialog / Condition / Flag 中心の最小 fixture を使う。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { StartFromOptions } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'

// --- fixture helpers（playScript.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function dialog(character: string, ...lines: string[]): Event {
  return { Dialog: { character, expression: null, position: null, text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function condition(flag: string, events: Event[]): Event {
  return { Condition: { flag, events } }
}

const boolFlag = (b: boolean): FlagValue => ({ Bool: b })

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** startFrom 検証用に到達したい内部状態へのアクセサ */
interface RendererInternals {
  eventIndex: number
  textIndex: number
  resolvedEvents: Event[]
  history: unknown[]
  waitingForChoice: boolean
  waitingForWait: boolean
  waitTimer: number | null
  advance(): void
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

const SCENES: EventScene[] = [
  scene('start', [narration('行1', '行2', '行3'), dialog('A', 'せりふ1', 'せりふ2')]),
  scene('left', [narration('左1', '左2')]),
  scene('right', [narration('右1')]),
]

// flag 依存 Condition を含むシーン群（resolvedEvents が flag で伸縮する）
const SCENES_COND: EventScene[] = [
  scene('cond', [
    narration('共通1'),
    condition('seen', [narration('分岐1'), narration('分岐2')]),
    narration('共通2'),
  ]),
]

// Choice を含むシーン（playScript で waitingForChoice=true を作る用）
const SCENES_CHOICE: EventScene[] = [
  scene('start', [
    narration('intro'),
    {
      Choice: {
        options: [
          { text: '左へ', jump: 'left' },
          { text: '右へ', jump: 'right' },
        ],
      },
    } as Event,
  ]),
  scene('left', [narration('左1')]),
  scene('right', [narration('右1')]),
]

// Wait を含むシーン（playScript で waitingForWait=true を作る用）
const SCENES_WAIT: EventScene[] = [
  scene('start', [narration('intro'), { Wait: { ms: 100000 } } as Event, narration('after')]),
]

describe('NovelRenderer.startFrom (#220)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ===== A. 正常系 =====

  it('1: sceneId のみ → currentSceneId 一致 & eventIndex/textIndex=0', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'left' })
    expect(r.getCurrentSceneId()).toBe('left')
    const s = r.getSnapshot()
    expect(s.eventIndex).toBe(0)
    expect(s.textIndex).toBe(0)
  })

  it('2: eventIndex 指定が反映される', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', eventIndex: 1 })
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('3: textIndex 指定が反映される', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', textIndex: 2 })
    expect(r.getSnapshot().textIndex).toBe(2)
  })

  it('4: eventIndex/textIndex 両方の指定が反映される', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', eventIndex: 1, textIndex: 1 })
    const s = r.getSnapshot()
    expect(s.eventIndex).toBe(1)
    expect(s.textIndex).toBe(1)
  })

  it('5: flags 指定 → getSnapshot().flags が一致する', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', flags: { seen: boolFlag(true), score: { Number: 7 } } })
    expect(r.getSnapshot().flags).toEqual({ seen: boolFlag(true), score: { Number: 7 } })
  })

  // ===== B. flags 置換（merge でない） =====

  it('6: 事前 flags → 別キーで startFrom → 前キーが消える（置換）', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', flags: { old: boolFlag(true) } })
    r.startFrom({ sceneId: 'start', flags: { fresh: boolFlag(true) } })
    expect(r.getSnapshot().flags).toEqual({ fresh: boolFlag(true) })
  })

  it('7: 事前 flags → flags 省略で startFrom → 空にクリアされる', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', flags: { old: boolFlag(true) } })
    r.startFrom({ sceneId: 'start' })
    expect(r.getSnapshot().flags).toEqual({})
  })

  it('8: flags={} は省略と同値（空クリア）', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', flags: { old: boolFlag(true) } })
    r.startFrom({ sceneId: 'start', flags: {} })
    expect(r.getSnapshot().flags).toEqual({})
  })

  // ===== C. デフォルト =====

  it('9: flags 省略 → {}', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start' })
    expect(r.getSnapshot().flags).toEqual({})
  })

  it('10: eventIndex 省略 → 0', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', textIndex: 1 })
    expect(r.getSnapshot().eventIndex).toBe(0)
  })

  it('11: textIndex 省略 → 0', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', eventIndex: 1 })
    expect(r.getSnapshot().textIndex).toBe(0)
  })

  // ===== D. 異常系（完全 no-op） =====

  it('12: 不正 sceneId → console.warn が呼ばれる', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'nonexistent' })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('13: 不正 sceneId → currentSceneId は不変', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    const before = r.getCurrentSceneId()
    r.startFrom({ sceneId: 'nonexistent' })
    expect(r.getCurrentSceneId()).toBe(before)
  })

  it('14: 不正 sceneId → flags も index も history も一切変わらない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    // 事前に startFrom で確定した状態を作る
    r.startFrom({ sceneId: 'start', eventIndex: 1, textIndex: 1, flags: { keep: boolFlag(true) } })
    const snapBefore = r.getSnapshot()
    const sceneBefore = r.getCurrentSceneId()
    const historyLenBefore = internals(r).history.length

    r.startFrom({ sceneId: 'does-not-exist', flags: { wiped: boolFlag(true) } })

    // 完全 no-op: snapshot / sceneId / history すべて不変
    expect(r.getSnapshot()).toEqual(snapBefore)
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(internals(r).history.length).toBe(historyLenBefore)
    expect(r.getSnapshot().flags).toEqual({ keep: boolFlag(true) })
  })

  // ===== E. Condition 展開 =====

  it('15: Condition 含むシーンで flag=true → eventCount が展開後件数', () => {
    const r = makeRenderer(SCENES_COND)
    r.startFrom({ sceneId: 'cond', flags: { seen: boolFlag(true) } })
    // 共通1 + (分岐1 + 分岐2) + 共通2 = 4 件
    expect(r.getDebugState().eventCount).toBe(4)
  })

  it('16: flag=false → Condition 内が除外される', () => {
    const r = makeRenderer(SCENES_COND)
    r.startFrom({ sceneId: 'cond', flags: { seen: boolFlag(false) } })
    // 共通1 + 共通2 = 2 件（Condition 内は展開されない）
    expect(r.getDebugState().eventCount).toBe(2)
  })

  it('17: flag 有無で eventCount に差が出る（true > false）', () => {
    const rTrue = makeRenderer(SCENES_COND)
    rTrue.startFrom({ sceneId: 'cond', flags: { seen: boolFlag(true) } })

    const rNone = makeRenderer(SCENES_COND)
    rNone.startFrom({ sceneId: 'cond' }) // flag 未指定 → false 扱い

    expect(rTrue.getDebugState().eventCount).toBeGreaterThan(rNone.getDebugState().eventCount)
  })

  // ===== F. 状態遷移 =====

  it('18: choice 待機中 → startFrom 後 waitingForChoice=false', () => {
    const r = makeRenderer(SCENES_CHOICE)
    // Choice 到達状態を直接作る。playScript 経由だと ChoiceOverlay.show が
    // AudioManager.ensureContext() を呼び、init() 未実行の jsdom には AudioContext が
    // 無いため落ちる（startFrom のリセット責務とは無関係な環境制約）。
    internals(r).waitingForChoice = true
    expect(internals(r).waitingForChoice).toBe(true)

    r.startFrom({ sceneId: 'left' })
    expect(internals(r).waitingForChoice).toBe(false)
  })

  it('19: wait 待機中 → startFrom 後 waitingForWait=false & waitTimer=null', () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_WAIT)
    // intro → advance で Wait に到達し waitingForWait=true / waitTimer がセットされる
    internals(r).advance()
    expect(internals(r).waitingForWait).toBe(true)
    expect(internals(r).waitTimer).not.toBeNull()

    r.startFrom({ sceneId: 'start' })
    expect(internals(r).waitingForWait).toBe(false)
    expect(internals(r).waitTimer).toBeNull()
  })

  it('20: wait 待機中に startFrom → その後 timer を進めても旧 wait の advance が発火しない', () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_WAIT)
    internals(r).advance()
    expect(internals(r).waitingForWait).toBe(true)

    r.startFrom({ sceneId: 'start' })
    const afterStart = r.getSnapshot()

    // 旧 wait のタイマーがクリアされていれば、時間を進めても進行は起きない
    vi.advanceTimersByTime(200000)
    expect(r.getSnapshot()).toEqual(afterStart)
    expect(internals(r).waitingForWait).toBe(false)
  })

  // ===== G. history =====

  it('21: 複数 advance 後 startFrom → history.length === 1', async () => {
    const r = makeRenderer(SCENES)
    await r.playScript([{ type: 'advance' }, { type: 'advance' }, { type: 'advance' }])
    expect(internals(r).history.length).toBeGreaterThan(1)

    r.startFrom({ sceneId: 'left' })
    expect(internals(r).history.length).toBe(1)
  })

  it('22: history[0] が startFrom 現在状態（getSnapshot）と一致する', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', eventIndex: 1, textIndex: 1, flags: { x: boolFlag(true) } })
    expect(internals(r).history[0]).toEqual(r.getSnapshot())
  })

  // ===== H. ログ =====

  it('23: 正常 startFrom で warn/error を呼ばない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start', eventIndex: 1, flags: { ok: boolFlag(true) } })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // ===== I. 決定論 =====

  it('24: 同一 opts を2 renderer で startFrom → getSnapshot 一致', () => {
    const opts: StartFromOptions = {
      sceneId: 'start',
      eventIndex: 1,
      textIndex: 1,
      flags: { seen: boolFlag(true), n: { Number: 3 } },
    }
    const r1 = makeRenderer(SCENES)
    r1.startFrom(opts)
    const r2 = makeRenderer(SCENES)
    r2.startFrom(opts)
    expect(r2.getSnapshot()).toEqual(r1.getSnapshot())
  })

  // ===== J. 境界 =====

  it('25: eventIndex に resolvedEvents.length 超過を指定 → 例外を投げない', () => {
    const r = makeRenderer(SCENES)
    const over = internals(r).resolvedEvents.length + 100
    expect(() => r.startFrom({ sceneId: 'start', eventIndex: over })).not.toThrow()
  })
})
