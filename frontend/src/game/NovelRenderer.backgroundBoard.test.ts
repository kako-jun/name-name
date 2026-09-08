/**
 * NovelRenderer BackgroundBoard 配線統合テスト (#683)。
 *
 * BackgroundBoardLayer 自体の幾何・スライドイン挙動は BackgroundBoardLayer.test.ts でカバー済み。
 * ここでは NovelRenderer 側の配線（settled state としての蓄積・[場面転換]でのクリア・
 * シーン間ジャンプでの持ち越し・goBack の宣言的復元）だけを検証する
 * （NovelRenderer.cameraMode.test.ts と同形。`getSnapshot()` の backgroundBoards を直接読む）。
 *
 * `setScenes()` はそれ自体が scenes[0] を自動開始する（内部で `setEvents()` → 冒頭の非テキスト
 * ディレクティブを最初のテキストイベントまで即時実行する、#293/#409 と同じ規律）。scenes[0] を
 * 対象にした `startFrom({sceneId: scenes[0].id})` を setScenes 直後に重ねて呼ぶと、冒頭の
 * ディレクティブが二重に実行されてしまう（Background 等の単一スロット状態では上書きなので
 * 無害だが、BackgroundBoard は加算的なため二重登録として顕在化する）。このファイルでは
 * scenes[0] を対象にした冒頭ディレクティブの検証は `setScenes()` の自動開始結果をそのまま読み、
 * 別シーンへの遷移が必要な検証だけ `jumpToScene`/`goBack`/`playScript` を使う。
 *
 * `assetBaseUrl` を設定しないため `Assets.load` は呼ばれない（BackgroundBoardLayer.add() の
 * ガード。NovelRenderer.cameraMode.test.ts と同じ流儀で、状態配線だけを軽量に検証できる）。
 */
import { describe, expect, it } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function backgroundBoard(path: string, depth?: number): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

describe('NovelRenderer BackgroundBoard 配線 (#683)', () => {
  it('本文しかないシーンは backgroundBoards が空配列のまま', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('複数の [背景板:] が加算的に蓄積される（単一スロット背景とは異なる意味論）', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        backgroundBoard('sky.png', 10),
        backgroundBoard('mountain.png', 7),
        backgroundBoard('tree.png', 4),
        narration('one'),
      ]),
    ])
    // setScenes の自動開始が冒頭の3つの [背景板:] を最初のテキストイベント（'one'）まで
    // 即時実行済み（Background 等の演出ディレクティブと同じ規律）。
    expect(r.getSnapshot().backgroundBoards).toEqual([
      { path: 'sky.png', depth: 10 },
      { path: 'mountain.png', depth: 7 },
      { path: 'tree.png', depth: 4 },
    ])
  })

  it('depth 省略時は 0（最前面）として蓄積される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [backgroundBoard('board.png'), narration('one')])])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'board.png', depth: 0 }])
  })

  it('[場面転換] は既存の単一スロット背景と同じタイミングで背景板もクリアする', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        backgroundBoard('sky.png', 10),
        narration('one'),
        'SceneTransition',
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    await r.playScript([{ type: 'advance' }]) // one -> SceneTransition(clear) -> two
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('通常のシーン間ジャンプ（jumpToScene）では既存の単一スロット背景と同じく持ち越される', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [backgroundBoard('sky.png', 10), narration('one')]),
      scene('b', [narration('two')]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    r.jumpToScene('b')
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
  })

  it('setEvents() を再度呼ぶ（新しいイベント列の開始・非 preserve 分岐）と既存の背景板はクリアされる', () => {
    const r = new NovelRenderer()
    r.setEvents([backgroundBoard('sky.png', 10), narration('one')])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    r.setEvents([narration('two')])
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('goBack（スナップショットベースの宣言的復元）で [背景板:] 実行前の状態に戻る', async () => {
    const r = new NovelRenderer()
    // 'one' が先頭のテキストイベントなので、自動開始はここで停止する（冒頭ディレクティブなし）。
    r.setScenes([scene('a', [narration('one'), backgroundBoard('sky.png', 10), narration('two')])])
    expect(r.getSnapshot().backgroundBoards).toEqual([])

    await r.playScript([{ type: 'advance' }]) // one -> board(directive) -> two
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    r.goBack() // two -> one（board 実行前のスナップショットへ）
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })
})
