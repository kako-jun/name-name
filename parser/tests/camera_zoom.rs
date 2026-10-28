//! #702 カメラ「ズーム」軸（`[カメラ: シアター, ズーム: キャラ名, 強さ: 1.5]`）のパーサ・エミッタ境界テスト。
//! 現挙動を固定するもの（全角・カンマ・重複など）は「仕様の固定」であり、変える場合は意図して直すこと。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

type Cam = (
    CameraMode,
    Option<CameraOrientation>,
    Option<CameraElevation>,
    Option<String>,
    Option<f32>,
);

fn cams_of(doc: &Document) -> Vec<Cam> {
    doc.chapters[0].scenes[0]
        .events
        .iter()
        .filter_map(|e| match e {
            Event::CameraMode {
                mode,
                orientation,
                elevation,
                zoom,
                zoom_strength,
            } => Some((
                *mode,
                *orientation,
                *elevation,
                zoom.clone(),
                *zoom_strength,
            )),
            _ => None,
        })
        .collect()
}

fn cams(body: &str) -> Vec<Cam> {
    cams_of(&parse(&format!("{HEAD}{body}\n")))
}

fn cam(body: &str) -> Cam {
    let v = cams(body);
    assert_eq!(v.len(), 1, "camera event count for {body:?}");
    v.into_iter().next().unwrap()
}

fn zs(body: &str) -> (Option<String>, Option<f32>) {
    let c = cam(body);
    (c.3, c.4)
}

fn s(x: &str) -> Option<String> {
    Some(x.to_string())
}

/// 単一の CameraMode イベントを差し替えて emit した本文（先頭の `[カメラ:` 行）を返す。
fn emit_cam(mode: CameraMode, zoom: Option<&str>, strength: Option<f32>) -> String {
    let mut doc = parse(&format!("{HEAD}[カメラ: ノベル]\n"));
    doc.chapters[0].scenes[0].events[0] = Event::CameraMode {
        mode,
        orientation: None,
        elevation: None,
        zoom: zoom.map(|z| z.to_string()),
        zoom_strength: strength,
    };
    let out = emit(&doc);
    out.lines()
        .find(|l| l.starts_with("[カメラ:"))
        .unwrap_or("")
        .to_string()
}

fn emit_theater(zoom: Option<&str>, strength: Option<f32>) -> String {
    emit_cam(CameraMode::Theater, zoom, strength)
}

// ---- parser ----

#[test]
fn t01_strength_first_order_keeps_both() {
    assert_eq!(
        zs("[カメラ: シアター, 強さ: 2, ズーム: ミナ]"),
        (s("ミナ"), Some(2.0))
    );
}

#[test]
fn t02_axes_in_any_order_same_result() {
    let a = cam("[カメラ: シアター, 向き: 舞台, 仰角: 見上げ, ズーム: ミナ]");
    let b = cam("[カメラ: シアター, ズーム: ミナ, 仰角: 見上げ, 向き: 舞台]");
    let c = cam("[カメラ: シアター, 仰角: 見上げ, ズーム: ミナ, 向き: 舞台]");
    assert_eq!(a, b);
    assert_eq!(a, c);
    assert_eq!(a.1, Some(CameraOrientation::Stage));
    assert_eq!(a.2, Some(CameraElevation::LookUp));
    assert_eq!(a.3, s("ミナ"));
}

#[test]
fn t03_all_axes_and_roundtrip() {
    let src = "[カメラ: シアター, 向き: 舞台, 仰角: 見下ろし, ズーム: ミナ, 強さ: 2.5]";
    let c = cam(src);
    assert_eq!(c.0, CameraMode::Theater);
    assert_eq!(c.1, Some(CameraOrientation::Stage));
    assert_eq!(c.2, Some(CameraElevation::LookDown));
    assert_eq!(c.3, s("ミナ"));
    assert_eq!(c.4, Some(2.5));
    let doc1 = parse(&format!("{HEAD}{src}\n"));
    let doc2 = parse(&emit(&doc1));
    assert_eq!(doc1, doc2);
}

