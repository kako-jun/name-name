//! パース済み `Document` を、TUI で逐次表示するための再生位置に変換する。
//!
//! 会話文（Dialog / Narration）の逐次表示に加え、選択肢分岐（`Event::Choice`）にも対応する
//! （#482）。フラグ管理・セーブ/ロードは引き続き対象外（`parser::models::Event` にそれらの
//! 型があっても扱わない）。背景・SE・BGM・立ち絵演出などその他のイベントは、今回も画面表示を
//! 変えないため読み飛ばす（左側は常にプレースホルダ表示のみ）。ただし `Event::EventImage` /
//! `EventImageExit` だけは例外で、各 `DisplayLine` に `event_image`（その時点で表示されて
//! いるべきイベント絵の相対パス）として反映する（#481）。左側は `event_image` が `None` の
//! ときのみ従来どおりプレースホルダ表示になる。`Event::Choice` はこの状態に影響しない
//! （Choice イベントを挟んでも、直前までの `event_image` はそのまま後続の `DisplayLine` に
//! 引き継がれる）。
//!
//! ## 選択肢分岐の設計 (#482)
//!
//! `Document` の chapters → scenes → events を一直線にフラット化する既存のシンプルな
//! モデル（#471 MVP、以前は `Event::Choice` を他の非表示イベントと同様に読み飛ばしていた）は
//! そのまま維持する。Choice イベントも `items`（旧 `lines`）の1要素（[`PlaybackItem::Choice`]）
//! として保持するようにしただけで、フラット化そのものは変えていない。加えて、各シーンの
//! 先頭 item のインデックスを `scene_start`（シーンID → `items` インデックス）として記録して
//! おく。選択肢が確定すると、`items` 内の現在位置を選ばれた `jump` 先シーンの `scene_start`
//! へ再配置するだけで遷移を実現する（[`Playback::select_current_choice`]）。
//!
//! GUI版 `NovelRenderer.jumpToScene`（`frontend/src/game/NovelRenderer.ts`）も `jump` 先を
//! シーンIDで解決する点は同じだが、GUI版は選ばれたシーンの `events` だけを新しい再生ストリーム
//! として張り直す（そのシーンの events を使い切ると `onEndCallback` で終劇になる、＝シーン境界を
//! 越えて自動的に後続シーンへ読み進めることはない）。対して TUI版は既存のフラット化済み1本の
//! `items` の中で現在位置を移動するだけなので、jump 先シーンの内容を読み終えると（GUI版のように
//! 終劇にはならず）ドキュメント順で後続の items へそのまま読み進める、という設計上の違いがある。
//! GUI版ほど厳密なシーン分離ではないが、既存の線形モデルをそのまま流用でき実装コストが小さいため
//! この簡略化を採用した（Issue #482 の実装方針で明示的に許容されている割り切り）。
//!
//! ### ファイル境界の例外 (#496)
//!
//! 上記の「jump 先シーンを読み終えてもドキュメント順で後続へ読み進める」という割り切りは
//! 単一ファイル前提（#482 当時は `tui-config.toml` の `entry_script` 1本のみ読み込んでいた）
//! だった。複数の `.md` を1つの `Document` にマージする `multi_doc`（#496）以降、この割り切りを
//! 無条件に適用すると「ルート1を読み終えて次へ押し続けるとルート2の冒頭に流れ込む」という
//! リークが起きる。[`Playback::from_merged_document`] はこれを防ぐため、`items` にファイル
//! 境界の情報（`item_file_ids`）を追加で持たせ、暗黙の `advance()` だけをファイル境界で
//! 止める（選択肢ジャンプは対象外）。詳細は [`Playback`] 構造体の doc コメント参照。

use std::collections::HashMap;

use name_name_parser::models::{BgmAction, ChoiceOption, Document, Event};

use crate::sentence;

/// 画面に表示する1行分の内容（話者名 + 本文 + その時点のイベント絵）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayLine {
    /// 話者名。`Narration` イベントの場合は `None`。
    pub speaker: Option<String>,
    /// 本文（複数行）。
    pub text: Vec<String>,
    /// この会話行の時点で表示されているべきイベント絵の相対パス
    /// （`Event::EventImage { path, .. }` の `path`。`config.event_image.assets_dir` からの
    /// 相対パス）。直前に `Event::EventImage` があれば `Some`、`Event::EventImageExit` で
    /// クリアされていれば（または一度も出ていなければ）`None`。`Event::Choice` 等その他の
    /// イベント種別はこの値に影響しない（#482 スコープの Choice を含め今回も対象外）。
    pub event_image: Option<String>,
}

/// ルビ記法（`｜` / `《...》`）を除去し、ベーステキストのみを残す。
///
/// parser はルビ記法をスキーマ化せず、Dialog/Narration の `text` に生 markdown の
/// まま透過する設計（`docs/spec/markdown-v0.1.md`）。frontend は描画直前に
/// `parseRubyText()` でルビを上下二段表示にするが、tui はターミナル上でその表示が
/// 非現実的なため、ベーステキストのみを残す形で除去する。
///
/// - `｜`（U+FF5C、ルビの明示的な開始境界マーカー）は単純に除去する
/// - `《...》`（U+300A/U+300B）は開き括弧から閉じ括弧までを中身ごと丸ごと除去する
///   （例: `漢字《かんじ》` → `漢字`）
/// - 対応する `》` が見つからない不正な `《`（閉じ忘れ）は、`《` 以降の文字を
///   全て捨てて終了する（panic・無限ループしない）
/// - ネストした `《`（`《《a》b》` のような不正な記法）は非対応・未定義動作。
///   panic・無限ループはしないが、内側の `》` で読み飛ばしが終わり外側の `》` が
///   除去されずリテラルとして出力に残る（例: `《《a》b》` → `b》`）
fn strip_ruby_markup(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '｜' => {}
            '《' => {
                // 対応する '》' まで読み飛ばす。見つからなければ末尾まで捨てて終了。
                for inner in chars.by_ref() {
                    if inner == '》' {
                        break;
                    }
                }
            }
            _ => result.push(c),
        }
    }
    result
}

/// `Event` が画面に表示すべき会話行なら `DisplayLine` に変換する。
/// Dialog / Narration 以外（背景・SE・BGM・EventImage 等）は `None`。
/// `event_image` は常に `None` で返す — 呼び出し側（`Playback::from_document`）が
/// 直前までの `Event::EventImage`/`EventImageExit` 走査状態を見て上書きする。
fn display_line_from_event(event: &Event) -> Option<DisplayLine> {
    match event {
        Event::Dialog {
            character, text, ..
        } => Some(DisplayLine {
            speaker: character.clone(),
            text: text.iter().map(|line| strip_ruby_markup(line)).collect(),
            event_image: None,
        }),
        Event::Narration { text, .. } => Some(DisplayLine {
            speaker: None,
            text: text.iter().map(|line| strip_ruby_markup(line)).collect(),
            event_image: None,
        }),
        _ => None,
    }
}

/// 再生列（`Playback::items`）の1要素。Dialog/Narration は `Line`、Choice は `Choice` になる。
/// それ以外のイベント（背景・SE・BGM 等）は要素を生成しない（[`playback_item_from_event`]）。
#[derive(Debug, Clone, PartialEq)]
enum PlaybackItem {
    Line(DisplayLine),
    Choice(Vec<ChoiceOption>),
}

/// `Event` を再生列の1要素に変換する。Choice は選択肢一覧をそのまま保持する
/// `PlaybackItem::Choice` に、Dialog/Narration は [`display_line_from_event`] 経由で
/// `PlaybackItem::Line` になる。それ以外（背景・SE・BGM 等）は `None`（読み飛ばす）。
///
/// `options` が空の Choice（原稿の `[選択]\n[/選択]` のように中身が無いブロック。parser は
/// これを許容する）も `None` にして読み飛ばす。空 Choice をそのまま item 化すると、
/// `options.get(0)` が常に `None` になるため `select_current_choice` が恒久的に失敗し、
/// `advance` も Choice 表示中は拒否するため、プレイヤーの入力を一切受け付けない詰み状態に
/// なる。これは以前の「Choice を丸ごと無視していた」挙動と同じ扱いに揃えることで回避する
/// （バグ修正、実装方針は Issue #482 コメント参照）。
fn playback_item_from_event(event: &Event) -> Option<PlaybackItem> {
    match event {
        Event::Choice { options } if options.is_empty() => None,
        Event::Choice { options } => Some(PlaybackItem::Choice(options.clone())),
        _ => display_line_from_event(event).map(PlaybackItem::Line),
    }
}

