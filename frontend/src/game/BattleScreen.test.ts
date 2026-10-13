/**
 * BattleScreen (#173 / #736) の単体テスト。
 *
 * PixiJS の実描画（見た目）は対象外。`Assets.load` をモックして jsdom で、
 * visible / フォールバック / 背景 sprite の有無 / console.warn / destroy 後 resolve の race を検証する。
 * EventImageLayer.test.ts と同じ流儀（internals キャストで private を観測し、`vi.spyOn(Assets, 'load')`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Assets,
  type Container,
  type Graphics,
  type Sprite,
  Texture,
  TextureSource,
  type Text,
} from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  SIDE_COMMAND_TEXT_PADDING,
  SIDE_LABEL_STROKE_WIDTH,
  SIDE_LOG_MIN_LINES,
  SIDE_STATUS_COMPACT_WIDTH,
  computeContainFit,
  computeSideBattleLayout,
  estimateTextWidth,
} from './battleLayout'
import { computeAcrylicGeometry, resolveAcrylicParams } from './spriteStyle'
import type { AcrylicEdgeFilter } from './acrylicEdgeFilter'

const DEAD_ALPHA = 0.3

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 10,
    maxHp: 10,
    mp: 4,
    maxMp: 4,
    atk: 3,
    def: 1,
    agi: 2,
    ...over,
  }
}

interface EntityViewLike {
  container: Container
  fallback: Graphics
  sprite: Sprite | null
  acrylicBack: Graphics | null
  acrylicFilter: AcrylicEdgeFilter | null
  label: Text | null
}
interface Internals {
  dim: Graphics
  enemyNameText: Text
  enemyHpText: Text
  heroStatsText: Text
  enemyViews: EntityViewLike[]
  partyViews: EntityViewLike[]
  statusTexts: Text[]
  logLines: Text[]
  backgroundSprite: Sprite | null
  layoutMode: 'front' | 'side'
  children: Container[]
  destroyed: boolean
}
const internals = (s: BattleScreen): Internals => s as unknown as Internals

function mockTexture(width = 100, height = 50): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function make(
  party: BattleEntity[],
  enemies: BattleEntity[],
  opts: BattleScreenOptions = {},
  w = 800,
  h = 450
): BattleScreen {
  return new BattleScreen(new BattleEngine(party, enemies), w, h, opts)
}

/** dim が半透明黒を塗っているか（clear 済みなら bounds が空） */
function dimIsPainted(s: BattleScreen): boolean {
  const b = internals(s).dim.getLocalBounds()
  return b.width > 0 && b.height > 0
}

const created: BattleScreen[] = []
function track(s: BattleScreen): BattleScreen {
  created.push(s)
  return s
}

afterEach(() => {
  for (const s of created.splice(0)) {
    if (!internals(s).destroyed) s.destroy({ children: true })
  }
  vi.restoreAllMocks()
})

describe('BattleScreen: front（従来）', () => {
  it('opts なしで従来構成（enemyName/enemyHp/heroStats が visible・stage container なし）', () => {
    const s = track(make([entity('hero')], [entity('slime')]))
    const i = internals(s)
    expect(i.enemyNameText.visible).toBe(true)
    expect(i.enemyHpText.visible).toBe(true)
    expect(i.heroStatsText.visible).toBe(true)
    expect(i.enemyViews).toHaveLength(0)
    expect(i.partyViews).toHaveLength(0)
    expect(i.statusTexts).toHaveLength(0)
  })

  it("layout:'front' 明示でも opts なしと同一構成", () => {
    const a = track(make([entity('hero')], [entity('slime')]))
    const b = track(make([entity('hero')], [entity('slime')], { layout: 'front' }))
    expect(internals(b).children.length).toBe(internals(a).children.length)
    expect(internals(b).enemyViews).toHaveLength(0)
    expect(internals(b).heroStatsText.visible).toBe(true)
  })

  it('front ではログ末尾 4 件を表示する（side の行数ではない）', () => {
    const engine = new BattleEngine(
      [entity('hero', { atk: 1 })],
      [entity('slime', { hp: 999, maxHp: 999 })]
    )
    const s = track(new BattleScreen(engine, 800, 450))
    const log = engine.getState().log
    const shown = internals(s).logLines.map((t) => t.text)
    expect(shown.filter((t) => t !== '')).toEqual(log.slice(-internals(s).logLines.length))
  })
})

