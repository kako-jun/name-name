import type { Event } from '../types'
import type { NovelGameState } from './GameState'
import { resolveEvents, type GameState } from './GameState'
import { countDisplayEvents, remapEventIndexAfterReResolve } from './eventCursor'
import type { NovelPage } from './novelLayout'

/**
 * 再生カーソルとイベント配列・履歴の唯一の書き手 (#824, #735 3/8)。
 *
 * 「今どのイベントのどの行か」（`eventIndex` / `textIndex` / `sentenceIndex`）と、その対象配列
 * （`rawEvents` / `resolvedEvents` / `displayEventCount`）、そこから派生するページキャッシュ、スナップショット
 * 履歴、再生中のシーン id、再生開始済みか、はここだけが書く。`NovelRenderer` は読み取り用の getter で読み、
 * 書き込みは必ずこのクラスのメソッド経由にする（読み取りの getter だけを公開し setter は持たない）。
 *
 * 不変条件: 展開後の列（`resolvedEvents`）は常に `resolveEvents(rawEvents, flags)` で再現できる
 * （ADR 0003 #777 追記）。3点セット（`rawEvents` / `resolvedEvents` / `displayEventCount`）は
 * `expand` を通してのみ更新する。
 *
 * ページ分割そのもの（`getNovelPages` / `getAdvSentencePages`）はスタイル設定・DOM 計測に依存するので
 * レンダラに残し、ここは派生キャッシュの保持と無効化（`invalidatePages`）だけを持つ。
 * Pixi・DOM・タイマーには依存しない。
 */
export class PlaybackCursor {
  /** Condition 展開前の元イベント配列（Flag 変更時の再展開に使用）。「今どのルートを再生中か」を表す。 */
  private _rawEvents: Event[] = []
  /** Condition 展開済みのフラットなイベント配列。 */
  private _resolvedEvents: Event[] = []
  private _eventIndex = 0
  private _textIndex = 0
  /** novel スタイルの「現ページ内で表示済みの最後の文 index」（0-based）。adv では常に 0。 */
  private _sentenceIndex = 0
  /** 展開後の列に含まれる本文イベント（Dialog / Narration）の数。 */
  private _displayEventCount = 0
  /** novel 改頁キャッシュ。eventIndex 単位の派生データ。 */
  private _novelPagesCache: { eventIndex: number; pages: NovelPage[] } | null = null
  /** adv 文単位ページキャッシュ。eventIndex 単位の派生データ。 */
  private _advSentencePagesCache: { eventIndex: number; pages: string[] } | null = null
  /** スナップショット履歴スタック（テキストイベント到達ごとに push）。 */
  private _history: NovelGameState[] = []
  /** 再生中のシーン id。シーンを持たない線形ストリームでは null。 */
  private _currentSceneId: string | null = null
  /**
   * 再生が開始済みか。`loadEvents` / `loadScenes` の直後は false（文書だけ入って位置が未確定）で、
   * 入場の適用（`markStarted`）で true になる。
   */
  private _playbackStarted = false

  // --- 読み取り ---

  get rawEvents(): readonly Event[] {
    return this._rawEvents
  }

  get resolvedEvents(): readonly Event[] {
    return this._resolvedEvents
  }

  get eventIndex(): number {
    return this._eventIndex
  }

  get textIndex(): number {
    return this._textIndex
  }

  get sentenceIndex(): number {
    return this._sentenceIndex
  }

  get displayEventCount(): number {
    return this._displayEventCount
  }

  get history(): readonly NovelGameState[] {
    return this._history
  }

  get currentSceneId(): string | null {
    return this._currentSceneId
  }

  get playbackStarted(): boolean {
    return this._playbackStarted
  }

  get novelPagesCache(): { eventIndex: number; pages: NovelPage[] } | null {
    return this._novelPagesCache
  }

  get advSentencePagesCache(): { eventIndex: number; pages: string[] } | null {
    return this._advSentencePagesCache
  }

  // --- イベント列（3点セット） ---

  /**
   * `rawEvents` を入れ替え、`resolvedEvents` / `displayEventCount` を同時に求め直す。
   * 位置・履歴・ページキャッシュには触らない（呼び出し側が続けて `load` 相当の再設定をするか、
   * `restorePosition` で位置を確定する）。
   */
  replaceEvents(rawEvents: Event[], flags: GameState): void {
    this._rawEvents = rawEvents
    this.expand(flags)
  }

  /**
   * 新しいイベント列で再生位置を最初から作り直す（位置は `startIndex`、textIndex / sentenceIndex は 0、
   * 履歴は空、ページキャッシュは破棄）。`playbackStarted` は変えない。
   */
  load(rawEvents: Event[], flags: GameState, startIndex = 0): void {
    this.replaceEvents(rawEvents, flags)
    this._eventIndex = startIndex
    this._textIndex = 0
    this._sentenceIndex = 0
    this._history = []
    this.invalidatePages()
  }

  /**
   * `flags` で `rawEvents` を全体展開し直して `resolvedEvents` / `displayEventCount` を更新する。
   * 展開は履歴に依存せず flags だけで決まる（ADR 0003 #777 追記）。
   */
  private expand(flags: GameState): void {
    this._resolvedEvents = resolveEvents(this._rawEvents, flags)
    this._displayEventCount = countDisplayEvents(this._resolvedEvents)
  }

