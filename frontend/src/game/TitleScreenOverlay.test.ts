/**
 * TitleScreenOverlay の単体テスト (#628 フェーズ2b)。
 *
 * NovelRenderer との仲介契約（dialogBox/seekBar/eventImageLayer の可視性・split_layout 退避・
 * characterLayer.showImage 経由のロゴ表示）は NovelRenderer.titleScreen.test.ts が担保する。
 * ここでは TitleScreenOverlay 自身が閉じた責務——背景色、フォールバックタイトルテキスト、
 * 4 ボタン（新規開始/つづきから/設定/終了）の描画・disabled 状態・クリック配線——だけを縛る。
 *
 * fill/border の描画検証は ChoiceOverlay.test.ts と同じ流儀（`Graphics.prototype.fill` を
 * スパイし、number 引数（ボタン本体色。ChoiceOverlay と違いこのクラスは shadow を描かないため
 * 全 fill 呼び出しが number 引数になる）を呼び出し順で拾う）。
 *
 * 色定数は TitleScreenOverlay.ts の private 定数（export されていない）をそのまま数値でピン留めする。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Graphics } from 'pixi.js'
import { TitleScreenOverlay, type TitleScreenShowOptions } from './TitleScreenOverlay'

// TitleScreenOverlay.ts の private 色定数（コメントに同じ意味の Tailwind 名を併記）。
const COLOR_PRIMARY_FILL = 0x4f46e5 // indigo-600
const COLOR_PRIMARY_FILL_HOVER = 0x6366f1 // indigo-500
const COLOR_PRIMARY_FILL_DISABLED = 0x312e81 // indigo-900
const COLOR_PRIMARY_TEXT_DISABLED = 0x818cf8 // indigo-400
const COLOR_SECONDARY_FILL = 0x374151 // gray-700
const COLOR_TEXT_PRIMARY = 0xffffff
const COLOR_TEXT_SECONDARY = 0xe5e7eb // gray-200
const COLOR_BG_DARK = 0x111827 // gray-900
const COLOR_BG_LIGHT = 0x1e1b4b // indigo-950
const BUTTON_HEIGHT = 40
const BUTTON_MIN_WIDTH = 160
const BUTTON_MAX_WIDTH = 280

function makeOpts(overrides?: Partial<TitleScreenShowOptions>): TitleScreenShowOptions {
  return {
    title: 'テストタイトル',
    hasSaveData: false,
    onNewGame: vi.fn(),
    onContinue: vi.fn(),
    onOpenSettings: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  }
}

interface TitleTextLike {
  text: string
  visible: boolean
}
interface OverlayInternals {
  titleText: TitleTextLike | null
  renderResolution: number
}
function internals(o: TitleScreenOverlay): OverlayInternals {
  return o as unknown as OverlayInternals
}

/** 描画順どおりの number 引数 fill 呼び出しだけを抽出する（bg 1件 + ボタン4件の計5件）。 */
function numberFillCalls(calls: readonly unknown[][]): number[] {
  return calls.map((args) => args[0]).filter((v): v is number => typeof v === 'number')
}

describe('TitleScreenOverlay.show() 背景・タイトルテキスト', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC15: show({title, hasSaveData:true, dark:false}) で背景色が COLOR_BG_LIGHT・タイトルテキストが opts.title になる', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ title: '固有タイトル', hasSaveData: true, dark: false }))

    const fills = numberFillCalls(fillSpy.mock.calls)
    expect(fills[0]).toBe(COLOR_BG_LIGHT)
    expect(internals(overlay).titleText?.text).toBe('固有タイトル')
  })

  it('TC16: dark:true で背景色が COLOR_BG_DARK に変わる', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ dark: true }))

    expect(numberFillCalls(fillSpy.mock.calls)[0]).toBe(COLOR_BG_DARK)
  })
})

