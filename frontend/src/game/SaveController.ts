import type { FlagValue } from '../types'
import type { BackgroundFade, NovelGameState } from './GameState'
import { getTextEvent } from './eventCursor'
import { gameStateToSaveSlot, resolveSceneTitle, saveSlotToGameState } from './novelLayout'
import type { PlaybackCursor } from './PlaybackCursor'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { LoadOrigin, SceneEntryRequest, SceneEntryResult } from './sceneEntry'
import type { SceneIndex } from './SceneIndex'
import type { TransitionState } from './TransitionState'

/**
 * `SaveController` がレンダラ（ファサード）へ頼む操作 (#827)。セーブ可否の判定・保存内容の組み立て・
 * 自動セーブの保留は SaveController が持ち、「いまの状態を読む」「見せる」「復元の入場を始める」だけをレンダラへ頼む。
 * `applyState` / `restoreToScene` / `getSnapshot` はステージとカーソルを横断する合成なのでレンダラに残る。
 * SaveController は `NovelRenderer` も pixi も import せず、この型だけを見る。
 * メソッド数は8以内に保つ（#735 設計 §6）。
 */
export interface SaveHost {
  /** 現在の状態の完全スナップショット（ADR 0002）。 */
  getSnapshot(): NovelGameState
  /** 終劇状態か (#386)。 */
  isStoryEnded(): boolean
  /** 再生位置のシーン ID（ジャンプ前の線形ストリームでは先頭シーン。セーブのシーン名の解決に使う）。 */
  getPlayheadSceneId(): string | null
  /** トースト表示。 */
  showToast(message: string): void
  /** AudioContext の起動（ユーザー操作より前の自動ロードでも BGM が無音にならないように）。 */
  ensureAudioContext(): void
  /** 背景フェードの正規化（PixiJS を間接参照するので純粋関数に渡す前にレンダラ側で適用する）。 */
  normalizeBackgroundFade(fade: SaveSlotData['backgroundFade']): BackgroundFade | null
  /** 復元の入場（`SceneEntryController.enter`）。 */
  enter(request: SceneEntryRequest): Promise<SceneEntryResult>
}

/** セーブ/ロードメニューの表示面。実体は `SaveLoadOverlay`（レンダラが生成して渡す）。 */
export interface SaveMenuView {
  showSave(onSave: (slot: number) => void): void
  showLoad(onLoad: (data: SaveSlotData) => void): void
}

/**
 * クイックセーブ・自動セーブ・セーブ/ロードメニュー・ロード通知 (#827, #735 6/8)。
 * `autoSavePending`（#768）と `SaveManager` の唯一の持ち主。自動セーブの保留を下ろす（破棄する）のは
 * レンダラの入場・復元の側なので、`discardPendingAutoSave()` を経由する。
 */
export class SaveController {
  /** 保存の実体。セーブキーの名前空間（docKey #578）はこのインスタンスの `setDocKey` で切り替える。 */
  readonly saveManager: SaveManager = new SaveManager()

  /**
   * シーン入場後の自動セーブが保留中か (#768)。`requestAutoSave()` で立て、そのシーンで最初の本文が
   * 表示されゲートが開いた時点（`flushAutoSave`）で1回保存して下ろす。新しい入場・復元で破棄する。
   */
  private autoSavePending = false

  private menu: SaveMenuView | null = null

  constructor(
    private readonly host: SaveHost,
    private readonly sceneIndex: SceneIndex,
    private readonly transition: TransitionState,
    private readonly cursor: PlaybackCursor
  ) {}

  /** メニューの表示面を結ぶ。オーバーレイは `SaveManager` を共有して生成されるため、生成後に渡す。 */
  attachMenu(menu: SaveMenuView): void {
    this.menu = menu
  }

  /** 保留中の自動セーブを破棄する（新しい入場・復元・新規開始で呼ぶ #768）。 */
  discardPendingAutoSave(): void {
    this.autoSavePending = false
  }

