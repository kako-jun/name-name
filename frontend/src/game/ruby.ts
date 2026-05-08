/**
 * 青空文庫風ルビ記法のパーサ (#148)
 *
 * 子供向け動画用途で漢字に読み仮名を振るための実装。
 * Markdown 仕様としては parser 側を変更せず、Dialog/Narration の text を
 * 生 markdown のまま保持し、frontend が描画直前にこのモジュールでパースする。
 *
 * 記法:
 *   - 単漢字グルーピング: `漢字《かんじ》` — `《》` の直前から「連続する CJK 漢字」を base にする
 *   - 明示グルーピング:   `｜美少女《びしょうじょ》` — 全角縦棒 `｜` から `《` 直前までが base
 *   - グループ境界: `｜` は plain run 中であれば任意位置で開始可能
 *
 * 不正記法は plain として透過する（壊さない方針）:
 *   - 閉じ忘れ `漢字《かんじ` → 全部 plain
 *   - 開きなし `かんじ》`     → 全部 plain
 *   - 空ルビ   `漢字《》`     → ruby なし扱い、base のみ残す
 *   - `《》` 直前に base 候補が無い（漢字でも `｜` でもない）→ 該当 `《...》` を plain として残す
 *
 * エスケープは未対応。本文に `《》` を書きたいときは `〈〉` 等の別字を使う想定。
 */

export interface RubyRun {
  /** 表示する base 本文（漢字本体、または plain text） */
  base: string
  /** ルビ。null なら plain text run（base がそのまま表示される） */
  ruby: string | null
}

const OPEN = '《' // 《
const CLOSE = '》' // 》
const GROUP_MARK = '｜' // ｜ (FULLWIDTH VERTICAL LINE)

/** CJK 統合漢字 (U+4E00-U+9FFF) + 拡張 A (U+3400-U+4DBF) */
function isCjkIdeograph(ch: string): boolean {
  if (ch.length === 0) return false
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
}

/**
 * 青空文庫記法のルビをパースして RubyRun の配列に分解する。
 *
 * 結果の連続する plain run はマージされない（呼び出し側で必要なら結合する）。
 * ただし `《》` を一切含まない入力は単一の plain run [{ base: line, ruby: null }] を返す（空文字列の場合は空配列）。
 */
export function parseRubyText(line: string): RubyRun[] {
  if (line.length === 0) return []

  // 高速パス: ルビ記号も `｜` も含まなければ plain として返す
  if (!line.includes(OPEN) && !line.includes(GROUP_MARK)) {
    return [{ base: line, ruby: null }]
  }

  const runs: RubyRun[] = []
  // 直前までの「未確定 plain バッファ」。`《》` を確定するときに base を切り出す元になる。
  let buf = ''

  let i = 0
  while (i < line.length) {
    const ch = line[i]

    if (ch === OPEN) {
      // 閉じ括弧を探す
      const closeIdx = line.indexOf(CLOSE, i + 1)
      if (closeIdx === -1) {
        // 閉じ忘れ → 残り全てを plain として buf へ
        buf += line.substring(i)
        i = line.length
        continue
      }

      const rubyText = line.substring(i + 1, closeIdx)
      // base を buf から確定する
      // ルール:
      //   1) buf 末尾が GROUP_MARK で終わっていたらエラー扱い（｜直後に《で base 空）→ plain 透過
      //   2) buf 内に GROUP_MARK が含まれていれば、最後の GROUP_MARK 以降を base にする
      //   3) なければ buf 末尾から逆向きに「連続する CJK 漢字」を base にする
      let baseStartInBuf: number | null = null

      const lastGroup = buf.lastIndexOf(GROUP_MARK)
      if (lastGroup !== -1 && lastGroup === buf.length - 1) {
        // ｜直後が《で base 空 → 不正、plain として透過する
        // buf はそのまま、《...》も plain として吐き出す
        buf += line.substring(i, closeIdx + 1)
        i = closeIdx + 1
        continue
      }

      if (lastGroup !== -1) {
        baseStartInBuf = lastGroup + 1
      } else {
        // 末尾から連続する CJK 漢字を逆走査
        let k = buf.length
        while (k > 0 && isCjkIdeograph(buf[k - 1])) {
          k--
        }
        if (k === buf.length) {
          // base 候補なし → 不正、《...》を plain として透過
          buf += line.substring(i, closeIdx + 1)
          i = closeIdx + 1
          continue
        }
        baseStartInBuf = k
      }

      // baseStartInBuf 確定
      const before = buf.substring(0, baseStartInBuf)
      // 「グループマーク自体」は表示しない（前向きに `｜` を取り除く）
      const beforePlain =
        lastGroup !== -1 && lastGroup >= baseStartInBuf - 1
          ? buf.substring(0, lastGroup) // ｜ より前
          : before

      const baseText = buf.substring(baseStartInBuf)

      // before(plain) を runs に push
      if (beforePlain.length > 0) {
        runs.push({ base: beforePlain, ruby: null })
      }

      if (rubyText.length === 0) {
        // 空ルビ → ruby なしで base のみ plain として残す
        if (baseText.length > 0) {
          runs.push({ base: baseText, ruby: null })
        }
      } else {
        runs.push({ base: baseText, ruby: rubyText })
      }

      buf = ''
      i = closeIdx + 1
      continue
    }

    if (ch === CLOSE) {
      // 開きなしの閉じ括弧 → plain として buf に残す
      buf += ch
      i++
      continue
    }

    // 通常文字（GROUP_MARK 含む）→ buf に蓄積
    buf += ch
    i++
  }

  if (buf.length > 0) {
    // 末尾に残った plain 部分。ただし宙ぶらりんの GROUP_MARK が混じっていれば
    // そのまま透過する（壊さない方針）。
    runs.push({ base: buf, ruby: null })
  }

  // 連続する plain run をマージ（描画/文字数計算をシンプルに保つ）
  return mergePlainRuns(runs)
}

function mergePlainRuns(runs: RubyRun[]): RubyRun[] {
  const out: RubyRun[] = []
  for (const r of runs) {
    const last = out[out.length - 1]
    if (r.ruby === null && last && last.ruby === null) {
      last.base += r.base
    } else {
      out.push({ base: r.base, ruby: r.ruby })
    }
  }
  return out
}

/**
 * ルビ記号を取り除いた plain text を返す。
 * wordwrap の幅計算用。`《...》` は丸ごと削除し、`｜` も削除する。
 *
 * 注: parseRubyText を経由して runs.map(r => r.base).join('') と等価だが、
 * パーサのオーバーヘッドを避けたい用途のためのヘルパー。
 */
export function stripRubyMarkup(line: string): string {
  if (!line.includes(OPEN) && !line.includes(GROUP_MARK)) return line
  return parseRubyText(line)
    .map((r) => r.base)
    .join('')
}
