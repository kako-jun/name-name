/**
 * FF 式メッセージ窓の文字サイズ (#1148)。窓の言葉だけ大きくし（1 行のまま）、dq のログ行は変えない。
 * 観点: 定数関係 / 最小の窓に収まる / ff の style / dq のログ行 / fitLabel の幅と「…」 / 勝利列・台詞（notice）でも同じ
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as layoutModule from './battleLayout'
import type { Text } from 'pixi.js'
import { BattleScreen, MESSAGE_WINDOW_FONT_SIZE, type BattleScreenOptions } from './BattleScreen'
import { skipEntrance } from './battleScreenTestUtil'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { computeSideLogHeight, estimateTextWidth } from './battleLayout'

/** BattleScreen の LOG_FONT_SIZE は非公開なので、dq のログ行の実 style で確かめる前提値（変えたらここも直す） */
const LOG_FONT_SIZE_EXPECTED = 16

// 配線の確認用に computeSideBattleLayout の入力を記録する（中身は本物のまま）
vi.mock('./battleLayout', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./battleLayout')>()
  return { ...orig, computeSideBattleLayout: vi.fn(orig.computeSideBattleLayout) }
})
const layoutSpy = vi.mocked(layoutModule.computeSideBattleLayout)

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 30,
    maxHp: 30,
    mp: 4,
    maxMp: 4,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  messageText: Text | null
  logLines: Text[]
  messageRect: { x: number; y: number; w: number; h: number }
  resultElapsed: number | null
  commands: { id: string; hit: { emit: (e: string, a: never) => void } }[]
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}, enemy: Partial<BattleEntity> = {}) {
  const engine = new BattleEngine(
    [entity('hero', { atk: 999 })],
    [entity('slime', { hp: 1, maxHp: 1, atk: 1, ...enemy })],
    { rng: () => 0.5 }
  )
  const s = skipEntrance(
    new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  )
  created.push(s)
  return { s, engine }
}
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
}
const style = (t: Text) => Number((t.style as { fontSize: number | string }).fontSize)

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('メッセージ窓の文字サイズ (#1148)', () => {
  it('ログ行より大きい', () => {
    expect(MESSAGE_WINDOW_FONT_SIZE).toBeGreaterThan(LOG_FONT_SIZE_EXPECTED)
  })

  it('ff の窓（1 行 = 36px）に、行ボックスの目安（×1.5）が収まる (#1178)', () => {
    expect(MESSAGE_WINDOW_FONT_SIZE * 1.5).toBeLessThanOrEqual(computeSideLogHeight(1))
  })

  it('ff: messageText の style が MESSAGE_WINDOW_FONT_SIZE', () => {
    const { s } = setup()
    expect(style(I(s).messageText!)).toBe(MESSAGE_WINDOW_FONT_SIZE)
  })

  it('dq: メッセージ窓は無く、ログ行は 16px のまま', () => {
    const { s } = setup({ presentation: 'dq' })
    expect(I(s).messageText).toBeNull()
    expect(I(s).logLines.length).toBeGreaterThan(0)
    for (const l of I(s).logLines) expect(style(l)).toBe(LOG_FONT_SIZE_EXPECTED)
  })

  it('ff: 長い言葉は幅（r.w-24）内に収まり、末尾が「…」。短い言葉はそのまま', () => {
    const { s, engine } = setup({}, { hp: 99, maxHp: 99 })
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'ア'.repeat(80), target: '相手単体', effect: 'damage 1..1' }
    )
    s.redraw(800, 450)
    run(s, 16)
    const m = I(s).messageText!
    const r = I(s).messageRect
    expect(m.visible).toBe(true)
    expect(m.text.endsWith('…')).toBe(true)
    expect(m.text.length).toBeLessThan(80)
    expect(estimateTextWidth(m.text, MESSAGE_WINDOW_FONT_SIZE)).toBeLessThanOrEqual(r.w - 24)

    run(s, 5000)
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'ファイア', target: '相手単体', effect: 'damage 1..1' }
    )
    s.redraw(800, 450)
    run(s, 16)
    expect(m.text).toBe('ファイア')
  })

  it('ff: 勝利メッセージ列でも同じサイズ（全件）', () => {
    const { s } = setup()
    I(s)
      .commands.find((c) => c.id === 'attack')!
      .hit.emit('pointertap', {} as never)
    let guard = 0
    while (I(s).resultElapsed === null && guard++ < 600) run(s, 16)
    expect(I(s).resultElapsed).not.toBeNull()
    for (let i = 0; i < 10; i++) {
      expect(I(s).messageText!.visible).toBe(true)
      expect(style(I(s).messageText!)).toBe(MESSAGE_WINDOW_FONT_SIZE)
      run(s, 100)
    }
  })

  it('ff: 台詞（notice）の表示中も同じサイズ', () => {
    const engine = new BattleEngine([entity('hero')], [entity('boss')], {
      rng: () => 0.5,
      script: { id: 'sc', rules: ['台詞: 条件=開始 話者=ボス 文=かかってこい'] },
    })
    const s = skipEntrance(
      new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
    )
    created.push(s)
    s.tick(1)
    expect(I(s).messageText!.text).toBe('ボス「かかってこい」')
    expect(I(s).messageText!.visible).toBe(true)
    expect(style(I(s).messageText!)).toBe(MESSAGE_WINDOW_FONT_SIZE)
  })
})

