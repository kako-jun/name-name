/**
 * parseSceneQuery(search) のテスト (#386)。
 *
 * `?scene=<sceneId>` を PlayerScreen が読むための最小パーサの検証。
 * `debugQuery.test.ts` と同じ流儀（副作用なし・DOM 非依存の純粋関数に文字列を渡し、
 * 戻り値を直接突き合わせる）で、観点ごとに 1 テストにする。
 */
import { describe, it, expect } from 'vitest'
import { parseSceneQuery } from './sceneQuery'

describe('parseSceneQuery (#386)', () => {
  // ===== A. 正常系 =====

  it('1: ?scene=foo → foo', () => {
    expect(parseSceneQuery('?scene=foo')).toBe('foo')
  })

  it('2: 先頭 ? 無し scene=foo → foo（URLSearchParams はどちらも受け付ける）', () => {
    expect(parseSceneQuery('scene=foo')).toBe('foo')
  })

  // ===== B. 境界値・null/空文字/未設定 =====

  it('3: 空文字 "" → null', () => {
    expect(parseSceneQuery('')).toBeNull()
  })

  it('4: ?scene=（値が空）→ null', () => {
    expect(parseSceneQuery('?scene=')).toBeNull()
  })

  it('4b: ?scene=a（1 文字）→ a（空文字との境界）', () => {
    expect(parseSceneQuery('?scene=a')).toBe('a')
  })

  it('5: ?other=1（scene 未設定）→ null', () => {
    expect(parseSceneQuery('?other=1')).toBeNull()
  })

  // ===== C. 同値分割 =====

  it('6: ?debug_scene=foo（scene キーではない）→ null', () => {
    expect(parseSceneQuery('?debug_scene=foo')).toBeNull()
  })

  // ===== D. 重複・複数パラメータ =====

  it('7: ?scene=a&scene=b（重複）→ a（先勝ち。URLSearchParams.get の仕様）', () => {
    expect(parseSceneQuery('?scene=a&scene=b')).toBe('a')
  })

  it('8: ?other=1&scene=bar（他パラメータ混在）→ bar', () => {
    expect(parseSceneQuery('?other=1&scene=bar')).toBe('bar')
  })

  // ===== E. i18n・特殊文字 =====

  it('9: ?scene=%E3%81%82（URL エンコード）→ デコード後の値 "あ"', () => {
    expect(parseSceneQuery('?scene=%E3%81%82')).toBe('あ')
  })

  it('10: ?scene=%20（空白 1 文字）→ " "（空文字とは区別される）', () => {
    expect(parseSceneQuery('?scene=%20')).toBe(' ')
  })
})
