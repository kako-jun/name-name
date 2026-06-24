export interface Viewport {
  x: number // パン位置 X
  y: number // パン位置 Y
  zoom: number // ズームレベル (0.1 ~ 5.0)
}

export type Mode = 'edit' | 'play'

// --- name-name Event model (synced with parser/src/models.rs) ---

export type BgmAction = 'Play' | 'Stop'
export type BlackoutAction = 'On' | 'Off'

export interface ChoiceOption {
  text: string
  jump: string
}

export type FlagValue = { Bool: boolean } | { String: string } | { Number: number }

export type Direction = 'Up' | 'Down' | 'Left' | 'Right'

export interface RpgMapData {
  width: number
  height: number
  tile_size: number
  tiles: number[][]
  /** タイル座標 [y][x] ごとの壁高さ。未指定なら null（Issue #90） */
  wall_heights?: number[][] | null
  /** タイル座標 [y][x] ごとの床高さ。未指定なら null（Issue #90） */
  floor_heights?: number[][] | null
  /** タイル座標 [y][x] ごとの天井高さ。未指定なら null（Issue #90） */
  ceiling_heights?: number[][] | null
  /** 確率エンカウントの分母（DQ4 式、`Math.random() < 1/N`）。0 = 街・室内 (#172) */
  encounter_rate?: number | null
  /** エンカウント抽選の敵グループ候補。各要素は monster_id か `+` 連結 (#172) */
  encounter_groups?: string[] | null
}

/**
 * NPC データ（parser / WASM 経由のスキーマ）。
 *
 * UI / runtime 側は `frontend/src/types/rpg.ts` の `UiNpcData` に変換される。
 * 主な差分は `message` の表現（parser は行配列、UI は 1 文字列）と portrait など。
 * フィールドを追加するときは parser 側 (`NpcData`) と UI 側 (`UiNpcData`) と
 * 変換層 (`rpgProjectFromDoc` / `applyRpgProjectToDoc`) の 3 箇所を必ず揃える (#103)。
 */
export interface NpcData {
  id: string
  name: string
  x: number
  y: number
  color: number
  message: string[]
  /** スプライトシートへの相対パス。未指定なら色付き四角で描画される */
  sprite?: string
  /** 歩行アニメのフレーム数（方向あたり）。未指定ならレンダラーのデフォルト（2） */
  frames?: number
  /** NPC が向いている方向。未指定ならレンダラーのデフォルト（Down） */
  direction?: Direction
  /**
   * 会話ダイアログに表示する顔画像（portrait）への相対パス。
   * Issue #73 Phase 1 で追加。未指定なら DialogBox に顔枠は出ず従来どおりの表示。
   * 動的表情切替は Phase 2 (#101) で別途対応。
   */
  portrait?: string
  /**
   * 表情差分マップ（#101 Phase 2）。
   * キーは表情名、値は portrait 画像パス。
   * WASM 側は `Map<string, string>` だが JSON ラウンドトリップで `Record` として扱う。
   */
  expressions?: Record<string, string>
  /** 「はなす」時に再生するイベント名 (#187)。指定時は message の代わりにこのイベントを再生する。 */
  scene?: string
}

/** モンスター定義 (#174)。`[モンスター <id>] ... [/モンスター]` ブロックでパースされる */
export interface MonsterDef {
  id: string
  name: string
  /** 体力。未指定時のデフォルトは 1（即死扱いを避けるための最低値、#174 設計判断） */
  hp: number
  /** マナ。`#[serde(default)]` 由来で optional（未指定 = 0 扱い、parser/pkg の d.ts と整合） */
  mp?: number
  atk: number
  def: number
  agi: number
  exp: number
  gold: number
  sprite?: string
  /** 専用関数 ID。指定時はランタイム実装に委譲（汎用 + 専用 builtin の二層設計、#176） */
  builtin?: string
}

/** アイテム定義 (#174) */
export interface ItemDef {
  id: string
  name: string
  /** 種別（"回復" / "攻撃" / "武器" / "盾" / "鎧" / "兜" / "鍵" / "その他" 等） */
  kind: string
  price?: number
  /** 宣言的効果 DSL（"heal 30" 等）。`builtin` と排他 */
  effect?: string
  builtin?: string
}

/** パーティメンバー定義 (#175) */
export interface PartyMemberDef {
  id: string
  name: string
  sprite?: string
  /** 初期レベル（既定 1） */
  level?: number
  hp: number
  /** マナ。`#[serde(default)]` 由来で optional（未指定 = 0 扱い） */
  mp?: number
  atk: number
  def: number
  agi: number
  /** レベルアップで習得する呪文。Phase 1 ではデータとして保持するだけ */
  learns?: PartyLearns[]
}

