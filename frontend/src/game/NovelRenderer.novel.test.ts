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
import { NovelRenderer, getTextEvent } from './NovelRenderer'
import { NOVEL_ROLE_X_RATIO } from './CharacterLayer'
import { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO } from './constants'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { Event, EventScene } from '../types'

/**
 * 役割配置の期待 x を定数から導出する (#286 follow-up S1)。
 * ハードコード（800*0.25 等）を避け、CharacterLayer の NOVEL_ROLE_X_RATIO と
 * 既定アスペクト比（16:9 → width 800）の積で算出する。比率・幅が変わっても追従する。
 */
const SCREEN_WIDTH = ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].width
const QUESTIONER_X = SCREEN_WIDTH * NOVEL_ROLE_X_RATIO.questioner // 主人公=左
const RESPONDER_X = SCREEN_WIDTH * NOVEL_ROLE_X_RATIO.responder // 住人=右

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
    clearText(): void
  }
  novelPagesCache: { eventIndex: number; pages: unknown[] } | null
  getNovelPages(textEvt: { text: string[] }): Array<{ text: string; lineCount: number }>
  currentPageCount(textEvt: { text: string[] }): number
  isNovelStyle(): boolean
  /** 本文色の決定論的導出 (#305)。話者 → 色 number（主人公=暖アイボリー / 住人=白）。 */
  resolveBodyTextColor(speaker: string | null): number
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

  // 25: novel 文単位送り (#292)。1 ページ内は sentenceIndex が 1 文ずつ前進し、ページ最後の文の
  //     advance で次ページ（textIndex+1, sentenceIndex=0）へ、最後のページの最後の文で次イベントへ。
  //     cap=NOVEL_CAP・各文 1 行（jsdom）なので 1 ページに cap 文。ここでは cap+1 文 = 2 ページ
  //     （[cap, 1]）で「文送り → 改頁 → 次イベント」の 3 種の遷移を 1 本で観測する。
  it('25: novel は文単位で前進し、ページ最後の文で改頁・最後のページの最後で次イベントへ', () => {
    const cap = NOVEL_CAP
    // cap+1 文 → ページ [cap, 1]。各文 = `k。`。
    const pageOverflow = Array.from({ length: cap + 1 }, (_, k) => `${k + 1}。`).join('')
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(pageOverflow), narration('次。')])])
    const i = internals(r)
    expect(i.dialogBox.novelMaxLinesPerPage()).toBe(cap) // 前提を固定（実測 cap）
    expect(i.currentPageCount({ text: [pageOverflow] })).toBe(2) // ページ [cap, 1]

    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    // ページ 0（cap 文）の中を 1 文ずつ送る（cap-1 回で最後の文 index = cap-1 に到達）。
    for (let s = 1; s <= cap - 1; s++) {
      i.advance()
      expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: s })
    }
    // ページ 0 最後の文 → advance で次ページ（textIndex 1・sentenceIndex 0）へ。
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 1, sentenceIndex: 0 })
    // 最後のページ（1 文）の最後の文 → advance で次イベントへ。
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0, sentenceIndex: 0 })
  })

  // 25d: 句点直後の余韻横棒 `。──`（先頭ダッシュ #374）は `。` で息継ぎし、`──それと、` を
  //      次のクリックで一気に表示する。イベント text（parser で `--`→`──` 正準化済み）→
  //      getNovelPages → splitIntoSentences の実行時経路で sentences 配列を観測する。
  it('25d: `です。──それと、` は `です。` / `──それと、` の2文になり、間に1クリック入る（#374）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // narration の text は parser 正準化後の姿（`--` → `──`）を直接与える。
    r.setScenes([scene('s', [narration('です。──それと、'), narration('次。')])])
    const i = internals(r)
    const pages = i.getNovelPages({ text: ['です。──それと、'] }) as unknown as Array<{
      sentences: string[]
    }>
    // 1 ページに収まり（jsdom で各文 1 行・cap 内）、句点で切れて `──` が次の文の先頭に回る。
    expect(pages).toHaveLength(1)
    expect(pages[0].sentences).toEqual(['です。', '──それと、'])

    // クリック（advance）で `です。`（文0）→ `──それと、`（文1）→ 次イベントへ、と 1 文ずつ進む。
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 1 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0, sentenceIndex: 0 })
  })

  // 25e: 閉じ括弧直後の `」──`（先頭ダッシュ #374 閉じ括弧拡張。script.md のお題選択行相当）は
  //      `「お題」` で息継ぎし、`──本文` を次のクリックで一気に表示する。実行時経路（getNovelPages →
  //      splitIntoSentences）で sentences 配列とクリック送りを観測する。
  it('25e: `「お題」──本文` は `「お題」` / `──本文` の2文になり、間に1クリック入る（#374 閉じ括弧）', () => {
    const line = '「人がうらやましい」──この胸を、誰に聞こう。'
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(line), narration('次。')])])
    const i = internals(r)
    const pages = i.getNovelPages({ text: [line] }) as unknown as Array<{ sentences: string[] }>
    expect(pages).toHaveLength(1)
    expect(pages[0].sentences).toEqual(['「人がうらやましい」', '──この胸を、誰に聞こう。'])

    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 1 })
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0, sentenceIndex: 0 })
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

  // 31b: goBack で文 index が 1 つ戻る（同一ページ内の文送りの巻き戻し・#292）。
  //      THREE_PAGE_TEXT のページ 0 は cap 文。1 文進めて 1 文戻すと sentenceIndex 0 に戻る。
  it('31b: novel で goBack すると文 index が 1 つ戻る（同一ページ内）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(THREE_PAGE_TEXT)])])
    const i = internals(r)
    i.advance() // 文 index 1 へ（同一ページ・同一イベント）
    expect(r.getSnapshot()).toMatchObject({ textIndex: 0, sentenceIndex: 1 })
    r.goBack()
    expect(r.getSnapshot()).toMatchObject({ textIndex: 0, sentenceIndex: 0 })
  })

  // 31b2: ページ先頭の文で更に goBack すると前ページへ戻り、前ページは全文（最後の文）表示に復元する。
  //       cap+1 文 → ページ [cap, 1]。cap 回 advance でページ 1（sentenceIndex 0）へ。
  //       そこで goBack するとページ 0 へ戻り sentenceIndex = cap-1（全文見えている状態）。
  it('31b2: novel でページ先頭から goBack すると前ページの最後の文へ復元する', () => {
    const cap = NOVEL_CAP
    const pageOverflow = Array.from({ length: cap + 1 }, (_, k) => `${k + 1}。`).join('')
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(pageOverflow)])])
    const i = internals(r)
    // ページ 0 の cap 文を送り切ると（cap 回 advance）ページ 1 の先頭文へ。
    for (let k = 0; k < cap; k++) i.advance()
    expect(r.getSnapshot()).toMatchObject({ textIndex: 1, sentenceIndex: 0 })
    // ページ先頭で goBack → 前ページ（ページ 0）の最後の文（index cap-1）へ。
    r.goBack()
    expect(r.getSnapshot()).toMatchObject({ textIndex: 0, sentenceIndex: cap - 1 })
  })

  // 31c: seekTo で履歴位置（別イベント）へ跳んでもページ/文 index が壊れない。
  //      多イベントを進めてから先頭履歴へ seekTo し、eventIndex/textIndex/sentenceIndex が履歴どおりに戻る。
  it('31c: novel で seekTo すると履歴位置の eventIndex/textIndex/sentenceIndex が復元される', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // 2 イベント: 1 つ目 2 文（cap=6 → 1 ページ・2 文）、2 つ目 1 文。
    // 文単位送り (#292) では 1 つ目イベントを次イベントへ抜けるのに 2 advance（文 0→1→次イベント）必要。
    r.setScenes([scene('s', [narration('甲。乙。'), narration('丙。')])])
    const i = internals(r)
    i.advance() // 文 0 → 1（同一イベント・同一ページ）
    i.advance() // ページ最後の文 → 次イベントへ
    const afterFirst = r.getSnapshot()
    expect(afterFirst.eventIndex).toBe(1)
    // 履歴の先頭（index 0）へ seek すると 1 つ目イベント・ページ 0・文 0 に戻る（イベント入口スナップショット）。
    r.seekTo(0)
    const back = r.getSnapshot()
    expect(back.eventIndex).toBe(0)
    expect(back.textIndex).toBe(0)
    expect(back.sentenceIndex).toBe(0)
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

// ===== #286 follow-up: 復元経路（goBack / quickLoad=applyState）の役割 x 再適用と誤 nudge 防止 (S1/S2) =====
//
// #286 の本実装は applyState（goBack / seekTo / quickLoad の共通復元）で
// resolveNovelRoleXRatio を再適用し、復元直後の lastSpeaker を据え置く。この分岐は
// 既存の #286 テスト（前進パスだけ）では踏まれていなかったため、復元経路を明示的に検証する。
//
// 観測点（jsdom は ticker が回らない）:
//   - getSpritePosition(name).x … 復元後の役割 x（質問役=QUESTIONER_X / 住人=RESPONDER_X）。
//   - getPoseNudgeState(name)    … 復元自体では nudge しない / 復元直後の同一話者 advance でも nudge しない。
describe('NovelRenderer novel 復元経路の役割配置と誤 nudge 防止 (#286 follow-up S1)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })
  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
  })

  // S1-goBack: goBack（applyState 単独経路）後に、戻り先キャラの x が役割 x（住人=右）へ再適用され、
  //   かつ復元直後に同一話者で advance しても nudge しない（lastSpeaker 据え置きの確認）。
  it('S1: goBack で役割 x（住人=右）が再適用され、復元直後の同一話者 advance で誤 nudge しない', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    // event0 せお（質問役=左）/ event1 ひな（住人=右）/ event2 ひな（同一話者）
    r.setScenes([
      scene('s', [dialog('せお', 'q。'), dialog('ひな', 'a1。'), dialog('ひな', 'a2。')]),
    ])
    const i = internals(r)
    i.advance() // event1 ひな（せお→ひな の交代 = nudge）
    i.advance() // event2 ひな（ひな→ひな 同一話者）
    expect(r.getSnapshot().eventIndex).toBe(2)

    // event1（ひな）へ goBack。applyState が走り、ひなの x が役割 x（住人=右）へ再適用される。
    r.goBack()
    expect(r.getSnapshot().eventIndex).toBe(1)
    expect(layerOf(r).getSpritePosition('ひな')!.x).toBe(RESPONDER_X)
    // 復元自体では nudge しない（演出は GameState に持たない）。
    expect(layerOf(r).getPoseNudgeState('ひな')).toBeNull()

    // 復元直後に同一話者（ひな→ひな）で前進しても誤 nudge しない（lastSpeaker が ひな に据えられている）。
    i.advance()
    expect(r.getSnapshot().eventIndex).toBe(2)
    expect(layerOf(r).getPoseNudgeState('ひな')).toBeNull()
    // x は役割 x のまま（右）。
    expect(layerOf(r).getSpritePosition('ひな')!.x).toBe(RESPONDER_X)
  })

  // S1-goBack-crossspeaker: goBack の復元先と「異なる話者」へ前進したとき、復元時に lastSpeaker を
  //   復元先話者へ据え直しているか（applyState の `this.lastSpeaker = restoredEvt.character`）を弁別する。
  //
  //   なぜ別ケースが要るか（PR #289 独立レビューの should）:
  //     上の S1-goBack は「ひな→ひな（同一話者）」で復元・前進するため、復元時に lastSpeaker を
  //     どう据えても（復元先=ひな／null／戻す前の値=ひな のいずれでも）前進時 speakerChanged=false で
  //     nudge しない。よって `this.lastSpeaker = restoredEvt.character` を「null 固定」や「代入削除」に
  //     壊しても緑のまま通り、再シードの回帰を検出できない。
  //
  //   本ケースの設計（復元先話者 ≠ 前進先話者 を作る）:
  //     event0 せお / event1 ひな / event2 せお。event2（せお）まで進めると lastSpeaker=せお。
  //     event1（ひな）へ goBack で復元 → 正しい再シードなら lastSpeaker=ひな に据え直る。
  //     復元直後に event2（せお）へ前進すると「ひな→せお」の話者交代 → nudge が発火する（true positive）。
  //       - 正しい実装: lastSpeaker=ひな → speakerChanged=true → せお に nudge（緑）。
  //       - 「null 固定」に壊すと: lastSpeaker=null → speakerChanged=false → nudge せず（赤）。
  //       - 「代入削除」に壊すと: lastSpeaker は復元前の せお のまま → speakerChanged=false → nudge せず（赤）。
  //     どちらの破壊でも「交代なのに nudge しない」で赤化するため、再シードの回帰を検出できる。
  it('S1: goBack 復元先と異なる話者へ前進すると交代 nudge が発火する（lastSpeaker 再シードの回帰検出）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    // event0 せお（質問役=左）/ event1 ひな（住人=右）/ event2 せお（質問役=左・話者交代）
    r.setScenes([
      scene('s', [dialog('せお', 'q1。'), dialog('ひな', 'a。'), dialog('せお', 'q2。')]),
    ])
    const i = internals(r)
    i.advance() // event1 ひな（せお→ひな の交代）
    i.advance() // event2 せお（ひな→せお の交代）。この時点で lastSpeaker=せお
    expect(r.getSnapshot().eventIndex).toBe(2)

    // event1（ひな）へ goBack。applyState が走り、lastSpeaker が復元先話者 ひな に据え直る。
    r.goBack()
    expect(r.getSnapshot().eventIndex).toBe(1)
    // 復元先キャラ ひな の x は役割 x（住人=右）へ再適用される。
    expect(layerOf(r).getSpritePosition('ひな')!.x).toBe(RESPONDER_X)
    // 復元自体では nudge しない。
    expect(layerOf(r).getPoseNudgeState('ひな')).toBeNull()

    // 復元先（ひな）と異なる話者（せお）へ前進 → 話者交代として nudge が発火する。
    // この assertion が再シードの本丸を踏む: 復元時に lastSpeaker=ひな へ据え直していないと、
    // lastSpeaker が null（null 固定）または せお（代入削除）になり speakerChanged=false で nudge せず赤くなる。
    i.advance()
    expect(r.getSnapshot().eventIndex).toBe(2)
    expect(layerOf(r).getPoseNudgeState('せお')).not.toBeNull()
    expect(layerOf(r).getPoseNudgeState('せお')!.active).toBe(true)
    // 前進先 せお の x は役割 x（質問役=左）。
    expect(layerOf(r).getSpritePosition('せお')!.x).toBe(QUESTIONER_X)
  })

  // S1-quickLoad: quickLoad（loadFromSaveData → restoreToScene → applyState）で seed したキャラが
  //   役割 x（主人公=左）へ再適用される。復元自体では nudge しない。
  it('S1: quickLoad（applyState）で役割 x（主人公=左）が再適用され、復元では nudge しない', () => {
    // event0 = せお（質問役）。せおを表示中の状態を seed（position は正本トークン「中央」）。
    new SaveManager().quickSave({
      slot: -1,
      sceneId: 's',
      eventIndex: 0,
      textIndex: 0,
      flags: {},
      backgroundPath: null,
      isBlackout: false,
      characters: [{ name: 'せお', expression: 'normal', position: '中央' }],
      currentBgmPath: null,
      savedAt: new Date().toISOString(),
      sceneName: null,
    })
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setScenes([scene('s', [dialog('せお', 'q。'), dialog('ひな', 'a。')])])
    expect(r.quickLoad()).toBe(true)

    // 正本トークンは「中央」だが、novel + protagonist 一致なので役割 x（質問役=左）へ再適用される。
    expect(layerOf(r).getSpritePosition('せお')!.x).toBe(QUESTIONER_X)
    // 復元自体では nudge しない。
    expect(layerOf(r).getPoseNudgeState('せお')).toBeNull()
  })
})

