/**
 * 天候演出 (#706) の粒の時間→位置 純粋計算。
 *
 * 雨・雪・桜吹雪は物理演算をしない。粒ごとに固定シードの疑似乱数で決めた「初期位置・位相・速度の揺らぎ」を持ち、
 * 経過時間 `elapsedMs` だけを入力に位置・回転を出す（直線落下 + 周期的な左右の揺れ）。`Math.random` も時計も使わない
 * ので、同じ入力なら同じ値になる（スキップ・セーブ復元・シーク・動画書き出しでも同じフレームが出る。ADR 0002）。
 * 保存状態（`NovelGameState.weather`）は「種類＋強さ」だけで、粒の位置は持たない。
 *
 * 時計は `ambientEffects.ts`（ろうそく揺れ等）と同じ流儀で、描画側（`WeatherLayer`）が `TimeController.now()` から出した
 * 経過時間を渡す。ここは描画ライブラリに依存しない。
 */

import type { WeatherKind } from '../types'
import { mulberry32 } from './ambientEffects'

/** 強さ（粒の密度の倍率）の既定値・下限・上限。パーサ（Rust）と同じ値。 */
export const WEATHER_INTENSITY_DEFAULT = 1
export const WEATHER_INTENSITY_MIN = 0.1
export const WEATHER_INTENSITY_MAX = 3

/** 強さを範囲へ寄せる。非有限・0 以下は既定（1.0）、それ以外は 0.1〜3.0 にクランプ。 */
export function clampWeatherIntensity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return WEATHER_INTENSITY_DEFAULT
  }
  return Math.min(WEATHER_INTENSITY_MAX, Math.max(WEATHER_INTENSITY_MIN, value))
}

/** 強さ 1.0 のときの粒数。 */
export const WEATHER_BASE_COUNT: Record<WeatherKind, number> = {
  Rain: 90,
  Snow: 70,
  Sakura: 40,
}

/** 粒数の絶対上限（強さを上げても描画負荷が際限なく増えない）。 */
export const WEATHER_MAX_PARTICLES = 240

/** 種類と強さから粒数を決める（強さ 1.0 で数十〜百弱、上限 `WEATHER_MAX_PARTICLES`）。 */
export function weatherParticleCount(kind: WeatherKind, intensity: number): number {
  const n = Math.round(WEATHER_BASE_COUNT[kind] * clampWeatherIntensity(intensity))
  return Math.max(1, Math.min(WEATHER_MAX_PARTICLES, n))
}

/** 種類ごとの運動定数。距離は画面の幅/高さに対する割合、時間は秒。 */
interface KindMotion {
  /** 落下速度（画面の高さ/秒）の基準。粒ごとに ±speedJitter 倍の揺らぎ。 */
  fall: number
  speedJitter: number
  /** 横方向の一定の流れ（画面の幅/秒。負が左）。 */
  drift: number
  /** 左右の揺れの振幅（画面の幅に対する割合）と周波数（Hz）。 */
  swayAmp: number
  swayHz: number
  /** 回転速度（ラジアン/秒）。0 なら回転しない。 */
  spin: number
  /** 粒の大きさの基準倍率と揺らぎ（描画側が基準図形に掛ける）。 */
  size: number
  sizeJitter: number
  alpha: number
}

const MOTION: Record<WeatherKind, KindMotion> = {
  // 速い直線落下。揺れなし。ほんの少し斜め（drift）で、描画側は落下方向に線を傾ける。
  Rain: {
    fall: 1.4,
    speedJitter: 0.18,
    drift: -0.4,
    swayAmp: 0,
    swayHz: 0,
    spin: 0,
    size: 1,
    sizeJitter: 0.3,
    alpha: 0.55,
  },
  // ゆっくり落下 + 周期的な左右揺れ。
  Snow: {
    fall: 0.11,
    speedJitter: 0.4,
    drift: 0,
    swayAmp: 0.022,
    swayHz: 0.45,
    spin: 0,
    size: 1,
    sizeJitter: 0.5,
    alpha: 0.85,
  },
  // ゆっくり落下 + 大きめの揺れ + 回転 + 風に流される。
  Sakura: {
    fall: 0.085,
    speedJitter: 0.35,
    drift: -0.035,
    swayAmp: 0.06,
    swayHz: 0.3,
    spin: 1.4,
    size: 1,
    sizeJitter: 0.4,
    alpha: 0.9,
  },
}

/** 種類ごとの固定シード（粒の並びを種類で変える）。 */
const KIND_SEED: Record<WeatherKind, number> = { Rain: 1001, Snow: 2003, Sakura: 3001 }

