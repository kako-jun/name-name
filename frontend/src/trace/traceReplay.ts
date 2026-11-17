/**
 * トレースからの戦闘の再実行 (#1197)。取り出した JSON（`TraceDump`）の戦闘 1 本ぶんの
 * 「開始時の編成・乱数の種・入力（コマンド）・経過時間」から `BattleEngine` をもう一度動かし、
 * 記録された結果（行動・HP の変化・倒れ・フェーズ・入力権の移動）と突き合わせる。
 * 実画面なしで「実機で起きたこと」を再現するための足場（#1182 のような件の調査用）。
 *
 * 限界（足場として割り切っていること）:
 * - 呪文・特技・アイテムの中身（効果式）は記録しない。コマンドの `ref`（マスターの名前）から `resolve` で引く
 * - `[状態]` の宣言・敵 AI のスキル・脚本など、エンジンのオプションは `engineOptions` で呼び出し側が渡す
 * - 画面側の演出（hpOverride・ポーズ解決）は再実行しない。エンジンの結果だけが対象
 * - 開始時の編成はエンジン構築「後」の値。構築時に乱数を消費する戦闘（脚本の開始など）は乱数列が1つずれうる
 */
import { BattleEngine, type BattleEngineOptions } from '../game/battleEngine'
import type {
  SpellExecution,
  SkillExecution,
  ItemExecution,
  SummonExecution,
} from '../game/battleEngine'
import { attachBattleTrace } from '../game/battleTrace'
import type { BattleEntity } from '../game/spellDsl'
import type { TraceDump, TraceEntry } from './trace'

/** 戦闘 1 本ぶんの記録 */
export interface RecordedBattle {
  bid: number
  start: TraceEntry
  /** 再実行が使う入力: b.cmd / b.adv / b.hold / b.scope（記録順） */
  steps: TraceEntry[]
  /** 突き合わせる結果: b.act / b.hp / b.ko / b.rev / b.phase / b.actor / b.st / b.join（記録順） */
  expected: TraceEntry[]
}

const STEP_KINDS = new Set(['b.cmd', 'b.adv', 'b.hold', 'b.scope', 'b.switch'])
export const COMPARED_KINDS = new Set([
  'b.act',
  'b.hp',
  'b.ko',
  'b.rev',
  'b.phase',
  'b.actor',
  'b.st',
  'b.join',
])

type Rec = Record<string, unknown>
const dataOf = (e: TraceEntry): Rec =>
  e.d && typeof e.d === 'object' && !Array.isArray(e.d) ? (e.d as Rec) : {}

/** 記録（前回分 → 今回分の順）から、戦闘ごとに開始・入力・結果を取り出す。`b.start` が無い（リングから溢れた）戦闘は返さない */
export function extractBattles(dump: Pick<TraceDump, 'prev' | 'session'>): RecordedBattle[] {
  const entries = [...(dump.prev?.entries ?? []), ...dump.session.entries]
  const byId = new Map<number, RecordedBattle>()
  const order: RecordedBattle[] = []
  for (const e of entries) {
    if (!e.k.startsWith('b.')) continue
    const d = dataOf(e)
    const bid = typeof d.bid === 'number' ? d.bid : -1
    if (e.k === 'b.start') {
      // セッションをまたぐと bid が重なりうるので、b.start が来るたびに新しい戦闘にする
      const b: RecordedBattle = { bid, start: e, steps: [], expected: [] }
      byId.set(bid, b)
      order.push(b)
      continue
    }
    const b = byId.get(bid)
    if (!b) continue
    if (STEP_KINDS.has(e.k)) b.steps.push(e)
    if (COMPARED_KINDS.has(e.k)) b.expected.push(e)
  }
  return order
}

/** コマンドの `ref` から実行内容を引く口。戦闘設定（マスター）を持つ呼び出し側が渡す */
export interface ReplayResolvers {
  spell?: (ref: string | null) => SpellExecution | undefined
  skill?: (ref: string | null) => SkillExecution | undefined
  item?: (ref: string | null) => ItemExecution | undefined
  summon?: (ref: string | null) => SummonExecution | undefined
  /** 番の入れ替え（`b.switch`、#1201 のマージ後に配線）。記録の要点を受けてエンジンを動かす。未指定なら無視する */
  switchActor?: (engine: BattleEngine, data: Record<string, unknown>) => void
}

export interface ReplayResult {
  engine: BattleEngine
  /** 再実行で出た結果の記録（`expected` と同じ種類だけ） */
  produced: TraceEntry[]
}