/** パーティメンバーの呪文習得スロット (#175) */
export interface PartyLearns {
  level: number
  spell: string
}

/** 呪文定義 (#174) */
export interface SpellDef {
  id: string
  name: string
  mp: number
  /** 対象（"味方単体" / "敵単体" / "味方全体" / "敵全体" / "自分" / "マップ" 等） */
  target: string
  effect?: string
  builtin?: string
  /** 系統（"fire" / "ice" / "holy" / "breath" 等、耐性計算用） */
  school?: string
}

export interface PlayerStartData {
  x: number
  y: number
  direction: Direction
}

export type Event =
  | {
      Dialog: {
        character: string | null
        expression: string | null
        position: string | null
        text: string[]
        /** per-line voice ファイルパス (#144) */
        voice_path?: string | null
        /** per-line フォント上書き (#147)。CSS の font-family 文字列 */
        font_family?: string | null
        /**
         * 立ち絵の明示フィット指定 (#294)。話者行に `フィット` / `fit` を書くと true。
         * true のときだけ「論理画面より大きい立ち絵を画面内に収める」旧 fit-down を適用する。
         * 未指定 / false は原寸（scale=1）で表示する。サイズ・位置では自動分岐しない。
         */
        fit?: boolean
      }
    }
  | {
      Narration: {
        text: string[]
        voice_path?: string | null
        /** per-line フォント上書き (#147) */
        font_family?: string | null
      }
    }
  | {
      Background: {
        path: string
        /** #250 端フェードマスク（px）。各端から内側へのフェード帯幅。0/未指定はフェードなし */
        fade_top?: number | null
        fade_bottom?: number | null
        fade_left?: number | null
        fade_right?: number | null
        /**
         * 背景の明るさ（brightness）。同一画像をシーン毎に減光する持続プロパティ。
         * 0.0〜1.0（1.0=原画のまま＝既定、0.6=60%の明るさ＝暗め）。
         * レンダラー側で背景スプライトの tint = rgb(b*255, b*255, b*255) として乗算適用する。
         * null/未指定は原画のまま（tint=白）＝後方互換。
         */
        brightness?: number | null
      }
    }
  | {
      Video: {
        path: string
        /** #252 配置位置（左/中央/右、英語 alias left/center/right）。未指定は中央 */
        position?: string | null
        /** #252 拡大率。未指定は cover-fit 相当（画面いっぱい） */
        scale?: number | null
        /** #252 ループ再生するか。未指定/false は 1 回再生 */
        loop?: boolean | null
        /** #252 音声をミュートするか。未指定/false はミックス再生 */
        mute?: boolean | null
        /** #252 端フェードマスク（px）。#250 背景フェードと同義。0/未指定はフェードなし */
        fade_top?: number | null
        fade_bottom?: number | null
        fade_left?: number | null
        fade_right?: number | null
      }
    }
  | 'VideoExit'
  | {
      /** 単色の地色 (#273)。`[背景色: #f5f0e8]`。背景画像 (Background) と同じ永続状態として
       *  NovelGameState に持たせ、snapshot / applyState / セーブ復元で復元する。 */
      BackgroundColor: {
        color: string
      }
    }
  | {
      Bgm: {
        path: string | null
        action: BgmAction
        /** BGM フェード時間 ms (#145)。Play なら fade-in、Stop なら fade-out */
        fade_ms?: number | null
      }
    }
  | { Se: { path: string; /** SE fade-in 時間 ms (#145) */ fade_ms?: number | null } }
  | { Blackout: { action: BlackoutAction } }
  | 'SceneTransition'
  /**
   * 手動改頁マーカー (#292 Phase 2)。本文中の単独行 `---` から生成される unit variant
   *（serde では文字列 `"PageBreak"`）。`dialog_style: novel` の自動改頁（文がページに収まる
   * 範囲で貪欲に詰める #283/#292）の上に乗る、人間が明示的に入れる強制ページ境界。
   * runtime は非テキストイベントとして読み飛ばす（getTextEvent は null・processDirective は no-op）。
   * 各 text イベントは独立にページ分割されるため、`---` で割られたイベントの切れ目が
   * そのまま強制ページ境界になる。`---` を含まない脚本は従来挙動と完全に同じ（非回帰）。 */
  | 'PageBreak'
  | { Exit: { character: string } }
  | { Wait: { ms: number } }
  | { Choice: { options: ChoiceOption[] } }
  | { Flag: { name: string; value: FlagValue } }
  | { Condition: { flag: string; events: Event[] } }
  | { ExpressionChange: { character: string; expression: string } }
  | { RpgMap: RpgMapData }
  | { PlayerStart: PlayerStartData }
  | { Npc: NpcData }
  | { Monster: MonsterDef }
  | { Item: ItemDef }
  | { Spell: SpellDef }
  | { PartyMember: PartyMemberDef }
  | { RpgEvent: { name: string; commands: EventCommand[] } }
  | {
      RpgTrigger: {
        x?: number
        y?: number
        auto?: boolean
        scene: string
        once?: boolean
      }
    }
  | {
      Animate: {
        target: string
        dx?: string
        dy?: string
        rotation?: string
        scale?: number
        duration_ms: number
        easing?: Easing
      }
    }
  | {
      /** グリフ単位の文字アニメ (#268)。`[アニメ]` のグリフ単位版。
       *  プリセット (effect) → プリミティブ既定値の展開は textEffect.ts で行う。
       *  ここでは parser が持たせた生の値（未指定は undefined）をそのまま受け取る。 */
      TextEffect: {
        target: string
        effect?: TextEffectPreset
        stagger_ms?: number
        ms_per_char?: number
        dx?: string
        dy?: string
        rotation?: string
        scale?: number
        alpha?: number
        duration_ms?: number
        easing?: Easing
        /** `効果=タイプ` 専用: タイプ末尾の点滅カーソルを出すか (#271)。reveal 以外では無視。 */
        cursor?: boolean
        /** カーソル点滅周期 (ms)。半周期で表示/非表示。未指定は既定 600 (#271)。 */
        blink_ms?: number
        /** カーソル色 (CSS カラー文字列)。未指定は文字色を流用 (#271)。 */
        cursor_color?: string
      }
    }
  | {
      /** 下線ビーム (#270)。`[文字演出]` とは別系統の図形プリミティブ。
       *  対象テキストの実 measure 幅にフィットする横線を直下に置き scaleX 0→1 で左から伸ばす。
       *  プリセット既定値の展開は underline.ts / CharacterLayer で行う。 */
      Underline: {
        target: string
        color?: string
        thickness?: number
        duration_ms?: number
        offset?: number
        easing?: Easing
      }
    }
  | {
      /** 動画タイトル中央表示 (llll-ll-media 用)。`[タイトル: TEXT, 色=#1a4a7a]`。
       *  color (#273) はタイトル文字色。グリフ演出 (爆発)・カーソルにも波及する。
       *  未指定なら CharacterLayer 側で白 (TITLE_FILL) にフォールバック。 */
      TitleShow: {
        text: string
        font_family?: string
        position?: string
        color?: string
        /** 文字サイズ (px) (#275)。未指定は CharacterLayer 既定 64。グリフ演出のグリフも同 size。 */
        size?: number
        /** 横位置の比率 override (0..1) (#275)。指定時は position トークンより優先。範囲外は無視。 */
        x?: number
        /** 縦位置の比率 override (0..1) (#275)。 */
        y?: number
      }
    }
  | {
      /** 単独の色付きラベル (#274)。`[ラベル: text, 色=#7a9abf, 位置=中上, サイズ=16, id=division]`。
       *  立ち絵に紐付かない単独テキストを 2D 位置に出す。CharacterLayer に id（既定 "Label"）で
       *  登録され `[文字演出: id]` / `[下線: id]` / `[アニメ: target=id]` の対象になれる。
       *  render-only（NovelGameState.characters には漏らさない）。 */
      Label: {
        text: string
        color?: string
        position?: string
        size?: number
        id?: string
        font_family?: string
        /** テキスト揃え (#275)。`left`/`center`/`right`（正規化済み）。未指定は中央。
         *  左揃え時はグリフ演出（タイプ等）がラベル左端から右へ並ぶ（ED の install-line）。 */
        align?: string
        /** 隣接配置 (#275)。参照ラベル id の右端にこのラベルの左端を接続（同 y）。
         *  指定時このラベルは自動で左揃え。参照が無ければ通常配置にフォールバック。 */
        after?: string
        /** 横位置の比率 override (0..1) (#275)。指定時は position トークンより優先。 */
        x?: number
        /** 縦位置の比率 override (0..1) (#275)。 */
        y?: number
      }
    }
  | {
      /** 単独の画像 (#274)。`[画像: avatar.png, 位置=上, 円形, サイズ=160, id=avatar]`。
       *  立ち絵（show）に紐付かない単独画像を 2D 位置に出す。アセットパスは背景画像と同じく
       *  `assetBaseUrl + '/images/' + path`。shape="円形" で円形マスク。render-only。 */
      Image: {
        path: string
        position?: string
        shape?: string
        size?: number
        id?: string
        /** 横位置の比率 override (0..1) (#275)。指定時は position トークンより優先。 */
        x?: number
        /** 縦位置の比率 override (0..1) (#275)。 */
        y?: number
      }
    }
  | { DialogBorderless: { borderless: boolean } }
  | { Shake: { intensity_px: number; duration_ms: number } }
  | { Flash: { color: string; alpha: number; duration_ms: number } }
  | {
      Fade: {
        target: string
        color: string
        from_alpha: number
        to_alpha: number
        duration_ms: number
      }
    }

