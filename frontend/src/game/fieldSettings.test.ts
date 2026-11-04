/** 「せってい」の値 → 実際の挙動への変換 (#880 / fieldSettings.ts) のテスト */
import { describe, expect, it } from 'vitest'
import {
  BATTLE_SPEED_FACTORS,
  MESSAGE_MS_FACTORS,
  battleModeOf,
  battleSpeedFactor,
  buildConfigOptions,
  cursorMemoryOn,
  messageMsPerChar,
  normalizeSettings,
  settingIndex,
  volumeOf,
} from './fieldSettings'
import { DEFAULT_CONFIG_OPTIONS } from './fieldMenuScreens'

describe('settingIndex', () => {
  it('値があればそれ、無い・範囲外・非整数・非数は既定（initial）', () => {
    expect(settingIndex({ battleSpeed: 4 }, 'battleSpeed')).toBe(4)
    expect(settingIndex({}, 'battleSpeed')).toBe(2)
    expect(settingIndex({ battleSpeed: 5 }, 'battleSpeed')).toBe(2)
    expect(settingIndex({ battleSpeed: -1 }, 'battleSpeed')).toBe(2)
    expect(settingIndex({ battleSpeed: 1.5 }, 'battleSpeed')).toBe(2)
    expect(settingIndex({ battleSpeed: NaN }, 'battleSpeed')).toBe(2)
    expect(settingIndex({}, 'unknown')).toBe(0)
  })
})

describe('battleModeOf', () => {
  it('値があれば優先、無ければゲーム設定のモード', () => {
    expect(battleModeOf({ battleMode: 0 }, 'active')).toBe('wait')
    expect(battleModeOf({ battleMode: 1 }, 'wait')).toBe('active')
    expect(battleModeOf({}, 'active')).toBe('active')
    expect(battleModeOf({ battleMode: 9 }, 'wait')).toBe('wait')
  })
})

describe('battleSpeedFactor', () => {
  it('3（既定）が等倍で、番号が大きいほど速い（単調増加）', () => {
    expect(battleSpeedFactor({})).toBe(1)
    const f = [0, 1, 2, 3, 4].map((i) => battleSpeedFactor({ battleSpeed: i }))
    expect(f).toEqual([...BATTLE_SPEED_FACTORS])
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1])
  })
})

describe('messageMsPerChar', () => {
  it('既定のままで窓の指定も無ければ undefined（何もしない）', () => {
    expect(messageMsPerChar(undefined, {}, 30)).toBeUndefined()
  })
  it('既定のままでも窓の指定（base）があればそのまま', () => {
    expect(messageMsPerChar(40, {}, 30)).toBe(40)
  })
  it('番号が大きいほど速い（ms は小さい）。base 未指定は窓の既定から。等倍の 3 は変更なし', () => {
    const ms = [0, 1, 2, 3, 4].map((i) => messageMsPerChar(undefined, { messageSpeed: i }, 30))
    expect(ms[2]).toBeUndefined()
    expect(ms[0]).toBe(60)
    expect(ms[1]).toBe(45)
    expect(ms[3]).toBe(18)
    expect(ms[4]).toBe(8)
    expect(ms[0]!).toBeGreaterThan(ms[1]!)
    expect(ms[1]!).toBeGreaterThan(ms[3]!)
    expect(ms[3]!).toBeGreaterThan(ms[4]!)
    expect(MESSAGE_MS_FACTORS[2]).toBe(1)
  })
  it('0（即時表示）は倍率に関係なく 0。最小は 1ms', () => {
    expect(messageMsPerChar(0, { messageSpeed: 0 }, 30)).toBe(0)
    expect(messageMsPerChar(1, { messageSpeed: 4 }, 30)).toBe(1)
  })
})

describe('cursorMemoryOn / volumeOf', () => {
  it('カーソルは既定がメモリ、1 でリセット', () => {
    expect(cursorMemoryOn({})).toBe(true)
    expect(cursorMemoryOn({ cursor: 0 })).toBe(true)
    expect(cursorMemoryOn({ cursor: 1 })).toBe(false)
  })
  it('音量は index / 5。既定は 0.8、0 で無音、5 で最大', () => {
    expect(volumeOf({}, 'bgm')).toBeCloseTo(0.8)
    expect(volumeOf({ se: 0 }, 'se')).toBe(0)
    expect(volumeOf({ se: 5 }, 'se')).toBe(1)
  })
})

describe('normalizeSettings', () => {
  it('既知のキーで範囲内の整数だけ残す', () => {
    expect(
      normalizeSettings({ battleMode: 1, battleSpeed: 9, cursor: 1.5, nope: 1, keys: 1, bgm: 5 })
    ).toEqual({ battleMode: 1, keys: 1, bgm: 5 })
  })
  it('オブジェクトでない入力は空', () => {
    for (const v of [undefined, null, 3, 'x', []]) expect(normalizeSettings(v)).toEqual({})
  })
  it('__proto__ などを持ち込まない', () => {
    const raw = JSON.parse('{"__proto__":{"battleMode":1},"battleMode":1}')
    const out = normalizeSettings(raw)
    expect(out).toEqual({ battleMode: 1 })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})

describe('buildConfigOptions', () => {
  it('既定と同じキー・順序で、すべてに説明が付く', () => {
    const o = buildConfigOptions({ atb: true, audio: false }, 'wait')
    expect(o.map((x) => x.key)).toEqual(DEFAULT_CONFIG_OPTIONS.map((x) => x.key))
    for (const x of o) expect(x.description).toBeTruthy()
  })
  it('ターン制では バトルモード・スピードに「効きません」、ATB では効く旨', () => {
    const turn = buildConfigOptions({ atb: false, audio: false }, 'wait')
    expect(turn.find((x) => x.key === 'battleMode')?.description).toContain('ターン制')
    expect(turn.find((x) => x.key === 'battleSpeed')?.description).toContain('ターン制')
    const atb = buildConfigOptions({ atb: true, audio: false }, 'wait')
    expect(atb.find((x) => x.key === 'battleMode')?.description).not.toContain('効きません')
  })
  it('音の再生が無いと BGM / SE に「効きません」。あれば出さない', () => {
    const no = buildConfigOptions({ atb: true, audio: false }, 'wait')
    expect(no.find((x) => x.key === 'bgm')?.description).toContain('効きません')
    const yes = buildConfigOptions({ atb: true, audio: true }, 'wait')
    expect(yes.find((x) => x.key === 'bgm')?.description).not.toContain('効きません')
  })
  it('バトルモードの初期位置はゲーム設定の ATB に合わせる。既定の定数は汚さない', () => {
    expect(
      buildConfigOptions({ atb: true, audio: false }, 'active').find((x) => x.key === 'battleMode')
        ?.initial
    ).toBe(1)
    expect(
      buildConfigOptions({ atb: true, audio: false }, 'wait').find((x) => x.key === 'battleMode')
        ?.initial
    ).toBe(0)
    const o = buildConfigOptions({ atb: true, audio: false }, 'wait')
    o[0].choices.push('Z')
    expect(DEFAULT_CONFIG_OPTIONS[0].choices).toHaveLength(2)
  })
})
