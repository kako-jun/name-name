/**
 * BattleScreen の戦闘ログ 1 文字ずつ表示 (#755) の QA テスト。
 *
 * - off（既定）は旧コード（`s.log.slice(-n)` をそのまま logLines に入れる）と同一で、ticker も作らない
 * - on は新規行だけタイプ。タイプ中の 1 タップ目は全文表示のみ（コマンドは実行しない）
 * 速度（BATTLE_LOG_MS_PER_CHAR）は目視で調整する値なので定数参照にする。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ticker, type Container, type Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { BATTLE_LOG_MS_PER_CHAR } from './battleLogTypewriter'
import { RESULT_HOLD_DQ_MS } from './battleResult'

const MS = BATTLE_LOG_MS_PER_CHAR
const ENCOUNTER = 'SLIME が あらわれた！'

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

interface Cmd {
  id: string
  hit: Container
}
interface Internals {
  logLines: Text[]
  logPanel: Container
  logTicker: Ticker | null
  commands: Cmd[]
  visibleLogLines: number
  destroyed: boolean
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}, w = 800, h = 450, hp = 999) {
  const engine = new BattleEngine([entity('hero')], [entity('slime', { hp, maxHp: hp })], {
    rng: () => 0.5,
  })
  const s = new BattleScreen(engine, w, h, opts)
  created.push(s)
  return { s, engine }
}

afterEach(() => {
  for (const s of created.splice(0)) {
    if (!I(s).destroyed) s.destroy({ children: true })
  }
  vi.restoreAllMocks()
})

const texts = (s: BattleScreen): string[] => I(s).logLines.map((t) => t.text)
const tap = (s: BattleScreen, id: string): void => {
  I(s)
    .commands.find((c) => c.id === id)!
    .hit.emit('pointertap', {} as never)
}
const tapLog = (s: BattleScreen): void => {
  I(s).logPanel.emit('pointertap', {} as never)
}
/** ticker を ms 分進める（リスナーを 1 回呼ぶ） */
function advance(s: BattleScreen, ms: number): void {
  const t = I(s).logTicker!
  // Ticker は 1 フレームの経過を maxElapsedMS（100ms）で頭打ちにするので、小刻みに進める
  for (let left = ms; left > 0; left -= 20) t.update(t.lastTime + Math.min(20, left))
  // 浮動小数の丸め（29.99999 ms 等）で 1 文字ぶん取りこぼさないよう、ごく小さい余りを足す
  t.update(t.lastTime + 0.01)
}
/** 全文表示まで飛ばして command を押せる状態にする */
function settle(s: BattleScreen): void {
  tapLog(s)
}

