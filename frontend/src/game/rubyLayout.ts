/**
 * ルビ描画位置計算 (#148)
 *
 * `parseRubyText` が返す runs と wordwrap 後の plain 行配列から、
 * 各ルビを「どの行」「base のどこ」に重ねるかを計算する。
 *
 * 描画は DialogBox 側で行うが、ロジックを単体テストできるよう pure function に分離。
 */

import type { RubyRun } from './ruby'

export interface RubyPlacement {
  /** ルビ文字列 */
  ruby: string
  /** base 文字列（ルビを置く対象テキスト） */
  base: string
  /** 何行目に置くか（0 始まり） */
  lineIndex: number
  /** その行内の base 開始文字 index（measureText で x を計算する元） */
  charStartInLine: number
  /** その行内の base 終了文字 index（exclusive） */
  charEndInLine: number
  /**
   * typewriter の displayedCharCount が何文字に達したらルビを表示するか。
   * 値は wordwrap 行を `\n` で連結した文字列上の位置（改行も 1 文字とカウント）。
   * displayedCharCount >= revealAt のときに可視化する。
   */
  revealAt: number
}

/**
 * runs を plain text 全体での文字オフセット付きで走査し、
 * wordwrap 行配列のどの位置に重なるかを計算して RubyPlacement[] を返す。
 *
 * 制約:
 *   - wordwrap 行を順に連結したものが runs.map(r => r.base).join('') と一致している前提
 *     （DialogBox 側で `wordwrap(stripRubyMarkup(text), ...)` から構築する）
 *   - base が行をまたぐと現状の実装では「base 開始行」に置く（はみ出すケース）。
 *     ruby base は通常 1〜数文字の漢字塊なので実用上ほぼ起きないが、
 *     起きても表示崩れは visible 範囲に収まる程度に留める。
 */
export function computeRubyPlacements(runs: RubyRun[], lines: string[]): RubyPlacement[] {
  const placements: RubyPlacement[] = []

  // 各行の plain text 上の開始オフセット（end は次行の start - 0、最終行は plain.length）
  const lineStarts: number[] = []
  let acc = 0
  for (const ln of lines) {
    lineStarts.push(acc)
    acc += ln.length
  }
  const totalPlain = acc

  // typewriter 文字列は lines.join('\n') なので、plain の i 文字目（exclusive な end 含む）は
  // typewriter 上では (i + 直前に挟まった改行数) 番目に対応する。
  //
  // base 末尾の reveal タイミングは「base 末尾文字が表示されたフレーム」なので、
  // end offset には「base 末尾文字を含む行」までの改行数を足す（次行へのまたぎは含めない）。
  function plainToTypewriterEnd(plainOffsetEnd: number): number {
    // base の最後の文字は (plainOffsetEnd - 1) なので、それを含む行を探す。
    // plainOffsetEnd === 0 のケースは base 空なので呼ばれない前提。
    const lastCharOffset = Math.max(0, plainOffsetEnd - 1)
    let lineIndex = 0
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= lastCharOffset) {
      lineIndex++
    }
    return plainOffsetEnd + lineIndex
  }

  let plainOffset = 0
  for (const run of runs) {
    const baseLen = run.base.length
    const baseStart = plainOffset
    const baseEnd = plainOffset + baseLen
    plainOffset = baseEnd

    if (run.ruby === null) continue
    if (baseLen === 0) continue
    if (baseEnd > totalPlain) continue // 安全ガード

    // base 開始の (line, charInLine)
    let lineIndex = 0
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= baseStart) {
      lineIndex++
    }
    const charStartInLine = baseStart - lineStarts[lineIndex]

    // 行末でクリップ（base が改行をまたぐ場合の暫定対応）
    const lineEndOffset = lineStarts[lineIndex] + lines[lineIndex].length
    const clippedEnd = Math.min(baseEnd, lineEndOffset)
    const charEndInLine = clippedEnd - lineStarts[lineIndex]

    // 表示タイミング: base 末尾が typewriter で表示完了した瞬間
    // typewriter offset は plain offset + 行頭までの改行数
    const revealAt = plainToTypewriterEnd(baseEnd)

    placements.push({
      ruby: run.ruby,
      base: run.base.substring(0, charEndInLine - charStartInLine),
      lineIndex,
      charStartInLine,
      charEndInLine,
      revealAt,
    })
  }

  return placements
}
