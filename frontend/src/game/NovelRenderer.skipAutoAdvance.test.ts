/**
 * NovelRenderer の skipAutoAdvance / pendingAutoAdvance / resumeAutoAdvanceIfPending の
 * 単体テスト (#620)。
 *
 * 背景（#620 の経緯）:
 * 「続きから」起動時の自動 quickLoad は、entry シーン冒頭の自動進行（[待機:] 等）が
 * quickLoad() 自体のガード（waitingForChoice/waitingForWait 中は quickLoad しない）を
 * 誤って踏んでしまう問題があった。対策として `setEvents`/`setScenes` に
 * `{ skipAutoAdvance: true }` を渡すと、resetAndStartEvents は自動進行
 * （processUntilNextTextEvent → showCharacterThenRender）を実行せず `pendingAutoAdvance`
 * を立てるだけで返る。その後 `resumeAutoAdvanceIfPending()` を呼ぶと、保留していた
 * 自動進行を後追いで一度だけ実行する。
 *
 * さらに、quickLoad() の boolean 戻り値は「実際にシーンが復元されたか」を正しく表さない
 * （sceneId 空・シーン未発見・missingSceneResolver 失敗のいずれでも常に true を返しうる）
 * ため、`restoreToScene` が実際に呼ばれたかどうかだけを唯一の判定基準として
 * `pendingAutoAdvance` の後始末を行うよう修正した。このファイルは主にその後始末（フリーズ
 * しないこと）を検証する。quickLoad() の各分岐そのものの網羅は
 * NovelRenderer.loadFromSaveData.test.ts が既に担保しているため、ここでは
 * skipAutoAdvance/pendingAutoAdvance に絡む観点だけに絞る。
 *
 * waitingForWait の検知には「エントリイベント列の先頭を Wait にする」手法を使う。
 * Wait は resetAndStartEvents 内の processUntilNextTextEvent に処理されると同期的に
 * waitingForWait=true を立てる（実際の待機解消はタイマー任せ）ため、
 * 「自動進行が実行されたかどうか」を確実に観測できる（NovelRenderer.startFrom.test.ts の
 * SCENES_WAIT と同じ手法。実タイマーが意図せず発火しないよう vi.useFakeTimers() を使う）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import { SaveManager, SaveSlotData } from './SaveManager'

// --- fixture helpers（NovelRenderer.loadFromSaveData.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function waitEvent(ms: number): Event {
  return { Wait: { ms } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** ensureContext の jsdom 制約回避（loadFromSaveData.test.ts の muteAudio と同じパターン）。 */