describe('TitleScreenOverlay.show() ボタン disabled/enabled (つづきから)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // children 順序: [0]=bg, [1]=titleText, [2]=新規開始, [3]=つづきから, [4]=設定, [5]=終了
  const CONTINUE_BUTTON_CHILD_INDEX = 3

  it('TC17: hasSaveData:false で「つづきから」ボタンが無効化される（eventMode="none"・disabled配色）', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: false }))

    const continueButton = overlay.children[CONTINUE_BUTTON_CHILD_INDEX]
    expect(continueButton.eventMode).toBe('none')
    // fills: [0]=bg, [1..4]=新規開始/つづきから/設定/終了 の順。つづきから=index2。
    expect(numberFillCalls(fillSpy.mock.calls)[2]).toBe(COLOR_PRIMARY_FILL_DISABLED)
  })

  it('TC18: hasSaveData:true で「つづきから」ボタンが有効（eventMode="static"・通常配色）', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: true }))

    const continueButton = overlay.children[CONTINUE_BUTTON_CHILD_INDEX]
    expect(continueButton.eventMode).toBe('static')
    expect(numberFillCalls(fillSpy.mock.calls)[2]).toBe(COLOR_PRIMARY_FILL)
  })

  it('有効な「設定」ボタンは secondary 灰色ではなく primary の有効色で描画され、disabled な「つづきから」と見分けられる', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: false }))

    const fills = numberFillCalls(fillSpy.mock.calls)
    // fills: [0]=bg, [1]=新規開始, [2]=つづきから(disabled), [3]=設定, [4]=終了
    expect(fills[2]).toBe(COLOR_PRIMARY_FILL_DISABLED)
    expect(fills[3]).toBe(COLOR_PRIMARY_FILL)
    expect(fills[3]).not.toBe(COLOR_SECONDARY_FILL)
  })

  it('有効な「設定」ボタンの hover は primary hover 色になる', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: true }))
    fillSpy.mockClear()

    const settingsButton = overlay.children[4]
    settingsButton.emit('pointerover', {} as never)
    const hoverFills = numberFillCalls(fillSpy.mock.calls)
    expect(hoverFills[hoverFills.length - 1]).toBe(COLOR_PRIMARY_FILL_HOVER)

    settingsButton.emit('pointerout', {} as never)
    const pointerOutFills = numberFillCalls(fillSpy.mock.calls)
    expect(pointerOutFills[pointerOutFills.length - 1]).toBe(COLOR_PRIMARY_FILL)
  })

  it('disabled 配色の文字色/secondary の配色定数が想定どおり（回帰用の定数確認）', () => {
    // このテストは配色定数自体の凡ミスを防ぐための最小限のドキュメント代わり。
    expect(COLOR_PRIMARY_TEXT_DISABLED).toBe(0x818cf8)
    expect(COLOR_SECONDARY_FILL).toBe(0x374151)
    expect(COLOR_TEXT_PRIMARY).toBe(0xffffff)
    expect(COLOR_TEXT_SECONDARY).toBe(0xe5e7eb)
  })
})

describe('TitleScreenOverlay.show() ボタンクリック配線', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC19: 各ボタンの pointertap で対応するコールバックが1回だけ呼ばれる', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onNewGame = vi.fn()
    const onContinue = vi.fn()
    const onOpenSettings = vi.fn()
    const onBack = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onNewGame, onContinue, onOpenSettings, onBack }))

    const [, , newGameBtn, continueBtn, settingsBtn, backBtn] = overlay.children

    newGameBtn.emit('pointertap', {} as never)
    expect(onNewGame).toHaveBeenCalledTimes(1)
    expect(onContinue).not.toHaveBeenCalled()

    continueBtn.emit('pointertap', {} as never)
    expect(onContinue).toHaveBeenCalledTimes(1)

    settingsBtn.emit('pointertap', {} as never)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    backBtn.emit('pointertap', {} as never)
    expect(onBack).toHaveBeenCalledTimes(1)

    // 直前までのタップで他コールバックが多重発火していないこと。
    expect(onNewGame).toHaveBeenCalledTimes(1)
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('disabled ボタン（hasSaveData:false の「つづきから」）は pointertap してもコールバックが呼ばれない（リスナー未接続）', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onContinue = vi.fn()
    overlay.show(makeOpts({ hasSaveData: false, onContinue }))

    overlay.children[3].emit('pointertap', {} as never)

    expect(onContinue).not.toHaveBeenCalled()
  })
})

