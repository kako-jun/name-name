/**
 * BattleScreen の battle_text_overflow (#1183): 入り切らない文字を省略(ellipsis)するか、窓の幅でクリップして横スクロール(scroll)するか。
 * 既定(ellipsis)は従来の見た目と完全に同じ。時計は tick の引数で注入する（ヘッドレスで再現できる）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import 'pixi.js/events'
import type { Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { skipEntrance } from './battleScreenTestUtil'
import { BattleEngine } from './battleEngine'
import type { BattleMenuData } from './battleMenu'
import { DEFAULT_MOTION_TIMING, SNAPPY_MOTION_TIMING } from './battleMotion'
import {
  MARQUEE_TARGETS,
  marqueeAppliesTo,
  marqueeOverflowPx,
  sampleMarquee,
} from './battleMarquee'
import { estimateTextWidth } from './battleLayout'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    atk: 0,
    def: 0,
    agi: 5,
    ...over,
  }
}

const LONG_SPELL = 'とてもながいなまえのじゅもんです'
const LONG_ENEMY = 'とてもとてもながいなまえのおおきなモンスター'
const MENU: BattleMenuData = {
  spells: {
    a: [
      { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' },
      { id: 'long', name: LONG_SPELL, mp: 12, target: '敵単体', effect: 'damage 8..14' },
    ],
  },
  items: [],
}

interface MenuLayerInternals {
  marquees: Array<{ key: string; text: Text; left: number; overflow: number }>
  body: { children: unknown[] }
}
interface Internals {
  menuLayer: MenuLayerInternals | null
  enemyListTexts: Text[]
  statusTexts: Text[]
  marquees: Map<Text, { mask: unknown; overflow: number; left: number }>
  textOverflow: 'ellipsis' | 'scroll'
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(
  opts: BattleScreenOptions = {},
  party = [ent('a')],
  enemies = [ent('e')],
  width = 800
) {
  const engine = new BattleEngine(party, enemies, { rng: () => 0 })
  const s = skipEntrance(
    new BattleScreen(engine, width, 450, {
      layout: 'side',
      presentation: 'ff',
      commandLayout: 'cross',
      menu: structuredClone(MENU),
      ...opts,
    })
  )
  created.push(s)
  return s
}
function press(key: string): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
  document.body.innerHTML = ''
})

/** 候補窓(じゅもん)を開いて、長い名前の行を返す */
function openSpellList(s: BattleScreen) {
  press('ArrowLeft')
  const layer = I(s).menuLayer!
  const row = layer.marquees.find((m) => m.text.text === LONG_SPELL)
  return { layer, row }
}

