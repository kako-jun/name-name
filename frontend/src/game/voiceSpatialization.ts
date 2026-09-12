import type { CameraMode } from '../types'

/**
 * シアターモードの台詞ボイスに適用する、Web Audio API 非依存の空間パラメータ。
 *
 * position は既存の 0..1 の画面内 x 比率、depth は #694 と同じく 0 を最前面とする。
 * 距離の減衰は基準奥行き 10 で半分、ローパスは最小 1.2kHz で頭打ちにする。これにより
 * 深い舞台でも無音にならず、「遠くで少しくぐもる」演出として扱える。
 */
export interface VoiceSpatialization {
  /** StereoPannerNode の -1（左）〜1（右） */
  pan: number
  /** 距離による音量倍率 */
  gain: number
  /** BiquadFilterNode(lowpass) の遮断周波数 */
  lowpassHz: number
}

export const VOICE_DISTANCE_REFERENCE_DEPTH = 10
export const VOICE_DISTANCE_MIN_LOWPASS_HZ = 1200
export const VOICE_DISTANCE_MAX_LOWPASS_HZ = 20000

/**
 * シアターモードの Dialog だけに適用する空間パラメータを決定する。
 * Novel モードでは null を返し、従来のボイス再生グラフを一切変えない。
 */
export function resolveVoiceSpatialization(
  cameraMode: CameraMode,
  xRatio: number,
  depth: number
): VoiceSpatialization | null {
  if (cameraMode !== 'Theater') return null

  const x = Number.isFinite(xRatio) ? Math.min(1, Math.max(0, xRatio)) : 0.5
  const d = Number.isFinite(depth) ? Math.max(0, depth) : 0
  return {
    pan: x * 2 - 1,
    gain: 1 / (1 + d / VOICE_DISTANCE_REFERENCE_DEPTH),
    lowpassHz: Math.max(
      VOICE_DISTANCE_MIN_LOWPASS_HZ,
      VOICE_DISTANCE_MAX_LOWPASS_HZ / (1 + d / VOICE_DISTANCE_REFERENCE_DEPTH)
    ),
  }
}
