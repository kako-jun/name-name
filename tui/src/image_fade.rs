//! イベント絵の切り替え（`DisplayLine::event_image` の変化、`None`⇄`Some` を含む）を
//! `jiwa::lerp_rgb` でセルごとにクロスフェードする（#481）。`reveal.rs`（タイプライター演出）
//! と同じ `Instant` ベースのタイマー構造を踏襲しつつ、色の補間先はテキストの単一色ではなく
//! `image_render::RenderedImage` のセル格子（`cols * rows` 個の fg/bg ペア）になる。

use std::time::{Duration, Instant};

use jiwa::{lerp_rgb, Rgb};

use crate::config::Config;
use crate::image_render::{self, ImageCache, QuadrantCell, RenderedImage};

/// 現在のイベント絵切り替え状態。`from`/`to` はいずれも Markdown 原稿中の相対パス
/// （`config.event_image.assets_dir` からの相対、`DisplayLine::event_image` と同じ形）。
/// `None` は「イベント絵なし」を表す。
pub struct ImageFadeState {
    from: Option<String>,
    to: Option<String>,
    started_at: Instant,
    duration: Duration,
}

impl ImageFadeState {
    /// トランジション無しの初期状態（`path` が既に定常表示され続けている体で開始する。
    /// `duration` を問わず [`Self::progress`] は常に `1.0` を返す）。
    pub fn settled(path: Option<String>) -> Self {
        Self {
            from: path.clone(),
            to: path,
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
    pub fn transition_to(&self, next: Option<String>, duration: Duration, now: Instant) -> Self {
        Self {
            from: self.to.clone(),
            to: next,
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
        let t = self.progress(now);
        if t >= 1.0 {
            return Some(match &self.to {
                Some(path) => resolve_grid(cache, config, path, cols, rows),
                None => image_render::blank_grid(cols, rows),
            });
        }
        let from_grid = self
            .from
            .as_deref()
            .map(|path| resolve_grid(cache, config, path, cols, rows));
        let to_grid = self
            .to
            .as_deref()
            .map(|path| resolve_grid(cache, config, path, cols, rows));
        Some(blend(from_grid.as_ref(), to_grid.as_ref(), cols, rows, t))
    }
}

/// 相対パスをデコード済み画像から quadrant block グリッドへ解決する。デコードに失敗した
/// 場合（ファイル不在・壊れたファイル等）は [`image_render::blank_grid`] にフォールバックし、
/// 1枚の画像の問題で再生全体をクラッシュさせない。
fn resolve_grid(
    cache: &mut ImageCache,
    config: &Config,
    relative_path: &str,
    cols: u16,
    rows: u16,
) -> RenderedImage {
    let full_path = config.resolve_image_path(relative_path);
    match cache.get_or_load(&full_path) {
        Some(decoded) => image_render::rgba_to_quadrant_grid(
            &decoded.rgba,
            decoded.width,
            decoded.height,
            cols,
            rows,
        ),
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
            started_at: now0,
            duration: Duration::from_millis(1000),
        };
        let mid = now0 + Duration::from_millis(500);
        assert_eq!(mid_flight.progress(mid), 0.5, "前提: まだ遷移の途中である");

        let next =
            mid_flight.transition_to(Some("c.webp".to_string()), Duration::from_millis(1000), mid);
        assert_eq!(
            next.from.as_deref(),
            Some("b.webp"),
            "新しいfromは中断時点のブレンド色ではなく、直前の遷移のtoパス(b)そのもの"
        );
        assert_eq!(next.to.as_deref(), Some("c.webp"));
    }

    #[test]
    fn settled_progress_is_always_one() {
        let state = ImageFadeState::settled(Some("props/x.webp".to_string()));
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
        let state = ImageFadeState::settled(Some("props/x.webp".to_string()));
        assert_eq!(state.current_target(), Some("props/x.webp"));
        let none_state = ImageFadeState::settled(None);
        assert_eq!(none_state.current_target(), None);
    }

    #[test]
    fn transition_to_carries_previous_target_as_new_from() {
        let settled = ImageFadeState::settled(Some("a.webp".to_string()));
        let now = Instant::now();
        let next =
            settled.transition_to(Some("b.webp".to_string()), Duration::from_millis(100), now);
        assert_eq!(next.from.as_deref(), Some("a.webp"));
        assert_eq!(next.to.as_deref(), Some("b.webp"));
        assert_eq!(next.current_target(), Some("b.webp"));
    }

    #[test]
    fn progress_at_start_is_zero_and_clamped_after_duration() {
        let state = ImageFadeState {
            from: None,
            to: Some("a.webp".to_string()),
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
        let state = ImageFadeState::settled(None);
        let mut cache = ImageCache::new();
        let config = Config::default();
        assert!(state
            .snapshot(&mut cache, &config, 4, 4, Instant::now())
            .is_none());
    }

    #[test]
    fn snapshot_unresolvable_path_falls_back_to_blank_grid_without_panicking() {
        let state = ImageFadeState::settled(Some("does-not-exist.webp".to_string()));
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
}
