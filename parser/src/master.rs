//! マスターデータブロック (#174 / #175) のパース。
//!
//! `[モンスター <id>]` / `[アイテム <id>]` / `[呪文 <id>]` / `[特技 <id>]` / `[パーティ <id>]` の
//! 5 種類のブロックを統一的に処理する。すべてヘッダ + key:value ボディ + 終端タグの
//! 構造を持ち、ボディ部の解釈だけが kind ごとに違う。
//!
//! parser.rs の本体ループから 1 関数 `try_parse_master_data_block` を呼び出すことで
//! 5 種すべてを判定する。各 kind の組み立ては `build_*_def` に委譲する。

use crate::models::*;
use crate::parser::emit_warning;

pub(crate) struct ParsedMasterBlock {
    pub event: Event,
    pub next_pos: usize,
}

/// `[モンスター <id>]` / `[アイテム <id>]` / `[呪文 <id>]` / `[特技 <id>]` / `[パーティ <id>]` の
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
        MasterKind::Skill => Event::Skill(build_skill_def(id, &body.entries)?),
        MasterKind::PartyMember => Event::PartyMember(build_party_member_def(id, &body.entries)?),
    };

    Some(ParsedMasterBlock { event, next_pos })
}

#[derive(Clone, Copy)]
enum MasterKind {
    Monster,
    Item,
    Spell,
    Skill,
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
    if let Some(rest) = header.strip_prefix("[特技 ") {
        let id = rest.strip_suffix(']')?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        return Some((MasterKind::Skill, id, "[/特技]"));
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
        poses: collect_poses(entries),
        builtin: lookup_master_string(entries, &["builtin"]),
        actions: collect_actions(entries),
        counters: collect_values(entries, &["反撃", "counter"]),
        on_death: collect_values(entries, &["死亡時", "onDeath", "on_death"])
            .and_then(|v| v.into_iter().next()),
        size: collect_size(entries),
        scale: collect_scale(entries),
        affinity: collect_affinity(entries),
    })
}

/// 属性相性の 4 欄のキー（別名を含む）。優先順位の高い順（吸収 > 無効 > 半減 > 弱点）で並べる (#872)。
const AFFINITY_COLUMNS: [(&str, &[&str]); 4] = [
    ("吸収", &["吸収", "absorb"]),
    ("無効", &["無効", "null", "immune"]),
    ("半減", &["半減", "halve"]),
    ("弱点", &["弱点", "weak"]),
];

/// `弱点` / `半減` / `無効` / `吸収` を属性相性にする (#872)。4 欄すべて空なら None。警告は `emit_warning` へ流す。
fn collect_affinity(entries: &[(String, String)]) -> Option<MonsterAffinity> {
    let (affinity, warnings) = interpret_affinity(entries);
    for w in warnings {
        emit_warning(&format!("[name-name-parser] warning: {w}"));
    }
    affinity
}

/// 属性 id を小文字・半角に寄せる（全角英数と `_` `-` だけを半角にし、小文字にする。半角カナ・丸数字などは変えない。JS 側 `normalizeAttrId`（`frontend/src/game/affinity.ts`）と同じ表）。
fn normalize_attr_id(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '\u{FF10}'..='\u{FF19}' | '\u{FF21}'..='\u{FF3A}' | '\u{FF41}'..='\u{FF5A}' => {
                char::from_u32(c as u32 - 0xFF00 + 0x20).unwrap_or(c)
            }
            '\u{FF3F}' => '_',
            '\u{FF0D}' => '-',
            _ => c,
        })
        .collect::<String>()
        .to_lowercase()
}

