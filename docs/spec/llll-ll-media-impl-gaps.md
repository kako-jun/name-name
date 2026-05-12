# llll-ll-media が要求する name-name 機能差分

`~/repos/private/llll-ll-media/script.md` の英語サンプル動画を実行するために、name-name 本体に未実装の機能。

## ギャップ1: タイトル表示ディレクティブ `[タイトル表示: ...]`

### 要件

```markdown
[タイトル表示: WORKING VEHICLES, position=center, font=bellpoke_font]
```

- DialogBox とは別の独立した text overlay レイヤーに、任意のテキストを描画する
- 画面位置（`position=center` / `top` / `bottom` 等）と font を指定
- 作られた overlay は `target=Title` で `[アニメ]` の対象になれる
- `[タイトル表示: 別のテキスト ...]` で内容を差し替えできる（または `[タイトル消去]`）

### 想定実装ポイント

- `parser/src/parser.rs:841` の `parse_animate_directive` 周辺と同じ階層に `parse_title_directive` を追加
- `Event` enum に `TitleOverlay { text, position, font }` バリアントを追加
- 新規 `frontend/src/game/TitleLayer.ts`（CharacterLayer.ts と同型）を作り、`Container` を `NovelRenderer` に挿入
- TitleLayer 内のスプライト/Text オブジェクトを「Title」という名前で `アニメ` 対象に登録（CharacterLayer の `characters` Map と並ぶ `titleObject` を持たせる）

## ギャップ2: 自己ホストフォントのロード

### 要件

`assets/fonts/bellpoke_fonts/bellpoke_font.woff2` をブラウザに認識させる。

### 現状

`docs/spec/markdown-v0.1.md:340-348` 参照。runtime は Google Fonts のみを動的ロードする。

### 想定実装ポイント

- FontLoader 抽象化: `frontend/src/game/` 配下に `FontLoader.ts` を新設
- font_family の値が Google Fonts 既知名でない & `assets/fonts/{name}/{name}.woff2` が存在するなら、`@font-face` を動的注入してそちらを使う
- 解決順序: 1) ローカル assets/fonts/、2) Google Fonts、3) システムフォント fallback

## ギャップ3: アニメで Title レイヤーをターゲット可能にする

### 要件

```markdown
[アニメ: target=Title, x=-900, duration=1400, easing=ease-in]
```

→ TitleLayer のテキストを X 方向にスライドさせる。

### 想定実装ポイント

ギャップ1 で導入する `titleObject` を、`AnimateLayer` / `executeAnimateEvent` が引ける登録テーブルに乗せる。target 解決の探索順は `characters → titleObject → ナレーター`。

## サンプルが要求する既存機能（チェック済み）

- `[背景: common/chalkboard.png]` ✓
- `[退場: <character>]` ✓
- `[枠なし]` ✓
- `[暗転解除]` ✓
- `[待機: ms]` ✓
- `[アニメ: target=<char>, x/y/scale/rotation/duration/easing]` ✓（位置・スケール・回転すべて利用）
- `**Name** (path/to/expression, 右):` 形式で `assets/images/{path}/{expression}.png` を立ち絵として読み込み ✓
- `**Name** → new-expression:` の表情変更（2コマ idle に流用） ✓
- `[SE: shape-enter.wav]` ✓

## 実装優先度（推奨）

1. ギャップ2（自己ホストフォント） — 単独で済む、影響が小さい、他の動画にも汎用
2. ギャップ1（タイトル表示） — レイヤー新設なので独立 PR で
3. ギャップ3（アニメ拡張） — ギャップ1 完成後

各ギャップで GitHub Issue を切る → `/impl name-name <issue>` で進行できる。