describe('TitleScreenOverlay.hideFallbackText() / hide()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC20: hideFallbackText() で titleText.visible が false になる', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts())
    expect(internals(overlay).titleText?.visible).toBe(true)

    overlay.hideFallbackText()

    expect(internals(overlay).titleText?.visible).toBe(false)
  })

  it('TC21: hide() で visible=false かつ子要素が破棄される', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts())
    expect(overlay.children.length).toBeGreaterThan(0)

    overlay.hide()

    expect(overlay.visible).toBe(false)
    expect(overlay.children.length).toBe(0)
  })
})

// TC22: テスト設計担当が発見した懸念の固定テスト。show() を2回連続で呼ぶと、1回目の
// hideFallbackText() 済み状態から2回目の show() で titleText が新規に作り直され、
// visible=true に戻ってしまう（=このクラス単体では毎回フォールバックテキストが再出現する）。
//
// 実バグ修正 (#628 フェーズ2b): この「show() は毎回まっさらな titleText を作る」という
// TitleScreenOverlay 自体の挙動は意図的な設計であり、直していない（このクラスはロゴの
// ロード状態を知らない単純なビュー）。実際にフォールバックテキストが表示済みロゴの上に
// 再出現していた実バグは、呼び出し側 `NovelRenderer.showTitleScreen()` が
// `characterLayer.hasLoadedTexture()` でロード済みかを確認し、ロード済みなら
// `titleScreenOverlay.hideFallbackText()` を再度呼ぶことで対処した
// （回帰テスト: `NovelRenderer.titleScreen.test.ts` TC38）。
describe('TitleScreenOverlay.show() 連続呼び出し (#628 テスト設計 TC22)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC22: 1回目 show()→hideFallbackText() 済みの状態から2回目の show() を呼ぶと、新しい titleText が visible=true で作られる（このクラス単体の設計上の挙動——実際のバグは呼び出し側 NovelRenderer で修正済み、TC38参照）', () => {
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ title: '1回目' }))
    const firstTitleText = internals(overlay).titleText
    overlay.hideFallbackText()
    expect(firstTitleText?.visible).toBe(false)

    overlay.show(makeOpts({ title: '2回目' }))
    const secondTitleText = internals(overlay).titleText

    // 新しい titleText インスタンスに総入れ替えされ、visible が既定の true に戻る。
    expect(secondTitleText).not.toBe(firstTitleText)
    expect(secondTitleText?.visible).toBe(true)
    expect(secondTitleText?.text).toBe('2回目')
  })
})

describe('TitleScreenOverlay.setRenderResolution()', () => {
  it('TC23: 0以下/NaN/Infinity を渡すと no-op（直前の有効値を保持する）', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    expect(internals(overlay).renderResolution).toBe(1) // 既定値

    overlay.setRenderResolution(2)
    expect(internals(overlay).renderResolution).toBe(2)

    overlay.setRenderResolution(0)
    expect(internals(overlay).renderResolution).toBe(2)

    overlay.setRenderResolution(-5)
    expect(internals(overlay).renderResolution).toBe(2)

    overlay.setRenderResolution(NaN)
    expect(internals(overlay).renderResolution).toBe(2)

    overlay.setRenderResolution(Infinity)
    expect(internals(overlay).renderResolution).toBe(2)
  })
})

