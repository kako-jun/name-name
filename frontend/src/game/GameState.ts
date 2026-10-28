/**
 * ゲームの状態を管理するクラス
 *
 * フラグストアを保持し、章またぎで引き継がれる。
 * NovelRenderer.setEvents() でリセットされない。
 */

import {
  AmbientEffects,
  CameraElevation,
  CameraZoom,
  CameraMode,
  CameraOrientation,
  Event,
  FlagValue,
} from '../types'
import { safeAssign } from './ownProperty'
import type { PaperDollOutlineConfig } from './outlineFilter'

/**
 * 背景画像の端フェードマスク設定 (#250)。
 *
 * 各端から内側へのフェード帯の幅をスクリーン座標系の px で指定する。
 * 帯の最外端（画面端）で透明、内側境界で不透明（線形）。
 * 0 / undefined はその端のフェードなし。
 */
export interface BackgroundFade {
  top?: number
  bottom?: number
  left?: number
  right?: number
}

/**
 * 動画入力レイヤの表示状態 (#252)。
 *
 * 背景と同じ単一スロット意味論（同時に 1 枚）。スナップショット / セーブ復元で取り回す。
 * playhead は復元時の seek 目標（秒）。ベストエフォート（録画/シーク精度はブラウザ依存）。
 */
export interface VideoState {
  path: string
  /** 配置位置（left/center/right に正規化済み）。未指定は center */
  position?: string
  /** 拡大率。未指定は cover-fit 相当 */
  scale?: number
  /** ループ再生するか */
  loop?: boolean
  /** 音声ミュートするか（false/未指定はミックス再生） */
  mute?: boolean
  /** 端フェードマスク (#250 と同義) */
  fade?: BackgroundFade | null
  /** 復元用の再生位置（秒）。ベストエフォートで seek する */
  playhead?: number
}

/**
 * イベント絵レイヤーの表示状態 (#351)。
 *
 * テキストより背面・全背面レイヤー（背景・背景板・動画・立ち絵・大道具）より前面に出る、
 * 画面ぴったりの単一スロット画像。
 * `back` が `'Hide'`（既定）のとき、全背面レイヤーは非表示になる（NovelRenderer.applyState /
 * directives/stageDirectives.ts の `EventImage` ハンドラが state.eventImage の有無・back 値を見て毎回宣言的に可視性をトグルする）。
 * `'Keep'` は全背面レイヤーを裏で維持する（物証アップ/一時ズーム用途）。
 *
 * フェード時間（表示フェードイン/退場フェードアウト）は持たない。それは一度きりの transition
 * パラメータであって settled state ではないため（ADR-0002: スナップショットは常に
 * settled 状態のみを持つ。VideoState の playhead のような「継続的な値」とは性質が違う）。
 */
export interface EventImageState {
  /** 画像への相対パス（`assetBaseUrl + '/images/' + path` で URL 化） */
  path: string
  /** 全背面レイヤーの扱い。'Hide' = 隠す（既定）/ 'Keep' = 裏で維持する */
  back: 'Hide' | 'Keep'
  /**
   * アンビエント演出フラグ (#582)。`back` と同じく settled state（`[イベント絵:]` の作者指定を
   * そのまま保持する宣言的な値。アニメーション位相自体は含まない・ADR-0002）。
   * `undefined` = 全フラグ false（無演出）。既存のセーブ/スナップショット比較（`toEqual`）を
   * 壊さないよう、`EventImageLayer.getState()` は全フラグ false のときこのキー自体を省略する
   * （vitest `toEqual` は undefined プロパティを無視するため、旧フォーマットの `{path, back}` と
   * 引き続き等価になる）。
   */
  effects?: AmbientEffects
}

