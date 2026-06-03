/**
 * 一人称レイキャスティングにおける NPC 射影計算（純粋関数）。
 *
 * PixiJS などの描画層に依存しない pure computation として切り出し、
 * 境界条件（同一タイル、背面、退化カメラ、極小深度）を単体テスト可能にする。
 */

export interface Vec2 {
  x: number
  y: number
}

export interface NpcProjection {
  /** スプライト中心のスクリーンX（px、Math.floor 済み） */
  screenX: number
  /** スプライト高さ px（clampedDepth ベース、Math.floor 済み） */
  spriteHeight: number
  /** スプライト幅 px（spriteHeight と同値、billboard は正方形） */
  spriteWidthPx: number
  /** z-buffer 比較用の生 transformY（minDepth クランプ前） */
  depth: number
  /** 画面クランプ後の描画範囲（[0, width], [0, height]） */
  drawStartX: number
  drawEndX: number
  drawStartY: number
  drawEndY: number
}

/**
 * NPC の world 座標を一人称カメラのスクリーン座標に射影する純粋関数。
 *
 * - `null` を返す条件:
 *   - プレイヤーと同一タイル（Math.floor の整数部が一致）
 *   - 背面（transformY ≤ 0.01）
 *   - 退化カメラ（|det| < 1e-9、ゼロ除算ガード）
 *
 * - `depth` は生の transformY（z-buffer 比較で遮蔽整合性を保つ）
 * - `spriteHeight/Width` は `Math.max(transformY, minDepth)` でクランプされた深度から算出
 *   （極小 transformY でサイズが青天井に肥大化するのを防ぐ）
 *
 * 呼び出し側注意: `det`（= plane × dir）はフレーム内で dir/plane が不変なら定数になる。
 * 本関数は NPC ごとに毎回再計算するが、通常の NPC 数（数体〜数十）では実害なし。
 * 数百体規模で毎フレーム呼ぶ用途が出てきたら precompute 版 API を別途検討する。
 *
 * @param npc NPC の world 座標（タイル中心を `x + 0.5` 等で表現）
 * @param player プレイヤーの world 座標
 * @param dir カメラ向き単位ベクトル
 * @param plane カメラ平面ベクトル（長さ = tan(fov/2)）
 * @param screen 描画キャンバスサイズ
 * @param minDepth スプライトサイズ計算時の深度下限。z-buffer 比較や `depth` フィールドには影響しない。
 * @param pitchOffsetPx 画面中央 Y のシフト量（px）。Issue #80 Phase 2 で導入。
 *                       pitch 由来の `Math.tan(pitch) * h/2` だけでなく、ジャンプ等のカメラ高さオフセット
 *                       `playerZ * h/2`（Phase 2-2）を合算した値を渡せる。正で画面中央が下にシフト＝視線が上向き
 *                       またはカメラ位置が上（プレイヤーがジャンプ中）。`NaN/Infinity` は `0` 扱い。
 *                       デフォルト `0`（pitch/ジャンプ未対応の従来呼び出しは挙動不変）。
 */
export function projectNpcToScreen(
  npc: Vec2,
  player: Vec2,
  dir: Vec2,
  plane: Vec2,
  screen: { width: number; height: number },
  minDepth: number,
  pitchOffsetPx: number = 0
): NpcProjection | null {
  // 同一タイル判定
  if (Math.floor(npc.x) === Math.floor(player.x) && Math.floor(npc.y) === Math.floor(player.y)) {
    return null
  }

  // 正規直交カメラでは |det| ≈ tan(fov/2) ≈ 0.577 なので、1e-9 は通常プレイでは発動しない純防御。
  // 入力が完全退化（dir ∥ plane）したときのゼロ除算を避けるのが目的。
  const det = plane.x * dir.y - dir.x * plane.y
  if (Math.abs(det) < 1e-9) return null
  const invDet = 1.0 / det

  const rx = npc.x - player.x
  const ry = npc.y - player.y
  const transformX = invDet * (dir.y * rx - dir.x * ry)
  const transformY = invDet * (-plane.y * rx + plane.x * ry)

  if (transformY <= 0.01) return null

  const w = screen.width
  const h = screen.height
  const screenX = Math.floor((w / 2) * (1 + transformX / transformY))
  const clampedDepth = Math.max(transformY, minDepth)
  const spriteHeight = Math.abs(Math.floor(h / clampedDepth))
  const spriteWidthPx = spriteHeight

  // pitch オフセット: NaN/Infinity は 0 扱い。baseY = h/2 + offset を中央基準にする
  const safePitchOffset = Number.isFinite(pitchOffsetPx) ? pitchOffsetPx : 0
  const baseY = h / 2 + safePitchOffset
  let drawStartY = Math.floor(-spriteHeight / 2 + baseY)
  if (drawStartY < 0) drawStartY = 0
  if (drawStartY > h) drawStartY = h
  let drawEndY = Math.floor(spriteHeight / 2 + baseY)
  if (drawEndY > h) drawEndY = h
  if (drawEndY < 0) drawEndY = 0
  let drawStartX = Math.floor(-spriteWidthPx / 2 + screenX)
  let drawEndX = Math.floor(spriteWidthPx / 2 + screenX)
  if (drawStartX < 0) drawStartX = 0
  if (drawEndX > w) drawEndX = w

  return {
    screenX,
    spriteHeight,
    spriteWidthPx,
    depth: transformY,
    drawStartX,
    drawEndX,
    drawStartY,
    drawEndY,
  }
}

