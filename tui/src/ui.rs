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
    Config, PlaceholderStyle, VolumeConfig, AUTO_WAIT_MAX_MS, AUTO_WAIT_MIN_MS, AUTO_WAIT_STEP_MS,
    TEXT_SPEED_MAX_MS, TEXT_SPEED_STEP_MS, VOLUME_MAX_PERCENT, VOLUME_STEP_PERCENT,
};
use crate::image_fade::ImageFadeState;
use crate::image_render::{
    clamp_scroll_offset, compute_full_width_rows, rgba_to_quadrant_grid_native,
    rgba_to_quadrant_grid_window, DecodedImage, ImageCache, RenderedImage,
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
/// セル数（#588でも32のまま踏襲。#494当時の20から#588で32へ拡大した — kako-jun指定の
/// `130列×33行`固定キャンバス／画像ペイン`64列×32行`の直接の根拠値）、
/// [`REQUIRED_IMAGE_COLS`] の導出元になる点が重要 — 詳細は下記を参照。
const REQUIRED_MAIN_CONTENT_ROWS: u16 = 32;

/// 画像ペインに必要な幅（セル数）。正方形画像（gymnasiaの128x128マスター想定）を
/// クロップ無しで表示するための式（#494、#588でも維持）。
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
/// `REQUIRED_MAIN_CONTENT_ROWS = 32` のとき `64`（Issue #588 が指定する画像ペイン幅と一致）。
const REQUIRED_IMAGE_COLS: u16 = REQUIRED_MAIN_CONTENT_ROWS * 2;

/// テキストペインに必要な幅（セル数）。#588で画像:テキストの横比率を厳密に`1:1`にする要求が
/// 明文化されたため、[`REQUIRED_IMAGE_COLS`] とそのまま同じ値を使う。
///
/// #494当時は `REQUIRED_IMAGE_COLS + 2` という補正値だった —
/// `split_columns` が `Constraint::Percentage(50)/Length(GAP)/Percentage(50)` を使っており、
/// ratatui のレイアウトソルバーは3つの制約が同時に指定された領域の幅を超過するとき
/// （`Percentage(50)`2つの理想値の合計 + `Length(GAP)` は area 幅ちょうどより
/// `IMAGE_TEXT_GAP_WIDTH` だけ超過する）、先に宣言された制約（画像側）だけを不足分だけ
/// 縮めて帳尻を合わせる実装だったため、幅が十分広い steady state では画像側が恒常的に
/// テキスト側より2セル少なくなる非対称性があった。この非対称性は総幅にかかわらず常に
/// ちょうど2セルの固定オフセットであり（`REQUIRED_TOTAL_WIDTH` をいくつに選んでも解消しない）、
/// #588 の「画像:テキスト=1:1」要求を満たせないため、`split_columns` 自体を
/// `Constraint::Length` ベースの絶対値指定へ変更した（#588セルフレビュー相当の判断）。
/// 固定キャンバス（`draw`が渡す領域の幅は常にちょうど[`REQUIRED_TOTAL_WIDTH`]）を前提にする限り
/// `Length` 3つの合計は area 幅と過不足なく一致するため、丸めの非対称性そのものが発生しない。
const REQUIRED_TEXT_COLS: u16 = REQUIRED_IMAGE_COLS;

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
/// （#488、#588で絶対値指定へ変更）。`Layout::split` の呼び出しをここへ切り出すことで、
/// テスト側は実際のレイアウト計算結果をそのまま期待値として使える（手計算した固定値を
/// テストに直書きしない）。スペーサー領域（戻り値の2番目）には何も描画しない — ratatui は
/// `Terminal::draw` のたびにバッファを既定セル（空白）へリセットするため、明示的に描く
/// コードが無くてもそこは単なる空白の余白として見える。
///
/// 画像/テキストは [`REQUIRED_IMAGE_COLS`]/[`REQUIRED_TEXT_COLS`]（#588時点でどちらも同値）を
/// `Constraint::Length` で直接指定する — #494〜#587では `Constraint::Percentage(50)` ずつ
/// だったが、ratatui のレイアウトソルバーは3制約の理想値合計が area 幅を超過するとき
/// 先に宣言された制約（画像側）だけを不足分だけ縮める実装で、幅が十分広い steady state では
/// テキスト側が画像側より常に2セル多くなる非対称性があった（[`REQUIRED_TEXT_COLS`] の
/// doc コメント参照）。#588 が「画像:テキスト=1:1」を明示的に要求したため、`draw` が渡す
/// 領域の幅は常にちょうど[`REQUIRED_TOTAL_WIDTH`]（`Length`3つの合計と過不足なく一致）という
/// 固定キャンバスの前提に乗り、絶対値指定へ切り替えて非対称性そのものを無くした。
/// `draw` から渡ってくる幅がちょうど[`REQUIRED_TOTAL_WIDTH`]のとき、画像/テキストは
/// 常にそれぞれ[`REQUIRED_IMAGE_COLS`]/[`REQUIRED_TEXT_COLS`]ちょうどになる
/// （`tests::fixed_canvas_image_pane_width_matches_required_image_cols` で検算）。
///
/// `area` の幅が3つの `Length` 合計に満たない場合（`draw` 経由では
/// [`fits_required_size`] のガードにより到達しないが、この関数自体は防御的に panic しない）、
/// ratatui のソルバーは不足分を各制約から比例的に切り詰める。この場合の具体的な配分は
/// `split_columns_areas_are_contiguous_and_never_exceed_input_width` が個別の幅ではなく
/// 「隙間なく連続する」「入力幅を超えない」という構造的な不変条件だけを検証する
/// （個別の丸め値そのものへは依存しない）。
fn split_columns(area: Rect) -> (Rect, Rect, Rect) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(REQUIRED_IMAGE_COLS),
            Constraint::Length(IMAGE_TEXT_GAP_WIDTH),
            Constraint::Length(REQUIRED_TEXT_COLS),
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
///
/// `image_only_item`（#628、`Playback::current_item_is_image_only()` をそのまま渡す）が真、
/// かつ `config.fullscreen_image` が真、かつ `choice.is_none()`（選択肢表示中は対象外）のとき、
/// [`split_columns`] による画像/テキストの左右分割をやめ、`root[0]` 全体をイベント絵に使う
/// 可逆トグル表示（GUI版 `fullscreen_image` frontmatter、`docs/spec/markdown-v0.1.md` 参照）。
/// 次に会話テキスト/選択肢のある item に進めば（＝`image_only_item` が `false` に戻れば）
/// 自動的に通常の左右分割表示へ戻る——状態を持たず毎フレーム `image_only_item` から判定する
/// だけなので、明示的な「元に戻す」処理は不要。
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
    // 各選択肢が完了(クリア済み)状態か（`option.cleared` が真のフラグを指している、#594、
    // #596でキーワード改名）。`choice_locked` と並行する独立配列——`choice` が `Some` の
    // ときだけ意味を持ち、`choice.0`/`choice_locked` と同じ長さ・同じ並びを期待する
    // （`main.rs` が `Playback::current_choice_cleared()` から作って渡す）。ロックとは
    // 異なり選択は拒否しない（見た目だけが変わる）。ロックと完了が同時に真のときはロックの
    // 見た目を優先する。
    choice_cleared: &[bool],
    position: usize,
    total: usize,
    is_at_end: bool,
    reveal: Option<&reveal::RevealState>,
    indicator_started_at: Instant,
    now: Instant,
    image_fade: Option<&ImageFadeState>,
    image_cache: &mut ImageCache,
    blackout: bool,
    image_only_item: bool,
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

    let fullscreen_event_image = config.fullscreen_image && image_only_item && choice.is_none();

    if fullscreen_event_image {
        draw_event_image_area(
            frame,
            root[0],
            config,
            image_fade,
            image_cache,
            now,
            blackout,
        );
    } else {
        let (placeholder_area, _gap_area, text_area) = split_columns(root[0]);
        draw_event_image_area(
            frame,
            placeholder_area,
            config,
            image_fade,
            image_cache,
            now,
            blackout,
        );
        match choice {
            Some((options, cursor, columns)) => draw_choice_list(
                frame,
                text_area,
                options,
                cursor,
                columns,
                choice_locked,
                choice_cleared,
            ),
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
    }
    draw_status_line(frame, root[1], config, position, total, is_at_end);
}

/// `area` 全体にイベント絵（`image_fade` のクロスフェード/ピクセレート状態）または
/// プレースホルダを描画する共通ヘルパー（#628）。`blackout` が真なら黒一色を優先する。
/// 通常プレイの左カラム（[`draw`] の非フルスクリーン分岐）と `fullscreen_image` モード
/// （[`draw`] の全画面分岐、選択肢/会話テキストを持たない画像コマ item専用）の両方から
/// 呼ばれる——レイアウト計算（呼び出し側が `area` を決める）と「そのエリアに何を描くか」の
/// 責務を分離する（無理に1つの`draw`本体へ両方のロジックを畳み込まない、Issue #628の実装
/// 判断）。
fn draw_event_image_area(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    image_fade: Option<&ImageFadeState>,
    image_cache: &mut ImageCache,
    now: Instant,
    blackout: bool,
) {
    let rendered_image = image_fade
        .and_then(|state| state.snapshot(image_cache, config, area.width, area.height, now));
    if blackout {
        draw_blackout(frame, area);
    } else {
        draw_placeholder(frame, area, config, rendered_image.as_ref());
    }
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
/// ロックは配色（DIM）のみで表現し、記号は一切付けない（#598/#604 で確定した GUI 版の
/// 設計をTUI版にも揃える、#609）。
///
/// `cleared`（#594、`option.cleared` が真のフラグを指している）も同様に `Modifier::DIM` を
/// 重ねる——TUI は色数が乏しいため、ロックと同じ「暗くする」表現を流用する。`cleared` の
/// 記号（[`CHOICE_CLEARED_SUFFIX`]）は `locked` とは独立した軸で判定する——ロック中でも
/// 完了済みなら🌑を表示する（`locked` はアイコン種別の判定に一切関与しない、#604 と同じ
/// 設計）。
fn choice_cursor_prefix_and_style(
    is_selected: bool,
    locked: bool,
    cleared: bool,
) -> (&'static str, Style) {
    let mut style = if is_selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };
    if locked || cleared {
        style = style.add_modifier(Modifier::DIM);
    }
    if is_selected {
        (CHOICE_CURSOR_SYMBOL, style)
    } else {
        (CHOICE_CURSOR_PADDING, style)
    }
}

/// 完了(クリア済み)状態の選択肢テキストに付ける視覚的な目印（#594、#596でキーワード改名）。
/// ろうそくの火が消えた後の「暗闇」を表す新月（🌑）を採用する。ロックとは独立した軸で
/// 判定する（`locked` の値に関わらず `cleared` だけで表示を決める、#609）ため、ロック中でも
/// 完了済みなら表示される。ロックと違い選択は拒否しない（`select_current_choice` は
/// `option.cleared` を見ない）ため、この記号は「選べないから見た目が変わる」のではなく
/// 「クリア済みで見た目が変わる」ことを示す。
const CHOICE_CLEARED_SUFFIX: &str = " 🌑";

fn draw_choice_list(
    frame: &mut Frame,
    area: Rect,
    options: &[ChoiceOption],
    cursor: usize,
    columns: Option<u32>,
    locked: &[bool],
    cleared: &[bool],
) {
    let columns = columns.unwrap_or(1).max(1);
    if columns <= 1 {
        let lines: Vec<Line> = options
            .iter()
            .enumerate()
            .map(|(i, option)| {
                let is_locked = locked.get(i).copied().unwrap_or(false);
                let is_cleared = cleared.get(i).copied().unwrap_or(false);
                let (prefix, style) =
                    choice_cursor_prefix_and_style(i == cursor, is_locked, is_cleared);
                // `is_locked` は上の DIM 判定にのみ使う。記号の出し分けは `is_cleared` だけで
                // 決める（`locked` から完全に独立、#609）——ロック中でも完了済みなら🌑を出す。
                let suffix = if is_cleared {
                    CHOICE_CLEARED_SUFFIX
                } else {
                    ""
                };
                Line::styled(format!("{prefix}{}{suffix}", option.text), style)
            })
            .collect();
        let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
        render_wrapped_paragraph(frame, area, paragraph);
        return;
    }
    draw_choice_grid(
        frame,
        area,
        options,
        cursor,
        columns as usize,
        locked,
        cleared,
    );
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
    cleared: &[bool],
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
            let is_cleared = cleared.get(index).copied().unwrap_or(false);
            let (prefix, style) =
                choice_cursor_prefix_and_style(index == cursor, is_locked, is_cleared);
            // `is_locked` は上の DIM 判定にのみ使う。記号の出し分けは `is_cleared` だけで
            // 決める（`locked` から完全に独立、#609）——ロック中でも完了済みなら🌑を出す。
            let suffix = if is_cleared {
                CHOICE_CLEARED_SUFFIX
            } else {
                ""
            };
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

/// スプラッシュ画面: `config.splash.logo_image` が設定されていればロゴ画像を表示し、
/// そうでなければ従来どおり `config.splash.lines` のロゴ行を画面中央に表示するテキストモード
/// （[`draw_splash_text`]）を描く。画像のロードに失敗した場合（`ImageCache::get_or_load` が
/// `None`）もテキストモードへフォールバックする — `splash.lines` が空でも既存のテキスト
/// モードどおり画面最下部の共通操作フッター（[`draw_operation_footer`]）だけは描く。
/// ロゴの内容（ASCII アート本体・画像ファイル）はゲームごとに異なるため、このエンジン側は
/// 表示方法だけを担い、内容そのものは持たない（`Config::splash` 参照）。
///
/// ロゴ画像モードは2通りに分岐する（#588）: [`logo_fits_natively`] が `true`（Issue #588が
/// 前提とする214x46pxロゴを含む、固定キャンバスの本編領域に収まるサイズ）のときは
/// [`draw_splash_logo_native`] で補間・拡大縮小・クロップ無しのネイティブ解像度表示を行う。
/// それより大きい画像（想定外の巨大ロゴ）では、既存の [`draw_fullscreen_image`]（#530、
/// contain-fit + スクロール）へフォールバックする — ネイティブ表示だとキャンバスから
/// はみ出て一部が見えなくなるため、大きい画像には縮小表示の方が実用的という判断。
///
/// `scroll_offset` はフルキャンバス画像表示モード（フォールバック時）でのみ意味を持つ
/// （呼び出し側 `main.rs` の `show_splash` が `Action::MoveUp`/`Action::MoveDown` から配線する）。
/// ネイティブ表示モード・テキストモードでは無視される。
///
/// `image_fade`/`now`（#628）はロゴのピクセレート遷移（黒ベタ→コルセン→スワップ→リファイン）
/// 状態。`main.rs::show_splash` が `ImageFadeState::settled(None, ..)` で開始し、ロゴパスが
/// 解決できた最初のフレームで `transition_to(Some(logo), .., EventImageTransition::Pixelate,
/// duration, now)` を呼んで遷移を開始する（通常プレイの `draw` が `image_fade` を受け取る
/// パターンをそのまま踏襲）。`None`（呼び出し元がピクセレート演出を使わないテスト等）なら
/// 常に通常表示（[`draw_splash_logo_native`]/[`draw_fullscreen_image`] 内の
/// `splash_pixelate_phase` が [`SplashPixelatePhase::Settled`] を返す）。
///
/// 通常プレイの `image_fade::ImageFadeState::snapshot`（`resolve_grid` 経由でパス解決から
/// やり直す cover-fit 前提の経路）はここでは使わない — スプラッシュのネイティブ/
/// contain-fit+スクロール表示は別の解像度計算（[`rgba_to_quadrant_grid_native`]/
/// [`rgba_to_quadrant_grid_window`]）を使うため、`image_fade` からは進行度・遷移モードだけを
/// 借り（[`ImageFadeState::progress`]/[`ImageFadeState::transition_mode`]）、実際のグリッド化は
/// [`splash_pixelate_phase`] が返す分母を使い分けた専用のピクセレート版関数
/// （[`image_render::rgba_to_quadrant_grid_native_pixelated`]/
/// [`image_render::rgba_to_quadrant_grid_window_pixelated`]）で行う。
pub fn draw_splash(
    frame: &mut Frame,
    config: &Config,
    image_cache: &mut ImageCache,
    scroll_offset: u16,
    image_fade: Option<&ImageFadeState>,
    now: Instant,
) {
    if let Some(path) = config.resolve_splash_logo_path() {
        if let Some(decoded) = image_cache.get_or_load(&path) {
            if logo_fits_natively(decoded.width, decoded.height) {
                let actual = frame.area();
                if !fits_required_size(actual) {
                    draw_too_small_message(frame, actual);
                    return;
                }
                let required = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, REQUIRED_TOTAL_HEIGHT);
                let canvas = compute_centered_canvas(actual, required);
                draw_splash_logo_native(frame, canvas, &decoded, image_fade, now);
            } else {
                draw_fullscreen_image(frame, &decoded, scroll_offset, image_fade, now);
            }
            return;
        }
    }
    draw_splash_text(frame, config);
}

/// スプラッシュロゴのピクセレート遷移(#628)で「今このフレームで描くべき状態」を表す。
/// [`splash_pixelate_phase`] が `image_fade`/`now` から導出する。
enum SplashPixelatePhase {
    /// コルセン中。スプラッシュロゴには「直前の画像」が無い（`from`は常に`None`扱い）ため、
    /// `image_fade::ImageFadeState::pixelate_snapshot` の `from=None` ケースと同じく
    /// 黒ベタ相当（[`image_render::blank_grid`]）を描く（no-op のコルセン）。
    Coarsening,
    /// リファイン中。`divisor` は [`crate::pixelate_transition::compute_divisor`] が返す
    /// 分母（1に向かって収束する）。
    Refining { divisor: u32 },
    /// 遷移なし（`image_fade` が `None`／`Pixelate` 以外／既に完了）。通常表示。
    Settled,
}

/// `image_fade`（#628）から [`SplashPixelatePhase`] を導出する純粋関数。
fn splash_pixelate_phase(image_fade: Option<&ImageFadeState>, now: Instant) -> SplashPixelatePhase {
    let Some(state) = image_fade else {
        return SplashPixelatePhase::Settled;
    };
    if state.transition_mode() != name_name_parser::models::EventImageTransition::Pixelate {
        return SplashPixelatePhase::Settled;
    }
    let t = state.progress(now);
    if t >= 1.0 {
        return SplashPixelatePhase::Settled;
    }
    if crate::pixelate_transition::is_coarsen_phase(
        t,
        crate::pixelate_transition::PIXELATE_TRANSITION_SWAP_RATIO,
    ) {
        SplashPixelatePhase::Coarsening
    } else {
        SplashPixelatePhase::Refining {
            divisor: crate::pixelate_transition::compute_divisor(
                t,
                crate::pixelate_transition::PIXELATE_TRANSITION_SWAP_RATIO,
                crate::pixelate_transition::PIXELATE_TRANSITION_MAX_DIVISOR,
            ),
        }
    }
}

/// スプラッシュロゴをネイティブ解像度（補間・拡大縮小なし）で固定キャンバス内に上下左右
/// 中央表示できるかどうかを判定する純粋関数（#588）。ロゴのセル換算ネイティブサイズ
/// （幅=`ceil(px幅/2)`、高さ=`ceil(px高さ/2)`、[`image_render::rgba_to_quadrant_grid_native`]
/// と同じ式）が、固定キャンバスの本編領域（[`REQUIRED_TOTAL_WIDTH`] x
/// [`REQUIRED_MAIN_CONTENT_ROWS`]、最下段の開始ヒント行を除く）に収まる場合だけ `true` を
/// 返す。収まらない大きな画像（Issue #588が前提とする214x46pxロゴでは発生しない想定外
/// ケース）では `false` を返し、呼び出し側（[`draw_splash`]）が既存の
/// [`draw_fullscreen_image`]（全幅contain-fit + スクロール）へフォールバックする。
fn logo_fits_natively(image_w: u32, image_h: u32) -> bool {
    let native_cols = image_w.div_ceil(2);
    let native_rows = image_h.div_ceil(2);
    native_cols <= u32::from(REQUIRED_TOTAL_WIDTH)
        && native_rows <= u32::from(REQUIRED_MAIN_CONTENT_ROWS)
}

/// スプラッシュロゴをネイティブ解像度のまま固定キャンバス内で上下左右中央に表示する
/// （#588、[`logo_fits_natively`] が `true` の場合のみ [`draw_splash`] から呼ばれる）。
/// [`image_render::rgba_to_quadrant_grid_native`] で拡大縮小・クロップ無しのグリッドを作り、
/// [`compute_centered_canvas`] を再利用してそのグリッドを画像領域（最下段の共通操作フッター
/// 行を除く）内で中央配置する — `compute_centered_canvas` は本来「端末内で固定キャンバスを
/// 中央配置する」ために作られた関数だが、「ある矩形の中に別の矩形を中央配置する」という
/// 責務自体は完全に汎用的なため、ネストして再利用できる。最下段には
/// [`draw_fullscreen_image`]・通常プレイ（[`draw`]）と同じ [`draw_operation_footer`] を表示し、
/// 起動直後から見た目の一貫性を保つ（Issue #587）。
fn draw_splash_logo_native(
    frame: &mut Frame,
    canvas: Rect,
    image: &DecodedImage,
    image_fade: Option<&ImageFadeState>,
    now: Instant,
) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(canvas);
    let image_area = rows[0];
    let hint_area = rows[1];

    // #628: ピクセレート遷移中はコルセン中=黒ベタ、リファイン中=段階的に細かく戻る
    // ネイティブ解像度グリッドを描く。遷移が無い/完了していれば従来どおり
    // `rgba_to_quadrant_grid_native` の完成形（このネイティブ表示は `crop`/`downsample_box` を
    // 経由しないため、`rgba_to_quadrant_grid_native_pixelated` の `divisor<=1` 早期returnと
    // 完全に一致する — 遷移完了直後の切り替わりに見た目の不連続は無い）。
    let grid = match splash_pixelate_phase(image_fade, now) {
        SplashPixelatePhase::Coarsening => {
            let native_cols = image.width.div_ceil(2).min(u32::from(u16::MAX)) as u16;
            let native_rows = image.height.div_ceil(2).min(u32::from(u16::MAX)) as u16;
            crate::image_render::blank_grid(native_cols, native_rows)
        }
        SplashPixelatePhase::Refining { divisor } => {
            crate::image_render::rgba_to_quadrant_grid_native_pixelated(
                &image.rgba,
                image.width,
                image.height,
                divisor,
            )
        }
        SplashPixelatePhase::Settled => {
            rgba_to_quadrant_grid_native(&image.rgba, image.width, image.height)
        }
    };
    let logo_rect = Rect::new(0, 0, grid.cols, grid.rows);
    let placed = compute_centered_canvas(image_area, logo_rect);
    draw_image_grid(frame, placed, &grid);

    draw_operation_footer(frame, hint_area, None);
}

