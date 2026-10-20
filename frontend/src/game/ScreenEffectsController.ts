import { Container, Graphics } from 'pixi.js'
import type { FlashArea } from '../types'
import type { NovelGameState } from './GameState'
import type { LayoutRect } from './novelLayout'
import { parseHexColor } from './novelLayout'
import {
  computeFadeAlpha,
  computeFlashAreaRect,
  computeShakeOffset,
  computeStrobeFlashAlpha,
} from './screenEffects'
import type { TimeController } from './TimeController'

/**
 * novel スタイル (#283) のセリフ表示中スクリム不透明度。
 * ToHeart 式に背景・立ち絵を半分ほど沈め、白文字 + DropShadow の可読性を上げる。
 * blink/A-B 実機検証で詰める前提の初期値（テストが参照できるよう export する）。
 */
export const NOVEL_SCRIM_ALPHA = 0.5

/** novel スクリムの自動退避フェード時間（ms）。表情変化・場面転換で絵を見せるための退避/復帰 (#283)。 */
export const NOVEL_SCRIM_RETREAT_MS = 220

/** novel スクリム退避後、絵を見せたまま保持する時間（ms）。退避→ホールド→復帰の中段 (#283)。 */
export const NOVEL_SCRIM_HOLD_MS = 500

/** novel スクリムの通常表示/非表示フェード時間（ms）。ページ送り時の明暗ジャンプを抑える。 */
export const NOVEL_SCRIM_VISIBILITY_FADE_MS = 180

/**
 * `ScreenEffectsController` がレンダラ（ファサード）へ頼む読み書き (#828 7b)。画面効果は状態と更新を自分で持ち、
 * 「レンダラだけが知っている値・触れない相手」だけを Host 越しに頼む。`NovelRenderer` も他モジュールも import しない。
 * メソッド数は8以内に保つ（#735 設計 §6）。
 */
export interface ScreenEffectsHost {
  /** 画面サイズ（construct 時に固定）。 */
  getScreenSize(): { width: number; height: number }
  /** 揺れ演出が動かす stage の位置。stage は Application が持つのでレンダラ越しに設定する。 */
  setStagePosition(x: number, y: number): void
  /** novel スタイルか（スクリムは novel のときだけ敷く）。 */
  isNovelStyle(): boolean
  /** スクリム退避中に本文ダイアログの alpha を一緒に動かす。退避の中断・復元時は 1 に戻す。 */
  setDialogAlpha(alpha: number): void
  /** 暗転中は SeekBar を隠す（可視性ゲートの同期先）。 */
  setSeekBarBlackoutHidden(hidden: boolean): void
}

/**
 * 画面効果（揺れ・フラッシュ・フェード・暗転・novel スクリム）の状態と更新 (#828 7b, #735 7/8 の第2段)。
 *
 * 次のフィールドの唯一の書き手: `effectOverlay` / `shakeTimer` / `shakeStartMs` / `effectTimer` / `novelScrim` /
 * `scrimRetreatActive` / `scrimRetreatTimer` / `scrimVisibilityTimer` / `blackoutOverlay`。
 * `getSnapshot()` / `applyState` の演出フィールドのうちここが持つのは暗転（`isBlackout`）だけで、`capture()` /
 * `restore()` で出し入れする。揺れ・フラッシュ・フェード・スクリム退避の中間状態は GameState に持たない（ADR 0002）。
 *
 * 呼び出し側がどの時点で何を止めるか（`resetAndStartEvents` の順序、`applyState` / `endStory` / `destroy` での
 * 止め方の差）は複数モジュールをまたぐ判断なので、レンダラが決める。ここは `reset` / `destroy` 等の部品だけを持つ。
 * Pixi は演出側として使うが、`NovelRenderer` は import しない（Host 越しのみ）。
 */
export class ScreenEffectsController {
  /** 暗転オーバーレイ。fill と z 順は `attachTo` で決まる。 */
  readonly blackoutOverlay: Graphics = new Graphics()

  /** novel スタイル (#283) の全画面スクリム。セリフ表示中だけ半透明黒を敷く。
   *  z 順は立ち絵の上・blackoutOverlay の下。adv では常に visible=false。`attachTo`（init）まで null。 */
  private novelScrim: Graphics | null = null

  // ---- 画面効果 (#143) ----
  /** flash/fade 用全画面オーバーレイ Graphics。`attachTo`（init）まで null。 */
  private effectOverlay: Graphics | null = null
  /** shake アニメーション用タイマー */
  private shakeTimer: number | null = null
  /** shake 開始時刻（ms） */
  private shakeStartMs: number = 0
  /** flash/fade アニメーション用タイマー */
  private effectTimer: number | null = null

