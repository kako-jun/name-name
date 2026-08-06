//! 文境界による改頁ロジック (#486)。
//!
//! GUI版 `frontend/src/game/novelLayout.ts` の `splitIntoSentences`（#283/#340/#374）と
//! `frontend/src/game/NovelRenderer.ts` の `getAdvSentencePages`（#448）の TUI 版移植。
//!
//! TUI は `dialog_style` を常に adv 固定で運用する（#487）ため、本モジュールは
//! `getAdvSentencePages` 相当（adv 用の文単位 1 ページ化）だけを対象とし、novel 側の行数
//! キャップ改頁（`paginateSentencesByLines`）は移植しない（#486 スコープ外）。
//!
//! また TUI は `playback.rs` の `strip_ruby_markup` で表示前にルビ記法を完全除去済みのため、
//! GUI 版が持つ「文境界判定は plain text で・表示はルビ記法保持」の二重管理
//! （`mapSentencesToRubyPreservedText`）は不要 — 常にルビ除去後の plain text に対して
//! そのまま文分割すればよい。
//!
//! `MIDLINE_RULE`（余韻横棒 `─`、U+2500）は GUI版と共通の正準化字形で、Rust側は既に
//! `name_name_parser::canonicalize` が公開済みのため、ここでは再定義せずそれを再利用する
//! （parser の `canonicalize_body_line` が原稿の `--` をこの文字へ正準化する）。

use name_name_parser::canonicalize::MIDLINE_RULE;

/// 文末記号（句点・感嘆符・疑問符、全角＋半角）。
const SENTENCE_TERMINATORS: &[char] = &['。', '！', '？', '!', '?'];

/// 文末記号の直後に同じ文へ取り込む閉じ括弧・閉じ引用符・読点。
const SENTENCE_TRAILERS: &[char] = &[
    '」', '』', '】', '〕', '〗', '〙', '）', '］', '｝', '〉', '》', '\u{201d}', '\u{2019}', '｠',
    '、', '，',
];

/// 先頭ダッシュを導く「括りの終わり」の閉じ括弧・閉じ引用符。`SENTENCE_TRAILERS` から読点
/// `、，` を除いた集合（読点は句の途中なので `──` は文中扱いのまま）。
const CLOSING_BRACKETS: &[char] = &[
    '」', '』', '】', '〕', '〗', '〙', '）', '］', '｝', '〉', '》', '\u{201d}', '\u{2019}', '｠',
];

fn is_terminator(ch: char) -> bool {
    SENTENCE_TERMINATORS.contains(&ch)
}

fn is_trailer(ch: char) -> bool {
    SENTENCE_TRAILERS.contains(&ch)
}

fn is_midline_rule(ch: char) -> bool {
    ch == MIDLINE_RULE
}

/// `current` の末尾に確定済みの文を1つ積み、`current` を空にする。空白のみ／空の `current`
/// は捨てる（push しない）。GUI版 `flush`（判定は `trim()`、push する値は untrimmed）と同じ。
fn flush(current: &mut Vec<char>, sentences: &mut Vec<String>) {
    let text: String = current.iter().collect();
    if !text.trim().is_empty() {
        sentences.push(text);
    }
    current.clear();
}

/// 直後の閉じ括弧・閉じ引用符・句読点を同じ文へ取り込む。取り込んだ最後の index を返す。
fn absorb_trailers(chars: &[char], n: usize, mut i: usize, current: &mut Vec<char>) -> usize {
    while i + 1 < n && is_trailer(chars[i + 1]) {
        i += 1;
        current.push(chars[i]);
    }
    i
}

/// 連続する `──` を `current` に取り込み、末尾の index を返す。
fn absorb_rule_run(chars: &[char], n: usize, mut i: usize, current: &mut Vec<char>) -> usize {
    while i + 1 < n && is_midline_rule(chars[i + 1]) {
        i += 1;
        current.push(chars[i]);
    }
    i
}

/// 文中 `──`（trailing）の後処理: 直後の閉じ括弧トレーラを吸収し、さらに直後に文末記号が
/// 続けば `──。` として 1 停止にまとめる（そのトレーラも吸収）。
fn absorb_rule_trail(chars: &[char], n: usize, i: usize, current: &mut Vec<char>) -> usize {
    let mut i = absorb_trailers(chars, n, i, current);
    if i + 1 < n && is_terminator(chars[i + 1]) {
        i += 1;
        current.push(chars[i]);
        i = absorb_trailers(chars, n, i, current);
    }
    i
}

