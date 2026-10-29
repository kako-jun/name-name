/**
 * 舞台レイヤーの可視性規則 (#982) の統合テスト。
 *
 * タイトル画面表示中、titleScreenOverlay より手前に積まれた舞台レイヤー（大道具・照明・幕・立ち絵・イベント絵・
 * 舞台前面・天候・吹き出し・テロップ）は隠れ、床もタイトル中は隠す。hideTitleScreen() は強制 visible=true にせず、
 * イベント絵の背面隠しを含む「あるべき可視性」へ戻す。規則の本体は stageLayerVisibility.ts。
 *
 * init 済みの実 stage で検証する（addChild 順の走査で「レイヤーを足したが規則へ入れ忘れた」を検出するため）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Container, type Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import {
  STAGE_LAYER_RULES,
  computeStageLayerState,
  type StageLayerKey,
} from './stageLayerVisibility'
import { internals, type RendererInternals } from '../test/rendererInternals'

const TEX = { width: 64, height: 32, source: {} } as unknown as Texture

interface LocalInternals extends RendererInternals {
  app: {
    init: (...args: unknown[]) => Promise<void>
    stage: { children: Container[] }
    canvas: unknown
    destroy: (...args: unknown[]) => void
  }
  titleScreenOverlay: Container
  eventImageLayer: Container & { shouldHideBackLayer(): boolean }
  characterLayer: Container & {
    showImage: (opts: Record<string, unknown>) => void
  }
  background: { setVisible(v: boolean): void }
  stageLayerTargets(): Record<string, Container>
  applyEventImageVisibility(): void
  dialogBox: Container
  seekBar: Container
  counterText: Container | null
  choiceOverlay: Container
  saveLoadOverlay: Container
  backlogOverlay: Container
  endingOverlay: Container
  toastOverlay: Container
  weatherLayer: Container
}

async function initRenderer(r: NovelRenderer): Promise<LocalInternals> {
  const ri = internals<LocalInternals>(r)
  vi.spyOn(ri.app, 'init').mockResolvedValue()
  Object.defineProperty(ri.app, 'canvas', {
    configurable: true,
    value: document.createElement('canvas'),
  })
  Object.defineProperty(ri.app, 'renderer', { configurable: true, value: { resolution: 1 } })
  await r.init(document.createElement('div'))
  return ri
}

function cleanupRenderer(r: NovelRenderer): void {
  internals<LocalInternals>(r).app.destroy = () => {}
  r.destroy()
}

function titleOpts() {
  return {
    title: 'T',
    hasSaveData: false,
    onNewGame: vi.fn(),
    onContinue: vi.fn(),
    onOpenSettings: vi.fn(),
    onBack: vi.fn(),
  }
}

/** visible で隠すレイヤー（規則の title === 'visible'）。 */
const VISIBLE_HIDDEN_KEYS = (Object.keys(STAGE_LAYER_RULES) as StageLayerKey[]).filter(
  (k) => STAGE_LAYER_RULES[k].title === 'visible'
)
const BACK_STACK_KEYS = (Object.keys(STAGE_LAYER_RULES) as StageLayerKey[]).filter(
  (k) => STAGE_LAYER_RULES[k].backStack && k !== 'background'
)

/** 描画に効く状態（visible / renderable）を全レイヤー分取る。経路間の同値比較に使う。 */
function snapshot(ri: LocalInternals): Record<string, { visible: boolean; renderable: boolean }> {
  const out: Record<string, { visible: boolean; renderable: boolean }> = {}
  for (const [k, layer] of Object.entries(ri.stageLayerTargets())) {
    out[k] = { visible: layer.visible, renderable: layer.renderable }
    if (k === 'character') {
      out['character.children'] = {
        visible: true,
        renderable: layer.children.every((c) => c.renderable),
      }
    }
  }
  return out
}

