import { describe, it, expect } from 'vitest'
import {
  FF_CURSOR_BLINK_MS,
  FF_DIALOG_HEIGHT_RATIO,
  ffCursorReserve,
  ffCursorVisible,
  ffLinesPerPage,
  pageIndexAtOffset,
  pageStartOffset,
  paginateLines,
  wrapParagraphs,
  FF_DIALOG_MS_PER_CHAR_MAX,
  fieldDialogOptions,
  FF_DIALOG_MS_PER_CHAR,
  FF_DIALOG_TOP_RATIO,
  computeFfDialogRect,
  normalizeDialogStyle,
  normalizeMsPerChar,
} from './ffDialog'
import { BATTLE_LOG_MS_PER_CHAR } from './battleLogTypewriter'
import {
  skipTypewriter,
  startTypewriter,
  tickTypewriter,
  isTypingActive,
  visibleText,
} from './typewriter'

describe('computeFfDialogRect (#840)', () => {
  const sizes: Array<[number, number]> = [
    [640, 360],
    [1280, 720],
    [1920, 1080],
    [800, 600],
    [360, 640],
    [2000, 500],
    [100, 100],
  ]
  it('どの画面サイズでも画面内に収まり、下端は画面の上半分以内', () => {
    for (const [w, h] of sizes) {
      const r = computeFfDialogRect(w, h)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(w)
      expect(r.y + r.height).toBeLessThanOrEqual(h / 2)
      expect(r.width).toBeGreaterThan(0)
      expect(r.height).toBeGreaterThan(0)
    }
  })
  it('左右対称（中央寄せ）で、上端は画面の上部にある', () => {
    for (const [w, h] of sizes) {
      const r = computeFfDialogRect(w, h)
      expect(r.x).toBe(w - (r.x + r.width))
      expect(r.y).toBeLessThan(h / 4)
    }
  })
  it('画面サイズに比例する（大きい画面は窓も大きい）', () => {
    const a = computeFfDialogRect(640, 360)
    const b = computeFfDialogRect(1280, 720)
    expect(b.height).toBeGreaterThan(a.height)
    expect(b.width).toBeGreaterThan(a.width)
    expect(b.y).toBeGreaterThan(a.y)
  })
  it('比率定数が上半分に収まる設計になっている', () => {
    expect(FF_DIALOG_TOP_RATIO + FF_DIALOG_HEIGHT_RATIO).toBeLessThanOrEqual(0.5)
  })
  it('非有限・負は 0 扱いで窓が潰れる（NaN を返さない）', () => {
    for (const bad of [NaN, -5, Infinity]) {
      const r = computeFfDialogRect(bad, bad)
      for (const v of [r.x, r.y, r.width, r.height, r.padding])
        expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('normalizeDialogStyle / normalizeMsPerChar (#840)', () => {
  it("'ff' だけを受け付ける（大文字・空白は許容）", () => {
    expect(normalizeDialogStyle('ff')).toBe('ff')
    expect(normalizeDialogStyle(' FF ')).toBe('ff')
  })
  it('未指定・未知値・非文字列は undefined（従来の窓）', () => {
    for (const bad of [undefined, null, '', 'dark', 'ff-blue', 1, true, {}])
      expect(normalizeDialogStyle(bad)).toBeUndefined()
  })
  it('msPerChar は 0 以上の有限数だけ。それ以外は undefined', () => {
    expect(normalizeMsPerChar(0)).toBe(0)
    expect(normalizeMsPerChar(45)).toBe(45)
    for (const bad of [-1, NaN, Infinity, '30', null, undefined])
      expect(normalizeMsPerChar(bad)).toBeUndefined()
  })
  it('上限（1000ms）まで受け付け、超えたら undefined', () => {
    expect(FF_DIALOG_MS_PER_CHAR_MAX).toBe(1000)
    expect(normalizeMsPerChar(1000)).toBe(1000)
    expect(normalizeMsPerChar(1001)).toBeUndefined()
    expect(normalizeMsPerChar(1e9)).toBeUndefined()
  })
  it('既定の速さは戦闘ログ (#755) と同じ', () => {
    expect(FF_DIALOG_MS_PER_CHAR).toBe(BATTLE_LOG_MS_PER_CHAR)
  })
})

describe('1 文字ずつの進行と全文表示（typewriter 流用）(#840)', () => {
  const MS = FF_DIALOG_MS_PER_CHAR
  it('経過時間に応じて 1 文字ずつ増え、全文に達したら止まる', () => {
    let t = startTypewriter('あいうえお')
    expect(visibleText(t)).toBe('')
    t = tickTypewriter(t, MS, MS)
    expect(visibleText(t)).toBe('あ')
    t = tickTypewriter(t, MS * 2, MS)
    expect(visibleText(t)).toBe('あいう')
    t = tickTypewriter(t, MS * 10, MS)
    expect(visibleText(t)).toBe('あいうえお')
    expect(isTypingActive(t)).toBe(false)
  })
  it('決定操作: 表示中なら全文、全文表示済みなら次へ進める状態', () => {
    let t = startTypewriter('あいうえお')
    t = tickTypewriter(t, MS, MS)
    expect(isTypingActive(t)).toBe(true) // この状態の決定 = 全文表示
    t = skipTypewriter(t)
    expect(visibleText(t)).toBe('あいうえお')
    expect(isTypingActive(t)).toBe(false) // この状態の決定 = 次へ
  })
})

describe('fieldDialogOptions (#840)', () => {
  it('未指定はキーが無い（従来の窓・既定の速さ）', () => {
    const o = fieldDialogOptions({})
    expect(o).toEqual({})
    expect('ffWindow' in o).toBe(false)
    expect('msPerChar' in o).toBe(false)
  })
  it('ff は ffWindow と既定速度 30ms', () => {
    expect(fieldDialogOptions({ dialogStyle: 'ff' })).toEqual({ ffWindow: true, msPerChar: 30 })
  })
  it('dialogMsPerChar が優先（0 = 即時表示）', () => {
    expect(fieldDialogOptions({ dialogStyle: 'ff', dialogMsPerChar: 80 })).toEqual({
      ffWindow: true,
      msPerChar: 80,
    })
    expect(fieldDialogOptions({ dialogStyle: 'ff', dialogMsPerChar: 0 }).msPerChar).toBe(0)
  })
  it('dialogStyle なしで dialogMsPerChar だけなら速さだけ変わり ffWindow は無い', () => {
    const o = fieldDialogOptions({ dialogMsPerChar: 50 })
    expect(o).toEqual({ msPerChar: 50 })
    expect('ffWindow' in o).toBe(false)
  })
})

const chars = (n: number) => (p: string) => {
  // 1 行 n 文字で折り返す単純な wrap（半角も全角も 1 文字 = 1 幅）
  const out: string[] = []
  for (let i = 0; i < p.length; i += n) out.push(p.slice(i, i + n))
  return out
}

describe('ffLinesPerPage (#840 改ページ)', () => {
  it('使える高さ（窓の高さ - 上下のパディング）÷ 行の高さの切り捨て', () => {
    expect(ffLinesPerPage(100, 10, 20)).toBe(4) // (100-20)/20
    expect(ffLinesPerPage(100, 10, 26)).toBe(3) // 80/26 = 3.07
    expect(ffLinesPerPage(100, 10, 27)).toBe(2) // 80/27 = 2.96
  })
  it('窓の大きさに依存する: 大きい窓ほど行が多い', () => {
    const small = computeFfDialogRect(640, 360)
    const large = computeFfDialogRect(1280, 720)
    const lh = (fs: number) => fs * 1.6
    expect(ffLinesPerPage(large.height, large.padding, lh(29))).toBeGreaterThan(
      ffLinesPerPage(small.height, small.padding, lh(29))
    )
  })
  it('極端に小さい窓・非有限値でも最低 1 行', () => {
    expect(ffLinesPerPage(10, 10, 40)).toBe(1)
    expect(ffLinesPerPage(0, 0, 40)).toBe(1)
    expect(ffLinesPerPage(-5, 3, 40)).toBe(1)
    expect(ffLinesPerPage(NaN, 3, 40)).toBe(1)
    expect(ffLinesPerPage(Infinity, 3, 40)).toBeGreaterThanOrEqual(1)
    expect(ffLinesPerPage(100, 3, 0)).toBe(1)
    expect(ffLinesPerPage(100, 3, NaN)).toBe(1)
    expect(ffLinesPerPage(100, NaN, 20)).toBe(5)
  })
})

describe('wrapParagraphs (#840 段落ごとの折り返し)', () => {
  it('改行をまたいで幅を累積しない（各段落が先頭から折り返される）', () => {
    // 「あいうえお」(5) の次の段落「かき」が、前の段落の残り幅ではなく先頭から並ぶ
    expect(wrapParagraphs('あいうえお\nかき', chars(4))).toEqual(['あいうえ', 'お', 'かき'])
  })
  it('空・改行のみ・連続改行', () => {
    expect(wrapParagraphs('', chars(4))).toEqual([''])
    expect(wrapParagraphs('\n', chars(4))).toEqual([''])
    expect(wrapParagraphs('\n\n\n', chars(4))).toEqual([''])
    expect(wrapParagraphs('あ\n\nい', chars(4))).toEqual(['あ', '', 'い'])
    expect(wrapParagraphs('あ\n', chars(4))).toEqual(['あ'])
  })
  it('半角・全角混在は wrap の結果をそのまま並べる', () => {
    expect(wrapParagraphs('abcあい\nxyz', chars(3))).toEqual(['abc', 'あい', 'xyz'])
  })
})

describe('paginateLines (#840 ページ分割)', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`)
  it('行数ちょうど = 1 ページ', () => {
    expect(paginateLines(lines(3), 3)).toEqual([['L0', 'L1', 'L2']])
  })
  it('1 行超えると 2 ページ（2 ページ目は 1 行）', () => {
    expect(paginateLines(lines(4), 3)).toEqual([['L0', 'L1', 'L2'], ['L3']])
  })
  it('空 = 空の 1 ページ', () => {
    expect(paginateLines([], 3)).toEqual([[]])
  })
  it('改行のみ（空行 1 つ）= 1 ページ', () => {
    expect(paginateLines([''], 3)).toEqual([['']])
  })
  it('長い 1 行は 1 ページのまま（行は割らない）', () => {
    expect(paginateLines(['あ'.repeat(500)], 2)).toEqual([['あ'.repeat(500)]])
  })
  it('wrapParagraphs と組み合わせ: 全角・半角混在の長文が行数ごとに分かれ、並べ直すと元の行に戻る', () => {
    const all = wrapParagraphs('あいうえおかきくけこ\nabcdefghij\nさしすせそ', chars(4))
    const pages = paginateLines(all, 2)
    expect(pages.length).toBe(Math.ceil(all.length / 2))
    expect(pages.flat()).toEqual(all)
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(2)
  })
  it('1 ページの行数が 1 未満・非有限でも 1 行ずつ', () => {
    expect(paginateLines(lines(3), 0)).toEqual([['L0'], ['L1'], ['L2']])
    expect(paginateLines(lines(3), -2)).toEqual([['L0'], ['L1'], ['L2']])
    expect(paginateLines(lines(3), NaN)).toEqual([['L0'], ['L1'], ['L2']])
    expect(paginateLines(lines(5), 2.9)).toEqual([['L0', 'L1'], ['L2', 'L3'], ['L4']])
  })
})

describe('pageStartOffset / pageIndexAtOffset (#840 再折り返しで位置を引き継ぐ)', () => {
  const pages = [['ab', 'cd'], ['ef'], ['gh', 'ij']]
  it('各ページの先頭が全体の何文字目か', () => {
    expect([0, 1, 2, 3].map((i) => pageStartOffset(pages, i))).toEqual([0, 4, 6, 10])
  })
  it('位置 → ページ番号（ちょうど先頭ならそのページ）', () => {
    expect(pageIndexAtOffset(pages, 0)).toBe(0)
    expect(pageIndexAtOffset(pages, 3)).toBe(0)
    expect(pageIndexAtOffset(pages, 4)).toBe(1)
    expect(pageIndexAtOffset(pages, 6)).toBe(2)
    expect(pageIndexAtOffset(pages, 999)).toBe(2)
    expect(pageIndexAtOffset(pages, NaN)).toBe(0)
    expect(pageIndexAtOffset(pages, -3)).toBe(0)
  })
})

describe('ffCursorVisible / ffCursorReserve (#840)', () => {
  it('ON から始まり、周期ごとに反転する', () => {
    expect(ffCursorVisible(0)).toBe(true)
    expect(ffCursorVisible(FF_CURSOR_BLINK_MS - 1)).toBe(true)
    expect(ffCursorVisible(FF_CURSOR_BLINK_MS)).toBe(false)
    expect(ffCursorVisible(FF_CURSOR_BLINK_MS * 2 - 1)).toBe(false)
    expect(ffCursorVisible(FF_CURSOR_BLINK_MS * 2)).toBe(true)
  })
  it('負・非有限は ON', () => {
    expect(ffCursorVisible(-1)).toBe(true)
    expect(ffCursorVisible(NaN)).toBe(true)
    expect(ffCursorVisible(Infinity)).toBe(true)
  })
  it('▼の分の予約幅は文字サイズに比例。不正値は 0', () => {
    expect(ffCursorReserve(40)).toBe(32)
    expect(ffCursorReserve(0)).toBe(0)
    expect(ffCursorReserve(NaN)).toBe(0)
    expect(ffCursorReserve(-4)).toBe(0)
  })
})
