/**
 * ゲームの状態を管理するクラス
 *
 * フラグストアを保持し、章またぎで引き継がれる。
 * NovelRenderer.setEvents() でリセットされない。
 */

import { Event, FlagValue } from '../types'

/**
 * ノベルゲームの全状態を表すスナップショット
 *
 * advance/goBack/seekTo/save/load の際にこのインターフェースで状態を取り回す。
 */
export interface NovelGameState {
  sceneId: string | null
  eventIndex: number
  textIndex: number
  flags: Record<string, FlagValue>
  backgroundPath: string | null
  isBlackout: boolean
  characters: Array<{ name: string; expression: string; position: string }>
  currentBgmPath: string | null
}

/**
 * Condition イベントをフラグに基づいて展開し、フラットなイベント配列を返す。
 *
 * - Condition が真 → 内部 events を再帰的に展開して挿入（Condition 自体は除去）
 * - Condition が偽 → スキップ
 * - Flag / その他のイベントはそのまま残す
 *
 * 元の events 配列は変更しない（不変）。
 */
export function resolveEvents(events: readonly Event[], gameState: GameState): Event[] {
  const result: Event[] = []
  for (const event of events) {
    if (typeof event === 'object' && event !== null && 'Condition' in event) {
      if (gameState.checkFlag(event.Condition.flag)) {
        // 条件が真 → 内部 events を再帰的に展開
        result.push(...resolveEvents(event.Condition.events, gameState))
      }
      // 偽ならスキップ
    } else {
      result.push(event)
    }
  }
  return result
}

export class GameState {
  private flags: Map<string, FlagValue> = new Map()

  /**
   * フラグを設定する
   */
  setFlag(name: string, value: FlagValue): void {
    this.flags.set(name, value)
  }

  /**
   * フラグの値を取得する（未設定なら undefined）
   */
  getFlag(name: string): FlagValue | undefined {
    return this.flags.get(name)
  }

  /**
   * フラグが「真」かどうかを判定する
   *
   * - Bool(true) → true
   * - Bool(false) → false
   * - それ以外の型（String, Number）→ 存在すれば true
   * - 未設定 → false
   */
  checkFlag(name: string): boolean {
    const value = this.flags.get(name)
    if (value === undefined) return false

    if ('Bool' in value) {
      return value.Bool
    }

    // String / Number は存在すれば true
    return true
  }

  /**
   * 全フラグをクリアする
   */
  clear(): void {
    this.flags.clear()
  }

  /**
   * フラグを Record として返す（シリアライズ用）
   */
  toJSON(): Record<string, FlagValue> {
    const obj: Record<string, FlagValue> = {}
    this.flags.forEach((value, key) => {
      obj[key] = value
    })
    return obj
  }

  /**
   * Record からフラグを復元する（デシリアライズ用）
   */
  fromJSON(data: Record<string, FlagValue>): void {
    this.flags.clear()
    for (const [key, value] of Object.entries(data)) {
      this.flags.set(key, value)
    }
  }
}
