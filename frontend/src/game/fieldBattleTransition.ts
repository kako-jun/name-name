/**
 * 戦闘の開始・終了の画面遷移の再生 (#830)。RaycastRenderer / TopDownRenderer が 1 つずつ持つ。
 *
 * 時間の計算は純粋関数 `battleTransition.ts`。ここは PixiJS への適用だけを担い、経過時間などの中間状態は
 * このクラスの private（GameState には載せない・ADR 0002）。
 *
 * - 開始 `playEnter`: stage 全体を focus（操作キャラ付近）を中心にズームし、黒い幕を重ねて暗転。真っ暗で `onBlack`（戦闘画面を開く）
 * - 終了 `playExit`: 黒い幕のフェードアウト。真っ暗で `onBlack`（戦闘画面を畳んでフィールドへ戻す）→ 追加画面（任意）→ フェードイン
 * - 演出中は `active`。レンダラーは入力・移動・エンカウントを止める
 */

import { Container, Graphics } from 'pixi.js'
import { PixelateFilter } from 'pixi-filters'
import {
  DEFAULT_BATTLE_TRANSITION_PARAMS,
  sampleEnter,
  sampleExit,
  transitionMosaicSize,
  type BattleTransitionParams,
} from './battleTransition'
import type { BattleOutcome } from './loot'

/** 黒の間に挟める追加画面（戦利品の画面など #831）。`container` は stage に載せられ、`durationMs` の間見える */
export interface BattleInterlude {
  container: Container
  durationMs: number
}

/** 音・追加画面のフック。音自体は呼び出し側（tatenami 側）が鳴らす */
export interface FieldBattleTransitionHooks {
  /** 開始のズーム 1 段ごとの始まり（n = 1, 2, ...）。「ドゥン」の音のきっかけ */
  onTransitionBeat?: (n: number) => void
  /** 戦闘の結果から、黒の間に挟む追加画面を返す。undefined（既定）なら何も挟まない */
  interlude?: (outcome: BattleOutcome) => BattleInterlude | undefined
}

type Run =
  | {
      kind: 'enter'
      elapsed: number
      beats: number
      onBlack: () => void
    }
  | {
      kind: 'exit'
      elapsed: number
      blackFired: boolean
      interlude: BattleInterlude | undefined
      /** 追加画面の長さ（外した後も黒の長さの計算に使う） */
      interludeMs: number
      onBlack: () => void
      onDone: () => void
    }

export class FieldBattleTransition {
  private run: Run | null = null
  private overlay: Graphics | null = null
  /** 幕の濃さに連動するモザイク (#953)。付けている間だけ持つ（stage.filters に入っている自分の分） */
  private mosaic: PixelateFilter | null = null
  private focus: () => { x: number; y: number } = () => ({ x: 0, y: 0 })
  private width = 0
  private height = 0
  hooks: FieldBattleTransitionHooks = {}

  constructor(
    private readonly getStage: () => Container,
    private params: BattleTransitionParams = DEFAULT_BATTLE_TRANSITION_PARAMS
  ) {}

  /** `battle_transition` のモードに応じたパラメータへ差し替える。演出の再生前に呼ぶ（再生中は呼ばない） */
  setParams(params: BattleTransitionParams): void {
    this.params = params
  }

  private get stage(): Container {
    return this.getStage()
  }

  get active(): boolean {
    return this.run !== null
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    if (this.overlay) this.drawOverlay()
  }

  /** 開始の演出。focus はズームの中心（画面座標）。歩いている最中に発火しても追従できるよう毎フレーム問い合わせる */
  playEnter(
    width: number,
    height: number,
    focus: () => { x: number; y: number },
    onBlack: () => void
  ): void {
    this.cancel()
    this.width = width
    this.height = height
    this.focus = focus
    this.ensureOverlay()
    this.run = { kind: 'enter', elapsed: 0, beats: 0, onBlack }
    this.apply()
  }

  /** 終了の演出。onBlack で戦闘画面を畳み、onDone はフェードインが終わったとき */
  playExit(
    width: number,
    height: number,
    outcome: BattleOutcome,
    onBlack: () => void,
    onDone: () => void
  ): void {
    this.cancel()
    this.width = width
    this.height = height
    this.ensureOverlay()
    const interlude = this.hooks.interlude?.(outcome)
    this.run = {
      kind: 'exit',
      elapsed: 0,
      blackFired: false,
      interlude,
      interludeMs: interlude?.durationMs ?? 0,
      onBlack,
      onDone,
    }
    this.apply()
  }

  /** 毎フレーム呼ぶ */
  tick(dtMs: number): void {
    if (!this.run) return
    this.run.elapsed += dtMs
    this.apply()
  }

