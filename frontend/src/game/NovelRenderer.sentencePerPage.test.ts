/**
 * NovelRenderer の `sentence_per_page: true`（#448 1ページ=1文の厳密改頁）単体テスト。
 *
 * テスト設計フェーズで発見された2件のバグ修正と1件の仕様確認を検証する:
 *   - バグ1: adv + sentence_per_page:true でルビ記法（`《》`/`｜`）が消える
 *     （getAdvSentencePages が stripRubyMarkup 済みテキストを DialogBox.setDialog に渡していた）。
 *   - バグ2: adv + sentence_per_page:true で Narration の `>` 単独行（空文字要素）由来の
 *     「間を置く」空白ポーズページが消滅する（`text[].join('\n').replace(/\n+/g,' ')` で潰れていた）。
 *   - Part2: setSentencePerPage がテキスト表示中でも即座に再描画しない非対称
 *     （setDialogStyle は即再描画するのに setSentencePerPage はキャッシュ破棄だけだった）。
 *
 * 駆動方式（既存 NovelRenderer.novel.test.ts と同じ流儀）:
 *   `new NovelRenderer()` → `setDialogStyle(...)` / `setSentencePerPage(...)` / `setScenes(...)` の
 *   最小構成。init() を呼ばないため render() は `if (!this.initialized) return` で描画をスキップする。
 *   改頁ロジック・ページ index 前進は getAdvSentencePages / getNovelPages / currentPageCount / advance /
 *   goBack という純計算アダプタを経由するため init なしで観測できる。
 *   Part2（即時再描画）だけは `initialized` を手動で true に立てて `render` を spy する
 *   （NovelRenderer.tachieTiming.test.ts と同じ流儀。render の実 body は PixiJS 依存なので spy で
 *   no-op 化し、呼ばれたかどうかだけを観測する）。
 *
 * jsdom の前提（novel.test.ts と同じ）: canvas.getContext('2d') が null → wordwrap は常に 1 行 →
 * 各文 = 1 行。1 文の複数行折り返しは `dialogBox.measureLineCount` を spy して人工的に再現する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

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

interface RendererInternals {
  render(): void
  initialized: boolean
  eventIndex: number
  resolvedEvents: Event[]
  dialogBox: {
    novelMaxLinesPerPage(): number
    measureLineCount(s: string): number
  }
  novelPagesCache: { eventIndex: number; pages: unknown[] } | null
  advSentencePagesCache: { eventIndex: number; pages: string[] } | null
  getNovelPages(textEvt: { text: string[] }): Array<{ text: string; sentences: string[] }>
  getAdvSentencePages(textEvt: { text: string[] }): string[]
  currentPageCount(textEvt: { text: string[] }): number
  isNovelStyle(): boolean
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer adv + sentence_per_page:true 本体機能 (#448)', () => {
  it('adv 明示 + sentence_per_page:true で currentPageCount() が文数を返す', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [dialog('カコ', '一。二。三。')])])
    expect(internals(r).currentPageCount({ text: ['一。二。三。'] })).toBe(3)
  })

  it('dialog_style 未指定 + sentence_per_page:true でも adv 相当として sentence 分岐が効く', () => {
    const r = new NovelRenderer()
    // setDialogStyle を呼ばない = 未指定（adv 相当）。
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [narration('甲。乙。')])])
    expect(internals(r).isNovelStyle()).toBe(false)
    expect(internals(r).currentPageCount({ text: ['甲。乙。'] })).toBe(2)
  })

  it('adv + sentence_per_page:false（既定）は従来通り text[] 要素数 = ページ数（非回帰ロック）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    // setSentencePerPage を呼ばない = 既定 false。
    r.setScenes([scene('s', [dialog('カコ', '行1', '行2', '行3')])])
    expect(internals(r).currentPageCount({ text: ['行1', '行2', '行3'] })).toBe(3)
    // sentence 分岐（getAdvSentencePages）は一切呼ばれていない（派生キャッシュが温まらない）。
    expect(internals(r).advSentencePagesCache).toBeNull()
  })
})

describe('NovelRenderer novel + sentence_per_page:true（既存の貪欲改頁との差分明示 #448）', () => {
  it('novel + sentence_per_page:true + 短文複数 → 1 文ごとに改頁される', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [narration('一。二。三。')])])
    const i = internals(r)
    const cap = i.dialogBox.novelMaxLinesPerPage()
    expect(cap).toBeGreaterThanOrEqual(3) // 前提: 3 文が cap に収まる（対照テストの成立条件）
    expect(i.currentPageCount({ text: ['一。二。三。'] })).toBe(3)
  })

  it('novel + sentence_per_page:false（既定）は同じ短文複数が貪欲改頁で 1 ページに収まる（対照）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // setSentencePerPage を呼ばない = 既定 false。
    r.setScenes([scene('s', [narration('一。二。三。')])])
    const i = internals(r)
    const cap = i.dialogBox.novelMaxLinesPerPage()
    expect(cap).toBeGreaterThanOrEqual(3)
    // 貪欲改頁なら cap 内に収まる 3 文は 1 ページにまとまる（sentence_per_page:true の 3 ページと対照）。
    expect(i.currentPageCount({ text: ['一。二。三。'] })).toBe(1)
  })

  it('novel + sentence_per_page:true + 1 文で cap 超過 → 単独ページ（次ページが空にならない・文の重複なし）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [narration('長い一文。'), narration('次。')])])
    const i = internals(r)
    const cap = i.dialogBox.novelMaxLinesPerPage()
    // jsdom は wordwrap が常に 1 行を返すため、measureLineCount を spy して人工的に cap 超過を再現する。
    vi.spyOn(i.dialogBox, 'measureLineCount').mockReturnValue(cap + 5)
    const pages = i.getNovelPages({ text: ['長い一文。'] })
    expect(pages).toHaveLength(1) // 単独ページ（次ページが空で追加されない）
    expect(pages[0].sentences).toEqual(['長い一文。']) // 文の重複なし
    expect(i.currentPageCount({ text: ['長い一文。'] })).toBe(1)
  })
})

describe('NovelRenderer バグ1検証: adv + sentence_per_page:true でルビ記法が保持される (#448)', () => {
  it('ルビ記法入り Dialog → getAdvSentencePages の各ページにルビ記法（《》/｜）が保持される', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    const text = ['今日《きょう》は晴れ《はれ》。明日《あした》は雨《あめ》。']
    r.setScenes([scene('s', [dialog('カコ', ...text)])])
    const pages = internals(r).getAdvSentencePages({ text })
    expect(pages).toEqual(['今日《きょう》は晴れ《はれ》。', '明日《あした》は雨《あめ》。'])
  })

  it('対照: adv + sentence_per_page:false は sentence 分岐を経由せず、text[] のルビ記法がそのまま残る', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    // setSentencePerPage を呼ばない = 既定 false。
    const text = ['今日《きょう》は晴れ《はれ》。']
    r.setScenes([scene('s', [dialog('カコ', ...text)])])
    const i = internals(r)
    expect(i.currentPageCount({ text })).toBe(1)
    // getAdvSentencePages（ルビ剥がし+文分割の入口）は一切呼ばれない = 呼び出し元は text[] を
    // そのまま使うため、ルビ記法は当然に保持される（render() 側の分岐そのものの回帰ロック）。
    expect(i.advSentencePagesCache).toBeNull()
    expect(text[0]).toContain('《きょう》')
  })
})

describe('NovelRenderer バグ2検証: adv + sentence_per_page:true で Narration の空白ポーズページが保持される (#448)', () => {
  // parser.rs の `> 一言目。` / `>` / `> 二言目。` が作る text: ["一言目。", "", "二言目。"] を直接与える。
  const narrationWithPause = ['一言目。', '', '二言目。']

  it('`>` 単独行（空文字要素）が中間にあるケース → 空白ポーズページが保持される（3ページ）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [narration(...narrationWithPause)])])
    const pages = internals(r).getAdvSentencePages({ text: narrationWithPause })
    expect(pages).toEqual(['一言目。', '', '二言目。'])
  })

  it('advance() で空白ポーズページを経由して正しく前進する（文単位ページの中間に空ページを挟む）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [narration(...narrationWithPause), narration('次。')])])
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0 })
    r.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 1 }) // 空白ポーズページ
    r.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 2 })
    r.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 1, textIndex: 0 }) // 次イベントへ
  })

  it('対照: adv + sentence_per_page:false（既定）は同じ Narration パターンで従来通り3ページとも保持される', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    // setSentencePerPage を呼ばない = 既定 false。
    r.setScenes([scene('s', [narration(...narrationWithPause)])])
    expect(internals(r).currentPageCount({ text: narrationWithPause })).toBe(3)
  })
})

describe('NovelRenderer adv 文境界規則の回帰固定 (#448 ADV版)', () => {
  it('？！連続は別ページになり、半角 `.` のみでは分割されない', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    const text = ['本当に？！はい。']
    r.setScenes([scene('s', [dialog('カコ', ...text)])])
    expect(internals(r).getAdvSentencePages({ text })).toEqual(['本当に？', '！', 'はい。'])

    // 半角 `.` は文末記号に含まれないため割れない（1 ページのまま）。
    const r2 = new NovelRenderer()
    r2.setDialogStyle('adv')
    r2.setSentencePerPage(true)
    const text2 = ['3.14は円周率です。']
    r2.setScenes([scene('s', [dialog('カコ', ...text2)])])
    expect(internals(r2).getAdvSentencePages({ text: text2 })).toEqual(['3.14は円周率です。'])
  })

  it('余韻横棒 `──` は文末記号直後で切り、次ページの先頭に回る（先頭ダッシュ #374 の ADV 版）', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    const text = ['A。──B']
    r.setScenes([scene('s', [dialog('カコ', ...text)])])
    expect(internals(r).getAdvSentencePages({ text })).toEqual(['A。', '──B'])
  })
})

describe('NovelRenderer 空/空白テキストのフォールバック (#448)', () => {
  it('adv + sentence_per_page:true で text 全体が空白のみ → 1 ページ（空文字）にフォールバックする', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [dialog('カコ', '   ')])])
    const pages = internals(r).getAdvSentencePages({ text: ['   '] })
    expect(pages).toEqual([''])
  })
})

describe('NovelRenderer Part2: setSentencePerPage の即時再描画 (#448)', () => {
  it('テキスト表示中に setSentencePerPage(true) をトグルすると即座に render() が呼ばれる', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setScenes([scene('s', [narration('こんにちは。')])])
    const i = internals(r)
    // renderOnce 相当のガード `if (!this.initialized) return` を通すため initialized を立てる
    // （NovelRenderer.tachieTiming.test.ts と同じ流儀）。render の実 body は PixiJS 依存なので
    // spy で no-op 化し、呼ばれたかどうかだけを観測する。
    i.initialized = true
    const renderSpy = vi.spyOn(i, 'render').mockImplementation(() => {})
    r.setSentencePerPage(true)
    expect(renderSpy).toHaveBeenCalled()
  })

  it('対照: テキスト未表示（initialized=false）なら setSentencePerPage は render() を呼ばない', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setScenes([scene('s', [narration('こんにちは。')])])
    const i = internals(r)
    // initialized を立てない（= まだ実画面に表示されていない状態を模す）。
    const renderSpy = vi.spyOn(i, 'render').mockImplementation(() => {})
    r.setSentencePerPage(true)
    expect(renderSpy).not.toHaveBeenCalled()
  })
})

describe('NovelRenderer adv + sentence_per_page:true の advance/goBack 往復 (#448)', () => {
  it('advance() でページを進めた後 goBack() すると文単位で正しく戻る', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setSentencePerPage(true)
    r.setScenes([scene('s', [narration('一。二。三。')])])
    expect(internals(r).currentPageCount({ text: ['一。二。三。'] })).toBe(3)

    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0 })
    r.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 1 })
    r.advance()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 2 })

    r.goBack()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 1 })
    r.goBack()
    expect(r.getSnapshot()).toMatchObject({ eventIndex: 0, textIndex: 0 })
  })
})

describe('NovelRenderer adv→novel の setDialogStyle 切替 (#448 派生キャッシュ二重破棄)', () => {
  it('sentence_per_page:true のまま adv→novel へ切替直後、両キャッシュが破棄され古いページ構成が混入しない', () => {
    const r = new NovelRenderer()
    r.setSentencePerPage(true) // dialog_style 未指定 = adv 相当
    r.setScenes([scene('s', [narration('一。二。三。')])])
    const i = internals(r)
    // adv 文単位ページキャッシュを温める。
    i.getAdvSentencePages({ text: ['一。二。三。'] })
    expect(i.advSentencePagesCache).not.toBeNull()
    expect(i.novelPagesCache).toBeNull() // novel 側はまだ触っていない

    r.setDialogStyle('novel')
    // スタイル切替で両方の派生キャッシュが破棄される（片方だけ残って古いページ構成が混入しない）。
    expect(i.advSentencePagesCache).toBeNull()
    expect(i.novelPagesCache).toBeNull()
  })
})
