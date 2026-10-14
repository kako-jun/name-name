/**
 * 勝敗が決まってから閉じるまでの「読ませる時間」(#745 分割4) の BattleScreen 側の挙動。
 * 時間計算そのものは battleResult.test.ts。ここは画面が演出・タイプ表示の完了を待ち、メッセージと victory ポーズを出し、
 * 決定操作・タップで飛ばせて、逃走はすぐ閉じることを確かめる。
 */
import { afterEach, describe, expect, it } from 'vitest'
// Container に eventMode / isInteractive を足す（実アプリでは Application がイベントシステムを登録する）
import 'pixi.js/events'
import { EventBoundary, type Container, type Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  RESULT_HOLD_DQ_MS,
  RESULT_HOLD_FF_MS,
  RESULT_SKIP_GUARD_MS,
  resultMessageText,
} from './battleResult'

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
  messageText: Text | null
  logPanel: Container
  sampleEntity(side: 'party' | 'enemy', index: number): { pose: string }
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
type Kind = 'victory' | 'defeat'
function setup(kind: Kind, opts: BattleScreenOptions = {}) {
  const engine =
    kind === 'victory'
      ? new BattleEngine([entity('hero', { atk: 999 })], [entity('slime', { hp: 1, maxHp: 1 })], {
          rng: () => 0.5,
        })
      : new BattleEngine(
          [entity('hero', { hp: 1, maxHp: 1, def: 0, agi: 1 })],
          [entity('ogre', { hp: 999, maxHp: 999, atk: 999, agi: 99 })],
          { rng: () => 0.5 }
        )
  const closed: string[] = []
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    onClose: (o) => closed.push(o),
    ...opts,
  })
  created.push(s)
  return { s, engine, closed }
}
const tap = (s: BattleScreen, id: string) =>
  I(s)
    .commands.find((c) => c.id === id)!
    .hit.emit('pointertap', {} as never)
