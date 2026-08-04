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
    let action = match event::read()? {
        CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
            KeyCode::Enter | KeyCode::Char(' ') => Action::Advance,
            KeyCode::Char('q') | KeyCode::Esc => Action::Quit,
            _ => Action::None,
        },
        _ => Action::None,
    };
    Ok(action)
}
