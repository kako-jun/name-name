import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BATTLE_TRANSITION_PARAMS as P,
  normalizeBattleTransition,
  sampleEnter,
  sampleExit,
} from './battleTransition'

describe('normalizeBattleTransition (#830)', () => {
  it.each([
    ['ff', 'ff'],
    [' FF ', 'ff'],
    ['none', 'none'],
    ['', 'none'],
    [null, 'none'],
    [undefined, 'none'],
    ['zoom', 'none'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeBattleTransition(raw)).toBe(expected)
  })
})

describe('sampleEnter (#830)', () => {
  it('始まりの瞬間に 1 段目が始まり、倍率は等倍・透明から動き出す', () => {
    const s = sampleEnter(0, P)
    expect(s.stage).toBe(1)
    expect(s.zoom).toBe(1)
    expect(s.alpha).toBe(0)
    expect(s.done).toBe(false)
  })

  it('負の経過時間は 0 として扱う', () => {
    expect(sampleEnter(-50, P)).toEqual(sampleEnter(0, P))
  })

  it('各段の easeMs 後にその段のズーム・暗さに達する', () => {
    const [a, b] = P.enterStages
    const s1 = sampleEnter(a.startMs + a.easeMs, P)
    expect(s1.stage).toBe(1)
    expect(s1.zoom).toBeCloseTo(a.zoom)
    expect(s1.alpha).toBeCloseTo(a.dark)
    const s2 = sampleEnter(b.startMs + b.easeMs, P)
    expect(s2.stage).toBe(2)
    expect(s2.zoom).toBeCloseTo(b.zoom)
    expect(s2.alpha).toBeCloseTo(b.dark)
  })

  it('2 段目の始まりで段の番号が 2 になる（音のきっかけが 2 回に分かれる）', () => {
    const b = P.enterStages[1]
    expect(sampleEnter(b.startMs - 1, P).stage).toBe(1)
    expect(sampleEnter(b.startMs, P).stage).toBe(2)
  })

  const monoVariants = [
    P,
    { ...P, enterStages: [{ startMs: 0, zoom: 2.5, dark: 0.1, easeMs: 0 }], enterFadeStartMs: 50 },
    { ...P, enterFadeStartMs: 0, enterFadeMs: 0, enterBlackMs: 0 },
    { ...P, enterStages: [...P.enterStages, { startMs: 700, zoom: 3, dark: 0.8, easeMs: 300 }] },
  ]
  it.each(monoVariants.map((p, i) => [i, p] as const))(
    'ズームも暗さも単調に増える（パラメータ %i）',
    (_i, params) => {
      let z = 0
      let a = 0
      for (let t = 0; t <= 2000; t += 7) {
        const s = sampleEnter(t, params)
        expect(s.zoom).toBeGreaterThanOrEqual(z - 1e-9)
        expect(s.alpha).toBeGreaterThanOrEqual(a - 1e-9)
        z = s.zoom
        a = s.alpha
      }
    }
  )

  it('暗転が終わると真っ黒、真っ黒の待ちが済むと done', () => {
    const blackAt = P.enterFadeStartMs + P.enterFadeMs
    expect(sampleEnter(blackAt, P).alpha).toBe(1)
    expect(sampleEnter(blackAt, P).done).toBe(false)
    expect(sampleEnter(blackAt + P.enterBlackMs, P).done).toBe(true)
  })

  it('段・暗転のパラメータを差し替えられる（段なしでも暗転だけで終わる）', () => {
    const custom = { ...P, enterStages: [], enterFadeStartMs: 0, enterFadeMs: 100, enterBlackMs: 0 }
    expect(sampleEnter(0, custom).stage).toBe(0)
    expect(sampleEnter(50, custom).alpha).toBeCloseTo(0.5)
    expect(sampleEnter(100, custom).done).toBe(true)
  })
})

describe('sampleExit (#830)', () => {
  it('フェードアウト → 黒 → フェードイン → 終了、の順に進む', () => {
    expect(sampleExit(0, P, 0)).toEqual({ alpha: 0, phase: 'fadeOut', done: false })
    expect(sampleExit(P.exitFadeOutMs / 2, P, 0).alpha).toBeCloseTo(0.5)
    const black = sampleExit(P.exitFadeOutMs, P, 0)
    expect(black).toEqual({ alpha: 1, phase: 'black', done: false })
    const inStart = P.exitFadeOutMs + P.exitBlackMs
    const mid = sampleExit(inStart + P.exitFadeInMs / 2, P, 0)
    expect(mid.phase).toBe('fadeIn')
    expect(mid.alpha).toBeCloseTo(0.5)
    expect(sampleExit(inStart + P.exitFadeInMs, P, 0)).toEqual({
      alpha: 0,
      phase: 'fadeIn',
      done: true,
    })
  })

  it('追加画面の長さの分だけ黒が延びる（既定 0 なら延びない）', () => {
    const inStart = P.exitFadeOutMs + P.exitBlackMs
    expect(sampleExit(inStart + 1, P, 0).phase).toBe('fadeIn')
    expect(sampleExit(inStart + 1, P, 500).phase).toBe('black')
    expect(sampleExit(inStart + 500, P, 500).phase).toBe('fadeIn')
    expect(sampleExit(inStart + 500 + P.exitFadeInMs, P, 500).done).toBe(true)
  })

  it('負の追加画面の長さは 0 として扱う', () => {
    expect(sampleExit(P.exitFadeOutMs + P.exitBlackMs + 1, P, -300).phase).toBe('fadeIn')
  })
})
