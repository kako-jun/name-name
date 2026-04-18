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
        if let Some(rest) = trimmed.strip_prefix("## ") {
            // Save previous scene
            if let Some(mut scene) = current_scene.take() {
                scene.events = std::mem::take(&mut current_events);
                scenes.push(scene);
            }
            last_character = None;
            last_expression = None;
            last_position = None;
            if let Some(colon_pos) = rest.find(':') {
                let id = rest[..colon_pos].trim().to_string();
                let title = rest[colon_pos + 1..].trim().to_string();
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

        // RPG Map block: [マップ WxH タイル=N] ... [/マップ]
        if let Some(header) = trimmed.strip_prefix("[マップ") {
            if header.ends_with(']') {
                let header_inner = header.trim_end_matches(']').trim();
                if let Some(map_data) = parse_map_header(header_inner) {
                    let (width, height, tile_size) = map_data;
                    pos += 1;
                    let mut tiles: Vec<Vec<u8>> = Vec::with_capacity(height as usize);
                    while pos < len && lines[pos].trim() != "[/マップ]" {
                        let row_line = lines[pos];
                        let row = parse_tile_row(row_line, width as usize);
                        tiles.push(row);
                        pos += 1;
                    }
                    if pos < len {
                        pos += 1; // skip [/マップ]
                    }
                    // Pad if short rows (should already be handled, but ensure count)
                    while tiles.len() < height as usize {
                        tiles.push(vec![0u8; width as usize]);
                    }
                    tiles.truncate(height as usize);
                    current_events.push(Event::RpgMap(RpgMapData {
                        width,
                        height,
                        tile_size,
                        tiles,
                    }));
                    continue;
                }
            }
        }

        // NPC block: [NPC name @x,y 色=#rrggbb] ... [/NPC]
        if let Some(header) = trimmed.strip_prefix("[NPC") {
            if header.ends_with(']') {
                let header_inner = header.trim_end_matches(']').trim();
                if let Some((name, x, y, color)) = parse_npc_header(header_inner) {
                    pos += 1;
                    let mut message: Vec<String> = Vec::new();
                    while pos < len && lines[pos].trim() != "[/NPC]" {
                        message.push(lines[pos].trim().to_string());
                        pos += 1;
                    }
                    // Trim trailing empty lines in message
                    while let Some(last) = message.last() {
                        if last.is_empty() {
                            message.pop();
                        } else {
                            break;
                        }
                    }
                    if pos < len {
                        pos += 1; // skip [/NPC]
                    }
                    let id = slugify_npc_id(&name, &current_events);
                    current_events.push(Event::Npc(NpcData {
                        id,
                        name,
                        x,
                        y,
                        color,
                        message,
                    }));
                    continue;
                }
            }
        }

        // Player start (single line): [プレイヤー @x,y 向き=...]
        if let Some(rest) = trimmed.strip_prefix("[プレイヤー") {
            if rest.ends_with(']') {
                let inner = rest.trim_end_matches(']').trim();
                if let Some(player) = parse_player_line(inner) {
                    current_events.push(Event::PlayerStart(player));
                    pos += 1;
                    continue;
                }
            }
        }

        // Directive: [...]
        if trimmed.starts_with('[')
            && !trimmed.starts_with("[選択]")
            && !trimmed.starts_with("[/選択]")
            && !trimmed.starts_with("[条件:")
            && !trimmed.starts_with("[/条件]")
        {
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

        // Expression change: **トモ** → angry_1:
        if trimmed.starts_with("**") && trimmed.contains('→') {
            if let Some(event) = parse_expression_change(trimmed) {
                if let Event::ExpressionChange {
                    character,
                    expression,
                } = &event
                {
                    last_character = Some(character.clone());
                    last_expression = Some(expression.clone());
                    // position stays the same
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
                if next_trimmed.starts_with('[')
                    || next_trimmed.starts_with("## ")
                    || next_trimmed.starts_with("**")
                    || next_trimmed.starts_with("> ")
                {
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
                let text = lines[pos]
                    .trim()
                    .strip_prefix("> ")
                    .unwrap_or("")
                    .to_string();
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
                if next_trimmed.starts_with('[')
                    || next_trimmed.starts_with("## ")
                    || next_trimmed.starts_with("**")
                    || next_trimmed.starts_with("> ")
                {
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
    let fake = format!(
        "---\nengine: name-name\nchapter: 1\ntitle: \"tmp\"\n---\n\n## tmp-1: tmp\n\n{}",
        input
    );
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
    if line.contains("**:") {
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

/// Parse "20x15 タイル=32" → Some((20, 15, 32))
fn parse_map_header(s: &str) -> Option<(u32, u32, u32)> {
    // Split on whitespace
    let mut parts = s.split_whitespace();
    let size = parts.next()?;
    let (w_str, h_str) = size.split_once('x').or_else(|| size.split_once('X'))?;
    let width: u32 = w_str.trim().parse().ok()?;
    let height: u32 = h_str.trim().parse().ok()?;
    // tile_size: default 32 if omitted
    let mut tile_size: u32 = 32;
    for rest in parts {
        if let Some(val) = rest.strip_prefix("タイル=") {
            if let Ok(n) = val.trim().parse() {
                tile_size = n;
            }
        }
    }
    Some((width, height, tile_size))
}

/// Parse a single row of tile characters. G/.=0, R=1, T=2, W=3. Unknown → 0.
fn parse_tile_row(line: &str, width: usize) -> Vec<u8> {
    let mut row: Vec<u8> = line
        .chars()
        .take(width)
        .map(|c| match c {
            'G' | '.' => 0u8,
            'R' => 1u8,
            'T' => 2u8,
            'W' => 3u8,
            _ => 0u8,
        })
        .collect();
    while row.len() < width {
        row.push(0);
    }
    row
}

/// Parse NPC header: "name @x,y 色=#rrggbb" → Some((name, x, y, color))
fn parse_npc_header(s: &str) -> Option<(String, u32, u32, u32)> {
    // Extract name (before @), then @x,y, then 色=...
    let at_pos = s.find('@')?;
    let name = s[..at_pos].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let after_at = &s[at_pos + 1..];
    // split by whitespace to separate x,y from 色=
    let mut parts = after_at.split_whitespace();
    let coord = parts.next()?;
    let (x_str, y_str) = coord.split_once(',')?;
    let x: u32 = x_str.trim().parse().ok()?;
    let y: u32 = y_str.trim().parse().ok()?;
    // color: default 0xff6b6b
    let mut color: u32 = 0xff6b6b;
    for p in parts {
        if let Some(val) = p.strip_prefix("色=") {
            let hex = val.trim().trim_start_matches('#');
            if let Ok(n) = u32::from_str_radix(hex, 16) {
                color = n;
            }
        }
    }
    Some((name, x, y, color))
}

/// Parse player start line: "@x,y 向き=..." → Some(PlayerStartData)
fn parse_player_line(s: &str) -> Option<PlayerStartData> {
    let at_pos = s.find('@')?;
    let after_at = &s[at_pos + 1..];
    let mut parts = after_at.split_whitespace();
    let coord = parts.next()?;
    let (x_str, y_str) = coord.split_once(',')?;
    let x: u32 = x_str.trim().parse().ok()?;
    let y: u32 = y_str.trim().parse().ok()?;
    let mut direction = Direction::Down;
    for p in parts {
        if let Some(val) = p.strip_prefix("向き=") {
            direction = parse_direction(val.trim());
        }
    }
    Some(PlayerStartData { x, y, direction })
}

fn parse_direction(s: &str) -> Direction {
    match s {
        "up" | "Up" | "上" => Direction::Up,
        "down" | "Down" | "下" => Direction::Down,
        "left" | "Left" | "左" => Direction::Left,
        "right" | "Right" | "右" => Direction::Right,
        _ => Direction::Down,
    }
}

/// Generate a unique id for an NPC from its name. If name is non-ASCII,
/// fall back to "npc{index}". If an NPC with the same id already exists
/// in the current events, append -2, -3, etc.
fn slugify_npc_id(name: &str, existing: &[Event]) -> String {
    let base: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c == ' ' || c == '-' || c == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect();
    let base = if base.is_empty() {
        let count = existing
            .iter()
            .filter(|e| matches!(e, Event::Npc(_)))
            .count();
        format!("npc{}", count + 1)
    } else {
        base
    };

    // Check for collisions
    let mut candidate = base.clone();
    let mut n = 2;
    while existing.iter().any(|e| {
        if let Event::Npc(npc) = e {
            npc.id == candidate
        } else {
            false
        }
    }) {
        candidate = format!("{}-{}", base, n);
        n += 1;
    }
    candidate
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
            Event::Dialog {
                character,
                expression,
                position,
                text,
            } => {
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
        assert_eq!(
            events[0],
            Event::Background {
                path: "radius/BG_COMMON_GRAD_3.png".to_string()
            }
        );
        assert_eq!(
            events[1],
            Event::Bgm {
                path: Some("amehure.ogg".to_string()),
                action: BgmAction::Play
            }
        );
        assert_eq!(
            events[2],
            Event::Blackout {
                action: BlackoutAction::Off
            }
        );
        assert_eq!(
            events[3],
            Event::Se {
                path: "se_test.ogg".to_string()
            }
        );
        assert_eq!(
            events[4],
            Event::Blackout {
                action: BlackoutAction::On
            }
        );
        assert_eq!(events[5], Event::SceneTransition);
        assert_eq!(
            events[6],
            Event::Exit {
                character: "トモ".to_string()
            }
        );
        assert_eq!(events[7], Event::Wait { ms: 1000 });
        assert_eq!(
            events[8],
            Event::Bgm {
                path: None,
                action: BgmAction::Stop
            }
        );
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
