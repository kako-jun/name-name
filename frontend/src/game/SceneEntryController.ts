import type { Event, EventScene, FlagValue } from '../types'
import {
  expandEvents,
  entryFromState,
  type NovelGameState,
  type StartFromOptions,
} from './GameState'
import { getTextEvent } from './eventCursor'
import { buildFreshPositionState } from './freshState'
import { isSceneIdConfined } from './sceneConfinement'
import {
  carryPolicyFor,
  findRestorePositionError,
  lacksLeadingBackground,
  type LoadOrigin,
  type SceneEntryRequest,
  type SceneEntryResult,
} from './sceneEntry'
import type { PlaybackCursor } from './PlaybackCursor'
import type { SceneIndex, SceneLookup } from './SceneIndex'
import type { TransitionState } from './TransitionState'

/** 解決できなかった入場（`SceneLookup` の failed 側）。 */
type EntryFailure = Extract<SceneLookup, { status: 'failed' }>

/**
 * 入場の周辺で外へ知らせる通知 (#826)。`onSceneChange` コールバックとトーストは、ともに「外への通知」で
 * 描画の実体はレンダラが持つので、Host へは1本のメソッドで渡す。
 */
export type EntryNotice =
  | { kind: 'sceneChange'; sceneId: string }
  | { kind: 'loadSuccess'; origin: LoadOrigin }
  | { kind: 'loadFailure' }

/**
 * `SceneEntryController` がレンダラ（ファサード）へ頼む操作 (#826)。入場の手続き（順序・世代・失敗処理）は
 * コントローラが持ち、「何を描くか」（持ち越しの実体・イベント列の組み立て・宣言的復元・通知の見せ方）は
 * レンダラが実装する。コントローラは `NovelRenderer` を import せず、この型だけを見る。
 * メソッド数は8以内に保つ（超えるなら境界の切り方を見直す、#735 設計 §6）。
 */
export interface EntryHost {
  /** レンダラが初期化済みで破棄されていないか。false なら遅延ロード後の適用を捨てる (#463)。 */
  isActive(): boolean
  /** 終劇にする（confinement 外への進行）。 */
  endStory(): void
  /**
   * 新規開始の適用の前に文脈を確定する (#734, ADR 0003 §3 の5): flags を置換し、終劇状態を解除する。
   * 失敗（解決できなかった）では呼ばれない。
   */
  applyFreshContext(flags: Record<string, FlagValue>): void
  /**
   * 通常の入場でイベント列を流し始める (#734)。終劇状態を解除し（適用の中で起きる先回り終劇 #398 の
   * `endStory()` が二重発火ガードで潰れないようにするため）、`currentSceneId` を設定し、演出をリセットして
   * 最初のテキストまで進める。
   */
  startEvents(
    sceneId: string | null,
    events: readonly Event[],
    opts: {
      preserveBackgroundForTransition: boolean
      carryBgm: boolean
      startIndex?: number
      fromRawIndex?: number
    }
  ): void
  /**
   * 完成済みの状態へ宣言的に復元する（`restoreToScene`）。`presetStoryEnded` が true のときは、適用の前に
   * `state.storyEnded` を直接セットして、新規 construct された renderer の `applyState` が終劇コールバックを
   * 二重発火しないようにする (#460)。
   */
  restoreToScene(scene: EventScene, state: NovelGameState, presetStoryEnded: boolean): void
  /** シーン変更・ロード結果の通知（`onSceneChange` とトースト）。 */
  notify(notice: EntryNotice): void
  /** 失敗後に現在位置から遷移状態（選択肢の再表示・Jump の再予約）を導出し直す。`processDirective` を呼ぶのでレンダラが持つ。 */
  rederiveTransition(): void
  /** テキストのページ数が表示幅や文分割に依存するか（ノベルスタイル・文単位ページ）。復元位置の範囲チェックが上限を見ない条件。 */
  isTextPaginated(): boolean
}

/**
 * シーン入場の単一入口 (#826, #735 5/8)。ADR 0003 の手続き全体（世代捕捉 → confinement → 解決 → 前処理 →
 * 適用 → 後処理 → 失敗処理）を持つ。「何を描くか」は知らず、適用は `EntryHost` に委譲する。
 *
 * `confinedSceneIds`（入場属性）の唯一の書き手。`SceneIndex`（シーンの引き当て）・`TransitionState`
 * （世代・入場中ゲート・Jump 予約）・`PlaybackCursor`（`playbackStarted` の読み取りのみ）は注入された
 * 参照として使う。DOM・Pixi・`NovelRenderer` には依存しない。
 */
