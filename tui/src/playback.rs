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
//! ## イベント絵の時間差自動連続表示 (#497)
//!
//! `Event::Wait { ms }` はパーサーで構文解析済みだが、以前は TUI ランタイムが完全に無視して
//! いた。`[イベント絵: A][待機: 200][イベント絵: B]` のように `EventImage` の直後に `Wait` が
//! 続く並びだけを検出し、その場面を独立した `PlaybackItem::Image` として `items` に反映する
//! （`Playback::build` 参照）。話者・本文は直前の会話行のものをそのまま引き継ぎ、
//! `event_image` だけが新しい画像に切り替わる — GUI版 `NovelRenderer` の `Wait` 処理が会話
//! テキストに触れず、イベント絵レイヤーだけを更新するのと同じ見え方にするため。この item に
//! 位置している間は [`Playback::pending_wait_ms`] が `Some(ms)` を返し、`main.rs::event_loop`
//! がプレイヤーの入力を待たずに `ms` 経過後へ自動的に進める。`Wait` を伴わない単発の
//! `EventImage`（既存スクリプトの大半）は従来どおり item を増やさない — 無条件に item 化すると
//! 「画像だけのクリック待ちの1手」が新たに増えてしまう回帰になるため。
//!
//! ### 暗転で終わる自動連続表示 (#475)
//!
//! `Event::Blackout`（#512）は本来、既存の Line/Choice/Image item に「表示中は暗転しているか」
//! のフラグ（`item_blackout`）を後付けするだけで、暗転自体を運ぶ item を単独では作らない。この
//! ため `[イベント絵:A][待機:200][イベント絵:B][待機:200][暗転]` のように、`[暗転]` の後に
//! 表示すべき会話行が一つも続かない原稿（route10 最終回の「目を閉じて暗転して終わる」演出が
//! これに当たる）では、上記の EventImage+Wait 自動送りの連鎖が「暗転を表示する item」へ着地
//! できず、暗転が画面に一度も出ないまま再生が終わってしまう。これを防ぐため、EventImage+Wait
//! のパターン検出をさらに一段拡張し、`Wait` の直後が `Event::Blackout` の場合は、暗転状態を
//! 焼き付けた追加の `PlaybackItem::Image` を生成する（`Playback::build` 参照）。この item は
//! さらなる自動送りを持たない（`item_wait_ms` は `None`）— 「閉じきった最後のコマで暗転へ
//! 移る」で連鎖は完結し、暗転後に別の item へ自動で進む理由が無いため。オン/オフどちらの
//! `Event::Blackout` にも同じ経路で対応するが、実際にこの拡張を要求した route10 最終回の
//! ユースケースはオン（暗転して終わる）のみ。
//!
//! ### `Event::SceneTransition` とイベント絵クリアの GUI 版整合 (#524)
//!
//! GUI版 `NovelRenderer.processDirective` の `Event::SceneTransition` 分岐は
//! `this.setBlackout(false)` に加えて `this.eventImageLayer.remove()` も呼び、暗転解除と
//! イベント絵クリアの両方を行う。TUI版は #512 で `current_blackout = false` のみ実装しており
//! `current_event_image` をクリアしていなかった（GUI版との差異）。#524 でこれを解消し、
//! `Event::SceneTransition` は `current_blackout` と `current_event_image` の両方をリセット
//! する。加えて、上記の Wait+Blackout 自動送り拡張（#475）と同様の非対称性が
//! `Event::SceneTransition` にもあった — `[イベント絵][待機][場面転換]` で終わる原稿では
//! `Wait` 直後の検出パターンに `SceneTransition` が含まれておらず、場面転換後の状態
//! （暗転解除・イベント絵クリア）を焼き付けた item が生成されなかった。#524 でこの検出も
//! `Event::Blackout` と同じ経路に拡張し、`Wait` の直後が `Event::SceneTransition` の場合も
//! 追加の `PlaybackItem::Image` を生成する（`Playback::build` 参照）。
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

use name_name_parser::models::{BlackoutAction, ChoiceOption, Document, Event};

use crate::flags::GameFlags;
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
///
/// `Image` は #497 で追加した、テキストを伴わない「画像コマ」専用の item。`Event::EventImage`
/// の直後に `Event::Wait { ms }` が続く場合だけ生成される（`Playback::build` のスキャン参照）。
/// 話者・本文はその時点まで表示されていた直前の会話行の値をそのまま引き継ぐ（GUI版
/// `NovelRenderer` の Wait 処理が会話テキストには触れず、イベント絵レイヤーだけを更新するのと
/// 同じ見え方にするため）。`event_image` だけがこの item 用に新しく差し替わる。この item に
/// 到達している間は `Playback::pending_wait_ms` が `Some` を返し、`main.rs::event_loop` が
/// プレイヤーの入力を待たずに一定時間後へ自動的に進める。
#[derive(Debug, Clone, PartialEq)]
enum PlaybackItem {
    Line(DisplayLine),
    Image(DisplayLine),
    Choice(Vec<ChoiceOption>),
}

/// ドキュメント順（chapters→scenes の順）に並んだ、各シーンの参照情報。
///
/// `Playback::scene_order` / `scene_index_by_id` の下ごしらえ（#509 Phase B 予定分の準備、
/// 今回のスコープでは構築するだけで誰からも参照されない）。フラグに依存しない構造的な情報
/// のみを保持する — `scene_id`/`file_id`（由来ファイル id、`item_file_ids` と同じ意味）に
/// 加え、そのシーンの生イベント列を丸ごと複製して持つ。将来、選択肢ジャンプ時にシーン単位で
/// フラグ評価（`flags::resolve_events`）を行う際の入力になる想定。
#[allow(dead_code)]
struct SceneRef {
    scene_id: String,
    file_id: usize,
    events: Vec<Event>,
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
    /// `items[i]` に紐づく自動送りの待機時間（ミリ秒、#497）。`items` と同じ長さを常に保つ。
    /// `Event::EventImage` の直後に `Event::Wait { ms }` が続いたときだけ、その画像コマ
    /// （[`PlaybackItem::Image`]）に対応する要素が `Some(ms)` になる。それ以外の item（通常の
    /// `Line`/`Choice`、および `Wait` を伴わない `EventImage`）は全て `None`
    /// （[`Playback::pending_wait_ms`] 参照）。
    item_wait_ms: Vec<Option<u32>>,
    /// `items[i]` の表示時点で暗転しているべきか（`Event::Blackout`、#512）。`items` と同じ
    /// 長さを常に保つ（`item_file_ids` と同じ並行 Vec のパターン）。GUI版 `NovelRenderer` が
    /// `blackoutOverlay.visible` を `[暗転]`/`[暗転解除]` の直後から次に切り替わるまで
    /// 宣言的に保持し続ける（＝現在暗転中かどうかだけを見る state、`setBlackout` 参照）のを、
    /// TUI では「その item が生成された時点の暗転状態を焼き付けて持ち回る」形で再現する。
    /// `Event::Choice` item も対象に含む（暗転中に選択肢が出る原稿は今回のスコープ外だが、
    /// 状態追跡自体は他の非表示イベントと同じ走査ループの中で行うため、除外する理由がない）。
    item_blackout: Vec<bool>,
    index: usize,
    /// シーンID → そのシーンに属する最初の item の `items` 内インデックス。選択肢確定時の
    /// jump 先解決に使う（[`Playback::select_current_choice`]）。あるシーンが表示可能な item を
    /// 1つも持たない場合（背景切り替えのみ等）は、そのシーンの位置＝まだ何も push していない
    /// 時点の `items.len()`（＝後続シーンの先頭 item のインデックス、もしくは最後尾）を指す。
    /// #509 Phase B で `select_current_choice` が `scene_index_by_id`/`scene_order` 経由の
    /// 遅延ビルド解決に切り替わったため、現在はどこからも参照されない（削除はスコープ外）。
    #[allow(dead_code)]
    scene_start: HashMap<String, usize>,
    /// ドキュメント順（chapters→scenes の順）に並んだ、各シーンの参照情報（#509 Phase A
    /// 予定分の下ごしらえ）。`from_document`/`from_merged_document` で埋まる。今回のスコープ
    /// ではまだ誰からも参照されない（`scene_start` によるフラット化 items 上のジャンプが
    /// 引き続き使われる）。`from_lines` 経由の構築では空のまま。
    #[allow(dead_code)]
    scene_order: Vec<SceneRef>,
    /// シーンID → `scene_order` 内のインデックス（#509 Phase A 予定分の下ごしらえ）。
    /// `scene_order` と同様、今回のスコープではまだ誰からも参照されない。`from_lines` 経由の
    /// 構築では空のまま。
    #[allow(dead_code)]
    scene_index_by_id: HashMap<String, usize>,
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
    /// シーンを跨いで引き継ぐランニング状態（#509 Phase B）。`build_scene_items` を
    /// シーン単位で遅延呼び出しするため、`build` 完了後もこの状態を `Playback` 自身が
    /// 保持し続ける必要がある（以前は `build` のローカル変数で使い捨てだった）。
    scan_state: SceneScanState,
    /// 直近に item を生成した（＝ `build_scene_items` を最後に呼んだ）シーンの
    /// `scene_order` 内インデックス。`advance`/`select_current_choice` が次に
    /// どのシーンから遅延ビルドを再開すべきかの起点になる。
    current_scene_idx: usize,
    /// フラグ管理（#509）。`Event::Flag`/`Event::Condition` を `build_scene_items` が
    /// 逐次walk中にリアルタイムに評価・更新するための状態。
    flags: GameFlags,
}

/// `build_scene_items` がシーンを跨いで引き継ぐランニング状態のまとめ役（#509 Phase A）。
/// 個別の引数として渡すと `clippy::too_many_arguments` に抵触するため1つにまとめてある
/// （挙動には影響しない、純粋な引数の持ち方の整理）。
#[derive(Clone)]
struct SceneScanState {
    current_event_image: Option<String>,
    current_speaker: Option<String>,
    current_text: Vec<String>,
    current_blackout: bool,
}

