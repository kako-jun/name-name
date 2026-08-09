//! キー入力の解釈。Enter/Space で次の会話行へ進み（選択肢表示中は確定になる、#482）、
//! ↑/↓ で選択肢のカーソルを動かし、q/Esc で終了する。

use std::time::Duration;

use ratatui::crossterm::event::{self, Event as CrosstermEvent, KeyCode, KeyEventKind};

/// キー入力から導かれるアプリの動作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 何もしない（対象外のキー入力・キー離しイベント等）。
    None,
    /// 次の会話行へ進む。選択肢表示中（`Playback::current_choice` が `Some`）は、
    /// 意味が「カーソルが指す選択肢の確定」に変わる（#482、`main.rs::on_advance` 参照）。
    /// Advance と兼用にしているのは、選択肢が無い既存スクリプトでは Enter/Space の意味を
    /// 一切変えたくないため（新規 Action にすると呼び出し側で常に分岐が必要になる）。
    Advance,
    /// 選択肢のカーソルを1つ上へ動かす。選択肢を表示していないときは no-op（#482）。
    MoveUp,
    /// 選択肢のカーソルを1つ下へ動かす。選択肢を表示していないときは no-op（#482）。
    MoveDown,
    /// オートモード（自動ページ送り）の ON/OFF を切り替える（#498、GUI版 `setAutoMode`
    /// 相当）。選択肢表示中でも受け付ける（GUI版のボタンも常時操作可能）。
    ToggleAuto,
    /// スキップモード（既読テキスト早送り）の ON/OFF を切り替える（#499、GUI版
    /// `setSkipMode` 相当）。選択肢表示中でも受け付ける（GUI版のボタンも常時操作可能）。
    ToggleSkip,
    /// バックログ（既読ログ）画面の表示/非表示を切り替える（#500、GUI版
    /// `NovelRenderer.backlogOverlay.toggle()` / キー`b`/`B` 相当）。選択肢表示中でも
    /// 受け付ける — バックログはゲーム進行に影響しない閲覧専用画面のため、選択肢待ちでも
    /// 開いて構わない（`main.rs::event_loop` の `Overlay` 参照）。
    ToggleBacklog,
    /// テキスト速度設定画面の表示/非表示を切り替える（#503、GUI版 `SettingsOverlay` の
    /// テキスト速度スライダー相当）。音量調整はGUI版にあるが、#502（ボイス/BGM/SE再生の
    /// 実装要否）がkako-jun判断待ちで未決着のため今回は対象外（Issue #503 本文の明示スコープ）。
    /// 選択肢表示中でも受け付ける（`ToggleBacklog` と同じ理由）。
    ToggleSettings,
    /// アプリを終了する。オーバーレイ（バックログ/設定画面）が開いているときは、
    /// `main.rs::event_loop` がこれを「アプリ終了」ではなく「オーバーレイを閉じる」として
    /// 解釈し直す（GUI版 `handleKeyDown` の「Escape: 開いているオーバーレイを閉じる」と
    /// 同じ優先順位）。
    Quit,
}

/// 次の端末イベントをブロッキングで待ち受け、`Action` に変換する。
pub fn next_action() -> anyhow::Result<Action> {
    Ok(action_for_event(event::read()?))
}

/// `timeout` 以内に端末イベントが来なければ `Action::None` を返す（ノンブロッキング）。
///
/// タイプライター演出（`jiwa::RevealHandle` の `snapshot`）とページ送りインジケータ
/// （`reveal::blink_visible` による1秒周期の完全on/off点滅、#495）はどちらも時間経過だけで
/// 進むため、`event_loop` はキー入力の有無に関わらず短い間隔で再描画する必要がある（#472）。
/// `next_action` の無条件ブロッキング待ちのままだと、キー入力が無い間はアニメーションが
/// 完全に静止してしまう。
pub fn poll_action(timeout: Duration) -> anyhow::Result<Action> {
    if event::poll(timeout)? {
        next_action()
    } else {
        Ok(Action::None)
    }
}

