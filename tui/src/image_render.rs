//! イベント絵（`DisplayLine::event_image`）のデコードと、TUI セル用 quadrant block 文字への
//! 変換を担う（#481）。`docs/visual/reference/20260722-nearsighted-pixel-redraw/tui-plan.md`
//! （gymnasia リポジトリ）の設計に従い、2x2 サブピクセルを前景/背景の最大2色へ近似する。
//!
//! - デコード（本ファイル冒頭）: ディスクIOを伴う唯一の箇所。失敗しても `panic` せず
//!   `None`/`Err` を返し、呼び出し側（`image_fade`）がプレースホルダへフォールバックできる
//!   ようにする。
//! - quadrant block 変換（後半）: 純粋関数。実ファイルを介さず合成した RGBA バイト列だけで
//!   テストできる。

use std::collections::{HashMap, VecDeque};
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

/// テスト専用: バイト列を一意な一時ファイルへ書き出す（フィクスチャ生成の共通部分）。
/// `ext` はファイル拡張子（ドット無し、例: `"webp"`）。テスト実行のたびに衝突しないよう
/// プロセスID・ナノ秒時刻・単調カウンタを組み合わせて名前を一意化する。
#[cfg(test)]
pub(crate) fn write_test_bytes_fixture(bytes: &[u8], ext: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "name-name-tui-test-fixture-{}-{}-{unique}.{ext}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    ));
    std::fs::write(&path, bytes).expect("should write test fixture to temp dir");
    path
}

/// テスト専用: RGBA バイト列を WebP としてエンコードし、一意な一時ファイルパスへ書き出す
/// （実デコード経路 [`load_image_rgba`] を外部ツール無しで検証するためのフィクスチャ生成
/// ヘルパー。`image` crate 自身の `WebPEncoder`（`webp` feature）で作るため、`unfake.py` 等の
/// 外部ツールへ依存しない）。`rgba.len()` は `width * height * 4` と一致していなければ
/// ならない（呼び出し側の誤用は `WebPEncoder::encode` の assert で早期に panic する）。
#[cfg(test)]
pub(crate) fn write_test_webp_fixture(rgba: &[u8], width: u32, height: u32) -> PathBuf {
    let mut encoded = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
        .encode(rgba, width, height, image::ExtendedColorType::Rgba8)
        .expect("test fixture RGBA should encode to WebP without error");
    write_test_bytes_fixture(&encoded, "webp")
}

/// [`ImageCache`] が同時に保持するエントリ数の上限。クロスフェード中に実際に同時参照
/// されるのは `ImageFadeState` の `from`/`to` 2枚程度だが、原稿の展開（別イベント絵への
/// ジャンプ・章の遷移等）で参照パスが変わっても直近分は再デコードせず済むよう、多めに
/// 余裕を持たせた小さな値にしている。gymnasia のような多数のイベント絵を持つゲームで
/// 長時間プレイしても、デコード済み RGBA がプレイセッション全体で際限なく蓄積しないための
/// 上限（#481 セルフレビュー指摘）。
const MAX_CACHE_ENTRIES: usize = 32;

/// パスをキーにデコード済み画像をキャッシュする。クロスフェード中は from/to 2枚を毎フレーム
/// 参照するため、キャッシュが無いと同じファイルを毎フレーム（既定 30ms 間隔）デコードし
/// 直す無駄が生じる。`Rc` で共有するのでクローンは軽量。
///
/// エントリ数が [`MAX_CACHE_ENTRIES`] を超えたら、最も古く挿入されたエントリから追い出す
/// （挿入順ベースの単純な FIFO。アクセス順を追跡する本格的な LRU までは不要という判断）。
/// `insertion_order` は `entries` に挿入した順にパスを積むキューで、先頭が最も古い。
#[derive(Debug, Default)]
pub struct ImageCache {
    entries: HashMap<PathBuf, Rc<DecodedImage>>,
    insertion_order: VecDeque<PathBuf>,
}