export interface WallYRange {
  /** 壁の上端 Y（画面座標、小さい方が上）。0 未満は 0 にクランプ済み */
  drawStartY: number
  /** 壁の下端 Y（画面座標、地面相当で `Math.floor(h/2 + lineHeight/2)`）。h 超過は h にクランプ済み */
  drawEndY: number
}

/**
 * 壁の高さ（wallHeight, 1.0 = 従来の画面中央 ±lineHeight/2）を考慮した Y 範囲を返す。
 *
 * 地面の位置は wallHeight に依らず常に `h/2 + lineHeight/2`（プレイヤー視線が地面から 0.5 タイル上と仮定）。
 * 上端は「地面から wallHeight 分上」= drawEnd - lineHeight * wallHeight。
 *
 * 浮動小数の floor を `lineHeight / 2 + h / 2` の段階で 1 回だけ取らず、
 * `drawEnd - lineHeight * effectiveHeight` 全体を 1 回 floor することで、
 * 二重 floor による最大 1px の上方バイアスを回避する。
 *
 * 入力契約:
 *  - `wallHeight` の `NaN/Infinity/負値` は 0 扱い（描画なし相当）
 *  - `lineHeight` の `NaN/Infinity/負値` は 0 扱い
 *  - `screenHeight` は非負を前提（負値はクランプで吸収するが想定外）
 * 呼び出し側で `drawEndY - drawStartY <= 0` を見て描画スキップする責務がある。
 *
 * 画面外クランプは [0, screenHeight] で行う。
 *
 * NOTE: 床 floor casting は「視点が床から 0.5 タイル上にある（= lineHeight/2 が地面位置）」前提を
 * 共有する（`RaycastRenderer.ts` の `FLOOR_CAMERA_Z = 0.5` 定数）。この関数の地面位置規約を
 * 変更する場合は床側の `FLOOR_CAMERA_Z` も同時に見直すこと。
 *
 * @param lineHeight 高さ 1.0 の壁が占める縦px（Lodev 方式の h/perpDist）
 * @param wallHeight 壁の高さ倍率（0 以下・非有限は 0 扱い、上限なし）
 * @param screenHeight 画面高 px
 * @param pitchOffsetPx 画面中央 Y のシフト量（px）。Issue #80 Phase 2 で導入。
 *                       pitch 由来の `Math.tan(pitch) * h/2` だけでなく、ジャンプ等のカメラ高さオフセット
 *                       `playerZ * h/2`（Phase 2-2）を合算した値を渡せる。正で画面中央が下にシフト＝視線が上向き
 *                       またはカメラ位置が上（プレイヤーがジャンプ中）。`NaN/Infinity` は `0` 扱い。
 *                       デフォルト `0`（pitch/ジャンプ未対応の従来呼び出しは挙動不変）。
 */