export class SceneEntryController {
  /**
   * `?scene=` ディープリンク単独埋め込みの confinement（在圏）一覧 (#386)。
   * null なら制限なし（通常のハブ経由フロー）。非 null のときは進行がこの集合の外への遷移を検出し、
   * 通常のシーン遷移ではなく `endStory()`（終劇）にする。
   * 新規開始の入場属性として `startFrom({ confinedSceneIds })` が、解決できた時点で置き換える
   * （呼び出し側は `PlayerScreen` が算出した対象 script ファイル自身の sceneId 一覧を渡す）。
   */
  private _confinedSceneIds: string[] | null = null

  constructor(
    private readonly host: EntryHost,
    private readonly sceneIndex: SceneIndex,
    private readonly transition: TransitionState,
    private readonly cursor: PlaybackCursor
  ) {}

  get confinedSceneIds(): string[] | null {
    return this._confinedSceneIds
  }

  /**
   * 指定シーンへ進行する (#734)。進行（選択肢の確定・`[ジャンプ:]`・`playScript` の choice）専用で、
   * 実体は単一の入口 `enter` に委譲する。
   */
  jumpTo(sceneId: string): Promise<SceneEntryResult> {
    return this.enter({ kind: 'progress', sceneId, origin: 'choice' })
  }

  /** 新規開始 (#734, ADR 0003)。オプションを入場の要求に整形して `enter` に渡す。 */
  startFrom(opts: StartFromOptions = {}): Promise<SceneEntryResult> {
    const eventIndex = opts.eventIndex ?? 0
    const textIndex = opts.textIndex ?? 0
    const sentenceIndex = opts.sentenceIndex ?? 0
    // 位置の指定がある場合だけ宣言的復元（`?debug_scene=` の途中局面）。無ければ先頭からの通常入場 (#399)。
    const position =
      opts.sceneId && (eventIndex !== 0 || textIndex !== 0 || sentenceIndex !== 0)
        ? { eventIndex, textIndex, sentenceIndex }
        : undefined
    return this.enter({
      kind: 'fresh',
      target: opts.sceneId ? { sceneId: opts.sceneId } : 'entry',
      flags: opts.flags,
      position,
      confinedSceneIds: opts.confinedSceneIds,
      linear: opts.linear,
    })
  }

  /**
   * 発火して忘れる呼び出し元（Jump のタイマー・選択肢の確定）用の入口。`enter` は同期の適用の例外も
   * 結果（failed）にして返すので、この try/catch は `enter` の前段（世代の更新など）で想定外に
   * 投げた場合の保険としてだけ働く。呼び出し元が待つ Promise を必ず解決し、未処理の rejection にしない。
   */
  run(req: SceneEntryRequest): Promise<SceneEntryResult> {
    try {
      return this.enter(req)
    } catch (err) {
      return Promise.resolve(this.failApply(req, err))
    }
  }

