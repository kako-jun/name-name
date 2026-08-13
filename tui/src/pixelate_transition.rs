//! イベント絵ピクセレート遷移 (#583) の進行度→値 純粋計算。
//!
//! GUI版（`frontend/src/game/pixelateTransition.ts` + `EventImageLayer.ts` の `PixelateFilter`）
//! と同じ「表示中の絵のドットを段階的に荒くする(コルセン)→切り替える→段階的に細かく戻す
//! (リファイン)」演出を、TUI版は `image_render::rgba_to_quadrant_grid_pixelated` に渡す
//! ダウンサンプル解像度の「粗さの分母 (divisor)」で表現する。GUI 側は PixiJS
//! `PixelateFilter.size`（画面px単位のブロックサイズ、大きいほど粗い）を直接動かせるが、
//! TUI はもともと quadrant block 変換の前段でボックスダウンサンプルしているため、
//! 意図的にターゲット解像度を小さくしてから最近傍で戻す方式を取る（Issue #583 本文の設計）。
//! パラメータの単位は異なるが「1=通常表示、大きいほど粗い」という向きは共通にしている。
//!
//! GUI版と異なりTUI側の画像デコード（`image_render::load_image_rgba`）は同期処理で
//! ネットワーク遅延が無いため、GUI版の `holding`（ロード待ち）フェーズに相当する状態は
//! 不要 — `image_fade::ImageFadeState::progress` が返す 0.0〜1.0 の進行度 `t` から
//! そのまま divisor を計算できる決定論的な純粋関数だけで完結する。
//!
//! 配分の根拠: GUI版と同じ [`PIXELATE_TRANSITION_SWAP_RATIO`]（既定 50%）で前半をコルセン、
//! 後半をリファインに均等配分する。境界地点（`t == swap_ratio`）で画像を切り替えるのは
//! `image_fade::blend` が既に採用している「中間点で glyph をハード切替する」設計と対称的な
//! 「中間点でスワップ」に揃えるため（GUI/TUI の見た目のリズムを合わせる、GUI側 doc comment と
//! 同じ根拠）。

/// ダウンサンプル解像度の分母の最大値（最も粗い状態）。実装者裁量の moderate 値
/// （`sub_w`/`sub_h` をこの値で割った解像度まで意図的に粗くする）。
pub const PIXELATE_TRANSITION_MAX_DIVISOR: u32 = 8;

/// 遷移全体の進行度のうち、コルセン（切替前半）に配分する割合。
pub const PIXELATE_TRANSITION_SWAP_RATIO: f32 = 0.5;

/// 遷移全体の進行度 `t`（0.0=開始, 1.0=完了、`ImageFadeState::progress` と同じ意味）から、
/// その瞬間 `image_render::rgba_to_quadrant_grid_pixelated` に渡すべき分母を返す。
/// `t < swap_ratio` はコルセン中（1→max_divisor へ粗くする）、`t >= swap_ratio` はリファイン中
/// （max_divisor→1 へ細かく戻す）として扱う。
///
/// 入力契約: `t`/`swap_ratio` は `[0.0, 1.0]` 外の値が渡っても内部で clamp する（呼び出し側の
/// `progress()` は既に clamp 済みだが、この関数単体でも安全に呼べるようにする防御）。
/// `max_divisor` は 1 未満を渡しても 1 として扱う（1=常に通常表示、粗さなし）。
pub fn compute_divisor(t: f32, swap_ratio: f32, max_divisor: u32) -> u32 {
    let t = t.clamp(0.0, 1.0);
    let ratio = swap_ratio.clamp(0.0, 1.0);
    let max = (max_divisor.max(1)) as f32;

    if t < ratio {
        // コルセン: 1 → max_divisor へ線形。
        let phase_t = if ratio <= 0.0 { 1.0 } else { t / ratio };
        (1.0 + phase_t * (max - 1.0)).round().clamp(1.0, max) as u32
    } else {
        // リファイン: max_divisor → 1 へ線形。
        let remaining = (1.0 - ratio).max(f32::EPSILON);
        let phase_t = ((t - ratio) / remaining).clamp(0.0, 1.0);
        (max - phase_t * (max - 1.0)).round().clamp(1.0, max) as u32
    }
}

