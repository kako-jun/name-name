/** BattleScreen の瀕死ポーズ weak (#1194): HP 割合が閾値未満の味方の待機姿だけを weak の絵にする */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture, TextureSource } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

const sized = (w: number, h: number): Texture =>
  new Texture({ source: new TextureSource({ width: w, height: h }) })
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface View {
  shownPose: string
  shownVisual: { texture: Texture } | null
  poseVisuals: Record<string, { texture: Texture }>
}
type Priv = {
  partyViews: View[]
  enemyViews: View[]
  hpOverride: Map<string, number>
  applyMotionFrame(): void
}
const priv = (s: BattleScreen): Priv => s as unknown as Priv

const created: BattleScreen[] = []
beforeEach(() => {
  const cache = new Map<string, Texture>()
  vi.spyOn(Assets, 'load').mockImplementation((async (p: string) => {
    if (!cache.has(p)) cache.set(p, sized(40, 80))
    return cache.get(p)
  }) as never)
})
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
  vi.restoreAllMocks()
})

const WITH_WEAK = { idle: 'img/idle.webp', hurt: 'img/hurt.webp', weak: 'img/weak.webp' }
const NO_WEAK = { idle: 'img/idle.webp', hurt: 'img/hurt.webp' }

async function setup(
  poses: Record<string, string>,
  opts: BattleScreenOptions = {},
  enemyPoses: Record<string, string> | undefined = poses
) {
  const hero: BattleEntity = {
    id: 'hero',
    name: 'HERO',
    hp: 20,
    maxHp: 20,
    mp: 4,
    maxMp: 4,
    atk: 3,
    def: 1,
    agi: 2,
    sprite: 'img/hero.webp',
    poses,
  }
  const engine = new BattleEngine(
    [hero],
    [{ ...hero, id: 'slime', name: 'SLIME', poses: enemyPoses, hp: 999, maxHp: 999, atk: 1 }],
    { rng: () => 0.5 }
  )
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  for (let i = 0; i < 5; i++) await flush()
  return { s, engine }
}

/** 味方の HP を変えて 1 フレーム描き、表示中のポーズを返す */
function poseAt(s: BattleScreen, engine: BattleEngine, hp: number): string {
  engine.getState().party[0].hp = hp
  priv(s).applyMotionFrame()
  return priv(s).partyViews[0].shownPose
}

describe('BattleScreen: 瀕死ポーズ weak (#1194)', () => {
  it('閾値未満で weak、閾値ちょうど以上で idle（FF の 1/4 未満）。回復すれば idle に戻る', async () => {
    const { s, engine } = await setup(WITH_WEAK, { weakThreshold: 0.25 })
    expect(poseAt(s, engine, 20)).toBe('idle')
    expect(poseAt(s, engine, 5)).toBe('idle') // 5/20 = 0.25 ちょうどは出さない（未満）
    expect(poseAt(s, engine, 4)).toBe('weak')
    expect(poseAt(s, engine, 1)).toBe('weak')
    expect(poseAt(s, engine, 12)).toBe('idle')
  })

  it('weak の絵が表示に使われる（テクスチャが weak のもの）', async () => {
    const { s, engine } = await setup(WITH_WEAK, { weakThreshold: 0.25 })
    poseAt(s, engine, 3)
    const v = priv(s).partyViews[0]
    expect(v.shownVisual?.texture).toBe(v.poseVisuals.weak.texture)
  })

  it('HP 0 は down が優先（weak ではない）', async () => {
    const { s, engine } = await setup(
      { ...WITH_WEAK, down: 'img/down.webp' },
      { weakThreshold: 0.25 }
    )
    expect(poseAt(s, engine, 0)).toBe('down')
  })

  it('既定（weakThreshold 未指定）は HP が減っても weak にならない（従来と同じ）', async () => {
    const { s, engine } = await setup(WITH_WEAK)
    expect(poseAt(s, engine, 1)).toBe('idle')
  })

  it('weak の絵が無いキャラは、瀕死でも idle のまま', async () => {
    const { s, engine } = await setup(NO_WEAK, { weakThreshold: 0.25 })
    expect(poseAt(s, engine, 1)).toBe('idle')
  })

  it('表示用の HP（演出の再生位置 hpOverride）に合わせる: 命中の瞬間より前は古い HP で idle のまま', async () => {
    const { s, engine } = await setup(WITH_WEAK, { weakThreshold: 0.25 })
    // エンジンの HP は確定済み(1)だが、演出はまだ命中前(20)を見せている
    priv(s).hpOverride.set('party:0', 20)
    expect(poseAt(s, engine, 1)).toBe('idle')
    // 命中の瞬間に表示 HP が追いつくと weak
    priv(s).hpOverride.set('party:0', 1)
    priv(s).applyMotionFrame()
    expect(priv(s).partyViews[0].shownPose).toBe('weak')
    // 逆に、回復の演出が追いつくまでは weak のまま
    priv(s).hpOverride.set('party:0', 1)
    expect(poseAt(s, engine, 20)).toBe('weak')
  })

  it('敵は対象外（瀕死でも weak にならない）', async () => {
    const { s, engine } = await setup(WITH_WEAK, { weakThreshold: 0.25 })
    engine.getState().enemies[0].hp = 1
    priv(s).applyMotionFrame()
    expect(priv(s).enemyViews[0].shownPose).toBe('idle')
  })

  it('戦闘に勝った待機中は weak にしない', async () => {
    const { s, engine } = await setup(
      { ...WITH_WEAK, victory: 'img/victory.webp' },
      { weakThreshold: 0.25 }
    )
    engine.getState().enemies[0].hp = 0
    ;(engine.getState() as { phase: string }).phase = 'victory'
    expect(poseAt(s, engine, 1)).not.toBe('weak')
  })

  it('dq では使われない（ポーズの差し替えは ff だけ）', async () => {
    const { s, engine } = await setup(WITH_WEAK, { presentation: 'dq', weakThreshold: 0.25 })
    expect(poseAt(s, engine, 1)).toBe('idle')
  })
})
