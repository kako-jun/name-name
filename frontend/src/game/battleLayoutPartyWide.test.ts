import { describe, it, expect } from 'vitest'
import {
  SIDE_PARTY_STEP_MAX_RATIO,
  computeSideBattleLayout,
  normalizePartyLayout,
  partyDrawOverhang,
  type PartyLayout,
  type SideBattleLayout,
  type SideBattleLayoutInput,
} from './battleLayout'
import {
  normalizeEnemyGridExtent,
  normalizeEnemyWindowOverlapBottomSetting,
  type EnemyFootprint,
} from './enemyGrid'
import { DEFAULT_ACRYLIC_PARAMS } from './spriteStyle'

// 味方の並び battle_party_layout / 敵グリッドの広がり battle_enemy_grid_extent / 下のパネルへの重なり
// battle_enemy_window_overlap_bottom (#1178)。3 つは互いに独立で、不変条件（敵と味方が触れない・画面外へ出ない）だけを共有する

const EPS = 1e-6
const SIZES: Array<[number, number]> = [
  [320, 240],
  [640, 360],
  [800, 450],
  [1024, 768],
  [1280, 720],
  [1600, 1080],
  [480, 800],
  [1920, 1080],
]
const FOOTS: EnemyFootprint[] = [
  { col: 2, row: 0, w: 2, h: 2 },
  { col: 5, row: 1, w: 1, h: 1 },
  { col: 0, row: 0, w: 1, h: 1 },
  { col: 0, row: 1, w: 1, h: 1 },
]

interface Opt {
  party?: number
  back?: boolean
  cross?: boolean
  list?: boolean
  acrylic?: boolean
  lines?: number
  layout?: PartyLayout
  extent?: 'normal' | 'wide'
  bottom?: number
  top?: number
  grid?: { cols: number; rows: number }
  align?: 'center' | 'bottom'
  depth?: boolean
}
const build = (w: number, h: number, o: Opt = {}): SideBattleLayout => {
  const party = o.party ?? 4
  const input: SideBattleLayoutInput = {
    width: w,
    height: h,
    partyCount: party,
    enemyCount: FOOTS.length,
    commandCount: o.cross ? 4 : 8,
    partyRows: Array.from({ length: party }, (_, i) => (o.back && i % 2 === 1 ? 'back' : 'front')),
    enemyGrid: o.grid ?? { cols: 6, rows: 2 },
    enemyFootprints: FOOTS,
    enemyWindowOverlap: o.top ?? 0.5,
    enemyList: o.list ?? true,
    messageLines: o.lines ?? 1,
    ...(o.cross ? { commandLayout: 'cross' as const } : {}),
    ...(o.acrylic === false ? {} : { partyAcrylic: DEFAULT_ACRYLIC_PARAMS }),
    ...(o.layout ? { partyLayout: o.layout } : {}),
    ...(o.extent ? { enemyGridExtent: o.extent } : {}),
    ...(o.bottom !== undefined ? { enemyWindowOverlapBottom: o.bottom } : {}),
    ...(o.align ? { enemyGridAlign: o.align } : {}),
    ...(o.depth ? { depth: { horizon: 0.3, perspective: 0.5 } } : {}),
  }
  return computeSideBattleLayout(input)
}

describe('正規化 (#1178)', () => {
  it('battle_party_layout / battle_enemy_grid_extent: 未指定・空・不正は既定', () => {
    expect(normalizePartyLayout(undefined)).toBe('default')
    expect(normalizePartyLayout(' TALL ')).toBe('tall')
    expect(normalizePartyLayout('wide', false)).toBe('default')
    expect(normalizeEnemyGridExtent('')).toBe('normal')
    expect(normalizeEnemyGridExtent('Wide')).toBe('wide')
    expect(normalizeEnemyGridExtent('huge', false)).toBe('normal')
  })
  it('battle_enemy_window_overlap_bottom: 0〜0.5 に丸め、数値でなければ undefined', () => {
    expect(normalizeEnemyWindowOverlapBottomSetting('0.3')).toBe(0.3)
    expect(normalizeEnemyWindowOverlapBottomSetting('9')).toBe(0.5)
    expect(normalizeEnemyWindowOverlapBottomSetting('-1')).toBe(0)
    expect(normalizeEnemyWindowOverlapBottomSetting('abc')).toBeUndefined()
    expect(normalizeEnemyWindowOverlapBottomSetting(undefined)).toBeUndefined()
  })
})