describe('候補窓の名前 (#1183)', () => {
  it('既定(ellipsis): 従来どおり「…」で省略され、スクロールもマスクもない', () => {
    const s = build()
    press('ArrowLeft')
    const layer = I(s).menuLayer!
    expect(layer.marquees).toEqual([])
    const texts = collectTexts(layer.body as never)
    expect(texts.some((t) => t === LONG_SPELL)).toBe(false)
    expect(texts.some((t) => t.endsWith('…') && LONG_SPELL.startsWith(t.slice(0, -1)))).toBe(true)
    s.tick(5000)
    expect(layer.marquees).toEqual([])
  })

  it('明示の ellipsis も既定と同じ', () => {
    const s = build({ textOverflow: 'ellipsis' })
    press('ArrowLeft')
    expect(I(s).menuLayer!.marquees).toEqual([])
  })

  it('scroll: 全文のまま名前の領域でクリップされ、先頭で止まってから左へゆっくり流れる', () => {
    const s = build({ textOverflow: 'scroll' })
    const { row } = openSpellList(s)
    expect(row).toBeDefined()
    expect(row!.text.mask).not.toBeNull()
    // 短い名前は動かさない・マスクもない
    const short = collectTexts(I(s).menuLayer!.body as never).filter((t) => t === 'ほのお')
    expect(short).toHaveLength(1)
    const t = DEFAULT_MOTION_TIMING
    const timing = {
      speed: t.marqueeSpeed,
      startHoldMs: t.marqueeStartHoldMs,
      endHoldMs: t.marqueeEndHoldMs,
    }
    // 先頭の停止の間は動かない
    s.tick(timing.startHoldMs - 1)
    expect(row!.text.x).toBe(row!.left)
    // 停止を過ぎると速度(px/秒)どおりに左へ流れる
    s.tick(1 + 1000)
    expect(row!.text.x).toBeCloseTo(
      row!.left - sampleMarquee(timing.startHoldMs + 1000, row!.overflow, timing),
      6
    )
    expect(row!.text.x).toBeLessThan(row!.left)
    expect(row!.left - row!.text.x).toBeCloseTo(timing.speed, 3)
    // 末尾まで流れ切ると全文が見える位置で止まる
    s.tick((row!.overflow / timing.speed) * 1000 - 1000 + 100)
    expect(row!.left - row!.text.x).toBeCloseTo(row!.overflow, 3)
    // 末尾で少し止まったあと、先頭（最初の文字が見える位置）へ切り替わる
    s.tick(timing.endHoldMs - 200)
    expect(row!.left - row!.text.x).toBeCloseTo(row!.overflow, 3)
    s.tick(200)
    expect(row!.text.x).toBe(row!.left)
  })

  it('カーソルを動かして窓を描き直しても、流れは先頭に戻らない', () => {
    const s = build({ textOverflow: 'scroll' })
    const { row } = openSpellList(s)
    expect(row).toBeDefined()
    s.tick(2500)
    const before = row!.left - row!.text.x
    expect(before).toBeGreaterThan(0)
    press('ArrowUp')
    const again = I(s).menuLayer!.marquees.find((m) => m.text.text === LONG_SPELL)!
    expect(again.left - again.text.x).toBeCloseTo(before, 6)
  })

  it('motion preset: snappy は default より速く流れる', () => {
    const run = (motion: 'default' | 'snappy') => {
      const s = build({ textOverflow: 'scroll', motion })
      if (motion === 'snappy') {
        s.tick(1500)
        s.tick(200)
      }
      const { row } = openSpellList(s)
      s.tick(3000)
      return row!.left - row!.text.x
    }
    expect(SNAPPY_MOTION_TIMING.marqueeSpeed).toBeGreaterThan(DEFAULT_MOTION_TIMING.marqueeSpeed)
    expect(run('snappy')).toBeGreaterThan(run('default'))
  })

  it('同じ入力なら同じ位置（時刻の注入で再現できる）', () => {
    const at = () => {
      const s = build({ textOverflow: 'scroll' })
      const { row } = openSpellList(s)
      for (let i = 0; i < 30; i++) s.tick(100)
      return row!.text.x
    }
    expect(at()).toBe(at())
  })

  it('reduced-motion のときは scroll でも省略に倒れる', () => {
    const s = build({ textOverflow: 'scroll', reducedMotion: true })
    expect(I(s).textOverflow).toBe('ellipsis')
    press('ArrowLeft')
    expect(I(s).menuLayer!.marquees).toEqual([])
  })
})

describe('敵名窓 (#1183)', () => {
  const longEnemy = () => [ent('e1', { name: LONG_ENEMY })]
  it('既定: 「…」で省略。scroll: 全文で、窓の幅でクリップされて流れる', () => {
    const d = build({ enemyList: 'window' }, [ent('a')], longEnemy())
    const dt = I(d)
      .enemyListTexts.filter((t) => t.visible)
      .map((t) => t.text)
    expect(dt[0].endsWith('…')).toBe(true)
    expect(I(d).marquees.size).toBe(0)

    const s = build({ enemyList: 'window', textOverflow: 'scroll' }, [ent('a')], longEnemy())
    const t = I(s).enemyListTexts.find((x) => x.visible)!
    expect(t.text).toBe(LONG_ENEMY)
    const m = I(s).marquees.get(t)!
    expect(m).toBeDefined()
    expect(t.mask).not.toBeNull()
    expect(m.overflow).toBeGreaterThan(0)
    const x0 = t.x
    s.tick(DEFAULT_MOTION_TIMING.marqueeStartHoldMs - 1)
    expect(t.x).toBe(x0)
    s.tick(1 + 1500)
    expect(t.x).toBeLessThan(x0)
  })

  it('入り切る名前はスクロールしない（マスクも付けない）', () => {
    const s = build(
      { enemyList: 'window', textOverflow: 'scroll' },
      [ent('a')],
      [ent('e', { name: 'スライム' })]
    )
    expect(I(s).marquees.size).toBe(0)
  })

  it('状態タグ付きの行も全文（[どく] 名前）で流れる', () => {
    const s = build({ enemyList: 'window', textOverflow: 'scroll' }, [ent('a')], longEnemy())
    // 長い名前の行は先頭が名前。状態の前置きがあっても enemyListRowText の全文になる
    expect(I(s).enemyListTexts.find((x) => x.visible)!.text).not.toContain('…')
  })
})

