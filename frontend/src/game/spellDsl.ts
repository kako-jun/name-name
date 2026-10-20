/**
 * 呪文 / アイテム の効果 DSL パーサー + 評価器 (#174 / #173)。
 *
 * 設計合意（kako-jun と 2026-05-09 セッションで確定、#176）:
 * - 単純な効果は宣言的 DSL（`heal 15..25` 等）で書き、parser/runtime で網羅評価する
 * - 複雑な振る舞い（ザラキ、ルーラ、メダパニ等）は `builtin: <slug>` で TypeScript 実装に委譲する
 * - 専用関数は引数なしで全責任を持つ（DSL は引数を持つ汎用関数）
 *
 * 本モジュールは前者（汎用関数）の DSL を扱う。BUILTIN は `builtin.ts` を参照。
 *
 * 文法（最低セット、段階的に拡張）:
 *   heal {min}..{max}              # 一様乱数で min..max を回復
 *   heal_full                      # 完全回復
 *   damage {min}..{max} [type=...] [回数=N]
 *                                  # 一様乱数で min..max のダメージ。type は耐性計算用。
 *                                  # 回数=N は 1 回の行動の中でヒットを N 回に増やす (#879。damage 専用)
 *   damage_full                    # 即死
 *   buff {stat}=+{n} duration={t}  # ATK+/DEF+/AGI+ 一定ターン強化
 *   debuff {stat}=-{n} duration={t}
 *   revive [hp=full|hp=half]       # 蘇生
 *   status {state} [duration={t}] [確率={P}]
 *                                  # 毒/麻痺/混乱/眠り など。確率は 0〜99 の整数 %（省略は必中）。
 *                                  # `[状態 id]` で宣言した id は継続ダメージ・行動不能・回復の反転などが働く (#870)
 *   cure {state|all}               # 状態の解除 (#870)
 *   escape_battle                  # 戦闘離脱
 *   escape_dungeon                 # ダンジョン脱出
 *
 * 不正な式は `parseEffect` で `null` を返し、runtime は warning を出して no-op する。
 */

import { hasOwn, safeAssign } from './ownProperty'
import {
  applyDamageToHp,
  clampDamage,
  clampHp,
  MAX_HITS_PER_ACTION,
  MAX_STATUS_CHANCE,
  MAX_STATUS_TURNS,
} from './battleLimits'
import type { BattlePoseSprites } from './battleMotion'
import {
  applyAffinityToDamage,
  DEATH_ATTRIBUTE,
  deathSuccessRate,
  resolveAffinity,
  rollDeath,
  type BattleAffinity,
} from './affinity'
import {
  resolveRuleId,
  reversalOf,
  STATUS_ALIASES,
  statusSuccessRate,
  type StatusRule,
} from './statusEffects'

// 従来どおり spellDsl から読めるように再エクスポートする（定義は statusEffects.ts）
export { STATUS_ALIASES }

export type EffectKind =
  | 'heal'
  | 'heal_full'
  | 'damage'
  | 'damage_full'
  | 'buff'
  | 'debuff'
  | 'revive'
  | 'status'
  | 'cure'
  | 'escape_battle'
  | 'escape_dungeon'

export type StatKey = 'hp' | 'mp' | 'atk' | 'def' | 'agi'

export interface ParsedEffect {
  kind: EffectKind
  /** heal/damage の範囲下限（min と max が同値なら固定値） */
  min?: number
  /** heal/damage の範囲上限 */
  max?: number
  /** damage の系統（fire / ice / holy / breath 等）。耐性計算用 */
  type?: string
  /**
   * damage のヒット数（`回数=N`、2 以上のときだけ付く。未指定・1 は付かない＝従来の経路）(#879)。
   * 上限は `MAX_HITS_PER_ACTION`
   */
  count?: number
  /** パース時の警告（`applyEffect` が戦闘ログに `(警告: …)` として出す。無ければ付かない）(#879) */
  warnings?: string[]
  /** buff/debuff のターゲット ステータス */
  stat?: StatKey
  /** buff/debuff の増減量（`+5` / `-3`） */
  delta?: number
  /** buff/debuff/status の有効ターン */
  duration?: number
  /** revive の hp 指定（full / half、省略時は full） */
  hp?: 'full' | 'half'
  /** status / cure の状態名（poison / paralysis / confusion / sleep 等。cure は `all` で全解除） */
  state?: string
  /**
   * status の付与成功率（%、0〜`MAX_STATUS_CHANCE`、`確率=P`）(#870)。付くのは書いたときだけ。
   * 無い = 必中（従来と同じ。耐性が無ければ乱数も使わない）
   */
  chance?: number
}

