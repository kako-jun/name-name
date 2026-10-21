/**
 * 検証ハーネスの検出器 (#877 段階 3)。戦闘の状態（`BattleState`）を見て「壊れ」を見つける純粋関数だけを置く。
 * 検出のみ: 何も修正せず、上限の有効化もしない。
 *
 * 機械判定できる「壊れ」: NaN/Infinity・負の HP/MP・maxHp/maxMp 超過・ダメージ上限違反・ダメージ表示の向き違反・
 * 勝敗と生存者の食い違い・ATB の不変条件違反・ログの `NaN` / `Infinity` / `undefined`。
 * 時間をまたぐもの（ロック・無限ループ・例外）は `run.ts` が判定する。
 */
import { ATB_GAUGE_MAX, type BattleActionEvent, type BattleState } from '../battleEngine'
import type { BattleEntity } from '../spellDsl'
import { MAX_STATUS_TURNS } from '../battleLimits'
import { MAX_ELEMENT_LAYERS } from '../magicite'
import { tracksDamage } from '../enemyAi'
import { MAX_LOOT_COUNT } from '../loot'

export type ViolationKind =
  | 'non-finite' // NaN / Infinity が状態・イベントに入った
  | 'unsafe-integer' // HP・量が Number.MAX_SAFE_INTEGER 超
  | 'negative-hp'
  | 'negative-mp'
  | 'hp-over-max'
  | 'mp-over-max'
  | 'damage-over-cap' // 1 ヒットのダメージ量が上限（MAX_DAMAGE）超
  | 'hit-direction' // damage のヒットで HP が増えた / heal のヒットで HP が減った / 量が負
  | 'bad-log-text' // ログに NaN / Infinity / undefined が出た
  | 'phase-mismatch' // 勝敗・フェーズと生存者の食い違い（進行不能を含む）
  | 'atb-invariant' // ATB のゲージ・キューの不変条件違反
  | 'lock' // 何も起きない（HP/状態もイベントも変わらない）まま進行しない（行動不能の永久連鎖）
  | 'stalemate' // 行動は起きているが攻撃だけでは HP が減り切らず決着がつかない（回復と攻撃が釣り合う）。壊れでなく要判断
  | 'event-flood' // 1 操作でイベントが異常に増えた（無限ループの疑い）
  | 'rng-budget' // 1 操作の乱数消費が予算超（無限ループの疑い）
  | 'slow-op' // 1 操作が極端に遅い（無限ループの疑い）
  | 'status-invariant' // 宣言した状態の不変条件違反（残りターンが整数でない・上限超・倒れた者に残る・status イベントの形が違う）(#870)
  | 'damage-memory' // `ダメージ…` を書いた敵の記憶 lastDamage が、直前の味方の行動が与えた表示数字の合計と食い違う（数字が出なかったのに前回値が残る等）(#871)
  | 'script-invariant' // 脚本の進行の不変条件違反（ターン・発動済み・参戦・逃走の整合、hpFloor の範囲、script の無い戦闘に脚本の状態・interrupted）(#741)
  | 'script-outcome' // 脚本のシナリオが、期待した終わり方（`scriptExpect.ends`）・ターン上限（`maxTurn`）を守らない (#741)
  | 'script-no-end' // 終わるはずの脚本のシナリオが、自動進行の上限まで決着しなかった（膠着・進行不能）(#741)
  | 'magicite-invariant' // 魔石 (#889) の不変条件違反（通常攻撃の属性が 2 つを超える・召喚済みの印が真偽でない・同じ味方が 2 回召喚した・召喚したのに印が立たない）
  | 'summon-invariant' // 召喚獣の演出 (#750) の不変条件違反（宣言していない召喚獣の演出が付いた・skill 以外のイベントに付いた・名前や id が空・画像/効果音が文字列でない）
  | 'loot-invariant' // 戦利品の不変条件違反（宣言していない品・個数が正の整数でない・ドロップが勝利以外で出た・盗めた回数が上限超・レア枠でない品が rare）(#831)
  | 'exception' // エンジンが例外を投げた

/** 壊れと断定しない（人間が見て判断する）種類。これだけのシナリオは「壊れ」に数えない */
export const WARN_KINDS: readonly ViolationKind[] = ['stalemate']

export const isBroken = (v: Violation): boolean => !WARN_KINDS.includes(v.kind)