describe('TitleScreenOverlay.handleKeyDown() キーボードフォーカス (#633)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('show() 直後は新規開始（index 0）にフォーカスがある。Tab で つづきから→設定→終了→新規開始 と循環する', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onNewGame = vi.fn()
    const onContinue = vi.fn()
    const onOpenSettings = vi.fn()
    const onBack = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onNewGame, onContinue, onOpenSettings, onBack }))

    // 初期フォーカス=新規開始(0) の状態で Enter → onNewGame が呼ばれる。
    expect(overlay.handleKeyDown('Enter')).toBe(true)
    expect(onNewGame).toHaveBeenCalledTimes(1)

    expect(overlay.handleKeyDown('Tab')).toBe(true)
    overlay.handleKeyDown(' ')
    expect(onContinue).toHaveBeenCalledTimes(1)

    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onBack).toHaveBeenCalledTimes(1)

    // 4つ目の Tab で先頭（新規開始）へ循環する。
    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onNewGame).toHaveBeenCalledTimes(2)
  })

  it('Shift+Tab で逆方向（末尾→先頭の循環含む）に移動する', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onBack = vi.fn()
    const onNewGame = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onBack, onNewGame }))

    // 初期フォーカス=新規開始(0) から Shift+Tab で末尾（終了）へ循環する。
    expect(overlay.handleKeyDown('Tab', true)).toBe(true)
    overlay.handleKeyDown('Enter')
    expect(onBack).toHaveBeenCalledTimes(1)

    // もう一度 Shift+Tab で設定→もう一度で つづきから→もう一度で新規開始 に戻る。
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Enter')
    expect(onNewGame).toHaveBeenCalledTimes(1)
  })

  it('ArrowDown/ArrowUp は Tab/Shift+Tab と同じ扱いでフォーカスを移動する', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onContinue = vi.fn()
    const onNewGame = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onContinue, onNewGame }))

    expect(overlay.handleKeyDown('ArrowDown')).toBe(true)
    overlay.handleKeyDown('Enter')
    expect(onContinue).toHaveBeenCalledTimes(1)

    expect(overlay.handleKeyDown('ArrowUp')).toBe(true)
    overlay.handleKeyDown('Enter')
    expect(onNewGame).toHaveBeenCalledTimes(1)
  })

  it('hasSaveData:false（つづきから disabled）の場合、Tab は つづきから をスキップして 新規開始→設定 と移動する', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onOpenSettings = vi.fn()
    const onContinue = vi.fn()
    overlay.show(makeOpts({ hasSaveData: false, onOpenSettings, onContinue }))

    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('disabled ボタン（つづきから）へは Shift+Tab で先頭から逆循環しても止まらない（終了→設定→新規開始の3つだけを巡回）', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onBack = vi.fn()
    overlay.show(makeOpts({ hasSaveData: false, onBack }))

    // 新規開始(0) から Shift+Tab → 終了(3) （つづきから(1)・設定(2)を跨いで逆循環）。
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Enter')
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('Tab/ArrowDown/ArrowUp/Enter/Space 以外のキーは処理せず false を返す（ゲーム内ショートカットに委譲しない値=falseのみ返す）', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts())

    expect(overlay.handleKeyDown('s')).toBe(false)
    expect(overlay.handleKeyDown('Escape')).toBe(false)
    expect(overlay.handleKeyDown('ArrowLeft')).toBe(false)
    expect(overlay.handleKeyDown('ArrowRight')).toBe(false)
  })

  // #633 テスト観点整理: show() を一度も呼んでいない（focusedIndex が初期値 -1・buttonEntries
  // が空配列のまま）状態で handleKeyDown('Enter') を呼んでも、activateFocusedButton() の
  // `buttonEntries[this.focusedIndex]` が undefined を返すだけで例外にならないことを確認する
  // （NovelRenderer 側が誤って show() 前に keydown を委譲してしまうような呼び出し順序ミスの
  // 保険）。
  it("TC-T1: focusedIndexが初期状態(-1)のままhandleKeyDown('Enter')を呼んでも例外・console.errorを出さない", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const overlay = new TitleScreenOverlay(800, 450)

    expect(() => overlay.handleKeyDown('Enter')).not.toThrow()

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('show() を再度呼ぶとフォーカスが新規開始（index 0）にリセットされる', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onNewGame1 = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onNewGame: onNewGame1 }))
    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Tab') // フォーカス=設定(2)

    const onNewGame2 = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onNewGame: onNewGame2 }))
    overlay.handleKeyDown('Enter')

    expect(onNewGame2).toHaveBeenCalledTimes(1)
  })
})

// #640 テスト観点整理: 黄色いフォーカスリングの visible focus 化（keyboardNavActive）そのものを
// 狙い撃つ回帰テスト。ChoiceOverlay.test.ts の #639 keyboardNavActive 回帰テスト
// （TC-C32〜C40）と同型のスタイル（focusInternals 経由で private フィールドへ直接到達し、
// `Graphics.prototype.stroke` を spy してリング描画の有無を判定する）を踏襲する。
interface FocusableButtonEntryLike {
  container: { eventMode: string }
  focusRing: Graphics
  onClick: () => void
  disabled: boolean
}
interface TitleScreenFocusInternals {
  buttonEntries: FocusableButtonEntryLike[]
  focusedIndex: number
  keyboardNavActive: boolean
  setFocusedIndex: (index: number) => void
}
function focusInternals(o: TitleScreenOverlay): TitleScreenFocusInternals {
  return o as unknown as TitleScreenFocusInternals
}

