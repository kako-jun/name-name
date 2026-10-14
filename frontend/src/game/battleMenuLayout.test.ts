/** 候補窓・手のカーソルの座標 (#204) の単体テスト。画面サイズ総当たりで、窓と手が画面内に収まることを見る */
import { describe, expect, it } from 'vitest'
import {
  computeSideBattleLayout,
  computeStatusColumns,
  type Rect,
  type SpriteSlot,
} from './battleLayout'
import {
  EMPTY_STACK,
  buildMenuRows,
  confirm,
  openList,
  scrollList,
  setListCursor,
  type BattleSpellEntry,
  type MenuContext,
} from './battleMenu'
import {
  HAND_BITMAP,
  HAND_HEIGHT,
  HAND_PIXEL,
  HAND_WIDTH,
  MENU_COMMAND_OVERHANG,
  MENU_MAX_ROWS,
  MENU_PADDING_Y,
  MENU_ROW_HEIGHT,
  MENU_SCROLL_STRIP,
  MENU_TOP_GAP,
  buildMenuView,
  computeListWindowRect,
  computeTargetHand,
  handCells,
  listMaxRows,
  type MenuGeometry,
} from './battleMenuLayout'
import type { BattleEntity } from './spellDsl'

const SIZES: Array<[number, number]> = [
  [360, 640],
  [320, 568],
  [800, 450],
  [1280, 720],
  [640, 360],
  [568, 320],
  [320, 240],
]
const EPS = 0.001

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return { id, name: id, hp: 10, maxHp: 10, mp: 99, maxMp: 99, atk: 1, def: 0, agi: 1, ...over }
}

function manySpells(n: number): BattleSpellEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `とてもながいなまえのじゅもん${i}`,
    mp: 1 + (i % 9),
    target: i % 2 ? '敵全体' : '味方単体',
  }))
}

function geometry(
  w: number,
  h: number,
  party: number,
  enemies: number,
  opts: { atb?: boolean; maxHp?: number } = {}
): MenuGeometry {
  const L = computeSideBattleLayout({
    width: w,
    height: h,
    partyCount: party,
    enemyCount: enemies,
    commandLayout: 'cross',
  })
  const rect = (s: SpriteSlot): Rect => ({ x: s.x, y: s.y, w: s.width, h: s.size })
  // BattleScreen.layoutSide と同じ入力で HP 列の位置を出し、窓の右端の上限にする
  const cols = computeStatusColumns({
    x: L.status.x,
    width: L.status.w,
    maxHp: opts.maxHp ?? 30,
    maxMp: 12,
    compact: L.statusCompact,
    atb: opts.atb ?? false,
  })
  return {
    width: w,
    height: h,
    avoidX: cols.hp.x - 2,
    command: L.command,
    top: L.log.y + L.log.h + MENU_TOP_GAP,
    enemySlots: L.enemies.map(rect),
    partySlots: L.party.map(rect),
  }
}

const inside = (r: Rect, w: number, h: number) =>
  r.x >= -EPS && r.y >= -EPS && r.x + r.w <= w + EPS && r.y + r.h <= h + EPS

describe('手のドット絵', () => {
  it('全行が同じ幅で、幅・高さはドットの倍数', () => {
    for (const row of HAND_BITMAP) expect(row.length).toBe(HAND_BITMAP[0].length)
    expect(HAND_WIDTH).toBe(HAND_BITMAP[0].length * HAND_PIXEL)
    expect(HAND_HEIGHT).toBe(HAND_BITMAP.length * HAND_PIXEL)
  })

  it('左向きは右向きの左右反転で、手の枠内に収まる', () => {
    const r = handCells('right')
    const l = handCells('left')
    expect(l).toHaveLength(r.length)
    const key = (c: { x: number; y: number }) => `${c.x},${c.y}`
    const mirrored = new Set(r.map((c) => key({ x: HAND_WIDTH - HAND_PIXEL - c.x, y: c.y })))
    expect(new Set(l.map(key))).toEqual(mirrored)
    for (const c of [...r, ...l]) {
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x + HAND_PIXEL).toBeLessThanOrEqual(HAND_WIDTH)
      expect(c.y + HAND_PIXEL).toBeLessThanOrEqual(HAND_HEIGHT)
    }
  })
})

