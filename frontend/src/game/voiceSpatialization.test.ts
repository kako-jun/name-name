import { describe, expect, it } from 'vitest'
import {
  resolveVoiceSpatialization,
  VOICE_DISTANCE_MAX_LOWPASS_HZ,
  VOICE_DISTANCE_MIN_LOWPASS_HZ,
  VOICE_DISTANCE_REFERENCE_DEPTH,
} from './voiceSpatialization'

describe('resolveVoiceSpatialization (#696)', () => {
  it('Novel モードは位置・奥行きにかかわらず空間化しない', () => {
    expect(resolveVoiceSpatialization('Novel', 1, 100)).toBeNull()
  })

  it('シアターモードでは x 比率を左右パンへ変換する', () => {
    expect(resolveVoiceSpatialization('Theater', 0, 0)?.pan).toBe(-1)
    expect(resolveVoiceSpatialization('Theater', 0.5, 0)?.pan).toBe(0)
    expect(resolveVoiceSpatialization('Theater', 1, 0)?.pan).toBe(1)
  })

  it('基準奥行きでは半分の音量と距離ローパスを適用する', () => {
    const result = resolveVoiceSpatialization('Theater', 0.5, VOICE_DISTANCE_REFERENCE_DEPTH)
    expect(result?.gain).toBe(0.5)
    expect(result?.lowpassHz).toBe(VOICE_DISTANCE_MAX_LOWPASS_HZ / 2)
  })

  it('不正な比率・負の奥行きは中央・最前面へクランプする', () => {
    expect(resolveVoiceSpatialization('Theater', Number.NaN, -1)).toEqual({
      pan: 0,
      gain: 1,
      lowpassHz: VOICE_DISTANCE_MAX_LOWPASS_HZ,
    })
  })

  it('非常に深い奥行きでもローパス周波数は下限を下回らない', () => {
    expect(resolveVoiceSpatialization('Theater', 0.5, Number.MAX_VALUE)?.lowpassHz).toBe(
      VOICE_DISTANCE_MIN_LOWPASS_HZ
    )
  })
})