describe('メッセージ窓の高さと配線 (#1178)', () => {
  function build(
    opts: BattleScreenOptions,
    enemyCount = 1,
    enemy: Partial<BattleEntity> = {},
    w = 1280,
    h = 720
  ) {
    const engine = new BattleEngine(
      [entity('hero')],
      Array.from({ length: enemyCount }, (_, i) =>
        entity(`slime${i}`, { hp: 30, maxHp: 30, atk: 1, ...enemy })
      ),
      { rng: () => 0.5 }
    )
    const s = skipEntrance(new BattleScreen(engine, w, h, { layout: 'side', ...opts }))
    created.push(s)
    return s
  }
  const grid = { cols: 6, rows: 2 }
  const rectH = (s: BattleScreen) => I(s).messageRect.h
  const slotOf = (s: BattleScreen) =>
    (s as unknown as { enemyViews: { slotRef: { y: number; size: number; width: number } }[] })
      .enemyViews[0].slotRef

  it('ff: 窓は 1 行ぶんの高さ。敵の数・グリッドの有無・列数・行数で変わらない', () => {
    const h1 = computeSideLogHeight(1)
    for (const enemyCount of [1, 3, 6]) {
      expect(rectH(build({ presentation: 'ff' }, enemyCount))).toBe(h1)
      expect(
        rectH(
          build({ presentation: 'ff', enemyGrid: grid }, enemyCount, {
            layout: { w: 1, h: 1, scale: 1 },
          })
        )
      ).toBe(h1)
      expect(
        rectH(
          build({ presentation: 'ff', enemyGrid: { cols: 12, rows: 4 } }, enemyCount, {
            layout: { w: 1, h: 1, scale: 1 },
          })
        )
      ).toBe(h1)
    }
  })

  it('dq: 窓は敵の数で可変（従来どおり）で、グリッドの有無で変わらない', () => {
    const noGrid = [1, 3].map((n) => rectH(build({ presentation: 'dq' }, n)))
    expect(noGrid[0]).toBe(computeSideLogHeight(2))
    expect(noGrid[1]).toBe(computeSideLogHeight(4))
    const withGrid = [1, 3].map((n) =>
      rectH(build({ presentation: 'dq', enemyGrid: grid }, n, { layout: { w: 1, h: 1, scale: 1 } }))
    )
    expect(withGrid).toEqual(noGrid)
  })

  it('グリッドなしでも、敵の表示倍率が配置に届く', () => {
    const full = slotOf(build({ presentation: 'ff' }))
    const half = slotOf(build({ presentation: 'ff' }, 1, { layout: { w: 1, h: 1, scale: 0.5 } }))
    expect(half.size).toBeCloseTo(full.size * 0.5)
    expect(half.width).toBeCloseTo(full.width * 0.5)
  })

  it('グリッドなしでも、battle_enemy_window_overlap と倍率が computeSideBattleLayout の入力に届く。messageLines は ff だけ', () => {
    const lastInput = () => layoutSpy.mock.calls[layoutSpy.mock.calls.length - 1][0]
    build({ presentation: 'ff', enemyWindowOverlap: 0.3 }, 1, {
      layout: { w: 1, h: 1, scale: 0.5 },
    })
    expect(lastInput().enemyGrid).toBeUndefined()
    expect(lastInput().enemyWindowOverlap).toBe(0.3)
    expect(lastInput().enemyScales).toEqual([0.5])
    expect(lastInput().messageLines).toBe(1)
    build({ presentation: 'dq', enemyGrid: grid }, 1, { layout: { w: 1, h: 1, scale: 1 } })
    expect(lastInput().enemyGrid).toEqual(grid)
    expect(lastInput().messageLines).toBeUndefined()
  })
})