describe('computeTargetHand', () => {
  const slot: Rect = { x: 100, y: 100, w: 40, h: 60 }
  it('敵は右側から左向き・味方は左側から右向き', () => {
    expect(computeTargetHand('enemy', slot, 800, 450)).toMatchObject({ facing: 'left' })
    expect(computeTargetHand('enemy', slot, 800, 450).x).toBeGreaterThanOrEqual(slot.x + slot.w)
    expect(computeTargetHand('party', slot, 800, 450)).toMatchObject({ facing: 'right' })
    expect(computeTargetHand('party', slot, 800, 450).x + HAND_WIDTH).toBeLessThanOrEqual(slot.x)
  })
  it('画面の端では画面内に収める', () => {
    const edge: Rect = { x: 0, y: 0, w: 10, h: 10 }
    const h = computeTargetHand('party', edge, 100, 100)
    expect(h.x).toBeGreaterThanOrEqual(0)
    expect(h.y).toBeGreaterThanOrEqual(0)
    const far: Rect = { x: 95, y: 95, w: 10, h: 10 }
    const e = computeTargetHand('enemy', far, 100, 100)
    expect(e.x + HAND_WIDTH).toBeLessThanOrEqual(100)
    expect(e.y + HAND_HEIGHT).toBeLessThanOrEqual(100)
  })
})

describe('画面サイズ総当たり: 一覧窓・手・当たり判定が画面内に収まる', () => {
  for (const [w, h] of SIZES) {
    for (const party of [1, 2, 3, 4]) {
      for (const enemies of [1, 3, 6]) {
        for (const n of [1, 3, 12, 40]) {
          it(`${w}x${h} 味方${party} 敵${enemies} 呪文${n}件`, () => {
            const g = geometry(w, h, party, enemies)
            const spells = manySpells(n)
            const members = Array.from({ length: party }, (_, i) => ent(`p${i}`))
            const foes = Array.from({ length: enemies }, (_, i) => ent(`e${i}`))
            const ctx: MenuContext = {
              rows: buildMenuRows('spell', spells, members[0]),
              maxRows: listMaxRows(g),
              entries: spells,
              party: members,
              enemies: foes,
              actorIndex: 0,
            }
            expect(ctx.maxRows).toBeGreaterThanOrEqual(1)
            // 先頭・末尾・途中のカーソル位置でスクロールしても収まる
            let st = openList(EMPTY_STACK, 'spell', ctx)
            for (const target of [0, Math.floor(n / 2), n - 1]) {
              st = setListCursor(st, target, ctx)
              const view = buildMenuView(st, ctx, g)
              const list = view[0]
              if (list.type !== 'list') throw new Error('list expected')
              expect(inside(list.rect, w, h)).toBe(true)
              expect(list.rect.y + list.rect.h).toBeLessThanOrEqual(
                g.command.y + g.command.h + MENU_COMMAND_OVERHANG + EPS
              )
              expect(list.rows.length).toBeGreaterThanOrEqual(1)
              expect(list.rows.length).toBeLessThanOrEqual(ctx.maxRows)
              expect(list.rows.some((r) => r.selected)).toBe(true)
              for (const r of list.rows) {
                expect(inside(r.rect, w, h)).toBe(true)
                expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(list.rect.y + list.rect.h + EPS)
              }
              expect(list.hand).not.toBeNull()
              expect(list.hand!.x).toBeGreaterThanOrEqual(list.rect.x)
              expect(list.hand!.x + HAND_WIDTH).toBeLessThanOrEqual(list.rect.x + list.rect.w + EPS)
            }
            // 対象窓: 敵全体 / 味方単体 の手と当たり判定
            for (const idx of [1, 0]) {
              let t = setListCursor(openList(EMPTY_STACK, 'spell', ctx), idx, ctx)
              t = confirm(t, ctx).stack
              const view = buildMenuView(t, ctx, g)
              // 対象選択の間は一覧を隠す（敵・味方の絵を窓が覆わない）
              expect(view.every((v) => v.type === 'target')).toBe(true)
              const tv = view[view.length - 1]
              if (tv.type !== 'target') throw new Error('target expected')
              expect(tv.hands.length).toBeGreaterThanOrEqual(1)
              for (const hand of tv.hands) {
                expect(hand.x).toBeGreaterThanOrEqual(0)
                expect(hand.y).toBeGreaterThanOrEqual(0)
                expect(hand.x + HAND_WIDTH).toBeLessThanOrEqual(w + EPS)
                expect(hand.y + HAND_HEIGHT).toBeLessThanOrEqual(h + EPS)
              }
            }
          })
        }
      }
    }
  }
})