/// 1シーン分の生イベント列を処理し、items系のVecへ積む。`Playback::build` から各シーンごとに
/// 呼ばれる、シーンを跨いで引き継ぐランニング状態（`current_event_image` 等、`state` にまとめて
/// ある）は呼び出し側が保持し、可変参照として受け渡す（#509 Phase A、後でシーン単位に動的
/// 呼び出しできるようにするための下ごしらえ。ロジックは `Playback::build` から一切変更せず
/// 丸ごと移動しただけ）。
///
/// `flags`（#509 のフラグ管理）を `state`（`SceneScanState`）にまとめず独立の引数のまま
/// 追加したため合計8引数になり `clippy::too_many_arguments`（既定閾値7）に抵触する。
/// `SceneScanState` は元々「シーンを跨いで引き継ぐランニング状態」専用の入れ物として
/// 導入された経緯があり、性質の異なる `GameFlags` をそこに押し込むのは筋が悪いため、
/// ここでは構造変更を避けて `allow` で抑止するに留める。
#[allow(clippy::too_many_arguments)]
fn build_scene_items(
    events: &[Event],
    file_id: usize,
    state: &mut SceneScanState,
    flags: &mut GameFlags,
    items: &mut Vec<PlaybackItem>,
    item_file_ids: &mut Vec<usize>,
    item_wait_ms: &mut Vec<Option<u32>>,
    item_blackout: &mut Vec<bool>,
) {
    let mut event_index = 0;
    while event_index < events.len() {
        let event = &events[event_index];
        match event {
            // `path` の `..` は `back`（表示位置）と `fade_ms`（イベント個別の
            // フェード時間上書き）を意図的に捨てている。`fade_ms` は TUI 側では
            // 常に `config.event_image.crossfade_ms`（グローバル値、`main.rs` の
            // `event_loop` 参照）しか使わない簡略化（MVPスコープ、#481）。GUI版の
            // ようなイベント単位のフェード時間上書きは今回の対象外。
            Event::EventImage { path, .. } => {
                state.current_event_image = Some(path.clone());
                // 直後が `Event::Wait { ms }` の場合だけ、画像コマ+待機の自動送り
                // item を作る（#497、Issue #475 が求める4コマ自動再生の受け皿）。
                // それ以外（次が Dialog/EventImage/EventImageExit 等）は従来どおり
                // `state.current_event_image` を更新するだけに留め、item は作らない —
                // ここで無条件に item 化すると、`[イベント絵:X]` の直後に台詞が
                // 続くだけの既存スクリプトにまで「クリック待ちの画像だけの1手」が
                // 増えてしまう（wait_ms 無しの item は自動で進まないため）回帰になる。
                //
                // `events.get(event_index + 1)` は「直後」の1イベントしか見ない
                // ため、`[イベント絵:A][SE:...][待機:200]` のように間に BGM/SE 等の
                // 非表示イベントを挟むとこのパターンに一致せず、自動送りが黙って
                // 無効化される（`Event::Wait` は下の `_` 分岐で通常どおり処理され、
                // 孤立した待機として扱われる）。スクリプト側でこの隣接性を守る必要が
                // ある（要ドキュメント化、セルフレビューshould対応）。
                if let Some(Event::Wait { ms }) = events.get(event_index + 1) {
                    items.push(PlaybackItem::Image(DisplayLine {
                        speaker: state.current_speaker.clone(),
                        text: state.current_text.clone(),
                        event_image: state.current_event_image.clone(),
                    }));
                    item_file_ids.push(file_id);
                    item_wait_ms.push(Some(*ms));
                    // #512 統合前は無かった並行 Vec。ここへの push 漏れは
                    // `item_blackout` を `items` より1件短くし、以降の全 item の
                    // `is_blackout()` 判定を静かにズラす（#475 実装時に発見した
                    // マージ由来のバグ、要修正）。
                    item_blackout.push(state.current_blackout);

                    // `Event::Wait` のさらに直後が `Event::Blackout` の場合、
                    // 暗転状態（オン/オフいずれも）を表示する独立した item を追加で
                    // 生成する（Issue #475）。#512 の `Event::Blackout` 処理
                    // （このmatchの少し下の腕）は、既存の Line/Choice/Image item に
                    // 「表示中は暗転しているか」のフラグを後付けするだけで、暗転
                    // 自体を運ぶ item を単独では作らない。そのため
                    // `[イベント絵:C][待機:200][暗転]` のように、暗転の後に表示
                    // すべき会話行が続かない原稿では、自動送りの連鎖が「暗転を表示
                    // する item」へ着地できず、暗転が画面に一度も出ないまま終わって
                    // しまう（Issue #475 の現状分析）。
                    //
                    // EventImage+Wait の2件消費に、Blackout も続く場合だけ+1する。
                    //
                    // 既知の制約1（Issue #475でスコープ外と判定済み、対応しない）:
                    // `events` はここでは `&scene.events`（シーンスコープ）のみを
                    // 見ているため、`[イベント絵][待機]` がシーン末尾・`[暗転]` が
                    // 次シーン先頭、という原稿ではこのパターンに一致せず検出漏れに
                    // なる（シーン境界をまたいだ Wait+Blackout 連鎖は検出できない）。
                    // Wait+Blackout の連鎖は同一シーン内に収める必要がある。
                    // シーン構造（`##` 見出し区切り）上、この演出を追記する箇所は
                    // 単一シーンに収まる設計になっていると推測されるが、現時点で
                    // Gymnasia 側に「目を閉じて暗転して終わる」シーケンス
                    // （`[暗転]` タグ）自体を含む原稿がまだ一件も存在しないため
                    // （画像素材が未制作で暫定対応中、Issue本文参照）、実データでの
                    // 検証はできていない。実データが追加された時点で再検証が必要。
                    //
                    // #524 で解消: `[イベント絵][待機][場面転換]` で終わる原稿も、
                    // `Event::Blackout` と同じ経路で「場面転換後の状態を焼き付けた
                    // item」を生成する。GUI版 `Event::SceneTransition` 分岐
                    // （`setBlackout(false)` + `eventImageLayer.remove()`）に倣い、
                    // `state.current_blackout=false` かつ `state.current_event_image=None` に
                    // リセットした上で item を積む — Blackout の「On」と同じ役割だが、
                    // 運ぶ状態は暗転そのものではなくイベント絵クリア後の状態である点が
                    // 異なる。この分岐で `Event::SceneTransition` 自体を消費するため、
                    // 下の match 腕（`Event::SceneTransition => { .. }`）はここでは
                    // 実行されない（`Event::Blackout` を消費するときと同じ扱い）。
                    let mut consumed = 2;
                    if let Some(Event::Blackout { action }) = events.get(event_index + 2) {
                        state.current_blackout = matches!(action, BlackoutAction::On);
                        items.push(PlaybackItem::Image(DisplayLine {
                            speaker: state.current_speaker.clone(),
                            text: state.current_text.clone(),
                            event_image: state.current_event_image.clone(),
                        }));
                        item_file_ids.push(file_id);
                        // 暗転item自体はさらなる自動送りを持たない —
                        // 「閉じきった最後のコマで暗転へ移る」で連鎖は完結し、
                        // 暗転後にまた別のitemへ自動で進む必要は無い（#475スコープ）。
                        item_wait_ms.push(None);
                        item_blackout.push(state.current_blackout);
                        consumed = 3;
                    } else if matches!(events.get(event_index + 2), Some(Event::SceneTransition)) {
                        state.current_blackout = false;
                        state.current_event_image = None;
                        items.push(PlaybackItem::Image(DisplayLine {
                            speaker: state.current_speaker.clone(),
                            text: state.current_text.clone(),
                            event_image: state.current_event_image.clone(),
                        }));
                        item_file_ids.push(file_id);
                        // Blackout終端itemと同じく、さらなる自動送りは持たない。
                        item_wait_ms.push(None);
                        item_blackout.push(state.current_blackout);
                        consumed = 3;
                    }
                    event_index += consumed;
                    continue;
                }
            }
            Event::EventImageExit { .. } => {
                state.current_event_image = None;
            }
            // GUI版 `setBlackout` 相当（#512）。オン/オフの2状態を単純に上書きする
            // だけの宣言的 state で、`state.current_event_image` と同じ「直近の値を次の
            // item に焼き付ける」走査パターンに乗せる。
            Event::Blackout { action } => {
                state.current_blackout = matches!(action, BlackoutAction::On);
            }
            // GUI版 `NovelRenderer.processDirective` の `Event::SceneTransition` 相当
            // （`this.setBlackout(false)` + `this.eventImageLayer.remove()`、#512/#524）。
            // spec（markdown-v0.1.md）は `[場面転換]` を「背景クリア + 暗転解除」と
            // 定義しており、`[暗転]` でオンにした暗転を明示的にオフへ戻すのに加え、
            // GUI版はイベント絵レイヤーも明示的にクリアする（作者が
            // `[イベント絵終了]` を書き忘れても場面転換で必ずイベント絵が消える
            // 防御的挙動、#351）。TUI 側もこれに合わせ `state.current_event_image` を
            // `None` に戻す（#524、旧実装は `state.current_blackout` のみリセットしており
            // GUI版との差異だった）。背景クリア相当の永続 state（`clearBackground` /
            // `videoLayer.remove` / `retreatNovelScrim`）は TUI 側が持たないため、
            // このスコープでは暗転解除・イベント絵クリアのみ実装する。
            Event::SceneTransition => {
                state.current_blackout = false;
                state.current_event_image = None;
            }
            Event::Flag { name, value } => {
                flags.set(name.clone(), value.clone());
            }
            Event::Condition {
                flag,
                events: inner,
            } => {
                if flags.check(flag) {
                    build_scene_items(
                        inner,
                        file_id,
                        state,
                        flags,
                        items,
                        item_file_ids,
                        item_wait_ms,
                        item_blackout,
                    );
                }
                // false の場合は何もしない（inner を一切処理しない＝副作用もitem生成も無い）
            }
            _ => {
                if let Some(item) = playback_item_from_event(event) {
                    let item = match item {
                        PlaybackItem::Line(mut line) => {
                            line.event_image = state.current_event_image.clone();
                            state.current_speaker = line.speaker.clone();
                            state.current_text = line.text.clone();
                            PlaybackItem::Line(line)
                        }
                        choice @ PlaybackItem::Choice(_) => choice,
                        // `playback_item_from_event` は Dialog/Narration/Choice
                        // からしか item を作らないため Image は返さない
                        // （Image は上の EventImage+Wait 分岐でのみ生成される）。
                        image @ PlaybackItem::Image(_) => image,
                    };
                    items.push(item);
                    item_file_ids.push(file_id);
                    item_wait_ms.push(None);
                    item_blackout.push(state.current_blackout);
                }
            }
        }
        event_index += 1;
    }
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
        let mut item_wait_ms = Vec::new();
        let mut item_blackout = Vec::new();
        let mut scene_start = HashMap::new();
        let mut scene_order: Vec<SceneRef> = Vec::new();
        let mut scene_index_by_id = HashMap::new();
        // 直前まで表示されていた会話行の話者・本文（#497）。`Event::EventImage` の直後に
        // `Event::Wait` が続いたときに生成する画像コマ item（`PlaybackItem::Image`）へ
        // そのまま引き継ぐ — Wait 中は会話テキストを変えず画像だけが切り替わる、という
        // GUI版 `NovelRenderer` の Wait 処理と同じ見え方にするため。まだ一度も会話行が
        // 無ければ「話者なし・本文なし」が初期値になる。
        let mut scan_state = SceneScanState {
            current_event_image: None,
            current_speaker: None,
            current_text: Vec::new(),
            current_blackout: false,
        };
        let mut flags = GameFlags::new();
        for (chapter_index, chapter) in doc.chapters.iter().enumerate() {
            let file_id = chapter_file_ids
                .map(|ids| ids.get(chapter_index).copied().unwrap_or(chapter_index))
                .unwrap_or(0);
            for scene in &chapter.scenes {
                // このシーンの最初の item になる（はずの）位置を、events を処理する前に記録する。
                // 重複シーンIDは最初の出現を優先する（GUI版 `allScenes.find` が最初の一致を
                // 返すのと同じ規約）。
                scene_start.entry(scene.id.clone()).or_insert(items.len());
                scene_index_by_id
                    .entry(scene.id.clone())
                    .or_insert_with(|| {
                        scene_order.push(SceneRef {
                            scene_id: scene.id.clone(),
                            file_id,
                            events: scene.events.clone(),
                        });
                        scene_order.len() - 1
                    });
            }
        }
        if let Some(first_scene) = scene_order.first() {
            build_scene_items(
                &first_scene.events,
                first_scene.file_id,
                &mut scan_state,
                &mut flags,
                &mut items,
                &mut item_file_ids,
                &mut item_wait_ms,
                &mut item_blackout,
            );
        }
        Self {
            items,
            item_file_ids,
            item_wait_ms,
            item_blackout,
            index: 0,
            scene_start,
            scene_order,
            scene_index_by_id,
            choice_cursor: 0,
            sentence_per_page: false,
            sentence_pages: Vec::new(),
            sentence_index: 0,
            current_display: None,
            scan_state,
            current_scene_idx: 0,
            flags,
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

    /// 現在位置の会話行。現在位置が Choice item、会話行が1件もない、または末尾を過ぎている
    /// 場合は `None`。`sentence_per_page` が有効なときは、Line item の全文ではなく現在の
    /// 文単位ページ（`current_display`）だけを返す (#486)。
    ///
    /// 現在位置が画像コマ item（[`PlaybackItem::Image`]、#497）の場合は、`sentence_per_page`
    /// の設定に関わらずその item が持つ `DisplayLine`（直前の会話行から引き継いだ話者・本文 +
    /// 新しい `event_image`）をそのまま返す。画像コマは文単位改頁の対象外
    /// （`sync_sentence_pages` が `Line` にしかマッチしないため `current_display` は
    /// 積まれない）なので、ここで先に特別扱いしないと `sentence_per_page` 有効時に
    /// 誤って `None` を返してしまう。
    pub fn current_line(&self) -> Option<&DisplayLine> {
        if let Some(PlaybackItem::Image(line)) = self.items.get(self.index) {
            return Some(line);
        }
        if self.sentence_per_page {
            return self.current_display.as_ref();
        }
        match self.items.get(self.index) {
            Some(PlaybackItem::Line(line)) => Some(line),
            _ => None,
        }
    }

    /// 現在位置の item が暗転中に表示されるべきか（`Event::Blackout`、#512）。
    /// `items` が空、または現在位置が末尾を過ぎている場合は暗転していない扱い（`false`）。
    /// GUI版 `blackoutOverlay.visible` に相当する、現在位置だけを見る宣言的な問い合わせ。
    pub fn is_blackout(&self) -> bool {
        self.item_blackout.get(self.index).copied().unwrap_or(false)
    }

    /// 現在位置が選択肢なら `(選択肢一覧, カーソル位置)` を返す。会話行の途中や末尾越えでは
    /// `None`。
    pub fn current_choice(&self) -> Option<(&[ChoiceOption], usize)> {
        match self.items.get(self.index) {
            Some(PlaybackItem::Choice(options)) => Some((options.as_slice(), self.choice_cursor)),
            _ => None,
        }
    }

    /// 現在位置に紐づく自動送りの待機時間（ミリ秒、#497）。`Some` を返すのは、`items` 構築時に
    /// `Event::EventImage` の直後に `Event::Wait { ms }` が続いていたことで生成された画像コマ
    /// item（[`PlaybackItem::Image`]）に位置しているときだけ。`main.rs::event_loop` はこれが
    /// `Some(ms)` の間、プレイヤーの入力（キー押下）を待たずに `ms` 経過後へ自動的に進める
    /// （GUI版 `NovelRenderer` の `Wait { ms }` + `waitingForWait` に相当、Issue #475 が求める
    /// イベント絵の複数コマ自動再生を実現する）。
    pub fn pending_wait_ms(&self) -> Option<u32> {
        self.item_wait_ms.get(self.index).copied().flatten()
    }

    /// `items` 内の生の現在位置（0始まり）。`position()`（会話行のみを数える1始まりのカウント）
    /// とは異なり、画像コマ item（[`PlaybackItem::Image`]、#497）も1件として数える。
    /// `main.rs::event_loop` が「実際に別の item へ移動したか」（＝新しい event_image への
    /// クロスフェードを開始すべきか）を判定するのに使う — 画像コマへの遷移は `position()` の
    /// 値を変えない（Line item ではないため）ので、`position()` の変化だけを見ていると
    /// 画像コマへの遷移を検知し損ねる。
    pub(crate) fn item_index(&self) -> usize {
        self.index
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
            return true;
        }
        loop {
            let next_scene_idx = self.current_scene_idx + 1;
            let Some(next_scene) = self.scene_order.get(next_scene_idx) else {
                return false;
            };
            let current_file_id = self.scene_order[self.current_scene_idx].file_id;
            if next_scene.file_id != current_file_id {
                return false;
            }
            let start = self.items.len();
            let events = next_scene.events.clone();
            let file_id = next_scene.file_id;
            build_scene_items(
                &events,
                file_id,
                &mut self.scan_state,
                &mut self.flags,
                &mut self.items,
                &mut self.item_file_ids,
                &mut self.item_wait_ms,
                &mut self.item_blackout,
            );
            self.current_scene_idx = next_scene_idx;
            if self.items.len() > start {
                self.set_index(start);
                return true;
            }
            // このシーンはitemを1件も生成しなかった。さらに次のシーンへ。
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
        let Some(&target_scene_idx) = self.scene_index_by_id.get(&option.jump) else {
            return false;
        };
        let mut scene_idx = target_scene_idx;
        loop {
            let scene = &self.scene_order[scene_idx];
            let events = scene.events.clone();
            let file_id = scene.file_id;
            let start = self.items.len();
            build_scene_items(
                &events,
                file_id,
                &mut self.scan_state,
                &mut self.flags,
                &mut self.items,
                &mut self.item_file_ids,
                &mut self.item_wait_ms,
                &mut self.item_blackout,
            );
            self.current_scene_idx = scene_idx;
            if self.items.len() > start {
                self.set_index(start);
                return true;
            }
            // ジャンプ先シーンがitem 0件。ファイル境界を越えない範囲で次のシーンへ
            // フォールスルーする（`advance()` のゼロ件シーン読み飛ばしループと同じ規約、
            // モジュール冒頭のドキュメント参照）。
            let next_scene_idx = scene_idx + 1;
            let Some(next_scene) = self.scene_order.get(next_scene_idx) else {
                // ドキュメント末尾。旧実装と同じく `items.len()`（範囲外）を指す位置に
                // 置く — `position()` は `take` で安全に全Line数を返し、`is_at_end()` は
                // `has_more_scenes_with_items()` 経由でこれを「実質末尾」として扱う
                // （`position_after_jumping_into_zero_item_last_scene_does_not_panic` /
                // `is_at_end_true_when_jump_lands_on_out_of_bounds_index_of_zero_item_scene`
                // の期待値どおり）。
                self.set_index(start);
                return true;
            };
            if next_scene.file_id != file_id {
                self.set_index(start);
                return true;
            }
            scene_idx = next_scene_idx;
        }
    }

    /// 会話行の総数（Choice item・画像コマ item は含まない、#497）。画像コマ
    /// （[`PlaybackItem::Image`]）は元の会話行の話者・本文を引き継いだ表示上の中間状態に
    /// すぎず、それ自体は新しい会話行ではないため数えない。
    ///
    /// UI（進捗バー等）向けに「ドキュメント全体の会話行総数」を返す必要があるため、
    /// プレイヤーが実際に訪れた範囲だけを保持する `self.items`（#509 で遅延構築に変更）は
    /// 使わない。`self.scene_order`（ドキュメント順の全シーンの生イベント一覧）を、実際の
    /// 再生状態（`self.scan_state` / `self.items`）に一切触れない使い捨ての状態で独立に
    /// 全件スキャンして数える（`has_more_scenes_with_items` が使っている「使い捨て
    /// scan_state + 使い捨て Vec で `build_scene_items` を試し呼びする」パターンと同じ）。
    pub fn total(&self) -> usize {
        let mut scan_state = SceneScanState {
            current_event_image: None,
            current_speaker: None,
            current_text: Vec::new(),
            current_blackout: false,
        };
        let mut flags = self.flags.clone();
        let mut count = 0;
        for scene in &self.scene_order {
            let mut items = Vec::new();
            let mut item_file_ids = Vec::new();
            let mut item_wait_ms = Vec::new();
            let mut item_blackout = Vec::new();
            build_scene_items(
                &scene.events,
                scene.file_id,
                &mut scan_state,
                &mut flags,
                &mut items,
                &mut item_file_ids,
                &mut item_wait_ms,
                &mut item_blackout,
            );
            count += items
                .iter()
                .filter(|item| matches!(item, PlaybackItem::Line(_)))
                .count();
        }
        count
    }

    /// 現在位置が何行目か（1始まり、Choice item・画像コマ item は含まない、#497）。現在位置が
    /// Choice の場合は、そこに至るまでに表示済みの会話行数を返す（例: 3行しゃべった直後に
    /// 選択肢が出ている状態なら3を返す）。画像コマ自動再生の途中（`pending_wait_ms` が
    /// `Some`）でも、直前に表示済みだった会話行数のまま変化しない。
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
            return !self.has_more_scenes_with_items();
        }
        self.item_file_ids[self.index + 1] != self.item_file_ids[self.index]
    }

    /// `self` を変更せず、`current_scene_idx` より後にまだ表示可能な item が存在するかを
    /// 判定する。`scan_state` を複製した使い捨ての状態に対して `build_scene_items` を試し
    /// 呼びし、実際に追記が必要になるまで `self` 本体を変更しないための読み取り専用
    /// ルックアヘッド（#509 Phase B、`is_at_end` の遅延ビルド対応）。
    fn has_more_scenes_with_items(&self) -> bool {
        let mut scan_state = self.scan_state.clone();
        let mut flags = self.flags.clone();
        let mut scene_idx = self.current_scene_idx;
        loop {
            let next_scene_idx = scene_idx + 1;
            let Some(next_scene) = self.scene_order.get(next_scene_idx) else {
                return false;
            };
            if next_scene.file_id != self.scene_order[scene_idx].file_id {
                return false;
            }
            let mut items = Vec::new();
            let mut item_file_ids = Vec::new();
            let mut item_wait_ms = Vec::new();
            let mut item_blackout = Vec::new();
            build_scene_items(
                &next_scene.events,
                next_scene.file_id,
                &mut scan_state,
                &mut flags,
                &mut items,
                &mut item_file_ids,
                &mut item_wait_ms,
                &mut item_blackout,
            );
            if !items.is_empty() {
                return true;
            }
            scene_idx = next_scene_idx;
        }
    }

    /// テスト専用: 会話行リストから直接 `Playback` を組み立てる。`main.rs` の
    /// `on_advance` テストなどで、`Document`（20個のフィールドを埋める必要がある）経由の
    /// 冗長なフィクスチャ構築を避けるために使う（#472）。選択肢を含む状態遷移のテストは
    /// `Document` 経由（`from_document`、`scene_start` の構築が必要なため）で行う。
    #[cfg(test)]
    pub(crate) fn from_lines(lines: Vec<DisplayLine>) -> Self {
        let item_file_ids = vec![0; lines.len()];
        let item_wait_ms = vec![None; lines.len()];
        let item_blackout = vec![false; lines.len()];
        Self {
            items: lines.into_iter().map(PlaybackItem::Line).collect(),
            item_file_ids,
            item_wait_ms,
            item_blackout,
            index: 0,
            scene_start: HashMap::new(),
            scene_order: Vec::new(),
            scene_index_by_id: HashMap::new(),
            choice_cursor: 0,
            sentence_per_page: false,
            sentence_pages: Vec::new(),
            sentence_index: 0,
            current_display: None,
            scan_state: SceneScanState {
                current_event_image: None,
                current_speaker: None,
                current_text: Vec::new(),
                current_blackout: false,
            },
            current_scene_idx: 0,
            flags: GameFlags::new(),
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

    // ---- #497: イベント絵の時間差自動連続表示（画像コマ item の構築・状態遷移） ----
    //
    // テストケース一覧のデシジョンテーブル1（`Playback::build` の EventImage/Wait走査）・
    // テーブル2のうち Playback 単体で検証できる部分（item_index/pending_wait_ms/advance の
    // 状態遷移）をここでカバーする。event_loop 側のタイマー駆動・入力スタベーション回帰は
    // main.rs 側のテストで検証する。

    fn wait(ms: u32) -> Event {
        Event::Wait { ms }
    }

    #[test]
    fn build_event_image_immediately_followed_by_wait_creates_image_item_with_wait_ms() {
        // デシジョンテーブル1#1: EventImage直後がWait、直前に会話行あり、Wait後は末尾。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["こんにちは"]),
            event_image("a.webp"),
            wait(200),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "会話行から画像コマitemへ進めるはず");

        assert_eq!(pb.pending_wait_ms(), Some(200));
        let line = pb
            .current_line()
            .expect("画像コマitemもcurrent_lineを持つはず");
        assert_eq!(
            line.speaker.as_deref(),
            Some("A"),
            "話者は直前の会話行を引き継ぐ"
        );
        assert_eq!(line.text, vec!["こんにちは".to_string()]);
        assert_eq!(line.event_image.as_deref(), Some("a.webp"));
    }

    #[test]
    fn build_event_image_without_following_wait_does_not_create_image_item() {
        // デシジョンテーブル1#6（回帰）: 直後がWaitでない既存スクリプトの大半はitem化しない。
        let doc = doc_single_scene(vec![
            event_image("a.webp"),
            dialog(Some("A"), vec!["hello"]),
        ]);
        let pb = Playback::from_document(&doc);

        assert_eq!(pb.total(), 1, "画像コマitemは増えず会話行1件のみのはず");
        let line = pb.current_line().expect("line");
        assert_eq!(line.speaker.as_deref(), Some("A"));
        assert_eq!(
            line.event_image.as_deref(),
            Some("a.webp"),
            "event_imageは従来どおりLine itemに反映されるはず"
        );
        assert_eq!(pb.pending_wait_ms(), None);
    }

    #[test]
    fn build_event_image_as_last_event_in_scene_without_wait_does_not_panic_or_create_item() {
        // デシジョンテーブル1#7: EventImageがシーン末尾で次要素が無い（events.get(+1)がNone）。
        // panicせず、item化もされないことを確認する。
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["hi"]), event_image("a.webp")]);
        let pb = Playback::from_document(&doc);

        assert_eq!(pb.total(), 1, "末尾のEventImage単体はitem化されないはず");
        assert!(pb.is_at_end());
    }

    #[test]
    fn build_consecutive_event_image_wait_pairs_create_multiple_image_items_in_order() {
        // デシジョンテーブル1#3: EventImage+Waitの連鎖が複数連続する。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["look"]),
            event_image("a.webp"),
            wait(100),
            event_image("b.webp"),
            wait(200),
            event_image("c.webp"),
            wait(300),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance());
        assert_eq!(pb.pending_wait_ms(), Some(100));
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("a.webp")
        );

        assert!(pb.advance());
        assert_eq!(pb.pending_wait_ms(), Some(200));
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("b.webp")
        );

        assert!(pb.advance());
        assert_eq!(pb.pending_wait_ms(), Some(300));
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("c.webp")
        );
        assert!(pb.is_at_end(), "3組目のWait後は末尾のはず");
    }

    #[test]
    fn build_event_image_wait_followed_by_dialog_resumes_normal_line_with_carried_event_image() {
        // デシジョンテーブル1#2: Wait後にDialogが続く場合、通常のLine itemへ復帰し、
        // event_imageはそのまま引き継がれる。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["intro"]),
            event_image("a.webp"),
            wait(100),
            dialog(Some("B"), vec!["next line"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "画像コマitemへ");
        assert!(pb.advance(), "通常のLine itemへ復帰");

        assert_eq!(
            pb.pending_wait_ms(),
            None,
            "通常のLine itemに戻ったのでwait_msは無いはず"
        );
        let line = pb.current_line().expect("line");
        assert_eq!(line.speaker.as_deref(), Some("B"));
        assert_eq!(line.text, vec!["next line".to_string()]);
        assert_eq!(
            line.event_image.as_deref(),
            Some("a.webp"),
            "event_imageは画像コマを経ても引き継がれ続けるはず"
        );
    }

    #[test]
    fn build_event_image_wait_before_any_dialog_has_none_speaker_and_empty_text() {
        // デシジョンテーブル1#8: 冒頭がいきなりEventImage+Wait（会話行が一度も無い）。
        let doc = doc_single_scene(vec![event_image("a.webp"), wait(50)]);
        let pb = Playback::from_document(&doc);

        let line = pb.current_line().expect("先頭itemが画像コマ自身になるはず");
        assert_eq!(line.speaker, None);
        assert_eq!(line.text, Vec::<String>::new());
        assert_eq!(line.event_image.as_deref(), Some("a.webp"));
    }

    #[test]
    fn build_orphan_wait_without_preceding_event_image_is_ignored() {
        // デシジョンテーブル1#10: 先行するEventImageが無い孤立したWaitは従来どおり無視される
        // （Waitはdisplay_line_from_event/playback_item_from_eventのどちらもNoneを返す）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            wait(100),
            dialog(Some("B"), vec!["there"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(pb.total(), 2, "孤立Waitはitem数に影響しないはず");
        assert_eq!(pb.pending_wait_ms(), None);
        assert!(pb.advance());
        assert_eq!(pb.current_line().unwrap().speaker.as_deref(), Some("B"));
    }

    #[test]
    fn build_event_image_followed_by_wait_display_complete_does_not_create_image_item() {
        // デシジョンテーブル1#9: 直後が`Event::Wait{ms}`ではなく別variantの
        // `Event::WaitDisplayComplete`（`[待機: 表示完了]`）だと、パターン不一致で
        // 画像コマitemは作られない（型取り違え検出）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            event_image("a.webp"),
            Event::WaitDisplayComplete,
            dialog(Some("B"), vec!["there"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(
            pb.total(),
            2,
            "WaitDisplayCompleteはEventImageの直後でも画像コマitemを作らないはず"
        );
        assert!(pb.advance());
        let line = pb.current_line().unwrap();
        assert_eq!(line.speaker.as_deref(), Some("B"));
        assert_eq!(
            line.event_image.as_deref(),
            Some("a.webp"),
            "event_image自体は通常どおり引き継がれる"
        );
        assert_eq!(pb.pending_wait_ms(), None);
    }

    #[test]
    fn build_event_image_wait_zero_ms_creates_image_item_with_wait_ms_zero_not_none() {
        // 境界値: ms=0でもSome(0)が保持され、Noneに丸められないこと。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            event_image("a.webp"),
            wait(0),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance());
        assert_eq!(
            pb.pending_wait_ms(),
            Some(0),
            "Some(0)とNoneは区別されなければならない"
        );
    }

    #[test]
    fn pending_wait_ms_is_none_for_ordinary_line_and_choice_items() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            choice(vec![("go", "1-1")]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(pb.pending_wait_ms(), None, "Line item上ではNoneのはず");
        pb.advance();
        assert_eq!(pb.pending_wait_ms(), None, "Choice item上でもNoneのはず");
    }

    #[test]
    fn pending_wait_ms_toggles_some_and_none_across_advance() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            event_image("a.webp"),
            wait(150),
            dialog(Some("B"), vec!["bye"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(pb.pending_wait_ms(), None, "会話行Aの時点ではNone");
        pb.advance();
        assert_eq!(pb.pending_wait_ms(), Some(150), "画像コマ到達でSome");
        pb.advance();
        assert_eq!(pb.pending_wait_ms(), None, "会話行Bに復帰してNoneへ戻る");
    }

    #[test]
    fn item_index_counts_image_items_while_position_does_not() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            event_image("a.webp"),
            wait(100),
            dialog(Some("B"), vec!["bye"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(pb.item_index(), 0);
        assert_eq!(pb.position(), 1);

        pb.advance(); // 画像コマitemへ
        assert_eq!(pb.item_index(), 1, "item_indexは画像コマも1件として数える");
        assert_eq!(
            pb.position(),
            1,
            "positionは画像コマを数えないので直前のままのはず"
        );

        pb.advance(); // 会話行Bへ
        assert_eq!(pb.item_index(), 2);
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn current_line_on_image_item_ignores_sentence_per_page_setting() {
        // sentence_per_page有効時でも、画像コマitemは文単位分割の対象外で、直前会話行の
        // 全文をそのままDisplayLineとして返す（current_lineの特別扱いが無いと、
        // current_display(Line専用)を参照して誤ってNoneを返してしまう）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1文目。2文目。"]),
            event_image("a.webp"),
            wait(100),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);

        assert!(pb.advance(), "1文目→2文目のページ送り（同一Line item内）");
        assert!(pb.advance(), "2文目→画像コマitemへ");

        assert_eq!(pb.pending_wait_ms(), Some(100));
        let line = pb
            .current_line()
            .expect("画像コマitemはsentence_per_page有効でもcurrent_lineを持つはず");
        assert_eq!(
            line.text,
            vec!["1文目。2文目。".to_string()],
            "話者・本文は直前会話行の全文をそのまま引き継ぐ（文単位分割はしない）"
        );
        assert_eq!(line.event_image.as_deref(), Some("a.webp"));
    }

    #[test]
    fn total_and_position_exclude_image_items_when_interposed_between_lines() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            event_image("a.webp"),
            wait(50),
            event_image("b.webp"),
            wait(50),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(
            pb.total(),
            2,
            "画像コマが2件挟まっていても会話行総数は2のまま"
        );
        pb.advance(); // 画像コマ1
        pb.advance(); // 画像コマ2
        pb.advance(); // 会話行B
        assert_eq!(
            pb.position(),
            2,
            "画像コマを2件経由してもpositionは会話行の数だけ進むはず"
        );
    }

    #[test]
    fn advance_with_sentence_per_page_pages_through_multi_sentence_line_before_reaching_image_item()
    {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1文目。2文目。"]),
            event_image("a.webp"),
            wait(100),
        ]);
        let mut pb = Playback::from_document(&doc).with_sentence_per_page(true);

        assert_eq!(pb.item_index(), 0);
        assert!(pb.advance(), "1文目から2文目へのページ送り");
        assert_eq!(
            pb.item_index(),
            0,
            "同一Line item内のページ送りなのでitem_indexは変わらない"
        );

        assert!(pb.advance(), "2文目を読み終えて画像コマitemへ進む");
        assert_eq!(pb.item_index(), 1);
        assert_eq!(pb.pending_wait_ms(), Some(100));
    }

    #[test]
    fn advance_from_terminal_image_item_returns_false_and_pending_wait_ms_still_some() {
        // 末尾境界: 末尾の画像コマからはこれ以上進めず、advance()はfalseを返す。
        // no-opのadvance後もpending_wait_msは変化しない（main.rs側のno-op判定が
        // この不変を前提にしている）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["hi"]),
            event_image("a.webp"),
            wait(0),
        ]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // 末尾の画像コマitemへ
        assert!(pb.is_at_end());
        assert_eq!(pb.pending_wait_ms(), Some(0));

        assert!(!pb.advance(), "末尾の画像コマからはこれ以上進めない");
        assert_eq!(
            pb.pending_wait_ms(),
            Some(0),
            "no-opのadvance後もwait_msは変化しないはず"
        );
    }

    /// spec（markdown-v0.1.md）は `[場面転換]` を「背景クリア + 暗転解除」と定義しており、
    /// GUI版 `NovelRenderer.processDirective` は `Event::SceneTransition` で明示的に
    /// `setBlackout(false)` を呼ぶ。`[暗転]` → (台詞) → `[場面転換]` → 台詞、という原稿で
    /// 最後の台詞の時点では暗転が解除されているべき（#512 仕様漏れの回帰テスト）。
    #[test]
    fn scene_transition_resets_blackout_per_spec() {
        let doc = doc_single_scene(vec![
            Event::Blackout {
                action: BlackoutAction::On,
            },
            dialog(Some("A"), vec!["暗転中の台詞"]),
            Event::SceneTransition,
            dialog(Some("B"), vec!["場面転換後の台詞"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.is_blackout(), "[暗転]直後の台詞はまだ暗転中のはず");

        assert!(pb.advance(), "場面転換後の台詞へ進めるはず");
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(
            !pb.is_blackout(),
            "[場面転換]は spec 上「暗転解除」を伴うため、直後の台詞では暗転していないはず"
        );
    }

    // ---- #512 追補: Event::Blackout の残りの観点（テスト観点整理で洗い出した分） ----

    fn blackout_on() -> Event {
        Event::Blackout {
            action: BlackoutAction::On,
        }
    }

    fn blackout_off() -> Event {
        Event::Blackout {
            action: BlackoutAction::Off,
        }
    }

    #[test]
    fn lines_before_any_blackout_are_not_blacked_out() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
            dialog(Some("C"), vec!["3"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(
            !pb.is_blackout(),
            "一度も[暗転]が出ない原稿ではis_blackout()は常にfalseのはず"
        );
        assert!(pb.advance());
        assert!(!pb.is_blackout());
        assert!(pb.advance());
        assert!(!pb.is_blackout());
    }

    #[test]
    fn dialog_after_blackout_on_is_blacked_out() {
        let doc = doc_single_scene(vec![blackout_on(), dialog(Some("A"), vec!["暗転中"])]);
        let pb = Playback::from_document(&doc);
        assert!(
            pb.is_blackout(),
            "[暗転]直後の台詞はis_blackout()==trueのはず"
        );
    }

    #[test]
    fn dialog_after_blackout_off_is_not_blacked_out() {
        let doc = doc_single_scene(vec![
            blackout_on(),
            dialog(Some("A"), vec!["暗転中"]),
            blackout_off(),
            dialog(Some("B"), vec!["解除後"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.is_blackout(), "1件目の台詞はまだ[暗転解除]前のはず");
        assert!(pb.advance());
        assert!(!pb.is_blackout(), "[暗転解除]後の台詞はfalseに戻るはず");
    }

    #[test]
    fn blackout_on_called_twice_in_a_row_is_idempotent() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["前"]),
            blackout_on(),
            blackout_on(),
            dialog(Some("B"), vec!["暗転中"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(!pb.is_blackout(), "1件目の台詞はまだ暗転前のはず");
        assert!(pb.advance());
        assert!(
            pb.is_blackout(),
            "[暗転]を連続で2回出してもtrueのまま変化しないはず"
        );
    }

    #[test]
    fn blackout_off_without_prior_on_is_idempotent_noop() {
        let doc = doc_single_scene(vec![blackout_off(), dialog(Some("A"), vec!["普通の台詞"])]);
        let pb = Playback::from_document(&doc);
        assert!(
            !pb.is_blackout(),
            "暗転していない状態への[暗転解除]はfalseのままのはず"
        );
    }

    #[test]
    fn blackout_state_persists_across_scene_and_chapter_boundaries() {
        // `event_image_state_persists_across_scene_and_chapter_boundaries` の暗転版。
        // ch2は[場面転換]を挟まないため、ch1で[暗転]した状態がそのまま持続するはず
        // （scene_transition_resets_blackout_per_spec の「[場面転換]で解除される」ケースとの
        // 対比 — 明示的な解除が無ければ境界を越えても解除されない）。
        let ch1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![blackout_on(), dialog(Some("A"), vec!["ch1"])],
            )],
        );
        let ch2 = chapter(2, vec![scene("2-1", vec![dialog(Some("B"), vec!["ch2"])])]);
        let doc = document_with_chapters(vec![ch1, ch2]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "ch1の台詞からch2の台詞へ進めるはず");
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(
            pb.is_blackout(),
            "[場面転換]を挟まない限り、暗転状態はチャプター境界をまたいでも持続するはず"
        );
    }

    #[test]
    fn choice_event_does_not_affect_blackout_state() {
        // `choice_event_does_not_affect_event_image_state` の暗転版。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        blackout_on(),
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
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");

        assert!(
            pb.select_current_choice(),
            "有効な jump 先なので成功するはず"
        );
        assert!(
            pb.is_blackout(),
            "Choiceを挟んでも暗転状態はリセットされず、jump先のLineに引き継がれるはず"
        );
    }

    #[test]
    fn is_blackout_true_while_choice_is_current_item() {
        let doc = doc_single_scene(vec![
            blackout_on(),
            Event::Choice {
                options: vec![ChoiceOption {
                    text: "yes".to_string(),
                    jump: "1-1".to_string(),
                }],
            },
        ]);
        let pb = Playback::from_document(&doc);
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");
        assert!(
            pb.is_blackout(),
            "暗転中にChoice itemが現在位置にあるときもtrueを返すはず"
        );
    }

    #[test]
    fn is_blackout_false_at_document_start_with_zero_items() {
        let doc = doc_single_scene(vec![]);
        let pb = Playback::from_document(&doc);
        assert!(!pb.is_blackout(), "itemsが空のときはfalseのはず");
    }

    #[test]
    fn is_blackout_false_when_index_past_end() {
        // "1-1": [暗転]+台詞+Choice("1-2"へjump)、"1-2": イベント0件かつ最終シーン。
        // select_current_choice で index が items.len()（範囲外）になる
        // （既存回帰テスト `position_after_jumping_into_zero_item_last_scene_does_not_panic`
        // と同じ構図の暗転版）。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        blackout_on(),
                        dialog(Some("A"), vec!["どうする？"]),
                        Event::Choice {
                            options: vec![ChoiceOption {
                                text: "進む".to_string(),
                                jump: "1-2".to_string(),
                            }],
                        },
                    ],
                ),
                scene("1-2", vec![]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "台詞→Choiceへ進めるはず");
        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");
        assert!(pb.is_at_end(), "0件シーンへのjumpは末尾扱いのはず");

        assert!(
            !pb.is_blackout(),
            "indexが範囲外のときはpanicせずfalseを返すはず（直前が[暗転]中でも）"
        );
    }

    #[test]
    fn blackout_jump_target_uses_document_order_baked_state_not_dynamic() {
        // "1-1": [暗転]→台詞A（baked=true）→Choice("1-2"へ)
        // "1-2": [暗転解除]→台詞B（baked=false）→Choice("1-1"へ戻る)
        //
        // "1-2"（暗転off状態）から"1-1"へ戻ると、実行時の直前状態（off）が引き継がれるのでは
        // なく、ドキュメントを最初から線形走査した時点でその item に焼き付けられた値
        // （"1-1"の台詞Aはon）がそのまま復元されることを確認する。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        blackout_on(),
                        dialog(Some("A"), vec!["暗転中の台詞"]),
                        Event::Choice {
                            options: vec![ChoiceOption {
                                text: "進む".to_string(),
                                jump: "1-2".to_string(),
                            }],
                        },
                    ],
                ),
                scene(
                    "1-2",
                    vec![
                        blackout_off(),
                        dialog(Some("B"), vec!["解除後の台詞"]),
                        Event::Choice {
                            options: vec![ChoiceOption {
                                text: "戻る".to_string(),
                                jump: "1-1".to_string(),
                            }],
                        },
                    ],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.is_blackout(), "1-1の台詞Aは暗転中のはず");
        assert!(pb.advance(), "台詞A→Choiceへ進めるはず");
        assert!(pb.select_current_choice(), "1-2へjumpできるはず");
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(!pb.is_blackout(), "1-2の台詞Bは暗転解除後のはず");

        assert!(pb.advance(), "台詞B→Choiceへ進めるはず");
        assert!(pb.select_current_choice(), "1-1へ戻るjumpができるはず");
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("A"),
            "1-1のscene_startである台詞Aへ戻るはず"
        );
        assert!(
            pb.is_blackout(),
            "戻る直前(1-2)は暗転offだったが、jump先の状態はそこから引き継がれるのではなく、\
             ドキュメント走査時にそのitem自身に焼き付けられた値(on)であるはず"
        );
    }

    #[test]
    fn later_blackout_off_after_on_within_same_scene_toggles_mid_scene() {
        let doc = doc_single_scene(vec![
            blackout_on(),
            dialog(Some("A"), vec!["1回目の暗転中"]),
            blackout_off(),
            dialog(Some("B"), vec!["解除後"]),
            blackout_on(),
            dialog(Some("C"), vec!["2回目の暗転中"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.is_blackout(), "1回目の[暗転]直後はtrue");
        assert!(pb.advance());
        assert!(!pb.is_blackout(), "[暗転解除]直後はfalse");
        assert!(pb.advance());
        assert!(pb.is_blackout(), "2回目の[暗転]直後は再びtrue");
    }

    #[test]
    fn blackout_from_lines_constructor_defaults_to_false() {
        let mut pb = Playback::from_lines(vec![
            dline(Some("A"), vec!["1"]),
            dline(Some("B"), vec!["2"]),
        ]);
        assert!(
            !pb.is_blackout(),
            "from_lines経由のPlaybackはitem_blackoutが全件falseのはず"
        );
        assert!(pb.advance());
        assert!(!pb.is_blackout());
    }

    // ---- #475: 暗転で終わるイベント絵の自動連続表示（Wait直後のBlackoutを検出する拡張）----

    #[test]
    fn build_event_image_wait_followed_by_blackout_creates_terminal_blackout_item() {
        // Issue #475 の核心ケース: `[イベント絵:C][待機:200][暗転]` の後に会話行が一つも
        // 続かない（シーン末尾）。旧実装（#497単体）ではWaitの後に来るBlackoutを孤立イベント
        // として素通りさせるだけで、暗転を運ぶitemが生成されず、自動送りが着地する先が
        // 無いまま終わっていた。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["目を閉じていく"]),
            event_image("eyes_closing_3.webp"),
            wait(200),
            blackout_on(),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(!pb.is_blackout(), "会話行の時点ではまだ暗転していない");
        assert!(pb.advance(), "会話行から画像コマitemへ進めるはず");
        assert_eq!(pb.pending_wait_ms(), Some(200));
        assert!(!pb.is_blackout(), "画像コマ表示中はまだ暗転前のはず");

        assert!(
            pb.advance(),
            "待機経過後、暗転を運ぶ独立itemへ進めるはず（Issue #475本体）"
        );
        assert!(
            pb.is_blackout(),
            "着地したitemはis_blackout()==trueを返すはず"
        );
        assert_eq!(
            pb.pending_wait_ms(),
            None,
            "暗転item自体はさらなる自動送りを持たないはず"
        );
        assert!(
            pb.is_at_end(),
            "暗転itemがドキュメント最後のitemなので終端扱いのはず"
        );
        let line = pb
            .current_line()
            .expect("暗転itemも直前会話行を引き継いだDisplayLineを持つはず");
        assert_eq!(line.speaker.as_deref(), Some("A"));
        assert_eq!(
            line.event_image.as_deref(),
            Some("eyes_closing_3.webp"),
            "event_imageは直前の画像コマから引き継がれるはず"
        );
    }

    #[test]
    fn full_four_frame_chain_auto_advances_to_blackout_in_one_click_sequence() {
        // Issue #475 が明示的に挙げる原稿形: `[イベント絵:A][待機][イベント絵:B][待機]
        // [イベント絵:C][待機][暗転]`。3コマ分のWait連鎖をadvance()で辿った末に暗転へ
        // 着地することを確認する（4コマ目=暗転そのもの、という設計）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["目を開けている"]),
            event_image("eyes_1.webp"),
            wait(200),
            event_image("eyes_2.webp"),
            wait(200),
            event_image("eyes_3.webp"),
            wait(200),
            blackout_on(),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> 1コマ目");
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("eyes_1.webp")
        );
        assert!(pb.advance(), "1コマ目 -> 2コマ目");
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("eyes_2.webp")
        );
        assert!(pb.advance(), "2コマ目 -> 3コマ目");
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("eyes_3.webp")
        );
        assert!(!pb.is_blackout());

        assert!(pb.advance(), "3コマ目 -> 暗転itemへ");
        assert!(pb.is_blackout(), "連鎖の最後に暗転へ到達するはず");
        assert!(pb.is_at_end());
    }

    #[test]
    fn event_image_wait_blackout_pattern_consumes_exactly_three_events() {
        // Blackout検出により消費イベント数が2→3に変わるぶん、直後に続くはずの
        // 別イベントを誤って飲み込んでいないか（境界の1個ずれ）を確認する。
        let doc = doc_single_scene(vec![
            event_image("a.webp"),
            wait(100),
            blackout_on(),
            dialog(Some("B"), vec!["暗転後も台詞は続く"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        // ドキュメント先頭が既に画像コマitem（前に会話行が無い）なので、advance無しで
        // 最初から画像コマitemに位置している。
        assert_eq!(pb.pending_wait_ms(), Some(100));
        assert!(!pb.is_blackout(), "画像コマ表示中はまだ暗転前のはず");

        assert!(pb.advance(), "画像コマ -> 暗転item");
        assert!(pb.is_blackout());
        assert!(
            !pb.is_at_end(),
            "暗転itemの後にまだ台詞が残っているので終端ではないはず"
        );

        assert!(
            pb.advance(),
            "暗転item -> 次の台詞へ（3イベント消費の直後）"
        );
        let line = pb.current_line().expect("line");
        assert_eq!(line.speaker.as_deref(), Some("B"));
        assert!(
            pb.is_blackout(),
            "[暗転解除]が無い限り、後続の台詞も暗転状態を引き継ぐはず"
        );
    }

    #[test]
    fn event_image_wait_followed_by_blackout_off_also_creates_terminal_item() {
        // Issue #475 のスコープはBlackout::Onのみだが、実装はBlackoutのaction種別を
        // 区別せず同じ経路を通るため、Offも自然にカバーされる（無理に両対応する必要は
        // 無いが、実装が対応できているならそれでよいという方針の確認）。
        let doc = doc_single_scene(vec![
            blackout_on(),
            dialog(Some("A"), vec!["暗転中"]),
            event_image("a.webp"),
            wait(50),
            blackout_off(),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.is_blackout());

        assert!(pb.advance(), "台詞 -> 画像コマitemへ");
        assert!(pb.is_blackout(), "画像コマ表示中はまだ暗転解除前のはず");

        assert!(pb.advance(), "画像コマ -> 暗転解除itemへ");
        assert!(
            !pb.is_blackout(),
            "[暗転解除]を運ぶitemに着地したのでfalseになるはず"
        );
        assert!(pb.is_at_end());
    }

    #[test]
    fn item_blackout_stays_aligned_with_items_across_event_image_wait_chain() {
        // マージ由来のバグ回帰ガード: EventImage+Waitの高速パスがitem_blackoutへのpushを
        // 欠いていると、以降の全itemのis_blackout()判定がインデックス1個分ズレて誤った
        // 値を返すようになる（#512統合時に見落とされていた、#475実装時に発見）。
        // 画像コマitemを複数回経由した後も、暗転状態と直後の通常会話行の暗転状態の両方が
        // 正しく読めることを確認する。
        let doc = doc_single_scene(vec![
            blackout_on(),
            dialog(Some("A"), vec!["1"]),
            event_image("a.webp"),
            wait(10),
            event_image("b.webp"),
            wait(10),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.is_blackout(), "台詞Aの時点で暗転中");
        assert!(pb.advance(), "台詞A -> 画像コマ1");
        assert!(
            pb.is_blackout(),
            "画像コマ1もitem_blackoutのpush漏れなくtrueを読めるはず"
        );
        assert!(pb.advance(), "画像コマ1 -> 画像コマ2");
        assert!(pb.is_blackout(), "画像コマ2もtrueのはず");
        assert!(pb.advance(), "画像コマ2 -> 台詞B");
        let line = pb.current_line().expect("line");
        assert_eq!(
            line.speaker.as_deref(),
            Some("B"),
            "item_blackoutのズレが無ければ台詞Bに正しく着地するはず"
        );
        assert!(
            pb.is_blackout(),
            "台詞Bもindexズレが無ければ引き続き暗転中と読めるはず"
        );
        assert!(pb.is_at_end());
    }

    // ---- #475 追加分: Blackout誤検出の否定側・隣接パターンの明示的固定 ----

    #[test]
    fn build_event_image_wait_followed_by_choice_consumes_only_two_events_not_three() {
        // Wait直後がBlackoutではなくChoiceの場合、誤って3消費（Blackout用の分岐）に
        // ならず、従来どおり2消費のままChoiceが独立したPlaybackItem::Choiceとして
        // 生成されることを確認する（Blackout誤検出の否定側）。
        let doc = doc_single_scene(vec![
            event_image("a.webp"),
            wait(100),
            choice(vec![("進む", "dummy-target")]),
        ]);
        let mut pb = Playback::from_document(&doc);
        // ドキュメント先頭が既に画像コマitem（前に会話行が無い）。
        assert_eq!(pb.pending_wait_ms(), Some(100));
        assert!(!pb.is_blackout());

        assert!(
            pb.advance(),
            "画像コマ -> Choice item（2消費のまま、3消費でChoiceを飲み込まない）"
        );
        assert!(
            pb.current_choice().is_some(),
            "Choiceが暗転itemに化けず通常のChoiceとして現在位置になっているはず"
        );
        assert_eq!(
            pb.pending_wait_ms(),
            None,
            "Choice itemは自動送りを持たないはず"
        );
        assert!(
            !pb.is_blackout(),
            "Blackoutと誤検出されていなければ暗転状態はfalseのままのはず"
        );
    }

    #[test]
    fn build_event_image_wait_followed_by_narration_resumes_narration_line() {
        // Wait直後がDialogではなくNarrationの場合も、同じ「_」分岐の経路で正しく
        // PlaybackItem::Lineが生成されることを明示的に固定する回帰ガード。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["まもなく静かになる"]),
            event_image("a.webp"),
            wait(50),
            narration(vec!["静かな場面だった。"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> 画像コマitemへ");
        assert_eq!(pb.pending_wait_ms(), Some(50));

        assert!(pb.advance(), "画像コマ -> ナレーションitemへ");
        let line = pb.current_line().expect("ナレーション行があるはず");
        assert_eq!(line.speaker, None, "Narrationなのでspeakerは常にNoneのはず");
        assert_eq!(line.text, vec!["静かな場面だった。".to_string()]);
        assert_eq!(
            pb.pending_wait_ms(),
            None,
            "通常のLine itemは自動送りを持たないはず"
        );
        assert!(!pb.is_blackout());
    }

    #[test]
    fn build_event_image_wait_zero_ms_followed_by_blackout_still_creates_terminal_item() {
        // `[イベント絵][待機:0][暗転]`（ms=0とBlackout検出の組み合わせ）でも、Wait自体は
        // Some(0)として存在するため検出は素通りせず、3消費・暗転itemが正しく生成される
        // ことを確認する（Some(0)をNone扱いしてしまう実装だと壊れる境界）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["ゼロ待機のまま暗転"]),
            event_image("a.webp"),
            wait(0),
            blackout_on(),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> 画像コマitemへ");
        assert_eq!(
            pb.pending_wait_ms(),
            Some(0),
            "ms=0でもSome(0)として保持されるはず"
        );
        assert!(!pb.is_blackout());

        assert!(
            pb.advance(),
            "画像コマ -> 暗転itemへ（ms=0でも3消費されるはず）"
        );
        assert!(pb.is_blackout(), "暗転itemに正しく着地しているはず");
        assert_eq!(pb.pending_wait_ms(), None);
        assert!(pb.is_at_end());
    }

    #[test]
    fn build_event_image_wait_blackout_before_any_dialog_has_none_speaker_and_empty_text() {
        // 会話行が一度も無い状態で`[イベント絵][待機][暗転]`が来た場合、current_speaker/
        // current_textの初期値（None/空Vec）がそのまま暗転itemへ焼き付けられ、
        // speaker=None・text=空Vecになることを明示的に確認する。
        let doc = doc_single_scene(vec![event_image("a.webp"), wait(10), blackout_on()]);
        let mut pb = Playback::from_document(&doc);
        // ドキュメント先頭が既に画像コマitem。
        let first = pb.current_line().expect("画像コマのline");
        assert_eq!(first.speaker, None, "会話行が無いのでspeakerはNoneのはず");
        assert_eq!(
            first.text,
            Vec::<String>::new(),
            "会話行が無いのでtextは空Vecのはず"
        );

        assert!(pb.advance(), "画像コマ -> 暗転itemへ");
        assert!(pb.is_blackout());
        let line = pb.current_line().expect("暗転itemのline");
        assert_eq!(
            line.speaker, None,
            "暗転itemも会話行未経験のままspeaker=Noneを引き継ぐはず"
        );
        assert_eq!(
            line.text,
            Vec::<String>::new(),
            "暗転itemも会話行未経験のままtext=空Vecを引き継ぐはず"
        );
    }

    #[test]
    fn build_event_image_wait_blackout_then_wait_again_does_not_chain_further_automatically() {
        // `[イベント絵][待機][暗転][待機][イベント絵]`（暗転後にさらにWait連鎖が続く
        // ネストケース）。暗転itemは連鎖の終端であるという設計（モジュール冒頭docの
        // 「暗転item自体はさらなる自動送りを持たない」）どおり、2つ目のWaitは孤立Waitとして
        // 無視され（Dialog/Narrationではないためitem化されない）、後続のEventImageも
        // 単独のEventImage（直後にWaitが無い）なのでitem化されず、暗転itemの後には
        // 何のitemも増えないことを確認する。
        let doc = doc_single_scene(vec![
            event_image("a.webp"),
            wait(10),
            blackout_on(),
            wait(20),
            event_image("b.webp"),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.pending_wait_ms(), Some(10), "1つ目の画像コマitem");

        assert!(pb.advance(), "画像コマ -> 暗転itemへ");
        assert!(pb.is_blackout());
        assert_eq!(
            pb.pending_wait_ms(),
            None,
            "暗転item自体はさらなる自動送りを持たないはず"
        );
        assert!(
            pb.is_at_end(),
            "暗転後の[待機][イベント絵]は新たな連鎖を作らず、暗転itemが最後のitemのままのはず"
        );

        assert!(
            !pb.advance(),
            "終端の暗転itemからはこれ以上進めないはず（後続のEventImageへ自動で乗らない）"
        );
        assert!(
            pb.is_blackout(),
            "advance失敗後も暗転itemに留まっているはず"
        );
    }

    #[test]
    fn select_current_choice_resolves_correctly_when_blackout_item_is_only_item_in_target_scene() {
        // 選択肢確定によるシーンジャンプが、暗転itemが挟まる/暗転itemのみで構成される
        // シーン（このシーンのitemsは「画像コマ item」+「暗転item」の2件だけで、
        // 通常のLine itemを1件も持たない）でも、scene_startの解決とitem_blackoutの
        // インデックス整合が崩れないことを確認する。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["目を閉じる？"]),
                        choice(vec![("はい", "1-2")]),
                    ],
                ),
                scene(
                    "1-2",
                    vec![event_image("eyes_closed.webp"), wait(30), blackout_on()],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> Choiceへ");
        assert!(pb.current_choice().is_some());

        assert!(
            pb.select_current_choice(),
            "1-2への jump は成功するはず（1-2はitemを2件持つので有効なscene_start）"
        );
        assert!(
            !pb.is_blackout(),
            "jump直後は画像コマitemなのでまだ暗転前のはず"
        );
        assert_eq!(pb.pending_wait_ms(), Some(30));
        let line = pb.current_line().expect("画像コマのline");
        assert_eq!(line.event_image.as_deref(), Some("eyes_closed.webp"));

        assert!(
            pb.advance(),
            "画像コマ -> 暗転item（1-2シーン内で唯一の後続item）へ"
        );
        assert!(
            pb.is_blackout(),
            "jump先シーン内の暗転itemへ正しく着地しているはず"
        );
        assert!(
            pb.is_at_end(),
            "暗転itemがドキュメント最後のitemなので終端扱いのはず"
        );
    }

    #[test]
    fn event_image_wait_then_blackout_across_scene_boundary_is_not_detected() {
        // 既知の制約1（モジュール冒頭doc・#475コメント参照）を固定するテスト。
        // `[イベント絵][待機]` がシーンA末尾、`[暗転]` がシーンB先頭という原稿では、
        // Wait+Blackoutパターンの探索が `events.get(event_index + 1/+2)`
        // （`&scene.events` というシーンスコープのみ）しか見ないため、シーンBの
        // `[暗転]` を検出できず、暗転を運ぶ独立itemが生成されない（検出漏れ）。
        // 同一シーン内に収まるケースを固定した
        // `build_event_image_wait_followed_by_blackout_creates_terminal_blackout_item`
        // との対比で、シーン境界をまたぐと非対応になるという仕様上の制約を
        // コードレベルでも担保する。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["目を閉じていく"]),
                        event_image("eyes_closing_3.webp"),
                        wait(200),
                    ],
                ),
                scene("1-2", vec![blackout_on()]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> 画像コマitemへ");
        assert_eq!(pb.pending_wait_ms(), Some(200));
        assert!(!pb.is_blackout(), "画像コマ表示中はまだ暗転前のはず");

        // シーンBの[暗転]が検出漏れになるため、画像コマitemがそのままドキュメント
        // 最後のitemになってしまう（同一シーン内パターンなら、ここからさらに暗転item
        // へ進めるはずだった）。
        assert!(
            pb.is_at_end(),
            "シーン境界をまたいだBlackoutは検出されず画像コマitemが終端になる（既知の制約1）"
        );
        assert!(
            !pb.advance(),
            "検出漏れにより暗転item自体が存在せず進めない"
        );
        assert!(
            !pb.is_blackout(),
            "暗転itemが生成されないため、シーンBのBlackout::OnがcurrentBlackoutを\
             trueにしてもis_blackout()はfalseのまま反映されない"
        );
    }

    // ---- #524: Event::SceneTransition のイベント絵クリア（GUI版eventImageLayer.remove()整合）----

    /// `scene_transition_resets_blackout_per_spec` の event_image 版。既存テストは
    /// `is_blackout()` のみを検証しており、`[イベント絵][B台詞][場面転換][C台詞]` という
    /// 原稿で `[場面転換]` 後の `C` の `event_image` がクリアされることは未検証だった
    /// （#524 の回帰テスト）。
    #[test]
    fn scene_transition_clears_event_image_per_spec() {
        let doc = doc_single_scene(vec![
            event_image("bg_a.webp"),
            dialog(Some("B"), vec!["場面転換前の台詞"]),
            Event::SceneTransition,
            dialog(Some("C"), vec!["場面転換後の台詞"]),
        ]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("bg_a.webp"),
            "[場面転換]前の台詞はまだイベント絵を引き継いでいるはず"
        );

        assert!(pb.advance(), "場面転換後の台詞へ進めるはず");
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("C")
        );
        assert_eq!(
            pb.current_line().expect("line").event_image,
            None,
            "[場面転換]はGUI版のeventImageLayer.remove()相当でイベント絵もクリアするはず（#524）"
        );
    }

    // ---- #524: Wait直後のSceneTransition検出（#475 Blackout版と対になる拡張）----

    #[test]
    fn build_event_image_wait_followed_by_scene_transition_creates_terminal_item() {
        // `build_event_image_wait_followed_by_blackout_creates_terminal_blackout_item` の
        // Event::SceneTransition版（#524）。`[イベント絵][待機][場面転換]` で終わる原稿でも、
        // 場面転換後の状態（暗転解除＋イベント絵クリア）を焼き付けたitemが生成されるはず
        // （旧実装ではBlackoutとは非対称にitemが生成されなかった）。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["目を閉じていく"]),
            event_image("eyes_closing_3.webp"),
            wait(200),
            Event::SceneTransition,
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(!pb.is_blackout(), "会話行の時点ではまだ暗転していない");
        assert!(pb.advance(), "会話行から画像コマitemへ進めるはず");
        assert_eq!(pb.pending_wait_ms(), Some(200));
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("eyes_closing_3.webp")
        );

        assert!(
            pb.advance(),
            "待機経過後、場面転換後の状態を運ぶ独立itemへ進めるはず（Issue #524本体）"
        );
        assert!(
            !pb.is_blackout(),
            "着地したitemはis_blackout()==falseのはず（Blackout版と違い暗転は運ばない）"
        );
        assert_eq!(
            pb.current_line().expect("line").event_image,
            None,
            "終端itemはeventImageLayer.remove()相当でevent_imageがクリアされているはず"
        );
        assert_eq!(
            pb.pending_wait_ms(),
            None,
            "場面転換item自体はさらなる自動送りを持たないはず"
        );
        assert!(
            pb.is_at_end(),
            "場面転換itemがドキュメント最後のitemなので終端扱いのはず"
        );
    }

    #[test]
    fn event_image_wait_scene_transition_pattern_consumes_exactly_three_events() {
        // `event_image_wait_blackout_pattern_consumes_exactly_three_events` の
        // Event::SceneTransition版（#524）。SceneTransition検出により消費イベント数が
        // 2→3に変わるぶん、直後に続くはずの別イベントを誤って飲み込んでいないか
        // （境界の1個ずれ）を確認する。
        let doc = doc_single_scene(vec![
            event_image("a.webp"),
            wait(100),
            Event::SceneTransition,
            dialog(Some("B"), vec!["場面転換後も台詞は続く"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        // ドキュメント先頭が既に画像コマitem（前に会話行が無い）なので、advance無しで
        // 最初から画像コマitemに位置している。
        assert_eq!(pb.pending_wait_ms(), Some(100));

        assert!(pb.advance(), "画像コマ -> 場面転換後の状態を運ぶitemへ");
        assert!(!pb.is_blackout());
        assert_eq!(pb.current_line().expect("line").event_image, None);
        assert!(
            !pb.is_at_end(),
            "場面転換itemの後にまだ台詞が残っているので終端ではないはず"
        );

        assert!(
            pb.advance(),
            "場面転換item -> 次の台詞へ（3イベント消費の直後）"
        );
        let line = pb.current_line().expect("line");
        assert_eq!(line.speaker.as_deref(), Some("B"));
        assert_eq!(
            line.event_image, None,
            "[場面転換]で解除された状態を後続の台詞も引き継ぐはず"
        );
    }

    #[test]
    fn event_image_wait_then_scene_transition_across_scene_boundary_is_not_detected() {
        // `event_image_wait_then_blackout_across_scene_boundary_is_not_detected` の
        // Event::SceneTransition版（#524）。既知の制約1（`events` がシーンスコープのみを
        // 見る）はBlackoutだけでなくSceneTransitionにも同様に効く —
        // `[イベント絵][待機]` がシーンA末尾、`[場面転換]` がシーンB先頭という原稿では
        // このパターンに一致せず検出漏れになる。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["目を閉じていく"]),
                        event_image("eyes_closing_3.webp"),
                        wait(200),
                    ],
                ),
                scene("1-2", vec![Event::SceneTransition]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> 画像コマitemへ");
        assert_eq!(pb.pending_wait_ms(), Some(200));

        // シーンBの[場面転換]が検出漏れになるため、画像コマitemがそのままドキュメント
        // 最後のitemになってしまう（同一シーン内パターンなら、ここからさらに場面転換後
        // itemへ進めるはずだった）。
        assert!(
            pb.is_at_end(),
            "シーン境界をまたいだSceneTransitionは検出されず画像コマitemが終端になる（既知の制約1）"
        );
        assert!(
            !pb.advance(),
            "検出漏れにより場面転換を運ぶitem自体が存在せず進めない"
        );
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("eyes_closing_3.webp"),
            "場面転換itemが生成されないため、シーンBのSceneTransitionがcurrent_event_imageを\
             Noneにしてもevent_imageはクリア前の値のまま反映されない"
        );
    }

    #[test]
    fn event_image_wait_blackout_scene_transition_chain_only_creates_blackout_item() {
        // `[イベント絵][待機][暗転][場面転換]` という4連続パターン（#524で明示的に固定する
        // 現状の実装挙動）。Wait直後の検出は `if let Some(Blackout) ... else if
        // matches!(SceneTransition)` の順で判定するためBlackoutが優先され、Blackoutが
        // 見つかった時点でconsumed=3として打ち切る。後続のSceneTransitionはこの特別処理の
        // 対象にならず、通常のmatchアーム（`Event::SceneTransition => {..}`）でstateだけが
        // 更新されitemは生成されない。結果として暗転itemだけが生成され、SceneTransitionの
        // 効果（暗転解除・イベント絵クリア）はどのitemにも反映されない。
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["目を閉じていく"]),
            event_image("eyes_closing_3.webp"),
            wait(200),
            blackout_on(),
            Event::SceneTransition,
        ]);
        let mut pb = Playback::from_document(&doc);

        assert!(pb.advance(), "台詞 -> 画像コマitemへ");
        assert_eq!(pb.pending_wait_ms(), Some(200));
        assert!(!pb.is_blackout(), "画像コマ表示中はまだ暗転前のはず");

        assert!(
            pb.advance(),
            "画像コマ -> 暗転item（Blackoutが優先されSceneTransitionは検出対象にならない）"
        );
        assert!(
            pb.is_blackout(),
            "検出されたのはBlackoutのため、着地したitemはis_blackout()==trueのはず"
        );
        assert_eq!(
            pb.current_line().expect("line").event_image.as_deref(),
            Some("eyes_closing_3.webp"),
            "Blackout経路はcurrent_event_imageをクリアしないため引き継がれるはず"
        );
        assert!(
            pb.is_at_end(),
            "後続のSceneTransitionはstateを更新するだけでitemを生成しないため、\
             暗転itemがドキュメント最後のitemになるはず"
        );
        assert!(
            !pb.advance(),
            "SceneTransitionからitemが生成されないため、これ以上は進めない"
        );
    }
}