impl ImageCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// `path` のデコード済み画像を取得する（キャッシュ済みならそれを返し、無ければ
    /// デコードしてキャッシュへ格納する）。デコードに失敗した場合は `None` を返す
    /// （1枚の画像パスの問題で再生全体をクラッシュさせないため。呼び出し側は
    /// プレースホルダ/直前の画像へのフォールバックができる）。挿入後に
    /// [`MAX_CACHE_ENTRIES`] を超えた場合は最も古いエントリを追い出す。
    pub fn get_or_load(&mut self, path: &Path) -> Option<Rc<DecodedImage>> {
        if let Some(existing) = self.entries.get(path) {
            return Some(existing.clone());
        }
        let decoded = load_image_rgba(path).ok()?;
        let rc = Rc::new(decoded);
        self.entries.insert(path.to_path_buf(), rc.clone());
        self.insertion_order.push_back(path.to_path_buf());
        while self.entries.len() > MAX_CACHE_ENTRIES {
            if let Some(oldest) = self.insertion_order.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
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

/// ターミナルの1文字セルの実世界アスペクト比（幅 / 高さ）。文字セルは一般に正方形ではなく
/// 縦長（幅の約2倍の高さ）と言われるが、実際の値はターミナルエミュレータ・フォント・
/// フォントサイズに強く依存する近似値であり、実測に基づく確定値ではない（#489）。
///
/// quadrant block の2x2サブピクセルトリック（[`rgba_to_quadrant_grid`]）は1セルを単純に
/// 縦横2等分するだけなので、サブピクセル自体の実世界アスペクト比もセルのアスペクト比を
/// そのまま引き継ぐ。cover-fit のクロップ計算（[`compute_cover_crop`]）で使う「ターゲットの
/// アスペクト比」は、文字セル数ベースの `sub_w:sub_h` をそのまま使うと実際の見た目とズレる
/// ため、この定数で補正した実効値を使う。kako-jun 実機確認の結果、環境依存で見た目が
/// 合わない場合は調整の余地がある（#488 の `IMAGE_TEXT_GAP_WIDTH` と同種の割り切り）。
///
/// `pub(crate)`: `ui.rs` のテストフィクスチャ（cover-fit クロップが発生しないアスペクト比の
/// 画像を組み立てる）がこの値を直書きせず参照するために公開している。
pub(crate) const TERMINAL_CELL_ASPECT_RATIO: f64 = 0.5;

/// 文字セル数ベースの `sub_h` を [`TERMINAL_CELL_ASPECT_RATIO`] で補正し、
/// [`compute_cover_crop`] に渡す実効ターゲット高さ（`effective_target_h`）を導出する。
/// `rgba_to_quadrant_grid` の本番計算とテストが同じ式を別々に再実装して重複しないよう、
/// 両者から呼び出す共通の純粋関数として切り出している。
fn effective_target_height(sub_h: u32) -> u32 {
    (f64::from(sub_h) / TERMINAL_CELL_ASPECT_RATIO)
        .round()
        .max(1.0) as u32
}

/// アスペクト比を保ったまま `target_w` x `target_h` の領域を覆う（cover-fit）ために、元画像
/// （`img_w` x `img_h`）側から中央基準で切り出すべき矩形を計算する。
///
/// GUI 側（`frontend/src/game/novelLayout.ts` の `computeCoverFit`）は「スケールしてから
/// 画面外へはみ出た分をクリップ」する設計だが、TUI は `downsample_box` が元画像を直接
/// ターゲットグリッドへ比例マッピングする実装のため、見た目としては等価な逆方向の変換
/// （「元画像側を先にクロップしてから、そのクロップ済み矩形をターゲットへ比例マッピング」）
/// を取る。
///
/// 戻り値は `(crop_x, crop_y, crop_w, crop_h)`（すべて元画像の座標系）で、常に
/// `crop_x + crop_w <= img_w` かつ `crop_y + crop_h <= img_h` を満たす。
/// `img_w`/`img_h`/`target_w`/`target_h` のいずれかが 0 の場合はクロップ無し
/// （`(0, 0, img_w, img_h)`）を返す（panicしない）。
fn compute_cover_crop(
    img_w: u32,
    img_h: u32,
    target_w: u32,
    target_h: u32,
) -> (u32, u32, u32, u32) {
    if img_w == 0 || img_h == 0 || target_w == 0 || target_h == 0 {
        return (0, 0, img_w, img_h);
    }
    let img_ratio = f64::from(img_w) / f64::from(img_h);
    let target_ratio = f64::from(target_w) / f64::from(target_h);

    if img_ratio > target_ratio {
        // 元画像の方が相対的に横長: 高さはフルのまま、幅を中央基準でクロップする。
        let crop_w = ((f64::from(img_h) * target_ratio).round() as u32).clamp(1, img_w);
        let crop_x = (img_w - crop_w) / 2;
        (crop_x, 0, crop_w, img_h)
    } else {
        // 元画像の方が相対的に縦長（または target と同じ）: 幅はフルのまま、高さを
        // 中央基準でクロップする。
        let crop_h = ((f64::from(img_w) / target_ratio).round() as u32).clamp(1, img_h);
        let crop_y = (img_h - crop_h) / 2;
        (0, crop_y, img_w, crop_h)
    }
}

/// アスペクト比を保ったまま `max_cols` x `max_rows`（文字セル数）の枠へ収まる最大サイズを
/// 計算する（contain-fit、#530）。[`compute_cover_crop`] の cover-fit（枠を覆うようクロップ
/// する）とは逆に、画像全体がクロップ無しで見えるよう縮小する。文字セルは正方形ではない
/// （[`TERMINAL_CELL_ASPECT_RATIO`]）ため、視覚上のアスペクト比を保つよう補正して計算する
/// （具体的な補正式は [`rgba_to_quadrant_grid`] が cover-fit 側で使っているのと同じ
/// `TERMINAL_CELL_ASPECT_RATIO` 換算）。
///
/// アルゴリズムは通常の `object-fit: contain` と同じ2段階判定: まず `max_cols` いっぱいに
/// 幅を使ったときの高さを求め、それが `max_rows` に収まればそれを採用（幅優先）。収まらない
/// 場合は逆に `max_rows` いっぱいに高さを使ったときの幅を採用する（高さ優先）。
///
/// フルキャンバス画像表示（`ui::draw_fullscreen_image`、#530）は高さ上限を持たない全幅表示
/// へ専用計算を使うため、この関数は汎用2軸 contain-fit のテスト用ヘルパーとして残す。
///
/// `image_w`/`image_h`/`max_cols`/`max_rows` のいずれかが0の場合は `(0, 0)` を返す
/// （panicしない）。戻り値は常に `1 <= fitted_cols <= max_cols` かつ
/// `1 <= fitted_rows <= max_rows` を満たす（`max_cols`/`max_rows` がいずれも0でない限り）。
#[cfg(test)]
pub fn compute_contain_fit(image_w: u32, image_h: u32, max_cols: u16, max_rows: u16) -> (u16, u16) {
    if image_w == 0 || image_h == 0 || max_cols == 0 || max_rows == 0 {
        return (0, 0);
    }
    let ar = TERMINAL_CELL_ASPECT_RATIO;
    // 「視覚上の」幅/高さ単位（セル比の非正方形を吸収した座標系）。セル幅は ar 単位、
    // セル高さは1単位とみなすと、cols x rows セルの視覚サイズは (cols*ar, rows) になる。
    let box_visual_w = f64::from(max_cols) * ar;
    let box_visual_h = f64::from(max_rows);
    let img_ratio = f64::from(image_w) / f64::from(image_h);

    let width_constrained_h = box_visual_w / img_ratio;
    let (visual_w, visual_h) = if width_constrained_h <= box_visual_h {
        // 幅優先: 枠の幅をフルに使っても高さが収まる。
        (box_visual_w, width_constrained_h)
    } else {
        // 高さ優先: 幅優先だと高さがはみ出すため、枠の高さをフルに使う側へ切り替える。
        (box_visual_h * img_ratio, box_visual_h)
    };

    let fitted_cols = ((visual_w / ar).round() as i64).clamp(1, i64::from(max_cols)) as u16;
    let fitted_rows = (visual_h.round() as i64).clamp(1, i64::from(max_rows)) as u16;
    (fitted_cols, fitted_rows)
}

/// フルキャンバス画像表示（`ui::draw_fullscreen_image`、#530）専用: 画像全体をクロップ無しで
/// **全幅**（`target_cols` セル）へ合わせたとき、必要になる総行数を返す。
///
/// `compute_contain_fit(..., max_rows=十分大きい値)` と違い「高さ上限」を仮置きしないため、
/// 極端な縦長画像でも高さ優先枝へ落ちず、常に全幅表示の仕様をそのまま計算できる。
/// ただし呼び出し側が保持するスクロールオフセットは `u16` 行単位なので、戻り値も
/// `u16::MAX` へ飽和させる（オーバーフロー回避と、不合理に大きい行数のまま上位層へ
/// 流さないための安全策）。
pub fn compute_full_width_rows(image_w: u32, image_h: u32, target_cols: u16) -> u16 {
    if image_w == 0 || image_h == 0 || target_cols == 0 {
        return 0;
    }
    let visual_w = f64::from(target_cols) * TERMINAL_CELL_ASPECT_RATIO;
    let img_ratio = f64::from(image_w) / f64::from(image_h);
    let rows = (visual_w / img_ratio).round();
    rows.clamp(1.0, f64::from(u16::MAX)) as u16
}

/// スクロールオフセットを `[0, content_rows.saturating_sub(visible_rows)]` へクランプする
/// 純粋関数（フルキャンバス画像表示の縦スクロール用、#530）。`content_rows <= visible_rows`
/// （そもそもスクロールが不要）のときは `max_offset` が0になるため、常に0を返す。
pub fn clamp_scroll_offset(offset: u16, content_rows: u16, visible_rows: u16) -> u16 {
    let max_offset = content_rows.saturating_sub(visible_rows);
    offset.min(max_offset)
}

/// [`RenderedImage`] の縦方向の一部（`offset` 行目から最大 `count` 行）だけを切り出す
/// （フルキャンバス画像表示のスクロール可視範囲抽出用、#530）。`offset` が `grid.rows` 以上の
/// 場合は0行の空グリッドを返し、`offset + count` が `grid.rows` を超える場合は末尾で
/// 切り詰める（`clamp_scroll_offset` で事前にクランプされている前提だが、この関数自体も
/// 範囲外アクセスで panic しないよう独立して防御する）。
#[cfg(test)]
pub fn slice_rendered_image_rows(grid: &RenderedImage, offset: u16, count: u16) -> RenderedImage {
    let start = offset.min(grid.rows);
    let end = start.saturating_add(count).min(grid.rows);
    let rows = end - start;
    let start_idx = start as usize * grid.cols as usize;
    let end_idx = end as usize * grid.cols as usize;
    let cells = grid
        .cells
        .get(start_idx..end_idx)
        .map(|slice| slice.to_vec())
        .unwrap_or_default();
    RenderedImage {
        cols: grid.cols,
        rows,
        cells,
    }
}

/// フルキャンバス画像表示のスクロールを目標位置へなめらかに追従させる ease-out
/// アニメーションの進行度（kako-jun追加要望、#530）。`image_fade::ImageFadeState::progress`
/// と同じ「経過時間 / 所要時間」ベースの設計だが、`Instant`/`Duration` には触れず
/// ミリ秒の `u64` だけを受け取る純粋関数にしている（`image_render.rs` はターミナル/時刻の
/// I/O に触れない決定論的計算だけを置く場所という既存の分離方針、`compute_cover_crop` 等と
/// 同じ）。
///
/// 線形の `t = elapsed_ms / duration_ms`（0.0〜1.0にクランプ）に対し、
/// ease-out カーブ `1 - (1-t)^2` を適用する — 開始直後は速く、目標に近づくほど減速して
/// 収束する（kako-jun「なめらかにしたい」要望に沿う、線形より自然な体感）。
/// `duration_ms == 0` は常に `1.0`（即時ジャンプ、アニメーション無効）を返す
/// （`ImageFadeState::progress` の `duration.is_zero()` 早期returnと同じ扱い）。
pub fn compute_scroll_ease_progress(elapsed_ms: u64, duration_ms: u64) -> f32 {
    if duration_ms == 0 {
        return 1.0;
    }
    let t = (elapsed_ms as f32 / duration_ms as f32).clamp(0.0, 1.0);
    1.0 - (1.0 - t) * (1.0 - t)
}

/// [`compute_scroll_ease_progress`] が返す進行度を使い、`start_offset` から `target_offset`
/// へ補間した「今フレームで表示すべきスクロールオフセット」を計算する純粋関数
/// （#530追加要望）。スクロールは文字セル単位（整数行）でしか描画できないため、線形補間の
/// 結果を最も近い整数行へ丸める（四捨五入）— 結果として1行ずつではあるが、瞬時ジャンプでは
/// なく `duration_ms` に渡って段階的に進む見た目になる。
pub fn compute_eased_scroll_offset(start_offset: u16, target_offset: u16, progress: f32) -> u16 {
    let interpolated =
        f32::from(start_offset) + (f32::from(target_offset) - f32::from(start_offset)) * progress;
    interpolated.round().clamp(0.0, f32::from(u16::MAX)) as u16
}

/// `pixels`（`img_w` x 高さ相当の RGBA straight alpha、行優先）から
/// `(crop_x, crop_y, crop_w, crop_h)` の矩形を切り出した新しい RGBA バイト列を返す
/// （行優先、`crop_w * crop_h * 4` バイト）。呼び出し元（[`compute_cover_crop`]）が返す矩形は
/// 契約上常に元画像の範囲内に収まるが、防御的に範囲外の読み出しはせず、はみ出た分は
/// 0（透明黒）で埋める（panicしない）。
fn crop_rgba(
    pixels: &[u8],
    img_w: u32,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
) -> Vec<u8> {
    let mut out = vec![0u8; crop_w as usize * crop_h as usize * 4];
    for y in 0..crop_h {
        let src_y = crop_y + y;
        for x in 0..crop_w {
            let src_x = crop_x + x;
            let src_i = ((src_y * img_w + src_x) * 4) as usize;
            if src_i + 4 > pixels.len() {
                continue;
            }
            let dst_i = ((y * crop_w + x) * 4) as usize;
            out[dst_i..dst_i + 4].copy_from_slice(&pixels[src_i..src_i + 4]);
        }
    }
    out
}

fn rgba_buffer_has_expected_len(pixels: &[u8], img_w: u32, img_h: u32) -> bool {
    let Some(expected_len) = (img_w as usize)
        .checked_mul(img_h as usize)
        .and_then(|pixel_count| pixel_count.checked_mul(4))
    else {
        return false;
    };
    pixels.len() >= expected_len
}

/// 元画像（`pixels`: RGBA straight alpha、`img_w` x `img_h`）を、ボックス平均で
/// `target_w` x `target_h` のサブピクセルグリッドへダウンサンプルする。
/// `pixels.len() < img_w * img_h * 4` 等の不正な入力では空の `Vec` を返す（panicしない）。
fn downsample_box_window(
    pixels: &[u8],
    img_w: u32,
    img_h: u32,
    target_w: u32,
    target_h: u32,
    target_y_start: u32,
    target_y_count: u32,
) -> Vec<(u8, u8, u8, u8)> {
    if img_w == 0
        || img_h == 0
        || target_w == 0
        || target_h == 0
        || target_y_count == 0
        || target_y_start >= target_h
    {
        return Vec::new();
    }
    if !rgba_buffer_has_expected_len(pixels, img_w, img_h) {
        return Vec::new();
    }
    let target_y_end = target_y_start.saturating_add(target_y_count).min(target_h);
    let actual_target_h = target_y_end - target_y_start;
    let mut out = Vec::with_capacity((target_w * actual_target_h) as usize);
    for ty in target_y_start..target_y_end {
        let y0 = ((u64::from(ty) * u64::from(img_h)) / u64::from(target_h)) as u32;
        let y1 = ((((u64::from(ty) + 1) * u64::from(img_h)) / u64::from(target_h)) as u32)
            .clamp(y0 + 1, img_h);
        for tx in 0..target_w {
            let x0 = ((u64::from(tx) * u64::from(img_w)) / u64::from(target_w)) as u32;
            let x1 = ((((u64::from(tx) + 1) * u64::from(img_w)) / u64::from(target_w)) as u32)
                .clamp(x0 + 1, img_w);
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

/// 元画像全体をターゲット全体（`target_w` x `target_h`）へダウンサンプルすると仮定したとき、
/// 縦方向に `target_y_start..target_y_start+target_y_count` の行だけを計算する薄いラッパ。
/// 全行ぶんの `Vec` を先に確保せず可視範囲だけを作るため、巨大なスクロール画像でも
/// 行数に比例したメモリを確保しない（#530 セルフレビュー対応）。
fn downsample_box(
    pixels: &[u8],
    img_w: u32,
    img_h: u32,
    target_w: u32,
    target_h: u32,
) -> Vec<(u8, u8, u8, u8)> {
    downsample_box_window(pixels, img_w, img_h, target_w, target_h, 0, target_h)
}

/// 元画像（RGBA、`img_w` x `img_h`）を `cols` x `rows` 文字セルの quadrant block グリッドへ
/// 変換する（`docs/visual/reference/20260722-nearsighted-pixel-redraw/tui-plan.md` の設計に
/// 従う）。セル数が 0、画像サイズが 0、または `pixels` が画像サイズに対して短すぎる場合は
/// [`blank_grid`] を返す（panicしない）。
///
/// 端末の高さが変わっても画像が縦横に潰れて見えないよう、cover-fit でアスペクト比を保つ
/// （#489）。ターゲットグリッド（`sub_w` x `sub_h`）へ単純に比例マッピングするのではなく、
/// 先に元画像側を [`compute_cover_crop`] で中央基準クロップしてから [`downsample_box`] へ
/// 渡す。クロップに使う実効ターゲット比は、文字セル数ベースの `sub_w:sub_h` を
/// [`TERMINAL_CELL_ASPECT_RATIO`] で補正した値（セルが正方形でないことの近似補正）。
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
    if !rgba_buffer_has_expected_len(pixels, img_w, img_h) {
        return blank_grid(cols, rows);
    }
    let sub_w = u32::from(cols) * 2;
    let sub_h = u32::from(rows) * 2;

    // 実効ターゲット比 = (sub_w:sub_h) をセルの実アスペクト比で補正したもの。
    // TERMINAL_CELL_ASPECT_RATIO = セルの幅/高さ なので、sub_h を割ることで
    // 「セルが縦長なぶん実効的な高さが大きくなる」効果を反映する。
    let effective_target_h = effective_target_height(sub_h);
    let (crop_x, crop_y, crop_w, crop_h) =
        compute_cover_crop(img_w, img_h, sub_w, effective_target_h);
    let cropped = crop_rgba(pixels, img_w, crop_x, crop_y, crop_w, crop_h);

    let sub = downsample_box(&cropped, crop_w, crop_h, sub_w, sub_h);
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

/// 元画像全体をクロップ無しで `cols` セル幅へ拡大・縮小し、総行数 `total_rows` のうち
/// `offset` 行目から最大 `rows` 行だけを quadrant block グリッドへ変換する。
/// フルキャンバス画像表示のスクロール可視範囲専用で、全行ぶんのグリッドを先に確保しない。
pub fn rgba_to_quadrant_grid_window(
    pixels: &[u8],
    img_w: u32,
    img_h: u32,
    cols: u16,
    total_rows: u16,
    offset: u16,
    rows: u16,
) -> RenderedImage {
    let visible_rows = total_rows.saturating_sub(offset).min(rows);
    if cols == 0 || total_rows == 0 || visible_rows == 0 || img_w == 0 || img_h == 0 {
        return blank_grid(cols, visible_rows);
    }
    if !rgba_buffer_has_expected_len(pixels, img_w, img_h) {
        return blank_grid(cols, visible_rows);
    }

    let sub_w = u32::from(cols) * 2;
    let total_sub_h = u32::from(total_rows) * 2;
    let sub_offset = u32::from(offset) * 2;
    let sub_rows = u32::from(visible_rows) * 2;
    let sub = downsample_box_window(
        pixels,
        img_w,
        img_h,
        sub_w,
        total_sub_h,
        sub_offset,
        sub_rows,
    );
    if sub.is_empty() {
        return blank_grid(cols, visible_rows);
    }

    let mut cells = Vec::with_capacity(cols as usize * visible_rows as usize);
    for cy in 0..visible_rows {
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
    RenderedImage {
        cols,
        rows: visible_rows,
        cells,
    }
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
    fn load_image_rgba_corrupted_webp_bytes_is_err_without_panicking() {
        // 拡張子は .webp だが中身がwebpのマジックバイトすら持たない壊れたファイル。
        let path = write_test_bytes_fixture(&[1u8, 2, 3, 4, 5, 6, 7, 8], "webp");
        let result = load_image_rgba(&path);
        assert!(
            result.is_err(),
            "corrupted webp bytes should be Err, not panic"
        );
    }

    #[test]
    fn load_image_rgba_non_webp_file_is_err_given_webp_only_feature() {
        // Cargo.toml で image crate は webp feature のみ有効（PNG等は無効化済み、#481）。
        // 中身は正しい1x1 PNG（PIL等ではなく手組みの最小PNGバイト列）だが、
        // PNGデコーダがビルドに含まれていないため Err になるはず。
        #[rustfmt::skip]
        const MINIMAL_1X1_PNG: [u8; 70] = [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 56, 145,
            98, 244, 31, 0, 5, 180, 2, 94, 192, 100, 233, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174,
            66, 96, 130,
        ];
        let path = write_test_bytes_fixture(&MINIMAL_1X1_PNG, "png");
        let result = load_image_rgba(&path);
        assert!(
            result.is_err(),
            "a valid PNG should still be Err because the png codec is not compiled in"
        );
    }

    #[test]
    fn load_image_rgba_valid_webp_fixture_roundtrips_exact_dimensions_and_pixels() {
        // #481 follow-up: 実デコード経路(load_image_rgba)を、実在するがハンドメイドの
        // 小さいWebPフィクスチャで初めて自動テスト化する（既存テストは存在しないパス/
        // 壊れたバイト列のエラー経路のみをカバーしていた）。
        let rgba: Vec<u8> = vec![
            10, 20, 30, 255, 40, 50, 60, 255, // row0: 2px
            70, 80, 90, 255, 100, 110, 120, 255, // row1: 2px
        ];
        let path = write_test_webp_fixture(&rgba, 2, 2);
        let decoded = load_image_rgba(&path).expect("valid webp fixture should decode");
        assert_eq!(decoded.width, 2);
        assert_eq!(decoded.height, 2);
        assert_eq!(
            decoded.rgba, rgba,
            "lossless webp roundtrip should preserve exact RGBA bytes"
        );
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

    #[test]
    fn image_cache_hit_returns_same_rc_without_redecoding() {
        // 同一パスの2回目取得は再デコードせず、既存の Rc をそのまま返す
        // （エビクション導入後も通常のキャッシュヒット挙動が壊れていないことの回帰ガード）。
        let mut cache = ImageCache::new();
        let path = write_test_webp_fixture(&[1, 2, 3, 255], 1, 1);
        let first = cache.get_or_load(&path).expect("first load should decode");
        let second = cache
            .get_or_load(&path)
            .expect("second load should hit cache");
        assert!(
            Rc::ptr_eq(&first, &second),
            "cache hit should return the same Rc instance, not a freshly decoded one"
        );
    }

    #[test]
    fn image_cache_evicts_oldest_entry_when_exceeding_capacity() {
        // MAX_CACHE_ENTRIES を超える件数を挿入すると、最も古く挿入されたエントリから
        // 追い出されることを確認する（プレイセッション全体でRGBAが無制限に蓄積しないための
        // 上限、#481 セルフレビュー指摘）。
        let mut cache = ImageCache::new();
        let paths: Vec<PathBuf> = (0..(MAX_CACHE_ENTRIES + 1))
            .map(|i| write_test_webp_fixture(&[i as u8, i as u8, i as u8, 255], 1, 1))
            .collect();
        for path in &paths {
            let result = cache.get_or_load(path);
            assert!(result.is_some(), "each fixture should decode successfully");
        }
        let oldest = &paths[0];
        assert!(
            !cache.entries.contains_key(oldest),
            "oldest entry should have been evicted once capacity is exceeded"
        );
        assert_eq!(
            cache.entries.len(),
            MAX_CACHE_ENTRIES,
            "cache should not grow past the configured capacity"
        );
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
    fn quadrant_cell_full_block_mask_is_structurally_unreachable() {
        // `quadrant_cell_from_subpixels` のdoc commentに明記されている設計上の性質を
        // 固定する回帰テスト: `farthest_pair` が返す ref_a は自分自身との距離が必ず0
        // (dist_a=0 <= dist_b はどんな相手でも真)になるため、常に「背景」側(mask非セット)
        // に分類される。よってmask(4bit)は最低1bitは常に0のままで、mask=15(フルブロック
        // '█')には実装上絶対到達しない。バグではなく仕様であり、意図せず変わっていないかを
        // ここで固定する。4色すべてがバラバラな複数パターンで確認する。
        let cases: [[(u8, u8, u8); 4]; 5] = [
            [(0, 0, 0), (255, 255, 255), (255, 0, 0), (0, 255, 0)],
            [(10, 20, 30), (200, 210, 220), (5, 5, 5), (250, 250, 250)],
            [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)],
            [(0, 0, 0), (85, 85, 85), (170, 170, 170), (255, 255, 255)],
            [(1, 2, 3), (253, 252, 251), (4, 5, 6), (6, 5, 4)],
        ];
        for subpixels in cases {
            let cell = quadrant_cell_from_subpixels(subpixels);
            assert_ne!(
                cell.glyph, '█',
                "mask=15 should be structurally unreachable, subpixels={subpixels:?}"
            );
        }
    }

    // ---- cover-fit クロップ計算（純粋関数）----

    #[test]
    fn compute_cover_crop_wide_image_into_tall_target_crops_width_keeps_full_height() {
        // 横長の元画像(2:1)を縦長のターゲット(1:2)へ cover-fit させる場合、高さはフルのまま
        // 幅だけが中央基準でクロップされる。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(200, 100, 10, 20);
        assert_eq!(crop_h, 100, "高さはフルのまま");
        assert_eq!(crop_y, 0);
        assert_eq!(crop_w, 50, "target比(1:2)に合わせて幅を50までクロップ");
        assert_eq!(crop_x, 75, "中央基準: (200-50)/2");
    }

    #[test]
    fn compute_cover_crop_tall_image_into_wide_target_crops_height_keeps_full_width() {
        // 縦長の元画像(1:2)を横長のターゲット(2:1)へ cover-fit させる場合は逆に、幅はフルの
        // まま高さだけが中央基準でクロップされる。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(100, 200, 20, 10);
        assert_eq!(crop_w, 100, "幅はフルのまま");
        assert_eq!(crop_x, 0);
        assert_eq!(crop_h, 50, "target比(2:1)に合わせて高さを50までクロップ");
        assert_eq!(crop_y, 75, "中央基準: (200-50)/2");
    }

    #[test]
    fn compute_cover_crop_matching_aspect_ratio_crops_nothing() {
        // 元画像とターゲットのアスペクト比が一致していれば、クロップは発生せず全体が
        // そのまま返る（正方形どうしに限らず、比が一致していれば常にこうなるはず）。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(50, 50, 10, 10);
        assert_eq!((crop_x, crop_y, crop_w, crop_h), (0, 0, 50, 50));

        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(200, 100, 8, 4);
        assert_eq!((crop_x, crop_y, crop_w, crop_h), (0, 0, 200, 100));
    }

    #[test]
    fn compute_cover_crop_zero_dimension_returns_full_image_without_panicking() {
        assert_eq!(compute_cover_crop(0, 100, 10, 10), (0, 0, 0, 100));
        assert_eq!(compute_cover_crop(100, 0, 10, 10), (0, 0, 100, 0));
        assert_eq!(compute_cover_crop(100, 100, 0, 10), (0, 0, 100, 100));
        assert_eq!(compute_cover_crop(100, 100, 10, 0), (0, 0, 100, 100));
    }

    #[test]
    fn compute_cover_crop_result_always_fits_within_source_image_bounds() {
        // 不変条件テスト: どんな組み合わせでも、返るクロップ矩形は必ず元画像の範囲内に
        // 収まる（はみ出た矩形を downsample_box に渡すと範囲外読み出しになりうるため）。
        let img_sizes = [(1u32, 1u32), (3, 7), (7, 3), (128, 128), (1920, 1080)];
        let target_sizes = [(1u32, 1u32), (2, 9), (9, 2), (64, 64), (13, 41)];
        for &(img_w, img_h) in &img_sizes {
            for &(target_w, target_h) in &target_sizes {
                let (crop_x, crop_y, crop_w, crop_h) =
                    compute_cover_crop(img_w, img_h, target_w, target_h);
                assert!(
                    crop_w >= 1 && crop_h >= 1,
                    "クロップ矩形は空であってはならない"
                );
                assert!(
                    crop_x + crop_w <= img_w,
                    "crop_x+crop_w={} が img_w={} を超えた (img={img_w}x{img_h}, target={target_w}x{target_h})",
                    crop_x + crop_w,
                    img_w
                );
                assert!(
                    crop_y + crop_h <= img_h,
                    "crop_y+crop_h={} が img_h={} を超えた (img={img_w}x{img_h}, target={target_w}x{target_h})",
                    crop_y + crop_h,
                    img_h
                );
            }
        }
    }

    #[test]
    fn compute_cover_crop_square_image_ratio_greater_than_target_crops_width() {
        // デシジョンテーブル: img_w/img_hの絶対大小関係(ここでは正方形=同値)ではなく
        // img_ratio と target_ratio の比較だけで分岐が決まることを確認する。
        // 正方形(比1.0)を、より縦長のtarget(比0.5)へcover-fitさせると img_ratio(1.0) >
        // target_ratio(0.5) となり幅がクロップされる。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(100, 100, 10, 20);
        assert_eq!(crop_h, 100, "高さはフルのまま");
        assert_eq!(crop_y, 0);
        assert_eq!(crop_w, 50, "target比(0.5)に合わせて幅を50までクロップ");
        assert_eq!(crop_x, 25, "中央基準: (100-50)/2");
    }

    #[test]
    fn compute_cover_crop_tall_image_but_relatively_wider_than_extreme_tall_target_crops_width() {
        // クロスケース回帰防止: img自体は縦長(w=100<h=200, 比0.5)だが、targetはさらに
        // 極端に縦長(比0.1)なので、img_ratio(0.5) > target_ratio(0.1) となり「imgの方が
        // 相対的に横長」判定になって幅がクロップされる。img_w<img_hという絶対関係だけを
        // 見て「縦長だから高さクロップのはず」と誤判定しないことを確認する。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(100, 200, 1, 10);
        assert_eq!(
            crop_h, 200,
            "高さはフルのまま(imgが相対的に横長扱いされるため)"
        );
        assert_eq!(crop_y, 0);
        assert_eq!(
            crop_w, 20,
            "target比(0.1)に合わせて幅を20までクロップ: round(200*0.1)"
        );
        assert_eq!(crop_x, 40, "中央基準: (100-20)/2");
    }

    #[test]
    fn compute_cover_crop_wide_image_but_relatively_taller_than_extreme_wide_target_crops_height() {
        // クロスケース回帰防止（逆方向）: img自体は横長(w=200>h=100, 比2.0)だが、target は
        // さらに極端に横長(比10.0)なので、img_ratio(2.0) <= target_ratio(10.0) となり
        // 「imgの方が相対的に縦長」判定になって高さがクロップされる。img_w>img_hという
        // 絶対関係だけを見て「横長だから幅クロップのはず」と誤判定しないことを確認する。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(200, 100, 100, 10);
        assert_eq!(
            crop_w, 200,
            "幅はフルのまま(imgが相対的に縦長扱いされるため)"
        );
        assert_eq!(crop_x, 0);
        assert_eq!(
            crop_h, 20,
            "target比(10.0)に合わせて高さを20までクロップ: round(200/10.0)"
        );
        assert_eq!(crop_y, 40, "中央基準: (100-20)/2");
    }

    #[test]
    fn compute_cover_crop_square_image_ratio_less_than_target_crops_height() {
        // 正方形(比1.0)を、より横長のtarget(比2.0)へcover-fitさせると img_ratio(1.0) <
        // target_ratio(2.0) となり高さがクロップされる（item1の対称ケース）。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(100, 100, 20, 10);
        assert_eq!(crop_w, 100, "幅はフルのまま");
        assert_eq!(crop_x, 0);
        assert_eq!(crop_h, 50, "target比(2.0)に合わせて高さを50までクロップ");
        assert_eq!(crop_y, 25, "中央基準: (100-50)/2");
    }

    #[test]
    fn compute_cover_crop_tall_image_ratio_equals_target_crops_nothing() {
        // 縦長img(比0.5)とtarget(比0.5)の比が一致する場合、クロップは発生しない
        // （既存の `compute_cover_crop_matching_aspect_ratio_crops_nothing` は正方形と
        // 横長の組み合わせのみカバーしていたため、縦長側でも確認する）。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(50, 100, 1, 2);
        assert_eq!((crop_x, crop_y, crop_w, crop_h), (0, 0, 50, 100));
    }

    #[test]
    fn compute_cover_crop_ratio_just_above_boundary_crops_minimal_width() {
        // 境界値: img_ratio(101/100=1.01)がtarget_ratio(1.0)よりわずかに大きいだけの
        // ケース。分岐は「幅クロップ」側に倒れるが、クロップ量は最小(1px)になるはず。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(101, 100, 100, 100);
        assert_eq!(crop_h, 100, "高さはフルのまま");
        assert_eq!(crop_y, 0);
        assert_eq!(
            crop_w, 100,
            "round(100*1.0)=100、img_w=101よりちょうど1px少ない"
        );
        assert_eq!(crop_x, 0, "(101-100)/2=0（整数除算で切り捨て）");
    }

    #[test]
    fn compute_cover_crop_ratio_just_below_boundary_crops_minimal_height() {
        // 対称ケース: img_ratio(100/101≈0.9901)がtarget_ratio(1.0)よりわずかに小さいだけ。
        // 分岐は「高さクロップ」側(else)に倒れるが、クロップ量は最小(1px)になるはず。
        let (crop_x, crop_y, crop_w, crop_h) = compute_cover_crop(100, 101, 100, 100);
        assert_eq!(crop_w, 100, "幅はフルのまま");
        assert_eq!(crop_x, 0);
        assert_eq!(
            crop_h, 100,
            "round(100/1.0)=100、img_h=101よりちょうど1px少ない"
        );
        assert_eq!(crop_y, 0, "(101-100)/2=0（整数除算で切り捨て）");
    }

    #[test]
    fn compute_cover_crop_1x1_image_returns_full_image_regardless_of_target() {
        // 境界値: img_w/img_hが1(これ以上縮められない)の場合、crop_w/crop_hは
        // `clamp(1, img_w)` / `clamp(1, img_h)` によりどちらも1に固定される。
        // targetがどれだけ極端な比であっても常に画像全体(0,0,1,1)が返ることを、
        // 複数のtargetで確認する（実装の意図の明示テスト）。
        let targets = [(1u32, 1000u32), (1000, 1), (50, 50), (1, 1), (7, 3)];
        for &(target_w, target_h) in &targets {
            assert_eq!(
                compute_cover_crop(1, 1, target_w, target_h),
                (0, 0, 1, 1),
                "target={target_w}x{target_h} でも1x1画像は常に全体を返すはず"
            );
        }
    }

    #[test]
    fn compute_cover_crop_result_aspect_ratio_matches_effective_target_ratio_within_rounding() {
        // doctrine「等価性の機械的証明」: compute_cover_crop の戻り値のアスペクト比
        // (crop_w/crop_h) は、渡した target 側の比 (target_w/target_h) と整数丸め誤差の
        // 範囲内で一致するはず。rgba_to_quadrant_grid が実際に呼び出す際の target は
        // 文字セル数(sub_w x sub_h)を effective_target_height() で補正した
        // effective_target_h なので、本番と同じ関数をそのまま呼び実利用に即した値で
        // 検証する（期待値を直書きせず、本番の計算関数から導出する）。
        //
        // img は十分大きい値だけを使う（1x1 等の極小画像は `clamp(1, img_w/img_h)` で
        // 比が保てなくなることが意図された挙動であり、それは別テスト
        // `compute_cover_crop_1x1_image_returns_full_image_regardless_of_target` が
        // カバーしている）。
        let cell_grids: [(u16, u16); 4] = [(1, 1), (10, 5), (3, 20), (80, 24)];
        let img_sizes: [(u32, u32); 6] = [
            (100, 100),
            (1920, 1080),
            (1080, 1920),
            (2000, 100),
            (100, 2000),
            (333, 777),
        ];

        for &(cols, rows) in &cell_grids {
            let sub_w = u32::from(cols) * 2;
            let sub_h = u32::from(rows) * 2;
            let effective_target_h = effective_target_height(sub_h);
            let target_ratio = f64::from(sub_w) / f64::from(effective_target_h);

            for &(img_w, img_h) in &img_sizes {
                let (_, _, crop_w, crop_h) =
                    compute_cover_crop(img_w, img_h, sub_w, effective_target_h);
                let crop_ratio = f64::from(crop_w) / f64::from(crop_h);
                // crop_w/crop_hは整数への丸めを経るため、その丸め1px分の誤差を許容する。
                let tolerance =
                    1.0 / f64::from(crop_h.max(1)) + 1.0 / f64::from(crop_w.max(1)) + 1e-9;
                assert!(
                    (crop_ratio - target_ratio).abs() <= tolerance,
                    "img={img_w}x{img_h} target={sub_w}x{effective_target_h}: crop比{crop_ratio} が target比{target_ratio} と丸め誤差({tolerance})を超えて乖離 (crop={crop_w}x{crop_h})"
                );
            }
        }
    }

    #[test]
    fn crop_rgba_extracts_expected_subrectangle() {
        // 4x2 の画像（列ごとに異なる色: 0,1,2,3）から中央2列(x=1..3)を切り出す。
        let colors: [(u8, u8, u8, u8); 4] = [
            (10, 0, 0, 255),
            (20, 0, 0, 255),
            (30, 0, 0, 255),
            (40, 0, 0, 255),
        ];
        let mut pixels = Vec::new();
        for _y in 0..2 {
            for &(r, g, b, a) in &colors {
                pixels.extend_from_slice(&[r, g, b, a]);
            }
        }
        let cropped = crop_rgba(&pixels, 4, 1, 0, 2, 2);
        assert_eq!(cropped.len(), 2 * 2 * 4);
        // 各行とも列1,2の色（20,0,0,255）(30,0,0,255）が並ぶはず。
        assert_eq!(&cropped[0..4], &[20, 0, 0, 255]);
        assert_eq!(&cropped[4..8], &[30, 0, 0, 255]);
        assert_eq!(&cropped[8..12], &[20, 0, 0, 255]);
        assert_eq!(&cropped[12..16], &[30, 0, 0, 255]);
    }

    #[test]
    fn crop_rgba_out_of_bounds_rect_zero_fills_without_panicking() {
        // crop_rgba のdocコメントが明記する防御的挙動: 呼び出し元(compute_cover_crop)の
        // 契約上は常にin-boundsな矩形しか渡らないはずだが、それでも範囲外の読み出しを
        // せず0(透明黒)で埋めるガードが実装されている。この専用テストで直接検証する。
        let pixels: Vec<u8> = vec![
            1, 1, 1, 255, 2, 2, 2, 255, // row0: 2px
            3, 3, 3, 255, 4, 4, 4,
            255, // row1: 2px (img_w=2の2x2画像として16バイトのみ)
        ];
        // (crop_x=1, crop_y=1) を起点に2x2をクロップ要求すると、右端・下端が画像範囲外
        // (存在するのは16バイト=2x2画素のみ)になる。
        let cropped = crop_rgba(&pixels, 2, 1, 1, 2, 2);
        assert_eq!(cropped.len(), 2 * 2 * 4, "サイズ自体は要求通りに確保される");
        assert_eq!(
            &cropped[0..4],
            &[4, 4, 4, 255],
            "in-boundsな唯一の画素(src=(1,1))はそのままコピーされる"
        );
        assert_eq!(&cropped[4..8], &[0, 0, 0, 0], "範囲外(src=(2,1))は0埋め");
        assert_eq!(&cropped[8..12], &[0, 0, 0, 0], "範囲外(src=(1,2))は0埋め");
        assert_eq!(&cropped[12..16], &[0, 0, 0, 0], "範囲外(src=(2,2))は0埋め");
    }

    #[test]
    fn rgba_to_quadrant_grid_cover_fit_crops_out_far_edge_color() {
        // 統合確認: 横長画像の左右の縁だけが緑、中央の広い範囲が赤。単純な比例マッピング
        // （クロップ無し）なら1x1セルの結果は赤緑が混ざった色になるはずだが、cover-fit
        // クロップにより画像端の緑は完全に切り落とされ、赤のみが残る。
        //
        // #489セルフレビュー指摘: 以前はimg=4x2という極小フィクスチャで、
        // TERMINAL_CELL_ASPECT_RATIO=0.5前提の1px境界に暗黙依存し、赤/緑境界を直書きして
        // いた（定数を調整すると壊れる）。ここでは赤/緑の境界を画像端から十分離す（緑を
        // 左右の縁だけの帯にする）ことで、TERMINAL_CELL_ASPECT_RATIO が多少調整されても
        // クロップ結果が赤の範囲内に収まるようにする（doctrine: テストの期待値に定数の
        // 計算結果を直書きしない）。
        let img_w = 100u32;
        let img_h = 10u32;
        let red = [255u8, 0, 0, 255];
        let green = [0u8, 255, 0, 255];
        let red_range = 30..70; // 中央40px幅だけ赤、残りの左右各30pxは緑
        let mut pixels = Vec::with_capacity((img_w * img_h * 4) as usize);
        for _y in 0..img_h {
            for x in 0..img_w {
                let px = if red_range.contains(&x) { red } else { green };
                pixels.extend_from_slice(&px);
            }
        }
        let grid = rgba_to_quadrant_grid(&pixels, img_w, img_h, 1, 1);
        assert_eq!(grid.cells.len(), 1);
        assert_eq!(
            grid.cells[0].bg,
            (255, 0, 0),
            "cover-fitクロップにより中央から十分離れた緑の縁は完全に切り落とされ赤のみが残るはず"
        );
        assert_eq!(
            grid.cells[0].glyph, ' ',
            "単色クロップ結果は無地セルになるはず"
        );
    }

    #[test]
    fn rgba_to_quadrant_grid_pixels_shorter_than_declared_size_returns_blank_grid_without_panicking(
    ) {
        // 最重要（事故パターン）: crop_rgba導入後、downsample_box自身が持つ同種チェック
        // （`pixels.len() < img_w*img_h*4`）は、rgba_to_quadrant_grid経由の呼び出し経路
        // では発火しなくなった。crop_rgbaが常に「crop_w*crop_h*4 ちょうど」のバッファを
        // 新しく作ってdownsample_boxへ渡すため、downsample_box側からは常にサイズが
        // 一致して見える（crop_rgba自体は範囲外を0埋めするだけでpanicはしないが、
        // 不正な長さのpixelsに対して「blank_gridを返す」という契約を守れるのは、
        // rgba_to_quadrant_grid冒頭の本ガードだけになった）。
        let pixels = vec![255u8; 4]; // 1画素分しかないのに 4x4 を主張する不正な入力
        let grid = rgba_to_quadrant_grid(&pixels, 4, 4, 2, 2);
        assert_eq!(grid.cols, 2);
        assert_eq!(grid.rows, 2);
        assert_eq!(grid.cells.len(), 4);
        assert!(
            grid.cells.iter().all(|c| *c == BLANK_CELL),
            "不正な長さのpixelsに対してはblank_gridを返すべき（panicしない）"
        );
    }

    #[test]
    fn rgba_to_quadrant_grid_window_uses_only_requested_visible_rows() {
        let pixels = vec![255, 0, 0, 255];
        let grid = rgba_to_quadrant_grid_window(&pixels, 1, 1, 40, u16::MAX, u16::MAX - 20, 20);
        assert_eq!(grid.rows, 20);
        assert_eq!(grid.cells.len(), 40 * 20);
    }

    #[test]
    fn rgba_to_quadrant_grid_window_rejects_overflowing_source_size_without_panicking() {
        let grid = rgba_to_quadrant_grid_window(&[], u32::MAX, u32::MAX, 40, 20, 0, 20);
        assert_eq!(grid, blank_grid(40, 20));
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

    // ---- contain-fit（フルキャンバス画像表示、#530）----

    #[test]
    fn compute_contain_fit_zero_image_width_returns_zero() {
        assert_eq!(compute_contain_fit(0, 100, 10, 10), (0, 0));
    }

    #[test]
    fn compute_contain_fit_zero_image_height_returns_zero() {
        assert_eq!(compute_contain_fit(100, 0, 10, 10), (0, 0));
    }

    #[test]
    fn compute_contain_fit_zero_max_cols_returns_zero() {
        assert_eq!(compute_contain_fit(100, 100, 0, 10), (0, 0));
    }

    #[test]
    fn compute_contain_fit_zero_max_rows_returns_zero() {
        assert_eq!(compute_contain_fit(100, 100, 10, 0), (0, 0));
    }

    #[test]
    fn compute_contain_fit_aspect_exactly_matches_box_fills_both_dimensions() {
        // image_w=200,image_h=100(比2.0) を max_cols=20,max_rows=5 の枠へ contain-fit。
        // 実効ボックス比(20*0.5 / 5 = 2.0)と画像比が完全一致するため、幅優先枝
        // （`<=`の等号側）が採られ、両方いっぱいに埋まる。
        assert_eq!(compute_contain_fit(200, 100, 20, 5), (20, 5));
    }

    #[test]
    fn compute_contain_fit_slightly_wider_than_box_takes_width_branch_with_shorter_rows() {
        // 比2.5(実効ボックス比2.0よりわずかに横長寄り)は幅優先枝に入り、
        // fitted_cols は max_cols いっぱいまで使うが fitted_rows は max_rows未満になる。
        let (cols, rows) = compute_contain_fit(250, 100, 20, 5);
        assert_eq!(
            cols, 20,
            "幅優先枝なのでfitted_colsはmax_colsいっぱいになるはず"
        );
        assert!(
            rows < 5,
            "横長寄りなのでfitted_rowsはmax_rows未満のはず: rows={rows}"
        );
    }

    #[test]
    fn compute_contain_fit_slightly_taller_than_box_takes_height_branch_with_narrower_cols() {
        // 比1.0(実効ボックス比2.0より縦長寄り)は高さ優先枝に入り、
        // fitted_rows は max_rows いっぱいまで使うが fitted_cols は max_cols未満になる。
        let (cols, rows) = compute_contain_fit(100, 100, 20, 5);
        assert_eq!(
            rows, 5,
            "高さ優先枝なのでfitted_rowsはmax_rowsいっぱいになるはず"
        );
        assert!(
            cols < 20,
            "縦長寄りなのでfitted_colsはmax_cols未満のはず: cols={cols}"
        );
    }

    #[test]
    fn compute_contain_fit_1x1_box_and_1x1_image_returns_1x1() {
        assert_eq!(compute_contain_fit(1, 1, 1, 1), (1, 1));
    }

    #[test]
    fn compute_contain_fit_extremely_wide_image_into_small_box_keeps_at_least_one_row() {
        let (cols, rows) = compute_contain_fit(10000, 1, 5, 5);
        assert!(rows >= 1, "fitted_rowsは最低1になるはず: rows={rows}");
        assert_eq!(cols, 5);
    }

    #[test]
    fn compute_contain_fit_extremely_tall_image_into_small_box_keeps_at_least_one_col() {
        let (cols, rows) = compute_contain_fit(1, 10000, 5, 5);
        assert!(cols >= 1, "fitted_colsは最低1になるはず: cols={cols}");
        assert_eq!(rows, 5);
    }

    #[test]
    fn compute_full_width_rows_zero_dimensions_return_zero() {
        assert_eq!(compute_full_width_rows(0, 100, 40), 0);
        assert_eq!(compute_full_width_rows(100, 0, 40), 0);
        assert_eq!(compute_full_width_rows(100, 100, 0), 0);
    }

    #[test]
    fn compute_full_width_rows_keeps_width_for_extremely_tall_images() {
        // 高さ上限を含むcontain-fitなら幅を縮める画像でも、フル幅表示の必要行数を返す。
        assert_eq!(compute_full_width_rows(1, 50, 40), 1000);
    }

    #[test]
    fn compute_full_width_rows_saturates_without_overflowing_for_extreme_aspect_ratio() {
        assert_eq!(compute_full_width_rows(1, u32::MAX, 40), u16::MAX);
    }

    #[test]
    fn compute_contain_fit_result_always_within_box_bounds() {
        // 不変条件テスト: image/boxのどんな組み合わせでも(0を除く)、fitted_cols/rows は
        // 必ず [1, max_cols]/[1, max_rows] の範囲に収まる。
        let image_sizes: [(u32, u32); 6] =
            [(1, 1), (3, 7), (7, 3), (128, 128), (1920, 1080), (1, 10000)];
        let box_sizes: [(u16, u16); 5] = [(1, 1), (10, 5), (5, 10), (84, 20), (2000, 1)];
        for &(image_w, image_h) in &image_sizes {
            for &(max_cols, max_rows) in &box_sizes {
                let (cols, rows) = compute_contain_fit(image_w, image_h, max_cols, max_rows);
                assert!(
                    (1..=max_cols).contains(&cols),
                    "image={image_w}x{image_h} box={max_cols}x{max_rows}: fitted_cols={cols} が範囲外"
                );
                assert!(
                    (1..=max_rows).contains(&rows),
                    "image={image_w}x{image_h} box={max_cols}x{max_rows}: fitted_rows={rows} が範囲外"
                );
            }
        }
    }

    // ---- スクロールオフセットのクランプ（#530）----

    #[test]
    fn clamp_scroll_offset_below_max_offset_is_unchanged() {
        // content_rows=10, visible_rows=4 → max_offset=6。境界の1つ内側(5)は変化しない。
        assert_eq!(clamp_scroll_offset(5, 10, 4), 5);
    }

    #[test]
    fn clamp_scroll_offset_exactly_at_max_offset_is_unchanged() {
        assert_eq!(clamp_scroll_offset(6, 10, 4), 6);
    }

    #[test]
    fn clamp_scroll_offset_above_max_offset_is_clamped_down() {
        assert_eq!(clamp_scroll_offset(9, 10, 4), 6);
    }

    #[test]
    fn clamp_scroll_offset_content_equals_visible_is_always_zero() {
        assert_eq!(clamp_scroll_offset(3, 5, 5), 0);
    }

    #[test]
    fn clamp_scroll_offset_content_shorter_than_visible_is_always_zero_without_underflow() {
        // saturating_sub のおかげで content_rows < visible_rows でも panic せず0になる。
        assert_eq!(clamp_scroll_offset(2, 3, 10), 0);
    }

    #[test]
    fn clamp_scroll_offset_zero_visible_rows_clamps_to_content_rows_not_zero() {
        // visible_rows=0 のときは max_offset=content_rows自身になるため、
        // 大きなoffsetはcontent_rowsにクランプされるだけで0にはならない。
        assert_eq!(clamp_scroll_offset(100, 7, 0), 7);
    }

    // ---- 可視範囲の切り出し（#530）----

    fn row_marked_grid(cols: u16, rows: u16) -> RenderedImage {
        let mut cells = Vec::with_capacity(cols as usize * rows as usize);
        for y in 0..rows {
            for _x in 0..cols {
                cells.push(QuadrantCell {
                    glyph: ' ',
                    fg: (y as u8, 0, 0),
                    bg: (y as u8, 0, 0),
                });
            }
        }
        RenderedImage { cols, rows, cells }
    }

    #[test]
    fn slice_rendered_image_rows_offset_within_bounds_extracts_requested_rows() {
        let grid = row_marked_grid(2, 5);
        let sliced = slice_rendered_image_rows(&grid, 1, 2);
        assert_eq!(sliced.rows, 2);
        assert_eq!(sliced.cells[0].fg, (1, 0, 0));
        assert_eq!(sliced.cells[2].fg, (2, 0, 0));
    }

    #[test]
    fn slice_rendered_image_rows_offset_equals_grid_rows_is_empty() {
        let grid = row_marked_grid(2, 5);
        let sliced = slice_rendered_image_rows(&grid, 5, 2);
        assert_eq!(sliced.rows, 0);
        assert!(sliced.cells.is_empty());
    }

    #[test]
    fn slice_rendered_image_rows_offset_beyond_grid_rows_is_empty_without_panicking() {
        let grid = row_marked_grid(2, 5);
        let sliced = slice_rendered_image_rows(&grid, 10, 2);
        assert_eq!(sliced.rows, 0);
        assert!(sliced.cells.is_empty());
    }

    #[test]
    fn slice_rendered_image_rows_zero_count_is_empty() {
        let grid = row_marked_grid(2, 5);
        let sliced = slice_rendered_image_rows(&grid, 0, 0);
        assert_eq!(sliced.rows, 0);
        assert!(sliced.cells.is_empty());
    }

    #[test]
    fn slice_rendered_image_rows_count_beyond_remaining_rows_is_truncated() {
        let grid = row_marked_grid(2, 5);
        let sliced = slice_rendered_image_rows(&grid, 3, 10);
        assert_eq!(
            sliced.rows, 2,
            "grid.rows(5) - offset(3) = 2行に切り詰められるはず"
        );
    }

    #[test]
    fn slice_rendered_image_rows_full_range_matches_original_grid() {
        let grid = row_marked_grid(3, 4);
        let sliced = slice_rendered_image_rows(&grid, 0, 4);
        assert_eq!(sliced, grid);
    }

    // ---- スクロールease進行度（#530）----

    #[test]
    fn compute_scroll_ease_progress_zero_elapsed_is_zero() {
        assert_eq!(compute_scroll_ease_progress(0, 1000), 0.0);
    }

    #[test]
    fn compute_scroll_ease_progress_elapsed_equals_duration_is_one() {
        assert_eq!(compute_scroll_ease_progress(1000, 1000), 1.0);
    }

    #[test]
    fn compute_scroll_ease_progress_one_ms_before_duration_is_less_than_one() {
        let progress = compute_scroll_ease_progress(999, 1000);
        assert!(progress < 1.0, "progress={progress} は1.0未満のはず");
    }

    #[test]
    fn compute_scroll_ease_progress_elapsed_past_duration_is_clamped_to_one() {
        assert_eq!(compute_scroll_ease_progress(1001, 1000), 1.0);
    }

    #[test]
    fn compute_scroll_ease_progress_zero_duration_is_always_one() {
        assert_eq!(compute_scroll_ease_progress(0, 0), 1.0);
        assert_eq!(compute_scroll_ease_progress(500, 0), 1.0);
    }

    #[test]
    fn compute_scroll_ease_progress_midpoint_uses_ease_out_curve_not_linear() {
        // t=0.5 → 1-(1-0.5)^2 = 0.75。線形補間(0.5)ではないことを確認する。
        let progress = compute_scroll_ease_progress(500, 1000);
        assert!(
            (progress - 0.75).abs() < 1e-6,
            "progress={progress} は0.75に近いはず(線形なら0.5になってしまう)"
        );
    }

    // ---- スクロールeaseの補間オフセット（#530）----

    #[test]
    fn compute_eased_scroll_offset_progress_zero_returns_start_offset() {
        assert_eq!(compute_eased_scroll_offset(5, 20, 0.0), 5);
    }

    #[test]
    fn compute_eased_scroll_offset_progress_one_returns_target_offset() {
        assert_eq!(compute_eased_scroll_offset(5, 20, 1.0), 20);
    }

    #[test]
    fn compute_eased_scroll_offset_upward_scroll_moves_monotonically_toward_target() {
        // start(20) > target(5) の上スクロール方向でも、progressが進むほど単調に
        // targetへ近づく(値が減っていく)ことを確認する。
        let early = compute_eased_scroll_offset(20, 5, 0.3);
        let late = compute_eased_scroll_offset(20, 5, 0.7);
        assert!(
            early > late,
            "progressが進むほどtargetに近づく(値が減る)はず: early={early} late={late}"
        );
    }

    #[test]
    fn compute_eased_scroll_offset_half_progress_rounds_away_from_zero() {
        // start=0,target=1,progress=0.5 → interpolated=0.5。Rustのf32::roundは0.5から
        // 離れる方向(この場合は1)に丸めるため、1になることを検証する。
        assert_eq!(compute_eased_scroll_offset(0, 1, 0.5), 1);
    }

    #[test]
    fn compute_eased_scroll_offset_start_equals_target_is_constant_regardless_of_progress() {
        for progress in [0.0, 0.25, 0.5, 0.75, 1.0] {
            assert_eq!(compute_eased_scroll_offset(7, 7, progress), 7);
        }
    }
}
