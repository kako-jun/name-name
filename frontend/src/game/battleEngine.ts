/**
 * RPG 戦闘エンジン (#173)。
 *
 * UI から独立した純粋な状態機械。コマンド入力（attack / escape / spell / item）を
 * 受けて state を進め、戦闘ログを蓄積する。UI（BattleScreen）はこの state を観測して
 * 描画するだけ。
 *
 * 進行方式は 2 つ（コンストラクタの `atb` オプションで選ぶ）:
 * - 従来ターン制（`atb` 未指定・既定）: 先頭の生存味方 1 人が行動 →「敵全員」の固定順
 * - ATB（#205、FF5 風）: 味方・敵ともゲージを持ち、AGI に比例した速さで溜まる。
 *   満タンの順に行動する。時間は外から `tick(ms)` で与える（エンジンは時計を持たない＝決定論的）。
 *   ゲージが満タンになった味方は「溜まった順のキュー」に並び、先頭から 1 人ずつコマンドを受ける。
 *   敵は満タンで自動行動する（狙いは生存味方からランダム。注入された rng を使う）。
 *   待機（wait、既定）= コマンド選択中は時間が止まる / アクティブ（active）= 止まらない。
 *
 * ダメージ式: DQ 式（atk - def/2 + rand(0..atk/4)）、最低 1
 *
 * 敵の特技 (#834): `performSkill` は「ある者が特技を 1 回使う」内部 API。敵の行動選択（`enemyAi.ts` の `chooseEnemyAction`、#835）の結果を
 * 従来ターン制の `runEnemyTurn` と ATB の `runAtbEnemyAction` が実行するときに呼ぶ。この API 自体はターン・ATB ゲージ・勝敗判定を進めない（呼び出し側が行う）。
 *
 * 状態異常 (#870): `[状態]` で宣言した状態（`BattleEngineOptions.statuses`）だけが働く。状態は**その者の手番の終わり**に進み
 * （継続ダメージ → 持続 -1 → 尽きたら解除。満了で戦闘不能もある）、行動不能・混乱の者は手番を自動で解決する。
 * 宣言の無い戦闘・宣言の無い印（属性欄の耐性も当てない）は、乱数の消費を含めて従来と完全に同じ。
 *
 * 戦利品 (#831): 敵の `loot`（ドロップ・ぬすむの通常枠とレア枠）を宣言した敵だけが働く。ドロップは勝利の瞬間に行ごとに抽選、
 * ぬすむは効果 DSL `steal`（`SpellExecution` / `SkillExecution` の `effect`。アイテムは対象が味方だけなので盗めない）が `ctx.steal` を呼んで抽選する。
 * 獲得は `BattleState.loot` に事実として積み、`getResult()` が結果（`BattleResult`）にまとめてホストへ渡す（所持品の保存は持たない）。
 * 宣言の無い戦闘は、乱数の消費を含めて従来と完全に同じ。
 *
 * 脚本制御の戦闘 (#741 / #863): `BattleEngineOptions.script`（`[戦闘]` の宣言）を渡した戦闘だけが働く。脚本の解釈・条件評価・
 * 「いま発動するルール」の決定は純粋関数モジュール `battleScript.ts` が行い、エンジンは**ステップの境目**（行動の後・敵の手番の後・ATB の判定のとき）に
 * `scriptStep` で決定を受けて、自分の操作（台詞・参戦・復活・逃走・強制終了・HP 下限の付け外し）で適用するだけ。乱数は使わない。
 * `script` を渡さない戦闘は、状態の形・ログ・乱数の消費まで従来と完全に同じ。
 *
 * 将来拡張:
 * - 呪文 / アイテム / さくせん（#174 / #175）
 * - 敵の builtin: での挙動委譲
 */

import type { BattleEntity, BattleRow, EffectContext } from './spellDsl'
import { applyEffect, parseEffect, rollRange } from './spellDsl'
import type { StatusDef, SummonCue } from '../types'
import {
  activeStatusRules,
  blockingAction,
  buildStatusRules,
  resolveRuleId,
  statusLabels,
  type StatusRule,
} from './statusEffects'
import {
  applyAffinityToDamage,
  DEATH_ATTRIBUTE,
  resolveAffinity,
  resolveAffinityMulti,
} from './affinity'
import { invokeBuiltinSpell, invokeBuiltinItem } from './builtin'
import { isReviveEntry } from './battleMenu'
import {
  chooseEnemyAction,
  chooseEnemyReaction,
  createEnemyMemory,
  hasOnDeath,
  parseCounterRules,
  parseDeathRules,
  recordEnemyAction,
  tracksDamage,
  tracksHits,
  type ChosenAction,
  type EnemyMemory,
  type HitSource,
} from './enemyAi'
import { hasOwn, safeAssign } from './ownProperty'
import { applyDamageToHp, clampDamage, clampHp, knockOutHp } from './battleLimits'
import {
  computeFloors,
  nextScriptAction,
  SCRIPT_STEP_SLACK,
  parseBattleScript,
  resolveAmount,
  resultFor,
  type ParsedBattleScript,
  type ScriptAction,
  type ScriptEndResult,
  type ScriptState,
  type ScriptView,
} from './battleScript'
import {
  attemptSteal,
  parseLootSpec,
  rollDrops,
  summarizeLoot,
  type BattleResult,
  type LootEntry,
  type LootSpec,
  type StealParams,
} from './loot'

export type BattlePhase =
  | 'party-input' // 味方の入力待ち（ATB では「ゲージが溜まった味方がコマンドを待っている」）
  | 'atb-running' // ATB: 誰もコマンド待ちでなく、ゲージが溜まっていく最中 (#205)
  | 'enemy-turn' // 敵の行動中（同期処理だが UI のアニメ用に分離）
  | 'victory'
  | 'defeat'
  | 'escaped'
  | 'interrupted' // 脚本が勝敗がつく前に打ち切った (#741)

/** 行動の主体・対象の指し示し (#745)。`party` / `enemies` の index */
export interface BattleActorRef {
  side: 'party' | 'enemy'
  index: number
}

/** 1 回の効果の結果の種類 (#745)。damage = HP 減少 / heal = HP 増加 / miss = 対象にしたが HP が変わらなかった */
export type BattleHitKind = 'damage' | 'heal' | 'miss'

/** 行動 1 回が対象 1 体に与えた結果 (#745)。演出（ダメージ数字・のけぞり・倒れ）が読む事実で、演出の途中状態ではない */
export interface BattleHit {
  target: BattleActorRef
  kind: BattleHitKind
  /**
   * 計算上のダメージ・回復量（miss は 0）。**HP が実際に変わった量ではない**: HP 3 の敵に 50 のダメージならオーバーキルでも 50、
   * HP が満タン近くへの回復も上限で切らない量。FF 式のダメージ数字はこれを出す。実際の変化は hpBefore - hpAfter。
   * builtin など計算量を通知しない効果は HP の前後差で代用する。
   */
  amount: number
  hpBefore: number
  hpAfter: number
  /**
   * 1 回の行動の中の何発目か（0 始まり。全体対象の `回数=N` は何巡目か）(#879)。**複数ヒット（効果 DSL `damage … 回数=N`）のときだけ付く**。
   * 無い（単発）は 0 と同じ。`hits` 配列の順序がそのまま再生順で、同じ `target` が複数回現れてよく、
   * `hpBefore` / `hpAfter` は直前のヒットから連鎖する（1 発目の `hpAfter` = 2 発目の `hpBefore`）。FF 式の順次再生は実装済み（`round` ごとに `MULTI_HIT_INTERVAL_MS` 間隔で発火（多いときは自動で縮む）。`battleMotion.ts`）
   */
  round?: number
  /**
   * 即死で倒した (#877)。ダメージの数字を出さず「たおれた」の演出だけにする印。`amount` は HP の前後差（`hpBefore - hpAfter`）で、
   * 1 回のダメージの上限 9999 の対象外（即死は上限を超える HP も 0 にする）。HP ゲージは `hpAfter`（0）へ向かう
   */
  instantDeath?: boolean
  /**
   * 状態による回復・ダメージの反転 (#870) で向きが入れ替わったヒット。`kind` は実際に起きた向き（回復が反転してダメージなら `damage`）。
   * 元の技の種類を知りたい消費側（ラーニング判定など）の印で、エンジン自身は参照しない
   */
  reversed?: boolean
}

/**
 * 行動 1 回の記録 (#745)。エンジンは同期処理で状態をすぐ確定させるので、画面の演出（FF 式）が
 * 「いま誰が誰に何をしたか」を後から再生できるよう、事実だけを残す。画面は `eventTotal` の差で新規分を数える（ログと同じ流儀）。
 */
export interface BattleActionEvent {
  /** 戦闘開始からの通し番号（0 始まり） */
  seq: number
  actor: BattleActorRef
  /**
   * `status` (#870) = 状態異常の継続ダメージ・満了による戦闘不能。`actor` と `hits[0].target` は状態が付いている本人、`label` は状態名。
   * 本人は動かず、ダメージ数字だけが出る
   */
  kind: 'attack' | 'spell' | 'item' | 'skill' | 'notice' | 'status'
  /**
   * 脚本制御の戦闘 (#741) が出した「読ませる文」（台詞・参戦・復活・逃走の知らせ）の印。`kind` は `notice` で `label` が全文。
   * 窓は短い知らせより長く見せる（`eventTimeline`）。HP が動く復活は `hits` に回復を持つ。脚本の無い戦闘・他の行動には付かない
   */
  line?: true
  /**
   * FF 式メッセージ窓に出す短い言葉。呪文・アイテム・特技 (#834) の名前、または `notice`（行動が成立しなかったことの知らせ。
   * 「にげられない！」「MPが たりない！」）の文言。通常攻撃は undefined
   */
  label?: string
  /**
   * 特技 (#834) の使用時メッセージ（`{user}` を使った側の名前に置き換えた後の文）。現段階では記録だけで画面は読まない
   * （設計書 §3.3 の `メッセージ`。表示は P1 #835 以降）。`メッセージ:` を書かない特技・他の kind は undefined */
  message?: string
  /**
   * 特技の予兆の文言（`{user}` 置き換え後。敵の行動パターン P2 #836）。FF 式は窓にラベルの代わりに出し、DQ 式は戦闘ログに積む。
   * 予兆の無い特技・他の kind は undefined
   */
  omen?: string
  /**
   * 召喚獣の演出 (#750)。召喚 (#889) と、味方の「わざ」（`召喚獣id` を持つ特技）の行動に付く。敵の行動には付かない。画面が登場の演出（絵・名前の札・想像の層・効果音）に使う
   * 事実で、エンジンの状態・乱数には効かない。`召喚獣id` を使わない戦闘・他の行動のイベントには付かない（従来と同じ形）
   */
  summon?: SummonCue
  hits: BattleHit[]
  /**
   * この行動を記録した時点の、全員の状態名（付いた順。宣言した状態だけ。`party[i]` / `enemies[i]` の順）(#870)。
   * FF 式の演出が、HP の数字と同じく再生位置で状態名を切り替えるために読む。`[状態]` の宣言が無い戦闘では付かない
   */
  statusLabels?: { party: string[][]; enemies: string[][] }
}

export interface BattleState {
  party: BattleEntity[]
  enemies: BattleEntity[]
  phase: BattlePhase
  /** 戦闘ログ（直近 30 行を保持） */
  log: string[]
  /**
   * 戦闘開始からの累計ログ行数。`appendLog` のたびに 1 増え、上限（LOG_MAX）で先頭を捨てても減らない。
   * `log` は絶対インデックスを失うので、「前回から何行積まれたか」は前回の値との差で数える (#755)
   */
  logTotal: number
  /** 行動の記録（直近 30 件）(#745)。演出が読む。`log` と同じく上限で先頭を捨てる */
  events: BattleActionEvent[]
  /** 戦闘開始からの累計行動数。`events` の絶対インデックスの代わりに「前回から何件増えたか」を数える (#745) */
  eventTotal: number
  /** 入手経験値（victory 到達時のみ集計） */
  earnedExp: number
  /** 入手ゴールド（victory 到達時のみ集計） */
  earnedGold: number
  /** ATB のゲージ・キュー (#205)。従来ターン制では存在しない（undefined） */
  atb?: AtbState
  /**
   * 敵ごとの記憶 (#835)。`enemies` と同じ index。`行動:` を持つ敵がいる戦闘のときだけ作る
   * （持たない戦闘では undefined で、敵の挙動・乱数の消費は従来のまま）。従来ターン制・ATB のどちらでも同じ意味
   */
  enemyMemory?: EnemyMemory[]
  /**
   * 獲得した戦利品（獲得順、#831）。ぬすんだ品は盗んだ時点で、ドロップは勝利の瞬間に積む。戦利品が 1 つも無い戦闘では undefined
   * （従来の状態と同じ形）。ホストへは `getResult()` で渡す
   */
  loot?: LootEntry[]
  /**
   * 脚本制御の戦闘 (#741) の進行（経過ターン・発動済みのルール・参戦した味方・逃走した敵）。`BattleEngineOptions.script` を渡した戦闘にだけ付く
   * （普通の戦闘は undefined で、状態の形は従来と同じ）。数値・文字列・配列だけ（ADR 0002）
   */
  script?: ScriptState
}

const LOG_MAX = 30
/** 警告を出した状態の宣言（`id` + 文面）。同じ宣言の警告を戦闘のたびに繰り返さない (#870) */
const warnedStatusDefs = new Set<string>()
/** 特技の対象の相対表現 (#834)。これ以外の値・省略は相手単体の扱い */
const SKILL_TARGETS = ['相手単体', '相手全体', '自分', '仲間単体', '仲間全体']
const EVENT_MAX = 30

/** ATB の進行方式 (#205)。`wait` = コマンド選択中は時間停止（既定）、`active` = 止めない */
export type AtbMode = 'wait' | 'active'

/** wait のときの停止範囲 (#204)。`command` = コマンド待ちの間ずっと / `menu` = 候補窓を開いている間だけ */
export type AtbWaitScope = 'command' | 'menu'

