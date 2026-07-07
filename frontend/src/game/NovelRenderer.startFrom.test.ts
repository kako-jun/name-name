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
import type { NovelGameState, StartFromOptions } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'

// --- fixture helpers（playScript.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function dialog(character: string, ...lines: string[]): Event {
  return { Dialog: { character, expression: null, position: null, text: lines } }
}

/** 立ち絵付き Dialog（character + expression + position が全て埋まる → 立ち絵が載る）(#399)。 */
function dialogWithPortrait(
  character: string,
  expression: string,
  position: string,
  ...lines: string[]
): Event {
  return { Dialog: { character, expression, position, text: lines } }
}

function background(path: string): Event {
  return { Background: { path } }
}

function bgm(path: string): Event {
  return { Bgm: { path, action: 'Play' } }
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
  applyState(state: NovelGameState): void
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

// #399 冒頭ディレクティブ実行用: [背景:] → [BGM:] → 最初の Dialog。
// fresh-start 経路（eventIndex=0）は resetAndStartEvents → processUntilNextTextEvent が
// 冒頭の Background / Bgm を最初のテキストまで実行するため、開始直後に背景/BGM が state に立つ。
const SCENES_INTRO_DIRECTIVES: EventScene[] = [
  scene('intro', [background('room.png'), bgm('theme.mp3'), dialog('A', 'おはよう')]),
]

// #399 立ち絵表示用: 最初の Dialog が character+expression+position を全て持つ。
const SCENES_PORTRAIT: EventScene[] = [
  scene('stage', [dialogWithPortrait('ヒロイン', 'smile', 'center', 'こんにちは')]),
]

// #399 DEV回帰用: 冒頭に [背景:] を持つシーン。eventIndex 指定の有無で経路が分岐する
// （0 → fresh-start で背景を実行 / >0 → restoreToScene で宣言的復元・冒頭ディレクティブ不実行）。
const SCENES_BG_THEN_DIALOG: EventScene[] = [
  scene('bg', [background('sky.png'), dialog('A', 'ここ')]),
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

  // ===== K. 終劇状態 (#386) =====

  it('28: startFrom 開始直後は getSnapshot().storyEnded === false', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'start' })
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('29: storyEnded=true を含む NovelGameState を applyState 直接キャストで復元すると true になり callback が発火する（本番導線には無い経路。goBack/seekTo/セーブ復元は通常のシーン遷移か quickLoad 経由でしか applyState を呼ばず、いずれも storyEnded=false のスナップショット/セーブしか渡さない）', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)
    r.startFrom({ sceneId: 'start' })
    const endedState: NovelGameState = { ...r.getSnapshot(), storyEnded: true }

    internals(r).applyState(endedState)

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(cb).toHaveBeenCalledWith(true)
  })
})

// ===================================================================================
// #399: 埋め込み開始（`?scene=` deep-link, eventIndex=0）の fresh-start 経路
// ===================================================================================
//
// 本番の `?scene=` 単独埋め込みは常に eventIndex=0 で startFrom する。この経路を通常入場
// （jumpToScene → startScene → resetAndStartEvents）と揃え、冒頭の [背景:]/[BGM:] を実行し
// 最初の話者の立ち絵を載せる（従来の restoreToScene 宣言的復元は冒頭ディレクティブを実行せず、
// 背景も立ち絵も出ず eventIndex=0 で止まっていた ＝ #399 の症状）。
//
// index 指定あり（DEV の debug_scene）は従来どおり restoreToScene にフォールバックする。
// 背景アセットの実ロード（WebGL）は jsdom 対象外だが、backgroundPath / currentBgmPath /
// characters は Assets.load を待たず同期で確定するフィールドなので、これらの state が
// 「開始直後に立つ」ことだけを検証する（実描画は CLAUDE.md ルール7 の実機 golden path に委ねる）。

describe('NovelRenderer.startFrom fresh-start 経路 (#399)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ===== 1. 冒頭ディレクティブ（背景 / BGM）が開始直後に実行される =====

  it('399-1: 先頭が [背景:]→[BGM:]→Dialog のシーンを startFrom すると、backgroundPath / currentBgmPath が開始直後に立ち、eventIndex が最初のテキスト（Dialog）まで進む', () => {
    const r = makeRenderer(SCENES_INTRO_DIRECTIVES)
    r.startFrom({ sceneId: 'intro' })

    const s = r.getSnapshot()
    // 冒頭の Background / Bgm ディレクティブが fresh-start で実行され、state に立っている。
    expect(s.backgroundPath).toBe('room.png')
    expect(s.currentBgmPath).toBe('theme.mp3')
    // eventIndex は 2 つの冒頭ディレクティブを越え、最初のテキストイベント（Dialog, index 2）に到達。
    expect(s.eventIndex).toBe(2)
    expect(s.storyEnded).toBe(false)
  })

  // ===== 2. 最初の話者の立ち絵が開始直後に characters に載る =====

  it('399-2: 最初の Dialog が character+expression+position を持つシーンを startFrom すると、その 1 体が characters に載る', () => {
    const r = makeRenderer(SCENES_PORTRAIT)
    r.startFrom({ sceneId: 'stage' })

    // CharacterLayer.show は sprite を同期生成して Map に登録する（テクスチャ実ロードは待たない）。
    // getSnapshot().characters は Map から renderOnly/退場中を除いて返すので、開始直後に 1 体入る。
    const chars = r.getSnapshot().characters
    expect(chars).toHaveLength(1)
    expect(chars[0]).toMatchObject({ name: 'ヒロイン', expression: 'smile', position: 'center' })
  })

  // ===== 3. fresh-start（index=0）は冒頭ディレクティブを実行、DEV（index>0）は restoreToScene で不実行 =====

  it('399-3: 同じシーンでも eventIndex=0 は冒頭 [背景:] を実行し、eventIndex 指定ありは restoreToScene 経路（冒頭ディレクティブ不実行）に分岐する', () => {
    // fresh-start（index 省略 = 0）: 冒頭 Background を実行 → backgroundPath が立ち、Dialog(index 1) まで進む。
    const rFresh = makeRenderer(SCENES_BG_THEN_DIALOG)
    rFresh.startFrom({ sceneId: 'bg' })
    const fresh = rFresh.getSnapshot()
    expect(fresh.backgroundPath).toBe('sky.png')
    expect(fresh.eventIndex).toBe(1)

    // DEV（eventIndex=1 指定）: restoreToScene の宣言的復元。冒頭 Background は実行されないため
    // backgroundPath は null のまま、eventIndex は指定値 1 が保たれる（fresh reset されない）。
    const rDev = makeRenderer(SCENES_BG_THEN_DIALOG)
    rDev.startFrom({ sceneId: 'bg', eventIndex: 1 })
    const dev = rDev.getSnapshot()
    expect(dev.backgroundPath).toBeNull()
    expect(dev.eventIndex).toBe(1)
  })
})
