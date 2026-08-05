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
}