/** 粒ごとの固定パラメータ（シードから決まり、時間に依存しない）。 */
export interface WeatherParticleParams {
  /** 横位置の初期値（0〜1、画面の幅に対する割合）。 */
  x0: number
  /** 縦位相の初期値（0〜1）。t=0 から画面全体に粒が散らばる。 */
  y0: number
  /** 落下速度の倍率。 */
  speedMul: number
  /** 揺れの位相（ラジアン）と周波数の倍率。 */
  swayPhase: number
  swayHzMul: number
  /** 回転の初期角（ラジアン）と回転方向（±1）。 */
  rot0: number
  spinDir: number
  /** 粒の大きさ倍率。 */
  size: number
}

/** 粒 `index` の固定パラメータを決める。`Math.random` は使わず、(kind, index) だけで決まる。 */
export function createWeatherParticleParams(
  kind: WeatherKind,
  index: number
): WeatherParticleParams {
  const m = MOTION[kind]
  const base = KIND_SEED[kind] * 100003 + index * 8191
  const r = (k: number) => mulberry32(base + k * 131)
  return {
    x0: r(1),
    y0: r(2),
    speedMul: 1 + (r(3) * 2 - 1) * m.speedJitter,
    swayPhase: r(4) * Math.PI * 2,
    swayHzMul: 0.75 + r(5) * 0.5,
    rot0: r(6) * Math.PI * 2,
    spinDir: r(7) < 0.5 ? -1 : 1,
    size: 1 + (r(8) * 2 - 1) * m.sizeJitter,
  }
}

/** 粒の描画に必要な値。 */
export interface WeatherParticleFrame {
  x: number
  y: number
  /** 描画の回転（ラジアン）。雨は落下方向に沿った傾き、桜は回転、雪は 0。 */
  rotation: number
  /** 基準図形に掛ける大きさ倍率。 */
  scale: number
  alpha: number
}

/** 粒がはみ出して見えなくなるまでの余白（px）。画面外で折り返すので端で急に出入りしない。 */
export const WEATHER_WRAP_MARGIN = 24

function positiveMod(v: number, m: number): number {
  return ((v % m) + m) % m
}

/**
 * 経過時間 `elapsedMs` での粒の位置などを `out` に書く（毎フレーム呼ぶので新規オブジェクトを作らない）。
 *
 * 入力契約: `elapsedMs` の非有限値/負値は 0 扱い。画面寸法の非有限値/0 以下は 0 扱い。
 * y は上端の外（-margin）から下端の外（H+margin）まで落ち、抜けたら上端へ戻る（周期的）。
 * x は初期位置 + 一定の流れ + 周期的な揺れ。左右も画面を回り込む。
 */
export function evaluateWeatherParticle(
  kind: WeatherKind,
  p: WeatherParticleParams,
  elapsedMs: number,
  width: number,
  height: number,
  out: WeatherParticleFrame
): WeatherParticleFrame {
  const m = MOTION[kind]
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs / 1000 : 0
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const h = Number.isFinite(height) && height > 0 ? height : 0
  const spanY = h + WEATHER_WRAP_MARGIN * 2
  const spanX = w + WEATHER_WRAP_MARGIN * 2

  const fallFrac = p.y0 + t * m.fall * p.speedMul
  out.y = positiveMod(fallFrac, 1) * spanY - WEATHER_WRAP_MARGIN

  const sway = m.swayAmp * w * Math.sin(2 * Math.PI * m.swayHz * p.swayHzMul * t + p.swayPhase)
  const xRaw = p.x0 * w + m.drift * w * t * p.speedMul + sway
  out.x = positiveMod(xRaw + WEATHER_WRAP_MARGIN, spanX) - WEATHER_WRAP_MARGIN

  if (kind === 'Rain') {
    // 縦線を落下方向（流れ込む向き）に傾ける。画面の縦横比が違っても実際の落下方向に沿う。
    out.rotation = Math.atan2(-m.drift * w, m.fall * h)
  } else if (kind === 'Sakura') out.rotation = p.rot0 + p.spinDir * m.spin * t
  else out.rotation = 0
  out.scale = m.size * p.size
  out.alpha = m.alpha
  return out
}

/**
 * 粒 `index` の `elapsedMs` 時点のフレームを新しいオブジェクトで返す（テスト・単発用の純粋関数）。
 * 描画ループは `createWeatherParticleParams` を一度だけ作って `evaluateWeatherParticle` を使う。
 */
export function computeWeatherParticle(
  kind: WeatherKind,
  index: number,
  elapsedMs: number,
  width: number,
  height: number
): WeatherParticleFrame {
  return evaluateWeatherParticle(
    kind,
    createWeatherParticleParams(kind, index),
    elapsedMs,
    width,
    height,
    { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
  )
}