  /**
   * 現在のゲーム状態をクイックセーブスロットに保存する。
   * 選択肢・Wait 待機中・終劇後は保存しない（不整合状態を避けるため）。
   *
   * 終劇後 (#386) を除外する理由: `endStory()` は `waitingForChoice` を false に戻すため
   * その条件だけでは終劇後のセーブを防げない。また `SaveSlotData`/`saveSlotToGameState` は
   * 意図的に `storyEnded` を保存しない設計（常に false で復元）なので、もし終劇後の
   * eventIndex（圏外 choice に到達したまま止まっている位置）でセーブを許すと、ロード時に
   * 「storyEnded=false なのに Choice イベント位置で止まっている」行き止まり（テキストも
   * 選択肢も "to be continued..." も出ない空白画面）になる。
   * 成功したら true、保存できない状態なら false を返す。
   *
   * sceneId が null の局面（シーン索引を使わない線形ストリーム〔`loadEvents`〕でジャンプ前）でも
   * セーブできる。null は「エントリ文書の線形ストリーム上の位置」を意味し、ロード側が eventIndex で
   * 復元する (#768)。
   */
  quickSave(): boolean {
    // 手動（F5）専用。自動セーブは requestAutoSave() → saveQuick('auto') だけが行う (#769, #768)。
    return this.saveQuick('quick')
  }

  /**
   * シーン入場の自動セーブを要求する (#768)。NovelPlayer の `onSceneChange` から呼ぶ。保存はこの時点では行わず、
   * そのシーンの最初の本文が表示されゲートが開いた時点で1回行う。シーン冒頭が `[待機]`・Jump・選択肢でも
   * 同じ仕組みで扱える（入場直後は待機中などでゲートが閉じているため、入場の瞬間に保存すると黙って弾かれる）。
   * 保存位置は「その本文の位置」で、宣言的復元は待機を再実行しないので、ロードすると待機を挟まずその本文から
   * 再開できる。冒頭が Jump だけの中継シーンは本文が無いので保存されず、遷移先の本文で保存される。
   * 次の入場・復元・新規開始・はじめからで保留は破棄される。
   */
  requestAutoSave(): void {
    this.autoSavePending = true
    this.flushAutoSave()
  }

  /** 保留中の自動セーブを、現在位置が本文でゲートが開いていれば実行して下ろす (#768)。 */
  flushAutoSave(): void {
    if (!this.autoSavePending) return
    if (
      this.host.isStoryEnded() ||
      !getTextEvent(this.cursor.resolvedEvents[this.cursor.eventIndex])
    )
      return
    if (this.transition.gateReason('quickSave') !== null) return
    this.autoSavePending = false
    this.saveQuick('auto')
  }

  private saveQuick(origin: 'quick' | 'auto'): boolean {
    // 結果のトースト（成功・弾かれた理由）はここで出す (#769。ロードの #765 と対称)。手動（F5）のみ通知し、
    // 自動セーブ（`onSceneChange` 経由の 'auto'）は無言。
    if (this.host.isStoryEnded()) {
      if (origin === 'quick') this.host.showToast('この場面ではセーブできません')
      return false
    }
    // 選択肢・待機・Jump 待機中・停止中 (#725)・入場中 (#734): 遷移途中・停止位置をセーブに残さない
    // （openSaveMenu と同じ理由）。文言の振り分けはロード側（quickLoad）と同じ。
    const blocked = this.transition.gateReason('quickSave')
    if (blocked) {
      if (origin === 'quick') {
        this.host.showToast(
          blocked === 'jump' || blocked === 'entry'
            ? '場面転換中のためセーブできません'
            : 'この場面ではセーブできません'
        )
      }
      return false
    }

    const data = gameStateToSaveSlot(this.host.getSnapshot(), {
      slot: -1, // クイックセーブはスロット番号不使用
      savedAt: new Date().toISOString(),
      sceneName: this.resolvePlayheadSceneTitle(),
    })
    this.saveManager.quickSave(data)
    if (origin === 'quick') this.host.showToast('クイックセーブしました')
    return true
  }