/**
 * 追うスポットライトの settled state (#693)。`[スポットライト: 対象=名前, color=..., radius=...]` /
 * `[スポットライト消灯]` で更新する。`Event::Flash`（一過性の fire-and-forget 演出）とは異なり
 * 永続ライティング要素なので `NovelGameState` に持たせ、save/seek/任意局面起動で復元する。
 *
 * `target` が `null` のときは画面中央に固定表示する（キャラに追従しない、対象未指定の既定挙動）。
 * `LightingLayer` が毎フレーム `target` の現在座標を `CharacterLayer.getCurrentPosition()` で
 * 問い合わせて追従する（アニメーション位相自体はここに持たせない、ADR-0002）。
 */
export interface SpotlightState {
  target: string | null
  color: string
  radius: number
}

/**
 * 幕の settled state (#697)。`[幕: path]` / `[幕: path, 手前にキャラ]` / `[幕: 上げる]` で
 * 更新する。`backgroundBoards`/`props` と異なり単一スロット（幕は1枚のみ、加算的な蓄積は
 * しない）。`null` = 幕なし（既定、`[幕: 上げる]` 後もこの値になる）。
 *
 * `charactersInFront` はカーテンコール用の配置フラグ。`true` のとき幕はキャラクター・
 * スポットライト・大道具より奥（キャラより手前に立てる配置）、既定 `false` は舞台全体を
 * 覆う通常の閉幕（最前面）。`CurtainLayer` が `NovelRenderer` の `stage.setChildIndex()` で
 * 2つの z 位置を切り替える。
 */
export interface CurtainState {
  path: string
  charactersInFront: boolean
}

/**
 * ノベルゲームの全状態を表すスナップショット
 *
 * advance/goBack/seekTo/save/load の際にこのインターフェースで状態を取り回す。
 */