/// `Document` の chapters → scenes → events を順番どおりに走査し、会話行・選択肢を再生する状態。
/// 設計の詳細（jump 解決・GUI版との違い）はモジュール冒頭のドキュメント参照（#482）。
///
/// ## ファイル境界（#496 追加スコープ）
///
/// `Playback::from_document` 単体は「単一ファイル」を前提とし、`items` 全件を同じ合成ファイル
/// id（`0`）として扱う。複数ファイルをマージした `Document`（`multi_doc::load_merged_document`）
/// から構築する場合は [`Playback::from_merged_document`] を使うと、各 item に由来ファイルの id
/// （`multi_doc::MergedDocument::chapter_file_ids` 経由）が刻まれ、`advance()` は「次の item が
/// 現在の item と異なるファイル由来」なら実行せず `is_at_end()` 相当（＝そのファイルを読み終えた
/// 扱い）にする。[`Playback::select_current_choice`] による明示的なジャンプはこの制限の対象外
/// （ジャンプ先が別ファイルでも常に成功する）— 「ルート1を読み終えて次へ押し続けるとルート2の
/// 冒頭に流れ込む」というリークを防ぎつつ、選択肢によるクロスファイル遷移（#496 の主目的）は
/// 妨げない。
pub struct Playback {
    items: Vec<PlaybackItem>,
    /// `items[i]` の由来ファイル id（`items` と同じ長さを常に保つ）。`from_document`/
    /// `from_lines` はファイル境界を知らないため全件 `0`（＝単一ファイル、境界チェックは
    /// 常に「同じファイル」判定になり実質無効化される）。`from_merged_document` だけが
    /// 複数の異なる id を持ちうる。
    item_file_ids: Vec<usize>,
    /// `items[i]` の表示時点で再生されているべき BGM のパス（`Event::Bgm`、#502）。`items` と
    /// 同じ長さを常に保つ（`item_file_ids` と同じ並行 Vec のパターン）。GUI版
    /// `AudioManager.currentBgmUrl`（`NovelRenderer.currentBgmPath`）が「現在再生されている
    /// べき BGM パス」を宣言的に持ち続けるのを、TUI では「その item が生成された時点の値を
    /// 焼き付けて持ち回る」形で再現する。`Event::Choice` item も対象に含める（除外する理由が
    /// ない）。
    item_bgm: Vec<Option<String>>,
    /// `items[i]` に到達した瞬間に一度だけ再生すべき SE のパス一覧（`Event::Se`、#502）。
    /// 直前の item から現在の item までの間に出現した `[SE:]` を出現順にすべて含む
    /// （複数の SE が連続していても取りこぼさない、通常は0〜1件）。BGM と異なり GUI版
    /// `playSe` に持続する state は無い（ワンショット）ため、`item_bgm` のような「現在位置を
    /// 問い合わせるだけの宣言的 state」ではなく、`event_loop` 側が「この item への新規到達」
    /// （[`Playback::cursor`] の変化）を検出したときに一度だけ消費するトリガとして扱う想定。
    /// ドキュメント末尾以降に出現した SE（後続 item が存在しない）は、どの item にも属せない
    /// ため再生対象にならない（既知の制約、影響は軽微）。
    item_se: Vec<Vec<String>>,
    index: usize,
    /// シーンID → そのシーンに属する最初の item の `items` 内インデックス。選択肢確定時の
    /// jump 先解決に使う（[`Playback::select_current_choice`]）。あるシーンが表示可能な item を
    /// 1つも持たない場合（背景切り替えのみ等）は、そのシーンの位置＝まだ何も push していない
    /// 時点の `items.len()`（＝後続シーンの先頭 item のインデックス、もしくは最後尾）を指す。
    scene_start: HashMap<String, usize>,
    /// 現在 Choice を表示中のときのカーソル位置（0始まり）。Line item にいる間は無視される。
    /// 新しい Choice item へ移動するたびに `set_index` が 0 へリセットする。
    choice_cursor: usize,
    /// adv を文単位（`sentence::adv_sentence_pages` 相当）で改頁するか (#486)。既定 `false`
    /// は従来どおり Line item の `text` を一括表示する（非破壊）。`with_sentence_per_page`
    /// で構築直後に設定する想定（`Config::sentence_per_page` をそのまま渡す）。
    sentence_per_page: bool,
    /// `sentence_per_page` が `true` かつ現在位置が Line item のときの、その行の文単位ページ
    /// （`sentence::adv_sentence_pages` の結果、非空 Line なら常に1要素以上）。
    /// それ以外（`sentence_per_page` が `false`、または現在位置が Choice/末尾）は空。
    sentence_pages: Vec<String>,
    /// `sentence_pages` のうち現在表示中のページ index。`sentence_pages` が空のときは無意味
    /// （`advance`/`is_at_end` はどちらも `sentence_pages` の非空チェックを先に行うため参照
    /// されない）。
    sentence_index: usize,
    /// `current_line()` が実際に返す表示内容 (#486)。`sentence_per_page` が `false` のとき
    /// は常に `None`（`current_line()` は `items` を直接参照するため未使用）。`true` の
    /// ときだけ、現在位置の Line item から `speaker`/`event_image` を引き継ぎつつ
    /// `text` を `sentence_pages[sentence_index]` の1要素に差し替えた形で保持する。
    current_display: Option<DisplayLine>,
}

impl Playback {
    /// `Document` から Dialog / Narration / Choice を抽出し、先頭に位置づけた再生状態を作る。
    /// 走査中、直近の `Event::EventImage`（表示開始）/ `EventImageExit`（退場）を
    /// `current_event_image` として追跡し、Line item として積まれる各 `DisplayLine` に
    /// その時点の値を刻む（#481）。チャプター/シーン境界をまたいでも状態は引き継がれる
    /// （`Document` 全体を単一の時系列として走査するため）。Choice item 自体はこの状態に
    /// 影響しない — Choice を挟んでも直前までの `current_event_image` はそのまま後続の
    /// Line item に引き継がれる。
    pub fn from_document(doc: &Document) -> Self {
        Self::build(doc, None)
    }

    /// [`Playback::from_document`] の複数ファイル対応版（#496 追加スコープ）。`doc` は
    /// `multi_doc::load_merged_document` が複数の `.md` をマージした `Document`、
    /// `chapter_file_ids` は同関数が返す `MergedDocument::chapter_file_ids`
    /// （`doc.chapters[i]` の由来ファイル id）をそのまま渡す想定。各 item に由来ファイルの id が
    /// 刻まれ、`advance()` がファイル境界を越える暗黙の前進を拒否するようになる（構造体の
    /// doc コメント参照）。`chapter_file_ids.len()` は常に `doc.chapters.len()` と一致する
    /// 前提（`multi_doc::merge_files` が呼び出し元として保証する）で、`build` がこの前提を
    /// `debug_assert_eq!` で検証する。前提が崩れた場合のフォールバック（対応の無いチャプターを
    /// そのチャプター自身の index で代用する）は「安全側に倒れる」わけではない点に注意 —
    /// フォールバック値（`chapter_index`）は他チャプターの明示的な file id と数値的に偶然
    /// 一致しうるため、本来張られるべき境界が消え、ファイルをまたいだ内容漏れが静かに
    /// 起こりうる（実測: `chapter_file_ids=[2,2]`、`doc.chapters.len()==3` のとき、3番目の
    /// チャプターのフォールバック値 `2` が既存の file id `2` と衝突し、全チャプターが同一
    /// ファイル扱いになって境界が機能しなくなる）。
    pub fn from_merged_document(doc: &Document, chapter_file_ids: &[usize]) -> Self {
        Self::build(doc, Some(chapter_file_ids))
    }

