//! イベント絵の切り替え（`DisplayLine::event_image` の変化、`None`⇄`Some` を含む）を
//! `jiwa::lerp_rgb` でセルごとにクロスフェードする（#481）。`reveal.rs`（タイプライター演出）
//! と同じ `Instant` ベースのタイマー構造を踏襲しつつ、色の補間先はテキストの単一色ではなく
//! `image_render::RenderedImage` のセル格子（`cols * rows` 個の fg/bg ペア）になる。

use std::time::{Duration, Instant};

use jiwa::{lerp_rgb, Rgb};
use name_name_parser::models::{AmbientEffects, EventImageTransition};

use crate::ambient_effects::{apply_ambient_effects, elapsed_ms_since_epoch};
use crate::config::Config;
use crate::image_render::{self, ImageCache, QuadrantCell, RenderedImage};
use crate::pixelate_transition::{
    compute_divisor, is_coarsen_phase, PIXELATE_TRANSITION_MAX_DIVISOR,
    PIXELATE_TRANSITION_SWAP_RATIO,
};

/// 現在のイベント絵切り替え状態。`from`/`to` はいずれも Markdown 原稿中の相対パス
/// （`config.event_image.assets_dir` からの相対、`DisplayLine::event_image` と同じ形）。
/// `None` は「イベント絵なし」を表す。`from_effects`/`to_effects`（#582）はそれぞれの画像に
/// 指定されたアンビエント演出フラグ（`path` が `None` のときは無視される）。
///
/// `to_transition`（#583）は「今進行中のこの遷移」がどちらのモードで描かれるかを決める
/// （`from` 側に対応する `from_transition` は持たない — 遷移の見た目はモード1つで決まり、
/// 旧画像がどんなモードで登場したかとは無関係）。[`Self::settled`] 経由で作った状態では
/// `duration` が常にゼロで [`Self::progress`] が常に `1.0` を返すため、値そのものは
/// 参照されない（意味を持つのは [`Self::transition_to`] で新しい遷移を開始した直後から）。
pub struct ImageFadeState {
    from: Option<String>,
    to: Option<String>,
    from_effects: AmbientEffects,
    to_effects: AmbientEffects,
    to_transition: EventImageTransition,
    started_at: Instant,
    duration: Duration,
}

impl ImageFadeState {
    /// トランジション無しの初期状態（`path` が既に定常表示され続けている体で開始する。
    /// `duration` を問わず [`Self::progress`] は常に `1.0` を返す）。
    pub fn settled(path: Option<String>, effects: AmbientEffects) -> Self {
        Self {
            from: path.clone(),
            to: path,
            from_effects: effects,
            to_effects: effects,
            // 常に progress()==1.0 なので参照されない（struct doc comment 参照）。
            to_transition: EventImageTransition::default(),
            started_at: Instant::now(),
            duration: Duration::ZERO,
        }
    }

    /// 現在の表示目標（`to`）パス。呼び出し側（`main.rs`）が `DisplayLine::event_image` の
    /// 変化を検知してトランジションを開始すべきかどうかの判定に使う。
    pub fn current_target(&self) -> Option<&str> {
        self.to.as_deref()
    }

    /// 新しい画像パスへの遷移を開始する。既存の `to` を新しい `from` として引き継ぐ。
    /// 遷移が完了する前にさらに別の画像へ切り替わった場合、そのときの中間色ではなく
    /// 前の遷移の目標パスをそのまま新しい起点にする簡易実装（`from` セルは目標パスの
    /// 画像をそのまま再デコードして使う）ため、連続切り替えでは前のフェードが完了前に
    /// 打ち切られたように見えることがあるが、短時間での連続切り替えは稀なケースとして
    /// 許容する（実際の再生では会話行の切り替えがフェード時間より速く連続することは
    /// タイプライター演出があるため通常起きない）。
    pub fn transition_to(
        &self,
        next: Option<String>,
        next_effects: AmbientEffects,
        next_transition: EventImageTransition,
        duration: Duration,
        now: Instant,
    ) -> Self {
        Self {
            from: self.to.clone(),
            to: next,
            from_effects: self.to_effects,
            to_effects: next_effects,
            to_transition: next_transition,
            started_at: now,
            duration,
        }
    }

