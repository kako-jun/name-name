/**
 * NovelRenderer の intermission.md 専用シーン化 (#404 フェーズ2) のテスト。
 *
 * `setIntermissionScene(events, options)` で登録した Event[] は、endStory() のフェード演出が
 * 終わった後に一度だけ「静止画タブロー」として描画され、そこで凍結する
 * （renderIntermissionTableau。GameState には持たず、advance() は storyEnded で no-op のまま）。
 *
 * `NovelRenderer.confinement.test.ts` と同じ最小構成（`new NovelRenderer()` → `setScenes(...)`）で
 * 行い、PixiJS 実描画・アセット非同期読込は対象外（CLAUDE.md ルール7 の実機 golden path に委ねる）。
 * タブロー内の Background(画像)/立ち絵は非同期ロードを伴うため対象外とし、同期的に確定する
 * BackgroundColor / Dialog テキストだけで「タブローが実際に描画された」ことを観測する。
 *
 * `initialized`（private, `init()` 完了フラグ）は他の NovelRenderer.*.test.ts と同じく
 * internals 直代入で立てる（PixiJS 実 init を経由しない既存の割り切り）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { NovelGameState } from './GameState'
import type { Event, EventScene, ChoiceOption } from '../types'

// --- fixture helpers（NovelRenderer.confinement.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function dialog(character: string | null, ...lines: string[]): Event {
  return { Dialog: { character, expression: null, position: null, text: lines, fit: false } }
}

function backgroundColor(color: string): Event {
  return { BackgroundColor: { color } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** narration → Choice の 2 イベントシーン。advance 1 回で Choice に到達する（confinement.test.ts と同じ）。 */
function choiceScene(id: string, options: ChoiceOption[]): EventScene {
  return scene(id, [narration('本文'), { Choice: { options } } as Event])
}

const SCENES: EventScene[] = [
  scene('entry', [narration('start')]),
  scene('out-scene', [narration('outside but exists in allScenes')]),
]

