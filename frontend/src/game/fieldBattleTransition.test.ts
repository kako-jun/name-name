import { describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { DEFAULT_BATTLE_TRANSITION_PARAMS as P } from './battleTransition'
import { FieldBattleTransition } from './fieldBattleTransition'

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
