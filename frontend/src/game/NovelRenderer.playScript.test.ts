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
 *
 * #515: playScript は `wait` step 明け直後に `this.initialized` を確認し、破棄済みなら
 * 以降の step を処理せず抜ける（wait 待機中の destroy() 対策）。この分岐に到達する
 * テスト（wait → advance の並び）だけ、restoreSnapshot.test.ts と同じ `markInitialized`
 * パターンで明示的に true を立てる（そうしないと wait 明けで即 return し、後続 advance が
 * 呼ばれなくなる）。wait を含まないテストは従来どおり `initialized` 未設定（false）のままで
 * 影響を受けない。
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

/** dialogBox の private msPerChar アクセサ（getMsPerChar）に到達するための型 */
interface RendererInternals {
  dialogBox: { getMsPerChar(): number; setMsPerChar(ms: number): void }
  jumpToScene(sceneId: string): void
  advance(): void
  isReplaying: boolean
  justSelectedChoice: boolean
  waitingForChoice: boolean
  choiceOverlay: { show: ReturnType<typeof vi.fn> }
  initialized: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function getMsPerChar(r: NovelRenderer): number {
  return internals(r).dialogBox.getMsPerChar()
}

/**
 * `init()` 完了後の状態を模す（NovelRenderer.restoreSnapshot.test.ts と同じパターン）。
 * wait → advance/choice の並びを検証するテストでのみ使う（#515、上記ファイル doc 参照）。
 */
function markInitialized(r: NovelRenderer): void {
  internals(r).initialized = true
}

/** 単一シーン（ナレーション数行）を持つ renderer を作る */
function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
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

  // #591: 選択肢オプションの条件付きロック。option.condition が未定義/false のフラグを
  // 指しているときだけロックし、choiceOverlay.show へ options と同じ長さ・並びの真偽配列
  // （6番目の引数）として渡す。
  it('#591: condition 付きオプションは flag 未設定なら locked=true で show へ渡される', () => {
    // 先頭に narration を置く: setScenes 内の processUntilNextTextEvent はテキストイベント
    // で止まるため、choiceOverlay.show をモックしてから明示 advance() で Choice へ進める
    // （#366 の既存テストと同じパターン。narration 無しだと構築中に本物の show が先に
    // 呼ばれてしまい、後からのモック差し替えで見えなくなる）。
    const r = makeRenderer([
      scene('cell', [
        narration('body'),
        {
          Choice: {
            options: [
              { text: '誰でも選べる', jump: 'hub' },
              { text: 'route01_cleared が必要', jump: 'route01', condition: 'route01_cleared' },
            ],
          },
        } as Event,
      ]),
      scene('hub', [narration('hub')]),
      scene('route01', [narration('route01')]),
    ])
    internals(r).choiceOverlay.show = vi.fn()

    internals(r).advance()

    const call = internals(r).choiceOverlay.show.mock.calls[0]
    expect(call?.[5]).toEqual([false, true])
  })

  // #652: デバッグ用の全選択肢ロック解除。setDebugUnlockAllChoices(true) 後は、
  // flag 未設定で本来ロックされる condition 付きオプションも locked=false で show へ渡る。
  it('#652: setDebugUnlockAllChoices(true) 後は flag 未設定でも condition 付きオプションが locked=false で show へ渡される', () => {
    const r = makeRenderer([
      scene('cell', [
        narration('body'),
        {
          Choice: {
            options: [
              { text: '誰でも選べる', jump: 'hub' },
              { text: 'route01_cleared が必要', jump: 'route01', condition: 'route01_cleared' },
            ],
          },
        } as Event,
      ]),
      scene('hub', [narration('hub')]),
      scene('route01', [narration('route01')]),
    ])
    internals(r).choiceOverlay.show = vi.fn()
    r.setDebugUnlockAllChoices(true)

    internals(r).advance()

    const call = internals(r).choiceOverlay.show.mock.calls[0]
    expect(call?.[5]).toEqual([false, false])
  })

  it('#591: Flag イベントで route01_cleared=true を立てた後は locked=false になる', () => {
    const r = makeRenderer([
      scene('cell', [
        narration('body'),
        { Flag: { name: 'route01_cleared', value: { Bool: true } } } as Event,
        {
          Choice: {
            options: [
              { text: 'route01_cleared が必要', jump: 'route01', condition: 'route01_cleared' },
            ],
          },
        } as Event,
      ]),
      scene('route01', [narration('route01')]),
    ])
    internals(r).choiceOverlay.show = vi.fn()

    // narration → Flag（フラグ設定、非表示イベント） → Choice まで processUntilNextTextEvent
    // が一気に処理するため、advance() は1回だけでよい。
    internals(r).advance()

    const call = internals(r).choiceOverlay.show.mock.calls[0]
    expect(call?.[5]).toEqual([false])
  })