/// 単一の crossterm イベントから `Action` を導く純粋なマッピング（I/O を持たない）。
/// `next_action()` から呼ばれる内部実装で、ユニットテストからは実端末を経由せず
/// 直接イベント値を組み立てて呼べる。
fn action_for_event(event: CrosstermEvent) -> Action {
    match event {
        CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
            KeyCode::Enter | KeyCode::Char(' ') => Action::Advance,
            KeyCode::Up => Action::MoveUp,
            KeyCode::Down => Action::MoveDown,
            KeyCode::Char('a') | KeyCode::Char('A') => Action::ToggleAuto,
            KeyCode::Char('s') | KeyCode::Char('S') => Action::ToggleSkip,
            KeyCode::Char('b') | KeyCode::Char('B') => Action::ToggleBacklog,
            KeyCode::Char('c') | KeyCode::Char('C') => Action::ToggleSettings,
            KeyCode::Char('q') | KeyCode::Esc => Action::Quit,
            _ => Action::None,
        },
        _ => Action::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::{KeyEvent, KeyModifiers};

    fn key_event(code: KeyCode, kind: KeyEventKind) -> CrosstermEvent {
        CrosstermEvent::Key(KeyEvent::new_with_kind(code, KeyModifiers::NONE, kind))
    }

    #[test]
    fn enter_press_returns_advance() {
        let action = action_for_event(key_event(KeyCode::Enter, KeyEventKind::Press));
        assert_eq!(action, Action::Advance);
    }

    #[test]
    fn space_press_returns_advance() {
        let action = action_for_event(key_event(KeyCode::Char(' '), KeyEventKind::Press));
        assert_eq!(action, Action::Advance);
    }

    #[test]
    fn up_arrow_press_returns_move_up() {
        let action = action_for_event(key_event(KeyCode::Up, KeyEventKind::Press));
        assert_eq!(action, Action::MoveUp);
    }

    #[test]
    fn down_arrow_press_returns_move_down() {
        let action = action_for_event(key_event(KeyCode::Down, KeyEventKind::Press));
        assert_eq!(action, Action::MoveDown);
    }

    #[test]
    fn char_q_press_returns_quit() {
        let action = action_for_event(key_event(KeyCode::Char('q'), KeyEventKind::Press));
        assert_eq!(action, Action::Quit);
    }

    #[test]
    fn esc_press_returns_quit() {
        let action = action_for_event(key_event(KeyCode::Esc, KeyEventKind::Press));
        assert_eq!(action, Action::Quit);
    }

    #[test]
    fn unmapped_key_press_returns_none() {
        let action = action_for_event(key_event(KeyCode::Char('z'), KeyEventKind::Press));
        assert_eq!(action, Action::None);
    }

    #[test]
    fn char_a_lowercase_press_returns_toggle_auto() {
        let action = action_for_event(key_event(KeyCode::Char('a'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleAuto);
    }

    #[test]
    fn char_a_uppercase_press_returns_toggle_auto() {
        let action = action_for_event(key_event(KeyCode::Char('A'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleAuto);
    }

    #[test]
    fn char_s_lowercase_press_returns_toggle_skip() {
        let action = action_for_event(key_event(KeyCode::Char('s'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleSkip);
    }

    #[test]
    fn char_s_uppercase_press_returns_toggle_skip() {
        let action = action_for_event(key_event(KeyCode::Char('S'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleSkip);
    }

    #[test]
    fn char_b_lowercase_press_returns_toggle_backlog() {
        let action = action_for_event(key_event(KeyCode::Char('b'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleBacklog);
    }

    #[test]
    fn char_b_uppercase_press_returns_toggle_backlog() {
        let action = action_for_event(key_event(KeyCode::Char('B'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleBacklog);
    }

    #[test]
    fn char_c_lowercase_press_returns_toggle_settings() {
        let action = action_for_event(key_event(KeyCode::Char('c'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleSettings);
    }

    #[test]
    fn char_c_uppercase_press_returns_toggle_settings() {
        let action = action_for_event(key_event(KeyCode::Char('C'), KeyEventKind::Press));
        assert_eq!(action, Action::ToggleSettings);
    }

    #[test]
    fn enter_repeat_does_not_trigger_advance() {
        let action = action_for_event(key_event(KeyCode::Enter, KeyEventKind::Repeat));
        assert_eq!(action, Action::None);
    }

    #[test]
    fn enter_release_does_not_trigger_advance() {
        let action = action_for_event(key_event(KeyCode::Enter, KeyEventKind::Release));
        assert_eq!(action, Action::None);
    }
}
