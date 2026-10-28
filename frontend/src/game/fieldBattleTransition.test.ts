import { describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { DEFAULT_BATTLE_TRANSITION_PARAMS as P, battleTransitionParams } from './battleTransition'
import { ColorMatrixFilter } from 'pixi.js'
import { PixelateFilter } from 'pixi-filters'
import { FieldBattleTransition } from './fieldBattleTransition'
import { DEFAULT_FIELD_BATTLE_SETTINGS, FieldInputGate, openFieldBattle } from './fieldBattle'
import { RESULT_HOLD_DQ_MS } from './battleResult'

function make() {
  const stage = new Container()
  const t = new FieldBattleTransition(() => stage)
  return { stage, t }
}

const run = (t: FieldBattleTransition, totalMs: number, step = 16): void => {
  for (let e = 0; e < totalMs; e += step) t.tick(step)
}

describe('FieldBattleTransition 開始 (#830)', () => {
  it('開始直後から active。音のきっかけは 1・2 の順に 1 回ずつ。真っ暗で onBlack、その時は見た目が元に戻っている', () => {
    const { stage, t } = make()
    const beats: number[] = []
    t.hooks = { onTransitionBeat: (n) => beats.push(n) }
    const onBlack = vi.fn(() => {
      expect(stage.scale.x).toBe(1)
      expect(stage.children).toHaveLength(0) // 幕は外れている
    })
    t.playEnter(800, 600, () => ({ x: 400, y: 300 }), onBlack)
    expect(t.active).toBe(true)
    expect(beats).toEqual([1]) // 開始の瞬間に 1 段目
    run(t, P.enterStages[1].startMs + 50)
    expect(beats).toEqual([1, 2])
    expect(stage.scale.x).toBeGreaterThan(1)
    expect(onBlack).not.toHaveBeenCalled()
    run(t, 2000)
    expect(onBlack).toHaveBeenCalledTimes(1)
    expect(beats).toEqual([1, 2])
    expect(t.active).toBe(false)
  })

  it('ズームの中心は focus。focus の位置は画面上で動かない', () => {
    const { stage, t } = make()
    t.playEnter(
      800,
      600,
      () => ({ x: 250, y: 120 }),
      () => {}
    )
    run(t, 300)
    expect(stage.scale.x).toBeGreaterThan(1)
    // focus の点は拡大しても同じ画面位置
    const wx = (250 - stage.pivot.x) * stage.scale.x + stage.position.x
    const wy = (120 - stage.pivot.y) * stage.scale.y + stage.position.y
    expect(wx).toBeCloseTo(250)
    expect(wy).toBeCloseTo(120)
  })

  it('focus は毎フレーム問い合わせる（歩いている最中に発火しても追従）', () => {
    const { stage, t } = make()
    let x = 100
    t.playEnter(
      800,
      600,
      () => ({ x, y: 100 }),
      () => {}
    )
    run(t, 100)
    x = 500
    run(t, 100)
    expect(stage.pivot.x).toBe(500)
  })

  it('cancel は見た目を戻し、コールバックを呼ばない', () => {
    const { stage, t } = make()
    const onBlack = vi.fn()
    t.playEnter(800, 600, () => ({ x: 0, y: 0 }), onBlack)
    run(t, 300)
    t.cancel()
    expect(t.active).toBe(false)
    expect(stage.scale.x).toBe(1)
    expect(stage.children).toHaveLength(0)
    run(t, 3000)
    expect(onBlack).not.toHaveBeenCalled()
  })
})

describe('FieldBattleTransition 終了 (#830)', () => {
  it('フェードアウトの後の真っ暗で onBlack、フェードイン後に onDone。active はその間ずっと true', () => {
    const { t } = make()
    const order: string[] = []
    t.playExit(
      800,
      600,
      'victory',
      () => order.push('black'),
      () => order.push('done')
    )
    run(t, P.exitFadeOutMs - 40)
    expect(order).toEqual([])
    run(t, 100)
    expect(order).toEqual(['black'])
    expect(t.active).toBe(true)
    run(t, 2000)
    expect(order).toEqual(['black', 'done'])
    expect(t.active).toBe(false)
  })

  it('追加画面のフック: 結果を受け取り、黒の間だけ stage に載り、延びた分だけ黒が続く', () => {
    const { stage, t } = make()
    const extra = new Container()
    const interlude = vi.fn((_o: string) => ({ container: extra, durationMs: 600 }))
    t.hooks = { interlude }
    const order: string[] = []
    t.playExit(
      800,
      600,
      'defeat',
      () => order.push('black'),
      () => order.push('done')
    )
    expect(interlude).toHaveBeenCalledWith('defeat')
    run(t, P.exitFadeOutMs + 100)
    expect(stage.children).toContain(extra)
    // 追加画面なしならフェードインが終わっているはずの時刻でも、まだ続く
    run(t, P.exitBlackMs + P.exitFadeInMs)
    expect(order).toEqual(['black'])
    run(t, 2000)
    expect(order).toEqual(['black', 'done'])
    expect(stage.children).not.toContain(extra)
  })

  it('既定（フック無し）は何も挟まず、幕だけで終わる', () => {
    const { stage, t } = make()
    t.playExit(
      800,
      600,
      'escaped',
      () => {},
      () => {}
    )
    expect(stage.children).toHaveLength(1) // 幕
    run(t, 3000)
    expect(stage.children).toHaveLength(0)
  })
})

describe('FieldBattleTransition 終了: 大きな dt・端のパラメータ (#830)', () => {
  const variants = [
    ['既定', P],
    ['黒・フェードイン 0', { ...P, exitBlackMs: 0, exitFadeInMs: 0 }],
    ['全部 0', { ...P, exitFadeOutMs: 0, exitBlackMs: 0, exitFadeInMs: 0 }],
  ] as const

  it.each(variants)(
    '%s: 1 tick で完了まで飛んでも onBlack は必ず 1 回、その後 onDone',
    (_n, params) => {
      const stage = new Container()
      const t = new FieldBattleTransition(() => stage, params)
      const order: string[] = []
      t.playExit(
        800,
        600,
        'victory',
        () => order.push('black'),
        () => order.push('done')
      )
      t.tick(100000)
      t.tick(100000)
      t.tick(100000)
      expect(order.filter((o) => o === 'black')).toHaveLength(1)
      expect(order[0]).toBe('black')
      expect(order[order.length - 1]).toBe('done')
      expect(t.active).toBe(false)
    }
  )

  it('大きな dt でも追加画面は黒の間に最低でも載り、フェードインで外れる', () => {
    const stage = new Container()
    const t = new FieldBattleTransition(() => stage)
    const extra = new Container()
    t.hooks = { interlude: () => ({ container: extra, durationMs: 500 }) }
    t.playExit(
      800,
      600,
      'victory',
      () => {},
      () => {}
    )
    t.tick(P.exitFadeOutMs + 10_000)
    expect(t.active).toBe(true)
    expect(stage.children).toContain(extra)
    // 幕（extra 以外の唯一の子）より手前、かつ最前面
    const overlay = stage.children.find((c) => c !== extra)!
    expect(stage.children.indexOf(extra)).toBeGreaterThan(stage.children.indexOf(overlay))
    expect(stage.children[stage.children.length - 1]).toBe(extra)
    run(t, 500 + P.exitBlackMs + 40)
    expect(stage.children).not.toContain(extra)
    expect(t.active).toBe(true)
  })

  it('演出が無いときの cancel は stage に触らない', () => {
    const stage = new Container()
    stage.scale.set(2)
    new FieldBattleTransition(() => stage).cancel()
    expect(stage.scale.x).toBe(2)
  })
})

describe('battle_transition: ff で戦闘の結果がホストへ渡る (#831)', () => {
  it('暗転の最も暗い瞬間に onClosed が result つきで呼ばれ、それまでは呼ばれない', () => {
    const { stage, t } = make()
    const onClosed = vi.fn()
    const screen = openFieldBattle({
      stage,
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS, transition: 'ff' },
      roster: {
        party: { hero: { id: 'hero', name: 'hero', hp: 20, mp: 5, atk: 400, def: 2, agi: 3 } },
        order: ['hero'],
        items: { potion: { id: 'potion', name: 'ポーション', kind: '回復' } },
      },
      enemies: [
        {
          id: 'slime',
          name: 'スライム',
          hp: 5,
          maxHp: 5,
          mp: 0,
          maxMp: 0,
          atk: 1,
          def: 0,
          agi: 1,
          exp: 4,
          gold: 6,
          loot: { drops: ['potion 個数=2'] },
        },
      ],
      gate: new FieldInputGate(),
      transition: t,
      onClosed,
    }) as unknown as { handleCommand(id: string): void; tick(ms: number): void }
    screen.handleCommand('attack')
    screen.tick(RESULT_HOLD_DQ_MS)
    // 演出が始まったが、まだ畳まれていない
    expect(t.active).toBe(true)
    expect(onClosed).not.toHaveBeenCalled()
    run(t, P.exitFadeOutMs - 40)
    expect(onClosed).not.toHaveBeenCalled()
    run(t, 100) // 最も暗い瞬間を越える
    expect(onClosed).toHaveBeenCalledTimes(1)
    const [outcome, result] = onClosed.mock.calls[0]
    expect(outcome).toBe('victory')
    expect(result).toMatchObject({
      outcome: 'victory',
      exp: 4,
      gold: 6,
      items: [{ itemId: 'potion', count: 2 }],
    })
    run(t, 2000)
    expect(onClosed).toHaveBeenCalledTimes(1)
  })
})

