/**
 * ゲームの状態を管理するクラス
 *
 * フラグストアを保持し、章またぎで引き継がれる。
 * NovelRenderer.setEvents() でリセットされない。
 */

import { Event, FlagValue } from '../types'
import { safeAssign } from './ownProperty'

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
 * テキストより背面・背景/立ち絵より前面に出る、画面ぴったりの単一スロット画像。
 * `back` が `'Hide'`（既定）のとき、下の背景・立ち絵は非表示になる（NovelRenderer.applyState /
 * processDirective が state.eventImage の有無・back 値を見て毎回宣言的に可視性をトグルする）。
 * `'Keep'` は背景・立ち絵を裏で維持する（物証アップ/一時ズーム用途）。
 *
 * フェード時間（表示フェードイン/退場フェードアウト）は持たない。それは一度きりの transition
 * パラメータであって settled state ではないため（ADR-0002: スナップショットは常に
 * settled 状態のみを持つ。VideoState の playhead のような「継続的な値」とは性質が違う）。
 */
export interface EventImageState {
  /** 画像への相対パス（`assetBaseUrl + '/images/' + path` で URL 化） */
  path: string
  /** 背面（背景・立ち絵）扱い。'Hide' = 隠す（既定）/ 'Keep' = 裏で維持する */
  back: 'Hide' | 'Keep'
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
  isBlackout: boolean
  characters: Array<{ name: string; expression: string; position: string }>
  currentBgmPath: string | null
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
 * startFrom() の引数 (#220 Phase 2)。
 *
 * sceneId と flags を直接指定して任意の状態からシーンを開始する。
 * デバッグ/テスト用。これは開始指示であってゲーム状態そのものではないため、
 * NovelGameState とは別に定義する。
 */
export interface StartFromOptions {
  /** 開始するシーン ID */
  sceneId: string
  /** 設定するフラグ（置換セマンティクス。省略時は空でクリア） */
  flags?: Record<string, FlagValue>
  /** 開始イベントインデックス（省略時 = 0） */
  eventIndex?: number
  /** 開始テキストインデックス（省略時 = 0） */
  textIndex?: number
  /** novel の現ページ内文インデックス（省略時 = 0・#292）。adv では未使用。 */
  sentenceIndex?: number
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
