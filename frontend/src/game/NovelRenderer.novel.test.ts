/**
 * NovelRenderer の `dialog_style: novel`（全画面ノベル改頁）単体テスト (#283)。
 *
 * 駆動方式（既存 NovelRenderer.*.test.ts と同じ流儀）:
 *   `new NovelRenderer()` → `setDialogStyle(...)` / `setScenes(...)` の最小構成。
 *   init() を呼ばないため render() は `if (!this.initialized) return` で描画をスキップする。
 *   ただし advance() は getNovelPages()（= DialogBox.measureLineCount / novelMaxLinesPerPage を
 *   使う純計算アダプタ）を経由するため、改頁ロジック・ページ index 前進は init なしで観測できる。
 *   検証は getSnapshot()（eventIndex / textIndex）/ getDebugState() / 内部アクセサで行う。
 *
 * jsdom の前提（テスト設計の実機検証で確定）:
 *   - canvas.getContext('2d') が null → wordwrap が常に 1 行 → 各文 = 1 行。
 *     よって 1 文の複数行折り返し改頁は再現不能（純粋関数 novelLayout.test.ts に委譲済み）。
 *   - 16:9（800x450）の novel 既定で novelMaxLinesPerPage()=cap。各文 1 行なので
 *     「N 文 → ceil(N/cap) ページ」で改頁を観測できる。cap は本文フォントサイズ既定
 *     （#283 補遺で 40 に復元）と novel 余白に依存するため measureNovelCap() で実測する。
 *
 * 非適用（実機・描画委譲。CLAUDE.md ルール7）:
 *   - スクリム可視性・退避フェードの描画反映（init 必須・jsdom 観測不能）。
 *   - race（in-flight ロード）と render 依存の見た目（スクリム描画・フェード輝度）。
 *     → これらは書かない。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { Event, EventScene } from '../types'

// --- fixture helpers（既存テストと同形） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

/** 立ち絵情報つき Dialog（#286 の役割配置・話者交代テスト用）。 */
function dialog(character: string, ...lines: string[]): Event {
  return {
    Dialog: {
      character,
      expression: 'normal',
      position: '中央',
      text: lines,
      voice_path: null,
      font_family: null,
    },
  }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** CharacterLayer の #286 観測 API（renderer 内部にぶら下がる layer を経由して読む）。 */
interface CharacterLayerObservable {
  getSpritePosition(name: string): { x: number; y: number } | null
  getPoseNudgeState(name: string): { active: boolean; baseY: number } | null
}
function layerOf(r: NovelRenderer): CharacterLayerObservable {
  return (r as unknown as { characterLayer: CharacterLayerObservable }).characterLayer
}

interface RendererInternals {
  advance(): void
  eventIndex: number
  textIndex: number
  dialogBox: {
    isNovelMode: boolean
    novelMaxLinesPerPage(): number
    measureLineCount(s: string): number
  }
  novelPagesCache: { eventIndex: number; pages: unknown[] } | null
  getNovelPages(textEvt: { text: string[] }): Array<{ text: string; lineCount: number }>
  currentPageCount(textEvt: { text: string[] }): number
  isNovelStyle(): boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * 16:9 novel 既定の 1 ページ最大行数（cap）を実測する (#283 補遺)。
 * cap は novel 幾何（boxH）と本文フォントサイズ（runtime 既定 40）に依存し、過去の余白調整・
 * font_size 切り出しで値が動くため、テスト内でハードコードせず実測値から期待値を導出する。
 * jsdom では canvas 2d が null で wordwrap は各文 1 行になるため「1 文 = 1 行」が成立する。
 */
function measureNovelCap(): number {
  const probe = new NovelRenderer()
  probe.setDialogStyle('novel')
  return (
    probe as unknown as { dialogBox: { novelMaxLinesPerPage(): number } }
  ).dialogBox.novelMaxLinesPerPage()
}
const NOVEL_CAP = measureNovelCap()

/**
 * ちょうど 3 ページ（textIndex 0,1,2）に改頁される文数の narration テキストを作る。
 * 各文 = 1 行（jsdom）なので、ceil(N/cap) = 3 になる最小 N = 2*cap + 1 文を並べる。
 * cap に依存させることで、本文フォントサイズ既定が変わっても「3 ページ」を維持する。
 */
function sentencesForThreePages(): string {
  const n = NOVEL_CAP * 2 + 1
  return Array.from({ length: n }, (_, k) => `${k + 1}。`).join('')
}
/** 3 ページに改頁される 1 narration テキスト（cap 連動）。 */
const THREE_PAGE_TEXT = sentencesForThreePages()

describe('NovelRenderer dialog_style: novel (#283)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 22: 未指定（setDialogStyle を呼ばない）は adv 相当（novel ではない）。
  it('22: dialog_style 未指定は adv 相当（isNovelStyle=false・DialogBox も adv）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('s', [narration('行1', '行2')])])
    expect(internals(r).isNovelStyle()).toBe(false)
    expect(internals(r).dialogBox.isNovelMode).toBe(false)
  })

  // 23: 未知値（'toheart' 等）は adv にフォールバックする（novel 判定は 'novel' 厳密一致）。
  it('23: 未知値の dialog_style は adv フォールバック（novel ではない）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('toheart')
    r.setScenes([scene('s', [narration('行1')])])
    expect(internals(r).isNovelStyle()).toBe(false)
    expect(internals(r).dialogBox.isNovelMode).toBe(false)
  })

  // 24: novel 指定で DialogBox が novel モードになる。
  it('24: dialog_style: novel で DialogBox が novel モードになる', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration('行1')])])
    expect(internals(r).isNovelStyle()).toBe(true)
    expect(internals(r).dialogBox.isNovelMode).toBe(true)
  })

  // 25: novel 多文の改頁で textIndex（= ページ index）が 1 ずつ前進し、ページを使い切ると次イベントへ。
  //     2*cap+1 文 → ちょうど 3 ページ（textIndex 0,1,2）。3 回目の advance で次イベントへ（eventIndex+1）。
  it('25: novel 多文の改頁で textIndex がページ単位で前進し、使い切ると次イベントへ', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT), narration('次。')])])
    const i = internals(r)
    expect(i.dialogBox.novelMaxLinesPerPage()).toBe(NOVEL_CAP) // 前提を固定（実測 cap）

    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 1 }) // 2 ページ目
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 2 }) // 3 ページ目
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0 }) // 次イベントへ
  })

  // 25b: ページ総数が「文数 / cap の切り上げ」になる（純計算経路の確認）。
  it('25b: novel のページ総数は ceil(文数 / cap) になる（2*cap+1 文 → 3 ページ）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    const textEvt = { text: [THREE_PAGE_TEXT] }
    expect(internals(r).currentPageCount(textEvt)).toBe(3)
  })

  // 25c: setFontSize（per-game font_size #283 補遺）が DialogBox に伝播し、cap（1 ページ行数）が変わる。
  //      フォントを小さくすると 1 ページに収まる行数が増える（NovelPlayer→NovelRenderer→DialogBox 配線の確認）。
  it('25c: setFontSize が DialogBox に伝播し novelMaxLinesPerPage（cap）が変わる', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration('行1')])])
    const i = internals(r)
    const capDefault = i.dialogBox.novelMaxLinesPerPage()
    expect(capDefault).toBe(NOVEL_CAP) // 既定 40 の cap

    r.setFontSize(20) // 半分にすると行高も半分 → cap は増える
    const capSmall = i.dialogBox.novelMaxLinesPerPage()
    expect(capSmall).toBeGreaterThan(capDefault)

    // null（未指定）を渡すと runtime 既定 40 に戻り cap も元に戻る
    r.setFontSize(null)
    expect(i.dialogBox.novelMaxLinesPerPage()).toBe(NOVEL_CAP)
  })

  // 26: adv の多行はページ化されず、text 行数で前進する（novel の改頁が adv に漏れない退行ガード）。
  it('26: adv の多行はページ化されず text 行単位で前進する（改頁が adv に漏れない）', () => {
    const r = new NovelRenderer()
    // dialog_style 未指定 = adv
    r.setScenes([scene('s', [narration('行1', '行2', '行3'), narration('次。')])])
    const i = internals(r)
    // adv の総ページ数 = text 行数（改頁しない）
    expect(i.currentPageCount({ text: ['行1', '行2', '行3'] })).toBe(3)

    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 1 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 2 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0 })
  })

  // 27: 空 text（立ち絵だけの空ダイアログ相当）は 1 つの空ページになる（ページ 0 ではない）。
  it('27: 空 text は 1 つの空ページになる（pageCount=1・空文字）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    const pages = internals(r).getNovelPages({ text: [''] })
    expect(pages).toHaveLength(1)
    expect(pages[0].text).toBe('')
    expect(internals(r).currentPageCount({ text: [''] })).toBe(1)
  })

  // 28: 改頁キャッシュは eventIndex 単位。スタイル切替（novel→adv）で派生キャッシュが破棄される。
  it('28: スタイル切替（novel→adv）で改頁キャッシュが破棄される', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    const i = internals(r)
    // getNovelPages を一度呼んでキャッシュを温める
    i.getNovelPages({ text: [THREE_PAGE_TEXT] })
    expect(i.novelPagesCache).not.toBeNull()

    // adv へ切替 → 派生キャッシュ破棄
    r.setDialogStyle('adv')
    expect(i.novelPagesCache).toBeNull()
  })

  // 28b: 改頁キャッシュは同一 eventIndex の再呼び出しで同一参照を返す（同イベント内で再計算しない）。
  it('28b: 同一 eventIndex の getNovelPages は同一参照（キャッシュヒット）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    const i = internals(r)
    const textEvt = { text: [THREE_PAGE_TEXT] }
    const first = i.getNovelPages(textEvt)
    const second = i.getNovelPages(textEvt)
    expect(second).toBe(first) // 同一参照 = 再計算していない
  })

  // 29: novel の改頁進行が console を汚染しない（warn/error を出さない）。
  it('29: novel の改頁進行で console.warn / console.error を出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    const i = internals(r)
    i.advance()
    i.advance()
    i.advance()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  // 30: novel→adv→novel の往復切替後も novel の改頁が正しく効く（冪等・状態が壊れない）。
  it('30: novel→adv→novel 往復切替後も改頁が効く（DialogBox novel モード復元）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    const i = internals(r)

    r.setDialogStyle('adv')
    expect(i.dialogBox.isNovelMode).toBe(false)

    r.setDialogStyle('novel')
    expect(i.dialogBox.isNovelMode).toBe(true)
    // novel に戻ったら改頁（2*cap+1 文 → 3 ページ）が効く
    expect(i.currentPageCount({ text: [THREE_PAGE_TEXT] })).toBe(3)
  })
})