    /// `now` 時点の進行度（0.0=開始直後、1.0=完了）。`duration` がゼロなら常に `1.0`
    /// （[`Self::settled`] はこの経路で常に完了扱いになる）。
    fn progress(&self, now: Instant) -> f32 {
        if self.duration.is_zero() {
            return 1.0;
        }
        let elapsed = now.saturating_duration_since(self.started_at);
        (elapsed.as_secs_f32() / self.duration.as_secs_f32()).clamp(0.0, 1.0)
    }

    /// オーバーレイ（バックログ/設定画面）が開いていた実時間（`by`）ぶん、クロスフェードの
    /// アンカー時刻を前進させる。`main.rs` の `close_overlay` が呼ぶ
    /// （[`crate::reveal::RevealState::shift_anchor_forward`] と同じ理由・同じ方針、
    /// セルフレビュー must対応: `current_reveal` だけでなく `image_fade` も `Instant`
    /// アンカーからの経過時間でクロスフェード進行を計算する設計のため、同じ「オーバーレイ
    /// 中の実時間漏れ込み」問題を抱えていた）。`duration` が `Duration::ZERO`（[`Self::settled`]
    /// 経由、または `crossfade_ms=0`）の場合は [`Self::progress`] が常に `1.0` を返すため
    /// この補正自体が観測可能な効果を持たない（無害）。
    pub fn shift_anchor_forward(&mut self, by: Duration) {
        self.started_at += by;
    }

    /// `now` 時点で描画すべき画像セル格子（`cols` x `rows`）。`from`/`to` が両方 `None`
    /// （イベント絵が一度も指定されていない）の場合は `None` を返す — 呼び出し側
    /// （`ui::draw_placeholder`）は `config.placeholder` のラベル表示へフォールバックする。
    pub fn snapshot(
        &self,
        cache: &mut ImageCache,
        config: &Config,
        cols: u16,
        rows: u16,
        now: Instant,
    ) -> Option<RenderedImage> {
        if self.from.is_none() && self.to.is_none() {
            return None;
        }
        let elapsed_ms = elapsed_ms_since_epoch(now);
        let t = self.progress(now);
        if t >= 1.0 {
            return Some(match &self.to {
                Some(path) => resolve_grid(
                    cache,
                    config,
                    path,
                    self.to_effects,
                    elapsed_ms,
                    cols,
                    rows,
                    1,
                ),
                None => image_render::blank_grid(cols, rows),
            });
        }

        // ピクセレート遷移 (#583): アルファクロスフェード（blend）ではなく、コルセン→スワップ→
        // リファインの専用経路を通る（`pixelate_snapshot` 参照）。
        if self.to_transition == EventImageTransition::Pixelate {
            return Some(self.pixelate_snapshot(cache, config, elapsed_ms, cols, rows, t));
        }

        let from_grid = self.from.as_deref().map(|path| {
            resolve_grid(
                cache,
                config,
                path,
                self.from_effects,
                elapsed_ms,
                cols,
                rows,
                1,
            )
        });
        let to_grid = self.to.as_deref().map(|path| {
            resolve_grid(
                cache,
                config,
                path,
                self.to_effects,
                elapsed_ms,
                cols,
                rows,
                1,
            )
        });
        Some(blend(from_grid.as_ref(), to_grid.as_ref(), cols, rows, t))
    }

    /// ピクセレート遷移 (#583) 中の `now` 時点のグリッドを返す。`t < swap_ratio` は `from`
    /// （表示中だった旧画像）をコルセン中として、`t >= swap_ratio` は `to`（新画像）を
    /// リファイン中として描画する — `blend` のように2枚を同時に合成するのではなく、常に
    /// どちらか一方だけを「粗さ」を変えながら描画する（Issue #583 本文の設計、GUI版
    /// `EventImageLayer.performPixelateSwap` と対称: スワップの瞬間に表示対象が切り替わる）。
    /// 対象パスが `None`（例: `from` が無い状態からの初回表示）の場合は
    /// [`image_render::blank_grid`] にフォールバックする（`blend` の missing-side 扱いと同じ
    /// 「黒扱い」の考え方）。
    fn pixelate_snapshot(
        &self,
        cache: &mut ImageCache,
        config: &Config,
        elapsed_ms: u64,
        cols: u16,
        rows: u16,
        t: f32,
    ) -> RenderedImage {
        let divisor = compute_divisor(
            t,
            PIXELATE_TRANSITION_SWAP_RATIO,
            PIXELATE_TRANSITION_MAX_DIVISOR,
        );
        if is_coarsen_phase(t, PIXELATE_TRANSITION_SWAP_RATIO) {
            match self.from.as_deref() {
                Some(path) => resolve_grid(
                    cache,
                    config,
                    path,
                    self.from_effects,
                    elapsed_ms,
                    cols,
                    rows,
                    divisor,
                ),
                None => image_render::blank_grid(cols, rows),
            }
        } else {
            match self.to.as_deref() {
                Some(path) => resolve_grid(
                    cache,
                    config,
                    path,
                    self.to_effects,
                    elapsed_ms,
                    cols,
                    rows,
                    divisor,
                ),
                None => image_render::blank_grid(cols, rows),
            }
        }
    }
}

