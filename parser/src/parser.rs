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
    let mut aspect_ratio = String::from("16:9");
    let mut choice_style: Option<String> = None;
    let mut font_family: Option<String> = None;

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
            } else if let Some(val) = line.strip_prefix("aspect_ratio:") {
                let v = unquote(val.trim());
                if v == "16:9" || v == "4:3" || v == "9:16" {
                    aspect_ratio = v;
                }
            } else if let Some(val) = line.strip_prefix("choice_style:") {
                let v = unquote(val.trim());
                if !v.is_empty() {
                    choice_style = Some(v);
                }
            } else if let Some(val) = line.strip_prefix("font_family:") {
                // per-game デフォルトフォント (#147)。
                // 値は CSS の font-family を生で透過させる。空なら None のままにする。
                let v = unquote(val.trim());
                if !v.is_empty() {
                    font_family = Some(v);
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
    // per-line voice (#144): [ボイス: path] で次の Dialog/Narration に注入する
    let mut pending_voice_path: Option<String> = None;
    // per-line font (#147): [フォント: family] で次の Dialog/Narration に注入する。
    // [フォント解除] で None にクリアされる（base に戻る）。
    let mut pending_font_family: Option<String> = None;

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
                let title_raw = rest[colon_pos + 1..].trim().to_string();
                let (title, view) = parse_scene_title_and_view(&title_raw);
                current_scene = Some(Scene {
                    id,
                    title,
                    view,
                    events: Vec::new(),
                });
            } else if let Some(colon_pos) = rest.find('：') {
                let id = rest[..colon_pos].trim().to_string();
                let title_raw = rest[colon_pos + '：'.len_utf8()..].trim().to_string();
                let (title, view) = parse_scene_title_and_view(&title_raw);
                current_scene = Some(Scene {
                    id,
                    title,
                    view,
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
                    let mut raw_rows: Vec<&str> = Vec::with_capacity(height as usize);
                    let mut close_found = false;
                    while pos < len {
                        let l = lines[pos].trim();
                        if l == "[/マップ]" {
                            close_found = true;
                            break;
                        }
                        // `[/マップ]` 欠落ガード: 行頭が `[` で始まり、[/マップ] でもない行が来たら
                        // 別ブロックが突入したと判断してループ中断。`pos` はそのまま次のブロック
                        // 処理に回す（break しなければ別ブロックがマップ行として消費されてしまう）。
                        if l.starts_with('[') {
                            emit_map_close_missing_warning(width, height, raw_rows.len());
                            break;
                        }
                        raw_rows.push(lines[pos]);
                        pos += 1;
                    }
                    if close_found && pos < len {
                        pos += 1; // skip [/マップ]
                    }

                    // Warn if declared dimensions don't match actual data.
                    // Behavior: keep tolerant (pad missing rows with zeros,
                    // truncate extras; short rows are already zero-padded by
                    // parse_tile_row, long rows are truncated). Do not panic.
                    let actual_rows = raw_rows.len() as u32;
                    let any_row_width_mismatch =
                        raw_rows.iter().any(|r| r.chars().count() as u32 != width);
                    if actual_rows != height || any_row_width_mismatch {
                        emit_map_dimension_warning(width, height, &raw_rows);
                    }

                    let mut tiles: Vec<Vec<u8>> = raw_rows
                        .iter()
                        .map(|row_line| parse_tile_row(row_line, width as usize))
                        .collect();
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
                        wall_heights: None,
                        floor_heights: None,
                        ceiling_heights: None,
                    }));
                    continue;
                }
            }
        }

        // Height blocks: [壁高さ] / [床高さ] / [天井高さ]
        // 空白区切りの f64 を行ごとにパースし、直前の RpgMap Event に注入する。
        // [マップ] と独立して受理し、寸法チェックは後段 (frontend validateMapHeights) に委ねる。
        if let Some(kind) = detect_height_block(trimmed) {
            pos += 1;
            let end_tag = format!("[/{}]", kind.tag());
            let mut rows: Vec<Vec<f64>> = Vec::new();
            let mut line_no: usize = 0;
            while pos < len && lines[pos].trim() != end_tag {
                let raw = lines[pos].trim();
                line_no += 1;
                if !raw.is_empty() {
                    // 1 行に 1 トークンでも parse 失敗があれば、その行を丸ごと破棄して警告を出す。
                    // collect::<Option<Vec<_>>>() は FromIterator の仕様で、any None で全体 None になる。
                    let parsed_row: Option<Vec<f64>> = raw
                        .split_whitespace()
                        .map(|s| s.parse::<f64>().ok().map(|v| (s, v)))
                        .collect::<Option<Vec<_>>>()
                        .map(|pairs| pairs.into_iter().map(|(_, v)| v).collect());
                    match parsed_row {
                        Some(row) => rows.push(row),
                        None => {
                            // どのトークンが壊れているかを拾う
                            let bad = raw
                                .split_whitespace()
                                .find(|s| s.parse::<f64>().is_err())
                                .unwrap_or("?");
                            emit_height_block_warning(&format!(
                                "[{}] 行 {}: 数値でないトークン \"{}\" を検出、行を破棄しました",
                                kind.tag(),
                                line_no,
                                bad
                            ));
                        }
                    }
                }
                pos += 1;
            }
            if pos < len {
                pos += 1; // skip end tag
            }
            // 直前の RpgMap Event に注入する。見つからなければ warning を出して破棄する
            // （寸法チェックは後段任せだが、[マップ] が一度も来ていなければ紐付け先がない）。
            inject_heights_into_last_map(&mut current_events, kind, rows);
            continue;
        }

        // NPC block: [NPC name @x,y 色=#rrggbb (id=xxx)? (sprite=path)? (frames=N)?] ... [/NPC]
        if let Some(header) = trimmed.strip_prefix("[NPC") {
            if header.ends_with(']') {
                let header_inner = header.trim_end_matches(']').trim();
                if let Some(parsed) = parse_npc_header(header_inner) {
                    pos += 1;
                    let mut message: Vec<String> = Vec::new();
                    while pos < len && lines[pos].trim() != "[/NPC]" {
                        // Preserve leading indentation; only strip trailing whitespace
                        message.push(lines[pos].trim_end().to_string());
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
                    let id = match parsed.explicit_id {
                        Some(eid) => resolve_npc_id_conflict(&eid, &current_events),
                        None => slugify_npc_id(&parsed.name, &current_events),
                    };
                    current_events.push(Event::Npc(NpcData {
                        id,
                        name: parsed.name,
                        x: parsed.x,
                        y: parsed.y,
                        color: parsed.color,
                        message,
                        sprite: parsed.sprite,
                        frames: parsed.frames,
                        direction: parsed.direction,
                        portrait: parsed.portrait,
                    }));
                    continue;
                }
            }
        }

        // Master data blocks (#174): [モンスター <id>] / [アイテム <id>] / [呪文 <id>]
        // 共通のキー値ボディを持つ宣言型ブロック。汎用関数（key=value）で書ききれない場合は
        // body 中で `builtin: <slug>` を指定してランタイムの専用関数に委譲する。
        if let Some(parsed) = try_parse_master_data_block(&lines, pos, len) {
            current_events.push(parsed.event);
            pos = parsed.next_pos;
            continue;
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
            // [ボイス: path] は次の Dialog/Narration に注入する (#144)
            if let Some(content) = trimmed
                .strip_prefix('[')
                .and_then(|s| s.strip_suffix(']'))
                .and_then(|s| s.strip_prefix("ボイス:"))
            {
                pending_voice_path = Some(content.trim().to_string());
                pos += 1;
                continue;
            }
            // [フォント: family] は次の Dialog/Narration に注入する (#147)。
            // 値は CSS の font-family 文字列（カンマや空白を含んでよい）を生で保持する。
            // `[フォント: ]` のように空白のみの場合は pending に空文字を残さない (#147 R1 M2)。
            if let Some(content) = trimmed
                .strip_prefix('[')
                .and_then(|s| s.strip_suffix(']'))
                .and_then(|s| s.strip_prefix("フォント:"))
            {
                let trimmed_content = content.trim();
                if !trimmed_content.is_empty() {
                    pending_font_family = Some(trimmed_content.to_string());
                }
                pos += 1;
                continue;
            }
            // [フォント解除] で pending をクリアし、次の行から base (Document.font_family) に戻す (#147)。
            if trimmed == "[フォント解除]" {
                pending_font_family = None;
                pos += 1;
                continue;
            }
            if let Some(event) = parse_directive(trimmed) {
                // [ボイス:] / [フォント:] の後に非テキストディレクティブが挟まった場合は
                // pending を破棄する（誤ったイベントへの注入を防ぐ #144 / #147）
                pending_voice_path = None;
                pending_font_family = None;
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
                    voice_path: pending_voice_path.take(),
                    font_family: pending_font_family.take(),
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
                voice_path: pending_voice_path.take(),
                font_family: pending_font_family.take(),
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
                    voice_path: pending_voice_path.take(),
                    font_family: pending_font_family.take(),
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
        aspect_ratio,
        choice_style,
        font_family,
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
    // [BGM停止] / [BGM停止: 2000] / [BGM停止: フェード=2000] (#145)
    if content == "BGM停止" {
        return Some(Event::Bgm {
            path: None,
            action: BgmAction::Stop,
            fade_ms: None,
        });
    }
    if let Some(rest) = content.strip_prefix("BGM停止:") {
        let fade_ms = parse_audio_fade_args(rest);
        return Some(Event::Bgm {
            path: None,
            action: BgmAction::Stop,
            fade_ms,
        });
    }
    // [BGM: path] / [BGM: path, フェード=500] (#145)
    if let Some(rest) = content.strip_prefix("BGM:") {
        let (path, fade_ms) = parse_audio_path_and_fade(rest);
        return Some(Event::Bgm {
            path: Some(path),
            action: BgmAction::Play,
            fade_ms,
        });
    }
    // [SE: path] / [SE: path, フェード=200] (#145)
    if let Some(rest) = content.strip_prefix("SE:") {
        let (path, fade_ms) = parse_audio_path_and_fade(rest);
        return Some(Event::Se { path, fade_ms });
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

    // [アニメ: target=ナレーター, x=+500, rotation=360, duration=3000, easing=ease-out]
    // 必須: target, duration / 任意: x, y, rotation, scale, easing
    if let Some(rest) = content.strip_prefix("アニメ:") {
        return parse_animate_directive(rest);
    }

    // [枠なし] / [枠あり] (#135)
    if content == "枠なし" {
        return Some(Event::DialogBorderless { borderless: true });
    }
    if content == "枠あり" {
        return Some(Event::DialogBorderless { borderless: false });
    }

    // [シェイク: intensity=10, duration=500] (#143)
    if let Some(rest) = content.strip_prefix("シェイク:") {
        return parse_shake_directive(rest);
    }

    // [フラッシュ: color=#ffffff, alpha=0.8, duration=300] (#143)
    if let Some(rest) = content.strip_prefix("フラッシュ:") {
        return parse_flash_directive(rest);
    }

    // [フェード: target=all, color=#000000, from=0, to=1, duration=500] (#143)
    if let Some(rest) = content.strip_prefix("フェード:") {
        return parse_fade_directive(rest);
    }

    None
}

/// 単一 kv pair（または bare 数字）から fade_ms を取り出す (#145)。
/// `フェード=N` / `fade=N` を受理。`accept_bare_number=true` のとき `=` 無し純数字も fade_ms とみなす。
/// 未知のキー・不正な値・空文字は None を返す（呼び出し側で silent skip）。
fn parse_fade_kv(pair: &str, accept_bare_number: bool) -> Option<u32> {
    let pair = pair.trim();
    if pair.is_empty() {
        return None;
    }
    if let Some((k, v)) = pair.split_once('=') {
        match k.trim() {
            "フェード" | "fade" => v.trim().parse::<u32>().ok(),
            _ => None,
        }
    } else if accept_bare_number {
        pair.parse::<u32>().ok()
    } else {
        None
    }
}

/// `[BGM: path, フェード=500]` / `[SE: path, フェード=200]` の本体を分解する (#145)。
/// 最初の `,` 区切り要素を path、残りを kv ペアとして解釈する。
/// kv は `フェード` / `fade` のみ受理。Play 系は path との曖昧さを避けるため bare 数字は受理しない
/// （Stop 系の `[BGM停止: 2000]` のみ bare 数字を許容）。
/// 未知のキーや不正な値は silent skip する（後方互換重視）。
fn parse_audio_path_and_fade(content: &str) -> (String, Option<u32>) {
    let mut parts = content.split(',');
    let path = parts
        .next()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mut fade_ms: Option<u32> = None;
    for raw in parts {
        if let Some(n) = parse_fade_kv(raw, false) {
            fade_ms = Some(n);
        }
    }
    (path, fade_ms)
}

/// `[BGM停止: 2000]` / `[BGM停止: フェード=2000]` の引数部分を fade_ms として解釈する (#145)。
/// bare 数字 / `フェード=` / `fade=` を受理。複数指定時は最後の有効値が勝つ。
fn parse_audio_fade_args(content: &str) -> Option<u32> {
    let mut fade_ms: Option<u32> = None;
    for raw in content.split(',') {
        if let Some(n) = parse_fade_kv(raw, true) {
            fade_ms = Some(n);
        }
    }
    fade_ms
}

fn parse_shake_directive(content: &str) -> Option<Event> {
    let mut intensity_px: u32 = 10;
    let mut duration_ms: u32 = 500;

    for raw_pair in content.split(',') {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        if let Some((k, v)) = pair.split_once('=') {
            match k.trim() {
                "intensity" | "強度" => {
                    if let Ok(v) = v.trim().parse() {
                        intensity_px = v;
                    }
                }
                "duration" | "時間" => {
                    if let Ok(v) = v.trim().parse() {
                        duration_ms = v;
                    }
                }
                _ => {}
            }
        }
    }

    Some(Event::Shake {
        intensity_px,
        duration_ms,
    })
}

fn parse_flash_directive(content: &str) -> Option<Event> {
    let mut color = "#ffffff".to_string();
    let mut alpha: f32 = 0.8;
    let mut duration_ms: u32 = 300;

    for raw_pair in content.split(',') {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        if let Some((k, v)) = pair.split_once('=') {
            match k.trim() {
                "color" | "色" => color = v.trim().to_string(),
                "alpha" | "不透明度" => {
                    if let Ok(v) = v.trim().parse() {
                        alpha = v;
                    }
                }
                "duration" | "時間" => {
                    if let Ok(v) = v.trim().parse() {
                        duration_ms = v;
                    }
                }
                _ => {}
            }
        }
    }

    Some(Event::Flash {
        color,
        alpha,
        duration_ms,
    })
}

fn parse_fade_directive(content: &str) -> Option<Event> {
    let mut target = "all".to_string();
    let mut color = "#000000".to_string();
    let mut from_alpha: f32 = 0.0;
    let mut to_alpha: f32 = 1.0;
    let mut duration_ms: u32 = 500;

    for raw_pair in content.split(',') {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        if let Some((k, v)) = pair.split_once('=') {
            match k.trim() {
                "target" | "対象" => target = v.trim().to_string(),
                "color" | "色" => color = v.trim().to_string(),
                "from" | "開始" => {
                    if let Ok(v) = v.trim().parse() {
                        from_alpha = v;
                    }
                }
                "to" | "終了" => {
                    if let Ok(v) = v.trim().parse() {
                        to_alpha = v;
                    }
                }
                "duration" | "時間" => {
                    if let Ok(v) = v.trim().parse() {
                        duration_ms = v;
                    }
                }
                _ => {}
            }
        }
    }

    Some(Event::Fade {
        target,
        color,
        from_alpha,
        to_alpha,
        duration_ms,
    })
}

fn parse_animate_directive(content: &str) -> Option<Event> {
    use crate::models::Easing;

    let mut target: Option<String> = None;
    let mut dx: Option<String> = None;
    let mut dy: Option<String> = None;
    let mut rotation: Option<String> = None;
    let mut scale: Option<f32> = None;
    let mut duration_ms: Option<u32> = None;
    let mut easing = Easing::Linear;

    for raw_pair in content.split(',') {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => return None, // 不正な構文
        };
        match key {
            "target" | "対象" => target = Some(value.to_string()),
            "x" => dx = Some(value.to_string()),
            "y" => dy = Some(value.to_string()),
            "rotation" | "回転" => rotation = Some(value.to_string()),
            "scale" | "拡縮" => scale = value.parse().ok(),
            "duration" | "時間" => duration_ms = value.parse().ok(),
            "easing" => {
                easing = match value.to_ascii_lowercase().as_str() {
                    "linear" => Easing::Linear,
                    "ease-in" | "easein" => Easing::EaseIn,
                    "ease-out" | "easeout" => Easing::EaseOut,
                    "ease-in-out" | "easeinout" => Easing::EaseInOut,
                    _ => Easing::Linear,
                }
            }
            _ => {} // 未知キーは silent skip
        }
    }

    let target = target?;
    let duration_ms = duration_ms?;
    Some(Event::Animate {
        target,
        dx,
        dy,
        rotation,
        scale,
        duration_ms,
        easing,
    })
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

/// Parse NPC header: "name @x,y 色=#rrggbb (id=xxx)?" → Some((name, x, y, color, explicit_id))
pub(crate) struct ParsedNpcHeader {
    pub name: String,
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub explicit_id: Option<String>,
    pub sprite: Option<String>,
    pub frames: Option<u32>,
    pub direction: Option<Direction>,
    pub portrait: Option<String>,
}

fn parse_npc_header(s: &str) -> Option<ParsedNpcHeader> {
    // Extract name (before @), then @x,y, then 色=... / id=... / sprite=... / frames=...
    let at_pos = s.find('@')?;
    let name = s[..at_pos].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let after_at = &s[at_pos + 1..];
    // split by whitespace to separate x,y from attribute tokens
    let mut parts = after_at.split_whitespace();
    let coord = parts.next()?;
    let (x_str, y_str) = coord.split_once(',')?;
    let x: u32 = x_str.trim().parse().ok()?;
    let y: u32 = y_str.trim().parse().ok()?;
    // color: default 0xff6b6b
    let mut color: u32 = 0xff6b6b;
    let mut explicit_id: Option<String> = None;
    let mut sprite: Option<String> = None;
    let mut frames: Option<u32> = None;
    let mut direction: Option<Direction> = None;
    let mut portrait: Option<String> = None;
    for p in parts {
        if let Some(val) = p.strip_prefix("色=") {
            let hex = val.trim().trim_start_matches('#');
            if let Ok(n) = u32::from_str_radix(hex, 16) {
                color = n;
            }
        } else if let Some(val) = p.strip_prefix("id=") {
            let v = val.trim().to_string();
            if !v.is_empty() {
                explicit_id = Some(v);
            }
        } else if let Some(val) = p.strip_prefix("sprite=") {
            let v = val.trim().to_string();
            if !v.is_empty() {
                sprite = Some(v);
            }
        } else if let Some(val) = p.strip_prefix("frames=") {
            if let Ok(n) = val.trim().parse::<u32>() {
                if n >= 1 {
                    frames = Some(n);
                }
            }
        } else if let Some(val) = p.strip_prefix("向き=") {
            direction = Some(parse_direction(val.trim()));
        } else if let Some(val) = p.strip_prefix("portrait=") {
            let v = val.trim().to_string();
            if !v.is_empty() {
                portrait = Some(v);
            }
        }
    }
    Some(ParsedNpcHeader {
        name,
        x,
        y,
        color,
        explicit_id,
        sprite,
        frames,
        direction,
        portrait,
    })
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
        _ => {
            emit_unknown_direction_warning(s);
            Direction::Down
        }
    }
}

/// Emit a warning about an unknown direction value. The parser still falls back to
/// `Down` for compatibility, but the user sees a warning about the typo.
fn emit_unknown_direction_warning(value: &str) {
    let msg = format!(
        "[name-name-parser] warning: unknown direction '{}', falling back to down. Expected one of: up/down/left/right or 上/下/左/右",
        value
    );
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::console::warn_1(&msg.into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("{}", msg);
    }
}

/// Compute the base slug for an NPC name. Returns `None` if the name has no
/// slug-able characters (caller falls back to `npc{index}`).
pub(crate) fn npc_base_slug(name: &str) -> Option<String> {
    let slug: String = name
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
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

/// Generate a unique id for an NPC from its name. If name is non-ASCII,
/// fall back to "npc{index}". If an NPC with the same id already exists
/// in the current events, append -2, -3, etc.
fn slugify_npc_id(name: &str, existing: &[Event]) -> String {
    let base = npc_base_slug(name).unwrap_or_else(|| {
        let count = existing
            .iter()
            .filter(|e| matches!(e, Event::Npc(_)))
            .count();
        format!("npc{}", count + 1)
    });
    resolve_npc_id_conflict(&base, existing)
}

/// Given a desired NPC id (explicit or slugged), append -2, -3, ... if it
/// collides with an NPC already present in `existing`.
fn resolve_npc_id_conflict(base: &str, existing: &[Event]) -> String {
    let mut candidate = base.to_string();
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

/// Parse the title portion of a scene header and extract an optional
/// `[view=xxx]` trailing directive. Returns the cleaned title and the
/// resolved SceneView. Unknown view values fall back to `TopDown` with
/// a warning.
fn parse_scene_title_and_view(title_raw: &str) -> (String, SceneView) {
    let s = title_raw.trim();
    // Look for a trailing [view=...] marker.
    if s.ends_with(']') {
        if let Some(open) = s.rfind('[') {
            let inside = &s[open + 1..s.len() - 1];
            if let Some(val) = inside.strip_prefix("view=") {
                let val = val.trim();
                let cleaned = s[..open].trim_end().to_string();
                let view = match val {
                    "topdown" | "TopDown" => SceneView::TopDown,
                    "raycast" | "Raycast" => SceneView::Raycast,
                    other => {
                        emit_unknown_view_warning(other);
                        SceneView::TopDown
                    }
                };
                return (cleaned, view);
            }
        }
    }
    (s.to_string(), SceneView::TopDown)
}

fn emit_unknown_view_warning(value: &str) {
    let msg = format!(
        "[name-name-parser] warning: unknown scene view '{}', falling back to topdown",
        value
    );
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::console::warn_1(&msg.into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("{}", msg);
    }
}

/// Emit a warning about map dimension mismatch. On native targets this goes
/// to stderr via `eprintln!`; on `wasm32` it goes through `console.warn`.
fn emit_map_dimension_warning(width: u32, height: u32, raw_rows: &[&str]) {
    let actual_rows = raw_rows.len();
    let row_widths: Vec<usize> = raw_rows.iter().map(|r| r.chars().count()).collect();
    emit_warning(&format!(
        "[name-name-parser] warning: map dimensions mismatch — declared {}x{}, got {} rows with widths {:?}",
        width, height, actual_rows, row_widths
    ));
}

/// 高さブロックの種別。tag() で `[...]` 内部の日本語ラベルを返す。
///
// TODO: warnings を Document の warnings フィールドに集約し、frontend で
//       エディタ UI が視覚的に表示できる仕組みを検討（現状は eprintln のみ）。
//       将来 warnings を `Document` フィールドに集約する際は、`#[cfg(test)]` での
//       出力抑制をやめ、`Vec<String>` に貯めてテストから検証可能にする設計に変える。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeightKind {
    Wall,
    Floor,
    Ceiling,
}

impl HeightKind {
    fn tag(self) -> &'static str {
        match self {
            HeightKind::Wall => "壁高さ",
            HeightKind::Floor => "床高さ",
            HeightKind::Ceiling => "天井高さ",
        }
    }
}

/// 行が高さブロックの開始タグ（`[壁高さ]` / `[床高さ]` / `[天井高さ]`）かを判定する。
/// 呼び出し側で trim 済み前提（parser ループ 167 行目で `trimmed` を渡す）。
/// `[マップ ...]` 系のような属性は現状なし。
fn detect_height_block(line: &str) -> Option<HeightKind> {
    match line {
        "[壁高さ]" => Some(HeightKind::Wall),
        "[床高さ]" => Some(HeightKind::Floor),
        "[天井高さ]" => Some(HeightKind::Ceiling),
        _ => None,
    }
}

/// 高さブロックの行データを、**直前の** `Event::RpgMap` にのみ注入する。
/// spec（「直前の `[マップ]` ブロックに紐付けられる」）と一致させるため、
/// `events.last_mut()` を見る。直前の Event が RpgMap でなければ破棄。
/// 既に該当フィールドが埋まっていれば「後勝ち」で上書きし警告を出す。
/// 空ブロック（`rows.is_empty()`）は inject せず警告を出す。
/// 行の列数がジャグっていたら警告だけ出し、値は保持する（validateMapHeights に委ねる）。
fn inject_heights_into_last_map(events: &mut [Event], kind: HeightKind, rows: Vec<Vec<f64>>) {
    // 空ブロックは注入しない（Some(vec![]) が frontend に漏れると
    // validateMapHeights が row-count-mismatch を誤検出する）。
    if rows.is_empty() {
        emit_height_block_warning(&format!("[{}] ブロックが空です。無視します", kind.tag()));
        return;
    }

    // ジャグ配列チェック（警告だけ、破棄はしない）。
    if let Some(first_len) = rows.first().map(|r| r.len()) {
        if rows.iter().any(|r| r.len() != first_len) {
            emit_height_block_warning(&format!("[{}] 各行の列数が不揃いです", kind.tag()));
        }
    }

    // 末尾が RpgMap でなければ破棄。
    match events.last_mut() {
        Some(Event::RpgMap(map)) => {
            let slot: &mut Option<Vec<Vec<f64>>> = match kind {
                HeightKind::Wall => &mut map.wall_heights,
                HeightKind::Floor => &mut map.floor_heights,
                HeightKind::Ceiling => &mut map.ceiling_heights,
            };
            if slot.is_some() {
                // 「最後勝ち」に変更。エディタで上書きしたとき後から書いた方が勝つほうが直感的。
                emit_height_block_warning(&format!(
                    "[{}] ブロックが重複しています。後の定義で上書きしました",
                    kind.tag()
                ));
            }
            *slot = Some(rows);
        }
        _ => {
            emit_height_block_warning(&format!(
                "[{}] ブロックの直前が [マップ] ではありません。破棄しました",
                kind.tag()
            ));
        }
    }
}

fn emit_height_block_warning(detail: &str) {
    emit_warning(&format!("[name-name-parser] warning: {}", detail));
}

/// `[/マップ]` 欠落時の警告。行頭 `[` で始まる別ブロックが突入した時点で
/// マップブロックを打ち切るため、既に収集した行数を報告する。
fn emit_map_close_missing_warning(width: u32, height: u32, collected_rows: usize) {
    emit_warning(&format!(
        "[name-name-parser] warning: [/マップ] が見つからないうちに別ブロックが開始されました — 宣言 {}x{}, 収集済み {} 行",
        width, height, collected_rows
    ));
}

/// 共通の warning 出力ヘルパー。
/// - native (`cfg(test)` なし): stderr に出力する
/// - native + test: 何もしない（テスト中の stderr 汚染防止）
/// - wasm32: `console.warn` へ流す
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
fn emit_warning(msg: &str) {
    eprintln!("{}", msg);
}

#[cfg(all(not(target_arch = "wasm32"), test))]
fn emit_warning(_msg: &str) {
    // suppress during tests
}

#[cfg(target_arch = "wasm32")]
fn emit_warning(msg: &str) {
    web_sys::console::warn_1(&msg.into());
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

// ===== Master data blocks (#174) =====

struct ParsedMasterBlock {
    event: Event,
    next_pos: usize,
}

/// `[モンスター <id>]` / `[アイテム <id>]` / `[呪文 <id>]` のいずれかを検出して
/// ボディの key: value ペアからオブジェクトを組み立てる。検出に失敗（ヘッダ形式不一致 /
/// 必須項目欠落）した場合は `None` を返し、呼び出し側は次の解釈ルートへ進む。
fn try_parse_master_data_block(
    lines: &[&str],
    pos: usize,
    len: usize,
) -> Option<ParsedMasterBlock> {
    let header = lines[pos].trim();
    let (kind, id, close_tag) = parse_master_block_header(header)?;
    let body = collect_master_body(lines, pos + 1, len, close_tag);
    let next_pos = body.next_pos;

    let event = match kind {
        MasterKind::Monster => Event::Monster(build_monster_def(id, &body.entries)?),
        MasterKind::Item => Event::Item(build_item_def(id, &body.entries)),
        MasterKind::Spell => Event::Spell(build_spell_def(id, &body.entries)?),
    };

    Some(ParsedMasterBlock { event, next_pos })
}

#[derive(Clone, Copy)]
enum MasterKind {
    Monster,
    Item,
    Spell,
}

fn parse_master_block_header(header: &str) -> Option<(MasterKind, String, &'static str)> {
    if let Some(rest) = header.strip_prefix("[モンスター ") {
        let id = rest.strip_suffix(']')?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        return Some((MasterKind::Monster, id, "[/モンスター]"));
    }
    if let Some(rest) = header.strip_prefix("[アイテム ") {
        let id = rest.strip_suffix(']')?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        return Some((MasterKind::Item, id, "[/アイテム]"));
    }
    if let Some(rest) = header.strip_prefix("[呪文 ") {
        let id = rest.strip_suffix(']')?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        return Some((MasterKind::Spell, id, "[/呪文]"));
    }
    None
}

struct MasterBody {
    entries: Vec<(String, String)>,
    next_pos: usize,
}

fn collect_master_body(lines: &[&str], start: usize, len: usize, close_tag: &str) -> MasterBody {
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut p = start;
    while p < len && lines[p].trim() != close_tag {
        let line = lines[p].trim();
        if !line.is_empty() {
            if let Some((k, v)) = line.split_once(':') {
                entries.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        p += 1;
    }
    if p < len {
        p += 1; // skip close tag
    }
    MasterBody {
        entries,
        next_pos: p,
    }
}

fn lookup_master_value<'a>(entries: &'a [(String, String)], keys: &[&str]) -> Option<&'a str> {
    for (k, v) in entries {
        if keys.iter().any(|key| k == key) {
            return Some(v.as_str());
        }
    }
    None
}

fn lookup_master_u32(entries: &[(String, String)], keys: &[&str], default: u32) -> u32 {
    lookup_master_value(entries, keys)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn lookup_master_string(entries: &[(String, String)], keys: &[&str]) -> Option<String> {
    lookup_master_value(entries, keys).map(|s| s.to_string())
}

fn build_monster_def(id: String, entries: &[(String, String)]) -> Option<MonsterDef> {
    let name = lookup_master_string(entries, &["名前", "name"])?;
    if name.is_empty() {
        return None;
    }
    Some(MonsterDef {
        id,
        name,
        hp: lookup_master_u32(entries, &["HP", "hp"], 1),
        mp: lookup_master_u32(entries, &["MP", "mp"], 0),
        atk: lookup_master_u32(entries, &["ATK", "atk", "攻撃"], 0),
        def_value: lookup_master_u32(entries, &["DEF", "def", "守備"], 0),
        agi: lookup_master_u32(entries, &["AGI", "agi", "素早さ"], 0),
        exp: lookup_master_u32(entries, &["EXP", "exp", "経験値"], 0),
        gold: lookup_master_u32(entries, &["GOLD", "gold", "G", "ゴールド"], 0),
        sprite: lookup_master_string(entries, &["スプライト", "sprite"]),
        builtin: lookup_master_string(entries, &["builtin"]),
    })
}

fn build_item_def(id: String, entries: &[(String, String)]) -> ItemDef {
    let name = lookup_master_string(entries, &["名前", "name"]).unwrap_or_default();
    let kind = lookup_master_string(entries, &["種別", "kind"])
        .unwrap_or_else(|| "その他".to_string());
    ItemDef {
        id,
        name,
        kind,
        price: lookup_master_value(entries, &["価格", "price"]).and_then(|v| v.parse().ok()),
        effect: lookup_master_string(entries, &["効果", "effect"]),
        builtin: lookup_master_string(entries, &["builtin"]),
    }
}

fn build_spell_def(id: String, entries: &[(String, String)]) -> Option<SpellDef> {
    let name = lookup_master_string(entries, &["名前", "name"])?;
    if name.is_empty() {
        return None;
    }
    let target = lookup_master_string(entries, &["対象", "target"])
        .unwrap_or_else(|| "敵単体".to_string());
    Some(SpellDef {
        id,
        name,
        mp: lookup_master_u32(entries, &["MP", "mp"], 0),
        target,
        effect: lookup_master_string(entries, &["効果", "effect"]),
        builtin: lookup_master_string(entries, &["builtin"]),
        school: lookup_master_string(entries, &["系統", "school"]),
    })
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
                ..
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
                action: BgmAction::Play,
                fade_ms: None,
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
                path: "se_test.ogg".to_string(),
                fade_ms: None,
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
                action: BgmAction::Stop,
                fade_ms: None,
            }
        );
    }

    #[test]
    fn test_parse_animate_directive() {
        let input = r#"---
engine: name-name
chapter: 1
title: "アニメテスト"
---

## anim: アニメ

[アニメ: target=ナレーター, x=+500, rotation=360, duration=3000, easing=ease-out]
[アニメ: target=車, scale=1.5, duration=1500]
[アニメ: target=寿司, y=-200, duration=800, easing=ease-in]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 3);
        if let Event::Animate {
            target,
            dx,
            rotation,
            duration_ms,
            easing,
            ..
        } = &events[0]
        {
            assert_eq!(target, "ナレーター");
            assert_eq!(dx.as_deref(), Some("+500"));
            assert_eq!(rotation.as_deref(), Some("360"));
            assert_eq!(*duration_ms, 3000);
            assert_eq!(*easing, crate::models::Easing::EaseOut);
        } else {
            panic!("expected Animate, got {:?}", events[0]);
        }
        if let Event::Animate {
            target,
            scale,
            duration_ms,
            easing,
            ..
        } = &events[1]
        {
            assert_eq!(target, "車");
            assert_eq!(*scale, Some(1.5));
            assert_eq!(*duration_ms, 1500);
            assert_eq!(*easing, crate::models::Easing::Linear);
        } else {
            panic!("expected Animate, got {:?}", events[1]);
        }
        if let Event::Animate {
            target, dy, easing, ..
        } = &events[2]
        {
            assert_eq!(target, "寿司");
            assert_eq!(dy.as_deref(), Some("-200"));
            assert_eq!(*easing, crate::models::Easing::EaseIn);
        } else {
            panic!("expected Animate, got {:?}", events[2]);
        }
    }

    #[test]
    fn test_animate_directive_japanese_keys() {
        // 日本語キーの別名 (target=対象, rotation=回転, scale=拡縮, duration=時間) も受理する
        let input = r#"---
engine: name-name
chapter: 1
title: "JP"
---

## s: テスト

[アニメ: 対象=車, 回転=180, 拡縮=2, 時間=2000]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        if let Event::Animate {
            target,
            rotation,
            scale,
            duration_ms,
            ..
        } = &events[0]
        {
            assert_eq!(target, "車");
            assert_eq!(rotation.as_deref(), Some("180"));
            assert_eq!(*scale, Some(2.0));
            assert_eq!(*duration_ms, 2000);
        } else {
            panic!("expected Animate");
        }
    }

    #[test]
    fn test_animate_directive_missing_required() {
        // target / duration が欠けると Animate は生成されず directive は捨てられる
        let input = r#"---
engine: name-name
chapter: 1
title: "miss"
---

## s: テスト

[アニメ: x=+100, duration=1000]
[アニメ: target=車]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        // どちらも捨てられる
        assert_eq!(events.len(), 0);
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
        assert!(doc.chapters[0].hidden);
        assert_eq!(doc.chapters[0].default_bgm, Some("test.ogg".to_string()));
    }

    #[test]
    fn test_dialog_borderless() {
        let input = "## 1-1: テスト\n[枠なし]\n> こんにちは\n[枠あり]\n";
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 3);
        assert!(
            matches!(&events[0], Event::DialogBorderless { borderless: true }),
            "expected DialogBorderless(true), got {:?}",
            events[0]
        );
        assert!(
            matches!(&events[1], Event::Narration { .. }),
            "expected Narration, got {:?}",
            events[1]
        );
        assert!(
            matches!(&events[2], Event::DialogBorderless { borderless: false }),
            "expected DialogBorderless(false), got {:?}",
            events[2]
        );
    }

    // ===== Master data blocks (#174) =====

    #[test]
    fn parses_monster_block_with_all_fields() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[モンスター slime]
