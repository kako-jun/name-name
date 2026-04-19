import { describe, expect, it } from 'vitest'
import {
  computeEffectiveFogMaxDist,
  computeFloorStepWallYRange,
  computeWallYRange,
  detectFloorStep,
  projectNpcToScreen,
  resolveCeilingHeight,
  resolveFloorHeight,
} from './raycastProjection'

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

describe('computeWallYRange (with pitch)', () => {
  // 基準: h=480, lineHeight=200, wallHeight=1
  //   pitch=0 → drawEndY=340, drawStartY=140
  //   pitchOffsetPx は baseY = h/2 + offset を動かし、上端・下端の両方に同じ量加わる

  it('pitchOffsetPx 未指定は従来挙動と同じ', () => {
    const a = computeWallYRange(200, 1, 480)
    const b = computeWallYRange(200, 1, 480, 0)
    expect(a.drawStartY).toBe(b.drawStartY)
    expect(a.drawEndY).toBe(b.drawEndY)
    expect(b.drawStartY).toBe(140)
    expect(b.drawEndY).toBe(340)
  })

  it('pitchOffsetPx > 0 で全体が下にシフト（視線が上向き）', () => {
    // baseY = 240 + 50 = 290 → drawEndY=floor(100+290)=390, drawStartY=floor(390-200)=190
    const range = computeWallYRange(200, 1, 480, 50)
    expect(range.drawEndY).toBe(390)
    expect(range.drawStartY).toBe(190)
  })

  it('pitchOffsetPx < 0 で全体が上にシフト（視線が下向き）', () => {
    // baseY = 240 - 50 = 190 → drawEndY=floor(100+190)=290, drawStartY=floor(290-200)=90
    const range = computeWallYRange(200, 1, 480, -50)
    expect(range.drawEndY).toBe(290)
    expect(range.drawStartY).toBe(90)
  })

  it('pitch で画面外に出ても [0, h] にクランプされ安全', () => {
    // h=480, pitch=+1000 → drawEndRaw=1340, drawStartRaw=1140 → 両方 480 にクランプ
    const range = computeWallYRange(200, 1, 480, 1000)
    expect(range.drawStartY).toBe(480)
    expect(range.drawEndY).toBe(480)
    // 反対方向（pitch=-1000）→ 両方 0 にクランプ
    const range2 = computeWallYRange(200, 1, 480, -1000)
    expect(range2.drawStartY).toBe(0)
    expect(range2.drawEndY).toBe(0)
  })

  it('pitchOffsetPx=NaN は 0 扱い', () => {
    // 0 扱いなので pitch 未指定と同値
    const range = computeWallYRange(200, 1, 480, Number.NaN)
    expect(range.drawStartY).toBe(140)
    expect(range.drawEndY).toBe(340)
  })

  it('pitchOffsetPx=Infinity は 0 扱い', () => {
    const range = computeWallYRange(200, 1, 480, Number.POSITIVE_INFINITY)
    expect(range.drawStartY).toBe(140)
    expect(range.drawEndY).toBe(340)
  })

  it('pitch と wallHeight の合成: pitchOffsetPx > 0 + wallHeight=1.5', () => {
    // baseY=290 → drawEndY=floor(100+290)=390, drawStartY=floor(390-200*1.5)=90
    const range = computeWallYRange(200, 1.5, 480, 50)
    expect(range.drawEndY).toBe(390)
    expect(range.drawStartY).toBe(90)
  })
})

