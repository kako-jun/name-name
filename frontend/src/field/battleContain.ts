/**
 * 論理サイズ固定の戦闘 (sit-by-me#52) の「16:9 を viewport へ等比 contain」の付け外し。
 * 戦闘開始で `body.battle-contain`（ツールバー等を隠し、`#stage` を viewport いっぱいに固定する CSS）を付け、
 * canvas の表示寸法を `containRect`（crop しない等比 contain）で求めた px にする。終了・dispose・例外のどれでも `leave` で元に戻す。
 * `dvh` に頼らず JS で viewport 寸法（`innerWidth/innerHeight`）を読むので、古いブラウザでも同じ結果になる。
 */
import { containRect } from '../game/battleLogicalSize'

export interface ContainTargets {
  body: { classList: { toggle(name: string, force?: boolean): boolean } }
  canvas: { style: CSSStyleDeclaration }
  /** 現在の viewport の大きさ（CSS px） */
  viewport(): { w: number; h: number }
  /** resize の購読。解除関数を返す */
  onResize(cb: () => void): () => void
}

export class BattleContain {
  private size: { w: number; h: number } | null = null
  private saved: { width: string; height: string } | null = null
  private off: (() => void) | null = null
  constructor(private readonly t: ContainTargets) {}

  get active(): boolean {
    return this.size !== null
  }

  /** 戦闘の論理サイズ（null = 論理サイズ未指定＝従来表示）。null は `leave` と同じ */
  enter(size: { w: number; h: number } | null): void {
    if (!size) {
      this.leave()
      return
    }
    if (!this.saved) {
      const s = this.t.canvas.style
      this.saved = { width: s.width, height: s.height }
    }
    this.size = size
    this.t.body.classList.toggle('battle-contain', true)
    this.off ??= this.t.onResize(() => this.apply())
    this.apply()
  }

  /** 付けたものを全部外す（付いていなければ何もしない） */
  leave(): void {
    this.off?.()
    this.off = null
    this.size = null
    this.t.body.classList.toggle('battle-contain', false)
    if (this.saved) {
      const s = this.t.canvas.style
      s.removeProperty('width')
      s.removeProperty('height')
      if (this.saved.width) s.width = this.saved.width
      if (this.saved.height) s.height = this.saved.height
      this.saved = null
    }
  }

  dispose(): void {
    this.leave()
  }

  private apply(): void {
    if (!this.size) return
    const vp = this.t.viewport()
    const r = containRect(vp.w, vp.h, this.size.w, this.size.h)
    const s = this.t.canvas.style
    s.setProperty('width', `${r.w}px`, 'important')
    s.setProperty('height', `${r.h}px`, 'important')
  }
}
