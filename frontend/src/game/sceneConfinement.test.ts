/**
 * isSceneIdConfined(sceneId, confinedSceneIds) のテスト (#386)。
 *
 * `?scene=` ディープリンク単独埋め込みの confinement（在圏）判定を行う純粋関数の検証。
 * 副作用なし・DOM 非依存なので、値を直接突き合わせる最小構成で行う（観点ごとに 1 テスト）。
 */
import { describe, it, expect } from 'vitest'
import { isSceneIdConfined } from './sceneConfinement'

describe('isSceneIdConfined (#386)', () => {
  // ===== A. null passthrough（制限なし＝通常のハブ経由フロー） =====

  it('1: confinedSceneIds=null なら常に true（制限なし）', () => {
    expect(isSceneIdConfined('x', null)).toBe(true)
  })

  // ===== B. 同値分割: 在圏 / 圏外 =====

  it('2: 在圏（集合に含まれる）→ true', () => {
    expect(isSceneIdConfined('a', ['a', 'b'])).toBe(true)
  })

  it('3: 圏外（集合に含まれない）→ false', () => {
    expect(isSceneIdConfined('c', ['a', 'b'])).toBe(false)
  })

  // ===== C. 境界値 =====

  it('4: 空配列 → 常に false（在圏の要素がそもそも無い）', () => {
    expect(isSceneIdConfined('a', [])).toBe(false)
  })

  it('5: 単一要素の配列で一致 → true', () => {
    expect(isSceneIdConfined('a', ['a'])).toBe(true)
  })

  it('6: 単一要素の配列で不一致 → false', () => {
    expect(isSceneIdConfined('b', ['a'])).toBe(false)
  })
})
