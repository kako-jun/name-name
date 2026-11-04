/**
 * 手の形カーソル（戦闘メニューとフィールドメニューの共通部品。#744・#1067）。
 * 画像（texture）があれば画像のスプライト、無ければ従来のドット手。位置・高さの比は呼び出し側が決めた枠に従う。
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js'
import { HAND_HEIGHT, HAND_PIXEL, HAND_WIDTH, handCells } from './battleMenuLayout'
import { computeHandImageRect, type HandFacingDir } from './uiImages'

const HAND_FILL = 0xffffff
const HAND_OUTLINE = 0x000000

/**
 * 手を作る。`(x, y)` は手の枠の左上、`height` は枠の高さ（幅は `HAND_WIDTH:HAND_HEIGHT` の比）。
 * タップは受けない（行・対象の判定へ通す）
 */
export function createHandCursor(
  x: number,
  y: number,
  height: number,
  facing: HandFacingDir,
  texture: Texture | null
): Container {
  const k = height / HAND_HEIGHT
  if (texture) {
    const r = computeHandImageRect(
      { x, y, w: HAND_WIDTH * k, h: height },
      facing,
      texture.width,
      texture.height
    )
    if (r) {
      const s = new Sprite(texture)
      s.eventMode = 'none'
      s.height = r.h
      s.width = r.w
      if (r.flipX) {
        // 左右反転: anchor を右端にして x を負にすると、位置 r.x から右へ向かって反転した絵が広がる
        s.anchor.set(1, 0)
        s.scale.x = -Math.abs(s.scale.x)
      }
      s.position.set(r.x, r.y)
      return s
    }
  }
  return dotHand(x, y, k, facing)
}

/** ドット手。黒い縁（1px 外へ広げた塗り）の上に白を重ねる */
function dotHand(x: number, y: number, k: number, facing: HandFacingDir): Graphics {
  const g = new Graphics()
  g.eventMode = 'none'
  const cells = handCells(facing)
  const unit = HAND_PIXEL * k
  for (const c of cells)
    g.rect(x + c.x * k - 1, y + c.y * k - 1, unit + 2, unit + 2).fill({ color: HAND_OUTLINE })
  for (const c of cells) g.rect(x + c.x * k, y + c.y * k, unit, unit).fill({ color: HAND_FILL })
  return g
}