describe('computeListWindowRect', () => {
  it('行数が少なければ行数ぶんの高さ、多ければ上限で止まる', () => {
    const g = geometry(800, 450, 4, 3)
    const rows = buildMenuRows('spell', manySpells(2), ent('a'))
    const small = computeListWindowRect(g, rows)
    expect(small.visibleRows).toBe(2)
    expect(small.rect.h).toBe(
      Math.max(2 * MENU_ROW_HEIGHT + 2 * MENU_PADDING_Y, g.command.h + 2 * MENU_COMMAND_OVERHANG)
    )
    const big = computeListWindowRect(g, buildMenuRows('spell', manySpells(99), ent('a')))
    expect(big.visibleRows).toBe(listMaxRows(g))
  })

  it('スクロールの有無を moreAbove / moreBelow で示す', () => {
    const g = geometry(640, 360, 4, 3)
    const spells = manySpells(30)
    const members = [ent('a')]
    const ctx: MenuContext = {
      rows: buildMenuRows('spell', spells, members[0]),
      maxRows: listMaxRows(g),
      entries: spells,
      party: members,
      enemies: [ent('e')],
      actorIndex: 0,
    }
    let st = openList(EMPTY_STACK, 'spell', ctx)
    let v = buildMenuView(st, ctx, g)[0]
    if (v.type !== 'list') throw new Error()
    expect([v.moreAbove, v.moreBelow]).toEqual([false, true])
    st = setListCursor(st, 29, ctx)
    v = buildMenuView(st, ctx, g)[0]
    if (v.type !== 'list') throw new Error()
    expect([v.moreAbove, v.moreBelow]).toEqual([true, false])
  })
})

describe('スクロール帯（タップ）', () => {
  it('320x240 でも、帯のスクロールだけで 40 件すべてに届く', () => {
    const g = geometry(320, 240, 4, 3)
    const spells = manySpells(40)
    const members = [ent('a')]
    const ctx: MenuContext = {
      rows: buildMenuRows('spell', spells, members[0]),
      maxRows: listMaxRows(g),
      entries: spells,
      party: members,
      enemies: [ent('e')],
      actorIndex: 0,
    }
    let st = openList(EMPTY_STACK, 'spell', ctx)
    const reached = new Set<number>()
    for (let i = 0; i < 60; i++) {
      const v = buildMenuView(st, ctx, g)[0]
      if (v.type !== 'list') throw new Error()
      for (const r of v.rows) reached.add(r.index)
      if (v.scrollDown) {
        expect(inside(v.scrollDown, 320, 240)).toBe(true)
        st = scrollList(st, 1, ctx)
      } else break
    }
    expect(reached.size).toBe(40)
    const top = buildMenuView(st, ctx, g)[0]
    if (top.type !== 'list') throw new Error()
    expect(top.scrollUp).not.toBeNull()
    expect(top.scrollDown).toBeNull()
  })

  it('先頭では上、末尾では下の帯が無い', () => {
    const g = geometry(640, 360, 2, 2)
    const ctx: MenuContext = {
      rows: buildMenuRows('spell', manySpells(30), ent('a')),
      maxRows: listMaxRows(g),
      entries: manySpells(30),
      party: [ent('a')],
      enemies: [ent('e')],
      actorIndex: 0,
    }
    const v = buildMenuView(openList(EMPTY_STACK, 'spell', ctx), ctx, g)[0]
    if (v.type !== 'list') throw new Error()
    expect([v.scrollUp, v.scrollDown !== null]).toEqual([null, true])
  })
})