/// スプラッシュ画像モードの最大スクロール量（最下端オフセット）を返す。
/// `show_splash` が target_scroll_offset 自体を入力時にクランプするための補助関数。
/// ロゴ画像が無い／読めない場合はテキストモード相当として 0 を返す。
///
/// [`logo_fits_natively`] が `true` の場合（[`draw_splash`] が [`draw_splash_logo_native`] で
/// スクロールを無視するネイティブ表示を行う場合）も 0 を返す（#588）。この分岐が無いと、
/// native表示中でも下記 `compute_full_width_rows`（全幅contain-fit前提の式）による架空の
/// 最大値が計算され、`main.rs::show_splash` の `Action::MoveUp`/`MoveDown` が画面に何も
/// 影響しない `target_scroll_offset` の内部状態だけを変化させ続けてしまう。
pub(crate) fn splash_max_scroll_offset(config: &Config, image_cache: &mut ImageCache) -> u16 {
    let Some(path) = config.resolve_splash_logo_path() else {
        return 0;
    };
    let Some(decoded) = image_cache.get_or_load(&path) else {
        return 0;
    };
    if logo_fits_natively(decoded.width, decoded.height) {
        return 0;
    }
    let total_rows = compute_full_width_rows(decoded.width, decoded.height, REQUIRED_TOTAL_WIDTH);
    clamp_scroll_offset(u16::MAX, total_rows, REQUIRED_MAIN_CONTENT_ROWS)
}

