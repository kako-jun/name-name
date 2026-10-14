import type { TimeController } from './TimeController'
import {
  createDeferred,
  gateReason as computeGateReason,
  isTransitionGated,
  type Deferred,
  type GatedOperation,
  type GateReason,
  type PendingEntry,
  type SceneEntryResult,
  type TransitionGateState,
} from './sceneEntry'

/** 本文なしで連続できる `[ジャンプ:]` の上限 (#725)。TUI の `RELAY_HOP_LIMIT` と同値。 */
export const JUMP_CHAIN_LIMIT = 100

/** `[ジャンプ:]` の遷移状態 (#733)。 */
export type JumpState = 'idle' | 'pending' | 'stalled'

/**
 * `arm` が発火時に呼び出し元（レンダラ）へ頼む操作。TransitionState は DOM/Pixi/シーン内容を知らないので、
 * 入場の実行と警告の表示は呼び出し側が持つ。
 */
export interface JumpFireHandlers {
  /** レンダラが初期化済みで破棄されていないか。false なら何もせず superseded で解決する。 */
  isActive(): boolean
  /** 本文なしの Jump 連鎖が `JUMP_CHAIN_LIMIT` を超えたときの警告（停止は TransitionState が行う）。 */
  warnChainLimit(): void
  /** 遷移先への入場を実行して結果を返す。 */
  enter(): Promise<SceneEntryResult>
}

/**
 * 遷移ゲートと `[ジャンプ:]` 予約の状態機械 (#825, #735 4/8)。
 *
 * 次のフィールドの唯一の書き手: `waitingForChoice` / `waitingForWait` / `justSelectedChoice` /
 * `suppressNextAdvance` / `jumpState` / `jumpTimer` / `jumpDeferred` / `consecutiveJumps` /
 * `pendingEntry` / `transitionGeneration`。`NovelRenderer` は読み取り用の getter で読み、書き込みは必ず
 * このクラスのメソッド経由にする。
 *
 * 遷移状態は GameState に載せない（#758）。復元後は位置から再導出するのはレンダラの責務で、ここは
 * 「リセットして idle に戻す」ところまでを担う。ADR 0003 の契約を不変条件として持つ:
 * - 予約中の Jump の取り消しはすべて `clear()` を通り、待っている側の deferred を `superseded` で解決する
 *   （解決はここの1か所）
 * - `arm()` は予約の時点（タイマーが発火する前）で `pendingEntry` を立てる
 * - `advanceGeneration()` は `pendingEntry` を下ろす
 * - `JUMP_CHAIN_LIMIT` を超えたら `stalled` にする
 *
 * DOM・Pixi・レンダラ・シーン内容には依存しない。タイマーは注入された TimeController を使う。
 */
export class TransitionState {
  /** 選択肢表示中フラグ。 */
  private _waitingForChoice = false
  /** `[待機]` 実行中フラグ（Jump の遷移状態は `jumpState` が持つ、#733）。 */
  private _waitingForWait = false
  /** 選択肢クリック直後の同フレーム advance を抑制するフラグ (#211)。 */
  private _justSelectedChoice = false
  /** SeekBar 操作直後の同フレーム advance を抑制するフラグ (#350)。 */
  private _suppressNextAdvance = false
  /**
   * - `idle`: Jump を実行していない（通常）
   * - `pending`: 遷移を予約済み（次の macrotask の発火待ち・遅延ロード往復中）
   * - `stalled`: 遷移先不在・循環上限で Jump 位置に停止中
   */
  private _jumpState: JumpState = 'idle'
  /** Jump の遷移を発火する timer。 */
  private _jumpTimer: number | null = null
  /** 予約中の Jump の deferred (#734)。取り消し経路はすべて `clear()` で superseded 解決する。 */
  private _jumpDeferred: Deferred<SceneEntryResult> | null = null
  /** 本文を描画しないまま連続して実行した `[ジャンプ:]` の回数 (#725)。 */
  private _consecutiveJumps = 0
  /** 入場中ゲート (#734)。遅延ロードの往復を待っている間だけ立つ。 */
  private _pendingEntry: PendingEntry | null = null
  /** 遷移文脈の世代 (#733)。再生位置が別の文脈へ移る箇所で進める。 */
  private _transitionGeneration = 0

  /**
   * @param time タイマー。`onStall` は `pending` → `stalled` の遷移が実際に起きたときだけ呼ぶ
   *   （スキップ中に停止した Jump へ着き続けて空回りしないよう、レンダラがスキップを解除する）。
   */
  constructor(
    private readonly time: TimeController,
    private readonly onStall: () => void
  ) {}