  /**
   * シーン入場の単一入口 (#734, ADR 0003 §3)。進行（選択肢・`[ジャンプ:]`・`playScript` の choice）と
   * 復元（クイックロード・ロードメニュー・`restoreSnapshot`）は、公開 API がこの入口を通る。
   * 新規開始（`startFrom`）も同じ入口を通る。
   *
   * 処理の順序:
   * 1. 要求の時点で遷移世代を進めて捕捉し、予約中の Jump を取り消す（後勝ち）
   * 2. 進行のときだけ confinement を判定する（圏外は終劇）
   * 3. `this.sceneIndex.resolve` でシーンを引く。読み込み済みなら同期のまま適用する。未ロードなら入場中ゲート
   *    （`pendingEntry`）を立てて待ち、await の後に世代と `isActive` をこの1か所で判定する
   *    （不一致は superseded。成功・失敗とも何もしない。後始末は世代を進めた新しい側が担う）
   * 4. 見つからなければ種類に応じて失敗として扱い、位置から遷移状態を導出し直す
   * 5. 適用し、入場中ゲートを下ろす
   */
  enter(req: SceneEntryRequest): Promise<SceneEntryResult> {
    // 世代を捕捉し、予約中の Jump のタイマーを取り消し、入場中ゲートを下ろす。jumpState は触らない (#759)。
    const generation = this.transition.beginEntry()

    if (req.kind === 'progress' && !isSceneIdConfined(req.sceneId, this._confinedSceneIds)) {
      // #386: confinement（在圏）外への進行は通常のシーン遷移にせず終劇にする。
      // theo-hayami の hub（別の問いを聞く → hub）等、埋め込み外の内容が漏れるのを防ぐ唯一の
      // choke point。scene の存在チェックより前に判定する（allScenes に実在する hub 等でも
      // 圏外なら即終劇＝lazy load すら試みない）。
      // #386 レビュー Q1（dev 診断のみ・production の挙動/見た目は不変）:
      // fail-closed（圏外は理由を問わず終劇）という設計は維持する。ただし「圏外だが
      // 実在するシーン（例: hub。意図した終劇）」と「原稿の typo でどこにも存在しない
      // sceneId（正常な終劇に偽装された事故）」を区別できないと、typo が気づかれない
      // まま「正常な終劇」として素通りしてしまう。allScenes（entry + 圏内 script の
      // 全シーン）にも見つからない場合だけ、開発時に気づけるよう警告を残す。
      if (import.meta.env.DEV && !this.sceneIndex.findScene(req.sceneId)) {
        console.warn(
          `[name-name] confinement: sceneId "${req.sceneId}" は allScenes にも存在しません。終劇として扱いますが、原稿の typo の可能性があります（意図した圏外遷移なら無視してください）。`
        )
      }
      // ここは onEndCallback の有無を見ずに常に endStory() を呼ぶ（#386 由来）。advance() の
      // 自然消化パス（#470）は onEndCallback 登録時に完全委譲し endStory() を呼ばないのと非対称だが、
      // confinedSceneIds（PlayerScreen の `?scene=` 埋め込み限定）と onEndCallback（EditorScreen の
      // VideoExporter 限定）が同時に有効になる画面配線が現状存在しないため到達不可能で実害はない。
      // 将来この2つが同一画面で両立する機能が来たら、この非対称性を再点検すること。
      this.host.endStory()
      return Promise.resolve({ status: 'ended' })
    }

    if (req.kind === 'fresh' && req.target === 'entry') {
      // エントリ文書の線形ストリームの先頭から。シーンの引き当て（遅延ロード）は要らない。
      try {
        return Promise.resolve(
          this.applyFresh(req, this.sceneIndex.getEntrySceneId(), this.sceneIndex.getEntryEvents())
        )
      } catch (err) {
        return Promise.resolve(this.failApply(req, err))
      }
    }

    const sceneId =
      req.kind === 'progress'
        ? req.sceneId
        : req.kind === 'fresh'
          ? (req.target as { sceneId: string }).sceneId
          : req.state.sceneId
    if (!sceneId) {
      // 復元で sceneId が null: エントリ文書の線形ストリーム（`loadEvents`。ジャンプ前はシーン ID を持たない）
      // 上の位置。セーブは eventIndex でこの位置を指すので、エントリのイベント列へ宣言的に復元する (#768)。
      // 進行・新規開始は sceneId を必ず持つ（'entry' の新規開始は上で処理済み）ので、ここへ来るのは復元だけ。
      return Promise.resolve(
        this.restoreEntryStream(req as Extract<SceneEntryRequest, { kind: 'restore' }>)
      )
    }

    const resolution = this.sceneIndex.resolve(sceneId)
    if (!('then' in resolution)) {
      // 同期の適用が throw しても、呼び出し元へ伝播させず failed（apply-error）で解決する。
      // await 後の適用と同じ扱い（初期入場の連鎖が reject で途切れない）。
      try {
        return Promise.resolve(this.finishEntry(req, resolution))
      } catch (err) {
        return Promise.resolve(this.failApply(req, err))
      }
    }
    const promise: Promise<SceneEntryResult> = (async () => {
      const resolved = await resolution
      // 遷移文脈が変わった（遅延ロード中に新規開始・復元・再遷移が入った）古い解決は、成功・失敗とも
      // 破棄する (#733)。await 中に renderer が destroy() された場合も同様（#463: destroy 後は
      // 破棄済みの this.app.stage を触るため、初期化チェック無しで先に進むと例外を投げうる）。
      if (this.transition.isStale(generation)) return { status: 'superseded' } as const
      if (!this.host.isActive()) {
        // 破棄済みの renderer には何も適用しない。失敗の警告だけは残す（#463）。
        if (resolved.status === 'failed') this.warnEntryFailure(req, resolved)
        return { status: 'superseded' } as const
      }
      this.transition.settlePendingEntry(generation)
      // 適用の例外で Promise を reject させない（待っている側が止まる・未処理 rejection になる）。
      try {
        return this.finishEntry(
          req,
          resolved.status === 'loaded'
            ? this.sceneIndex.indexLoaded(sceneId, resolved.scenes)
            : resolved
        )
      } catch (err) {
        return this.failApply(req, err)
      }
    })()
    this.transition.setPendingEntry({ generation, kind: req.kind, sceneId, promise })
    return promise
  }