export function computeWallYRange(
  lineHeight: number,
  wallHeight: number,
  screenHeight: number,
  pitchOffsetPx: number = 0
): WallYRange {
  const h = screenHeight
  const effectiveHeight = !Number.isFinite(wallHeight) || wallHeight <= 0 ? 0 : wallHeight
  const safeLineHeight = !Number.isFinite(lineHeight) || lineHeight <= 0 ? 0 : lineHeight
  const safePitchOffset = Number.isFinite(pitchOffsetPx) ? pitchOffsetPx : 0
  // drawEnd は常に floor 済みの整数として確定させ、上端は drawEnd 基準で 1 回だけ floor する
  // （drawEnd を二度参照するため別変数。drawEndRaw の floor 漏れによる 1px ズレを避ける狙い）
  // pitchOffsetPx は地平線（baseY = h/2 + offset）を上下にずらす効果を持ち、上端・下端の両方に同じ量だけ加わる
  const drawEndRaw = Math.floor(safeLineHeight / 2 + h / 2 + safePitchOffset)
  const drawStartRaw = Math.floor(
    safeLineHeight / 2 + h / 2 + safePitchOffset - safeLineHeight * effectiveHeight
  )
  const drawStartY = drawStartRaw < 0 ? 0 : drawStartRaw > h ? h : drawStartRaw
  const drawEndY = drawEndRaw < 0 ? 0 : drawEndRaw > h ? h : drawEndRaw
  return { drawStartY, drawEndY }
}

/**
 * 壁高さに応じたフォグ上限距離を返す（Issue #80 Phase 2）。
 *
 * 通常の壁（wallHeight=1）は `baseFogMaxDist` で消えるが、高い塔（wallHeight=1.5, 2 等）は
 * ランドマークとして遠距離から視認できてほしい。そこで wallHeight > 1 の塔に限り、
 * 上限距離を `baseFogMaxDist * wallHeight` まで伸長する。
 *
 * 契約:
 *  - `wallHeight <= 1` → `baseFogMaxDist`（低い壁は通常の壁と同じ距離で消える。遠方視認を広げない）
 *  - `wallHeight > 1`  → `baseFogMaxDist * wallHeight`（高いほど遠くまで見える）
 *  - `NaN / Infinity / 負値`（および `0`）は `baseFogMaxDist`（防御。`Math.max(1, ...)` 相当）
 *
 * `baseFogMaxDist` 自体の非有限／非正値はそのまま返す（呼び出し側の責務）。
 */
export function computeEffectiveFogMaxDist(baseFogMaxDist: number, wallHeight: number): number {
  if (!Number.isFinite(wallHeight) || wallHeight <= 1) {
    return baseFogMaxDist
  }
  return baseFogMaxDist * wallHeight
}

/**
 * 床高さグリッド（[y][x]）から指定タイルの床高さを返す純粋関数（Issue #84）。
 *
 * - `grid` が `undefined`、該当行が未定義、セルが未定義、値が有限数でない場合は `0` を返す（地面扱い）
 * - 負値はそのまま返す（地面より沈み込む表現を許容する）
 *
 * `getWallHeight` の fallback=1 に対し、床高さは fallback=0（地面）。
 * プレイヤーがそのタイルに踏み込んだときのカメラ高さオフセットとして使う。
 */
export function resolveFloorHeight(grid: number[][] | undefined, tx: number, ty: number): number {
  if (!grid) return 0
  const row = grid[ty]
  if (!row) return 0
  const v = row[tx]
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return v
}

/**
 * 段差壁面（floor step wall）情報。Issue #88 Phase 2-7a。
 *
 * 隣接タイル間で `floorHeights` に差があるとき、境界に生じる垂直な段差面を表現する。
 * - `lowerZ` < `upperZ`。`heightDiff = upperZ - lowerZ > 0`
 * - この面は「lowerZ から upperZ まで」の垂直壁として描画される
 * - `upperSide` は「高い方の床がどちら側にあるか」（将来 u 座標計算やテクスチャ選択で使う可能性があるため保持）
 */
export interface FloorStepInfo {
  lowerZ: number
  upperZ: number
  heightDiff: number
  upperSide: 'prev' | 'next'
}

/**
 * 段差壁の記録（DDA ループ内で手前→奥順に蓄積する）。
 *
 * - `info`: 検出した段差情報（lowerZ/upperZ/heightDiff/upperSide）
 * - `depth`: ray が境界を跨いだときの crossDepth（`MIN_DEPTH` 以上にクランプ済み）
 * - `side`: 境界を跨いだ side（0=x-side, 1=y-side）。NPC と同じ y-side シェード判定に使う
 *
 * モジュールトップに昇格（元は DDA ループ内 inline 型）。
 */
