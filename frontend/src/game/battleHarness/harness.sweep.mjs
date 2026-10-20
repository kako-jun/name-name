/**
 * 検証ハーネスの手動実行の入口 (#877 段階 3)。`npm run test:battle-harness` から vitest 経由で動く
 * （通常の `npm test` には入らない。CI に入れるかは未決）。
 *
 * 環境変数:
 * - HARNESS_SEED / HARNESS_RANDOM_COUNT: ランダム合成の seed と件数（既定 1 / 3000）
 * - HARNESS_SKIP: 省く族をカンマ区切り（effect-matrix,enemy-skill,stack-order,reaction-chain,random）
 * - HARNESS_OUT: 結果の出力先ディレクトリ（既定 `battle-harness-out`、再現時は `battle-harness-out/replay`）。report.md と failures.json を書く
 *   （読み込み元の failures.json と同じパスには書かない）
 * - HARNESS_REPLAY: 失敗ファイル（または単体のシナリオ JSON）のパス。指定すると総当たりでなくそれだけを再実行する
 * - HARNESS_REPLAY_ID: HARNESS_REPLAY の中から 1 件だけ再実行するときのシナリオ id
 * - HARNESS_STRICT=1: 壊れが 1 件でもあれば失敗扱いにする（既定は一覧を出すだけで成功）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidates, formatReport, scenariosFromJson, summarize, toFailureFile } from './report.ts'
import { buildSweep, DEFAULT_SWEEP, runAll } from './sweep.ts'

const env = process.env

const FAMILIES = ['effect-matrix', 'enemy-skill', 'stack-order', 'reaction-chain', 'random']

/** 入力の誤りは黙って無視せずエラーで止める（NaN で 0 件になる、未知の族名が素通りする、を防ぐ） */
function intEnv(name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name}=${raw} は 0 以上の整数にしてください`)
  }
  return n
}

function skipEnv() {
  const list = env.HARNESS_SKIP?.split(',').filter(Boolean) ?? []
  for (const f of list) {
    if (!FAMILIES.includes(f)) {
      throw new Error(`HARNESS_SKIP の族名 "${f}" は無効です。有効な値: ${FAMILIES.join(', ')}`)
    }
  }
  return list
}

describe('battle-harness', () => {
  it('総当たり / 再現', { timeout: 30 * 60 * 1000 }, () => {
    const out =
      env.HARNESS_OUT ?? (env.HARNESS_REPLAY ? 'battle-harness-out/replay' : 'battle-harness-out')
    let scenarios
    if (env.HARNESS_REPLAY) {
      const json = JSON.parse(readFileSync(env.HARNESS_REPLAY, 'utf8'))
      scenarios = scenariosFromJson(json, env.HARNESS_REPLAY_ID)
      expect(scenarios.length, '再現するシナリオが見つからない').toBeGreaterThan(0)
    } else {
      const cfg = {
        randomSeed: intEnv('HARNESS_SEED', DEFAULT_SWEEP.randomSeed),
        randomCount: intEnv('HARNESS_RANDOM_COUNT', DEFAULT_SWEEP.randomCount),
        skip: skipEnv(),
      }
      scenarios = buildSweep(cfg)
    }
    const results = runAll(scenarios)
    const summary = summarize(results)
    const text = formatReport(summary, candidates(results), results)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'report.md'), text)
    const failuresPath = join(out, 'failures.json')
    // 再現の読み込み元を上書きして総当たりの一覧を消さない
    if (!env.HARNESS_REPLAY || resolve(failuresPath) !== resolve(env.HARNESS_REPLAY)) {
      writeFileSync(failuresPath, JSON.stringify(toFailureFile(scenarios, results), null, 1))
    }
    process.stdout.write('\n' + text + `\n出力: ${join(out, 'report.md')} / failures.json\n`)
    if (env.HARNESS_STRICT === '1') expect(summary.broken).toBe(0)
  })
})
