//! イベント絵（`DisplayLine::event_image`）のデコードと、TUI セル用 quadrant block 文字への
//! 変換を担う（#481）。`docs/visual/reference/20260722-nearsighted-pixel-redraw/tui-plan.md`
//! （gymnasia リポジトリ）の設計に従い、2x2 サブピクセルを前景/背景の最大2色へ近似する。
//!
//! - デコード（本ファイル冒頭）: ディスクIOを伴う唯一の箇所。失敗しても `panic` せず
//!   `None`/`Err` を返し、呼び出し側（`image_fade`）がプレースホルダへフォールバックできる
//!   ようにする。
//! - quadrant block 変換（後半）: 純粋関数。実ファイルを介さず合成した RGBA バイト列だけで
//!   テストできる。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

/// デコード済みの画像（RGBA、行優先、`rgba.len() == width * height * 4`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// `path` の画像ファイルを読み込み RGBA へデコードする（WebP を含む、`image` crate 経由）。
/// フォーマットはファイル拡張子から自動判別する。
pub fn load_image_rgba(path: &Path) -> anyhow::Result<DecodedImage> {
    let img = image::open(path)
        .map_err(|e| anyhow::anyhow!("画像の読み込みに失敗しました: {} ({e})", path.display()))?;
    let buffer = img.to_rgba8();
    let (width, height) = buffer.dimensions();
    Ok(DecodedImage {
        width,
        height,
        rgba: buffer.into_raw(),
    })
}

/// パスをキーにデコード済み画像をキャッシュする。クロスフェード中は from/to 2枚を毎フレーム
/// 参照するため、キャッシュが無いと同じファイルを毎フレーム（既定 30ms 間隔）デコードし
/// 直す無駄が生じる。`Rc` で共有するのでクローンは軽量。
#[derive(Debug, Default)]
pub struct ImageCache {
    entries: HashMap<PathBuf, Rc<DecodedImage>>,
}

impl ImageCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// `path` のデコード済み画像を取得する（キャッシュ済みならそれを返し、無ければ
    /// デコードしてキャッシュへ格納する）。デコードに失敗した場合は `None` を返す
    /// （1枚の画像パスの問題で再生全体をクラッシュさせないため。呼び出し側は
    /// プレースホルダ/直前の画像へのフォールバックができる）。
    pub fn get_or_load(&mut self, path: &Path) -> Option<Rc<DecodedImage>> {
        if let Some(existing) = self.entries.get(path) {
            return Some(existing.clone());
        }
        let decoded = load_image_rgba(path).ok()?;
        let rc = Rc::new(decoded);
        self.entries.insert(path.to_path_buf(), rc.clone());
        Some(rc)
    }
}

// ---- quadrant block 変換（純粋関数） ----
//
// tui-plan.md の設計: 2x2 サブピクセルのセルを、最大2色（背景 + 前景）で近似する。
// 4サブピクセルのうち最も色距離が離れた2点を「参照色」とし、残り2点をどちらか近い方へ
// 分類する（2クラスタの貪欲な割当）。分類結果（4bit マスク、UL/UR/LL/LR の順）を
// Unicode Block Elements の該当文字（quadrant / half-block / full-block）へ写像する。

/// 1セル分の描画情報。`glyph` が塗る形（前景色 `fg`）とその他（背景色 `bg`）を表す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuadrantCell {
    pub glyph: char,
    pub fg: (u8, u8, u8),
    pub bg: (u8, u8, u8),
}

/// 完全に何も描かれていない（黒一色の）セル。デコード失敗時のフォールバックや
/// クロスフェードで片側の画像が存在しない場合の既定値として使う。
pub const BLANK_CELL: QuadrantCell = QuadrantCell {
    glyph: ' ',
    fg: (0, 0, 0),
    bg: (0, 0, 0),
};

/// `cols` x `rows` セル分の quadrant block グリッド（行優先、`cells.len() == cols * rows`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedImage {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<QuadrantCell>,
}