/**
 * 効果 DSL 文字列をパースする。文法エラー時は null。
 *
 * 例:
 *   parseEffect("heal 15..25")             → { kind: 'heal', min: 15, max: 25 }
 *   parseEffect("damage 8..14 type=fire")  → { kind: 'damage', min: 8, max: 14, type: 'fire' }
 *   parseEffect("buff atk=+5 duration=3")  → { kind: 'buff', stat: 'atk', delta: 5, duration: 3 }
 *   parseEffect("revive")                  → { kind: 'revive', hp: 'full' }
 *   parseEffect("escape_battle")           → { kind: 'escape_battle' }
 */
export function parseEffect(input: string): ParsedEffect | null {
  const parsed = parseEffectInner(input)
  if (!parsed) return null
  // `回数=` は damage 専用 (#879)。damage 以外に付いていたら無視して警告する（damage 自身の不正値は parseDamage 側で警告済み）
  if (
    parsed.kind !== 'damage' &&
    input
      .trim()
      .split(/\s+/)
      .some((t) => t.startsWith(COUNT_KEY + '='))
  ) {
    parsed.warnings = [...(parsed.warnings ?? []), '回数= は damage 専用のため無視した']
  }
  // `確率=` は status 専用 (#870)
  if (
    parsed.kind !== 'status' &&
    input
      .trim()
      .split(/\s+/)
      .some((t) => t.startsWith(CHANCE_KEY + '='))
  ) {
    parsed.warnings = [...(parsed.warnings ?? []), '確率= は status 専用のため無視した']
  }
  return parsed
}

/** `status` の「付与成功率」キー (#870) */
const CHANCE_KEY = '確率'

/** `damage` の「ヒット数」キー (#879)。`hits` は敵 AI の被弾記憶と被るので使わない */
const COUNT_KEY = '回数'

function parseEffectInner(input: string): ParsedEffect | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  // 単独動詞のキーワード
  if (trimmed === 'heal_full') return { kind: 'heal_full' }
  if (trimmed === 'damage_full') return { kind: 'damage_full' }
  // `damage_full 回数=3` は回数を無視（警告は parseEffect が付ける）。回数以外の余計な語は従来どおり不正
  if (/^damage_full(\s+回数=\S*)+$/.test(trimmed)) return { kind: 'damage_full' }
  if (trimmed === 'escape_battle') return { kind: 'escape_battle' }
  if (trimmed === 'escape_dungeon') return { kind: 'escape_dungeon' }

  const tokens = trimmed.split(/\s+/)
  const verb = tokens[0]
  const rest = tokens.slice(1)

  if (verb === 'heal') {
    const range = parseRange(rest[0])
    if (!range) return null
    return { kind: 'heal', min: range.min, max: range.max }
  }
  if (verb === 'damage') {
    const range = parseRange(rest[0])
    if (!range) return null
    const out: ParsedEffect = { kind: 'damage', min: range.min, max: range.max }
    for (const t of rest.slice(1)) {
      const [k, v] = splitKv(t)
      if (k === 'type' && v) out.type = v
      if (k === COUNT_KEY) {
        const c = parseHitCount(v)
        if (c.warning) out.warnings = [...(out.warnings ?? []), c.warning]
        if (c.count > 1) out.count = c.count
      }
    }
    return out
  }
  if (verb === 'buff' || verb === 'debuff') {
    // 例: "buff atk=+5 duration=3"
    let stat: StatKey | undefined
    let delta: number | undefined
    let duration: number | undefined
    for (const t of rest) {
      const [k, v] = splitKv(t)
      if (!v) continue
      if (k === 'duration') {
        duration = parseInt(v, 10)
      } else if (isStatKey(k)) {
        stat = k
        delta = parseSignedInt(v)
      }
    }
    if (stat === undefined || delta === undefined || !Number.isFinite(delta)) return null
    if (verb === 'debuff' && delta > 0) delta = -delta
    return { kind: verb, stat, delta, duration }
  }
  if (verb === 'revive') {
    let hp: 'full' | 'half' = 'full'
    for (const t of rest) {
      const [k, v] = splitKv(t)
      if (k === 'hp' && (v === 'full' || v === 'half')) hp = v
    }
    return { kind: 'revive', hp }
  }
  if (verb === 'status') {
    if (rest.length === 0) return null
    const state = rest[0]
    let duration: number | undefined
    let chance: number | undefined
    let warnings: string[] | undefined
    for (const t of rest.slice(1)) {
      const [k, v] = splitKv(t)
      if (k === 'duration' && v) duration = parseInt(v, 10)
      if (k === CHANCE_KEY) {
        const c = parseChance(v)
        if (c.warning) warnings = [...(warnings ?? []), c.warning]
        if (c.chance !== undefined) chance = c.chance
      }
    }
    return {
      kind: 'status',
      state,
      duration,
      ...(chance !== undefined ? { chance } : {}),
      ...(warnings ? { warnings } : {}),
    }
  }
  if (verb === 'cure') {
    if (rest.length === 0) return null
    return { kind: 'cure', state: rest[0] }
  }
  return null
}

