/**
 * BattleScreen の内部トレース (#1197): ff の戦闘で、HP の変化・倒れ・演出の発火（hpOverride）・ポーズの解決（画像パス）・
 * 入力・窓の開閉が記録されること。off のときは何も記録せず、画面の振る舞いも変えない。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture, TextureSource } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import { skipEntrance } from './battleScreenTestUtil'
import type { BattleEntity } from './spellDsl'
import { configureTrace, resetTraceForTest, traceDump, type TraceEntry } from '../trace/trace'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 30,
    maxHp: 30,
    mp: 9,
    maxMp: 9,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

const created: BattleScreen[] = []
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const entries = (): TraceEntry[] => traceDump().session.entries
const ofKind = (k: string): TraceEntry[] => entries().filter((e) => e.k === k)

function build(withPoses = true) {
  vi.spyOn(Assets, 'load').mockImplementation(
    ((): Promise<Texture> =>
      Promise.resolve(
        new Texture({ source: new TextureSource({ width: 40, height: 80 }) })
      )) as never
  )
  const engine = new BattleEngine(
    [
      entity('hero', {
        sprite: 'img/h.webp',
        ...(withPoses ? { poses: { idle: 'img/h-idle.webp', down: 'img/h-down.webp' } } : {}),
        hp: 1,
        maxHp: 30,
      }),
    ],
    [entity('boss', { atk: 5, hp: 500, maxHp: 500, sprite: 'img/b.webp' })],
    { rng: () => 0.5, skills: {} }
  )
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    presentation: 'ff',
    motion: 'snappy',
  })
  created.push(s)
  return { s, engine }
}

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
  vi.restoreAllMocks()
  resetTraceForTest()
})

describe('BattleScreen: 内部トレース (#1197)', () => {
  it('off（既定）: 何も記録しない', async () => {
    const { s, engine } = build()
    await flush()
    s.tick(1500)
    s.tick(200)
    engine.selectAttack()
    for (let i = 0; i < 100; i++) s.tick(50)
    expect(entries()).toEqual([])
  })

  it('on: ポーズ絵の読み込み・倒れ・演出の発火・ポーズの解決（画像パス）・終了が順に追える', async () => {
    configureTrace(true, { storage: null })
    const { s, engine } = build()
    await flush()
    // 登場スライドを済ませる
    s.tick(1500)
    s.tick(200)
    // 敵に殴らせて hero を倒す（従来ターン制: 自分の番に攻撃 → 敵の番）
    engine.selectAttack()
    for (let i = 0; i < 400 && !engine.isOver(); i++) s.tick(50)
    for (let i = 0; i < 200; i++) s.tick(50)

    const kinds = entries().map((e) => e.k)
    expect(kinds).toContain('b.start')
    // ポーズ絵の読み込みの成否
    const loads = ofKind('b.load').map((e) => e.d as { img: string; ok: boolean; pose: string })
    expect(loads.some((l) => l.pose === 'down' && l.ok && l.img === 'img/h-down.webp')).toBe(true)
    // 味方の HP が 1 → 0 へ変わり、倒れが記録される
    const hp = ofKind('b.hp').map((e) => e.d as { s: number; i: number; from: number; to: number })
    expect(hp.some((h) => h.s === 0 && h.i === 0 && h.from === 1 && h.to === 0)).toBe(true)
    expect(ofKind('b.ko').some((e) => (e.d as { s: number }).s === 0)).toBe(true)
    // 演出の発火: 命中の瞬間に表示 HP が確定値へ進む
    const fires = ofKind('b.fire').map(
      (e) => e.d as { hits?: number[][]; ov?: unknown[]; clear?: boolean }
    )
    expect(fires.some((f) => f.hits?.some((h) => h[0] === 0 && h[2] === 0))).toBe(true)
    expect(fires.some((f) => f.clear)).toBe(true)
    // ポーズの解決: 倒れの絵（down）に解決され、その画像パスが残る
    const poses = ofKind('b.pose').map(
      (e) => e.d as { s: number; req: string; res: string | null; img: string | null }
    )
    expect(
      poses.some(
        (p) => p.s === 0 && p.req === 'down' && p.res === 'down' && p.img === 'img/h-down.webp'
      )
    ).toBe(true)
    // 倒れの前に idle の解決もある（順序: idle → … → down）
    const heroPoses = poses.filter((p) => p.s === 0).map((p) => p.res)
    expect(heroPoses.indexOf('idle')).toBeLessThan(heroPoses.indexOf('down'))
    // 終了
    expect(ofKind('b.end')).toHaveLength(1)
    expect(kinds.indexOf('b.end')).toBeGreaterThan(kinds.indexOf('b.ko'))
  })

  it('ポーズ絵の読み込み失敗は ok: false で残る', async () => {
    configureTrace(true, { storage: null })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockImplementation(
      ((p: string): Promise<Texture> =>
        p.includes('down')
          ? Promise.reject(new Error('404'))
          : Promise.resolve(
              new Texture({ source: new TextureSource({ width: 40, height: 80 }) })
            )) as never
    )
    const engine = new BattleEngine(
      [
        entity('hero', {
          sprite: 'img/h.webp',
          poses: { idle: 'img/h-idle.webp', down: 'img/h-down.webp' },
        }),
      ],
      [entity('boss', { sprite: 'img/b.webp' })],
      { rng: () => 0.5, skills: {} }
    )
    created.push(new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' }))
    await flush()
    await flush()
    const bad = ofKind('b.load').filter((e) => (e.d as { ok: boolean }).ok === false)
    expect(bad.map((e) => (e.d as { img: string }).img)).toEqual(['img/h-down.webp'])
  })

  it('入力: 画面のコマンド選択と、エンジンへの入力が記録される', async () => {
    configureTrace(true, { storage: null })
    const { s } = build(false)
    await flush()
    s.tick(1500)
    s.tick(200)
    ;(s as unknown as { handleCommand(id: string): void }).handleCommand('attack')
    const cmds = ofKind('b.in').map((e) => e.d as { src: string; v: string })
    expect(cmds.some((c) => c.src === 'cmd' && c.v === 'attack')).toBe(true)
    expect(ofKind('b.cmd').some((e) => (e.d as { c: string }).c === 'selectAttack')).toBe(true)
  })

  it('候補窓の開閉・キー入力が記録される（cross のキーで窓を開き、取り消しで閉じる）', async () => {
    configureTrace(true, { storage: null })
    vi.spyOn(Assets, 'load').mockImplementation(
      ((): Promise<Texture> =>
        Promise.resolve(
          new Texture({ source: new TextureSource({ width: 40, height: 80 }) })
        )) as never
    )
    const engine = new BattleEngine([entity('a')], [entity('e')], { rng: () => 0 })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      commandLayout: 'cross',
      menu: {
        spells: {
          a: [{ id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' }],
        },
        items: [],
      },
    })
    created.push(s)
    skipEntrance(s)
    const press = (key: string): void => {
      globalThis.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    }
    press('ArrowLeft') // じゅもんの窓を開く
    press('Escape') // 取り消して閉じる
    const wins = ofKind('b.win').map((e) => (e.d as { ev: string }).ev)
    expect(wins).toEqual(['open', 'close'])
    const keys = ofKind('b.in').map((e) => e.d as { src: string; v: string })
    expect(keys.map((k) => k.v)).toEqual(['ArrowLeft', 'spell', 'Escape'])
    // 窓を開いている間は ATB の時間を止める指示も出る（ATB の戦闘のみ。ここは従来ターン制なので出ない）
    expect(ofKind('b.hold')).toEqual([])
  })

  it('倒れの絵が無い者は、沈み込み（sink）で倒れを表したことが記録に出る', async () => {
    configureTrace(true, { storage: null })
    vi.spyOn(Assets, 'load').mockImplementation(
      ((): Promise<Texture> =>
        Promise.resolve(
          new Texture({ source: new TextureSource({ width: 40, height: 80 }) })
        )) as never
    )
    const engine = new BattleEngine(
      [
        entity('hero', {
          sprite: 'img/h.webp',
          poses: { idle: 'img/h-idle.webp' },
          hp: 1,
          maxHp: 30,
        }),
      ],
      [entity('boss', { atk: 5, hp: 500, maxHp: 500, sprite: 'img/b.webp' })],
      { rng: () => 0.5, skills: {} }
    )
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
    })
    created.push(s)
    await flush()
    s.tick(1500)
    s.tick(200)
    engine.selectAttack()
    for (let i = 0; i < 300 && !engine.isOver(); i++) s.tick(50)
    for (let i = 0; i < 40; i++) s.tick(50)
    const down = ofKind('b.pose')
      .map((e) => e.d as { s: number; req: string; look?: string })
      .find((p) => p.s === 0 && p.req === 'down')
    expect(down?.look).toBe('sink')
  })

  it('dq 方式でも、姿（idle → down）が記録される', async () => {
    configureTrace(true, { storage: null })
    vi.spyOn(Assets, 'load').mockImplementation(
      ((): Promise<Texture> =>
        Promise.resolve(
          new Texture({ source: new TextureSource({ width: 40, height: 80 }) })
        )) as never
    )
    const engine = new BattleEngine(
      [entity('hero', { sprite: 'img/h.webp', hp: 1, maxHp: 30 })],
      [entity('boss', { atk: 5, hp: 500, maxHp: 500, sprite: 'img/b.webp' })],
      { rng: () => 0.5, skills: {} }
    )
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'dq' })
    created.push(s)
    await flush()
    engine.selectAttack()
    ;(s as unknown as { refresh(): void }).refresh()
    const poses = ofKind('b.pose')
      .map((e) => e.d as { s: number; req: string })
      .filter((p) => p.s === 0)
      .map((p) => p.req)
    expect(poses[0]).toBe('idle')
    expect(poses[poses.length - 1]).toBe('down')
  })
})