  /**
   * Flag 実行後の再展開。全体を展開し直し、`eventIndex` を決定的に写像する (#777)。
   * 現在のイベントが新しい列に残ればその位置、囲む `[条件:]` が偽で消えたら元イベント列上で次に残る
   * イベントの直前（呼び出し元が続けて `eventIndex` を進める）。textIndex / sentenceIndex / 履歴は変えない。
   */
  reResolve(flags: GameState): void {
    const current = this._resolvedEvents[this._eventIndex]
    this.expand(flags)
    this._eventIndex = remapEventIndexAfterReResolve(
      this._rawEvents,
      this._resolvedEvents,
      current,
      this._eventIndex,
      flags
    )
    this.invalidatePages()
  }

  // --- 位置 ---

  /**
   * スナップショットの位置へ復元する。復元前に `flags`（呼び出し側が `state.flags` で置換済み）で全体を
   * 展開し直す（goBack/seekTo は flags だけを過去の値に戻すので、列と位置を揃える #777）。
   * `sentenceIndex` が無い古いスナップショットは 0（ページ先頭の文）に倒す。
   */
  restorePosition(state: NovelGameState, flags: GameState): void {
    this.expand(flags)
    this._eventIndex = state.eventIndex
    this._textIndex = state.textIndex
    this._sentenceIndex = state.sentenceIndex ?? 0
    this.invalidatePages()
  }

  /** 現在ページ内で次の文へ進む（novel）。 */
  nextSentence(): void {
    this._sentenceIndex++
  }

  /** 次ページの先頭文へ進む（novel）。 */
  nextPageStart(): void {
    this._textIndex++
    this._sentenceIndex = 0
  }

  /** 次の text 行へ進む（adv）。 */
  nextTextLine(): void {
    this._textIndex++
  }

  /**
   * 次のイベントへ進み、ページ内の位置を先頭へ戻して派生ページキャッシュを破棄する（本文イベントを離れる時）。
   */
  nextEvent(): void {
    this._eventIndex++
    this._textIndex = 0
    this._sentenceIndex = 0
    this.invalidatePages()
  }

  /**
   * 次のイベントへ位置だけ進める（非本文イベントの実行後・`[待機]` 明け）。ページ内の位置と
   * ページキャッシュは触らない（本文イベントの上にいないので派生データは未使用）。
   */
  skipDirective(): void {
    this._eventIndex++
  }

  /** 現在ページ内で 1 文戻る（novel）。 */
  prevSentence(): void {
    this._sentenceIndex--
  }

  /** 前ページへ戻り、前ページの `lastSentenceIndex` 番目の文を表示位置にする（novel）。 */
  prevPage(lastSentenceIndex: (prevTextIndex: number) => number): void {
    this._textIndex--
    this._sentenceIndex = lastSentenceIndex(this._textIndex)
  }

  /** text 行を 1 つ戻る（adv）。 */
  prevTextLine(): void {
    this._textIndex--
  }

  /**
   * `textIndex` を `pageCount` 以上にならないよう最終ページへ寄せる (#789, #663)。寄せたときだけ
   * `sentenceIndex` を 0 に戻す（ページが変わるため）。寄せたかを返す。
   */
  clampToPageCount(pageCount: number): boolean {
    if (pageCount > 0 && this._textIndex >= pageCount) {
      this._textIndex = pageCount - 1
      this._sentenceIndex = 0
      return true
    }
    return false
  }

  // --- 派生ページキャッシュ ---

  /** novel 改頁・adv 文単位ページの派生キャッシュを両方破棄する（無効化はここ1本）。 */
  invalidatePages(): void {
    this._novelPagesCache = null
    this._advSentencePagesCache = null
  }

  /** 現在の `eventIndex` に対する novel 改頁を保存する。 */
  cacheNovelPages(pages: NovelPage[]): void {
    this._novelPagesCache = { eventIndex: this._eventIndex, pages }
  }

  /** 現在の `eventIndex` に対する adv 文単位ページを保存する。 */
  cacheAdvSentencePages(pages: string[]): void {
    this._advSentencePagesCache = { eventIndex: this._eventIndex, pages }
  }

  // --- 履歴 ---

  /** 履歴を空にするか、`snapshot` 1件だけにする（復元後は現在位置のみ）。 */
  resetHistory(snapshot?: NovelGameState): void {
    this._history = snapshot ? [snapshot] : []
  }

  pushHistory(snapshot: NovelGameState): void {
    this._history.push(snapshot)
  }

  /** 末尾を 1 件取り除く。 */
  popHistory(): void {
    this._history.pop()
  }

  /** 履歴を `index` 番目（含む）までに切り詰め、その要素を返す（アンドゥスタック方式のシーク）。 */
  truncateHistory(index: number): NovelGameState {
    this._history = this._history.slice(0, index + 1)
    return this._history[index]
  }

  // --- シーン・開始状態 ---

  setCurrentSceneId(sceneId: string | null): void {
    this._currentSceneId = sceneId
  }

  markStarted(): void {
    this._playbackStarted = true
  }

  markUnstarted(): void {
    this._playbackStarted = false
  }
}