  /** 演出を捨てて見た目を元に戻す（コールバックは呼ばない）。load() / destroy() 用 */
  cancel(): void {
    const run = this.run
    if (!run && !this.overlay) return
    this.run = null
    this.resetStage()
    this.clearMosaic()
    if (run?.kind === 'exit') this.removeInterlude(run.interlude)
    if (this.overlay) {
      this.stage.removeChild(this.overlay)
      this.overlay.destroy()
      this.overlay = null
    }
  }

  private apply(): void {
    const run = this.run
    if (!run) return
    if (run.kind === 'enter') {
      const s = sampleEnter(run.elapsed, this.params)
      while (run.beats < s.stage) {
        run.beats += 1
        this.hooks.onTransitionBeat?.(run.beats)
      }
      if (this.run !== run) return
      if (s.done) {
        // 真っ暗: 見た目を戻して戦闘画面へ（幕は外す。戦闘画面は stage の最前面に載る）
        this.finish()
        run.onBlack()
        return
      }
      // ズームは stage を拡大する前の位置で測る（pivot/position/scale を一度戻して問い合わせる）
      this.resetStage()
      const f = this.focus()
      this.stage.pivot.set(f.x, f.y)
      this.stage.position.set(f.x, f.y)
      this.stage.scale.set(s.zoom)
      this.setAlpha(s.alpha)
      return
    }
    let s = sampleExit(run.elapsed, this.params, run.interludeMs)
    if (!run.blackFired && (s.phase !== 'fadeOut' || s.done)) {
      // 1 tick が大きくフェードアウトを飛び越えても、戦闘画面を畳む onBlack は必ず 1 回呼ぶ
      run.blackFired = true
      run.onBlack()
      if (this.run !== run) return
      // 戦闘画面が畳まれた分、幕を最前面へ置き直し、その上に追加画面を載せる
      if (this.overlay) this.stage.addChild(this.overlay)
      if (run.interlude) this.stage.addChild(run.interlude.container)
      // 飛び越えた分は黒の延長として扱い、黒（と追加画面）を省略せず見せる
      run.elapsed = Math.min(run.elapsed, this.params.exitFadeOutMs)
      s = sampleExit(run.elapsed, this.params, run.interludeMs)
    }
    if (s.done) {
      this.finish()
      run.onDone()
      return
    }
    // 追加画面は黒の間だけ見せる（フェードインに入ったら外す）
    if (s.phase === 'fadeIn' && run.interlude) {
      this.removeInterlude(run.interlude)
      run.interlude = undefined
    }
    this.setAlpha(s.alpha)
  }

  private finish(): void {
    const run = this.run
    this.run = null
    this.resetStage()
    this.clearMosaic()
    if (run?.kind === 'exit') this.removeInterlude(run.interlude)
    if (this.overlay) {
      this.stage.removeChild(this.overlay)
      this.overlay.destroy()
      this.overlay = null
    }
  }

  private removeInterlude(i: BattleInterlude | undefined): void {
    if (!i) return
    this.stage.removeChild(i.container)
    i.container.destroy({ children: true })
  }

  private resetStage(): void {
    this.stage.pivot.set(0, 0)
    this.stage.position.set(0, 0)
    this.stage.scale.set(1)
  }

  private ensureOverlay(): void {
    if (!this.overlay) {
      this.overlay = new Graphics()
      this.overlay.alpha = 0
    }
    this.drawOverlay()
    this.stage.addChild(this.overlay)
  }

  /** ズーム中は stage ごと拡大されるので、画面の外まで届く大きさで塗る */
  private drawOverlay(): void {
    if (!this.overlay) return
    const w = this.width
    const h = this.height
    this.overlay.clear()
    this.overlay.rect(-w * 4, -h * 4, w * 9, h * 9).fill(0x000000)
  }

  private setAlpha(a: number): void {
    if (this.overlay) this.overlay.alpha = a
    this.applyMosaic(a)
  }

  /** 幕の濃さに連動して size を更新する。size が 2 未満の間・無効（max 0）なら付けない（他のフィルタには触れない） */
  private applyMosaic(alpha: number): void {
    const size = transitionMosaicSize(alpha, this.params.mosaicMaxSize)
    if (this.params.mosaicMaxSize <= 0 || size < 2) {
      this.clearMosaic()
      return
    }
    if (!this.mosaic) {
      const f = new PixelateFilter(1)
      f.resolution = 'inherit'
      this.mosaic = f
      this.stage.filters = [...(this.stage.filters ?? []), f]
    }
    this.mosaic.size = size
  }

  private clearMosaic(): void {
    const f = this.mosaic
    if (!f) return
    this.mosaic = null
    const rest = (this.stage.filters ?? []).filter((x) => x !== f)
    this.stage.filters = rest.length > 0 ? rest : null
    f.destroy()
  }
}
