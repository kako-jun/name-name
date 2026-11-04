/**
 * 残り時間の最前面オーバーレイ (#880)。フィールド・メニュー・戦闘のどこでも同じ位置（`fieldTimeLimit.ts` の予約領域）に出す。
 * 呼び出し側は stage の最前面に置き（`zIndex` を大きく）、`update` で状態と画面の大きさを渡す。時間制限なしなら非表示。
 * 停止中は暗い色・「停止中」付きで見せる。
 */
import { Container, Graphics, Text as PixiText } from 'pixi.js'
import {
  timeLimitText,
  timeLimitFontPx,
  timeLimitRect,
  type TimeLimitState,
} from './fieldTimeLimit'

const FONT_FAMILY = "'Noto Sans JP', sans-serif"

export const TIME_LIMIT_LAYER_Z = 1_000_000

export class TimeLimitLayer extends Container {
  private readonly bg = new Graphics()
  private readonly caption = new PixiText({
    text: '',
    style: { fontFamily: FONT_FAMILY, fontSize: 16, fill: 0xffffff },
  })
  private key = ''

  constructor() {
    super()
    this.zIndex = TIME_LIMIT_LAYER_Z
    this.eventMode = 'none'
    this.visible = false
    this.caption.anchor.set(0, 0.5)
    this.addChild(this.bg, this.caption)
  }

  update(state: TimeLimitState, faceW: number, faceH: number): void {
    const text = timeLimitText(state)
    if (text === null) {
      this.visible = false
      return
    }
    this.visible = true
    const key = `${text}|${state.paused}|${faceW}|${faceH}`
    if (key === this.key) return
    this.key = key
    const r = timeLimitRect(faceW, faceH)
    const font = timeLimitFontPx(faceW, faceH)
    this.bg
      .clear()
      .roundRect(r.x, r.y, r.w, r.h, r.h * 0.2)
      .fill({ color: 0x000a50, alpha: state.paused ? 0.6 : 0.85 })
    this.bg
      .roundRect(r.x, r.y, r.w, r.h, r.h * 0.2)
      .stroke({ width: 2, color: state.paused ? 0xaaaaaa : 0xffffff })
    // 停止中は右端に停止マーク（縦棒2本。絵文字は使わない）
    if (state.paused) {
      const bw = r.h * 0.12
      const bh = r.h * 0.5
      const bx = r.x + r.w - r.h * 0.45
      const by = r.y + (r.h - bh) / 2
      this.bg.rect(bx, by, bw, bh).fill({ color: 0xbbbbbb })
      this.bg.rect(bx + bw * 1.8, by, bw, bh).fill({ color: 0xbbbbbb })
    }
    this.caption.text = text
    this.caption.style.fontSize = font
    this.caption.style.fill = state.paused ? 0xbbbbbb : 0xffffff
    this.caption.position.set(r.x + r.w * 0.05, r.y + r.h / 2)
  }
}
