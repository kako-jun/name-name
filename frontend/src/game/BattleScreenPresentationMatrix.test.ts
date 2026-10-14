/**
 * BattleScreen の演出 (#745) の組み合わせ・状態遷移テスト。
 * BattleScreenPresentation.test.ts が代表の golden path を見るのに対し、
 * presentation x layout x ATB x 行動種別 x 結果 x HP0 の組み合わせと、destroy・二重 onClose・入力無視を見る。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  MOTION_EXTENT_PAD,
  MOTION_SCREEN_MARGIN,
  POPUP_TOTAL_MS,
  buildActionTimeline,
  eventTimeline,
} from './battleMotion'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 30,
    maxHp: 30,
    mp: 9,
    maxMp: 9,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  commands: { id: string; hit: Container }[]
  enemyViews: { container: Container; baseX: number; baseY: number }[]
  partyViews: { container: Container; baseX: number; baseY: number }[]
  popups: { text: Text }[]
  messageText: Text | null
  logPanel: Container
  playback: { queue: unknown[]; active: unknown }
  statusTexts: Text[]
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function make(engine: BattleEngine, opts: BattleScreenOptions = {}) {
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  return s
}
function setup(
  opts: BattleScreenOptions = {},
  party: Partial<BattleEntity> = {},
  enemy: Partial<BattleEntity> = {},
  rng = () => 0.5
) {
  const engine = new BattleEngine(
    [entity('hero', party)],
    [entity('slime', { atk: 1, ...enemy })],
    { rng }
  )
  return { engine, s: make(engine, opts) }
}
const tap = (s: BattleScreen, id: string) =>
  I(s)
    .commands.find((c) => c.id === id)!
    .hit.emit('pointertap', {} as never)
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
}
const FIRE = { name: 'ファイア', mp: 1, target: '敵単体', effect: 'damage 5..5' }
// 呪文・アイテムは UI から選べない（#175）ので、エンジンを直接操作して画面を描き直す
const cast = (s: BattleScreen, engine: BattleEngine, spell = FIRE) => {
  engine.selectSpell(spell)
  s.redraw(800, 450)
}

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

/*
 * デシジョンテーブル（描画に効く条件）
 *  presentation  layout  ATB   行動      結果        HP0   → 期待
 *  dq            side    off   attack    damage      no    → 演出部品なし・入力はすぐ通る
 *  ff            front   off   attack    damage      no    → dq 扱い（演出部品なし）
 *  ff            side    off   attack    damage      no    → 演出 / 窓なし / 数字 / 入力待ち
 *  ff            side    off   attack    damage      yes   → 倒れ切るまで onClose を待つ
 *  ff            side    off   spell     damage      no    → 窓に名前 / 数字
 *  ff            side    off   spell     heal        no    → 窓に名前 / 数字（回復）
 *  ff            side    off   spell     miss        no    → 窓に名前 / MISS
 *  ff            side    on    attack    damage      no    → 演出中は ATB 時間停止
 *  ff            side    off   escape    -           -     → 演出なしで即 onClose
 */

describe('デシジョンテーブル: presentation x layout', () => {
  it('dq + front / ff + front / dq + side はすべて入力が演出に塞がれない', () => {
    for (const opts of [
      { presentation: 'dq' as const, layout: 'side' as const },
      { presentation: 'ff' as const, layout: 'front' as const },
      { presentation: 'dq' as const, layout: 'front' as const },
    ]) {
      const { s, engine } = setup(opts)
      tap(s, 'attack')
      const t1 = engine.getState().eventTotal
      tap(s, 'attack')
      expect(engine.getState().eventTotal).toBeGreaterThan(t1)
      expect(I(s).playback.queue).toHaveLength(0)
    }
  })

  it('ff + side: 演出が終われば次のコマンドを受け付ける', () => {
    const { s, engine } = setup()
    tap(s, 'attack')
    run(s, 5000)
    const t1 = engine.getState().eventTotal
    tap(s, 'attack')
    expect(engine.getState().eventTotal).toBeGreaterThan(t1)
  })
})

