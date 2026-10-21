/** EventRunner の `[戦闘: id]` コマンド (#741): 戦闘の終了を待ち、結果の `次=` で分岐する */
import { describe, expect, it, vi } from 'vitest'
import { EventRunner, MAX_BATTLE_BRANCH_DEPTH, type EventBattleHost } from './eventRunner'
import type { DialogBox } from './DialogBox'
import type { BattleResult } from './loot'
import type { EventCommand } from '../types'

/** 台詞は表示せず、すぐ次へ進む最小の DialogBox */
function makeRunner(host?: EventBattleHost) {
  const shown: string[] = []
  const dialogBox = {
    show: (_n: string, text: string) => shown.push(text),
    hide: vi.fn(),
    isTyping: () => false,
    skipTypewriter: vi.fn(),
    isShowing: true,
  } as unknown as DialogBox
  const runner = new EventRunner(dialogBox, { moveNpcTo: () => Promise.resolve() }, host)
  return { runner, shown, advance: () => runner.advance() }
}

const result = (next?: string): BattleResult => ({
  outcome: 'victory',
  exp: 0,
  gold: 0,
  loot: [],
  items: [],
  script: { id: 'b', flags: {}, ...(next !== undefined ? { next } : {}) },
})
const say = (t: string): EventCommand => ({ type: 'Narration', text: [t] })
const battle = (id: string): EventCommand => ({ type: 'Battle', id })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Battle コマンド', () => {
  it('戦闘が終わるまでキューを止め、終わったら続きを実行して onComplete を呼ぶ', async () => {
    let finish: (r: BattleResult | null) => void = () => {}
    const startBattle = vi.fn(() => new Promise<BattleResult | null>((r) => (finish = r)))
    const { runner, shown, advance } = makeRunner({ startBattle })
    const done = vi.fn()
    runner.run([say('前'), battle('b'), say('後')], done)
    expect(shown).toEqual(['前'])
    advance() // 前の台詞を送る → 戦闘開始
    expect(startBattle).toHaveBeenCalledWith('b')
    expect(shown).toEqual(['前'])
    await flush()
    expect(shown).toEqual(['前']) // まだ戦闘中
    finish(result())
    await flush()
    expect(shown).toEqual(['前', '後'])
    advance()
    expect(done).toHaveBeenCalledTimes(1)
    expect(runner.isRunning).toBe(false)
  })

  it('次= があればそのイベントへ分岐し、現在のイベントの残りは捨てる', async () => {
    const events: Record<string, EventCommand[]> = { after: [say('暗転')] }
    const { runner, shown, advance } = makeRunner({
      startBattle: () => Promise.resolve(result('after')),
      findEvent: (n) => events[n],
    })
    const done = vi.fn()
    runner.run([battle('b'), say('勝ったことになっている')], done)
    await flush()
    expect(shown).toEqual(['暗転'])
    advance()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('次= のイベントが無ければ警告して残りを続ける', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runner, shown } = makeRunner({
      startBattle: () => Promise.resolve(result('nowhere')),
      findEvent: () => undefined,
    })
    runner.run([battle('b'), say('続き')])
    await flush()
    expect(shown).toEqual(['続き'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('次= が空・結果が null（始められなかった）・script なしは、残りを続ける', async () => {
    for (const r of [result(''), null, { ...result(), script: undefined } as BattleResult]) {
      const { runner, shown } = makeRunner({ startBattle: () => Promise.resolve(r) })
      runner.run([battle('b'), say('続き')])
      await flush()
      expect(shown).toEqual(['続き'])
    }
  })

  it('ホストが無ければ警告して飛ばす', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runner, shown } = makeRunner(undefined)
    runner.run([battle('b'), say('続き')])
    expect(shown).toEqual(['続き'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('戦闘の待ちの間に destroy / 次の run があれば、古い続きは動かない', async () => {
    let finish: (r: BattleResult | null) => void = () => {}
    const host: EventBattleHost = {
      startBattle: () => new Promise<BattleResult | null>((r) => (finish = r)),
    }
    const a = makeRunner(host)
    a.runner.run([battle('b'), say('古い続き')])
    a.runner.destroy()
    finish(result())
    await flush()
    expect(a.shown).toEqual([])

    const b = makeRunner(host)
    b.runner.run([battle('b'), say('古い続き')])
    const firstFinish = finish
    b.runner.run([say('新しい'), say('二つ目')]) // 別のイベントが走り出した（台詞待ちの途中）
    firstFinish(result())
    await flush()
    expect(b.shown).toEqual(['新しい'])
  })

  it('次= の分岐が MAX_BATTLE_BRANCH_DEPTH を超えて続くと止める（無限の連鎖にしない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const events: Record<string, EventCommand[]> = { loop: [battle('b')] }
    const { runner } = makeRunner({
      startBattle: () => {
        calls++
        // 上限が外れて連鎖が止まらなくなっても、テストが固まらず `calls` の不一致として落ちるよう、余裕を超えたら戦闘を終えない
        if (calls > MAX_BATTLE_BRANCH_DEPTH + 5) return new Promise<BattleResult | null>(() => {})
        return Promise.resolve(result('loop'))
      },
      findEvent: (n) => events[n],
    })
    const done = vi.fn()
    runner.run([battle('b')], done)
    for (let i = 0; i < MAX_BATTLE_BRANCH_DEPTH + 5; i++) await flush()
    expect(calls).toBe(MAX_BATTLE_BRANCH_DEPTH + 1)
    expect(done).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('startBattle が例外（reject）でも進行不能にならず続きへ進む', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runner, shown } = makeRunner({ startBattle: () => Promise.reject(new Error('x')) })
    runner.run([battle('b'), say('続き')])
    await flush()
    expect(shown).toEqual(['続き'])
    warn.mockRestore()
  })
})