function parseRange(raw: string | undefined): { min: number; max: number } | null {
  if (!raw) return null
  // "15..25" or "30"
  const m = raw.match(/^(-?\d+)\.\.(-?\d+)$/)
  if (m) {
    const min = parseInt(m[1], 10)
    const max = parseInt(m[2], 10)
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return min <= max ? { min, max } : { min: max, max: min }
  }
  const single = parseInt(raw, 10)
  if (!Number.isNaN(single) && /^-?\d+$/.test(raw)) {
    return { min: single, max: single }
  }
  return null
}

/**
 * `回数=` の値を解釈する (#879)。正の整数だけ有効（0・負・小数・数字以外は警告して 1＝従来どおり）。
 * `MAX_HITS_PER_ACTION` を超えたら上限に切り詰めて警告する。範囲指定（`2..4`）は未対応（不正値として警告）
 */
function parseHitCount(raw: string | undefined): { count: number; warning?: string } {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return { count: 1, warning: `回数=${raw ?? ''} は正の整数でないため 1 回にした` }
  }
  const n = Number(raw)
  if (n < 1) return { count: 1, warning: `回数=${raw} は 1 以上でないため 1 回にした` }
  if (n > MAX_HITS_PER_ACTION) {
    return {
      count: MAX_HITS_PER_ACTION,
      warning: `回数=${raw} は上限 ${MAX_HITS_PER_ACTION} を超えたため ${MAX_HITS_PER_ACTION} 回にした`,
    }
  }
  return { count: n }
}

/**
 * `確率=` の値を解釈する (#870)。0 以上の整数 % だけ有効。`MAX_STATUS_CHANCE`（99）を超えたら 99 に切って警告する。
 * 負の整数は 0（必ず外れる）に切って警告する（誤記で必中にならない安全側）。それ以外の整数でない値は警告して未指定＝必中に落とす
 */
function parseChance(raw: string | undefined): { chance?: number; warning?: string } {
  if (raw !== undefined && /^-\d+$/.test(raw)) {
    return { chance: 0, warning: `確率=${raw} は負のため 0 にした（必ず外れる）` }
  }
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return { warning: `確率=${raw ?? ''} は 0〜${MAX_STATUS_CHANCE} の整数でないため必中にした` }
  }
  const n = Number(raw)
  if (n > MAX_STATUS_CHANCE) {
    return {
      chance: MAX_STATUS_CHANCE,
      warning: `確率=${raw} は上限 ${MAX_STATUS_CHANCE} を超えたため ${MAX_STATUS_CHANCE} にした`,
    }
  }
  return { chance: n }
}

function splitKv(token: string): [string, string | undefined] {
  const eq = token.indexOf('=')
  if (eq < 0) return [token, undefined]
  return [token.slice(0, eq), token.slice(eq + 1)]
}

function parseSignedInt(value: string): number {
  // "+5" / "-3" / "5" を許容
  const cleaned = value.startsWith('+') ? value.slice(1) : value
  const n = parseInt(cleaned, 10)
  return Number.isFinite(n) ? n : NaN
}

function isStatKey(k: string): k is StatKey {
  return k === 'hp' || k === 'mp' || k === 'atk' || k === 'def' || k === 'agi'
}

/**
 * 効果評価のための実行コンテキスト。
 * - caster: 効果を発動した側（味方/敵）
 * - targets: 効果を受ける対象配列。target スコープに応じて呼び出し側で 1 体 or 全体を渡す
 * - rng: 0..1 の一様乱数を返す関数（テスト時に固定値で差し替え可能）
 */
