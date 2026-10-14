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
 * 敵の特技 (#834): `performSkill` は「ある者が特技を 1 回使う」内部 API。敵の行動選択（#835 以降）が呼ぶ。
 * この API 自体はターン・ATB ゲージ・勝敗判定を進めない（呼び出し側が行う）。
 *
 * 将来拡張:
 * - 呪文 / アイテム / さくせん（#174 / #175）
 * - 敵 AI（builtin: で挙動委譲）
 * - ターン跨ぎ状態異常の減衰
 */

import type { BattleEntity, BattleRow, EffectContext } from './spellDsl'
import { applyEffect, parseEffect } from './spellDsl'
import { invokeBuiltinSpell, invokeBuiltinItem } from './builtin'

export type BattlePhase =
  | 'party-input' // 味方の入力待ち（ATB では「ゲージが溜まった味方がコマンドを待っている」）
  | 'atb-running' // ATB: 誰もコマンド待ちでなく、ゲージが溜まっていく最中 (#205)
  | 'enemy-turn' // 敵の行動中（同期処理だが UI のアニメ用に分離）
  | 'victory'
  | 'defeat'
  | 'escaped'

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
}

/**
 * 行動 1 回の記録 (#745)。エンジンは同期処理で状態をすぐ確定させるので、画面の演出（FF 式）が
 * 「いま誰が誰に何をしたか」を後から再生できるよう、事実だけを残す。画面は `eventTotal` の差で新規分を数える（ログと同じ流儀）。
 */
export interface BattleActionEvent {
  /** 戦闘開始からの通し番号（0 始まり） */
  seq: number
  actor: BattleActorRef
  kind: 'attack' | 'spell' | 'item' | 'skill' | 'notice'
  /**
   * FF 式メッセージ窓に出す短い言葉。呪文・アイテム・特技 (#834) の名前、または `notice`（行動が成立しなかったことの知らせ。
   * 「にげられない！」「MPが たりない！」）の文言。通常攻撃は undefined
   */
  label?: string
  /** 特技 (#834) の使用時メッセージ（`{user}` を使った側の名前に置き換えた後の文）。`メッセージ:` を書かない特技・他の kind は undefined */
  message?: string
  hits: BattleHit[]
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
}

const LOG_MAX = 30
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
}

