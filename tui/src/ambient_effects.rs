//! イベント絵アンビエント演出 (#582) の RGBA ピクセル変換。
//!
//! GUI版（`frontend/src/game/ambientEffects.ts` + `EventImageLayer.ts` の PixiJS フィルタ
//! チェーン）と同じ4効果（ゆらぎ/ビネット/グロー/ろうそく揺れ）を、TUI版は
//! `image_render::rgba_to_quadrant_grid`（quadrant block 変換）に渡す前段で、デコード済み
//! RGBA バッファへ直接ピクセル変換として適用することで実現する。GUI側のシェーダーと数式は
//! 共有できないが、効果の「意味」は共有する（#582 Issue 本文の要件）。
//!
//! ゆらぎ・ろうそく揺れは時間経過で変化する。TUI のレンダーループは `REDRAW`（`main.rs`,
//! 30ms）間隔でキー入力の有無に関わらず再描画するため、呼び出し側が毎フレーム新しい
//! `elapsed_ms` でこのモジュールの関数を呼び直すだけで自然にアニメーションする
//! （専用の tick 駆動インフラを新設する必要はない）。

use std::sync::OnceLock;
use std::time::Instant;

use name_name_parser::models::AmbientEffects;

/// プロセス起動後、最初にこのモジュールが使われた時点を基準時刻とする（`Instant` は絶対時刻を
/// 持たず差分でしか比較できないため）。`elapsed_ms_since_epoch`専用、他のモジュールの
/// `Instant`（`reveal::RevealState`/`image_fade::ImageFadeState` 等の起点）とは無関係。
static EPOCH: OnceLock<Instant> = OnceLock::new();

/// `now` から、このモジュールの基準時刻を起点とした経過ミリ秒を返す。
/// `apply_ambient_effects` の `elapsed_ms` を呼び出し側（`image_fade.rs`）が組み立てるための
/// ヘルパー。決定論的な `elapsed_ms` そのものを扱う `apply_ambient_effects` 側は純粋関数のまま
/// 保ち、実時計に触れる副作用をここに閉じ込める（`screenEffects.ts`/`ambientEffects.ts` の
/// 「計算は純粋・時刻取得は呼び出し側」という GUI 版の役割分担と同じ考え方）。
pub fn elapsed_ms_since_epoch(now: Instant) -> u64 {
    let epoch = *EPOCH.get_or_init(Instant::now);
    now.saturating_duration_since(epoch).as_millis() as u64
}

/// ろうそく揺れのステップ間隔 (ms)。GUI版 `ambientEffects.ts::CANDLE_STEP_MS` と同じ値。
const CANDLE_STEP_MS: u64 = 120;
/// グロー（自身を blur して overlay 合成）の合成強度。#316 で確定した「45%dissolve程度」。
const GLOW_OPACITY: f32 = 0.45;
/// グローのボックスブラー半径（px）。quadrant block 変換前の原寸画像に対する値のため、
/// GUI版の `KawaseBlurFilter` の `strength: 20`（スクリーン全体基準）とは尺度が異なる
/// （TUI 側は主に 128x128 程度の小さい画像を想定した控えめな値、#582 MVP スコープ）。
const GLOW_BLUR_RADIUS: i32 = 2;
/// ビネットの減光強度（0=無効、1=縁が真っ黒）。GUI版 `VignetteFilter`（`frontend/src/game/
/// VignetteFilter.ts`）の既定 `intensity`（0.55）に近い値だが、完全一致ではない
/// （TUI 側は quadrant block の粗い解像度向けに独自に調整した値、#582）。
const VIGNETTE_INTENSITY: f32 = 0.6;

