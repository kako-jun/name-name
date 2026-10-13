/**
 * 復元位置が範囲外のときの扱い (#789)。
 *
 * 文書が編集された後のセーブは、eventIndex / textIndex が解決したイベント列の外を指すことがある。
 * 全復元経路（クイックロード・ロードメニュー〈loadFromSaveData〉・restoreSnapshot・sceneId null の
 * エントリ復元・startFrom の位置指定）で、範囲外は復元失敗（out-of-range）として扱い、位置・flags とも
 * 現状維持にする（クランプしない）。セーブ由来のロードだけ失敗トーストを出し、restoreSnapshot と
 * startFrom は warn のみ。範囲は flags で `[条件:]` を展開した後の長さで判定する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { NovelGameState } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'
import { SaveManager, type SaveSlotData } from './SaveManager'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
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
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  r.setScenes(scenes)
  return r
}

function craftSnapshot(over: Partial<NovelGameState>): NovelGameState {
  return {
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    sentenceIndex: 0,
    flags: {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    backgroundBoards: [],
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    paperDollOutline: null,
    storyEnded: false,
    ...over,
  }
}

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

// a: 2 イベント（1 つ目は 3 行、2 つ目は 2 行）。b: 1 イベント。
const SCENES: EventScene[] = [
  scene('a', [narration('a1', 'a2', 'a3'), narration('a4', 'a5')]),
  scene('b', [narration('b1')]),
]
// seen が真なら 4 イベント、偽なら 2 イベントに展開される。
const SCENES_COND: EventScene[] = [
  scene('cond', [
    narration('共通1'),
    condition('seen', [narration('分岐1'), narration('分岐2')]),
    narration('共通2'),
  ]),
]

/** 失敗しても変わらないことを見る、現在位置の目印を立てる。 */
function startAtB(r: NovelRenderer): void {
  r.startFrom({ sceneId: 'b', flags: { old: boolFlag(true) } })
}
function expectUnchanged(r: NovelRenderer): void {
  expect(r.getCurrentSceneId()).toBe('b')
  expect(r.getSnapshot().eventIndex).toBe(0)
  expect(r.getSnapshot().flags).toEqual({ old: boolFlag(true) })
}