function muteAudio(r: NovelRenderer): void {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

/** loadFromSaveData.test.ts の markInitialized と同じ: missingSceneResolver の待機経路検証に必要。 */
function markInitialized(r: NovelRenderer): void {
  internals(r).initialized = true
}

/** loadFromSaveData.test.ts の内部アクセサに pendingAutoAdvance を加えたもの (#620)。 */
interface RendererInternals {
  history: unknown[]
  initialized: boolean
  pendingAutoAdvance: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/** jsdom セーフな SaveSlotData を作る（loadFromSaveData.test.ts の craftSave と同じ）。 */
function craftSave(over: Partial<SaveSlotData>): SaveSlotData {
  return {
    slot: -1,
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: new Date().toISOString(),
    sceneName: null,
    ...over,
  }
}

function seedQuickSave(data: SaveSlotData): void {
  new SaveManager().quickSave(data)
}

// 冒頭が Wait のエントリイベント列。processUntilNextTextEvent が実行されると
// 同期的に waitingForWait=true になる（自動進行が実行された痕跡として使う）。
const ENTRY_EVENTS: Event[] = [waitEvent(500), narration('entry-after-wait')]

// 冒頭がテキストイベント（Wait 等のディレクティブを挟まない）のイベント列。
// pushSnapshot は「現在位置がテキストイベントである」ことを条件に history へ積むため
// （Wait で止まっている間は積まない）、history の増分で「自動進行が実行されたか」を
// 検知したいテスト（二重実行防止の確認）専用に使う。
const TEXT_ONLY_EVENTS: Event[] = [narration('only-line')]

// quickLoad の復元先として使うシーン。'a' もエントリと同じく冒頭 Wait を持つが、
// restoreToScene は宣言的な state 復元のみで Wait を実行しないため、
// pendingAutoAdvance の後始末の検証に影響しない。
const SCENES: EventScene[] = [
  scene('a', [waitEvent(500), narration('a-after-wait')]),
  scene('b', [narration('b1')]),
]

function makeSkippedRenderer(jumpIndex: EventScene[] = []): NovelRenderer {
  const r = new NovelRenderer()
  muteAudio(r)
  if (jumpIndex.length > 0) {
    r.setJumpSceneIndex(jumpIndex)
  }
  r.setEvents(ENTRY_EVENTS, { skipAutoAdvance: true })
  return r
}

describe('NovelRenderer skipAutoAdvance / pendingAutoAdvance / resumeAutoAdvanceIfPending (#620)', () => {
  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ===== A. setEvents/setScenes への skipAutoAdvance 伝播 =====

  it('1: setEvents(events, { skipAutoAdvance: true }) は pendingAutoAdvance を立て、waitingForWait/waitingForChoice は false のまま（エントリの [待機:] を実行しない）', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)

    r.setEvents(ENTRY_EVENTS, { skipAutoAdvance: true })

    expect(internals(r).pendingAutoAdvance).toBe(true)
    expect(r.getDebugState().waitingForWait).toBe(false)
    expect(r.getDebugState().waitingForChoice).toBe(false)
  })

  it('2a: setEvents(events, { skipAutoAdvance: false }) は従来通り自動進行する（非回帰）', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)

    r.setEvents(ENTRY_EVENTS, { skipAutoAdvance: false })

    expect(internals(r).pendingAutoAdvance).toBe(false)
    expect(r.getDebugState().waitingForWait).toBe(true)
  })

  it('2b: setEvents(events)（オプション省略）も従来通り自動進行する（非回帰）', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)

    r.setEvents(ENTRY_EVENTS)

    expect(internals(r).pendingAutoAdvance).toBe(false)
    expect(r.getDebugState().waitingForWait).toBe(true)
  })

  it('3: setScenes(scenes, { skipAutoAdvance: true }) は内部の setEvents 呼び出しへオプションを伝播する', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)

    r.setScenes(SCENES, { skipAutoAdvance: true })

    expect(internals(r).pendingAutoAdvance).toBe(true)
    expect(r.getDebugState().waitingForWait).toBe(false)
  })

  // ===== B. resumeAutoAdvanceIfPending の単体挙動 =====

  it('4: resumeAutoAdvanceIfPending() は skipAutoAdvance:true 後に呼ぶと保留していた自動進行を実行し、pendingAutoAdvance を false に戻す', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(ENTRY_EVENTS, { skipAutoAdvance: true })

    r.resumeAutoAdvanceIfPending()

    expect(internals(r).pendingAutoAdvance).toBe(false)
    expect(r.getDebugState().waitingForWait).toBe(true)
  })

  it('5: resumeAutoAdvanceIfPending() は pendingAutoAdvance が false（一度も skip していない）状態で呼んでも no-op で例外を投げない', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)
    r.setEvents(ENTRY_EVENTS) // 通常経路。既に自動進行済み → pendingAutoAdvance は最初から false
    const waitingBefore = r.getDebugState().waitingForWait

    expect(() => r.resumeAutoAdvanceIfPending()).not.toThrow()

    expect(internals(r).pendingAutoAdvance).toBe(false)
    // 何も進行しない（状態が変わらない）ことも確認する
    expect(r.getDebugState().waitingForWait).toBe(waitingBefore)
  })

  it('6: resumeAutoAdvanceIfPending() を2回連続で呼んでも2回目は何も起きない（二重進行しない）', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)
    // Wait を挟まないテキスト先頭の列を使う: pushSnapshot は現在位置がテキストイベントの
    // ときだけ history に積むため（ENTRY_EVENTS のように Wait で止まったままだと history が
    // 増えず二重実行の検知に使えない）。
    r.setEvents(TEXT_ONLY_EVENTS, { skipAutoAdvance: true })

    r.resumeAutoAdvanceIfPending()
    // 1回目の実行で history に現在位置が1件積まれる（pushSnapshot）。
    const historyLengthAfterFirst = internals(r).history.length
    expect(historyLengthAfterFirst).toBeGreaterThan(0)

    r.resumeAutoAdvanceIfPending()

    // 2回目は no-op なので history は増えない（自動進行が二重に走っていない証拠）。
    expect(internals(r).history.length).toBe(historyLengthAfterFirst)
  })

  // ===== C. quickLoad() 経由の後始末（#620 の本題: restoreToScene が実際に呼ばれたかだけを見る） =====

  it('7: quickLoad() 成功（シーンが同期的に見つかる）→ restoreToScene 実行後に pendingAutoAdvance が false になる', () => {
    vi.useFakeTimers()
    const r = makeSkippedRenderer(SCENES)
    expect(internals(r).pendingAutoAdvance).toBe(true)

    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 0 }))
    expect(r.quickLoad()).toBe(true)

    expect(internals(r).pendingAutoAdvance).toBe(false)
  })

  it('8: quickLoad() ケースA（sceneId が空のセーブ）→ フラグだけ復元されるが pendingAutoAdvance が false になり自動進行が実行される（フリーズしない）', () => {
    vi.useFakeTimers()
    const r = makeSkippedRenderer(SCENES)
    expect(internals(r).pendingAutoAdvance).toBe(true)

    seedQuickSave(craftSave({ sceneId: '', flags: {} }))
    expect(r.quickLoad()).toBe(true)

    expect(internals(r).pendingAutoAdvance).toBe(false)
    // エントリの [待機:] が後追いで実行されている（フリーズしていない証拠）。
    expect(r.getDebugState().waitingForWait).toBe(true)
  })

  it('9: quickLoad() ケースB（sceneId が allScenes に無く missingSceneResolver も無い）→ フラグだけ復元されwarnが出るが pendingAutoAdvance が false になり自動進行が実行される（フリーズしない）', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // allScenes には 'hub' しか無く、セーブ対象の 'ghost' は含まれない。resolver も設定しない。
    const r = makeSkippedRenderer([scene('hub', [narration('hub1')])])
    expect(internals(r).pendingAutoAdvance).toBe(true)

    seedQuickSave(craftSave({ sceneId: 'ghost', flags: {} }))
    expect(r.quickLoad()).toBe(true)

    expect(internals(r).pendingAutoAdvance).toBe(false)
    expect(r.getDebugState().waitingForWait).toBe(true)
  })

  it('10: quickLoad() ケースC（missingSceneResolver が非同期解決に失敗）→ 非同期完了後に pendingAutoAdvance が false になり自動進行が実行される（フリーズしない）', async () => {
    vi.useFakeTimers()
    const resolver = vi.fn(async () => null)
    const r = new NovelRenderer()
    muteAudio(r)
    r.setJumpSceneIndex([scene('hub', [narration('hub1')])])
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    r.setEvents(ENTRY_EVENTS, { skipAutoAdvance: true })
    expect(internals(r).pendingAutoAdvance).toBe(true)

    seedQuickSave(craftSave({ sceneId: 'ghost-route', flags: {} }))
    // loadFromSaveDataMissingScene は fire-and-forget なので quickLoad() 自体は resolver の
    // 解決を待たず同期的に true を返す（loadFromSaveData.test.ts #10 と同じ非同期性）。
    expect(r.quickLoad()).toBe(true)
    // resolver 解決前はまだ pendingAutoAdvance が残っている（このタイミング差が #620 の核心）。
    expect(internals(r).pendingAutoAdvance).toBe(true)

    await vi.waitFor(() => {
      expect(resolver).toHaveBeenCalledWith('ghost-route')
    })

    expect(internals(r).pendingAutoAdvance).toBe(false)
    expect(r.getDebugState().waitingForWait).toBe(true)
  })

  // ===== D. 回帰確認: quickLoad() の入口ガードは willAutoQuickLoad 経路では原理上発火しない =====

  it('11: resetAndStartEvents は skipAutoAdvance 判定より前に waitingForChoice/waitingForWait を無条件で false にリセットするため、直後の quickLoad() が入口ガードで弾かれることは起きない', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    muteAudio(r)
    r.setJumpSceneIndex(SCENES)
    // 通常経路の setEvents で意図的に waitingForWait=true を作っておく（前シーンの Wait 待機）。
    r.setEvents(ENTRY_EVENTS)
    expect(r.getDebugState().waitingForWait).toBe(true)

    // #620 の実運用と同じ呼び出し: skipAutoAdvance:true で resetAndStartEvents を再度通す。
    r.setEvents(ENTRY_EVENTS, { skipAutoAdvance: true })
    expect(r.getDebugState().waitingForWait).toBe(false)
    expect(r.getDebugState().waitingForChoice).toBe(false)

    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 0 }))
    // quickLoad() 冒頭の `if (this.waitingForChoice || this.waitingForWait) return false` に
    // 弾かれず、正しく true を返す。
    expect(r.quickLoad()).toBe(true)
  })
})
