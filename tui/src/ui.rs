//! ratatui による画面描画。左にイベント絵（quadrant block変換 + jiwaクロスフェード、
//! `image_fade`/`image_render`、#481。未指定時は従来の画像プレースホルダにフォールバック）、
//! 右に相手（上）/自分（下）の2ウィンドウでテキストを表示する。左右は基本50/50（GUI版
//! `frontend/src/game/novelLayout.ts` の
//! `computeSplitLayoutRegions` と同じ比率、#480）だが、間に固定幅
//! [`IMAGE_TEXT_GAP_WIDTH`] のスペーサーを挟む都合上、実際にどちらへ何セル寄るかは端末幅
//! 次第で非単調に変わる非対称な分割になる（#488。GUI版はテキスト側の内側マージン
//! `NOVEL_TEXT_MARGIN_X` で密着を避けているが、TUI版は列間そのものにギャップを作る形で
//! 対応する。詳細は [`split_columns`] を参照）。テキスト側の上下分割も比率としては50/50
//! だが、GUI版の `splitTextRegionForDualWindow` が浮動小数点で分割するのに対し、TUI版は
//! 整数セル単位のため高さが奇数のとき端数が出る。GUI版と違いこの端数は self（自分＝
//! プレイヤー発言側）に寄せる（`draw_text_windows` 参照）— self が opponent より恒常的に
//! 損をする片側固定バイアスを避けるための意図的な差異（セルフレビュー修正）。GUI版の
//! dual-window は常に borderless のため、こちらも罫線の枠は描かない。話者名ラベルも表示しない
//! — 話者識別は「上下どちらの窓か」（位置）と `Config::color_name_for` の文字色で行う。
//!
//! 画面全体は [`Constraint::Percentage`] による端末サイズへの動的追従をやめ、固定寸法の
//! キャンバス（[`REQUIRED_TOTAL_WIDTH`] x [`REQUIRED_TOTAL_HEIGHT`]）+ センタリング +
//! 最小サイズゲートにしている（#494）。GUI版の `aspect_ratio: auto` 機構
//! （`pickFluidAspectRatio`/`computeSplitLayoutRegions`）はブラウザウィンドウを動的に
//! 「都合の良い形」へ再構成してから描画するピクセルベース特有の前提に依存しており、
//! セル/グリフ単位の離散描画である TUI には原理的に移植できない（kako-jun確認: 「TUIは
//! それをできないので完全に合わせることはもともとむりだ」）。代わりに、端末が固定サイズ
//! より大きい場合はキャンバス全体を中央配置（レターボックス/ピラーボックス、
//! [`compute_centered_canvas`]）し、小さい場合は縮小描画をせず案内メッセージのみを表示する
//! （[`fits_required_size`]/[`draw_too_small_message`]、kako-jun確認:「それでいい。縮小された
//! 絵を見ても仕方ないからね」）。[`split_columns`] 自体は「渡された `Rect` を画像/gap/テキストへ
//! 3分割する」という責務のまま変更しておらず、渡ってくる `Rect` が「実際の端末サイズ」から
//! 「固定サイズ＋センタリング後の `Rect`」に変わるだけである。

use std::str::FromStr;
use std::time::Instant;

use name_name_parser::models::ChoiceOption;
use ratatui::buffer::CellWidth;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::config::{
    Config, PlaceholderStyle, VolumeConfig, TEXT_SPEED_MAX_MS, TEXT_SPEED_STEP_MS,
    VOLUME_MAX_PERCENT, VOLUME_STEP_PERCENT,
};
use crate::image_fade::ImageFadeState;
use crate::image_render::{
    clamp_scroll_offset, compute_full_width_rows, rgba_to_quadrant_grid_window, DecodedImage,
    ImageCache, RenderedImage,
};
use crate::playback::DisplayLine;
use crate::reveal;

/// 画像列とテキスト列の間に挟む固定幅スペーサーのセル数（#488）。テキストが画像に密着して
/// 見える問題への対応で、kako-jun実機確認により「半角2つぶんくらい」が妥当と判断された値
/// をそのまま採用している（1セル=半角1文字相当なので幅2）。GUI版はテキスト領域の内側
/// マージン `NOVEL_TEXT_MARGIN_X`（`frontend/src/game/DialogBox.ts`）で密着を避けているが、
/// こちらは列と列の「間」に入れる構造的なギャップという別の実装形（テキスト領域内側の
/// 全方向パディングまでは #488 のスコープ外）。
const IMAGE_TEXT_GAP_WIDTH: u16 = 2;

/// 固定キャンバスの本編領域（画像ペイン・テキストペイン共通の高さ、ステータス行を除く）の
/// セル数（#494）。この値そのものに強い根拠は無く（`IMAGE_TEXT_GAP_WIDTH`と同種の実機調整
/// 前提の初期値）、[`REQUIRED_IMAGE_COLS`] の導出元になる点が重要 — 詳細は下記を参照。
const REQUIRED_MAIN_CONTENT_ROWS: u16 = 20;

/// 画像ペインに必要な幅（セル数）。正方形画像（gymnasiaの128x128マスター想定）を
/// クロップ無しで表示するための式（#494）。
///
/// quadrant block の2x2サブピクセルグリッドは `sub_w = image_cols*2`,
/// `sub_h = image_rows*2` であり、`image_render::rgba_to_quadrant_grid` は
/// `effective_target_h = sub_h / TERMINAL_CELL_ASPECT_RATIO`
/// （[`crate::image_render::TERMINAL_CELL_ASPECT_RATIO`]、既定0.5）を実効ターゲット高さとして
/// cover-fit のクロップ計算に渡す。正方形画像でクロップを0にするには
/// `sub_w == effective_target_h` が必要で、これを解くと
/// `image_cols*2 == (image_rows*2) / TERMINAL_CELL_ASPECT_RATIO` → 定数0.5のとき
/// `image_cols = image_rows * 2` になる（この関係は `TERMINAL_CELL_ASPECT_RATIO = 0.5` という
/// 具体値そのものに依存しており、式を逆算すると AR はこの値に一意に定まる。AR非依存で
/// 不変なのはむしろ逆で、`REQUIRED_MAIN_CONTENT_ROWS`（rows）の具体値の方 —
/// `sub_w = rows*4` と `effective_target_h = (rows*2)/TERMINAL_CELL_ASPECT_RATIO` の式で
/// rows は両辺で約分されて消えるため自由に選べる。将来 `TERMINAL_CELL_ASPECT_RATIO` を
/// 調整する場合は、この `*2` の式も合わせて見直す必要がある）。実際にクロップ0になることは
/// `tests::fixed_canvas_square_image_crops_nothing_at_required_image_pane_size` で検算する。
const REQUIRED_IMAGE_COLS: u16 = REQUIRED_MAIN_CONTENT_ROWS * 2;

/// テキストペインに必要な幅（セル数、#494）。日本語の折返しに十分な幅であることに加え、
/// `REQUIRED_IMAGE_COLS + 2` という一見不思議な値には理由がある: `split_columns` は
/// `Constraint::Percentage(50)/Length(GAP)/Percentage(50)` を使っており、ratatui の
/// cassowary ソルバーは `Length` を優先的に満たした残り幅を2分割する際、幅が十分広い
/// steady state では前者（画像側）を「半分-1」・後者（テキスト側）を「半分+1」に割り当てる
/// （`split_columns` のdoc コメント、`split_columns_at_wide_area_gives_text_two_more_cells_than_image_steady_state`
/// で実測済みの挙動）。画像ペインの実際のレンダリング幅を[`REQUIRED_IMAGE_COLS`]ちょうどに
/// するには、`(REQUIRED_IMAGE_COLS + REQUIRED_TEXT_COLS)/2 - 1 == REQUIRED_IMAGE_COLS`を
/// 満たす必要があり、これを解くと `REQUIRED_TEXT_COLS = REQUIRED_IMAGE_COLS + 2` になる
/// （実際に画像ペイン幅が過不足なく一致することは
/// `tests::fixed_canvas_image_pane_width_matches_required_image_cols` で検算する）。
const REQUIRED_TEXT_COLS: u16 = REQUIRED_IMAGE_COLS + 2;

/// 固定キャンバス全体の必要幅（画像 + スペーサー + テキスト、#494）。`pub(crate)`:
/// `main.rs` の統合テストが `TestBackend` のサイズをハードコードせずここから導出するために
/// 公開している（`draw` を経由する以上、これ未満の端末サイズでは常に
/// [`draw_too_small_message`] だけが表示され、通常のゲームUIの検証にならないため）。
pub(crate) const REQUIRED_TOTAL_WIDTH: u16 =
    REQUIRED_IMAGE_COLS + IMAGE_TEXT_GAP_WIDTH + REQUIRED_TEXT_COLS;

/// 固定キャンバス全体の必要高さ（本編領域 + ステータス行1、#494）。`pub(crate)`の理由は
/// [`REQUIRED_TOTAL_WIDTH`] と同じ。
pub(crate) const REQUIRED_TOTAL_HEIGHT: u16 = REQUIRED_MAIN_CONTENT_ROWS + 1;

/// 実際の端末サイズ（`frame.area()`）が、固定キャンバスを描画するのに十分かどうかを判定する
/// 純粋関数（#494）。幅・高さのどちらか一方でも [`REQUIRED_TOTAL_WIDTH`]/
/// [`REQUIRED_TOTAL_HEIGHT`] に満たなければ `false` を返す。`draw` はこれが `false` のとき
/// 通常のゲームUI描画を一切行わず、代わりに [`draw_too_small_message`] だけを表示する
/// （GUI版のような動的リサイズはTUIでは原理的に成立しないという設計判断、モジュールdoc
/// コメント参照）。
fn fits_required_size(actual: Rect) -> bool {
    actual.width >= REQUIRED_TOTAL_WIDTH && actual.height >= REQUIRED_TOTAL_HEIGHT
}

/// `actual`（実際の端末の描画領域）の中央に、`required`（固定必要サイズ、`draw` からは常に
/// `Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT)` が渡る）と同じ幅・高さの
/// 矩形を配置した結果を返す純粋関数（#494）。実際の端末サイズの方が大きい場合、余った幅/高さは
/// 2で割った分だけ左/上に寄せる（`width`が奇数の余りは右側に残る＝GUI版のセンタリングと同様、
/// 厳密な左右対称は要求しない）。呼び出し前提は `fits_required_size(actual)` が真であること
/// （`draw` 参照）だが、この関数自体は `actual` が `required` より小さくても panic しないよう
/// 幅/高さをそれぞれ `required.*.min(actual.*)` へクランプしてから中央配置を計算する
/// （呼び出し側の防御的な保険。実運用ではこの縮小クランプ分岐には入らない）。
fn compute_centered_canvas(actual: Rect, required: Rect) -> Rect {
    let width = required.width.min(actual.width);
    let height = required.height.min(actual.height);
    let x = actual.x + (actual.width - width) / 2;
    let y = actual.y + (actual.height - height) / 2;
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// [`fits_required_size`] が `false` のとき、通常のゲームUIの代わりに表示する案内メッセージ
/// （#494）。btop等のTUIダッシュボードが小さすぎる端末で通常のダッシュボードの代わりに警告を
/// 出す方式と同じ発想 — ドット絵をピクセル単位で滑らかに縮小できないTUIでは、無理な縮小描画
/// より固定サイズ+レターボックスの方が画質を保てるため、`actual` が要求サイズに満たない場合は
/// 一切ゲームUIを描画しない（kako-jun確認: 「それでいい。縮小された絵を見ても仕方ないから
/// ね」）。過度に凝ったUI（枠・色等）は付けない（Issueのスコープ外）。
///
/// `Wrap` は使わない — ratatui 0.30.2 / ratatui-widgets 0.3.2 は特定の折り返し幅（実測:
/// 半角/全角混在の文字列で幅ちょうど2セル）で `Wrap` 付き `Paragraph` がバッファ範囲外書き込み
/// panic することがある既知のバグがある（[`MIN_SAFE_TEXT_WRAP_WIDTH`]/[`render_wrapped_paragraph`]
/// 参照）。ここへ来る `actual` は要求サイズ未満というだけで具体的な幅は0を含め任意になり得る
/// ため、危険幅を個別にガードするより wrap 無しのシンプルな1行表示（収まらない分は
/// `Alignment::Center` の描画がそのまま末尾を切り詰める）に留める方が安全かつ単純である。
fn draw_too_small_message(frame: &mut Frame, actual: Rect) {
    let message = format!(
        "端末を広げてください（現在 {}x{}、必要 {}x{}）",
        actual.width, actual.height, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT
    );
    let paragraph = Paragraph::new(message).alignment(Alignment::Center);
    // 縦方向中央寄せ: 1行想定のメッセージを実際の高さの中央付近の行に置く。
    // `draw_splash_text` と違い折り返し高さを事前計算しない分単純化しているが、それで十分
    // （Issueのスコープ外の凝った表現は避ける）。高さ0の極小端末では描画領域自体を
    // 0にしてpanicを避ける。
    let height = if actual.height == 0 { 0 } else { 1 };
    let y = actual.y + actual.height / 2;
    let area = Rect {
        x: actual.x,
        y,
        width: actual.width,
        height,
    };
    frame.render_widget(paragraph, area);
}

/// 画面上段を「画像プレースホルダ」「スペーサー」「テキスト」の横3分割にする純粋関数
/// （#488）。`Layout::split` の呼び出しをここへ切り出すことで、テスト側は実際のレイアウト
/// 計算結果をそのまま期待値として使える（手計算した固定値をテストに直書きしない）。
/// スペーサー領域（戻り値の2番目）には何も描画しない — ratatui は `Terminal::draw` のたびに
/// バッファを既定セル（空白）へリセットするため、明示的に描くコードが無くてもそこは単なる
/// 空白の余白として見える。画像/テキストは基本 `Constraint::Percentage(50)` ずつだが、
/// スペーサーの `Constraint::Length` を優先的に満たす ratatui のレイアウト解決の都合上、
/// 両者は均等に縮む/伸びるわけではない。どちらが有利になるかは単一方向のバイアスではなく
/// 端末幅（W）によって非単調に変わる（W=3〜4のような狭い幅域では画像側が、W=7以降の
/// 実用的な幅域ではテキスト側が恒常的に有利になり、その差は最大2セルにとどまる —
/// steady state）。#480 が「対称性を要求しない分割」としていたのと同じ理由でここでも
/// 問題ない。具体的な境界・数値は下記テスト群を参照。
fn split_columns(area: Rect) -> (Rect, Rect, Rect) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(50),
            Constraint::Length(IMAGE_TEXT_GAP_WIDTH),
            Constraint::Percentage(50),
        ])
        .split(area);
    (columns[0], columns[1], columns[2])
}

/// 実際の端末サイズ（`frame.area()`）が固定必要サイズに満たない場合は
/// [`fits_required_size`] で検知し、通常のゲームUI描画を一切せず [`draw_too_small_message`]
/// だけを表示して早期returnする（#494）。十分な場合は [`compute_centered_canvas`] で固定
/// サイズのキャンバスを中央配置してから、以下の画面全体を左（画像プレースホルダ）50% /
/// 右（テキスト、相手=上/自分=下にさらに分割）に分割して描画する。テキスト側の上下分割は
/// 整数セルの端数を self（自分）側に寄せる（`draw_text_windows` 参照。opponent が恒常的に
/// 得をする片側固定バイアスを避けるため）。最下段1行は進行状況（ゲーム名 + 会話位置/総数）
/// 専用の帯にする — 罫線の title として表示していた情報を、枠を使わず最小限の形で残すための
/// もの（過剰な装飾はしない）。
///
/// `reveal` は現在の会話行のタイプライター表示状態（[`reveal::RevealState`]、`None` は行
/// そのものが無いケース）、`indicator_started_at` はページ送りインジケータの点滅基準時刻
/// （reveal 完了後にのみ表示する。[`reveal::blink_visible`] にそのまま渡す。色はウィンドウ
/// （自分側/相手側）ごとに `draw_text_windows` が決める、#495）。呼び出し側（`main.rs` の
/// `event_loop`）が [`reveal::indicator_blink_started_at`] で毎フレーム更新した値を渡す —
/// reveal が非表示→表示に切り替わった瞬間（＝reveal完了の瞬間）に加え、`playback.item_index()`
/// が変化した（＝実際に新しい item へ進んだ。会話行だけを数える `position()` だと画像コマ
/// item への遷移を取りこぼすため、#497 で `item_index()` に乗り換え済み）瞬間も
/// `event_loop` 側が明示的に非表示→表示の遷移として扱われるよう仕込んでいる
/// （`char_interval_ms=0 &&
/// fade_duration_ms=0` では新しい行の reveal が生成された瞬間に既に完了しているため、
/// reveal 自体の遷移だけでは検出できない。[`reveal::indicator_blink_started_at`] のdoc
/// comment参照、セルフレビュー must対応、#495 追加修正2）。この関数自身は基準時刻を
/// そのまま下流に渡すだけで、リセットの発生条件を意識しない（#495 追加修正）。
/// `now` はこのフレームの
/// 描画時刻（`reveal`/`indicator_started_at` の `body_lines`/`blink_visible` に渡す基準時刻。
/// `RevealState::Done` はこれを無視する）。`image_fade` は左側に描画するイベント絵の
/// クロスフェード状態（[`ImageFadeState`]、`None` は event_image を一切扱わない呼び出し元
/// 向けのフォールバック）、`image_cache` はそのデコード結果キャッシュ（#481）。
///
/// `choice` が `Some((options, cursor, columns))`（選択肢表示中、#482。`columns` はグリッド
/// 配置の列数、#508）のときは、右側テキスト領域（`split_columns` が返すテキスト領域、#480の
/// 50/50分割＋#488のスペーサーはそのまま）に選択肢一覧を描画し、通常の相手/自分2ウィンドウ
/// （`draw_text_windows`）は描かない。選択肢には特定の話者が無いため、相手/自分の上下分割
/// という概念自体が意味を持たない（`line`/`choice` は同時に `Some` にならない —
/// `Playback::current_line`/`current_choice` が排他的なため。呼び出し側の `main.rs` は
/// この排他性を意識せず、両方をそのまま渡すだけでよい）。選択肢表示中も左側のイベント絵/
/// プレースホルダ（`image_fade`）はそのまま描画され続ける — 左カラムは右カラム（テキスト/
/// 選択肢の切替）とは独立しているため、選択肢表示は画像側のフェードやサイズに影響しない。
///
/// `blackout`（`Playback::is_blackout`、#512）が `true` のときは、左側の画像プレースホルダ/
/// イベント絵の代わりに黒一色を敷く。GUI版 `NovelRenderer` の `blackoutOverlay` が
/// 背景・立ち絵・イベント絵レイヤーより前面・ダイアログボックスより背面に位置する
/// （＝暗転中もテキストは黒地の上にそのまま読める）のに倣い、右側のテキスト/選択肢
/// （`draw_text_windows`/`draw_choice_list`）は暗転の影響を受けず通常どおり描画する。
/// `image_fade` のスナップショット計算自体は暗転中も継続する（クロスフェードの内部時刻を
/// 止めない）が、その結果は使わず捨てる — 暗転解除後にイベント絵が変な位置から再開しない
/// ようにするため。
#[allow(clippy::too_many_arguments)]
pub fn draw(
    frame: &mut Frame,
    config: &Config,
    line: Option<&DisplayLine>,
    choice: Option<(&[ChoiceOption], usize, Option<u32>)>,
    // 各選択肢がロックされているか（`option.condition` が未定義/false のフラグを
    // 指している、#591）。`choice` が `Some` のときだけ意味を持ち、`choice.0` と
    // 同じ長さ・同じ並びを期待する（`main.rs` が `Playback::current_choice_locked()`
    // から作って渡す）。`choice` が `None` のときは無視される。
    choice_locked: &[bool],
    position: usize,
    total: usize,
    is_at_end: bool,
    reveal: Option<&reveal::RevealState>,
    indicator_started_at: Instant,
    now: Instant,
    image_fade: Option<&ImageFadeState>,
    image_cache: &mut ImageCache,
    blackout: bool,
) {
    let actual = frame.area();
    if !fits_required_size(actual) {
        draw_too_small_message(frame, actual);
        return;
    }
    let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
    let canvas = compute_centered_canvas(actual, required);

    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(canvas);

    let (placeholder_area, _gap_area, text_area) = split_columns(root[0]);

    let rendered_image = image_fade.and_then(|state| {
        state.snapshot(
            image_cache,
            config,
            placeholder_area.width,
            placeholder_area.height,
            now,
        )
    });
    if blackout {
        draw_blackout(frame, placeholder_area);
    } else {
        draw_placeholder(frame, placeholder_area, config, rendered_image.as_ref());
    }
    match choice {
        Some((options, cursor, columns)) => {
            draw_choice_list(frame, text_area, options, cursor, columns, choice_locked)
        }
        None => draw_text_windows(
            frame,
            text_area,
            config,
            line,
            reveal,
            indicator_started_at,
            now,
        ),
    }
    draw_status_line(frame, root[1], config, position, total, is_at_end);
}

/// 選択肢のカーソル行に付ける記号。`reveal::PAGE_INDICATOR_SYMBOL` と同じ方針
/// （記号・強調スタイルはハードコードし、Config化しない）。
///
/// 区切りに半角スペース（U+0020）ではなく非改行スペース（NBSP、U+00A0）を使うのは
/// 意図的（#576 バグ修正）。`draw_choice_list` は選択肢テキストを `Paragraph::wrap`
/// （ratatui-widgets の `WordWrapper`）で折り返しており、`WordWrapper::process_input`
/// は「非空白文字→空白文字」の遷移で単語確定＝行フラッシュを行う。半角スペースだと
/// `▶`（非空白）→半角スペース（空白）の並びでこの確定が発火し、`▶` だけが独立した
/// 1行としてフラッシュされ、後続の選択肢本文（空白を含まない1つの巨大word）が次の
/// 物理行に落ちてカーソル記号と本文がずれる。NBSP は Unicode の一般カテゴリでは他の
/// 空白文字と同じく `Zs`（空白）であり `char::is_whitespace` も `true` を返すが、
/// `WordWrapper::process_input` が判定に使う `StyledGrapheme::is_whitespace`
/// （ratatui-core `text/grapheme.rs`）が `symbol != NBSP` で NBSP だけを名指しで
/// 空白扱いから除外する実装上の特例になっているため、単語の区切りとして扱われない。
/// この特例のおかげで `▶`+NBSP+本文が1つの巨大wordとして結合され、通常の長い
/// 選択肢テキストと同じ折り返しフローに合流する。セル幅は半角スペースと同じ1セルなので見た目・レイアウト
/// 計算（[`CHOICE_CURSOR_PADDING`] との幅比較含む）に影響しない。
const CHOICE_CURSOR_SYMBOL: &str = "▶\u{a0}";
/// カーソル記号と同じ表示幅を保つための、非カーソル行の左詰めパディング。
/// [`CHOICE_CURSOR_SYMBOL`]（`▶` 1セル + NBSP 1セル = 計2セル、`CellWidth`/
/// `unicode-width` 基準。`▶` U+25B6 は East Asian Width が Neutral のため半角扱い）
/// と同じ2セル幅になるよう半角スペース2文字にしている。
const CHOICE_CURSOR_PADDING: &str = "  ";

/// 右側テキスト領域全体に選択肢を描画する。相手/自分の2ウィンドウ分割（`draw_text_windows`）
/// は使わない — 選択肢に話者は無いため。カーソル行は反転表示（`Modifier::REVERSED`）+
/// 先頭の [`CHOICE_CURSOR_SYMBOL`] で示す。左側（画像プレースホルダ列）のイベント絵/
/// プレースホルダは選択肢表示中も独立して描画され続けるため、ここでは一切触れない。
///
/// `columns` が `None` または `1` 以下（`Event::Choice.columns` 未指定/不正値、#508）なら
/// 従来どおりの縦一列描画（#482、非破壊）。`2` 以上なら [`draw_choice_grid`] にグリッド
/// 描画を委譲する。
/// 選択肢1件分のカーソル記号と強調スタイルを決める（#508 セルフレビュー: `draw_choice_list`
/// と `draw_choice_grid` で同一ロジックが重複していたため共通化）。
///
/// `locked`（#591、`option.condition` が未定義/false のフラグを指している）なら、選択中か
/// どうかに関わらず `Modifier::DIM` を重ねる — カーソルはロック中の選択肢の上にも普通に
/// 乗れる（`select_current_choice` 側で確定だけを拒否する fail-soft 方針、既存の「無効な
/// jump 先」時の挙動と同じ）ため、選択中の DIM 表示は「ここにいるが選べない」を示す。
fn choice_cursor_prefix_and_style(is_selected: bool, locked: bool) -> (&'static str, Style) {
    let mut style = if is_selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };
    if locked {
        style = style.add_modifier(Modifier::DIM);
    }
    if is_selected {
        (CHOICE_CURSOR_SYMBOL, style)
    } else {
        (CHOICE_CURSOR_PADDING, style)
    }
}