/** ゲージ満タンの値 */
export const ATB_GAUGE_MAX = 1000
/** AGI 1 あたり、1ms ごとに溜まるゲージ量。AGI に比例（AGI 5 で 5 秒、AGI 10 で 2.5 秒で満タン）。目視で調整する値 */
export const ATB_FILL_PER_AGI_MS = 0.04
/** `tick(ms)` 1 回で進める時間の上限（ms）。タブ復帰などで巨大な値が来ても暴走しないための安全弁 */
export const ATB_MAX_TICK_MS = 10_000

/**
 * ATB のゲージとコマンド待ちキュー (#205)。味方・敵とも `party` / `enemies` と同じ index の配列。
 * 画面演出の中間状態ではなくゲーム進行そのものなので、BattleState に持つ（ADR 0002 は演出の中間状態を持たせない原則）。
 */
export interface AtbState {
  mode: AtbMode
  /** 味方ゲージ（0〜ATB_GAUGE_MAX）。`party` と同じ index */
  partyGauge: number[]
  /** 敵ゲージ（0〜ATB_GAUGE_MAX）。`enemies` と同じ index */
  enemyGauge: number[]
  /** ゲージが満タンでコマンド待ちの味方の index（溜まった順。先頭が今コマンドを出す人） */
  queue: number[]
}

export interface BattleEngineOptions {
  /** 0..1 の一様乱数を返す関数。テストで決定論的に差し替え可能 */
  rng?: () => number
  /**
   * ATB 方式にする (#205)。未指定は従来ターン制。
   * `initialGauges` は任意局面から始めるための初期ゲージ（範囲外・非有限値は 0〜最大に丸める。省略は 0）。
   */
  atb?: {
    mode?: AtbMode
    /**
     * wait のとき、どこで時間を止めるか (#204)。`command`（既定）= コマンド待ちの味方がいる間ずっと止める（従来）/
     * `menu` = 候補窓（じゅもん・どうぐの一覧や対象選択）を開いている間だけ止める（FF5/6 の「ウェイト」）。
     * 候補窓を開いているかは表示側が `setAtbHold` で教える（エンジンは窓を知らない）。active では無関係
     */
    waitScope?: AtbWaitScope
    initialGauges?: { party?: number[]; enemies?: number[] }
  }
  /**
   * 敵が使える特技 (#835)。`行動:` の候補の id → 特技の実行内容（マスターの `[特技]` から `toSkillExecutions` で作る）。
   * 候補の id がここに無ければ、その行動は通常攻撃になる。エンジンはマスター参照を持たないので呼び出し側が渡す
   */
  skills?: Record<string, SkillExecution>
  /**
   * 状態の宣言 (#870)。マスターの `[状態]`（id → `StatusDef`）。宣言した id だけが継続ダメージ・行動不能・回復の反転などで働く。
   * 無い・空は従来どおり（`status` は印が付くだけ）。エンジンはマスター参照を持たないので呼び出し側が渡す
   */
  statuses?: Record<string, StatusDef>
  /**
   * アイテムの表示名 (#831)。戦利品のログ（「〇〇 を てにいれた！」）に使う id → 名前。マスターのアイテム定義から作って渡す。
   * 無い id は id をそのまま表示する（戦利品の id はゲームが決める不透明な文字列で、アイテムマスターに無くてもよい）
   */
  itemNames?: Record<string, string>
  /**
   * 脚本制御の戦闘 (#741 / #863)。`[戦闘 id]` の宣言。渡した戦闘だけ脚本が働く（無い・渡さない戦闘は従来どおり）。
   * エンジンはマスター参照を持たないので、途中参戦できる味方（`joiners`）も呼び出し側が渡す
   */
  script?: BattleScriptOptions
}

/** 脚本制御の戦闘の入力 (#741)。`rules` は `BattleScriptDef.rules`（`キー: 値` の生の行）をそのまま渡す */
export interface BattleScriptOptions {
  /** `[戦闘 id]` の id（`BattleResult.script.id` に載る） */
  id: string
  rules: readonly string[]
  /** 途中参戦できる味方（`参戦: 対象=` の id → 味方）。戦闘ごとに複製して使う（渡した側の値は書き換えない） */
  joiners?: Record<string, BattleEntity>
}

/** 戦利品の宣言の警告を出した印（敵 id + 文面）。同じ宣言の警告を戦闘のたびに繰り返さない (#831) */
const warnedLootDefs = new Set<string>()
/** 脚本の宣言の警告を出した印（戦闘 id + 文面）。同じ宣言の警告を戦闘のたびに繰り返さない (#741) */
const warnedScriptDefs = new Set<string>()

export class BattleEngine {
  private state: BattleState
  private rng: () => number
  /** wait / menu のとき、表示側が候補窓を開いている間 true（画面の一時的な状態なので BattleState には持たない） */
  private atbHold = false
  private atbWaitScope: AtbWaitScope = 'command'
  private skills: Record<string, SkillExecution>
  /** 見つからない特技 id の警告を出した印（1 戦闘に 1 度だけ） */
  private warnedSkills = new Set<string>()
  /** 状態の規則 (#870)。`statuses` を解釈したもの。空なら状態異常の処理は一切走らない（従来どおり） */
  private statusRules: Record<string, StatusRule> = {}
  private hasStatusRules = false
  /** 行動不能・混乱の味方の手番を自動で解決している最中（再入防止） */
  private autoResolving = false
  /** 状態名の控え（イベントの `statusLabels`）を付け始めたか。状態が一度でも付いたら true */
  private statusLabelsSeen = false
  /**
   * 今の手番の中で付いた状態の記録 (#870)。`applier` が `target` に `key` を書いた（付与者は問わない: 自分への付与も、
   * 味方の手番中に敵の反撃・死亡時の行動が付けた状態も含む）。`target` の手番の終わり（`tickStatuses`）はこの分を 1 度だけ飛ばし、
   * 手番の終わりごとに全部消す（付けた直後に目減りしない。敵が味方に付けた状態は、敵の手番の終わりに記録が消えるので味方の次の手番まで減らない）
   */
  private freshStatuses: { applier: BattleEntity; target: BattleEntity; key: string }[] = []
  /** 今の行動で状態を付けられた・解かれた者。HP が動かなくても MISS にしない（`recordEffect` が使って空にする） */
  private statusTouched = new Set<BattleEntity>()
  /** 敵ごとの戦利品の宣言（解釈済み、#831）。宣言の無い敵は入らない */
  private lootSpecs = new Map<BattleEntity, LootSpec>()
  /** 敵ごとに盗めた回数 (#831)。`ぬすむ回数` に達した敵は空になる */
  private stolenCounts = new Map<BattleEntity, number>()
  private itemNames: Record<string, string>
  /** ドロップを抽選した印（勝利は 1 度だけ） */
  private dropsRolled = false
  /** 脚本制御の戦闘 (#741)。解釈済みの宣言。渡さない戦闘は null（脚本の処理は一切走らない） */
  private scriptParsed: ParsedBattleScript | null = null
  /** 途中参戦できる味方（複製済み）。`参戦:` が id で引く */
  private joiners: Record<string, BattleEntity> = {}
  /** 脚本のステップを実行している最中（再入防止） */
  private scriptRunning = false
  /** 参戦できなかった id の警告を出した印（1 戦闘に 1 度だけ） */
  private warnedJoiners = new Set<string>()
  private warnedStatuses = new Set<string>()

  constructor(party: BattleEntity[], enemies: BattleEntity[], opts: BattleEngineOptions = {}) {
    this.state = {
      party,
      enemies,
      phase: 'party-input',
      log: [],
      logTotal: 0,
      events: [],
      eventTotal: 0,
      earnedExp: 0,
      earnedGold: 0,
    }
    this.rng = opts.rng ?? Math.random
    this.skills = opts.skills ?? {}
    this.itemNames = opts.itemNames ?? {}
    for (const e of enemies) {
      const spec = parseLootSpec(e.loot)
      if (!spec) continue
      this.lootSpecs.set(e, spec)
      for (const w of spec.warnings) {
        const key = `${e.id}\u0000${w}`
        if (warnedLootDefs.has(key)) continue
        warnedLootDefs.add(key)
        console.warn(`[name-name] 敵 '${e.id}' の戦利品: ${w}`)
      }
    }
    if (opts.statuses) {
      this.statusRules = buildStatusRules(opts.statuses)
      this.hasStatusRules = Object.keys(this.statusRules).length > 0
      // 最初から状態が付いている者がいれば、状態名の控え（イベントの `statusLabels`）は最初のイベントから付ける
      this.statusLabelsSeen =
        this.hasStatusRules &&
        [...party, ...enemies].some((en) => statusLabels(en, this.statusRules).length > 0)
      // 宣言の不正値の警告は、同じ状態・同じ文面なら 1 度だけ（戦闘のたびに出さない）
      for (const rule of Object.values(this.statusRules)) {
        for (const w of rule.warnings) {
          const key = `${rule.id}\u0000${w}`
          if (warnedStatusDefs.has(key)) continue
          warnedStatusDefs.add(key)
          console.warn(`[name-name] 状態 '${rule.id}': ${w}`)
        }
      }
    }
    const memory = createEnemyMemory(enemies)
    if (memory) this.state.enemyMemory = memory
    if (opts.atb) {
      this.initAtb(opts.atb)
      this.atbWaitScope = opts.atb.waitScope === 'menu' ? 'menu' : 'command'
    }
    if (opts.script) {
      const parsed = parseBattleScript(opts.script.rules)
      this.scriptParsed = parsed
      this.state.script = {
        id: opts.script.id,
        turn: 0,
        fired: [],
        joined: [],
        fled: [],
      }
      for (const [id, member] of Object.entries(opts.script.joiners ?? {})) {
        safeAssign(this.joiners, id, JSON.parse(JSON.stringify(member)) as BattleEntity)
      }
      for (const w of parsed.warnings) {
        const key = `${opts.script.id}\u0000${w}`
        if (warnedScriptDefs.has(key)) continue
        warnedScriptDefs.add(key)
        console.warn(`[name-name] 戦闘 '${opts.script.id}': ${w}`)
      }
    }
    const enemyNames = enemies.map((e) => e.name).join(' と ')
    this.appendLog(`${enemyNames} が あらわれた！`)
    // 脚本の最初のステップ（`開始` の台詞・最初の HP 下限・開始時の逃走や終了）と、そのあとの勝敗の判定。戦闘の開始の行は出したあと。
    // 脚本の戦闘だけ（普通の戦闘は開始時に勝敗を見ない＝従来どおり）
    if (this.scriptParsed) this.checkEnd()
    // 最初から行動不能・混乱の味方が先頭なら、入力を待たずに解決する (#870)
    this.autoResolveParty()
  }

  /** 宣言された状態の規則 (#870)。表示（状態名）が引く。宣言が無ければ空 */
  getStatusRules(): Readonly<Record<string, StatusRule>> {
    return this.statusRules
  }

  /** 者に付いている宣言済みの状態の表示名（付いた順）(#870)。宣言が無い戦闘は常に空 */
  getStatusLabels(entity: BattleEntity): string[] {
    return this.hasStatusRules ? statusLabels(entity, this.statusRules) : []
  }

  getState(): Readonly<BattleState> {
    return this.state
  }

  /**
   * wait の停止範囲を切り替える (#204)。ATB でなければ何もしない。
   * `menu` にすると、`setAtbHold(true)` の間だけ時間が止まる（コマンド窓だけを出している間は進む）
   */
  setAtbWaitScope(scope: AtbWaitScope): void {
    this.atbWaitScope = scope === 'menu' ? 'menu' : 'command'
    if (this.atbWaitScope === 'command') this.atbHold = false
  }

  /** 候補窓を開いている間 true を渡す (#204)。`waitScope` が `menu` の wait のときだけ時間停止に効く */
  setAtbHold(hold: boolean): void {
    this.atbHold = hold
  }

  /** 今コマンドを出す味方の party index（ATB はキュー先頭の生存者）。いなければ -1。表示側もこれを使う */
  getCurrentActorIndex(): number {
    return this.currentActorIndex()
  }

  isOver(): boolean {
    return (
      this.state.phase === 'victory' ||
      this.state.phase === 'defeat' ||
      this.state.phase === 'escaped' ||
      this.state.phase === 'interrupted'
    )
  }

  /** 「たたかう」: 指定敵に通常攻撃。ターゲット未指定なら最初に生きてる敵 */
  selectAttack(targetId?: string): void {
    if (this.state.phase !== 'party-input') return
    if (this.refuseIfBlocked()) return
    const hero = this.currentActor()
    if (!hero) return
    const target = targetId
      ? this.state.enemies.find((e) => e.id === targetId && e.hp > 0)
      : this.firstAlive(this.state.enemies)
    if (!target) return

    const hpBefore = target.hp
    const raw = this.computeAttackDamage(hero, target)
    // 通常攻撃の属性 (#889): 攻撃側が `attackElements` を持つときだけ、敵の属性相性で判定する（持たなければ常に normal ＝従来どおり）
    const kind = resolveAffinityMulti(target.affinity, hero.attackElements)
    if (kind === 'absorb') {
      // 吸収: 計算したダメージ量だけ回復する（最大 HP で止まる。数字は 9999 で頭打ち、#877）
      const absorbed = clampDamage(raw)
      target.hp = clampHp(target.hp + absorbed, target.maxHp)
      this.recordAttack(hero, target, hpBefore, absorbed, 'heal')
      this.appendLog(`${hero.name} の こうげき！`)
      this.appendLog(`${target.name} は ${absorbed} のダメージを吸収した！`)
    } else if (kind === 'nullify') {
      this.recordAttack(hero, target, hpBefore, 0, 'miss')
      this.appendLog(`${hero.name} の こうげき！`)
      this.appendLog(`${target.name} には きかなかった！`)
    } else {
      const dmg = applyDamageToHp(target, applyAffinityToDamage(kind, raw))
      this.recordAttack(hero, target, hpBefore, dmg)
      this.appendLog(`${hero.name} の こうげき！`)
      this.appendLog(`${target.name} に ${dmg} の ダメージ！`)
      if (target.hp === 0) {
        this.appendLog(`${target.name} を たおした！`)
      }
    }

    this.advanceAfterPartyAction(
      this.reactionOf(hero, { category: 'physical' }, new Map([[target, hpBefore]]))
    )
  }

