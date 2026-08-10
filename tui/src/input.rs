//! キー入力の解釈。Enter/Space で次の会話行へ進み（選択肢表示中は確定になる、#482）、
//! ↑/↓ で選択肢のカーソルを動かし（グリッド表示では行移動、#508）、←/→ で選択肢の
//! グリッド表示中のみカーソルを列移動し（非グリッドでは no-op、#508）、q/Esc で終了する。

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
    /// 選択肢のカーソルを1つ上の行へ動かす。選択肢を表示していないときは no-op（#482）。
    /// グリッド表示（#508）では同じ列の1つ上の行へ、非グリッドでは1つ前の要素へ動く
    /// （`Playback::move_choice_cursor_up` 参照）。
    MoveUp,
    /// 選択肢のカーソルを1つ下の行へ動かす。選択肢を表示していないときは no-op（#482）。
    /// グリッド表示（#508）では同じ列の1つ下の行へ、非グリッドでは1つ次の要素へ動く
    /// （`Playback::move_choice_cursor_down` 参照）。
    MoveDown,
    /// 選択肢のカーソルを同じ行内で1つ左へ動かす（#508）。選択肢を表示していない、
    /// または非グリッド（列数1以下）表示中は no-op（`Playback::move_choice_cursor_left`）。
    MoveLeft,
    /// 選択肢のカーソルを同じ行内で1つ右へ動かす（#508）。選択肢を表示していない、
    /// または非グリッド（列数1以下）表示中は no-op（`Playback::move_choice_cursor_right`）。
    MoveRight,
    /// アプリを終了する。
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
            KeyCode::Left => Action::MoveLeft,
            KeyCode::Right => Action::MoveRight,
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
    fn left_arrow_press_returns_move_left() {
        let action = action_for_event(key_event(KeyCode::Left, KeyEventKind::Press));
        assert_eq!(action, Action::MoveLeft);
    }

    #[test]
    fn right_arrow_press_returns_move_right() {
        let action = action_for_event(key_event(KeyCode::Right, KeyEventKind::Press));
        assert_eq!(action, Action::MoveRight);
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