/// ロック中の選択肢テキストに付ける視覚的な目印（#591）。Web版 `ChoiceOverlay`
/// （PixiJS、`fillLocked`/`borderLocked` の別配色）とは表現手段が異なる（TUI は色数が
/// 乏しいため DIM + 記号を併用）が、「flag が未定義/false なら判別可能」という判定結果は
/// 同じにする。
const CHOICE_LOCKED_SUFFIX: &str = " 🔒";

fn draw_choice_list(
    frame: &mut Frame,
    area: Rect,
    options: &[ChoiceOption],
    cursor: usize,
    columns: Option<u32>,
    locked: &[bool],
) {
    let columns = columns.unwrap_or(1).max(1);
    if columns <= 1 {
        let lines: Vec<Line> = options
            .iter()
            .enumerate()
            .map(|(i, option)| {
                let is_locked = locked.get(i).copied().unwrap_or(false);
                let (prefix, style) = choice_cursor_prefix_and_style(i == cursor, is_locked);
                let suffix = if is_locked { CHOICE_LOCKED_SUFFIX } else { "" };
                Line::styled(format!("{prefix}{}{suffix}", option.text), style)
            })
            .collect();
        let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
        render_wrapped_paragraph(frame, area, paragraph);
        return;
    }
    draw_choice_grid(frame, area, options, cursor, columns as usize, locked);
}

/// 選択肢を `columns` 列のグリッドとして描画する（#508、`draw_choice_list` から
/// `columns >= 2` のときのみ呼ばれる）。行方向は `Layout::Vertical`、各行内の列方向は
/// `Layout::Horizontal` をネストして組む — `i % columns` 列目・`i / columns` 行目に配置する
/// GUI版 `novelLayout.ts` の `computeChoiceGridLayout` と同じ規則（行優先で敷き詰める）。
///
/// 縦一列描画（`Wrap` 付き `Paragraph`）と異なり、各セルは折り返し無しの1行表示にする —
/// TUIはセル/グリフ単位の離散描画のため、ボタン状の固定幅グリッドセルに複数行の折り返しを
/// 持ち込むと行の高さ計算（`Constraint::Length(1)`）が崩れる。長いテキストは `Paragraph`
/// の既定動作でそのまま右側が切り詰められる（縦一列描画が `Wrap` するのとは異なる、
/// 固定幅ボタンという性質上の意図的な簡略化）。`Wrap` を使わないため、縦一列描画側が
/// 依存している [`render_wrapped_paragraph`] の極小幅ガード（ratatui の `Wrap` 折り返し
/// panicバグ対策）はここでは不要。
///
/// `area` の高さが総行数に満たない場合は、縦一列描画（`Wrap` 無しでは元々スクロール機構が
/// 存在しない、`choice_list_with_many_options_does_not_panic_when_overflowing_area_height`
/// 参照）と同様にそのまま見切れる — グリッド化に伴う新規の退行ではない。
///
/// `columns` は選択肢数（`total`）を超えないようここでもクランプする（バグ修正、#508）。
/// 呼び出し元（`Playback::playback_item_from_event`）は既に選択肢数へクランプ済みの値しか
/// 積まないはずだが、この関数は `pub(crate)` でテストからも直接呼ばれうるため、実際に
/// ハングを起こす箇所（このすぐ下の `col_areas` の `Vec<Constraint>` 生成 —
/// `columns` 個の要素を持つベクタを ratatui の `Layout::split`＝cassowary線形制約
/// ソルバーに渡す）そのものにも多重にクランプを入れておく。実測: クランプ無しで
/// `columns=2_000_000` を渡すと2分以上応答が返らずSIGKILLが必要だった。`columns >= total`
/// のときクランプしても `rows = total.div_ceil(columns)` は常に `1` のままなので、
/// 見た目（行数・各行の並び）はクランプの有無で変わらない — 純粋に性能上の安全弁。
fn draw_choice_grid(
    frame: &mut Frame,
    area: Rect,
    options: &[ChoiceOption],
    cursor: usize,
    columns: usize,
    locked: &[bool],
) {
    let total = options.len();
    if total == 0 || columns == 0 {
        return;
    }
    let columns = columns.min(total);
    let rows = total.div_ceil(columns);
    let row_areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints(vec![Constraint::Length(1); rows])
        .split(area);

    for row in 0..rows {
        let col_areas = Layout::default()
            .direction(Direction::Horizontal)
            .constraints(vec![Constraint::Ratio(1, columns as u32); columns])
            .split(row_areas[row]);
        for (col, col_area) in col_areas.iter().enumerate() {
            let index = row * columns + col;
            // 総数が列数で割り切れない場合、最終行の余った列には何も描画しない
            // （例: 7要素・3列なら最終行は index 6 の1セルだけ埋まる）。
            let Some(option) = options.get(index) else {
                continue;
            };
            let is_locked = locked.get(index).copied().unwrap_or(false);
            let (prefix, style) = choice_cursor_prefix_and_style(index == cursor, is_locked);
            let suffix = if is_locked { CHOICE_LOCKED_SUFFIX } else { "" };
            let paragraph = Paragraph::new(Line::styled(
                format!("{prefix}{}{suffix}", option.text),
                style,
            ));
            frame.render_widget(paragraph, *col_area);
        }
    }
}

/// 左側: イベント絵（`image` が `Some` のとき、quadrant block グリッドとして描画）、または
/// 従来の画像プレースホルダ（`image` が `None` のとき、罫線なし・中央にラベル文字列/空欄）
/// （#481）。`image` が `None` になるのは、event_image が一度も設定されていないゲーム/
/// シーンを再生している場合（後方互換のフォールバック）。
fn draw_placeholder(frame: &mut Frame, area: Rect, config: &Config, image: Option<&RenderedImage>) {
    if let Some(grid) = image {
        draw_image_grid(frame, area, grid);
        return;
    }

    let label = match config.placeholder.style {
        PlaceholderStyle::Blank => "",
        PlaceholderStyle::Label => config.placeholder.label.as_str(),
    };

    let paragraph = Paragraph::new(label).alignment(Alignment::Center);
    frame.render_widget(paragraph, area);
}

/// 暗転中（`Playback::is_blackout`、#512）に画像プレースホルダの代わりに描く、黒一色の塗り
/// つぶし。`Block` に文字は乗せず背景色のみ黒にする — GUI版 `blackoutOverlay`（`fill(0x000000)`
/// のみで文字を持たない全画面 `Graphics`）と同じ「黒で覆うだけ」の見た目。ラベルや罫線を
/// 出さない（`draw_too_small_message` 等と違い、暗転は演出そのものが目的なので追加の文言は
/// 不要）。
fn draw_blackout(frame: &mut Frame, area: Rect) {
    let block = Block::default().style(Style::default().bg(Color::Black));
    frame.render_widget(block, area);
}

/// quadrant block 変換済みのセル格子（[`RenderedImage`]）を、セルごとに fg/bg 付き `Span` の
/// `Paragraph` として描画する。`grid` の cols/rows は呼び出し側（`draw`）が `area` と同じ
/// 寸法で構築するが、万一のズレ（フレーム間の解像度取りこぼし等）に備え `area` の範囲へ
/// クランプし、範囲外アクセスで panic しないようにする。
fn draw_image_grid(frame: &mut Frame, area: Rect, grid: &RenderedImage) {
    let rows = grid.rows.min(area.height);
    let cols = grid.cols.min(area.width);
    let mut lines = Vec::with_capacity(rows as usize);
    for y in 0..rows {
        let mut spans = Vec::with_capacity(cols as usize);
        for x in 0..cols {
            let idx = y as usize * grid.cols as usize + x as usize;
            if let Some(cell) = grid.cells.get(idx) {
                let fg = Color::Rgb(cell.fg.0, cell.fg.1, cell.fg.2);
                let bg = Color::Rgb(cell.bg.0, cell.bg.1, cell.bg.2);
                spans.push(Span::styled(
                    cell.glyph.to_string(),
                    Style::default().fg(fg).bg(bg),
                ));
            }
        }
        lines.push(Line::from(spans));
    }
    let paragraph = Paragraph::new(Text::from(lines));
    frame.render_widget(paragraph, area);
}

/// スプラッシュ画面: `config.splash.logo_image` が設定されていればフルキャンバス画像表示
/// （[`draw_fullscreen_image`]、#530）、そうでなければ従来どおり `config.splash.lines` の
/// ロゴ行を画面中央に表示するテキストモード（[`draw_splash_text`]）を描く。画像のロードに
/// 失敗した場合（`ImageCache::get_or_load` が `None`）もテキストモードへフォールバックする
/// — `splash.lines` が空でも既存のテキストモードどおり「空行 + 開始ヒント」だけは描く。
/// ロゴの内容（ASCII アート本体・画像ファイル）はゲームごとに異なるため、このエンジン側は
/// 表示方法だけを担い、内容そのものは持たない（`Config::splash` 参照）。
///
/// `scroll_offset` はフルキャンバス画像表示モードでのみ意味を持つ（呼び出し側 `main.rs` の
/// `show_splash` が `Action::MoveUp`/`Action::MoveDown` から配線する）。テキストモードでは
/// 無視される。
pub fn draw_splash(
    frame: &mut Frame,
    config: &Config,
    image_cache: &mut ImageCache,
    scroll_offset: u16,
) {
    if let Some(path) = config.resolve_splash_logo_path() {
        if let Some(decoded) = image_cache.get_or_load(&path) {
            draw_fullscreen_image(frame, &decoded, scroll_offset);
            return;
        }
    }
    draw_splash_text(frame, config);
}

/// スプラッシュ画像モードの最大スクロール量（最下端オフセット）を返す。
/// `show_splash` が target_scroll_offset 自体を入力時にクランプするための補助関数。
/// ロゴ画像が無い／読めない場合はテキストモード相当として 0 を返す。
pub(crate) fn splash_max_scroll_offset(config: &Config, image_cache: &mut ImageCache) -> u16 {
    let Some(path) = config.resolve_splash_logo_path() else {
        return 0;
    };
    let Some(decoded) = image_cache.get_or_load(&path) else {
        return 0;
    };
    let total_rows = compute_full_width_rows(decoded.width, decoded.height, REQUIRED_TOTAL_WIDTH);
    clamp_scroll_offset(u16::MAX, total_rows, REQUIRED_MAIN_CONTENT_ROWS)
}

/// フルキャンバス画像表示（#530）。テキストウィンドウ・スプラッシュの罫線を畳み、画像を
/// アスペクト比を保ったままキャンバス全幅（[`REQUIRED_TOTAL_WIDTH`]）へ contain-fit する
/// （クロップは行わない）。必要総行数は `image_render::compute_full_width_rows` で
/// **全幅前提の式から直接**求め、高さが表示可能行数を超える場合は追加の縮小をせず、
/// `scroll_offset`（呼び出し側が `Action::MoveUp`/`Action::MoveDown` から配線する、
/// `main.rs::show_splash` 参照）に応じて縦方向の可視範囲だけを
/// [`rgba_to_quadrant_grid_window`] で生成して描画する（スクロール）。
///
/// 端末サイズが [`fits_required_size`] を満たさない場合は [`draw_too_small_message`] へ
/// フォールバックする — 固定サイズのキャンバス幅（84列）を前提に contain 計算するため、
/// 通常のゲームUI描画（[`draw`]）と同じ最小サイズ制約を課す。GUI版 dual-window と同じく
/// 罫線・タイトルは描かない（将来イベント絵演出からも呼べる汎用の表示として、装飾を
/// 持たせない）。
fn draw_fullscreen_image(frame: &mut Frame, image: &DecodedImage, scroll_offset: u16) {
    let actual = frame.area();
    if !fits_required_size(actual) {
        draw_too_small_message(frame, actual);
        return;
    }
    let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
    let canvas = compute_centered_canvas(actual, required);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(canvas);
    let image_area = rows[0];
    let hint_area = rows[1];

    let fitted_cols = image_area.width;
    let fitted_rows = compute_full_width_rows(image.width, image.height, fitted_cols);
    if fitted_cols == 0 || fitted_rows == 0 {
        // 画像を描画できない場合でも、テキストモードのフォールバックと対称になるよう
        // 「Enter / Space で開始」ヒントだけは出す。`fits_required_size`チェックを通過して
        // いる以上、固定幅の`REQUIRED_TOTAL_WIDTH`から導かれる`fitted_cols`が実際に0になる
        // ことは現状のコード上ほぼ到達不能（#538）。
        let hint_paragraph = Paragraph::new("Enter / Space で開始")
            .alignment(Alignment::Center)
            .style(Style::default().add_modifier(Modifier::DIM));
        frame.render_widget(hint_paragraph, hint_area);
        return;
    }

    let scrollable = fitted_rows > image_area.height;
    let offset = clamp_scroll_offset(scroll_offset, fitted_rows, image_area.height);
    let visible_rows = image_area.height.min(fitted_rows);
    let visible = rgba_to_quadrant_grid_window(
        &image.rgba,
        image.width,
        image.height,
        fitted_cols,
        fitted_rows,
        offset,
        visible_rows,
    );
    let draw_area = Rect {
        x: image_area.x,
        y: image_area.y,
        width: fitted_cols,
        height: visible.rows,
    };
    draw_image_grid(frame, draw_area, &visible);

    let hint = if scrollable {
        "Enter / Space で開始　↑/↓ でスクロール"
    } else {
        "Enter / Space で開始"
    };
    let hint_paragraph = Paragraph::new(hint)
        .alignment(Alignment::Center)
        .style(Style::default().add_modifier(Modifier::DIM));
    frame.render_widget(hint_paragraph, hint_area);
}

/// スプラッシュ画面（テキストモード）: `config.splash.lines` に設定されたロゴ行を画面中央に
/// 表示する。ロゴの内容はゲームごとに異なるため、このエンジン側は「中央寄せして表示する」
/// という汎用的な描画だけを担い、内容そのものは持たない（`Config::splash` 参照）。
fn draw_splash_text(frame: &mut Frame, config: &Config) {
    let area = frame.area();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(config.game_name.as_str());
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let color = Color::from_str(&config.splash.color).unwrap_or(Color::White);
    let style = Style::default().fg(color);

    let mut lines: Vec<Line> = config
        .splash
        .lines
        .iter()
        .map(|text_line| Line::styled(text_line.clone(), style))
        .collect();
    lines.push(Line::raw(""));
    lines.push(Line::styled(
        "Enter / Space で開始",
        Style::default().add_modifier(Modifier::DIM),
    ));

    // 縦方向中央寄せ: ratatui の Paragraph は縦方向の中央寄せを持たないため、
    // ロゴ全体の高さから上マージンを計算して描画領域をずらす。
    let content_height = lines.len() as u16;
    let top_margin = inner.height.saturating_sub(content_height) / 2;
    let centered = Rect {
        x: inner.x,
        y: inner.y.saturating_add(top_margin),
        width: inner.width,
        height: inner.height.saturating_sub(top_margin),
    };

    let paragraph = Paragraph::new(Text::from(lines)).alignment(Alignment::Center);
    frame.render_widget(paragraph, centered);
}

/// 1文字のセル幅（半角=1、全角=2 等）を、`ratatui`（`unicode-width` を推移的依存に持つ）の
/// `CellWidth` トレイトを使って判定する。以前はここに Unicode East Asian Width の代表的な
/// レンジだけをカバーする独自の簡易テーブル（[`is_wide_char`] 相当）を持っていたが、
/// このファイルは既に他の箇所（[`buffer_text_wide_aware`] 等）で `CellWidth`/`cell_width()`
/// を使っており、新規依存を増やさずに同じ判定ロジックへ統一できる。独自テーブルは
/// カバー範囲が限定的で、[`MIN_SAFE_TEXT_WRAP_WIDTH`] まわりの既知バグ（幅判定の
/// ミスマッチに由来）と根が同じ不整合リスクを持っていた（セルフレビュー should対応）。
/// `CellWidth` は `str` 向けのトレイトのため、1文字をスタック上の小さいバッファへ
/// UTF-8エンコードしてから呼ぶ。
fn char_width(c: char) -> u16 {
    let mut buf = [0u8; 4];
    c.encode_utf8(&mut buf).cell_width()
}

/// 1行のテキストを `max_width` セル幅で文字単位に折り返す（単語境界は考慮しない —
/// 日本語主体のダイアログには分かち書きが無いため、GUI版のCSS `word-break: break-all` 相当の
/// 動きの方が実態に近い、#500）。
///
/// バックログ画面（[`draw_backlog`]）はこの結果の行数をそのままスクロール量のクランプに
/// 使うため、ratatui の `Paragraph::wrap`（内部の折り返しアルゴリズムが端末幅に応じて
/// 実行時にしか行数が定まらず、`unstable-rendered-line-info` feature 無しでは事前に
/// 行数を取得できない）には頼らず、ここで折り返し済みの行を直接組み立てる。
///
/// `max_width == 0` は無限ループを避けるため、1文字ずつ個別の行にする。
fn wrap_line(text: &str, max_width: u16) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    if max_width == 0 {
        return text.chars().map(|c| c.to_string()).collect();
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_width: u16 = 0;
    for c in text.chars() {
        let w = char_width(c);
        if current_width + w > max_width && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            current_width = 0;
        }
        current.push(c);
        current_width += w;
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// バックログの全エントリを、話者名（あれば太字+話者色）+ 本文（各行 [`wrap_line`] で
/// `max_width` セルへ折り返し済み）+ エントリ間の空行区切り、という単一の `Line` 列に変換する
/// （#500）。エントリが1件も無いときは「まだ何も無い」ことを示す1行だけを返す。
fn wrap_backlog_lines(
    config: &Config,
    entries: &[DisplayLine],
    max_width: u16,
) -> Vec<Line<'static>> {
    if entries.is_empty() {
        return vec![Line::styled(
            "(まだ表示された会話がありません)",
            Style::default().add_modifier(Modifier::DIM),
        )];
    }
    let mut lines = Vec::new();
    for entry in entries {
        let color_name = config.color_name_for(entry.speaker.as_deref());
        let color = Color::from_str(color_name).unwrap_or(Color::White);
        if let Some(speaker) = &entry.speaker {
            for wrapped in wrap_line(speaker, max_width) {
                lines.push(Line::styled(
                    wrapped,
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                ));
            }
        }
        for text_line in &entry.text {
            for wrapped in wrap_line(text_line, max_width) {
                lines.push(Line::styled(wrapped, Style::default().fg(color)));
            }
        }
        lines.push(Line::raw(""));
    }
    lines
}

/// バックログ（既読ログ）画面: これまで表示し終えた会話行を話者名込みで一覧表示し、
/// スクロールで遡って読める（#500、GUI版 `frontend/src/game/BacklogOverlay.ts` 相当）。
/// 閲覧専用 — この画面を描画している間、`event_loop` は会話の進行（オート/スキップモードの
/// タイマー・reveal のタイプライター時間経過を含む）を完全に凍結する
/// （`main.rs::Overlay::Backlog` 分岐参照）。
///
/// `entries` は表示済みの会話行の履歴（時系列順、最新が末尾）。`scroll` は呼び出し側が
/// 保持する生のスクロール位置（折り返し後の行数単位）。実際のコンテンツ量より大きい値
/// （`main.rs` はバックログを開いた直後に `u16::MAX` を渡す）を渡すと「末尾（最新）に
/// クランプ」される。戻り値はこのフレームで実際に使われた（クランプ後の）スクロール位置 —
/// 呼び出し側はこれを次フレームの `scroll` として保存し直す（`reveal::indicator_blink_started_at`
/// 等、既存の「関数が計算した値を呼び出し側のループ変数へ書き戻す」パターンを踏襲する）。
pub fn draw_backlog(
    frame: &mut Frame,
    config: &Config,
    entries: &[DisplayLine],
    scroll: u16,
) -> u16 {
    let actual = frame.area();
    if !fits_required_size(actual) {
        draw_too_small_message(frame, actual);
        return scroll;
    }
    let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
    let canvas = compute_centered_canvas(actual, required);

    let block = Block::default().borders(Borders::ALL).title("BACKLOG");
    let inner = block.inner(canvas);
    frame.render_widget(block, canvas);

    if inner.width == 0 || inner.height == 0 {
        return scroll;
    }

    let sections = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(inner);
    let content_area = sections[0];
    let footer_area = sections[1];

    let lines = wrap_backlog_lines(config, entries, content_area.width);
    let total_lines = lines.len() as u16;
    let max_scroll = total_lines.saturating_sub(content_area.height);
    let clamped = scroll.min(max_scroll);

    let paragraph = Paragraph::new(Text::from(lines)).scroll((clamped, 0));
    render_wrapped_paragraph(frame, content_area, paragraph);

    let footer = Paragraph::new(Line::styled(
        "↑↓ スクロール / Enter・B・Esc で閉じる",
        Style::default().add_modifier(Modifier::DIM),
    ))
    .alignment(Alignment::Center);
    frame.render_widget(footer, footer_area);

    clamped
}

/// テキスト速度の表示ラベル。GUI版 `SettingsOverlay.tsx` の msPerChar スライダーの
/// `format` 関数と同じ区分・文言をそのまま踏襲する（#503）。
fn format_speed_label(ms: u64) -> String {
    if ms == 0 {
        "瞬間表示".to_string()
    } else if ms <= 15 {
        format!("速い ({ms}ms)")
    } else if ms >= 60 {
        format!("遅い ({ms}ms)")
    } else {
        format!("{ms}ms/字")
    }
}

/// 設定画面（#503）でフォーカス中の行。`Action::MoveLeft`/`Action::MoveRight` の文脈依存の
/// 再利用（`main.rs::event_loop` の `Overlay::Settings` 分岐）でラップアラウンドしながら
/// 切り替わる。フォーカス行に応じて `Action::MoveUp`/`Action::MoveDown` が調整する値
/// （テキスト速度 or 音量）が変わる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingsField {
    #[default]
    TextSpeed,
    BgmVolume,
    SeVolume,
    VoiceVolume,
}

impl SettingsField {
    /// 次の行へラップアラウンドしながら進む（`Action::MoveRight`）。
    pub fn next(self) -> Self {
        match self {
            SettingsField::TextSpeed => SettingsField::BgmVolume,
            SettingsField::BgmVolume => SettingsField::SeVolume,
            SettingsField::SeVolume => SettingsField::VoiceVolume,
            SettingsField::VoiceVolume => SettingsField::TextSpeed,
        }
    }

    /// 前の行へラップアラウンドしながら戻る（`Action::MoveLeft`）。
    pub fn prev(self) -> Self {
        match self {
            SettingsField::TextSpeed => SettingsField::VoiceVolume,
            SettingsField::BgmVolume => SettingsField::TextSpeed,
            SettingsField::SeVolume => SettingsField::BgmVolume,
            SettingsField::VoiceVolume => SettingsField::SeVolume,
        }
    }
}

/// フォーカス中の行の先頭に付ける印。`format_settings_line` が使う（#503）。
const FOCUS_MARKER: &str = "> ";
const NO_FOCUS_MARKER: &str = "  ";

/// 設定画面の1行を組み立てる。`focused` なら [`FOCUS_MARKER`] を付けて `Modifier::BOLD` で
/// 強調し、それ以外は [`NO_FOCUS_MARKER`] で幅を揃えるだけにする（#503）。
fn format_settings_line(text: String, focused: bool) -> Line<'static> {
    let marker = if focused {
        FOCUS_MARKER
    } else {
        NO_FOCUS_MARKER
    };
    let style = if focused {
        Style::default().add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    Line::styled(format!("{marker}{text}"), style)
}