/// 全セルが [`BLANK_CELL`] の空グリッドを作る。
pub fn blank_grid(cols: u16, rows: u16) -> RenderedImage {
    RenderedImage {
        cols,
        rows,
        cells: vec![BLANK_CELL; cols as usize * rows as usize],
    }
}

/// RGBA（straight alpha）を黒背景に合成し不透明な RGB を得る。
/// tui-plan.md が「候補場面はブラック地/ろうそく暗色UIで確認する」としている前提に合わせ、
/// 透明部分は黒として扱う（terminal の既定背景色に頼らず、常に確定的な色を返すため）。
pub fn composite_over_black(r: u8, g: u8, b: u8, a: u8) -> (u8, u8, u8) {
    let a = u32::from(a);
    (
        ((u32::from(r) * a) / 255) as u8,
        ((u32::from(g) * a) / 255) as u8,
        ((u32::from(b) * a) / 255) as u8,
    )
}

/// 2色間の距離（2乗ユークリッド距離、符号なし整数のまま計算しオーバーフローを避ける）。
fn color_distance_sq(a: (u8, u8, u8), b: (u8, u8, u8)) -> u32 {
    let dr = i32::from(a.0) - i32::from(b.0);
    let dg = i32::from(a.1) - i32::from(b.1);
    let db = i32::from(a.2) - i32::from(b.2);
    (dr * dr + dg * dg + db * db) as u32
}

/// 4色の中で最も色距離が離れたペアの添字を返す（タイは先勝ち、ペア列挙順は固定）。
fn farthest_pair(colors: [(u8, u8, u8); 4]) -> (usize, usize) {
    const PAIRS: [(usize, usize); 6] = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
    let mut best_pair = PAIRS[0];
    let mut best_dist = 0u32;
    for &(i, j) in &PAIRS {
        let d = color_distance_sq(colors[i], colors[j]);
        if d > best_dist {
            best_dist = d;
            best_pair = (i, j);
        }
    }
    best_pair
}

/// mask のビット順 (UL=8, UR=4, LL=2, LR=1) に対応する Unicode Block Elements 文字。
/// 0 = 何も塗らない(空白)、15 = 全面塗り(█)、その他は quadrant / half-block の組み合わせ。
const QUADRANT_GLYPHS: [char; 16] = [
    ' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟', '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█',
];

/// 2x2 サブピクセル（UL, UR, LL, LR の順、黒合成済み RGB）を1セル分の [`QuadrantCell`] へ
/// 変換する。4色のうち最も色距離が離れた2点を参照色A/Bとし（[`farthest_pair`]、複数ペアが
/// 同着なら `PAIRS` 列挙順で先に出た方が勝つ）、残り2点をどちらか近い方へ分類する。
/// 参照色Aへ分類された点（参照色A自身を含む。距離0は必ずA側に倒すタイブレークのため）の
/// 平均色を背景、参照色Bへ分類された点の平均色を前景とし、前景側に分類された点の位置が
/// そのまま glyph の形になる（tui-plan.md: 2色近似・形は分類結果そのもの）。
/// 「A/Bどちらが前景になるか」は多数派/少数派で決めているのではなく `farthest_pair` が
/// 返すペアの順序（＝ `PAIRS` の列挙順）で決まる点に注意 — 外れ値が必ず前景になるとは
/// 限らない（3点が完全に同色の場合はその1点との組で外れ値がAに来ることもある。テスト
/// `quadrant_cell_single_outlier_produces_isolated_quadrant_glyph` 参照）。
pub fn quadrant_cell_from_subpixels(subpixels: [(u8, u8, u8); 4]) -> QuadrantCell {
    let (ref_a, ref_b) = farthest_pair(subpixels);
    let ref_a_color = subpixels[ref_a];
    let ref_b_color = subpixels[ref_b];

    let mut mask: u8 = 0;
    let mut bg_sum = (0u32, 0u32, 0u32, 0u32); // r,g,b,count
    let mut fg_sum = (0u32, 0u32, 0u32, 0u32);
    for (i, &color) in subpixels.iter().enumerate() {
        let dist_a = color_distance_sq(color, ref_a_color);
        let dist_b = color_distance_sq(color, ref_b_color);
        if dist_a <= dist_b {
            bg_sum.0 += u32::from(color.0);
            bg_sum.1 += u32::from(color.1);
            bg_sum.2 += u32::from(color.2);
            bg_sum.3 += 1;
        } else {
            // UL=bit3, UR=bit2, LL=bit1, LR=bit0
            mask |= 1 << (3 - i);
            fg_sum.0 += u32::from(color.0);
            fg_sum.1 += u32::from(color.1);
            fg_sum.2 += u32::from(color.2);
            fg_sum.3 += 1;
        }
    }

    let bg = average(bg_sum);
    // 前景クラスタが空になるのは mask==0（全ピクセルが背景色に等距離以下で分類された）
    // ときだけ（詳細はモジュールテスト参照）。その場合は glyph が空白になり fg は
    // 画面に出ないが、クロスフェード時の補間対象として bg と同じ値を入れておく。
    let fg = if fg_sum.3 == 0 { bg } else { average(fg_sum) };

    QuadrantCell {
        glyph: QUADRANT_GLYPHS[mask as usize],
        fg,
        bg,
    }
}