const tapScreen = (s: BattleScreen) => s.emit('pointertap', {} as never)
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
}
const press = (key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
  globalThis.dispatchEvent(e)
  return e
}

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('勝敗を読ませてから閉じる: dq', () => {
  it('勝利: すぐには閉じず、待機を過ぎてから 1 回だけ onClose', () => {
    const { s, engine, closed } = setup('victory')
    tap(s, 'attack')
    expect(engine.getState().phase).toBe('victory')
    expect(closed).toEqual([])
    s.tick(RESULT_HOLD_DQ_MS - 1)
    expect(closed).toEqual([])
    s.tick(1)
    expect(closed).toEqual(['victory'])
    s.tick(5000)
    expect(closed).toEqual(['victory'])
  })

  it('全滅も同じく待機してから閉じる', () => {
    const { s, engine, closed } = setup('defeat')
    tap(s, 'attack')
    expect(engine.getState().phase).toBe('defeat')
    expect(closed).toEqual([])
    s.tick(RESULT_HOLD_DQ_MS)
    expect(closed).toEqual(['defeat'])
  })

  it('逃走成功は待たずにすぐ閉じる', () => {
    const closed: string[] = []
    // 逃走が必ず成功する乱数
    const engine = new BattleEngine([entity('hero')], [entity('slime', { agi: 1 })], {
      rng: () => 0,
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      onClose: (o) => closed.push(o),
    })
    created.push(s)
    tap(s, 'escape')
    expect(engine.getState().phase).toBe('escaped')
    expect(closed).toEqual(['escaped'])
  })

  it('決定を押した直後のタップでは飛ばない。猶予を過ぎたら画面タップで飛ばせる', () => {
    const { s, closed } = setup('victory')
    tap(s, 'attack')
    tapScreen(s) // 戦闘を決めたタップの bubbling 相当
    expect(closed).toEqual([])
    s.tick(RESULT_SKIP_GUARD_MS)
    tapScreen(s)
    expect(closed).toEqual(['victory'])
  })

  it('決定キー（Enter / Space / Z）で飛ばせる。他のキーでは飛ばない。destroy 後は無反応', () => {
    const a = setup('victory')
    tap(a.s, 'attack')
    a.s.tick(RESULT_SKIP_GUARD_MS)
    press('a')
    expect(a.closed).toEqual([])
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(a.closed).toEqual(['victory'])
    const b = setup('victory')
    tap(b.s, 'attack')
    b.s.tick(RESULT_SKIP_GUARD_MS)
    press(' ')
    expect(b.closed).toEqual(['victory'])
    const c = setup('victory')
    tap(c.s, 'attack')
    c.s.tick(RESULT_SKIP_GUARD_MS)
    press('z')
    expect(c.closed).toEqual(['victory'])
    // 待機の前では決定キーを奪わない
    const d = setup('victory')
    expect(press('Enter').defaultPrevented).toBe(false)
    // 待機中に destroy したらリスナーが外れる
    tap(d.s, 'attack')
    d.s.destroy({ children: true })
    expect(press('Enter').defaultPrevented).toBe(false)
    expect(d.closed).toEqual([])
  })

  it('決定キー: isInputSuspended・修飾キー・repeat のときは飛ばさない。戦闘外のタップも同様', () => {
    let suspended = true
    const { s, closed } = setup('victory', { isInputSuspended: () => suspended })
    tap(s, 'attack')
    s.tick(RESULT_SKIP_GUARD_MS)
    press('Enter')
    tapScreen(s)
    expect(closed).toEqual([])
    suspended = false
    press('Enter', { ctrlKey: true })
    press('Enter', { shiftKey: true })
    press('Enter', { repeat: true })
    expect(closed).toEqual([])
    press('Enter')
    expect(closed).toEqual(['victory'])
  })

  it('tick を呼ばないホストでは待機が終わらない（全ホストが毎フレーム tick を呼ぶ契約）', () => {
    const { s, closed } = setup('victory')
    tap(s, 'attack')
    tapScreen(s) // 猶予は tick の総和なので、tick なしではタップでも抜けられない
    expect(closed).toEqual([])
    s.tick(16)
    s.tick(RESULT_HOLD_DQ_MS)
    expect(closed).toEqual(['victory'])
  })

  it('redraw で全画面のタップ領域が新しい画面サイズに追従する（待機中）', () => {
    const { s } = setup('victory')
    tap(s, 'attack')
    const area = () => (s as unknown as { hitArea: { width: number; height: number } }).hitArea
    expect([area().width, area().height]).toEqual([800, 450])
    s.redraw(450, 800)
    expect([area().width, area().height]).toEqual([450, 800])
  })

  it('全画面のタップ受け口は待機中だけ。待機の前・閉じた後・destroy 後には残らない', () => {
    const mode = (s: BattleScreen) => [s.eventMode === 'static', s.hitArea]
    const a = setup('victory')
    expect(mode(a.s)).toEqual([false, null])
    tap(a.s, 'attack')
    expect(a.s.eventMode).toBe('static')
    expect(a.s.hitArea).not.toBeNull()
    a.s.tick(RESULT_HOLD_DQ_MS)
    expect(a.closed).toEqual(['victory'])
    expect(mode(a.s)).toEqual([false, null])
    const b = setup('victory')
    tap(b.s, 'attack')
    b.s.destroy({ children: true })
    expect(mode(b.s)).toEqual([false, null])
  })

  it('待機中はコマンドを受けない', () => {
    const { s, engine } = setup('victory')
    tap(s, 'attack')
    const total = engine.getState().eventTotal
    tap(s, 'attack')
    expect(engine.getState().eventTotal).toBe(total)
  })

  it('logTypewriter on: 最後のログのタイプ表示が終わってから待機が始まる', () => {
    const { s, closed } = setup('victory', { logTypewriter: 'on' })
    I(s).logPanel.emit('pointertap', {} as never) // 戦闘開始のログを全文表示
    tap(s, 'attack') // 勝利のログがタイプ中
    run(s, RESULT_HOLD_DQ_MS * 2)
    expect(closed).toEqual([]) // タイプ中は待機も始まらない
    expect((s as unknown as { resultElapsed: number | null }).resultElapsed).toBeNull()
    // 全文表示にすると、次の tick で待機が始まる
    I(s).logPanel.emit('pointertap', {} as never)
    s.tick(16)
    expect(closed).toEqual([])
    s.tick(RESULT_HOLD_DQ_MS)
    expect(closed).toEqual(['victory'])
  })
})

describe('勝敗を読ませてから閉じる: ff', () => {
  it('勝利: 演出が終わり、勝利メッセージと victory ポーズを見せてから閉じる', () => {
    const { s, closed } = setup('victory', { presentation: 'ff' })
    tap(s, 'attack')
    // 演出中はまだ勝利メッセージも出ない・閉じない
    run(s, 100)
    expect(closed).toEqual([])
    expect(I(s).messageText!.text).not.toBe(resultMessageText('victory'))
    // 演出が終わるまで進める（まだ閉じない）
    let guard = 0
    while (I(s).messageText!.text !== resultMessageText('victory') && guard++ < 400) run(s, 16)
    expect(closed).toEqual([])
    expect(I(s).messageText!.visible).toBe(true)
    expect(I(s).logPanel.visible).toBe(true)
    expect(I(s).sampleEntity('party', 0).pose).toBe('victory')
    // 待機を過ぎたら閉じる
    run(s, RESULT_HOLD_FF_MS)
    expect(closed).toEqual(['victory'])
  })

  it('全滅: メッセージは ぜんめつ。待機後に閉じる', () => {
    const { s, closed } = setup('defeat', { presentation: 'ff' })
    tap(s, 'attack')
    let guard = 0
    while (I(s).messageText!.text !== resultMessageText('defeat') && guard++ < 600) run(s, 16)
    expect(I(s).messageText!.visible).toBe(true)
    expect(closed).toEqual([])
    run(s, RESULT_HOLD_FF_MS)
    expect(closed).toEqual(['defeat'])
  })

  it('勝利メッセージの待機は画面タップで飛ばせる', () => {
    const { s, closed } = setup('victory', { presentation: 'ff' })
    tap(s, 'attack')
    let guard = 0
    while (I(s).messageText!.text !== resultMessageText('victory') && guard++ < 400) run(s, 16)
    expect(closed).toEqual([])
    run(s, RESULT_SKIP_GUARD_MS)
    tapScreen(s)
    expect(closed).toEqual(['victory'])
  })
})

