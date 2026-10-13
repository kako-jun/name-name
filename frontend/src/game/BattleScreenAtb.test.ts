/**
 * BattleScreen の ATB (#205) の単体テスト（独立テスト担当）。
 * 見た目のピクセルではなく、ゲージ棒の描画命令（色・幅）、マーカー、コマンドの有効状態、
 * onClose の回数、destroy 後の tick、モバイル幅でのはみ出しを検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container, Graphics, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import { computeSideBattleLayout, estimateTextWidth } from './battleLayout'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 4,
    maxMp: 4,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

interface Internals {
  atbBars: Graphics[]
  atbBarRects: Array<{ x: number; y: number; w: number; h: number }>
  statusTexts: Text[]
  heroStatsText: Text
  commands: Array<{ id: string; hit: Container; text: Text }>
  destroyed: boolean
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

interface BarInstr {
  action: string
  data: {
    style: { color: number }
    path: { shapePath: { shapePrimitives: Array<{ shape: { width: number } }> } }
  }
}
/** 棒の塗り命令（下地を除く）: [色, 幅] の配列 */
function fills(g: Graphics): Array<[number, number]> {
  const ins = (g as unknown as { context: { instructions: BarInstr[] } }).context.instructions
  return ins
    .filter((i) => i.action === 'fill')
    .slice(1) // 先頭は下地（黒）
    .map((i) => [i.data.style.color, i.data.path.shapePath.shapePrimitives[0].shape.width])
}

const created: BattleScreen[] = []
function build(
  party: BattleEntity[],
  enemies: BattleEntity[],
  atb: ConstructorParameters<typeof BattleEngine>[2] extends infer O ? O : never,
  opts: BattleScreenOptions = { layout: 'side' },
  w = 800,
  h = 450
): { s: BattleScreen; engine: BattleEngine } {
  const engine = new BattleEngine(party, enemies, atb)
  const s = new BattleScreen(engine, w, h, opts)
  created.push(s)
  return { s, engine }
}
const ATB = (
  initial?: { party?: number[]; enemies?: number[] },
  mode: 'wait' | 'active' = 'wait'
) => ({
  atb: { mode, initialGauges: initial },
  rng: () => 0,
})

afterEach(() => {
  for (const s of created.splice(0)) if (!I(s).destroyed) s.destroy({ children: true })
  vi.restoreAllMocks()
})

describe('BattleScreen ATB: ゲージ棒の有無', () => {
  it.each([
    ['side', 3],
    ['front', 1],
  ] as const)('%s: ATB なら棒が %d 本（side=味方数 / front=1）', (layout, n) => {
    const { s } = build([ent('a'), ent('b'), ent('c')], [ent('s')], ATB(), { layout })
    expect(I(s).atbBars).toHaveLength(n)
  })

  it.each(['side', 'front'] as const)(
    '%s: ATB でなければ棒は作られず、tick は何もしない',
    (layout) => {
      const rng = () => 0
      const { s, engine } = build([ent('a')], [ent('s')], { rng }, { layout })
      expect(I(s).atbBars).toHaveLength(0)
      const before = JSON.stringify(engine.getState())
      s.tick(5000)
      expect(JSON.stringify(engine.getState())).toBe(before)
    }
  )
})

describe('BattleScreen ATB: ゲージ棒の色と幅（溜まり中は青・満タンは黄）', () => {
  it('ゲージ 0 → 塗りなし / 500 → 青で半分 / 999 → 青 / 1000 → 黄で全幅', () => {
    const { s } = build(
      [ent('a'), ent('b'), ent('c'), ent('d')],
      [ent('s')],
      ATB({ party: [0, 500, 999, 1000] })
    )
    const w = I(s).atbBarRects[0].w
    expect(fills(I(s).atbBars[0])).toEqual([])
    expect(fills(I(s).atbBars[1])).toEqual([[0x66aaff, w * 0.5]])
    const [c2, w2] = fills(I(s).atbBars[2])[0]
    expect(c2).toBe(0x66aaff)
    expect(w2).toBeCloseTo(w * 0.999, 6)
    expect(fills(I(s).atbBars[3])).toEqual([[0xffdd55, w]])
  })

  it('倒れた味方の棒は空', () => {
    const { s } = build([ent('a', { hp: 0 }), ent('b')], [ent('s')], ATB({ party: [1000, 0] }))
    expect(fills(I(s).atbBars[0])).toEqual([])
  })

  it('tick で棒が伸びる（1000ms で AGI5 は 200/1000）', () => {
    const { s } = build([ent('a')], [ent('s')], ATB())
    s.tick(1000)
    const w = I(s).atbBarRects[0].w
    const [color, width] = fills(I(s).atbBars[0])[0]
    expect(color).toBe(0x66aaff)
    expect(width).toBeCloseTo(w * 0.2, 6)
  })

  it('満タンで黄色に変わり、行動すると空に戻る', () => {
    const { s, engine } = build([ent('a')], [ent('s')], ATB())
    s.tick(5000)
    expect(fills(I(s).atbBars[0])[0][0]).toBe(0xffdd55)
    I(s).commands[0].hit.emit('pointertap', {} as never)
    expect(engine.getState().atb!.partyGauge[0]).toBe(0)
    expect(fills(I(s).atbBars[0])).toEqual([])
  })
})