/// 属性相性の解釈（副作用なし）。戻りは (相性, 警告文の列)。
///
/// - 値は属性 id を `,` `，` `、` 空白で区切って複数指定。同じキーを複数行書いたら足し合わせる
/// - 語彙は検証しない（`type=` が自由記述なので、任意の属性を足せるようにする）
/// - 同じ属性が同じ欄に重なったら 1 つにまとめる（警告なし）。複数の欄にまたがったら警告して優先順位の高い欄を採る
/// - `無属性` / `none` は耐性欄に書けない（警告して無視）
/// - 区切りだけで属性が 1 つも取れない値は警告。値が空の行は黙って無視
fn interpret_affinity(entries: &[(String, String)]) -> (Option<MonsterAffinity>, Vec<String>) {
    let mut warnings = Vec::new();
    // 優先順位の高い欄から順に埋める。先に採られた属性が後の欄に出たら捨てる
    let mut taken: Vec<String> = Vec::new();
    let mut columns: Vec<Vec<String>> = Vec::new();
    for (label, keys) in AFFINITY_COLUMNS {
        let mut col: Vec<String> = Vec::new();
        for (k, v) in entries {
            if !keys.contains(&k.as_str()) || v.trim().is_empty() {
                continue;
            }
            let tokens: Vec<String> = v
                .split(|c: char| c == ',' || c == '，' || c == '、' || c.is_whitespace())
                .filter(|t| !t.is_empty())
                .map(normalize_attr_id)
                .collect();
            if tokens.is_empty() {
                warnings.push(format!(
                    "monster {label}: '{}' has no attribute id, ignored",
                    v.trim()
                ));
                continue;
            }
            for t in tokens {
                if t == "無属性" || t == "none" {
                    warnings.push(format!(
                        "monster {label}: '{t}' (no attribute) cannot be written in an affinity column, ignored"
                    ));
                } else if taken.contains(&t) {
                    warnings.push(format!(
                        "monster {label}: attribute '{t}' is already in a higher-priority column (吸収 > 無効 > 半減 > 弱点), ignored"
                    ));
                } else if !col.contains(&t) {
                    col.push(t);
                }
            }
        }
        taken.extend(col.iter().cloned());
        columns.push(col);
    }
    let mut it = columns.into_iter();
    let affinity = MonsterAffinity {
        absorb: it.next().unwrap_or_default(),
        nullify: it.next().unwrap_or_default(),
        halve: it.next().unwrap_or_default(),
        weak: it.next().unwrap_or_default(),
    };
    if affinity == MonsterAffinity::default() {
        (None, warnings)
    } else {
        (Some(affinity), warnings)
    }
}

/// `サイズ` / `size` を敵のサイズ区分にする (#839)。`2x1` / `2X1` / `２×１`（幅x高さ、整数 1 以上）。
/// 書かない場合は None。不正値は警告して None（＝1x1）。同じキーが複数あれば最初の 1 行が勝つ
/// （その値が空なら未指定扱いで、後の行は見ない）。
fn collect_size(entries: &[(String, String)]) -> Option<MonsterSize> {
    let (size, warning) = interpret_size(lookup_master_value(entries, &["サイズ", "size"]));
    if let Some(w) = warning {
        emit_warning(&format!("[name-name-parser] warning: {w}"));
    }
    size
}

/// `サイズ:` の値の解釈（副作用なし）。戻りは (サイズ, 警告文)。
fn interpret_size(raw: Option<&str>) -> (Option<MonsterSize>, Option<String>) {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return (None, None);
    };
    match parse_size_pair(raw) {
        Some(sz) => (Some(sz), None),
        None => (
            None,
            Some(format!(
                "invalid monster size '{raw}', falling back to 1x1. Expected e.g. 1x1 / 2x1 / 2x2"
            )),
        ),
    }
}

/// 全角英数を半角へ寄せた上で `<整数>x<整数>`（x は x / X / ×）を読む。両方 1 以上のときだけ Some。
fn parse_size_pair(raw: &str) -> Option<MonsterSize> {
    let normalized = to_halfwidth(raw);
    let (a, b) = normalized.split_once(['x', 'X', '×'])?;
    let (a, b) = (a.trim(), b.trim());
    // `u32::parse` は先頭の `+` を許すので、数字だけであることを先に見る
    if !a.chars().all(|c| c.is_ascii_digit()) || !b.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let w: u32 = a.parse().ok()?;
    let h: u32 = b.parse().ok()?;
    if w < 1 || h < 1 {
        return None;
    }
    Some(MonsterSize { w, h })
}

