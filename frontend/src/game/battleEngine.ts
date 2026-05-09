/**
 * RPG 戦闘エンジン (#173)。
 *
 * UI から独立した純粋な状態機械。コマンド入力（attack / escape / spell / item）を
 * 受けて state を進め、戦闘ログを蓄積する。UI（BattleScreen）はこの state を観測して
 * 描画するだけ。
 *
 * Phase 1 スコープ:
 * - 味方 1 体（ゆうしゃ）vs 敵 1〜複数のターン制
 * - コマンド: たたかう（attack） / にげる（escape）。じゅもん / どうぐは雛形のみ
 * - ダメージ式: DQ 式（atk - def/2 + rand(0..atk/4)）、最低 1
 * - 行動順は今は「味方→敵全員」固定。AGI ソートは Phase 2
 *
 * 将来拡張:
 * - 呪文 / アイテム / さくせん（#174 / #175）
 * - 敵 AI（builtin: で挙動委譲）
 * - 行動順 AGI ソート
 * - ターン跨ぎ状態異常の減衰
 */

import type { BattleEntity, EffectContext } from './spellDsl'
import { applyEffect, parseEffect } from './spellDsl'
import { invokeBuiltinSpell, invokeBuiltinItem } from './builtin'

export type BattlePhase =
  | 'party-input' // 味方の入力待ち
  | 'enemy-turn' // 敵の行動中（同期処理だが UI のアニメ用に分離）
  | 'victory'
  | 'defeat'
  | 'escaped'

export interface BattleState {
  party: BattleEntity[]
  enemies: BattleEntity[]
  phase: BattlePhase
  /** 戦闘ログ（直近 30 行を保持） */
  log: string[]
  /** 入手経験値（victory 到達時のみ集計） */
  earnedExp: number
  /** 入手ゴールド（victory 到達時のみ集計） */
  earnedGold: number
}

const LOG_MAX = 30

export interface BattleEngineOptions {
  /** 0..1 の一様乱数を返す関数。テストで決定論的に差し替え可能 */
  rng?: () => number
}

export class BattleEngine {
  private state: BattleState
  private rng: () => number

  constructor(party: BattleEntity[], enemies: BattleEntity[], opts: BattleEngineOptions = {}) {
    this.state = {
      party,
      enemies,
      phase: 'party-input',
      log: [],
      earnedExp: 0,
      earnedGold: 0,
    }
    this.rng = opts.rng ?? Math.random
    const enemyNames = enemies.map((e) => e.name).join(' と ')
    this.appendLog(`${enemyNames} が あらわれた！`)
  }

  getState(): Readonly<BattleState> {
    return this.state
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
    const hero = this.firstAlive(this.state.party)
    if (!hero) return
    const target = targetId
      ? this.state.enemies.find((e) => e.id === targetId && e.hp > 0)
      : this.firstAlive(this.state.enemies)
    if (!target) return

    const dmg = this.computeAttackDamage(hero, target)
    target.hp = Math.max(0, target.hp - dmg)
    this.appendLog(`${hero.name} の こうげき！`)
    this.appendLog(`${target.name} に ${dmg} の ダメージ！`)
    if (target.hp === 0) {
      this.appendLog(`${target.name} を たおした！`)
    }

    this.advanceAfterPartyAction()
  }

  /** 「にげる」: 50% で離脱、失敗で敵ターン */
  selectEscape(): void {
    if (this.state.phase !== 'party-input') return
    if (this.rng() < 0.5) {
      this.appendLog('にげだした！')
      this.state.phase = 'escaped'
    } else {
      this.appendLog('しかし まわりこまれてしまった！')
      this.runEnemyTurn()
    }
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
    const caster = this.firstAlive(this.state.party)
    if (!caster) return
    if (caster.mp < spell.mp) {
      this.appendLog('MP が たりない！')
      return
    }
    caster.mp -= spell.mp
    this.appendLog(`${caster.name} は ${spell.name} を となえた！`)

    const targets = this.resolveSpellTargets(spell, targetId)
    const ctx: EffectContext = { caster, targets, rng: this.rng }
    const lines = spell.builtin
      ? invokeBuiltinSpell(spell.builtin, ctx)
      : spell.effect
        ? this.evalEffectDsl(spell.effect, ctx)
        : ['(呪文に効果定義なし)']
    for (const line of lines) this.appendLog(line)

    this.advanceAfterPartyAction()
  }

  /** 「どうぐ」: アイテムを使用 */
  selectItem(item: ItemExecution, targetId?: string): void {
    if (this.state.phase !== 'party-input') return
    const user = this.firstAlive(this.state.party)
    if (!user) return
    this.appendLog(`${user.name} は ${item.name} を つかった！`)

    const targets = this.resolveItemTargets(item, targetId)
    const ctx: EffectContext = { caster: user, targets, rng: this.rng }
    const lines = item.builtin
      ? invokeBuiltinItem(item.builtin, ctx)
      : item.effect
        ? this.evalEffectDsl(item.effect, ctx)
        : ['(アイテムに効果定義なし)']
    for (const line of lines) this.appendLog(line)

    this.advanceAfterPartyAction()
  }

  // ===== 内部 =====

  private evalEffectDsl(effectStr: string, ctx: EffectContext): string[] {
    const parsed = parseEffect(effectStr)
    if (!parsed) return [`(効果 DSL が解釈できない: '${effectStr}')`]
    return applyEffect(parsed, ctx)
  }

  private advanceAfterPartyAction(): void {
    if (this.state.enemies.every((e) => e.hp === 0)) {
      this.handleVictory()
      return
    }
    this.runEnemyTurn()
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
      hero.hp = Math.max(0, hero.hp - dmg)
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
    switch (spell.target) {
      case '味方単体':
        return targetId
          ? this.state.party.filter((p) => p.id === targetId)
          : [this.state.party[0]].filter(Boolean)
      case '味方全体':
        return this.state.party.filter((p) => p.hp > 0)
      case '敵全体':
        return this.state.enemies.filter((e) => e.hp > 0)
      case '自分':
        return [this.firstAlive(this.state.party)].filter((x): x is BattleEntity => x !== null)
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

  private resolveItemTargets(item: ItemExecution, targetId?: string): BattleEntity[] {
    // アイテムは「味方単体」既定で、明示的 target が無ければパーティ最初の生存者
    void item
    if (targetId) {
      const t = this.state.party.find((p) => p.id === targetId)
      return t ? [t] : []
    }
    const hero = this.firstAlive(this.state.party)
    return hero ? [hero] : []
  }

  private firstAlive(list: BattleEntity[]): BattleEntity | null {
    return list.find((e) => e.hp > 0) ?? null
  }

  private appendLog(line: string): void {
    this.state.log.push(line)
    if (this.state.log.length > LOG_MAX) this.state.log.shift()
  }

  private computeAttackDamage(attacker: BattleEntity, defender: BattleEntity): number {
    return computeAttackDamage(attacker, defender, this.rng)
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

/** 呪文発動の引数。マスターからの解決は呼び出し側で行う */
export interface SpellExecution {
  name: string
  mp: number
  target: string // "味方単体" / "敵全体" 等
  effect?: string
  builtin?: string
}

/** アイテム使用の引数 */
export interface ItemExecution {
  name: string
  effect?: string
  builtin?: string
}