describe('FieldBattleTransition モザイク (#953)', () => {
  const outcome = 'victory' as const
  const mk = (mode: 'none' | 'ff' | 'ff-mosaic') => {
    const { stage, t } = make()
    t.setParams(battleTransitionParams(mode))
    return { stage, t }
  }
  const mosaicOf = (stage: Container): PixelateFilter | undefined =>
    (stage.filters ?? []).find((f) => f instanceof PixelateFilter) as PixelateFilter | undefined

  it('ff-mosaic の開始: 暗くなるにつれて size が単調に増え、onBlack の時にはフィルタが外れている', () => {
    const { stage, t } = mk('ff-mosaic')
    let sawFilterAtBlack: unknown = 'unset'
    t.playEnter(
      800,
      600,
      () => ({ x: 400, y: 300 }),
      () => {
        sawFilterAtBlack = stage.filters
      }
    )
    const sizes: number[] = []
    for (let e = 0; e < 3000 && t.active; e += 16) {
      t.tick(16)
      const f = mosaicOf(stage)
      if (f) sizes.push(f.sizeX)
    }
    expect(sizes.length).toBeGreaterThan(5)
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1])
    expect(Math.max(...sizes)).toBeGreaterThan(5)
    expect(sawFilterAtBlack === null || (sawFilterAtBlack as unknown[]).length === 0).toBe(true)
    expect(stage.filters ?? []).toHaveLength(0)
  })

  it('ff-mosaic の終了: 山形（等倍→最大→等倍）で、終わるとフィルタが外れ onDone が発火', () => {
    const { stage, t } = mk('ff-mosaic')
    const onBlack = vi.fn()
    const onDone = vi.fn()
    t.playExit(800, 600, outcome, onBlack, onDone)
    const sizes: number[] = []
    for (let e = 0; e < 3000 && t.active; e += 16) {
      t.tick(16)
      const f = mosaicOf(stage)
      sizes.push(f ? f.sizeX : 1)
    }
    const peak = Math.max(...sizes)
    const pi = sizes.indexOf(peak)
    expect(peak).toBeGreaterThan(5)
    expect(sizes[0]).toBeLessThan(peak)
    expect(sizes[sizes.length - 1]).toBeLessThan(peak)
    expect(sizes.slice(pi).every((v, i, a) => i === 0 || v <= a[i - 1] || v === peak)).toBe(true)
    expect(onBlack).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(stage.filters ?? []).toHaveLength(0)
  })

  it('cancel でフィルタが外れる', () => {
    const { stage, t } = mk('ff-mosaic')
    t.playEnter(
      800,
      600,
      () => ({ x: 400, y: 300 }),
      () => {}
    )
    run(t, 500)
    expect(mosaicOf(stage)).toBeDefined()
    t.cancel()
    expect(stage.filters ?? []).toHaveLength(0)
  })

  it('ff と none では付かない', () => {
    for (const mode of ['ff', 'none'] as const) {
      const { stage, t } = mk(mode)
      t.playEnter(
        800,
        600,
        () => ({ x: 400, y: 300 }),
        () => {}
      )
      for (let e = 0; e < 1200; e += 16) {
        t.tick(16)
        expect(stage.filters ?? []).toHaveLength(0)
      }
    }
  })

  it('他のフィルタは残し、自分の分だけ足し引きする', () => {
    const { stage, t } = mk('ff-mosaic')
    const other = new ColorMatrixFilter()
    stage.filters = [other]
    t.playEnter(
      800,
      600,
      () => ({ x: 400, y: 300 }),
      () => {}
    )
    run(t, 500)
    expect(stage.filters).toContain(other)
    expect(mosaicOf(stage)).toBeDefined()
    t.cancel()
    expect(stage.filters).toEqual([other])
  })

  it('ff-mosaic でも onBlack / onDone の発火回数は ff と同じ', () => {
    for (const mode of ['ff', 'ff-mosaic'] as const) {
      const { t } = mk(mode)
      const b1 = vi.fn()
      t.playEnter(800, 600, () => ({ x: 0, y: 0 }), b1)
      run(t, 3000)
      const b2 = vi.fn()
      const d2 = vi.fn()
      t.playExit(800, 600, outcome, b2, d2)
      run(t, 3000)
      expect([b1.mock.calls.length, b2.mock.calls.length, d2.mock.calls.length]).toEqual([1, 1, 1])
    }
  })
})