describe('BattleScreen logTypewriter: off は旧挙動と同一 (#755)', () => {
  it.each([
    ['未指定', {}],
    ["'off'", { logTypewriter: 'off' as const }],
    ['未知値', { logTypewriter: 'x' as never }],
    ['大文字 ON（厳密一致でない）', { logTypewriter: 'ON' as never }],
  ] as const)('front: %s は初期ログが即時にリテラル通り（4 行・末尾空）', (_n, opts) => {
    const { s } = setup(opts)
    expect(texts(s)).toEqual([ENCOUNTER, '', '', ''])
    expect(I(s).logTicker).toBeNull()
  })

  it('front: コマンド後も log.slice(-4) と一致し、一度に全文が出る', () => {
    const { s, engine } = setup()
    tap(s, 'attack')
    const log = engine.getState().log
    expect(log.slice(0, 2)).toEqual([ENCOUNTER, 'HERO の こうげき！'])
    expect(texts(s)).toEqual(log.slice(-4))
  })

  it('front: 5 行以上積まれると先頭が押し出され log.slice(-4) と一致', () => {
    const { s, engine } = setup()
    tap(s, 'attack')
    tap(s, 'attack')
    const log = engine.getState().log
    expect(log.length).toBeGreaterThan(4)
    expect(texts(s)).toEqual(log.slice(-4))
  })

  it('side: log.slice(-n) と一致（n は visibleLogLines）し、ticker は無い', () => {
    const { s, engine } = setup({ layout: 'side' }, 360, 640)
    tap(s, 'attack')
    tap(s, 'attack')
    const n = I(s).visibleLogLines
    const tail = engine.getState().log.slice(-n)
    expect(texts(s)).toEqual(Array.from({ length: I(s).logLines.length }, (_, i) => tail[i] ?? ''))
    expect(I(s).logTicker).toBeNull()
  })

  it('off では Ticker を生成も start もしない', () => {
    const start = vi.spyOn(Ticker.prototype, 'start')
    const { s } = setup()
    tap(s, 'attack')
    s.redraw(640, 360)
    expect(start).not.toHaveBeenCalled()
    expect(I(s).logTicker).toBeNull()
  })

  it('off ではログ帯はタップ対象にならず、タップしてもコマンドは普通に実行される', () => {
    const { s, engine } = setup()
    expect(I(s).logPanel.eventMode).not.toBe('static')
    expect(() => tapLog(s)).not.toThrow()
    tap(s, 'attack')
    expect(engine.getState().log.length).toBeGreaterThan(1)
  })

  it('off では 1 回のタップで即コマンドが実行される（タップ吸収なし）', () => {
    const { s, engine } = setup()
    tap(s, 'attack')
    expect(engine.getState().log).toContain('HERO の こうげき！')
  })
})