  // --- 読み取り ---

  get waitingForChoice(): boolean {
    return this._waitingForChoice
  }

  get waitingForWait(): boolean {
    return this._waitingForWait
  }

  get jumpState(): JumpState {
    return this._jumpState
  }

  get pendingEntry(): PendingEntry | null {
    return this._pendingEntry
  }

  get hasPendingEntry(): boolean {
    return this._pendingEntry !== null
  }

  get generation(): number {
    return this._transitionGeneration
  }

  isJumpPending(): boolean {
    return this._jumpState === 'pending'
  }

  isJumpStalled(): boolean {
    return this._jumpState === 'stalled'
  }

  // --- ゲート判定 ---

  gateState(): TransitionGateState {
    return {
      waitingForChoice: this._waitingForChoice,
      waitingForWait: this._waitingForWait,
      jumpState: this._jumpState,
      hasPendingEntry: this._pendingEntry !== null,
    }
  }

  /** この操作を今は受け付けてはいけないか (#734)。 */
  isGated(op: GatedOperation): boolean {
    return isTransitionGated(op, this.gateState())
  }

  /** この操作を止めている理由（止めないなら null）。 */
  gateReason(op: GatedOperation): GateReason | null {
    return computeGateReason(op, this.gateState())
  }

  // --- 世代 ---

  /** 古い入場の結果を破棄すべきか（捕捉した世代と現在の世代が違う）。 */
  isStale(generation: number): boolean {
    return generation !== this._transitionGeneration
  }

  /**
   * 再生位置が別の文脈へ移るときに世代を進める (#734)。待っていた入場は世代の不一致で破棄されるので、
   * 入場中ゲートもここで下ろす。
   */
  advanceGeneration(): void {
    this._transitionGeneration++
    this._pendingEntry = null
  }

  /**
   * 入場の開始 (#734)。世代を進めて捕捉し、予約中の Jump のタイマーを取り消し（発火済みの Jump 自身の
   * 入場では何もしない）、入場中ゲートを下ろす。`jumpState` は触らない: ロード中も予約中・停止中のゲートを
   * 保ち、結末（成功は idle 化・失敗は再導出・破棄は世代を進めた側）で確定する (#759)。
   */
  beginEntry(): number {
    const generation = ++this._transitionGeneration
    this.clear()
    this._pendingEntry = null
    return generation
  }

  // --- 入場待ち ---

  /** 進行中の入場を登録する（ゲートを立てる）。 */
  setPendingEntry(entry: PendingEntry): void {
    this._pendingEntry = entry
  }

  /** この世代の入場が決着したので、入場中ゲートを下ろす（別の入場に置き換わっていれば触らない）。 */
  settlePendingEntry(generation: number): void {
    if (this._pendingEntry?.generation === generation) this._pendingEntry = null
  }

  /** 入場中ゲートを無条件に下ろす。 */
  clearPendingEntry(): void {
    this._pendingEntry = null
  }

  /**
   * playScript 用 (#725/#734): 進行中の入場があれば、その Promise が解決するまで待つ。予約を取り消す経路は
   * deferred を superseded で解決するので、待ち続けて止まることはない。待った場合は true を返す。
   */
  async awaitPending(): Promise<boolean> {
    const promise = this._pendingEntry?.promise
    if (!promise) return false
    await promise
    // 解決したのに同じ入場が残っているなら（防御）、待ち直さない。
    return this._pendingEntry?.promise !== promise
  }

  // --- Jump 予約 ---

  /**
   * Jump の遷移を予約する (#725/#733)。前の予約は `clear()` で取り消し、世代を進め、`pending` にして、
   * 予約の時点で待つ対象（`pendingEntry`）を作る。次の macrotask で発火する。
   */
  arm(target: string, handlers: JumpFireHandlers): void {
    this.clear()
    this._transitionGeneration++
    this._jumpState = 'pending'
    // 予約の時点（setTimeout(0) が発火する前）で待つ対象を作る。発火後は enterScene の Promise が引き継ぐ (#734)。
    const deferred = createDeferred<SceneEntryResult>()
    this._jumpDeferred = deferred
    this._pendingEntry = {
      generation: this._transitionGeneration,
      kind: 'progress',
      sceneId: target,
      promise: deferred.promise,
    }
    this._jumpTimer = this.time.setTimeout(() => {
      this._jumpTimer = null
      // 発火したので、以後の取り消しでは解決しない（enterScene の結果で解決する）。
      this._jumpDeferred = null
      if (!handlers.isActive()) {
        deferred.resolve({ status: 'superseded' })
        return
      }
      // 本文を描画しない Jump だけの連鎖（循環）は上限で止める。
      if (this.noteChainHop() === 'limit') {
        handlers.warnChainLimit()
        if (this._pendingEntry?.promise === deferred.promise) this._pendingEntry = null
        this.stall()
        deferred.resolve({ status: 'failed', reason: 'not-found' })
        return
      }
      void handlers.enter().then(deferred.resolve)
    }, 0)
  }

