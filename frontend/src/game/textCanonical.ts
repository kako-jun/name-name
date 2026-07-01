/**
 * 本文（会話文・地の文）の表示用ダイグラフ正準化 (#340)。
 *
 * 原稿は打ちやすい ASCII / U+2026 で書き、読み込み後に中央字形へ置換する。中央字形
 * （`─`=U+2500 / `⋯`=U+22EF）は「上下中央に出る」ため見栄えで採用しているが、普段打つのが
 * 大変なため。自動置換してよいのは正当な literal 表示用途が存在しない書き方だけ（`--` / `…`）で、
 * `？`/`！`/空白/単独ハイフンは literal 用途があるので触らない（原稿側で正しく書く）。
 *
 * `canonicalizeBodyText` は「表示テキスト 1 行」に対する行単位の純変換。どの行に掛けるか
 * （＝対象スコープ）は呼び出し側 `frontend/src/wasm/parser.ts` の normalizeEvents が決める:
 * Dialog / Narration の本文、Choice.options[].text、TitleShow.text、Label.text、RpgEvent 内会話
 * （EventCommand の Dialog / Narration の text）。対象外＝話者名・NpcData.message/name・マスタ名・
 * frontmatter・見出し `##`・ディレクティブ引数・ID・アセットパス。Rust 側 `canonicalize_body_line`
 * （parser/src/canonicalize.rs）と同一挙動で、#308 の二段漏れ（片側だけ直して素の値が出る）を防ぐ。
 */

/** U+2500 BOX DRAWINGS LIGHT HORIZONTAL（余韻横棒の表示字形 `─`）。 */
export const MIDLINE_RULE = '─'
/** U+22EF MIDLINE HORIZONTAL ELLIPSIS（言いよどみの表示字形 `⋯`）。 */
export const MIDLINE_ELLIPSIS = '⋯'

/**
 * 本文 1 行を表示用ダイグラフに正準化する純粋関数 (#340)。
 *
 * - `--`（ASCII U+002D ちょうど 2 連。前後にハイフンが無い＝`(?<!-)--(?!-)` 相当）→ `──`
 *   （U+2500 × 2）。`---`（3 連以上）は markdown hr / 見出し下線と衝突するため不変。単独 `-`・
 *   URL や語中のハイフンも不変（＝あらゆるハイフンの一括置換はしない）。
 * - `…`（U+2026、1 つでも連続でも）→ `⋯`（U+22EF、同数）。
 *
 * 冪等: 出力に ASCII `--` / U+2026 は残らないため二重適用は恒等（既存の `──`/`⋯⋯` コーパスにも恒等）。
 */
export function canonicalizeBodyText(text: string): string {
  const chars = Array.from(text)
  let out = ''
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    if (c === '…') {
      // … → ⋯（1 文字ずつ・連続でも同数）。
      out += MIDLINE_ELLIPSIS
      i++
    } else if (c === '-') {
      // ハイフンの連続長を数え、ちょうど 2 連のときだけ ── に置換する。
      // 1 連（単独）・3 連以上（markdown hr / 見出し下線）はそのまま温存する。
      const start = i
      while (i < chars.length && chars[i] === '-') i++
      out += i - start === 2 ? MIDLINE_RULE + MIDLINE_RULE : '-'.repeat(i - start)
    } else {
      out += c
      i++
    }
  }
  return out
}