describe('対象外の窓（ステータス窓の味方名・メッセージ窓）は scroll でも省略のまま (#1183)', () => {
  it('狭い画面で入り切らない味方名は、既定でも scroll でも同じ「…」の省略で、スクロールもマスクもしない', () => {
    const name = 'ものすごくながいなまえのゆうしゃ'
    const d = build({}, [ent('a', { name })], [ent('e')], 300)
    const s = build({ textOverflow: 'scroll' }, [ent('a', { name })], [ent('e')], 300)
    expect(I(d).statusTexts[0].text.endsWith('…')).toBe(true)
    expect(I(s).statusTexts[0].text).toBe(I(d).statusTexts[0].text)
    expect(I(s).statusTexts[0].mask).toBeFalsy()
    expect(I(s).marquees.has(I(s).statusTexts[0])).toBe(false)
    s.tick(10000)
    expect(I(s).statusTexts[0].x).toBe(I(d).statusTexts[0].x)
  })
})

describe('スクロールの対象は MARQUEE_TARGETS の1箇所で決まる (#1183)', () => {
  it('下のウィンドウの名前（候補窓・敵名窓）だけ。ステータス窓・メッセージ窓は含まない', () => {
    expect([...MARQUEE_TARGETS]).toEqual(['menu', 'enemyList'])
    expect(marqueeAppliesTo('scroll', 'menu')).toBe(true)
    expect(marqueeAppliesTo('scroll', 'enemyList')).toBe(true)
    expect(marqueeAppliesTo('scroll', 'status')).toBe(false)
    expect(marqueeAppliesTo('scroll', 'message')).toBe(false)
    expect(marqueeAppliesTo('ellipsis', 'menu')).toBe(false)
  })
})

describe('既定(ellipsis)は main と同じ見た目 (#1183)', () => {
  it('未指定と ellipsis は、全 Text の文字列・位置が一致する（長い名前の入った構成）', () => {
    const snap = (opts: BattleScreenOptions) => {
      const s = build(
        { enemyList: 'window', ...opts },
        [ent('a', { name: 'ものすごくながいなまえのゆうしゃ' })],
        [ent('e1', { name: LONG_ENEMY })]
      )
      press('ArrowLeft')
      s.tick(3000)
      const texts: Text[] = [...I(s).enemyListTexts, ...I(s).statusTexts]
      return texts.map((t) => [t.text, t.x, t.y, t.visible])
    }
    expect(snap({ textOverflow: 'ellipsis' })).toEqual(snap({}))
  })
})

describe('幅の判定は概算幅と同じ基準 (#1183)', () => {
  it('estimateTextWidth が窓の幅を越えるときだけ overflow が付く', () => {
    expect(marqueeOverflowPx(estimateTextWidth('ほのお', 16), 200)).toBe(0)
    expect(marqueeOverflowPx(estimateTextWidth(LONG_SPELL, 16), 100)).toBeGreaterThan(0)
  })
})

/** 画面の木を辿って Text の文字列を集める */
function collectTexts(root: { children?: unknown[]; text?: unknown }): string[] {
  const out: string[] = []
  const walk = (n: { children?: unknown[]; text?: unknown }) => {
    if (typeof n.text === 'string') out.push(n.text)
    for (const c of n.children ?? []) walk(c as never)
  }
  walk(root)
  return out
}