describe('openFieldBattle の終了で ff-mosaic のモザイクが効く (#953)', () => {
  it('終了の演出中にモザイクが付き、畳んだあと・終了後に stage へ残らない', () => {
    const { stage, t } = make()
    const onClosed = vi.fn()
    const screen = openFieldBattle({
      stage,
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS, transition: 'ff-mosaic' },
      roster: {
        party: { hero: { id: 'hero', name: 'hero', hp: 20, mp: 5, atk: 400, def: 2, agi: 3 } },
        order: ['hero'],
        items: {},
      },
      enemies: [
        {
          id: 'slime',
          name: 'スライム',
          hp: 5,
          maxHp: 5,
          mp: 0,
          maxMp: 0,
          atk: 1,
          def: 0,
          agi: 1,
          exp: 1,
          gold: 1,
        },
      ],
      gate: new FieldInputGate(),
      transition: t,
      onClosed,
    }) as unknown as { handleCommand(id: string): void; tick(ms: number): void }
    screen.handleCommand('attack')
    screen.tick(RESULT_HOLD_DQ_MS)
    let max = 1
    for (let e = 0; e < 3000 && t.active; e += 16) {
      t.tick(16)
      const f = (stage.filters ?? [])[0] as { sizeX?: number } | undefined
      if (f?.sizeX) max = Math.max(max, f.sizeX)
    }
    expect(max).toBeGreaterThan(5)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(stage.filters ?? []).toHaveLength(0)
  })
})