describe('窓の寸法の取り決め (#204 レビュー)', () => {
  it('スクロール帯は上下の余白に収まり、行の決定領域に食い込まない', () => {
    expect(MENU_SCROLL_STRIP).toBeLessThanOrEqual(MENU_PADDING_Y)
    const g = geometry(640, 360, 2, 2)
    const spells = manySpells(30)
    const ctx: MenuContext = {
      rows: buildMenuRows('spell', spells, ent('a')),
      maxRows: listMaxRows(g),
      entries: spells,
      party: [ent('a')],
      enemies: [ent('e')],
      actorIndex: 0,
    }
    const st = setListCursor(openList(EMPTY_STACK, 'spell', ctx), 10, ctx)
    const v = buildMenuView(st, ctx, g)[0]
    if (v.type !== 'list') throw new Error()
    const first = v.rows[0].rect
    const last = v.rows[v.rows.length - 1].rect
    expect(v.scrollUp!.y + v.scrollUp!.h).toBeLessThanOrEqual(first.y)
    expect(v.scrollDown!.y).toBeGreaterThanOrEqual(last.y + last.h)
  })

  it('一覧窓はコマンド窓より狭くならず（文字がはみ出して見えない）・画面内に収まり、見える行は MENU_MAX_ROWS まで', () => {
    for (const [w, h] of SIZES) {
      const g = geometry(w, h, 4, 3)
      const r = computeListWindowRect(g, buildMenuRows('spell', manySpells(2), ent('a')))
      expect(r.rect.w).toBeGreaterThanOrEqual(g.command.w - EPS)
      expect(inside(r.rect, w, h)).toBe(true)
      expect(listMaxRows(g)).toBeLessThanOrEqual(MENU_MAX_ROWS)
    }
  })
})

describe('名前の読みやすさ（画面サイズ総当たり）', () => {
  const NAMES = [
    ['ほのお', 3],
    ['いなずま', 6],
    ['ヒール', 2],
    ['ヒーリング', 8],
    ['ちゆのいのり', 4],
    ['メテオ', 20],
    ['ブリザドラ', 12], // 消費が 2 桁
    ['はいぽーしょん', 5],
    ['えりくさー', 7],
    ['しらさぎのおまもり', 9], // 9 文字は 6 文字 + …
    ['ちゆのいのりよ', 123], // 消費が 3 桁
  ] as const

  for (const [w, h] of SIZES) {
    it(`${w}x${h}: 名前は 7 文字以下なら全部、それより長くても 6 文字見え、互いに区別できる`, () => {
      const g = geometry(w, h, 4, 3)
      const spells: BattleSpellEntry[] = NAMES.map(([name, mp], i) => ({
        id: `n${i}`,
        name,
        mp,
        target: '敵単体',
      }))
      const members = [ent('a')]
      const ctx: MenuContext = {
        rows: buildMenuRows('spell', spells, members[0]),
        maxRows: listMaxRows(g),
        entries: spells,
        party: members,
        enemies: [ent('e')],
        actorIndex: 0,
      }
      // 行数が窓に収まらないぶんはスクロールで見えるので、先頭を動かしながら全行を集める
      const seen = new Map<number, string>()
      let st = openList(EMPTY_STACK, 'spell', ctx)
      for (let i = 0; i < NAMES.length; i++) {
        const v = buildMenuView(st, ctx, g)[0]
        if (v.type !== 'list') throw new Error()
        for (const r of v.rows) seen.set(r.index, r.label)
        st = scrollList(st, 1, ctx)
      }
      expect(seen.size).toBe(NAMES.length)
      const labels = [...seen.entries()].sort((x, y) => x[0] - y[0]).map(([, l]) => l)
      NAMES.forEach(([name], i) => {
        const shown = labels[i].replace('…', '')
        expect(shown.length).toBeGreaterThanOrEqual(Math.min(name.length, 6))
        if (name.length <= 7) expect(labels[i]).toBe(name) // 7 文字以下は省略されない
        expect(name.startsWith(shown)).toBe(true)
      })
      expect(new Set(labels).size).toBe(NAMES.length)
    })
  }
})