// ===== save-load / goBack / seekTo を跨いだページ index（textIndex）保持 (#283 設計31) =====
describe('NovelRenderer novel ページ index の永続化跨ぎ保持 (#283)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })
  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
  })

  function craftSave(over: Partial<SaveSlotData>): SaveSlotData {
    return {
      slot: -1,
      sceneId: 's',
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

  // 31a: save→load でページ index（textIndex）が復元される。
  //      novel ではページ index、quickSave/quickLoad が textIndex をそのまま保存・復元する。
  it('31a: novel で save→load してもページ index（textIndex）が保持される', () => {
    // ページ 2（index=1）でセーブされた状態を直接 seed する。
    new SaveManager().quickSave(craftSave({ sceneId: 's', eventIndex: 0, textIndex: 1 }))
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    expect(r.quickLoad()).toBe(true)
    // ページ index がそのまま復元される
    expect(r.getSnapshot().textIndex).toBe(1)
  })

  // 31b: goBack でページ index が 1 つ戻る（同一イベント内の改頁の巻き戻し）。
  it('31b: novel で goBack するとページ index が 1 つ戻る', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    const i = internals(r)
    i.advance() // ページ index 1 へ
    expect(r.getSnapshot().textIndex).toBe(1)
    r.goBack()
    expect(r.getSnapshot().textIndex).toBe(0)
  })

  // 31c: seekTo で履歴位置（別イベント）へ跳んでもページ index が壊れない。
  //      多イベントを進めてから先頭履歴へ seekTo し、eventIndex/textIndex が履歴どおりに戻る。
  it('31c: novel で seekTo すると履歴位置の eventIndex/textIndex が復元される', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // 2 イベント: 1 つ目 2 文（cap2 → 1 ページ）、2 つ目 1 文
    r.setScenes([scene('s', [narration('甲。乙。'), narration('丙。')])])
    const i = internals(r)
    // 1 つ目（1 ページ）を送ると 2 つ目イベントへ
    i.advance()
    const afterFirst = r.getSnapshot()
    expect(afterFirst.eventIndex).toBe(1)
    // 履歴の先頭（index 0）へ seek すると 1 つ目イベント・ページ 0 に戻る
    r.seekTo(0)
    const back = r.getSnapshot()
    expect(back.eventIndex).toBe(0)
    expect(back.textIndex).toBe(0)
  })
})