export interface EffectContext {
  caster: BattleEntity
  targets: BattleEntity[]
  rng: () => number
  /**
   * 計算上のダメージ・回復量の通知 (#745)。FF 式のダメージ数字は、HP が実際に減った・増えた量ではなく
   * 計算した量（オーバーキル・回復の上限切りを含む）を出すので、効果の評価側が 1 対象ごとに知らせる。
   * 通知しない効果（builtin など）は呼び出し側が HP の前後差で代用する。
   */
  onAmount?: (
    target: BattleEntity,
    kind: 'damage' | 'heal',
    amount: number,
    reversed?: boolean
  ) => void
  /**
   * 即死で倒したことの通知 (#877)。`damage_full` の成功時と builtin の即死が呼ぶ。即死は HP をそのまま 0 にするので
   * ダメージの数字を持たない（`onAmount` は呼ばない）。戦闘側は hits に `instantDeath` を付け、数字を出さず「たおれた」だけにする
   */
  onKill?: (target: BattleEntity) => void
  /**
   * 複数ヒットの乗り換え先 (#879)。行動者から見て**相手陣営の単体**を狙う `回数=N` で、標的が途中で倒れたら、ここ（相手陣営の全員）の
   * 並び順で先頭の生存者へ残りのヒットを回す。エンジンが渡す。自分・仲間を狙うとき・未指定は乗り換え先なし
   * （標的が倒れたら残りは打ち切り。仲間に流さない）
   */
  pool?: BattleEntity[]
  /**
   * 複数ヒット（`回数=N` で N>=2）の 1 ヒットごとの通知 (#879)。呼ばれる順が再生順。
   * `round` は 0 始まりのヒット番号（全体対象は巡の番号）。`miss` は無効（耐性 0・属性無効）など HP が動かないヒット。
   * `回数` を使わない効果では呼ばれない（従来の `onAmount` と HP 前後差の経路のまま）。`onAmount` は複数ヒットでも従来どおり呼ぶ
   */
  onHit?: (
    target: BattleEntity,
    kind: 'damage' | 'heal' | 'miss',
    amount: number,
    round: number,
    reversed?: boolean
  ) => void
  /**
   * 状態の規則 (#870)。エンジンが `[状態]` から作って渡す。あれば `status` / `cure` の id を規則に引き、
   * 回復・ダメージの反転（`reversalOf`）を `heal` / `damage` に適用する。無い・空は従来どおり（状態は印が付くだけ）
   */
  statusRules?: Readonly<Record<string, StatusRule>>
  /**
   * `status` で状態を書いた通知 (#870)。`key` は書いた状態の id（宣言した状態は規則の id、印だけの状態は DSL に書かれた名前）。
   * エンジンが、今の手番の中で付いた状態をその手番の終わりに減らさないために使う
   */
  onStatus?: (target: BattleEntity, key: string, change?: 'apply' | 'cure') => void
}

