/**
 * BattleScreen のエフェクト重ね (#936): 宣言したシートを、行動の記録に応じて対象の位置へ重ね、コマを送り、終われば消す。
 * 宣言が無ければ層も作らない。画像が読めなければその種類だけ省き、戦闘は止めない。時間・割り当ての計算は battleEffects.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BufferImageSource, Texture, type Container, type Sprite } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { BattleEffects, BattleEffectSheet } from './battleEffects'
import { ATTACK_STEP_MS, ATTACK_SLASH_HIT_MS, CAST_HIT_MS } from './battleMotion'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 999,
    maxHp: 999,
    mp: 9,
    maxMp: 9,
    atk: 10,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface EffectInstanceView {
  sprite: Sprite
  kind: string
  side: string
  index: number
}
interface Internals {
  effectLayer: Container | null
  effectTextures: Map<string, Texture | null>
  effectInstances: EffectInstanceView[]
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

/** 横に frames コマ並ぶ cell 幅 × h のシート（中身は空の RGBA） */
function sheetTexture(frames: number, cell = 16, h = 32): Texture {
  const source = new BufferImageSource({
    resource: new Uint8Array(cell * frames * h * 4),
    width: cell * frames,
    height: h,
  })
  return new Texture({ source })
}
const sh = (over: Partial<BattleEffectSheet> = {}): BattleEffectSheet => ({
  image: 'sheet.png',
  frames: 4,
  columns: 4,
  frameMs: 100,
  anchor: 'center',
  scale: 1,
  ...over,
})