名前: スライム
HP: 10
MP: 0
ATK: 3
DEF: 1
AGI: 2
EXP: 2
GOLD: 1
スプライト: monsters/slime.png
[/モンスター]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::Monster(m) => {
                assert_eq!(m.id, "slime");
                assert_eq!(m.name, "スライム");
                assert_eq!(m.hp, 10);
                assert_eq!(m.mp, 0);
                assert_eq!(m.atk, 3);
                assert_eq!(m.def_value, 1);
                assert_eq!(m.agi, 2);
                assert_eq!(m.exp, 2);
                assert_eq!(m.gold, 1);
                assert_eq!(m.sprite.as_deref(), Some("monsters/slime.png"));
                assert_eq!(m.builtin, None);
            }
            other => panic!("expected Monster, got {:?}", other),
        }
    }

    #[test]
    fn monster_block_without_name_is_dropped() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[モンスター nameless]
HP: 5
[/モンスター]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 0, "block without 名前 should be dropped");
    }

    #[test]
    fn parses_item_block_with_effect() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[アイテム やくそう]
名前: やくそう
種別: 回復
価格: 8
効果: heal 30
[/アイテム]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::Item(it) => {
                assert_eq!(it.id, "やくそう");
                assert_eq!(it.name, "やくそう");
                assert_eq!(it.kind, "回復");
                assert_eq!(it.price, Some(8));
                assert_eq!(it.effect.as_deref(), Some("heal 30"));
                assert_eq!(it.builtin, None);
            }
            other => panic!("expected Item, got {:?}", other),
        }
    }

    #[test]
    fn parses_spell_block_with_builtin() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[呪文 ザラキ]
