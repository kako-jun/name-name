/**
 * セーブデータの管理
 *
 * localStorage を使い、複数スロット（3つ）のセーブデータを管理する。
 * JSON エクスポート/インポートによるブラウザ間の持ち運びにも対応。
 */

import { FlagValue } from '../types'

const SLOT_COUNT = 3
const STORAGE_PREFIX = 'name-name-save-'

export interface SaveSlotData {
  slot: number
  sceneId: string | null
  eventIndex: number
  textIndex: number
  flags: Record<string, FlagValue>
  backgroundPath: string | null
  savedAt: string // ISO 8601
  sceneName: string | null
}

export class SaveManager {
  /**
   * 指定スロットにセーブデータを保存する
   */
  save(slot: number, data: SaveSlotData): void {
    if (slot < 0 || slot >= SLOT_COUNT) return
    const json = JSON.stringify(data)
    localStorage.setItem(`${STORAGE_PREFIX}${slot}`, json)
  }

  /**
   * 指定スロットからセーブデータを読み込む
   */
  load(slot: number): SaveSlotData | null {
    if (slot < 0 || slot >= SLOT_COUNT) return null
    const json = localStorage.getItem(`${STORAGE_PREFIX}${slot}`)
    if (!json) return null
    try {
      return JSON.parse(json) as SaveSlotData
    } catch {
      return null
    }
  }

  /**
   * 全スロットの状態一覧を返す（空スロットは null）
   */
  listSlots(): (SaveSlotData | null)[] {
    const result: (SaveSlotData | null)[] = []
    for (let i = 0; i < SLOT_COUNT; i++) {
      result.push(this.load(i))
    }
    return result
  }

  /**
   * 指定スロットを削除する
   */
  deleteSlot(slot: number): void {
    if (slot < 0 || slot >= SLOT_COUNT) return
    localStorage.removeItem(`${STORAGE_PREFIX}${slot}`)
  }

  /**
   * 全スロットを JSON 文字列でエクスポートする
   */
  exportJSON(): string {
    const data: (SaveSlotData | null)[] = this.listSlots()
    return JSON.stringify(data, null, 2)
  }

  /**
   * JSON 文字列から全スロットを復元する
   */
  importJSON(json: string): boolean {
    try {
      const data = JSON.parse(json) as (SaveSlotData | null)[]
      if (!Array.isArray(data)) return false
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (i < data.length && data[i] !== null && data[i] !== undefined) {
          this.save(i, data[i]!)
        } else {
          this.deleteSlot(i)
        }
      }
      return true
    } catch {
      return false
    }
  }
}
