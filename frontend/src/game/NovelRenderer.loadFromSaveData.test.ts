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
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
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
})
