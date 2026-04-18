use crate::models::*;

/// Emit a Document back to Markdown format.
pub fn emit(doc: &Document) -> String {
    let mut out = String::new();

    for chapter in &doc.chapters {
        // YAML front matter
        out.push_str("---\n");
        out.push_str(&format!("engine: {}\n", doc.engine));
        out.push_str(&format!("chapter: {}\n", chapter.number));
        out.push_str(&format!("title: \"{}\"\n", chapter.title));
        out.push_str(&format!("hidden: {}\n", chapter.hidden));
        if let Some(ref bgm) = chapter.default_bgm {
            out.push_str(&format!("default_bgm: {}\n", bgm));
        }
        out.push_str("---\n");

        for scene in &chapter.scenes {
            out.push('\n');
            out.push_str(&format!("## {}: {}\n", scene.id, scene.title));
            out.push('\n');

            emit_events(&mut out, &scene.events);
        }
    }

    // Remove trailing newlines, then add exactly one
    let trimmed = out.trim_end().to_string();
    trimmed + "\n"
}

fn emit_events(out: &mut String, events: &[Event]) {
    let mut prev_was_dialog_or_text = false;

    for (i, event) in events.iter().enumerate() {
        match event {
            Event::Dialog {
                character,
                expression,
                position,
                text,
            } => {
                // Add blank line before dialog if previous was also dialog (new speech block)
                if prev_was_dialog_or_text && i > 0 {
                    out.push('\n');
                }

                // Check if we need to emit a speaker line
                let need_speaker = needs_speaker_line(events, i);
                if need_speaker {
                    if let Some(ref ch) = character {
                        out.push_str(&format!("**{}**", ch));
                        if expression.is_some() || position.is_some() {
                            let expr = expression.as_deref().unwrap_or("");
                            let pos = position.as_deref().unwrap_or("");
                            if !pos.is_empty() {
                                out.push_str(&format!(" ({}, {}):\n", expr, pos));
                            } else if !expr.is_empty() {
                                out.push_str(&format!(" ({}):\n", expr));
                            } else {
                                out.push_str(":\n");
                            }
                        } else {
                            out.push_str(":\n");
                        }
                    }
                }

                for line in text {
                    out.push_str(line);
                    out.push('\n');
                }

                prev_was_dialog_or_text = true;
            }
            Event::Narration { text } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                for line in text {
                    out.push_str(&format!("> {}\n", line));
                }
                prev_was_dialog_or_text = true;
            }
            Event::Background { path } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[背景: {}]\n", path));
                prev_was_dialog_or_text = false;
            }
            Event::Bgm { path, action } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                match action {
                    BgmAction::Play => {
                        if let Some(ref p) = path {
                            out.push_str(&format!("[BGM: {}]\n", p));
                        }
                    }
                    BgmAction::Stop => {
                        out.push_str("[BGM停止]\n");
                    }
                }
                prev_was_dialog_or_text = false;
            }
            Event::Se { path } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[SE: {}]\n", path));
                prev_was_dialog_or_text = false;
            }
            Event::Blackout { action } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                match action {
                    BlackoutAction::On => out.push_str("[暗転]\n"),
                    BlackoutAction::Off => out.push_str("[暗転解除]\n"),
                }
                prev_was_dialog_or_text = false;
            }
            Event::SceneTransition => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str("[場面転換]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Exit { character } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[退場: {}]\n", character));
                prev_was_dialog_or_text = false;
            }
            Event::Wait { ms } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[待機: {}]\n", ms));
                prev_was_dialog_or_text = false;
            }
            Event::Choice { options } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str("[選択]\n");
                for opt in options {
                    out.push_str(&format!("- {} → {}\n", opt.text, opt.jump));
                }
                out.push_str("[/選択]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Flag { name, value } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                let val_str = match value {
                    FlagValue::Bool(b) => b.to_string(),
                    FlagValue::String(s) => format!("\"{}\"", s),
                    FlagValue::Number(n) => format_number(*n),
                };
                out.push_str(&format!("[フラグ: {} = {}]\n", name, val_str));
                prev_was_dialog_or_text = false;
            }
            Event::Condition {
                flag,
                events: inner,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[条件: {}]\n", flag));
                emit_events(out, inner);
                out.push_str("[/条件]\n");
                prev_was_dialog_or_text = false;
            }
            Event::ExpressionChange {
                character,
                expression,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("**{}** → {}:\n", character, expression));
                prev_was_dialog_or_text = false;
            }
            Event::RpgMap(map) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!(
                    "[マップ {}x{} タイル={}]\n",
                    map.width, map.height, map.tile_size
                ));
                for row in &map.tiles {
                    let mut line = String::with_capacity(map.width as usize);
                    for (i, t) in row.iter().enumerate() {
                        if i >= map.width as usize {
                            break;
                        }
                        line.push(tile_char(*t));
                    }
                    // pad if short
                    while line.chars().count() < map.width as usize {
                        line.push('G');
                    }
                    out.push_str(&line);
                    out.push('\n');
                }
                out.push_str("[/マップ]\n");
                prev_was_dialog_or_text = false;
            }
            Event::PlayerStart(p) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!(
                    "[プレイヤー @{},{} 向き={}]\n",
                    p.x,
                    p.y,
                    direction_ja(p.direction)
                ));
                prev_was_dialog_or_text = false;
            }
            Event::Npc(npc) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!(
                    "[NPC {} @{},{} 色=#{:06x}]\n",
                    npc.name, npc.x, npc.y, npc.color
                ));
                for line in &npc.message {
                    out.push_str(line);
                    out.push('\n');
                }
                out.push_str("[/NPC]\n");
                prev_was_dialog_or_text = false;
            }
        }
    }
}

