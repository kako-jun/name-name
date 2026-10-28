/**
 * 再生カーソル (#824, PlaybackCursor) 経由の位置・履歴更新が、リファクタ前と 1 バイトも変わらないことの回帰テスト。
 *
 * 期待 JSON は、リファクタ前の実装（origin/main の `NovelRenderer.ts`）で同じシナリオを実測して得た値。
 * 実測手順: `git show origin/main:frontend/src/game/NovelRenderer.ts > frontend/src/game/NovelRendererOld.ts`
 * を一時的に置き、本テストの import だけを `./NovelRendererOld` に差し替えて実行すると、同じ値で緑になる
 * （確認後に一時ファイルを消す。コミットしない）。先行の NovelRenderer.snapshotJson.test.ts と同じ作法。
 *
 * シナリオ（novel）: 3 ページに改頁される本文 → Flag → Condition(展開) → 本文。
 * 本文送り・戻る・シーク・クイックセーブ→別インスタンスへロードの各局面で getSnapshot() を固定する。
 * #799: 元列に `[条件:]` を含むので、入場時 flags（`entryFlags`）が末尾に加わる（既存のキーの値と順序は不変）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

const narr = (s: string): Event => ({ Narration: { text: [s] } })

function measureNovelCap(): number {
  const probe = new NovelRenderer()
  probe.setDialogStyle('novel')
  return (
    probe as unknown as { dialogBox: { novelMaxLinesPerPage(): number } }
  ).dialogBox.novelMaxLinesPerPage()
}
const CAP = measureNovelCap()
/** ちょうど 3 ページ（cap, cap, 1 文）に改頁される本文。 */
const THREE_PAGE_TEXT = Array.from({ length: CAP * 2 + 1 }, (_, k) => `${k + 1}。`).join('')
const TOTAL_ADVANCES_TO_COND = CAP * 2 + 1

const SCENES: EventScene[] = [
  {
    id: 'a',
    title: 'シーンA',
    view: 'TopDown',
    events: [
      narr(THREE_PAGE_TEXT),
      { Flag: { name: 'seen', value: { Bool: true } } },
      { Condition: { flag: 'seen', events: [narr('c0。c1。')] } },
      narr('tail'),
    ],
  },
]

function makeRenderer(): NovelRenderer {
  const r = new NovelRenderer()
  r.setDialogStyle('novel')
  r.setScenes(SCENES)
  r.startFrom({ sceneId: 'a' })
  return r
}

async function advanceN(r: NovelRenderer, n: number): Promise<void> {
  await r.playScript(Array.from({ length: n }, () => ({ type: 'advance' as const })))
}

const json = (r: NovelRenderer): string => JSON.stringify(r.getSnapshot())

