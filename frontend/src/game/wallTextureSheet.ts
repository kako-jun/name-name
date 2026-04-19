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

import { Container, Graphics, Rectangle, RenderTexture, Renderer, Sprite, Texture } from 'pixi.js'

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
  /**
   * 派生 columns Texture を解放する。base source は共有（`demoWallCache` or Assets 側）なので
   * touch しない。base 本体の解放は `clearDemoWallCache(renderer)` 側が担当する。
   */
  destroy(): void
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
 * 壁ヒット位置から u 座標（[0, 1)）を算出する純粋関数。
 *
 * Lodev 方式:
 *  - side=0（x-side に当たった）→ wallY = playerY + perpDist * rayDirY の小数部
 *  - side=1（y-side に当たった）→ wallX = playerX + perpDist * rayDirX の小数部
 *  - u 反転: side=0 && rayDirX > 0 のときと、side=1 && rayDirY < 0 のとき u = 1 - u
 *    （テクスチャの「左右」がレイの来る向きに対して常に同じ向きに見えるようにする）
 *
 * @see https://lodev.org/cgtutor/raycasting.html
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
  // u >= 1 を 1 - 1e-6 に丸める: `uToColumn` 側でも width-1 へのクランプで救われるが、
  // 呼び出し側で `u === 1` を直接等号比較するケースや、[0, 1) の半開区間契約に依存する
  // 呼び出し側の歴史的境界回避のため、ここで閉じておく
  if (u >= 1) u = 1 - 1e-6
  return u
}

export interface WallTextureCrop {
  /**
   * 切り出し開始 Y（texture 座標）。
   * `stackHeight - round(wh * textureHeight)`（stackHeight = tileCount * textureHeight）。
   * tileCount=1 のときは `textureHeight - round(wh * textureHeight)`（従来の `(1-wh)*H` 相当）。
   */
  frameY: number
  /** 切り出し高さ（texture 座標） */
  frameHeight: number
  /**
   * 使うスタックテクスチャのタイル数（1, 2, 3）。
   * 1 のときは基底テクスチャ 1 枚、2 のときはベース 2 枚縦スタック、3 のときは 3 枚スタック。
   * wallHeight > 3 は 3 にクランプ（その部分だけ従来 stretch 退化、警告を 1 度出す）。
   */
  tileCount: number
}

/** wallHeight > 3 の警告を各セッションで 1 度だけ出すためのフラグ（module-scope） */
let _loggedClampWarning = false

/**
 * wh > 3 のクランプ警告。テスト実行時は抑制する。
 * 関数として分離して unit test から reset 可能に（テスト内では `MODE === 'test'` で実質 no-op）。
 */
function warnWallHeightClampedOnce(wh: number): void {
  if (_loggedClampWarning) return
  // vitest などのテスト環境では抑制（import.meta.env.MODE が 'test'）
  try {
    if (
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test'
    ) {
      _loggedClampWarning = true
      return
    }
  } catch {
    // 一部のランタイム（ビルド時評価）で import.meta.env が読めない場合はフォールスルー
  }
  _loggedClampWarning = true
  console.warn(
    `[wallTextureSheet] wallHeight=${wh} exceeds supported max 3; clamping to 3-tile rendering.`
  )
}

/**
 * 壁高さに応じたテクスチャ切り出し範囲を返す純粋関数。
 *
 * Issue #86 Phase 2-5: 0 < wallHeight < 1 の crop モード（上端を削って下部のみ残す）。
 * Issue #93: wallHeight > 1 の垂直タイリングモード（tileCount 2/3 のスタックテクスチャを指す）。
 *
 * - 0 < wh < 1: tileCount=1、frameY=(1-wh)*H、frameHeight=wh*H（上端を削って下部のみ）
 * - wh == 1: tileCount=1、frameY=0、frameHeight=H（texture 全体）
 * - 1 < wh <= 2: tileCount=2、frameY=(2-wh)*H、frameHeight=wh*H（2 タイル合成の下部 wh 分）
 * - 2 < wh <= 3: tileCount=3、frameY=(3-wh)*H、frameHeight=wh*H（3 タイル合成の下部 wh 分）
 * - wh > 3: tileCount=3、frameY=0、frameHeight=3*H にクランプ（console.warn 1 回）
 * - wh <= 0 / NaN / Infinity: tileCount=1、frameY=0、frameHeight=0（描画スキップ）
 *
 * `frameHeight` は 1px 未満にならないよう `Math.max(1, ...)` で保護、Math.round で整数化。
 *
 * 数学的根拠（pixel scale 不変性）:
 *   - wh=1: pixel scale = lineHeight / H
 *   - wh=0.5 crop: pixel scale = (lineHeight*0.5) / (H*0.5) = lineHeight / H ← 同じ
 *   - wh=2 tile: pixel scale = (lineHeight*2) / (H*2) = lineHeight / H ← 同じ
 *
 * @param textureHeight 基底テクスチャの高さ（通常 TEXTURE_HEIGHT=64）。スタック後の高さではない
 * @param wallHeight 壁高さ（1.0 が標準）
 */