describe('TitleScreenOverlay keyboardNavActive 回帰テスト (#640)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-T2: show()直後はfocusedIndexが0（新規開始）だが黄色いフォーカスリングはまだ描画されない（マウス/タップ操作だけのユーザーには見せない）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: true }))

    expect(focusInternals(overlay).focusedIndex).toBe(0)
    const entry0 = focusInternals(overlay).buttonEntries[0]
    expect(strokeSpy.mock.instances).not.toContain(entry0.focusRing)
  })

  it('TC-T3: Tabキーを押すと初めてkeyboardNavActiveがfalse→trueになり、移動先ボタンのfocusRingにstrokeが描画される', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: true }))
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    const entry1 = focusInternals(overlay).buttonEntries[1]

    overlay.handleKeyDown('Tab')

    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    expect(strokeSpy.mock.instances).toContain(entry1.focusRing)
  })

  it('TC-T4: ArrowDown/ArrowUpでもTabと同様にkeyboardNavActiveがtrueになり移動先にリングが描画される', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')

    const overlayDown = new TitleScreenOverlay(800, 450)
    overlayDown.show(makeOpts({ hasSaveData: true }))
    const entry1 = focusInternals(overlayDown).buttonEntries[1] // つづきから
    overlayDown.handleKeyDown('ArrowDown')
    expect(focusInternals(overlayDown).keyboardNavActive).toBe(true)
    expect(strokeSpy.mock.instances).toContain(entry1.focusRing)

    const overlayUp = new TitleScreenOverlay(800, 450)
    overlayUp.show(makeOpts({ hasSaveData: true }))
    const entry3 = focusInternals(overlayUp).buttonEntries[3] // 終了（先頭からArrowUpで末尾へ循環）
    overlayUp.handleKeyDown('ArrowUp')
    expect(focusInternals(overlayUp).keyboardNavActive).toBe(true)
    expect(strokeSpy.mock.instances).toContain(entry3.focusRing)
  })

  it('TC-T5: pointertapによるマウスクリック選択ではkeyboardNavActiveはfalseのまま、どのfocusRingにもstrokeが呼ばれない', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    const onNewGame = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, onNewGame }))
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    strokeSpy.mockClear()

    overlay.children[2].emit('pointertap', {} as never) // 新規開始ボタン

    expect(onNewGame).toHaveBeenCalledTimes(1)
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    const rings = focusInternals(overlay).buttonEntries.map((e) => e.focusRing)
    expect(rings.some((ring) => strokeSpy.mock.instances.includes(ring))).toBe(false)
  })

  it('TC-T6(最重要): Tab操作でkeyboardNavActive=trueにした後、hide()→show()を呼んでも保持され、新しいbuttonEntriesの初期フォーカス(index0)に即座にリングが描画される', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: true }))
    overlay.handleKeyDown('Tab')
    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    overlay.hide()

    strokeSpy.mockClear()
    overlay.show(makeOpts({ hasSaveData: true }))

    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    expect(focusInternals(overlay).focusedIndex).toBe(0)
    const entry0 = focusInternals(overlay).buttonEntries[0]
    expect(strokeSpy.mock.instances).toContain(entry0.focusRing)
  })

  it('TC-T7: Tabを2回連続で押しても2回目はactivateKeyboardFocusVisibleの早期returnで例外なく完了する（冪等性）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: true }))

    expect(() => overlay.handleKeyDown('Tab')).not.toThrow()
    const callCountAfterFirstTab = strokeSpy.mock.calls.length

    expect(() => overlay.handleKeyDown('Tab')).not.toThrow()

    // 2回目はkeyboardNavActiveが既にtrueのためactivateKeyboardFocusVisible側は早期returnし、
    // 移動先1件分のリング描画（stroke1回）だけが増える。
    expect(strokeSpy.mock.calls.length).toBe(callCountAfterFirstTab + 1)
  })

  it('TC-T8a: hasSaveData:false（enabled3個: 新規開始/設定/終了）でもTab操作によりリングが正しく描画される', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: false }))
    const entry2 = focusInternals(overlay).buttonEntries[2] // 設定（つづきからをスキップした次）

    overlay.handleKeyDown('Tab')

    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    expect(focusInternals(overlay).focusedIndex).toBe(2)
    expect(strokeSpy.mock.instances).toContain(entry2.focusRing)
  })

  it('TC-T8b: hasSaveData:true（enabled4個）でもTab操作によりリングが正しく描画される', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: true }))
    const entry1 = focusInternals(overlay).buttonEntries[1] // つづきから

    overlay.handleKeyDown('Tab')

    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    expect(focusInternals(overlay).focusedIndex).toBe(1)
    expect(strokeSpy.mock.instances).toContain(entry1.focusRing)
  })

  it("TC-T9: show()未呼び出し（buttonEntries空・focusedIndex=-1）状態でhandleKeyDown('Tab'/'ArrowDown'/'ArrowUp')を呼んでも例外・console.errorが出ない", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const overlay = new TitleScreenOverlay(800, 450)

    expect(() => {
      overlay.handleKeyDown('Tab')
      overlay.handleKeyDown('ArrowDown')
      overlay.handleKeyDown('ArrowUp')
    }).not.toThrow()

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('TC-T10: 未知のキー文字列や空文字を渡してもkeyboardNavActiveは変化しない（false→falseのまま）', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: true }))
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)

    expect(overlay.handleKeyDown('')).toBe(false)
    expect(overlay.handleKeyDown('PageDown')).toBe(false)
    expect(overlay.handleKeyDown('Escape')).toBe(false)

    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
  })

  it('TC-T11: keyboardNavActive=falseのままsetFocusedIndex()を直接呼んでも、リングは描画されないがfocusedIndexは正しく前進する（リング描画ガードとフォーカス移動そのものが独立していることの明示。将来このifブロックに他の副作用が足された際の検知用の安全網）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new TitleScreenOverlay(800, 450)
    overlay.show(makeOpts({ hasSaveData: true }))
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    const entry1 = focusInternals(overlay).buttonEntries[1]
    strokeSpy.mockClear()

    focusInternals(overlay).setFocusedIndex(1)

    expect(focusInternals(overlay).focusedIndex).toBe(1)
    expect(strokeSpy.mock.instances).not.toContain(entry1.focusRing)
  })
})