  /**
   * sceneId が null の復元 (#768)。エントリ文書の線形ストリーム（`entryRawEvents`）を復元先にする。
   * エントリ文書が未読み込みなら復元先が無いので失敗（位置・flags とも変えない）。
   * 同期の適用が throw しても failed（apply-error）で解決する。
   */
  private restoreEntryStream(
    req: Extract<SceneEntryRequest, { kind: 'restore' }>
  ): SceneEntryResult {
    if (this.sceneIndex.getEntryEvents().length === 0) {
      return this.failEntry(req, {
        status: 'failed',
        reason: 'not-found',
        detail: 'エントリ文書が読み込まれていないため、sceneId が null の位置を復元できません',
      })
    }
    const rangeError = this.checkRestorePosition(this.sceneIndex.getEntryEvents(), req.state)
    if (rangeError) return this.failEntry(req, rangeError)
    try {
      const entryId = this.sceneIndex.getEntrySceneId()
      const entry: EventScene = {
        id: entryId ?? '',
        title: '',
        view: 'TopDown',
        // readonly を通すためのコピー。restoreToScene が再度コピーするので挙動は変わらない
        events: [...this.sceneIndex.getEntryEvents()],
      }
      // sceneId はエントリの識別子に正規化する（loadEvents なら null。空文字のセーブも同じ扱い）。
      this.host.restoreToScene(entry, { ...req.state, sceneId: entryId }, req.source === 'snapshot')
      if (req.source === 'save' && req.origin) {
        this.host.notify({ kind: 'loadSuccess', origin: req.origin })
      }
      return { status: 'entered', sceneId: entryId }
    } catch (err) {
      return this.failApply(req, err)
    }
  }

  /** 入場の適用中の例外を失敗として扱い、結果を返す。ゲートも下ろす。 */
  private failApply(req: SceneEntryRequest, err: unknown): SceneEntryResult {
    this.transition.clearPendingEntry()
    this.handleApplyError(req, err)
    return { status: 'failed', reason: 'apply-error' }
  }

  /**
   * 入場の適用中に例外が出たとき（通信失敗ではなく実装・データの不具合）。ログを残し、Jump 由来なら停止し、
   * 選択肢由来なら閉じていた選択肢を再表示して、詰まらないようにする。
   */
  private handleApplyError(req: SceneEntryRequest, err: unknown): void {
    console.error('[name-name] シーン入場の適用中に例外が発生しました', err)
    if (req.kind === 'progress' && req.origin === 'jump') {
      this.transition.stall()
    } else if (req.kind === 'progress') {
      this.host.rederiveTransition()
    } else {
      this.transition.stall()
    }
  }

  /** 解決が済んだ入場を、種類に応じて適用する（失敗なら失敗として扱う）。 */
  private finishEntry(req: SceneEntryRequest, resolution: SceneLookup): SceneEntryResult {
    if (resolution.status === 'failed') {
      return this.failEntry(req, resolution)
    }
    if (req.kind === 'progress') {
      // 進行: 背景等・BGM を持ち越す。storyEnded は startScene が解除する。
      this.startScene(resolution.scene.id, resolution.scene.events, carryPolicyFor('progress'))
      return { status: 'entered', sceneId: resolution.scene.id }
    }
    if (req.kind === 'fresh') {
      return this.applyFresh(req, resolution.scene.id, resolution.scene.events, resolution.scene)
    }
    // 復元: 状態どおりに宣言的に組み立てる。位置が範囲外なら適用の前に失敗にする (#789)。
    const rangeError = this.checkRestorePosition(resolution.scene.events, req.state)
    if (rangeError) return this.failEntry(req, rangeError)
    // snapshot のときは、適用の前に storyEnded を直接セットする（重複発火防止 #460。Host.restoreToScene が行う）。
    this.host.restoreToScene(resolution.scene, req.state, req.source === 'snapshot')
    if (req.source === 'save' && req.origin) {
      this.host.notify({ kind: 'loadSuccess', origin: req.origin })
    }
    return { status: 'entered', sceneId: resolution.scene.id }
  }