describe('NovelRenderer novel skipMode の nudge 抑制 (#286 follow-up S2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // S2: skipMode 中は話者交代しても nudge を発火しない（既読高速進行で乱発しない）。
  //   役割 x の再適用は skip でも効く（x は GameState 由来の表示状態）が、nudge（演出）だけ抑制される。
  it('S2: skipMode 中は話者交代しても nudgePose しない（役割 x は効く）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setSkipMode(true)
    r.setScenes([scene('s', [dialog('せお', 'q。'), dialog('ひな', 'a。')])])
    // せお（質問役=左）が表示され、skip でも役割 x は当たる。
    expect(layerOf(r).getSpritePosition('せお')!.x).toBe(QUESTIONER_X)
    internals(r).advance()
    // せお→ひな の話者交代だが skipMode 中なので nudge は発火しない。
    expect(layerOf(r).getPoseNudgeState('ひな')).toBeNull()
    // 役割 x（住人=右）は skip でも当たる。
    expect(layerOf(r).getSpritePosition('ひな')!.x).toBe(RESPONDER_X)
  })
})

// ===== 手動改頁 `---` = Event::PageBreak (#292 Phase 2) =====
//
// 本文中の単独行 `---` は parser が Event::PageBreak（serde では文字列 "PageBreak"）にする。
// runtime はこれを非テキストイベントとして読み飛ばす（getTextEvent=null・processDirective=no-op）。
// 各 text イベントは独立にページ分割されるため、`---` で割られたイベントの切れ目がそのまま
// 強制ページ境界になる（自動改頁 #283/#292 の上に乗る人手の早出し改頁）。
//
// 観測点（jsdom・init なし。既存 novel テストと同じ流儀）:
//   - getTextEvent('PageBreak') が null（非テキスト＝読み飛ばし対象）。
//   - advance() で PageBreak を跨ぐとき eventIndex がマーカー分も進み、次の Dialog が新ページ
//     （textIndex=0・sentenceIndex=0）から始まる＝強制ページ境界。
//   - `---` を含まない（PageBreak なし）脚本は従来の文単位送りと完全に同じ（非回帰）。
describe('NovelRenderer 手動改頁 PageBreak (#292 Phase 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // P1: PageBreak は非テキストイベント（getTextEvent=null）。adv/novel いずれでも読み飛ばし対象。
  it('P1: getTextEvent(PageBreak) は null（非テキスト＝読み飛ばし対象）', () => {
    expect(getTextEvent('PageBreak')).toBeNull()
  })

  // P2: novel で `セリフ → PageBreak → 同一話者セリフ` を進めると、PageBreak を跨いで
  //     次の Dialog が新ページ（textIndex=0・sentenceIndex=0）から始まる＝強制ページ境界。
  //     1 つ目 Dialog は 1 文（cap 内・1 ページ）。その最後の文の advance で PageBreak を読み飛ばし、
  //     2 つ目 Dialog（event index 2）へ。
  it('P2: novel で PageBreak を跨ぐと次の Dialog が新ページ先頭から始まる（強制改頁）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // parser が `カコ「最初の文。」/ --- / 続きの文。` を割った形を手で組む。
    r.setScenes([
      scene('s', [dialog('カコ', '最初の文。'), 'PageBreak', dialog('カコ', '続きの文。')]),
    ])
    const i = internals(r)
    expect(i.isNovelStyle()).toBe(true)
    // 1 つ目 Dialog は 1 ページ・1 文。
    expect(i.currentPageCount({ text: ['最初の文。'] })).toBe(1)

    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    // 1 つ目 Dialog の最後（唯一）の文 → advance で PageBreak(event1) を読み飛ばし、
    // 2 つ目 Dialog(event2) の新ページ先頭へ。
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 2, textIndex: 0, sentenceIndex: 0 })
  })

  // P3: PageBreak は表示イベント数（カウンタ/シークの母数）に入らない。
  //     dialog + PageBreak + dialog の表示イベント数は 2（PageBreak は除外）。
  it('P3: PageBreak は displayEventCount に数えられない（テキストイベントのみ）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [dialog('カコ', 'A。'), 'PageBreak', dialog('カコ', 'B。')])])
    const count = (r as unknown as { displayEventCount: number }).displayEventCount
    expect(count).toBe(2)
  })

  // P4: PageBreak の読み飛ばし進行で console を汚さない（no-op の確認）。
  it('P4: PageBreak を跨ぐ進行で console.warn / console.error を出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [dialog('カコ', 'A。'), 'PageBreak', dialog('カコ', 'B。')])])
    internals(r).advance()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  // P5: 非回帰。PageBreak を含まない（`---` 無し）同等脚本は、従来の文単位送りと完全に同じ。
  //     1 つの Dialog に 2 文をまとめた場合（cap 内・1 ページ 2 文）は、PageBreak で割った P2 と違い
  //     同一ページ内を文送り（sentenceIndex 0→1）してから次イベントへ進む。
  it('P5: PageBreak 無し（同一 Dialog に 2 文）は同一ページ内を文送りする（強制改頁が漏れない）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // cap 内（NOVEL_CAP>=2 前提）に 2 文 → 1 ページ 2 文。
    r.setScenes([scene('s', [dialog('カコ', '最初の文。続きの文。'), dialog('トモ', '次。')])])
    const i = internals(r)
    expect(i.currentPageCount({ text: ['最初の文。続きの文。'] })).toBe(1) // 1 ページ
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    // 同一ページ内を 1 文送る（PageBreak が無いので改頁・次イベントには行かない）。
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 1 })
    // ページ最後の文 → 次イベントへ。
    i.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0, sentenceIndex: 0 })
  })

  it('P6: novel で次イベントへ進む前に前ページ文字を clear する', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [dialog('カコ', '最初の文。'), dialog('トモ', '次。')])])
    const i = internals(r)
    const clearText = vi.spyOn(i.dialogBox, 'clearText')

    i.advance()

    expect(clearText).toHaveBeenCalled()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0, sentenceIndex: 0 })
  })
})