describe('行動種別 x 結果', () => {
  it('呪文 damage: 数字は敵の HP 減少量、窓に名前', () => {
    const { s, engine } = setup()
    cast(s, engine)
    run(s, buildActionTimeline('spell', { damages: true }).hitAt + 16)
    expect(I(s).messageText!.text).toBe('ファイア')
    expect(I(s).popups.map((p) => p.text.text)).toContain('5')
  })

  it('呪文 heal: 回復量が出る', () => {
    const { s, engine } = setup({}, { hp: 10 })
    cast(s, engine, { name: 'ケアル', mp: 1, target: '味方単体', effect: 'heal 6..6' })
    run(s, buildActionTimeline('spell').hitAt + 16)
    expect(I(s).popups.map((p) => p.text.text)).toEqual(['6'])
  })

  it('呪文 miss（耐性 0 の無効）: MISS が出る。計算上のダメージ 0 は 0 が出る', () => {
    const { s, engine } = setup({}, {}, { resist: { fire: 0 } })
    cast(s, engine, { name: 'ミス', mp: 1, target: '敵単体', effect: 'damage 5..5 type=fire' })
    run(s, buildActionTimeline('spell').hitAt + 16)
    expect(I(s).popups.map((p) => p.text.text)).toEqual(['MISS'])
    const z = setup()
    cast(z.s, z.engine, { name: 'ゼロ', mp: 1, target: '敵単体', effect: 'damage 0..0' })
    run(z.s, buildActionTimeline('spell').hitAt + 16)
    expect(I(z.s).popups.map((p) => p.text.text)).toEqual(['0'])
  })

  it('S1: とどめの演出中は、生き残りの味方が先に victory ポーズにならない', () => {
    const engine = new BattleEngine(
      [entity('a'), entity('b')],
      [entity('slime', { hp: 1, maxHp: 1, atk: 1 })],
      { rng: () => 0.5 }
    )
    const s = make(engine)
    tap(s, 'attack')
    expect(engine.getState().phase).toBe('victory')
    run(s, 100)
    // 演出が続いている間は idle 系。victory は再生が空になってから
    const sample = s as unknown as { sampleEntity(side: string, i: number): { pose: string } }
    expect(sample.sampleEntity('party', 1).pose).not.toBe('victory')
    run(s, 5000)
  })

  it('S3: 逃走失敗の「にげられない！」は窓に出る。MP 不足の言葉も出る', () => {
    const { s } = setup({}, {}, {}, () => 0.9)
    tap(s, 'escape')
    run(s, 16)
    expect(I(s).messageText!.text).toBe('にげられない！')
    expect(I(s).messageText!.visible).toBe(true)
    run(s, 8000)
    const m = setup({}, { mp: 0 })
    m.engine.selectSpell({ name: 'ファイア', mp: 5, target: '敵単体', effect: 'damage 5..5' })
    m.s.redraw(800, 450)
    run(m.s, 16)
    expect(I(m.s).messageText!.text).toBe('MPが たりない！')
  })

  it('アイテム: 窓に名前、数字が出る', () => {
    const { s, engine } = setup({}, { hp: 10 })
    engine.selectItem({ name: 'やくそう', effect: 'heal 4..4' })
    s.redraw(800, 450)
    run(s, 16)
    expect(I(s).messageText!.text).toBe('やくそう')
    run(s, buildActionTimeline('item').hitAt)
    expect(I(s).popups.map((p) => p.text.text)).toContain('4')
  })

  it('全体呪文: 対象の数だけ数字が同時に出る', () => {
    const engine = new BattleEngine(
      [entity('hero')],
      [entity('a', { atk: 1 }), entity('b', { atk: 1 }), entity('c', { atk: 1 })],
      { rng: () => 0.5 }
    )
    const s = make(engine)
    cast(s, engine, { name: 'ブリザガ', mp: 1, target: '敵全体', effect: 'damage 3..3' })
    run(s, buildActionTimeline('spell', { damages: true }).hitAt + 16)
    expect(I(s).popups).toHaveLength(3)
  })

  it('通常攻撃では窓の文字が出ない（label が無い）', () => {
    const { s } = setup()
    tap(s, 'attack')
    run(s, 100)
    expect(I(s).messageText!.visible).toBe(false)
  })
})