  /**
   * 新規開始の適用 (#734, ADR 0003 §2・§3 の5・6)。解決できた後・描画の前に、文脈を確定してから組み立てる。
   * flags の置換・confinement の置き換え・`storyEnded = false`・`consecutiveJumps = 0` は、適用の中で
   * 同期に走る先回り終劇（#398）が `confinedSceneIds` を読み、`endStory()` の二重発火ガードが
   * `storyEnded` を見るため、適用より前に済ませる。失敗（解決できなかった）では呼ばれないので、
   * 失敗時は状態を一切変えない。背景等・BGM・立ち絵は持ち越さない（`carryPolicyFor('fresh')`）。
   *
   * @param scene 位置指定（途中局面からの起動）で宣言的復元するときの対象シーン。先頭からなら不要。
   */
  private applyFresh(
    req: Extract<SceneEntryRequest, { kind: 'fresh' }>,
    sceneId: string | null,
    events: readonly Event[],
    scene?: EventScene
  ): SceneEntryResult {
    // 位置指定は適用の前に範囲を判定する (#789)。範囲外なら flags・confinement とも変えずに失敗にする。
    const positioned =
      req.position && scene
        ? { scene, state: buildFreshPositionState(scene.id, req.position, req.flags) }
        : null
    if (positioned) {
      const rangeError = this.checkRestorePosition(positioned.scene.events, positioned.state)
      if (rangeError) return this.failEntry(req, rangeError)
    }

    // 文脈の確定: confinement の置き換え → flags の置換と終劇の解除（Host）→ Jump 連鎖のリセット。
    this._confinedSceneIds = req.confinedSceneIds ?? null
    this.host.applyFreshContext(req.flags ?? {})
    this.transition.resetChain()

    if (positioned) {
      // 途中局面からの起動（`?debug_scene=` の index 指定）: 最小 NovelGameState を共通コアで宣言的復元する。
      // 冒頭からのディレクティブ実行ではなく、位置の指定方法が違うだけで文脈を捨てる意味論は同じ。
      this.host.restoreToScene(positioned.scene, positioned.state, false)
      this.host.notify({ kind: 'sceneChange', sceneId: positioned.scene.id })
      return { status: 'entered', sceneId: positioned.scene.id }
    }

    // エントリ（target 'entry'。sceneId の有無によらず）は警告しない: エディタのライブ再パース等で毎回出てしまう。
    if (
      import.meta.env.DEV &&
      req.target !== 'entry' &&
      sceneId !== null &&
      lacksLeadingBackground(events)
    ) {
      console.warn(
        `[name-name] startFrom: 新規開始の対象シーン "${sceneId}" が最初のテキストまでに [背景:] を持ちません。新規開始は背景を持ち越さないので、背景は地色から始まります。`
      )
    }
    // `linear: true`（動画書き出しの範囲指定が明示的に選ぶ, #777/#817）で、対象がエントリの線形ストリーム上の
    // シーンなら、そのシーンの events だけでなく、ストリーム全体をシーン先頭から流す。シーン末尾で終わらず、
    // 続くシーンまで再生される。ストリームの持ち主はエントリのまま（セーブは sceneId = エントリ + eventIndex
    // で復元できる）。既定（`?scene=` / `?debug_scene=` を含む）は指定シーンの events だけを流して末尾で終劇する。
    if (req.linear && sceneId !== null && sceneId !== this.sceneIndex.getEntrySceneId()) {
      const linearStart = this.sceneIndex.linearStart(sceneId, req.flags)
      if (linearStart !== null) {
        this.startScene(
          this.sceneIndex.getEntrySceneId(),
          this.sceneIndex.getEntryEvents(),
          carryPolicyFor('fresh'),
          {
            startIndex: linearStart.startIndex,
            fromRawIndex: linearStart.rawStart,
            announcedSceneId: sceneId,
          }
        )
        return { status: 'entered', sceneId }
      }
    }
    // 先頭から: 通常入場と同じ経路（冒頭の [背景:]/[BGM:] 等を最初のテキストまで実行し、立ち絵も出す #399）。
    this.startScene(sceneId, events, carryPolicyFor('fresh'))
    return { status: 'entered', sceneId }
  }