describe('BattleScreen: 背景画像', () => {
  it('background 未指定なら Assets.load を呼ばない', () => {
    const load = vi.spyOn(Assets, 'load')
    track(make([entity('hero')], [entity('slime')]))
    expect(load).not.toHaveBeenCalled()
  })

  it('background 成功 → 背景 sprite が先頭（index 0）で、dim は半透明黒を塗らない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' }))
    // ロード前は従来どおり暗くする
    expect(dimIsPainted(s)).toBe(true)
    await flushPromises()
    const i = internals(s)
    expect(i.backgroundSprite).not.toBeNull()
    expect(i.children[0]).toBe(i.backgroundSprite)
    expect(dimIsPainted(s)).toBe(false)
  })

  it('background 失敗 → warn 1 回・dim は半透明黒のまま・背景 sprite なし・例外なし', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/missing.webp' }))
    await flushPromises()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(internals(s).backgroundSprite).toBeNull()
    expect(dimIsPainted(s)).toBe(true)
  })

  it('背景成功後に redraw しても背景 sprite は 1 つのまま', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' }))
    await flushPromises()
    s.redraw(400, 700)
    s.redraw(800, 450)
    const sprites = internals(s).children.filter((c) => c === internals(s).backgroundSprite)
    expect(sprites).toHaveLength(1)
    expect(dimIsPainted(s)).toBe(false)
  })

  it('背景ロードが destroy 後に resolve しても例外なし・sprite を追加しない', async () => {
    let resolve!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((r) => {
        resolve = r
      }) as never
    )
    const s = make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' })
    s.destroy({ children: true })
    resolve(mockTexture())
    await flushPromises()
    expect(internals(s).backgroundSprite).toBeNull()
  })
})