describe('既定は従来と完全に同じ (#1178)', () => {
  it('default / normal / 0 を明示しても、未指定と一致（総当たり）', () => {
    let n = 0
    for (const [w, h] of SIZES)
      for (const party of [1, 4, 6])
        for (const back of [false, true])
          for (const cross of [false, true])
            for (const lines of [1, 4]) {
              const o = { party, back, cross, lines }
              expect(
                build(w, h, { ...o, layout: 'default', extent: 'normal', bottom: 0 }),
                JSON.stringify([w, h, o])
              ).toEqual(build(w, h, o))
              n++
            }
    expect(n).toBe(8 * 3 * 2 * 2 * 2)
  })
  it('グリッドなしでは 広がり・下の重なり は無関係', () => {
    for (const [w, h] of SIZES) {
      const base = { width: w, height: h, partyCount: 4, enemyCount: 3, enemyAspects: [1, 1, 1] }
      expect(
        computeSideBattleLayout({
          ...base,
          enemyGridExtent: 'wide',
          enemyWindowOverlapBottom: 0.5,
        }),
        `${w}x${h}`
      ).toEqual(computeSideBattleLayout(base))
    }
  })
})

describe('味方の並び tall (#1178)', () => {
  it('味方の大きさは default と同じ。x 送りは 0.2h・y 送りは default 以上で下限 0.3h。列は舞台の中に収まる', () => {
    let n = 0
    for (const [w, h] of SIZES)
      for (const party of [2, 4, 6, 8])
        for (const lines of [1, 2, 4])
          for (const cross of [false, true]) {
            const o = { party, lines, cross, back: false }
            const d = build(w, h, o)
            const t = build(w, h, { ...o, layout: 'tall' })
            const ctx = JSON.stringify([w, h, o])
            expect(t.stage, ctx).toEqual(d.stage)
            expect(t.log, ctx).toEqual(d.log)
            expect(t.command, ctx).toEqual(d.command)
            expect(t.status, ctx).toEqual(d.status)
            const h0 = d.party[0].size
            for (const s of t.party) expect(s.size, ctx).toBeCloseTo(h0, 6)
            for (let i = 1; i < t.party.length; i++) {
              const dx = t.party[i].x - t.party[i - 1].x
              const dy = t.party[i].y - t.party[i - 1].y
              expect(dx, ctx).toBeCloseTo(0.2 * h0, 6)
              expect(dy, ctx).toBeGreaterThanOrEqual(0.3 * h0 - EPS)
              expect(dy, ctx).toBeGreaterThanOrEqual(d.party[i].y - d.party[i - 1].y - EPS)
            }
            // 先頭は default 以上に上、列の下端は舞台の下端のまま、舞台の外へ出ない
            expect(t.party[0].y, ctx).toBeLessThanOrEqual(d.party[0].y + EPS)
            for (const s of t.party) {
              expect(s.y, ctx).toBeGreaterThanOrEqual(t.stage.y - EPS)
              expect(s.floor, ctx).toBeLessThanOrEqual(t.stage.y + t.stage.h + EPS)
            }
            n++
          }
    expect(n).toBe(8 * 4 * 3 * 2)
  })
  it('ff(窓 1 行)・1280x720・味方 4 人: 先頭が default より実際に上へ寄り、占める横幅が狭まる', () => {
    const d = build(1280, 720, {})
    const t = build(1280, 720, { layout: 'tall' })
    expect(t.party[0].y).toBeLessThan(d.party[0].y - 10)
    const span = (L: SideBattleLayout) =>
      Math.max(...L.party.map((s) => s.x + s.width)) - Math.min(...L.party.map((s) => s.x))
    expect(span(t)).toBeLessThan(span(d) - 50)
    expect(t.party[0].size).toBeCloseTo(d.party[0].size, 6)
  })
  it('後衛は斜めの位置から右へ半歩 (その人の幅の 0.5 倍)', () => {
    const t = build(1280, 720, { layout: 'tall', back: true })
    const f = build(1280, 720, { layout: 'tall', back: false })
    // 後衛の人は前衛の並びの同じ index より右へ (左端基準で全体が動くので差は index 1 と 0 の相対で見る)
    const rel = (L: SideBattleLayout, i: number) => L.party[i].x - L.party[0].x
    expect(rel(t, 1) - rel(f, 1)).toBeCloseTo(t.party[1].width * 0.5, 6)
  })
  it('味方同士の枠は、上の人の顔(上 30%)が下の人に隠れない間隔で、味方と敵は重ならない (総当たり)', () => {
    let n = 0
    for (const [w, h] of SIZES)
      for (const party of [1, 4, 8])
        for (const back of [false, true])
          for (const list of [false, true])
            for (const extent of ['normal', 'wide'] as const) {
              const L = build(w, h, { party, back, list, extent, layout: 'tall', bottom: 0.3 })
              const ctx = JSON.stringify([w, h, party, back, list, extent])
              for (const p of L.party)
                for (const e of L.enemies) {
                  if (!(e.size > 0)) continue
                  const hit =
                    p.x < e.x + e.width - EPS &&
                    e.x < p.x + p.width - EPS &&
                    p.y < e.y + e.size - EPS &&
                    e.y < p.y + p.size - EPS
                  expect(hit, ctx).toBe(false)
                }
              n++
            }
    expect(n).toBe(8 * 3 * 2 * 2 * 2)
  })
})

