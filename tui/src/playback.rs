//! パース済み `Document` を、TUI で逐次表示するための再生位置に変換する。
//!
//! 会話文（Dialog / Narration）の逐次表示に加え、選択肢分岐（`Event::Choice`）にも対応する
//! （#482）。フラグ管理・条件分岐（`Event::Flag`/`Event::Condition`）にも対応する（#509、
//! 詳細は後述）。セーブ/ロードは引き続き対象外（#501、別Issue）。背景・立ち絵演出などその他の
//! イベントは、今回も画面表示を変えないため読み飛ばす（左側は常にプレースホルダ表示のみ）。
//! `Event::EventImage`/`EventImageExit` だけは例外で、各 `DisplayLine` に `event_image`
//! （その時点で表示されているべきイベント絵の相対パス）として反映する（#481）。左側は
//! `event_image` が `None` のときのみ従来どおりプレースホルダ表示になる。`Event::Choice` は
//! この状態に影響しない（Choice イベントを挟んでも、直前までの `event_image` はそのまま
//! 後続の `DisplayLine` に引き継がれる）。`Event::Bgm`/`Event::Se` も同様に状態として追跡する
//! （画面表示は変えないが #502 で「読み飛ばし」対象から外れた）。詳細は [`Playback`] 構造体の
//! `item_bgm`/`item_se` フィールドの doc comment 参照。
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
//! **既知の制約2**（セルフレビュー対応、実データ未検証。実害が判明したら要対応）:
//! `[イベント絵][待機][暗転][場面転換]` のように `Wait` の直後で `Blackout` と
//! `SceneTransition` が連続する原稿では、検出は `Blackout` を優先し（`if let
//! Some(Blackout) ... else if SceneTransition` の順）、`Blackout` が見つかった時点で
//! 打ち切る。後続の `SceneTransition` は通常の match アーム（state 更新のみ、item は
//! 生成しない）に落ちるため、この並びが原稿の末尾ならターミナル item は暗転状態の
//! ままで、`SceneTransition` が本来行うはずの暗転解除・イベント絵クリアは画面に
//! 一度も反映されない（GUI版 `processDirective` は逐次実行のため両方とも確実に
//! 反映される点で TUI 版と異なる）。既知の制約1と同様、この並びを含む原稿は現状
//! Gymnasia 側に存在しないため実害は未確認。
//!
//! ## 選択肢分岐の設計 (#482)
//!
//! `Document` の chapters → scenes → events を一直線にフラット化する既存のシンプルな
//! モデル（#471 MVP、以前は `Event::Choice` を他の非表示イベントと同様に読み飛ばしていた）
//! だったが、#509 でシーン単位の動的追記モデルに置き換えた（詳細は次節）。Choice イベントは
//! `items`（旧 `lines`）の1要素（[`PlaybackItem::Choice`]）として保持する。選択肢が確定すると
//! `jump` 先シーンの内容をその時点の `flags` で新たに構築し、`items` の末尾に追記して遷移する
//! （[`Playback::select_current_choice`]）。
//!
//! GUI版 `NovelRenderer.jumpToScene`（`frontend/src/game/NovelRenderer.ts`）も `jump` 先を
//! シーンIDで解決する点は同じだが、GUI版は選ばれたシーンの `events` だけを新しい再生ストリーム
//! として張り直す（そのシーンの events を使い切ると `onEndCallback` で終劇になる、＝シーン境界を
//! 越えて自動的に後続シーンへ読み進めることはない）。対して TUI版は jump 先シーンの内容を
//! 読み終えると（GUI版のように終劇にはならず）ドキュメント順で後続シーンの内容までそのまま
//! 追記して読み進める、という設計上の違いがある（[`Playback::advance`] 参照）。GUI版ほど厳密な
//! シーン分離ではないが、既存の線形モデルをそのまま流用でき実装コストが小さいためこの簡略化を
//! 採用した（Issue #482 の実装方針で明示的に許容されている割り切り）。
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
//!
//! #496 が保護するのは「暗黙の前進」のみで、選択肢ジャンプ（[`Playback::select_current_choice`]）
//! による明示的なファイル境界越えは意図的に許可対象のままだが、ジャンプ元とジャンプ先が
//! 異なるファイル由来のとき、シーンを跨いで引き継ぐランニング状態（`SceneScanState` の
//! `current_bgm`/`current_event_image`/`current_blackout`/`pending_se`）には #496 と同種の
//! 保護が及んでいなかった（#528）。route1（file 0）の末尾が `[BGM: a.ogg]` 再生中のまま
//! route2（file 1）へジャンプすると、無関係な BGM やイベント絵が route2 冒頭まで
//! そのまま引き継がれてしまう実害があった（Gymnasia実データで確認）。#528 で
//! `select_current_choice` に、ジャンプ元とジャンプ先の `file_id` が異なる場合だけ上記4
//! フィールドをリセットしてから遷移先シーンを構築する処理を追加した。
//!
//! `current_speaker`/`current_text` は当初「Wait+EventImage自動連続表示専用フィールド
//! なので対象外」（#528のスコープ外）としていたが、独立レビュー（#540）で仕様
//! （`docs/spec/markdown-v0.1.md`）を確認したところ、`[イベント絵:][待機:Nms]` の
//! チェーンが会話行を経ずにシーン先頭へ直接置かれることを禁止する記述が無いと判明した。
//! ジャンプ先シーンの先頭がこのパターンで始まる場合、`current_speaker`/`current_text`
//! （ジャンプ元ファイルの最後の会話行）がリセットされないまま新しい `event_image` と
//! 組み合わさって表示されうる（例: route1最後の話者の台詞テキストが、route2冒頭の
//! 無関係な自動連続画像に上書きされずに乗る）。#528と同じ根本原因のため、#540で
//! `current_speaker`/`current_text` も上記4フィールドと同じリセット対象に合流させた。
//!
//! ## フラグ管理・条件分岐の遅延評価 (#509)
//!
//! `Event::Flag`/`Event::Condition` は、GUI版 `GameState`/`resolveEvents`
//! （`frontend/src/game/GameState.ts`）と同じ「実際にプレイヤーが辿った経路・その時点の
//! フラグ状態で評価する」遅延評価モデルで対応する。「フラグを立てろという命令は、その行に
//! 実際にたどり着いて実行されるまで効果を持たない」という順序を守る必要があるため、
//! ドキュメント全体を起動時に一括構築する方式（旧 #482 MVP のフラット化モデル）とは
//! 原理的に相容れない — 同じドキュメント上の位置でも、そこに至った経路（どの分岐を通ったか）
//! によってフラグ状態、ひいては `Event::Condition` の展開結果が変わりうるため、共有の静的
//! 配列に事前に焼き付けることができない。
//!
//! これを解決するため、`items` を「起動時に `Document` 全体を事前構築する」方式から
//! 「プレイヤーが実際に訪れたシーンだけ、訪れた順にその場で追記していく」方式に変更した。
//! [`Playback::build`] は最初のシーンだけを構築し、[`Playback::advance`]（ドキュメント順の
//! 自動継続）と [`Playback::select_current_choice`]（選択肢ジャンプ）は、次に必要になった
//! シーンをその時点の `flags`（[`GameFlags`]）で新たに構築して `items` に追記する。
//! `total()`/`is_at_end()` 等、全体像や先読みが必要な read-only メソッドは、実プレイ状態
//! （`self.flags`/`self.items`）を変更しない使い捨ての状態で試し計算する。
//!
//! `Event::Flag`/`Event::Condition` 自体は [`build_scene_items`] が、シーン内のイベント列を
//! 逐次 walk する中でリアルタイムに処理する（GUI版のように一括変換の純粋関数を都度呼び直す
//! のではなく、逐次 walk のループに直接組み込む設計）。`Event::Flag` に遭遇したら即座に
//! `flags.set()` で副作用を適用し、`Event::Condition` に遭遇したら `flags.check()` で判定して
//! 真なら内部 events を同じ関数に再帰的に渡す。これにより、同一シーン内で「Flag のすぐ後の
//! Condition」が正しく反応する（GUI版 `reResolveEvents` と同じ効果を1本のループで実現する）。

use std::collections::HashMap;

use name_name_parser::models::{BgmAction, BlackoutAction, ChoiceOption, Document, Event};

use crate::flags::GameFlags;
use crate::sentence;

/// 画面に表示する1行分の内容（話者名 + 本文 + その時点のイベント絵）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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
/// `Choice` の第2要素は `Event::Choice.columns`（グリッド配置の列数、#508）を基に
/// [`playback_item_from_event`] が選択肢数へクランプ済みの値。`None`/`Some(0)`/`Some(1)` は
/// いずれも従来どおりの縦一列表示を意味し、実際に「グリッドとして扱うか」の正規化（0や1を
/// どう1列と見なすか）は消費側（[`Playback::current_choice`]・カーソル移動系メソッド・
/// `ui::draw_choice_list`）が都度行う。上限側の正規化（選択肢数を超える列数の切り詰め）は
/// [`playback_item_from_event`] がここへ積む前に済ませてある（バグ修正、同関数の
/// doc コメント参照）。
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
    Choice(Vec<ChoiceOption>, Option<u32>),
}

