# アセット管理システム

## 概要

Name×Nameは、ビジュアルノベルのアセット（画像、音声、動画）をGitリポジトリで管理します。
各プロジェクトは独立したGitリポジトリを持ち、章データとアセットが一緒に管理されます。

## ディレクトリ構造

```
projects/{project_name}/
├── chapters/
│   └── all.md              # 章データ（Markdown）
└── assets/
    ├── images/             # 画像ファイル
    │   ├── character_a.png
    │   └── background_1.jpg
    ├── sounds/             # 音声ファイル
    │   ├── bgm_001.mp3
    │   └── se_click.wav
    ├── movies/             # 動画ファイル
    │   └── opening.mp4
    └── ideas/              # アイデアファイル
        └── character_concept.md
```

## API エンドポイント

### アセット一覧取得
```
GET /api/projects/{project_name}/assets/{asset_type}
```
- `asset_type`: `images`, `sounds`, `movies`, `ideas`
- レスポンス: アセットの名前、サイズ、URLのリスト

### アセットアップロード
```
POST /api/projects/{project_name}/assets/{asset_type}
Content-Type: multipart/form-data

file: (ファイル)
commit_message: (オプション)
```
- ファイルをアップロードし、自動的にGitコミット・プッシュ
- レスポンス: ファイル名、URL、コミットハッシュ

### アセット取得
```
GET /api/projects/{project_name}/assets/{asset_type}/{filename}
```
- ファイルをダウンロード（配信）
- エディタでのプレビューやPixiJS実行時のロードに使用

### アセット削除
```
DELETE /api/projects/{project_name}/assets/{asset_type}/{filename}
```
- ファイルを削除し、自動的にGitコミット・プッシュ

## PixiJSとの統合

### エディタモード
エディタでアセットを使用する場合：

```typescript
// 画像を表示
const imageUrl = `/api/projects/${projectName}/assets/images/character_a.png`;
<img src={imageUrl} alt="character" />
```

### プレイモード（PixiJS）
PixiJSのノベルプレイヤーでアセットをロードする場合：

```typescript
import { Sprite, Texture } from 'pixi.js';

// バックエンドAPIからアセットをロード
const baseUrl = 'http://localhost:7373/api/projects';
const projectName = 'my-game';

// 背景画像をロード
const bgTexture = await Texture.from(
  `${baseUrl}/${projectName}/assets/images/background_1.jpg`
);
const bgSprite = new Sprite(bgTexture);

// 立ち絵をロード
const charTexture = await Texture.from(
  `${baseUrl}/${projectName}/assets/images/character_a.png`
);
const charSprite = new Sprite(charTexture);
```

### アセットマニフェスト（推奨）
章データ（Markdown v0.1）にアセット情報を記述する方式を採用：

```markdown
## 1-1: 教室の朝

[背景: radius/BG_COMMON_GRAD_3.png]
[BGM: amehure.ogg]

**主人公** (suppin_1, 左):
今日も平和な一日が始まる。
```

このアプローチにより、章データとアセットの関係が明確になり、
ノベルプレイヤーで必要なアセットだけを効率的にロードできます。

## Git管理のメリット

1. **バージョン管理**: アセットの変更履歴を追跡
2. **チーム開発**: 複数人で同時に作業可能
3. **ロールバック**: 以前のバージョンに簡単に戻せる
4. **バックアップ**: GitHubなどのリモートリポジトリで自動バックアップ
5. **Claude Codeとの連携**: VSCodeで直接編集・AI支援を受けられる

## 注意事項

- 大きなファイル（動画など）はGit LFSの使用を推奨
- アセットファイル名には英数字とアンダースコアを使用（日本語は避ける）
- 著作権に注意（使用許可のあるアセットのみをアップロード）
