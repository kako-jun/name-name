/**
 * レンダラ結合: SaveController との配線 (#827, #735 6/8)。
 *
 * 単体で固定できない「レンダラの入場・復元が自動セーブの保留を破棄する」「配線前の初期入場では自動セーブが走らない」
 * 「クイックセーブ → 別インスタンスへロード → getSnapshot が一致」だけを見る。ゲート別のトースト文言・
 * 自動セーブの保留規則・SaveSlotData の中身は SaveController.test.ts、トーストの実機相当は
 * quickSaveToast / saveLoadConsistency / sceneEntryGate / linearRange 系が固定済みなので重複させない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import { SaveManager } from './SaveManager'
import type { Event, EventScene } from '../types'
import { internals, type SaveInternals } from '../test/rendererInternals'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const jump = (target: string): Event => ({ Jump: { target } })
const wait = (ms: number): Event => ({ Wait: { ms } }) as Event
const background = (path: string): Event => ({ Background: { path } }) as unknown as Event
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function prepare(r: NovelRenderer): NovelRenderer {
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals(r).initialized = true
  vi.spyOn(internals(r), 'render').mockImplementation(() => {})
  return r
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  defaultTimeController.setMode('live')
  localStorage.clear()
})

describe('自動セーブの配線 (#768)', () => {
  const A = scene('a', [narration('a1'), narration('a2'), jump('b')])
  const B = scene('b', [narration('b1'), narration('b2')])

  it('初期入場（配線前）では自動セーブが走らず、配線後は次のシーン境界の本文で1回だけ保存される', async () => {
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([A, B])
    r.loadEvents(A.events)
    const quickSave = vi.spyOn(internals<SaveInternals>(r).saveManager, 'quickSave')
    const request = vi.spyOn(r, 'requestAutoSave')

    await r.startFrom({}) // NovelPlayer と同じ: 初期入場の確定までは setOnSceneChange を結ばない
    expect(request).not.toHaveBeenCalled()
    expect(quickSave).not.toHaveBeenCalled()
    expect(internals<SaveInternals>(r).autoSavePending).toBe(false)

    r.setOnSceneChange(() => r.requestAutoSave()) // 初期入場の確定後に配線
    r.advance() // a2
    expect(quickSave).not.toHaveBeenCalled() // 同じシーン内の進行では保存しない

    r.advance() // Jump に到達し予約
    r.getTimeController().tick(1)
    await flush()

    expect(r.getCurrentSceneId()).toBe('b')
    expect(request).toHaveBeenCalledTimes(1)
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(quickSave.mock.calls[0][0]).toMatchObject({ slot: -1, sceneId: 'b', eventIndex: 0 })
    expect(new SaveManager().quickLoad()?.sceneName).toBe('b')
  })

  it('保留中に次の入場（シーンジャンプ）が始まると保留は破棄され、その後の本文でも保存されない', async () => {
    const W = scene('w', [wait(100), narration('w1')])
    const C = scene('c', [narration('c1')])
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([A, W, C])
    r.loadEvents([narration('s0'), jump('w')])
    await r.startFrom({})
    r.setOnSceneChange(() => r.requestAutoSave())
    r.advance() // Jump w
    r.getTimeController().tick(1)
    await flush()
    expect(r.getCurrentSceneId()).toBe('w')
    expect(internals<SaveInternals>(r).autoSavePending).toBe(true) // 待機中なので保留

    r.setOnSceneChange(() => {}) // 次の入場が新たな保留を作らないようにして、破棄だけを見る
    await r.jumpToScene('c')
    expect(internals<SaveInternals>(r).autoSavePending).toBe(false)
    expect(new SaveManager().hasQuickSave()).toBe(false) // c の本文でも保存されない
  })

  it('保留中に新規開始（startFrom）しても保留は破棄される', async () => {
    const W = scene('w', [wait(100), narration('w1')])
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([W])
    r.loadEvents([narration('s0'), jump('w')])
    await r.startFrom({})
    r.setOnSceneChange(() => r.requestAutoSave())
    r.advance()
    r.getTimeController().tick(1)
    await flush()
    expect(internals<SaveInternals>(r).autoSavePending).toBe(true)

    r.setOnSceneChange(() => {})
    await r.startFrom({})
    expect(internals<SaveInternals>(r).autoSavePending).toBe(false)
    r.getTimeController().tick(1000)
    await flush()
    expect(new SaveManager().hasQuickSave()).toBe(false)
  })

  it('保留中にクイックロード（復元）すると保留は破棄され、復元後の本文で古い保留による自動セーブが走らない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const STALL = scene('stall', [jump('nowhere')]) // 冒頭が遷移先不在の Jump
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([STALL])
    r.loadEvents([narration('s0'), narration('s1'), jump('stall')])
    await r.startFrom({})
    expect(r.quickSave()).toBe(true) // s0 の位置を手動セーブ（復元先）
    r.advance() // s1
    r.setOnSceneChange(() => r.requestAutoSave())
    r.advance() // Jump stall
    r.getTimeController().tick(1)
    await flush()
    expect(r.getCurrentSceneId()).toBe('stall')
    r.getTimeController().tick(1) // 冒頭 Jump も遷移先不在 → stalled
    await flush()
    expect(internals(r).jumpState).toBe('stalled')
    expect(internals<SaveInternals>(r).autoSavePending).toBe(true) // 本文が無いので保留のまま

    r.setOnSceneChange(() => {})
    const quickSave = vi.spyOn(internals<SaveInternals>(r).saveManager, 'quickSave')
    expect(await r.quickLoad()).not.toBeNull() // navigate ゲートは stalled の Jump を通す → applyState
    expect(internals<SaveInternals>(r).autoSavePending).toBe(false)

    // 復元後の本文位置で pushSnapshot → flushAutoSave が走っても、古い保留では保存されない
    ;(r as unknown as { pushSnapshot(): void }).pushSnapshot()
    expect(quickSave).not.toHaveBeenCalled()
  })
})

describe('クイックセーブ → 別インスタンスへロード (#827)', () => {
  it('ロード先の getSnapshot() が、セーブ時の getSnapshot() と一致する', async () => {
    const S1 = scene('s1', [
      background('bg1.png'),
      narration('one'),
      narration('two'),
      narration('three'),
    ])
    const make = async (): Promise<NovelRenderer> => {
      const r = prepare(new NovelRenderer())
      r.setScenes([S1])
      return r
    }

    const src = await make()
    src.advance()
    src.advance()
    const snapshot = src.getSnapshot()
    expect(snapshot.eventIndex).toBeGreaterThan(1) // 先頭ではない位置
    expect(snapshot.backgroundPath).toBe('bg1.png')
    expect(src.quickSave()).toBe(true)

    const dst = await make()
    expect(dst.getSnapshot().eventIndex).not.toBe(snapshot.eventIndex)
    await expect(dst.quickLoad()).resolves.toEqual({ status: 'entered', sceneId: 's1' })

    expect(dst.getSnapshot()).toEqual(snapshot)
  })
})
