/**
 * 既読 display index の localStorage 永続化ストア
 *
 * Issue #140: スキップモード + 既読フラグ永続化
 *
 * - キー: `name-name:read-progress:<docKey>`
 * - 値: JSON 配列（既読の display index 一覧）
 * - display index は computeDisplayIndex() が返す 1-based のテキストイベント番号
 */

const STORAGE_PREFIX = 'name-name:read-progress:'

/**
 * 指定 docKey の既読 display index セットを読み込む。
 * localStorage が使えない場合は空セットを返す。
 */
export function loadReadProgress(docKey: string): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + docKey)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((v) => typeof v === 'number'))
  } catch {
    return new Set()
  }
}

/**
 * 指定 docKey の既読 display index セットを保存する。
 * localStorage が使えない場合は無視する。
 */
export function saveReadProgress(docKey: string, progress: Set<number>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + docKey, JSON.stringify(Array.from(progress)))
  } catch {
    // quota exceeded 等は無視
  }
}

/**
 * 指定 docKey の display index を既読にマークし、保存する。
 * progress セットを直接変更する（in-place mutation）。
 */
export function markRead(docKey: string, progress: Set<number>, displayIndex: number): void {
  if (progress.has(displayIndex)) return
  progress.add(displayIndex)
  saveReadProgress(docKey, progress)
}

/**
 * 指定 display index が既読かどうかを返す。
 */
export function isRead(progress: Set<number>, displayIndex: number): boolean {
  return progress.has(displayIndex)
}

/** テスト用: localStorage をリセットする */
export function __resetReadProgressForTest(docKey: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + docKey)
  } catch {
    // ignore
  }
}