/// 4効果すべてを `elapsed_ms` 時点の見た目で RGBA バッファへ適用した新しいバッファを返す。
///
/// 適用順: ゆらぎ（再サンプリング）→ ビネット（周辺減光+暗部沈み）→ グロー（ぼかし+overlay合成）
/// → ろうそく（明度/色温度の周期変調）。どのフラグも false なら何もせず `pixels` を複製して返す
/// （呼び出し側の分岐を減らすため、常に新しい `Vec<u8>` を返す設計）。
///
/// `pixels` は `img_w * img_h * 4` の RGBA バッファを前提とする（`image_render::crop_rgba` /
/// `downsample_box` と同じ契約）。長さが不足する、または `img_w`/`img_h` が 0 の場合は
/// 変換をスキップしてそのまま複製を返す（panic しない。`rgba_to_quadrant_grid` 自身が持つ
/// `rgba_buffer_has_expected_len` チェックと同じ防御方針）。
pub fn apply_ambient_effects(
    pixels: &[u8],
    img_w: u32,
    img_h: u32,
    effects: AmbientEffects,
    elapsed_ms: u64,
) -> Vec<u8> {
    let expected_len = (img_w as usize)
        .saturating_mul(img_h as usize)
        .saturating_mul(4);
    if img_w == 0 || img_h == 0 || pixels.len() < expected_len {
        return pixels.to_vec();
    }
    if !effects.wobble && !effects.vignette && !effects.glow && !effects.candle {
        return pixels.to_vec();
    }

    let mut buf = if effects.wobble {
        apply_wobble(pixels, img_w, img_h, elapsed_ms)
    } else {
        pixels.to_vec()
    };
    if effects.vignette {
        apply_vignette(&mut buf, img_w, img_h);
    }
    if effects.glow {
        buf = apply_glow(&buf, img_w, img_h);
    }
    if effects.candle {
        apply_candle(&mut buf, elapsed_ms);
    }
    buf
}

/// ゆらぎ。行ごとに正弦波でずらした水平方向の再サンプリングで近似する（GUI版の
/// `DisplacementFilter` の2D ノイズマップとは異なる簡略化。quadrant block の粗い解像度では
/// 2D ノイズの細部はどのみち視認できないため、行単位の「ヒートヘイズ」的な安価な近似で十分と
/// 判断した、#582）。振幅は画像幅に比例させつつ極端に荒れないようクランプする。
fn apply_wobble(pixels: &[u8], img_w: u32, img_h: u32, elapsed_ms: u64) -> Vec<u8> {
    let w = img_w as i64;
    let h = img_h as usize;
    let stride = img_w as usize * 4;
    let mut out = vec![0u8; pixels.len()];
    let t = elapsed_ms as f32;
    let amplitude = (img_w as f32 * 0.015).clamp(0.6, 3.5);
    for y in 0..h {
        let phase = (y as f32) * 0.35 + t * 0.0022;
        let shift = (phase.sin() * amplitude).round() as i64;
        let row_start = y * stride;
        for x in 0..w {
            let src_x = (x - shift).clamp(0, w - 1) as usize;
            let src_idx = row_start + src_x * 4;
            let dst_idx = row_start + (x as usize) * 4;
            out[dst_idx..dst_idx + 4].copy_from_slice(&pixels[src_idx..src_idx + 4]);
        }
    }
    out
}

