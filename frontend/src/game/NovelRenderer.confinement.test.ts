/**
 * NovelRenderer の confinement（在圏）判定 + 終劇（endStory）のテスト (#386)。
 *
 * `?scene=` ディープリンク単独埋め込みで `setConfinedSceneIds` が設定されているとき、
 * `jumpToScene` がその集合の外への遷移を通常のシーン遷移ではなく終劇として扱う挙動を検証する。
 * `startFrom.test.ts` / `backgroundCrossfade.test.ts` と同じく
 * `new NovelRenderer()` → `setScenes(...)` の最小構成で行い、PixiJS 実描画は対象外
 * （CLAUDE.md ルール7 の実機 golden path に委ねる）。
 *
 * 背景/立ち絵の非同期アセット読込を伴う状態は `loadFromSaveData.test.ts` と同じ理由で
 * jsdom 検証の対象外とする（実機 golden path に委ねる）。backgroundPath/backgroundColor は
 * アセット読込を経由せず同期的に確定するフィールドなので、これらだけを対象に
 * 「endStory 後は全部クリアされる」ことを検証する（video/characters は既定値のまま据え置き、
 * 純粋な状態遷移の検証として弱いが doctrine 通りの割り切り）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { BACKGROUND_CROSSFADE_MS, NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene, ChoiceOption } from '../types'

// --- fixture helpers（startFrom.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** narration → Choice の 2 イベントシーン。advance 1 回で Choice に到達する（#398）。 */
function choiceScene(id: string, options: ChoiceOption[]): EventScene {
  return scene(id, [narration('本文'), { Choice: { options } } as Event])
}

