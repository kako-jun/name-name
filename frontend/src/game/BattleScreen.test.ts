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
  type Text,
  type Texture,
} from 'pixi.js'
import { BattleScreen, SIDE_LABEL_STROKE_WIDTH, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  SIDE_COMMAND_TEXT_PADDING,
  SIDE_LOG_MIN_LINES,
  SIDE_STATUS_COMPACT_WIDTH,
  computeSideBattleLayout,
  estimateTextWidth,
} from './battleLayout'

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
      L.enemies[0].size - SIDE_LABEL_STROKE_WIDTH * 2 + 0.001
    )
  })
})