export interface StepRecord {
  info: FloorStepInfo
  depth: number
  side: 0 | 1
}

/**
 * 隣接タイルの床高さから段差壁面情報を返す純粋関数（Issue #88 Phase 2-7a）。
 *
 * - `prevFloorZ === nextFloorZ` または差が 1e-6 未満 → `null`（段差なし）
 * - 高い方を `upperZ`、低い方を `lowerZ` として返す
 *
 * Q3 defense-in-depth: 非有限値の検査は通常 `resolveFloorHeight` 側で `0` に正規化されているため
 * ここには来ないが、純粋関数単位の契約として独立に検証する（`resolveFloorHeight` を経由しない
 * 直接呼び出しや、将来 `resolveFloorHeight` の正規化ルールが変わったときにここで吸収するため）。
 * `NaN` / `Infinity` は `null`。
 */
export function detectFloorStep(prevFloorZ: number, nextFloorZ: number): FloorStepInfo | null {
  if (!Number.isFinite(prevFloorZ) || !Number.isFinite(nextFloorZ)) return null
  const diff = Math.abs(prevFloorZ - nextFloorZ)
  if (diff < 1e-6) return null
  if (prevFloorZ > nextFloorZ) {
    return { lowerZ: nextFloorZ, upperZ: prevFloorZ, heightDiff: diff, upperSide: 'prev' }
  }
  return { lowerZ: prevFloorZ, upperZ: nextFloorZ, heightDiff: diff, upperSide: 'next' }
}

/**
 * 段差壁面の Y 範囲（画面座標）を返す純粋関数（Issue #88 Phase 2-7a）。
 *
 * 段差の垂直面は、通常の壁の地面位置から `lowerZ * lineHeight` だけ上にシフトした位置が下端、
 * そこから `heightDiff * lineHeight` 分だけ上に伸ばした位置が上端になる。
 *
 * 地面の基準位置（`baseGroundY`）: `computeWallYRange` と同じく
 *   `baseGroundY = floor(lineHeight/2 + h/2 + pitchOffsetPx)`
 * を前提にする。ただし段差の下端・上端は同じ floor 操作を最後に 1 回だけかけて、
 * 二重 floor による 1px バイアスを避ける（`computeWallYRange` の方針と同じ）。
 *
 * 入力契約:
 *  - `lineHeight` の `NaN/Infinity/負値` は 0 扱い
 *  - `lowerZ / upperZ` の `NaN/Infinity` は 0 扱い
 *  - `upperZ <= lowerZ` のときは上端=下端（描画なし相当）
 *  - `pitchOffsetPx` の `NaN/Infinity` は 0 扱い
 *  - 画面外クランプは [0, screenHeight] で行う
 *
 * 呼び出し側は `drawEndY - drawStartY <= 0` で描画スキップの責務を持つ。
 */
export function computeFloorStepWallYRange(
  lineHeight: number,
  lowerZ: number,
  upperZ: number,
  screenHeight: number,
  pitchOffsetPx: number = 0
): WallYRange {
  const h = screenHeight
  const safeLineHeight = !Number.isFinite(lineHeight) || lineHeight <= 0 ? 0 : lineHeight
  const safeLower = Number.isFinite(lowerZ) ? lowerZ : 0
  const safeUpper = Number.isFinite(upperZ) ? upperZ : 0
  const safePitchOffset = Number.isFinite(pitchOffsetPx) ? pitchOffsetPx : 0
  // 段差の高さ（負以下は描画なし）
  const effectiveDiff = safeUpper - safeLower <= 0 ? 0 : safeUpper - safeLower
  // 地面基準位置に対して「lowerZ 分上」に段差の下端が来る。通常の `computeWallYRange` は
  // `lowerZ=0` を仮定していたのと対照。上端は下端からさらに effectiveDiff 分上。
  const drawEndRaw = Math.floor(
    safeLineHeight / 2 + h / 2 + safePitchOffset - safeLineHeight * safeLower
  )
  const drawStartRaw = Math.floor(
    safeLineHeight / 2 + h / 2 + safePitchOffset - safeLineHeight * (safeLower + effectiveDiff)
  )
  const drawStartY = drawStartRaw < 0 ? 0 : drawStartRaw > h ? h : drawStartRaw
  const drawEndY = drawEndRaw < 0 ? 0 : drawEndRaw > h ? h : drawEndRaw
  return { drawStartY, drawEndY }
}

