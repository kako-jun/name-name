/**
 * NovelRenderer の「はじめから」旧セーブ引きずり修正のテスト (#637)。
 *
 * GUI 版の「はじめから」（`PlayerScreen.onNewGame`）は #578 の自動クイックロードが復元した
 * 旧セッションの flags/currentSceneId/クイックセーブを完全に切り離す必要がある。
 * - `startFrom({})`（旧 `restart()`。#734 PR5 で廃止）は flags を置換し、`currentSceneId` を
 *   エントリ doc 先頭（`entrySceneId`）に揃える。
 * - `clearQuickSave()` は、新規開始の自動セーブが最初の本文の表示まで行われないため、その間に
 *   リロードされても復活してしまう旧クイックセーブを、呼び出し側が明示的に消去するメソッド。
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

// #662 T2/T4 検証用: NovelPlayer が events-prop 変化 effect で「別のエントリ文書」を
// 流し込み直すケースを模した2番目の setEvents() 呼び出し用フィクスチャ。
// SCENES とは無関係な独立コンテンツであることが分かるよう内容を明確に区別する。
const ENTRY_B_EVENTS: Event[] = [narration('entry-b-start')]

/** #637 検証用の内部アクセサ（他 NovelRenderer.*.test.ts と同じ internals 直代入の割り切り） */
interface RendererInternals {
  gameState: { setFlag: (name: string, value: FlagValue) => void }
  currentSceneId: string | null
  resolvedEvents: Event[]
  saveManager: { deleteQuickSave: () => void }
  // #662 検証用: rawEvents（quickLoad/restoreToScene で直前ルートの内容に上書きされうる
  // 可変フィールド）と entryRawEvents（setEvents() でのみ更新されるエントリ文書スナップショット）
  rawEvents: Event[]
  entryRawEvents: Event[]
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

describe('NovelRenderer.startFrom({}) の gameState/currentSceneId リセット (#637)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1: flags を設定した状態で startFrom({}) を呼ぶと gameState の flags が空になる（正常系）', () => {
    const r = makeRenderer(SCENES)
    internals(r).gameState.setFlag('visited', { Bool: true })
    expect(r.getSnapshot().flags).toEqual({ visited: { Bool: true } })

    void r.startFrom({})

    expect(r.getSnapshot().flags).toEqual({})
  })

  it('2: 複数シーンで2番目以降のシーンに遷移後 startFrom({}) すると currentSceneId が allScenes[0].id（entry 先頭）に戻る（境界=1/+1）', () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('branch')
    expect(r.getCurrentSceneId()).toBe('branch')

    void r.startFrom({})

    expect(r.getCurrentSceneId()).toBe('entry')
    expect(r.getCurrentSceneId()).toBe(r.getAllSceneIds()[0])
  })

  it('3: allScenes が空の状態で startFrom({}) しても currentSceneId は entrySceneId（setScenes のエントリ）に戻る（境界-1・防御 #768）', () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('branch') // currentSceneId='branch' / rawEvents は空でない状態を作る
    r.setJumpSceneIndex([]) // ジャンプ索引（allScenes）だけを空にする

    void r.startFrom({})

    expect(r.getCurrentSceneId()).toBe(SCENES[0].id)
  })

  it('4: エントリ文書が未読み込み（未初期化 renderer）でも startFrom({}) は例外にならず、空の文書からの新規開始として flags と currentSceneId をリセットする (#734 PR5)', async () => {
    const r = new NovelRenderer() // setScenes/setEvents を呼ばない = entryRawEvents は既定の空配列
    internals(r).gameState.setFlag('pristine', { Bool: true })
    internals(r).currentSceneId = 'untouched-scene'

    await expect(r.startFrom({})).resolves.toEqual({ status: 'entered', sceneId: null })

    expect(r.getSnapshot().flags).toEqual({})
    expect(r.getCurrentSceneId()).toBeNull()
  })

  it('5: startFrom({}) は新規開始として onSceneChangeCallback をエントリのシーンIDで1回発火する（ADR 0003 §2。旧 restart() は発火しなかった）', () => {
    const r = makeRenderer(SCENES)
    const cb = vi.fn()
    r.setOnSceneChange(cb) // setScenes() 内での初回発火より後に付け替えるので、この時点では未発火

    void r.startFrom({})

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('entry')
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
  // （clearQuickSave() → startFrom({})、PlayerScreen.onNewGame と同じ呼び出し順）を実行すると、
  // 以後 quickLoad() は旧データを復元せず、フラグもクリアされ、events も entry シーン
  // （entryRawEvents）まで巻き戻ることを確認する（#662 修正後の期待挙動）。
  it('14: milestone フラグを立てて route まで進行→はじめから相当実行後、quickLoad() は復元せず events は entry シーンまで巻き戻る（本丸）', async () => {
    const r = makeRenderer(SCENES)
    r.setDocKey('doc-637-14')

    r.jumpToScene('route') // 冒頭の Flag ディレクティブが自動処理され route_milestone=true になる
    expect(r.getSnapshot().flags).toEqual({ route_milestone: { Bool: true } })

    r.jumpToScene('branch') // フラグが立っているので Condition 内の 'flagged-content' が展開される
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['flagged-content', 'base-content'])

    // #578 自動クイックセーブ相当: 旧セッションのクイックセーブに flag=true / sceneId='branch' が残る
    expect(r.quickSave()).toBe(true)
    expect(r.hasQuickSave()).toBe(true)

    // 「はじめから」相当: PlayerScreen.onNewGame と同じ順序（clearQuickSave() → startFrom({})）で呼ぶ
    r.clearQuickSave()
    void r.startFrom({})

    // 旧クイックセーブはもう復元されない
    expect(await r.quickLoad()).toBeNull()
    // フラグもクリアされている
    expect(r.getSnapshot().flags).toEqual({})
    // #662: startFrom({}) は rawEvents（branch まで進行した直前ルートの内容）ではなく
    // entryRawEvents（setScenes() 時点の entry シーン）を再生する。branch の
    // 'flagged-content'/'base-content' には戻らず、entry の 'start' になる。
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['start'])
  })

  // 15: #637 本体の症状そのものの再現テスト。一度もシーン遷移していない状態（entry のまま）でも
  // hasQuickSave() が false のままであることを確認する。startFrom({}) 単体は onSceneChangeCallback を
  // 発火しないため自動クイックセーブに頼れない（設計エージェントが確認した重要な事実）。
  // clearQuickSave() を明示していなければここは true のまま（旧クイックセーブ復活）になっていた。
  it('15: 「はじめから」操作（clearQuickSave()+startFrom({})）直後、一度もシーン遷移していなくても hasQuickSave() は false のまま（#637本体症状の再現・最重要）', () => {
    const r = makeRenderer(SCENES) // entry のまま
    r.setDocKey('doc-637-15')
    expect(r.quickSave()).toBe(true) // 旧セッションのクイックセーブが存在する状態を作る
    expect(r.hasQuickSave()).toBe(true)

    r.clearQuickSave()
    void r.startFrom({})

    // シーン遷移は一切していない（entry のまま）。それでも旧クイックセーブは復活しない。
    expect(r.hasQuickSave()).toBe(false)
    expect(r.getCurrentSceneId()).toBe('entry')
  })
})

