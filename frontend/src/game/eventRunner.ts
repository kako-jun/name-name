/**
 * RPG イベント実行エンジン (#197)
 *
 * EventCommand のキューを順に実行する。
 * DialogBox への委譲・NPC 移動・Wait を担当。
 * TopDownRenderer から呼ばれ、実行中は inputLocked = true を維持する。
 */
import type { EventCommand } from '../types'
import type { DialogBox } from './DialogBox'
import type { BattleResult } from './loot'

export interface NpcMover {
  /** NPC を指定タイルへアニメ移動させる。完了したら resolve する Promise を返す */
  moveNpcTo(npcName: string, x: number, y: number, speed: number): Promise<void>
}

/**
 * 脚本制御の戦闘 (`[戦闘: id]`、#741) を使うためのホスト側の口。渡さない（または `startBattle` が無い）ときの `Battle` コマンドは警告して飛ばす。
 * `次=` の分岐に使う `findEvent` は、`[イベント <name>]` のコマンド列を返す（無ければ undefined）
 */
export interface EventBattleHost {
  /** `[戦闘 id]` の戦闘を始め、終わったら結果で解決する。始められなかった（宣言が無い・敵が組めない・すでに戦闘中）は null */
  startBattle(id: string): Promise<BattleResult | null>
  findEvent?(name: string): EventCommand[] | undefined
}

/** `次=` の分岐の連鎖の上限（イベント → 戦闘 → 次のイベント → 戦闘 … が際限なく続くのを止める安全弁） */
export const MAX_BATTLE_BRANCH_DEPTH = 32

export class EventRunner {
  private queue: EventCommand[] = []
  private running = false
  private dialogBox: DialogBox
  private npcMover: NpcMover
  private onComplete: (() => void) | undefined
  private battleHost: EventBattleHost | undefined
  /** `run` ごとに進める世代。戦闘の待ちの間に `destroy` / 次の `run` があったら、古い待ちの続きを捨てる */
  private generation = 0
  private branchDepth = 0

  constructor(dialogBox: DialogBox, npcMover: NpcMover, battleHost?: EventBattleHost) {
    this.dialogBox = dialogBox
    this.npcMover = npcMover
    this.battleHost = battleHost
  }

  get isRunning(): boolean {
    return this.running
  }

  /** イベントコマンド列を実行開始する */
  run(commands: EventCommand[], onComplete?: () => void): void {
    this.queue = [...commands]
    this.running = true
    this.onComplete = onComplete
    this.generation++
    this.branchDepth = 0
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
      this.npcMover.moveNpcTo(cmd.npc, cmd.x, cmd.y, cmd.speed ?? 3).then(() => {
        if (this.running) this.step()
      })
      return
    }

    if (cmd.type === 'Wait') {
      setTimeout(() => {
        if (this.running) this.step()
      }, cmd.ms)
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

    if (cmd.type === 'Battle') {
      this.runBattle(cmd.id)
      return
    }

    // 未知のコマンドはスキップ
    this.step()
  }

  /**
   * `[戦闘: id]` (#741)。戦闘が終わるまでキューを止め、結果の `次=` があればそのイベントへ分岐する
   * （現在のイベントの残りは捨てる。負けイベントの後に勝った前提の台詞が続かないように）。無ければ残りを続ける。
   * 始められなかった（null）・ホストが無いときは警告して次へ進む
   */
  private runBattle(id: string): void {
    const host = this.battleHost
    if (!host) {
      console.warn(`[EventRunner] 戦闘 '${id}' を始められない（ホストが戦闘に対応していない）`)
      this.step()
      return
    }
    const gen = this.generation
    host.startBattle(id).then(
      (result) => {
        if (gen !== this.generation || !this.running) return
        const next = result?.script?.next
        if (next !== undefined && next !== '') {
          const commands = host.findEvent?.(next)
          if (!commands) {
            console.warn(`[EventRunner] 戦闘 '${id}' の次=${next} のイベントが無い（残りを続ける）`)
          } else if (this.branchDepth >= MAX_BATTLE_BRANCH_DEPTH) {
            console.warn(
              `[EventRunner] 次=${next} の分岐が ${MAX_BATTLE_BRANCH_DEPTH} 回を超えた（止める）`
            )
            this.queue = []
          } else {
            this.branchDepth++
            this.queue = [...commands]
          }
        }
        this.step()
      },
      (e: unknown) => {
        console.warn(`[EventRunner] 戦闘 '${id}' で例外`, e)
        if (gen === this.generation && this.running) this.step()
      }
    )
  }

  destroy(): void {
    this.queue = []
    this.running = false
    this.onComplete = undefined
    this.generation++
  }
}
