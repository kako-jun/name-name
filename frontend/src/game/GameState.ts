/**
 * ゲームの状態を管理するクラス
 *
 * フラグストアを保持し、章またぎで引き継がれる。
 * NovelRenderer.setEvents() でリセットされない。
 */

import { FlagValue } from '../types'

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