// ===== #286: novel 役割配置（質問役=左 / 回答役=右）＋話者交代ポーズ変化 =====
//
// 16:9（width 800）。質問役 x=800*0.25=200、回答役 x=800*0.75=600。
// jsdom では ticker が回らないため、nudge は「セットされたか」を観測点にする（描画は実機委譲）。
describe('NovelRenderer novel 役割配置 (#286)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // protagonist 指定の novel: 主人公（質問役）= 左、住人（回答役）= 右。
  it('protagonist 指定の novel で主人公=左 (0.25)・住人=右 (0.75) に振る', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', '質問。'), dialog('ひな', '回答。')])])
    // 1 つ目の Dialog（せお = 質問役 = 左）
    expect(layerOf(r).getSpritePosition('せお')!.x).toBe(800 * 0.25)
    internals(r).advance()
    // 2 つ目の Dialog（ひな = 住人 = 回答役 = 右）
    expect(layerOf(r).getSpritePosition('ひな')!.x).toBe(800 * 0.75)
  })

  // protagonist 未指定の novel は従来配置（position トークン「中央」= screenWidth*0.5）。後方互換。
  it('protagonist 未指定の novel は従来配置のまま（中央 = 0.5）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [dialog('せお', 'やあ。')])])
    expect(layerOf(r).getSpritePosition('せお')!.x).toBe(800 * 0.5)
  })

  // adv では protagonist を設定しても左右配置は効かない（novel 限定）。adv 非回帰。
  it('adv では protagonist を設定しても役割配置しない（中央 = 0.5）', () => {
    const r = new NovelRenderer()
    // dialog_style 未指定 = adv
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', 'やあ。'), dialog('ひな', 'どうも。')])])
    expect(layerOf(r).getSpritePosition('せお')!.x).toBe(800 * 0.5)
    internals(r).advance()
    expect(layerOf(r).getSpritePosition('ひな')!.x).toBe(800 * 0.5)
  })

  // 司会など3人目（非主人公）は v1 では「非主人公=右」に倒す（TODO 定位置）。
  it('非主人公（司会など）は v1 では回答役=右 (0.75) に倒す', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('ヴィンチア', 'では始めます。')])])
    expect(layerOf(r).getSpritePosition('ヴィンチア')!.x).toBe(800 * 0.75)
  })
})