const CHOICE_SCENES: EventScene[] = [
  choiceScene('entry', [
    { text: 'ハブへ', jump: 'hub' },
    { text: '他業へ', jump: 'other' },
  ]),
  scene('hub', [narration('hub')]),
  scene('other', [narration('other')]),
]

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** intermission タブロー検証用の内部アクセサ */
interface RendererInternals {
  initialized: boolean
  storyEnded: boolean
  intermissionTimer: number | null
  readSceneProgress: Set<string>
  waitingForChoice: boolean
  dialogBox: { dialogText: { text: string } }
  characterLayer: { clearForSceneTransition: (durationMsOverride?: number) => void }
  fadeOutBackgroundEntries: (durationMs: number) => void
  renderIntermissionTableau: (events: Event[]) => void
  applyState: (state: NovelGameState) => void
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

describe('NovelRenderer intermission.md 専用シーン (#404)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  // ===== A. hasIntermissionScene() の同値分割 =====

  it('1: setIntermissionScene(null)/(undefined)/([]) はいずれも hasIntermissionScene()=false（未設定扱い）', () => {
    const r = makeRenderer(SCENES)
    r.setIntermissionScene(null)
    expect(r.hasIntermissionScene()).toBe(false)
    r.setIntermissionScene(undefined)
    expect(r.hasIntermissionScene()).toBe(false)
    r.setIntermissionScene([])
    expect(r.hasIntermissionScene()).toBe(false)
  })

  it('2: setIntermissionScene([narration]) で hasIntermissionScene()=true', () => {
    const r = makeRenderer(SCENES)
    r.setIntermissionScene([narration('x')])
    expect(r.hasIntermissionScene()).toBe(true)
  })

  // ===== B. 消去フェード時間の出所（デシジョンテーブル #1 / #3） =====

  it('3: intermission 未設定で jumpToScene 圏外 → fadeOutBackgroundEntries/clearForSceneTransition が本編の backgroundFadeMs で呼ばれる', () => {
    const r = makeRenderer(SCENES)
    r.setBackgroundFadeMs(650) // 本編 per-game 設定（intermission とは無関係な値にしておく）
    const bgSpy = vi.spyOn(
      r as unknown as { fadeOutBackgroundEntries: (ms: number) => void },
      'fadeOutBackgroundEntries'
    )
    const charSpy = vi.spyOn(internals(r).characterLayer, 'clearForSceneTransition')

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    expect(bgSpy).toHaveBeenCalledWith(650)
    // intermission 未設定なので override 無し（undefined）＝ CharacterLayer 自身の characterFadeMs が使われる。
    expect(charSpy).toHaveBeenCalledWith(undefined)
  })

  it('4: intermission 設定済みで jumpToScene 圏外 → 上記2メソッドが intermission 自身の fade 値で呼ばれる（本編値は無視）', () => {
    const r = makeRenderer(SCENES)
    r.setBackgroundFadeMs(650) // 本編値。intermission 側の値と異なることを確認するための対照値。
    r.setIntermissionScene([narration('x')], { backgroundFadeMs: 900, characterFadeMs: 800 })
    const bgSpy = vi.spyOn(
      r as unknown as { fadeOutBackgroundEntries: (ms: number) => void },
      'fadeOutBackgroundEntries'
    )
    const charSpy = vi.spyOn(internals(r).characterLayer, 'clearForSceneTransition')

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    expect(bgSpy).toHaveBeenCalledWith(900)
    expect(charSpy).toHaveBeenCalledWith(800)
  })

  it('5: intermission 設定済みで Choice 全滅 → 上記2メソッドが intermission 自身の fade 値で呼ばれ、かつ既読化される', async () => {
    const r = makeRenderer(CHOICE_SCENES)
    r.setDocKey('doc-404-choice-all-out') // markCurrentSceneRead を実際に効かせる
    r.setIntermissionScene([narration('x')], { backgroundFadeMs: 900, characterFadeMs: 800 })
    const bgSpy = vi.spyOn(
      r as unknown as { fadeOutBackgroundEntries: (ms: number) => void },
      'fadeOutBackgroundEntries'
    )
    const charSpy = vi.spyOn(internals(r).characterLayer, 'clearForSceneTransition')
    r.setConfinedSceneIds(['entry']) // hub / other は圏外

    await r.playScript([{ type: 'advance' }]) // narration → Choice 到達 → 全滅短絡 → endStory()

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(bgSpy).toHaveBeenCalledWith(900)
    expect(charSpy).toHaveBeenCalledWith(800)
    expect(internals(r).readSceneProgress.has('entry')).toBe(true)
  })

  // ===== C. onStoryEndedChangeCallback の発火位置・タイミング不変 =====

  it('6: onStoryEndedChangeCallback の発火位置・タイミングは intermission 有無で変わらない（同期的に1回・tick 前）', () => {
    const cbWithout = vi.fn()
    const rWithout = makeRenderer(SCENES)
    rWithout.setOnStoryEndedChange(cbWithout)
    rWithout.setConfinedSceneIds(['entry'])
    rWithout.jumpToScene('out-scene')
    expect(cbWithout).toHaveBeenCalledTimes(1)
    expect(cbWithout).toHaveBeenCalledWith(true)

    const cbWith = vi.fn()
    const rWith = makeRenderer(SCENES)
    rWith.setIntermissionScene([narration('x')], { backgroundFadeMs: 10, characterFadeMs: 10 })
    rWith.setOnStoryEndedChange(cbWith)
    rWith.setConfinedSceneIds(['entry'])
    rWith.jumpToScene('out-scene')
    // tick を一切進めていない時点（タブロー未描画）で、既に true で1回発火している。
    expect(cbWith).toHaveBeenCalledTimes(1)
    expect(cbWith).toHaveBeenCalledWith(true)
  })

  // ===== D. 二重発火防止 =====

  it('7: jumpToScene(圏外) を2回連続で呼んでも intermissionTimer は1つしかセットされない', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    r.setIntermissionScene([narration('x')], { backgroundFadeMs: 100, characterFadeMs: 100 })
    r.setConfinedSceneIds(['entry'])

    r.jumpToScene('out-scene')
    const timerId = internals(r).intermissionTimer
    expect(timerId).not.toBeNull()

    r.jumpToScene('out-scene') // 2回目（endStory 側の二重発火防止で早期 return するはず）
    expect(internals(r).intermissionTimer).toBe(timerId) // 新しいタイマーに置き換わっていない
  })

  // ===== E. virtual time で delay 経過後にタブローが描画される =====