describe('NovelRenderer #662: startFrom({}) は entryRawEvents を再生し quickLoad 後も直前ルートに引きずられない', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 16 (T3・最重要): quickLoad() を実際に呼んで rawEvents が route の内容に上書きされた
  // 状態から startFrom({}) すると、resolvedEvents は route/branch の内容ではなく entry の
  // 'start' に戻る。既存テスト14は startFrom({}) より前に quickLoad() を呼んでおらず、この
  // 経路（自動 quickLoad 相当）は #662 修正前は完全にノーカバレッジだった。
  it('16: route まで進行→quickSave→quickLoad実行（rawEventsがroute内容に上書き）→startFrom({})後、resolvedEventsはroute/branchでなくentryの内容になる（本丸）', async () => {
    const r = makeRenderer(SCENES)
    r.setDocKey('doc-662-16')

    r.jumpToScene('route') // 冒頭の Flag ディレクティブが自動処理され route_milestone=true になる
    expect(r.getSnapshot().flags).toEqual({ route_milestone: { Bool: true } })

    expect(r.quickSave()).toBe(true)
    // #578/#620 の自動 quickLoad 相当: 実際に quickLoad() を呼び restoreToScene() 経由で
    // rawEvents が route の内容（'progressed'）に上書きされる状態を作る。
    expect(await r.quickLoad()).not.toBeNull()
    expect(narrationTexts(internals(r).rawEvents)).toEqual(['progressed'])

    void r.startFrom({})

    // #662 修正前は rawEvents（route内容）をそのまま再生し 'progressed' が残っていた。
    // 修正後は entryRawEvents を参照するため entry の 'start' に戻る。
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['start'])
  })

  // 17 (T3 補助アサーション): 16 と同じ手順で、quickLoad() 直後（startFrom({}) より前）の
  // 内部状態を確認する。rawEvents は route の内容に上書きされる一方、entryRawEvents は
  // setScenes() 時点のエントリ内容のまま無傷であることを直接検証する。
  it('17: quickLoad() 実行直後、rawEventsはroute内容に上書きされるがentryRawEventsはentry内容のまま変化しない', async () => {
    const r = makeRenderer(SCENES)
    r.setDocKey('doc-662-17')

    r.jumpToScene('route')
    expect(r.quickSave()).toBe(true)

    // quickLoad() 前: entryRawEvents は setScenes() 由来の entry 内容
    expect(narrationTexts(internals(r).entryRawEvents)).toEqual(['start'])

    expect(await r.quickLoad()).not.toBeNull()

    // quickLoad() 後: rawEvents は route の内容に上書きされている
    expect(narrationTexts(internals(r).rawEvents)).toEqual(['progressed'])
    // しかし entryRawEvents は無傷（setEvents() 経由でしか更新されないため）
    expect(narrationTexts(internals(r).entryRawEvents)).toEqual(['start'])
  })

  // 18 (T2): setEvents() が複数回呼ばれた場合、startFrom({}) は「最後に」setEvents された
  // エントリ内容を再生する（NovelPlayer の events-prop 変化 effect が2回目の setEvents() を
  // 呼ぶケースを模す）。
  it('18: setEvents()が複数回呼ばれた後にstartFrom({})すると、最後にsetEventsされた内容(entryRawEvents)を再生する', () => {
    const r = makeRenderer(SCENES) // 1回目の setEvents は setScenes() 内部から呼ばれる（entry内容）
    r.jumpToScene('route') // 何らかの操作（ルート遷移）

    // NovelPlayer の events-prop 変化 effect を模した2回目の setEvents() 呼び出し。
    // SCENES とは無関係な別のエントリ文書内容に差し替える。
    r.setEvents(ENTRY_B_EVENTS)

    void r.startFrom({})

    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['entry-b-start'])
  })

  // 19 (T4・T2+T3複合): 18 の手順の後、さらに route へ遷移して quickSave/quickLoad を行い
  // rawEvents が route 内容に上書きされても、startFrom({}) は（route 内容にも旧entry内容にも
  // 戻らず）最後に setEvents された SCENES_B 側のエントリ内容に戻る。
  it('19: setEvents複数回呼び出し後にquickLoadでrawEventsが上書きされても、startFrom({})は最後のsetEvents内容に戻る', async () => {
    const r = makeRenderer(SCENES)
    r.setDocKey('doc-662-19')

    r.jumpToScene('route') // 1周目の操作
    r.setEvents(ENTRY_B_EVENTS) // 2回目の setEvents（entryRawEvents が B 側に更新される）

    // allScenes は setScenes(SCENES) 時点のまま（setEvents は allScenes を変更しない）ので
    // 'route' への再遷移は可能。ここで quickSave→quickLoad し rawEvents を route 内容に上書きする。
    r.jumpToScene('route')
    expect(r.quickSave()).toBe(true)
    expect(await r.quickLoad()).not.toBeNull()
    expect(narrationTexts(internals(r).rawEvents)).toEqual(['progressed'])

    void r.startFrom({})

    // route の内容にも SCENES の entry('start') にも戻らず、最後に setEvents された
    // ENTRY_B_EVENTS の内容に戻る。
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['entry-b-start'])
  })

  // 20 (T7): エントリ文書を一度も供給していない（entryRawEvents が空）が rawEvents は非空（setEvents
  // 未経由の jumpToScene）という状態から startFrom({}) すると、再生中の rawEvents（branch の内容）
  // ではなく、エントリ文書（空）からの新規開始になる。#662 の「rawEvents を再生しない」契約の
  // entryRawEvents 版（旧 restart() は空なら早期 return だったが、新規開始は空の文書も新規開始する）。
  it('20: entryRawEventsが空でrawEventsは空でない状態（setEvents未経由のjumpToScene）でstartFrom({})すると、rawEventsではなくエントリ（空）を新規開始する（#662・#734 PR5）', () => {
    const r = new NovelRenderer() // setScenes/setEvents 未呼び出し = entryRawEvents は既定の空配列
    r.setJumpSceneIndex(SCENES) // allScenes（ジャンプ索引）だけ設定。setEvents は呼ばれない
    r.jumpToScene('branch') // rawEvents は branch の内容で非空になる。entryRawEvents は空のまま
    expect(narrationTexts(internals(r).rawEvents)).toEqual(['base-content'])

    expect(() => r.startFrom({})).not.toThrow()

    expect(internals(r).rawEvents).toEqual([])
    expect(internals(r).resolvedEvents).toEqual([])
    expect(r.getCurrentSceneId()).toBeNull()
  })

  // 21 (冪等性・補強): startFrom({}) を連続で2回呼んでも例外にならず、2回目の後も
  // entryRawEvents の内容（entry）のまま変化しない。startFrom({}) 自体が entryRawEvents を
  // 書き換えてしまう将来のリグレッションを防ぐ。
  it('21: startFrom({})を連続2回呼んでも例外にならず、2回目後も同じentry内容のまま（冪等性）', async () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('route')
    expect(r.quickSave()).toBe(true)
    expect(await r.quickLoad()).not.toBeNull()

    void r.startFrom({})
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['start'])

    expect(() => r.startFrom({})).not.toThrow()
    expect(narrationTexts(internals(r).resolvedEvents)).toEqual(['start'])
  })
})
