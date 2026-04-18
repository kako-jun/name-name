import { describe, expect, it } from 'vitest'
import { projectNpcToScreen } from './raycastProjection'

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
    const degenerateDir = { x: 1, y: 0 }
    const degeneratePlane = { x: 1, y: 0 } // dir と平行 → det = 0
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, degenerateDir, degeneratePlane, screen, minDepth)
    expect(result).toBeNull()
  })
})
