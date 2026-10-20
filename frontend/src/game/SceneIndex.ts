import type { Event, EventScene, FlagValue } from '../types'
import { expandEvents } from './GameState'
import { findSceneById } from './novelLayout'
import {
  findLinearSegments,
  resolveLinearSegments,
  type LinearSegment,
  type ResolvedSegment,
} from './sceneEntry'

/** シーンを引いた結果: 引けたか、引けなかった理由と警告用の文言。 */
export type SceneLookup =
  | { status: 'found'; scene: EventScene }
  | {
      status: 'failed'
      reason: 'not-found' | 'resolver-error' | 'out-of-range'
      detail: string
      error?: unknown
    }

/**
 * `SceneIndex.resolve` の結果。遅延ロードで取得できたシーン群（loaded）は、呼び出し側が世代の判定を
 * 通して `indexLoaded` を呼ぶまで索引に反映しない（破棄された入場は何も書き換えない）。
 */
export type SceneResolution = SceneLookup | { status: 'loaded'; scenes: EventScene[] }

export type MissingSceneResolver = (sceneId: string) => Promise<EventScene[] | null>

/**
 * シーンの索引・エントリ文書・遅延ロードの共有 Promise・線形区間のキャッシュ (#823, #735 2/8)。
 *
 * `NovelRenderer` にも再生状態にも依存しない。再生中の配列（`rawEvents`）は持たない:
 * 「エントリ文書本来の events」（`entryRawEvents`, #662）と「今どのルートを再生中か」（`rawEvents`）は
 * 別物なので、再生中かどうかが要る判定（`isEntryStreamActive` など）は、呼び出し側が現在の
 * `currentSceneId` / `rawEvents` を引数で渡す。`initialized` / 世代の判定も呼び出し側の責務。
 */
export class SceneIndex {
  /** 全シーン情報（シーンジャンプ用の解決索引）。 */
  private allScenes: EventScene[] = []
  private missingSceneResolver: MissingSceneResolver | null = null
  /**
   * 遅延ロード中の resolver 呼び出し (#733)。同じ sceneId の解決は 1 本に束ね、後続の呼び出しも同じ
   * Promise を待つ（Jump 経路は世代違いの再入でも自分の世代で後処理するため、黙って捨てると予約が
   * 宙に浮く）。settle 時に `requestMissingScene` が取り除く。
   */
  private pendingMissingScenes = new Map<string, Promise<EventScene[] | null>>()
  /**
   * エントリ文書本来の events のスナップショット (#662)。`setEntry()`（エントリ doc を供給する経路）
   * でのみ更新する。quickLoad()/restoreToScene() 経由の再生配列の上書きでは一切更新されない。
   * 新規開始の 'entry' は常にこれを参照するので、直前ルートに引きずられずエントリ冒頭から再生できる。
   */
  private entryRawEvents: Event[] = []
  /**
   * 新規開始（`startFrom({})`、target 'entry'）の `currentSceneId`。シーン文書は `scenes[0].id`、
   * 線形ストリームは null（sceneId を持たない）(#734)。
   */
  private entrySceneId: string | null = null
  /** `findLinearSegments` の結果。エントリの元イベント列と `allScenes` が変わったときだけ引き直す (#777)。 */
  private linearSegmentsCache: {
    entry: readonly Event[]
    scenes: readonly EventScene[]
    segments: LinearSegment[]
  } | null = null

  /** エントリ文書の events（読み取り専用の参照。新規開始・復元の対象）。 */
  getEntryEvents(): readonly Event[] {
    return this.entryRawEvents
  }

  getEntrySceneId(): string | null {
    return this.entrySceneId
  }

  /** 索引上のシーン群（`resolveSceneTitle` など、索引を引く純粋関数に渡す用）。 */
  getScenes(): readonly EventScene[] {
    return this.allScenes
  }

  /** `sceneId` のシーンが読み込み済みの索引にあれば返す（同期）。 */
  findScene(sceneId: string): EventScene | undefined {
    return findSceneById(this.allScenes, sceneId)
  }

  /**
   * エントリ文書を(再)供給する。events はコピーして保持する。`sceneId` は新規開始の `currentSceneId`
   * （シーン文書は `scenes[0].id`、線形ストリームは省略 = null）。文書と ID は常に一緒に入れ替える。
   */
  setEntry(events: readonly Event[], sceneId: string | null = null): void {
    this.entryRawEvents = [...events]
    this.entrySceneId = sceneId
  }

  /** シーンジャンプ解決専用の索引だけを設定する (#284)。エントリ文書には触れない。 */
  setJumpSceneIndex(scenes: EventScene[]): void {
    this.allScenes = scenes
  }

  setMissingSceneResolver(resolver: MissingSceneResolver | null): void {
    this.missingSceneResolver = resolver
  }

  /** 登録済みシーンIDの一覧（順序保持）(#228)。 */
  getAllSceneIds(): string[] {
    return this.allScenes.map((s) => s.id)
  }

  /**
   * missingSceneResolver を呼ぶ。同じ sceneId が解決中ならその Promise を共有する (#733)。
   * resolver の同期 throw も reject に畳む。呼び出しごとの後処理（世代・initialized 判定）は呼び出し側。
   */
  requestMissingScene(sceneId: string): Promise<EventScene[] | null> {
    const inflight = this.pendingMissingScenes.get(sceneId)
    if (inflight) return inflight
    const resolver = this.missingSceneResolver
    // resolver の Promise をそのまま共有する（余計な await 段を挟まず、従来と同じ解決タイミングを保つ）。
    // 取り除きは副チェーンで行い、共有 Promise の settle を遅らせない。
    let p: Promise<EventScene[] | null>
    try {
      p = resolver ? resolver(sceneId) : Promise.resolve(null)
    } catch (err) {
      p = Promise.reject(err)
    }
    const remove = (): void => {
      if (this.pendingMissingScenes.get(sceneId) === p) this.pendingMissingScenes.delete(sceneId)
    }
    p.then(remove, remove)
    this.pendingMissingScenes.set(sceneId, p)
    return p
  }