export interface Violation {
  kind: ViolationKind
  detail: string
  /** 何番目の操作の直後か。-1 = 初期状態、ops.length 以上 = 操作列の後の自動進行 */
  opIndex: number
}

export interface DetectOptions {
  /** 1 ヒットのダメージ上限（既定 9999 = kako-jun 決定。`battleLimits.MAX_DAMAGE`） */
  maxDamage: number
  /** 宣言した状態の id (#870)。あれば、その id の残りターン・倒れた者に残っていないか・status イベントの形を検査する */
  statusIds?: readonly string[]
  /**
   * 脚本制御の戦闘 (#741) のシナリオ。あれば `BattleState.script` の整合（ターン・発動済み・参戦・逃走・hpFloor）を検査し、
   * 脚本が決めた勝敗（生存者と食い違う victory / defeat、interrupted）を許す。`ruleCount` は解釈済みルールの数（発動済み index の範囲）
   */
  script?: { ruleCount: number }
  /**
   * シナリオが宣言した召喚獣の演出の id (#750。`cue.id`)。イベントの `summon` はこの id のものだけが許され、
   * 宣言の無いシナリオ（undefined）は `summon` が 1 件でも付いたら違反（召喚獣を使わない戦闘は従来と同じイベントの形、の検査）
   */
  summonCueIds?: readonly string[]
  /**
   * 敵ごとの戦利品の宣言 (#831)。キーは敵の id。あれば `BattleState.loot` を、宣言した品だけか・レア枠の印が合うか・
   * 盗めた回数が上限内か・個数が 1〜`MAX_LOOT_COUNT` の整数か・ドロップが勝利のときだけかで検査する。
   * 宣言の無いシナリオは検査しない（`state.loot` が積まれていたら宣言が無い敵の品として違反）
   */
  loot?: Readonly<
    Record<
      string,
      {
        normal: readonly string[]
        rare: readonly string[]
        drops: readonly string[]
        limit: number
      }
    >
  >
}

const OVER_PHASES = ['victory', 'defeat', 'escaped', 'interrupted']
const BAD_TEXT = /NaN|Infinity|undefined/

type Push = (kind: ViolationKind, detail: string) => void

function checkNumber(push: Push, where: string, v: unknown): void {
  if (typeof v !== 'number') return
  if (!Number.isFinite(v)) push('non-finite', `${where} = ${String(v)}`)
}

/** 宣言した状態 (#870) の不変条件: 残りターンは 1〜上限の整数、倒れた者には残らない */
function checkDeclaredStatuses(
  push: Push,
  w: string,
  e: BattleEntity,
  ids: readonly string[] | undefined
): void {
  if (!ids || ids.length === 0) return
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(e.status ?? {}, id)) continue
    const v = e.status?.[id]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue // 非有限は non-finite で報告済み
    if (!Number.isInteger(v) || v < 0 || v > MAX_STATUS_TURNS) {
      push(
        'status-invariant',
        `${w}.status.${id} = ${v}（0〜${MAX_STATUS_TURNS} の整数であるべき）`
      )
    } else if (v > 0 && e.hp <= 0) {
      push('status-invariant', `${w}: 倒れているのに状態 ${id} が残っている (${v})`)
    }
  }
}

/** 魔石 (#889) の不変条件: 通常攻撃の属性は文字列で最大 `MAX_ELEMENT_LAYERS` 個、召喚済みの印は真（立てるときだけ）か未指定 */
function checkMagiciteEntity(push: Push, w: string, e: BattleEntity): void {
  if (e.attackElements !== undefined) {
    const els: unknown = e.attackElements
    if (
      !Array.isArray(els) ||
      els.length > MAX_ELEMENT_LAYERS ||
      els.some((x) => typeof x !== 'string' || x === '')
    ) {
      push(
        'magicite-invariant',
        `${w}.attackElements = ${JSON.stringify(els)}（空でない文字列が最大 ${MAX_ELEMENT_LAYERS} 個であるべき）`
      )
    }
  }
  if (e.summoned !== undefined && e.summoned !== true) {
    push('magicite-invariant', `${w}.summoned = ${String(e.summoned)}（真か未指定であるべき）`)
  }
}

