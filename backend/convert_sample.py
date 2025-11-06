#!/usr/bin/env python3
"""サンプルデータをMarkdownに変換"""

from app.models import Chapter, Scene, Cut
from app.markdown_parser import chapters_to_markdown

# フロントエンドのサンプルデータ
chapters = [
    Chapter(
        id=1,
        title="出会い",
        scenes=[
            Scene(
                id=1,
                title="プロローグ",
                cuts=[
                    Cut(id=1, character="ナレーター", text="物語が始まる...", expression=""),
                    Cut(id=2, character="主人公", text="こんにちは、世界！", expression="笑顔"),
                ],
            ),
            Scene(
                id=2,
                title="初対面",
                cuts=[
                    Cut(id=3, character="ヒロイン", text="よろしくね！", expression="照れ"),
                    Cut(id=4, character="主人公", text="こちらこそ！", expression="笑顔"),
                ],
            ),
        ],
    ),
    Chapter(
        id=2,
        title="事件発生",
        scenes=[
            Scene(
                id=3,
                title="不穏な空気",
                cuts=[
                    Cut(id=5, character="ナレーター", text="その日の夜、事件が起きた。", expression=""),
                    Cut(id=6, character="主人公", text="これは...！", expression="驚き"),
                ],
            ),
        ],
    ),
    Chapter(
        id=3,
        title="調査開始",
        scenes=[
            Scene(
                id=4,
                title="手がかり",
                cuts=[
                    Cut(id=7, character="主人公", text="この手がかりは...", expression="真剣"),
                    Cut(id=8, character="ヒロイン", text="何か見つけた？", expression="心配"),
                ],
            ),
            Scene(
                id=5,
                title="証拠の分析",
                cuts=[
                    Cut(id=9, character="主人公", text="これは重要な証拠だ", expression="真剣"),
                    Cut(id=10, character="ナレーター", text="事件の真相が見えてきた", expression=""),
                ],
            ),
        ],
    ),
    Chapter(
        id=4,
        title="真実への接近",
        scenes=[
            Scene(
                id=6,
                title="容疑者との対峙",
                cuts=[
                    Cut(id=11, character="主人公", text="あなたが犯人なのか？", expression="疑い"),
                    Cut(id=12, character="容疑者", text="私は何も知らない...", expression="動揺"),
                ],
            ),
            Scene(
                id=7,
                title="新たな謎",
                cuts=[
                    Cut(id=13, character="ヒロイン", text="この状況、おかしくない？", expression="疑問"),
                    Cut(id=14, character="主人公", text="確かに...何かが引っかかる", expression="考え込む"),
                ],
            ),
        ],
    ),
    Chapter(
        id=5,
        title="真犯人",
        scenes=[
            Scene(
                id=8,
                title="真相の解明",
                cuts=[
                    Cut(id=15, character="主人公", text="すべての謎が解けた！", expression="確信"),
                    Cut(id=16, character="ナレーター", text="驚愕の真実が明かされる", expression=""),
                ],
            ),
            Scene(
                id=9,
                title="対決",
                cuts=[
                    Cut(id=17, character="真犯人", text="よくぞここまで...", expression="冷笑"),
                    Cut(id=18, character="主人公", text="観念しろ！", expression="怒り"),
                    Cut(id=19, character="ヒロイン", text="そんな...まさか！", expression="驚愕"),
                ],
            ),
        ],
    ),
    Chapter(
        id=6,
        title="エピローグ",
        scenes=[
            Scene(
                id=10,
                title="事件の終結",
                cuts=[
                    Cut(id=20, character="ナレーター", text="長い事件がついに終わった", expression=""),
                    Cut(id=21, character="主人公", text="やっと終わった...", expression="安堵"),
                ],
            ),
            Scene(
                id=11,
                title="新たな日常",
                cuts=[
                    Cut(id=22, character="ヒロイン", text="これからどうする？", expression="笑顔"),
                    Cut(id=23, character="主人公", text="また新しい物語が始まる", expression="希望"),
                    Cut(id=24, character="ナレーター", text="二人の冒険は続く...", expression=""),
                ],
            ),
        ],
    ),
]

# Markdownに変換
markdown = chapters_to_markdown(chapters)
print(markdown)