// ===== #305: 主人公の本文色（暖アイボリー #FFF6E6）／住人は純白 =====
//
// 本文色は render() 時に話者から決定論的に導出して DialogBox.setBodyTextColor に渡す per-line の
// 描画属性（GameState には持たない）。ここでは導出の純粋部分（resolveBodyTextColor）を直接検証する。
// DialogBox への受け渡し（dialogText.style.fill 反映）は DialogBox.test.ts で検証する。
const FFF6E6 = 0xfff6e6 // 暖アイボリー（kako-jun 確定）
const WHITE = 0xffffff
describe('NovelRenderer 主人公本文色 (#305)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('novel + protagonist 一致話者は既定の暖アイボリー #FFF6E6 に解決する', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    expect(internals(r).resolveBodyTextColor('せお')).toBe(FFF6E6)
  })

  it('novel の住人（非主人公）は純白に解決する', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    expect(internals(r).resolveBodyTextColor('ひな')).toBe(WHITE)
  })

  it('protagonist 未指定なら novel でも全員白（色差しない・後方互換）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    expect(internals(r).resolveBodyTextColor('せお')).toBe(WHITE)
    expect(internals(r).resolveBodyTextColor('ひな')).toBe(WHITE)
  })

  it('adv では protagonist を設定しても色差しない（全員白・adv 非回帰）', () => {
    const r = new NovelRenderer()
    // dialog_style 未指定 = adv
    r.setProtagonist('せお')
    expect(internals(r).resolveBodyTextColor('せお')).toBe(WHITE)
    expect(internals(r).resolveBodyTextColor('ひな')).toBe(WHITE)
  })

  it('話者不明（null = ナレ）は白に解決する', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    expect(internals(r).resolveBodyTextColor(null)).toBe(WHITE)
  })

  it('setProtagonistTextColor で主人公本文色を per-game 上書きできる', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setProtagonistTextColor('#112233')
    expect(internals(r).resolveBodyTextColor('せお')).toBe(0x112233)
    // 住人は上書きの影響を受けず白のまま。
    expect(internals(r).resolveBodyTextColor('ひな')).toBe(WHITE)
  })

  it('setProtagonistTextColor(null) は既定 #FFF6E6 に倒す', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setProtagonistTextColor('#112233')
    r.setProtagonistTextColor(null)
    expect(internals(r).resolveBodyTextColor('せお')).toBe(FFF6E6)
  })

  it('不正な色指定は既定 #FFF6E6 にフォールバックする', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setProtagonist('せお')
    r.setProtagonistTextColor('not-a-color')
    expect(internals(r).resolveBodyTextColor('せお')).toBe(FFF6E6)
  })
})