/** confinement 検証用の内部アクセサ */
interface RendererInternals {
  setBackground(
    path: string,
    fade?: unknown,
    brightness?: number | null,
    opts?: { instant?: boolean }
  ): void
  setBackgroundColor(color: string): void
  initialized: boolean
  history: unknown[]
  currentBgmPath: string | null
  shakeTimer: number | null
  effectTimer: number | null
  effectOverlay: { alpha: number; visible: boolean } | null
  waitingForChoice: boolean
  readSceneProgress: Set<string>
  choiceOverlay: { show: (...args: unknown[]) => void; hide: () => void }
  bgEntries: Array<{
    sprite: { alpha: number; removeFromParent: () => void; destroy: () => void }
    mask: null
    fadeAnimation: null | {
      startMs: number
      durationMs: number
      fromAlpha: number
      toAlpha: number
      destroyOnComplete: boolean
    }
  }>
  updateBackgroundFadeFrame(): void
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

// entry: 在圏に含める / in-scene: 在圏に含める / out-scene: allScenes には実在するが圏外
const SCENES: EventScene[] = [
  scene('entry', [narration('start')]),
  scene('in-scene', [narration('inside')]),
  scene('out-scene', [narration('outside but exists in allScenes')]),
]

// goBack/seekTo 回帰用: entry に複数イベントを持たせ、advance で history を複数積めるようにする
// （pushSnapshot は「次のイベントへ」進んだときだけ発火するため、1 イベント/1 行の SCENES では
// history.length が 1 のままになり goBack の history.pop() 分岐に届かない）。
const SCENES_MULTI_EVENT: EventScene[] = [
  scene('entry', [narration('one'), narration('two'), narration('three')]),
  scene('in-scene', [narration('inside')]),
  scene('out-scene', [narration('outside but exists in allScenes')]),
]

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

describe('NovelRenderer confinement / endStory (#386)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
  })

  // ===== A. 後方互換: confinement 未設定 =====

  it('17: confinement 未設定（既定 null）時、圏外相当の sceneId でも jumpToScene は通常遷移する（後方互換の核）', () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('out-scene')
    expect(r.getCurrentSceneId()).toBe('out-scene')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== B. 在圏ジャンプは通常遷移 =====

  it('18: confinement 設定後、在圏 scene への jumpToScene は通常遷移する', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('in-scene')
    expect(r.getCurrentSceneId()).toBe('in-scene')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== C. 圏外ジャンプ（allScenes に実在）は終劇 =====

  it('19: confinement 設定後、圏外（allScenes に実在）sceneId への jumpToScene は storyEnded=true にする', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene')
    expect(r.getSnapshot().storyEnded).toBe(true)
  })

  it('20: 圏外ジャンプで console.warn は呼ばれない（シーン未発見扱いにしない）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('21: 圏外かつ allScenes に存在しない sceneId への jumpToScene も終劇になり、missingSceneResolver は呼ばれない', () => {
    // このパスは Q1 の DEV console.warn（typo 診断）を踏むため silence する（テスト32 と同様・実行ログのノイズ防止）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resolver = vi.fn().mockResolvedValue(null)
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.setMissingSceneResolver(resolver)
    r.jumpToScene('totally-unknown-scene')
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('24: 終劇後も currentSceneId は変化しない（endStory は startScene を経由しない）', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene')
    expect(r.getCurrentSceneId()).toBe('entry')
  })

  // ===== D. 終劇後の入力無効化 =====

  it('22: 終劇後、advance() を呼んでも eventIndex/textIndex 等のスナップショットは変化しない', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    const before = r.getSnapshot()
    r.advance()
    r.advance()
    expect(r.getSnapshot()).toEqual(before)
  })

  // ===== E. 終劇後の宣言的終端状態 =====

  it('23: 終劇後、getSnapshot() の backgroundPath/backgroundColor が null にクリアされる', () => {
    const r = makeRenderer(SCENES)
    // アセット読込を経由しない同期フィールドだけを事前に非 null にしておく
    // （実際のテクスチャロードは jsdom 検証対象外・loadFromSaveData.test.ts と同じ割り切り）。
    internals(r).setBackground('bg.png')
    internals(r).setBackgroundColor('#112233')
    expect(r.getSnapshot().backgroundPath).toBe('bg.png')
    expect(r.getSnapshot().backgroundColor).toBe('#112233')

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    const s = r.getSnapshot()
    expect(s.backgroundPath).toBeNull()
    expect(s.backgroundColor).toBeNull()
    // video/characters はアセット読込を経由するため事前に非 null 化していないが、
    // 終劇後に「なし」であることは変わらず確認できる。
    expect(s.video).toBeNull()
    expect(s.characters).toEqual([])
  })

  // ===== F. 二重発火防止 =====

  it('25: 終劇トリガーを2回連続しても、onStoryEndedChange コールバックは1回しか発火しない', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    r.jumpToScene('out-scene') // 2回目（二重発火防止で早期 return するはず）
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(true)
  })

  // ===== G. 終劇からの復帰（startScene の安全弁） =====

  it('26: 終劇後に在圏 scene へ jumpToScene すると storyEnded=false に戻り、callback が false で発火する', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene') // 圏外 → 終劇（storyEnded=true, cb(true)）
    expect(r.getSnapshot().storyEnded).toBe(true)
    cb.mockClear()

    r.jumpToScene('in-scene') // 在圏 → 通常遷移。startScene の安全弁で false に戻る
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(r.getCurrentSceneId()).toBe('in-scene')
    expect(cb).toHaveBeenCalledWith(false)
  })

  // ===== H. race: 背景ロード中の endStory =====

  it('27: setBackground の非同期ロード中に endStory() が発火しても、後で元 promise が resolve しても backgroundPath は null のまま', async () => {
    const r = makeRenderer(SCENES)
    r.setAssetBaseUrl('/assets')
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setConfinedSceneIds(['entry'])

    let resolveLoad!: (texture: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((resolve) => {
        resolveLoad = resolve
      }) as never
    )

    // アセットキャッシュに無い背景 → Assets.load が pending のまま bgLoadToken を確保する。
    internals(r).setBackground('pending.png')
    expect(r.getSnapshot().backgroundPath).toBe('pending.png')

    // 圏外ジャンプで endStory() が発火。bgLoadToken を進めて古いロードを無効化し、
    // backgroundPath を即座に null に確定する。
    r.jumpToScene('out-scene')
    expect(r.getSnapshot().backgroundPath).toBeNull()

    // 古い pending.png の読み込みが後から解決しても、endStory 後の状態を上書きしない。
    resolveLoad(Texture.WHITE)
    await Promise.resolve()
    expect(r.getSnapshot().backgroundPath).toBeNull()
  })

  // ===== I. 終劇後の goBack/seekTo 無効化 (#386 レビュー M1) =====
  //
  // endStory() は pushSnapshot() を呼ばない（新しいシーンへ進んだわけではないため）。
  // そのため history の末尾には、confinement 違反前の最後のテキストイベント
  // （storyEnded: false のスナップショット）がそのまま残っている。goBack()/seekTo() を
  // storyEnded でガードしないと、終劇後にこれらを呼ぶと applyState() が storyEnded を
  // false に巻き戻し、"to be continued..." が消えて背景/立ち絵/BGM が直前の状態に
  // 戻ってしまう（終劇の無効化）。

  it('28: 終劇後に goBack() を呼んでも storyEnded は true のまま維持される（M1 回帰）', async () => {
    const r = makeRenderer(SCENES_MULTI_EVENT)
    // entry (one/two/three の3イベント) を2回 advance して history を複数積む。
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(internals(r).history.length).toBeGreaterThan(1)

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene') // 圏外 → 終劇
    expect(r.getSnapshot().storyEnded).toBe(true)
    const historyLenAfterEnd = internals(r).history.length

    r.goBack()
    expect(r.getSnapshot().storyEnded).toBe(true)
    // 早期 return で history.pop() にも到達しない（history 自体も不変）。
    expect(internals(r).history.length).toBe(historyLenAfterEnd)
  })

  it('29: 終劇後に seekTo() を呼んでも storyEnded は true のまま維持される（M1 回帰: SeekBar ドラッグでの巻き戻し防止）', async () => {
    const r = makeRenderer(SCENES_MULTI_EVENT)
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(internals(r).history.length).toBeGreaterThan(1)

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene') // 圏外 → 終劇
    expect(r.getSnapshot().storyEnded).toBe(true)

    r.seekTo(0) // history の先頭（storyEnded: false の時点）へ戻ろうとする
    expect(r.getSnapshot().storyEnded).toBe(true)
  })

  // ===== I2. 終劇の消去フェード中に setSkipMode(true) を呼んでも巻き戻らない (#404 セルフレビュー S1) =====
  //
  // endStory() の fadeOutBackgroundEntries()（次背景を追加しない全消去フェード）進行中に
  // setSkipMode(true) が呼ばれると、finishBackgroundCrossfadeInstant() が「crossfade 中で
  // 次背景が来る」前提のまま「最後の bgEntry = 次背景」の alpha を 1 にリセットしてしまい、
  // 消去フェード中だった背景を誤って完全不透明へ巻き戻す事故があった（skip 中は tick が
  // 止まるためそのまま固定される）。setSkipMode() 自体を storyEnded 中 no-op にするガード
  // （goBack/seekTo と同じ M1 系イディオム）でこれを防いだことを検証する。

  it('33: 終劇の消去フェード進行中に setSkipMode(true) を呼んでも背景 alpha は巻き戻らず、skipMode も変化しない（S1 回帰）', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    // 実アセットロードを経由せず、フェード対象の背景 entry を直接注入する
    // （backgroundCrossfade.test.ts と同じ割り切り）。
    const bgEntry = {
      sprite: { alpha: 1, removeFromParent: vi.fn(), destroy: vi.fn() },
      mask: null,
      fadeAnimation: null,
    }
    internals(r).bgEntries = [bgEntry]

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene') // 圏外 → endStory() → fadeOutBackgroundEntries(BACKGROUND_CROSSFADE_MS)

    // 消去フェード（1→0）が仕込まれていることを確認する（クロスフェードの 0→1 と混同しないよう明示）。
    expect(internals(r).bgEntries).toEqual([bgEntry])
    expect(bgEntry.fadeAnimation).toMatchObject({ fromAlpha: 1, toAlpha: 0 })

    // フェードを1/3ほど進める（alpha が 1 でも 0 でもない中間状態を作る）。
    const partialMs = Math.round(BACKGROUND_CROSSFADE_MS / 3)
    r.getTimeController().tick(partialMs)
    internals(r).updateBackgroundFadeFrame()
    const alphaBeforeSkip = bgEntry.sprite.alpha
    expect(alphaBeforeSkip).toBeGreaterThan(0)
    expect(alphaBeforeSkip).toBeLessThan(1)

    r.setSkipMode(true)

    // 修正前は finishBackgroundCrossfadeInstant() が alpha を 1 に巻き戻していた。
    expect(bgEntry.sprite.alpha).toBe(alphaBeforeSkip)
    expect(bgEntry.fadeAnimation).toMatchObject({ fromAlpha: 1, toAlpha: 0 })
    // setSkipMode() 自体が storyEnded 中は no-op のため、skipMode も変化しない。
    expect(r.isSkipMode()).toBe(false)
  })

  // ===== J. 終劇後の BGM 停止 (#386 レビュー M2) =====
  //
  // resetAndStartEvents()（通常のシーン遷移）は毎回 stopBgm(0) + currentBgmPath=null するが、
  // endStory() にはこれが無かった。終劇は物語上の終端で以後 Bgm イベントは来ないため、
  // 一度このバグを踏むと BGM が永久に鳴り続ける（初見訪問者にはセーブが無く止める手段がない）。
  // playBgm() 自体は AudioContext/アセット読込を伴い jsdom 対象外のため、他のテストと同じく
  // 追跡フィールド（currentBgmPath）だけ直接セットし、stopBgm 呼び出しはスパイで検証する。

  it('30: endStory() は BGM を停止し currentBgmPath を null にする（M2 回帰）', () => {
    const r = makeRenderer(SCENES)
    const stopBgmSpy = vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {})
    internals(r).currentBgmPath = 'bgm/loop.mp3'
    expect(r.getSnapshot().currentBgmPath).toBe('bgm/loop.mp3')

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    expect(stopBgmSpy).toHaveBeenCalled()
    expect(r.getSnapshot().currentBgmPath).toBeNull()
  })

  // ===== K. 終劇後の画面効果クリア (#386 レビュー S1) =====
  //
  // Shake/Flash/Fade は fire-and-forget なタイマー演出。これらを仕込んだ直後の text から
  // confinement 外への choice が続くシーンでは、endStory() 後もタイマー/オーバーレイが
  // 残ってしまう（特に Fade で画面を色で覆う演出中だと、その色が "to be continued..." 画面に
  // 残留する）。applyState() の画面効果リセットブロックと同じロジックを endStory() にも
  // 適用したことを検証する。

  it('31: endStory() は shakeTimer/effectTimer をクリアし effectOverlay を隠す（S1 回帰）', () => {
    const r = makeRenderer(SCENES)
    // Shake/Flash/Fade の fire-and-forget な内部状態を直接仕込む（実際のトリガーは
    // processDirective 経由だが、ここでは endStory 側の後始末だけを対象にする）。
    internals(r).shakeTimer = 12345
    internals(r).effectTimer = 67890
    internals(r).effectOverlay = { alpha: 0.6, visible: true }

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    expect(internals(r).shakeTimer).toBeNull()
    expect(internals(r).effectTimer).toBeNull()
    expect(internals(r).effectOverlay).toEqual({ alpha: 0, visible: false })
  })

  // ===== L. confinement 圏外 + 未知 sceneId の dev 診断 (#386 レビュー Q1) =====
  //
  // fail-closed（圏外は理由を問わず終劇）という設計自体は維持しつつ、原稿の typo で
  // どこにも存在しない sceneId が「正常な終劇（例: hub への遷移）」に偽装されて気づかれない
  // 事故を、開発時にだけ検知できるようにする。production の挙動・見た目は変えない
  // （console.warn は import.meta.env.DEV でのみ評価される）。

  it('32: 圏外かつ allScenes にも存在しない sceneId は DEV で console.warn される（Q1: typo が正常な終劇に偽装されない）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])

    r.jumpToScene('typo-scene-id')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('typo-scene-id'))
    // fail-closed の挙動自体は不変（警告があっても終劇にはなる）。
    expect(r.getSnapshot().storyEnded).toBe(true)
  })
  // 「圏外だが allScenes に実在する sceneId は console.warn されない」は既存テスト20が担保する
  // （out-scene は allScenes に実在するため、本テストの 'typo-scene-id' と対照的な既存カバレッジ）。
})