describe('BattleScreen ATB: 番の味方のマーカー（▶ + 黄色）', () => {
  it('side: キュー先頭だけ ▶ が付いて黄色。他は付かず白', () => {
    const { s } = build([ent('a'), ent('b')], [ent('s')], ATB({ party: [0, 1000] }))
    const [ta, tb] = I(s).statusTexts
    expect(tb.text.startsWith('▶B')).toBe(true)
    expect(tb.style.fill).toBe(0xffee66)
    expect(ta.text.includes('▶')).toBe(false)
    expect(ta.style.fill).toBe(0xffffff)
  })

  it('side: 行動後はマーカーが消える', () => {
    const { s } = build([ent('a')], [ent('s')], ATB({ party: [1000] }))
    expect(I(s).statusTexts[0].text.startsWith('▶')).toBe(true)
    I(s).commands[0].hit.emit('pointertap', {} as never)
    expect(I(s).statusTexts[0].text.includes('▶')).toBe(false)
    expect(I(s).statusTexts[0].style.fill).toBe(0xffffff)
  })

  it('front: 番なら heroStatsText に ▶ と黄色', () => {
    const { s } = build([ent('a')], [ent('s')], ATB({ party: [1000] }), { layout: 'front' })
    expect(I(s).heroStatsText.text.startsWith('▶A')).toBe(true)
    expect(I(s).heroStatsText.style.fill).toBe(0xffee66)
  })

  it('従来ターン制にはマーカーが付かない（不変）', () => {
    const { s } = build([ent('a')], [ent('s')], { rng: () => 0 })
    expect(I(s).statusTexts[0].text.includes('▶')).toBe(false)
  })

  it('倒れた味方は灰色のまま（番にならない）', () => {
    const { s } = build([ent('a', { hp: 0 }), ent('b')], [ent('s')], ATB({ party: [1000, 0] }))
    expect(I(s).statusTexts[0].style.fill).toBe(0x888888)
    expect(I(s).statusTexts[0].text.includes('▶')).toBe(false)
  })
})

describe('BattleScreen ATB: コマンドの有効状態（atb-running 中は「にげる」だけ）', () => {
  const enabled = (s: BattleScreen) =>
    Object.fromEntries(
      I(s).commands.map((c) => [c.id, c.hit.eventMode === 'static' && c.hit.alpha === 1])
    )

  it('atb-running: にげるだけ有効', () => {
    const { s } = build([ent('a')], [ent('s')], ATB())
    expect(enabled(s)).toEqual({ attack: false, spell: false, item: false, escape: true })
  })

  it('party-input: 全部有効', () => {
    const { s } = build([ent('a')], [ent('s')], ATB({ party: [1000] }))
    expect(enabled(s)).toEqual({ attack: true, spell: true, item: true, escape: true })
  })

  it('tick で満タンになると全部有効に、行動すると にげる だけに戻る', () => {
    const { s } = build([ent('a')], [ent('s')], ATB())
    s.tick(5000)
    expect(enabled(s).attack).toBe(true)
    I(s).commands[0].hit.emit('pointertap', {} as never)
    expect(enabled(s)).toEqual({ attack: false, spell: false, item: false, escape: true })
  })

  it('終了後は にげる も無効', () => {
    const { s, engine } = build(
      [ent('a', { atk: 999 })],
      [ent('s', { hp: 1 })],
      ATB({ party: [1000] })
    )
    I(s).commands[0].hit.emit('pointertap', {} as never)
    expect(engine.getState().phase).toBe('victory')
    expect(Object.values(enabled(s)).some(Boolean)).toBe(false)
  })

  it('従来ターン制は party-input で全部有効（不変）', () => {
    const { s } = build([ent('a')], [ent('s')], { rng: () => 0 })
    expect(enabled(s)).toEqual({ attack: true, spell: true, item: true, escape: true })
  })

  it('atb-running 中に にげる を押すと escape できる（onClose は escaped で 1 回）', () => {
    const onClose = vi.fn()
    const { s } = build([ent('a')], [ent('s')], ATB(), { layout: 'side', onClose })
    I(s).commands[3].hit.emit('pointertap', {} as never)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('escaped')
  })
})

