use crate::master::try_parse_master_data_block;
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
                        encounter_rate: None,
                        encounter_groups: None,
                    }));
                    continue;
                }
            }
        }

        // エンカウント率 (#172): 直前の RpgMap に注入する単行ディレクティブ
        // [エンカウント率: 16] / [エンカウント率: 1/16]（後者は分母 16 を抽出）/
        // [エンカウント率: 0]（安全マップ：街・室内）
        if let Some(content) = trimmed
            .strip_prefix("[エンカウント率:")
            .and_then(|s| s.strip_suffix(']'))
        {
            if let Some(rate) = parse_encounter_rate(content.trim()) {
                inject_encounter_rate_into_last_map(&mut current_events, rate);
            }
            pos += 1;
            continue;
        }
        // エンカウント群 (#172): 直前の RpgMap に注入。
        // [エンカウント群: slime, ghost, slime+skeleton]
        if let Some(content) = trimmed
            .strip_prefix("[エンカウント群:")
            .and_then(|s| s.strip_suffix(']'))
        {
            let groups: Vec<String> = content
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !groups.is_empty() {
                inject_encounter_groups_into_last_map(&mut current_events, groups);
            }
            pos += 1;
            continue;
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
                        expressions: parsed.expressions,
                        scene: parsed.scene,
                    }));
                    continue;
                }
            }
        }

        // RpgEvent block: [イベント <name>] ... [/イベント]
        if let Some(header) = trimmed.strip_prefix("[イベント ") {
            if header.ends_with(']') {
                let name = header.trim_end_matches(']').trim().to_string();
                if !name.is_empty() {
                    pos += 1;
                    let mut commands: Vec<EventCommand> = Vec::new();
                    let mut pending_dialog_char: Option<String> = None;
                    let mut pending_dialog_lines: Vec<String> = Vec::new();
                    while pos < len && lines[pos].trim() != "[/イベント]" {
                        let cmd_line = lines[pos].trim();
                        // [NPC移動: <npc> → @x,y 速度=N 向き=<dir>]
                        if let Some(rest) = cmd_line.strip_prefix("[NPC移動:") {
                            if rest.ends_with(']') {
                                // flush pending dialog
                                if let Some(char) = pending_dialog_char.take() {
                                    if !pending_dialog_lines.is_empty() {
                                        commands.push(EventCommand::Dialog {
                                            character: Some(char),
                                            text: std::mem::take(&mut pending_dialog_lines),
                                        });
                                    }
                                    // text が空の場合は話者行だけで終わったとみなし、skip
                                } else if !pending_dialog_lines.is_empty() {
                                    commands.push(EventCommand::Dialog {
                                        character: None,
                                        text: std::mem::take(&mut pending_dialog_lines),
                                    });
                                }
                                let inner = rest.trim_end_matches(']').trim();
                                if let Some(cmd) = parse_npc_move_command(inner) {
                                    commands.push(cmd);
                                }
                                pos += 1;
                                continue;
                            }
                        }
                        // [待機: N]
                        if let Some(rest) = cmd_line.strip_prefix("[待機:") {
                            if rest.ends_with(']') {
                                if let Some(char) = pending_dialog_char.take() {
                                    if !pending_dialog_lines.is_empty() {
                                        commands.push(EventCommand::Dialog {
                                            character: Some(char),
                                            text: std::mem::take(&mut pending_dialog_lines),
                                        });
                                    }
                                } else if !pending_dialog_lines.is_empty() {
                                    commands.push(EventCommand::Dialog {
                                        character: None,
                                        text: std::mem::take(&mut pending_dialog_lines),
                                    });
                                }
                                let ms_str = rest.trim_end_matches(']').trim();
                                if let Ok(ms) = ms_str.parse::<u32>() {
                                    commands.push(EventCommand::Wait { ms });
                                }
                                pos += 1;
                                continue;
                            }
                        }
                        // > テキスト → Narration
                        if cmd_line.starts_with("> ") {
                            if let Some(char) = pending_dialog_char.take() {
                                if !pending_dialog_lines.is_empty() {
                                    commands.push(EventCommand::Dialog {
                                        character: Some(char),
                                        text: std::mem::take(&mut pending_dialog_lines),
                                    });
                                }
                            } else if !pending_dialog_lines.is_empty() {
                                commands.push(EventCommand::Dialog {
                                    character: None,
                                    text: std::mem::take(&mut pending_dialog_lines),
                                });
                            }
                            let mut narr_lines: Vec<String> = Vec::new();
                            while pos < len {
                                let l = lines[pos].trim();
                                if l.starts_with("> ") {
                                    narr_lines.push(l.strip_prefix("> ").unwrap_or("").to_string());
                                    pos += 1;
                                } else {
                                    break;
                                }
                            }
                            commands.push(EventCommand::Narration { text: narr_lines });
                            continue;
                        }
                        // **キャラ**: → Dialog speaker
                        if cmd_line.starts_with("**") && is_speaker_line(cmd_line) {
                            if let Some(char) = pending_dialog_char.take() {
                                if !pending_dialog_lines.is_empty() {
                                    commands.push(EventCommand::Dialog {
                                        character: Some(char),
                                        text: std::mem::take(&mut pending_dialog_lines),
                                    });
                                }
                                // text が空の場合は話者行だけで終わったとみなし、skip
                            } else if !pending_dialog_lines.is_empty() {
                                commands.push(EventCommand::Dialog {
                                    character: None,
                                    text: std::mem::take(&mut pending_dialog_lines),
                                });
                            }
                            let after_stars = &cmd_line[2..];
                            let name_end = after_stars.find("**").unwrap_or(after_stars.len());
                            pending_dialog_char = Some(after_stars[..name_end].to_string());
                            pos += 1;
                            continue;
                        }
                        // empty line flushes dialog
                        if cmd_line.is_empty() {
                            if let Some(char) = pending_dialog_char.take() {
                                if !pending_dialog_lines.is_empty() {
                                    commands.push(EventCommand::Dialog {
                                        character: Some(char),
                                        text: std::mem::take(&mut pending_dialog_lines),
                                    });
                                }
                            } else if !pending_dialog_lines.is_empty() {
                                commands.push(EventCommand::Dialog {
                                    character: None,
                                    text: std::mem::take(&mut pending_dialog_lines),
                                });
                            }
                            pos += 1;
                            continue;
                        }
                        // plain text → dialog lines
                        if !cmd_line.starts_with('[') {
                            pending_dialog_lines.push(cmd_line.to_string());
                            pos += 1;
                            continue;
                        }
                        pos += 1;
                    }
                    // flush pending dialog at end
                    if let Some(char) = pending_dialog_char.take() {
                        if !pending_dialog_lines.is_empty() {
                            commands.push(EventCommand::Dialog {
                                character: Some(char),
                                text: pending_dialog_lines,
                            });
                        }
                        // text が空の場合は話者行だけで終わったとみなし、skip
                    } else if !pending_dialog_lines.is_empty() {
                        commands.push(EventCommand::Dialog {
                            character: None,
                            text: pending_dialog_lines,
                        });
                    }
                    if pos < len {
                        pos += 1; // skip [/イベント]
                    } else {
                        eprintln!(
                            "[name-name] 警告: [イベント {name}] に対応する [/イベント] がありません"
                        );
                    }
                    current_events.push(Event::RpgEvent { name, commands });
                    continue;
                }
            }
        }

        // RpgTrigger: [トリガー @x,y scene=xxx once=true] or [トリガー auto scene=xxx]
        if let Some(rest) = trimmed.strip_prefix("[トリガー ") {
            if rest.ends_with(']') {
                let inner = rest.trim_end_matches(']').trim();
                if let Some(trigger) = parse_trigger_line(inner) {
                    current_events.push(trigger);
                    pos += 1;
                    continue;
                }
            }
        }

        // Master data blocks (#174): [モンスター <id>] / [アイテム <id>] / [呪文 <id>]        // 共通のキー値ボディを持つ宣言型ブロック。汎用関数（key=value）で書ききれない場合は
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
            // body が空でも Dialog を発行する (立ち絵だけ登場させて台詞は無し、
            // のような動画用途で必要)。renderer 側で空テキストはタイプライタ抑制する。
            current_events.push(Event::Dialog {
                character: Some(character),
                expression,
                position,
                text: if text_lines.is_empty() {
                    vec![String::new()]
                } else {
                    text_lines
                },
                voice_path: pending_voice_path.take(),
                font_family: pending_font_family.take(),
            });
            continue;
        }

        // Narration: > テキスト
        // `>` 単独 (空 Narration) もサポートする。voice 注入用途で「テキストを画面に出さず voice
        // だけ Dialog/Narration に紐付けたい」ケース (例: [タイトル:] の voice 紐付け) で使う。
        // trim() で全角空白も削除されるため `> 　` のような書き方は空 `>` として処理される。
        if trimmed == ">" || trimmed.starts_with("> ") {
            let mut narration_lines: Vec<String> = Vec::new();
            while pos < len {
                let t = lines[pos].trim();
                if t == ">" {
                    narration_lines.push(String::new());
                    pos += 1;
                } else if let Some(rest) = t.strip_prefix("> ") {
                    narration_lines.push(rest.to_string());
                    pos += 1;
                } else {
                    break;
                }
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
        "---\nengine: name-name\nchapter: 1\ntitle: \"tmp\"\n---\n\n## tmp-1: tmp\n\n{input}"
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

    // [背景色: #f5f0e8] — 単色の地色 (#273)。
    // strip_prefix("背景:") は "背景色: …" にマッチしない（3 文字目が ':' でなく '色'）ため
    // 順序非依存だが、意図を明示するため「背景:」より前に置く。
    if let Some(rest) = content.strip_prefix("背景色:") {
        return Some(Event::BackgroundColor {
            color: rest.trim().to_string(),
        });
    }
    if let Some(rest) = content.strip_prefix("背景:") {
        return Some(parse_background_directive(rest));
    }
    // [動画退場] — 動画レイヤをクリア (#252)。「動画:」より先に完全一致で判定する。
    if content == "動画退場" {
        return Some(Event::VideoExit);
    }
    if let Some(rest) = content.strip_prefix("動画:") {
        return Some(parse_video_directive(rest));
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

    // [文字演出: Title, 効果=爆発, 間隔=80] — グリフ単位の文字アニメ (#268)
    // 必須: target / 任意: 効果(爆発|タイプ), 間隔, 速度, dy/dx/rotation/scale/alpha, duration, easing,
    //       カーソル/点滅/カーソル色 (効果=タイプ 専用, #271)
    if let Some(rest) = content.strip_prefix("文字演出:") {
        return parse_text_effect_directive(rest);
    }

    // [下線: Title, 色=#1a4a7a, 太さ=3, 時間=700] — 下線ビーム (#270)
    // 必須: target（bare 先頭値でも可）/ 任意: 色, 太さ, 時間, 余白, easing
    if let Some(rest) = content.strip_prefix("下線:") {
        return parse_underline_directive(rest);
    }
    if let Some(rest) = content.strip_prefix("underline:") {
        return parse_underline_directive(rest);
    }

    // [ラベル: text, 色=#7a9abf, 位置=中上, サイズ=16, id=division] — 単独の色付きラベル (#274)
    // 必須: text（先頭の bare 値）/ 任意: 色, 位置, サイズ, id, font
    if let Some(rest) = content.strip_prefix("ラベル:") {
        return parse_label_directive(rest);
    }
    if let Some(rest) = content.strip_prefix("label:") {
        return parse_label_directive(rest);
    }

    // [画像: avatar.png, 位置=上, 円形, サイズ=160, id=avatar] — 単独の画像 (#274)
    // 必須: path（先頭の bare 値）/ 任意: 位置, 円形(フラグ)/形状, サイズ, id
    if let Some(rest) = content.strip_prefix("画像:") {
        return parse_image_directive(rest);
    }
    if let Some(rest) = content.strip_prefix("image:") {
        return parse_image_directive(rest);
    }

    // [タイトル: TEXT] / [タイトル: TEXT, font=bellpoke_font] / [タイトル: TEXT, 位置=右外]
    // 動画用センターオーバーレイ。空テキストなら退場扱い。
    // 位置を指定すると初期位置を変えられる (右外 = 画面外右から登場用)。
    if let Some(rest) = content.strip_prefix("タイトル:") {
        let mut text = String::new();
        let mut font_family: Option<String> = None;
        let mut position: Option<String> = None;
        let mut color: Option<String> = None;
        let mut first = true;
        for raw in rest.split(',') {
            let part = raw.trim();
            if first {
                first = false;
                text = part.to_string();
                continue;
            }
            if let Some((k, v)) = part.split_once('=') {
                match k.trim() {
                    "font" | "font_family" | "フォント" => {
                        let v = v.trim();
                        if !v.is_empty() {
                            font_family = Some(v.to_string());
                        }
                    }
                    "position" | "位置" => {
                        let v = v.trim();
                        if !v.is_empty() {
                            position = Some(v.to_string());
                        }
                    }
                    // タイトル文字色 (#273)。Underline の color と同形（日本語キー `色` / 英語 `color`）。
                    "color" | "色" => {
                        let v = v.trim();
                        if !v.is_empty() {
                            color = Some(v.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        return Some(Event::TitleShow {
            text,
            font_family,
            position,
            color,
        });
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

/// `[背景: path]` / `[背景: path, フェード上=40, フェード下=60, ...]` の本体を分解する (#250)。
/// 最初の `,` 区切り要素を path、残りを端フェード kv として解釈する。
/// キーは日本語（`フェード上/下/左/右`）と英語 alias（`fade_top/bottom/left/right`）の両対応。
/// 値が非負整数 px に parse できないものや 0 は None 扱い（指定なし）。
/// 未知のキーは silent skip する（後方互換重視）。
fn parse_background_directive(content: &str) -> Event {
    let (path_part, kv_part) = match content.split_once(',') {
        Some((p, rest)) => (p, Some(rest)),
        None => (content, None),
    };
    let path = path_part.trim().to_string();

    let mut fade_top: Option<u32> = None;
    let mut fade_bottom: Option<u32> = None;
    let mut fade_left: Option<u32> = None;
    let mut fade_right: Option<u32> = None;

    if let Some(kv) = kv_part {
        for raw in kv.split(',') {
            let pair = raw.trim();
            if pair.is_empty() {
                continue;
            }
            if let Some((k, v)) = pair.split_once('=') {
                // 0 は None 扱いにするため、parse 成功かつ非ゼロのときだけ採用する。
                let val = v.trim().parse::<u32>().ok().filter(|&n| n > 0);
                match k.trim() {
                    "フェード上" | "fade_top" => fade_top = val,
                    "フェード下" | "fade_bottom" => fade_bottom = val,
                    "フェード左" | "fade_left" => fade_left = val,
                    "フェード右" | "fade_right" => fade_right = val,
                    _ => {}
                }
            }
        }
    }

    Event::Background {
        path,
        fade_top,
        fade_bottom,
        fade_left,
        fade_right,
    }
}

/// `[動画: path]` / `[動画: path, 位置=中央, スケール=1.0, ループ=true, ミュート=false, フェード上=40, ...]`
/// の本体を分解する (#252)。`parse_background_directive` と同じく最初の `,` で path / kv を分離する。
/// キーは日本語（`位置` / `スケール` / `ループ` / `ミュート` / `フェード上/下/左/右`）と
/// 英語 alias（`position` / `scale` / `loop` / `mute` / `fade_top/bottom/left/right`）の両対応。
/// フェードは 0 / 非数値を None 扱い。bool は `true` / `false`、f32 は parse 失敗で None。
/// 未知のキーは silent skip する（後方互換重視）。
fn parse_video_directive(content: &str) -> Event {
    let (path_part, kv_part) = match content.split_once(',') {
        Some((p, rest)) => (p, Some(rest)),
        None => (content, None),
    };
    let path = path_part.trim().to_string();

    let mut position: Option<String> = None;
    let mut scale: Option<f32> = None;
    let mut loop_: Option<bool> = None;
    let mut mute: Option<bool> = None;
    let mut fade_top: Option<u32> = None;
    let mut fade_bottom: Option<u32> = None;
    let mut fade_left: Option<u32> = None;
    let mut fade_right: Option<u32> = None;

    if let Some(kv) = kv_part {
        for raw in kv.split(',') {
            let pair = raw.trim();
            if pair.is_empty() {
                continue;
            }
            if let Some((k, v)) = pair.split_once('=') {
                let key = k.trim();
                let value = v.trim();
                // フェードは parse 成功かつ非ゼロのときだけ採用（0/不正は None）。
                let px = value.parse::<u32>().ok().filter(|&n| n > 0);
                match key {
                    "位置" | "position" if !value.is_empty() => {
                        position = Some(value.to_string());
                    }
                    "スケール" | "scale" => {
                        scale = value.parse::<f32>().ok().filter(|n| n.is_finite());
                    }
                    "ループ" | "loop" => loop_ = parse_bool_kv(value),
                    "ミュート" | "mute" => mute = parse_bool_kv(value),
                    "フェード上" | "fade_top" => fade_top = px,
                    "フェード下" | "fade_bottom" => fade_bottom = px,
                    "フェード左" | "fade_left" => fade_left = px,
                    "フェード右" | "fade_right" => fade_right = px,
                    _ => {}
                }
            }
        }
    }

    Event::Video {
        path,
        position,
        scale,
        loop_,
        mute,
        fade_top,
        fade_bottom,
        fade_left,
        fade_right,
    }
}

/// `true` / `false`（大文字小文字無視）を bool に解釈する (#252)。それ以外は None。
fn parse_bool_kv(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
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
                easing = parse_easing(value).unwrap_or(Easing::Linear);
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

/// easing キーワードを Easing に解釈する (#134 / #268)。
/// 英語表記（linear / ease-out / easeoutback 等）と日本語表記（オーバーシュート）を受理。
/// 未知の値は None（呼び出し側で Linear 等にフォールバック）。
fn parse_easing(value: &str) -> Option<crate::models::Easing> {
    use crate::models::Easing;
    // オーバーシュートは日本語表記のため lowercase 化前に判定する。
    if value == "オーバーシュート" {
        return Some(Easing::EaseOutBack);
    }
    match value.to_ascii_lowercase().as_str() {
        "linear" => Some(Easing::Linear),
        "ease-in" | "easein" => Some(Easing::EaseIn),
        "ease-out" | "easeout" => Some(Easing::EaseOut),
        "ease-in-out" | "easeinout" => Some(Easing::EaseInOut),
        "ease-out-back" | "easeoutback" => Some(Easing::EaseOutBack),
        _ => None,
    }
}

/// `[文字演出: target, …]` をパースする (#268)。
///
/// `[アニメ]` のグリフ単位版。プリセット（効果=爆発/タイプ）と素のプリミティブ
/// （dy=/scale= 等 + 間隔/速度/duration/easing）の 2 層。必須は target のみで、
/// プリセット既定値の展開は TS ランタイム側で行う（parser は値を素直に持たせるだけ）。
/// 日本語キー（効果/間隔/速度/対象/拡縮/不透明度/回転/時間）＋英語エイリアス
/// （effect/stagger/speed/target/scale/alpha/rotation/duration）に両対応。
/// target 欠落時は directive を捨てる（Animate の作法に揃える）。
fn parse_text_effect_directive(content: &str) -> Option<Event> {
    use crate::models::TextEffectPreset;

    let mut target: Option<String> = None;
    let mut effect: Option<TextEffectPreset> = None;
    let mut stagger_ms: Option<u32> = None;
    let mut ms_per_char: Option<u32> = None;
    let mut dx: Option<String> = None;
    let mut dy: Option<String> = None;
    let mut rotation: Option<String> = None;
    let mut scale: Option<f32> = None;
    let mut alpha: Option<f32> = None;
    let mut duration_ms: Option<u32> = None;
    let mut easing: Option<crate::models::Easing> = None;
    // #271: タイプ末尾の点滅カーソル（効果=タイプ 専用）。
    let mut cursor: Option<bool> = None;
    let mut blink_ms: Option<u32> = None;
    let mut cursor_color: Option<String> = None;

    let mut first = true;
    for raw_pair in content.split(',') {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        // 先頭要素が `=` を含まない bare 値なら target とみなす
        //（`[文字演出: Title, 効果=爆発]` の `Title`）。
        match pair.split_once('=') {
            None => {
                if first {
                    target = Some(pair.to_string());
                }
                // bare 値が 2 つ目以降に来る不正構文は silent skip
            }
            Some((k, v)) => {
                let key = k.trim();
                let value = v.trim();
                match key {
                    "target" | "対象" => target = Some(value.to_string()),
                    "effect" | "効果" => {
                        // to_ascii_lowercase は ASCII のみ小文字化し非 ASCII は素通しするため、
                        // 英語別名は大小無視で、日本語キーワードはそのまま一致する。
                        effect = match value.to_ascii_lowercase().as_str() {
                            "explode" | "爆発" => Some(TextEffectPreset::Explode),
                            "typewriter" | "タイプ" => Some(TextEffectPreset::Typewriter),
                            _ => None, // 未知プリセットは silent skip
                        };
                    }
                    "stagger" | "間隔" => stagger_ms = value.parse().ok(),
                    "speed" | "速度" => ms_per_char = value.parse().ok(),
                    "x" | "dx" => dx = Some(value.to_string()),
                    "y" | "dy" => dy = Some(value.to_string()),
                    "rotation" | "回転" => rotation = Some(value.to_string()),
                    "scale" | "拡縮" => scale = value.parse().ok(),
                    "alpha" | "不透明度" => alpha = value.parse().ok(),
                    "duration" | "時間" => duration_ms = value.parse().ok(),
                    "easing" => easing = parse_easing(value),
                    // #271: カーソル on/off。on / true / 表示 を真、off / false / なし を偽に倒す。
                    "cursor" | "カーソル" => cursor = parse_on_off(value),
                    "blink" | "点滅" => blink_ms = value.parse().ok(),
                    "cursor_color" | "カーソル色" => cursor_color = Some(value.to_string()),
                    _ => {} // 未知キーは silent skip
                }
            }
        }
        first = false;
    }

    let target = target?;
    Some(Event::TextEffect {
        target,
        effect,
        stagger_ms,
        ms_per_char,
        dx,
        dy,
        rotation,
        scale,
        alpha,
        duration_ms,
        easing,
        cursor,
        blink_ms,
        cursor_color,
    })
}

/// on/off 系キーワードを bool に解釈する (#271)。
/// `on` / `true` / `表示` / `あり` を true、`off` / `false` / `なし` を false に倒す。
/// 未知の値は None（呼び出し側でフィールド未設定 = 既定挙動）。
fn parse_on_off(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "on" | "true" | "表示" | "あり" => Some(true),
        "off" | "false" | "なし" => Some(false),
        _ => None,
    }
}

/// `[下線: target, …]` をパースする (#270)。
///
/// orber OP タイトルカードの下線ビーム。`[文字演出]` とは別系統の図形プリミティブ。
/// 必須は target のみ（bare 先頭値でも可）。プリセット既定値の展開は TS 側で行い、
/// parser は指定された値を素直に持たせる。日本語キー（対象/色/太さ/時間/余白）＋
/// 英語エイリアス（target/color/thickness/duration/offset）に両対応。
/// target 欠落時は directive を捨てる（Animate / TextEffect の作法に揃える）。
fn parse_underline_directive(content: &str) -> Option<Event> {
    let mut target: Option<String> = None;
    let mut color: Option<String> = None;
    let mut thickness: Option<u32> = None;
    let mut duration_ms: Option<u32> = None;
    let mut offset: Option<u32> = None;
    let mut easing: Option<crate::models::Easing> = None;

    let mut first = true;
    for raw_pair in content.split(',') {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        // 先頭要素が `=` を含まない bare 値なら target とみなす
        //（`[下線: Title, 色=#1a4a7a]` の `Title`）。
        match pair.split_once('=') {
            None => {
                if first {
                    target = Some(pair.to_string());
                }
                // bare 値が 2 つ目以降に来る不正構文は silent skip
            }
            Some((k, v)) => {
                let key = k.trim();
                let value = v.trim();
                match key {
                    "target" | "対象" => target = Some(value.to_string()),
                    "color" | "色" => color = Some(value.to_string()),
                    "thickness" | "太さ" => thickness = value.parse().ok(),
                    "duration" | "時間" => duration_ms = value.parse().ok(),
                    "offset" | "余白" => offset = value.parse().ok(),
                    "easing" => easing = parse_easing(value),
                    _ => {} // 未知キーは silent skip
                }
            }
        }
        first = false;
    }

    let target = target?;
    Some(Event::Underline {
        target,
        color,
        thickness,
        duration_ms,
        offset,
        easing,
    })
}

/// `[ラベル: text, …]` をパースする (#274)。
///
/// orber OP タイトルカードの肩書 / 名前のような単独色付きラベル。先頭の bare 値を text と
/// みなし（kv ではない）、残りを色/位置/サイズ/id/font の kv で受ける。日本語キー＋英語
/// エイリアスに両対応。空値ガード（`if !v.is_empty()`）は TitleShow の属性と同形にして、
/// `色=` のような空値を None に倒す。text が空文字でも Label として保持する
/// （描画側で text 空は無視するが round-trip では構文を残す）。
fn parse_label_directive(content: &str) -> Option<Event> {
    let mut text = String::new();
    let mut color: Option<String> = None;
    let mut position: Option<String> = None;
    let mut size: Option<u32> = None;
    let mut id: Option<String> = None;
    let mut font_family: Option<String> = None;

    let mut first = true;
    for raw in content.split(',') {
        let part = raw.trim();
        if first {
            first = false;
            text = part.to_string();
            continue;
        }
        if let Some((k, v)) = part.split_once('=') {
            let value = v.trim();
            match k.trim() {
                "color" | "色" if !value.is_empty() => {
                    color = Some(value.to_string());
                }
                "position" | "位置" if !value.is_empty() => {
                    position = Some(value.to_string());
                }
                "size" | "サイズ" => size = value.parse().ok(),
                "id" if !value.is_empty() => {
                    id = Some(value.to_string());
                }
                "font" | "font_family" | "フォント" if !value.is_empty() => {
                    font_family = Some(value.to_string());
                }
                _ => {} // 未知キーは silent skip
            }
        }
    }

    Some(Event::Label {
        text,
        color,
        position,
        size,
        id,
        font_family,
    })
}

/// `[画像: path, …]` をパースする (#274)。
///
/// orber OP タイトルカードのアバターのような単独画像。先頭の bare 値を path とみなす。
/// `円形` / `circle` は値なしフラグ（`[画像: a.png, 円形]`）でも `形状=円形` でも書ける。
/// 値なしの bare トークン `円形` / `circle` を shape="円形" として拾う。path 欠落（空文字）
/// 時は directive を捨てる（画像は path 必須）。
fn parse_image_directive(content: &str) -> Option<Event> {
    let mut path = String::new();
    let mut position: Option<String> = None;
    let mut shape: Option<String> = None;
    let mut size: Option<u32> = None;
    let mut id: Option<String> = None;

    let mut first = true;
    for raw in content.split(',') {
        let part = raw.trim();
        if first {
            first = false;
            path = part.to_string();
            continue;
        }
        if part.is_empty() {
            continue;
        }
        match part.split_once('=') {
            None => {
                // 値なし bare トークン: 円形 / circle を形状フラグとして拾う。
                if part == "円形" || part == "circle" {
                    shape = Some("円形".to_string());
                }
                // それ以外の bare 値は silent skip。
            }
            Some((k, v)) => {
                let value = v.trim();
                match k.trim() {
                    "position" | "位置" if !value.is_empty() => {
                        position = Some(value.to_string());
                    }
                    // 形状=円形 / shape=circle も受ける。値は `円形` に正規化する。
                    "shape" | "形状" if (value == "円形" || value == "circle") => {
                        shape = Some("円形".to_string());
                    }
                    "size" | "サイズ" => size = value.parse().ok(),
                    "id" if !value.is_empty() => {
                        id = Some(value.to_string());
                    }
                    _ => {} // 未知キーは silent skip
                }
            }
        }
    }

    if path.is_empty() {
        return None;
    }
    Some(Event::Image {
        path,
        position,
        shape,
        size,
        id,
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
    pub expressions: std::collections::HashMap<String, String>,
    pub scene: Option<String>,
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
    let mut expressions: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut scene: Option<String> = None;
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
        } else if let Some(val) = p.strip_prefix("expressions=") {
            // "normal:normal.png,sad:sad.png" → HashMap
            for pair in val.trim().split(',') {
                if let Some((key, path)) = pair.split_once(':') {
                    let k = key.trim().to_string();
                    let v = path.trim().to_string();
                    if !k.is_empty() && !v.is_empty() {
                        expressions.insert(k, v);
                    }
                }
            }
        } else if let Some(val) = p.strip_prefix("scene=") {
            let v = val.trim().to_string();
            if !v.is_empty() {
                scene = Some(v);
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
        expressions,
        scene,
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
        "[name-name-parser] warning: unknown direction '{value}', falling back to down. Expected one of: up/down/left/right or 上/下/左/右"
    );
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::console::warn_1(&msg.into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("{msg}");
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
        candidate = format!("{base}-{n}");
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
        "[name-name-parser] warning: unknown scene view '{value}', falling back to topdown"
    );
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::console::warn_1(&msg.into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("{msg}");
    }
}

/// Emit a warning about map dimension mismatch. On native targets this goes
/// to stderr via `eprintln!`; on `wasm32` it goes through `console.warn`.
fn emit_map_dimension_warning(width: u32, height: u32, raw_rows: &[&str]) {
    let actual_rows = raw_rows.len();
    let row_widths: Vec<usize> = raw_rows.iter().map(|r| r.chars().count()).collect();
    emit_warning(&format!(
        "[name-name-parser] warning: map dimensions mismatch — declared {width}x{height}, got {actual_rows} rows with widths {row_widths:?}"
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
    emit_warning(&format!("[name-name-parser] warning: {detail}"));
}

/// `[/マップ]` 欠落時の警告。行頭 `[` で始まる別ブロックが突入した時点で
/// マップブロックを打ち切るため、既に収集した行数を報告する。
fn emit_map_close_missing_warning(width: u32, height: u32, collected_rows: usize) {
    emit_warning(&format!(
        "[name-name-parser] warning: [/マップ] が見つからないうちに別ブロックが開始されました — 宣言 {width}x{height}, 収集済み {collected_rows} 行"
    ));
}

/// 共通の warning 出力ヘルパー。
/// - native (`cfg(test)` なし): stderr に出力する
/// - native + test: 何もしない（テスト中の stderr 汚染防止）
/// - wasm32: `console.warn` へ流す
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
fn emit_warning(msg: &str) {
    eprintln!("{msg}");
}

#[cfg(all(not(target_arch = "wasm32"), test))]
fn emit_warning(_msg: &str) {
    // suppress during tests
}

#[cfg(target_arch = "wasm32")]
fn emit_warning(msg: &str) {
    web_sys::console::warn_1(&msg.into());
}

/// `[エンカウント率: ...]` のボディを u32 にパースする。
/// 受理形式:
///   "16"   → 16
///   "1/16" → 16  (分母を抽出)
///   "0"    → 0   (安全マップ、絶対にエンカウントしない)
///   "1"    → 1   (デバッグ用、毎歩エンカウント発火)
///
/// 不正値は None で破棄:
///   "1/0"  → None (分母 0 は無意味、安全マップ意図なら "0" を直接書く)
fn parse_encounter_rate(s: &str) -> Option<u32> {
    if let Some(denom) = s.strip_prefix("1/") {
        let n = denom.trim().parse::<u32>().ok()?;
        if n == 0 {
            emit_encounter_warning(
                "[エンカウント率: 1/0] は無意味（分母 0）。安全マップなら [エンカウント率: 0] を使ってください",
            );
            return None;
        }
        return Some(n);
    }
    s.parse::<u32>().ok()
}

fn inject_encounter_rate_into_last_map(events: &mut [Event], rate: u32) {
    match events.last_mut() {
        Some(Event::RpgMap(map)) => {
            map.encounter_rate = Some(rate);
        }
        _ => {
            emit_encounter_warning(
                "[エンカウント率] の直前が [マップ] ではありません。破棄しました",
            );
        }
    }
}

fn inject_encounter_groups_into_last_map(events: &mut [Event], groups: Vec<String>) {
    match events.last_mut() {
        Some(Event::RpgMap(map)) => {
            map.encounter_groups = Some(groups);
        }
        _ => {
            emit_encounter_warning(
                "[エンカウント群] の直前が [マップ] ではありません。破棄しました",
            );
        }
    }
}

fn emit_encounter_warning(msg: &str) {
    let full = format!("[name-name-parser] warning: {msg}");
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::console::warn_1(&full.into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("{full}");
    }
}

/// `[NPC移動: <npc> → @x,y 速度=N 向き=<dir>]` の内部をパースする。
/// 形式: `<npc名> → @x,y [速度=N] [向き=<dir>]`
fn parse_npc_move_command(s: &str) -> Option<EventCommand> {
    // Split on → (arrow)
    let arrow_pos = s.find('→')?;
    let npc = s[..arrow_pos].trim().to_string();
    if npc.is_empty() {
        return None;
    }
    let rest = s[arrow_pos + '→'.len_utf8()..].trim();
    let at_pos = rest.find('@')?;
    let after_at = &rest[at_pos + 1..];
    let mut parts = after_at.split_whitespace();
    let coord = parts.next()?;
    let (x_str, y_str) = coord.split_once(',')?;
    let x: u32 = x_str.trim().parse().ok()?;
    let y: u32 = y_str.trim().parse().ok()?;
    let mut speed: u32 = 3;
    let mut direction: Option<Direction> = None;
    for p in parts {
        if let Some(val) = p.strip_prefix("速度=") {
            if let Ok(n) = val.trim().parse::<u32>() {
                speed = n;
            }
        } else if let Some(val) = p.strip_prefix("向き=") {
            direction = Some(parse_direction(val.trim()));
        }
    }
    Some(EventCommand::NpcMove {
        npc,
        x,
        y,
        speed,
        direction,
    })
}

/// `[トリガー ...]` の内部をパースする。
/// 座標トリガー: `@x,y scene=xxx [once=true]`
/// 自動トリガー: `auto scene=xxx [once=true]`
fn parse_trigger_line(s: &str) -> Option<Event> {
    let mut x: Option<u32> = None;
    let mut y: Option<u32> = None;
    let mut auto = false;
    let mut scene: Option<String> = None;
    let mut once = false;

    let mut parts = s.split_whitespace();
    let first = parts.next()?;
    if first == "auto" {
        auto = true;
    } else if let Some(coord) = first.strip_prefix('@') {
        let (x_str, y_str) = coord.split_once(',')?;
        x = Some(x_str.trim().parse().ok()?);
        y = Some(y_str.trim().parse().ok()?);
    } else {
        return None;
    }

    for p in parts {
        if let Some(val) = p.strip_prefix("scene=") {
            let v = val.trim().to_string();
            if !v.is_empty() {
                scene = Some(v);
            }
        } else if p == "once=true" {
            once = true;
        }
    }

    let scene = scene?;
    Some(Event::RpgTrigger {
        x,
        y,
        auto,
        scene,
        once,
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

// マスターデータブロック (#174 / #175) のパース実装は master.rs に分離。
// `use crate::master::try_parse_master_data_block;` は parser.rs 冒頭に集約。

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
                path: "radius/BG_COMMON_GRAD_3.png".to_string(),
                fade_top: None,
                fade_bottom: None,
                fade_left: None,
                fade_right: None,
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
            other => panic!("expected Monster, got {other:?}"),
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
            other => panic!("expected Item, got {other:?}"),
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
            other => panic!("expected Spell, got {other:?}"),
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
            other => panic!("expected Spell, got {other:?}"),
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
            other => panic!("expected Monster, got {other:?}"),
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
            other => panic!("expected Item, got {other:?}"),
        }
    }

    // ===== Encounter directives (#172) =====

    #[test]
    fn parses_encounter_rate_and_groups_attached_to_map() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[マップ 5x5 タイル=32]
GGGGG
GGGGG
GGGGG
GGGGG
GGGGG
[/マップ]

[エンカウント率: 1/16]
[エンカウント群: slime, ghost, slime+ghost]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::RpgMap(m) => {
                assert_eq!(m.encounter_rate, Some(16));
                assert_eq!(
                    m.encounter_groups,
                    Some(vec!["slime".into(), "ghost".into(), "slime+ghost".into()])
                );
            }
            other => panic!("expected RpgMap, got {other:?}"),
        }
    }

    #[test]
    fn encounter_rate_accepts_bare_number() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[マップ 3x3 タイル=32]
GGG
GGG
GGG
[/マップ]

[エンカウント率: 32]
"#;
        let doc = parse(input);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::RpgMap(m) => assert_eq!(m.encounter_rate, Some(32)),
            other => panic!("expected RpgMap, got {other:?}"),
        }
    }

    #[test]
    fn encounter_rate_zero_is_safe_map() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[マップ 3x3 タイル=32]
GGG
GGG
GGG
[/マップ]

[エンカウント率: 0]
"#;
        let doc = parse(input);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::RpgMap(m) => assert_eq!(m.encounter_rate, Some(0)),
            other => panic!("expected RpgMap, got {other:?}"),
        }
    }

    // ===== Party member block (#175) =====

    #[test]
    fn parses_party_member_block_with_all_fields() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[パーティ hero]
名前: ゆうしゃ
スプライト: characters/hero.png
レベル: 1
HP: 20
MP: 0
ATK: 5
DEF: 3
AGI: 4
習得: Lv4 ホイミ
習得: Lv7 ギラ
[/パーティ]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        match &events[0] {
            Event::PartyMember(p) => {
                assert_eq!(p.id, "hero");
                assert_eq!(p.name, "ゆうしゃ");
                assert_eq!(p.sprite.as_deref(), Some("characters/hero.png"));
                assert_eq!(p.level, 1);
                assert_eq!(p.hp, 20);
                assert_eq!(p.atk, 5);
                assert_eq!(p.def_value, 3);
                assert_eq!(p.agi, 4);
                let learns = p.learns.as_ref().expect("learns 必須");
                assert_eq!(learns.len(), 2);
                assert_eq!(learns[0].level, 4);
                assert_eq!(learns[0].spell, "ホイミ");
                assert_eq!(learns[1].level, 7);
                assert_eq!(learns[1].spell, "ギラ");
            }
            other => panic!("expected PartyMember, got {other:?}"),
        }
    }

    #[test]
    fn party_learns_accepts_kv_form() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[パーティ hero]
名前: ゆうしゃ
HP: 20
ATK: 5
DEF: 3
AGI: 4
習得: level=4 spell=ホイミ
[/パーティ]
"#;
        let doc = parse(input);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::PartyMember(p) => {
                let learns = p.learns.as_ref().expect("learns 必須");
                assert_eq!(learns[0].level, 4);
                assert_eq!(learns[0].spell, "ホイミ");
            }
            other => panic!("expected PartyMember, got {other:?}"),
        }
    }

    #[test]
    fn party_learns_preserves_order_and_skips_invalid_rows() {
        // 不正な習得行が混じっても、後続の正常行は取り込まれて順序が保たれる
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[パーティ hero]
名前: ゆうしゃ
HP: 20
ATK: 5
DEF: 3
AGI: 4
習得: Lv4 ホイミ
習得: invalid_no_level_number
習得: level=7 spell=
習得: Lv10 ベホマ
[/パーティ]
"#;
        let doc = parse(input);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::PartyMember(p) => {
                let learns = p.learns.as_ref().expect("learns 必須");
                // 不正行 2 つはスキップされ、正常行 2 つが順序を保ったまま残る
                assert_eq!(learns.len(), 2);
                assert_eq!(learns[0].level, 4);
                assert_eq!(learns[0].spell, "ホイミ");
                assert_eq!(learns[1].level, 10);
                assert_eq!(learns[1].spell, "ベホマ");
            }
            other => panic!("expected PartyMember, got {other:?}"),
        }
    }

    #[test]
    fn party_member_without_name_is_dropped() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[パーティ nameless]
HP: 20
[/パーティ]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn npc_expressions_parse() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## scene: s

[マップ 5x5 テーマ=town]
[/マップ]
[プレイヤー開始 @2,2]
[NPC 長老 @1,1 色=#ffcc00 portrait=elder.png expressions=normal:normal.png,sad:sad.png]
こんにちは。
[/NPC]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        let npc = events
            .iter()
            .find_map(|e| if let Event::Npc(n) = e { Some(n) } else { None });
        let npc = npc.expect("Npc event not found");
        assert_eq!(
            npc.expressions.get("normal"),
            Some(&"normal.png".to_string())
        );
        assert_eq!(npc.expressions.get("sad"), Some(&"sad.png".to_string()));
        assert_eq!(npc.expressions.len(), 2);
    }

    #[test]
    fn npc_expressions_roundtrip() {
        use crate::emitter::emit;
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## scene: s

[マップ 5x5 テーマ=town]
[/マップ]
[プレイヤー開始 @2,2]
[NPC 長老 @1,1 色=#ffcc00 portrait=elder.png expressions=normal:normal.png,sad:sad.png]
こんにちは。
[/NPC]
"#;
        let doc = parse(input);
        let emitted = emit(&doc);
        // emitter が expressions= を出力することを確認
        assert!(
            emitted.contains("expressions="),
            "emitter should include expressions= but got:\n{emitted}"
        );
        // ラウンドトリップ: 再パースしても同じ expressions が得られる
        let doc2 = parse(&emitted);
        let npc2 = doc2.chapters[0].scenes[0].events.iter().find_map(|e| {
            if let Event::Npc(n) = e {
                Some(n)
            } else {
                None
            }
        });
        let npc2 = npc2.expect("Npc event not found after roundtrip");
        assert_eq!(
            npc2.expressions.get("normal"),
            Some(&"normal.png".to_string())
        );
        assert_eq!(npc2.expressions.get("sad"), Some(&"sad.png".to_string()));
    }

    // ===== RpgEvent / RpgTrigger / NpcData.scene (#196) =====

    #[test]
    fn npc_scene_parse() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[NPC 衛兵 @3,3 色=#ff0000 scene=guard_talk]
警戒中だ。
[/NPC]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        let npc = events
            .iter()
            .find_map(|e| if let Event::Npc(n) = e { Some(n) } else { None })
            .expect("Npc not found");
        assert_eq!(npc.scene.as_deref(), Some("guard_talk"));
    }

    #[test]
    fn rpg_event_parse() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[イベント guard_talk]
[NPC移動: 衛兵 → @5,3 速度=1]
[待機: 500]
**衛兵**:
通れ。
[/イベント]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::RpgEvent { name, commands } => {
                assert_eq!(name, "guard_talk");
                assert_eq!(commands.len(), 3);
                match &commands[0] {
                    EventCommand::NpcMove {
                        npc, x, y, speed, ..
                    } => {
                        assert_eq!(npc, "衛兵");
                        assert_eq!(*x, 5);
                        assert_eq!(*y, 3);
                        assert_eq!(*speed, 1);
                    }
                    other => panic!("expected NpcMove, got {other:?}"),
                }
                match &commands[1] {
                    EventCommand::Wait { ms } => assert_eq!(*ms, 500),
                    other => panic!("expected Wait, got {other:?}"),
                }
                match &commands[2] {
                    EventCommand::Dialog { character, text } => {
                        assert_eq!(character.as_deref(), Some("衛兵"));
                        assert_eq!(text, &vec!["通れ。".to_string()]);
                    }
                    other => panic!("expected Dialog, got {other:?}"),
                }
            }
            other => panic!("expected RpgEvent, got {other:?}"),
        }
    }

    #[test]
    fn rpg_trigger_step_parse() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[トリガー @5,5 scene=foo once=true]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::RpgTrigger {
                x,
                y,
                auto,
                scene,
                once,
            } => {
                assert_eq!(*x, Some(5));
                assert_eq!(*y, Some(5));
                assert!(!auto);
                assert_eq!(scene, "foo");
                assert!(*once);
            }
            other => panic!("expected RpgTrigger, got {other:?}"),
        }
    }

    #[test]
    fn rpg_trigger_auto_parse() {
        let input = r#"---
engine: name-name
chapter: 1
title: "test"
---
## map: m

[トリガー auto scene=intro]
"#;
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::RpgTrigger {
                x,
                y,
                auto,
                scene,
                once,
            } => {
                assert_eq!(*x, None);
                assert_eq!(*y, None);
                assert!(*auto);
                assert_eq!(scene, "intro");
                assert!(!once);
            }
            other => panic!("expected RpgTrigger, got {other:?}"),
        }
    }

    #[test]
    fn rpg_event_roundtrip() {
        use crate::emitter::emit;
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## map: m\n\n[イベント guard_talk]\n[NPC移動: 衛兵 → @5,3 速度=2]\n[待機: 300]\n**衛兵**:\n通れ。\n[/イベント]\n[トリガー @5,5 scene=guard_talk once=true]\n[トリガー auto scene=guard_talk]\n";
        let doc1 = parse(input);
        let emitted = emit(&doc1);
        let doc2 = parse(&emitted);
        assert_eq!(doc1, doc2, "rpg event/trigger round-trip should be stable");
    }

    // ===== 背景色 / タイトル色 (#273) =====

    #[test]
    fn parses_background_color() {
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[背景色: #f5f0e8]\n";
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            Event::BackgroundColor {
                color: "#f5f0e8".to_string(),
            }
        );
    }

    #[test]
    fn background_color_does_not_shadow_background() {
        // `[背景: …]` が `背景色` パスに吸われていないこと（プレフィックス衝突回避）。
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[背景: bg.png]\n[背景色: #f5f0e8]\n";
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], Event::Background { .. }));
        assert!(matches!(events[1], Event::BackgroundColor { .. }));
    }

    #[test]
    fn background_color_roundtrip() {
        use crate::emitter::emit;
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[背景色: #f5f0e8]\n";
        let doc1 = parse(input);
        let emitted = emit(&doc1);
        let doc2 = parse(&emitted);
        assert_eq!(doc1, doc2, "background color round-trip should be stable");
    }

    #[test]
    fn parses_title_with_color() {
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[タイトル: orber, 色=#1a4a7a]\n";
        let doc = parse(input);
        let events = &doc.chapters[0].scenes[0].events;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            Event::TitleShow {
                text: "orber".to_string(),
                font_family: None,
                position: None,
                color: Some("#1a4a7a".to_string()),
            }
        );
    }

    #[test]
    fn title_color_roundtrip_with_and_without() {
        use crate::emitter::emit;
        // 色あり
        let with = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[タイトル: orber, 色=#1a4a7a]\n";
        let d1 = parse(with);
        let d2 = parse(&emit(&d1));
        assert_eq!(d1, d2, "title with color round-trip should be stable");
        // 色なし（既存挙動を壊さない）
        let without = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[タイトル: orber]\n";
        let d3 = parse(without);
        let d4 = parse(&emit(&d3));
        assert_eq!(d3, d4, "title without color round-trip should be stable");
        // 色なしのとき color は None
        if let Event::TitleShow { color, .. } = &d3.chapters[0].scenes[0].events[0] {
            assert_eq!(*color, None);
        } else {
            panic!("expected TitleShow");
        }
    }

    // R6: 英語キー `color=` で受け、emit は日本語 `色=` に正規化する（入力英語→出力日本語の
    // 非対称 round-trip）。下線（#270）の color と同じく英語キーも受理する仕様を縛る。
    #[test]
    fn title_color_english_key_emits_japanese() {
        use crate::emitter::emit;
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[タイトル: orber, color=#1a4a7a]\n";
        let doc = parse(input);
        // 英語キーでも color に入る。
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::TitleShow {
                text: "orber".to_string(),
                font_family: None,
                position: None,
                color: Some("#1a4a7a".to_string()),
            }
        );
        // emit は常に日本語 `色=` で出す（英語キーは出力に残らない）。
        let emitted = emit(&doc);
        assert!(
            emitted.contains("色=#1a4a7a"),
            "emit should normalize to Japanese key `色=`, got: {emitted}"
        );
        assert!(
            !emitted.contains("color="),
            "emit should not keep English key `color=`, got: {emitted}"
        );
        // 意味的には再 parse で安定（color= → 色= の正規化は値を変えない）。
        let reparsed = parse(&emitted);
        assert_eq!(
            doc, reparsed,
            "color= input should round-trip via 色= output"
        );
    }

    // R7: `[背景色: ]`（値が空）の境界。実装は rest.trim() をそのまま保持するため空文字 color に
    // なる（描画では黒に倒すが文字列は保持＝spec の round-trip 保持）。parse→emit→再 parse が安定。
    #[test]
    fn background_color_empty_value_roundtrip() {
        use crate::emitter::emit;
        let input =
            "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[背景色: ]\n";
        let d1 = parse(input);
        // 空文字を保持する（None ではなく空文字列）。
        assert_eq!(
            d1.chapters[0].scenes[0].events[0],
            Event::BackgroundColor {
                color: "".to_string(),
            }
        );
        // emit は `[背景色: ]`（空値）で出し、再 parse しても同じ空文字に戻る。
        let d2 = parse(&emit(&d1));
        assert_eq!(d1, d2, "empty background color round-trip should be stable");
    }

    // R8: `[タイトル: orber, 色=]`（色キーありで値が空）。タイトル色の kv は空値ガード
    // （`if !v.is_empty()`）を持つため、空値では color=None になる（背景色の空文字保持とは非対称）。
    #[test]
    fn title_empty_color_value_is_none() {
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[タイトル: orber, 色=]\n";
        let doc = parse(input);
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::TitleShow {
                text: "orber".to_string(),
                font_family: None,
                position: None,
                color: None,
            }
        );
    }

    // R9: font / 位置 / 色 を同時指定した全属性 round-trip。属性が増えても emit→parse が安定する
    // ことを縛る（emit の属性出力順 font→位置→色 が parse で復元される）。
    #[test]
    fn title_all_attributes_roundtrip() {
        use crate::emitter::emit;
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[タイトル: orber, font=bellpoke_font, 位置=中央, 色=#1a4a7a]\n";
        let d1 = parse(input);
        assert_eq!(
            d1.chapters[0].scenes[0].events[0],
            Event::TitleShow {
                text: "orber".to_string(),
                font_family: Some("bellpoke_font".to_string()),
                position: Some("中央".to_string()),
                color: Some("#1a4a7a".to_string()),
            }
        );
        let d2 = parse(&emit(&d1));
        assert_eq!(
            d1, d2,
            "title with all attributes round-trip should be stable"
        );
    }

    // ===== ラベル / 画像 (#274) =====

    #[test]
    fn parses_label_with_all_attributes() {
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[ラベル: Planning Div. 42, 色=#7a9abf, 位置=中上, サイズ=16, id=division, font=bellpoke_font]\n";
        let doc = parse(input);
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Label {
                text: "Planning Div. 42".to_string(),
                color: Some("#7a9abf".to_string()),
                position: Some("中上".to_string()),
                size: Some(16),
                id: Some("division".to_string()),
                font_family: Some("bellpoke_font".to_string()),
            }
        );
    }

    #[test]
    fn label_roundtrip_with_and_without() {
        use crate::emitter::emit;
        // 全属性
        let with = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[ラベル: kako-jun, 色=#2b6cb0, 位置=中, サイズ=22, id=name]\n";
        let d1 = parse(with);
        let d2 = parse(&emit(&d1));
        assert_eq!(d1, d2, "label with attributes round-trip should be stable");
        // 属性なし（text のみ）
        let bare = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[ラベル: hi]\n";
        let d3 = parse(bare);
        assert_eq!(
            d3.chapters[0].scenes[0].events[0],
            Event::Label {
                text: "hi".to_string(),
                color: None,
                position: None,
                size: None,
                id: None,
                font_family: None,
            }
        );
        let d4 = parse(&emit(&d3));
        assert_eq!(d3, d4, "bare label round-trip should be stable");
    }

    // 英語キー `label:` / `color=` / `position=` / `size=` で受け、emit は日本語キーに正規化する。
    #[test]
    fn label_english_keys_emit_japanese() {
        use crate::emitter::emit;
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[label: title, color=#7a9abf, position=upper, size=16, id=division]\n";
        let doc = parse(input);
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Label {
                text: "title".to_string(),
                color: Some("#7a9abf".to_string()),
                position: Some("upper".to_string()),
                size: Some(16),
                id: Some("division".to_string()),
                font_family: None,
            }
        );
        let emitted = emit(&doc);
        assert!(emitted.contains("色=#7a9abf"), "got: {emitted}");
        assert!(emitted.contains("位置=upper"), "got: {emitted}");
        assert!(emitted.contains("サイズ=16"), "got: {emitted}");
        assert!(!emitted.contains("color="), "got: {emitted}");
        let reparsed = parse(&emitted);
        assert_eq!(
            doc, reparsed,
            "english-key label should round-trip via 日本語 output"
        );
    }

    #[test]
    fn parses_image_with_flag_circle() {
        // 円形を値なしフラグで指定する。
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[画像: avatar.png, 位置=上, 円形, サイズ=160, id=avatar]\n";
        let doc = parse(input);
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Image {
                path: "avatar.png".to_string(),
                position: Some("上".to_string()),
                shape: Some("円形".to_string()),
                size: Some(160),
                id: Some("avatar".to_string()),
            }
        );
    }

    #[test]
    fn image_roundtrip_flag_and_kv_circle() {
        use crate::emitter::emit;
        // フラグ形 `円形` → emit は `形状=円形` の kv 形に正規化 → 再 parse で同じ shape に戻る。
        let flag = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[画像: avatar.png, 位置=上, 円形, サイズ=160, id=avatar]\n";
        let d1 = parse(flag);
        let emitted = emit(&d1);
        assert!(emitted.contains("形状=円形"), "got: {emitted}");
        let d2 = parse(&emitted);
        assert_eq!(
            d1, d2,
            "image with flag circle should round-trip via 形状=円形"
        );
        // kv 形 `形状=円形` でも shape は同じ。
        let kv = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[画像: avatar.png, 形状=円形]\n";
        let d3 = parse(kv);
        assert_eq!(
            d3.chapters[0].scenes[0].events[0],
            Event::Image {
                path: "avatar.png".to_string(),
                position: None,
                shape: Some("円形".to_string()),
                size: None,
                id: None,
            }
        );
        // circle 英語フラグ。
        let en = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[image: a.png, circle]\n";
        let d4 = parse(en);
        if let Event::Image { shape, .. } = &d4.chapters[0].scenes[0].events[0] {
            assert_eq!(*shape, Some("円形".to_string()));
        } else {
            panic!("expected Image");
        }
    }

    #[test]
    fn image_without_path_is_dropped() {
        // path が空（先頭 bare 値なし）なら directive を捨てる（イベント 0 件）。
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[画像: , 円形]\n";
        let doc = parse(input);
        assert_eq!(doc.chapters[0].scenes[0].events.len(), 0);
    }

    #[test]
    fn image_natural_size_roundtrip() {
        use crate::emitter::emit;
        // サイズ・形状なし（自然サイズ・矩形）でも安定 round-trip。
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n[画像: pic.png, 位置=中]\n";
        let d1 = parse(input);
        assert_eq!(
            d1.chapters[0].scenes[0].events[0],
            Event::Image {
                path: "pic.png".to_string(),
                position: Some("中".to_string()),
                shape: None,
                size: None,
                id: None,
            }
        );
        let d2 = parse(&emit(&d1));
        assert_eq!(d1, d2, "image natural-size round-trip should be stable");
    }

    // ===== #274 追加: u32 parse 境界 / 空値ガード / 未知キー / カンマ構造制約 =====

    // 共通ヘッダ。各テストの本文（## 以降）だけを差し替える。
    fn label_doc(body: &str) -> String {
        format!("---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n{body}\n")
    }

    // 23: サイズの u32 parse 境界。負値 / 小数 / 非数値はいずれも `value.parse::<u32>().ok()`
    //     が None になり silent drop される（size: None）。type-globe の size 直書きが壊れない縛り。
    #[test]
    fn label_size_invalid_values_drop_to_none() {
        for raw in ["サイズ=-5", "サイズ=3.5", "サイズ=abc"] {
            let doc = parse(&label_doc(&format!("[ラベル: hi, {raw}]")));
            match &doc.chapters[0].scenes[0].events[0] {
                Event::Label { text, size, .. } => {
                    assert_eq!(text, "hi", "text should survive ({raw})");
                    assert_eq!(
                        *size, None,
                        "size should be None for `{raw}` (u32 parse fails)"
                    );
                }
                other => panic!("expected Label, got {other:?} for `{raw}`"),
            }
        }
    }

    // 24: 空値ガード。`色=`（= の右が空）は `if !value.is_empty()` で None に倒れる。
    //     位置= / id= / font= も同形だが、ここでは色の代表で空値ガードを縛る。
    #[test]
    fn label_empty_color_value_is_none() {
        let doc = parse(&label_doc("[ラベル: hi, 色=]"));
        match &doc.chapters[0].scenes[0].events[0] {
            Event::Label { text, color, .. } => {
                assert_eq!(text, "hi");
                assert_eq!(*color, None, "empty `色=` value must guard to None");
            }
            other => panic!("expected Label, got {other:?}"),
        }
    }

    // 25: 未知キーは silent skip し、Label 自体は成立する（謎=1 を無視して text を保持）。
    #[test]
    fn label_unknown_key_silently_skipped() {
        let doc = parse(&label_doc("[ラベル: x, 謎=1]"));
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Label {
                text: "x".to_string(),
                color: None,
                position: None,
                size: None,
                id: None,
                font_family: None,
            },
            "unknown key 謎= must be skipped, Label still parses"
        );
    }

    // 26: 画像の非円形 bare トークンは silent skip し、Image は path だけで成立する。
    #[test]
    fn image_unknown_bare_flag_silently_skipped() {
        let doc = parse(&label_doc("[画像: a.png, へんなbareフラグ]"));
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Image {
                path: "a.png".to_string(),
                position: None,
                // `円形`/`circle` 以外の bare トークンは shape にならない。
                shape: None,
                size: None,
                id: None,
            },
            "non-circle bare token must be skipped, Image still parses"
        );
    }

    // 27: `フォント=`（日本語キー）入力の round-trip 安定。emitter は `font=` で出すが、
    //     parser は font/font_family/フォント を等価に受けるため再 parse で同じ値に戻る。
    #[test]
    fn label_font_japanese_key_roundtrips_via_english_emit() {
        use crate::emitter::emit;
        let d1 = parse(&label_doc("[ラベル: hi, フォント=bellpoke_font]"));
        // 入力時点で font_family が拾えている。
        match &d1.chapters[0].scenes[0].events[0] {
            Event::Label { font_family, .. } => {
                assert_eq!(*font_family, Some("bellpoke_font".to_string()));
            }
            other => panic!("expected Label, got {other:?}"),
        }
        let emitted = emit(&d1);
        // emit は font= に正規化する（フォント= では出さない）。
        assert!(emitted.contains("font=bellpoke_font"), "got: {emitted}");
        assert!(!emitted.contains("フォント="), "got: {emitted}");
        // それでも再 parse で d1 と同一に戻る（font/フォント は等価キー）。
        let d2 = parse(&emitted);
        assert_eq!(d1, d2, "フォント= input should round-trip via font= emit");
    }

    // 28: text/path に `,` を含む入力の現挙動を固定する（split(',') の構造的限界の明文化）。
    //     `[ラベル: a,b, 色=#fff]` は split(',') で ["a", "b", " 色=#fff"] になり、
    //     先頭 "a" だけが text、"b" は `=` を含まない bare → silent skip で LOST、
    //     "色=#fff" は color として拾われる。つまり text にカンマは入れられない（仕様制約）。
    #[test]
    fn label_comma_in_text_is_truncated_at_first_comma() {
        let doc = parse(&label_doc("[ラベル: a,b, 色=#fff]"));
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Label {
                // text は最初のカンマまで。"b" は構造的に脱落する（split(',') の限界）。
                text: "a".to_string(),
                color: Some("#fff".to_string()),
                position: None,
                size: None,
                id: None,
                font_family: None,
            },
            "comma in label text is truncated at first comma; trailing segment without `=` is dropped"
        );
    }

    // 28b: 画像 path のカンマも同様に最初のカンマで切れる（path にカンマは入れられない）。
    #[test]
    fn image_comma_in_path_is_truncated_at_first_comma() {
        let doc = parse(&label_doc("[画像: a,b.png, 位置=中]"));
        assert_eq!(
            doc.chapters[0].scenes[0].events[0],
            Event::Image {
                // path は "a" まで。",b.png" は bare として skip される。
                path: "a".to_string(),
                position: Some("中".to_string()),
                shape: None,
                size: None,
                id: None,
            },
            "comma in image path is truncated at first comma (structural limit of split(','))"
        );
    }
}