/** 期待値(origin/main の実装で実測)。 */
const EXPECTED = {
  midPage:
    '{"sceneId":"a","eventIndex":0,"textIndex":2,"sentenceIndex":0,"flags":{},"backgroundPath":null,"backgroundColor":null,"backgroundFade":null,"backgroundBrightness":null,"video":null,"eventImage":null,"backgroundBoards":[],"props":[],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[],"currentBgmPath":null,"cameraMode":"Novel","cameraOrientation":"Audience","cameraElevation":null,"cameraZoom":null,"paperDollOutline":null,"storyEnded":false,"entryFlags":{}}',
  atCondition:
    '{"sceneId":"a","eventIndex":2,"textIndex":0,"sentenceIndex":0,"flags":{"seen":{"Bool":true}},"backgroundPath":null,"backgroundColor":null,"backgroundFade":null,"backgroundBrightness":null,"video":null,"eventImage":null,"backgroundBoards":[],"props":[],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[],"currentBgmPath":null,"cameraMode":"Novel","cameraOrientation":"Audience","cameraElevation":null,"cameraZoom":null,"paperDollOutline":null,"storyEnded":false,"entryFlags":{}}',
  backFromCondition:
    '{"sceneId":"a","eventIndex":0,"textIndex":0,"sentenceIndex":0,"flags":{},"backgroundPath":null,"backgroundColor":null,"backgroundFade":null,"backgroundBrightness":null,"video":null,"eventImage":null,"backgroundBoards":[],"props":[],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[],"currentBgmPath":null,"cameraMode":"Novel","cameraOrientation":"Audience","cameraElevation":null,"cameraZoom":null,"paperDollOutline":null,"storyEnded":false,"entryFlags":{}}',
  afterSeekCondition:
    '{"sceneId":"a","eventIndex":2,"textIndex":0,"sentenceIndex":0,"flags":{"seen":{"Bool":true}},"backgroundPath":null,"backgroundColor":null,"backgroundFade":null,"backgroundBrightness":null,"video":null,"eventImage":null,"backgroundBoards":[],"props":[],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[],"currentBgmPath":null,"cameraMode":"Novel","cameraOrientation":"Audience","cameraElevation":null,"cameraZoom":null,"paperDollOutline":null,"storyEnded":false,"entryFlags":{}}',
  afterSeekHead:
    '{"sceneId":"a","eventIndex":0,"textIndex":0,"sentenceIndex":0,"flags":{},"backgroundPath":null,"backgroundColor":null,"backgroundFade":null,"backgroundBrightness":null,"video":null,"eventImage":null,"backgroundBoards":[],"props":[],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[],"currentBgmPath":null,"cameraMode":"Novel","cameraOrientation":"Audience","cameraElevation":null,"cameraZoom":null,"paperDollOutline":null,"storyEnded":false,"entryFlags":{}}',
}

describe('再生カーソル経由の getSnapshot() の JSON 回帰 (#824)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('前提: シナリオが期待どおり進む（3 ページ目の先頭 → Flag 後に Condition 展開で本文へ）', async () => {
    const r = makeRenderer()
    await advanceN(r, CAP * 2)
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 2, sentenceIndex: 0 })
    await advanceN(r, 1)
    expect(r.getSnapshot().flags).toEqual({ seen: { Bool: true } })
    expect(r.getSnapshot().eventIndex).toBeGreaterThan(0)
  })

  it('本文送り → 戻る → シーク後の getSnapshot() が固定された期待と一致する', async () => {
    const r = makeRenderer()
    await advanceN(r, CAP * 2)
    expect(json(r)).toBe(EXPECTED.midPage)
    await advanceN(r, 1)
    expect(json(r)).toBe(EXPECTED.atCondition)
    r.goBack()
    expect(json(r)).toBe(EXPECTED.backFromCondition)
    await advanceN(r, TOTAL_ADVANCES_TO_COND + 2)
    r.seekTo(1)
    expect(json(r)).toBe(EXPECTED.afterSeekCondition)
    r.seekTo(0)
    expect(json(r)).toBe(EXPECTED.afterSeekHead)
  })

  it('クイックセーブ → 別インスタンスへロード → getSnapshot() が一致する往復（位置・履歴の復元）', async () => {
    const r1 = makeRenderer()
    await advanceN(r1, CAP + 1) // 2 ページ目の途中
    const before = json(r1)
    expect(r1.quickSave()).toBe(true)

    const r2 = makeRenderer()
    expect(json(r2)).not.toBe(before)
    expect(await r2.quickLoad()).not.toBeNull()
    expect(json(r2)).toBe(before)
    // 復元後も続きが同じように進む（カーソルと履歴が正しく復元されている）
    await advanceN(r1, 2)
    await advanceN(r2, 2)
    expect(json(r2)).toBe(json(r1))
    r1.goBack()
    r2.goBack()
    expect(json(r2)).toBe(json(r1))
  })

  it('Condition 展開後の局面でもクイックセーブ → 別インスタンスのロードで一致する', async () => {
    const r1 = makeRenderer()
    await advanceN(r1, TOTAL_ADVANCES_TO_COND)
    const before = json(r1)
    expect(JSON.parse(before).flags).toEqual({ seen: { Bool: true } })
    expect(r1.quickSave()).toBe(true)
    const r2 = makeRenderer()
    expect(await r2.quickLoad()).not.toBeNull()
    expect(json(r2)).toBe(before)
  })
})