describe('HP0・決着・onClose', () => {
  it('敵が倒れる: 倒れ切った後は薄く（沈み切って）残り、onClose は victory を 1 回だけ', () => {
    const closed: string[] = []
    const { s } = setup({ onClose: (o) => closed.push(o) }, {}, { hp: 1, maxHp: 1 })
    tap(s, 'attack')
    run(s, 10000)
    expect(closed).toEqual(['victory'])
    expect(I(s).enemyViews[0].container.alpha).toBeLessThan(1)
    // 閉じた後に tick/redraw しても二重に呼ばれない
    run(s, 5000)
    s.redraw(800, 450)
    expect(closed).toEqual(['victory'])
  })

  it('命中前に決着していても onClose はまだ呼ばれない', () => {
    const closed: string[] = []
    const { s, engine } = setup({ onClose: (o) => closed.push(o) }, {}, { hp: 1, maxHp: 1 })
    tap(s, 'attack')
    expect(engine.isOver()).toBe(true)
    expect(closed).toEqual([])
    run(s, buildActionTimeline('attack').hitAt - 20)
    expect(closed).toEqual([])
  })

  it('味方が倒れる: defeat を演出の後に 1 回', () => {
    const closed: string[] = []
    const { s } = setup(
      { onClose: (o) => closed.push(o) },
      { hp: 1, maxHp: 1 },
      { hp: 999, maxHp: 999, atk: 50 }
    )
    tap(s, 'attack')
    expect(closed).toEqual([])
    run(s, 10000)
    expect(closed).toEqual(['defeat'])
  })

  it('逃走成功は演出なしで即 escaped', () => {
    const closed: string[] = []
    const { s } = setup({ onClose: (o) => closed.push(o) }, {}, {}, () => 0)
    tap(s, 'escape')
    expect(I(s).playback.queue).toHaveLength(0)
    expect(closed).toEqual(['escaped'])
  })

  it('決着後に閉じるまでの間、追加のコマンドは無視される', () => {
    const { s, engine } = setup({}, {}, { hp: 1, maxHp: 1 })
    tap(s, 'attack')
    const total = engine.getState().eventTotal
    tap(s, 'attack')
    tap(s, 'escape')
    expect(engine.getState().eventTotal).toBe(total)
  })

  it('閉じたあとの tick は何も起こさない（例外を出さない）', () => {
    const { s } = setup({}, {}, { hp: 1, maxHp: 1 })
    tap(s, 'attack')
    run(s, 10000)
    expect(() => s.tick(16)).not.toThrow()
  })
})

describe('destroy・作り直し（GameState に演出の中間状態を持たない）', () => {
  it('演出中に destroy → tick しても例外を出さない', () => {
    const { s } = setup()
    tap(s, 'attack')
    run(s, 100)
    s.destroy({ children: true })
    expect(() => s.tick(16)).not.toThrow()
  })

  it('演出中に作り直した画面は、過去の行動を再生せず確定した HP から始まる', () => {
    const { s, engine } = setup()
    tap(s, 'attack')
    run(s, 50)
    const s2 = make(engine)
    expect(I(s2).playback.queue).toHaveLength(0)
    expect(I(s2).playback.active).toBeNull()
    expect(I(s2).popups).toHaveLength(0)
    run(s2, 5000)
    expect(I(s2).popups).toHaveLength(0)
    // 確定値（味方の反撃 HP 反映済み）が出ている
    const hp = engine.getState().party[0].hp
    expect(I(s2).statusTexts.some((t) => t.text.includes(String(hp)))).toBe(true)
  })

  it('作り直した画面でも、その後の新しい行動は演出される', () => {
    const { s, engine } = setup()
    tap(s, 'attack')
    const s2 = make(engine)
    run(s2, 5000)
    tap(s2, 'attack')
    expect(I(s2).playback.queue.length + (I(s2).playback.active ? 1 : 0)).toBeGreaterThan(0)
    void s
  })
})