// ===== #340: 余韻横棒 `──`（正準化後 U+2500）が novel の文送り配線に到達する =====
//
// novelLayout.test.ts は splitIntoSentences（純粋関数）を直接縛るが、ここでは NovelRenderer の
// ページ化・文送り配線（getNovelPages / currentPageCount / advance）まで `──` が実際に届き、
// 「句点が無くても `──` で文が割れて 1 ページ内 2 文停止・改頁が起きる」ことを end-to-end で固定する。
// events は直接構築するので、正準化パスは経由せず**正準化済みの `──`（U+2500×2）**を渡す。
describe('NovelRenderer novel: 余韻横棒 `──` が文送り境界として配線に届く (#340)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // U+2500×2（正準化後の余韻横棒）。原稿 `--` を canonicalize した後の実データ形。
  const RULE = '\u{2500}\u{2500}'

  // F1: 句点の無い `文1──文2` が 1 ページ内で 2 文に割れ、advance で sentenceIndex 0→1 を踏む。
  //     `──` が無ければ 1 文＝次イベントへ抜ける（sentenceIndex は動かない）ので、
  //     sentenceIndex が前進する事実そのものが「`──` が split 配線に到達した」証明になる。
  it('F1: 句点無し `文1──文2` は 1 ページ 2 文になり advance で sentenceIndex 0→1 を踏む', () => {
    const text = `文1${RULE}文2`
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(text), narration('次。')])])
    const i = internals(r)
    // cap 大・各文 1 行（jsdom）→ 2 文が 1 ページに収まる。
    expect(i.currentPageCount({ text: [text] })).toBe(1)
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    i.advance()
    // 同一イベント・同一ページのまま文 index だけ前進する（`──` 境界が効いている証拠）。
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 1 })
  })

  // F2: `──` 区切りセグメントが cap を超える数だけ並ぶと、ページ総数が ceil(セグメント数 / cap) になる。
  //     句点を一切使わず `──` だけで改頁が起きることを縛る（`──` が paginate まで配線されている）。
  it('F2: cap 超過数の `──` 区切りセグメントは ceil(セグメント数 / cap) ページに改頁される', () => {
    const n = NOVEL_CAP + 1 // cap を 1 つ超える → 2 ページ以上
    // seg1──seg2──…──segN（各セグメント 1 文 = 1 行、句点なし）。
    const text = Array.from({ length: n }, (_, k) => `${k + 1}`).join(RULE)
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setScenes([scene('s', [narration(text)])])
    expect(internals(r).currentPageCount({ text: [text] })).toBe(Math.ceil(n / NOVEL_CAP))
  })
})