export function computeWallTextureCrop(textureHeight: number, wallHeight: number): WallTextureCrop {
  // 防御: 非有限値・非正値は空の切り出し
  if (!Number.isFinite(wallHeight) || wallHeight <= 0) {
    return { frameY: 0, frameHeight: 0, tileCount: 1 }
  }

  // wh > 3 はクランプ（3 タイル分に圧縮、stretch 退化）
  if (wallHeight > 3) {
    warnWallHeightClampedOnce(wallHeight)
    return { frameY: 0, frameHeight: textureHeight * 3, tileCount: 3 }
  }

  // バケット: ceil(wh) で 1/2/3 を決める（wh=1.0 は 1、wh=2.0 は 2、wh=2.0001 は 3）
  // wh <= 0 は上で弾いているので、ceil(wh) は 1/2/3 のいずれか
  const tileCount = Math.ceil(wallHeight) as 1 | 2 | 3
  const stackHeight = textureHeight * tileCount

  // frameHeight = wh * H（整数化 + 1px 保護）
  const rawHeight = Math.round(textureHeight * wallHeight)
  const frameHeight = Math.max(1, rawHeight)
  // frameY は「スタック高さの下端に揃える」= stackHeight - frameHeight
  const frameY = stackHeight - frameHeight
  return { frameY, frameHeight, tileCount }
}

/**
 * テスト専用: wh > 3 警告フラグをリセット。
 * 本番コードから呼ばれることを想定しない。
 * @internal
 */
export function __resetWallHeightClampWarning(): void {
  _loggedClampWarning = false
}

/**
 * ベーステクスチャから縦ストライプ配列を切り出す。
 * base source を共有するため、個別 Texture を destroy するときは
 * `tex.destroy(false)` で呼び、base source を壊さないこと。
 */
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

  // 木目の縦ライン（濃いめ）。幅・位置はジグザグにして単調さを避ける。
  // 値は TEXTURE_WIDTH=64 前提で手動調整済み（可変幅対応は将来 Issue）
  const grainCols = [8, 18, 27, 39, 48, 57]
  for (const col of grainCols) {
    for (let y = 0; y < size; y++) {
      const wiggle = Math.sin(y * 0.35 + col) * 1.2
      g.rect(col + wiggle, y, 1, 1).fill(0x0f2a0f)
    }
  }

  // 明るめの縦ハイライト（木の反射）。TEXTURE_WIDTH=64 前提
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
 *
 * Phase 1 では外部画像パス引数を受け付けない（未使用 + センチネル値の混乱回避）。
 * Phase 2（プロジェクトごとの `assets/textures/{name}.png` 読み込み）は別 Issue で戻す。
 *
 * ロード失敗時は null（呼び出し側で色ベタ fallback）。
 */
export async function loadWallTexture(
  kind: WallTextureKind,
  renderer: Renderer
): Promise<WallTextureSheet | null> {
  const base = getOrBuildDemoBase(renderer, kind)
  const columns = sliceColumns(base, TEXTURE_WIDTH, TEXTURE_HEIGHT)
  return {
    columns,
    width: TEXTURE_WIDTH,
    height: TEXTURE_HEIGHT,
    destroy() {
      // base source は demoWallCache（または Assets）側が共有・管理するので触らない。
      // 派生 frame Texture のみ個別に destroy する（false: base を壊さない）
      for (const tex of columns) {
        tex.destroy(false)
      }
      columns.length = 0
    },
  }
}

/**
 * スタック済み壁テクスチャシートのキャッシュ（Issue #93）。
 * key は `"${kind}:${tileCount}"`。renderer が GC されれば一緒に消える（WeakMap）。
 * RaycastRenderer からは tileCount>=2 のときだけ呼ぶ想定。
 */
const stackedWallCache = new WeakMap<Renderer, Map<string, WallTextureSheet>>()

/**
 * ベーステクスチャを縦方向に `tileCount` 回スタックした RenderTexture を作る。
 * Sprite を tileCount 個配置して renderer.render で 1 枚の RenderTexture に焼く。
 */
