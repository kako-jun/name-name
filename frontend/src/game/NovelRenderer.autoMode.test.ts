/**
 * NovelRenderer の `setAutoMode` 会話中トグル即時反映テスト (#302)。
 *
 * 症状: `onTypingDone` は render()（setDialog / setNovelDialogProgressive 呼び出し時）に
 * `this.autoMode ? ()=>scheduleAutoAdvance() : null` で**その時点の autoMode で確定**する。
 * auto OFF で描画された行は callback=null。よって会話中に auto を ON にしただけでは—
 *   - 現在行が**タイプ完了済み**なら onTypingDone は再発火せず、
 *   - 現在行が**タイプ中**でも onTypingDone は null のまま、
 * どちらも自動送りが始まらず、待てずに手動送りすると #139「手動操作で auto OFF」で解除される。
 *
 * 修正: setAutoMode(true) かつ choice/wait 待機でなく スクリプト末尾でないとき、DialogBox の
 * onTypingDone を **live で張り替える**（`dialogBox.setOnTypingDone(()=>scheduleAutoAdvance())`）。
 *   - タイプ中なら、その行の完了時に scheduleAutoAdvance が発火する（DialogBox 側 ticker 経由）。
 *   - 完了済みなら setOnTypingDone がその場で 1 回だけ scheduleAutoAdvance を呼ぶ。
 * auto OFF で onTypingDone を解除する（OFF 中の完了で誤進行しない）。
 *
 * 駆動方式（既存 NovelRenderer.*.test.ts と同形）:
 *   `new NovelRenderer()` → `setDialogStyle(...)` / `setScenes(...)` の最小構成（init は呼ばない）。
 *   private `scheduleAutoAdvance` を vi.spyOn で観測する（実 setTimeout/advance は走らせない）。
 *   `dialogBox.setOnTypingDone` を spy して live 張り替えの呼び出し・解除を観測し、タイプ中ケースは
 *   捕捉した callback を手で呼んで「typewriter 完了 → 実発火」をシミュレートする（test(b) の偽安心解消）。
 *   jsdom（CLAUDE.md ルール7）で観測可能な状態遷移のみを縛る。
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

interface DialogBoxObservable {
  isTyping(): boolean
  novelMaxLinesPerPage(): number
  setOnTypingDone(cb: (() => void) | null): void
}

interface AutoModeInternals {
  scheduleAutoAdvance(): void
  dialogBox: DialogBoxObservable
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

/** scheduleAutoAdvance を spy で差し替える（実タイマー/advance は走らせない）。 */
function spyScheduler(r: NovelRenderer) {
  return vi.spyOn(internals(r), 'scheduleAutoAdvance').mockImplementation(() => {})
}

/**
 * DialogBox.setOnTypingDone を spy で差し替え、現在行のタイプ状態を `typing` で固定する。
 * - typing=false（完了済み）: 実装の即時 done と同じく、渡された cb をその場で 1 回呼ぶ。
 * - typing=true（タイプ中）  : cb を保持するだけ（後で手動 fire して完了をシミュレート）。
 * 返り値: spy 本体と「最後に保持した onTypingDone」を取り出す getter。
 */
function spyOnTypingDone(r: NovelRenderer, typing: boolean) {
  let pending: (() => void) | null = null
  const spy = vi
    .spyOn(internals(r).dialogBox, 'setOnTypingDone')
    .mockImplementation((cb: (() => void) | null) => {
      pending = cb
      // 完了済み行に張り替えたら実装と同様その場で 1 回だけ消費する。
      if (cb && !typing) {
        pending = null
        cb()
      }
    })
  return {
    spy,
    /** タイプ中ケース用: 保持中の onTypingDone を手で発火し（= typewriter 完了）、消費する。 */
    fireTypingDone() {
      const cb = pending
      pending = null
      cb?.()
    },
    hasPending: () => pending !== null,
  }
}

