/**
 * 検証ハーネスの結果の集計と出力 (#877 段階 3)。
 *
 * 3 分類のうち、機械判定するのは「壊れ」（違反が 1 件でもあるシナリオ）と「正常」（違反なし）だけ。
 * 「凄い組み合わせ（強すぎ・許容）」は閾値を決め打ちせず、指標の上位を数値つきで並べる「候補」に留める（閾値は未決）。
 */
import { isBroken, WARN_KINDS, type Violation, type ViolationKind } from './detect'
import type { Metrics, ScenarioResult } from './run'
import type { Scenario } from './scenario'

export interface SweepSummary {
  total: number
  /** 壊れと断定できる違反が 1 件以上あるシナリオ */
  broken: number
  /** 壊れと断定はしない違反（`WARN_KINDS`: 膠着など）だけがあるシナリオ */
  needsJudgement: number
  normal: number
  /** 自動進行の上限内で決着がつかなかった数（ロックとは別。HP が大きい戦闘など。情報のみ） */
  unfinished: number
  byFamily: Record<string, { total: number; broken: number }>
  byKind: Array<{ kind: ViolationKind; scenarios: number; examples: string[] }>
}

export interface Candidate {
  metric: keyof Pick<
    Metrics,
    'maxEventDamage' | 'maxHealAmount' | 'maxHitsPerEvent' | 'maxAbsBuff' | 'maxHpDrop'
  >
  rows: Array<{ id: string; value: number; ties: number }>
}

export const CANDIDATE_METRICS: Candidate['metric'][] = [
  'maxEventDamage',
  'maxHpDrop',
  'maxHealAmount',
  'maxHitsPerEvent',
  'maxAbsBuff',
]

export function familyOf(id: string): string {
  return id.split('/')[0]
}

export function summarize(results: readonly ScenarioResult[]): SweepSummary {
  const byFamily: SweepSummary['byFamily'] = {}
  const kinds = new Map<ViolationKind, string[]>()
  let broken = 0
  let needsJudgement = 0
  let unfinished = 0
  for (const r of results) {
    const f = (byFamily[familyOf(r.id)] ??= { total: 0, broken: 0 })
    f.total++
    if (r.violations.some(isBroken)) {
      broken++
      f.broken++
    } else if (r.violations.length > 0) {
      needsJudgement++
    }
    if (r.violations.length > 0) {
      for (const k of new Set(r.violations.map((v) => v.kind))) {
        const list = kinds.get(k) ?? []
        list.push(r.id)
        kinds.set(k, list)
      }
    }
    if (!r.metrics.ended && !r.violations.some((v) => v.kind === 'lock')) unfinished++
  }
  const byKind = [...kinds.entries()]
    .map(([kind, ids]) => ({ kind, scenarios: ids.length, examples: ids.slice(0, 3) }))
    .sort((a, b) => b.scenarios - a.scenarios)
  return {
    total: results.length,
    broken,
    needsJudgement,
    normal: results.length - broken - needsJudgement,
    unfinished,
    byFamily,
    byKind,
  }
}

/**
 * 指標ごとの上位 `top` 件（値が大きい順。0 のものは出さない）。判定はしない。
 * 同じ値のシナリオは 1 行にまとめ（代表 1 件の id と、同値の他の件数 `ties`）、上位が同値で埋まらないようにする
 */
export function candidates(results: readonly ScenarioResult[], top = 10): Candidate[] {
  return CANDIDATE_METRICS.map((metric) => {
    const byValue = new Map<number, string[]>()
    for (const r of results) {
      if (r.violations.length > 0 || !(r.metrics[metric] > 0)) continue // 壊れ・要判断は候補に混ぜない
      const ids = byValue.get(r.metrics[metric]) ?? []
      ids.push(r.id)
      byValue.set(r.metrics[metric], ids)
    }
    const rows = [...byValue.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, top)
      .map(([value, ids]) => ({ value, id: ids.slice().sort()[0], ties: ids.length - 1 }))
    return { metric, rows }
  })
}

/** 失敗の再現ファイル。`replayFile` に渡せばそのまま再実行できる */
export interface FailureFile {
  version: 1
  failures: Array<{ scenario: Scenario; violations: Violation[] }>
}

export function toFailureFile(
  scenarios: readonly Scenario[],
  results: readonly ScenarioResult[],
  limit = 5000
): FailureFile {
  const byId = new Map(scenarios.map((s) => [s.id, s]))
  const failures: FailureFile['failures'] = []
  for (const r of results) {
    if (r.violations.length === 0) continue
    const scenario = byId.get(r.id)
    if (scenario) failures.push({ scenario, violations: r.violations })
    if (failures.length >= limit) break
  }
  return { version: 1, failures }
}

/** 失敗ファイル（または単体のシナリオ JSON）からシナリオを取り出す。`id` を渡せば 1 件だけ */
export function scenariosFromJson(json: unknown, id?: string): Scenario[] {
  const j = json as { failures?: Array<{ scenario: Scenario }>; ops?: unknown }
  const list: Scenario[] = Array.isArray(j?.failures)
    ? j.failures.map((f) => f.scenario)
    : Array.isArray(j?.ops)
      ? [json as Scenario]
      : []
  return id ? list.filter((s) => s.id === id) : list
}

export function formatReport(
  summary: SweepSummary,
  cands: readonly Candidate[],
  results: readonly ScenarioResult[]
): string {
  const L: string[] = []
  L.push('# battle-harness 結果（検出のみ・何も修正していない）')
  L.push('')
  L.push(
    `走らせた組み合わせ: ${summary.total} 件 / 壊れ: ${summary.broken} 件 / 要判断(膠着): ${summary.needsJudgement} 件 / 正常: ${summary.normal} 件` +
      `（うち自動進行の上限内で未決着: ${summary.unfinished} 件。ロックとは別・情報のみ）`
  )
  L.push('')
  L.push('## 族ごと')
  for (const [f, v] of Object.entries(summary.byFamily)) {
    L.push(`- ${f}: ${v.total} 件中 壊れ ${v.broken} 件`)
  }
  L.push('')
  const byId = new Map(results.map((r) => [r.id, r]))
  const section = (title: string, kinds: typeof summary.byKind): void => {
    L.push(title)
    if (kinds.length === 0) L.push('- なし')
    for (const k of kinds) {
      L.push(`- ${k.kind}: ${k.scenarios} シナリオ`)
      for (const id of k.examples) {
        const v = byId.get(id)?.violations.find((x) => x.kind === k.kind)
        L.push(`  - ${id}: ${v?.detail ?? ''}（操作 ${v?.opIndex ?? '?'} の後）`)
      }
    }
    L.push('')
  }
  const isWarn = (k: { kind: ViolationKind }): boolean => WARN_KINDS.includes(k.kind)
  section(
    '## 壊れ（止めるべき）: 種類ごと',
    summary.byKind.filter((k) => !isWarn(k))
  )
  section(
    '## 要判断（壊れと断定しない。攻撃だけでは決着しない膠着など）',
    summary.byKind.filter(isWarn)
  )
  L.push('## 凄い組み合わせの候補（閾値は未決。壊れでないシナリオの指標の上位を数値のまま並べる）')
  for (const c of cands) {
    L.push(`- ${c.metric}`)
    if (c.rows.length === 0) L.push('  - 該当なし')
    for (const r of c.rows)
      L.push(`  - ${r.value}: ${r.id}${r.ties > 0 ? `（同値の他 ${r.ties} 件）` : ''}`)
  }
  return L.join('\n') + '\n'
}
