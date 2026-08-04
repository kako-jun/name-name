//! キー入力の解釈。Enter/Space で次の会話行へ進み、q/Esc で終了する。

use ratatui::crossterm::event::{self, Event as CrosstermEvent, KeyCode, KeyEventKind};

/// キー入力から導かれるアプリの動作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 何もしない（対象外のキー入力・キー離しイベント等）。
    None,
    /// 次の会話行へ進む。
    Advance,
    /// アプリを終了する。
    Quit,
}

/// 次の端末イベントをブロッキングで待ち受け、`Action` に変換する。
pub fn next_action() -> anyhow::Result<Action> {
    Ok(action_for_event(event::read()?))
}

/// 単一の crossterm イベントから `Action` を導く純粋なマッピング（I/O を持たない）。
/// `next_action()` から呼ばれる内部実装で、ユニットテストからは実端末を経由せず
/// 直接イベント値を組み立てて呼べる。
fn action_for_event(event: CrosstermEvent) -> Action {
    match event {
        CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
            KeyCode::Enter | KeyCode::Char(' ') => Action::Advance,
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
        let action = action_for_event(key_event(KeyCode::Char('a'), KeyEventKind::Press));
        assert_eq!(action, Action::None);
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