describe('projectNpcToScreen (with pitch)', () => {
  const player = { x: 5.5, y: 5.5 }
  const dir = { x: 1, y: 0 }
  const planeLen = Math.tan(Math.PI / 6)
  const plane = { x: 0, y: planeLen }
  const screen = { width: 800, height: 600 }
  const minDepth = 0.1

  it('pitchOffsetPx 未指定は従来挙動と同じ（透過互換）', () => {
    const npc = { x: 6.5, y: 5.5 }
    const a = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    const b = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 0)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.drawStartY).toBe(a!.drawStartY)
    expect(b!.drawEndY).toBe(a!.drawEndY)
    expect(b!.screenX).toBe(a!.screenX)
  })

  it('pitchOffsetPx > 0 で Y 範囲が下にシフト', () => {
    // 通常: drawStartY=0, drawEndY=600（spriteHeight=600, h=600, baseY=300）
    // pitch=+50 → baseY=350 → drawStart=floor(-300+350)=50, drawEnd=floor(300+350)=650 → 600 クランプ
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 50)
    expect(result).not.toBeNull()
    expect(result!.drawStartY).toBe(50)
    expect(result!.drawEndY).toBe(600)
    // X 系は pitch に影響されない
    expect(result!.screenX).toBe(400)
    expect(result!.drawStartX).toBe(100)
    expect(result!.drawEndX).toBe(700)
  })

  it('pitchOffsetPx < 0 で Y 範囲が上にシフト', () => {
    // pitch=-50 → baseY=250 → drawStart=floor(-300+250)=-50→0, drawEnd=floor(300+250)=550
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, -50)
    expect(result).not.toBeNull()
    expect(result!.drawStartY).toBe(0)
    expect(result!.drawEndY).toBe(550)
  })

  it('pitchOffsetPx=NaN は 0 扱い', () => {
    const npc = { x: 6.5, y: 5.5 }
    const a = projectNpcToScreen(npc, player, dir, plane, screen, minDepth)
    const b = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, Number.NaN)
    expect(b!.drawStartY).toBe(a!.drawStartY)
    expect(b!.drawEndY).toBe(a!.drawEndY)
  })

  it('pitch で画面外に出ても [0, h] にクランプ', () => {
    // 巨大 pitch でも drawStart/End が [0, h] に収まる
    const npc = { x: 6.5, y: 5.5 }
    const big = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 10000)
    expect(big!.drawStartY).toBe(600)
    expect(big!.drawEndY).toBe(600)
    const negBig = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, -10000)
    expect(negBig!.drawStartY).toBe(0)
    expect(negBig!.drawEndY).toBe(0)
  })
})

describe('computeWallYRange (with combined offset for jump)', () => {
  // Issue #80 Phase 2-2: pitchOffsetPx 引数は「pitch 由来 + cameraZ（ジャンプ）由来」の合算値を受け取る。
  // 関数自体は合算後の単一スカラとしか扱わないが、呼び出し側で
  //   pitchOffsetPx + cameraZOffsetPx = 合算 Y オフセット
  // という運用になることを契約として明示するための境界値テスト。
  // 基準: h=480, lineHeight=200, wallHeight=1
  //   合算 0 → drawEndY=340, drawStartY=140

  it('合算オフセット（pitch+30, cameraZ+30 → total 60）が単独値と同じ結果になる', () => {
    // 合算 60 → baseY=300 → drawEndY=floor(100+300)=400, drawStartY=floor(400-200)=200
    const combined = computeWallYRange(200, 1, 480, 60)
    expect(combined.drawEndY).toBe(400)
    expect(combined.drawStartY).toBe(200)
    // 関数は合算スカラだけ見るので、pitch=60 単独でも同値
    const single = computeWallYRange(200, 1, 480, 60)
    expect(combined.drawEndY).toBe(single.drawEndY)
    expect(combined.drawStartY).toBe(single.drawStartY)
  })

  it('大きな合算（pitch=50 + cameraZ=100 → total 150）でも [0, h] にクランプ', () => {
    // baseY=240+150=390 → drawEndRaw=floor(100+390)=490 → 480, drawStartRaw=floor(490-200)=290
    const range = computeWallYRange(200, 1, 480, 150)
    expect(range.drawEndY).toBe(480)
    expect(range.drawStartY).toBe(290)
  })

  it('負の合算（pitch=-30 + cameraZ=0 → total -30）も従来通り上シフト', () => {
    // baseY=210 → drawEndY=floor(100+210)=310, drawStartY=floor(310-200)=110
    const range = computeWallYRange(200, 1, 480, -30)
    expect(range.drawEndY).toBe(310)
    expect(range.drawStartY).toBe(110)
  })

  it('呼び出し側合算が NaN になっても関数自体は 0 扱いで防御', () => {
    // ジャンプ計算で playerZ が NaN になり cameraZOffsetPx=NaN、合算 pitch+NaN=NaN を渡されるケース
    const range = computeWallYRange(200, 1, 480, Number.NaN)
    expect(range.drawEndY).toBe(340)
    expect(range.drawStartY).toBe(140)
  })

  it('合算とジャンプ最大値（playerZ=0.375 → cameraZOffsetPx=90, h=480）でも安全', () => {
    // jumpInitialV=3, gravity=12 → 最高到達 = 9/24 = 0.375 タイル → cameraZOffsetPx = 0.375 * 240 = 90
    // pitch=0 でも合算=90 → baseY=330 → drawEndY=floor(100+330)=430, drawStartY=floor(430-200)=230
    const range = computeWallYRange(200, 1, 480, 90)
    expect(range.drawEndY).toBe(430)
    expect(range.drawStartY).toBe(230)
  })
})

