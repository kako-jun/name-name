/**
 * NovelRenderer のセーブデータ復元 loadFromSaveData の動作テスト (#256)。
 *
 * #256 で loadFromSaveData / startFrom は共通コア restoreToScene に統合された。
 * restoreToScene のリセット/履歴/Condition 展開といった「共有部分」は
 * NovelRenderer.startFrom.test.ts が startFrom 経由で広く検証している。
 * このファイルは loadFromSaveData に固有の振る舞いに絞る:
 *
 *  - sceneId 空 / シーン未発見 / 正常 の 3 分岐
 *  - 「シーンが無くてもフラグだけは復元する」という loadFromSaveData 固有の
 *    挙動（startFrom は完全 no-op なのと対照的）
 *  - SaveSlotData の各フィールド（eventIndex/textIndex/flags/isBlackout/
 *    backgroundFade/video）が NovelGameState へ正しく写し取られること
 *  - 後方互換（video / isBlackout / characters 欠如の旧セーブ）
 *  - 復元後の history が現在位置 1 件にリセットされること
 *
 * loadFromSaveData は private なので、公開 API の golden path である
 * quickSave()/quickLoad()（共に localStorage の同一キーを共有する SaveManager 経由）
 * から駆動する。crafted な SaveSlotData は SaveManager.quickSave() で直接書き込む。
 *
 * PixiJS 実描画・音声・アセット読込を伴う状態（backgroundPath / characters /
 * currentBgmPath の非 null）は jsdom では検証できないため、startFrom.test.ts と
 * 同様にこれらは null/空に固定し、実機 golden path に委ねる（CLAUDE.md ルール7）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { NovelGameState } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'
import { SaveManager, SaveSlotData } from './SaveManager'

// --- fixture helpers（startFrom.test.ts と同じスタイル） ---

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
  r.setScenes(scenes)
  return r
}

/** loadFromSaveData 検証用の内部アクセサ（startFrom.test.ts と同じ） */
interface RendererInternals {
  history: unknown[]
  justSelectedChoice: boolean
  applyState(state: NovelGameState): void
  initialized: boolean
  waitingForChoice: boolean
  waitingForWait: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * `init()` 完了後の状態を模す (#578: loadFromSaveDataMissingScene の待機経路検証に必要)。
 * NovelRenderer.restoreSnapshot.test.ts の markInitialized と同じ理由: この状態フラグの
 * デフォルト値 false のままだと、missingSceneResolver 解決後の `!this.initialized` ガードが
 * 常に早期returnし、正常系の再解決すらテストできなくなる。
 */
function markInitialized(r: NovelRenderer): void {
  internals(r).initialized = true
}

/**
 * 複数シーンを 1 本の Event[] に線形連結する（NovelRenderer.restoreSnapshot.test.ts と同形）。
 * setScenes ではなく setEvents + setJumpSceneIndex の実運用に近い経路（マルチMD構成）を
 * 再現するために使う。
 */
function flatten(scenes: EventScene[]): Event[] {
  const events: Event[] = []
  let first = true
  for (const s of scenes) {
    if (!first) events.push('SceneTransition')
    first = false
    events.push(...s.events)
  }
  return events
}

/**
 * jsdom セーフな SaveSlotData を作る。
 * アセット読込を伴うフィールド（backgroundPath / characters / currentBgmPath）は
 * デフォルトで null/空。over で上書きできる。
 */
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

/** crafted な SaveSlotData をクイックセーブスロットへ直接書き込む */
function seedQuickSave(data: SaveSlotData): void {
  new SaveManager().quickSave(data)
}

/**
 * 指定キーを欠落させた「旧フォーマット」セーブを作る（後方互換テスト用）。
 * SaveSlotData は厳格な型なので一旦 Record に剥がしてキーを削る。
 */
function craftLegacy(omit: keyof SaveSlotData): SaveSlotData {
  const legacy = craftSave({ sceneId: 'a' }) as unknown as Record<string, unknown>
  delete legacy[omit]
  return legacy as unknown as SaveSlotData
}

const SCENES: EventScene[] = [
  scene('a', [narration('a1', 'a2', 'a3'), narration('a4')]),
  scene('b', [narration('b1')]),
]

// flag 依存 Condition を含むシーン（resolvedEvents が flag で伸縮する）
const SCENES_COND: EventScene[] = [
  scene('cond', [
    narration('共通1'),
    condition('seen', [narration('分岐1'), narration('分岐2')]),
    narration('共通2'),
  ]),
]

describe('NovelRenderer.loadFromSaveData (#256)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })

  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ===== A. 正常系: フィールドの写し取り =====

  it('1: 正常セーブ → sceneId/eventIndex/textIndex が復元される', () => {
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1, textIndex: 0 }))
    const r = makeRenderer(SCENES)
    expect(r.quickLoad()).toBe(true)
    const s = r.getSnapshot()
    expect(s.sceneId).toBe('a')
    expect(s.eventIndex).toBe(1)
    expect(s.textIndex).toBe(0)
  })

  it('2: textIndex も復元される（行途中からの復帰）', () => {
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 0, textIndex: 2 }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(r.getSnapshot().textIndex).toBe(2)
  })

  it('3: flags が復元される', () => {
    seedQuickSave(craftSave({ flags: { seen: boolFlag(true), n: { Number: 5 } } }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(r.getSnapshot().flags).toEqual({ seen: boolFlag(true), n: { Number: 5 } })
  })

  it('4: isBlackout=true が復元される', () => {
    seedQuickSave(craftSave({ isBlackout: true }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(r.getSnapshot().isBlackout).toBe(true)
  })

  it('5: isBlackout=false が復元される', () => {
    seedQuickSave(craftSave({ isBlackout: false }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(r.getSnapshot().isBlackout).toBe(false)
  })

  it('6: backgroundPath=null のセーブ → backgroundPath/backgroundFade とも null で復元', () => {
    // backgroundPath が null のセーブは applyState で clearBackground を通る。
    // backgroundFade は背景に付随する値なので、背景なしでは null に落ちる。
    // （fade 付き背景の実描画は PixiJS 依存のため実機 golden path に委ねる）
    seedQuickSave(craftSave({ backgroundPath: null, backgroundFade: { top: 40, bottom: 60 } }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    const s = r.getSnapshot()
    expect(s.backgroundPath).toBeNull()
    expect(s.backgroundFade).toBeNull()
  })

  it('7: 背景ありの状態から backgroundPath=null のセーブをロード → 背景がクリアされる', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    seedQuickSave(craftSave({ sceneId: 'a', backgroundPath: null }))
    r.quickLoad()
    expect(r.getSnapshot().backgroundPath).toBeNull()
  })

  // ===== B. flags 置換（merge でない） =====

  it('8: 事前 flags → 別キーのセーブをロード → 前キーが消える（置換）', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a', flags: { old: boolFlag(true) } })
    seedQuickSave(craftSave({ flags: { fresh: boolFlag(true) } }))
    r.quickLoad()
    expect(r.getSnapshot().flags).toEqual({ fresh: boolFlag(true) })
  })

  it('9: 事前 flags → flags 空のセーブをロード → 空にクリアされる', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a', flags: { old: boolFlag(true) } })
    seedQuickSave(craftSave({ flags: {} }))
    r.quickLoad()
    expect(r.getSnapshot().flags).toEqual({})
  })

  // ===== C. 異常系: sceneId 空（restoreToScene を通さない分岐） =====

  it('10: sceneId="" の空セーブ → quickLoad は true（データは存在する）', () => {
    seedQuickSave(craftSave({ sceneId: '', flags: { f: boolFlag(true) } }))
    const r = makeRenderer(SCENES)
    expect(r.quickLoad()).toBe(true)
  })

  it('11: sceneId="" → フラグだけ復元され、currentSceneId は変化しない', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const sceneBefore = r.getCurrentSceneId()
    seedQuickSave(craftSave({ sceneId: '', flags: { only: boolFlag(true) } }))
    r.quickLoad()
    expect(r.getSnapshot().flags).toEqual({ only: boolFlag(true) })
    // sceneId 空は restoreToScene を通さない → currentSceneId は据え置き
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
  })

  it('12: sceneId="" → history はリセットされない（restoreToScene 未通過）', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const historyBefore = internals(r).history.length
    seedQuickSave(craftSave({ sceneId: '', flags: { f: boolFlag(true) } }))
    r.quickLoad()
    expect(internals(r).history.length).toBe(historyBefore)
  })

  it('13: sceneId="" → warn は呼ばない（空セーブは正常な早期 return）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedQuickSave(craftSave({ sceneId: '', flags: {} }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ===== D. 異常系: シーン未発見（フラグだけ復元 + warn） =====

  it('14: 存在しない sceneId → warn が呼ばれる', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedQuickSave(craftSave({ sceneId: 'ghost' }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('15: 存在しない sceneId でも flags は復元される（startFrom との差分）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a', flags: { prev: boolFlag(true) } })
    seedQuickSave(craftSave({ sceneId: 'ghost', flags: { restored: boolFlag(true) } }))
    r.quickLoad()
    // loadFromSaveData はシーンが無くてもフラグだけは復元する（従来挙動の維持）
    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
  })

  it('16: 存在しない sceneId → currentSceneId は変化しない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const sceneBefore = r.getCurrentSceneId()
    seedQuickSave(craftSave({ sceneId: 'ghost', flags: { f: boolFlag(true) } }))
    r.quickLoad()
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
  })

  it('17: 存在しない sceneId → history はリセットされない（restoreToScene 未通過）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const historyBefore = internals(r).history.length
    seedQuickSave(craftSave({ sceneId: 'ghost', flags: { f: boolFlag(true) } }))
    r.quickLoad()
    expect(internals(r).history.length).toBe(historyBefore)
  })

  // ===== E. 状態遷移: ロード前後 =====

  it('18: 別シーンを開いた状態から正常ロード → ロード先シーンへ遷移する', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'b' })
    expect(r.getCurrentSceneId()).toBe('b')
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1 }))
    r.quickLoad()
    expect(r.getCurrentSceneId()).toBe('a')
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('19: 正常ロード後 history は現在位置 1 件にリセットされる', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1, textIndex: 0 }))
    r.quickLoad()
    expect(internals(r).history.length).toBe(1)
    expect(internals(r).history[0]).toEqual(r.getSnapshot())
  })

  // ===== E2. choice 抑制フラグのリセット（startFrom と挙動を揃える #256） =====

  it('28: 正常ロードで justSelectedChoice=false にリセットされる（restoreToScene 共通リセット）', () => {
    const r = makeRenderer(SCENES)
    // ロード前に「choice 直後」状態を人為的に立てておく
    internals(r).justSelectedChoice = true
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1 }))
    r.quickLoad()
    // restoreToScene が完全リセットの一環として false に倒す（startFrom と同じ挙動）
    expect(internals(r).justSelectedChoice).toBe(false)
  })

  it('29: sceneId="" の空セーブは restoreToScene を通さないため justSelectedChoice を触らない', () => {
    const r = makeRenderer(SCENES)
    internals(r).justSelectedChoice = true
    seedQuickSave(craftSave({ sceneId: '', flags: { f: boolFlag(true) } }))
    r.quickLoad()
    // 空セーブは早期 return（restoreToScene 未通過）なので据え置き
    expect(internals(r).justSelectedChoice).toBe(true)
  })

  // ===== F. Condition 展開（flags がロード時点で resolveEvents に効く） =====

  it('20: Condition シーンを flag=true でロード → 展開後件数になる', () => {
    seedQuickSave(craftSave({ sceneId: 'cond', flags: { seen: boolFlag(true) } }))
    const r = makeRenderer(SCENES_COND)
    r.quickLoad()
    // 共通1 + (分岐1 + 分岐2) + 共通2 = 4 件
    expect(r.getDebugState().eventCount).toBe(4)
  })

  it('21: Condition シーンを flag=false でロード → Condition 内が除外される', () => {
    seedQuickSave(craftSave({ sceneId: 'cond', flags: { seen: boolFlag(false) } }))
    const r = makeRenderer(SCENES_COND)
    r.quickLoad()
    // 共通1 + 共通2 = 2 件
    expect(r.getDebugState().eventCount).toBe(2)
  })

  // ===== G. 後方互換: 旧セーブの欠落フィールド =====

  it('22: video キー欠如の旧セーブ → クラッシュせず video=null で復元', () => {
    seedQuickSave(craftLegacy('video'))
    const r = makeRenderer(SCENES)
    expect(r.quickLoad()).toBe(true)
    expect(r.getSnapshot().video).toBeNull()
  })

  it('23: isBlackout キー欠如の旧セーブ → 既定 false で復元', () => {
    seedQuickSave(craftLegacy('isBlackout'))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(r.getSnapshot().isBlackout).toBe(false)
  })

  it('24: characters キー欠如の旧セーブ → 既定 空配列で復元', () => {
    seedQuickSave(craftLegacy('characters'))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(r.getSnapshot().characters).toEqual([])
  })

  // ===== H. 境界値 =====

  it('25: eventIndex に resolvedEvents.length 超過のセーブ → 例外を投げない', () => {
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 9999 }))
    const r = makeRenderer(SCENES)
    expect(() => r.quickLoad()).not.toThrow()
  })

  // ===== I. 決定論 =====

  it('26: 同一セーブを 2 renderer でロード → getSnapshot 一致', () => {
    seedQuickSave(
      craftSave({ sceneId: 'a', eventIndex: 1, textIndex: 1, flags: { x: boolFlag(true) } })
    )
    const r1 = makeRenderer(SCENES)
    r1.quickLoad()
    const r2 = makeRenderer(SCENES)
    r2.quickLoad()
    expect(r2.getSnapshot()).toEqual(r1.getSnapshot())
  })

  // ===== J. ログ =====

  it('27: 正常ロードで warn/error を呼ばない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1, flags: { ok: boolFlag(true) } }))
    const r = makeRenderer(SCENES)
    r.quickLoad()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // ===== K. 終劇状態 (#386) =====
  //
  // SaveSlotData / saveSlotToGameState は storyEnded を持たない設計（novelLayout.ts 参照）。
  // このセクションは「終劇後もセーブ自体が起きない（quickSave が false を返す）」
  // 「万一 storyEnded=true な GameState からセーブ相当のロードをしても常に false に
  // 復元される」という #386 修正後の正しい挙動を確認する。

  it('30: storyEnded=true の状態から quickLoad しても、saveSlotToGameState により常に storyEnded=false で復元される', () => {
    // quickLoad 前に「終劇済み」の状態を人為的に作る（confinement 外ジャンプの再現は
    // NovelRenderer.confinement.test.ts の責務なので、ここでは applyState 直接キャストで作る。
    // 本番導線には無い経路であることは startFrom.test.ts #29 と同様）。
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 0 }))
    const r = makeRenderer(SCENES)
    internals(r).applyState({ ...r.getSnapshot(), storyEnded: true })
    expect(r.getSnapshot().storyEnded).toBe(true)

    r.quickLoad()

    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('31: 終劇後（storyEnded=true）は quickSave() が false を返す（保存自体が起きない・行き止まり防止）', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    internals(r).applyState({ ...r.getSnapshot(), storyEnded: true })

    expect(r.quickSave()).toBe(false)
  })

  // ===== L. docKey 名前空間化 (#578) =====
  //
  // NovelRenderer 内部の SaveManager は `new SaveManager()`（既定 docKey ''）で構築される
  // （setDocKey() は setDocKey() 呼び出し時にのみ内部 SaveManager の docKey を更新する）。
  // ここでは setDocKey() を一度も呼ばない場合、既定の '' 名前空間へ書かれることを直接
  // localStorage キーで確認する（SaveManager.test.ts の docKey 単体テストと対になる、
  // NovelRenderer 経由の統合確認）。

  it('8: setDocKey() 呼び出し前に quickSave() すると既定の "" 名前空間の localStorage キーに保存される', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })

    expect(r.quickSave()).toBe(true)

    // SaveManager の quickKey() は `${PREFIX}${docKey}-quick`。docKey 既定は '' なので
    // 'name-name-save--quick' というキーに書かれる。
    expect(localStorage.getItem('name-name-save--quick')).not.toBeNull()
  })

  // ===== M. quickLoad の missingSceneResolver 再解決（loadFromSaveDataMissingScene）(#578) =====
  //
  // #460 の restoreSnapshot と同じ「hub(entry doc) + ルート別 md」問題が、起動時の自動 quickLoad
  // （本 Issue の新機能）経由でも起きる。修正前は allScenes にまだ無い sceneId のクイックセーブを
  // ロードすると常に「フラグのみの縮退復元 + warn」に落ちていた。修正後は missingSceneResolver が
  // あれば restoreSnapshot と同じ非同期再解決パターンを踏んでから復元する。
  // NovelRenderer.restoreSnapshot.test.ts の K1/K2 と同形の構成で loadFromSaveData 版を検証する。

  it('9: hasQuickSave() が真の状態で quickLoad() を呼び、対象 sceneId が allScenes に存在する場合は正しく該当シーン位置へ復元される', () => {
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1, textIndex: 0 }))
    const r = makeRenderer(SCENES)
    expect(r.hasQuickSave()).toBe(true)

    expect(r.quickLoad()).toBe(true)

    expect(r.getCurrentSceneId()).toBe('a')
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('10: allScenes に無い sceneId でも missingSceneResolver 経由で非同期再解決され、正しいシーン位置へ復元される（マルチMD遅延ロード再現）', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const routeScene = scene('r01-01', [narration('route-line-a', 'route-line-b')])
    const resolver = vi.fn(async () => [...entryScenes, routeScene])

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    // 新規 renderer 直後は allScenes に route-scene がまだ無い（マルチMD遅延ロード前の状態）。
    expect(r.getAllSceneIds()).toEqual(['entry-hub'])
    seedQuickSave(craftSave({ sceneId: 'r01-01', eventIndex: 1, flags: { seen: boolFlag(true) } }))
    expect(r.hasQuickSave()).toBe(true)

    expect(r.quickLoad()).toBe(true)
    // loadFromSaveDataMissingScene は fire-and-forget（quickLoad 自体は同期 true を返す）なので
    // resolver の Promise 解決をマイクロタスクとして待つ（#460 K1 と同じ待ち方）。
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('r01-01')
    expect(r.getAllSceneIds()).toEqual(['entry-hub', 'r01-01'])
    expect(r.getCurrentSceneId()).toBe('r01-01')
    expect(r.getSnapshot().eventIndex).toBe(1)
    expect(r.getSnapshot().flags).toEqual({ seen: boolFlag(true) })
  })

  it('11a: missingSceneResolver が無い場合、従来どおりフラグのみ復元され console.warn が呼ばれる', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // resolver 未設定（makeRenderer は setMissingSceneResolver を呼ばない）。
    seedQuickSave(craftSave({ sceneId: 'ghost-no-resolver', flags: { restored: boolFlag(true) } }))
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    const sceneBefore = r.getCurrentSceneId()

    expect(r.quickLoad()).toBe(true)

    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('11b: missingSceneResolver が解決に失敗（null を返す）した場合、フラグのみ復元され console.warn が呼ばれる', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => null)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)
    r.startFrom({ sceneId: 'entry-hub' })
    const sceneBefore = r.getCurrentSceneId()

    seedQuickSave(craftSave({ sceneId: 'ghost-route', flags: { restored: boolFlag(true) } }))
    expect(r.quickLoad()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolver).toHaveBeenCalledWith('ghost-route')
    expect(r.getSnapshot().flags).toEqual({ restored: boolFlag(true) })
    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('11c: missingSceneResolver が例外を投げた場合でも、フラグのみ復元され console.warn が呼ばれる（例外を外に漏らさない）', async () => {
    const entryScenes: EventScene[] = [scene('entry-hub', [narration('hub-line')])]
    const resolver = vi.fn(async () => {
      throw new Error('network error')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setEvents(flatten(entryScenes))
    r.setJumpSceneIndex(entryScenes)
    r.setMissingSceneResolver(resolver)
    markInitialized(r)

    seedQuickSave(craftSave({ sceneId: 'ghost-route-2', flags: { y: boolFlag(true) } }))
    expect(() => r.quickLoad()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(r.getSnapshot().flags).toEqual({ y: boolFlag(true) })
    expect(warnSpy).toHaveBeenCalled()
  })

  // ===== N. 選択肢/Wait 待機中の quickSave/quickLoad ガード (#578) =====
  //
  // quickSave()/quickLoad() は waitingForChoice/waitingForWait 中は不整合を避けるため no-op で
  // false を返す（既存実装。#578 のテスト設計時に明示的に固定するリクエストがあったため追加）。
  // storyEnded 中の quickSave()=false は既存の 31 番が担保済みなのでここでは扱わない。

  it('12a: waitingForChoice=true の間に quickLoad() を呼ぶと false を返し、状態を変更しない', () => {
    seedQuickSave(craftSave({ sceneId: 'a', eventIndex: 1, flags: { later: boolFlag(true) } }))
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'b' })
    const sceneBefore = r.getCurrentSceneId()
    const flagsBefore = r.getSnapshot().flags
    internals(r).waitingForChoice = true

    expect(r.quickLoad()).toBe(false)

    expect(r.getCurrentSceneId()).toBe(sceneBefore)
    expect(r.getSnapshot().flags).toEqual(flagsBefore)
  })

  it('12b: waitingForWait=true の間に quickLoad() を呼んでも false を返す（choice と同じガード）', () => {
    seedQuickSave(craftSave({ sceneId: 'a' }))
    const r = makeRenderer(SCENES)
    internals(r).waitingForWait = true

    expect(r.quickLoad()).toBe(false)
  })

  it('13a: waitingForChoice=true の間に quickSave() を呼ぶと false を返し、保存されない', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    internals(r).waitingForChoice = true

    expect(r.quickSave()).toBe(false)
    expect(r.hasQuickSave()).toBe(false)
  })

  it('13b: waitingForWait=true の間に quickSave() を呼ぶと false を返し、保存されない', () => {
    const r = makeRenderer(SCENES)
    r.startFrom({ sceneId: 'a' })
    internals(r).waitingForWait = true

    expect(r.quickSave()).toBe(false)
    expect(r.hasQuickSave()).toBe(false)
  })
})