export interface NovelGameState {
  sceneId: string | null
  eventIndex: number
  textIndex: number
  /**
   * novel スタイル (#292) で「現ページ内の表示済み最後の文 index」（0-based・息継ぎ送り）。
   * adv では未使用（常に 0）。これは「どの文まで送ったか」という**進行位置＝ゲーム状態**であり、
   * タイプ途中という演出中間状態ではない（ADR 0002 / 規律3 に適合）。
   * textIndex（ページ index）の下位に位置する。古いセーブには無い → 復元時は ?? 0。
   */
  sentenceIndex: number
  flags: Record<string, FlagValue>
  backgroundPath: string | null
  /** 単色の地色 (#273)。背景画像と同じ永続状態。なしなら null（既定の黒） */
  backgroundColor: string | null
  /** 背景の端フェードマスク (#250)。なしなら null */
  backgroundFade: BackgroundFade | null
  /**
   * 背景の明るさ（brightness）。同一画像をシーン毎に減光する持続プロパティ。
   * 0.0〜1.0（1.0=原画のまま、0.6=60%）。null/未指定は原画のまま（tint=白）。
   * 背景フェードと同じく snapshot / applyState / セーブ復元で復元する。
   */
  backgroundBrightness: number | null
  /** 動画入力レイヤ (#252)。なしなら null */
  video: VideoState | null
  /** イベント絵レイヤー (#351)。なしなら null */
  eventImage: EventImageState | null
  /**
   * シアターモード舞台構造の背景板 (#683)。`[背景板: path, depth: N]` の加算的な蓄積状態
   * （既存の単一スロット `backgroundPath` とは独立）。既定は空配列。演出の中間状態
   * （降りてくるアニメーションの進行度）は持たない（ADR-0002。#684 の stageMotion と同じ扱い、
   * `BackgroundBoardLayer` だけが一時的なアニメーション位相を保持する）。
   */
  backgroundBoards: Array<{ path: string; depth: number }>
  /**
   * シアターモード舞台構造の大道具 (#692)。`[大道具: path, depth: N]` の加算的な蓄積状態
   * （`backgroundBoards` と同じ扱い）。背景板・キャラとは独立した PixiJS レイヤーで、キャラより
   * 手前に固定される（docs/architecture.md「レイヤーモデル」節）。既定は空配列。
   * 演出の中間状態は持たない（ADR-0002。`PropLayer` だけが一時的なアニメーション位相を保持する）。
   */
  props: Array<{ path: string; depth: number }>
  /**
   * 追うスポットライト (#693)。`null` = 消灯（既定）。settled state（演出の中間状態は持たない、
   * ADR-0002）。`SpotlightState` 参照。
   */
  spotlight: SpotlightState | null
  /**
   * 幕 (#697)。`null` = 幕なし（既定）。単一スロットの settled state（save/seek/任意局面起動で
   * 復元可能）。`Prop`/`BackgroundBoard` と同じく `[場面転換]` でクリアされる（`CurtainState` 参照）。
   */
  curtain: CurtainState | null
  isBlackout: boolean
  characters: Array<{ name: string; expression: string; position: string; depth: number }>
  currentBgmPath: string | null
  /**
   * カメラモード (#681)。'Novel'（既定・正投影・従来通り）/ 'Theater'（透視投影）。
   * `[カメラ: シアター]` / `[カメラ: ノベル]` イベント処理で更新する、isBlackout と同種の
   * 宣言的な settled state（演出の中間状態ではない）。新しいシーン開始時は 'Novel' に戻る
   * （isBlackout と同じくシーンをまたいで暗黙に持ち越さない、明示指定必須の設計）。
   */
  cameraMode: CameraMode
  /**
   * シアターモードのカメラの向き (#681)。'Audience'（既定・客席視点）/ 'Stage'（逆転）。
   * `cameraMode` が 'Novel' のときは意味を持たない（無視される）。
   */
  cameraOrientation: CameraOrientation
  /**
   * シアターモードのカメラ仰角 (#682)。null（既定・水平）/ 'LookUp'（見上げ）/ 'LookDown'（見下ろし）。
   * `cameraOrientation` と同じく `cameraMode` が 'Novel' のときは意味を持たない（無視される）。
   * 新しいシーン開始時は null（水平）に戻る（cameraOrientation と同じ規律）。
   */
  cameraElevation: CameraElevation | null
  /**
   * シアターモードのカメラズーム (#702)。null（既定・全景）/ `{ target, strength }`（対象キャラへ寄る）。
   * `cameraElevation` と同じく `cameraMode` が 'Novel' のときは意味を持たない。settled state のみ保持し、
   * 寄り・戻りの補間途中のポーズは保存しない（復元は最終状態へ即時スナップ、ADR-0002）。
   * 新しいシーン開始時は null（全景）に戻る。
   */
  cameraZoom: CameraZoom | null
  /**
   * 紙人形風の輪郭 (#699)。`[紙人形輪郭: オン]` / `[紙人形輪郭: オフ]` で更新する。
   * `cameraMode` と同じく宣言的な settled state（save/seek/任意局面起動で復元可能）だが、
   * スコープはシーン単位ではなく**シナリオ（entryRawEvents）全体**: 一度オンにすると、
   * そのシナリオ内で以降表示される全てのキャラクター（`CharacterLayer`）・大道具
   * （`PropLayer`）に輪郭が付く。`cameraMode`/`spotlight` と異なり、場面転換（シーン間
   * ジャンプ）や `endStory()` では自動クリアしない——別の .md（`setEvents()` でのエントリ
   * 文書差し替え）や新規開始（`startFrom({})`）では `NovelRenderer.resetAndStartEvents` の non-preserve
   * 経路がリセットする。`null` = 通常表示（既定）。
   */
  paperDollOutline: PaperDollOutlineConfig | null
  /**
   * 終劇状態 (#386)。`?scene=` ディープリンク単独埋め込みの confinement（在圏）外へ
   * choice でジャンプしようとしたときに true になる、宣言的なフラグ。
   * 演出の中間状態ではない（ADR 0002 / 規律3）: フェード演出自体はこのフラグの発火に
   * 付随する一度きりの見た目でしかなく、GameState としては「背景も立ち絵もない
   * 終劇後」という終端状態を指す。goBack/seekTo/セーブ復元（applyState）はすべて
   * このフラグをそのまま宣言的に反映する（フェードのやり直しはしない）。
   * 通常のハブ経由フロー（confinement 無効）では常に false。
   */
  storyEnded: boolean