  it('8: virtual time を delayMs 分進めると、tableau の Background(色)/Dialog が反映される', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setIntermissionScene([backgroundColor('#224466'), dialog(null, 'ただいま')], {
      backgroundFadeMs: 100,
      characterFadeMs: 50,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    // endStory() 直後: 消去フェードで backgroundColor は null にクリアされ、タブローはまだ描かれない。
    expect(r.getSnapshot().backgroundColor).toBeNull()
    expect(internals(r).dialogBox.dialogText.text).toBe('')

    // delay = max(intermissionBackgroundFadeMs, intermissionCharacterFadeMs) = max(100, 50) = 100
    r.getTimeController().tick(100)

    expect(r.getSnapshot().backgroundColor).toBe('#224466')
    expect(internals(r).dialogBox.dialogText.text).toBe('ただいま')
  })

  // ===== F. events 件数による表示内容の境界値 =====

  it('9: events=1件（Narration のみ）→ そのテキストがそのまま表示される', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setIntermissionScene([narration('ひとことだけ')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    r.getTimeController().tick(10)

    expect(internals(r).dialogBox.dialogText.text).toBe('ひとことだけ')
  })

  it('10: events=複数件の Dialog/Narration → 最後の1件だけが最終的に表示される（上書き仕様の固定化）', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    // 話者名は null 固定（jsdom は canvas getContext を null スタブしており（src/test/setup.ts）、
    // borderless=false + 名前ありだと updateNameDisplay の nameText.width 計測が例外を投げる。
    // 実ブラウザでは無関係な jsdom 環境の制約なので、ここでは character=null で回避する）。
    r.setIntermissionScene([narration('いち'), dialog(null, 'に'), narration('さん')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    r.getTimeController().tick(10)

    expect(internals(r).dialogBox.dialogText.text).toBe('さん')
  })

  // ===== G. Choice/Wait/WaitDisplayComplete は無視系（例外を投げず継続） =====

  it('11: Choice/Wait/WaitDisplayComplete を含む events は例外を投げず、DEV でだけ console.warn し、他のイベント処理は継続する', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setIntermissionScene(
      [
        narration('前'),
        { Choice: { options: [] } } as Event,
        'WaitDisplayComplete',
        { Wait: { ms: 100 } } as Event,
        narration('後'),
      ],
      { backgroundFadeMs: 10, characterFadeMs: 10 }
    )
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    expect(() => r.getTimeController().tick(10)).not.toThrow()

    // 無視された3イベント分だけ dev warn が出て、前後の narration は普通に処理され続ける。
    const intermissionWarns = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('intermission.md')
    )
    expect(intermissionWarns.length).toBe(3)
    expect(internals(r).dialogBox.dialogText.text).toBe('後')
  })

  // ===== H. 副作用の非漏出 =====

  it('12: タブロー描画中に onSkipModeChange コールバックが一度も呼ばれない', () => {
    const skipCb = vi.fn()
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setOnSkipModeChange(skipCb)
    r.setIntermissionScene([backgroundColor('#111111'), narration('x')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    r.getTimeController().tick(10)

    expect(skipCb).not.toHaveBeenCalled()
  })

  // ===== I. タイマーキャンセル経路（restart / applyState / destroy） =====

  it('13: endStory 後 delay 経過前に restart() を呼ぶと intermissionTimer がキャンセルされ、tableau は描画されない', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    const tableauSpy = vi.spyOn(
      r as unknown as { renderIntermissionTableau: (events: Event[]) => void },
      'renderIntermissionTableau'
    )
    r.setIntermissionScene([narration('x')], { backgroundFadeMs: 100, characterFadeMs: 100 })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    expect(internals(r).intermissionTimer).not.toBeNull()

    r.restart()
    expect(internals(r).intermissionTimer).toBeNull()

    r.getTimeController().tick(200) // 元の delay を過ぎても描画されない
    expect(tableauSpy).not.toHaveBeenCalled()
  })

  it('14: endStory 後 delay 経過前に applyState（restoreToScene 経由と同じ後始末）を叩くとタイマーがキャンセルされる', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    const tableauSpy = vi.spyOn(
      r as unknown as { renderIntermissionTableau: (events: Event[]) => void },
      'renderIntermissionTableau'
    )
    r.setIntermissionScene([narration('x')], { backgroundFadeMs: 100, characterFadeMs: 100 })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    expect(internals(r).intermissionTimer).not.toBeNull()

    // セーブロード / goBack / seekTo はすべて applyState を経由する（loadFromSaveData.test.ts と同じ直呼び流儀）。
    internals(r).applyState({ ...r.getSnapshot(), storyEnded: false })
    expect(internals(r).intermissionTimer).toBeNull()

    r.getTimeController().tick(200)
    expect(tableauSpy).not.toHaveBeenCalled()
  })

  it('15: destroy() 呼び出しで pending 中の intermissionTimer がリークしない', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setIntermissionScene([narration('x')], { backgroundFadeMs: 100, characterFadeMs: 100 })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    expect(internals(r).intermissionTimer).not.toBeNull()

    // destroy() は appInitialized（init() 完了）ガード付きの early-return を持つ (React StrictMode 対策)。
    // PixiJS 実 init は jsdom 対象外のため、ガードを満たしつつ canvas/app.destroy をここだけ最小スタブする
    // （NovelRenderer.*.test.ts 全体で PixiJS 実描画・破棄フローには乗らない既存の割り切りと同じ）。
    const appInternals = r as unknown as {
      appInitialized: boolean
      app: { canvas: unknown; destroy: (...args: unknown[]) => void }
    }
    appInternals.appInitialized = true
    // app.canvas は PixiJS Application のゲッター専用プロパティ（代入不可）なので
    // defineProperty で instance 側に配置済みプロパティとして上書きする。
    Object.defineProperty(appInternals.app, 'canvas', {
      configurable: true,
      value: { removeEventListener: () => {} },
    })
    appInternals.app.destroy = () => {}

    expect(() => r.destroy()).not.toThrow()
    expect(internals(r).intermissionTimer).toBeNull()
  })