describe('NovelRenderer setAutoMode 会話中トグル即時反映 (#302)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // a) タイプ完了済みで ON → live 張り替えがその場で scheduleAutoAdvance を呼ぶ（即時オート開始）。
  it('タイプ完了済み・末尾でない位置で ON にすると即 scheduleAutoAdvance を呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    const sched = spyScheduler(r)
    spyOnTypingDone(r, false) // 完了済み
    r.setAutoMode(true)
    expect(sched).toHaveBeenCalledTimes(1)
    expect(r.isAutoMode()).toBe(true)
  })

  // b) タイプ中に ON → setAutoMode 内では発火しないが、onTypingDone が live で張り替わる。
  //    その後 typewriter 完了をシミュレートしたら scheduleAutoAdvance が**実際に**発火する。
  //    （レビュー指摘「test(b) が偽の安心」の解消: OFF で描画→タイプ中 ON→完了→発火 を縛る。）
  it('タイプ中に ON → onTypingDone が張り替わり、完了で scheduleAutoAdvance が実発火する', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    const sched = spyScheduler(r)
    const td = spyOnTypingDone(r, true) // タイプ中（張り替えは保持のみ）
    r.setAutoMode(true)
    // setAutoMode 内ではまだ発火しない（タイプ完了を待つ）。
    expect(sched).not.toHaveBeenCalled()
    // だが onTypingDone は live で張り替えられている（auto OFF で null だった行に cb が入る）。
    expect(td.spy).toHaveBeenCalledTimes(1)
    expect(td.spy).toHaveBeenLastCalledWith(expect.any(Function))
    expect(td.hasPending()).toBe(true)
    // typewriter 完了をシミュレート → scheduleAutoAdvance が実際に発火する。
    td.fireTypingDone()
    expect(sched).toHaveBeenCalledTimes(1)
    expect(r.isAutoMode()).toBe(true)
  })

  // b') 二重発火しない: 完了で 1 回発火した後、もう一度 fire しても増えない（onTypingDone は消費済み）。
  it('タイプ中 ON → 完了発火は 1 回だけ（二重発火しない）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    const sched = spyScheduler(r)
    const td = spyOnTypingDone(r, true)
    r.setAutoMode(true)
    td.fireTypingDone()
    td.fireTypingDone() // 既に消費済み → no-op
    expect(sched).toHaveBeenCalledTimes(1)
  })

  // OFF: auto を OFF にしたら onTypingDone を解除する（OFF 中の完了で誤進行しない）。
  it('auto OFF で setOnTypingDone(null) を呼んで onTypingDone を解除する', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    spyScheduler(r) // 先に ON する前に実タイマーを張らせない
    r.setAutoMode(true) // 先に ON（実 dialogBox に張り替わる）
    const spy = vi.spyOn(internals(r).dialogBox, 'setOnTypingDone')
    r.setAutoMode(false)
    expect(spy).toHaveBeenCalledWith(null)
    expect(r.isAutoMode()).toBe(false)
  })

  // c) choice 待ち中に ON → 張り替えもしない（進める先がない）。
  it('choice 待ち中に ON にしても setOnTypingDone/scheduleAutoAdvance を呼ばない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    internals(r).waitingForChoice = true
    const sched = spyScheduler(r)
    const td = spyOnTypingDone(r, false)
    r.setAutoMode(true)
    expect(sched).not.toHaveBeenCalled()
    expect(td.spy).not.toHaveBeenCalled()
  })

  // c') wait 待ち中に ON → 張り替えもしない。
  it('wait 待ち中に ON にしても setOnTypingDone/scheduleAutoAdvance を呼ばない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    internals(r).waitingForWait = true
    const sched = spyScheduler(r)
    const td = spyOnTypingDone(r, false)
    r.setAutoMode(true)
    expect(sched).not.toHaveBeenCalled()
    expect(td.spy).not.toHaveBeenCalled()
  })

  // d) スクリプト末尾（最後のイベント・最後のページ）で ON → 張り替えもしない（advance しても進まない）。
  it('スクリプト末尾で ON にしても setOnTypingDone/scheduleAutoAdvance を呼ばない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('唯一の行。')])]) // 単一イベント・1 行 → 末尾
    expect(internals(r).isAtScriptEnd()).toBe(true) // 前提
    const sched = spyScheduler(r)
    const td = spyOnTypingDone(r, false)
    r.setAutoMode(true)
    expect(sched).not.toHaveBeenCalled()
    expect(td.spy).not.toHaveBeenCalled()
    expect(r.isAutoMode()).toBe(true) // 状態自体は ON になる
  })

  // 同値 no-op: 既に ON のとき再 ON は何もしない（#139 の早期 return）。
  it('既に ON のとき再 ON は no-op（張り替えも発火もしない）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('一行目。'), narration('二行目。')])])
    spyScheduler(r) // 1 回目の ON で実タイマーを張らせない
    r.setAutoMode(true) // 1 回目
    const spy = vi.spyOn(internals(r).dialogBox, 'setOnTypingDone')
    r.setAutoMode(true) // 同値 → 早期 return
    expect(spy).not.toHaveBeenCalled()
  })

  // adv 非回帰: adv 既定でも末尾でない位置で ON すると即発火（live 張り替えで完了済み→即）。
  it('adv（既定スタイル）でも末尾でない位置で ON すると即 scheduleAutoAdvance を呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('行1', '行2'), narration('行3')])])
    expect(internals(r).isNovelStyle()).toBe(false)
    const sched = spyScheduler(r)
    spyOnTypingDone(r, false)
    r.setAutoMode(true)
    expect(sched).toHaveBeenCalledTimes(1)
  })

  // novel 文単位: ページ途中の文で ON → 末尾でないので即発火する（#292 連動）。
  it('novel: ページ途中の文で ON すると即 scheduleAutoAdvance を呼ぶ（末尾でない）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    const cap = internals(r).dialogBox.novelMaxLinesPerPage()
    const text = Array.from({ length: cap + 1 }, (_, k) => `${k + 1}。`).join('') // cap+1 文 → 2 ページ
    r.setScenes([scene('s', [narration(text)])])
    internals(r).sentenceIndex = 0
    internals(r).textIndex = 0
    expect(internals(r).isAtScriptEnd()).toBe(false)
    const sched = spyScheduler(r)
    spyOnTypingDone(r, false)
    r.setAutoMode(true)
    expect(sched).toHaveBeenCalledTimes(1)
  })
})