  /**
   * このシーン訪問に入った瞬間の flags（入場時 flags, #799）。`[条件:]` は入場時に1回だけ展開して訪問中は
   * 固定するので、展開後の列 = `expandEvents(raw, { flags: entryFlags, ... })` で再現でき、`eventIndex` は
   * その列の添字になる（ADR 0002 の「展開は純関数」を、位置までに実行した `[フラグ:]` を含めて保つ）。
   * `getSnapshot` は元列に `[条件:]` を含むときだけ出力する（含まなければ展開が flags に依存しない）。
   * 後方互換: 古いセーブ/スナップショットには無い → 復元時は保存位置までを `flags` で静的に展開し、
   * 位置から後ろは `flags` から逐次評価する（`entryFromState`）。
   */
  entryFlags?: Record<string, FlagValue>
  /**
   * 古いセーブから復元した訪問だけが持つ、再開位置 (#799)。保存時の `eventIndex`（展開後の列の添字）。
   * 展開後の列がこの長さに達するまでは `entryFlags` で `[条件:]` を静的に評価し（`[フラグ:]` は適用しない）、
   * 達した後は `[フラグ:]` を適用しながら1イベントずつ逐次に評価する。無いときは `entryRawIndex` の規則だけ。
   */
  entryResumeIndex?: number
  /** 線形ストリームの途中のシーンから始めた訪問の、元列での開始位置 (#799)。0 のときは出力しない。 */
  entryRawIndex?: number
}

/**
 * デバッグ用リプレイの 1 操作 (#220 Phase 1)。
 *
 * シーン再生中のユーザー操作を宣言的に表す。NovelRenderer.playScript() に
 * 配列で渡すと、各 Step を順に適用して任意の状態を再現できる。
 * これは演出の再生指示であってゲーム状態ではないため、NovelGameState には含めない。
 */
export type Step =
  /** クリック相当。次のテキスト / 次のイベントへ進む */
  | { type: 'advance' }
  /** 選択肢を選ぶ。Choice 表示をスキップして直接 jump 先のシーンへ遷移する */
  | { type: 'choice'; jump: string }
  /** 非同期イベント待機（将来用）。ms ミリ秒だけ待つ */
  | { type: 'wait'; ms: number }

/**
 * startFrom() の引数 (#220 Phase 2, #734)。
 *
 * 新規開始（文脈を捨てて始める）の指示。これは開始指示であってゲーム状態そのものではないため、
 * NovelGameState とは別に定義する。
 */
export interface StartFromOptions {
  /** 開始するシーン ID。省略するとエントリ文書の線形ストリームの先頭から始める */
  sceneId?: string
  /** 設定するフラグ（置換セマンティクス。省略時は空でクリア） */
  flags?: Record<string, FlagValue>
  /** 開始イベントインデックス（省略時 = 0） */
  eventIndex?: number
  /** 開始テキストインデックス（省略時 = 0） */
  textIndex?: number
  /** novel の現ページ内文インデックス（省略時 = 0・#292）。adv では未使用。 */
  sentenceIndex?: number
  /**
   * 入場属性としての confinement（在圏）一覧 (#386)。解決できた時点で置き換える。
   * 省略・null は解除（制限なし）。`?scene=` の埋め込みが渡す。
   */
  confinedSceneIds?: string[] | null
  /**
   * 線形ストリームを流す新規開始 (#777, #817)。`sceneId` がエントリ文書の線形ストリーム上のシーンのとき、
   * そのシーン先頭からストリーム全体を流し、シーン末尾で終わらず後続のシーンまで再生する（動画書き出しの
   * 範囲指定が選ぶ）。省略・false は指定シーンの events だけを流して末尾で終劇する（`?scene=` /
   * `?debug_scene=` の従来挙動）。`sceneId` が無い・線形ストリーム上に無いときは効かない。
   */
  linear?: boolean
}