fn average(sum: (u32, u32, u32, u32)) -> (u8, u8, u8) {
    let n = sum.3.max(1);
    ((sum.0 / n) as u8, (sum.1 / n) as u8, (sum.2 / n) as u8)
}

/// 元画像（`pixels`: RGBA straight alpha、`img_w` x `img_h`）を、ボックス平均で
/// `target_w` x `target_h` のサブピクセルグリッドへダウンサンプルする。
/// `pixels.len() < img_w * img_h * 4` 等の不正な入力では空の `Vec` を返す（panicしない）。
fn downsample_box(
    pixels: &[u8],
    img_w: u32,
    img_h: u32,
    target_w: u32,
    target_h: u32,
) -> Vec<(u8, u8, u8, u8)> {
    if img_w == 0 || img_h == 0 || target_w == 0 || target_h == 0 {
        return Vec::new();
    }
    if pixels.len() < (img_w as usize) * (img_h as usize) * 4 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity((target_w * target_h) as usize);
    for ty in 0..target_h {
        let y0 = ty * img_h / target_h;
        let y1 = (((ty + 1) * img_h) / target_h).clamp(y0 + 1, img_h);
        for tx in 0..target_w {
            let x0 = tx * img_w / target_w;
            let x1 = (((tx + 1) * img_w) / target_w).clamp(x0 + 1, img_w);
            let mut sum = (0u32, 0u32, 0u32, 0u32, 0u32); // r,g,b,a,count
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = ((y * img_w + x) * 4) as usize;
                    sum.0 += u32::from(pixels[i]);
                    sum.1 += u32::from(pixels[i + 1]);
                    sum.2 += u32::from(pixels[i + 2]);
                    sum.3 += u32::from(pixels[i + 3]);
                    sum.4 += 1;
                }
            }
            let n = sum.4.max(1);
            out.push((
                (sum.0 / n) as u8,
                (sum.1 / n) as u8,
                (sum.2 / n) as u8,
                (sum.3 / n) as u8,
            ));
        }
    }
    out
}

