/**
 * NovelRenderer 背景明るさ（brightness）の永続・復元・tint テスト。
 *
 * `[背景: bg.png, 明るさ=0.6]` は同一画像をシーン毎に減光する持続プロパティで、背景の端フェード
 * （#250）と同じく背景スロットに属し、snapshot / applyState / セーブ復元の全経路で復元される。
 * 減光は PixiJS の sprite.tint（乗算）で実現する: 明るさ b → tint = rgb(b*255, b*255, b*255)。
 *
 * 観測点は jsdom セーフな CPU 側のみ（CLAUDE.md ルール7 / doctrine: env-limit を盾にしない）:
 *   - getSnapshot().backgroundBrightness          … 永続状態の一次情報（assetBaseUrl 無しでも乗る）
 *   - brightnessToTint / normalizeBackgroundBrightness … tint 計算式・クランプの純関数
 *   - applyBrightnessTint(mockSprite)             … sprite.tint へ反映される観測（実描画は不要）
 *   - SaveManager の localStorage round-trip       … quickSave/quickLoad・slot save/load
 * 実ピクセル・z-order の描画検証は対象外でライブ blink に委ねる（ルール7）。
 *
 * 進行による `[背景]` 適用は playScript(advance) で駆動する。startFrom は先頭の非テキスト
 * イベントを自動処理しないため、`[背景]` の前に 1 行ナレーションを置き advance 1 回で踏ませる。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer, brightnessToTint, normalizeBackgroundBrightness } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import { SaveManager, SaveSlotData } from './SaveManager'

// --- fixture helpers（既存 NovelRenderer 系テストと同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function bg(path: string, brightness?: number | null): Event {
  // parser の Event union と同形（[背景: path, 明るさ=b] → Background { path, brightness }）。
  return { Background: { path, brightness: brightness ?? null } } as Event
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
  setBackground(path: string, fade?: unknown, brightness?: number | null): void
  clearBackground(): void
  applyBrightnessTint(sprite: { tint: number }): void
  currentBackgroundBrightness: number | null
  currentBackgroundPath: string | null
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

describe('brightnessToTint（明るさ → tint 乗算値の純関数）', () => {
  // tint = rgb(round(b*255), round(b*255), round(b*255))。PixiJS は乗算なので b 倍に減光される。
  it('b=1.0 → 0xffffff（白＝tint 無効＝原画）', () => {
    expect(brightnessToTint(1.0)).toBe(0xffffff)
  })

  it('null/undefined → 0xffffff（未指定＝原画＝後方互換）', () => {
    expect(brightnessToTint(null)).toBe(0xffffff)
    expect(brightnessToTint(undefined)).toBe(0xffffff)
  })

  it('b=0.6 → rgb(153,153,153)=0x999999（round(0.6*255)=153）', () => {
    expect(brightnessToTint(0.6)).toBe(0x999999)
  })

  it('b=0.0 → 0x000000（真っ黒）', () => {
    expect(brightnessToTint(0.0)).toBe(0x000000)
  })

  it('b=0.5 → round(127.5)=128 → 0x808080', () => {
    expect(brightnessToTint(0.5)).toBe(0x808080)
  })

  it('範囲外・非有限は防御的に倒れる（負→0x000000・1超→0xffffff・NaN→0xffffff）', () => {
    expect(brightnessToTint(-0.5)).toBe(0x000000)
    expect(brightnessToTint(1.5)).toBe(0xffffff)
    expect(brightnessToTint(NaN)).toBe(0xffffff)
    expect(brightnessToTint(Infinity)).toBe(0xffffff)
  })
})

describe('normalizeBackgroundBrightness（生値の正規化）', () => {
  it('未指定（null/undefined）・非有限は null（＝原画）', () => {
    expect(normalizeBackgroundBrightness(null)).toBeNull()
    expect(normalizeBackgroundBrightness(undefined)).toBeNull()
    expect(normalizeBackgroundBrightness(NaN)).toBeNull()
    expect(normalizeBackgroundBrightness(Infinity)).toBeNull()
  })

  it('1.0 以上は null（原画と同義のため持たない・round-trip 安定）', () => {
    expect(normalizeBackgroundBrightness(1.0)).toBeNull()
    expect(normalizeBackgroundBrightness(2.0)).toBeNull()
  })

  it('0.0〜1.0 未満はクランプして保持（0.6→0.6・負→0）', () => {
    expect(normalizeBackgroundBrightness(0.6)).toBe(0.6)
    expect(normalizeBackgroundBrightness(0)).toBe(0)
    expect(normalizeBackgroundBrightness(-0.5)).toBe(0)
  })
})

describe('NovelRenderer 背景明るさの永続・復元・tint', () => {
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

  // BR1: [背景: …, 明るさ=0.6] 処理 → snapshot.backgroundBrightness に乗る（assetBaseUrl 無しでも state は立つ）。
  it('BR1: [背景: bg.png, 明るさ=0.6] を advance で処理 → snapshot.backgroundBrightness === 0.6', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bg('bg.png', 0.6), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().backgroundBrightness).toBeNull() // 開始時はまだ未処理
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundBrightness).toBe(0.6)
  })

  // BR2: 明るさ未指定の背景は backgroundBrightness=null（後方互換＝原画のまま）。
  it('BR2: 明るさ未指定の [背景: bg.png] → snapshot.backgroundBrightness === null（後方互換）', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bg('bg.png'), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundBrightness).toBeNull()
  })

  // BR3: 明るさ=1.0（原画と同義）は normalize で null に倒れる。
  it('BR3: 明るさ=1.0 の背景 → snapshot.backgroundBrightness === null（原画と同義）', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bg('bg.png', 1.0), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundBrightness).toBeNull()
  })

  // ===== tint 反映（applyBrightnessTint・mock sprite）=====

  // BR4: 明るさ設定後の sprite に applyBrightnessTint → sprite.tint が期待値になる。
  it('BR4: 明るさ=0.6 の背景設定後 applyBrightnessTint → sprite.tint === 0x999999', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).setBackground('bg.png', null, 0.6)
    const sprite = { tint: 0xffffff }
    internals(r).applyBrightnessTint(sprite)
    expect(sprite.tint).toBe(0x999999)
  })

  // BR5: 明るさ未指定の背景 → tint は 0xffffff（原画のまま）。
  it('BR5: 明るさ未指定の背景設定後 applyBrightnessTint → sprite.tint === 0xffffff（原画）', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).setBackground('bg.png', null, null)
    const sprite = { tint: 0x123456 } // 既存値が上書きされることも確認
    internals(r).applyBrightnessTint(sprite)
    expect(sprite.tint).toBe(0xffffff)
  })

  // ===== 復元（quickSave/quickLoad round-trip）=====

  // BR6: 明るさセット後 quickSave → quickLoad で backgroundBrightness が往復する。
  it('BR6: 明るさセット後 quickSave→quickLoad で backgroundBrightness が往復する', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bg('bg.png', 0.6), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.quickSave()).toBe(true)
    const r2 = makeRenderer([scene('a', [narration('x'), bg('bg.png', 0.6), narration('y', 'z')])])
    r2.startFrom({ sceneId: 'a' })
    expect(r2.getSnapshot().backgroundBrightness).toBeNull()
    expect(r2.quickLoad()).toBe(true)
    expect(r2.getSnapshot().backgroundBrightness).toBe(0.6)
  })

  // BR7: 旧セーブ（backgroundBrightness キー欠落）→ 落ちず backgroundBrightness === null（後方互換 ?? null）。
  it('BR7: backgroundBrightness キー欠落の旧セーブを quickLoad → 落ちず null', () => {
    seedQuickSave(craftLegacy('backgroundBrightness'))
    const r = makeRenderer([scene('a', [narration('x')])])
    expect(r.quickLoad()).toBe(true)
    expect(r.getSnapshot().backgroundBrightness).toBeNull()
  })

  // BR8: スロットセーブ（slot≥0）でも backgroundBrightness が往復する（quickSave とは別経路）。
  it('BR8: スロットセーブ（slot 0）でも backgroundBrightness が往復する', () => {
    const sm = new SaveManager()
    sm.save(0, craftSave({ slot: 0, backgroundPath: 'bg.png', backgroundBrightness: 0.6 }))
    const loaded = sm.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded!.backgroundBrightness).toBe(0.6)
    const r = makeRenderer([scene('a', [narration('x')])])
    seedQuickSave(loaded!) // loadFromSaveData を quickLoad 経由で駆動（同じ復元コア）
    r.quickLoad()
    expect(r.getSnapshot().backgroundBrightness).toBe(0.6)
  })

  // BR9: startFrom の初期 state は backgroundBrightness=null（最小状態）。
  it('BR9: startFrom 直後の初期 state は backgroundBrightness === null', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().backgroundBrightness).toBeNull()
  })

  // ===== applyState（復元で維持・解除）=====

  // BR10: applyState で backgroundBrightness 付き state を流す → currentBackgroundBrightness が一致する。
  it('BR10: applyState（backgroundBrightness=0.4）→ currentBackgroundBrightness === 0.4', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    const base = r.getSnapshot()
    internals(r).applyState({ ...base, backgroundPath: 'bg.png', backgroundBrightness: 0.4 })
    expect(internals(r).currentBackgroundBrightness).toBe(0.4)
    expect(r.getSnapshot().backgroundBrightness).toBe(0.4)
  })

  // BR11: 背景パス無し state を applyState（事前に明るさあり）→ clearBackground で null に戻る。
  it('BR11: 事前に明るさあり → backgroundPath=null の state を applyState → null に戻る', () => {
    const r = makeRenderer([scene('a', [narration('x')])])
    r.startFrom({ sceneId: 'a' })
    internals(r).setBackground('bg.png', null, 0.6) // 事前に明るさあり
    const base = r.getSnapshot()
    internals(r).applyState({ ...base, backgroundPath: null, backgroundBrightness: null })
    expect(internals(r).currentBackgroundBrightness).toBeNull()
    expect(r.getSnapshot().backgroundBrightness).toBeNull()
  })

  // ===== スロット独立（明るさは端フェードと同じ背景スロット。明るさ=0 は有効値）=====

  // BR12: 明るさ=0（真っ黒）は有効値として保持・復元される（fade の 0=None とは非対称）。
  it('BR12: 明るさ=0（真っ黒）は snapshot=0 で保持され quickSave→quickLoad で往復する', async () => {
    const r = makeRenderer([scene('a', [narration('x'), bg('bg.png', 0), narration('y', 'z')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundBrightness).toBe(0)
    r.quickSave()
    const r2 = makeRenderer([scene('a', [narration('x'), bg('bg.png', 0), narration('y', 'z')])])
    r2.startFrom({ sceneId: 'a' })
    r2.quickLoad()
    expect(r2.getSnapshot().backgroundBrightness).toBe(0)
  })
})