describe('computeStageLayerState（規則の純粋関数）', () => {
  const key = (k: StageLayerKey, titleActive: boolean, hideBack: boolean) =>
    computeStageLayerState(k, { titleActive, hideBack })

  it('タイトル中は visible モードのレイヤーが隠れ、背面隠しの対象外でも隠れる', () => {
    for (const k of VISIBLE_HIDDEN_KEYS) {
      expect(key(k, true, false).visible).toBe(false)
      expect(key(k, true, true).visible).toBe(false)
    }
  })

  it('タイトルでない時は背面隠しの対象だけが hideBack で隠れる（強制 true にならない）', () => {
    for (const k of VISIBLE_HIDDEN_KEYS) {
      expect(key(k, false, true).visible).toBe(!STAGE_LAYER_RULES[k].backStack)
      expect(key(k, false, false).visible).toBe(true)
    }
  })

  it('titleScreenOverlay より奥の背景・壁・背景板・動画はタイトルで隠さない', () => {
    for (const k of ['background', 'wall', 'backgroundBoard', 'video'] as const) {
      expect(key(k, true, false)).toEqual({ visible: true, titleSuppressed: false })
    }
  })

  it('renderable / children モードは visible を背面隠しだけで決め、タイトルは titleSuppressed に出す', () => {
    expect(key('bubble', true, true)).toEqual({ visible: true, titleSuppressed: true })
    expect(key('telop', false, false)).toEqual({ visible: true, titleSuppressed: false })
    // タイトル中は背面隠しでも visible を保つ（ロゴを載せているため）
    expect(key('character', true, true)).toEqual({ visible: true, titleSuppressed: true })
    expect(key('character', false, true)).toEqual({ visible: false, titleSuppressed: false })
    expect(key('character', true, false)).toEqual({ visible: true, titleSuppressed: true })
  })
})