describe('NovelRenderer novel 話者交代ポーズ変化 (#286)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 話者が変わったら新話者の立ち絵に nudge がかかる。初回（場面冒頭）は交代でないので nudge しない。
  it('話者交代で新話者に nudgePose がかかる（初回はかからない）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', '質問。'), dialog('ひな', '回答。')])])
    // 初回（せお登場）は話者交代ではない → nudge なし
    expect(layerOf(r).getPoseNudgeState('せお')).toBeNull()
    internals(r).advance()
    // せお → ひな の交代 → ひな に nudge
    expect(layerOf(r).getPoseNudgeState('ひな')).not.toBeNull()
    expect(layerOf(r).getPoseNudgeState('ひな')!.active).toBe(true)
  })

  // 同じ話者が連続する間は nudge しない（改行で同一話者が続くだけならポーズ変化を乱発しない）。
  it('同一話者が連続する間は nudgePose しない', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', '一文目。'), dialog('せお', '二文目。')])])
    internals(r).advance() // せお → せお（交代なし）
    expect(layerOf(r).getPoseNudgeState('せお')).toBeNull()
  })

  // adv では話者交代があっても nudge しない（演出は novel 限定）。adv 非回帰。
  it('adv では話者交代があっても nudgePose しない', () => {
    const r = new NovelRenderer()
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', '質問。'), dialog('ひな', '回答。')])])
    internals(r).advance()
    expect(layerOf(r).getPoseNudgeState('ひな')).toBeNull()
  })

  // 話者交代進行で console を汚さない（防御の確認）。
  it('話者交代の進行で console.warn / console.error を出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', 'a。'), dialog('ひな', 'b。'), dialog('せお', 'c。')])])
    internals(r).advance()
    internals(r).advance()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