export class BattleEngine {
  private state: BattleState
  private rng: () => number
  /** wait / menu のとき、表示側が候補窓を開いている間 true（画面の一時的な状態なので BattleState には持たない） */
  private atbHold = false
  private atbWaitScope: AtbWaitScope = 'command'

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
    if (opts.atb) {
      this.initAtb(opts.atb)
      this.atbWaitScope = opts.atb.waitScope === 'menu' ? 'menu' : 'command'
    }
    const enemyNames = enemies.map((e) => e.name).join(' と ')
    this.appendLog(`${enemyNames} が あらわれた！`)
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
      this.state.phase === 'escaped'
    )
  }

  /** 「たたかう」: 指定敵に通常攻撃。ターゲット未指定なら最初に生きてる敵 */
  selectAttack(targetId?: string): void {
    if (this.state.phase !== 'party-input') return
    const hero = this.currentActor()
    if (!hero) return
    const target = targetId
      ? this.state.enemies.find((e) => e.id === targetId && e.hp > 0)
      : this.firstAlive(this.state.enemies)
    if (!target) return

    const dmg = this.computeAttackDamage(hero, target)
    const hpBefore = target.hp
    target.hp = Math.max(0, target.hp - dmg)
    this.recordAttack(hero, target, hpBefore, dmg)
    this.appendLog(`${hero.name} の こうげき！`)
    this.appendLog(`${target.name} に ${dmg} の ダメージ！`)
    if (target.hp === 0) {
      this.appendLog(`${target.name} を たおした！`)
    }

    this.advanceAfterPartyAction()
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
      if (idx !== -1) this.finishAtbAction(idx)
      this.settleAtbPhase()
    } else {
      this.recordNotice(this.currentActor() ?? undefined, 'にげられない！')
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
          if (m && m.hp > 0 && !atb.queue.includes(who.index)) atb.queue.push(who.index)
        } else {
          this.runAtbEnemyAction(atb, who.index)
        }
      }
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
    const amounts = new Map<BattleEntity, { kind: 'damage' | 'heal'; amount: number }>()
    const ctx: EffectContext = {
      caster,
      targets,
      rng: this.rng,
      onAmount: (t, kind, amount) => amounts.set(t, { kind, amount }),
    }
    const hpSnapshot = this.snapshotHp()
    const lines = spell.builtin
      ? invokeBuiltinSpell(spell.builtin, ctx)
      : spell.effect
        ? this.evalEffectDsl(spell.effect, ctx)
        : ['(呪文に効果定義なし)']
    for (const line of lines) this.appendLog(line)
    this.recordEffect('spell', caster, spell.name, targets, hpSnapshot, amounts)

    this.advanceAfterPartyAction()
  }

  /** 「どうぐ」: アイテムを使用 */
  selectItem(item: ItemExecution, targetId?: string): void {
    if (this.state.phase !== 'party-input') return
    const user = this.currentActor()
    if (!user) return
    this.appendLog(`${user.name} は ${item.name} を つかった！`)

    const targets = this.resolveItemTargets(item, targetId)
    const amounts = new Map<BattleEntity, { kind: 'damage' | 'heal'; amount: number }>()
    const ctx: EffectContext = {
      caster: user,
      targets,
      rng: this.rng,
      onAmount: (t, kind, amount) => amounts.set(t, { kind, amount }),
    }
    const hpSnapshot = this.snapshotHp()
    const lines = item.builtin
      ? invokeBuiltinItem(item.builtin, ctx)
      : item.effect
        ? this.evalEffectDsl(item.effect, ctx)
        : ['(アイテムに効果定義なし)']
    for (const line of lines) this.appendLog(line)
    this.recordEffect('item', user, item.name, targets, hpSnapshot, amounts)

    this.advanceAfterPartyAction()
  }

  /**
   * 特技 (#834) を 1 回使う（内部 API。敵の行動選択 #835 が呼ぶ。この PR 単体では敵は呼ばない）。
   *
   * - `user` は `party` / `enemies` の index。倒れている・存在しない者は何もせず false を返す
   * - 対象は**使う側から見た相対表現**: `相手単体` / `相手全体` / `自分` / `仲間単体` / `仲間全体`
   *   （敵が使えば「相手」は味方側）。未知の値・省略は `相手単体`。
   *   単体の `target` は明示指定（側が合わなければ無視）。省略時は相手単体・仲間単体とも最初の生存者
   * - 効果は呪文と同じ評価器を内部で共有（`builtin` があればそれ、無ければ `effect` の DSL）。MP は持たず消費しない
   * - ログに `message`（`{user}` を使った側の名前に置換）か「〇〇は △△ を つかった！」、演出イベントに `kind: 'skill'` を残す
   * - フェーズ・ATB ゲージ・勝敗判定は触らない（敵ターンの途中で呼ばれても二重に終了処理しないため、呼び出し側が checkEnd 相当を行う）
   * - 乱数は効果の評価でだけ消費する（対象の解決は rng を使わない）
   */
  performSkill(user: BattleActorRef, skill: SkillExecution, target?: BattleActorRef): boolean {
    const userList = user.side === 'party' ? this.state.party : this.state.enemies
    const caster = userList[user.index]
    if (!caster || caster.hp <= 0) return false
    const targets = this.resolveSkillTargets(user.side, caster, skill, target)
    const message =
      typeof skill.message === 'string' && skill.message.trim() !== ''
        ? skill.message.split('{user}').join(caster.name)
        : undefined
    this.appendLog(message ?? `${caster.name} は ${skill.name} を つかった！`)

    const amounts = new Map<BattleEntity, { kind: 'damage' | 'heal'; amount: number }>()
    const ctx: EffectContext = {
      caster,
      targets,
      rng: this.rng,
      onAmount: (t, kind, amount) => amounts.set(t, { kind, amount }),
    }
    const hpSnapshot = this.snapshotHp()
    const lines = skill.builtin
      ? invokeBuiltinSpell(skill.builtin, ctx)
      : skill.effect
        ? this.evalEffectDsl(skill.effect, ctx)
        : ['(特技に効果定義なし)']
    for (const line of lines) this.appendLog(line)
    this.recordEffect('skill', caster, skill.name, targets, hpSnapshot, amounts, message)
    return true
  }

  // ===== 内部 =====

  private evalEffectDsl(effectStr: string, ctx: EffectContext): string[] {
    const parsed = parseEffect(effectStr)
    if (!parsed) return [`(効果 DSL が解釈できない: '${effectStr}')`]
    return applyEffect(parsed, ctx)
  }

  private advanceAfterPartyAction(): void {
    const atb = this.state.atb
    if (atb) {
      // ATB: 行動した人のゲージを 0 に戻し、キューの次へ（敵は自分のゲージで動くので敵ターンは挟まない）
      const idx = this.currentActorIndex()
      if (idx !== -1) this.finishAtbAction(idx)
      if (this.state.enemies.every((e) => e.hp === 0)) {
        this.handleVictory()
        return
      }
      this.settleAtbPhase()
      return
    }
    if (this.state.enemies.every((e) => e.hp === 0)) {
      this.handleVictory()
      return
    }
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
  }

  /** 全滅 / 殲滅していれば終了フェーズへ。終了したら true */
  private checkEnd(): boolean {
    if (this.isOver()) return true
    if (this.state.enemies.every((e) => e.hp === 0)) {
      this.handleVictory()
      return true
    }
    if (this.state.party.every((p) => p.hp === 0)) {
      this.state.phase = 'defeat'
      this.appendLog('ぜんめつ してしまった……')
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
    const target = alive[Math.min(alive.length - 1, Math.floor(this.rng() * alive.length))]
    const dmg = this.computeAttackDamage(enemy, target)
    const hpBefore = target.hp
    target.hp = Math.max(0, target.hp - dmg)
    this.recordAttack(enemy, target, hpBefore, dmg)
    this.appendLog(`${enemy.name} の こうげき！`)
    this.appendLog(`${target.name} は ${dmg} の ダメージを うけた！`)
    if (target.hp === 0) {
      this.appendLog(`${target.name} は たおれた！`)
      const idx = this.state.party.indexOf(target)
      atb.queue = atb.queue.filter((i) => i !== idx)
      atb.partyGauge[idx] = 0
    }
    this.checkEnd()
  }

  private handleVictory(): void {
    this.state.phase = 'victory'
    let exp = 0
    let gold = 0
    for (const e of this.state.enemies) {
      exp += e.exp ?? 0
      gold += e.gold ?? 0
    }
    this.state.earnedExp = exp
    this.state.earnedGold = gold
    this.appendLog(`けいけんち ${exp} を てに いれた！`)
    this.appendLog(`${gold} ゴールドを てに いれた！`)
  }

  private runEnemyTurn(): void {
    this.state.phase = 'enemy-turn'
    for (const enemy of this.state.enemies) {
      if (enemy.hp === 0) continue
      const hero = this.firstAlive(this.state.party)
      if (!hero) break
      const dmg = this.computeAttackDamage(enemy, hero)
      const hpBefore = hero.hp
      hero.hp = Math.max(0, hero.hp - dmg)
      this.recordAttack(enemy, hero, hpBefore, dmg)
      this.appendLog(`${enemy.name} の こうげき！`)
      this.appendLog(`${hero.name} は ${dmg} の ダメージを うけた！`)
      if (hero.hp === 0) {
        this.appendLog(`${hero.name} は たおれた！`)
      }
    }
    if (this.state.party.every((p) => p.hp === 0)) {
      this.state.phase = 'defeat'
      this.appendLog('ぜんめつ してしまった……')
      return
    }
    this.state.phase = 'party-input'
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
   * 明示指定 `target` は単体のときだけ効き、相手単体は生存者・仲間単体は同じ側の者（倒れていても可＝蘇生の効果用）に限る。
   */
  private resolveSkillTargets(
    side: 'party' | 'enemy',
    user: BattleEntity,
    skill: SkillExecution,
    target?: BattleActorRef
  ): BattleEntity[] {
    const allies = side === 'party' ? this.state.party : this.state.enemies
    const opponents = side === 'party' ? this.state.enemies : this.state.party
    const explicit = (list: BattleEntity[], side0: 'party' | 'enemy'): BattleEntity | undefined =>
      target && target.side === side0 ? list[target.index] : undefined
    switch (typeof skill.target === 'string' ? skill.target.trim() : skill.target) {
      case '相手全体':
        return opponents.filter((e) => e.hp > 0)
      case '自分':
        return [user]
      case '仲間全体':
        return allies.filter((e) => e.hp > 0)
      case '仲間単体': {
        const t = explicit(allies, side) ?? this.firstAlive(allies)
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
    damage: number
  ): void {
    const actorRef = this.refOf(actor)
    const targetRef = this.refOf(target)
    if (!actorRef || !targetRef) return
    this.pushEvent({
      actor: actorRef,
      kind: 'attack',
      hits: [
        {
          target: targetRef,
          kind: 'damage',
          amount: damage,
          hpBefore,
          hpAfter: target.hp,
        },
      ],
    })
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
    amounts: Map<BattleEntity, { kind: 'damage' | 'heal'; amount: number }>,
    message?: string
  ): void {
    const actorRef = this.refOf(actor)
    if (!actorRef) return
    const hits: BattleHit[] = []
    for (const e of [...this.state.party, ...this.state.enemies]) {
      const hpBefore = before.get(e) ?? e.hp
      const ref = this.refOf(e)
      if (!ref) continue
      // 計算上の量（オーバーキル・回復の上限切りを含む）が通知されていればそれを数字にする。無ければ HP の前後差
      const computed = amounts.get(e)
      if (computed && e.hp !== hpBefore) {
        const k = e.hp < hpBefore ? 'damage' : 'heal'
        hits.push({
          target: ref,
          kind: k,
          amount: computed.kind === k ? computed.amount : Math.abs(e.hp - hpBefore),
          hpBefore,
          hpAfter: e.hp,
        })
      } else if (computed?.kind === 'heal' && computed.amount > 0 && targets.includes(e)) {
        // HP が変わらなかったが量はある（満タンへの回復）。数字は計算上の量
        hits.push({
          target: ref,
          kind: 'heal',
          amount: computed.amount,
          hpBefore,
          hpAfter: e.hp,
        })
      } else if (computed?.kind === 'damage' && computed.amount === 0 && hpBefore > 0) {
        // 計算上のダメージが 0（防御が上回るなど）は MISS でなく「0」。MISS は回避・無効（耐性 0）のときだけ
        hits.push({ target: ref, kind: 'damage', amount: 0, hpBefore, hpAfter: e.hp })
      } else if (e.hp < hpBefore) {
        hits.push({ target: ref, kind: 'damage', amount: hpBefore - e.hp, hpBefore, hpAfter: e.hp })
      } else if (e.hp > hpBefore) {
        hits.push({ target: ref, kind: 'heal', amount: e.hp - hpBefore, hpBefore, hpAfter: e.hp })
      } else if (targets.includes(e)) {
        hits.push({ target: ref, kind: 'miss', amount: 0, hpBefore, hpAfter: e.hp })
      }
    }
    this.pushEvent({
      actor: actorRef,
      kind,
      label,
      ...(message !== undefined ? { message } : {}),
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
    this.state.events.push({ seq: this.state.eventTotal, ...e })
    this.state.eventTotal++
    if (this.state.events.length > EVENT_MAX) this.state.events.shift()
  }

  private appendLog(line: string): void {
    this.state.log.push(line)
    this.state.logTotal++
    if (this.state.log.length > LOG_MAX) this.state.log.shift()
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
}

/** アイテム使用の引数 */
export interface ItemExecution {
  name: string
  effect?: string
  builtin?: string
}