  /**
   * 通常の入場でイベント列を流し始め、入ったシーンを知らせる。
   *
   * @param carry 持ち越し方針 (#734)。種類ごとに `carryPolicyFor(kind)` を渡す。
   * @param sceneId ストリームの持ち主の ID（`currentSceneId` に入る）。新規開始の 'entry'（線形ストリームの
   *   先頭）で sceneId を持たないときは null。
   * @param linear 線形ストリームの途中のシーンから始めるとき (#777)。`startIndex` は展開後の位置、`fromRawIndex` は元列での開始位置 (#799)、
   *   `announcedSceneId` は入ったシーン（`onSceneChange` で知らせる ID。持ち主とは別）。
   *   指定が無ければ `sceneId` を知らせる（null なら発火しない）。
   */
  private startScene(
    sceneId: string | null,
    events: readonly Event[],
    carry: { preserveBackgroundForTransition: boolean; carryBgm: boolean },
    linear?: { startIndex: number; fromRawIndex: number; announcedSceneId: string }
  ): void {
    // 終劇状態の解除・currentSceneId の設定・演出のリセットは Host.startEvents が行う。
    // #386: 通常のシーン遷移が成立する経路なので、終劇状態は解除しておく（宣言的整合性の保険）。
    this.host.startEvents(sceneId, events, {
      preserveBackgroundForTransition: carry.preserveBackgroundForTransition,
      carryBgm: carry.carryBgm,
      startIndex: linear?.startIndex,
      fromRawIndex: linear?.fromRawIndex,
    })
    // 線形ストリームの途中のシーンから始めるときは、ストリームの持ち主ではなく入ったシーンを知らせる (#777)。
    const announced = linear ? linear.announcedSceneId : sceneId
    if (announced !== null) this.host.notify({ kind: 'sceneChange', sceneId: announced })
  }

  /**
   * 復元位置を、復元先のイベント列を入場時 flags で展開した後の長さに照らして検証する (#789, #799)。
   * 範囲内なら null、範囲外なら `failEntry` に渡す失敗（out-of-range）を返す。何も変更しない。
   * 展開後で判定するのは、`[条件:]` の真偽で長さが変わり、`eventIndex` は展開後の列を指すため
   * （`restoreToScene` が `entryFromState(state, events)` で展開した列に `applyState` が eventIndex を当てる）。
   * 展開は `restoreToScene` と同じ `expandEvents(events, entryFromState(state, events))`（旧セーブは保存位置に達するまでを静的展開、後ろを逐次評価）。
   */
  private checkRestorePosition(
    events: readonly Event[],
    state: NovelGameState
  ): EntryFailure | null {
    const detail = findRestorePositionError(
      expandEvents(events, entryFromState(state, events)).events,
      { eventIndex: state.eventIndex, textIndex: state.textIndex },
      (event) => {
        const textEvt = getTextEvent(event)
        if (!textEvt) return 1
        // ノベルの改頁数・文単位ページは表示幅や文分割に依存する。ここでは上限を見ない。
        if (this.host.isTextPaginated()) return null
        return Math.max(1, textEvt.text.length)
      }
    )
    return detail === null ? null : { status: 'failed', reason: 'out-of-range', detail }
  }

  private warnEntryFailure(req: SceneEntryRequest, failure: EntryFailure): void {
    const label =
      req.kind === 'progress'
        ? ''
        : req.kind === 'fresh'
          ? 'startFrom: '
          : req.source === 'save'
            ? 'loadFromSaveData: '
            : 'restoreSnapshot: '
    if (failure.error !== undefined) {
      console.warn(`[name-name] ${label}${failure.detail}`, failure.error)
    } else {
      console.warn(`[name-name] ${label}${failure.detail}`)
    }
  }

  /**
   * 入場の失敗 (#734, ADR 0003 §2 の「失敗」列)。位置は動かないので、失敗の種類に応じた通知をしたうえで、
   * 現在位置から遷移状態を導出し直す。
   */
  private failEntry(req: SceneEntryRequest, failure: EntryFailure): SceneEntryResult {
    this.warnEntryFailure(req, failure)
    if (req.kind === 'progress' && req.origin === 'jump') {
      // Jump 由来: Jump の位置で停止する（現状どおり）。再予約すると同じ失敗を繰り返すので導出し直さない。
      this.transition.stall()
    } else {
      if (req.kind === 'restore' && req.source === 'save') {
        // セーブ由来の復元失敗はプレイヤー操作起点の通知 (#765)。flags は適用しない。
        this.host.notify({ kind: 'loadFailure' })
      }
      // 未開始（loadEvents 直後）の index 0 は仮置きなので導出し直さない。
      if (this.cursor.playbackStarted) this.host.rederiveTransition()
    }
    return { status: 'failed', reason: failure.reason }
  }
}
