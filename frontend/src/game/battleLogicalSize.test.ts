import { describe, expect, it } from 'vitest'
import {
  BATTLE_LOGICAL_HEIGHT,
  BATTLE_LOGICAL_WIDTH,
  containRect,
  normalizeUiScale,
  parseBattleLogicalSize,
  resolveBattleFrame,
} from './battleLogicalSize'
import { computeSideBattleLayout, type Rect, type SideBattleLayout } from './battleLayout'

describe('battleLogicalSize (sit-by-me#52)', () => {
  it('parse: "1920x1080" だけが有効、それ以外は undefined（従来）', () => {
    expect(parseBattleLogicalSize('1920x1080')).toBe('1920x1080')
    for (const bad of [undefined, null, '1536x1024', '800x450', 1920, '']) {
      expect(parseBattleLogicalSize(bad)).toBeUndefined()
    }
  })

  it('frame: 指定なしは null、指定ありは 1920x1080 / uiScale 2.4', () => {
    expect(resolveBattleFrame(undefined)).toBeNull()
    expect(resolveBattleFrame('1920x1080')).toEqual({ width: 1920, height: 1080, uiScale: 2.4 })
    // 800x450 の設計値を 2.4 倍すると、ちょうど 1920x1080（16:9 のまま割り切れる）
    expect(800 * 2.4).toBe(BATTLE_LOGICAL_WIDTH)
    expect(450 * 2.4).toBe(BATTLE_LOGICAL_HEIGHT)
  })

  it('normalizeUiScale: 有限の正数以外は 1', () => {
    expect(normalizeUiScale(2.4)).toBe(2.4)
    for (const bad of [undefined, 0, -1, NaN, Infinity]) expect(normalizeUiScale(bad)).toBe(1)
  })

  const viewports: [string, number, number][] = [
    ['3:2', 1200, 800],
    ['16:9', 1280, 720],
    ['19.5:9', 1170, 540],
    ['20:9', 1200, 540],
  ]
  it.each(viewports)('containRect %s: 16:9 を等比で収め、crop せず中央寄せ', (_n, vw, vh) => {
    const r = containRect(vw, vh)
    expect(r.w / r.h).toBeCloseTo(16 / 9, 6)
    expect(r.w).toBeLessThanOrEqual(vw + 1e-9)
    expect(r.h).toBeLessThanOrEqual(vh + 1e-9)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    // どちらか一辺は viewport にぴったり接する（contain）
    expect(Math.abs(r.w - vw) < 1e-6 || Math.abs(r.h - vh) < 1e-6).toBe(true)
    expect(r.x * 2 + r.w).toBeCloseTo(vw, 6)
    expect(r.y * 2 + r.h).toBeCloseTo(vh, 6)
  })

  it('containRect: 不正な viewport は 0 矩形', () => {
    expect(containRect(0, 100).w).toBe(0)
    expect(containRect(NaN, 100).scale).toBe(0)
  })
})

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inside = (r: Rect, w: number, h: number): boolean =>
  r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= w + 1e-9 && r.y + r.h <= h + 1e-9

// 設計座標（800×450）での既存保証の再確認。1920×1080 の実描画寸法（根の scale 適用後）の検証は BattleScreenLogicalSize.test.ts
describe('設計座標 800×450 のレイアウト（既存保証の再確認）', () => {
  const compute = (enemyCount: number, partyCount: number): SideBattleLayout =>
    computeSideBattleLayout({
      width: 800,
      height: 450,
      partyCount,
      enemyCount,
      commandLayout: 'cross',
      enemyList: true,
    })

  it.each([
    [1, 1],
    [3, 2],
    [5, 4],
  ])('敵 %i / 味方 %i: 窓どうしが重ならず、コマンドセルが 800×450 の画面内にある', (e, p) => {
    const L = compute(e, p)
    const windows = [L.log, L.command, L.status, ...(L.enemyList ? [L.enemyList] : [])]
    for (const w of windows) expect(inside(w, 800, 450)).toBe(true)
    for (let i = 0; i < windows.length; i++)
      for (let j = i + 1; j < windows.length; j++)
        expect(overlap(windows[i], windows[j])).toBe(false)
    for (const c of L.commandCells) expect(inside(c, 800, 450)).toBe(true)
  })
})