/// フルキャンバス画像表示（#530。#588以降は [`logo_fits_natively`] が `false` を返す
/// 大きな画像専用のフォールバック経路 — [`draw_splash`] 参照）。テキストウィンドウ・
/// スプラッシュの罫線を畳み、画像をアスペクト比を保ったままキャンバス全幅
/// （[`REQUIRED_TOTAL_WIDTH`]）へ contain-fit する（クロップは行わない）。必要総行数は
/// `image_render::compute_full_width_rows` で**全幅前提の式から直接**求め、高さが表示可能
/// 行数を超える場合は追加の縮小をせず、`scroll_offset`（呼び出し側が
/// `Action::MoveUp`/`Action::MoveDown` から配線する、`main.rs::show_splash` 参照）に応じて
/// 縦方向の可視範囲だけを [`rgba_to_quadrant_grid_window`] で生成して描画する（スクロール）。
///
/// 端末サイズが [`fits_required_size`] を満たさない場合は [`draw_too_small_message`] へ
/// フォールバックする — 固定サイズのキャンバス幅（[`REQUIRED_TOTAL_WIDTH`]）を前提に
/// contain 計算するため、通常のゲームUI描画（[`draw`]）と同じ最小サイズ制約を課す。
/// GUI版 dual-window と同じく罫線・タイトルは描かない。
fn draw_fullscreen_image(
    frame: &mut Frame,
    image: &DecodedImage,
    scroll_offset: u16,
    image_fade: Option<&ImageFadeState>,
    now: Instant,
) {
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
        // 共通操作フッターだけは出す。`fits_required_size`チェックを通過している以上、
        // 固定幅の`REQUIRED_TOTAL_WIDTH`から導かれる`fitted_cols`が実際に0になることは
        // 現状のコード上ほぼ到達不能（#538）。
        draw_operation_footer(frame, hint_area, None);
        return;
    }

    let offset = clamp_scroll_offset(scroll_offset, fitted_rows, image_area.height);
    let visible_rows = image_area.height.min(fitted_rows);
    // #628: ピクセレート遷移中はコルセン中=黒ベタ、リファイン中=段階的に細かく戻るcontain-fit
    // グリッドを描く。遷移が無い/完了していれば従来どおり `rgba_to_quadrant_grid_window`。
    let visible = match splash_pixelate_phase(image_fade, now) {
        SplashPixelatePhase::Coarsening => {
            crate::image_render::blank_grid(fitted_cols, visible_rows)
        }
        SplashPixelatePhase::Refining { divisor } => {
            crate::image_render::rgba_to_quadrant_grid_window_pixelated(
                &image.rgba,
                image.width,
                image.height,
                fitted_cols,
                fitted_rows,
                offset,
                visible_rows,
                divisor,
            )
        }
        SplashPixelatePhase::Settled => rgba_to_quadrant_grid_window(
            &image.rgba,
            image.width,
            image.height,
            fitted_cols,
            fitted_rows,
            offset,
            visible_rows,
        ),
    };
    let draw_area = Rect {
        x: image_area.x,
        y: image_area.y,
        width: fitted_cols,
        height: visible.rows,
    };
    draw_image_grid(frame, draw_area, &visible);

    // #587: スクロール可否による専用ヒント（「↑/↓ でスクロール」）は廃止した。共通操作
    // フッター（[`OPERATION_HINT_TEXT`]）が既に `↑/↓ 選択` を含んでおり、画像スクロール時の
    // ↑/↓ もこの表記でカバーされるため、二重表示を避けて常に同じフッターへ統一する。
    draw_operation_footer(frame, hint_area, None);
}

