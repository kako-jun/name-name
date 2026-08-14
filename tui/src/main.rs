mod ambient_effects;
mod audio;
mod cli;
mod config;
mod flags;
mod image_fade;
mod image_render;
mod input;
mod multi_doc;
mod pixelate_transition;
mod playback;
mod reveal;
mod save;
mod sentence;
mod ui;

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::Context;
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::Terminal;

use cli::Cli;
use config::{
    decrement_volume_percent, increment_volume_percent, percent_to_volume_scale, Config,
    TEXT_SPEED_MAX_MS, TEXT_SPEED_STEP_MS,
};
use input::Action;
use playback::{DisplayLine, Playback};
use ui::SettingsField;

/// 描画の再チェック間隔。タイプライター演出（`jiwa::RevealHandle`）はフレームごとの
/// `snapshot` で動くため、キー入力が無くてもこの間隔で再描画してアニメーションを進める
/// （kako-jun/type-globe の `quiz.rs` の `REDRAW` と同じ値）。
const REDRAW: Duration = Duration::from_millis(30);

/// バックログ画面（#500）で ↑/↓ 1回あたりスクロールする行数。GUI版
/// `BacklogOverlay.handleKeyScroll` の `LINE_HEIGHT * 3`（1回で3行ぶん動く）と同じ
/// 「数行まとめて動く」感覚をセル単位で踏襲する。
const BACKLOG_SCROLL_STEP: u16 = 3;

/// ゲーム画面より前面に描画するフルスクリーンオーバーレイ。開いている間、`event_loop` は
/// 会話の進行（オート/スキップモードのタイマー判定・`Action::Advance` 等）を一切実行せず
/// 完全に凍結する — バックログ（#500 Issue本文「バックログを閉じると元のゲーム画面に戻る
/// (ゲーム進行状態は変化しない、閲覧専用)」という明示要件）・設定画面（#503、値を調整して
/// いる最中に裏で会話が進むのは直感に反するため、バックログと同じ扱いにする）共通の方針。
///
/// **ただし reveal のタイプライター時間経過（`current_reveal`）とイベント絵クロスフェード
/// （`image_fade`）は、この「凍結」の対象外だった（セルフレビュー must対応）**。
/// どちらも `Instant` アンカーからの経過時間で見た目を計算する設計のため、オーバーレイが
/// 開いている間に更新・描画を止めても、アンカー自体は現実の時計と共に進み続ける。閉じた
/// 瞬間に初めて経過時間が読まれるため、開いていた実時間がそのままタイプライター表示の
/// 進行やクロスフェードの進行に漏れ込んでしまう（レビュアー実機再現: `char_interval_ms=1000`
/// で表示途中にバックログを開き実時間1.5秒待ってから閉じると、閉じた直後に1〜2文字余分に
/// 表示される）。`event_loop` は閉じる際に `close_overlay` を呼び、開いていた実時間ぶん
/// 両者のアンカーを前進させることでこの漏れを補正する（`close_overlay` のdoc comment参照）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Overlay {
    /// 通常のゲーム画面。
    None,
    /// バックログ（既読ログ）閲覧画面（#500）。
    Backlog,
    /// テキスト速度設定画面（#503）。
    Settings,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse(std::env::args());

    let mut config = match &cli.config_path {
        Some(path) => Config::load(path)
            .with_context(|| format!("config読み込みに失敗しました: {}", path.display()))?,
        None => Config::default(),
    };
    // #579: 自動クイックセーブ/ロードの保存先は `--config` の指定有無だけから決まる
    // 「実行時だけ決まる値」（`Config::quicksave_path` のdoc comment参照）。TOMLでは
    // 設定できないため、config読み込み後にここで差し込む。
    config.quicksave_path = Some(save::quicksave_path(&cli));

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
    // #579: 自動クイックロード。`skip_leading_empty_scenes` より前に差し込む —
    // 保存済みのシーンへ復元できた場合、それが「本来の先頭シーン」の扱いに優先する
    // （`skip_leading_empty_scenes` は保存データが無い/復元失敗時の通常起動でのみ
    // 意味を持てばよく、復元後の着地シーンを巻き戻して壊してはならない）。
    // 復元の成否（`bool`）は `playback_restored` として `run`/`run_screens`/`event_loop`
    // まで運ぶ（#579 追加修正）——`restore_playback` が `false`（保存済みscene_idが
    // 現在の原稿の `scene_index_by_id` に無い等）の場合、`playback` はflags未適用・
    // 先頭シーンの初期状態のまま止まる（`Playback::has_scene_id` のガードによる
    // アトミック性）。この状態で `event_loop` 側の `read_positions` だけ古い保存データを
    // 復元してしまうと、「playbackは初期状態なのにread_positionsだけ別原稿を指した値が
    // 残る」という非対称な不整合が起きるため、`playback_restored` が `true` の時だけ
    // `event_loop` に `read_positions` を復元させる。
    // #622: `--new-game` は既存のクイックセーブを無視して必ず script_dir の
    // entry_script 先頭（hubの10択画面）から新規開始するためのフラグ。
    // クイックセーブファイルは削除する方針（以後は通常起動でも「続きから」＝
    // 今回の新規開始が自然に続きになる体験にするため）。ファイルが存在しなくても
    // エラーにはしない。削除した場合は `restore_playback` の呼び出し自体を
    // スキップし、`playback_restored` は `false` のままにする。
    let mut playback_restored = false;
    if let Some(path) = &config.quicksave_path {
        playback_restored = apply_new_game_or_restore(cli.new_game, &mut playback, path)?;
    }
    skip_leading_empty_scenes(&mut playback);

    run(&config, &mut playback, playback_restored)
}

/// #622: `--new-game`ならクイックセーブを削除してrestoreをスキップし、
/// それ以外は従来通りrestore_playbackする。戻り値はplayback_restored。
fn apply_new_game_or_restore(
    new_game: bool,
    playback: &mut Playback,
    quicksave_path: &Path,
) -> anyhow::Result<bool> {
    if new_game {
        if quicksave_path.exists() {
            std::fs::remove_file(quicksave_path).with_context(|| {
                format!(
                    "クイックセーブファイルの削除に失敗しました: {}",
                    quicksave_path.display()
                )
            })?;
        }
        Ok(false)
    } else {
        Ok(save::restore_playback(playback, quicksave_path))
    }
}

/// #564: `Playback` 構築完了直後の時点で、先頭シーンが Line/Choice/Image を1つも
/// 持たない（フラグ設定イベントだけの `game_init` 等）場合、`current_choice()` も
/// `current_line()` も両方 `None` のまま最初の描画フレームを迎えてしまい、
/// 「(会話行がありません)」が一瞬見える（kako-jun実機テストで発見）。
///
/// `on_advance`（#558）の C1 分岐（現在位置に Line/Choice どちらも無ければ
/// `advance()` を試みる）と同じ理屈だが、あちらはキー入力（`Action::Advance`）が
/// 一度入ってから初めて呼ばれるため、起動直後・最初のキー入力前の1フレームは
/// カバーできない。ここで `main()` のセットアップ末尾・`run()` 呼び出し直前に
/// 同じ判定を1回だけ行っておくことで、最初の描画フレームが既に先頭の会話行/選択肢を
/// 指した状態になる。
///
/// `advance()` は内部にスキップループを持つため（`Playback::advance` 参照）、
/// 空シーンが複数連続していても1回の呼び出しで次に item を持つシーンまで到達する
/// （呼び出しは1回で足りる）。`current_reveal` はまだ構築されていない
/// （`event_loop` の冒頭でこの後の状態を見て初めて作られる）ため、ここでは
/// `Playback` の位置を進めるだけで良い。
///
/// **起動時セットアップでのみ呼ぶ想定** — `event_loop` 内の通常フローには
/// `on_advance` の C1 分岐が既にあるため、ここで二重に呼ぶ必要はない。
fn skip_leading_empty_scenes(playback: &mut Playback) {
    if playback.current_choice().is_none() && playback.current_line().is_none() {
        playback.advance();
    }
}

/// 端末を alternate screen + raw mode に切り替えて再生ループを回す。
/// ループを抜けたら（正常終了・エラーいずれの場合も）必ず端末状態を元に戻す。
/// ratatui/crossterm 内部などで予期しない panic が起きた場合も、デフォルトの
/// panic フックが呼ばれる前に端末状態を復元し、raw mode + alternate screen の
/// まま固まってユーザーが `reset` を打つ羽目になるのを防ぐ。
///
/// `playback_restored`は`main()`の`save::restore_playback`呼び出しの成否をそのまま
/// `run_screens`/`event_loop`へ運ぶだけの値（#579 追加修正、詳細は`main()`のコメント参照）。
fn run(config: &Config, playback: &mut Playback, playback_restored: bool) -> anyhow::Result<()> {
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

    // 音声出力デバイスを初期化すると同時に `config.volume` を反映する（#502／起動時同期は#537）。
    // SSH経由・headless環境等でデバイスが無い場合は `None` になるが、これはエラーではない —
    // `event_loop` はその場合 BGM/SE の状態追跡だけ行い実際の再生呼び出しをスキップして進行を
    // 続ける（`audio::AudioPlayer::try_new` のdoc comment参照）。
    //
    // `try_new` が `&config.volume` を必須引数として要求するため、「音量を渡さずに
    // `AudioPlayer` を生成する」経路自体が存在しない——生成と起動時同期を分離した2段階の
    // 設計（`try_new()` → 別行で `sync_startup_volume(...)`）だった当初は、後者の呼び出しを
    // 削除しても `cargo test` が気づけないという構造的な穴があった（`audio::AudioPlayer::try_new`
    // のdoc comment参照）。GUI版 `NovelPlayer.tsx` がinit完了直後に `applySettings` を呼ぶのと
    // 同じ役割を、ここでは1回の生成呼び出しに統合している。
    let mut audio_player = audio::AudioPlayer::try_new(&config.volume);

    // タイプライター演出（`jiwa::RevealHandle`）とページ送りインジケータ
    // （`reveal::blink_visible` による1秒周期の完全on/off点滅、#495）は
    // どちらも時間経過だけで見た目が変わるため、キー入力の有無に関わらず `REDRAW` 間隔で
    // 再描画するポーリング方式にする（#472）。この `next_action` は `run_screens` を通じて
    // `show_splash`/`event_loop` の両方へ渡り、スプラッシュ画面もこの間隔で再描画されるが、
    // 静的な画面なので実害はない。
    let result = run_screens(
        &mut terminal,
        config,
        playback,
        &mut || input::poll_action(REDRAW),
        audio_player.as_mut(),
        playback_restored,
    );

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
///
/// `playback_restored`は`event_loop`へそのまま渡すだけ（#579 追加修正、`main()`の
/// コメント参照）。スプラッシュ画面自体は保存/復元と無関係なため参照しない。
fn run_screens<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    playback: &mut Playback,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
    audio: Option<&mut audio::AudioPlayer>,
    playback_restored: bool,
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
    event_loop(
        terminal,
        config,
        playback,
        next_action,
        audio,
        playback_restored,
    )
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
/// `scroll_anim_start` をその場で取り直した `Instant::now()` にリセットする点も
/// （ループ先頭で取得した `now` は `next_action()?` のブロッキング待ち分だけ古くなるため
/// 使わない）`ImageFadeState::transition_to` と同じ設計）。
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
                // 開始時刻はここで取り直す（ループ先頭の`now`は`next_action()?`の
                // ブロッキング待ち分だけ古くなっているため、`event_loop`の
                // `image_fade.transition_to`呼び出しと同じ設計に合わせる）。
                scroll_anim_start_offset = display_scroll_offset;
                scroll_anim_start = Instant::now();
                let max_offset = ui::splash_max_scroll_offset(config, &mut image_cache);
                // MoveDown側で既にmax_offsetにクランプ済みのため理論上ここでの`.min`は
                // 到達不能だが、MoveDown側との対称性のために残している。
                target_scroll_offset = target_scroll_offset.saturating_sub(1).min(max_offset);
            }
            Action::MoveDown => {
                scroll_anim_start_offset = display_scroll_offset;
                scroll_anim_start = Instant::now();
                let max_offset = ui::splash_max_scroll_offset(config, &mut image_cache);
                target_scroll_offset = target_scroll_offset.saturating_add(1).min(max_offset);
            }
            // スプラッシュ画面には左右移動の対象となる複数列選択肢が無いため、無視する(#482、#508)。
            // オート/スキップモードもバックログ/設定画面も無いため、各種トグルも合わせて
            // 無視する（#498 / #499 / #500 / #503）。
            Action::MoveLeft
            | Action::MoveRight
            | Action::ToggleAuto
            | Action::ToggleSkip
            | Action::ToggleBacklog
            | Action::ToggleSettings
            | Action::None => {}
        }
    }
}

