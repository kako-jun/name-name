import { describe, expect, it } from 'vitest'
import { computeWallYRange, projectNpcToScreen } from './raycastProjection'

describe('projectNpcToScreen', () => {
  // 共通のカメラ設定: player (5.5, 5.5)、dir = +x、FOV 60° 相当
  // dir = (1, 0), plane = (0, planeLen) の配置では
  //   det = -planeLen
  //   transformY = rx = npc.x - player.x
  //   transformX = ry / planeLen = (npc.y - player.y) / planeLen
  const player = { x: 5.5, y: 5.5 }
  const dir = { x: 1, y: 0 }
  const planeLen = Math.tan(Math.PI / 6) // fov/2 = 30°
  const plane = { x: 0, y: planeLen }
  const screen = { width: 800, height: 600 }
  const minDepth = 0.1

  it('背面の NPC は null（transformY ≤ 0.01）', () => {
    // player の真後ろ: npc は player の -x 方向 → transformY = -1.0
    const npc = { x: 4.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).toBeNull()
  })

  it('境界: transformY = 0.001 は背面カリングで null', () => {
    // rx = 0.001 ≤ 0.01 → 背面カリング対象。
    // 同一タイル判定を回避するため npc.y を別タイルに置く（floor(6.5)=6 ≠ floor(5.5)=5）
    const npc = { x: 5.501, y: 6.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).toBeNull()
  })

  it('境界: transformY = 0.02 は minDepth=0.1 でクランプ発動（spriteHeight = 6000）', () => {
    // rx = 0.02 > 0.01 → 背面カリングされない。
    // clampedDepth = max(0.02, 0.1) = 0.1 → spriteHeight = floor(600 / 0.1) = 6000
    const npc = { x: 5.52, y: 6.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).not.toBeNull()
    expect(result!.depth).toBeCloseTo(0.02, 5)
    expect(result!.spriteHeight).toBe(6000)
  })

  it('境界: transformY = 0.1 は minDepth=0.1 のちょうど境界（クランプ発動しても同じ値）', () => {
    // rx = 0.1、minDepth = 0.1 → clampedDepth = max(0.1, 0.1) = 0.1
    // spriteHeight = floor(600 / 0.1) = 6000（境界なのでクランプ有無に関わらず同値）
    const npc = { x: 5.6, y: 6.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).not.toBeNull()
    expect(result!.depth).toBeCloseTo(0.1, 5)
    expect(result!.spriteHeight).toBe(6000)
  })

  it('minDepth クランプが発動: 深度は生 transformY、サイズはクランプ深度で計算', () => {
    // npc = (6.1, 7.5) → rx = 0.6, ry = 2.0
    //   transformY = 0.6（生の深度、depth に格納される）
    //   minDepth = 1.0 を渡すと clampedDepth = max(0.6, 1.0) = 1.0
    //   spriteHeight = floor(600 / 1.0) = 600
    const npc = { x: 6.1, y: 7.5 }
    const largeMinDepth = 1.0
    const result = projectNpcToScreen(npc, player, dir, plane, screen, largeMinDepth)
    expect(result).not.toBeNull()
    expect(result!.depth).toBeCloseTo(0.6, 5)
    expect(result!.spriteHeight).toBe(600)
    expect(result!.spriteWidthPx).toBe(600)
  })

  it('通常距離: transformY = 1.0 → spriteHeight = 600, 正面 NPC は screenX = 400', () => {
    // transformY = rx = 1.0 → npc.x = 6.5
    // transformX = 0 → screenX = floor(800/2 * (1 + 0)) = 400
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).not.toBeNull()
    expect(result!.depth).toBeCloseTo(1.0, 5)
    expect(result!.spriteHeight).toBe(600)
    expect(result!.spriteWidthPx).toBe(600)
    expect(result!.screenX).toBe(400)
  })

  it('描画範囲は画面内にクランプされる', () => {
    // 正面 1.0 先の NPC の描画範囲検証
    //   drawStartY = floor(-600/2 + 600/2) = 0
    //   drawEndY   = floor( 600/2 + 600/2) = 600
    //   drawStartX = floor(-600/2 + 400) = 100
    //   drawEndX   = floor( 600/2 + 400) = 700
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).not.toBeNull()
    expect(result!.drawStartY).toBe(0)
    expect(result!.drawEndY).toBe(600)
    expect(result!.drawStartX).toBe(100)
    expect(result!.drawEndX).toBe(700)
  })

  it('同一タイル: null を返す', () => {
    // floor(5.8) = 5 = floor(5.5) かつ floor(5.8) = 5 = floor(5.5)
    const npc = { x: 5.8, y: 5.8 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    expect(result).toBeNull()
  })

  it('退化カメラ（det ≈ 0）: null を返す', () => {
    // plane が dir と平行 → det = plane.x * dir.y - dir.x * plane.y = 0
    const degeneratePlane = { x: 1, y: 0 }
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, degeneratePlane, screen, minDepth)
    expect(result).toBeNull()
  })
})