/**
 * 天井高さグリッド（[y][x]）から指定タイルの天井高さを返す純粋関数（Issue #87）。
 *
 * - `grid` が `undefined`、該当行が未定義、セルが未定義、値が有限数でない場合は `1` を返す（標準天井）
 * - `0` 以下の値も `1` にフォールバックする（天井が床より下の退化ケースで頭ぶつけ判定が破綻するのを防ぐ）
 *
 * `resolveFloorHeight`（fallback=0、負値許容）と対照的に、fallback=1、0 以下非許容。
 * プレイヤーのジャンプ時の頭ぶつけ判定に使う。
 */
export function resolveCeilingHeight(grid: number[][] | undefined, tx: number, ty: number): number {
  if (!grid) return 1
  const row = grid[ty]
  if (!row) return 1
  const v = row[tx]
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  if (v <= 0) return 1
  return v
}

// =============================================================================
// 床 floor casting 用の純粋関数群（Raycast 床描画）
// =============================================================================

/**
 * スキャンライン y における地表までの距離（タイル単位）を返す。
 *
 * Lodev 方式 floor casting の標準式: `rowDist = cameraZ / ((y - horizon) / (h/2))`。
 *
 * 入力契約:
 *  - `y > horizonY` でないと denom が 0 以下になる。呼び出し側は y > horizonY を保証する。
 *  - 上記が満たされない場合・非有限値・`screenHeight<=0` の場合は `0` を返す（描画スキップ目印）。
 *  - `cameraZ` の `NaN/Infinity` は `0` 扱い。
 */
export function computeFloorRowDist(
  y: number,
  horizonY: number,
  screenHeight: number,
  cameraZ: number
): number {
  if (!Number.isFinite(y) || !Number.isFinite(horizonY)) return 0
  if (!Number.isFinite(screenHeight) || screenHeight <= 0) return 0
  const safeCameraZ = Number.isFinite(cameraZ) ? cameraZ : 0
  const halfH = screenHeight / 2
  const denom = (y - horizonY) / halfH
  if (denom <= 0) return 0
  return safeCameraZ / denom
}

/**
 * 床タイル色サンプリング純粋関数。
 *
 * 与えられた世界座標 `(worldX, worldY)` のタイルを `Math.floor` で引き、
 * `palette[tile]` から色を返す。`palette` に無いタイル種別・マップ範囲外・非有限値は
 * `fallbackColor` にフォールバックする。
 *
 * 入力契約:
 *  - `mapTiles[ty]` が undefined のとき（行が穴あき）は `fallbackColor`
 *  - `palette[tile]` が `number` でないとき（未登録タイル種別）は `fallbackColor`
 *  - `worldX/Y` の `NaN/Infinity` は `fallbackColor`
 */
export function sampleFloorTileColor(
  mapTiles: number[][],
  mapWidth: number,
  mapHeight: number,
  worldX: number,
  worldY: number,
  palette: Readonly<Record<number, number>>,
  fallbackColor: number
): number {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return fallbackColor
  const tx = Math.floor(worldX)
  const ty = Math.floor(worldY)
  if (tx < 0 || tx >= mapWidth || ty < 0 || ty >= mapHeight) return fallbackColor
  const row = mapTiles[ty]
  if (!row) return fallbackColor
  const tile = row[tx]
  if (typeof tile !== 'number') return fallbackColor
  // 型上 `palette[tile]` は `number` だが、TS の `noUncheckedIndexedAccess` が無効でも実体が
  // 欠けた palette を渡される可能性があるため、ランタイム防御として `typeof` チェックを残す。
  const color = palette[tile]
  return typeof color === 'number' ? color : fallbackColor
}

// =============================================================================
// スワイプ 90° ターン補間用の純粋関数（Raycast 旋回アニメ）
// =============================================================================

/**
 * ターン補間 1 ステップ分の角度消費結果。
 */
export interface TurnAnimStep {
  /** プレイヤー角度に加算する rad（符号付き）。残量ゼロ・dt=0・speed=0 のときは 0 */
  delta: number
  /** 消費後の残量 rad（符号付き）。`Math.abs(remaining) <= maxStep` なら 0 にクリア */
  newRemaining: number
}