/// イベント絵の遷移（Fade/Pixelate、#583）で使うクロスフェード所要時間 (ms) を決定する
/// (dev-doctrine 規約3: `event_loop` 本体に計算ロジックを直書きせず純粋関数に切り出す)。
///
/// 通常の Fade 遷移は常に `crossfade_ms`（グローバル設定）を使う。`Event::EventImage`/
/// `EventImageExit` が持つイベント個別の `フェード=N`（`event_image_fade_ms`）指定は
/// 意図的に読み捨てている（MVPスコープの簡略化、#481、非回帰）。ピクセレート遷移
/// (#583) だけは Issue の要件どおり per-event `フェード=N` を「遷移全体の所要時間」
/// として尊重し、未指定なら同じ `crossfade_ms` を既定値として使う。
///
/// この Fade/Pixelate 間の非対称は意図的な仕様であり、バグではない
/// (`docs/architecture.md` 「イベント絵ピクセレート遷移 (#583)」/
/// `docs/spec/markdown-v0.1.md` の `フェード` 節を参照)。
fn resolve_event_image_transition_duration_ms(
    transition: name_name_parser::models::EventImageTransition,
    target_fade_ms: Option<u32>,
    crossfade_ms: u64,
) -> u64 {
    match transition {
        name_name_parser::models::EventImageTransition::Pixelate => {
            target_fade_ms.map(u64::from).unwrap_or(crossfade_ms)
        }
        name_name_parser::models::EventImageTransition::Fade => crossfade_ms,
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
///
/// `playback_restored`は、呼び出し元（`main()`）が`save::restore_playback`を呼んだ結果
/// （保存済みscene_idが現在の原稿に実在し、実際に`playback`へ復元できたか）をそのまま
/// 受け取る（#579 追加修正）。`false`（保存データ無し／復元失敗）の場合は`read_positions`の
/// 復元も行わない — `playback`が初期状態のままなのに`read_positions`だけ古い（場合によっては
/// 別原稿を指す）値が残る非対称な不整合を防ぐため（下の`read_positions`初期化コメント参照）。
fn event_loop<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    playback: &mut Playback,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
    mut audio: Option<&mut audio::AudioPlayer>,
    playback_restored: bool,
) -> anyhow::Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    // テキスト速度をプレイ中に変更できるようにするため（#503）、以後この関数内では
    // 呼び出し元から借りた `&Config` ではなく、この関数がオーナーシップを持つ可変コピーを
    // 使う。イベント絵/配色/スプラッシュ等 typewriter 以外の設定値をプレイ中に書き換える
    // 手段は無いため実質的に不変のままだが、`config.typewriter.char_interval_ms` だけは
    // 下の `Overlay::Settings` 分岐（`Action::MoveUp`/`Action::MoveDown` の文脈依存の再利用）
    // が書き換える。
    let mut config = config.clone();

    let mut current_reveal: Option<reveal::RevealState> =
        build_reveal_for_current(playback, &config, Instant::now());
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
        playback
            .current_line()
            .map(|line| line.event_image_effects)
            .unwrap_or_default(),
    );

    // BGM（宣言的 state）/ SE（ワンショットトリガ）の再生状態（#502）。`current_bgm_path`/
    // `last_se_cursor` はどちらも「実際に音を鳴らす副作用を起こす」ための直前状態で、
    // `image_fade` と同様に開始時点の値で初期化してから毎フレーム同期する
    // （`sync_bgm`/`play_new_se_cues` のdoc comment参照）。ここで一度呼ぶことで、
    // 原稿の先頭に `[BGM:]`/`[SE:]` がある場合も advance を待たず起動直後から再生される。
    let mut current_bgm_path: Option<String> = None;
    sync_bgm(
        &mut current_bgm_path,
        playback,
        &config,
        audio.as_deref_mut(),
    );
    let mut last_se_cursor: Option<usize> = None;
    play_new_se_cues(&mut last_se_cursor, playback, &config, audio.as_deref_mut());

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

    // オートモード（#498、GUI版 `NovelRenderer.autoMode`/`scheduleAutoAdvance` 相当）の
    // 状態。`auto_deadline` は「現在行の reveal が完了してから `config.auto_wait_ms` 後」の
    // 締切で、これを過ぎたらプレイヤーの入力を待たずに `Action::Advance` を合成する
    // （#497 の `wait_deadline` と同じ「`Action` 経由にせず直接合成する」設計）。
    let mut auto_mode = false;
    let mut auto_deadline: Option<Instant> = None;

    // スキップモード（#499、GUI版 `NovelRenderer.setSkipMode`/`scheduleSkipStep` 相当）の
    // 状態。GUI版はセーブファイルの永続化された既読進捗（`readProgress`）を使う。TUI側は
    // 当初ランタイム中だけのメモリ上の既読集合として実装していた（#499 Issue本文の
    // 「永続化はスコープ外」指示どおり）が、#579 の自動クイックセーブ/ロードで
    // `read_positions` 自体もセーブデータへ含めることになったため、起動時は
    // `save::restore_read_positions` で前回セッションの既読集合を復元する
    // （`config.quicksave_path` が `None` — 主に `Config::default()` を直接使うテスト —
    // なら従来どおり空集合から始まる）。
    //
    // ただし復元は `playback_restored`（引数、`save::restore_playback` の戻り値）が
    // `true` の時に限る（#579 追加修正）。`restore_playback` は保存済みscene_idが現在の
    // 原稿の `scene_index_by_id` に存在しない場合（原稿変更等）、flagsも位置も一切変更せず
    // `false` を返すアトミックな設計になっている——この場合 `playback` は構築直後の初期状態
    // （先頭シーン・flags未適用）のまま止まる。ここで `playback_restored` を見ずに
    // `read_positions` だけ独立に復元すると、「`playback` は初期状態なのに
    // `read_positions` だけ古い（場合によっては別原稿を指す）値が残る」という非対称な
    // 不整合が生じる（kako-jun指摘、Issue #579 フォローアップ）。`playback_restored` が
    // `false` の場合は空集合のまま起動し、`playback` の初期状態と揃える。
    //
    // キーは `playback.position()`（会話行のみを数える生の値）ではなく
    // `playback.stable_item_key()` が返す `(scene_order 内インデックス, シーン内構築順
    // インデックス, コンテンツハッシュ)` を使う（#509 統合バグ修正・#533 コンテンツ
    // ハッシュ追加）。#509 で `Playback` の `items` が「訪れたシーンをその都度末尾に
    // 追記する」遅延構築モデルに変わったため、`select_current_choice`（選択肢ジャンプ）は
    // 既に訪れたことのあるシーンへ戻る場合でも既存の `items` を再利用せず常に新規追記する。
    // そのため生の `position()`/`item_index()` は同じシーンの同じ箇所に再訪しても毎回別の
    // 値になり、位置の生値をそのままキーにすると「一度読んだ行を選択肢でジャンプして戻り、
    // スキップで再度素通りする」という #499 が検証済みだったシナリオで既読が一切認識されず
    // スキップが即座に自己解除してしまう（マージ時に発覚した回帰）。さらに #533 で、
    // シーンの中身自体がフラグ状態に依存して変わる場合（`Event::Condition` の分岐で
    // シーン内 item の内容が訪問ごとに変わるが件数は同じ場合）に `(scene_idx,
    // local_index)` の2つ組だけでは取り違えが起きる既知の制約が判明したため、3つ目の
    // 要素としてコンテンツハッシュを追加した（`stable_item_key` の doc comment、
    // `playback.rs` 参照）。
    let mut skip_mode = false;
    let mut read_positions: HashSet<(usize, usize, u64)> = if playback_restored {
        save::restore_read_positions(config.quicksave_path.as_deref())
    } else {
        HashSet::new()
    };

    // バックログ（#500）: これまで実際に表示し終えた会話行（話者名込み）の履歴。
    // `Action::Advance` 処理内、行を実際に離れた瞬間（`on_advance` が `true` を返した
    // とき）にその行を積む — `read_positions`（既読判定、位置の集合）とは別に、表示内容
    // そのもの（`DisplayLine`）を時系列順に保持する。`sentence_per_page` が有効なときは
    // 文単位ページごとに1エントリになる（GUI版 `NovelRenderer` がページを離れる時だけ
    // backlog に記録するのと同じ粒度、`advanceOrSkipTypewriter` 参照）。
    let mut backlog: Vec<DisplayLine> = Vec::new();
    // バックログのスクロール位置（行数）。`ui::draw_backlog` が実際のコンテンツ量に合わせて
    // クランプした値を返すので、ここへ書き戻す（`indicator_started_at` と同じ「関数が
    // 計算した値をループ変数へ書き戻す」パターン）。`Overlay::Backlog` を開いた直後は
    // `u16::MAX` をセットして「末尾（最新）にクランプ」させる。
    let mut backlog_scroll: u16 = 0;

    // 設定画面（`Overlay::Settings`）内でフォーカスしている行（#503）。`Action::MoveLeft`/
    // `Action::MoveRight` で `SettingsField::prev`/`next` により切り替える。`Overlay::Settings`
    // を開くたびに `SettingsField::default()`（`TextSpeed`）へ戻す（`backlog_scroll` を
    // 開くたびに `u16::MAX` へ戻すのと同じ「オーバーレイごとに初期状態から始める」パターン）。
    let mut settings_focus = SettingsField::default();

    // 現在開いているオーバーレイ画面（#500 / #503）。既定は `Overlay::None`（通常のゲーム画面）。
    let mut overlay = Overlay::None;
    // `overlay` を `Overlay::None` 以外にした瞬間の実時刻。オーバーレイを閉じる際、
    // ここからの経過時間ぶん `current_reveal`/`image_fade` のアンカーを前進させる
    // （`close_overlay` 参照、セルフレビュー must対応）。`overlay == Overlay::None` の間は
    // 参照されないため初期値は任意。
    let mut overlay_opened_at = Instant::now();
    // `Overlay::Settings` 表示中に `restart_reveal_for_speed_change` が `current_reveal` を
    // 作り直した実時刻（#503）。作り直された `current_reveal` のアンカーは既に「オーバーレイ
    // 内のその時点」を起点にしているため、`close_overlay` は `overlay_opened_at` からではなく
    // この時刻から閉じるまでの経過だけを差し引く必要がある（セルフレビュー再指摘対応 —
    // `overlay_opened_at` からの全期間を差し引くと、開いてから速度変更までの分だけ余計に
    // アンカーを未来へ押し出してしまい、閉じた直後にタイプライターが一時的に凍結する）。
    // `image_fade` は速度変更で作り直されないため、この補正の対象外（常に
    // `overlay_opened_at` 基準のまま）。オーバーレイを開くたびに `None` へリセットする。
    let mut reveal_rebuilt_at: Option<Instant> = None;

    loop {
        let now = Instant::now();

        // オーバーレイ（バックログ/設定画面）表示中は、通常のゲームロジック（オート/スキップ
        // モードの締切判定・reveal のタイプライター経過・`Action::Advance` 等）を一切実行
        // せず、ここで完結させて次の周回へ進む（#500 / #503）。こうすることで「開いている間は
        // 会話が一切進まない」ことが構造的に保証される — 通常フローの奥深くに `if overlay ==
        // Overlay::None` の条件分岐を無数に挟むより、入り口1箇所で早期分岐する方が
        // 見落としのリスクが低い。
        if overlay != Overlay::None {
            terminal.draw(|frame| match overlay {
                Overlay::Backlog => {
                    backlog_scroll = ui::draw_backlog(frame, &config, &backlog, backlog_scroll);
                }
                Overlay::Settings => {
                    ui::draw_settings(
                        frame,
                        config.typewriter.char_interval_ms,
                        &config.volume,
                        settings_focus,
                    );
                }
                Overlay::None => unreachable!("overlay != Overlay::None はこの分岐の前提"),
            })?;

            match next_action()? {
                // バックログ/設定画面を開いたのと同じキーで閉じる（GUI版 `BacklogOverlay` の
                // 「ESC / B / クリックで閉じる」の「B」に相当、#500）。
                Action::ToggleBacklog if overlay == Overlay::Backlog => {
                    // 復帰直後にオートモードの締切超過で即座に自動送りしてしまわないよう
                    // （オーバーレイを開いていた間に締切だけが過去へ流れ去っている）、
                    // 締切を破棄して次の周回で「reveal完了から改めて `auto_wait_ms` 待つ」
                    // 状態に戻す（安全策）。加えて、オーバーレイ中に経過した実時間を
                    // タイプライター表示/イベント絵クロスフェードのアンカーから除外する
                    // （`close_overlay` 参照、セルフレビュー must対応）。
                    close_overlay(
                        &mut overlay,
                        &mut auto_deadline,
                        &mut current_reveal,
                        &mut image_fade,
                        overlay_opened_at,
                        reveal_rebuilt_at,
                        Instant::now(),
                    );
                }
                Action::ToggleSettings if overlay == Overlay::Settings => {
                    close_overlay(
                        &mut overlay,
                        &mut auto_deadline,
                        &mut current_reveal,
                        &mut image_fade,
                        overlay_opened_at,
                        reveal_rebuilt_at,
                        Instant::now(),
                    );
                }
                // Enter/Space（GUI版 `handlePointerClick` がバックログ表示中のタップを
                // 「進める」ではなく「閉じる」として吸収するのと同じ、#500）、および
                // Quit（q/Esc、GUI版 `handleKeyDown` の「Escape: 開いているオーバーレイを
                // 閉じる」と同じ優先順位）は、オーバーレイが開いている間はアプリ終了ではなく
                // 「オーバーレイを閉じる」を意味する。
                Action::Advance | Action::Quit => {
                    close_overlay(
                        &mut overlay,
                        &mut auto_deadline,
                        &mut current_reveal,
                        &mut image_fade,
                        overlay_opened_at,
                        reveal_rebuilt_at,
                        Instant::now(),
                    );
                }
                // バックログ表示中の ↑/↓ はスクロール（#500）。`Action::MoveUp`/
                // `Action::MoveDown` は「選択肢が無いときは no-op」というのが本来の意味だが
                // （`input.rs` の doc comment参照）、選択肢が存在し得ないオーバーレイ画面の
                // 文脈では別の意味へ読み替える — `Action::Advance` が選択肢確定へ読み替わる
                // のと同じ、既存の「Action の文脈依存の再解釈」パターンを踏襲する。
                Action::MoveUp if overlay == Overlay::Backlog => {
                    backlog_scroll = backlog_scroll.saturating_sub(BACKLOG_SCROLL_STEP);
                }
                Action::MoveDown if overlay == Overlay::Backlog => {
                    backlog_scroll = backlog_scroll.saturating_add(BACKLOG_SCROLL_STEP);
                }
                // 設定画面表示中の ←/→ はフォーカス行の切り替え（#503）。
                // `SettingsField::prev`/`next` がラップアラウンドを担う。
                Action::MoveLeft if overlay == Overlay::Settings => {
                    settings_focus = settings_focus.prev();
                }
                Action::MoveRight if overlay == Overlay::Settings => {
                    settings_focus = settings_focus.next();
                }
                // 設定画面表示中の ↑/↓ はフォーカス行に応じて意味が変わる（#503）。
                // `TextSpeed` 行ではテキスト速度、`BgmVolume`/`SeVolume`/`VoiceVolume` 行では
                // 対応する音量を調整する。GUI版 `SettingsOverlay.tsx` の各スライダー
                // （step=5）と同じ刻み幅。↑ = 数値を減らす、↓ = 数値を増やす（GUI版スライダーの
                // 左/右と同じ向き。ratatui のカーソル上/下という空間的な向きとは対応しない
                // 一方的な割り当てだが、他に基準となる向きが無いため choice cursor の
                // Up=前進/Down=後退という「上へ行くほど数値が減る」既存の感覚に合わせる）。
                Action::MoveUp if overlay == Overlay::Settings => match settings_focus {
                    SettingsField::TextSpeed => {
                        // `TEXT_SPEED_MIN_MS` は0固定（clippyの`unnecessary_min_or_max`が
                        // 指摘する通り、u64の`saturating_sub`は既にそれ未満に落ちない）。
                        // 将来 `TEXT_SPEED_MIN_MS` を0より大きい値へ変える場合はここで改めて
                        // `.max(TEXT_SPEED_MIN_MS)` を足す必要がある。
                        let next_ms = config
                            .typewriter
                            .char_interval_ms
                            .saturating_sub(TEXT_SPEED_STEP_MS);
                        config.typewriter.char_interval_ms = next_ms;
                        // `now`（ループ先頭・直前の `next_action()` 呼び出し前の値）ではなく、
                        // ここで取り直した実時刻を使う（セルフレビュー再指摘対応。
                        // `close_overlay` の doc comment が警告する「呼び出し直前に取り直す」
                        // 原則と同じ理由 — `next_action()` はブロッキング/スリープを含み
                        // うるため、古い `now` ではアンカーが過去へずれる）。
                        let restart_now = Instant::now();
                        restart_reveal_for_speed_change(
                            playback,
                            &mut current_reveal,
                            &config,
                            restart_now,
                        );
                        reveal_rebuilt_at = Some(restart_now);
                    }
                    SettingsField::BgmVolume => {
                        config.volume.bgm_percent =
                            decrement_volume_percent(config.volume.bgm_percent);
                        if let Some(player) = audio.as_deref_mut() {
                            player
                                .set_bgm_volume(percent_to_volume_scale(config.volume.bgm_percent));
                        }
                    }
                    SettingsField::SeVolume => {
                        config.volume.se_percent =
                            decrement_volume_percent(config.volume.se_percent);
                        if let Some(player) = audio.as_deref_mut() {
                            player.set_se_volume(percent_to_volume_scale(config.volume.se_percent));
                        }
                    }
                    // ボイス音量は値を保持するだけで、音声バックエンドへは反映されない
                    // （`VolumeConfig::voice_percent` のdoc comment参照、将来ボイス再生を
                    // 実装するまでの割り切り）。
                    SettingsField::VoiceVolume => {
                        config.volume.voice_percent =
                            decrement_volume_percent(config.volume.voice_percent);
                    }
                },
                Action::MoveDown if overlay == Overlay::Settings => match settings_focus {
                    SettingsField::TextSpeed => {
                        let next_ms = config
                            .typewriter
                            .char_interval_ms
                            .saturating_add(TEXT_SPEED_STEP_MS)
                            .min(TEXT_SPEED_MAX_MS);
                        config.typewriter.char_interval_ms = next_ms;
                        let restart_now = Instant::now();
                        restart_reveal_for_speed_change(
                            playback,
                            &mut current_reveal,
                            &config,
                            restart_now,
                        );
                        reveal_rebuilt_at = Some(restart_now);
                    }
                    SettingsField::BgmVolume => {
                        config.volume.bgm_percent =
                            increment_volume_percent(config.volume.bgm_percent);
                        if let Some(player) = audio.as_deref_mut() {
                            player
                                .set_bgm_volume(percent_to_volume_scale(config.volume.bgm_percent));
                        }
                    }
                    SettingsField::SeVolume => {
                        config.volume.se_percent =
                            increment_volume_percent(config.volume.se_percent);
                        if let Some(player) = audio.as_deref_mut() {
                            player.set_se_volume(percent_to_volume_scale(config.volume.se_percent));
                        }
                    }
                    SettingsField::VoiceVolume => {
                        config.volume.voice_percent =
                            increment_volume_percent(config.volume.voice_percent);
                    }
                },
                // 上記のどれにも当てはまらない入力（他方のオーバーレイ用トグルキー・
                // オート/スキップトグル等）はオーバーレイ表示中は無視する。
                _ => {}
            }
            continue;
        }

        // スキップモード（#499）: この周回で即座に advance すべきか（`skip_triggered`、下記）
        // を判定する。適格でなくなっていれば（選択肢到達・進める先が無い・未読到達）、
        // ここで `skip_mode` 自体を降ろす（GUI版 `processDirective` の Choice 到達時
        // `setSkipMode(false)` 等と同じ「その場で即座に解除する」挙動、#140）。
        if skip_mode
            && (playback.current_choice().is_some()
                || playback.current_line().is_none()
                || playback.is_at_end())
        {
            skip_mode = false;
        }
        // 既読 → この周回でキー入力を待たずに即座に advance する（GUI版 `scheduleSkipStep`
        // の `setTimeout(…, 0)` 相当、「実質ウェイト無しで回し続ける」設計）。未読ならスキップ
        // 終了（現在行は表示したまま待機、GUI版 #140 と同じ）——これは上のブロックが
        // 拾わないので、ここで改めて判定する。`position()` の生値ではなく
        // `stable_item_key()`（シーンを跨いで安定なキー、#509統合バグ修正）で既読集合と
        // 照合する — `stable_item_key` が `None`（範囲外）を返すことは通常起こらないが、
        // 防御的に `is_some_and` で「キーが取れず判定できない」場合は未読扱いにする。
        let skip_triggered = skip_mode
            && playback
                .stable_item_key(playback.item_index())
                .is_some_and(|key| read_positions.contains(&key));
        if skip_mode && !skip_triggered {
            skip_mode = false;
        }

        // オートモード（#498）: 締切を毎フレーム引き直すのではなく、「reveal完了 かつ
        // 選択肢待ちでない かつ スクリプト末尾でない」条件を満たした最初のフレームでだけ
        // 締切を1回セットする（#497 で踏んだ「毎周回上書きすると締切が無限に後退し続けて
        // 発火しない」バグを踏まないため、`auto_deadline.is_none()` のときだけ書き込む）。
        // 条件を外れたら（reveal未完了へ戻る＝新しい行へ進んだ、選択肢が出た、末尾に
        // 達した、等）締切を破棄する。GUI版が choice/wait 待機中・スクリプト末尾で
        // `scheduleAutoAdvance` を発火させないのと同じガード（`waitingForWait` 相当は
        // TUI にまだ無いため対象外）。
        if auto_mode {
            let reveal_done = current_reveal
                .as_ref()
                .map(|r| r.is_done(now))
                .unwrap_or(true);
            let eligible =
                reveal_done && playback.current_choice().is_none() && !playback.is_at_end();
            if eligible {
                if auto_deadline.is_none() {
                    auto_deadline = Some(now + Duration::from_millis(config.auto_wait_ms));
                }
            } else {
                auto_deadline = None;
            }
        } else {
            auto_deadline = None;
        }
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
        // #591: 選択肢のロック状態（`option.condition` が未定義/false のフラグを指している）
        // は current_choice() とは別配列で持つ（current_choice() の戻り値は Playback を
        // borrow したままの &[ChoiceOption] のため、ロック判定用に別途 owned な Vec を作る）。
        let choice_locked = playback.current_choice_locked();
        // #594: 選択肢の完了(クリア済み)状態も同じ理由で別配列に持つ（#596でキーワード改名）。ロックとは独立
        // （`option.cleared` を見る）で、選択自体は拒否しない見た目専用のフラグ。
        let choice_cleared = playback.current_choice_cleared();
        terminal.draw(|frame| {
            ui::draw(
                frame,
                &config,
                playback.current_line(),
                playback.current_choice(),
                &choice_locked,
                &choice_cleared,
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

        // オートモード（#498）: 締切を過ぎていれば、キー入力を待たずに `Action::Advance` を
        // 合成する（#497 の `deadline_triggered` と同じパターン）。`auto_triggered` は
        // 下の `Action::Advance` 分岐で「これは自動送りか、プレイヤーの手動操作か」を
        // 区別するために使う — 手動操作でのみオートモードを解除する（GUI版
        // `handleAdvance`/`handleKeyDown` が `setAutoMode(false)` するのと同じだが、自動送り
        // 自身がその直後に自分自身を解除してしまっては永久に1行しか進めなくなる）。
        let auto_triggered = matches!(auto_deadline, Some(deadline) if now >= deadline);
        if auto_triggered {
            // 締切を消費したら即座に `None` へ戻す。ここでクリアしないと、次のループ先頭の
            // オートモード判定ブロックは「`auto_deadline` が既に `Some`」と見て新しい締切への
            // 上書きをスキップし（#497 で踏んだ「毎周回上書きすると発火しなくなる」バグを
            // 避けるための意図的なガード）、advance 後の新しい行にも同じ過去の締切が
            // 残り続けてしまう。結果、advance するたびに即座にまた `now >= deadline` が
            // 真になり、`auto_wait_ms` の待機を1回も置かずに残り全行を一瞬で読み終える
            // カスケード事故になる（tmux実機確認で発見）。
            auto_deadline = None;
        }
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
        // `next_action()` によるキー入力待ちにフォールバックする（下の締切引き直しブロック参照）。
        //
        // `deadline_triggered` が真の間は `next_action()`（`REDRAW` = 30ms のポーリング間隔で
        // 入力を待つ経路）を経由せずに直接 `Action::Advance` を合成するため、この分岐だけを
        // 通り続ける限りループ本体はスリープしない。`[待機:0][イベント絵:B][待機:0]...` の
        // ように ms=0 の画像コマ item が連続すると、締切は毎回「作った瞬間に既に過ぎている」
        // ため `deadline_triggered` が常に真になり、その連鎖の間だけ CPU をビジーループで
        // 回し続ける。バグではなく許容している設計上のトレードオフ（ms=0 は「即座に進める」
        // という利用者の意図そのものであり、そこに人為的なウェイトを挟む理由が無いため）。
        let deadline_triggered = matches!(wait_deadline, Some(deadline) if now >= deadline);
        // 自動送り（オート／スキップ／画像コマ自動送りのいずれか）による合成 Advance かどうか。
        // 手動操作でのみオート/スキップモード自体を解除するために使う（GUI版
        // `handleAdvance`/`handleKeyDown` が `setAutoMode(false)`/`setSkipMode(false)` する
        // のと同じだが、自動送り自身がその直後に自分自身を解除してしまっては永久に1行しか
        // 進めなくなる）。画像コマ自動送り（`deadline_triggered`）はオート/スキップモードとは
        // 独立したメカニズム（原稿の `[待機:N]` 指定に由来）のため、これ単独でオート/スキップを
        // 解除することはない — 下の `Action::Advance` 分岐の `!synthetic_advance` ガードが
        // 3種の合成 Advance をまとめて「手動操作ではない」として扱う。
        let synthetic_advance = auto_triggered || skip_triggered || deadline_triggered;
        let action = if synthetic_advance {
            Action::Advance
        } else {
            next_action()?
        };
        let item_index_before_action = playback.item_index();

        match action {
            Action::Advance => {
                if !synthetic_advance {
                    // 手動操作（Enter/Space）でオート/スキップモードをキャンセルする
                    // （#498/#499、GUI版 `handleAdvance`/`handleKeyDown` の「手動操作で
                    // auto/skip を OFF にする」挙動を踏襲）。画像コマ自動送り
                    // （`deadline_triggered`）は `synthetic_advance` に含まれるため、
                    // Wait連鎖の自動進行でもここには来ない。
                    auto_mode = false;
                    auto_deadline = None;
                    skip_mode = false;
                }
                let prev_position = playback.position();
                // #499/#509統合: 既読マーク（`read_positions`）に積むキーは `prev_position`
                // ではなく `stable_item_key(prev_item_index)`（シーンを跨いで安定なキー、
                // `read_positions` 宣言側のコメント参照）を使う。`prev_item_index` は
                // on_advance で状態を動かす前の生インデックスをここで捕まえておく必要がある
                // — after 側で取り直すと既に次の item を指してしまうため。
                let prev_item_index = playback.item_index();
                // #558フォローアップ: `stable_item_key` の呼び出し自体も on_advance の
                // 「前」でここで済ませておく必要がある。`item_scene_key`/`item_content_hash`
                // は `advance()` 内部でシーンを新規構築するたびに末尾へ追記される
                // （`Playback::stable_item_key` の doc comment 参照）ため、空シーン
                // （items 0件、on_advance の C1 分岐で `advance()` が呼ばれるケース、#558）
                // では `prev_item_index=0` が「advance前は範囲外（items自体が空）」だった
                // ものが、advance後は新規構築された次シーンの最初の item 自身を指して
                // しまう。after側で `stable_item_key` を呼び直すと、この「advance前は
                // 存在しなかったはずのキー」が誤って解決されてしまい、まだ一度も表示して
                // いない次シーンの最初の行が既読マークされる事故になる（実機テスト作成中に
                // 発覚、再現テスト
                // `event_loop_empty_first_scene_landing_line_is_not_falsely_marked_as_read`）。
                // on_advance 実行前のこの時点で呼んでおけば、空シーンでは
                // `item_scene_key`/`item_content_hash` がまだ空（またはより短い）ため
                // 自然に `None` になり、後述の既読マーク処理も自動的にスキップされる。
                let prev_stable_key = playback.stable_item_key(prev_item_index);
                // #579: 自動クイックセーブのトリガー判定用に、on_advance で状態を動かす
                // 前の現在シーンを覚えておく。`prev_stable_key` と同じ「呼び出し前後で
                // 比較する」パターン — `playback.current_scene_idx()` は
                // `advance()`/`select_current_choice()` が新しいシーンの item を構築する
                // たびに更新される値なので、この前後比較で「シーンが実際に切り替わったか」
                // を検出できる（`Playback::current_scene_idx` のdoc comment参照）。
                let prev_scene_idx = playback.current_scene_idx();
                // #499: 既読マーク判定用に、on_advance で状態を動かす前の「選択肢表示中か」を
                // 覚えておく。`playback.position()` は Choice item をカウントしないため、
                // 「最後の会話行 → 直後の Choice」という遷移では `position()` の値が変わらず
                // （#497 が `item_index()` を導入した理由と同種の制約）、`prev_position` だけの
                // 比較では「本当に別の item へ移動したか」を取りこぼす。`current_choice()` の
                // 有無の変化も合わせて見ることでこの遷移も拾う。
                let was_choice_before = playback.current_choice().is_some();
                // #500: バックログに積む候補（話者名込みの表示内容）を、状態を動かす前に
                // 保存しておく。選択肢表示中は `current_line()` が `None` を返すため、この時点
                // で自然と候補なしになる — 選択肢自体はバックログの対象外という方針
                // （GUI版 #140 も text イベントだけを backlog の対象にしている）。
                let prev_line_for_backlog = playback.current_line().cloned();
                // 選択肢表示中（`Playback::current_choice` が `Some`）は、on_advance 内部で
                // `select_current_choice` による確定を試みる（#482、デシジョンテーブル参照）。
                let advanced = on_advance(playback, &mut current_reveal, &config, Instant::now());
                // BGM/SE の同期は `position()`（Line item のみを数える）ではなく、内部で
                // それぞれ「宣言的な値の変化」「生カーソルの変化」を見て判定するため、Choice
                // item への遷移（position() は変化しない）でも正しく反応する（#502）。
                // どちらも値が変わっていなければ no-op なので、advance が実質何もしなかった
                // （末尾で false を返した等）場合も無条件に呼んで問題ない。
                sync_bgm(
                    &mut current_bgm_path,
                    playback,
                    &config,
                    audio.as_deref_mut(),
                );
                play_new_se_cues(&mut last_se_cursor, playback, &config, audio.as_deref_mut());
                // #500: 実際に行/文単位ページが1つ先へ進んだとき（`on_advance` が `true` を
                // 返したとき、デシジョンテーブルのケース2a（#558）・ケース4）だけ、離れる
                // 直前の表示内容をバックログへ積む。選択肢確定（ケース1）・タイプライターの
                // スキップのみ（ケース3、まだ同じ行にとどまる）・末尾での no-op
                // （ケース2b・ケース5）ではいずれも `advanced` が偽になり、GUI版
                // `NovelRenderer.advanceOrSkipTypewriter` が
                // 「ページを離れる時だけ backlog に記録する」のと同じ粒度になる。本文が空
                // （改ページ専用の空行）のエントリは記録しない（GUI版 `BacklogOverlay.addEntry`
                // の「空行は記録しない」を踏襲）。
                if advanced {
                    if let Some(entry) = prev_line_for_backlog {
                        if !entry.text.iter().all(|line| line.is_empty()) {
                            backlog.push(entry);
                        }
                    }
                }
                // #499: 会話行から実際に離脱した（＝別の item へ移動した）瞬間、離脱前の行を
                // 既読としてマークする（`read_positions`、離脱ベースの既読判定 — 上の
                // `skip_mode` 初期化コメント参照）。選択肢から離脱した場合（`was_choice_before`）
                // はマーク対象外 — 選択肢自体は会話行ではなく、GUI版も text イベントだけを
                // 対象にしている（#140）。「離脱したか」の判定自体は `position()` の単発の
                // before/after比較で十分（同じ1回の on_advance 呼び出し内の変化を見るだけ
                // なので、#509 の遅延シーン追記が引き起こす「同じ内容が別 index になる」
                // 問題の影響を受けない）。実際に集合へ積むキーだけを安定キーに差し替える
                // — #558フォローアップにより、そのキー自体も on_advance 実行前に
                // 捕まえた `prev_stable_key` を使う（on_advance 後に取り直さない、上の
                // `prev_stable_key` 宣言側コメント参照）。
                let position_changed = playback.position() != prev_position
                    || playback.current_choice().is_some() != was_choice_before;
                if position_changed && !was_choice_before {
                    if let Some(key) = prev_stable_key {
                        read_positions.insert(key);
                    }
                }
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
                    let target_effects = playback
                        .current_line()
                        .map(|line| line.event_image_effects)
                        .unwrap_or_default();
                    let target_transition = playback
                        .current_line()
                        .map(|line| line.event_image_transition)
                        .unwrap_or_default();
                    let target_fade_ms = playback
                        .current_line()
                        .and_then(|line| line.event_image_fade_ms);
                    if image_fade.current_target() != target.as_deref() {
                        // Fade/Pixelate 間の crossfade_ms vs per-event `フェード=N` の非対称は
                        // `resolve_event_image_transition_duration_ms` のdoc comment参照。
                        let duration_ms = resolve_event_image_transition_duration_ms(
                            target_transition,
                            target_fade_ms,
                            config.event_image.crossfade_ms,
                        );
                        image_fade = image_fade.transition_to(
                            target,
                            target_effects,
                            target_transition,
                            Duration::from_millis(duration_ms),
                            Instant::now(),
                        );
                    }
                }
                // #579: シーンが実際に切り替わったら自動クイックセーブする。GUI版
                // `NovelPlayer.setOnSceneChange`（#578）の TUI 版対応 — GUI版が
                // シーン切り替えごとに `quickSave()` するのと同じタイミングを、
                // `prev_scene_idx`（本アーム冒頭で捕まえた値）との前後比較で検出する。
                // このブロックより前で更新済みの `read_positions`（直前で離脱した行の
                // 既読マーク、上の判定ブロック参照）を含めて保存する。書き込み失敗は
                // 握りつぶし、シーン進行を止めない（`save::save_quick` の fail-soft
                // 方針、GUI版 `quickSave` と同じ）。`config.quicksave_path` が `None`
                // （`Config::default()` を直接使うテストの大半）なら何もしない。
                if playback.current_scene_idx() != prev_scene_idx {
                    if let Some(path) = &config.quicksave_path {
                        save::save_quick(path, playback, &read_positions);
                    }
                }
            }
            // 選択肢を表示していないとき（`Playback::current_choice` が `None`）は no-op（#482）。
            // MoveLeft/MoveRight は非グリッド（列数1以下）表示中も同様に no-op（#508）。
            Action::MoveUp => playback.move_choice_cursor_up(),
            Action::MoveDown => playback.move_choice_cursor_down(),
            Action::MoveLeft => playback.move_choice_cursor_left(),
            Action::MoveRight => playback.move_choice_cursor_right(),
            Action::ToggleAuto => {
                // #498: トグルするだけで締切自体はここでは張らない。次ループ先頭の
                // オートモード判定ブロックが、この後の `auto_mode`/reveal 状態から
                // 改めて「eligibleか」を評価して締切を1回セットし直す（ON にした瞬間に
                // 現在行がタイプ中でも表示完了済みでも、その状態に応じて正しく拾える）。
                auto_mode = !auto_mode;
                auto_deadline = None;
                if auto_mode {
                    // オートとスキップは排他（GUI版 `setSkipMode(true)` が `setAutoMode(false)`
                    // する方向の排他を #140 から踏襲）。GUI版は逆方向（オートON時にスキップを
                    // 切る）までは明示していないが、TUI は「同時に有効な締切は高々1つ」という
                    // 単純なタイマー設計のため、両モードが同時に走る未定義状態を避けるべく
                    // 対称に扱う。
                    skip_mode = false;
                }
            }
            Action::ToggleSkip => {
                // #499: 同じ理由でスキップ側もトグルだけに留め、次ループ先頭の既読判定
                // ブロックに「eligibleか」の再評価を委ねる。ON にした瞬間に現在行が未読なら
                // その判定ブロックが即座に `skip_mode` を `false` に戻す（GUI版 #140 と同じ
                // 「未読到達で即座に解除」挙動）。
                skip_mode = !skip_mode;
                if skip_mode {
                    // スキップON時はオートを解除する（GUI版 `setSkipMode(true)` の
                    // `this.setAutoMode(false)` をそのまま踏襲、#140）。
                    auto_mode = false;
                    auto_deadline = None;
                }
            }
            Action::ToggleBacklog => {
                // #500: 開いた瞬間は最新（末尾）を表示させたいが、実際の折り返し後の行数は
                // `ui::draw_backlog` が描画時に初めて分かる。`u16::MAX` を渡しておくと
                // `draw_backlog` がその場で「末尾にクランプ」した値を返すので、次フレーム
                // 以降はその値を使う（`indicator_started_at` と同じ「関数の戻り値をループ
                // 変数へ書き戻す」パターン）。
                overlay = Overlay::Backlog;
                backlog_scroll = u16::MAX;
                // ループ先頭の `now` ではなく取り直した実時刻を使う（`close_overlay` が
                // 「呼び出し直前に取り直す」ことを要求するのと同じ理由 — この分岐に来る前の
                // `next_action()` がブロッキングしうるため、セルフレビュー再指摘対応）。
                overlay_opened_at = Instant::now();
                reveal_rebuilt_at = None;
            }
            Action::ToggleSettings => {
                overlay = Overlay::Settings;
                settings_focus = SettingsField::default();
                overlay_opened_at = Instant::now();
                reveal_rebuilt_at = None;
            }
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

/// オーバーレイ（バックログ/設定画面）を閉じる際の後始末（#500 / #503）。
///
/// `Overlay` のdoc comment（本ファイル冒頭）は「オーバーレイ表示中はゲーム進行を完全に
/// 凍結する」と書いているが、これは実際には「`event_loop` がオーバーレイ表示中
/// `current_reveal`/`image_fade` を一切更新・描画しない」という意味に留まる。
/// `current_reveal`（`jiwa::RevealHandle` ベース）と `image_fade` はどちらも `Instant`
/// アンカーからの経過時間で見た目を計算するため、アンカー自体はオーバーレイが開いている
/// 間も現実の時計と共に進み続ける。オーバーレイを閉じずに何もしなければ実害は無いが
/// （次に描画/参照されるまで誰も経過時間を読まない）、閉じた瞬間に初めて経過時間が
/// 読まれるため、オーバーレイを開いていた実時間がそのままタイプライター表示の進行や
/// クロスフェードの進行に漏れ込んでしまう（セルフレビュー must対応: レビュアー実機再現
/// `char_interval_ms=1000` で表示途中にバックログを開き実時間1.5秒待ってから閉じると、
/// 閉じた直後に1〜2文字余分に表示される）。
///
/// これを防ぐため、閉じる際にオーバーレイが開いていた実時間（`overlay_opened_at` から
/// `now` までの経過）ぶん、`current_reveal`/`image_fade` 双方のアンカーを前進させる
/// （[`reveal::RevealState::shift_anchor_forward`]/`image_fade::ImageFadeState::shift_anchor_forward`）。
/// これにより以後の経過時間計算からオーバーレイ中の実時間経過が差し引かれ、閉じた直後の
/// 見た目はオーバーレイを開く直前と完全に一致する。
///
/// オートモードの締切（`auto_deadline`）破棄は既存の安全策（オーバーレイが開いていた間に
/// 締切だけが過去へ流れ去っているのを防ぐ）で、上記のアンカー補正とは別の理由による処理
/// だが、「オーバーレイを閉じる」という同じ操作の一部としてここにまとめる。
///
/// `now` は呼び出し側が `event_loop` のループ先頭で一度だけ計算した値をそのまま渡しては
/// ならず、この関数を呼ぶ直前（`next_action()` がオーバーレイを閉じる `Action` を返した
/// 「後」）に改めて `Instant::now()` を取り直したものを渡す必要がある。`next_action()`
/// 自体がブロッキング/スリープを含みうる（本番の `input::poll_action` は最大 `REDRAW` だけ
/// だが、テストの合成 `next_action` はもっと長く `thread::sleep` することがある）ため、
/// ループ先頭の古い `now` を使うと `overlay_opened_at` からの経過時間を過小評価し、
/// このアンカー補正自体が骨抜きになる（実装時に一度この誤りを踏んだ — オーバーレイの
/// 実時間経過が結局漏れ込む退行を作ってしまい、下の回帰テストで検出した）。
///
/// `reveal_rebuilt_at` は `Overlay::Settings` 表示中に速度変更で `current_reveal` が
/// 作り直された実時刻（#503、`restart_reveal_for_speed_change` 呼び出し側が記録する）。
/// `Some` のときは `current_reveal` のアンカー補正だけこの時刻を基準にする —
/// 作り直された `current_reveal` は既に「オーバーレイ内のその時点」を起点にしているため、
/// `overlay_opened_at`（オーバーレイを開いた瞬間）から丸ごと差し引くと、開いてから
/// 速度変更までの分だけ余計にアンカーを未来へ押し出してしまい、閉じた直後にタイプライターが
/// 一時的に凍結する退行になる（セルフレビュー再指摘対応）。`image_fade` は速度変更で
/// 作り直されないため、常に `overlay_opened_at` 基準のまま。
fn close_overlay(
    overlay: &mut Overlay,
    auto_deadline: &mut Option<Instant>,
    current_reveal: &mut Option<reveal::RevealState>,
    image_fade: &mut image_fade::ImageFadeState,
    overlay_opened_at: Instant,
    reveal_rebuilt_at: Option<Instant>,
    now: Instant,
) {
    *overlay = Overlay::None;
    *auto_deadline = None;
    let reveal_base = reveal_rebuilt_at.unwrap_or(overlay_opened_at);
    let reveal_duration = now.saturating_duration_since(reveal_base);
    if let Some(reveal) = current_reveal.as_mut() {
        reveal.shift_anchor_forward(reveal_duration);
    }
    let image_duration = now.saturating_duration_since(overlay_opened_at);
    image_fade.shift_anchor_forward(image_duration);
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

/// テキスト速度の変更（#503、`Overlay::Settings`）を「見た目に即座に反映する」ための処理。
/// 現在タイプ中（`current_reveal` が `Animating` かつ未完了）の行があれば、新しい速度で
/// タイプライターを最初から組み立て直す。既に表示完了済み（`RevealState::Done`、または
/// `Animating` で既に `is_done`）の行は触らない — 残りの文字が無い行を無意味に再度タイプ
/// させ直すのは不自然なため。
///
/// GUI版 `typewriter.ts::tickTypewriter` は `msPerChar` を毎フレーム読み直すため、速度変更は
/// 「そこから先の文字だけ」新速度になる。対して `jiwa::RevealHandle`（TUI側の実装）は構築時に
/// 速度を固定する設計で、既に見えている文字の表示時刻を保ったまま速度だけ差し替えるAPIを
/// 持たない。そのため、ここでは「タイプ中の行を新速度で最初から表示し直す」ことで同等の
/// 即時性を実現する — 既に見えていた文字も含めて最初から出し直す分だけ、GUI版の
/// 「そこから先だけ加速/減速する」動きとは厳密には一致しないが、体感できるほどの差では
/// ない（1行の平均文字数・調整幅を考えれば、再タイプにかかる時間は高々数百ms）。
/// 「即座に」は内部状態の話であり、`Overlay::Settings` 表示中はゲーム画面自体が
/// `ui::draw_settings` に差し替わっているためユーザーからは見えない — オーバーレイを
/// 閉じた瞬間に初めて反映後の見た目が現れる（意図した仕様。設定画面の裏でゲーム画面を
/// 透過プレビューする機能は範囲外、セルフレビュー再指摘で確認）。
///
/// `now` は呼び出し側がループ先頭で計算した古い値をそのまま渡してはならず、この関数を
/// 呼ぶ直前に改めて `Instant::now()` を取り直したものを渡す必要がある（`close_overlay` と
/// 同じ理由・同じ原則。呼び出し側は `reveal_rebuilt_at` にこの時刻を記録し、
/// `close_overlay` のアンカー補正の基準に使う、セルフレビュー再指摘対応）。
fn restart_reveal_for_speed_change(
    playback: &Playback,
    current_reveal: &mut Option<reveal::RevealState>,
    config: &Config,
    now: Instant,
) {
    let still_typing = current_reveal.as_ref().is_some_and(|r| !r.is_done(now));
    if still_typing {
        *current_reveal = build_reveal_for_current(playback, config, now);
    }
}

/// `Action::Advance` 受信時の意思決定（デシジョンテーブル、#472。選択肢分岐対応で #482 拡張）。
/// `Terminal<CrosstermBackend<Stdout>>` という具体型に結合していた `event_loop` から、
/// `playback` / `current_reveal` / `config` / `now` だけを引数に取る純粋関数として切り出し、
/// `TestBackend` 無しでもユニットテストできるようにした。
///
/// | # | 現在位置 | reveal状態 | 次 | 動作 |
/// |---|---|---|---|---|
/// | 1 | 選択肢 | ― | ― | `select_current_choice` で確定を試みる。成功時のみ新しい位置の reveal を組み立て直す（失敗時＝無効な jump 先は選択肢表示のまま no-op） |
/// | 2a | 無し | ― | advance成功（次itemに到達） | `advance()` を試みる（#558）。成功時は次item の reveal を組み立て直し、`true` を返す — 現在シーンが Line/Choice/Image を1つも持たない場合（例: フラグ設定イベントだけの `game_init`）に、`advance()` 内部のスキップループが次にitemを持つシーンまで自動的に進める |
/// | 2b | 無し | ― | advance失敗（真の末尾/ファイル境界） | 従来通り no-op（`false` を返す、`current_reveal` は不変） |
/// | 3 | 会話行 | 未完了 | 存在する/最終行 | `skip_lines` で即全文表示、`advance()` は呼ばない |
/// | 4 | 会話行 | 完了 | 存在する | `advance()` → 次item の reveal（`build_reveal_for_current`。Line なら Animating、Choice なら None） |
/// | 5 | 会話行 | 完了 | 最終行 | `advance()` が `false` を返し no-op（`current_reveal` は不変） |
///
/// 選択肢表示中（#1）は Advance（Enter/Space）の意味が「次の行へ進む」から「カーソルが
/// 指す選択肢を確定する」に変わる（`input::Action::Advance` のドキュメント参照）。選択肢の
/// 文言はタイプライター演出の対象外なので、reveal の完了/未完了を問わず常に即座に確定を試みる
/// （#3/#4 のような reveal_done 分岐が不要）。
///
/// 戻り値は「実際に会話行/文単位ページが1つ先へ進んだか」（デシジョンテーブルのケース2a
/// （#558）・ケース4でのみ `true`）。呼び出し側 `event_loop` はこれを使ってバックログ
/// （#500）に「離れる直前の表示内容」を積むタイミングを判定する — 選択肢確定（ケース1）・
/// タイプライターのスキップのみでまだ同じ行にとどまる（ケース3）・末尾での no-op
/// （ケース2b・ケース5）はいずれも `false` を返す。既存の呼び出し元（テスト含む）は
/// 戻り値を無視しても動作に影響しない（`bool` は `#[must_use]` ではないため、無視しても
/// 警告は出ない）。
fn on_advance(
    playback: &mut Playback,
    current_reveal: &mut Option<reveal::RevealState>,
    config: &Config,
    now: Instant,
) -> bool {
    if playback.current_choice().is_some() {
        if playback.select_current_choice() {
            *current_reveal = build_reveal_for_current(playback, config, now);
        }
        return false;
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
            return false;
        } else if playback.advance() {
            *current_reveal = build_reveal_for_current(playback, config, now);
            return true;
        }
    } else if playback.advance() {
        // #558: current_choice()もcurrent_line()もNoneのケース（現在シーンが
        // Line/Choice/Imageを1つも持たない、例: フラグ設定イベントだけの
        // game_init）。Playback::advance()は内部にスキップループを持ち、
        // 呼びさえすれば次にitemを持つシーンまで自動的に進む
        // （playback.rs 参照）。ここで呼ばなければ、両方Noneの間ずっと
        // on_advanceが何もしない＝キー入力が効かないまま進行不能になる。
        *current_reveal = build_reveal_for_current(playback, config, now);
        return true;
    }
    false
}

/// `playback.current_bgm()`（宣言的 state、#502）を実際の再生状態へ同期する。
/// GUI版 `AudioManager.playBgm` の `if (this.currentBgmUrl === url) return`（同一URLなら
/// 何もしない）と同じく、前回同期時の値（`current`）と変化が無ければ即座に返る —
/// これにより毎フレーム無条件に呼んでも、実際に BGM が切り替わった瞬間だけ
/// `AudioPlayer::play_bgm`/`stop_bgm` が呼ばれる。
///
/// `config.resolve_sound_path` がパストラバーサル等で `None` を返した場合（原稿の記述ミス）は
/// 「BGM無し」と同じ扱いで `stop_bgm` に倒す（fail-soft、`image_fade` がデコード失敗時に
/// プレースホルダへ倒すのと同じ考え方）。`audio` が `None`（音声出力デバイス無し、
/// `AudioPlayer::try_new` 参照）の場合は `current` の追跡だけ行い実際の再生呼び出しはしない。
fn sync_bgm(
    current: &mut Option<String>,
    playback: &Playback,
    config: &Config,
    audio: Option<&mut audio::AudioPlayer>,
) {
    let target = playback.current_bgm().map(str::to_string);
    if *current == target {
        return;
    }
    *current = target.clone();
    let Some(audio) = audio else { return };
    match target.and_then(|relative| config.resolve_sound_path(&relative)) {
        Some(path) => audio.play_bgm(&path),
        None => audio.stop_bgm(),
    }
}

/// [`Playback::item_index`] が前回チェック時から変化していたら（＝新しい item に到達した
/// 瞬間）、その item に紐づく `current_se_cues()` を出現順にすべて一度だけ再生する（#502）。
/// SE は BGM と異なり持続する state を持たないワンショットのため、`sync_bgm` のような
/// 「値そのもの」の比較ではなく「カーソルが動いたかどうか」のエッジ検出になる —
/// 同じ item に居続ける限り（`sentence_per_page` の文送り等）何度呼んでも再生しない。
/// `item_index()` は image_fade のクロスフェード判定（#497）が使っているのと同じ「生の
/// items インデックス」で、SE の新規到達検出にもそのまま転用できる（専用の `cursor()` を
/// 別途持たない）。`last_cursor` を `Option<usize>` にしているのは、起動直後の初回呼び出し
/// （実インデックス値は常に有効な `usize`）を「前回と異なる」として確実に一致させ、原稿冒頭の
/// `[SE:]` も取りこぼさないため。
///
/// パス解決に失敗した個別の SE（`config.resolve_sound_path` が `None`）は黙って読み飛ばし、
/// 残りの SE の再生は継続する（1件の記述ミスで他の SE まで巻き込んで無音にしない）。
/// `audio` が `None` の場合は `last_cursor` の追跡だけ行い実際の再生はしない。
fn play_new_se_cues(
    last_cursor: &mut Option<usize>,
    playback: &Playback,
    config: &Config,
    audio: Option<&mut audio::AudioPlayer>,
) {
    let cursor = playback.item_index();
    if *last_cursor == Some(cursor) {
        return;
    }
    *last_cursor = Some(cursor);
    let Some(audio) = audio else { return };
    for relative in playback.current_se_cues() {
        if let Some(path) = config.resolve_sound_path(relative) {
            audio.play_se(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::DisplayLine;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::CellWidth;
    use ratatui::style::Color;
    use std::cell::RefCell;

    fn dline(speaker: Option<&str>, text: &str) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
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
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::default(),
            event_image_fade_ms: None,
        }
    }

    /// `dline_with_image` の遷移指定版（Pixelate遷移固定、#613の event_loop 統合テスト用）。
    fn dline_with_image_pixelate(
        speaker: Option<&str>,
        text: &str,
        event_image: Option<String>,
    ) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
            event_image,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
            event_image_transition: name_name_parser::models::EventImageTransition::Pixelate,
            event_image_fade_ms: None,
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

    // resolve_event_image_transition_duration_ms（Fade/Pixelate間のcrossfade_ms vs
    // per-event `フェード=N` 尊重の非対称、#583 should S-2）の3分岐。
    // event_loop 内の match をそのまま切り出した純粋関数のため、event_loop 全体の
    // TestBackend 統合テストを組まずにここで直接ロックできる。

    #[test]
    fn resolve_event_image_transition_duration_ms_pixelate_with_explicit_fade_ms_uses_it() {
        // Pixelate + フェード=N明示 → N採用（crossfade_msは無視）。
        let duration = resolve_event_image_transition_duration_ms(
            name_name_parser::models::EventImageTransition::Pixelate,
            Some(900),
            700,
        );
        assert_eq!(duration, 900);
    }

    #[test]
    fn resolve_event_image_transition_duration_ms_pixelate_without_fade_ms_falls_back_to_crossfade_ms(
    ) {
        // Pixelate + フェード省略 → crossfade_msに委譲。
        let duration = resolve_event_image_transition_duration_ms(
            name_name_parser::models::EventImageTransition::Pixelate,
            None,
            700,
        );
        assert_eq!(duration, 700);
    }

    #[test]
    fn resolve_event_image_transition_duration_ms_fade_ignores_explicit_fade_ms() {
        // Fade + フェード=N明示 → crossfade_ms固定（Nは無視、#481由来の既存の意図的簡略化）。
        let duration = resolve_event_image_transition_duration_ms(
            name_name_parser::models::EventImageTransition::Fade,
            Some(900),
            700,
        );
        assert_eq!(duration, 700);
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

    // ---- #558: current_choice()もcurrent_line()もNoneのケース（items 0件のシーン、
    // 例: フラグ設定だけのgame_init）からの on_advance ----
    //
    // Playback::from_lines はシーン構造を持たない（scene_order が常に空）ため、この分岐
    // （シーンを跨いだ暗黙のスキップ）を再現できない。実際の Markdown を parser::parse
    // した Document 経由で Playback を構築する必要がある（choice_branch_source 系のテストと
    // 同じ理由）。

    #[test]
    fn on_advance_empty_first_scene_advances_to_next_scene_line() {
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: 探索済み = true]\n\n## 1-2: ハブ\n\n**A**:\nおかえりなさい\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        // 前提: 1-1 はフラグ設定イベントだけで items を1件も持たないため、Choice も
        // Line も現在位置に無い。
        assert!(playback.current_choice().is_none());
        assert!(playback.current_line().is_none());

        let advanced = on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(
            advanced,
            "items 0件のシーンで足止めされず、items を持つ次シーンまで進めるはず"
        );
        assert_eq!(
            playback
                .current_line()
                .expect("hubの台詞")
                .speaker
                .as_deref(),
            Some("A")
        );
        assert!(
            current_reveal.is_some(),
            "到達した新しい会話行のrevealが組み立てられているはず"
        );
    }

    #[test]
    fn skip_leading_empty_scenes_advances_past_empty_first_scene() {
        // #564: 起動直後、まだAction::Advanceが一度も来ていない時点でも、items 0件の
        // 先頭シーン（フラグ設定イベントだけのgame_init相当）はスキップされ、最初の
        // 描画フレームが既に次シーンの会話行を指しているはず。
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: 探索済み = true]\n\n## 1-2: ハブ\n\n**A**:\nおかえりなさい\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);

        assert!(playback.current_choice().is_none());
        assert!(playback.current_line().is_none());

        skip_leading_empty_scenes(&mut playback);

        assert_eq!(
            playback
                .current_line()
                .expect("hubの台詞")
                .speaker
                .as_deref(),
            Some("A")
        );
    }

    #[test]
    fn skip_leading_empty_scenes_does_not_skip_line_when_first_scene_has_multiple_lines() {
        // 先頭シーンが最初からLineを持つ通常構成では、余計に1つ進めてしまわないはず
        // （「current_choice/current_lineが両方Noneのときだけ」というon_advanceのC1分岐と
        // 同じガード）。
        //
        // 旧フィクスチャ（先頭シーンにLine1件だけ・後続シーン無し）は、ガード条件
        // `current_choice().is_none() && current_line().is_none()` を丸ごと削除して常に
        // `advance()` を呼ぶ変異を入れても、`advance()` 自身が「次item無し・次シーン無し」で
        // 何もせず終わるため検出できなかった（テスト観点整理エージェント指摘、ミューテーション
        // 生存＝実質検出力ゼロ）。先頭シーンに2行(A→B)を用意し、ガードが無いと本当にBまで
        // 進んでしまう構成にすることで検出力を持たせる。
        let source =
            "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n**A**:\nこんにちは\n\n**B**:\nやあ\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);

        skip_leading_empty_scenes(&mut playback);

        assert_eq!(
            playback
                .current_line()
                .expect("起動シーンの1行目")
                .speaker
                .as_deref(),
            Some("A"),
            "先頭シーンに複数行ある場合でも1行目のまま留まるはず（2行目Bへ進んでは \
             いけない）"
        );
    }

    #[test]
    fn skip_leading_empty_scenes_is_noop_when_first_item_is_choice() {
        // 決定表パターン2: current_line()がNone・current_choice()がSomeのケース。
        // 先頭シーンの最初のitemが直接Choiceの構成でも、skip_leading_empty_scenesは
        // 選択肢のjump先へ勝手に進んでしまってはいけない、という仕様の記録。
        //
        // ただしミューテーション検証済み: `current_choice().is_none() && current_line().is_none()`
        // からcurrent_choice()側の項を丸ごと削っても（advance()を無条件で呼んでも）このテストは
        // 通ってしまう。`Playback::advance()`自身が「items[index]がChoiceなら即false」という
        // 内部ガードを持つため、外側のcurrent_choice()チェックが無くてもこのケースでは実害が出ない。
        // つまりこのテスト単体ではskip_leading_empty_scenes側のcurrent_choice()条件の検出力は無い
        // （テスト観点整理エージェント指摘）。
        let source =
            "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n[選択]\n- 進む→1-2\n[/選択]\n\n\
                       ## 1-2: 次\n\n**B**:\n次のセリフ\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);

        assert!(playback.current_choice().is_some());
        assert!(playback.current_line().is_none());

        skip_leading_empty_scenes(&mut playback);

        assert_eq!(
            playback
                .current_choice()
                .expect("skip_leading_empty_scenes後も選択肢のまま")
                .0
                .first()
                .expect("選択肢が1件")
                .text,
            "進む",
            "選択肢の内容が変化してはいけない（jump先へ進んでしまっていないことの確認）"
        );
        assert!(
            playback.current_line().is_none(),
            "jump先(1-2)の会話行へ進んでしまってはいけない"
        );
    }

    #[test]
    fn skip_leading_empty_scenes_true_end_after_consecutive_empty_scenes_is_safe_noop() {
        // 決定表パターン3c（境界値）: 空シーンが複数連続し、その後に後続シーンが無い
        // （ドキュメントがそこで終わる）場合。`advance()`の内部スキップループが末尾まで
        // 走り切っても行き先が無く、no-opでpanicもしないはず
        // （`on_advance_true_end_of_document_is_safe_noop_not_panic`のskip_leading_empty_scenes版）。
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n[フラグ: A = true]\n\n\
                       ## 1-2: 中継\n\n[フラグ: B = true]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);

        assert!(playback.current_choice().is_none());
        assert!(playback.current_line().is_none());

        skip_leading_empty_scenes(&mut playback);

        assert!(
            playback.current_choice().is_none(),
            "後続シーンが無い末尾ではno-opのはず（panicしない）"
        );
        assert!(
            playback.current_line().is_none(),
            "後続シーンが無い末尾ではno-opのはず（panicしない）"
        );
    }

    #[test]
    fn skip_leading_empty_scenes_via_merged_document_advances_within_same_file() {
        // `from_merged_document`経由でも`from_document`と同じくガード・前進が効くことの
        // 回帰ガード（`main()`は通常起動時に`multi_doc::load_merged_document`＋
        // `Playback::from_merged_document`を使う経路を通る、`main()`のdoc comment参照）。
        // 単一の`parse()`呼び出しから得た`Document`は先頭シーンも次シーンも同じ1個の
        // Chapter（＝同じfile id）に属するため、これは「同一ファイル内前進」のケースになる。
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n[フラグ: 探索済み = true]\n\n\
                       ## 1-2: ハブ\n\n**A**:\nおかえりなさい\n";
        let document = name_name_parser::parser::parse(source);
        let chapter_file_ids: Vec<usize> = vec![0; document.chapters.len()];
        let mut playback = Playback::from_merged_document(&document, &chapter_file_ids);

        assert!(playback.current_choice().is_none());
        assert!(playback.current_line().is_none());

        skip_leading_empty_scenes(&mut playback);

        assert_eq!(
            playback
                .current_line()
                .expect("hubの台詞")
                .speaker
                .as_deref(),
            Some("A"),
            "from_merged_document経路でも同一ファイル内なら前進するはず"
        );
    }

    #[test]
    fn skip_leading_empty_scenes_via_merged_document_does_not_cross_file_boundary() {
        // 境界値: `from_merged_document`で、先頭シーン（file 0, 空）の次シーンがfile 1
        // （別ファイル）の場合。`on_advance_does_not_cross_file_boundary_from_empty_first_scene`
        // と同じフィクスチャパターン（doc0/doc1を別々にparseしてから連結する = 別ファイル扱い）。
        // ファイル境界チェックは`advance()`内部の仕組みなので、`skip_leading_empty_scenes`は
        // 前進せず、呼び出し前と同じ「(会話行がありません)」を一瞬表示する状態
        // （current_line()/current_choice()が両方None）が保たれなければいけない。
        let source0 = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n[フラグ: 探索済み = true]\n";
        let source1 = "---\nengine: name-name\n---\n\n## 2-1: ハブ\n\n**A**:\nおかえりなさい\n";
        let mut doc0 = name_name_parser::parser::parse(source0);
        let doc1 = name_name_parser::parser::parse(source1);
        let chapter_file_ids: Vec<usize> = std::iter::repeat_n(0, doc0.chapters.len())
            .chain(std::iter::repeat_n(1, doc1.chapters.len()))
            .collect();
        doc0.chapters.extend(doc1.chapters);
        let document = doc0;
        let mut playback = Playback::from_merged_document(&document, &chapter_file_ids);

        assert!(playback.current_choice().is_none());
        assert!(playback.current_line().is_none());

        skip_leading_empty_scenes(&mut playback);

        assert!(
            playback.current_choice().is_none(),
            "file1のhubへ誤って進んでしまってはいけない"
        );
        assert!(
            playback.current_line().is_none(),
            "file1のhubへ誤って進んでしまってはいけない \
             （呼び出し前と同じ「(会話行がありません)」状態が保たれるはず）"
        );
    }

    #[test]
    fn on_advance_empty_first_scene_landing_on_choice_keeps_reveal_none() {
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: 探索済み = true]\n\n## 1-2: ハブ\n\n\
                       [選択]\n- 進む→1-2\n[/選択]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        let advanced = on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(advanced);
        assert!(
            playback.current_choice().is_some(),
            "items 0件のシーンの次に直接Choiceが来る構成でも、そこまで進めるはず"
        );
        assert!(
            current_reveal.is_none(),
            "選択肢に着地した場合はrevealを持たないはず（build_reveal_for_currentは \
             current_line()がNoneならNoneを返す）"
        );
    }

    #[test]
    fn on_advance_skips_multiple_consecutive_empty_scenes_in_one_call() {
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: A = true]\n\n## 1-2: 中継\n\n[フラグ: B = true]\n\n\
                       ## 1-3: ハブ\n\n**A**:\nおかえりなさい\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        let advanced = on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(
            advanced,
            "空シーンが2連続していても、on_advance 1回でitemsを持つシーンまで到達するはず \
             （Playback::advance の内部スキップループが1呼び出しで完結する）"
        );
        assert_eq!(
            playback
                .current_line()
                .expect("hubの台詞")
                .speaker
                .as_deref(),
            Some("A")
        );
    }

    #[test]
    fn on_advance_does_not_cross_file_boundary_from_empty_first_scene() {
        // #496 のファイル境界チェックは、items 0件のシーンからの新しい暗黙スキップ
        // （#558）でも引き続き尊重されるはず（false-positive前進の回帰ガード）。
        let config = instant_config();
        let source0 = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n[フラグ: 探索済み = true]\n";
        let source1 = "---\nengine: name-name\n---\n\n## 2-1: ハブ\n\n**A**:\nおかえりなさい\n";
        let mut doc0 = name_name_parser::parser::parse(source0);
        let doc1 = name_name_parser::parser::parse(source1);
        let chapter_file_ids: Vec<usize> = std::iter::repeat_n(0, doc0.chapters.len())
            .chain(std::iter::repeat_n(1, doc1.chapters.len()))
            .collect();
        doc0.chapters.extend(doc1.chapters);
        let document = doc0;
        let mut playback = Playback::from_merged_document(&document, &chapter_file_ids);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        assert!(playback.current_choice().is_none());
        assert!(playback.current_line().is_none());

        let advanced = on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(
            !advanced,
            "items 0件のシーンの次がファイル境界を跨ぐ場合は進んではいけない"
        );
        assert!(playback.current_choice().is_none());
        assert!(
            playback.current_line().is_none(),
            "file1のhubへ誤って進んでしまってはいけない"
        );
        assert!(current_reveal.is_none());
    }

    #[test]
    fn on_advance_true_end_of_document_is_safe_noop_not_panic() {
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n[フラグ: 探索済み = true]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        for _ in 0..3 {
            let advanced = on_advance(&mut playback, &mut current_reveal, &config, now);
            assert!(
                !advanced,
                "後続シーンが無いドキュメント末尾では常にno-opのはず（panicしない）"
            );
        }
        assert!(current_reveal.is_none());
    }

    #[test]
    fn on_advance_empty_first_scene_advances_with_sentence_per_page_enabled() {
        // Gymnasia実バグ（tui-config.toml の sentence_per_page=true）の発生条件そのもの。
        // current_line() が current_display 経由になっても C1 分岐が機能することを確認する。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: 探索済み = true]\n\n## 1-2: ハブ\n\n**A**:\nおかえりなさい\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document).with_sentence_per_page(true);
        let now = Instant::now();
        let mut current_reveal: Option<reveal::RevealState> = None;

        assert!(playback.current_line().is_none());

        let advanced = on_advance(&mut playback, &mut current_reveal, &config, now);

        assert!(advanced);
        assert_eq!(
            playback
                .current_line()
                .expect("hubの台詞（current_display経由）")
                .speaker
                .as_deref(),
            Some("A")
        );
        assert!(current_reveal.is_some());
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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert!(
            buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "advancing into a line with a new event_image should switch the fade target to it"
        );
    }

    #[test]
    fn event_loop_advance_crossing_into_new_event_image_with_pixelate_transition_from_none_displays_it(
    ) {
        // #613: 上のテスト（Fade遷移、#481由来）と同じ構造を、Pixelate遷移かつ「表示中の絵が
        // 無い状態(from=None)からのイベント絵表示」で再現する回帰ガード——GUI版(#612)の
        // バグが起きていたのと同じ入力パターン。GUI版は `EventImageLayer.show()` の
        // `this.sprite && fadeMs > 0` ゲートにより、この入力（表示中スプライト無し）だと
        // Pixelate分岐自体に入れずFade（実質即時表示）へフォールバックしていたが、TUI側の
        // `ImageFadeState::snapshot` にそのようなゲートは無く、`to_transition==Pixelate`だけで
        // 無条件にPixelate経路（`pixelate_snapshot`、from=Noneはblank_gridとして扱う設計、
        // `image_fade.rs`のdocコメント参照）に入る。crossfade_ms=0にして、トランジション
        // 開始直後の描画が実時間経過に依存せず即座に新ターゲットの色を表示するようにし、
        // 決定的なアサーションにする。
        let fixture_color = (33u8, 200u8, 210u8);
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
            dline_with_image_pixelate(Some("B"), "world", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance, Action::Quit]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert!(
            buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "advancing into a line with a new Pixelate-transition event_image from a from=None \
             state should display the image, not get stuck on the placeholder (TUI counterpart \
             of the #612 GUI fix)"
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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

    /// レンダリング済みバッファを1本の文字列に変換する（`ui.rs` のテストヘルパーと同じ目的）。
    /// ASCII中心の既存テストで使う薄いラッパー。実体は [`buffer_text_wide_aware`] —
    /// ASCII文字はどれも `cell_width() == 1` なので、全角対応版の走査ロジックは
    /// ASCII専用の単純な連結と完全に同じ結果を返す（セルフレビュー nit対応:
    /// 同じ走査ロジックが2箇所に重複していたのを一本化）。
    fn buffer_text(terminal: &Terminal<TestBackend>) -> String {
        buffer_text_wide_aware(terminal)
    }

    /// [`buffer_text`] の全角対応版。全角文字の次のセルは直前のグラフェムの表示のために
    /// 予約された継続セルであり、単純に連結すると全角文字どうしの間に余分な文字が
    /// 混入してCJK文字列の内容比較が壊れる（`ui.rs` の `buffer_text` と同じ理由、参照）。
    /// CJK文字列そのものを検証するテストも `buffer_text` のASCII専用テストも、どちらも
    /// この実装を共有する（上記 [`buffer_text`] 参照）。
    fn buffer_text_wide_aware(terminal: &Terminal<TestBackend>) -> String {
        let buffer = terminal.backend().buffer();
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

    /// [`action_queue`] のブロッキング待ち版。各ステップは `(この呼び出しを返す前に
    /// 眠る時間, 返すAction)` のペアで、実機の `input::poll_action` が次のキー入力まで
    /// ブロックする時間を意図的に模す（`show_splash` はループ先頭で `Instant::now()` を
    /// 取ってから `next_action()?` を呼ぶため、この待ちの間だけ先頭の `now` が古くなる —
    /// バグ修正1（#538、`scroll_anim_start` の取り直し）の退行検出用）。
    /// 列を使い切った後は `Action::Quit` を返し続ける（`action_queue` と同じ安全策）。
    fn scripted_next_action(
        steps: Vec<(Duration, Action)>,
    ) -> impl FnMut() -> anyhow::Result<Action> {
        let mut iter = steps.into_iter();
        move || match iter.next() {
            Some((sleep_before, action)) => {
                if !sleep_before.is_zero() {
                    std::thread::sleep(sleep_before);
                }
                Ok(action)
            }
            None => Ok(Action::Quit),
        }
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

        run_screens(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        // #587以降、共通操作フッター（Enter/Space 次へ ... C 設定 ...）はsplashの有無に
        // 関わらず常時表示されるため、「Enter」の非存在ではもう判定できない
        // （splashが描かれる/描かれないに関わらず、通常プレイ画面`draw`側の
        // `draw_status_line`経由で同じフッターが出る）。ここでは splash をスキップして
        // event_loop 側の通常プレイ描画（共通フッター + 位置表示 "0/0"）が出ていることを
        // 確認する。
        let text = buffer_text(&terminal);
        assert!(
            text.contains("C 設定"),
            "共通操作フッターは通常プレイでも常時表示されるはず, buffer was: {text}"
        );
        assert!(text.contains("0/0"), "buffer was: {text}");
    }

    // ---- #502: sync_bgm / play_new_se_cues（音声出力デバイス無しでの状態追跡）----
    //
    // `audio: None`（`AudioPlayer::try_new` がデバイス無し環境で返す値）を渡しても panic
    // せず、また実ファイルI/Oを一切行わずに `current`/`last_cursor` の状態追跡だけが
    // 正しく進むことを確認する（`sync_bgm`/`play_new_se_cues` の doc comment 参照:
    // `audio` が `None` の分岐は状態更新後に早期returnするだけで `resolve_sound_path` すら
    // 呼ばない）。

    #[test]
    fn sync_bgm_tracks_current_bgm_without_audio_device() {
        let source =
            "---\nengine: name-name\n---\n\n## 1-1: start\n\n[BGM: amehure.ogg]\n\n**A**:\nhello\n";
        let document = name_name_parser::parser::parse(source);
        let playback = Playback::from_document(&document);
        let config = Config::default();

        let mut current = None;
        sync_bgm(&mut current, &playback, &config, None);

        assert_eq!(current.as_deref(), Some("amehure.ogg"));
    }

    #[test]
    fn sync_bgm_no_op_when_target_unchanged() {
        let document = name_name_parser::parser::parse(
            "---\nengine: name-name\n---\n\n## 1-1: start\n\n**A**:\nhello\n",
        );
        let playback = Playback::from_document(&document);
        let config = Config::default();

        // 既に current == target(None) の状態で呼んでも current は変化しない（自明だが、
        // 「値が変化した時だけ再生を試みる」という契約をコードで固定しておく）。
        let mut current = None;
        sync_bgm(&mut current, &playback, &config, None);
        assert_eq!(current, None);
    }

    #[test]
    fn play_new_se_cues_updates_cursor_once_per_item_without_audio_device() {
        let source = "---\nengine: name-name\n---\n\n## 1-1: start\n\n[SE: chime.wav]\n\n**A**:\nhello\n\n**B**:\nworld\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let config = Config::default();

        let mut last_cursor = None;
        play_new_se_cues(&mut last_cursor, &playback, &config, None);
        assert_eq!(
            last_cursor,
            Some(0),
            "最初のitemへの到達でcursorが記録される"
        );

        // 同じitemに居続ける限り、何度呼んでもcursorは変わらない（＝再トリガーしない）。
        play_new_se_cues(&mut last_cursor, &playback, &config, None);
        assert_eq!(last_cursor, Some(0));

        playback.advance();
        play_new_se_cues(&mut last_cursor, &playback, &config, None);
        assert_eq!(
            last_cursor,
            Some(1),
            "次のitemへ進んだのでcursorが更新されるはず"
        );
    }

    // ---- #537: 起動時音量同期 ----
    //
    // 以前ここには `sync_startup_volume`（`run()` が `AudioPlayer::try_new()` の直後に
    // 別行で呼ぶ設計）を実デバイス非依存・決定論的に検証するテストがあったが、#537の
    // セルフレビュー指摘（生成と同期の呼び出しが分離されており、後者の呼び出しを削除しても
    // `cargo test` が気づけない）を受けて構造そのものを変更した。生成と音量同期は
    // `audio::AudioPlayer::try_new(&config.volume)` という単一の呼び出しに統合済みで、
    // 対応する回帰テストは `audio::tests`（`initial_volumes_maps_default_config_to_bgm_and_se_scale`
    // 等）に移動している——`audio::AudioPlayer::try_new` のdoc comment参照。

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

    /// `REQUIRED_TOTAL_WIDTH`四方の正方形画像を、2px ごとの横帯で段階的に赤みを変えた
    /// フィクスチャ。正方形画像を全幅（`REQUIRED_TOTAL_WIDTH`列）contain-fit表示すると
    /// `compute_full_width_rows` は総行数 `REQUIRED_TOTAL_WIDTH/2` を返し、そのsubpixel高さ
    /// （総行数*2）がちょうど画像の縦幅 `REQUIRED_TOTAL_WIDTH` に一致する（サイズを
    /// `REQUIRED_TOTAL_WIDTH` 自体から動的に導出しているため、この一致は定数値を問わず常に
    /// 成り立つ）。これにより縦方向の拡大縮小が発生せず、各表示行が一意な赤背景を持つため、
    /// 「最下端から1つ戻ったか」を先頭セルの背景色だけで判別できる。
    fn per_row_scroll_fixture() -> std::path::PathBuf {
        let size: u32 = u32::from(ui::REQUIRED_TOTAL_WIDTH);
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
    fn show_splash_movedown_stale_next_action_call_does_not_cause_early_progress() {
        // バグ修正1（#538）の退行検出。上の
        // `show_splash_movedown_does_not_instantly_jump_to_target_scroll_offset`（60秒という
        // 巨大な scroll_ease_ms を使う手法）はこの退行を検出できない —
        // `action_queue`（フェイク）は即座に返るため、修正前後で`scroll_anim_start`に差が
        // 生まれない。ここでは `next_action` がブロッキング入力待ちで実際に時間を要する
        // ケースを [`scripted_next_action`] で再現する。
        //
        // scroll_ease_ms=400（ease-outカーブで progress=0.5 になるのは t≈0.293、
        // 400ms*0.293≈117ms）に対し、MoveDownを返す直前に150ms眠ることで「ループ先頭で
        // `now` を取ってから、実際にMoveDownが届くまでに150ms経過した」状況を作る。
        //
        // 修正後（正しい実装）: MoveDown処理直後に`Instant::now()`を取り直すため、次フレーム
        // の`elapsed_ms`はほぼ0 → progress≈0 → 表示オフセットはまだ帯0のまま。
        // もし退行してループ先頭の古い`now`を使ってしまうと: 次フレームの
        // `elapsed_ms≈150ms`（閾値117msを超える）→ 表示オフセットが早くも帯1へ
        // ラウンドされてしまう。150ms(sleep) vs 117ms(閾値)でマージンを広く取っているため、
        // CI環境のジッタで誤検出する可能性は低い。
        let fixture_path = per_row_scroll_fixture();
        let mut config = image_splash_config(&fixture_path);
        config.splash.scroll_ease_ms = 400;

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut next_action = scripted_next_action(vec![
            (Duration::from_millis(150), Action::MoveDown),
            (Duration::ZERO, Action::Advance),
        ]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();
        assert!(advanced);

        assert_eq!(
            terminal.backend().buffer().cell((0, 0)).unwrap().bg,
            Color::Rgb(0, 0, 0),
            "MoveDownが届くまでに150ms経過していても、アニメーション起点が\
             `Instant::now()`で取り直されていれば次フレームのeaseはほぼ0進行のはず\
             （帯0=赤0のまま）。古い`now`を使い回す退行が起きると帯1(赤5)へ早期遷移する"
        );
    }

    #[test]
    fn show_splash_moveup_stale_next_action_call_does_not_cause_early_progress() {
        // 上の `show_splash_movedown_stale_next_action_call_does_not_cause_early_progress`
        // のMoveUp版（対称性のため）。MoveUpは`saturating_sub`のため0からは動けないので、
        // 事前に別のMoveDownでオフセットを1まで進めてからMoveUpで戻す形にする。
        //
        // ステップ:
        // 1. MoveDown（即時）でtarget_scroll_offsetを1にする。
        // 2. 500ms眠ってからAction::Noneを返す（scroll_ease_ms=400なので、この間に
        //    ease-outアニメーションが確実に完了し、表示オフセットが帯1へ完全に収束する）。
        // 3. 150ms眠ってからMoveUpを返す（バグ修正1の退行検出用の待ち。上のMoveDown版と
        //    同じ150ms vs 閾値117msのマージン）。
        // 4. 即座にAdvanceを返す。
        let fixture_path = per_row_scroll_fixture();
        let mut config = image_splash_config(&fixture_path);
        config.splash.scroll_ease_ms = 400;

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        let mut next_action = scripted_next_action(vec![
            (Duration::ZERO, Action::MoveDown),
            (Duration::from_millis(500), Action::None),
            (Duration::from_millis(150), Action::MoveUp),
            (Duration::ZERO, Action::Advance),
        ]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();
        assert!(advanced);

        assert_eq!(
            terminal.backend().buffer().cell((0, 0)).unwrap().bg,
            Color::Rgb(5, 0, 0),
            "MoveUpが届くまでに150ms経過していても、アニメーション起点が\
             `Instant::now()`で取り直されていれば次フレームのeaseはほぼ0進行のはずなので、\
             表示は直前まで収束していた帯1(赤5)のまま。古い`now`を使い回す退行が起きると\
             帯0(赤0)へ早期に戻ってしまう"
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

        let fixture_size = u32::from(ui::REQUIRED_TOTAL_WIDTH);
        let total_rows = crate::image_render::compute_full_width_rows(
            fixture_size,
            fixture_size,
            ui::REQUIRED_TOTAL_WIDTH,
        );
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

        run_screens(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

    /// #622 デシジョンテーブル行C: `--new-game`指定でもクイックセーブファイルが
    /// 元から存在しない場合はエラーにならず、削除操作自体が完全にno-op（`false`を
    /// 返すだけ）であることを確認する。
    #[test]
    fn apply_new_game_or_restore_with_new_game_and_no_quicksave_file_is_noop_and_returns_false() {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-apply-new-game-no-file-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);
        assert!(!quicksave_path.exists());

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut playback = Playback::from_document(&document);

        let result = apply_new_game_or_restore(true, &mut playback, &quicksave_path)
            .expect("ファイルが元から無い場合はエラーにならないはず（#622 デシジョンテーブル行C）");

        assert!(
            !result,
            "ファイルが無ければrestoreは行われないためfalseのはず"
        );
        assert!(
            !quicksave_path.exists(),
            "元から無いファイルの削除を試みてもエラーにならず、存在しないままのはず"
        );
        assert_eq!(
            playback.current_scene_id(),
            "1-1",
            "restoreが行われないのでplaybackは初期状態のままのはず"
        );
    }

    /// #622 デシジョンテーブル行D（今回実装の核心）: `--new-game`指定時、正常な
    /// クイックセーブファイルが存在してもその中身は使わず、ファイルごと削除して
    /// `restore_playback`の呼び出し自体をスキップする。`playback`のシーンは
    /// 構築直後（entry_script先頭）のまま変化しない。
    #[test]
    fn apply_new_game_or_restore_with_new_game_and_existing_quicksave_deletes_file_and_skips_restore(
    ) {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-apply-new-game-existing-file-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut save_source_playback = Playback::from_document(&document);
        assert!(save_source_playback.jump_to_scene_id("1-2"));
        save::save_quick(&quicksave_path, &save_source_playback, &HashSet::new());
        assert!(
            quicksave_path.exists(),
            "テスト前提: 正常なクイックセーブファイルが書かれているはず"
        );

        let mut playback = Playback::from_document(&document);
        let result = apply_new_game_or_restore(true, &mut playback, &quicksave_path)
            .expect("正常な削除はエラーにならないはず");

        assert!(
            !result,
            "--new-gameではrestoreを行わないのでfalseのはず（#622 デシジョンテーブル行D）"
        );
        assert!(
            !quicksave_path.exists(),
            "--new-gameは既存のクイックセーブファイルを削除するはず"
        );
        assert_eq!(
            playback.current_scene_id(),
            "1-1",
            "restoreがスキップされたのでplaybackのシーンは構築直後のまま変化していないはず"
        );
    }

    /// #622 デシジョンテーブル行F: scene_idが現原稿に存在しない壊れた（stale）
    /// クイックセーブファイルであっても、`--new-game`は中身を検証せずファイルの
    /// 存在だけを見てまるごと削除する（行Dと同じ削除ロジックであることの確認）。
    #[test]
    fn apply_new_game_or_restore_with_new_game_and_stale_scene_id_quicksave_still_deletes_file() {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-apply-new-game-stale-scene-id-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);

        let document = name_name_parser::parser::parse(choice_branch_source());
        let save_source_playback = Playback::from_document(&document);
        let real_scene_id = save_source_playback.current_scene_id().to_string();
        assert_eq!(real_scene_id, "1-1");
        save::save_quick(&quicksave_path, &save_source_playback, &HashSet::new());
        let written = std::fs::read_to_string(&quicksave_path).unwrap();
        let tampered = written.replace(&format!("\"{real_scene_id}\""), "\"does-not-exist\"");
        assert_ne!(
            tampered, written,
            "scene_idの文字列置換がテストの前提どおり発生しているはず"
        );
        std::fs::write(&quicksave_path, &tampered).unwrap();

        let mut playback = Playback::from_document(&document);
        let result = apply_new_game_or_restore(true, &mut playback, &quicksave_path)
            .expect("stale scene_idでも削除自体はエラーにならないはず");

        assert!(!result);
        assert!(
            !quicksave_path.exists(),
            "壊れた(stale scene_id)クイックセーブでも中身を検証せずファイルごと \
             削除されるはず（#622 デシジョンテーブル行F）"
        );
    }

    /// #622 非回帰: `--new-game`を指定しない場合は従来通り`save::restore_playback`を
    /// 呼び、その戻り値がそのまま返る（デシジョンテーブル行A/Bの非回帰）。ファイルも
    /// 削除されない。
    #[test]
    fn apply_new_game_or_restore_without_new_game_falls_back_to_existing_restore_playback_behavior()
    {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-apply-new-game-fallback-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut save_source_playback = Playback::from_document(&document);
        assert!(save_source_playback.jump_to_scene_id("1-2"));
        save::save_quick(&quicksave_path, &save_source_playback, &HashSet::new());

        let mut playback = Playback::from_document(&document);
        let result = apply_new_game_or_restore(false, &mut playback, &quicksave_path)
            .expect("正常な読み込みはエラーにならないはず");

        assert!(
            result,
            "new_game=falseなら従来通りrestore_playbackの戻り値がそのまま返るはず"
        );
        assert!(
            quicksave_path.exists(),
            "new_game=falseではファイルを削除しないはず"
        );
        assert_eq!(
            playback.current_scene_id(),
            "1-2",
            "保存済みシーンへ復元されているはず"
        );

        let _ = std::fs::remove_file(&quicksave_path);
    }

    /// #622: `--new-game`指定でクイックセーブが削除され`playback_restored=false`と
    /// なった場合、`event_loop`側の`read_positions`が空集合のまま初期化されることを
    /// 確認する（#579事故パターン——「playbackは初期状態なのにread_positionsだけ
    /// 保存済みの古い値が漏れ込む」——の回帰防止）。保存していたクイックセーブは
    /// stale scene_idケースと違い**中身として完全に正常**（単体で`restore_playback`を
    /// 呼べば成功する）にもかかわらず、`--new-game`が中身を見ずファイルごと削除する
    /// ことで結果的に`playback_restored=false`になる点が
    /// `event_loop_does_not_restore_read_positions_when_restore_playback_fails_on_stale_scene_id`
    /// との違い（配線パターン自体は同じものを踏襲）。
    #[test]
    fn event_loop_read_positions_stay_empty_when_new_game_flag_forced_playback_restored_false() {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-event-loop-new-game-read-positions-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);

        let mut config = instant_config();
        config.quicksave_path = Some(quicksave_path.clone());

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut playback = Playback::from_document(&document);
        let key0 = playback
            .stable_item_key(playback.item_index())
            .expect("先頭item（会話行A）の安定キーが取れるはず");

        // 「前回セッションでAを読了済みだった」を模した既読集合込みで、現在の原稿に
        // 実在するシーン("1-1")で正常に保存する。
        save::save_quick(&quicksave_path, &playback, &HashSet::from([key0]));
        assert!(
            quicksave_path.exists(),
            "テスト前提: 正常なクイックセーブファイルが書かれているはず"
        );

        let playback_restored = apply_new_game_or_restore(true, &mut playback, &quicksave_path)
            .expect("正常な削除はエラーにならないはず");
        assert!(
            !playback_restored,
            "--new-gameではrestoreを行わないのでfalseのはず"
        );
        assert!(
            !quicksave_path.exists(),
            "--new-gameでファイルが削除されているはず"
        );

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // スキップを試みる。`read_positions`が`playback_restored`を無視して独立に
        // 復元されていたら、先頭item（A、上で保存したkey0）が既読扱いされ即座に
        // スキップが発動しBまで飛ばされてしまう。正しい配線では`playback_restored=false`
        // なので`read_positions`は空集合のままAは未読と判定され、その場でスキップが
        // 解除されてAが表示され続けるはず。
        let (mut next_action, _remaining) = action_queue(vec![Action::ToggleSkip, Action::Quit]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            playback_restored,
        )
        .unwrap();

        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("A"),
            "read_positionsが(バグにより)復元されていればAが既読扱いされスキップでBへ \
             飛ばされてしまうはず。正しい配線では空集合のままAが未読判定されその場に留まる"
        );
    }

    /// #622 権限系: クイックセーブファイルを含むディレクトリが書き込み不可（unix
    /// 0o555）な場合、`std::fs::remove_file`はディレクトリの書き込み権限が無いため
    /// 失敗する。この失敗を`save.rs`のfail-soft方針（`save_quick_does_not_panic_when_target_directory_is_read_only`
    /// 参照）のように握りつぶすのではなく、`Err`として呼び出し元（`main()`）まで
    /// 伝播させる設計であることを確認する——「新規開始の要求に対し黙って失敗するのは
    /// 避けるべき」というIssue本文の意図をここで固定する。macOSのローカル開発機
    /// （非root実行）を前提とする。
    #[cfg(unix)]
    #[test]
    fn apply_new_game_or_restore_with_new_game_when_quicksave_dir_is_read_only_returns_err() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "name-name-tui-apply-new-game-readonly-dir-{}",
            std::process::id()
        ));
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();

        struct ReadonlyDirGuard(std::path::PathBuf);
        impl Drop for ReadonlyDirGuard {
            fn drop(&mut self) {
                // remove_dir_allの前に書き込み権限を戻さないと自分自身の削除にも失敗する。
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = ReadonlyDirGuard(dir.clone());

        let quicksave_path = dir.join("quicksave.json");
        // ディレクトリがまだ書き込み可能なうちにファイルを作っておく
        // （unlinkに必要なのはファイル自体ではなく親ディレクトリの書き込み権限）。
        std::fs::write(&quicksave_path, "{}").unwrap();

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut playback = Playback::from_document(&document);

        let result = apply_new_game_or_restore(true, &mut playback, &quicksave_path);

        assert!(
            result.is_err(),
            "削除失敗時はfail-softにせずErrを伝播する設計。この設計判断をここで固定する"
        );
    }

    /// #622 冪等性: `--new-game`を連続で実行しても（2回目はファイルが既に無い状態）
    /// エラーにならず、常に`false`を返す。
    #[test]
    fn apply_new_game_or_restore_with_new_game_twice_in_a_row_is_idempotent() {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-apply-new-game-idempotent-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut save_source_playback = Playback::from_document(&document);
        assert!(save_source_playback.jump_to_scene_id("1-2"));
        save::save_quick(&quicksave_path, &save_source_playback, &HashSet::new());
        assert!(quicksave_path.exists());

        let mut playback = Playback::from_document(&document);

        let first = apply_new_game_or_restore(true, &mut playback, &quicksave_path)
            .expect("1回目の削除はエラーにならないはず");
        assert!(!first);
        assert!(
            !quicksave_path.exists(),
            "1回目の呼び出しでファイルが削除されているはず"
        );

        let second = apply_new_game_or_restore(true, &mut playback, &quicksave_path)
            .expect("2回目（ファイルが既に無い状態）でもエラーにならないはず（#622 冪等性）");
        assert!(!second);
        assert!(!quicksave_path.exists());
    }

    /// #579 の配線（`event_loop` 内、`Action::Advance` アーム末尾の自動クイックセーブ
    /// 判定）そのものを確認する最小テスト。`save::save_quick`/`Playback::jump_to_scene_id`
    /// 自体の網羅的な検証はそれぞれ `save.rs`/`playback.rs` にあるので、ここでは
    /// 「シーンが実際に切り替わったら `config.quicksave_path` へファイルが書かれるか」
    /// という結線だけを見る。
    #[test]
    fn event_loop_autosaves_quicksave_file_when_scene_changes_and_path_is_configured() {
        let mut config = instant_config();
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-event-loop-autosave-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);
        config.quicksave_path = Some(quicksave_path.clone());

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // 1回目のAdvance: 最初のセリフ→Choice（同じシーン"1-1"内、シーンは切り替わらない）。
        // 2回目のAdvance: Choiceを確定→"1-2"へjump（シーンが切り替わる、ここで自動セーブ）。
        let (mut next_action, _remaining) =
            action_queue(vec![Action::Advance, Action::Advance, Action::Quit]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        let saved = std::fs::read_to_string(&quicksave_path)
            .expect("シーン切り替えでクイックセーブファイルが書き込まれているはず");
        assert!(
            saved.contains("\"1-2\""),
            "保存データに着地先シーンID(1-2)が含まれるはず, saved was: {saved}"
        );

        let _ = std::fs::remove_file(&quicksave_path);
    }

    /// #579 フォローアップ: `restore_playback` が失敗した場合（原稿変更等で保存済み
    /// scene_idが現在の`scene_index_by_id`に存在しなくなったケース）、`read_positions`も
    /// 復元されず空集合のまま起動することを検証する。`playback`（先頭シーンのまま初期状態）
    /// と`read_positions`（空集合）を揃えるのがこの修正の目的——`playback_restored`を見ずに
    /// `read_positions`だけ独立に復元していた旧実装では、この場合でも保存済みの既読集合が
    /// そのまま適用され、「playbackは初期状態なのにread_positionsだけ古い値が残る」という
    /// 非対称な不整合が起きていた（`main()`の`playback_restored`コメント参照）。
    ///
    /// `save::restore_playback`単体の「stale scene_idではflags/位置とも変更されない」保証は
    /// `save.rs::tests::restore_playback_does_not_touch_flags_when_saved_scene_id_is_stale`が
    /// 既にカバーしているので、ここでは`event_loop`まで通した`read_positions`側の配線を見る。
    #[test]
    fn event_loop_does_not_restore_read_positions_when_restore_playback_fails_on_stale_scene_id() {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-event-loop-stale-scene-read-positions-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);

        let mut config = instant_config();
        config.quicksave_path = Some(quicksave_path.clone());

        let document = name_name_parser::parser::parse(choice_branch_source());
        let mut playback = Playback::from_document(&document);
        let real_scene_id = playback.current_scene_id().to_string();
        assert_eq!(real_scene_id, "1-1");
        let key0 = playback
            .stable_item_key(playback.item_index())
            .expect("先頭item（会話行A）の安定キーが取れるはず");

        // 「前回セッションでAを読了済みだった」を模した既読集合込みでいったん実在する
        // scene_id（"1-1"）で保存し、その後scene_idの文字列だけを存在しないIDへ置換する
        // ことで「原稿変更で保存済みシーンが消えた」ケースを再現する
        // （`read_positions`フィールドはこの置換の影響を受けず残る）。
        save::save_quick(&quicksave_path, &playback, &HashSet::from([key0]));
        let written = std::fs::read_to_string(&quicksave_path).unwrap();
        let tampered = written.replace(&format!("\"{real_scene_id}\""), "\"does-not-exist\"");
        assert_ne!(
            tampered, written,
            "scene_idの文字列置換がテストの前提どおり発生しているはず"
        );
        std::fs::write(&quicksave_path, &tampered).unwrap();

        let playback_restored = save::restore_playback(&mut playback, &quicksave_path);
        assert!(
            !playback_restored,
            "存在しないscene_idなので復元は失敗するはず"
        );
        assert_eq!(
            playback.current_scene_id(),
            "1-1",
            "restore_playback失敗時はplaybackが構築直後のまま変わらないはず"
        );

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // スキップを試みる。修正前のように`read_positions`が`playback_restored`を無視して
        // 独立に復元されていたら、先頭item（A、上で保存したkey0）が既読扱いされ即座に
        // スキップが発動しBまで飛ばされてしまう。修正後は`playback_restored=false`なので
        // `read_positions`は空集合のままAは未読と判定され、その場でスキップが解除されて
        // Aが表示され続けるはず。
        let (mut next_action, _remaining) = action_queue(vec![Action::ToggleSkip, Action::Quit]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            playback_restored,
        )
        .unwrap();

        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("A"),
            "read_positionsが(バグにより)復元されていればAが既読扱いされスキップでBへ \
             飛ばされてしまうはず。修正後は空集合のままAが未読判定されその場に留まる"
        );

        let _ = std::fs::remove_file(&quicksave_path);
    }

    /// #579 回帰: 自動クイックセーブは「シーンが実際に切り替わったか」
    /// （`playback.current_scene_idx()` の前後比較）だけをトリガーにしているため、
    /// 同一シーン内で会話行を何行進めてもセーブファイルは一切書き換わらないはず。
    /// 同じ `Playback`/セーブ先ファイルを使って `event_loop` を2回連続で呼び、1回目
    /// （シーン切り替えを含む）が終わった直後のファイル内容と、2回目（同一シーン内の
    /// 追加Advanceのみ）が終わった後のファイル内容を比較する——書き込みが2回とも
    /// 実際に発生していれば `read_positions` の中身が変わり得るため、同一プロセス内で
    /// `HashSet` の反復順序が異なる別々のテスト実行同士を比較するより、この「同じ
    /// ファイルへの2回目の書き込みが物理的に起きていないこと」を直接見る方が
    /// 反復順序起因の偽陽性が無く確実（1回しか書かれていなければ内容は必ずbit-exactに
    /// 一致する）。
    #[test]
    fn event_loop_does_not_rewrite_quicksave_file_on_additional_advance_within_same_scene() {
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-event-loop-no-rewrite-same-scene-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);
        let mut config = instant_config();
        config.quicksave_path = Some(quicksave_path.clone());

        let source = "---\nengine: name-name\n---\n\n\
                       ## 1-1: multi\n\n\
                       **A**:\n1文目\n\n\
                       **A**:\n2文目\n\n\
                       [選択]\n- 進む→1-2\n[/選択]\n\n\
                       ## 1-2: landing\n\n\
                       **B**:\n最終1\n\n\
                       **B**:\n最終2\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        // 1回目: 1-1の2行を読み進めてChoiceを確定 -> 1-2へjump（シーン切り替え、
        // ここで自動セーブが1回発生する）。
        let (mut next_action_landing, _r1) = action_queue(vec![
            Action::Advance,
            Action::Advance,
            Action::Advance,
            Action::Quit,
        ]);
        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action_landing,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.current_scene_id(),
            "1-2",
            "テストの前提: 1回目の終了時点で1-2へ着地しているはず"
        );
        let after_landing = std::fs::read_to_string(&quicksave_path)
            .expect("シーン切り替え直後にクイックセーブファイルが書かれているはず");

        // 2回目: 同じplaybackを継続し、1-2内でもう1行進める（最終1->最終2）。
        // シーンは変わらないため、ここではセーブが再発生しないはず。
        let (mut next_action_same_scene, _r2) = action_queue(vec![Action::Advance, Action::Quit]);
        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action_same_scene,
            None,
            false,
        )
        .unwrap();

        let after_extra_advance = std::fs::read_to_string(&quicksave_path)
            .expect("ファイルは（1回目の書き込みのまま）残っているはず");

        assert_eq!(
            after_landing, after_extra_advance,
            "シーンが変わらない追加Advanceでセーブファイルの中身が変わってしまっている \
             (再セーブされた疑い), after_landing={after_landing}, \
             after_extra_advance={after_extra_advance}"
        );

        let _ = std::fs::remove_file(&quicksave_path);
    }

    /// #579 + #574 統合: 中継シーン連鎖（本文無し・Choice1件だけのシーンが2連続）を
    /// 1回の `Action::Advance` で自動通過した場合、自動クイックセーブに保存される
    /// `scene_id` が中継先（"1-2"/"1-3"）ではなく最終的な着地シーン（"1-4"）である
    /// ことを確認する。`event_loop` のセーブトリガー判定は `Action::Advance` 処理の
    /// 前後で1回だけ`playback.current_scene_idx()`を比較する構造（本テストファイルの
    /// `event_loop_autosaves_quicksave_file_when_scene_changes_and_path_is_configured`
    /// 参照）のため、途中の中継シーンで書き込みが起きることは構造上あり得ない——
    /// ここでは「その1回の書き込みが指す先が正しく最終着地シーンか」を確認する。
    #[test]
    fn event_loop_autosaves_final_landing_scene_id_not_relay_scene_after_chained_relay_advance() {
        let mut config = instant_config();
        let quicksave_path = std::env::temp_dir().join(format!(
            "name-name-tui-event-loop-relay-chain-autosave-test-{}-{}.json",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_file(&quicksave_path);
        config.quicksave_path = Some(quicksave_path.clone());

        let source = "---\nengine: name-name\n---\n\n\
                       ## 1-1: start\n\n\
                       **A**:\nどうする？\n\n\
                       [選択]\n- 進む→1-2\n[/選択]\n\n\
                       ## 1-2: relay_a\n\n\
                       [フラグ: seen_relay_a=true]\n\n\
                       [選択]\n- 続ける→1-3\n[/選択]\n\n\
                       ## 1-3: relay_b\n\n\
                       [フラグ: seen_relay_b=true]\n\n\
                       [選択]\n- 続ける→1-4\n[/選択]\n\n\
                       ## 1-4: landing\n\n\
                       **B**:\n最終セリフ\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // 1回目のAdvance: "どうする？" -> Choice（同じシーン"1-1"内）。
        // 2回目のAdvance: Choice確定 -> 1-2(relay_a)→1-3(relay_b)→1-4(landing)を
        // #574の中継自動継続で1回で通過し、"1-4"の台詞で止まる。
        let (mut next_action, _remaining) =
            action_queue(vec![Action::Advance, Action::Advance, Action::Quit]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.current_scene_id(),
            "1-4",
            "テストの前提: 中継を2連鎖通過して最終着地シーンにいるはず"
        );

        let saved = std::fs::read_to_string(&quicksave_path)
            .expect("シーン切り替えでクイックセーブファイルが書き込まれているはず");
        assert!(
            saved.contains("\"scene_id\":\"1-4\""),
            "保存されるscene_idは中継先ではなく最終着地シーン(1-4)のはず, saved was: {saved}"
        );
        assert!(
            !saved.contains("\"scene_id\":\"1-2\"") && !saved.contains("\"scene_id\":\"1-3\""),
            "中継シーン自体のIDが保存されてはいけない, saved was: {saved}"
        );
        assert!(
            saved.contains("seen_relay_a") && saved.contains("seen_relay_b"),
            "中継シーンを2つとも実際に通過した(フラグが両方立った)ことの確認, saved was: {saved}"
        );

        let _ = std::fs::remove_file(&quicksave_path);
    }

    #[test]
    fn choice_immediately_followed_by_another_choice_keeps_reveal_none_after_jump() {
        // jump先シーンの先頭itemがまたChoiceであるケース（連続分岐）。build_reveal_for_current
        // は current_line() が None（＝現在Choice）のとき None を返すため、jump直後も
        // current_reveal は None のまま維持されるはず。
        //
        // "1-2" はあえて選択肢を2件（さらに進む/戻る）にしている。1件だけだと#574の
        // 「純粋な中継シーン（本文無し・Choice1件だけ）自動継続」の対象になり、
        // この本テストが検証したい「jump直後に別のChoiceで止まる」状況を再現できず
        // 直接"1-3"まで進んでしまう（このテストの意図とは無関係な#574の挙動と衝突する）。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n[選択]\n- 進む→1-2\n[/選択]\n\n## 1-2: 次\n\n[選択]\n- さらに進む→1-3\n- 戻る→1-1\n[/選択]\n\n## 1-3: 最後\n\n**C**:\n最後のセリフ\n";
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

    // ---- テスト観点整理担当の指摘に基づく追加テスト（#497/#498型再発確認・状態遷移の
    // 排他制御・境界値・null/空文字・正常系）。既存カバレッジと重複する範囲は避け、
    // #498/#499/#500/#503（オート/スキップ/バックログ/設定オーバーレイ）のevent_loop
    // レベルのテストがこれまで一件も存在しなかった領域に絞る。 ----

    #[test]
    fn event_loop_closing_backlog_overlay_resets_auto_deadline_preventing_stale_cascade() {
        // #497/#498型の再発確認: バックログを開いている間にauto_wait_ms(締切)を実時間で
        // 過ぎ去らせてから閉じても、閉じた直後の1フレームで過ぎ去った締切により
        // 即座にauto advanceが起きてはいけない(`auto_deadline = None`リセットの回帰ガード)。
        let mut config = instant_config();
        config.auto_wait_ms = 200;
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "one"), dline(Some("B"), "two")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleAuto),
                2 => Ok(Action::ToggleBacklog), // オーバーレイを開く
                3 => {
                    // auto_wait_ms(200ms)より十分長く待ち、開いている間に張られた締切を
                    // 確実に過去のものにする。
                    std::thread::sleep(Duration::from_millis(400));
                    Ok(Action::ToggleBacklog) // 閉じる
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            1,
            "オーバーレイを閉じた直後に過ぎ去ったauto_deadlineでカスケード的に \
             自動送りされてはいけない(#497/#498型再発防止)"
        );
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("A")
        );
    }

    #[test]
    fn event_loop_closing_settings_overlay_also_resets_auto_deadline() {
        // 上のテストの設定画面(#503)版。バックログと同じ`auto_deadline = None`リセットの
        // コード経路が設定画面を閉じたときにも適用されることの回帰ガード。
        let mut config = instant_config();
        config.auto_wait_ms = 200;
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "one"), dline(Some("B"), "two")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleAuto),
                2 => Ok(Action::ToggleSettings),
                3 => {
                    std::thread::sleep(Duration::from_millis(400));
                    Ok(Action::ToggleSettings)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(playback.position(), 1);
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("A")
        );
    }

    // ---- #500/#503 セルフレビュー must対応: オーバーレイの実時間経過がタイプライター表示/
    // クロスフェードへ漏れ込まないことの回帰ガード ----
    //
    // `event_loop_closing_backlog_overlay_resets_auto_deadline_preventing_stale_cascade`
    // 等の上のテスト群は `instant_config()`（char_interval_ms=0、生成と同時に完了扱い）を
    // 使っているため、そもそも「タイプ中」の状態が存在せず、このバグを検出できない
    // （レビュアー指摘）。ここでは `slow_config()`（char_interval_ms=1000）を使い、
    // オーバーレイを開いた瞬間には1文字目しか見えていない状態を作ってから、
    // オーバーレイを開いたまま実時間で1文字ぶんの間隔（1000ms）近くを待って閉じ、
    // 閉じた直後の描画結果（`TestBackend` バッファ）に2文字目以降が漏れ出ていないことを
    // 実際に表示された文字で確認する。

    #[test]
    fn event_loop_closing_backlog_overlay_does_not_leak_overlay_duration_into_typewriter() {
        // 修正前の実装では、オーバーレイを開いていた実時間がそのまま `current_reveal`
        // （`jiwa::RevealHandle` ベース）の経過時間計算に漏れ込み、閉じた直後に
        // オーバーレイを開く前には見えていなかった文字が一気に表示されてしまっていた
        // （レビュアー実機再現: char_interval_ms=1000で表示途中にバックログを開き実時間
        // 1.5秒程度待ってから閉じると1〜2文字余分に表示される）。この回帰ガードはその
        // 再現条件をほぼそのまま踏襲する。
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "abcdefghij")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                // 1回目のフレームはまだ何もキー入力していない状態で描画されている
                // （＝reveal開始直後、"a"のみ可視）。ここで即座にバックログを開く。
                1 => Ok(Action::ToggleBacklog),
                2 => {
                    // char_interval_ms(1000ms)を1境界ぶん超える実時間を、オーバーレイを
                    // 開いたまま経過させる。修正前ならこの間に2文字目("b")が
                    // 見えてしまうはずの長さ（800ms程度では1000msの境界を跨がず
                    // 修正の有無に関わらず1文字のままになってしまうため、意図的に
                    // 1000msを超える値にしている）。
                    std::thread::sleep(Duration::from_millis(1200));
                    Ok(Action::ToggleBacklog) // 閉じる
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        let text = buffer_text(&terminal);
        assert!(text.contains('a'), "1文字目は表示されているはず: {text:?}");
        assert!(
            !text.contains("ab"),
            "オーバーレイを開いていた実時間(1200ms)が漏れ込み、2文字目まで表示されて \
             しまっている(#500/#503セルフレビューmust再発防止): {text:?}"
        );
    }

    #[test]
    fn event_loop_closing_settings_overlay_does_not_leak_overlay_duration_into_typewriter() {
        // 上のテストの設定画面(#503)版。バックログと同じ `close_overlay` 経路が
        // 設定画面を閉じたときにも適用されることの回帰ガード。
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "abcdefghij")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => {
                    // 上のバックログ版と同じ理由でchar_interval_ms(1000ms)の境界を
                    // 超える長さにしている。
                    std::thread::sleep(Duration::from_millis(1200));
                    Ok(Action::ToggleSettings)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        let text = buffer_text(&terminal);
        assert!(text.contains('a'));
        assert!(
            !text.contains("ab"),
            "設定画面を開いていた実時間が漏れ込み、2文字目まで表示されてしまっている: {text:?}"
        );
    }

    #[test]
    fn event_loop_settings_speed_change_mid_overlay_does_not_freeze_typewriter_after_close() {
        // セルフレビュー再指摘の回帰ガード: 設定画面表示中に速度変更(#503)すると
        // `restart_reveal_for_speed_change` が `current_reveal` を新しいアンカーで作り
        // 直す。ここで「設定画面を開いてから速度変更キーを押すまで」の待ち時間が長いと、
        // `close_overlay` が誤って `overlay_opened_at`（開いた瞬間）からの全期間を差し
        // 引いてしまい、アンカーが実際の close 時刻より未来へ押し出されて、閉じた直後
        // タイプライターが一時的に凍結する退行があった（正しくは、作り直された瞬間
        // `reveal_rebuilt_at` からの経過だけを差し引くべき）。
        let config = slow_config(); // char_interval_ms = 1000
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "abcdefghij")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings), // 設定画面を開く
                2 => {
                    // 開いてからしばらく考えてから速度を変える、という自然な操作フロー。
                    std::thread::sleep(Duration::from_millis(800));
                    // char_interval_ms: 1000 -> saturating_add(5).min(200) = 200
                    Ok(Action::MoveDown)
                }
                3 => {
                    std::thread::sleep(Duration::from_millis(700));
                    Ok(Action::ToggleSettings) // 閉じる
                }
                4 => {
                    // 閉じた後、十分な実時間を与える。バグがあれば速度変更前の待ち時間
                    // (800ms)ぶんアンカーが未来へ押し出されたままなので、この程度では
                    // まだ動き出さない。
                    std::thread::sleep(Duration::from_millis(900));
                    Ok(Action::None)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        let text = buffer_text(&terminal);
        assert!(
            text.contains('d'),
            "設定画面を閉じてから900ms経過(200ms/字なら4文字分)しているのに \
             タイプライターが凍結していて4文字目まで進んでいない(#503セルフレビュー \
             再指摘の回帰): {text:?}"
        );
    }

    #[test]
    fn event_loop_settings_move_right_focuses_bgm_volume_and_move_down_increments_it() {
        // 音量調整UI(#503)の配線確認: ←→でBGM音量行へフォーカスを移し、↓で
        // VOLUME_STEP_PERCENT(5)ぶん増加することを、実際にdraw_settingsが描画する
        // テキストで確認する(内部のconfigは event_loop がオーナーシップを持つ可変
        // コピーのため、呼び出し元からは直接参照できない)。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "テスト")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings), // 開く(フォーカスはTextSpeed)
                2 => Ok(Action::MoveRight),      // フォーカスをBgmVolumeへ
                3 => Ok(Action::MoveDown),       // bgm_percent: 70 -> 75
                // 意図的な停止(既存の`event_loop_backlog_overlay_ignores_...`と同じ
                // パターン)。`Action::Quit`は overlay 表示中は「閉じる」に読み替わって
                // しまい、後続の周回で通常画面が再描画されてから初めてループを抜けるため、
                // 直後の(BgmVolume=75%が反映された)描画をそのまま検証対象にできない。
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None, // audio: Noneでもpanicしないことも併せて確認する
            false,
        );
        assert!(result.is_err(), "テスト用の意図的な停止のはず");

        let text = buffer_text(&terminal);
        assert!(
            text.contains("75%"),
            "BGM音量がVOLUME_STEP_PERCENT(5)ぶん増加(70->75)して表示されているはず: {text:?}"
        );
        assert!(
            text.contains("> BGM音量"),
            "フォーカスマーカーがBGM音量行に付いているはず: {text:?}"
        );
    }

    #[test]
    fn event_loop_settings_reopening_resets_focus_to_text_speed() {
        // 設定画面を閉じて再度開くと、前回のフォーカス位置(BgmVolume)を引きずらず
        // 既定のTextSpeedへ戻ることを確認する(#503、backlog_scrollを開くたびに
        // u16::MAXへ戻すのと同じ「オーバーレイごとに初期状態から始める」パターン)。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "テスト")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings), // 開く
                2 => Ok(Action::MoveRight),      // フォーカスをBgmVolumeへ
                3 => Ok(Action::ToggleSettings), // 閉じる
                4 => Ok(Action::ToggleSettings), // 再度開く
                // 意図的な停止(上のテストと同じ理由)。
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err(), "テスト用の意図的な停止のはず");

        let text = buffer_text(&terminal);
        assert!(
            text.contains("> テキスト表示速度"),
            "再度開いた時点でフォーカスがTextSpeedへリセットされているはず: {text:?}"
        );
        assert!(
            !text.contains("> BGM音量"),
            "前回閉じた時点のBgmVolumeフォーカスを引きずっていないはず: {text:?}"
        );
    }

    #[test]
    fn event_loop_closing_backlog_overlay_does_not_leak_overlay_duration_into_image_crossfade() {
        // `image_fade`（イベント絵クロスフェード）も `current_reveal` と同じ `Instant`
        // アンカー方式のため、同じ漏れ込みバグを抱えていないか確認する回帰ガード
        // （セルフレビュー指摘: reveal と同じ方針で調査・修正すること）。
        // crossfade_ms(300ms) をオーバーレイの実時間経過(500ms)より短くしておくことで、
        // 「開いていた実時間がそのままフェード進行に加算される(バグ)」場合は
        // t=500/300>1.0でクランプされ`to`の色そのものになり、「補正されている(修正後)」
        // 場合はt≈0(オーバーバーヘッド分のみ)で`from`寄りの色のままになる、という
        // 二値的で検出しやすい差にする。
        let fixture_from = (10u8, 200u8, 10u8);
        let fixture_to = (200u8, 10u8, 10u8);
        let fixture_from_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_from, 2, 2), 2, 2);
        let fixture_to_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_to, 2, 2), 2, 2);
        let mut config = instant_config();
        config.event_image.assets_dir = fixture_from_path.parent().unwrap().to_path_buf();
        config.event_image.crossfade_ms = 300;
        let relative_from = fixture_from_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let relative_to = fixture_to_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "one", Some(relative_from)),
            dline_with_image(Some("B"), "two", Some(relative_to)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                // 1行目→2行目へ進み、フェードを開始させる。
                1 => Ok(Action::Advance),
                // フェード開始直後にバックログを開く。
                2 => Ok(Action::ToggleBacklog),
                3 => {
                    // crossfade_ms(300ms)より長い実時間をオーバーレイ表示中に経過させる。
                    // 修正前ならこの分がそのままフェード進行に加算され、t>=1.0となって
                    // 完了(`to`の色そのもの)扱いになってしまう。
                    std::thread::sleep(Duration::from_millis(500));
                    Ok(Action::ToggleBacklog)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert!(
            !buffer_has_bg_color(terminal.backend().buffer(), fixture_to),
            "オーバーレイを開いていた実時間(500ms)がクロスフェード(300ms)の進行に \
             漏れ込み、本来ごくわずかしか進んでいないはずのフェードが完了して \
             見えてしまっている(#500/#503セルフレビューmust再発防止)"
        );
    }

    #[test]
    fn event_loop_overlay_polling_does_not_mark_current_line_as_read() {
        // #499型の再発確認: バックログ表示中もREDRAWポーリング（`Action::None`）は続くが、
        // 「見ているだけ」で現在行がread_positionsへ新規追加されてはいけない
        // （既読集合はAction::Advanceで実際に離脱した瞬間にのみ更新される設計）。
        // オーバーレイを閉じた直後にスキップをONにして、まだ一度も離脱していない
        // 1行目が即座に飛ばされない（＝スキップが即座に解除される）ことで間接的に確認する。
        let config = instant_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "one"), dline(Some("B"), "two")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, _remaining) = action_queue(vec![
            Action::ToggleBacklog,
            Action::None,
            Action::None,
            Action::None,
            Action::ToggleBacklog,
            Action::ToggleSkip,
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            1,
            "バックログを見ていただけの1行目がREDRAWポーリングで既読扱いになり、\
             閉じた直後のスキップONで2行目へ自動的に飛ばされてはいけない"
        );
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("A")
        );
    }

    #[test]
    fn sentence_per_page_skip_after_revisiting_a_fully_read_line_fast_forwards_through_to_the_choice(
    ) {
        // 【#499 実装バグ調査の結論、テスト実装担当の指摘を検証した結果】
        //
        // 当初「read_positionsがLine item単位（`playback.position()`）でしか既読を記録しない
        // 一方バックログは文単位でエントリを積むため、複数文を持つLine itemを再訪して1文目で
        // 止まっている状態からスキップすると、今回まだ見ていない2文目以降を確認なしに
        // 飛ばしてしまうのではないか」という懸念でこのテストは red のまま残されていた。
        //
        // 検証のため実際に `read_positions` を `(position, sentence_index)` の複合キーへ
        // 変更し文単位の既読判定を実装したところ、この具体的なシナリオでは**挙動が一切
        // 変わらなかった**（生成コードのdiffを戻してもこのテストのpanicメッセージは
        // byte-exactに同一）。理由: このエンジンの `Playback::advance` は同一 Line item 内の
        // 文を必ず 0→1→…→末尾の順に一度も飛ばさず辿る設計であり、「item全体が既読」という
        // 粗い印（旧実装）が立つのは、必ずその item の**全ての文を実際に辿り終えた後**
        // （item境界を越える最後の advance が成功した瞬間）だけ。つまり粗いitem単位の印は
        // 「その中の全文を個別に辿り終えている」ことの必要十分条件であり、文単位に分解しても
        // 判定結果は変わらない（ある文だけ未読のままitem全体が既読になる中間状態が原理的に
        // 作れない）。
        //
        // さらに、この feature の仕様上の参照実装である GUI版
        // （`frontend/src/game/NovelRenderer.ts` の `readProgress`/`markRead`、Issue #499 本文が
        // 明記）も、`computeDisplayIndex`（イベント単位、文単位ページindexを含まない）だけを
        // 既読キーにしており、GUI版そのものが文単位の細分をしていない——今回のシナリオの
        // ような「一度最後まで読んだ行をジャンプで再訪し、スキップで再度通過する」動きは、
        // 単一文の行に対してはこのすぐ下の
        // `event_loop_skip_through_read_line_stops_exactly_at_choice_without_auto_confirming`
        // が既に「選択肢まで一気に通過する」ことを正として検証済みであり、文単位ページを
        // 使っていても結論は変わらないのが一貫した挙動。
        //
        // 以上により、これは実装バグではなく「一度最後まで読み終えた内容を再訪してスキップ
        // すれば、選択肢まで一気に通過する」という正しいスキップ挙動だったと判断し、
        // アサーションを実際の（かつ意図した）結果に合わせて修正する。「未読テキストに
        // 到達したら止まる」という本質的な仕様は、他のテスト
        // （`event_loop_overlay_polling_does_not_mark_current_line_as_read` 等）で別途保証済み。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n\
                       最初の文。二番目の文。\n\n[選択]\n- 戻る→1-1\n[/選択]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document).with_sentence_per_page(true);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, remaining) = action_queue(vec![
            Action::Advance,    // 1文目 -> 2文目
            Action::Advance,    // 2文目 -> 選択肢へ離脱（読了マーク）
            Action::Advance,    // 選択肢確定「戻る」-> 1-1 の1文目へジャンプし直す
            Action::ToggleSkip, // 再訪した1文目（既読）からスキップON
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert!(
            playback.current_choice().is_some(),
            "既読の行を再訪してスキップを機能させれば、1文目・2文目とも既読のため \
             選択肢まで一気に通過するはず。実際: current_line={:?}, at_choice={}",
            playback.current_line(),
            playback.current_choice().is_some()
        );
        assert_eq!(
            *remaining.borrow(),
            0,
            "スキップが実際に機能していれば、追加のAdvance無しで選択肢まで到達するはず"
        );
    }

    #[test]
    fn event_loop_skip_stops_at_unread_line_after_revisiting_hub_scene_with_shifted_item_count() {
        // #539 (元#533): event_loopレベルの統合テスト。playback.rs側の単体テスト
        // (`stable_item_key_content_hash_differs_when_flag_dependent_scene_item_count_itself_shifts_across_revisits`)
        // は`stable_item_key`の戻り値だけを検証していたが、実際に`event_loop`を通して
        // 「スキップ中に内容の変わったhubシーンへ再訪した際、`skip_triggered`が正しく
        // 偽になりスキップが止まるか」を確認する統合テストがなかった（セルフレビュー指摘）。
        //
        // route1でmilestone_a_pending=trueにしてhubへ→hub内は「Aの手紙」1件だけを読んで
        // 選択肢へ離脱（既読マーク）→route2でフラグを反転→hubへ再訪すると、今度は
        // Condition分岐先のitem数自体が1件→2件に増え「Bの手紙1」「Bの手紙2」が表示される。
        // 2回目訪問直後（＝Bの手紙1が現在行の状態）でスキップONにしても、Bの手紙1は
        // 一度も読んでいない新規内容のため、選択肢まで一気に飛ばされず即座に止まるはず。
        //
        // route2（Flag設定のみ・Choiceが1件だけ）は#574の「純粋な中継シーン自動継続」の
        // 対象のため、「次のルートへ」確定の1回のAdvanceでroute2を経由してhub(2回目訪問)の
        // Bの手紙1まで一気に到達する（#574以前はroute2でいったん止まり、route2の
        // 「hubへ」を確定するAdvanceがもう1回必要だった）。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n\
                       ## 1-1: route1\n\n\
                       [フラグ: milestone_a_pending=true]\n\
                       [フラグ: milestone_b_pending=false]\n\n\
                       [選択]\n- hubへ→1-2\n[/選択]\n\n\
                       ## 1-2: hub\n\n\
                       [条件: milestone_a_pending]\n\
                       **施設**:\nAの手紙\n\n\
                       [/条件]\n\
                       [条件: milestone_b_pending]\n\
                       **施設**:\nBの手紙1\n\n\
                       **施設**:\nBの手紙2\n\n\
                       [/条件]\n\
                       [選択]\n- 次のルートへ→1-3\n[/選択]\n\n\
                       ## 1-3: route2\n\n\
                       [フラグ: milestone_a_pending=false]\n\
                       [フラグ: milestone_b_pending=true]\n\n\
                       [選択]\n- hubへ→1-2\n[/選択]\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, _remaining) = action_queue(vec![
            Action::Advance, // route1のChoice「hubへ」確定 -> hub(1回目訪問)、Aの手紙
            Action::Advance, // Aの手紙 -> Choice「次のルートへ」へ離脱（既読マーク）
            // 「次のルートへ」確定 -> route2(#574の純粋な中継シーン)を自動通過 ->
            // hub(2回目訪問)、Bの手紙1（未読の新規item）
            Action::Advance,
            Action::ToggleSkip, // 2回目訪問直後、未読のBの手紙1からスキップを試みる
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.current_line().unwrap().text,
            vec!["Bの手紙1".to_string()],
            "item数がずれて(1件→2件)local_index=0の内容がAの手紙からBの手紙1に変わった \
             2回目訪問では、Bの手紙1は一度も読んでいないためスキップが即座に選択肢まで \
             飛ばさず、そこで止まるはず(skip_triggeredがコンテンツハッシュの不一致により \
             正しく偽になる、#539/#533)"
        );
        assert!(
            playback.current_choice().is_none(),
            "スキップが誤って選択肢まで進んでしまってはいけない"
        );
    }

    #[test]
    fn event_loop_empty_first_scene_landing_line_is_not_falsely_marked_as_read() {
        // #558のフォローアップ: on_advanceが表示コンテンツの無いシーン（items 0件、
        // 例game_init）から次シーンの新規itemへ一気に進めるようになったことで、
        // 「advance前のprev_item_index=0」がadvance後に新規構築された次シーンの
        // 最初のitem自身を指してしまい、まだ一度も表示していない行が誤って
        // read_positionsに既読マークされる副作用が発生した（実機テスト作成中に発覚）。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: 探索済み = true]\n\n## 1-2: ハブ\n\n\
                       **A**:\nおかえりなさい\n\n**B**:\n次の話\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, _remaining) = action_queue(vec![
            Action::Advance,    // items 0件の1-1 -> 1-2の1行目(A)へ一気に進む（#558新分岐）
            Action::ToggleSkip, // 着地直後、まだ未読のはずのAでスキップを試みる
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            1,
            "空シーンから合流した直後のhub1行目が誤ってread_positionsに既読マークされ、\
             スキップで2行目(B)まで飛ばされてはいけない"
        );
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("A")
        );
    }

    #[test]
    fn event_loop_backlog_overlay_ignores_auto_skip_settings_toggle_keys() {
        // #500: バックログ表示中に a/s/c（オート/スキップ/設定トグル）を送っても、
        // overlayを含む状態が変化してはいけない。a/s/cを送った直後もoverlayが
        // Backlogのまま（Settingsへ変化していない）ことを描画内容で確認する。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleBacklog),
                2 => Ok(Action::ToggleAuto),
                3 => Ok(Action::ToggleSkip),
                4 => Ok(Action::ToggleSettings),
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err(), "テスト用の意図的な停止のはず");

        let text = buffer_text_wide_aware(&terminal);
        assert!(
            text.contains("BACKLOG"),
            "a/s/cキーでオーバーレイがBacklog以外へ変化してはいけない, buffer was: {text}"
        );
        assert!(!text.contains("設定"), "buffer was: {text}");
    }

    #[test]
    fn event_loop_settings_overlay_ignores_auto_skip_backlog_toggle_keys() {
        // #503: 設定画面表示中に a/s/b（オート/スキップ/バックログトグル）を送っても、
        // overlayを含む状態が変化してはいけない。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::ToggleAuto),
                3 => Ok(Action::ToggleSkip),
                4 => Ok(Action::ToggleBacklog),
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err(), "テスト用の意図的な停止のはず");

        let text = buffer_text_wide_aware(&terminal);
        assert!(
            text.contains("設定"),
            "a/s/bキーでオーバーレイがSettings以外へ変化してはいけない, buffer was: {text}"
        );
        assert!(!text.contains("BACKLOG"), "buffer was: {text}");
    }

    #[test]
    fn event_loop_quit_while_overlay_open_only_closes_overlay_second_quit_terminates_app() {
        // #500/#503: オーバーレイ表示中のq/Escはアプリ終了ではなくオーバーレイを閉じる
        // だけ。もう一度q/Escを押して初めて本当に終了する（2段階操作）。
        // `remaining`が0（3件すべて消費）まで進むことで、1回目のQuitで早期終了して
        // いないことを確認する（もし早期終了していれば2件しか消費されず1が残る）。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, remaining) =
            action_queue(vec![Action::ToggleBacklog, Action::Quit, Action::Quit]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            *remaining.borrow(),
            0,
            "1回目のQuitはオーバーレイを閉じるだけで終了してはいけない \
             (2回目のQuitまで消費されるはず)"
        );
    }

    #[test]
    fn event_loop_enabling_skip_while_auto_active_turns_off_auto_preventing_stale_auto_advance() {
        // #498/#499: オートON中にスキップをONにすると、オートは排他的にOFFになる。
        // OFFになっていなければ、auto_wait_ms経過後に（スキップの既読判定とは無関係に）
        // 自動送りが発火して2行目へ進んでしまうはず。
        let mut config = instant_config();
        config.auto_wait_ms = 50;
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "one"), dline(Some("B"), "two")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleAuto),
                2 => Ok(Action::ToggleSkip),
                3 => {
                    // 元のauto_wait_ms(50ms)よりはるかに長く待つ。オートが排他的にOFFに
                    // なっていなければ、ここでauto_deadline発火が観測できるはず。
                    std::thread::sleep(Duration::from_millis(200));
                    Ok(Action::None)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            1,
            "スキップON操作でオートが排他的にOFFになるはず。OFFになっていなければ \
             auto_wait_ms経過後に自動送りが発火し2行目へ進んでしまう"
        );
    }

    #[test]
    fn event_loop_enabling_auto_while_skip_active_turns_off_skip_and_auto_still_fires() {
        // #498/#499: 逆方向（スキップON中にオートをONにする）でも排他が成り立つことを
        // 確認する。スキップが残っていると誤動作しうるが、正しく排他が効いていれば
        // オートだけがauto_wait_ms後に1行分だけ正常に発火する。
        let mut config = instant_config();
        config.auto_wait_ms = 50;
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "one"),
            dline(Some("B"), "two"),
            dline(Some("C"), "three"),
        ]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSkip),
                2 => Ok(Action::ToggleAuto),
                3 => {
                    std::thread::sleep(Duration::from_millis(200));
                    Ok(Action::None)
                }
                4 => Ok(Action::None),
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            2,
            "スキップ->オートの排他遷移後、オートがちょうど1回だけ発火してBへ進むはず"
        );
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("B")
        );
    }

    #[test]
    fn event_loop_skip_through_read_line_stops_exactly_at_choice_without_auto_confirming() {
        // #499/#482: 既読の会話行をスキップで通過した先が選択肢の場合、選択肢に到達した
        // 時点で自動的にスキップが解除され、選択肢を勝手に確定したりはしない
        // （GUI版 #140の「選択肢到達で setSkipMode(false)」と同じ）。同時に、既読内容を
        // 実際に自動送りできている（スキップが機能している）ことも確認する。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n\
                       最初のセリフ\n\n[選択]\n- 進む→1-2\n- 戻る→1-1\n[/選択]\n\n\
                       ## 1-2: 次\n\n**B**:\n次のセリフ\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, remaining) = action_queue(vec![
            Action::Advance,    // A読了 -> 選択肢へ離脱（read_positionsにAを記録）
            Action::MoveDown,   // カーソルを「戻る」へ
            Action::Advance,    // 「戻る」確定 -> 1-1のAへジャンプし直す
            Action::ToggleSkip, // 既読のAからスキップ開始
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert!(
            playback.current_choice().is_some(),
            "既読行のスキップは選択肢に到達した時点で止まり、自動確定してはいけない"
        );
        assert_eq!(
            *remaining.borrow(),
            0,
            "スキップが実際に機能していれば、追加のAdvance無しで選択肢まで到達するはず"
        );
    }

    #[test]
    fn event_loop_skip_stops_at_true_script_end_without_error() {
        // #499: スキップ中にスクリプト末尾（is_at_end）に到達すると自動的にスキップが
        // 解除される。最終行は「離脱」できないため原理的にread_positionsへ記録され得ず、
        // 誤ってそこへ進もうとしてエラー/パニックしないことも合わせて確認する。
        let config = instant_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "one"), dline(Some("B"), "two")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, _remaining) = action_queue(vec![
            Action::Advance,    // A読了 -> B（最終行）へ
            Action::ToggleSkip, // 末尾Bでスキップを試みる
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(playback.position(), 2);
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("B")
        );
        assert!(playback.is_at_end());
    }

    // ---- #498: オートモードの選択肢到達/スクリプト末尾での非発火（should対応） ----
    //
    // スキップモードには上の
    // `event_loop_skip_through_read_line_stops_exactly_at_choice_without_auto_confirming`/
    // `event_loop_skip_stops_at_true_script_end_without_error` という対のテストがあるが、
    // オートモードには同種のテストが無かった（セルフレビュー指摘）。オートモードは
    // `event_loop` の `eligible = reveal_done && current_choice().is_none() && !is_at_end`
    // というガードで選択肢到達/末尾到達の両方をカバーしているはずだが、この2つのテストで
    // 実際にその通り動くことを確認する。

    #[test]
    fn event_loop_auto_mode_does_not_auto_confirm_when_a_choice_is_reached() {
        // オートモード中に自動送りで選択肢へ到達しても、選択肢を勝手に確定したりはしない
        // （`eligible` が `current_choice().is_none()` を要求するため、選択肢到達時点で
        // `auto_deadline` が再設定されなくなる）。手動 `Action::Advance` で選択肢へ進むと
        // その操作自体がオートモードを解除してしまう（「手動操作でauto/skipをキャンセル
        // する」既存挙動）ため、ここでは意図的にオートの自動送り自体で選択肢まで
        // 到達させ、手動操作を一切使わない。
        let mut config = instant_config();
        config.auto_wait_ms = 30;
        let source = "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n\
                       最初のセリフ\n\n[選択]\n- 進む→1-2\n- 戻る→1-1\n[/選択]\n\n\
                       ## 1-2: 次\n\n**B**:\n次のセリフ\n";
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
            match call_count {
                1 => Ok(Action::ToggleAuto), // Aの行でオートON（reveal即完了）
                2 => {
                    // auto_wait_ms(30ms)を超えて待ち、オート自身の自動送りでAから
                    // 選択肢へ進ませる（この待機の間にnext_action経由でなく
                    // ループ側が合成Advanceを発火させる）。
                    std::thread::sleep(Duration::from_millis(120));
                    Ok(Action::None)
                }
                3 => {
                    // 選択肢に到達した後、さらに待っても自動確定されないことを
                    // 確認するための追加待機。
                    std::thread::sleep(Duration::from_millis(120));
                    Ok(Action::None)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert!(
            playback.current_choice().is_some(),
            "オートモードは選択肢到達時点で発火が止まり、自動確定してはいけない"
        );
    }

    #[test]
    fn event_loop_auto_mode_stops_firing_at_true_script_end_without_error() {
        // オートモードがスクリプト末尾（is_at_end）に到達すると、`eligible` の
        // `!is_at_end` 条件により以後 `auto_deadline` が再設定されなくなる。
        // 末尾到達後にさらに待っても、位置が異常に進んだりエラー/パニックになったり
        // しないことを確認する。
        let mut config = instant_config();
        config.auto_wait_ms = 30;
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "one"), dline(Some("B"), "two")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleAuto), // Aの行でオートON
                2 => {
                    // auto_wait_ms(30ms)を超えて待ち、A(最終行の1つ手前)からB(末尾)への
                    // 自動送りを起こす。
                    std::thread::sleep(Duration::from_millis(120));
                    Ok(Action::None)
                }
                3 => {
                    // B(末尾)到達後、さらに待っても追加の発火が起きないことを確認する
                    // ための追加待機。
                    std::thread::sleep(Duration::from_millis(120));
                    Ok(Action::None)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(playback.position(), 2);
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("B")
        );
        assert!(playback.is_at_end());
    }

    #[test]
    fn event_loop_skip_stops_at_first_unread_line_keeping_it_displayed_not_skipped() {
        // #499: スキップ中に未読行に到達すると、その場でスキップが解除され現在行が
        // （次へ飛ばされず）表示維持される。既読済みのAを通過した直後の未読Bで確認する
        // （末尾ではない＝上のテストの「末尾到達」条件とは別の、純粋な「未読」条件を狙う）。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "one"),
            dline(Some("B"), "two"),
            dline(Some("C"), "three"),
        ]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let (mut next_action, _remaining) = action_queue(vec![
            Action::Advance,    // A読了 -> B（未読）へ
            Action::ToggleSkip, // 未読のBでスキップを試みる
            Action::Quit,
        ]);

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            2,
            "未読行に到達した時点でスキップが解除され、Cへ飛ばされてはいけない"
        );
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("B")
        );
    }

    #[test]
    fn event_loop_backlog_gains_entry_only_after_leaving_a_line_not_while_still_displaying_it() {
        // #500: バックログには「実際に離脱した」行だけが積まれる。まだ表示中（離脱前）の
        // 行は積まれないことを、Aから離脱した直後にバックログを開いて中身を確認する
        // ことで検証する（Advance直後の意図的な停止で中間状態を覗く）。
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "first line"),
            dline(Some("B"), "second line"),
        ]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::Advance), // A -> B へ離脱、Aがバックログへ積まれるはず
                2 => Ok(Action::ToggleBacklog), // 中身を確認するために開く
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("first line"),
            "離脱済みのAはバックログに積まれているはず, buffer was: {text}"
        );
        assert!(
            !text.contains("second line"),
            "まだ表示中(離脱前)のBはバックログに積まれてはいけない, buffer was: {text}"
        );
    }

    #[test]
    fn restart_reveal_for_speed_change_rebuilds_still_typing_reveal_with_new_speed() {
        // #503: タイプライター表示中に速度変更すると、現在のrevealが新速度で
        // 再構築される（見た目に即座に反映される）。
        let slow = slow_config();
        let playback = Playback::from_lines(vec![dline(Some("A"), "hello there")]);
        let t0 = Instant::now();
        let mut current_reveal = Some(animating(&slow, playback.current_line().expect("line"), t0));
        assert!(
            !current_reveal.as_ref().unwrap().is_done(t0),
            "slow_config前提の確認: まだタイプ中のはず"
        );

        let instant = instant_config();
        restart_reveal_for_speed_change(&playback, &mut current_reveal, &instant, t0);

        assert!(
            current_reveal.as_ref().unwrap().is_done(t0),
            "タイプ中の行は新速度(瞬間表示)で再構築され、即座に完了しているはず"
        );
    }

    #[test]
    fn restart_reveal_for_speed_change_leaves_already_done_reveal_untouched() {
        // #503: 表示完了済みの行は速度変更の対象外——再構築されていたら、新しい
        // slow設定の下では「今」構築し直された分だけ未完了に戻ってしまうはず。
        let instant = instant_config();
        let playback = Playback::from_lines(vec![dline(Some("A"), "hello there")]);
        let t0 = Instant::now();
        let mut current_reveal = Some(animating(
            &instant,
            playback.current_line().expect("line"),
            t0,
        ));
        assert!(
            current_reveal.as_ref().unwrap().is_done(t0),
            "instant_config前提の確認: 既に表示完了済みのはず"
        );

        let slow_new = slow_config();
        let t1 = t0 + Duration::from_millis(1);
        restart_reveal_for_speed_change(&playback, &mut current_reveal, &slow_new, t1);

        assert!(
            current_reveal.as_ref().unwrap().is_done(t1),
            "既に表示完了済みの行はspeed change対象外のはず(再構築されていたら新しい \
             slow設定の下でまだ未完了になっているはず)"
        );
    }

    #[test]
    fn event_loop_settings_char_interval_lower_bound_clamps_to_zero_and_stays() {
        // #503: char_interval_msが5の状態で↑（MoveUp/減少）を押すと0になる（下限到達）。
        // 0からさらに押しても0のまま（saturating_subの下限保持）。
        let mut config = instant_config();
        config.typewriter.char_interval_ms = 5;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveUp), // 5 -> 0
                3 => Ok(Action::MoveUp), // 0 -> 0（下限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text_wide_aware(&terminal);
        assert!(
            text.contains("瞬間表示"),
            "2回目の↑後も0(瞬間表示)のままのはず, buffer was: {text}"
        );
    }

    #[test]
    fn event_loop_settings_char_interval_upper_bound_clamps_to_200_and_stays() {
        // #503: char_interval_msが195の状態で↓（MoveDown/増加）を押すと200になる
        // （上限到達）。200からさらに押しても200のまま（205にはならない、
        // `.min(TEXT_SPEED_MAX_MS)`）。
        let mut config = instant_config();
        config.typewriter.char_interval_ms = 195;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveDown), // 195 -> 200
                3 => Ok(Action::MoveDown), // 200 -> 200（205にならず上限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text_wide_aware(&terminal);
        assert!(
            text.contains("遅い (200ms)"),
            "2回目の↓後も200msのままのはず(205等になっていないか), buffer was: {text}"
        );
    }

    // ---- #537: event_loop経由のBGM/SE/ボイス音量の境界値クランプ ----
    //
    // `event_loop_settings_char_interval_{lower,upper}_bound_clamps_...`と同じ「境界の
    // 1つ外側から2回操作し、2回目も境界のまま」という3手構成をBGM/SE/Voiceへ横展開する。

    #[test]
    fn event_loop_settings_bgm_volume_lower_bound_clamps_to_zero_and_stays() {
        // bgm_percentが5の状態で↑（MoveUp/減少）を押すと0になる（下限到達）。
        // 0からさらに押しても0のまま（saturating_subの下限保持）。
        let mut config = instant_config();
        config.volume.bgm_percent = 5;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveRight), // フォーカスをBgmVolumeへ
                3 => Ok(Action::MoveUp),    // 5 -> 0
                4 => Ok(Action::MoveUp),    // 0 -> 0（下限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("BGM音量: 0%"),
            "2回目の↑後も0%のままのはず, buffer was: {text}"
        );
    }

    #[test]
    fn event_loop_settings_bgm_volume_upper_bound_clamps_to_100_and_stays() {
        // bgm_percentが95の状態で↓（MoveDown/増加）を押すと100になる（上限到達）。
        // 100からさらに押しても100のまま（105にはならない、`.min(VOLUME_MAX_PERCENT)`）。
        let mut config = instant_config();
        config.volume.bgm_percent = 95;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveRight), // フォーカスをBgmVolumeへ
                3 => Ok(Action::MoveDown),  // 95 -> 100
                4 => Ok(Action::MoveDown),  // 100 -> 100（上限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("BGM音量: 100%"),
            "2回目の↓後も100%のままのはず(105等になっていないか), buffer was: {text}"
        );
    }

    #[test]
    fn event_loop_settings_se_volume_lower_bound_clamps_to_zero_and_stays() {
        // se_percentが5の状態で↑を押すと0になる（下限到達）。0からさらに押しても0のまま。
        let mut config = instant_config();
        config.volume.se_percent = 5;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveRight), // BgmVolumeへ
                3 => Ok(Action::MoveRight), // SeVolumeへ
                4 => Ok(Action::MoveUp),    // 5 -> 0
                5 => Ok(Action::MoveUp),    // 0 -> 0（下限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("SE音量: 0%"),
            "2回目の↑後も0%のままのはず, buffer was: {text}"
        );
    }

    #[test]
    fn event_loop_settings_se_volume_upper_bound_clamps_to_100_and_stays() {
        // se_percentが95の状態で↓を押すと100になる（上限到達）。100からさらに押しても100のまま。
        let mut config = instant_config();
        config.volume.se_percent = 95;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveRight), // BgmVolumeへ
                3 => Ok(Action::MoveRight), // SeVolumeへ
                4 => Ok(Action::MoveDown),  // 95 -> 100
                5 => Ok(Action::MoveDown),  // 100 -> 100（上限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("SE音量: 100%"),
            "2回目の↓後も100%のままのはず(105等になっていないか), buffer was: {text}"
        );
    }

    #[test]
    fn event_loop_settings_voice_volume_lower_bound_clamps_to_zero_and_stays() {
        // voice_percentが5の状態で↑を押すと0になる（下限到達）。0からさらに押しても0のまま。
        // ボイス音量は音声バックエンドへの反映は無い割り切り（`VolumeConfig::voice_percent`の
        // doc comment参照）だが、表示上のクランプ挙動自体はBGM/SEと同じであるべき。
        let mut config = instant_config();
        config.volume.voice_percent = 5;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveRight), // BgmVolumeへ
                3 => Ok(Action::MoveRight), // SeVolumeへ
                4 => Ok(Action::MoveRight), // VoiceVolumeへ
                5 => Ok(Action::MoveUp),    // 5 -> 0
                6 => Ok(Action::MoveUp),    // 0 -> 0（下限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("ボイス音量 (将来用): 0%"),
            "2回目の↑後も0%のままのはず, buffer was: {text}"
        );
    }

    #[test]
    fn event_loop_settings_voice_volume_upper_bound_clamps_to_100_and_stays() {
        // voice_percentが95の状態で↓を押すと100になる（上限到達）。100からさらに押しても
        // 100のまま。
        let mut config = instant_config();
        config.volume.voice_percent = 95;
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "one")]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleSettings),
                2 => Ok(Action::MoveRight), // BgmVolumeへ
                3 => Ok(Action::MoveRight), // SeVolumeへ
                4 => Ok(Action::MoveRight), // VoiceVolumeへ
                5 => Ok(Action::MoveDown),  // 95 -> 100
                6 => Ok(Action::MoveDown),  // 100 -> 100（上限のまま）
                _ => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
            }
        };

        let result = event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        );
        assert!(result.is_err());

        let text = buffer_text(&terminal);
        assert!(
            text.contains("ボイス音量 (将来用): 100%"),
            "2回目の↓後も100%のままのはず(105等になっていないか), buffer was: {text}"
        );
    }

    // ---- #537: Backlogオーバーレイ表示中のMoveLeft/MoveRight無視 ----

    #[test]
    fn event_loop_backlog_overlay_ignores_move_left_and_move_right() {
        // #537: `Action::MoveLeft`/`MoveRight`は`overlay == Overlay::Settings`ガード付きの
        // 分岐にしかマッチせず、Backlog表示中は末尾の`_ => {}`に落ちて完全に無視される
        // はず。バックログのスクロール位置（非公開のstate）に対する副作用が無いことを、
        // 「MoveLeft/MoveRightを挟まない場合」と「挟む場合」で最終描画バッファが
        // 完全一致することを比較して確認する（挟んだ方だけが何か変化していれば、
        // 本来無視されるべきキーが状態を動かしてしまっている）。
        let make_playback = || {
            Playback::from_lines(vec![
                dline(Some("A"), "first line"),
                dline(Some("B"), "second line"),
            ])
        };
        let run = |actions: Vec<Action>| -> String {
            let config = instant_config();
            let mut playback = make_playback();
            let mut terminal = Terminal::new(TestBackend::new(
                ui::REQUIRED_TOTAL_WIDTH,
                ui::REQUIRED_TOTAL_HEIGHT,
            ))
            .unwrap();

            let mut call_count = 0usize;
            let mut next_action = move || -> anyhow::Result<Action> {
                let action = actions.get(call_count).cloned();
                call_count += 1;
                match action {
                    Some(action) => Ok(action),
                    None => Err(anyhow::anyhow!("intentional stop for mid-loop inspection")),
                }
            };

            let result = event_loop(
                &mut terminal,
                &config,
                &mut playback,
                &mut next_action,
                None,
                false,
            );
            assert!(result.is_err(), "テスト用の意図的な停止のはず");
            buffer_text(&terminal)
        };

        let without_left_right = run(vec![Action::Advance, Action::ToggleBacklog]);
        let with_left_right = run(vec![
            Action::Advance,
            Action::ToggleBacklog,
            Action::MoveLeft,
            Action::MoveRight,
        ]);

        assert_eq!(
            without_left_right, with_left_right,
            "MoveLeft/MoveRightを挟んでも挟まなくても、Backlog表示中の描画結果は \
             完全一致するはず(無視されているならば)"
        );
    }

    #[test]
    fn toggle_auto_on_advances_after_wait_then_toggle_off_stops_further_auto_advance() {
        // #498: aキーでオートON/OFFが正しく切り替わる。ONで待機後に自動送りが実際に
        // 発火し、OFFにした後は同じだけ待っても発火しないことを確認する。
        let mut config = instant_config();
        config.auto_wait_ms = 50;
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "one"),
            dline(Some("B"), "two"),
            dline(Some("C"), "three"),
        ]);
        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();

        let mut call_count = 0u32;
        let mut next_action = move || -> anyhow::Result<Action> {
            call_count += 1;
            match call_count {
                1 => Ok(Action::ToggleAuto), // ON
                2 => {
                    std::thread::sleep(Duration::from_millis(150));
                    Ok(Action::None)
                }
                3 => Ok(Action::ToggleAuto), // OFF（B到達直後のはず）
                4 => {
                    std::thread::sleep(Duration::from_millis(150));
                    Ok(Action::None)
                }
                _ => Ok(Action::Quit),
            }
        };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.position(),
            2,
            "ON後の待機で1回だけ自動送りが発火し(A->B)、OFF後は再度待ってもCへは \
             進まないはず"
        );
        assert_eq!(
            playback.current_line().unwrap().speaker.as_deref(),
            Some("B")
        );
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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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
            let result = event_loop(
                &mut terminal,
                &config,
                &mut playback,
                &mut next_action,
                None,
                false,
            );
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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

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

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            playback.current_line().expect("line").speaker.as_deref(),
            Some("B"),
            "手動Advanceを一度も送らずに3連続の画像コマ(a→b→c)を経てBまで自動で \
             進んでいるはず"
        );
    }

    #[test]
    fn event_loop_first_frame_after_skip_leading_empty_scenes_does_not_show_placeholder() {
        // #564統合テスト: `main()`と同じ順序（`Playback`構築 → `skip_leading_empty_scenes`
        // 呼び出し → `event_loop`）をここで再現し、`event_loop`が実際に描画する最初の
        // フレーム（`terminal.draw`は`next_action()`より先に実行される、ループ本体参照）が
        // 既に「(会話行がありません)」プレースホルダーを表示していないことを確認する。
        //
        // `skip_leading_empty_scenes`単体のテスト（`Playback`の位置だけを見るテスト群）は
        // 「位置が進んでいるか」までしか検証できず、それが実際に最初の描画へ反映されるか
        // （`draw_text_windows`のフォールバック分岐を経由しないか）はカバーしない。この
        // テストは`event_loop`本体を`TestBackend`で実際に1フレーム描画させることで、
        // 「main()のセットアップ末尾でのみ呼ぶ想定」というdoc commentの前提（=起動直後・
        // 最初のキー入力前の1フレームを直接カバーする）を実描画で裏取りする。
        let config = instant_config();
        let source = "---\nengine: name-name\n---\n\n## 1-1: 起動\n\n\
                       [フラグ: 探索済み = true]\n\n## 1-2: ハブ\n\n**A**:\nおかえりなさい\n";
        let document = name_name_parser::parser::parse(source);
        let mut playback = Playback::from_document(&document).with_sentence_per_page(false);
        skip_leading_empty_scenes(&mut playback);

        let mut terminal = Terminal::new(TestBackend::new(
            ui::REQUIRED_TOTAL_WIDTH,
            ui::REQUIRED_TOTAL_HEIGHT,
        ))
        .unwrap();
        // `event_loop`は`terminal.draw`を`next_action()`より先に実行するため、最初の呼び出しで
        // `Action::Quit`を返すだけで「起動直後・最初のキー入力前」のフレームがそのまま
        // `terminal`のバッファに残る。
        let mut next_action = move || -> anyhow::Result<Action> { Ok(Action::Quit) };

        event_loop(
            &mut terminal,
            &config,
            &mut playback,
            &mut next_action,
            None,
            false,
        )
        .unwrap();

        let text = buffer_text(&terminal);
        assert!(
            !text.contains("会話行がありません"),
            "skip_leading_empty_scenesを経ているので、起動直後の最初のフレームで \
             プレースホルダーが見えてはいけない: {text:?}"
        );
        // このTUIはゲーム画面に話者名テキストを表示しない設計（`ui::draw_text_windows`は
        // `line.text`のみを描画し、話者は色分け/自分側・相手側判定にのみ使う、実描画で確認
        // 済み）。そのため「話者名が写っている」ではなく、hubシーンの実際の会話文が写って
        // いることをもって「先頭の会話行を指した状態で描画されている」ことの確認とする。
        assert!(
            text.contains("おかえりなさい"),
            "hubシーンの会話行が実際に描画されているはず: {text:?}"
        );
    }
}