/// `run_start` の `──` の直前（空白を飛ばした最後の実文字）が「括りの終わり」＝文末記号 or
/// 閉じ括弧/閉じ引用符か。読点 `、` は括りの終わりに含めない（文中扱い）。
///
/// 空白判定は Rust `char::is_whitespace`（Unicode `White_Space` プロパティ）を使う。JS の
/// `\s` とはごく僅かに集合が異なる（Rust は U+0085 NEL を含み U+FEFF ZWNBSP を含まない一方、
/// JS `\s` はその逆）が、台本テキストにこれらの制御文字が現れることは実運用上ない。
fn preceded_by_clause_end(chars: &[char], run_start: usize) -> bool {
    let mut p: isize = run_start as isize - 1;
    while p >= 0 && chars[p as usize].is_whitespace() {
        p -= 1;
    }
    if p < 0 {
        return false;
    }
    let ch = chars[p as usize];
    is_terminator(ch) || CLOSING_BRACKETS.contains(&ch)
}

/// 本文を文境界で分割する純粋関数 (#283 / #340 / #374 の Rust 移植、#486)。
///
/// 句点・感嘆符・疑問符を文末とみなし、直後に続く閉じ括弧・閉じ引用符（および句読点）は
/// その文に含める。加えて余韻横棒 `──`（U+2500 の連続）も文送り境界とする。文末記号を
/// 持たない末尾の断片も 1 文として返す。改行（`\n`）は文の途中の改行として温存し、文境界
/// とはしない。
///
/// `──` の帰属は直前の「括りの終わり」の有無で決まる (#374)。括りの終わり＝文末記号
/// （`。！？!?`）または閉じ括弧/閉じ引用符（`」』…`。読点 `、` は含めない＝句の途中）:
///  - **括りの終わりの直後の `──`（`。──` / `」──` 等）**＝「次のかたまりを導く先頭ダッシュ」。
///    括りの終わりで切って `──` は次の表示単位の先頭に回す。括りの終わりと `──` の間の空白
///    （`。 ──`／`「お題」 ──`）は捨てず次単位の先頭空白として温存する。
///  - **それ以外の `──`（直前が括りの終わりでない・文中）**＝従来どおり `──` の後で停止し、
///    `──` は前の単位に含める (#340)。この場合は直後に文末記号が続けば `──。` として
///    1 停止にまとめる（二重に止まらない）。
///
/// - 空文字・空白だけの入力は空配列 `[]` を返す。
/// - テキスト全体の先頭・末尾（外周）の余分な空白は関数冒頭で 1 回だけトリムするが、
///   文と文の境界にある空白・改行はトリムせず温存する (#362)。判定（空文字かどうか）には
///   trim した値を使うが、push する値は常に untrimmed の `current` にする。
///
/// `text` は既にルビ記法除去済み（`playback::strip_ruby_markup`）の plain text を渡す想定。
pub fn split_into_sentences(text: &str) -> Vec<String> {
    // 外周だけ 1 回 trim する。文中・文境界の空白/改行は以降一切トリムしない (#362)。
    let outer_trimmed = text.trim();
    let chars: Vec<char> = outer_trimmed.chars().collect();
    let n = chars.len();
    let mut sentences: Vec<String> = Vec::new();
    let mut current: Vec<char> = Vec::new();

    let mut i: usize = 0;
    while i < n {
        let ch = chars[i];
        if is_midline_rule(ch) {
            if preceded_by_clause_end(&chars, i) {
                // 先頭ダッシュ (#374): 括りの終わり（文末記号 or 閉じ括弧）で切り、この `──` を
                // 次の単位の先頭に置く。current を「末尾空白」と「それ以外の本文」に分け、本文を
                // 1 単位として flush し、末尾空白は次単位の先頭空白として温存する。
                let trailing_ws_count = current
                    .iter()
                    .rev()
                    .take_while(|c| c.is_whitespace())
                    .count();
                let split_point = current.len() - trailing_ws_count;
                let trailing_ws: Vec<char> = current[split_point..].to_vec();
                current.truncate(split_point);
                flush(&mut current, &mut sentences); // 本文（空でなければ）を確定。空白のみ/空なら no-op。
                current = trailing_ws;
                current.push(ch);
                i = absorb_rule_run(&chars, n, i, &mut current);
            } else {
                // 文中 `──`（trailing, #340）: `──`（連続分含む）の後で停止し、前の単位に含める。
                current.push(ch);
                i = absorb_rule_run(&chars, n, i, &mut current);
                i = absorb_rule_trail(&chars, n, i, &mut current);
                flush(&mut current, &mut sentences);
            }
        } else if is_terminator(ch) {
            // 文末記号: 直後のトレーラを吸収して停止する。直後の `──` は吸収しない (#374)。
            current.push(ch);
            i = absorb_trailers(&chars, n, i, &mut current);
            flush(&mut current, &mut sentences);
        } else {
            current.push(ch);
        }
        i += 1;
    }
    // 文末記号で終わらない末尾の断片も 1 文として拾う。
    flush(&mut current, &mut sentences);
    sentences
}

