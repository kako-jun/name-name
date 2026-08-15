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