/**
 * 保存された状態から、展開の入場条件を求める (#799)。`raw` は復元先の元イベント列。
 *
 * `entryFlags` が無い（古いセーブ・手書きの状態）は、保存位置（`eventIndex`）に達するまでを保存時の `flags` で
 * 静的に展開し（旧実装の展開と添字が一致する）、位置から後ろは `flags` から1イベントずつ逐次評価する
 * （旧実装は `[フラグ:]` の実行ごとに再展開していたので、位置より後ろの条件も評価し直されていた）。
 * 位置を囲む `[条件:]` ブロックには入った状態から続き、その内側の位置より後ろの `[フラグ:]` も後続の
 * `[条件:]` に反映される。再開位置は `resumeIndex` として入場条件に載り、再保存でも同じ列に戻る。
 * 位置が展開後の列の範囲外のときは全体を静的に展開する。
 * 旧実装との差は、ブロックに入る時点の評価を再展開でなく到達時に1回行う点だけ（ADR 0003）。
 */
export function entryFromState(state: NovelGameState, raw: readonly Event[]): ExpansionEntry {
  if (state.entryFlags !== undefined) {
    return {
      flags: state.entryFlags,
      ...(state.entryResumeIndex !== undefined ? { resumeIndex: state.entryResumeIndex } : {}),
      fromRawIndex: state.entryRawIndex ?? 0,
    }
  }
  const all = raw.length
  const base = expandEvents(raw, { flags: state.flags, fromRawIndex: all })
  if (state.eventIndex < 0 || state.eventIndex >= base.events.length) {
    return { flags: state.flags, fromRawIndex: all }
  }
  return { flags: state.flags, resumeIndex: state.eventIndex, fromRawIndex: 0 }
}

/**
 * Condition イベントをフラグに基づいて展開し、フラットなイベント配列を返す。
 *
 * - Condition が真 → 内部 events を再帰的に展開して挿入（Condition 自体は除去）
 * - Condition が偽 → スキップ
 * - Flag / その他のイベントはそのまま残す
 *
 * 元の events 配列は変更しない（不変）。
 */
export function resolveEvents(events: readonly Event[], gameState: GameState): Event[] {
  const result: Event[] = []
  for (const event of events) {
    if (typeof event === 'object' && event !== null && 'Condition' in event) {
      if (gameState.checkFlag(event.Condition.flag)) {
        // 条件が真 → 内部 events を再帰的に展開
        result.push(...resolveEvents(event.Condition.events, gameState))
      }
      // 偽ならスキップ
    } else {
      result.push(event)
    }
  }
  return result
}

/**
 * 入場時 flags で `[条件:]` を展開する際の入場条件 (#799)。
 *
 * - `flags`: シーン訪問に入った瞬間の flags（入場時 flags）。
 * - `fromRawIndex`: 元列のトップレベルでこの位置より前は静的に展開し、この位置以降を逐次評価する
 *   （線形ストリームの途中のシーンから始めるときだけ非0）。
 */
export interface ExpansionEntry {
  flags: Record<string, FlagValue>
  /**
   * 再開位置（展開後の列の添字）。古いセーブの復元だけが使う (#799): 展開後の列がこの長さに達するまでは
   * `[条件:]` を `flags` で静的に評価して `[フラグ:]` は走査に適用せず、達した後は `[フラグ:]` を適用しながら
   * 逐次評価する（位置を囲むブロックには入った状態から続く）。省略時は `fromRawIndex` の規則だけ。
   */
  resumeIndex?: number
  fromRawIndex: number
}

/** `expandEvents` の結果。 */
export interface Expansion {
  /** 展開後の平坦なイベント列（`Flag` は残す）。 */
  events: Event[]
  /** `rawOffsets[i]` = 元列のトップレベル i 番目を処理する直前の展開後の長さ（長さは `raw.length + 1`）。 */
  rawOffsets: number[]
}

function gameStateFromFlags(flags: Record<string, FlagValue>): GameState {
  const gs = new GameState()
  gs.fromJSON(flags)
  return gs
}

