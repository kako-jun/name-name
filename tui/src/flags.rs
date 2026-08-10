//! GUI版（`frontend/src/game/GameState.ts`）と同じ「遅延評価」モデルのフラグ管理と
//! 条件イベント展開の純粋関数（#509 Phase A）。
//!
//! ここで定義するのは「フラグ状態を持つ構造体」と「イベント列を現在のフラグ状態で
//! 再解決する純粋関数」だけで、`Playback::build()` の eager flatten 方式（`items` /
//! `scene_start` 等）には一切触れない。呼び出し側の配線（実行順に沿った再解決タイミング）
//! は別タスク（Phase B）で行う。
//!
//! Phase A の時点ではまだどこからも呼ばれないため、`#![allow(dead_code)]` で未使用警告を
//! 抑止している。Phase B で `Playback` 側から配線されたらこの allow は外すこと。
#![allow(dead_code)]

use std::collections::HashMap;

use name_name_parser::models::{Event, FlagValue};

/// プレイ経路上で立てたフラグの集合。
///
/// GUI版 `GameState.flags: Map<string, FlagValue>` に対応する。
#[derive(Debug, Clone, Default)]
pub struct GameFlags {
    values: HashMap<String, FlagValue>,
}

impl GameFlags {
    pub fn new() -> Self {
        Self::default()
    }

    /// フラグを設定する（`[フラグ: name = value]` の実行時に呼ばれる想定）。
    pub fn set(&mut self, name: impl Into<String>, value: FlagValue) {
        self.values.insert(name.into(), value);
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

/// イベント列を現在のフラグ状態で再解決する純粋関数。
///
/// GUI版 `resolveEvents` と同じロジック:
/// - `Event::Condition { flag, events }` を見つけたら `flags.check(flag)` で判定し、
///   真なら内部 `events` を再帰的に `resolve_events` して結果に展開する。偽ならスキップする。
/// - `Event::Flag` を含む他のイベントはそのまま透過する（副作用の適用は呼び出し側の責務。
///   この関数はあくまで条件分岐の展開のみを行う）。
///
/// 呼ばれた瞬間の `flags` でのみ評価し、結果をキャッシュしない（GUI版と同じく、シーンに
/// 入るたび・Flag イベント処理直後に都度呼び直す想定）。
pub fn resolve_events(events: &[Event], flags: &GameFlags) -> Vec<Event> {
    let mut result = Vec::with_capacity(events.len());
    for event in events {
        match event {
            Event::Condition {
                flag,
                events: inner,
            } => {
                if flags.check(flag) {
                    result.extend(resolve_events(inner, flags));
                }
            }
            other => result.push(other.clone()),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dialog(text: &str) -> Event {
        Event::Flag {
            name: format!("marker:{text}"),
            value: FlagValue::Bool(true),
        }
    }

    #[test]
    fn condition_not_expanded_when_flag_unset() {
        let flags = GameFlags::new();
        let events = vec![Event::Condition {
            flag: "seen_intro".to_string(),
            events: vec![dialog("hidden")],
        }];

        let resolved = resolve_events(&events, &flags);

        assert!(resolved.is_empty());
    }

    #[test]
    fn condition_expanded_when_flag_true() {
        let mut flags = GameFlags::new();
        flags.set("seen_intro", FlagValue::Bool(true));
        let events = vec![Event::Condition {
            flag: "seen_intro".to_string(),
            events: vec![dialog("shown")],
        }];

        let resolved = resolve_events(&events, &flags);

        assert_eq!(resolved, vec![dialog("shown")]);
    }

    #[test]
    fn nested_conditions_resolve_recursively() {
        let mut flags = GameFlags::new();
        flags.set("outer", FlagValue::Bool(true));
        flags.set("inner", FlagValue::Bool(true));
        let events = vec![Event::Condition {
            flag: "outer".to_string(),
            events: vec![Event::Condition {
                flag: "inner".to_string(),
                events: vec![dialog("deep")],
            }],
        }];

        let resolved = resolve_events(&events, &flags);

        assert_eq!(resolved, vec![dialog("deep")]);
    }

    #[test]
    fn nested_condition_not_expanded_when_inner_flag_false() {
        let mut flags = GameFlags::new();
        flags.set("outer", FlagValue::Bool(true));
        // inner は未設定のまま。
        let events = vec![Event::Condition {
            flag: "outer".to_string(),
            events: vec![Event::Condition {
                flag: "inner".to_string(),
                events: vec![dialog("deep")],
            }],
        }];

        let resolved = resolve_events(&events, &flags);

        assert!(resolved.is_empty());
    }

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

    #[test]
    fn flag_event_itself_passes_through_untouched() {
        let flags = GameFlags::new();
        let events = vec![Event::Flag {
            name: "seen_intro".to_string(),
            value: FlagValue::Bool(true),
        }];

        let resolved = resolve_events(&events, &flags);

        assert_eq!(resolved, events);
    }

    #[test]
    fn flag_event_inside_true_condition_passes_through() {
        let mut flags = GameFlags::new();
        flags.set("outer", FlagValue::Bool(true));
        let inner_flag = Event::Flag {
            name: "seen_intro".to_string(),
            value: FlagValue::Bool(true),
        };
        let events = vec![Event::Condition {
            flag: "outer".to_string(),
            events: vec![inner_flag.clone()],
        }];

        let resolved = resolve_events(&events, &flags);

        assert_eq!(resolved, vec![inner_flag]);
    }
}