/** 戦闘エンティティ（味方/敵共通の最小スキーマ） */
export interface BattleEntity {
  id: string
  name: string
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  atk: number
  def: number
  agi: number
  /** type 別耐性（'fire' → 0.5 = 半減 / 1.0 = 等倍 / 0 = 無効 / 2.0 = 弱点）。未指定は 1.0 */
  resist?: Partial<Record<string, number>>
  /**
   * 属性相性 (#872)。`MonsterDef.affinity`（`弱点:` / `半減:` / `無効:` / `吸収:`）を戦闘への組み立て時に写す。
   * 呪文・特技・アイテムの `damage` / `damage_full` が、吸収 > 無効 > 半減 > 弱点の順に判定する（`resolveAffinity`）。
   * どれにも該当しなければ従来の `resist` を見る。通常攻撃は見ない（未対応）。無い敵は従来どおり
   */
  affinity?: BattleAffinity
  /** 状態異常（毒/麻痺/混乱/眠り など）。値は残ターン。`[状態]` で宣言した id はエンジンが手番ごとに減らす (#870) */
  status?: Partial<Record<string, number>>
  /**
   * この者が付ける状態の付与成功率に足す点（%）(#870)。魔法の成長（使うほど状態異常魔法の成功率が上がる、#882）が埋める口。
   * 未指定は 0。足した後も `MAX_STATUS_CHANCE`（99%）で頭打ち。`確率=` を書かない付与（必中）には効かない
   */
  statusChanceBonus?: number
  /** buff / debuff の累積値（atk+5 等）。残ターン管理は将来 Issue */
  buffs?: Partial<Record<StatKey, number>>
  /** 倒したときに得られる経験値（敵側のみ、味方は undefined） */
  exp?: number
  /** 倒したときに落とすゴールド（敵側のみ） */
  gold?: number
  /**
   * 戦闘画面に描くスプライト画像のパス (#736)。`MonsterDef.sprite` / `PartyMemberDef.sprite` を
   * 戦闘への組み立て時に写す。未指定・読み込み失敗時は色四角で描く（サイドビューのみ参照、
   * 戦闘エンジンは読まない）。
   */
  sprite?: string
  /**
   * 戦闘ポーズ別スプライト (#745)。`MonsterDef.poses` / `PartyMemberDef.poses` を戦闘への組み立て時に正規化して写す。
   * `battle_presentation: ff` のときだけ画面が局面ごとに差し替える（dq では読まない）。部分指定可、無いポーズは `sprite` のまま。
   */
  poses?: BattlePoseSprites
  /**
   * 戦闘の隊列 (#747)。`'back'` = 後衛（受ける物理ダメージ・与える近接物理ダメージが半分。魔法相当は影響なし）。
   * 未指定は前衛（現行どおり）。味方・敵のどちらに付けても補正は効く（汎用エンジンとして敵の後衛も認める。配置の描画は味方側のみ）。
   */
  row?: BattleRow
  /**
   * 敵の行動ルール (#835)。`MonsterDef.actions` を戦闘への組み立て時に写す生文字列（書いた順）。
   * 解釈・選択は `enemyAi.ts` の `chooseEnemyAction`。無い（または空の）敵は従来どおり通常攻撃だけで、乱数の消費も変わらない
   */
  actions?: string[]
  /** 敵の反撃ルール (#837)。`MonsterDef.counters`（`反撃:` の値の生文字列、書いた順）を戦闘への組み立て時に写す。解釈は `enemyAi.ts` */
  counters?: string[]
  /** 敵の死亡時の行動 (#837)。`MonsterDef.onDeath`（`死亡時:` の値の生文字列）を写す。倒されたとき 1 度だけ実行する */
  onDeath?: string
  /**
   * 敵の隊形上の大きさと配置指定 (#839)。`MonsterDef.size` / `scale` と群の配置 `@C1` を、戦闘への組み立て時（`rollEncounter`）に写す。
   * `size` / `scale` / 配置のどれも無い敵（従来の定義・群）は付かない＝従来の挙動のまま。
   * 描画専用のマスターデータで、戦闘エンジン（`battleEngine.ts`）は読まない。`battle_enemy_grid` が有効なときだけ描画（`BattleScreen` / `computeSideBattleLayout`、#839 段4）が使う。
   */
  layout?: EnemyLayout
}

/** 敵の隊形上の大きさ・倍率・配置指定 (#839) */
export interface EnemyLayout {
  /** サイズ区分（占有セル数）。`サイズ:` 未指定は 1 */
  w: number
  h: number
  /** 表示倍率（0.25〜1）。`倍率:` 未指定は 1 */
  scale: number
  /** 群の配置指定 `@C1`（0 始まりの列・行。未指定は自動配置）。`placeEnemies` の `PlacementItem.at` にそのまま渡す */
  at?: { col: number; row: number }
}

/** 戦闘の隊列 (#747) */
export type BattleRow = 'front' | 'back'

/**
 * 解釈済み効果を実行する。コンテキストの targets を直接ミューテートする
 * （pure ではない）。戻り値は人間可読のログ行群（戦闘ログ表示用）。
 *
 * 不正パラメータや未対応 kind は `[]` を返して silent skip するのではなく、
 * ログに `(警告: ...)` を入れて呼び出し側が表示できるようにする。
 */
export function applyEffect(effect: ParsedEffect, ctx: EffectContext): string[] {
  // パース時の警告（`回数=` の不正値など）は、効果のログの前に `(警告: …)` として出す (#879)
  const warnings = (effect.warnings ?? []).map((w) => `(警告: ${w})`)
  return warnings.length > 0
    ? [...warnings, ...applyEffectBody(effect, ctx)]
    : applyEffectBody(effect, ctx)
}

