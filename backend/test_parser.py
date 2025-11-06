#!/usr/bin/env python3
"""Markdownパーサーのテスト"""

from app.markdown_parser import markdown_to_chapters

# 実際のMarkdownファイルを読み込んでテスト
with open("projects/ogurasia/chapters/all.md", "r", encoding="utf-8") as f:
    markdown = f.read()

chapters = markdown_to_chapters(markdown)

print(f"パースされた章数: {len(chapters)}")
for chapter in chapters:
    print(f"\n第{chapter.id}章: {chapter.title}")
    print(f"  シーン数: {len(chapter.scenes)}")
    for scene in chapter.scenes:
        print(f"    シーン{scene.id}: {scene.title}")
        print(f"      カット数: {len(scene.cuts)}")
        for cut in scene.cuts:
            print(f"        カット{cut.id}: {cut.character} - {cut.text[:20]}...")