describe('TitleScreenOverlay ボタン幅クランプ', () => {
  it('TC24: 極端に大きい screenWidth でも buttonWidth が BUTTON_MAX_WIDTH でクランプされる', () => {
    const overlay = new TitleScreenOverlay(10000, 450)
    overlay.show(makeOpts())

    // container.pivot.set(buttonWidth / 2, BUTTON_HEIGHT / 2) から buttonWidth を逆算する。
    const newGameBtn = overlay.children[2]
    expect(newGameBtn.pivot.x).toBe(BUTTON_MAX_WIDTH / 2)
    expect(newGameBtn.pivot.y).toBe(BUTTON_HEIGHT / 2)
  })

  it('TC24: 極端に小さい screenWidth でも buttonWidth が BUTTON_MIN_WIDTH でクランプされる', () => {
    const overlay = new TitleScreenOverlay(10, 450)
    overlay.show(makeOpts())

    const newGameBtn = overlay.children[2]
    expect(newGameBtn.pivot.x).toBe(BUTTON_MIN_WIDTH / 2)
  })
})

// #643 テスト観点整理 C群: showExitButton（header: hidden プロジェクトで「終了」ボタン自体を
// buttonSpecs から除外する新オプション）。disabled 化ではなく非描画であることと、それに伴う
// キーボードフォーカス循環（Tab/Shift+Tab）の対象集合が正しく縮むことを縛る。
describe('TitleScreenOverlay.show() showExitButton (#643)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-C1: showExitButton:false で「終了」ボタンが子要素として一切存在しない（disabledではなく非描画）', () => {
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: true, showExitButton: false }))

    // children: [0]=bg, [1]=titleText, [2..4]=はじめから/つづきから/設定 の3ボタンのみ（計5件）。
    expect(overlay.children.length).toBe(5)
    expect(focusInternals(overlay).buttonEntries.length).toBe(3)
  })

  it('TC-C2: showExitButton:undefined（未指定）で従来どおり4ボタン（後方互換の既定値true）', () => {
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: true, showExitButton: undefined }))

    expect(overlay.children.length).toBe(6)
    expect(focusInternals(overlay).buttonEntries.length).toBe(4)
  })

  it('TC-C3: showExitButton:true を明示指定した場合も4ボタンになる', () => {
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts({ hasSaveData: true, showExitButton: true }))

    expect(overlay.children.length).toBe(6)
    expect(focusInternals(overlay).buttonEntries.length).toBe(4)
  })

  it('TC-C4: showExitButton:false かつ hasSaveData:false のとき、Tabで「はじめから」と「設定」の2つだけを循環する', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onNewGame = vi.fn()
    const onOpenSettings = vi.fn()
    overlay.show(makeOpts({ hasSaveData: false, showExitButton: false, onNewGame, onOpenSettings }))

    // 初期フォーカス=はじめから(0)。Tabで設定へ。
    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    // もう一度Tabで先頭（はじめから）へ循環する＝2つだけの循環。
    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onNewGame).toHaveBeenCalledTimes(1)
  })

  it('TC-C5: showExitButton:false かつ hasSaveData:true のとき、Tabで「はじめから→つづきから→設定」の3つを循環し「終了」に到達しない', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onNewGame = vi.fn()
    const onContinue = vi.fn()
    const onOpenSettings = vi.fn()
    const onBack = vi.fn()
    overlay.show(
      makeOpts({
        hasSaveData: true,
        showExitButton: false,
        onNewGame,
        onContinue,
        onOpenSettings,
        onBack,
      })
    )

    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onContinue).toHaveBeenCalledTimes(1)

    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    // 3回目のTabで先頭（はじめから）へ循環する＝終了は存在しないため経由しない。
    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Enter')
    expect(onNewGame).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('TC-C6: showExitButton:false の状態でShift+Tab（逆循環）が末尾（設定）→先頭（はじめから）で正しく折り返す（終了を挟まない）', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onOpenSettings = vi.fn()
    const onNewGame = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, showExitButton: false, onOpenSettings, onNewGame }))

    // 初期フォーカス=はじめから(0) から Shift+Tab で末尾（設定。終了が存在しないため設定が末尾）へ。
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Enter')
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    // さらに2回 Shift+Tab（つづきから→はじめから）で先頭に戻る。
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Tab', true)
    overlay.handleKeyDown('Enter')
    expect(onNewGame).toHaveBeenCalledTimes(1)
  })

  it('TC-C7: showExitButton:false の状態でEnterによる決定操作は、フォーカスが「設定」にあるとき onOpenSettings を呼ぶが onBack は一度も呼ばれない', () => {
    const overlay = new TitleScreenOverlay(800, 450)
    const onOpenSettings = vi.fn()
    const onBack = vi.fn()
    overlay.show(makeOpts({ hasSaveData: true, showExitButton: false, onOpenSettings, onBack }))

    overlay.handleKeyDown('Tab') // はじめから→つづきから
    overlay.handleKeyDown('Tab') // つづきから→設定
    overlay.handleKeyDown('Enter')

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
  })
})

// #643 テスト観点整理 E群: 「新規開始」→「はじめから」ラベル変更。既存テストは children の
// index 参照のみでラベル文字列自体を確認していなかったため、PixiJS Text 描画内容を直接確認する。
describe('TitleScreenOverlay.show() ボタンラベル文言 (#643)', () => {
  it('TC-E8: 1番目のボタン（はじめから）の PixiJS Text 描画内容が「はじめから」である', () => {
    const overlay = new TitleScreenOverlay(800, 450)

    overlay.show(makeOpts())

    const entry0Container = focusInternals(overlay).buttonEntries[0].container as unknown as {
      children: { text: string }[]
    }
    // container.children: [0]=背景Graphics, [1]=ラベルPixiText, [2]=focusRing。
    expect(entry0Container.children[1].text).toBe('はじめから')
  })
})
