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

# エンジンが受理するポーズ（frontend/src/game/battleMotion.ts の BATTLE_POSES と同じ並び）
POSES = ["idle", "ready", "step", "slash", "cast", "hurt", "down", "victory"]
DIRS = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"]
CHARACTERS = ["C001", "C002", "C003", "C004"]


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
        pose_re = re.compile(rf"^{cid}-(?P<form>.+?)(?P<char>-character)?-(?P<pose>[a-z]+)\.webp$")
        for f in sorted((base / "poses").glob(f"{cid}-*.webp")):
            m = pose_re.match(f.name)
            if not m or m["pose"] not in POSES:
                continue  # special / swing-* などエンジン未受理のポーズは含めない
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
        characters[cid] = {"forms": dict(sorted(forms.items()))}
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