  // ---- novel スクリム自動退避 (#283) ----
  /** スクリム退避フェード中フラグ。true の間は updateNovelScrim が触らない（フェードが制御） */
  private scrimRetreatActive = false
  /** スクリム退避フェード用タイマー */
  private scrimRetreatTimer: number | null = null
  /** スクリム通常表示/非表示フェード用タイマー */
  private scrimVisibilityTimer: number | null = null

  constructor(
    private readonly host: ScreenEffectsHost,
    private readonly time: TimeController
  ) {}

  // --- 組み立て・状態の出し入れ ---

  /**
   * スクリム → 暗転 → 画面効果オーバーレイの順に作ってステージに積む（`NovelRenderer.init`）。
   * 3枚は連続して積み、間にほかのレイヤーを挟まない（z 順: 立ち絵の上・ダイアログの下）。
   * 画面効果オーバーレイの fill 色は startFlash/startFade で毎回 clear() → fill(color) し直すため初期値は任意。
   */
  attachTo(stage: Container): void {
    const { width, height } = this.host.getScreenSize()

    // novel スタイルの全画面スクリム (#283)。セリフ表示中だけ半透明黒を敷き、白文字の可読性を上げつつ
    // ToHeart 的な「絵を薄く沈める」見え方にする。adv では常に非表示。
    this.novelScrim = new Graphics()
    this.novelScrim.rect(0, 0, width, height)
    this.novelScrim.fill(0x000000)
    this.novelScrim.alpha = 0
    this.novelScrim.visible = false
    stage.addChild(this.novelScrim)

    // 暗転レイヤー
    this.blackoutOverlay.rect(0, 0, width, height)
    this.blackoutOverlay.fill(0x000000)
    this.setBlackout(false)
    stage.addChild(this.blackoutOverlay)

    // 画面効果オーバーレイ（#143: flash/fade — blackout より上、dialog より下）
    this.effectOverlay = new Graphics()
    this.effectOverlay.rect(0, 0, width, height)
    this.effectOverlay.fill(0x000000)
    this.effectOverlay.alpha = 0
    this.effectOverlay.visible = false
    stage.addChild(this.effectOverlay)
  }

  /** `getSnapshot()` の演出部分（宣言的に確定した値＝暗転のみ。揺れ・フラッシュ・フェード・スクリムは含まない）。 */
  capture(): Pick<NovelGameState, 'isBlackout'> {
    return { isBlackout: this.blackoutOverlay.visible }
  }

  /** `applyState` の演出部分（暗転）。画面効果・スクリム退避の中間状態の停止は呼び出し側が先に `reset` 等で行う。 */
  restore(state: Pick<NovelGameState, 'isBlackout'>): void {
    this.setBlackout(state.isBlackout)
  }

  // --- 暗転 ---

  /**
   * 暗転オーバーレイの表示を切り替え、SeekBar の可視ゲートと同期する (#350)。
   * 暗転中はスライダを隠す（z 順は変えず可視性ゲートで対処し、黒の上に薄いスライダ線が残らない）。
   * active も SeekBar 側で解除する。GameState の永続 isBlackout から導出する transient な見た目同期で、
   * 適用/解除/復元（processDirective / restoreToScene / applyState）すべてこの 1 経路に集約する。
   */
  setBlackout(visible: boolean): void {
    this.blackoutOverlay.visible = visible
    this.host.setSeekBarBlackoutHidden(visible)
  }

  // --- 画面効果の停止・後始末 ---

  /**
   * 揺れ・フラッシュ/フェードのタイマーを止め、オーバーレイを消す。stage の位置は戻さない
   * （`resetAndStartEvents` と同じ。位置まで戻すなら `resetStagePosition` を併用する）。
   */
  reset(): void {
    this.stopShakeTimer()
    this.stopEffectTimer()
    this.hideEffectOverlay()
  }

  /** 揺れで動かした stage を原点へ戻す。`applyState` / `endStory` の後始末（シーク・終劇で揺れを残さない）。 */
  resetStagePosition(): void {
    this.host.setStagePosition(0, 0)
  }

  /** フラッシュ/フェード用オーバーレイだけを消す（タイマーには触らない。intermission タブロー描画前の掃除）。 */
  hideEffectOverlay(): void {
    if (this.effectOverlay) {
      this.effectOverlay.alpha = 0
      this.effectOverlay.visible = false
    }
  }