/**
 * 元イベント列を入場条件から展開する (#799)。シーン訪問の入口で1回だけ呼び、その訪問中は結果を固定する。
 *
 * 逐次評価（TUI の `build_scene_items` と同じ手順）: 元列を先頭から1イベントずつ走査し、走査用の flags の
 * 複製に `Flag` を適用しながら、`Condition` に達した時点の複製で真偽を判定して真なら内側を再帰する。
 * `Flag` イベント自体は展開後の列に残す（実フラグを書くのは再生時の `processDirective` のまま）。
 * ブロックに入った後で、ブロック内でそのフラグを変えても、入場済みのブロックの残りは流れる。
 * 偽のブロックは内側の `Flag` も実行しない。
 *
 * `fromRawIndex` より前のトップレベルは `entry.flags` で静的に展開する（`resolveEvents` と同じ）。
 * 結果は `(raw, entry)` だけで決まる（フラグの履歴・乱数・時刻に依存しない）。
 */
export function expandEvents(raw: readonly Event[], entry: ExpansionEntry): Expansion {
  const events: Event[] = []
  const rawOffsets: number[] = []
  const staticState = gameStateFromFlags(entry.flags)
  const scan = gameStateFromFlags(entry.flags)
  const resume = entry.resumeIndex

  // topStatic: トップレベル要素ごとの静的展開（`fromRawIndex` より前）。再開位置に達するまでも静的に評価する。
  const walk = (list: readonly Event[], topStatic: boolean): void => {
    for (const event of list) {
      const isStatic = topStatic || (resume !== undefined && events.length < resume)
      if (typeof event === 'object' && event !== null && 'Condition' in event) {
        if ((isStatic ? staticState : scan).checkFlag(event.Condition.flag)) {
          walk(event.Condition.events, topStatic)
        }
      } else {
        if (!isStatic && typeof event === 'object' && event !== null && 'Flag' in event) {
          scan.setFlag(event.Flag.name, event.Flag.value)
        }
        events.push(event)
      }
    }
  }

  for (let i = 0; i < raw.length; i++) {
    rawOffsets.push(events.length)
    walk([raw[i]], i < entry.fromRawIndex)
  }
  rawOffsets.push(events.length)
  return { events, rawOffsets }
}

/** 元イベント列に `[条件:]` を含むか。展開結果が入場時 flags に依存するかの判定に使う (#799)。 */
export function hasCondition(raw: readonly Event[]): boolean {
  return raw.some((e) => typeof e === 'object' && e !== null && 'Condition' in e)
}

export class GameState {
  private flags: Map<string, FlagValue> = new Map()

  /**
   * フラグを設定する
   */
  setFlag(name: string, value: FlagValue): void {
    this.flags.set(name, value)
  }

  /**
   * フラグの値を取得する（未設定なら undefined）
   */
  getFlag(name: string): FlagValue | undefined {
    return this.flags.get(name)
  }

  /**
   * フラグが「真」かどうかを判定する
   *
   * - Bool(true) → true
   * - Bool(false) → false
   * - それ以外の型（String, Number）→ 存在すれば true
   * - 未設定 → false
   */
  checkFlag(name: string): boolean {
    const value = this.flags.get(name)
    if (value === undefined) return false

    if ('Bool' in value) {
      return value.Bool
    }

    // String / Number は存在すれば true
    return true
  }

  /**
   * 全フラグをクリアする
   */
  clear(): void {
    this.flags.clear()
  }

  /**
   * フラグを Record として返す（シリアライズ用）
   */
  toJSON(): Record<string, FlagValue> {
    const obj: Record<string, FlagValue> = {}
    this.flags.forEach((value, key) => {
      // #370: フラグ名が "__proto__" でも own-property として書く（prototype pollution 回避）
      safeAssign(obj, key, value)
    })
    return obj
  }

  /**
   * Record からフラグを復元する（デシリアライズ用）
   */
  fromJSON(data: Record<string, FlagValue>): void {
    this.flags.clear()
    for (const [key, value] of Object.entries(data)) {
      this.flags.set(key, value)
    }
  }
}
