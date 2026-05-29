/**
 * セーブデータの管理
 *
 * localStorage を使い、複数スロット（3つ）のセーブデータを管理する。
 * JSON エクスポート/インポートによるブラウザ間の持ち運びにも対応。
 * クイックセーブ（#142）は専用キーで通常スロットとは独立して保存する。
 */

import { FlagValue } from '../types'
import { BackgroundFade, VideoState } from './GameState'

const SLOT_COUNT = 3
const STORAGE_PREFIX = 'name-name-save-'
/** クイックセーブ専用ストレージキー (#142) */
const QUICK_SAVE_KEY = 'name-name-save-quick'

export interface SaveSlotData {
  slot: number
  sceneId: string | null
  eventIndex: number
  textIndex: number
  flags: Record<string, FlagValue>
  backgroundPath: string | null
  /**
   * 背景の端フェードマスク (#250)。
   * 後方互換: 古いセーブデータには無い → undefined/null はフェードなし扱い。
   */
  backgroundFade?: BackgroundFade | null
  /**
   * 動画入力レイヤ (#252)。
   * 後方互換: 古いセーブデータには無い → undefined/null は動画なし扱い。
   */
  video?: VideoState | null
  /** 暗転状態 */
  isBlackout: boolean
  /** 表示中のキャラクター情報 */
  characters: Array<{ name: string; expression: string; position: string }>
  /** 再生中の BGM パス */
  currentBgmPath: string | null
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
   * 全スロットを JSON 文字列でエクスポートする。
   * クイックセーブは一時的な作業メモとして扱うため、エクスポート対象に含めない。
   * ブラウザ間の持ち運びが目的のため、意図的に除外している。
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
      const data = JSON.parse(json)
      if (!Array.isArray(data)) return false
      // 各スロットの基本的な形状を検証
      for (let i = 0; i < SLOT_COUNT; i++) {
        const slot = i < data.length ? data[i] : null
        if (slot === null || slot === undefined) {
          this.deleteSlot(i)
        } else if (
          typeof slot === 'object' &&
          typeof slot.eventIndex === 'number' &&
          typeof slot.textIndex === 'number' &&
          typeof slot.savedAt === 'string' &&
          typeof slot.flags === 'object' &&
          typeof slot.isBlackout === 'boolean' &&
          Array.isArray(slot.characters)
        ) {
          this.save(i, slot as SaveSlotData)
        } else {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  // --- クイックセーブ (#142) ---

  /**
   * クイックセーブスロットに保存する。
   * 通常スロット（0〜2）とは独立したキーで保存するため、既存セーブと干渉しない。
   */
  quickSave(data: SaveSlotData): void {
    try {
      localStorage.setItem(QUICK_SAVE_KEY, JSON.stringify(data))
    } catch {
      // quota exceeded 等は無視
    }
  }

  /**
   * クイックセーブスロットからデータを読み込む。
   * データがない場合は null を返す。
   */
  quickLoad(): SaveSlotData | null {
    try {
      const json = localStorage.getItem(QUICK_SAVE_KEY)
      if (!json) return null
      return JSON.parse(json) as SaveSlotData
    } catch {
      return null
    }
  }

  /**
   * クイックセーブデータが存在するか返す。
   */
  hasQuickSave(): boolean {
    try {
      return localStorage.getItem(QUICK_SAVE_KEY) !== null
    } catch {
      return false
    }
  }

  /**
   * クイックセーブデータを消去する。
   */
  deleteQuickSave(): void {
    try {
      localStorage.removeItem(QUICK_SAVE_KEY)
    } catch {
      // ignore
    }
  }
}