// ===================================================================================
// #398: Choice ディレクティブ経由の短絡（全 option 圏外なら選択肢を出さず終劇へ倒す）
// ===================================================================================
//
// 既存テスト（17〜32）は jumpToScene 起点の endStory（選んだ jump 先が圏外）だけをカバーする。
// #398 は「そもそも全 option が圏外なら、クリックを待たず choice 描画前に短絡して終劇する」経路。
// setter 直呼びでなく、narration → Choice を advance で再生して processDirective の Choice 分岐を
// 実際に踏む。choiceOverlay.show() は AudioManager.ensureContext()（jsdom に AudioContext なし）と
// PixiJS 実描画を伴うため、短絡しない（choice 表示に進む）ケースだけ show を no-op spy に差し替える
// （短絡ケースは show に到達しないので差し替え不要）。

describe('NovelRenderer confinement × Choice ディレクティブ短絡 (#398)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    // markCurrentSceneRead は docKey ごとに localStorage へ書くため、テスト間で持ち越さない。
    localStorage.clear()
  })

  // ===== 1. 全 option 圏外 → 短絡して終劇 =====

  it('398-1: 全 option の jump が圏外を指す Choice に到達すると、choice を出さず storyEnded=true にする', async () => {
    const cb = vi.fn()
    const r = makeRenderer([
      choiceScene('entry', [
        { text: 'ハブへ', jump: 'hub' },
        { text: '他業へ', jump: 'other' },
      ]),
      scene('hub', [narration('hub')]),
      scene('other', [narration('other')]),
    ])
    r.setDocKey('doc-398-all-out') // markCurrentSceneRead を実際に効かせる（既読集合を観測するため）
    r.setOnStoryEndedChange(cb)
    r.setConfinedSceneIds(['entry']) // 圏内は entry のみ。hub / other は圏外
    // choiceOverlay.show に到達しないことを spy で担保する（短絡なら呼ばれない）。
    const showSpy = vi.spyOn(internals(r).choiceOverlay, 'show')

    // narration('本文') → advance 1 回で Choice に到達（processDirective の Choice 分岐を再生経路で踏む）。
    await r.playScript([{ type: 'advance' }])

    expect(r.getSnapshot().storyEnded).toBe(true)
    // waitingForChoice は立たず、choiceOverlay も表示されない（短絡で choice UI に進まない）。
    expect(internals(r).waitingForChoice).toBe(false)
    expect(showSpy).not.toHaveBeenCalled()
    // onStoryEndedChange は true で 1 回だけ発火する。
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(true)
    // Choice 到達時の markCurrentSceneRead が短絡より前に走り、シーンが既読になっている。
    expect(internals(r).readSceneProgress.has('entry')).toBe(true)
  })

  // ===== 2. 一部 option が圏内 → 短絡せず choice 表示 =====

  it('398-2: 一部 option が圏内なら短絡せず choice を表示する（waitingForChoice=true / storyEnded=false）', async () => {
    const r = makeRenderer([
      choiceScene('entry', [
        { text: '中へ', jump: 'inside' }, // 圏内
        { text: 'ハブへ', jump: 'hub' }, // 圏外
      ]),
      scene('inside', [narration('inside')]),
      scene('hub', [narration('hub')]),
    ])
    r.setConfinedSceneIds(['entry', 'inside'])
    // 圏内 option があるので choice 表示に進む。show は AudioContext/PixiJS を触るので no-op に差し替える。
    const showSpy = vi.spyOn(internals(r).choiceOverlay, 'show').mockImplementation(() => {})

    await r.playScript([{ type: 'advance' }])

    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(internals(r).waitingForChoice).toBe(true)
    expect(showSpy).toHaveBeenCalledTimes(1)
  })

  // ===== 3. confinedSceneIds === null（通常フロー） → 常に短絡しない（後方互換） =====

  it('398-3: confinedSceneIds が null（既定）なら、全 option が圏外相当でも短絡せず choice を表示する（後方互換）', async () => {
    const r = makeRenderer([
      choiceScene('entry', [
        { text: 'ハブへ', jump: 'hub' },
        { text: '他業へ', jump: 'other' },
      ]),
      scene('hub', [narration('hub')]),
      scene('other', [narration('other')]),
    ])
    // setConfinedSceneIds を呼ばない（confinedSceneIds は既定 null）。
    const showSpy = vi.spyOn(internals(r).choiceOverlay, 'show').mockImplementation(() => {})

    await r.playScript([{ type: 'advance' }])

    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(internals(r).waitingForChoice).toBe(true)
    expect(showSpy).toHaveBeenCalledTimes(1)
  })

  // ===== 4. skipMode リセット (#424 セルフレビュー must) =====
  //
  // 通常の Choice 表示は choiceOverlay.show() の直前に setSkipMode(false) を呼ぶが、全 option
  // 圏外の短絡（上のテスト398-1）はこれを飛ばして直接 endStory() へ向かう。そのため
  // setSkipMode(true) の状態でこの経路に到達すると、修正前は this.skipMode が true のまま
  // endStory() に入っていた。renderIntermissionTableau が委譲する Label/Image は
  // instant: this.skipMode を見るため（NovelRenderer.intermission.test.ts テスト31/32参照）、
  // このリセット漏れは #424 の目玉機能（段階フェード）を丸ごと無効化する実害があった。

  it('398-4: setSkipMode(true) 中に全 option 圏外の Choice で終劇へ短絡しても、endStory() 側で skipMode がリセットされる（must 回帰）', async () => {
    const r = makeRenderer([
      choiceScene('entry', [
        { text: 'ハブへ', jump: 'hub' },
        { text: '他業へ', jump: 'other' },
      ]),
      scene('hub', [narration('hub')]),
      scene('other', [narration('other')]),
    ])
    r.setConfinedSceneIds(['entry']) // hub / other は圏外
    r.setSkipMode(true)
    expect(r.isSkipMode()).toBe(true)
    const showSpy = vi.spyOn(internals(r).choiceOverlay, 'show')

    await r.playScript([{ type: 'advance' }]) // narration → Choice 到達 → 全滅短絡 → endStory()

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(showSpy).not.toHaveBeenCalled() // 短絡なので choice UI には進まない
    expect(r.isSkipMode()).toBe(false)
  })
})
