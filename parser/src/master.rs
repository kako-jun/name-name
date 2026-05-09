//! マスターデータブロック (#174 / #175) のパース。
//!
//! `[モンスター <id>]` / `[アイテム <id>]` / `[呪文 <id>]` / `[パーティ <id>]` の
//! 4 種類のブロックを統一的に処理する。すべてヘッダ + key:value ボディ + 終端タグの
//! 構造を持ち、ボディ部の解釈だけが kind ごとに違う。
//!
//! parser.rs の本体ループから 1 関数 `try_parse_master_data_block` を呼び出すことで
//! 4 種すべてを判定する。各 kind の組み立ては `build_*_def` に委譲する。

use crate::models::*;

pub(crate) struct ParsedMasterBlock {
    pub event: Event,
    pub next_pos: usize,
}

/// `[モンスター <id>]` / `[アイテム <id>]` / `[呪文 <id>]` / `[パーティ <id>]` の
/// いずれかを検出して、ボディの key: value ペアからオブジェクトを組み立てる。
/// 検出に失敗（ヘッダ形式不一致 / 必須項目欠落）した場合は `None` を返し、
/// 呼び出し側は次の解釈ルートへ進む。
pub(crate) fn try_parse_master_data_block(
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
        MasterKind::PartyMember => Event::PartyMember(build_party_member_def(id, &body.entries)?),
    };

    Some(ParsedMasterBlock { event, next_pos })
}

#[derive(Clone, Copy)]
enum MasterKind {
    Monster,
    Item,
    Spell,
    PartyMember,
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
    if let Some(rest) = header.strip_prefix("[パーティ ") {
        let id = rest.strip_suffix(']')?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        return Some((MasterKind::PartyMember, id, "[/パーティ]"));
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
    let kind =
        lookup_master_string(entries, &["種別", "kind"]).unwrap_or_else(|| "その他".to_string());
    ItemDef {
        id,
        name,
        kind,
        price: lookup_master_value(entries, &["価格", "price"]).and_then(|v| v.parse().ok()),
        effect: lookup_master_string(entries, &["効果", "effect"]),
        builtin: lookup_master_string(entries, &["builtin"]),
    }
}

fn build_party_member_def(id: String, entries: &[(String, String)]) -> Option<PartyMemberDef> {
    let name = lookup_master_string(entries, &["名前", "name"])?;
    if name.is_empty() {
        return None;
    }
    Some(PartyMemberDef {
        id,
        name,
        sprite: lookup_master_string(entries, &["スプライト", "sprite"]),
        level: lookup_master_u32(entries, &["レベル", "level", "Lv"], 1).max(1),
        hp: lookup_master_u32(entries, &["HP", "hp"], 1),
        mp: lookup_master_u32(entries, &["MP", "mp"], 0),
        atk: lookup_master_u32(entries, &["ATK", "atk", "攻撃"], 0),
        def_value: lookup_master_u32(entries, &["DEF", "def", "守備"], 0),
        agi: lookup_master_u32(entries, &["AGI", "agi", "素早さ"], 0),
        // 「習得」キーは複数行 OK で `Lv4 ホイミ` / `4 ホイミ` のような形式を受理する
        learns: collect_party_learns(entries),
    })
}

/// `習得` / `learns` のキー値ペアを複数集めて Vec<PartyLearns> にする。
/// 形式: "Lv4 ホイミ" / "4 ホイミ" / "level=4 spell=ホイミ" すべて受理。
fn collect_party_learns(entries: &[(String, String)]) -> Option<Vec<PartyLearns>> {
    let mut out: Vec<PartyLearns> = Vec::new();
    for (k, v) in entries {
        if k != "習得" && k != "learns" {
            continue;
        }
        let trimmed = v.trim();
        if trimmed.is_empty() {
            continue;
        }
        // パターン 1: "level=4 spell=ホイミ"
        if trimmed.contains('=') {
            let mut level: Option<u32> = None;
            let mut spell: Option<String> = None;
            for token in trimmed.split_whitespace() {
                if let Some(val) = token.strip_prefix("level=") {
                    level = val.parse().ok();
                } else if let Some(val) = token.strip_prefix("spell=") {
                    spell = Some(val.to_string());
                }
            }
            if let (Some(lv), Some(sp)) = (level, spell) {
                out.push(PartyLearns {
                    level: lv,
                    spell: sp,
                });
                continue;
            }
        }
        // パターン 2: "Lv4 ホイミ" / "4 ホイミ"
        let mut tokens = trimmed.split_whitespace();
        let lv_token = tokens.next()?;
        let lv_str = lv_token.strip_prefix("Lv").unwrap_or(lv_token);
        let lv = lv_str.parse::<u32>().ok()?;
        let spell: String = tokens.collect::<Vec<_>>().join(" ");
        if spell.is_empty() {
            continue;
        }
        out.push(PartyLearns { level: lv, spell });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
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
