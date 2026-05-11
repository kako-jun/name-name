/**
 * RPG イベント実行エンジン (#197)
 *
 * EventCommand のキューを順に実行する。
 * DialogBox への委譲・NPC 移動・Wait を担当。
 * TopDownRenderer から呼ばれ、実行中は inputLocked = true を維持する。
 */
import type { EventCommand } from '../types'
import type { DialogBox } from './DialogBox'

export interface NpcMover {
  /** NPC を指定タイルへアニメ移動させる。完了したら resolve する Promise を返す */
  moveNpcTo(npcName: string, x: number, y: number, speed: number): Promise<void>
}

export class EventRunner {
  private queue: EventCommand[] = []
  private running = false
  private dialogBox: DialogBox
  private npcMover: NpcMover
  private onComplete: (() => void) | undefined

  constructor(dialogBox: DialogBox, npcMover: NpcMover) {
    this.dialogBox = dialogBox
    this.npcMover = npcMover
  }

  get isRunning(): boolean {
    return this.running
  }

  /** イベントコマンド列を実行開始する */
  run(commands: EventCommand[], onComplete?: () => void): void {
    this.queue = [...commands]
    this.running = true
    this.onComplete = onComplete
    this.step()
  }

  /** 現在の Dialog を送る（Enter/タップ時に呼ぶ） */
  advance(): void {
    if (!this.running) return
    if (this.dialogBox.isTyping()) {
      this.dialogBox.skipTypewriter()
    } else if (this.dialogBox.isShowing) {
      this.dialogBox.hide()
      this.step()
    }
  }

  private step(): void {
    const cmd = this.queue.shift()
    if (!cmd) {
      this.running = false
      const cb = this.onComplete
      this.onComplete = undefined
      cb?.()
      return
    }

    if (cmd.type === 'NpcMove') {
      this.npcMover.moveNpcTo(cmd.npc, cmd.x, cmd.y, cmd.speed ?? 3).then(() => this.step())
      return
    }

    if (cmd.type === 'Wait') {
      setTimeout(() => this.step(), cmd.ms)
      return
    }

    if (cmd.type === 'Dialog') {
      const name = cmd.character ?? ''
      const text = cmd.text.join('\n')
      this.dialogBox.show(name, text, undefined)
      // advance() 呼び出し待ち（step は advance() で続く）
      return
    }

    if (cmd.type === 'Narration') {
      const text = cmd.text.join('\n')
      this.dialogBox.show('', text, undefined)
      // advance() 呼び出し待ち（step は advance() で続く）
      return
    }

    // 未知のコマンドはスキップ
    this.step()
  }

  destroy(): void {
    this.queue = []
    this.running = false
    this.onComplete = undefined
  }
}