const created: BattleScreen[] = []
function setup(effects: BattleEffects | undefined, opts: BattleScreenOptions = {}, hero = {}) {
  const engine = new BattleEngine([entity('hero', hero)], [entity('boss', { atk: 0 })], {
    rng: () => 0.5,
    skills: {},
  })
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    presentation: 'ff',
    ...(effects ? { effects } : {}),
    ...opts,
  })
  created.push(s)
  return { s, engine }
}
const sync = (s: BattleScreen) => (s as unknown as { refresh(): void }).refresh()
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 10) s.tick(Math.min(10, left))
}
const fire = { name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 5..5' }

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('BattleScreen エフェクト重ね', () => {
  it('宣言が無い・空なら層を作らない。dq / front も作らない', () => {
    expect(I(setup(undefined).s).effectLayer).toBeNull()
    expect(I(setup({}).s).effectLayer).toBeNull()
    expect(I(setup({ slash: sh() }, { presentation: 'dq' }).s).effectLayer).toBeNull()
    expect(I(setup({ slash: sh() }, { layout: 'front' }).s).effectLayer).toBeNull()
    expect(I(setup({ slash: sh() }).s).effectLayer).not.toBeNull()
  })

  it('宣言が無い戦闘では攻撃しても何も重ならない', () => {
    const { s, engine } = setup(undefined)
    engine.selectAttack()
    sync(s)
    run(s, 800)
    expect(I(s).effectInstances).toEqual([])
  })

  it('通常攻撃: 命中の瞬間に対象の位置へ重なり、コマが進み、終われば消える（打撃: slash ポーズ無し）', () => {
    const { s, engine } = setup({ impact: sh() })
    I(s).effectTextures.set('sheet.png', sheetTexture(4))
    engine.selectAttack()
    sync(s)
    run(s, ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS - 30)
    expect(I(s).effectInstances).toHaveLength(0)
    run(s, 60)
    const inst = I(s).effectInstances
    expect(inst).toHaveLength(1)
    expect(inst[0].kind).toBe('impact')
    expect(inst[0].side).toBe('enemy')
    // 位置は対象の枠の中。大きさは 16px セル×（枠の一辺 × 1）
    expect(inst[0].sprite.x).toBeGreaterThan(0)
    expect(inst[0].sprite.x).toBeLessThan(800)
    expect(inst[0].sprite.width).toBeGreaterThan(0)
    const first = inst[0].sprite.texture
    run(s, 150)
    expect(I(s).effectInstances[0].sprite.texture).not.toBe(first)
    run(s, 400)
    expect(I(s).effectInstances).toHaveLength(0)
    expect(I(s).effectLayer!.children).toHaveLength(0)
  })

  it('slash ポーズを持つ使い手は斬撃のシートを使う', () => {
    const { s, engine } = setup(
      { impact: sh({ image: 'i.png' }), slash: sh({ image: 's.png' }) },
      {},
      {
        poses: { slash: 'slash.png' },
      }
    )
    I(s).effectTextures.set('i.png', sheetTexture(4))
    I(s).effectTextures.set('s.png', sheetTexture(4))
    engine.selectAttack()
    sync(s)
    run(s, ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS + 30)
    expect(I(s).effectInstances.map((e) => e.kind)).toEqual(['slash'])
  })

  it('呪文: 発動で詠唱が使い手（味方）の位置に出て、命中で魔法ヒットが対象（敵）に出る', () => {
    const { s, engine } = setup({
      cast: sh({ image: 'c.png', anchor: 'hand' }),
      magic: sh({ image: 'm.png' }),
    })
    I(s).effectTextures.set('c.png', sheetTexture(4))
    I(s).effectTextures.set('m.png', sheetTexture(4))
    engine.selectSpell(fire)
    sync(s)
    run(s, 50)
    const cast = I(s).effectInstances.find((e) => e.kind === 'cast')
    expect(cast).toBeDefined()
    expect(cast!.side).toBe('party')
    const castX = cast!.sprite.x
    run(s, CAST_HIT_MS - 50)
    const magic = I(s).effectInstances.find((e) => e.kind === 'magic')
    expect(magic).toBeDefined()
    expect(magic!.side).toBe('enemy')
    // 味方は右側・敵は左側にいる
    expect(castX).toBeGreaterThan(magic!.sprite.x)
  })

  it('画像が読めなかった（null）種類は出さず、戦闘は進む', () => {
    const { s, engine } = setup({ impact: sh() })
    I(s).effectTextures.set('sheet.png', null)
    engine.selectAttack()
    sync(s)
    run(s, 1500)
    expect(I(s).effectInstances).toEqual([])
    expect(engine.getState().enemies[0].hp).toBeLessThan(999)
  })

  it('1 回の dt が行動の終わりをまたいでも、数字が出るヒットには効果も出る', () => {
    const { s, engine } = setup({ impact: sh({ frameMs: 2000 }) })
    I(s).effectTextures.set('sheet.png', sheetTexture(4))
    engine.selectAttack()
    sync(s)
    let popups = 0
    const inner = s as unknown as { spawnPopup: (...a: unknown[]) => void }
    const orig = inner.spawnPopup.bind(s)
    inner.spawnPopup = (...a) => {
      popups++
      orig(...a)
    }
    // タブ復帰などで大きく遅れた 1 tick: 命中も行動の終わりも 1 回で越える
    s.tick(ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS + 600)
    expect(popups).toBeGreaterThan(0)
    expect(I(s).effectInstances.map((e) => e.kind)).toEqual(['impact'])
  })

  it('エンジンの状態・イベントはエフェクトの有無で変わらない（攻撃・呪文を数手、変化する乱数列で）', () => {
    const lcg = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const make = (effects: BattleEffects | undefined) => {
      const engine = new BattleEngine(
        [entity('hero', { poses: { slash: 'slash.png' } }), entity('mage')],
        [entity('boss', { atk: 4 }), entity('imp', { atk: 3 })],
        { rng: lcg(12345), skills: {} }
      )
      const s = new BattleScreen(engine, 800, 450, {
        layout: 'side',
        presentation: 'ff',
        ...(effects ? { effects } : {}),
      })
      created.push(s)
      for (const f of ['sheet.png']) I(s).effectTextures.set(f, sheetTexture(4))
      return { s, engine }
    }
    const a = make(undefined)
    const b = make({ impact: sh(), slash: sh(), cast: sh(), magic: sh() })
    // 宣言あり側で重ねられたエフェクトの最大同時数（行動の再生中に数える）
    const maxInstances = { a: 0, b: 0 }
    for (const [key, t] of [
      ['a', a],
      ['b', b],
    ] as const) {
      for (let turn = 0; turn < 6; turn++) {
        if (turn % 2 === 0) t.engine.selectAttack()
        else t.engine.selectSpell(fire)
        sync(t.s)
        for (let left = 1500; left > 0; left -= 10) {
          t.s.tick(Math.min(10, left))
          maxInstances[key] = Math.max(maxInstances[key], I(t.s).effectInstances.length)
        }
      }
    }
    const snap = (e: BattleEngine) => {
      const st = e.getState()
      return JSON.stringify({
        events: st.events,
        party: st.party.map((x) => [x.hp, x.mp]),
        enemies: st.enemies.map((x) => [x.hp, x.mp]),
      })
    }
    expect(snap(a.engine).length).toBeGreaterThan(200)
    expect(snap(b.engine)).toBe(snap(a.engine))
    // 宣言あり側では実際にエフェクトが重なっていた（比較が空振りでない）。宣言なし側は層ごと無い
    expect(maxInstances.b).toBeGreaterThan(0)
    expect(maxInstances.a).toBe(0)
  })
})