/// 相対パスをデコード済み画像から quadrant block グリッドへ解決する。パスの解決に失敗した
/// 場合（`..`/絶対パス等の不正な相対パス、ファイル不在、壊れたファイル等）は
/// [`image_render::blank_grid`] にフォールバックし、1枚の画像の問題で再生全体を
/// クラッシュさせない。
///
/// アンビエント演出 (#582): `effects` が何か1つでも有効なら `apply_ambient_effects` で
/// quadrant 変換前の RGBA バッファへピクセル変換を適用する。`elapsed_ms` はゆらぎ・
/// ろうそく揺れの時間経過アニメーション用（呼び出し側 `snapshot` が毎回渡す最新値、
/// このモジュール自体は「いつ」を知らない）。4フラグ全部 false の場合は
/// `apply_ambient_effects` を呼ばずデコード済み RGBA バッファをそのまま
/// `rgba_to_quadrant_grid` へ渡す（演出なし画像で毎フレーム無駄な `pixels.to_vec()` clone が
/// 発生していた回帰の修正、レビュー nit-4 対応）。
///
/// `coarse_divisor`（#583）は `1` なら通常の [`image_render::rgba_to_quadrant_grid`]（アンビエント
/// 演出のみ・粗さなし）、`2` 以上なら [`image_render::rgba_to_quadrant_grid_pixelated`]
/// （ピクセレート遷移中の粗い表示）を呼び分ける。
#[allow(clippy::too_many_arguments)]
fn resolve_grid(
    cache: &mut ImageCache,
    config: &Config,
    relative_path: &str,
    effects: AmbientEffects,
    elapsed_ms: u64,
    cols: u16,
    rows: u16,
    coarse_divisor: u32,
) -> RenderedImage {
    let Some(full_path) = config.resolve_image_path(relative_path) else {
        return image_render::blank_grid(cols, rows);
    };
    match cache.get_or_load(&full_path) {
        Some(decoded) => {
            let pixels = if !effects.wobble && !effects.vignette && !effects.glow && !effects.candle
            {
                None
            } else {
                Some(apply_ambient_effects(
                    &decoded.rgba,
                    decoded.width,
                    decoded.height,
                    effects,
                    elapsed_ms,
                ))
            };
            let rgba = pixels.as_deref().unwrap_or(&decoded.rgba);
            if coarse_divisor <= 1 {
                image_render::rgba_to_quadrant_grid(rgba, decoded.width, decoded.height, cols, rows)
            } else {
                image_render::rgba_to_quadrant_grid_pixelated(
                    rgba,
                    decoded.width,
                    decoded.height,
                    cols,
                    rows,
                    coarse_divisor,
                )
            }
        }
        None => image_render::blank_grid(cols, rows),
    }
}