  /**
   * 「しょうかん」(#889): 味方が装備中の魔石の召喚獣を呼ぶ。1 人が 1 バトルで 1 回だけ（`BattleEntity.summoned`）。
   * 消費 MP（既定 0）が足りないときは何も起きず false（呪文と同じ「MPが たりない！」）、呼び済みなら false（ログと吹き出しで知らせる）。
   * 効果・対象の解決は `performSkill`（「わざ」と同じ。対象は使う側から見た相対表現）。召喚は魔法扱いで、敵の `受けた=魔法` に成立する。
   * 演出イベントは `kind: 'skill'`（ラベルは召喚獣の名前）。魔石が `召喚獣id` で召喚獣を参照していれば、イベントに `summon`（登場の演出の元、#750）が付く。
   * 呼べたら true。入力待ちでない・使い手がいないときも false
   */
  selectSummon(summon: SummonExecution, targetId?: string): boolean {
    if (this.state.phase !== 'party-input') return false
    if (this.refuseIfBlocked()) return false
    const caster = this.currentActor()
    if (!caster) return false
    const user = this.refOf(caster)
    if (!user) return false
    if (caster.summoned) {
      this.notifyBlocked('このたたかいでは もう よべない！')
      return false
    }
    const mp = Number.isFinite(summon.mp) && summon.mp > 0 ? Math.floor(summon.mp) : 0
    if (caster.mp < mp) {
      this.appendLog('MPが たりない！')
      this.recordNotice(caster, 'MPが たりない！')
      return false
    }
    let target: BattleActorRef | undefined
    if (targetId) {
      const pi = this.state.party.findIndex((e) => e.id === targetId)
      const ei = pi === -1 ? this.state.enemies.findIndex((e) => e.id === targetId) : -1
      if (pi !== -1) target = { side: 'party', index: pi }
      else if (ei !== -1) target = { side: 'enemy', index: ei }
    }
    const hpSnapshot = this.snapshotHp()
    caster.mp -= mp
    caster.summoned = true
    if (!this.performSkill(user, summon, target)) {
      caster.mp += mp
      delete caster.summoned
      return false
    }
    this.advanceAfterPartyAction(
      this.reactionOf(
        caster,
        { category: 'magic', name: summon.name, type: spellDamageType(summon) },
        hpSnapshot
      )
    )
    return true
  }

  /**
   * 「にげる」: 50% で離脱、失敗で敵ターン。
   * ATB (#205) ではいつでも選べる（ゲージが溜まっていなくてもよい）。失敗したときは行動した扱いで、
   * コマンド待ちの味方がいればその人（先頭）、いなければゲージが最も溜まっている生存味方のゲージが 0 に戻る
   * （失敗の連打で無償に試行できないようにする）。敵ターンは挟まない（敵は自分のゲージで動く）。
   */
  selectEscape(): void {
    const atb = this.state.atb
    if (atb) {
      if (this.state.phase !== 'party-input' && this.state.phase !== 'atb-running') return
    } else if (this.state.phase !== 'party-input') {
      return
    }
    // 脚本が「にげる」を禁じている (#741)。ターンも乱数も使わず、知らせだけ出す（連打しても進行しない・詰まない）
    if (this.scriptParsed?.noEscape) {
      this.appendLog('にげられない！')
      this.recordNotice(this.currentActor() ?? undefined, 'にげられない！')
      return
    }
    if (this.rng() < 0.5) {
      this.appendLog('にげだした！')
      this.state.phase = 'escaped'
      return
    }
    this.appendLog('しかし まわりこまれてしまった！')
    if (atb) {
      const cur = this.currentActorIndex()
      const idx = cur !== -1 ? cur : this.fullestAliveIndex(atb)
      this.recordNotice(idx !== -1 ? this.state.party[idx] : undefined, 'にげられない！')
      this.endPartyTurnStatuses(idx)
      if (idx !== -1) this.finishAtbAction(idx)
      this.countScriptTurn()
      this.settleAtbPhase()
    } else {
      this.recordNotice(this.currentActor() ?? undefined, 'にげられない！')
      this.endPartyTurnStatuses(-1)
      this.runEnemyTurn()
    }
  }

  /**
   * 時間を ms 進める (#205)。ATB のときだけ意味を持つ（従来ターン制・終了後・不正な ms は何もしない）。
   * 1 回で `ATB_MAX_TICK_MS` までに丸める。途中でゲージが満タンになる者がいればそこで区切って処理し直すので、
   * 呼び方（細かい tick の連続 / 大きい tick 1 回）で結果は変わらない（同じ rng 列なら決定論的）。
   * - 待機（wait）: コマンド待ちの味方がいる間は時間が止まる（残りの ms は捨てる）。`waitScope: 'menu'` (#204) のときは候補窓を開いている間（`setAtbHold`）だけ止まる
   * - 同時に満タンになった者の順序は rng で決める（AGI 同値など）
   * - 味方が満タン → キューに並ぶ / 敵が満タン → その場で自動行動（狙いは生存味方からランダム）
   */
  tick(ms: number): void {
    const atb = this.state.atb
    if (!atb || this.isOver()) return
    if (!Number.isFinite(ms) || ms <= 0) return
    let remaining = Math.min(ms, ATB_MAX_TICK_MS)
    // 無限ループ防止の安全弁（1 tick で全員が何周もするほどの時間は ATB_MAX_TICK_MS で丸め済み）
    for (let guard = 0; guard < 1000 && remaining > 0 && !this.isOver(); guard++) {
      if (this.checkEnd()) return
      if (atb.mode === 'wait' && atb.queue.length > 0) {
        if (this.atbWaitScope === 'command' || this.atbHold) break
      }
      const dt = this.timeToNextFill(atb, remaining)
      if (dt === null) break // 進めるゲージが無い（全員コマンド待ち）
      remaining -= dt
      this.advanceGauges(atb, dt)
      const ready = this.collectReady(atb)
      for (const who of this.shuffled(ready)) {
        if (this.isOver()) break
        if (who.side === 'party') {
          const m = this.state.party[who.index]
          // ゲージが満タンのままか（同じ時刻に満タンになった敵が先に動いて倒し、脚本が復活させた味方は、ゲージが 0 に戻っているので並べない）
          if (
            m &&
            m.hp > 0 &&
            atb.partyGauge[who.index] >= ATB_GAUGE_MAX &&
            !atb.queue.includes(who.index)
          ) {
            atb.queue.push(who.index)
          }
        } else {
          this.runAtbEnemyAction(atb, who.index)
          // 死亡時の行動などで手番の終わりのあとに付いた状態の記録を、次の手番へ持ち越さない (#870)
          this.freshStatuses = []
        }
      }
      // 行動不能・混乱の味方は入力待ちに入った時点で解決する (#870)。待機（wait）の時間停止に巻き込まない
      // （フェーズをコマンド待ちに整えてから解決する。宣言の無い戦闘は従来どおり何もしない）
      if (this.hasStatusRules) this.settleAtbPhase()
    }
    this.settleAtbPhase()
  }

  /**
   * 「じゅもん」: 呪文を発動。spell.builtin があれば builtin、そうでなければ
   * spell.effect の DSL を評価する。targetId 未指定は target=敵単体 / 敵全体 で
   * 自動分配する（簡易：敵全体は全員、それ以外は最初の生きてる敵）。
   *
   * 注: 呪文定義は呼び出し側が解決して渡す（このエンジンはマスター参照を持たない）。
   */
  selectSpell(spell: SpellExecution, targetId?: string): void {
    if (this.state.phase !== 'party-input') return
    if (this.refuseIfBlocked()) return
    const caster = this.currentActor()
    if (!caster) return
    if (caster.mp < spell.mp) {
      this.appendLog('MPが たりない！')
      this.recordNotice(caster, 'MPが たりない！')
      return
    }
    caster.mp -= spell.mp
    this.appendLog(`${caster.name} は ${spell.name} を となえた！`)

    const targets = this.resolveSpellTargets(spell, targetId)
    const amounts = new Map<BattleEntity, ComputedAmount>()
    const multi: MultiHit[] = []
    const ctx: EffectContext = {
      caster,
      targets,
      rng: this.rng,
      statusRules: this.statusRules,
      onStatus: (t, key, change) => this.noteStatus(caster, t, key, change),
      steal: this.stealHook(caster),
      pool: this.poolOf(caster, targets),
      onAmount: (t, kind, amount, reversed) =>
        amounts.set(t, { kind, amount, ...(reversed ? { reversed: true } : {}) }),
      onKill: (t) => amounts.set(t, { kind: 'damage', amount: 0, kill: true }),
      onHit: (t, kind, amount, round, reversed) =>
        multi.push({
          target: t,
          kind,
          amount,
          round,
          hpAfter: t.hp,
          ...(reversed ? { reversed: true } : {}),
        }),
    }
    const hpSnapshot = this.snapshotHp()
    const lines = spell.builtin
      ? invokeBuiltinSpell(spell.builtin, ctx)
      : spell.effect
        ? this.evalEffectDsl(spell.effect, ctx)
        : ['(呪文に効果定義なし)']
    for (const line of lines) this.appendLog(line)
    this.recordEffect(
      'spell',
      caster,
      spell.name,
      targets,
      hpSnapshot,
      amounts,
      undefined,
      undefined,
      multi
    )

    this.advanceAfterPartyAction(
      this.reactionOf(
        caster,
        { category: 'magic', name: spell.name, type: spellDamageType(spell) },
        hpSnapshot
      )
    )
  }

  /**
   * 「わざ」(#873): 味方が特技（刀のアビリティ）を 1 回使う。MP は消費しない。効果・対象の解決は `performSkill` と同じ
   * （対象は使う側から見た相対表現 `相手単体` / `相手全体` / `仲間単体` / `仲間全体` / `自分`。`targetId` は単体のときだけ効く）。
   * 敵の `受けた=物理` 条件は、わざ（アビリティ）にも成立する（通常こうげきが無いゲームでも条件が働くように、
   * 反応カテゴリは `physical` で、`受けた=わざ名` の名前指定は無い）。
   * 入力待ちでない・使い手がいない・使えなかったときは何も起きず false。使えたら true。
   */
  selectSkill(skill: SkillExecution, targetId?: string): boolean {
    if (this.state.phase !== 'party-input') return false
    if (this.refuseIfBlocked()) return false
    const caster = this.currentActor()
    if (!caster) return false
    const user = this.refOf(caster)
    if (!user) return false
    let target: BattleActorRef | undefined
    if (targetId) {
      const pi = this.state.party.findIndex((e) => e.id === targetId)
      const ei = pi === -1 ? this.state.enemies.findIndex((e) => e.id === targetId) : -1
      if (pi !== -1) target = { side: 'party', index: pi }
      else if (ei !== -1) target = { side: 'enemy', index: ei }
    }
    const hpSnapshot = this.snapshotHp()
    if (!this.performSkill(user, skill, target)) return false
    this.advanceAfterPartyAction(
      this.reactionOf(
        caster,
        { category: 'physical', name: skill.name, type: spellDamageType(skill) },
        hpSnapshot
      )
    )
    return true
  }

  /** 行動を選べなかった理由を、MP 不足と同じ経路（ログ＋窓の知らせ）で出す。入力待ちの味方がいるときだけ。状態は変えない */
  notifyBlocked(label: string): void {
    if (this.state.phase !== 'party-input') return
    this.appendLog(label)
    this.recordNotice(this.currentActor() ?? undefined, label)
  }

  /** 「どうぐ」: アイテムを使用。実際に使えたら true、行動が成立しなかった（入力待ちでない等）ら false */
  selectItem(item: ItemExecution, targetId?: string): boolean {
    if (this.state.phase !== 'party-input') return false
    if (this.refuseIfBlocked()) return false
    const user = this.currentActor()
    if (!user) return false
    this.appendLog(`${user.name} は ${item.name} を つかった！`)

    const targets = this.resolveItemTargets(item, targetId)
    const amounts = new Map<BattleEntity, ComputedAmount>()
    const multi: MultiHit[] = []
    const ctx: EffectContext = {
      caster: user,
      targets,
      rng: this.rng,
      statusRules: this.statusRules,
      onStatus: (t, key, change) => this.noteStatus(user, t, key, change),
      steal: this.stealHook(user),
      pool: this.poolOf(user, targets),
      onAmount: (t, kind, amount, reversed) =>
        amounts.set(t, { kind, amount, ...(reversed ? { reversed: true } : {}) }),
      onKill: (t) => amounts.set(t, { kind: 'damage', amount: 0, kill: true }),
      onHit: (t, kind, amount, round, reversed) =>
        multi.push({
          target: t,
          kind,
          amount,
          round,
          hpAfter: t.hp,
          ...(reversed ? { reversed: true } : {}),
        }),
    }
    const hpSnapshot = this.snapshotHp()
    const lines = item.builtin
      ? invokeBuiltinItem(item.builtin, ctx)
      : item.effect
        ? this.evalEffectDsl(item.effect, ctx)
        : ['(アイテムに効果定義なし)']
    for (const line of lines) this.appendLog(line)
    this.recordEffect(
      'item',
      user,
      item.name,
      targets,
      hpSnapshot,
      amounts,
      undefined,
      undefined,
      multi
    )

    this.advanceAfterPartyAction(
      this.reactionOf(user, { category: 'item', name: item.name }, hpSnapshot)
    )
    return true
  }