  // #591 テスト観点整理フェーズ 低優先9: 状態遷移/再訪。同じChoiceイベントを持つsceneに
  // 1回目はflag未設定で突入(ロック)し、flag設定後に再度同じsceneへjumpして2回目のshow()
  // 呼び出しでlockedが更新されていることを確認する（show()は毎回その時点のflag状態から
  // lockedを計算し直す、キャッシュされた古い値を使い回さないことの確認）。
  it('#591 再訪: 1回目はflag未設定で突入しロック、flag設定後に再訪すると2回目のshow()呼び出しでlockedがfalseに更新される', () => {
    const r = makeRenderer([
      scene('gate', [
        narration('gate body'),
        {
          Choice: {
            options: [{ text: '報酬へ', jump: 'reward', condition: 'flag_a' }],
          },
        } as Event,
      ]),
      scene('unlock', [
        narration('unlock body'),
        { Flag: { name: 'flag_a', value: { Bool: true } } } as Event,
        { Choice: { options: [{ text: 'gateへ戻る', jump: 'gate' }] } } as Event,
      ]),
      scene('reward', [narration('reward')]),
    ])
    internals(r).choiceOverlay.show = vi.fn()

    internals(r).advance() // gate: narration → Choice
    const firstCall = internals(r).choiceOverlay.show.mock.calls[0]
    // 1回目はflag_a未設定でロックされているはず
    expect(firstCall?.[5]).toEqual([true])

    r.jumpToScene('unlock') // unlock: narrationで停止（まだFlag/Choiceは未処理）
    internals(r).advance() // unlock: Flag(flag_a=true)を通過してChoiceへ（無条件、gateへ戻す）
    r.jumpToScene('gate') // gateへ再訪（narrationで停止、まだChoiceは未処理）
    internals(r).advance() // gate: Choiceへ再度到達（2回目のshow呼び出し）

    const calls = internals(r).choiceOverlay.show.mock.calls
    const secondGateCall = calls[calls.length - 1]
    // 2回目はflag_a設定済みでロック解除されているはず（show()が毎回flag状態から再計算する）
    expect(secondGateCall?.[5]).toEqual([false])
  })

  // #591 テスト観点整理フェーズ 低優先10: 組み合わせ。同一flagを参照する2つのoptionが
  // 同時にロック/解除されることを確認する（1つのoptionだけ更新漏れが起きていないか）。
  it('#591 組み合わせ: 同一flagを参照する2つのoptionは同時にロックされ、flag設定後は同時に解除される', () => {
    const rBothLocked = makeRenderer([
      scene('branch', [
        narration('body'),
        {
          Choice: {
            options: [
              { text: 'ルートA', jump: 'a', condition: 'shared_flag' },
              { text: 'ルートB', jump: 'b', condition: 'shared_flag' },
            ],
          },
        } as Event,
      ]),
    ])
    internals(rBothLocked).choiceOverlay.show = vi.fn()
    internals(rBothLocked).advance()
    expect(internals(rBothLocked).choiceOverlay.show.mock.calls[0]?.[5]).toEqual([true, true])

    const rBothUnlocked = makeRenderer([
      scene('branch', [
        narration('body'),
        { Flag: { name: 'shared_flag', value: { Bool: true } } } as Event,
        {
          Choice: {
            options: [
              { text: 'ルートA', jump: 'a', condition: 'shared_flag' },
              { text: 'ルートB', jump: 'b', condition: 'shared_flag' },
            ],
          },
        } as Event,
      ]),
    ])
    internals(rBothUnlocked).choiceOverlay.show = vi.fn()
    internals(rBothUnlocked).advance()
    expect(internals(rBothUnlocked).choiceOverlay.show.mock.calls[0]?.[5]).toEqual([false, false])
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
    markInitialized(r) // #515: wait 明けの advance 続行には initialized=true が必要
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
    markInitialized(r) // #515: wait 明けの advance 続行には initialized=true が必要
    const advanceSpy = vi.spyOn(internals(r), 'advance')
    await r.playScript([{ type: 'wait', ms: 0 }, { type: 'advance' }])
    expect(advanceSpy).toHaveBeenCalledTimes(1)
  })

  // ===== E'. destroy 後ガード (#515) =====
  //
  // #460/#462/#463 と同型のパターン: wait ステップの await 中に destroy() が呼ばれると
  // `this.initialized` が false になる。playScript は次 step（advance/choice）を処理する前に
  // これを確認し、破棄済みの dialogBox/stage 等を触らない（#515 で追加したガード）。
  it('18: wait 待機中に destroy 相当（initialized=false）になると、後続の advance は呼ばれず例外も投げない', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_SINGLE)
    markInitialized(r) // init() 完了済み（実運用と同じ開始状態）を模す
    const advanceSpy = vi.spyOn(internals(r), 'advance')

    const p = r.playScript([{ type: 'wait', ms: 100 }, { type: 'advance' }])
    await Promise.resolve()
    // wait 待機中に destroy() が呼ばれた状態を模す（jsdom には実 destroy() を最後まで
    // 走らせる canvas が無いため、restoreSnapshot.test.ts S1 と同じく直接フラグ操作で模す）。
    internals(r).initialized = false

    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBeUndefined()