/// `from`（`None` の場合は全セル [`image_render::BLANK_CELL`] 扱い）から `to` へ、セルごとに
/// `jiwa::lerp_rgb` で fg/bg を補間したグリッドを作る。`from`/`to` の次元が `cols` x `rows`
/// と異なる場合（キャッシュ由来の取り違え等、通常は起きない）はインデックス範囲外を
/// 空扱いにして panic を避ける。
///
/// glyph（文字の形）は色のようには補間できない（ratatui の1セルは単一グリフしか持てない）
/// ため、`t < 0.5` では `from` の形、`t >= 0.5` では `to` の形へ中間点で切り替える。色は
/// `t` の全区間で滑らかに補間され続ける — tui-plan.md が「4象限を2色へ近似する」時点で
/// 形状そのものが近似である以上、切り替え自体も簡易な折衷（形は中間点でハードスイッチ、
/// 色は連続補間）として許容する。
fn blend(
    from: Option<&RenderedImage>,
    to: Option<&RenderedImage>,
    cols: u16,
    rows: u16,
    t: f32,
) -> RenderedImage {
    let count = cols as usize * rows as usize;
    let mut cells = Vec::with_capacity(count);
    for i in 0..count {
        let from_cell = from
            .and_then(|g| g.cells.get(i))
            .copied()
            .unwrap_or(image_render::BLANK_CELL);
        let to_cell = to
            .and_then(|g| g.cells.get(i))
            .copied()
            .unwrap_or(image_render::BLANK_CELL);
        cells.push(QuadrantCell {
            glyph: if t < 0.5 {
                from_cell.glyph
            } else {
                to_cell.glyph
            },
            fg: lerp(from_cell.fg, to_cell.fg, t),
            bg: lerp(from_cell.bg, to_cell.bg, t),
        });
    }
    RenderedImage { cols, rows, cells }
}

