/**
 * 下線ビーム (#270) の pure 計算ヘルパー。
 *
 * orber 宣伝動画の OP タイトルカード（opening.html の `drawLine` / scaleX 0→1）を
 * 忠実再現する。対象テキスト幅にフィットする横線を直下に置き、左から伸ばす。
 * CharacterLayer.applyUnderline はこの値を Pixi Graphics に当てるだけ（配線のみ）。
 *
 * 設計（ADR0002）: アニメ進行中の中間状態は持たず、経過 ms を入力に毎フレーム純粋計算する。
 * 効果完了後（または復元・skip 時）は線が伸び切った（scaleX=1）「静止状態」になる。
 * 決定論: TimeController 仮想時間で駆動し、Math.random は使わない。
 */

import type { Easing } from '../types'
import { applyEasing } from './easing'

/** `[下線]` イベントの生パラメータ（parser 由来。未指定は undefined）。 */
export interface UnderlineParams {
  /** 線の色（CSS カラー文字列、例 "#1a4a7a"）。 */
  color?: string
  /** 線の太さ (px)。 */
  thickness?: number
  /** 伸長アニメ所要 (ms)。 */
  duration_ms?: number
  /** テキスト下端からの距離 (px)。未指定なら測定値から自動算出（autoOffset 参照）。 */
  offset?: number
  easing?: Easing
}

/**
 * プリセット既定値の正本（#270）。opening.html の `.underline` 相当。
 *
 * テストが期待値を直書きして陳腐化するのを防ぐため export する。
 * - color: opening.html の `background: #1a4a7a`
 * - thickness: opening.html の `height: 3px`
 * - durationMs: opening.html の `drawLine 0.7s`
 * - easing: opening.html の `cubic-bezier(0.7,0,1,0.5)`（加速ビーム感）≒ EaseIn
 */
export const UNDERLINE_DEFAULTS = {
  color: '#1a4a7a',
  thickness: 3,
  durationMs: 700,
  easing: 'EaseIn' as Easing,
} as const

/** 解決済みの下線パラメータ。プリセット既定 + 個別 override を済ませた後の値。 */
export interface ResolvedUnderline {
  /** Pixi の数値カラー (0xRRGGBB)。 */
  colorNum: number
  /** 線の太さ (px)。 */
  thickness: number
  /** 伸長アニメ所要 (ms)。 */
  durationMs: number
  /** テキスト下端からの距離 (px)。undefined なら呼び出し側が autoOffset で補う。 */
  offset?: number
  easing: Easing
}

/**
 * CSS カラー文字列（"#1a4a7a" / "#222" / "1a4a7a"）を Pixi の数値カラーに変換する（純粋）。
 *
 * 3 桁短縮形（#222 → #222222）も展開する。解釈不能なら fallback（既定色）を返す。
 * Math.random など非決定要素は使わない。
 */
export function parseColorToNumber(color: string | undefined, fallback: number): number {
  if (color === undefined) return fallback
  let s = color.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 3) {
    // #rgb → #rrggbb
    s = s
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (s.length !== 6) return fallback
  // 純粋 hex 16 進数のみ受理する。Number.parseInt は '+1a4a7'/'-1a4a7' のような符号付き
  // 文字列を解釈してしまい fallback に倒れないため、parseInt 前に純 hex 判定で弾く。
  if (!/^[0-9a-fA-F]+$/.test(s)) return fallback
  const n = Number.parseInt(s, 16)
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback
  return n
}

/**
 * プリセット既定値と個別指定をマージして解決済みパラメータを返す。
 *
 * 優先順位: 個別指定 > プリセット既定値。負の thickness/duration はクランプする。
 * offset は undefined のまま返し、呼び出し側（autoOffset）で測定値から補う余地を残す。
 */
export function resolveUnderline(params: UnderlineParams): ResolvedUnderline {
  const fallbackColor = parseColorToNumber(UNDERLINE_DEFAULTS.color, 0x000000)
  return {
    colorNum: parseColorToNumber(params.color, fallbackColor),
    thickness: Math.max(0, params.thickness ?? UNDERLINE_DEFAULTS.thickness),
    durationMs: Math.max(0, params.duration_ms ?? UNDERLINE_DEFAULTS.durationMs),
    offset: params.offset,
    easing: params.easing ?? UNDERLINE_DEFAULTS.easing,
  }
}

/**
 * 経過 ms → scaleX [0,1] を返す（純粋）。
 *
 * elapsed<=0 は 0、duration 経過後は 1。durationMs<=0 は即完了（1）。
 * easing を適用するため途中値は線形ではない（EaseIn なら序盤ゆっくり）。
 * 注意: EaseOutBack 等のオーバーシュート easing では 1 を超える瞬間があり得るが、
 * 線は「行き過ぎてから戻る」表現として許容する（applyEasing 自体は clamp しない）。
 */
export function underlineScaleX(elapsedMs: number, resolved: ResolvedUnderline): number {
  if (!(resolved.durationMs > 0)) return 1
  const t = elapsedMs > 0 ? elapsedMs / resolved.durationMs : 0
  if (t >= 1) return 1
  return applyEasing(resolved.easing, t)
}

/**
 * テキストの実 measure 値から下線の幾何（ジオメトリ）を算出する（純粋）。
 *
 * opening.html は `name.length * charWidth` で概算するが、name-name は実 measure 幅を使う
 * （fallback フォント幅ずれを防ぐ）。下線は対象テキストの中央に左右対称で置く想定なので、
 * 矩形のローカル左端 x は `-width/2`、上端 y はテキスト下端 + offset。
 * scaleX のピボットを左端に置けるよう、矩形は「ローカル原点 = 左端」で記述する。
 *
 * @param textWidth 対象テキストの実 measure 幅 (px)
 * @param textBottomY 対象テキスト下端のローカル y 座標（anchor 中央なら fontSize/2 等）
 * @param resolved 解決済みパラメータ
 * @param autoOffset offset 未指定時に使う自動余白 (px)。測定値（例 fontSize の数 %）。
 * @returns 矩形の左端 x / 上端 y / 幅 / 太さ。scaleX は別途 underlineScaleX で掛ける。
 */
export function layoutUnderline(
  textWidth: number,
  textBottomY: number,
  resolved: ResolvedUnderline,
  autoOffset: number
): { x: number; y: number; width: number; thickness: number } {
  const width = textWidth > 0 ? textWidth : 0
  const offset = resolved.offset ?? autoOffset
  return {
    // 左端基準: 中央寄せした線の左端。scaleX の pivot をここ（左端）に置く。
    x: -width / 2,
    y: textBottomY + offset,
    width,
    thickness: resolved.thickness,
  }
}
