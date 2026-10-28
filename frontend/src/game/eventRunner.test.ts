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
})
