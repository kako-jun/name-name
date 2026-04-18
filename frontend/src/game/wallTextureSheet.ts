/**
 * 壁テクスチャシート生成・ロード。
 *
 * Raycast レンダラーの壁描画を「色ベタ → テクスチャストライプ」に引き上げるための
 * テクスチャローダー。`npcSpriteSheet.ts` と同じパターンで、手続き生成の `__demo_tree` /
 * `__demo_water` と、外部画像パス指定（PIXI Assets.load）の両方をサポートする。
 *
 * 公開する `WallTextureSheet` は「幅 TEXTURE_WIDTH × 高さ TEXTURE_HEIGHT」のベーステクスチャから
 * 1 列ずつ切り出した縦ストライプ Texture 配列を保持する。RaycastRenderer は DDA で得た壁ヒット位置
 * から `computeWallU` → `uToColumn` で列 index を決め、ストライプ Sprite の texture に割り当てる。
 */

import { Assets, Container, Graphics, Rectangle, RenderTexture, Renderer, Texture } from 'pixi.js'

export type WallTextureKind = 'tree' | 'water'

/** テクスチャ幅（= 縦ストライプ列数）。Lodev 系レイキャスタの慣例で 64 を採用 */
export const TEXTURE_WIDTH = 64
/** テクスチャ高さ（= 縦ストライプの高さ）。正方で使う */
export const TEXTURE_HEIGHT = 64

export interface WallTextureSheet {
  /** 左から 0..width-1 の縦ストライプ Texture（いずれも幅 1 × 高さ height） */
  columns: Texture[]
  width: number
  height: number
}

/**
 * u 座標 [0, 1] を列 index [0, width-1] に変換する純粋関数。
 * 範囲外はクランプ。NaN は 0 扱い。
 */
export function uToColumn(u: number, width: number): number {
  if (Number.isNaN(u)) return 0
  const clamped = u < 0 ? 0 : u > 1 ? 1 : u
  const col = Math.floor(clamped * width)
  if (col < 0) return 0
  if (col >= width) return width - 1
  return col
}

/**
 * 壁ヒット位置から u 座標（[0, 1]）を算出する純粋関数。
 *
 * Lodev 方式:
 *  - side=0（x-side に当たった）→ wallY = playerY + perpDist * rayDirY の小数部
 *  - side=1（y-side に当たった）→ wallX = playerX + perpDist * rayDirX の小数部
 *  - u 反転: side=0 && rayDirX > 0 のときと、side=1 && rayDirY < 0 のとき u = 1 - u
 *    （テクスチャの「左右」がレイの来る向きに対して常に同じ向きに見えるようにする）
 */
export function computeWallU(
  hitSide: 0 | 1,
  perpDist: number,
  playerX: number,
  playerY: number,
  rayDirX: number,
  rayDirY: number
): number {
  let wallPos: number
  if (hitSide === 0) {
    wallPos = playerY + perpDist * rayDirY
  } else {
    wallPos = playerX + perpDist * rayDirX
  }
  let u = wallPos - Math.floor(wallPos)
  if (hitSide === 0 && rayDirX > 0) u = 1 - u
  if (hitSide === 1 && rayDirY < 0) u = 1 - u
  // 浮動小数の境界で負の微小値になる可能性をクランプ
  if (u < 0) u = 0
  if (u >= 1) u = 1 - 1e-6
  return u
}

/** ベーステクスチャから縦ストライプ配列を切り出す */
function sliceColumns(base: Texture, width: number, height: number): Texture[] {
  const cols: Texture[] = []
  for (let x = 0; x < width; x++) {
    cols.push(
      new Texture({
        source: base.source,
        frame: new Rectangle(x, 0, 1, height),
      })
    )
  }
  return cols
}

/**
 * デモ木目（TREE 用）: `#1a3a1a` ベースに木目ライン数本と節目の斑点。
 * 「色ベタじゃなくテクスチャが出ている」と一目で分かる程度で十分。
 */
function drawDemoTree(size: number): Graphics {
  const g = new Graphics()
  // ベース
  g.rect(0, 0, size, size).fill(0x1a3a1a)

  // 木目の縦ライン（濃いめ）。幅・位置はジグザグにして単調さを避ける
  const grainCols = [8, 18, 27, 39, 48, 57]
  for (const col of grainCols) {
    for (let y = 0; y < size; y++) {
      const wiggle = Math.sin(y * 0.35 + col) * 1.2
      g.rect(col + wiggle, y, 1, 1).fill(0x0f2a0f)
    }
  }

  // 明るめの縦ハイライト（木の反射）
  const highlightCols = [14, 33, 52]
  for (const col of highlightCols) {
    for (let y = 0; y < size; y++) {
      g.rect(col, y, 1, 1).fill(0x2a5a2a)
    }
  }

  // 節目のダーク斑点
  const knots = [
    { x: 20, y: 15, r: 3 },
    { x: 45, y: 40, r: 4 },
    { x: 10, y: 52, r: 2 },
  ]
  for (const k of knots) {
    g.circle(k.x, k.y, k.r).fill(0x0a1a0a)
    g.circle(k.x, k.y, Math.max(1, k.r - 1)).fill(0x1a3a1a)
  }

  return g
}

