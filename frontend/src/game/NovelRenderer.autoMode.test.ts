/**
 * NovelRenderer の `setAutoMode` 会話中トグル即時反映テスト (#302)。
 *
 * 症状: 会話中に A（オート）を ON にしても、現在行が既にタイプ完了済みだと
 * `onTypingDone`→`scheduleAutoAdvance` が再発火せず、その場ではオートにならない。待てずに
 * 手動送りすると #139「手動操作で auto OFF」で解除されてしまう。
 *
 * 修正: setAutoMode(true) かつ「タイプ完了済み・choice/wait 待機でない・スクリプト末尾でない」
 * のときは setAutoMode 内で直接 scheduleAutoAdvance() を呼んでその場でオートを開始する。
 * タイプ中に ON にした場合は従来どおり onTypingDone 経由で発火する（二重発火しない）。
 *
 * 駆動方式（既存 NovelRenderer.*.test.ts と同形）:
 *   `new NovelRenderer()` → `setDialogStyle(...)` / `setScenes(...)` の最小構成（init は呼ばない）。
 *   private `scheduleAutoAdvance` を vi.spyOn で観測する（実 setTimeout/advance は走らせない）。
 *   `dialogBox.isTyping()` / `waitingForChoice` / `waitingForWait` / `sentenceIndex` を直接
 *   操作して各局面を作る。jsdom（CLAUDE.md ルール7）で観測可能な状態遷移のみを縛る。
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

interface AutoModeInternals {
  scheduleAutoAdvance(): void
  dialogBox: { isTyping(): boolean; novelMaxLinesPerPage(): number }
  waitingForChoice: boolean
  waitingForWait: boolean
  sentenceIndex: number
  textIndex: number
  eventIndex: number
  isAtScriptEnd(): boolean
  isNovelStyle(): boolean
}

function internals(r: NovelRenderer): AutoModeInternals {
  return r as unknown as AutoModeInternals
}

/** scheduleAutoAdvance を spy で差し替えた renderer を返す（実タイマーは張らない）。 */
function spyScheduler(r: NovelRenderer) {
  return vi.spyOn(internals(r), 'scheduleAutoAdvance').mockImplementation(() => {})
}

/** isTyping を固定値にする（タイプ中 / 完了済みを作る）。 */
function stubTyping(r: NovelRenderer, typing: boolean) {
  vi.spyOn(internals(r).dialogBox, 'isTyping').mockReturnValue(typing)
}

describe('NovelRenderer setAutoMode 会話中トグル即時反映 (#302)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // a) タイプ完了済みで ON → その場で scheduleAutoAdvance が呼ばれる（即時オート開始）。
  it('タイプ完了済み・末尾でない位置で ON にすると即 scheduleAutoAdvance を呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    // 末尾でない: 2 イベントの先頭にいる（eventIndex=0）。
    stubTyping(r, false)
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(r.isAutoMode()).toBe(true)
  })

  // b) タイプ中に ON → ここでは呼ばず、onTypingDone 経由（二重発火防止）。
  it('タイプ中に ON にしても setAutoMode 内では scheduleAutoAdvance を呼ばない（onTypingDone 経由）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    stubTyping(r, true) // タイプ中
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).not.toHaveBeenCalled()
    expect(r.isAutoMode()).toBe(true)
  })

  // c) choice 待ち中に ON → 呼ばない（進める先がない）。
  it('choice 待ち中に ON にしても scheduleAutoAdvance を呼ばない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    stubTyping(r, false)
    internals(r).waitingForChoice = true
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).not.toHaveBeenCalled()
  })

  // c') wait 待ち中に ON → 呼ばない。
  it('wait 待ち中に ON にしても scheduleAutoAdvance を呼ばない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    stubTyping(r, false)
    internals(r).waitingForWait = true
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).not.toHaveBeenCalled()
  })

  // d) スクリプト末尾（最後のイベント・最後のページ）で ON → 呼ばない（advance しても進まない）。
  it('スクリプト末尾で ON にしても scheduleAutoAdvance を呼ばない', () => {
    const r = new NovelRenderer()
    // 単一イベント・1 行 → eventIndex=0 が末尾。
    r.setScenes([scene('s', [narration('唯一の行。')])])
    stubTyping(r, false)
    expect(internals(r).isAtScriptEnd()).toBe(true) // 前提: ここが末尾
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).not.toHaveBeenCalled()
    expect(r.isAutoMode()).toBe(true) // 状態自体は ON になる
  })

  // 同値 no-op: 既に ON のとき再度 ON は何もしない（#139 の早期 return）。
  it('既に ON のとき再 ON は no-op（scheduleAutoAdvance を呼ばない）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    stubTyping(r, false)
    r.setAutoMode(true) // 1 回目（このとき呼ばれる）
    const spy = spyScheduler(r)
    r.setAutoMode(true) // 同値 → 早期 return
    expect(spy).not.toHaveBeenCalled()
  })

  // adv 非回帰: novel でない既定（adv）でも即時オートは同条件で効く（末尾でなければ ON で開始）。
  it('adv（既定スタイル）でも末尾でない位置で ON すると即 scheduleAutoAdvance を呼ぶ', () => {
    const r = new NovelRenderer()
    // setDialogStyle を呼ばない = adv 相当。複数 text 行で先頭は末尾でない。
    r.setScenes([scene('s', [narration('行1', '行2'), narration('行3')])])
    expect(internals(r).isNovelStyle()).toBe(false)
    stubTyping(r, false)
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // novel 文単位: ページ途中の文で ON → 末尾でないので即発火する（#292 連動）。
  it('novel: ページ途中の文で ON すると即 scheduleAutoAdvance を呼ぶ（末尾でない）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    const cap = internals(r).dialogBox.novelMaxLinesPerPage()
    // cap+1 文 → 2 ページ。ページ 0 の途中（sentenceIndex=0）は末尾でない。
    const text = Array.from({ length: cap + 1 }, (_, k) => `${k + 1}。`).join('')
    r.setScenes([scene('s', [narration(text)])])
    stubTyping(r, false)
    internals(r).sentenceIndex = 0
    internals(r).textIndex = 0
    expect(internals(r).isAtScriptEnd()).toBe(false)
    const spy = spyScheduler(r)
    r.setAutoMode(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