describe('BattleScreen: side', () => {
  const side: BattleScreenOptions = { layout: 'side' }

  it('enemyName/enemyHp/heroStats を非表示にする', () => {
    const s = track(make([entity('hero')], [entity('slime')], side))
    const i = internals(s)
    expect(i.enemyNameText.visible).toBe(false)
    expect(i.enemyHpText.visible).toBe(false)
    expect(i.heroStatsText.visible).toBe(false)
  })

  it('敵 3・味方 2 で EntityView が 3 + 2', () => {
    const s = track(
      make([entity('hero'), entity('mage')], [entity('a'), entity('b'), entity('c')], side)
    )
    expect(internals(s).enemyViews).toHaveLength(3)
    expect(internals(s).partyViews).toHaveLength(2)
    expect(internals(s).statusTexts).toHaveLength(2)
  })

  it('sprite 指定 → Assets.load が sprite パスで呼ばれ、ロード後にフォールバックが非表示になる', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime', { sprite: 'm/slime.webp' })], side))
    expect(load).toHaveBeenCalledWith('m/slime.webp')
    expect(internals(s).enemyViews[0].fallback.visible).toBe(true)
    await flushPromises()
    const v = internals(s).enemyViews[0]
    expect(v.sprite).not.toBeNull()
    expect(v.fallback.visible).toBe(false)
  })

  it('sprite 失敗 → フォールバック可視・warn・他の view に影響しない', async () => {
    vi.spyOn(Assets, 'load').mockImplementation(((path: string) =>
      path === 'm/bad.webp'
        ? Promise.reject(new Error('404'))
        : Promise.resolve(mockTexture())) as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(
      make(
        [entity('hero', { sprite: 'p/hero.webp' })],
        [entity('bad', { sprite: 'm/bad.webp' }), entity('ok', { sprite: 'm/ok.webp' })],
        side
      )
    )
    await flushPromises()
    const i = internals(s)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(i.enemyViews[0].sprite).toBeNull()
    expect(i.enemyViews[0].fallback.visible).toBe(true)
    expect(i.enemyViews[1].sprite).not.toBeNull()
    expect(i.enemyViews[1].fallback.visible).toBe(false)
    expect(i.partyViews[0].sprite).not.toBeNull()
  })

  it('sprite 未指定の entity は Assets.load を呼ばず色四角のまま', () => {
    const load = vi.spyOn(Assets, 'load')
    const s = track(make([entity('hero')], [entity('slime')], side))
    expect(load).not.toHaveBeenCalled()
    expect(internals(s).enemyViews[0].fallback.visible).toBe(true)
    expect(internals(s).partyViews[0].fallback.visible).toBe(true)
  })

  it.each([
    [-1, DEAD_ALPHA],
    [0, DEAD_ALPHA],
    [1, 1],
  ])('hp=%d の敵・味方 view の alpha は %d', (hp, alpha) => {
    const s = track(make([entity('hero', { hp })], [entity('slime', { hp })], side))
    expect(internals(s).enemyViews[0].container.alpha).toBe(alpha)
    expect(internals(s).partyViews[0].container.alpha).toBe(alpha)
  })

  it('statusText は 320 幅では MP なし・800 幅では MP あり', () => {
    const narrow = track(make([entity('hero')], [entity('slime')], side, 320, 568))
    const wide = track(make([entity('hero')], [entity('slime')], side, 800, 450))
    expect(internals(narrow).statusTexts[0].text).toContain('HP 10/10')
    expect(internals(narrow).statusTexts[0].text).not.toContain('MP')
    expect(internals(wide).statusTexts[0].text).toContain('MP 4/4')
  })

  it('味方 hp=0 の statusText は灰色 fill', () => {
    const s = track(make([entity('hero'), entity('mage', { hp: 0 })], [entity('slime')], side))
    const [alive, dead] = internals(s).statusTexts
    expect(alive.style.fill).not.toBe(dead.style.fill)
    expect(dead.style.fill).toBe(0x888888)
  })

  it('敵ラベルは名前と HP を含む', () => {
    const s = track(make([entity('hero')], [entity('slime', { name: 'スライム' })], side))
    expect(internals(s).enemyViews[0].label?.text).toBe('スライム\nHP 10/10')
    expect(internals(s).partyViews[0].label).toBeNull()
  })

  it.each([[SIDE_LOG_MIN_LINES - 1], [SIDE_LOG_MIN_LINES], [SIDE_LOG_MIN_LINES + 1]])(
    'ログは直近 SIDE_LOG_MIN_LINES 行のみ（敵 1 体）（エンジンのログが %d 行のとき）',
    (count) => {
      const engine = new BattleEngine([entity('hero')], [entity('slime')])
      const log = engine.getState().log as string[]
      log.length = 0
      for (let n = 0; n < count; n++) log.push(`line${n}`)
      const s = track(new BattleScreen(engine, 800, 450, side))
      const shown = internals(s)
        .logLines.map((t) => t.text)
        .filter((t) => t !== '')
      expect(shown).toEqual(log.slice(-SIDE_LOG_MIN_LINES))
      expect(shown.length).toBe(Math.min(count, SIDE_LOG_MIN_LINES))
    }
  )

  it('背景失敗かつ sprite 失敗でも例外なし', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(
      make([entity('hero', { sprite: 'p/x.webp' })], [entity('slime', { sprite: 'm/x.webp' })], {
        layout: 'side',
        background: 'bg/x.webp',
      })
    )
    await flushPromises()
    expect(internals(s).backgroundSprite).toBeNull()
    expect(internals(s).enemyViews[0].fallback.visible).toBe(true)
  })

  it('destroy 後に sprite ロードが resolve しても例外なし・sprite を追加しない', async () => {
    const resolvers: Array<(t: Texture) => void> = []
    vi.spyOn(Assets, 'load').mockImplementation(
      (() => new Promise<Texture>((r) => resolvers.push(r))) as never
    )
    const s = make(
      [entity('hero', { sprite: 'p/x.webp' })],
      [entity('slime', { sprite: 'm/x.webp' })],
      side
    )
    const views = [...internals(s).enemyViews, ...internals(s).partyViews]
    s.destroy({ children: true })
    for (const r of resolvers) r(mockTexture())
    await flushPromises()
    for (const v of views) expect(v.sprite).toBeNull()
  })

  it('背景も sprite も成功する経路で warn / error が出ない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    track(
      make([entity('hero', { sprite: 'p/x.webp' })], [entity('slime', { sprite: 'm/x.webp' })], {
        layout: 'side',
        background: 'bg/x.webp',
      })
    )
    await flushPromises()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('redraw で幅 800 → 360 にすると compact へ切り替わり statusText が短縮される', () => {
    const s = track(make([entity('hero')], [entity('slime')], side, 800, 450))
    expect(internals(s).statusTexts[0].text).toContain('MP')
    s.redraw(360, 640)
    expect(internals(s).statusTexts[0].text).not.toContain('MP')
    s.redraw(800, 450)
    expect(internals(s).statusTexts[0].text).toContain('MP')
  })

  it('compact 閾値の定数が MP 表記の切替に使われている（幅スイープで MP 有無が一度だけ切り替わる）', () => {
    const s = track(make([entity('hero')], [entity('slime')], side, 800, 450))
    let prev = false
    let flips = 0
    for (let w = 300; w <= 900; w += 10) {
      s.redraw(w, 640)
      const hasMp = internals(s).statusTexts[0].text.includes('MP')
      if (hasMp !== prev) flips++
      prev = hasMp
    }
    expect(flips).toBe(1)
    expect(SIDE_STATUS_COMPACT_WIDTH).toBeGreaterThan(0)
  })
})

