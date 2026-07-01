import { describe, it, expect } from 'vitest'
import { canonicalizeBodyText, MIDLINE_RULE, MIDLINE_ELLIPSIS } from './textCanonical'

describe('canonicalizeBodyText 表示用ダイグラフ正準化 (#340)', () => {
  it('定数は中央字コード U+2500 / U+22EF', () => {
    expect(MIDLINE_RULE).toBe('─')
    expect(MIDLINE_ELLIPSIS).toBe('⋯')
  })

  it('`--`（ASCII ちょうど2連）→ `──`（U+2500×2）', () => {
    expect(canonicalizeBodyText('待って--行かないで')).toBe('待って──行かないで')
    expect(canonicalizeBodyText('--')).toBe('──')
    expect(canonicalizeBodyText('A--B。')).toBe('A──B。')
  })

  it('`---`（3連以上）は不変（markdown hr / 見出し下線を壊さない）', () => {
    expect(canonicalizeBodyText('---')).toBe('---')
    expect(canonicalizeBodyText('----')).toBe('----')
    expect(canonicalizeBodyText('A---B')).toBe('A---B')
  })

  it('単独 `-`・語中/URL のハイフンは不変（一括置換しない）', () => {
    expect(canonicalizeBodyText('a-b')).toBe('a-b')
    expect(canonicalizeBodyText('part-time')).toBe('part-time')
    expect(canonicalizeBodyText('-')).toBe('-')
  })

  it('`…`（U+2026、1つでも連続でも）→ `⋯`（U+22EF、同数）', () => {
    expect(canonicalizeBodyText('そう…')).toBe('そう⋯')
    expect(canonicalizeBodyText('ええと……')).toBe('ええと⋯⋯')
    expect(canonicalizeBodyText('……あと五分……')).toBe('⋯⋯あと五分⋯⋯')
  })

  it('冪等: 既存中央字コーパス（──/⋯⋯）に恒等・二重適用も恒等', () => {
    expect(canonicalizeBodyText('待って──行かないで⋯⋯')).toBe('待って──行かないで⋯⋯')
    const once = canonicalizeBodyText('待って--行かないで……')
    expect(canonicalizeBodyText(once)).toBe(once)
  })

  it('`？`/`！`/空白は触らない', () => {
    expect(canonicalizeBodyText('本当に？ はい！')).toBe('本当に？ はい！')
  })

  it('`--` と `…` の混在を同時に正準化する', () => {
    expect(canonicalizeBodyText('そうか--でも…もういい')).toBe('そうか──でも⋯もういい')
  })
})
