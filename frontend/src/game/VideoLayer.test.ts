/**
 * VideoLayer の純粋関数テスト (#252)。
 *
 * VideoLayer 本体（show/remove/restore/prepareForExport）は HTMLVideoElement・
 * VideoSource・canvas マスク描画・WebAudio に依存し、jsdom では検証できない（CLAUDE.md ルール7、
 * 実機 golden path で担保）。ここでは canvas/video/webaudio に触れない純粋関数だけを検証する。
 */
import { describe, it, expect } from 'vitest'
import { normalizeVideoPosition } from './VideoLayer'

describe('normalizeVideoPosition', () => {
  it('日本語「左」を left に正規化する', () => {
    expect(normalizeVideoPosition('左')).toBe('left')
  })

  it('日本語「中央」を center に正規化する', () => {
    expect(normalizeVideoPosition('中央')).toBe('center')
  })

  it('日本語「右」を right に正規化する', () => {
    expect(normalizeVideoPosition('右')).toBe('right')
  })

  it('日本語の表記ゆれ（真ん中）も center に寄せる', () => {
    expect(normalizeVideoPosition('真ん中')).toBe('center')
  })

  it('英語 left/center/right はそのまま通る', () => {
    expect(normalizeVideoPosition('left')).toBe('left')
    expect(normalizeVideoPosition('center')).toBe('center')
    expect(normalizeVideoPosition('right')).toBe('right')
  })

  it('大文字 LEFT は小文字化して left になる', () => {
    expect(normalizeVideoPosition('LEFT')).toBe('left')
  })

  it('先頭大文字 Center（マップ登録あり）は center になる', () => {
    expect(normalizeVideoPosition('Center')).toBe('center')
  })

  it('英国綴り Centre も center に正規化する', () => {
    expect(normalizeVideoPosition('Centre')).toBe('center')
  })

  it('未知の値はマップ外として小文字化したものをそのまま返す', () => {
    // 実装は未知値を center に丸めず、lowercase したものを通す。
    // 既定(center)になるのは null/undefined/空文字のみ。
    expect(normalizeVideoPosition('TOP')).toBe('top')
  })

  it('null は既定 center になる', () => {
    expect(normalizeVideoPosition(null)).toBe('center')
  })

  it('undefined は既定 center になる', () => {
    expect(normalizeVideoPosition(undefined)).toBe('center')
  })

  it('空文字は falsy として既定 center になる', () => {
    expect(normalizeVideoPosition('')).toBe('center')
  })
})
