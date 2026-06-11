/**
 * NovelRenderer 背景色（単色地色）の永続・復元テスト (#273)。
 *
 * `[背景色: #f5f0e8]` は背景画像（`[背景:]`）と同じ永続状態として扱い、
 * snapshot / applyState / セーブ復元の全経路で復元される（doctrine 規律3）。
 * 観測点は jsdom セーフな CPU 側のみを使う（CLAUDE.md ルール7 / doctrine: env-limit を盾にしない）:
 *   - getSnapshot().backgroundColor              … 永続状態の一次情報
 *   - SaveManager の localStorage round-trip      … quickSave/quickLoad・slot save/load
 *   - bgGraphics.clear の spy                     … 塗り直しで前色が透けない回帰（DT-A2）
 * bgGraphics の clear/rect/fill は PIXI v8 で CPU 側のため init() を要さない。
 * 実ピクセル・z-order の描画検証は対象外でライブ blink に委ねる（ルール7）。
 *
 * 進行による `[背景色]` 適用は playScript(advance) で駆動する（processUntilNextTextEvent が
 * 非テキストイベントを処理する既存経路）。startFrom は先頭の非テキストイベントを自動処理しない
 * ため、`[背景色]` の前に 1 行ナレーションを置き advance 1 回で踏ませる。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene, NovelGameState } from '../types'
import { SaveManager, SaveSlotData } from './SaveManager'

// --- fixture helpers（既存 NovelRenderer 系テストと同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function bgColor(color: string): Event {
  // parser の Event union と同形（[背景色: …] → BackgroundColor { color }）。
  return { BackgroundColor: { color } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** private メソッド / フィールドへ到達するための内部アクセサ（既存テストと同じ cast 流儀） */
interface RendererInternals {
  applyState(state: NovelGameState): void
  setBackgroundColor(color: string): void
  clearBackgroundColor(): void
  clearBackground(): void
  currentBackgroundColor: string | null
  currentBackgroundPath: string | null
  bgGraphics: { clear(): unknown }
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/** jsdom セーフな SaveSlotData を作る（アセット系は null/空）。over で上書き可。 */
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
    savedAt: '2026-01-01T00:00:00.000Z',
    sceneName: null,
    ...over,
  }
}

function seedQuickSave(data: SaveSlotData): void {
  new SaveManager().quickSave(data)
}

/** 指定キーを欠落させた「旧フォーマット」セーブ（後方互換テスト用）。 */
function craftLegacy(omit: keyof SaveSlotData): SaveSlotData {
  const legacy = craftSave({ sceneId: 'a' }) as unknown as Record<string, unknown>
  delete legacy[omit]
  return legacy as unknown as SaveSlotData
}