describe('BattleScreen: side のレビュー指摘対応 (#736)', () => {
  const sideOpts: BattleScreenOptions = { layout: 'side' }
  const enemies = (n: number): BattleEntity[] =>
    Array.from({ length: n }, (_, k) => entity(`e${k}`, { name: `てき${k}` }))

  it.each([
    [1, 2],
    [2, 3],
    [3, 4],
    [6, 4],
  ])('敵 %d 体 → ログ行テキストは %d 本だけ生成される（800x720）', (n, lines) => {
    const s = track(make([entity('hero')], enemies(n), sideOpts, 800, 720))
    expect(internals(s).logLines).toHaveLength(lines)
  })

  it('低い画面ではログ行テキストが減り、リサイズで増減に追従する', () => {
    const party = [entity('p0'), entity('p1'), entity('p2'), entity('p3')]
    const s = track(make(party, enemies(6), sideOpts, 800, 720))
    expect(internals(s).logLines).toHaveLength(4)
    s.redraw(568, 320)
    expect(internals(s).logLines).toHaveLength(SIDE_LOG_MIN_LINES)
    s.redraw(800, 720)
    expect(internals(s).logLines).toHaveLength(4)
  })

  it('敵が複数いてもログの行数ぶんだけ直近ログを表示する', () => {
    const engine = new BattleEngine([entity('hero')], enemies(3))
    const log = engine.getState().log as string[]
    log.length = 0
    for (let n = 0; n < 9; n++) log.push(`line${n}`)
    const s = track(new BattleScreen(engine, 800, 720, sideOpts))
    expect(internals(s).logLines.map((t) => t.text)).toEqual(log.slice(-4))
  })

  it('敵ラベルは縁取り(stroke)付き。背景指定の有無で変わらない', () => {
    for (const opts of [sideOpts, { ...sideOpts, background: 'bg/x.webp' }]) {
      vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
      const s = track(make([entity('hero')], [entity('slime')], opts))
      const stroke = internals(s).enemyViews[0].label!.style.stroke as {
        color: unknown
        width: number
      }
      expect(stroke.width).toBe(SIDE_LABEL_STROKE_WIDTH)
      expect(stroke.width).toBeGreaterThan(0)
    }
  })

  it('敵ラベルは container 相対でスプライト直下（純粋関数のラベル矩形）に置かれる', () => {
    const s = track(make([entity('hero')], enemies(3), sideOpts, 800, 720))
    const L = computeSideBattleLayout({
      width: 800,
      height: 720,
      partyCount: 1,
      enemyCount: 3,
    })
    internals(s).enemyViews.forEach((v, k) => {
      const slot = L.enemies[k]
      expect(v.label!.x).toBeCloseTo(slot.label!.x - slot.x + slot.label!.w / 2)
      expect(v.label!.y).toBeCloseTo(slot.size + 2)
      expect(v.label!.visible).toBe(true)
    })
  })

  it('長い敵名は省略され、ラベル幅(=スプライト一辺)を越えない', () => {
    const s = track(
      make(
        [entity('hero')],
        [
          entity('a', { name: 'とてもとてもながいなまえのモンスターたち' }),
          entity('b'),
          entity('c'),
          entity('d'),
        ],
        sideOpts,
        360,
        640
      )
    )
    const nameLine = internals(s).enemyViews[0].label!.text.split('\n')[0]
    expect(nameLine.endsWith('…')).toBe(true)
    const L = computeSideBattleLayout({ width: 360, height: 640, partyCount: 1, enemyCount: 4 })
    expect(estimateTextWidth(nameLine, 12)).toBeLessThanOrEqual(L.enemies[0].size + 0.001)
  })

  it.each([
    ['ながいなまえのゆうしゃ', 20, true],
    ['ながいなまえのゆうしゃ', 120, false],
  ])(
    '320 幅でも status テキストは概算幅でパネル内に収まる（%s, HP %d）',
    (name, hp, hasEllipsis) => {
      const s = track(
        make([entity('hero', { name, hp, maxHp: hp })], [entity('slime')], sideOpts, 320, 568)
      )
      const L = computeSideBattleLayout({ width: 320, height: 568, partyCount: 1, enemyCount: 1 })
      const text = internals(s).statusTexts[0].text
      expect(text.endsWith(`HP ${hp}/${hp}`)).toBe(true)
      expect(text.includes('…')).toBe(hasEllipsis)
      expect(estimateTextWidth(text, 14)).toBeLessThanOrEqual(L.status.w - 24 + 0.001)
    }
  )
})