describe('敵グリッドの広がり wide (#1178)', () => {
  it('敵は画面の左端から、踏み出した味方の描画範囲に触れない所まで (総当たり: 画面 x 味方 x 隊列 x コマンド x 並び x 下の重なり)', () => {
    let n = 0
    let reachedLeft = 0
    for (const [w, h] of SIZES)
      for (const party of [1, 3, 4, 6, 8])
        for (const back of [false, true])
          for (const cross of [false, true])
            for (const layout of ['default', 'tall'] as const)
              for (const bottom of [0, 0.5])
                for (const acrylic of [false, true]) {
                  const o = { party, back, cross, layout, bottom, acrylic, extent: 'wide' as const }
                  const L = build(w, h, o)
                  const ctx = JSON.stringify([w, h, o])
                  const over = acrylic ? partyDrawOverhang(L.party, DEFAULT_ACRYLIC_PARAMS) : 0
                  const step = SIDE_PARTY_STEP_MAX_RATIO * L.party[0].size
                  for (const e of L.enemies) {
                    if (!(e.size > 0)) continue
                    expect(e.x, ctx).toBeGreaterThanOrEqual(-EPS)
                    for (const p of L.party) {
                      // 踏み出した味方の描画範囲（枠より左へ広がる台座・影を含む）
                      const left = p.x - over - step
                      const hit =
                        left < e.x + e.width - EPS &&
                        e.x < p.x + p.width - EPS &&
                        p.y < e.y + e.size - EPS &&
                        e.y < p.y + p.size - EPS
                      expect(hit, ctx).toBe(false)
                    }
                  }
                  // 画面の外へ出ない（上・下）
                  for (const e of L.enemies) {
                    if (!(e.size > 0)) continue
                    expect(e.y, ctx).toBeGreaterThanOrEqual(-EPS)
                    expect(e.floor, ctx).toBeLessThanOrEqual(h + EPS)
                  }
                  if (L.enemies.some((e) => e.size > 0 && e.x < 1)) reachedLeft++
                  n++
                }
    expect(n).toBe(8 * 5 * 2 * 2 * 2 * 2 * 2)
    expect(reachedLeft).toBeGreaterThan(30)
  })
  it('wide は敵の領域だけを変える: 窓・舞台・味方・コマンド・ステータスは normal と同じ (並びとは独立)', () => {
    for (const [w, h] of SIZES)
      for (const layout of ['default', 'tall'] as const)
        for (const bottom of [0, 0.4]) {
          const o = { layout, bottom }
          const a = build(w, h, o)
          const b = build(w, h, { ...o, extent: 'wide' })
          const ctx = JSON.stringify([w, h, o])
          expect(b.log, ctx).toEqual(a.log)
          expect(b.stage, ctx).toEqual(a.stage)
          expect(b.party, ctx).toEqual(a.party)
          expect(b.command, ctx).toEqual(a.command)
          expect(b.status, ctx).toEqual(a.status)
          expect(b.statusRows, ctx).toEqual(a.statusRows)
        }
  })
  it('並び tall + wide は、default + wide より敵の領域が広い (1280x720・味方 4 人・ff・6x2)', () => {
    const right = (L: SideBattleLayout) => Math.max(...L.enemies.map((e) => e.x + e.width))
    const a = build(1280, 720, { extent: 'wide' })
    const b = build(1280, 720, { extent: 'wide', layout: 'tall' })
    expect(right(b)).toBeGreaterThan(right(a) + 50)
    expect(b.enemies[0].width).toBeGreaterThan(a.enemies[0].width)
  })
})