    expect(advanceSpy).not.toHaveBeenCalled()
  })

  it('19: destroy 相当後も isReplaying/msPerChar は finally で正しく後始末される', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_SINGLE)
    markInitialized(r)
    internals(r).dialogBox.setMsPerChar(30)

    const p = r.playScript([{ type: 'wait', ms: 50 }, { type: 'advance' }])
    await Promise.resolve()
    internals(r).initialized = false

    await vi.advanceTimersByTimeAsync(50)
    await p

    expect(internals(r).isReplaying).toBe(false)
    expect(getMsPerChar(r)).toBe(30)
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

  // ===== G. destroy 後ガードの未カバー行 (#515 テスト設計 N1/N2/N3/N4/N7) =====

  it('20 (N1): 呼び出し前から initialized=false（markInitialized 未実行）のまま advance を呼んでも例外を投げない', async () => {
    // #515 のガードは wait ステップ明けにのみ入る。wait を経由しない script（advance のみ）は
    // このガード自体を通らないため、initialized=false のままでも advance() 自体が投げないことを
    // 固定する。
    //
    // 実測済みの理由（render() に一時 console.log を仕込んで確認、2箇所とも到達を確認済み）:
    // SCENES_SINGLE は resolvedEvents.length=2（空ではない）で、advance() は早期 return せず
    // backlogOverlay.addEntry() まで実行したのち、adv 分岐の「まだページが残っている」ケース
    // （textIndex=1 < pageCount=3）で this.render() を呼ぶところまで到達する。例外が出ないのは
    // その render() 自身の先頭にある `if (!this.initialized) return`（NovelRenderer.ts の
    // private render()）が初期化未完了を検知してそこで打ち切るためであり、advance() 側に
    // initialized チェックがあるわけではない。なお makeRenderer() 内の setScenes() が呼ぶ
    // 最初の render() 呼び出しも同じガードで既に早期 return している（advance 呼び出し前から
    // 1回目の到達は起きている）。
    const r = makeRenderer(SCENES_SINGLE)
    // markInitialized(r) を意図的に呼ばない = init() 未完了 / 破棄済みを模す
    await expect(r.playScript([{ type: 'advance' }])).resolves.toBeUndefined()
  })

  it('21 (N2): waitが2連続のscriptで、1回目のwait明けadvanceは実行され2回目のwait中にdestroy相当になると3番目以降のstepは実行されない', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_SINGLE)
    markInitialized(r)
    const advanceSpy = vi.spyOn(internals(r), 'advance')

    const p = r.playScript([
      { type: 'wait', ms: 50 },
      { type: 'advance' },
      { type: 'wait', ms: 50 },
      { type: 'advance' },
    ])

    // 1回目の wait 明け: initialized はまだ true なので advance が実行される
    await vi.advanceTimersByTimeAsync(50)
    expect(advanceSpy).toHaveBeenCalledTimes(1)

    // 2回目の wait 待機中に destroy 相当（initialized=false）にする
    internals(r).initialized = false
    await vi.advanceTimersByTimeAsync(50)
    await expect(p).resolves.toBeUndefined()

    // 2回目の wait 明けでガードが効き、4番目の advance は実行されない
    expect(advanceSpy).toHaveBeenCalledTimes(1)
  })

  it('22 (N3): wait待機中にdestroy相当になった後の次stepがchoiceの場合もjumpToSceneが呼ばれない（advance版と対称）', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_BRANCH)
    markInitialized(r)
    const jumpSpy = vi.spyOn(internals(r), 'jumpToScene')

    const p = r.playScript([
      { type: 'wait', ms: 100 },
      { type: 'choice', jump: 'left' },
    ])
    await Promise.resolve()
    internals(r).initialized = false

    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBeUndefined()

    expect(jumpSpy).not.toHaveBeenCalled()
    expect(r.getCurrentSceneId()).toBe('start')
  })

  it('23 (N4): destroy相当後finally実行までの間もconsole.warn/errorを呼ばない（既存test18/19は未アサートだった）', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = makeRenderer(SCENES_SINGLE)
    markInitialized(r)

    const p = r.playScript([{ type: 'wait', ms: 100 }, { type: 'advance' }])
    await Promise.resolve()
    internals(r).initialized = false

    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBeUndefined()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('24 (N7): wait→choiceの正常な並びでchoiceのjumpToSceneが正しく呼ばれる（destroyなし）', async () => {
    vi.useFakeTimers()
    const r = makeRenderer(SCENES_BRANCH)
    markInitialized(r)
    const jumpSpy = vi.spyOn(internals(r), 'jumpToScene')

    const p = r.playScript([
      { type: 'wait', ms: 100 },
      { type: 'choice', jump: 'right' },
    ])
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBeUndefined()

    expect(jumpSpy).toHaveBeenCalledWith('right')
    expect(r.getCurrentSceneId()).toBe('right')
  })
})
