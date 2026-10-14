/**
 * シーン入場の種類・結果・持ち越し方針・遷移ゲートの純粋ロジック (#734, ADR 0003)。
 *
 * NovelRenderer は「いつ呼ぶか」「結果をどの表示オブジェクトに当てるか」だけを持ち、
 * 入場の種類ごとの方針（何を持ち越すか）と、遷移中に何を止めるかの判定はここに集約する
 * （doctrine 規律4.5: 状態は独立に持つが、状態の組み合わせの判定は1か所に置く）。
 * `this` / PixiJS / DOM / TimeController には一切依存しない。
 */
import type { NovelGameState } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'

/** シーン入場の種類。進行 = 物語の流れの中の遷移、新規開始 = 文脈を捨てて始める、復元 = 保存状態へ戻す。 */
export type EntryKind = 'progress' | 'fresh' | 'restore'

/** ロードの起点 (#765): 成功トーストの要否が変わる。quick=F8、menu=ロードメニュー、auto=マウント時の自動クイックロード。 */
export type LoadOrigin = 'quick' | 'menu' | 'auto'

/**
 * 進行の由来。選択肢の確定（`playScript` の choice ステップを含む）と `[ジャンプ:]`。
 * 失敗時の扱いだけが分かれる（選択肢は再表示、Jump は停止）。
 */
export type ProgressOrigin = 'choice' | 'jump'

/** 新規開始で途中局面から始めるときの位置（`?debug_scene=` の index 指定）。 */
export interface FreshPosition {
  eventIndex: number
  textIndex?: number
  sentenceIndex?: number
}

/**
 * 入場の要求。`enterScene` に渡す。
 */
export type SceneEntryRequest =
  | { kind: 'progress'; sceneId: string; origin: ProgressOrigin }
  // 新規開始: 文脈を捨てて始める。target 'entry' はエントリ文書の線形ストリームの先頭から。
  // flags は置換（省略時は空）、confinedSceneIds は解決できた時点で置き換える（省略時は解除）。
  | {
      kind: 'fresh'
      target: { sceneId: string } | 'entry'
      flags?: Record<string, FlagValue>
      position?: FreshPosition
      confinedSceneIds?: string[] | null
    }
  // source: 失敗時の警告文言と、復元元に応じた後処理（save は失敗トースト・自動進行の再開、
  // snapshot は storyEnded の重複発火防止 #460）を分けるため。
  // origin はセーブ由来のロード元だけが持つ（成功トーストの出し分け #765）。
  | { kind: 'restore'; state: NovelGameState; source: 'save'; origin: LoadOrigin }
  | { kind: 'restore'; state: NovelGameState; source: 'snapshot' }

/** 入場の結果。 */
export type SceneEntryResult =
  /** 入場できた。sceneId が null なのは、エントリの線形ストリーム（新規開始のエントリ、または sceneId null の復元）へ入ったとき。 */
  | { status: 'entered'; sceneId: string | null }
  /** 進行のみ: confinement の圏外で終劇した。 */
  | { status: 'ended' }
  /**
   * not-found: 遷移先が無い / resolver-error: 遅延ロードの通信失敗など（一時的）/
   * apply-error: 適用中の例外（実装・データの不具合。一時的な通信失敗とは区別する）/
   * out-of-range: 位置（eventIndex / textIndex）が解決したイベント列の範囲外 (#789)。文書が編集されて
   * セーブの位置が指す先が無くなった。不在（not-found）と同じく再試行しても直らないので区別して持つ
   */
  | { status: 'failed'; reason: 'not-found' | 'resolver-error' | 'apply-error' | 'out-of-range' }
  /** 待っている間に、より新しい入場要求が来た（後始末は新しい側が担う）。 */
  | { status: 'superseded' }

/**
 * 入場の種類ごとの持ち越し方針。`resetAndStartEvents` が受け取る個別フラグはここから導出する。
 * 新しく持ち越す状態を足すときは、この型に1項目足して `carryPolicyFor` の表を埋めるだけで済む。
 */
export interface CarryPolicy {
  /** 背景・背景板・大道具・幕・紙人形輪郭を持ち越す（立ち絵は遷移用の退場になる）。 */
  preserveBackgroundForTransition: boolean
  /** BGM を持ち越す (#724)。 */
  carryBgm: boolean
}