describe('下のパネルへの重なり enemyWindowOverlapBottom (#1178)', () => {
  it('敵が大きくなり、足元は下のパネルに入る。入る量は許容量以下で、画面の外へは出ない。上のキー・味方は変わらない', () => {
    let grew = 0
    let n = 0
    for (const [w, h] of SIZES)
      for (const grid of [
        { cols: 6, rows: 2 },
        { cols: 4, rows: 2 },
        { cols: 12, rows: 4 },
      ])
        for (const bottom of [0.1, 0.25, 0.5])
          for (const extent of ['normal', 'wide'] as const)
            for (const align of ['bottom', 'center'] as const) {
              const o = { grid, extent, align }
              const a = build(w, h, o)
              const b = build(w, h, { ...o, bottom })
              const ctx = JSON.stringify([w, h, o, bottom])
              expect(b.party, ctx).toEqual(a.party)
              expect(b.log, ctx).toEqual(a.log)
              expect(b.command, ctx).toEqual(a.command)
              for (const e of b.enemies) {
                if (!(e.size > 0)) continue
                const into = e.floor - b.command.y
                expect(into, ctx).toBeLessThanOrEqual(bottom * e.size + EPS + 0)
                expect(e.floor, ctx).toBeLessThanOrEqual(h + EPS)
              }
              if (b.enemies[0].size > a.enemies[0].size + 1) grew++
              expect(b.enemies[0].size, ctx).toBeGreaterThanOrEqual(a.enemies[0].size - EPS)
              n++
            }
    expect(n).toBeGreaterThan(100)
    expect(grew).toBeGreaterThan(20)
  })
  it('上の重なり (battle_enemy_window_overlap) と独立: 上を変えても下の食い込み量の上限は変わらない', () => {
    for (const top of [0, 0.25, 0.5]) {
      const b = build(1280, 720, { top, bottom: 0.4, extent: 'wide' })
      for (const e of b.enemies) {
        if (!(e.size > 0)) continue
        expect(e.floor - b.command.y).toBeLessThanOrEqual(0.4 * e.size + EPS)
      }
    }
  })
})