    /// `from_document` / `from_merged_document` 共通の構築ロジック。`chapter_file_ids` が
    /// `None` のときは全 item を単一の合成ファイル id `0` として扱う（構造体の doc コメント
    /// 参照）。`Some` のときは長さが `doc.chapters.len()` と一致する前提を `debug_assert_eq!`
    /// で検証する — 前提が崩れるとファイル境界の判定が静かに壊れうるため
    /// （[`Playback::from_merged_document`] の doc コメント参照）、デバッグビルドでは
    /// 早期に検出する。
    fn build(doc: &Document, chapter_file_ids: Option<&[usize]>) -> Self {
        if let Some(ids) = chapter_file_ids {
            debug_assert_eq!(
                ids.len(),
                doc.chapters.len(),
                "chapter_file_ids.len() は doc.chapters.len() と一致する前提（multi_doc::merge_files \
                 が保証）。不一致のまま進むとファイル境界の判定が壊れうる。"
            );
        }
        let mut items = Vec::new();
        let mut item_file_ids = Vec::new();
        let mut item_bgm = Vec::new();
        let mut item_se: Vec<Vec<String>> = Vec::new();
        let mut scene_start = HashMap::new();
        let mut current_event_image: Option<String> = None;
        let mut current_bgm: Option<String> = None;
        let mut pending_se: Vec<String> = Vec::new();
        for (chapter_index, chapter) in doc.chapters.iter().enumerate() {
            let file_id = chapter_file_ids
                .map(|ids| ids.get(chapter_index).copied().unwrap_or(chapter_index))
                .unwrap_or(0);
            for scene in &chapter.scenes {
                // このシーンの最初の item になる（はずの）位置を、events を処理する前に記録する。
                // 重複シーンIDは最初の出現を優先する（GUI版 `allScenes.find` が最初の一致を
                // 返すのと同じ規約）。
                scene_start.entry(scene.id.clone()).or_insert(items.len());
                for event in &scene.events {
                    match event {
                        // `path` の `..` は `back`（表示位置）と `fade_ms`（イベント個別の
                        // フェード時間上書き）を意図的に捨てている。`fade_ms` は TUI 側では
                        // 常に `config.event_image.crossfade_ms`（グローバル値、`main.rs` の
                        // `event_loop` 参照）しか使わない簡略化（MVPスコープ、#481）。GUI版の
                        // ようなイベント単位のフェード時間上書きは今回の対象外。
                        Event::EventImage { path, .. } => {
                            current_event_image = Some(path.clone());
                        }
                        Event::EventImageExit { .. } => {
                            current_event_image = None;
                        }
                        // GUI版 `NovelRenderer` の `'Bgm' in event` 分岐（`audioManager.playBgm`/
                        // `stopBgm`）と同じ意味論（#502）。`action === 'Play' && path` の両方が
                        // 揃わない限り「停止」扱いになる GUI版の挙動をそのまま再現する
                        // （`action: Play` でも `path: None` なら停止 — 通常の原稿では起こらない
                        // 組み合わせだが、フォールバックとして GUI版に揃える）。`fade_ms` は
                        // `Event::EventImage` の `fade_ms` と同じ理由で意図的に捨てる（TUIは
                        // フェード無しの即時切り替え、MVPスコープ）。
                        Event::Bgm { path, action, .. } => {
                            current_bgm = match (action, path) {
                                (BgmAction::Play, Some(p)) => Some(p.clone()),
                                _ => None,
                            };
                        }
                        // GUI版 `playSe` はワンショット再生で持続 state を持たないため、
                        // `current_event_image`/`current_bgm` のような「直近の値」ではなく
                        // 「次に生成される item に紐づけて後で一度だけ再生するトリガ」として
                        // 貯めておく（`item_se` の doc comment 参照、#502）。`fade_ms` は BGM と
                        // 同じ理由で捨てる。
                        Event::Se { path, .. } => {
                            pending_se.push(path.clone());
                        }
                        _ => {
                            if let Some(item) = playback_item_from_event(event) {
                                let item = match item {
                                    PlaybackItem::Line(mut line) => {
                                        line.event_image = current_event_image.clone();
                                        PlaybackItem::Line(line)
                                    }
                                    choice @ PlaybackItem::Choice(_) => choice,
                                };
                                items.push(item);
                                item_file_ids.push(file_id);
                                item_bgm.push(current_bgm.clone());
                                item_se.push(std::mem::take(&mut pending_se));
                            }
                        }
                    }
                }
            }
        }
        Self {
            items,
            item_file_ids,
            item_bgm,
            item_se,
            index: 0,
            scene_start,
            choice_cursor: 0,
            sentence_per_page: false,
            sentence_pages: Vec::new(),
            sentence_index: 0,
            current_display: None,
        }
    }

    /// 文単位改頁（adv の 1 ページ＝1 文、#486）を有効/無効にする。`Playback::from_document`
    /// / [`Playback::from_lines`] 直後に連結して呼ぶ想定
    /// （`Playback::from_document(&doc).with_sentence_per_page(config.sentence_per_page)`）。
    /// 呼んだ時点の現在位置に対して即座にページ分割を反映する（構築直後でも `current_line`
    /// が最初のページだけを返すようになる）。
    pub fn with_sentence_per_page(mut self, enabled: bool) -> Self {
        self.sentence_per_page = enabled;
        self.sync_sentence_pages();
        self
    }

    /// `sentence_per_page` の設定と現在位置（`self.index`）から `sentence_pages` /
    /// `sentence_index` / `current_display` を再計算する。現在位置が変わるたび
    /// （[`Playback::set_index`]）と、`sentence_per_page` の設定が変わるたび
    /// （[`Playback::with_sentence_per_page`]）に呼ぶ。
    fn sync_sentence_pages(&mut self) {
        self.sentence_pages = Vec::new();
        self.sentence_index = 0;
        self.current_display = None;
        if !self.sentence_per_page {
            return;
        }
        let Some(PlaybackItem::Line(line)) = self.items.get(self.index) else {
            return;
        };
        let pages = sentence::adv_sentence_pages(&line.text);
        // `adv_sentence_pages` は常に非空（空入力でも `[""]` を返す）ため `pages[0]` は安全。
        self.current_display = Some(DisplayLine {
            speaker: line.speaker.clone(),
            text: vec![pages[0].clone()],
            event_image: line.event_image.clone(),
        });
        self.sentence_pages = pages;
    }

    /// 現在位置を更新する内部ヘルパー。新しい位置が Choice item であっても無くても、
    /// カーソルは常に 0 にリセットする（Line item に対しては無視されるだけなので無害。
    /// こうしておくことで「以前の Choice で選んでいたカーソル位置が、無関係な次の Choice に
    /// 引き継がれる」事故を型的に起こしえなくする）。新しい位置の文単位ページも同時に
    /// 再計算する（#486、`sync_sentence_pages`）。
    fn set_index(&mut self, index: usize) {
        self.index = index;
        self.choice_cursor = 0;
        self.sync_sentence_pages();
    }

    /// 現在位置の item に紐づく BGM 状態（`Event::Bgm`、#502）。GUI版
    /// `AudioManager.currentBgmUrl` と同じ「現在再生されているべき BGM パス」を表す宣言的
    /// state。`items` が空、または現在位置が末尾を過ぎている場合は `None`（＝BGM無し）。
    /// `event_loop` 側はフレームごとにこの値を前フレームの値と比較し、変化していれば
    /// 再生中の BGM を切り替える（`item_bgm` の doc comment 参照）。
    pub fn current_bgm(&self) -> Option<&str> {
        self.item_bgm.get(self.index).and_then(|b| b.as_deref())
    }

