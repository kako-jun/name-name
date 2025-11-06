# ブランチ戦略

Name×Nameは、Gitブランチを使って開発環境と本番環境を分離します。

## ブランチの役割

### `develop` ブランチ（デフォルト）
- **用途**: 原稿の編集・テスト
- **環境**: ローカル開発環境（localhost）
- **特徴**:
  - 自由に編集・保存できる
  - 本番環境には影響しない
  - 新しい章やシーンを試作できる

### `main` ブランチ
- **用途**: 本番公開用の確定した原稿
- **環境**: GCP本番環境
- **特徴**:
  - ユーザーに見せる完成版
  - `develop`から十分テストした内容をマージ
  - 慎重に管理

## ワークフロー

### 1. 通常の開発作業

```
開発者 → localhost (develop) → GitHub (develop)
```

1. ローカルで`develop`ブランチを使用（デフォルト）
2. 原稿を編集・保存
3. 自動的に`develop`ブランチにcommit & push

### 2. 本番環境への反映

```
GitHub (develop) → Pull Request → GitHub (main) → GCP (main)
```

1. GitHubで`develop`→`main`のPull Requestを作成
2. 内容を確認してマージ
3. 本番環境（GCP）が`main`ブランチから自動デプロイ

### 3. 本番内容の確認（オプション）

開発環境で本番ブランチを確認したい場合：

```bash
POST /api/projects/{project_name}/switch-branch
{
  "branch": "main"
}
```

確認後、開発ブランチに戻す：

```bash
POST /api/projects/{project_name}/switch-branch
{
  "branch": "develop"
}
```

## API エンドポイント

### プロジェクト作成時にブランチ指定

```bash
# 新規プロジェクト
POST /api/projects/init
{
  "name": "my-game",
  "branch": "develop"  # 省略可（デフォルトはdevelop）
}

# 既存リポジトリをクローン
POST /api/projects/clone
{
  "name": "my-game",
  "repo_url": "https://github.com/user/my-game.git",
  "branch": "develop"  # 省略可（デフォルトはdevelop）
}
```

### ブランチ切り替え

```bash
POST /api/projects/{project_name}/switch-branch
{
  "branch": "main"
}
```

### プロジェクト一覧（ブランチ情報含む）

```bash
GET /api/projects

# レスポンス
{
  "projects": [
    {
      "name": "my-game",
      "path": "/path/to/projects/my-game",
      "branch": "develop"
    }
  ]
}
```

## 設定ファイル

各プロジェクトのルートに`.name-name.json`が作成されます：

```json
{
  "branch": "develop"
}
```

このファイルは**ローカル設定**なので、Gitで管理されません。
各環境（開発・本番）で異なるブランチを使用できます。

## 環境別の設定例

### ローカル開発環境
```json
{
  "branch": "develop"
}
```
- 編集中の原稿で作業
- 本番に影響なし

### GCP本番環境
```json
{
  "branch": "main"
}
```
- 確定した原稿をユーザーに配信
- `main`ブランチのみを参照

## ベストプラクティス

1. **日常的な編集は`develop`で**
   - 新しい章やシーンは必ず`develop`で作成
   - 誤字修正も`develop`で行う

2. **こまめにコミット**
   - 保存のたびに自動コミット
   - 変更履歴が残るので安心

3. **本番反映は慎重に**
   - `develop`で十分テストしてから`main`にマージ
   - Pull Requestでレビューを行う

4. **緊急修正の場合**
   - 本番で誤字を発見 → `main`ブランチで直接修正も可能
   - 修正後、`main`→`develop`にもマージして同期

## トラブルシューティング

### 間違えて本番ブランチで編集してしまった

```bash
# 1. developに切り替え
POST /api/projects/{project_name}/switch-branch
{"branch": "develop"}

# 2. mainブランチの変更をdevelopにマージ（GitHubで）
# または、変更を取り消す
```

### ブランチの状態がおかしい

```bash
# プロジェクトを同期
POST /api/projects/{project_name}/sync
```

### 設定ファイルを手動で確認

```bash
cat projects/my-game/.name-name.json
```

## まとめ

- **`develop`**: 編集用（デフォルト）
- **`main`**: 本番公開用
- 開発環境と本番環境は完全に分離
- ブランチ切り替えで柔軟に対応可能