  /**
   * 特技 (#834) を 1 回使う（内部 API。敵の行動選択 #835 が呼ぶ。この PR 単体では敵は呼ばない）。
   *
   * - `user` は `party` / `enemies` の index。戦闘が終わっている・倒れている・存在しない者は何もせず false を返す
   * - 対象は**使う側から見た相対表現**: `相手単体` / `相手全体` / `自分` / `仲間単体` / `仲間全体`
   *   （敵が使えば「相手」は味方側）。未知の値・省略は `相手単体`。
   *   単体の `target` は明示指定（側が合わなければ無視）。倒れている者を指せるのは蘇生の効果（`revive` / builtin `zaorik`）のときだけで、
   *   それ以外は最初の生存者に落ちる。省略時は最初の生存者（蘇生の仲間単体だけは最初の倒れた仲間）
   * - 効果は呪文と同じ評価器を内部で共有（`builtin` があればそれ、無ければ `effect` の DSL）。MP は持たず消費しない
   * - ログに `message`（`{user}` を使った側の名前に置換）か「〇〇 は △△ を つかった！」、演出イベントに `kind: 'skill'` を残す
   * - `opts.allowDowned` は死亡時の行動 (#837) 用。倒れている使い手でも使える
   * - フェーズ・ATB ゲージ・勝敗判定は触らない（敵ターンの途中で呼ばれても二重に終了処理しないため、呼び出し側が checkEnd 相当を行う）
   * - 乱数は効果の評価でだけ消費する（対象の解決は rng を使わない）
   */
  performSkill(
    user: BattleActorRef,
    skill: SkillExecution,
    target?: BattleActorRef,
    opts: { allowDowned?: boolean } = {}
  ): boolean {
    const userList = user.side === 'party' ? this.state.party : this.state.enemies
    const caster = userList[user.index]
    if (this.isOver()) return false
    // 倒れた者は行動できない。ただし死亡時の行動 (#837) は、倒れた本人が最後に 1 度だけ使う
    if (!caster || (caster.hp <= 0 && !opts.allowDowned)) return false
    // 倒れた使い手（死亡時の行動 #837）は自分を効果の対象にできない（自分向けの回復・蘇生で生き返る抜け道を塞ぐ）。
    // 生きている仲間への回復・強化や、倒れた別の仲間の蘇生は使える
    const excludeUser = !!opts.allowDowned && caster.hp <= 0
    const targets = this.resolveSkillTargets(user.side, caster, skill, target, excludeUser)
    const message =
      typeof skill.message === 'string' && skill.message.trim() !== ''
        ? skill.message.split('{user}').join(caster.name)
        : undefined
    this.appendLog(message ?? `${caster.name} は ${skill.name} を つかった！`)
    const omen =
      typeof skill.telegraph === 'string' && skill.telegraph.trim() !== ''
        ? skill.telegraph.split('{user}').join(caster.name)
        : undefined
    if (omen !== undefined) this.appendLog(omen)

    const amounts = new Map<BattleEntity, ComputedAmount>()
    const multi: MultiHit[] = []
    const ctx: EffectContext = {
      caster,
      targets,
      rng: this.rng,
      statusRules: this.statusRules,
      onStatus: (t, key, change) => this.noteStatus(caster, t, key, change),
      steal: this.stealHook(caster),
      pool: this.poolOf(caster, targets),
      onAmount: (t, kind, amount, reversed) =>
        amounts.set(t, { kind, amount, ...(reversed ? { reversed: true } : {}) }),
      onKill: (t) => amounts.set(t, { kind: 'damage', amount: 0, kill: true }),
      onHit: (t, kind, amount, round, reversed) =>
        multi.push({
          target: t,
          kind,
          amount,
          round,
          hpAfter: t.hp,
          ...(reversed ? { reversed: true } : {}),
        }),
    }
    const hpSnapshot = this.snapshotHp()
    // 効果も builtin も無い特技は、予兆・メッセージだけの演出用（ログの警告も、対象の MISS も出さない）
    const noEffect = !skill.builtin && !skill.effect
    const lines = skill.builtin
      ? invokeBuiltinSpell(skill.builtin, ctx)
      : skill.effect
        ? this.evalEffectDsl(skill.effect, ctx)
        : []
    for (const line of lines) this.appendLog(line)
    this.recordEffect(
      'skill',
      caster,
      skill.name,
      noEffect ? [] : targets,
      hpSnapshot,
      amounts,
      message,
      omen,
      multi,
      skill.cue
    )
    return true
  }

  // ===== 内部 =====

  private evalEffectDsl(effectStr: string, ctx: EffectContext): string[] {
    const parsed = parseEffect(effectStr)
    if (!parsed) return [`(効果 DSL が解釈できない: '${effectStr}')`]
    return applyEffect(parsed, ctx)
  }

  private advanceAfterPartyAction(react?: PartyReaction): void {
    const atb = this.state.atb
    // 行動した人は、反撃で倒れる前に控える（ATB の currentActorIndex は倒れた者を飛ばす）
    const idx = atb ? this.currentActorIndex() : -1
    // 被弾した敵の反撃と、倒れた敵の死亡時の行動 (#837)。勝敗はこのあとの 1 か所だけで判定する（二重にならない）
    if (react) this.reactToPartyAction(react)
    else this.clearLastDamage()
    // 味方の手番の終わりに状態を進める (#870)。継続ダメージで倒れた味方も、下の勝敗判定・掃除に流れる
    this.endPartyTurnStatuses(idx)
    if (atb) {
      // ATB: 行動した人のゲージを 0 に戻し、キューの次へ（敵は自分のゲージで動くので敵ターンは挟まない）。
      // 倒れた味方の掃除と勝敗は settleAtbPhase に一本化する（同時全滅は敗北優先、#877）
      if (idx !== -1) this.finishAtbAction(idx)
      this.countScriptTurn()
      this.settleAtbPhase()
      return
    }
    // 従来ターン制: 味方が全滅したら（敵も同時に全滅していても）敗北を優先 (#877)。脚本があれば先にステップを進める（復活・終了など）
    if (this.checkEnd()) return
    this.runEnemyTurn()
  }

  // ===== ATB (#205) =====

  private initAtb(cfg: NonNullable<BattleEngineOptions['atb']>): void {
    const clamp = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(ATB_GAUGE_MAX, Math.max(0, v)) : 0
    const { party, enemies } = this.state
    const atb: AtbState = {
      mode: cfg.mode === 'active' ? 'active' : 'wait',
      partyGauge: party.map((_, i) => clamp(cfg.initialGauges?.party?.[i])),
      enemyGauge: enemies.map((_, i) => clamp(cfg.initialGauges?.enemies?.[i])),
      queue: [],
    }
    // 倒れている者のゲージは 0（任意局面・復元で死亡者がいても溜まりっぱなしにしない）
    party.forEach((p, i) => {
      if (p.hp <= 0) atb.partyGauge[i] = 0
    })
    enemies.forEach((e, i) => {
      if (e.hp <= 0) atb.enemyGauge[i] = 0
    })
    // すでに満タンの味方は index 順でコマンド待ちにする（初期ゲージで始めた場合）
    party.forEach((p, i) => {
      if (p.hp > 0 && atb.partyGauge[i] >= ATB_GAUGE_MAX) atb.queue.push(i)
    })
    this.state.atb = atb
    this.state.phase = atb.queue.length > 0 ? 'party-input' : 'atb-running'
  }

  /** 今コマンドを出す味方の party index。ATB はキュー先頭の生存者、従来ターン制は先頭の生存者。いなければ -1 */
  private currentActorIndex(): number {
    const atb = this.state.atb
    if (!atb) return this.state.party.findIndex((p) => p.hp > 0)
    for (const idx of atb.queue) {
      const m = this.state.party[idx]
      if (m && m.hp > 0) return idx
    }
    return -1
  }

  /** 今コマンドを出す味方。導出は currentActorIndex に一本化 */
  private currentActor(): BattleEntity | null {
    const idx = this.currentActorIndex()
    return idx === -1 ? null : this.state.party[idx]
  }

  /** 行動を終えた味方のゲージを 0 に戻し、キューから外す */
  private finishAtbAction(partyIndex: number): void {
    const atb = this.state.atb
    if (!atb) return
    atb.partyGauge[partyIndex] = 0
    atb.queue = atb.queue.filter((i) => i !== partyIndex)
  }

  private fullestAliveIndex(atb: AtbState): number {
    let best = -1
    this.state.party.forEach((p, i) => {
      if (p.hp > 0 && (best === -1 || atb.partyGauge[i] > atb.partyGauge[best])) best = i
    })
    return best
  }

  /** 倒れた味方をキューから除き、勝敗を判定し、フェーズ（コマンド待ち / ゲージ進行中）を整える */
  private settleAtbPhase(): void {
    const atb = this.state.atb
    if (!atb || this.isOver()) return
    atb.queue = atb.queue.filter((i) => (this.state.party[i]?.hp ?? 0) > 0)
    this.state.party.forEach((p, i) => {
      if (p.hp <= 0) atb.partyGauge[i] = 0
    })
    this.state.enemies.forEach((e, i) => {
      if (e.hp <= 0) atb.enemyGauge[i] = 0
    })
    if (this.checkEnd()) return
    this.state.phase = atb.queue.length > 0 ? 'party-input' : 'atb-running'
    this.autoResolveParty()
  }

  /** 全滅 / 殲滅していれば終了フェーズへ。終了したら true */
  private checkEnd(): boolean {
    if (this.isOver()) return true
    // 脚本のステップ (#741)。復活・参戦・逃走・強制終了は、勝敗の判定より前に決める（復活すれば全滅にならない）
    this.scriptStep()
    if (this.isOver()) return true
    // 同時全滅（敵も味方も HP 0）は味方全滅=敗北を優先する (#877)
    if (this.state.party.every((p) => p.hp === 0)) {
      this.state.phase = 'defeat'
      this.appendLog('ぜんめつ してしまった……')
      return true
    }
    if (this.state.enemies.every((e) => e.hp === 0)) {
      this.handleVictory()
      return true
    }
    return false
  }

  private atbRate(entity: BattleEntity): number {
    // AGI に比例。0 以下・非有限でも最低 1 で進める（永久に溜まらないと戦闘が止まるため）
    const agi = Number.isFinite(entity.agi) ? Math.max(1, entity.agi) : 1
    return agi * ATB_FILL_PER_AGI_MS
  }

  /** 次にゲージが満タンになるまでの ms（remaining を上限とする）。進めるゲージが無ければ null */
  private timeToNextFill(atb: AtbState, remaining: number): number | null {
    let dt = remaining
    let any = false
    const consider = (e: BattleEntity, gauge: number, inQueue: boolean) => {
      if (e.hp <= 0 || inQueue) return
      any = true
      dt = Math.min(dt, (ATB_GAUGE_MAX - gauge) / this.atbRate(e))
    }
    this.state.party.forEach((p, i) => consider(p, atb.partyGauge[i], atb.queue.includes(i)))
    this.state.enemies.forEach((e, i) => consider(e, atb.enemyGauge[i], false))
    return any ? Math.max(0, dt) : null
  }

  private advanceGauges(atb: AtbState, dt: number): void {
    this.state.party.forEach((p, i) => {
      if (p.hp <= 0 || atb.queue.includes(i)) return
      atb.partyGauge[i] = Math.min(ATB_GAUGE_MAX, atb.partyGauge[i] + dt * this.atbRate(p))
    })
    this.state.enemies.forEach((e, i) => {
      if (e.hp <= 0) return
      atb.enemyGauge[i] = Math.min(ATB_GAUGE_MAX, atb.enemyGauge[i] + dt * this.atbRate(e))
    })
  }

  /** 満タン（浮動小数の誤差を許す）で行動待ちの者を集める。キュー済みの味方は除く */
  private collectReady(atb: AtbState): { side: 'party' | 'enemy'; index: number }[] {
    const eps = 1e-6
    const out: { side: 'party' | 'enemy'; index: number }[] = []
    this.state.party.forEach((p, i) => {
      if (p.hp > 0 && !atb.queue.includes(i) && atb.partyGauge[i] >= ATB_GAUGE_MAX - eps) {
        atb.partyGauge[i] = ATB_GAUGE_MAX
        out.push({ side: 'party', index: i })
      }
    })
    this.state.enemies.forEach((e, i) => {
      if (e.hp > 0 && atb.enemyGauge[i] >= ATB_GAUGE_MAX - eps) {
        atb.enemyGauge[i] = ATB_GAUGE_MAX
        out.push({ side: 'enemy', index: i })
      }
    })
    return out
  }