describe('projectNpcToScreen (with combined offset for jump)', () => {
  // Issue #80 Phase 2-2: 合算オフセット（pitch + cameraZ）を NPC 射影でも検証
  const player = { x: 5.5, y: 5.5 }
  const dir = { x: 1, y: 0 }
  const planeLen = Math.tan(Math.PI / 6)
  const plane = { x: 0, y: planeLen }
  const screen = { width: 800, height: 600 }
  const minDepth = 0.1

  it('合算オフセット（pitch+30, cameraZ+30 → total 60）でも単独値と同じ Y シフト', () => {
    // 通常: drawStartY=0, drawEndY=600（spriteHeight=600, baseY=300）
    // 合算 60 → baseY=360 → drawStart=floor(-300+360)=60, drawEnd=floor(300+360)=660 → 600 クランプ
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 60)
    expect(result).not.toBeNull()
    expect(result!.drawStartY).toBe(60)
    expect(result!.drawEndY).toBe(600)
  })

  it('大きな合算（pitch=50 + cameraZ=100 → total 150）でも [0, h] にクランプ', () => {
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 150)
    expect(result).not.toBeNull()
    expect(result!.drawStartY).toBe(150)
    expect(result!.drawEndY).toBe(600)
  })

  it('呼び出し側合算が NaN になっても 0 扱いで防御', () => {
    const npc = { x: 6.5, y: 5.5 }
    const a = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 0)
    const b = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, Number.NaN)
    expect(b!.drawStartY).toBe(a!.drawStartY)
    expect(b!.drawEndY).toBe(a!.drawEndY)
  })

  it('ジャンプ最大相当（cameraZOffsetPx=90, h=600 ベース）でも整合', () => {
    // h=600 環境では cameraZOffsetPx = 0.375 * 300 = 112.5 → round=113
    // baseY=300+113=413 → drawStart=floor(-300+413)=113, drawEnd=floor(300+413)=713 → 600 クランプ
    const npc = { x: 6.5, y: 5.5 }
    const result = projectNpcToScreen(npc, player, dir, plane, screen, minDepth, 113)
    expect(result).not.toBeNull()
    expect(result!.drawStartY).toBe(113)
    expect(result!.drawEndY).toBe(600)
  })
})

describe('computeEffectiveFogMaxDist', () => {
  // 基準: baseFogMaxDist = 12（RaycastRenderer の実値）
  const base = 12

  it('wallHeight=1 は base と等しい（通常の壁は従来挙動）', () => {
    expect(computeEffectiveFogMaxDist(base, 1)).toBe(base)
  })

  it('wallHeight=0.5（低い壁）も base と等しい（Math.max(1, 0.5)=1 相当）', () => {
    // 低い壁は遠方視認距離を広げない。通常の壁と同じ距離で消える
    expect(computeEffectiveFogMaxDist(base, 0.5)).toBe(base)
  })

  it('wallHeight=1.5 は base * 1.5（塔がランドマークとして遠くまで見える）', () => {
    expect(computeEffectiveFogMaxDist(base, 1.5)).toBe(base * 1.5)
  })

  it('wallHeight=2 は base * 2', () => {
    expect(computeEffectiveFogMaxDist(base, 2)).toBe(base * 2)
  })

  it('wallHeight=0 は base 扱い（防御）', () => {
    expect(computeEffectiveFogMaxDist(base, 0)).toBe(base)
  })

  it('wallHeight=負値 は base 扱い（防御）', () => {
    expect(computeEffectiveFogMaxDist(base, -1)).toBe(base)
  })

  it('wallHeight=NaN は base 扱い（防御）', () => {
    expect(computeEffectiveFogMaxDist(base, Number.NaN)).toBe(base)
  })

  it('wallHeight=Infinity は base 扱い（防御）', () => {
    expect(computeEffectiveFogMaxDist(base, Number.POSITIVE_INFINITY)).toBe(base)
  })

  it('wallHeight=-Infinity も base 扱い（防御、wallHeight<=1 ルートに乗る）', () => {
    expect(computeEffectiveFogMaxDist(base, Number.NEGATIVE_INFINITY)).toBe(base)
  })
})