fn tile_char(t: u8) -> char {
    match t {
        0 => 'G',
        1 => 'R',
        2 => 'T',
        3 => 'W',
        _ => 'G',
    }
}

fn direction_ja(d: Direction) -> &'static str {
    match d {
        Direction::Up => "上",
        Direction::Down => "下",
        Direction::Left => "左",
        Direction::Right => "右",
    }
}

/// Determine if a Dialog event needs a speaker line emitted.
/// A speaker line is needed if:
/// - It's the first dialog, OR
/// - The character/expression/position changed from previous dialog, OR
/// - There was a non-dialog event in between
fn needs_speaker_line(events: &[Event], idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    // Look at previous event
    let prev = &events[idx - 1];
    let curr = &events[idx];

    match (prev, curr) {
        (
            Event::Dialog {
                character: prev_ch,
                expression: prev_ex,
                position: prev_pos,
                ..
            },
            Event::Dialog {
                character: curr_ch,
                expression: curr_ex,
                position: curr_pos,
                ..
            },
        ) => {
            // Same speaker continuation: no speaker line needed
            !(prev_ch == curr_ch && prev_ex == curr_ex && prev_pos == curr_pos)
        }
        (Event::ExpressionChange { .. }, Event::Dialog { .. }) => {
            // After expression change, no speaker line (expression change already shows who)
            false
        }
        _ => true,
    }
}

fn format_number(n: f64) -> String {
    if n == n.floor() && n.is_finite() {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_emit_simple() {
        let doc = Document {
            engine: "name-name".to_string(),
            chapters: vec![Chapter {
                number: 1,
                title: "テスト".to_string(),
                hidden: false,
                default_bgm: None,
                scenes: vec![Scene {
                    id: "1-1".to_string(),
                    title: "テスト".to_string(),
                    events: vec![Event::Dialog {
                        character: Some("カコ".to_string()),
                        expression: Some("suppin_1".to_string()),
                        position: Some("左".to_string()),
                        text: vec!["こんにちは。".to_string()],
                    }],
                }],
            }],
        };

        let output = emit(&doc);
        assert!(output.contains("**カコ** (suppin_1, 左):"));
        assert!(output.contains("こんにちは。"));
    }
}
