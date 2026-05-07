# ADR 0001: ホスティングアーキテクチャ

- 起票日: 2026-05-08
- ステータス: Accepted
- 関連 Issue: #105

## Context（背景）

name-name は当初、以下の構成でローカル開発と本番運用を行う計画だった:

- **ローカル開発**: Docker Compose で FastAPI バックエンド (`http://localhost:7373`) と Vite フロント (`http://localhost:5173`) を立ち上げる
- **永続化**: バックエンドが GitPython で `backend/projects/<game>/.git/` を直接操作。各ゲームリポはローカルディスクにクローンされる
- **本番**: GCP に name-name 一式（FastAPI + Vite + 各ゲームリポ）をデプロイし、main ブランチを参照

しかしこの構成には次の問題があった:

1. **公開 URL がない**。kako-jun の手元 PC でしか動かない
2. **「ブラウザでログインさえすれば編集でき、即本番反映」という運用に構造的に合わない**。push → 別環境が pull → ビルド/再起動 という多段が必要
3. **マルチデバイスでの編集**ができない（ローカル PC 依存）
4. **CF Pages（他 kako-jun アプリの標準デプロイ先）に乗らない**。Workers は揮発的で、永続ファイルシステム + git バイナリ + Python ランタイムを要求するこの構成は CF に載らない
5. **データモデルの歪み**。GitPython で git 作業ツリーを DB の代用にしている

## Decision（決定）

ホスティング戦略を以下に転換する。

### コア構造

- **name-name は「ハード」**。各ゲームリポ（ogurasia, skirts-colour, friday-1930 等）は **「ソフト」（カートリッジ）**
- エディタとプレイヤーは**同じ React アプリ**。認証で機能が分岐するだけ
  - 未ログイン: プレイヤーのみ（`/play/<game>`）
  - kako-jun ログイン済み: 同じプレイヤー画面に編集 UI とデバッグオーバーレイが追加マウントされる（`/edit/<game>`）

### 構成（CF Pages + Worker + GitHub API）

```
ブラウザ (CF Pages, 静的フロント React+PixiJS+WASM)
    ↓ fetch
name-name-api.workers.dev (CF Worker, octokit)
    ↓ GitHub REST API (Contents API + Git Data API)
github.com/kako-jun/<game>
```

- **永続化**: GitHub の各ゲームリポをそのままソース・オブ・トゥルースとする。D1 / R2 は使わない
- **アセット**: 一般的サイズ（〜5MB）は Contents API、大きいもの（5〜100MB）は Git Data API、>100MB は Git LFS
- **履歴**: git log がそのまま履歴になる
- **認証**: CF Access or GitHub OAuth で kako-jun のみ通過。GitHub PAT は Worker Secret に格納（`wrangler secret put GITHUB_TOKEN`）。**ブラウザに一切渡さない**
- **キャッシュ**: 読み取り側（`/play/*`）は CF Cache API で短時間キャッシュ（30秒〜数分）し、保存時にパージ
- **楽観ロック**: Contents API は `sha` 必須。別デバイスで先に編集された場合は 409 を返し、エディタ側で「最新を取り直す」を促す

### URL 構造

```
name-name.llll-ll.com/                 ← ジャンプ風タイトル画面（ゲーム選択）
name-name.llll-ll.com/play/<game>      ← プレイヤー（一般ユーザー、ログイン不要）
name-name.llll-ll.com/edit/<game>      ← プレイヤー＋編集UI＋デバッグ（ログイン必須）
name-name-api.workers.dev/api/...      ← Worker
```

### ブランチ戦略

- **`develop`**: 編集用。kako-jun が `/edit/<game>` から触る。一般ユーザーから見えない
- **`main`**: 公開用。`/play/<game>` から見える。`develop` → `main` PR を kako-jun が GitHub UI でマージしたものだけが公開される
- マージ → Worker キャッシュパージ → 次のリクエストで反映＝**即公開**

### 公開ポリシー

- 各ゲームリポ（ogurasia, skirts-colour, friday-1930 等）は **public のまま**（完成までは隠さない方針）
- 編集者は **kako-jun のみ**（永続的な仕様）

## Consequences（結果と影響）

### 利点

- **永続化を git から DB に移す大改修が不要**。GitHub をそのまま使う
- **D1 / R2 不要**。CF Worker 1個で済む
- **保存→即反映が真に成立する**。ビルドや push の多段がない
- **マルチデバイスで編集できる**。ブラウザでログインするだけ
- **他 kako-jun アプリ（orber, 3min, ear-sky 等）と同じ CF Pages デプロイフローに統一**
- **履歴は git log がそのまま**。バックアップ・diff・rollback が自然
- **公開 URL `name-name.llll-ll.com` を持てる**

### 廃止される旧計画

- `backend/` (FastAPI + GitPython + projects/) → 移行完了次第削除
- `compose.yaml` → 削除
- `backend/BRANCHES.md` の「GCP 本番環境が main を自動デプロイ」記述 → 既に新方針へ書き換え済（旧計画は墓標として「廃止された旧計画」セクションに保存）
- `POST /api/projects/{name}/switch-branch` 等の FastAPI エンドポイント → 廃止

### トレードオフ

- **GitHub Rate Limit に依存する**（認証付き 5000 req/h）。kako-jun 1人運用ならまず当たらないが、`/play/*` を一般公開するなら Cache API で必ず吸収する
- **大きいアセットの扱いが2系統に分かれる**（Contents API と Git Data API）。Octokit が helper を提供しているので運用上の負担は小さい
- **Public リポ前提が崩れたら別方式が要る**。将来 private にしたい場合は Worker 経由で配信に切り替える（GitHub raw URL は使えなくなる）

### 移行作業（Issue 化済）

- #105: ADR 転記（本ドキュメント）
- #106: CF Worker バックエンド新設
- #107: フロントの API 層を Worker URL に差し替え
- #108: EditorScreen / PlayerScreen を権限分岐で1画面に統合
- #109: ジャンプ風トップページ
- #110: CF Access or GitHub OAuth で認証
- #111: CF Pages デプロイ設定
- #112: 旧 backend 削除

依存関係:

```
#105 → #106 → (#107, #110) → #108 → (#109, #111) → #112
```

## 参考

- 永続的な戦略メモ: `repos/private/notes/.agasteer/notes/dev/name-name.md` の「ホスティング戦略（2026-05-08 確定）」セクション
- Agasteer 方式（参考実装）: `repos/2025/agasteer/src/lib/api/sync.ts`
