mod cli;
mod config;
mod image_fade;
mod image_render;
mod input;
mod multi_doc;
mod playback;
mod reveal;
mod sentence;
mod ui;

use std::time::{Duration, Instant};

use anyhow::Context;
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::Terminal;

use cli::Cli;
use config::Config;
use input::Action;
use playback::Playback;

/// 描画の再チェック間隔。タイプライター演出（`jiwa::RevealHandle`）はフレームごとの
/// `snapshot` で動くため、キー入力が無くてもこの間隔で再描画してアニメーションを進める
/// （kako-jun/type-globe の `quiz.rs` の `REDRAW` と同じ値）。
const REDRAW: Duration = Duration::from_millis(30);

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse(std::env::args());

    let config = match &cli.config_path {
        Some(path) => Config::load(path)
            .with_context(|| format!("config読み込みに失敗しました: {}", path.display()))?,
        None => Config::default(),
    };

    // `--script` は単一ファイルを直接指定する動作確認用の経路（`cli.rs` の doc comment
    // 参照）。この場合は script_dir 配下の一括マージをせず、従来どおりそのファイル単体を
    // parse する（単一ファイルなのでファイル境界情報は不要、`Playback::from_document`）。
    // 未指定（通常の起動経路）は script_dir 配下の全 .md を一括マージし、クロスファイル
    // ジャンプを解決できるようにする（#496）。この経路は複数ファイルが混在しうるため、
    // マージが返すファイル境界情報（`chapter_file_ids`）を渡せる `Playback::from_merged_document`
    // を使い、暗黙の advance がファイルをまたいで別ルートへ漏れないようにする（#496 追加スコープ）。
    let playback = match &cli.script_path {
        Some(script_path) => {
            let source = std::fs::read_to_string(script_path).with_context(|| {
                format!(
                    "Markdown原稿の読み込みに失敗しました: {}",
                    script_path.display()
                )
            })?;
            let document = name_name_parser::parser::parse(&source);
            Playback::from_document(&document)
        }
        None => {
            let merged =
                multi_doc::load_merged_document(&config.script_dir, &config.entry_script_path())
                    .with_context(|| {
                        format!(
                            "script_dir 配下のMarkdown原稿マージに失敗しました: {}",
                            config.script_dir.display()
                        )
                    })?;
            Playback::from_merged_document(&merged.document, &merged.chapter_file_ids)
        }
    };
    let mut playback = playback.with_sentence_per_page(config.sentence_per_page);

    run(&config, &mut playback)
}

/// 端末を alternate screen + raw mode に切り替えて再生ループを回す。
/// ループを抜けたら（正常終了・エラーいずれの場合も）必ず端末状態を元に戻す。
/// ratatui/crossterm 内部などで予期しない panic が起きた場合も、デフォルトの
/// panic フックが呼ばれる前に端末状態を復元し、raw mode + alternate screen の
/// まま固まってユーザーが `reset` を打つ羽目になるのを防ぐ。
fn run(config: &Config, playback: &mut Playback) -> anyhow::Result<()> {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(
            std::io::stdout(),
            LeaveAlternateScreen,
            ratatui::crossterm::cursor::Show
        );
        default_hook(info);
    }));

    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // タイプライター演出（`jiwa::RevealHandle`）とページ送りインジケータ
    // （`reveal::blink_visible` による1秒周期の完全on/off点滅、#495）は
    // どちらも時間経過だけで見た目が変わるため、キー入力の有無に関わらず `REDRAW` 間隔で
    // 再描画するポーリング方式にする（#472）。この `next_action` は `run_screens` を通じて
    // `show_splash`/`event_loop` の両方へ渡り、スプラッシュ画面もこの間隔で再描画されるが、
    // 静的な画面なので実害はない。
    let result = run_screens(&mut terminal, config, playback, &mut || {
        input::poll_action(REDRAW)
    });

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

/// スプラッシュ（`config.splash` が設定されていれば）→ 本編ループ、の順に画面を進める。
/// スプラッシュ未設定（デフォルト）ならいきなり本編から始まる（後方互換）。
///
/// `next_action` はキー入力の取得元を差し替え可能にするための注入点。本番の `run` からは
/// `input::poll_action`（実端末を短いタイムアウト付きで読む）をそのまま渡すだけで従来通り
/// 動くが、テストからは固定の `Action` 列を返すクロージャを渡すことで、`TestBackend` +
/// 合成キー入力で状態遷移をユニットテストできる。
fn run_screens<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    playback: &mut Playback,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
) -> anyhow::Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    if config.should_show_splash() {
        let advanced = show_splash(terminal, config, next_action)?;
        if !advanced {
            // スプラッシュ画面で終了操作（q/Esc）された場合は本編に進まず終える。
            return Ok(());
        }
    }
    event_loop(terminal, config, playback, next_action)
}

/// スプラッシュ画面を描画し、キー入力を1件待つ。`Action::Advance` で `Ok(true)`
/// （本編へ進む）、`Action::Quit` で `Ok(false)`（そのまま終了）を返す。
///
/// `image_cache` はフルキャンバス画像表示モード（`config.splash.logo_image` が `Some` の
/// 場合、#530）専用のローカル状態。`event_loop` 側の `ImageCache` とは別インスタンス
/// （スプラッシュはイベント絵と同時に表示されないため共有する必要が無く、シグネチャ変更の
/// 影響範囲を最小化する）。
///
/// スクロール（`Action::MoveUp`/`Action::MoveDown`）は目標位置（`target_scroll_offset`）を
/// 即座に更新するだけで、実際に描画する表示位置（`display_scroll_offset`）は
/// `config.splash.scroll_ease_ms` の所要時間をかけて ease-out で追従する
/// （kako-jun追加要望「スクロールはeaseにしたい」。`image_fade::ImageFadeState` の
/// `from`/`to`/`started_at`/`duration` パターンを踏襲 — キー入力のたびに現在の表示位置を
/// 新しいアニメーションの起点 `scroll_anim_start_offset` として引き継ぎ、開始時刻
/// `scroll_anim_start` をリセットする点も `ImageFadeState::transition_to` と同じ設計）。
/// 進行度・補間の計算自体は [`image_render::compute_scroll_ease_progress`]/
/// [`image_render::compute_eased_scroll_offset`]（ターミナル/時刻I/Oに触れない純粋関数）に
/// 委譲する。テキストモード（`logo_image` が `None`）ではどちらも参照されない
/// （`ui::draw_splash` 参照。以前はカーソル移動を選択肢が無いという理由で無視していたが
/// （#482）、フルキャンバス画像表示モードのスクロールに転用した、#530）。
///
/// アニメーション中も継続的に再描画されるのは、`next_action`（本番では
/// `input::poll_action(REDRAW)`、`run` 参照）がキー入力の有無に関わらず [`REDRAW`] 間隔で
/// `Action::None` を返してループを回し続けるため（`event_loop` のタイプライター演出・
/// ページ送りインジケータ点滅と同じ既存の定期再描画の仕組みをそのまま利用するだけで、
/// ここでの変更は不要）。
fn show_splash<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
) -> anyhow::Result<bool>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let mut image_cache = image_render::ImageCache::new();
    let mut target_scroll_offset: u16 = 0;
    let mut scroll_anim_start_offset: u16 = 0;
    let mut scroll_anim_start = Instant::now();
    loop {
        let now = Instant::now();
        let elapsed_ms = now.saturating_duration_since(scroll_anim_start).as_millis() as u64;
        let progress =
            image_render::compute_scroll_ease_progress(elapsed_ms, config.splash.scroll_ease_ms);
        let display_scroll_offset = image_render::compute_eased_scroll_offset(
            scroll_anim_start_offset,
            target_scroll_offset,
            progress,
        );
        terminal.draw(|frame| {
            ui::draw_splash(frame, config, &mut image_cache, display_scroll_offset)
        })?;

        match next_action()? {
            Action::Advance => return Ok(true),
            Action::Quit => return Ok(false),
            Action::MoveUp => {
                // 現在の表示位置（アニメーション途中点も含む）を新しいアニメーションの
                // 起点として引き継ぐことで、連打してもジャンプせず滑らかに追従し続ける。
                scroll_anim_start_offset = display_scroll_offset;
                scroll_anim_start = now;
                let max_offset = ui::splash_max_scroll_offset(config, &mut image_cache);
                target_scroll_offset = target_scroll_offset.saturating_sub(1).min(max_offset);
            }
            Action::MoveDown => {
                scroll_anim_start_offset = display_scroll_offset;
                scroll_anim_start = now;
                let max_offset = ui::splash_max_scroll_offset(config, &mut image_cache);
                target_scroll_offset = target_scroll_offset.saturating_add(1).min(max_offset);
            }
            // スプラッシュ画面には左右移動の対象となる複数列選択肢が無いため、無視する(#482、#508)。
            Action::MoveLeft | Action::MoveRight | Action::None => {}
        }
    }
}