#[test]
fn t04_strength_boundaries() {
    assert_eq!(zs("[カメラ: シアター, ズーム: ミナ, 強さ: 0]").1, None);
    assert_eq!(zs("[カメラ: シアター, ズーム: ミナ, 強さ: -1]").1, None);
    assert_eq!(
        zs("[カメラ: シアター, ズーム: ミナ, 強さ: 0.0001]").1,
        Some(0.0001)
    );
    assert_eq!(zs("[カメラ: シアター, ズーム: ミナ, 強さ: -0]").1, None);
}

#[test]
fn t05_strength_non_finite_is_none() {
    for v in ["NaN", "nan", "inf", "-inf", "Infinity", "1e999", "1e39"] {
        assert_eq!(
            zs(&format!("[カメラ: シアター, ズーム: ミナ, 強さ: {v}]")),
            (s("ミナ"), None),
            "強さ: {v}"
        );
    }
}

#[test]
fn t06_strength_ascii_comma_splits_directive() {
    // `強さ: 1,5` はカンマで分割され、`強さ: 1` と未知パート `5` になる（現挙動固定）。
    assert_eq!(
        zs("[カメラ: シアター, ズーム: ミナ, 強さ: 1,5]"),
        (s("ミナ"), Some(1.0))
    );
}

#[test]
fn t07_fullwidth_space_after_colon_is_trimmed() {
    // `str::trim` は全角空白も除去する（現挙動固定）。
    assert_eq!(zs("[カメラ: シアター, ズーム:　ミナ]").0, s("ミナ"));
}

#[test]
fn t08_fullwidth_colon_is_ignored() {
    assert_eq!(zs("[カメラ: シアター, ズーム：ミナ]"), (None, None));
}

#[test]
fn t09_fullwidth_digit_strength_is_none() {
    assert_eq!(
        zs("[カメラ: シアター, ズーム: ミナ, 強さ: ２]"),
        (s("ミナ"), None)
    );
}

#[test]
fn t10_no_space_and_surrounding_spaces() {
    assert_eq!(zs("[カメラ: シアター, ズーム:ミナ]").0, s("ミナ"));
    assert_eq!(
        zs("[カメラ: シアター,   ズーム:   ミナ   ,強さ:2]"),
        (s("ミナ"), Some(2.0))
    );
}

#[test]
fn t11_blank_zoom_is_none() {
    assert_eq!(zs("[カメラ: シアター, ズーム:   ]").0, None);
}

#[test]
fn t12_strength_only_is_dropped() {
    assert_eq!(zs("[カメラ: シアター, 強さ: 2]"), (None, None));
}

#[test]
fn t13_duplicate_zoom_last_wins_and_zenkei_resets() {
    assert_eq!(zs("[カメラ: シアター, ズーム: A, ズーム: B]").0, s("B"));
    // 現挙動: 後勝ち。`全景` は無視（zoom を None に戻さない）ので A が残る。
    // 仕様としては「後の指定が全景なら全景」と読むのが自然で、不具合寄りの挙動（要判断）。
    assert_eq!(zs("[カメラ: シアター, ズーム: A, ズーム: 全景]").0, s("A"));
    assert_eq!(zs("[カメラ: シアター, ズーム: A, ズーム:]").0, s("A"));
}

#[test]
fn t13b_duplicate_strength_last_valid_wins() {
    assert_eq!(
        zs("[カメラ: シアター, ズーム: A, 強さ: 2, 強さ: 3]").1,
        Some(3.0)
    );
    // 後ろが不正値なら前の有効値が残る（現挙動）。
    assert_eq!(
        zs("[カメラ: シアター, ズーム: A, 強さ: 2, 強さ: 0]").1,
        Some(2.0)
    );
}

#[test]
fn t14_novel_mode_ignores_zoom_and_strength() {
    assert_eq!(zs("[カメラ: ノベル, ズーム: ミナ, 強さ: 2]"), (None, None));
}

#[test]
fn t15_malformed_numbers_are_none() {
    for v in ["1.5abc", "1.5.2", "", "abc", "--1", "1e", "+"] {
        assert_eq!(
            zs(&format!("[カメラ: シアター, ズーム: ミナ, 強さ: {v}]")),
            (s("ミナ"), None),
            "強さ: {v:?}"
        );
    }
}

#[test]
fn t16_f32_precision_roundtrip_equal() {
    let doc1 = parse(&format!(
        "{HEAD}[カメラ: シアター, ズーム: ミナ, 強さ: 1.1]\n[カメラ: シアター, ズーム: ミナ, 強さ: 0.1]\n[カメラ: シアター, ズーム: ミナ, 強さ: 3.3333333]\n"
    ));
    let doc2 = parse(&emit(&doc1));
    assert_eq!(doc1, doc2);
    assert_eq!(cams_of(&doc2)[0].4, Some(1.1f32));
}

