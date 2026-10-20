# アーキテクチャ設計書

Name×Name のシステム構成と主要な設計判断をまとめる。

## モノレポ構造

```
name-name/
├── parser/             # Rust crate（Markdownパーサー本体）
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs            # WASMエクスポート
│   │   ├── models.rs         # Eventデータモデル（型の正本）
│   │   ├── parser.rs         # Markdown → Events
│   │   └── emitter.rs        # Events → Markdown
│   └── tests/
├── tui/                # Rust crate（TUI版プレイヤー、parserをネイティブ流用）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           # エントリポイント
│       ├── cli.rs            # CLI引数パース
│       ├── config.rs         # config.toml読み込み
│       ├── playback.rs       # 再生ロジック
│       ├── ui.rs             # ratatui描画
│       └── input.rs          # キー入力処理
├── frontend/           # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/       # UIコンポーネント
│   │   └── game/             # ゲームレンダラー（PixiJS）
│   │       ├── NovelRenderer.ts     # ノベルプレイヤー
│   │       ├── DialogBox.ts         # ノベル用ダイアログ（話者名別枠 + ▼）
│   │       ├── TopDownRenderer.ts   # RPG 見下ろし型
│   │       ├── RaycastRenderer.ts   # RPG 一人称レイキャスト型
│   │       ├── fieldBattle.ts       # フィールド→戦闘画面の起動・終了とキー入力の共通部分（TopDown / Raycast）
│   │       ├── battleMenu.ts        # 戦闘の候補窓（じゅもん・どうぐ）と対象選択の状態機械（純粋関数）
│   │       ├── battleMenuLayout.ts  # 候補窓・手のカーソルの座標（純粋関数）
│   │       ├── BattleMenuLayer.ts   # 候補窓・手のカーソルの描画（PixiJS）
│   │       └── RpgDialogBox.ts      # RPG 共通ダイアログ（TopDown / Raycast で共用）
│   ├── package.json
│   └── vite.config.ts
├── worker/             # Cloudflare Worker（GitHub REST API プロキシ）
│   ├── src/
│   │   ├── index.ts          # Hono ルーティング + CORS
│   │   ├── projects.ts       # GET /api/projects
│   │   ├── contents.ts       # GET/PUT /api/projects/:name/contents/*
│   │   ├── scripts.ts        # GET /api/projects/:name/scripts (#237)
│   │   ├── assets.ts         # GET/POST /api/projects/:name/assets/:type
│   │   ├── github.ts         # octokit ラッパー（baseUrl 切替で dev 用中継対応）
│   │   ├── auth.ts           # 認証ミドルウェア（CF Access 想定、#110）
│   │   └── cache.ts          # CF Cache API ヘルパー
│   ├── scripts/
│   │   ├── dev.mjs           # `npm run dev` ラッパー（直結 / proxy / local-fs の 3 モード）
│   │   ├── github-proxy.mjs  # corp proxy 中継（host 側）
│   │   └── local-fs-proxy.mjs# ローカル作業ツリー emulator（host 側）
│   └── wrangler.toml
└── docs/               # ドキュメント
```

### 各モジュールの責務

| モジュール  | 責務                                                              | パースする？                                           |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `parser/`   | Markdown ↔ Event[] の双方向変換                                   | Yes（正本）                                            |
| `frontend/` | エディタUI + ノベルプレイヤー（PixiJS） + RPGプレイヤー（PixiJS） | Yes（WASMで parser を呼ぶ。`src/wasm/parser.ts` 経由） |
| `tui/`      | TUI版プレイヤー（ratatui, frontendと対になる表示クライアント）    | Yes（parserをネイティブ関数呼び出しで直接利用。WASM/JsValueは経由しない） |
| `worker/`   | GitHub REST API プロキシ、CORS、認証ゲート、Cache API             | No（生テキスト中継）                                   |

Worker はパースしない。GitHub から Markdown を取得してそのままフロントエンドに渡し、フロントエンドが WASM パーサー（`frontend/src/wasm/parser.ts`）で Event[] に変換する。WASM の初期化は遅延実行（初回呼び出し時に `init()` を実行）。

`tui/` の選択肢分岐（`Playback`, #482）はシーン境界を越えてフラットに読み進む設計で、GUI版と異なり jump 先シーンを読み終えても終劇にならない。原稿を書く側は、選択肢の分岐先シーンをドキュメント末尾に置くか、必ず次の `Choice` で明示的に閉じること — さもないとドキュメント順で後続の別シーンの内容がそのまま漏れて表示されてしまう（設計の詳細は `tui/src/playback.rs` 冒頭のdocコメント参照）。この割り切りは単一ファイル前提だったため、複数の `.md` を一括マージする `multi_doc`（#496）以降は例外を設けている: `Playback::from_merged_document` で構築すると各 item に由来ファイルの id が刻まれ、暗黙の `advance()` はファイル境界（＝マージ対象ファイルの境目）を越えず、そこに到達すると `is_at_end()` になる。選択肢ジャンプ（`select_current_choice`）はこの制限の対象外で、別ファイルのシーンへ明示的に飛ぶのは従来どおり成功する。ただしジャンプ元とジャンプ先が異なるファイル由来の場合、シーンを跨いで引き継ぐランニング状態（イベント絵/暗転/直前SE、#497/#512）は#528でリセットされるようになった — 同一ファイル内のジャンプでは従来どおり引き継がれる。BGM（#502）は当初このリセット対象だったが、#724 で GUI版と揃えて「ジャンプ一般で持ち越す」に変更し、ファイル境界でもリセットしない。

ジャンプ先シーンが「純粋な中継シーン」の場合、`select_current_choice` はプレイヤーへの追加入力を要求せず自動的に先へ進む（#574）。判定基準（厳密）: そのシーンが積んだ items が「正確に1件」かつ、その1件が `Choice` で `options.len() == 1` の場合だけを対象とする。Line/Image が1件でも混ざっていれば対象外（地の文やイベント絵のある「見せ場のある単一選択肢画面」は飛ばさない）し、選択肢が0件/2件以上でも対象外（プレイヤーに分岐の意思決定をさせる画面は必ず止める）。背景: Gymnasiaの`hub_gate`→`hub_gate_advance_1`のような、フラグ設定専用で本文・イベント絵を持たず「続ける」選択肢1つだけを持つ中継シーンにジャンプすると、直前の画面（同じく「続ける」だけ）とピクセル単位で同一に見えてしまい、プレイヤーには「続ける」を2回押さないと反応しないUXバグに見えていた。この自動継続は実内容のあるシーン、または選択肢が0件/2件以上のシーンに着地するまで繰り返し、循環参照による無限ループは `RELAY_HOP_LIMIT`（100回）で打ち切る。中継シーンがファイル境界を越えて`jump`する場合も、上記のファイル境界越えリセットが同様に適用される。

`tui/` の `[待機: Nms]`（#497）はGUI版と異なり汎用実装ではなく、`Event::EventImage` の直後に `Event::Wait { ms }` が続く場合だけを `Playback::build` が走査時にパターン検出し、独立した画像コマ item（`PlaybackItem::Image`）と自動送りの締切（`main.rs::event_loop` の `wait_deadline`）を生成する狭いスコープの実装（GUI版 `NovelRenderer` の `Wait{ms}` + `waitingForWait` はどの文脈の `Wait` でも汎用的に待機する）。`events.get(event_index + 1)` で直後の1イベントしか見ないため、`[イベント絵:][SE:][待機:]` のように間に他のイベントを挟むと不一致になり自動送りは発火しない。それ以外の文脈にある `Wait` は従来どおり無視される（TUI版はそもそも `Wait` 全般を実装しておらず、この隣接パターンだけを新規サポートした）。設計の詳細は `tui/src/playback.rs` 冒頭のdocコメント参照。原稿を書く側の注意点は `docs/spec/markdown-v0.1.md` の「イベント絵」節参照。

## データフロー

### 編集時

```
ユーザー操作 → React UI (EventDocument 直接操作) → parser(emit) → Markdown → Worker(/api/.../contents PUT) → GitHub
```

エディタは `EventDocument`（`chapters[].scenes[].events[]` のツリー）を真実の情報源として
保持する。UI の編集操作は `EventDocument` を直接更新し、`emitMarkdown` で Markdown 文字列に
変換してから autosave 経由で Worker に PUT する。旧 `Chapter` / `Scene` / `Cut` 型は削除済み。

#### 複数 .md ファイル運用 (#237 / 親 #234)

エディタは「単一 `script.md`」前提から「複数 `.md`」を扱える構造に拡張済み。
`GET /api/projects/:name/scripts` が対象 `.md` を `[{ path, title, hidden, sha, size }]` で返す。
`scriptsDir` 未指定プロジェクトでは、ルート直下の `.md` の本文を peek し、frontmatter
`engine: name-name` を含むものだけを返す。
エディタが最初に開く文書は、この一覧から決める（直下の `script.md` があればそれ、無ければ basename が `script.md` のもの、それも無ければ先頭。#778）。
一覧の取得が済むまで初期ロードは待ち、一覧が失敗した環境では従来どおり直下の `script.md` を試す。
ただし worker の一覧取得は（キャッシュ MISS のとき）各 .md を順に fetch して遅いため、既定の直下 `script.md` の取得だけは一覧と並列で先に投げておく。
先行取得するのは `scriptsDir` を持つプロジェクトでは `scriptsDir/script.md`（`GET /api/projects` の `scriptsDir`）、持たなければ直下の `script.md`。
一覧が「その `script.md` あり」と確定したらその結果を採用し、一覧に無ければ捨てる（失敗してもトーストは出さない）。
先行取得の取得権は await の前に同期的に確保し、同じプロジェクトで未消費の先行取得があれば作り直さない（dev の StrictMode の二重実行でも起動時の取得は1回）。
文書のロードは、タブ・プロジェクトの切替で中断する（遅れて完了した古いロードは、state・sha・下書きに何も書かない）。
保存（PUT）・破棄の通信中はタブ切替を無効にする（タブを disabled にする）。通信中に編集中の文書が変わらないので、保存完了が別文書の sha・基準内容・下書きに触れる経路が無い（#794）。
下書きのキーは `currentScriptPath` ではなく、`rawMarkdown` がどのパスの文書の内容かを表す `rawMarkdownPath` から作る（タブ切替後、切替先のロード完了までに旧文書を編集しても、切替先のキーに旧文書の内容を書かない。#795）。
切替先のロード中（表示中の `doc` が編集中パスの文書でない間）は、編集 UI を読み取り専用にする（`main` に `inert`・「読み込み中...」の覆い）。`handleDocChange` もこの間の編集を受け付けない（旧文書の編集がロード完了で黙って消えるのを防ぐ）。
この間は破棄ボタンも無効（title「読み込み中…」）で、`handleDiscard` も何もしない（旧文書を捨てるつもりでも、取り直しと下書き削除は切替先に対して走り、切替先の未保存の下書きを消してしまうため）。タブ切替で旧文書の未保存表示は直ちに落とす。
`emitMarkdown` の await 中にタブが切り替わった編集は、`rawMarkdown` には反映せず、編集した文書の下書きとして退避する。別文書の保留中の下書きが残ったまま新しい下書きを積むときは、その文書の基準内容が分からないので、常に下書きとして先に退避する。
切替後に emit が失敗しても、切替先の表示を旧文書に戻さない（`setDoc(prev)` は編集した文書が表示中のときだけ）。
動画書き出しのモーダルを開いている間は、保存中と同じくタブ切替を無効にする（モード・エディタタブを切り替えるとモーダルはアンマウントされるので、開いている扱いも閉じる。切替先のロード中の `inert` でモーダルが操作不能になるのを避けるため）。
書き出しの**実行中**（録画中）は、`SaveDiscardButtons` のモード切替（`modeChangeDisabled`）と header のエディタタブ（ノベル／RPG）も無効にする（disabled・薄い表示・`onClick` の早期 return）。切り替えるとプレビューのレンダラが破棄されて録画が壊れるため (#797)。完了・失敗・中止・タイムアウトの後は戻る。
プロジェクトの切替は App が `key={projectName}` で再マウントする前提で、エディタ内の初期化処理は保険。
`rawMarkdown` は parse 完了と中断判定の後に設定する（設定からコミットまでの間のタブ切替で、切替先のキーに旧文書の本文を積まないため）。
一覧も失敗した場合は、先行取得の失敗を使い回して同じ取得を繰り返さない（トーストは1回）。プロジェクトが変わったら一覧・開くファイル・doc の所属を初期化して取り直す。
プロジェクト設定に `scriptsDir`（例 `content/scripts`）を持たせると、列挙の起点を
そのディレクトリに移し、**起点直下＋サブディレクトリ 1 段**の `.md` を列挙する（#284。
theo-hayami がシナリオを `content/scripts/free` `content/scripts/main` に分割するため）。
この経路は #314 以降、Git Trees API の recursive listing で path/sha/size を一括取得し、
各 MD 本文の frontmatter peek はしない。theo-hayami の 260 本級で scripts listing が 260 req 級に
膨らむのを避けるためで、`scriptsDir` 配下は name-name script 置き場として扱う（`title=null`,
`hidden=false`）。
EditorScreen は listing をタブ UI で表示し、タブ切替で `currentScriptPath` 経由で
`getContents` / `putContents` を呼び直す。`hidden: true` の .md はタブにラベル表示され、
`/play` 系には露出しない（ogurasia の `data.md` 等のマスター定義置き場として使う）。この hidden
判定は frontmatter peek を行うルート直下プロジェクト向けで、`scriptsDir` 高速経路では使わない。

localStorage の draft キーは `name-name:editor-draft:${projectName}:${path}` で
ファイル単位に分離されている。タブ切替時に未保存変更があれば確認ダイアログを出す。

#### RPG タブのマスター統合 (#238 / 親 #234)

`mergeMasterDataFromDocs(docs[])` で複数 .md のマスター (`Monster` / `Item` / `Spell` /
`PartyMember`) を束ねる。重複 ID は **後勝ち**。`rpgProjectFromDoc(doc, sceneId, name, extraDocs)`
の `extraDocs` に他 .md (例: `data.md`) の `EventDocument` を渡すと、active doc が末尾に
ある状態でマージされ、active 側の上書きが効く。EditorScreen は availableScripts から
currentScriptPath 以外を全部 parallel fetch + parse して `otherDocs` state に詰める。

#### マルチMD再生と遅延ロード（#284 / #314）

ノベル本編もシナリオを複数 .md に分割できる。`PlayerScreen` は `listScripts`（`scriptsDir`
配下＋リポ直下）でプロジェクトの .md 一覧と各ファイルの `sha` を取得し、**エントリ＝path の
basename が `script.md`** のもの（無ければ先頭）を選ぶ。

通常再生は従来どおり**エントリ doc を `flattenDocumentEvents` で線形化した `events=`**（多シーンの
自動進行を維持）。それとは別に、読み込み済み doc の全シーンを `NovelPlayer` の
`jumpSceneIndex=` → `NovelRenderer.setJumpSceneIndex` でジャンプ解決索引（`allScenes`）として渡す
（再生ストリームは置換しない）。

#314 以降、`/play` の初期ロードでは全 .md を fetch/parse しない。初期表示は entry MD だけを読み、
選択肢などで未ロード scene へジャンプした時点で `NovelRenderer` の missing scene resolver が
必要な MD を追加取得する。まず `sceneId.md` と theo-hayami 形式の `theme__resident.md`
（例: `makiya-netami` → `netami__makiya.md`）、Gymnasia 形式の `routeNN/NN-slug.md`（#556。
`sceneId` が `r{route番号}-{slug}` 形式のとき `route{route番号}/{slug}.md` を候補にする。例:
`r09-01-eyes-in-the-dark` → `route09/01-eyes-in-the-dark.md`。basename だけでなくフォルダ名込みで
一致させるのは、`02-life.md` のような同名 slug が複数 route（route01/02/05/06）に存在するため）を
候補にし、見つからなければ未ロード MD を順に探す。
読み込み済み doc と in-flight 読み込みはセッション中 `Map` で共有し、同一セッション内の再遷移で
再 fetch / 再 parse しない。

ブラウザ間をまたぐ再訪問では `frontend/src/game/scriptContentCache.ts` の IndexedDB キャッシュを使う。
キャッシュは再生を止めない best-effort 最適化で、利用不可・読込失敗・保存失敗時は従来経路へ戻る。

- Markdown 本文 cache: key は `projectName + ref + path + sha`。`listScripts` の `sha` が一致すれば
  GitHub Contents API を呼ばず、IndexedDB の本文を使う。`sha` が変われば key が変わるため cache miss になる。
- parse済み `EventDocument` cache: key は `projectName + ref + path + sha + schemaVersion`。
  `schemaVersion` が一致すれば WASM `parseMarkdown` を呼ばず保存済み doc を使う。parser / document 形状を
  変えた場合は `PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION` を上げて既存 cache を無効化する。#340 では本文の表示用
  正準化（`--`→`──` / `…`→`⋯`。後述）を parser に足して正規形が変わったため 1→2 に上げ、素の `--`/`…` を
  含む旧解析結果を無効化した（キャッシュ復元は parseMarkdown/normalizeEvents を経ないため）。

`listScripts` 不在・失敗時は単一 `script.md` 再生へフォールバックする。このフォールバックは一覧 `sha` が
無いため IndexedDB cache 対象外。シーン ID は全 .md でグローバル一意が前提（`findSceneById` 先勝ち・
重複は warn）。なおエントリ doc のみが RPG 判定・`aspect_ratio`/`choice_style`/`font_family`/
`font_size`/`dialog_style`/`protagonist` の供給元（サブ MD の RPG シーンは未対応）。

**エディタのプレビューでのファイル横断ジャンプ（#778）**: エディタ（`EditorScreen`）のプレビューも、他の .md のシーンへの
`[ジャンプ:]`・選択肢を `PlayerScreen` と同じ遅延ロードで解決する。遅延ロードの規則（sceneId から候補 MD を推定 →
未ロード MD を順に取得 → 索引を作り直す）は `frontend/src/game/crossFileScenes.ts` の
`resolveMissingSceneAcrossDocs` に切り出して両画面で共有する。取得元だけがエディタ固有で、次のとおり:

- **編集中の文書**: 常に最新の `doc` state（未保存の編集を含む）。キャッシュには入れず、呼び出しごとに作業用 `Map` へ差し込む。
  タブ切替直後に `doc` がまだ旧文書の間（`doc` のパスと編集中パスが食い違う間）は解決せず not-found にする（エントリの取り違え防止）
- **他タブの文書**: そのタブの未保存の下書き（`localStorage` の `name-name:editor-draft:{project}:{path}`）があればそれ、
  無ければ **develop** ブランチの内容（エディタと同じ。`/play` は main）。この取得（`loadOtherDoc`）は path キーのキャッシュ・取得中 Promise と
  ともに1本で、#238 の `otherDocs`（RPG タブのマスター参照）と共有する（二重取得しない）。そのためマスター参照も下書き優先になる
  （エディタでは編集中・未保存の内容を見るのが自然なため）。キャッシュはタブ切替・プロジェクト切替で epoch を進めて捨て、
  古い取得結果は反映せず、進行中の解決ループも打ち切る
- **下書きの確定**: 下書き（localStorage）への書き込みは 1 秒デバウンスだが、タブ切替・アンマウントの直前に保留分を即確定する
  （切替前 1 秒以内の編集が失われないように。他タブの下書きがプレビューの取得元になるため）
- **探索対象**: `/play` と同じく hidden の .md（`data.md` 等のマスター）は遅延ロードの探索から除く（編集中のものは残す）
- **`jumpSceneIndex`**: 編集中の文書のシーン（ライブ再パースで更新）に、取得済みの他文書のシーンを後ろへ足した配列。
  ライブ再パースしても取得済みの他文書の索引は残る。反映は索引 effect だけ（#671）で、再生ストリームは触らない
- **#607 の `event_image_transition` 継承**: `/play` と同じく、`script.md`（basename 一致）以外の他文書は `script.md` の値を継承してパースする
  （プレビューの目的は `/play` の再現）。`script.md` が無い・読めない場合は継承なし。編集中の文書自身には適用しない（エディタが直接パースするため）
  継承元の `script.md` を編集中でその文書が未確定の間（タブ切替直後）は他文書を解析しない。`script.md` の `event_image_transition` を編集で変えると、解析済みの他文書は捨てて取り直す（その破棄で打ち切られた進行中のジャンプ解決は、新しい状態で1回だけやり直す。タブ切替による破棄ではやり直さない）。
  `doc` が未確定の間（タブ切替直後）に起きたジャンプは not-found になり、読み込み完了後に入り直すと解決する
- エントリは「いま編集中の文書」（`/play` の `script.md` 固定とは異なる）
- **動画書き出しの開始/終了シーン**（`VideoExportModal` の候補）は、今回は範囲外で自文書のシーンのみ（他文書から選べない）


#### production 向けシーン直接ディープリンク `?scene=`（#386）

`?scene=<sceneId>` は production ビルドでも常時有効な、特定シーンへの直接埋め込み用の入口。
`debug_scene`（[デバッグガイド](./guide/debugger.md) 参照。flags/eventIndex/textIndex も指定
できるデバッグ起点。#652で本番ビルドでも常時有効化済み）とは別系統で、こちらは sceneId 単体の
みを受け取る最小限のパーサ（`frontend/src/game/sceneQuery.ts` の `parseSceneQuery`）。theo-hayami
の「1 セル 1 URL＝1 遅延埋め込み」設計のための経路で、他 .md の会話劇セルを 1 本だけ外部ページに
埋め込むときに使う。両者の決定的な違いは confinement（在圏、下記）の有無——`?scene=` は圏外への
遷移を終劇として扱うが、`debug_scene` は confinement なしで任意のシーンへ遷移できる。

`PlayerScreen` が `?scene=` を読み、対象 sceneId が属する script を（上記の missing scene
resolver 経由で）事前解決・ロードしてから `NovelPlayer` に `initialSceneId` として渡す。

`?debug_scene=` の遅延ロードは `PlayerScreen` では事前解決しない（#734 PR2。#726 の事前解決は撤去した）。
`NovelRenderer.startFrom` が新規開始専用の Promise 版になり、`jumpToScene` と同じ遅延ロードの解決口
（`SceneIndex.resolve` → `missingSceneResolver`）を通るため。`?scene=` の事前解決は、confinement の算出
（`findConfinedSceneIds` は対象の doc を要する）とタイトル画面の判定（`startSceneId`）に必要なので残る。
HUD（`loadDebugInfo`）の `debug_scene: <id> → resolved / not found (…)` の行は、`NovelPlayer` が初期入場の
結果を `onInitialEntry` で通知し、`PlayerScreen` が足す。

`NovelPlayer` のマウント時の入場は1回だけで、純粋関数 `resolveInitialEntry`（`game/initialEntry.ts`）が試行の順序
（fluid 再マウントのスナップショット → `?debug_scene=` → `?scene=` → 自動クイックロード → エントリ）を決め、
`runInitialEntry` が `entered` で打ち切り、`failed` / `null` のときだけ次へ進む（`superseded` でも打ち切る）。
文書は先に `loadEvents` / `loadScenes`（開始しない読み込み）で入れ、エントリ冒頭の自動進行は初期入場が確定するまで実行されない。
`?debug_scene=` は `startFrom({ …, confinedSceneIds: null })`（confinement なし）、`?scene=` は
`startFrom({ sceneId, confinedSceneIds })` で、confinement は入場属性として解決できた時点で置き換わる。
`?debug_scene=` が入場できなければ `?scene=` の confinement が保たれる（#726 の「後勝ち」を事前解決なしで再現）。
`?debug_scene=` / `?debug_script=` / `?scene=` のいずれかがあるときは自動クイックロードをしない。`?scene=` と `?debug_script=` を併用するときは `?scene=` の confinement を外す（`confinedSceneIds: null`、#729）。
`?scene=` の `startFrom` は `eventIndex=0`（シーン先頭）固定なので、**通常入場と同じ経路**
（`SceneEntryController.startScene` → `host.startEvents` → `resetAndStartEvents`）に乗り、冒頭の `[背景:]`/`[BGM:]` を実行し最初の
話者の立ち絵を出してから最初のテキストで止まる（#399）。従来は宣言的復元の `restoreToScene` に
乗せていたため、冒頭ディレクティブが実行されず背景も立ち絵も出ないまま `eventIndex=0` で
止まっていた。`debug_scene` で `eventIndex>0` を指定した途中局面起動だけ `restoreToScene`
にフォールバックする（詳細は [ADR 0002](./adr/0002-deterministic-state-and-debuggability.md) の §3）。
どちらも入場の種類は新規開始で、背景・BGM・立ち絵は持ち越さない（`carryPolicyFor('fresh')`）。
`startFrom` の `linear: true`（動画書き出しの範囲指定が明示的に選ぶ。既定 false。#817）で、対象がエントリ文書の線形ストリーム上のシーンなら、ストリーム全体をそのシーン先頭から流し、シーン境界で `onSceneChange` を発火する（#777）。`?scene=` / `?debug_scene=` は `linear` を渡さないので、エントリのシーンでも他ファイルのシーンでも、指定シーンの events だけを流して末尾で終劇する（`story-ended` が親ページに届く）。閉じ込め外のシーン境界に入ったら終劇にする処理は、線形ストリーム再生中の防御として残してある。

**confinement（在圏）+ 終劇**: 単独埋め込みは対象 script ファイルの外（hub・他ファイル）へ
choice で漏れてはいけない（theo-hayami #20: 他ファイルへの遷移は choice ではなく埋め込み外側の
HTML リンクで行う設計）。`PlayerScreen` の `findConfinedSceneIds(targetSceneId, docs, entryPath)`
が対象 sceneId が属する script ファイル自身の sceneId 一覧を算出し（entry doc/hub 自身は候補から
除外）、`NovelPlayer` → `startFrom({ sceneId, confinedSceneIds })`（新規開始の入場属性）に渡す。集合外への遷移を検知すると
通常のシーン遷移をせず `endStory()` を呼び、`NovelGameState.storyEnded` を true にする。

`endStory()` の見た目は2段構え（#404）。**`assets/scripts/intermission.md` をプロジェクトが
配置していれば**（`PlayerScreen` が `assets/raw` 経由で取得・parse し `NovelRenderer.
setIntermissionScene(events, {backgroundFadeMs, characterFadeMs, eventImageFadeMs})` に渡す。取得は `title.png` と
同じ経路・タイミング）、`endStory()` は**既存の専用消去コード**（`fadeOutBackgroundEntries()` +
`characterLayer.clearForSceneTransition()`）だけをそのまま使い、通常のシーン遷移機構
（`resetAndStartEvents`/`jumpToScene`。背景を `finishBackgroundCrossfadeInstant()` で瞬間消去する
別経路）には一切乗せない——乗せると「幕がゆっくり降りる」演出がフェード無しの瞬間消去に負けて
台無しになるため。消去フェード時間とタブロー内イベント絵フェード時間は**物語本編の `background_fade_ms`/`character_fade_ms`/`event_image_fade_ms`
（他の全トランジションに影響する共有フィールド）を流用せず、intermission.md 自身の frontmatter**
から読む（未指定は `INTERMISSION_FADE_MS_DEFAULT`=1400ms、通常既定 700ms より遅めの「幕が降りる」
値。フェード時間の推奨3値＝基本700ms・短め300ms・長め1400ms のうち「長め」を採用・#424）。消去フェード完了後、intermission.md 自身のイベント列を `renderIntermissionTableau()` が
静止画タブローとして描画して凍結する（`storyEnded=true` で以後 `advance()` は no-op のため
Choice によるプレイヤー操作介入は無い。ただし `[待機: Nms]`（数値指定）はタブロー専用のローカル・
ステージングとしてサポートし、Label/Image の間に挟むことで段階的なフェード演出ができる（#424。
黒くなった後テキストがじわっと出て、それからロゴがさらにじわっと出る、等）。**intermission.md
未配置のプロジェクト**は、PixiJS 側（`NovelRenderer` の終劇オーバーレイ、#386/#404/#630）が
中央に大きく "to be continued..." を表示し、`assetBaseUrl` の `title.png` があれば左上に埋め込み
元プロジェクトのロゴを重ねる、従来の見た目にフォールバックする（フェーズ1・後方互換。表示実装は
#630 で DOM `NovelPlayer.tsx` から PixiJS `NovelRenderer.showEndingOverlay()`
+ `characterLayer.showImage()` に置き換わった——`TitleScreenOverlay`/#628 フェーズ2b と同じ移行
パターン。`intermission.md` 使用時にこの表示を出さない判定は、以前は `NovelPlayer` 側の React state
（`usedIntermissionScene`、endStory() 発火時点の `hasIntermissionScene()` を1回だけスナップショット）
が担っていたが、#630 で `NovelRenderer.syncEndingOverlayVisibility()` に内部化された）。
`intermission.md` はあえて `content/scripts/` 配下ではなく `assets/` 配下に置く設計——
`content/scripts/` は `listScripts()` で全列挙され `allScenes`/confinement グラフに乗ってしまい、
`?scene=` 直リンクや原稿 typo で到達可能になる事故ルートになるため、意図的に外している。

終劇の判定箇所は 3 つ:
**選んだ jump 先**が圏外なら `jumpToScene`（choice 確定後）が終劇する。さらに **全 option の
jump 先が圏外の `[選択]` に到達した場合**は、選択肢を描画せず `processDirective` の Choice 分岐で
先回りして終劇する（#398。全 option 圏外の choice はクリックするまで `jumpToScene` に届かず、
`storyEnded` の postMessage が発火しないため既読化されなかった。`markCurrentSceneRead` を済ませて
から終劇し、選択肢を出さずに完読を親へ通知する）。加えて **`[選択]` を持たないまま `advance()` が
resolvedEvents を最後まで消化した場合**は、confinement とは無関係に、`onEndCallback`
（VideoExporter 専用）が未登録であれば `endStory()` を呼ぶ（#470。記述が尽きたシーンが無反応で
固まって見える不具合の修正。`onEndCallback` 登録時＝動画書き出し中はそちらに完全委譲し
`endStory()` の演出は重ねない）。`?scene=` が hub 自身の sceneId を指した場合は
`findConfinedSceneIds` が null を返し、confinement を組まず無制限フローにフォールバックする
（hub → 各お題への通常 choice 遷移を壊さないため）。**終劇は行き止まり**（kako-jun 決定、#815）:
`storyEnded` の間は `goBack()` / `seekTo()` が冒頭のガードで no-op（#386）であり、`SeekBar` も無効表示にして
操作（タップ/ドラッグ）を受け付けない。`SeekBar.setDisabled` は `storyEnded` の書き換え箇所
（`endStory` / `clearStoryEnded` / `applyState`）から `syncSeekBarEnabled()` で同期する transient な UI ゲート
（GameState には持たない）。TUI には巻き戻し・シークバー自体が無く対応不要。`storyEnded` の設計上の位置づけ
（ADR 0002 の「演出の中間状態を持たない」規律との関係）は
[ADR 0002](./adr/0002-deterministic-state-and-debuggability.md) を参照。

**埋め込み時のヘッダ抑制（#392）**: `PlayerScreen` 上端のヘッダ（プロジェクト一覧への戻る
ボタン＋タイトル）は、**iframe に埋め込まれて表示されているとき（`utils/isEmbedded.ts` の
`isEmbedded()` ＝ `window.self !== window.top`）は描画しない**。埋め込み文脈では name-name の
トップへ戻る導線が無意味で、埋め込み側（theo-hayami 等）が既に額縁とタイトルを出しており二重に
なるため。standalone タブで `/play/*` を直接開いたときは従来どおりヘッダを出す（後方互換）。
これは `?scene=` に依存しない一般的な埋め込み挙動で、`?scene=`（＝ディープリンク意図＝#388 の
タイトル画面飛ばしの条件。#628 フェーズ2b で表示実装は DOM `TitleOverlay.tsx` から PixiJS `TitleScreenOverlay` に変わったが、この判定ロジック自体は不変）とは関心が別（ゲートも別）。

**standalone 再生時のヘッダ抑制 `header:`（#519）**: 上記の `isEmbedded()` 抑制とは**独立の軸**で、
埋め込みでない standalone 再生（`name-name.llll-ll.com/play/...` を直接開く等）でもプレイヤーヘッダを
抑制できる per-game frontmatter 設定。`"visible"`（既定・後方互換）/ `"hidden"`（完全非表示。戻る手段が
無くなる想定なので原稿作者の判断に委ねる）/ `"collapsed"`（折りたたみ。画面上部中央に小さなハンドルを
常時出し、タップでヘッダを一時展開する。展開中も `<main>` の高さを変えない absolute オーバーレイで、
3秒操作が無ければ自動で再び折りたたむ）の3値。`isEmbedded()===true` のときは本設定に関係なく常に
ヘッダを描画しない（embedded 抑制が優先し、`header:` は standalone のときだけ意味を持つ）。不正値・
未指定は `"visible"` にフォールバックする（`dialog_style` と同じ後方互換パターン）。詳細は
[Markdown 仕様書](./spec/markdown-v0.1.md) の `header` frontmatter を参照。

**プレイヤーの見た目テーマ `?theme=light|dark`（#394）**: ノベルゲーム本体（PixiJS キャンバス）は
常に `0x000000`＝黒なので、**プレイヤー（`/play/*`）の見た目デフォルトは黒（dark）**。ルート背景を
`bg-black`、ローディングを黒地・明色文字にして「黒→黒」で継ぎ目なくキャンバスへ繋ぐ（暗い埋め込み
先で白いロード画面がフラッシュしない）。React マウント前の白も `index.html` の body 黒背景で消す。
例外として**ライトな埋め込み先**は `?theme=light` を明示して白いロード画面を要求できる（`game/themeQuery.ts`
の `parseThemeQuery(search)` ＝ `?theme=light` のみ 'light'、他は既定 'dark'）。App の darkMode（エディタ
UI 用トグル、`isDark`）とは独立＝プレイヤーの見た目は `?theme`（既定 dark）だけで決まる。`?scene=`
（#388）・`isEmbedded()`（#392）とも独立した第3の埋め込み引数。

**完読の親通知 postMessage（#395）**: 埋め込み側（theo-hayami 等）に「どのセルを読み終わったか」を
知らせるため、**終劇（endStory）到達時に、iframe 埋め込み時（`isEmbedded()`）のみ親ウィンドウへ
`window.parent.postMessage({ source:'name-name', type:'story-ended', scene, project }, '*')` を送る**
（`game/storyEndedMessage.ts` の純粋関数 `buildStoryEndedMessage` が本体を組み立て、`NovelPlayer` の
`onStoryEndedChange` が `ended===true && isEmbedded()` のときだけ発火）。name-name の既読 localStorage は
別オリジンで埋め込み側から読めないため、完読の事実だけを渡し、埋め込み側が自前で既読を記録・表示する
（theo-hayami #30）。`scene` は `?scene=` の sceneId（無ければ null）、`project` は projectName。
standalone や `ended===false`（終劇解除）では送らない。origin は `'*'`（受信側が origin 検証する前提）。

### 再生時

```
Worker(listScripts) → entry Markdown / cached EventDocument → Event[] → resolveEvents → NovelRenderer(PixiJS)
```

## パーサー

Rust で実装。wasm-bindgen + tsify-next で TypeScript 型を自動生成する。

### Event 型

`parser/src/models.rs` が型の正本。主要なバリアント:

- `Dialog` — ダイアログ（character, expression, position, text, voice_path?, font_family?, bubble_style?）。`bubble_style` は `[吹き出し:]` の line-scoped 表示指定で、DialogBox を場面内の PixiJS 吹き出しへ置換する。Novel では平面、Theater では既存の position/depth/camera projection を使う。
- `Narration` — ナレーション（text, voice_path?, font_family?, bubble_style?）
- `Background` — 背景変更（path）。通常進行では旧背景と新背景を同時保持し、既定 700ms（フロントマター `background_fade_ms` で作品ごとに変更可・表示/切替/退場すべてに適用・#407）で alpha を入れ替えるクロスフェードを行う（復元・シーク・スキップは即時）
- `Bgm` — BGM 制御（action: Play/Stop, path, fade_ms?: Play=fade-in / Stop=fade-out 時間 ms）
- `Se` — SE 再生（paths: 候補ファイルパス配列、通常は1件＝従来通りの単発再生。複数件は選択数+間隔でランダム抽出+シャッフル再生のプールになる（#672、後述「SE複数候補プールのランダム抽出+シャッフル+ランダム間隔再生」節参照）、fade_ms?: fade-in 時間 ms、count?: 選択数K・省略時は全件、gap_min_ms?/gap_max_ms?: ランダム間隔レンジ・省略時のランタイム既定は50-200ms）
- `Blackout` — 暗転制御（action: On/Off）
- `SceneTransition` — 場面転換
- `PageBreak` — 手動改頁マーカー（本文中の単独行 `---`。`dialog_style: novel` の強制ページ境界。非テキストイベントとして読み飛ばす。#292 Phase 2）。**本文中の `--`（2 連）は別物**で、余韻横棒 `──` に正準化され novel の文送り境界になる（#340・後述）。改頁になるのは単独行 `---`（3 連以上）だけ
- `Exit` — 立ち絵退場（character）
- `Enter` — 無言の立ち絵登場（character, expression?, position?, fit?・#401）。`[登場: 名前 (sprite/表情, 位置)]` で本文なしに立ち絵を出す。話者タグの立ち絵指定と同書式・同じ配置/フェード/衝突退場ロジック（`CharacterLayer.show` を流用）だが、テキストと話者継続状態を持たない。非テキストイベントなので `processUntilNextTextEvent` が冒頭で実行し、`?scene=` ディープリンク（#399）開始直後にキャストを立てられる。冪等（同一 name/expression/position/fit の再宣言は show 側の no-op ガードで無効）
- `ExpressionChange` — 表情変更（character, expression）
- `Wait` — 固定時間待機（ms）
- `WaitDisplayComplete` — 表示完了待機。`[待機: 表示完了]` で、その時点の背景ロード/フェードと立ち絵ロード/フェード/移動が完了するまで待つ
- `Flag` — フラグ設定（name, value）
- `Condition` — 条件分岐（flag, events: Event[]）
- `Jump` — 無条件ジャンプ（target: シーンID。`[ジャンプ: シーンID]`、#725）。選択肢確定と同じ遷移経路（GUI は `jumpToScene`、confinement・`missingSceneResolver` 遅延ロードを再利用）。`[条件:]` 内にも書け、先読み（`preloadUpcomingAssets`）は `Choice`/`Condition` と同様にここで打ち切る。遷移先不在・循環上限（連続 100 回）では停止する（GUI は `[待機]` 用の `waitingForWait` とは独立した `jumpState: 'idle' | 'pending' | 'stalled'` で持ち、遷移予約は `armJump`、停止は `stallJump`。TUI は `pending_jump` の予約保持）。`jumpState` は GameState に載せず、`applyState`（goBack・seekTo・startFrom・quickLoad・セーブロード・restoreSnapshot の全復元経路）で `idle` に戻して、復元後の `eventIndex` が Jump を指していれば `armJump` で再予約する（停止は復元をまたいで持ち越さず、遷移先不在なら再び警告して停止する）。詳細は spec のジャンプ節
- `Choice` — 選択肢（options: ChoiceOption[]。各 `ChoiceOption` は `text`/`jump` に加え任意の `condition?: string` を持つ。`- text → jump [条件: flag]` 構文で個別ロックを付けられる、#591。さらに任意の `cleared?: string` も持ち、`[完了: flag]` 構文でクリア済み視覚状態（選択可能なまま暗い配色）を付けられる、#594（#596でキーワードを`完了`に改名）。両構文は同じ行に併記可能。詳細は `docs/spec/markdown-v0.1.md` の「選択肢の条件付きロック」「選択肢の完了（クリア済み）視覚状態」参照）。GUI版・TUI版とも、ロック中選択肢はダイム配色のみで表し記号は付けない（旧🔒絵文字連結はGUI版が#598、TUI版が#609でそれぞれ撤去）。GUI版はさらに「ロック」と「既読/完了」を独立した2軸として扱いアイコンを出し分ける（`resolveChoiceIconKind`、`novelLayout.ts`、#598追記3/#604訂正/#658再訂正。配色の優先順位 locked > cleared > alreadyRead > 通常 とは別軸で判定する。`locked` はアイコン種別の判定に一切関与しない——ロックは「読むことすらできない」状態を表すだけで「未読でない」わけではないため、#604 で `locked` 引数自体を関数シグネチャから削除した）: `cleared || alreadyRead`（既読/完了 or 実際に読んだ、ロック中かどうかは無関係）が真ならプロジェクト任意アセット `assets/images/read-icon.webp`、どちらも false（未読、ロック中かどうかに関わらず）ならプロジェクト任意アセット `assets/images/unread-icon.webp` を、それぞれ `ChoiceOverlay.setAssetBaseUrl()`（`NovelRenderer.setAssetBaseUrl` から他レイヤと同じタイミングで伝播）で `Assets.load()` 先読みし（favicon.png と同じ `assets/raw/{path}` 取得規約）、成功していればテキストの上にアイコンを表示する（未配置/取得失敗時は配色のみのフォールバック、read/unread それぞれ独立に判定）。**#658 再訂正**: #604 時点では「アイコンは `cleared` のみで決まり `alreadyRead` は無関係」だったが、Gymnasia route10 の実機確認で「背景色（`alreadyRead` 由来）は既読を示すのに、`[完了: flag]` を書いていない選択肢はアイコンだけ未読のまま」という食い違いが報告されたため、`cleared || alreadyRead` の OR 合成に訂正した。アイコン表示時は `ChoiceOverlay.layoutButtonHeight` がアイコン+テキストの2段組みが収まる高さへ切り替わる（アイコンが一切描画されない回は通常の `BUTTON_HEIGHT` のまま非破壊）。アイコン/テキストの縦位置は純粋関数 `computeChoiceIconLayout`（`novelLayout.ts`）が算出する。**選択肢テキストの折り返し（#658）**: ボタン内テキストは DialogBox.ts と同じ禁則ワードラップ（`wordwrap.ts`）でボタン内側幅（`layoutButtonWidth - CHOICE_TEXT_PADDING_X*2`）に収まるよう `\n` 区切りに事前折り返しし、`TextStyle.align: 'center'` で行ごとに中央揃えする（PixiJS 組み込みの `TextStyle.wordWrap` は使わない——CJK は空白区切りが無いため `breakWords` 無指定では折り返されず、`breakWords` を足しても禁則処理が無いため句読点が行頭に来得り、本文用の禁則ワードラップと二重実装になるため）。折り返しで行数が増えた回は、その `show()` 呼び出し内の最大行数ぶん `CHOICE_TEXT_LINE_HEIGHT`(24px) を `layoutButtonHeight` に加算する（`willShowIcon` と同じ「必要な回だけ調整する」流儀）。1行に収まる従来どおりの短い選択肢文言は追加の高さが 0 になり非破壊。GUI版はさらに #633 で `ChoiceOverlay.handleKeyDown()` によるキーボード操作（Tab/Shift+Tab・矢印キーでのフォーカス移動、Enter/Space での確定、visible focus ring）を持つ——`TitleScreenOverlay`（#633 同時対応）と同じパターンをグリッド配置（#508、同じ列/行内移動）・ロック（#591）・#339 スクロール追従に合わせて拡張したもので、`NovelRenderer.handleKeyDown` は `waitingForChoice` の間 window keydown をこのメソッドへ委譲する。**focus-visible化（#639）**: #633 実装当初は `show()` 時に無条件で先頭選択肢へフォーカスリングを描画しており、マウス/タップのみで進める大多数のプレイヤーにも黄色いリングが常時表示されてしまっていた。`ChoiceOverlay` に `keyboardNavActive` フラグを追加し、`moveFocus`/`moveFocusInColumn`/`moveFocusInRow`（Tab/矢印キー駆動）が呼ばれて初めてリングを可視化するよう修正（マウスクリックはこのフラグに触れない、ブラウザネイティブの `:focus-visible` と同じ考え方）。一度キーボード操作をしたセッションでは、以後の `show()` でも直ちにリングが出る（キーボードユーザーと判定したら以後も維持する設計）。同じパターンで A/S/D/設定等の素の HTML `<button>`（`NovelPlayer.tsx` 等）にも Tailwind の `focus-visible:` バリアントを適用し、ブラウザ標準の `:focus` アウトライン（マウスクリックでも出て残り続ける）を置き換えた。**`TitleScreenOverlay` にも同型バグが残っていたが、#640 で同じ `keyboardNavActive` パターンを移植して修正した**（`moveFocus()` が呼ばれて初めてリングを可視化する、マウスクリックはフラグに触れない、という設計をそのまま踏襲。`TitleScreenOverlay` は「はじめから」「設定」「終了」が無効化されない仕様のため、`ChoiceOverlay` にあった「選択肢1件のみでの早期returnエッジケース」は理論上到達不能だが、将来の変更に備え同じ防御ロジックは実装してある）。
- `RpgMap` — RPG マップ（width, height, tile_size, tiles: u8[][]）
- `PlayerStart` — プレイヤー初期位置（x, y, direction）
- `Npc` — NPC 配置（id, name, x, y, color, message: string[], sprite?: string, frames?: u32, direction?: Direction）

フロントマターは Event ではなく、`Chapter` 構造体のフィールド（number, title, hidden, default_bgm）と `Document` ルートフィールド（engine, aspect_ratio, choice_style, font_family, font_size, dialog_style, protagonist, split_layout, sentence_per_page, pixel_art）としてパースされる。`Scene` も Event ではなくドキュメント構造の一部。

`Document.aspect_ratio` は画面比率（#136）。既定は `16:9`/`4:3`/`9:16` の固定 3 値で、`NovelPlayer` は選ばれた比率の論理解像度（`ASPECT_RATIOS`）を `NovelRenderer` construct 時の `screenWidth`/`screenHeight` に固定し、CSS（`gameBoxStyle` の `min(100cqw, ...)`/`min(100cqh, ...)`）でその比率の箱をレターボックス/ピラーボックスする。**`auto`（#442）は固定ロックしない fluid モード**: `NovelPlayer` はルート要素（常に `w-full h-full`＝実ビューポート追従のコンテナ）の実測サイズを `ResizeObserver` で監視し、`pickFluidAspectRatio`（横長・正方形→`16:9` / 縦長→`9:16`）で離散比率を選ぶ。向きカテゴリが変わった（横長⇄縦長）ときだけ `NovelRenderer` を丸ごと再マウントする（`fluidRemountKey` を mount effect の依存配列に含める）。同カテゴリ内の連続的なリサイズ（例: デスクトップでウィンドウ幅を少し変える）は既存の CSS スケーリングでそのまま吸収されるため、renderer 自身に新しい resize ハンドラは持ち込まない（`screenWidth`/`screenHeight` は construct 時に固定のまま・非 fluid の全ゲームと共通の設計を維持）。非 fluid（`16:9`/`4:3`/`9:16` を明示指定）では `fluidRemountKey` が常に `null` で不変なため、mount effect は従来どおり「マウント時に1度だけ生成」のまま＝完全非破壊。

**再マウント復元時の textIndex クランプ（#663）**: fluid 再マウントは旧 renderer の `getSnapshot()` を新 renderer に `restoreSnapshot()` で渡す（`applyState()` 経由）。novel の改頁（`getNovelPages`）はテキスト折り返し幅に依存するため、向きが変わって `gameWidth`/`gameHeight` が変わると同じイベントでもページ数が変わり得る。`render()` の `sentenceIndex` クランプ（#283、現ページ範囲外を防ぐ安全網）とは別に、`textIndex` 自体は検証なしでコピーされていたため、復元直後の `textIndex` が新レイアウトでのページ数を超えていると `advance()` の「同ページに続きがある/次ページがある」判定が両方偽になって次イベントへ素通りしてしまい、最悪 #470 の終劇フォールバックに到達して `ToBeContinued` が早期到来する事故があった。`applyState()` は復元直後に `currentPageCount()` で再計算したページ数へ `textIndex` をクランプする（超えていれば `pageCount - 1` の最後の有効ページへ）。これは復元パス限定の防御で、goBack/seekTo 等の通常復元では `textIndex` が既に有効範囲内なので no-op、`advance()` 自体の前進ロジックには影響しない。

`Document.choice_style` は per-game の選択肢ボタンスタイル名（#146）。`default` / `soft` / `monochrome` / `pixel` の 4 種を ChoiceOverlay が持ち、未指定なら `default` 扱い。スタイル文字列は parser 側ではバリデーションせず生文字列として透過し、runtime 側で未知値を `default` にフォールバックする。

既読進捗は `/play` の `projectName` を `docKey` として `localStorage` に保存する（#140/#366）。保存は origin 単位なので、同じ Name×Name origin で同じ `projectName` を開く複数の埋め込みは共有する。別 origin ではブラウザ仕様上共有されない。scene ジャンプ後のスキップ判定は `sceneId#displayIndex` の文字列キーを使う。従来の display index 既読しかない既存データは、最初に遭遇した scene の `sceneId#displayIndex` へ best-effort 移行し、以後は scene-aware key を正本にする。これにより複数 MD の別セルで同じ行番号が誤って既読扱いになることを避ける。選択肢は jump 先の `sceneId` が既読 scene セットに含まれる場合、ChoiceOverlay が既読用の色で描く。scene セットへの既読マークは本文の最初ではなく、scene の末尾（次の `Choice` に到達した時点、またはスクリプト末尾）で行う。

`Document.font_family` は per-game のテキストフォント（#147）。CSS の `font-family` 文字列を生で透過する。runtime 側（`NovelRenderer`）が `frontend/src/game/FontLoader.ts` の `ensureFontLoaded()` で `<link rel="stylesheet">` を Google Fonts CSS API に向けて注入し、ロード完了後に `DialogBox.setFontFamily()` を呼ぶ。Dialog / Narration の `font_family` は per-line 上書き（`[フォント: family]` ディレクティブで pending 注入）で、優先順位は `per-line override → per-game default → runtime default ('Noto Sans JP', sans-serif)`。

`Document.font_size` は per-game の本文フォントサイズ（px・#283 補遺）。parser は数値のみ受理し（空・非数値は None）、runtime（`NovelRenderer.setFontSize`）が未指定時に既定 `40` へフォールバックして即座に `DialogBox.setFontSize()` を呼ぶ（フォント lazy load を伴わないため遅延適用は不要）。これにより 16:9 ADV（既定 40）と 9:16 ノベル（例 26）を per-game で切り替える。per-line 上書きは無く、名札系は本文サイズに連動、バックログ・選択肢・メニューは連動しない（`font_family` と同スコープ）。

`Document.dialog_style` は per-game の会話描画スタイル（#283）。`adv`（下部 ADV 箱）/ `novel`（全画面ノベル）の対等 2 択で、parser はバリデーションせず生文字列で透過し、未指定・不明値は runtime が `adv` 描画にフォールバックする（正規デフォルトという扱いはしない）。`NovelPlayer` → `NovelRenderer.setDialogStyle()` で `DialogBox.setNovelMode()`（名札 OFF・全画面 borderless 描画を流用）に伝わり、`novel` のときだけ全画面スクリム表示と `paginateSentencesByLines` による文境界改頁が有効になる。送りは**文単位（息継ぎ単位、#292 Phase 1）**: クリックは句点等で割った文を 1 つずつ送り（`sentenceIndex` は GameState）、既出文は同ページに溜まり、文末の右に種別付きクリッカー（`▼`=同ページ次文 / `❯`=ページ最後＝改頁）が出る。`assets/images/ui/text-next-{1..4}.webp` と `assets/images/ui/page-turn-{1..4}.webp` がある作品では、文の続き送りとページ送りを 4 フレーム画像カーソルで表示し、画像が無い/読めない作品では従来グリフにフォールバックする（#320）。クリッカーの座標は `setNovelDialogProgressive()` で累積テキストを更新した時点と `setIndicatorVisible(true)` の直前に `positionIndicator()` で同期し、`indicatorBaseY` と実 `indicator.y` を同時更新する（#333）。これにより ticker の次フレーム待ちで旧 y 座標が一瞬見えることを防ぐ。さらに**本文中の単独行 `---` は手動改頁マーカー `Event::PageBreak`（#292 Phase 2）**で、自動改頁の上に乗る強制ページ境界になる（`---` で Dialog を分割するため、各 text イベントが独立にページ分割される `getNovelPages` の切れ目がそのまま境界になり、`paginateSentencesByLines` 自体は不変）。フロントマター区切りの `---` は先頭ブロックのみで別扱い。通常のセリフ用スクリム表示/非表示は 180ms で短くフェードし、ページ/イベント送りで半透明黒が瞬時にON/OFFして画面輝度が跳ねるのを避ける。表情変化・場面転換ではスクリムが自動退避する。改頁ページは派生（GameState には持たず再計算可能）。

`Document.protagonist` は per-game の質問役（主人公）の話者名（#286）。`dialog_style: novel` の立ち絵左右配置に使う。parser は生文字列で透過し（空は None）、`NovelPlayer` → `NovelRenderer.setProtagonist()` に流れる。`novel` でかつ protagonist 指定時、`showCharacterFromDialog` が Dialog の話者を役割に写す（`resolveNovelRoleXRatio`: 話者 = protagonist → 質問役＝左 `NOVEL_ROLE_X_RATIO.questioner=0.25` / それ以外 = 回答役＝右 `0.75`）。比率は `CharacterLayer.show(..., { xRatio })` の override 経路で sprite x に当て、position トークン（snapshot/復元の正本）は据え置く（縦位置は `CHARACTER_Y_RATIO`＝全員共通のベースライン。既定 1.0、frontmatter `character_y_ratio` で per-game 上書き可＝足を画面下端より下げ靴を切れる #308）。さらに直前と異なる話者になったら `CharacterLayer.nudgePose()` で立ち絵を軽く持ち上げて戻す自己復帰アニメをかけ（ticker 駆動・GameState 非保持の render-only 演出）、`#283` の scrim 自動退避に相乗りして「今この人」を見せる。場面冒頭の初出（`lastSpeaker===null`）・同一話者連続・スキップ中は nudge しない。adv / protagonist 未指定では左右配置・ポーズ変化とも一切起きない（従来配置・後方互換）。復元（`applyState`）でも protagonist 指定時は役割 x を当て直し、`lastSpeaker` を復元位置の話者に据えて誤 nudge を防ぐ。v1 では司会など3人目以降の定位置は未対応（非主人公＝右に倒す・TODO）。

`Document.split_layout` は per-game の画像/テキスト分割配置モード（#442、Gymnasia 向け）。`dialog_style`（adv/novel、テキスト送りの挙動）とは**独立の軸**で、`true` のとき画面を隙間なく左右（横長・正方形）/上下（縦長）に2分割し、キャラ画像とテキストウィンドウを別領域に収める。既存の「画像全面＋テキストオーバーレイ」ジオメトリの代わりとなる第三のモードで、adv/novel どちらの見た目（枠・名札の有無・DropShadow 等）にも一切触れない。判定・領域分割は純粋関数 `computeSplitLayoutRegions(screenWidth, screenHeight)`（`novelLayout.ts`）が担う：`screenWidth >= screenHeight`（横長 **or ちょうど正方形**）→ `'landscape'`（左半分＝画像・右半分＝テキスト）、それ以外 → `'portrait'`（上半分＝画像・下半分＝テキスト）。正方形は横長側に倒す規約で、fluid `aspect_ratio: auto` の `pickFluidAspectRatio`（上記）と同じ `>=` 境界に揃えている（揃っていないと「キャンバスの実形」と「領域分割」が矛盾する）。`NovelRenderer.setSplitLayout(enabled)` が `computeSplitLayoutRegions` の結果を `DialogBox.setSplitLayoutRegion(regions.text)` と `CharacterLayer.setSplitLayoutRegion(regions.character)` に配る（`ChoiceOverlay.setSplitLayoutRegion(regions.text)` も同様にテキスト領域へ収める・#442 self-review should-5）。`EventImageLayer.setSplitLayoutRegion(regions.character)`（#464）も CharacterLayer と同じ画像側領域を受け取り、イベント絵が画面全体に引き伸ばされずキャラ画像側パネルに収まるようにする。`DialogBox` 側は `boxX/Y/W/H` を渡された矩形（テキスト領域）に固定するだけ（novel の全画面ジオメトリ・adv の下部バーの代わり）。`CharacterLayer` 側は個々のキャラの位置計算（`positionX`/`characterY`/xRatio 等、すべて screenWidth/screenHeight 基準）を一切変えず、`Container` 全体（`this`）の `scale`/`position` に `computeCharacterLayerSplitTransform`（native 座標系全体を領域へ contain フィット）を適用して射影する（単一責務・変更範囲の最小化）。`screenWidth`/`screenHeight` は construct 時に固定（renderer 自身は resize を監視しない）なので、ウィンドウリサイズへの追従は実質的に `aspect_ratio: auto` の再マウント機構に依存する — Gymnasia は `aspect_ratio: auto` + `split_layout: true` を組み合わせて使う想定。未指定・`false` は従来どおり（既存ゲームは非破壊）。

**話者別2窓表示（#444）**: `split_layout: true` かつ `protagonist:` 指定時、テキスト領域をさらに相手（上窓）/ 自分（下窓）の2つに固定配置する「2窓モード」が有効になる。新規 frontmatter フィールドは追加せず、既存の `split_layout`/`protagonist` の組み合わせをこのモードの明示トリガーにする設計（`NovelRenderer.isDualWindowMode()`）。トリガーは `dialog_style`（adv/novel）を問わない — #305/#286（主人公色・左右配置）が novel 限定なのとは異なり、2窓モードは独立の軸。`applySplitLayout()` が `computeSplitLayoutRegions(...).text` を `splitTextRegionForDualWindow()`（`novelLayout.ts`）でさらに上下2等分し、`DialogBox.setDualWindowRegions({ opponent, self })` に渡す。話者判定は既存の protagonist 一致比較を流用（`resolveDualWindowIsSelf`: 話者 = protagonist、または話者不明(null) → 自分、protagonist と異なる明示的な話者名(NPC等) → 相手、#549）し、`render()`/`renderIntermissionTableau()` が `setDialog`/`setNovelDialogProgressive` の直前に `DialogBox.setDualWindowActiveRole('self'|'opponent')` でアクティブ窓を切り替える。非アクティブ側は直前発言を保持しない（チャットログ化しない）— アクティブ窓の boxY/H だけを都度切り替える 1 つの DialogBox インスタンスで実装しており、無枠・無名札のため「窓が存在するが空」と「窓が無い」は見た目上区別が付かない（2窓を同時に描画する必要がない設計）。本文色は `resolveBodyTextColor()` の最優先分岐で決まる: 自分（protagonist 一致・話者不明含む）＝白（`RESIDENT_TEXT_COLOR`）、相手（protagonist と異なる明示的な話者のみ）＝水色 `OPPONENT_TEXT_COLOR=0x9ad4e8`（TUI 版 gymnasia#39 準拠、#305 の暖アイボリーとは別配色、#549）。`DialogBox.effectiveBorderless()`（`this.borderless || dualWindowActive`）が背景ボックス（`drawBackground`）・名札（`nameBox`/`nameText`）・DropShadow の分岐をこの1箇所に集約し、2窓モード中は dialog_style に関わらず常に無枠・名札なしを強制する。テキスト送りの挙動（typewriter・改頁・インジケータ）は変更しない（adv/novel それぞれの既存ロジックがそのまま動く）。`aspect_ratio: auto` と組み合わせる場合、`pickFluidAspectRatio` の第3引数 `splitLayout` が `true` のとき、素の 16:9/9:16（400x450 の縦長半分になり正方形にならない）の代わりに `2:1`(900x450)/`1:2`(450x900) を選び、`computeSplitLayoutRegions` の 50/50 分割で画像・テキストとも 450x450 の正方形になるようにする。`protagonist` 未指定なら 2窓モードは発火せず、split_layout は従来どおり単一テキストウィンドウ（枠あり）のまま非破壊。`aspect_ratio` に `auto` 以外の固定値（`16:9`/`9:16`/`4:3` 等）を指定した場合も `split_layout: true` + `protagonist:` の組み合わせでテキスト2窓自体は機能するが（`computeSplitLayoutRegions` は screenWidth/screenHeight から求めるだけで aspect_ratio の識別子自体は見ない）、画像/テキスト領域は正方形にならない（例: `16:9`=800x450 では text 領域が 400x450 になり 2:1 のような 450x450 の正方形にならない）。これは #442 由来の既存挙動であり #444 のリグレッションではない。

`Document.sentence_per_page` は per-game の文単位厳密改頁モード（#448）。`dialog_style`（adv/novel、テキスト送りの挙動）とは**独立の軸**で、両方と併用できる。オーバーフロー防止の自動改頁は常時 ON・オフ不可（novel の `paginateSentencesByLines` は 1 文だけで `maxLinesPerPage` を超える場合その文単独で 1 ページにする安全策を持つ）。`sentence_per_page: true` はこの安全策を変更・迂回せず、その上に「1 ページに置ける文の数を常に 1 文に固定する」制約を重ねるだけで、adv/novel どちらの `dialog_style` でも 1 ページ＝厳密に 1 文になる。**novel** は `getNovelPages` が `paginateSentencesByLines` に `maxSentencesPerPage=1`（未指定時は `Infinity`＝無制限・後方互換）を渡す。改頁判定は行数キャップとの OR（`pageLines + lines > cap || pageSentences.length >= sentenceCap`）で、どちらが先に発火してもページ内容自体は変わらない。**adv** は従来の「Markdown 行単位で `text[]` をそのままページとする」動作をやめ、`NovelRenderer.getAdvSentencePages()` が Dialog/Narration の `text[]` を `splitIntoSentences`（`ruby.ts`）で文単位に再分割してページ化する。`>` 単独行由来の空文字要素（従来 adv の「間を置く」空白ポーズページ）はグループ区切りとして扱い、`>` で区切られた各グループを独立に文分割したうえでグループ間に空文字 1 ページを挟み直し、空白ポーズページを維持する。文境界判定はルビ記法を剥いだ plain text（`stripRubyMarkup`）に対して行う（`》` が文末トレーラの1つのため、ルビ記法混在のままだと誤吸収されうる）が、`DialogBox.setDialog` へ渡す表示テキストはルビ記法を保持する必要があるため（`setDialog` が自前で `parseRubyText` を呼ぶ設計）、`mapSentencesToRubyPreservedText` で plain 文境界をルビ込み原文へマッピングし直す。`NovelPlayer` → `NovelRenderer.setSentencePerPage()` の配線は `setDialogStyle`（`applyDialogStyle`）と同じパターンで、表示中に ON/OFF すると即座に新ページ構成で再描画する（EditorScreen のライブプレビューが frontmatter をライブバインドしているため、これが無いと次のクリックまで画面が古いページ構成のまま stale になる）。派生ページ（`novelPagesCache` / `advSentencePagesCache`）は GameState に持たず、eventIndex が変わるたびに破棄・再計算する。未指定・`false` は従来どおり（既存ゲームは非破壊）。

**1 位置 1 キャラ（衝突時の自動退場・#303）**: `CharacterLayer.show()` は立ち絵を置く先の `targetX`（xRatio override > position トークン > center で解決）を占有している**別の立ち絵を退場させてから**新キャラを置く（`evictCollidersAt(targetX, keepName, instant)`）。役割配置で複数キャラが同じ右（`responder=0.75`）に続けて出る avatar__kantia 型の重なりを、`[退場:]` を明示せず解消する。除外対象は「自分自身（`keepName`＝同一キャラの再表示・位置変更）」「`renderOnly`（Title/Label/Image #274＝立ち絵スロットを占有しない演出要素）」「既に退場フェード中（`destroyOnComplete`）」。退場は通常 300ms フェード、`instant`（skip/復元）では即時。GameState には中間状態を持ち込まず、`getCharacterStates()` は**退場フェード中のキャラを除外**するため、衝突退場の途中で撮ったスナップショットからも前キャラが漏れず、セーブ/シーク/任意局面起動の復元で重なり・消えすぎが起きない。判定は別位置（左の質問役）には届かない（x 不一致）ので干渉しない。adv の position トークン経路（左/中央/右）でも同 x なら退場する（多人数を別位置に置く既存作品は x が異なるため非回帰）。

**立ち絵のスケール（原寸 / 元絵基準スケール / 目標高さ / per-character override / フィット・#360 #364 #294 #378）**: 立ち絵（`CharacterLayer.show()`）の表示スケールは `loadTexture` で5段の優先順位で決まる。①話者行に `フィット`/`fit` を書いた立ち絵は `computeFitScale`（論理画面より大きいときだけ画面全体に収める・#294）②per-game frontmatter `character_scale`（元絵基準の一律スケール・#378）が指定されていれば `sprite.scale = character_scale` をそのまま適用する（**元絵基準：表示px = character_scale × textureHeight**）③per-character frontmatter `character_height_ratios`（キャラごとの目標高さ override マップ・#364）に該当キャラがあれば、その値で `computeTargetHeightScale(textureHeight, ratio, screenHeight) = (ratio×screenHeight)/textureHeight` を適用して uniform スケール（幅はアスペクト比で追従）④マップに該当キャラが無ければ per-game frontmatter `character_height_ratio`（スクリプト単位デフォルト・#360）があれば同じ式で適用⑤どちらも無ければ原寸 `scale=1`（後方互換）。③④は**画面基準**で、`character_height_ratio(s)` の式が元絵の縦px（textureHeight）を割り消すため**元画像の解像度に依らず画面上の高さを一定**にする（立ち絵を高解像度で描き直しても大きさは不変で鮮明さだけ上がる／2倍リサイズした立ち絵が原寸だと画面をはみ出す問題への対処）が、**その代償として元絵に焼き込んだ身長差も潰れる**。対して②`character_scale` は**元絵基準**（textureHeight を割り消さない）で、**元絵に焼き込んだ身長差をそのまま画面に出す**（＝元絵解像度に依存する）。身長差を絵に描き込んだキャストを素材そのままの比率で並べたいときに②を使う。②は `clampCharacterScale(scale)`（`CharacterLayer.ts` の export 純関数）で `[0.05, 4]` にクランプし、非有限・非正は未設定扱い（下位優先順位へフォールバック）。③④の優先順位判定（マップ override があればそれ、無ければスクリプト単位デフォルト）は `resolveCharacterHeightRatio(characterName, ratios, defaultRatio)`（`CharacterLayer.ts` の export 純関数）に切り出している。`ratios[characterName]` を素朴なブラケットアクセスすると prototype chain 経由でキャラ名が `constructor` 等と一致したときに関数オブジェクトを返してしまうため、共通ヘルパー `hasOwn()`（`ownProperty.ts`・#368 で全箇所を統一）で own-property のみを見て判定する。数式は `computeFitScale` / `computeTargetHeightScale` / `clampCharacterScale`（いずれも `CharacterLayer.ts` の export 純関数・非有限/非正入力はフォールバック）へ切り出してテストする（doctrine 規律4）。`character_scale` / `character_height_ratio` / `character_height_ratios` は演出中間状態でなく per-game 表示設定なので GameState には持たず、`NovelPlayer` → `NovelRenderer.setCharacterScale()`/`setCharacterHeightRatios()` → `CharacterLayer` に流す（既存の `setCharacterHeightRatio`（#360）・`character_y_ratio`（#308）と対称の配線）。`character_scale` を後から変えても表示中の静的立ち絵に即再適用される（`reapplyCharacterHeightRatios` が①fit を除き②〜⑤の優先順位でライブ再スケール）。render-only（Title/Label/Image #274）は `loadTexture` を通らず自前 sizing のため非対象。

**主人公の本文色（#305）**: `dialog_style: novel` かつ `protagonist` 指定の作品（実質 theo のみ）で、主人公セリフの本文だけやや暖かいアイボリー `#FFF0D8`、住人は純白。`NovelRenderer.resolveBodyTextColor(speaker)`（novel かつ話者 = protagonist のときだけ `protagonistTextColor`、それ以外・adv・protagonist 未指定・話者 null は `RESIDENT_TEXT_COLOR=0xffffff`）で**話者から決定論的に導出**し、`render()` の都度 `DialogBox.setBodyTextColor()` に渡す。DialogBox 側は `bodyTextColor`（既定白）を `dialogText.style.fill` と表示中ルビの fill（`makeRubyTextStyle()` に集約・#307）に当てる。主人公色は**固定で `#FFF0D8`**: parser は色を解析せず `NovelPlayer` も渡さないため、**frontmatter での色上書きは未実装**（本番経路は常に既定 #FFF0D8）。`NovelRenderer.protagonistTextColor` フィールド（既定 #FFF0D8）と `setProtagonistTextColor()` はテスト・将来拡張用の内部フックとして残す（呼ばなければ既定が効く）。per-line の描画属性であり演出中間状態ではないため GameState には持たず、復元時も render で再導出される。adv / protagonist 未指定では全員白＝後方互換。

**立ち絵とテキストの表示順序の同期（#293）**: テキスト reveal（`render()` → `DialogBox` typewriter）は同期開始するのに対し、立ち絵は `CharacterLayer.show()` が `Assets.load` で**非同期に**テクスチャ取得するため、呼び出し順が立ち絵先でも見た目は「文字が出てから立ち絵が遅れて出る」順序逆転になっていた。これを `CharacterLayer.show(..., { onReady })`（テクスチャ load 完了／texture 不要な早期 return／load 失敗いずれでも**必ず1回**発火）と `NovelRenderer.showCharacterThenRender(afterShow)` で解決する: forward（前進）3 経路（`resetAndStartEvents` 場面冒頭・`advance` 話者/イベント交代・`[待機]` 明け）で立ち絵 sprite を同期生成しスナップショットを撮った後、**novel スタイルではテクスチャ用意完了まで `render()`（テキスト reveal）を遅延**して「立ち絵 →（同時/直後に）テキスト」を保証する。adv / skip（instant 表示でラグ無し）/ 立ち絵なし Dialog は同期描画＝従来どおり（非回帰）。順序保証は描画駆動のローカルなトークン照合（`eventIndex` 一致）で行い、保留中に別イベントへ進んだ場合は stale な onReady では描画しない（連続クリック耐性）。演出中間状態は GameState に持ち込まない（ADR 0002）。復元（`applyState`）経路は instant 表示でラグが無いため従来どおり同期 `render()`。

**登場フェードインも texture-ready ゲートに揃える（#17）**: 新規立ち絵の入場フェード（alpha 0→1）は、テクスチャ load 完了後に開始する。退場衝突がある経路（`evictCollidersAt` のコールバック）は元から texture-ready を待っていたが、**退場対象がいない（`colliderCount===0`）新規立ち絵は texture を待たず即フェードを開始していた**ため、初回コールドキャッシュで texture load が fade（立ち絵の登場フェードは `character_fade_ms`・エンジン既定 `DEFAULT_FADE_MS`=700ms〔#407 で 300→700〕）より遅いと、alpha が 1 に達し切ってから絵が現れ「フェードが見えず突然出る」不具合になっていた（例: ハブに居らず本編入口で初出の司会ヴィンチア＝衝突が無いためこの経路を踏む）。`colliderCount===0` でも `startEntrance`（texture-ready ゲート）を通すよう揃えて解消する。`instant`（skip / `applyState` 復元）は従来どおり即時表示（フェード無し）。**同じ原則を Label/Image（`showLabel`/`showImage` #274）にも適用（#427）**: フォント確定（`ensureFontLoaded`）／画像 load（`Assets.load`）完了後の `.then()` で登場フェードを開始し、instant 時は張らない。この `.then()` 内ガードは当初 `label.destroyed`/`sprite.destroyed` のみだったが、`remove()`（非 instant）は即時破棄せず `startFade` で `{ toAlpha: 0, destroyOnComplete: true }`（退場フェード予約）を張るだけで実破棄は ticker 完了時まで遅延するため、その「予約済みだが未破棄」の窓に load/font が解決すると `destroyed` ガードを素通りして退場フェードを登場フェードで上書きしてしまい、`remove()` による退場が取り消される不具合があった。共通ヘルパー `startEntranceFade(state, instant)` に `state.fadeAnimation?.destroyOnComplete` なら何もしないガードを追加して解消する（showLabel/showImage 両方が使う。フェード設定コードの重複解消も兼ねる）。ただし showLabel/showImage の `existing`（同 id 再表示）分岐はこの退場フェード予約中の対象でも position/text 更新のみで return し、進行中の退場フェードをそのまま完走・破棄させていた。show() の「退場アニメ中の同名キャラを再 show するとフェードアウトを取り消してフェードインに切り替える」規約（#177）と非対称だったため、`existing` 分岐冒頭に同じキャンセル/反転処理を追加し、`instant`／`characterFadeMs<=0` なら即 `alpha=1`、それ以外は `startFade(existing, existing.sprite.alpha, 1, false)` で現在の alpha からフェードインに切り替えるよう揃えた（#429）。ただしこの反転処理自体が `.then()` 内の `startEntranceFade` と競合するレースを新たに生んでいた（#429 re-review）: 初回 `showLabel`/`showImage` の `ensureFontLoaded`/`Assets.load` が pending のまま、`remove()`（退場フェード予約 `destroyOnComplete:true`）→ 同 id 再表示（上記の反転処理で `destroyOnComplete:false` の復活フェードに差し替え）→ ticker で復活フェードが中間 alpha まで進行、という順で events が来ると、最後に pending だった `.then()` が解決して `startEntranceFade` を呼ぶ。当時のガードは `state.fadeAnimation?.destroyOnComplete` のみを見ていたため、`destroyOnComplete:false` の復活フェードは素通りしてしまい、進行中だったそれを `{ fromAlpha: 0, toAlpha: 1 }` の新規入場フェードで丸ごと上書きして alpha が瞬間的に巻き戻っていた。ガードを `state.fadeAnimation` の有無（destroyOnComplete に限定しない）に広げ、どちらの経路が先に fadeAnimation を張っていても後から来た入場フェード初期化を無視するようにして解消した。ただしこの拡張は**非 instant 復活**（`startFade` が新しい `fadeAnimation` オブジェクトを張る経路）のケースに限られており、**instant 復活**（`reviveFromExitFade` の instant 分岐、`sprite.alpha=1` にした直後 `fadeAnimation=null` に戻す経路）は解消できていなかった（#429 2巡目 re-review）。instant 復活は「捕捉時点（`remove()` 予約直後）」も「復活後」も `fadeAnimation` が null のままなので、`fadeAnimation` の有無だけを見るガードでは「捕捉後に復活が起きたか」を区別できず、pending だった `.then()` が素通りして `{ fromAlpha: 0, toAlpha: 1 }` の新規入場フェードを張ってしまい、alpha が 1→0 付近まで瞬間的に巻き戻ってから再度フェードインし直していた（`showImage` の `Assets.load` 版でも同型で再現）。`reviveFromExitFade` が実際に復活処理をするたびに `CharacterState.reviveGeneration` を +1 する世代カウンタを追加し、showLabel/showImage が state 新規作成直後（＝まだ一度も復活していない時点）の世代を `expectedGeneration` として捕捉、`startEntranceFade(state, instant, expectedGeneration)` 側で現在の世代と比較し不一致（＝捕捉後に復活が起きていた）なら入場フェード初期化を無視するよう修正して解消した。`fadeAnimation` の有無ではなく「捕捉後に復活処理を経たか」を世代カウンタで直接判定するため、instant/非 instant いずれの復活後も、pending だった古い `.then()` が復活後の状態を巻き戻すことはない。

**立ち絵・背景の先読みと瞬断リトライ（#389）**: #293/#17 は「立ち絵・背景を表示の瞬間に初めて `Assets.load` する遅延ロードで、初出は必ずコールドロード（ネット取得）になり、遅延・瞬断すると #293 のフォールバック（ロード成否に関わらず onReady 発火）で『立ち絵なし・テキストあり』に倒れる」問題への表示順序側の対処だった。#389 はその根治として、コールドロードそのものを先読みで温め、失敗時に 1 回リトライする。**先読み `preloadUpcomingAssets()`**: `processUntilNextTextEvent()` の末尾（forward の全経路 advance / setScenes / jumpToScene が通る単一トリガー）で、現在の `eventIndex`（今表示するテキストイベントを含む）から `resolvedEvents` を前方走査し、**次の分岐（`Choice` / `Condition`）または配列末尾まで**の `Dialog` / `ExpressionChange` 立ち絵（`resolveCharacterImageUrls`＝webp/png 候補）と `Background` 背景（`resolveAssetUrl`）と `EventImage` イベント絵・`Image` 単独画像（`[画像:]`, #274 renderOnly）（いずれも `resolveAssetUrl`、`.path` のみを見て `back`/`transition`/`shape`/`id` 等の付随フィールドには依存しない）の URL を `backgroundPreload`（`backgroundPreload.ts`、#782）に積んで事前に温める（#621: 当初 `EventImage`/`Image` は先読み対象外だったが、イベント絵切替時に初回ダウンロード遅延が体感される不具合の根本原因と判明し対象へ追加した。`EventImageExit` は画像パスを持たないため対象外のまま）。`Dialog` の立ち絵は実表示ガード（`showCharacterFromDialog`: `expression`/`position`/`character` が全て truthy）に揃え、空文字・position 欠落は積まない。分岐に当たったら止めるのは、分岐先が確定するまで先読み対象を決められないため。**先読み予算の撤廃（#417）**: 当初は `getTextEvent` 非 null のテキストイベント数を `PRELOAD_MAX_TEXT_EVENTS`=8 で打ち切る保険を入れていたが、theo-hayamiの実スクリプトを実測すると1話（`free/`）あたり平均13.9件・最大19件で旧上限8を上回っており、分岐前に先読みが途中で打ち切られる不具合になっていた。`PRELOAD_MAX_TEXT_EVENTS` を `Infinity` にして撤廃し、先読みの実質的な境界は「次の分岐（Choice/Condition）または配列末尾まで」だけになった。現時点でtheo-hayami以外に実運用中のゲームは無いため撤廃の影響範囲は限定的だが、将来「分岐なしで極端に長い区間」を持つゲームが出た場合は個別に再検討する。**重複除去は2段（#417）**: まずスキャン内で `seen` Set により重複URLを除去する（同じキャラの表情が Dialog→ExpressionChange で連続する、同じ表情が複数回登場する等で同一URLがスキャン内に複数回集まり得る。初出＝最も近い方を残し後続の重複を落とすことで近い順の並びは保持する。以前は `preloadedUrls`（呼び出しまたぎの重複除去）しか無く、スキャン内の重複はそのまま push されていた）。その上で `preloadedUrls` Set で呼び出しまたぎの重複を除去する（イベント列を差し替える `resetAndStartEvents` でクリアし、新しいイベント列では先読み状態も作り直す）。`assetBaseUrl` 空なら no-op。走査は同期・実ダウンロードは `backgroundPreload(...)` に投げっぱなし（await せず本編を待たせない）。選択肢送り・シーンジャンプ直後は分岐先が確定するまで先読みできず構造的にコールドのままだが、確定後の分岐内の後続アセットは先読みで温まる。#293 の順序保証とは独立で後方互換（先読み未完でも従来どおりテキストは詰まらない）。**LIFO pop 消化順の逆転（#414）**: 先読みは `_maxConcurrent=1` 相当の直列で、積まれた配列を末尾から `Array.pop()`（LIFO）して1件ずつ読む。近い順（nearest→farthest）に組み立てた配列をそのまま渡すと最も遠いアセットが先に読まれ、直後に必要な立ち絵が後回しになるため、`backgroundPreload()` に渡す直前に配列を `reverse()` して末尾＝nearest が最初に読まれるようにする。消化順は自前の `backgroundPreload` が保証するので PixiJS の内部実装には依存しない。**`Assets.backgroundLoad` を使わない理由（#782）**: `backgroundLoad` はキューに積むだけで resolve し、実ダウンロードは内部 `BackgroundLoader._next()` が `void` で投げっぱなしにするため、先読み 1 件の 404（webp→png 候補の片側欠落で日常的に起きる）が unhandled rejection（pageerror）になり、`_isLoading` が true のまま残って以降の先読みも止まる。呼び出し側の `.catch` ではキュー追加の失敗しか拾えず防げない。さらに pixi の `Assets._mapLoadToResolve`（Assets.mjs）は前景 load 中に `_backgroundLoader.active=false` にし、失敗時に true へ戻さないため、旧コードでは表示経路の初回 webp 404 以降、先読みが恒久停止していた（置き換えで先読みが最後まで走るようになり、先行リクエストが増える）。そこで自前の `backgroundPreload`（LIFO・並列度 1 を踏襲し、1 件ずつ `Assets.load` して失敗は握り潰して次へ。先読みで失敗した URL は再先読みしない）に置き換えた。失敗した URL は表示時の `Assets.load`（候補フォールバック・全滅時 warn）が改めて扱う。シーン入場（`resetAndStartEvents`）では `clearBackgroundPreloadQueue()` で未消化キューだけを、文書差し替え（`loadEvents`）と `destroy` では `clearBackgroundPreload()` でキューと失敗記録を捨てる（エディタで画像追加後は再試行させるため）。**瞬断リトライ `loadFirstAvailableTexture()`**: URL 候補（webp→png）が一巡全滅したら `LOAD_RETRY_DELAY_MS`=300ms 待って**1 回だけ**もう一巡リトライ（計 2 巡）してから reject する。PixiJS v8 の Loader は失敗 URL を `promiseCache` から削除する（キャッシュ済み reject を残さない）ため同一 URL のリトライも実際に再取得を試みる＝ネット回復にも別 URL 候補にも効く。#293 とは両立（失敗が確定すれば従来どおり onReady が 1 回発火してテキスト解禁。リトライぶん確定が遅れるだけで詰まらせない）。

**ページ送りインジケータ画像の先読みは別系統（#413）**: 上記の `preloadUpcomingAssets`（立ち絵・背景、シーン進行に連動）とは独立に、`text-next-{1..4}.webp` / `page-turn-{1..4}.webp`（計8枚）専用の先読みがある。トリガーは `NovelPlayer` mount 時に `assetBaseUrl` が判明した瞬間（`renderer.init()` の完了を待たない）で、`getIndicatorImageUrls(baseUrl, kind)`（`novelLayout.ts`）で組み立てた URL を `Assets.backgroundLoad` ではなく `Assets.load` に直接投げっぱなしにする（`Promise.all(...).catch(() => {})`）。全シーン・全キャラ共通の UI 素材でシーン進行と無関係なため、`preloadUpcomingAssets` の走査ロジックに乗せる意味がなく、mount 時に1回だけ先読みすれば足りる。`DialogBox` 側は fetch 中の kind を `pendingIndicatorKinds`（Set）で追跡し、`applyIndicatorFrame()` は結果が確定する（成功でフレーム画像が揃う／失敗で諦める）までは ▼ グリフも画像 sprite も表示しない。フォールバックの ▼ を出すのは fetch を試みていない、または確定失敗した場合のみで、これにより先読みが間に合わず ▼ が一瞬見えてから画像に差し替わるちらつきを解消している（#413 M1: `DialogBox.setIndicatorKind` は既定値 `'next'` と一致する呼び出しでも `applyIndicatorFrame()` を呼び、pending 状態を glyph/sprite の可視状態へ反映する）。`setIndicatorAssetBaseUrl` 自体も `loadIndicatorFrames` 呼び出し直後に `applyIndicatorFrame()` を呼ぶ（baseUrl 切替時に旧 baseUrl のスプライトが残存表示されるのを防ぐ対策）。この呼び出しは `setIndicatorKind` を経由しないため、adv モード（`novelMode=false`、`setIndicatorKind` を一度も呼ばない設計）でも pending 反映が働き、ちらつきの解消は novel/adv 両モードに及ぶ。

### ルビ（青空文庫記法）(#148)

子供向け動画用途で漢字に読み仮名を振る機能。parser はスキーマを拡張せず、Dialog / Narration の `text` に `漢字《かんじ》` / `｜美少女《びしょうじょ》` といった記法を生 markdown のまま保持する。frontend が描画直前に `frontend/src/game/ruby.ts` の `parseRubyText()` で `RubyRun[]`（base + ruby? のラン列）に分解し、`frontend/src/game/rubyLayout.ts` の `computeRubyPlacements()` で wordwrap 行配列に対する配置（lineIndex / charStartInLine / charEndInLine / revealAt）を pure に算出する。

`DialogBox` の描画パス:

1. raw text を `parseRubyText` で runs に分解
2. `stripRubyMarkup` で plain text を作り、既存 `wordwrap` で行配列を得る。`wordwrap` は Canvas の
   `measureText` を使う公開 API だが、中核は `wrapTextWithMeasure` に分離されており、行頭禁止文字を
   前行へ押し込んだ後に後続文字まで超過行へ連鎖させない禁則境界を単体テストで固定している（#400）。
3. `computeRubyPlacements` で各ルビの (line, x 範囲, typewriter 上の reveal タイミング) を算出
4. `dialogText` に joined plain text を流し、typewriter ticker で 1 文字ずつ表示
5. `rubyContainer` に各ルビ用の小さい `Text` を予め非表示で配置し、`displayedCharCount` が `revealAt` を超えたタイミングで `visible = true` に切り替え

これにより既存 `typewriter` モジュールには手を入れず、ルビ表示は別レイヤとして加算される。ルビ仕様の詳細は `docs/spec/markdown-v0.1.md` の「ルビ（漢字読み仮名）」を参照。

### 双方向変換

- `parse(markdown) → Event[]` — Markdown テキストを Event 配列に変換
- `emit(events) → markdown` — Event 配列を Markdown テキストに復元

ラウンドトリップテスト（parse → emit → parse で同一結果）により整合性を保証する。

### 本文の表示用正準化 (#340)

`parse` の最後に `canonicalize_events`（`parser/src/canonicalize.rs`）を全シーンの Event へ掛け、**読ませる表示テキストの一部記号を上下中央に出る字形へ正準化**する。中央字形（`─`=U+2500 / `⋯`=U+22EF）は見栄えで採用しているが普段打つのが大変なので、**原稿は打ちやすい `--` / `…` で書き、読み込み時に中央字へ正準化する**。

- `--`（ASCII ハイフンちょうど 2 連）→ `──`（U+2500 × 2、余韻横棒）。単独 `-`・語中/URL のハイフン・`---`（3 連以上＝水平線 / 見出し下線 / フロントマター区切り / 手動改頁 `PageBreak`）は不変。
- `…`（U+2026、個数保持）→ `⋯`（U+22EF、言いよどみ）。
- **対象は読ませる表示テキスト全部**: `Dialog.text` / `Narration.text` / `Choice.options[].text` / `TitleShow.text` / `Label.text`、および **RpgEvent（`[イベント]`）内の会話** `EventCommand::Dialog.text` / `EventCommand::Narration.text`（RPG モードで DialogBox に描画される本文。`canonicalize_commands` ヘルパで適用）。**対象外**: RpgEvent 内 `Dialog.character`（話者名）・`NpcData.message`（NPC に話しかけた台詞・kako-jun が明示的に対象外と決定）・RPG マスタ名（Monster / Item / Spell / PartyMember の name・`NpcData.name`）・frontmatter・`##` 見出し（scene.title）・ディレクティブ引数・アセットパス・ID・話者名（`canonicalize_events` / `canonicalize_commands` の match が分岐を持たず素通しする＝マスタ / ドメイン分離）。
- **冪等**（二重適用しても不変。既存の `──` / `⋯` コーパスも不変）。
- **emit は本文を verbatim で書き出す**ため、正準化後の `──` / `⋯` はそのまま保存され原稿 `--` / `…` には戻らない。初回保存で中央字形が原稿へ焼き込まれ、以降の parse → emit は正規形で安定する。
- **2 層構成（#308 の二段罠対策）**: Rust パーサが正本だが、wasm が古い / IndexedDB キャッシュ経由でも素の記号を出さないよう、フロント側 `frontend/src/wasm/parser.ts` の `normalizeEvents` でも `canonicalizeBodyText`（`frontend/src/game/textCanonical.ts`、Rust と同一挙動）を掛ける。parse 済み EventDocument キャッシュは `PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION` を 1→2 に上げて旧解析結果を無効化する。
- 余韻横棒 `──`（原稿 `--`）は **novel の文送り境界**にもなる（`frontend/src/game/novelLayout.ts` の `splitIntoSentences`）。`──` は前の表示単位（文）に含め、隣接する `。──` / `──。` は 1 停止にまとめる。`⋯`（言いよどみ）と `、` は境界にしない。`。` / `？` / `！` の既存境界（#292 Phase 1）は維持。

## 状態管理: NovelGameState

ノベルプレイヤーはスナップショット方式で状態を管理する。
設計思想の詳細は [ADR 0002: 決定論的状態管理とデバッグ可能性](./adr/0002-deterministic-state-and-debuggability.md) を参照。

### NovelGameState の構成

```typescript
interface NovelGameState {
  sceneId: string | null; // 現在のシーンID
  eventIndex: number; // 現在のイベントインデックス
  textIndex: number; // 現在のテキスト行インデックス
  flags: Record<string, FlagValue>; // フラグ状態
  backgroundPath: string | null; // 表示中の背景
  backgroundColor: string | null; // 単色の地色（#273。背景画像の下に敷く。復元対象）
  backgroundBrightness: number | null; // 背景の明るさ 0.0〜1.0（同一画像をシーン毎に減光。sprite.tint 乗算。null=原画。復元対象）
  eventImage: EventImageState | null; // イベント絵レイヤー（#351）。{path, back: 'Hide'|'Keep', effects?: AmbientEffects}。effects は#582アンビエント演出フラグ、全false時はキー省略。テキストより背面・全背面レイヤー（背景・背景板・動画・立ち絵・大道具）より前面の画面ぴったり単一スロット画像。null=非表示
  isBlackout: boolean; // 暗転中か
  characters: Array<{ name: string; expression: string; position: string }>; // 立ち絵のみ。タイトル/ラベル/画像は演出表示(renderOnly)で除外(#274)
  currentBgmPath: string | null; // 再生中のBGM
  storyEnded: boolean; // 終劇状態（#386）。confinement（在圏）外への choice ジャンプで true になる宣言的フラグ。演出の中間状態ではない
  entryFlags?: Record<string, FlagValue>; // このシーン訪問に入った瞬間の flags（#799）。[条件:] の入場時評価の入力。元列に [条件:] を含むときだけ。無い旧セーブは保存位置を含むトップレベル要素までを flags で静的に、後ろを逐次に展開して復元
  entryScanFlags?: Record<string, FlagValue>; // 旧セーブから復元した訪問だけ。逐次評価の走査開始 flags（保存位置を含む要素の残りの [フラグ:] を適用したもの）。無ければ entryFlags
  entryRawIndex?: number; // 線形ストリームの途中のシーンから始めた訪問の、元列での開始位置（#799。非0のときだけ）
}
```

### スナップショット方式の利点

1. **巻き戻し**: 履歴スタックから前のスナップショットを取り出すだけ
2. **シーク**: 先頭からリプレイせず、対象位置のスナップショットを直接復元
3. **セーブ/ロード**: スナップショットをそのまま JSON 化して保存・復元
4. **宣言的復元**: `applyState(snapshot)` で画面を完全に再構築

背景クロスフェード (#319) は立ち絵フェードと同じ render-only 演出で、`NovelGameState` には中間 alpha を持たない。`BackgroundController`（#828 7a で `NovelRenderer` から分離）が背景 sprite/mask を entry として管理し、通常進行の `[背景:]` では旧 entry を fade-out、新 entry を fade-in する。フェード時間はフロントマター `background_fade_ms`（未指定は既定 `BACKGROUND_CROSSFADE_MS`=700ms・#407）を `NovelRenderer.setBackgroundFadeMs` で受け、クロスフェード・終劇のフェードアウト・BGM 停止フェードすべてに適用する（`character_fade_ms` と対称の per-game 設定）。fade-out 完了時に旧 sprite と端フェード mask を破棄する。`dialog_style: novel` の forward 経路では、背景フェード完了を待ってから立ち絵 show / settle を待ち、その後に本文 `render()` を呼ぶため、「背景 → 立ち絵 → 本文」の舞台進行になる。物語/シーンの最初の背景（直前に背景が無いコールドスタート＝`processDirective` 経由の前進再生）も、旧 entry が空のまま新 entry を alpha 0→1 でフェードインさせる（ステージ最背面 `bgGraphics` の下地ベタ既定色 — フロントマター `background_color`（#409）を `NovelRenderer.setDefaultBackgroundColor` で受け、未指定は黒 `0x000000` — の上から浮かび上がるので黒フラッシュにはならない）。この下地ベタ既定色は `[背景色:]`（#273）のシーン上書きが無いとき（`currentBackgroundColor === null`）の実塗り色で、`clearBackgroundColor`（`[背景色]` 解除・終劇）の戻り先でもある。即時置換は `applyState`（`opts.instant:true` を明示＝seek / save load / 任意局面復元）と skip・同一 path だけで、任意局面復元で不要なフェードを再生しない。

イベント絵レイヤー (`EventImageLayer.ts`・#351) はテキストより背面・全背面レイヤー（背景・背景板・動画・立ち絵・大道具）より前面に出る単一スロット画像で、`VideoLayer` と同じ単一スロット意味論を踏襲する。独自の位置/スケール指定は持たず常に cover-fit で覆うが、覆う矩形は `split_layout: true`（#464）で `setSplitLayoutRegion` に領域が設定されていれば `CharacterLayer` と同じ画像側領域（テキスト領域には重ねない）、未設定（従来どおり）なら画面全体になる。`NovelGameState.eventImage`（`{path, back}`）は settled state のみを持ち（フェード時間は一度きりの演出パラメータなので含まない・ADR-0002）、フェード開始は必ずテクスチャロード完了後（`Assets.load().then()` 内）に行う（#427/#428 と同じ「未ロードのままフェード開始してしまう」事故の回避策）。フェード時間は frontmatter `event_image_fade_ms`（未指定は 700ms）を `NovelRenderer.setEventImageFadeMs` で受け、個別 `フェード=` がある場合だけそちらを優先する。`back` 値による全背面レイヤーの可視性トグルは `NovelRenderer.applyEventImageVisibility()`（`ScreenEffectsController.setBlackout` と同じ単一の宣言的セッター）が担い、`processDirective`（ライブ進行）と `applyState`（goBack/seekTo/セーブ復元）の両方から呼ばれる。`back=Hide`（既定）は最終的に全背面レイヤーを隠すが、ロード前・フェードイン中は背面を残し、イベント絵が完全表示された後に隠すことで暗転フラッシュを避ける。`back=Keep` は全背面レイヤーを表示したまま前面にイベント絵だけを重ねる。シーン遷移・レイヤー破棄時にはイベント絵を明示的に `remove()` して全背面レイヤーの可視性を戻す（作者が `[イベント絵終了]` を書き忘れても全背面レイヤーが隠れたまま持ち越されない防御）。終劇時だけは順序が異なり、`endStory()` が `ScreenEffectsController.startEndStoryBlackoutFade` で effectOverlay の黒フェードをイベント絵より上で開始し、黒で覆い切った後に eventImageLayer を `remove()` して全背面レイヤーの可視性を戻す。これにより終端イベント絵から終劇へ進む場面で、元の全背面レイヤーが一瞬戻らない。`hasPendingVisualTransition()`（`[待機: 表示完了]` の集約点）にもロード/フェードの pending 判定を OR で加える。可視性の実際の判定は `EventImageLayer.shouldHideBackLayer()` に委ねる: `getState()`（settled state・ADR-0002・作者の意図として path/back を load 成否に関わらず保持し続ける）とは別に、ロードが恒久的に失敗した世代では false を返し、覆う画像が無いのに全背面レイヤーが隠れっぱなしになる事故を防ぐ（`EventImageShowOptions.onSettled` コールバックで load 成功/失敗の両方から再計算をトリガーする。CharacterLayer の #293 `onReady` と同じ「成否に関わらず一度だけ発火」の流儀）。画像テクスチャは `EventImageLayer.disposeTextures()` で `NovelRenderer.textureCache`（背景）と同じタイミング（`setEvents()` / `destroy()`）に PixiJS の `Assets.unload` で解放し、GPU テクスチャのリークを防ぐ。アンビエント演出（ゆらぎ/ビネット/グロー/ろうそく揺れ、#582）は `sprite`/`glowSprite` を包む `imageGroup`（`this` の子、scrollHintText は含まない）にフィルタチェーンとして適用する。詳細（技法・パラメータ・TUI版の対応する RGBA ピクセル変換）は `docs/spec/markdown-v0.1.md`「アンビエント演出」節参照。

`fullscreen_image: true`（#530）はイベント絵側のもう一つのレイアウトモードで、`split_layout`（領域を分けてクロップして覆う）とは逆に「クロップせずキャンバス全幅で見せる」ことを優先する。`EventImageLayer.setFullscreenMode(true)` で有効化すると、以後の `show()` は `splitLayoutRegion` を無視し `computeFullscreenImageFit`（`novelLayout.ts`、常に横幅いっぱいで contain）で sprite の幅/高さ/x を決め、y=0 起点で表示する。画像の高さがキャンバス高さを超える場合は追加の縮小をせず、`handleWheel`（マウスホイール、`clampFullscreenImageScrollY` でクランプ）による縦スクロールで見せる。`computeFullscreenImageFit().scrollable` が true（＝縦スクロールが必要）のときは、画面下端中央に固定スタイルの小さなヒントテキスト（`EventImageLayer.scrollHintText`、「↓ スクロールできます」）を表示する（#547 must1。ゲームごとの本文フォント設定とは独立の固定スタイル）。`NovelRenderer` はイベント絵表示処理（`directives/stageDirectives.ts` の `EventImage` ハンドラ。旧 `processDirective` の分岐）で `this.fullscreenImage` が true のときだけ `DialogBox.hide()`/`ChoiceOverlay.hide()` を呼びテキストウィンドウを隠す（次の Dialog/Narration/Choice 表示で通常どおり復帰する可逆トグル）。

**TUI版との関係（#547 should3・誤解注意、#628 フェーズ3で更新）**: TUI版には `fullscreen_image` という語が出てくる機構が2つあり、どちらも GUI 側の本機構（`Document.fullscreen_image`、script.md frontmatter 由来）とは**疎結合の別物**——共有 parser クレートに `Document.fullscreen_image` フィールドが追加された後も、TUI 側のコードはこのフィールド自体を一切参照していない（TUI にとっては今も死んだフィールド）点は変わらない:
1. `tui/src/ui.rs` の `draw_splash`/`draw_fullscreen_image` — `Config.splash.logo_image`（ゲーム設定ファイル由来）が設定されている場合にのみ発火する、起動時スプラッシュ専用の contain-fit + スクロール描画モード（#530/#588、変更なし）。
2. `Config.fullscreen_image`（`tui-config.toml`、#628 フェーズ3で新規追加）— GUI 側 `Document.fullscreen_image` と**同じ意味論**（イベント絵単体シーンの間だけテキストウィンドウ/選択肢を隠す可逆トグル）を TUI 側にも用意したもの。ただし配線経路は GUI と異なり、script.md frontmatter を読むのではなく `sentence_per_page` と同じ「TUI は `tui-config.toml` 側の独立フィールドで制御する」設計パターンを踏襲する（`Config::fullscreen_image` の doc comment参照）。トリガー判定は `Playback::current_item_is_image_only()`（現在位置が `PlaybackItem::Image`——テキストを持たない画像コマitem——かどうか）で、`ui::draw()` が `config.fullscreen_image && image_only_item && choice.is_none()` のときだけ `split_columns` による左右分割をやめ `root[0]` 全体をイベント絵に使う。次に会話テキスト/選択肢のある item に進めば自動的に通常の左右分割へ戻る（状態を持たず毎フレーム再判定するだけの可逆トグル、GUI版と同じ設計）。

両者は起動時1回（1）と全イベント絵（2）という適用範囲も、ゲーム設定ファイル（1と2はどちらも `tui-config.toml` 由来だが別フィールド）という点も異なる独立した機構である点に注意。

**テクスチャ拡大縮小フィルタ（pixel_art, #466）**: PixiJS は既定でテクスチャ拡大時に linear（滑らか）フィルタを掛けるため、Gymnasia の 128x128 ドット絵イベント絵を cover-fit で拡大表示するとブロック状のドットがぼける。frontmatter `pixel_art: true` で per-game に `'nearest'`（ドット感を保つ）へ切り替えられる（未指定/`false` は従来どおり `'linear'`＝theo-hayami 等の塗り絵作品は非回帰）。`NovelPlayer` → `NovelRenderer.setPixelArt(enabled)` → `CharacterLayer.setPixelArt()` / `EventImageLayer.setPixelArt()` の対称配線（`character_scale` 等と同じ流儀）で、値の所有権は各レイヤー側に置き renderer はフィールドを持たず素通しする。適用箇所はテクスチャロード完了後（`Assets.load().then()` 内）の `texture.source.scaleMode = pixelArt ? 'nearest' : 'linear'`（PixiJS v8 API）で、`CharacterLayer` は立ち絵（`loadTexture`）と render-only 単独画像（`showImage`、`[画像:]`）の両方に効く。**対象外**: `NovelRenderer` が内蔵する背景画像（`setBackground`/`showLoadedBackground`）は本設定の対象に含めていない。Gymnasia は `[背景:]` タグ自体を使わず全てイベント絵で構成する設計（#76）のため現状不要と判断した。将来ドット絵背景を使う作品が出た場合は同じパターン（`texture.source.scaleMode` の分岐）を `showLoadedBackground` に追加する形で拡張できる。`pixel_art` を後から変えても、`character_scale`（#378）と同じく表示中の sprite に即再適用される: `CharacterLayer.setPixelArt()` は `reapplyPixelArt()` で `this.characters` の全 sprite（立ち絵・render-only・クロスフェード中の旧 sprite 問わず、テクスチャロード済みのもの）の `scaleMode` をその場で書き換え、`EventImageLayer.setPixelArt()` は show() が保持する直近の `currentTexture` を同様に書き換える（scale 系のライブ再適用と異なりジオメトリを変えないため、アニメ中・fit 等の除外は不要）。editor で `pixel_art: true` を追記した瞬間に表示中の絵の見た目も揃う。**タイトル画面・終劇オーバーレイの title.png（#553、#628 フェーズ2b／#630 で経路変更）**: 起動時タイトル画面のロゴは #628 フェーズ2b で DOM `TitleOverlay.tsx` から PixiJS 実装（`NovelRenderer.showTitleScreen()` → `TitleScreenOverlay` + `characterLayer.showImage()`）に置き換わり、以後は上記の `scaleMode` 配線（`CharacterLayer.setPixelArt()`）にそのまま乗る——別経路の CSS 適用は不要になった。終劇オーバーレイ（confinement 外脱出時に出す埋め込み元ロゴ、#404）も #630 で同じパターンに揃えた: DOM `NovelPlayer.tsx` の素の `<img>`（`pixelArt` prop が true のときだけ `style={{ imageRendering: 'pixelated' }}` を適用する CSS 経由の実装）を廃し、`NovelRenderer.showEndingOverlay()` → `characterLayer.showImage()` に置き換えたことで、こちらも `CharacterLayer.setPixelArt()` の `scaleMode` 配線にそのまま乗るようになった（別経路の CSS 適用は不要）。値の出どころはタイトル・終劇とも同じ `Document.pixel_art` で、PlayerScreen → `NovelPlayer` → `NovelRenderer.setPixelArt()` へ他の per-game 設定と同じ経路で流れる。#628 フェーズ2b の DOM→PixiJS 移行で失われていた Tab/Shift+Tab・矢印キーでのフォーカス移動、Enter/Space での確定、visible focus ring（`Graphics` 枠線）は #633 で `TitleScreenOverlay.handleKeyDown()` として復元した。`NovelRenderer.handleKeyDown` は `titleScreenOverlay.visible` の間、window keydown を丸ごとこのメソッドへ委譲する。**focus-visible化（#640）**: #633 実装当初はマウス操作でもフォーカスリングが常時表示されていた（`ChoiceOverlay` と同型のバグ、詳細は前述 `Choice` 節の #639/#640 の記述参照）。`ChoiceOverlay` の `keyboardNavActive` パターンをそのまま移植し、`moveFocus()` が実際に呼ばれるまでリングを描画しないよう修正した。

### イベント絵ピクセレート遷移 (#583)

`[イベント絵: path, 遷移=pixelate, フェード=N]` で選べる、透明度フェード（既定）に代わるもう1つの遷移モード。GUI/TUIで実装場所とパラメータの単位は異なるが、「表示中の絵のドットを段階的に荒くする（コルセン）→切り替える（スワップ）→段階的に細かく戻す（リファイン）」という3段構成と、前半/後半を `PIXELATE_TRANSITION_SWAP_RATIO`（両実装とも既定50%）で均等配分する設計は共通（中間点でスワップする点は TUI の既存 `blend()` が `t>=0.5` でグリフをハード切替する設計と対称に揃えている）。

**プロジェクト単位デフォルト (#599)**: `遷移=` が明示されていないタグの実効値は、Rust parser（`parser/src/parser.rs::parse_event_image_directive`）が frontmatter `event_image_transition`（既定 `Fade`）を解決してその場で `Event::EventImage.transition` に焼き込む。GUI/TUI 側は自前でこのデフォルト解決をやり直す必要がなく、常に解決済みの値を読むだけでよい（`NovelRenderer`/TUI `playback.rs` の `ei.transition ?? ...` 系フォールバックは wasm 経由の型上 optional に対する防御的な二重防御でしかなく、実運用では発火しない）。emit（保存）時は `parser/src/emitter.rs::emit_events` がこの同じデフォルトと比較し、タグの実効値が一致する場合だけ `遷移=` kv を省略する。Gymnasia のように大半の `[イベント絵:]` を `遷移=pixelate` にしたい作品は、422箇所に個別タグ付けする代わりに `event_image_transition: "pixelate"` を1行足すだけでよい。

**GUI版**: 純粋な時間→値計算は `frontend/src/game/pixelateTransition.ts`（`computeSwapAtMs`/`computeCoarsenSize`/`computeRefineSize`/`isCoarsenComplete`/`isRefineComplete`）に切り出し、`EventImageLayer.ts` が `pixi-filters` の `PixelateFilter` を `imageGroup` に適用してタイマー駆動する。表示中スプライトのドットを粗くしながら並行して次画像をロードし、コルセン完了（`swapAtMs` 到達）時点でロードが済んでいれば `performPixelateSwap()` で即座にテクスチャを差し替え、済んでいなければ `holding` フェーズで最大粗さのままロード完了を待ってからスワップする。進行状態は `pixelateState`（`'coarsen'`/`'holding'`/`'refine'` の3値 `phase`）としてクラスだけが保持する一時状態（ADR-0002）。`show()` は `opts.transition === 'Pixelate'` かつ `fadeMs > 0` のときだけ `startPixelateTransition()` を通す。表示中の絵が無い（初回表示、`[イベント絵終了:]` 後の再表示等）場合も同じ経路に入り（#612）、`imageGroup` が空のままコルセンが始まるだけで、ステージは `background_color` のベタ塗りなので見た目は「黒ベタからのピクセレート遷移」として成立する。`fadeMs<=0`（即時指定）の場合のみ、遷移するものが無い/瞬時表示が明示されているため通常の Fade 経路（実質は即時表示）にフォールバックする。別の遷移・退場（`remove()`）への割り込みは `cancelPixelateTransition()` が担う。

**TUI版**: GUI版の「PixiJSフィルタで画面をぼかす」とは異なるアプローチで、quadrant block 変換（#481）の前段でダウンサンプル解像度そのものを粗くする。`tui/src/pixelate_transition.rs` の `compute_divisor`/`is_coarsen_phase` が進行度 `t`（0.0〜1.0）から粗さの分母（`PIXELATE_TRANSITION_MAX_DIVISOR`=8 を上限、コルセン中は1→8、リファイン中は8→1）を計算する純粋関数。`tui/src/image_render.rs` の `rgba_to_quadrant_grid_pixelated` が `nearest_upscale`（意図的にブロック状に拡大する、ボックス平均の逆操作）と組み合わせてこの粗さを実現し、`coarse_divisor<=1` では既存の `rgba_to_quadrant_grid` と出力が一致する（遷移完了時に見た目の不連続が起きない根拠）。`tui/src/image_fade.rs` の `ImageFadeState` は新規フィールド `to_transition` を持ち、`Pixelate` のときは通常の `blend()`（αクロスフェード）ではなく専用の `pixelate_snapshot()` を通る — `blend` のように `from`/`to` を同時合成するのではなく、常にどちらか一方（コルセン中は `from`、リファイン中は `to`）だけを粗さを変えながら描画する。TUI版はGUI版と異なり `this.sprite &&` のような「表示中スプライトの有無」でこの経路に入るかどうかを分岐するゲートを元々持たない — `ImageFadeState::snapshot()` は `to_transition == Pixelate` の判定だけで無条件に `pixelate_snapshot()` へ入る。`pixelate_snapshot()` は `from` が `None`（表示中の絵が無い、シーン最初の `[イベント絵:]` 表示等）の場合 `image_render::blank_grid`（`BLANK_CELL` 一色の黒）を返し、`draw_image_grid` が全セルへ明示的に fg/bg Style を適用するため純黒の塗りつぶしと完全に等価になる（穴にはならない）。したがってコルセン中は `from=None` のまま黒ベタ据え置き（実質no-op）、スワップ後は `to` が実際にコルセン→リファインされるという、GUI版と同じ「黒ベタからのピクセレート遷移」が成立する。Issue #613 でこの `from=None` ケースが想定外入力への防御的フォールバックではなく意図された設計であることを明文化した。

**TUI版の所要時間 (ms) の決定は Fade/Pixelate で非対称（意図的な仕様）**: `main.rs::event_loop` は `resolve_event_image_transition_duration_ms()` で遷移所要時間を決める。通常の Fade 遷移は常に `config.event_image.crossfade_ms`（グローバル値）を使い、`[イベント絵: ..., フェード=N]` によるイベント個別の `event_image_fade_ms` 指定は意図的に読み捨てる（MVPスコープの簡略化、#481、非回帰）。一方ピクセレート遷移 (#583) だけは Issue の要件どおり per-event の `フェード=N` を「遷移全体の所要時間」として尊重し、未指定なら同じ `crossfade_ms` を既定値として使う。GUI版にはこの区別自体が無い — `NovelRenderer` は `ei.fade_ms ?? this.eventImageFadeMs`（個別指定優先・未指定時は frontmatter `event_image_fade_ms` 既定値にフォールバック）を Fade/Pixelate どちらの `show()` 呼び出しにも同じロジックで渡す。

**TUI版: 起動ロゴのピクセレート遷移（#628 フェーズ3a）**: `main.rs::show_splash` は `image_fade::ImageFadeState::settled(None, ..)` で開始し、`config.resolve_splash_logo_path()` が解決できた最初のフレームで `transition_to(Some(logo相対パス), .., EventImageTransition::Pixelate, Duration::from_millis(config.event_image.crossfade_ms), now)` を1回だけ呼び、以後 `current_target().is_some()` により再トリガーしない。ただし `ui::draw_splash`/`draw_splash_logo_native`/`draw_fullscreen_image` は通常プレイの `ImageFadeState::snapshot()`（`resolve_grid` 経由のパス解決 + cover-fit 前提の quadrant grid 化）をそのまま使わない——スプラッシュはネイティブ解像度表示（`rgba_to_quadrant_grid_native`、#588）と contain-fit+スクロール表示（`rgba_to_quadrant_grid_window`、#530）という cover-fit とは別の解像度計算を使うため。代わりに `ImageFadeState::progress(now)`/`transition_mode()`（`pub(crate)` 化、#628）だけを借りて `ui::splash_pixelate_phase()` が `Coarsening`/`Refining{divisor}`/`Settled` を判定し、`image_render::rgba_to_quadrant_grid_native_pixelated`/`rgba_to_quadrant_grid_window_pixelated`（`rgba_to_quadrant_grid_pixelated` と同じ「粗いdivisorへダウンサンプル→`nearest_upscale`」方式をネイティブ/window表示にも適用した新規関数、`coarse_divisor<=1` は素通しで無印版と完全一致）へ振り分ける。コルセン中（`from=None` 相当）は `image_render::blank_grid` の黒ベタ——通常のイベント絵と同じ「黒ベタからのピクセレート出現」（#613）がロゴにも成立する。

**同一パス再指定時のGUI/TUI対称化 (#590)**: 表示中と同じパスへ `遷移=pixelate` で再指定した場合、GUI/TUIとも実際にコルセン→自己スワップ→リファインを再生する。GUI版は元々 `show()` がパスの同一性を見ず「表示中の絵の有無」（`this.sprite` の有無）だけで判定するためこの挙動だった。TUI版は `main.rs::event_loop` の `image_fade.current_target() != target` というパス一致ガード（連続する同一パスへの無駄な再フェードトリガーを防ぐための既存ガード、#481由来・#583以前から存在）に引っかかり、`transition_to()` 自体が呼ばれず何も起きない（no-op）という非対称があった（#583セルフレビューで発見）。#590 でこのガードを `should_start_image_fade_transition()`（純粋関数に切り出し、`main.rs`）に置き換え、`target_transition == Pixelate && target.is_some()` の場合はパス一致でも `transition_to` を呼ぶ例外を追加して対称化した。パス不一致時の挙動・Fade遷移のガード（同一パスへのFade再指定は引き続きno-op、#481由来の回帰防止は非回帰）は変更していない。

### 単独画像 (`[画像:]`) のピクセレート遷移 (#628, GUI版のみ)

`[画像: path, 遷移=pixelate, フェード=N]`（`showImage`/`CharacterLayer.ts`）は、上記イベント絵 (#583) と同じ `pixelateTransition.ts` 純粋関数・同じ `pixi-filters` `PixelateFilter` を使ってコルセン→スワップ→リファインを再生する。**イベント絵との構造的な違いは、CharacterLayer が単一スロットではなく id ごとに複数の `[画像:]`/立ち絵を同時に扱う点**: ピクセレートの進行状態（`pixelateState`）とフィルタ（`pixelateFilter`）は `EventImageLayer` のようにクラス単一のフィールドではなく、`CharacterState`（`characters` Map の各エントリ）に id 毎で持たせる。駆動も `EventImageLayer` 専用の `setInterval`（`pixelateTimer`）ではなく、`CharacterLayer` が立ち絵の transform/fade/pose-nudge/文字演出/下線で既に使っている単一の共通 ticker（`ensureTicker`、`elapsedMs` 基準）に相乗りする（`updateImagePixelateFrame` が毎フレーム呼ばれる）。フィルタは `EventImageLayer` の `imageGroup`（wrapper container）に相当する共有コンテナが無いため、対象 sprite（`state.sprite`）に直接 `sprite.filters = [pixelateFilter]` で掛ける。

**新規表示限定**: `showImage()` の同 id 再表示（`existing` 分岐）でのピクセレート遷移は対象外— 位置更新のみで従来どおり（テクスチャが既にロード済みの場合、または後述 #646 の再ロード中の場合いずれも、ピクセレート演出自体は再生しない）。ピクセレートは新規表示（`characters` に未登録の id）のときだけ `startImagePixelateTransition()` に入る。呼び出し時点で sprite にはまだテクスチャが無い（`showImage` はテクスチャロード前に sprite を作る設計）ため、見た目は「何も無い状態からのピクセレート遷移」になる（イベント絵の #612 と同じ性質— コルセン中は何も見えず、スワップの瞬間に画像が最大粗さで現れ、以後リファインで細かく戻る）。

**同id再表示時のテクスチャ未ロード救済（#646）**: `existing` 分岐は元々「テクスチャ差し替えは想定しない」設計で、位置更新のみして即 return していた。しかしこれが `NovelRenderer.showTitleScreen()` の `title.png` 読み込みで実害のあるバグを生んでいた——`NovelPlayer` の mount effect（`[fluidRemountKey]` 依存、コンポーネント生存中1回だけ実行）内で `assetBaseUrl` prop がまだ空/未解決のタイミングだと `renderer.setAssetBaseUrl()` がスキップされ、`renderer.assetBaseUrl` が空のまま残る。`rendererReady`（`renderer.init()` 完了のみを見るフラグで `assetBaseUrl` の非空を保証しない）到達後にタイトル画面 effect が `showTitleScreen()` を呼ぶと、`characterLayer.showImage()` に空の `assetBaseUrl` が渡り壊れた URL で読み込みが失敗する（`onError` 発火、フォールバック文字は表示したまま）。その後 `assetBaseUrl` prop が遅延解決しても、別の effect が `renderer.setAssetBaseUrl()` を呼び直すだけでロゴ画像の再読み込みは一切トリガーされず、`existing` 分岐が「位置更新のみで return」する設計のため、以後何度リロードして `showTitleScreen()` を呼び直しても永久にフォールバック文字が固着していた。

修正: `CharacterState` に `imageLoadPending?: boolean`（Fade/ピクセレート双方のロード in-flight を示すフラグ、成功・失敗いずれの完了パスでも false に戻す）を新設し、`existing` 分岐で `hasLoadedTexture(NAME)` が false かつ `imageLoadPending` も false（＝前回ロードが失敗/未着手のまま、正規のロードも in-flight でない）なら、新規 sprite/state は作らず `existing.sprite`/`existing` を再利用して呼び出し時点の最新 `opts.assetBaseUrl`（`existing.assetBaseUrl` ではない——後から解決済みになっているからこそ再ロードする意味がある）で `Assets.load` → `applyImageTexture` → `startEntranceFade` の通常 Fade 経路に合流させる。`imageLoadPending` ガードにより、ピクセレート遷移が coarsen/holding フェーズで進行中（この間 `hasLoadedTexture` は false のまま）でもFade経路の再ロードが横から割り込まない。ピクセレート初回ロードが失敗した場合の再ロードは常に Fade 経路（ピクセレート再開はしない）。

**フェード既定値は `event_image_fade_ms` に紐付けない（設計上の意図的な割り切り）**: イベント絵の `遷移=` はプロジェクト単位デフォルト（frontmatter `event_image_transition`、#599）を受けるが、`[画像:]` の `遷移=` は Rust parser 側で明示的にこの解決をスキップし、未指定時は常に `Fade` に固定される（`parser/src/models.rs` の `Image.transition` 参照）。同じ理由で GUI 側の所要時間既定値も `event_image_fade_ms` を流用せず、`CharacterLayer` が単独画像の入場フェードに既に使っている `TITLE_CARD_FADE_MS`（700ms）をそのまま `resolveImagePixelateDurationMs()` の既定値にする。`フェード=` 明示指定時はその値、`フェード=0` 以下を明示指定した場合は遷移するものが無いため通常の Fade/即時経路にフォールバックする（イベント絵版 `show()` と同じ規約）。

**退場・打ち切りの後始末**: `clearImagePixelateState()` が `pixelateState` を外し `PixelateFilter.size` を初期値 1 に戻し `sprite.filters` を外す、単一の後始末ヘルパー（イベント絵版は完了/打ち切りで `completePixelateTransition`/`cancelPixelateTransition` に分かれているが、CharacterLayer は専用タイマーを持たず ticker 駆動のため区別不要）。リファイン完了・ロード失敗・`remove()`/`clear()` による破棄（`destroyCharacterState`）のいずれの経路でもこのヘルパーを通し、フィルタの状態を持ち越さない。`hasActiveAnimation()` は `pixelateState` の有無も判定に含め、ピクセレート進行中は共通 ticker を止めない。

**parser.ts の防御的正規化 (#628)**: `Event.Image` の `transition`/`fade_ms` は wasm 側 `#[serde(default)]` のため型上 optional だが、`normalizeEvents()`（`frontend/src/wasm/parser.ts`）に `Image` 分岐を追加し `transition: im.transition ?? 'Fade'` / `fade_ms: im.fade_ms ?? null` に倒す（他の `Image` フィールド position/shape/size/id/x/y は元から素通り [catch-all `return event`] で機能していたため変更していない）。

### 主要API

| API                                                     | 説明                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advance()`                                             | 次のイベントに進む                                                                                                                               |
| `goBack()`                                              | 前のイベントに戻る                                                                                                                               |
| `getSnapshot()`                                         | 現在の状態をスナップショットとして取得                                                                                                           |
| `seekTo(historyIndex)`                                  | 履歴の指定位置にジャンプ                                                                                                                         |
| `applyState(state)`                                     | スナップショットから画面を復元                                                                                                                   |
| `playScript(steps)`                                     | 操作列（`advance`/`choice`/`wait`）を決定論的にリプレイ（#220 Phase 1、デバッグ/テスト用。再生中 msPerChar=0、完了・例外時に復元、再入は throw）。destroy 後ガード（#515）: `wait` ステップの `await` 中に `destroy()` されて `initialized=false` になった場合、wait 明け直後にそれを検知し、残りの step（後続の `advance`/`choice` 含む）を一切実行せず `playScript` を終了する（msPerChar 復元等の finally 後始末は通常どおり走る） |
| `startFrom({sceneId?, flags?, eventIndex?, textIndex?, sentenceIndex?, confinedSceneIds?}): Promise<SceneEntryResult>` | 新規開始（#220 Phase 2、#734 PR2）。`sceneId` 省略でエントリ文書の先頭から。未ロードのシーンは遅延ロードで解決する。解決できた後・描画の前に flags 置換・confinement（#386。`jumpToScene` はこの集合外への遷移を通常のシーン遷移にせず `endStory()` にする。省略・null は解除）の置き換え・`storyEnded` 解除・`consecutiveJumps` 0 を確定する。背景・BGM・立ち絵は持ち越さない。history リセット。不在は `failed` で状態を一切変えない |
| `loadEvents(events)` / `loadScenes(scenes)`              | 文書を読み込むだけで開始しない（#734 PR2）。`NovelPlayer` のマウント時に使い、続く初期入場が位置を確定する。`setEvents` / `setScenes` は「読み込み＋`startFrom({})`」（#734 PR5。flags のクリア・`storyEnded` の解除・`consecutiveJumps` のリセット・`currentSceneId` のエントリへの揃えは新規開始が担う）。`restart()` は PR5 で廃止し、`startFrom({})` に置き換えた |
| `ensureAudioContext()` / `setDocKey(docKey)` / `hasQuickSave()` / `clearQuickSave()` | タイトル画面の「はじめから」「つづきから」が使う（#734 PR5）。`PlayerScreen` は `NovelPlayerHandle`（型付き）経由で呼ぶ。`window.__renderer` のダックタイプはやめた |
| `setOnStoryEndedChange(cb)`                              | 終劇状態の変化コールバックを登録する（#386）。`NovelPlayer` は iframe 埋め込み時の postMessage 通知（#395）とデバッグ HUD 等の一部 DOM ボタンの disabled 制御に使う（"to be continued..." 表示自体は #630 で PixiJS 側に内部化され、このコールバックには依存しない） |
| `setIntermissionScene(events, {backgroundFadeMs?, characterFadeMs?, eventImageFadeMs?})` | intermission.md 専用シーンを設定する（#404）。`events` は `assets/scripts/intermission.md` を parse した Event 列。null/空配列は「未設定」として `endStory()` を従来どおりのフェード＋終劇オーバーレイ表示にフォールバックさせる。fade 値は intermission.md 自身の frontmatter 由来で物語本編の設定とは独立 |
| `hasIntermissionScene()`                                | intermission.md 専用シーンが設定済みかを返す（#404）。`syncEndingOverlayVisibility()`（#630）が終劇オーバーレイと PixiJS タブローの排他判定に内部で使う |
| `showToast(message)`                                     | クイックセーブ/ロード完了通知の toast を表示する（#142、#630 で PixiJS 化）。`ToastOverlay` に描画を委譲し、2秒後の自動消去タイマー管理は renderer 側（`this.time`）が持つ。結果の通知は renderer 内（`quickSave` / `quickLoad`）が呼ぶ。`NovelPlayer` の F5/F8 ハンドラは結果を通知せず、初期入場の自動セーブ停止通知だけが NovelPlayer から呼ぶ |

### シーン入場経路の網羅表（#734）

シーンに入るすべての経路について、横断的な機能（遅延ロード・持ち越し・confinement・遷移世代・Jump 状態など）をどう扱っているかを一覧にする。
横断的な機能を足したり変えたりするときは、先にこの表の全マスを埋める。
入場を「進行」「新規開始」「復元」の3種に分ける設計と、その移行計画は [ADR 0003](./adr/0003-scene-entry-kinds.md) にある。表の「あるべき挙動」は、ADR 0003 §2 の種類別の表から導いたもの。

- 実装状況: PR1（#734）で進行と復元の入場を単一の入口 `enterScene` に通した。表の ⚠ のうち [4]（遷移中のゲート。復元中の `advance` を含む）・[5]（選択肢の遷移先不在）・[6]（要求時に世代を進めない）・[13]（遅延ロード後処理の重複）は解消済みで、表の該当セルの関数名・行番号（`resolveMissingSceneAndJump`・`loadFromSaveDataMissingScene`・`resolveMissingSceneAndRestore`・`beginRestoreTransition`・`drainPendingJump`）は PR1 以前のもの。新規開始の経路のうち `startFrom`（G3〜G5。`?scene=`・`?debug_scene=`）と初期入場は PR2（#734）で単一の入口へ移した: [1]（`startFrom` が遅延ロードを通らない）・[7]（新規開始が背景等を持ち越す）・[8]（初期入場が1回で済まない）・[14]（fluid 再マウントで debug 起点を再実行する）は解消済みで、G3・G4・G5・G9 の該当セル（`PS` の事前解決・`setConfinedSceneIds`・`skipAutoAdvance`・`setEvents` がエントリ冒頭を実行済み、など）は PR2 以前のもの。PR3（#734）で [2]（`playScript` の choice が遅延ロードを待たない）・[3]（`?scene=` と `debug_script` の併用で confinement が残る）・[12]（GUI/TUI の debug 起点の不一致）を解消した（G6・T4 の該当セルは PR3 以前のもの）。動画書き出し（G11）は PR4（#734）で `startFrom` へ移し、[9] は解消済み。G11 行のセルは PR4 以前のもの。PR5（#734）で「はじめから」（G12）と文書の(再)供給（G13）を新規開始へ揃え、`restart()` を廃止した: [10]（`setEvents` と `restart` の食い違い）・[11]（`consecutiveJumps` のリセット漏れ）は解消済み。G12・G13 行のセル（`restart`・`setEvents` が flags を残す、など）は PR5 以前のもの

- 現状の欄は、関数名と行番号で示す。行番号は 2026-10-13 時点（main `dae752b`）の目安で、±数行ずれることがある
- 略号: `NR` = `frontend/src/game/NovelRenderer.ts`、`NP` = `frontend/src/components/NovelPlayer.tsx`、`PS` = `frontend/src/screens/PlayerScreen.tsx`、`VE` = `frontend/src/game/VideoExporter.ts`、`PB` = `tui/src/playback.rs`
- ✓ はあるべき挙動と一致。⚠ は不一致で、`→` の後にあるべき挙動を書く。`[n]` は ADR 0003 の「不整合」の番号
- 「背景等」は背景・背景板・大道具・幕・紙人形輪郭を指す。「立ち絵」は、進行では `clearForSceneTransition`（遷移用の退場）、それ以外では `clear`

#### 経路と入場の種類

G1・G2 はエディタのプレビュー（`EditorScreen`）でも同じ入口を通り、遅延ロードも `PlayerScreen` と同じ規則で解決する（#778。取得元は編集中の doc・他タブの下書き・develop。詳細は「マルチMD再生と遅延ロード」）。

| 記号 | 経路 | 入口（現状） | 種類（あるべき） |
|---|---|---|---|
| G1 | 選択肢の確定 | ChoiceOverlay コールバック（`NR` L4873-4885）→ `jumpToScene`（L1375） | 進行 |
| G2 | `[ジャンプ:]` | `processDirective`（L4893-4900）→ `armJump`（L1448）→ 次 tick で `jumpToScene` | 進行 |
| G3 | `?scene=` | `PS` L638 で事前解決 → `NP` L783 `startFrom({sceneId})` → index 0 なので `startScene`（L1489） | 新規開始 |
| G4 | `?debug_scene=`（index 0） | `PS` L652 で事前解決 → `NP` L819 `startFrom` → `startScene` | 新規開始 |
| G5 | `?debug_scene=`（index 指定）・`startFrom` の index 指定 | `startFrom`（L6292）→ 最小 state で `restoreToScene`（L5908） | 新規開始（位置を指定） |
| G6 | `?debug_script=` | `NP` L817 `playScript`（L3637）。advance は `advance`＋`transition.awaitPending()`、choice は `await jumpToScene`（`entered` 以外なら打ち切り、#734 PR3） | 進行（choice）。土台は G3 または エントリ |
| G7 | クイックロード | F8（`NP` L1114）・マウント時の自動実行（`NP` L791）→ `quickLoad`（L5797）→ `loadFromSaveData`（L5979） | 復元 |
| G8 | ロードメニュー | `openLoadMenu`（L5881）→ `loadFromSaveData` | 復元 |
| G9 | fluid 再マウント | `NP` L772 `restoreSnapshot`（L6120） | 復元 |
| G10 | `goBack`・`seekTo` | `goBack`（L3680）・`seekTo`（L3742）→ `applyState`（L3779） | 入場ではない（同じシーンの history 内） |
| G11 | 動画書き出し | `VE` `startFrom`（PR4 で `stopBgmForFreshStart`＋`jumpToScene` から移行済み） | 新規開始 |
| G12 | 「はじめから」・「つづきから」（クイックセーブなし） | `PS` `onNewGame`・`onContinue` → `NovelPlayerHandle.startFrom({})`（PR5 で `restart` から移行済み。旧: `PS` L998・L1020 `restart`〔L1305〕） | 新規開始（エントリ） |
| G13 | 文書の(再)供給 | マウント（`NP` L756/L763）・events 変化 effect（`NP` L1165、エディタのライブ再パース）→ `setEvents`（L1257）/`setScenes`（L1321）（PR5 で「`loadEvents`/`loadScenes` + `startFrom({})`」に移行済み） | 新規開始（エントリ） |
| T1 | 選択肢の確定（TUI） | `select_current_choice`（`PB` L1679）→ `jump_to_scene_id`（L1705）→ `jump_to_scene_idx`（L1762） | 進行 |
| T2 | `[ジャンプ:]`（TUI） | `advance` の `pending_jump`（`PB` L1516）→ `jump_to_scene_id` | 進行 |
| T3 | 自動クイックロード（TUI） | `save.rs` `restore_playback`（L121）→ `set_flags`＋`jump_to_scene_id_with_continuation`（`PB` L1733） | 復元（シーン先頭の粒度） |
| T4 | `--debug-scene`（TUI） | `main.rs` `apply_startup_entry` → `start_fresh_at`（クイックロード・自動クイックセーブなし、#734 PR3） | 新規開始 |
| T5 | 起動・`--new-game`（TUI） | `Playback::from_merged_document`／`from_document` | 新規開始（エントリ） |

#### 遅延ロード・持ち越し・flags・confinement

| 記号 | 遅延ロード | BGM | 背景等・立ち絵 | flags | confinement |
|---|---|---|---|---|---|
| G1 | `resolveMissingSceneAndJump`（L1530）✓ | 持ち越す（`carryBgm`）✓ | 持ち越す（`preserveBackgroundForTransition`）✓ | 保持 ✓ | 判定する（L1380）✓ |
| G2 | 同上 ✓ | 持ち越す ✓ | 持ち越す ✓ | 保持 ✓ | 判定する ✓ |
| G3 | ⚠ `startFrom` は解決しない（L6257、no-op）。`PS` が事前解決する [1] → `startFrom` 自身が共通の解決口を通る。`PS` の事前解決は confinement の算出だけに使う | 止める ✓ | ⚠ 持ち越す（`startScene` が `preserveBackgroundForTransition: true` 固定）[7]。ハブ背景のテクスチャがロード中なら `bgLoadToken++` で破棄されて描かれないが、`currentBackgroundPath` の状態（再マウントのスナップショット・`getSnapshot`・HUD）が漏れる。ハブと同じパスの背景はフェードせずに即時表示され、ハブの話者は退場演出をする → クリア | 置換（空）✓ | ⚠ 入場とは別に `setConfinedSceneIds`（`NP` L591）で事前に設定している → 入場の属性として、成功時に確定する |
| G4 | ⚠ G3 と同じ（`PS` L652 の事前解決、#726）[1] → 共通の解決口 | 止める ✓ | ⚠ G3 と同じ [7] → クリア | `debug_flags` で置換 ✓ | ⚠ `PS` が解決結果を見て null にする（L671） → `startFrom` の `confinedSceneIds: null`。失敗時は G3 の設定が残る。タイトル画面を出すかどうかは解決結果ではなく `PS` の `hasDebugStart`（L277、URL に指定があるか）で決まる |
| G5 | ⚠ G4 と同じ [1] | 止める（空 state）✓ | クリア（空 state を `applyState`）✓ | 置換 ✓ | G4 と同じ |
| G6 | ⚠ choice は解決を待たない。`drainPendingJump` が `jumpState` しか見ない（#729）[2] → 入場の Promise を await する。advance 後の `[ジャンプ:]` は、`pending` の間 0ms ポーリングで待つ → 入場の Promise を待つ | 持ち越す ✓ | 持ち越す ✓ | 保持 ✓ | ⚠ `?scene=` と併用すると confinement が残り、別ファイルへの choice が終劇になる [3] → debug 系は confinement なし |
| G7 | `loadFromSaveDataMissingScene`（L6035）✓（後処理は重複 [13]） | 状態どおり ✓ | 状態どおり ✓ | 置換 ✓ | 判定しない ✓（confinement 中のロードは未整理。ADR 0003 の保留事項） |
| G8 | 同上 ✓ | 状態どおり ✓ | 状態どおり ✓ | 置換 ✓ | 判定しない ✓ |
| G9 | `resolveMissingSceneAndRestore`（L6192）✓（後処理は重複 [13]） | 状態どおり ✓ | 状態どおり ✓ | 置換 ✓ | 判定しない ✓ |
| G10 | 不要（同じシーン） | スナップショットどおり ✓ | スナップショットどおり ✓ | 置換 ✓ | 関与しない ✓ |
| G11 | 進行の解決（G1 と同じ）を通るが、結果を待たない ⚠ → `startFrom` の結果を await する。失敗時は reject する | ⚠ 打ち消し用の `stopBgmForFreshStart` を前置きして止める [9] → 新規開始として止める | ⚠ プレビューから持ち越す [9] → クリア | ⚠ プレビューの flags を保持 [9] → 置換（空） | ⚠ 進行として判定する（エディタでは null なので実害なし）→ 判定しない |
| G12 | 不要（エントリ） | 止める ✓ | クリア ✓ | クリア ✓ | 触らない（タイトルは `?scene=` が無いときだけ出る）✓ |
| G13 | 不要（エントリ） | 止める ✓ | クリア ✓ | ⚠ 保持する（`restart` はクリアするのに）[10] → 置換（空）。PR5 で解消 | 解除する ✓（PR5。`setEvents` が `startFrom({})` 経由になり、`confinedSceneIds` も解除される） |
| T1 | 不要（全 .md をマージ済み） | 持ち越す（#724）✓ | ファイル境界ではイベント絵・暗転・SE・話者をリセット（`reset_running_state_across_files` L1747）✓ | 保持 ✓ | 無し（GUI 版のみ）✓ |
| T2 | 不要 | 持ち越す ✓ | T1 と同じ ✓ | 保持 ✓ | 無し ✓ |
| T3 | 不要 | `continuation` どおり ✓ | `continuation` どおり（BGM・イベント絵・暗転）✓ | 置換（`set_flags`）✓ | 無し ✓ |
| T4 | 不要 | ⚠ クイックロードで復元した BGM を持ち越す [12] → 止める | ⚠ 同じファイル内ならランニング状態を持ち越す [12] → クリア | ⚠ 復元した flags を保持 [12] → 置換（空） | 無し ✓ |
| T5 | 不要 | 無し ✓ | 無し ✓ | 空 ✓ | 無し ✓ |

#### 遷移世代・ゲート・失敗時・既読・history・終劇

| 記号 | 遷移世代 | 遷移中ゲート・Jump 状態 | 失敗時（不在・resolver 失敗） | 既読 | history・自動クイックセーブ・`pendingAutoAdvance` | `storyEnded`・`consecutiveJumps` |
|---|---|---|---|---|---|---|
| G1 | ⚠ 要求の時点では進めない（解決後の `resetAndStartEvents` で進む）。先行する非同期の入場と同じ世代を捕捉する [6] → 要求の時点で進めて捕捉する | ⚠ 遅延ロード中も `jumpState` は `idle`、`waitingForChoice` は false。`advance` が Choice を素通りし、`quickSave` も通る [4] → 入場中ゲート（`pendingEntry`） | ⚠ 警告だけ出し、選択肢は閉じたまま。`advance` で Choice の後ろへ進む [5] → 選択肢を再表示する（T1 と同じ） | Choice 到達時（L4835）✓ | 空から積む ✓。`onSceneChange` → 自動クイックセーブ ✓ | false（`startScene`）✓。継続 ✓ |
| G2 | `armJump` で進める ✓ | `pending` → 成功で `idle`、失敗で `stalled` ✓ | `stallJump` ✓ | Jump 到達時（L4899）✓ | 空から積む ✓。発火 ✓ | false ✓。加算し、上限 100 ✓ |
| G3 | `resetAndStartEvents` で進める（同期）✓ | 同期なのでゲート不要。非同期化した後は入場中ゲート | ⚠ no-op。マウント時はエントリにフォールバックしたことになるが、実際にはその前に `setEvents` がエントリ冒頭を実行済み [8] → 初期入場は `resolveInitialEntry` の試行順で1回だけ | 付けない ✓ | 空から積む ✓。`onSceneChange` は発火するが、deep-link では自動セーブを配線しない（#664）✓ | false ✓。⚠ リセットしない [11] → 0 |
| G4 | G3 と同じ ✓ | G3 と同じ | ⚠ G3 と同じ。加えて `?scene=` と併用すると `startFrom` を2回呼ぶ。debug_scene 単独でも自動クイックロード（`NP` L753-L799）が先に走る [8] → 初期入場を1回にし、debug 指定時はクイックロードしない | 付けない ✓ | G3 と同じ ✓ | false ✓。⚠ リセットしない [11] |
| G5 | `applyState` で進める ✓ | 位置が Jump なら再予約（#733）✓ | G4 と同じ ⚠ | 付けない（Jump 位置だけ到達扱い）✓ | `[snapshot]` ✓ | false ✓。0 ✓ |
| G6 | choice は G1 と同じ ⚠ [6] | ⚠ choice は G1 と同じ [4] | ⚠ 警告を出して次のステップへ続行 → 打ち切って警告する | G1/G2 と同じ ✓ | ⚠ 自動クイックロードと競合する（`willAutoQuickLoad` が debug_script を見ない）[8] → debug 指定時はクイックロードしない。⚠ fluid 再マウントでスクリプトを再実行し、引き継いだ位置を上書きする [14] → スナップショットがあれば debug 起点は再実行しない | G1/G2 と同じ ✓ |
| G7 | `beginRestoreTransition` で進める ✓ | `jumpState` は据え置き（#759）✓。`pending` 中は `quickLoad` 自体を弾く ✓。ロード中の `advance` は Jump 以外では通る ⚠ [4] → 入場中ゲート（ADR 0003 の PR1） | flags だけ反映し、`resumeAutoAdvanceIfPending`・`rearmPendingJumpAfterFailedRestore` ✓（打ち消し系は PR2 で廃止） | 付けない ✓ | `[snapshot]` ✓。`pendingAutoAdvance` をクリア ✓。⚠ F8 のトーストは遅延ロードの結果を待たずに成功と出す → 結果を待って出す | 状態どおり ✓。0 ✓ |
| G8 | G7 と同じ ✓ | 開いた時と確定時に `pending` を弾く（#759）✓ | G7 と同じ ✓ | 付けない ✓ | `[snapshot]` ✓ | 状態どおり ✓。0 ✓ |
| G9 | G7 と同じ ✓。⚠ G1 の要求が同じ世代を捕捉して競合する [6] | G7 と同じ | G7 と同じ ✓ | 付けない ✓ | `[snapshot]` ✓。⚠ 直前の `setEvents` がエントリ冒頭を実行済み [8] | 事前に `storyEnded` をセットして重複発火を防ぐ ✓。0 ✓ |
| G10 | `applyState` で進める ✓ | `pending` 中は弾き、`stalled` 中は復元し直す ✓ | 該当なし | 付けない ✓ | 切り詰める（`seekTo`）✓ | 状態どおり ✓。0 ✓ |
| G11 | 進行と同じ ⚠ [6] | ⚠ 進行と同じ [4] | ⚠ 警告だけ出し、プレビューの内容のまま録画が始まる [9] → reject する | 付けない ✓ | `onSceneChange` を書き出しが占有して終端検知に使う ✓ | false ✓。⚠ 継続 [9] → 0 |
| G12 | `resetAndStartEvents` で進める ✓ | `idle` に戻す ✓ | 該当なし | 付けない ✓ | 空から積む ✓。⚠ `onSceneChange` を発火しない（`PS` が明示的に `clearQuickSave`）→ 新規開始として発火する（自動セーブの配線は初期入場の確定後なので、初期入場の分は保存されない） | ⚠ `storyEnded` を戻さない [10] → false。⚠ リセットしない [11] → 0 |
| G13 | 同上 ✓ | 同上 ✓ | 該当なし | 付けない ✓ | 空から積む ✓。⚠ `onSceneChange` を発火しない → G12 と同じ。⚠ `skipAutoAdvance`→`pendingAutoAdvance`→`resumeAutoAdvanceIfPending` で後から来る入場の分を打ち消している [10] → 開始しない `loadEvents` と明示的な入場に分ける。⚠ events 変化 effect（`NP` L1160-1167）がマウント時にも1回走り、`init()` 解決前の renderer に `setEvents` する（コード上の読み、要実機確認）[8] → 初回は実行せず、`rendererReady` 後の変化にだけ反応する | ⚠ G12 と同じ [10][11]。`currentSceneId` も更新しない ⚠。PR5 で解消（新規開始が揃える） |
| T1 | 同期のため不要 | 同期 ✓ | `false` を返し、選択肢に留まる ✓ | 表示位置単位（`main.rs` の `read_positions`）。経路による差は無い ✓ | 自動クイックセーブはシーン切り替えの検知で行う ✓ | 中継の上限 `RELAY_HOP_LIMIT` = 100 ✓ |
| T2 | 不要 | `pending_jump` は位置から再導出 ✓ | 位置を変えず `false`（停止）✓ | T1 と同じ ✓ | T1 と同じ ✓ | 上限 100 ✓ |
| T3 | 不要 | 構築・復元時に `pending_jump` を再導出 ✓ | `has_scene_id` で事前に確認し、無ければ何もしない ✓ | `read_positions` は復元が成功したときだけ戻す ✓ | — | — |
| T4 | 不要 | ✓ | 不在なら no-op ✓ | — | ⚠ 自動クイックロードの後に上書きする [12] → `--debug-scene` 指定時はクイックロードしない（`read_positions` も復元されない）。⚠ シーン切替ごとの自動クイックセーブ（`main.rs` L1302-1304 `save_quick`）が `--debug-scene` 中も走る [12] → 行わない（GUI の #664 と対称） | — |
| T5 | 不要 | ✓ | — | — | `--new-game` はクイックセーブを削除する ✓ | — |

## レンダリングパイプライン

```
Event[] (パース結果)
    ↓
expandEvents(events, 入場時 flags)  ← Condition を入場時に逐次評価・展開（#799）
    ↓
ResolvedEvent[]                 ← フラットな配列（Condition なし）
    ↓
NovelRenderer (PixiJS)          ← 1イベントずつ描画
```

### expandEvents（`[条件:]` の入場時評価, #799）

`Condition` イベントを、シーン訪問の入場時の flags から逐次に評価して展開し、フラットな `ResolvedEvent[]` を生成する（`frontend/src/game/GameState.ts`）。

- 元の events 配列を変更しない（不変展開）
- 元列を先頭から走査し、`Flag` を走査用の複製に適用しながら `Condition` に達した時点で評価する（TUI の `build_scene_items` と同じ）。ブロック内でそのフラグを変えても、入場済みのブロックの残りは流れる
- 展開はシーンの訪問ごとに1回（`PlaybackCursor.load` / `replaceEvents`）。`[フラグ:]` を実行しても再展開しない（`reResolve` は廃止）。訪問中は列が不変で、`displayEventCount`・SeekBar の番号付け・`eventIndex` は固定された列に対する値
- 入場時の flags は、`NovelGameState.entryFlags`（元列に `[条件:]` を含むときだけ）としてセーブ・スナップショットに載る。`eventIndex` の意味（展開後の列の添字）は変わらない。`entryFlags` が無い旧セーブは、保存位置を含むトップレベル要素までを保存された flags での静的展開（`resolveEvents` と同じ結果）で、後ろを、保存位置を含む要素の残りの `[フラグ:]` を適用した flags（`entryScanFlags`）からの逐次評価で復元する（`entryFromState`。要素の内側の `[条件:]` だけは評価し直されない制約が残る）
- `rawOffsets`（元列のトップレベル i 番目の展開後の開始位置）が、線形ストリームのシーン境界の計算（`resolveLinearSegments`）に使われる
- `resolveEvents(events, flags)` は静的展開（全体を1つの flags で展開）として残り、旧セーブの保存位置までの展開と `[条件:]` を含まない入力の旧挙動との一致の基準になる
- 詳細は ADR 0003 の #799 追記

### 演出イベントの即時実行

以下のイベントはユーザー操作を待たず即時実行し、次のイベントに自動進行する:

- `Background` — 背景変更
- `EventImage` / `EventImageExit` — イベント絵レイヤーの表示/終了（#351）
- `Telop` — テロップ（画面隅への短文の非同期スライドイン表示。#674、下記参照）
- `Blackout` — 暗転/暗転解除（action: On/Off）
- `SceneTransition` — 場面転換
- `PageBreak` — 手動改頁マーカー（`---`）。何もせず読み飛ばす（次の text イベントが新ページから始まる、#292 Phase 2）
- `Bgm` / `Se` — 音声制御
- `Flag` — フラグ設定
- `Exit` / `ExpressionChange` — 立ち絵制御
- `Wait` — 固定時間待機
- `WaitDisplayComplete` — 表示完了待機（ユーザー操作は待たず、視覚演出完了後に自動進行）

`Dialog` と `Narration` のみユーザー操作（クリック/キー）で進行する。

### 新しいディレクティブをどこに足すか (#829, #735 8/8)

演出系のディレクティブは `NovelRenderer.processDirective` に分岐を足さず、`frontend/src/game/directives/` の領域別の表に足す。`processDirective` は先頭で `dispatchDirective(event, this.directiveContext)` を呼び、表にある種ならそこで終わる。表に無い種（フロー制御系・テキスト系・未知）だけがレンダラに残る。ハンドラは `(event, ctx) => void`、表のキーはイベント種名（`{ Bgm: ... }` なら `Bgm`、文字列イベントなら `'SceneTransition'` そのもの）。

| 足したいもの | 置き場 | 条件 |
| --- | --- | --- |
| 背景・背景板・大道具・動画・イベント絵・テロップ・幕・照明・画面効果（揺れ/フラッシュ/フェード/暗転）・カメラ・紙人形輪郭・文字窓の枠 | `directives/stageDirectives.ts` の `stageDirectives`（オブジェクトイベント）。引数なしの文字列イベントは同ファイルの `stageSignalDirectives` | `ctx.stage` / `ctx.layers` / `ctx.hooks` 経由で触る。再生状態には触らない |
| 立ち絵の登場・退場・表情・アニメ、`[タイトル:]` / `[ラベル:]` / `[画像:]` / `[文字演出:]` / `[下線:]` | `directives/characterDirectives.ts` | `ctx.characters`（`CharacterLayer`）に渡すだけ。Dialog の立ち絵（`showCharacterFromDialog`）や話者交代の nudge は触らない |
| BGM・SE | `directives/audioDirectives.ts` | `ctx.audio`（`AudioManager`）。現在 BGM の記録は `ctx.hooks.setCurrentBgmPath` |
| フラグ・選択肢・ジャンプ・待機（`Flag` / `Choice` / `Jump` / `Wait` / `WaitDisplayComplete`）のように、カーソル・遷移ゲート・待機タイマーなど再生状態を同時に触るもの | `NovelRenderer.processDirective` に残す（表に入れない） | 表に入れると `DirectiveContext` が再生状態まで持つことになる。表のキーとしての混入は `directives.test.ts` が落とす |
| `Dialog` / `Narration`（本文） | 表の対象外（`render()` が処理） | |

新しい種を足す手順: (1) 該当領域のファイルに `on<'種名'>((event, ctx) => ...)` を足す、(2) `directives/oldProcessDirective.oracle.ts` は着手時点の旧実装の写しなので触らず、新規の種は `directives.test.ts` に単体テストを足す、(3) 触れるものが `DirectiveContext` に無い場合は、まず既存のグループ（`layers` / `env` / `hooks`）へ足せないか考え、本当に新しい領域のときだけトップレベルのメンバーを増やす（上限 10。現状 6: `stage` / `audio` / `characters` / `layers` / `env` / `hooks`）。`DirectiveContext` は `NovelRenderer.createDirectiveContext()` が getter で組み立て、値は毎回レンダラの現在値を読む。

### テロップレイヤー (`TelopLayer.ts`・#674)

`[テロップ: 本文, 位置=右下, 秒=4, 種別=しおり]` から駆動される、画面隅に短文を数秒表示して消える演出。`EventImageLayer`/`ToastOverlay` と同じ「薄いラッパー」方針で、いつ表示するか（復元中・スキップ中は表示しない）の判断は `directives/stageDirectives.ts` の `Telop` ハンドラ（#829 で `NovelRenderer.processDirective()` から移動）が持ち、`TelopLayer` 自身はスライドイン（`easing.ts` の `easeOut`）→保持→フェードアウト（線形、`computeFadeAlpha` と同じ流儀）の描画だけを担う。矩形幾何・帯高さの計算は `novelLayout.ts` の `computeTelopGeometry`/`computeTelopBandHeight`（純粋関数）に切り出す。**復元・スキップでは表示しない**——`NovelGameState` にはテロップの状態を一切持たせない（ADR-0002）ため、`applyState`（goBack/seekTo/セーブ復元/任意局面起動）はそもそも `processDirective` を再生しない経路で `telopLayer.clear()` するだけであり、追加ガードは不要。複数出現時は position ごとに縦へ積む（新しいものが下＝下端アンカーは新しいものほど辺に近い段、上端アンカーは古いものほど辺に近い段）、同時最大3段で超過は古いものから即破棄。frontmatter `telop_reserve: true`（既定 false）のときだけ `DialogBox.setNovelBottomReserve(computeTelopBottomReserveHeight(font_size, buttonRowHeightPx))` 経由で novel の本文領域下端を1段ぶん＋下部丸ボタン行ぶん狭め、改頁計算もその領域で行う（動的な重なり回避はしない方針、kako-jun 2026-09-07）。レイヤー順は `dialogBox` の直後・`seekBar`/選択肢/終劇オーバーレイの下。`TelopLayer.resize()` は本番の `NovelRenderer` からは呼ばれない（論理 screenWidth/Height はコンストラクタで固定・`aspect_ratio: auto` の fluid モードは再マウントで対応する）ため、将来の実行時リサイズ対応と単体テストのための API。テロップのアクセント縦線色は `SeekBar` と同じ色解決を共有し、`NovelRenderer.setSeekBarColor()` が呼ばれると次の `show()` だけでなく、その時点で表示中の全段にも `TelopLayer.setAccentColor()` 経由で新色を即時反映する。**下端アンカー（BottomLeft/BottomRight）は画面下部の丸ボタン行（DOM 固定 CSS px、`NovelPlayer.tsx` の `bottom-3`/`w-9 h-9`）と重ならないよう `PLAYER_BUTTON_ROW_HEIGHT_PX` ぶん余分にマージンを取る**（#677）。表示倍率が1でない端末では `NovelRenderer.syncTelopBottomMarginToButtons()` が `SeekBar.setVerticalCenter` と同じ方法（`canvas.clientHeight` から実倍率を求めて固定 CSS px を割る）でこの値を補正し、`TelopLayer.setButtonRowHeightPx()` 経由で反映する。本文は PIXI.Text の `wordWrap: true`＋`breakWords: true`（日本語は空白が無く breakWords 必須）で `computeTelopMaxWidth(screenWidth)`（画面幅から左右マージンを引いた最大幅）由来の `wordWrapWidth` に折り返す（#679）。帯の矩形（`computeTelopGeometry` の width/height）は実測 `textWidth`/`textHeight` から組み、`computeTelopBandHeight`（font_size からの1行固定高さ）はもう使わない——複数行になった段はそのぶん帯も高くなる。スタックは「アンカー辺に近い段から順に実測 `height + TELOP_STACK_GAP_PX` を積み上げた累積値」を `stackOffsetPx` として渡す（`relayout()` が計算、固定の等間隔ではない）。`telop_reserve` の予約帯（`computeTelopBottomReserveHeight`）だけは引き続き1行固定のままで、複数行のテロップは予約帯より上に一時的にはみ出し本文と重なるのを許容する。

### canvas の touch-action 方針 (#434)

「ゲームタイプごとに入力要件が異なるので touch-action もレンダラーごとに自身の入力要件に応じて宣言する」という設計方針。次にレンダラーを足す・touch-action を触るときはこの規約に従うこと。

- **novel 型**（`NovelRenderer.ts`）: canvas の touch-action は `'pan-y'`（`init()` 完了直後に上書きする。PixiJS の `Application.init()` は既定で `'none'` を設定するが、そのままだと iframe 埋め込み内のスワイプが外側ページのスクロールを奪えなくなる）。ただしスクロール可能な選択肢リスト表示中（#339, `ChoiceOverlay`）だけは `'none'` に戻す（`ChoiceOverlay.setOnScrollableChange` 経由の通知を受けて `NovelRenderer` が切り替える）。
- **RPG 型**（`TopDownRenderer.ts`）・**raycast 型**（`RaycastRenderer.ts`）: `touchInput.ts` がスワイプ移動/タップメニューにスワイプ自体をゲーム操作として使うため、touch-action は `'none'` 固定・無改修。

### NovelRenderer の純粋計算モジュール (#260)

`NovelRenderer.ts` は god-object 化しやすいため、入力→出力が決定論的で `this` / PixiJS / DOM / TimeController に一切依存しない計算を専用モジュールへ漸進分離している（#260）。`ruby.ts` / `rubyLayout.ts` / `raycastProjection.ts` と同じ流儀で、NovelRenderer 側は「いつ計算するか」「結果をどの表示オブジェクト・オーディオに当てるか」だけを保持する。各関数は抽出前に NovelRenderer 内へ直書きされていた式・数値・文字列と完全一致し（挙動不変）、リファレンス等価性をユニットテストで機械的に担保する。

- **`frontend/src/game/screenEffects.ts`（時間→値、#143 / #264）**: 画面効果の毎フレーム計算を集約する。`effectProgress(elapsedMs, durationMs)` が `min(elapsed/duration, 1)` の進行率を返し（`durationMs <= 0` / 非有限は即完了 `1`、負 elapsed は `0` にクランプ）、それを使って `computeShakeOffset`（`decay = 1 - progress`・`offsetX = sin(elapsed*0.05)*intensity*decay`・`offsetY = cos(elapsed*0.037)*intensity*decay*0.6` の減衰揺れ）、`computeFlashAlpha`（`peak*(1-progress)` の線形フェードアウト）、`computeFadeAlpha`（`from + (to-from)*progress` の線形補間、`progress>=1` で `to` ちょうど）を算出する。いずれも `done = progress >= 1` を返し、NaN/Infinity の振幅・alpha は `0` 扱い。境界値テストは `screenEffects.test.ts`
- **`frontend/src/game/textEffect.ts`（グリフ単位文字演出の時間→値・中央寄せレイアウト、#268）**: `[文字演出]` ディレクティブ（タイトルカードの enter アニメ）の純粋計算を集約する。`resolveTransformEffect(params)` がプリセット（爆発）＋個別 override ＋グローバル既定をマージして解決済みパラメータを返し（優先順位: 個別 > プリセット > 既定、負の duration/stagger は 0 クランプ）、`glyphLinearProgress(elapsed, glyphIndex, stagger, duration)` がグリフ i の `i*stagger` 遅延・duration 飽和を踏まえた線形進行率 `[0,1]` を返す。`computeGlyphTransform(resolved, elapsed, glyphIndex)` は進行率に easing を当てて開始オフセット → 整列状態（0/等倍/不透明）へ補間した 1 グリフ 1 フレーム分の transform を返し、`textEffectTotalDurationMs(resolved, glyphCount)` が最後のグリフが整列し終わる総時間（`(n-1)*stagger + duration`、0 グリフは 0）を返す。`layoutGlyphCenters(widths)` はグリフ幅配列から行全体を原点中央に寄せた各グリフ中心 x 配列を返す（空配列は `[]`）。プリセット定数（`EXPLODE_PRESET` / `TYPEWRITER_PRESET` / `TEXT_EFFECT_DEFAULTS`）はテストが期待値を直書きして陳腐化しないよう export する。CharacterLayer.applyTextEffect はこれらの値を各グリフ PixiText に当てるだけ（配線のみ）で `this`/PixiJS には触れない。easing 側の `easeOutBack`（`easing.ts`、爆発の "ポップ" 用オーバーシュート。overshoot 係数 s=1.70158、t=1 で 1.0）も #268 で追加。#271 でタイプ末尾の点滅カーソルを追加: `resolveCursor(params)` が reveal かつ `cursor=on` のときだけ `enabled=true`・点滅周期（既定 600）・色を解決し、`cursorVisible(elapsedMs, blinkMs)` が `floor(t / (blinkMs/2)) % 2 === 0` の step 関数で点滅位相を返す（`t<=0` 表示・`blinkMs<=0` 常時表示）。プリセット定数 `CURSOR_DEFAULTS` も export。CharacterLayer 側はカーソルを縦矩形 Graphics として reveal head に追従させ、settle 後も点滅だけ ticker で継続する（render-only・セーブ対象外）。カーソル Graphics は生成直後は不可視で、初期 `updateTextEffectFrame()` が reveal head へ配置したあとに `cursorVisible()` の結果で表示する（#333、未配置原点の 1 フレーム表示を防ぐ）。#275 でラベル揃え対応のグリフ整列オフセット `glyphAnchorOffset(totalWidth, anchorX) = totalWidth*(0.5 - anchorX)` を追加（左揃えラベルにタイプを当てるとグリフが左端起点で右へ並ぶ。`anchorX=0.5` で 0＝従来の中央寄せと一致。カーソルは container の子なので自動追従する）。境界値・デシジョンテーブルテストは `textEffect.test.ts` / `easing.test.ts`
- **`frontend/src/game/underline.ts`（下線ビームの時間→値・幾何・色パース、#270）**: `[下線]` ディレクティブ（OP タイトルカードの巨神兵ビーム）の純粋計算を集約する。`resolveUnderline(params)` がプリセット既定（`UNDERLINE_DEFAULTS`: 色 `#1a4a7a` / 太さ 3 / 700ms / EaseIn）と個別 override をマージし数値色・太さ（負は 0 クランプ）・duration・easing を解決、`underlineScaleX(elapsedMs, resolved)` が経過 ms → `scaleX [0,1]`（easing 適用、`elapsed<=0` で 0・`duration` 経過後 1・`duration<=0` は即 1）を返す。`layoutUnderline(textWidth, textBottomY, resolved, autoOffset)` がテキスト実 measure 幅から線の幾何（左端 x = `-width/2`・y = `textBottomY + offset`・幅・太さ）を算出する（offset 未指定なら autoOffset を補う）。色パース `parseColorToNumber` は **#273 で `novelLayout.ts`（色/幾何の純関数置き場）へ移設**し（下線ビーム・タイトル文字色・背景色が共有するため。doctrine 規律4=純粋関数の単一の置き場所）、`underline.ts` はここから re-export して既存 import（CharacterLayer / underline.test）の互換を保つだけ。CharacterLayer.applyUnderline は解決値を Pixi Graphics の矩形に当て scale.x で左から伸ばすだけ（配線のみ）。プリセット定数は export。`Math.random` 不使用・`TimeController` 駆動で決定論的。境界値テストは `underline.test.ts`
- **`frontend/src/game/wordwrap.ts`（日本語禁則ワードラップ、#400）**: `wrapTextWithMeasure(text, maxWidth, measure)` が
  Canvas/DOM 非依存の折り返し中核。`wordwrap(text, maxWidth, font)` は Canvas `measureText` を注入する薄い
  ラッパーとして既存 API を維持する。行頭禁止文字（句読点・閉じ括弧・促音など）は前行へ押し込むが、その1文字ぶんの
  超過を許した時点で行を確定し、`」って` のような閉じ括弧+促音+通常文字が右端を越えて連鎖しないようにする。
  そのため、超過行を確定した直後の次行では促音などの行頭禁止文字始まりを許容する場合がある。右端見切れ防止を
  優先し、禁則の押し込みを無制限に連鎖させない方針。行末禁止文字（開き括弧など）を次行へ送る既存禁則は維持する。
  境界値テストは `wordwrap.test.ts`。
- **`frontend/src/game/novelLayout.ts`（幾何・色パース・URL 解決・state 変換・フォント解決・表示値・シーンルックアップ・2D 位置解決、#265 / #260 / #273 / #274 / #275）**: NovelRenderer の純粋計算 13 種を集約する（#273 で `parseColorToNumber` を `underline.ts` から移設、#274/#275 で 2D 位置解決を追加）。`computeCoverFit(textureWidth, textureHeight, screenWidth, screenHeight)` は背景画像をアスペクト比維持で画面に「カバー」し中央寄せした `{width, height, x, y}` を返す（`scale = max(screenW/texW, screenH/texH)` で短辺を画面に合わせ長辺を溢れさせ、はみ出し分を中央でトリミング）。`parseHexColor(hex)` は `#RRGGBB` を PixiJS 用数値色に変換（先頭 '#' を 1 つだけ除去 → `parseInt(_, 16)`、NaN は白 `0xffffff` フォールバック）。`parseColorToNumber(color, fallback)`（#270 で導入、**#273 で `underline.ts` からこのモジュールへ移設**）は CSS カラー（`#rgb` 短縮形も展開）を PixiJS 数値色に変換し解釈不能・`undefined`・純 hex 以外は引数の `fallback` を返す（`parseHexColor` と違い fallback 可変・3 桁展開・符号付き弾き）。下線ビーム（#270）・タイトル文字色／背景色（#273）が共有し、`underline.ts` は re-export で互換維持。`resolveAssetUrl(baseUrl, kind, path)` はアセット相対パスを `${baseUrl}/${kind}/${path 先頭 '/' を 1 つ除去}` の配信 URL に解決（`kind` は `'images' | 'sounds'`）。`saveSlotToGameState(data, normalizedFade)` は `SaveSlotData` を復元用 `NovelGameState` に写像する（video/isBlackout/characters/currentBgmPath は古いセーブ向け後方互換フォールバック付き、fade は PixiJS 非依存を保つため正規化済みの値を引数で受け取る）。`resolveFontFamily(perLine, perGameDefault, runtimeDefault)` は `perLine ?? perGameDefault ?? runtimeDefault` の優先順チェーン（元 render() / TitleShow の 2 箇所重複を集約。空文字は指定扱いで素通し）。`formatCounterText(displayIndex, total)` は `"{displayIndex} / {total}"` の整形。`computeSeekBarPosition(displayIndex, total)` は SeekBar 用 `{current: max(0, displayIndex-1), total}`（1-based を 0-based 化しクランプ）。`describeEventForDebug(event)` はデバッグ HUD 用に 1 イベントから `{kind, text}` を取り出す（`Object.keys()[0]` の kind + text 配列/line/path/target の優先順抽出、配列は先頭を JSON 化し 120 文字切り詰め。引数型は任意入力耐性のため `unknown`）。`findSceneById(scenes, sceneId)` は `scenes.find((s) => s.id === sceneId)`（先頭一致の `EventScene | undefined`、未発見時の分岐は呼び出し側責任。`jumpToScene` / `loadFromSaveData` / `startFrom` / `resolveSceneTitle` 内部の 4 箇所で同形だったルックアップを集約）。`resolveSceneTitle(scenes, sceneId)` はセーブ表示用のシーンタイトル解決（`sceneId` が falsy なら即 `null`、それ以外は `findSceneById(...)?.title ?? null`。元 `quickSave` / `openSaveMenu` の 2 箇所にバイト単位で重複していた式を集約）。`resolveLayoutPosition(position)` は縦＋横を結合した 2D 位置トークン（縦 `上`0.16/`中上`0.34/`中`0.5/`中下`0.64/`下`0.84 ＋横 `左`0.1875/`中央`0.5/`右`0.8125）を `{xRatio, yRatio}` に解決する（完全一致を優先して `中央`↔`中` の衝突を避ける・`左下` 等の結合は順序非依存・英語 alias・未知/空は中央 (0.5,0.5)。横 ratio は立ち絵 `CHARACTER_X_RATIO` と同値で揃える、#274）。`resolvePositionWithOverride(position, x?, y?)` はそのトークン由来比率に数値 `x`/`y`（有限かつ 0..1 の値のみ採用、NaN/Infinity/範囲外は軸ごとにトークンへフォールバック）を軸独立に被せ、テンプレ厳密合わせを可能にする（#275）。両者を `[ラベル]`（showLabel）/`[画像]`（showImage）/`[タイトル]`（showTitle）が共有し、縦位置トークンと厳密配置を全要素で一貫させる（タイトルも #275 で縦トークンを尊重）。境界値・リファレンス等価性テストは `novelLayout.test.ts`。**#260 の純粋計算抽出はこれで出し切った**（シーンタイトル解決・シーンルックアップを含め、`this`/PixiJS/DOM/audio に触れない決定論的な計算は残っていない）: 残る NovelRenderer の責務（Sprite/Container/Graphics の生成・配置・破棄、Ticker/タイマー駆動、AudioManager/DOM 副作用、フラグ/履歴の状態遷移）は PixiJS 表示オブジェクト管理そのものであり純粋化不能
- **`frontend/src/game/SceneIndex.ts`（#735 の分割 2/8、#823）**: シーンの索引（`allScenes`）、エントリ文書（`entryRawEvents` / `entrySceneId`）、遅延ロードの共有 Promise（`missingSceneResolver` / `pendingMissingScenes`）、線形区間のキャッシュ（`linearSegmentsCache`）を持つ。`NovelRenderer` を import せず、再生中の配列（`rawEvents`）も持たない（エントリ文書と兼務しない, #662）。`resolve(sceneId)` は索引にあれば**同期で**結果を返し（同期描画のタイミングを変えない, ADR 0003 §3）、未ロードなら共有 Promise を返す（同一 sceneId の二重要求は resolver 1 回）。取れたシーン群の索引への反映（`indexLoaded`）は、世代と `initialized` の判定を通った後に呼び出し側（`enterScene`）が行う。線形ストリームの判定（`isEntryStreamActive` / `resolveLinearSegmentsNow`）は再生中の `currentSceneId` / `rawEvents` を引数で受ける。レンダラ側は `loadEvents` / `loadScenes` / `setJumpSceneIndex` / `setMissingSceneResolver` / `getAllSceneIds` を薄く委譲し、`currentSceneId` と `onSceneChange` の扱いは従来どおり持つ。テストからは `internals(r).allScenes` / `entryRawEvents` / `pendingMissingScenes` で `SceneIndex` の private フィールドを読み書きできる（アクセスの経路は `rendererInternals.ts` の1か所）。
- **`frontend/src/game/PlaybackCursor.ts`（#735 の分割 3/8、#824）**: 再生カーソルとイベント配列・履歴の**唯一の書き手**。`rawEvents` / `resolvedEvents` / `displayEventCount`（3点セット）、`eventIndex` / `textIndex` / `sentenceIndex`、派生ページキャッシュ（`novelPagesCache` / `advSentencePagesCache`）、`history`、`currentSceneId`、`playbackStarted` を private に持ち、読み取りは getter（readonly）だけを公開する。`NovelRenderer` は `this.cursor.eventIndex` のように読み、書き込みは必ずメソッド経由にする。3点セットと入場条件（`entry`）・`rawOffsets` の更新は内部の `expand(entry)` 1か所だけ（`replaceEvents` / `load` だけがここを通る。`restorePosition` と goBack・seekTo は再展開しない）で、展開後の列は常に `expandEvents(rawEvents, entry)` で再現できる。入場時の flags はセーブに載る（`snapshotEntry()`、ADR 0002 / 0003 #799 追記）。位置の更新は意味のある操作だけ: 進行（`nextSentence` / `nextPageStart` / `nextTextLine` / `nextEvent` / `skipDirective`）、後退（`prevSentence` / `prevPage` / `prevTextLine`）、復元（`restorePosition`）、新しい列での作り直し（`load`）、ページ数超過の寄せ（`clampToPageCount`、寄せたときだけ `sentenceIndex=0`）。履歴は `resetHistory` / `pushHistory` / `popHistory` / `truncateHistory`。ページキャッシュの無効化は `invalidatePages()` の1本（`nextEvent` / `load` / `restorePosition` / `reResolve` が内部で呼び、スタイル切替・`sentence_per_page` の切替はレンダラが直接呼ぶ）。ページ分割そのもの（`getNovelPages` / `getAdvSentencePages`）は DialogBox の計測やスタイル設定に依存するのでレンダラに残り、結果を `cacheNovelPages` / `cacheAdvSentencePages` で預ける。Pixi・DOM・タイマーに依存せず、`NovelRenderer` を import しない。テストが private を直接読み書きする経路は `frontend/src/test/rendererInternals.ts` の1か所（`cursor` の実体へ委譲するアクセサ）に集約している。
- **`frontend/src/game/TransitionState.ts`（#735 の分割 4/8、#825）**: 遷移ゲートと `[ジャンプ:]` 予約の状態機械。`waitingForChoice` / `waitingForWait` / `justSelectedChoice` / `suppressNextAdvance` / `jumpState` / `jumpTimer` / `jumpDeferred` / `consecutiveJumps` / `pendingEntry` / `transitionGeneration` の**唯一の書き手**で、`NovelRenderer` は `this.transition.waitingForChoice` のように getter で読み、書き込みは必ずメソッド経由にする。判定は `isGated(op)` / `gateReason(op)`（規則本体は `sceneEntry.ts` の純粋関数）、世代は `beginEntry` / `isStale` / `advanceGeneration`、Jump は `arm` / `clear`（deferred を `superseded` で解決する唯一の口）/ `stall` / `noteChainHop`（`JUMP_CHAIN_LIMIT`）、位置の切り替えは `resetForNewPosition`（`resetAndStartEvents`）と `resetJumpForRestore`（`applyState`）。DOM / Pixi / レンダラ / シーン内容を知らず、`NovelRenderer` を import しない（タイマーは注入した `TimeController`）。契約は ADR 0003（#825 での追記）。テストの private アクセスは `src/test/rendererInternals.ts` の `exposeTransitionFields` に集約。
- **`frontend/src/game/SceneEntryController.ts`（#735 の分割 5/8、#826）**: シーン入場の単一入口（ADR 0003 の `enterScene`）と、その適用・失敗処理。`enter` / `run` / `jumpTo` / `startFrom` と、入場属性 `confinedSceneIds` の唯一の書き手。手順（世代捕捉 → confinement → 解決 → 適用前の文脈確定 → 適用 → 後処理 → 失敗処理）を持ち、「何を描くか」は知らず、適用は自分で定義する `EntryHost`（8 メソッド）に委譲する（`NovelRenderer` が実装を渡す。`NovelRenderer` は import しない）。`SceneIndex` / `TransitionState` / `PlaybackCursor` はコンストラクタ注入。公開 API（`jumpToScene` / `startFrom` / `restoreSnapshot` / `quickLoad`）はレンダラに残る薄いラッパー。
- **`frontend/src/game/SaveController.ts`（#735 の分割 6/8、#827）**: クイックセーブ・自動セーブ・セーブ/ロードメニュー・ロード通知の*手続き*。`quickSave` / `quickLoad` / `requestAutoSave` / `flushAutoSave` / `openSaveMenu` / `openLoadMenu` / `loadFromSaveData` / `notifyLoadSuccess` / `notifyLoadFailure` / `getQuickSaveFlags` / `hasQuickSave` / `clearQuickSave` と、`autoSavePending`（#768。保留の書き込みはこのクラス内と `discardPendingAutoSave()` だけ）・`SaveManager` の唯一の持ち主。セーブ可否の判定（`transition.gateReason` / `isGated` と終劇）とトースト文言、`gameStateToSaveSlot`（#822）による `SaveSlotData` の組み立てを持つ。`applyState` / `restoreToScene` / `getSnapshot` はステージとカーソルを横断する合成なのでレンダラに残り、`SaveController` は自分で定義する `SaveHost`（7 メソッド: `getSnapshot` / `isStoryEnded` / `getPlayheadSceneId` / `showToast` / `ensureAudioContext` / `normalizeBackgroundFade` / `enter`）越しにだけレンダラを見る（`NovelRenderer` も pixi も import しない。`SaveLoadOverlay` はレンダラが生成して `attachMenu` で渡す）。公開 API（`quickSave` / `quickLoad` / `requestAutoSave` / `hasQuickSave` / `clearQuickSave` / `getQuickSaveFlags`）はレンダラに残る薄いラッパー。以下の本文で `NovelRenderer` の `notifyLoadFailure()` / `flushAutoSave` / `loadFromSaveData` と書いた処理は #827 で `SaveController` へ移った（読み替え: 旧 `NovelRenderer.saveQuick` / `openSaveMenu` / `openLoadMenu` / `loadFromSaveData` / `notifyLoad*` / `autoSavePending` / `saveManager` → `SaveController` の同名メンバー）。
- **`frontend/src/game/BackgroundController.ts`（#735 の分割 7a/8、#828 の第1段）**: 背景の状態と更新。下地ベタ（`graphics`、旧 `bgGraphics`）・背景画像コンテナ（`container`、旧 `bgContainer`）、クロスフェード中の `bgEntries` / `bgMaskSprite` / `bgCrossfadeTimer`、宣言状態 `currentBackgroundPath` / `Color` / `Fade` / `Brightness`、`defaultBackgroundColor`（#409）、背景専用の `textureCache`、ロード無効化の `bgLoadToken` / `pendingBackgroundLoad*` の**唯一の書き手**。公開メソッドは `attachTo`（init で下地ベタを塗ってステージへ積む）/ `capture`・`restore`（`getSnapshot` / `applyState` の背景 4 フィールドと地色の出し入れ。クロスフェードの中間状態は持たない、ADR 0002）/ `setBackground` / `clearBackground` / `forgetBackground`（宣言状態だけ捨てる。終劇用）/ `cancelPendingLoad`（トークンを進める。持ち越し遷移でも呼ぶ）/ `setBackgroundColor` / `clearBackgroundColor` / `setDefaultBackgroundColor` / `fadeOutBackgroundEntries`（終劇）/ `finishBackgroundCrossfadeInstant`（スキップ・持ち越し）/ `updateBackgroundFadeFrame` / `hasActiveBackgroundFade` / `hasPendingBackgroundLoad` / `waitForLoad` / `setVisible`（イベント絵 `back=Hide`）/ `clearBackgroundEntries` / `releaseTextures`。動画レイヤ（`VideoLayer`）・背景板には触れない。動画の寿命管理はレンダラの責任で、`resetAndStartEvents` と `processDirective` の `[場面転換]` は背景クリア直後、`applyState` は背景復元後に `videoLayer.remove()` を呼ぶ。`destroy` は先に動画を消し、後で背景 entries を解放する。`resetAndStartEvents` の持ち越しは従来どおり `preserveBackgroundForTransition` の1か所で分岐する（個別フラグは増やしていない）。Pixi は使うが `NovelRenderer` は import せず、自分で定義する `BackgroundHost`（5 メソッド: `getAssetBaseUrl` / `isSkipMode` / `isInitialized` / `getScreenSize` / `getCrossfadeMs`）越しにだけレンダラを見る。`TimeController` はコンストラクタ注入。背景の純粋関数 `normalizeBackgroundFade` / `normalizeBackgroundBrightness` / `brightnessToTint` もここで定義し、`NovelRenderer` から再エクスポートしている（既存の import 経路を変えない）。レンダラに残る公開 API は `setDefaultBackgroundColor` / `waitForBackgroundLoad` の薄いラッパー。以下の本文で `NovelRenderer` の背景メンバーと書いた処理は #828 7a で `BackgroundController` へ移った（読み替え: 旧 `NovelRenderer` の `bgEntries` / `bgMaskSprite` / `bgCrossfadeTimer` / `currentBackground*` / `defaultBackgroundColor` / `textureCache` / `bgLoadToken` / `pendingBackgroundLoad*` と、`setBackground` / `showLoadedBackground` / `clearBackground` / `setBackgroundColor` / `clearBackgroundColor` / `fadeOutBackgroundEntries` / `finishBackgroundCrossfadeInstant` / `updateBackgroundFadeFrame` ほか背景系 → `BackgroundController` の同名メンバー。`bgGraphics` → `graphics`、`bgContainer` → `container`）。
- **`frontend/src/game/ScreenEffectsController.ts`（#735 の分割 7b/8、#828 の第2段）**: 画面効果の状態と更新。揺れ（`startShake`）・フラッシュ（`startFlash`）・フェード（`startFade`）・終劇の黒フェード（`startEndStoryBlackoutFade`）・暗転（`blackoutOverlay` / `setBlackout`）・novel スクリム（`updateNovelScrim` / `retreatNovelScrim` / `resetNovelScrimState` / 矩形の `applyNovelScrimRegion`・`resetNovelScrimRegion`）の**唯一の書き手**で、`effectOverlay` / `shakeTimer` / `shakeStartMs` / `effectTimer` / `novelScrim` / `scrimRetreatActive` / `scrimRetreatTimer` / `scrimVisibilityTimer` / `blackoutOverlay` を持つ。時間→値の純粋計算は従来どおり `screenEffects.ts`（#143 / #264）で、ここは「いつ計算するか」と「結果をどの Graphics に当てるか」だけを持つ。`NOVEL_SCRIM_*` 定数もここで定義し、`NovelRenderer` から再エクスポートしている（既存の import 経路を変えない）。`getSnapshot` / `applyState` の演出フィールドのうちここが持つのは暗転 `isBlackout` だけ（`capture()` / `restore()`）。揺れ・フラッシュ・フェード・スクリム退避の中間状態は GameState に持たない（ADR 0002）。**止め方の差は呼び出し側が決める**: `reset()`（揺れ・効果の timer 停止 + オーバーレイ消去。stage 位置は戻さない）が `resetAndStartEvents` の「タイマー停止 → 演出消去 → BGM → カーソル → 再生開始」の演出消去にあたり、`applyState` と `endStory` は `reset()` に加えて `resetStagePosition()` で揺れた stage を原点へ戻す。`destroy` は `stopAllTimers()`（揺れ・効果・スクリム退避・スクリム通常フェード）、intermission タブロー描画前は `hideEffectOverlay()`。スクリム側は `resetNovelScrimState()`（退避途中を捨てて dialog alpha を 1 に戻す）を `resetAndStartEvents` / `applyState` が呼ぶ。Pixi は使うが `NovelRenderer` は import せず、自分で定義する `ScreenEffectsHost`（5 メソッド: `getScreenSize` / `setStagePosition` / `isNovelStyle` / `setDialogAlpha` / `setSeekBarBlackoutHidden`）越しにだけレンダラを見る。`TimeController` はコンストラクタ注入。z 順（立ち絵の上・スクリム → 暗転 → 効果オーバーレイ・ダイアログの下）は `attachTo(stage)` が3枚を連続して積んで保つ。テストは `ScreenEffectsController.test.ts`（単体）/ `ScreenEffectsController.equivalence.test.ts`（分離前の実装を写した参照実装との1フレーム刻みの状態列比較）/ `NovelRenderer.screenEffects.test.ts`（レンダラとの配線・呼び出し順）。以下の本文で `NovelRenderer` の `effectOverlay` / `novelScrim` / `startShake` / `startFlash` / `startFade` / `setBlackout` / `retreatNovelScrim` ほか画面効果系と書いた処理は #828 7b で `ScreenEffectsController` へ移った（読み替え: 同名メンバー）。ファイル名は、`screenEffects.ts` と大文字小文字違いだけになると macOS など大文字小文字を区別しないファイルシステムで衝突するため、`ScreenEffects.ts` ではなく `ScreenEffectsController.ts` とした。
- **`frontend/src/game/Stage.ts`（#735 の分割 7c/8、#828 の第3段・完了）**: 演出状態（背景・画面効果・カメラ3つ組・紙人形輪郭）を束ねる薄いコンポジタ。`BackgroundController`（`stage.background`）と `ScreenEffectsController`（`stage.effects`）を持ち、`cameraMode` / `cameraOrientation` / `cameraElevation` / `paperDollOutline` の**唯一の書き手**。公開は `reset(policy: CarryPolicy)`（`resetAndStartEvents` の演出消去。持ち越し判定は `carryPolicyFor` 由来の `CarryPolicy` だけを見る）/ `restore(state)`（`applyState` の演出の消去と復元。持ち越しなし）/ `capture()`（`getSnapshot` の演出9フィールド。セーブ形式不変）/ `setCamera(mode, orientation, elevation)` と `setPaperDollOutline(config)`（`[カメラ:]` / `[紙人形輪郭:]`・reset・restore の共通の更新口。背景板・大道具・立ち絵へは Host の `applyCamera` / `applyPaperDollOutline` で伝える）/ `cancelAllTimers()` と `release()`（`destroy`）/ `attachBackground` と `attachEffects`（init での z 順どおりの積み込み）。複数モジュールをまたいでリセットしてよいのは `resetAndStartEvents` / `applyState` / `destroy` の3つだけで、この3つの演出部分が `stage.*` の呼び出し列になった。立ち絵・大道具・背景板・動画・幕・スポットライト・テロップは Stage に入れず、レンダラが前後で呼ぶ（カメラの伝播を立ち絵のクリアより後に置く旧順序を保つ）。`resetAndStartEvents` は stage 位置を戻さず `applyState` / `endStory` は戻す（7b から不変。揺れ中の `resetAndStartEvents` で位置が戻らない件は #913）。`getSnapshot` のキー順はセーブ JSON 回帰テストが固定しているため、レンダラは `stage.capture()` の値を従来の位置に並べ直す。Pixi は使うが `NovelRenderer` は import せず、自分で定義する `StageHost`（`BackgroundHost` + `ScreenEffectsHost` + `applyCamera` / `applyPaperDollOutline`）越しにだけレンダラを見る。テストは `Stage.test.ts`（単体）/ `Stage.equivalence.test.ts`（分離前の呼び出し順を写した参照実装との比較）/ `NovelRenderer.stage.test.ts`（配線・呼び出し順）。以下の本文で `NovelRenderer` の `cameraMode` / `cameraOrientation` / `cameraElevation` / `paperDollOutline` と書いた処理は #828 7c で `Stage` へ移った（読み替え: `stage.cameraMode` などの getter と `stage.setCamera` / `stage.setPaperDollOutline`）。
- **`frontend/src/game/directives/`（#735 の分割 8/8、#829）**: `processDirective` の演出系ディレクティブ（32種）を領域別の表に分けた。`stageDirectives.ts`（ステージ系）/ `characterDirectives.ts`（立ち絵系）/ `audioDirectives.ts`（オーディオ系）/ `index.ts`（3表を結合した `dispatchDirective(event, ctx): boolean`。キー重複は読み込み時に例外）/ `types.ts`（`DirectiveContext` など）。`DirectiveContext` は `stage` / `audio` / `characters` / `layers` / `env` / `hooks` の 6 メンバー（上限 10）で、`layers` は動画・背景板・大道具・幕・照明・イベント絵・テロップ・文字窓・選択肢の必要メソッドだけを `Pick` した窓、`env` はレンダラの現在値の読み取り専用ビュー、`hooks` はレンダラ側の操作（可視性の再計算・幕の z-order・テロップのクリア・役割 xRatio・現在 BGM の記録）。`Flag` / `Choice` / `Jump` / `Wait` / `WaitDisplayComplete` は再生状態を同時に触るため表に入れずレンダラに残す。旧実装の呼び出し列との一致は `directives/directives.equivalence.test.ts`（参照実装は `oldProcessDirective.oracle.ts`）、レンダラとの結線は `NovelRenderer.directives.test.ts`。置き場の判断は上の「新しいディレクティブをどこに足すか」。以下の本文で `processDirective` の○○分岐と書いたものは、`directives/` の同名ハンドラ（`Telop` / `EventImage` / `SceneTransition` / `TitleShow` / `Se` など）へ移った（読み替え。`Flag` / `Choice` / `Jump` / `Wait` / `WaitDisplayComplete` の分岐は `processDirective` に残る）。
- **`frontend/src/game/eventCursor.ts` / `freshState.ts` / `preloadPlan.ts` / `debugState.ts`（#735 の分割 1/8、#822）**: `NovelRenderer` を分割する前に、`this` を使わない計算を先に出した。いずれも `NovelRenderer` を import しない（循環を作らない）。レンダラ側は「いつ呼ぶか」と、結果を `preloadedUrls` へ反映する書き込みだけを持つ（`resolvedEvents` / `eventIndex` / `displayEventCount` への反映は #824 で `PlaybackCursor` に移った）。`eventCursor.ts` は `countDisplayEvents(resolved)`（本文イベント = Dialog / Narration の数。`displayEventCount` を求める計算。#824 以降の呼び出しは `PlaybackCursor` の `expand` 1か所だけ）と、`getTextEvent`（Dialog / Narration から本文を取り出す。元は `NovelRenderer.ts` にあったが純粋関数なのでここへ移した。`seekMapping.ts` など純粋モジュールも `eventCursor.ts` から import し、`NovelRenderer.ts` との循環はない）と、述語 `isTextEvent`（`getTextEvent !== null`）。`freshState.ts` は `buildFreshPositionState(sceneId, position, flags)` で新規開始の最小 `NovelGameState` を組む（演出状態はすべて初期値）。`preloadPlan.ts` は `collectUpcomingAssetUrls(events, fromIndex, assetBaseUrl)` で先読み対象 URL を近い順・重複除去済みで返す（Choice / Condition / Jump で打ち切り、`assetBaseUrl` が空なら空）。積み済み集合 `preloadedUrls` との差分と `backgroundPreload()` の呼び出しはレンダラに残る。`debugState.ts` は `buildDebugState(inputs)` で `getDebugState()` の戻り値（`DebugState`）を組み立てる（`this` の読み取りは呼び出し側）。`NovelGameState` → `SaveSlotData` の写像は `novelLayout.ts` の `gameStateToSaveSlot(snapshot, { slot, savedAt, sceneName })` で、逆向きの `saveSlotToGameState` と対にし、クイックセーブ（`saveQuick`）とスロット保存（`openSaveMenu`）が共有する。時計（`savedAt`）の読み取りは呼び出し側。テスト側では、各 `NovelRenderer.*.test.ts` に個別定義されていた `internals(r)` を `frontend/src/test/rendererInternals.ts`（型付きアクセサ `internals<T>(r)` と共通フィールドの `RendererInternals`）に集約した。private の置き場が変わる以後の分割 PR では、このファイルを直せばよい。モックに差し替える `dialogBox` / `characterLayer` などテストごとに形が違うものは、各テストが `interface LocalInternals extends RendererInternals` で足す。`origin/main` で個別に `internals` を定義していた 42 ファイルはすべてこのヘルパに寄せた。一方、`as unknown as {...}` をその場で書くインラインのキャストや、用途別の別名ヘルパ（`scrimInternals` など）は今回の対象外で、まだ残っている（`linearRange` / `pendingChoice` / `saveLoadConsistency` / `intermission` など）。以後の分割 PR で触るときに寄せる

## セーブ/ロード

### 保存先

localStorage に 3 スロット分のセーブデータを保存する。

### SaveSlotData

```typescript
interface SaveSlotData {
  slot: number;
  sceneId: string | null;
  eventIndex: number;
  textIndex: number;
  flags: Record<string, FlagValue>;
  backgroundPath: string | null;
  isBlackout: boolean;
  characters: Array<{ name: string; expression: string; position: string }>;
  currentBgmPath: string | null;
  savedAt: string; // ISO 8601
  sceneName: string | null; // 表示用シーン名
}
```

### JSON エクスポート/インポート

セーブデータを JSON ファイルとしてエクスポート・インポートできる。異なるブラウザ間でのデータ移行に使用。

### 自動クイックセーブ/クイックロード（#578）とタイトル画面の相互作用（#620）

上記の3スロット手動セーブとは別に、`renderer` は毎シーン切り替え時に専用スロットへ自動でクイックセーブし、`PlayerScreen` マウント時に `renderer.hasQuickSave()` が真なら自動でクイックロードして直前セッションの正確な最終位置まで復元する（#578）。

タイトル画面の「つづきから」ボタン（`PlayerScreen.tsx` の `onContinue`。表示は #628 フェーズ2b で PixiJS `TitleScreenOverlay` に変わったが、このボタンが `PlayerScreen.tsx` 側に持つ副作用ロジック自体は不変）は、この自動クイックロードとの整合を取るため `hasQuickSave()` で分岐する（PR5 以降は `NovelPlayerHandle` 経由。かつては `window.__renderer` のダックタイプだった）:

- **真**（クイックセーブあり＝マウント時点で既に正確な位置まで復元済み）: `startFrom({})` を呼ばずタイトルを閉じるだけにする。呼んでしまうと最初のシーンへ巻き戻り、復元済みの位置を握りつぶす（#620 で発見・修正したバグ）
- **偽**（#578 以前のレガシーセーブ等、クイックセーブが存在しない）: 既存の「スキップモードで既読位置まで高速進行」（#140 `hasAnyReadProgress`/`readProgress` ベース）にフォールバックする

**hub冒頭の自動進行スキップ（#620 再発修正 → #734 PR2 で根治）**: かつて `NovelRenderer.setEvents()`/`setScenes()` は呼ばれると内部の `resetAndStartEvents()` が常に `processUntilNextTextEvent()` で最初のtext event（または `[待機:]` 等のディレクティブ）まで自動進行した。Gymnasia等、entry_script冒頭にイベント絵＋`[待機: 表示完了]`（ピクセレート遷移演出）を置く構成では、この自動進行が待機状態（`waitingForWait=true`）まで進んでしまい、その直後に呼ばれる `quickLoad()` の入口ガードに引っかかって静かに失敗し、「つづきから」で保存位置に復元されずhub冒頭が表示され続けるバグがあった（#620）。その対策だった `skipAutoAdvance` オプション・`pendingAutoAdvance` フラグ・`resumeAutoAdvanceIfPending()` は #734 PR2 で廃止した。`NovelPlayer` のマウントは `loadEvents`/`loadScenes`（開始しない読み込み）で文書を入れ、続く初期入場（`resolveInitialEntry`。上記）が `quickLoad`／`startFrom` で位置を1回で確定するので、エントリ冒頭の自動進行が先に走って `quickLoad()` を弾くことも、走った演出を別の入場で上書きすることも起きない。

`quickLoad(origin)` は `Promise<SceneEntryResult | null>` を返す（null はクイックセーブデータが無い・ゲートで弾かれた場合。入場を始めていない）。マウント時に失敗（`failed`）したときは、セーブの flags を `getQuickSaveFlags()` で読んで `startFrom({ flags })` に倒す（位置は失うが、進めたルートの入口が閉じない）。

復元（クイックロード・ロードメニュー・`restoreSnapshot`）は、進行（選択肢・`[ジャンプ:]`）と同じ単一の入口 `SceneEntryController.enter(request)`（旧 `enterScene`。#734 PR1、ADR 0003、#826 で移設）を通る。入口は要求の時点で遷移世代（`transitionGeneration`）を進めて捕捉し、予約中の Jump タイマーを止める（`transition.clear()`。再マウント直後に冒頭 Jump のタイマーが await 中に発火して復元を潰すのを防ぐ。進行中の古い解決も後勝ちで無効化される。#759）。遅延ロードを待つ間は入場中ゲート `pendingEntry`（`{ generation, kind, sceneId, promise }`）を立て、`transition.isGated()` が `waitingForChoice`・`waitingForWait`・`jumpState`・`pendingEntry` を合成して、`advance`・`goBack`・`seekTo`・セーブ／ロード・選択肢の確定を止める（読み込み済みのシーンへの同期の入場では立てない）。`jumpState` は変えない: ロード中も pending／stalled のゲートを保ち、`advance` で Jump を飛び越したり Jump 位置でセーブしたりさせない。シーンの引き当ては `sceneIndex.resolve` の1か所（読み込み済みなら同期のまま、未ロードなら `requestMissingScene`〔同一 sceneId は Promise 共有〕を待つ）で、await 後の世代と `initialized`（`host.isActive()`）の判定も `SceneEntryController.enter` の1か所にある。世代が不一致なら、復元を成功・失敗とも破棄して `superseded` を返す（`allScenes` の更新も行わない）。世代を進める他の経路（`resetAndStartEvents`・`applyState`）は `pendingEntry` も下ろす（破棄された入場がゲートを残さない）。予約中の `[ジャンプ:]` は `transition.arm()` の時点で deferred を作って `pendingEntry` に載せ、取り消す全経路（`transition.clear()`）が `superseded` で解決する（`playScript` が `pendingEntry.promise` を待って止まらない）。成功は `applyState` が `idle` 化して新位置が Jump なら再アームする。世代が一致したまま失敗（null／reject／ロード後も不在。resolver 未設定で解決できない場合も同じ）して位置が動かない場合は、フラグも適用せず位置・flags とも現状維持して（#765。選択したセーブの flags だけが現プレイに混ざるのを防ぐ）、`rederiveTransitionAtCurrentPosition()` で現在位置から遷移状態を導出し直す。現在位置が Jump で、タイマーを止められていた pending のものは `rearmJumpAtCurrentPosition()`（`applyState` 末尾と共通）で再予約し（stalled は据え置き）、現在位置が Choice で閉じられていた選択肢は再表示する。`pending` が残って詰むことも、Jump や選択肢が消えることもない。sceneId が null（空文字含む）のセーブ・スナップショットは、シーン索引を使わない線形ストリーム（`loadEvents`）のジャンプ前の位置であり、エントリ文書の線形ストリーム（`entryRawEvents`）の eventIndex へ `restoreEntryStream()` が復元する（#768。PlayerScreen の通常再生はジャンプ前に sceneId が null なので、その局面のセーブを無効にはしない）。復元後の `currentSceneId` は `entrySceneId`（`loadEvents` なら null、`loadScenes`/`setScenes` ならエントリのシーン ID）で、新規開始（`startFrom({})`）と `setEvents`/`setScenes` も同じ値に揃える（セーブの sceneId と eventIndex の指す先を一致させるため）。fluid 再マウントの引き継ぎは sceneId でなく `hasStartedPlayback()` で判定する。エントリ文書が未読み込みなら復元先が無いので、他の復元失敗と同じく位置・flags とも現状維持して失敗トーストを出す。復元位置の範囲検証（#789）: 復元先（シーン、またはエントリのストリーム）が決まった後・適用の前に、`checkRestorePosition()` が復元する入場時 flags（`expandEvents(events, entryFromState(state, events))`。旧セーブは保存位置までを `flags` で静的展開）で展開した列に対して `findRestorePositionError()`（`sceneEntry.ts` の純粋関数）で `eventIndex` / `textIndex` を判定する。`[条件:]` の真偽で列の長さが変わり、`applyState` が `eventIndex` を当てるのは展開後の列だから。範囲外は `failEntry` に `reason: 'out-of-range'` で渡し、位置・flags とも変えない（クランプなし）。ロード系は失敗トースト、`restoreSnapshot` は警告ログのみ。`startFrom` の位置指定も、`applyFresh` の flags・confinement の更新より前に同じ検証をする。終端（`eventIndex` が展開後の長さと等しい）は終劇かどうかに関わらず有効で `textIndex` は 0 のみ（末尾の命令を消化したクリック待ちの位置や、長さ 0 のシーン）。`setDialogStyle`／`setSentencePerPage` のライブ切り替えは `clampTextIndexToPageCount()` で textIndex を最終ページへ寄せる（範囲外のスナップショットを作らない）。`textIndex` の上限はレイアウトに依存しない場合（テキスト以外は 0 のみ、adv の本文は行数）だけ見て、ノベルの改頁数・文単位ページは見ない（#663 の fluid 再マウントのクランプを残すため）。`out-of-range` は `not-found` と同じく再試行しても直らない失敗なので、初期入場の自動セーブは配線する（配線しないのは `resolver-error` だけ）。ロード結果のトーストは NovelRenderer に一本化されている: `quickLoad(origin)`／`loadFromSaveData(data, origin)`（origin は `quick`=F8／`menu`=ロードメニュー／`auto`=マウント時の自動クイックロード）に起点を渡し、失敗は `notifyLoadFailure()` が同期・非同期とも即時にトースト「ロードに失敗しました」で通知し（auto も通知する）、成功は `restoreToScene` が実際に成功した時点（非同期は解決後）で `quick` のときだけ「クイックロードしました」を出す（menu は確定後にオーバーレイが閉じて結果が見えるため、auto は無言）。F8 が弾かれた場合も renderer が理由に合った文言を出す（Jump 予約中・入場中〔遅延ロードの往復を待っている間〕は「場面転換中のためロードできません」、選択肢／待機中は「この場面ではロードできません」、データ無しは「クイックセーブデータがありません」。auto は無言）。NovelPlayer の F8 ハンドラは `quickLoad()` を呼ぶだけ。クイックセーブ（F5）の結果トーストも renderer に一本化されている（#769）: `quickSave(origin)`（origin は `quick`=F5／`auto`=`onSceneChange` 経由の自動セーブ）が、成功は「クイックセーブしました」、弾かれたときは `gateReason` に応じて Jump 予約中・入場中は「場面転換中のためセーブできません」、選択肢／待機中・停止中の Jump・終劇後は「この場面ではセーブできません」を出す（ロード側と同じ振り分け。停止中の Jump は転換が進行していないので `gateReason` の `stalled` として区別する。auto は無言）。シーン入場後の自動セーブは、NovelPlayer の `onSceneChange` が `requestAutoSave()` で保留を立てるだけで、そのシーンで最初の本文が表示されゲートが開いた時点（`pushSnapshot` → `flushAutoSave`）に1回保存する（#768）。入場直後は `[待機: 表示完了]` 等でゲートが閉じていることがあり、その瞬間に保存すると黙って弾かれるため。保存位置はその本文の位置で、宣言的復元は待機を再実行しないので、ロードすると待機を挟まずその本文から再開できる。冒頭が Jump だけの中継シーンや選択肢のシーンは本文が無いので保存されず、遷移先の本文で保存される。保留は次の入場・復元・新規開始・はじめからで破棄される。NovelPlayer の F5 ハンドラは `quickSave()` を呼ぶだけで、自動セーブは `quickSave('auto')` を呼ぶ。非同期失敗は世代チェックの後に `initialized` も確認し（`SceneEntryController.enter` の1か所、`host.isActive()`）、destroy 後の reject で破棄済みの overlay にトーストしない。`restoreSnapshot` 系は自動復元でプレイヤー操作起点でないためトーストを出さず警告ログのみ。ロード／セーブメニューのコールバックも、表示中に裏で遷移が始まった場合に備えて確定時に `transition.isGated()` を再確認し、拒否時はトースト（「場面転換中のためセーブ／ロードできません」）で通知する（オーバーレイは確定後に必ず閉じるため、無通知だと保存・ロードされたと誤認する）。

「はじめから」ボタン（`onNewGame`）は常に `NovelPlayerHandle.startFrom({})` を呼ぶ（PR5 で `restart()` から置き換えた。クイックセーブの有無に関わらず最初から始める仕様のため、この分岐は不要）。

**「はじめから」が旧セーブを引きずる不具合の修正（#637）**（以下は当時の経緯。`restart()` は #734 PR5 で廃止し、`startFrom({})` に置き換わった。新規開始は flags の置換と `currentSceneId` のエントリへの揃えを必ず行う）: `restart()` は元々 `rawEvents`/`eventIndex` 等のみをリセットし、`gameState`（フラグ）と `currentSceneId` には触れなかった。一方 GUI 起動時の自動クイックロード（#578、上記）はタイトル画面が表示される前に裏で `quickLoad()` を実行し、`gameState.flags` と `currentSceneId` を旧セーブの値で埋めてしまう。そのため「はじめから」を押しても Condition 分岐が旧フラグのまま解決され、「つづきから」相当の内容になっていた。`restart()` は `setScenes()` と対称に冒頭で `gameState.clear()` を呼び、`currentSceneId` を `allScenes[0]?.id ?? null`（エントリ doc の先頭シーン）にリセットするよう修正した。さらに `restart()` は `onSceneChangeCallback` を発火しないため自動クイックセーブが走らず、旧クイックセーブが残ったままリロードすると復活してしまう。これを防ぐため `NovelRenderer.clearQuickSave()`（`SaveManager.deleteQuickSave()` の薄いラッパー）を新設し、`onNewGame` から `restart()` と併せて明示的に呼ぶ。

**「はじめから」が直前ルートを再生してしまう不具合の修正（#662）**（`restart()` は #734 PR5 で `startFrom({})` に置き換わった。新規開始の 'entry' も `entryRawEvents` を再生する）: `rawEvents` は Condition 展開前の元イベント配列を保持する単一の可変フィールドで、`quickLoad()` → `restoreToScene()` が復元先シーン（例: 近視ルート）の `scene.events` で上書きする。#637 修正後も `restart()` はこの `rawEvents` をそのまま再生していたため、`currentSceneId` こそ `allScenes[0]` にリセットされるものの、実際に再生される events は自動 quickLoad が上書きした直前ルートのままになっていた（クイックセーブが存在する時だけ発生するため再現が不安定に見えた）。修正として `NovelRenderer` に `entryRawEvents`（エントリ文書本来の events のスナップショット）を新設し、`setEvents()`（`NovelPlayer` がエントリ doc の events を供給する唯一の公開経路）でのみ更新するようにした。`quickLoad`/`restoreToScene`/`jumpToScene` 経由の `rawEvents` 上書きは `entryRawEvents` に一切影響しない。`restart()` は `rawEvents` の代わりに `entryRawEvents` を再生するよう変更し、これにより `resetAndStartEvents` が `rawEvents` 自体も entryRawEvents のコピーへ戻す。

**fluid 再マウント時の `allScenes` staleness 修正（#667）**: `PlayerScreen.tsx` の `resolveMissingScene()` は、マルチMD構成でシーンIDが初回ロード分に見つからないとき対象ファイルを遅延ロードし `buildSceneIndex` で `scenes` を再構築するが、この結果は元々 `loadedDocsRef`（実際に `NovelPlayer` へ渡る参照）にしか反映されず、`allScenes`（`NovelPlayer` へ `jumpSceneIndex=` として渡る React state。上記 L121 参照）は初回ロード時のスナップショットのまま更新されなかった。通常再生ではこの state は再利用されないため無害だったが、fluid（`aspect_ratio: auto`、#442・上記）プロジェクトで画面幅リサイズが向きカテゴリ境界を跨ぐと `NovelPlayer` が丸ごと再マウントされ、その時点の props（＝この `allScenes` の古いスナップショット）で新しい `NovelRenderer` がゼロから初期化されるため、遅延ロード済みだったはずの現在ルートを新レンダラーが見失い `findSceneById` に失敗する事故があった。修正として `resolveMissingScene()` は `buildSceneIndex` 再構築の直後に `setAllScenes(scenes)` を呼び、React state 側も同時に最新化するようにした。`buildSceneIndex` は毎回 `loadedDocsRef.current` から全件再構築するため、複数呼び出しが並行しても `setAllScenes` される値は常に非減少（ref はロード済み doc を削除しないため後から解決したものほど同等以上に完全）で、競合による巻き戻りは起きない。なおこの `setAllScenes` 追加は、`NovelPlayer` 側で `events`/`scenes`/`jumpSceneIndex` を1つにまとめていた既存 `useEffect` を誤って再実行させ、`jumpToScene()` のたびに `events` 自体は不変でも無条件の `setEvents()` が発火してプレイ中のシーンが entry doc 冒頭まで巻き戻るリグレッションを誘発した（セルフレビューmust M1で発見）。修正として当該 effect を `jumpSceneIndex` 専用と `events`/`scenes` 専用の2つに分離し解消した。

**「設定」ボタンが実際に設定パネルを開くようになった（#643）**: 元々 `onOpenSettings` は `setTitleDismissed(true)` を呼ぶだけの暫定実装（#141由来のTODO）で、押すと設定パネルを開かずにタイトルを閉じてゲームが始まってしまっていた。`NovelPlayer` を `forwardRef` 化し `NovelPlayerHandle`（`openSettings()`。#734 PR5 で `ensureAudioContext`・`setDocKey`・`hasQuickSave`・`clearQuickSave`・`startFrom` を追加）を公開、`PlayerScreen` の `titleScreen.onOpenSettings` から `novelPlayerRef.current?.openSettings()` を呼ぶように変更した。タイトル画面（PixiJS `TitleScreenOverlay`）は閉じずに表示したまま、その上にDOM `SettingsOverlay` を重ねて開く。閉じるとタイトルへ戻る。

**deep-link/デバッグ起動時は自動クイックセーブの配線自体を行わない（#664）**: （なお現在の自動セーブは、`onSceneChange` が `requestAutoSave` で保留を立て、最初の本文の表示時に保存する #768。以下は #664 当時の経緯）`?scene=`（`initialSceneId`）単独埋め込みは `PlayerScreen` がタイトル画面を出さず `NovelPlayer` の mount effect が `renderer.startFrom({ sceneId })` を同期的に呼ぶが、この呼び出しが `startScene()` 経由で `onSceneChangeCallback` を発火させ、`docKey` があれば即座に `quickSave()` が走っていた。つまり実プレイ中に kako-jun がデバッグ目的で `?scene=` URL を踏むと、その時点で直前セッションの正当なクイックセーブが黙って上書きされる footgun があった（`?debug_scene=`/`?debug_script=` 経由の `startFrom`/`playScript`→`jumpToScene` でも同様）。修正は `NovelPlayer.tsx` の mount effect 側: `parseDebugQuery(window.location.search)` を早めに1回だけ評価して `debugQueryResult` を変数化し、`hasDeepLinkOrDebugStart = !!initialSceneId || debugQueryResult !== null` を判定、真の間は `renderer.setOnSceneChange(...)` の配線自体をスキップする。`NovelRenderer` 側は無変更（`onSceneChangeCallback` が null のままなので `startScene`/`setScenes` からの発火は何も呼ばない）。#734 PR2 以降は、通常起動でも自動クイックセーブの配線は初期入場が確定した後に行う（初期入場の `onSceneChange` が、有効なクイックセーブをエントリ冒頭の位置で上書きしないため）。自動クイックロードが通信失敗（`resolver-error`）で倒れたセッションは配線せず、renderer の `showToast` でその旨を知らせる（一時的な失敗で正しいセーブを消さない。`not-found`＝原稿が変わってセーブのシーンが消えた場合は、もう戻れないセーブなので通常どおり配線する）。手動セーブ（3スロットメニュー / F5）は `quickSave()` を直接呼ぶ別経路のため影響を受けない。通常プレイ（`?scene=`/`debug_scene`/`debug_script` 無し）の自動クイックセーブ挙動は不変。

**`header: hidden` プロジェクト、および embedded（iframe埋め込み）ではタイトル画面の「終了」ボタンを非表示にする（#643、embedded軸はセルフレビューshouldで#647にて追加）**: 「終了」は `onBack`（ヘッダのバックボタンと共有のハンドラ）経由で name-name トップページへ戻る。`header: hidden`（`PlayerScreen.tsx` の `normalizeHeaderMode`）で name-name 自身のブランディングを隠しているプロジェクト（Gymnasia等）では、タイトル画面から name-name トップへ戻れてしまうのは設計として矛盾するため、`TitleScreenOverlay.show()` に `showExitButton?: boolean`（既定 `true`）を追加し、`false` のときは「終了」を `disabled` ではなく `buttonSpecs` から除外（非描画）する。`PlayerScreen` のヘッダ描画ゲート（本ファイル上記、L762-771相当）は `!embedded && headerMode === 'visible'`（`embedded` は `isEmbedded()`、iframe埋め込み判定）で、embedded時はheaderModeに関係なく常にヘッダ非表示（name-nameトップへ戻る導線は埋め込み文脈で無意味・没入破壊のため）。「終了」ボタンの表示条件もこれに揃える必要があり、`PlayerScreen` は `showExitButton: headerMode !== 'hidden' && !embedded` を渡す（headerMode単体では、embedded かつ headerMode が visible/collapsed のプロジェクト＝theo-hayami等の埋め込みで、ヘッダは出ないのに終了ボタンだけ残り押すと埋め込み文脈から離脱してしまう不整合があった）。非表示時は #640 のキーボードフォーカス巡回（Tab/矢印）も残りのボタンだけを正しく循環する。

## 音声システム

Web Audio API を使用。

### TUI版の音声再生 (#502)

GUI版とは別実装。`tui/src/audio.rs` の `AudioPlayer` が rodio（cpalベースの pure Rust
オーディオライブラリ）で BGM のループ再生・SE のワンショット再生（複数同時再生可）を行う。
`Event::Bgm`/`Event::Se` の状態追跡自体は `tui/src/playback.rs`（`Playback` の
`item_bgm`/`item_se`、GUI版 `currentBgmPath`/`playSe` と同じ意味論）にあり、`main.rs` の
`event_loop` が毎フレーム `sync_bgm`/`play_new_se_cues` でその状態を実際の再生呼び出しに
変換する。GUI版との既知の差分:

- **フェード無し**: `fade_ms` は解析時点で読み捨てる（#512 暗転の「TUIはフェード無しの
  瞬時切替」という判断基準を踏襲）。BGM 切り替え・停止は常に即時。
- **音声出力デバイス無し環境への配慮**: `AudioPlayer::try_new(...)`（`OutputStream::
  try_default()` に失敗すると `None`）・ファイル未検出/デコード失敗のいずれも、エラーに
  せず音声再生だけを無効化して進行を続ける（SSH経由・headless環境等を想定）。
- **ALSA/JACKログの抑制（#559）**: デバイス無し環境では ALSA/JACK が C レベルで直接 stderr
  にエラーログを書き込み、raw mode の alternate screen 画面と衝突して乱れる。
  `with_stderr_suppressed`（`tui/src/audio.rs`）が `try_default()` 呼び出し中だけ fd 2 を
  `/dev/null` へリダイレクトして抑制する。
- **BGM/SE音量制御（#503/#536/#537）**: 設定画面（`Overlay::Settings`）から BGM/SE 音量を
  5%刻みで調整でき、`AudioPlayer::set_bgm_volume`/`set_se_volume` に即時反映される。加えて
  起動時（設定画面を一度も開いていない状態）の音量も `config.volume.bgm_percent`/`se_percent`
  （`tui-config.toml` の `[volume]`）から必ず反映される——`AudioPlayer::try_new` が
  `&config::VolumeConfig` を必須引数として要求し、生成と同時に音量を計算してフィールドへ
  埋め込む設計（#537、以前は生成後に別関数で同期する2段階設計で、その呼び出しを削除しても
  テストが気づけない構造的な穴があった。`try_new` のdoc comment参照）。ボイス音量
  （`voice_percent`）は値の保持のみでバックエンド未反映（TUIにボイス再生コード自体が
  無いため、`config::VolumeConfig` の doc comment参照）。動画ミックス・エクスポート用
  キャプチャ配線は対象外。
- **SE複数候補プールのランダム抽出+シャッフル+ランダム間隔再生（#672）**: `Event::Se` の
  `paths`（複数件）/`count`/`gap_min_ms`/`gap_max_ms` は `Playback::item_se`（`SeCue`、選択・
  シャッフル前の生の記述）にそのまま保持され、実際のランダム抽出は `main.rs::
  select_and_resolve_se_paths` が再生トリガのたびに新規計算する（`tui/src/se_selection.rs`
  の純粋関数、GameStateに選択結果を焼き込まない）。`AudioPlayer::play_se_sequence` が
  gapの待機を別スレッドで行うため、TUIのキー入力ループはブロックされない（各再生は
  `play_se` と同じ fire-and-forget）。**SEシーケンスのキャンセル（#672フォローアップ）**:
  背景スレッドはシーンが実際に切り替わった瞬間（`main.rs::event_loop` が
  `playback.current_scene_idx()` の前後比較で検出、選択肢ジャンプ含む）に
  `AudioPlayer::cancel_se_sequence()` でキャンセルされる。世代カウンタ
  （`se_selection::SeSequenceGeneration`、GUI版 `AudioManager.seSequenceGeneration` と同じ
  generation-based cancellation）を進めるだけで、実行中の全スレッドは次のチェックポイント
  （gapの `thread::sleep` が明けた直後）で自ら停止する——`AudioPlayer` 自体が実デバイス
  依存でCI環境では構築できないため、世代カウンタの増分・比較という中核ロジックだけを
  `SeSequenceGeneration` として切り出しデバイス非依存にテストしている。
- **オート進行ウェイト設定項目の追加（#644、GUI版とのパリティ）**: `SettingsField` enum
  （`TextSpeed`/`BgmVolume`/`SeVolume`/`VoiceVolume` の4項目）に `AutoWaitMs` を
  `TextSpeed` の直後（GUI版 `Settings` interface の並び順に対応）に追加し、5項目に
  拡張した。オートモードの待機時間 `config.auto_wait_ms`（既定2500ms）を設定画面から
  実行時に調整できる。範囲は 500..10000ms・500ms刻み（`AUTO_WAIT_MIN_MS`/
  `AUTO_WAIT_MAX_MS`/`AUTO_WAIT_STEP_MS`、`tui/src/config.rs`）。以前は
  `tui-config.toml` 起動時設定としてのみ存在し、設定画面からの調整手段が無かった
  （GUI版 `SettingsOverlay.tsx` の「オート進行ウェイト」スライダーに相当する項目が
  TUI側に欠けていた）。GUI版スライダーも本Issueで同じ範囲・刻み（500-10000ms・
  500ms刻み）に統一した（元は500-8000ms・100ms刻みで、100ms刻みはTUIのキー操作には
  細かすぎるとkako-junが判断し、GUI側をTUIに合わせた）。

### BGM

- ループ再生
- 曲切り替え時はフェードアウト → 新曲開始
- `[BGM停止]` でフェードアウト停止
- **シーンジャンプでは持ち越す（#724）**: `NovelRenderer.resetAndStartEvents` は独立オプション `carryBgm`（背景持ち越しの `preserveBackgroundForTransition` とは別。進行の入場〔`SceneEntryController`〕が `carryPolicyFor('progress')` から導出して渡す）のとき `audioManager.stopBgm(0)` と `currentBgmPath = null` を実行しない。次シーン冒頭の同一曲 `[BGM:]` は `AudioManager.playBgm` の同一 URL 継続分岐で頭出しされない。`setEvents` / 終劇（`endStory`）、`startFrom`（`?scene=` / `?debug_scene=`）、動画書き出し（`startFrom`）の新規開始では従来どおり停止する。無音にしたいシーンは冒頭で `[BGM停止]`。`NovelGameState.currentBgmPath` はジャンプ後もそのまま整合し、snapshot / seek / save / load で復元される

### SE

- ワンショット再生
- 複数 SE の同時再生対応
- **複数候補プールのランダム抽出+シャッフル+ランダム間隔再生（#672）**: `Event::Se` の
  `paths` が複数件のとき、`seSelection.selectAndShuffleSeFiles(paths, count)` が発火の
  たびに重複無しでK件抽出+シャッフルし（`count` 省略時は全件）、`AudioManager.
  playSeSequence(urls, gapMinMs, gapMaxMs, fadeInMs)` が選択済み順に、`gap_min_ms`/
  `gap_max_ms`（省略時のランタイム既定 50-200ms）の範囲で `seSelection.randomGapMs` が
  決めたランダム間隔を挟みながら再生する（1件のみ＝従来通りの単発再生、後方互換）。
  各再生は `playSe` と同じ fire-and-forget（gapがクリップ長より短ければ複数SEが重なって
  鳴る意図的な挙動）。選択・シャッフル順序はどこにも永続化せず、`NovelRenderer.
  processDirective` から呼ばれる `directives/audioDirectives.ts` の `Se` ハンドラ（#829）が `Se` イベント発火のたびに新規計算する（doctrine 規律3）。
  **gap待機のキャンセル（#672フォローアップ）**: `playSeSequence` の gap 待機は
  `AudioManager` に注入された `TimeController`（`NovelRenderer.time` を共有）経由の
  `setTimeout` で行い、世代カウンタ（`seSequenceGeneration`）ベースでキャンセル可能にした
  `AudioManager.cancelSeSequence()` を `NovelRenderer` の他の全タイマー（wait/auto/skip/
  shake/toast/intermission 等）と同じ規律で `resetAndStartEvents`（シーン遷移）・
  `endStory`（終劇）・`applyState`（goBack/seekTo/セーブロード）・`AudioManager.destroy()`
  （`NovelRenderer.destroy()` 経由）から呼ぶ。導入当初はこの規律から漏れており、シーン
  遷移後もgap待機中の残りSEがバックグラウンドで鳴り続けるギャップがあった（テスト設計
  フェーズで発見、是正）。TUI版 `AudioPlayer.cancel_se_sequence()`（`tui/src/audio.rs`、
  上記TUI節参照）も同じ generation-based cancellation で対称に実装されている。

### AudioBuffer キャッシュ

- 一度デコードした AudioBuffer をキャッシュ
- ユーザーインタラクション制約（autoplay policy）に対応

### 動画エクスポート用キャプチャ (#228)

- `AudioManager.enableCapture()` で `MediaStreamAudioDestinationNode` を生成し、`bgmMasterGain` / `seMasterGain` を分岐配線する
- 通常の `ctx.destination` への配線は維持されるため、録画中もスピーカーで音をモニタできる
- 別アプリの音声・他ブラウザタブ・システム音は混入しない（Web Audio グラフ内の音のみキャプチャ）
- `disableCapture()` で MediaStream destination を切断する

## 動画エクスポート (#228)

llll-ll-media など、シナリオを動画ファイルとして書き出す用途のための Phase 1 実装。

### 方式: MediaRecorder リアルタイム録画

```
canvas.captureStream(fps) ─┐
                            ├─ MediaStream ─ MediaRecorder ─ Blob (video/webm)
AudioManager.enableCapture ─┘
```

- 映像: `<canvas>` 要素の描画フレームのみキャプチャ
- 音声: AudioManager の master gain 経由音のみキャプチャ
- 出力: WebM（VP9/opus 優先、VP8 フォールバック）

### モジュール構成

| ファイル                                  | 役割                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `frontend/src/game/VideoExporter.ts`      | `exportVideo()` / `pickSupportedMimeType()` / `downloadBlob()`                                          |
| `frontend/src/game/AudioManager.ts`       | `enableCapture()` / `disableCapture()`                                                                  |
| `frontend/src/game/NovelRenderer.ts`      | `getCanvas()` / `getAudioManager()` / `getCurrentSceneId()` / `getAllSceneIds()` / `setOnSceneChange()` |
| `frontend/src/components/NovelPlayer.tsx` | `onRendererReady` prop                                                                                  |
| `frontend/src/screens/EditorScreen.tsx`   | 録画ボタン + モーダル UI                                                                                |

### 終了検出

`exportVideo` 開始時に `setOnSceneChange` を上書きし、以下のいずれかで `MediaRecorder.stop()` する:

1. シーンが一度 `endSceneId` になり、その後別シーンへ遷移した
2. `renderer.onEnd` が発火（全イベント完走、`endSceneId` が最終シーンだったケース）

stop 後に `postRollMs` (デフォルト 1200ms) の余韻録音を経て Blob を確定する。BGM 既定フェード 1000ms を完全に録音するための値。
新規開始（`startFrom`）の結果を await し、`entered` 以外（開始シーン不在・resolver 失敗・適用例外・`superseded`）なら録画を始めず reject する（isExporting・解像度・SeekBar 抑制・リスナ退避・autoMode は cleanup で必ず戻す）。`VideoExportOptions.flags`（既定は空＝決定論的）を `startFrom` に渡し、使った flags を `onProgress` に出す。エディタの書き出しダイアログの「プレビューの flags を引き継ぐ」（既定 OFF）が ON のときだけ、`resolveExportFlags` がプレビューの flags を複製して渡す。続けて開始シーンの背景のロード完了を待ち（上限 10 秒。超えたら `console.warn` して録画を始める）、録画開始前の待ち中に終端（`onEnd` など）を検知したら録画せず reject し、予約済みの停止 timer も取り消す。書き出す範囲（開始〜終了シーン）は、ジャンプ・選択肢でつながったシーン間と、線形に連結したシーン間（エントリ文書でシーンが続く並び）の両方で効く。書き出しは `startFrom` を `linear: true` で呼ぶ（#817）。`linear: true` の `startFrom` は、開始シーンがエントリの線形ストリーム上にあれば、そのシーンの events だけでなくストリーム全体をシーン先頭から流し、シーン境界の `SceneTransition` を通過するたびに入ったシーンの ID で `onSceneChange` を発火する（#777、ADR 0003「#777 での追記」）。作者の `[場面転換]`（シーン内）は境界ではない。ジャンプ・選択肢で入ったシーンはそのシーンの events だけが流れるので、その先で線形に続くシーンへは進まない。選択肢・中止・停滞は下記「書き出しの終わり方」で扱う。その後 `preRollMs` (デフォルト 50ms) の遅延を挟んで「前回プレビューの最終フレーム」と「BGM 頭欠け」を最小化する。AudioContext のバッファ遅延 20-50ms を吸収する目安。

### VideoExporter が依存する公開 API

| メソッド                                                                                            | 役割                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `NovelRenderer.getCanvas()`                                                                         | `canvas.captureStream(fps)` の対象を取得                                           |
| `NovelRenderer.getAudioManager()`                                                                   | AudioManager 経由で音声 MediaStream を分岐                                         |
| `NovelRenderer.startFrom({ sceneId, flags, linear: true })` | 新規開始。`linear: true` で、線形に続くシーンをストリーム全体で流す（範囲指定が終了シーンの末尾まで続く, #817）。BGM・背景・flags・`consecutiveJumps` を持ち越さない。結果が `entered` 以外なら export を reject し、cleanup を通す |
| `NovelRenderer.isAutoMode()` / `setAutoMode()` | 書き出し中だけオートモードを入れ、cleanup で書き出し前の値へ戻す |
| `NovelRenderer.getSnapshot()` | `resolveExportFlags` がプレビューの flags を複製して取り出す（引き継ぎ ON のときだけ） |
| `NovelRenderer.getExportProgress()` | 停滞検出用の軽量な進行状況（位置の署名・`[待機: N]` の N・終わりのある動画の再生中か）(#780) |
| `NovelRenderer.getPendingChoice()` / `selectPendingChoice(jump)` | 選択肢待ちの遷移先とロック状態の取得、ロックされていない option の確定（`ChoiceOverlay.selectByJump` 経由で、クリックと同じ確定経路 `confirmChoiceJump` と確定音を通る）(#780) |
| `NovelRenderer.prepareVideosForExport()` | 録画開始前に動画レイヤを頭出しする |
| `NovelRenderer.waitForBackgroundLoad()` | 開始シーンの背景ロード完了を録画開始前に待つ（新規開始は背景が地色から始まるため） |
| `NovelRenderer.setOnSceneChange()` / `takeOnSceneChange()`                                          | 終端検出用のリスナ占有と退避復元                                                   |
| `NovelRenderer.setOnEnd()` / `takeOnEnd()`                                                          | 全イベント完走の検出用、退避復元（VideoExporter は登録も復元も `setOnEnd` に統一） |
| `AudioManager.enableCapture()` / `disableCapture()`                                                 | 音声 MediaStreamAudioDestinationNode の分岐管理                                    |
| `VideoExporter.exportVideo()` / `pickSupportedMimeType()` / `sanitizeFilename()` / `downloadBlob()` | エクスポートの本体と補助関数                                                       |

UI 側からは `NovelRenderer.getCurrentSceneId()` / `getAllSceneIds()` も使えるが、EditorScreen は doc から直接シーン ID 一覧を作っているので未使用。

`take*` 系は破壊的 getter（取り出し後 null クリア）。VideoExporter 内部で同 renderer に対する並行起動を防ぐため、モジュールスコープで `isExporting` フラグも持つ（HMR で再ロードされた場合のみリセットされる。録画中はソースコードを触らないこと）。

### 書き出しの終わり方 (#780)

録画開始後、`EXPORT_POLL_MS`（250ms）ごとに選択肢と進行位置を見張る。判定の計算は純粋関数 `videoExportPolicy.ts`（`isSceneInExportRange` / `pickAutoChoice`（`ExportChoiceMemory` で辺を記憶）/ `computeStallLimitMs` / `exportProgressSignature`）に置き、`exportVideo` が配線する。

| 状況 | 動作 | `endReason` |
| --- | --- | --- |
| 終了シーンを抜けた／全イベント完走 | 余韻録音（`postRollMs`）のあと停止して保存 | `scene-end` / `story-end` |
| 選択肢に到達し、範囲内で**まだ選んでいない辺**（選択肢〔元の Choice イベントの同一性。`[条件:]` の再展開や入場経路が変わっても同じ〕× 遷移先）のロックされていない遷移先がある | 選択肢を `EXPORT_AUTO_CHOICE_DISPLAY_MS`（1.5 秒）映してから、先頭のものを確定音つき（クリックと同じ経路）で自動選択して続行。辺が全部選び済みでも、その先（見た選択肢と、`[ジャンプ:]`・線形の続きなど選択肢を経由しない遷移をたどって）に未選択の範囲内の辺へ行けるものは選ぶので、ハブ→サブメニュー→各ルート→ハブの構成でもサブメニューの全ルートを回る（最大 `EXPORT_MAX_AUTO_CHOICES`=50 回は保険） | （続行） |
| 選択肢に到達し、範囲内の遷移先が無い／辺がすべて選び済みで先にも未選択の辺が無い（または自動選択が上限） | 選択肢を `EXPORT_CHOICE_HOLD_MS`（3 秒）映してから終端扱いで停止・保存 | `choice-end` |
| 本文・選択肢が `EXPORT_STALL_TIMEOUT_MS`（60 秒）進まない | タイムアウトで停止・保存。理由をモーダルに表示。`[待機: N]` 中は N ms を加えた長さ、終わりのある（loop でない）動画の再生中は停滞とみなさない。選択肢を受け付けられないまま固まった場合もここで終わる | `stalled` |
| 中止（モーダルの「中止」） | `AbortSignal` で録画を止めて**破棄**（ファイルは保存しない）。`ExportAbortedError` で reject し、cleanup は通常どおり走る | — |

終了理由は `VideoExportResult.endReason` / `endMessage` で返り、エディタがモーダルに表示する。中止は録画前（準備中。背景ロード・動画頭出しの待ちの途中を含む）でも効き、`EditorScreen` がアンマウントされる（戻る・プロジェクト切替・設定/アセット画面）と実行中の書き出しも自動で中止する（破棄済みのレンダラ〔`isReady()` が false〕には後始末で触らず、画面の state も更新しない）。録画前の中止では、遅延ロード中の `startFrom` を `cancelPendingEntry()` で取り消し（世代を進めたうえで、`[ジャンプ:]` の予約など遷移状態を現在位置から導き直す）、後から解決してプレビューを書き換えないようにする。

選択肢を経由しない遷移（`[ジャンプ:]`・線形の続き）をたどる到達判定は経験則で、実際に起きた遷移（`onSceneChange`）を記録して使う。そのため、`[条件:]` に囲まれた `[ジャンプ:]` のように、flags 次第で起きなくなる遷移も「行ける」とみなし、選び済みの辺を選び直すことがある（自動選択の上限 `EXPORT_MAX_AUTO_CHOICES` で止まる）。

書き出しはプレビューのレンダラを使うので、完了・中止・失敗のあともプレビューは書き出しの開始シーンの位置に移ったままで、書き出し前の位置には戻らない(現状の仕様。戻す実装は未対応)。選択肢に到達した時点を進行とみなすので、長い `[待機: N]` の直後でも停滞と誤判定しない。

「範囲内」は**編集中の doc のシーンだけ**が対象で（他の .md のシーンは `sceneOrder` に無く、範囲外として扱う）、`[待機: 表示完了]` のように待ち時間が決まっていない待機は通常の停滞時間で判定する。

### Phase 1 の制約

- **実時間がかかる**: シナリオ 3 分なら録画も 3 分。virtual time 化していないため
- **中止は破棄**: 録画中の「中止」は録画を捨てる（途中までの保存はしない）。長尺録画は事前に範囲を確認すること
- **WebM のみ**: mp4 変換は Phase 2 で ffmpeg.wasm を追加する
- **タブ非アクティブで品質劣化**: ブラウザが rAF を間引くと PixiJS Ticker が薄まり、描画フレームが捨てられる。録画中はタブをアクティブに保つ必要がある
- **コールバックの占有**: `setOnSceneChange` / `setOnEnd` を録画中に上書きするため、録画中の手動操作と競合する想定はしていない
- **多重録画不可**: モジュールスコープの `isExporting` フラグで防衛しているが、HMR (Vite dev) でファイル保存すると false にリセットされる。録画中はソースを触らない

### Phase 2 構想

決定論的 virtual time 経路（`TimeController` 既設）+ `OffscreenCanvas` 毎フレーム render + ffmpeg.wasm 連結。Phase 1 のモジュール境界 (`VideoExporter`) を保ったまま実装本体を差し替える想定。

## RPG サブシステム

RPG プレイモードもノベルと同じく PixiJS で実装する（Phaser から移行済み）。
レンダラーは 2 種類:

- `frontend/src/game/TopDownRenderer.ts` — 見下ろし型（デフォルト）。グリッド単位のステップ移動で編集との対応が取りやすい
- `frontend/src/game/RaycastRenderer.ts` — 一人称レイキャスト型。DDA 方式で縦ストライプ描画、距離フォグ、NPC は距離ソート billboard

`RPGPlayer` は `view` prop（`'topdown' | 'raycast'`）でどちらを使うかを受け取り、シーンヘッダー `[view=...]` の値がそのまま伝わる。MapEditor は編集性を優先して常に TopDown を使う。

**アセットのベース URL (#746)**: RPG の画像パス（NPC スプライト・NPC 顔・戦闘スプライト・戦闘背景/前景）は、`PlayerScreen` / `EditorScreen` / `MapEditor`（プレビュー）が `${apiBaseUrl}/api/projects/{name}/assets/raw` を `RPGPlayer` の `assetBaseUrl` prop に渡し、`RPGPlayer` が `renderer.load()` の直前に `setAssetBaseUrl()` で renderer に伝える。renderer 側は `RaycastRenderer`（NPC は `loadNpcSpriteSheet`、顔は `DialogBox.show`、戦闘は `BattleScreen` の `assetBaseUrl` オプション）と `TopDownRenderer`（NPC・顔に加え、戦闘スプライト・背景・前景にも適用。戦闘は両レンダラーとも `fieldBattle.ts` の `openFieldBattle` に `assetBaseUrl` 引数で渡す #784）。計算は純粋関数 `novelLayout.ts` の `resolveRpgImagePath` が正本（相対パスは `{base}/images/{path}`、絶対 URL・先頭 `/`・`__demo` は不変、ベース URL なしはパスそのまま）。

### RPGProject データモデル

`frontend/src/types/rpg.ts` に定義：

- `MapData` — `width` / `height` / `tileSize` + 2次元配列の `tiles`（`TileType` = GRASS / ROAD / TREE / WATER）+ `wallHeights?: number[][]`（Issue #49 Phase 1）+ `floorHeights?: number[][]`（Issue #84、踏み込むとカメラ高さが上がる）+ `ceilingHeights?: number[][]`（Issue #87、ジャンプの頭ぶつけ判定）
- `PlayerData` — 初期グリッド座標と向き（`up` / `down` / `left` / `right`）
- `UiNpcData` — UI / runtime 側の NPC 型（parser 側 `NpcData`（WASM 経由スキーマ、`frontend/src/types.ts`）から `rpgProjectFromDoc` 変換層で詰め替える）。フィールド追加時は parser / UI / 変換層の 3 箇所を揃える #103。グリッド座標・名前・会話メッセージ・表示色・オプション: `sprite`（スプライトシートパス）・`frames`（歩行アニメフレーム数 / 方向あたり、未指定なら 2）・`direction`（アイドル時の向き、未指定なら `down`）
- `RPGProject` — 上記の集合（+ 将来の `EventData`）
- `RPGProject.battleLayout` / `battleBackground` (#736) — 戦闘画面のレイアウト（`'front'` 既定 / `'side'`）と背景画像パス。frontmatter `battle_layout:` / `battle_background:` が parser（`Document`）→ `normalizeDocument` → `rpgProjectFromDoc` → `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `layout`/`background` オプションへ流れる。サイドビューの座標計算は純粋関数 `frontend/src/game/battleLayout.ts`（`computeSideBattleLayout`）が正本で、`BattleScreen` は描画だけを担う。`BattleEntity.sprite` は戦闘への組み立て時（`rollEncounter` / `fieldBattle.ts` の `partyDefToBattleEntity`）に `MonsterDef`/`PartyMemberDef` の `sprite` から写す。`battleEngine.ts` は変更しない。`front` ではエンジンに先頭 1 人だけ渡す（従来どおり）が、`side` では `party` 全員を渡す（hero 定義があれば先頭、無ければ定義順。`RPGProject.partyOrder` が定義順の正本で、整数風 ID でも `Object.keys` に並べ替えられない）。`battleLayout.ts` は敵ラベル矩形・ログ行数（敵数で 2〜4）・省略関数（`fitLabel`）・コマンドのフォントサイズ（`fitCommandFontSize`）・フォールバック矩形も純粋関数で返し（複数体の列数は「3 体まで 1 列・4 体以上は 2 列」を下限に `SIDE_READABLE_SPRITE_SIZE`〈HP 行の概算幅から導出した約 64px〉に届く最小の列数、届かなければ全体で最大サイズの列数。ラベル幅は 1 列なら領域幅まで（上限はスプライト一辺の `SIDE_LABEL_MAX_WIDTH_RATIO`=3 倍）・多列は列ピッチまで。幅が `SIDE_LABEL_MIN_WIDTH`（HP 数値「12/12」が入る幅）未満のラベルは置かない。`fitHpLabel` は HP 行を「HP 」より数値優先で省略。ラベルを置くとスプライトが潰れるほど低いときはラベルだけ省く）、`BattleScreen` は結果を使うだけ。下パネル右の味方ステータス欄は純粋関数 `computeStatusColumns` が名前 / HP / MP /（ATB ゲージ）の列を求め、4 人で共通（名前の長さで位置がずれない）。HP・MP は「見出し（左寄せ）｜現在値（「/」の直前に右寄せ）｜/最大値（「/」の x で左寄せ）」の 3 つの Text に分け、見出しと「/」の x が全員そろう。名前列が最低 3 文字に届かなければ MP → 見出し → HP の最大値 → ゲージ幅の順に省き、名前は概算幅で詰めたあと実測幅（`Text.width`）でも列幅に収める。戦闘中の画面リサイズは各レンダラーの `handleResize` が `BattleScreen.redraw` へ流す。味方の配置 (#813) は `computeSideBattleLayout` が人数によらず**最低 4 枠固定**（`SIDE_PARTY_MIN_SLOTS`）で、斜め一列の枠の位置・大きさと下パネル（status 行）の高さを 4 人のときのまま保ち、味方は上の枠から順に入れる（空き枠は何も描かない・5 人以上は従来どおり人数ぶん・味方 0 人は枠なし）。枠の幾何（x, y, size, width）は固定の基準縦横比 `SIDE_PARTY_FRAME_ASPECT`=0.8（sit-by-me の ready ポーズ 0.68〜1.00 の実測を踏まえた値）と隊列だけで決まり、誰がパーティにいるか・各自の立ち絵の縦横比には依らない（入力から `partyAspects` は削除済み）。ただし後衛 (#747) が 1 人でもいると右側の予約幅が切り替わるため、後衛の有無で全員の枠と敵の領域が動く（これは明示的な例外）。`BattleScreen` が各立ち絵を自分の枠に contain（縦横比維持・足元中央）で収める（アクリル時は横長の絵を正方形の箱ごと縮める）ので、細い絵も太い絵も枠から出ない。空き枠の隊列は前衛。下パネルも 4 行ぶんなので、小さい横画面（568x320 等）では 1〜3 人でもステージは 4 人ぶんの狭さに固定される（仕様）。前衛・後衛 (#747)・ATB・status 行・演出の基準は同じ枠
- `RPGProject.spriteStyle` (#737) — 戦闘スプライトの表示スタイル（`'none'` 既定 / `'acrylic'`）。frontmatter `sprite_style:` が parser（`Document`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeSpriteStyle`）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `spriteStyle` オプションへ流れる（GUI 専用・TUI は読まない）。パラメータ（透明な余白の幅・枠線の太さ/色/不透明度・台座・影・ハイライト。長さは比率で持ち、小さいスプライトで線が潰れないよう px の下限も持つ）と、枠から台座/影/スプライトの配置を求める計算は純粋関数 `frontend/src/game/spriteStyle.ts`（`resolveAcrylicParams` / `computeAcrylicGeometry`）が正本。`BattleScreen` は結果を使うだけで、画像のある枠に限り Container 内を 台座（接地影込み・`acrylicBase.ts` の純粋関数 `renderAcrylicBase` が幅 512px で一度だけ作る共有テクスチャ。透明な上面・側面の厚み・縁のハイライト・差し込み口のスリット・柔らかい影。`acrylicBaseTexture.ts` がパラメータごとにキャッシュ。canvas が使えない環境では従来の Graphics の黒い台座・影）→ アクリル板（`acrylicPlate.ts` の純粋関数 `renderAcrylicPlate` が、長辺 192px（`PLATE_WORK_MAX_SIDE`）の作業解像度で 1 回だけ作る RGBA ラスタ（1 キャラ約 10ms）。同じ画像（tex.source）の板・影は共有する。スプライトの alpha を box blur 3 回（≒ガウス）でぼかし、しきい値の smoothstep で外へ余白+線ぶん膨らませて板の形にし、縁をアンチエイリアスする。膨らませる前に、足元の帯（高さの約 6%）に触れる列だけを画像下端から `computePlateExtend`（`spriteLiftRatio` × 高さ、切り上げ）行ぶん下へ伸ばす（`extendFootMask`。腕など上の部位は伸ばさない）ので、スプライトの足元が差し込み線より浮いても板の下の縁は差し込み線まで届く（#802）。さらに、台座のスリット幅に当たる中央の列（画像中心 ± スリット半幅＝上面の横半径の 0.5 倍を画像 px に換算。`computeStemSlitHalfWidth`）の中の不透明な画素（alpha ≥ 32）の最下端から画像下端までの距離が画像高さの `stemMinGapRatio`（既定 0.06）以上離れている絵（空を飛ぶ敵・飛行ポーズの味方。中央の下付近が透明。左下の羽根の先だけが下端に届く絵も含む）には、中央の列の最下端付近の重心 x（帯がスリットからはみ出さない範囲に寄せる）を中心に、不透明部分の幅 × `stemWidthRatio`（既定 0.28。0 で無効）の帯状の透明プラスチック（ステム）を、絵の最下端から差し込み線まで板のマスクへ足す（純粋関数 `computeStem` / `stampStem`。帯の幅は枠一辺の 0.14（`STEM_MIN_WIDTH_RATIO`）を下限に持ち、帯の中心はスリット列の最下端の重心と絵全体の最下端の重心の中間（スリット内に収まる範囲）に寄せ、スリットの左右の外側の両方で画像下端（高さの 2% の帯）に画像幅の 3% 以上ずつ接している絵（両側で支えられた接地した二輪の乗り物など）には帯を出さず、帯の左右の縁だけ（上端の丸い角は除く）には帯だけの形から求めたリムを本体のリムとは独立に重ねて、本体の輪郭が近くても埋もれないようにし、上端は絵の最下端より高さの約 5% 上まで食い込ませる。帯の内側の面は `stemFillAlpha`（既定 0.22）で本体の板（`plateFillAlpha`）より濃く、リムも光と反対側で弱くならないよう下限を持たせて、小さい画面でも板で台座とつながって見えるようにする。ぼかし・smoothstep を通るので縁・リム・ハイライトは板と同じ質感で、角は丸い）。距離が小さい絵（地面に立つキャラ）は帯なしで従来と同一の見た目。二輪の乗り物のように地面に立つ絵は、スリットの左右の外側の両方で下端に接していれば接地とみなして帯を出さない（片側だけ接する絵は浮いているとして帯が出る）。alpha の走査は板の生成時に 1 回だけで、結果は板（画像単位）のキャッシュに含まれ GameState には持たない。台座が無いとき（hasBase=false）は出さない。板の外接寸法は変わらないので画面内・非重複の不変条件は崩れない（#848）。既知の制約: (1) propeller のように最下端の羽根の先がスリットの外にある絵は、板がスリットにしか刺さらないため帯が羽根の真下からずれる。(2) 味方の飛行ポーズでは帯が出ない。`computeStemScale` はポーズ画像自身を枠に contain で収めたと仮定してスリット幅を換算するが、実際のポーズ画像は `poseRectOnBase` で基本の絵の縮尺のまま置かれるため合わない。質感は、内側はごく薄い白〜水色の透明面、縁は細い明るいリムで光が当たる左上を強く・反対側を弱く、縁の内側に光と反対側の薄い影、左上寄りの斜めの鏡面ハイライトの筋。canvas↔Texture の橋渡しは `acrylicPlateTexture.ts`。BattleScreen の `makeAcrylicPlate` が呼び、canvas が使えない環境では null＝板なし。テクスチャは mipmap＋linear で、スプライトと同じ倍率（作業解像度ぶんを掛けて）で拡縮して pad ぶん外へ広げて敷く。台座のスリットの高さ `computeSlitY` で水平に切る mask は板の兄弟 Graphics で、本体の足元は切らない）→ スプライトの順に積む（子の順は fallback → 台座 Graphics → 台座スプライト → 板 → 板の mask → スプライト。v8 では Sprite に子を足せない）。さらに本体（シルエット＋板の形）の地面の影は、板と同時に作るぼかしテクスチャ（`acrylicShadow.ts` の `renderGroundShadow`）を `shadowLayer`（sideStage の直下・全スプライトより下）へ敷き、足元を pivot に `computeShadowTransform`（縦に `castSquash` 倍つぶし `castShear` だけ右へ傾ける）で変形する（#760。acrylic のときだけ）（#760 で旧 `AcrylicEdgeFilter`＝描画解像度で alpha の段差をなぞる方式を廃止。縮小後のテクスチャ上で動くためジャギーが出た）。板は画像ごとに 1 回だけ作り、再配置では位置と倍率だけ更新する。`battleLayout.ts` の座標は変えず、台座・影・スプライトは slot 枠の下端に収める（台座の側面の厚みは `computeAcrylicGeometry` が下に予約。板だけは余白+線ぶん枠の外へ広がる）。スプライトの下端（靴の底）は差し込み線より `spriteLiftRatio`（スプライト高さに対する比率・既定 0.03・0〜0.15 に丸める・非有限は既定）ぶん上に浮かせ、`computeAcrylicGeometry` がその分スプライトを縮めて `liftPx` を返す（接地影は `liftPx` を足して差し込み線の高さに残す。台座が無い＝hasBase=false のときは効かない。style=none は変わらない。`spriteLiftRatio=0` でも足元は台座の中心でなく差し込み線に置かれるので、#802 以前の見た目＝約 0.28×台座の縦半径だけ下には戻らない。#802）。パラメータ上書きは `BattleScreenOptions.spriteStyleParams`（コード側のみ）
- `RPGProject.windowStyle` (#744) — 戦闘ウィンドウの配色テーマ（`'dark'` 既定 / `'ff-blue'`）。frontmatter `window_style:` が parser（`Document.window_style`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeWindowStyle`）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `windowStyle` オプションへ流れる（`spriteStyle` と同じ経路。GUI 専用・TUI は読まない）。色だけがテーマで寸法は持たない。帯の数・両端の色・不透明度・文字影の定数と、帯ごとの色導出は純粋関数 `frontend/src/game/windowStyle.ts`（`computeBands` / `lerpColor` / `normalizeWindowStyle`）が正本。`BattleScreen.drawPanel` は ff-blue のとき帯ごとの `rect` を上から積み、dark と同じ角丸（半径 `PANEL_RADIUS`=6）の mask で切り抜いて、同形の角丸白枠を重ねる（g の子 [帯, mask, 枠] を g ごとに 1 組だけ使い回し、枠は mask の外に置く）。dark は従来の角丸矩形のまま。文字は `themedStyle` が ff-blue のときだけ `dropShadow` を足した `TextStyle` を返す
- `RPGProject.battleBackgroundTone` (#753) — 戦闘背景の彩度・明度を表示時に落とすか（`'on'` 既定 / `'off'`）。frontmatter `battle_background_tone:` が parser（`Document.battle_background_tone`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeBackgroundTone`）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `backgroundTone` オプションへ流れる（`windowStyle` と同じ経路。GUI 専用・TUI は読まない）。係数（彩度・明度）と正規化は純粋関数 `frontend/src/game/backgroundTone.ts`（`BACKGROUND_TONE_SATURATION` / `BACKGROUND_TONE_BRIGHTNESS` / `normalizeBackgroundTone` / `saturationToPixiAmount`）が正本。`BattleScreen.applyBackgroundTone` が背景スプライトにだけ `ColorMatrixFilter`（1 個を使い回し、`destroy` で解放）をかける。`off` と背景なしはフィルタ無し
- `RPGProject.battleBackgroundDof` (#753) — 戦闘背景の被写界深度風の手前ぼかし（`'off'` 既定 / `'on'`）。frontmatter `battle_background_dof:` が parser（`Document.battle_background_dof`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeBackgroundDof`）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `backgroundDof` オプションへ流れる（`battleBackgroundTone` と同じ経路・独立。GUI 専用・TUI は読まない）。定数（仕様値の `DOF_START_RATIO`（画面高さ 50% から下へ）と、目視調整の `DOF_GRADIENT_RATIO` / `DOF_MAX_BLUR_STRENGTH` / `DOF_LEVEL_COUNT`、および最大ぼかしから導く `DOF_EDGE_EXTEND`）と、画面高さから各段のマスク領域・アルファの立ち上がり割合・ぼかし強さを求める計算は純粋関数 `frontend/src/game/depthOfField.ts`（`computeDofLevels` / `computeDofQuad` / `computeDofFilterArea` / `dofMaskStops` / `normalizeBackgroundDof`）が正本。`BattleScreen.applyBackgroundDof` は背景と**同じテクスチャを共有**するぼかしコピーを `DOF_LEVEL_COUNT`（4）段、強さを段階的に変えて背景の直上に弱→強の順で重ね（可変半径ガウスの近似）、各段は縦グラデーションの canvas テクスチャ（1 x 256、alpha が 0 → 1）を持つマスク Sprite を `setMask({ mask, channel: 'alpha' })` で掛けて受け持つ帯だけ見せる（Sprite マスクの既定チャンネルは red なので alpha 指定が必須）。各コピーは背景を四方へ `DOF_EDGE_EXTEND` だけ広げた `Mesh`（広げた部分は UV が 0〜1 の外側を指し clamp-to-edge で端ピクセルの繰り返し。単独画像テクスチャ・既定の addressMode が前提）で、画面端でもぼけ量が落ちない。フィルタは `BlurFilter`（`repeatEdgePixels` は padding を 0 にするだけなので使わず、`clipToViewport = false` で padding を残す）で、`filterArea`（コピーのローカル座標）を段ごとのマスクが見える帯に絞る。マスクの絵は立ち上がり割合が変わったときだけ差し替える。テクスチャは `dofMaskCache.ts` が立ち上がり割合を 0.01 刻みに丸めて画面間で共有し、**破棄しない**（マスクの TextureSource を壊すと、Pixi のプールに戻ったマスクフィルタの束縛が連鎖的に破棄され、画面サイズ切替で BattleScreen を作り直した次の描画が `Cannot read properties of null (reading '0')` で落ちる #745）。canvas が使えずマスクが作れない環境では 1 段も作らずぼかし無しで続行する。`destroy` でコピー・geometry（`Mesh.destroy` は破棄しない）・マスク・フィルタを解放（共有している背景テクスチャとマスクのテクスチャは壊さない）。`off` と背景なしは何も作らない
- `RPGProject.battleLogTypewriter` (#755) — 戦闘ログの 1 文字ずつ表示（`'off'` 既定 / `'on'`）。frontmatter `battle_log_typewriter:` が parser（`Document.battle_log_typewriter`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeBattleLogTypewriter`）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `logTypewriter` オプションへ流れる（GUI 専用・TUI は読まない）。計算は純粋関数 `frontend/src/game/battleLogTypewriter.ts`（`syncBattleLog` / `tickBattleLog` / `skipBattleLog` / `visibleBattleLogTail` ほか、速度定数 `BATTLE_LOG_MS_PER_CHAR`）が正本で、1 行のタイプは既存 `typewriter.ts` を使う。ログは上限超過で先頭が捨てられ絶対インデックスが失われるため、「タイプ中の行」「表示待ちの行」は**ログ末尾からの相対位置**で追い、新規行数は文面の突き合わせでなく、`BattleEngine` が `appendLog` のたびに加算する累計行数 `BattleState.logTotal`（上限で先頭を捨てても減らない）の前回との差で数える（同じ文面が続いても数え違えない。ログ長を超える差は見える範囲に丸め、`logTotal` が前回より小さければ別戦闘として全行を新規扱い。流れてもタイプ中の行が別の行に化けない）。中間状態（`BattleLogTracker`）は `BattleScreen` が持ち GameState には持たせない（ADR 0002）。ticker はタイプ中だけ回し、`destroy` で破棄する。`off` は従来経路そのまま。タイプ中のコマンド／ログ帯タップは全文即時表示のみでコマンドは実行しない（DialogBox の流儀）
- `RPGProject.battleDepth` / `battleForeground` (#747) — 戦闘画面の奥行きと前景レイヤー。frontmatter `battle_horizon:` / `battle_perspective:` / `battle_foreground:` が parser（`Document`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeBattleDepth`: perspective が数値で 0 超のときだけ `{horizon, perspective}`、それ以外は undefined＝平面）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `depth` / `foreground` オプションへ流れる（GUI 専用・TUI は読まない）。計算は純粋関数 `frontend/src/game/battleLayout.ts` が正本: `computeFormation` が平面の枠と床の基準 y（`SpriteSlot.floor` = スプライトの足元 `y + size`、ラベル分は含めない）を返し、`applyDepthToSlots` が `computeDepthScale`（地平線 y と最前列の floor から幾何の縮尺 → perspective で補間、下限 `DEPTH_MIN_SCALE`）で各枠を**元の予約領域の上端・水平中央を保って縮める**（縮んだ枠・ラベルは元の予約領域の内側なので #736 の不変条件=画面内・非重複・非負が保たれ、acrylic の台座・影は枠 `size` に追従する）。`computeSideBattleLayout` が `depthActive` を返し、`BattleScreen` は有効時だけ `sideStage.sortableChildren` と各 view の `zIndex = floor` で奥→手前に重ねる（無効時は従来どおり挿入順）。前景は `BattleScreen.loadForeground` が stage の直上（パネルより奥）に cover で敷く。敵の名前・HP ラベルは sideStage の外の `labelLayer`（前景のさらに上・パネルより奥）に置き、座標は画面絶対で枠の縮尺・位置に追従する（前景に覆われて読めなくならない）。中間状態は持たない（レイアウトは入力から毎回求める。GameState には何も足さない・ADR 0002）
- 戦闘の ATB `RPGProject.battleAtb` (#205) — frontmatter `battle_atb: on` / `battle_atb_mode: wait|active`（既定 off / wait）が parser（`Document.battle_atb` / `battle_atb_mode`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`game/battleAtb.ts` の `normalizeBattleAtb`。`on` のときだけ `{ mode }`、他は undefined＝従来ターン制）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `openFieldBattle` で `new BattleEngine(party, enemies, { atb })` へ流れる（GUI 専用・TUI は読まない）。**エンジンは時計を持たない純粋状態機械**のままで、時間は `BattleEngine.tick(ms)` で外から与える（本編は各レンダラーの `onTick` が `BattleScreen.tick(dtMs)` 経由。設定オーバーレイ中は進めない、サンプルページは自前の ticker）。ゲージ・コマンド待ちキューは演出の中間状態ではなく戦闘進行そのものなので `BattleState.atb`（`partyGauge` / `enemyGauge` / `queue`）に持つ（ADR 0002 が禁じるのは演出の中間状態）。ATB でなければ `state.atb` は存在せず、既存のターン制経路（`runEnemyTurn` ほか）は一切変わらない。`tick` は「次にゲージが満タンになる時刻」で区切って進めるので、細かい tick の連続と大きい tick 1 回で結果が同じ（同じ rng 列なら決定論的。1 回の上限 `ATB_MAX_TICK_MS`）。同時に満タンの順序と敵の狙いは注入された `rng`。待機（wait）はキューに味方がいる間 `tick` が時間を進めない。復元・任意局面起動は `atb.initialGauges`（初期に満タンの味方が複数いるとコマンド待ちキューの順は **party の index 順に固定**される。溜まった順は表現できない）と、死亡者のゲージ 0・勝敗判定（`checkEnd`）で壊れない。フェーズは `party-input`（コマンド待ち）/ `atb-running`（ゲージ進行中）を追加。`BattleScreen` はゲージ棒（`atbBars`、side は各ステータス行の右端に置く数文字ぶんの短い棒。列の x と幅は純粋関数 `computeStatusColumns`（`battleLayout.ts`）が名前・HP・MP・ゲージの順に右から詰めて求め、味方全員で共通＝名前の長さで HP の位置がずれない。HP・MP は「見出し｜現在値｜/最大値」の 3 つの Text に分けて見出しと「/」の x をそろえる。名前列が最低 3 文字に届かなければ MP → 見出し → HP の最大値 → ゲージ幅の順に削る。ATB off ではゲージ列だけが無い。front はパネル下端の細い棒のまま）と番の味方の「▶」（名前の文字列に混ぜず、左余白に別 Text の `atbMarkers`。名前の左に ATB のときだけ足す余白の中、名前の 3px 手前〔`sideStatusMarkerX`、幅は `estimateTextWidth`〕に置く。余白は基本 `SIDE_STATUS_MARKER_GUTTER_MIN`（`sideStatusLeftPadding`。どの幅でも枠から 4px 以上）で、`computeStatusColumns` が名前列の余裕（最小名前幅を超えるぶん）から `SIDE_STATUS_MARKER_GUTTER_MAX`（枠の線の中心から最大 8px）まで広げる。段階（省略）は変えず、400/399 のような閾値のジャンプは無い。front は名前を ▶ ぶん右へ寄せ（`frontStatsLeftPadding`: 1 行の文字に余裕があれば MAX まで。余裕は概算幅 `FRONT_STATS_TEXT_BUDGET`=260 との比較で判断）、隙間は side と同じ。ATB 棒の左端は名前の x にそろえる）・黄色を描き、アクスタ側の「選択中」の印は各アクスタの頭上の白い下向き三角 ▼（`EntityView.selectMark`。container の子なので板・台座・踏み出し演出に追従し、大きさ・間隔は枠の一辺に比例（小さい画面用の下限あり: 幅 10px・高さ 8px・間隔 4px）。形は純粋関数 `computeSelectMarkTriangle`、位置はポーズでなく基本の絵の矩形に固定し、上端は上のログ窓の下端＋`SELECT_MARK_LOG_GAP`（`messageRect` を container 座標へ換算した `minTop`）より上へ出さない（▼ は sideStage 内でパネルの下の層なので、最上段のキャラはログ窓に隠れないよう下げる。頭に少し重なってよい）。出す者は純粋関数 `selectMarkTargets`（`battleMenu.ts`）が決め、`updateSelectMarks` が出し入れする: 対象選択の窓が開いている間は手の指す者だけ〔生きている者。蘇生の対象窓は候補の倒れた味方〕、開いていなければ ATB の番の味方。▶ と併存する #805）を置き、戦闘の終了は `tick` でも検知して `onClose` を 1 回だけ呼ぶ
- 戦闘のコマンド窓 `RPGProject.battleCommandLayout` / `battleCommandLabels` (#204) — frontmatter `battle_command_layout: grid|cross`（既定 grid）/ `battle_command_labels: attack=斬る, spell=魔石` が parser（`Document`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`game/battleCommands.ts` の `normalizeCommandLayout` / `parseCommandLabels`）→ `fieldBattle.ts` の `readFieldBattleSettings`（各レンダラーの `battleSettings`）→ `openFieldBattle` → `BattleScreen` の `commandLayout` / `commandLabels` オプションへ流れる（GUI 専用・TUI は読まない）。コマンド id は `attack`/`spell`/`item`/`escape` 固定で、変わるのは label だけ。配置座標は純粋関数 `battleLayout.ts` の `computeCommandCells`（`grid`=2 列 / `cross`=幅半分のセルを上・左・右・下、段は 3 等分。`cross` はコマンドが 4 つで `side` のときだけ有効）が正本で、レンダラに数式は無い。`cross` のとき `BattleScreen` は `globalThis` に keydown を 1 本だけ付け（`attachCrossKeys`）、矢印キー（`crossKeyToCommandId`）を `handleCommand` と同じ経路へ流す。選べない局面（`isCommandEnabled`: ATB のにげる常時可を含む、表示の alpha と共通）・フォーム部品のフォーカス中・修飾キー・リピートは無視し、`destroy` で必ず外す。入力まわりの取り決め（両レンダラー共通。状態は `fieldBattle.ts` の `FieldInputGate` が持つ。詳細は「フィールドから戦闘画面への入退場」節）: (1) 戦闘中は `handleKeyDown` と `onTick`（Raycast は `updateMovement`）がフィールドの移動を止める。Raycast は `startBattle` / 戦闘終了で `keys` をクリアする。TopDown は加えてタップ・スワイプ・キュー済みスワイプ（pendingSwipe）・エンカウント抽選も止める。(2) 戦闘開始時に押されていた矢印キーは `FieldInputGate.trackKeyDown`（keydown/keyup で追跡）→ `BattleScreen` の `initialHeldKeys` で渡され、keyup まで無視する（`inputGuards.ts` の `isHeldKeyBlocked`）。戦闘終了時に押されていた矢印キーは `armReleaseGate` で記録し、keyup までフィールド移動に使わない（repeat の keydown で戻さない）。window の blur で `FieldInputGate.blur` がこれらの押下記録を捨てる（Raycast は加えて `keys`、`BattleScreen` は `heldKeys` も捨てる）。(3) 設定オーバーレイ（Ctrl+,）が開いている間は、`RPGPlayer` が `setInputSuspended(open)` で両レンダラーに伝え（renderer 作り直し時も ref で引き継ぐ）、`FieldInputGate.setSuspended` がフィールド移動と ATB の進行（`BattleScreen.tick`）を止め、`BattleScreenOptions.isInputSuspended` 経由で戦闘のキーも止める。(4) フォーム部品のフォーカス判定は `inputGuards.ts` の `isEditableTarget` に共通化。(5) `cross` 有効中は、選べない局面・リピートでも矢印キーは `preventDefault`（ページのスクロール防止）。修飾キー付き・フォーム部品・入力停止中は止めない。(6) `cross` は 3 段で窓が高くなるため、ログが最小行でもステージが `SIDE_MIN_STAGE_HEIGHT` を割る小画面では 1 段を縮める（下限 `SIDE_COMMAND_CROSS_MIN_CELL_HEIGHT`＝28px）。`grid` にはリスナーを付けない
- 戦闘の候補窓（窓の階層・MP・対象選択）(#204 PR2) — `battle_command_layout: cross` のとき、「じゅもん」「どうぐ」で FF5/6 風に一覧の窓が重なって開き、確定で対象選択（手のカーソル）が重なる。キャンセル（Escape / Backspace / X・窓の外のタップ）で一つ前の窓に戻る。**状態は純粋関数 `game/battleMenu.ts`**（`MenuStack` = 開いている窓の配列。`openList` / `moveCursor` / `confirm` / `cancel` / `setListCursor` / `setTargetCursor`。確定したときだけ `MenuAction` が出る）、**座標は純粋関数 `game/battleMenuLayout.ts`**（`computeListWindowRect` / `buildMenuView` / `computeTargetHand` と手のドット絵 `HAND_BITMAP`）、`BattleMenuLayer.ts` は `MenuView` を描いて当たり判定を出すだけ。`BattleScreen` はスタックを private に持つが **GameState / BattleState には持たない**（ADR 0002。窓の開閉は画面の一時的な状態で、確定した行動だけ `BattleEngine.selectSpell` / `selectItem` を通ってエンジンの状態になる）。窓の候補は `BattleScreenOptions.menu`（`spells` は味方 id ごと・`items` は共通）で呼び出し側が渡し、エンジンは汎用のまま（コマンド名は `battle_command_labels`）。本編では `fieldBattle.ts` の `buildBattleMenuData` が、`PartyMemberDef.learns` のうちメンバーのレベル（既定 1）以下で呪文マスター（`RPGProject.spells`、各レンダラーの `masterSpells`）にあるものを定義順に作る（アイテムは所持品の仕組みが無いので渡さない＝どうぐは従来どおり何も起きない）。候補が 1 件も渡されない・`front` では窓を作らず従来どおり（`grid` は #806 で候補窓が使える）。**MP**: 消費は既存の `selectSpell` が行い（`caster.mp -= spell.mp`）、表示側は `buildMenuRows` で MP 不足の行を `disabled`（グレー）にする。グレーの行を決定すると窓は閉じず、エンジンの「MPが たりない！」（ログと吹き出し、#788）が出る（指せる対象がいないときと所持数 0 のアイテムも同じ経路で `BattleEngine.notifyBlocked` が「たいしょうがいない！」「もっていない！」を出す #890。アイテムの `count` は `BattleScreen` が使用成立時に渡された候補の `count` を書き換えて減らすので、呼び出し側は戦闘ごとに複製を渡す）。**対象**: 呪文の `target` 文字列を `parseSpellTarget` が解釈する（`味方単体` / `味方全体` / `敵単体` / `敵全体` / `自分` / `マップ`。未知は敵単体）。単体は手が 1 本で、側は `target` に固定（左右キーでは切り替えない。エンジンは `target` と逆の側の `targetId` を解決できず、MP とターンだけを消費してしまうため）、上下で候補を巡回し、確定で `targetId` をエンジンへ渡す。候補は生存者のみで、倒れた味方を指せるのは蘇生（効果 DSL が `revive` または builtin `zaorik`、`isReviveEntry`）のときだけ（その場合は倒れた味方のみ）。確定時にも手の指す対象が候補に残っているか確認する。`マップ`（対象なし）の呪文は戦闘ではグレー。対象選択の間は下の一覧窓を隠す（`buildMenuView`）。一覧が窓に収まらないときは窓の上端・下端のスクロール帯（`scrollUp` / `scrollDown`、`scrollList`）のタップで 1 行ずつ動かし、画面サイズ変更で見える行数が変わったら `refitList` が収め直す。`target` の前後の空白はエンジンと窓の両方で無視する。ff 演出中は画面の HP 表示が演出に追いつくまで古いことがあるが、窓の開閉はエンジンの確定した状態で決めるので影響せず、数字の更新が遅れるだけ（既知の制約）全体は対象側の生存者全員に手が同時に立ち、`targetId` は渡さない（エンジンが `target` から解決）。アイテムはエンジンが味方単体だけを扱うので常に味方単体（蘇生の判定は呪文が builtin `zaorik`、アイテムが builtin `world_tree_drop`、どちらも効果 DSL `revive` でも可。種別ごとに見る）。一覧窓は `drawPanel(..., opaque)` で不透明に描き（下のコマンド窓の文字を透かさない。ff-blue の帯はそのまま）、幅はコマンド窓と同じを基本に、名前が `MENU_NAME_MIN_CHARS`＝7 文字まで省略されずに読める幅を下限にし（消費は MP の数字だけ。右端は `MenuGeometry.avoidX`＝味方ステータス欄の HP 列の左〔`layoutSide` が `computeStatusColumns` の `hp.x` から渡す〕を越えない。コマンド窓の外形ぶんは下限として必ず覆う）（縦長の画面ではコマンド窓が狭く、消費を引くと名前が残らないため。画面サイズ総当たりで『7 文字以下の名前は全文、それより長くても 6 文字見えて互いに区別できる』『窓の右端が HP 列の途中で終わらない〔消費 1〜3 桁〕』を固定）、見える行は `MENU_MAX_ROWS`＝4（高さは行が少なくてもコマンド窓の外形を `MENU_COMMAND_OVERHANG`＝4px の枠線ぶんまで覆う）、入りきらない名前は `fitLabel` で省略する。スクロール帯の高さは上下の余白（`MENU_PADDING_Y`）に収め、行の決定領域に食い込ませない。▲▼の記号・行の文字・手のカーソルは `eventMode='none'`（子は親の static を継承して判定に参加し、帯や行へのタップを遮るため。`pixi.js/events` を読み込んだ実の EventBoundary で固定）。MP 不足の通知は `MPが たりない！`（ログと吹き出しで同じ文言）。一覧窓はコマンド窓の真上に出るので、画面によっては下の絵や欄に重なる（既知の制約。実測、味方 4・敵 3: 800x450・640x360 は敵ラベルの 7〜20%、360x640・320x568 は窓幅 205px で味方ステータス欄の名前列の 29〜37%〔HP 列・絵・ラベルには重ならない〕、320x240 は敵の絵の約 42%、1280x720 はほぼ 0）**ATB の wait**: `BattleEngine` に `waitScope`（`command` 既定 = 従来どおりコマンド待ちの間ずっと止まる / `menu` = `setAtbHold(true)` の間だけ止まる）を足し、候補窓が有効な `BattleScreen` が `setAtbWaitScope('menu')` にして（候補窓を使わない画面や destroy では `'command'` に戻す）、窓の枚数が 1 以上の間だけ `setAtbHold` する（ホールドは `BattleState` に持たないエンジンの private）。番が変わる・行動が済む・戦闘が終わるなど窓の前提が崩れたら `refresh` が窓を閉じてホールドを解く。キーは `attachCrossKeys` の同じ keydown リスナーが、窓が開いている間だけ `menuKeyAction` に切り替える（Space は battle-sample のブリンク切替と衝突するため使わない）。窓は `BattleScreen` の最前面（`updateMenuLayer` が毎回 `addChild` し直す）。画面サイズ総当たりで、一覧窓・手・当たり判定が画面内に収まることを `battleMenuLayout.test.ts` で固定している。範囲外（残り）: 呪文の最小エフェクト、前衛・後衛の入れ替え操作、「たたかう」の対象選択
- 戦闘コマンドの構成と「わざ」(#873) — frontmatter `battle_commands: skill, spell, item, escape`（id の列。順序＝配置順）が parser（`Document.battle_commands`、生文字列で透過）→ `normalizeDocument` → `rpgProjectFromDoc`（`parseCommandIds`）→ `RPGProject.battleCommands` → `readFieldBattleSettings` → `BattleScreenOptions.commands` へ流れる（GUI 専用）。`resolveCommandSpecs(labels, ids)` が並び・表示名を作り、未指定・有効 id なしは従来の `attack, spell, item, escape`。コマンド id に `skill`（わざ）を追加しただけで、特殊なコマンドは増やさない（FF らしさ）。配置座標は `computeCommandCells` が個数に応じて決める（`cross` は 4 つのときだけ。他は `grid`）。`cross` の矢印キー（`crossKeyToCommandId(key, ids)`）は id でなく**並びの位置**で決まる（0 番目=↑・1=←・2=→・3=↓）。「わざ」は候補窓の三つ目の種類 `MenuKind='skill'`（呪文と同じ窓・同じ状態機械。MP なしでコスト列は空）。中身は `PartyMemberDef.abilities`（`わざ:` の `[特技 id]` の id、parser の `collect_values`）を `buildBattleMenuData` が特技マスター（`roster.skills`）で引いて `BattleMenuData.skills`（味方 id ごと）に作る。対象は特技と同じ相対表現（`parseSkillTarget`: 相手単体/相手全体/仲間単体/仲間全体/自分。蘇生は builtin `zaorik` か効果 `revive`）。確定は `BattleEngine.selectSkill`（内部は敵と共有の `performSkill`。MP は消費せず、演出イベントは既存の `skill` 種別、使えなければ false）で、敵の反応は `physical` カテゴリ＝`受けた=物理` が通常攻撃にもわざにも成立する（通常こうげきの無いゲームでも条件が働く）。敵の通常攻撃（`こうげき`）は残す。基本の攻撃を魔法（無属性ダメージ魔法）にするゲームは `attack` を外して `spell` の候補窓で戦う。候補窓は `side` なら `grid` でも使える（#806。`menuEnabled` は `layoutMode==='side'` かつ候補が 1 件以上。キーのリスナーは grid でも候補窓のためだけに付き、コマンドの矢印キー決定は cross のときだけ。grid のコマンド選択はタップ）。画面の下端の余白（`SIDE_PADDING` 16px）に操作の案内を常に出す（純粋関数 `battleMenu.ts` の `menuHint`＝局面〔コマンド・一覧・対象 単体/全体〕と cross の有無と「収まるか」の判定から文を選び、長い文→短い文→空の順に落とす。収まるかには一覧窓との交差も含め、`BattleMenuLayer.placeHint` が中央→窓の横の空き→窓の下の順で置き場所を決め、置けなければ出さない。描画は `BattleMenuLayer.drawHint`、案内だけのときもレイヤーは visible だが全面のキャンセル受けは窓があるときだけ）。
- 戦闘の演出 `RPGProject.battlePresentation` / `PartyMemberDef.poses` / `MonsterDef.poses` (#745) — frontmatter `battle_presentation: dq|ff`（既定 dq＝現行の見た目・挙動を一切変えない）が parser（`Document.battle_presentation`）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`game/battleMotion.ts` の `normalizeBattlePresentation`。`ff` 以外は `dq`）→ `fieldBattle.ts` の `readFieldBattleSettings`（`FieldBattleSettings.presentation`、既定 `dq`。RaycastRenderer・TopDownRenderer 共通）→ `openFieldBattle` → `BattleScreen` の `presentation` オプションへ流れる（GUI 専用・TUI は読まない）。`ff` は `layout: side` のときだけ有効（`front` は絵を動かさない）。ポーズ別スプライトはマスタ定義 `*Def`（不変定義）の `poses`（`ポーズ: idle=a.png, step=b.png`、parser の `BTreeMap<String, String>`。wasm 経由では Map で返るため `normalizeEvents` が Record に変換する）で、戦闘への組み立て時に `posesField`（`normalizePoses`）で `BattleEntity.poses` に写す（味方は `fieldBattle.ts` の `partyDefToBattleEntity`、敵は `encounter.ts` の `rollEncounter` と `RaycastRenderer` の暫定戦闘のフォールバック定義）。ポーズ画像のパスも他の戦闘画像と同じく `assetBaseUrl`（`resolveRpgImagePath`）で解決する (#746)。**エンジンは同期で状態を確定させる純粋状態機械のまま**で、演出が読めるよう行動 1 回ごとの事実（誰が・何を・誰にいくつ。`BattleActionEvent` / `BattleHit`）を `BattleState.events`（直近 30 件）と累計 `eventTotal` に残す（ログの `log` / `logTotal` と同じ流儀。呪文・アイテムは効果の前後の HP 差から damage / heal / miss を導くので DSL・builtin のどちらでも動く。行動が成立しなかった知らせ（逃走失敗「にげられない！」・MP 不足「MPが たりない！」）は `kind: 'notice'`（hits 空・絵は動かない・窓の言葉だけ）として記録し、ff の窓に出す。ポーズは `idle / ready / step / slash / cast / hurt / down / victory`（`cast`=呪文の構え、アイテムは `ready`。`special` は必殺技の配線時に足す）。計算上のダメージ 0 は MISS でなく `0`（MISS は無効（耐性 0）と HP 0 への追撃のみ）。`BattleHit.amount` は HP の実変化ではなく**計算上のダメージ・回復量**（オーバーキル・回復の上限切りを含む。実変化は `hpBefore - hpAfter`）で、通常攻撃は計算値、DSL は `EffectContext.onAmount` の通知、builtin は通知が無いので HP の前後差で代用する）。**時間計算は純粋関数 `game/battleMotion.ts` が正本**: 行動の時間割（`buildActionTimeline` / `eventTimeline`: 踏み出し 220・斬り 180（命中は斬り開始の 70 後）・戻り 220・行動間 120 ms。呪文・アイテムは構え 560・命中 400。のけぞり 260・倒れ 320・数字の跳ね 260+160・留まり 240・フェード 200 ms）、行動側の位置とポーズ（`sampleActor`）、対象ののけぞり・倒れ（`sampleTarget`）、再生キューの進行（`advancePlayback`: 行動の境をまたぐ時間は次へ繰り越し、命中の瞬間だけ `fires` に出す）、数字の跳ね（`sampleDamagePopup`）、ポーズの代替順（`resolvePose`）。距離はすべて「枠の一辺」に対する比で、前後の向きを持たない（`forward` = 相手陣営へ向かう量、`recoil` = 離れる量。左右への写像は画面）。**再生の途中状態（`PlaybackState`・浮いている数字・命中までの古い HP の控え `hpOverride`）は `BattleScreen` が持ち、GameState / `BattleState` には載せない**（ADR 0002）。`BattleScreen` を作り直した画面は確定した状態から始まり、過去の行動を再生しない（`seenEventTotal` を作成時のエンジンの値に揃える）。**描画**: 行動する側・対象は `EntityView.container` の位置を `placeEntityView` が置いた基準位置（`baseX/baseY`）+ ずれで動かす。アクスタの板・台座は container の子なので一緒に動き、別層（`shadowLayer`）の地面の影には同じ横ずれを足す（置き去りにしない）。ポーズの差し替えはスプライトのテクスチャ（と acrylic の板・影のテクスチャ）を入れ替えて `placeEntityView` で置き直す。枠の配置に使う縦横比は基本の絵（`baseVisual`）で固定し、ポーズで texture が変わっても枠が動かない。ポーズの絵は**基本の絵を枠に収めたときの縮尺を全ポーズで共通に使い、足元（下端中央）を基本の絵に揃えて**描く（`poseRectOnBase`。横広の slash なども枠に収め直さない＝縮めない。はみ出しは許容しクリップしない）。acrylic の板・台座・影も同じ基準（台座・影は基本の絵、板・影の傾きは各ポーズの絵の寸法）で追従する。ダメージ数字のフォントは枠の一辺の 0.35 倍（`POPUP_FONT_RATIO`、20〜56px）。PixiJS v8 は Sprite の子を描画しないので、部品は Container にまとめる。**メッセージ窓（ff）**: ダメージや「〇〇のこうげき！」を文で出さず、再生中の行動に名前（呪文・アイテム）があるときだけ上の窓に一度に全文・中央寄せで出す。通常攻撃は窓ごと非表示。`battle_log_typewriter`（#755）は dq のログ専用で ff では使わない。**進行方式**: 従来ターン制では演出キューが空になるまで、`handleCommand` / 十字キー / `isCommandEnabled` は新しい行動を受けない（`isInputBlockedByPresentation`）。**ATB は本家 FF5/6 に合わせ、演出中も `BattleScreen.tick` が `engine.tick` を呼び続け、ゲージが進む**。敵の行動は `events` に積まれて演出キューで順に再生され、行動可能な味方は演出中でもコマンドを入力できる（入力した行動もキューの末尾に積まれる）。複数の行動が積まれても、対象の HP 表示は `hpOverride`（最初に積まれた行動の `hpBefore` から、各命中の瞬間に `hpAfter` へ段階的に進み、キューが空で捨てる）で命中ごとに正しく変わる。`wait` の「コマンド選択中は時間停止」はエンジンの従来どおり（本家の wait は候補窓を開いている間の停止で、候補窓は #204 PR2）。エンジンの状態機械は変えない。従来ターン制でも `tick` が演出時間を進める（本編 `RaycastRenderer` / `TopDownRenderer` の `onTick`・サンプルの ticker が毎フレーム渡す）。戦闘が決着しても、再生キューと浮いている数字が空になってから `onClose` を呼ぶ。さらに勝利・全滅は、演出方式（dq / ff）を問わず「読ませる待機」を挟んでから閉じる（#745 分割4）: 待機の長さと経過の計算は純粋関数 `frontend/src/game/battleResult.ts`（dq 0.8 秒 / ff 1.5 秒・タップ/決定キーで飛ばせる猶予 0.25 秒・ff のメッセージ窓の言葉）。待機の経過時間 `BattleScreen.resultElapsed` は画面が持つ（GameState には持たせない・ADR 0002）で、演出・ダメージ数字・`battle_log_typewriter: on` のタイプ表示が終わってから数え始め、`tick` が進める（dq 従来ターン制の `tick` も待機のために動く）。ff では待機中、メッセージ窓に「しょうり！」「ぜんめつ…」を出し、勝った側が victory ポーズを取る。決定キーのリスナーは待機中だけ付け、閉じる時・destroy で外す。逃走成功は待機なし。待機の長さを上書きする frontmatter 設定は今は無い（固定値）。命中の瞬間まで対象の HP 表示（ステータス行・敵ラベル）は古い値を見せ、HP 0 の見た目（down ポーズ or 沈み込み＋薄く）もその瞬間から。
- 戦闘の開始・終了の画面遷移 `RPGProject.battleTransition` (#830) — frontmatter `battle_transition: none|ff`（既定 none＝現行の挙動を一切変えない）が parser（`Document.battle_transition`、wasm 再生成＋`parser/pkg` コミット必須）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`battleTransition.ts` の `normalizeBattleTransition`）→ `fieldBattle.ts` の `readFieldBattleSettings`（`FieldBattleSettings.transition`。**FieldBattleSettings / DEFAULT / readFieldBattleSettings / openFieldBattle の 4 か所**）へ流れる（GUI 専用）。**時間計算は純粋関数 `game/battleTransition.ts` が正本**: 開始 `sampleEnter(経過ms)`＝ズーム倍率・暗転の濃さ・始まっている段の番号・完了（仮の値: 2 段のズーム 1.3→1.9 倍・段の間隔 380ms・暗転 260ms・黒の待ち 120ms。#803 の測定値で `DEFAULT_BATTLE_TRANSITION_PARAMS` を差し替える）、終了 `sampleExit(経過ms, 追加画面の長さ)`＝フェードアウト→黒→フェードイン。**再生は `game/fieldBattleTransition.ts` の `FieldBattleTransition`**（各レンダラーが 1 つ持つ）で、経過時間などの中間状態はこのクラスの private（GameState には載せない・ADR 0002）。開始は `app.stage` 全体を操作キャラの画面位置を中心に拡大（`pivot`/`position`/`scale`。TopDown は `world + playerContainer` を毎フレーム問い合わせて歩き出しの発火にも追従、Raycast は画面中央）し、最前面の黒い幕の alpha で暗転、真っ暗で見た目を等倍に戻して幕を外し `openFieldBattle` を呼ぶ。終了は `openFieldBattle` の `onClose` が（`transition` 引数が渡され設定が ff のとき）`playExit` に回り、フェードアウトの真っ暗の間に戦闘画面を畳む（`closeFieldBattle` + 既存の `onClosed`）→ フェードイン、終了時に `armReleaseGate`（フェードイン中に押された矢印キーも離すまで無視・#779）。レンダラーは `battleBusy`（`battleScreen !== null || transition.active`）で入力・移動・メニュー・エンカウント・多重起動を止める。`load()` / `destroy()` は `closeBattle` 内で `transition.cancel()`（見た目を戻し、保留中のコールバックを捨てる）。**拡張点（フック）**: `setBattleTransitionHooks({ onTransitionBeat(n), interlude(outcome) })`。`onTransitionBeat` は開始の各段の始まりに呼ばれる音のきっかけ（音自体は tatenami 側）、`interlude` は戦闘結果（victory/defeat/escaped）から「黒の間に挟む追加画面」`{ container, durationMs }` を返す（戦利品の画面 #831 用。既定は undefined＝何も挟まない。ドロップの仕組み自体は未実装なので画面は作っていない）。`setBattleTransitionHooks` の呼び出し元は未配線（拡張点として用意しただけ。戦利品 #831 で配線する）。対象外: 寺町サンプルの一枚絵フィールド（`fieldSample`）は別系統で未対応。
- 敵の見えないグリッド `RPGProject.battleEnemyGrid` / `battleEnemyWindowOverlap` と敵のサイズ・倍率 (#839 段3) — frontmatter `battle_enemy_grid: 6x2` / `battle_enemy_window_overlap: 0.25` は parser（`Document` に生文字列で透過、wasm 再生成＋`parser/pkg` コミット必須）→ `normalizeDocument`（`nullIfEmpty`）→ `rpgProjectFromDoc`（`normalizeEnemyGrid` / `normalizeEnemyWindowOverlapSetting`）→ `fieldBattle.ts` `readFieldBattleSettings` → `BattleScreenOptions.enemyGrid` / `enemyWindowOverlap`。モンスターの `サイズ:` / `倍率:` は `master.rs` が `MonsterDef.size{w,h}` / `scale`（丸め済み、不正は警告して無し）にし、`rollEncounter` が `BattleEntity.layout?{w,h,scale,at?}` に写す（どれも無ければ付けない。戦闘エンジンは読まない）。段3は値を通すだけ。描画への配線は下の段4。設計は `docs/design/enemy-formation.md`
- 隊列 `PartyMemberDef.row` / `BattleEntity.row` (#747) — パーティ定義の `隊列:`（`row:`）が parser（`PartyMemberDef.row`）→ `fieldBattle.ts` の `partyDefToBattleEntity`（`normalizeBattleRow`。`side` のときだけ `row: 'back'` を載せる）→ `BattleEntity.row` へ流れる。敵は `computeFormation(…, 'enemy', …, enemyAspects, {maxSize, minSize})` が縦横比つきの枠（`size`=高さ・`width`=幅）で並べ、領域は `partyRegionWidth`（味方の斜め一列に必要な幅）を引いた残り、`minSize` は味方の高さ、`maxSize` は `SIDE_ENEMY_MAX_SIZE`=480（#760）。座標は `computePartyDiagonal`（`computeFormation(…, 'party', …, rows)` が委譲。#760 で味方を FF6 式の左上→右下の斜め一列にした。n=max(4, 人数)（#813）として size=min(320, 高さ/(1+(n−1)×0.3), 幅/(最大幅比×(1+後衛予約)+(n−1)×0.3))、行間隔=min((高さ−size)/(n−1), 0.6×size)、斜めのずらし=0.3〜0.75×size。後衛は斜めの位置から右へ `SIDE_BACK_ROW_SHIFT_RATIO`=0.5 × size で、後衛が 1 人でもいれば全員ぶんの右余白を予約。縮尺は掛けず、party[i] の並びはステータス欄の行順と一致。敵は従来の千鳥）、ダメージは `battleEngine.ts` の純粋関数 `applyRowToPhysicalDamage` / `computeRowAttackDamage`（通常攻撃のみ。呪文・アイテムは通らない）が正本。BattleEngine 内の `computeAttackDamage` ラッパーは `computeRowAttackDamage` を呼ぶが、隊列未指定は従来と同一の数値
- 敵のアクスタ (#737) と窓・隣の板 (#838) — `computeSideBattleLayout` の入力 `enemyAcrylic`（`BattleScreen` が `acrylicParams` を渡す。未指定は板なし＝従来どおり）を渡すと、純粋関数 `computeEnemyPlateRect`（`placeEntityView` / `placeAcrylic` の配置を写し、板＝絵の長辺の `marginRatio + lineWidthRatio` 倍だけ外へ広げた矩形。下端は枠の下端）で見た目の矩形を求める。(1) **列ピッチ**: `computeFormation` の `plateParams` で 1 体ぶんの横幅を「枠の幅」から「板を含む幅」へ広げ、枠の幅だけで板も収まるときは従来の大きさのまま、収まらないときだけ二分法で縮めて、同じ行の隣の板と重ならないようにする。(2) **窓との重なり**: 敵の絵の上端がログ帯の下へ入ってよいのは各敵の枠の高さの `enemyWindowOverlap`（0〜`SIDE_ENEMY_WINDOW_OVERLAP_MAX`=0.5、既定 `SIDE_ENEMY_WINDOW_OVERLAP`=0.25、窓の高さまで）で、許容量以内なら何も変えず、超える（主に横長の絵。箱が枠の上へ伸びる）ときだけ敵領域の上端を二分法で最小限下げる（`measureWindowOver`）。窓は敵・影の層より手前に描かれる（`sideStage` はパネルより奥）ので、許容量までは窓が上に重なるのが仕様。frontmatter `battle_enemy_window_overlap` は parser〜`readFieldBattleSettings`〜`openFieldBattle` まで通っており、グリッド有効時だけ効く（下の敵グリッド配線 #839 段4。グリッドなしは既定値の定数のまま。設計: `docs/design/enemy-formation.md`）。不変条件は `battleLayout.test.ts` の画面サイズ総当たり（板が画面内・同じ行の板が非重複・窓との重なりが許容量以下）
- 敵グリッドの配線 (#839 段4) — `computeSideBattleLayout` の入力 `enemyGrid`（`{cols, rows}`）の**有無で分岐**する。なし → 従来の `computeFormation` と #838 の窓フィットをそのまま通る（出力は `enemyFootprints` を渡しても不変）。あり → `enemyFootprints`（敵の index 順の `{col,row,w,h,scale}`。null・欠けは置けなかった敵＝大きさ 0 のスロットで、後段は描かない）を `computeEnemyGridLayout` に渡し、`enemies[i]` は `EnemyGridSlot`（`SpriteSlot` + `occupied` / `box` / `displayScale`）。`BattleScreen` は**戦闘開始時に 1 回だけ** `placeEnemies`（`BattleEntity.layout` の w/h/at から）で配置して `enemyFootprints` に保持し、毎回の `layoutSide` で入力に渡す（GameState には足さない・ADR 0002）。窓との重なり許容量は `clampEnemyWindowOverlap` が**延長 `overlap × cell` が窓（ログ帯）の高さを超えない閉形式**に絞る（画面の上へ出さない）。奥行き (#747) の縮尺の基準は**グリッド最下行の下端**（ラベル帯を除く。体数・空きに依らない）で、`applyDepthToGridSlots` が `occupied` / `box` / ラベルを同じ変換で縮める（上端固定で縮めたあと、窓に入る量が `overlap × 縮んだ高さ` を超える分だけ、元の占有矩形の内側で下へずらす）。被ダメ数字の高さは描いた絵の矩形の上端から 35%、対象選択の矩形（手の位置と、タップの当たり判定 `hits`）は `slot.box`（倍率で縮めた箱）基準（アクスタの 1x2 は絵が箱より小さいため、手の位置も当たり判定も絵の外にずれうる）。アクスタは `computeAcrylicBoxSize` が、板の実矩形（`computeEnemyPlateRect`）と台座・影の横幅が占有領域の内側に収まる最大の正方形（上限 `max(w,h)`。横長の占有（2x1）は幅いっぱいまで使えるが、縦長の占有（1x2）は台座・影の幅が占有幅で先に頭打ちになり、1x1 の約 1.5 倍の高さ＝占有高さの約 45% にとどまる。設計書 §7）を二分法で求め、`placeEntityView` が `slot.box`（占有矩形を倍率で縮めた箱）の足元中央に置く。描画順は `enemyDrawOrder`（floor 昇順・同じなら列昇順）を `zIndex` に使い、奥行きオフでも `sortableChildren` を有効にして、味方は従来どおり敵より手前に出す（`zIndex` 補正）。**ログ行数はグリッド有効時 `desiredSideLogLines(cols*rows)` で固定**（体数で行数が変わると stage 高さ→`cell` が体数で変わるため。設計書 §3.8 の体数不変）。不変条件は `battleLayout.test.ts` の「敵グリッド有効時の総当たり」（画面内・窓の重なり量・非重複・板が占有矩形内・体数不変・2x2=1x1 の 2 倍）と `enemyGridWiring.test.ts`。
- 敵グリッドの読み込み時検証 (#839 段5) — `frontend/src/game/encounterGroupValidation.ts` の純粋関数 `validateEncounterGroups({grid, masters, groups})`（console は触らない）が、各群を `parseEncounterGroup` で解釈し、`*m..n` は**最大数**（`it.max`）に展開して、敵ごとに `MonsterDef.size`（無ければ 1x1）と先頭 1 体だけの `@` 配置を `placeEnemies`（段1）へ通す。置けなかった敵は `EncounterGroupError`（`mapId` / `group` / `monsterId` / `nth` / `kind`〔`invalid-size` `out-of-range` `overlap` `full` `invalid-grid`〕/ `reason`）になり、1 件でもある群は `valid[i]=false`。未知のモンスター id は数えない（`rollEncounter` が警告して飛ばす寛容さのまま）。呼び出しは `rpgProjectFromDoc` の後段（`battleEnemyGrid` が有効、かつ `options.validateEncounterGroups !== false` のときだけ）で、`collectEncounterGroupInputs` が doc の全シーンの `RpgMap.encounter_groups` を集めて検証し、エラーがあれば `console.error('[name-name] …')` に一覧を出して `RPGProject.encounterGroupErrors` に載せ、返す対象マップの `encounterGroups` から収まらない群を外す（読み込みは続行。全部外れた群リストは空になり `rollEncounter` は不発）。`battle_enemy_grid` が無いゲームは何もしない。エディタ（`EditorScreen`）が編集用に導出する project は doc へ書き戻すため `validateEncounterGroups: false` で呼ぶ（検証・除外しない）。ただしエディタの「プレイ」タブの `RPGPlayer` へは、`rpgSubTab === 'play'` のときだけ検証ありで別に導出した project（`rpgPlayProject`）を渡す。プレイ（`PlayerScreen`）は既定の検証あり。一枚絵フィールドサンプルは `fieldSample/config.ts` の `parseConfig` が同じ関数で `battle.enemyGrid` 有効時に全シーンの `groups` を検証して外し、`FieldSampleConfig.groupErrors` に載せて `console.error` を出し、`main.ts` が画面のエラー表示にも出す（`monsters.<id>.size` / `scale` と `battle.enemyGrid` / `enemyWindowOverlap` もここで読む）。戦闘時の保険は `BattleScreen.placeEnemyFootprints` で、置けない敵は描かず `console.warn` を出す（敵は戦闘に残る）。書き方は `docs/guide/enemy-formation.md`、設計は `docs/design/enemy-formation.md` §3.5。
- 敵の特技 `SkillDef` / `BattleEngine.performSkill` (#834、敵の行動パターン P0 / 設計 #832) — `[特技 id]` ブロック（`名前` / `対象` / `効果` / `builtin` / `メッセージ` / `予兆`）を parser（`master.rs` の `build_skill_def` → `Event::Skill(SkillDef)`、emit も対応。wasm は `parser/pkg` 再ビルド・コミット済み）が `[呪文]`（`SpellDef`）とは別のマスターデータとして読み、`collectMasterData` / `mergeMasterDataFromDocs`（`rpgProjectFromDoc.ts`）が `skills` に集め、`RPGProject.skills` に載せる。`MonsterDef` には触れない（どの敵がいつ使うかの紐づけは #835）。**MP は持たない**。`対象` は使う側から見た相対表現（`相手単体`〈既定〉/ `相手全体` / `自分` / `仲間単体` / `仲間全体`）で、parser は生文字列で透過し、`BattleEngine.performSkill(user: BattleActorRef, skill: SkillExecution, target?: BattleActorRef)` が使い手の側から解決する（敵が使えば相手=味方側。解決は rng を使わない）。効果は `selectSpell` と同じ評価器（`parseEffect` / `applyEffect`、`builtin` は `invokeBuiltinSpell` のレジストリ）を内部で共有し、結果の記録も `recordEffect` を通る（`BattleActionEvent` に `kind: 'skill'`・`label` = 特技名・`message` = `{user}` 置換後の文を残す。FF 式演出は呪文と同じ表示経路で名前を窓に出し、使い手は `cast` ポーズ、時間割は呪文と同じ）。`performSkill` は**フェーズ・ATB ゲージ・勝敗判定を進めない**（敵ターンの途中で呼んでも終了処理が二重にならないよう、呼び出し側が行う）。この段階では誰も `performSkill` を呼ばないので、行動を書かない敵の挙動・rng の消費順は従来と完全に同じ。エンジンの内部名に特定ゲームの語彙は持ち込まない（sit-by-me の `sit_` + 英語 3 語の id 規約は設定側の話）。
- 敵の行動パターン P1 (#835、設計 #832) — `[モンスター]` の `行動:` 行（複数可）を parser が `MonsterDef.actions`（書いた順の生文字列。`master.rs` の `collect_actions`、emit も対応。wasm は `parser/pkg` 再ビルド・コミット済み）で透過し、`encounter.ts` が戦闘への組み立て時に `BattleEntity.actions` へ写す。解釈は新規 `game/enemyAi.ts`（`parseActionRule(s)` — 効果 DSL と同じ流儀で不正な行は `console.warn` して無視、`chooseEnemyAction(state, enemyIndex, rng)` — **純粋関数**。上の行から条件〈初手 / `HP<N%` / 仲間数 / 味方数〉を評価し、最初に成立した行の候補から重み付き抽選。`対象=` で `ランダム` / `HP最小` の相手も選ぶ）。状態は `BattleState.enemyMemory?: EnemyMemory[]`（`enemies` と同じ index。いまは行動回数 `acted` だけ）で、**`行動:` を持つ敵がいる戦闘のときだけ作る**（`createEnemyMemory`）。`BattleEngine` の従来ターン制 `runEnemyTurn` と ATB の `runAtbEnemyAction` が同じ `decideEnemyAction`（→ `chooseEnemyAction`）を使い、特技は #834 の `performSkill`（エンジンの `skills` オプション = `toSkillExecutions(RPGProject.skills)`。`fieldBattle.ts` の `roster.skills` 経由）で実行、行動後に `acted++`。`行動:` を書かない敵は rng を触らず通常攻撃のまま（既存の挙動・乱数の消費順は不変）。カウンター／死亡時は P3（#837、下の項）。実機確認用に戦闘画面サンプルの設定 JSON が `enemies[].actions` と `skills` を受け取る（例: `public/battle-sample/enemy-actions.json`）
- 敵の行動パターン P2 (#836、設計 #832) — `enemyAi.ts` に `順番=A > B > C`（`候補=` の代わり。rng を消費しない）・`予兆=`・`上限=N`（行ごとの使用回数）と条件 `回数>=N` / `周期=N[/R]` / `使用<特技>>=N` / `状態=` / `味方状態=` を追加。`EnemyMemory` に `rule`（直前に選ばれた行）・`pos`（順番の位置）・`used`・`ruleUses` を足したが、**P2 の語彙を使う敵だけ**が行動後に持つ（`chooseEnemyAction` が `ChosenAction.track` を返し、エンジンの `countEnemyAction` が純粋な `recordEnemyAction` で記憶を進める。使わない敵の記憶は `{ acted }` のまま・rng の消費も不変）。選ばれる行が変わると位置は先頭に戻る。予兆は `SkillExecution.telegraph`（`[特技]` の `予兆:`。行の `予兆=` が優先）を `performSkill` がログに足し、`BattleActionEvent.omen` に載せる。FF 式のメッセージ窓は `omen ?? label` を出す。状態条件は既存の `BattleEntity.status`（効果 DSL の `status`）に依存し、ターン経過の減衰は未実装のまま。実機確認用の設定例は `public/battle-sample/enemy-order-omen.json`
- 敵の行動パターン P3 (#837、設計 #832) — `[モンスター]` の `反撃:`（複数可）と `死亡時:`（最初の 1 行）を parser が `MonsterDef.counters` / `onDeath`（生文字列。`master.rs` の `collect_values`、emit も対応。`parser/pkg` 再ビルド・コミット済み）で透過し、`encounter.ts` が `BattleEntity.counters` / `onDeath` へ写す。解釈は `enemyAi.ts`: `parseActionRule(line, 'reaction')`（`順番=` `上限=` を弾く）、`parseCounterRules` / `parseDeathRules`、**純粋関数** `chooseEnemyReaction(state, enemyIndex, rules, rng)`（毎回先頭から評価・重み抽選。成立する行が無ければ `null`＝何もしない。狙いは `対象=` か直前の攻撃者）。条件 `被弾>=N` / `受けた=物理|魔法|アイテム[:名]|呪文:名|系統:x` と対象 `最後に攻撃した者` は `行動:` でも使える。`EnemyMemory` に `hits` `lastHit` `lastAttacker` `died` を足したが、**`tracksHits(enemy)`（反撃・死亡時を持つ、または `行動:` に被弾の語彙を書いた）敵だけ**が持つ（`createEnemyMemory` は `行動:` `反撃:` `死亡時:` のいずれかを持つ敵がいる戦闘で作る）。エンジンは `selectAttack` / `selectSpell` / `selectItem` が行動前後の HP から `PartyReaction`（攻撃者・被弾の種類・行動前 HP）を作り、`advanceAfterPartyAction(react)` が **勝敗判定より前に** `reactToPartyAction`（被弾した敵ごとに 1 回の反撃 → `resolveDeaths`）を呼ぶ。反撃は味方の行動からしか起きないので連鎖しない（1 段）。`resolveDeaths` は敵の特技で倒れた分も含め `runEnemyTurn` / `runAtbEnemyAction` からも呼ぶ。倒れた本人が使うため `performSkill` に `opts.allowDowned` を足した。ATB は行動者の index を反撃の前に控え（`currentActorIndex` が倒れた者を飛ばすため）、`pruneDownedParty` でキュー・ゲージを整える。同時全滅は従来どおり（ターン制は敗北、ATB は勝利）→ #877 で ATB も敗北優先に変更。`反撃:` `死亡時:` を書かない敵・P2 までの敵の挙動と乱数の消費は不変。実機確認用の設定例は `public/battle-sample/enemy-counter.json`（設定 JSON は `enemies[].counters` / `onDeath` を受け取る）
- 敵の条件: 受けたダメージの値 (#871 段階1) — 条件 `ダメージ=奇数|偶数|N の倍数`・`ダメージ<op>N`・`ダメージ桁数<op>N` を `enemyAi.ts` の `parseCondition`（`ダメージ…` は `parseDamage`）が解釈する。**parser（Rust）・wasm の変更は無い**（条件は `行動:` `反撃:` `死亡時:` の生文字列の中）。式の解釈・評価は純粋関数 `numberPredicate.ts`（`parseNumberPredicate` / `matchesNumber` / `digitCount`。味方側の対象指定 #876 が同じ語彙で使えるよう切り出した）。値は `BattleEngine.damageDealtBy` が、味方の行動の直後に記録された演出イベントの `hits`（`kind: 'damage'`・即死でない・敵が対象）の `amount`（画面の数字）を敵ごとに合計して `PartyReaction.damage` に載せ、`reactToPartyAction` が **`tracksDamage(enemy)`（`ダメージ…` を書いた敵）だけ**の `EnemyMemory.lastDamage` に書く。HP が減ったかに関わらず味方の行動 1 回ごとに置き換え、数字が出なかった手番（MISS・無効・吸収・即死のみ・対象外の敵）は消す（`react` を作らない手番は `clearLastDamage`）。書かない敵の記憶・乱数は不変。条件は `lastDamage` が無ければ常に不成立。検証ハーネスに族 `damage-condition`（`generate.ts` の `damageConditions`。8 を当ててから MISS・吸収・表示 0 を受ける並びを含み、検出器 `damage-memory` が前回値の持ち越しを見る）を足した（他の族のシナリオ・順序は不変）
- 属性相性 (#872) — `[モンスター]` の `弱点:` `半減:` `無効:` `吸収:` を parser が `MonsterDef.affinity`（`master.rs` の `interpret_affinity`。小文字・半角に正規化、欄間の重複は優先順位の高い欄を採って警告。emit 対応、`parser/pkg` 再生成・コミット済み）にし、`encounter.ts` / `startTestBattle` が `affinityField` で `BattleEntity.affinity` へ写す。解決は新規 `game/affinity.ts`（`resolveAffinity` — 吸収 > 無効 > 半減 > 弱点で打ち切り・該当なしは従来の `resist`、`deathSuccessRate` / `rollDeath` — 即死の成功率）で、`spellDsl.ts` の `damage` / `damage_full` と builtin `zaraki` が使う（呪文・特技・アイテムの 3 経路は `applyEffect` を共有）。通常攻撃・複数属性・味方側の属性は未対応。実機確認用に戦闘画面サンプルの `enemies[].affinity`（`party[].affinity` は読み込みエラー）と `public/battle-sample/enemy-affinity.json`
- 戦闘の上限・HP 下限の基盤 (#877 段階 1) — 新規 `game/battleLimits.ts` に `MAX_DAMAGE = 9999`（1 回のダメージの上限。敵 HP は上限なしが決定、味方 HP・回復量は未決で現状は上限なし）・`MIN_HP = 0`と、`clampDamage` / `clampHp` / `applyDamageToHp`（ダメージを上限で頭打ちして HP から引く唯一の口。頭打ち後の量を返し、ログ・ダメージ数字はこれを使う）。`battleEngine.ts` の通常攻撃 4 箇所と `spellDsl.ts` の `damage`（相性補正・`resist` 経由とも）が経由する。`heal` は `clampHp` で 0〜最大 HP に収める（負値の回復で負 HP にならない。既定で有効）。builtin など HP の前後差で数字を出す経路も `recordEffect` で 9999 に頭打ち。`damage_full`（即死）は HP を直接 0 にする。**検証ハーネスが見つけた壊れの修正 (#877)**: `applyDamageToHp` は負の量を 0 として扱い（ダメージは HP を増やさない）、負の `resist` は 0 に丸め（相性は `吸収:` に一本化）、復活・吸収は `clampHp(…, maxHp)` で最大 HP に止める。吸収量も `clampDamage` で 9999 に頭打ち。同時全滅は `checkEnd` / `advanceAfterPartyAction` で味方全滅（敗北）を先に判定し、ATB は `settleAtbPhase` に一本化して倒れた味方をキューから外す。即死は `EffectContext.onKill`（`damage_full` 成功時・builtin `zaraki`）で知らせ、`recordEffect` が hit に `instantDeath: true`（`amount` は HP の前後差）を付け、`BattleScreen.spawnPopup` は数字を出さず、ログは `damage_full` が「〇〇 は たおれた！」、zaraki は従来どおり「〇〇 は しんでしまった！」で、どちらもダメージの数字は出さない。**未着手（後続段階）**: 成功率・バフ重ね掛け・持続の上限、検証ハーネス（段階 3）。**高 HP の表示 (#877 段階 2)**: 実ブラウザで HP 9999〜7 桁 × ff/dq × 敵 1〜3 体 × 4 画面サイズを測定し、はみ出したのは回復・吸収などの 5 桁以上のダメージ数字（枠の一辺・画面端を越える）と、狭い窓での敵ラベル HP 行の最大値の桁の途中切れ（最大値 3 桁以上で起きうる。9999 以下の狭い窓でも出力が変わる）だけだった。数字は `fitPopupFontSize`（`battleMotion.ts`）で 4 文字（上限 9999）の幅に収まるよう文字数に比例して縮め（4 文字以下は不変）、`fitHpLabel` は数値が入らないとき最大値の桁を途中で切らず「現在値/…」にする。味方欄（`computeStatusColumns`）・dq 式の `HP n/m`（front）は 7 桁でも変更なし（既存の段階的な省略で収まる）。桁区切り・万/億の短縮は決定がなく未実装。既存の `LOG_MAX` / `EVENT_MAX` / `ATB_*` / `DEATH_CHANCE_CAP` は意味が違うので移していない（所在は `battleLimits.ts` の冒頭コメント）
- 状態異常 (#870 段階1) — `[状態 id]` ブロック（`名前` / `持続` / `継続ダメージ` / `行動` / `反転` / `解除` / `満了`）を parser が `Event::Status(StatusDef)`（`master.rs` の `build_status_def`。名前以外は生文字列で透過・空は未指定、emit 対応、`parser/pkg` 再生成・コミット済み）にし、`rpgProjectFromDoc.collectMasterData` が `statuses` に集約して（宣言したゲームだけ `RPGProject.statuses`）`fieldBattle` → `BattleEngine` の `opts.statuses` へ渡す（TopDown / Raycast / 戦闘画面サンプルの `statuses` 配列）。解釈・判定は新規 `game/statusEffects.ts`（`parseStatusDef` — 不正値は警告して既定に落とす、`activeStatusRules` / `blockingAction`〈行動不能 > 混乱〉/ `reversalOf` / `statusSuccessRate`〈`deathSuccessRate` と同じ耐性の式〉）。効果 DSL は `status {id} [duration=N] [確率=P]`（P は 0〜99、`MAX_STATUS_CHANCE`。省略は必中で乱数を使わない）と `cure {id|all}` を追加し、`EffectContext.statusRules` があれば `heal` / `damage` に回復・ダメージの反転を掛ける（`onAmount` / `onHit` の `reversed` → `BattleHit.reversed`）。エンジンは宣言があるときだけ動く: 状態は**その者の手番の終わり**に進み（`tickStatuses`: 継続ダメージ → 持続 −1 → 満了。従来ターン制は味方側の行動 1 回の直後に味方全員、ATB は本人の行動の直後、敵は各敵の行動の直後。今の手番の中で付いた分は、付与者を問わず進めない〈`freshStatuses`。手番の終わりごとに全部消す〉）、継続ダメージ・満了は `BattleActionEvent.kind: 'status'`（本人が actor、`battleMotion` は動かず数字だけ）、行動不能・混乱の味方はコマンド待ちに入った時点で `autoResolveParty` が自動で解決し（再入防止・1000 手番の安全弁）、敵は行動を選ばず手番を過ごす。倒れた者は宣言済みの状態を失い（`pushEvent` の前に掃除）、HP が減って生き残れば `解除: 被ダメージ` の状態が解ける。持続は `MAX_STATUS_TURNS=99` で頭打ち（`battleLimits.ts`）。耐性は `[モンスター]` の属性欄に状態 id を書く。表示は `BattleScreen` が味方は名前の前に `[どく]` を前置き、敵は名前の後ろに先頭 1 つ＋「…」（`battleLayout.fitEnemyLabelWithStatus`）。FF 式は HP と同じく再生位置で切り替える（`BattleActionEvent.statusLabels` に記録時点の全員の状態名を持たせ、`BattleScreen` の `statusOverride` が命中の瞬間に進める。状態が一度も付かない戦闘では付かない）。parser は名前なし・空 id・未知キーを警告し、同じ id の重複は `collectMasterData` が警告する。宣言の無い戦闘・宣言の無い id（属性欄の耐性も当てない）は従来と完全に同じ（乱数の消費も同じ。検証ハーネス 21,416 件が main と完全一致）。検証ハーネスに `status-matrix` / `random-status` 族と `status-invariant` 検出を追加。例 `public/battle-sample/status-effects.json`
- 複数ヒット (#879 P1) — 効果 DSL `damage … 回数=N`（`spellDsl.ts` の `parseEffect` が `ParsedEffect.count`・`warnings`、不正値・damage 以外への付与は `(警告: …)` を戦闘ログの先頭に出す。parser(Rust) は効果 DSL を解釈しないので変更なし）。`applyEffect` は N>=2 のときだけヒットごとに `EffectContext.onHit` で通知し（`pool` = 行動者から見て相手陣営の単体を狙うときだけ渡す相手陣営の全員。その単体は倒れたら pool の先頭の生存者へ乗り換え、自分・仲間を狙うときは pool 無しで倒れたら打ち切り、全体は N 巡）、未指定・1 は従来経路のまま。`battleEngine.ts` の `recordEffect` は通知列があるときだけそれを `BattleActionEvent.hits`（再生順・hpBefore/hpAfter 連鎖・任意の `round`）にし、無いときは従来の HP 前後差。上限 `MAX_HITS_PER_ACTION`（`battleLimits.ts`。99・値は未決で暫定）。各ヒットのダメージにも `applyDamageToHp`（上限 9999）が掛かる（ヒットごとの上限で、行動全体の合計には掛からない）。表示 (P2) — `battleMotion.ts` の `ActivePlayback.hitFired` を `firedRounds`（発火済みの round 数）に変え、`advancePlayback` は `groupHitsByRound` で hits を round ごとにまとめ、`hitTimeOf(hitAt, round, interval)` = `hitAt + round * interval` で 1 組ずつ `HitFire`（`hits`・`round`）にする。間隔 `interval`（`ActionTimeline.hitInterval`）は `multiHitIntervalFor(最大 round)` = `max(MULTI_HIT_MIN_INTERVAL_MS, min(MULTI_HIT_INTERVAL_MS, MULTI_HIT_TOTAL_MS / 最大 round))`（基本 100ms・総時間 2000ms・下限 10ms はいずれも暫定・未決。最大 round 20 以下は 100ms のまま従来と同じ。99 ヒットでも最後の命中は約 2 秒）。`eventTimeline` は最後のダメージ・倒れるヒットの round に加え、種別（damage・heal・miss）を問わない最大 round（`lastRound`）の命中まで `duration` を保証する（round 無し・全 0 は従来値）。`BattleScreen` は `fire.hits` だけを発火し、のけぞりは「発火済みの最後の damage ヒット」から測って毎ヒット再トリガ、数字は `popupStackIndex`（同一イベントの同一対象の何番目か・最大 5 段）ぶん縦にずらす（単発は 0 段で従来位置）。段の間隔は縮小前の基本フォントで決め（#877 の 5 桁以上の縮小に揃えると、桁が混ざる連続ヒットで重なるため）、縮んだ数字は `popupCenterOffset`（battleMotion.ts）で基本サイズの段の中の上下中央に置く（4 文字以下は 0 で #879 の位置のまま）。例 `public/battle-sample/multi-hit.json`

`TILE_COLORS_HEX` がタイルの描画色（PixiJS `Graphics` で矩形塗りつぶしに使用）。

### レンダラー共通インタフェース（TopDownRenderer / RaycastRenderer）

| API               | 説明                                                    |
| ----------------- | ------------------------------------------------------- |
| `init(container)` | PixiJS `Application` を生成し `<canvas>` を親要素に追加 |
| `load(gameData)`  | マップ・プレイヤー・NPC を描画して入力受付開始          |
| `destroy()`       | ticker・イベントリスナー解除、PIXI `Application` 破棄   |

内部はレイヤ分割：`mapLayer` / `npcLayer` / `playerLayer` を `world` コンテナに束ね、プレイヤー位置に追従するカメラ（`world.x/y` のオフセット更新）を適用する。マップが画面より大きい場合のみクランプ、小さい場合は中央寄せ。

### フィールドから戦闘画面への入退場（`fieldBattle.ts`, #784）

TopDownRenderer / RaycastRenderer は同じ共通モジュールで `BattleScreen` を開閉する。レンダラーに残る責務はエンカウント抽選・クールダウン・移動入力だけ。

- `readFieldBattleSettings(gameData)` — frontmatter 由来の戦闘設定（layout / background / spriteStyle / windowStyle / 背景トーン・DoF / ログタイプライタ / 奥行き / 前景 / pixelArt / ATB / コマンド配置・表示名）を読み、既定値を一箇所に持つ。レンダラーは `battleSettings` として保持する
- `buildPartyBattleEntities` / `buildHeroBattleEntity` / `partyDefToBattleEntity` — パーティマスター → 味方 `BattleEntity` の純粋関数（front は先頭 1 人、side は全員）
- `FieldInputGate` — 戦闘をまたぐキー入力状態。押下中の矢印キー（戦闘開始時に `initialHeldKeys` として渡す）・戦闘終了時に押されていたキーを離すまで無視する gate・設定オーバーレイ中の停止（`setInputSuspended`）・blur でのクリアを持つ
- `openFieldBattle(...)` — `BattleEngine` + `BattleScreen` を組み立ててステージへ載せ、終了（勝利・逃走・全滅）で直後の canvas tap を抑止（`suppressNextTouchTap`。戦闘を終わらせたタップがフィールドのメニューを開かないように）し、画面を畳み gate を張って `onClosed(outcome)` を呼ぶ。`closeFieldBattle(stage, screen)` は戦闘中の `load()` / `destroy()` が `onClosed` を呼ばずに強制的に畳むための共通ヘルパー（畳み済みの画面の古い `onClose` は無視される）。`encounterCooldown = 3` は各レンダラーが `onClosed` でセットする（戦闘終了時）
- 戦闘中（`battleScreen != null`）は、どちらのレンダラーもフィールドの入力・移動・エンカウント抽選を止め、ticker で `BattleScreen.tick`（ATB）を進め、リサイズで戦闘画面も再配置する。TopDown は加えてタップ／スワイプも止め、エンカウントした歩の踏み込みトリガーを戦闘終了後（勝利・逃走のみ。全滅では発火しない）に回す。設定オーバーレイ中は ATB の `BattleScreen.tick` も呼ばない

### プレイヤー移動

- 矢印キー / WASD でグリッド単位に移動（1タイル単位）
- 通行不可タイル（TREE / WATER）と NPC のいるタイルには入れない
- 移動中は `performance.now()` ベースで 150ms かけて線形補間し、完了まで次入力を受け付けない
- 進行方向に小さな三角マーカーを表示（向きの視覚化）

### NPC スプライトとアニメーション（TopDown / Raycast 共通）

`frontend/src/game/npcSpriteSheet.ts` にロード・切り出し・手続き生成の責務を集約。両レンダラーは同じ `loadNpcSpriteSheet` / `clampFrames` / `directionToRow` / `clearDemoSheetCache` API を共有する。

- **シート規約**: `frames × 4` グリッド。行 = 向き（0: `down`, 1: `left`, 2: `right`, 3: `up`）、列 = 歩行フレーム（0..frames-1）。各セル `tileSize × tileSize`
- **`frames` 値域**: parser は `>= 1` を受理するが、レンダラー側で 1〜4 に clamp（`clampFrames`）。未指定は 2（ドラクエ式）
- **アイドルアニメ**: 500ms 周期で frame 0 ↔ 1 をループ（`frames=1` なら静止）。NPC ごとに位相オフセットを与え、画一感を防ぐ
- **向き**: `UiNpcData.direction`（未指定なら `down`）に対応する行を表示。アイドル中は固定（自律移動・プレイヤー追従は未対応）
- **外部スプライト**: `PIXI.Assets.load(path)` で PNG 等をロード。失敗時は `console.warn` して単色 billboard のまま維持
- **`__demo` センチネル**: `sprite: '__demo'` 指定時は `buildDemoSheet` で `RenderTexture` に頭・胴体・目・足を描いた簡易スプライトを生成する。リポに画像アセットを持たずに「NPC が動く」デモを成立させるための仕組み。`(color, frames, tileSize)` 組で `WeakMap<Renderer, Map>` にキャッシュされ、同条件の NPC 間で共有される
- **フォールバック**: `sprite` 未指定・ロード失敗は単色矩形で描画（TopDown は色付き四角 + 赤枠、Raycast は billboard sprite に `Texture.WHITE` + `tint` = `data.color`）

#### TopDown 固有

プレイヤーと同じ `world` コンテナ内の `npcLayer` に NPC 単位の `Container`（`Sprite` + placeholder `Graphics`）を配置。スプライトロード完了時に placeholder を `visible=false` にして切り替える。

#### Raycast 固有

`npcLayer` を stage 直下に配置（`worldLayer` とは分離）。NPC ごとに:

- **Sprite + Graphics mask**: sprite は常に 1 つ、初期状態は `Texture.WHITE` を `data.color` で tint。シートロード完了で texture を差し替え、tint はフォグ専用に再利用
- **距離ソート**: `npcLayer.sortableChildren = true`。毎フレーム `container.zIndex = -transformY` で奥→手前順に描画
- **列単位の z-buffer 遮蔽**: 壁との遮蔽は mask Graphics に可視列だけ `rect()` + `fill()`。従来の `Graphics.rect` + 直接描画と同等の正確性を保ったまま Sprite ベースに移行した
- **フォグ**: スプライトロード済みは `tint = applyFog(0xffffff, fog)`、未ロード（単色）は `tint = applyFog(n.data.color, fog)`
- **射影計算の純粋関数化**: NPC のカメラ座標系への射影（transformX/Y、同一タイル・背面・退化カメラの culling、スプライトサイズ・描画範囲の算出）は `frontend/src/game/raycastProjection.ts` の `projectNpcToScreen` 純粋関数に切り出し済み。`depth` は生の transformY（z-buffer 比較用）、`spriteHeight` は `minDepth` クランプ後の深度から算出。境界値ユニットテストは `raycastProjection.test.ts`

#### 壁テクスチャ（Raycast）

壁描画は「縦ストライプ Sprite プール」方式で行う。

- **レイヤ順**: `worldLayer` 直下に `worldGraphics`（空のベタ塗り + 床の per-tile floor casting、奥）、`wallSpritesContainer`（壁 Sprite プール、その手前）、`stepWallSpritesContainer`（段差壁面 Sprite プール、さらに手前）を配置。NPC は stage 直下の `npcLayer` にあるため、空 → 床 → 壁 → 段差壁 → NPC の順で重なる（段差壁は常に壁より手前なので、段差壁ピクセルは壁の上に描かれる）
- **ストライプ Sprite プール**: `numStripes = ceil(screenWidth / stripeWidth)` 個の `Sprite` を `wallSpritesContainer` に保持。毎フレーム texture / x / height / tint / visible を更新して再利用する。画面リサイズで `numStripes` が変わるときは `ensureStripePool(target)` で余剰を destroy、不足を生成
- **テクスチャ**: `wallTextureSheet.ts` が TREE / WATER ごとに `TEXTURE_WIDTH=64` × `TEXTURE_HEIGHT=64` のベース RenderTexture を作り、左から 1 列ずつ 64 本の縦ストライプ Texture に切り分けてキャッシュする。`loadWallTexture(kind, renderer, externalPath?)` が非同期でこのシートを返す。ロード前は従来の `worldGraphics` ベタ塗り fallback を使う
- **u 座標の算出**: DDA で hit した壁の位置から `computeWallU(side, perpDist, px, py, rdx, rdy)` → [0, 1) の u を求め、`uToColumn(u, width)` で列 index に変換して `sheet.columns[col]` を Sprite.texture に設定する。Lodev 方式の u 反転（side=0 && rdx>0、side=1 && rdy<0）を純粋関数内で処理
- **テクスチャ切り出し（crop モード、Issue #86 Phase 2-5）**: 短い壁（wallHeight<1）はテクスチャの下部 `wallHeight` 分のみを 1:1 スケールで表示する。純粋関数 `computeWallTextureCrop(textureHeight, wallHeight)` が `{frameY, frameHeight}` を返し、RaycastRenderer は `new Texture({ source, frame: new Rectangle(col, frameY, 1, frameHeight) })` を毎フレーム生成して Sprite に割り当てる。pixel scale = `lineHeight/textureHeight` が wallHeight に依らず一定 → レンガ模様が縦潰れしない。wallHeight>=1 は texture 全体を使う従来 stretch 挙動（tiling は別 Issue）。wallHeight<=0 / NaN / Infinity は `frameHeight=0` で描画スキップ
- **フォグ**: `tint = applyFog(base, fog)` で暗く落とす。y-side（side=1）は `darken(0xffffff, 0.7)` を基底にしてから fog 適用し、壁面の立体感を保つ
- **デモテクスチャ**: リポに画像アセットを持たずに「色ベタではないテクスチャ」の体験が成立するよう、`__demo_tree`（緑系の木目 + 節目）と `__demo_water`（青系の波模様）を手続き生成する。`(renderer, kind)` 組で `WeakMap<Renderer, Map>` にキャッシュされ、`clearDemoWallCache(renderer)` で一括解放
- **テスト**: 純粋関数 `uToColumn` / `computeWallU` / `computeWallTextureCrop` の境界値テストは `wallTextureSheet.test.ts`。PixiJS 描画自体は手動確認

#### 床描画（Raycast）

床は壁と同じく「2D マップ上の各タイルが、透視投影で先細りした四角として見える」状態を狙う。`worldGraphics` に対するスキャンライン floor casting で実装する。

- **アルゴリズム**: ホライゾン以下の各 y スキャンラインについて、純粋関数 `computeFloorRowDist(y, horizonY, screenHeight, cameraZ)` で「そのスキャンラインが地表で何タイル先か」（= `rowDist = cameraZ / ((y - horizon) / (h/2))`）を求め、画面左端 (cameraX=-1) / 右端 (cameraX=+1) を貫くレイの世界座標を線形補間する。x ピクセルごとに純粋関数 `sampleFloorTileColor(mapTiles, mapWidth, mapHeight, wx, wy, palette, fallback)` でタイル色を引き、連続同色のランを 1 つの `g.rect(x, y, runWidth, 1).fill(color)` にまとめる
- **カメラベクトル共有**: `dirX/Y` と `planeX/Y` は `renderFrame` 冒頭で 1 度だけ計算し、床 floor casting と壁 DDA の両方が同じ値を参照する。途中で `playerAngle` を書き換えないため両者は必ず同一フレームの値で揃う
- **色対応**: `TILE_COLORS_HEX[tile]` を palette に渡す（TopDown 側と同じ単一情報源）。マップ範囲外や palette に無いタイル種別、`mapTiles[ty]` 行が undefined のケースは fallback `TILE_COLORS_HEX[TileType.TREE]` に倒す。WATER タイルは palette に登録があるため青 (`0x4169e1`) で描画される（2D マップと一致する見た目）。歩ける床ではないが、視界の遠方の水面が視覚的に伝わる
- **per-tile な見え方**: 1 マスだけ ROAD があるマップなら、画面上に茶色のタイルが 1 枚だけ「透視投影で先細りした四角」として現れる（厳密にはハイパボリック投影なので奥行きが非線形に圧縮されるが、見た目は台形に近い）。NPC ビルボードと同じく「遠くは小さく近くは大きく」見える。1 サンプル/スキャンライン方式（旧 #172）の「踏み込んだ瞬間に画面全体が切り替わる」見栄えはここで解消される
- **計算量**: `w × (h - horizon)` の `sampleFloorTileColor` 呼び出し + ランチェック。800 × 300 ≈ 240k ops/frame、fill 呼び出しは 1 行あたり通常数個に収束する
- **既知の制限**: 床テクスチャは未対応（壁の `wallTextureSheet` 相当はない）。pitch が大きいときの遠近歪みも単色塗り分けなので許容範囲
- **テスト**: `computeFloorRowDist` / `sampleFloorTileColor` の境界値（horizon 直下、`row` 穴あき、palette 未登録、`NaN/Infinity`、マップ範囲外）は `raycastProjection.test.ts` で網羅

#### スワイプ 90° 旋回アニメ（Raycast）

スマホのスワイプ ← / → による 90° 旋回は瞬間スナップではなく `turnAnimSpeed = 10 rad/s` での角度補間で進める。π/2 ≈ 1.5708 rad を 0.157 秒で消化する。

- **データモデル**: `RaycastRenderer.turnAnimRemaining: number`（rad、符号付き）に「あと回す角度」を積む
- **予約 (`queueTurn`)**: スワイプ left → `-π/2`、right → `+π/2` を積む。連打すると加算され 180°/270°/360° と連続回転する。残量は `±turnAnimMaxAbs = ±2π` にクランプ（4 連打で同向きへ戻る挙動を維持しつつ、100 連打で 16 秒回り続ける UX 事故を防ぐ）
- **消費 (`advanceTurnAnim`)**: `onTick` の dialog ガード**外**で毎フレ呼ぶ。ダイアログ / メニュー表示中も補間は進む（M1: 表示中に消費が止まると、閉じた瞬間に残量が残っていて角度がカクッと変わる事故を防ぐ）。純粋関数 `consumeTurnAnim(remaining, dt, animSpeed)` に消費ロジックを委譲
- **flush (`flushTurnAnim`)**: `snapStep` の先頭で残量を即時消費して角度を確定する。S4: 旋回アニメ中にタイル単位の移動（`Math.round(cos/sin)`）が走ると中間角度を拾って想定外のタイルに進む事故が起きるため、移動前に必ず flush する
- **minimap 連動**: 表示中だけでなく非表示中も `setPlayerAngle` でバッファだけは更新する。ダイアログを閉じて minimap が再表示された瞬間に矢印がカクッと飛ばないようにする
- **テスト**: `consumeTurnAnim` の境界値（残量ぴったり消化、符号反転、`dt=0` / `animSpeed=0`、`NaN/Infinity`、複数フレーム消化）は `raycastProjection.test.ts` で網羅

#### 壁高さ（wallHeights, Issue #49 Phase 1）

タイル座標ごとに壁の高さを変えられる。低い柵・高い塔のような段差表現が可能。

- **データモデル**: `MapData.wallHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`1.0` = 標準（従来挙動）、`0.5` = 腰高、`1.5` = 二階建て塔、`0` 以下 = 描画なし
- **未指定時**: `wallHeights` 自体が undefined、または該当行/セルが未定義の場合は `1.0` 扱い（既存マップは挙動不変）
- **TREE/WATER 以外のタイル**: `wallHeights` の値は無視される（壁でないので描画されない）
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `computeWallYRange(lineHeight, wallHeight, screenHeight)` が `drawStartY` / `drawEndY` を返す。地面位置（`drawEndY`）は wallHeight に依らず不変で、上端（`drawStartY`）が伸縮する。遠方カリング・フォグの伸長は `computeEffectiveFogMaxDist(baseFogMaxDist, wallHeight)`（Phase 2）。境界値テストは `raycastProjection.test.ts`
- **Sprite 配置**: 壁ストライプ Sprite は `anchor.set(0, 0)` で上端を `drawStartY` に置き、`height = drawEndY - drawStartY` で下端を地面に揃える。Phase 1 は縦方向全体スケール（壁が低いと texture 自体が圧縮されレンガ模様が潰れる）だったが、Issue #86 Phase 2-5 で `wallHeight<1` のときテクスチャ上端クロップ（`computeWallTextureCrop`）に切り替え、pixel scale が wallHeight に依らず一定になるようにした。`wallHeight>=1` は引き続き全体スケール
- **Phase 2 として残課題**: 視覚的な天井レンダリング（per-column ceiling texture）、真の斜面 + pitch の ray Z 成分導入（Issue #99）は別 Issue。pitch（上下視線）は #80 Phase 2-1、ジャンプ（z 方向の動き）は #80 Phase 2-2、床段差（踏み込むとカメラ z が上がる MVP）は Issue #84、天井段差（頭ぶつけ判定 MVP）は Issue #87、視覚的な床段差壁面レンダリングは Issue #88 Phase 2-7a で対応済み（下記参照）。Markdown 構文 / エディタ UI からの wallHeights / floorHeights / ceilingHeights 指定は #90 / #91 で対応済み
- **既知の制限（Phase 1 → Phase 2 引き継ぎ）**:
  - **NPC 遮蔽の壁高さ連動**: Phase 2 で対応済み。`wallTopYBuffer` で壁上端の画面 Y を列ごとに記録し、NPC mask は「壁が前にある列でも、壁上端より上の部分のみ可視化」する。低い壁（wallHeight=0.5）の奥にいる NPC の頭が壁の上から出る
  - **遠方カリング・フォグの壁高さ連動**: Phase 2 で対応済み。純粋関数 `computeEffectiveFogMaxDist(baseFogMaxDist, wallHeight)` が `wallHeight > 1` の塔に限り `baseFogMaxDist * wallHeight` まで上限距離を伸長する（`wallHeight <= 1` は通常の壁と同じ距離で消える）。描画スキップ判定 (`perpDist <= effectiveFogMax + 0.5`) とフォグ計算 (`1 - perpDist / effectiveFogMax`) の両方に適用
  - **寸法ミスマッチは警告のみ**: `wallHeights` の行数・列数が `tiles` と一致しない場合、`load()` で `console.warn` を出すが描画は止めない（該当セルは未定義 → 1.0 フォールバック）。Markdown / エディタ UI 経由の入力時にバリデーションを強化するのは Phase 2 課題

#### pitch（上下視線, Issue #80 Phase 2）

プレイヤーが上下に視線を振れる。一人称ダンジョン探索で「天井を見上げる」「足元を覗く」感覚を出す。ジャンプ・床段差の前提となる地平線シフト機構でもある。

- **入力**: PageUp で上向き、PageDown で下向き。`pitchSpeed = 1.5 rad/s` で連続変化、`pitchMaxAbs = 0.4 rad`（≒ ±23°）でクランプ。マウス Y は未対応（キーのみで十分）
- **データモデル**: `RaycastRenderer.playerPitch: number`（rad、ランタイム状態のみ）。`load()` ごとに 0（水平）にリセット。`MapData` への永続化や Markdown 構文での演出指定は別 Issue
- **px オフセット変換**: Lodev 方式の `pitchOffsetPx = round(Math.tan(playerPitch) * h/2)`。`pitchOffsetPx > 0` で画面中央が下にシフト＝視線が上向き＝空が広く見える、という符号定義に統一
- **適用箇所**: 空・床ベタ塗りの分割位置 `horizonY = h/2 + pitchOffsetPx`、壁ストライプの `computeWallYRange(..., pitchOffsetPx)`、NPC スプライトの `projectNpcToScreen(..., pitchOffsetPx)` および sprite.y。すべて同じ baseY を共有
- **純粋関数の signature 拡張（後方互換）**: `computeWallYRange(lineHeight, wallHeight, screenHeight, pitchOffsetPx?=0)` / `projectNpcToScreen(..., minDepth, pitchOffsetPx?=0)`。デフォルト 0 で Phase 1 の既存呼び出しは挙動不変。`NaN/Infinity` は 0 扱い（既存契約に準拠）。画面外クランプは `[0, h]` のまま
- **既知の制限**: pitch は描画上のシフト演出のみで、実際のレイ方向（dir / plane）には影響しない。pitch を大きく取っても遠方の壁が「上から見下ろされる」幾何にはならず、純粋な縦シフトのまま。Quake 系の真の pitch を実装するには ray の Z 成分を導入する必要があり、現状では非対応

#### ジャンプ（Issue #80 Phase 2-2）

プレイヤーが Z キーで小さくジャンプできる。pitch と同じ「baseY シフト」機構の上に乗せた、地に足の付いたカメラ高さオフセット演出。

- **入力**: Z キーで一度だけジャンプ（押下時のみ。`e.repeat` を弾く）。空中での再ジャンプは不可（着地中のみ受け付け）。マウスや Markdown 構文での jump 制御は未対応（別 Issue）
- **データモデル**: `RaycastRenderer.playerJumpZ: number`（タイル単位、0 = 床面、正でジャンプ中。Issue #84 で `playerZ` からリネーム）と `playerVZ: number`（タイル/秒）。`load()` ごとに `playerJumpZ=0, playerVZ=0` にリセット。`MapData` への永続化は別 Issue
- **物理パラメータ**: `jumpInitialV = 3.0` タイル/秒、`gravity = 12.0` タイル/秒^2。最高到達高 = `v^2 / (2g) = 9 / 24 = 0.375` タイル、滞空時間 = `2v/g = 0.5` 秒。控えめだが視点が変わる感覚は十分
- **更新ロジック**: `updateMovement(dt)` 末尾で「`playerJumpZ > 0` または `playerVZ ≠ 0` のときだけ」`playerVZ -= gravity*dt; playerJumpZ += playerVZ*dt`、`playerJumpZ <= 0` で `playerJumpZ=0, playerVZ=0` に着地スナップ
- **px オフセット変換**: `cameraZOffsetPx = round((playerGroundZ + playerJumpZ) * h/2)`（Issue #84 で床段差 `playerGroundZ` との合算化）。pitch と同じ符号規約（正で baseY が下シフト＝視点が上＝壁・NPC が下方向に見える）。`pitchOffsetPx + cameraZOffsetPx = totalYOffsetPx` を空・床ベタ塗りの分割位置と純粋関数（`computeWallYRange` / `projectNpcToScreen`）に渡す
- **純粋関数の引数意味の汎化（後方互換）**: `computeWallYRange(..., pitchOffsetPx?=0)` / `projectNpcToScreen(..., pitchOffsetPx?=0)` の `pitchOffsetPx` 引数は「pitch 由来 + cameraZ（ジャンプ）由来の合算 Y シフト」を受け取る契約に汎化。引数名は後方互換のため変更せず、JSDoc の意味だけ拡張。`NaN/Infinity` は 0 扱い、画面外クランプ `[0, h]` も従来通り
- **既知の制限**: ジャンプ中も `isPassable` 判定は変えない（現状壁は通行不可のまま、壁の上に乗る挙動は未実装）。Markdown 構文での jump 演出指定は別 PR で扱う（Issue #80 の他項目）。NPC 遮蔽連動・fogMaxDist 連動は Phase 2 で対応済み（本 PR、上記「既知の制限（Phase 1 → Phase 2 引き継ぎ）」参照）。床段差（floorHeights）は Issue #84 で対応済み、天井段差（ceilingHeights、頭ぶつけ判定）は Issue #87 で対応済み（下記参照）

#### 床段差（floorHeights, Issue #84 / Phase 2-7a Issue #88）

タイルごとに床の高さを変えられる。プレイヤーが踏み込むとカメラ高さが自動で上昇する。Issue #88 Phase 2-7a で、隣接タイル間の床高さ差が垂直な段差壁面として描画されるようになった。

- **データモデル**: `MapData.floorHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`0.0` = 地面標準（従来挙動）、`0.5` = 半段、`1.0` = 1 タイル分上。負値は沈み込み表現として許容
- **未指定時**: `floorHeights` 自体が undefined、または該当行/セルが未定義の場合は `0.0` 扱い（既存マップは挙動不変）
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `resolveFloorHeight(grid, tx, ty)` が床高さを返す。`getWallHeight` と同構造だが fallback は `0`（地面）。境界値テストは `raycastProjection.test.ts`
- **プレイヤー状態の分離**: `RaycastRenderer.playerGroundZ`（現在踏んでいるタイルの床高さ、床段差由来）と `playerJumpZ`（ジャンプ由来の相対高、旧 `playerZ` をリネーム）に分離。カメラ総オフセット `totalCameraZ = playerGroundZ + playerJumpZ` を `h/2` 倍して px に換算し、pitch オフセットと合算して純粋関数に渡す
- **更新タイミング**: `updateMovement(dt)` の移動処理後に `playerGroundZ = resolveFloorHeight(floorHeights, floor(x), floor(y))` で瞬時切替（補間なし）。段差の境界で視点が段階的にカクっと上がる
- **ジャンプとの関係**: ジャンプは床面（`playerGroundZ`）からの相対高 `playerJumpZ` で管理し、着地判定は `playerJumpZ <= 0`。床段差の上でも通常通りジャンプできる
- **寸法ミスマッチ**: `wallHeights` と同様、行数・列数が `tiles` と一致しない場合は `load()` で `console.warn` を出すが描画は止めない
- **段差壁面の描画（Issue #88 Phase 2-7a）**: DDA ループ中、ray がタイル境界を跨ぐ都度 `detectFloorStep(prevFloorZ, nextFloorZ)` で段差情報（`FloorStepInfo: lowerZ / upperZ / heightDiff / upperSide`）を検出し、壁ヒットまでに通過した境界のうち手前から最大 `maxStepsPerColumn = 3` 個を記録する。列ごとに `computeFloorStepWallYRange(lineHeight, lowerZ, upperZ, h, pitchOffsetPx)` で画面 Y 範囲を求め、`stepWallSpritesContainer` の Sprite プール（サイズ = `numStripes × maxStepsPerColumn`）から slot を取り出してテクスチャ・位置・フォグ tint を設定して描画する。テクスチャは MVP では TREE 壁の `wallTextureSheet` を流用（両隣は非壁タイルなので壁タイルの種類を参照できない）。u 座標は通常壁と同じ `computeWallU` を使う
- **段差の zBuffer / wallTopYBuffer 扱い**: 列ごとに段差のうち最も手前の depth を `frontStepDepth`、その drawStartY を `frontStepDrawStartY` として追跡する。`frontStepDepth < zBuffer[i]` なら `zBuffer[i]` を更新、`frontStepDrawStartY < wallTopYBuffer[i]` なら `wallTopYBuffer[i]` を更新する。これにより「段差の手前にいる NPC は段差で遮蔽」「段差の奥にいる NPC の頭が段差の上端より上に出ている部分のみ可視化」の両方が整合する。段差は常に壁より手前（DDA は壁ヒットで止まる前の境界）なので、この上書きは「より厳しい遮蔽」として安全に働く。`hit=false`（壁が視界外、`wallTopYBuffer[i]=h` のまま）のケースでも、段差が最前面なら wallTopYBuffer が段差の drawStartY で上書きされる
- **描画順と視覚重なり**: `stepWallSpritesContainer` を `wallSpritesContainer` の後に addChild するため、同じ列内では段差壁 Sprite が壁 Sprite の上に重ねて描かれる。列内で複数の段差がある場合は「奥から手前」の順に slot 0 → N に割り当て、子配列の描画順で自然に奥が先に塗られる
- **段差テクスチャの縦 pixel scale**: 通常壁の `computeWallTextureCrop` を段差にも流用する（Phase 2-7a R1 対応）。`computeWallTextureCrop(WALL_TEXTURE_HEIGHT, heightDiff)` で下部 `heightDiff` 分をクロップ（例: `heightDiff=0.25` → ベーステクスチャの下 16px のみ）。pixel scale = `lineHeight/WALL_TEXTURE_HEIGHT` が heightDiff に依らず一定になり、段差壁でもレンガ模様が縦潰れしない。`heightDiff > 1` のケース（stacked sheet が必要）は MVP では未対応 → tileCount>1 になったらフォールバックしてベーステクスチャ全体を `WALL_TEXTURE_HEIGHT` で切る（heightDiff>1 かつ frameHeight=WALL_TEXTURE_HEIGHT なので、stepDrawHeight > frameHeight となり、視覚的には縦に引き伸ばされる）
- **既知の制限**:
  - **u 座標の近似**: 段差の u 座標は「ray と段差面の交差点のタイル内位相」を近似的に `computeWallU`（通常壁向けの側面 u 計算）で算出している。真に正しい u は段差境界の「長辺方向の位置」だが、MVP では視覚的違和感が小さいので採用。隣接列で u が不連続になる可能性があり、レンガの横ラインが境界で段ズレする場合がある（Q1）。手動確認できないため、破綻しているケースが見つかったら Issue #99 と合わせて真の u を実装する
  - **1 列あたり段差最大 3 個**: `maxStepsPerColumn = 3` を超える段差は奥側から無視される。実測データに基づくチューニングは未実施（Q2）
  - **テクスチャは TREE シート固定**: 両隣が非壁タイルのため、段差側面の wallType を自動選択できない。MVP では TREE を流用
  - 真の斜面（連続高低差を ray 射影する）や CornerHeights、Camera.pitch の本物化（ray に Z 成分）は Issue #99 で別途扱う
  - Markdown 構文 / エディタ UI からの `floorHeights` 指定は別 Issue

#### 天井段差（ceilingHeights, Issue #87）

タイルごとに天井の高さを変えられる。プレイヤーがジャンプで頭をぶつけて跳ね返される MVP。視覚的な天井レンダリング（per-column ceiling texture）は別 Issue。

- **データモデル**: `MapData.ceilingHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`1.0` = 標準（従来挙動）、`0.5` = 低天井トンネル、等
- **未指定時**: `ceilingHeights` 自体が undefined、または該当行/セルが未定義の場合は `1.0` 扱い（既存マップは挙動不変）
- **フォールバック契約**: `NaN` / `Infinity` / `0` 以下は `1.0` 扱い。`resolveFloorHeight` が負値を沈み込みとして許容するのと対照的に、`resolveCeilingHeight` は退化ケース（天井が床より下）で頭ぶつけ判定が破綻しないよう `1.0` に倒す防御的設計
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `resolveCeilingHeight(grid, tx, ty)` が天井高さを返す。`resolveFloorHeight`（fallback 0、負値許容）と対照に fallback 1、0 以下非許容。境界値テストは `raycastProjection.test.ts`
- **ジャンプ干渉**: `updateMovement(dt)` のジャンプ更新ロジックで `playerJumpZ` の上限 = `ceilingHeight - playerGroundZ` を計算し、到達したらその位置でクランプ。`playerVZ > 0`（上昇中）のときのみ `0` に落として即落下開始（跳ね返り演出なし、MVP）。クランプ後も従来通り `playerJumpZ <= 0` で着地スナップ
- **寸法ミスマッチ**: `wallHeights` / `floorHeights` と同様、行数・列数が `tiles` と一致しない場合は `load()` で `console.warn` を出すが描画は止めない
- **既知の制限**:
  - 視覚的な天井レンダリング（per-column ceiling texture）は未対応。現状は頭ぶつけ挙動のみで、天井そのものは見えない
  - 跳ね返り演出（反発係数・下向き初速付与）もなく、天井到達時は即 `VZ=0` で落下開始
  - 空中移動で水平方向に低天井タイルへ入った瞬間、`playerJumpZ > maxJumpZ` なら位置だけクランプで下がる（z ポップダウン）。落下中（`VZ ≤ 0`）はそのまま落下継続するため影響軽微、MVP 許容
  - 天井が床より低い退化ケース（`playerGroundZ > 1` の床段差上に低天井を置く等）は `resolveCeilingHeight` が `1.0` にフォールバックするものの `maxJumpZ = 1 - playerGroundZ` が負になりうる。その場合は頭ぶつけ判定が即発動してジャンプが成立しないが MVP では許容
  - Markdown 構文 / エディタ UI からの `ceilingHeights` 指定も別 Issue

#### マップ検証（mapValidation, Issue #89）

wallHeights / floorHeights / ceilingHeights の次元が tiles と一致するかを純粋関数 `validateMapHeights(map)` で検証する。従来は `RaycastRenderer.load()` で field ごとに個別の `console.warn` を出していたが、Markdown 構文（#90）/ MapEditor（#91）からも同じ検証を呼べるよう純粋関数に切り出した。

- **場所**: `frontend/src/game/mapValidation.ts`
- **返り値**: `{ ok: boolean, errors: HeightDimensionError[] }`。errors は `{ field, kind, expected, actual, rowIndex? }` の配列
- **kind**: `row-count-mismatch`（行数不一致）/ `col-count-mismatch`（指定行の列数不一致）
- **方針**: 複数 field / 複数行のエラーは全て収集（early return しない）。ただし行数ミスマッチが出たその field は col-count 検証を打ち切る（ノイズ削減）
- **整形**: `formatHeightError(err)` で人間可読メッセージに整形。ログ出力・UI 表示共通で使う
- **呼び出し**: 現状は `RaycastRenderer.load()` のみ（warn ログとして利用）。Markdown 構文（#90）・MapEditor（#91）からも使う想定
- **対象外**: tiles 自体の次元検証（`mapTiles.length !== mapHeight` 等）は `validateMapHeights` の範疇外で、`RaycastRenderer.load()` 側に残す

#### `assets/textures/` 規約

- 現状は `__demo_tree` / `__demo_water` の組み込みデモテクスチャが `wallTextureSheet.ts` に手続き実装されているため、ゲームプロジェクト側は PNG を用意しなくても Raycast で壁がテクスチャで描画される
- 将来的にゲームプロジェクト側のテクスチャを使う場合は、プロジェクトリポジトリの `assets/textures/{name}.png` に配置し、`loadWallTexture(kind, renderer, externalPath)` にパスを渡す経路で読み込む想定（コード経路は別 Issue）。**現時点の実装は 64×64 固定**（`TEXTURE_WIDTH` / `TEXTURE_HEIGHT` 定数）。動的サイズ対応は別 Issue でやる
- タイル（TREE / WATER）にどのテクスチャを当てるかを Markdown 側から指定する構文（例: `[テクスチャ] ... [/テクスチャ]`）は **Issue #48 のスコープ外**。別 Issue で検討する

### 会話ダイアログ

- プレイヤーの前方 1 タイルに NPC がいる状態で Enter / Space
- 画面下部のウィンドウに NPC 名と `message` を即時表示（タイプライター演出なし）
- 再度 Enter / Space で閉じる。ダイアログ表示中は移動入力を無視
- 見た目・状態管理は `RpgDialogBox` クラス（`frontend/src/game/RpgDialogBox.ts`）に集約。TopDownRenderer / RaycastRenderer は `show(name, message, portrait?)` / `hide()` / `redraw(w, h)` / `isShowing` のみを呼ぶ
- **portrait 顔枠（Issue #73 Phase 1 + #104）**: NPC に `portrait=path.png` が指定されているとダイアログ左側に 80×80 の顔枠を表示し、テキスト開始 x を顔枠右側（140px）にシフトする。VN 風の固定 1 枚、**contain（アスペクト比保持で内接）でセンター配置**し余白は portraitFrame の半透明黒で埋まる。portrait 未指定時は従来どおり顔枠なし。画像ロードは `PIXI.Assets.load` + path 単位キャッシュ（`portraitCache`、成功時のみキャッシュ保持、失敗時は delete して再試行を許す）。ロード失敗時は黒枠プレースホルダのみ表示。`Assets.load` の戻り値は `instanceof Texture` で型 guard。パス解決は vite の `public/` 起点（= `/` 起点）で、サンプル画像として `frontend/public/elder_portrait.png`（80×80 単色 PNG）を同梱。連続 show 時のちらつき抑制（同一 path 維持 + 失敗時のみ visible を落とす）・レイアウト定数集約（`PORTRAIT_SIZE` / `PORTRAIT_MARGIN` / `PORTRAIT_X` / `DIALOG_HEIGHT` 等 export）済み。動的表情切替と NPCEditor UI での portrait 入力フィールドは Phase 2 (#101) スコープ

### サンプルデータ

`frontend/src/game/sampleRpgData.ts` に 16×12 のサンプルマップと NPC 2 人を用意。`RPGPlayer` コンポーネントは `gameData` prop が未指定ならこれを使用し、データ永続化（#34）より前でも RPG がそのまま動作する。

## RPG データフロー

RPG マップ・プレイヤー初期位置・NPC は Event として .md ファイルに統合される（別ファイルではない）。ノベル要素と同じシーンに混在可能。

```
.md ファイル
  ↓ parser(parse)
EventDocument（chapters[].scenes[].events[] に RpgMap/PlayerStart/Npc を含む）
  ↓ rpgProjectFromDoc(doc)    ← 最初にマップを含むシーンを探す
RPGProject（frontend/src/types/rpg.ts）
  ↓
MapEditor / NPCEditor / RPGPlayer
```

編集時の書き戻し:

```
MapEditor/NPCEditor の変更
  ↓ applyRpgProjectToDoc(doc, project)    ← 対象シーンの RPG 要素を置換（ノベル要素は保持）
新しい EventDocument
  ↓ parser(emit)
.md（自動保存 → ワーキングディレクトリに PUT → エディタ上で「保存」ボタンで Git commit）
```

ヘルパー関数は `frontend/src/game/rpgProjectFromDoc.ts` に実装。

- `rpgProjectFromDoc(doc, sceneId?)` — doc → RPGProject（マップが無ければ null）
- `applyRpgProjectToDoc(doc, project, sceneId)` — RPGProject → doc（既存シーンの RPG 要素を置換、無ければ新シーン追加）

## シアターモード構想（カメラ基盤・背景板/大道具/キャラの depth 配置・幕・照明まで実装済み）

舞台/漫才向けの制約付き制作ゲーム「絶対もっといいセリフあったよな」のための、カメラ・舞台演出の設計。既存の `dialog_style`（`adv`/`novel`, #283）・`split_layout`（Gymnasia向け, #442）と同じく、既存の2択を置き換えずに**独立した per-game 設定軸を積み重ねる**方針に倣う。おぐらじあの計画中のコミック風表示も同じ並びの軸になる想定（4つ目）。シアター/舞台は5つ目としてこの並びに合流する。

**実装状況 (#681/#682/#683/#692/#693/#694/#695/#696/#697/#699)**: `Event::CameraMode { mode: Novel|Theater, orientation: Option<Audience|Stage>, elevation: Option<LookUp|LookDown> }`（parser）・`NovelGameState.cameraMode`/`cameraOrientation`/`cameraElevation`（GameState 側 settled state、save/seek/任意局面起動で復元可能）・`computeCameraProjection(mode, orientation, elevation, depth)`（`frontend/src/game/cameraProjection.ts`、純粋関数、novel は identity・theater は depth に応じた縮小スケールと、仰角（後述）に応じた `verticalOffset` を返す）まで実装済み。#683 でこの関数が初めて実際の描画に配線された: `Event::BackgroundBoard { path, depth }`（parser、`[背景板: path, depth: N]`）・`NovelGameState.backgroundBoards`（settled state、save/seek/任意局面起動で復元可能）・`BackgroundBoardLayer`（`frontend/src/game/BackgroundBoardLayer.ts`、`computeCameraProjection` の scale/verticalOffset を `novelLayout.computeBoardPlacement` で実座標に変換し、`novelLayout.computeBoardSlideInOffset` で追加時の「上から降りてくる」演出を行う）まで実装済み（下記「舞台構造」節）。#692 で大道具にも同じ depth 配置が実装された: `Event::Prop { path, depth }`（parser、`[大道具: path, depth: N]`）・`NovelGameState.props`・`PropLayer`（`frontend/src/game/PropLayer.ts`、`BackgroundBoardLayer` を複製した独立レイヤー）。#694 でキャラにも depth 配置が実装された: 話者タグ・登場ディレクティブのオプションに `depth: N` を追加（`Event::Dialog.depth` / `Event::Enter.depth`、`Option<f32>`。省略は 0.0＝最前面）、`CharacterLayer` が `computeCameraProjection` の scale/verticalOffset を既存の character_height_ratio/character_scale/fit 由来の基本スケール・足元Y座標へ乗算・加算で合成する（下記「レイヤーモデル」節）。同 Issue で話者タグの横位置指定も自由化: 既存の `左`/`中央`/`右` 等の文字列トークンに加え、0〜1 の数値（例 `0.15`）を直接 x 比率として書けるようになった（`novelLayout.resolveCharacterXRatio`）。#695 で `PropLayer` は `CharacterLayer` の直後、`EventImageLayer` の前に配置され、大道具をキャラより手前・イベント絵/UIより奥に描画する。#696 でシアターモードの台詞ボイスは既存の `position`/`depth` から左右パン・距離減衰・ローパスを得る。#693 で照明が2要素に分けて実装された（下記「照明」節）: (1) 既存 `Event::Flash`（一過性の全画面フラッシュ、#143）を `area`（エリア限定矩形）・`strobe`/`interval`（断続ストロボ）に拡張、(2) 新規の永続ライティング要素として `Event::Spotlight { target, color, radius }` / `Event::SpotlightOff`・`NovelGameState.spotlight`（settled state）・`LightingLayer`（`frontend/src/game/LightingLayer.ts`）を追加。スポットライトは対象キャラの現在座標（`CharacterLayer.getCurrentPosition()`）に毎フレーム追従する。#699 で紙人形風の輪郭が実装された（下記「紙人形風の輪郭」節）: `Event::PaperDollOutline { enabled, color, thickness }` / `[紙人形輪郭: オン|オフ]`・`NovelGameState.paperDollOutline`（settled state、cameraMode と異なり場面転換で自動クリアしない）・`CharacterLayer`/`PropLayer` 共通の `outlineFilter.ts`（`pixi-filters` の `OutlineFilter`）。#697 で幕が実装された（下記「幕」節）: `Event::Curtain { path, characters_in_front }` / `Event::CurtainUp`・`NovelGameState.curtain`（単一スロットの settled state）・`CurtainLayer`（`frontend/src/game/CurtainLayer.ts`、depth 配置・カメラ射影は持たない全画面カバーフィット画像）。`characters_in_front` に応じて `stage.setChildIndex()` 相当（`removeChild` + `addChildAt`）で z-order を切り替え、キャラより手前（通常の閉幕）/奥（カーテンコール）を選べる。**未実装**のまま残るのは向き（客席/舞台）反転時の座標系のみ。

実装方針: せおはやみで確立した「話者ターンごとの立ち絵差し替え」機構（`CharacterLayer` / 話者タグ）の延長として作る。台本フォーマット・話者切り替えロジックは共通のまま、表示層（描画・射影・モーション）だけを差し替える。台本や `resolveEvents` の構造を新設計にしない。

### カメラモード（ノベル / シアター）

ノベルゲームと演劇/漫才は別モードではなく、**カメラの違いだけ**として扱う。

- **ノベルモード**（既存・従来通り）: カメラ正面。奥行きによる縮小なし
- **シアターモード**（新規）: カメラ斜め（客席視点）。遠近法あり。舞台を見ている絵になる

共通（モードで変わらないもの）: 台本フォーマット、タイムライン再生・クリック送り、エディタUI・操作、キャラの配置指定（x, y, depth）、大道具・小道具・幕、BGM/SE/立ち絵/背景。

変わるもの: 描画の射影変換（正投影 vs 透視投影）と、シアターモード時のみ有効なカメラ仰角（後述）。ノベルモードは常に水平・正面固定。

台本の1行で切り替え可能:

```markdown
[カメラ: シアター]
```

演出としても使える（例: 作中劇オチでモードをシアターに切り替え、客席が見える）。

### 舞台構造（実装済み・#683/#692）

背景は1枚ではなく、本物の舞台のように**複数枚の板が異なる奥行きに吊られている**:

```markdown
[背景板: 空.png, depth: 10]    # 最奥
[背景板: 山.png, depth: 7]     # 中景
[背景板: 木.png, depth: 4]     # 前景
```

- 既存の単一スロット背景（`[背景:]`/`Event::Background`）とは完全に独立した加算的な仕組み。1シーン内に複数書けば、それぞれ別の板として `BackgroundBoardLayer` に蓄積される（構文の詳細は `docs/spec/markdown-v0.1.md`「背景板（舞台構造）」節を参照）
- 板の追加時は「上から降りてくる」tween アニメーションで登場する（`novelLayout.computeBoardSlideInOffset`、既定 600ms）。場面転換自体に専用の退場演出は無く、`[場面転換]` で既存の単一スロット背景と同じタイミングで即座にクリアされる
- ノベルモードでは `computeCameraProjection` が常に `scale=1` を返すため、全部原寸で正面に重なるだけになる（従来の背景切り替えと同じ見た目、自動的に後方互換）
- シアターモードでは depth に応じて `scale` が縮小し、遠近法で奥行き差が見える（depth が大きいほど画面中心を基準に小さく表示される）
- **大道具 (#692/#695)** も同じ仕組みで実装済み: `[大道具: path, depth: N]`（`Event::Prop`）・`NovelGameState.props`・`PropLayer`（`BackgroundBoardLayer` を複製した独立レイヤー）。ただし数値 depth の空間は背景板・キャラと共有せず、レイヤー自体が背景板・キャラより手前、イベント絵/UIより奥に固定される（下記「レイヤーモデル」節、`docs/spec/markdown-v0.1.md`「大道具（舞台構造）」節参照）

### カメラの向き・仰角

向き（客席/舞台の前後）と仰角（上下）は独立した2軸:

- **向き**: 客席→舞台（デフォルト、通常の観客視点）/ 舞台→客席（逆転、演者の背中越しに客席が見える構図。客席用の背景絵が別途要る）
- **仰角**（新規）: 水平（デフォルト）/ 見上げ（斜め下から見上げるアングル。力強さ・迫力）/ 見下ろし（斜め上から見下ろすアングル。俯瞰・儚さ）

```markdown
[カメラ: シアター, 向き: 客席, 仰角: 見上げ]
```

背景板・大道具・キャラの depth 配置はそのまま使い、カメラの投影パラメータだけが変わる。

### レイヤーモデル

```
奥 ← 背景板（depth複数）← キャラ ← スポットライト ← 大道具 ← 幕（既定） ← 手前
                    └─ 幕（手前にキャラ指定時）
                           └─ 表情（差分）
                           └─ 服（差分）
                           └─ 小道具（差分）
```

- **幕は z 位置を2つ持つ（実装済み・#697）**: `Event::Curtain { path, characters_in_front }` / `[幕: path]` / `[幕: path, 手前にキャラ]` / `Event::CurtainUp` / `[幕: 上げる]`。既定（`characters_in_front: false`）は `PropLayer` の直後（最前面、`EventImageLayer` の手前）で舞台全体を覆う通常の閉幕。`characters_in_front: true`（カーテンコール）は `BackgroundBoardLayer` の直後・`CharacterLayer` の手前で、キャラ・スポットライト・大道具が幕より手前に見える。`CurtainLayer`（`frontend/src/game/CurtainLayer.ts`）は大道具・背景板と異なり depth 配置・カメラ射影を持たない単一スロットの全画面カバーフィット画像で、`NovelRenderer` が `stage.setChildIndex()` 相当（`removeChild` + `addChildAt`）で2つの位置を動的に切り替える（このコードベースで唯一の動的 z-order 差し替え）。詳細は下記「幕」節参照
- キャラが持つ小道具（マイク、扇子、剣など）は**キャラの差分レイヤー**。表情や服と同じ扱いで、depth はキャラと同一（シアターモードでもキャラから浮かない）
- **追うスポットライトは光源として独立したレイヤーに固定される（実装済み・#693）**: `Event::Spotlight { target, color, radius }` / `[スポットライト: 対象=名前, color=..., radius=...]`。`LightingLayer`（`frontend/src/game/LightingLayer.ts`）が stage 上で `CharacterLayer` の直後・`PropLayer` の前に配置される。大道具・背景板と違い数値 depth の空間は持たない（レイヤー自体の描画順が「キャラより手前・大道具より奥」を固定する）。詳細は下記「照明」節参照
- **大道具（机、椅子など）は独立した depth を持つ（実装済み・#692/#695）**: `Event::Prop { path, depth }` / `[大道具: path, depth: N]`。背景板・キャラとは別の独立した PixiJS レイヤー（`PropLayer`）として、stage 上で `LightingLayer`（#693）の直後、`EventImageLayer` の前に配置される（`CharacterLayer` の直後は `LightingLayer` が挟まる、上記レイヤー順図参照）。数値 depth は大道具どうしの奥行き順にのみ使われ、背景板・キャラの depth 値と直接比較されることはない（レイヤーのグループ順序自体が「背景板・キャラより手前、イベント絵/UIより奥」を固定する）。**現状は背景板と同じ cover-fit（画面全体を覆う、常に画面中央・アスペクト比維持で拡大）配置で、個別オブジェクトとしてのx/y位置指定には未対応**（大道具1枚＝机や椅子を含む全画面サイズの透過PNGを用意する必要がある。`PropLayer` が `BackgroundBoardLayer` と同じ `computeBoardPlacement`——`computeCameraProjection` の scale/verticalOffset を実座標に変換する関数——を再利用しているため）。個別配置は将来のスコープ。詳細は上記「舞台構造」節参照
- **キャラ自身の depth 配置も実装済み（#694）**: 話者タグ・登場ディレクティブのオプションに `depth: N` を追加（`Event::Dialog.depth` / `Event::Enter.depth`、`Option<f32>`。パース失敗・省略は 0.0＝最前面）。`CharacterLayer` は独自の x/y/scale 計算体系を持つため、大道具/背景板のような専用の配置関数（`computeBoardPlacement`）は使わず、`computeCameraProjection` が返す scale/verticalOffset を、character_height_ratio(s)/character_scale/フィット（#294/#360/#364/#378）で決まる基本スケール・足元Y座標（`characterY`）に直接**乗算・加算**で合成する。ノベルモード（既定）では `computeCameraProjection` が常に `scale=1, verticalOffset=0` を返すため見た目は無変化（後方互換）。カメラ状態が変わったとき（`[カメラ:]`）は `CharacterLayer.setCamera()` が表示中の全キャラを新しい scale/verticalOffset で再配置する（`BackgroundBoardLayer`/`PropLayer` の同名メソッドと同じ役割）。同 Issue で話者タグの横位置指定も自由化した: 既存の `左`/`中央`/`右`/`上手`/`下手` 等の文字列トークンに加え、0〜1 の数値（例 `**トモ** (笑顔, 0.15)`）を直接 x 比率として書ける（`novelLayout.resolveCharacterXRatio`、未知の文字列は従来通り中央にフォールバック）

```markdown
**ボケ** (ツッコミ顔, 上手, 小道具: マイク.png):
なんでやねん！
```

depth 指定の実例（#694）:

```markdown
**ボケ** (ツッコミ顔, 上手, depth: 3):
なんでやねん！
```

**音響の空間表現（実装済み・#696）**: シアターモードで `[ボイス:]` を付けたダイアログは、#694 の既存 `position` と `depth` をそのまま音響にも使う。`position` を `StereoPannerNode` の左右パンへ、`depth` を距離減衰（基準 depth 10 で音量 1/2）と `BiquadFilterNode` のローパスへ写像する。写像は `voiceSpatialization.resolveVoiceSpatialization` に集約し、ノベルモードでは `null` を返して従来のボイス接続を保つ。ナレーションには話者位置がなく、BGM/SE も舞台上の発話者に紐付かないため、いずれも空間化しない。`AudioManager` は該当行だけ `source → lowpass → stereo pan → distance gain → SE master` の使い捨てノード列を作り、終了・停止時に切断する。

```markdown
[登場: せお (theo/akarame, 左, depth: 2)]
```

### 入場・退場の方向モーション（実装済み・#684）

既存の `[登場: 名前 (sprite/表情, 位置)]`（#401）/ `[退場: 名前]` タグに、任意で方向引数を追加する。引数なしは従来通り（瞬間表示/フェード、後方互換）。引数ありのときだけ、舞台上を歩いて入る/去るモーションになる:

**実装状況 (#684)**: `Event::Enter.enter_direction` / `Event::Exit.exit_direction`（`Option<StageDirection>`、`Kamite`/`Shimote`）をパーサ・エミッタで往復対応済み。所要時間の per-game 設定 `character_move_ms`（frontmatter、未指定は runtime 既定 1400ms）も実装済み。X 座標の tween 計算は `computeStageMotionOffset`（`frontend/src/game/novelLayout.ts`、純粋関数）に集約し、`CharacterLayer` が `stageMotion`（ticker 駆動、fadeAnimation とは独立の軸）として駆動する。ノベルモードでは `NovelRenderer.cameraMode` を見て方向引数を無視しフェードにフォールバックする（呼び出し側で判定、CharacterLayer 自体はカメラモードを知らない）。GameState には一切状態を追加しない（ADR 0002、演出の中間状態を持たない — セーブ/シーク/任意局面起動では常に最終確定位置で即時表示）。

```markdown
[登場: トモ, 上手から]
[退場: トモ, 下手へ]
```

- 方向は上手/下手（位置指定と同じ語彙を流用。話者タグの `位置` トークンは既に `上手`/`下手` を受理している）
- モーション時間は `character_fade_ms` と同系統の per-game 設定で調整できるようにする想定（実装時に検討）
- ノベルモードでは方向引数を無視し、従来のフェード挙動にフォールバックする

### 照明（フラッシュ拡張 / スポットライト）(#693)

舞台演出としての照明を2要素に分けて実装した。

**1. エリア限定フラッシュ・ストロボ**: 既存 `Event::Flash`（一過性の全画面フラッシュ、#143、`docs/spec/markdown-v0.1.md`「画面効果」節参照）を拡張する。

```markdown
[フラッシュ: color=#ffffff, alpha=0.8, duration=300, area=0.2,0.3,0.3,0.4, strobe=3, interval=150]
```

- `area=x,y,w,h`（0〜1のratio、画面全体を基準にした矩形。省略時は全画面のまま後方互換）でオーバーレイの描画範囲を限定する。パーサー内部の parse は `content.split(',')` による単純な kv 分解では複数値の `area` を壊すため、`parse_flash_directive`（`parser/src/parser.rs`）はトークン列を index 走査し `area=` の後続 bare トークンを4つまで追加消費する専用ロジックを持つ。
- `strobe=N`（回数、省略時1回のまま後方互換）+ `interval=ms`（省略時は `duration` と同じ値にフォールバック）でフラッシュを断続的に繰り返す。
- fire-and-forget を維持する（`NovelGameState` には入れない。既存の Shake/Flash/Fade と同じ扱い）。
- alpha 補間は `computeStrobeFlashAlpha`（`frontend/src/game/screenEffects.ts`、純粋関数）に集約。`strobeCount<=1` のときは既存の `computeFlashAlpha` と完全に同じ結果になる（後方互換）。描画範囲の px 変換は `computeFlashAreaRect`（同ファイル）。

**2. 追うスポットライト**: 新規の永続ライティング要素として `NovelGameState.spotlight`（settled state、save/seek/任意局面起動で復元可能）に持たせる。

```markdown
[スポットライト: 対象=キャラ名, color=#ffffff, radius=0.2]
[スポットライト消灯]
```

- パーサー内部では `Event::Spotlight { target: Option<String>, color, radius }` / `Event::SpotlightOff`（unit variant）で表現される。`target` 省略時は画面中央に固定表示する（キャラに追従しない、実装時に決めた既定挙動）。
- `LightingLayer`（`frontend/src/game/LightingLayer.ts`、上記レイヤーモデル節参照）が対象キャラの**現在の**表示位置を毎フレーム追従する。座標は新設の `CharacterLayer.getCurrentPosition(name)` が返す——`show()`/`Enter` で表示中の立ち絵はもちろん、`Underline`/`Animate`/`TextEffect` と同じく render-only（Title/Label/Image）の identifier も区別なく対象にできる。返す座標はアンカー `(0.5, 1)`（足元）から、スプライト高さの半分だけ上（体の中心付近）に補正した点。生成時点の座標を固定で保持しないため、入場退場モーション（#684）や将来の立ち位置変更でも追従できる。
- 描画は Canvas 2D で1枚だけ生成した「白の中心から外周へ透明にフェードする」正方形テクスチャを `Sprite`（`blendMode: 'add'`、`tint` で色付け、`width`/`height` で直径を伸縮）として使い回す（`ambientEffects.buildDisplacementNoiseCanvas` と同じパターン）。PixiJS v8 の `FillGradient`（radial）+ `Graphics.fill()` も検討したが、fill 時に即座に `CanvasRenderingContext2D.createRadialGradient` を呼ぶため、jsdom（`canvas` npm パッケージ未導入、`getContext('2d')` が `null`）のテスト環境で例外を投げることが判明し不採用にした。`buildSpotlightGradientCanvas` は `getContext('2d')` が `null` のとき例外を投げず `null` を返す（描画だけ諦める、state 管理は継続）。
- カメラモード非依存（`CameraMode::Novel`/`Theater` どちらでも機能する）。
- 新しいシーンの開始・`[場面転換]`・`endStory()` で自動的に消灯する（`isBlackout`/`cameraMode` と同じ規律。シーンをまたいで暗黙に持ち越さない）。

### 紙人形風の輪郭（実装済み・#699）

「手書きのペラペラ2Dキャラ、手押し相撲のような質感」（下記「活用例」参照）を強めるため、立ち絵・大道具のシルエット輪郭に沿って白枠/黒枠を自動生成し、紙人形（切り絵）風に見せる。

```markdown
[紙人形輪郭: オン]
[紙人形輪郭: オン, color=#000000, width=3]
[紙人形輪郭: オフ]
```

- パーサー内部では `Event::PaperDollOutline { enabled: bool, color: Option<String>, thickness: Option<f32> }` で表現される。`color`（既定 `#ffffff`）・`width`（既定 `2`）は `オン` のときだけ任意指定できる（`オフ` のときは無視され、emitter は素の `[紙人形輪郭: オフ]` に正規化する）
- **スコープはキャラクター個別ではなくシナリオ（.md）全体**。一度オンにすると、そのシナリオ内で以降表示される**全てのキャラクター・大道具**に常時輪郭が付く（話者ごとの指定ではない）。別の .md では輪郭なし（通常表示）のままでよい
- `NovelGameState.paperDollOutline`（settled state、`cameraMode` と同じく save/seek/任意局面起動で復元可能）に持たせるが、`cameraMode`/`spotlight` と異なり**場面転換（同シナリオ内のシーン間ジャンプ）・`endStory()` では自動クリアしない**。新しいエントリ文書の開始（`setEvents()`）・新規開始（`startFrom({})`）のときだけ通常表示にリセットされる（`NovelRenderer.resetAndStartEvents` の non-preserve 経路）
- 対象は `CharacterLayer`（立ち絵）・`PropLayer`（大道具）の両方。共通の輪郭フィルタ生成ロジックは `frontend/src/game/outlineFilter.ts`（`pixi-filters` の `OutlineFilter` をラップ）に切り出し、両レイヤーがそれぞれ `setPaperDollOutline(config)` メソッドで自分のスプライトへ反映する
- `CharacterLayer` は `[画像:]` のピクセレート遷移（#628）用 `PixelateFilter` と `sprite.filters` を共有するため、`applySpriteFilters()` に代入箇所を集約し両フィルタが共存できるようにしている。`PropLayer` のスプライトには他にフィルタ運用が無いため直代入でよい
- ノベルモード・シアターモード両方で機能する（カメラモードと独立した要素）

### 幕（実装済み・#697）

演劇/漫才の幕の昇降演出。指定画像でスライドダウン演出しながら幕を降ろし、幕より手前にキャラを立てる配置（カーテンコール等）にも対応する。

```markdown
[幕: caution.png]
[幕: caution.png, 手前にキャラ]
[幕: 上げる]
```

- 第一引数が画像への相対パス。第一引数が `上げる` のときだけ幕を上げる（`Event::CurtainUp`、`Spotlight`/`SpotlightOff` と同じ「オン系は設定値を持つ、オフ系は専用の空イベント」パターン）
- `手前にキャラ`（カーテンコール用）: 幕は降りているが、キャラクター・スポットライト・大道具より**奥**（キャラより手前に立てる配置）になる。省略時は舞台全体を覆う通常の閉幕として最前面に配置される
- `NovelGameState.curtain`（単一スロットの settled state、save/seek/任意局面起動で復元可能）に保持する。`BackgroundBoard`/`Prop` と同じく `[場面転換]`（`Event::SceneTransition`）でクリアされ、専用のクリアディレクティブは無い。それらと異なり単一スロット（幕は1枚のみ、加算的な蓄積はしない）
- 昇降アニメーションは背景板の「上から降りてくる」演出（`novelLayout.computeBoardSlideInOffset`、#683）と同じ設計パターン。降ろす＝上から降りてくる（`computeBoardSlideInOffset`、easeOut）をそのまま流用し、上げる＝上へ消えていく（`novelLayout.computeCurtainRiseOffset`、easeIn。昇降の見た目に差を付けるため異なるイージングを使う）。復元（goBack/seekTo/セーブ復元/任意局面起動）は演出の中間状態を持たない（ADR-0002）ため、アニメーションを起こさず即座に最終位置へ配置する
- `CurtainLayer`（`frontend/src/game/CurtainLayer.ts`）は `BackgroundBoardLayer`/`PropLayer` と異なり depth 配置・カメラ射影を持たない全画面カバーフィット画像（`novelLayout.computeCoverFit`、単一スロット背景と同じ配置方式）。`characters_in_front` に応じた z-order の切り替え（`propLayer` の直後 or `backgroundBoardLayer` の直後）は `NovelRenderer.setCurtainZOrder()` が `stage.setChildIndex()` 相当（`removeChild` + `addChildAt`）で行う（詳細は上記「レイヤーモデル」節参照）
- パーサー内部では `Event::Curtain { path: String, characters_in_front: bool }` / `Event::CurtainUp`（unit variant）で表現される。TUI版（`tui/`）はこれらのイベントを解釈しない（無視される。`Spotlight`/`BackgroundBoard`/`Prop` と同じ理由）

### 活用例

- 漫才: ボケとツッコミが舞台上で掛け合い。シアターモードで客席視点
- 落語: 座布団、扇子、手ぬぐい、着物、座り姿勢で一人芝居を作る
- 演劇: 大道具の奥行き配置、幕のアニメーション、役者のはけ
- 手書きのペラペラ2Dキャラ、手押し相撲のような質感。小道具や衣装は手描き画像でいい

### 実体は独立アプリではない

「絶対もっといいセリフあったよな」は独自データを持つ別アプリにしない。裏側では NameName の通常プロジェクト（`.md` + assets）が作られているだけで、ゲームらしいスキン（お題・制約・講評・達成状況）でそれを見せる。保存先はユーザー自身の GitHub リポジトリ（現時点では未作成）。設計の全文は notes リポジトリ `dev/name-name.md` を参照。

## ツールとゲームデータの分離

- **Name×Name ツール**: このリポジトリ（name-name）
- **ゲームプロジェクト**: 別リポジトリ（例: ogurasia, friday-1930, skirts-colour, gymnasia）
- 永続化は GitHub の各ゲームリポをそのまま使う（D1/R2 を介さない、ADR `0001-hosting-architecture.md` 参照）
- 本番: Worker が GitHub Contents API 経由で読み書き
- dev: `npm run dev -- --local` でローカル作業ツリーを直読みできる（`worker/scripts/local-fs-proxy.mjs`）

## 下流プロジェクトのスモークテスト

name-name の parser / emitter を壊すと下流ゲームが一斉に動かなくなるため、代表プロジェクトの最小 Markdown を `parser/tests/fixtures/` に fixture として取り込み、構造を検証するスモークテストを置く。

| fixture                         | テスト                     | 対象下流                                               | カバー                                                                                                             |
| ------------------------------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `fixtures/friday1930-sample.md` | `friday1930_smoke_test.rs` | [friday-1930](https://github.com/kako-jun/friday-1930) | ノベル（ダイアログ/ナレーション/背景/BGM/暗転/SE/退場/場面転換）+ RPG（RpgMap/PlayerStart/Npc/view=raycast）の混在 |

**運用ルール:**

- 下流の `script.md` を更新したら、対応する fixture も手動で同期する（ファイルコピー）
- fixture はあくまで「代表的な構造例」。バイト一致を要求する必要はなく、view / RpgMap / NPC の抽出が期待通りかを assert する
- スモークテストで扱うのは **ハッピーパスの構造検証のみ**。parser の異常系（空ファイル、不正値、ミスマッチ等）は `integration_test.rs` で担保する
- 下流ごとに fixture とテストを1セット追加していく（ogurasia 等、将来の通常 RPG 下流も同じ方式で展開する想定）

## 型チェック

`frontend/tsconfig.json` は references 構成（`files: []`）。
ルート直下に `tsc --noEmit` を走らせてもノーチェックになるため、`npm run type-check` は `tsc -b --noEmit` を使う。
CI でも同じコマンドで app + node 両方の tsconfig が検証される。
