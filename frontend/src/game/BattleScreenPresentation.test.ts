/**
 * BattleScreen の FF 式演出 (#745) のスモークテスト。
 * 時間計算そのものは battleMotion.test.ts。ここは画面が演出を再生し、入力・終了を待たせることを確かめる。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { buildActionTimeline, POPUP_TOTAL_MS } from './battleMotion'

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
  commands: { id: string; hit: Container }[]
  enemyViews: { container: Container; baseX: number }[]
  partyViews: { container: Container; baseX: number }[]
  popups: { text: Text }[]
  messageText: Text | null
  logPanel: Container
  popupLayer: Container | null
  playback: { queue: unknown[]; active: unknown }
  statusTexts: Text[]
  statusHpTexts: Text[]
  statusHpMaxes: Text[]
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}, enemyHp = 999, closed: string[] = []) {
  const engine = new BattleEngine(
    [entity('hero')],
    [entity('slime', { hp: enemyHp, maxHp: enemyHp, atk: 1 })],
    { rng: () => 0.5 }
  )
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    presentation: 'ff',
    onClose: (o) => closed.push(o),
    ...opts,
  })
  created.push(s)
  return { s, engine }
}
const tap = (s: BattleScreen, id: string) =>
  I(s)
    .commands.find((c) => c.id === id)!
    .hit.emit('pointertap', {} as never)
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
}

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('BattleScreen presentation', () => {
  it('dq（既定）: 演出の部品を作らず、tick は何もしない', () => {
    const { s, engine } = setup({ presentation: 'dq' })
    expect(I(s).popupLayer).toBeNull()
    expect(I(s).messageText).toBeNull()
    tap(s, 'attack')
    s.tick(1000)
    expect(I(s).playback.queue).toHaveLength(0)
    expect(engine.getState().eventTotal).toBeGreaterThan(0)
  })

  it('front レイアウトでは ff を指定しても dq のまま', () => {
    const { s } = setup({ layout: 'front' })
    expect(I(s).popupLayer).toBeNull()
  })

  it('ff: 通常攻撃で窓は出ず、味方が左へ出て戻り、数字が出て、演出中はコマンドを受けない', () => {
    const { s, engine } = setup()
    expect(I(s).logPanel.visible).toBe(false)
    const hero = I(s).partyViews[0]
    tap(s, 'attack')
    // 演出中: 次のコマンドは無視（エンジンは進まない）
    const total = engine.getState().eventTotal
    tap(s, 'attack')
    expect(engine.getState().eventTotal).toBe(total)
    expect(I(s).logPanel.visible).toBe(false)
    // 踏み出しの途中: 味方は基準より左
    run(s, 150)
    expect(hero.container.x).toBeLessThan(hero.baseX)
    // 命中後: 数字が出る
    run(s, 200)
    expect(I(s).popups.length).toBeGreaterThan(0)
    expect(I(s).popups[0].text.text).toMatch(/^\d+$/)
    // 全部終われば元の位置に戻り、数字も消える
    run(s, 5000)
    expect(hero.container.x).toBeCloseTo(hero.baseX, 3)
    expect(I(s).popups).toHaveLength(0)
    expect(I(s).playback.queue).toHaveLength(0)
    expect(I(s).playback.active).toBeNull()
  })

  it('ff: HP 表示は命中の瞬間まで古い値', () => {
    const { s } = setup()
    const before = I(s).statusHpTexts[0].text
    tap(s, 'attack')
    // 敵の反撃も同じ呼び出しで積まれるが、味方の HP は味方の命中まで変わらない
    expect(I(s).statusHpTexts[0].text).toBe(before)
    run(s, 6000)
    expect(I(s).statusHpTexts[0].text).not.toBe(before)
  })

  it('ff: 呪文の名前だけを窓の中央に一度に出し、行動が終われば窓を消す', () => {
    const { s, engine } = setup()
    engine.selectSpell({ name: 'ファイア', mp: 1, target: '敵単体', effect: 'damage 5..5' })
    s.redraw(800, 450)
    run(s, 16)
    expect(I(s).messageText!.text).toBe('ファイア')
    expect(I(s).messageText!.visible).toBe(true)
    expect(I(s).logPanel.visible).toBe(true)
    run(s, 5000)
    expect(I(s).messageText!.visible).toBe(false)
    expect(I(s).logPanel.visible).toBe(false)
  })

  it('ff: 敵の特技 (#834) も名前を窓に出し、対象（味方）の位置に数字を出す。終われば窓を消す', () => {
    const { s, engine } = setup()
    const before = I(s).statusHpTexts[0].text
    engine.performSkill(
      { side: 'enemy', index: 0 },
      {
        name: 'すみはき',
        target: '相手単体',
        effect: 'damage 5..5',
        message: '{user}は 墨を はいた！',
      }
    )
    s.redraw(800, 450)
    run(s, 16)
    expect(I(s).messageText!.text).toBe('すみはき')
    expect(I(s).messageText!.visible).toBe(true)
    run(s, 700)
    expect(I(s).popups[0].text.text).toBe('5')
    run(s, 5000)
    expect(I(s).messageText!.visible).toBe(false)
    expect(I(s).statusHpTexts[0].text).not.toBe(before)
  })

  it('ff: 予兆つきの特技は名前の代わりに予兆の文言を窓に出す (#836)。効果が無ければ MISS の数字は出ない', () => {
    const { s, engine } = setup()
    engine.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'ためる', target: '自分', telegraph: '{user}の からだが ふるえている！' }
    )
    s.redraw(800, 450)
    run(s, 16)
    expect(I(s).messageText!.text).toContain('からだが ふるえている！')
    expect(I(s).messageText!.visible).toBe(true)
    run(s, 700)
    expect(I(s).popups).toHaveLength(0)
    run(s, 5000)
    expect(I(s).messageText!.visible).toBe(false)
  })

  it('ff: 勝敗が決まっても演出（と数字）を見せ切ってから閉じる', () => {
    const closed: string[] = []
    const { s } = setup({}, 1, closed)
    tap(s, 'attack')
    expect(closed).toHaveLength(0)
    const tl = buildActionTimeline('attack', { damages: true, downs: true })
    run(s, tl.duration - 50)
    expect(closed).toHaveLength(0)
    run(s, POPUP_TOTAL_MS + tl.duration)
    expect(closed).toEqual(['victory'])
  })

  it('ff + ATB: 演出中もゲージは進む', () => {
    const engine = new BattleEngine([entity('hero', { agi: 25 })], [entity('slime', { agi: 1 })], {
      rng: () => 0.5,
      atb: { mode: 'wait', initialGauges: { party: [1000] } },
    })
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
    created.push(s)
    tap(s, 'attack')
    const g = engine.getState().atb!.partyGauge[0]
    run(s, 160)
    expect(engine.getState().atb!.partyGauge[0]).toBeGreaterThan(g)
  })
})