/// 全角の数字・`x` / `X`・`.`・`+`・`-` だけを半角へ寄せる（それ以外の全角は変えない。`×` はそのまま）。
fn to_halfwidth(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|c| match c {
            '\u{FF10}'..='\u{FF19}' => char::from_u32(c as u32 - 0xFF10 + '0' as u32).unwrap_or(c),
            '\u{FF58}' | '\u{FF38}' => 'x',
            '\u{FF0E}' => '.',
            '\u{FF0B}' => '+',
            '\u{FF0D}' => '-',
            _ => c,
        })
        .collect()
}

/// `倍率` / `scale` を 0.25〜1 に丸めた表示倍率にする (#839)。書かない場合は None。
/// 全角数字可。素直な十進数（符号・小数点・数字だけ。指数表記・`inf`・`NaN` は不可。
/// frontmatter の `battle_enemy_window_overlap` と同じ範囲）以外は警告して None（＝1）。
/// 範囲外は丸める（1 超は占有領域をはみ出すため 1）。同じキーが複数あれば最初の 1 行が勝つ。
fn collect_scale(entries: &[(String, String)]) -> Option<f64> {
    let (scale, warning) = interpret_scale(lookup_master_value(entries, &["倍率", "scale"]));
    if let Some(w) = warning {
        emit_warning(&format!("[name-name-parser] warning: {w}"));
    }
    scale
}

/// `倍率:` の値の解釈（副作用なし）。戻りは (倍率, 警告文)。
fn interpret_scale(raw: Option<&str>) -> (Option<f64>, Option<String>) {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return (None, None);
    };
    let t = to_halfwidth(raw);
    let plain = !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '+' | '-'));
    match t.parse::<f64>() {
        Ok(v) if plain && v.is_finite() => (Some(v.clamp(0.25, 1.0)), None),
        _ => (
            None,
            Some(format!(
                "invalid monster scale '{raw}', falling back to 1. Expected a number between 0.25 and 1"
            )),
        ),
    }
}

/// `行動` / `action` の値を書いた順に集める (#835)。値は生文字列のまま透過し、空の行は捨てる。
/// 書式の検証（条件・候補の構文）は runtime が行い、不正な行はそこで無視する。1 行も無ければ None。
fn collect_actions(entries: &[(String, String)]) -> Option<Vec<String>> {
    collect_values(entries, &["行動", "action"])
}

/// 指定したキー（別名を含む）の値を書いた順に集める (#835 / #837)。値は生文字列のまま透過し、空の行は捨てる。1 行も無ければ None。
fn collect_values(entries: &[(String, String)], keys: &[&str]) -> Option<Vec<String>> {
    let out: Vec<String> = entries
        .iter()
        .filter(|(k, v)| keys.contains(&k.as_str()) && !v.trim().is_empty())
        .map(|(_, v)| v.trim().to_string())
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
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
        poses: collect_poses(entries),
        // 空の `隊列:` は未指定（None）にする（emit で `隊列: ` だけの行が出ないように）
        row: lookup_master_string(entries, &["隊列", "row"]).filter(|r| !r.trim().is_empty()),
        level: lookup_master_u32(entries, &["レベル", "level", "Lv"], 1).max(1),
        hp: lookup_master_u32(entries, &["HP", "hp"], 1),
        mp: lookup_master_u32(entries, &["MP", "mp"], 0),
        atk: lookup_master_u32(entries, &["ATK", "atk", "攻撃"], 0),
        def_value: lookup_master_u32(entries, &["DEF", "def", "守備"], 0),
        agi: lookup_master_u32(entries, &["AGI", "agi", "素早さ"], 0),
        // 「習得」キーは複数行 OK で `Lv4 ホイミ` / `4 ホイミ` のような形式を受理する
        learns: collect_party_learns(entries),
        // 「わざ」キーは複数行 OK で、`[特技 id]` の id を書いた順に集める (#873)
        abilities: collect_values(entries, &["わざ", "abilities"]),
    })
}