/// `/\n+/g` → `' '` 相当。連続する改行を単一の半角スペースへ畳む。
fn collapse_newline_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            out.push(' ');
            while chars.peek() == Some(&'\n') {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// group（連続する非空行）を 1 本の本文へ結合し、文分割した結果を `pages` へ追記する。
fn flush_group(group: &mut Vec<String>, pages: &mut Vec<String>) {
    if group.is_empty() {
        return;
    }
    let joined = group.join("\n");
    let collapsed = collapse_newline_runs(&joined);
    pages.extend(split_into_sentences(&collapsed));
    group.clear();
}

/// adv スタイルの「文単位ページ」へ分割する (`getAdvSentencePages` 相当、#448/#486)。
///
/// `lines` は `DisplayLine::text`（markdown 原稿の `Event::Dialog`/`Narration` の
/// `text: Vec<String>`。既にルビ記法除去済み）をそのまま渡す想定。
///
/// GUI版のバグ2対応（Narration の空白ポーズページ消滅、#448）を踏襲する: parser の `>`
/// 単独行は空文字列要素（`""`）になり、従来 adv（`sentence_per_page: false`）では「間を
/// 置く」空白ページとして機能していた（`["一言目。", "", "二言目。"]` → 3 ページ）。単純に
/// 全行を `\n` 結合してから空白へ畳むと、空要素由来の連続 `\n\n` が半角スペース 1 個に潰れて
/// 空白ページが消えるため、`lines` を空文字列要素で分割し、各グループを独立に文分割してから
/// グループの間に空文字 1 ページを挿入する。
///
/// GUI版と異なり、ルビ記法保持テキストへのマッピング（`mapSentencesToRubyPreservedText`）は
/// 行わない — `lines` は既にルビ除去済みの plain text であり、文分割対象そのものが表示対象と
/// 一致するため（モジュール冒頭のドキュメント参照）。
///
/// テキストが空（`lines` が空、または空文字列要素のみ）なら 1 ページ（空文字）を返し、
/// 従来の空表示を保つ。
pub fn adv_sentence_pages(lines: &[String]) -> Vec<String> {
    let mut pages: Vec<String> = Vec::new();
    let mut group: Vec<String> = Vec::new();

    for line in lines {
        if line.is_empty() {
            // `>` 単独行由来の空文字要素 (#448 バグ2) = 意図的な空白ポーズページ。
            flush_group(&mut group, &mut pages);
            pages.push(String::new());
        } else {
            group.push(line.clone());
        }
    }
    flush_group(&mut group, &mut pages);
    if pages.is_empty() {
        pages.push(String::new());
    }
    pages
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- split_into_sentences: 基本ケース ----

    #[test]
    fn empty_input_returns_empty_vec() {
        assert_eq!(split_into_sentences(""), Vec::<String>::new());
    }

    #[test]
    fn no_terminator_returns_single_fragment() {
        assert_eq!(split_into_sentences("断片"), vec!["断片"]);
    }

    // ---- ゴールデン値テスト (#486 doctrine「等価性の機械的証明」) ----
    //
    // 以下は frontend/src/game/novelLayout.ts の `splitIntoSentences`／`getAdvSentencePages`
    // 相当ロジックを `npx tsx` で実際に実行して得た出力をそのままゴールデン値として貼り付けた
    // もの（推測でゴールデン値を作らない）。生成に使ったスクリプトは句点・感嘆符・疑問符混在、
    // `──`混在（先頭ダッシュ／文中トレーリングの両方）、閉じ括弧・引用符混在、末尾に文末記号が
    // 無い断片、空文字列・空白のみ入力、`>` 単独行由来の空白ポーズページ等を代表ケースとして
    // 網羅する。

    #[test]
    fn split_into_sentences_basic_mixed_terminators() {
        assert_eq!(
            split_into_sentences("こんにちは。今日はいい天気ですね！本当ですか？"),
            vec!["こんにちは。", "今日はいい天気ですね！", "本当ですか？"]
        );
    }

    #[test]
    fn split_into_sentences_terminator_then_closing_bracket() {
        assert_eq!(
            split_into_sentences("「今日はいい天気ですか？」と聞いた。"),
            vec!["「今日はいい天気ですか？」", "と聞いた。"]
        );
    }

    #[test]
    fn split_into_sentences_terminator_then_touten_trailer() {
        assert_eq!(
            split_into_sentences("えっと。、それでですね。"),
            vec!["えっと。、", "それでですね。"]
        );
    }

    #[test]
    fn split_into_sentences_question_then_exclaim_adjacent() {
        assert_eq!(split_into_sentences("なに？！"), vec!["なに？", "！"]);
    }

    #[test]
    fn split_into_sentences_no_terminator_fragment() {
        assert_eq!(
            split_into_sentences("これは文末記号がない断片"),
            vec!["これは文末記号がない断片"]
        );
    }

    #[test]
    fn split_into_sentences_empty_string() {
        assert_eq!(split_into_sentences(""), Vec::<String>::new());
    }

    #[test]
    fn split_into_sentences_whitespace_only() {
        assert_eq!(split_into_sentences("   \n\t  "), Vec::<String>::new());
    }

    #[test]
    fn split_into_sentences_midline_trailing_basic() {
        assert_eq!(
            split_into_sentences("私はこう見ている──在る"),
            vec!["私はこう見ている──", "在る"]
        );
    }

    #[test]
    fn split_into_sentences_midline_trailing_with_terminator_after() {
        assert_eq!(
            split_into_sentences("私はこう見ている──。次へ"),
            vec!["私はこう見ている──。", "次へ"]
        );
    }

    #[test]
    fn split_into_sentences_midline_leading_after_terminator() {
        assert_eq!(
            split_into_sentences("です。──それと"),
            vec!["です。", "──それと"]
        );
    }

    #[test]
    fn split_into_sentences_midline_leading_after_terminator_with_space() {
        assert_eq!(
            split_into_sentences("です。 ──それと"),
            vec!["です。", " ──それと"]
        );
    }

    #[test]
    fn split_into_sentences_midline_leading_after_closing_bracket() {
        assert_eq!(
            split_into_sentences("「お題」──本文"),
            vec!["「お題」", "──本文"]
        );
    }

    #[test]
    fn split_into_sentences_midline_leading_after_closing_bracket_with_space() {
        assert_eq!(
            split_into_sentences("「お題」 ──本文"),
            vec!["「お題」", " ──本文"]
        );
    }

    #[test]
    fn split_into_sentences_midline_after_touten_stays_trailing() {
        assert_eq!(split_into_sentences("A、──B"), vec!["A、──", "B"]);
    }

    #[test]
    fn split_into_sentences_midline_run_of_four() {
        assert_eq!(
            split_into_sentences("沈黙が続く────それから"),
            vec!["沈黙が続く────", "それから"]
        );
    }

    #[test]
    fn split_into_sentences_ellipsis_then_midline() {
        assert_eq!(
            split_into_sentences("彼はしばらく黙っていた⋯⋯──それから言った"),
            vec!["彼はしばらく黙っていた⋯⋯──", "それから言った"]
        );
    }

    #[test]
    fn split_into_sentences_ellipsis_then_terminator() {
        assert_eq!(
            split_into_sentences("そう、それは⋯⋯。"),
            vec!["そう、それは⋯⋯。"]
        );
    }

    #[test]
    fn split_into_sentences_ellipsis_then_terminator_then_midline() {
        assert_eq!(
            split_into_sentences("そう⋯⋯。──それから"),
            vec!["そう⋯⋯。", "──それから"]
        );
    }

    #[test]
    fn split_into_sentences_internal_newline_preserved() {
        assert_eq!(
            split_into_sentences("これは1行目\nこれは2行目。次の文"),
            vec!["これは1行目\nこれは2行目。", "次の文"]
        );
    }

    #[test]
    fn split_into_sentences_outer_whitespace_trimmed() {
        assert_eq!(
            split_into_sentences("  こんにちは。  "),
            vec!["こんにちは。"]
        );
    }

    #[test]
    fn split_into_sentences_half_width_terminators() {
        assert_eq!(
            split_into_sentences("What? Really! Yes."),
            vec!["What?", " Really!", " Yes."]
        );
    }

    #[test]
    fn split_into_sentences_multiple_midline_alone() {
        assert_eq!(split_into_sentences("──それは"), vec!["──", "それは"]);
    }

    #[test]
    fn split_into_sentences_midline_at_very_end() {
        assert_eq!(split_into_sentences("それは──"), vec!["それは──"]);
    }

    #[test]
    fn split_into_sentences_closing_quote_single() {
        assert_eq!(
            split_into_sentences("『引用文だ』と彼は言った。"),
            vec!["『引用文だ』と彼は言った。"]
        );
    }

    #[test]
    fn split_into_sentences_fullwidth_paren_trailer() {
        assert_eq!(
            split_into_sentences("（これは注記だ）。次の文へ"),
            vec!["（これは注記だ）。", "次の文へ"]
        );
    }

    #[test]
    fn split_into_sentences_mixed_trailer_chain() {
        assert_eq!(
            split_into_sentences("「本当？」」（変な入れ子）。次"),
            vec!["「本当？」」", "（変な入れ子）。", "次"]
        );
    }

    #[test]
    fn split_into_sentences_comma_ideographic_after_terminator() {
        assert_eq!(
            split_into_sentences("本当に？、そう思う。"),
            vec!["本当に？、", "そう思う。"]
        );
    }

    #[test]
    fn adv_sentence_pages_single_line_multi_sentence() {
        assert_eq!(
            adv_sentence_pages(&["こんにちは。今日はいい天気ですね！".to_string()]),
            vec!["こんにちは。", "今日はいい天気ですね！"]
        );
    }

    #[test]
    fn adv_sentence_pages_multi_markdown_lines_one_group() {
        assert_eq!(
            adv_sentence_pages(&[
                "一行目のセリフ。".to_string(),
                "二行目に続く文章です。".to_string()
            ]),
            vec!["一行目のセリフ。", " 二行目に続く文章です。"]
        );
    }

    #[test]
    fn adv_sentence_pages_pause_between_two_groups() {
        assert_eq!(
            adv_sentence_pages(&[
                "最初のグループ。".to_string(),
                "".to_string(),
                "次のグループ。".to_string()
            ]),
            vec!["最初のグループ。", "", "次のグループ。"]
        );
    }

    #[test]
    fn adv_sentence_pages_leading_pause() {
        assert_eq!(
            adv_sentence_pages(&["".to_string(), "テキスト。".to_string()]),
            vec!["", "テキスト。"]
        );
    }

    #[test]
    fn adv_sentence_pages_trailing_pause() {
        assert_eq!(
            adv_sentence_pages(&["テキスト。".to_string(), "".to_string()]),
            vec!["テキスト。", ""]
        );
    }

    #[test]
    fn adv_sentence_pages_multiple_consecutive_pauses() {
        assert_eq!(
            adv_sentence_pages(&["".to_string(), "".to_string()]),
            vec!["", ""]
        );
    }

    #[test]
    fn adv_sentence_pages_empty_array() {
        assert_eq!(adv_sentence_pages(&[]), vec![""]);
    }

    #[test]
    fn adv_sentence_pages_single_empty_string_line() {
        assert_eq!(adv_sentence_pages(&["".to_string()]), vec![""]);
    }

    #[test]
    fn adv_sentence_pages_no_terminator_single_line() {
        assert_eq!(
            adv_sentence_pages(&["断片テキスト".to_string()]),
            vec!["断片テキスト"]
        );
    }

    #[test]
    fn adv_sentence_pages_group_with_internal_newline_collapse() {
        assert_eq!(
            adv_sentence_pages(&["最初の行".to_string(), "次の行に続く。".to_string()]),
            vec!["最初の行 次の行に続く。"]
        );
    }
}