/// テキスト速度・BGM/SE/ボイス音量設定画面（#503、GUI版 `frontend/src/game/settings.ts`/
/// `SettingsOverlay.tsx` 相当）。
///
/// 閲覧専用の [`draw_backlog`] と異なり、この画面は `Action::MoveLeft`/`Action::MoveRight`
/// で [`SettingsField`]（フォーカス行）を切り替え、`Action::MoveUp`/`Action::MoveDown`
/// （選択肢カーソル移動の文脈依存の再利用と同じ設計）でフォーカス中の値を書き換える —
/// 実際の値変更は呼び出し側 `main.rs` の `Overlay::Settings` 分岐が行い、この関数は
/// 現在値・現在のフォーカスを表示するだけ。
///
/// BGM/SE音量は実際に音声バックエンドへ反映されるが、ボイス音量は値を保持するだけの
/// 「(将来用)」の受け皿——`config::VolumeConfig` のdoc comment参照。ラベルにもその旨を
/// 明記し、GUI版 `SettingsOverlay.tsx` の「ボイス音量 (将来用)」表記と揃える。
pub fn draw_settings(
    frame: &mut Frame,
    char_interval_ms: u64,
    volume: &VolumeConfig,
    focus: SettingsField,
) {
    let actual = frame.area();
    if !fits_required_size(actual) {
        draw_too_small_message(frame, actual);
        return;
    }
    let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
    let canvas = compute_centered_canvas(actual, required);

    let block = Block::default().borders(Borders::ALL).title("設定");
    let inner = block.inner(canvas);
    frame.render_widget(block, canvas);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let speed_label = format_speed_label(char_interval_ms);
    // フォーカス中の項目に応じて調整可能なレンジ・刻み幅をヒントに出す（#537）。全項目分を
    // 常時表示すると横幅・視認性の両方で冗長になるため、フォーカス行1つぶんだけに絞る。
    let range_hint = match focus {
        SettingsField::TextSpeed => {
            format!("(0〜{TEXT_SPEED_MAX_MS}ms, {TEXT_SPEED_STEP_MS}ms刻み)")
        }
        SettingsField::BgmVolume | SettingsField::SeVolume | SettingsField::VoiceVolume => {
            format!("(0〜{VOLUME_MAX_PERCENT}%, {VOLUME_STEP_PERCENT}%刻み)")
        }
    };
    let lines = vec![
        Line::raw(""),
        format_settings_line(
            format!("テキスト表示速度: {speed_label}"),
            focus == SettingsField::TextSpeed,
        ),
        format_settings_line(
            format!("BGM音量: {}%", volume.bgm_percent),
            focus == SettingsField::BgmVolume,
        ),
        format_settings_line(
            format!("SE音量: {}%", volume.se_percent),
            focus == SettingsField::SeVolume,
        ),
        format_settings_line(
            format!("ボイス音量 (将来用): {}%", volume.voice_percent),
            focus == SettingsField::VoiceVolume,
        ),
        Line::raw(""),
        Line::styled(
            format!("←→ 項目切替 / ↑↓ 調整 {range_hint} / Enter・C・Esc で閉じる"),
            Style::default().add_modifier(Modifier::DIM),
        ),
    ];

    // 縦方向中央寄せ（`draw_splash` と同じ手法）。
    let content_height = lines.len() as u16;
    let top_margin = inner.height.saturating_sub(content_height) / 2;
    let centered = Rect {
        x: inner.x,
        y: inner.y.saturating_add(top_margin),
        width: inner.width,
        height: inner.height.saturating_sub(top_margin),
    };

    let paragraph = Paragraph::new(Text::from(lines)).alignment(Alignment::Center);
    render_wrapped_paragraph(frame, centered, paragraph);
}

/// 右側をさらに上（相手）/下（自分）に分割し、現在の会話行の話者側のウィンドウにだけ
/// 本文を描画する（GUI版 `splitTextRegionForDualWindow`: 相手=上/自分=下、#480）。分割は
/// `Constraint::Length` で明示的に高さを計算し、opponent=`height / 2`（切り捨て）・
/// self=`height - opponent`（切り捨て分の端数を含む）とする — `Constraint::Percentage`
/// のペアだと ratatui は前者を切り上げ・後者を切り捨てるため、そのまま使うと self が
/// opponent より恒常的に1行少なくなる片側固定バイアスが生じる（セルフレビューで発見・修正）。
/// 話者が `config.player_speakers` に含まれる場合のみ「自分」（下窓）、それ以外（Narration の
/// 話者不明を含む — GUI版 `resolveDualWindowIsSelf` が話者不明を相手側に倒すのと同じ規則）は
/// 「相手」（上窓）に描く。話者側でない方の窓は空のまま（前回発言のログ表示はスコープ外）。
///
/// 本文は `reveal`（[`reveal::RevealState`]）が与えられていれば `RevealState::body_lines` から
/// 組み立て（`Animating` はタイプライター表示のスナップショット、`Done` はスキップ済みの全文）、
/// 表示すべきか自体は [`reveal::should_show_page_indicator`]（`main.rs` の `event_loop` と共有
/// する可視条件、#495 追加修正2）で判定し、表示すべきときは [`reveal::blink_visible`] による
/// 1秒周期の完全on/off点滅でページ送りインジケータをウィンドウ右下の固定位置に描画する
/// （[`draw_page_indicator`] 参照、#487/#495）。
/// インジケータの色は「そのウィンドウが自分側(self)か相手側(opponent)か」に応じて
/// `config.colors.player`/`config.colors.opponent` をそのまま使う（本文色と同じ配色設定を
/// 再利用し、専用の色設定は増やさない — GUI版 `DialogBox.ts` の
/// `DUAL_WINDOW_SELF_INDICATOR_COLOR`/`DUAL_WINDOW_OPPONENT_INDICATOR_COLOR` と同じ役割分担）。
/// `reveal` が `None`（会話行そのものが無い等）の場合は従来どおりの静的表示にフォールバックする。
fn draw_text_windows(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    line: Option<&DisplayLine>,
    reveal: Option<&reveal::RevealState>,
    indicator_started_at: Instant,
    now: Instant,
) {
    let opponent_height = area.height / 2; // 切り捨て
    let self_height = area.height - opponent_height; // 余りは self が受け取る（floor+余り=ceil相当）
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(opponent_height),
            Constraint::Length(self_height),
        ])
        .split(area);
    let opponent_area = rows[0];
    let self_area = rows[1];

    let Some(line) = line else {
        let paragraph = Paragraph::new("(会話行がありません)").wrap(Wrap { trim: false });
        render_wrapped_paragraph(frame, opponent_area, paragraph);
        return;
    };

    let is_self_speaker = line
        .speaker
        .as_deref()
        .is_some_and(|speaker| config.is_player_speaker(speaker));
    let target_area = if is_self_speaker {
        self_area
    } else {
        opponent_area
    };

    let color_name = config.color_name_for(line.speaker.as_deref());
    let color = Color::from_str(color_name).unwrap_or(Color::White);
    let style = Style::default().fg(color);

    let mut rendered = Vec::new();
    match reveal {
        Some(state) => {
            rendered.extend(state.body_lines(now));
        }
        None => {
            for text_line in &line.text {
                rendered.push(Line::styled(text_line.clone(), style));
            }
        }
    }
    // 可視条件（choice無し・line有り・reveal完了）は `reveal::should_show_page_indicator` に
    // 集約済み（#495 should対応）。`draw_text_windows` はここに来る時点で choice=Noneが
    // 呼び出し元（`draw`）の分岐で保証済み、line も早期returnで保証済みのため、それぞれ
    // `false`/`true` を渡す。
    let show_page_indicator = reveal::should_show_page_indicator(false, true, reveal, now);

    let paragraph = Paragraph::new(Text::from(rendered)).wrap(Wrap { trim: false });
    render_wrapped_paragraph(frame, target_area, paragraph);

    if show_page_indicator {
        // 本文色（`color_name_for`、ナレーションでは3色目の gray もありうる）とは別に、
        // インジケータは常に「自分側/相手側」の2択（GUI版 `DUAL_WINDOW_SELF_INDICATOR_COLOR`/
        // `DUAL_WINDOW_OPPONENT_INDICATOR_COLOR` と同じ役割分担）。既存の `ColorConfig` の
        // `player`/`opponent` フィールドをそのまま使い、新しい色設定は増やさない（#495）。
        let indicator_color_name = if is_self_speaker {
            config.colors.player.as_str()
        } else {
            config.colors.opponent.as_str()
        };
        let indicator_color = Color::from_str(indicator_color_name).unwrap_or(Color::White);
        draw_page_indicator(
            frame,
            target_area,
            indicator_color,
            indicator_started_at,
            now,
        );
    }
}

/// wrap 付き `Paragraph` を描画する際、危険な極小幅を避けるための下限セル数。
/// ratatui 0.30.2 / ratatui-widgets 0.3.2 は、半角/全角混在の文字列を `Wrap` 付き
/// `Paragraph` で描画する幅がちょうど2セルのとき、内部の折り返し計算がバッファ範囲外に
/// 書き込みpanicすることがある（`ratatui_widgets::paragraph::render_line` →
/// `Buffer::index_mut`）。実測では幅2セル・高さ2以上で複数の入力文字列
/// （例: フォールバック文言「(会話行がありません)」）について再現し、幅1セルおよび幅3セル
/// 以上では再現しなかった。依存クレート側の折り返し計算バグのためこちら側では直接修正
/// できず、危険な幅ではwrap描画そのものをスキップする防御的ガードとする。
const MIN_SAFE_TEXT_WRAP_WIDTH: u16 = 3;

/// [`MIN_SAFE_TEXT_WRAP_WIDTH`] 未満の極小幅では、ratatui内部のpanicを避けるため
/// `Paragraph` の描画自体をスキップする（何も描かない）。それ以外は通常どおり描画する。
fn render_wrapped_paragraph(frame: &mut Frame, area: Rect, paragraph: Paragraph<'_>) {
    if area.width < MIN_SAFE_TEXT_WRAP_WIDTH {
        return;
    }
    frame.render_widget(paragraph, area);
}

/// 画面最下段1行: ゲーム名 + 会話位置/総数（+ 終端マーカー）。枠の title として表示していた
/// 情報を、枠なし化後もユーザーが状況を把握できるよう右寄せの単なる1行テキストとして残す
/// （罫線・背景等の装飾は付けない）。
fn draw_status_line(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    position: usize,
    total: usize,
    is_at_end: bool,
) {
    let status = if is_at_end {
        format!("{} — {position}/{total} (END)", config.game_name)
    } else {
        format!("{} — {position}/{total}", config.game_name)
    };
    let paragraph = Paragraph::new(status)
        .style(Style::default().add_modifier(Modifier::DIM))
        .alignment(Alignment::Right);
    frame.render_widget(paragraph, area);
}

/// ページ送りインジケータ（▼）をウィンドウ右下から固定するセル数
/// （GUI版 `frontend/src/game/DialogBox.ts:1323-1329` の adv 右下固定
/// `boxX + boxW - 40`, `boxY + boxH - 45` を踏襲、#487）。GUI側はpx単位だが、TUI側は
/// セル単位の座標系のためpxをそのまま換算せず、右端/下端から数セル内側という見た目の
/// 意図だけを移植する。`PAGE_INDICATOR_INSET_COLS` は「右からNセル目」の意味で、
/// N=3なら右端の2セルぶんは常に空けたまま（角にめり込ませない）。
const PAGE_INDICATOR_INSET_COLS: u16 = 3;
/// [`PAGE_INDICATOR_INSET_COLS`] の下端版。N=2なら下端の1セルぶんは常に空ける。
const PAGE_INDICATOR_INSET_ROWS: u16 = 2;

/// [`PAGE_INDICATOR_INSET_COLS`]/[`PAGE_INDICATOR_INSET_ROWS`] を使って、`area`（opponent_area/
/// self_area いずれかのウィンドウ矩形）内の右下固定インジケータ位置（幅・高さ1セル）を返す
/// 純粋関数（レンダラ非依存、テストで直接検証できるよう `draw_page_indicator` から分離）。
/// `area` の幅/高さがオフセット未満の極小ウィンドウでは `saturating_sub` で `area` の左上角
/// （x=area.x/y=area.y）側へクランプし、`area` の外へはみ出さないようにする。
fn page_indicator_area(area: Rect) -> Rect {
    let x = area.x + area.width.saturating_sub(PAGE_INDICATOR_INSET_COLS);
    let y = area.y + area.height.saturating_sub(PAGE_INDICATOR_INSET_ROWS);
    Rect {
        x,
        y,
        width: 1,
        height: 1,
    }
}