  /** rng による Fisher-Yates（同時に満タンになった者の順序を乱数で決める）。1 人以下なら rng を消費しない */
  private shuffled<T>(list: T[]): T[] {
    const a = [...list]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  /** 敵 1 体の自動行動（通常攻撃。狙いは生存味方からランダム）。行動後ゲージは 0 */
  private runAtbEnemyAction(atb: AtbState, enemyIndex: number): void {
    const enemy = this.state.enemies[enemyIndex]
    atb.enemyGauge[enemyIndex] = 0
    if (!enemy || enemy.hp <= 0) return
    const alive = this.state.party.filter((p) => p.hp > 0)
    if (alive.length === 0) return
    // 行動不能・混乱の敵 (#870): 行動を選ばず、手番を状態に従って過ごす（行動回数・順番の記憶は進めない）
    const block = this.actorBlock(enemy)
    if (block) {
      this.runBlockedEnemy(enemy, block)
      this.tickStatuses(enemy)
      this.resolveDeaths()
      this.pruneDownedParty(atb)
      this.checkEnd()
      return
    }
    const choice = this.decideEnemyAction(enemyIndex)
    if (choice.kind === 'skill' && this.useEnemySkill(enemyIndex, choice)) {
      // 特技で倒れた味方は、通常攻撃で倒れたときと同じくコマンド待ち・ゲージから外す
      this.state.party.forEach((p, i) => {
        if (p.hp > 0) return
        atb.queue = atb.queue.filter((q) => q !== i)
        atb.partyGauge[i] = 0
      })
      this.countEnemyAction(enemyIndex, choice)
      this.tickStatuses(enemy)
      this.resolveDeaths()
      this.pruneDownedParty(atb)
      this.checkEnd()
      return
    }
    const picked = this.pickedParty(choice)
    const target =
      picked ?? alive[Math.min(alive.length - 1, Math.floor(this.rng() * alive.length))]
    const hpBefore = target.hp
    const dmg = applyDamageToHp(target, this.computeAttackDamage(enemy, target))
    this.recordAttack(enemy, target, hpBefore, dmg)
    this.appendLog(`${enemy.name} の こうげき！`)
    this.appendLog(`${target.name} は ${dmg} の ダメージを うけた！`)
    if (target.hp === 0) {
      this.appendLog(`${target.name} は たおれた！`)
      const idx = this.state.party.indexOf(target)
      atb.queue = atb.queue.filter((i) => i !== idx)
      atb.partyGauge[idx] = 0
    }
    this.countEnemyAction(enemyIndex, choice, true)
    this.tickStatuses(enemy)
    this.resolveDeaths()
    this.pruneDownedParty(atb)
    this.checkEnd()
  }

  /**
   * 敵の次の行動を決める (#835)。`行動:` を持つ敵がいる戦闘（`enemyMemory` あり）だけ `chooseEnemyAction` に任せる。
   * 持たない戦闘は通常攻撃（rng は触らない）
   */
  private decideEnemyAction(enemyIndex: number): ChosenAction {
    if (!this.state.enemyMemory) return { kind: 'attack' }
    return chooseEnemyAction(this.state, enemyIndex, this.rng)
  }

  /** 選ばれた特技を使う。エンジンに無い id、使えない状況（戦闘終了など）なら false（呼び出し側が通常攻撃に落とす） */
  private useEnemySkill(
    enemyIndex: number,
    choice: Extract<ChosenAction, { kind: 'skill' }>,
    allowDowned = false
  ): boolean {
    const skill = hasOwn(this.skills, choice.skillId) ? this.skills[choice.skillId] : undefined
    if (!skill) {
      // 同じ id は 1 戦闘に 1 度だけ警告する（敵の行動のたびに出さない）
      if (!this.warnedSkills.has(choice.skillId)) {
        this.warnedSkills.add(choice.skillId)
        console.warn(
          `[name-name] 行動: の特技 '${choice.skillId}' が見つからないため通常攻撃にします`
        )
      }
      return false
    }
    // `対象=` の上書き: `仲間` / `自分`（→ 仲間単体 / 自分）はどの特技にも効く。ランダム / HP最小 / 全体（→ 相手側を向く）は
    // 特技の対象が相手単体（省略・未知を含む）のときだけ。仲間単体・仲間全体・自分・相手全体の特技の向きは変えない
    // （仲間向けの特技を相手側に向けて、敵がプレイヤーを回復するようなことを避ける）
    const t = typeof skill.target === 'string' ? skill.target.trim() : ''
    const isOpponentSingle = t === '相手単体' || !SKILL_TARGETS.includes(t)
    const o = choice.targetOverride
    const applies = o !== undefined && (o === '仲間単体' || o === '自分' || isOpponentSingle)
    // 予兆: 行の `予兆=` が特技の `予兆` より優先（P2 #836）
    const omen = choice.omen !== undefined ? choice.omen : skill.telegraph
    // 敵は召喚獣を呼ばない (#750): 特技に `cue` が付いていても敵の行動の記録には載せない（召喚獣の演出は味方の召喚・「わざ」だけ）
    const enemySkill: SkillExecution = { ...skill }
    delete enemySkill.cue
    const exec = {
      ...enemySkill,
      ...(applies ? { target: o } : {}),
      ...(omen !== undefined ? { telegraph: omen } : {}),
    }
    return this.performSkill(
      { side: 'enemy', index: enemyIndex },
      exec,
      applies || o === undefined ? choice.target : undefined,
      allowDowned ? { allowDowned: true } : undefined
    )
  }

  /** 行動を終えた敵の記憶を進める (#835 行動回数、#836 順番の位置・使用回数)。記憶が無い戦闘では何もしない */
  private countEnemyAction(enemyIndex: number, choice: ChosenAction, usedAttack = false): void {
    const m = this.state.enemyMemory?.[enemyIndex]
    if (!m) return
    // 特技が見つからず通常攻撃に落ちたときは、使用回数を特技 id でなく通常攻撃に数える
    const c: ChosenAction =
      usedAttack && choice.track
        ? { ...choice, track: { ...choice.track, key: 'こうげき' } }
        : choice
    recordEnemyAction(m, c)
  }

  /** `対象=ランダム` / `HP最小` で選ばれた生存味方。無ければ null（従来の狙い方） */
  private pickedParty(choice: ChosenAction): BattleEntity | null {
    if (!choice.target || choice.target.side !== 'party') return null
    const t = this.state.party[choice.target.index]
    return t && t.hp > 0 ? t : null
  }

  /** 味方の行動のうち、被弾した敵の反撃・死亡時の行動に渡す情報。敵の記憶が無い戦闘では undefined（何も起きない） */
  private reactionOf(
    attacker: BattleEntity,
    source: HitSource,
    before: Map<BattleEntity, number>
  ): PartyReaction | undefined {
    if (!this.state.enemyMemory) return undefined
    const ref = this.refOf(attacker)
    return ref ? { attacker: ref, source, before, damage: this.damageDealtBy(ref) } : undefined
  }

  /**
   * 味方 `attacker` の行動 1 回（直前に記録されたイベント）が、敵 index ごとに与えたダメージ（画面に出る数字 = `BattleHit.amount` の合計）(#871)。
   * 数字を持たない即死・MISS・回復（吸収）は数えない（その敵は値なし）。直前のイベントがその味方の行動でなければ空（`ダメージ…` 条件が不成立になる）
   */
  private damageDealtBy(attacker: BattleActorRef): Map<number, number> {
    const out = new Map<number, number>()
    const ev = this.state.events[this.state.events.length - 1]
    if (!ev || ev.actor.side !== attacker.side || ev.actor.index !== attacker.index) return out
    if (ev.kind === 'status' || ev.kind === 'notice') return out
    for (const h of ev.hits) {
      if (h.kind !== 'damage' || h.instantDeath || h.target.side !== 'enemy') continue
      out.set(h.target.index, (out.get(h.target.index) ?? 0) + h.amount)
    }
    return out
  }

  /** 味方の行動が敵にダメージを与えなかった手番（行動不能など）。`ダメージ…` を書いた敵の前回の値を残さない (#871) */
  private clearLastDamage(): void {
    const memory = this.state.enemyMemory
    if (!memory) return
    this.state.enemies.forEach((e, i) => {
      if (tracksDamage(e)) delete memory[i].lastDamage
    })
  }

  /**
   * 味方の行動 1 回のあとの、被弾した敵の反撃と死亡時の行動 (#837)。
   * - 被弾 = 行動の前後で HP が減った敵。**1 行動につき 1 回**（1 行動で何ヒットしても、全体攻撃で複数の敵に当たっても敵ごとに 1 回）
   * - 被弾の記憶（`hits` `lastHit` `lastAttacker`）は、被弾の語彙を使う敵（`tracksHits`）だけに残す。ほかの敵の記憶・乱数は触らない
   * - 反撃は生きている敵だけ。ダメージ確定後、敵の並び順に 1 体ずつ。反撃は反撃を起こさない（この関数は味方の行動からしか呼ばれない）
   * - そのあと倒れた敵の死亡時の行動（`resolveDeaths`）。勝敗は呼び出し側が 1 度だけ判定する
   */
  private reactToPartyAction(react: PartyReaction): void {
    const memory = this.state.enemyMemory
    if (!memory) return
    const hit: number[] = []
    this.state.enemies.forEach((e, i) => {
      // 受けたダメージ (#871)。HP が減ったかどうかに関わらず、この行動が与えた表示数字（0 を含む）に置き換える。
      // 数字が出なかった（MISS・無効・吸収・即死のみ・この行動の対象外）敵は前回の値を残さず値なしにする
      if (tracksDamage(e)) {
        const dealt = react.damage.get(i)
        if (dealt === undefined) delete memory[i].lastDamage
        else memory[i].lastDamage = dealt
      }
      const before = react.before.get(e)
      if (before === undefined || e.hp >= before || !tracksHits(e)) return
      const m = memory[i]
      m.hits = (m.hits ?? 0) + 1
      m.lastHit = react.source
      m.lastAttacker = react.attacker
      hit.push(i)
    })
    for (const i of hit) {
      const enemy = this.state.enemies[i]
      if (enemy.hp <= 0 || !enemy.counters || enemy.counters.length === 0) continue
      if (this.state.party.every((p) => p.hp === 0)) break
      const choice = chooseEnemyReaction(this.state, i, parseCounterRules(enemy.counters), this.rng)
      if (choice) this.performReaction(i, choice, 'はんげき！')
    }
    this.resolveDeaths()
  }

  /**
   * 倒れた敵の `死亡時:` を、倒れた順（敵の並び順）に 1 体ずつ 1 度だけ実行する (#837)。
   * 死亡時の行動で別の敵が倒れたときはその敵の分も続ける。味方が全滅していれば実行しない。
   * 記憶が無い戦闘・`死亡時:` を持たない敵は何も起きない（乱数も消費しない）
   */
  private resolveDeaths(): void {
    const memory = this.state.enemyMemory
    if (!memory) return
    for (let guard = 0; guard <= this.state.enemies.length; guard++) {
      const i = this.state.enemies.findIndex(
        (e, k) => e.hp <= 0 && hasOnDeath(e) && !memory[k].died
      )
      if (i === -1) return
      memory[i].died = true
      if (this.state.party.every((p) => p.hp === 0)) return
      const rules = parseDeathRules(this.state.enemies[i].onDeath as string)
      const choice = chooseEnemyReaction(this.state, i, rules, this.rng)
      if (choice) this.performReaction(i, choice, 'さいごの あがき！')
    }
  }

  /**
   * 反撃・死亡時の行動を 1 回実行する (#837)。特技（エンジンに無い id は通常攻撃に落ちる）か通常攻撃。
   * 敵の行動回数 `acted`・順番の位置は進めない（ターンの台本とは別）。狙いが決まらなければ最初の生存味方
   */
  private performReaction(enemyIndex: number, choice: ChosenAction, attackLine: string): void {
    const enemy = this.state.enemies[enemyIndex]
    if (choice.kind === 'skill' && this.useEnemySkill(enemyIndex, choice, true)) return
    const hero = this.pickedParty(choice) ?? this.firstAlive(this.state.party)
    if (!hero) return
    const hpBefore = hero.hp
    const dmg = applyDamageToHp(hero, this.computeAttackDamage(enemy, hero))
    this.recordAttack(enemy, hero, hpBefore, dmg)
    // 既定の文言（仮。上書きの仕組みは未実装）。特技を使うときは特技の message / 既定の「つかった！」が出る
    this.appendLog(`${enemy.name} の ${attackLine}`)
    this.appendLog(`${hero.name} は ${dmg} の ダメージを うけた！`)
    if (hero.hp === 0) this.appendLog(`${hero.name} は たおれた！`)
  }

  /** ATB: 倒れた味方をコマンド待ち・ゲージから外す（反撃・死亡時の行動で倒れた分。通常攻撃と同じ後始末） */
  private pruneDownedParty(atb: AtbState): void {
    this.state.party.forEach((p, i) => {
      if (p.hp > 0) return
      atb.queue = atb.queue.filter((q) => q !== i)
      atb.partyGauge[i] = 0
    })
  }

  private handleVictory(): void {
    this.state.phase = 'victory'
    let exp = 0
    let gold = 0
    const fled = this.state.script?.fled ?? []
    this.state.enemies.forEach((e, i) => {
      if (fled.includes(i)) return // 逃げた敵の経験値・ゴールドは入らない (#741)
      exp += e.exp ?? 0
      gold += e.gold ?? 0
    })
    this.state.earnedExp = exp
    this.state.earnedGold = gold
    this.appendLog(`けいけんち ${exp} を てに いれた！`)
    this.appendLog(`${gold} ゴールドを てに いれた！`)
    this.rollDropsOnVictory()
  }

  /**
   * ドロップの抽選 (#831)。勝利の瞬間に、戦利品を宣言した敵だけを敵の並び順に、`ドロップ:` の行ごとに独立に判定する。
   * 宣言の無い戦闘は何もしない（乱数を使わない）
   */
  private rollDropsOnVictory(): void {
    if (this.dropsRolled) return
    this.dropsRolled = true
    const fled = this.state.script?.fled ?? []
    for (const [i, enemy] of this.state.enemies.entries()) {
      if (fled.includes(i)) continue // 逃げた敵はドロップしない (#741)
      const spec = this.lootSpecs.get(enemy)
      if (!spec) continue
      for (const line of rollDrops(spec, this.rng)) {
        this.addLoot({
          itemId: line.itemId,
          count: line.count,
          via: 'drop',
          rare: false,
          enemyId: enemy.id,
          enemyName: enemy.name,
        })
        this.appendLog(`${this.lootLabel(line.itemId, line.count)} を てに いれた！`)
      }
    }
  }

  /** 戦利品の表示名（`名前` または `名前 ×N`）。名前が分からない id は id のまま */
  private lootLabel(itemId: string, count: number): string {
    const name = hasOwn(this.itemNames, itemId) ? this.itemNames[itemId] : itemId
    return count > 1 ? `${name} ×${count}` : name
  }

  private addLoot(entry: LootEntry): void {
    if (!this.state.loot) this.state.loot = []
    this.state.loot.push(entry)
  }

  /**
   * ぬすむの実行口 (#831)。効果 DSL `steal` が `EffectContext.steal` として呼ぶ。盗めるのは**味方が敵から**だけ
   * （敵が味方から盗む・ゴールドや装備を盗むのは未対応）。倒れた敵・戦利品を宣言しない敵・盗める回数に達した敵は `empty`。
   * 盗めた品は `BattleState.loot` に積み（その場でホストに渡る扱い。逃走・敗北でも失われない）、その敵の盗めた回数を 1 増やす。
   * HP が動かなくても MISS 表示にならないよう、対象を `statusTouched` に入れる
   */
  private stealHook(caster: BattleEntity): NonNullable<EffectContext['steal']> {
    return (target, params) => {
      if (!this.state.party.includes(caster) || !this.state.enemies.includes(target)) {
        return { log: ['(警告: ぬすめるのは味方から敵だけ)'], outcome: 'empty' }
      }
      if (target.hp <= 0) return { log: [], outcome: 'empty' }
      this.statusTouched.add(target)
      const spec = this.lootSpecs.get(target)
      const stolen = this.stolenCounts.get(target) ?? 0
      const full: StealParams = {
        ...params,
        ...(caster.stealChanceBonus !== undefined ? { chanceBonus: caster.stealChanceBonus } : {}),
        ...(caster.stealRareBonus !== undefined ? { rareBonus: caster.stealRareBonus } : {}),
      }
      const r = spec ? attemptSteal(spec, stolen, full, this.rng) : { kind: 'empty' as const }
      if (r.kind === 'empty') {
        return { log: [`${target.name} は もう なにも もっていない！`], outcome: 'empty' }
      }
      if (r.kind === 'miss') {
        return { log: [`${target.name} から ぬすめなかった！`], outcome: 'miss' }
      }
      this.stolenCounts.set(target, stolen + 1)
      this.addLoot({
        itemId: r.line.itemId,
        count: r.line.count,
        via: 'steal',
        rare: r.rare,
        enemyId: target.id,
        enemyName: target.name,
      })
      return {
        log: [
          `${caster.name} は ${target.name} から ${this.lootLabel(r.line.itemId, r.line.count)} を ぬすんだ！`,
        ],
        outcome: 'got',
      }
    }
  }

  /**
   * 戦闘の結果をホストに渡す形にまとめる (#831)。終了していなければ null。経験値・ゴールドは victory のときだけ入る。
   * 戦利品はぬすんだ品（逃走・敗北でも入る）とドロップ（victory のみ）
   */
  getResult(): BattleResult | null {
    const phase = this.state.phase
    if (
      phase !== 'victory' &&
      phase !== 'defeat' &&
      phase !== 'escaped' &&
      phase !== 'interrupted'
    ) {
      return null
    }
    const loot = (this.state.loot ?? []).map((e) => ({ ...e }))
    const script = this.state.script
    const declared = script && this.scriptParsed ? resultFor(this.scriptParsed, phase) : undefined
    return {
      outcome: phase,
      exp: this.state.earnedExp,
      gold: this.state.earnedGold,
      loot,
      items: summarizeLoot(loot),
      // 脚本制御の戦闘 (#741): 結果フラグ・次のイベントをホストへ返す（宣言が無い終わり方も、脚本の戦闘だったことは伝える）
      ...(script
        ? {
            script: {
              id: script.id,
              flags: { ...(declared?.flags ?? {}) },
              ...(declared?.next !== undefined ? { next: declared.next } : {}),
            },
          }
        : {}),
    }
  }

  private runEnemyTurn(): void {
    this.state.phase = 'enemy-turn'
    let usedSkill = false
    for (let i = 0; i < this.state.enemies.length; i++) {
      const enemy = this.state.enemies[i]
      if (enemy.hp === 0) continue
      const firstHero = this.firstAlive(this.state.party)
      if (!firstHero) break
      // 行動不能・混乱の敵 (#870)。味方陣営が減るのは混乱した敵が味方の敵を殴るときだけだが、敵が倒れうるので勝敗を見直す印を立てる
      const block = this.actorBlock(enemy)
      if (block) {
        usedSkill = true
        this.runBlockedEnemy(enemy, block)
        this.tickStatuses(enemy)
        this.resolveDeaths()
        // 死亡時の行動で付いた状態の記録は、次の敵の手番の終わりまで持ち越さない (#870)
        this.freshStatuses = []
        continue
      }
      const choice = this.decideEnemyAction(i)
      if (choice.kind === 'skill' && this.useEnemySkill(i, choice)) {
        usedSkill = true
        this.countEnemyAction(i, choice)
        this.tickStatuses(enemy)
        this.resolveDeaths()
        // 死亡時の行動で付いた状態の記録は、次の敵の手番の終わりまで持ち越さない (#870)
        this.freshStatuses = []
        continue
      }
      const hero = this.pickedParty(choice) ?? firstHero
      const hpBefore = hero.hp
      const dmg = applyDamageToHp(hero, this.computeAttackDamage(enemy, hero))
      this.recordAttack(enemy, hero, hpBefore, dmg)
      this.appendLog(`${enemy.name} の こうげき！`)
      this.appendLog(`${hero.name} は ${dmg} の ダメージを うけた！`)
      if (hero.hp === 0) {
        this.appendLog(`${hero.name} は たおれた！`)
      }
      this.countEnemyAction(i, choice, true)
      if (this.hasStatusRules) {
        // 継続ダメージ・満了で敵が倒れうる (#870)
        usedSkill = true
        this.tickStatuses(enemy)
        this.resolveDeaths()
        // 死亡時の行動で付いた状態の記録は、次の敵の手番の終わりまで持ち越さない (#870)
        this.freshStatuses = []
      }
    }
    // 敵側の手番の終わりに、今の手番で付いた状態の記録を持ち越さない (#870)
    this.freshStatuses = []
    // 従来ターン制は「味方の行動 → 敵の行動」の 1 巡で 1 ターン (#741)。脚本のステップは勝敗の判定より前（復活すれば全滅にならない）
    if (!this.state.atb) {
      this.countScriptTurn()
      this.scriptStep()
      if (this.isOver()) return
    }
    if (this.state.party.every((p) => p.hp === 0)) {
      this.state.phase = 'defeat'
      this.appendLog('ぜんめつ してしまった……')
      return
    }
    // 特技（仲間への攻撃など）で敵が全滅しうるのは特技を使ったときだけ（通常攻撃では敵は減らない）。脚本の逃走で全滅するのは脚本の戦闘だけ
    if (
      (usedSkill || this.state.script !== undefined) &&
      this.state.enemies.every((e) => e.hp === 0)
    ) {
      this.handleVictory()
      return
    }
    this.state.phase = 'party-input'
    this.autoResolveParty()
  }

  private resolveSpellTargets(spell: SpellExecution, targetId?: string): BattleEntity[] {
    // 前後の空白は無視する（候補窓の parseSpellTarget と同じ）
    switch (typeof spell.target === 'string' ? spell.target.trim() : spell.target) {
      case '味方単体': {
        if (targetId) {
          return this.state.party.filter((p) => p.id === targetId)
        }
        const alive = this.currentActor()
        return alive ? [alive] : []
      }
      case '味方全体':
        return this.state.party.filter((p) => p.hp > 0)
      case '敵全体':
        return this.state.enemies.filter((e) => e.hp > 0)
      case '自分':
        return [this.currentActor()].filter((x): x is BattleEntity => x !== null)
      case 'マップ':
        return [] // 戦闘内では効果対象なし。builtin が no-op で処理する想定
      case '敵単体':
      default: {
        const t = targetId
          ? this.state.enemies.find((e) => e.id === targetId && e.hp > 0)
          : this.firstAlive(this.state.enemies)
        return t ? [t] : []
      }
    }
  }

  /**
   * 特技の対象を「使う側から見た相対表現」で解決する (#834)。rng は使わない。
   * 明示指定 `target` は単体のときだけ効き、相手単体は生存者に限る。仲間単体は同じ側の者で、倒れている者を指せるのは
   * 蘇生の効果（`revive` / builtin `zaorik`）のときだけ。それ以外は最初の生存者に落とす。蘇生の仲間単体で省略したときは最初の倒れた仲間。
   */
  private resolveSkillTargets(
    side: 'party' | 'enemy',
    user: BattleEntity,
    skill: SkillExecution,
    target?: BattleActorRef,
    excludeUser = false
  ): BattleEntity[] {
    const allies = side === 'party' ? this.state.party : this.state.enemies
    const opponents = side === 'party' ? this.state.enemies : this.state.party
    const explicit = (list: BattleEntity[], side0: 'party' | 'enemy'): BattleEntity | undefined =>
      target && target.side === side0 ? list[target.index] : undefined
    switch (typeof skill.target === 'string' ? skill.target.trim() : skill.target) {
      case '相手全体':
        return opponents.filter((e) => e.hp > 0)
      case '自分':
        return excludeUser ? [] : [user]
      case '仲間全体':
        return allies.filter((e) => e.hp > 0 && !(excludeUser && e === user))
      case '仲間単体': {
        const revive = isReviveEntry('spell', skill)
        // 倒れた使い手本人（死亡時の行動 #837）は、明示した対象にも既定の「最初の倒れた仲間」にもならない
        // 脚本で逃げた敵 (#741) は戦闘から消えている。蘇生の対象にも、最初の倒れた仲間にもならない
        const candidates = allies.filter(
          (e) => !(excludeUser && e === user) && !this.isFledEnemy(e)
        )
        const p0 = explicit(allies, side)
        const picked = p0 && !(excludeUser && p0 === user) && !this.isFledEnemy(p0) ? p0 : undefined
        const t =
          picked && (picked.hp > 0 || revive)
            ? picked
            : revive
              ? (candidates.find((e) => e.hp <= 0) ?? this.firstAlive(candidates))
              : this.firstAlive(candidates)
        return t ? [t] : []
      }
      case '相手単体':
      default: {
        const picked = explicit(opponents, side === 'party' ? 'enemy' : 'party')
        const t = picked && picked.hp > 0 ? picked : this.firstAlive(opponents)
        return t ? [t] : []
      }
    }
  }

  private resolveItemTargets(item: ItemExecution, targetId?: string): BattleEntity[] {
    // アイテムは「味方単体」既定で、明示的 target が無ければパーティ最初の生存者
    void item
    if (targetId) {
      const t = this.state.party.find((p) => p.id === targetId)
      return t ? [t] : []
    }
    const hero = this.currentActor()
    return hero ? [hero] : []
  }

  private firstAlive(list: BattleEntity[]): BattleEntity | null {
    return list.find((e) => e.hp > 0) ?? null
  }

  /** entity が味方・敵のどちらの何番目か。どちらにもいなければ null */
  private refOf(entity: BattleEntity): BattleActorRef | null {
    const pi = this.state.party.indexOf(entity)
    if (pi !== -1) return { side: 'party', index: pi }
    const ei = this.state.enemies.indexOf(entity)
    return ei !== -1 ? { side: 'enemy', index: ei } : null
  }

  /**
   * 複数ヒットで標的が倒れたときの乗り換え先 (#879)。**行動者から見て相手陣営の単体を狙うときだけ**その陣営の全員を返す。
   * 自分・仲間（同陣営）を狙うとき・標的がいないときは undefined（倒れたら残りのヒットは打ち切り。仲間に流さない）
   */
  private poolOf(caster: BattleEntity, targets: BattleEntity[]): BattleEntity[] | undefined {
    const first = targets[0]
    if (!first) return undefined
    const casterIsParty = this.state.party.includes(caster)
    const opponents = casterIsParty ? this.state.enemies : this.state.party
    return opponents.includes(first) ? opponents : undefined
  }

  /** 全員の現在 HP を控える（呪文・アイテムの効果の前後差から結果を導く） */
  private snapshotHp(): Map<BattleEntity, number> {
    const m = new Map<BattleEntity, number>()
    for (const e of [...this.state.party, ...this.state.enemies]) m.set(e, e.hp)
    return m
  }

  /** 通常攻撃 1 回を記録する (#745)。`damage` は計算上のダメージ（HP が実際に減った量ではない。オーバーキルでもそのまま） */
  private recordAttack(
    actor: BattleEntity,
    target: BattleEntity,
    hpBefore: number,
    damage: number,
    /** 通常攻撃の属性 (#889) が吸収された（heal）・無効だった（miss）ときだけ指定する。既定は damage */
    hitKind: BattleHitKind = 'damage'
  ): void {
    const actorRef = this.refOf(actor)
    const targetRef = this.refOf(target)
    if (!actorRef || !targetRef) return
    this.breakOnDamage(target, hpBefore)
    this.pushEvent({
      actor: actorRef,
      kind: 'attack',
      hits: [
        {
          target: targetRef,
          kind: hitKind,
          amount: damage,
          hpBefore,
          hpAfter: target.hp,
        },
      ],
    })
  }

  /** ダメージ数字は 1 回のダメージの上限 (#877) を超えない（計算量を通知しない効果の HP の前後差で代用する経路。即死は kill 分岐で数字を持たない）。回復は切らない */
  private capHitAmount(kind: 'damage' | 'heal', amount: number): number {
    return kind === 'damage' ? clampDamage(amount) : amount
  }

  /**
   * 呪文・アイテム・特技 (#834) 1 回を記録する (#745)。効果は DSL・builtin のどちらでも HP を直接書き換えるので、
   * 効果の前後の HP 差で結果を導く（減った=damage / 増えた=heal）。対象にしたのに HP が変わらなかった者は miss。
   */
  private recordEffect(
    kind: 'spell' | 'item' | 'skill',
    actor: BattleEntity,
    label: string,
    targets: BattleEntity[],
    before: Map<BattleEntity, number>,
    amounts: Map<BattleEntity, ComputedAmount>,
    message?: string,
    omen?: string,
    multi: MultiHit[] = [],
    cue?: SummonCue
  ): void {
    const actorRef = this.refOf(actor)
    if (!actorRef) return
    // この行動で状態を付けられた・解かれた者（HP が動かなくても MISS にしない）。次の行動へ持ち越さない (#870)
    const touched = this.statusTouched
    this.statusTouched = new Set()
    // HP が減って生き残った者の「被ダメージで解ける」状態を解く (#870)
    for (const e of [...this.state.party, ...this.state.enemies]) {
      const b = before.get(e)
      if (b !== undefined) this.breakOnDamage(e, b)
    }
    const hits: BattleHit[] = []
    // 複数ヒット (#879): 効果が 1 ヒットごとに通知したときは、その列（再生順）をそのまま hits にする。
    // HP は直前のヒットから連鎖させる（各対象の最初の hpBefore は行動前の HP）
    if (multi.length > 0) {
      const chain = new Map<BattleEntity, number>()
      for (const h of multi) {
        const ref = this.refOf(h.target)
        if (!ref) continue
        const hpBefore = chain.get(h.target) ?? before.get(h.target) ?? h.target.hp
        chain.set(h.target, h.hpAfter)
        hits.push({
          target: ref,
          kind: h.kind,
          amount: h.amount,
          hpBefore,
          hpAfter: h.hpAfter,
          round: h.round,
          ...(h.reversed ? { reversed: true } : {}),
        })
      }
      this.pushEvent({
        actor: actorRef,
        kind,
        label,
        ...(message !== undefined ? { message } : {}),
        ...(omen !== undefined ? { omen } : {}),
        ...(cue ? { summon: cue } : {}),
        hits,
      })
      return
    }
    for (const e of [...this.state.party, ...this.state.enemies]) {
      const hpBefore = before.get(e) ?? e.hp
      const ref = this.refOf(e)
      if (!ref) continue
      // 計算上の量（オーバーキル・回復の上限切りを含む）が通知されていればそれを数字にする。無ければ HP の前後差
      const computed = amounts.get(e)
      const rv = computed?.reversed ? { reversed: true as const } : {}
      if (computed?.kill && e.hp < hpBefore) {
        // 即死 (#877): 数字を持たない。amount は HP の前後差（hpBefore - hpAfter）で、表示は instantDeath を見て「たおれた」だけにする
        hits.push({
          target: ref,
          kind: 'damage',
          amount: hpBefore - e.hp,
          hpBefore,
          hpAfter: e.hp,
          instantDeath: true,
        })
      } else if (computed && e.hp !== hpBefore) {
        const k = e.hp < hpBefore ? 'damage' : 'heal'
        hits.push({
          target: ref,
          kind: k,
          amount: this.capHitAmount(
            k,
            computed.kind === k ? computed.amount : Math.abs(e.hp - hpBefore)
          ),
          hpBefore,
          hpAfter: e.hp,
          ...rv,
        })
      } else if (computed?.kind === 'heal' && computed.amount > 0 && targets.includes(e)) {
        // HP が変わらなかったが量はある（満タンへの回復）。数字は計算上の量
        hits.push({
          target: ref,
          kind: 'heal',
          amount: computed.amount,
          hpBefore,
          hpAfter: e.hp,
          ...rv,
        })
      } else if (computed?.kind === 'damage' && computed.amount === 0 && hpBefore > 0) {
        // 計算上のダメージが 0（防御が上回るなど）は MISS でなく「0」。MISS は回避・無効（耐性 0）のときだけ
        hits.push({ target: ref, kind: 'damage', amount: 0, hpBefore, hpAfter: e.hp })
      } else if (e.hp < hpBefore) {
        hits.push({
          target: ref,
          kind: 'damage',
          amount: clampDamage(hpBefore - e.hp),
          hpBefore,
          hpAfter: e.hp,
        })
      } else if (e.hp > hpBefore) {
        hits.push({ target: ref, kind: 'heal', amount: e.hp - hpBefore, hpBefore, hpAfter: e.hp })
      } else if (
        targets.includes(e) &&
        !touched.has(e) &&
        !(computed?.kind === 'heal' && computed.amount === 0)
      ) {
        // 回復量 0 で HP も変わらない対象は MISS にしない（予兆だけの特技など）
        hits.push({ target: ref, kind: 'miss', amount: 0, hpBefore, hpAfter: e.hp })
      }
    }
    this.pushEvent({
      actor: actorRef,
      kind,
      label,
      ...(message !== undefined ? { message } : {}),
      ...(omen !== undefined ? { omen } : {}),
      ...(cue ? { summon: cue } : {}),
      hits,
    })
  }

  /** 行動が成立しなかったことの知らせ (#745)。FF 式の窓に短い言葉だけを出す。対象はなく、絵は動かない */
  private recordNotice(actor: BattleEntity | undefined, label: string): void {
    // 主体が決まらないとき（全員戦闘不能など）は先頭の味方に倒す。フォールバックはここ 1 か所
    const ref = (actor ? this.refOf(actor) : null) ?? { side: 'party' as const, index: 0 }
    this.pushEvent({ actor: ref, kind: 'notice', label, hits: [] })
  }

  private pushEvent(e: Omit<BattleActionEvent, 'seq'>): void {
    // 倒れた者は宣言した状態を全部失う (#870)。行動の結果の HP はすべて、記録の前に確定している
    this.clearDownedStatuses()
    // 状態名の控え。状態が一度も付いていない間は付けない（宣言だけして使わない戦闘は、イベントも従来と同じ）。
    // 一度付いたあとは、全員の状態が消えたことも伝えるため付け続ける
    let labelsSnap: { party: string[][]; enemies: string[][] } | undefined
    if (this.hasStatusRules) {
      const snap = {
        party: this.state.party.map((p) => this.getStatusLabels(p)),
        enemies: this.state.enemies.map((en) => this.getStatusLabels(en)),
      }
      const any = [...snap.party, ...snap.enemies].some((l) => l.length > 0)
      if (any || this.statusLabelsSeen) labelsSnap = snap
      if (any) this.statusLabelsSeen = true
    }
    this.state.events.push({
      seq: this.state.eventTotal,
      ...e,
      ...(labelsSnap ? { statusLabels: labelsSnap } : {}),
    })
    this.state.eventTotal++
    if (this.state.events.length > EVENT_MAX) this.state.events.shift()
  }

  private appendLog(line: string): void {
    this.state.log.push(line)
    this.state.logTotal++
    if (this.state.log.length > LOG_MAX) this.state.log.shift()
  }

  // ===== 脚本制御の戦闘 (#741 / #863) =====

  /** 経過ターンを 1 進める（脚本のある戦闘だけ）。従来ターン制は敵の手番の終わり、ATB は味方の行動の終わり */
  private countScriptTurn(): void {
    if (this.state.script) this.state.script.turn++
  }

  /** 脚本の判定に使う、戦闘の状態の写し */
  private scriptView(): ScriptView {
    const st = this.state.script as ScriptState
    return {
      turn: st.turn,
      party: this.state.party.map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp })),
      enemies: this.state.enemies.map((e) => ({ id: e.id, hp: e.hp, maxHp: e.maxHp })),
      joined: st.joined,
    }
  }

  /**
   * 脚本のステップ: HP 下限を整え、いま発動するルールを 1 つずつ（宣言順に）適用し、もう発動するものが無くなったら下限をもう一度整える。
   * ルールは 1 回しか発動しないので、回数はルール数で止まる（安全弁としてルール数 + 余裕で打ち切る）。終了したら止める。再入しない。
   */
  private scriptStep(): void {
    const parsed = this.scriptParsed
    const st = this.state.script
    if (!parsed || !st || this.scriptRunning || this.isOver()) return
    this.scriptRunning = true
    try {
      for (let guard = 0; guard < parsed.rules.length + SCRIPT_STEP_SLACK; guard++) {
        this.applyScriptFloors()
        const action = nextScriptAction(parsed, st, this.scriptView())
        if (!action) break
        st.fired.push(action.index)
        this.performScriptAction(action)
        if (this.isOver()) return
      }
      this.applyScriptFloors()
    } finally {
      this.scriptRunning = false
    }
  }

  /** 条件が真の `下限` を、者の `hpFloor` に付け外しする（脚本のない戦闘は何も付かない） */
  private applyScriptFloors(): void {
    const parsed = this.scriptParsed
    if (!parsed) return
    const floors = computeFloors(parsed, this.scriptView())
    const set = (list: BattleEntity[], values: number[]): void => {
      list.forEach((e, i) => {
        if (values[i] > 0) e.hpFloor = values[i]
        else delete e.hpFloor
      })
    }
    set(this.state.party, floors.party)
    set(this.state.enemies, floors.enemies)
  }

  private performScriptAction(a: ScriptAction): void {
    switch (a.kind) {
      case 'line':
        this.emitScriptLine(a.speaker, a.text)
        return
      case 'join':
        this.scriptJoin(a.target, a.text)
        return
      case 'revive':
        this.scriptRevive(a)
        return
      case 'flee':
        this.scriptFlee(a.target, a.text)
        return
      case 'end':
        this.scriptEnd(a.result, a.text)
        return
    }
  }

  /** 読ませる 1 文（台詞・知らせ）を、戦闘ログと窓の演出（`line` の notice）の両方に出す。`hits` は HP が動くときだけ */
  private emitScriptLine(speaker: string | undefined, text: string, hits: BattleHit[] = []): void {
    const line = speaker ? `${speaker}「${text}」` : text
    this.appendLog(line)
    this.pushEvent({
      actor: { side: 'party', index: 0 },
      kind: 'notice',
      label: line,
      line: true,
      hits,
    })
  }

  /** 途中参戦: `joiners` の味方を末尾に加える。すでに味方にいれば何もしない。参戦できる味方がいなければ警告（1 度だけ） */
  private scriptJoin(id: string, text: string | undefined): void {
    if (this.state.party.some((p) => p.id === id)) return
    const src = hasOwn(this.joiners, id) ? this.joiners[id] : undefined
    if (!src) {
      if (!this.warnedJoiners.has(id)) {
        this.warnedJoiners.add(id)
        console.warn(`[name-name] 参戦できる味方 '${id}' が渡されていない（参戦: は無視した）`)
      }
      return
    }
    const member = JSON.parse(JSON.stringify(src)) as BattleEntity
    this.state.party.push(member)
    const st = this.state.script as ScriptState
    st.joined.push(member.id)
    const atb = this.state.atb
    if (atb) atb.partyGauge.push(0)
    this.emitScriptLine(undefined, text ?? `${member.name} が くわわった！`)
  }

  /** 復活: HP0 の味方 1 人を戦闘不能から戻す（全滅にしない）。HP は指定（既定は全回復）、MP も指定すれば、状態も付けられる */
  private scriptRevive(a: Extract<ScriptAction, { kind: 'revive' }>): void {
    const idx = this.state.party.findIndex((p) => p.id === a.target && p.hp <= 0)
    if (idx === -1) return
    const m = this.state.party[idx]
    const hpBefore = m.hp
    m.hp = resolveAmount(a.hp, m.maxHp, 1)
    if (a.mp) m.mp = resolveAmount(a.mp, m.maxMp, 0)
    if (a.status) {
      const ruleId = resolveRuleId(this.statusRules, a.status)
      if (ruleId === null) {
        // 宣言（[状態]）の無い id は付けない（生のキーを書き込まない）。警告は id ごとに 1 度だけ
        if (!this.warnedStatuses.has(a.status)) {
          this.warnedStatuses.add(a.status)
          console.warn(
            `[name-name] 復活の 付与= '${a.status}' は [状態] に宣言が無い（付与は無視した）`
          )
        }
      } else {
        if (!m.status) m.status = {}
        safeAssign(m.status, ruleId, this.statusRules[ruleId].duration)
        this.noteStatus(m, m, ruleId)
      }
    }
    const ref: BattleActorRef = { side: 'party', index: idx }
    this.emitScriptLine(undefined, a.text ?? `${m.name} は ふっかつした！`, [
      { target: ref, kind: 'heal', amount: m.hp - hpBefore, hpBefore, hpAfter: m.hp },
    ])
  }

  /** 脚本の `逃走` で戦闘から消えた敵か (#741) */
  private isFledEnemy(e: BattleEntity): boolean {
    const fled = this.state.script?.fled
    return !!fled && fled.some((i) => this.state.enemies[i] === e)
  }

  /** 逃走: 生きている敵のうち id が一致する先頭 1 体を、戦闘から消す（HP 0・経験値・ドロップなし。倒したことにはしない） */
  private scriptFlee(id: string, text: string | undefined): void {
    const idx = this.state.enemies.findIndex((e) => e.id === id && e.hp > 0)
    if (idx === -1) return
    const enemy = this.state.enemies[idx]
    enemy.hp = 0
    delete enemy.hpFloor
    const st = this.state.script as ScriptState
    st.fled.push(idx)
    // 倒れたのではないので、死亡時: は発動しない（resolveDeaths の対象から外す）
    const memory = this.state.enemyMemory
    if (memory) memory[idx].died = true
    const atb = this.state.atb
    if (atb) atb.enemyGauge[idx] = 0
    this.emitScriptLine(undefined, text ?? `${enemy.name} は にげだした！`)
  }

  /** 強制終了: 勝利（ふつうの勝利と同じ報酬）/ 敗北（全滅の扱い。ゲームオーバーにするかはホストが決める）/ 中断（報酬なし） */
  private scriptEnd(result: ScriptEndResult, text: string | undefined): void {
    if (text !== undefined) this.emitScriptLine(undefined, text)
    if (result === 'victory') {
      this.handleVictory()
    } else if (result === 'defeat') {
      this.state.phase = 'defeat'
      this.appendLog('ぜんめつ してしまった……')
    } else {
      this.state.phase = 'interrupted'
    }
  }

  // ===== 状態異常 (#870) =====

  /** 者の行動の乱れ。宣言が無い戦闘は常に null */
  private actorBlock(entity: BattleEntity): ReturnType<typeof blockingAction> {
    return this.hasStatusRules ? blockingAction(entity, this.statusRules) : null
  }

  /**
   * 手番が来た味方が行動不能・混乱なら、入力を受けずエンジンが解決する。解決した（入力は無効）なら true。
   * 通常はコマンド待ちに入った時点で `autoResolveParty` が済ませているので、ここへ来るのは解決しきれなかった（ガードに達した）ときだけ
   */
  private refuseIfBlocked(): boolean {
    if (!this.hasStatusRules) return false
    const actor = this.currentActor()
    if (!actor || !this.actorBlock(actor)) return false
    this.autoResolveParty()
    return true
  }

  /**
   * コマンド待ちの先頭の味方が行動不能・混乱の間、その手番を自動で解決し続ける (#870、FF6 の「コマンドが選べず」)。
   * 行動不能 = 手番を飛ばす / 混乱 = 自陣営の生存者（自分を含む）へ通常攻撃。解決のたびに状態は 1 手番進む（持続は有限なので必ず終わる）。
   * ガード（1000 手番）に達したら止める（無限ループ防止の安全弁。この場合は次の入力で再び解決を試みる）
   */
  private autoResolveParty(): void {
    if (!this.hasStatusRules || this.autoResolving) return
    this.autoResolving = true
    try {
      for (let guard = 0; guard < 1000; guard++) {
        if (this.isOver() || this.state.phase !== 'party-input') return
        const idx = this.currentActorIndex()
        if (idx === -1) return
        const actor = this.state.party[idx]
        const block = this.actorBlock(actor)
        if (!block) return
        if (block.action === 'stun') {
          this.appendLog(`${actor.name} は ${block.rule.name} で うごけない！`)
          this.recordNotice(actor, 'うごけない！')
        } else {
          this.confusedAttack(actor, this.randomAlive(this.state.party), block.rule)
        }
        this.advanceAfterPartyAction(undefined)
      }
    } finally {
      this.autoResolving = false
    }
  }

  /** 行動不能・混乱の敵の手番。行動不能は飛ばし、混乱は敵陣営の生存者（自分を含む）へ通常攻撃する */
  private runBlockedEnemy(
    enemy: BattleEntity,
    block: NonNullable<ReturnType<typeof blockingAction>>
  ): void {
    if (block.action === 'stun') {
      this.appendLog(`${enemy.name} は ${block.rule.name} で うごけない！`)
      this.recordNotice(enemy, 'うごけない！')
      return
    }
    this.confusedAttack(enemy, this.randomAlive(this.state.enemies), block.rule)
  }

  /** 生存者のうち 1 人を乱数で選ぶ（乱数は常に 1 回使う）。呼び出し側が生存者の存在を保証する */
  private randomAlive(list: BattleEntity[]): BattleEntity {
    const alive = list.filter((e) => e.hp > 0)
    return alive[Math.min(alive.length - 1, Math.floor(this.rng() * alive.length))]
  }

  /** 混乱した者の通常攻撃 1 回（狙いは呼び出し側が決める）。反撃・死亡時の行動は起こさない（敵の行動ではないため） */
  private confusedAttack(actor: BattleEntity, target: BattleEntity, rule: StatusRule): void {
    const hpBefore = target.hp
    const dmg = applyDamageToHp(target, this.computeAttackDamage(actor, target))
    this.recordAttack(actor, target, hpBefore, dmg)
    this.appendLog(`${actor.name} は ${rule.name} で あばれた！`)
    this.appendLog(`${target.name} に ${dmg} の ダメージ！`)
    if (target.hp === 0) this.appendLog(`${target.name} は たおれた！`)
  }

  /**
   * 味方の手番の終わりに状態を進める。ATB は行動した本人（`idx`）だけ、従来ターン制は味方全員
   * （従来ターン制は 1 手番に先頭の 1 人しか動かないので、手番の単位は「味方側の行動 1 回」）
   */
  private endPartyTurnStatuses(idx: number): void {
    if (!this.hasStatusRules) return
    if (this.state.atb) {
      const m = idx !== -1 ? this.state.party[idx] : undefined
      if (m) this.tickStatuses(m)
      return
    }
    // 従来ターン制: 味方側の行動 1 回が手番。この手番で付いた状態は全員とも飛ばす（反撃で付いた分も）
    for (const p of this.state.party) this.tickStatuses(p, false)
    this.freshStatuses = []
  }

  /**
   * 者の宣言済みの状態を 1 手番ぶん進める: 継続ダメージ → 持続 -1 → 0 なら解除（満了があればその効果）。
   * 今の手番の中で付いた状態（付与者は問わない）は、この手番の終わりには進めない。敵が味方に付けた混乱は、敵の手番の終わりに記録が消えるので味方の次の手番に効く。
   * 倒れている者は状態を失うだけ。宣言の無い状態（印だけ）は触らない
   */
  private tickStatuses(entity: BattleEntity, clearFresh = true): void {
    if (!this.hasStatusRules) return
    // この手番の中で付いた状態は進めない（1 度だけ。付与者は問わない）
    const fresh = new Set(this.freshStatuses.filter((f) => f.target === entity).map((f) => f.key))
    if (clearFresh) this.freshStatuses = []
    if (entity.hp <= 0) {
      this.clearDownedStatuses()
      return
    }
    const st = entity.status
    const ref = this.refOf(entity)
    if (!st || !ref) return
    for (const key of Object.keys(st)) {
      if (!hasOwn(this.statusRules, key) || fresh.has(key)) continue
      const rule = this.statusRules[key]
      const turns = st[key]
      if (typeof turns !== 'number' || !(turns > 0)) continue
      if (entity.hp <= 0) break
      if (rule.tick) this.applyStatusTick(entity, ref, rule)
      if (entity.hp <= 0) break
      if (turns - 1 > 0) {
        safeAssign(st, key, turns - 1)
        continue
      }
      delete st[key]
      this.expireStatus(entity, ref, rule)
      if (entity.hp <= 0) break
    }
    this.clearDownedStatuses()
  }

  /** 継続ダメージ 1 回。状態 id の属性相性が効く: 無効 = なし / 吸収 = 回復 / 半減 ×½ / 弱点 ×2（上限 9999 は共通） */
  private applyStatusTick(entity: BattleEntity, ref: BattleActorRef, rule: StatusRule): void {
    const tick = rule.tick
    if (!tick) return
    const base =
      tick.kind === 'fraction'
        ? Math.max(1, Math.floor((entity.maxHp * tick.num) / tick.den))
        : rollRange(tick.min, tick.max, this.rng)
    const kind = resolveAffinity(entity.affinity, rule.id)
    if (kind === 'nullify') return
    const hpBefore = entity.hp
    if (kind === 'absorb') {
      const healed = clampDamage(base)
      if (!(healed > 0)) return
      entity.hp = clampHp(entity.hp + healed, entity.maxHp)
      this.appendLog(`${entity.name} は ${rule.name} の力を ${healed} 吸収した！`)
      this.pushEvent({
        actor: ref,
        kind: 'status',
        label: rule.name,
        hits: [{ target: ref, kind: 'heal', amount: healed, hpBefore, hpAfter: entity.hp }],
      })
      return
    }
    const dealt = applyDamageToHp(entity, applyAffinityToDamage(kind, base))
    this.appendLog(`${entity.name} は ${rule.name} で ${dealt} のダメージ！`)
    if (entity.hp === 0) this.appendLog(`${entity.name} は たおれた！`)
    this.pushEvent({
      actor: ref,
      kind: 'status',
      label: rule.name,
      hits: [{ target: ref, kind: 'damage', amount: dealt, hpBefore, hpAfter: entity.hp }],
    })
  }

  /**
   * 持続が尽きた状態の後始末。`満了: 戦闘不能` は即死扱いで、即死耐性 (#872) の `death` が無効・吸収の者は助かる（解けるだけ）。
   * 数字は出さない（即死と同じ `instantDeath`）
   */
  private expireStatus(entity: BattleEntity, ref: BattleActorRef, rule: StatusRule): void {
    if (rule.expireDeath) {
      const death = resolveAffinity(entity.affinity, DEATH_ATTRIBUTE)
      if (death !== 'nullify' && death !== 'absorb') {
        const hpBefore = entity.hp
        if (!knockOutHp(entity)) {
          // HP の下限 (#741) で倒れなかった。数字つきのダメージとして知らせる（下限が無ければここへは来ない）
          this.appendLog(`${entity.name} の ${rule.name} の カウントが つきた……`)
          this.appendLog(`${entity.name} は もちこたえた！`)
          this.pushEvent({
            actor: ref,
            kind: 'status',
            label: rule.name,
            hits: [
              {
                target: ref,
                kind: 'damage',
                amount: hpBefore - entity.hp,
                hpBefore,
                hpAfter: entity.hp,
              },
            ],
          })
          return
        }
        this.appendLog(`${entity.name} の ${rule.name} の カウントが つきた……`)
        this.appendLog(`${entity.name} は たおれた！`)
        this.pushEvent({
          actor: ref,
          kind: 'status',
          label: rule.name,
          hits: [
            {
              target: ref,
              kind: 'damage',
              amount: hpBefore,
              hpBefore,
              hpAfter: 0,
              instantDeath: true,
            },
          ],
        })
        return
      }
    }
    this.appendLog(`${entity.name} の ${rule.name} が とけた！`)
  }

  /** HP が減って生き残った者の、被ダメージで解ける状態を解く */
  private breakOnDamage(entity: BattleEntity, hpBefore: number): void {
    if (!this.hasStatusRules || entity.hp <= 0 || entity.hp >= hpBefore) return
    const st = entity.status
    if (!st) return
    for (const rule of activeStatusRules(entity, this.statusRules)) {
      if (!rule.cureOnDamage) continue
      delete st[rule.id]
      this.appendLog(`${entity.name} の ${rule.name} が なおった！`)
    }
  }

  /**
   * 効果が状態を付けた・解いた通知。宣言した状態の付与は「今の手番で付いた」として記録し（その手番の終わりには減らさない）、
   * 付与・解除とも、その対象は MISS にしない（HP が変わらなくても、効いた）。宣言の無い印は従来どおり
   */
  private noteStatus(
    applier: BattleEntity,
    target: BattleEntity,
    key: string,
    change: 'apply' | 'cure' = 'apply'
  ): void {
    if (!this.hasStatusRules) return
    if (change === 'cure') {
      this.statusTouched.add(target)
      return
    }
    if (!hasOwn(this.statusRules, key)) return
    this.freshStatuses.push({ applier, target, key })
    this.statusTouched.add(target)
  }

  /** 倒れた者の宣言済みの状態を消す（蘇生しても残らない）。宣言の無い印は触らない */
  private clearDownedStatuses(): void {
    if (!this.hasStatusRules) return
    // 倒れた者に付けた「付けたばかり」の記録も捨てる（溜まり続けない。付与者が倒れても、付いた状態の記録は残す）
    if (this.freshStatuses.length > 0) {
      this.freshStatuses = this.freshStatuses.filter((f) => f.target.hp > 0)
    }
    for (const e of [...this.state.party, ...this.state.enemies]) {
      const st = e.status
      if (e.hp > 0 || !st) continue
      for (const k of Object.keys(st)) if (hasOwn(this.statusRules, k)) delete st[k]
    }
  }

  private computeAttackDamage(attacker: BattleEntity, defender: BattleEntity): number {
    return computeRowAttackDamage(attacker, defender, this.rng)
  }
}