describe('コマンド窓を覆う高さ', () => {
  it('行が 1 行でも、窓はコマンド窓全体を覆う（コマンドの文字が窓の上に顔を出さない）', () => {
    for (const [w, h] of SIZES) {
      const g = geometry(w, h, 4, 3)
      for (const n of [1, 3]) {
        const r = computeListWindowRect(g, buildMenuRows('item', manySpells(n), ent('a'))).rect
        // コマンド窓の外形（枠線ぶんまで）を上下左右とも覆う
        expect(r.y).toBeLessThanOrEqual(g.command.y - MENU_COMMAND_OVERHANG + EPS)
        expect(r.y + r.h).toBeGreaterThanOrEqual(
          g.command.y + g.command.h + MENU_COMMAND_OVERHANG - EPS
        )
        expect(r.x).toBeLessThanOrEqual(g.command.x - MENU_COMMAND_OVERHANG + EPS)
        expect(r.x + r.w).toBeGreaterThanOrEqual(
          g.command.x + g.command.w + MENU_COMMAND_OVERHANG - EPS
        )
        expect(inside(r, w, h)).toBe(true)
      }
    }
  })
})

describe('窓の右端が味方ステータス欄の HP 列の途中で終わらない', () => {
  for (const [w, h] of SIZES) {
    for (const party of [1, 2, 3, 4]) {
      it(`${w}x${h} 味方${party}: 窓の右端は HP 列の左（消費 1〜3 桁・ATB・最大 HP）`, () => {
        for (const [atb, maxHp, mp] of [
          [false, 30, 3],
          [true, 30, 20],
          [false, 999, 123],
          [true, 999, 20],
          [true, 9999, 123],
          [false, 9999, 3],
        ] as const) {
          const g = geometry(w, h, party, 3, { atb, maxHp })
          const rows = buildMenuRows(
            'spell',
            [{ id: 'a', name: 'はいぽーしょん', mp, target: '敵単体' }],
            ent('a')
          )
          const r = computeListWindowRect(g, rows).rect
          // コマンド窓の外形ぶんは下限として必ず覆う。それを超えて広げるのは HP 列の左まで
          const floor = g.command.x + g.command.w + MENU_COMMAND_OVERHANG
          expect(r.x + r.w).toBeLessThanOrEqual(Math.max(g.avoidX!, floor) + EPS)
          expect(floor).toBeLessThanOrEqual(g.avoidX! + EPS) // 下限そのものが HP 列にかからない
        }
      })
    }
  }
})

describe('消費が 2 桁でも 7 文字の名前は省略されない（浮動小数の誤差）', () => {
  for (const [w, h] of SIZES) {
    for (const party of [1, 2, 3, 4]) {
      it(`${w}x${h} 味方${party}`, () => {
        const g = geometry(w, h, party, 3)
        const names = ['ちゆのいのりだ', 'はいぽーしょん', 'ひーりんぐおん']
        const spells: BattleSpellEntry[] = names.map((name, i) => ({
          id: `n${i}`,
          name,
          mp: [10, 20, 99][i],
          target: '敵単体',
        }))
        const members = [ent('a')]
        const ctx: MenuContext = {
          rows: buildMenuRows('spell', spells, members[0]),
          maxRows: listMaxRows(g),
          entries: spells,
          party: members,
          enemies: [ent('e')],
          actorIndex: 0,
        }
        const v = buildMenuView(openList(EMPTY_STACK, 'spell', ctx), ctx, g)[0]
        if (v.type !== 'list') throw new Error()
        for (const r of v.rows) expect(r.label).toBe(names[r.index])
      })
    }
  }
})