/// reveal 完了後の入力待ちを示すページ送りインジケータ（既定では ▼）を、`area`（発言側の
/// ウィンドウ、opponent_area/self_area いずれか）の右下固定位置（[`page_indicator_area`]）に
/// 描画する。#487 より前は本文最終行の末尾に文末追従で付けていたが、GUI版のadv固定仕様
/// （`DialogBox.ts` 参照）に合わせてウィンドウ右下固定へ変更した — gymnasiaの `dialog_style`
/// は常にadvのため、TUI側もdialog_style分岐を作らずadv右下固定のみを実装する。
/// 表示中（未 reveal）にはこの関数を呼ばない — 呼び出し側（`draw_text_windows`）が
/// `state.is_done(now)` で既にガードしている。`area` の幅が [`MIN_SAFE_TEXT_WRAP_WIDTH`]
/// 未満、または高さが0の極小ウィンドウでは何もしない — 幅ガードは
/// [`render_wrapped_paragraph`] が本文パラグラフの描画をスキップする閾値と揃えたもので、
/// これが無いと「本文は消えるがインジケータだけ浮く」表示不整合が起きる（セルフレビュー
/// 指摘、#487）。
///
/// `color` は呼び出し側（`draw_text_windows`）がウィンドウの自分側/相手側に応じて既に決定
/// 済みの固定色（表示されている間ずっと同じ色 — `jiwa::PulseHandle` の連続色補間は使わない、
/// #495）。`blink_started_at`/`now` は [`reveal::blink_visible`] にそのまま渡し、非表示区間
/// （1秒周期の奇数区間）ではグリフの描画自体をスキップする（GUI版 `DialogBox.ts` の
/// `this.indicatorGlyph.visible = this.indicatorBlinkOn` と同じ完全on/off切り替え）。
fn draw_page_indicator(
    frame: &mut Frame,
    area: Rect,
    color: Color,
    blink_started_at: Instant,
    now: Instant,
) {
    if area.width < MIN_SAFE_TEXT_WRAP_WIDTH || area.height == 0 {
        return;
    }
    if !reveal::blink_visible(
        blink_started_at,
        now,
        reveal::PAGE_INDICATOR_BLINK_PERIOD_MS,
    ) {
        return;
    }
    let span = Span::styled(reveal::PAGE_INDICATOR_SYMBOL, Style::default().fg(color));
    let paragraph = Paragraph::new(Line::from(span));
    frame.render_widget(paragraph, page_indicator_area(area));
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::Terminal;

    /// レンダリング済みバッファを行ごとのテキストに変換する。
    /// 全角文字（幅2セル）の次のセルは、直前のグラフェムを表示するために予約された
    /// 空セルであり内容を持たないため、`cell_width()` を見て読み飛ばす
    /// （そのまま連結すると「[画像]」が「[画 像 ]」のように空白混じりになってしまう）。
    fn buffer_text(buffer: &Buffer) -> String {
        let area = buffer.area();
        let mut out = String::new();
        for y in 0..area.height {
            let mut x = 0u16;
            while x < area.width {
                let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                out.push_str(symbol);
                x += symbol.cell_width().max(1);
            }
        }
        out
    }

    /// `w`x`h` px の単色 RGBA バイト列を作る（テストフィクスチャ用）。
    fn solid_rgba(color: (u8, u8, u8), w: u32, h: u32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            buf.extend_from_slice(&[color.0, color.1, color.2, 255]);
        }
        buf
    }

    /// `cols`x`rows`セル全域が確実に非空白グリフ('▞', fg=白/bg=黒)になるRGBA画像を
    /// WebPフィクスチャとして書き出す。各セル分の2x2サブピクセルが黒/白の対角パターン
    /// （UL/LR=黒, UR/LL=白）を繰り返す構成で、`image_render::quadrant_cell_from_subpixels`
    /// のテスト（`quadrant_cell_full_block_when_all_subpixels_are_maximally_different`）と
    /// 同じ入力パターンになるようにしている。
    fn diagonal_pattern_webp_fixture(cols: u16, rows: u16) -> std::path::PathBuf {
        let sub_w = cols as u32 * 2;
        let sub_h = rows as u32 * 2;
        // #489: rgba_to_quadrant_grid は cover-fit + ターミナルセルのアスペクト比補正
        // （TERMINAL_CELL_ASPECT_RATIO）で元画像を先にクロップしてからダウンサンプルする
        // ようになった。このフィクスチャはクロップが一切発生しないよう、実効ターゲット比
        // （sub_w : sub_h/TERMINAL_CELL_ASPECT_RATIO）と同じアスペクト比の画像を作る —
        // 各行を `1/TERMINAL_CELL_ASPECT_RATIO` 回だけ縦に複製して高さを増やす
        // （複製した行どうしは同色なので、ボックス平均で潰しても純色のまま保たれ、
        // このテストが検証したい「各セルが厳密に単色2色の対角パターンになる」性質は崩れない）。
        let row_repeat = (1.0 / crate::image_render::TERMINAL_CELL_ASPECT_RATIO).round() as u32;
        let img_h = sub_h * row_repeat;
        let mut rgba = Vec::with_capacity((sub_w * img_h * 4) as usize);
        for y in 0..sub_h {
            let mut row = Vec::with_capacity((sub_w * 4) as usize);
            for x in 0..sub_w {
                let is_black = (x % 2) == (y % 2);
                let px = if is_black {
                    [0u8, 0, 0, 255]
                } else {
                    [255u8, 255, 255, 255]
                };
                row.extend_from_slice(&px);
            }
            for _ in 0..row_repeat {
                rgba.extend_from_slice(&row);
            }
        }
        crate::image_render::write_test_webp_fixture(&rgba, sub_w, img_h)
    }

    /// `image_fade` テスト用に `Config::event_image.assets_dir` をフィクスチャの置き場所へ
    /// 向け、`DisplayLine::event_image` と同じ形（ファイル名のみ）の相対パスを返す。
    fn config_and_relative_path_for(fixture_path: &std::path::Path) -> (Config, String) {
        let mut config = Config::default();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (config, relative)
    }

    // ---- #481 follow-up: draw() に Some(&ImageFadeState) を渡す統合テスト ----
    //
    // 既存テストは全て image_fade=None で呼んでおり、draw_image_grid が実際に呼ばれる
    // 経路（左カラムに quadrant block 文字が描かれる）は自動テストで一度も検証されて
    // いなかった（image_fade.rs/image_render.rs の純粋関数テストのみ）。以下はその穴を
    // 埋める、実在パスを resolve した `Some(&ImageFadeState)` 経由の統合テスト。

    #[test]
    fn draw_with_resolved_image_fade_renders_quadrant_glyphs_not_placeholder() {
        // placeholder_area は #494 以降、常に固定キャンバス(CANVAS_W x CANVAS_H)に対して
        // `split_columns` が実際に計算する幅になる。手計算した固定値をテストに直書きせず、
        // 本番コードと同じ `split_columns` を呼んで期待値を得る。
        let (placeholder_area, _gap, _text) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        let fixture_path =
            diagonal_pattern_webp_fixture(placeholder_area.width, placeholder_area.height);
        let (mut config, relative) = config_and_relative_path_for(&fixture_path);
        config.placeholder.label = "[画像]".to_string();
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );

        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // フィクスチャは全セルが対角パターンの '▞'（fg=白、bg=黒）になるよう作られている。
        for y in 0..placeholder_area.height {
            for x in 0..placeholder_area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_eq!(
                    cell.symbol(),
                    "▞",
                    "cell ({x},{y}) should carry the quadrant glyph, not a placeholder blank"
                );
                assert_eq!(cell.fg, Color::Rgb(255, 255, 255));
                assert_eq!(cell.bg, Color::Rgb(0, 0, 0));
            }
        }
        let text = buffer_text(buffer);
        assert!(
            !text.contains("[画像]"),
            "should not fall back to the placeholder label, buffer was: {text}"
        );
    }

    #[test]
    fn draw_with_resolved_image_fade_at_extremely_small_placeholder_area_does_not_panic() {
        // #494以降、これらの極小サイズは fits_required_size を満たさず
        // draw_too_small_message 側の分岐に入るため image_fade は実際には参照されないが、
        // 「resolved image_fade を渡した状態でどれだけ小さい端末でも draw() が panic しない」
        // という回帰ガードとしての価値はそのまま残る。
        let fixture_path = diagonal_pattern_webp_fixture(1, 1);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );

        for (w, h) in [(1u16, 1u16), (2, 1), (1, 2), (2, 2), (1, 3)] {
            let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
            let now = Instant::now();
            let mut image_cache = ImageCache::new();
            terminal
                .draw(|f| {
                    draw(
                        f,
                        &config,
                        None,
                        None,
                        &[],
                        0,
                        0,
                        true,
                        None,
                        now,
                        now,
                        Some(&image_fade),
                        &mut image_cache,
                        false,
                    )
                })
                .unwrap();
        }
    }

    #[test]
    fn draw_with_one_pixel_source_image_upsampled_to_larger_grid_gives_every_cell_that_color() {
        let color = (123u8, 45u8, 67u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 1, 1), 1, 1);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );

        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // placeholder_area は #494 以降、常に固定キャンバス(CANVAS_W x CANVAS_H)に対して
        // `split_columns` が計算する幅になる。手計算した固定値を直書きせず、本番コードと
        // 同じ `split_columns` を呼んで期待値を得る。1x1画像相当のRGBAデータを大きいグリッド
        // へ展開しても、範囲外アクセスでpanicしたり色が壊れたりせず、全セルが唯一のソース
        // 画素の色をそのまま持つことを確認する。
        let (placeholder_area, _gap, _text) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        for y in 0..placeholder_area.height {
            for x in 0..placeholder_area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_eq!(
                    cell.bg,
                    Color::Rgb(color.0, color.1, color.2),
                    "cell ({x},{y}) should carry the single source pixel's color"
                );
            }
        }
    }

    // ---- #512: draw() の blackout パラメータ（画像プレースホルダの黒塗り） ----

    /// `render()`（既存ヘルパー、blackout は常に false 固定）の blackout 可変版。
    /// blackout の有無によるテキスト側/画像側の描画差分を比較する目的で使う。
    fn render_with_blackout(
        config: &Config,
        line: Option<&DisplayLine>,
        blackout: bool,
        width: u16,
        height: u16,
    ) -> Buffer {
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    config,
                    line,
                    None,
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    blackout,
                )
            })
            .unwrap();
        terminal.backend().buffer().clone()
    }

    #[test]
    fn draw_blackout_true_fills_placeholder_area_with_black_only() {
        let config = Config::default();
        let (placeholder_area, _gap, _text) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        let buffer = render_with_blackout(&config, None, true, CANVAS_W, CANVAS_H);
        for y in 0..placeholder_area.height {
            for x in 0..placeholder_area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_eq!(
                    cell.bg,
                    Color::Black,
                    "cell ({x},{y}) should be filled black while blackout is active"
                );
            }
        }
    }

    #[test]
    fn draw_blackout_true_does_not_alter_text_area_cells() {
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["暗転中でも読めるはずの台詞".to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let normal = render_with_blackout(&config, Some(&line), false, CANVAS_W, CANVAS_H);
        let blacked = render_with_blackout(&config, Some(&line), true, CANVAS_W, CANVAS_H);

        let (_placeholder, _gap, text_area) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        for y in text_area.y..(text_area.y + text_area.height) {
            for x in text_area.x..(text_area.x + text_area.width) {
                let normal_cell = normal.cell((x, y)).expect("in bounds");
                let blacked_cell = blacked.cell((x, y)).expect("in bounds");
                assert_eq!(
                    normal_cell.symbol(),
                    blacked_cell.symbol(),
                    "cell ({x},{y}) text content should be unaffected by blackout"
                );
                assert_eq!(
                    normal_cell.fg, blacked_cell.fg,
                    "cell ({x},{y}) fg should be unaffected by blackout"
                );
                assert_eq!(
                    normal_cell.bg, blacked_cell.bg,
                    "cell ({x},{y}) bg should be unaffected by blackout"
                );
            }
        }
    }

    #[test]
    fn draw_blackout_true_with_choice_renders_both_black_placeholder_and_choice_list() {
        let config = Config::default();
        let options = vec![choice_option("はい", "a"), choice_option("いいえ", "b")];
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 0, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    true,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();

        let (placeholder_area, _gap, _text) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        for y in 0..placeholder_area.height {
            for x in 0..placeholder_area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_eq!(
                    cell.bg,
                    Color::Black,
                    "cell ({x},{y}) should stay black even while a choice list is showing"
                );
            }
        }
        let text = buffer_text(buffer);
        assert!(text.contains("はい"), "buffer was: {text}");
        assert!(text.contains("いいえ"), "buffer was: {text}");
    }

    #[test]
    fn draw_blackout_suppresses_image_fade_rendering_even_when_resolved() {
        let (placeholder_area, _gap, _text) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        let fixture_path =
            diagonal_pattern_webp_fixture(placeholder_area.width, placeholder_area.height);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );

        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    true,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for y in 0..placeholder_area.height {
            for x in 0..placeholder_area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_ne!(
                    cell.symbol(),
                    "▞",
                    "cell ({x},{y}) should not show the resolved event image glyph while blackout is active"
                );
                assert_eq!(
                    cell.bg,
                    Color::Black,
                    "cell ({x},{y}) should be black instead of the resolved event image"
                );
            }
        }
    }

    #[test]
    fn draw_blackout_false_after_true_restores_placeholder_or_image() {
        let mut config = Config::default();
        config.placeholder.style = PlaceholderStyle::Label;
        config.placeholder.label = "[画像]".to_string();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();

        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    true,
                )
            })
            .unwrap();
        let blacked_text = buffer_text(terminal.backend().buffer());
        assert!(
            !blacked_text.contains("[画像]"),
            "buffer was: {blacked_text}"
        );

        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let restored_text = buffer_text(terminal.backend().buffer());
        assert!(
            restored_text.contains("[画像]"),
            "blackout=false に戻ったら通常のプレースホルダに復帰するはず, buffer was: {restored_text}"
        );

        // 黒塗りが残っていないかは、全角グリフの継続セル（`buffer_text` のコメント参照:
        // 直前のグラフェムを表示するために予約された空セルで、どのウィジェットからも
        // 書き込まれない）を除いて判定する。継続セルは Paragraph が「[画像]」ラベルを
        // 描画する際に一切タッチしないため、before/after のどちらのフレームでも触られず
        // 前フレームの値をそのまま持ち越す ratatui 側の既知の挙動であり、暗転解除の
        // 検証対象ではない。
        let (placeholder_area, _gap, _text) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        let buffer = terminal.backend().buffer();
        let mut has_black_cell = false;
        for y in placeholder_area.y..(placeholder_area.y + placeholder_area.height) {
            let mut x = placeholder_area.x;
            let x_end = placeholder_area.x + placeholder_area.width;
            while x < x_end {
                let cell = buffer.cell((x, y)).expect("in bounds");
                if cell.bg == Color::Black {
                    has_black_cell = true;
                }
                x += cell.symbol().cell_width().max(1);
            }
        }
        assert!(
            !has_black_cell,
            "blackout=false のフレームでは黒塗りが残ってはいけない"
        );
    }

    #[test]
    fn draw_blackout_at_minimum_fits_required_size_does_not_panic() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    true,
                )
            })
            .unwrap();

        // ちょうど最小サイズでも実際に通常UI(黒塗り)側の分岐に入っていることを確認する
        // （too-small分岐へ誤って落ちていないことの裏付け）。
        let (placeholder_area, _gap, _text) = split_columns(Rect::new(
            0,
            0,
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT - 1,
        ));
        let buffer = terminal.backend().buffer();
        let cell = buffer
            .cell((placeholder_area.x, placeholder_area.y))
            .expect("in bounds");
        assert_eq!(cell.bg, Color::Black);
    }

    #[test]
    fn draw_blackout_below_fits_required_size_shows_too_small_message_not_black_screen() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH - 1,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    true,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text = buffer_text(buffer);
        assert!(text.contains("端末を広げてください"), "buffer was: {text}");
        let area = buffer.area();
        let has_black_cell = (0..area.height).any(|y| {
            (0..area.width).any(|x| buffer.cell((x, y)).expect("in bounds").bg == Color::Black)
        });
        assert!(
            !has_black_cell,
            "端末が要求サイズ未満のときは黒塗り(暗転)を描画してはいけない"
        );
    }

    #[test]
    fn placeholder_label_style_renders_label_text() {
        let mut config = Config::default();
        config.placeholder.style = PlaceholderStyle::Label;
        config.placeholder.label = "[画像]".to_string();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("[画像]"), "buffer was: {text}");
    }

    #[test]
    fn placeholder_blank_style_renders_no_label_text() {
        let mut config = Config::default();
        config.placeholder.style = PlaceholderStyle::Blank;
        config.placeholder.label = "[画像]".to_string();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(!text.contains("[画像]"), "buffer was: {text}");
    }

    #[test]
    fn status_line_shows_end_marker_when_at_end() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    1,
                    1,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("(END)"), "buffer was: {text}");
    }

    #[test]
    fn status_line_omits_end_marker_when_not_at_end() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    1,
                    2,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(!text.contains("(END)"), "buffer was: {text}");
    }

    #[test]
    fn no_line_shows_placeholder_message() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    None,
                    &[],
                    0,
                    0,
                    true,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("会話行がありません"), "buffer was: {text}");
    }

    #[test]
    fn extremely_narrow_terminal_does_not_panic() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(1, 3)).unwrap();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hi".to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();
        // #494以降、W=1x H=3 は fits_required_size を満たさず draw_too_small_message 側の
        // 分岐に入るため、旧コメントが述べていた「左右Percentage(50/50)分割が0セルに丸まる
        // 経路」は実際には通らなくなったが、「reveal完了済みの極小端末でdraw()がpanicしない」
        // という回帰ガードとしての価値はそのまま残る。
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
    }

    #[test]
    fn typewriter_reveal_shows_only_visible_graphemes_before_done() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000; // 十分長い間隔で確実に「一部だけ表示」を作る
        config.typewriter.fade_duration_ms = 0;
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hello".to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        // t=0 では最初の1グラフェムしか見えない (jiwa::RevealHandle の仕様)。
        assert!(text.contains('h'), "buffer was: {text}");
        assert!(!text.contains("hello"), "buffer was: {text}");
    }

    #[test]
    fn page_indicator_is_absent_while_typing_and_present_once_done() {
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hello".to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();

        // 表示中（char_interval を長くして確実に未完了にする）はインジケータが出ない。
        let mut typing_config = Config::default();
        typing_config.typewriter.char_interval_ms = 1000;
        typing_config.typewriter.fade_duration_ms = 0;
        let typing_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&typing_config, &line, now));
        let mut typing_image_cache = ImageCache::new();
        let mut typing_terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        typing_terminal
            .draw(|f| {
                draw(
                    f,
                    &typing_config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&typing_reveal),
                    now,
                    now,
                    None,
                    &mut typing_image_cache,
                    false,
                )
            })
            .unwrap();
        let typing_text = buffer_text(typing_terminal.backend().buffer());
        assert!(
            !typing_text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "buffer was: {typing_text}"
        );

        // char_interval=0 かつ fade_duration=0 は t=0 から即座に is_done() なので、
        // インジケータ側の「完了後だけ出す」挙動をスキップ機能無しで検証できる。
        let mut done_config = Config::default();
        done_config.typewriter.char_interval_ms = 0;
        done_config.typewriter.fade_duration_ms = 0;
        let done_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&done_config, &line, now));
        let mut done_image_cache = ImageCache::new();
        let mut done_terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        done_terminal
            .draw(|f| {
                draw(
                    f,
                    &done_config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&done_reveal),
                    now,
                    now,
                    None,
                    &mut done_image_cache,
                    false,
                )
            })
            .unwrap();
        let done_text = buffer_text(done_terminal.backend().buffer());
        assert!(
            done_text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "buffer was: {done_text}"
        );
    }

    /// バッファを行ごとのテキストに変換する（`buffer_text` の行分割版）。
    /// ページ送りインジケータがどの行に付いているかを確認するテストで使う。
    fn buffer_rows(buffer: &Buffer) -> Vec<String> {
        let area = buffer.area();
        (0..area.height)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0u16;
                while x < area.width {
                    let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                    row.push_str(symbol);
                    x += symbol.cell_width().max(1);
                }
                row
            })
            .collect()
    }

    #[test]
    fn draw_empty_text_dialog_with_done_reveal_shows_only_indicator() {
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec![],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_is_fixed_at_window_bottom_right_not_attached_to_body_text() {
        // #487: GUI版advの右下固定（DialogBox.ts:1323-1329）に合わせ、文末追従をやめた。
        // 旧テスト（page_indicator_attaches_to_last_line_of_multiline_body）は文末追従を
        // 検証していたが、新仕様ではインジケータは本文の長さに関わらずウィンドウ右下の
        // 固定セルに描画される。
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["first line".to_string(), "second line".to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let rows = buffer_rows(buffer);

        // speaker "A" は Config::default() の player_speakers に含まれないため相手（上）窓。
        // #494: 端末サイズは固定キャンバス(CANVAS_W x CANVAS_H)ちょうどなので、テキスト列の
        // Rectはsplit_columnsから、高さはcanvas_text_rows_splitから、それぞれ導出する
        // （手計算した固定値をテストに直書きしない）。
        let (_placeholder, _gap, text_area) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let opponent_area = Rect {
            x: text_area.x,
            y: 0,
            width: text_area.width,
            height: opponent_height,
        };
        let indicator_cell = page_indicator_area(opponent_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        assert_eq!(
            cell.symbol(),
            reveal::PAGE_INDICATOR_SYMBOL,
            "indicator should render at the fixed bottom-right cell, rows were: {rows:?}"
        );

        let second_line_row = rows
            .iter()
            .find(|r| r.contains("second line"))
            .expect("second line should be rendered");
        assert!(
            !second_line_row.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must no longer attach to the body's last line (adv fixed position), rows were: {rows:?}"
        );
    }

    #[test]
    fn draw_does_not_panic_at_height_one() {
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hi".to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(40, 1)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_splash_renders_configured_logo_lines() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田田田".to_string(), "回回回".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("田田田"), "buffer was: {text}");
        assert!(text.contains("回回回"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_renders_continue_hint() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_shows_game_name_as_title() {
        let mut config = Config {
            game_name: "テストゲーム".to_string(),
            ..Config::default()
        };
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("テストゲーム"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_extremely_small_terminal_does_not_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田田田田田田田田田田".to_string(); 20];
        let mut terminal = Terminal::new(TestBackend::new(1, 1)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
    }

    #[test]
    fn draw_splash_invalid_color_name_falls_back_to_white_without_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        config.splash.color = "not-a-real-color".to_string();
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("田"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_content_fits_exactly_shows_hint() {
        // ロゴ1行 + 空行1行 + ヒント1行 = content_height 3。
        // Borders::ALL は上下1セルずつ占有するため、area.height=5 のとき
        // inner.height もちょうど3になり、余白ゼロで全行が収まる境界。
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 5)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_content_overflows_by_one_line_does_not_panic() {
        // 上のテストから area.height を1減らし、inner.height が content_height より
        // 1行分小さい状態（ヒント行が収まりきらない）を作る。ratatui の Paragraph は
        // wrap 未指定でも収まらない行を静かに切り詰めるだけで panic しないことの確認。
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 4)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
    }

    #[test]
    fn draw_splash_mixed_width_line_renders_without_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["AB田C".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("AB田C"), "buffer was: {text}");
    }

    // ---- フルキャンバス画像表示モード（#530）----

    #[test]
    fn draw_fullscreen_image_wide_image_with_enough_space_shows_hint_without_scroll_indicator() {
        // 横長画像(比4.0)はキャンバス全幅へcontain-fitしても表示可能行数に収まるため、
        // スクロール不要になり、ヒントは「Enter / Space で開始」だけになる。
        let image = DecodedImage {
            width: 4,
            height: 1,
            rgba: solid_rgba((200, 80, 80), 4, 1),
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter / Space で開始"), "buffer was: {text}");
        assert!(
            !text.contains('↑') && !text.contains('↓'),
            "スクロール不要な画像では↑/↓ヒントを出してはいけない, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_tall_image_needing_scroll_shows_scroll_hint() {
        // 正方形画像(比1.0)は端末セルの非正方形補正込みでcontain-fitすると表示可能行数
        // (image_area.height)を超えるため、スクロールヒント(↑/↓)が追加される。
        let image = DecodedImage {
            width: 1,
            height: 1,
            rgba: solid_rgba((80, 80, 200), 1, 1),
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains('↑') && text.contains('↓'),
            "スクロール要の画像では↑/↓ヒントを出すはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_scroll_offset_far_beyond_content_clamps_without_panicking() {
        let image = DecodedImage {
            width: 1,
            height: 1,
            rgba: solid_rgba((10, 20, 30), 1, 1),
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, u16::MAX))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("Enter"),
            "末尾でクランプされた状態でもヒントは描画されるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_terminal_too_small_shows_too_small_message_not_text_fallback() {
        // #530 デシジョンテーブル: 画面が小さすぎる場合、画像モード自身のtoo-smallガードが
        // 効き、draw_splash_textのテキストモードへは一切フォールバックしない。
        let image = DecodedImage {
            width: 4,
            height: 1,
            rgba: solid_rgba((10, 20, 30), 4, 1),
        };
        // 幅だけを不足させる（高さはREQUIRED_TOTAL_HEIGHTちょうど）。極小(5x5)だと
        // メッセージ自体が描画領域に収まりきらず切り詰められてしまうため、
        // `draw_too_small_message_content_survives_at_moderately_narrow_width` と同じ
        // 「狭いがゼロではない」中間幅を使う。
        let moderately_narrow_width = REQUIRED_TOTAL_WIDTH / 2;
        let mut terminal =
            Terminal::new(TestBackend::new(moderately_narrow_width, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("端末を広げてください"), "buffer was: {text}");
    }

    #[test]
    fn draw_fullscreen_image_zero_sized_decoded_image_does_not_panic() {
        // compute_full_width_rows(0, 0, ..) は 0 を返し、draw_fullscreen_image は
        // fitted_cols/rowsが0のとき早期returnする(グリッド構築・描画をどちらもしない)。
        let image = DecodedImage {
            width: 0,
            height: 0,
            rgba: vec![],
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
    }

    #[test]
    fn draw_fullscreen_image_zero_sized_decoded_image_still_shows_start_hint() {
        // バグ修正2（#538）: fitted_cols>0/fitted_rows==0（image.width/heightが0）の
        // 早期return経路でも、テキストモードのフォールバックと対称になるよう
        // 「Enter / Space で開始」ヒントだけは描画されるはず。
        let image = DecodedImage {
            width: 0,
            height: 0,
            rgba: vec![],
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("Enter / Space で開始"),
            "fitted_rows==0の早期return経路でも開始ヒントは表示されるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_zero_sized_decoded_image_does_not_show_scroll_hint() {
        // バグ修正2（#538）: fitted_rows==0の早期return経路では`scrollable`判定
        // （`fitted_rows > image_area.height`）自体が実行されないため、通常の画像描画
        // 経路が出す「↑/↓ でスクロール」ヒントは含まれないはず。
        let image = DecodedImage {
            width: 0,
            height: 0,
            rgba: vec![],
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            !text.contains("↑/↓ でスクロール"),
            "fitted_rows==0の早期return経路ではスクロールヒントを含まないはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_extremely_tall_image_uses_full_width_and_scrolls() {
        // 極端な縦長画像でも高さ優先の縮小へ切り替えず、全幅を使って縦スクロールする。
        let color = (10u8, 20u8, 30u8);
        let image = DecodedImage {
            width: 1,
            height: 50,
            rgba: solid_rgba(color, 1, 50),
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let image_color = Color::Rgb(color.0, color.1, color.2);
        assert_eq!(
            buffer.cell((0, 0)).unwrap().bg,
            image_color,
            "極端な縦長画像でも画像はキャンバス左端から全幅で始まるはず"
        );
        assert_eq!(
            buffer.cell((CANVAS_W - 1, 0)).unwrap().bg,
            image_color,
            "極端な縦長画像でも画像はキャンバス右端まで全幅で使うはず"
        );
        assert!(
            buffer_text(buffer).contains("↑/↓ でスクロール"),
            "極端な縦長画像では縦スクロールヒントを表示するはず"
        );
    }

    /// `splash.logo_image`/`event_image.assets_dir` を実在するWebPフィクスチャへ向けた
    /// `Config` を作る（`draw_splash` がフルキャンバス画像表示モードへ実際に分岐する
    /// テスト用。`config_and_relative_path_for` を土台に、スプラッシュ用フィールドを
    /// 追加で設定する）。
    fn splash_config_with_logo_image(fixture_path: &std::path::Path) -> Config {
        let (mut config, relative) = config_and_relative_path_for(fixture_path);
        config.splash.enabled = true;
        config.splash.logo_image = Some(std::path::PathBuf::from(relative));
        config
    }

    #[test]
    fn draw_splash_logo_image_load_failure_falls_back_to_text_mode() {
        // ファイルが存在しないパスを指す logo_image を設定する（実際にはロードに失敗する）。
        // #530: 画像ロード失敗時はテキストモード（`splash.lines`）へフォールバックする。
        let mut config = Config::default();
        config.event_image.assets_dir = std::path::PathBuf::from("tui/tests/fixtures");
        config.splash.enabled = true;
        config.splash.logo_image = Some(std::path::PathBuf::from("does-not-exist.webp"));
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("田"),
            "ロード失敗時はテキストモードのロゴ行が描画されるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_splash_logo_image_load_failure_with_empty_lines_does_not_panic() {
        let mut config = Config::default();
        config.event_image.assets_dir = std::path::PathBuf::from("tui/tests/fixtures");
        config.splash.enabled = true;
        config.splash.logo_image = Some(std::path::PathBuf::from("does-not-exist.webp"));
        config.splash.lines = vec![];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("Enter / Space で開始"),
            "lines が空でも開始ヒントはテキストモードへフォールバックして表示するはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_splash_valid_logo_image_renders_fullscreen_image_mode_not_text() {
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((200, 80, 80), 4, 1), 4, 1);
        let mut config = splash_config_with_logo_image(&fixture_path);
        config.game_name = "テストゲーム".to_string();
        config.splash.lines = vec!["田".to_string()]; // logo_image優先で無視されるはず
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            !text.contains("田"),
            "logo_imageが有効な場合はテキストモードのlinesを描画しないはず, buffer was: {text}"
        );
        assert!(
            !text.contains("テストゲーム"),
            "フルキャンバス画像表示はテキストモードの罫線タイトルを描かないはず, buffer was: {text}"
        );
        assert!(text.contains("Enter / Space で開始"), "buffer was: {text}");
    }

    // ---- #480: 画面分割(50/50・プレイヤー/相手ウィンドウ分離・枠なし)のテスト ----
    //
    // ratatui 0.30.2 の `Layout::split` は `Constraint::Percentage(50)/Percentage(50)` を
    // 奇数サイズに適用したとき前者(左/上)が切り上げ・後者(右/下)が切り捨てになる（cargo test
    // で `Layout::split` の戻り値を直接ダンプして実測・確認済み）。左右 columns（画像
    // プレースホルダ/テキスト）の分割はこの丸めをそのまま使っている（対称性を要求しない分割
    // のため問題ない。W=7 で左が1セル余分に取る例は下記
    // `odd_terminal_width_gives_placeholder_column_the_extra_cell` 参照）。#488 でこの2分割の
    // 間に固定幅スペーサー（[`IMAGE_TEXT_GAP_WIDTH`]）を挟む3分割（`split_columns`）に
    // なったが、下記テストの多くは W=40 のような偶数幅を使っており、`Constraint::Length` を
    // 満たす不足分がスペーサーに隣接する画像側から差し引かれる関係で、テキスト側
    // （最終カラム）の開始x座標・幅は#480当時の2分割と偶然一致する（下記の各テストの
    // コメント・`draw_with_resolved_image_fade_keeps_480_text_column_start_x_unchanged`
    // 参照）。
    //
    // 一方、テキスト側の上下分割（相手=上/自分=下）は `Constraint::Percentage` ではなく
    // `Constraint::Length` で明示的に高さを計算しており（`draw_text_windows` 内、
    // opponent=`height/2`切り捨て・self=`height-opponent`）、self が余りの1行を必ず受け取る。
    // これは self が opponent より恒常的に1行少なくなる片側固定バイアスをセルフレビューで
    // 発見し修正した結果であり、以下のテストは修正後の挙動（self が優先される）を固定する。

    /// テスト用に `DisplayLine` を組み立てる（複数のテストで多用するための局所ヘルパー）。
    fn dialog_line(speaker: Option<&str>, text: Vec<&str>) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: text.into_iter().map(|s| s.to_string()).collect(),
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        }
    }

    /// `draw()` を指定サイズの `TestBackend` に1回描画し、結果バッファを返す簡易ヘルパー。
    /// `position`/`total`/`is_at_end` はレイアウト・話者振り分けの検証には無関係なので固定値
    /// （タイムスタンプに依存する `reveal::RevealState::Animating` の状態遷移テストは、この
    /// ヘルパーを使わず既存テストと同じ手書きスタイルで `now` を共有する）。
    fn render(
        config: &Config,
        line: Option<&DisplayLine>,
        reveal: Option<&reveal::RevealState>,
        width: u16,
        height: u16,
    ) -> Buffer {
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    config,
                    line,
                    None,
                    &[],
                    1,
                    1,
                    false,
                    reveal,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        terminal.backend().buffer().clone()
    }

    /// バッファの1行を、x座標の範囲を絞ってテキスト化する（`buffer_rows` の列範囲限定版）。
    /// 左側プレースホルダ列と右側テキスト列は同じ行(y)を共有するため、「テキスト側の窓が
    /// 空かどうか」を見るテストは行全体ではなく列範囲を絞って判定する必要がある
    /// （プレースホルダ列の内容が行頭に混ざって誤判定になるのを避ける）。
    fn buffer_rows_in_x_range(buffer: &Buffer, x_start: u16, x_end: u16) -> Vec<String> {
        let area = buffer.area();
        (0..area.height)
            .map(|y| {
                let mut row = String::new();
                let mut x = x_start;
                while x < x_end {
                    let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                    row.push_str(symbol);
                    x += symbol.cell_width().max(1);
                }
                row
            })
            .collect()
    }

    /// 指定した行 (y) のテキスト列（x_start以降）の中で最初に非空白文字が現れるセルの
    /// 前景色を返す。話者識別が文字色（`Config::color_name_for`）で行われることを検証する
    /// テストで使う。左側プレースホルダ列を除外するため x_start を指定する。
    fn first_colored_cell_in_row(buffer: &Buffer, y: u16, x_start: u16) -> Option<Color> {
        let area = buffer.area();
        (x_start..area.width).find_map(|x| {
            let cell = buffer.cell((x, y)).expect("in bounds");
            if cell.symbol() == " " {
                None
            } else {
                Some(cell.fg)
            }
        })
    }

    /// #494以降の統合テストで使う既定の端末サイズ: 固定必要サイズちょうど
    /// （[`REQUIRED_TOTAL_WIDTH`] x [`REQUIRED_TOTAL_HEIGHT`]）。この値以上を渡せば
    /// `fits_required_size` を満たし、`draw()` は必ずこのサイズの固定キャンバスを描画する
    /// （実端末サイズがちょうどこのサイズなら `compute_centered_canvas` のオフセットも0になり、
    /// 期待値の計算が最も単純になる）。以下の統合テストの多くは実端末サイズの違いではなく
    /// 話者振り分け・テキストレイアウト自体の検証が目的なので、一貫してこの既定値を使う
    /// （小さすぎる端末での挙動は別途 [`draw_too_small_message`] 関連のテストで検証する）。
    const CANVAS_W: u16 = REQUIRED_TOTAL_WIDTH;
    const CANVAS_H: u16 = REQUIRED_TOTAL_HEIGHT;

    /// `render()`(`draw()`)が`CANVAS_W`x`CANVAS_H`のとき渡すキャンバス上でテキスト列が
    /// 開始するx座標を`split_columns`から導出する（手計算した固定値をテストに直書きしない）。
    fn canvas_text_column_x_start() -> u16 {
        let (_placeholder, _gap, text) = split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        text.x
    }

    /// `draw_text_windows`内の相手(opponent)/自分(self)の上下分割の高さを、`CANVAS_H`のときの
    /// 値として導出する（`draw_text_windows`のopponent=height/2切り捨て・self=height-opponentと
    /// 同じ式。root[0].height = CANVAS_H - 1(ステータス行分)が入力になる）。
    fn canvas_text_rows_split() -> (u16, u16) {
        let root0_height = CANVAS_H - 1;
        let opponent_height = root0_height / 2;
        let self_height = root0_height - opponent_height;
        (opponent_height, self_height)
    }

    // ---- #494: fits_required_size / compute_centered_canvas の境界値テスト ----

    #[test]
    fn fits_required_size_exactly_required_is_true() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
        assert!(fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_one_cell_narrower_is_false() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH - 1, REQUIRED_TOTAL_HEIGHT);
        assert!(!fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_one_cell_shorter_is_false() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT - 1);
        assert!(!fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_one_cell_narrower_and_shorter_is_false() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH - 1, REQUIRED_TOTAL_HEIGHT - 1);
        assert!(!fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_larger_in_both_dimensions_is_true() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH + 10, REQUIRED_TOTAL_HEIGHT + 10);
        assert!(fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_zero_sized_is_false() {
        assert!(!fits_required_size(Rect::new(0, 0, 0, 0)));
    }

    // 以下4件は幅/高さそれぞれの過不足を混合させたデシジョンテーブルの欠落マス
    // （既存テストは幅のみ不足・高さのみ不足・両方不足・両方過剰の4通りのみをカバーしており、
    // 「片方不足+もう片方過剰」の組み合わせが未検証だった）。`fits_required_size` は両方が
    // 要求値以上のときのみ `true` を返すAND条件のため、一方でも不足していれば他方が過剰でも
    // `false` になるはずである。

    #[test]
    fn fits_required_size_width_deficient_height_excess_is_false() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH - 1, REQUIRED_TOTAL_HEIGHT + 1);
        assert!(!fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_width_excess_height_deficient_is_false() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH + 1, REQUIRED_TOTAL_HEIGHT - 1);
        assert!(!fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_one_cell_wider_only_is_true() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH + 1, REQUIRED_TOTAL_HEIGHT);
        assert!(fits_required_size(actual));
    }

    #[test]
    fn fits_required_size_one_cell_taller_only_is_true() {
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT + 1);
        assert!(fits_required_size(actual));
    }

    #[test]
    fn compute_centered_canvas_actual_equals_required_has_zero_offset() {
        let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
        let canvas = compute_centered_canvas(required, required);
        assert_eq!(
            canvas, required,
            "when actual exactly matches required, there is no margin to center within"
        );
    }

    #[test]
    fn compute_centered_canvas_larger_actual_centers_with_even_margins() {
        let required = Rect::new(0, 0, 10, 4);
        // 余白: 幅+20(左右10ずつ)、高さ+8(上下4ずつ)。
        let actual = Rect::new(0, 0, 30, 12);
        let canvas = compute_centered_canvas(actual, required);
        assert_eq!(canvas, Rect::new(10, 4, 10, 4));
    }

    #[test]
    fn compute_centered_canvas_height_only_excess_centers_vertically_width_unchanged() {
        // 幅は required と一致させ、高さだけ超過させる（幅軸のオフセットが常に0のまま、
        // 高さ軸だけが中央寄せされることの単独確認。上の
        // `compute_centered_canvas_larger_actual_centers_with_even_margins` は両軸とも
        // 過剰なケースのため、高さ単独の寄与を切り分けられていなかった）。
        let required = Rect::new(0, 0, 10, 4);
        let actual = Rect::new(0, 0, 10, 8);
        let canvas = compute_centered_canvas(actual, required);
        assert_eq!(canvas, Rect::new(0, 2, 10, 4));
    }

    #[test]
    fn compute_centered_canvas_odd_margin_favors_left_and_top() {
        // 幅の余白が奇数(1)のとき、整数除算により左側のオフセットが切り捨てられる
        // （右側に多く残る＝厳密な左右対称は要求しない、doc コメント参照）。
        let required = Rect::new(0, 0, 10, 4);
        let actual = Rect::new(0, 0, 11, 4); // 余白1
        let canvas = compute_centered_canvas(actual, required);
        assert_eq!(
            canvas.x, 0,
            "an odd margin should round down via integer division, leaving the extra cell on the right"
        );
        assert_eq!(canvas.width, 10);
    }

    #[test]
    fn compute_centered_canvas_odd_vertical_margin_favors_top() {
        // 上と対になる高さ軸版: 高さの余白が奇数(1)のとき、整数除算により上側のオフセットが
        // 切り捨てられる（下側に多く残る＝厳密な上下対称は要求しない、doc コメント参照）。
        let required = Rect::new(0, 0, 10, 4);
        let actual = Rect::new(0, 0, 10, 5); // 余白1
        let canvas = compute_centered_canvas(actual, required);
        assert_eq!(
            canvas.y, 0,
            "an odd vertical margin should round down via integer division, leaving the extra cell on the bottom"
        );
        assert_eq!(canvas.height, 4);
    }

    #[test]
    fn compute_centered_canvas_respects_nonzero_actual_origin() {
        let required = Rect::new(0, 0, 10, 4);
        let actual = Rect::new(5, 7, 30, 12);
        let canvas = compute_centered_canvas(actual, required);
        assert_eq!(canvas, Rect::new(5 + 10, 7 + 4, 10, 4));
    }

    #[test]
    fn compute_centered_canvas_actual_smaller_than_required_clamps_without_panicking() {
        // draw() からは fits_required_size(actual) が真の場合のみ呼ばれる想定だが、
        // 関数自体は縮小クランプにより防御的にpanicしないことを確認する（doc コメント参照）。
        let required = Rect::new(0, 0, 10, 4);
        let actual = Rect::new(0, 0, 3, 2);
        let canvas = compute_centered_canvas(actual, required);
        assert_eq!(canvas.width, 3);
        assert_eq!(canvas.height, 2);
    }

    #[test]
    fn draw_too_small_message_shows_actual_and_required_dimensions() {
        let config = Config::default();
        let buffer = render(
            &config,
            None,
            None,
            REQUIRED_TOTAL_WIDTH - 1,
            REQUIRED_TOTAL_HEIGHT,
        );
        let text = buffer_text(&buffer);
        assert!(
            text.contains(&format!(
                "現在 {}x{}",
                REQUIRED_TOTAL_WIDTH - 1,
                REQUIRED_TOTAL_HEIGHT
            )),
            "buffer was: {text}"
        );
        assert!(
            text.contains(&format!(
                "必要 {REQUIRED_TOTAL_WIDTH}x{REQUIRED_TOTAL_HEIGHT}"
            )),
            "buffer was: {text}"
        );
    }

    #[test]
    fn draw_too_small_message_does_not_panic_across_tiny_and_edge_sizes() {
        let config = Config::default();
        for (w, h) in [
            (0u16, 0u16),
            (1, 1),
            (0, 5),
            (5, 0),
            (1, REQUIRED_TOTAL_HEIGHT),
            (REQUIRED_TOTAL_WIDTH, 1),
            (REQUIRED_TOTAL_WIDTH - 1, REQUIRED_TOTAL_HEIGHT - 1),
        ] {
            let _ = render(&config, None, None, w, h); // panicしないことのみ確認する
        }
    }

    #[test]
    fn draw_too_small_message_content_survives_at_moderately_narrow_width() {
        // 上のテストは極小(0/1)や境界ぴったり(REQUIRED_TOTAL_WIDTH-1)のようなpanic有無の
        // 確認に留まっており、それらの中間にあたる「狭いがゼロではない」幅でメッセージの
        // 本文そのものが実際にバッファへ描画されるかは未検証だった。高さは
        // REQUIRED_TOTAL_HEIGHT ちょうど(不足していない)にして、幅の狭さだけを効かせる。
        let config = Config::default();
        let moderately_narrow_width = REQUIRED_TOTAL_WIDTH / 2; // 極小でも境界ぴったりでもない中間幅
        let buffer = render(
            &config,
            None,
            None,
            moderately_narrow_width,
            REQUIRED_TOTAL_HEIGHT,
        );
        let text = buffer_text(&buffer);
        assert!(text.contains("端末を広げてください"), "buffer was: {text}");
    }

    #[test]
    fn draw_larger_than_required_terminal_offsets_content_by_centering_margin() {
        // 実端末がCANVAS_W/CANVAS_Hより大きい場合、UI全体がcompute_centered_canvasの
        // オフセット分だけ右下にずれて描画されることを、テキスト列の開始位置で確認する
        // （レターボックス/ピラーボックス、#494）。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["Y"]); // "A" は player_speakers 非該当=opponent(上)
        let extra_w = 6u16;
        let extra_h = 4u16;
        let buffer = render(
            &config,
            Some(&line),
            None,
            CANVAS_W + extra_w,
            CANVAS_H + extra_h,
        );
        let area = buffer.area();
        let mut leftmost_y_x = None;
        'outer: for y in 0..area.height {
            for x in 0..area.width {
                if buffer.cell((x, y)).expect("in bounds").symbol() == "Y" {
                    leftmost_y_x = Some(x);
                    break 'outer;
                }
            }
        }
        let x = leftmost_y_x.expect("text should render somewhere");
        let expected_x_offset = extra_w / 2;
        assert_eq!(
            x,
            canvas_text_column_x_start() + expected_x_offset,
            "text column should shift right by the centering margin"
        );
    }

    #[test]
    fn draw_taller_than_required_terminal_offsets_content_vertically_by_centering_margin() {
        // 上の`draw_larger_than_required_terminal_offsets_content_by_centering_margin`
        // （x軸版）と対になるy軸版。幅はCANVAS_Wちょうどに固定し、高さだけ超過させた
        // terminalでdraw()を経由してrenderし、テキストの描画y座標が
        // compute_centered_canvasの高さオフセット分だけ下にずれることを確認する。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["Y"]); // "A" は player_speakers 非該当=opponent(上)
        let extra_h = 4u16;
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H + extra_h);
        let area = buffer.area();
        let mut topmost_y = None;
        'outer: for y in 0..area.height {
            for x in 0..area.width {
                if buffer.cell((x, y)).expect("in bounds").symbol() == "Y" {
                    topmost_y = Some(y);
                    break 'outer;
                }
            }
        }
        let y = topmost_y.expect("text should render somewhere");
        let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
        let actual = Rect::new(0, 0, CANVAS_W, CANVAS_H + extra_h);
        let expected_y = compute_centered_canvas(actual, required).y;
        assert_eq!(
            y, expected_y,
            "text row should shift down by the centering margin"
        );
    }

    // -- A. 話者振り分け --

    #[test]
    fn player_speaker_text_renders_in_bottom_half_of_screen() {
        // #494: 実端末サイズを CANVAS_W x CANVAS_H(固定必要サイズちょうど)にすると、
        // draw()が内部で使う root[0].height は常に (CANVAS_H - 1) になる。行境界は
        // `canvas_text_rows_split` から導出し、手計算した固定値をテストに直書きしない。
        let config = Config {
            player_speakers: vec!["Player".to_string()],
            ..Config::default()
        };
        let line = dialog_line(Some("Player"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let (top, bottom) = rows.split_at(opponent_height as usize);
        assert!(
            bottom.iter().any(|r| r.contains("hello")),
            "player speaker text should render in the bottom half, rows were: {rows:?}"
        );
        assert!(
            !top.iter().any(|r| r.contains("hello")),
            "player speaker text must not leak into the top half, rows were: {rows:?}"
        );
    }

    #[test]
    fn opponent_speaker_text_renders_in_top_half_of_screen() {
        let config = Config::default(); // player_speakers = ["主格"]
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let (top, bottom) = rows.split_at(opponent_height as usize);
        assert!(
            top.iter().any(|r| r.contains("hello")),
            "unmatched speaker text should render in the top half, rows were: {rows:?}"
        );
        assert!(
            !bottom.iter().any(|r| r.contains("hello")),
            "unmatched speaker text must not leak into the bottom half, rows were: {rows:?}"
        );
    }

    #[test]
    fn narration_none_speaker_renders_in_top_half_with_narration_color() {
        let config = Config::default();
        let line = dialog_line(None, vec!["ナレーション"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let (top, bottom) = rows.split_at(opponent_height as usize);
        let hit_row = top.iter().position(|r| r.contains("ナレーション"));
        assert!(
            hit_row.is_some(),
            "narration text should render in the top half, rows were: {rows:?}"
        );
        assert!(
            !bottom.iter().any(|r| r.contains("ナレーション")),
            "narration text must not leak into the bottom half, rows were: {rows:?}"
        );
        let y = hit_row.unwrap() as u16;
        // 左側プレースホルダ列を避け、テキスト列だけを見る。
        let color = first_colored_cell_in_row(&buffer, y, canvas_text_column_x_start())
            .expect("a colored cell should exist on the narration row");
        assert_eq!(
            color,
            Color::Gray,
            "None(Narration) speaker should use colors.narration (default: gray)"
        );
    }

    #[test]
    fn player_speaker_leaves_opponent_top_window_completely_blank() {
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        // テキスト列だけを見る。左側プレースホルダ列は話者に関わらず常に何か描画するため、
        // 行全体で判定すると誤検知する。
        let rows = buffer_rows_in_x_range(&buffer, canvas_text_column_x_start(), CANVAS_W);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        assert!(
            rows[..opponent_height as usize]
                .iter()
                .all(|r| r.trim().is_empty()),
            "opponent(top) text window must be entirely blank while the player speaks, rows were: {rows:?}"
        );
    }

    #[test]
    fn opponent_speaker_leaves_self_bottom_window_completely_blank() {
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows_in_x_range(&buffer, canvas_text_column_x_start(), CANVAS_W);
        let (opponent_height, self_height) = canvas_text_rows_split();
        // ステータス行（最終行）は self ウィンドウの外なので範囲に含めない。
        assert!(
            rows[opponent_height as usize..(opponent_height + self_height) as usize]
                .iter()
                .all(|r| r.trim().is_empty()),
            "self(bottom) text window must be entirely blank while an opponent speaks, rows were: {rows:?}"
        );
    }

    // -- B. 同値分割 --

    #[test]
    fn empty_player_speakers_list_routes_all_named_speakers_to_top_window() {
        // player_speakers を空にすると、デフォルトなら player 側になる名前（"主格"）も
        // 相手(上)側に落ちる（`Config::is_player_speaker` は空リストで常に false を返す）。
        let config = Config {
            player_speakers: vec![],
            ..Config::default()
        };
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let (top, bottom) = rows.split_at(opponent_height as usize);
        assert!(
            top.iter().any(|r| r.contains("hello")),
            "with an empty player_speakers list, even the default player name should go to the top window, rows were: {rows:?}"
        );
        assert!(
            !bottom.iter().any(|r| r.contains("hello")),
            "rows were: {rows:?}"
        );
    }

    // -- C. 境界値 --
    //
    // #494: `draw()` は固定必要サイズ未満の端末では常に [`draw_too_small_message`] だけを
    // 表示するようになったため、`draw_text_windows` 固有の行分割算術（極小高さでの端数の
    // 挙動）を検証する以下のテストは、`draw()`（`render()`ヘルパー）ではなく
    // `draw_text_windows` を直接呼ぶ `render_text_windows` ヘルパー経由に切り替える。
    // `draw_text_windows` は画像プレースホルダ列を知らないぶん、`area.height` がそのまま
    // 行分割の入力になる（`draw()` 経由だった旧テストのようにステータス行1を引く必要が
    // 無くなった点に注意）。

    /// `render()`(`draw()`)ではなく [`draw_text_windows`] を直接指定サイズの `TestBackend` に
    /// 描画するヘルパー（#494）。相手/自分の行分割という `draw_text_windows` 固有の算術を
    /// 検証するテストは、`draw()` の固定必要サイズゲートを経由せずこの関数を直接叩く。
    fn render_text_windows(
        config: &Config,
        line: Option<&DisplayLine>,
        reveal: Option<&reveal::RevealState>,
        width: u16,
        height: u16,
    ) -> Buffer {
        let now = Instant::now();
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_text_windows(f, area, config, line, reveal, now, now);
            })
            .unwrap();
        terminal.backend().buffer().clone()
    }

    #[test]
    fn odd_text_area_height_gives_self_window_the_extra_row() {
        // area.height=3(奇数) → opponent=floor(3/2)=1行・self=3-1=2行になり、self(下/自分)側が
        // 余りの1行を受け取る（self が損をしないよう明示的な高さ計算にした、セルフレビュー
        // 修正）。Rect を直接覗く代わりに、2行の本文を与えたとき何行まで収まるかで高さを実測する。
        let config = Config::default();
        let text = vec!["line1", "line2"];

        let opponent_line = dialog_line(Some("相手"), text.clone());
        let opponent_buffer = render_text_windows(&config, Some(&opponent_line), None, 40, 3);
        let opponent_text = buffer_text(&opponent_buffer);
        assert!(
            opponent_text.contains("line1"),
            "buffer was: {opponent_text}"
        );
        assert!(
            !opponent_text.contains("line2"),
            "opponent window (height 1) should clip the second line, buffer was: {opponent_text}"
        );

        let self_line = dialog_line(Some("主格"), text);
        let self_buffer = render_text_windows(&config, Some(&self_line), None, 40, 3);
        let self_text = buffer_text(&self_buffer);
        assert!(self_text.contains("line1"), "buffer was: {self_text}");
        assert!(
            self_text.contains("line2"),
            "self window (height 2) should fit both lines, buffer was: {self_text}"
        );
    }

    #[test]
    fn text_area_height_one_collapses_opponent_window_to_zero_height() {
        // area.height=1 → opponent=floor(1/2)=0・self=1-0=1 になり、self が優先されるため、
        // 相手発言(opponent窓)が実質どこにも描画されなくなる（旧実装では逆に self 側が
        // 消えていた。セルフレビュー修正）。
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let buffer = render_text_windows(&config, Some(&line), None, 40, 1);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains("hello"),
            "opponent window has height 0 at area.height=1, opponent text must not render anywhere, buffer was: {text}"
        );
    }

    #[test]
    fn even_text_area_height_splits_evenly() {
        // area.height=2(偶数) → opponent(上)=1行・self(下)=1行の対称になる。height=3で self
        // が余りの1行を受け取るケース（1つ上のテスト）と対を成す対比ケース。
        let config = Config::default();
        let text = vec!["line1", "line2"];

        let opponent_line = dialog_line(Some("相手"), text.clone());
        let opponent_buffer = render_text_windows(&config, Some(&opponent_line), None, 40, 2);
        let opponent_text = buffer_text(&opponent_buffer);
        assert!(
            opponent_text.contains("line1"),
            "buffer was: {opponent_text}"
        );
        assert!(
            !opponent_text.contains("line2"),
            "opponent window should also be height 1 at area.height=2 (symmetric with self), buffer was: {opponent_text}"
        );

        let self_line = dialog_line(Some("主格"), text);
        let self_buffer = render_text_windows(&config, Some(&self_line), None, 40, 2);
        let self_text = buffer_text(&self_buffer);
        assert!(self_text.contains("line1"), "buffer was: {self_text}");
        assert!(
            !self_text.contains("line2"),
            "self window should be height 1 at area.height=2, buffer was: {self_text}"
        );
    }

    #[test]
    fn terminal_smaller_than_required_shows_too_small_message_not_body_content() {
        // #494: H=1 のような固定必要サイズ未満の端末では、draw() は通常のゲームUI
        // （ステータス行を含む）を一切描画せず、代わりに「端末を広げてください」
        // メッセージだけを表示する。
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 1);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains(&config.game_name),
            "the normal status line must not render below the required size, buffer was: {text}"
        );
        assert!(
            !text.contains("hello"),
            "body content must not render below the required size, buffer was: {text}"
        );
        assert!(
            text.contains("端末を広げてください"),
            "a too-small guidance message should render instead, buffer was: {text}"
        );
    }

    #[test]
    fn draw_wires_split_columns_text_column_start_x_on_the_fixed_canvas() {
        // #494: draw()が渡すcanvasは固定サイズ(CANVAS_W x CANVAS_H)なので、旧#480テストが
        // 検証していた「任意の端末幅Wでのsplit_columnsの丸め」という統合確認はできなくなった
        // （split_columns自体の丸め挙動は複数の直接呼び出しテストが引き続きカバーしている、
        // `split_columns_at_wide_area_gives_text_two_more_cells_than_image_steady_state`等
        // 参照）。ここでは「draw()がCANVAS_W/CANVAS_Hのとき、テキスト列の開始位置が
        // split_columnsの計算結果と一致する」という配線自体を固定する。手計算した固定値を
        // テストに直書きしない。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["Y"]); // "A" は player_speakers 非該当=opponent(上)
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let area = buffer.area();
        let mut leftmost_y_x = None;
        'outer: for y in 0..area.height {
            for x in 0..area.width {
                if buffer.cell((x, y)).expect("in bounds").symbol() == "Y" {
                    leftmost_y_x = Some(x);
                    break 'outer;
                }
            }
        }
        let x = leftmost_y_x.expect("text should render somewhere");
        assert_eq!(
            x,
            canvas_text_column_x_start(),
            "text column should start where split_columns places it; found at x={x}"
        );
    }

    #[test]
    fn narrow_text_area_with_no_display_line_does_not_panic_on_fullwidth_fallback_message() {
        // 全角文字を含むフォールバック文言「(会話行がありません)」をテキスト側ウィンドウ幅が
        // ちょうど2セルの状態で wrap 描画しようとすると、ratatui 内部
        // （`ratatui_widgets::paragraph::render_line` → `Buffer::index_mut`）で
        // バッファ範囲外書き込みpanicすることを実測で確認した（幅1セル・幅3セル以上では
        // 再現しない）。`render_wrapped_paragraph` の極小幅ガード（3セル未満はwrap描画を
        // スキップ）でこの経路を回避できていることを固定する回帰テスト。
        //
        // #494: draw()は固定キャンバス化され、テキスト列の幅は常に REQUIRED_TEXT_COLS
        // 基準の十分な幅になるため、この危険幅(2)は draw() 経由ではもう自然発生しない。
        // draw_text_windows を直接呼び、area幅そのものを危険幅(2)に固定して検証する
        // （旧テストは split_columns がこの幅を生む総端末幅Wを探して間接的に再現していたが、
        // draw_text_windows は area を直接受け取るため、その必要が無くなった）。
        let config = Config::default();
        for h in [2u16, 3, 4, 10] {
            let mut terminal = Terminal::new(TestBackend::new(2, h)).unwrap();
            let now = Instant::now();
            terminal
                .draw(|f| {
                    let area = f.area();
                    draw_text_windows(f, area, &config, None, None, now, now);
                })
                .unwrap();
        }
    }

    // -- D. null/空/未設定 --

    #[test]
    fn no_display_line_renders_placeholder_message_in_top_window_only() {
        let config = Config::default();
        let buffer = render(&config, None, None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        assert!(
            rows[..opponent_height as usize]
                .iter()
                .any(|r| r.contains("会話行がありません")),
            "fallback message should render in the top window, rows were: {rows:?}"
        );
        let text_rows = buffer_rows_in_x_range(&buffer, canvas_text_column_x_start(), CANVAS_W);
        let (_opponent_height, self_height) = canvas_text_rows_split();
        // ステータス行（最終行）は self ウィンドウの外なので範囲に含めない。
        assert!(
            text_rows[opponent_height as usize..(opponent_height + self_height) as usize]
                .iter()
                .all(|r| r.trim().is_empty()),
            "self(bottom) text window should stay blank when there is no display line, rows were: {text_rows:?}"
        );
    }

    #[test]
    fn empty_text_vec_with_player_speaker_shows_indicator_only_in_bottom_window() {
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec![]);
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        assert!(
            rows[opponent_height as usize..]
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "page indicator should render in the bottom window for an empty player line, rows were: {rows:?}"
        );
        let text_rows = buffer_rows_in_x_range(&buffer, canvas_text_column_x_start(), CANVAS_W);
        assert!(
            text_rows[..opponent_height as usize]
                .iter()
                .all(|r| r.trim().is_empty()),
            "opponent(top) text window should stay blank, rows were: {text_rows:?}"
        );
    }

    // -- E. 状態遷移 --

    #[test]
    fn player_speaker_typewriter_reveal_shows_partial_text_in_bottom_window() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000; // 十分長い間隔で確実に「一部だけ表示」を作る
        config.typewriter.fade_duration_ms = 0;
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let now = Instant::now();
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let rows = buffer_rows(terminal.backend().buffer());
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let (top, bottom) = rows.split_at(opponent_height as usize);
        assert!(
            bottom.iter().any(|r| r.contains('h')),
            "the first revealed grapheme should render in the bottom window, rows were: {rows:?}"
        );
        assert!(
            !bottom.iter().any(|r| r.contains("hello")),
            "text should still be partial (typewriter in progress), rows were: {rows:?}"
        );
        assert!(
            !top.iter().any(|r| r.contains('h')),
            "typewriter text must not leak into the top window, rows were: {rows:?}"
        );
    }

    #[test]
    fn player_speaker_page_indicator_appears_only_after_done_in_bottom_window() {
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let now = Instant::now();
        let (opponent_height, _self_height) = canvas_text_rows_split();

        // 表示中（未完了）は下窓にもインジケータは出ない。
        let mut typing_config = Config::default();
        typing_config.typewriter.char_interval_ms = 1000;
        typing_config.typewriter.fade_duration_ms = 0;
        let typing_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&typing_config, &line, now));
        let mut typing_image_cache = ImageCache::new();
        let mut typing_terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        typing_terminal
            .draw(|f| {
                draw(
                    f,
                    &typing_config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&typing_reveal),
                    now,
                    now,
                    None,
                    &mut typing_image_cache,
                    false,
                )
            })
            .unwrap();
        let typing_rows = buffer_rows(typing_terminal.backend().buffer());
        assert!(
            !typing_rows
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "rows were: {typing_rows:?}"
        );

        // 完了後は下窓(self)にのみインジケータが出る。
        let mut done_config = Config::default();
        done_config.typewriter.char_interval_ms = 0;
        done_config.typewriter.fade_duration_ms = 0;
        let done_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&done_config, &line, now));
        let mut done_image_cache = ImageCache::new();
        let mut done_terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        done_terminal
            .draw(|f| {
                draw(
                    f,
                    &done_config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&done_reveal),
                    now,
                    now,
                    None,
                    &mut done_image_cache,
                    false,
                )
            })
            .unwrap();
        let done_rows = buffer_rows(done_terminal.backend().buffer());
        let (done_top, done_bottom) = done_rows.split_at(opponent_height as usize);
        assert!(
            done_bottom
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "rows were: {done_rows:?}"
        );
        assert!(
            !done_top
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "rows were: {done_rows:?}"
        );
    }

    // -- F. i18n/文字種混在 --

    #[test]
    fn long_single_line_wraps_within_half_height_window_without_bleeding_into_other_window() {
        let config = Config::default();
        let long_text = "a".repeat(45); // opponent窓(高さ十分)内に折り返される
        let line = dialog_line(Some("相手"), vec![long_text.as_str()]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, self_height) = canvas_text_rows_split();
        let top = &rows[..opponent_height as usize];
        // ステータス行（最終行、game_name="gymnasia"に'a'が2つ含まれる）は self ウィンドウの
        // 外なので、bottom の範囲から明示的に除外する（さもないとステータス行の'a'まで
        // self_as に数えてしまい誤検知する）。
        let bottom = &rows[opponent_height as usize..(opponent_height + self_height) as usize];
        let opponent_as: usize = top.iter().map(|r| r.matches('a').count()).sum();
        let self_as: usize = bottom.iter().map(|r| r.matches('a').count()).sum();
        assert_eq!(
            opponent_as, 45,
            "all wrapped characters should land in the opponent(top) window, rows were: {rows:?}"
        );
        assert_eq!(
            self_as, 0,
            "wrapped continuation must not bleed into the self(bottom) window, rows were: {rows:?}"
        );
    }

    #[test]
    fn fullwidth_speaker_name_matches_player_list_exactly_routes_to_bottom() {
        // Config::default() の player_speakers は実運用の gymnasia 設定値である全角 "主格"。
        // config.rs 側の文字列一致の単体テストとは別に、描画パイプライン全体を通しても
        // このデフォルト値がそのまま下窓にルーティングされることを確認する。
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["台詞"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let rows = buffer_rows(&buffer);
        let (opponent_height, _self_height) = canvas_text_rows_split();
        let (top, bottom) = rows.split_at(opponent_height as usize);
        assert!(
            bottom.iter().any(|r| r.contains("台詞")),
            "rows were: {rows:?}"
        );
        assert!(
            !top.iter().any(|r| r.contains("台詞")),
            "rows were: {rows:?}"
        );
    }

    // -- G. 退行防止（過去の事故パターンの固定化） --

    #[test]
    fn dual_window_output_never_contains_border_line_characters() {
        // #480 で Borders::ALL を撤去した（枠なし化）。box-drawing 文字が復活していないことを
        // 固定する退行防止テスト。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["hi"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let text = buffer_text(&buffer);
        for border_char in ['│', '─', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼']
        {
            assert!(
                !text.contains(border_char),
                "border character {border_char:?} must not appear, buffer was: {text}"
            );
        }
    }

    #[test]
    fn draw_with_resolved_image_fade_keeps_480_text_column_start_x_unchanged() {
        // #480の画像/テキスト分割（#488でスペーサーを挟む3分割になった、`split_columns`）が、
        // #481で image_fade に実在パスを渡すようになった後も変わっていないことを確認する。
        // #494以降 draw() は固定キャンバス(CANVAS_W x CANVAS_H)を使うため、
        // `draw_wires_split_columns_text_column_start_x_on_the_fixed_canvas`
        // （あちらは image_fade=None のケース）と同じサイズを流用し、期待値も同じ
        // `canvas_text_column_x_start` から得る。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((10, 20, 30), 2, 2), 2, 2);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );

        let line = dialog_line(Some("A"), vec!["Y"]); // "A" は player_speakers 非該当=opponent(上)
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal),
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let area = buffer.area();
        let mut leftmost_y_x = None;
        'outer: for y in 0..area.height {
            for x in 0..area.width {
                if buffer.cell((x, y)).expect("in bounds").symbol() == "Y" {
                    leftmost_y_x = Some(x);
                    break 'outer;
                }
            }
        }
        let x = leftmost_y_x.expect("text should render somewhere");
        assert_eq!(
            x,
            canvas_text_column_x_start(),
            "text column should still start where split_columns places it with a resolved image_fade present; found at x={x}"
        );
    }

    #[test]
    fn dual_window_output_never_contains_speaker_name_label() {
        // #480 で話者名ラベル行の描画を撤去した。話者識別は窓の位置と文字色のみで行う設計を
        // 固定する退行防止テスト。
        let config = Config::default();
        let line = dialog_line(Some("すぴーかー"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let text = buffer_text(&buffer);
        assert!(
            text.contains("hello"),
            "body text should still render, buffer was: {text}"
        );
        assert!(
            !text.contains("すぴーかー"),
            "speaker name must not appear as a separate label, buffer was: {text}"
        );
    }

    // ---- #488: 画像/テキスト間スペーサーのテスト ----

    #[test]
    fn split_columns_reserves_configured_gap_width() {
        let (_placeholder, gap, _text) = split_columns(Rect::new(0, 0, 100, 20));
        assert_eq!(gap.width, IMAGE_TEXT_GAP_WIDTH);
    }

    #[test]
    fn image_text_gap_column_renders_blank_between_placeholder_and_text() {
        // デフォルト設定は PlaceholderStyle::Label（ラベル文字列を画像列内で中央寄せ）
        // なので、画像列の内容がスペーサー列へはみ出していないことも合わせて確認できる。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["hello"]); // opponent(上)
        let buffer = render(&config, Some(&line), None, CANVAS_W, CANVAS_H);
        let (placeholder_area, gap_area, _text_area) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1)); // root[0].height = CANVAS_H - 1
        let gap_rows = buffer_rows_in_x_range(
            &buffer,
            placeholder_area.width,
            placeholder_area.width + gap_area.width,
        );
        // 最終行(y=10)はステータス行で、config.game_name が長いとその文字列がスペーサー列の
        // x範囲まで届くことがある（本文描画とは無関係な誤検知を避けるため、
        // placeholder_area.height 分＝本文描画領域の高さだけをチェック対象にする。同じ作法は
        // 同ファイル内の player_speaker_leaves_opponent_top_window_completely_blank 等、
        // rows[0..5]/rows[5..10] でステータス行を明示除外している既存テストにも見られる）。
        let body_gap_rows = &gap_rows[..placeholder_area.height as usize];
        assert!(
            body_gap_rows.iter().all(|r| r.trim().is_empty()),
            "the gap column between image and text must stay blank, rows were: {body_gap_rows:?}"
        );
    }

    #[test]
    fn split_columns_at_area_narrower_than_gap_returns_gap_shrunk_to_available_width() {
        // W=1 は IMAGE_TEXT_GAP_WIDTH(2) に満たないため、cassowary ソルバーは
        // Constraint::Length を area 幅いっぱいまで縮めて確保する（画像/テキストは0幅）。
        let (img, gap, text) = split_columns(Rect::new(0, 0, 1, 10));
        assert_eq!(gap.width, 1, "利用可能な幅(1)までgapが縮むはず");
        assert_eq!(img.width, 0);
        assert_eq!(text.width, 0);
    }

    #[test]
    fn split_columns_at_area_exactly_gap_width_leaves_zero_width_image_and_text() {
        // W=IMAGE_TEXT_GAP_WIDTH ちょうどでは、gapのConstraint::Lengthだけが満たされ
        // 画像/テキストのConstraint::Percentage(50)には残余が無い。
        let (img, gap, text) = split_columns(Rect::new(0, 0, IMAGE_TEXT_GAP_WIDTH, 10));
        assert_eq!(gap.width, IMAGE_TEXT_GAP_WIDTH);
        assert_eq!(img.width, 0);
        assert_eq!(text.width, 0);
    }

    #[test]
    fn split_columns_at_area_one_cell_over_gap_width_gives_extra_cell_to_image_not_text() {
        // W=IMAGE_TEXT_GAP_WIDTH+1 になって初めて1セルの余剰が生まれるが、それはtextでは
        // なくimg側（先頭のConstraint::Percentage）に付く。これはW=3〜4という狭い幅域限定で
        // img側が優先される現象（#480由来の既存丸め規約の再現）を固定する回帰テストであり、
        // `split_columns` 全体の一般的な傾向ではない — W=9以降のsteady stateでは逆にtext側が
        // 恒常的に有利になる
        // （`split_columns_at_wide_area_gives_text_two_more_cells_than_image_steady_state`
        // 参照）。
        let (img, gap, text) = split_columns(Rect::new(0, 0, IMAGE_TEXT_GAP_WIDTH + 1, 10));
        assert_eq!(img.width, 1, "剰余の1セルはimg側に付くはず");
        assert_eq!(gap.width, IMAGE_TEXT_GAP_WIDTH);
        assert_eq!(text.width, 0);
    }

    #[test]
    fn split_columns_at_wide_area_gives_text_two_more_cells_than_image_steady_state() {
        // W=9以降は img/text の差が最大2セルにとどまりつつtext側が恒常的に有利になる
        // steady stateに入る（W=3〜4の狭い幅域だけがimg優先になる例外区間で、それは上記
        // `split_columns_at_area_one_cell_over_gap_width_gives_extra_cell_to_image_not_text`
        // が固定している）。このsteady state自体を検知するテストが無かったため追加する
        // （W=20はimg=8/gap=2/text=10で差がちょうど2になる実測値、cargo testで確認済み）。
        let (img, gap, text) = split_columns(Rect::new(0, 0, 20, 10));
        assert_eq!(gap.width, IMAGE_TEXT_GAP_WIDTH);
        assert_eq!(
            text.width,
            img.width + 2,
            "steady stateではtext側がimg側より2セル多いはず: img={}, text={}",
            img.width,
            text.width
        );
    }

    #[test]
    fn split_columns_areas_are_contiguous_and_never_exceed_input_width() {
        // 個別幅の期待値ではなく、あらゆる入力幅で崩れてはいけない構造的な不変条件を
        // プロパティテストとして固定する: 3列は隙間なく連続し、合計は入力幅を超えず、
        // gapはIMAGE_TEXT_GAP_WIDTHを超えて広がらない。
        for w in 0..=30u16 {
            let area = Rect::new(0, 0, w, 10);
            let (img, gap, text) = split_columns(area);
            assert_eq!(
                img.x + img.width,
                gap.x,
                "W={w}: imgとgapの間に隙間や重なりがあってはいけない"
            );
            assert_eq!(
                gap.x + gap.width,
                text.x,
                "W={w}: gapとtextの間に隙間や重なりがあってはいけない"
            );
            assert!(
                img.width + gap.width + text.width <= area.width,
                "W={w}: 合計幅が入力幅を超えている"
            );
            assert!(
                gap.width <= IMAGE_TEXT_GAP_WIDTH,
                "W={w}: gapが設定値を超えて広がっている"
            );
        }
    }

    // ---- #482: 選択肢UI（キーボードカーソル）のテスト ----

    fn choice_option(text: &str, jump: &str) -> ChoiceOption {
        ChoiceOption {
            text: text.to_string(),
            jump: jump.to_string(),
            condition: None,
        }
    }

    #[test]
    fn choice_list_renders_all_option_texts_in_right_column() {
        let config = Config::default();
        let options = vec![
            choice_option("はい", "a"),
            choice_option("いいえ", "b"),
            choice_option("わからない", "c"),
        ];
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 0, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("はい"), "buffer was: {text}");
        assert!(text.contains("いいえ"), "buffer was: {text}");
        assert!(text.contains("わからない"), "buffer was: {text}");
    }

    #[test]
    fn choice_list_marks_only_the_cursor_row_with_reverse_style() {
        let config = Config::default();
        let options = vec![choice_option("A", "a"), choice_option("B", "b")];
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // カーソルは index 1 ("B") を指している。
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 1, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        // 'A'/'B' の実描画セル座標を探す（左半分はプレースホルダ列なので x=0 決め打ちは誤り。
        // 選択肢は右半分の列にしかレンダリングされない）。
        let find_cell = |needle: char| -> (u16, u16) {
            let area = buffer.area();
            for y in 0..area.height {
                for x in 0..area.width {
                    if buffer.cell((x, y)).expect("in bounds").symbol() == needle.to_string() {
                        return (x, y);
                    }
                }
            }
            panic!("option {needle:?} should render somewhere, buffer was: {buffer:?}");
        };
        let (ax, ay) = find_cell('A');
        let (bx, by) = find_cell('B');
        let a_reversed = buffer
            .cell((ax, ay))
            .expect("in bounds")
            .modifier
            .contains(Modifier::REVERSED);
        let b_reversed = buffer
            .cell((bx, by))
            .expect("in bounds")
            .modifier
            .contains(Modifier::REVERSED);
        assert!(!a_reversed, "非カーソル行は反転表示されないはず");
        assert!(b_reversed, "カーソル行(index 1)は反転表示されるはず");
    }

    #[test]
    fn choice_list_does_not_panic_at_extremely_narrow_width() {
        let config = Config::default();
        let options = vec![choice_option("選択肢", "a")];
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(1, 3)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 0, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
    }

    #[test]
    fn choice_list_does_not_panic_at_gap_boundary_widths() {
        // #488で追加されたgap分割の境界幅（W=IMAGE_TEXT_GAP_WIDTHちょうど、および+1）でも
        // draw()がpanicしないことを確認する。既存の
        // `choice_list_does_not_panic_at_extremely_narrow_width` はW=1のみをカバーしていた。
        // #494以降これらの幅は fits_required_size を満たさず draw_too_small_message 側の
        // 分岐に入るため、実際に draw_choice_list のgap境界そのものを踏むわけではないが、
        // 「この幅でdraw()がpanicしない」という回帰ガードとしての価値は変わらず残す。
        let config = Config::default();
        let options = vec![choice_option("選択肢", "a")];
        let now = Instant::now();
        for w in [IMAGE_TEXT_GAP_WIDTH, IMAGE_TEXT_GAP_WIDTH + 1] {
            let mut image_cache = ImageCache::new();
            let mut terminal = Terminal::new(TestBackend::new(w, 3)).unwrap();
            terminal
                .draw(|f| {
                    draw(
                        f,
                        &config,
                        None,
                        Some((&options, 0, None)),
                        &[],
                        1,
                        1,
                        false,
                        None,
                        now,
                        now,
                        None,
                        &mut image_cache,
                        false,
                    )
                })
                .unwrap_or_else(|e| panic!("W={w}で描画がpanicした: {e}"));
        }
    }

    #[test]
    fn choice_list_with_many_options_does_not_panic_when_overflowing_area_height() {
        // 選択肢数(50件)がterminalの高さ(8行)を大きく超える。draw_choice_list はスクロールを
        // 実装していないため画面に収まらない分は単に見切れるが、panic しないことを確認する。
        let config = Config::default();
        let options: Vec<ChoiceOption> = (0..50)
            .map(|i| choice_option(&format!("選択肢{i}"), "x"))
            .collect();
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 0, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
    }

    #[test]
    fn choice_list_full_width_long_option_wraps_without_panic_and_keeps_reversed_style_on_wrapped_rows(
    ) {
        // 全角文字を60個連ねた長い選択肢テキストを、右側テキスト列がその全文を1行に
        // 収められない狭い terminal 幅で描画する。折り返し（Wrap）が発生しても panic せず、
        // カーソル行（index 0、REVERSEDスタイル）の折り返し継続行にもスタイルが引き継がれる
        // ことを確認する。
        let config = Config::default();
        let long_text = "あ".repeat(60);
        let options = vec![choice_option(&long_text, "x")];
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 0, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let area = buffer.area();
        let mut rows_with_a = 0;
        for y in 0..area.height {
            let mut row_has_a = false;
            let mut all_reversed = true;
            for x in 0..area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                if cell.symbol() == "あ" {
                    row_has_a = true;
                    if !cell.modifier.contains(Modifier::REVERSED) {
                        all_reversed = false;
                    }
                }
            }
            if row_has_a {
                rows_with_a += 1;
                assert!(
                    all_reversed,
                    "折り返された行もカーソルのREVERSEDスタイルを保つはず (y={y})"
                );
            }
        }
        assert!(
            rows_with_a >= 2,
            "十分に長い全角文字列なので複数行に折り返されるはず（実際は{rows_with_a}行）"
        );
    }

    #[test]
    fn choice_list_wrapped_cursor_symbol_stays_on_same_row_as_option_text() {
        // #576 回帰テスト: 選択肢テキストが折り返される長さのとき、カーソル記号(▶)が
        // 本文とは別の行に単独表示され本文が1行下にずれるバグの回帰ガード。修正前は
        // CHOICE_CURSOR_SYMBOL の半角スペースが ratatui-widgets の WordWrapper の
        // 単語確定点になり、`▶` だけが独立した1行としてフラッシュされていた
        // （NBSP化で `▶`+区切り+本文が1つのwordとして結合され、この回帰は起きないはず）。
        let config = Config::default();
        let long_text = "あ".repeat(60);
        let options = vec![choice_option(&long_text, "x")];
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    Some((&options, 0, None)),
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let area = buffer.area();
        let cursor_row = (0..area.height)
            .find(|&y| {
                (0..area.width).any(|x| buffer.cell((x, y)).expect("in bounds").symbol() == "▶")
            })
            .expect("カーソル記号▶がどこかの行に描画されているはず");
        let cursor_row_has_text = (0..area.width)
            .any(|x| buffer.cell((x, cursor_row)).expect("in bounds").symbol() == "あ");
        assert!(
            cursor_row_has_text,
            "カーソル記号▶と選択肢本文の先頭は同じ行(y={cursor_row})に描画されるはず（#576: \
             別行に単独表示されると本文全体が1行下にずれる）"
        );
    }

    // ---- #508: 選択肢グリッド描画（`draw_choice_grid`/`draw_choice_list`分岐）のテスト ----

    #[test]
    fn draw_choice_grid_does_not_panic_at_extremely_narrow_width_with_many_columns() {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&format!("o{i}"), "x"))
            .collect();
        let mut terminal = Terminal::new(TestBackend::new(1, 3)).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_choice_grid(f, area, &options, 0, 10, &[]);
            })
            .unwrap_or_else(|e| panic!("極端に狭い幅×多列(10)でpanicした: {e}"));
    }

    // ---- #508 バグ修正の回帰テスト: columns の上限クランプが無いとハングする ----

    #[test]
    fn draw_choice_grid_completes_quickly_when_columns_vastly_exceeds_option_count() {
        // レビューで実際にハングを再現した条件そのもの: 選択肢はわずか2件なのに
        // columns=2_000_000（`[選択: 列=200000]` のような巨大値、または実際に確認された
        // 2_000_000）が渡ってくるケース。クランプ無しだと `col_areas` の
        // `Vec<Constraint>; columns` 生成 → ratatui `Layout::split`（cassowary線形制約
        // ソルバー）が2分以上応答を返さずSIGKILLが必要だった。修正後は内部で `total`（2）
        // までクランプされるため、他の（現実的な列数の）draw_choice_gridテストと同程度の
        // 時間で完了するはず。「常識的な範囲での完了」を秒単位のタイムアウトで直接検証する
        // （実際にハングするコードをそのままテストに残さないための実行時間アサーション）。
        let options = vec![choice_option("A", "x"), choice_option("B", "y")];
        let area = Rect::new(0, 0, 40, 3);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();

        let start = std::time::Instant::now();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, 0, 2_000_000, &[]);
            })
            .unwrap_or_else(|e| panic!("巨大なcolumnsでpanicした: {e}"));
        let elapsed = start.elapsed();

        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "columns=2,000,000 でも選択肢数(2)にクランプされ高速に完了するはず（実測: {elapsed:?}）。\
             2秒を超えるならクランプの退行（#508バグの再発）を疑う。"
        );
    }

    #[test]
    fn draw_choice_grid_ragged_last_row_leaves_missing_cells_blank_without_panic() {
        // 8件・columns=3。行優先配置で row0=[0,1,2] row1=[3,4,5] row2=[6,7]
        // （col2欠の端数行）になる。
        let options: Vec<ChoiceOption> = (0..8)
            .map(|i| choice_option(&format!("O{i}"), "x"))
            .collect();
        let area = Rect::new(0, 0, 30, 3);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, 0, 3, &[]);
            })
            .unwrap_or_else(|e| panic!("端数行のあるグリッドでpanicした: {e}"));

        // draw_choice_grid内部と同じLayout計算でrow2・col2のRectを再現し、
        // そこに何も描画されず空白のままであることを確認する（欠けたセルは単に
        // スキップされるだけでpanicはしない、という実装の意図を直接検証する）。
        let buffer = terminal.backend().buffer();
        let row_areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints(vec![Constraint::Length(1); 3])
            .split(area);
        let col_areas = Layout::default()
            .direction(Direction::Horizontal)
            .constraints(vec![Constraint::Ratio(1, 3); 3])
            .split(row_areas[2]);
        let missing_cell = col_areas[2];
        for y in missing_cell.y..missing_cell.y + missing_cell.height {
            for x in missing_cell.x..missing_cell.x + missing_cell.width {
                let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                assert_eq!(
                    symbol, " ",
                    "欠けたセル(row2,col2)は描画されず空白のままのはず (x={x},y={y})"
                );
            }
        }
    }

    #[test]
    fn draw_choice_grid_selected_cursor_cell_uses_reversed_style() {
        // 6件・columns=3ちょうど（端数無し、2行×3列）。カーソルはindex4("E")。
        let letters = ["A", "B", "C", "D", "E", "F"];
        let options: Vec<ChoiceOption> = letters.iter().map(|l| choice_option(l, "x")).collect();
        let area = Rect::new(0, 0, 30, 2);
        let cursor = 4;
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, cursor, 3, &[]);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let find_cell = |needle: char| -> (u16, u16) {
            for y in 0..area.height {
                for x in 0..area.width {
                    if buffer.cell((x, y)).expect("in bounds").symbol() == needle.to_string() {
                        return (x, y);
                    }
                }
            }
            panic!("option {needle:?} should render somewhere, buffer was: {buffer:?}");
        };
        for (i, letter) in letters.iter().enumerate() {
            let ch = letter.chars().next().unwrap();
            let (x, y) = find_cell(ch);
            let reversed = buffer
                .cell((x, y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::REVERSED);
            if i == cursor {
                assert!(
                    reversed,
                    "カーソル位置(index {i}, {letter})は反転表示されるはず"
                );
            } else {
                assert!(
                    !reversed,
                    "非カーソル位置(index {i}, {letter})は反転表示されないはず"
                );
            }
        }
    }

    // #591 テスト観点整理フェーズ 最優先2: grid×lock整合性。過去の事故パターン
    // （グリッドの行×列マッピングとインデックス対応がずれる不具合）が locked 配列でも
    // 再発していないかを狙い撃ちする。10択・columns=5・locked を市松(交互)パターンで渡し、
    // 各セルのDIMスタイル・🔒サフィックスがlocked配列と同じインデックスの選択肢に
    // 対応することを、行×列から独立に再計算したセル領域内で直接確認する（frontendの
    // ChoiceOverlay grid×lock整合性テストと対をなす）。
    #[test]
    fn draw_choice_grid_mixed_locked_pattern_maps_dim_and_lock_marker_to_correct_index_not_shifted()
    {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // 偶数indexはロックなし、奇数indexはロック中（市松パターンで隣接セルとの取り違えも検出できる）。
        let locked: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 2);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, 0, 5, &locked);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // draw_choice_grid内部と同じLayout計算でrow/colのRectを独立に再現する
        // （draw_choice_grid_ragged_last_row_leaves_missing_cells_blank_without_panic と同じ手法）。
        let row_areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints(vec![Constraint::Length(1); 2])
            .split(area);

        for i in 0..10usize {
            let row = i / 5;
            let col = i % 5;
            let col_areas = Layout::default()
                .direction(Direction::Horizontal)
                .constraints(vec![Constraint::Ratio(1, 5); 5])
                .split(row_areas[row]);
            let cell_area = col_areas[col];

            let digit = i.to_string();
            let (digit_x, digit_y) = (cell_area.x..cell_area.x + cell_area.width)
                .zip(std::iter::repeat(cell_area.y))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!("index {i} (\"{digit}\") should render inside its own grid cell, buffer was: {buffer:?}")
                });

            let expected_locked = locked[i];
            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim, expected_locked,
                "index {i} の DIM 状態が locked[{i}]={expected_locked} と一致しない \
                 （行×列マッピングとlocked配列のインデックスずれの検出用）"
            );

            // 🔒はそのセル領域内(同じ行、自セルのx範囲内)だけを見る。行全体を見ると
            // 隣接セル(同じ行の別index)の🔒を誤って拾う恐れがあるため、独立に計算した
            // cell_area の範囲だけに限定してスキャンする。
            let has_lock_marker = (cell_area.x..cell_area.x + cell_area.width)
                .any(|x| buffer.cell((x, cell_area.y)).expect("in bounds").symbol() == "🔒");
            assert_eq!(
                has_lock_marker, expected_locked,
                "index {i} の🔒表示の有無が locked[{i}]={expected_locked} と一致しない \
                 （自セル範囲内だけを見ても対応がずれていないかの確認）"
            );
        }
    }

    #[test]
    fn draw_choice_list_dispatches_to_grid_only_when_columns_at_least_2() {
        // A/Bが同じ行(y)に描画されるかどうかで、グリッド委譲(columns>=2)か
        // 従来の縦一列描画(columns None/0/1)かを見分ける。
        let options = vec![
            choice_option("A", "x"),
            choice_option("B", "x"),
            choice_option("C", "x"),
            choice_option("D", "x"),
        ];
        let area = Rect::new(0, 0, 20, 4);
        for columns in [None, Some(0), Some(1), Some(2)] {
            let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
            terminal
                .draw(|f| {
                    draw_choice_list(f, area, &options, 0, columns, &[]);
                })
                .unwrap();
            let buffer = terminal.backend().buffer();
            let find_y = |needle: char| -> u16 {
                for y in 0..area.height {
                    for x in 0..area.width {
                        if buffer.cell((x, y)).expect("in bounds").symbol() == needle.to_string() {
                            return y;
                        }
                    }
                }
                panic!("option {needle:?} should render somewhere");
            };
            let a_y = find_y('A');
            let b_y = find_y('B');
            let is_grid = a_y == b_y;
            match columns {
                Some(c) if c >= 2 => assert!(
                    is_grid,
                    "columns={columns:?}: draw_choice_gridへ委譲されA/Bが同じ行に並ぶはず"
                ),
                _ => assert!(
                    !is_grid,
                    "columns={columns:?}: 非グリッドなのでA/Bは別々の行のはず"
                ),
            }
            // #576 セルフレビュー: グリッド/リスト両モードで、カーソル(index0='A')の位置に
            // 記号▶が実際に描画されていることそのものを検証する（同じ行に来るかどうかの
            // モード判定だけでは、▶自体が欠落・別位置に化けていても検出できないため）。
            let cursor_y = (0..area.height)
                .find(|&y| {
                    (0..area.width).any(|x| buffer.cell((x, y)).expect("in bounds").symbol() == "▶")
                })
                .unwrap_or_else(|| {
                    panic!("columns={columns:?}: カーソル記号▶がどこにも描画されていない")
                });
            assert_eq!(
                cursor_y, a_y,
                "columns={columns:?}: カーソル記号▶はカーソル選択肢('A')と同じ行にあるはず"
            );
        }
    }

    // ---- #576 追加: CHOICE_CURSOR_SYMBOL NBSP化のテスト観点(境界値・混在ケース) ----

    #[test]
    fn choice_list_wrapped_option_reaches_wrap_boundary_exactly_stays_single_line() {
        // デシジョンテーブルの3点セット（境界-1・境界・境界+1）のうち境界-1と境界の2点。
        // 境界+1は `choice_list_wrapped_option_one_char_past_boundary_wraps_with_cursor_glued`
        // で別途検証する。Rect幅=10セル固定、prefix(CHOICE_CURSOR_SYMBOL)の実測セル幅を
        // 引いたコンテンツ予算ちょうど・予算-1のどちらでも、折り返しが起きず単一行のまま
        // 収まることを確認する。
        let area_width = 10u16;
        let prefix_width = CHOICE_CURSOR_SYMBOL.cell_width();
        // 設計案の数値をそのまま信じず、実装のprefix幅を検算してから固定する
        // （▶ 1セル + NBSP 1セル = 2セルのはず、CHOICE_CURSOR_PADDINGのdocコメント参照）。
        assert_eq!(
            prefix_width, 2,
            "境界値テストはprefix幅2セルを前提に文字数を決めている。\
             CHOICE_CURSOR_SYMBOLの実際の幅が変わったらこのテストの数値も見直しが必要"
        );
        let content_budget = area_width - prefix_width;
        for content_len in [content_budget - 1, content_budget] {
            let text = "x".repeat(content_len as usize);
            let options = vec![choice_option(&text, "j")];
            let area = Rect::new(0, 0, area_width, 4);
            let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
            terminal
                .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
                .unwrap_or_else(|e| panic!("content_len={content_len}でpanicした: {e}"));
            let buffer = terminal.backend().buffer();
            let rows_with_content: Vec<u16> = (0..area.height)
                .filter(|&y| {
                    (0..area.width).any(|x| {
                        let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                        symbol == "▶" || symbol == "x"
                    })
                })
                .collect();
            assert_eq!(
                rows_with_content.len(),
                1,
                "content_len={content_len}(予算={content_budget})では折り返しが発生せず単一行に\
                 収まるはず（実際に使われた行: {rows_with_content:?}）"
            );
        }
    }

    #[test]
    fn choice_list_wrapped_option_one_char_past_boundary_wraps_with_cursor_glued() {
        // デシジョンテーブルの3点セットの境界+1。予算をちょうど1文字はみ出すと折り返しが
        // 発生し、`▶`+NBSP+先頭のコンテンツ予算ぶんの文字が1行目に、はみ出した残り1文字が
        // 2行目に来ることを確認する（#576のNBSP化修正がまさに守っている挙動）。
        let area_width = 10u16;
        let prefix_width = CHOICE_CURSOR_SYMBOL.cell_width();
        let content_budget = area_width - prefix_width;
        let content_len = content_budget + 1;
        let text = "x".repeat(content_len as usize);
        let options = vec![choice_option(&text, "j")];
        let area = Rect::new(0, 0, area_width, 4);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let count_x_in_row = |y: u16| -> usize {
            (0..area.width)
                .filter(|&x| buffer.cell((x, y)).expect("in bounds").symbol() == "x")
                .count()
        };
        let has_cursor_in_row = |y: u16| -> bool {
            (0..area.width).any(|x| buffer.cell((x, y)).expect("in bounds").symbol() == "▶")
        };
        let cursor_row = (0..area.height)
            .find(|&y| has_cursor_in_row(y))
            .expect("カーソル記号▶がどこかの行にあるはず");
        assert_eq!(
            count_x_in_row(cursor_row),
            content_budget as usize,
            "1行目はカーソル記号に予算ぶんの文字が続いて1行に収まるはず"
        );
        let next_row = cursor_row + 1;
        assert!(
            !has_cursor_in_row(next_row),
            "2行目にカーソル記号が単独で来てはいけない（#576の元バグそのもの）"
        );
        assert_eq!(
            count_x_in_row(next_row),
            1,
            "はみ出した残り1文字は2行目に来るはず"
        );
    }

    #[test]
    fn render_wrapped_paragraph_skips_drawing_below_min_safe_width_even_with_long_wrapping_choice_text(
    ) {
        // MIN_SAFE_TEXT_WRAP_WIDTH(3)の境界-1(幅2セル)。ratatuiのWrap panicバグ
        // （render_wrapped_paragraphのdocコメント参照）を踏む危険な幅では、選択肢テキストが
        // 長く折り返しを要求してもpanicせず、単純に描画自体をスキップすることを確認する。
        let area = Rect::new(0, 0, MIN_SAFE_TEXT_WRAP_WIDTH - 1, 6);
        let long_text = "あ".repeat(20);
        let options = vec![choice_option(&long_text, "j")];
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
            .unwrap_or_else(|e| panic!("MIN_SAFE_TEXT_WRAP_WIDTH-1でpanicした: {e}"));
        let text = buffer_text(terminal.backend().buffer());
        assert_eq!(
            text.trim(),
            "",
            "幅がMIN_SAFE_TEXT_WRAP_WIDTH未満のときは描画自体をスキップするはず、buffer was: {text}"
        );
    }

    #[test]
    fn choice_list_long_wrapping_text_does_not_panic_and_keeps_cursor_glued_at_min_safe_wrap_width()
    {
        // MIN_SAFE_TEXT_WRAP_WIDTH(3)ちょうどの境界。この幅では描画がスキップされず(Dの
        // ケースと対照)、かつratatuiのWrap panicバグも踏まないことを確認する。長い選択肢
        // テキストが1文字ずつ折り返される極端な幅でも、`▶`が単独行化せず先頭文字と同じ行に
        // 来ることを確認する（#576の回帰ガードをこの境界幅でも取る）。
        let area = Rect::new(0, 0, MIN_SAFE_TEXT_WRAP_WIDTH, 10);
        let text = "abcdefghij".to_string();
        let options = vec![choice_option(&text, "j")];
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
            .unwrap_or_else(|e| panic!("MIN_SAFE_TEXT_WRAP_WIDTHでpanicした: {e}"));
        let buffer = terminal.backend().buffer();
        let cursor_row = (0..area.height)
            .find(|&y| {
                (0..area.width).any(|x| buffer.cell((x, y)).expect("in bounds").symbol() == "▶")
            })
            .expect("カーソル記号▶がどこかの行にあるはず");
        let cursor_row_has_first_char = (0..area.width)
            .any(|x| buffer.cell((x, cursor_row)).expect("in bounds").symbol() == "a");
        assert!(
            cursor_row_has_first_char,
            "極小幅でもカーソル記号と本文の先頭文字は同じ行(y={cursor_row})に描画されるはず"
        );
    }

    #[test]
    fn choice_list_non_cursor_wrapped_option_continuation_rows_are_not_reversed_and_neighboring_cursor_option_unaffected(
    ) {
        // デシジョンテーブルのセル4: カーソルは短い選択肢(index0)にあり、隣の選択肢
        // (index1)は長くて折り返す・かつカーソルではない、という組み合わせ。折り返した
        // 非カーソル選択肢の継続行にREVERSEDスタイルが漏れ伝播しないこと、かつ短い
        // カーソル選択肢側の表示がそれに引きずられないことを確認する。
        let area = Rect::new(0, 0, 20, 12);
        let long_text = "あ".repeat(40);
        let options = vec![choice_option("A", "x"), choice_option(&long_text, "y")];
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
            .unwrap();
        let buffer = terminal.backend().buffer();

        let mut a_found = false;
        for y in 0..area.height {
            for x in 0..area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                match cell.symbol() {
                    "A" => {
                        a_found = true;
                        assert!(
                            cell.modifier.contains(Modifier::REVERSED),
                            "カーソル位置の短い選択肢Aは反転表示されるはず"
                        );
                    }
                    "あ" => {
                        assert!(
                            !cell.modifier.contains(Modifier::REVERSED),
                            "非カーソルの折り返し選択肢の継続行にREVERSEDが漏れてはいけない \
                             (x={x},y={y})"
                        );
                    }
                    _ => {}
                }
            }
        }
        assert!(a_found, "カーソル選択肢Aがどこかに描画されているはず");
    }

    #[test]
    fn choice_list_empty_option_text_renders_cursor_symbol_alone_without_panic() {
        // 選択肢テキストが空文字列でも、CHOICE_CURSOR_SYMBOL単体の描画でpanicしないことを
        // 確認する（本文が無いのでNBSP以降に結合する文字が無い極端なケース）。
        let options = vec![choice_option("", "j")];
        let area = Rect::new(0, 0, 20, 4);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
            .unwrap_or_else(|e| panic!("空選択肢テキストでpanicした: {e}"));
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains('▶'),
            "空選択肢テキストでもカーソル記号▶は描画されるはず、buffer was: {text}"
        );
    }

    #[test]
    fn choice_cursor_symbol_and_padding_have_equal_cell_width() {
        // CHOICE_CURSOR_PADDINGはCHOICE_CURSOR_SYMBOLと同じ表示幅を保つためのパディングで
        // ある、という構造的不変条件そのものを検証する。片方だけを変更してもう片方を
        // 更新し忘れると、カーソル行と非カーソル行で本文の開始列がずれる。
        assert_eq!(
            CHOICE_CURSOR_SYMBOL.cell_width(),
            CHOICE_CURSOR_PADDING.cell_width(),
            "CHOICE_CURSOR_SYMBOLとCHOICE_CURSOR_PADDINGは常に同じセル幅であるべき"
        );
    }

    #[test]
    fn cell_width_treats_nbsp_as_single_cell() {
        // NBSP(U+00A0)のcell_width()が1であることを固定する。CHOICE_CURSOR_SYMBOLの幅計算
        // （▶1セル+NBSP1セル=計2セル、CHOICE_CURSOR_PADDINGとの整合）はこの前提に依存
        // している。ただしこれは`unicode-width`ベースの論理的なセル幅の保証であり、実端末・
        // 実フォントでNBSPが実際に半角1文字ぶんの幅でグリフ描画される（あるいは見た目上
        // 何らかの空白として表示される）ことまでは保証しない。
        assert_eq!("\u{a0}".cell_width(), 1);
    }

    #[test]
    fn choice_list_mixed_width_option_text_with_emoji_wraps_without_panic() {
        // 半角(ASCII)+全角(かな)+絵文字が混在するテキストで折り返しが発生してもpanicせず、
        // カーソル記号が本文冒頭と同じ行に来ることを確認する。
        let unit = "abcあいう😀";
        let text = unit.repeat(6);
        let options = vec![choice_option(&text, "j")];
        let area = Rect::new(0, 0, 16, 12);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[]))
            .unwrap_or_else(|e| panic!("半角+全角+絵文字混在テキストでpanicした: {e}"));
        let buffer = terminal.backend().buffer();
        let cursor_row = (0..area.height)
            .find(|&y| {
                (0..area.width).any(|x| buffer.cell((x, y)).expect("in bounds").symbol() == "▶")
            })
            .expect("カーソル記号▶がどこかの行にあるはず");
        let cursor_row_has_first_char = (0..area.width)
            .any(|x| buffer.cell((x, cursor_row)).expect("in bounds").symbol() == "a");
        assert!(
            cursor_row_has_first_char,
            "混在テキストでもカーソル記号と本文冒頭は同じ行(y={cursor_row})に描画されるはず"
        );
    }

    // -- D. page_indicator_area 単体テスト（#487） --
    //
    // `draw_page_indicator` から抽出した純粋関数（Frame不要）の境界値テスト。
    // `PAGE_INDICATOR_INSET_COLS`/`PAGE_INDICATOR_INSET_ROWS` を直値で書き写さず、
    // 定数からの相対値・関数呼び出しの戻り値から期待値を導出する
    // （docs/operations/doctrine/name-name/guidelines/README.md の
    // 「テストの期待値に定数の計算結果を直書きしない」規約）。

    /// x軸の境界値テスト共通の高さ。`PAGE_INDICATOR_INSET_ROWS` の境界から十分離しておき、
    /// y側のクランプが混ざってx側の判定を汚染しないようにする。
    fn safe_height_above_row_inset() -> u16 {
        PAGE_INDICATOR_INSET_ROWS + 50
    }

    /// y軸の境界値テスト共通の幅。上記の列版。
    fn safe_width_above_col_inset() -> u16 {
        PAGE_INDICATOR_INSET_COLS + 50
    }

    #[test]
    fn page_indicator_area_clamps_x_when_width_below_inset() {
        // width = inset - 1: saturating_sub は 0 未満へ潜らずクランプするため、
        // インジケータは area の左上角(x=area.x)まで寄る。
        let width = PAGE_INDICATOR_INSET_COLS - 1;
        let area = Rect {
            x: 0,
            y: 0,
            width,
            height: safe_height_above_row_inset(),
        };
        let result = page_indicator_area(area);
        assert_eq!(
            result.x, area.x,
            "width(inset-1) should clamp x to area.x, got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_clamps_x_when_width_equals_inset() {
        // width == inset: saturating_sub が自然に 0 になる境界（クランプ分岐と結果は
        // 上のテストと同じだが、算術的な経路が異なるため明示的に区別する）。
        let width = PAGE_INDICATOR_INSET_COLS;
        let area = Rect {
            x: 0,
            y: 0,
            width,
            height: safe_height_above_row_inset(),
        };
        let result = page_indicator_area(area);
        assert_eq!(
            result.x, area.x,
            "width == inset should still clamp x to area.x, got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_offsets_x_when_width_above_inset() {
        // width = inset + 1: クランプが外れ、x は area.x から (width - inset) だけ
        // 内側に入る（実装の `area.width.saturating_sub(INSET)` と同じ式で期待値を導出）。
        let width = PAGE_INDICATOR_INSET_COLS + 1;
        let area = Rect {
            x: 0,
            y: 0,
            width,
            height: safe_height_above_row_inset(),
        };
        let result = page_indicator_area(area);
        assert_eq!(
            result.x,
            area.x + (width - PAGE_INDICATOR_INSET_COLS),
            "width(inset+1) should offset x by (width - inset), got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_clamps_y_when_height_below_inset() {
        let height = PAGE_INDICATOR_INSET_ROWS - 1;
        let area = Rect {
            x: 0,
            y: 0,
            width: safe_width_above_col_inset(),
            height,
        };
        let result = page_indicator_area(area);
        assert_eq!(
            result.y, area.y,
            "height(inset-1) should clamp y to area.y, got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_clamps_y_when_height_equals_inset() {
        let height = PAGE_INDICATOR_INSET_ROWS;
        let area = Rect {
            x: 0,
            y: 0,
            width: safe_width_above_col_inset(),
            height,
        };
        let result = page_indicator_area(area);
        assert_eq!(
            result.y, area.y,
            "height == inset should still clamp y to area.y, got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_offsets_y_when_height_above_inset() {
        let height = PAGE_INDICATOR_INSET_ROWS + 1;
        let area = Rect {
            x: 0,
            y: 0,
            width: safe_width_above_col_inset(),
            height,
        };
        let result = page_indicator_area(area);
        assert_eq!(
            result.y,
            area.y + (height - PAGE_INDICATOR_INSET_ROWS),
            "height(inset+1) should offset y by (height - inset), got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_returns_1x1_rect_regardless_of_area_size() {
        // 大きな area でも、インジケータのセル自体は常に 1x1（1文字幅の記号を1セルに描く）。
        let area = Rect {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        };
        let result = page_indicator_area(area);
        assert_eq!(
            (result.width, result.height),
            (1, 1),
            "indicator rect must always be 1x1 regardless of area size, got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_at_zero_sized_area_does_not_panic_and_pins_to_origin() {
        // area.width==0 && area.height==0 は draw_text_windows 側で target_area として
        // そのまま渡り得る極小端末のケース。saturating_sub のおかげでオーバーフローせず、
        // area の原点にピン留めされる。
        let area = Rect {
            x: 5,
            y: 7,
            width: 0,
            height: 0,
        };
        let result = page_indicator_area(area);
        assert_eq!(
            (result.x, result.y),
            (area.x, area.y),
            "zero-sized area should pin the indicator to its own origin, got {result:?}"
        );
    }

    #[test]
    fn page_indicator_area_respects_nonzero_area_origin() {
        // self_area は y=0 始まりとは限らない（opponent_area の下に続く）。原点をずらしても
        // 「area の右下から一定オフセット」という相対関係そのものは変わらないことを、
        // 原点0のareaとの差分比較で確認する（絶対座標を直書きしない回帰防止）。
        let width = safe_width_above_col_inset();
        let height = safe_height_above_row_inset();
        let origin_area = Rect {
            x: 0,
            y: 0,
            width,
            height,
        };
        let shifted_area = Rect {
            x: 37,
            y: 19,
            width,
            height,
        };
        let origin_result = page_indicator_area(origin_area);
        let shifted_result = page_indicator_area(shifted_area);
        assert_eq!(
            shifted_result.x - shifted_area.x,
            origin_result.x - origin_area.x,
            "x offset from area origin should be identical regardless of area.x, \
             origin={origin_result:?} shifted={shifted_result:?}"
        );
        assert_eq!(
            shifted_result.y - shifted_area.y,
            origin_result.y - origin_area.y,
            "y offset from area origin should be identical regardless of area.y, \
             origin={origin_result:?} shifted={shifted_result:?}"
        );
    }

    // -- E. draw_page_indicator / draw_text_windows 経由テスト（#487、Terminal+Frame必要） --

    #[test]
    fn draw_page_indicator_skipped_when_target_area_width_zero() {
        // w=1 端末では columns[1](テキスト側カラム)の幅がPercentage(50/50)分割で0になる
        // （opponent/self とも幅0）。この場合 draw_page_indicator の `area.width == 0` ガードで
        // 描画自体がスキップされ、PAGE_INDICATOR_SYMBOL がバッファに一切出現しない。
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hi"]); // player_speakers非該当=opponent側
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), 1, 10);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must not render when the target window has zero width, buffer was: {text}"
        );
    }

    #[test]
    fn draw_page_indicator_skipped_when_target_area_width_below_min_safe_wrap() {
        // w=4 端末では columns[1](テキスト側カラム)の幅がPercentage(50/50)分割で2になる
        // （ceilを取る左=columns[0]が2、floorを取る右=columns[1]が2 — w=4は偶数なので両方2。
        // opponent/self とも幅2を引き継ぐ）。これは0ではないが MIN_SAFE_TEXT_WRAP_WIDTH(3)
        // 未満であり、本文側の render_wrapped_paragraph は既にこの幅で描画をスキップする
        // （セルフレビューで実測された「幅4端末で▼が浮く」ケース）。draw_page_indicator も
        // 同じ閾値でスキップし、本文が消えているのにインジケータだけ空白領域に残る表示不整合
        // が起きないことを確認する。
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hi"]); // player_speakers非該当=opponent側
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), 4, 10);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must not render when the target window width is below \
             MIN_SAFE_TEXT_WRAP_WIDTH, buffer was: {text}"
        );
    }

    #[test]
    fn draw_page_indicator_skipped_when_target_area_height_zero() {
        // w=40,h=2 端末では root/status行分離後の残り高さが1セルになり、テキスト側の
        // opponent/self 上下分割 (height/2切り捨て・余り) で opponent 側が高さ0になる
        // （既存の draw_does_not_panic_at_height_one と同系統のセットアップ、症状として
        // 「描画有無」を見る点が異なる）。draw_page_indicator の `area.height == 0` ガードで
        // スキップされ、PAGE_INDICATOR_SYMBOL が出現しないことを確認する。
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hi"]); // player_speakers非該当=opponent側
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), 40, 2);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must not render when the target window has zero height, buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_shown_in_self_window_when_speaker_is_player() {
        // 既存の page_indicator_is_fixed_at_window_bottom_right_not_attached_to_body_text は
        // opponent側(話者がplayer_speakers非該当)のみを検証しており、self側の分岐
        // （draw_text_windows の is_self_speaker == true → target_area = self_area）は
        // 未カバーだった。self側でも同じ右下固定ロジックが適用されることを確認する。
        let config = Config {
            player_speakers: vec!["Player".to_string()],
            ..Config::default()
        };
        let line = dialog_line(Some("Player"), vec!["first line", "second line"]);
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);

        // #494: 端末サイズは固定キャンバス(CANVAS_W x CANVAS_H)ちょうどなので、テキスト列の
        // Rectはsplit_columnsから、上下分割の高さはcanvas_text_rows_splitから、それぞれ
        // 導出する（手計算した固定値をテストに直書きしない）。
        let (_placeholder, _gap, text_area) =
            split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        let (opponent_height, self_height) = canvas_text_rows_split();
        let self_area = Rect {
            x: text_area.x,
            y: opponent_height,
            width: text_area.width,
            height: self_height,
        };
        let indicator_cell = page_indicator_area(self_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        assert_eq!(
            cell.symbol(),
            reveal::PAGE_INDICATOR_SYMBOL,
            "indicator should render at the self window's fixed bottom-right cell"
        );
    }

    // ---- #495: ページ送りインジケータの色・点滅仕様 ----
    //
    // GUI版 `frontend/src/game/DialogBox.ts` の DUAL_WINDOW_SELF_INDICATOR_COLOR(白)/
    // DUAL_WINDOW_OPPONENT_INDICATOR_COLOR(水色) と INDICATOR_BLINK_MS(1000ms、完全on/off)
    // に TUI 側を揃えたことを、draw() を通したレンダリング結果で確認する
    // （reveal::blink_visible 自体の境界値テストは reveal.rs 側にある）。

    /// `width`x`height` 端末での opponent(上)/self(下) ウィンドウの Rect を、ハードコードせず
    /// `draw_text_windows` と同じ計算（`split_columns` → 上下 Length 分割）で導出する。
    fn text_sub_areas(width: u16, height: u16) -> (Rect, Rect) {
        let (_placeholder, _gap, text_area) = split_columns(Rect::new(0, 0, width, height - 1));
        let opponent_height = text_area.height / 2;
        let self_height = text_area.height - opponent_height;
        let opponent_area = Rect {
            x: text_area.x,
            y: text_area.y,
            width: text_area.width,
            height: opponent_height,
        };
        let self_area = Rect {
            x: text_area.x,
            y: text_area.y + opponent_height,
            width: text_area.width,
            height: self_height,
        };
        (opponent_area, self_area)
    }

    #[test]
    fn page_indicator_uses_configured_player_color_in_self_window() {
        let mut config = Config::default();
        config.colors.player = "yellow".to_string();
        // "主格" は Config::default() の player_speakers に含まれる → self(下)窓。
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);

        let (_opponent_area, self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let indicator_cell = page_indicator_area(self_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        assert_eq!(cell.symbol(), reveal::PAGE_INDICATOR_SYMBOL);
        assert_eq!(
            cell.fg,
            Color::Yellow,
            "self window's indicator should use config.colors.player, not a hardcoded jiwa color"
        );
    }

    #[test]
    fn page_indicator_uses_configured_opponent_color_in_opponent_window() {
        let mut config = Config::default();
        config.colors.opponent = "magenta".to_string();
        // "相手" は player_speakers ("主格") に含まれない → opponent(上)窓。
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);

        let (opponent_area, _self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let indicator_cell = page_indicator_area(opponent_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        assert_eq!(cell.symbol(), reveal::PAGE_INDICATOR_SYMBOL);
        assert_eq!(
            cell.fg,
            Color::Magenta,
            "opponent window's indicator should use config.colors.opponent, not a hardcoded jiwa color"
        );
    }

    #[test]
    fn page_indicator_self_and_opponent_use_different_default_colors() {
        // GUI版の白(self)/水色(opponent, #9ad4e8)という「2つの窓が別の固定色を持つ」性質そのものを、
        // デフォルト設定（colors.player="white"/colors.opponent="#9ad4e8"）で確認する。
        let config = Config::default();

        let self_line = dialog_line(Some("主格"), vec!["hello"]);
        let self_reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &self_line));
        let self_buffer = render(
            &config,
            Some(&self_line),
            Some(&self_reveal),
            CANVAS_W,
            CANVAS_H,
        );
        let (_opponent_area, self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let self_indicator_cell = page_indicator_area(self_area);
        let self_cell = self_buffer
            .cell((self_indicator_cell.x, self_indicator_cell.y))
            .expect("in bounds");

        let opponent_line = dialog_line(Some("相手"), vec!["hello"]);
        let opponent_reveal =
            reveal::RevealState::Done(reveal::skip_lines(&config, &opponent_line));
        let opponent_buffer = render(
            &config,
            Some(&opponent_line),
            Some(&opponent_reveal),
            CANVAS_W,
            CANVAS_H,
        );
        let (opponent_area, _self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let opponent_indicator_cell = page_indicator_area(opponent_area);
        let opponent_cell = opponent_buffer
            .cell((opponent_indicator_cell.x, opponent_indicator_cell.y))
            .expect("in bounds");

        let expected_opponent_color =
            Color::from_str(&config.colors.opponent).expect("default opponent color must parse");
        assert_eq!(self_cell.fg, Color::White);
        assert_eq!(opponent_cell.fg, expected_opponent_color);
        assert_ne!(
            self_cell.fg, opponent_cell.fg,
            "self/opponent windows must use distinct fixed colors, matching GUI's dual-window design"
        );
    }

    #[test]
    fn page_indicator_falls_back_to_white_when_configured_player_color_is_invalid() {
        // `draw_splash_invalid_color_name_falls_back_to_white_without_panic` と同じパターンを
        // indicator向けに複製する（観点3）。self側(下窓)のindicatorは config.colors.player を
        // 使うため、無効な色名を入れても panic せず Color::White にフォールバックすることを
        // 確認する。
        let mut config = Config::default();
        config.colors.player = "not-a-real-color".to_string();
        let line = dialog_line(Some("主格"), vec!["hello"]); // self(下)窓
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);

        let (_opponent_area, self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let indicator_cell = page_indicator_area(self_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        assert_eq!(cell.symbol(), reveal::PAGE_INDICATOR_SYMBOL);
        assert_eq!(
            cell.fg,
            Color::White,
            "an unparseable colors.player name must fall back to White instead of panicking"
        );
    }

    #[test]
    fn page_indicator_falls_back_to_white_when_configured_opponent_color_is_invalid() {
        // 上と同じフォールバックパターンを opponent側(上窓)の config.colors.opponent 向けに
        // 複製する（観点3）。
        let mut config = Config::default();
        config.colors.opponent = "not-a-real-color".to_string();
        let line = dialog_line(Some("相手"), vec!["hello"]); // opponent(上)窓
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);

        let (opponent_area, _self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let indicator_cell = page_indicator_area(opponent_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        assert_eq!(cell.symbol(), reveal::PAGE_INDICATOR_SYMBOL);
        assert_eq!(
            cell.fg,
            Color::White,
            "an unparseable colors.opponent name must fall back to White instead of panicking"
        );
    }

    #[test]
    fn page_indicator_uses_opponent_color_for_narration_with_no_speaker() {
        // Narration（speaker: None）は `is_self_speaker` 判定（`Option::is_some_and`）が None
        // に対し false を返すため常に opponent側(上窓)に倒れる（`draw_text_windows` ドキュメント
        // 「話者不明を相手側に倒す」規則）。本文色は colors.narration（既定 gray）を使うが、
        // indicator は本文色と独立に「自分/相手」の2択で決まるため、Narration でも
        // colors.opponent を使い、colors.narration とは異なる色になることを固定する（観点4）。
        let config = Config::default();
        let line = dialog_line(None, vec!["hello"]); // Narration
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), CANVAS_W, CANVAS_H);

        let (opponent_area, _self_area) = text_sub_areas(CANVAS_W, CANVAS_H);
        let indicator_cell = page_indicator_area(opponent_area);
        let cell = buffer
            .cell((indicator_cell.x, indicator_cell.y))
            .expect("in bounds");
        let expected_opponent_color =
            Color::from_str(&config.colors.opponent).expect("default opponent color must parse");
        assert_eq!(cell.symbol(), reveal::PAGE_INDICATOR_SYMBOL);
        assert_eq!(
            cell.fg, expected_opponent_color,
            "narration (speaker: None) indicator should use config.colors.opponent, not colors.narration"
        );
        assert_ne!(
            cell.fg,
            Color::from_str(&config.colors.narration).expect("default narration color must parse"),
            "indicator must not reuse the narration body color"
        );
    }

    #[test]
    fn page_indicator_blinks_off_one_full_period_after_it_started() {
        // 完全on/off点滅（jiwaの連続色補間ではない）を draw() 経由で確認する。1周期
        // (PAGE_INDICATOR_BLINK_PERIOD_MS)ちょうど経過した時点は reveal::blink_visible の
        // 境界テストで確認済みの「非表示区間の開始」— そのまま draw() を通しても
        // インジケータのグリフが一切出現しないことを固定する。
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let started_at = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let now =
            started_at + std::time::Duration::from_millis(reveal::PAGE_INDICATOR_BLINK_PERIOD_MS);
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal),
                    started_at,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            !text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must fully disappear (not fade) during the off phase, buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_blinks_off_one_full_period_after_it_started_in_opponent_window() {
        // 既存の `page_indicator_blinks_off_one_full_period_after_it_started` は self側(下窓)
        // のみを確認していた。opponent側(上窓)でも同じ非表示区間で draw() 経由のグリフが
        // 一切出現しないことを固定する（観点2）。
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hello"]); // player_speakers非該当=opponent側
        let started_at = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let now =
            started_at + std::time::Duration::from_millis(reveal::PAGE_INDICATOR_BLINK_PERIOD_MS);
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal),
                    started_at,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            !text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "opponent window's indicator must fully disappear during the off phase too, buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_blinks_back_on_after_two_full_periods() {
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let started_at = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let now = started_at
            + std::time::Duration::from_millis(reveal::PAGE_INDICATOR_BLINK_PERIOD_MS * 2 + 1);
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal),
                    started_at,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must return to fully visible in its next on-phase, buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_absent_while_reveal_is_animating_not_done() {
        // RevealState::Animating が未完了（is_done(now)==false）の間は draw_text_windows が
        // show_page_indicator=false のまま draw_page_indicator を一切呼ばない。char_interval を
        // 十分長くして「now時点では確実に未完了」を作る（render() ヘルパーは内部で新しい
        // Instant::now() を取ってしまうため、Animating の時刻依存テストではこのテストの
        // ドキュメントコメントの指針どおり手書きで now を共有する）。
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000;
        config.typewriter.fade_duration_ms = 0;
        let line = dialog_line(Some("A"), vec!["hello"]);
        let now = Instant::now();
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
        assert!(
            !reveal.is_done(now),
            "test precondition: must not be done yet"
        );

        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    now,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            !text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must stay absent while typing is still in progress, buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_appears_at_the_instant_reveal_completes() {
        // 同一の RevealHandle を2つの時刻でスナップショットし、is_done() が false→true に
        // 切り替わる瞬間にインジケータの出現もトグルすることを1テスト内で確認する
        // （ハンドルを2つ作る page_indicator_is_absent_while_typing_and_present_once_done とは
        // 違い、同一ハンドルへの2回の draw で「同じアニメーションの前後」を見る）。
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 100;
        config.typewriter.fade_duration_ms = 0;
        let line = dialog_line(Some("A"), vec!["hi"]); // 2グラフェーム: total_runtime=100ms*1
        let now = Instant::now();
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
        let not_done_at = now;
        let done_at = now + std::time::Duration::from_millis(150);
        assert!(
            !reveal.is_done(not_done_at),
            "test precondition: not yet done"
        );
        assert!(reveal.is_done(done_at), "test precondition: done by 150ms");

        let mut image_cache = ImageCache::new();

        let mut before_terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        before_terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    not_done_at,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let before_text = buffer_text(before_terminal.backend().buffer());
        assert!(
            !before_text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must be absent before reveal completes, buffer was: {before_text}"
        );

        let mut after_terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        after_terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    None,
                    &[],
                    1,
                    1,
                    true,
                    Some(&reveal),
                    now,
                    done_at,
                    None,
                    &mut image_cache,
                    false,
                )
            })
            .unwrap();
        let after_text = buffer_text(after_terminal.backend().buffer());
        assert!(
            after_text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must appear the instant reveal completes, buffer was: {after_text}"
        );
    }

    #[test]
    fn page_indicator_symbol_renders_correctly_in_single_cell() {
        // PAGE_INDICATOR_SYMBOL（▼）は East Asian Width = Ambiguous な記号で、フォント/端末に
        // よって半角/全角の解釈が割れる。page_indicator_area が返す 1x1 の Rect にこの記号を
        // 描画したとき、セルの symbol() がそのまま1個の PAGE_INDICATOR_SYMBOL になっており、
        // 隣接セルへのはみ出しや空白パディングで壊れていないことを確認する（i18n観点）。
        // width は MIN_SAFE_TEXT_WRAP_WIDTH ちょうど（#487 セルフレビュー後の draw_page_indicator
        // ガードがこれ未満をスキップするため、それ以上を指定する必要がある。
        // PAGE_INDICATOR_INSET_COLS と同値でもあるため x のクランプ挙動は変わらない）。
        let area = Rect {
            x: 2,
            y: 2,
            width: MIN_SAFE_TEXT_WRAP_WIDTH,
            height: 1,
        };
        let mut terminal = Terminal::new(TestBackend::new(6, 6)).unwrap();
        let now = Instant::now();
        terminal
            .draw(|f| draw_page_indicator(f, area, Color::White, now, now))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let cell = buffer.cell((area.x, area.y)).expect("in bounds");
        assert_eq!(
            cell.symbol(),
            reveal::PAGE_INDICATOR_SYMBOL,
            "the single target cell should carry exactly the indicator symbol"
        );
    }

    #[test]
    fn choice_list_renders_nothing_but_does_not_panic_when_options_empty() {
        // Playback 側の修正（バグ2）後は options: [] の Choice が item 化されなくなるため
        // ui.rs の描画経路には現れなくなるが、draw_choice_list 単体としての防御も別途
        // 確認しておく価値がある（呼び出し側の前提が崩れても panic しないことの担保）。
        let mut terminal = Terminal::new(TestBackend::new(20, 10)).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                draw_choice_list(f, area, &[], 0, None, &[]);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert_eq!(text.trim(), "", "空optionsでは何も描画されないはず");
    }

    // ---- #494: 固定必要サイズの検算 ----

    #[test]
    fn fixed_canvas_image_pane_width_matches_required_image_cols() {
        // REQUIRED_TEXT_COLS = REQUIRED_IMAGE_COLS + 2 という一見不思議な式（定数の
        // doc コメント参照）が、実際に split_columns 経由で画像ペインを
        // REQUIRED_IMAGE_COLS ちょうどの幅にすることを検算する。ここがズレると
        // 正方形画像のクロップ0保証（`fixed_canvas_square_image_crops_nothing_at_required_image_pane_size`）
        // の前提が崩れる。
        let (img, gap, text) = split_columns(Rect::new(0, 0, CANVAS_W, CANVAS_H - 1));
        assert_eq!(
            img.width, REQUIRED_IMAGE_COLS,
            "image pane width should exactly match REQUIRED_IMAGE_COLS at the fixed canvas size"
        );
        assert_eq!(gap.width, IMAGE_TEXT_GAP_WIDTH);
        assert_eq!(text.width, REQUIRED_TEXT_COLS);
    }

    #[test]
    fn fixed_canvas_square_image_crops_nothing_at_required_image_pane_size() {
        // #494の核心の検算: gymnasiaの128x128マスター相当の正方形画像を、固定キャンバスの
        // 画像ペイン(REQUIRED_IMAGE_COLS x REQUIRED_MAIN_CONTENT_ROWS)へ実際に
        // rgba_to_quadrant_grid で変換したとき、cover-fitのクロップが発生しないことを
        // 実データで確認する（`compute_cover_crop`の純粋関数レベルの検算は
        // image_render.rs 側の `compute_cover_crop_result_aspect_ratio_matches_effective_target_ratio_within_rounding`
        // に既にあるが、ここでは本Issueで導入した具体的な定数の組み合わせで実際にクロップ0に
        // なることそのものを固定する）。
        let img_w = 128u32;
        let img_h = 128u32;
        let mut pixels = Vec::with_capacity((img_w * img_h * 4) as usize);
        for y in 0..img_h {
            for x in 0..img_w {
                // 縁(外側1px)だけ緑、それ以外は赤 — クロップが少しでも発生すれば緑が
                // 混入して検出できるようにする。
                let is_edge = x == 0 || y == 0 || x == img_w - 1 || y == img_h - 1;
                if is_edge {
                    pixels.extend_from_slice(&[0, 255, 0, 255]);
                } else {
                    pixels.extend_from_slice(&[255, 0, 0, 255]);
                }
            }
        }
        let grid = crate::image_render::rgba_to_quadrant_grid(
            &pixels,
            img_w,
            img_h,
            REQUIRED_IMAGE_COLS,
            REQUIRED_MAIN_CONTENT_ROWS,
        );
        assert_eq!(grid.cols, REQUIRED_IMAGE_COLS);
        assert_eq!(grid.rows, REQUIRED_MAIN_CONTENT_ROWS);
        // クロップが発生していれば、外周セルの緑が失われ全セルが赤一色になる。
        // クロップ無しなら外周セル(少なくとも四隅)には緑が残るはず。
        let has_green_influence = |fg: (u8, u8, u8), bg: (u8, u8, u8)| fg.1 > 0 || bg.1 > 0;
        let top_left = grid.cells[0];
        let top_right = grid.cells[(REQUIRED_IMAGE_COLS - 1) as usize];
        let bottom_left =
            grid.cells[(REQUIRED_IMAGE_COLS as usize) * (REQUIRED_MAIN_CONTENT_ROWS - 1) as usize];
        let bottom_right = grid.cells[grid.cells.len() - 1];
        for (name, cell) in [
            ("top_left", top_left),
            ("top_right", top_right),
            ("bottom_left", bottom_left),
            ("bottom_right", bottom_right),
        ] {
            assert!(
                has_green_influence(cell.fg, cell.bg),
                "{name} corner cell should retain some green from the uncropped source edge, got {cell:?}"
            );
        }
    }

    // ---- #500: バックログ画面 ----

    #[test]
    fn wrap_line_ascii_wraps_at_exact_width() {
        assert_eq!(
            wrap_line("hello world", 5),
            vec!["hello".to_string(), " worl".to_string(), "d".to_string()]
        );
    }

    #[test]
    fn wrap_line_wide_chars_count_as_two_cells() {
        // 全角3文字は6セル分。max_width=4なら2文字目までで折り返す（2+2=4で打ち切り）。
        assert_eq!(
            wrap_line("あいう", 4),
            vec!["あい".to_string(), "う".to_string()]
        );
    }

    #[test]
    fn wrap_line_empty_string_returns_single_empty_line() {
        assert_eq!(wrap_line("", 10), vec![String::new()]);
    }

    #[test]
    fn wrap_line_zero_width_does_not_infinite_loop_and_splits_per_char() {
        assert_eq!(wrap_line("ab", 0), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn wrap_backlog_lines_empty_entries_shows_placeholder() {
        let config = Config::default();
        let lines = wrap_backlog_lines(&config, &[], 40);
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("まだ"));
    }

    #[test]
    fn wrap_backlog_lines_includes_speaker_name_and_body() {
        let config = Config::default();
        let entries = vec![dialog_line(Some("A"), vec!["hello"])];
        let lines = wrap_backlog_lines(&config, &entries, 40);
        let joined: Vec<String> = lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        assert!(joined.contains(&"A".to_string()));
        assert!(joined.contains(&"hello".to_string()));
    }

    #[test]
    fn wrap_backlog_lines_narration_with_no_speaker_omits_speaker_line_but_keeps_body() {
        // `wrap_backlog_lines` は `entry.speaker` が `Some` の場合のみ話者名の行を積む
        // （`if let Some(speaker) = &entry.speaker` 分岐）。ナレーション行（話者
        // `None`）にはこの分岐が無いテストが無かった（セルフレビュー should対応）。
        // 話者名の行は追加されず、本文だけが積まれることを確認する。
        let config = Config::default();
        let entries = vec![dialog_line(None, vec!["ナレーション本文"])];
        let lines = wrap_backlog_lines(&config, &entries, 40);
        let joined: Vec<String> = lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        assert!(joined.contains(&"ナレーション本文".to_string()));
        // 話者名の行が無い＝本文行 + エントリ区切りの空行だけの計2行のはず。
        assert_eq!(
            lines.len(),
            2,
            "話者Noneでは話者名の行が積まれず、本文+区切り空行の2行だけのはず: {joined:?}"
        );
    }

    #[test]
    fn draw_backlog_no_entries_renders_placeholder_message() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw_backlog(f, &config, &[], 0);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("BACKLOG"));
        assert!(text.contains("まだ"));
    }

    #[test]
    fn draw_backlog_renders_entry_speaker_and_text() {
        let config = Config::default();
        let entries = vec![dialog_line(Some("A"), vec!["hello there"])];
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw_backlog(f, &config, &entries, 0);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("A"), "buffer was: {text}");
        assert!(text.contains("hello there"), "buffer was: {text}");
    }

    #[test]
    fn draw_backlog_scroll_beyond_content_clamps_to_max_scroll() {
        // 大量のエントリを積んでスクロール可能な状態を作り、`u16::MAX`（開いた直後の合図）を
        // 渡しても実際のコンテンツ量にクランプされることを確認する。
        let config = Config::default();
        let bodies: Vec<String> = (0..50).map(|i| format!("line {i}")).collect();
        let entries: Vec<DisplayLine> = bodies
            .iter()
            .map(|s| dialog_line(Some("A"), vec![s.as_str()]))
            .collect();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut clamped = 0u16;
        terminal
            .draw(|f| {
                clamped = draw_backlog(f, &config, &entries, u16::MAX);
            })
            .unwrap();
        assert!(
            clamped < u16::MAX,
            "u16::MAX はコンテンツ量へクランプされるはず、実際: {clamped}"
        );
    }

    #[test]
    fn draw_backlog_scroll_within_bounds_is_unchanged() {
        let config = Config::default();
        let entries = vec![dialog_line(Some("A"), vec!["hello"])];
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut clamped = 999u16;
        terminal
            .draw(|f| {
                clamped = draw_backlog(f, &config, &entries, 0);
            })
            .unwrap();
        assert_eq!(
            clamped, 0,
            "コンテンツが少ない=そもそもスクロール不要な場合は0のまま"
        );
    }

    // ---- #503: テキスト速度設定画面 ----

    #[test]
    fn format_speed_label_zero_is_instant() {
        assert_eq!(format_speed_label(0), "瞬間表示");
    }

    #[test]
    fn format_speed_label_fast_range_shows_fast_label() {
        assert_eq!(format_speed_label(10), "速い (10ms)");
    }

    #[test]
    fn format_speed_label_slow_range_shows_slow_label() {
        assert_eq!(format_speed_label(80), "遅い (80ms)");
    }

    #[test]
    fn format_speed_label_middle_range_shows_plain_ms_label() {
        assert_eq!(format_speed_label(30), "30ms/字");
    }

    #[test]
    fn draw_settings_renders_current_speed_label() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::TextSpeed);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("30ms/字"), "buffer was: {text}");
    }

    #[test]
    fn draw_settings_extremely_small_terminal_does_not_panic() {
        let mut terminal = Terminal::new(TestBackend::new(1, 1)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::TextSpeed);
            })
            .unwrap();
    }

    #[test]
    fn draw_settings_renders_volume_percentages() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig {
            bgm_percent: 65,
            se_percent: 85,
            voice_percent: 40,
        };
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::BgmVolume);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("BGM音量: 65%"), "buffer was: {text}");
        assert!(text.contains("SE音量: 85%"), "buffer was: {text}");
        assert!(
            text.contains("ボイス音量 (将来用): 40%"),
            "buffer was: {text}"
        );
    }

    // ---- #537: draw_settingsのフォーカス項目別レンジ・刻み幅ヒント ----

    #[test]
    fn draw_settings_text_speed_focus_shows_ms_range_hint() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::TextSpeed);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("(0〜200ms, 5ms刻み)"),
            "TextSpeedフォーカス時はms単位のレンジヒントが出るはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_settings_bgm_volume_focus_shows_percent_range_hint() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::BgmVolume);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("(0〜100%, 5%刻み)"),
            "BgmVolumeフォーカス時は%単位のレンジヒントが出るはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_settings_se_volume_focus_shows_percent_range_hint() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::SeVolume);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("(0〜100%, 5%刻み)"),
            "SeVolumeフォーカス時は%単位のレンジヒントが出るはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_settings_voice_volume_focus_shows_percent_range_hint() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, &volume, SettingsField::VoiceVolume);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("(0〜100%, 5%刻み)"),
            "VoiceVolumeフォーカス時は%単位のレンジヒントが出るはず, buffer was: {text}"
        );
    }

    #[test]
    fn settings_field_next_wraps_around_from_voice_volume_to_text_speed() {
        assert_eq!(SettingsField::VoiceVolume.next(), SettingsField::TextSpeed);
    }

    #[test]
    fn settings_field_prev_wraps_around_from_text_speed_to_voice_volume() {
        assert_eq!(SettingsField::TextSpeed.prev(), SettingsField::VoiceVolume);
    }

    #[test]
    fn settings_field_next_then_prev_returns_to_original() {
        for field in [
            SettingsField::TextSpeed,
            SettingsField::BgmVolume,
            SettingsField::SeVolume,
            SettingsField::VoiceVolume,
        ] {
            assert_eq!(field.next().prev(), field);
        }
    }

    // ---- テスト観点整理担当の指摘に基づく追加テスト（境界値・null/空文字）。既存の
    // `draw_backlog_scroll_beyond_content_clamps_to_max_scroll`（超過）と
    // `draw_backlog_scroll_within_bounds_is_unchanged`（範囲内）はカバー済みだが、
    // 「ちょうど境界」の値は未カバーだった。 ----

    #[test]
    fn draw_backlog_scroll_exactly_at_max_scroll_is_unclamped() {
        let config = Config::default();
        let bodies: Vec<String> = (0..50).map(|i| format!("line {i}")).collect();
        let entries: Vec<DisplayLine> = bodies
            .iter()
            .map(|s| dialog_line(Some("A"), vec![s.as_str()]))
            .collect();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();

        // まず u16::MAX でクランプ後の実際の max_scroll 値を得る。
        let mut max_scroll = 0u16;
        terminal
            .draw(|f| {
                max_scroll = draw_backlog(f, &config, &entries, u16::MAX);
            })
            .unwrap();
        assert!(
            max_scroll > 0,
            "テスト前提: スクロール可能な量のエントリのはず"
        );

        let mut clamped = 0u16;
        terminal
            .draw(|f| {
                clamped = draw_backlog(f, &config, &entries, max_scroll);
            })
            .unwrap();

        assert_eq!(
            clamped, max_scroll,
            "max_scrollちょうどの値はクランプされず、そのまま使われるはず"
        );
    }

    #[test]
    fn draw_backlog_empty_speaker_name_does_not_panic() {
        // #500: 話者名が空文字のエントリでもバックログ描画がpanicせず、本文は
        // 表示されることを確認する。
        let config = Config::default();
        let entries = vec![dialog_line(Some(""), vec!["hello"])];
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| {
                draw_backlog(f, &config, &entries, 0);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("hello"), "buffer was: {text}");
    }
}
