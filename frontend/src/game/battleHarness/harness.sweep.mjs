/**
 * 検証ハーネスの手動実行の入口 (#877 段階 3)。`npm run test:battle-harness` から vitest 経由で動く
 * （通常の `npm test` には入らない。CI に入れるかは未決）。
 *
 * 環境変数:
 * - HARNESS_SEED / HARNESS_RANDOM_COUNT: ランダム合成の seed と件数（既定 1 / 3000）
 * - HARNESS_SKIP: 省く族をカンマ区切り（effect-matrix,enemy-skill,stack-order,reaction-chain,random）
 * - HARNESS_OUT: 結果の出力先ディレクトリ（既定 `battle-harness-out`）。report.md と failures.json を書く
 * - HARNESS_REPLAY: 失敗ファイル（または単体のシナリオ JSON）のパス。指定すると総当たりでなくそれだけを再実行する
 * - HARNESS_REPLAY_ID: HARNESS_REPLAY の中から 1 件だけ再実行するときのシナリオ id
 * - HARNESS_STRICT=1: 壊れが 1 件でもあれば失敗扱いにする（既定は一覧を出すだけで成功）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidates, formatReport, scenariosFromJson, summarize, toFailureFile } from './report.ts'
import { buildSweep, DEFAULT_SWEEP, runAll } from './sweep.ts'

const env = process.env

describe('battle-harness', () => {
  it('総当たり / 再現', { timeout: 30 * 60 * 1000 }, () => {
    const out = env.HARNESS_OUT ?? 'battle-harness-out'
    let scenarios
    if (env.HARNESS_REPLAY) {
      const json = JSON.parse(readFileSync(env.HARNESS_REPLAY, 'utf8'))
      scenarios = scenariosFromJson(json, env.HARNESS_REPLAY_ID)
      expect(scenarios.length, '再現するシナリオが見つからない').toBeGreaterThan(0)
    } else {
      const cfg = {
        randomSeed: Number(env.HARNESS_SEED ?? DEFAULT_SWEEP.randomSeed),
        randomCount: Number(env.HARNESS_RANDOM_COUNT ?? DEFAULT_SWEEP.randomCount),
        skip: env.HARNESS_SKIP?.split(',').filter(Boolean) ?? [],
      }
      scenarios = buildSweep(cfg)
    }
    const results = runAll(scenarios)
    const summary = summarize(results)
    const text = formatReport(summary, candidates(results), results)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'report.md'), text)
    writeFileSync(
      join(out, 'failures.json'),
      JSON.stringify(toFailureFile(scenarios, results), null, 1)
    )
    process.stdout.write('\n' + text + `\n出力: ${join(out, 'report.md')} / failures.json\n`)
    if (env.HARNESS_STRICT === '1') expect(summary.broken).toBe(0)
  })
})