/// 元画像（RGBA、`img_w` x `img_h`）を `cols` x `rows` 文字セルの quadrant block グリッドへ
/// 変換する（`docs/visual/reference/20260722-nearsighted-pixel-redraw/tui-plan.md` の設計に
/// 従う）。セル数が 0、画像サイズが 0、または `pixels` が画像サイズに対して短すぎる場合は
/// [`blank_grid`] を返す（panicしない）。
pub fn rgba_to_quadrant_grid(
    pixels: &[u8],
    img_w: u32,
    img_h: u32,
    cols: u16,
    rows: u16,
) -> RenderedImage {
    if cols == 0 || rows == 0 || img_w == 0 || img_h == 0 {
        return blank_grid(cols, rows);
    }
    let sub_w = u32::from(cols) * 2;
    let sub_h = u32::from(rows) * 2;
    let sub = downsample_box(pixels, img_w, img_h, sub_w, sub_h);
    if sub.is_empty() {
        return blank_grid(cols, rows);
    }

    let mut cells = Vec::with_capacity(cols as usize * rows as usize);
    for cy in 0..rows {
        for cx in 0..cols {
            let sub_x = u32::from(cx) * 2;
            let sub_y = u32::from(cy) * 2;
            let get = |x: u32, y: u32| -> (u8, u8, u8, u8) { sub[(y * sub_w + x) as usize] };
            let ul = get(sub_x, sub_y);
            let ur = get(sub_x + 1, sub_y);
            let ll = get(sub_x, sub_y + 1);
            let lr = get(sub_x + 1, sub_y + 1);
            cells.push(quadrant_cell_from_subpixels([
                composite_over_black(ul.0, ul.1, ul.2, ul.3),
                composite_over_black(ur.0, ur.1, ur.2, ur.3),
                composite_over_black(ll.0, ll.1, ll.2, ll.3),
                composite_over_black(lr.0, lr.1, lr.2, lr.3),
            ]));
        }
    }
    RenderedImage { cols, rows, cells }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_image_rgba_missing_path_is_err() {
        let result = load_image_rgba(Path::new("tui/tests/fixtures/does-not-exist.webp"));
        assert!(result.is_err());
    }

    #[test]
    fn image_cache_missing_path_returns_none_without_panicking() {
        let mut cache = ImageCache::new();
        let result = cache.get_or_load(Path::new("tui/tests/fixtures/does-not-exist.webp"));
        assert!(result.is_none());
    }

    #[test]
    fn image_cache_repeated_miss_does_not_insert_entries() {
        // デコードに失敗したパスをキャッシュに残さないことを確認する
        // （`entries` が無限に汚れていかないことの回帰ガード）。
        let mut cache = ImageCache::new();
        let path = Path::new("tui/tests/fixtures/does-not-exist.webp");
        cache.get_or_load(path);
        cache.get_or_load(path);
        assert!(cache.entries.is_empty());
    }

    // ---- quadrant block 変換（純粋関数）----

    #[test]
    fn composite_over_black_full_alpha_keeps_color() {
        assert_eq!(composite_over_black(200, 100, 50, 255), (200, 100, 50));
    }

    #[test]
    fn composite_over_black_zero_alpha_is_black() {
        assert_eq!(composite_over_black(200, 100, 50, 0), (0, 0, 0));
    }

    #[test]
    fn composite_over_black_half_alpha_darkens_toward_black() {
        let (r, g, b) = composite_over_black(255, 255, 255, 128);
        // 255 * 128 / 255 = 128
        assert_eq!((r, g, b), (128, 128, 128));
    }

    #[test]
    fn quadrant_cell_all_identical_colors_is_blank_glyph() {
        let cell = quadrant_cell_from_subpixels([(10, 20, 30); 4]);
        assert_eq!(cell.glyph, ' ');
        assert_eq!(cell.bg, (10, 20, 30));
        assert_eq!(cell.fg, (10, 20, 30));
    }

    #[test]
    fn quadrant_cell_full_block_when_all_subpixels_are_maximally_different() {
        // 実際には「farthest pair」の一方に必ず全ピクセルが引き寄せられるため、
        // 4色すべてが異なっていても mask が 1111（全面塗り）になるとは限らない。
        // ここでは「片方の対角ペアが黒、もう片方の対角ペアが白」という、必ず2色2色へ
        // 綺麗に分かれるケースで対角線パターン（▚ or ▞）になることを確認する。
        let cell =
            quadrant_cell_from_subpixels([(0, 0, 0), (255, 255, 255), (255, 255, 255), (0, 0, 0)]);
        assert_eq!(cell.glyph, '▞'); // UR+LL（白2点）
        assert_eq!(cell.fg, (255, 255, 255));
        assert_eq!(cell.bg, (0, 0, 0));
    }

    #[test]
    fn quadrant_cell_single_outlier_produces_isolated_quadrant_glyph() {
        // UL/UR/LL が同一の青、LR だけ赤の外れ値。「最も離れた2点」は (UL, LR) に決まり
        // （他の3ペアはすべて距離0）、LR側が前景として選ばれ、glyph は「LR のみ塗り」の
        // ▗ になる（fg=外れ値の赤、bg=残り3点の平均=青）。
        let cell =
            quadrant_cell_from_subpixels([(0, 0, 200), (0, 0, 200), (0, 0, 200), (255, 0, 0)]);
        assert_eq!(cell.glyph, '▗');
        assert_eq!(cell.fg, (255, 0, 0));
        assert_eq!(cell.bg, (0, 0, 200));
    }

    #[test]
    fn downsample_box_uniform_image_averages_to_same_color() {
        // 4x4 の単色画像を 2x2 にダウンサンプルすると、全セルが同じ色になる。
        let mut pixels = Vec::new();
        for _ in 0..(4 * 4) {
            pixels.extend_from_slice(&[10, 20, 30, 255]);
        }
        let sub = downsample_box(&pixels, 4, 4, 2, 2);
        assert_eq!(sub.len(), 4);
        for px in sub {
            assert_eq!(px, (10, 20, 30, 255));
        }
    }

    #[test]
    fn downsample_box_zero_target_size_is_empty_without_panicking() {
        let pixels = vec![0u8; 4 * 4 * 4];
        assert!(downsample_box(&pixels, 4, 4, 0, 2).is_empty());
        assert!(downsample_box(&pixels, 4, 4, 2, 0).is_empty());
    }

    #[test]
    fn downsample_box_pixels_shorter_than_declared_size_is_empty_without_panicking() {
        let pixels = vec![0u8; 4]; // 1画素分しかないのに 4x4 を主張する不正な入力
        assert!(downsample_box(&pixels, 4, 4, 2, 2).is_empty());
    }

    #[test]
    fn rgba_to_quadrant_grid_zero_cols_or_rows_returns_blank_grid_without_panicking() {
        let pixels = vec![255u8; 2 * 2 * 4];
        let grid = rgba_to_quadrant_grid(&pixels, 2, 2, 0, 5);
        assert_eq!(grid.cells.len(), 0);
        let grid = rgba_to_quadrant_grid(&pixels, 2, 2, 5, 0);
        assert_eq!(grid.cells.len(), 0);
    }

    #[test]
    fn rgba_to_quadrant_grid_zero_size_image_returns_blank_grid_without_panicking() {
        let grid = rgba_to_quadrant_grid(&[], 0, 0, 3, 3);
        assert_eq!(grid.cells.len(), 9);
        assert!(grid.cells.iter().all(|c| *c == BLANK_CELL));
    }

    #[test]
    fn rgba_to_quadrant_grid_single_cell_uniform_white_image() {
        // 4x4(=1セル分の2x2サブピクセル領域x2x2)の白一色画像を 1x1 セルへ変換する。
        let mut pixels = Vec::new();
        for _ in 0..(4 * 4) {
            pixels.extend_from_slice(&[255, 255, 255, 255]);
        }
        let grid = rgba_to_quadrant_grid(&pixels, 4, 4, 1, 1);
        assert_eq!(grid.cols, 1);
        assert_eq!(grid.rows, 1);
        assert_eq!(grid.cells.len(), 1);
        assert_eq!(grid.cells[0].glyph, ' ');
        assert_eq!(grid.cells[0].bg, (255, 255, 255));
    }

    #[test]
    fn blank_grid_has_expected_cell_count_and_blank_cells() {
        let grid = blank_grid(3, 2);
        assert_eq!(grid.cells.len(), 6);
        assert!(grid.cells.iter().all(|c| *c == BLANK_CELL));
    }
}