describe('computeWallYRange', () => {
  // 基準設定: h=480, lineHeight=200, wallHeight=1 のとき
  //   drawEndRaw   = floor(100 + 240) = 340
  //   drawStartRaw = floor(340 - 200) = 140
  // 地面位置（drawEnd）は wallHeight に依らず 340 で不変。
  // 注意: 本関数は Y 範囲を返すだけで、`drawEndY - drawStartY <= 0` のときの描画スキップは
  // 呼び出し側責務（RaycastRenderer.renderFrame の drawHeight 判定）。

  it('wallHeight=1 は従来挙動（中央±lineHeight/2）', () => {
    const range = computeWallYRange(200, 1, 480)
    expect(range.drawStartY).toBe(140)
    expect(range.drawEndY).toBe(340)
  })

  it('wallHeight=0.5 は上端が下がる（地面位置は不変）', () => {
    // drawStartRaw = floor(340 - 200*0.5) = 240
    const range = computeWallYRange(200, 0.5, 480)
    expect(range.drawStartY).toBe(240)
    expect(range.drawEndY).toBe(340)
  })

  it('wallHeight=1.5 は上端が上に伸びる', () => {
    // drawStartRaw = floor(340 - 200*1.5) = 40
    const range = computeWallYRange(200, 1.5, 480)
    expect(range.drawStartY).toBe(40)
    expect(range.drawEndY).toBe(340)
  })

  it('wallHeight=2 は上端が画面外クランプ', () => {
    // drawStartRaw = floor(340 - 200*2) = -60 → 0 にクランプ
    const range = computeWallYRange(200, 2, 480)
    expect(range.drawStartY).toBe(0)
    expect(range.drawEndY).toBe(340)
  })

  it('wallHeight=0 は drawStart === drawEnd（描画なし）', () => {
    // drawStartRaw = floor(340 - 0) = 340
    const range = computeWallYRange(200, 0, 480)
    expect(range.drawStartY).toBe(340)
    expect(range.drawEndY).toBe(340)
    expect(range.drawEndY - range.drawStartY).toBe(0)
  })

  it('wallHeight<0 は 0 扱い（drawStart===drawEnd）', () => {
    const range = computeWallYRange(200, -1, 480)
    expect(range.drawStartY).toBe(340)
    expect(range.drawEndY).toBe(340)
  })

  it('lineHeight が小さい（遠い壁）ケース: 中央付近に薄く収まる', () => {
    // h=480, lineHeight=20, wallHeight=1
    //   drawEndRaw   = floor(10 + 240) = 250
    //   drawStartRaw = floor(250 - 20) = 230
    const range = computeWallYRange(20, 1, 480)
    expect(range.drawStartY).toBe(230)
    expect(range.drawEndY).toBe(250)
  })

  it('lineHeight > h（近すぎる壁）で drawStart=0, drawEnd=h にクランプ', () => {
    // h=480, lineHeight=800, wallHeight=1
    //   drawEndRaw   = floor(400 + 240) = 640 → 480 にクランプ
    //   drawStartRaw = floor(640 - 800) = -160 → 0 にクランプ
    const range = computeWallYRange(800, 1, 480)
    expect(range.drawStartY).toBe(0)
    expect(range.drawEndY).toBe(480)
  })

  it('wallHeight=NaN は 0 扱い（drawStart===drawEnd）', () => {
    const range = computeWallYRange(200, Number.NaN, 480)
    expect(range.drawStartY).toBe(340)
    expect(range.drawEndY).toBe(340)
  })

  it('wallHeight=Infinity は 0 扱い', () => {
    const range = computeWallYRange(200, Number.POSITIVE_INFINITY, 480)
    expect(range.drawStartY).toBe(340)
    expect(range.drawEndY).toBe(340)
  })

  it('lineHeight=NaN は 0 扱い（drawStart===drawEnd=h/2）', () => {
    const range = computeWallYRange(Number.NaN, 1, 480)
    // safeLineHeight=0 → drawEndRaw=floor(0+240)=240, drawStartRaw=floor(240-0)=240
    expect(range.drawStartY).toBe(240)
    expect(range.drawEndY).toBe(240)
  })

  it('lineHeight<0 は 0 扱い', () => {
    const range = computeWallYRange(-100, 1, 480)
    expect(range.drawStartY).toBe(240)
    expect(range.drawEndY).toBe(240)
  })
})
