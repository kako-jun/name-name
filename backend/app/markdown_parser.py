import re
from typing import List
from .models import Chapter, Scene, Cut


def chapters_to_markdown(chapters: List[Chapter]) -> str:
    """章リストをMarkdownに変換"""
    lines = []

    for chapter in chapters:
        lines.append(f"# 第{chapter.id}章: {chapter.title}\n")

        for scene in chapter.scenes:
            lines.append(f"## シーン{scene.id}: {scene.title}\n")

            for cut in scene.cuts:
                lines.append(f"### カット{cut.id}\n")
                lines.append(f"- **キャラクター**: {cut.character}")
                lines.append(f"- **テキスト**: {cut.text}")
                if cut.expression:
                    lines.append(f"- **表情**: {cut.expression}")
                lines.append("")  # 空行

        lines.append("")  # 章の間に空行

    return "\n".join(lines)


def markdown_to_chapters(markdown: str) -> List[Chapter]:
    """MarkdownをChapterリストに変換"""
    chapters = []
    current_chapter = None
    current_scene = None
    current_cut = None

    lines = markdown.split('\n')

    for line in lines:
        line = line.strip()

        # 章のパース (# 第1章: タイトル)
        chapter_match = re.match(r'^# 第(\d+)章:\s*(.+)$', line)
        if chapter_match:
            # 新しい章に移る前に、現在のカット・シーンを確定
            if current_cut and current_scene:
                current_scene.cuts.append(current_cut)
            if current_scene and current_chapter:
                current_chapter.scenes.append(current_scene)
            if current_chapter:
                chapters.append(current_chapter)

            chapter_id = int(chapter_match.group(1))
            chapter_title = chapter_match.group(2)
            current_chapter = Chapter(id=chapter_id, title=chapter_title, scenes=[])
            current_scene = None
            current_cut = None
            continue

        # シーンのパース (## シーン1: タイトル)
        scene_match = re.match(r'^## シーン(\d+):\s*(.+)$', line)
        if scene_match and current_chapter:
            # 新しいシーンに移る前に、現在のカットを確定
            if current_cut and current_scene:
                current_scene.cuts.append(current_cut)
            if current_scene:
                current_chapter.scenes.append(current_scene)

            scene_id = int(scene_match.group(1))
            scene_title = scene_match.group(2)
            current_scene = Scene(id=scene_id, title=scene_title, cuts=[])
            current_cut = None
            continue

        # カットのパース (### カット1)
        cut_match = re.match(r'^### カット(\d+)$', line)
        if cut_match and current_scene:
            if current_cut:
                current_scene.cuts.append(current_cut)
            cut_id = int(cut_match.group(1))
            current_cut = Cut(id=cut_id, character='', text='', expression='')
            continue

        # カットの属性パース
        if current_cut:
            char_match = re.match(r'^-\s*\*\*キャラクター\*\*:\s*(.+)$', line)
            if char_match:
                current_cut.character = char_match.group(1)
                continue

            text_match = re.match(r'^-\s*\*\*テキスト\*\*:\s*(.+)$', line)
            if text_match:
                current_cut.text = text_match.group(1)
                continue

            expr_match = re.match(r'^-\s*\*\*表情\*\*:\s*(.+)$', line)
            if expr_match:
                current_cut.expression = expr_match.group(1)
                continue

    # 最後の要素を追加
    if current_cut and current_scene:
        current_scene.cuts.append(current_cut)
    if current_scene and current_chapter:
        current_chapter.scenes.append(current_scene)
    if current_chapter:
        chapters.append(current_chapter)

    return chapters
