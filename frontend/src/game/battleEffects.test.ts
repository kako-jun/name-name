/**
 * 戦闘のエフェクト重ね (#936) の純粋関数: 設定の検証、コマ送り、シートの切り出し、アンカー、行動の記録からの再生の予定。
 */
import { describe, expect, it } from 'vitest'
import type { BattleActionEvent, BattleHit } from './battleEngine'
import {
  EFFECT_DEFAULT_FRAME_MS,
  effectAnchorPoint,
  effectDrawSize,
  effectFrameAt,
  effectFrameRect,
  effectRows,
  effectTotalMs,
  hasBattleEffects,
  parseBattleEffects,
  planEventEffects,
  type BattleEffects,
  type BattleEffectSheet,
} from './battleEffects'
import { CAST_HIT_MS, ATTACK_STEP_MS, ATTACK_SLASH_HIT_MS, SUMMON_HIT_MS } from './battleMotion'

const sheet = (over: Partial<BattleEffectSheet> = {}): BattleEffectSheet => ({
  image: 'a.png',
  frames: 6,
  columns: 6,
  frameMs: 50,
  anchor: 'center',
  scale: 1,
  ...over,
})
const ALL: BattleEffects = {
  cast: sheet(),
  summon: sheet(),
  impact: sheet(),
  slash: sheet(),
  magic: sheet(),
}

const hit = (index: number, over: Partial<BattleHit> = {}): BattleHit => ({
  target: { side: 'enemy', index },
  kind: 'damage',
  amount: 5,
  hpBefore: 20,
  hpAfter: 15,
  ...over,
})
const ev = (over: Partial<BattleActionEvent>): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind: 'attack',
  hits: [hit(0)],
  ...over,
})
const noSlash = { usesSlashPose: () => false }
const slashy = { usesSlashPose: () => true }

describe('parseBattleEffects', () => {
  it('未指定・null は空で警告なし', () => {
    expect(parseBattleEffects(undefined)).toEqual({ effects: {}, warnings: [] })
    expect(parseBattleEffects(null)).toEqual({ effects: {}, warnings: [] })
  })

  it('既定値: 横一列・80ms・拡大 1。アンカーは詠唱が手元、ヒットは中心', () => {
    const r = parseBattleEffects({
      cast: { image: 'c.png', frames: 6 },
      slash: { image: 's.png', frames: 6 },
    })
    expect(r.warnings).toEqual([])
    expect(r.effects.cast).toEqual({
      image: 'c.png',
      frames: 6,
      columns: 6,
      frameMs: EFFECT_DEFAULT_FRAME_MS,
      anchor: 'hand',
      scale: 1,
    })
    expect(r.effects.slash?.anchor).toBe('center')
  })

  it('グリッド・間隔・アンカー・拡大率を宣言できる。画像は resolve を通す', () => {
    const r = parseBattleEffects(
      { magic: { image: 'm.png', frames: 8, columns: 4, frameMs: 40, anchor: 'foot', scale: 1.5 } },
      (u) => `http://x/${u}`
    )
    expect(r.effects.magic).toEqual({
      image: 'http://x/m.png',
      frames: 8,
      columns: 4,
      frameMs: 40,
      anchor: 'foot',
      scale: 1.5,
    })
  })

  it('不正な値は警告してその種類だけ無視する（他の種類は生きる）', () => {
    const bad: Record<string, unknown> = {
      cast: { image: '', frames: 6 },
      summon: { image: 'a.png', frames: 0 },
      impact: { image: 'a.png', frames: 2.5 },
      slash: { image: 'a.png', frames: 6, columns: 7 },
      magic: { image: 'a.png', frames: 6, frameMs: -1 },
      fire: { image: 'a.png', frames: 6 },
    }
    const r = parseBattleEffects({ ...bad, ok: 1 })
    expect(r.effects).toEqual({})
    expect(r.warnings).toHaveLength(7)
    const mixed = parseBattleEffects({
      cast: { image: 'a.png', frames: 6, anchor: 'sky' },
      magic: { image: 'a.png', frames: 6, scale: 0 },
      slash: { image: 'a.png', frames: 3 },
    })
    expect(Object.keys(mixed.effects)).toEqual(['slash'])
    expect(mixed.warnings).toHaveLength(2)
  })

  it('URL を解決できない画像・オブジェクトでない値は警告して無視する', () => {
    const r = parseBattleEffects({ cast: { image: 'a.png', frames: 2 } }, () => null)
    expect(r.effects).toEqual({})
    expect(r.warnings[0]).toContain('effects.cast.image')
    expect(parseBattleEffects([]).warnings).toHaveLength(1)
    expect(parseBattleEffects({ cast: 3 }).warnings).toHaveLength(1)
  })

  it('hasBattleEffects: 宣言が 1 つでもあれば true', () => {
    expect(hasBattleEffects(undefined)).toBe(false)
    expect(hasBattleEffects({})).toBe(false)
    expect(hasBattleEffects({ cast: sheet() })).toBe(true)
  })
})