function checkEntity(
  push: Push,
  side: string,
  i: number,
  e: BattleEntity,
  opts: DetectOptions
): void {
  const w = `${side}[${i}] ${e.name}`
  checkDeclaredStatuses(push, w, e, opts.statusIds)
  checkMagiciteEntity(push, w, e)
  for (const k of ['hp', 'maxHp', 'mp', 'maxMp', 'atk', 'def', 'agi'] as const) {
    checkNumber(push, `${w}.${k}`, e[k])
  }
  for (const [k, v] of Object.entries(e.buffs ?? {})) checkNumber(push, `${w}.buffs.${k}`, v)
  for (const [k, v] of Object.entries(e.status ?? {})) checkNumber(push, `${w}.status.${k}`, v)
  if (Number.isFinite(e.hp)) {
    if (e.hp < 0) push('negative-hp', `${w}.hp = ${e.hp}`)
    if (e.hp > Number.MAX_SAFE_INTEGER) push('unsafe-integer', `${w}.hp = ${e.hp}`)
    if (Number.isFinite(e.maxHp) && e.hp > e.maxHp) {
      push('hp-over-max', `${w}.hp = ${e.hp} > maxHp = ${e.maxHp}`)
    }
  }
  if (Number.isFinite(e.mp)) {
    if (e.mp < 0) push('negative-mp', `${w}.mp = ${e.mp}`)
    if (Number.isFinite(e.maxMp) && e.mp > e.maxMp) {
      push('mp-over-max', `${w}.mp = ${e.mp} > maxMp = ${e.maxMp}`)
    }
  }
}

/** 召喚獣の演出 (#750) の不変条件: 宣言した id だけ・`skill` のイベントだけ・名前と id は空でない文字列・画像/効果音は空でない文字列か無い・想像/向きは型どおり */
function checkSummonCue(push: Push, ev: BattleActionEvent, opts: DetectOptions): void {
  const cue: unknown = ev.summon
  if (cue === undefined) return
  const w = `event#${ev.seq}.summon`
  if (!opts.summonCueIds) {
    push('summon-invariant', `${w}: 召喚獣の演出を宣言していないシナリオに付いた`)
    return
  }
  if (typeof cue !== 'object' || cue === null) {
    push('summon-invariant', `${w} = ${String(cue)}（オブジェクトであるべき）`)
    return
  }
  const c = cue as Record<string, unknown>
  if (ev.kind !== 'skill') push('summon-invariant', `${w}: kind=${ev.kind}（skill であるべき）`)
  for (const k of ['id', 'name'] as const) {
    if (typeof c[k] !== 'string' || c[k] === '') {
      push('summon-invariant', `${w}.${k} = ${String(c[k])}（空でない文字列であるべき）`)
    }
  }
  if (typeof c.id === 'string' && !opts.summonCueIds.includes(c.id)) {
    push('summon-invariant', `${w}.id = ${c.id}（宣言した召喚獣のどれでもない）`)
  }
  for (const k of ['image', 'se'] as const) {
    if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k] === '')) {
      push('summon-invariant', `${w}.${k} = ${String(c[k])}（空でない文字列か未指定であるべき）`)
    }
  }
  if (c.imaginary !== undefined && c.imaginary !== true) {
    push('summon-invariant', `${w}.imaginary = ${String(c.imaginary)}（真か未指定であるべき）`)
  }
  if (c.faces !== undefined && c.faces !== 'left') {
    push('summon-invariant', `${w}.faces = ${String(c.faces)}（'left' か未指定であるべき）`)
  }
}