/**
 * デモ水面（WATER 用）: `#4169e1` ベースに明暗の横ストライプと波ライン。
 */
function drawDemoWater(size: number): Graphics {
  const g = new Graphics()
  // ベース
  g.rect(0, 0, size, size).fill(0x4169e1)

  // 横ストライプ（明暗交互）。奇数行は少し暗く、偶数行はハイライト寄り
  for (let y = 0; y < size; y++) {
    if (y % 6 === 0) {
      g.rect(0, y, size, 1).fill(0x87cefa)
    } else if (y % 6 === 3) {
      g.rect(0, y, size, 1).fill(0x2c4fb0)
    }
  }

  // 波ライン（緩やかな横方向のうねり）
  for (let x = 0; x < size; x++) {
    const y1 = Math.floor(12 + Math.sin(x * 0.25) * 3)
    const y2 = Math.floor(34 + Math.sin(x * 0.2 + 1) * 3)
    const y3 = Math.floor(52 + Math.sin(x * 0.3 + 2) * 2)
    g.rect(x, y1, 1, 1).fill(0xb0e0ff)
    g.rect(x, y2, 1, 1).fill(0xb0e0ff)
    g.rect(x, y3, 1, 1).fill(0x87cefa)
  }

  return g
}

/**
 * `__demo_tree` / `__demo_water` のベーステクスチャを RenderTexture で作る。
 */
export function buildDemoWallTexture(renderer: Renderer, kind: WallTextureKind): Texture {
  const container = new Container()
  const g = kind === 'tree' ? drawDemoTree(TEXTURE_WIDTH) : drawDemoWater(TEXTURE_WIDTH)
  container.addChild(g)

  const rt = RenderTexture.create({
    width: TEXTURE_WIDTH,
    height: TEXTURE_HEIGHT,
    resolution: 1,
  })
  renderer.render({ container, target: rt })
  container.destroy({ children: true })
  return rt
}

/**
 * レンダラーごと＋種別ごとにキャッシュする WeakMap。
 * 複数の RaycastRenderer インスタンス間で誤共有しないため、renderer を key にする。
 */
const demoWallCache = new WeakMap<Renderer, Map<WallTextureKind, Texture>>()

function getOrBuildDemoBase(renderer: Renderer, kind: WallTextureKind): Texture {
  let byRenderer = demoWallCache.get(renderer)
  if (!byRenderer) {
    byRenderer = new Map()
    demoWallCache.set(renderer, byRenderer)
  }
  const existing = byRenderer.get(kind)
  if (existing) return existing
  const built = buildDemoWallTexture(renderer, kind)
  byRenderer.set(kind, built)
  return built
}

/**
 * レンダラー破棄時に、そのレンダラー向けに生成した __demo_* テクスチャを一括 destroy する。
 */
export function clearDemoWallCache(renderer: Renderer): void {
  const byRenderer = demoWallCache.get(renderer)
  if (!byRenderer) return
  for (const tex of byRenderer.values()) {
    tex.destroy(true)
  }
  demoWallCache.delete(renderer)
}

/**
 * 壁テクスチャシートを得る。`kind` に応じて `__demo_tree` / `__demo_water` を手続き生成する。
 * 将来的に外部画像パスを渡せるよう、第 3 引数に `externalPath` を許容する（省略時はデモ生成）。
 * ロード失敗時は null（呼び出し側で色ベタ fallback）。
 */
export async function loadWallTexture(
  kind: WallTextureKind,
  renderer: Renderer,
  externalPath?: string
): Promise<WallTextureSheet | null> {
  if (externalPath && externalPath !== '__demo_tree' && externalPath !== '__demo_water') {
    try {
      const base = (await Assets.load(externalPath)) as Texture
      return {
        columns: sliceColumns(base, TEXTURE_WIDTH, TEXTURE_HEIGHT),
        width: TEXTURE_WIDTH,
        height: TEXTURE_HEIGHT,
      }
    } catch (e) {
      console.warn(`[WallTextureSheet] failed to load wall texture "${externalPath}":`, e)
      return null
    }
  }

  const base = getOrBuildDemoBase(renderer, kind)
  return {
    columns: sliceColumns(base, TEXTURE_WIDTH, TEXTURE_HEIGHT),
    width: TEXTURE_WIDTH,
    height: TEXTURE_HEIGHT,
  }
}