const CARRY_POLICY: Record<EntryKind, CarryPolicy> = {
  progress: { preserveBackgroundForTransition: true, carryBgm: true },
  fresh: { preserveBackgroundForTransition: false, carryBgm: false },
  // 復元は状態どおり（`restoreToScene` が宣言的に組み立てる）で `resetAndStartEvents` を通らない。
  // どちらも持ち越さない扱いにしておき、誤って経由してもライブ状態を引き継がないようにする。
  restore: { preserveBackgroundForTransition: false, carryBgm: false },
}

/** 入場の種類から、持ち越し方針を返す。 */
export function carryPolicyFor(kind: EntryKind): CarryPolicy {
  return { ...CARRY_POLICY[kind] }
}

/** ゲートの判定に使う状態。NovelRenderer の独立した状態フィールドをそのまま写す。 */
export interface TransitionGateState {
  waitingForChoice: boolean
  waitingForWait: boolean
  jumpState: 'idle' | 'pending' | 'stalled'
  /** 入場中（遅延ロードの往復を待っている間）か。 */
  hasPendingEntry: boolean
}

/**
 * ゲートを問う操作。
 * - advance: 進行（advance・オート送り・スキップ）。停止中の Jump も止める
 * - quickSave: クイックセーブ。停止中の Jump も止める
 * - saveMenu: セーブメニューを開く／確定する
 * - navigate: goBack・seekTo・クイックロード。停止中の Jump では使える
 * - autoAdvance: オート送り・スキップのタイマー。規則は navigate と同じだが、用途を分けて名前を持つ
 * - loadMenu: ロードメニューを開く／確定する
 * - confirmChoice: 選択肢の確定（選択肢が出ていること自体は前提）
 */
export type GatedOperation =
  | 'advance'
  | 'quickSave'
  | 'saveMenu'
  | 'navigate'
  | 'autoAdvance'
  | 'loadMenu'
  | 'confirmChoice'

interface GateRule {
  choice: boolean
  wait: boolean
  /** any: 予約中・停止中とも止める / pending: 予約中だけ止める */
  jump: 'any' | 'pending'
}

// 入場中（hasPendingEntry）はどの操作も止める。それ以外の列は操作ごとの既存の規則を保つ。
const GATE_RULES: Record<GatedOperation, GateRule> = {
  advance: { choice: true, wait: true, jump: 'any' },
  quickSave: { choice: true, wait: true, jump: 'any' },
  saveMenu: { choice: false, wait: false, jump: 'any' },
  navigate: { choice: true, wait: true, jump: 'pending' },
  autoAdvance: { choice: true, wait: true, jump: 'pending' },
  loadMenu: { choice: false, wait: false, jump: 'pending' },
  confirmChoice: { choice: false, wait: false, jump: 'pending' },
}

/**
 * ゲートが操作を止めている理由。entry/jump は「場面転換中」、choice/wait/stalled は「この場面では不可」。
 * stalled は停止中の Jump（遷移先が無く Jump の位置で止まっている）で、遷移は進行していないので転換中ではない。
 */
export type GateReason = 'entry' | 'jump' | 'stalled' | 'choice' | 'wait'

/**
 * 遷移中のゲート: この操作を今は受け付けてはいけない理由を返す（止めないなら null）。
 * `waitingForChoice`・`waitingForWait`・`jumpState`・入場中を合成する唯一の場所で、
 * 呼び出し側はこの関数（または `isTransitionGated`）だけを見る
 * （状態の組み合わせ判定を各所に散らさない）。
 */
export function gateReason(op: GatedOperation, s: TransitionGateState): GateReason | null {
  if (s.hasPendingEntry) return 'entry'
  const rule = GATE_RULES[op]
  if (s.jumpState === 'pending') return 'jump'
  if (rule.jump === 'any' && s.jumpState === 'stalled') return 'stalled'
  if (rule.choice && s.waitingForChoice) return 'choice'
  if (rule.wait && s.waitingForWait) return 'wait'
  return null
}