describe('BattleScreen: side の文字はみ出し対策 2 巡目 (#736)', () => {
  const sideOpts: BattleScreenOptions = { layout: 'side' }
  type CmdInternals = { commands: Array<{ text: Text }> }

  it.each([
    [320, 568],
    [360, 640],
    [320, 240],
  ])('%dx%d: コマンド文字はセル幅に余白つきで収まる', (w, h) => {
    const s = track(make([entity('hero')], [entity('slime')], sideOpts, w, h))
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: 1, enemyCount: 1 })
    const cmds = (s as unknown as CmdInternals).commands
    cmds.forEach((c, k) => {
      const font = Number(c.text.style.fontSize)
      expect(
        estimateTextWidth(c.text.text, font) + SIDE_COMMAND_TEXT_PADDING * 2
      ).toBeLessThanOrEqual(L.commandCells[k].w + 1e-9)
    })
  })

  it('コマンドのフォント縮小は他の BattleScreen（front）に漏れない', () => {
    const a = track(make([entity('hero')], [entity('slime')], sideOpts, 320, 568))
    const b = track(make([entity('hero')], [entity('slime')]))
    expect(Number((a as unknown as CmdInternals).commands[0].text.style.fontSize)).toBeLessThan(18)
    expect(Number((b as unknown as CmdInternals).commands[0].text.style.fontSize)).toBe(18)
  })

  it('敵名の省略は縁取り(両側)ぶんを引いた幅に収まる', () => {
    const s = track(
      make(
        [entity('hero')],
        [
          entity('a', { name: 'とてもとてもながいなまえのモンスターたち' }),
          entity('b'),
          entity('c'),
        ],
        sideOpts,
        360,
        640
      )
    )
    const L = computeSideBattleLayout({ width: 360, height: 640, partyCount: 1, enemyCount: 3 })
    const nameLine = internals(s).enemyViews[0].label!.text.split('\n')[0]
    expect(estimateTextWidth(nameLine, 12)).toBeLessThanOrEqual(
      L.enemies[0].label!.w - SIDE_LABEL_STROKE_WIDTH * 2 + 0.001
    )
  })
})

describe('BattleScreen: 敵ラベルの HP は数値を優先して残す (#736)', () => {
  it('640x360・敵 6 体: HP 行は「HP 」が落ちても 12/12 が見える', () => {
    const foes = Array.from({ length: 6 }, (_, k) =>
      entity(`e${k}`, { name: `てき${k}`, hp: 12, maxHp: 12 })
    )
    const s = track(make([entity('hero')], foes, { layout: 'side' }, 640, 360))
    for (const v of internals(s).enemyViews) {
      expect(v.label!.text.split('\n')[1]).toMatch(/12\/12$/)
    }
  })

  it('800x450・敵 3 体（2 列 83px）は「HP 12/12」がそのまま出る', () => {
    const foes = Array.from({ length: 3 }, (_, k) => entity(`e${k}`, { hp: 12, maxHp: 12 }))
    const s = track(make([entity('hero')], foes, { layout: 'side' }, 800, 450))
    for (const v of internals(s).enemyViews) expect(v.label!.text.split('\n')[1]).toBe('HP 12/12')
  })
})

/** Node の process の最小型（@types/node に依存しない） */
interface NodeEmitter {
  on(ev: string, fn: (...a: unknown[]) => void): void
  off(ev: string, fn: (...a: unknown[]) => void): void
}