/**
 * 通常攻撃のダメージ計算。DQ 式:
 *   base = max(1, atk - floor(def/2))
 *   variance = floor(atk/4)
 *   damage = base + floor(rng * (variance + 1))
 *
 * テスト容易性のため export。
 */
export function computeAttackDamage(
  attacker: BattleEntity,
  defender: BattleEntity,
  rng: () => number
): number {
  const base = Math.max(1, attacker.atk - Math.floor(defender.def / 2))
  const variance = Math.floor(attacker.atk / 4)
  const r = Math.floor(rng() * (variance + 1))
  return base + r
}

/**
 * 隊列 (#747) によるダメージ補正（FF4〜6 準拠）。通常攻撃（近接物理）にだけ使う。
 * 後衛（`row: 'back'`）が攻撃側なら与えるダメージが半分、防御側なら受けるダメージが半分（両方なら 2 回半分）。
 * 丸めは「半分ごとに切り捨て・最低 1」（`computeAttackDamage` の最低 1 に揃える）。
 * 前衛・未指定はそのまま。呪文・アイテムの効果（DSL / builtin）はこの関数を通らず、隊列の影響を受けない。
 */
export function applyRowToPhysicalDamage(
  damage: number,
  attackerRow: BattleRow | undefined,
  defenderRow: BattleRow | undefined
): number {
  let d = damage
  if (attackerRow === 'back') d = Math.max(1, Math.floor(d / 2))
  if (defenderRow === 'back') d = Math.max(1, Math.floor(d / 2))
  return d
}