function checkEvents(push: Push, events: readonly BattleActionEvent[], opts: DetectOptions): void {
  for (const ev of events) {
    checkSummonCue(push, ev, opts)
    // 状態異常の継続ダメージ・満了 (#870): 本人の記録（actor = 対象 1 件）
    if (ev.kind === 'status') {
      const own = ev.hits.every(
        (h) => h.target.side === ev.actor.side && h.target.index === ev.actor.index
      )
      if (ev.hits.length === 0 || !own) {
        push(
          'status-invariant',
          `event#${ev.seq} (status): actor 本人だけを対象にした 1 件以上のヒットであるべき`
        )
      }
    }
    ev.hits.forEach((h, k) => {
      const w = `event#${ev.seq}.hits[${k}] (${h.kind})`
      checkNumber(push, `${w}.amount`, h.amount)
      checkNumber(push, `${w}.hpBefore`, h.hpBefore)
      checkNumber(push, `${w}.hpAfter`, h.hpAfter)
      if (h.amount > Number.MAX_SAFE_INTEGER) push('unsafe-integer', `${w}.amount = ${h.amount}`)
      // 即死 (instantDeath) は上限の対象外（HP を直接 0 にする。数字は出さない）
      // 除外するのは正しく付いた印だけ（instantDeath かつ HP が 0 になり amount が前後差と一致）。誤ってフラグだけ付いた上限超過は隠さない
      const genuineKill =
        h.instantDeath === true && h.hpAfter === 0 && h.amount === h.hpBefore - h.hpAfter
      if (h.kind === 'damage' && !genuineKill && h.amount > opts.maxDamage) {
        push('damage-over-cap', `${w}.amount = ${h.amount} > ${opts.maxDamage}`)
      }
      if (h.amount < 0) push('hit-direction', `${w}.amount = ${h.amount}（負の量）`)
      if (h.kind === 'damage' && h.hpAfter > h.hpBefore) {
        push('hit-direction', `${w}: damage なのに HP が ${h.hpBefore} → ${h.hpAfter} に増えた`)
      }
      if (h.kind === 'heal' && h.hpAfter < h.hpBefore) {
        push('hit-direction', `${w}: heal なのに HP が ${h.hpBefore} → ${h.hpAfter} に減った`)
      }
    })
  }
}

/**
 * 受けたダメージの記憶 (#871): `ダメージ…` を書いた敵の `lastDamage` は、直前の味方の行動 1 回がその敵に与えた表示数字（即死でない damage ヒットの合計。0 を含む）。
 * 数字が出なかった（MISS・無効・吸収・即死のみ・対象外）ときは値なしで、前回の値が残ってはならない。
 * 直前の操作で味方の行動（attack / spell / item / skill）が記録されたときだけ見る
 */
function checkDamageMemory(
  push: Push,
  s: Readonly<BattleState>,
  newEvents: readonly BattleActionEvent[]
): void {
  const memory = s.enemyMemory
  if (!memory) return
  let last: BattleActionEvent | undefined
  for (const ev of newEvents) {
    if (ev.actor.side === 'party' && ev.kind !== 'status' && ev.kind !== 'notice') last = ev
  }
  if (!last) return
  const expected = new Map<number, number>()
  for (const h of last.hits) {
    if (h.kind !== 'damage' || h.instantDeath || h.target.side !== 'enemy') continue
    expected.set(h.target.index, (expected.get(h.target.index) ?? 0) + h.amount)
  }
  s.enemies.forEach((e, i) => {
    if (!tracksDamage(e)) return
    const got = memory[i]?.lastDamage
    const want = expected.get(i)
    if (got !== want) {
      push(
        'damage-memory',
        `enemies[${i}] ${e.name}: lastDamage = ${String(got)}（直前の行動 event#${last.seq} が与えた表示数字は ${want === undefined ? '無し' : want}）`
      )
    }
  })
}

function checkPhase(push: Push, s: BattleState, scripted: boolean): void {
  const over = OVER_PHASES.includes(s.phase)
  const partyAlive = s.party.some((p) => p.hp > 0)
  const enemiesAlive = s.enemies.some((e) => e.hp > 0)
  if (!over && !partyAlive) push('phase-mismatch', `味方が全員倒れているのに phase = ${s.phase}`)
  if (!over && !enemiesAlive) push('phase-mismatch', `敵が全員倒れているのに phase = ${s.phase}`)
  // 脚本が決めた勝敗（`固定` `終了`）は、生存者と食い違ってよい。interrupted は脚本の戦闘にだけある
  if (!scripted) {
    if (s.phase === 'victory' && enemiesAlive)
      push('phase-mismatch', 'victory なのに敵が生きている')
    if (s.phase === 'defeat' && partyAlive) push('phase-mismatch', 'defeat なのに味方が生きている')
  }
}