describe('BattleScreen ATB: onClose は 1 回だけ', () => {
  it('tick で全滅 → onClose(defeat) 1 回。以後の tick / クリックでは呼ばれない', () => {
    const onClose = vi.fn()
    const { s } = build(
      [ent('a', { hp: 5, agi: 1 })],
      [ent('s', { agi: 10, atk: 50 })],
      ATB({}, 'active'),
      { layout: 'side', onClose }
    )
    s.tick(2500)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('defeat')
    s.tick(2500)
    s.tick(2500)
    for (const c of I(s).commands) c.hit.emit('pointertap', {} as never)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('クリックで勝利 → onClose(victory) 1 回。その後の tick でも増えない', () => {
    const onClose = vi.fn()
    const { s } = build([ent('a', { atk: 999 })], [ent('s', { hp: 1 })], ATB({ party: [1000] }), {
      layout: 'side',
      onClose,
    })
    I(s).commands[0].hit.emit('pointertap', {} as never)
    s.tick(5000)
    I(s).commands[0].hit.emit('pointertap', {} as never)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('victory')
  })

  it('従来ターン制でも onClose は 1 回', () => {
    const onClose = vi.fn()
    const { s } = build(
      [ent('a', { atk: 999 })],
      [ent('s', { hp: 1 })],
      { rng: () => 0 },
      {
        layout: 'side',
        onClose,
      }
    )
    I(s).commands[0].hit.emit('pointertap', {} as never)
    I(s).commands[0].hit.emit('pointertap', {} as never)
    s.tick(1000)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onClose の中で destroy しても例外にならず、その後の tick は無害', () => {
    let screen: BattleScreen | null = null
    const onClose = vi.fn(() => screen?.destroy({ children: true }))
    const { s } = build(
      [ent('a', { hp: 5, agi: 1 })],
      [ent('s', { agi: 10, atk: 50 })],
      ATB({}, 'active'),
      { layout: 'side', onClose }
    )
    screen = s
    expect(() => s.tick(2500)).not.toThrow()
    expect(() => s.tick(2500)).not.toThrow()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('BattleScreen ATB: destroy と tick の race', () => {
  it('destroy 後の tick はエンジンを進めず、例外も出さない', () => {
    const { s, engine } = build([ent('a')], [ent('s')], ATB())
    s.destroy({ children: true })
    const before = JSON.stringify(engine.getState())
    expect(() => s.tick(5000)).not.toThrow()
    expect(JSON.stringify(engine.getState())).toBe(before)
  })
})

describe('BattleScreen ATB: 再描画の節約（署名）', () => {
  it('状態が変わらない tick では全表示更新（refresh）を呼ばず、変わったときは呼ぶ', () => {
    const { s } = build([ent('a')], [ent('s')], ATB())
    const spy = vi.spyOn(I(s), 'refresh')
    s.tick(100)
    s.tick(100)
    expect(spy).not.toHaveBeenCalled()
    s.tick(5000) // 満タン: phase とキューが変わる
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('敵の攻撃（ログが増える）でも refresh される', () => {
    const { s } = build([ent('a', { agi: 1 })], [ent('s', { agi: 10 })], ATB())
    const spy = vi.spyOn(I(s), 'refresh')
    s.tick(2500)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(I(s).statusTexts[0].text).toContain('HP 90/100')
  })
})

describe('BattleScreen ATB: モバイル幅（360x640）で棒と文字が重ならない', () => {
  it.each([
    [360, 640, 4],
    [320, 568, 4],
    [360, 640, 1],
  ])('%dx%d・味方 %d 人: 文字の右端 <= 棒の左端、棒は status 枠内', (w, h, n) => {
    const party = Array.from({ length: n }, (_, i) =>
      ent(`p${i}`, { name: 'とてもながいなまえのゆうしゃ', hp: 120, maxHp: 120, mp: 99, maxMp: 99 })
    )
    const { s } = build(
      party,
      [ent('s')],
      ATB({ party: party.map(() => 1000) }),
      { layout: 'side' },
      w,
      h
    )
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: n, enemyCount: 1 })
    const rects = I(s).atbBarRects
    expect(rects).toHaveLength(n)
    I(s).statusTexts.forEach((t, i) => {
      const r = rects[i]
      expect(t.x + estimateTextWidth(t.text, 14)).toBeLessThanOrEqual(r.x + 0.001)
      expect(r.x).toBeGreaterThanOrEqual(L.status.x)
      expect(r.x + r.w).toBeLessThanOrEqual(L.status.x + L.status.w + 0.001)
      expect(r.w).toBeGreaterThanOrEqual(28)
      expect(r.w).toBeLessThanOrEqual(64)
    })
  })

  it('redraw でサイズが変わっても棒の矩形が追従する', () => {
    const { s } = build([ent('a')], [ent('s')], ATB({ party: [500] }))
    const before = I(s).atbBarRects[0].x
    s.redraw(360, 640)
    expect(I(s).atbBarRects[0].x).not.toBe(before)
    const [, width] = fills(I(s).atbBars[0])[0]
    expect(width).toBeCloseTo(I(s).atbBarRects[0].w * 0.5, 6)
  })
})

describe('BattleScreen ATB: console 汚染', () => {
  it('ATB の通常進行・クリック・destroy で warn / error を出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { s } = build([ent('a'), ent('b')], [ent('s', { hp: 40 })], ATB({}, 'active'))
    for (let n = 0; n < 20; n++) {
      s.tick(1000)
      I(s).commands[0].hit.emit('pointertap', {} as never)
    }
    s.destroy({ children: true })
    expect(warn).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
  })
})