describe('resolveFloorHeight', () => {
  // Issue #84: 床高さグリッドから指定タイルの床高さを返す純粋関数。
  // `getWallHeight` と異なり fallback は 0（地面）。負値はそのまま返す（沈み込みを許容）。

  it('grid=undefined は 0 を返す', () => {
    expect(resolveFloorHeight(undefined, 0, 0)).toBe(0)
  })

  it('通常の正値はそのまま返す', () => {
    const grid = [[0.5]]
    expect(resolveFloorHeight(grid, 0, 0)).toBe(0.5)
  })

  it('範囲外インデックス（x >= width）は 0 を返す', () => {
    const grid = [
      [0.5, 1.0],
      [0.25, 0.75],
    ]
    expect(resolveFloorHeight(grid, 5, 0)).toBe(0)
  })

  it('範囲外インデックス（y >= height）は 0 を返す', () => {
    const grid = [[0.5, 1.0]]
    expect(resolveFloorHeight(grid, 0, 5)).toBe(0)
  })

  it('行が未定義（sparse）なら 0 を返す', () => {
    const grid: number[][] = []
    grid[2] = [0.5]
    // 行 0 は未定義
    expect(resolveFloorHeight(grid, 0, 0)).toBe(0)
    // 行 2 の 0 列目は 0.5
    expect(resolveFloorHeight(grid, 0, 2)).toBe(0.5)
  })

  it('セルが NaN なら 0 を返す', () => {
    const grid = [[Number.NaN]]
    expect(resolveFloorHeight(grid, 0, 0)).toBe(0)
  })

  it('セルが Infinity なら 0 を返す', () => {
    const grid = [[Number.POSITIVE_INFINITY]]
    expect(resolveFloorHeight(grid, 0, 0)).toBe(0)
  })

  it('負値はそのまま返す（沈み込み表現を許容）', () => {
    const grid = [[-0.5]]
    expect(resolveFloorHeight(grid, 0, 0)).toBe(-0.5)
  })

  it('負のインデックスは 0 を返す', () => {
    const grid = [[0.5]]
    expect(resolveFloorHeight(grid, -1, 0)).toBe(0)
    expect(resolveFloorHeight(grid, 0, -1)).toBe(0)
  })
})

describe('resolveCeilingHeight', () => {
  // Issue #87: 天井高さグリッドから指定タイルの天井高さを返す純粋関数。
  // `getWallHeight` と同じ設計（fallback=1）。`resolveFloorHeight`（fallback=0、負値許容）と対照。
  // 0 以下も 1 フォールバック（天井が床より下の退化ケースで頭ぶつけ判定が破綻するのを防ぐ）。

  it('grid=undefined は 1 を返す（標準天井）', () => {
    expect(resolveCeilingHeight(undefined, 0, 0)).toBe(1)
  })

  it('通常の正値（低天井 0.5）はそのまま返す', () => {
    const grid = [[0.5]]
    expect(resolveCeilingHeight(grid, 0, 0)).toBe(0.5)
  })

  it('1 より大きい値もそのまま返す（高天井）', () => {
    const grid = [[2.5]]
    expect(resolveCeilingHeight(grid, 0, 0)).toBe(2.5)
  })

  it('範囲外インデックス（x >= width）は 1 を返す', () => {
    const grid = [
      [0.5, 0.5],
      [0.5, 0.5],
    ]
    expect(resolveCeilingHeight(grid, 5, 0)).toBe(1)
  })

  it('範囲外インデックス（y >= height）は 1 を返す', () => {
    const grid = [[0.5, 0.5]]
    expect(resolveCeilingHeight(grid, 0, 5)).toBe(1)
  })

  it('行が未定義（sparse）なら 1 を返す', () => {
    const grid: number[][] = []
    grid[2] = [0.5]
    // 行 0 は未定義 → 1
    expect(resolveCeilingHeight(grid, 0, 0)).toBe(1)
    // 行 2 の 0 列目は 0.5
    expect(resolveCeilingHeight(grid, 0, 2)).toBe(0.5)
  })

  it('セルが NaN なら 1 を返す', () => {
    const grid = [[Number.NaN]]
    expect(resolveCeilingHeight(grid, 0, 0)).toBe(1)
  })

  it('セルが Infinity なら 1 を返す', () => {
    const grid = [[Number.POSITIVE_INFINITY]]
    expect(resolveCeilingHeight(grid, 0, 0)).toBe(1)
  })

  it('0 以下の値は 1 にフォールバック（退化ケース防御）', () => {
    expect(resolveCeilingHeight([[0]], 0, 0)).toBe(1)
    expect(resolveCeilingHeight([[-0.5]], 0, 0)).toBe(1)
    expect(resolveCeilingHeight([[Number.NEGATIVE_INFINITY]], 0, 0)).toBe(1)
  })

  it('負のインデックスは 1 を返す', () => {
    const grid = [[0.5]]
    expect(resolveCeilingHeight(grid, -1, 0)).toBe(1)
    expect(resolveCeilingHeight(grid, 0, -1)).toBe(1)
  })
})

