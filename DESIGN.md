# Name × Name — Design System

> Source of truth for visual design across the Name × Name editor. Mirror this
> document with code changes; never let the implementation drift.

このドキュメントはエディタ UI のデザインシステムを定義する。Player / Runtime
（PixiJS 側）は対象外で、エディタ画面のみが従う規範。

実装はすべて `frontend/src/index.css` の `--desk-*` カスタムプロパティ +
`.desk-*` ユーティリティクラス経由で行う。Tailwind の hardcoded color
（`bg-gray-800`, `text-blue-500` 等）を新規エディタコードに足さない。

---

## 1. Vision & Principles

### 1.1 Theme — 漫画家の机 (Manga-Artist's Desk)

エディタは「漫画家の机の上での作業」をメタファーとする。IDE / コード
エディタの無機質さを意図的に避け、紙・インク・付箋・朱印といった
物理的な筆記具の語彙でインタラクションを設計する。

### 1.2 Principles

| Principle | 説明 |
|---|---|
| **Warm over cold** | 純白・純黒ではなく古紙色・濃紫寄りインク色。蛍光色を避ける。 |
| **Long sessions** | 1時間以上連続作業しても疲れない。コントラストを上げすぎず、彩度も抑える。 |
| **Tactile metaphors** | カードは「紙」、タブは「バインダー」、保存は「朱印」、選択は「赤入れ」。 |
| **Dark = 深夜作業灯** | ダークモードは色反転ではなく「机の明かりを落とした夜」。暖色を残す。 |
| **Reversible visuals** | 派手なアニメーション/効果音はオプションで OFF にできる前提で設計する。 |

### 1.3 Non-goals