/**
 * 戦闘 1 本を再実行する。乱数は記録した種から。`engineOptions` は `rng` 以外のエンジンのオプション
 * （`atb` は記録した方式を既定にし、渡せばそちらが優先）
 */
export function replayBattle(
  battle: RecordedBattle,
  resolvers: ReplayResolvers = {},
  engineOptions: BattleEngineOptions = {}
): ReplayResult {
  const sd = dataOf(battle.start)
  const seed = typeof sd.seed === 'number' ? sd.seed : undefined
  if (seed === undefined)
    throw new Error('この戦闘は乱数の種が無く再実行できません（トレース on で始めた戦闘のみ対象）')
  const party = (sd.party as unknown as BattleEntity[]).map((e) => structuredClone(e))
  const enemies = (sd.enemies as unknown as BattleEntity[]).map((e) => structuredClone(e))
  const atb = sd.atb as {
    mode?: 'wait' | 'active'
    g?: number[][]
    q?: number[]
  } | null
  const engine = new BattleEngine(party, enemies, {
    seed,
    ...(atb
      ? {
          atb: {
            mode: atb.mode ?? 'wait',
            // セーブからの再開は途中のゲージ・待ちの順から始まる
            ...(atb.g ? { initialGauges: { party: atb.g[0], enemies: atb.g[1] } } : {}),
          },
          ...(atb.q && atb.q.length > 0 ? { restore: { atbQueue: atb.q } } : {}),
        }
      : {}),
    ...engineOptions,
  })
  const produced: TraceEntry[] = []
  let n = 0
  attachBattleTrace(
    engine,
    {},
    {
      force: true,
      sink: (k, d) => {
        if (COMPARED_KINDS.has(k))
          produced.push({
            n: n++,
            t: 0,
            k,
            ...(d === undefined ? {} : { d: d as TraceEntry['d'] }),
          })
      },
    }
  )
  for (const step of battle.steps) {
    const d = dataOf(step)
    switch (step.k) {
      case 'b.adv':
        engine.tick(d.ms as number)
        break
      case 'b.hold':
        engine.setAtbHold(!!d.hold)
        break
      case 'b.scope':
        engine.setAtbWaitScope(d.scope === 'menu' ? 'menu' : 'command')
        break
      case 'b.cmd':
        applyCommand(engine, d, resolvers)
        break
      case 'b.switch':
        resolvers.switchActor?.(engine, d)
        break
    }
  }
  return { engine, produced }
}

function applyCommand(engine: BattleEngine, d: Rec, r: ReplayResolvers): void {
  const ref = typeof d.ref === 'string' ? d.ref : null
  const target = typeof d.tg === 'string' ? d.tg : undefined
  switch (d.c) {
    case 'selectAttack':
      engine.selectAttack(target)
      break
    case 'selectEscape':
      engine.selectEscape()
      break
    case 'selectSpell': {
      const spell = r.spell?.(ref)
      if (spell) engine.selectSpell(spell, target, d.x === 'all' ? 'all' : 'single')
      break
    }
    case 'selectSkill': {
      const skill = r.skill?.(ref)
      if (skill) engine.selectSkill(skill, target)
      break
    }
    case 'selectItem': {
      const item = r.item?.(ref)
      if (item) engine.selectItem(item, target)
      break
    }
    case 'selectSummon': {
      const summon = r.summon?.(ref)
      if (summon) engine.selectSummon(summon, target)
      break
    }
    case 'notifyBlocked':
      engine.notifyBlocked(target ?? ref ?? '')
      break
  }
}

export interface ReplayMismatch {
  index: number
  expected: TraceEntry | null
  actual: TraceEntry | null
}

/** 突き合わせ用の署名。戦闘の通し番号（bid）は記録と再実行で違うので除く */
function signature(e: TraceEntry): string {
  return JSON.stringify(e.d, (key, v) => (key === 'bid' ? undefined : v))
}

/** 記録と再実行を、種類と要点（時刻・通し番号を除く）の列として突き合わせる。一致なら null、最初のずれを返す */
export function firstMismatch(
  expected: readonly TraceEntry[],
  actual: readonly TraceEntry[]
): ReplayMismatch | null {
  const len = Math.max(expected.length, actual.length)
  for (let i = 0; i < len; i++) {
    const a = expected[i]
    const b = actual[i]
    if (!a || !b || a.k !== b.k || signature(a) !== signature(b))
      return { index: i, expected: a ?? null, actual: b ?? null }
  }
  return null
}