/**
 * 残量 `remaining` (rad、符号付き) から 1 フレ分 `dt * animSpeed` を消費する。
 *
 * - 残量が `maxStep` 以内なら全部消費して `newRemaining = 0`（float 誤差で 0 を跨ぐ事故を防ぐ）
 * - それ以外は `Math.sign(remaining) * maxStep` を消費して残量を減らす
 *
 * 入力契約:
 *  - `remaining` の `NaN/Infinity` は `{ delta: 0, newRemaining: 0 }`（破損状態を伝播させない）
 *  - `dt` / `animSpeed` の非正値・`NaN/Infinity` は `maxStep=0` 扱いで `delta=0`、残量はそのまま
 */
export function consumeTurnAnim(remaining: number, dt: number, animSpeed: number): TurnAnimStep {
  if (!Number.isFinite(remaining)) return { delta: 0, newRemaining: 0 }
  if (remaining === 0) return { delta: 0, newRemaining: 0 }
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0
  const safeSpeed = Number.isFinite(animSpeed) && animSpeed > 0 ? animSpeed : 0
  const maxStep = safeSpeed * safeDt
  if (maxStep <= 0) return { delta: 0, newRemaining: remaining }
  if (Math.abs(remaining) <= maxStep) {
    return { delta: remaining, newRemaining: 0 }
  }
  const step = (remaining > 0 ? 1 : -1) * maxStep
  return { delta: step, newRemaining: remaining - step }
}

// =============================================================================
// DDA ray march（純粋関数化・Issue #259）
//
// 一人称レイキャスティングの DDA（Digital Differential Analysis）を、PixiJS 描画から
// 切り離した純粋関数として表現する。これまで RaycastRenderer.renderFrame の内部ループに
// 直書きされていて、raycastProjection.test.ts は「終端計算」しかカバーできていなかった
// （march 途中＝壁ヒット判定・段差検出・crossDepth・side 判定のバグを検出できなかった）。
// init → advance を state→state の遷移として切り出し、marchRay でオーケストレーションする。
// 境界値テストを march 過程まで広げるのが狙い（規律4 の構造的検証点を描画側に広げる）。
// =============================================================================

/**
 * DDA march の状態。1 本の ray が grid をどこまで進んだかを表す。
 *
 * `deltaDist* / step*` は ray 方向から決まる不変量、`mapX/Y` と `sideDist*` が
 * イテレーションで進む可変量。`side / crossDepth / prevMapX/Y` は「直近のステップ」
 * の結果（`initRayMarch` の初期状態では便宜上 side=0, crossDepth=0, prev=map と同値）。
 */
export interface RayMarchState {
  /** 現在いる grid セル */
  mapX: number
  mapY: number
  /** 次の x / y 境界までの距離 */
  sideDistX: number
  sideDistY: number
  /** 1 タイル進むのにかかる距離（軸平行 ray は 1e30） */
  deltaDistX: number
  deltaDistY: number
  /** ray の進行方向（±1） */
  stepX: number
  stepY: number
  /** 直近のステップで跨いだ side（0=x境界, 1=y境界）。初期状態は 0 */
  side: 0 | 1
  /** 直近のステップで境界を跨いだ深度（クランプ前の生 crossDepth）。初期状態は 0 */
  crossDepth: number
  /** 直近のステップで跨ぐ前にいたタイル（段差検出で prev/next を比較するため）。初期状態は map と同値 */
  prevMapX: number
  prevMapY: number
}

/**
 * プレイヤー位置と ray 方向から DDA の初期状態を作る純粋関数（Issue #259）。
 *
 * 元 `RaycastRenderer.renderFrame` の init ブロックと同一の式。
 * - `mapX/Y` はプレイヤーがいるタイル（`Math.floor`）
 * - `deltaDist*` は 1 タイル進む距離。`rayDir*===0`（軸平行）は `1e30`（無限大ガード）
 * - `step*` は ray の進行方向（±1）、`sideDist*` は最初の境界までの距離
 *
 * 入力契約: `rayDirX/Y` の非有限はカメラ計算側で排除済みの前提（ここでは防御しない）。
 */
