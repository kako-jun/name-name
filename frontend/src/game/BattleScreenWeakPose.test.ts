/** BattleScreen の瀕死ポーズ weak (#1194): HP 割合が閾値未満の味方の待機姿だけを weak の絵にする */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture, TextureSource } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine, type BattleEngineOptions } from './battleEngine'
import { DEFAULT_MOTION_TIMING } from './battleMotion'
import { skipEntrance } from './battleScreenTestUtil'
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
  handleCommand(id: string): void
  playback: {
    active: { elapsed: number; event: { actor: { side: string; index: number } } } | null
    queue: unknown[]
  }
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
  engineOpts: BattleEngineOptions = { rng: () => 0.5 },
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
    engineOpts
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

  it('決着の行動の演出が走っている間は、勝利でも weak のまま（勝利ポーズは演出が終わってから）', async () => {
    const ps = {
      ...WITH_WEAK,
      victory: 'img/victory.webp',
      ready: 'img/ready.webp',
      slash: 'img/slash.webp',
    }
    const { s, engine } = await setupTwo(ps, { weakThreshold: 0.25 }, 1)
    skipEntrance(s)
    // 先頭の強い味方が敵を倒す。2 人目（瀕死）は行動者でも対象でもない
    engine.getState().party[1].hp = 4
    priv(s).handleCommand('attack')
    expect((engine.getState() as { phase: string }).phase).toBe('victory')
    expect(priv(s).playback.active ?? priv(s).playback.queue.length).toBeTruthy()
    priv(s).applyMotionFrame()
    expect(priv(s).partyViews[1].shownPose).toBe('weak')
    // 演出が終わったら勝ちポーズ側（weak ではない）
    for (let i = 0; i < 400; i++) s.tick(20)
    expect(priv(s).partyViews[1].shownPose).not.toBe('weak')
  })

  it('瀕死でも、行動中のポーズ（ready / step / slash）は weak に勝つ。のけぞり（hurt）も weak より先', async () => {
    const ps = {
      ...WITH_WEAK,
      ready: 'img/ready.webp',
      step: 'img/step.webp',
      slash: 'img/slash.webp',
    }
    const { s, engine } = await setupTwo(ps, { weakThreshold: 0.25 }, 999)
    skipEntrance(s)
    const st = engine.getState()
    st.party[0].hp = 9 // 9/40 = 瀕死
    st.party[0].maxHp = 40
    st.enemies[0].atk = 4
    priv(s).handleCommand('attack')
    const seq: string[] = []
    for (let i = 0; i < 300; i++) {
      s.tick(20)
      const p = priv(s).partyViews[0].shownPose
      const pb = priv(s).playback.active
      const act = pb?.event.actor
      // 自分の通常攻撃の動き（踏み出し・斬り・戻り）の間は、構え・踏み出し・斬りのいずれか（weak ではない）。動きが終わった後の間は待機に戻るので weak でよい
      const moving =
        DEFAULT_MOTION_TIMING.attackStepMs +
        DEFAULT_MOTION_TIMING.attackSlashMs +
        DEFAULT_MOTION_TIMING.attackReturnMs
      if (pb && act && act.side === 'party' && act.index === 0 && pb.elapsed < moving - 1)
        expect(p).not.toBe('weak')
      if (seq[seq.length - 1] !== p) seq.push(p)
    }
    expect(seq).toEqual(expect.arrayContaining(['slash']))
    // 敵の攻撃を受けると、のけぞり（hurt）が weak に勝ち、そのあと weak に戻る（命中前は hurt にならない）
    expect(seq).toContain('hurt')
    expect(seq.lastIndexOf('weak')).toBeGreaterThan(seq.indexOf('hurt'))
  })

  it('最大 HP が変わると割合が変わる（HP 6: 最大 20 は 30% で idle、最大 40 は 15% で weak）', async () => {
    const { s, engine } = await setup(WITH_WEAK, { weakThreshold: 0.25 })
    engine.getState().party[0].maxHp = 20
    expect(poseAt(s, engine, 6)).toBe('idle')
    engine.getState().party[0].maxHp = 40
    expect(poseAt(s, engine, 6)).toBe('weak')
  })

  it('ATB でも動く（待機中の瀕死の味方が weak）', async () => {
    const { s, engine } = await setup(
      WITH_WEAK,
      { weakThreshold: 0.25 },
      {
        atb: { mode: 'wait' },
        rng: () => 0,
      }
    )
    skipEntrance(s)
    expect(poseAt(s, engine, 20)).toBe('idle')
    expect(poseAt(s, engine, 3)).toBe('weak')
  })

  it('アクスタ（acrylic）でも動く', async () => {
    vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation(((
      tex: Texture
    ) => ({
      texture: sized(tex.width + 16, tex.height + 16),
      pad: 8,
      shadow: sized(64, 32),
      foot: { x: 32, y: 16 },
    })) as never)
    const { s, engine } = await setup(WITH_WEAK, { weakThreshold: 0.25, spriteStyle: 'acrylic' })
    expect(poseAt(s, engine, 20)).toBe('idle')
    expect(poseAt(s, engine, 3)).toBe('weak')
    const v = priv(s).partyViews[0]
    expect(v.shownVisual?.texture).toBe(v.poseVisuals.weak.texture)
  })
})

/** 味方 2 人（先頭は敵を一撃で倒せる強者、2 人目が主役）で組む。enemyHp は敵の HP */
async function setupTwo(poses: Record<string, string>, opts: BattleScreenOptions, enemyHp: number) {
  const mk = (id: string, atk: number): BattleEntity => ({
    id,
    name: id,
    hp: 40,
    maxHp: 40,
    mp: 4,
    maxMp: 4,
    atk,
    def: 1,
    agi: 2,
    sprite: 'img/hero.webp',
    poses,
  })
  const engine = new BattleEngine(
    [mk('a', 99), mk('b', 3)],
    [{ ...mk('slime', 1), hp: enemyHp, maxHp: 999, poses: undefined }],
    { rng: () => 0.5 }
  )
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  for (let i = 0; i < 5; i++) await flush()
  return { s, engine }
}