describe('BattleScreen logTypewriter: on (#755)', () => {
  const on: BattleScreenOptions = { logTypewriter: 'on' }

  it('初期ログ（遭遇メッセージ）はタイプされ、最初は 0 文字・ticker が走る', () => {
    const { s } = setup(on)
    expect(texts(s)).toEqual(['', '', '', ''])
    expect(I(s).logTicker).not.toBeNull()
    expect(I(s).logTicker!.started).toBe(true)
  })

  it('ticker を進めると 1 文字ずつ出て、全文後に ticker が止まる', () => {
    const { s } = setup(on)
    advance(s, MS)
    expect(texts(s)[0]).toBe(ENCOUNTER.slice(0, 1))
    advance(s, MS * 2)
    expect(texts(s)[0]).toBe(ENCOUNTER.slice(0, 3))
    advance(s, MS * 100)
    expect(texts(s)[0]).toBe(ENCOUNTER)
    expect(I(s).logTicker!.started).toBe(false)
  })

  it('タイプ中のタップ: 1 回目は全文表示のみでコマンド不実行、2 回目で実行される', () => {
    const { s, engine } = setup(on)
    advance(s, MS)
    tap(s, 'attack')
    expect(texts(s)[0]).toBe(ENCOUNTER)
    expect(engine.getState().log).toEqual([ENCOUNTER])
    expect(I(s).logTicker!.started).toBe(false)
    tap(s, 'attack')
    expect(engine.getState().log.length).toBeGreaterThan(1)
  })

  it('コマンド後の新規行もタイプされ、未開始行は出ない', () => {
    const { s, engine } = setup(on)
    settle(s)
    tap(s, 'attack')
    const log = engine.getState().log
    expect(log.length).toBe(5) // 遭遇 + こうげき + ダメージ + 敵こうげき + 被ダメージ
    // 新規 4 行のうち、まだ始まっていない行は出ない
    expect(texts(s)).toEqual([ENCOUNTER, '', '', ''])
    advance(s, MS)
    expect(texts(s)).toEqual([ENCOUNTER, log[1].slice(0, 1), '', ''])
    advance(s, MS * log[1].length)
    expect(texts(s)).toEqual([ENCOUNTER, log[1], '', ''])
    advance(s, MS * log[2].length)
    expect(texts(s)).toEqual([ENCOUNTER, log[1], log[2], ''])
  })

  it('skip（ログ帯タップ）で待ち行も含め全文表示、ticker 停止、コマンドは不実行', () => {
    const { s, engine } = setup(on)
    settle(s)
    tap(s, 'attack')
    const before = engine.getState().log.length
    tapLog(s)
    expect(texts(s).filter((t) => t !== '')).toEqual(engine.getState().log.slice(-4))
    expect(I(s).logTicker!.started).toBe(false)
    expect(engine.getState().log.length).toBe(before)
  })

  it('on でもタイプ中でなければログ帯タップは何もしない（例外なし・ticker 起動なし）', () => {
    const { s } = setup(on)
    settle(s)
    const text = texts(s)
    expect(() => tapLog(s)).not.toThrow()
    expect(texts(s)).toEqual(text)
    expect(I(s).logTicker!.started).toBe(false)
  })

  it('on のログ帯は interactive', () => {
    const { s } = setup(on)
    expect(I(s).logPanel.eventMode).toBe('static')
  })

  it('タイプ中に skip 後、さらに新規行が積まれると ticker が再起動する', () => {
    const { s } = setup(on)
    settle(s)
    expect(I(s).logTicker!.started).toBe(false)
    tap(s, 'attack')
    expect(I(s).logTicker!.started).toBe(true)
  })

  it('skip で止まった ticker を、同じ戦闘内の次の新規行でも二重に作らず再利用する', () => {
    const { s } = setup(on)
    const first = I(s).logTicker
    settle(s)
    tap(s, 'attack')
    expect(I(s).logTicker).toBe(first)
  })

  it('onClose は、タイプ中のタップでは呼ばれず、全文表示後の勝利タップで 1 回だけ呼ばれる', () => {
    const onClose = vi.fn()
    const { s } = setup({ ...on, onClose }, 800, 450, 1)
    advance(s, MS) // タイプ中
    tap(s, 'attack') // 全文表示のみ。コマンドは実行されず onClose も呼ばれない
    tapLog(s)
    expect(onClose).not.toHaveBeenCalled()
    settle(s)
    tap(s, 'attack') // 勝利。最後のログのタイプ表示が終わり、待機を過ぎてから閉じる (#745)
    expect(onClose).not.toHaveBeenCalled()
    settle(s)
    s.tick(16) // タイプ表示が終わった tick で待機が始まる
    s.tick(RESULT_HOLD_DQ_MS)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('同じ文面のターンが上限(30 行)到達後に何度続いても、毎ターンタイプされ続ける', () => {
    // atk 3 はダメージのばらつき 0 なので、毎ターン全く同じ 4 行が積まれる
    const engine = new BattleEngine(
      [entity('hero', { hp: 99999, maxHp: 99999 })],
      [entity('slime', { hp: 99999, maxHp: 99999 })],
      { rng: () => 0.5 }
    )
    const s = new BattleScreen(engine, 800, 450, on)
    created.push(s)
    for (let turn = 0; turn < 15; turn++) {
      settle(s)
      tap(s, 'attack')
      expect(I(s).logTicker!.started).toBe(true)
    }
    expect(engine.getState().logTotal).toBeGreaterThan(30 + 4 * 7)
  })

  it('タイプ中の 1 タップ目は escape/spell/item でも実行されない', () => {
    const { s, engine } = setup(on)
    advance(s, MS)
    tap(s, 'escape')
    tap(s, 'spell')
    tap(s, 'item')
    expect(engine.getState().log).toEqual([ENCOUNTER])
  })
})

describe('BattleScreen logTypewriter: destroy / redraw / layout (#755)', () => {
  const on: BattleScreenOptions = { logTypewriter: 'on' }

  it('destroy で ticker を破棄する（タイプ中でも）', () => {
    const destroy = vi.spyOn(Ticker.prototype, 'destroy')
    const { s } = setup(on)
    const t = I(s).logTicker!
    expect(t.started).toBe(true)
    s.destroy({ children: true })
    expect(destroy).toHaveBeenCalled()
    expect(I(s).logTicker).toBeNull()
  })

  it('off の destroy は Ticker.destroy を呼ばない', () => {
    const destroy = vi.spyOn(Ticker.prototype, 'destroy')
    const { s } = setup()
    s.destroy({ children: true })
    expect(destroy).not.toHaveBeenCalled()
  })

  it('二重 destroy でも落ちない', () => {
    const { s } = setup(on)
    s.destroy({ children: true })
    expect(() => s.destroy({ children: true })).not.toThrow()
  })

  it('destroy 後に（遅れて）タップや redraw が来ても Ticker を作り直さない', () => {
    const start = vi.spyOn(Ticker.prototype, 'start')
    const { s } = setup(on)
    const callsBefore = start.mock.calls.length
    s.destroy({ children: true })
    expect(() => {
      try {
        tapLog(s)
      } catch {
        /* destroyed container の emit は無視してよい */
      }
    }).not.toThrow()
    expect(start.mock.calls.length).toBe(callsBefore)
    expect(I(s).logTicker).toBeNull()
  })

  it('front: redraw（サイズ変更）でタイプ途中の文字数が巻き戻らない', () => {
    const { s } = setup(on)
    advance(s, MS * 3)
    const mid = texts(s)[0]
    expect(mid).toBe(ENCOUNTER.slice(0, 3))
    s.redraw(640, 360)
    s.redraw(800, 450)
    expect(texts(s)[0]).toBe(mid)
    expect(I(s).logTicker!.started).toBe(true)
    advance(s, MS)
    expect(texts(s)[0]).toBe(ENCOUNTER.slice(0, 4))
  })

  it('side: redraw でタイプ途中が保たれ、未開始行は出ない', () => {
    const { s, engine } = setup({ ...on, layout: 'side' }, 360, 640)
    settle(s)
    tap(s, 'attack')
    const log = engine.getState().log
    advance(s, MS * 2)
    const visible = () => texts(s).filter((t) => t !== '')
    expect(visible()[visible().length - 1]).toBe(log[1].slice(0, 2))
    s.redraw(360, 640)
    expect(visible()[visible().length - 1]).toBe(log[1].slice(0, 2))
    expect(visible()).not.toContain(log[2])
  })

  it('side: 画面サイズ変更でログ行数が変わっても、見えている末尾 n 行と整合する', () => {
    const { s, engine } = setup({ ...on, layout: 'side' }, 360, 640)
    settle(s)
    tap(s, 'attack')
    settle(s)
    tap(s, 'attack')
    settle(s)
    const log = engine.getState().log
    for (const [w, h] of [
      [360, 640],
      [800, 450],
      [360, 300],
      [360, 640],
    ] as const) {
      s.redraw(w, h)
      const n = I(s).visibleLogLines
      const shown = texts(s).filter((t) => t !== '')
      expect(shown).toEqual(log.slice(-n).slice(-shown.length))
      expect(shown.length).toBe(Math.min(n, log.length))
    }
  })

  it('side でもタイプ中のタップはコマンド不実行・ログ帯タップで skip', () => {
    const { s, engine } = setup({ ...on, layout: 'side' }, 360, 640)
    advance(s, MS)
    tap(s, 'attack')
    expect(engine.getState().log).toEqual([ENCOUNTER])
    expect(texts(s).filter((t) => t !== '')).toEqual([ENCOUNTER])
    tap(s, 'attack')
    settle(s)
    expect(engine.getState().log.length).toBeGreaterThan(1)
  })

  it('side の初期ログも on ならタイプされ 0 文字から', () => {
    const { s } = setup({ ...on, layout: 'side' }, 360, 640)
    expect(texts(s).every((t) => t === '')).toBe(true)
    advance(s, MS)
    expect(texts(s).filter((t) => t !== '')).toEqual([ENCOUNTER.slice(0, 1)])
  })
})