/** 遷移中のゲート: この操作を今は受け付けてはいけないか。 */
export function isTransitionGated(op: GatedOperation, s: TransitionGateState): boolean {
  return gateReason(op, s) !== null
}

/** 入場中ゲート。進行中の入場の Promise を誰でも待てるように持つ。 */
export interface PendingEntry {
  generation: number
  kind: EntryKind
  sceneId: string | null
  promise: Promise<SceneEntryResult>
}

/** 外から解決できる Promise。`[ジャンプ:]` の予約（発火前）の時点で待つ対象を作るために使う。 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * 新規開始の対象シーンが、最初のテキストまでに `[背景:]` を持たないか (#734, ADR 0003 §8)。
 * 新規開始は背景を持ち越さずクリアする（地色から始まる）ため、冒頭に `[背景:]` が無い原稿は
 * 背景が地色になる。DEV ビルドの警告に使う。最初のテキスト（Dialog / Narration）より前の
 * トップレベルのイベントだけを見る（条件分岐の中までは追わない: 見落としは警告が出ないだけ）。
 */
export function lacksLeadingBackground(events: readonly Event[]): boolean {
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    if ('Dialog' in event || 'Narration' in event) return true
    // 背景・地色・動画・イベント絵のどれかで始まるなら、地色のままにはならない（警告しない側）。
    if ('Background' in event || 'BackgroundColor' in event) return false
    if ('Video' in event || 'EventImage' in event) return false
    // 条件分岐の中に背景があるかもしれない場合は断定できないので、警告しない側に倒す。
    if ('Condition' in event) return false
  }
  // テキストが無い（何も表示しない）原稿は、背景が無くても困らない。
  return false
}

/** 復元位置の検証入力。 */
export interface RestorePosition {
  eventIndex: number
  textIndex: number
}

/**
 * 復元位置が、解決したイベント列（flags を当てて `[条件:]` を展開した後）の範囲内かを判定する (#789)。
 * 範囲内なら null、範囲外なら失敗の詳細文言を返す。適用の前に呼び、範囲外なら何も変えずに失敗にする
 * （クランプはしない。文書が編集された後のセーブは、黙って別の位置へ寄せずに復元失敗として知らせる）。
 *
 * - eventIndex: 整数で `0 <= eventIndex <= resolved.length`。終端（`eventIndex === resolved.length`）は
 *   storyEnded に関わらず有効で、このとき textIndex は 0 のみ。最後の本文の後ろに命令（`[BGM停止]`・
 *   `[暗転]` 等）だけが続くと、advance がそれらを消化して終端で止まる（終劇ではなくクリック待ちの空画面）
 *   ので、エンジン自身が書いたセーブ・スナップショットが終端を指しうる。展開後の長さが 0 のシーンも同じ
 * - textIndex: 整数で 0 以上。上限は `textIndexBound` が返すイベントごとの排他的上限で判定する。
 *   null はレイアウト依存（ノベルの改頁数は表示幅で変わる）で、ここでは上限を見ない
 *   （fluid 再マウントで改頁数が変わる復元は `applyState` が最終ページへ寄せる設計のため）
 */
export function findRestorePositionError(
  resolved: readonly Event[],
  pos: RestorePosition,
  textIndexBound: (event: Event) => number | null
): string | null {
  const { eventIndex, textIndex } = pos
  if (!Number.isInteger(eventIndex) || eventIndex < 0) {
    return `eventIndex が不正です: ${eventIndex}`
  }
  const atEnd = eventIndex === resolved.length
  if (eventIndex > resolved.length) {
    return `eventIndex が範囲外です: ${eventIndex}（イベント数 ${resolved.length}）`
  }
  if (!Number.isInteger(textIndex) || textIndex < 0) {
    return `textIndex が不正です: ${textIndex}`
  }
  if (atEnd) {
    if (textIndex !== 0) return `textIndex が範囲外です: ${textIndex}（終端では 0 のみ）`
  } else {
    const bound = textIndexBound(resolved[eventIndex])
    if (bound !== null && textIndex >= bound) {
      return `textIndex が範囲外です: ${textIndex}（eventIndex ${eventIndex} の上限 ${bound}）`
    }
  }
  return null
}