describe('勝敗を読ませてから閉じる: ATB・ff 逃走', () => {
  const atbOpts = { atb: { mode: 'wait' as const, initialGauges: { party: [1000] } }, rng: () => 0 }

  it('ATB dq: 待機中はゲージが進まず（署名不変）、待機後に閉じる', () => {
    const engine = new BattleEngine(
      [entity('hero', { atk: 999 })],
      [entity('slime', { hp: 1, maxHp: 1 })],
      atbOpts
    )
    const closed: string[] = []
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', onClose: (o) => closed.push(o) })
    created.push(s)
    tap(s, 'attack')
    expect(engine.getState().phase).toBe('victory')
    const sig = () => JSON.stringify(engine.getState().atb)
    const before = sig()
    s.tick(RESULT_HOLD_DQ_MS - 1)
    expect(sig()).toBe(before)
    expect(closed).toEqual([])
    s.tick(1)
    expect(closed).toEqual(['victory'])
  })

  it('ff + ATB: 演出のあとメッセージを出し、待機後に閉じる', () => {
    const engine = new BattleEngine(
      [entity('hero', { atk: 999 })],
      [entity('slime', { hp: 1, maxHp: 1 })],
      atbOpts
    )
    const closed: string[] = []
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      onClose: (o) => closed.push(o),
    })
    created.push(s)
    tap(s, 'attack')
    let guard = 0
    while (I(s).messageText!.text !== resultMessageText('victory') && guard++ < 400) run(s, 16)
    expect(closed).toEqual([])
    run(s, RESULT_HOLD_FF_MS)
    expect(closed).toEqual(['victory'])
  })

  it('ff で逃走成功したときは、演出のあとすぐ閉じる（勝敗の待機なし）', () => {
    const closed: string[] = []
    const engine = new BattleEngine([entity('hero')], [entity('slime', { agi: 1 })], {
      rng: () => 0,
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      onClose: (o) => closed.push(o),
    })
    created.push(s)
    tap(s, 'escape')
    run(s, 3000)
    expect(closed).toEqual(['escaped'])
    expect((s as unknown as { resultElapsed: number | null }).resultElapsed).toBeNull()
  })
})

describe('コマンドボタンが実際のイベント境界のヒットテストで届く（全画面の受け口に奪われない）', () => {
  const atbOpts = { atb: { mode: 'wait' as const, initialGauges: { party: [1000] } }, rng: () => 0 }
  // 各ボタンの中心を画面座標に直し、Pixi のイベント境界でヒットテストして、ボタン自身に当たることを見る
  const hitsButtons = (s: BattleScreen) => {
    const boundary = new EventBoundary(s)
    const cmds = I(s).commands as unknown as {
      id: string
      hit: Container & { hitArea: { x: number; y: number; width: number; height: number } }
    }[]
    const attack = cmds.find((c) => c.id === 'attack')!
    const ha = attack.hit.hitArea
    const p = attack.hit.toGlobal({ x: ha.x + ha.width / 2, y: ha.y + ha.height / 2 })
    return boundary.hitTest(p.x, p.y) === attack.hit
  }
  const cases: [string, BattleScreenOptions, boolean][] = [
    ['dq', {}, false],
    ['ff', { presentation: 'ff' }, false],
    ['dq + ATB', {}, true],
    ['ff + ATB', { presentation: 'ff' }, true],
  ]
  it.each(cases)('通常時: %s', (_n, opts, useAtb) => {
    const engine = new BattleEngine(
      [entity('hero', { atk: 999 })],
      [entity('slime', { hp: 1, maxHp: 1 })],
      useAtb ? atbOpts : { rng: () => 0.5 }
    )
    const closed: string[] = []
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      onClose: (o) => closed.push(o),
      ...opts,
    })
    created.push(s)
    expect(hitsButtons(s)).toBe(true)
    tap(s, 'attack')
    expect(engine.getState().phase).toBe('victory')
  })
})