/// ビネット。中心からの距離に応じて RGB を減光し、暗部側をさらに僅かに沈める
/// （Issue #582 の TUI 技法一覧「暗部沈み・周辺減光」に対応。GUI版 `VignetteFilter` と同じ
/// `smoothstep` ベースの減光カーブ）。アルファは変更しない。
fn apply_vignette(pixels: &mut [u8], img_w: u32, img_h: u32) {
    let w = img_w as f32;
    let h = img_h as f32;
    let cx = w / 2.0;
    let cy = h / 2.0;
    let max_dist = (cx * cx + cy * cy).sqrt().max(1.0);
    for y in 0..img_h {
        for x in 0..img_w {
            let idx = ((y * img_w + x) * 4) as usize;
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt() / max_dist;
            let vig = smoothstep(0.35, 0.95, dist);
            let factor = 1.0 - vig * VIGNETTE_INTENSITY;
            for c in 0..3 {
                let v = pixels[idx + c] as f32 * factor;
                // 暗部沈み: 低輝度側をさらに少し潰し、コントラストを僅かに強める。
                let crushed = if v < 70.0 { v * 0.82 } else { v };
                pixels[idx + c] = crushed.clamp(0.0, 255.0) as u8;
            }
        }
    }
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// グロー/ブルーム。自身をぼかし（ボックスブラー）、Photoshop の Overlay 合成式で
/// `GLOW_OPACITY` の強度だけ重ねる（#316 で確定した「自身を blur して overlay 合成」技法を
/// GUI版と同じ考え方で TUI 向けに実装したもの。明るい点を光らせる用途ではなく、べた塗りの
/// 平坦な領域の境界をグラデーションに見せることが目的。暖色 tint は使わない）。
///
/// 性能メモ: 画素数に比例するボックスブラーのため、Gymnasia の 128x128 マスター程度の
/// サイズを主眼にした MVP スコープの実装（#582）。将来大きな画像でグローを多用する場合は
/// スライディングウィンドウ方式への最適化を検討する。
fn apply_glow(pixels: &[u8], img_w: u32, img_h: u32) -> Vec<u8> {
    let blurred = box_blur(pixels, img_w, img_h, GLOW_BLUR_RADIUS);
    let mut out = vec![0u8; pixels.len()];
    for i in (0..pixels.len()).step_by(4) {
        for c in 0..3 {
            let base = pixels[i + c] as f32 / 255.0;
            let blend = blurred[i + c] as f32 / 255.0;
            let overlay = if base < 0.5 {
                2.0 * base * blend
            } else {
                1.0 - 2.0 * (1.0 - base) * (1.0 - blend)
            };
            let mixed = base + (overlay - base) * GLOW_OPACITY;
            out[i + c] = (mixed * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        out[i + 3] = pixels[i + 3];
    }
    out
}

/// 水平→垂直の2パス分離ボックスブラー。端は clamp（画像端の色を延長）。
fn box_blur(pixels: &[u8], img_w: u32, img_h: u32, radius: i32) -> Vec<u8> {
    let w = img_w as i64;
    let h = img_h as i64;

    let mut horiz = vec![0u8; pixels.len()];
    for y in 0..h {
        for x in 0..w {
            let mut sum = [0u32; 4];
            let mut count = 0u32;
            for dx in -radius..=radius {
                let sx = (x + dx as i64).clamp(0, w - 1);
                let idx = ((y * w + sx) * 4) as usize;
                for (c, s) in sum.iter_mut().enumerate() {
                    *s += pixels[idx + c] as u32;
                }
                count += 1;
            }
            let idx = ((y * w + x) * 4) as usize;
            for (c, s) in sum.iter().enumerate() {
                horiz[idx + c] = (*s / count) as u8;
            }
        }
    }

    let mut out = vec![0u8; pixels.len()];
    for y in 0..h {
        for x in 0..w {
            let mut sum = [0u32; 4];
            let mut count = 0u32;
            for dy in -radius..=radius {
                let sy = (y + dy as i64).clamp(0, h - 1);
                let idx = ((sy * w + x) * 4) as usize;
                for (c, s) in sum.iter_mut().enumerate() {
                    *s += horiz[idx + c] as u32;
                }
                count += 1;
            }
            let idx = ((y * w + x) * 4) as usize;
            for (c, s) in sum.iter().enumerate() {
                out[idx + c] = (*s / count) as u8;
            }
        }
    }
    out
}

/// ろうそく光の数コマ揺れ。`elapsed_ms` を `CANDLE_STEP_MS` 単位で量子化してから決定論的な
/// 疑似乱数を引く（段階的な揺れ。伝統的なコマ撮りアニメのように一定時間ごとに値が飛ぶ、
/// GUI版 `ambientEffects.ts::computeCandleFlicker` と同じ設計）。明度を `[0.86, 1.0]` で
/// 揺らしつつ、明るいときほど僅かに暖色（R強め/B弱め）にする周期的な色温度変調も行う
/// （Issue #582 の TUI 技法一覧「明度/色温度の周期変調」に対応。GUI版は明度のみでこちらは
/// 色温度も持つ非対称仕様 — TUI はテキストのアルファ効果を持たずピクセル値が最終出力その
/// ものであるため、暗闇+オレンジ色のろうそく光というルックをより直接的に担わせている）。
fn apply_candle(pixels: &mut [u8], elapsed_ms: u64) {
    let step = elapsed_ms / CANDLE_STEP_MS;
    let r = pseudo_random(step.wrapping_add(1));
    let brightness = 0.86 + r * 0.14;
    // brightness の揺れと連動させ、明るいときほど暖色寄りにする（0..1 に正規化してから ±0.06）。
    let bt = ((brightness - 0.86) / 0.14).clamp(0.0, 1.0);
    let warm = 1.0 + (bt - 0.5) * 0.12;
    let cool = 1.0 - (bt - 0.5) * 0.10;
    for i in (0..pixels.len()).step_by(4) {
        let r = pixels[i] as f32 * brightness * warm;
        let g = pixels[i + 1] as f32 * brightness;
        let b = pixels[i + 2] as f32 * brightness * cool;
        pixels[i] = r.clamp(0.0, 255.0) as u8;
        pixels[i + 1] = g.clamp(0.0, 255.0) as u8;
        pixels[i + 2] = b.clamp(0.0, 255.0) as u8;
    }
}

/// splitmix64 ベースの決定論的ハッシュ。`seed` から `[0.0, 1.0)` の疑似乱数を1つ得る
/// （GUI版 `ambientEffects.ts::mulberry32` と同じ役割 — ステップ量子化した経過時間から
/// 再現可能な揺れ値を作る、#582）。
fn pseudo_random(seed: u64) -> f32 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z >> 40) as f32 / (1u32 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_rgba(color: (u8, u8, u8, u8), w: u32, h: u32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            buf.extend_from_slice(&[color.0, color.1, color.2, color.3]);
        }
        buf
    }

    fn no_effects() -> AmbientEffects {
        AmbientEffects::default()
    }

    #[test]
    fn all_flags_false_returns_pixels_unchanged() {
        let pixels = solid_rgba((10, 20, 30, 255), 4, 4);
        let out = apply_ambient_effects(&pixels, 4, 4, no_effects(), 0);
        assert_eq!(out, pixels);
    }

    #[test]
    fn short_buffer_is_returned_unchanged_without_panicking() {
        let pixels = vec![1, 2, 3];
        let effects = AmbientEffects {
            wobble: true,
            vignette: true,
            glow: true,
            candle: true,
        };
        let out = apply_ambient_effects(&pixels, 10, 10, effects, 0);
        assert_eq!(out, pixels);
    }

    #[test]
    fn zero_size_image_is_returned_unchanged_without_panicking() {
        let effects = AmbientEffects {
            wobble: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&[], 0, 0, effects, 0);
        assert!(out.is_empty());
    }

    #[test]
    fn vignette_darkens_corner_more_than_center_on_uniform_image() {
        let pixels = solid_rgba((200, 200, 200, 255), 21, 21);
        let effects = AmbientEffects {
            vignette: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&pixels, 21, 21, effects, 0);
        let center_idx = ((10 * 21 + 10) * 4) as usize;
        let corner_idx = 0usize;
        assert!(
            out[corner_idx] < out[center_idx],
            "corner ({}) should be darker than center ({})",
            out[corner_idx],
            out[center_idx]
        );
        // 中心は減光ゼロ域（innerRadius 内）のはずなので不変。
        assert_eq!(out[center_idx], 200);
    }

    #[test]
    fn vignette_preserves_alpha() {
        let pixels = solid_rgba((200, 200, 200, 128), 10, 10);
        let effects = AmbientEffects {
            vignette: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&pixels, 10, 10, effects, 0);
        for chunk in out.chunks_exact(4) {
            assert_eq!(chunk[3], 128);
        }
    }

    #[test]
    fn glow_on_flat_uniform_color_stays_uniform() {
        // ボックスブラーは定数画像に対して定数を返すため、overlay合成（自身との自己合成）後も
        // 全ピクセルが同一の値になる（値そのものは overlay のコントラスト強調で変わりうるが、
        // 境界の無い平坦領域にムラ・アーティファクトを持ち込まないことが重要 — NOTES.md の
        // 意図どおり「境界にグラデーションを作る」技法であり、平坦領域を荒らす技法ではない）。
        let pixels = solid_rgba((150, 90, 40, 255), 12, 12);
        let effects = AmbientEffects {
            glow: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&pixels, 12, 12, effects, 0);
        let first: Vec<u8> = out[0..4].to_vec();
        for chunk in out.chunks_exact(4) {
            assert_eq!(chunk, first.as_slice());
        }
    }

    #[test]
    fn candle_flicker_is_deterministic_for_same_elapsed_ms() {
        let pixels = solid_rgba((180, 120, 60, 255), 5, 5);
        let effects = AmbientEffects {
            candle: true,
            ..AmbientEffects::default()
        };
        let out1 = apply_ambient_effects(&pixels, 5, 5, effects, 5000);
        let out2 = apply_ambient_effects(&pixels, 5, 5, effects, 5000);
        assert_eq!(out1, out2);
    }

    #[test]
    fn candle_flicker_changes_across_steps() {
        let pixels = solid_rgba((180, 120, 60, 255), 5, 5);
        let effects = AmbientEffects {
            candle: true,
            ..AmbientEffects::default()
        };
        let out_a = apply_ambient_effects(&pixels, 5, 5, effects, 0);
        let out_b = apply_ambient_effects(&pixels, 5, 5, effects, CANDLE_STEP_MS * 10);
        assert_ne!(out_a, out_b, "十分離れたステップでは揺れ値が変わるはず");
    }

    #[test]
    fn wobble_does_not_change_buffer_length_or_alpha() {
        let pixels = solid_rgba((10, 20, 30, 200), 16, 8);
        let effects = AmbientEffects {
            wobble: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&pixels, 16, 8, effects, 12345);
        assert_eq!(out.len(), pixels.len());
        for chunk in out.chunks_exact(4) {
            assert_eq!(chunk[3], 200);
        }
    }

    #[test]
    fn candle_flicker_step_boundary_at_119_120_121ms() {
        // ろうそく揺れは `elapsed_ms / CANDLE_STEP_MS(120)` の切り捨てで step を決める。
        // 境界-1/境界/境界+1 の3点(119/120/121ms)で、119→120(step 0→1)で出力が変化し、
        // 120→121(どちらも step=1)は変化しないことを明示ロックする。
        let pixels = solid_rgba((180, 120, 60, 255), 4, 4);
        let effects = AmbientEffects {
            candle: true,
            ..AmbientEffects::default()
        };
        let out_119 = apply_ambient_effects(&pixels, 4, 4, effects, 119);
        let out_120 = apply_ambient_effects(&pixels, 4, 4, effects, 120);
        let out_121 = apply_ambient_effects(&pixels, 4, 4, effects, 121);
        assert_ne!(
            out_119, out_120,
            "119ms(step=0)→120ms(step=1)でstepが変わり出力が変化するはず"
        );
        assert_eq!(
            out_120, out_121,
            "120ms→121msは同じstep=1のため出力は変化しないはず"
        );
    }

    #[test]
    fn vignette_dark_crush_threshold_69_70_71_boundary() {
        // apply_vignette の暗部沈み込み分岐 `v < 70.0` の境界を、`<` と `<=` の取り違えを
        // 狙い撃って直接ロックする。21x21画像の中心ピクセル(10,10)は dist=0 → factor=1.0
        // なので入力値がそのまま v になり、境界-1/境界/境界+1(69/70/71)を正確に制御できる。
        let effects = AmbientEffects {
            vignette: true,
            ..AmbientEffects::default()
        };
        let center_idx = ((10 * 21 + 10) * 4) as usize;

        let pixels_69 = solid_rgba((69, 69, 69, 255), 21, 21);
        let out_69 = apply_ambient_effects(&pixels_69, 21, 21, effects, 0);
        assert_eq!(
            out_69[center_idx], 56,
            "69 < 70 → crushされる: (69*0.82).trunc() = 56"
        );

        let pixels_70 = solid_rgba((70, 70, 70, 255), 21, 21);
        let out_70 = apply_ambient_effects(&pixels_70, 21, 21, effects, 0);
        assert_eq!(
            out_70[center_idx], 70,
            "70は境界そのもの。`< 70.0` ではないのでcrushされない(`<=`との取り違えを検知)"
        );

        let pixels_71 = solid_rgba((71, 71, 71, 255), 21, 21);
        let out_71 = apply_ambient_effects(&pixels_71, 21, 21, effects, 0);
        assert_eq!(out_71[center_idx], 71, "71 >= 70 → crushされない");
    }

    #[test]
    fn wobble_shifts_pixels_on_non_uniform_diagonal_pattern() {
        // 既存の `wobble_does_not_change_buffer_length_or_alpha` は単色画像を使っており、
        // apply_wobble が恒等関数(何もしない実装)に壊れても検知できない死角があった。
        // 列ごとに値が変わるグラデーション画像を使い、実際に行ごとの水平方向の再サンプリングが
        // 起きていることを直接検証する。
        let img_w = 32u32;
        let img_h = 8u32;
        let mut pixels = vec![0u8; (img_w * img_h * 4) as usize];
        for y in 0..img_h {
            for x in 0..img_w {
                let idx = ((y * img_w + x) * 4) as usize;
                let v = (x * 8) as u8;
                pixels[idx] = v;
                pixels[idx + 1] = v;
                pixels[idx + 2] = v;
                pixels[idx + 3] = 255;
            }
        }
        let effects = AmbientEffects {
            wobble: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&pixels, img_w, img_h, effects, 700);

        let row_differs = (0..img_h as usize).any(|y| {
            let start = y * img_w as usize * 4;
            let end = start + img_w as usize * 4;
            out[start..end] != pixels[start..end]
        });
        assert!(
            row_differs,
            "少なくとも1行は実際に水平シフトして元画像と異なるはず(恒等関数だと全行一致してしまう)"
        );
    }

    #[test]
    fn glow_actually_changes_pixel_values_from_input() {
        // 既存の `glow_on_flat_uniform_color_stays_uniform` は「一様性の維持」だけを見ており、
        // 恒等関数でも通ってしまう死角があった。ここでは明確なエッジ(左右で色が違う)を持つ
        // 画像を使い、glow適用後に実際に入力から値が変化していることを明示的にアサートする。
        let mut pixels = vec![0u8; (8 * 8 * 4) as usize];
        for y in 0..8u32 {
            for x in 0..8u32 {
                let idx = ((y * 8 + x) * 4) as usize;
                let v = if x < 4 { 20u8 } else { 220u8 };
                pixels[idx] = v;
                pixels[idx + 1] = v;
                pixels[idx + 2] = v;
                pixels[idx + 3] = 255;
            }
        }
        let effects = AmbientEffects {
            glow: true,
            ..AmbientEffects::default()
        };
        let out = apply_ambient_effects(&pixels, 8, 8, effects, 0);
        assert_ne!(
            out, pixels,
            "エッジ付近はぼかし+overlay合成で実際に値が変化するはず"
        );
    }

    #[test]
    fn combined_effect_flags_preserve_buffer_length_without_panicking() {
        // 4フラグのうち2〜3個を有効にした代表的な組み合わせ(glow+candle, wobble+vignette,
        // wobble+vignette+glow)で、通常サイズ画像でも長さ不変・panicしないことを確認する
        // (単体テストは各フラグ単独が中心で、組み合わせ経路の検証が抜けていた)。
        let pixels = solid_rgba((120, 90, 60, 255), 64, 64);
        let combos = [
            AmbientEffects {
                glow: true,
                candle: true,
                ..AmbientEffects::default()
            },
            AmbientEffects {
                wobble: true,
                vignette: true,
                ..AmbientEffects::default()
            },
            AmbientEffects {
                wobble: true,
                vignette: true,
                glow: true,
                ..AmbientEffects::default()
            },
        ];
        for effects in combos {
            let out = apply_ambient_effects(&pixels, 64, 64, effects, 4200);
            assert_eq!(
                out.len(),
                pixels.len(),
                "combo {effects:?} で長さが変わってはいけない"
            );
        }
    }
}
