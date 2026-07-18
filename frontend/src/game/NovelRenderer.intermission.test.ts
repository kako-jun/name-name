/**
 * NovelRenderer の intermission.md 専用シーン化 (#404 フェーズ2 / #424 段階フェード) のテスト。
 *
 * `setIntermissionScene(events, options)` で登録した Event[] は、endStory() のフェード演出が
 * 終わった後に「静止画タブロー」として描画され、そこで凍結する（renderIntermissionTableau。
 * GameState には持たず、advance() は storyEnded で no-op のまま）。`Wait { ms }` を含む場合は
 * #424 でタブロー専用のローカル・ステージングとして扱われ、指定 ms 後に残りのイベントから
 * 再開する（それ以外は endStory 直後に一括で処理される）。
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

/** `[待機: Nms]`（数値指定のみ）に対応する Wait イベント (#424)。 */
function wait(ms: number): Event {
  return { Wait: { ms } }
}

/** `[ラベル: text]` イベント (#274)。instant フラグの直接検証用 (#424 セルフレビュー should)。 */
function label(text: string): Event {
  return { Label: { text } } as Event
}

/** `[画像: path]` イベント (#274)。instant フラグの直接検証用 (#424 セルフレビュー should)。 */
function image(path: string): Event {
  return { Image: { path } } as Event
}