- プレイヤー画面（NovelPlayer / RPGPlayer）はゲーム描画レイヤーなのでテーマ適用外
- 派手なグラスモーフィズム・ネオン・ピクセルアートは採用しない
- 純黒 (#000) / 純白 (#fff) の使用禁止

---

## 2. Color Tokens

すべて CSS カスタムプロパティで定義される。`frontend/src/index.css` の
`:root` ブロックを正本とする。

### 2.1 Light mode (昼の卓上)

| Token | Hex | Use |
|---|---|---|
| `--desk-paper` | `#f5ecd9` | エディタ全体の地紙。古紙アイボリー。 |
| `--desk-paper-soft` | `#fbf4e1` | 原稿用紙（罫線あり）の下地。 |
| `--desk-paper-deep` | `#e6d9b8` | 非アクティブタブの紙厚感。 |
| `--desk-ink` | `#1f1a18` | 本文インク。**純黒ではない**（濃紫寄り）。 |
| `--desk-ink-soft` | `#4a4138` | サブテキスト・補足情報。 |
| `--desk-akapen` | `#c64a3f` | 朱赤。赤入れ・選択・朱印に使う。 |
| `--desk-marker` | `#f3d75a` | 蛍光イエロー。ハイライトの帯。 |
| `--desk-aopen` | `#5a8fc7` | 青ペン。リンク・参照系。 |
| `--desk-fusen-y` | `#f7e496` | 黄付箋（演出系イベント）。 |
| `--desk-fusen-p` | `#f7c6c6` | 桃付箋（RPG マップ要素）。 |
| `--desk-fusen-b` | `#c6dff7` | 青付箋（分岐・条件）。 |
| `--desk-fusen-g` | `#cfe5c0` | 緑付箋（RPG マスター定義）。 |
| `--desk-rule` | `rgba(31,26,24,0.12)` | 罫線・薄い区切り。 |
| `--desk-shadow` | `rgba(80,60,30,0.18)` | 紙の影。 |

### 2.2 Dark mode (深夜作業灯)

`.dark` クラスを持つ祖先要素配下で CSS 変数が再定義される。実装上は
`EditorScreen` の root div に `${isDark ? 'dark' : ''}` が付与される
（`<html>` 全体には付かない。これは `App.tsx` で複数ルートの dark mode
を独立に扱うため）。色相は維持し、明度のみ落とす。

| Token | Hex |
|---|---|
| `--desk-paper` | `#2b2520` |
| `--desk-paper-soft` | `#36302a` |
| `--desk-paper-deep` | `#1a1612` |
| `--desk-ink` | `#ece4d2` |
| `--desk-ink-soft` | `#b8ad97` |
| `--desk-akapen` | `#e57368` |
| `--desk-aopen` | `#7eb1de` |
| `--desk-fusen-y` | `#6c5e2b` |
| `--desk-fusen-p` | `#6e3f3f` |
| `--desk-fusen-b` | `#2f4868` |
| `--desk-fusen-g` | `#3f5a36` |

---

## 3. Typography

### 3.1 Font stacks

| Class | Font family | Use |
|---|---|---|
| `.desk-heading` | `'Klee One', system-ui, sans-serif` | H1〜H3、タブラベル、UI ボタン文言 |
| `.desk-body` | `'Hina Mincho', 'Klee One', 'Noto Serif JP', serif` | 原稿用紙カード内のシナリオ本文 |
| _(unscoped)_ | `system-ui, sans-serif` | UI フォールバック（settings 等の非テーマ画面） |

Klee One / Hina Mincho は `frontend/index.html` で preload する。
カスタムフォントを増やすときは preload に追加し、display=swap を維持する。

### 3.2 Sizes

エディタはテキストが密になりがちなので、Tailwind のデフォルト `text-sm`
（0.875rem）を基準とする。見出しは `text-base`〜`text-lg`、補足は `text-xs`。

---

## 4. Components

### 4.1 Card (`.desk-genko` / `.desk-fusen`)

#### `.desk-genko` — 原稿用紙

シナリオ本文（Dialog / Narration）を入れるカード。罫線あり、ベース色は
`--desk-paper-soft`。常に `.desk-body` と組み合わせる。

```html
<div class="desk-genko desk-body p-3 rounded">
  <strong>ナレーター</strong>: こんにちは
</div>
```

#### `.desk-fusen` — 付箋

演出指示・データ定義等、本文以外のイベントに使う。デフォルトで
`--desk-fusen-y`（黄）。修飾クラスで色を変える:

| Variant 群 | 修飾子 | 色 |
|---|---|---|
| Bgm / Se / Background / Wait / Animate / Shake / Flash / Fade / SceneTransition | — | 黄 |
| Choice / Flag / Condition | `.desk-fusen-b` | 青 |
| Monster / Item / Spell / PartyMember | `.desk-fusen-g` | 緑 |
| Npc / RpgMap / PlayerStart / RpgEvent / RpgTrigger | `.desk-fusen-p` | 桃 |

variant → クラスのマッピングは `EventCard.tsx` の `variantToDeskClass()` を
**唯一の真実の情報源** とする。CSS 側を直接拡張しない。

### 4.2 Tab (`.desk-tab`)

バインダーのインデックス風。ファイルタブ・エディタモードタブ
（ノベル/RPG）両方に使う。

- 非アクティブ: `--desk-paper-deep`
- ホバー: `--desk-paper-soft` + `--desk-ink`
- アクティブ: `--desk-paper` + 朱赤の下線 (`inset 0 -3px 0 var(--desk-akapen)`)
- 切替時に `translateY(1px)` でわずかに沈み込む

アクセシビリティ: `role="tablist"` + `role="tab"` + `aria-selected` を必ず付与。

### 4.3 Hanko button (`.desk-hanko`)

朱印風の保存ボタン。

- 非押下: `--desk-akapen` 背景 + 白文字 + 軽い影
- ホバー: `translateY(-1px)` + 影が深くなる
- 押下: `translateY(1px)` + inset 影（押印感）
- disabled: `--desk-paper-deep` 背景 + ink-soft 文字

保存・コミット系の主アクションだけに使う。汎用ボタンに流用しない。

### 4.4 Paper (`.desk-paper`)

エディタ全体に敷く地紙。`radial-gradient` で繰り返しの斑を作っており、
画像 import 不要。スクロールしても重くない。**`<body>` ではなく
エディタ画面の root に付ける**（プレイヤー画面に影響させない）。

---

## 5. Layout & Spacing

- Tailwind の spacing scale をそのまま使う（`p-3`, `gap-2` 等）
- カード間の余白は `gap-2` を基本
- セクション間の余白は `gap-6`
- カードの padding は `p-3`（小）/ `p-4`（大）

---

## 6. Motion

- 状態遷移は `transition-shadow`, `transition-colors`, `transition-transform` で 100〜200ms
- ボタン押下の沈み込みは `translateY(1px)`
- 派手なバウンス・パララックスは禁止（長時間作業の疲労源になる）

---

## 7. Accessibility

| 項目 | ルール |
|---|---|
| コントラスト | 本文テキストは AA (4.5:1) 以上。CSS 変数で担保（純黒/純白は使わない代わりにペアで設計） |
| Focus | 朱赤 (`--desk-akapen`) の ring を見せる。`outline: none` は禁止 |
| Motion | `prefers-reduced-motion` で transition を 0ms に落とせる（実装は follow-up） |
| Tab order | 論理順序を維持。`tabindex` の手動操作は最終手段 |

---

## 8. Do's and Don'ts

### Do

- ✅ 新規 UI には `.desk-*` クラスを使う
- ✅ 新しい色が必要になったら `--desk-*` トークンを追加する
- ✅ light / dark 両モードで動作確認する
- ✅ 1 時間以上の連続作業で疲れないか自問する
- ✅ コンポーネント追加時は本ドキュメントの §4 を更新する

### Don't

- ❌ Tailwind の `bg-gray-*` / `text-blue-*` 等を **エディタ画面の新規コード**に直接書く（既存箇所の段階的移行は別件）
- ❌ 純黒 (`#000`) / 純白 (`#fff`) を使う
- ❌ 蛍光ピンク / ネオングリーン等の高彩度色を使う
- ❌ CSS-in-JS や styled-components を導入する（既存スタックは Tailwind + CSS variables）
- ❌ プレイヤー画面のスタイルを「ついで」に変える（テーマはエディタ専用）

---

## 9. Roadmap

| Phase | Status | 内容 |
|---|---|---|
| §1〜§4.2 基盤 + タブ + カード | 🟢 PR #240 提出済 | パレット / 紙 / バインダータブ / 付箋色 |
| §4.3 朱印保存ボタン | 🟡 未着手 | `SaveDiscardButtons` の朱印化 |
| §6 拡張 (くしゃっと消える等) | 🟡 未着手 | カード追加・削除のモーション |
| 環境音 (任意トグル) | 🟡 未着手 | 紙めくり音 / ペン先 / 雨音 |
| `prefers-reduced-motion` 対応 | 🟡 未着手 | アクセシビリティ |
| プロジェクト一覧 / アセット画面の塗り替え | 🟡 未着手 | 統一感 |

各 Phase は Issue #239 配下の子 Issue として切り出される予定。