/** 脚本の進行の不変条件 (#741)。`opts.script` が無い（脚本の無い戦闘）なら、脚本の状態・hpFloor・interrupted が無いことを見る */
function checkScript(push: Push, s: BattleState, opts: DetectOptions): void {
  const decl = opts.script
  const st = s.script
  if (!decl) {
    if (st !== undefined) push('script-invariant', '脚本の無い戦闘に state.script がある')
    if (s.phase === 'interrupted') push('script-invariant', '脚本の無い戦闘が interrupted になった')
    for (const e of [...s.party, ...s.enemies]) {
      if (e.hpFloor !== undefined) push('script-invariant', `脚本の無い戦闘で ${e.name} に hpFloor`)
    }
    return
  }
  if (!st) {
    push('script-invariant', '脚本のある戦闘に state.script が無い')
    return
  }
  if (!Number.isInteger(st.turn) || st.turn < 0)
    push('script-invariant', `turn = ${String(st.turn)}`)
  const uniqueInts = (label: string, list: readonly number[], max: number): void => {
    if (new Set(list).size !== list.length)
      push('script-invariant', `${label} に重複 [${list.join(',')}]`)
    for (const v of list) {
      if (!Number.isInteger(v) || v < 0 || v >= max) {
        push('script-invariant', `${label} に範囲外の値 ${String(v)}（0〜${max - 1}）`)
      }
    }
  }
  uniqueInts('fired', st.fired, decl.ruleCount)
  uniqueInts('fled', st.fled, s.enemies.length)
  for (const i of st.fled) {
    if (s.enemies[i] && s.enemies[i].hp !== 0)
      push('script-invariant', `逃げた敵 ${i} の HP が 0 でない`)
  }
  if (new Set(st.joined).size !== st.joined.length) {
    push('script-invariant', `joined に重複 [${st.joined.join(',')}]`)
  }
  for (const id of st.joined) {
    if (!s.party.some((p) => p.id === id))
      push('script-invariant', `参戦したはずの ${id} が味方にいない`)
  }
  if (s.party.length < 1) push('script-invariant', '味方がいない')
  for (const [side, list] of [
    ['party', s.party],
    ['enemies', s.enemies],
  ] as const) {
    list.forEach((e, i) => {
      if (e.hpFloor === undefined) return
      if (!Number.isInteger(e.hpFloor) || e.hpFloor < 1 || e.hpFloor > e.maxHp) {
        push(
          'script-invariant',
          `${side}[${i}] ${e.name}.hpFloor = ${String(e.hpFloor)}（1〜maxHp の整数であるべき）`
        )
      }
    })
  }
}

/** `battleEngineAtb.test.ts` の不変条件（ゲージ 0..1000・キューは生存者のみで重複なし・フェーズ整合）を移した */
function checkAtb(push: Push, s: BattleState): void {
  const atb = s.atb
  if (!atb) return
  for (const g of [...atb.partyGauge, ...atb.enemyGauge]) {
    if (!Number.isFinite(g)) push('non-finite', `ATB ゲージ = ${String(g)}`)
    else if (g < 0 || g > ATB_GAUGE_MAX)
      push('atb-invariant', `ゲージ ${g} が 0..${ATB_GAUGE_MAX} の外`)
  }
  if (new Set(atb.queue).size !== atb.queue.length) {
    push('atb-invariant', `キューに重複 [${atb.queue.join(',')}]`)
  }
  for (const i of atb.queue) {
    if (!(s.party[i]?.hp > 0)) push('atb-invariant', `キューに倒れた/不在の味方 ${i}`)
    else if (atb.partyGauge[i] !== ATB_GAUGE_MAX) {
      push('atb-invariant', `キューの味方 ${i} のゲージが満タンでない (${atb.partyGauge[i]})`)
    }
  }
  s.party.forEach((p, i) => {
    if (p.hp <= 0 && atb.partyGauge[i] !== 0) {
      push('atb-invariant', `倒れた味方 ${i} のゲージが 0 でない (${atb.partyGauge[i]})`)
    }
  })
  if (!OVER_PHASES.includes(s.phase)) {
    const want = atb.queue.length > 0 ? 'party-input' : 'atb-running'
    if (s.phase !== want)
      push('atb-invariant', `phase = ${s.phase}（キュー ${atb.queue.length} 件なら ${want}）`)
  }
  if (s.phase === 'enemy-turn') push('atb-invariant', 'ATB なのに phase = enemy-turn')
}

/**
 * 状態 1 つを検査して違反を返す。`newEvents` は直前の操作で増えたイベントだけを渡す（過去分を再報告しない）。
 * `opIndex` は違反にそのまま付ける。
 */
