use crate::models::*;
use crate::parser::npc_base_slug;
use std::fmt::Write as _;

/// Emit a Document back to Markdown format.
pub fn emit(doc: &Document) -> String {
    let mut out = String::new();

    for chapter in &doc.chapters {
        // YAML front matter
        out.push_str("---\n");
        out.push_str(&format!("engine: {}\n", doc.engine));
        // Emit aspect_ratio only when non-default
        if doc.aspect_ratio != "16:9" {
            out.push_str(&format!("aspect_ratio: \"{}\"\n", doc.aspect_ratio));
        }
        // Emit choice_style only when present (#146)
        if let Some(ref style) = doc.choice_style {
            out.push_str(&format!("choice_style: \"{style}\"\n"));
        }
        // Emit font_family only when present (#147)。
        // CSS の font-family 文字列はカンマや空白を含み得るので必ず double-quote で包む。
        // family 名に `"` が含まれる場合は emit 時に取り除く（unquote が escape を解釈しないため
        // round-trip で壊れるのを防ぐ）。実用上 `"` を含む family 名は無いので影響なし (#147 R1 N2)。
        if let Some(ref family) = doc.font_family {
            let sanitized = family.replace('"', "");
            out.push_str(&format!("font_family: \"{sanitized}\"\n"));
        }
        // Emit font_size only when present (#283 補遺)。数値なので quote 不要。
        if let Some(size) = doc.font_size {
            out.push_str(&format!("font_size: {size}\n"));
        }
        // Emit dialog_style only when present (#283)。adv / novel の対等 2 択で
        // 「正規デフォルト」を持たないため、aspect_ratio のような「非デフォルト時のみ」では
        // なく choice_style と同じ「Some のときだけ出す」流儀にする（明示指定をそのまま保持）。
        if let Some(ref style) = doc.dialog_style {
            out.push_str(&format!("dialog_style: \"{style}\"\n"));
        }
        // Emit protagonist only when present (#286)。dialog_style と同じく Some のときだけ出す。
        // 話者名はカンマや空白を含み得るので double-quote で包む（font_family と同方針）。
        if let Some(ref name) = doc.protagonist {
            let sanitized = name.replace('"', "");
            out.push_str(&format!("protagonist: \"{sanitized}\"\n"));
        }
        // Emit character_y_ratio only when present (#308)。数値なので quote 不要（font_size と同じ）。
        if let Some(ratio) = doc.character_y_ratio {
            out.push_str(&format!("character_y_ratio: {ratio}\n"));
        }
        // Emit character_height_ratio only when present (#360)。数値なので quote 不要（character_y_ratio と同じ）。
        if let Some(ratio) = doc.character_height_ratio {
            out.push_str(&format!("character_height_ratio: {ratio}\n"));
        }
        if let Some(ms) = doc.character_fade_ms {
            out.push_str(&format!("character_fade_ms: {ms}\n"));
        }
        // Emit skip_enabled / debug_enabled only when present (#310)。bool なので Some のときだけ
        // `true` / `false` を素で出す（None は省略＝runtime 既定にフォールバック）。
        if let Some(enabled) = doc.skip_enabled {
            out.push_str(&format!("skip_enabled: {enabled}\n"));
        }
        if let Some(enabled) = doc.debug_enabled {
            out.push_str(&format!("debug_enabled: {enabled}\n"));
        }
        out.push_str(&format!("chapter: {}\n", chapter.number));
        out.push_str(&format!("title: \"{}\"\n", chapter.title));
        // Emit `hidden` only when true; it's a boolean flag and the default (false) is silent.
        if chapter.hidden {
            out.push_str("hidden: true\n");
        }
        if let Some(ref bgm) = chapter.default_bgm {
            out.push_str(&format!("default_bgm: {bgm}\n"));
        }
        out.push_str("---\n");

        for scene in &chapter.scenes {
            out.push('\n');
            let view_suffix = match scene.view {
                SceneView::Raycast => " [view=raycast]",
                SceneView::TopDown => "",
            };
            out.push_str(&format!(
                "## {}: {}{}\n",
                scene.id, scene.title, view_suffix
            ));
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
                voice_path,
                font_family,
                fit,
            } => {
                // Add blank line before dialog if previous was also dialog (new speech block)
                if prev_was_dialog_or_text && i > 0 {
                    out.push('\n');
                }

                // Emit [フォント: family] before the dialog block (#147)。
                // 連続する Dialog/Narration で同値が続く場合もスキップしない（明示記述を保つ）。
                if let Some(ref ff) = font_family {
                    out.push_str(&format!("[フォント: {ff}]\n"));
                }
                // Emit [ボイス: path] before the dialog block
                if let Some(ref vp) = voice_path {
                    out.push_str(&format!("[ボイス: {vp}]\n"));
                }

                // Check if we need to emit a speaker line
                let need_speaker = needs_speaker_line(events, i);
                if need_speaker {
                    if let Some(ref ch) = character {
                        out.push_str(&format!("**{ch}**"));
                        // 話者行オプションを位置取りで組み立てる: expression=先頭 / position=2 番目、
                        // フィット (#294) は真偽フラグなので末尾に `フィット` トークンとして付ける。
                        // parser 側は `フィット` / `fit` を位置取りから除外してから expr/pos を読むので
                        // round-trip で安定する。fit=false かつ expr/pos なしのときは従来どおり `:` だけ。
                        let expr = expression.as_deref().unwrap_or("");
                        let pos = position.as_deref().unwrap_or("");
                        let mut attrs: Vec<&str> = Vec::new();
                        if !pos.is_empty() {
                            // position があれば expression が空でも位置取りを保つため両方積む。
                            attrs.push(expr);
                            attrs.push(pos);
                        } else if !expr.is_empty() {
                            attrs.push(expr);
                        }
                        if *fit {
                            attrs.push("フィット");
                        }
                        if attrs.is_empty() {
                            out.push_str(":\n");
                        } else {
                            out.push_str(&format!(" ({}):\n", attrs.join(", ")));
                        }
                    }
                }

                for line in text {
                    out.push_str(line);
                    out.push('\n');
                }

                prev_was_dialog_or_text = true;
            }
            Event::Narration {
                text,
                voice_path,
                font_family,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                if let Some(ref ff) = font_family {
                    out.push_str(&format!("[フォント: {ff}]\n"));
                }
                if let Some(ref vp) = voice_path {
                    out.push_str(&format!("[ボイス: {vp}]\n"));
                }
                for line in text {
                    out.push_str(&format!("> {line}\n"));
                }
                prev_was_dialog_or_text = true;
            }
            Event::Background {
                path,
                fade_top,
                fade_bottom,
                fade_left,
                fade_right,
                brightness,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                // #250 端フェード kv を 上→下→左→右、続けて 明るさ の順、日本語キーで正規化出力する。
                let mut kv = String::new();
                if let Some(n) = fade_top {
                    kv.push_str(&format!(", フェード上={n}"));
                }
                if let Some(n) = fade_bottom {
                    kv.push_str(&format!(", フェード下={n}"));
                }
                if let Some(n) = fade_left {
                    kv.push_str(&format!(", フェード左={n}"));
                }
                if let Some(n) = fade_right {
                    kv.push_str(&format!(", フェード右={n}"));
                }
                if let Some(b) = brightness {
                    kv.push_str(&format!(", 明るさ={b}"));
                }
                out.push_str(&format!("[背景: {path}{kv}]\n"));
                prev_was_dialog_or_text = false;
            }
            Event::BackgroundColor { color } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[背景色: {color}]\n"));
                prev_was_dialog_or_text = false;
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
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                // #252 kv を 位置→スケール→ループ→ミュート→フェード上/下/左/右 の順、
                // 日本語キーで正規化出力する（Some のものだけ。round-trip 安定）。
                let mut kv = String::new();
                if let Some(p) = position {
                    kv.push_str(&format!(", 位置={p}"));
                }
                if let Some(s) = scale {
                    kv.push_str(&format!(", スケール={s}"));
                }
                if let Some(l) = loop_ {
                    kv.push_str(&format!(", ループ={l}"));
                }
                if let Some(m) = mute {
                    kv.push_str(&format!(", ミュート={m}"));
                }
                if let Some(n) = fade_top {
                    kv.push_str(&format!(", フェード上={n}"));
                }
                if let Some(n) = fade_bottom {
                    kv.push_str(&format!(", フェード下={n}"));
                }
                if let Some(n) = fade_left {
                    kv.push_str(&format!(", フェード左={n}"));
                }
                if let Some(n) = fade_right {
                    kv.push_str(&format!(", フェード右={n}"));
                }
                out.push_str(&format!("[動画: {path}{kv}]\n"));
                prev_was_dialog_or_text = false;
            }
            Event::VideoExit => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str("[動画退場]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Bgm {
                path,
                action,
                fade_ms,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                match action {
                    BgmAction::Play => {
                        if let Some(ref p) = path {
                            match fade_ms {
                                Some(ms) => out.push_str(&format!("[BGM: {p}, フェード={ms}]\n")),
                                None => out.push_str(&format!("[BGM: {p}]\n")),
                            }
                        }
                    }
                    BgmAction::Stop => match fade_ms {
                        Some(ms) => out.push_str(&format!("[BGM停止: フェード={ms}]\n")),
                        None => out.push_str("[BGM停止]\n"),
                    },
                }
                prev_was_dialog_or_text = false;
            }
            Event::Se { path, fade_ms } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                match fade_ms {
                    Some(ms) => out.push_str(&format!("[SE: {path}, フェード={ms}]\n")),
                    None => out.push_str(&format!("[SE: {path}]\n")),
                }
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
            Event::PageBreak => {
                // 手動改頁マーカー (#292 Phase 2)。本文中の単独 `---` 行に戻す。
                // 直前がセリフ/テキストなら空行を 1 つ挟んでから `---` を出す（front matter の
                // 区切りと視覚的に揃え、前のセリフ行に貼り付かないようにする）。
                // prev_was_dialog_or_text は true のまま据え置く: `---` を挟んでも次の同一話者
                // セリフは継続行（話者名なし）として emit したいので、間に PageBreak があっても
                // 「直前はセリフ」という連続性を崩さない（needs_speaker_line も PageBreak を透過する）。
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str("---\n");
            }
            Event::Exit { character } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[退場: {character}]\n"));
                prev_was_dialog_or_text = false;
            }
            Event::Wait { ms } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[待機: {ms}]\n"));
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
                    FlagValue::String(s) => format!("\"{s}\""),
                    FlagValue::Number(n) => format_number(*n),
                };
                out.push_str(&format!("[フラグ: {name} = {val_str}]\n"));
                prev_was_dialog_or_text = false;
            }
            Event::Condition {
                flag,
                events: inner,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[条件: {flag}]\n"));
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
                out.push_str(&format!("**{character}** → {expression}:\n"));
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

                // Height blocks (Issue #90): emit after the map in order wall/floor/ceiling.
                // Each block uses the 日本語 tag and space-separated f64 rows.
                if let Some(heights) = &map.wall_heights {
                    emit_height_block(out, "壁高さ", heights);
                }
                if let Some(heights) = &map.floor_heights {
                    emit_height_block(out, "床高さ", heights);
                }
                if let Some(heights) = &map.ceiling_heights {
                    emit_height_block(out, "天井高さ", heights);
                }

                // エンカウント設定 (#172)
                if let Some(rate) = map.encounter_rate {
                    if rate == 0 {
                        out.push_str("[エンカウント率: 0]\n");
                    } else {
                        out.push_str(&format!("[エンカウント率: 1/{rate}]\n"));
                    }
                }
                if let Some(groups) = &map.encounter_groups {
                    if !groups.is_empty() {
                        out.push_str(&format!("[エンカウント群: {}]\n", groups.join(", ")));
                    }
                }

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
                // Emit `id=...` only when the stored id differs from what the
                // slugger would produce from the name (so names that slugify
                // cleanly keep the markup visually short).
                let id_suffix = match npc_base_slug(&npc.name) {
                    Some(slug) if slug == npc.id => String::new(),
                    _ => format!(" id={}", npc.id),
                };
                let sprite_suffix = match &npc.sprite {
                    Some(path) if !path.is_empty() => format!(" sprite={path}"),
                    _ => String::new(),
                };
                let frames_suffix = match npc.frames {
                    Some(n) => format!(" frames={n}"),
                    None => String::new(),
                };
                let direction_suffix = match npc.direction {
                    Some(d) => format!(" 向き={}", direction_ja(d)),
                    None => String::new(),
                };
                let portrait_suffix = match &npc.portrait {
                    Some(path) if !path.is_empty() => format!(" portrait={path}"),
                    _ => String::new(),
                };
                let expressions_suffix = if npc.expressions.is_empty() {
                    String::new()
                } else {
                    // BTreeMap でソートして順序を安定化（保存のたびに diff が出るのを防ぐ）
                    let mut pairs: Vec<_> = npc.expressions.iter().collect();
                    pairs.sort_by_key(|(k, _)| k.as_str());
                    format!(
                        " expressions={}",
                        pairs
                            .iter()
                            .map(|(k, v)| format!("{k}:{v}"))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                };
                let scene_suffix = match &npc.scene {
                    Some(s) if !s.is_empty() => format!(" scene={s}"),
                    _ => String::new(),
                };
                out.push_str(&format!(
                    "[NPC {} @{},{} 色=#{:06x}{}{}{}{}{}{}{}]\n",
                    npc.name,
                    npc.x,
                    npc.y,
                    npc.color,
                    id_suffix,
                    sprite_suffix,
                    frames_suffix,
                    direction_suffix,
                    portrait_suffix,
                    expressions_suffix,
                    scene_suffix
                ));
                for line in &npc.message {
                    out.push_str(line);
                    out.push('\n');
                }
                out.push_str("[/NPC]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Monster(m) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[モンスター {}]\n", m.id));
                out.push_str(&format!("名前: {}\n", m.name));
                out.push_str(&format!("HP: {}\n", m.hp));
                if m.mp > 0 {
                    out.push_str(&format!("MP: {}\n", m.mp));
                }
                out.push_str(&format!("ATK: {}\n", m.atk));
                out.push_str(&format!("DEF: {}\n", m.def_value));
                out.push_str(&format!("AGI: {}\n", m.agi));
                out.push_str(&format!("EXP: {}\n", m.exp));
                out.push_str(&format!("GOLD: {}\n", m.gold));
                if let Some(s) = &m.sprite {
                    out.push_str(&format!("スプライト: {s}\n"));
                }
                if let Some(b) = &m.builtin {
                    out.push_str(&format!("builtin: {b}\n"));
                }
                out.push_str("[/モンスター]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Item(it) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[アイテム {}]\n", it.id));
                out.push_str(&format!("名前: {}\n", it.name));
                out.push_str(&format!("種別: {}\n", it.kind));
                if let Some(p) = it.price {
                    out.push_str(&format!("価格: {p}\n"));
                }
                if let Some(e) = &it.effect {
                    out.push_str(&format!("効果: {e}\n"));
                }
                if let Some(b) = &it.builtin {
                    out.push_str(&format!("builtin: {b}\n"));
                }
                out.push_str("[/アイテム]\n");
                prev_was_dialog_or_text = false;
            }
            Event::PartyMember(p) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[パーティ {}]\n", p.id));
                out.push_str(&format!("名前: {}\n", p.name));
                if let Some(s) = &p.sprite {
                    out.push_str(&format!("スプライト: {s}\n"));
                }
                if p.level > 1 {
                    out.push_str(&format!("レベル: {}\n", p.level));
                }
                out.push_str(&format!("HP: {}\n", p.hp));
                if p.mp > 0 {
                    out.push_str(&format!("MP: {}\n", p.mp));
                }
                out.push_str(&format!("ATK: {}\n", p.atk));
                out.push_str(&format!("DEF: {}\n", p.def_value));
                out.push_str(&format!("AGI: {}\n", p.agi));
                if let Some(learns) = &p.learns {
                    for l in learns {
                        out.push_str(&format!("習得: Lv{} {}\n", l.level, l.spell));
                    }
                }
                out.push_str("[/パーティ]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Spell(sp) => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[呪文 {}]\n", sp.id));
                out.push_str(&format!("名前: {}\n", sp.name));
                out.push_str(&format!("MP: {}\n", sp.mp));
                out.push_str(&format!("対象: {}\n", sp.target));
                if let Some(s) = &sp.school {
                    out.push_str(&format!("系統: {s}\n"));
                }
                if let Some(e) = &sp.effect {
                    out.push_str(&format!("効果: {e}\n"));
                }
                if let Some(b) = &sp.builtin {
                    out.push_str(&format!("builtin: {b}\n"));
                }
                out.push_str("[/呪文]\n");
                prev_was_dialog_or_text = false;
            }
            Event::RpgEvent { name, commands } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!("[イベント {name}]\n"));
                for cmd in commands {
                    match cmd {
                        EventCommand::NpcMove {
                            npc,
                            x,
                            y,
                            speed,
                            direction,
                        } => {
                            let dir_part = match direction {
                                Some(d) => format!(" 向き={}", direction_ja(*d)),
                                None => String::new(),
                            };
                            out.push_str(&format!(
                                "[NPC移動: {npc} → @{x},{y} 速度={speed}{dir_part}]\n"
                            ));
                        }
                        EventCommand::Wait { ms } => {
                            out.push_str(&format!("[待機: {ms}]\n"));
                        }
                        EventCommand::Dialog { character, text } => {
                            if let Some(ch) = character {
                                out.push_str(&format!("**{ch}**:\n"));
                            }
                            for line in text {
                                out.push_str(line);
                                out.push('\n');
                            }
                        }
                        EventCommand::Narration { text } => {
                            for line in text {
                                out.push_str(&format!("> {line}\n"));
                            }
                        }
                    }
                }
                out.push_str("[/イベント]\n");
                prev_was_dialog_or_text = false;
            }
            Event::RpgTrigger {
                x,
                y,
                auto,
                scene,
                once,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                let pos_part = if *auto {
                    "auto".to_string()
                } else if let (Some(tx), Some(ty)) = (x, y) {
                    format!("@{tx},{ty}")
                } else {
                    eprintln!(
                        "[name-name] 警告: RpgTrigger に auto=false かつ x/y=None の不正データ"
                    );
                    "auto".to_string()
                };
                let once_part = if *once { " once=true" } else { "" };
                out.push_str(&format!("[トリガー {pos_part} scene={scene}{once_part}]\n"));
                prev_was_dialog_or_text = false;
            }
            Event::Animate {
                target,
                dx,
                dy,
                rotation,
                scale,
                duration_ms,
                easing,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                let mut parts: Vec<String> = vec![format!("target={}", target)];
                if let Some(v) = dx {
                    parts.push(format!("x={v}"));
                }
                if let Some(v) = dy {
                    parts.push(format!("y={v}"));
                }
                if let Some(v) = rotation {
                    parts.push(format!("rotation={v}"));
                }
                if let Some(v) = scale {
                    parts.push(format!("scale={v}"));
                }
                parts.push(format!("duration={duration_ms}"));
                if *easing != crate::models::Easing::Linear {
                    parts.push(format!("easing={}", easing_keyword(*easing)));
                }
                out.push_str(&format!("[アニメ: {}]\n", parts.join(", ")));
                prev_was_dialog_or_text = false;
            }
            Event::TextEffect {
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
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                let mut parts: Vec<String> = vec![format!("target={}", target)];
                if let Some(e) = effect {
                    let effect_str = match e {
                        crate::models::TextEffectPreset::Explode => "explode",
                        crate::models::TextEffectPreset::Typewriter => "typewriter",
                    };
                    parts.push(format!("effect={effect_str}"));
                }
                if let Some(v) = stagger_ms {
                    parts.push(format!("stagger={v}"));
                }
                if let Some(v) = ms_per_char {
                    parts.push(format!("speed={v}"));
                }
                if let Some(v) = dx {
                    parts.push(format!("x={v}"));
                }
                if let Some(v) = dy {
                    parts.push(format!("y={v}"));
                }
                if let Some(v) = rotation {
                    parts.push(format!("rotation={v}"));
                }
                if let Some(v) = scale {
                    parts.push(format!("scale={v}"));
                }
                if let Some(v) = alpha {
                    parts.push(format!("alpha={v}"));
                }
                if let Some(v) = duration_ms {
                    parts.push(format!("duration={v}"));
                }
                if let Some(e) = easing {
                    parts.push(format!("easing={}", easing_keyword(*e)));
                }
                // #271: カーソル系。round-trip のため英語キー (cursor=on/off) に正規化する。
                if let Some(c) = cursor {
                    parts.push(format!("cursor={}", if *c { "on" } else { "off" }));
                }
                if let Some(v) = blink_ms {
                    parts.push(format!("blink={v}"));
                }
                if let Some(v) = cursor_color {
                    parts.push(format!("cursor_color={v}"));
                }
                out.push_str(&format!("[文字演出: {}]\n", parts.join(", ")));
                prev_was_dialog_or_text = false;
            }
            Event::Underline {
                target,
                color,
                thickness,
                duration_ms,
                offset,
                easing,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                // round-trip のため英語キーに正規化する（parse_underline_directive が受理する綴り）。
                let mut parts: Vec<String> = vec![format!("target={}", target)];
                if let Some(v) = color {
                    parts.push(format!("color={v}"));
                }
                if let Some(v) = thickness {
                    parts.push(format!("thickness={v}"));
                }
                if let Some(v) = duration_ms {
                    parts.push(format!("duration={v}"));
                }
                if let Some(v) = offset {
                    parts.push(format!("offset={v}"));
                }
                if let Some(e) = easing {
                    parts.push(format!("easing={}", easing_keyword(*e)));
                }
                out.push_str(&format!("[下線: {}]\n", parts.join(", ")));
                prev_was_dialog_or_text = false;
            }
            Event::TitleShow {
                text,
                font_family,
                position,
                color,
                size,
                x,
                y,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str("[タイトル: ");
                out.push_str(text);
                if let Some(f) = font_family {
                    out.push_str(", font=");
                    out.push_str(f);
                }
                if let Some(p) = position {
                    out.push_str(", 位置=");
                    out.push_str(p);
                }
                // タイトル文字色 (#273)。日本語キー `色=` で round-trip 出力する。
                if let Some(c) = color {
                    out.push_str(", 色=");
                    out.push_str(c);
                }
                // タイトル文字サイズ・位置 override (#275)。日本語キーに正規化して出力。
                if let Some(s) = size {
                    out.push_str(&format!(", サイズ={s}"));
                }
                if let Some(xv) = x {
                    out.push_str(&format!(", x={xv}"));
                }
                if let Some(yv) = y {
                    out.push_str(&format!(", y={yv}"));
                }
                out.push_str("]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Label {
                text,
                color,
                position,
                size,
                id,
                font_family,
                align,
                after,
                x,
                y,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                // round-trip のため日本語キーに正規化する（英語キー入力も日本語で出す）。
                out.push_str("[ラベル: ");
                // 前後スペース等、parser の trim で失われる内容を持つ text は `"..."` で囲って
                // round-trip を安定させる (#275)。通常 text はクオート無しのまま出す。
                out.push_str(&quote_label_text_if_needed(text));
                if let Some(c) = color {
                    out.push_str(", 色=");
                    out.push_str(c);
                }
                if let Some(p) = position {
                    out.push_str(", 位置=");
                    out.push_str(p);
                }
                if let Some(s) = size {
                    out.push_str(&format!(", サイズ={s}"));
                }
                if let Some(i) = id {
                    out.push_str(", id=");
                    out.push_str(i);
                }
                if let Some(f) = font_family {
                    out.push_str(", font=");
                    out.push_str(f);
                }
                // 揃え・隣接・位置 override (#275)。日本語キーに正規化して出力。
                // align は正規化済み英語値（left/center/right）をそのまま値に書く。
                if let Some(a) = align {
                    out.push_str(", 揃え=");
                    out.push_str(a);
                }
                if let Some(af) = after {
                    out.push_str(", 後ろ=");
                    out.push_str(af);
                }
                if let Some(xv) = x {
                    out.push_str(&format!(", x={xv}"));
                }
                if let Some(yv) = y {
                    out.push_str(&format!(", y={yv}"));
                }
                out.push_str("]\n");
                prev_was_dialog_or_text = false;
            }
            Event::Image {
                path,
                position,
                shape,
                size,
                id,
                x,
                y,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                // round-trip のため日本語キーに正規化する。円形は `形状=円形` の kv 形で出す
                // （値なしフラグ入力 `円形` も `形状=円形` に正規化）。
                out.push_str("[画像: ");
                out.push_str(path);
                if let Some(p) = position {
                    out.push_str(", 位置=");
                    out.push_str(p);
                }
                if let Some(s) = shape {
                    out.push_str(", 形状=");
                    out.push_str(s);
                }
                if let Some(sz) = size {
                    out.push_str(&format!(", サイズ={sz}"));
                }
                if let Some(i) = id {
                    out.push_str(", id=");
                    out.push_str(i);
                }
                // 位置 override (#275)。日本語キーは無く x/y で round-trip。
                if let Some(xv) = x {
                    out.push_str(&format!(", x={xv}"));
                }
                if let Some(yv) = y {
                    out.push_str(&format!(", y={yv}"));
                }
                out.push_str("]\n");
                prev_was_dialog_or_text = false;
            }
            Event::DialogBorderless { borderless } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(if *borderless {
                    "[枠なし]\n"
                } else {
                    "[枠あり]\n"
                });
                prev_was_dialog_or_text = false;
            }
            Event::Shake {
                intensity_px,
                duration_ms,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!(
                    "[シェイク: intensity={intensity_px}, duration={duration_ms}]\n"
                ));
                prev_was_dialog_or_text = false;
            }
            Event::Flash {
                color,
                alpha,
                duration_ms,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!(
                    "[フラッシュ: color={color}, alpha={alpha}, duration={duration_ms}]\n"
                ));
                prev_was_dialog_or_text = false;
            }
            Event::Fade {
                target,
                color,
                from_alpha,
                to_alpha,
                duration_ms,
            } => {
                if prev_was_dialog_or_text {
                    out.push('\n');
                }
                out.push_str(&format!(
                    "[フェード: target={target}, color={color}, from={from_alpha}, to={to_alpha}, duration={duration_ms}]\n"
                ));
                prev_was_dialog_or_text = false;
            }
        }
    }
}