/// スプラッシュ画面（テキストモード）: `config.splash.lines` に設定されたロゴ行を画面中央に
/// 表示する。ロゴの内容はゲームごとに異なるため、このエンジン側は「中央寄せして表示する」
/// という汎用的な描画だけを担い、内容そのものは持たない（`Config::splash` 参照）。
///
/// 罫線内側（`inner`）を [`Layout`] で `[Min(0), Length(1)]` に上下分割し、上段には
/// `config.splash.lines` だけを中央寄せで描画する（従来のように末尾へ空行+開始ヒントを
/// 埋め込まない）。下段は他3経路（[`draw_splash_logo_native`]/[`draw_fullscreen_image`]/
/// 通常プレイの [`draw`]）と同じ [`draw_operation_footer`] を呼び、画面最下部に固定された
/// 共通フッターとして表示する（Issue #587）。
///
/// 端末サイズが [`fits_required_size`] を満たさない場合は [`draw_too_small_message`] へ
/// フォールバックする — 他3経路（[`draw_splash_logo_native`] は呼び出し元の [`draw_splash`]
/// で、[`draw_fullscreen_image`]・通常プレイの [`draw`] は自分自身で）が既に同じガードを
/// 持っており、ここだけ欠けていると狭い端末で操作フッターごとロゴ表示が丸ごと欠落する
/// （セルフレビューmust対応、#587）。ガードをこの関数自身の先頭に置くのは、将来
/// [`draw_splash`] 以外から呼ばれても取りこぼさないようにするため（`draw_fullscreen_image`
/// と同じ自己完結パターン）。
fn draw_splash_text(frame: &mut Frame, config: &Config) {
    let area = frame.area();
    if !fits_required_size(area) {
        draw_too_small_message(frame, area);
        return;
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .title(config.game_name.as_str());
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(inner);
    let lines_area = rows[0];
    let footer_area = rows[1];

    let color = Color::from_str(&config.splash.color).unwrap_or(Color::White);
    let style = Style::default().fg(color);

    let lines: Vec<Line> = config
        .splash
        .lines
        .iter()
        .map(|text_line| Line::styled(text_line.clone(), style))
        .collect();

    // 縦方向中央寄せ: ratatui の Paragraph は縦方向の中央寄せを持たないため、
    // ロゴ全体の高さから上マージンを計算して描画領域をずらす。
    let content_height = lines.len() as u16;
    let top_margin = lines_area.height.saturating_sub(content_height) / 2;
    let centered = Rect {
        x: lines_area.x,
        y: lines_area.y.saturating_add(top_margin),
        width: lines_area.width,
        height: lines_area.height.saturating_sub(top_margin),
    };

    let paragraph = Paragraph::new(Text::from(lines)).alignment(Alignment::Center);
    frame.render_widget(paragraph, centered);

    draw_operation_footer(frame, footer_area, None);
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

/// オート進行ウェイトの表示ラベル。GUI版 `SettingsOverlay.tsx` の autoWaitMs スライダーの
/// `format` 関数（`${(v / 1000).toFixed(1)}秒`）と同じ文言をそのまま踏襲する（#644）。
fn format_auto_wait_label(ms: u64) -> String {
    format!("{:.1}秒", ms as f64 / 1000.0)
}

/// 設定画面（#503）でフォーカス中の行。`Action::MoveLeft`/`Action::MoveRight` の文脈依存の
/// 再利用（`main.rs::event_loop` の `Overlay::Settings` 分岐）でラップアラウンドしながら
/// 切り替わる。フォーカス行に応じて `Action::MoveUp`/`Action::MoveDown` が調整する値
/// （テキスト速度 / オート進行ウェイト / 音量）が変わる。並び順は GUI版 `Settings`
/// interface（`frontend/src/game/settings.ts`）の msPerChar→autoWaitMs→bgmVolume→
/// seVolume→voiceVolume に合わせる（#644）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingsField {
    #[default]
    TextSpeed,
    AutoWaitMs,
    BgmVolume,
    SeVolume,
    VoiceVolume,
}

impl SettingsField {
    /// 次の行へラップアラウンドしながら進む（`Action::MoveRight`）。
    pub fn next(self) -> Self {
        match self {
            SettingsField::TextSpeed => SettingsField::AutoWaitMs,
            SettingsField::AutoWaitMs => SettingsField::BgmVolume,
            SettingsField::BgmVolume => SettingsField::SeVolume,
            SettingsField::SeVolume => SettingsField::VoiceVolume,
            SettingsField::VoiceVolume => SettingsField::TextSpeed,
        }
    }

    /// 前の行へラップアラウンドしながら戻る（`Action::MoveLeft`）。
    pub fn prev(self) -> Self {
        match self {
            SettingsField::TextSpeed => SettingsField::VoiceVolume,
            SettingsField::AutoWaitMs => SettingsField::TextSpeed,
            SettingsField::BgmVolume => SettingsField::AutoWaitMs,
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
    auto_wait_ms: u64,
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
    let auto_wait_label = format_auto_wait_label(auto_wait_ms);
    // フォーカス中の項目に応じて調整可能なレンジ・刻み幅をヒントに出す（#537）。全項目分を
    // 常時表示すると横幅・視認性の両方で冗長になるため、フォーカス行1つぶんだけに絞る。
    let range_hint = match focus {
        SettingsField::TextSpeed => {
            format!("(0〜{TEXT_SPEED_MAX_MS}ms, {TEXT_SPEED_STEP_MS}ms刻み)")
        }
        SettingsField::AutoWaitMs => {
            format!("({AUTO_WAIT_MIN_MS}〜{AUTO_WAIT_MAX_MS}ms, {AUTO_WAIT_STEP_MS}ms刻み)")
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
            format!("オート進行ウェイト: {auto_wait_label}"),
            focus == SettingsField::AutoWaitMs,
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

/// 通常プレイ・スプラッシュを問わず、画面最下部の共通フッターへ常時表示する操作キー一覧の
/// ヒント文言（Issue #587）。従来は起動直後のスプラッシュ画面にだけ「Enter / Space で開始」を
/// 単独表示しており、設定 (`C`) やバックログ (`B`) の存在を初見で知る手段が無かった —
/// この定数はそれらを含む主要操作を`Enter / Space` と同格で常時提示するために追加した。
/// 項目の欠落は禁止（[`draw_operation_footer`] 参照）。
const OPERATION_HINT_TEXT: &str =
    "Enter/Space 次へ  ↑/↓ 選択  A オート  S スキップ  B バックログ  C 設定  Q/Esc 終了";

/// 画面最下部1行の共通操作ヒントフッターを描画する（Issue #587）。[`OPERATION_HINT_TEXT`] を
/// 左寄せ・DIM スタイルで表示し、`trailing` が `Some(status)` の場合は同じ行の右寄せで
/// `status` を DIM スタイルで重ねて表示する（従来 `draw_status_line` が単独で持っていた
/// 「ゲーム名 — position/total (END)」の表示はこの `trailing` 経由で引き継ぐ）。
///
/// `area` の幅は通常キャンバス幅（[`REQUIRED_TOTAL_WIDTH`]=130列固定）を前提にしており、
/// ヒント文（約60〜70文字）と status 文字列は通常1行に収まる。収まりきらない場合でも
/// [`OPERATION_HINT_TEXT`] の7項目は絶対に欠落させない方針のため、ヒント側には
/// `OPERATION_HINT_TEXT` の実セル幅ぶんの領域を [`Layout`] で確保してから status を残りの
/// 領域へ描画する（重ね描画で status がヒントの一部を上書きする事故を避ける）。極端に
/// 狭い端末では、先にヒント側の幅を優先して確保するため status 側から先に切り詰められる。
fn draw_operation_footer(frame: &mut Frame, area: Rect, trailing: Option<&str>) {
    let hint_width = OPERATION_HINT_TEXT.cell_width().min(area.width);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(hint_width), Constraint::Min(0)])
        .split(area);

    let hint_paragraph = Paragraph::new(OPERATION_HINT_TEXT)
        .style(Style::default().add_modifier(Modifier::DIM))
        .alignment(Alignment::Left);
    frame.render_widget(hint_paragraph, cols[0]);

    if let Some(status) = trailing {
        let status_paragraph = Paragraph::new(status)
            .style(Style::default().add_modifier(Modifier::DIM))
            .alignment(Alignment::Right);
        frame.render_widget(status_paragraph, cols[1]);
    }
}

/// 画面最下段1行: [`draw_operation_footer`] 経由で共通の操作ヒントを左寄せ表示しつつ、
/// 右寄せで「ゲーム名 + 会話位置/総数（+ 終端マーカー）」を重ねて表示する（Issue #587で
/// `draw_operation_footer` へ統合、旧実装は status 単体の右寄せ1行だけだった）。
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
    draw_operation_footer(frame, area, Some(&status));
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
                        false,
                    )
                })
                .unwrap();
        }
    }

    // ---- #628: fullscreen_image（テキストを持たない画像コマitemの全画面表示、可逆トグル） ----

    #[test]
    fn draw_fullscreen_image_mode_hides_text_window_and_fills_full_canvas_width_with_image() {
        // config.fullscreen_image=true かつ image_only_item=true かつ choice=None のとき、
        // split_columns による左右分割をやめ root[0]全体をイベント絵に使う（GUI版
        // `fullscreen_image` frontmatterの可逆トグルと同じ設計）。通常なら text_area の
        // 先頭列になるはずの位置まで画像色が埋まっていること、かつ会話テキストが一切
        // 描画されないことを確認する。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((255, 0, 0), 4, 4), 4, 4);
        let (mut config, relative) = config_and_relative_path_for(&fixture_path);
        config.fullscreen_image = true;
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );
        let line = dialog_line(Some("A"), vec!["この本文は表示されないはず"]);
        let now = Instant::now();
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
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                    true, // image_only_item
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // 通常の左右分割なら text_area 側になるはずの右端セルまで画像色で埋まっているはず。
        assert_eq!(
            buffer.cell((CANVAS_W - 1, 0)).unwrap().bg,
            Color::Rgb(255, 0, 0),
            "fullscreen_imageモードは右端(本来のtext_area側)までイベント絵が埋めるはず"
        );
        let text = buffer_text(buffer);
        assert!(
            !text.contains("この本文は表示されないはず"),
            "fullscreen_imageモードでは会話テキストが隠れるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_mode_with_choice_present_falls_back_to_split_layout() {
        // 選択肢表示中（choice.is_some()）は、たとえ config.fullscreen_image=true かつ
        // image_only_item=true でも通常の左右分割へ戻る（Issue本文の「選択肢を完全に禁止
        // するわけではない」設計、`draw`のdoc comment参照）。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((255, 0, 0), 4, 4), 4, 4);
        let (mut config, relative) = config_and_relative_path_for(&fixture_path);
        config.fullscreen_image = true;
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );
        let options = vec![name_name_parser::models::ChoiceOption {
            text: "選択肢テキスト".to_string(),
            jump: "1-1".to_string(),
            condition: None,
            cleared: None,
        }];
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
                    &[false],
                    &[false],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                    true, // image_only_item（本来は選択肢と同時にSomeにはならないが、防御的に確認）
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let text = buffer_text(buffer);
        assert!(
            text.contains("選択肢テキスト"),
            "選択肢表示中は通常の左右分割へ戻り選択肢が見えるはず, buffer was: {text}"
        );
        assert_ne!(
            buffer.cell((CANVAS_W - 1, 0)).unwrap().bg,
            Color::Rgb(255, 0, 0),
            "選択肢表示中は右端まで画像で埋まらない(通常のtext_areaが復帰する)はず"
        );
    }

    #[test]
    fn draw_fullscreen_image_config_disabled_ignores_image_only_item_and_uses_split_layout() {
        // config.fullscreen_image=false（既定）なら、image_only_item=trueでも従来どおりの
        // 左右分割のまま——既定値で非破壊であることの固定。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((255, 0, 0), 4, 4), 4, 4);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        assert!(!config.fullscreen_image, "前提: 既定はfalse");
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );
        let line = dialog_line(Some("A"), vec!["本文"]);
        let now = Instant::now();
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
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal::RevealState::Done(reveal::skip_lines(
                        &config, &line,
                    ))),
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                    true, // image_only_item=true でも config が無効なので効果なし
                )
            })
            .unwrap();

        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("本文"),
            "fullscreen_image=falseなら通常どおり会話テキストが見えるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_mode_with_blackout_fills_entire_root_area_black_and_keeps_footer() {
        // #628 x #512の組み合わせ確認: fullscreen_event_image=true(config.fullscreen_image &&
        // image_only_item && choice.is_none()) かつ blackout=true のとき、通常の左右分割時は
        // placeholder_area側だけが黒くなるのに対し、フルスクリーン時はroot[0]全体
        // （本来のtext_area側を含む）が黒一色になり、右側にテキストが漏れないことを確認する
        // （draw_event_image_areaがblackoutをroot[0]全体に対して適用する経路の回帰ガード）。
        // 併せて、画面最下段の共通操作フッター（#587、非回帰要件）がblackout中も引き続き
        // 表示されることを確認する。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((255, 0, 0), 4, 4), 4, 4);
        let (mut config, relative) = config_and_relative_path_for(&fixture_path);
        config.fullscreen_image = true;
        let image_fade = ImageFadeState::settled(
            Some(relative),
            name_name_parser::models::AmbientEffects::default(),
        );
        let line = dialog_line(Some("A"), vec!["この本文は表示されないはず"]);
        let now = Instant::now();
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
                    &[],
                    1,
                    1,
                    false,
                    None,
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    true, // blackout
                    true, // image_only_item
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for y in 0..(CANVAS_H - 1) {
            for x in 0..CANVAS_W {
                assert_eq!(
                    buffer.cell((x, y)).unwrap().bg,
                    Color::Black,
                    "cell ({x},{y}) はfullscreen+blackout中は右側(本来のtext_area側)含め\
                     全域が黒のはず"
                );
            }
        }
        let text = buffer_text(buffer);
        assert!(
            !text.contains("この本文は表示されないはず"),
            "blackout中は会話テキストが見えないはず, buffer was: {text}"
        );
        assert!(
            text.contains("Enter/Space 次へ"),
            "#587の共通操作フッターはfullscreen+blackout中も表示され続けるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_config_enabled_with_text_and_event_image_but_image_only_item_false_uses_split_layout(
    ) {
        // GUI版(#628 frontmatter)との意図的な差異の固定: GUI版はfullscreen_image設定時、
        // イベント絵を伴う行であれば台詞の有無に関わらずフルスクリーン表示に倒す設計だが、
        // TUI版は`image_only_item`(Playback::current_item_is_image_only()、テキストを一切
        // 持たない画像コマitemだけがtrue)を厳密なゲートにしている（`draw`のdoc comment参照）。
        // したがって、台詞付きの行がevent_imageを伴っていても、image_only_item=falseで
        // ある限り左右分割のままになることを統合テストとして固定する。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((255, 0, 0), 4, 4), 4, 4);
        let (mut config, relative) = config_and_relative_path_for(&fixture_path);
        config.fullscreen_image = true;
        let image_fade = ImageFadeState::settled(
            Some(relative.clone()),
            name_name_parser::models::AmbientEffects::default(),
        );
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["台詞付きイベント絵".to_string()],
            event_image: Some(relative),
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        };
        let now = Instant::now();
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
                    &[],
                    1,
                    1,
                    false,
                    Some(&reveal::RevealState::Done(reveal::skip_lines(
                        &config, &line,
                    ))),
                    now,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                    false,
                    false, // image_only_item=false（テキストを持つLine item）
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let text = buffer_text(buffer);
        assert!(
            text.contains("台詞付きイベント絵"),
            "image_only_item=falseなら台詞は隠れず表示されるはず, buffer was: {text}"
        );
        assert_ne!(
            buffer.cell((CANVAS_W - 1, 0)).unwrap().bg,
            Color::Rgb(255, 0, 0),
            "config.fullscreen_image=trueでもimage_only_item=falseなら右端(text_area側)は\
             画像色で埋まらない(フルスクリーンに倒れない)はず"
        );
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
                    false,
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
                    false,
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
                    false,
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
                    false,
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
                    false,
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
                    false,
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
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
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
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
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
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
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
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
    }

    #[test]
    fn draw_splash_invalid_color_name_falls_back_to_white_without_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        config.splash.color = "not-a-real-color".to_string();
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("田"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_content_fits_exactly_shows_hint() {
        // セルフレビューmust対応（#587）で draw_splash_text にも fits_required_size ガードが
        // 付いたため、この境界テストは到達可能な最小サイズ（REQUIRED_TOTAL_WIDTH x
        // REQUIRED_TOTAL_HEIGHT）まで引き上げた。Borders::ALL が上下1セルずつ占有するため
        // inner.height = REQUIRED_TOTAL_HEIGHT-2、さらに [Min(0), Length(1)] 分割で
        // フッター1行を引いた lines_area.height = REQUIRED_TOTAL_HEIGHT-3。ロゴ行数を
        // ちょうどそれに合わせ、余白ゼロで全行が収まる境界を再現する。
        let content_height = REQUIRED_TOTAL_HEIGHT - 3;
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string(); content_height as usize];
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_content_overflows_by_one_line_does_not_panic() {
        // 上のテストからロゴ行数を1行増やし、lines_area.height より content_height が
        // 1行分大きい状態（末尾行が収まりきらない）を、fits_required_size ガード通過に
        // 必要な最小端末サイズの中で再現する（セルフレビューmust対応、#587）。ratatui の
        // Paragraph は wrap 未指定でも収まらない行を静かに切り詰めるだけで panic しない
        // ことの確認。フッター行は content の折り返し量に関係なく固定 Length(1) のため、
        // オーバーフローしても表示され続けることも併せて確認する。
        let content_height = REQUIRED_TOTAL_HEIGHT - 3 + 1;
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string(); content_height as usize];
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_mixed_width_line_renders_without_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["AB田C".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("AB田C"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_text_below_required_size_shows_too_small_message_not_footer() {
        // セルフレビューmust対応（#587）: draw_splash_text 経路（ロゴ画像未設定/ロード失敗時）
        // も他3経路（draw_splash_logo_native/draw_fullscreen_image/通常プレイのdraw）と同じ
        // fits_required_size ガードを持つことを固定する。幅のみ1セル不足させ、通常の
        // ゲームUI（操作フッター含む）が一切描画されず案内メッセージにフォールバックする
        // ことを確認する（既存の draw_splash_extremely_small_terminal_does_not_panic は
        // panicしないことしか見ておらずフッター欠落の有無を検証していなかった）。
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH - 1,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("端末を広げてください"), "buffer was: {text}");
        assert!(
            !text.contains(OPERATION_HINT_TEXT),
            "操作フッターが表示されてしまっている: {text}"
        );
        assert!(
            !text.contains("田"),
            "ロゴ行が表示されてしまっている: {text}"
        );
    }

    // ---- フルキャンバス画像表示モード（#530）----

    #[test]
    fn draw_fullscreen_image_wide_image_with_enough_space_shows_operation_footer_without_duplicate_scroll_hint(
    ) {
        // 横長画像(比4.0)はキャンバス全幅へcontain-fitしても表示可能行数に収まるため、
        // スクロール不要になる。#587以降は「Enter / Space で開始」のような専用文言では
        // なく、常時表示の共通操作フッター（[`OPERATION_HINT_TEXT`]、`↑/↓ 選択`を含む）が
        // 出るため、'↑'/'↓'の非存在はもう主張できない。ここではスクロール不要な場合でも
        // 専用の「でスクロール」ヒントが二重に追加されないことだけを確認する。
        let image = DecodedImage {
            width: 4,
            height: 1,
            rgba: solid_rgba((200, 80, 80), 4, 1),
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter/Space 次へ"), "buffer was: {text}");
        assert!(
            !text.contains("でスクロール"),
            "スクロール不要な画像で専用スクロールヒントを二重表示してはいけない, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_tall_image_needing_scroll_shows_operation_footer() {
        // 正方形画像(比1.0)は端末セルの非正方形補正込みでcontain-fitすると表示可能行数
        // (image_area.height)を超える。#587以降、スクロール要否に関わらず同じ共通操作
        // フッター（`↑/↓ 選択`を含む）が出るため、ここではフッターが確実に描画されている
        // ことだけを確認する（専用の「↑/↓ でスクロール」文言は廃止済み）。
        let image = DecodedImage {
            width: 1,
            height: 1,
            rgba: solid_rgba((80, 80, 200), 1, 1),
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("Enter/Space 次へ") && text.contains('↑') && text.contains('↓'),
            "共通操作フッター（↑/↓ 選択を含む）は表示されるはず, buffer was: {text}"
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
            .draw(|f| draw_fullscreen_image(f, &image, u16::MAX, None, Instant::now()))
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
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
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
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
            .unwrap();
    }

    #[test]
    fn draw_fullscreen_image_zero_sized_decoded_image_still_shows_operation_footer() {
        // バグ修正2（#538）: fitted_cols>0/fitted_rows==0（image.width/heightが0）の
        // 早期return経路でも、テキストモードのフォールバックと対称になるよう
        // 共通操作フッター（[`OPERATION_HINT_TEXT`]、Issue #587）だけは描画されるはず。
        let image = DecodedImage {
            width: 0,
            height: 0,
            rgba: vec![],
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("Enter/Space 次へ"),
            "fitted_rows==0の早期return経路でも共通操作フッターは表示されるはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_fullscreen_image_zero_sized_decoded_image_does_not_show_scroll_hint() {
        // バグ修正2（#538）: fitted_rows==0の早期return経路では`scrollable`判定
        // （`fitted_rows > image_area.height`）自体が実行されないため、通常の画像描画
        // 経路が出す専用の「でスクロール」ヒント（#587で廃止済み・共通フッターに統一）は
        // 元々含まれない。
        let image = DecodedImage {
            width: 0,
            height: 0,
            rgba: vec![],
        };
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        terminal
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
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
            .draw(|f| draw_fullscreen_image(f, &image, 0, None, Instant::now()))
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
        // #587でスクロール要否による専用ヒント（「↑/↓ でスクロール」）は廃止され、
        // 常時同じ共通操作フッターへ統一された。ここでは (a) フッター自体が表示されて
        // いること、(b) この画像が実際にスクロールを要する行数（表示可能行数=CANVAS_H-1を
        // 超える）であることを、廃止されたヒント文言の代わりに直接計算で確認する。
        assert!(
            buffer_text(buffer).contains("Enter/Space 次へ"),
            "共通操作フッターは表示されるはず"
        );
        let fitted_rows = compute_full_width_rows(image.width, image.height, CANVAS_W);
        assert!(
            fitted_rows > CANVAS_H - 1,
            "極端な縦長画像は表示可能行数(image_area.height)を超えて縦スクロールが必要になるはず"
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
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
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
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("Enter/Space 次へ"),
            "lines が空でも共通操作フッターはテキストモードへフォールバックして表示するはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_splash_valid_logo_image_does_not_render_text_mode_fallback() {
        // #588: 4x1というごく小さい画像は logo_fits_natively により
        // draw_splash_logo_native 経由になる（かつてはこのサイズでも常に
        // draw_fullscreen_image を通っていたが、#588でネイティブ表示が分岐した）。
        // ここでは「画像モードが選ばれ、テキストモードのフォールバックが一切描画されない」
        // という、両モードに共通する契約だけを確認する（各モード固有の描画内容は
        // 下記 `draw_splash_small_logo_image_uses_native_mode_and_does_not_fill_full_canvas_width`/
        // `draw_splash_oversized_logo_image_falls_back_to_fullscreen_scaled_mode` が担当する）。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((200, 80, 80), 4, 1), 4, 1);
        let mut config = splash_config_with_logo_image(&fixture_path);
        config.game_name = "テストゲーム".to_string();
        config.splash.lines = vec!["田".to_string()]; // logo_image優先で無視されるはず
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            !text.contains("田"),
            "logo_imageが有効な場合はテキストモードのlinesを描画しないはず, buffer was: {text}"
        );
        assert!(
            !text.contains("テストゲーム"),
            "画像表示モードはテキストモードの罫線タイトルを描かないはず, buffer was: {text}"
        );
        assert!(text.contains("Enter/Space 次へ"), "buffer was: {text}");
    }

    #[test]
    fn logo_fits_natively_214x46_reference_logo_size_fits() {
        // Issue #588が前提とする横長ロゴ214x46px（cols=107, rows=23）は、固定キャンバスの
        // 本編領域（REQUIRED_TOTAL_WIDTH x REQUIRED_MAIN_CONTENT_ROWS = 130x32）に
        // 収まるはず。
        assert!(logo_fits_natively(214, 46));
    }

    #[test]
    fn logo_fits_natively_oversized_image_does_not_fit() {
        // ネイティブ表示だとキャンバス本編領域をはみ出す大きさの画像は false になり、
        // draw_splash がスケール表示側（draw_fullscreen_image）へフォールバックする。
        let oversized_w = u32::from(REQUIRED_TOTAL_WIDTH) * 2 + 1;
        assert!(!logo_fits_natively(oversized_w, 46));
        let oversized_h = u32::from(REQUIRED_MAIN_CONTENT_ROWS) * 2 + 1;
        assert!(!logo_fits_natively(214, oversized_h));
    }

    #[test]
    fn logo_fits_natively_native_cols_exactly_at_width_boundary_is_true() {
        // 境界値の欠落補強（#588）: native_cols（image_w.div_ceil(2)）が
        // REQUIRED_TOTAL_WIDTH ちょうどになる幅（=REQUIRED_TOTAL_WIDTH*2px）は、
        // 「収まらない」側ではなく「収まる」側の境界（<=判定）に含まれるはず。
        let image_w = u32::from(REQUIRED_TOTAL_WIDTH) * 2;
        assert!(logo_fits_natively(image_w, 2));
    }

    #[test]
    fn logo_fits_natively_native_rows_exactly_at_height_boundary_is_true() {
        // 上の cols 版と対になる rows 版: native_rows（image_h.div_ceil(2)）が
        // REQUIRED_MAIN_CONTENT_ROWS ちょうどになる高さ（=REQUIRED_MAIN_CONTENT_ROWS*2px）も
        // 「収まる」側の境界に含まれるはず。
        let image_h = u32::from(REQUIRED_MAIN_CONTENT_ROWS) * 2;
        assert!(logo_fits_natively(2, image_h));
    }

    #[test]
    fn draw_splash_small_logo_image_uses_native_mode_and_does_not_fill_full_canvas_width() {
        // #588の核心の1つ: ネイティブ表示は画面全幅へ引き伸ばさない。8x2という小さい単色
        // 画像（cols=4, rows=1）をCANVAS_W(130)幅のキャンバスに表示すると、キャンバス
        // 左端(x=0)は中央配置により空白のままのはず — 引き伸ばしていたら全幅を覆ってしまう。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((255, 0, 0), 8, 2), 8, 2);
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let top_left_bg = buffer.cell((0, 0)).unwrap().bg;
        assert_ne!(
            top_left_bg,
            Color::Rgb(255, 0, 0),
            "ネイティブ表示は中央配置のはずで、キャンバス左端(0,0)まで赤で埋まってはいけない"
        );
    }

    #[test]
    fn draw_splash_oversized_logo_image_falls_back_to_fullscreen_scaled_mode() {
        // #588: 本編領域に収まらない大きな画像（ここでは縦長で高さが本編行数を超える画像）は
        // draw_fullscreen_image（全幅contain-fit）側へフォールバックする。#587で専用の
        // 「↑/↓ でスクロール」ヒントは廃止され、常時同じ共通操作フッターに統一されたため、
        // フォールバック経路に入った証拠は文言ではなく描画の signature（全幅contain-fit
        // なら image_area の左右端まで画像色で埋まる。ネイティブ表示は中央配置のため
        // 左右端まで埋まらない — `draw_splash_small_logo_image_uses_native_mode_and_does_not_fill_full_canvas_width`
        // 参照）で確認する。
        let oversized_h = (u32::from(REQUIRED_MAIN_CONTENT_ROWS) * 2 + 10) * 2; // rows超過を確実にする
        let color = (255u8, 0u8, 0u8);
        let fixture_path = crate::image_render::write_test_webp_fixture(
            &solid_rgba(color, 4, oversized_h),
            4,
            oversized_h,
        );
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let image_color = Color::Rgb(color.0, color.1, color.2);
        assert_eq!(
            buffer.cell((0, 0)).unwrap().bg,
            image_color,
            "全幅contain-fitのフォールバック描画は画像領域の左端まで埋まるはず"
        );
        assert_eq!(
            buffer.cell((CANVAS_W - 1, 0)).unwrap().bg,
            image_color,
            "全幅contain-fitのフォールバック描画は画像領域の右端まで埋まるはず"
        );
        let text = buffer_text(buffer);
        assert!(
            text.contains("Enter/Space 次へ"),
            "フォールバック経路でも共通操作フッターは表示されるはず, buffer was: {text}"
        );
    }

    // ---- #628: スプラッシュロゴのピクセレート遷移 ----

    /// スプラッシュロゴ用のピクセレート遷移中 `ImageFadeState` を組み立てる。`snapshot()`
    /// （パス解決ベースのcover-fit経路）は使わないため `next` の値自体は実際には参照されない
    /// （`ui::splash_pixelate_phase` は `progress()`/`transition_mode()` だけを見る、
    /// `draw_splash` のdoc comment参照）——`transition_to`のシグネチャを満たすためのダミー値。
    fn mid_flight_pixelate_fade(
        started_at: std::time::Instant,
        duration_ms: u64,
    ) -> ImageFadeState {
        ImageFadeState::settled(None, name_name_parser::models::AmbientEffects::default())
            .transition_to(
                Some("unused.webp".to_string()),
                name_name_parser::models::AmbientEffects::default(),
                name_name_parser::models::EventImageTransition::Pixelate,
                std::time::Duration::from_millis(duration_ms),
                started_at,
            )
    }

    // ---- #628: splash_pixelate_phase 単体テスト（draw_splash を経由せず直接呼ぶ）----
    //
    // 以下の draw_splash 統合テスト群は既に coarsen/refine/settled の見た目を検証しているが、
    // いずれも `draw_splash` のレンダリング経路越しの間接確認であり、`splash_pixelate_phase`
    // 自体を直接呼んだテストはこれまで一度も存在しなかった（テスト設計エージェント指摘）。

    #[test]
    fn splash_pixelate_phase_none_image_fade_is_always_settled() {
        // image_fade=None（呼び出し元がピクセレート演出を使わないテスト等）は常にSettled
        // （draw_splashのdoc comment契約）。
        assert!(matches!(
            splash_pixelate_phase(None, Instant::now()),
            SplashPixelatePhase::Settled
        ));
    }

    #[test]
    fn splash_pixelate_phase_non_pixelate_transition_mode_is_always_settled() {
        // transition_mode()がPixelate以外（既定のFade）ならSettled固定
        // （splash_pixelate_phase の `transition_mode() != Pixelate` 早期return を直接固定）。
        let started = Instant::now();
        let fade =
            ImageFadeState::settled(None, name_name_parser::models::AmbientEffects::default())
                .transition_to(
                    Some("unused.webp".to_string()),
                    name_name_parser::models::AmbientEffects::default(),
                    name_name_parser::models::EventImageTransition::Fade,
                    std::time::Duration::from_millis(1000),
                    started,
                );
        assert!(matches!(
            splash_pixelate_phase(Some(&fade), started + std::time::Duration::from_millis(100)),
            SplashPixelatePhase::Settled
        ));
    }

    #[test]
    fn splash_pixelate_phase_at_exact_swap_ratio_boundary_is_refining_not_coarsening() {
        // t==swap_ratio(0.5)ちょうどの境界: `pixelate_transition::is_coarsen_phase(0.5, 0.5)`は
        // 厳密な`<`比較によりfalse（コルセン側ではない）を返すため、境界ちょうどは
        // コルセンではなくリファイン側に転ぶ。この分岐をsplash_pixelate_phase単体で固定する
        // （pixelate_transition::is_coarsen_phase_boundary_just_below_at_and_above_swap_ratio
        // と同じ境界をここでも直接縛る）。
        let duration_ms = 1000;
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, duration_ms);
        let now = started + std::time::Duration::from_millis(duration_ms / 2);
        match splash_pixelate_phase(Some(&fade), now) {
            SplashPixelatePhase::Refining { divisor } => {
                assert_eq!(
                    divisor,
                    crate::pixelate_transition::PIXELATE_TRANSITION_MAX_DIVISOR,
                    "境界ちょうどはコルセン完了直後の値としてmax_divisorになるはず\
                     （pixelate_transition::compute_divisor_at_swap_boundary_is_maxと同じ根拠）"
                );
            }
            SplashPixelatePhase::Coarsening => {
                panic!("t==swap_ratioちょうどはRefiningのはずだったがCoarseningになった")
            }
            SplashPixelatePhase::Settled => {
                panic!("t==swap_ratioちょうどはRefiningのはずだったがSettledになった")
            }
        }
    }

    #[test]
    fn splash_pixelate_phase_progress_at_or_beyond_one_is_settled() {
        // t>=1.0（遷移完了ちょうど・超過の両方）はSettled。
        let duration_ms = 500;
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, duration_ms);
        assert!(
            matches!(
                splash_pixelate_phase(
                    Some(&fade),
                    started + std::time::Duration::from_millis(duration_ms)
                ),
                SplashPixelatePhase::Settled
            ),
            "tちょうど1.0(duration経過ちょうど)はSettledのはず"
        );
        assert!(
            matches!(
                splash_pixelate_phase(
                    Some(&fade),
                    started + std::time::Duration::from_millis(duration_ms + 500)
                ),
                SplashPixelatePhase::Settled
            ),
            "duration超過後もSettledのはず"
        );
    }

    #[test]
    fn draw_splash_fullscreen_mode_pixelate_coarsen_phase_shows_black_not_image_color() {
        // #628: コルセン中(t<0.5)はスプラッシュにも「直前の画像」が無い(from=None扱い)ため
        // 黒ベタになる。有効なロゴ画像が設定されていてもロゴ色が出てはいけない
        // （`image_fade::ImageFadeState::pixelate_snapshot`のfrom=Noneケースと同じ発想）。
        let oversized_h = (u32::from(REQUIRED_MAIN_CONTENT_ROWS) * 2 + 10) * 2;
        let color = (255u8, 0u8, 0u8);
        let fixture_path = crate::image_render::write_test_webp_fixture(
            &solid_rgba(color, 4, oversized_h),
            4,
            oversized_h,
        );
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, 1000);
        terminal
            .draw(|f| {
                draw_splash(
                    f,
                    &config,
                    &mut image_cache,
                    0,
                    Some(&fade),
                    started + std::time::Duration::from_millis(100),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(
            buffer.cell((0, 0)).unwrap().bg,
            Color::Rgb(0, 0, 0),
            "コルセン中(t=0.1)は黒ベタのはず"
        );
    }

    #[test]
    fn draw_splash_fullscreen_mode_pixelate_refine_phase_converges_to_image_color() {
        // #628: リファイン終盤(t≈0.999)はdivisor=1に収束し、通常のcontain-fit表示
        // （`draw_splash_oversized_logo_image_falls_back_to_fullscreen_scaled_mode`）と
        // 一致する画像色になる。
        let oversized_h = (u32::from(REQUIRED_MAIN_CONTENT_ROWS) * 2 + 10) * 2;
        let color = (255u8, 0u8, 0u8);
        let fixture_path = crate::image_render::write_test_webp_fixture(
            &solid_rgba(color, 4, oversized_h),
            4,
            oversized_h,
        );
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, 1000);
        terminal
            .draw(|f| {
                draw_splash(
                    f,
                    &config,
                    &mut image_cache,
                    0,
                    Some(&fade),
                    started + std::time::Duration::from_millis(999),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let image_color = Color::Rgb(color.0, color.1, color.2);
        assert_eq!(
            buffer.cell((0, 0)).unwrap().bg,
            image_color,
            "リファイン終盤(t=0.999)はdivisor=1相当で画像色に収束するはず"
        );
        assert_eq!(
            buffer.cell((CANVAS_W - 1, 0)).unwrap().bg,
            image_color,
            "全幅を覆うはず(通常のcontain-fit表示と同じ)"
        );
    }

    #[test]
    fn draw_splash_fullscreen_mode_settled_pixelate_transition_matches_no_fade_output() {
        // `draw_splash_native_mode_settled_pixelate_transition_matches_no_fade_output` の
        // フォールバック側（`draw_fullscreen_image`/`rgba_to_quadrant_grid_window_pixelated`）
        // 対。遷移完了後(t>=1.0)は通常の`draw_splash(.., None, ..)`と完全に同じ出力になる
        // はず（`rgba_to_quadrant_grid_window_pixelated`のdivisor<=1早期returnの契約、
        // `image_render`側のdoc comment参照）。
        let oversized_h = (u32::from(REQUIRED_MAIN_CONTENT_ROWS) * 2 + 10) * 2;
        let color = (255u8, 0u8, 0u8);
        let fixture_path = crate::image_render::write_test_webp_fixture(
            &solid_rgba(color, 4, oversized_h),
            4,
            oversized_h,
        );
        let config = splash_config_with_logo_image(&fixture_path);

        let mut baseline_terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut baseline_cache = ImageCache::new();
        baseline_terminal
            .draw(|f| draw_splash(f, &config, &mut baseline_cache, 0, None, Instant::now()))
            .unwrap();

        let mut fade_terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut fade_cache = ImageCache::new();
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, 1000);
        fade_terminal
            .draw(|f| {
                draw_splash(
                    f,
                    &config,
                    &mut fade_cache,
                    0,
                    Some(&fade),
                    started + std::time::Duration::from_millis(1000),
                )
            })
            .unwrap();

        assert_eq!(
            buffer_text(baseline_terminal.backend().buffer()),
            buffer_text(fade_terminal.backend().buffer()),
            "遷移完了後(t=1.0)は通常表示と同じ出力になるはず"
        );
    }

    #[test]
    fn draw_splash_native_mode_pixelate_coarsen_phase_shows_black_not_logo_color() {
        // 上のフルスクリーン版と対になる、ネイティブ表示モード（[`draw_splash_logo_native`]）
        // 側の確認。ネイティブ表示は画像を中央配置するため、画像の中心セルで確認する
        // （`draw_splash_small_logo_image_uses_native_mode_and_does_not_fill_full_canvas_width`
        // と同じ理由で(0,0)は元々背景のままなので使えない）。
        let color = (255u8, 0u8, 0u8);
        // 214x46pxの単色画像（logo_fits_natively が真になる参照サイズ、#588）。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 214, 46), 214, 46);
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, 1000);
        terminal
            .draw(|f| {
                draw_splash(
                    f,
                    &config,
                    &mut image_cache,
                    0,
                    Some(&fade),
                    started + std::time::Duration::from_millis(100),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        // ネイティブ表示は cols=107, rows=23（214x46/2）で画像領域(高さ=CANVAS_H-1)の中央に
        // 配置される。中心セルは確実に画像範囲内。
        let center = (CANVAS_W / 2, (CANVAS_H - 1) / 2);
        assert_eq!(
            buffer.cell(center).unwrap().bg,
            Color::Rgb(0, 0, 0),
            "コルセン中(t=0.1)は黒ベタのはず"
        );
    }

    #[test]
    fn draw_splash_native_mode_pixelate_refine_phase_converges_to_logo_color() {
        let color = (255u8, 0u8, 0u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 214, 46), 214, 46);
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, 1000);
        terminal
            .draw(|f| {
                draw_splash(
                    f,
                    &config,
                    &mut image_cache,
                    0,
                    Some(&fade),
                    started + std::time::Duration::from_millis(999),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let center = (CANVAS_W / 2, (CANVAS_H - 1) / 2);
        assert_eq!(
            buffer.cell(center).unwrap().bg,
            Color::Rgb(255, 0, 0),
            "リファイン終盤(t=0.999)はdivisor=1相当でロゴ色に収束するはず"
        );
    }

    #[test]
    fn draw_splash_native_mode_settled_pixelate_transition_matches_no_fade_output() {
        // 遷移完了後(t>=1.0)は通常の`draw_splash(.., None, ..)`と完全に同じ出力になるはず
        // （`rgba_to_quadrant_grid_native_pixelated`のdivisor<=1早期returnの契約、
        // `image_render`側のdoc comment参照）。
        let color = (255u8, 0u8, 0u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 214, 46), 214, 46);
        let config = splash_config_with_logo_image(&fixture_path);

        let mut baseline_terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut baseline_cache = ImageCache::new();
        baseline_terminal
            .draw(|f| draw_splash(f, &config, &mut baseline_cache, 0, None, Instant::now()))
            .unwrap();

        let mut fade_terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut fade_cache = ImageCache::new();
        let started = Instant::now();
        let fade = mid_flight_pixelate_fade(started, 1000);
        fade_terminal
            .draw(|f| {
                draw_splash(
                    f,
                    &config,
                    &mut fade_cache,
                    0,
                    Some(&fade),
                    started + std::time::Duration::from_millis(1000),
                )
            })
            .unwrap();

        assert_eq!(
            buffer_text(baseline_terminal.backend().buffer()),
            buffer_text(fade_terminal.backend().buffer()),
            "遷移完了後(t=1.0)は通常表示と同じ出力になるはず"
        );
    }

    #[test]
    fn draw_splash_native_mode_logo_below_required_size_shows_too_small_message_not_native_draw() {
        // #588の自己申告ギャップの本丸: draw_splash_logo_native 内でガードしている
        // fits_required_size の分岐自体がこれまで無検証だった。native表示に収まる
        // ロゴ（214x46px、logo_fits_natively の参照サイズ）を設定した状態で、幅だけ
        // 1セル不足する端末（REQUIRED_TOTAL_WIDTH-1 x REQUIRED_TOTAL_HEIGHT）に
        // draw_splash を呼ぶと、(a) draw_too_small_message の文言が出て、
        // (b) ネイティブ描画側の開始ヒントは出ず、(c) ロゴ色のセルが一切描画されない
        // （native描画そのものに到達していない）ことを確認する。
        let color = (255u8, 0u8, 0u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 214, 46), 214, 46);
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(
            REQUIRED_TOTAL_WIDTH - 1,
            REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text = buffer_text(buffer);
        assert!(text.contains("端末を広げてください"), "buffer was: {text}");
        assert!(
            !text.contains("Enter / Space で開始"),
            "サイズ不足時はネイティブ描画側の開始ヒントを出してはいけない, buffer was: {text}"
        );
        let logo_color = Color::Rgb(color.0, color.1, color.2);
        let area = buffer.area();
        for y in 0..area.height {
            for x in 0..area.width {
                assert_ne!(
                    buffer.cell((x, y)).unwrap().bg,
                    logo_color,
                    "サイズ不足時はロゴピクセルが一切描画されないはず (x={x}, y={y})"
                );
            }
        }
    }

    #[test]
    fn draw_splash_reference_214x46_logo_renders_end_to_end_without_panic_and_uses_native_mode() {
        // Issue #588 が前提とする基準サイズ214x46pxのロゴを、フルパイプライン(draw_splash)で
        // 実際に CANVAS_W x CANVAS_H 端末に通す。(a) panicしない (b) フォールバック
        // （draw_fullscreen_image、全幅contain-fit）ではなくnative側に入った証拠として
        // 画像左端(0,0)がキャンバス左端まで埋まっていない（native表示は中央配置で107cols
        // しか使わずcanvas幅130を余す。#587で「↑/↓ でスクロール」文言は廃止され共通操作
        // フッター（`↑/↓ 選択`を含む）が常時出るため、'↑'/'↓'文字の非存在ではもう判定
        // できない） (c) 画像領域の一部セルがロゴ色になっている、(d) 共通操作フッターが
        // 表示されている、の4点を確認する。
        let color = (10u8, 200u8, 30u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 214, 46), 214, 46);
        let config = splash_config_with_logo_image(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let logo_color = Color::Rgb(color.0, color.1, color.2);
        assert_ne!(
            buffer.cell((0, 0)).unwrap().bg,
            logo_color,
            "native表示は中央配置のはずで、キャンバス左端(0,0)まで画像色で埋まってはいけない（埋まっていればfallbackに入った証拠）"
        );
        let area = buffer.area();
        let has_logo_color = (0..area.height)
            .any(|y| (0..area.width).any(|x| buffer.cell((x, y)).unwrap().bg == logo_color));
        assert!(has_logo_color, "画像領域の一部セルがロゴ色になっているはず");
        let text = buffer_text(buffer);
        assert!(
            text.contains("Enter/Space 次へ"),
            "native表示モードでも共通操作フッターは表示されるはず, buffer was: {text}"
        );
    }

    #[test]
    fn splash_max_scroll_offset_native_mode_logo_returns_zero() {
        // レビュー指摘対応（#588）: `draw_splash_logo_native`（native表示）は
        // scroll_offset を完全に無視するが、`splash_max_scroll_offset` はこれまで
        // `logo_fits_natively` を認識せず、常に全幅contain-fit前提の `compute_full_width_rows`
        // で最大スクロール量を計算していた。native表示に収まる基準サイズ214x46pxロゴでは、
        // この最大値は画面に何も影響しない架空の値になってしまう
        // （`main.rs::show_splash` の Action::MoveUp/MoveDown が空回りする）。
        // native表示中はスクロール不要なので 0 を返すべき、という契約を固定する。
        let fixture_path = crate::image_render::write_test_webp_fixture(
            &solid_rgba((10, 20, 30), 214, 46),
            214,
            46,
        );
        let config = splash_config_with_logo_image(&fixture_path);
        let mut image_cache = ImageCache::new();
        assert_eq!(
            splash_max_scroll_offset(&config, &mut image_cache),
            0,
            "native表示に収まるロゴではスクロール不要のため最大オフセットは0のはず"
        );
    }

    #[test]
    fn draw_splash_native_mode_logo_extremely_small_terminal_does_not_panic() {
        // 既存の draw_splash_extremely_small_terminal_does_not_panic はロゴ未設定
        // （テキストモードへフォールバックする経路）のみをカバーしていた。ここでは
        // native表示に収まる小さいロゴ（4x1px相当のnativeサイズ）を設定した状態で、
        // 0x0/1x1という極小端末でもpanicしないことを確認する（#588、
        // logo_fits_natively==true分岐からfits_required_sizeガードに至る経路）。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((10, 20, 30), 4, 1), 4, 1);
        let config = splash_config_with_logo_image(&fixture_path);
        let mut image_cache = ImageCache::new();
        for (w, h) in [(0u16, 0u16), (1, 1)] {
            let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
            terminal
                .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
                .unwrap();
        }
    }

    #[test]
    fn draw_splash_native_mode_logo_larger_terminal_still_centers_without_growing() {
        // #588: ネイティブ表示は端末が要求サイズより大きくてもロゴを拡大しない。
        // 単色画像は quadrant_cell_from_subpixels により全セルが glyph=空白・
        // bg=ロゴ色になる（doc コメント参照）ため、8x2px（native cols=4, rows=1）の
        // 単色ロゴなら、ロゴ色を持つセル数はちょうど4になるはず。端末を
        // CANVAS_W/CANVAS_Hより大きくしてもこのセル数が変わらないこと、かつ
        // 左上(0,0)には来ない（中央寄せされている）ことを確認する。
        let color = (255u8, 0u8, 0u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 8, 2), 8, 2);
        let config = splash_config_with_logo_image(&fixture_path);
        let extra_w = 6u16;
        let extra_h = 4u16;
        let mut terminal =
            Terminal::new(TestBackend::new(CANVAS_W + extra_w, CANVAS_H + extra_h)).unwrap();
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| draw_splash(f, &config, &mut image_cache, 0, None, Instant::now()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let logo_color = Color::Rgb(color.0, color.1, color.2);
        let area = buffer.area();
        assert_ne!(
            buffer.cell((0, 0)).unwrap().bg,
            logo_color,
            "端末が大きくてもロゴは左上(0,0)まで拡大されないはず"
        );
        let logo_cell_count = (0..area.height)
            .flat_map(|y| (0..area.width).map(move |x| (x, y)))
            .filter(|&(x, y)| buffer.cell((x, y)).unwrap().bg == logo_color)
            .count();
        assert_eq!(
            logo_cell_count, 4,
            "native_cols(4)*native_rows(1)を超えて拡大されてはいけない"
        );
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
    fn fits_required_size_one_cell_wider_and_taller_is_true() {
        // 上の2件（幅のみ+1／高さのみ+1）は個別の軸しか動かしていなかった。
        // 幅・高さ双方を同時に+1したケースでも true になることを明示する。
        let actual = Rect::new(0, 0, REQUIRED_TOTAL_WIDTH + 1, REQUIRED_TOTAL_HEIGHT + 1);
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
    fn draw_too_small_message_content_survives_when_both_width_and_height_deficient() {
        // 上の`draw_too_small_message_content_survives_at_moderately_narrow_width`は
        // 幅のみ不足（高さはREQUIRED_TOTAL_HEIGHTちょうど）でしか本文を検証していなかった。
        // 幅・高さ双方が1セルずつ不足するケース（129x32）でも本文が省略されずに
        // 描画されることを確認する。
        let config = Config::default();
        let buffer = render(
            &config,
            None,
            None,
            REQUIRED_TOTAL_WIDTH - 1,
            REQUIRED_TOTAL_HEIGHT - 1,
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

    #[test]
    fn draw_then_draw_again_with_different_terminal_size_does_not_leak_stale_layout() {
        // #588: draw() の全出力は毎フレームの引数（特に frame.area()）だけから決まるべきで、
        // 前フレームのレイアウト（センタリングオフセット等）を引きずってはいけない。
        // CANVAS_W x CANVAS_H（ジャストサイズ、オフセット0）→ それより大きいサイズ
        // （オフセットが乗る）→ 再び CANVAS_W x CANVAS_H と連続で draw() し、最後のフレームで
        // テキスト列の開始x座標がオフセット0の位置（canvas_text_column_x_start()）に
        // 戻っていることを確認する。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["Y"]);
        let now = Instant::now();
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();

        let sizes = [
            (CANVAS_W, CANVAS_H),
            (CANVAS_W + 20, CANVAS_H + 7),
            (CANVAS_W, CANVAS_H),
        ];
        for (w, h) in sizes {
            terminal.backend_mut().resize(w, h);
            terminal
                .draw(|f| {
                    draw(
                        f,
                        &config,
                        Some(&line),
                        None,
                        &[],
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
                        false,
                    )
                })
                .unwrap();
        }

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
            "サイズを行き来した後ジャストサイズに戻れば、前フレームのオフセットを引きずらずセンタリングオフセットは0に戻るはず"
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
    fn split_columns_at_area_exactly_gap_width_squeezes_gap_to_zero() {
        // #588: split_columnsをConstraint::Length(REQUIRED_IMAGE_COLS/GAP/REQUIRED_TEXT_COLS)
        // ベースへ変更した後の実測値。W=IMAGE_TEXT_GAP_WIDTH(2)では3つのLengthがどれも
        // 満たせない極端な不足状態になり、ratatuiのレイアウトソルバーはgap(2番目に宣言した
        // 制約)を真っ先に0まで切り詰め、img/textへ1セルずつ均等に配る（cargo testで実測・
        // 確認済み、#494当時のPercentage版とは配分の傾向が異なる — 現在のsplit_columnsは
        // 常にちょうどREQUIRED_TOTAL_WIDTHの領域でしか呼ばれない前提のため、この極端な不足時の
        // 配分自体に強い意味は無く、panicしないことと合計が入力幅を超えないことが本質。
        // 具体的な配分は `split_columns_areas_are_contiguous_and_never_exceed_input_width` の
        // 構造的な不変条件でも別途カバーしている）。
        let (img, gap, text) = split_columns(Rect::new(0, 0, IMAGE_TEXT_GAP_WIDTH, 10));
        assert_eq!(img.width, 1);
        assert_eq!(
            gap.width, 0,
            "極端な不足時はgapが真っ先に0へ切り詰められる（実測値）"
        );
        assert_eq!(text.width, 1);
    }

    #[test]
    fn split_columns_at_area_one_cell_over_gap_width_splits_evenly() {
        // #588: W=IMAGE_TEXT_GAP_WIDTH+1(3)では、上のW=2のケースからgapが1セルだけ回復し、
        // img/gap/textが1セルずつのちょうど均等割りになる（cargo testで実測・確認済み）。
        let (img, gap, text) = split_columns(Rect::new(0, 0, IMAGE_TEXT_GAP_WIDTH + 1, 10));
        assert_eq!(img.width, 1);
        assert_eq!(gap.width, 1);
        assert_eq!(text.width, 1);
    }

    #[test]
    fn split_columns_below_required_total_width_gives_text_most_of_the_shortfall() {
        // #588: split_columnsがConstraint::Lengthベースになったことで、
        // REQUIRED_TOTAL_WIDTH未満の領域（draw()経由では fits_required_size のガードにより
        // 到達しないが、この関数自体は防御的に入力を受け付ける）ではimg/gapが小さな値に
        // 張り付き、textが残りをほぼ全て吸収する非対称な配分になる（W=20はimg=2/gap=2/text=16、
        // cargo testで実測・確認済み。#494当時のPercentage版の「差は最大2セル」という
        // steady stateの性質はもう成り立たない）。この配分自体は draw() の実運用では
        // 到達しない領域の実装詳細だが、ratatuiのレイアウトソルバーの挙動が将来変わったときに
        // 気づけるよう固定しておく。
        let (img, gap, text) = split_columns(Rect::new(0, 0, 20, 10));
        assert_eq!(img.width, 2);
        assert_eq!(gap.width, 2);
        assert_eq!(text.width, 16);
    }

    #[test]
    fn split_columns_at_required_total_width_gives_exact_1to1_split() {
        // #588の核心: draw()が実際に渡す唯一の幅（REQUIRED_TOTAL_WIDTH）では、
        // Length3つの合計がarea幅とちょうど一致するため過不足なく満たされ、
        // 画像:テキストが要求どおり厳密に1:1（REQUIRED_IMAGE_COLS == REQUIRED_TEXT_COLS）になる
        // （`fixed_canvas_image_pane_width_matches_required_image_cols` と同じ性質を
        // `split_columns` 単体でも固定する）。
        let (img, gap, text) = split_columns(Rect::new(0, 0, REQUIRED_TOTAL_WIDTH, 10));
        assert_eq!(img.width, REQUIRED_IMAGE_COLS);
        assert_eq!(gap.width, IMAGE_TEXT_GAP_WIDTH);
        assert_eq!(text.width, REQUIRED_TEXT_COLS);
        assert_eq!(img.width, text.width, "画像:テキストは厳密に1:1のはず");
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
            cleared: None,
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
                draw_choice_grid(f, area, &options, 0, 10, &[], &[]);
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
                draw_choice_grid(f, area, &options, 0, 2_000_000, &[], &[]);
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
                draw_choice_grid(f, area, &options, 0, 3, &[], &[]);
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
                draw_choice_grid(f, area, &options, cursor, 3, &[], &[]);
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
    // 各セルのDIMスタイルがlocked配列と同じインデックスの選択肢に対応することを、行×列から
    // 独立に再計算したセル領域内で直接確認する（frontendの ChoiceOverlay grid×lock整合性
    // テストと対をなす）。ロックは記号を持たない（#609でCHOICE_LOCKED_SUFFIX撤去）ため、
    // ここではDIMのみを検証する。
    #[test]
    fn draw_choice_grid_mixed_locked_pattern_maps_dim_to_correct_index_not_shifted() {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // 偶数indexはロックなし、奇数indexはロック中（市松パターンで隣接セルとの取り違えも検出できる）。
        let locked: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 2);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, 0, 5, &locked, &[]);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // draw_choice_grid内部と同じLayout計算でrow/colのRectを独立に再現する
        // （draw_choice_grid_ragged_last_row_leaves_missing_cells_blank_without_panic と同じ手法）。
        let row_areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints(vec![Constraint::Length(1); 2])
            .split(area);

        for (i, &expected_locked) in locked.iter().enumerate() {
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
        }
    }

    // #594 テスト観点整理フェーズ 最優先1: grid×cleared整合性。#591 の
    // draw_choice_grid_mixed_locked_pattern_maps_dim_to_correct_index_not_shifted
    // を cleared 版に踏襲する。10択・columns=5・cleared を市松(交互)パターンで渡し、
    // 各セルのDIMスタイル・🌑サフィックスがcleared配列と同じインデックスの選択肢に
    // 対応することを、行×列から独立に再計算したセル領域内で直接確認する（frontendの
    // ChoiceOverlay grid×cleared整合性テストと対をなす）。
    #[test]
    fn draw_choice_grid_mixed_cleared_pattern_maps_dim_and_moon_marker_to_correct_index_not_shifted(
    ) {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // 偶数indexは未完了、奇数indexは完了中（市松パターンで隣接セルとの取り違えも検出できる）。
        let cleared: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 2);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, 0, 5, &[], &cleared);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // draw_choice_grid内部と同じLayout計算でrow/colのRectを独立に再現する
        // （draw_choice_grid_ragged_last_row_leaves_missing_cells_blank_without_panic と同じ手法）。
        let row_areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints(vec![Constraint::Length(1); 2])
            .split(area);

        for (i, &expected_cleared) in cleared.iter().enumerate() {
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

            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim, expected_cleared,
                "index {i} の DIM 状態が cleared[{i}]={expected_cleared} と一致しない \
                 （行×列マッピングとcleared配列のインデックスずれの検出用）"
            );

            // 🌑はそのセル領域内(同じ行、自セルのx範囲内)だけを見る。行全体を見ると
            // 隣接セル(同じ行の別index)の🌑を誤って拾う恐れがあるため、独立に計算した
            // cell_area の範囲だけに限定してスキャンする。
            let has_moon_marker = (cell_area.x..cell_area.x + cell_area.width)
                .any(|x| buffer.cell((x, cell_area.y)).expect("in bounds").symbol() == "🌑");
            assert_eq!(
                has_moon_marker, expected_cleared,
                "index {i} の🌑表示の有無が cleared[{i}]={expected_cleared} と一致しない \
                 （自セル範囲内だけを見ても対応がずれていないかの確認）"
            );
        }
    }

    // #609 テスト観点整理: locked×cleared独立性。locked と cleared が同じindexで重なる
    // ケースを含む混在パターンで、🌑の表示が locked の値に一切影響されず cleared だけで
    // 決まること（GUI版 #604 で確立した「locked はアイコン種別の判定に一切関与しない」
    // 設計と同じ）、DIMは(locked||cleared)の単純ORであり二重付与されないことをセル単位で
    // 確認する。旧仕様（#591当時）は`if is_locked { LOCK } else if is_cleared { MOON }`という
    // 排他分岐で、locked×cleared同時真のとき🌑が漏れる（🔒のみ表示される）バグを持っていた
    // ——#609 はこの回帰を防ぐ。
    #[test]
    fn draw_choice_grid_locked_and_cleared_mixed_pattern_moon_shows_regardless_of_lock() {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // locked: index 0,3,6,9 / cleared: index 1,3,5,7,9。
        // index 3・9は locked かつ cleared が同時に真の重複ケース——locked に関わらず
        // cleared どおりに🌑が出ることを確認する（旧仕様のバグの回帰防止）。
        let locked: Vec<bool> = (0..10).map(|i| i % 3 == 0).collect();
        let cleared: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 2);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_grid(f, area, &options, 0, 5, &locked, &cleared);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let row_areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints(vec![Constraint::Length(1); 2])
            .split(area);

        for i in 0..10 {
            let row = i / 5;
            let col = i % 5;
            let col_areas = Layout::default()
                .direction(Direction::Horizontal)
                .constraints(vec![Constraint::Ratio(1, 5); 5])
                .split(row_areas[row]);
            let cell_area = col_areas[col];

            let is_locked = locked[i];
            let is_cleared = cleared[i];
            let expected_dim = is_locked || is_cleared;

            let digit = i.to_string();
            let (digit_x, digit_y) = (cell_area.x..cell_area.x + cell_area.width)
                .zip(std::iter::repeat(cell_area.y))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!("index {i} (\"{digit}\") should render inside its own grid cell, buffer was: {buffer:?}")
                });

            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim, expected_dim,
                "index {i} のDIM状態は (locked||cleared)={expected_dim} と一致するはず \
                 （locked/clearedの二重付与ではなく単純ORのため、重複時も非重複時と同じDIM一段のはず）"
            );

            let has_moon_marker = (cell_area.x..cell_area.x + cell_area.width)
                .any(|x| buffer.cell((x, cell_area.y)).expect("in bounds").symbol() == "🌑");

            // locked とは独立: locked の値に関わらず、cleared どおりに🌑が出る
            // （lockedがcleared判定を乗っ取らない、#609）。
            assert_eq!(
                has_moon_marker, is_cleared,
                "index {i} の🌑表示の有無が cleared[{i}]={is_cleared} と一致しない \
                 （locked[{i}]={is_locked} に関わらず cleared だけで決まるはず）"
            );
        }
    }

    // ---- #609 テスト観点整理: draw_choice_list（縦一列描画）側のlocked/cleared独立軸 ----
    // 上の3件（draw_choice_grid_mixed_locked_pattern_maps_dim_to_correct_index_not_shifted 等）
    // はgrid版のみを対象にしており、list版（columns<=1、選択肢ごとに別々の行に描画）には
    // 同種のテストが無かった（テスト設計エージェントによる指摘）。list版はgridのような
    // 行×列のセル領域計算が不要で、選択肢ごとに1行ずつ描画されるだけなので、各indexの行(y)を
    // 直接探して検証する。

    // #609 テスト観点整理 優先度A: list×locked整合性。10択・locked市松パターンで、各行の
    // DIM状態がlocked配列と同じインデックスの選択肢に対応することを確認する
    // （grid版の対応テストのlist版）。
    #[test]
    fn draw_choice_list_mixed_locked_pattern_maps_dim_to_correct_index() {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // 偶数indexはロックなし、奇数indexはロック中（市松パターンで隣接行との取り違えも検出できる）。
        let locked: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 10);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &locked, &[]);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for (i, &expected_locked) in locked.iter().enumerate() {
            let digit = i.to_string();
            let (digit_x, digit_y) = (0..area.width)
                .flat_map(|x| (0..area.height).map(move |y| (x, y)))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!(
                        "index {i} (\"{digit}\") should render somewhere, buffer was: {buffer:?}"
                    )
                });

            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim, expected_locked,
                "index {i} の DIM 状態が locked[{i}]={expected_locked} と一致しない \
                 （list版の行とlocked配列のインデックスずれの検出用）"
            );
        }
    }

    // #609 テスト観点整理 優先度A: list×cleared整合性。10択・cleared市松パターンで、各行の
    // DIM状態と🌑サフィックスがcleared配列と同じインデックスの選択肢に対応することを確認する
    // （grid版の対応テストのlist版）。
    #[test]
    fn draw_choice_list_mixed_cleared_pattern_maps_dim_and_moon_to_correct_index() {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // 偶数indexは未完了、奇数indexは完了中（市松パターンで隣接行との取り違えも検出できる）。
        let cleared: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 10);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &[], &cleared);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for (i, &expected_cleared) in cleared.iter().enumerate() {
            let digit = i.to_string();
            let (digit_x, digit_y) = (0..area.width)
                .flat_map(|x| (0..area.height).map(move |y| (x, y)))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!(
                        "index {i} (\"{digit}\") should render somewhere, buffer was: {buffer:?}"
                    )
                });

            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim, expected_cleared,
                "index {i} の DIM 状態が cleared[{i}]={expected_cleared} と一致しない \
                 （list版の行とcleared配列のインデックスずれの検出用）"
            );

            // 🌑はdigitと同じ行(digit_y)だけを見る。全バッファを見ると別行の🌑を誤って
            // 拾う恐れがあるため、自分の行に限定してスキャンする。
            let has_moon_marker = (0..area.width)
                .any(|x| buffer.cell((x, digit_y)).expect("in bounds").symbol() == "🌑");
            assert_eq!(
                has_moon_marker, expected_cleared,
                "index {i} の🌑表示の有無が cleared[{i}]={expected_cleared} と一致しない \
                 （自行範囲内だけを見ても対応がずれていないかの確認）"
            );
        }
    }

    // #609 テスト観点整理 優先度A（★最重要）: list×locked×cleared独立性。デシジョン
    // テーブルの locked=true・cleared=true の重複ケースを含む混在パターンで、🌑の表示が
    // locked の値に一切影響されず cleared だけで決まること（GUI版 #604 で確立した
    // 「lockedはアイコン種別の判定に一切関与しない」設計と同じ、grid版の回帰ガードの
    // list版）を確認する。lockedがclearedを握り潰すバグが再発しないことの回帰ガード。
    #[test]
    fn draw_choice_list_locked_and_cleared_mixed_pattern_moon_shows_regardless_of_lock() {
        let options: Vec<ChoiceOption> = (0..10)
            .map(|i| choice_option(&i.to_string(), "x"))
            .collect();
        // locked: index 0,3,6,9 / cleared: index 1,3,5,7,9（grid版の回帰テストと同じ組み合わせ）。
        // index 3・9は locked かつ cleared が同時に真の重複ケース——locked に関わらず
        // cleared どおりに🌑が出ることを確認する。
        let locked: Vec<bool> = (0..10).map(|i| i % 3 == 0).collect();
        let cleared: Vec<bool> = (0..10).map(|i| i % 2 == 1).collect();
        let area = Rect::new(0, 0, 60, 10);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &locked, &cleared);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for i in 0..10 {
            let is_locked = locked[i];
            let is_cleared = cleared[i];
            let expected_dim = is_locked || is_cleared;

            let digit = i.to_string();
            let (digit_x, digit_y) = (0..area.width)
                .flat_map(|x| (0..area.height).map(move |y| (x, y)))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!(
                        "index {i} (\"{digit}\") should render somewhere, buffer was: {buffer:?}"
                    )
                });

            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim, expected_dim,
                "index {i} のDIM状態は (locked||cleared)={expected_dim} と一致するはず \
                 （locked/clearedの二重付与ではなく単純ORのため、重複時も非重複時と同じDIM一段のはず）"
            );

            let has_moon_marker = (0..area.width)
                .any(|x| buffer.cell((x, digit_y)).expect("in bounds").symbol() == "🌑");

            // locked とは独立: locked の値に関わらず、cleared どおりに🌑が出る
            // （lockedがcleared判定を乗っ取らない、#609）。
            assert_eq!(
                has_moon_marker, is_cleared,
                "index {i} の🌑表示の有無が cleared[{i}]={is_cleared} と一致しない \
                 （locked[{i}]={is_locked} に関わらず cleared だけで決まるはず）"
            );
        }
    }

    // #609 テスト観点整理 優先度B: 正常系の回帰ガード。locked/clearedが全て偽のとき、
    // DIM無し・🌑無しはもちろん、撤去済みの🔒記号が出力バッファのどこにも現れないことを
    // 確認する（#609で🔒完全撤去したことの直接的な回帰検出）。
    #[test]
    fn draw_choice_list_no_lock_no_cleared_shows_no_dim_and_no_marker() {
        let options: Vec<ChoiceOption> =
            (0..5).map(|i| choice_option(&i.to_string(), "x")).collect();
        let locked = vec![false; 5];
        let cleared = vec![false; 5];
        let area = Rect::new(0, 0, 60, 5);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &locked, &cleared);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for y in 0..area.height {
            for x in 0..area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert!(
                    !cell.modifier.contains(Modifier::DIM),
                    "locked/cleared共に全て偽のとき、({x},{y})にDIMが付いてはいけない"
                );
                assert_ne!(
                    cell.symbol(),
                    "🌑",
                    "locked/cleared共に全て偽のとき、({x},{y})に🌑が出てはいけない"
                );
                assert_ne!(
                    cell.symbol(),
                    "🔒",
                    "🔒は#609で完全撤去済みのため、どのセルにも出てはいけない"
                );
            }
        }
    }

    // #609 テスト観点整理 優先度B: locked配列がoptions数より短いとき、範囲外indexは
    // `locked.get(i).copied().unwrap_or(false)` によりfalse扱いになりDIMが付かないことを
    // 確認する。
    #[test]
    fn draw_choice_list_locked_array_shorter_than_options_defaults_to_false() {
        let options: Vec<ChoiceOption> =
            (0..5).map(|i| choice_option(&i.to_string(), "x")).collect();
        // options 5件に対しlockedは2件だけ渡す。index0,1は明示的にロック、index2..4は
        // 配列が無い＝unwrap_or(false)でfalse扱いになるはず。
        let locked = vec![true, true];
        let area = Rect::new(0, 0, 60, 5);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &locked, &[]);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for i in 0..5 {
            let expected_locked = i < locked.len() && locked[i];
            let digit = i.to_string();
            let (digit_x, digit_y) = (0..area.width)
                .flat_map(|x| (0..area.height).map(move |y| (x, y)))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!(
                        "index {i} (\"{digit}\") should render somewhere, buffer was: {buffer:?}"
                    )
                });
            let dim = buffer
                .cell((digit_x, digit_y))
                .expect("in bounds")
                .modifier
                .contains(Modifier::DIM);
            assert_eq!(
                dim,
                expected_locked,
                "index {i}: locked配列(長さ{})の範囲外はunwrap_or(false)でDIM無しのはず",
                locked.len()
            );
        }
    }

    // #609 テスト観点整理 優先度B: cleared配列がoptions数より短いとき、範囲外indexは
    // `cleared.get(i).copied().unwrap_or(false)` によりfalse扱いになり🌑が付かないことを
    // 確認する（上のlocked版の対）。
    #[test]
    fn draw_choice_list_cleared_array_shorter_than_options_defaults_to_false() {
        let options: Vec<ChoiceOption> =
            (0..5).map(|i| choice_option(&i.to_string(), "x")).collect();
        // options 5件に対しclearedは2件だけ渡す。index0,1は明示的に完了済み、index2..4は
        // 配列が無い＝unwrap_or(false)でfalse扱いになるはず。
        let cleared = vec![true, true];
        let area = Rect::new(0, 0, 60, 5);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &[], &cleared);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for i in 0..5 {
            let expected_cleared = i < cleared.len() && cleared[i];
            let digit = i.to_string();
            let (_digit_x, digit_y) = (0..area.width)
                .flat_map(|x| (0..area.height).map(move |y| (x, y)))
                .find(|&(x, y)| buffer.cell((x, y)).expect("in bounds").symbol() == digit)
                .unwrap_or_else(|| {
                    panic!(
                        "index {i} (\"{digit}\") should render somewhere, buffer was: {buffer:?}"
                    )
                });
            let has_moon_marker = (0..area.width)
                .any(|x| buffer.cell((x, digit_y)).expect("in bounds").symbol() == "🌑");
            assert_eq!(
                has_moon_marker,
                expected_cleared,
                "index {i}: cleared配列(長さ{})の範囲外はunwrap_or(false)で🌑無しのはず",
                cleared.len()
            );
        }
    }

    // #609 テスト観点整理 優先度B: `&[]`, `&[]` を直接渡した場合にDIM/🌑が一切出ないことを
    // 明示的に確認する。他のテストでは引数として頻繁に使われているが、この非存在自体を
    // 直接アサートするテストが無かったため単独で用意する。
    #[test]
    fn draw_choice_list_both_locked_and_cleared_empty_slices_render_plain() {
        let options: Vec<ChoiceOption> =
            (0..5).map(|i| choice_option(&i.to_string(), "x")).collect();
        let area = Rect::new(0, 0, 60, 5);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal
            .draw(|f| {
                draw_choice_list(f, area, &options, 0, None, &[], &[]);
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        for y in 0..area.height {
            for x in 0..area.width {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert!(
                    !cell.modifier.contains(Modifier::DIM),
                    "locked=&[], cleared=&[]のとき、({x},{y})にDIMが付いてはいけない"
                );
                assert_ne!(
                    cell.symbol(),
                    "🌑",
                    "locked=&[], cleared=&[]のとき、({x},{y})に🌑が出てはいけない"
                );
            }
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
                    draw_choice_list(f, area, &options, 0, columns, &[], &[]);
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
                .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
            .draw(|f| draw_choice_list(f, area, &options, 0, None, &[], &[]))
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
                draw_choice_list(f, area, &[], 0, None, &[], &[]);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert_eq!(text.trim(), "", "空optionsでは何も描画されないはず");
    }

    // ---- #494: 固定必要サイズの検算 ----

    #[test]
    fn fixed_canvas_image_pane_width_matches_required_image_cols() {
        // REQUIRED_TEXT_COLS == REQUIRED_IMAGE_COLS（#588で1:1に統一。定数の
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
                draw_settings(f, 30, 2500, &volume, SettingsField::TextSpeed);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("30ms/字"), "buffer was: {text}");
    }

    #[test]
    fn format_auto_wait_label_formats_seconds_with_one_decimal() {
        assert_eq!(format_auto_wait_label(2500), "2.5秒");
        assert_eq!(format_auto_wait_label(500), "0.5秒");
        assert_eq!(format_auto_wait_label(10000), "10.0秒");
    }

    #[test]
    fn draw_settings_renders_current_auto_wait_label() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, 3000, &volume, SettingsField::AutoWaitMs);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("オート進行ウェイト: 3.0秒"),
            "buffer was: {text}"
        );
    }

    #[test]
    fn draw_settings_extremely_small_terminal_does_not_panic() {
        let mut terminal = Terminal::new(TestBackend::new(1, 1)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, 2500, &volume, SettingsField::TextSpeed);
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
                draw_settings(f, 30, 2500, &volume, SettingsField::BgmVolume);
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
                draw_settings(f, 30, 2500, &volume, SettingsField::TextSpeed);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("(0〜200ms, 5ms刻み)"),
            "TextSpeedフォーカス時はms単位のレンジヒントが出るはず, buffer was: {text}"
        );
    }

    // ---- #644: draw_settingsのAutoWaitMsフォーカス時のレンジ・刻み幅ヒント ----

    #[test]
    fn draw_settings_auto_wait_ms_focus_shows_ms_range_hint() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, 2500, &volume, SettingsField::AutoWaitMs);
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(
            text.contains("(500〜10000ms, 500ms刻み)"),
            "AutoWaitMsフォーカス時はms単位のレンジヒントが出るはず, buffer was: {text}"
        );
    }

    #[test]
    fn draw_settings_bgm_volume_focus_shows_percent_range_hint() {
        let mut terminal = Terminal::new(TestBackend::new(CANVAS_W, CANVAS_H)).unwrap();
        let volume = VolumeConfig::default();
        terminal
            .draw(|f| {
                draw_settings(f, 30, 2500, &volume, SettingsField::BgmVolume);
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
                draw_settings(f, 30, 2500, &volume, SettingsField::SeVolume);
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
                draw_settings(f, 30, 2500, &volume, SettingsField::VoiceVolume);
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
    fn settings_field_next_from_text_speed_goes_to_auto_wait_ms() {
        assert_eq!(SettingsField::TextSpeed.next(), SettingsField::AutoWaitMs);
    }

    #[test]
    fn settings_field_prev_wraps_around_from_text_speed_to_voice_volume() {
        assert_eq!(SettingsField::TextSpeed.prev(), SettingsField::VoiceVolume);
    }

    #[test]
    fn settings_field_next_then_prev_returns_to_original() {
        for field in [
            SettingsField::TextSpeed,
            SettingsField::AutoWaitMs,
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
