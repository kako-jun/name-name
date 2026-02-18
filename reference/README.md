# reference/

宇宙色（skirts-colour）の旧エンジン・ツール群から抽出した参考資料。
name-name 開発時の設計リファレンスとして保持。

## h-colour-meta/

Markdown → TyranoScript シナリオ変換パイプライン（2019年）。

- `converter/converter.js` — JS版コンバーター（最新）。Markdown記法（`> 背景絵を 1_4 に`）→ `.ks`
- `converter/convert.py` — Python 2版（旧）。`■` 記法
- `S1-1-1_meta.md` — シナリオメタデータの実データサンプル
- `header.ks` / `footer.ks` — TyranoScript テンプレート

**参照ポイント**: シナリオに必要な要素（背景切替、立ち絵、BGM/SE、選択肢、モノローグ、シーン遷移）の一覧

## kvns3/

ビジュアルノベルエンジン v3（2021年、Phaser 3 + Vue 3 + enable3d）。

- `src/models/TimelinePlayer.ts` — イベント駆動のシナリオ再生エンジン
- `src/game_objects/DialogBox.ts` — ダイアログボックス（日本語折り返し対応）
- `src/scenes/MainScene.ts` — 3D カメラワーク、enable3d での立ち絵 Z軸配置
- `src/data/timeline.ts` — シナリオデータ構造（Timeline/Choice型）
- `src/types/` — TypeScript 型定義

**参照ポイント**: 3D立ち絵のじわり移動、カメラ軌道アニメーション、Phaser + Three.js 統合パターン

## filmente-wear-skirts/

`■` 記法 → TyranoScript シナリオ変換（filmente内モジュール）。

- `wear_skirts.js` — 変換ロジック本体
- `S1-1-1_meta.txt` — `■` 記法のサンプル入力
- `S1-1-1.ks` / `_S1-1-1.ks` — 変換後の `.ks` 出力例
- `header.txt` / `footer.txt` — テンプレート

**参照ポイント**: h-colour-meta との記法比較、変換マッピングの網羅性確認