describe('NovelRenderer 背景色の永続・復元 (#273)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
    localStorage.clear()
  })
  afterEach(() => {
    new SaveManager().deleteQuickSave()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ===== 永続（snapshot）=====

  // BG1: [背景色] 処理 → snapshot.backgroundColor に乗る。
  it('BG1: [背景色: #f5f0e8] を advance で処理 → snapshot.backgroundColor === "#f5f0e8"', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bgColor('#f5f0e8'), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().backgroundColor).toBeNull() // 開始時はまだ未処理
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundColor).toBe('#f5f0e8')
  })

  // S2: 同一 [背景色] を 2 回処理しても snapshot は冪等（同じ値・差分なし）。
  it('S2: 同一 [背景色] を 2 回処理しても snapshot.backgroundColor は冪等', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('x'),
        bgColor('#f5f0e8'),
        narration('y'),
        bgColor('#f5f0e8'),
        narration('z', 'w'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    const first = r.getSnapshot().backgroundColor
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundColor).toBe(first)
    expect(r.getSnapshot().backgroundColor).toBe('#f5f0e8')
  })

  // ===== 復元（quickSave/quickLoad round-trip）=====

  // BG2: 背景色セット後 quickSave → quickLoad で backgroundColor が往復する。
  it('BG2: 背景色セット後 quickSave→quickLoad で backgroundColor が往復する', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bgColor('#f5f0e8'), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.quickSave()).toBe(true)
    // 別 renderer で同じシーンを開き、地色なしの状態からロードして復元を確認。
    const r2 = makeRenderer([scene('a', [narration('x'), bgColor('#f5f0e8'), narration('y', 'z')])])
    r2.startFrom({ sceneId: 'a' })
    expect(r2.getSnapshot().backgroundColor).toBeNull()
    expect(r2.quickLoad()).toBe(true)
    expect(r2.getSnapshot().backgroundColor).toBe('#f5f0e8')
  })

  // BG5: 旧セーブ（backgroundColor キー欠落）→ 落ちず backgroundColor === null（後方互換 ?? null）。
  it('BG5: backgroundColor キー欠落の旧セーブを quickLoad → 落ちず backgroundColor === null', () => {
    seedQuickSave(craftLegacy('backgroundColor'))
    const r = makeRenderer([scene('a', [narration('x')])])
    expect(r.quickLoad()).toBe(true)
    expect(r.getSnapshot().backgroundColor).toBeNull()
  })

  // BG8: スロットセーブ（slot≥0）でも backgroundColor が往復する（quickSave とは別経路）。
  it('BG8: スロットセーブ（slot 0）でも backgroundColor が往復する', () => {
    const sm = new SaveManager()
    sm.save(0, craftSave({ slot: 0, backgroundColor: '#f5f0e8' }))
    const loaded = sm.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded!.backgroundColor).toBe('#f5f0e8')
    // ロードした slot データから renderer 状態へ復元しても保たれる。
    const r = makeRenderer([scene('a', [narration('x')])])
    seedQuickSave(loaded!) // loadFromSaveData を quickLoad 経由で駆動（同じ復元コア）
    r.quickLoad()
    expect(r.getSnapshot().backgroundColor).toBe('#f5f0e8')
  })

  // BG9: startFrom の初期 state は backgroundColor=null（最小状態）。
  it('BG9: startFrom 直後の初期 state は backgroundColor === null', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().backgroundColor).toBeNull()
  })

  // ===== applyState（塗り直し・黒復帰）=====

  // BG3: applyState で別色再設定時に bgGraphics.clear が呼ばれる（前色透け回帰防止 / DT-A2）。
  it('BG3: applyState で別色を再設定すると bgGraphics.clear が呼ばれる（重ね塗り防止 / DT-A2）', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).setBackgroundColor('#f5f0e8') // 事前に色あり
    const base = r.getSnapshot()
    const clearSpy = vi.spyOn(internals(r).bgGraphics, 'clear')
    internals(r).applyState({ ...base, backgroundColor: '#1a4a7a' })
    // 別色適用は setBackgroundColor を通り、塗り直し前に必ず clear() する。
    expect(clearSpy).toHaveBeenCalled()
    expect(r.getSnapshot().backgroundColor).toBe('#1a4a7a')
  })

  // BG4: backgroundColor=null の state を applyState（事前に色あり）→ 黒復帰・currentBackgroundColor=null（DT-A3）。
  it('BG4: 事前に色あり → backgroundColor=null の state を applyState → null に戻り clear される（DT-A3）', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).setBackgroundColor('#f5f0e8')
    const base = r.getSnapshot()
    const clearSpy = vi.spyOn(internals(r).bgGraphics, 'clear')
    internals(r).applyState({ ...base, backgroundColor: null })
    // null は clearBackgroundColor 経由で黒復帰（clear → rect → fill(0x000000)）。
    expect(clearSpy).toHaveBeenCalled()
    expect(internals(r).currentBackgroundColor).toBeNull()
    expect(r.getSnapshot().backgroundColor).toBeNull()
  })

  // ===== スロット独立（背景画像と地色の相互不可侵）=====

  // BGX4: clearBackground は地色を変えない / clearBackgroundColor は背景パスを変えない。
  it('BGX4: clearBackground() は currentBackgroundColor を変えない（スロット独立）', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).setBackgroundColor('#f5f0e8')
    internals(r).clearBackground() // 背景画像スロットだけを初期化
    expect(internals(r).currentBackgroundColor).toBe('#f5f0e8')
  })

  it('BGX4: clearBackgroundColor() は currentBackgroundPath を変えない（スロット独立）', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).currentBackgroundPath = 'bg/room.png' // 背景画像ありを擬似的に立てる
    internals(r).clearBackgroundColor() // 地色スロットだけを初期化
    expect(internals(r).currentBackgroundPath).toBe('bg/room.png')
  })

  // ===== 非対称の明文化（S1）=====

  // S1: 地色は復元される / タイトル色は復元されない、という非対称を固定する。
  // snapshot には backgroundColor は乗るが titleColor は乗らない（TitleShow は再 emit されない仕様 spec L507）。
  it('S1: snapshot は背景色を持つがタイトル色を持たない（地色は復元・タイトル色は非復元の非対称）', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bgColor('#f5f0e8'), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    const snap = r.getSnapshot() as unknown as Record<string, unknown>
    // 地色は永続状態として snapshot に乗る。
    expect(snap.backgroundColor).toBe('#f5f0e8')
    // タイトル色は snapshot の独立フィールドとしては存在しない（復元経路を持たない）。
    expect('titleColor' in snap).toBe(false)
  })

  // ===== 意図確認系（現挙動を固定。spec は「描画は黒・文字列は round-trip 保持」と定義済み）=====

  // BG10/A7: 不正 hex(#zzz) は描画では黒に倒れるが、文字列自体は currentBackgroundColor / snapshot に
  // そのまま保持される（spec: 不正・空の色は round-trip で文字列保持）。
  it('BG10/A7: 不正 hex [背景色: #zzz] → snapshot に生文字列 "#zzz" が保持される（描画は黒だが文字列は round-trip）', async () => {
    // 仕様定義済み（spec「背景色」節: 不正・空の色は文字列を round-trip 保持、描画は黒）。
    const r = makeRenderer([scene('a', [narration('x'), bgColor('#zzz'), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundColor).toBe('#zzz')
  })

  // A6: 空文字 [背景色: ] の倒れ方を 1 ケースで固定する。
  // 現挙動: setBackgroundColor('') は生文字列 "" を currentBackgroundColor に保持する（snapshot は ""）。
  // ただし applyState の truthy ガード（`if (state.backgroundColor)`）では "" は else に落ち、
  // clearBackgroundColor 経由で null になる（永続→復元で "" が null に倒れる非対称）。
  // 仕様未定義の境界。現挙動の固定として残す。
  it('A6: 空文字 [背景色: ] の現挙動を固定（処理直後は "" 保持・applyState では truthy ガードで null に倒れる）', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bgColor(''), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    // 処理直後（setBackgroundColor 経由）は空文字をそのまま保持する。
    expect(r.getSnapshot().backgroundColor).toBe('')
    // applyState 経路（quickSave→quickLoad）では truthy ガードで else に落ち null に倒れる。
    r.quickSave()
    const r2 = makeRenderer([scene('a', [narration('x'), bgColor(''), narration('y', 'z')])])
    r2.startFrom({ sceneId: 'a' })
    r2.quickLoad()
    expect(r2.getSnapshot().backgroundColor).toBeNull()
  })
})