  /**
   * クイックセーブスロットからゲーム状態を復元する。
   * 選択肢・Wait 待機中はロードしない（不整合状態を避けるため）。
   * 復元の入場（`SceneEntryController.enter` の restore）の結果を Promise で返す (#734)。null は、クイックセーブデータが
   * 無いか、ゲートで弾かれた場合（入場を始めていない）。トーストは入場の結末（成功・失敗）で出る (#765)。
   */
  quickLoad(origin: 'quick' | 'auto' = 'quick'): Promise<SceneEntryResult | null> {
    const blocked = this.transition.gateReason('navigate')
    if (blocked) {
      // 弾かれた理由に合った通知を出す（手動 F8 のみ。マウント時の自動ロード〔auto〕は
      // 弾かれた理由のトーストを出さない。ロード自体が失敗したときの「ロードに失敗しました」は auto でも出す〔notifyLoadFailure〕）(#765)。
      if (origin === 'quick') {
        this.host.showToast(
          blocked === 'jump' || blocked === 'entry'
            ? '場面転換中のためロードできません'
            : 'この場面ではロードできません'
        )
      }
      return Promise.resolve(null)
    }
    const data = this.saveManager.quickLoad()
    if (!data) {
      if (origin === 'quick') this.host.showToast('クイックセーブデータがありません')
      return Promise.resolve(null)
    }
    return this.loadFromSaveData(data, origin)
  }

  /**
   * クイックセーブの flags を返す（データが無ければ null）。マウント時の自動クイックロードが失敗したとき、
   * 位置は失っても進めたルートの flags は保ってエントリから始めるために使う (#734, ADR 0003 §5)。
   */
  getQuickSaveFlags(): Record<string, FlagValue> | null {
    return this.saveManager.quickLoad()?.flags ?? null
  }

  /** クイックセーブデータが存在するか返す。 */
  hasQuickSave(): boolean {
    return this.saveManager.hasQuickSave()
  }

  /**
   * クイックセーブデータを消去する (#637)。
   * 「はじめから」（`PlayerScreen.onNewGame`）等、直前のセッションのクイックセーブを完全に
   * 無効化したい場面で使う。新規開始後は自動セーブが走るまで（loadEvents 構成では最初のシーン境界・ジャンプまで）旧セーブが残るため、
   * それまでの間にリロードされると旧クイックセーブがそのまま復元されてしまう。
   * 呼び出し側が明示的にこれを呼び、リロード時に旧セーブが復活しないことを保証する。
   */
  clearQuickSave(): void {
    this.saveManager.deleteQuickSave()
  }

  /**
   * セーブメニューを表示する。
   * 終劇後 (#386) はメニュー自体を開かない。理由は quickSave() の doc コメント参照
   * （SaveSlotData は storyEnded を持たないため、終劇後のセーブは行き止まりの原因になる）。
   */
  openSaveMenu(): void {
    if (this.host.isStoryEnded()) return
    // Jump 待機中・停止中 (#725)・入場中 (#734) は開かない。遷移途中・停止位置をセーブに残さない
    // （ロードのたびに再予約・警告・停止を繰り返す状態を避ける。復元側は #733 で再予約するので
    // 行き止まりにはならないが、保存する価値のある位置ではない）。
    if (this.transition.isGated('saveMenu')) return
    this.menu?.showSave((slot: number) => {
      // オーバーレイ表示中も autoTimer / skipTimer / [待機] は進み、裏で Jump が予約・停止し得る。
      // 開く時だけでなく確定時にも再確認する (#759)。
      if (this.transition.isGated('saveMenu')) {
        // オーバーレイは確定後に必ず閉じるので、無通知だと保存されたと誤認する。
        this.host.showToast('場面転換中のためセーブできません')
        return
      }
      const data = gameStateToSaveSlot(this.host.getSnapshot(), {
        slot,
        savedAt: new Date().toISOString(),
        sceneName: this.resolvePlayheadSceneTitle(),
      })
      this.saveManager.save(slot, data)
    })
  }