/// 描画 → 短いタイムアウト付きでキー入力を待つ → 再生状態更新、を1件終了
/// (`Action::Quit`)まで繰り返す。
///
/// MVP（#471）はキー入力をブロッキングで待っていたが、タイプライター演出
/// （`jiwa::RevealHandle`）とページ送りインジケータ（`reveal::blink_visible` による
/// 1秒周期の完全on/off点滅、#495）はどちらも時間経過だけで見た目が変わるため、
/// キー入力の有無に関わらず一定間隔で再描画するフレームベースのループに変更した（#472）。
/// `Terminal<CrosstermBackend<Stdout>>` という具体型への結合は、`show_splash`/`run_screens`
/// と同じ `Backend` ジェネリック化・
/// `next_action` 注入パターンで解消済み（#478 のリファクタをそのまま踏襲）。
fn event_loop<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    playback: &mut Playback,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
) -> anyhow::Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let mut current_reveal: Option<reveal::RevealState> =
        build_reveal_for_current(playback, config, Instant::now());
    // ページ送りインジケータの点滅基準時刻。1秒周期の完全on/off点滅自体は話者・テキストに
    // 依存しないグローバルな明滅（`reveal::blink_visible`、#495）だが、基準時刻は固定ではなく
    // 毎フレーム `reveal::indicator_blink_started_at` で更新する（#495 追加修正）。
    //
    // 当初の #495 実装は起動時に一度だけ記録して以後固定していたが、これだと「ある会話行の
    // reveal完了が壁時計基準でたまたま非表示区間に重なると、読み終えたのに▼が最大1秒近く
    // 見えない」という、GUI版が #447 で潰したのと同じ事故がTUI側で再現しうった
    // （テスト設計エージェント指摘）。`indicator_was_shown` で前フレームの表示/非表示を
    // 追跡し、非表示→表示に切り替わる瞬間（＝reveal完了の瞬間）だけ基準時刻を
    // `Instant::now()` にリセットすることで、常に表示区間（ON）から点滅が始まるようにする。
    //
    // ただし reveal完了の瞬間だけを見ていると、`char_interval_ms=0 && fade_duration_ms=0`
    // （タイプライター演出を完全に無効化する設定）で reveal が生成直後から常に完了扱いに
    // なるケースを取りこぼす（行Aの表示完了後に行Bへ進んでも `show_page_indicator` が
    // `true→true` のまま一度も `false` を経由しないため、非表示→表示遷移が検出できず、
    // 行Bが行Aの残り点滅位相を引き継いでしまう — セルフレビュー must対応、#495 追加修正2）。
    // このため下のループ本体では、`playback.position()` が実際に変化した（＝新しい行へ
    // 進んだ）瞬間にも `indicator_was_shown` を強制的に `false` にリセットする
    // （`Action::Advance` 処理内、`reveal::indicator_blink_started_at` のdoc comment参照）。
    // 色はウィンドウ（自分側/相手側）ごとに `ui::draw_text_windows` が `Config::colors` から
    // 決める（この基準時刻の更新とは無関係）。
    let mut indicator_started_at = Instant::now();
    let mut indicator_was_shown = false;

    // イベント絵（`DisplayLine::event_image`）のデコード結果キャッシュとクロスフェード状態
    // （#481）。`image_fade` は開始時点の会話行が持つ event_image を「既にトランジション無しで
    // 表示され続けている」状態として初期化する（起動直後にフェードインさせない）。
    let mut image_cache = image_render::ImageCache::new();
    let mut image_fade = image_fade::ImageFadeState::settled(
        playback
            .current_line()
            .and_then(|line| line.event_image.clone()),
    );

    // 画像コマ自動送り（#497）の締切。現在位置が画像コマ item（`playback.pending_wait_ms()`
    // が `Some(ms)`、`Event::EventImage` 直後に `Event::Wait { ms }` が続いていたときだけ
    // 生成される、`playback::PlaybackItem::Image` 参照）にいる間だけ `Some` になり、
    // ループ本体はこれを過ぎたらプレイヤーの入力を待たずに自動的に `Action::Advance` 相当を
    // 発生させる（GUI版 `NovelRenderer` の `Wait { ms }` + `setTimeout` + `waitingForWait` に
    // 相当）。`Action` 経由にしない（`input::Action` はキー入力の解釈に特化した設計を維持する、
    // Issue #497 の実装方針）ため、`Action` enum にはタイマー起因の variant を増やさず、
    // ここで直接 `Action::Advance` を合成してから既存の `on_advance` 分岐へ流し込む。
    let mut wait_deadline = playback
        .pending_wait_ms()
        .map(|ms| Instant::now() + Duration::from_millis(u64::from(ms)));

    loop {
        let now = Instant::now();
        // インジケータを表示すべきか（reveal完了 かつ 選択肢非表示 かつ 会話行あり）。
        // `ui::draw_text_windows` が実際の描画可否を判定するのと同じ条件式を
        // `reveal::should_show_page_indicator` に集約して共有する（セルフレビュー should
        // 対応、#495 追加修正2。以前はここと `draw_text_windows` の両方に手書きで複製
        // されており、将来どちらか片方だけが変更されると黙って乖離するリスクがあった）。
        let show_page_indicator = reveal::should_show_page_indicator(
            playback.current_choice().is_some(),
            playback.current_line().is_some(),
            current_reveal.as_ref(),
            now,
        );
        indicator_started_at = reveal::indicator_blink_started_at(
            indicator_was_shown,
            show_page_indicator,
            indicator_started_at,
            now,
        );
        indicator_was_shown = show_page_indicator;
        terminal.draw(|frame| {
            ui::draw(
                frame,
                config,
                playback.current_line(),
                playback.current_choice(),
                playback.position(),
                playback.total(),
                playback.is_at_end(),
                current_reveal.as_ref(),
                indicator_started_at,
                now,
                Some(&image_fade),
                &mut image_cache,
                playback.is_blackout(),
            )
        })?;

        // 画像コマ自動送り（#497）: 締切を過ぎていれば、キー入力を待たずに `Action::Advance`
        // を合成する。まだ過ぎていなければ従来どおり `next_action()` で入力を待つ（プレイヤーが
        // 締切前に手動で Enter/Space を押して早送りすることも引き続きできる）。
        // 締切超過により `Action::Advance` を合成したかどうかを覚えておく（#497 バグ修正）。
        // この後 `on_advance` を呼んでも item が進まなかった（items 末尾で advance 相当が
        // no-op に終わった）場合、下の締切引き直しをそのまま行うと `ms` が0（または実測上0と
        // みなせる極小値）のとき新しい締切が「作った瞬間に既に過ぎている」ものになり、次周回の
        // 「経過済み」判定が恒久的に真になり続けて `next_action()`（実キー入力を読む唯一の
        // 経路）が二度と呼ばれなくなる — raw mode + alternate screen 中はこれが「アプリが
        // 固まった」ように見え、プレイヤーが q キー等で終了できなくなる（テスト設計フェーズで
        // 発見）。`deadline_triggered` と、行動前後の `item_index()` の変化を照合して、この
        // 「進行不可能なのに締切だけが経過し続ける」組み合わせのときだけ締切をクリアし、通常の
        // `next_action()` によるキー入力待ちにフォールバックする。
        //
        // `deadline_triggered` が真の間は `next_action()`（`REDRAW` = 30ms のポーリング間隔で
        // 入力を待つ経路）を経由せずに直接 `Action::Advance` を合成するため、この分岐だけを
        // 通り続ける限りループ本体はスリープしない。`[待機:0][イベント絵:B][待機:0]...` の
        // ように ms=0 の画像コマ item が連続すると、締切は毎回「作った瞬間に既に過ぎている」
        // ため `deadline_triggered` が常に真になり、その連鎖の間だけ CPU をビジーループで
        // 回し続ける。バグではなく許容している設計上のトレードオフ（ms=0 は「即座に進める」
        // という利用者の意図そのものであり、そこに人為的なウェイトを挟む理由が無いため）。
        let deadline_triggered = matches!(wait_deadline, Some(deadline) if now >= deadline);
        let action = if deadline_triggered {
            Action::Advance
        } else {
            next_action()?
        };
        let item_index_before_action = playback.item_index();

        match action {
            Action::Advance => {
                // 選択肢表示中（`Playback::current_choice` が `Some`）は、on_advance 内部で
                // `select_current_choice` による確定を試みる（#482、デシジョンテーブル参照）。
                on_advance(playback, &mut current_reveal, config, Instant::now());
                // `position()`（会話行のみを数える）ではなく `item_index()`（生の `items`
                // インデックス）で「実際に別の item へ移動したか」を判定する（#497）。画像コマ
                // item（`PlaybackItem::Image`）への遷移は会話行ではないため `position()` を
                // 変えないが、event_image は変わっているのでクロスフェードは起こす必要がある
                // — `position()` のままだと画像コマへの遷移を取りこぼす。
                //
                // item が実際に進んだ（＝スキップ操作でも選択肢の確定待ちでもなく、次の
                // item へ移動した）ときだけ event_image の変化を見てクロスフェードを
                // 開始する。skip_lines 経路（on_advance がタイプライター表示を全文表示へ
                // 早送りしただけ）や、無効な jump 先を選んで選択肢表示のまま no-op に終わった
                // 場合は item_index が変わらないため、ここには到達しない。
                if playback.item_index() != item_index_before_action {
                    // 会話行が実際に切り替わった瞬間。GUI版 `NovelRenderer` が新しい行/ページが
                    // 始まるたびに明示的に `setIndicatorVisible(false)` を呼んでからタイプ
                    // ライターを開始しているのと同じ「行が変わったら一旦強制的に隠す」ステップを
                    // ここで再現する（セルフレビュー must対応、#495 追加修正2）。
                    //
                    // `char_interval_ms=0 && fade_duration_ms=0`（タイプライター演出を完全に
                    // 無効化する設定）では、次の行の reveal は `build_reveal_for_current` で
                    // 生成された瞬間に既に `is_done()==true` になる。行Aの表示完了後
                    // （`indicator_was_shown=true`）にこのまま行Bへ進むと、行Bの
                    // `show_page_indicator` も生成直後から `true` なので `true→true` のまま
                    // 一度も `false` を経由せず、`reveal::indicator_blink_started_at` の
                    // 「非表示→表示遷移」判定が発火しない。結果、行Aの残り点滅位相
                    // （たまたま非表示区間かもしれない）を行Bがそのまま引き継いでしまう
                    // （2908aaf が防いだのと同じ事故の退行）。
                    //
                    // `indicator_blink_started_at` はフレーム間の `show_page_indicator` の値の
                    // 差分しか見ておらず「会話行そのものが切り替わったか」を知らないため、
                    // これはあの関数だけでは検出できない。ここで使っている
                    // `playback.item_index() != item_index_before_action`（＝本当に新しい item へ進んだ、
                    // #497 で画像コマ item も拾えるよう `position()` から乗り換え）は
                    // 既に上の image_fade トリガーが使っているのと同じ signal であり、これを
                    // 使って `indicator_was_shown` を強制的に `false` にリセットしてから
                    // 次フレームの `should_show_page_indicator`/`indicator_blink_started_at` に
                    // 入ることで、reveal が瞬間完了かどうかに関わらず必ず非表示→表示の遷移
                    // として扱われ、表示区間（ON）から点滅が始まり直す。
                    indicator_was_shown = false;

                    let target = playback
                        .current_line()
                        .and_then(|line| line.event_image.clone());
                    if image_fade.current_target() != target.as_deref() {
                        // `config.event_image.crossfade_ms`（グローバル値）を常に使う。
                        // `Event::EventImage`/`EventImageExit` が持つイベント個別の `fade_ms`
                        // 上書きは `playback.rs` の `Playback::from_document` で意図的に
                        // 読み捨てている（MVPスコープの簡略化、#481）。
                        image_fade = image_fade.transition_to(
                            target,
                            Duration::from_millis(config.event_image.crossfade_ms),
                            Instant::now(),
                        );
                    }
                }
            }
            // 選択肢を表示していないとき（`Playback::current_choice` が `None`）は no-op（#482）。
            // MoveLeft/MoveRight は非グリッド（列数1以下）表示中も同様に no-op（#508）。
            Action::MoveUp => playback.move_choice_cursor_up(),
            Action::MoveDown => playback.move_choice_cursor_down(),
            Action::MoveLeft => playback.move_choice_cursor_left(),
            Action::MoveRight => playback.move_choice_cursor_right(),
            Action::Quit => break,
            Action::None => {}
        }

        // 画像コマ自動送り（#497）: 今回のアクション処理後の現在位置に応じて締切を引き直す。
        //
        // `wait_deadline` は「新しい item へ実際に移った、その瞬間にだけ」`Instant::now()` を
        // 基準として1回だけ設定するものであって、まだ経過していない待機中の反復のたびに
        // 基準時刻を引き直してよいものではない（テスト実装フェーズで発見された重大バグ、
        // #497）。旧実装は `deadline_advance_was_noop` が false である限り
        // （＝items末尾でのno-opでない限り）毎周回 `Instant::now() + ms` で上書きしていたため、
        // `ms > 0` のケースでは締切が「今から ms ミリ秒後」へ無限に後退し続け、ループの
        // オーバーヘッド以上の時間が経過しない限り `now >= deadline` が真にならず、
        // 自動送りが事実上まったく発火しなかった（`ms=0` のケースだけは、ループに入る前の
        // 初期セット分で最初のチェックで即座に trigger するため、たまたまこの再計算に
        // 到達せず踏まなかった）。
        //
        // 正しくは `item_index()` の変化（＝本当に別の item へ進んだか）だけを見て分岐する:
        let item_changed = playback.item_index() != item_index_before_action;
        if deadline_triggered && !item_changed {
            // 締切超過により `Action::Advance` を合成したが、items 末尾などで進行できず
            // no-op に終わった場合。そのまま `pending_wait_ms()` から締切を引き直すと、
            // 同じ Image item に留まったまま新しい締切をまた作ってしまい、`ms` が実質0と
            // みなせる値のときは「作った瞬間に既に過ぎている」締切になって、次周回以降
            // ずっと `next_action()`（実キー入力を読む唯一の経路）を経由せず即座に締切超過
            // と判定され続けてしまう（f7e16c1 で修正済みの入力スタベーション対策）。
            // この組み合わせのときだけ締切を `None` にクリアし、通常の `next_action()` に
            // よるキー入力待ちにフォールバックする。
            wait_deadline = None;
        } else if item_changed {
            // 新しい item へ実際に移った（タイマー起因の自動 Advance／手動キー入力による
            // Advance のどちらでも）。その新 item の `pending_wait_ms()` に応じて、この
            // 瞬間の `Instant::now()` を基準に締切を1回だけセットし直す。
            wait_deadline = playback
                .pending_wait_ms()
                .map(|ms| Instant::now() + Duration::from_millis(u64::from(ms)));
        }
        // else: 締切未経過かつ item も変わっていない通常の待機中の反復。既存の
        // `wait_deadline` をそのまま保持し、絶対に再計算しない（これが今回のバグ修正の核心）。
    }
    Ok(())
}

