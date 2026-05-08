/**
 * 設定の永続化（localStorage）と clamp ユーティリティ
 *
 * Issue #138: 設定画面（テキスト速度 / 音量 / オート wait time）
 *
 * - localStorage 'name-name:settings' に JSON 保存
 * - 欠落キーは DEFAULT_SETTINGS で補完（前方互換）
 * - 範囲外は clamp（msPerChar 0..500、各音量 0..1、autoWaitMs 500..10000）
 * - localStorage 未対応 / 例外時は in-memory フォールバック
 */

export interface Settings {
  /** 1 文字あたり ms。0 = 瞬間表示。UI レンジは 0..200 だが clamp 上限は 500 */
  msPerChar: number
  /** 0..1 */
  bgmVolume: number
  /** 0..1 */
  seVolume: number
  /** 0..1（#144 ボイス用、現在は保存だけ） */
  voiceVolume: number
  /** 1000..8000 想定（#139 オート用、保存だけ）。clamp は 500..10000 */
  autoWaitMs: number
}

export const DEFAULT_SETTINGS: Settings = {
  msPerChar: 30,
  bgmVolume: 0.7,
  seVolume: 0.8,
  voiceVolume: 0.8,
  autoWaitMs: 2500,
}

const STORAGE_KEY = 'name-name:settings'

/**
 * 範囲を [min, max] に丸める。
 * - 非数値 / NaN → fallback
 * - Infinity → max、-Infinity → min（範囲外なので素直にクランプ）
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * 設定値を許容範囲に clamp する。
 * - msPerChar: 0..500
 * - bgmVolume / seVolume / voiceVolume: 0..1
 * - autoWaitMs: 500..10000
 */
export function clampSettings(s: Settings): Settings {
  return {
    msPerChar: clampNumber(s.msPerChar, 0, 500, DEFAULT_SETTINGS.msPerChar),
    bgmVolume: clampNumber(s.bgmVolume, 0, 1, DEFAULT_SETTINGS.bgmVolume),
    seVolume: clampNumber(s.seVolume, 0, 1, DEFAULT_SETTINGS.seVolume),
    voiceVolume: clampNumber(s.voiceVolume, 0, 1, DEFAULT_SETTINGS.voiceVolume),
    autoWaitMs: clampNumber(s.autoWaitMs, 500, 10000, DEFAULT_SETTINGS.autoWaitMs),
  }
}

// localStorage 未対応 / 例外時のフォールバック
let memoryStore: string | null = null

function safeGetItem(): string | null {
  try {
    if (typeof localStorage === 'undefined') return memoryStore
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return memoryStore
  }
}

function safeSetItem(value: string): void {
  memoryStore = value
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // memoryStore に既に書いたので何もしない
  }
}

/**
 * localStorage から設定を読む。欠落キー / 不正 JSON はデフォルトで補完。
 */
export function loadSettings(): Settings {
  const raw = safeGetItem()
  if (!raw) return { ...DEFAULT_SETTINGS }

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...(parsed as Partial<Settings>),
    }
    return clampSettings(merged)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 設定を localStorage に保存する。clamp してから保存。
 */
export function saveSettings(s: Settings): void {
  const clamped = clampSettings(s)
  safeSetItem(JSON.stringify(clamped))
}

/** テスト用: in-memory フォールバックをリセット */
export function __resetMemoryStoreForTest(): void {
  memoryStore = null
}
