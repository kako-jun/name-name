/**
 * NovelRenderer の「はじめから」旧セーブ引きずり修正のテスト (#637)。
 *
 * GUI 版の「はじめから」（`PlayerScreen.onNewGame`）は #578 の自動クイックロードが復元した
 * 旧セッションの flags/currentSceneId/クイックセーブを完全に切り離す必要がある。
 * - `restart()` は `setScenes()` と対称に `gameState.clear()` / `currentSceneId` を
 *   `allScenes[0]`（エントリ doc 先頭）にリセットするようになった。
 * - `clearQuickSave()` は `restart()` がシーン切り替え検知（`onSceneChangeCallback`）を
 *   経由しないため自動上書きされない旧クイックセーブを、呼び出し側が明示的に消去する新設メソッド。
 *
 * `NovelRenderer.confinement.test.ts` / `NovelRenderer.intermission.test.ts` と同じ最小構成
 * （`new NovelRenderer()` → `setScenes(...)`）で行い、PixiJS 実描画は対象外
 * （CLAUDE.md ルール7 の実機 golden path に委ねる）。
 *
 * 各 it() の先頭数字は #637 回帰テスト全体（本ファイル + `SaveManager.test.ts` +
 * `PlayerScreen.test.tsx`）を通した観点番号 1〜15。本ファイルは 1-7・14-15 を持ち、
 * 8 は `SaveManager.test.ts`（docKey 別インスタンス間の deleteQuickSave() 非干渉。
 * 双方向の非干渉を1テストで検証しており、別観点として独立させなかったため 9 は
 * 欠番のまま）、10-13 は `PlayerScreen.test.tsx`（onNewGame からの clearQuickSave() 呼び出し）
 * に対応する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene, FlagValue } from '../types'

// --- fixture helpers（confinement.test.ts / intermission.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

// entry: 単純な開始シーン
// route: Flag ディレクティブを冒頭に持つ（scene 開始時に processUntilNextTextEvent で自動処理される）
// branch: route_milestone フラグで内容が変わる Condition を持つ
const SCENES: EventScene[] = [
  scene('entry', [narration('start')]),
  scene('route', [
    { Flag: { name: 'route_milestone', value: { Bool: true } } } as Event,
    narration('progressed'),
  ]),
  scene('branch', [
    { Condition: { flag: 'route_milestone', events: [narration('flagged-content')] } } as Event,
    narration('base-content'),
  ]),
]

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** #637 検証用の内部アクセサ（他 NovelRenderer.*.test.ts と同じ internals 直代入の割り切り） */
interface RendererInternals {
  gameState: { setFlag: (name: string, value: FlagValue) => void }
  currentSceneId: string | null
  resolvedEvents: Event[]
  saveManager: { deleteQuickSave: () => void }
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function narrationTexts(events: Event[]): string[] {
  return events
    .filter(
      (e): e is { Narration: { text: string[] } } =>
        typeof e === 'object' && e !== null && 'Narration' in e
    )
    .map((e) => e.Narration.text[0])
}

describe('NovelRenderer.restart() の gameState/currentSceneId リセット (#637)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1: flags を設定した状態で restart() を呼ぶと gameState の flags が空になる（正常系）', () => {
    const r = makeRenderer(SCENES)
    internals(r).gameState.setFlag('visited', { Bool: true })
    expect(r.getSnapshot().flags).toEqual({ visited: { Bool: true } })

    r.restart()

    expect(r.getSnapshot().flags).toEqual({})
  })

  it('2: 複数シーンで2番目以降のシーンに遷移後 restart() すると currentSceneId が allScenes[0].id（entry 先頭）に戻る（境界=1/+1）', () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('branch')
    expect(r.getCurrentSceneId()).toBe('branch')

    r.restart()

    expect(r.getCurrentSceneId()).toBe('entry')
    expect(r.getCurrentSceneId()).toBe(r.getAllSceneIds()[0])
  })

  it('3: allScenes が空の状態で restart() すると currentSceneId が null になる（境界-1・防御）', () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('branch') // currentSceneId='branch' / rawEvents は空でない状態を作る
    r.setJumpSceneIndex([]) // ジャンプ索引（allScenes）だけを空にする

    r.restart()

    expect(r.getCurrentSceneId()).toBeNull()
  })

  it('4: rawEvents が空の状態（未初期化 renderer）で restart() を呼んでも例外にならず gameState/currentSceneId は変化しない（早期 return）', () => {
    const r = new NovelRenderer() // setScenes/setEvents を呼ばない = rawEvents は既定の空配列
    internals(r).gameState.setFlag('pristine', { Bool: true })
    internals(r).currentSceneId = 'untouched-scene'

    expect(() => r.restart()).not.toThrow()

    expect(r.getSnapshot().flags).toEqual({ pristine: { Bool: true } })
    expect(r.getCurrentSceneId()).toBe('untouched-scene')
  })

  it('5: restart() は onSceneChangeCallback を発火しない（#578 自動 quickSave 非発火の設計を固定化する回帰）', () => {
    const r = makeRenderer(SCENES)
    const cb = vi.fn()
    r.setOnSceneChange(cb) // setScenes() 内での初回発火より後に付け替えるので、この時点では未発火

    r.restart()

    expect(cb).not.toHaveBeenCalled()
  })
})