/**
 * エントリの線形ストリームを構成するシーン区間 (#777)。
 * `start` / `length` はエントリの元イベント列（`[条件:]` 展開前）での位置。
 */
export interface LinearSegment {
  sceneId: string
  start: number
  length: number
}

/**
 * エントリの線形ストリーム（シーンの間に `SceneTransition` を挟んで flatten した元イベント列）を、
 * 元のシーン区間に分解する (#777)。
 *
 * 作者の `[場面転換]` も同じ `'SceneTransition'` なので、イベントの種別では境界を区別できない。
 * そこで `scenes` の各シーンの events が同一オブジェクト参照で並び、直後に `SceneTransition`（または終端）が
 * 来るものだけを区間とする。照合できなくなったところで打ち切る（以降は線形ストリームの外）。照合は先頭のシーンを見つけたあと、`scenes` 上の次のシーンを順に行う（エントリ文書のシーンは `scenes` 上で連続・文書順）。
 * events が空のシーンは長さ 0 の区間にする。
 */
export function findLinearSegments(
  entryEvents: readonly Event[],
  scenes: readonly EventScene[]
): LinearSegment[] {
  // 先頭に照合できるシーンが複数あり得る（文字列イベントだけのシーン同士など）ので、候補ごとに連鎖を作り、
  // 一番長く続くものを採る。
  let best: LinearSegment[] = []
  for (let i = 0; i < scenes.length; i++) {
    if (!matchesAt(entryEvents, 0, scenes[i].events)) continue
    const chain = chainFrom(entryEvents, scenes, i)
    if (chain.length > best.length) best = chain
  }
  return best
}

/**
 * `scenes[first]` が先頭に照合できたとして、以降は `scenes` 上の次のシーンを順に照合する。
 * エントリ文書のシーンは `allScenes` 上で連続し文書順に並ぶ。events が空のシーンは長さ 0 の区間にする
 * （直後の境界の `SceneTransition` を消費する）。
 */
function chainFrom(
  entryEvents: readonly Event[],
  scenes: readonly EventScene[],
  first: number
): LinearSegment[] {
  const segments: LinearSegment[] = []
  let pos = 0
  for (let i = first; i < scenes.length; i++) {
    const scene = scenes[i]
    if (!matchesAt(entryEvents, pos, scene.events)) break
    segments.push({ sceneId: scene.id, start: pos, length: scene.events.length })
    pos += scene.events.length
    if (pos >= entryEvents.length) break
    // matchesAt が直後の境界を確認済み
    pos += 1
  }
  return segments
}

function matchesAt(stream: readonly Event[], pos: number, events: readonly Event[]): boolean {
  if (pos + events.length > stream.length) return false
  for (let i = 0; i < events.length; i++) {
    if (stream[pos + i] !== events[i]) return false
  }
  const next = pos + events.length
  return next === stream.length || stream[next] === 'SceneTransition'
}

/**
 * 区間を `[条件:]` 展開後の位置に直した境界 (#777)。
 * `start`: 展開後のストリームでのシーン先頭、`separator`: 直前の境界の `SceneTransition` の位置
 * （先頭の区間は null）。展開は現在の flags で行うので、flags が変わったら引き直す。
 */
export interface ResolvedSegment {
  sceneId: string
  start: number
  separator: number | null
}

export function resolveLinearSegments(
  entryEvents: readonly Event[],
  segments: readonly LinearSegment[],
  resolvedLength: (events: readonly Event[]) => number
): ResolvedSegment[] {
  const out: ResolvedSegment[] = []
  let pos = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const separator = i === 0 ? null : pos
    if (i > 0) pos += 1
    out.push({ sceneId: seg.sceneId, start: pos, separator })
    pos += resolvedLength(entryEvents.slice(seg.start, seg.start + seg.length))
  }
  return out
}

/** 展開後のイベント位置 `index` が属するシーン区間（境界の `SceneTransition` 自身は次のシーンに属す）。 */
export function segmentAt(
  resolved: readonly ResolvedSegment[],
  index: number
): ResolvedSegment | null {
  let found: ResolvedSegment | null = null
  for (const seg of resolved) {
    const from = seg.separator ?? seg.start
    if (index >= from) found = seg
    else break
  }
  return found
}