describe('detectFloorStep', () => {
  // Issue #88 Phase 2-7a: 隣接タイルの床高さから段差壁面情報を返す

  it('同じ高さなら null', () => {
    expect(detectFloorStep(0, 0)).toBeNull()
    expect(detectFloorStep(0.5, 0.5)).toBeNull()
  })

  it('ごく微小な差（1e-7）は null（浮動小数雑音吸収）', () => {
    expect(detectFloorStep(0.5, 0.5 + 1e-7)).toBeNull()
  })

  it('prev が高い場合、upperSide=prev', () => {
    const step = detectFloorStep(0.5, 0)
    expect(step).not.toBeNull()
    expect(step!.lowerZ).toBe(0)
    expect(step!.upperZ).toBe(0.5)
    expect(step!.heightDiff).toBeCloseTo(0.5, 6)
    expect(step!.upperSide).toBe('prev')
  })

  it('next が高い場合、upperSide=next', () => {
    const step = detectFloorStep(0, 0.5)
    expect(step).not.toBeNull()
    expect(step!.lowerZ).toBe(0)
    expect(step!.upperZ).toBe(0.5)
    expect(step!.heightDiff).toBeCloseTo(0.5, 6)
    expect(step!.upperSide).toBe('next')
  })

  it('負の床（沈み込み）と地面の段差も正しく認識', () => {
    const step = detectFloorStep(-0.3, 0)
    expect(step).not.toBeNull()
    expect(step!.lowerZ).toBe(-0.3)
    expect(step!.upperZ).toBe(0)
    expect(step!.heightDiff).toBeCloseTo(0.3, 6)
    expect(step!.upperSide).toBe('next')
  })

  it('NaN 入力は null（防御）', () => {
    expect(detectFloorStep(Number.NaN, 0)).toBeNull()
    expect(detectFloorStep(0, Number.NaN)).toBeNull()
  })

  it('Infinity 入力は null（防御）', () => {
    expect(detectFloorStep(Number.POSITIVE_INFINITY, 0)).toBeNull()
    expect(detectFloorStep(0, Number.NEGATIVE_INFINITY)).toBeNull()
  })

  // S5 境界値追加テスト
  it('大差（+5 / -5）も正しく認識', () => {
    const step = detectFloorStep(5, -5)
    expect(step).not.toBeNull()
    expect(step!.lowerZ).toBe(-5)
    expect(step!.upperZ).toBe(5)
    expect(step!.heightDiff).toBeCloseTo(10, 6)
    expect(step!.upperSide).toBe('prev')
  })

  it('0 と -0 は同値なので null（符号差のみの浮動小数ノイズ吸収）', () => {
    // Math.abs(0 - (-0)) === 0 < 1e-6
    expect(detectFloorStep(0, -0)).toBeNull()
  })

  it('差がちょうど閾値 1e-6 なら null（< 1e-6 なので 1e-6 自体は境界で null にならず段差扱い）', () => {
    // 実装は `if (diff < 1e-6) return null` なので 1e-6 ちょうどは「null ではなく段差あり」
    // 境界を明示するための回帰テスト
    const step = detectFloorStep(0, 1e-6)
    expect(step).not.toBeNull()
    expect(step!.heightDiff).toBeCloseTo(1e-6, 12)
  })

  it('差が 1e-6 より小さい（1e-7）なら null', () => {
    expect(detectFloorStep(0.1, 0.1 + 1e-7)).toBeNull()
  })
})