describe('NovelRenderer.clearQuickSave() (#637)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('6: clearQuickSave() は内部の saveManager.deleteQuickSave() を呼ぶ（spy検証）', () => {
    const r = makeRenderer(SCENES)
    const spy = vi.spyOn(internals(r).saveManager, 'deleteQuickSave')

    r.clearQuickSave()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('7: quickSave が存在しない状態で clearQuickSave() を呼んでも例外にならない', () => {
    const r = makeRenderer(SCENES)
    r.setDocKey('doc-637-7')
    expect(r.hasQuickSave()).toBe(false)

    expect(() => r.clearQuickSave()).not.toThrow()

    expect(r.hasQuickSave()).toBe(false)
  })
})

describe('NovelRenderer #637 統合: 「はじめから」相当のフラグ/クイックセーブ完全リセット', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 14: 本丸。旧セッションでフラグを立てたまま quickSave された状態から「はじめから」相当
  // （clearQuickSave() → restart()、PlayerScreen.onNewGame と同じ呼び出し順）を実行すると、
  // 以後 quickLoad() は旧データを復元せず、フラグもクリアされ、events も entry シーン
  // （entryRawEvents）まで巻き戻ることを確認する（#662 修正後の期待挙動）。
  it('14: milestone フラグを立てて route まで進行→はじめから相当実行後、quickLoad() は復元せず events は entry シーンまで巻き戻る（本丸）', () => {
    const r = makeRenderer(SCENES)
    r.setDocKey('doc-637-14')

    r.jumpToScene('route') // 冒頭の Flag ディレクティブが自動処理され route_milestone=true になる
    expect(r.getSnapshot().flags).toEqual({ route_milestone: { Bool: true } })

    r.jumpToScene('branch') // フラグが立っているので Condition 内の 'flagged-content' が展開される
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['flagged-content', 'base-content'])

    // #578 自動クイックセーブ相当: 旧セッションのクイックセーブに flag=true / sceneId='branch' が残る
    expect(r.quickSave()).toBe(true)
    expect(r.hasQuickSave()).toBe(true)

    // 「はじめから」相当: PlayerScreen.onNewGame と同じ順序（clearQuickSave() → restart()）で呼ぶ
    r.clearQuickSave()
    r.restart()

    // 旧クイックセーブはもう復元されない
    expect(r.quickLoad()).toBe(false)
    // フラグもクリアされている
    expect(r.getSnapshot().flags).toEqual({})
    // #662: restart() は rawEvents（branch まで進行した直前ルートの内容）ではなく
    // entryRawEvents（setScenes() 時点の entry シーン）を再生する。branch の
    // 'flagged-content'/'base-content' には戻らず、entry の 'start' になる。
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['start'])
  })

  // 15: #637 本体の症状そのものの再現テスト。一度もシーン遷移していない状態（entry のまま）でも
  // hasQuickSave() が false のままであることを確認する。restart() 単体は onSceneChangeCallback を
  // 発火しないため自動クイックセーブに頼れない（設計エージェントが確認した重要な事実）。
  // clearQuickSave() を明示していなければここは true のまま（旧クイックセーブ復活）になっていた。
  it('15: 「はじめから」操作（clearQuickSave()+restart()）直後、一度もシーン遷移していなくても hasQuickSave() は false のまま（#637本体症状の再現・最重要）', () => {
    const r = makeRenderer(SCENES) // entry のまま
    r.setDocKey('doc-637-15')
    expect(r.quickSave()).toBe(true) // 旧セッションのクイックセーブが存在する状態を作る
    expect(r.hasQuickSave()).toBe(true)

    r.clearQuickSave()
    r.restart()

    // シーン遷移は一切していない（entry のまま）。それでも旧クイックセーブは復活しない。
    expect(r.hasQuickSave()).toBe(false)
    expect(r.getCurrentSceneId()).toBe('entry')
  })
})