export type Easing = 'Linear' | 'EaseIn' | 'EaseOut' | 'EaseInOut' | 'EaseOutBack'

/** `[文字演出]` の名前付きプリセット (#268)。parser の TextEffectPreset と同期する。 */
export type TextEffectPreset = 'Explode' | 'Typewriter'

export type SceneView = 'TopDown' | 'Raycast'

export interface EventScene {
  id: string
  title: string
  view: SceneView
  events: Event[]
}

export interface EventChapter {
  number: number
  title: string
  hidden: boolean
  default_bgm: string | null
  scenes: EventScene[]
}

export interface EventDocument {
  engine: string
  /** 画面比率。省略時は "16:9" がデフォルト (Issue #136) */
  aspect_ratio?: string
  /** 選択肢スタイル名。`default` / `soft` / `monochrome` (#146)。
   *  null/undefined のときは runtime で `default` 扱い。 */
  choice_style?: string | null
  /** per-game デフォルトフォント (#147)。CSS の font-family 文字列。
   *  null/undefined のときは runtime 既定 (`'Noto Sans JP', sans-serif`) を使う。 */
  font_family?: string | null
  /** per-game デフォルトの本文フォントサイズ (px) (#283 補遺)。
   *  null/undefined のときは runtime 既定 40 を使う。frontmatter `font_size:` から流す。 */
  font_size?: number | null
  /** 会話の描画スタイル (#283)。`adv` / `novel` の対等 2 択。
   *  `adv` = 下部 ADV 箱（話者名札あり）、`novel` = 全画面ノベル（名札なし・スクリム・改頁）。
   *  null/undefined のときは runtime で `adv` 相当にフォールバックする（未指定時の挙動であって
   *  「正規デフォルト」ではない）。frontmatter `dialog_style:` から流す。 */
  dialog_style?: string | null
  /** 質問役（主人公）の話者名 (#286)。`dialog_style: novel` の左右配置に使う per-game 設定。
   *  話者がこの名前と一致したら質問役＝左、それ以外（住人）は回答役＝右に振る。
   *  null/undefined のときは従来配置（後方互換）。frontmatter `protagonist:` から流す。 */
  protagonist?: string | null
  /** 立ち絵の足元アンカー Y 比率 (#308)。`characterY = screenHeight * character_y_ratio`。
   *  内部定数 `CHARACTER_Y_RATIO`（runtime 既定 1.0）と 1:1 対応する per-game 設定。
   *  1.0 = 足が画面下端 / >1.0（例 1.05）= 足が下端より下＝靴が画面外に切れる（ToHeart 式）。
   *  null/undefined のときは runtime 既定 1.0（後方互換）。frontmatter `character_y_ratio:` から流す。
   *  dialog_style: novel/adv 非依存（両モードで同じ足元）。 */
  character_y_ratio?: number | null
  /** Skip(S) ボタンを再生 UI に出すか (#310)。true=出す（既定・後方互換）/ false=描画しない。
   *  skip-read-only ロジック（未読は解除）自体は不変。ボタンの有無だけを制御する。
   *  null/undefined のときは runtime 既定 true（出す）。frontmatter `skip_enabled:` から流す。 */
  skip_enabled?: boolean | null
  /** デバッグ HUD（D ボタン）を `/play`（PlayerScreen）に出すか (#310)。
   *  true=出す / null/undefined・false=出さない（本番非表示が既定）。
   *  `/edit`（EditorScreen）は frontmatter 非依存で常時出す（別経路）。
   *  frontmatter `debug_enabled:` から流す。 */
  debug_enabled?: boolean | null
  chapters: EventChapter[]
}

/** エディタでの編集位置を示す参照（章インデックス、シーンインデックス、イベントインデックス） */
export interface EventRef {
  chapterIdx: number
  sceneIdx: number
  eventIdx: number
}

export type EditableDialogField = 'character' | 'expression' | 'text'
export type EditableNarrationField = 'text'

/**
 * RPG イベントコマンド (#197)。parser の EventCommand と同期する。
 */
export type EventCommand =
  | { type: 'NpcMove'; npc: string; x: number; y: number; speed?: number; direction?: Direction }
  | { type: 'Wait'; ms: number }
  | { type: 'Dialog'; character?: string; text: string[] }
  | { type: 'Narration'; text: string[] }
