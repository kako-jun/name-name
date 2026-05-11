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
})
