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

  it('未知の値（既知 alias にないもの）は既定 center に丸める', () => {
    // name-name の enum 慣例（未知→既定）に合わせ、未知値はすべて center に落とす。
    expect(normalizeVideoPosition('TOP')).toBe('center')
  })

  it('前後空白を含む既知 alias も正規化する', () => {
    expect(normalizeVideoPosition('  left  ')).toBe('left')
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

  // own-property ルックアップ修正の確認（#368）。position が Object.prototype のプロパティ名と
  // 一致しても未知の値と同じ既定 center になる（関数オブジェクトを文字列として返さない）。
  it('修正確認: "constructor" でも既定 center になる', () => {
    expect(normalizeVideoPosition('constructor')).toBe('center')
  })

  // 他の proto 名（toString/valueOf 等）は `.toLowerCase()` で文字列自体が変化し
  // 実在の Object.prototype メンバー名と一致しなくなるため対象外（例: 'toString'→'tostring' は
  // 本物の member 名ではなく、修正前後で挙動差が出ない）。'Constructor'/'__proto__' は
  // lowercase 後も実在メンバー名のままなので、大文字化・空白付きの回帰として検証する。
  it('修正確認: 大文字混在 "Constructor" も lowercase 後に衝突するが center になる', () => {
    expect(normalizeVideoPosition('Constructor')).toBe('center')
  })

  it('修正確認: 前後空白付き "  constructor  " も center になる', () => {
    expect(normalizeVideoPosition('  constructor  ')).toBe('center')
  })

  it('修正確認: "__proto__" でも center になる', () => {
    expect(normalizeVideoPosition('__proto__')).toBe('center')
  })
})
