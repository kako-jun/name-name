import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  Settings,
  __resetMemoryStoreForTest,
  clampSettings,
  loadSettings,
  makeDebouncedSaveSettings,
  saveSettings,
} from './settings'

const STORAGE_KEY = 'name-name:settings'

beforeEach(() => {
  localStorage.clear()
  __resetMemoryStoreForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('settings', () => {
  it('loadSettings は localStorage が空ならデフォルトを返す', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('save → load の round-trip で値が保持される', () => {
    const s: Settings = {
      msPerChar: 10,
      bgmVolume: 0.5,
      seVolume: 0.3,
      voiceVolume: 0.6,
      autoWaitMs: 3000,
    }
    saveSettings(s)
    expect(loadSettings()).toEqual(s)
  })

  it('保存された JSON に欠落キーがあるとデフォルトでマージされる', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ msPerChar: 100 }))
    const loaded = loadSettings()
    expect(loaded.msPerChar).toBe(100)
    expect(loaded.bgmVolume).toBe(DEFAULT_SETTINGS.bgmVolume)
    expect(loaded.seVolume).toBe(DEFAULT_SETTINGS.seVolume)
    expect(loaded.voiceVolume).toBe(DEFAULT_SETTINGS.voiceVolume)
    expect(loaded.autoWaitMs).toBe(DEFAULT_SETTINGS.autoWaitMs)
  })

  it('不正な JSON → DEFAULT_SETTINGS を返す', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('null / 配列 / プリミティブな JSON → DEFAULT_SETTINGS を返す', () => {
    localStorage.setItem(STORAGE_KEY, 'null')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    localStorage.setItem(STORAGE_KEY, '42')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('clampSettings は msPerChar を 0..500 に丸める', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, msPerChar: -10 }).msPerChar).toBe(0)
    expect(clampSettings({ ...DEFAULT_SETTINGS, msPerChar: 9999 }).msPerChar).toBe(500)
    expect(clampSettings({ ...DEFAULT_SETTINGS, msPerChar: 0 }).msPerChar).toBe(0)
    expect(clampSettings({ ...DEFAULT_SETTINGS, msPerChar: 500 }).msPerChar).toBe(500)
  })

  it('clampSettings は volume を 0..1 に丸める', () => {
    const c = clampSettings({
      ...DEFAULT_SETTINGS,
      bgmVolume: -0.5,
      seVolume: 2,
      voiceVolume: 1.5,
    })
    expect(c.bgmVolume).toBe(0)
    expect(c.seVolume).toBe(1)
    expect(c.voiceVolume).toBe(1)
  })

  it('clampSettings は autoWaitMs を 500..10000 に丸める', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, autoWaitMs: 100 }).autoWaitMs).toBe(500)
    expect(clampSettings({ ...DEFAULT_SETTINGS, autoWaitMs: 99999 }).autoWaitMs).toBe(10000)
    expect(clampSettings({ ...DEFAULT_SETTINGS, autoWaitMs: 2500 }).autoWaitMs).toBe(2500)
  })

  it('clampSettings は NaN / Infinity / 非数値をデフォルトに置換する', () => {
    const c = clampSettings({
      msPerChar: NaN,
      bgmVolume: Infinity,
      seVolume: -Infinity,
      // @ts-expect-error - テスト目的で型を破る
      voiceVolume: 'bad',
      autoWaitMs: NaN,
    })
    expect(c.msPerChar).toBe(DEFAULT_SETTINGS.msPerChar)
    // Infinity は範囲外として max にクランプされる
    expect(c.bgmVolume).toBe(1)
    expect(c.seVolume).toBe(0)
    expect(c.voiceVolume).toBe(DEFAULT_SETTINGS.voiceVolume)
    expect(c.autoWaitMs).toBe(DEFAULT_SETTINGS.autoWaitMs)
  })

  it('saveSettings は範囲外の値を clamp してから保存する', () => {
    saveSettings({
      msPerChar: 9999,
      bgmVolume: 5,
      seVolume: -1,
      voiceVolume: 0.5,
      autoWaitMs: 50,
    })
    const loaded = loadSettings()
    expect(loaded.msPerChar).toBe(500)
    expect(loaded.bgmVolume).toBe(1)
    expect(loaded.seVolume).toBe(0)
    expect(loaded.voiceVolume).toBe(0.5)
    expect(loaded.autoWaitMs).toBe(500)
  })

  it('localStorage.setItem が例外を投げても save → load が破綻しない (in-memory フォールバック)', () => {
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    const s: Settings = {
      msPerChar: 50,
      bgmVolume: 0.4,
      seVolume: 0.4,
      voiceVolume: 0.4,
      autoWaitMs: 4000,
    }
    expect(() => saveSettings(s)).not.toThrow()
    // setItem は呼ばれた（が throw される）→ in-memory にフォールバック
    expect(setSpy).toHaveBeenCalled()
    expect(loadSettings()).toEqual(s)
    expect(getSpy).toHaveBeenCalled()
  })
})

describe('makeDebouncedSaveSettings (review #155 should-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('連続呼び出しは debounce され、最後の値だけ保存される', () => {
    const { save } = makeDebouncedSaveSettings(100)
    const s1: Settings = { ...DEFAULT_SETTINGS, msPerChar: 10 }
    const s2: Settings = { ...DEFAULT_SETTINGS, msPerChar: 50 }
    const s3: Settings = { ...DEFAULT_SETTINGS, msPerChar: 99 }

    save(s1)
    save(s2)
    save(s3)
    // wait 経過前は保存されていない
    expect(loadSettings().msPerChar).toBe(DEFAULT_SETTINGS.msPerChar)

    vi.advanceTimersByTime(100)
    expect(loadSettings().msPerChar).toBe(99)
  })

  it('flush で即時保存できる', () => {
    const { save, flush } = makeDebouncedSaveSettings(500)
    save({ ...DEFAULT_SETTINGS, bgmVolume: 0.42 })
    expect(loadSettings().bgmVolume).toBe(DEFAULT_SETTINGS.bgmVolume)
    flush()
    expect(loadSettings().bgmVolume).toBe(0.42)
  })

  it('cancel で pending 保存を破棄できる', () => {
    const { save, cancel } = makeDebouncedSaveSettings(100)
    save({ ...DEFAULT_SETTINGS, seVolume: 0.11 })
    cancel()
    vi.advanceTimersByTime(500)
    expect(loadSettings().seVolume).toBe(DEFAULT_SETTINGS.seVolume)
  })

  it('独立した debouncer は state を共有しない', () => {
    const a = makeDebouncedSaveSettings(100)
    const b = makeDebouncedSaveSettings(100)
    a.save({ ...DEFAULT_SETTINGS, msPerChar: 10 })
    b.save({ ...DEFAULT_SETTINGS, msPerChar: 20 })
    vi.advanceTimersByTime(100)
    // 後勝ち (どちらも localStorage に書くので、最後の write が残る)
    expect(loadSettings().msPerChar).toBe(20)
  })
})