describe('ATB x ff（race）', () => {
  function atbSetup(mode: 'wait' | 'active') {
    const engine = new BattleEngine(
      [entity('hero', { agi: 25 })],
      [entity('slime', { agi: 1, atk: 1 })],
      {
        rng: () => 0.5,
        atb: { mode, initialGauges: { party: [1000] } },
      }
    )
    return { engine, s: make(engine) }
  }

  it.each(['wait', 'active'] as const)('%s: 演出中もゲージは進む（本家 FF5/6 と同じ）', (mode) => {
    const { s, engine } = atbSetup(mode)
    tap(s, 'attack')
    expect(I(s).playback.active ?? I(s).playback.queue.length).toBeTruthy()
    const before = [...engine.getState().atb!.enemyGauge]
    run(s, 160)
    // 演出はまだ続いている
    expect(I(s).playback.active).not.toBeNull()
    expect(engine.getState().atb!.enemyGauge[0]).toBeGreaterThan(before[0])
  })

  it('演出中に tick を何度呼んでも、確定した eventTotal は増えない（二重実行しない）', () => {
    const { s, engine } = atbSetup('wait')
    tap(s, 'attack')
    const total = engine.getState().eventTotal
    run(s, 300)
    expect(engine.getState().eventTotal).toBe(total)
  })
})

describe('画面端での頭打ち', () => {
  it('のけぞり・踏み出しの全 tick で、味方も敵も枠が画面の端から出ない', () => {
    const { s } = setup({}, {}, { hp: 999, maxHp: 999 })
    tap(s, 'attack')
    for (let i = 0; i < 300; i++) {
      s.tick(16)
      for (const v of [...I(s).partyViews, ...I(s).enemyViews]) {
        const f = v as unknown as { slotRef: { x: number; width: number }; unit: number }
        const dx = v.container.x - v.baseX
        const pad = f.unit * MOTION_EXTENT_PAD
        const left = f.slotRef.x - pad
        const right = f.slotRef.x + f.slotRef.width + pad
        // 端の外へ動かない（最初から外にある枠は、それ以上外へ出ないだけ）
        expect(dx).toBeGreaterThanOrEqual(Math.min(0, MOTION_SCREEN_MARGIN - left) - 1e-6)
        expect(dx).toBeLessThanOrEqual(Math.max(0, 800 - MOTION_SCREEN_MARGIN - right) + 1e-6)
      }
    }
  })
})

describe('数字・窓・位置の不変条件', () => {
  it('全 tick を通して container の座標・alpha が有限で、alpha は 0〜1', () => {
    const { s } = setup({}, {}, { hp: 5, maxHp: 5 })
    tap(s, 'attack')
    for (let i = 0; i < 400; i++) {
      s.tick(16)
      for (const v of [...I(s).partyViews, ...I(s).enemyViews]) {
        expect(Number.isFinite(v.container.x)).toBe(true)
        expect(Number.isFinite(v.container.y)).toBe(true)
        expect(v.container.alpha).toBeGreaterThanOrEqual(0)
        expect(v.container.alpha).toBeLessThanOrEqual(1)
      }
    }
  })

  it('全部終われば位置は基準に戻る（倒れていない側）', () => {
    const { s } = setup()
    tap(s, 'attack')
    run(s, 8000)
    const v = I(s).partyViews[0]
    expect(v.container.x).toBeCloseTo(v.baseX, 3)
    expect(v.container.y).toBeCloseTo(v.baseY, 3)
  })

  it('倒れた敵は縦に沈む（down ポーズの絵が無いとき）', () => {
    const { s } = setup({}, {}, { hp: 1, maxHp: 1 })
    tap(s, 'attack')
    run(s, 10000)
    const v = I(s).enemyViews[0]
    expect(v.container.y).toBeGreaterThan(v.baseY)
  })

  it('数字は POPUP_TOTAL_MS 後には全て消える（リーク無し）', () => {
    const { s } = setup()
    tap(s, 'attack')
    run(s, 8000 + POPUP_TOTAL_MS)
    expect(I(s).popups).toHaveLength(0)
  })

  it('ポーズ未指定でも例外なく一周できる（1 枚絵のまま）', () => {
    const { s } = setup({}, { poses: undefined }, { poses: {} })
    expect(() => {
      tap(s, 'attack')
      run(s, 8000)
    }).not.toThrow()
  })
})

