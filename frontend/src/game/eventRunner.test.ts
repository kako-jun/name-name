/**
 * EventRunner のユニットテスト (#197)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventRunner } from './eventRunner'
import type { NpcMover } from './eventRunner'
import type { DialogBox } from './DialogBox'
import type { EventCommand } from '../types'

// DialogBox のモック
function makeDialogBox(): DialogBox {
  return {
    isTyping: vi.fn(() => false),
    skipTypewriter: vi.fn(),
    nextPage: vi.fn(() => false),
    isShowing: false,
    show: vi.fn(),
    hide: vi.fn(),
  } as unknown as DialogBox
}

// NpcMover のモック
function makeNpcMover(): NpcMover {
  return {
    moveNpcTo: vi.fn(() => Promise.resolve()),
  }
}

describe('EventRunner', () => {
  let dialogBox: ReturnType<typeof makeDialogBox>
  let npcMover: ReturnType<typeof makeNpcMover>
  let runner: EventRunner

  beforeEach(() => {
    dialogBox = makeDialogBox()
    npcMover = makeNpcMover()
    runner = new EventRunner(dialogBox as unknown as DialogBox, npcMover)
  })

  it('空のキューで即 isRunning=false になる', () => {
    const onComplete = vi.fn()
    runner.run([], onComplete)
    expect(runner.isRunning).toBe(false)
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('Wait コマンドで指定 ms 後に次のコマンドに進む', async () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const commands: EventCommand[] = [{ type: 'Wait', ms: 100 }]
    runner.run(commands, onComplete)
    expect(runner.isRunning).toBe(true)
    expect(onComplete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    await vi.runAllTimersAsync()
    expect(runner.isRunning).toBe(false)
    expect(onComplete).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('Dialog コマンドで dialogBox.show が呼ばれる', () => {
    const commands: EventCommand[] = [{ type: 'Dialog', character: 'Alice', text: ['こんにちは'] }]
    runner.run(commands)
    expect(runner.isRunning).toBe(true)
    expect(dialogBox.show).toHaveBeenCalledWith('Alice', 'こんにちは', undefined)
  })

  it('advance() で Dialog の次に進む', () => {
    const onComplete = vi.fn()
    ;(dialogBox as unknown as { isShowing: boolean }).isShowing = true
    const commands: EventCommand[] = [{ type: 'Dialog', character: 'Bob', text: ['やあ'] }]
    runner.run(commands, onComplete)
    expect(runner.isRunning).toBe(true)
    // advance() で Dialog を閉じて次へ
    ;(dialogBox.isTyping as ReturnType<typeof vi.fn>).mockReturnValue(false)
    runner.advance()
    expect(dialogBox.hide).toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
    expect(runner.isRunning).toBe(false)
  })

  it('onComplete コールバックが最後に呼ばれる', () => {
    const onComplete = vi.fn()
    const commands: EventCommand[] = [{ type: 'Narration', text: ['ナレーション'] }]
    runner.run(commands, onComplete)
    // Narration は advance() 待ち
    expect(onComplete).not.toHaveBeenCalled()
    ;(dialogBox as unknown as { isShowing: boolean }).isShowing = true
    ;(dialogBox.isTyping as ReturnType<typeof vi.fn>).mockReturnValue(false)
    runner.advance()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('destroy() で isRunning が false になる', () => {
    const commands: EventCommand[] = [{ type: 'Dialog', character: 'X', text: ['test'] }]
    runner.run(commands)
    expect(runner.isRunning).toBe(true)
    runner.destroy()
    expect(runner.isRunning).toBe(false)
  })

  describe('Emotion (#946)', () => {
    const emo = (target: string, kind: string, duration_ms?: number): EventCommand => ({
      type: 'Emotion',
      target,
      kind,
      ...(duration_ms !== undefined ? { duration_ms } : {}),
    })

    it('emotionHost があれば呼び、待たずに次のコマンドへ進む', () => {
      const host = { showEmotion: vi.fn() }
      const r = new EventRunner(dialogBox, npcMover, undefined, host)
      r.run([
        emo('近所の子', 'びっくり'),
        emo('主人公', '？', 900),
        { type: 'Narration', text: ['次'] },
      ])
      // Emotion 2 つを同期で消化して、そのまま Narration が出ている（待っていない）
      expect(host.showEmotion.mock.calls).toEqual([
        ['近所の子', 'びっくり', undefined],
        ['主人公', '？', 900],
      ])
      expect(dialogBox.show).toHaveBeenCalledWith('', '次', undefined)
    })

    it('emotionHost が無ければ読み飛ばして次へ進む（TopDown の既存呼び出しと同じ）', () => {
      const onComplete = vi.fn()
      runner.run([emo('主人公', 'びっくり'), { type: 'Narration', text: ['次'] }], onComplete)
      expect(dialogBox.show).toHaveBeenCalledWith('', '次', undefined)
      // Emotion だけのイベントも完了する
      runner.destroy()
      runner.run([emo('主人公', 'びっくり')], onComplete)
      expect(onComplete).toHaveBeenCalledOnce()
      expect(runner.isRunning).toBe(false)
    })

    it('ホストが例外を投げても実行は止まらない', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const host = {
        showEmotion: vi.fn(() => {
          throw new Error('boom')
        }),
      }
      const r = new EventRunner(dialogBox, npcMover, undefined, host)
      r.run([emo('主人公', 'びっくり'), { type: 'Narration', text: ['次'] }])
      expect(dialogBox.show).toHaveBeenCalledWith('', '次', undefined)
      warn.mockRestore()
    })
  })
  describe('SceneMove (#1072)', () => {
    const move = (
      scene: string,
      x?: number,
      y?: number,
      direction?: 'Up' | 'Down' | 'Left' | 'Right'
    ): EventCommand =>
      ({
        type: 'SceneMove',
        scene,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(direction !== undefined ? { direction } : {}),
      }) as EventCommand
    const narr = (t: string): EventCommand => ({ type: 'Narration', text: [t] })
    /** resolve / reject を外から握れる moveScene */
    function deferredHost() {
      let resolve!: () => void
      let reject!: (e: unknown) => void
      const moveScene = vi.fn(
        () =>
          new Promise<void>((res, rej) => {
            resolve = res
            reject = rej
          })
      )
      return { moveScene, resolve: () => resolve(), reject: (e: unknown) => reject(e) }
    }
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }

    it('ホストが無いときは警告ちょうど 1 件で次へ進む', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      runner.run([move('本堂', 1, 2), narr('次')])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(dialogBox.show).toHaveBeenCalledWith('', '次', undefined)
      warn.mockRestore()
    })

    it('moveScene が引数どおり (scene, x, y, direction) で呼ばれる', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const host = deferredHost()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, host)
      r.run([move('本堂', 400, 700, 'Up')])
      expect(host.moveScene).toHaveBeenCalledTimes(1)
      expect(host.moveScene).toHaveBeenCalledWith('本堂', 400, 700, 'Up')
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('x,y・向きが無ければ undefined で渡る', () => {
      const host = deferredHost()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, host)
      r.run([move('本堂')])
      expect(host.moveScene).toHaveBeenCalledWith('本堂', undefined, undefined, undefined)
    })

    it('resolve までキューが止まり、resolve 後に次が進む', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const host = deferredHost()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, host)
      r.run([move('本堂', 1, 2), narr('次')])
      await flush()
      expect(dialogBox.show).not.toHaveBeenCalled()
      expect(r.isRunning).toBe(true)
      host.resolve()
      await flush()
      expect(dialogBox.show).toHaveBeenCalledWith('', '次', undefined)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('reject でも警告ちょうど 1 件で次へ進む', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const host = deferredHost()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, host)
      r.run([move('本堂', 1, 2), narr('次')])
      host.reject(new Error('boom'))
      await flush()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(dialogBox.show).toHaveBeenCalledWith('', '次', undefined)
      warn.mockRestore()
    })

    it('待機中に destroy したら、後の resolve で step は走らない', async () => {
      const host = deferredHost()
      const onComplete = vi.fn()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, host)
      r.run([move('本堂', 1, 2), narr('次')], onComplete)
      r.destroy()
      host.resolve()
      await flush()
      expect(dialogBox.show).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
      expect(r.isRunning).toBe(false)
    })

    it('待機中に次の run が入ったら、古い resolve では新しい run が進まない', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const first = deferredHost()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, first)
      r.run([move('本堂', 1, 2), narr('古い次')])
      // 新しい run は Dialog で待つ
      r.run([{ type: 'Dialog', character: 'A', text: ['新'] }])
      expect(dialogBox.show).toHaveBeenCalledTimes(1)
      first.resolve()
      await flush()
      expect(dialogBox.show).toHaveBeenCalledTimes(1)
      expect(dialogBox.show).toHaveBeenCalledWith('A', '新', undefined)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('Dialog → SceneMove → Dialog の順に進む', async () => {
      const host = deferredHost()
      const r = new EventRunner(dialogBox, npcMover, undefined, undefined, host)
      r.run([
        { type: 'Dialog', character: 'A', text: ['前'] },
        move('本堂', 1, 2),
        { type: 'Dialog', character: 'A', text: ['後'] },
      ])
      expect(dialogBox.show).toHaveBeenCalledTimes(1)
      expect(host.moveScene).not.toHaveBeenCalled()
      ;(dialogBox as unknown as { isShowing: boolean }).isShowing = true
      r.advance()
      expect(host.moveScene).toHaveBeenCalledTimes(1)
      expect(dialogBox.show).toHaveBeenCalledTimes(1)
      host.resolve()
      await flush()
      expect(dialogBox.show).toHaveBeenCalledTimes(2)
      expect(dialogBox.show).toHaveBeenLastCalledWith('A', '後', undefined)
    })
  })
})
