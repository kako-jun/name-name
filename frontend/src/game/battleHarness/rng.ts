/**
 * 検証ハーネスの乱数 (#877 段階 3)。エンジンの `opts.rng` に注入して戦闘を決定論的にリプレイする。
 */

/** 決定論的な擬似乱数（LCG）。`battleEngineAtb.test.ts` の `lcg` と同じ式 */
export function lcg(seed = 12345): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

/** 1 操作あたりの乱数消費が予算を超えたときに投げる（エンジン内の無限ループの検出に使う） */
export class RngBudgetExceeded extends Error {
  constructor(budget: number) {
    super(`1 操作で乱数を ${budget} 回より多く消費した`)
    this.name = 'RngBudgetExceeded'
  }
}

export interface BudgetRng {
  (): number
  /** 操作の開始ごとに消費数を 0 に戻す */
  reset(): void
  /** 通算の消費数 */
  total(): number
}

/** 1 操作の乱数消費の既定の予算。無限ループは数 ms でここに届く */
export const DEFAULT_RNG_BUDGET_PER_OP = 2_000_000

/** `lcg(seed)` を包み、`reset()` からの消費数が `budgetPerOp` を超えたら `RngBudgetExceeded` を投げる乱数 */
export function budgetRng(seed: number, budgetPerOp = DEFAULT_RNG_BUDGET_PER_OP): BudgetRng {
  const base = lcg(seed)
  let inOp = 0
  let total = 0
  const f = (() => {
    inOp++
    total++
    if (inOp > budgetPerOp) throw new RngBudgetExceeded(budgetPerOp)
    return base()
  }) as BudgetRng
  f.reset = () => {
    inOp = 0
  }
  f.total = () => total
  return f
}