/// `PlaybackItem` の中身から軽量なコンテンツハッシュを算出する。
///
/// [`Playback::stable_item_key`] が返す安定キーに、同メソッドの doc comment が挙げていた
/// 「既知の制約」（シーンの中身自体がフラグ状態に依存して変わる場合、`(scene_idx,
/// local_index)` だけでは異なる内容の item を同一視してしまう）を解消するために付加する
/// 第3要素として使う。`(scene_idx, local_index)` が同じでも中身（話者・本文・イベント絵・
/// 選択肢）が異なれば別のハッシュ値になるため、呼び出し側（`main.rs` の `read_positions`）は
/// 3つ組全体を比較することで「本当に同じ内容を読んだか」まで判定できる。
///
/// `DisplayLine`（`Line`/`Image` 両方が内部で持つ型）は `#[derive(Hash)]` 済みのため
/// そのままハッシュに流し込むだけでよい。`Choice` は `ChoiceOption` が `Hash` を実装して
/// いないため、`text`/`jump` を個別にハッシュへ流し込む。
///
/// 「中身が異なれば別のハッシュ値になる」は、64bit `DefaultHasher` の衝突耐性に依存した
/// 近似的な保証であり、理論上は異なる内容が同じハッシュ値になる可能性がゼロではない
/// （が、1セッション内で再生される item 数という実用スケールでは無視できる、#539）。
fn content_signature(item: &PlaybackItem) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    match item {
        // variant判別用の1バイトを先頭に混ぜる。中身の `DisplayLine` が偶然同一でも
        // `Line`/`Image` は別のitem種別として扱うため、variantを区別しないと
        // ハッシュが衝突してしまう（セルフレビュー指摘、#533）。
        PlaybackItem::Line(line) => {
            hasher.write_u8(0);
            line.hash(&mut hasher);
        }
        PlaybackItem::Image(line) => {
            hasher.write_u8(1);
            line.hash(&mut hasher);
        }
        PlaybackItem::Choice(options, columns) => {
            hasher.write_u8(2);
            for option in options {
                option.text.hash(&mut hasher);
                option.jump.hash(&mut hasher);
            }
            columns.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// ドキュメント順（chapters→scenes の順）に並んだ、各シーンの参照情報。
///
/// `Playback::scene_order` / `scene_index_by_id` が保持する（#509 Phase B）。フラグに
/// 依存しない構造的な情報のみを保持する — `scene_id`/`file_id`（由来ファイル id、
/// `item_file_ids` と同じ意味）に加え、そのシーンの生イベント列を丸ごと複製して持つ。
/// `advance()`/`select_current_choice()` が、プレイヤーが実際にそのシーンへ到達した
/// 時点で `events` を `build_scene_items` にそのまま渡し、Flag/Condition をその場の
/// フラグ状態でリアルタイムに評価させる（`Playback` 構造体の doc コメント参照）。
struct SceneRef {
    /// `scene_index_by_id` の構築時にキーとして使うだけで、構築後は読み出されない
    /// （デバッグ時の可読性のために保持している）。
    #[allow(dead_code)]
    scene_id: String,
    file_id: usize,
    events: Vec<Event>,
}

/// `Event` を再生列の1要素に変換する。Choice は選択肢一覧とグリッド列数をそのまま保持する
/// `PlaybackItem::Choice` に、Dialog/Narration は [`display_line_from_event`] 経由で
/// `PlaybackItem::Line` になる。それ以外（背景・SE・BGM 等）は `None`（読み飛ばす）。
///
/// `options` が空の Choice（原稿の `[選択]\n[/選択]` のように中身が無いブロック。parser は
/// これを許容する）も `None` にして読み飛ばす。空 Choice をそのまま item 化すると、
/// `options.get(0)` が常に `None` になるため `select_current_choice` が恒久的に失敗し、
/// `advance` も Choice 表示中は拒否するため、プレイヤーの入力を一切受け付けない詰み状態に
/// なる。これは以前の「Choice を丸ごと無視していた」挙動と同じ扱いに揃えることで回避する
/// （バグ修正、実装方針は Issue #482 コメント参照）。
///
/// `columns` は選択肢数（`options.len()`）を超えないようクランプする（バグ修正、#508）。
/// parser の `parse_choice_columns` は `u32 >= 1` ならどんな巨大な値も受理し上限
/// バリデーションを持たない。`[選択: 列=200000]` のような原稿（タイプミスや意図的な巨大値）が
/// そのまま通ると、`ui::draw_choice_grid` が `columns` 個の `Constraint` を生成して
/// ratatui の `Layout::split`（cassowary線形制約ソルバー）に渡すことになり、実機で2分以上
/// 応答が返らずSIGKILLが必要になる実害のあるハングを引き起こす（レビューで実測）。選択肢の
/// 実数より多い列数を作る正当な理由は無い（列が余るだけ）ため、ここでクランプするのが唯一の
/// 発生源であり、以降 `current_choice()`・`effective_columns()`・`move_choice_cursor_down`/
/// `right`（いずれも `items` から直接 `columns` を読む）が呼び出し箇所を問わず自動的に妥当な
/// 値だけを見るようになる。`ui::draw_choice_grid` 側にも同種のクランプを多重に入れてある
/// （呼び出し元を問わない多重防御。実害のあるハングだったため）。
fn playback_item_from_event(event: &Event) -> Option<PlaybackItem> {
    match event {
        Event::Choice { options, .. } if options.is_empty() => None,
        Event::Choice { options, columns } => {
            let clamped = columns.map(|c| c.min(options.len() as u32));
            Some(PlaybackItem::Choice(options.clone(), clamped))
        }
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
    /// （[`Playback::item_index`] の変化）を検出したときに一度だけ消費するトリガとして扱う想定。
    /// ドキュメント末尾以降に出現した SE（後続 item が存在しない）は、どの item にも属せない
    /// ため再生対象にならない（既知の制約、影響は軽微）。
    item_se: Vec<Vec<String>>,
    /// `items[i]` の、シーンを跨いで安定な識別子（`(scene_order 内インデックス, その
    /// シーン内での構築順インデックス)`、#499/#509統合）。`items` と同じ長さを常に保つ
    /// （`item_file_ids` と同じ並行 Vec のパターン）。詳細・既知の制約は
    /// [`Playback::stable_item_key`] の doc comment参照。
    item_scene_key: Vec<(usize, usize)>,
    /// `items[i]` の [`content_signature`] をあらかじめ計算してキャッシュしたもの
    /// （`item_scene_key` と同じ並行 Vec のパターン、#539）。`stable_item_key` が呼ばれる
    /// たびに毎回再計算していた（`main.rs` では同一 item に対し最低2回、既読判定と
    /// 既読マークの両方で呼ばれる）のを避ける — `append_stable_item_keys` が
    /// `item_scene_key` を積むのと同じタイミング（item構築直後の1回きり）で一緒に計算する。
    item_content_hash: Vec<u64>,
    index: usize,
    /// ドキュメント順（chapters→scenes の順）に並んだ、各シーンの参照情報。
    /// `from_document`/`from_merged_document` で埋まる。`advance`/`select_current_choice` が
    /// 次に構築すべきシーンを引くのに使う（#509 Phase B、モジュール冒頭のドキュメント参照）。
    /// `from_lines` 経由の構築では空のまま。
    scene_order: Vec<SceneRef>,
    /// シーンID → `scene_order` 内のインデックス。`select_current_choice` が `jump` 先の
    /// 解決に使う（#509 Phase B、ジャンプ先解決手段）。`from_lines`
    /// 経由の構築では空のまま。
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
    /// [`Playback::total`] の結果キャッシュ（世代番号, 対象ファイルid, 値）。`total()` は
    /// 現在のファイルに属するシーンだけを独立に再スキャンする重い処理だが、結果は
    /// `self.flags` と現在のファイルが変化しない限り変わらない（セルフレビュー対応、#509。
    /// スコープを「現在ファイル単位」に変更、#565）。`main.rs::event_loop` が `REDRAW`＝
    /// 30msごとに無条件で `total()` を呼ぶため、フラグ・ファイルのどちらも変わっていない
    /// フレームでは再スキャンを省略する。ファイルidをキャッシュキーに含めるのは、選択肢で
    /// 別ファイルへジャンプした直後にフラグ世代が変わらないまま分母だけ変わるケースを
    /// 取りこぼさないため（#565）。`total()` は `&self` のままキャッシュを更新したいため
    /// `Cell` で内部可変性を持たせる（`RefCell` ではなく `Cell` で十分 — 中身が `Copy` な
    /// `(u64, Option<usize>, usize)` のため）。
    total_cache: std::cell::Cell<Option<(u64, Option<usize>, usize)>>,
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
    /// 現在再生されているべき BGM のパス（`Event::Bgm`、#502）。`current_event_image`/
    /// `current_blackout` と同じ「シーン・チャプター境界をまたいで引き継ぐ宣言的 state」
    /// パターン（`Playback` 構造体の `item_bgm` doc comment参照）。
    current_bgm: Option<String>,
    /// 直前の item から現在位置までの間に出現した `[SE:]` の出現順一覧（#502）。次に item が
    /// push されるタイミングで `item_se` へ焼き付けられ、その場で空に戻る
    /// （`Playback` 構造体の `item_se` doc comment参照）。
    pending_se: Vec<String>,
}

/// 1シーン分の生イベント列を処理し、items系のVecへ積む。`Playback::build` から各シーンごとに
/// 呼ばれる、シーンを跨いで引き継ぐランニング状態（`current_event_image` 等、`state` にまとめて
/// ある）は呼び出し側が保持し、可変参照として受け渡す（#509 Phase A、後でシーン単位に動的
/// 呼び出しできるようにするための下ごしらえ。ロジックは `Playback::build` から一切変更せず
/// 丸ごと移動しただけ）。
///
/// `flags`（#509 のフラグ管理）を `state`（`SceneScanState`）にまとめず独立の引数のまま
/// 追加したため合計8引数になり `clippy::too_many_arguments`（既定閾値7）に抵触する
/// （#502 の `item_bgm`/`item_se` 追加で現在は10引数）。`SceneScanState` は元々
/// 「シーンを跨いで引き継ぐランニング状態」専用の入れ物として導入された経緯があり、
/// 性質の異なる `GameFlags` をそこに押し込むのは筋が悪いため、ここでは構造変更を避けて
/// `allow` で抑止するに留める。
/// Wait 直後の Blackout/SceneTransition 検出（#475/#524）が共通で行う、「その時点の
/// `state`（呼び出し側で望む終端状態へ更新済み）を1つの画像コマ item として焼き付けて
/// 4本の並行 Vec へ積む」処理をまとめたもの（セルフレビュー対応、重複除去）。この item は
/// さらなる自動送りを持たない（`item_wait_ms` は常に `None`）— 「閉じきった最後のコマで
/// 状態が切り替わる」で連鎖は完結し、この item から別の item へ自動で進む理由が無いため。
/// BGM/SE の並行 Vec が増えたことで8引数になり `clippy::too_many_arguments`
/// （既定閾値7）に抵触する（#502）。`build_scene_items` と同じ理由で `allow` に留める。
#[allow(clippy::too_many_arguments)]
fn push_wait_chain_terminal_item(
    state: &mut SceneScanState,
    file_id: usize,
    items: &mut Vec<PlaybackItem>,
    item_file_ids: &mut Vec<usize>,
    item_wait_ms: &mut Vec<Option<u32>>,
    item_blackout: &mut Vec<bool>,
    item_bgm: &mut Vec<Option<String>>,
    item_se: &mut Vec<Vec<String>>,
) {
    items.push(PlaybackItem::Image(DisplayLine {
        speaker: state.current_speaker.clone(),
        text: state.current_text.clone(),
        event_image: state.current_event_image.clone(),
    }));
    item_file_ids.push(file_id);
    item_wait_ms.push(None);
    item_blackout.push(state.current_blackout);
    // BGM/SE も他の並行 Vec と同じくこの合成 item に焼き付ける（#502）。この item を
    // 経由しても pending な SE を取りこぼさないよう、他の push サイトと同じく
    // `mem::take` で消費する。
    item_bgm.push(state.current_bgm.clone());
    item_se.push(std::mem::take(&mut state.pending_se));
}

/// `build_scene_items` の1回の呼び出し（内部の `Event::Condition` 再帰も含む）が
/// `items` に追加した範囲 `[start..items.len())` の各 item へ、`(scene_idx, シーン内での
/// 構築順インデックス)` の安定キーを割り当てて `item_scene_key` へ積む
/// （[`Playback::stable_item_key`] の doc comment参照、#499/#509統合）。同じ範囲の各 item の
/// [`content_signature`] も同時に計算して `item_content_hash` へ積む（#539、`stable_item_key`
/// が呼ばれるたびの再計算を避けるキャッシュ）。
///
/// `build_scene_items` 自体（および `push_wait_chain_terminal_item`）のシグネチャは
/// 変更していない — 呼び出し側（`Playback::build`/`advance`/`select_current_choice`）が
/// 既に把握している「このシーンの構築がどこから始まったか」（`start`）から事後的に
/// 範囲を割り出すだけなので、`Event::Condition` の再帰呼び出しを含む全ての push サイトを
/// 個別に変更する必要がない。
fn append_stable_item_keys(
    items: &[PlaybackItem],
    item_scene_key: &mut Vec<(usize, usize)>,
    item_content_hash: &mut Vec<u64>,
    scene_idx: usize,
    start: usize,
    end: usize,
) {
    for (local_index, item) in items[start..end].iter().enumerate() {
        item_scene_key.push((scene_idx, local_index));
        item_content_hash.push(content_signature(item));
    }
}

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
    item_bgm: &mut Vec<Option<String>>,
    item_se: &mut Vec<Vec<String>>,
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
                    // BGM/SE も他の並行 Vec と同じくこの画像コマ item に焼き付ける（#502）。
                    item_bgm.push(state.current_bgm.clone());
                    item_se.push(std::mem::take(&mut state.pending_se));

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
                    //
                    // 既知の制約2（モジュール冒頭doc参照）: 下の分岐は `if let
                    // Some(Blackout) ... else if SceneTransition` の順で判定するため
                    // Blackout を優先する。`Wait` の直後に Blackout と SceneTransition が
                    // 両方続く原稿（`[イベント絵][待機][暗転][場面転換]`）では、Blackout側
                    // で打ち切られ後続の SceneTransition は item を生成しない state 更新
                    // のみになる。
                    let mut consumed = 2;
                    if let Some(Event::Blackout { action }) = events.get(event_index + 2) {
                        state.current_blackout = matches!(action, BlackoutAction::On);
                        push_wait_chain_terminal_item(
                            state,
                            file_id,
                            items,
                            item_file_ids,
                            item_wait_ms,
                            item_blackout,
                            item_bgm,
                            item_se,
                        );
                        consumed = 3;
                    } else if matches!(events.get(event_index + 2), Some(Event::SceneTransition)) {
                        state.current_blackout = false;
                        state.current_event_image = None;
                        push_wait_chain_terminal_item(
                            state,
                            file_id,
                            items,
                            item_file_ids,
                            item_wait_ms,
                            item_blackout,
                            item_bgm,
                            item_se,
                        );
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
            // GUI版 `NovelRenderer` の `'Bgm' in event` 分岐（`audioManager.playBgm`/
            // `stopBgm`）と同じ意味論（#502）。`action === 'Play' && path` の両方が
            // 揃わない限り「停止」扱いになる GUI版の挙動をそのまま再現する
            // （`action: Play` でも `path: None` なら停止 — 通常の原稿では起こらない
            // 組み合わせだが、フォールバックとして GUI版に揃える）。`fade_ms` は
            // `Event::EventImage` の `fade_ms` と同じ理由で意図的に捨てる（TUIは
            // フェード無しの即時切り替え、MVPスコープ）。
            Event::Bgm { path, action, .. } => {
                state.current_bgm = match (action, path) {
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
                state.pending_se.push(path.clone());
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
                        item_bgm,
                        item_se,
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
                        choice @ PlaybackItem::Choice(_, _) => choice,
                        // `playback_item_from_event` は Dialog/Narration/Choice
                        // からしか item を作らないため Image は返さない
                        // （Image は上の EventImage+Wait 分岐でのみ生成される）。
                        image @ PlaybackItem::Image(_) => image,
                    };
                    items.push(item);
                    item_file_ids.push(file_id);
                    item_wait_ms.push(None);
                    item_blackout.push(state.current_blackout);
                    item_bgm.push(state.current_bgm.clone());
                    item_se.push(std::mem::take(&mut state.pending_se));
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
        let mut item_bgm = Vec::new();
        let mut item_se: Vec<Vec<String>> = Vec::new();
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
            current_bgm: None,
            pending_se: Vec::new(),
        };
        let mut flags = GameFlags::new();
        for (chapter_index, chapter) in doc.chapters.iter().enumerate() {
            let file_id = chapter_file_ids
                .map(|ids| ids.get(chapter_index).copied().unwrap_or(chapter_index))
                .unwrap_or(0);
            for scene in &chapter.scenes {
                // 重複シーンIDは最初の出現を優先する（GUI版 `allScenes.find` が最初の一致を
                // 返すのと同じ規約）。
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
        let mut item_scene_key = Vec::new();
        let mut item_content_hash = Vec::new();
        if let Some(first_scene) = scene_order.first() {
            let start = items.len();
            build_scene_items(
                &first_scene.events,
                first_scene.file_id,
                &mut scan_state,
                &mut flags,
                &mut items,
                &mut item_file_ids,
                &mut item_wait_ms,
                &mut item_blackout,
                &mut item_bgm,
                &mut item_se,
            );
            append_stable_item_keys(
                &items,
                &mut item_scene_key,
                &mut item_content_hash,
                0,
                start,
                items.len(),
            );
        }
        Self {
            items,
            item_file_ids,
            item_wait_ms,
            item_blackout,
            item_bgm,
            item_se,
            item_scene_key,
            item_content_hash,
            index: 0,
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
            total_cache: std::cell::Cell::new(None),
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
    /// （`event_loop`）は [`Playback::item_index`] の変化（＝この item への新規到達）を検出
    /// したときだけ、この一覧を消費して1回だけ再生する想定（`item_se` の doc comment 参照）。
    /// `item_index()` は `PlaybackItem::Image`（#497）へのクロスフェード判定が使っているのと
    /// 同じ「生の items インデックス」で、専用の `cursor()` を別途持たずそのまま流用できる —
    /// [`Playback::position`]（Line item のみを数える会話行番号）と異なり Choice item への
    /// 遷移でも変化する一方、`sentence_per_page` による同一 Line item 内の文送りでは変化しない
    /// （同じ item に紐づく SE を文送りのたびに再トリガーしない、という意図した挙動でもある）。
    pub fn current_se_cues(&self) -> &[String] {
        self.item_se
            .get(self.index)
            .map(Vec::as_slice)
            .unwrap_or(&[])
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

    /// 現在位置が選択肢なら `(選択肢一覧, カーソル位置, グリッド列数)` を返す。会話行の途中や
    /// 末尾越えでは `None`。3番目の要素は `Event::Choice.columns`（#508）をそのまま渡す —
    /// `None`/`Some(0)`/`Some(1)` はいずれも従来どおりの縦一列表示を意味し、その正規化は
    /// 呼び出し側（`ui::draw_choice_list` 等）が行う。
    pub fn current_choice(&self) -> Option<(&[ChoiceOption], usize, Option<u32>)> {
        match self.items.get(self.index) {
            Some(PlaybackItem::Choice(options, columns)) => {
                Some((options.as_slice(), self.choice_cursor, *columns))
            }
            _ => None,
        }
    }

    /// 現在Choice表示中なら、正規化済みの有効列数（`None`/`0`/`1` はいずれも「非グリッド
    /// 1列」として `1` に丸める）を返す。上限側（選択肢数を超える列数）は `items` に積む
    /// 時点（[`playback_item_from_event`]）で既にクランプ済みのため、ここでは行わない。
    /// Choice表示中でなければ `None`（#508、カーソル移動系メソッド共通のヘルパー）。
    fn effective_columns(&self) -> Option<usize> {
        match self.items.get(self.index) {
            Some(PlaybackItem::Choice(_, columns)) => Some(columns.unwrap_or(1).max(1) as usize),
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
    /// 画像コマへの遷移を検知し損ねる。SE のワンショット再生（#502）も同じ signal で
    /// 「新しい item に到達した瞬間」を検出する（[`Playback::current_se_cues`] のdoc
    /// comment参照）— Choice item への遷移でも変化する一方、`sentence_per_page` による
    /// 同一 Line item 内の文送りでは変化しないため、同じ item に紐づく SE を文送りのたびに
    /// 再トリガーしない、という意図した挙動にもなる。
    pub(crate) fn item_index(&self) -> usize {
        self.index
    }

    /// `item_index()` が指しうる生インデックス `item_index` を、シーンを跨いで安定な
    /// 識別子（`(scene_order 内インデックス, そのシーン内での構築順インデックス,
    /// コンテンツハッシュ)`）に変換する。`item_index` が範囲外（`items.len()` 以上）なら
    /// `None`。
    ///
    /// #509 で `items` が「プレイヤーが実際に訪れたシーンだけを訪れた順にその場で末尾へ
    /// 追記する」遅延構築モデルに変わった（モジュール冒頭のドキュメント参照）。
    /// `select_current_choice`/`advance` は、既に訪れたことのあるシーンへ戻る場合でも
    /// 既存の `items` を再利用せず、常に `build_scene_items` でそのシーンを新規に構築して
    /// `items` 末尾へ追記する — そのため生の `item_index()`（や `position()`）は、同じ
    /// シーンの同じ箇所に再訪しても毎回異なる値になる。#499 スキップモードの
    /// `read_positions`（`main.rs::event_loop`）は「以前ここを読んだか」を素朴な位置比較
    /// （`position()` の値をそのまま集合のキーにする）で判定していたため、#509 の遅延構築
    /// モデルと統合した際にこの前提が崩れ、既読判定が機能しなくなっていた（バグ、再訪→
    /// スキップのシナリオで発覚）。
    ///
    /// このメソッドはその代わりに使う安定キーを返す。同じシーンへ同じフラグ状態
    /// （`self.flags`）で再訪した場合、`build_scene_items` は毎回同じイベント列を同じ順序で
    /// 処理するため、シーン内の同じ相対位置に生成される item は毎回同じキーになる —
    /// 呼び出し側（`main.rs`）はこちらを集合のキーにすることで「本当に同じ箇所へ戻って
    /// きたか」を正しく判定できる。
    ///
    /// 第3要素は [`content_signature`] が item の中身（話者・本文・イベント絵、または
    /// 選択肢のテキスト・ジャンプ先・列数）から算出するコンテンツハッシュ（#533）。
    /// `(scene_idx, local_index)` の2つ組だけでは、シーンの中身自体がフラグ状態に
    /// 依存して変わる場合（`Event::Condition` で条件分岐する行を含むシーンを、1回目と
    /// 2回目で異なるフラグ状態で訪れた場合）に取り違えが起きうる — シーン内で構築される
    /// item 数自体は毎回同じでも、`Condition` の分岐によって「ローカルindex Nの item」が
    /// 指す内容（話者・本文・選択肢）が訪問ごとに異なりうるため（実例:
    /// `gymnasia/docs/scripts/drafts/interludes.md` の `hub_gate` シーン、9個の
    /// `milestone_*_pending` Condition ブロックが排他的に1個ずつ真になる）。コンテンツ
    /// ハッシュを3つ目のキー要素として加えることで、`(scene_idx, local_index)` が
    /// 一致していても中身が異なれば別キー扱いになり、この取り違えを解消する。
    ///
    /// 元Issue #533は、シーン内で構築される item 数自体が訪問ごとにずれるケース
    /// （`Condition` ブロックの分岐先で件数の異なるイベント列が展開される場合）も
    /// 懸念として挙げていた。この場合も「ローカルindex Nの item」が指す内容自体が
    /// 訪問ごとに変わる点は上記の件数不変ケースと同じであり、コンテンツハッシュが
    /// そのまま副次的にカバーする（#539で検証、
    /// `stable_item_key_content_hash_differs_when_flag_dependent_scene_item_count_itself_shifts_across_revisits`
    /// テスト参照）。ただし「絶対に取り違えが起きない」わけではなく、[`content_signature`]
    /// の doc comment が挙げる64bit `DefaultHasher` の衝突（理論上ゼロではないが実用
    /// スケールでは無視できる）が起きない限り、という限定付きの保証である。
    ///
    /// **呼び出し規約（#558フォローアップ）**: `item_scene_key`/`item_content_hash` は
    /// `advance()`/`select_current_choice()` などシーン構築系メソッドの呼び出し中に、
    /// そのシーンの item 群を新規構築するたびに末尾へ追記される（append-only）。そのため、
    /// ある時点の状態を表す `stable_item_key` の値を「before値」として使いたい場合は、
    /// その状態を動かすメソッド呼び出しより**前**に計算しておく必要がある。呼び出し後に
    /// 同じ `item_index` で呼び直すと、その間に新しく構築された item のキーを誤って
    /// 指してしまう可能性がある（`item_index` が呼び出し前は範囲外だった場合に特に顕著 —
    /// 呼び出し後は新規構築されたシーンの item を指すようになり、`None` ではなく誤った
    /// `Some` が返る）。`main.rs::event_loop` が `on_advance` 実行前に
    /// `prev_stable_key` を計算しているのはこの規約に従うため。
    pub(crate) fn stable_item_key(&self, item_index: usize) -> Option<(usize, usize, u64)> {
        let (scene_idx, local_index) = self.item_scene_key.get(item_index).copied()?;
        // `content_signature` を都度呼ばず、`append_stable_item_keys` が item 構築直後の
        // 1回だけ計算してキャッシュした値を読む（#539、nit対応）。
        let content_hash = self.item_content_hash.get(item_index).copied()?;
        Some((scene_idx, local_index, content_hash))
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
        if matches!(self.items.get(self.index), Some(PlaybackItem::Choice(_, _))) {
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
            let file_id = next_scene.file_id;
            build_scene_items(
                &next_scene.events,
                file_id,
                &mut self.scan_state,
                &mut self.flags,
                &mut self.items,
                &mut self.item_file_ids,
                &mut self.item_wait_ms,
                &mut self.item_blackout,
                &mut self.item_bgm,
                &mut self.item_se,
            );
            append_stable_item_keys(
                &self.items,
                &mut self.item_scene_key,
                &mut self.item_content_hash,
                next_scene_idx,
                start,
                self.items.len(),
            );
            self.current_scene_idx = next_scene_idx;
            if self.items.len() > start {
                self.set_index(start);
                return true;
            }
            // このシーンはitemを1件も生成しなかった。さらに次のシーンへ。
        }
    }

    /// 選択肢表示中のみ有効。カーソルを1つ上の行へ動かす（先頭行で頭打ち、末尾行への
    /// ラップはしない）。選択肢を表示していないときの呼び出しは no-op。
    ///
    /// グリッド表示（列数 >= 2、#508の`[選択: 列=N]`）では「1つ上の行の同じ列」へ移動する。
    /// 非グリッド（列数1）では従来どおり「1つ前の要素」に一致する — 列数1のときは
    /// 行=要素index・列=常に0になるため、特別扱いせず同じ計算式で両方を扱える。
    pub fn move_choice_cursor_up(&mut self) {
        let Some(columns) = self.effective_columns() else {
            return;
        };
        if self.choice_cursor >= columns {
            self.choice_cursor -= columns;
        }
        // else: 先頭行なので頭打ち（従来の非グリッド時と同じ「先頭で頭打ち」規約を踏襲）。
    }

    /// 選択肢表示中のみ有効。カーソルを1つ下の行へ動かす（末尾行で頭打ち、先頭行への
    /// ラップはしない）。選択肢を表示していないときの呼び出しは no-op。
    ///
    /// グリッド表示では「1つ下の行の同じ列」へ移動する。ただし総数が列数で割り切れず
    /// 最終行が途中までしか埋まっていない場合（例: 7要素・3列なら最終行は index 6 の
    /// 1要素だけ）、移動先の列に要素が存在しないことがある。この場合はテキストエディタの
    /// カーソル移動が短い行の末尾に寄せるのと同じ発想で、その行の最後の要素へ寄せる
    /// （設計判断: 「存在しない列へは移動できず何もしない」より「近い有効な位置へ寄る」
    /// 方が、短い最終行にある選択肢へも上下キーだけで到達できて自然だと判断した。GUI版は
    /// キーボード操作を持たないため参考にできる先例が無く、これはTUI独自の判断）。
    /// 非グリッド（列数1）では従来どおり「1つ次の要素」に一致する。
    pub fn move_choice_cursor_down(&mut self) {
        let Some(columns) = self.effective_columns() else {
            return;
        };
        let Some(PlaybackItem::Choice(options, _)) = self.items.get(self.index) else {
            return;
        };
        let total = options.len();
        let row = self.choice_cursor / columns;
        let rows = total.div_ceil(columns);
        if row + 1 >= rows {
            return; // 最終行なので頭打ち
        }
        let col = self.choice_cursor % columns;
        let target_row = row + 1;
        self.choice_cursor = (target_row * columns + col).min(total - 1);
    }

    /// 選択肢表示中かつグリッド表示（列数 >= 2、#508）のときのみ意味を持つ。カーソルを
    /// 同じ行内で1つ左へ動かす（行の先頭列で頭打ち、前の行の末尾へのラップはしない —
    /// 上下カーソルの「頭打ち・ラップしない」規約をそのまま左右にも適用した設計判断）。
    /// 非グリッド（列数1）では常に no-op（列が1つしかないため左右移動という概念自体が
    /// 無い）。選択肢を表示していないときの呼び出しも no-op。
    pub fn move_choice_cursor_left(&mut self) {
        let Some(columns) = self.effective_columns() else {
            return;
        };
        if columns <= 1 {
            return;
        }
        if !self.choice_cursor.is_multiple_of(columns) {
            self.choice_cursor -= 1;
        }
    }

    /// [`Playback::move_choice_cursor_left`] の右版。行の最終列、または（最終行が途中
    /// までしか埋まっていない場合の）その行に存在する最後の要素で頭打ちになる。
    pub fn move_choice_cursor_right(&mut self) {
        let Some(columns) = self.effective_columns() else {
            return;
        };
        if columns <= 1 {
            return;
        }
        let Some(PlaybackItem::Choice(options, _)) = self.items.get(self.index) else {
            return;
        };
        let col = self.choice_cursor % columns;
        if col + 1 < columns && self.choice_cursor + 1 < options.len() {
            self.choice_cursor += 1;
        }
    }

    /// 現在カーソルが指している選択肢を確定し、その `jump` 先シーンへ遷移する。
    ///
    /// 選択肢を表示していない場合、カーソルが範囲外の場合（本来起こり得ないが防御的に）、
    /// または `jump` 先のシーンIDが `scene_index_by_id` に見つからない場合（原稿の記述ミスで
    /// 存在しないシーンIDを指している等）は、位置を変えずに `false` を返す。GUI版
    /// `NovelRenderer.jumpToScene` の「シーンが見つからなければ何もせず console.warn するだけ」
    /// という fail-soft 方針と同じだが、TUI は alternate screen 中で標準出力を使えないため
    /// 警告そのものは出さない（呼び出し側が `false` を見て何もしない、という形で吸収する）。
    pub fn select_current_choice(&mut self) -> bool {
        let Some(PlaybackItem::Choice(options, _columns)) = self.items.get(self.index) else {
            return false;
        };
        let Some(option) = options.get(self.choice_cursor) else {
            return false;
        };
        let Some(&target_scene_idx) = self.scene_index_by_id.get(&option.jump) else {
            return false;
        };
        // ジャンプ元とジャンプ先が異なるファイル由来の場合、シーンを跨いで引き継ぐ
        // ランニング状態（BGM/イベント絵/暗転/pending SE/話者・本文）をリセットする
        // （#528、#540で`current_speaker`/`current_text`を追加）。
        // `advance()` は `item_file_ids` を見てファイル境界をまたぐ暗黙の前進を拒否する
        // （#496）が、選択肢ジャンプ（本メソッド）は元々ファイル境界の対象外として設計
        // されており（モジュール冒頭ドキュメント参照）、この種の保護を持っていなかった。
        // その結果、例えば route1（file 0）の末尾で `[BGM: a.ogg]` が再生中のまま
        // route2（file 1）へジャンプすると、無関係な a.ogg が route2 冒頭までそのまま
        // 引き継がれてしまう（Issue #528、Gymnasia実データで実害を確認）。
        // `current_speaker`/`current_text`は元々「Wait+EventImage自動連続表示専用
        // フィールドなので対象外」（#528のスコープ外）としていたが、独立レビュー
        // （#540）で「会話行を経ずにシーン先頭が直接 `[イベント絵:][待機:Nms]` で
        // 始まるケース」を仕様（`docs/spec/markdown-v0.1.md`）で確認したところ、
        // これを禁止する記述が無いと判明。ジャンプ先シーンがこのパターンで始まる場合、
        // `build_scene_items` はその時点の `state.current_speaker`/`current_text`
        // （＝ジャンプ元ファイルの最後の会話行）をそのまま画像コマ item に焼き付ける
        // ため、他4フィールドと同じ経路のリーク（route1最後の話者の台詞が、route2冒頭の
        // 無関係な自動連続画像に上書きされず乗る）が起きる。#528と同じ根本原因のため、
        // 同じ「ファイル境界を越える場合のみリセット」ロジックに合流させる。
        if self.scene_order[self.current_scene_idx].file_id
            != self.scene_order[target_scene_idx].file_id
        {
            self.scan_state.current_bgm = None;
            self.scan_state.current_event_image = None;
            self.scan_state.current_blackout = false;
            self.scan_state.pending_se.clear();
            self.scan_state.current_speaker = None;
            self.scan_state.current_text = Vec::new();
        }
        // 中継シーン（本文・イベント絵を一切含まず、確認用の選択肢が1つだけの
        // シーン）を自動で通過し続ける際の上限回数（#574）。原稿ミスで中継シーン同士が
        // 循環参照（互いにジャンプし合う）していた場合、下のループはスタックを使わず
        // ただ`scene_idx`を書き換えて回るだけなので理論上無限ループになり得る。0件シーンの
        // フォールスルー（このすぐ下、既存ループ）は`scene_idx + 1`で単調増加するため
        // `scene_order`の長さで自然に止まるが、中継シーンの自動継続は選択肢の`jump`先へ
        // 任意方向へ飛べるため同じ保証がない。プレイヤーがハングしたりクラッシュしたり
        // しないよう、定数の上限に達したら「現在の着地点で停止する」（＝直前と同じに見える
        // 中継画面がもう一度出るだけで、以後は通常どおりプレイヤーの入力を待つ）。
        const RELAY_HOP_LIMIT: usize = 100;
        let mut relay_hops = 0usize;
        let mut scene_idx = target_scene_idx;
        loop {
            let scene = &self.scene_order[scene_idx];
            let file_id = scene.file_id;
            let start = self.items.len();
            build_scene_items(
                &scene.events,
                file_id,
                &mut self.scan_state,
                &mut self.flags,
                &mut self.items,
                &mut self.item_file_ids,
                &mut self.item_wait_ms,
                &mut self.item_blackout,
                &mut self.item_bgm,
                &mut self.item_se,
            );
            append_stable_item_keys(
                &self.items,
                &mut self.item_scene_key,
                &mut self.item_content_hash,
                scene_idx,
                start,
                self.items.len(),
            );
            self.current_scene_idx = scene_idx;
            if self.items.len() > start {
                // 中継シーンの自動継続（#574）
                //
                // 症状: Gymnasiaの`hub_gate`→`hub_gate_advance_1`のように、フラグ設定
                // だけを行い本文・イベント絵を持たず「続ける」選択肢1つだけで次のシーンへ
                // つなぐ「中継専用」シーンにジャンプすると、この時点までの実装では
                // `items.len() > start`（items 1件＝Choice）が真になるため即座に画面を
                // 表示して停止していた。しかしその1件が直前の画面と見た目上まったく同じ
                // （地の文なし・選択肢「続ける」1つだけ）だと、プレイヤーには「続ける」を
                // 押しても何も起きていないように見え、実際には2回押して初めて次の実内容
                // シーンへ辿り着く（＝二度押し UX）。
                //
                // 判定基準（厳密）: このシーンが積んだ items 範囲（`self.items[start..]`）
                // が「正確に1件」かつ、その1件が `PlaybackItem::Choice` で
                // `options.len() == 1`の場合だけを「純粋な中継シーン」とみなす。
                // Line/Imageが1件でも混ざっていれば対象外（＝地の文やイベント絵のある
                // 「見せ場のある単一選択肢画面」は誤って飛ばさない）。選択肢が2件以上でも
                // 対象外（＝プレイヤーに分岐の意思決定をさせる画面は必ず止める）。
                //
                // この判定を満たす場合のみ、その唯一の選択肢を自動選択したのと同じ効果
                // （＝このシーンで積んだ items を巻き戻し、選択肢の`jump`先シーンから
                // ループを継続）を、プレイヤーへの追加入力要求なしに行う。実内容のある
                // シーン、または選択肢が0件/2件以上のシーンに着地するまで繰り返す。
                let relay_jump: Option<String> = match &self.items[start..] {
                    [PlaybackItem::Choice(options, _columns)] if options.len() == 1 => {
                        Some(options[0].jump.clone())
                    }
                    _ => None,
                };
                if let Some(jump_id) = relay_jump {
                    if relay_hops < RELAY_HOP_LIMIT {
                        if let Some(&relay_target_idx) = self.scene_index_by_id.get(&jump_id) {
                            // このシーンが積んだ唯一の item（中継専用の「続ける」選択肢）は
                            // プレイヤーには見せず、次のシーンの内容に差し替える。各 item
                            // 並行 Vec は `items` と同じ長さを保つ不変条件があるため、
                            // 全て揃えて `start` まで巻き戻す。
                            self.items.truncate(start);
                            self.item_file_ids.truncate(start);
                            self.item_wait_ms.truncate(start);
                            self.item_blackout.truncate(start);
                            self.item_bgm.truncate(start);
                            self.item_se.truncate(start);
                            self.item_scene_key.truncate(start);
                            self.item_content_hash.truncate(start);

                            // ここから先の遷移は、プレイヤーが手動で選択肢を選んで
                            // ジャンプしたのと意味的に同じ操作（本メソッド冒頭の
                            // ファイル境界越えリセットの対象と同種）。中継シーンが
                            // 別ファイルへ`jump`するケースは稀だが、あり得る場合に
                            // BGM等のリークガード（#528/#540）を免除する理由がないため
                            // 同じリセットを適用する。
                            if self.scene_order[self.current_scene_idx].file_id
                                != self.scene_order[relay_target_idx].file_id
                            {
                                self.scan_state.current_bgm = None;
                                self.scan_state.current_event_image = None;
                                self.scan_state.current_blackout = false;
                                self.scan_state.pending_se.clear();
                                self.scan_state.current_speaker = None;
                                self.scan_state.current_text = Vec::new();
                            }

                            relay_hops += 1;
                            scene_idx = relay_target_idx;
                            continue;
                        }
                        // jump先のシーンIDが見つからない（原稿ミス）。他の異常系と同様
                        // クラッシュさせず、中継シーンをそのまま表示して停止する
                        // （下の通常return処理へフォールスルー）。
                    }
                    // 循環参照等でRELAY_HOP_LIMITに達した。無限ループを避けるため、
                    // これ以上は自動継続せず現在の着地点で停止する。
                }
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

    /// 現在のファイルに属する会話行の総数（Choice item・画像コマ item は含まない、#497）。
    /// 画像コマ（[`PlaybackItem::Image`]）は元の会話行の話者・本文を引き継いだ表示上の
    /// 中間状態にすぎず、それ自体は新しい会話行ではないため数えない。
    ///
    /// UI（進捗バー等）向けに「現在プレイ中のファイルの会話行総数」を返す必要があるため、
    /// プレイヤーが実際に訪れた範囲だけを保持する `self.items`（#509 で遅延構築に変更）は
    /// 使わない。`self.scene_order`（ドキュメント順の全シーンの生イベント一覧）を、実際の
    /// 再生状態（`self.scan_state` / `self.items`）に一切触れない使い捨ての状態で独立に
    /// スキャンして数える（`has_more_scenes_with_items` が使っている「使い捨て scan_state
    /// + 使い捨て Vec で `build_scene_items` を試し呼びする」パターンと同じ）。
    ///
    /// ## スコープ: ドキュメント全体ではなく現在ファイル単位（#565）
    ///
    /// 以前はこの関数が `self.scene_order` を無条件に全件スキャンし「ドキュメント全体の
    /// 会話行総数」を返していたが、Gymnasiaのようにhubから複数の独立したルートファイル
    /// （route01〜route10等）へ分岐する構成（`from_merged_document`）では、選択していない
    /// ルートの会話数まで合算されてしまい実測2696のような巨大な数字になり、プレイヤーが
    /// 実際にそのルートで読む行数とかけ離れた意味の無い分母になる問題があった。GUI版
    /// （`NovelRenderer` の `resolvedEvents`）が現在シーン単位で分母をリセットしているのに
    /// 揃え、`current_scene_idx` が指す現在シーンの `file_id` と同じファイルに属するシーン
    /// だけをスキャン対象にする（一致しないシーンは丸ごとスキップし、`build_scene_items`
    /// も呼ばない）。単一ファイル構成（`from_document`/`from_lines`）は全シーンが同じ合成
    /// ファイルid `0` を持つため、この絞り込みは実質無効化され従来と同じ結果になる。
    ///
    /// ### なぜ `item_file_ids[self.index]` ではなく `scene_order[current_scene_idx].file_id` か
    ///
    /// Issue #565 本文は「`item_file_ids[self.index]`（現在itemのfile_id）」を現在ファイル
    /// 判定の基準として指示していたが、実装ではあえて `scene_order[current_scene_idx].file_id`
    /// （現在シーンのfile_id）を採用している。これは意図的な設計判断で、理由は
    /// `select_current_choice` が選択肢ジャンプを0件シーンかつ最終シーンへ着地させたとき
    /// `self.index` を `self.items.len()`（範囲外）に設定し得ること。この状態で
    /// `item_file_ids[self.index]` ベースの実装を書くと、`item_file_ids.get(self.index)` 相当の
    /// 添字アクセスが範囲外で `None` になり、`current_file_id` が特定できず全シーンが
    /// スキップされて `total()` が誤って `0` を返す回帰（ゲーム終了直前に分母が唐突に0へ
    /// 落ちる）を招く。一方 `scene_order` は構築後不変で、かつ `current_scene_idx` は
    /// （`self.index` と異なり）このジャンプ処理でも常に有効な範囲内のインデックスしか
    /// 指さない（ジャンプ先シーン自体は必ず `scene_order` に実在するため）。したがって
    /// `current_scene_idx` ベースなら同じOOB状態でも正しく実際の会話行数を返せる
    /// （回帰テスト
    /// `total_after_jumping_into_zero_item_last_scene_does_not_return_zero_or_panic` 参照）。
    /// **この理由により、Issue本文の記述に合わせて `item_file_ids` ベースへ「揃える」修正は
    /// しないこと** — 上記の回帰を再発させる。
    ///
    /// `current_scene_idx` が指すシーンが存在しない場合（`from_lines` のように
    /// `scene_order` が常に空の構成）は現在ファイルを特定できないため、スキャン対象の
    /// シーンが1つも無い＝ `0` を返す（`from_lines` は元々このケースを想定したテスト専用
    /// コンストラクタで、`total()` を呼ぶ既存テストは無い）。
    ///
    /// `main.rs::event_loop` は `REDRAW`＝30ms間隔で（キー入力の有無に関わらず）毎フレーム
    /// この関数を呼ぶが、結果は `self.flags` と現在のファイルが変化しない限り変わらない。
    /// スキャンはシーン数に比例した Vec 確保を伴う軽くない処理のため、`self.total_cache` に
    /// `(self.flags.generation(), 現在のfile_id, 直近の結果)` を保持し、どちらも変わって
    /// いなければ再スキャンを省略する（セルフレビュー対応、#509。ファイルidをキーに追加、
    /// #565）。
    pub fn total(&self) -> usize {
        let current_generation = self.flags.generation();
        let current_file_id = self
            .scene_order
            .get(self.current_scene_idx)
            .map(|scene| scene.file_id);
        if let Some((cached_generation, cached_file_id, cached_total)) = self.total_cache.get() {
            if cached_generation == current_generation && cached_file_id == current_file_id {
                return cached_total;
            }
        }
        let mut scan_state = SceneScanState {
            current_event_image: None,
            current_speaker: None,
            current_text: Vec::new(),
            current_blackout: false,
            current_bgm: None,
            pending_se: Vec::new(),
        };
        let mut flags = self.flags.clone();
        let mut count = 0;
        for scene in &self.scene_order {
            if Some(scene.file_id) != current_file_id {
                continue;
            }
            let mut items = Vec::new();
            let mut item_file_ids = Vec::new();
            let mut item_wait_ms = Vec::new();
            let mut item_blackout = Vec::new();
            let mut item_bgm = Vec::new();
            let mut item_se = Vec::new();
            build_scene_items(
                &scene.events,
                scene.file_id,
                &mut scan_state,
                &mut flags,
                &mut items,
                &mut item_file_ids,
                &mut item_wait_ms,
                &mut item_blackout,
                &mut item_bgm,
                &mut item_se,
            );
            count += items
                .iter()
                .filter(|item| matches!(item, PlaybackItem::Line(_)))
                .count();
        }
        self.total_cache
            .set(Some((current_generation, current_file_id, count)));
        count
    }

    /// 現在位置が何行目か（1始まり、Choice item・画像コマ item は含まない、#497）。現在位置が
    /// Choice の場合は、そこに至るまでに表示済みの会話行数を返す（例: 3行しゃべった直後に
    /// 選択肢が出ている状態なら3を返す）。画像コマ自動再生の途中（`pending_wait_ms` が
    /// `Some`）でも、直前に表示済みだった会話行数のまま変化しない。
    pub fn position(&self) -> usize {
        // `self.items[..=self.index]` だと `index == items.len()`（ジャンプ先シーンが
        // イベント0件かつドキュメント末尾のとき `set_index` がこの値を取り得る、
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
            let mut item_bgm = Vec::new();
            let mut item_se = Vec::new();
            build_scene_items(
                &next_scene.events,
                next_scene.file_id,
                &mut scan_state,
                &mut flags,
                &mut items,
                &mut item_file_ids,
                &mut item_wait_ms,
                &mut item_blackout,
                &mut item_bgm,
                &mut item_se,
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
    /// `Document` 経由（`from_document`、`scene_order`/`scene_index_by_id` の構築が
    /// 必要なため）で行う。
    #[cfg(test)]
    pub(crate) fn from_lines(lines: Vec<DisplayLine>) -> Self {
        let item_file_ids = vec![0; lines.len()];
        let item_wait_ms = vec![None; lines.len()];
        let item_blackout = vec![false; lines.len()];
        let item_bgm = vec![None; lines.len()];
        let item_se = vec![Vec::new(); lines.len()];
        // `from_lines` にはシーン構造が無く、`select_current_choice`/`advance` の遅延
        // シーン追記も発生しない（`scene_order` が常に空、doc comment参照）ため、各行を
        // それぞれ独立した「シーン0番の、その行自身のindex番目」として扱えば十分安定する
        // （`stable_item_key` の doc comment参照）。
        let item_scene_key = (0..lines.len()).map(|i| (0, i)).collect();
        let items: Vec<PlaybackItem> = lines.into_iter().map(PlaybackItem::Line).collect();
        let item_content_hash = items.iter().map(content_signature).collect();
        Self {
            items,
            item_file_ids,
            item_wait_ms,
            item_blackout,
            item_bgm,
            item_se,
            item_scene_key,
            item_content_hash,
            index: 0,
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
                current_bgm: None,
                pending_se: Vec::new(),
            },
            current_scene_idx: 0,
            flags: GameFlags::new(),
            total_cache: std::cell::Cell::new(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use name_name_parser::models::{BgmAction, Chapter, ChoiceOption, FlagValue, Scene, SceneView};
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
            header: None,
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
            fullscreen_image: None,
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
        // Background/Bgm/Se は依然として画面表示イベントではないため独立した items を
        // 生成しない（Bgm/Se は #502 で状態として追跡されるようになったが、それは次に
        // 生成される item に焼き付けられるだけで、Bgm/Se 自体が item にはならない）。
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
                columns: None,
            },
            dialog(Some("カコ"), vec!["こんにちは"]),
        ]);
        let pb = Playback::from_document(&doc);
        // 会話行としては dialog の1件だけがカウントされる（Choice は数えない）。
        assert_eq!(pb.total(), 1);
        // 再生位置としては Choice が最初の item になるため、いきなり選択肢が現れる。
        assert_eq!(pb.current_line(), None);
        let (options, cursor, _columns) = pb.current_choice().expect("choice should be current");
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
            columns: None,
        }
    }

    /// `[フラグ: name=value]` 相当の `Event::Flag`（#509）。
    fn flag_event(name: &str, value: bool) -> Event {
        Event::Flag {
            name: name.to_string(),
            value: FlagValue::Bool(value),
        }
    }

    /// `[条件: flag]...[/条件]` 相当の `Event::Condition`（#509）。
    fn condition_event(flag: &str, events: Vec<Event>) -> Event {
        Event::Condition {
            flag: flag.to_string(),
            events,
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
    fn select_current_choice_jumps_to_target_scene() {
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

    /// #574 の再現原稿の縮約版: `hub_gate`（台詞→Choice、`hub_gate_advance_1`へjump）
    /// → `hub_gate_advance_1`（Flagのみ・Choice「続ける」1件だけの純粋な中継シーン、
    /// `hub`へjump）→ `hub`（実内容のある台詞）。
    fn hub_gate_relay_doc() -> Document {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "hub_gate",
                    vec![
                        dialog(Some("A"), vec!["定期報告"]),
                        choice(vec![("続ける", "hub_gate_advance_1")]),
                    ],
                ),
                scene(
                    "hub_gate_advance_1",
                    vec![
                        flag_event("milestone_1_pending", false),
                        choice(vec![("続ける", "hub")]),
                    ],
                ),
                scene("hub", vec![dialog(Some("B"), vec!["hubに戻った"])]),
            ],
        );
        document_with_chapters(vec![ch1])
    }

    #[test]
    fn select_current_choice_auto_continues_through_pure_relay_scene() {
        // #574: 中継シーン（本文無し・Choiceが1件だけ）に着地したとき、プレイヤーに
        // 追加の「続ける」入力を要求せず、自動的にその先の実内容シーンまで進むはず。
        let doc = hub_gate_relay_doc();
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "台詞から Choice へ進めるはず");

        assert!(
            pb.select_current_choice(),
            "有効な jump 先なので成功するはず"
        );

        assert_eq!(
            pb.current_line()
                .expect("中継シーンを自動通過した先の台詞")
                .speaker
                .as_deref(),
            Some("B"),
            "中継シーン(hub_gate_advance_1)で止まらず、その先のhubまで自動で進むはず"
        );
        assert_eq!(
            pb.current_choice(),
            None,
            "着地先は実内容の台詞であり、中継シーンのChoiceが見えてはいけない"
        );
    }

    #[test]
    fn select_current_choice_does_not_skip_single_choice_scene_with_dialog() {
        // 判定基準の厳密さの確認: 選択肢が1件だけでも、そのシーンに地の文（Line）が
        // 伴う場合は「純粋な中継シーン」ではないため自動継続してはいけない
        // （見せ場のある単一選択肢画面を誤ってスキップしない）。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "confirm")]),
                    ],
                ),
                scene(
                    "confirm",
                    vec![
                        dialog(Some("A"), vec!["本当にいいんだな？"]),
                        choice(vec![("続ける", "hub")]),
                    ],
                ),
                scene("hub", vec![dialog(Some("B"), vec!["hub"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line()
                .expect("confirmシーンの台詞")
                .speaker
                .as_deref(),
            Some("A"),
            "本文を持つconfirmシーンで止まるはず（自動継続しない）"
        );
        assert!(
            pb.current_choice().is_none(),
            "confirmシーンはまだ台詞表示中でChoiceは未表示のはず"
        );
    }

    #[test]
    fn select_current_choice_stops_when_relay_target_choice_has_multiple_options() {
        // 判定基準の厳密さの確認: 着地先が本文無しでも、選択肢が2件以上あれば
        // プレイヤーに分岐の意思決定をさせる画面のため自動継続してはいけない。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "relay")]),
                    ],
                ),
                scene(
                    "relay",
                    vec![
                        flag_event("seen_relay", true),
                        choice(vec![("Aへ", "a"), ("Bへ", "b")]),
                    ],
                ),
                scene("a", vec![dialog(Some("A"), vec!["A"])]),
                scene("b", vec![dialog(Some("B"), vec!["B"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_choice().map(|(options, _, _)| options.len()),
            Some(2),
            "選択肢2件のrelayシーンで止まり、プレイヤーの選択を待つはず"
        );
    }

    #[test]
    fn select_current_choice_auto_continues_through_chained_relay_scenes() {
        // #574: 中継シーンが2連続で連なっていても(A中継→B中継→実内容)、1回の呼び出しで
        // 実内容シーンまで到達するはず(単発の中継だけでなく連鎖にも対応することの確認)。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "relay_a")]),
                    ],
                ),
                scene(
                    "relay_a",
                    vec![
                        flag_event("seen_relay_a", true),
                        choice(vec![("続ける", "relay_b")]),
                    ],
                ),
                scene(
                    "relay_b",
                    vec![
                        flag_event("seen_relay_b", true),
                        choice(vec![("続ける", "hub")]),
                    ],
                ),
                scene("hub", vec![dialog(Some("B"), vec!["hubに戻った"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line()
                .expect("2段の中継を自動通過した先の台詞")
                .speaker
                .as_deref(),
            Some("B"),
            "中継シーンが2連続でも1回の呼び出しで実内容(hub)まで到達するはず"
        );
        assert_eq!(pb.current_choice(), None);
    }

    #[test]
    fn select_current_choice_falls_through_zero_item_scene_unaffected_by_relay_logic() {
        // 境界値回帰: Line/Imageなし・選択肢も0件(Flagのみ)のシーンは、今回追加した
        // 中継自動継続ロジックの対象外(items.len() > startにすら入らない)であり、
        // 既存の0件フォールスルー(scene_idx+1へ進む)がそのまま機能し続けるはず。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "flagonly")]),
                    ],
                ),
                scene("flagonly", vec![flag_event("only_flag", true)]),
                scene("real", vec![dialog(Some("B"), vec!["実内容"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line()
                .expect("フォールスルー先の台詞")
                .speaker
                .as_deref(),
            Some("B"),
            "0件シーン(Flagのみ)は中継ロジックに触れず、既存のフォールスルーでrealまで進むはず"
        );
    }

    /// `count`個の純粋な中継シーン(`{prefix}_0`..`{prefix}_{count-1}`)を連鎖させ、最後の
    /// シーンの選択肢は`final_target`へjumpする。#574のRELAY_HOP_LIMIT境界値テスト群で
    /// 使う(100個・101個規模の原稿を手書きする代わりに機械的に生成する)。
    fn relay_chain_scenes(prefix: &str, count: usize, final_target: &str) -> Vec<Scene> {
        (0..count)
            .map(|i| {
                let id = format!("{prefix}_{i}");
                let next = if i + 1 < count {
                    format!("{prefix}_{}", i + 1)
                } else {
                    final_target.to_string()
                };
                scene(
                    &id,
                    vec![
                        flag_event(&format!("seen_{id}"), true),
                        choice(vec![("続ける", &next)]),
                    ],
                )
            })
            .collect()
    }

    #[test]
    fn select_current_choice_completes_chain_of_exactly_hop_limit_relay_scenes() {
        // RELAY_HOP_LIMIT境界値(=100): ちょうど100個の中継シーンを連鎖させても、
        // 1回のselect_current_choice呼び出しだけで実内容シーンまで完走するはず。
        let mut scenes = vec![scene(
            "start",
            vec![
                dialog(Some("A"), vec!["どうする？"]),
                choice(vec![("進む", "relay_0")]),
            ],
        )];
        scenes.extend(relay_chain_scenes("relay", 100, "hub"));
        scenes.push(scene("hub", vec![dialog(Some("B"), vec!["hubに戻った"])]));
        let doc = document_with_chapters(vec![chapter(1, scenes)]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line()
                .expect("100連鎖の先の台詞")
                .speaker
                .as_deref(),
            Some("B"),
            "ちょうど100個の中継シーンは1回の呼び出しで完走するはず(境界=100)"
        );
        assert_eq!(pb.current_choice(), None);
    }

    #[test]
    fn select_current_choice_stops_one_hop_past_relay_hop_limit() {
        // RELAY_HOP_LIMIT境界値(+1=101): 101個目の中継シーンでは自動継続が打ち切られ、
        // そのシーン自身のChoiceが表示されて止まるはず。もう一度呼べば残りが進む。
        let mut scenes = vec![scene(
            "start",
            vec![
                dialog(Some("A"), vec!["どうする？"]),
                choice(vec![("進む", "relay_0")]),
            ],
        )];
        scenes.extend(relay_chain_scenes("relay", 101, "hub"));
        scenes.push(scene("hub", vec![dialog(Some("B"), vec!["hubに戻った"])]));
        let doc = document_with_chapters(vec![chapter(1, scenes)]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice(), "最初のjump自体は成功するはず");

        let (options, _, _) = pb
            .current_choice()
            .expect("101番目の中継シーン(relay_100)自身のChoiceで停止するはず");
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].text, "続ける");

        assert!(
            pb.select_current_choice(),
            "もう一度呼べば残りのhopが進み、hubまで到達するはず"
        );
        assert_eq!(
            pb.current_line()
                .expect("2回目の呼び出しで到達した台詞")
                .speaker
                .as_deref(),
            Some("B")
        );
    }

    #[test]
    fn select_current_choice_stops_at_relay_hop_limit_on_self_referential_cycle() {
        // 自己参照1ホップ中継(自分自身にjumpし続ける原稿ミス)が延々循環せず、
        // RELAY_HOP_LIMITでクラッシュせず停止することの確認。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "loop_self")]),
                    ],
                ),
                scene(
                    "loop_self",
                    vec![
                        flag_event("looped", true),
                        choice(vec![("続ける", "loop_self")]),
                    ],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(
            pb.select_current_choice(),
            "最初のjump自体は成功するはず(無限ループせずRELAY_HOP_LIMITで打ち切って戻ってくる)"
        );

        let (options, _, _) = pb
            .current_choice()
            .expect("自己参照中継はRELAY_HOP_LIMITで打ち切られ自身のChoiceで停止するはず");
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].jump, "loop_self");
    }

    #[test]
    fn select_current_choice_stops_when_relay_target_scene_id_is_missing() {
        // 異常系: 中継シーンの唯一の選択肢がさらにjumpする先のIDが原稿ミスで
        // 存在しない場合、この呼び出し自体は成功(true)を返す(最初のjumpは成功して
        // いるため)が、中継シーン自身のChoice(1件)がそのまま表示されて停止するはず。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "relay")]),
                    ],
                ),
                scene(
                    "relay",
                    vec![
                        flag_event("seen_relay", true),
                        choice(vec![("続ける", "does-not-exist")]),
                    ],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(
            pb.select_current_choice(),
            "最初のjump(start→relay)自体は成功しているのでtrueを返すはず"
        );

        let (options, _, _) = pb
            .current_choice()
            .expect("relayシーン自身のChoiceで停止するはず(jump先のscene idが存在しないため)");
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].text, "続ける");
    }

    #[test]
    fn select_current_choice_relay_across_file_boundary_resets_bgm_and_event_image() {
        // #574の中継自動継続が別ファイルへjumpする場合も、#528/#540のリークガード
        // (BGM/イベント絵/暗転/pending_se/話者・本文のリセット)が適用されるはず。
        // "start"→"relay"は同一ファイル内(ここではリセットは発火しない)、
        // "relay"の唯一の選択肢が別ファイルの"hub"へjumpする箇所で発火することを確認する。
        let route1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        Event::Bgm {
                            path: Some("a.ogg".to_string()),
                            action: BgmAction::Play,
                            fade_ms: None,
                        },
                        event_image("route1/scene.webp"),
                        Event::Blackout {
                            action: name_name_parser::models::BlackoutAction::On,
                        },
                        dialog(Some("A"), vec!["ルート1: 最後の台詞"]),
                        choice(vec![("進む", "relay")]),
                    ],
                ),
                scene(
                    "relay",
                    vec![
                        flag_event("seen_relay", true),
                        choice(vec![("続ける", "hub")]),
                        se("orphan.wav"),
                    ],
                ),
            ],
        );
        let hub = chapter(
            2,
            vec![scene("hub", vec![dialog(Some("施設"), vec!["定期報告"])])],
        );
        let doc = document_with_chapters(vec![route1, hub]);
        let chapter_file_ids = vec![0, 1];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert!(pb.advance());
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        assert!(pb.is_blackout());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line().expect("jump先の台詞").text,
            vec!["定期報告".to_string()]
        );
        assert_eq!(
            pb.current_bgm(),
            None,
            "中継シーンがファイル境界を越えてjumpしたのでBGMはリセットされるはず\
             (#528の保護が中継hopにも適用される)"
        );
        assert!(
            !pb.is_blackout(),
            "中継シーンがファイル境界を越えてjumpしたので暗転状態はリセットされるはず"
        );
        assert_eq!(
            pb.current_line().unwrap().event_image,
            None,
            "中継シーンがファイル境界を越えてjumpしたのでイベント絵はリセットされるはず"
        );
        assert!(
            pb.current_se_cues().is_empty(),
            "中継シーンがファイル境界を越えてjumpしたのでpending_se(orphan.wav)は\
             引き継がれないはず"
        );
    }

    #[test]
    fn select_current_choice_relay_preserves_bgm_across_hops_within_same_file() {
        // 同一file内の中継連鎖では、#528/#540のリセットは発火せず、BGM/イベント絵/
        // 暗転が意図的に持ち越されるはず(中継先へのファイル境界を越えないジャンプは
        // 通常のシーン間ジャンプと同じ「引き継ぐ」規約であることの確認)。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        Event::Bgm {
                            path: Some("a.ogg".to_string()),
                            action: BgmAction::Play,
                            fade_ms: None,
                        },
                        event_image("route1/mid.webp"),
                        Event::Blackout {
                            action: name_name_parser::models::BlackoutAction::On,
                        },
                        dialog(Some("A"), vec!["中間の台詞"]),
                        choice(vec![("進む", "relay")]),
                    ],
                ),
                scene(
                    "relay",
                    vec![
                        flag_event("seen_relay", true),
                        choice(vec![("続ける", "hub")]),
                    ],
                ),
                scene("hub", vec![dialog(Some("B"), vec!["hubに戻った"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let chapter_file_ids = vec![0];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert!(pb.advance());
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        assert!(pb.is_blackout());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line().expect("jump先の台詞").text,
            vec!["hubに戻った".to_string()]
        );
        assert_eq!(
            pb.current_bgm(),
            Some("a.ogg"),
            "同一ファイル内の中継hopではBGMがリセットされず引き継がれるはず"
        );
        assert!(
            pb.is_blackout(),
            "同一ファイル内の中継hopでは暗転状態もリセットされず引き継がれるはず"
        );
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("route1/mid.webp"),
            "同一ファイル内の中継hopではイベント絵もリセットされず引き継がれるはず"
        );
    }

    #[test]
    fn select_current_choice_after_relay_auto_continue_is_idempotent_when_landed_on_real_content() {
        // 冪等性: 自動継続後に実内容シーンへ着地した状態でもう一度select_current_choice()
        // を呼んでも、現在位置は選択肢ではなく台詞(Line)なので何も起きずfalseを返すはず。
        let doc = hub_gate_relay_doc();
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());
        assert!(pb.select_current_choice());
        let line_before = pb.current_line().expect("hubの台詞").clone();

        assert!(
            !pb.select_current_choice(),
            "着地先が実内容(台詞)のとき、再度呼んでもfalseを返すはず"
        );
        assert_eq!(
            pb.current_line().expect("状態が変わっていないはず"),
            &line_before,
            "2回目の呼び出しで状態が変化してはいけない"
        );
    }

    #[test]
    fn select_current_choice_relay_truncate_keeps_all_parallel_vecs_length_equal() {
        // 並行vec整合性: 中継シーンをまたいだ後もitems/item_file_ids/item_wait_ms/
        // item_blackout/item_bgm/item_se/item_scene_key/item_content_hashが
        // 常に同じ長さを保っているはず(truncate/pushの操作が全vecで揃っていることの
        // 明示的なアサーション)。
        let doc = hub_gate_relay_doc();
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());
        assert!(pb.select_current_choice());

        let len = pb.items.len();
        assert_eq!(pb.item_file_ids.len(), len);
        assert_eq!(pb.item_wait_ms.len(), len);
        assert_eq!(pb.item_blackout.len(), len);
        assert_eq!(pb.item_bgm.len(), len);
        assert_eq!(pb.item_se.len(), len);
        assert_eq!(pb.item_scene_key.len(), len);
        assert_eq!(pb.item_content_hash.len(), len);
    }

    #[test]
    fn select_current_choice_relay_lands_on_zero_item_scene_then_falls_through() {
        // 相互作用: 中継の唯一の選択肢のjump先が「0件シーン(Flagのみ)」だった場合、
        // 中継ループを正しく抜けて既存の0件フォールスルー(scene_idx+1方向)に乗り換え、
        // 最終的に正しい実内容シーンまで到達するはず。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "start",
                    vec![
                        dialog(Some("A"), vec!["どうする？"]),
                        choice(vec![("進む", "relay")]),
                    ],
                ),
                scene(
                    "relay",
                    vec![
                        flag_event("seen_relay", true),
                        choice(vec![("続ける", "empty")]),
                    ],
                ),
                scene("empty", vec![]),
                scene("real", vec![dialog(Some("B"), vec!["実内容"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance());

        assert!(pb.select_current_choice());

        assert_eq!(
            pb.current_line()
                .expect("フォールスルー先の台詞")
                .speaker
                .as_deref(),
            Some("B"),
            "中継の着地先が0件シーンでも、既存のフォールスルーに正しく乗り換えてrealまで進むはず"
        );
        assert_eq!(pb.current_choice(), None);
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
            Event::Choice {
                options: vec![],
                columns: None,
            },
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
                            columns: None,
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
        // `select_current_choice_jumps_to_target_scene` 等は Choice→scene jump の
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

    // ---- #508: 選択肢グリッド化（columns >= 2）のカーソル移動テスト ----
    //
    // 行優先の配置規則: `col = index % columns`, `row = index / columns`。端数行
    // （最終行のみ、選択肢数が列数の倍数でない場合）は行優先埋めのため必ず最終行にのみ
    // 発生する（実装の設計）。以下のテストは主に8選択肢・columns=3のフィクスチャ
    // （`ragged_grid_playback`、row0=[0,1,2] row1=[3,4,5] row2=[6,7]、col2欠の端数行）を使う。

    /// #508用フィクスチャヘルパー。`count`件・`columns`列で、選択肢の `jump` は全て
    /// `target` に統一する（カーソル移動系のテストでは jump 先の中身は重要でないため、
    /// カーソル位置の確認だけに集中できるよう簡略化している）。
    fn choice_grid(count: usize, columns: Option<u32>, target: &str) -> Event {
        Event::Choice {
            options: (0..count)
                .map(|i| ChoiceOption {
                    text: format!("opt{i}"),
                    jump: target.to_string(),
                })
                .collect(),
            columns,
        }
    }

    /// #508の主要フィクスチャ: 8選択肢・columns=3。行優先配置で
    /// row0=[0,1,2] row1=[3,4,5] row2=[6,7]（col2欠の端数行）になる。
    fn ragged_grid_playback() -> Playback {
        let doc = doc_single_scene(vec![choice_grid(8, Some(3), "x")]);
        Playback::from_document(&doc)
    }

    #[test]
    fn move_choice_cursor_up_down_treat_columns_none_same_as_some_1() {
        let doc_none = doc_single_scene(vec![choice_grid(3, None, "x")]);
        let doc_some1 = doc_single_scene(vec![choice_grid(3, Some(1), "x")]);
        let mut pb_none = Playback::from_document(&doc_none);
        let mut pb_some1 = Playback::from_document(&doc_some1);

        pb_none.move_choice_cursor_down();
        pb_some1.move_choice_cursor_down();
        assert_eq!(
            pb_none.current_choice().unwrap().1,
            pb_some1.current_choice().unwrap().1,
            "columns=None と columns=Some(1) はdown後も同じカーソル位置のはず"
        );

        pb_none.move_choice_cursor_down();
        pb_some1.move_choice_cursor_down();
        assert_eq!(
            pb_none.current_choice().unwrap().1,
            2,
            "末尾(index 2)まで進むはず"
        );
        assert_eq!(pb_some1.current_choice().unwrap().1, 2);

        pb_none.move_choice_cursor_up();
        pb_some1.move_choice_cursor_up();
        assert_eq!(
            pb_none.current_choice().unwrap().1,
            1,
            "up後も両者一致するはず"
        );
        assert_eq!(pb_some1.current_choice().unwrap().1, 1);
    }

    #[test]
    fn move_choice_cursor_up_down_treat_columns_some_0_same_as_some_1() {
        let doc_some0 = doc_single_scene(vec![choice_grid(3, Some(0), "x")]);
        let doc_some1 = doc_single_scene(vec![choice_grid(3, Some(1), "x")]);
        let mut pb_some0 = Playback::from_document(&doc_some0);
        let mut pb_some1 = Playback::from_document(&doc_some1);

        pb_some0.move_choice_cursor_down();
        pb_some1.move_choice_cursor_down();
        assert_eq!(
            pb_some0.current_choice().unwrap().1,
            pb_some1.current_choice().unwrap().1,
            "columns=Some(0) と columns=Some(1) はdown後も同じカーソル位置のはず"
        );

        pb_some0.move_choice_cursor_down();
        pb_some1.move_choice_cursor_down();
        assert_eq!(pb_some0.current_choice().unwrap().1, 2);
        assert_eq!(pb_some1.current_choice().unwrap().1, 2);

        pb_some0.move_choice_cursor_up();
        pb_some1.move_choice_cursor_up();
        assert_eq!(pb_some0.current_choice().unwrap().1, 1);
        assert_eq!(pb_some1.current_choice().unwrap().1, 1);
    }

    #[test]
    fn move_choice_cursor_down_from_ragged_row_gap_snaps_to_last_existing_item_in_row() {
        let mut pb = ragged_grid_playback();
        pb.move_choice_cursor_right(); // idx0 -> idx1
        pb.move_choice_cursor_right(); // idx1 -> idx2 (row0, col2)
        pb.move_choice_cursor_down(); // row0 col2 -> row1 col2 = idx5
        assert_eq!(
            pb.current_choice().unwrap().1,
            5,
            "前提: row1のcol2(idx5)にいるはず"
        );

        pb.move_choice_cursor_down(); // row2のcol2は存在しない(端数行)
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "row2にcol2が存在しないため、row2の最後の実在アイテム(idx7)へスナップするはず"
        );
    }

    #[test]
    fn move_choice_cursor_right_at_ragged_last_row_stops_at_last_existing_item_not_grid_edge() {
        let mut pb = ragged_grid_playback();
        pb.move_choice_cursor_right();
        pb.move_choice_cursor_right();
        pb.move_choice_cursor_down();
        pb.move_choice_cursor_down(); // idx2 -> idx5 -> スナップして idx7
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "前提: idx7(row2,col1、端数行の実在最後)にいるはず"
        );

        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "列的にはまだ余裕(col1<columns-1=2)があるが、総数(8件)の終端が理由でno-opのはず"
        );
    }

    #[test]
    fn move_choice_cursor_right_at_full_row_stops_at_grid_column_edge() {
        let mut pb = ragged_grid_playback();
        pb.move_choice_cursor_right();
        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_choice().unwrap().1,
            2,
            "前提: idx2(row0,col2、列は3列あるので列端)にいるはず"
        );

        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_choice().unwrap().1,
            2,
            "総数の終端(8件)ではなく、グリッドの列端(columns=3)が理由でno-opのはず \
             （前のテストとは頭打ちの理由が異なる対比）"
        );
    }

    #[test]
    fn move_choice_cursor_down_at_last_row_is_noop_even_from_ragged_position() {
        let mut pb = ragged_grid_playback();
        pb.move_choice_cursor_down();
        pb.move_choice_cursor_down(); // idx0 -> idx3 -> idx6
        assert_eq!(
            pb.current_choice().unwrap().1,
            6,
            "前提: idx6(row2,col0)にいるはず"
        );
        pb.move_choice_cursor_down();
        assert_eq!(pb.current_choice().unwrap().1, 6, "最終行なのでno-op");

        pb.move_choice_cursor_right(); // idx6 -> idx7
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "前提: idx7(row2,col1)にいるはず"
        );
        pb.move_choice_cursor_down();
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "端数行の実在位置からでも最終行はno-opのはず"
        );
    }

    #[test]
    fn move_choice_cursor_up_at_first_row_is_noop_for_all_columns() {
        let mut pb = ragged_grid_playback();
        pb.move_choice_cursor_up();
        assert_eq!(pb.current_choice().unwrap().1, 0, "col0でno-op");

        pb.move_choice_cursor_right();
        pb.move_choice_cursor_up();
        assert_eq!(pb.current_choice().unwrap().1, 1, "col1でもno-op");

        pb.move_choice_cursor_right();
        pb.move_choice_cursor_up();
        assert_eq!(pb.current_choice().unwrap().1, 2, "col2でもno-op");
    }

    #[test]
    fn move_choice_cursor_left_at_row_start_is_noop() {
        let mut pb = ragged_grid_playback();
        pb.move_choice_cursor_left();
        assert_eq!(pb.current_choice().unwrap().1, 0, "row0のcol0でno-op");

        pb.move_choice_cursor_down();
        pb.move_choice_cursor_left();
        assert_eq!(
            pb.current_choice().unwrap().1,
            3,
            "row1のcol0でも前の行(row0)へまたいでleftしないはず"
        );

        pb.move_choice_cursor_down();
        pb.move_choice_cursor_left();
        assert_eq!(
            pb.current_choice().unwrap().1,
            6,
            "row2のcol0でも同様に行をまたがないはず"
        );
    }

    #[test]
    fn move_choice_cursor_left_right_are_noop_when_columns_is_none_or_1() {
        for columns in [None, Some(1)] {
            let doc = doc_single_scene(vec![choice_grid(3, columns, "x")]);
            let mut pb = Playback::from_document(&doc);
            pb.move_choice_cursor_down(); // 非グリッドでは「1つ次の要素」= idx1
            assert_eq!(pb.current_choice().unwrap().1, 1);

            pb.move_choice_cursor_right();
            assert_eq!(
                pb.current_choice().unwrap().1,
                1,
                "columns={columns:?}: 非グリッドではrightはno-opのはず"
            );

            pb.move_choice_cursor_left();
            assert_eq!(
                pb.current_choice().unwrap().1,
                1,
                "columns={columns:?}: 非グリッドではleftもno-opのはず"
            );
        }
    }

    #[test]
    fn move_choice_cursor_left_right_are_noop_when_choice_not_displayed() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["会話中"])]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.current_line().is_some(), "前提: Line表示中のはず");

        // panicしないことが主目的。表示内容も変わらないことを合わせて確認する。
        pb.move_choice_cursor_left();
        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_line().expect("line").speaker.as_deref(),
            Some("A"),
            "Choice以外の表示中はleft/rightで状態が変わらないはず"
        );
        assert_eq!(pb.current_choice(), None);
    }

    #[test]
    fn move_choice_cursor_grid_columns_equal_option_count_forms_single_row() {
        let doc = doc_single_scene(vec![choice_grid(8, Some(8), "x")]);
        let mut pb = Playback::from_document(&doc);

        pb.move_choice_cursor_down();
        assert_eq!(
            pb.current_choice().unwrap().1,
            0,
            "1行のみのグリッドなのでdownは即頭打ちのはず"
        );

        for _ in 0..7 {
            pb.move_choice_cursor_right();
        }
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "rightだけで最終列まで到達できるはず"
        );

        pb.move_choice_cursor_right();
        assert_eq!(pb.current_choice().unwrap().1, 7, "列端でno-opのはず");

        pb.move_choice_cursor_up();
        assert_eq!(
            pb.current_choice().unwrap().1,
            7,
            "1行のみのグリッドなのでupも即頭打ちのはず"
        );
    }

    #[test]
    fn move_choice_cursor_grid_columns_greater_than_option_count_forms_single_ragged_row() {
        let doc = doc_single_scene(vec![choice_grid(3, Some(5), "x")]);
        let mut pb = Playback::from_document(&doc);

        pb.move_choice_cursor_right();
        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_choice().unwrap().1,
            2,
            "前提: 実在最後(idx2)にいるはず"
        );

        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_choice().unwrap().1,
            2,
            "列数(5)にはまだ余裕があるが、実在アイテム終端(3件)が理由でno-opのはず"
        );

        pb.move_choice_cursor_down();
        assert_eq!(
            pb.current_choice().unwrap().1,
            2,
            "1行のみのグリッドなのでdownもno-opのはず"
        );
    }

    #[test]
    fn select_current_choice_resets_cursor_to_zero_even_when_jumping_between_different_grid_column_counts(
    ) {
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![choice_grid(8, Some(5), "1-2")]),
                scene("1-2", vec![choice_grid(3, Some(2), "1-2")]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        pb.move_choice_cursor_right();
        pb.move_choice_cursor_right();
        assert_eq!(
            pb.current_choice().unwrap().1,
            2,
            "前提: jump前にカーソルを非0位置に動かしておく"
        );

        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");
        let (options, cursor, columns) = pb.current_choice().expect("jump先もChoiceのはず");
        assert_eq!(options.len(), 3);
        assert_eq!(columns, Some(2), "jump先は別のcolumns値を持つ選択肢のはず");
        assert_eq!(
            cursor, 0,
            "jump元のcolumns(5)とjump先のcolumns(2)が異なっていても、cursorは0から始まるはず"
        );
    }

    #[test]
    fn consecutive_grid_and_non_grid_choices_do_not_leak_cursor_state() {
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![choice_grid(6, Some(3), "1-2")]),
                scene("1-2", vec![choice(vec![("A", "x"), ("B", "y")])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        pb.move_choice_cursor_down(); // idx0(row0,col0) -> idx3(row1,col0)
        assert_ne!(
            pb.current_choice().unwrap().1,
            0,
            "前提: グリッド選択肢でカーソルを非0位置に動かしておく"
        );

        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");
        let (options, cursor, columns) = pb.current_choice().expect("jump先もChoiceのはず");
        assert_eq!(options.len(), 2);
        assert_eq!(columns, None, "jump先は非グリッドの選択肢のはず");
        assert_eq!(
            cursor, 0,
            "前のグリッド選択肢の非0カーソルが、後続の非グリッド選択肢に漏れてはいけない"
        );
    }

    // ---- #508 バグ修正の回帰テスト: columns の上限クランプ ----

    #[test]
    fn choice_columns_vastly_exceeding_option_count_is_clamped_to_option_count() {
        // レビューで実際にハングを再現した原稿そのもの相当: `[選択: 列=200000]` だが
        // 選択肢は2件しかない。parser の `parse_choice_columns` は `u32 >= 1` ならどんな
        // 巨大な値も受理し上限バリデーションを持たないため、`Playback` 構築時
        // （`playback_item_from_event`）でクランプしていないと、この生の巨大値が
        // `ui::draw_choice_grid` までそのまま届いてハングする。実際に markdown を
        // `parser::parse` した `Document` を経由させ、パイプライン全体でクランプが
        // 効いていることを確認する。
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n[選択: 列=200000]\n- \
                       進む→1-2\n- 戻る→1-2\n[/選択]\n\n## 1-2: 次\n\n**B**:\n次のセリフ\n";
        let document = name_name_parser::parser::parse(source);
        let pb = Playback::from_document(&document);

        let (options, _cursor, columns) = pb.current_choice().expect("Choiceが最初の item のはず");
        assert_eq!(options.len(), 2);
        assert_eq!(
            columns,
            Some(2),
            "列=200000 は選択肢数(2)へクランプされるはず（クランプ無しだとui::draw_choice_grid \
             がハングする実害バグ、#508）"
        );
    }

    #[test]
    fn choice_columns_within_option_count_is_left_unchanged() {
        // クランプは「選択肢数を超える」場合のみに効き、妥当な範囲の列数（<= 選択肢数）は
        // 従来どおりそのまま通ることの確認（過剰なクランプで #508 の元機能を壊していないか）。
        let doc = doc_single_scene(vec![choice_grid(8, Some(3), "x")]);
        let pb = Playback::from_document(&doc);
        let (_options, _cursor, columns) = pb.current_choice().expect("Choiceのはず");
        assert_eq!(
            columns,
            Some(3),
            "選択肢数(8)以下の列数(3)はクランプされないはず"
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
                scene("1-1", vec![blackout_on(), choice(vec![("yes", "1-2")])]),
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
        let doc = doc_single_scene(vec![blackout_on(), choice(vec![("yes", "1-1")])]);
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
                        choice(vec![("進む", "1-2")]),
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
                        choice(vec![("進む", "1-2")]),
                    ],
                ),
                scene(
                    "1-2",
                    vec![
                        blackout_off(),
                        dialog(Some("B"), vec!["解除後の台詞"]),
                        choice(vec![("戻る", "1-1")]),
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
        // `[イベント絵][待機][暗転][場面転換]` という4連続パターン（既知の制約2、
        // モジュール冒頭doc・#524コメント参照。#524で明示的に固定する現状の実装挙動）。
        // Wait直後の検出は `if let Some(Blackout) ... else if matches!(SceneTransition)`
        // の順で判定するためBlackoutが優先され、Blackoutが見つかった時点でconsumed=3として
        // 打ち切る。後続のSceneTransitionはこの特別処理の対象にならず、通常のmatchアーム
        // （`Event::SceneTransition => {..}`）でstateだけが更新されitemは生成されない。
        // 結果として暗転itemだけが生成され、SceneTransitionの効果（暗転解除・イベント絵
        // クリア）はどのitemにも反映されない。
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

    // ---- #509: Event::Flag / Event::Condition のリアルタイム評価テスト ----

    #[test]
    fn condition_reflects_flag_set_earlier_in_the_same_scene_but_not_when_flag_comes_after() {
        // フラグが先・条件が後: 同一シーン内で即座に反映され、条件内の台詞が最初のitemになる。
        let doc = doc_single_scene(vec![
            flag_event("x", true),
            condition_event("x", vec![dialog(Some("カコ"), vec!["表示されるはず"])]),
        ]);
        let pb = Playback::from_document(&doc);
        let line = pb
            .current_line()
            .expect("フラグ成立後の条件内台詞が最初のitemのはず");
        assert_eq!(line.speaker.as_deref(), Some("カコ"));
        assert_eq!(line.text, vec!["表示されるはず".to_string()]);

        // 条件が先・フラグが後: まだフラグが立っていない時点で評価されるため表示されない。
        let doc_reversed = doc_single_scene(vec![
            condition_event("y", vec![dialog(Some("カコ"), vec!["表示されないはず"])]),
            flag_event("y", true),
        ]);
        let pb_reversed = Playback::from_document(&doc_reversed);
        assert_eq!(
            pb_reversed.current_line(),
            None,
            "条件評価時点ではyが未設定なので条件内の台詞は一切itemにならないはず"
        );
        assert!(pb_reversed.is_at_end(), "後続イベントが無いので末尾のはず");
    }

    #[test]
    fn condition_reflects_flag_set_in_an_earlier_scene_after_crossing_scene_boundary() {
        // シーン "1-1" でフラグを立て、選択肢を介さずドキュメント順で "1-2" へ advance() した際に
        // "1-2" 内の条件付き台詞が反映されることを確認する（#509）。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        flag_event("seen", true),
                        dialog(Some("A"), vec!["最初のシーン"]),
                    ],
                ),
                scene(
                    "1-2",
                    vec![condition_event(
                        "seen",
                        vec![dialog(Some("B"), vec!["Aを見た後"])],
                    )],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(
            pb.current_line().expect("1-1の台詞").speaker.as_deref(),
            Some("A")
        );

        assert!(pb.advance(), "シーン境界を越えて1-2へ進めるはず");
        let line = pb
            .current_line()
            .expect("1-2の条件付き台詞がseen=true成立で表示されるはず");
        assert_eq!(line.speaker.as_deref(), Some("B"));
        assert_eq!(line.text, vec!["Aを見た後".to_string()]);
    }

    #[test]
    fn condition_result_depends_on_actual_path_taken_not_document_position() {
        // ハブ → ルートA（seen_aを立てる）→ ハブへ戻る → ルートB、という経路をたどると
        // ルートB内の `[条件: seen_a]` が表示される。同じドキュメント上の位置でも、
        // ハブから最初からルートBへ直接進んだ場合（ルートAを未経由）は表示されない —
        // これが #509 の核心（経路依存の評価）。
        fn hub_doc() -> Document {
            let ch1 = chapter(
                1,
                vec![
                    scene(
                        "hub",
                        vec![
                            dialog(Some("Hub"), vec!["ハブ"]),
                            choice(vec![("Aへ", "route-a"), ("Bへ", "route-b")]),
                        ],
                    ),
                    scene(
                        "route-a",
                        vec![
                            dialog(Some("A"), vec!["ルートA"]),
                            flag_event("seen_a", true),
                            choice(vec![("ハブへ戻る", "hub")]),
                        ],
                    ),
                    scene(
                        "route-b",
                        vec![
                            condition_event(
                                "seen_a",
                                vec![dialog(Some("B2"), vec!["Aを見た後のB"])],
                            ),
                            dialog(Some("B"), vec!["ルートB"]),
                        ],
                    ),
                ],
            );
            document_with_chapters(vec![ch1])
        }

        // 経路1: ハブ → A → ハブ → B（Aを経由してからBへ）。
        let doc = hub_doc();
        let mut pb = Playback::from_document(&doc);
        assert!(pb.advance(), "ハブの台詞 -> Choiceへ");
        assert!(
            pb.select_current_choice(),
            "カーソル0（Aへ）でroute-aへjumpできるはず"
        );
        assert_eq!(
            pb.current_line().expect("route-aの台詞").speaker.as_deref(),
            Some("A")
        );
        assert!(
            pb.advance(),
            "route-aの台詞 -> フラグ設定を経てChoiceへ進めるはず"
        );
        assert!(
            pb.select_current_choice(),
            "「ハブへ戻る」でhubへjumpできるはず"
        );
        assert_eq!(
            pb.current_line()
                .expect("再訪したhubの台詞")
                .speaker
                .as_deref(),
            Some("Hub")
        );
        assert!(pb.advance(), "再訪hubの台詞 -> Choiceへ");
        pb.move_choice_cursor_down();
        assert_eq!(
            pb.current_choice().expect("choice").1,
            1,
            "カーソルはBへ（index 1）動いているはず"
        );
        assert!(
            pb.select_current_choice(),
            "Bへ選択してroute-bへjumpできるはず"
        );
        let line = pb
            .current_line()
            .expect("route-aを経由済みなのでseen_a成立、条件内の台詞が表示されるはず");
        assert_eq!(line.speaker.as_deref(), Some("B2"));
        assert_eq!(line.text, vec!["Aを見た後のB".to_string()]);

        // 経路2: ハブから直接B（Aを未経由）。同じドキュメント位置でも結果が変わる。
        let doc_direct = hub_doc();
        let mut pb_direct = Playback::from_document(&doc_direct);
        assert!(pb_direct.advance(), "ハブの台詞 -> Choiceへ");
        pb_direct.move_choice_cursor_down();
        assert_eq!(pb_direct.current_choice().expect("choice").1, 1);
        assert!(
            pb_direct.select_current_choice(),
            "Bへ選択してroute-bへjumpできるはず"
        );
        let line_direct = pb_direct
            .current_line()
            .expect("route-bの最初の台詞（Aを未経由なので条件内はスキップされるはず）");
        assert_eq!(
            line_direct.speaker.as_deref(),
            Some("B"),
            "seen_a未成立なので条件内のB2は生成されず、通常のBが最初のitemになるはず"
        );
        assert_eq!(line_direct.text, vec!["ルートB".to_string()]);
    }

    #[test]
    fn total_call_does_not_mutate_playback_state() {
        // セルフレビュー対応（#509）: total() は独立の使い捨て状態で試し計算するだけで、
        // 実プレイの現在位置・flags・items を変えてはならない。キャッシュ導入後も
        // この不変条件が壊れていないことを確認する。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["最初のシーン"]),
                        flag_event("unlocked", true),
                    ],
                ),
                scene(
                    "1-2",
                    vec![condition_event(
                        "unlocked",
                        vec![dialog(Some("B"), vec!["解禁後だけ見える"])],
                    )],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let pb = Playback::from_document(&doc);

        let line_before = pb.current_line().cloned();
        let position_before = pb.position();
        let is_at_end_before = pb.is_at_end();
        let generation_before = pb.flags.generation();
        let items_len_before = pb.items.len();

        // 複数回呼ぶ（キャッシュ経路も含めて）。
        let total_first_call = pb.total();
        let total_second_call = pb.total();
        assert_eq!(
            total_first_call, total_second_call,
            "同じflags状態での複数回呼び出しは同じ値を返すはず（キャッシュ有無に関わらず）"
        );

        assert_eq!(
            pb.current_line().cloned(),
            line_before,
            "total()の呼び出しが実プレイ位置のcurrent_lineを変えてはならない"
        );
        assert_eq!(
            pb.position(),
            position_before,
            "total()の呼び出しがposition()を変えてはならない"
        );
        assert_eq!(
            pb.is_at_end(),
            is_at_end_before,
            "total()の呼び出しがis_at_end()を変えてはならない"
        );
        assert_eq!(
            pb.flags.generation(),
            generation_before,
            "total()は使い捨てのflags.clone()で試し計算するだけで、実プレイのflags状態を\
             変えてはならない"
        );
        assert_eq!(
            pb.items.len(),
            items_len_before,
            "total()の呼び出しが実プレイのitemsを追記してはならない（遅延ビルドは\
             advance()/select_current_choice()経由でのみ起こる）"
        );
    }

    #[test]
    fn total_after_jumping_into_zero_item_last_scene_does_not_return_zero_or_panic() {
        // should1で追記したtotal()のdoc comment「なぜitem_file_ids[self.index]ではなく
        // scene_order[current_scene_idx].file_idか」の直接の回帰テスト。fixtureは
        // `position_after_jumping_into_zero_item_last_scene_does_not_panic` と同じ
        // （"1-1": 台詞 + Choice("1-2"へjump)、"1-2": イベント0件かつ最終シーン）。
        // select_current_choiceでself.indexがitems.len()（範囲外）になった状態でも、
        // current_scene_idxは常に有効な範囲内のインデックス（scene_order上の"1-2"）を
        // 指し続けるため、total()はpanicせず実際の会話行数(1)を返せるはず。もし
        // item_file_ids[self.index]ベースだったら、この範囲外アクセスでcurrent_file_idが
        // Noneになり、全シーンがスキップされてtotal()が誤って0を返してしまう。
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

        // ここで panic しないことを確認する。
        let total = pb.total();
        assert_eq!(
            total, 1,
            "ジャンプ先が0件シーンでself.indexがOOBになっても、実際の会話行数(1)を\
             返すはず（0ではない）"
        );
    }

    #[test]
    fn total_reflects_real_play_flags_and_cache_invalidates_when_flags_change() {
        // セルフレビュー対応（#509）: total()のキャッシュは self.flags.generation() を
        // キーにしているため、実プレイでflagsが変化すれば再計算され、古い値を使い回さない
        // ことを確認する。
        //
        // シーン宣言順は route-b → route-a（total()の全件スキャンは`scene_order`の
        // 登録順=このドキュメント宣言順で行われる）。route-bの`[条件: seen_a]`は
        // ドキュメント順ではroute-aのフラグ設定より*前*に出現するため、total()の
        // スキャンが自前で辿るだけでは（route-a未到達の時点で）まだ成立していない。
        // しかし実プレイでroute-aへ進みseen_aを実際に立てた後は、total()の起点
        // （self.flags.clone()）がseen_a=trueを持つため、route-bの条件付き行も
        // カウントに含まれるようになる——「同じドキュメント位置でも実プレイの経路次第で
        // 結果が変わる」という#509の核心が、total()の起点にも及ぶことの検証。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "route-b",
                    vec![
                        dialog(Some("Intro"), vec!["導入"]),
                        condition_event("seen_a", vec![dialog(Some("B2"), vec!["Aを見た後"])]),
                    ],
                ),
                scene(
                    "route-a",
                    vec![
                        dialog(Some("A"), vec!["ルートA"]),
                        flag_event("seen_a", true),
                    ],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        let total_before = pb.total();
        assert_eq!(
            total_before, 2,
            "total()自身のスキャンではroute-b条件評価時点でseen_aがまだ未設定のため、\
             Intro + Aの2行のはず（B2は含まれない）"
        );

        let generation_before = pb.flags.generation();
        assert!(
            pb.advance(),
            "Intro -> シーン境界を越えてroute-aのAへ進めるはず"
        );
        assert_ne!(
            pb.flags.generation(),
            generation_before,
            "advance()でroute-aのEvent::Flagが実行されたので世代番号が進むはず"
        );

        let total_after = pb.total();
        assert_eq!(
            total_after, 3,
            "実プレイでseen_aが立った後は、total()の起点(self.flags.clone())が\
             seen_a=trueを持つため、route-bのB2もカウントに含まれ3行になるはず\
             （古いキャッシュ値2を誤って使い回していないことの確認）"
        );
    }

    // ---- #565: total()のスコープを「ドキュメント全体」から「現在ファイル単位」に変更
    // ---- したことの回帰テスト
    //
    // 以下はtotal_cacheの有効性デシジョンテーブル（generation一致×file_id一致の2×2。
    // 以降の各テストのコメントが「行N」で参照する）:
    //   行1: generation不一致 × file_id不一致 → 再スキャン
    //   行2: generation一致   × file_id一致   → キャッシュヒット
    //   行3: generation一致   × file_id不一致 → 再スキャン（最重要ケース。#565の直接の
    //        再発防止対象。旧実装はgenerationしかキャッシュキーに見ておらず、この行だけ
    //        誤ってキャッシュヒットしてしまい、選択肢で別ファイルへジャンプした直後に
    //        古い値を返す事故が起きていた）
    //   行4: generation不一致 × file_id一致   → 再スキャン

    #[test]
    fn from_merged_document_total_counts_only_current_file_scenes() {
        // #565: total()はドキュメント全体ではなく現在ファイルの会話行だけを数えるべき。
        // file0(route1相当)に3行、file1(route2相当)に5行を配置し、構築直後
        // （current_scene_idxはfile0内）ではfile0の3行だけが返るはず（8ではない）。
        let route1 = route_chapter(1, "1-1", vec!["file0-1", "file0-2", "file0-3"]);
        let route2 = route_chapter(
            2,
            "2-1",
            vec!["file1-1", "file1-2", "file1-3", "file1-4", "file1-5"],
        );
        let doc = document_with_chapters(vec![route1, route2]);
        let chapter_file_ids = vec![0, 1];

        let pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert_eq!(
            pb.total(),
            3,
            "現在シーンはfile0内なのでfile0の3行だけが分母になるはず\
             （file1の5行を合算した8ではない）"
        );
    }

    #[test]
    fn select_current_choice_cross_file_jump_invalidates_total_cache_without_flag_change() {
        // #565の直接的な再発防止テスト。以前のtotal_cacheはgeneration（flagsの世代番号）
        // だけをキーにしておりfile_idを見ていなかった。選択肢で別ファイルへジャンプしても
        // flag設定イベントが無ければgenerationは変化しないため、file_idをキーに含めない
        // 実装ではここでキャッシュヒットしてしまい、file0時点の古い値を返す事故が
        // 起きていた（デシジョンテーブル行3）。
        let route1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![
                    dialog(Some("A"), vec!["file0の唯一の台詞"]),
                    choice(vec![("file1へ", "2-1")]),
                ],
            )],
        );
        let route2 = route_chapter(2, "2-1", vec!["file1-1", "file1-2", "file1-3", "file1-4"]);
        let doc = document_with_chapters(vec![route1, route2]);
        let chapter_file_ids = vec![0, 1];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);

        // ジャンプ前にtotal()を複数回呼びキャッシュをプライムする。
        let total_before_first = pb.total();
        let total_before_second = pb.total();
        assert_eq!(
            total_before_first, 1,
            "file0は台詞1件だけのはず（直後のChoiceはカウント対象外）"
        );
        assert_eq!(
            total_before_first, total_before_second,
            "キャッシュヒットでも値は変わらないはず"
        );
        let generation_before = pb.flags.generation();

        assert!(
            pb.advance(),
            "台詞 -> Choiceへは同一ファイル内の前進なので進めるはず"
        );
        assert!(
            pb.select_current_choice(),
            "file1(2-1)への明示的なjumpは成功するはず（選択肢によるクロスファイル\
             遷移はファイル境界チェックの対象外）"
        );
        assert_eq!(
            pb.flags.generation(),
            generation_before,
            "この選択肢にはflag設定イベントが無いので世代番号は変化しないはず\
             （generationだけをキャッシュキーにしていた旧実装では、この後のtotal()が\
             誤ってキャッシュヒットしてfile0時点の古い値1を返してしまっていた）"
        );

        assert_eq!(
            pb.total(),
            4,
            "generationが不変でもfile_idがfile0からfile1に変わったので再スキャンされ、\
             file1の4行が返るはず（file0時点の古いキャッシュ値1ではない）"
        );
    }

    #[test]
    fn from_document_total_matches_pre_565_behavior_for_single_file() {
        // 非退行確認: from_document（単一ファイル、全itemが合成file id 0）では、
        // #565のスコープ絞り込みが実質無効化され、絞り込み導入前と同じ
        // 「ドキュメント全体の会話行総数」がそのまま返るはず。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![dialog(Some("A"), vec!["a1"]), dialog(Some("A"), vec!["a2"])],
                ),
                scene("1-2", vec![dialog(Some("B"), vec!["b1"])]),
            ],
        );
        let ch2 = chapter(
            2,
            vec![scene(
                "2-1",
                vec![
                    dialog(Some("C"), vec!["c1"]),
                    dialog(Some("C"), vec!["c2"]),
                    dialog(Some("C"), vec!["c3"]),
                ],
            )],
        );
        let doc = document_with_chapters(vec![ch1, ch2]);
        let pb = Playback::from_document(&doc);

        assert_eq!(
            pb.total(),
            6,
            "単一ファイル構成(from_document)では全シーンが同じ合成file id 0を持つため、\
             #565のスコープ絞り込みは実質無効化され、従来どおりドキュメント全体の\
             会話行総数(2+1+3=6)が返るはず"
        );
    }

    #[test]
    fn total_on_from_lines_returns_zero_without_panic() {
        // 境界値: from_lines()はscene_orderを持たない（常に空、from_lines自身のdoc comment
        // 参照）ため、current_scene_idxが指すシーンを特定できない。total()はこのケースで
        // panicせず0を返すはず（スキャン対象のシーンが1つも無い扱い）。
        let pb = Playback::from_lines(vec![
            dline(Some("A"), vec!["1行目"]),
            dline(Some("B"), vec!["2行目"]),
        ]);
        assert_eq!(
            pb.total(),
            0,
            "scene_orderが空で現在ファイルを特定できないため0が返るはず（panicしない）"
        );
    }

    #[test]
    fn from_document_with_zero_chapters_total_returns_zero() {
        // 境界値: chaptersが0件のドキュメントではscene_orderも空になるため、
        // total()は0を返すはず。
        let doc = document_with_chapters(vec![]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 0);
    }

    #[test]
    fn total_cache_hit_returns_same_value_when_nothing_changes_in_multi_file_doc() {
        // デシジョンテーブル行2の複数ファイル版: generation・file_idともに不変な連続
        // 呼び出しはキャッシュヒットし、実プレイ状態（flags/position/items）を変えずに
        // 同じ値を返すはず。
        let route1 = route_chapter(1, "1-1", vec!["file0-1", "file0-2"]);
        let route2 = route_chapter(2, "2-1", vec!["file1-1"]);
        let doc = document_with_chapters(vec![route1, route2]);
        let chapter_file_ids = vec![0, 1];
        let pb = Playback::from_merged_document(&doc, &chapter_file_ids);

        let generation_before = pb.flags.generation();
        let position_before = pb.position();
        let items_len_before = pb.items.len();

        let total_first = pb.total();
        let total_second = pb.total();

        assert_eq!(total_first, 2, "現在シーンはfile0内なのでfile0の2行のはず");
        assert_eq!(
            total_first, total_second,
            "何も変化していない連続呼び出しは同じ値を返すはず"
        );
        assert_eq!(
            pb.flags.generation(),
            generation_before,
            "total()の呼び出しがflagsのgenerationを変えてはならない"
        );
        assert_eq!(
            pb.position(),
            position_before,
            "total()の呼び出しが実プレイのposition()を変えてはならない"
        );
        assert_eq!(
            pb.items.len(),
            items_len_before,
            "total()の呼び出しが実プレイのitemsを追記してはならない"
        );
    }

    #[test]
    fn total_cache_invalidates_when_flag_changes_within_same_file_in_multi_file_doc() {
        // デシジョンテーブル行4（同一ファイル内でflagが変化）の複数ファイル版。
        // scene構成・期待値はtotal_reflects_real_play_flags_and_cache_invalidates_when_flags_change
        // と同じ（route-bのcondition評価がroute-aのflag設定より先にscanされる、という
        // total()の独立スキャンの性質を利用）で、file1(route2相当)を追加している点だけが
        // 異なる。file_idは不変のままgenerationだけが変化してもキャッシュが正しく
        // 無効化されること、かつfile1の行が誤って合算されないこと（多重の絞り込み）を
        // 同時に確認する。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "route-b",
                    vec![
                        dialog(Some("Intro"), vec!["導入"]),
                        condition_event("seen_a", vec![dialog(Some("B2"), vec!["Aを見た後"])]),
                    ],
                ),
                scene(
                    "route-a",
                    vec![
                        dialog(Some("A"), vec!["ルートA"]),
                        flag_event("seen_a", true),
                    ],
                ),
            ],
        );
        let route2 = route_chapter(2, "2-1", vec!["file1-1"]);
        let doc = document_with_chapters(vec![ch1, route2]);
        let chapter_file_ids = vec![0, 1];
        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);

        let total_before = pb.total();
        assert_eq!(
            total_before, 2,
            "route-b条件評価時点ではseen_aが未設定なのでIntro + Aの2行のはず\
             （B2は含まれず、file1の行も合算されない）"
        );

        let generation_before = pb.flags.generation();
        assert!(
            pb.advance(),
            "Intro -> シーン境界を越えてroute-aのAへ進めるはず（同一ファイル内なので\
             file境界チェックには引っかからない）"
        );
        assert_ne!(
            pb.flags.generation(),
            generation_before,
            "advance()でroute-aのEvent::Flagが実行されたので世代番号が進むはず"
        );

        let total_after = pb.total();
        assert_eq!(
            total_after, 3,
            "seen_aが立った後はB2もカウントに含まれ3行になるはず（file_idはfile0の\
             ままなので世代番号の変化だけでキャッシュが再スキャンされたことの確認、\
             file1の1行は依然として合算されない）"
        );
    }

    #[test]
    fn condition_treats_string_and_number_flag_values_as_truthy_when_present_via_playback() {
        // セルフレビュー対応（#509）: `GameFlags::check`のString/Number分岐
        // （flags.rs側の単体テストでは検証済み）が、`build_scene_items`/`Playback`を
        // 通した実際のCondition評価でも同じセマンティクスで機能することを統合的に確認する。
        let doc = doc_single_scene(vec![
            Event::Flag {
                name: "route".to_string(),
                value: FlagValue::String("A".to_string()),
            },
            condition_event(
                "route",
                vec![dialog(Some("B"), vec!["文字列フラグでも表示されるはず"])],
            ),
            Event::Flag {
                name: "count".to_string(),
                value: FlagValue::Number(0.0),
            },
            condition_event(
                "count",
                vec![dialog(
                    Some("C"),
                    vec!["数値0でも存在すればtrueなので表示されるはず"],
                )],
            ),
        ]);
        let mut pb = Playback::from_document(&doc);

        let line = pb
            .current_line()
            .expect("文字列フラグの条件内台詞が最初のitemのはず");
        assert_eq!(line.speaker.as_deref(), Some("B"));

        assert!(pb.advance(), "B -> 数値フラグの条件内台詞へ進めるはず");
        let line = pb
            .current_line()
            .expect("Number(0.0)も存在すればtrueなので条件内台詞が表示されるはず");
        assert_eq!(line.speaker.as_deref(), Some("C"));

        assert!(pb.is_at_end(), "後続イベントが無いので末尾のはず");
    }

    #[test]
    fn flag_in_zero_item_scene_still_applies_when_auto_skip_passes_through_it() {
        // セルフレビュー対応（#509）: `advance()`の「itemを1件も生成しなかったシーンは
        // 読み飛ばす」ループ（本関数内の"このシーンはitemを1件も生成しなかった。さらに
        // 次のシーンへ。"コメント参照）を通過するシーンが`Event::Flag`しか持たない場合でも、
        // その副作用（flags.set）が読み飛ばされずに適用されることを確認する。#509以前は
        // Flag/Conditionを一切処理していなかったため、この相互作用は今回のPRで初めて
        // 意味を持つようになった組み合わせ。
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![dialog(Some("A"), vec!["最初のシーン"])]),
                // 表示可能なitemを1件も持たない、Event::Flagのみのシーン。
                scene("1-2", vec![flag_event("mid", true)]),
                scene(
                    "1-3",
                    vec![condition_event(
                        "mid",
                        vec![dialog(Some("B"), vec!["1-2のflagが効いているはず"])],
                    )],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);

        assert_eq!(
            pb.current_line().expect("1-1の台詞").speaker.as_deref(),
            Some("A")
        );

        assert!(
            pb.advance(),
            "1-1 -> item0件の1-2を読み飛ばして1-3の条件付き台詞まで進めるはず"
        );
        let line = pb
            .current_line()
            .expect("1-2のflag副作用が適用され1-3の条件が成立しているはず");
        assert_eq!(line.speaker.as_deref(), Some("B"));
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

    fn bgm_stop_with_path(path: &str) -> Event {
        // 通常の原稿では起こらない組み合わせ（Stopなのにpathが付いている）だが、
        // GUI版と同じ「actionがStopなら無条件で停止」という意味論を固定するために使う
        // （デシジョンテーブル1' #3）。
        Event::Bgm {
            path: Some(path.to_string()),
            action: BgmAction::Stop,
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
                    vec![bgm_play("amehure.ogg"), choice(vec![("yes", "1-2")])],
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
        let before = pb.item_index();
        pb.advance();
        assert_ne!(
            before,
            pb.item_index(),
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
        let before = pb.item_index();
        assert!(pb.advance(), "同じLine item内の次の文へ進めるはず");
        assert_eq!(
            before,
            pb.item_index(),
            "文送りだけではcursorは変化しないはず"
        );
    }

    // ---- #502 追補: テスト設計担当のデシジョンテーブルに基づく追加ケース ----

    #[test]
    fn consecutive_same_bgm_path_keeps_state_unchanged() {
        // デシジョンテーブル1 #3: 同一BGMパスが連続する場合([BGM:a][Dialog][BGM:a])、
        // current_bgm()は変化せずSome(a)のままであることを確認する。値としては同じだが
        // 「無条件で状態は保持される」ことの確認であり、実際に再生を再スタートしないかは
        // audio.rs層の話なのでここでは扱わない。
        let doc = doc_single_scene(vec![
            bgm_play("a.ogg"),
            dialog(Some("A"), vec!["1"]),
            bgm_play("a.ogg"),
            dialog(Some("A"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        pb.advance();
        assert_eq!(
            pb.current_bgm(),
            Some("a.ogg"),
            "同一パスの再Play後もcurrent_bgm()はSome(a.ogg)のまま"
        );
    }

    #[test]
    fn bgm_stop_with_path_present_still_clears_current_bgm() {
        // デシジョンテーブル1' #3: Event::Bgm{action: Stop, path: Some(p)}
        // (pathがあってもStopが優先)でcurrent_bgm()がNoneになることを確認する。
        let doc = doc_single_scene(vec![
            bgm_play("a.ogg"),
            dialog(Some("A"), vec!["再生中"]),
            bgm_stop_with_path("a.ogg"),
            dialog(Some("A"), vec!["停止後"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        pb.advance();
        assert_eq!(
            pb.current_bgm(),
            None,
            "pathが付いていてもactionがStopなら停止扱いになるはず"
        );
    }

    #[test]
    fn choice_item_carries_se_attached_immediately_before_it() {
        // デシジョンテーブル2 #2: Choice直前に[SE:x]があるケース(Choiceにitem_seが
        // 付く)で、item_index()ベースのSE検出が正しく反応する(current_se_cues()が
        // Choice item自体でも値を返す)ことを確認する。
        let doc = doc_single_scene(vec![se("select.wav"), choice(vec![("進む", "1-1")])]);
        let pb = Playback::from_document(&doc);
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");
        assert_eq!(
            pb.current_se_cues(),
            &["select.wav".to_string()],
            "Choice item自体もSEを保持する"
        );
    }

    #[test]
    fn moving_choice_cursor_does_not_change_playback_cursor() {
        // デシジョンテーブル2 #3: Choice表示中のmove_choice_cursor_up/downは
        // self.index(item_index())を変えないため、SEが再発火しないことを確認する。
        let doc = doc_single_scene(vec![se("select.wav"), choice(vec![("A", "x"), ("B", "y")])]);
        let mut pb = Playback::from_document(&doc);
        let before = pb.item_index();
        pb.move_choice_cursor_down();
        assert_eq!(
            before,
            pb.item_index(),
            "カーソル移動だけではitem_index()は変化しないはず(SE再発火防止)"
        );
        assert_eq!(pb.current_se_cues(), &["select.wav".to_string()]);
    }

    #[test]
    fn select_current_choice_success_exposes_jump_targets_own_se() {
        // デシジョンテーブル2 #4: select_current_choice成功でjump先のitemが持つ
        // item_seが正しく参照できることを確認する(jump先itemに[SE:]を仕込む)。
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![choice(vec![("進む", "1-2")])]),
                scene(
                    "1-2",
                    vec![se("arrival.wav"), dialog(Some("A"), vec!["到着"])],
                ),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");
        assert_eq!(
            pb.current_se_cues(),
            &["arrival.wav".to_string()],
            "jump先itemのSEが正しく参照できるはず"
        );
    }

    #[test]
    fn backward_jump_to_already_visited_scene_refires_its_se_by_design() {
        // デシジョンテーブル2 #7: 後方jump(既訪問シーンへ戻る選択肢)で、そのitemのSEが
        // 「再発火する」ことを仕様として明示的に固定する。item_se/current_se_cues()は
        // cursor位置に対する純粋な参照であり、「一度発火したら二度と発火しない」ような
        // 消費済みフラグは持たない設計のため、同じitemへ再訪すれば同じSEが再び
        // current_se_cues()から観測される。これはバグではなく意図的な挙動である
        // (event_loop側がitem_index()の変化を検出するたびに毎回消費する設計、#502)。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![se("bgm-room.wav"), dialog(Some("A"), vec!["最初のシーン"])],
                ),
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
        assert_eq!(
            pb.current_se_cues(),
            &["bgm-room.wav".to_string()],
            "最初の訪問時にSEが記録されているはず"
        );
        pb.advance(); // "1-1"の台詞 → "1-2"の台詞
        pb.advance(); // "1-2"の台詞 → Choice
        assert!(
            pb.select_current_choice(),
            "既訪問シーンへの戻りjumpも成功するはず"
        );
        assert_eq!(
            pb.current_se_cues(),
            &["bgm-room.wav".to_string()],
            "既訪問シーンへ戻っても同じSEが再びcurrent_se_cues()に現れる(仕様、バグではない)"
        );
    }

    #[test]
    fn multiple_se_are_all_recorded_regardless_of_path_validity() {
        // 観点7: 複数SEのうち1件のパスが(config層のresolve_sound_pathでは弾かれる
        // ような値)であっても、Playback層はパスの妥当性を検証しないため、全てのSEが
        // item_se/current_se_cues()に記録されることを確認する(パス解決自体はconfig層の
        // 話であり、ここでは「複数SEが全て記録される」ことのみ確認する)。
        let doc = doc_single_scene(vec![
            se("valid.wav"),
            se("../escape.wav"), // resolve_sound_pathなら弾かれるパスだがPlayback層は関知しない
            dialog(Some("A"), vec!["後"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current_se_cues(),
            &["valid.wav".to_string(), "../escape.wav".to_string()],
            "パスの妥当性に関わらず両方のSEが記録される"
        );
    }

    #[test]
    fn select_current_choice_failure_leaves_bgm_and_se_state_unchanged() {
        // 観点8: select_current_choice失敗時(無効jump)にcurrent_bgm()/
        // current_se_cues()相当が変化しないことを確認する。
        let doc = doc_single_scene(vec![
            bgm_play("room.ogg"),
            se("warn.wav"),
            choice(vec![("存在しない先へ", "does-not-exist")]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_bgm(), Some("room.ogg"));
        assert_eq!(pb.current_se_cues(), &["warn.wav".to_string()]);

        assert!(
            !pb.select_current_choice(),
            "存在しないシーンIDへのjumpは失敗するはず"
        );

        assert_eq!(
            pb.current_bgm(),
            Some("room.ogg"),
            "jump失敗後もBGM状態は変わらないはず"
        );
        assert_eq!(
            pb.current_se_cues(),
            &["warn.wav".to_string()],
            "jump失敗後もSE状態は変わらないはず"
        );
    }

    #[test]
    fn confirming_choice_jump_moves_cursor_away_from_source_choice_se() {
        // 観点9: Choice確定ジャンプで遷移した際、遷移元Choice item自体のSEが
        // 再発火しない(cursorが変わるのは遷移後のみ)ことを確認する。遷移元Choiceが
        // 持っていたSEはジャンプ後には現れず(target itemが別のSEを持つため)、
        // item_index()も遷移元とは異なる値に変化していることを確認する。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![se("open-menu.wav"), choice(vec![("進む", "1-2")])],
                ),
                scene("1-2", vec![dialog(Some("A"), vec!["次のシーン"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.current_se_cues(), &["open-menu.wav".to_string()]);
        let source_cursor = pb.item_index();

        assert!(pb.select_current_choice(), "有効なjump先なので成功するはず");

        assert_ne!(
            source_cursor,
            pb.item_index(),
            "ジャンプ後はitem_index()が変化しているはず(遷移元Choiceへの再到達ではない)"
        );
        assert!(
            pb.current_se_cues().is_empty(),
            "遷移元Choice自体のSEは遷移後には現れない(target itemは別のSEを持つため)"
        );
    }

    // ---- #533: stable_item_key へのコンテンツハッシュ追加(フラグ依存シーン再訪の取り違え防止) ----

    #[test]
    fn content_signature_is_stable_for_identical_line_items() {
        let line = DisplayLine {
            speaker: Some("カコ".to_string()),
            text: vec!["やあ".to_string()],
            event_image: None,
        };
        let a = PlaybackItem::Line(line.clone());
        let b = PlaybackItem::Line(line);
        assert_eq!(
            content_signature(&a),
            content_signature(&b),
            "同一内容のLine itemは同じハッシュになるはず"
        );
    }

    #[test]
    fn content_signature_differs_when_text_differs() {
        let a = PlaybackItem::Line(DisplayLine {
            speaker: Some("カコ".to_string()),
            text: vec!["やあ".to_string()],
            event_image: None,
        });
        let b = PlaybackItem::Line(DisplayLine {
            speaker: Some("カコ".to_string()),
            text: vec!["さようなら".to_string()],
            event_image: None,
        });
        assert_ne!(
            content_signature(&a),
            content_signature(&b),
            "本文が異なればハッシュも異なるはず"
        );
    }

    #[test]
    fn content_signature_differs_when_event_image_differs() {
        let a = PlaybackItem::Line(DisplayLine {
            speaker: None,
            text: vec!["同じ本文".to_string()],
            event_image: Some("a.webp".to_string()),
        });
        let b = PlaybackItem::Line(DisplayLine {
            speaker: None,
            text: vec!["同じ本文".to_string()],
            event_image: Some("b.webp".to_string()),
        });
        assert_ne!(
            content_signature(&a),
            content_signature(&b),
            "本文が同じでもevent_imageが異なればハッシュも異なるはず"
        );
    }

    #[test]
    fn content_signature_differs_between_line_and_image_variants_with_identical_payload() {
        // セルフレビュー指摘(#533 PR #534 should): 中身のDisplayLineが偶然同一でも、
        // Line/Imageはitem種別が異なるためハッシュも異なるべき。
        let line = DisplayLine {
            speaker: Some("カコ".to_string()),
            text: vec!["同じ中身".to_string()],
            event_image: None,
        };
        let a = PlaybackItem::Line(line.clone());
        let b = PlaybackItem::Image(line);
        assert_ne!(
            content_signature(&a),
            content_signature(&b),
            "DisplayLineの中身が同一でもLine/Imageのvariantが異なればハッシュも異なるはず"
        );
    }

    #[test]
    fn content_signature_is_stable_for_identical_choice_items() {
        let options = vec![
            ChoiceOption {
                text: "進む".to_string(),
                jump: "1-2".to_string(),
            },
            ChoiceOption {
                text: "戻る".to_string(),
                jump: "1-1".to_string(),
            },
        ];
        let a = PlaybackItem::Choice(options.clone(), Some(2));
        let b = PlaybackItem::Choice(options, Some(2));
        assert_eq!(
            content_signature(&a),
            content_signature(&b),
            "同一内容のChoice itemは同じハッシュになるはず"
        );
    }

    #[test]
    fn content_signature_differs_when_choice_jump_target_differs() {
        let a = PlaybackItem::Choice(
            vec![ChoiceOption {
                text: "進む".to_string(),
                jump: "1-2".to_string(),
            }],
            None,
        );
        let b = PlaybackItem::Choice(
            vec![ChoiceOption {
                text: "進む".to_string(),
                jump: "1-3".to_string(),
            }],
            None,
        );
        assert_ne!(
            content_signature(&a),
            content_signature(&b),
            "選択肢のテキストが同じでもjump先が異なればハッシュも異なるはず"
        );
    }

    /// 2つの排他的フラグ(`milestone_a_pending`/`milestone_b_pending`)で内容が変わる
    /// "hub" シーンに、異なるルート("route1"→"route2")から2回ジャンプする構成
    /// (Gymnasia実データの`hub_gate`パターンを模す)。
    fn hub_revisit_doc() -> Document {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "route1",
                    vec![
                        flag_event("milestone_a_pending", true),
                        flag_event("milestone_b_pending", false),
                        choice(vec![("hubへ", "hub")]),
                    ],
                ),
                scene(
                    "hub",
                    vec![
                        condition_event(
                            "milestone_a_pending",
                            vec![dialog(Some("施設"), vec!["Aの定期報告"])],
                        ),
                        condition_event(
                            "milestone_b_pending",
                            vec![dialog(Some("施設"), vec!["Bの定期報告"])],
                        ),
                        choice(vec![("次のルートへ", "route2")]),
                    ],
                ),
                scene(
                    "route2",
                    vec![
                        flag_event("milestone_a_pending", false),
                        flag_event("milestone_b_pending", true),
                        choice(vec![("hubへ", "hub")]),
                    ],
                ),
            ],
        );
        document_with_chapters(vec![ch1])
    }

    #[test]
    fn stable_item_key_content_hash_differs_when_flag_dependent_scene_content_changes_across_revisits(
    ) {
        let doc = hub_revisit_doc();
        let mut pb = Playback::from_document(&doc);

        // route1 → hub (1回目訪問): milestone_a_pending=true のまま。
        assert!(
            pb.select_current_choice(),
            "route1からhubへジャンプできるはず"
        );
        let first_key = pb
            .stable_item_key(pb.item_index())
            .expect("hub 1回目訪問のitemはキーを持つはず");
        assert_eq!(
            pb.current_line().unwrap().text,
            vec!["Aの定期報告".to_string()],
            "1回目はmilestone_a_pendingが立っているのでAの定期報告が最初のitemのはず"
        );

        // hub → route2 → hub (2回目訪問): milestone_b_pendingへ反転済み。route2は
        // Flag設定のみ・Choiceが1件だけの純粋な中継シーンのため、#574の中継シーン
        // 自動継続により、この1回の select_current_choice 呼び出しだけでroute2を
        // 経由してhubまで一気に進む（#574以前はroute2でいったん止まり、
        // select_current_choiceをもう一度呼ぶ必要があった）。
        assert!(pb.advance(), "hub台詞からChoiceへ進めるはず");
        assert!(
            pb.select_current_choice(),
            "hubからroute2を自動通過してhubへジャンプできるはず"
        );
        let second_key = pb
            .stable_item_key(pb.item_index())
            .expect("hub 2回目訪問のitemはキーを持つはず");
        assert_eq!(
            pb.current_line().unwrap().text,
            vec!["Bの定期報告".to_string()],
            "2回目はmilestone_b_pendingが立っているのでBの定期報告が最初のitemのはず"
        );

        assert_eq!(
            (first_key.0, first_key.1),
            (second_key.0, second_key.1),
            "(scene_idx, local_index)自体は1回目・2回目とも同じ組み合わせのはず(#533の前提バグ)"
        );
        assert_ne!(
            first_key, second_key,
            "内容が異なる(Aの定期報告 vs Bの定期報告)ので、コンテンツハッシュを含む3つ組全体は一致してはいけない(#533)"
        );
    }

    #[test]
    fn stable_item_key_is_identical_when_revisiting_same_scene_with_unchanged_flags() {
        // 退行防止: フラグを一切使わず同一シーンへ戻る通常のスキップ判定ケースでは、
        // コンテンツハッシュを含む3つ組が完全に一致し続けるはず(#533導入前と同じ挙動)。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        dialog(Some("A"), vec!["繰り返し表示される台詞"]),
                        choice(vec![("進む", "1-2"), ("戻る", "1-1")]),
                    ],
                ),
                scene("1-2", vec![dialog(Some("B"), vec!["別シーン"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let mut pb = Playback::from_document(&doc);
        // 1回目訪問時の台詞itemのキーを、Choiceへ進む前に(local_index=0の状態で)捕捉する。
        let first_key = pb
            .stable_item_key(pb.item_index())
            .expect("1回目訪問の台詞itemはキーを持つはず");

        // 選択肢「戻る」で同じシーン("1-1")を、フラグ状態を変えずに再訪する。
        assert!(pb.advance(), "台詞からChoiceへ進めるはず");
        pb.move_choice_cursor_down();
        assert!(
            pb.select_current_choice(),
            "戻る選択で自シーンへ再ジャンプできるはず"
        );
        assert_eq!(
            pb.current_line().unwrap().text,
            vec!["繰り返し表示される台詞".to_string()],
            "再訪後も1-1の台詞から始まるはず"
        );
        let second_key = pb
            .stable_item_key(pb.item_index())
            .expect("2回目訪問のitemはキーを持つはず");

        assert_eq!(
            first_key, second_key,
            "フラグを変えずに同一シーンへ戻った場合は3つ組が完全一致し続けるはず(退行防止)"
        );
    }

    /// `hub_revisit_doc` と同じ route1/hub/route2 の3シーン構成だが、hubシーン内の
    /// `Condition` 分岐先イベント数自体を1回目と2回目で変える（1件 vs 2件）。
    /// 元Issue #533が挙げていた「シーン内で構築される要素の並び・件数自体がずれる」
    /// ケースを再現する（#539）。
    fn hub_revisit_item_count_shift_doc() -> Document {
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "route1",
                    vec![
                        flag_event("milestone_a_pending", true),
                        flag_event("milestone_b_pending", false),
                        choice(vec![("hubへ", "hub")]),
                    ],
                ),
                scene(
                    "hub",
                    vec![
                        condition_event(
                            "milestone_a_pending",
                            vec![dialog(Some("施設"), vec!["Aの手紙"])],
                        ),
                        condition_event(
                            "milestone_b_pending",
                            vec![
                                dialog(Some("施設"), vec!["Bの手紙1"]),
                                dialog(Some("施設"), vec!["Bの手紙2"]),
                            ],
                        ),
                        choice(vec![("次のルートへ", "route2")]),
                    ],
                ),
                scene(
                    "route2",
                    vec![
                        flag_event("milestone_a_pending", false),
                        flag_event("milestone_b_pending", true),
                        choice(vec![("hubへ", "hub")]),
                    ],
                ),
            ],
        );
        document_with_chapters(vec![ch1])
    }

    #[test]
    fn stable_item_key_content_hash_differs_when_flag_dependent_scene_item_count_itself_shifts_across_revisits(
    ) {
        // 元Issue #533「残っている限界」節が挙げていた、シーン内で構築されるitem数自体が
        // 訪問ごとにずれるケース（#539で追加した検証）。1回目訪問はhub内item数が2件
        // (Aの手紙+Choice)、2回目訪問は3件(Bの手紙1+Bの手紙2+Choice)に変わる —
        // どちらの訪問でも local_index=0 の item を比較する。
        let doc = hub_revisit_item_count_shift_doc();
        let mut pb = Playback::from_document(&doc);

        // route1 → hub (1回目訪問): milestone_a_pendingのみ真。
        assert!(
            pb.select_current_choice(),
            "route1からhubへジャンプできるはず"
        );
        let first_key = pb
            .stable_item_key(pb.item_index())
            .expect("hub 1回目訪問のitemはキーを持つはず");
        assert_eq!(
            pb.current_line().unwrap().text,
            vec!["Aの手紙".to_string()],
            "1回目訪問の最初のitem(local_index=0)はAの手紙のはず"
        );

        // hub → route2 → hub (2回目訪問): milestone_b_pendingへ反転済み。route2は
        // Flag設定のみ・Choiceが1件だけの純粋な中継シーンのため、#574の中継シーン
        // 自動継続により、この1回の select_current_choice 呼び出しだけでroute2を
        // 経由してhubまで一気に進む（#574以前はroute2でいったん止まり、
        // select_current_choiceをもう一度呼ぶ必要があった）。
        assert!(pb.advance(), "Aの手紙からChoiceへ進めるはず");
        assert!(
            pb.select_current_choice(),
            "hubからroute2を自動通過してhubへジャンプできるはず"
        );
        let second_key = pb
            .stable_item_key(pb.item_index())
            .expect("hub 2回目訪問のitemはキーを持つはず");
        assert_eq!(
            pb.current_line().unwrap().text,
            vec!["Bの手紙1".to_string()],
            "2回目訪問の最初のitem(local_index=0)はBの手紙1のはず\
             (シーン内item数自体が2件→3件に変化している)"
        );

        assert_eq!(
            (first_key.0, first_key.1),
            (second_key.0, second_key.1),
            "(scene_idx, local_index)自体は1回目・2回目ともlocal_index=0で一致する\
             (シーン内item数がずれても最初のitemのlocal_indexそのものは変わらない、\
             これが#533の取り違えの原因)"
        );
        assert_ne!(
            first_key, second_key,
            "item数自体がずれて同じlocal_index=0が別の内容(Aの手紙→Bの手紙1)を指す\
             ようになっても、コンテンツハッシュを含む3つ組全体は一致してはいけない\
             (#539: #533の件数ずれ懸念もこのfixで副次的にカバーされることの検証)"
        );

        // 念のため、2回目訪問のhubシーンが実際にitem数の増えた3件構成になっている
        // ことも確認する(Bの手紙1の次にBの手紙2が続く)。
        assert!(pb.advance(), "Bの手紙1からBの手紙2へ進めるはず");
        assert_eq!(
            pb.current_line().unwrap().text,
            vec!["Bの手紙2".to_string()],
            "2回目訪問はitemが1件増えているため、Bの手紙1の次はBの手紙2が続くはず"
        );
    }

    // ---- #528: select_current_choiceのファイル境界越えジャンプでの状態リセット ----

    #[test]
    fn select_current_choice_resets_running_state_when_jumping_across_file_boundary() {
        // route1(file 0)末尾でBGM再生中・イベント絵表示中・暗転中のまま、Choiceで
        // 別ファイルのhub(file 1)へジャンプする。route1のChoiceの直後(itemを消費する前)に
        // 置いたSEは、後続itemが無いためpending_seとしてscan_stateに残留したまま
        // ファイル境界を越える(#528のバグ再現条件そのもの)。
        let route1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![
                    Event::Bgm {
                        path: Some("a.ogg".to_string()),
                        action: BgmAction::Play,
                        fade_ms: None,
                    },
                    event_image("route1/scene.webp"),
                    Event::Blackout {
                        action: name_name_parser::models::BlackoutAction::On,
                    },
                    dialog(Some("A"), vec!["ルート1: 最後の台詞"]),
                    choice(vec![("hubへ", "hub")]),
                    se("orphan.wav"),
                ],
            )],
        );
        let hub = chapter(
            2,
            vec![scene("hub", vec![dialog(Some("施設"), vec!["定期報告"])])],
        );
        let doc = document_with_chapters(vec![route1, hub]);
        let chapter_file_ids = vec![0, 1];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert!(pb.advance(), "台詞からChoiceへ進めるはず");
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");
        // ジャンプ前の時点でBGM/イベント絵/暗転/pending_seが全て残留していることを確認
        // (このあとのジャンプでリセットされることを対比させるため)。
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        assert!(pb.is_blackout());

        assert!(
            pb.select_current_choice(),
            "別ファイルのhubへのjumpは成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("jump先の台詞").text,
            vec!["定期報告".to_string()]
        );

        assert_eq!(
            pb.current_bgm(),
            None,
            "ファイル境界を越えたのでroute1のBGMはリセットされ、hub側で新規指定が無い限りNoneのはず(#528)"
        );
        assert_eq!(
            pb.current_line().unwrap().event_image,
            None,
            "ファイル境界を越えたのでroute1のイベント絵はリセットされるはず(#528)"
        );
        assert!(
            !pb.is_blackout(),
            "ファイル境界を越えたのでroute1の暗転状態はリセットされるはず(#528)"
        );
        assert!(
            pb.current_se_cues().is_empty(),
            "ファイル境界を越えたのでroute1末尾のpending_se(orphan.wav)は引き継がれないはず(#528)"
        );
    }

    #[test]
    fn select_current_choice_resets_speaker_and_text_when_jumping_across_file_boundary_into_wait_chain(
    ) {
        // #540: route1(file 0)の最後の会話行の話者・本文が、ファイル境界を越えたChoice
        // ジャンプ先(hub, file 1)の [イベント絵:][待機:Nms] 自動連続表示チェーン
        // （会話行を一切経ずにシーン先頭へ直接置かれるパターン、
        // docs/spec/markdown-v0.1.mdでは禁止されていない）にそのまま乗ってしまう
        // 回帰の再現。#528と同じ根本原因(ファイル境界を越えてもscan_stateが
        // current_speaker/current_textを引き継ぐ)がこのフィールドにも及ぶことを示す。
        let route1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![
                    dialog(Some("A"), vec!["ルート1: 最後の台詞"]),
                    choice(vec![("hubへ", "hub")]),
                ],
            )],
        );
        let hub = chapter(
            2,
            vec![scene("hub", vec![event_image("hub/open.webp"), wait(200)])],
        );
        let doc = document_with_chapters(vec![route1, hub]);
        let chapter_file_ids = vec![0, 1];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert_eq!(
            pb.current_line()
                .expect("初期位置は台詞itemのはず")
                .speaker
                .as_deref(),
            Some("A"),
            "advance前はroute1の台詞が現在位置のはず"
        );
        assert!(pb.advance(), "台詞からChoiceへ進めるはず");
        assert!(pb.current_choice().is_some(), "Choiceが現在位置のはず");

        assert!(
            pb.select_current_choice(),
            "別ファイルのhubへのjumpは成功するはず"
        );
        let line = pb
            .current_line()
            .expect("画像コマitem(イベント絵+待機チェーン)のDisplayLine");
        assert_eq!(
            line.speaker, None,
            "ファイル境界を越えたのでroute1の話者はリセットされ、hub側に会話行が\
             無い限りNoneのはず(#540)"
        );
        assert!(
            line.text.is_empty(),
            "ファイル境界を越えたのでroute1の本文はリセットされ、hub側に会話行が\
             無い限り空のはず(#540)"
        );
        assert_eq!(
            line.event_image.as_deref(),
            Some("hub/open.webp"),
            "画像コマ自体はhub側の新しいイベント絵を表示するはず"
        );
    }

    #[test]
    fn select_current_choice_preserves_running_state_when_jumping_within_same_file() {
        // 同一ファイル内のジャンプでは、#528/#540のリセットは発火せず、BGM/イベント絵/
        // 暗転/pending SEがすべてそのまま引き継がれる(同一ルート内でシーンを跨いで
        // これらの状態が継続する、既存の意図した挙動)。クロスファイル側のテスト
        // (select_current_choice_resets_running_state_when_jumping_across_file_boundary)は
        // 4フィールド全部を確認しているが、こちらは従来BGMしか確認しておらず非対称
        // だった(#540 should対応、他3フィールドも追加)。
        let ch1 = chapter(
            1,
            vec![
                scene(
                    "1-1",
                    vec![
                        Event::Bgm {
                            path: Some("a.ogg".to_string()),
                            action: BgmAction::Play,
                            fade_ms: None,
                        },
                        event_image("route1/mid.webp"),
                        Event::Blackout {
                            action: name_name_parser::models::BlackoutAction::On,
                        },
                        dialog(Some("A"), vec!["中間の台詞"]),
                        choice(vec![("同ファイル内ジャンプ", "1-2")]),
                        se("orphan.wav"),
                    ],
                ),
                scene("1-2", vec![dialog(Some("B"), vec!["次のシーン"])]),
            ],
        );
        let doc = document_with_chapters(vec![ch1]);
        let chapter_file_ids = vec![0];

        let mut pb = Playback::from_merged_document(&doc, &chapter_file_ids);
        assert!(pb.advance(), "台詞からChoiceへ進めるはず");
        assert_eq!(pb.current_bgm(), Some("a.ogg"));
        assert!(pb.is_blackout());

        assert!(
            pb.select_current_choice(),
            "同一ファイル内のjumpは成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("jump先の台詞").text,
            vec!["次のシーン".to_string()]
        );
        assert_eq!(
            pb.current_bgm(),
            Some("a.ogg"),
            "同一ファイル内のジャンプでは#528のリセットは発火せず、BGMは引き継がれ続けるはず"
        );
        assert_eq!(
            pb.current_line().unwrap().event_image.as_deref(),
            Some("route1/mid.webp"),
            "同一ファイル内のジャンプではイベント絵も引き継がれ続けるはず(#540)"
        );
        assert!(
            pb.is_blackout(),
            "同一ファイル内のジャンプでは暗転状態も引き継がれ続けるはず(#540)"
        );
        assert_eq!(
            pb.current_se_cues(),
            &["orphan.wav".to_string()],
            "同一ファイル内のジャンプではpending_se(orphan.wav)も引き継がれ、jump先の\
             最初のitemで再生されるはず(#540)"
        );
    }
}