describe('BattleScreen: acrylic (#737)', () => {
  const sideNone: BattleScreenOptions = { layout: 'side' }
  const acrylic: BattleScreenOptions = { layout: 'side', spriteStyle: 'acrylic' }
  const withSprite = (id: string): BattleEntity => entity(id, { sprite: `img/${id}.webp` })
  /** Graphics に積まれた fill 命令の色と不透明度（描画順） */
  const fillsOf = (g: Graphics): Array<{ color: number; alpha: number }> =>
    (
      g.context.instructions as unknown as Array<{
        action: string
        data: { style: { color: number; alpha: number } }
      }>
    )
      .filter((ins) => ins.action === 'fill')
      .map((ins) => ({ color: ins.data.style.color, alpha: ins.data.style.alpha }))
  const TEX_W = 100
  const TEX_H = 50
  /** 実寸を持つ本物の Texture（モックだと Sprite が EMPTY に差し替えて配置の数値を検証できない） */
  const sizedTexture = (width: number, height: number): Texture =>
    new Texture({ source: new TextureSource({ width, height }) })
  const okLoad = (): void => {
    vi.spyOn(Assets, 'load').mockResolvedValue(sizedTexture(TEX_W, TEX_H) as never)
  }
  /** 800x450・敵1・味方1 の slot 一辺 */
  const slotSize = (w = 800, h = 450, party = 1, enemies = 1): number =>
    computeSideBattleLayout({ width: w, height: h, partyCount: party, enemyCount: enemies })
      .enemies[0].size
  const defaultGeometry = (size: number) =>
    computeAcrylicGeometry(TEX_W, TEX_H, size, resolveAcrylicParams())

  describe('none（回帰）', () => {
    it('spriteStyle 未指定: acrylicBack / acrylicFilter は null・sprite.filters は空・子は fallback→sprite→label の 3 つ', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], sideNone))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).toBeNull()
      expect(v.acrylicFilter).toBeNull()
      expect(v.sprite!.filters ?? []).toHaveLength(0)
      expect(v.container.children).toHaveLength(3)
      expect(v.container.children[0]).toBe(v.fallback)
      expect(v.container.children[1]).toBe(v.sprite)
      expect(v.container.children[2]).toBe(v.label)
    })

    it('spriteStyle 未指定のスプライト配置は #736 の contain と同一', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], sideNone))
      await flushPromises()
      const sp = internals(s).enemyViews[0].sprite!
      const fit = computeContainFit(TEX_W, TEX_H, slotSize())
      expect(sp.x).toBeCloseTo(fit.x, 9)
      expect(sp.y).toBeCloseTo(fit.y, 9)
      expect(sp.width).toBeCloseTo(fit.width, 9)
      expect(sp.height).toBeCloseTo(fit.height, 9)
    })

    it("spriteStyle:'none' 明示でも画像成功後の構成は未指定と同一", async () => {
      okLoad()
      const a = track(make([entity('hero')], [withSprite('slime')], sideNone))
      const b = track(
        make([entity('hero')], [withSprite('slime')], { ...sideNone, spriteStyle: 'none' })
      )
      await flushPromises()
      const va = internals(a).enemyViews[0]
      const vb = internals(b).enemyViews[0]
      expect(vb.acrylicBack).toBeNull()
      expect(vb.acrylicFilter).toBeNull()
      expect(vb.container.children).toHaveLength(va.container.children.length)
      expect([vb.sprite!.x, vb.sprite!.y, vb.sprite!.width, vb.sprite!.height]).toEqual([
        va.sprite!.x,
        va.sprite!.y,
        va.sprite!.width,
        va.sprite!.height,
      ])
    })

    it("不正値 'ACRYLIC' は none 扱い（BattleScreen は === 'acrylic' の厳密比較。正規化は rpgProjectFromDoc の責務）", async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          layout: 'side',
          spriteStyle: 'ACRYLIC' as never,
        })
      )
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).toBeNull()
      expect(v.acrylicFilter).toBeNull()
      expect(v.container.children).toHaveLength(3)
    })
  })

  describe('acrylic: 読み込み状態', () => {
    it('sprite 未指定の entity は Assets.load を呼ばず色四角のまま・acrylicBack なし', () => {
      const load = vi.spyOn(Assets, 'load')
      const s = track(make([entity('hero')], [entity('slime')], acrylic))
      expect(load).not.toHaveBeenCalled()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).toBeNull()
      expect(v.fallback.visible).toBe(true)
      expect(internals(s).partyViews[0].acrylicBack).toBeNull()
    })

    it('保留中: acrylicBack はあるが非表示・fallback 表示・filter なし', () => {
      vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>(() => {}) as never)
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).not.toBeNull()
      expect(v.acrylicBack!.visible).toBe(false)
      expect(v.fallback.visible).toBe(true)
      expect(v.acrylicFilter).toBeNull()
      expect(v.sprite).toBeNull()
    })

    it('成功: acrylicBack 表示・filter ちょうど 1 つ・fallback 非表示・sprite.filters は [filter]', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack!.visible).toBe(true)
      expect(v.acrylicFilter).not.toBeNull()
      expect(v.fallback.visible).toBe(false)
      expect(v.sprite!.filters).toHaveLength(1)
      expect((v.sprite!.filters as unknown[])[0]).toBe(v.acrylicFilter)
    })

    it('成功: 子の順序は fallback → acrylicBack → sprite → label', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.container.children).toHaveLength(4)
      expect(v.container.children[0]).toBe(v.fallback)
      expect(v.container.children[1]).toBe(v.acrylicBack)
      expect(v.container.children[2]).toBe(v.sprite)
      expect(v.container.children[3]).toBe(v.label)
    })

    it('成功: sprite は slot 枠に収まり、足元が台座の中心に乗る（computeAcrylicGeometry と一致）', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const sp = internals(s).enemyViews[0].sprite!
      const size = slotSize()
      const g = defaultGeometry(size)
      expect(sp.x).toBeCloseTo(g.sprite.x, 9)
      expect(sp.y).toBeCloseTo(g.sprite.y, 9)
      expect(sp.width).toBeCloseTo(g.sprite.width, 9)
      expect(sp.height).toBeCloseTo(g.sprite.height, 9)
      expect(sp.x).toBeGreaterThanOrEqual(0)
      expect(sp.y).toBeGreaterThanOrEqual(0)
      expect(sp.x + sp.width).toBeLessThanOrEqual(size + 1e-9)
      expect(sp.y + sp.height).toBeCloseTo(g.base!.cy, 9)
    })

    it('成功: 台座・影が描かれる（acrylicBack の bounds が台座の幅に一致）', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const b = internals(s).enemyViews[0].acrylicBack!.getLocalBounds()
      const g = defaultGeometry(slotSize())
      // 最も広い影の楕円がバウンディングを決める
      expect(b.width).toBeCloseTo(g.shadow!.rx * 2, 6)
    })

    it('仕様値: 影は黒 0.4・台座は 0x111111・ハイライトは白 0.3 の順に塗られる（リテラル固定）', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      expect(fillsOf(internals(s).enemyViews[0].acrylicBack!)).toEqual([
        { color: 0x000000, alpha: 0.4 },
        { color: 0x111111, alpha: 1 },
        { color: 0xffffff, alpha: 0.3 },
      ])
    })

    it('spriteStyleParams の shadowAlpha / highlightAlpha が影・ハイライトの塗りに別々に反映される', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { shadowAlpha: 0.7, highlightAlpha: 0.6 },
        })
      )
      await flushPromises()
      const fills = fillsOf(internals(s).enemyViews[0].acrylicBack!)
      expect(fills[0].alpha).toBe(0.7)
      expect(fills[2].alpha).toBe(0.6)
    })

    it('失敗: 色四角のまま・acrylicBack 非表示・filter なし・warn 1 回', async () => {
      vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(warn).toHaveBeenCalledTimes(1)
      expect(v.sprite).toBeNull()
      expect(v.fallback.visible).toBe(true)
      expect(v.acrylicBack!.visible).toBe(false)
      expect(v.acrylicFilter).toBeNull()
    })

    it('味方側のスプライトにも適用される', async () => {
      okLoad()
      const s = track(make([withSprite('hero')], [entity('slime')], acrylic))
      await flushPromises()
      const v = internals(s).partyViews[0]
      expect(v.acrylicFilter).not.toBeNull()
      expect(v.acrylicBack!.visible).toBe(true)
      expect(v.sprite!.filters).toHaveLength(1)
      expect(v.container.children).toHaveLength(3) // 味方にラベルはない: fallback → back → sprite
      expect(v.container.children[2]).toBe(v.sprite)
    })

    it('複数体（敵 3・味方 2）: 各 view が独立の filter を持つ（共有しない）', async () => {
      okLoad()
      const s = track(
        make(
          [withSprite('p0'), withSprite('p1')],
          [withSprite('e0'), withSprite('e1'), withSprite('e2')],
          acrylic
        )
      )
      await flushPromises()
      const views = [...internals(s).enemyViews, ...internals(s).partyViews]
      expect(views).toHaveLength(5)
      const filters = views.map((v) => v.acrylicFilter)
      for (const f of filters) expect(f).not.toBeNull()
      expect(new Set(filters).size).toBe(5)
      for (const v of views) expect(v.sprite!.filters).toHaveLength(1)
    })

    it('成功経路で console.error / warn が呼ばれない', async () => {
      okLoad()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      track(make([withSprite('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    })
  })

  describe('acrylic: front は影響しない', () => {
    it('front + acrylic + sprite 指定は none の front と同一（子数・position・alpha）で Assets.load も呼ばれない', async () => {
      const load = vi.spyOn(Assets, 'load')
      const a = track(
        make([withSprite('hero')], [withSprite('slime')], { layout: 'front', spriteStyle: 'none' })
      )
      const b = track(
        make([withSprite('hero')], [withSprite('slime')], {
          layout: 'front',
          spriteStyle: 'acrylic',
        })
      )
      await flushPromises()
      expect(load).not.toHaveBeenCalled()
      const ca = internals(a).children
      const cb = internals(b).children
      expect(cb).toHaveLength(ca.length)
      cb.forEach((c, k) => {
        expect(c.position.x).toBe(ca[k].position.x)
        expect(c.position.y).toBe(ca[k].position.y)
        expect(c.alpha).toBe(ca[k].alpha)
      })
      expect(internals(b).enemyViews).toHaveLength(0)
    })
  })

  describe('acrylic: redraw / パラメータ', () => {
    it('redraw を複数回呼んでも filter インスタンスは同一で filters.length は 1・setWidths が新 size で呼ばれる', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const filter = v.acrylicFilter!
      const setWidths = vi.spyOn(filter, 'setWidths')
      s.redraw(400, 700)
      s.redraw(800, 450)
      s.redraw(400, 700)
      expect(v.acrylicFilter).toBe(filter)
      expect(v.sprite!.filters).toHaveLength(1)
      expect(setWidths).toHaveBeenCalledTimes(3)
      const g = defaultGeometry(slotSize(400, 700))
      expect(setWidths).toHaveBeenLastCalledWith(g.marginPx, g.linePx)
      const g2 = defaultGeometry(slotSize(800, 450))
      expect(setWidths).toHaveBeenNthCalledWith(2, g2.marginPx, g2.linePx)
    })

    it('redraw で size が 0 になると filters は null・通常に戻すと再装着される', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const filter = v.acrylicFilter!
      s.redraw(0, 0)
      expect(slotSize(0, 0)).toBeLessThanOrEqual(0)
      expect(v.sprite!.filters ?? []).toHaveLength(0)
      s.redraw(800, 450)
      expect(v.sprite!.filters).toHaveLength(1)
      expect((v.sprite!.filters as unknown[])[0]).toBe(filter)
    })

    it('spriteStyleParams.lineAlpha=0 → filters は付かない・0.01 → 付く', async () => {
      okLoad()
      const off = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { lineAlpha: 0 },
        })
      )
      const on = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { lineAlpha: 0.01 },
        })
      )
      await flushPromises()
      expect(internals(off).enemyViews[0].sprite!.filters ?? []).toHaveLength(0)
      expect(internals(on).enemyViews[0].sprite!.filters).toHaveLength(1)
    })

    it('hasBase=false → 台座・影は描かれず、足元は枠の下端から余白+線ぶん上', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { hasBase: false },
        })
      )
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const b = v.acrylicBack!.getLocalBounds()
      expect(b.width).toBe(0)
      expect(b.height).toBe(0)
      const size = slotSize()
      const g = computeAcrylicGeometry(TEX_W, TEX_H, size, resolveAcrylicParams({ hasBase: false }))
      expect(v.sprite!.y + v.sprite!.height).toBeCloseTo(size - g.marginPx - g.linePx, 9)
    })

    it('spriteStyleParams の clamp がコンストラクタで効く（marginRatio:9 は 0.15 として配置される）', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { marginRatio: 9 },
        })
      )
      await flushPromises()
      const sp = internals(s).enemyViews[0].sprite!
      const g = computeAcrylicGeometry(
        TEX_W,
        TEX_H,
        slotSize(),
        resolveAcrylicParams({ marginRatio: 0.15 })
      )
      expect(sp.x).toBeCloseTo(g.sprite.x, 9)
      expect(sp.width).toBeCloseTo(g.sprite.width, 9)
      expect(sp.width).toBeGreaterThan(0)
    })
  })

  describe('acrylic: destroy', () => {
    it('保留中の destroy は例外なし', () => {
      vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>(() => {}) as never)
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      expect(() => s.destroy({ children: true })).not.toThrow()
    })

    it('destroy 後に resolve しても例外なし・filter も sprite も作られず unhandled rejection も出ない', async () => {
      const resolvers: Array<(t: Texture) => void> = []
      vi.spyOn(Assets, 'load').mockImplementation(
        (() => new Promise<Texture>((r) => resolvers.push(r))) as never
      )
      const onRejection = vi.fn()
      const proc = (globalThis as unknown as { process: NodeEmitter }).process
      proc.on('unhandledRejection', onRejection)
      try {
        const s = make([withSprite('hero')], [withSprite('slime')], acrylic)
        const views = [...internals(s).enemyViews, ...internals(s).partyViews]
        s.destroy({ children: true })
        for (const r of resolvers) r(sizedTexture(TEX_W, TEX_H))
        await flushPromises()
        for (const v of views) {
          expect(v.sprite).toBeNull()
          expect(v.acrylicFilter).toBeNull()
        }
        expect(onRejection).not.toHaveBeenCalled()
      } finally {
        proc.off('unhandledRejection', onRejection)
      }
    })

    it('成功後の destroy で filter.destroy が 1 回呼ばれ、view の参照は null になる', async () => {
      okLoad()
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const filter = v.acrylicFilter!
      const destroy = vi.spyOn(filter, 'destroy')
      s.destroy({ children: true })
      expect(destroy).toHaveBeenCalledTimes(1)
      expect(v.acrylicFilter).toBeNull()
    })
  })
})