/// 現在位置の会話行から新しい reveal を組み立てる。現在位置が選択肢
/// （`Playback::current_choice`）や、そもそも表示すべき item が無い場合は `None` — 選択肢の
/// 文言はタイプライター演出の対象外（GUI版の選択肢オーバーレイに演出が無いのと同じ扱い、#482）。
///
/// `playback.pending_wait_ms()` が `Some`（＝画像コマ自動送り item、#497）の間は、通常の
/// `RevealState::Animating`（タイプライターで少しずつ表示）ではなく即座に全文表示済みの
/// `RevealState::Done` を返す。画像コマは話者・本文を直前の会話行からそのまま引き継いでいる
/// だけ（`playback::Playback::build` 参照）なので、ここでもう一度同じ文をタイプライターで
/// 再生し直すと、指定した `Wait { ms }` の間ずっと文字が少しずつ出続けるだけの見た目になり、
/// `ms` 経過後の自動送りが「まだ全文表示し終えていない」ために足止めされうる
/// （`on_advance` は reveal 未完了だと `advance()` を呼ばず全文表示へのスキップに専念するため、
/// 自動送りの締切と実際に進むタイミングが `char_interval_ms` 分だけずれてしまう）。
fn build_reveal_for_current(
    playback: &Playback,
    config: &Config,
    now: Instant,
) -> Option<reveal::RevealState> {
    let line = playback.current_line()?;
    if playback.pending_wait_ms().is_some() {
        return Some(reveal::RevealState::Done(reveal::skip_lines(config, line)));
    }
    Some(reveal::RevealState::Animating(reveal::build_reveal(
        config, line, now,
    )))
}