    /// 現在位置の item に到達した際に一度だけ再生すべき SE のパス一覧（`Event::Se`、#502）。
    /// `items` が空、または現在位置が末尾を過ぎている場合は空スライス。呼び出し側
    /// （`event_loop`）は [`Playback::cursor`] の変化（＝この item への新規到達）を検出した
    /// ときだけ、この一覧を消費して1回だけ再生する想定（`item_se` の doc comment 参照）。
    pub fn current_se_cues(&self) -> &[String] {
        self.item_se
            .get(self.index)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// 内部カーソル（`items` 内の生インデックス）。SE のワンショット再生を `event_loop` 側で
    /// 「新しい item に到達した瞬間」として検出するための識別子として公開する（#502）。
    /// [`Playback::position`]（Line item のみを数える会話行番号）と異なり、Choice item への
    /// 遷移でも変化する。一方、`sentence_per_page` による同一 Line item 内の文送りでは
    /// 変化しない（`self.index` 自体は動かないため）— 同じ item に紐づく SE を文送りのたびに
    /// 再トリガーしない、という意図した挙動でもある。値そのものに意味的な使い道は無く、
    /// 前フレームとの比較にのみ使う想定。
    pub fn cursor(&self) -> usize {
        self.index
    }

    /// 現在位置の会話行。現在位置が Choice item、会話行が1件もない、または末尾を過ぎている
    /// 場合は `None`。`sentence_per_page` が有効なときは、Line item の全文ではなく現在の
    /// 文単位ページ（`current_display`）だけを返す (#486)。
    pub fn current_line(&self) -> Option<&DisplayLine> {
        if self.sentence_per_page {
            return self.current_display.as_ref();
        }
        match self.items.get(self.index) {
            Some(PlaybackItem::Line(line)) => Some(line),
            _ => None,
        }
    }

    /// 現在位置が選択肢なら `(選択肢一覧, カーソル位置)` を返す。会話行の途中や末尾越えでは
    /// `None`。
    pub fn current_choice(&self) -> Option<(&[ChoiceOption], usize)> {
        match self.items.get(self.index) {
            Some(PlaybackItem::Choice(options)) => Some((options.as_slice(), self.choice_cursor)),
            _ => None,
        }
    }

    /// 次の item へ進む。現在位置が選択肢（選択待ち）の場合は、[`Playback::select_current_choice`]
    /// で確定する必要があるため進めず `false` を返す。既に末尾にいた場合も `false`。
    ///
    /// `sentence_per_page` が有効で、現在の Line item にまだ表示していない文単位ページが
    /// 残っている場合は、`items` 内の位置（`self.index`）を動かさずページだけ1つ進める
    /// (#486)。次の item への遷移（`set_index`）は、現在行の全ページを表示し終えたときだけ
    /// 起こる — GUI版 `getAdvSentencePages` が「1 Event = 複数ページ」に分割するのと同じ
    /// 粒度を、既存の「1 advance = 1手前進」という状態遷移にそのまま重ねる形。
    ///
    /// 次の item が現在の item と異なるファイル由来（#496、`item_file_ids` 参照）の場合は、
    /// 位置を変えず `false` を返す — フラット化済み `items` 上ではドキュメント順で後続に
    /// 存在していても、暗黙の前進では別ファイルの内容へ進めない。ファイルをまたぐ遷移は
    /// [`Playback::select_current_choice`] による明示的な選択肢ジャンプでのみ許可される。
    pub fn advance(&mut self) -> bool {
        if matches!(self.items.get(self.index), Some(PlaybackItem::Choice(_))) {
            return false;
        }
        if self.sentence_per_page && self.sentence_index + 1 < self.sentence_pages.len() {
            self.sentence_index += 1;
            if let Some(display) = self.current_display.as_mut() {
                display.text = vec![self.sentence_pages[self.sentence_index].clone()];
            }
            return true;
        }
        if self.index + 1 < self.items.len() {
            if self.item_file_ids[self.index + 1] != self.item_file_ids[self.index] {
                return false;
            }
            self.set_index(self.index + 1);
            true
        } else {
            false
        }
    }

    /// 選択肢表示中のみ有効。カーソルを1つ上へ動かす（先頭で頭打ち、末尾へのラップはしない）。
    /// 選択肢を表示していないときの呼び出しは no-op。
    pub fn move_choice_cursor_up(&mut self) {
        if matches!(self.items.get(self.index), Some(PlaybackItem::Choice(_))) {
            self.choice_cursor = self.choice_cursor.saturating_sub(1);
        }
    }

    /// 選択肢表示中のみ有効。カーソルを1つ下へ動かす（末尾で頭打ち、先頭へのラップはしない）。
    /// 選択肢を表示していないときの呼び出しは no-op。
    pub fn move_choice_cursor_down(&mut self) {
        if let Some(PlaybackItem::Choice(options)) = self.items.get(self.index) {
            if self.choice_cursor + 1 < options.len() {
                self.choice_cursor += 1;
            }
        }
    }

    /// 現在カーソルが指している選択肢を確定し、その `jump` 先シーンへ遷移する。
    ///
    /// 選択肢を表示していない場合、カーソルが範囲外の場合（本来起こり得ないが防御的に）、
    /// または `jump` 先のシーンIDが `scene_start` に見つからない場合（原稿の記述ミスで
    /// 存在しないシーンIDを指している等）は、位置を変えずに `false` を返す。GUI版
    /// `NovelRenderer.jumpToScene` の「シーンが見つからなければ何もせず console.warn するだけ」
    /// という fail-soft 方針と同じだが、TUI は alternate screen 中で標準出力を使えないため
    /// 警告そのものは出さない（呼び出し側が `false` を見て何もしない、という形で吸収する）。
    pub fn select_current_choice(&mut self) -> bool {
        let Some(PlaybackItem::Choice(options)) = self.items.get(self.index) else {
            return false;
        };
        let Some(option) = options.get(self.choice_cursor) else {
            return false;
        };
        let Some(&target) = self.scene_start.get(&option.jump) else {
            return false;
        };
        self.set_index(target);
        true
    }

    /// 会話行の総数（Choice item は含まない）。
    pub fn total(&self) -> usize {
        self.items
            .iter()
            .filter(|item| matches!(item, PlaybackItem::Line(_)))
            .count()
    }

    /// 現在位置が何行目か（1始まり、Choice item は含まない）。現在位置が Choice の場合は、
    /// そこに至るまでに表示済みの会話行数を返す（例: 3行しゃべった直後に選択肢が出ている
    /// 状態なら3を返す）。
    pub fn position(&self) -> usize {
        // `self.items[..=self.index]` だと `index == items.len()`（ジャンプ先シーンが
        // イベント0件かつドキュメント末尾のとき `scene_start` がこの値を取り得る、
        // `select_current_choice` 参照）のとき範囲外アクセスで panic する。`take` は
        // `index` が範囲外でも自動的に全要素で打ち切られるため安全（「ドキュメント末尾を
        // 超えた位置」＝「全会話行を読み終えた」なので、全 Line 数を返すのは意味的にも
        // 正しい）。
        self.items
            .iter()
            .take(self.index.saturating_add(1))
            .filter(|item| matches!(item, PlaybackItem::Line(_)))
            .count()
    }

    /// 末尾（最後の item）に到達しているか。現在位置が未選択の Choice の場合は、
    /// それがドキュメント上の最後の item であってもプレイヤーはまだ何も選んでおらず
    /// 物語は終わっていないため常に `false`（[`Playback::current_choice`] を流用）。
    /// これを見落とすと、`ui::draw_status_line` が画面下部に `(END)` を出しつつ右側では
    /// 選択肢メニューが入力待ちで表示される、という矛盾した見た目になる。
    ///
    /// `sentence_per_page` が有効で、現在の Line item にまだ表示していない文単位ページが
    /// 残っている場合も同様に `false` にする (#486) — それがドキュメント最後の item でも、
    /// プレイヤーはまだ最後の文を読み切っていないため。
    ///
    /// 次の item が現在の item と異なるファイル由来（#496）の場合も `true` を返す —
    /// `advance()` がそこへは進めない（ファイル境界を暗黙には越えられない）ため、意味的には
    /// 「このファイルの内容を読み終えた」のと同じ状態として扱う。
    pub fn is_at_end(&self) -> bool {
        if self.current_choice().is_some() {
            return false;
        }
        if self.sentence_per_page && self.sentence_index + 1 < self.sentence_pages.len() {
            return false;
        }
        if self.items.is_empty() || self.index + 1 >= self.items.len() {
            return true;
        }
        self.item_file_ids[self.index + 1] != self.item_file_ids[self.index]
    }

    /// テスト専用: 会話行リストから直接 `Playback` を組み立てる。`main.rs` の
    /// `on_advance` テストなどで、`Document`（20個のフィールドを埋める必要がある）経由の
    /// 冗長なフィクスチャ構築を避けるために使う（#472）。選択肢を含む状態遷移のテストは
    /// `Document` 経由（`from_document`、`scene_start` の構築が必要なため）で行う。
    #[cfg(test)]
    pub(crate) fn from_lines(lines: Vec<DisplayLine>) -> Self {
        let item_file_ids = vec![0; lines.len()];
        let item_bgm = vec![None; lines.len()];
        let item_se = vec![Vec::new(); lines.len()];
        Self {
            items: lines.into_iter().map(PlaybackItem::Line).collect(),
            item_file_ids,
            item_bgm,
            item_se,
            index: 0,
            scene_start: HashMap::new(),
            choice_cursor: 0,
            sentence_per_page: false,
            sentence_pages: Vec::new(),
            sentence_index: 0,
            current_display: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use name_name_parser::models::{BgmAction, Chapter, ChoiceOption, Scene, SceneView};
    use std::collections::HashMap;

    #[test]
    fn strip_ruby_markup_removes_basic_ruby() {
        assert_eq!(strip_ruby_markup("漢字《かんじ》です"), "漢字です");
    }

    #[test]
    fn strip_ruby_markup_removes_explicit_boundary_marker() {
        assert_eq!(
            strip_ruby_markup("｜美少女《びしょうじょ》が微笑む"),
            "美少女が微笑む"
        );
    }

    #[test]
    fn strip_ruby_markup_leaves_plain_text_unchanged() {
        assert_eq!(strip_ruby_markup("こんにちは"), "こんにちは");
    }

    #[test]
    fn strip_ruby_markup_removes_lone_pipes_without_ruby_body() {
        assert_eq!(strip_ruby_markup("｜A｜B"), "AB");
    }

    #[test]
    fn strip_ruby_markup_removes_multiple_rubies_in_one_line() {
        assert_eq!(
            strip_ruby_markup("今日《きょう》は良い天気《てんき》だ"),
            "今日は良い天気だ"
        );
    }

    #[test]
    fn strip_ruby_markup_unclosed_bracket_discards_rest_without_panicking() {
        assert_eq!(strip_ruby_markup("これは《閉じられない"), "これは");
    }

    /// `Document` の非 chapters フィールドを全て無害な既定値で埋めるヘルパー。
    /// Document は Default を derive していないため、テストごとに20個のフィールドを
    /// 書き下ろすのを避けるためにここに1箇所だけ用意する。
    fn document_with_chapters(chapters: Vec<Chapter>) -> Document {
        Document {
            engine: "test".to_string(),
            aspect_ratio: "16:9".to_string(),
            choice_style: None,
            font_family: None,
            font_size: None,
            dialog_style: None,
            protagonist: None,
            character_y_ratio: None,
            character_height_ratio: None,
            character_height_ratios: HashMap::new(),
            character_scale: None,
            character_fade_ms: None,
            background_fade_ms: None,
            event_image_fade_ms: None,
            background_color: None,
            skip_enabled: None,
            debug_enabled: None,
            speaker_nudge: None,
            auto_play: None,
            seekbar_color: None,
            split_layout: None,
            sentence_per_page: None,
            pixel_art: None,
            chapters,
        }
    }

    fn chapter(number: u32, scenes: Vec<Scene>) -> Chapter {
        Chapter {
            number,
            title: "chapter".to_string(),
            hidden: false,
            default_bgm: None,
            scenes,
        }
    }

    fn scene(id: &str, events: Vec<Event>) -> Scene {
        Scene {
            id: id.to_string(),
            title: "scene".to_string(),
            view: SceneView::TopDown,
            events,
        }
    }

    fn dialog(character: Option<&str>, text: Vec<&str>) -> Event {
        Event::Dialog {
            character: character.map(|s| s.to_string()),
            expression: None,
            position: None,
            text: text.into_iter().map(|s| s.to_string()).collect(),
            voice_path: None,
            font_family: None,
            fit: false,
        }
    }

    fn narration(text: Vec<&str>) -> Event {
        Event::Narration {
            text: text.into_iter().map(|s| s.to_string()).collect(),
            voice_path: None,
            font_family: None,
        }
    }

    fn event_image(path: &str) -> Event {
        Event::EventImage {
            path: path.to_string(),
            back: name_name_parser::models::EventImageBack::default(),
            fade_ms: None,
        }
    }

    fn event_image_exit() -> Event {
        Event::EventImageExit { fade_ms: None }
    }

    /// 単一チャプター・単一シーンに `events` を並べた `Document` を作る。
    fn doc_single_scene(events: Vec<Event>) -> Document {
        document_with_chapters(vec![chapter(1, vec![scene("1-1", events)])])
    }

    #[test]
    fn dialog_with_character_produces_correct_display_line() {
        let doc = doc_single_scene(vec![dialog(Some("カコ"), vec!["やあ"])]);
        let pb = Playback::from_document(&doc);
        let line = pb.current_line().expect("should have a line");
        assert_eq!(line.speaker.as_deref(), Some("カコ"));
        assert_eq!(line.text, vec!["やあ".to_string()]);
    }

    #[test]
    fn narration_only_has_none_speaker() {
        let doc = doc_single_scene(vec![narration(vec!["静かな朝だった。"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_line().expect("line").speaker, None);
    }

    #[test]
    fn dialog_without_character_has_none_speaker() {
        let doc = doc_single_scene(vec![dialog(None, vec!["誰？"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_line().expect("line").speaker, None);
    }

    #[test]
    fn empty_text_events_produce_empty_display_line_text() {
        let doc = doc_single_scene(vec![dialog(Some("カコ"), vec![]), narration(vec![])]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 2);
        assert_eq!(pb.current_line().expect("line").text, Vec::<String>::new());
        pb.advance();
        assert_eq!(pb.current_line().expect("line").text, Vec::<String>::new());
    }

    #[test]
    fn non_display_events_are_excluded_but_choice_still_produces_an_item() {
        // Background/Bgm/Se は依然として画面表示イベントではないため items を生成しない。
        // Choice は #482 で「読み飛ばし」対象から外れ、独立した item になった（以前は他の
        // 非表示イベントと同様に丸ごと無視されており、選択肢が一切機能しない原因だった）。
        let doc = doc_single_scene(vec![
            Event::Background {
                path: "bg.png".to_string(),
                fade_top: None,
                fade_bottom: None,
                fade_left: None,
                fade_right: None,
                brightness: None,
            },
            Event::Bgm {
                path: Some("bgm.ogg".to_string()),
                action: BgmAction::Play,
                fade_ms: None,
            },
            Event::Se {
                path: "se.ogg".to_string(),
                fade_ms: None,
            },
            Event::Choice {
                options: vec![ChoiceOption {
                    text: "yes".to_string(),
                    jump: "1-2".to_string(),
                }],
            },
            dialog(Some("カコ"), vec!["こんにちは"]),
        ]);
        let pb = Playback::from_document(&doc);
        // 会話行としては dialog の1件だけがカウントされる（Choice は数えない）。
        assert_eq!(pb.total(), 1);
        // 再生位置としては Choice が最初の item になるため、いきなり選択肢が現れる。
        assert_eq!(pb.current_line(), None);
        let (options, cursor) = pb.current_choice().expect("choice should be current");
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].text, "yes");
        assert_eq!(cursor, 0);
    }

    #[test]
    fn zero_events_playback_has_no_current_and_is_at_end() {
        let doc = doc_single_scene(vec![]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_line(), None);
        assert_eq!(pb.position(), 0);
        assert_eq!(pb.total(), 0);
        assert!(pb.is_at_end());
    }

    #[test]
    fn single_event_playback_position_and_end_state() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["hi"])]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.position(), 1);
        assert_eq!(pb.total(), 1);
        assert!(pb.is_at_end());
        assert!(!pb.advance());
        assert_eq!(pb.position(), 1);
    }

    #[test]
    fn advance_before_last_line_moves_forward() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.position(), 1);
        assert_eq!(pb.total(), 2);
        assert!(!pb.is_at_end());
        assert!(pb.advance());
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn advance_at_last_line_returns_false_and_stays() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // move to the last line (index 1)
        assert_eq!(pb.position(), 2);
        assert!(pb.is_at_end());
        assert!(!pb.advance());
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn advance_past_end_is_idempotent() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // to the last line
        assert!(!pb.advance()); // first call at end
        assert!(!pb.advance()); // second call, still false and unchanged
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn advance_through_three_lines_reaches_end_in_order() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
            dialog(Some("C"), vec!["3"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(!pb.is_at_end());
        assert!(pb.advance());
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(!pb.is_at_end());
        assert!(pb.advance());
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("C")
        );
        assert!(pb.is_at_end());
    }

    #[test]
    fn playback_preserves_order_across_chapters_and_scenes() {
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![dialog(Some("A"), vec!["ch1-scene1"])]),
                scene("1-2", vec![dialog(Some("B"), vec!["ch1-scene2"])]),
            ],
        );
        let ch2 = chapter(
            2,
            vec![scene("2-1", vec![dialog(Some("C"), vec!["ch2-scene1"])])],
        );
        let doc = document_with_chapters(vec![ch1, ch2]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 3);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["ch1-scene1".to_string()]
        );
        pb.advance();
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["ch1-scene2".to_string()]
        );
        pb.advance();
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["ch2-scene1".to_string()]
        );
    }

    #[test]
    fn zero_scenes_or_zero_events_do_not_affect_line_count() {
        let populated = chapter(
            1,
            vec![
                scene("empty-scene", vec![]),
                scene("real-scene", vec![dialog(Some("A"), vec!["hi"])]),
            ],
        );
        let empty_chapter = Chapter {
            number: 2,
            title: "empty".to_string(),
            hidden: false,
            default_bgm: None,
            scenes: vec![],
        };
        let doc = document_with_chapters(vec![populated, empty_chapter]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 1);
    }

    // ---- #482: 選択肢分岐（Choice / jump 解決）のテスト ----

    fn choice(options: Vec<(&str, &str)>) -> Event {
        Event::Choice {
            options: options
                .into_iter()
                .map(|(text, jump)| ChoiceOption {
                    text: text.to_string(),
                    jump: jump.to_string(),
                })
                .collect(),
        }
    }

    /// 2シーン構成: "1-1" は台詞→Choice（"1-2" へ jump）、"1-2" は台詞1件だけ。
    fn two_scene_doc_with_choice() -> Document {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "1-2")]),
                    ],
                ),
                scene("1-2", vec![dialog(Some("B"), vec!["次のシーン"])]),
            ],
        );
        document_with_chapters(vec![ch1])
    }

    #[test]
    fn select_current_choice_jumps_to_target_scene_start() {
        let doc = two_scene_doc_with_choice();
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "台詞から Choice へ進めるはず");
        assert!(pb.current_choice().is_some(), "Choice が現在位置のはず");

        assert!(
            pb.select_current_choice(),
            "有効な jump 先なので成功するはず"
        );

        assert_eq!(
            pb.current_line().expect("jump先の台詞").speaker.as_deref(),
            Some("B")
        );
        assert_eq!(pb.current_choice(), None, "jump後はChoiceではないはず");
    }

    #[test]
    fn select_current_choice_with_unknown_jump_target_is_noop() {
        let ch1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![choice(vec![("存在しない先へ", "does-not-exist")])],
            )],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.current_choice().is_some());

        assert!(
            !pb.select_current_choice(),
            "存在しないシーンIDへのjumpは失敗するはず"
        );
        assert!(
            pb.current_choice().is_some(),
            "失敗時は選択肢表示のまま変わらないはず"
        );
    }

    #[test]
    fn move_choice_cursor_clamps_at_both_ends_without_wrapping() {
        let ch1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![choice(vec![("A", "x"), ("B", "y"), ("C", "z")])],
            )],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        // 先頭でさらに上へ: 0 のまま。
        pb.move_choice_cursor_up();
        assert_eq!(pb.current_choice().unwrap().1, 0);

        pb.move_choice_cursor_down();
        pb.move_choice_cursor_down();
        assert_eq!(pb.current_choice().unwrap().1, 2, "末尾(index 2)まで進む");

        // 末尾でさらに下へ: 2 のまま（3 へラップ/オーバーフローしない）。
        pb.move_choice_cursor_down();
        assert_eq!(pb.current_choice().unwrap().1, 2);
    }

    #[test]
    fn advance_while_choice_is_current_does_not_move() {
        let doc = two_scene_doc_with_choice();
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // 台詞 → Choice
        assert!(pb.current_choice().is_some());

        assert!(
            !pb.advance(),
            "Choice表示中の advance は select_current_choice を使うべきなので false"
        );
        assert!(pb.current_choice().is_some(), "位置が変わっていないはず");
    }

    // ---- バグ修正の回帰テスト（実装バグ2件） ----

    #[test]
    fn position_after_jumping_into_zero_item_last_scene_does_not_panic() {
        // "1-1": 台詞 + Choice("1-2"へjump)。"1-2": イベント0件かつ最終シーン。
        // 旧実装は select_current_choice で index を items.len()（範囲外）へ設定した後、
        // position() の `items[..=index]` が範囲外アクセスで panic していた（バグ1）。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "1-2")]),
                    ],
                ),
                scene("1-2", vec![]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // 台詞 → Choice
        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");

        // ここで panic しないことを確認する（バグ1の回帰）。
        let position = pb.position();
        assert_eq!(
            position, 1,
            "ジャンプ先が0件シーンでも、それまでの全Line数(1)を返すはず"
        );
    }

    #[test]
    fn position_after_jumping_into_zero_item_non_last_scene_falls_through_to_next_scene_content() {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "1-2")]),
                    ],
                ),
                scene("1-2", vec![]), // イベント0件だが最終シーンではない
                scene("1-3", vec![dialog(Some("B"), vec!["1-3の台詞"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        pb.advance();
        assert!(pb.select_current_choice());

        // "1-2" は表示可能な item を1つも持たないため、jump先の位置は実質的に
        // 後続シーン "1-3" の先頭 item と同じインデックスになり、そのまま "1-3" の
        // 内容が現れる（シーン境界を越えてドキュメント順に読み進める設計、モジュール
        // 冒頭のドキュメント参照）。
        assert_eq!(
            pb.current_line().expect("1-3の台詞").text,
            vec!["1-3の台詞".to_string()]
        );
    }

    #[test]
    fn is_at_end_true_when_jump_lands_on_out_of_bounds_index_of_zero_item_scene() {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "1-2")]),
                    ],
                ),
                scene("1-2", vec![]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        pb.advance();
        assert!(pb.select_current_choice());

        assert!(
            pb.is_at_end(),
            "0件シーンへのjumpは実質ドキュメント末尾として扱われるはず"
        );
    }

    #[test]
    fn choice_with_empty_options_is_skipped_like_absent_choice() {
        // parser は `[選択]\n[/選択]`（中身が空）のような options: [] の Choice を許容する。
        // これを item 化してしまうと select_current_choice が常に失敗し、advance も
        // Choice表示中は拒否するため、入力を一切受け付けない詰み状態になっていた（バグ2）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["どうする？"]),
            Event::Choice { options: vec![] },
            dialog(Some("B"), vec!["次のセリフ"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(
            pb.current_choice(),
            None,
            "空Choiceはitem化されず最初から現れないはず"
        );
        assert_eq!(
            pb.current_line().expect("最初の台詞").speaker.as_deref(),
            Some("A")
        );

        assert!(pb.advance(), "空Choiceを飛び越えて次の台詞に進めるはず");
        assert_eq!(
            pb.current_choice(),
            None,
            "advance後もChoiceは一度も現れないはず"
        );
        assert_eq!(
            pb.current_line().expect("次の台詞").speaker.as_deref(),
            Some("B")
        );
    }

    #[test]
    fn move_choice_cursor_up_down_are_noop_when_single_option() {
        let ch1 = chapter(
            1,
            vec![scene("1-1", vec![choice(vec![("唯一の選択肢", "x")])])],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        pb.move_choice_cursor_up();
        assert_eq!(pb.current_choice().unwrap().1, 0);

        pb.move_choice_cursor_down();
        assert_eq!(
            pb.current_choice().unwrap().1,
            0,
            "選択肢が1件のみなら↓してもカーソルは動かないはず"
        );
    }

    #[test]
    fn select_current_choice_supports_backward_jump_to_earlier_scene() {
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![dialog(Some("A"), vec!["最初のシーン"])]),
                scene(
                    "1-2",
                    vec![
                        dialog(Some("B"), vec!["2番目のシーン"]),
                        choice(vec![("戻る", "1-1")]),
                    ],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // "1-1"の台詞 → "1-2"の台詞
        pb.advance(); // "1-2"の台詞 → Choice
        assert!(pb.current_choice().is_some());

        assert!(
            pb.select_current_choice(),
            "現在シーンより前のシーンへのjumpも成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("戻り先の台詞").text,
            vec!["最初のシーン".to_string()]
        );
    }

    // ---- セルフレビュー指摘の回帰テスト（PR #484 should）----

    #[test]
    fn is_at_end_is_false_while_unselected_choice_is_displayed_even_at_document_end() {
        // ドキュメント最終シーンの最後の item が（空でない）Choice のケース。旧実装は
        // アイテム種別を見ずに「最後の item にいるか」だけで判定していたため、プレイヤーが
        // まだ何も選んでいない＝物語が終わっていない状態でも is_at_end が true を返し、
        // `ui::draw_status_line` が (END) を表示する一方で選択肢メニューも入力待ちで表示
        // される、という矛盾したUIになっていた。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["どうする？"]),
            choice(vec![("進む", "1-1")]),
        ]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // 台詞 → Choice（ドキュメント最後の item）
        assert!(pb.current_choice().is_some(), "Choice が現在位置のはず");

        assert!(
            !pb.is_at_end(),
            "未選択のChoiceを表示中は、それがドキュメント末尾でも終端扱いしてはいけない"
        );
    }

    // ---- #481: EventImage / EventImageExit の event_image 追跡 ----

    #[test]
    fn lines_before_any_event_image_have_none() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["前"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_line().expect("line").event_image, None);
    }

    #[test]
    fn dialog_after_event_image_carries_its_path() {
        let doc = doc_single_scene(vec![
            event_image("props/candle.webp"),
            dialog(Some("A"), vec!["後"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/candle.webp")
        );
    }

    #[test]
    fn event_image_exit_clears_path_for_subsequent_lines() {
        let doc = doc_single_scene(vec![
            event_image("props/candle.webp"),
            dialog(Some("A"), vec!["表示中"]),
            event_image_exit(),
            dialog(Some("A"), vec!["退場後"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/candle.webp")
        );
        pb.advance();
        assert_eq!(pb.current_line().expect("line").event_image, None);
    }

    #[test]
    fn later_event_image_replaces_the_previous_one() {
        let doc = doc_single_scene(vec![
            event_image("props/a.webp"),
            dialog(Some("A"), vec!["1"]),
            event_image("props/b.webp"),
            dialog(Some("A"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/a.webp")
        );
        pb.advance();
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/b.webp")
        );
    }

    #[test]
    fn event_image_state_persists_across_scene_and_chapter_boundaries() {
        let ch1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![
                    event_image("props/candle.webp"),
                    dialog(Some("A"), vec!["ch1"]),
                ],
            )],
        );
        let ch2 = chapter(2, vec![scene("2-1", vec![dialog(Some("B"), vec!["ch2"])])]);
        let doc = document_with_chapters(vec![ch1, ch2]);
        let mut pb = Playback::from_document(&doc);
        pb.advance();
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/candle.webp"),
            "イベント絵の状態はチャプター境界をまたいでも引き継がれる"
        );
    }

    #[test]
    fn choice_event_does_not_affect_event_image_state() {
        // Choice を挟んでも event_image はリセットされず、jump 先の Line item にも
        // 引き継がれることを確認する（#482 で Choice が item 化された後の回帰確認）。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        event_image("props/candle.webp"),
                        Event::Choice {
                            options: vec![ChoiceOption {
                                text: "yes".to_string(),
                                jump: "1-2".to_string(),
                            }],
                        },
                    ],
                ),
                scene("1-2", vec![dialog(Some("A"), vec!["後"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.current_choice().is_some(), "Choice が現在位置のはず");

        assert!(
            pb.select_current_choice(),
            "有効な jump 先なので成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/candle.webp"),
            "Choiceはevent_image状態を変更しない（#482スコープ外）"
        );
    }

    // ---- #486: sentence_per_page（adv の文単位改頁） ----

    fn dline(speaker: Option<&str>, text: Vec<&str>) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: text.into_iter().map(|s| s.to_string()).collect(),
            event_image: None,
        }
    }

    #[test]
    fn sentence_per_page_disabled_by_default_shows_full_line_unchanged() {
        // with_sentence_per_page を呼ばなければ既定 false（非破壊）。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["最初の文。次の文。"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["最初の文。次の文。".to_string()]
        );
    }

    #[test]
    fn sentence_per_page_enabled_shows_only_first_sentence() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["最初の文。次の文。"])]);
        let pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["最初の文。".to_string()]
        );
    }

    #[test]
    fn sentence_per_page_advance_moves_to_next_sentence_without_changing_position() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["最初の文。次の文。"])]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(pb.position(), 1);
        assert!(pb.advance(), "同じLine item内の次の文へ進めるはず");
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["次の文。".to_string()]
        );
        // 同じ Line item 内の文送りは「会話行数」のカウントを進めない（#486、判断メモ:
        // position/total は Line item 単位のまま据え置く設計）。
        assert_eq!(pb.position(), 1);
    }

    #[test]
    fn sentence_per_page_advance_after_last_sentence_moves_to_next_item() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1文目。2文目。"]),
            dialog(Some("B"), vec!["次の話者。"]),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.advance(), "1文目 -> 2文目");
        assert!(pb.advance(), "2文目(最後) -> 次のitem");
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["次の話者。".to_string()]
        );
        assert_eq!(
            pb.position(),
            2,
            "itemが進んだのでLine item単位のカウントは増える"
        );
    }

    #[test]
    fn sentence_per_page_is_at_end_false_while_sentences_remain_on_last_line() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["1文目。2文目。"])]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(
            !pb.is_at_end(),
            "最初の文を表示中でまだ2文目が残っているので終端ではない"
        );
        assert!(pb.advance());
        assert!(pb.is_at_end(), "最後の文まで表示し終えたら終端");
    }

    #[test]
    fn sentence_per_page_event_image_preserved_across_sentence_pages() {
        let doc = doc_single_scene(vec![
            event_image("props/candle.webp"),
            dialog(Some("A"), vec!["1文目。2文目。"]),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/candle.webp")
        );
        pb.advance();
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("props/candle.webp"),
            "文送りの間もevent_imageは変わらない"
        );
    }

    #[test]
    fn sentence_per_page_empty_text_dialog_shows_single_empty_page() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec![])]);
        let pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(pb.current_line().expect("line").text, vec!["".to_string()]);
    }

    #[test]
    fn sentence_per_page_narration_pause_element_becomes_its_own_blank_page() {
        // parser の `>` 単独行由来の空文字要素（#448 バグ2）は、文単位ページでも独立した
        // 空白ポーズページとして残らなければならない。
        let doc = doc_single_scene(vec![narration(vec![
            "最初のグループ。",
            "",
            "次のグループ。",
        ])]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["最初のグループ。".to_string()]
        );
        assert!(pb.advance());
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["".to_string()],
            "`>` 単独行由来の空白ポーズページ"
        );
        assert!(!pb.is_at_end(), "空白ポーズページの後にまだ文が残っている");
        assert!(pb.advance());
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["次のグループ。".to_string()]
        );
        assert!(pb.is_at_end());
    }

    #[test]
    fn sentence_per_page_choice_jump_paginates_target_scenes_first_sentence() {
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![choice(vec![("進む", "1-2")])]),
                scene("1-2", vec![dialog(Some("B"), vec!["1文目。2文目。"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["1文目。".to_string()],
            "jump先の最初の文だけが表示される"
        );
    }

    #[test]
    fn sentence_per_page_total_counts_line_items_not_sentence_pages() {
        // total()/position() は文送りの粒度ではなく Line item 単位のまま据え置く設計
        // （#486、実装中の判断メモ）。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["1文目。2文目。3文目。"])]);
        let pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(pb.total(), 1);
    }

    #[test]
    fn sentence_per_page_from_lines_builder_applies_pagination() {
        // from_lines（テスト専用コンストラクタ）経由でも with_sentence_per_page が効くことを
        // 確認する（main.rs のテストがこの組み合わせに依存するため）。
        let mut pb = Playback::from_lines(vec![dline(Some("A"), vec!["最初の文。次の文。"])])
            .with_sentence_per_page(true);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["最初の文。".to_string()]
        );
        assert!(pb.advance());
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["次の文。".to_string()]
        );
    }

    // ---- #486 追補: Line item 内の文送り状態遷移の交差点（デシジョンテーブルで判明した穴）----

    #[test]
    fn sentence_per_page_single_sentence_line_advances_directly_to_next_item() {
        // sentence_pages.len() == 1 の境界: `advance` の `sentence_index + 1 <
        // sentence_pages.len()` が `1 < 1` で偽に倒れ、最初の advance 呼び出しだけで items 内
        // 移動の分岐へ直接フォールスルーすることを確認する（1文だけの Line item の直後に
        // 別の Line item が続く文書）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["これだけの文。"]),
            dialog(Some("B"), vec!["次のitem。"]),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert_eq!(pb.position(), 1);

        assert!(
            pb.advance(),
            "1文だけのLineは最初のadvanceで即座に次itemへ進むはず"
        );
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert_eq!(
            pb.position(),
            2,
            "item自体が進んだのでLine item単位のカウントも増える"
        );
    }

    #[test]
    fn sentence_per_page_single_sentence_last_item_is_at_end_immediately() {
        // 1文だけの Line item がドキュメント全体の最後の item である場合、advance を一度も
        // 呼ばずに is_at_end が最初から true になる（2文以上のケース、
        // `sentence_per_page_is_at_end_false_while_sentences_remain_on_last_line` との違いを
        // 明示的に固定する）。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["これだけの文。"])]);
        let pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.is_at_end(), "1文だけの最終itemはadvance前から終端のはず");
    }

    #[test]
    fn sentence_per_page_last_sentence_advances_into_following_choice() {
        // 複数文の Line item の直後に Choice item が続く文書で、Line 最後の文から advance
        // した結果が Choice へ前進することを確認する（Line→Choice への前進遷移。既存テスト
        // `select_current_choice_jumps_to_target_scene_start` 等は Choice→scene jump の
        // 後方向のみカバーしている）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1文目。2文目。"]),
            choice(vec![("進む", "1-1")]),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.advance(), "1文目 -> 2文目");
        assert!(pb.advance(), "2文目(最後) -> Choiceへ前進");

        assert!(
            pb.current_choice().is_some(),
            "Line最後の文からadvanceした先はChoiceのはず"
        );
        assert_eq!(
            pb.current_line(),
            None,
            "Choiceへ前進した後はcurrent_lineはNoneのはず"
        );
    }

    #[test]
    fn sentence_per_page_advance_past_true_end_is_idempotent() {
        // 非sentence版の既存 `advance_past_end_is_idempotent` の対（#486）。最後の Line item
        // の最後の文まで到達した真の終端状態でさらに advance を呼んでも false を返し、状態が
        // 変化しないことを確認する。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["1文目。2文目。"])]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.advance(), "1文目 -> 2文目（真の終端）");
        assert!(pb.is_at_end());
        let text_at_end = pb.current_line().expect("line").text.clone();

        assert!(!pb.advance(), "真の終端での最初のadvance呼び出し");
        assert_eq!(
            pb.current_line().expect("line").text,
            text_at_end,
            "状態は変化しないはず"
        );
        assert!(
            !pb.advance(),
            "真の終端での2回目のadvance呼び出しも変化なし"
        );
        assert_eq!(pb.current_line().expect("line").text, text_at_end);
        assert_eq!(pb.position(), 1);
    }

    #[test]
    fn sentence_per_page_advance_on_choice_item_returns_false_regardless_of_flag() {
        // Choiceチェックがsentence分岐より先に評価される設計の回帰ガード（#486）。
        // sentence_per_page=false での Choice 上 advance は既存の
        // `advance_while_choice_is_current_does_not_move` でカバー済みのため、ここでは
        // sentence_per_page=true の側を固定する。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["どうする？"]),
            choice(vec![("進む", "1-1")]),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.advance(), "1文だけのLine -> Choiceへ前進");
        assert!(pb.current_choice().is_some());

        assert!(
            !pb.advance(),
            "sentence_per_page=trueでもChoice表示中のadvanceはfalseのはず"
        );
        assert!(pb.current_choice().is_some(), "位置が変わっていないはず");
    }

    #[test]
    fn sentence_per_page_sentence_pages_empty_when_positioned_on_choice() {
        // `sync_sentence_pages` の早期returnパス（現在位置が Choice のとき）を直接カバーする。
        let doc = doc_single_scene(vec![choice(vec![("進む", "1-1")])]);
        let pb = Playback::from_document(&doc).with_sentence_per_page(true);
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");
        assert_eq!(
            pb.current_line(),
            None,
            "Choice位置ではcurrent_lineは常にNoneのはず"
        );
    }

    #[test]
    fn with_sentence_per_page_false_explicit_matches_default() {
        // `.with_sentence_per_page(false)` を明示的に呼んだ場合とデフォルト（呼ばない場合）が
        // 同じ結果になることを確認する。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["最初の文。次の文。"])]);
        let default_pb = Playback::from_document(&doc);
        let explicit_false_pb = Playback::from_document(&doc).with_sentence_per_page(false);
        assert_eq!(
            default_pb.current_line().expect("line").text,
            explicit_false_pb.current_line().expect("line").text
        );
    }

    // ---- #496 追加スコープ: ファイル境界（複数ファイルマージ時の暗黙advance制限） ----

    /// `chapter_number` 1件・`scene_id` 1件・`lines` を台詞として並べた「1ファイル分」の
    /// Chapter を作る（`route_chapter(1, "1-1", vec!["a", "b"])` = route1相当のファイル）。
    fn route_chapter(chapter_number: u32, scene_id: &str, lines: Vec<&str>) -> Chapter {
        chapter(
            chapter_number,
            vec![scene(
                scene_id,
                lines
                    .into_iter()
                    .map(|text| dialog(Some("A"), vec![text]))
                    .collect(),
            )],
        )
    }

    #[test]
    fn from_merged_document_advance_at_file_boundary_does_not_leak_into_next_file() {
        // route1相当(file 0)に台詞2件、route2相当(file 1)に台詞1件。原稿側で明示的なChoiceの
        // 閉じは無い（#496で修正する前のバグの再現条件そのもの: 「ルート1を読み終えて次へ
        // 押し続けるとルート2の冒頭に流れ込む」）。
        let route1 = route_chapter(1, "1-1", vec!["ルート1: 1文目", "ルート1: 最後の台詞"]);
        let route2 = route_chapter(2, "2-1", vec!["ルート2: 最初の台詞"]);
        let doc = document_with_chapters(vec![route1, route2]);
        let chapter_file_ids = vec![0, 1];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert!(
            pb.advance(),
            "route1内の1文目→2文目(最後)へは同一ファイルなので進めるはず"
        );
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["ルート1: 最後の台詞".to_string()]
        );

        assert!(
            pb.is_at_end(),
            "次のitemが別ファイル(route2)由来なので、route1最後の台詞の時点で終端扱いになるはず"
        );
        assert!(
            !pb.advance(),
            "別ファイルのitemへの暗黙advanceは拒否され、フラットなitems列上で物理的に \
             後続に存在するルート2相当のシーンには進まないはず"
        );
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["ルート1: 最後の台詞".to_string()],
            "advance拒否後も表示内容は変わらないはず"
        );
    }

    #[test]
    fn from_merged_document_explicit_choice_jump_still_crosses_file_boundary() {
        // route1(file 0)の最後にroute2(file 1)へ飛ぶChoiceを置いた構成。ファイル境界
        // チェックは暗黙のadvanceだけに適用され、選択肢による明示的なジャンプは
        // 別ファイル宛でも制限されないことを確認する（既存のクロスファイルジャンプ機能
        // `multi_doc::load_merged_document_resolves_cross_file_scene_jump` 等と対になる、
        // ファイル境界チェック導入後の回帰確認）。
        let route1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![
                    dialog(Some("A"), vec!["ルート1: 最後の台詞"]),
                    choice(vec![("ルート2へ", "2-1")]),
                ],
            )],
        );
        let route2 = route_chapter(2, "2-1", vec!["ルート2: 最初の台詞"]);
        let doc = document_with_chapters(vec![route1, route2]);
        let chapter_file_ids = vec![0, 1];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert!(
            pb.advance(),
            "台詞→Choiceへは同一ファイル内の前進なので進めるはず"
        );
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");

        assert!(
            pb.select_current_choice(),
            "別ファイルのシーンへのjumpでも、ファイル境界チェックの対象外なので成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("jump先の台詞").text,
            vec!["ルート2: 最初の台詞".to_string()]
        );
    }

    #[test]
    fn from_merged_document_with_single_underlying_file_behaves_like_from_document() {
        // multi_doc経由でも実質1ファイルしか無い場合（chapter_file_idsが全chapterに対して
        // 同じidを持つ）は、境界が1つしか無い＝実害が無いはず（from_documentと同じ挙動）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let chapter_file_ids = vec![0]; // 単一chapter・単一file id
        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);

        assert!(
            pb.advance(),
            "同一file id内なのでfrom_document同様に通常どおり進めるはず"
        );
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
    }

    // ---- #502: BGM (Event::Bgm) / SE (Event::Se) の追跡 ----

    fn bgm_play(path: &str) -> Event {
        Event::Bgm {
            path: Some(path.to_string()),
            action: BgmAction::Play,
            fade_ms: None,
        }
    }

    fn bgm_stop() -> Event {
        Event::Bgm {
            path: None,
            action: BgmAction::Stop,
            fade_ms: None,
        }
    }

    fn se(path: &str) -> Event {
        Event::Se {
            path: path.to_string(),
            fade_ms: None,
        }
    }

    #[test]
    fn lines_before_any_bgm_have_none() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["前"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), None);
    }

    #[test]
    fn dialog_after_bgm_play_carries_its_path() {
        let doc = doc_single_scene(vec![bgm_play("amehure.ogg"), dialog(Some("A"), vec!["後"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), Some("amehure.ogg"));
    }

    #[test]
    fn bgm_stop_clears_current_bgm_for_subsequent_lines() {
        let doc = doc_single_scene(vec![
            bgm_play("amehure.ogg"),
            dialog(Some("A"), vec!["再生中"]),
            bgm_stop(),
            dialog(Some("A"), vec!["停止後"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), Some("amehure.ogg"));
        pb.advance();
        assert_eq!(pb.current_bgm(), None);
    }

    #[test]
    fn later_bgm_play_replaces_the_previous_one() {
        let doc = doc_single_scene(vec![
            bgm_play("a.ogg"),
            dialog(Some("A"), vec!["1"]),
            bgm_play("b.ogg"),
            dialog(Some("A"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        pb.advance();
        assert_eq!(pb.current_bgm(), Some("b.ogg"));
    }

    #[test]
    fn bgm_play_without_path_is_treated_as_stop_like_gui() {
        // GUI版 `event.Bgm.action === 'Play' && event.Bgm.path` の両方が揃わない限り
        // else（停止）分岐に落ちるのと同じ意味論（通常の原稿では起こらない組み合わせだが、
        // フォールバックとして揃える）。
        let doc = doc_single_scene(vec![
            Event::Bgm {
                path: None,
                action: BgmAction::Play,
                fade_ms: None,
            },
            dialog(Some("A"), vec!["後"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), None);
    }

    #[test]
    fn bgm_state_persists_across_scene_and_chapter_boundaries() {
        let ch1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![bgm_play("amehure.ogg"), dialog(Some("A"), vec!["ch1"])],
            )],
        );
        let ch2 = chapter(2, vec![scene("2-1", vec![dialog(Some("B"), vec!["ch2"])])]);
        let doc = document_with_chapters(vec![ch1, ch2]);
        let mut pb = Playback::from_document(&doc);
        pb.advance();
        assert_eq!(
            pb.current_bgm(),
            Some("amehure.ogg"),
            "BGM状態はチャプター境界をまたいでも引き継がれる"
        );
    }

    #[test]
    fn choice_event_does_not_affect_bgm_state() {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        bgm_play("amehure.ogg"),
                        Event::Choice {
                            options: vec![ChoiceOption {
                                text: "yes".to_string(),
                                jump: "1-2".to_string(),
                            }],
                        },
                    ],
                ),
                scene("1-2", vec![dialog(Some("A"), vec!["後"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_bgm(),
            Some("amehure.ogg"),
            "Choice item自体もBGM状態を持つ"
        );
        assert!(pb.select_current_choice());
        assert_eq!(
            pb.current_bgm(),
            Some("amehure.ogg"),
            "Choiceを挟んでもBGM状態は変わらない"
        );
    }

    #[test]
    fn lines_before_any_se_have_empty_cues() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["前"])]);
        let pb = Playback::from_document(&doc);
        assert!(pb.current_se_cues().is_empty());
    }

    #[test]
    fn dialog_after_se_carries_its_path_as_a_one_shot_cue() {
        let doc = doc_single_scene(vec![se("chime.wav"), dialog(Some("A"), vec!["後"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current_se_cues(), &["chime.wav".to_string()]);
    }

    #[test]
    fn next_line_does_not_repeat_the_previous_lines_se_cue() {
        let doc = doc_single_scene(vec![
            se("chime.wav"),
            dialog(Some("A"), vec!["1"]),
            dialog(Some("A"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_se_cues(), &["chime.wav".to_string()]);
        pb.advance();
        assert!(
            pb.current_se_cues().is_empty(),
            "SEは到達時の1itemだけに紐づき後続itemへ引き継がれない（BGMとの意味論の違い）"
        );
    }

    #[test]
    fn multiple_consecutive_se_before_one_line_accumulate_in_order() {
        let doc = doc_single_scene(vec![
            se("a.wav"),
            se("b.wav"),
            dialog(Some("A"), vec!["後"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_se_cues(),
            &["a.wav".to_string(), "b.wav".to_string()]
        );
    }

    #[test]
    fn trailing_se_with_no_following_item_is_dropped() {
        // ドキュメント末尾の直前にSEがあっても、後続itemが無いためどのitemにも紐づかず
        // 再生対象にならない（既知の制約、item_seのdoc comment参照）。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["最後の台詞"]), se("chime.wav")]);
        let pb = Playback::from_document(&doc);
        assert!(pb.current_se_cues().is_empty());
    }

    #[test]
    fn cursor_changes_when_advancing_to_the_next_item() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        let before = pb.cursor();
        pb.advance();
        assert_ne!(
            before,
            pb.cursor(),
            "次のitemへ進んだのでcursorは変化するはず"
        );
    }

    #[test]
    fn cursor_stays_the_same_across_sentence_pages_within_one_line() {
        // sentence_per_page有効時、同一Line item内の文送りはitemsの位置(self.index)を
        // 動かさないため、cursorは変化しない（＝同じitemに紐づくSEを文送りのたびに
        // 再トリガーしない、意図した挙動）。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["最初の文。次の文。"])]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);
        let before = pb.cursor();
        assert!(pb.advance(), "同じLine item内の次の文へ進めるはず");
        assert_eq!(before, pb.cursor(), "文送りだけではcursorは変化しないはず");
    }
}