describe('NovelRenderer 舞台レイヤーの可視性 (#982)', () => {
  let r: NovelRenderer
  let ri: LocalInternals

  beforeEach(async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    r = new NovelRenderer()
    ri = await initRenderer(r)
  })

  afterEach(() => {
    cleanupRenderer(r)
    vi.restoreAllMocks()
  })

  function mockHideBack(value: boolean) {
    return vi.spyOn(ri.eventImageLayer, 'shouldHideBackLayer').mockReturnValue(value)
  }

  it('showTitleScreen で手前のレイヤーがすべて隠れ、hideTitleScreen で全部戻る', () => {
    const targets = ri.stageLayerTargets()
    r.showTitleScreen(titleOpts())
    for (const k of VISIBLE_HIDDEN_KEYS) expect(targets[k].visible, k).toBe(false)
    expect(targets.bubble.renderable).toBe(false)
    expect(targets.telop.renderable).toBe(false)
    // 奥側は触らない
    for (const k of ['wall', 'backgroundBoard', 'video']) expect(targets[k].visible, k).toBe(true)

    r.hideTitleScreen()
    // 吹き出し・テロップは自身の show()/hide() が visible を持つ（非表示が既定）ので renderable だけ見る
    for (const k of Object.keys(targets).filter((k) => k !== 'bubble' && k !== 'telop')) {
      expect(targets[k].visible, k).toBe(true)
    }
    expect(targets.bubble.renderable).toBe(true)
    expect(targets.telop.renderable).toBe(true)
  })

  it('立ち絵レイヤーはロゴだけ見え、他の立ち絵は renderable で隠れる（visible・状態は触らない）', () => {
    const layer = ri.characterLayer
    layer.showImage({ id: 'prop-image', path: 'a.png', x: 0.2, y: 0.5, assetBaseUrl: 'http://x' })
    r.showTitleScreen(titleOpts())
    const logo = layer.children.filter((c) => c.renderable)
    const hidden = layer.children.filter((c) => !c.renderable)
    expect(layer.visible).toBe(true)
    expect(logo).toHaveLength(1)
    expect(hidden.length).toBeGreaterThanOrEqual(1)

    r.hideTitleScreen()
    expect(layer.children.every((c) => c.renderable)).toBe(true)
  })

  it('タイトル中に後から出た立ち絵（シナリオ進行・復元・シーンジャンプ）も隠れ、hide で戻る', () => {
    r.showTitleScreen(titleOpts())
    ri.characterLayer.showImage({
      id: 'late',
      path: 'late.png',
      x: 0.8,
      y: 0.5,
      assetBaseUrl: 'http://x',
    })
    // ロゴ（免除）以外の子はすべて隠れている
    const visibleChildren = ri.characterLayer.children.filter((c) => c.renderable)
    expect(visibleChildren).toHaveLength(1)

    r.hideTitleScreen()
    expect(ri.characterLayer.children.every((c) => c.renderable)).toBe(true)
  })

  it('背面隠し中の hideTitleScreen は背面スタックを出さず、対象外のレイヤーは戻す', () => {
    mockHideBack(true)
    const targets = ri.stageLayerTargets()
    r.showTitleScreen(titleOpts())
    r.hideTitleScreen()
    for (const k of BACK_STACK_KEYS) expect(targets[k].visible, k).toBe(false)
    expect(targets.eventImage.visible).toBe(true)
    expect(targets.stageFront.visible).toBe(true)
    expect(targets.weather.visible).toBe(true)
    // 奥側の背景板・壁・動画も背面隠しに従う
    expect(targets.wall.visible).toBe(false)
    expect(targets.backgroundBoard.visible).toBe(false)
    expect(targets.video.visible).toBe(false)
  })

  it('タイトル中に背面隠しが変わっても、hide 時に最新の状態になる', () => {
    const spy = mockHideBack(false)
    const targets = ri.stageLayerTargets()
    r.showTitleScreen(titleOpts())
    spy.mockReturnValue(true)
    ri.applyEventImageVisibility()
    // タイトル中は背面隠しの再計算が走っても手前レイヤーは隠れたまま
    expect(targets.prop.visible).toBe(false)
    expect(targets.eventImage.visible).toBe(false)
    r.hideTitleScreen()
    expect(targets.prop.visible).toBe(false)
    expect(targets.eventImage.visible).toBe(true)

    // 逆: 背面隠しが解けた状態で hide
    r.showTitleScreen(titleOpts())
    spy.mockReturnValue(false)
    r.hideTitleScreen()
    expect(targets.prop.visible).toBe(true)
    expect(targets.wall.visible).toBe(true)
  })

  it('hide の三経路（続ける・タイトルなし mount・dark 変更）で同じ結果になる', async () => {
    mockHideBack(true)
    // 続ける: show → hide
    r.showTitleScreen(titleOpts())
    r.hideTitleScreen()
    const viaContinue = snapshot(ri)
    const r2 = new NovelRenderer()
    const r3 = new NovelRenderer()
    try {
      // タイトルなし mount: show せずに hide
      const ri2 = await initRenderer(r2)
      vi.spyOn(ri2.eventImageLayer, 'shouldHideBackLayer').mockReturnValue(true)
      r2.hideTitleScreen()
      // dark 変更: show → show（再実行）→ hide
      const ri3 = await initRenderer(r3)
      vi.spyOn(ri3.eventImageLayer, 'shouldHideBackLayer').mockReturnValue(true)
      r3.showTitleScreen({ ...titleOpts(), dark: false })
      r3.showTitleScreen({ ...titleOpts(), dark: true })
      r3.hideTitleScreen()
      expect(snapshot(ri2)).toEqual(viaContinue)
      expect(snapshot(ri3)).toEqual(viaContinue)
    } finally {
      cleanupRenderer(r2)
      cleanupRenderer(r3)
    }
  })

  it('背面=hide のイベント絵が冒頭にあっても、タイトル中は立ち絵レイヤーが visible のままロゴだけ描画される (#982 M1)', () => {
    mockHideBack(true)
    r.showTitleScreen(titleOpts())
    const layer = ri.characterLayer
    expect(layer.visible).toBe(true)
    expect(layer.children.filter((c) => c.renderable)).toHaveLength(1)
    // 手前の他レイヤーは隠れたまま、奥の背面スタックは背面隠しのまま
    expect(ri.stageLayerTargets().prop.visible).toBe(false)
    r.hideTitleScreen()
    // 閉じたら背面隠しに従う（立ち絵レイヤーは隠れる）
    expect(layer.visible).toBe(false)
  })

  it('ロゴを remove せずに show → hide → 再 show しても、ロゴは描画される (#982 S2)', () => {
    r.showTitleScreen(titleOpts())
    r.hideTitleScreen()
    r.showTitleScreen(titleOpts())
    expect(ri.characterLayer.children.filter((c) => c.renderable)).toHaveLength(1)
    // ロゴが残っている状態（抑止中に追加 → childAdded で一度非描画 → 再計算で復帰）でも同じ
    r.showTitleScreen(titleOpts())
    expect(ri.characterLayer.children.filter((c) => c.renderable)).toHaveLength(1)
  })

  it('setTitleSuppressed は立ち絵の alpha・visible を変えない (#982 N2)', () => {
    ri.characterLayer.showImage({
      id: 'img',
      path: 'a.png',
      x: 0.2,
      y: 0.5,
      assetBaseUrl: 'http://x',
      instant: true,
    })
    const before = ri.characterLayer.children.map((c) => [c.alpha, c.visible])
    r.showTitleScreen(titleOpts())
    const kids = ri.characterLayer.children
    // ロゴは showImage 由来で alpha が別（フェードイン中）なので、既存の子だけ比較する
    expect(kids.slice(0, before.length).map((c) => [c.alpha, c.visible])).toEqual(before)
    r.hideTitleScreen()
    expect(ri.characterLayer.children.map((c) => [c.alpha, c.visible])).toEqual(before)
  })

  it('二重 show / 二重 hide でも状態が壊れない', () => {
    const targets = ri.stageLayerTargets()
    r.showTitleScreen(titleOpts())
    r.showTitleScreen(titleOpts())
    expect(targets.prop.visible).toBe(false)
    r.hideTitleScreen()
    r.hideTitleScreen()
    for (const [k, v] of Object.entries(snapshot(ri))) {
      expect(v.renderable, k).toBe(true)
      if (k !== 'bubble' && k !== 'telop') expect(v.visible, k).toBe(true)
    }
    // 再度 show → hide もできる
    r.showTitleScreen(titleOpts())
    expect(targets.prop.visible).toBe(false)
    r.hideTitleScreen()
    expect(targets.prop.visible).toBe(true)
  })

  function assertStageCovered(): void {
    const stage = ri.app.stage.children
    const overlayIndex = stage.indexOf(ri.titleScreenOverlay)
    expect(overlayIndex).toBeGreaterThanOrEqual(0)
    const above = stage.slice(overlayIndex + 1)

    const ruled = new Set<Container>(Object.values(ri.stageLayerTargets()))
    // 意図的な除外（隠さない理由）:
    //  - dialogBox / seekBar: showTitleScreen が個別に隠す（dialogBox.visible / seekBar.setTitleScreenHidden）
    //  - スクリム・暗転・画面効果（attachEffects の3枚、weatherLayer と dialogBox の間）: 画面全体の演出で、
    //    タイトルの操作を妨げない前提。タイトル中の暗転は別 Issue の論点
    //  - カウンタ・選択肢・セーブ/ロード・バックログ・終劇・トースト: タイトル中は表示されない UI オーバーレイで
    //    シナリオ進行の副産物ではない（それぞれ自前の visible 管理）
    const excluded = new Set<Container>(
      [
        ri.dialogBox,
        ri.seekBar,
        ri.counterText,
        ri.choiceOverlay,
        ri.saveLoadOverlay,
        ri.backlogOverlay,
        ri.endingOverlay,
        ri.toastOverlay,
      ].filter((c): c is Container => c != null)
    )
    const effectsFrom = stage.indexOf(ri.weatherLayer) + 1
    const effectsTo = stage.indexOf(ri.dialogBox)
    const effects = stage.slice(effectsFrom, effectsTo)
    // スクリム・暗転・画面効果の3枚ちょうど。ここに別レイヤーが紛れ込んだら除外ではなく規則へ入れるべき
    expect(effects).toHaveLength(3)
    for (const c of effects) excluded.add(c)

    const unaccounted = above.filter((c) => !ruled.has(c) && !excluded.has(c))
    expect(unaccounted.map((c) => c.label ?? c.constructor.name)).toEqual([])
    // 規則の対象はすべて stage 上に実在する（死んだ項目の検出）。背景は BackgroundController 管理なので除く
    for (const [k, c] of Object.entries(ri.stageLayerTargets())) {
      expect(stage.includes(c), k).toBe(true)
    }
    // 規則表とターゲット表のキーが一致する
    expect(Object.keys(ri.stageLayerTargets()).sort()).toEqual(
      Object.keys(STAGE_LAYER_RULES)
        .filter((k) => k !== 'background')
        .sort()
    )
  }

  it('stage 上で titleScreenOverlay より手前の Container は、規則の対象か意図的な除外のどちらかに入っている', () => {
    assertStageCovered()
  })

  it('カーテンコール配置（setCurtainZOrder(true)）後の順序でも漏れがない (#982 N3)', () => {
    ;(r as unknown as { setCurtainZOrder(v: boolean): void }).setCurtainZOrder(true)
    assertStageCovered()
  })
})