  // ===== J. Flag ディレクティブは GameState を汚染しない (#404 セルフレビュー S2) =====
  //
  // Choice/Wait/WaitDisplayComplete は明示的に無視される一方、それ以外は全て processDirective
  // へフォールスルーしていたため、Flag ディレクティブが this.gameState.setFlag(...) を呼び、
  // NovelGameState を恒久的に書き換えてしまっていた。これは本メソッド docstring の
  // 「通常再生ストリーム（…flags等）には一切触れない」という明言に反する。
  // Choice/Wait と同様に明示無視することを、getSnapshot().flags が不変であることで直接検証する。

  it('16: intermission.md 内の Flag ディレクティブは無視され、getSnapshot().flags を汚染しない（S2 回帰）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    const flagsBefore = r.getSnapshot().flags
    r.setIntermissionScene(
      [
        narration('前'),
        { Flag: { name: 'seen_ending', value: { Bool: true } } } as Event,
        narration('後'),
      ],
      { backgroundFadeMs: 10, characterFadeMs: 10 }
    )
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    r.getTimeController().tick(10)

    // 無視された Flag 分だけ dev warn が出て、前後の narration は普通に処理され続ける。
    const intermissionWarns = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('intermission.md')
    )
    expect(intermissionWarns.length).toBe(1)
    expect(internals(r).dialogBox.dialogText.text).toBe('後')
    // Flag ディレクティブが GameState の flags を一切書き換えていない。
    expect(r.getSnapshot().flags).toEqual(flagsBefore)
    expect(r.getSnapshot().flags).toEqual({})
  })

  // ===== K. skipMode の例外時復元 (#404 セルフレビュー S3) =====
  //
  // renderIntermissionTableau は開始直後に skipMode を true へ一時的に切り替え（instant 表示のため
  // processDirective 内の `instant: this.skipMode` 判定を流用する）、finally で呼び出し前の値へ
  // 戻す。try/finally の実装自体は #404 フェーズ2から存在するが、それを直接検証するテストが
  // 無かったため追加する（processDirective が例外を投げる経路を明示的に作って確認する）。

  it('17: renderIntermissionTableau 内で processDirective が例外を投げても、finally で skipMode は呼び出し前の値へ確実に戻る（S3 直接検証）', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    expect(r.isSkipMode()).toBe(false) // 呼び出し前の値（既定 false）

    const boom = new Error('boom')
    vi.spyOn(
      r as unknown as { processDirective: (event: Event) => void },
      'processDirective'
    ).mockImplementation(() => {
      throw boom
    })

    expect(() => internals(r).renderIntermissionTableau([backgroundColor('#000000')])).toThrow(boom)

    // 例外がそのまま外へ伝播しても、finally が呼び出し前の値（false）へ確実に戻す。
    expect(r.isSkipMode()).toBe(false)
  })
})