function eventImage(
  path: string,
  opts?: { back?: 'Hide' | 'Keep'; fadeMs?: number | null }
): Event {
  return { EventImage: { path, back: opts?.back, fade_ms: opts?.fadeMs ?? null } } as Event
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
  dialogBox: {
    dialogText: { text: string }
    setDialog: (name: string | null, text: string) => void
    setMsPerChar: (ms: number) => void
  }
  characterLayer: {
    clearForSceneTransition: (durationMsOverride?: number) => void
    showLabel: (...args: unknown[]) => void
    showImage: (...args: unknown[]) => void
  }
  eventImageLayer: {
    show: (...args: unknown[]) => void
  }
  fadeOutBackgroundEntries: (durationMs: number) => void
  renderIntermissionTableau: (events: Event[], startIndex?: number) => void
  applyState: (state: NovelGameState) => void
  appInitialized: boolean
  app: { canvas: unknown; destroy: (...args: unknown[]) => void }
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * Wait ステージング (#424) 専用テスト向けの共通セットアップ。
 * intermission タブロー自体の外側消去フェード（jumpToScene→endStory）を最小の 10ms 固定で
 * 発火させ、以降の tick() 呼び出しは events 内の Wait の ms だけに集中できるようにする
 * （endStory 側の delay と Wait 自身の delay の合算を毎回暗算しないため）。
 * 呼び出し後、events[0] から Wait に到達するまでの処理が既に済んだ状態になる。
 */
function setupWaitStaging(r: NovelRenderer, events: Event[]): void {
  r.getTimeController().setMode('virtual')
  internals(r).initialized = true
  r.setIntermissionScene(events, { backgroundFadeMs: 10, characterFadeMs: 10 })
  r.setConfinedSceneIds(['entry'])
  r.jumpToScene('out-scene')
  r.getTimeController().tick(10)
}

/**
 * destroy() の appInitialized ガードを満たすための最小スタブ（既存テスト15と同じ割り切り）。
 * PixiJS 実 init は jsdom 対象外のため、ガードを満たしつつ canvas/app.destroy をここだけ
 * 最小スタブする。
 */
function stubDestroyableApp(r: NovelRenderer): void {
  const appInternals = internals(r)
  appInternals.appInitialized = true
  // app.canvas は PixiJS Application のゲッター専用プロパティ（代入不可）なので
  // defineProperty で instance 側に配置済みプロパティとして上書きする。
  Object.defineProperty(appInternals.app, 'canvas', {
    configurable: true,
    value: { removeEventListener: () => {} },
  })
  appInternals.app.destroy = () => {}
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

  it('4b: intermission 内の [イベント絵] は本編値ではなく intermission 自身の eventImageFadeMs を使う', () => {
    const r = makeRenderer(SCENES)
    r.setAssetBaseUrl('/assets')
    r.setEventImageFadeMs(300)
    r.setIntermissionScene([eventImage('story/intermission.webp')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
      eventImageFadeMs: 1400,
    })
    const showSpy = vi.spyOn(internals(r).eventImageLayer, 'show').mockImplementation(() => {})

    internals(r).renderIntermissionTableau([eventImage('story/intermission.webp')])

    expect(showSpy).toHaveBeenCalledWith(
      'story/intermission.webp',
      expect.objectContaining({ back: undefined, fadeMs: 1400 })
    )
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

  // ===== G. Choice/WaitDisplayComplete は無視系（例外を投げず継続） =====
  //
  // Wait { ms } は #424 でタブロー専用のローカル・ステージング対象になった（この「無視して
  // 継続」グループからは外れた）ため、ここでは対象外にする。Wait のステージング挙動
  // （フェード中の中間状態・時間経過後の再開・タイマーキャンセル）は次段階のテスト作成
  // エージェントが別途カバーする。

  it('11: Choice/WaitDisplayComplete を含む events は例外を投げず、DEV でだけ console.warn し、他のイベント処理は継続する', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setIntermissionScene(
      [
        narration('前'),
        { Choice: { options: [] } } as Event,
        'WaitDisplayComplete',
        narration('後'),
      ],
      { backgroundFadeMs: 10, characterFadeMs: 10 }
    )
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    expect(() => r.getTimeController().tick(10)).not.toThrow()

    // 無視された2イベント分だけ dev warn が出て、前後の narration は普通に処理され続ける。
    const intermissionWarns = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('intermission.md')
    )
    expect(intermissionWarns.length).toBe(2)
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

  // ===== H2. Label/Image に渡る instant フラグの直接検証 (#424 セルフレビュー should) =====
  //
  // 上のセクション E〜G は BackgroundColor/Dialog という同期確定フィールドでタブローの描画結果を
  // 間接的に確認するのみで、processDirective が Label/Image に渡す `instant: this.skipMode`
  // （NovelRenderer.ts の showLabel/showImage 呼び出し）そのものを検証するテストがこれまで
  // 1本もなかった。これが「skipMode=true のまま endStory() に入ると #424 の段階フェードが
  // 瞬間タブローに退行する」must バグを実装・テスト双方で見逃した直接の原因。
  // Label は同期処理・Image は Assets.load を裏で fire-and-forget するが、ここでは呼び出し
  // 引数だけを見るため await は不要（CharacterLayer.test.ts の showImage 系テストと同じ割り切り）。

  it('31: 既定 skipMode=false では、タブロー内の Label/Image は instant: false で呼ばれる', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    const showLabelSpy = vi.spyOn(internals(r).characterLayer, 'showLabel')
    const showImageSpy = vi.spyOn(internals(r).characterLayer, 'showImage')
    r.setIntermissionScene([label('見出し'), image('avatar.png')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    r.getTimeController().tick(10)

    expect(showLabelSpy).toHaveBeenCalledWith(expect.objectContaining({ instant: false }))
    expect(showImageSpy).toHaveBeenCalledWith(expect.objectContaining({ instant: false }))
  })

  it('32: skipMode=true 中に全 option 圏外の Choice で終劇へ短絡しても endStory() 側で skipMode がリセットされ、タブロー内の Label/Image は instant: false で呼ばれる（must 修正の直接回帰）', async () => {
    const r = makeRenderer(CHOICE_SCENES)
    r.getTimeController().setMode('virtual')
    r.setIntermissionScene([label('見出し'), image('avatar.png')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    r.setConfinedSceneIds(['entry']) // hub / other は圏外
    const skipCb = vi.fn()
    r.setOnSkipModeChange(skipCb)
    r.setSkipMode(true)
    expect(r.isSkipMode()).toBe(true)

    // narration('本文') → advance 1 回で Choice に到達 → 全 option 圏外の短絡（#398）→ endStory()。
    // この経路は通常の Choice 表示前の setSkipMode(false) を通らないため、修正前は skipMode=true
    // のまま endStory() に入っていた。
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(r.isSkipMode()).toBe(false) // must 修正: endStory() 冒頭で skipMode がリセットされる
    // re-review should 修正: skipMode は NovelGameState/applyState の対象外（ADR0002）で
    // あり、onSkipModeChange が React 側（NovelPlayer の Skip ボタン表示）へ true→false を
    // 伝える唯一の経路。直接代入だけでは NovelPlayer 側の state が true のまま取り残される。
    expect(skipCb).toHaveBeenCalledWith(false)

    // タブロー描画（intermissionTimer の遅延発火）を通すため、endStory() 後に initialized を立てる。
    internals(r).initialized = true
    const showLabelSpy = vi.spyOn(internals(r).characterLayer, 'showLabel')
    const showImageSpy = vi.spyOn(internals(r).characterLayer, 'showImage')
    r.getTimeController().tick(10)

    // 修正前は skipMode=true のまま renderIntermissionTableau に入り、instant: true（瞬間表示）で
    // 呼ばれていた（#424 の段階フェードが瞬間タブローに退行するバグ）。
    expect(showLabelSpy).toHaveBeenCalledWith(expect.objectContaining({ instant: false }))
    expect(showImageSpy).toHaveBeenCalledWith(expect.objectContaining({ instant: false }))
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

  // ===== K. skipMode の例外時復元 (#404 セルフレビュー S3) は #424 で撤去 =====
  //
  // renderIntermissionTableau が開始直後に skipMode を true へ一時的に切り替える強制（前後の値の
  // 退避・finally での復元）は #424 で撤去した（Label/Image のネイティブフェードインを素直に効かせる
  // ため）。この節が検証していた try/finally の revert 挙動はもう存在しないため、旧テスト17は削除した。

  // ===== L. Wait 単発ステージング (#424) =====

  it('17: Wait 待機中は Wait 直前までの内容で凍結し、指定 ms に達すると残りが反映される（デシジョンテーブル#5）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [backgroundColor('#111111'), wait(500), dialog(null, 'あと')])

    // Wait 直前の BackgroundColor は既に反映されている一方、Wait 後の Dialog はまだ届いていない。
    expect(r.getSnapshot().backgroundColor).toBe('#111111')
    expect(internals(r).dialogBox.dialogText.text).toBe('')

    r.getTimeController().tick(499) // Wait 500ms のうち 499ms 経過（未満）
    expect(internals(r).dialogBox.dialogText.text).toBe('')

    r.getTimeController().tick(1) // 合計 500ms 経過 → 発火
    expect(internals(r).dialogBox.dialogText.text).toBe('あと')
  })

  it('18: Wait 発火後、後続に Wait が無ければ intermissionTimer は null に戻る', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(200), dialog(null, '後')])

    r.getTimeController().tick(200)

    expect(internals(r).intermissionTimer).toBeNull()
    expect(internals(r).dialogBox.dialogText.text).toBe('後')
  })

  it('19: Wait 待機中（未発火）は intermissionTimer が非 null', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(200), dialog(null, '後')])

    expect(internals(r).intermissionTimer).not.toBeNull()
  })

  // ===== M. Wait 複数連続ステージング (#424) =====

  it('20: Wait が連続する場合、各 tick で1段ずつ進み最終的に最後の Dialog が表示される（デシジョンテーブル#10）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(100), dialog(null, '一段目'), wait(100), dialog(null, '二段目')])

    r.getTimeController().tick(100) // 1個目の Wait 発火 → '一段目' が反映される
    expect(internals(r).dialogBox.dialogText.text).toBe('一段目')

    r.getTimeController().tick(100) // 2個目の Wait 発火 → '二段目' で上書きされる
    expect(internals(r).dialogBox.dialogText.text).toBe('二段目')
  })

  it('21: Wait が events の最後の要素でも、発火後に例外が出ず追加の変化もない（境界値）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [dialog(null, '本文'), wait(50)])
    expect(internals(r).dialogBox.dialogText.text).toBe('本文')

    expect(() => r.getTimeController().tick(50)).not.toThrow()

    expect(internals(r).dialogBox.dialogText.text).toBe('本文') // 変化なし
    expect(internals(r).intermissionTimer).toBeNull() // 新しいタイマーはセットされない
  })

  // ===== N. Wait 待機中の中断 (#424) =====

  it('22: Wait 待機中に destroy() すると intermissionTimer が null になり、以後 tick を進めても Wait 後の内容が反映されない（デシジョンテーブル#6）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(200), dialog(null, '後')])
    expect(internals(r).intermissionTimer).not.toBeNull()

    stubDestroyableApp(r)
    expect(() => r.destroy()).not.toThrow()
    expect(internals(r).intermissionTimer).toBeNull()

    r.getTimeController().tick(200)
    expect(internals(r).dialogBox.dialogText.text).toBe('') // Wait 後の内容は反映されない
  })

  it('23: Wait 待機中に restart()（resetAndStartEvents 経由）すると intermissionTimer がキャンセルされ、新しいシーン側に正しく上書きされる（デシジョンテーブル#7）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(200), dialog(null, '後')])
    expect(internals(r).intermissionTimer).not.toBeNull()

    r.restart() // rawEvents は jumpToScene(圏外)/endStory では書き換わらないため entry の内容に戻る
    expect(internals(r).intermissionTimer).toBeNull()
    // restart() 後の通常再生はタイプライター中（Pixi Ticker は jsdom で自動進行しないため
    // dialogText.text は空のまま）。renderIntermissionTableau と違い skipTypewriter を
    // 自動で挟まないので、DialogBox.test.ts と同じ流儀で msPerChar=0 にして即時 reveal させる。
    internals(r).dialogBox.setMsPerChar(0)

    r.getTimeController().tick(200)
    // Wait 後の内容('後')が漏れ出さず、restart() が復元した entry シーン側の内容('start')に
    // 正しく上書きされている。
    expect(internals(r).dialogBox.dialogText.text).toBe('start')
  })

  it('24: Wait 待機中に applyState（goBack/seekTo 相当）を叩くと intermissionTimer がキャンセルされ、storyEnded が復元値になる（デシジョンテーブル#8）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(200), dialog(null, '後')])
    expect(internals(r).intermissionTimer).not.toBeNull()

    // セーブロード / goBack / seekTo はすべて applyState を経由する（loadFromSaveData.test.ts と同じ直呼び流儀）。
    internals(r).applyState({ ...r.getSnapshot(), storyEnded: false })
    expect(internals(r).intermissionTimer).toBeNull()
    expect(r.getSnapshot().storyEnded).toBe(false)

    r.getTimeController().tick(200)
    // Wait 後の内容が、applyState で復元済みの画面を上書きしない。
    expect(internals(r).dialogBox.dialogText.text).toBe('')
  })

  it('25: 2つ目の Wait が pending 中に destroy() すると、1つ目の効果だけが反映されて凍結する（デシジョンテーブル#11）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(100), dialog(null, '一段目'), wait(100), dialog(null, '二段目')])

    r.getTimeController().tick(100) // 1個目 Wait 発火 → '一段目' 反映、2個目 Wait が pending に
    expect(internals(r).dialogBox.dialogText.text).toBe('一段目')
    expect(internals(r).intermissionTimer).not.toBeNull()

    stubDestroyableApp(r)
    expect(() => r.destroy()).not.toThrow()
    expect(internals(r).intermissionTimer).toBeNull()

    r.getTimeController().tick(100) // 2個目の Wait 分の時間が経過しても…
    expect(internals(r).dialogBox.dialogText.text).toBe('一段目') // …'二段目' には進まない
  })

  // ===== O. Wait ms 境界値・同値分割 (#424) =====

  it('26: Wait{ms:0} は TimeController.tick(0) だけで発火する（同値分割・下限）', () => {
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    // 外側の消去フェードも 0ms にして、Wait 自身の ms:0 だけを tick(0) で観測できるようにする。
    r.setIntermissionScene([wait(0), dialog(null, '即時')], {
      backgroundFadeMs: 0,
      characterFadeMs: 0,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    expect(internals(r).dialogBox.dialogText.text).toBe('') // tick 前はまだ

    r.getTimeController().tick(0)
    expect(internals(r).dialogBox.dialogText.text).toBe('即時')
  })

  it('27: 推奨3値相当（300ms/1400ms）を含め、クランプされず指定 ms ぴったりで発火する（同値分割）', () => {
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(300), dialog(null, '短め'), wait(1400), dialog(null, '長め')])

    r.getTimeController().tick(299)
    expect(internals(r).dialogBox.dialogText.text).toBe('')
    r.getTimeController().tick(1) // 合計 300ms → 1個目発火
    expect(internals(r).dialogBox.dialogText.text).toBe('短め')

    r.getTimeController().tick(1399)
    expect(internals(r).dialogBox.dialogText.text).toBe('短め') // まだ
    r.getTimeController().tick(1) // 合計 1400ms → 2個目発火
    expect(internals(r).dialogBox.dialogText.text).toBe('長め')
  })

  it('28（防御的）: Wait{ms:-1} 相当は TimeController 側で 0 にクランプされ即時発火する（.md からは到達不能な型安全網の確認）', () => {
    // Rust 側パーサの `Wait { ms: u32 }`（u32 は符号なし整数）により、`.md` の `[待機: Nms]` から
    // 負値の Event が構築されることはない。ここでは TS 側の型（number）上は表現できてしまうため、
    // TimeController.setTimeout 内の `Math.max(0, ms)` クランプが型安全網として機能することだけを
    // 直接構築で確認する（実データでは到達しない防御的テスト）。
    const r = makeRenderer(SCENES)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setIntermissionScene([wait(-1), dialog(null, '即時')], {
      backgroundFadeMs: 0,
      characterFadeMs: 0,
    })
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    expect(internals(r).dialogBox.dialogText.text).toBe('') // tick 前はまだ

    r.getTimeController().tick(0) // 0 にクランプされているので tick(0) だけで発火する
    expect(internals(r).dialogBox.dialogText.text).toBe('即時')
  })

  // ===== P. ログ非汚染 (#424) =====

  it('29: Wait を含む events を処理しても intermission 関連の warn は1件も出ない（Choice/WaitDisplayComplete/Flag との対比。テスト11/16参照）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    setupWaitStaging(r, [wait(100), dialog(null, '後')])

    r.getTimeController().tick(100)

    const intermissionWarns = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('intermission.md')
    )
    expect(intermissionWarns.length).toBe(0)
    expect(internals(r).dialogBox.dialogText.text).toBe('後')
  })

  // ===== Q. 再入・二重発火の防御的検証 (#424) =====

  it('30: renderIntermissionTableau を同じ startIndex から直接2回連続呼んでも、pending タイマーは1つだけで二重にコールバックが走らない（再入防御）', () => {
    const r = makeRenderer(SCENES)
    const events = [wait(100), dialog(null, '後')]
    setupWaitStaging(r, events)
    // setupWaitStaging 内の endStory 経由の1回目呼び出しで、既に Wait が pending 状態。
    const firstTimerId = internals(r).intermissionTimer
    expect(firstTimerId).not.toBeNull()
    expect(r.getTimeController().getPendingTimerCount()).toBe(1)

    const setDialogSpy = vi.spyOn(internals(r).dialogBox, 'setDialog')

    // 2回目を同じ startIndex(0) から強制的に直接呼ぶ（本来この経路には来ないはずの再入を模擬）。
    internals(r).renderIntermissionTableau(events, 0)

    // 二重に walk しても pending タイマーは1つだけ（古いタイマーが正しく clear されている）。
    expect(r.getTimeController().getPendingTimerCount()).toBe(1)
    expect(internals(r).intermissionTimer).not.toBe(firstTimerId) // 新しいタイマーに置き換わっている

    r.getTimeController().tick(100)
    // 二重にコールバックが走っていれば setDialog も2回呼ばれるはずだが、1回だけで済んでいる。
    expect(setDialogSpy).toHaveBeenCalledTimes(1)
    expect(setDialogSpy).toHaveBeenCalledWith(null, '後')
  })
})
