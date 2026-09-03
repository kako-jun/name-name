/**
 * `seSelection.ts`（SE 複数候補プールのランダム抽出+シャッフル、ランダム間隔算出、#672）のテスト。
 *
 * `AudioManager`/`NovelRenderer` に依存しない純粋関数のみを対象とするため、`easing.test.ts` と
 * 同じ最小構成（関数を直接呼び出し、決定的な `random` スタブを差し込む）で検証する。
 * TUI版 `se_selection.rs` の既存テスト（`select_and_shuffle_returns_all_when_count_is_none` 等）
 * と対応する観点をGUI版でも揃える。
 */
import { describe, it, expect } from 'vitest'
import { selectAndShuffleSeFiles, randomGapMs } from './seSelection'

describe('selectAndShuffleSeFiles (#672)', () => {
  it('17: countがnullなら全件を返す', () => {
    const paths = ['a.wav', 'b.wav', 'c.wav']
    const result = selectAndShuffleSeFiles(paths, null)
    expect(result).toHaveLength(3)
    expect(result.slice().sort()).toEqual(paths.slice().sort())
  })

  it('18: count=1なら要素数1の配列を返す', () => {
    const paths = ['a.wav', 'b.wav', 'c.wav']
    const result = selectAndShuffleSeFiles(paths, 1)
    expect(result).toHaveLength(1)
    expect(paths).toContain(result[0])
  })

  it('19: countがpaths.lengthを超えるとき全件にclampされる', () => {
    const paths = ['a.wav', 'b.wav']
    const result = selectAndShuffleSeFiles(paths, 10)
    expect(result).toHaveLength(2)
    expect(result.slice().sort()).toEqual(paths.slice().sort())
  })

  it('20: count=0のとき空配列を返す（呼び出し側は無音として扱う）', () => {
    const paths = ['a.wav', 'b.wav']
    expect(selectAndShuffleSeFiles(paths, 0)).toEqual([])
  })

  it('21: 負のcountは0扱いになる（防御コード確認）', () => {
    const paths = ['a.wav', 'b.wav']
    expect(selectAndShuffleSeFiles(paths, -5)).toEqual([])
  })

  it('22: 抽出結果に重複が無い（決定的randomスタブで検証）', () => {
    const paths = ['a.wav', 'b.wav', 'c.wav', 'd.wav', 'e.wav']
    // Math.random ではなく単調に周回する決定的スタブを使い、実行のたびに結果が変わらないようにする
    // （TUI版テストの StepRng と同じ狙い）。
    let seed = 0.05
    const random = (): number => {
      seed = (seed + 0.137) % 1
      return seed
    }
    const result = selectAndShuffleSeFiles(paths, 3, random)
    expect(result).toHaveLength(3)
    expect(new Set(result).size).toBe(3)
    for (const p of result) {
      expect(paths).toContain(p)
    }
  })

  it('23: paths空配列なら空配列を返す', () => {
    expect(selectAndShuffleSeFiles([], null)).toEqual([])
    expect(selectAndShuffleSeFiles([], 5)).toEqual([])
  })
})

describe('randomGapMs (#672)', () => {
  it('24: min<maxのとき範囲内の値を返す', () => {
    for (let i = 0; i < 20; i++) {
      const gap = randomGapMs(50, 200, () => i / 20)
      expect(gap).toBeGreaterThanOrEqual(50)
      expect(gap).toBeLessThanOrEqual(200)
    }
  })

  it('25: min>maxを渡しても正規化されて範囲内に収まる', () => {
    const gap = randomGapMs(200, 50, () => 0.5)
    expect(gap).toBeGreaterThanOrEqual(50)
    expect(gap).toBeLessThanOrEqual(200)
  })

  it('26: min=maxのとき常にその値を返す', () => {
    expect(randomGapMs(100, 100, () => 0)).toBe(100)
    expect(randomGapMs(100, 100, () => 0.999)).toBe(100)
  })
})