// ---- emitter ----

#[test]
fn t17_theater_zoom_none_strength_some_emits_nothing_extra() {
    assert_eq!(emit_theater(None, Some(2.0)), "[カメラ: シアター]");
}

#[test]
fn t18_novel_with_zoom_emits_nothing_extra() {
    assert_eq!(
        emit_cam(CameraMode::Novel, Some("ミナ"), Some(2.0)),
        "[カメラ: ノベル]"
    );
}

#[test]
fn t19_unemittable_zoom_names_emit_nothing() {
    for z in ["", "  ", " ミナ", "ミナ ", "全景", "A,B", "ミナ,"] {
        assert_eq!(
            emit_theater(Some(z), Some(2.0)),
            "[カメラ: シアター]",
            "zoom {z:?}"
        );
    }
}

#[test]
fn t20_invalid_strength_not_emitted() {
    for v in [0.0f32, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(
            emit_theater(Some("ミナ"), Some(v)),
            "[カメラ: シアター, ズーム: ミナ]",
            "strength {v}"
        );
    }
}

#[test]
fn t21_strength_format() {
    assert_eq!(
        emit_theater(Some("ミナ"), Some(1.5)),
        "[カメラ: シアター, ズーム: ミナ, 強さ: 1.5]"
    );
    assert_eq!(
        emit_theater(Some("ミナ"), Some(2.0)),
        "[カメラ: シアター, ズーム: ミナ, 強さ: 2]"
    );
    assert_eq!(
        emit_theater(Some("ミナ"), None),
        "[カメラ: シアター, ズーム: ミナ]"
    );
}

#[test]
fn t22_special_chars_in_name_reparse_behavior() {
    // `:` を含む名前: 先頭の `ズーム:` だけ剥がすので名前に `:` が残る → 再パースで同一。
    let doc1 = parse(&format!("{HEAD}[カメラ: シアター, ズーム: A:B, 強さ: 2]\n"));
    assert_eq!(cams_of(&doc1)[0].3, s("A:B"));
    assert_eq!(doc1, parse(&emit(&doc1)));

    // `]` を含む名前: 現挙動を観測して固定（ディレクティブ検出が壊れる場合は emit が再パースで等価にならない）。
    let mut doc = parse(&format!("{HEAD}[カメラ: ノベル]\n"));
    doc.chapters[0].scenes[0].events[0] = Event::CameraMode {
        mode: CameraMode::Theater,
        orientation: None,
        elevation: None,
        zoom: s("A]B"),
        zoom_strength: None,
    };
    let text = emit(&doc);
    let line = text.lines().find(|l| l.starts_with("[カメラ:")).unwrap();
    assert_eq!(line, "[カメラ: シアター, ズーム: A]B]");
    let re = cams_of(&parse(&text));
    // 行末の `]` だけがディレクティブ終端として扱われ、名前内の `]` は保たれる（現挙動固定）。
    assert_eq!(re.len(), 1);
    assert_eq!(re[0].3, s("A]B"));
}

// ---- serde ----

#[test]
fn t23_serde_skips_none_and_reads_legacy_json() {
    let ev = Event::CameraMode {
        mode: CameraMode::Theater,
        orientation: None,
        elevation: None,
        zoom: None,
        zoom_strength: None,
    };
    let j = serde_json::to_string(&ev).unwrap();
    assert!(!j.contains("zoom"), "None のときキー無し: {j}");

    let ev2 = Event::CameraMode {
        mode: CameraMode::Theater,
        orientation: None,
        elevation: None,
        zoom: s("ミナ"),
        zoom_strength: Some(1.5),
    };
    let j2 = serde_json::to_string(&ev2).unwrap();
    assert!(j2.contains("\"zoom\":\"ミナ\"") && j2.contains("zoom_strength"));
    assert_eq!(serde_json::from_str::<Event>(&j2).unwrap(), ev2);

    let legacy = r#"{"CameraMode":{"mode":"Theater"}}"#;
    assert_eq!(serde_json::from_str::<Event>(legacy).unwrap(), ev);
}