/// 遷移全体の進行度 `t` がコルセンフェーズ（表示中の旧画像を粗くしている最中）かどうかを返す。
/// `false` はリファインフェーズ（スワップ後の新画像を細かく戻している最中）を意味する。
pub fn is_coarsen_phase(t: f32, swap_ratio: f32) -> bool {
    t.clamp(0.0, 1.0) < swap_ratio.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_divisor_at_t_zero_is_one() {
        assert_eq!(compute_divisor(0.0, 0.5, 8), 1);
    }

    #[test]
    fn compute_divisor_at_swap_boundary_is_max() {
        // t == swap_ratio はコルセン側の境界値（is_coarsen_phase は false を返す＝リファイン側）
        // だが、コルセン完了直後の値として max_divisor になるはず（リファイン側 phase_t=0 も
        // max を返すため、境界で値が連続している）。
        assert_eq!(compute_divisor(0.5, 0.5, 8), 8);
    }

    #[test]
    fn compute_divisor_at_t_one_is_one() {
        assert_eq!(compute_divisor(1.0, 0.5, 8), 1);
    }

    #[test]
    fn compute_divisor_is_monotonic_increasing_during_coarsen() {
        let a = compute_divisor(0.1, 0.5, 8);
        let b = compute_divisor(0.3, 0.5, 8);
        let c = compute_divisor(0.49, 0.5, 8);
        assert!(a <= b, "コルセン中は単調増加のはず: {a} <= {b}");
        assert!(b <= c, "コルセン中は単調増加のはず: {b} <= {c}");
    }

    #[test]
    fn compute_divisor_is_monotonic_decreasing_during_refine() {
        let a = compute_divisor(0.51, 0.5, 8);
        let b = compute_divisor(0.7, 0.5, 8);
        let c = compute_divisor(0.99, 0.5, 8);
        assert!(a >= b, "リファイン中は単調減少のはず: {a} >= {b}");
        assert!(b >= c, "リファイン中は単調減少のはず: {b} >= {c}");
    }

    #[test]
    fn compute_divisor_out_of_range_t_is_clamped() {
        assert_eq!(compute_divisor(-1.0, 0.5, 8), compute_divisor(0.0, 0.5, 8));
        assert_eq!(compute_divisor(2.0, 0.5, 8), compute_divisor(1.0, 0.5, 8));
    }

    #[test]
    fn compute_divisor_max_divisor_below_one_is_treated_as_one() {
        assert_eq!(compute_divisor(0.25, 0.5, 0), 1);
    }

    #[test]
    fn is_coarsen_phase_before_swap_ratio_is_true() {
        assert!(is_coarsen_phase(0.1, 0.5));
        assert!(!is_coarsen_phase(0.5, 0.5));
        assert!(!is_coarsen_phase(0.9, 0.5));
    }

    #[test]
    fn compute_divisor_swap_ratio_zero_is_always_refine() {
        // 観点C-1: swap_ratio=0.0 は「コルセン区間の幅が0」＝t=0直後から常にリファイン側
        // (`t < ratio` は t>=0 の限り常に偽)。t=0でもリファインのphase_t計算式
        // ((t-0)/(1-0))=0 となり max を返す（リファイン開始点＝最も粗い状態から始まる）。
        assert_eq!(compute_divisor(0.0, 0.0, 8), 8);
        assert_eq!(compute_divisor(0.5, 0.0, 8), 5); // 8-0.5*7=4.5→round→5
        assert_eq!(compute_divisor(1.0, 0.0, 8), 1);
    }

    #[test]
    fn compute_divisor_swap_ratio_one_is_always_coarsen() {
        // 観点C-1: swap_ratio=1.0 は「リファイン区間の幅が0」＝t=1未満は常にコルセン側
        // (`t < ratio` は t<1.0 の限り常に真)。
        assert_eq!(compute_divisor(0.0, 1.0, 8), 1);
        assert_eq!(compute_divisor(0.5, 1.0, 8), 5); // 1+0.5*7=4.5→round→5
                                                     // t=1.0はコルセン条件 `t < ratio`(1.0 < 1.0)が偽になりリファイン側に落ちるが、
                                                     // リファイン残り幅が(1.0-1.0).max(EPSILON)による極小値のため即座に max 相当になる。
        assert_eq!(compute_divisor(1.0, 1.0, 8), 8);
    }

    #[test]
    fn is_coarsen_phase_boundary_just_below_at_and_above_swap_ratio() {
        // 観点C-2: t=0.499/0.5/0.501 の3点で is_coarsen_phase の境界を確認する
        // （swap_ratio=0.5固定、`t < ratio` の厳密な不等号を直接縛る）。
        assert!(
            is_coarsen_phase(0.499, 0.5),
            "境界-1(0.499)はコルセン側のはず"
        );
        assert!(
            !is_coarsen_phase(0.5, 0.5),
            "境界ちょうど(0.5)は厳密な `<` によりリファイン側のはず"
        );
        assert!(
            !is_coarsen_phase(0.501, 0.5),
            "境界+1(0.501)はリファイン側のはず"
        );
    }
}