/// `ポーズ` / `poses` の値（`idle=a.png, step=b.png`）を集めて BTreeMap にする (#745)。
/// カンマ区切りの `キー=パス`。`=` が無い・キーかパスが空の要素は無視する。同じキーは後勝ち。
/// キー名（idle / step 等）の妥当性は検証せず透過する（解釈は runtime 側）。1 件も取れなければ None。
fn collect_poses(
    entries: &[(String, String)],
) -> Option<std::collections::BTreeMap<String, String>> {
    let mut out = std::collections::BTreeMap::new();
    for (k, v) in entries {
        if k != "ポーズ" && k != "poses" {
            continue;
        }
        for part in v.split(',') {
            if let Some((key, path)) = part.split_once('=') {
                let (key, path) = (key.trim(), path.trim());
                if !key.is_empty() && !path.is_empty() {
                    out.insert(key.to_string(), path.to_string());
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
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
                if !sp.is_empty() {
                    out.push(PartyLearns {
                        level: lv,
                        spell: sp,
                    });
                }
                // sp が空（"spell=" だけ書いて値なし）はパターン 1 では破棄。
                // パターン 2 の解釈にもフォールバックさせない（kv 形式で書いた意図を尊重）。
                continue;
            }
        }
        // パターン 2: "Lv4 ホイミ" / "4 ホイミ"
        // 不正行（lv トークン無し / 数値でない / spell 空）は当該行のみスキップ。
        // 関数全体を `?` で早期 return すると、後続の正常な習得行まで巻き込んで捨ててしまう。
        let mut tokens = trimmed.split_whitespace();
        let lv_token = match tokens.next() {
            Some(t) => t,
            None => continue,
        };
        let lv_str = lv_token.strip_prefix("Lv").unwrap_or(lv_token);
        let lv = match lv_str.parse::<u32>() {
            Ok(n) => n,
            Err(_) => continue,
        };
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
    let target =
        lookup_master_string(entries, &["対象", "target"]).unwrap_or_else(|| "敵単体".to_string());
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

/// `[特技 <id>]` (#834)。`名前` 必須。`対象` の既定は `相手単体`（使う側から見た相対表現）。
/// MP は持たない。`効果` / `builtin` / `メッセージ` / `予兆` は生文字列で透過し、runtime が解釈する。
fn build_skill_def(id: String, entries: &[(String, String)]) -> Option<SkillDef> {
    let name = lookup_master_string(entries, &["名前", "name"])?;
    if name.is_empty() {
        return None;
    }
    let target = lookup_master_string(entries, &["対象", "target"])
        .unwrap_or_else(|| "相手単体".to_string());
    Some(SkillDef {
        id,
        name,
        target,
        effect: lookup_master_string(entries, &["効果", "effect"]),
        builtin: lookup_master_string(entries, &["builtin"]),
        message: lookup_master_string(entries, &["メッセージ", "message"]),
        telegraph: lookup_master_string(entries, &["予兆", "telegraph"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_size_returns_warning_and_none() {
        let (sz, w) = interpret_size(Some("big"));
        assert_eq!(sz, None);
        assert!(w.unwrap().contains("invalid monster size 'big'"));
        let (sz, w) = interpret_size(Some("2x1"));
        assert_eq!(sz, Some(MonsterSize { w: 2, h: 1 }));
        assert_eq!(w, None);
        // 未指定・空は警告なし
        assert_eq!(interpret_size(None), (None, None));
        assert_eq!(interpret_size(Some("")), (None, None));
    }

    #[test]
    fn size_rejects_signs_and_overflow() {
        for bad in ["+2x1", "-1x2", "5000000000x1", "0x1", "2x0", "1.5x2", "2"] {
            assert_eq!(interpret_size(Some(bad)).0, None, "{bad}");
            assert!(interpret_size(Some(bad)).1.is_some(), "{bad}");
        }
    }

    #[test]
    fn invalid_scale_returns_warning_and_none() {
        for bad in ["abc", "NaN", "inf", "1e3", "1e-1", "--1", "."] {
            let (sc, w) = interpret_scale(Some(bad));
            assert_eq!(sc, None, "{bad}");
            assert!(w.unwrap().contains("invalid monster scale"), "{bad}");
        }
        assert_eq!(interpret_scale(None), (None, None));
        assert_eq!(interpret_scale(Some("")), (None, None));
    }

    #[test]
    fn scale_accepts_fullwidth_and_clamps() {
        assert_eq!(interpret_scale(Some("０.５")).0, Some(0.5));
        assert_eq!(interpret_scale(Some("０．５")).0, Some(0.5));
        assert_eq!(interpret_scale(Some(".5")).0, Some(0.5));
        assert_eq!(interpret_scale(Some("0.1")).0, Some(0.25));
        assert_eq!(interpret_scale(Some("3")).0, Some(1.0));
        assert_eq!(interpret_scale(Some("-2")).0, Some(0.25));
        assert_eq!(interpret_scale(Some("+0.5")).0, Some(0.5));
    }

    #[test]
    fn first_duplicate_key_wins_even_if_empty() {
        let entries = vec![
            ("サイズ".to_string(), String::new()),
            ("size".to_string(), "2x2".to_string()),
        ];
        assert_eq!(collect_size(&entries), None);
    }

    // ===== 属性相性 (#872) =====

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn affinity_none_when_no_key_or_all_empty() {
        assert_eq!(interpret_affinity(&kv(&[("名前", "x")])), (None, vec![]));
        // 値が空の行は黙って無視（警告なし）
        assert_eq!(
            interpret_affinity(&kv(&[("弱点", ""), ("weak", "  ")])),
            (None, vec![])
        );
    }

    #[test]
    fn affinity_reads_four_columns_with_aliases() {
        let (a, w) = interpret_affinity(&kv(&[
            ("weak", "water"),
            ("halve", "fire"),
            ("immune", "wind"),
            ("absorb", "thunder"),
        ]));
        assert_eq!(w, Vec::<String>::new());
        let a = a.unwrap();
        assert_eq!(a.weak, strs(&["water"]));
        assert_eq!(a.halve, strs(&["fire"]));
        assert_eq!(a.nullify, strs(&["wind"]));
        assert_eq!(a.absorb, strs(&["thunder"]));
        let (a, _) = interpret_affinity(&kv(&[("null", "death"), ("無効", "ink")]));
        assert_eq!(a.unwrap().nullify, strs(&["death", "ink"]));
    }

    #[test]
    fn affinity_separators_case_and_fullwidth() {
        let (a, w) = interpret_affinity(&kv(&[(
            "弱点",
            "Ice, ＷＡＴＥＲ、fire，ｅａｒｔｈ　Thunder_2 ,, ",
        )]));
        assert!(w.is_empty());
        assert_eq!(
            a.unwrap().weak,
            strs(&["ice", "water", "fire", "earth", "thunder_2"])
        );
    }

    #[test]
    fn affinity_normalizes_only_fullwidth_alnum_underscore_hyphen() {
        // 全角数字・英字・`＿`・`－` は半角になり、半角カナ・丸数字は変換しない（JS 側 normalizeAttrId と同じ表）
        let (a, w) = interpret_affinity(&kv(&[("弱点", "ＦＩＲＥ＿０－Ａ ﾎﾉｵ ①")]));
        assert!(w.is_empty());
        assert_eq!(a.unwrap().weak, strs(&["fire_0-a", "ﾎﾉｵ", "①"]));
    }

    #[test]
    fn affinity_multiple_lines_accumulate_and_dedup_silently() {
        let (a, w) = interpret_affinity(&kv(&[
            ("弱点", "ice"),
            ("weak", "water, ICE"),
            ("弱点", "water"),
        ]));
        assert!(w.is_empty());
        assert_eq!(a.unwrap().weak, strs(&["ice", "water"]));
    }

    #[test]
    fn affinity_separator_only_value_warns() {
        let (a, w) = interpret_affinity(&kv(&[("弱点", ","), ("半減", "、 ，")]));
        assert_eq!(a, None);
        assert_eq!(w.len(), 2);
        assert!(w[0].contains("has no attribute id"));
    }

    #[test]
    fn affinity_no_attribute_is_rejected_with_warning() {
        for bad in ["無属性", "none", "NONE", "ＮＯＮＥ"] {
            let (a, w) = interpret_affinity(&kv(&[("無効", &format!("fire, {bad}"))]));
            assert_eq!(a.unwrap().nullify, strs(&["fire"]), "{bad}");
            assert_eq!(w.len(), 1, "{bad}");
            assert!(w[0].contains("cannot be written"), "{bad}");
        }
        // 無属性だけなら相性なし
        let (a, w) = interpret_affinity(&kv(&[("弱点", "none")]));
        assert_eq!(a, None);
        assert_eq!(w.len(), 1);
    }

    /// デシジョンテーブル: 1 つの属性 `x` を 4 欄のうちどの部分集合に書いても、
    /// 優先順位 吸収 > 無効 > 半減 > 弱点 の最も高い欄に 1 回だけ入り、勝てなかった欄の数だけ警告が出る。
    #[test]
    fn affinity_priority_decision_table_all_subsets() {
        let cols = [("吸収", 0usize), ("無効", 1), ("半減", 2), ("弱点", 3)];
        for mask in 1u32..16 {
            let mut pairs = Vec::new();
            for (name, i) in cols {
                if mask & (1 << i) != 0 {
                    pairs.push((name, "x"));
                }
            }
            let (a, w) = interpret_affinity(&kv(&pairs));
            let a = a.unwrap();
            let winner = (0..4).find(|i| mask & (1 << i) != 0).unwrap();
            let got = [&a.absorb, &a.nullify, &a.halve, &a.weak];
            for (i, item) in got.iter().enumerate() {
                let expect = if i == winner { strs(&["x"]) } else { vec![] };
                assert_eq!(**item, expect, "mask={mask:04b} col={i}");
            }
            assert_eq!(
                w.len(),
                (mask.count_ones() - 1) as usize,
                "mask={mask:04b} warnings"
            );
        }
    }

    #[test]
    fn affinity_priority_independent_per_attribute() {
        let (a, w) = interpret_affinity(&kv(&[
            ("弱点", "fire, ice"),
            ("吸収", "fire"),
            ("半減", "ice, wind"),
        ]));
        let a = a.unwrap();
        assert_eq!(a.absorb, strs(&["fire"]));
        assert_eq!(a.halve, strs(&["ice", "wind"]));
        assert_eq!(a.weak, Vec::<String>::new());
        assert_eq!(w.len(), 2);
    }

    #[test]
    fn monster_without_affinity_keys_serializes_without_affinity() {
        let def = build_monster_def("m".into(), &kv(&[("名前", "m"), ("HP", "5")])).unwrap();
        assert_eq!(def.affinity, None);
        let json = serde_json::to_string(&def).unwrap();
        assert!(!json.contains("affinity"), "{json}");
    }

    #[test]
    fn monster_affinity_json_shape_omits_empty_columns() {
        let def = build_monster_def(
            "m".into(),
            &kv(&[("名前", "m"), ("無効", "death, wind"), ("弱点", "thunder")]),
        )
        .unwrap();
        let v: serde_json::Value = serde_json::to_value(&def).unwrap();
        assert_eq!(
            v["affinity"],
            serde_json::json!({"weak": ["thunder"], "nullify": ["death", "wind"]})
        );
    }
}