  /** `destroy()` の部品。画面効果・スクリム退避・スクリム通常フェードのタイマーをすべて止める。 */
  stopAllTimers(): void {
    this.stopShakeTimer()
    this.stopEffectTimer()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.cancelNovelScrimVisibilityFade()
  }

  private stopShakeTimer(): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
  }

  private stopEffectTimer(): void {
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
  }

  // --- 終劇の黒フェード ---

  /**
   * 終劇専用の黒フェード。
   *
   * endStory() では背景・立ち絵・イベント絵を最終的に消すが、イベント絵が出ている状態で
   * 先に eventImageLayer.remove() すると背面が戻ってしまう。eventImageLayer より上の
   * effectOverlay を黒へフェードし、黒で覆い切った後に後始末する。
   */
  startEndStoryBlackoutFade(durationMs: number, onComplete: () => void): void {
    if (!this.effectOverlay) {
      onComplete()
      return
    }
    this.stopEffectTimer()

    const { width, height } = this.host.getScreenSize()
    this.effectOverlay.clear()
    this.effectOverlay.rect(0, 0, width, height)
    this.effectOverlay.fill(0x000000)
    this.effectOverlay.alpha = durationMs > 0 ? 0 : 1
    this.effectOverlay.visible = true

    if (durationMs <= 0) {
      onComplete()
      return
    }

    const startMs = this.time.now()
    const FPS = 60
    const intervalMs = 1000 / FPS

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = this.time.now() - startMs
      if (!this.effectOverlay) return
      const { alpha, done } = computeFadeAlpha(elapsed, 0, 1, durationMs)
      this.effectOverlay.alpha = alpha
      if (done) {
        this.effectOverlay.alpha = 1
        this.stopEffectTimer()
        onComplete()
      }
    }, intervalMs)
  }

  // --- 揺れ・フラッシュ・フェード (#143) ---
  // 16進カラーパース parseHexColor は novelLayout に切り出した (#260)

  /**
   * 画面シェイク演出 (#143)。
   * sin 波ベースの決定論的な揺れ。stage の position を直接動かして実現する。
   */
  startShake(intensityPx: number, durationMs: number): void {
    this.stopShakeTimer()
    this.shakeStartMs = performance.now()

    const FPS = 60
    const intervalMs = 1000 / FPS

    const tick = (): void => {
      const elapsed = performance.now() - this.shakeStartMs
      // 減衰 sin/cos 揺れの数式は screenEffects.computeShakeOffset に集約 (#260)
      const { offsetX, offsetY, done } = computeShakeOffset(elapsed, intensityPx, durationMs)
      this.host.setStagePosition(offsetX, offsetY)

      if (!done) {
        this.shakeTimer = this.time.setTimeout(tick, intervalMs)
      } else {
        this.host.setStagePosition(0, 0)
        this.shakeTimer = null
      }
    }
    tick()
  }

  /**
   * フラッシュ演出 (#143)。エリア限定・ストロボ拡張 (#693)。
   * effectOverlay を指定色で alpha ピーク → 0 にフェードアウトする。
   * `area` 指定時はオーバーレイの矩形をその範囲に限定する（`null` は全画面、後方互換）。
   * `strobe` > 1 のときは `intervalMs` 間隔で同じパルスを繰り返す（`computeStrobeFlashAlpha`）。
   */
  startFlash(
    colorHex: string,
    peakAlpha: number,
    durationMs: number,
    area: FlashArea | null,
    strobeCount: number,
    intervalMs: number | null
  ): void {
    if (!this.effectOverlay) return
    this.stopEffectTimer()

    const color = parseHexColor(colorHex)
    // エリア限定矩形は screenEffects.computeFlashAreaRect に集約 (#693)。area なしは全画面。
    const { width, height } = this.host.getScreenSize()
    const rect = computeFlashAreaRect(area, width, height)
    this.effectOverlay.clear()
    this.effectOverlay.rect(rect.x, rect.y, rect.width, rect.height)
    this.effectOverlay.fill(color)
    this.effectOverlay.alpha = peakAlpha
    this.effectOverlay.visible = true

    const startMs = performance.now()
    const FPS = 60
    const intervalMsTick = 1000 / FPS
    // interval 省略時は duration と同程度の適当なデフォルト（Issue #693 方針）。
    const effectivePulseIntervalMs = intervalMs ?? durationMs

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      if (!this.effectOverlay) return
      // alpha 補間は screenEffects.computeStrobeFlashAlpha に集約 (#260/#693)。
      // strobeCount<=1 のときは computeFlashAlpha と完全に同じ結果になる（後方互換）。
      const { alpha, done } = computeStrobeFlashAlpha(
        elapsed,
        peakAlpha,
        durationMs,
        strobeCount,
        effectivePulseIntervalMs
      )
      this.effectOverlay.alpha = alpha
      if (done) {
        this.effectOverlay.visible = false
        this.effectOverlay.alpha = 0
        this.stopEffectTimer()
      }
    }, intervalMsTick)
  }

  /**
   * フェード演出 (#143)。
   * effectOverlay を指定色・指定アルファ範囲で補間する。
   * target: "bg"（背景のみ）は将来拡張。現状は "all" と同じ全画面オーバーレイ。
   */
  startFade(
    _target: string,
    colorHex: string,
    fromAlpha: number,
    toAlpha: number,
    durationMs: number
  ): void {
    if (!this.effectOverlay) return
    this.stopEffectTimer()

    const color = parseHexColor(colorHex)
    const { width, height } = this.host.getScreenSize()
    this.effectOverlay.clear()
    this.effectOverlay.rect(0, 0, width, height)
    this.effectOverlay.fill(color)
    this.effectOverlay.alpha = fromAlpha
    this.effectOverlay.visible = true

    const startMs = performance.now()
    const FPS = 60
    const intervalMs = 1000 / FPS

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      if (!this.effectOverlay) return
      // alpha 補間は screenEffects.computeFadeAlpha に集約 (#260)。
      // done 時に alpha=toAlpha ちょうどを返すので、従来の「progress>=1 で toAlpha を当て直す」挙動と一致。
      const { alpha, done } = computeFadeAlpha(elapsed, fromAlpha, toAlpha, durationMs)
      this.effectOverlay.alpha = alpha
      if (done) {
        // toAlpha が 0 なら不可視に戻す
        if (toAlpha <= 0) {
          this.effectOverlay.visible = false
        }
        this.stopEffectTimer()
      }
    }, intervalMs)
  }

  // --- novel スクリム (#283) ---

  /**
   * novel スクリムの表示状態を「セリフ表示中か」に合わせて更新する (#283)。
   * adv では no-op。退避フェード中（scrimRetreatActive）は触らない（フェードが制御する）。
   * 通常のページ/イベント送りでは短くフェードさせ、立ち絵切替時の明暗ジャンプを抑える。
   */
  updateNovelScrim(visibleForDialog: boolean): void {
    if (!this.novelScrim) return
    if (!this.host.isNovelStyle()) {
      this.setNovelScrimImmediate(false, 0)
      return
    }
    if (this.scrimRetreatActive) return
    this.startNovelScrimVisibilityFade(visibleForDialog)
  }

  /** スクリム退避フェード（表情変化・場面転換）の最中か。立ち絵の遷移待ち判定（`isTransitionSettled`）が見る。 */
  isScrimRetreatActive(): boolean {
    return this.scrimRetreatActive
  }

  /** adv へ戻すときのスクリム消灯。スクリム未生成（init 前）なら何もしない。 */
  hideNovelScrim(): void {
    this.setNovelScrimImmediate(false, 0)
  }

  private cancelNovelScrimVisibilityFade(): void {
    if (!this.scrimVisibilityTimer) return
    this.time.clearInterval(this.scrimVisibilityTimer)
    this.scrimVisibilityTimer = null
  }

  private startNovelScrimVisibilityFade(visibleForDialog: boolean): void {
    if (!this.novelScrim) return
    this.cancelNovelScrimVisibilityFade()
    const targetAlpha = visibleForDialog ? NOVEL_SCRIM_ALPHA : 0
    const fromAlpha = this.novelScrim.visible ? this.novelScrim.alpha : 0
    if (fromAlpha === targetAlpha) {
      this.novelScrim.visible = visibleForDialog
      this.novelScrim.alpha = targetAlpha
      return
    }
    this.novelScrim.visible = true
    const durationMs = NOVEL_SCRIM_VISIBILITY_FADE_MS
    const startedAt = this.time.now()
    const tick = () => {
      if (!this.novelScrim) return
      const elapsed = this.time.now() - startedAt
      const { alpha, done } = computeFadeAlpha(elapsed, fromAlpha, targetAlpha, durationMs)
      this.novelScrim.alpha = alpha
      if (!done) return
      this.novelScrim.alpha = targetAlpha
      this.novelScrim.visible = visibleForDialog
      this.cancelNovelScrimVisibilityFade()
    }
    tick()
    if (!this.scrimVisibilityTimer) {
      this.scrimVisibilityTimer = this.time.setInterval(tick, 1000 / 60)
    }
  }

  private setNovelScrimImmediate(visible: boolean, alpha: number): void {
    if (!this.novelScrim) return
    this.cancelNovelScrimVisibilityFade()
    this.novelScrim.visible = visible
    this.novelScrim.alpha = alpha
  }

  /**
   * novel スクリム退避の途中状態をリセットする (#283)。
   * シーン遷移・状態復元・破棄で退避フェードのタイマーを止め、文字 alpha を元に戻す。
   * 退避中間状態（フェード途中）は GameState に持たないため、復元では「退避していない」前提に倒す。
   */
  resetNovelScrimState(): void {
    this.cancelNovelScrimVisibilityFade()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.scrimRetreatActive = false
    this.host.setDialogAlpha(1)
    this.setNovelScrimImmediate(false, 0)
  }

  /**
   * novel スクリム自動退避 (#283)。
   *
   * 表情変化 / 場面転換のとき、スクリム（とその上の白文字）を一旦 α→0 へ滑らかに退避して
   * 絵を見せ、`holdMs` 後に元の不透明度へ戻す。エンジン自動（作者は記述不要）。
   * adv では no-op。セリフ非表示中（スクリムが既に消えている）も no-op。
   *
   * 退避中は `scrimRetreatActive=true` にして updateNovelScrim が触らないようにする。
   * フェード計算は screenEffects.computeFadeAlpha を流用（演出中間状態は GameState に持たない）。
   */
  retreatNovelScrim(holdMs = NOVEL_SCRIM_HOLD_MS): void {
    if (!this.host.isNovelStyle() || !this.novelScrim) return
    // セリフが表示されておらずスクリムが既に消えているなら退避不要。
    if (!this.novelScrim.visible || this.novelScrim.alpha <= 0) return

    this.cancelNovelScrimVisibilityFade()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.scrimRetreatActive = true
    const FPS = 60
    const intervalMs = 1000 / FPS
    const durationMs = NOVEL_SCRIM_RETREAT_MS

    // フェーズ: 0 = 退避(α: ALPHA→0)、1 = ホールド、2 = 復帰(α: 0→ALPHA)
    let phase: 0 | 1 | 2 = 0
    let phaseStart = performance.now()

    this.scrimRetreatTimer = this.time.setInterval(() => {
      if (!this.novelScrim) return
      const elapsed = performance.now() - phaseStart
      if (phase === 0) {
        const { alpha, done } = computeFadeAlpha(elapsed, NOVEL_SCRIM_ALPHA, 0, durationMs)
        this.novelScrim.alpha = alpha
        this.host.setDialogAlpha(1 - (NOVEL_SCRIM_ALPHA - alpha) / NOVEL_SCRIM_ALPHA) // 文字も一緒に退避
        if (done) {
          this.novelScrim.alpha = 0
          this.host.setDialogAlpha(0)
          phase = 1
          phaseStart = performance.now()
        }
      } else if (phase === 1) {
        if (elapsed >= holdMs) {
          phase = 2
          phaseStart = performance.now()
        }
      } else {
        const { alpha, done } = computeFadeAlpha(elapsed, 0, NOVEL_SCRIM_ALPHA, durationMs)
        this.novelScrim.alpha = alpha
        this.host.setDialogAlpha(alpha / NOVEL_SCRIM_ALPHA)
        if (done) {
          this.novelScrim.alpha = NOVEL_SCRIM_ALPHA
          this.host.setDialogAlpha(1)
          if (this.scrimRetreatTimer) {
            this.time.clearInterval(this.scrimRetreatTimer)
            this.scrimRetreatTimer = null
          }
          this.scrimRetreatActive = false
        }
      }
    }, intervalMs)
  }

  /**
   * novelScrim の矩形を split_layout のテキスト領域に絞る (#442 self-review must-2)。
   * `novelScrim` は init() 完了後にしか存在しない（コンストラクタでは未生成）ため、
   * まだ無ければ何もしない（次に applySplitLayout が呼ばれた時点で改めて適用される）。
   */
  applyNovelScrimRegion(region: LayoutRect): void {
    if (!this.novelScrim) return
    this.novelScrim.clear()
    this.novelScrim.rect(region.x, region.y, region.width, region.height)
    this.novelScrim.fill(0x000000)
  }

  /** novelScrim の矩形を画面全体に戻す (#442 self-review must-2)。split_layout 無効時の従来どおり。 */
  resetNovelScrimRegion(): void {
    if (!this.novelScrim) return
    const { width, height } = this.host.getScreenSize()
    this.novelScrim.clear()
    this.novelScrim.rect(0, 0, width, height)
    this.novelScrim.fill(0x000000)
  }
}
