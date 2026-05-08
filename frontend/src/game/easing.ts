/**
 * イージング関数 (#134)
 *
 * すべて pure: t in [0,1] → eased value in [0,1]。
 * アニメーションの進行率に適用する。
 */

import type { Easing } from '../types'

export function easeLinear(t: number): number {
  return t
}

export function easeIn(t: number): number {
  return t * t
}

export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

export function applyEasing(easing: Easing | undefined, t: number): number {
  // t は 0..1 にクランプしてから関数適用
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  switch (easing) {
    case 'EaseIn':
      return easeIn(clamped)
    case 'EaseOut':
      return easeOut(clamped)
    case 'EaseInOut':
      return easeInOut(clamped)
    case 'Linear':
    case undefined:
    default:
      return easeLinear(clamped)
  }
}

/**
 * "+500" / "-200" / "400" のような相対/絶対表現を解釈する。
 *
 * @param expr 入力文字列。`+`/`-` 接頭辞付きは相対、それ以外は絶対。
 * @param current 現在値 (相対計算用)
 * @returns target 数値。expr が無効なら current を返す
 */
export function resolveDelta(expr: string | undefined, current: number): number {
  if (expr === undefined) return current
  const trimmed = expr.trim()
  if (trimmed === '') return current
  // 相対 (+ or -)
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return current
    return current + n
  }
  // 絶対
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return current
  return n
}
