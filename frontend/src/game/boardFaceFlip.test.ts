/**
 * boardFaceFlip（大道具・背景板の面の切り替え #704）の純粋ロジックとランのテスト。
 * 角度の数式そのものは boardFlip.test.ts が担保済み。ここでは「旧面・新面への振り分け」「境界」
 * 「回転を出してよいかの条件」「mesh の寿命」を縛る。
 */
import { describe, expect, it, vi } from 'vitest'
import { BufferImageSource, Texture } from 'pixi.js'
import {
  BoardFaceFlipRun,
  computeBoardFaceFlipFrames,
  isBoardFaceFlipEnabled,
  type BoardFaceFlipConditions,
} from './boardFaceFlip'
import { BOARD_FLIP_MAX_ANGLE_RAD, computeBoardFlipCorners } from './boardFlip'

const OLD = { x: 400, y: 225, width: 800, height: 450 }
const NEW = { x: 300, y: 200, width: 400, height: 300 }

function tex(w = 8, h = 8): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(w * h * 4), width: w, height: h }),
  })
}

const base: BoardFaceFlipConditions = {
  isTheater: true,
  skip: false,
  exporting: false,
  reducedMotion: false,
  durationMs: 700,
}

describe('isBoardFaceFlipEnabled', () => {
  it('シアターで他の抑止条件が無く時間が正なら回す', () => {
    expect(isBoardFaceFlipEnabled(base)).toBe(true)
  })
  it.each([
    ['ノベル', { isTheater: false }],
    ['スキップ', { skip: true }],
    ['動画書き出し', { exporting: true }],
    ['prefers-reduced-motion', { reducedMotion: true }],
    ['時間 0', { durationMs: 0 }],
    ['時間が負', { durationMs: -1 }],
    ['時間が NaN', { durationMs: Number.NaN }],
    ['時間が Infinity', { durationMs: Number.POSITIVE_INFINITY }],
  ])('%s では回さない（即時切替）', (_name, patch) => {
    expect(isBoardFaceFlipEnabled({ ...base, ...patch })).toBe(false)
  })
})

describe('computeBoardFaceFlipFrames', () => {
  it('開始 (0): 旧面は可視・角度 0（正面）、新面は不可視', () => {
    const f = computeBoardFaceFlipFrames(0, 1000, OLD, NEW)
    expect(f.old.visible).toBe(true)
    expect(f.next.visible).toBe(false)
    expect(f.next.corners).toBeNull()
    const c = computeBoardFlipCorners(OLD.x, OLD.y + OLD.height / 2, OLD.width, OLD.height, 0)
    expect(f.old.corners).toEqual(c)
    // 角度 0 は元の矩形そのもの。
    expect(c.x0).toBeCloseTo(OLD.x - OLD.width / 2)
    expect(c.x2).toBeCloseTo(OLD.x + OLD.width / 2)
  })

  it('前半の途中: 旧面だけが回って細くなり、新面はまだ出ない', () => {
    const f = computeBoardFaceFlipFrames(250, 1000, OLD, NEW)
    expect(f.old.visible).toBe(true)
    expect(f.next.visible).toBe(false)
    const w = f.old.corners!.x1 - f.old.corners!.x0
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThan(OLD.width)
  })

  it('半分ちょうど (0.5): 旧面が消え、新面が現れる（空白フレームなし）', () => {
    const f = computeBoardFaceFlipFrames(500, 1000, OLD, NEW)
    expect(f.old.visible).toBe(false)
    expect(f.old.corners).toBeNull()
    expect(f.next.visible).toBe(true)
    // 現れる瞬間は縁がほぼ見えない細さ（-90° 付近）で、頂点は有限。
    const c = f.next.corners!
    for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true)
    expect(c.x1 - c.x0).toBeLessThan(NEW.width * 0.05)
  })

  it('終了 (1) 以降: 新面は正面（元の矩形）、旧面は不可視', () => {
    for (const t of [1000, 1500]) {
      const f = computeBoardFaceFlipFrames(t, 1000, OLD, NEW)
      expect(f.old.visible).toBe(false)
      expect(f.next.visible).toBe(true)
      const c = f.next.corners!
      expect(c.x0).toBeCloseTo(NEW.x - NEW.width / 2)
      expect(c.x1).toBeCloseTo(NEW.x + NEW.width / 2)
      expect(c.y0).toBeCloseTo(NEW.y - NEW.height / 2)
      expect(c.y2).toBeCloseTo(NEW.y + NEW.height / 2)
    }
  })

  it('旧面と新面は各自の配置で描かれる（片方の寸法を他方に使わない）', () => {
    const early = computeBoardFaceFlipFrames(10, 1000, OLD, NEW).old.corners!
    expect(early.x1 - early.x0).toBeGreaterThan(NEW.width)
    const late = computeBoardFaceFlipFrames(990, 1000, OLD, NEW).next.corners!
    expect(late.x1 - late.x0).toBeLessThanOrEqual(NEW.width)
  })

  it('新面の角度は -MAX..0、旧面の角度は 0..MAX の範囲に収まる（縁が反転しない）', () => {
    for (let t = 0; t <= 1000; t += 50) {
      const f = computeBoardFaceFlipFrames(t, 1000, OLD, NEW)
      for (const fr of [f.old, f.next]) {
        if (!fr.corners) continue
        expect(fr.corners.x1).toBeGreaterThanOrEqual(fr.corners.x0)
      }
    }
    expect(BOARD_FLIP_MAX_ANGLE_RAD).toBeLessThan(Math.PI / 2)
  })
})

describe('BoardFaceFlipRun', () => {
  it('update が旧面・新面の可視を時刻で切り替える', () => {
    const run = new BoardFaceFlipRun(tex(), tex(), OLD, NEW, 100, 1000)
    run.update(100)
    expect(run.oldMesh.visible).toBe(true)
    expect(run.newMesh.visible).toBe(false)
    run.update(700)
    expect(run.oldMesh.visible).toBe(false)
    expect(run.newMesh.visible).toBe(true)
    run.dispose()
  })

  it('isFinished は開始から所要時間ちょうどで true', () => {
    const run = new BoardFaceFlipRun(tex(), tex(), OLD, NEW, 100, 1000)
    expect(run.isFinished(1099)).toBe(false)
    expect(run.isFinished(1100)).toBe(true)
    run.dispose()
  })

  it('dispose は mesh と geometry を破棄し、2 回呼んでも安全。破棄後の update は何もしない', () => {
    const run = new BoardFaceFlipRun(tex(), tex(), OLD, NEW, 0, 1000)
    const spies = [
      vi.spyOn(run.oldMesh.geometry, 'destroy'),
      vi.spyOn(run.newMesh.geometry, 'destroy'),
    ]
    run.dispose()
    expect(run.oldMesh.destroyed).toBe(true)
    expect(run.newMesh.destroyed).toBe(true)
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1)
    expect(() => run.dispose()).not.toThrow()
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1)
    expect(() => run.update(500)).not.toThrow()
  })

  it('setFilters は両方の mesh に付く', () => {
    const run = new BoardFaceFlipRun(tex(), tex(), OLD, NEW, 0, 1000)
    const f = { fake: true } as never
    run.setFilters([f])
    expect(run.oldMesh.filters).toEqual([f])
    expect(run.newMesh.filters).toEqual([f])
    run.setFilters(null)
    expect(run.oldMesh.filters).toBeNull()
    run.dispose()
  })
})
