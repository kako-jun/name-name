"""sit-by-me の人物素材（assets/images/characters/C00x/{poses,walk}/）から、
どの形態にどのポーズ・歩行絵が実在するかの目録 `sit-character-forms.json` を生成する (#1020)。

目録は生成物（手で編集しない）。正本は sit-by-me のファイルと台帳（docs/ledger/素材.yaml・人物形態.yaml）。
sit-by-me の素材が増えたら、このスクリプトを再実行して目録を差し替える。

使い方（frontend/ で）:
    uv run python3 scripts/gen_sit_character_forms.py <sit-by-me のルート> [出力先]
出力先の既定は public/field-sample/sit-character-forms.json
"""

import json
import re
import sys
from pathlib import Path

# エンジンが受理するポーズ（frontend/src/game/battleMotion.ts の BATTLE_POSES と同じ並び。#1026 で special・swing を追加）
POSES = [
    "idle",
    "ready",
    "step",
    "swing-windup",
    "slash",
    "swing-followthrough",
    "cast",
    "special",
    "hurt",
    "down",
    "victory",
]
DIRS = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"]
CHARACTERS = ["C001", "C002", "C003", "C004"]
# plain（-character でない版）に、刀・斬撃の軌跡を絵へ焼き込んだ版が混じり得る人物。目録に plainBaked: true を付け、
# name-name は人物単体版が揃った形態だけ使う（C001。sit-by-me の旧一体版削除 PR #223 の後も、adult/teen/midlife-wheelchair に plain が残る）
PLAIN_BAKED = {"C001"}
# 寺町サンプルで持たせる既定の刀（刀の最終割り当ては KJ 未決。各人物の候補の先頭＝sit-by-me docs の既定）。
# 刀を載せない人物は書かない（目録に weapon が無い人物は刀なし）。
# 刀の画像は assets/images/weapons/{C}/、カタログは同ディレクトリの {C}-blade-candidates.json、layers JSON は人物の battle-layers.json
DEFAULT_WEAPON = {
    "C001": "C001-odenta-mitsuyo-candidate.webp",
    "C002": "C002-muramasa-candidate.webp",
    "C003": "C003-nagasone-kotetsu-candidate.webp",
    "C004": "C004-shichishito-candidate.webp",
}


# 刀カタログ側にだけ候補刀別の変換の上書き（shared_pose_transforms の candidate_overrides）がある人物（C001 の slash。sit-by-me docs/assets-policy.md の C001 の例外）。
# true の人物は、設定側で weapon-overrides にカタログを指す
CATALOG_OVERRIDES = {"C001"}


def weapon_entry(root: Path, cid: str) -> dict | None:
    """刀の項目。layers JSON・刀カタログ・既定の刀の絵が実在するときだけ作る（無ければ None＝刀なし）。"""
    default = DEFAULT_WEAPON.get(cid)
    if not default:
        return None
    wdir = root / "assets/images/weapons" / cid
    images = sorted(f.name for f in wdir.glob(f"{cid}-*-candidate.webp"))
    ok = (
        default in images
        and (root / "assets/images/characters" / cid / "battle-layers.json").is_file()
        and (wdir / f"{cid}-blade-candidates.json").is_file()
    )
    if not ok:
        return None
    return {"default": default, "images": images, **({"catalogOverrides": True} if cid in CATALOG_OVERRIDES else {})}


def main() -> None:
    root = Path(sys.argv[1]).expanduser()
    out = (
        Path(sys.argv[2])
        if len(sys.argv) > 2
        else Path(__file__).resolve().parent.parent / "public/field-sample/sit-character-forms.json"
    )
    characters: dict[str, dict] = {}
    for cid in CHARACTERS:
        base = root / "assets/images/characters" / cid
        forms: dict[str, dict] = {}
        pose_re = re.compile(rf"^{cid}-(?P<form>.+?)(?P<char>-character)?-(?P<pose>swing-windup|swing-followthrough|[a-z]+)\.webp$")
        for f in sorted((base / "poses").glob(f"{cid}-*.webp")):
            m = pose_re.match(f.name)
            if not m or m["pose"] not in POSES:
                continue  # エンジン未受理のポーズ名は含めない
            entry = forms.setdefault(m["form"], {"poses": {}, "walk": False})
            variant = "character" if m["char"] else "plain"
            entry["poses"].setdefault(variant, []).append(m["pose"])
        walk_re = re.compile(rf"^{cid}-(?P<form>.+)-walk-(?P<dir>[a-z]+)-(?P<n>[123])\.webp$")
        walk: dict[str, set] = {}
        for f in (base / "walk").glob(f"{cid}-*-walk-*.webp"):
            m = walk_re.match(f.name)
            if m:
                walk.setdefault(m["form"], set()).add((m["dir"], m["n"]))
        for form, got in walk.items():
            if len(got) == len(DIRS) * 3:
                forms.setdefault(form, {"poses": {}, "walk": False})["walk"] = True
        for entry in forms.values():
            for variant in list(entry["poses"]):
                entry["poses"][variant].sort(key=POSES.index)
        weapon = weapon_entry(root, cid)
        characters[cid] = {
            **({"plainBaked": True} if cid in PLAIN_BAKED else {}),
            **({"weapon": weapon} if weapon else {}),
            "forms": dict(sorted(forms.items())),
        }
    doc = {
        "_generated": "frontend/scripts/gen_sit_character_forms.py が sit-by-me の人物素材から生成。手で編集しない（#1020）",
        "characters": characters,
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    # 文字列だけの配列は 1 行にまとめる（prettier の整形と同じ見た目で、差分が読みやすい）
    text = re.sub(r"\[\s*((?:\"[a-z]+\",?\s*)+)\]", lambda m: "[" + " ".join(m.group(1).split()).rstrip(",") + "]", text)
    out.write_text(text + "\n", encoding="utf-8")
    print(f"wrote {out} ({sum(len(c['forms']) for c in characters.values())} forms)")


if __name__ == "__main__":
    main()