/// ラベル本文を round-trip 安定に emit する (#275)。
///
/// parser は bare な text を `trim()` する（`extract_label_text`）。そのため前後スペースを
/// 持つ text（`"$ "` のプロンプト記号など）はクオート無しで出すと再 parse で消える。
/// 前後に空白がある場合だけ `"..."` で囲んで前後スペースを保持する。通常 text（前後空白なし）
/// はクオート無しのまま出す。クオート内カンマは非対応（parser の `split(',')` 制約）。
fn quote_label_text_if_needed(text: &str) -> String {
    let needs_quote = text != text.trim();
    if needs_quote {
        format!("\"{text}\"")
    } else {
        text.to_string()
    }
}

/// Easing を Markdown キーワードに変換する (#134 / #268)。
/// parse_easing が受理する英語表記に揃える（round-trip 一致）。
fn easing_keyword(easing: crate::models::Easing) -> &'static str {
    match easing {
        crate::models::Easing::Linear => "linear",
        crate::models::Easing::EaseIn => "ease-in",
        crate::models::Easing::EaseOut => "ease-out",
        crate::models::Easing::EaseInOut => "ease-in-out",
        crate::models::Easing::EaseOutBack => "ease-out-back",
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
    // 直前イベントを探すとき、手動改頁マーカー (#292) は透過する。
    // `---` で割られた同一話者の継続セリフは、`---` を挟んでも話者名を再掲しない
    // （`セリフ。\n---\nセリフ。` を 1 話者の 2 ページとして round-trip させる）。
    // PageBreak だけが連続するケース（`---\n---`）も遡って最初の非 PageBreak まで見る。
    let mut prev_idx = idx;
    while prev_idx > 0 {
        prev_idx -= 1;
        if !matches!(events[prev_idx], Event::PageBreak) {
            break;
        }
    }
    // 遡った先がまだ PageBreak（＝先頭から PageBreak しかなかった）なら話者行が要る。
    if matches!(events[prev_idx], Event::PageBreak) {
        return true;
    }
    // Look at previous event
    let prev = &events[prev_idx];
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

// 注: f64 演算結果（例: 0.1 + 0.2 = 0.30000000000000004）をそのまま書き戻すと
// 冗長桁が出る。現状は parser 入力由来の値しか通らないので問題ないが、エディタ側で
// 演算結果を書き戻す場合は整数または 0.25 刻みを推奨。必要なら ryu 等で丸める。
fn format_number(n: f64) -> String {
    if n == n.floor() && n.is_finite() {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// 高さブロックを emit する。各値は `1.0 → "1"`, `0.25 → "0.25"` で書く。
/// 行頭で空行を一つ挟み、ブロック終端の後は改行のみ残す（他ブロックのスタイルに合わせる）。
fn emit_height_block(out: &mut String, tag: &str, rows: &[Vec<f64>]) {
    out.push('\n');
    writeln!(out, "[{tag}]").unwrap();
    for row in rows {
        let mut first = true;
        for v in row {
            if !first {
                out.push(' ');
            }
            out.push_str(&format_number(*v));
            first = false;
        }
        out.push('\n');
    }
    writeln!(out, "[/{tag}]").unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_emit_simple() {
        let doc = Document {
            engine: "name-name".to_string(),
            aspect_ratio: "16:9".to_string(),
            choice_style: None,
            font_family: None,
            font_size: None,
            dialog_style: None,
            protagonist: None,
            character_y_ratio: None,
            character_height_ratio: None,
            character_fade_ms: None,
            skip_enabled: None,
            debug_enabled: None,
            chapters: vec![Chapter {
                number: 1,
                title: "テスト".to_string(),
                hidden: false,
                default_bgm: None,
                scenes: vec![Scene {
                    id: "1-1".to_string(),
                    title: "テスト".to_string(),
                    view: SceneView::TopDown,
                    events: vec![Event::Dialog {
                        character: Some("カコ".to_string()),
                        expression: Some("suppin_1".to_string()),
                        position: Some("左".to_string()),
                        text: vec!["こんにちは。".to_string()],
                        voice_path: None,
                        font_family: None,
                        fit: false,
                    }],
                }],
            }],
        };

        let output = emit(&doc);
        assert!(output.contains("**カコ** (suppin_1, 左):"));
        assert!(output.contains("こんにちは。"));
    }

    // ===== Master data blocks (#174) =====

    #[test]
    fn emits_monster_block() {
        let doc = make_doc_with_event(Event::Monster(MonsterDef {
            id: "slime".to_string(),
            name: "スライム".to_string(),
            hp: 10,
            mp: 0,
            atk: 3,
            def_value: 1,
            agi: 2,
            exp: 2,
            gold: 1,
            sprite: Some("monsters/slime.png".to_string()),
            builtin: None,
        }));
        let out = emit(&doc);
        assert!(out.contains("[モンスター slime]"));
        assert!(out.contains("名前: スライム"));
        assert!(out.contains("HP: 10"));
        assert!(out.contains("ATK: 3"));
        assert!(out.contains("DEF: 1"));
        assert!(out.contains("スプライト: monsters/slime.png"));
        assert!(out.contains("[/モンスター]"));
        // MP は 0 のとき省略
        assert!(!out.contains("MP: 0"));
    }

    #[test]
    fn emits_item_block_with_effect() {
        let doc = make_doc_with_event(Event::Item(ItemDef {
            id: "やくそう".to_string(),
            name: "やくそう".to_string(),
            kind: "回復".to_string(),
            price: Some(8),
            effect: Some("heal 30".to_string()),
            builtin: None,
        }));
        let out = emit(&doc);
        assert!(out.contains("[アイテム やくそう]"));
        assert!(out.contains("名前: やくそう"));
        assert!(out.contains("種別: 回復"));
        assert!(out.contains("価格: 8"));
        assert!(out.contains("効果: heal 30"));
        assert!(out.contains("[/アイテム]"));
    }

    #[test]
    fn emits_spell_block_with_builtin() {
        let doc = make_doc_with_event(Event::Spell(SpellDef {
            id: "ザラキ".to_string(),
            name: "ザラキ".to_string(),
            mp: 8,
            target: "敵全体".to_string(),
            effect: None,
            builtin: Some("zaraki".to_string()),
            school: None,
        }));
        let out = emit(&doc);
        assert!(out.contains("[呪文 ザラキ]"));
        assert!(out.contains("MP: 8"));
        assert!(out.contains("対象: 敵全体"));
        assert!(out.contains("builtin: zaraki"));
        assert!(out.contains("[/呪文]"));
    }

    #[test]
    fn round_trip_master_blocks() {
        // parse → emit → parse がフィールド一致で安定することを確認
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## data: マスター\n\n[モンスター slime]\n名前: スライム\nHP: 10\nATK: 3\nDEF: 1\nAGI: 2\nEXP: 2\nGOLD: 1\n[/モンスター]\n\n[呪文 ホイミ]\n名前: ホイミ\nMP: 4\n対象: 味方単体\n効果: heal 15..25\n[/呪文]\n\n[アイテム やくそう]\n名前: やくそう\n種別: 回復\n価格: 8\n効果: heal 30\n[/アイテム]\n";
        let doc1 = crate::parser::parse(input);
        let emitted = emit(&doc1);
        let doc2 = crate::parser::parse(&emitted);
        assert_eq!(doc1, doc2, "master data round-trip should be stable");
    }

    #[test]
    fn round_trip_character_height_ratio() {
        // frontmatter の character_height_ratio (#360) が parse → emit → parse で保持されること。
        // character_y_ratio(#308) と同型の per-game 数値設定。emit は quote なしの数値行で出す。
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\ncharacter_height_ratio: 0.8\n---\n\n## 1-1: シーン\n\nナレ。\n";
        let doc1 = crate::parser::parse(input);
        assert_eq!(
            doc1.character_height_ratio,
            Some(0.8),
            "frontmatter の character_height_ratio が数値で parse されること"
        );

        let emitted = emit(&doc1);
        assert!(
            emitted.contains("character_height_ratio: 0.8"),
            "emit 出力に character_height_ratio が含まれること（quote なしの数値）: {emitted}"
        );

        let doc2 = crate::parser::parse(&emitted);
        assert_eq!(
            doc2.character_height_ratio,
            Some(0.8),
            "round-trip で character_height_ratio が保持される"
        );
        assert_eq!(
            doc1, doc2,
            "character_height_ratio round-trip should be stable"
        );
    }

    fn make_doc_with_event(event: Event) -> Document {
        Document {
            engine: "name-name".to_string(),
            aspect_ratio: "16:9".to_string(),
            choice_style: None,
            font_family: None,
            font_size: None,
            dialog_style: None,
            protagonist: None,
            character_y_ratio: None,
            character_height_ratio: None,
            character_fade_ms: None,
            skip_enabled: None,
            debug_enabled: None,
            chapters: vec![Chapter {
                number: 1,
                title: "test".to_string(),
                hidden: false,
                default_bgm: None,
                scenes: vec![Scene {
                    id: "data".to_string(),
                    title: "マスター".to_string(),
                    view: SceneView::TopDown,
                    events: vec![event],
                }],
            }],
        }
    }

    // ===== Encounter (#172) =====

    #[test]
    fn emits_encounter_rate_and_groups_after_map() {
        let map = RpgMapData {
            width: 3,
            height: 3,
            tile_size: 32,
            tiles: vec![vec![0; 3]; 3],
            wall_heights: None,
            floor_heights: None,
            ceiling_heights: None,
            encounter_rate: Some(16),
            encounter_groups: Some(vec!["slime".into(), "slime+ghost".into()]),
        };
        let doc = make_doc_with_event(Event::RpgMap(map));
        let out = emit(&doc);
        assert!(out.contains("[エンカウント率: 1/16]"));
        assert!(out.contains("[エンカウント群: slime, slime+ghost]"));
    }

    #[test]
    fn encounter_rate_zero_emits_zero_form() {
        let map = RpgMapData {
            width: 3,
            height: 3,
            tile_size: 32,
            tiles: vec![vec![0; 3]; 3],
            wall_heights: None,
            floor_heights: None,
            ceiling_heights: None,
            encounter_rate: Some(0),
            encounter_groups: None,
        };
        let doc = make_doc_with_event(Event::RpgMap(map));
        let out = emit(&doc);
        assert!(out.contains("[エンカウント率: 0]"));
        assert!(!out.contains("1/0"));
    }

    #[test]
    fn round_trip_encounter() {
        let input = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## m: m\n\n[マップ 3x3 タイル=32]\nGGG\nGGG\nGGG\n[/マップ]\n[エンカウント率: 1/16]\n[エンカウント群: slime, ghost]\n";
        let doc1 = crate::parser::parse(input);
        let emitted = emit(&doc1);
        let doc2 = crate::parser::parse(&emitted);
        assert_eq!(doc1, doc2, "encounter round-trip should be stable");
    }
}
