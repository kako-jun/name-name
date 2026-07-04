/**
 * parseThemeQuery(search) のテスト (#394)。
 *
 * `?theme=light` のときだけ 'light'、それ以外（未指定 / dark / 未知値 / 空 / 大文字 /
 * 末尾空白）はすべて既定 'dark' に倒す純粋パーサの検証。`sceneQuery.test.ts` と同じ流儀
 * （副作用なし・DOM 非依存の純粋関数に文字列を直接渡し、戻り値を突き合わせる）で、
 * 観点ごとに 1 テストにする。
 *
 * 観点分類:
 *   適用   = 「'light' 完全一致 → light / それ以外 → dark（既定）」の弁別。本パーサ唯一の
 *            責務。境界は 8/8b/9（'Light' / 'LIGHT' / 'light ' が完全一致でない＝dark）。
 *            重複キーの先勝ち（10a/10b）も URLSearchParams.get の仕様として担保する。
 *   非適用 = i18n / 権限 / 日付フォーマット / 並行(race) 等。本パーサは query string を
 *            'light' | 'dark' に写す副作用なしの純関数で、これらの軸を一切持たないため対象外。
 */
import { describe, it, expect } from 'vitest'
import { parseThemeQuery } from './themeQuery'

describe('parseThemeQuery (#394)', () => {
  // ===== 適用: 'light' 明示指定のみ light =====

  it('1【適用】?theme=light → light（明示指定のみ light）', () => {
    expect(parseThemeQuery('?theme=light')).toBe('light')
  })

  it('2【適用】先頭 ? 無し theme=light → light（URLSearchParams はどちらも受ける）', () => {
    expect(parseThemeQuery('theme=light')).toBe('light')
  })

  // ===== 適用: 既定 dark に倒れる側（否定側）=====

  it('3【適用】?theme=dark → dark（明示 dark も既定と同じ）', () => {
    expect(parseThemeQuery('?theme=dark')).toBe('dark')
  })

  it('4【適用】?theme=（値が空）→ dark（既定）', () => {
    expect(parseThemeQuery('?theme=')).toBe('dark')
  })

  it('5【適用】空文字 "" → dark（既定）', () => {
    expect(parseThemeQuery('')).toBe('dark')
  })

  it('6【適用】?other=1（theme キー無し）→ dark（既定）', () => {
    expect(parseThemeQuery('?other=1')).toBe('dark')
  })

  it('7【適用】未知値 ?theme=lite → dark（light 以外は既定）', () => {
    expect(parseThemeQuery('?theme=lite')).toBe('dark')
  })

  // ===== 適用・境界: 'light' 完全一致 vs それ以外 =====

  it('8【適用・境界】?theme=Light → dark（大文字始まりは完全一致でない）', () => {
    expect(parseThemeQuery('?theme=Light')).toBe('dark')
  })

  it('8b【適用・境界】?theme=LIGHT → dark（全大文字は完全一致でない）', () => {
    expect(parseThemeQuery('?theme=LIGHT')).toBe('dark')
  })

  it('9【適用・境界】?theme=light%20（デコード後 "light " 末尾空白）→ dark（完全一致でない）', () => {
    expect(parseThemeQuery('?theme=light%20')).toBe('dark')
  })

  // ===== 適用: 重複キー（URLSearchParams.get は先勝ち）=====

  it('10a【適用】?theme=light&theme=dark → light（先勝ち）', () => {
    expect(parseThemeQuery('?theme=light&theme=dark')).toBe('light')
  })

  it('10b【適用】?theme=dark&theme=light → dark（先勝ち）', () => {
    expect(parseThemeQuery('?theme=dark&theme=light')).toBe('dark')
  })
})