/** 通常攻撃のダメージ（`computeAttackDamage` + 隊列補正 (#747)）。乱数の消費は `computeAttackDamage` と同じ 1 回 */
export function computeRowAttackDamage(
  attacker: BattleEntity,
  defender: BattleEntity,
  rng: () => number
): number {
  return applyRowToPhysicalDamage(
    computeAttackDamage(attacker, defender, rng),
    attacker.row,
    defender.row
  )
}

/** 効果が通知した計算上の量 (#745)。`kill` は即死で倒した印（#877。量は持たない） */
interface ComputedAmount {
  kind: 'damage' | 'heal'
  amount: number
  kill?: boolean
  /** 状態による回復・ダメージの反転 (#870) */
  reversed?: boolean
}

/** 効果 DSL の複数ヒット (#879) が 1 ヒットごとに通知した結果。`recordEffect` が `BattleHit` 列にする */
interface MultiHit {
  target: BattleEntity
  kind: BattleHitKind
  amount: number
  round: number
  /** 通知した時点（そのヒットを反映した直後）の対象の HP */
  hpAfter: number
  /** 状態による回復・ダメージの反転 (#870) */
  reversed?: boolean
}

/** 味方の行動 1 回が敵に与えた被弾の情報 (#837)。`before` は行動の前の全員の HP */
interface PartyReaction {
  attacker: BattleActorRef
  source: HitSource
  before: Map<BattleEntity, number>
  /** 敵 index ごとの、この行動が与えたダメージの数字の合計 (#871) */
  damage: Map<number, number>
}