export function initRayMarch(
  playerX: number,
  playerY: number,
  rayDirX: number,
  rayDirY: number
): RayMarchState {
  const mapX = Math.floor(playerX)
  const mapY = Math.floor(playerY)
  const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX)
  const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY)
  let stepX: number
  let stepY: number
  let sideDistX: number
  let sideDistY: number
  if (rayDirX < 0) {
    stepX = -1
    sideDistX = (playerX - mapX) * deltaDistX
  } else {
    stepX = 1
    sideDistX = (mapX + 1.0 - playerX) * deltaDistX
  }
  if (rayDirY < 0) {
    stepY = -1
    sideDistY = (playerY - mapY) * deltaDistY
  } else {
    stepY = 1
    sideDistY = (mapY + 1.0 - playerY) * deltaDistY
  }
  return {
    mapX,
    mapY,
    sideDistX,
    sideDistY,
    deltaDistX,
    deltaDistY,
    stepX,
    stepY,
    side: 0,
    crossDepth: 0,
    prevMapX: mapX,
    prevMapY: mapY,
  }
}

/**
 * DDA を 1 セル分、`state` を破壊的に進める内部ヘルパ（ゼロアロケーション）。
 *
 * march の数式の唯一の正本。`marchRay` のホットループ（1 フレームで
 * stripe数 × ステップ数 ≈ 数千回）はこれを単一の scratch state に対して回し、
 * per-step のオブジェクト生成を避ける（元のインラインループと同じ in-place 更新）。
 * 純粋版が欲しい外部利用・単体テストは下の `advanceRayMarch` を使う。
 *
 * - `prevMapX/Y` に跨ぐ前のタイルを退避してから `mapX/Y` を進める（段差検出で prev/next を比較）
 * - `sideDistX < sideDistY` の軸を選ぶ（同値時は y を優先＝元コードの `<` と同じ）
 * - 跨いだ境界の `crossDepth`（= 選んだ側の旧 sideDist）と `side` を記録
 */
function stepRayInPlace(state: RayMarchState): void {
  state.prevMapX = state.mapX
  state.prevMapY = state.mapY
  if (state.sideDistX < state.sideDistY) {
    state.crossDepth = state.sideDistX
    state.sideDistX += state.deltaDistX
    state.mapX += state.stepX
    state.side = 0
  } else {
    state.crossDepth = state.sideDistY
    state.sideDistY += state.deltaDistY
    state.mapY += state.stepY
    state.side = 1
  }
}

/**
 * DDA を 1 セル進めた次状態を返す純粋関数（state→state・Issue #259）。
 *
 * 入力 `state` は変更せず（不変）、新しい `RayMarchState` を返す。`marchRay` のホットパスは
 * 内部で破壊的版（`stepRayInPlace`）を使うので、この純粋版は単体テストや外部利用向け
 * （数式の正本は `stepRayInPlace` に集約し、ここはその immutable ラッパ）。
 *
 * 元ループの「prev 保存 → 軸選択 → sideDist 加算 → map 進行」と完全に等価。
 */
export function advanceRayMarch(state: RayMarchState): RayMarchState {
  const next: RayMarchState = { ...state }
  stepRayInPlace(next)
  return next
}

/**
 * `marchRay` の結果。壁ヒットの有無と、描画に必要な終端値・段差レコードを返す。
 */
export interface RayMarchResult {
  /** 壁にヒットしたか（false = maxSteps 到達／壁なし） */
  hit: boolean
  /** ヒットした壁タイル種別（未ヒット時は `defaultTile`） */
  hitTile: number
  /** ヒット境界の side（0=x, 1=y）。未ヒット時は最後のステップの side */
  side: 0 | 1
  /** ヒット位置のタイル（`getWallHeight` に渡す用）。未ヒット時は最終到達タイル */
  mapX: number
  mapY: number
  /**
   * 壁の perpWallDist（`minDepth` クランプ済み）。未ヒット時は `null`。
   * 呼び出し側は未ヒット時に `fogMaxDist + 1` 等のセンチネルを使う。
   */
  perpDist: number | null
  /** 手前→奥順の段差壁レコード（`floorHeights` 未指定時は空配列） */
  stepInfos: StepRecord[]
}