  /** ロードメニューを表示する。 */
  openLoadMenu(): void {
    // Jump 遷移の予約中 (#733)・入場中 (#734) は quickLoad と同じく開かない（遷移途中に別の位置へ復元させない）。
    if (this.transition.isGated('loadMenu')) return
    this.menu?.showLoad((data: SaveSlotData) => {
      // 表示中に裏で遷移が始まった場合は復元させない（開く時だけでなく確定時にも再確認 #759）。
      if (this.transition.isGated('loadMenu')) {
        this.host.showToast('場面転換中のためロードできません')
        return
      }
      void this.loadFromSaveData(data, 'menu')
    })
  }

  /**
   * セーブデータからゲーム状態を復元する（applyState ベースの宣言的復元）
   *
   * #578 再発修正: restoreSnapshot（#460）と同じ「hub(entry doc) + ルート別 md」問題が
   * quickLoad() 経由でも起きる。起動直後の自動 quickLoad は allScenes
   * にまだ entry doc 分のシーンしか無い状態で呼ばれ得るため、ルート内シーンをセーブして
   * いた場合に findSceneById が不発になり、常にフラグのみ復元＋warn のフォールバックへ
   * 縮退して意図したシーン位置に戻れない。restoreSnapshot と同じく missingSceneResolver
   * 経由の非同期再解決を挟んでから復元する。
   *
   * #578 セルフレビュー must 対応: ensureContext() をここで呼ぶ。起動時自動 quickLoad
   * （NovelPlayer のマウント effect から `renderer.hasQuickSave()` が true の場合に同期呼び出しされる）は
   * ユーザー操作より前に quickLoad() → loadFromSaveData() が走る。ensureContext() を呼ばないと AudioManager.ctx が
   * null のままで、この後 applyState 経由の playBgm() が `if (!this.ctx) return` で無音のまま
   * 早期 return し、以後ユーザーが操作しても currentBgmUrl 未設定のため再試行されない
   * （復元先シーンの BGM が次のシーン遷移までサイレントになる回帰）。restoreSnapshot（#460）と
   * 同じ対処であり、ensureContext() はべき等なので通常の openLoadMenu 経由（既に
   * ensureContext 済み）で重複呼び出しになっても副作用はない。
   */
  loadFromSaveData(data: SaveSlotData, origin: LoadOrigin): Promise<SceneEntryResult> {
    this.host.ensureAudioContext()

    // SaveSlotData → NovelGameState のフィールド対応・後方互換フォールバックは
    // novelLayout.saveSlotToGameState に集約 (#260)。fade だけは PixiJS を間接参照する
    // normalizeBackgroundFade をここで適用し、純粋関数には正規化済みの値を渡す。
    // シーンの引き当て・遅延ロード（マルチMD構成 #578）・失敗時の通知は、単一の入口（SceneEntryController.enter）に任せる。
    // 失敗（解決手段が無い・resolver が null/例外・ロード後も不在）は位置・flags とも現状維持（#765）。
    const state = saveSlotToGameState(data, this.host.normalizeBackgroundFade(data.backgroundFade))
    return this.host.enter({ kind: 'restore', state, source: 'save', origin })
  }

  /**
   * ロード失敗（復元先シーンを解決できない）のプレイヤー通知 (#765)。同期・非同期とも即時に出す。
   * 成功トーストは restoreToScene が実際に成功した時点で出す（notifyLoadSuccess）ので、
   * 失敗通知が成功通知に先行・上書きされることはない。マウント時の自動ロードも、続きを期待している
   * 場面なので失敗は通知する。
   */
  notifyLoadFailure(): void {
    this.host.showToast('ロードに失敗しました')
  }

  /**
   * ロード成功の通知 (#765)。クイックロード（F8）だけ「クイックロードしました」を出す。
   * ロードメニューは確定後にオーバーレイが閉じて結果が見えるため出さず（従来どおり）、
   * マウント時の自動クイックロードも出さない。
   */
  notifyLoadSuccess(origin: LoadOrigin): void {
    if (origin === 'quick') this.host.showToast('クイックロードしました')
  }

  /** 再生位置のシーンタイトル（sceneId ガード + find + ?.title ?? null は novelLayout.resolveSceneTitle に集約 #260）。 */
  private resolvePlayheadSceneTitle(): string | null {
    return resolveSceneTitle(this.sceneIndex.getScenes(), this.host.getPlayheadSceneId())
  }
}
