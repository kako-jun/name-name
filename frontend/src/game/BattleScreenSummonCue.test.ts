/**
 * BattleScreen の召喚獣の登場 (#750): 再生中の行動に summon があるあいだ名前の札・絵・想像の層のかぶせを出し、終われば隠す。
 * 絵が無い／読めないときは名前の札だけ。呼ぶのは味方だけで、右向きの絵は反転して左向きに出す（左向きの絵は反転しない）。敵は呼ばない。
 * 時間の計算そのものは battleMotionSummon.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Texture, type Container, type Graphics, type Sprite, type Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine, type SummonExecution } from './battleEngine'
import type { SummonCue } from '../types'
import type { BattleEntity } from './spellDsl'
import { SUMMON_APPEAR_MS, SUMMON_HOLD_MS, SUMMON_MS } from './battleMotion'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 999,
    maxHp: 999,
    mp: 4,
    maxMp: 4,
    atk: 1,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  summonLayer: Container | null
  summonVeil: Graphics | null
  summonSprite: Sprite | null
  summonPlate: Text | null
  summonPlateFloorY: number
  summonTextures: Map<string, Texture | null>
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const cue: SummonCue = { id: 'S1', name: 'うみの主' }
const call = (c: SummonCue = cue): SummonExecution => ({
  name: c.name,
  target: '相手全体',
  mp: 0,
  effect: 'damage 5..5',
  cue: c,
})

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}, enemyOver: Partial<BattleEntity> = {}) {
  const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0, ...enemyOver })], {
    rng: () => 0.5,
    skills: {},
  })
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  return { s, engine }
}
/** エンジンを直接動かしたあと、画面に再生キューへ取り込ませる（画面のボタン操作が refresh で行うのと同じ） */
const sync = (s: BattleScreen) => (s as unknown as { refresh(): void }).refresh()
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
}

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('BattleScreen 召喚獣の登場', () => {
  it('ff のときだけ層を作り、最初は隠れている。dq / front は作らない', () => {
    const { s } = setup()
    expect(I(s).summonLayer).not.toBeNull()
    expect(I(s).summonLayer!.visible).toBe(false)
    const dq = setup({ presentation: 'dq' }).s
    expect(I(dq).summonLayer).toBeNull()
    const front = setup({ layout: 'front' }).s
    expect(I(front).summonLayer).toBeNull()
  })

  it('召喚すると名前の札が出て、登場の間は見え、終われば隠れる', () => {
    const { s, engine } = setup()
    engine.selectSummon(call())
    sync(s)
    run(s, SUMMON_APPEAR_MS + 100)
    expect(I(s).summonLayer!.visible).toBe(true)
    expect(I(s).summonPlate!.text).toBe('うみの主')
    expect(I(s).summonPlate!.alpha).toBe(1)
    run(s, SUMMON_MS + 400)
    expect(I(s).summonLayer!.visible).toBe(false)
  })

  it('途中ではフェードインの途中（0 < alpha < 1）', () => {
    const { s, engine } = setup()
    engine.selectSummon(call())
    sync(s)
    s.tick(16)
    run(s, SUMMON_APPEAR_MS / 2)
    const a = I(s).summonPlate!.alpha
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(1)
  })

  it('想像の層: imaginary のときだけかぶせが濃くなる（そうでなければ 0 のまま）', () => {
    const plain = setup()
    plain.engine.selectSummon(call())
    sync(plain.s)
    run(plain.s, SUMMON_APPEAR_MS + 100)
    expect(I(plain.s).summonVeil!.alpha).toBe(0)

    const img = setup()
    img.engine.selectSummon(call({ ...cue, imaginary: true }))
    sync(img.s)
    run(img.s, SUMMON_APPEAR_MS + 100)
    expect(I(img.s).summonVeil!.alpha).toBeGreaterThan(0.4)
    run(img.s, SUMMON_MS + 400)
    expect(I(img.s).summonLayer!.visible).toBe(false)
  })

  it('絵が無い／読めない（null）ときは絵を出さず、名前の札だけ', () => {
    const none = setup()
    none.engine.selectSummon(call())
    sync(none.s)
    run(none.s, SUMMON_APPEAR_MS + 50)
    expect(I(none.s).summonSprite).toBeNull()

    const broken = setup()
    I(broken.s).summonTextures.set('summons/x.webp', null)
    broken.engine.selectSummon(call({ ...cue, image: 'summons/x.webp' }))
    sync(broken.s)
    run(broken.s, SUMMON_APPEAR_MS + 50)
    expect(I(broken.s).summonSprite).toBeNull()
    expect(I(broken.s).summonPlate!.text).toBe('うみの主')
  })

  it('味方が呼ぶ右向きの絵は反転する。左向きの絵は反転しない', () => {
    const right = setup()
    I(right.s).summonTextures.set('a.webp', Texture.WHITE)
    right.engine.selectSummon(call({ ...cue, image: 'a.webp' }))
    sync(right.s)
    run(right.s, SUMMON_APPEAR_MS + 50)
    expect(I(right.s).summonSprite!.visible).toBe(true)
    expect(I(right.s).summonSprite!.scale.x).toBeLessThan(0)

    const left = setup()
    I(left.s).summonTextures.set('a.webp', Texture.WHITE)
    left.engine.selectSummon(call({ ...cue, image: 'a.webp', faces: 'left' }))
    sync(left.s)
    run(left.s, SUMMON_APPEAR_MS + 50)
    expect(I(left.s).summonSprite!.scale.x).toBeGreaterThan(0)
  })

  it('敵の特技に cue があっても、敵は召喚獣を呼ばない（絵も札も出ない）', () => {
    const engine = new BattleEngine(
      [entity('hero')],
      [entity('boss', { atk: 0, agi: 99, actions: ['候補=call'] })],
      {
        rng: () => 0.5,
        skills: {
          call: {
            name: 'よびごえ',
            target: '相手全体',
            effect: 'damage 1..1',
            cue: { ...cue, image: 'a.webp' },
          },
        },
      }
    )
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
    created.push(s)
    I(s).summonTextures.set('a.webp', Texture.WHITE)
    engine.selectAttack()
    sync(s)
    run(s, 1300)
    expect(I(s).summonSprite).toBeNull()
    expect(I(s).summonLayer!.visible).toBe(false)
  })

  it('名前の札は下の窓（コマンド・味方）の上端より上に収まる', () => {
    const { s, engine } = setup()
    I(s).summonTextures.set('tall.webp', Texture.WHITE)
    engine.selectSummon(call({ ...cue, image: 'tall.webp' }))
    sync(s)
    run(s, SUMMON_APPEAR_MS + 50)
    const plate = I(s).summonPlate!
    expect(I(s).summonPlateFloorY).toBeLessThan(450)
    expect(plate.y + Number(plate.style.fontSize) * 1.5).toBeLessThanOrEqual(I(s).summonPlateFloorY)
  })

  it('登場の始まりに 1 回だけ onSummonCue を呼ぶ（tick を重ねても増えない）', () => {
    const seen: string[] = []
    const { s, engine } = setup({ onSummonCue: (c) => seen.push(c.id) })
    engine.selectSummon(call({ ...cue, se: 'se/a.ogg' }))
    sync(s)
    run(s, SUMMON_APPEAR_MS + SUMMON_HOLD_MS)
    expect(seen).toEqual(['S1'])
  })

  it('演出の元の無い召喚・通常攻撃では層を出さず、コールバックも呼ばない', () => {
    const seen: string[] = []
    const { s, engine } = setup({ onSummonCue: (c) => seen.push(c.id) })
    engine.selectSummon({ name: 'ただの', target: '相手全体', mp: 0, effect: 'damage 1..1' })
    sync(s)
    run(s, 800)
    expect(I(s).summonLayer!.visible).toBe(false)
    expect(seen).toEqual([])
  })

  it('召喚獣の効果の数字は絵が出そろってから出る（命中が遅れる）', () => {
    const { s, engine } = setup()
    engine.selectSummon(call())
    sync(s)
    s.tick(16)
    const popups = () => (s as unknown as { popups: unknown[] }).popups.length
    run(s, 300)
    expect(popups()).toBe(0)
    run(s, 500)
    expect(popups()).toBeGreaterThan(0)
  })
})