describe('コマ送りとシートの切り出し', () => {
  it('effectFrameAt: frameMs ごとに進み、総時間で終わる（null）', () => {
    const s = sheet({ frames: 6, frameMs: 50 })
    expect(effectTotalMs(s)).toBe(300)
    expect(effectFrameAt(s, 0)).toBe(0)
    expect(effectFrameAt(s, 49)).toBe(0)
    expect(effectFrameAt(s, 50)).toBe(1)
    expect(effectFrameAt(s, 299)).toBe(5)
    expect(effectFrameAt(s, 300)).toBeNull()
    expect(effectFrameAt(s, 9999)).toBeNull()
  })

  it('負・非有限は 0 コマ目', () => {
    const s = sheet()
    expect(effectFrameAt(s, -10)).toBe(0)
    expect(effectFrameAt(s, Number.NaN)).toBe(0)
  })

  it('横一列: 2172x724 を 6 コマ → 362x724 を左から', () => {
    const s = sheet({ frames: 6, columns: 6 })
    expect(effectRows(s)).toBe(1)
    expect(effectFrameRect(s, 2172, 724, 0)).toEqual({ x: 0, y: 0, w: 362, h: 724 })
    expect(effectFrameRect(s, 2172, 724, 5)).toEqual({ x: 1810, y: 0, w: 362, h: 724 })
  })

  it('グリッド: 列数で折り返し、左上から右へ・上から下へ数える', () => {
    const s = sheet({ frames: 6, columns: 3 })
    expect(effectRows(s)).toBe(2)
    expect(effectFrameRect(s, 300, 200, 0)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(effectFrameRect(s, 300, 200, 2)).toEqual({ x: 200, y: 0, w: 100, h: 100 })
    expect(effectFrameRect(s, 300, 200, 3)).toEqual({ x: 0, y: 100, w: 100, h: 100 })
    expect(effectFrameRect(s, 300, 200, 5)).toEqual({ x: 200, y: 100, w: 100, h: 100 })
    // 端数のあるコマ数（5 コマ・3 列 → 2 行）
    expect(effectRows(sheet({ frames: 5, columns: 3 }))).toBe(2)
  })

  it('effectDrawSize: セルの幅が unit×scale・縦横比を保つ。空は 0', () => {
    expect(effectDrawSize(sheet({ scale: 2 }), 362, 724, 100)).toEqual({ w: 200, h: 400 })
    expect(effectDrawSize(sheet(), 0, 10, 100)).toEqual({ w: 0, h: 0 })
    expect(effectDrawSize(sheet(), 10, 10, 0)).toEqual({ w: 0, h: 0 })
  })
})

describe('effectAnchorPoint', () => {
  const screen = { w: 800, h: 450 }
  const base = { x: 100, y: 200, unit: 80 }
  it('center は枠の中心、foot は足元（下へ）、screen は画面中央', () => {
    expect(effectAnchorPoint('center', { side: 'enemy', ...base }, screen)).toEqual({
      x: 100,
      y: 200,
      unit: 80,
    })
    const foot = effectAnchorPoint('foot', { side: 'enemy', ...base }, screen)
    expect(foot.x).toBe(100)
    expect(foot.y).toBeGreaterThan(200)
    const sc = effectAnchorPoint('screen', { side: 'enemy', ...base }, screen)
    expect(sc.x).toBe(400)
    expect(sc.unit).toBe(225)
  })
  it('hand は相手側へ寄る: 味方は左へ、敵は右へ', () => {
    expect(effectAnchorPoint('hand', { side: 'party', ...base }, screen).x).toBeLessThan(100)
    expect(effectAnchorPoint('hand', { side: 'enemy', ...base }, screen).x).toBeGreaterThan(100)
  })
})

describe('planEventEffects', () => {
  it('宣言が無ければ何も出さない（従来と同一）', () => {
    expect(planEventEffects(ev({}), undefined, noSlash)).toEqual([])
    expect(planEventEffects(ev({}), {}, noSlash)).toEqual([])
  })

  it('通常攻撃: slash ポーズを持つ使い手は斬撃、持たなければ打撃。命中の瞬間に対象へ', () => {
    const e = ev({ hits: [hit(0), hit(1)] })
    const at = ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS
    expect(planEventEffects(e, ALL, slashy)).toEqual([
      { kind: 'slash', atMs: at, target: { side: 'enemy', index: 0 } },
      { kind: 'slash', atMs: at, target: { side: 'enemy', index: 1 } },
    ])
    expect(planEventEffects(e, ALL, noSlash).map((p) => p.kind)).toEqual(['impact', 'impact'])
  })

  it('宣言の無い種類は出さない（斬撃だけ宣言して打撃になる使い手は何も出ない）', () => {
    expect(planEventEffects(ev({}), { slash: sheet() }, noSlash)).toEqual([])
    expect(planEventEffects(ev({}), { impact: sheet() }, slashy)).toEqual([])
  })

  it('ミス・回復のヒットには出さない', () => {
    const e = ev({ hits: [hit(0, { kind: 'miss' }), hit(1, { kind: 'heal' }), hit(2)] })
    const p = planEventEffects(e, ALL, noSlash)
    expect(p).toHaveLength(1)
    expect(p[0].target.index).toBe(2)
  })

  it('呪文: 発動時に詠唱を使い手へ、命中時に魔法ヒットを対象へ', () => {
    const e = ev({ kind: 'spell', label: 'ほのお' })
    expect(planEventEffects(e, ALL, noSlash)).toEqual([
      { kind: 'cast', atMs: 0, target: { side: 'party', index: 0 } },
      { kind: 'magic', atMs: CAST_HIT_MS, target: { side: 'enemy', index: 0 } },
    ])
  })

  it('回復の呪文は詠唱だけ（魔法ヒットは出ない）', () => {
    const e = ev({ kind: 'spell', hits: [hit(0, { kind: 'heal' })] })
    expect(planEventEffects(e, ALL, noSlash).map((p) => p.kind)).toEqual(['cast'])
  })

  it('召喚獣の行動: 召喚詠唱を使い手へ、命中に魔法ヒット', () => {
    const e = ev({ kind: 'skill', summon: { id: 'S', name: 'うみ' } })
    expect(planEventEffects(e, ALL, noSlash)).toEqual([
      { kind: 'summon', atMs: 0, target: { side: 'party', index: 0 } },
      { kind: 'magic', atMs: SUMMON_HIT_MS, target: { side: 'enemy', index: 0 } },
    ])
  })

  it('召喚獣の無い特技・アイテム・状態・知らせには出さない', () => {
    for (const kind of ['skill', 'item', 'status', 'notice'] as const) {
      expect(planEventEffects(ev({ kind }), ALL, noSlash)).toEqual([])
    }
  })

  it('複数ヒット: round ごとに命中の瞬間がずれる', () => {
    const e = ev({ kind: 'spell', hits: [hit(0, { round: 0 }), hit(0, { round: 2 })] })
    const magic = planEventEffects(e, ALL, noSlash).filter((p) => p.kind === 'magic')
    expect(magic).toHaveLength(2)
    expect(magic[1].atMs).toBeGreaterThan(magic[0].atMs)
  })
})