fn lerp(a: (u8, u8, u8), b: (u8, u8, u8), t: f32) -> (u8, u8, u8) {
    let Rgb(r, g, b) = lerp_rgb(Rgb(a.0, a.1, a.2), Rgb(b.0, b.1, b.2), t);
    (r, g, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `w`x`h` px の単色 RGBA バイト列を作る（テストフィクスチャ用）。
    fn solid_rgba(color: (u8, u8, u8), w: u32, h: u32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            buf.extend_from_slice(&[color.0, color.1, color.2, 255]);
        }
        buf
    }

    /// `color` の単色WebPフィクスチャを書き出し、`Config::event_image.assets_dir` を
    /// その置き場所へ向けた `Config` と、`DisplayLine::event_image` と同じ形の相対パス
    /// （ファイル名のみ）を返す。
    fn config_and_relative_path_for_solid_fixture(color: (u8, u8, u8)) -> (Config, String) {
        let fixture_path = image_render::write_test_webp_fixture(&solid_rgba(color, 2, 2), 2, 2);
        let mut config = Config::default();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (config, relative)
    }

    #[test]
    fn snapshot_from_none_to_some_path_interpolates_from_black_at_partial_progress() {
        // デシジョンテーブル#2（None→Some(A)）の統合確認。既存の `blend()` 単体テストは
        // 合成済み RenderedImage を直接渡すだけだったが、こちらは
        // `ImageFadeState::snapshot` 経由でパス解決(resolve_grid)からの一気通貫を、
        // 実在するフィクスチャの色で確認する。
        let fixture_color = (200u8, 40u8, 210u8); // 全成分偶数(2で割り切れる)にして丸め誤差を避ける
        let (config, relative) = config_and_relative_path_for_solid_fixture(fixture_color);

        let started_at = Instant::now();
        let state = ImageFadeState {
            from: None,
            to: Some(relative),
            from_effects: AmbientEffects::default(),
            to_effects: AmbientEffects::default(),
            to_transition: EventImageTransition::default(),
            started_at,
            duration: Duration::from_millis(1000),
        };
        let mut cache = ImageCache::new();
        let grid = state
            .snapshot(
                &mut cache,
                &config,
                1,
                1,
                started_at + Duration::from_millis(500),
            )
            .expect("to=Someならグリッドが返る");

        let half = (
            fixture_color.0 / 2,
            fixture_color.1 / 2,
            fixture_color.2 / 2,
        );
        assert_eq!(
            grid.cells[0].bg, half,
            "t=0.5は黒(0,0,0)とfixture色のちょうど中間になる"
        );
        assert_ne!(
            grid.cells[0].bg,
            (0, 0, 0),
            "黒そのままではなく既に補間が進んでいる"
        );
        assert_ne!(
            grid.cells[0].bg, fixture_color,
            "まだ完了していないのでfixtureの色そのものにはなっていない"
        );
    }

    #[test]
    fn snapshot_from_some_path_to_none_fades_toward_black_over_time() {
        // デシジョンテーブル#3（Some(A)→None、退場フェードアウト）の統合確認。
        let fixture_color = (200u8, 40u8, 210u8);
        let (config, relative) = config_and_relative_path_for_solid_fixture(fixture_color);

        let started_at = Instant::now();
        let state = ImageFadeState {
            from: Some(relative),
            to: None,
            from_effects: AmbientEffects::default(),
            to_effects: AmbientEffects::default(),
            to_transition: EventImageTransition::default(),
            started_at,
            duration: Duration::from_millis(1000),
        };
        let mut cache = ImageCache::new();

        let at_start = state
            .snapshot(&mut cache, &config, 1, 1, started_at)
            .expect("from=Someならグリッドが返る");
        assert_eq!(
            at_start.cells[0].bg, fixture_color,
            "開始直後(t=0)はfromの色そのまま"
        );

        let near_end = state
            .snapshot(
                &mut cache,
                &config,
                1,
                1,
                started_at + Duration::from_millis(999),
            )
            .expect("グリッドが返る");
        assert_eq!(
            near_end.cells[0].bg,
            (0, 0, 0),
            "完了間際(t≈1)は黒(BLANK_CELLの色)へほぼ収束する"
        );
    }

    #[test]
    fn transition_to_mid_flight_uses_previous_to_path_not_interrupted_blend_color() {
        // `ImageFadeState::transition_to` のdoc commentに明記された意図的な簡略化を
        // 固定する回帰テスト: 遷移が完了する前(本当に進行中、t=0.5)にさらに別画像へ
        // 切り替わっても、新しいfromは「中断時点のブレンド色」ではなく
        // 「直前の遷移のtoパス」そのものになる。既存の
        // `transition_to_carries_previous_target_as_new_from` は settled 状態
        // （既に完了済み）からの遷移だったため、ここでは「本当に進行中」の状態から
        // 呼ぶことを明示する。
        let now0 = Instant::now();
        let mid_flight = ImageFadeState {
            from: Some("a.webp".to_string()),
            to: Some("b.webp".to_string()),
            from_effects: AmbientEffects::default(),
            to_effects: AmbientEffects::default(),
            to_transition: EventImageTransition::default(),
            started_at: now0,
            duration: Duration::from_millis(1000),
        };
        let mid = now0 + Duration::from_millis(500);
        assert_eq!(mid_flight.progress(mid), 0.5, "前提: まだ遷移の途中である");

        let next = mid_flight.transition_to(
            Some("c.webp".to_string()),
            AmbientEffects::default(),
            EventImageTransition::default(),
            Duration::from_millis(1000),
            mid,
        );
        assert_eq!(
            next.from.as_deref(),
            Some("b.webp"),
            "新しいfromは中断時点のブレンド色ではなく、直前の遷移のtoパス(b)そのもの"
        );
        assert_eq!(next.to.as_deref(), Some("c.webp"));
    }

    #[test]
    fn settled_progress_is_always_one() {
        let state =
            ImageFadeState::settled(Some("props/x.webp".to_string()), AmbientEffects::default());
        let now = Instant::now();
        assert_eq!(state.progress(now), 1.0);
        assert_eq!(
            state.progress(now + Duration::from_secs(9999)),
            1.0,
            "durationがゼロなのでnowに関わらず常に完了扱い"
        );
    }

    #[test]
    fn settled_current_target_matches_input() {
        let state =
            ImageFadeState::settled(Some("props/x.webp".to_string()), AmbientEffects::default());
        assert_eq!(state.current_target(), Some("props/x.webp"));
        let none_state = ImageFadeState::settled(None, AmbientEffects::default());
        assert_eq!(none_state.current_target(), None);
    }

    #[test]
    fn transition_to_carries_previous_target_as_new_from() {
        let settled =
            ImageFadeState::settled(Some("a.webp".to_string()), AmbientEffects::default());
        let now = Instant::now();
        let next = settled.transition_to(
            Some("b.webp".to_string()),
            AmbientEffects::default(),
            EventImageTransition::default(),
            Duration::from_millis(100),
            now,
        );
        assert_eq!(next.from.as_deref(), Some("a.webp"));
        assert_eq!(next.to.as_deref(), Some("b.webp"));
        assert_eq!(next.current_target(), Some("b.webp"));
    }

    #[test]
    fn progress_at_start_is_zero_and_clamped_after_duration() {
        let state = ImageFadeState {
            from: None,
            to: Some("a.webp".to_string()),
            from_effects: AmbientEffects::default(),
            to_effects: AmbientEffects::default(),
            to_transition: EventImageTransition::default(),
            started_at: Instant::now(),
            duration: Duration::from_millis(100),
        };
        assert_eq!(state.progress(state.started_at), 0.0);
        assert_eq!(
            state.progress(state.started_at + Duration::from_millis(50)),
            0.5
        );
        assert_eq!(
            state.progress(state.started_at + Duration::from_millis(200)),
            1.0,
            "durationを超えても1.0でクランプされる"
        );
    }

    #[test]
    fn snapshot_both_none_returns_none() {
        let state = ImageFadeState::settled(None, AmbientEffects::default());
        let mut cache = ImageCache::new();
        let config = Config::default();
        assert!(state
            .snapshot(&mut cache, &config, 4, 4, Instant::now())
            .is_none());
    }

    #[test]
    fn snapshot_unresolvable_path_falls_back_to_blank_grid_without_panicking() {
        let state = ImageFadeState::settled(
            Some("does-not-exist.webp".to_string()),
            AmbientEffects::default(),
        );
        let mut cache = ImageCache::new();
        let config = Config::default();
        let grid = state
            .snapshot(&mut cache, &config, 3, 2, Instant::now())
            .expect("to=Someならグリッドが返る");
        assert_eq!(grid.cols, 3);
        assert_eq!(grid.rows, 2);
        assert!(grid.cells.iter().all(|c| *c == image_render::BLANK_CELL));
    }

    #[test]
    fn blend_at_t_zero_matches_from_exactly() {
        let from = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '▘',
                fg: (255, 0, 0),
                bg: (0, 0, 255),
            }],
        };
        let to = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '█',
                fg: (0, 255, 0),
                bg: (0, 255, 0),
            }],
        };
        let blended = blend(Some(&from), Some(&to), 1, 1, 0.0);
        assert_eq!(blended.cells[0].glyph, '▘');
        assert_eq!(blended.cells[0].fg, (255, 0, 0));
        assert_eq!(blended.cells[0].bg, (0, 0, 255));
    }

    #[test]
    fn blend_at_t_near_one_matches_to_color_and_glyph() {
        let from = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '▘',
                fg: (255, 0, 0),
                bg: (0, 0, 255),
            }],
        };
        let to = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '█',
                fg: (0, 255, 0),
                bg: (0, 255, 0),
            }],
        };
        let blended = blend(Some(&from), Some(&to), 1, 1, 0.999);
        assert_eq!(blended.cells[0].glyph, '█');
        assert_eq!(blended.cells[0].fg, (0, 255, 0));
        assert_eq!(blended.cells[0].bg, (0, 255, 0));
    }

    #[test]
    fn blend_glyph_switches_at_midpoint() {
        let from = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '▘',
                fg: (100, 100, 100),
                bg: (0, 0, 0),
            }],
        };
        let to = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '█',
                fg: (200, 200, 200),
                bg: (200, 200, 200),
            }],
        };
        assert_eq!(
            blend(Some(&from), Some(&to), 1, 1, 0.49).cells[0].glyph,
            '▘'
        );
        assert_eq!(blend(Some(&from), Some(&to), 1, 1, 0.5).cells[0].glyph, '█');
    }

    #[test]
    fn blend_missing_from_uses_blank_cell_as_start_point() {
        let to = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '█',
                fg: (200, 200, 200),
                bg: (200, 200, 200),
            }],
        };
        let blended = blend(None, Some(&to), 1, 1, 0.0);
        assert_eq!(
            blended.cells[0].fg,
            (0, 0, 0),
            "from無しは黒(BLANK_CELL)からスタート"
        );
    }

    #[test]
    fn blend_missing_to_fades_toward_blank_cell() {
        let from = RenderedImage {
            cols: 1,
            rows: 1,
            cells: vec![QuadrantCell {
                glyph: '█',
                fg: (200, 200, 200),
                bg: (200, 200, 200),
            }],
        };
        let blended = blend(Some(&from), None, 1, 1, 0.999);
        assert_eq!(
            blended.cells[0].fg,
            (0, 0, 0),
            "to無しは黒(BLANK_CELL)へフェードアウトする"
        );
    }

    #[test]
    fn resolve_grid_wires_effects_into_apply_ambient_effects() {
        // `resolve_grid` が `effects` を実際に `apply_ambient_effects` へ渡していることを、
        // 同一画像で effects あり/なしの grid 出力が異なることで検証する（配線の断線を検知する
        // 唯一の防波堤。effects を握りつぶして常にデフォルトへ差し替えるリグレッションが起きても、
        // 他のテストは通ってしまう）。glow は elapsed_ms に依存しない純粋な変換なので、
        // タイミングに関わる不確実性なしに決定論的に差を検証できる。
        let fixture_color = (180u8, 120u8, 60u8);
        let (config, relative) = config_and_relative_path_for_solid_fixture(fixture_color);
        let mut cache = ImageCache::new();

        let no_effects = resolve_grid(
            &mut cache,
            &config,
            &relative,
            AmbientEffects::default(),
            0,
            1,
            1,
            1,
        );
        let glow_effects = AmbientEffects {
            glow: true,
            ..AmbientEffects::default()
        };
        let with_effects = resolve_grid(&mut cache, &config, &relative, glow_effects, 0, 1, 1, 1);

        assert_ne!(
            no_effects.cells[0].bg, with_effects.cells[0].bg,
            "effects が実際に apply_ambient_effects へ渡っていれば glow の overlay合成で色が変わるはず"
        );
    }

    #[test]
    fn settled_snapshot_reflects_effects() {
        // `ImageFadeState::settled(path, effects)` で構築した状態の `snapshot()` 結果が
        // 実際に effects を反映していることを確認する。
        let fixture_color = (180u8, 120u8, 60u8);
        let (config, relative) = config_and_relative_path_for_solid_fixture(fixture_color);
        let mut cache = ImageCache::new();

        let plain = ImageFadeState::settled(Some(relative.clone()), AmbientEffects::default());
        let glow = ImageFadeState::settled(
            Some(relative),
            AmbientEffects {
                glow: true,
                ..AmbientEffects::default()
            },
        );
        let now = Instant::now();
        let plain_grid = plain
            .snapshot(&mut cache, &config, 1, 1, now)
            .expect("to=Someならグリッドが返る");
        let glow_grid = glow
            .snapshot(&mut cache, &config, 1, 1, now)
            .expect("to=Someならグリッドが返る");

        assert_ne!(
            plain_grid.cells[0].bg, glow_grid.cells[0].bg,
            "effects=glowのsettled状態はsnapshotにも反映されるはず"
        );
    }

    #[test]
    fn transition_to_applies_independent_effects_to_from_and_to_images() {
        // `transition_to` で新旧effectsが独立管理されることを確認する: フェード開始直後(t≈0)は
        // 旧画像(from)に旧effects(なし)が、フェード完了間際(t≈1)は新画像(to)に新effects(glow)が
        // それぞれ適用されていること。
        let color_a = (180u8, 120u8, 60u8);
        let color_b = (40u8, 200u8, 90u8);
        let (config, relative_a) = config_and_relative_path_for_solid_fixture(color_a);
        // write_test_webp_fixture は std::env::temp_dir() に一意なファイル名で書き出すため、
        // config(= relative_a の親ディレクトリ)をそのまま使い回して2本目も解決できる。
        let fixture_path_b =
            image_render::write_test_webp_fixture(&solid_rgba(color_b, 2, 2), 2, 2);
        let relative_b = fixture_path_b
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let settled = ImageFadeState::settled(Some(relative_a), AmbientEffects::default());
        let now0 = Instant::now();
        let glow_effects = AmbientEffects {
            glow: true,
            ..AmbientEffects::default()
        };
        let transitioning = settled.transition_to(
            Some(relative_b),
            glow_effects,
            EventImageTransition::default(),
            Duration::from_millis(1000),
            now0,
        );

        let mut cache = ImageCache::new();

        let at_start = transitioning
            .snapshot(&mut cache, &config, 1, 1, now0)
            .expect("グリッドが返る");
        assert_eq!(
            at_start.cells[0].bg, color_a,
            "t=0はfrom(A)そのまま。fromには旧effects(なし)が適用されているはず"
        );

        let near_end = transitioning
            .snapshot(&mut cache, &config, 1, 1, now0 + Duration::from_millis(999))
            .expect("グリッドが返る");
        assert_ne!(
            near_end.cells[0].bg, color_b,
            "t≈1はto(B)にglowが適用されているはずなので、無加工のcolor_bとは異なる"
        );
    }
}