beforeEach(() => {
  new SaveManager().deleteQuickSave()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('範囲外のセーブ復元は失敗扱い (#789)', () => {
  const outOfRange: Array<[string, Partial<SaveSlotData>]> = [
    ['eventIndex が終端を超える（イベント数 + 1）', { eventIndex: 3 }],
    ['eventIndex がイベント数を大きく超える', { eventIndex: 99 }],
    ['eventIndex が負数', { eventIndex: -1 }],
    ['textIndex が本文の行数と等しい', { eventIndex: 1, textIndex: 2 }],
    ['textIndex が負数', { eventIndex: 0, textIndex: -1 }],
  ]

  it.each(outOfRange)(
    'quickLoad: %s → out-of-range・位置と flags は不変・失敗トーストのみ',
    async (_label, over) => {
      const r = makeRenderer(SCENES)
      startAtB(r)
      new SaveManager().quickSave(craftSave({ ...over, flags: { restored: boolFlag(true) } }))
      const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

      const result = await r.quickLoad()

      expect(result).toEqual({ status: 'failed', reason: 'out-of-range' })
      expectUnchanged(r)
      expect(toast.mock.calls).toEqual([['ロードに失敗しました']])
    }
  )

  it('quickLoad: 自動ロード（auto）でも失敗は通知する', async () => {
    const r = makeRenderer(SCENES)
    startAtB(r)
    new SaveManager().quickSave(craftSave({ eventIndex: 5 }))
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

    expect(await r.quickLoad('auto')).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(toast.mock.calls).toEqual([['ロードに失敗しました']])
  })

  it('境界: 最後のイベント・最後の行は成功し、クイックロードのトーストが出る', async () => {
    const r = makeRenderer(SCENES)
    startAtB(r)
    new SaveManager().quickSave(
      craftSave({ eventIndex: 1, textIndex: 1, flags: { restored: boolFlag(true) } })
    )
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

    expect(await r.quickLoad()).toEqual({ status: 'entered', sceneId: 'a' })
    expect(r.getSnapshot().eventIndex).toBe(1)
    expect(r.getSnapshot().textIndex).toBe(1)
    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
    expect(toast.mock.calls).toEqual([['クイックロードしました']])
  })

  it('[条件:] の展開後の長さで判定する: flags が偽なら 2 イベントなので eventIndex 3 は範囲外', async () => {
    const r = makeRenderer(SCENES_COND)
    r.startFrom({ sceneId: 'cond', flags: { old: boolFlag(true) } })
    new SaveManager().quickSave(craftSave({ sceneId: 'cond', eventIndex: 3, flags: {} }))
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

    expect(await r.quickLoad()).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(r.getSnapshot().flags).toEqual({ old: boolFlag(true) })
    expect(toast.mock.calls).toEqual([['ロードに失敗しました']])
  })

  it('[条件:] の展開後の長さで判定する: flags が真なら 4 イベントなので eventIndex 3 は範囲内', async () => {
    const r = makeRenderer(SCENES_COND)
    r.startFrom({ sceneId: 'cond' })
    new SaveManager().quickSave(
      craftSave({ sceneId: 'cond', eventIndex: 3, flags: { seen: boolFlag(true) } })
    )

    expect(await r.quickLoad()).toEqual({ status: 'entered', sceneId: 'cond' })
    expect(r.getSnapshot().eventIndex).toBe(3)
  })
})

describe('範囲外の restoreSnapshot は失敗扱い・トーストなし (#789)', () => {
  it.each([
    ['eventIndex が終端を超える（イベント数 + 1）', { eventIndex: 3 }],
    ['eventIndex が負数', { eventIndex: -1 }],
    ['textIndex が負数', { textIndex: -1 }],
    ['textIndex が本文の行数以上', { eventIndex: 1, textIndex: 2 }],
  ] as Array<[string, Partial<NovelGameState>]>)(
    '%s → out-of-range・位置と flags は不変・warn のみ',
    async (_label, over) => {
      const r = makeRenderer(SCENES)
      startAtB(r)
      const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
      const warn = vi.mocked(console.warn)
      warn.mockClear()

      const result = await r.restoreSnapshot(
        craftSnapshot({ ...over, flags: { x: boolFlag(true) } })
      )

      expect(result).toEqual({ status: 'failed', reason: 'out-of-range' })
      expectUnchanged(r)
      expect(toast).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    }
  )

  it('境界: 最後のイベントは成功する', async () => {
    const r = makeRenderer(SCENES)
    startAtB(r)
    expect(await r.restoreSnapshot(craftSnapshot({ eventIndex: 1 }))).toEqual({
      status: 'entered',
      sceneId: 'a',
    })
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('終端（eventIndex がイベント数と等しい）は storyEnded に関わらず有効、textIndex は 0 のみ', async () => {
    const r = makeRenderer(SCENES)
    expect(await r.restoreSnapshot(craftSnapshot({ eventIndex: 2, storyEnded: true }))).toEqual({
      status: 'entered',
      sceneId: 'a',
    })
    expect(await r.restoreSnapshot(craftSnapshot({ eventIndex: 2 }))).toEqual({
      status: 'entered',
      sceneId: 'a',
    })
    expect(await r.restoreSnapshot(craftSnapshot({ eventIndex: 2, textIndex: 1 }))).toEqual({
      status: 'failed',
      reason: 'out-of-range',
    })
  })
})

describe('sceneId が null のエントリ復元の範囲外 (#789)', () => {
  it('snapshot: eventIndex が範囲外 → out-of-range・不変・トーストなし', async () => {
    const r = makeRenderer(SCENES)
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    const before = r.getSnapshot()

    const result = await r.restoreSnapshot(
      craftSnapshot({ sceneId: null, eventIndex: 3, flags: { x: boolFlag(true) } })
    )

    expect(result).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(r.getSnapshot().eventIndex).toBe(before.eventIndex)
    expect(r.getSnapshot().flags).toEqual(before.flags)
    expect(toast).not.toHaveBeenCalled()
  })

  it('save: eventIndex が範囲外 → out-of-range・不変・失敗トースト', async () => {
    const r = makeRenderer(SCENES)
    new SaveManager().quickSave(
      craftSave({ sceneId: null, eventIndex: 7, flags: { x: boolFlag(true) } })
    )
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

    expect(await r.quickLoad()).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(r.getSnapshot().flags).toEqual({})
    expect(toast.mock.calls).toEqual([['ロードに失敗しました']])
  })

  it('境界: 最後のイベントは成功する', async () => {
    const r = makeRenderer(SCENES)
    const result = await r.restoreSnapshot(craftSnapshot({ sceneId: null, eventIndex: 1 }))
    expect(result.status).toBe('entered')
    expect(r.getSnapshot().eventIndex).toBe(1)
  })
})

describe('startFrom の位置指定の範囲外 (#789)', () => {
  it.each([
    ['eventIndex が終端を超える（イベント数 + 1）', { eventIndex: 3 }],
    ['eventIndex が負数', { eventIndex: -1 }],
    ['textIndex が本文の行数以上', { eventIndex: 1, textIndex: 2 }],
    ['textIndex が負数', { eventIndex: 1, textIndex: -1 }],
  ])('%s → out-of-range・flags と位置は不変', async (_label, pos) => {
    const r = makeRenderer(SCENES)
    startAtB(r)

    const result = await r.startFrom({ sceneId: 'a', flags: { fresh: boolFlag(true) }, ...pos })

    expect(result).toEqual({ status: 'failed', reason: 'out-of-range' })
    expectUnchanged(r)
  })

  it('範囲外でも confinement は置き換わらない', async () => {
    const r = makeRenderer(SCENES)
    await r.startFrom({ sceneId: 'b', confinedSceneIds: ['b'] })
    await r.startFrom({ sceneId: 'a', eventIndex: 9, confinedSceneIds: null })
    // 圏外への進行が終劇になる（confinement が ['b'] のまま）ことで確認する。
    expect(await r.jumpToScene('a')).toEqual({ status: 'ended' })
  })

  it('境界: 最後のイベントは成功する', async () => {
    const r = makeRenderer(SCENES)
    startAtB(r)
    expect(await r.startFrom({ sceneId: 'a', eventIndex: 1 })).toEqual({
      status: 'entered',
      sceneId: 'a',
    })
    expect(r.getSnapshot().eventIndex).toBe(1)
  })
})

// 最後の本文の後ろに命令だけが続くシーン。advance が命令を消化して終端（storyEnded=false のクリック待ち）で止まる。
const TAIL_SCENES: EventScene[] = [
  scene('tail', [narration('last'), { Blackout: { action: 'On' } } as Event]),
]

describe('末尾の命令を消化した終端の位置 (#789)', () => {
  it('エンジン自身が書いたセーブ・スナップショットが復元できる', async () => {
    const r = makeRenderer(TAIL_SCENES)
    r.startFrom({ sceneId: 'tail' })
    r.advance()
    const snap = r.getSnapshot()
    expect(snap.eventIndex).toBe(2)
    expect(snap.storyEnded).toBe(false)

    const r2 = makeRenderer(TAIL_SCENES)
    expect(await r2.restoreSnapshot(snap)).toEqual({ status: 'entered', sceneId: 'tail' })
    expect(r2.getSnapshot().eventIndex).toBe(2)

    new SaveManager().quickSave(craftSave({ sceneId: 'tail', eventIndex: 2 }))
    const r3 = makeRenderer(TAIL_SCENES)
    expect(await r3.quickLoad()).toEqual({ status: 'entered', sceneId: 'tail' })
    expect(r3.getSnapshot().eventIndex).toBe(2)
  })

  it('[条件:] が全て偽で長さ 0 のシーンは eventIndex 0 が終端として有効', async () => {
    const scenes = [scene('empty', [condition('never', [narration('x')])])]
    const r = makeRenderer(scenes)
    expect(await r.restoreSnapshot(craftSnapshot({ sceneId: 'empty', eventIndex: 0 }))).toEqual({
      status: 'entered',
      sceneId: 'empty',
    })
    expect(await r.restoreSnapshot(craftSnapshot({ sceneId: 'empty', eventIndex: 1 }))).toEqual({
      status: 'failed',
      reason: 'out-of-range',
    })
  })
})

describe('ライブ切り替えで textIndex を範囲内に戻す (#789)', () => {
  it('setSentencePerPage / setDialogStyle 後の textIndex は現在のページ数未満で、スナップショットが復元できる', async () => {
    const r = makeRenderer([scene('p', [narration('一文目。二文目。三文目。')])])
    r.setSentencePerPage(true)
    r.startFrom({ sceneId: 'p' })
    r.advance()
    r.advance()
    expect(r.getSnapshot().textIndex).toBe(2)

    r.setSentencePerPage(false) // 1 ページ（text[] は 1 行）になる
    const snap = r.getSnapshot()
    expect(snap.textIndex).toBe(0)
    expect(snap.sentenceIndex).toBe(0)

    const r2 = makeRenderer([scene('p', [narration('一文目。二文目。三文目。')])])
    expect(await r2.restoreSnapshot(snap)).toEqual({ status: 'entered', sceneId: 'p' })
  })

  it('ノベルで2ページ目にいる状態から setDialogStyle("adv") に切り替えると textIndex が範囲内（0）に戻り、スナップショットが復元できる', async () => {
    const events = [scene('n', [narration('一行だけの本文。')])]
    const r = makeRenderer(events)
    r.setDialogStyle('novel')
    r.startFrom({ sceneId: 'n' })
    // ノベルの改頁は表示幅の計測（初期化後）が要るので、2ページ目にいる状態を直接作る。
    ;(r as unknown as { textIndex: number }).textIndex = 1
    expect(r.getSnapshot().textIndex).toBe(1)

    r.setDialogStyle('adv') // adv では 1 行 = 1 ページなので 1 ページ目へ寄る
    const snap = r.getSnapshot()
    expect(snap.textIndex).toBe(0)
    expect(snap.sentenceIndex).toBe(0)

    const r2 = makeRenderer(events)
    expect(await r2.restoreSnapshot(snap)).toEqual({ status: 'entered', sceneId: 'n' })
  })
})