function buildStackedWallTexture(
  renderer: Pick<Renderer, 'render'>,
  base: Texture,
  tileCount: number
): RenderTexture {
  const container = new Container()
  for (let i = 0; i < tileCount; i++) {
    const sprite = new Sprite(base)
    sprite.x = 0
    sprite.y = i * TEXTURE_HEIGHT
    container.addChild(sprite)
  }
  const rt = RenderTexture.create({
    width: TEXTURE_WIDTH,
    height: TEXTURE_HEIGHT * tileCount,
    resolution: 1,
  })
  renderer.render({ container, target: rt })
  // sprite は base texture を参照しているだけ。base source は demoWallCache の所有なので、
  // children: true でも base 本体は destroy されない（Sprite 側の所有権は無い）。
  container.destroy({ children: true })
  return rt
}

/**
 * スタック済み壁テクスチャシートを取得する（Issue #93、垂直タイリング用）。
 *
 * - tileCount=1 のときは基底テクスチャからそのまま columns を切り出して返す
 *   （`loadWallTexture` と同じ結果の新しいシート。呼び出し側は独立した destroy 管理が可能）。
 * - tileCount>=2 のときは、基底テクスチャを縦に `tileCount` 回スタックした RenderTexture を
 *   作り、そこから `sliceColumns` で列を切り出す。計算された stacked RenderTexture は
 *   `stackedWallCache` に保持され、renderer が GC されるまで再利用される。
 *
 * `sheet.height` は `TEXTURE_HEIGHT * tileCount`。`computeWallTextureCrop` の frameY/frameHeight は
 * このスタック高さと整合する。呼び出し側は `computeWallTextureCrop(TEXTURE_HEIGHT, wh)` と
 * 基底高さを渡し、帰ってきた `frameY` を `Rectangle(col, frameY, 1, frameHeight)` として
 * 本関数が返した `sheet.columns[col].source` に当てる。
 */
export function getStackedWallSheet(
  renderer: Renderer,
  kind: WallTextureKind,
  tileCount: number
): WallTextureSheet {
  // 入力防御: 1-3 にクランプ。tileCount が外から 0 や 4+ で来ても安全に動く
  const clamped = Math.max(1, Math.min(3, Math.floor(tileCount))) as 1 | 2 | 3
  const key = `${kind}:${clamped}`

  let byRenderer = stackedWallCache.get(renderer)
  if (!byRenderer) {
    byRenderer = new Map()
    stackedWallCache.set(renderer, byRenderer)
  }
  const cached = byRenderer.get(key)
  if (cached) return cached

  const base = getOrBuildDemoBase(renderer, kind)
  const stackedHeight = TEXTURE_HEIGHT * clamped
  // clamped === 1 のときは demoWallCache 所有の base をそのまま使い回すので、本 sheet は base の
  // 所有権を持たない（ownedBase=null）。destroy で誤って demoWallCache の base を壊さないため。
  // clamped >= 2 のときだけ新しい RenderTexture を本 sheet が所有し、clearStackedWallCache 経由で
  // sheet.destroy() → ownedBase.destroy(true) で解放する。
  const ownedBase: RenderTexture | null =
    clamped === 1 ? null : buildStackedWallTexture(renderer, base, clamped)
  const stackedBase: Texture = ownedBase ?? base
  const columns = sliceColumns(stackedBase, TEXTURE_WIDTH, stackedHeight)

  const sheet: WallTextureSheet = {
    columns,
    width: TEXTURE_WIDTH,
    height: stackedHeight,
    destroy() {
      for (const tex of columns) {
        tex.destroy(false)
      }
      columns.length = 0
      // ownedBase !== null の場合のみ、本 sheet が所有する stacked RenderTexture を解放する。
      // ownedBase === null（tileCount=1）は demoWallCache の base を共有しているため触らない。
      ownedBase?.destroy(true)
    },
  }
  byRenderer.set(key, sheet)
  return sheet
}

/**
 * レンダラー破棄時に、スタック済み RenderTexture とシートを一括 destroy する。
 * demoWallCache の base を壊す前に呼ぶのが安全（stacked RenderTexture は既に独立 source を持つが、
 * columns は base source を参照するため、順序を気にする場合は stacked → demo の順で呼ぶ）。
 */
export function clearStackedWallCache(renderer: Renderer): void {
  const byRenderer = stackedWallCache.get(renderer)
  if (!byRenderer) return
  for (const sheet of byRenderer.values()) {
    sheet.destroy()
  }
  stackedWallCache.delete(renderer)
}