/** 呪文の効果 DSL が `damage ... type=` を持つときその系統（`受けた=系統:x` の判定用）。builtin・DSL でなければ undefined */
function spellDamageType(spell: { builtin?: string; effect?: string }): string | undefined {
  if (spell.builtin || !spell.effect) return undefined
  const parsed = parseEffect(spell.effect)
  return parsed && parsed.kind === 'damage' ? parsed.type : undefined
}

/** 呪文発動の引数。マスターからの解決は呼び出し側で行う */
export interface SpellExecution {
  name: string
  mp: number
  target: string // "味方単体" / "敵全体" 等
  effect?: string
  builtin?: string
}

/**
 * 特技 (#834) の引数。マスター（`[特技 id]`）からの解決は呼び出し側で行う。呪文と違って MP は持たない。
 * `target` は使う側から見た相対表現（`相手単体` / `相手全体` / `自分` / `仲間単体` / `仲間全体`）
 */
export interface SkillExecution {
  name: string
  target: string
  effect?: string
  builtin?: string
  /** 使用時の演出文。`{user}` は使った側の名前に置き換わる */
  message?: string
  /** 予兆の文言（P2 #836）。使用時に `message` のあとへ出す。`{user}` は使った側の名前に置き換わる */
  telegraph?: string
  /** 召喚獣の演出 (#750)。あれば行動の記録（`BattleActionEvent.summon`）に載る。魔石 (#889) の召喚と、味方の「わざ」（`召喚獣id` を持つ特技）が付ける。敵が使う特技の `cue` は無視される */
  cue?: SummonCue
}

/**
 * 召喚 (#889) の引数。魔石（`[魔石]`）から `magicite.ts` の `toSummonExecution` で作る。特技と同じ書式の効果に、消費 MP（既定 0）を足したもの。
 * `name` は召喚獣の表示名、`message` は召喚時の演出文（`{user}` は呼んだ側の名前）
 */
export interface SummonExecution extends SkillExecution {
  /** 消費 MP（0 以上） */
  mp: number
}

/** アイテム使用の引数 */
export interface ItemExecution {
  name: string
  effect?: string
  builtin?: string
}