/// `Action::Advance` 受信時の意思決定（デシジョンテーブル、#472。選択肢分岐対応で #482 拡張）。
/// `Terminal<CrosstermBackend<Stdout>>` という具体型に結合していた `event_loop` から、
/// `playback` / `current_reveal` / `config` / `now` だけを引数に取る純粋関数として切り出し、
/// `TestBackend` 無しでもユニットテストできるようにした。
///
/// | # | 現在位置 | reveal状態 | 次 | 動作 |
/// |---|---|---|---|---|
/// | 1 | 選択肢 | ― | ― | `select_current_choice` で確定を試みる。成功時のみ新しい位置の reveal を組み立て直す（失敗時＝無効な jump 先は選択肢表示のまま no-op） |
/// | 2 | 無し | ― | ― | 何もしない |
/// | 3 | 会話行 | 未完了 | 存在する/最終行 | `skip_lines` で即全文表示、`advance()` は呼ばない |
/// | 4 | 会話行 | 完了 | 存在する | `advance()` → 次item の reveal（`build_reveal_for_current`。Line なら Animating、Choice なら None） |
/// | 5 | 会話行 | 完了 | 最終行 | `advance()` が `false` を返し no-op（`current_reveal` は不変） |
///
/// 選択肢表示中（#1）は Advance（Enter/Space）の意味が「次の行へ進む」から「カーソルが
/// 指す選択肢を確定する」に変わる（`input::Action::Advance` のドキュメント参照）。選択肢の
/// 文言はタイプライター演出の対象外なので、reveal の完了/未完了を問わず常に即座に確定を試みる
/// （#3/#4 のような reveal_done 分岐が不要）。
fn on_advance(
    playback: &mut Playback,
    current_reveal: &mut Option<reveal::RevealState>,
    config: &Config,
    now: Instant,
) {
    if playback.current_choice().is_some() {
        if playback.select_current_choice() {
            *current_reveal = build_reveal_for_current(playback, config, now);
        }
        return;
    }

    if let Some(line) = playback.current_line() {
        let reveal_done = current_reveal
            .as_ref()
            .map(|r| r.is_done(now))
            .unwrap_or(true);
        if !reveal_done {
            // ブラウザ版 NovelRenderer の advanceOrSkipTypewriter と同じ
            // 「表示中の1手目は全文表示へのスキップに専念し、次の行へは
            // 進めない」挙動（カノソ方式）。`skip_lines` は `RevealHandle` の時間計算を
            // 経由しない（#472 セルフレビュー対応）。
            *current_reveal = Some(reveal::RevealState::Done(reveal::skip_lines(config, line)));
        } else if playback.advance() {
            *current_reveal = build_reveal_for_current(playback, config, now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::DisplayLine;
    use ratatui::backend::TestBackend;
    use ratatui::style::Color;
    use std::cell::RefCell;

    fn dline(speaker: Option<&str>, text: &str) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
            event_image: None,
        }
    }

    /// `dline` の event_image 指定版（#481 の event_loop 統合テスト用）。
    fn dline_with_image(
        speaker: Option<&str>,
        text: &str,
        event_image: Option<String>,
    ) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
            event_image,
        }
    }

    /// `w`x`h` px の単色 RGBA バイト列を作る（テストフィクスチャ用）。
    fn solid_rgba(color: (u8, u8, u8), w: u32, h: u32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            buf.extend_from_slice(&[color.0, color.1, color.2, 255]);
        }
        buf
    }

    /// 描画済みバッファのどこかのセルの背景色が `color` と一致するかを走査する。
    fn buffer_has_bg_color(buffer: &ratatui::buffer::Buffer, color: (u8, u8, u8)) -> bool {
        let area = buffer.area();
        (0..area.width).any(|x| {
            (0..area.height)
                .any(|y| buffer.cell((x, y)).unwrap().bg == Color::Rgb(color.0, color.1, color.2))
        })
    }

    /// reveal が即座には完了しない速度設定（境界確認に使う）。
    fn slow_config() -> Config {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000;
        config.typewriter.fade_duration_ms = 0;
        config
    }

    /// reveal が構築と同時に完了する速度設定（「完了済み」の分岐確認に使う）。
    fn instant_config() -> Config {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 0;
        config.typewriter.fade_duration_ms = 0;
        config
    }

    fn animating(
        config: &Config,
        dline: &crate::playback::DisplayLine,
        now: Instant,
    ) -> reveal::RevealState {
        reveal::RevealState::Animating(reveal::build_reveal(config, dline, now))
    }

    #[test]
    fn on_advance_incomplete_reveal_skips_without_advancing_position() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "hello there"),
            dline(Some("B"), "next line"),
        ]);
        let now = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            now,
        ));
        assert!(!current_reveal.as_ref().unwrap().is_done(now));

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 1, "スキップでは位置が進んではいけない");
        assert!(current_reveal.as_ref().unwrap().is_done(now));
    }

    #[test]
    fn on_advance_incomplete_reveal_at_last_line_skips_without_advancing_position() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "only line here")]);
        let now = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            now,
        ));
        assert!(!current_reveal.as_ref().unwrap().is_done(now));

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 1);
        assert!(playback.is_at_end());
        assert!(current_reveal.as_ref().unwrap().is_done(now));
    }

    #[test]
    fn on_advance_complete_reveal_with_next_line_advances_and_starts_new_reveal() {
        let config = instant_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "first"), dline(Some("B"), "second")]);
        let now = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            now,
        ));
        assert!(current_reveal.as_ref().unwrap().is_done(now));

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 2);
        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(current_reveal.is_some());
    }

    #[test]
    fn on_advance_complete_reveal_at_last_line_is_noop() {
        let config = slow_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "first"), dline(Some("B"), "second")]);
        playback.advance(); // 最終行へ
        let t0 = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            t0,
        ));
        // "second" は6グラフェム、char_interval=1000ms・fade=0ms なので
        // t0 + 5000ms で完了する。
        let t_call = t0 + Duration::from_millis(5000);
        assert!(current_reveal.as_ref().unwrap().is_done(t_call));

        on_advance(&mut playback, &mut current_reveal, &config, t_call);

        assert_eq!(playback.position(), 2);
        assert!(playback.is_at_end());
        // no-op であれば current_reveal は t0 起点のまま = t_call 時点で全文表示済み。
        // もし（バグで）t_call を起点に作り直されていたら、最初の1グラフェムしか
        // 見えないはず（char_interval=1000msなので）。
        let lines = current_reveal.as_ref().unwrap().body_lines(t_call);
        assert_eq!(lines[0].spans.len(), "second".chars().count());
    }

    #[test]
    fn on_advance_no_current_line_is_noop() {
        let config = Config::default();
        let mut playback = Playback::from_lines(vec![]);
        let mut current_reveal: Option<reveal::RevealState> = None;
        let now = Instant::now();

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 0);
        assert!(current_reveal.is_none());
    }

    #[test]
    fn on_advance_full_lifecycle_across_two_lines() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "hello there"),
            dline(Some("B"), "second line"),
        ]);
        let t0 = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            t0,
        ));

        // 1行目: reveal中
        assert!(!current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(skip): 全文表示、位置は変わらない
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(playback.position(), 1);
        assert!(current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(進行): 完了済みなので2行目へ進む
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(playback.position(), 2);
        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(!current_reveal.as_ref().unwrap().is_done(t0)); // 2行目 reveal中

        // Advance(skip): 2行目を全文表示
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert!(current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(最終行no-op): 位置は変わらない
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(playback.position(), 2);
        assert!(playback.is_at_end());
    }

    #[test]
    fn on_advance_single_call_never_advances_more_than_one_state() {
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "one"),
            dline(Some("B"), "two"),
            dline(Some("C"), "three"),
        ]);
        let now = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            now,
        ));
        assert_eq!(playback.position(), 1);

        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback.position(),
            2,
            "1回のAdvanceで2行以上進んではいけない"
        );

        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback.position(),
            3,
            "1回のAdvanceで2行以上進んではいけない"
        );
    }

    // ---- #486: sentence_per_page 有効時の on_advance 配線 ----
    //
    // Playback 側（playback.rs）の状態遷移自体は playback.rs のテストで検証済み。ここでは
    // on_advance の「reveal未完了ならskip・完了していれば advance」というデシジョンテーブルが
    // sentence_per_page 有効時にも変更なしで正しく機能する（＝1文ごとに新しい reveal が
    // 始まる）ことを確認する。build_reveal_for_current が playback.current_line() を都度
    // 読み直すだけで自動的に成立する設計であることの回帰ガード。

    #[test]
    fn on_advance_sentence_per_page_skip_then_advance_moves_one_sentence_at_a_time() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "1文目。2文目。")])
            .with_sentence_per_page(true);
        let t0 = Instant::now();
        let mut current_reveal = Some(animating(
            &config,
            playback.current_line().expect("line"),
            t0,
        ));
        assert!(!current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(skip): 1文目を全文表示。Line item は進まない。
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(
            playback.current_line().expect("line").text,
            vec!["1文目。".to_string()]
        );
        assert!(current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(進行): 完了済みなので2文目へ。新しい reveal が始まり未完了に戻る。
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(
            playback.current_line().expect("line").text,
            vec!["2文目。".to_string()]
        );
        assert_eq!(playback.position(), 1, "同一Line item内なのでposition不変");
        assert!(
            !current_reveal.as_ref().unwrap().is_done(t0),
            "2文目用に新しいrevealが始まっているはず"
        );

        // Advance(skip): 2文目を全文表示。
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert!(current_reveal.as_ref().unwrap().is_done(t0));
        assert!(playback.is_at_end());
    }

    // ---- #481 follow-up: event_loop の event_image フェード開始判定（デシジョンテーブル） ----
    //
    // on_advance() 自体（position/reveal の遷移）は上のテスト群で既にカバーされているが、
    // 「position が実際に進んだ時だけ event_image の変化を見てフェードを開始する」という
    // event_loop 側のガード（本体の event_loop 内、on_advance 呼び出し直後のコメント参照）は
    // これまで自動テストで一度も検証されていなかった（手動tmux確認のみ）。

    #[test]
    fn event_loop_advance_crossing_into_new_event_image_switches_placeholder_to_that_image() {
        // デシジョンテーブル#2（None→Some(A)）の統合確認。crossfade_ms=0 にして、
        // トランジション開始直後の描画が実時間経過に依存せず即座に新ターゲットの色を
        // 表示するようにし、決定的なアサーションにする（`ImageFadeState::progress` は
        // duration=0 のとき常に1.0を返す）。
        let fixture_color = (123u8, 45u8, 67u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = instant_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        config.event_image.crossfade_ms = 0;
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "hello", None),
            dline_with_image(Some("B"), "world", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert!(
            buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "advancing into a line with a new event_image should switch the fade target to it"
        );
    }

    #[test]
    fn event_loop_advance_to_same_event_image_path_does_not_restart_fade_timer() {
        // デシジョンテーブル#4（Some(A)→Some(A)、同一パスが連続する行）の回帰ガード:
        // 無駄な再フェードトリガーの防止。crossfade_ms をテスト実行時間よりはるかに
        // 長い60秒にし、最初の None→A フェードがまだ進行中の状態を作る。もし2回目の
        // Advance(A→A、同一パス)が誤って transition_to を再度呼ぶと、from/to が
        // 両方Aになり(同一画像同士の補間は t に関わらず即座にAの色そのものになる、
        // `jiwa::lerp_u8` は a==b なら常に a を返すため)、本来まだ進行中で黒寄りの
        // はずのフェードが「完了して見える」という観測可能な差が出る。これを利用して
        // 再トリガーの有無を検出する。
        let fixture_color = (250u8, 10u8, 10u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = instant_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        config.event_image.crossfade_ms = 60_000;
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "one", None),
            dline_with_image(Some("B"), "two", Some(relative.clone())),
            dline_with_image(Some("C"), "three", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) =
            action_queue(vec![Action::Advance, Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert!(
            !buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "同一パスへの2回目のAdvanceでフェードが再トリガーされ、本来まだ進行中(60秒中の\
             数ms)のはずのフェードが完了して見えてしまっている(無駄な再トリガー、退行)"
        );
    }

    #[test]
    fn event_loop_skip_advance_on_incomplete_reveal_does_not_start_image_fade() {
        // タイプライタースキップ操作（reveal未完了時のAdvance）は position を進めない
        // （on_advance のデシジョンテーブル#2、上のテスト群で確認済み）。event_loop側は
        // それを受けて「position が実際に進んだ時だけ event_image の変化を見る」ガードを
        // 持つ（event_loop 内、on_advance 呼び出し直後のコメント参照）。スキップ操作
        // 単体では次行の event_image を先読みしてフェードを開始したりしないことを確認する。
        let fixture_color = (77u8, 88u8, 99u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = slow_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "hello there this is long enough text", None),
            dline_with_image(Some("B"), "next", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.position(),
            1,
            "スキップではpositionが進んではいけない"
        );
        assert!(
            !buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "スキップ操作(reveal未完了時のAdvance)だけでは次行のevent_imageへフェードが\
             開始されてはいけない"
        );
    }

    // ---- #495 追加修正2: instant-complete reveal での indicator 位相リセット（セルフレビュー
    // must対応） ----
    //
    // `char_interval_ms=0 && fade_duration_ms=0`（タイプライター演出を完全に無効化する設定）
    // では、新しい行の reveal は生成された瞬間に既に完了している。この場合
    // `reveal::indicator_blink_started_at` の「非表示→表示遷移」判定は
    // `show_page_indicator` のフレーム間差分だけでは発火しないため、`event_loop` が
    // `playback.position()` の変化を検知して `indicator_was_shown` を強制的に `false` へ
    // リセットする配線（本体の `Action::Advance` 処理内、`indicator_was_shown = false;` の
    // 行）が無いと、前の行の残り点滅位相を次の行がそのまま引き継いでしまう。この配線は
    // `on_advance`（純粋関数、上のテスト群でカバー済み）を経由しないため、`event_loop` を
    // 実際に走らせる統合テストでしか検証できない。
    #[test]
    fn event_loop_instant_complete_reveal_shows_indicator_immediately_after_advancing_past_a_blink_off_phase(
    ) {
        // 行A表示中にインジケータの点滅基準時刻が記録される（instant_config なので生成直後
        // から表示区間ONで始まる）。その後 `PAGE_INDICATOR_BLINK_PERIOD_MS` を1周期以上
        // （かつ2周期未満、つまり非表示区間=奇数区間の途中）実時間で待ってから行Bへ
        // advance する。`indicator_was_shown` の強制リセットが無ければ、行Bのフレームは
        // 行Aの基準時刻をそのまま引き継ぎ、その時点でたまたま非表示区間に入っているため
        // インジケータが描画されない（退行の再現条件）。修正後は position 変化で基準時刻が
        // `now` にリセットされるため、行Bへ切り替わった直後のフレームは必ず表示区間(ON)から
        // 描画される。
        let config = instant_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "hello"), dline(Some("B"), "world")]);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            if call_count == 1 {
                // 行Aの最初の描画（indicator_started_at が記録された直後）から、1周期
                // 経過後の非表示区間（奇数区間）へ確実に入るまで実時間で待つ。
                std::thread::sleep(std::time::Duration::from_millis(
                    reveal::PAGE_INDICATOR_BLINK_PERIOD_MS + 200,
                ));
                Ok(Action::Advance)
            } else {
                Ok(Action::Quit)
            }
        };

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.position(),
            2,
            "行Bへadvanceしているはず（`position` は1始まりでLine item数を数える）"
        );
        assert!(
            buffer_text(&terminal).contains(reveal::PAGE_INDICATOR_SYMBOL),
            "行Bへ切り替わった直後のフレームは、行Aの残り点滅位相（非表示区間）を \
             引き継がず、必ず表示区間(ON)から点滅が始まっているべき（セルフレビュー \
             must対応の回帰ガード）"
        );
    }

    /// レンダリング済みバッファを1本の文字列に変換する（`ui.rs` のテストヘルパーと
    /// 同じ目的だが、全角文字の cell_width までは main.rs のテストでは問わないため
    /// 単純に symbol を連結するだけの簡略版で足りる）。
    fn buffer_text(terminal: &Terminal<TestBackend>) -> String {
        let buffer = terminal.backend().buffer();
        let area = buffer.area();
        let mut out = String::new();
        for y in 0..area.height {
            for x in 0..area.width {
                out.push_str(buffer.cell((x, y)).expect("in bounds").symbol());
            }
        }
        out
    }

    /// 固定の `Action` 列を順番に返すクロージャを作る。列を使い切った後は
    /// `Action::Quit` を返し続ける（テストが無限ループしないためのフォールバック）。
    /// `remaining` で消費後の残り件数を確認できるようにしておく
    /// （`show_splash_none_action_keeps_looping_and_redraws` が「途中で打ち切られず
    /// 全件を消費してからループを終える」ことを検証するために使う）。
    fn action_queue(
        actions: Vec<Action>,
    ) -> (
        impl FnMut() -> anyhow::Result<Action>,
        std::rc::Rc<RefCell<usize>>,
    ) {
        let remaining = std::rc::Rc::new(RefCell::new(actions.len()));
        let remaining_handle = remaining.clone();
        let mut iter = actions.into_iter();
        let closure = move || {
            let next = iter.next();
            *remaining.borrow_mut() = iter.len();
            Ok(next.unwrap_or(Action::Quit))
        };
        (closure, remaining_handle)
    }

    fn splash_config() -> Config {
        Config {
            splash: crate::config::SplashConfig {
                enabled: true,
                lines: vec!["田".to_string()],
                ..crate::config::SplashConfig::default()
            },
            ..Config::default()
        }
    }

    #[test]
    fn show_splash_advance_action_returns_true_without_entering_event_loop() {
        let config = splash_config();
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(advanced);
    }

    #[test]
    fn show_splash_quit_action_returns_false() {
        let config = splash_config();
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Quit]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(!advanced);
    }

    #[test]
    fn show_splash_none_action_keeps_looping_and_redraws() {
        let config = splash_config();
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, remaining) = action_queue(vec![
            Action::None,
            Action::None,
            Action::None,
            Action::Advance,
        ]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(advanced);
        // 4件（None x3 + Advance）を全て消費してから返ってきたことを確認する。
        // 先頭の Action::None だけでループを抜けてしまう実装退行があれば、
        // ここで remaining が 3 のまま残り失敗する。
        assert_eq!(*remaining.borrow(), 0);
    }

    #[test]
    fn run_screens_skips_splash_when_should_show_splash_is_false() {
        let config = Config::default(); // splash.enabled == false（既定）
        assert!(!config.should_show_splash());
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let document = name_name_parser::parser::parse("");
        let mut playback = Playback::from_document(&document);
        let (mut next_action, _remaining) = action_queue(vec![Action::Quit]);

        run_screens(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        // スプラッシュ用の「Enter / Space で開始」ヒントが一切描画されておらず、
        // event_loop 側の描画（位置表示 "0/0"）だけが出ていることを確認する。
        let text = buffer_text(&terminal);
        assert!(!text.contains("Enter"), "buffer was: {text}");
        assert!(text.contains("0/0"), "buffer was: {text}");
    }

    // ---- フルキャンバス画像表示モードのスクロール配線（#530）----

    /// `splash.logo_image`/`event_image.assets_dir` を実在するWebPフィクスチャへ向けた
    /// `Config` を作る（`splash_config` のテキストモード版に対応する画像モード版）。
    fn image_splash_config(fixture_path: &std::path::Path) -> Config {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        config.splash.logo_image = Some(std::path::PathBuf::from(
            fixture_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        ));
        config
    }

    /// 縦168px・上から4行だけ赤(255,0,0)、残りは青(0,0,255)の正方形WebPフィクスチャ。
    /// contain-fit(比1.0)でスクロールが必要になり、かつグリッド行0(赤)と行1以降(青)が
    /// はっきり色分けされるため、「スクロールオフセットが0のままか、進んだか」を
    /// セルの背景色だけで判別できる（`show_splash_movedown_does_not_instantly_jump_to_target_scroll_offset`
    /// 用）。
    fn banded_scroll_fixture() -> std::path::PathBuf {
        let size: u32 = 168;
        let mut rgba = Vec::with_capacity((size * size * 4) as usize);
        for y in 0..size {
            let color: [u8; 4] = if y < 4 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 255, 255]
            };
            for _x in 0..size {
                rgba.extend_from_slice(&color);
            }
        }
        crate::image_render::write_test_webp_fixture(&rgba, size, size)
    }

    /// 84x84 の正方形画像を、2px ごとの横帯で段階的に赤みを変えたフィクスチャ。
    /// 全幅表示（84列）では総42行になり、各表示行が一意な赤背景を持つため、
    /// 「最下端から1つ戻ったか」を先頭セルの背景色だけで判別できる。
    fn per_row_scroll_fixture() -> std::path::PathBuf {
        let size: u32 = 84;
        let mut rgba = Vec::with_capacity((size * size * 4) as usize);
        for y in 0..size {
            let band = (y / 2) as u8;
            let red = band.saturating_mul(5);
            for _x in 0..size {
                rgba.extend_from_slice(&[red, 0, 0, 255]);
            }
        }
        crate::image_render::write_test_webp_fixture(&rgba, size, size)
    }

    #[test]
    fn show_splash_text_mode_movedown_does_not_change_rendered_output() {
        // デシジョンテーブル: テキストモードはMoveUp/Downでtarget_scroll_offsetこそ内部で
        // 更新されるが、draw_splash自体がテキストモードでは scroll_offset を一切参照しない
        // ため、見た目は変化しないはず。
        let config = splash_config();

        let mut baseline_terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut baseline_action, _r1) = action_queue(vec![Action::Advance]);
        show_splash(&mut baseline_terminal, &config, &mut baseline_action).unwrap();
        let baseline_text = buffer_text(&baseline_terminal);

        let mut moved_terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut moved_action, _r2) = action_queue(vec![
            Action::MoveDown,
            Action::MoveDown,
            Action::MoveDown,
            Action::Advance,
        ]);
        show_splash(&mut moved_terminal, &config, &mut moved_action).unwrap();
        let moved_text = buffer_text(&moved_terminal);

        assert_eq!(
            baseline_text, moved_text,
            "テキストモードはMoveDown連打しても描画結果が変わってはいけない"
        );
    }

    #[test]
    fn show_splash_image_mode_non_scrolling_movedown_does_not_change_rendered_output() {
        // デシジョンテーブル: 画像モードでもスクロール不要な画像なら、MoveDownで
        // target_scroll_offset 自体が max_offset=0 にクランプされるため、見た目は
        // 変化しないはず。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((200, 80, 80), 4, 1), 4, 1);
        let config = image_splash_config(&fixture_path);

        let mut baseline_terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut baseline_action, _r1) = action_queue(vec![Action::Advance]);
        show_splash(&mut baseline_terminal, &config, &mut baseline_action).unwrap();
        let baseline_text = buffer_text(&baseline_terminal);

        let mut moved_terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut moved_action, _r2) = action_queue(vec![
            Action::MoveDown,
            Action::MoveDown,
            Action::MoveDown,
            Action::Advance,
        ]);
        show_splash(&mut moved_terminal, &config, &mut moved_action).unwrap();
        let moved_text = buffer_text(&moved_terminal);

        assert_eq!(
            baseline_text, moved_text,
            "非スクロール画像ではMoveDown連打しても描画結果が変わってはいけない"
        );
    }

    #[test]
    fn show_splash_movedown_does_not_instantly_jump_to_target_scroll_offset() {
        // テスト設計エージェントの申し送り事項3: show_splash は Instant::now() を直接
        // 呼んでおり時刻注入できないため、厳密なタイミング検証はできない。ここでは
        // scroll_ease_ms を十分大きく(60秒)取ることで、テスト実行にかかる実時間(通常
        // 数ミリ秒)ではease進行度がほぼ0のままになる前提を使い、「MoveDown直後に
        // target_scroll_offsetへ瞬時ジャンプしない」という方向性だけを検証する
        // （元の観点57-60を1本に統合、テスト設計エージェントの緩和指示に従う）。
        let fixture_path = banded_scroll_fixture();
        let mut config = image_splash_config(&fixture_path);
        config.splash.scroll_ease_ms = 60_000;

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![
            Action::MoveDown,
            Action::MoveDown,
            Action::MoveDown,
            Action::MoveDown,
            Action::MoveDown,
            Action::Advance,
        ]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();
        assert!(advanced);

        let buffer = terminal.backend().buffer();
        assert_eq!(
            buffer.cell((0, 0)).unwrap().bg,
            Color::Rgb(255, 0, 0),
            "5回MoveDownした直後でもeaseが進む前は先頭行(赤)のままのはず。\
             青(グリッド行1以降の色)になっていたら瞬時ジャンプしている"
        );
    }

    #[test]
    fn show_splash_moveup_after_reaching_bottom_starts_moving_up_again() {
        let fixture_path = per_row_scroll_fixture();
        let mut config = image_splash_config(&fixture_path);
        config.splash.scroll_ease_ms = 0;

        let mut actions = vec![Action::MoveDown; 50];
        actions.push(Action::MoveUp);
        actions.push(Action::Advance);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(actions);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();
        assert!(advanced);

        let total_rows =
            crate::image_render::compute_full_width_rows(84, 84, ui::REQUIRED_TOTAL_WIDTH);
        let visible_rows = ui::REQUIRED_TOTAL_HEIGHT - 1;
        let expected_offset = total_rows.saturating_sub(visible_rows).saturating_sub(1);
        let expected_red = (expected_offset as u8).saturating_mul(5);
        assert_eq!(
            terminal.backend().buffer().cell((0, 0)).unwrap().bg,
            Color::Rgb(expected_red, 0, 0),
            "最下端まで進めた後に↑を1回押したら、表示はただちに1行ぶん上へ戻り始めるはず"
        );
    }

    #[test]
    fn show_splash_moveleft_and_moveright_do_not_change_scroll_offset() {
        // スプラッシュ画面には左右移動の対象となる複数列選択肢が無いため、
        // MoveLeft/MoveRight はNoneと同様に無視されるはず（#482、#508）。
        // スクロール可能な画像でMoveDownによりオフセットを進めた後、MoveLeft/MoveRightを
        // 連打しても描画結果がMoveDownのみの場合と変わらないことを確認する。
        let fixture_path = per_row_scroll_fixture();
        let mut config = image_splash_config(&fixture_path);
        config.splash.scroll_ease_ms = 0;

        let mut baseline_terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut baseline_action, _r1) =
            action_queue(vec![Action::MoveDown, Action::MoveDown, Action::Advance]);
        show_splash(&mut baseline_terminal, &config, &mut baseline_action).unwrap();
        let baseline_text = buffer_text(&baseline_terminal);

        let mut moved_terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut moved_action, _r2) = action_queue(vec![
            Action::MoveDown,
            Action::MoveDown,
            Action::MoveLeft,
            Action::MoveRight,
            Action::MoveLeft,
            Action::Advance,
        ]);
        show_splash(&mut moved_terminal, &config, &mut moved_action).unwrap();
        let moved_text = buffer_text(&moved_terminal);

        assert_eq!(
            baseline_text, moved_text,
            "MoveLeft/MoveRightを挟んでもスクロールオフセットは変化してはいけない"
        );
    }

    #[test]
    fn show_splash_advance_interrupts_image_mode_scrolling_and_returns_true_immediately() {
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((10, 20, 30), 1, 1), 1, 1);
        let config = image_splash_config(&fixture_path);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, remaining) =
            action_queue(vec![Action::MoveDown, Action::MoveDown, Action::Advance]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(
            advanced,
            "画像モードのスクロール操作の途中でもAdvanceは即座にOk(true)で返るはず"
        );
        assert_eq!(
            *remaining.borrow(),
            0,
            "MoveDown x2 + Advance の3件をすべて消費してから返っているはず"
        );
    }

    #[test]
    fn run_screens_shows_splash_when_logo_image_is_set_without_lines() {
        // #530: logo_image のみが設定されていて lines が空でも should_show_splash() は
        // true になる(Config::should_show_splashのテストで確認済み)ため、run_screensは
        // スプラッシュをスキップしてはいけない。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((10, 20, 30), 4, 1), 4, 1);
        let config = image_splash_config(&fixture_path);
        assert!(
            config.should_show_splash(),
            "logo_imageのみ設定でもshould_show_splashはtrueのはず"
        );
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let document = name_name_parser::parser::parse("");
        let mut playback = Playback::from_document(&document);
        let (mut next_action, _remaining) = action_queue(vec![Action::Quit]);

        run_screens(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        // スプラッシュがスキップされていれば、この唯一のQuitはevent_loopへ渡り
        // "0/0" の位置表示が出るはず。実際にはスプラッシュ(画像モード)がまず表示され、
        // そこでQuitされて終わる(本編のevent_loopへは進まない)ことを確認する。
        let text = buffer_text(&terminal);
        assert!(
            text.contains("Enter"),
            "スプラッシュ(画像モード)のヒントが表示されているはず, buffer was: {text}"
        );
        assert!(
            !text.contains("0/0"),
            "event_loopの位置表示は出ていない(本編へ進んでいない)はず, buffer was: {text}"
        );
    }

    // ---- #482: on_advance の選択肢分岐（Choice/jump）配線テスト ----
    //
    // `Playback::from_lines` は会話行専用のテスト用コンストラクタで Choice を作れないため、
    // ここだけ実際の Markdown を `parser::parse` した `Document` 経由で `Playback` を作る
    // （playback.rs 側の jump 解決そのものの単体テストは `playback.rs` にあるので、ここでは
    // 「on_advance 経由で正しく呼び分けられているか」という配線だけを確認する）。
    fn choice_branch_source() -> &'static str {
        "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n最初のセリフ\n\n[選択]\n- 進む→1-2\n[/選択]\n\n## 1-2: 次\n\n**B**:\n次のセリフ\n"
    }

    #[test]
    fn on_advance_choice_selection_jumps_to_target_scene_and_starts_new_reveal() {
        let config = instant_config();
        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal = build_reveal_for_current(&playback, &config, now);

        // 最初のセリフ → Choice へ進む（reveal は instant_config なので即完了している）。
        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert!(playback.current_choice().is_some());
        assert!(
            current_reveal.is_none(),
            "選択肢表示中は reveal を持たないはず"
        );

        // Choice を確定（カーソルは既定で先頭の唯一の選択肢）→ jump 先シーンの1行目が current になる。
        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback
                .current_line()
                .expect("jump先の会話行")
                .speaker
                .as_deref(),
            Some("B")
        );
        assert!(
            current_reveal.is_some(),
            "jump後の会話行のrevealが組み立てられているはず"
        );
    }

    #[test]
    fn on_advance_choice_selection_with_invalid_jump_leaves_choice_displayed() {
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n[選択]\n- 行き先不明→does-not-exist\n[/選択]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(
            playback.current_choice().is_some(),
            "無効なjump先では選択肢表示のまま変わらないはず"
        );
        assert!(current_reveal.is_none());
    }

    #[test]
    fn choice_immediately_followed_by_another_choice_keeps_reveal_none_after_jump() {
        // jump先シーンの先頭itemがまたChoiceであるケース（連続分岐）。build_reveal_for_current
        // は current_line() が None（＝現在Choice）のとき None を返すため、jump直後も
        // current_reveal は None のまま維持されるはず。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n[選択]\n- 進む→1-2\n[/選択]\n\n## 1-2: 次\n\n[選択]\n- さらに進む→1-3\n[/選択]\n\n## 1-3: 最後\n\n**C**:\n最後のセリフ\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal = build_reveal_for_current(&playback, &config, now);
        assert!(
            current_reveal.is_none(),
            "開始直後はChoiceなのでrevealは無いはず"
        );

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(
            playback.current_choice().is_some(),
            "jump先の先頭itemも再びChoiceのはず"
        );
        assert!(
            current_reveal.is_none(),
            "jump先がChoiceの場合はrevealを持たないはず"
        );
    }

    #[test]
    fn on_advance_rapid_double_advance_after_valid_jump_does_not_double_jump() {
        // jump成功直後にもう一度 on_advance を呼んでも、2回連続でjumpが発生しない
        // （2回目の呼び出し時点では current_choice() が None になっているため、
        // select_current_choice ではなく通常の1行分の advance だけが起こる）ことを確認する。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n[選択]\n- 進む→1-2\n[/選択]\n\n## 1-2: 次\n\n**B**:\n最初のセリフ\n\n**C**:\n次のセリフ\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal = build_reveal_for_current(&playback, &config, now);

        // 1回目: Choice確定 → "1-2" の先頭行 "B" へjump。
        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback
                .current_line()
                .expect("jump先の会話行")
                .speaker
                .as_deref(),
            Some("B"),
            "1回目の呼び出しでjump先の1行目(B)に到達するはず"
        );
        assert_eq!(playback.position(), 1);

        // 2回目（rapid double advance）: 既にChoiceではないため、jumpは再発生せず
        // 通常の1行送り（B→C）だけが起こるはず。
        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback
                .current_line()
                .expect("2回目の会話行")
                .speaker
                .as_deref(),
            Some("C"),
            "2回目の呼び出しはBからCへの1行送りだけのはず（2回連続jumpしない）"
        );
        assert_eq!(playback.position(), 2, "1回のadvanceにつき1行だけ進むはず");
    }

    // ---- #497: イベント絵の時間差自動連続表示（event_loop のタイマー駆動・回帰） ----
    //
    // `Playback::from_lines` は画像コマ item（`PlaybackItem::Image`）を作れないため、
    // ここでは実際の Markdown を `parser::parse` した `Document` 経由で `Playback` を作る
    // （`choice_branch_source` と同じ理由）。

    /// 画像コマ自動送り(#497)のタイマー系テスト用: 手動入力を一切行わず（常に`Action::None`）
    /// 実時間経過だけで自動advanceが起こるのを待つ。`timeout`を超えても終わらない場合は
    /// バグ（締切機構が壊れて自動送りが起きない）とみなし`Action::Quit`を返してループを
    /// 強制終了する安全弁——こうしておかないとバグ混入時にテストプロセスごとハングする。
    fn passive_next_action(timeout: Duration) -> impl FnMut() -> anyhow::Result<Action> {
        let start = Instant::now();
        move || -> anyhow::Result<Action> {
            if start.elapsed() > timeout {
                return Ok(Action::Quit);
            }
            Ok(Action::None)
        }
    }

    #[test]
    fn event_loop_auto_advances_past_image_item_after_wait_ms_elapses_without_key_input() {
        // テーブル2#1〜3の統合確認: 手動入力を一切送らなくても、[待機:ms]経過後は
        // event_loopが自分でAction::Advance相当を合成して次のitemへ進む。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: a.webp]\n[待機: 20]\n\n**B**:\nnext\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        // 画像コマitemへは決定的な手動advanceで進めておき、本テストの主眼である
        // 「その後の自動送り」だけを検証する。
        playback.advance();
        assert_eq!(playback.pending_wait_ms(), Some(20));

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut next_action = passive_next_action(Duration::from_secs(2));

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B"),
            "手動入力(Advance)を一度も送っていないのに、[待機:20]の経過で自動的にBへ\
             進んでいるはず（テーブル2#1〜3）。2秒のタイムアウトに達した場合は\
             この自動送りが機能していない"
        );
    }

    #[test]
    fn event_loop_image_item_reveal_is_done_immediately_even_with_slow_typewriter_config() {
        // build_reveal_for_current は pending_wait_ms が Some の間、slow_config
        // （char_interval_ms=1000）でもタイプライターを経由せず即座に RevealState::Done を
        // 返すはず。もしここが Animating のままだと、[待機:ms]の経過後に advance しようと
        // しても on_advance が「reveal未完了」と判定してタイプライタースキップに専念して
        // しまい、自動送りが char_interval_ms 分だけ遅延する（main.rs のコメント参照）。
        let config = slow_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\nhello there this text is long\n\n[イベント絵: a.webp]\n[待機: 30]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        playback.advance(); // 画像コマitemへ
        assert_eq!(playback.pending_wait_ms(), Some(30));

        let now = Instant::now();
        let reveal = build_reveal_for_current(&playback, &config, now)
            .expect("画像コマitemもrevealを持つはず");

        assert!(
            reveal.is_done(now),
            "画像コマitemのrevealは生成直後から完了済み(Done)であるべき（slow_configでも）"
        );
    }

    #[test]
    fn event_loop_manual_advance_before_wait_deadline_skips_immediately() {
        // テーブル2#4: 締切前でも手動Advanceが来ればタイマーを待たず即座に進む。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: a.webp]\n[待機: 60000]\n\n**B**:\nnext\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // 60秒待機を指定しているが、手動でAdvance x2 (A→画像コマ、画像コマ→B) を
        // 送るのでタイマーが発火するより先にBへ到達しなければならない。
        let (mut next_action, _remaining) =
            action_queue(vec![Action::Advance, Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B"),
            "60秒待機を指定していても、手動Advanceがタイマーより先に効いて即座に \
             進むはず"
        );
    }

    #[test]
    fn event_loop_crossing_into_image_item_triggers_crossfade_via_item_index_not_position() {
        // 核心回帰ガード: 既存の
        // `event_loop_advance_crossing_into_new_event_image_switches_placeholder_to_that_image`
        // (#481)と同じ形の検証を、画像コマitem(#497)に対して行う。画像コマへの遷移は
        // position()を変えない(Line itemではないため)ので、event_loop内でitem_index()
        // 経由の判定に乗り換えていないとクロスフェードを取りこぼす。
        // [待機:]は非常に大きい値にして、自動送りタイマーが本テストの短い実行時間中に
        // 割り込まないようにする（本テストの主眼はクロスフェード判定であってタイマーでは
        // ない）。
        let fixture_color = (200u8, 20u8, 40u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = instant_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        config.event_image.crossfade_ms = 0;
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let source = format!(
            "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: {relative}]\n[待機: 999999]\n"
        );
        let document = name_name_parser::parser::parse(&source);
        let mut playback = Playback::from_document(&document);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert!(
            buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "position()を変えない画像コマitemへの遷移でも、item_index()の変化を見て \
             クロスフェードが開始されるはず"
        );
    }

    #[test]
    fn event_loop_indicator_resets_when_crossing_into_image_item() {
        // #495 の indicator 位相リセット配線（`playback.item_index() != item_index_before_action`）
        // が画像コマ item（#497）への遷移でも機能することを確認する。もし実装が
        // `position()`のままだったら（画像コマはposition不変のため）ここでリセットが
        // 起こらず、直前の残り点滅位相（非表示区間）をそのまま引き継いでしまう
        // （`event_loop_instant_complete_reveal_shows_indicator_immediately_after_advancing_past_a_blink_off_phase`
        // と同じ手法）。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: a.webp]\n[待機: 999999]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            if call_count == 1 {
                // 会話行Aの最初の描画（indicator_started_atが記録された直後）から、
                // 1周期経過後の非表示区間（奇数区間）へ確実に入るまで実時間で待つ。
                std::thread::sleep(std::time::Duration::from_millis(
                    reveal::PAGE_INDICATOR_BLINK_PERIOD_MS + 200,
                ));
                Ok(Action::Advance)
            } else {
                Ok(Action::Quit)
            }
        };

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert!(
            buffer_text(&terminal).contains(reveal::PAGE_INDICATOR_SYMBOL),
            "画像コマitemへ切り替わった直後のフレームは、直前の残り点滅位相（非表示区間）を \
             引き継がず、必ず表示区間(ON)から点滅が始まっているべき"
        );
    }

    #[test]
    fn event_loop_terminal_image_item_with_wait_ms_zero_does_not_starve_input_forever() {
        // 最重要回帰テスト: 修正コミットf7e16c1で直したバグ。wait_ms=0かつ画像コマが
        // items末尾(advanceできない)の組み合わせだと、修正前は`wait_deadline`が永久に
        // 引き直され続け、next_action()(実際にはキー入力を読む唯一の経路)が二度と
        // 呼ばれず入力が完全に固まった。event_loopを別スレッドで実行し、有限時間内に
        // Quitアクションが読まれてループを抜けられることをタイムアウト付きで確認する。
        // バグが再発してもテストプロセス自体をハングさせないよう、joinはせず
        // channelのrecv_timeoutで待つ。
        let source =
            "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: a.webp]\n[待機: 0]\n";

        // 事前確認: 末尾の画像コマ(wait_ms=0)に位置していることを確認する。
        let document = name_name_parser::parser::parse(source);
        let mut check_playback = Playback::from_document(&document);
        check_playback.advance();
        assert!(check_playback.is_at_end());
        assert_eq!(check_playback.pending_wait_ms(), Some(0));

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let config = instant_config();
            let document = name_name_parser::parser::parse(source);
            let mut playback = Playback::from_document(&document);
            playback.advance();
            let mut terminal = Terminal::new(TestBackend::new(
                ui::REQUIRED_TOTAL_WIDTH,
                ui::REQUIRED_TOTAL_HEIGHT,
            ))
            .unwrap();
            // 実際のキー入力の代わりに、呼ばれるたびにQuitを返すフェイクの入力源。
            // バグが再発した場合、このクロージャは一度も呼ばれずevent_loopが無限ループする。
            let mut next_action = move || -> anyhow::Result<Action> { Ok(Action::Quit) };
            let result = event_loop(&mut terminal, &config, &mut playback, &mut next_action);
            let _ = tx.send(result.is_ok());
        });

        let finished = rx.recv_timeout(Duration::from_secs(5));
        assert!(
            finished.is_ok(),
            "wait_ms=0かつ末尾の画像コマでnext_action()が二度と呼ばれず入力が固まった \
             (修正コミットf7e16c1が直したバグの再発)"
        );
        assert!(finished.unwrap(), "event_loopがエラーで終了した");
    }

    #[test]
    fn event_loop_wait_deadline_boundary_now_equal_to_deadline_is_treated_as_elapsed() {
        // テーブル2#2/#3: `now >= deadline`（等号を含む）で経過扱いにする実装であることを、
        // 「ちょうどwait_ms分だけ眠ってから1回だけnext_action()を呼ぶ」形で確認する。
        // next_actionの呼び出しを2回（1回目sleep後にNone、2回目はQuit）に制限しても
        // 自動advanceが成立することで、境界を跨いですぐに検出できている（＝過ぎるまで
        // 余分な周回を要しない）ことを確認する。
        let config = instant_config();
        let wait_ms = 20u64;
        let source = format!(
            "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: a.webp]\n[待機: {wait_ms}]\n\n**B**:\nnext\n"
        );
        let document = name_name_parser::parser::parse(&source);
        let mut playback = Playback::from_document(&document);
        playback.advance(); // 画像コマitemへ

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            if call_count == 1 {
                std::thread::sleep(Duration::from_millis(wait_ms));
                Ok(Action::None)
            } else {
                Ok(Action::Quit)
            }
        };

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B"),
            "wait_ms経過ちょうどのタイミングで経過扱い(>=)になり自動advanceして \
             いるはず。next_actionは2回しか呼んでいない(1回目sleep後にNone、2回目は \
             Quit)ため、境界を跨いですぐに検出できていることを保証する"
        );
    }

    #[test]
    fn event_loop_auto_advances_through_chain_of_three_event_images_without_manual_advance() {
        // テーブル1#3のランタイム統合版: 3連続のEventImage+Waitを、手動Advanceを一度も
        // 送らずに最後まで自動で通過できるはず。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\nhello\n\n[イベント絵: a.webp]\n[待機: 10]\n[イベント絵: b.webp]\n[待機: 10]\n[イベント絵: c.webp]\n[待機: 10]\n\n**B**:\ndone\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        playback.advance(); // 最初の画像コマ(a.webp)へ

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut next_action = passive_next_action(Duration::from_secs(3));

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B"),
            "手動Advanceを一度も送らずに3連続の画像コマ(a→b→c)を経てBまで自動で \
             進んでいるはず"
        );
    }
}