  /**
   * Jump の予約を取り消す (#734)。timer を止め、待っている側が止まらないよう deferred を superseded で
   * 解決する（`superseded` の解決はここの1か所）。遷移状態（`jumpState`）は触らない。
   */
  clear(): void {
    if (this._jumpTimer) {
      this.time.clearTimeout(this._jumpTimer)
      this._jumpTimer = null
    }
    const deferred = this._jumpDeferred
    if (deferred) {
      this._jumpDeferred = null
      if (this._pendingEntry?.promise === deferred.promise) this._pendingEntry = null
      deferred.resolve({ status: 'superseded' })
    }
  }

  /**
   * 予約中（pending）から停止中（stalled）へ移す (#725)。予約中でなければ（await 中に新規開始・復元で
   * idle へ戻った等）何もしない (#733)。遷移したときだけ true。
   */
  stall(): boolean {
    if (this._jumpState !== 'pending') return false
    this._jumpState = 'stalled'
    this.onStall()
    return true
  }

  /** 予約中のまま残った pending を idle に確定させる（現在位置が Jump でないときの防御）。 */
  settleJumpIdle(): void {
    if (this._jumpState === 'pending') this._jumpState = 'idle'
  }

  /** 本文なしの Jump 連鎖を1つ数え、上限を超えたかを返す。 */
  noteChainHop(): 'ok' | 'limit' {
    this._consecutiveJumps++
    return this._consecutiveJumps > JUMP_CHAIN_LIMIT ? 'limit' : 'ok'
  }

  /** Jump 連鎖のカウンタをリセットする（本文の描画・ユーザー操作・状態復元・新規開始）。 */
  resetChain(): void {
    this._consecutiveJumps = 0
  }

  // --- 選択肢・待機 ---

  enterChoiceWait(): void {
    this._waitingForChoice = true
  }

  leaveChoiceWait(): void {
    this._waitingForChoice = false
  }

  enterWait(): void {
    this._waitingForWait = true
  }

  leaveWait(): void {
    this._waitingForWait = false
  }

  // --- 入力抑制 ---

  /**
   * 選択肢確定直後の同フレーム advance を抑制する (#211)。enterScene が例外を投げても次のイベントループで
   * 確実にリセットされるよう setTimeout(0) で下ろす。
   */
  markChoiceJustSelected(): void {
    this._justSelectedChoice = true
    this.time.setTimeout(() => {
      this._justSelectedChoice = false
    }, 0)
  }

  /** 選択肢確定直後の抑制を、消費せずに下ろす（playScript・完全リセット）。 */
  clearJustSelectedChoice(): void {
    this._justSelectedChoice = false
  }

  /** 選択肢確定直後の抑制が立っていれば下ろして true を返す。 */
  consumeJustSelectedChoice(): boolean {
    if (!this._justSelectedChoice) return false
    this._justSelectedChoice = false
    return true
  }

  /** SeekBar 起因の同フレーム advance 抑制を立てる (#350)。 */
  suppressNextAdvance(): void {
    this._suppressNextAdvance = true
  }

  /** SeekBar 起因の抑制が立っていれば下ろして true を返す。 */
  consumeSuppressNextAdvance(): boolean {
    if (!this._suppressNextAdvance) return false
    this._suppressNextAdvance = false
    return true
  }

  // --- 位置の切り替え ---

  /**
   * 復元など、新しい到達として扱うときのリセット (#733)。予約中・停止中のどちらも持ち越さず idle へ戻し、
   * 世代を進め、Jump の予約を取り消す。選択肢・待機のフラグは触らない。
   */
  resetJumpForRestore(): void {
    this._jumpState = 'idle'
    this.advanceGeneration()
    this.clear()
  }

  /**
   * 新しい位置から始めるときの完全リセット。`waitingFor*=false; jumpState='idle'; advanceGeneration();
   * clear()` の重複ブロックを1つにしたもの。
   */
  resetForNewPosition(): void {
    this._waitingForChoice = false
    this._waitingForWait = false
    this.resetJumpForRestore()
  }

  /** レンダラ破棄時: 予約を取り消し、入場中ゲートを下ろす。 */
  dispose(): void {
    this.clear()
    this._pendingEntry = null
  }
}