describe('computeFloorStepWallYRange', () => {
  // Issue #88 Phase 2-7a: 段差壁面の Y 範囲を返す
  // 基準: h=480, lineHeight=200, pitch=0
  //   通常の壁（lowerZ=0, upperZ=1）の基準地面位置は floor(100 + 240) = 340

  it('lowerZ=0, upperZ=1 は computeWallYRange(lineHeight, 1, h) と同じ', () => {
    // 段差の下端=地面(340)、上端=140
    const step = computeFloorStepWallYRange(200, 0, 1, 480)
    const wall = computeWallYRange(200, 1, 480)
    expect(step.drawStartY).toBe(wall.drawStartY)
    expect(step.drawEndY).toBe(wall.drawEndY)
  })

  it('lowerZ=0, upperZ=0.5 は半段の段差壁', () => {
    // drawEndRaw = floor(100 + 240 - 0) = 340
    // drawStartRaw = floor(100 + 240 - 200*0.5) = 240
    const range = computeFloorStepWallYRange(200, 0, 0.5, 480)
    expect(range.drawEndY).toBe(340)
    expect(range.drawStartY).toBe(240)
  })

  it('lowerZ=0.25, upperZ=0.75 は中間にある半段段差', () => {
    // drawEndRaw = floor(340 - 200*0.25) = 290
    // drawStartRaw = floor(340 - 200*0.75) = 190
    const range = computeFloorStepWallYRange(200, 0.25, 0.75, 480)
    expect(range.drawEndY).toBe(290)
    expect(range.drawStartY).toBe(190)
  })

  it('upperZ <= lowerZ は drawStart === drawEnd（描画なし）', () => {
    const range = computeFloorStepWallYRange(200, 0.5, 0.5, 480)
    expect(range.drawStartY).toBe(range.drawEndY)
    const range2 = computeFloorStepWallYRange(200, 0.7, 0.5, 480)
    expect(range2.drawStartY).toBe(range2.drawEndY)
  })

  it('lineHeight=0 は drawStart === drawEnd（h/2 位置）', () => {
    const range = computeFloorStepWallYRange(0, 0, 1, 480)
    expect(range.drawStartY).toBe(240)
    expect(range.drawEndY).toBe(240)
  })

  it('pitchOffsetPx > 0 で全体が下にシフト', () => {
    // baseY = 240+50=290 → drawEndRaw=floor(100+290)=390, drawStartRaw=floor(390-100)=290
    const range = computeFloorStepWallYRange(200, 0, 0.5, 480, 50)
    expect(range.drawEndY).toBe(390)
    expect(range.drawStartY).toBe(290)
  })

  it('pitchOffsetPx < 0 で全体が上にシフト', () => {
    // baseY=190 → drawEndRaw=floor(100+190)=290, drawStartRaw=floor(290-100)=190
    const range = computeFloorStepWallYRange(200, 0, 0.5, 480, -50)
    expect(range.drawEndY).toBe(290)
    expect(range.drawStartY).toBe(190)
  })

  it('画面外は [0, h] にクランプ', () => {
    // 極端な pitch で下端が h を超える
    const range = computeFloorStepWallYRange(200, 0, 0.5, 480, 1000)
    expect(range.drawStartY).toBe(480)
    expect(range.drawEndY).toBe(480)
    const range2 = computeFloorStepWallYRange(200, 0, 0.5, 480, -1000)
    expect(range2.drawStartY).toBe(0)
    expect(range2.drawEndY).toBe(0)
  })

  it('NaN / Infinity 入力は 0 扱い（防御）', () => {
    // lineHeight NaN → safeLineHeight=0 → 両端 h/2
    const a = computeFloorStepWallYRange(Number.NaN, 0, 0.5, 480)
    expect(a.drawStartY).toBe(240)
    expect(a.drawEndY).toBe(240)
    // lowerZ/upperZ NaN → それぞれ 0 扱い
    const b = computeFloorStepWallYRange(200, Number.NaN, Number.NaN, 480)
    expect(b.drawStartY).toBe(b.drawEndY)
    // pitch NaN → 0 扱いで基準通り
    const c = computeFloorStepWallYRange(200, 0, 0.5, 480, Number.NaN)
    expect(c.drawEndY).toBe(340)
    expect(c.drawStartY).toBe(240)
  })

  it('負の lowerZ（沈み込みから地面への段差）も正しく描画', () => {
    // lowerZ=-0.25, upperZ=0 → 下端は地面より下
    // drawEndRaw = floor(340 - 200*(-0.25)) = floor(390) = 390
    // drawStartRaw = floor(340 - 0) = 340
    const range = computeFloorStepWallYRange(200, -0.25, 0, 480)
    expect(range.drawEndY).toBe(390)
    expect(range.drawStartY).toBe(340)
  })
})