describe('ATB x ff: 演出キューに積まれる行動 (#745)', () => {
  const hero = (id: string) => entity(id, { agi: 25, hp: 99, maxHp: 99 })
  function twoHeroes(enemy: Partial<BattleEntity> = {}, mode: 'wait' | 'active' = 'wait') {
    const engine = new BattleEngine(
      [hero('a'), hero('b')],
      [entity('slime', { atk: 1, hp: 500, maxHp: 500, ...enemy })],
      {
        rng: () => 0.5,
        atb: { mode, initialGauges: { party: [1000, 1000] } },
      }
    )
    return { engine, s: make(engine) }
  }

  it('演出中に敵の行動が events に積まれ、キューで順に再生される（seq が単調に進む）', () => {
    const { s, engine } = twoHeroes({ agi: 40 }, 'active')
    tap(s, 'attack') // a の攻撃。b もコマンド待ち（active なので時間は止まらない）
    const seen: number[] = []
    for (let i = 0; i < 600; i++) {
      s.tick(16)
      const act = I(s).playback.active as { event: { seq: number } } | null
      if (act && seen[seen.length - 1] !== act.event.seq) seen.push(act.event.seq)
    }
    expect(engine.getState().eventTotal).toBeGreaterThan(1)
    expect(seen.length).toBeGreaterThan(1)
    expect([...seen].sort((x, y) => x - y)).toEqual(seen)
  })

  it('演出中に、行動可能な別の味方のコマンドが受け付けられ、キューの末尾に積まれる', () => {
    const { s, engine } = twoHeroes()
    tap(s, 'attack') // a
    run(s, 16)
    const total = engine.getState().eventTotal
    expect(I(s).playback.active).not.toBeNull()
    tap(s, 'attack') // 演出中に b が入力
    expect(engine.getState().eventTotal).toBeGreaterThan(total)
    expect(I(s).playback.queue.length).toBeGreaterThan(0)
    const queued = (I(s).playback.queue as { actor: { side: string; index: number } }[]).filter(
      (e) => e.actor.side === 'party'
    )
    expect(queued[queued.length - 1].actor).toEqual({ side: 'party', index: 1 })
  })

  it('複数行動が積まれても、命中のたびに HP 表示が段階的に変わる', () => {
    const { s, engine } = twoHeroes()
    tap(s, 'attack')
    tap(s, 'attack')
    const evs = engine
      .getState()
      .events.filter((e) => e.kind === 'attack' && e.actor.side === 'party')
    expect(evs).toHaveLength(2)
    const [e1, e2] = evs
    const key = 'enemy:0'
    const ov = () => (s as unknown as { hpOverride: Map<string, number> }).hpOverride.get(key)
    // 積んだ直後は最初の行動の前の HP
    expect(ov()).toBe(e1.hits[0].hpBefore)
    const t1 = buildActionTimeline('attack', { damages: true }).hitAt
    run(s, t1 + 16)
    expect(ov()).toBe(e1.hits[0].hpAfter)
    expect(e1.hits[0].hpAfter).toBe(e2.hits[0].hpBefore)
    // 2 つ目の命中は、1 つ目の行動の長さ + 命中までの時間。その直前はまだ 1 つ目の結果のまま、直後に 2 つ目の結果になる
    const d1 = eventTimeline(e1).duration
    run(s, d1 - 32)
    expect(ov()).toBe(e1.hits[0].hpAfter)
    run(s, 32)
    expect(ov()).toBe(e2.hits[0].hpAfter)
    run(s, 8000)
    expect((s as unknown as { hpOverride: Map<string, number> }).hpOverride.size).toBe(0)
  })

  it('決着: 積まれた演出を見せ切ってから閉じ、決着後に行動は積まれない', () => {
    const closed: string[] = []
    const engine = new BattleEngine(
      [hero('a'), hero('b')],
      [entity('slime', { hp: 1, maxHp: 1, atk: 1 })],
      {
        rng: () => 0.5,
        atb: { mode: 'wait', initialGauges: { party: [1000, 1000] } },
      }
    )
    const s = make(engine, { onClose: (o) => closed.push(o) })
    tap(s, 'attack')
    expect(engine.getState().phase).toBe('victory')
    const total = engine.getState().eventTotal
    tap(s, 'attack') // 決着後の入力は積まれない
    run(s, 100)
    expect(engine.getState().eventTotal).toBe(total)
    expect(closed).toHaveLength(0)
    run(s, 8000)
    expect(closed).toEqual(['victory'])
    expect(engine.getState().eventTotal).toBe(total)
  })
})