function applyEffectBody(effect: ParsedEffect, ctx: EffectContext): string[] {
  const log: string[] = []
  switch (effect.kind) {
    case 'heal':
    case 'heal_full': {
      // heal_full は Math.min(maxHp, hp + Infinity) で完全回復になる前提。
      // entity.maxHp は有限値である必要があり（Infinity 渡すと NaN ログになる）、
      // BattleEntity 生成時にこれを保証する責務は呼び出し側にある。
      const amount =
        effect.kind === 'heal_full'
          ? Infinity
          : rollRange(effect.min ?? 0, effect.max ?? 0, ctx.rng)
      for (const t of ctx.targets) {
        // 回復の反転 (#870): ダメージになる（上限 9999・倒れている者は対象外）。蘇生 (revive) は反転しない
        if (reversalOf(t, ctx.statusRules).heal) {
          if (t.hp > 0) {
            const dealt = applyDamageToHp(t, amount)
            ctx.onAmount?.(t, 'damage', dealt, true)
            log.push(`${t.name} は 回復が さかさまに はたらき ${dealt} のダメージ！`)
            if (t.hp === 0) log.push(`${t.name} は たおれた！`)
          }
          continue
        }
        const before = t.hp
        t.hp = clampHp(t.hp + amount, t.maxHp) // 下限 0: 負値の回復で HP を 0 未満にしない (#877)
        const healed = t.hp - before
        // 計算上の回復量（上限で切らない）。完全回復は回復した分
        ctx.onAmount?.(t, 'heal', Number.isFinite(amount) ? amount : healed)
        log.push(`${t.name} は ${healed} 回復した！`)
      }
      return log
    }
    case 'damage':
    case 'damage_full': {
      // 複数ヒット (#879)。`回数=N`（N>=2）のときだけ onHit でヒットごとに通知する。未指定・1 は従来と同じ経路
      // （基礎値の抽選は 1 回・rng 消費・ログとも不変）
      const multi = effect.kind === 'damage' && (effect.count ?? 1) > 1
      /** 対象 1 体への 1 ヒット。`base` は計算済みの基礎ダメージ（damage_full は Infinity）、`round` はヒット番号 */
      const hitOne = (t: BattleEntity, base: number, round: number): void => {
        // ダメージの反転 (#870): 属性相性・耐性を通した最終値が回復になる。即死は全回復。倒れている者は生き返らない
        const reverse = reversalOf(t, ctx.statusRules).damage
        /** 反転: `amount` だけ回復する（最大 HP で止まる。0 以下・倒れている者は何も起きない＝MISS） */
        const healInstead = (amount: number): void => {
          const healed = clampDamage(Math.max(0, amount))
          if (healed > 0 && t.hp > 0) {
            t.hp = clampHp(t.hp + healed, t.maxHp)
            ctx.onAmount?.(t, 'heal', healed, true)
            if (multi) ctx.onHit?.(t, 'heal', healed, round, true)
            log.push(`${t.name} は ${healed} 回復した！`)
          } else if (multi) {
            ctx.onHit?.(t, 'miss', 0, round)
          }
        }
        if (reverse && effect.kind === 'damage_full') {
          if (t.hp > 0) {
            const healed = t.maxHp - t.hp
            t.hp = clampHp(t.maxHp, t.maxHp)
            ctx.onAmount?.(t, 'heal', healed, true)
            log.push(`${t.name} は 全回復した！`)
          }
          return
        }
        // 属性相性 (#872)。吸収 > 無効 > 半減 > 弱点で該当した時点で打ち切り、どれにも該当しなければ下の従来の resist へ。
        // 即死 (damage_full) は属性 id `death` を見て成功率を変える（無効・吸収 0 / 半減 ×0.5 / 弱点 ×2〈上限 DEATH_CHANCE_CAP〉。既定は 100%）
        const kind = resolveAffinity(
          t.affinity,
          effect.kind === 'damage_full' ? DEATH_ATTRIBUTE : effect.type
        )
        if (effect.kind === 'damage_full') {
          if (!rollDeath(deathSuccessRate(kind, 1), ctx.rng)) {
            log.push(`${t.name} には きかなかった！`)
            return
          }
        } else if (kind === 'absorb') {
          // 吸収: 計算したダメージ量だけ回復する（最大 HP で切る。倒れている対象は生き返らせない）
          // 計算量が 0 のときは回復も吸収ログも出さない。通知も無いので、戦闘側は HP が変わらない対象を MISS（hits に miss）にする
          // 複数ヒットでは、吸収したそのヒットだけが heal になる (#879)
          // 吸収量はダメージと同じく 9999 で頭打ち（吸収=受けるはずだったダメージ。回復量一般には上限を掛けない、#877）
          const absorbed = clampDamage(base)
          if (absorbed > 0) {
            if (t.hp > 0) t.hp = clampHp(t.hp + absorbed, t.maxHp)
            ctx.onAmount?.(t, 'heal', absorbed)
            if (multi) ctx.onHit?.(t, 'heal', absorbed, round)
            log.push(`${t.name} は ${absorbed} のダメージを吸収した！`)
          } else if (multi) {
            ctx.onHit?.(t, 'miss', 0, round)
          }
          return
        } else if (kind === 'nullify') {
          // 無効: ダメージ 0・通知なし（戦闘側で MISS）。追加効果は無い
          if (multi) ctx.onHit?.(t, 'miss', 0, round)
          log.push(`${t.name} には きかなかった！`)
          return
        } else if (kind === 'halve' || kind === 'weak') {
          if (reverse) {
            healInstead(applyAffinityToDamage(kind, base))
            return
          }
          const dealt = applyDamageToHp(t, applyAffinityToDamage(kind, base))
          ctx.onAmount?.(t, 'damage', dealt)
          if (multi) ctx.onHit?.(t, 'damage', dealt, round)
          log.push(`${t.name} に ${dealt} のダメージ！`)
          if (t.hp === 0) log.push(`${t.name} は たおれた！`)
          return
        }
        // own-property のみ見る (#368)。素朴な `t.resist?.[effect.type]` は Object.prototype も
        // 辿ってしまい、DSL の `type=...` が自由記述の effect.type が `constructor` 等と一致すると
        // （truthy な関数オブジェクトを返すため）`??` のフォールバックが発火せず耐性倍率が
        // 数値でなくなってしまう。
        // 負の耐性は 0（無効）に丸める (#877)。HP を増やす向きの相性は属性相性の `吸収:` (#872) に一本化した
        const resistRaw =
          effect.type && t.resist && hasOwn(t.resist, effect.type)
            ? (t.resist[effect.type] ?? 1.0)
            : 1.0
        const resist = resistRaw < 0 ? 0 : resistRaw
        // 即死 (damage_full) は HP をそのまま 0 にする（ダメージ上限は掛けない）。ダメージの数字は持たず「たおれた」だけを知らせる (#877)
        if (effect.kind === 'damage_full') {
          t.hp = 0
          ctx.onKill?.(t)
          log.push(`${t.name} は たおれた！`)
          return
        }
        if (reverse && resist !== 0) {
          healInstead(Math.floor(base * resist))
          return
        }
        const dealt = applyDamageToHp(t, Math.floor(base * resist))
        // 耐性 0（無効）は通知しない＝呼び出し側で MISS になる。それ以外は 0 でも計算上のダメージとして知らせる (#745)
        if (resist !== 0) ctx.onAmount?.(t, 'damage', dealt)
        if (multi) ctx.onHit?.(t, resist !== 0 ? 'damage' : 'miss', resist !== 0 ? dealt : 0, round)
        log.push(`${t.name} に ${dealt} のダメージ！`)
        if (t.hp === 0) log.push(`${t.name} は たおれた！`)
      }

      if (!multi) {
        const base =
          effect.kind === 'damage_full'
            ? Infinity
            : rollRange(effect.min ?? 0, effect.max ?? 0, ctx.rng)
        for (const t of ctx.targets) hitOne(t, base, 0)
        return log
      }

      // 複数ヒット (#879)。1 ヒット（全体対象は 1 巡）ごとにダメージを振り直す。rng 消費順は「ヒットごとにダメージ抽選」だけ
      // （標的の乗り換えは rng を使わず、並び順の先頭の生存者）。全体対象（targets が 2 体以上）は N 巡して毎巡その時点の生存者全員、
      // 単体対象は標的が倒れたら pool の先頭の生存者へ移り、全滅したらそこで打ち切る
      const count = effect.count ?? 1
      const min = effect.min ?? 0
      const max = effect.max ?? 0
      if (ctx.targets.length >= 2) {
        for (let round = 0; round < count; round++) {
          const alive = ctx.targets.filter((t) => t.hp > 0)
          if (alive.length === 0) break
          const base = rollRange(min, max, ctx.rng)
          for (const t of alive) hitOne(t, base, round)
        }
      } else if (ctx.targets.length === 1) {
        const pool = ctx.pool ?? []
        let current = ctx.targets[0]
        for (let round = 0; round < count; round++) {
          if (current.hp <= 0) {
            const next = pool.find((e) => e.hp > 0)
            if (!next) break
            current = next
          }
          hitOne(current, rollRange(min, max, ctx.rng), round)
        }
      }
      return log
    }
    case 'buff':
    case 'debuff': {
      if (effect.stat === undefined || effect.delta === undefined) {
        return ['(警告: buff/debuff のパラメータ不正)']
      }
      for (const t of ctx.targets) {
        if (!t.buffs) t.buffs = {}
        const cur = t.buffs[effect.stat] ?? 0
        t.buffs[effect.stat] = cur + effect.delta
        const sign = effect.delta >= 0 ? '上' : '下'
        log.push(`${t.name} の ${effect.stat.toUpperCase()} が ${sign}がった！`)
      }
      return log
    }
    case 'revive': {
      for (const t of ctx.targets) {
        if (t.hp > 0) continue
        t.hp = clampHp(effect.hp === 'half' ? Math.floor(t.maxHp / 2) : t.maxHp, t.maxHp)
        log.push(`${t.name} は生き返った！`)
      }
      return log
    }
    case 'status': {
      if (!effect.state) return ['(警告: status の state 名なし)']
      // `[状態]` で宣言した id は規則に引く (#870)。日本語名の別名（毒 → poison）も引く。宣言の無い id は従来どおり印だけ
      const ruleId = resolveRuleId(ctx.statusRules, effect.state)
      const rule = ruleId !== null ? ctx.statusRules?.[ruleId] : undefined
      for (const t of ctx.targets) {
        // 宣言した状態は倒れている者に付けない（宣言の無い印は従来どおり対象を選ばない）
        if (rule && t.hp <= 0) continue
        // 付与の成功判定 (#870)。`確率=` が無く耐性も無ければ必中で乱数を使わない（従来と同じ）。
        // 耐性は属性相性の欄に書いた状態 id（無効・吸収 0 / 半減 ×0.5 / 弱点 ×2〈上限 99%〉）。
        // 宣言の無い印には耐性を当てない（従来どおり、`確率=` だけで判定する）
        const rate = statusSuccessRate(
          rule && ruleId !== null ? resolveAffinity(t.affinity, ruleId) : 'normal',
          effect.chance,
          ctx.caster.statusChanceBonus
        )
        if (!rollDeath(rate, ctx.rng)) {
          log.push(`${t.name} には きかなかった！`)
          continue
        }
        if (!t.status) t.status = {}
        // 持続: 宣言した状態は duration= → 持続: → 既定の順で 1〜上限に収める。宣言の無い印は従来どおり（既定 1）
        const turns = rule ? turnsOf(effect.duration, rule.duration) : (effect.duration ?? 1)
        // #370: state は DSL の自由記述文字列。"__proto__" でも own-property として書く
        safeAssign(t.status, ruleId ?? effect.state, turns)
        ctx.onStatus?.(t, ruleId ?? effect.state)
        log.push(`${t.name} は ${rule ? rule.name : effect.state} になった！`)
      }
      return log
    }
    case 'cure': {
      // 状態の解除 (#870)。`all` は付いている状態すべて。付いていない状態は何も言わない
      const which = effect.state
      if (!which) return ['(警告: cure の state 名なし)']
      for (const t of ctx.targets) {
        const st = t.status
        if (!st) continue
        if (which === 'all') {
          const keys = Object.keys(st).filter((k) => (st[k] ?? 0) > 0)
          for (const k of keys) delete st[k]
          if (keys.length > 0) {
            log.push(`${t.name} の 状態異常が なおった！`)
            ctx.onStatus?.(t, which, 'cure')
          }
          continue
        }
        const ruleId = resolveRuleId(ctx.statusRules, which)
        for (const key of ruleId !== null && ruleId !== which ? [ruleId, which] : [which]) {
          if (hasOwn(st, key) && (st[key] ?? 0) > 0) {
            delete st[key]
            const name =
              ctx.statusRules && hasOwn(ctx.statusRules, key) ? ctx.statusRules[key].name : key
            log.push(`${t.name} の ${name} が なおった！`)
            ctx.onStatus?.(t, key, 'cure')
          }
        }
      }
      return log
    }
    case 'escape_battle':
      log.push('にげだした！')
      return log
    case 'escape_dungeon':
      log.push('ダンジョンから脱出した。')
      return log
  }
}

/** 宣言した状態の持続ターン数。`duration=` が 1 以上の有限値ならそれ（切り捨て）、無ければ既定。`MAX_STATUS_TURNS` で頭打ち */
function turnsOf(duration: number | undefined, fallback: number): number {
  const d =
    duration !== undefined && Number.isFinite(duration) && duration >= 1 ? duration : fallback
  return Math.min(Math.floor(d), MAX_STATUS_TURNS)
}

export function rollRange(min: number, max: number, rng: () => number): number {
  if (min === max) return min
  const r = rng()
  // Math.random() は [0, 1) なので通常 max+1 にはならないが、
  // テストや差し替え rng で 1.0 を渡された場合に備えて Math.min(max, ...) で堅牢化。
  return Math.min(max, Math.floor(min + r * (max - min + 1)))
}
