use crate::models::*;

/// Parse a name-name Markdown document into a Document struct.
pub fn parse(input: &str) -> Document {
    let lines: Vec<&str> = input.lines().collect();
    let len = lines.len();
    let mut pos = 0;

    // Parse YAML front matter
    let mut engine = String::from("name-name");
    let mut chapter_number: u32 = 1;
    let mut chapter_title = String::new();
    let mut hidden = false;
    let mut default_bgm: Option<String> = None;

    if pos < len && lines[pos].trim() == "---" {
        pos += 1;
        while pos < len && lines[pos].trim() != "---" {
            let line = lines[pos].trim();
            if let Some(val) = line.strip_prefix("engine:") {
                engine = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("chapter:") {
                chapter_number = val.trim().parse().unwrap_or(1);
            } else if let Some(val) = line.strip_prefix("title:") {
                chapter_title = unquote(val.trim());
            } else if let Some(val) = line.strip_prefix("hidden:") {
                hidden = val.trim() == "true";
            } else if let Some(val) = line.strip_prefix("default_bgm:") {
                let v = val.trim().to_string();
                if !v.is_empty() {
                    default_bgm = Some(v);
                }
            }
            pos += 1;
        }
        if pos < len {
            pos += 1; // skip closing ---
        }
    }

    // Skip blank lines after front matter
    while pos < len && lines[pos].trim().is_empty() {
        pos += 1;
    }

    // Parse scenes
    let mut scenes: Vec<Scene> = Vec::new();
    let mut current_scene: Option<Scene> = None;
    let mut current_events: Vec<Event> = Vec::new();

    // Track last speaker for continuation
    let mut last_character: Option<String> = None;
    let mut last_expression: Option<String> = None;
    let mut last_position: Option<String> = None;

    while pos < len {
        let line = lines[pos];
        let trimmed = line.trim();

        // Scene heading: ## 1-1: 教室の朝
        if trimmed.starts_with("## ") {
            // Save previous scene
            if let Some(mut scene) = current_scene.take() {
                scene.events = std::mem::take(&mut current_events);
                scenes.push(scene);
            }
            last_character = None;
            last_expression = None;
            last_position = None;

            let rest = &trimmed[3..];
            if let Some(colon_pos) = rest.find(':') {
                let id = rest[..colon_pos].trim().to_string();
                let title = rest[colon_pos + 1..].trim().to_string();
                // Handle fullwidth colon
                let title = title.strip_prefix('\u{FF1A}').map(|s| s.trim().to_string()).unwrap_or(title);
                current_scene = Some(Scene {
                    id,
                    title,
                    events: Vec::new(),
                });
            } else if let Some(colon_pos) = rest.find('：') {
                let id = rest[..colon_pos].trim().to_string();
                let title = rest[colon_pos + '：'.len_utf8()..].trim().to_string();
                current_scene = Some(Scene {
                    id,
                    title,
                    events: Vec::new(),
                });
            }
            pos += 1;
            continue;
        }

        // Empty line: ends current dialog accumulation
        if trimmed.is_empty() {
            pos += 1;
            continue;
        }

        // Directive: [...]
        if trimmed.starts_with('[') && !trimmed.starts_with("[選択]") && !trimmed.starts_with("[/選択]") && !trimmed.starts_with("[条件:") && !trimmed.starts_with("[/条件]") {
            if let Some(event) = parse_directive(trimmed) {
                current_events.push(event);
            }
            pos += 1;
            continue;
        }

        // Choice block: [選択] ... [/選択]
        if trimmed == "[選択]" {
            pos += 1;
            let mut options: Vec<ChoiceOption> = Vec::new();
            while pos < len && lines[pos].trim() != "[/選択]" {
                let opt_line = lines[pos].trim();
                if let Some(rest) = opt_line.strip_prefix("- ") {
                    if let Some(arrow_pos) = rest.find('→') {
                        let text = rest[..arrow_pos].trim().to_string();
                        let jump = rest[arrow_pos + '→'.len_utf8()..].trim().to_string();
                        options.push(ChoiceOption { text, jump });
                    }
                }
                pos += 1;
            }
            if pos < len {
                pos += 1; // skip [/選択]
            }
            current_events.push(Event::Choice { options });
            continue;
        }

        // Condition block: [条件: flag] ... [/条件]
        if let Some(rest) = trimmed.strip_prefix("[条件:") {
            if let Some(flag) = rest.strip_suffix(']') {
                let flag = flag.trim().to_string();
                pos += 1;
                let mut inner_lines: Vec<String> = Vec::new();
                let mut depth = 1;
                while pos < len && depth > 0 {
                    let inner = lines[pos].trim();
                    if inner.starts_with("[条件:") {
                        depth += 1;
                    }
                    if inner == "[/条件]" {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    inner_lines.push(lines[pos].to_string());
                    pos += 1;
                }
                if pos < len {
                    pos += 1; // skip [/条件]
                }
                // Recursively parse inner content
                let inner_text = inner_lines.join("\n");
                let inner_events = parse_events_only(&inner_text);
                current_events.push(Event::Condition {
                    flag,
                    events: inner_events,
                });
                continue;
            }
        }

        // Flag: [フラグ: name = value]
        if let Some(rest) = trimmed.strip_prefix("[フラグ:") {
            if let Some(content) = rest.strip_suffix(']') {
                if let Some(eq_pos) = content.find('=') {
                    let name = content[..eq_pos].trim().to_string();
                    let val_str = content[eq_pos + 1..].trim();
                    let value = parse_flag_value(val_str);
                    current_events.push(Event::Flag { name, value });
                }
            }
            pos += 1;
            continue;
        }

        // Expression change: **トモ** → angry_1:
        if trimmed.starts_with("**") && trimmed.contains('→') {
            if let Some(event) = parse_expression_change(trimmed) {
                match &event {
                    Event::ExpressionChange { character, expression } => {
                        last_character = Some(character.clone());
                        last_expression = Some(expression.clone());
                        // position stays the same
                    }
                    _ => {}
                }
                current_events.push(event);
            }
            pos += 1;
            continue;
        }

        // Speaker line: **カコ** (suppin_1, 左):
        if trimmed.starts_with("**") && is_speaker_line(trimmed) {
            let (character, expression, position) = parse_speaker_line(trimmed);
            last_character = Some(character.clone());
            last_expression = expression.clone();
            last_position = position.clone();

            pos += 1;
            // Collect text lines until empty line or next command
            let mut text_lines: Vec<String> = Vec::new();
            while pos < len {
                let next = lines[pos];
                let next_trimmed = next.trim();
                if next_trimmed.is_empty() {
                    break;
                }
                if next_trimmed.starts_with('[') || next_trimmed.starts_with("## ") || next_trimmed.starts_with("**") || next_trimmed.starts_with("> ") {
                    break;
                }
                text_lines.push(next_trimmed.to_string());
                pos += 1;
            }
            if !text_lines.is_empty() {
                current_events.push(Event::Dialog {
                    character: Some(character),
                    expression,
                    position,
                    text: text_lines,
                });
            }
            continue;
        }

        // Narration: > テキスト
        if trimmed.starts_with("> ") {
            let mut narration_lines: Vec<String> = Vec::new();
            while pos < len && lines[pos].trim().starts_with("> ") {
                let text = lines[pos].trim().strip_prefix("> ").unwrap_or("").to_string();
                narration_lines.push(text);
                pos += 1;
            }
            current_events.push(Event::Narration {
                text: narration_lines,
            });
            continue;
        }

        // Continuation text (no speaker line, but last_character exists)
        if last_character.is_some() && !trimmed.is_empty() {
            let mut text_lines: Vec<String> = Vec::new();
            while pos < len {
                let next = lines[pos];
                let next_trimmed = next.trim();
                if next_trimmed.is_empty() {
                    break;
                }
                if next_trimmed.starts_with('[') || next_trimmed.starts_with("## ") || next_trimmed.starts_with("**") || next_trimmed.starts_with("> ") {
                    break;
                }
                text_lines.push(next_trimmed.to_string());
                pos += 1;
            }
            if !text_lines.is_empty() {
                current_events.push(Event::Dialog {
                    character: last_character.clone(),
                    expression: last_expression.clone(),
                    position: last_position.clone(),
                    text: text_lines,
                });
            }
            continue;
        }

        pos += 1;
    }

    // Save last scene
    if let Some(mut scene) = current_scene.take() {
        scene.events = current_events;
        scenes.push(scene);
    }

    Document {
        engine,
        chapters: vec![Chapter {
            number: chapter_number,
            title: chapter_title,
            hidden,
            default_bgm,
            scenes,
        }],
    }
}

/// Parse just the events from a string (used for nested condition blocks)
fn parse_events_only(input: &str) -> Vec<Event> {
    // Wrap in a fake document so we can reuse parsing logic
    let fake = format!("---\nengine: name-name\nchapter: 1\ntitle: \"tmp\"\n---\n\n## tmp-1: tmp\n\n{}", input);
    let doc = parse(&fake);
    if let Some(chapter) = doc.chapters.first() {
        if let Some(scene) = chapter.scenes.first() {
            return scene.events.clone();
        }
    }
    Vec::new()
}

fn parse_directive(line: &str) -> Option<Event> {
    let content = line.strip_prefix('[')?.strip_suffix(']')?;

    if let Some(path) = content.strip_prefix("背景:") {
        return Some(Event::Background {
            path: path.trim().to_string(),
        });
    }
    if content == "BGM停止" {
        return Some(Event::Bgm {
            path: None,
            action: BgmAction::Stop,
        });
    }
    if let Some(path) = content.strip_prefix("BGM:") {
        return Some(Event::Bgm {
            path: Some(path.trim().to_string()),
            action: BgmAction::Play,
        });
    }
    if let Some(path) = content.strip_prefix("SE:") {
        return Some(Event::Se {
            path: path.trim().to_string(),
        });
    }
    if content == "暗転" {
        return Some(Event::Blackout {
            action: BlackoutAction::On,
        });
    }
    if content == "暗転解除" {
        return Some(Event::Blackout {
            action: BlackoutAction::Off,
        });
    }
    if content == "場面転換" {
        return Some(Event::SceneTransition);
    }
    if let Some(character) = content.strip_prefix("退場:") {
        return Some(Event::Exit {
            character: character.trim().to_string(),
        });
    }
    if let Some(ms_str) = content.strip_prefix("待機:") {
        if let Ok(ms) = ms_str.trim().parse() {
            return Some(Event::Wait { ms });
        }
    }
    if let Some(rest) = content.strip_prefix("フラグ:") {
        if let Some(eq_pos) = rest.find('=') {
            let name = rest[..eq_pos].trim().to_string();
            let val_str = rest[eq_pos + 1..].trim();
            let value = parse_flag_value(val_str);
            return Some(Event::Flag { name, value });
        }
    }

    None
}

fn parse_flag_value(s: &str) -> FlagValue {
    if s == "true" {
        return FlagValue::Bool(true);
    }
    if s == "false" {
        return FlagValue::Bool(false);
    }
    if let Ok(n) = s.parse::<f64>() {
        return FlagValue::Number(n);
    }
    FlagValue::String(unquote(s))
}

fn is_speaker_line(line: &str) -> bool {
    // **Name** ... : pattern (but not expression change with →)
    if line.contains('→') {
        return false;
    }
    // Must have ** ... ** and end with :
    if let Some(end) = line.find("**:") {
        // Simple form: **Name**:
        let _ = end;
        return true;
    }
    if line.ends_with(':') || line.ends_with('：') {
        // **Name** (expr, pos):
        return true;
    }
    false
}

fn parse_speaker_line(line: &str) -> (String, Option<String>, Option<String>) {
    // Extract character name between ** **
    let after_stars = &line[2..]; // skip leading **
    let name_end = after_stars.find("**").unwrap_or(after_stars.len());
    let character = after_stars[..name_end].to_string();

    let rest = &after_stars[name_end + 2..]; // after closing **
    let rest = rest.trim();

    // Check for parenthesized attributes: (expression, position):
    if let Some(paren_start) = rest.find('(') {
        if let Some(paren_end) = rest.find(')') {
            let attrs = &rest[paren_start + 1..paren_end];
            let parts: Vec<&str> = attrs.split(',').collect();
            let expression = parts.first().map(|s| s.trim().to_string());
            let position = parts.get(1).map(|s| s.trim().to_string());
            return (character, expression, position);
        }
    }

    (character, None, None)
}

fn parse_expression_change(line: &str) -> Option<Event> {
    // **トモ** → angry_1:
    let after_stars = &line[2..];
    let name_end = after_stars.find("**")?;
    let character = after_stars[..name_end].to_string();

    let rest = &after_stars[name_end + 2..];
    let arrow_pos = rest.find('→')?;
    let after_arrow = &rest[arrow_pos + '→'.len_utf8()..];
    let expression = after_arrow.trim().trim_end_matches(':').trim().to_string();

    Some(Event::ExpressionChange {
        character,
        expression,
    })
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_dialog() {
        let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: テスト

**カコ** (suppin_1, 左):
こんにちは。
"#;
        let doc = parse(input);
        assert_eq!(doc.chapters.len(), 1);
        assert_eq!(doc.chapters[0].scenes.len(), 1);
        assert_eq!(doc.chapters[0].scenes[0].events.len(), 1);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::Dialog { character, expression, position, text } => {
                assert_eq!(character, &Some("カコ".to_string()));
                assert_eq!(expression, &Some("suppin_1".to_string()));
                assert_eq!(position, &Some("左".to_string()));
                assert_eq!(text, &vec!["こんにちは。".to_string()]);
            }
            _ => panic!("Expected Dialog event"),
        }
    }

    #[test]
    fn test_parse_directives() {
        let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: テスト

[背景: radius/BG_COMMON_GRAD_3.png]
[BGM: amehure.ogg]
[暗転解除]
[SE: se_test.ogg]
[暗転]
[場面転換]
[退場: トモ]
[待機: 1000]
[BGM停止]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 9);
        assert_eq!(events[0], Event::Background { path: "radius/BG_COMMON_GRAD_3.png".to_string() });
        assert_eq!(events[1], Event::Bgm { path: Some("amehure.ogg".to_string()), action: BgmAction::Play });
        assert_eq!(events[2], Event::Blackout { action: BlackoutAction::Off });
        assert_eq!(events[3], Event::Se { path: "se_test.ogg".to_string() });
        assert_eq!(events[4], Event::Blackout { action: BlackoutAction::On });
        assert_eq!(events[5], Event::SceneTransition);
        assert_eq!(events[6], Event::Exit { character: "トモ".to_string() });
        assert_eq!(events[7], Event::Wait { ms: 1000 });
        assert_eq!(events[8], Event::Bgm { path: None, action: BgmAction::Stop });
    }

    #[test]
    fn test_parse_front_matter() {
        let input = r#"---
engine: name-name
chapter: 2
title: "第二章"
hidden: true
default_bgm: test.ogg
---

## 2-1: テスト
"#;
        let doc = parse(input);
        assert_eq!(doc.engine, "name-name");
        assert_eq!(doc.chapters[0].number, 2);
        assert_eq!(doc.chapters[0].title, "第二章");
        assert_eq!(doc.chapters[0].hidden, true);
        assert_eq!(doc.chapters[0].default_bgm, Some("test.ogg".to_string()));
    }
}