/**
 * 1 本の ray を DDA で march し、壁ヒットと段差壁を検出する純粋関数（Issue #259）。
 *
 * これまで `RaycastRenderer.renderFrame` に直書きされていた DDA ループ本体を関数化したもの。
 * `initRayMarch` + `advanceRayMarch` を内部で使い、壁判定（`isWall` / `getTile` クロージャ）と
 * 床高さ（`floorHeights` + 既存の `resolveFloorHeight` / `detectFloorStep`）を組み合わせる。
 *
 * 壁ヒット時の perpWallDist は「ヒットしたステップの `crossDepth`」と等価。元コードの
 * `sideDist - deltaDist` は、ヒット直前に加算済みの sideDist から deltaDist を引いて
 * 跨いだ瞬間の距離（= crossDepth）に戻す操作なので、ここでは crossDepth をそのまま使う。
 * `minDepth` 未満は `minDepth` にクランプ（0 除算近傍の発散ガード）。
 *
 * 段差は「両タイルとも非壁」のステップでのみ記録し、手前から `maxStepStairs` 個まで蓄積する
 * （DDA は手前→奥順に境界を跨ぐので、`length < maxStepStairs` で打ち切れば自動的に手前優先）。
 *
 * 入力契約:
 *  - `isWall` は範囲外を `true`（壁）、`getTile` は範囲外を既定タイルで返す責務を呼び出し側が持つ
 *  - `floorHeights` が `undefined` なら段差検出を丸ごとスキップ（`resolveFloorHeight` が常に 0 を
 *    返し `detectFloorStep` が必ず `null` になる無駄を、毎ステップの 2 lookup ごと省く早期 bailout）
 *  - `maxSteps` は最大ステップ数（想定: map の最大対角）。壁に当たらなければここで打ち切る
 *
 * @param maxStepStairs 段差レコードの上限（手前優先で打ち切り。元 `maxStepsPerColumn`）
 * @param minDepth      crossDepth / perpDist の極小クランプ閾値（元 `MIN_DEPTH`）
 * @param defaultTile   未ヒット時の `hitTile`（元 `TileType.TREE`）
 */
export function marchRay(params: {
  playerX: number
  playerY: number
  rayDirX: number
  rayDirY: number
  maxSteps: number
  maxStepStairs: number
  minDepth: number
  defaultTile: number
  isWall: (tx: number, ty: number) => boolean
  getTile: (tx: number, ty: number) => number
  floorHeights: number[][] | undefined
}): RayMarchResult {
  const {
    playerX,
    playerY,
    rayDirX,
    rayDirY,
    maxSteps,
    maxStepStairs,
    minDepth,
    defaultTile,
    isWall,
    getTile,
    floorHeights,
  } = params

  // 単一の scratch state を in-place で進める（per-step アロケーションを避けるホットパス）。
  const state = initRayMarch(playerX, playerY, rayDirX, rayDirY)
  const stepInfos: StepRecord[] = []
  const hasFloorHeights = floorHeights !== undefined

  for (let s = 0; s < maxSteps; s++) {
    stepRayInPlace(state)
    // 壁ヒット時は境界 = 壁面そのものなので段差は記録しない（壁の向こうの床は描かない）。
    if (isWall(state.mapX, state.mapY)) {
      const perp = state.crossDepth < minDepth ? minDepth : state.crossDepth
      return {
        hit: true,
        hitTile: getTile(state.mapX, state.mapY),
        side: state.side,
        mapX: state.mapX,
        mapY: state.mapY,
        perpDist: perp,
        stepInfos,
      }
    }
    // 両タイルとも非壁 → prev / next の床高さを比較して段差を検出。
    if (hasFloorHeights && stepInfos.length < maxStepStairs) {
      const prevFloorZ = resolveFloorHeight(floorHeights, state.prevMapX, state.prevMapY)
      const nextFloorZ = resolveFloorHeight(floorHeights, state.mapX, state.mapY)
      const step = detectFloorStep(prevFloorZ, nextFloorZ)
      if (step) {
        const depthClamped = state.crossDepth < minDepth ? minDepth : state.crossDepth
        stepInfos.push({ info: step, depth: depthClamped, side: state.side })
      }
    }
  }

  // maxSteps 到達（壁なし）。side / map は最後のステップの値。
  return {
    hit: false,
    hitTile: defaultTile,
    side: state.side,
    mapX: state.mapX,
    mapY: state.mapY,
    perpDist: null,
    stepInfos,
  }
}
