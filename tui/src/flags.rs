//! GUI版（`frontend/src/game/GameState.ts`）と同じ「遅延評価」モデルのフラグ状態を持つ
//! 構造体（#509 Phase A）。
//!
//! 実際の評価タイミングは `build_scene_items`（`tui/src/playback.rs`）が、シーン内の
//! イベント列を逐次 walk しながら `Event::Flag`/`Event::Condition` に遭遇するたびに
//! リアルタイムで行う（この構造体を都度参照・更新する）。

use std::collections::HashMap;

use name_name_parser::models::FlagValue;

/// プレイ経路上で立てたフラグの集合。
///
/// GUI版 `GameState.flags: Map<string, FlagValue>` に対応する。
#[derive(Debug, Clone, Default)]
pub struct GameFlags {
    values: HashMap<String, FlagValue>,
    /// `set()` が呼ばれるたびに単調増加するカウンタ。値そのものの比較（`HashMap` の
    /// `PartialEq` は要素順序に依存しないため本来は使えるが、意図をより明確にするため）
    /// ではなく、この世代番号の比較で「フラグ状態が前回から変わったか」を安価に判定できる
    /// ようにする。`Playback::total()` のキャッシュ無効化に使う（セルフレビュー対応、#509）。
    generation: u64,
}

impl GameFlags {
    pub fn new() -> Self {
        Self::default()
    }

    /// フラグを設定する（`[フラグ: name = value]` の実行時に呼ばれる想定）。
    pub fn set(&mut self, name: impl Into<String>, value: FlagValue) {
        self.values.insert(name.into(), value);
        self.generation += 1;
    }

    /// 現在の世代番号。`set()` が呼ばれるたびに増える。同じ値であれば `set()` は一度も
    /// 呼ばれていない（＝フラグ状態が変わっていない）ことの安価な証明として使える。
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// フラグの真偽を判定する。GUI版 `checkFlag` と同じセマンティクス:
    /// - 未設定 → false
    /// - `Bool(b)` → b の値そのまま
    /// - `String` / `Number` → 値の中身に関わらず「存在すれば true」
    pub fn check(&self, name: &str) -> bool {
        match self.values.get(name) {
            None => false,
            Some(FlagValue::Bool(b)) => *b,
            Some(FlagValue::String(_)) | Some(FlagValue::Number(_)) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_false_is_distinct_from_unset() {
        let mut flags = GameFlags::new();
        flags.set("seen_intro", FlagValue::Bool(false));

        // 明示的な false は「未設定」と同じく check() は false を返すが、
        // 値としては区別して保持されている（get すれば Some(Bool(false))）ことを確認する。
        assert!(!flags.check("seen_intro"));
        assert_eq!(
            flags.values.get("seen_intro"),
            Some(&FlagValue::Bool(false))
        );
        assert!(!flags.check("never_set"));
        assert_eq!(flags.values.get("never_set"), None);
    }

    #[test]
    fn string_and_number_flags_are_truthy_if_present() {
        let mut flags = GameFlags::new();
        flags.set("name", FlagValue::String("kako".to_string()));
        flags.set("count", FlagValue::Number(0.0));

        // Number(0.0) even though falsy in JS-numeric-sense, GUI版のセマンティクスでは
        // 「存在すれば true」なので true になる。
        assert!(flags.check("name"));
        assert!(flags.check("count"));
    }
}
