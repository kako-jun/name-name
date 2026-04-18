/**
 * NPC スプライトシート生成・ロード。
 *
 * ゲーム側が PNG を提供していないサンプル段階でも「NPC がアニメーションで表示される」
 * という体験を成立させるため、`sprite = "__demo"` のときだけ手続き的に 4 方向 × 2 フレームの
 * シートを PixiJS `RenderTexture` で生成する。外部パス指定の場合は PIXI `Assets` でロード。
 *
 * シート座標系（tileSize = セルサイズ、典型 32）:
 *   - 行（縦）: 0=Down, 1=Left, 2=Right, 3=Up
 *   - 列（横）: 0..frames-1 の歩行フレーム
 */

import { Assets, Container, Graphics, Rectangle, RenderTexture, Renderer, Texture } from 'pixi.js'

export type Direction = 'down' | 'left' | 'right' | 'up'

const DIRECTION_ROW: Record<Direction, number> = {
  down: 0,
  left: 1,
  right: 2,
  up: 3,
}

export interface NpcSpriteSheet {
  /** (direction, frame) -> Texture。未指定フレームは textures[dir][0] を返す */
  textures: Texture[][]
  frames: number
}

/** 文字列 direction → 行 index。未知値は down 扱い。 */
export function directionToRow(d: Direction | undefined): number {
  return DIRECTION_ROW[d ?? 'down']
}

/** 実用値域 1..4 に clamp（parser は上限チェックしない、#50-a の docs 参照） */
export function clampFrames(n: number | undefined): number {
  if (!n || n < 1) return 2
  if (n > 4) return 4
  return Math.floor(n)
}

/**
 * スプライトシートから (directions × frames) の Texture 配列を切り出す。
 * baseTexture は frames*tileSize × 4*tileSize を前提。
 */
function sliceSheet(base: Texture, frames: number, tileSize: number): Texture[][] {
  const grid: Texture[][] = []
  for (let row = 0; row < 4; row++) {
    const rowArr: Texture[] = []
    for (let col = 0; col < frames; col++) {
      rowArr.push(
        new Texture({
          source: base.source,
          frame: new Rectangle(col * tileSize, row * tileSize, tileSize, tileSize),
        })
      )
    }
    grid.push(rowArr)
  }
  return grid
}

/**
 * 手続き的に「歩く小人」を 4 方向 × frames 分描画した RenderTexture を作る。
 *
 * 見た目:
 *   - 胴体: NPC 色の矩形
 *   - 頭: 肌色の円
 *   - 目: 向いている方向にシフト
 *   - 足: フレームごとに左右入れ替え（歩行感）
 *
 * サンプル段階で「動いてる」が一目でわかることを優先し、リアルさは追わない。
 * 実 PNG アセットが提供されたらこの関数は使われなくなる。
 */
export function buildDemoSheet(
  renderer: Renderer,
  color: number,
  frames: number,
  tileSize: number
): Texture {
  const total = new Container()
  for (let row = 0; row < 4; row++) {
    const dir: Direction = row === 0 ? 'down' : row === 1 ? 'left' : row === 2 ? 'right' : 'up'
    for (let col = 0; col < frames; col++) {
      const cell = drawDemoCell(dir, col, color, tileSize)
      cell.x = col * tileSize
      cell.y = row * tileSize
      total.addChild(cell)
    }
  }

  const rt = RenderTexture.create({
    width: frames * tileSize,
    height: 4 * tileSize,
    resolution: 1,
  })
  renderer.render({ container: total, target: rt })
  total.destroy({ children: true })
  return rt
}

function drawDemoCell(dir: Direction, frame: number, color: number, size: number): Graphics {
  const g = new Graphics()
  const cx = size / 2
  // 胴体（中央やや下）
  const bodyW = Math.max(10, Math.floor(size * 0.45))
  const bodyH = Math.max(8, Math.floor(size * 0.3))
  const bodyTop = Math.floor(size * 0.45)
  g.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH).fill(color)
  g.rect(cx - bodyW / 2, bodyTop, bodyW, bodyH).stroke({ width: 1, color: 0x222222 })

  // 頭（胴体の上、肌色）
  const headR = Math.max(4, Math.floor(size * 0.2))
  g.circle(cx, bodyTop - headR + 2, headR).fill(0xfcd9b0)
  g.circle(cx, bodyTop - headR + 2, headR).stroke({ width: 1, color: 0x222222 })

  // 目（向きを示す）
  const eyeR = 1
  const eyeY = bodyTop - headR + 2
  if (dir === 'down') {
    g.circle(cx - 2, eyeY + 1, eyeR).fill(0x222222)
    g.circle(cx + 2, eyeY + 1, eyeR).fill(0x222222)
  } else if (dir === 'up') {
    g.circle(cx - 2, eyeY - 2, eyeR).fill(0x222222)
    g.circle(cx + 2, eyeY - 2, eyeR).fill(0x222222)
  } else if (dir === 'left') {
    g.circle(cx - 3, eyeY, eyeR).fill(0x222222)
    g.circle(cx - 1, eyeY, eyeR).fill(0x222222)
  } else {
    // right
    g.circle(cx + 1, eyeY, eyeR).fill(0x222222)
    g.circle(cx + 3, eyeY, eyeR).fill(0x222222)
  }

  // 足（フレーム交互）: 奇数フレームで左右入れ替え
  const footY = bodyTop + bodyH
  const footW = 3
  const footH = 3
  const footOffset = frame % 2 === 0 ? 0 : 2
  g.rect(cx - 4 + footOffset, footY, footW, footH).fill(0x333333)
  g.rect(cx + 1 - footOffset, footY, footW, footH).fill(0x333333)

  return g
}

/**
 * NPC スプライトシートを得る。`spritePath` が `__demo` なら手続き生成、
 * それ以外は PIXI Assets.load で外部画像をロードする。失敗時は null（呼び出し側で色四角フォールバック）。
 */
export async function loadNpcSpriteSheet(
  spritePath: string,
  frames: number,
  tileSize: number,
  color: number,
  renderer: Renderer
): Promise<NpcSpriteSheet | null> {
  const f = clampFrames(frames)

  if (spritePath === '__demo') {
    const base = buildDemoSheet(renderer, color, f, tileSize)
    return { textures: sliceSheet(base, f, tileSize), frames: f }
  }

  try {
    const base = (await Assets.load(spritePath)) as Texture
    return { textures: sliceSheet(base, f, tileSize), frames: f }
  } catch (e) {
    console.warn(`[NpcSpriteSheet] failed to load sprite "${spritePath}":`, e)
    return null
  }
}