  /** 遷移先を引く手段が確実に無い（読み込み済みに無く、遅延ロードの resolver も無い）。 */
  isDefinitelyUnresolvable(sceneId: string): boolean {
    return !findSceneById(this.allScenes, sceneId) && !this.missingSceneResolver
  }

  /**
   * 遅延ロードの解決口 (#734)。シーンの引き当てはここ1か所で行う。索引にあれば**同期のまま**返す
   * （同期描画のタイミングを変えない。動画書き出しの preRoll と既存テストの前提, ADR 0003 §3）。
   * 無ければ `requestMissingScene`（同一 sceneId の解決は共有）を待つ。取れたシーン群はまだ索引に
   * 反映しない（世代の判定を通った後に呼び出し側が `indexLoaded` する）。
   */
  resolve(sceneId: string): SceneLookup | Promise<SceneResolution> {
    const scene = findSceneById(this.allScenes, sceneId)
    if (scene) return { status: 'found', scene }
    if (this.isDefinitelyUnresolvable(sceneId)) {
      return {
        status: 'failed',
        reason: 'not-found',
        detail: `シーンが見つからない: ${sceneId}`,
      }
    }
    return (async (): Promise<SceneResolution> => {
      try {
        const scenes = await this.requestMissingScene(sceneId)
        if (!scenes) {
          return {
            status: 'failed',
            reason: 'not-found',
            detail: `シーンが見つからない（resolver が null を返しました）: ${sceneId}`,
          }
        }
        return { status: 'loaded', scenes }
      } catch (error) {
        return {
          status: 'failed',
          reason: 'resolver-error',
          detail: `シーンの追加読み込みに失敗しました: ${sceneId}`,
          error,
        }
      }
    })()
  }

  /**
   * 遅延ロードで取れたシーン群を索引に反映して、目的のシーンを引き直す。
   * 世代の判定（破棄されないこと）を通った後にだけ呼ぶ（破棄された入場は何も書き換えない）。
   */
  indexLoaded(sceneId: string, scenes: EventScene[]): SceneLookup {
    this.setJumpSceneIndex(scenes)
    const scene = findSceneById(this.allScenes, sceneId)
    if (!scene) {
      return {
        status: 'failed',
        reason: 'not-found',
        detail: `lazy load 後もシーンが見つかりません: ${sceneId}`,
      }
    }
    return { status: 'found', scene }
  }

  getLinearSegments(): LinearSegment[] {
    const c = this.linearSegmentsCache
    if (c && c.entry === this.entryRawEvents && c.scenes === this.allScenes) return c.segments
    const segments = findLinearSegments(this.entryRawEvents, this.allScenes)
    this.linearSegmentsCache = { entry: this.entryRawEvents, scenes: this.allScenes, segments }
    return segments
  }

  /**
   * いま再生しているストリームがエントリの線形ストリームか (#777)。ストリームの持ち主がエントリで、
   * 元イベント列がエントリのものと一致するとき。選択肢・`[ジャンプ:]` で入ったシーンは、そのシーンの
   * events だけが流れるので false（線形連結は効かない）。再生中の値は呼び出し側が渡す。
   */
  isEntryStreamActive(currentSceneId: string | null, playingRawEvents: readonly Event[]): boolean {
    if (currentSceneId !== this.entrySceneId) return false
    const raw = playingRawEvents
    const entry = this.entryRawEvents
    if (raw.length !== entry.length || entry.length === 0) return false
    for (let i = 0; i < raw.length; i++) if (raw[i] !== entry[i]) return false
    return true
  }

  /**
   * 入場時に展開したエントリの線形ストリームのシーン区間。線形ストリームでなければ null。
   * `rawOffsets` は再生中の展開が持つ、元列のトップレベル i 番目の展開後の開始位置 (#799)。
   */
  resolveLinearSegmentsNow(
    currentSceneId: string | null,
    playingRawEvents: readonly Event[],
    rawOffsets: readonly number[]
  ): ResolvedSegment[] | null {
    if (!this.isEntryStreamActive(currentSceneId, playingRawEvents)) return null
    const segments = this.getLinearSegments()
    if (segments.length === 0) return null
    return resolveLinearSegments(segments, rawOffsets)
  }

  /**
   * 新規開始の対象 `sceneId` がエントリの線形ストリーム上にあれば、そのシーン先頭の元列での位置（`rawStart`）と
   * 展開後の位置（`startIndex`）を返す (#777, #799)。入場時 flags は新規開始で置き換えた後の値（`req.flags`）。
   * 先頭より前は静的に、先頭以降は逐次評価で展開する（再生側の `PlaybackCursor.load` と同じ展開）。
   * 線形ストリーム上になければ null。
   */
  linearStart(
    sceneId: string,
    flags: Record<string, FlagValue> | undefined
  ): { rawStart: number; startIndex: number } | null {
    const seg = this.getLinearSegments().find((s) => s.sceneId === sceneId)
    if (!seg) return null
    const { rawOffsets } = expandEvents(this.entryRawEvents, {
      flags: flags ?? {},
      fromRawIndex: seg.start,
    })
    return { rawStart: seg.start, startIndex: rawOffsets[seg.start] ?? 0 }
  }
}