名前: ザラキ
MP: 8
対象: 敵全体
builtin: zaraki
[/呪文]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::Spell(sp) => {
                assert_eq!(sp.id, "ザラキ");
                assert_eq!(sp.name, "ザラキ");
                assert_eq!(sp.mp, 8);
                assert_eq!(sp.target, "敵全体");
                assert_eq!(sp.builtin.as_deref(), Some("zaraki"));
                assert_eq!(sp.effect, None);
                assert_eq!(sp.school, None);
            }
            other => panic!("expected Spell, got {:?}", other),
        }
    }

    #[test]
    fn parses_spell_block_with_declarative_effect_and_school() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[呪文 メラ]
名前: メラ
MP: 2
対象: 敵単体
系統: fire
効果: damage 8..14 type=fire
[/呪文]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::Spell(sp) => {
                assert_eq!(sp.school.as_deref(), Some("fire"));
                assert_eq!(sp.effect.as_deref(), Some("damage 8..14 type=fire"));
            }
            other => panic!("expected Spell, got {:?}", other),
        }
    }

    #[test]
    fn english_keys_are_accepted() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[モンスター ghost]
name: ゴースト
hp: 14
atk: 5
def: 2
agi: 6
exp: 4
gold: 3
[/モンスター]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::Monster(m) => {
                assert_eq!(m.name, "ゴースト");
                assert_eq!(m.hp, 14);
                assert_eq!(m.def_value, 2);
            }
            other => panic!("expected Monster, got {:?}", other),
        }
    }

    #[test]
    fn item_kind_defaults_to_その他() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[アイテム mystery]
名前: なぞの石
[/アイテム]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::Item(it) => {
                assert_eq!(it.kind, "その他");
                assert_eq!(it.price, None);
            }
            other => panic!("expected Item, got {:?}", other),
        }
    }
}