export function checkState(
  state: Readonly<BattleState>,
  newEvents: readonly BattleActionEvent[],
  opIndex: number,
  opts: DetectOptions
): Violation[] {
  const out: Violation[] = []
  const push: Push = (kind, detail) => out.push({ kind, detail, opIndex })
  state.party.forEach((e, i) => checkEntity(push, 'party', i, e, opts))
  state.enemies.forEach((e, i) => checkEntity(push, 'enemies', i, e, opts))
  checkNumber(push, 'earnedExp', state.earnedExp)
  checkNumber(push, 'earnedGold', state.earnedGold)
  checkEvents(push, newEvents, opts)
  for (const line of state.log) {
    if (BAD_TEXT.test(line)) push('bad-log-text', `ログ「${line}」`)
  }
  checkDamageMemory(push, state, newEvents)
  checkPhase(push, state, opts.script !== undefined)
  checkScript(push, state, opts)
  checkAtb(push, state)
  checkLoot(push, state, opts)
  return out
}

/** 戦利品の不変条件 (#831)。`state.loot` が無い（戦利品なしの戦闘）ならそもそも検査しない */
function checkLoot(push: Push, s: BattleState, opts: DetectOptions): void {
  const loot = s.loot
  if (loot === undefined) return
  if (!Array.isArray(loot) || loot.length === 0) {
    push('loot-invariant', `state.loot が空配列か配列でない（積むまでは undefined のはず）`)
    return
  }
  const decl = opts.loot ?? {}
  const stolen = new Map<string, number>()
  loot.forEach((e, i) => {
    const w = `loot[${i}]`
    if (!Number.isInteger(e.count) || e.count < 1 || e.count > MAX_LOOT_COUNT) {
      push('loot-invariant', `${w}.count = ${String(e.count)} が 1〜${MAX_LOOT_COUNT} の整数でない`)
    }
    if (e.via !== 'drop' && e.via !== 'steal') push('loot-invariant', `${w}.via = ${String(e.via)}`)
    if (typeof e.itemId !== 'string' || e.itemId === '') {
      push('loot-invariant', `${w}.itemId が空`)
    }
    const d = Object.prototype.hasOwnProperty.call(decl, e.enemyId) ? decl[e.enemyId] : undefined
    if (!d) {
      push('loot-invariant', `${w}: 戦利品を宣言していない敵 '${e.enemyId}' から ${e.itemId}`)
      return
    }
    if (e.via === 'drop') {
      if (s.phase !== 'victory') push('loot-invariant', `${w}: 勝利でないのにドロップ (${s.phase})`)
      if (e.rare) push('loot-invariant', `${w}: ドロップに rare が付いている`)
      if (!d.drops.includes(e.itemId)) {
        push('loot-invariant', `${w}: 宣言に無いドロップ '${e.itemId}' (${e.enemyId})`)
      }
    } else {
      const slot = e.rare ? d.rare : d.normal
      if (!slot.includes(e.itemId)) {
        push(
          'loot-invariant',
          `${w}: ${e.rare ? 'レア' : '通常'}枠に無い品 '${e.itemId}' を盗んだ (${e.enemyId})`
        )
      }
      stolen.set(e.enemyId, (stolen.get(e.enemyId) ?? 0) + 1)
    }
  })
  for (const [enemyId, n] of stolen) {
    const limit = decl[enemyId]?.limit ?? 0
    if (n > limit) push('loot-invariant', `敵 '${enemyId}' から ${n} 回盗めた（上限 ${limit}）`)
  }
  // ドロップは盗みの後（勝利の瞬間）にだけ積まれる: ドロップのあとに盗みが来たら順序違反
  const firstDrop = loot.findIndex((e) => e.via === 'drop')
  if (firstDrop !== -1 && loot.slice(firstDrop).some((e) => e.via === 'steal')) {
    push('loot-invariant', 'ドロップのあとにぬすんだ品が積まれた')
  }
}

/** ロック判定用の指紋。HP/MP/状態/バフ/フェーズ/ATB ゲージ。同じ指紋が続けば「何も進んでいない」 */
export function fingerprint(s: Readonly<BattleState>): string {
  return JSON.stringify([
    s.phase,
    s.party.map((e) => [e.hp, e.mp, e.status, e.buffs]),
    s.enemies.map((e) => [e.hp, e.mp, e.status, e.buffs]),
    s.atb && [s.atb.partyGauge, s.atb.enemyGauge, s.atb.queue],
    // 脚本のターンは HP が動かなくても進む（上限ターンまで押し続ける戦闘をロックと取り違えない）(#741)
    s.script && [s.script.turn, s.script.fired, s.script.joined, s.script.fled],
  ])
}
