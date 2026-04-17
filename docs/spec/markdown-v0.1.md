# Markdown v0.1 仕様書

Name×Name のゲームスクリプト言語仕様。Markdown のスーパーセットとして設計されており、通常の Markdown エディタでも読み書きできる。

パーサー実装: `parser/` (Rust, wasm-bindgen)

## フロントマター

ファイル先頭に YAML フロントマターを記述する。

```yaml
---
engine: name-name
chapter: 1
title: "出会い"
hidden: false
default_bgm: amehure.ogg
---
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `engine` | string | Yes | 固定値 `name-name` |
| `chapter` | number | Yes | 章番号 |
| `title` | string | Yes | 章タイトル |
| `hidden` | boolean | No | `true` の場合エディタで非表示（デフォルト: `false`） |
| `default_bgm` | string | No | 章全体のデフォルトBGMファイルパス |

フロントマターは Event ではなく、parser の Chapter 構造体（Rust 側）のフィールドとしてパースされる。フロントエンド側の EventChapter 型とは別物なので注意する。

## シーン

`##` 見出しでシーンを定義する。`{id}: {title}` の形式。

```markdown
## 1-1: 教室の朝
```

- `id`: シーン識別子（選択肢のジャンプ先として使用）
- `title`: シーンの表示名
- コロンは半角 `:` でも全角 `：` でも認識される

## ダイアログ

太字の名前、括弧内に表情と位置、改行後にテキスト。

```markdown
**主人公** (suppin_1, 左):
今日も平和な一日が始まる。

**ヒロイン** (smile_1, 右):
おはよう！
```

| 要素 | 説明 |
|---|---|
| `**名前**` | 話者名（ダイアログボックスの名前欄に表示） |
| `(表情, 位置)` | 表情名と立ち絵位置。位置は `左` / `右` / `中央` |
| テキスト行 | 台詞本文（次行以降に記述。空行か次の構文まで継続） |

表情・位置は省略可能:
```markdown
**主人公**:
（独り言……）
```

直前の話者と同じキャラクターが続く場合、話者行なしでテキストだけ書くと継続ダイアログになる:
```markdown
**主人公** (suppin_1, 左):
最初のセリフ。

次のセリフ（話者行なしで継続）。
```

## ナレーション

`> ` (blockquote) で始まる行はナレーションとして扱われる。

```markdown
> 夕日が教室を赤く染めていた。
```

話者名なしでダイアログボックスに表示される。連続する `> ` 行は1つのナレーションイベントにまとめられる。

## 背景

```markdown
[背景: radius/BG_COMMON_GRAD_3.png]
```

背景画像を変更する。パスは `assets/images/` からの相対パス。

## BGM

```markdown
[BGM: amehure.ogg]
```

BGMをループ再生する。パスは `assets/sounds/` からの相対パス。

```markdown
[BGM停止]
```

再生中のBGMをフェードアウトして停止する。

パーサー内部では `Bgm { action: Play, path }` / `Bgm { action: Stop, path: None }` の単一バリアントで表現される。

## SE（効果音）

```markdown
[SE: click.wav]
```

SEをワンショット再生する。複数のSEを同時に再生可能。パスは `assets/sounds/` からの相対パス。

## 暗転・暗転解除

```markdown
[暗転]
```

画面を黒くフェードアウトする。

```markdown
[暗転解除]
```

暗転を解除してフェードインする。

パーサー内部では `Blackout { action: On }` / `Blackout { action: Off }` の単一バリアントで表現される。

## 場面転換

```markdown
[場面転換]
```

場面転換エフェクトを実行する（背景クリア + 暗転解除）。

## 立ち絵退場

```markdown
[退場: ヒロイン]
```

指定キャラクターの立ち絵を画面から退場させる。

## 表情変更

```markdown
**ヒロイン** → angry_1:
```

表示中のキャラクターの表情を変更する。ダイアログなしで表情だけ変えたい場合に使用。`**名前** → 表情名:` の形式。

## 待機

```markdown
[待機: 1000]
```

指定ミリ秒だけ自動的に待機する。演出の間を取るために使用。

## フラグ

```markdown
[フラグ: visited_library = true]
[フラグ: route = "A"]
[フラグ: affection = 42]
```

ゲーム内フラグを設定する。値は boolean、文字列、数値のいずれか。

## 条件分岐

```markdown
[条件: visited_library]
**主人公**:
昨日も来たな、ここ。
[/条件]
```

フラグの値に応じてイベントの表示/非表示を切り替える。`[条件: フラグ名]` ～ `[/条件]` の間に任意のイベントを記述できる。ネスト可能。

パーサーは条件分岐を `Condition` イベントとしてパースし、ランタイムの `resolveEvents` が実行時にフラグを評価して展開する。

## 選択肢

```markdown
[選択]
- 図書館に行く → 1-2
- 帰宅する → 1-3
[/選択]
```

プレイヤーに選択肢を提示する。各選択肢は `- テキスト → シーンID` の形式。選択するとフラグが設定され、指定シーンにジャンプする。

## 完全な例

```markdown
---
engine: name-name
chapter: 1
title: "出会い"
default_bgm: amehure.ogg
---

## 1-1: 教室の朝

[背景: radius/BG_COMMON_GRAD_3.png]
[BGM: amehure.ogg]
[暗転解除]

**主人公** (suppin_1, 左):
今日も平和な一日が始まる。

**ヒロイン** (smile_1, 右):
おはよう！

[条件: visited_library]
**ヒロイン** (smile_1, 右):
昨日の本、面白かった？
[/条件]

> 夕日が差し込んできた。

[SE: chime.wav]

**ヒロイン** (smile_1, 右):
放課後、どこに行く？

[選択]
- 図書館に行く → 1-2
- 帰宅する → 1-3
[/選択]

## 1-2: 図書館

[背景: library.png]
[BGM: quiet.ogg]
[フラグ: visited_library = true]

**主人公** (suppin_1, 左):
静かでいい場所だ。

**ヒロイン** → happy_1:

**ヒロイン** (happy_1, 右):
でしょ？

## 1-3: 帰り道

[背景: road_sunset.png]
[BGM停止]

> 夕焼けの道を一人で歩いた。
```
