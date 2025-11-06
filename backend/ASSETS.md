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
- エディタでのプレビューやPhaser実行時のロードに使用

### アセット削除
```
DELETE /api/projects/{project_name}/assets/{asset_type}/{filename}
```
- ファイルを削除し、自動的にGitコミット・プッシュ

## Phaserとの統合

### エディタモード
エディタでアセットを使用する場合：

```typescript
// 画像を表示
const imageUrl = `/api/projects/${projectName}/assets/images/character_a.png`;
<img src={imageUrl} alt="character" />
```

### プレイモード（Phaser）
Phaserのゲーム実行時にアセットをロードする場合：

```typescript
class GameScene extends Phaser.Scene {
  preload() {
    // バックエンドAPIからアセットをロード
    const baseUrl = 'http://localhost:8000/api/projects';
    const projectName = 'my-game';

    // 画像をロード
    this.load.image(
      'character_a',
      `${baseUrl}/${projectName}/assets/images/character_a.png`
    );

    // 音声をロード
    this.load.audio(
      'bgm_001',
      `${baseUrl}/${projectName}/assets/sounds/bgm_001.mp3`
    );

    // 動画をロード
    this.load.video(
      'opening',
      `${baseUrl}/${projectName}/assets/movies/opening.mp4`
    );
  }

  create() {
    // ロードしたアセットを使用
    this.add.image(400, 300, 'character_a');
    this.sound.play('bgm_001');
  }
}
```

### アセットマニフェスト（推奨）
章データ（Markdown）にアセット情報を記述する方式も検討可能：

```markdown
# 第1章: 出会い

## シーン1: 教室
- **背景**: background_classroom.jpg
- **BGM**: bgm_daily.mp3

### カット1
- **キャラクター**: 主人公
- **立ち絵**: character_protagonist_normal.png
- **テキスト**: 今日も平和な一日が始まる。
- **表情**: normal
```

このアプローチにより、章データとアセットの関係が明確になり、
Phaserのpreloadメソッドで必要なアセットだけを効率的にロードできます。

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
