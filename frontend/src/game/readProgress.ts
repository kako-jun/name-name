/**
 * 既読進捗の localStorage 永続化ストア
 *
 * Issue #140: スキップモード + 既読フラグ永続化
 *
 * - キー: `name-name:read-progress:<docKey>`（旧 display index）
 * - キー: `name-name:read-lines:<docKey>`（sceneId + display index）
 * - キー: `name-name:read-scenes:<docKey>`（sceneId）
 * - 値: JSON 配列
 * - display index は computeDisplayIndex() が返す 1-based のテキストイベント番号
 * - sceneId は MD の読み込み順や読み込み数に依存しない安定キーとして扱う
 */

const STORAGE_PREFIX = 'name-name:read-progress:'
const LINE_STORAGE_PREFIX = 'name-name:read-lines:'
const SCENE_STORAGE_PREFIX = 'name-name:read-scenes:'

function loadStringSet(prefix: string, docKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(prefix + docKey)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((v) => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function saveStringSet(prefix: string, docKey: string, progress: Set<string>): void {
  try {
    localStorage.setItem(prefix + docKey, JSON.stringify(Array.from(progress)))
  } catch {
    // quota exceeded 等は無視
  }
}

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

export function makeReadLineKey(sceneId: string, displayIndex: number): string {
  return `${sceneId}#${displayIndex}`
}

export function loadReadLineProgress(docKey: string): Set<string> {
  return loadStringSet(LINE_STORAGE_PREFIX, docKey)
}

export function markReadLine(docKey: string, progress: Set<string>, key: string): void {
  if (progress.has(key)) return
  progress.add(key)
  saveStringSet(LINE_STORAGE_PREFIX, docKey, progress)
}

export function isLineRead(progress: Set<string>, key: string): boolean {
  return progress.has(key)
}

/**
 * sceneId がある行の既読判定。
 *
 * sceneId がある場面では旧 display index を直接 fallback しない。旧形式は
 * migrateLegacyReadProgressForScene() で最初に遭遇した scene へ一括移行してから使う。
 */
export function isReadForLine(
  displayProgress: Set<number>,
  lineProgress: Set<string>,
  sceneId: string | null,
  displayIndex: number
): boolean {
  if (!sceneId) return isRead(displayProgress, displayIndex)
  return isLineRead(lineProgress, makeReadLineKey(sceneId, displayIndex))
}

/**
 * 旧 display index だけを持つ既存ユーザー向けの best-effort 移行。
 *
 * 旧形式は scene 情報を持たないため完全な復元はできない。そこで read-lines がまだ空の時だけ、
 * 現在最初に遭遇した scene に旧 display index を割り当てる。以後は scene-aware な
 * read-lines を正本にし、別 scene の同じ displayIndex へ誤爆させない。
 */
export function migrateLegacyReadProgressForScene(
  docKey: string,
  displayProgress: Set<number>,
  lineProgress: Set<string>,
  sceneId: string
): void {
  if (lineProgress.size > 0 || displayProgress.size === 0) return
  for (const displayIndex of displayProgress) {
    lineProgress.add(makeReadLineKey(sceneId, displayIndex))
  }
  saveStringSet(LINE_STORAGE_PREFIX, docKey, lineProgress)
}

export function loadReadSceneProgress(docKey: string): Set<string> {
  return loadStringSet(SCENE_STORAGE_PREFIX, docKey)
}

export function markReadScene(docKey: string, progress: Set<string>, sceneId: string): void {
  if (progress.has(sceneId)) return
  progress.add(sceneId)
  saveStringSet(SCENE_STORAGE_PREFIX, docKey, progress)
}

export function isSceneRead(progress: Set<string>, sceneId: string): boolean {
  return progress.has(sceneId)
}

export function hasAnyReadProgress(docKey: string): boolean {
  return (
    loadReadProgress(docKey).size > 0 ||
    loadReadLineProgress(docKey).size > 0 ||
    loadReadSceneProgress(docKey).size > 0
  )
}

/**
 * 指定 docKey の既読データを全消去する。
 * タイトル画面の「新規開始」など、進捗リセット時に呼ぶ (#141)。
 */
export function clearReadProgress(docKey: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + docKey)
    localStorage.removeItem(LINE_STORAGE_PREFIX + docKey)
    localStorage.removeItem(SCENE_STORAGE_PREFIX + docKey)
  } catch {
    // ignore
  }
}

/** テスト用: localStorage をリセットする（clearReadProgress の薄いラッパー） */
export function __resetReadProgressForTest(docKey: string): void {
  clearReadProgress(docKey)
}
