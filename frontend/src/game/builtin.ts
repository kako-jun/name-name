/**
 * 専用関数（builtin）レジストリ (#174 / #173 / #176)。
 *
 * 設計合意（kako-jun と 2026-05-09 セッション、#176）:
 * - 単純な効果は `spellDsl` の宣言的 DSL で完結する（heal / damage / buff 等）
 * - DSL で表現できない複雑な振る舞い（成功率がレベル差で決まる、マップ状態を読む、
 *   ターン跨ぎ状態を持つ etc.）は **専用関数 = builtin** に逃がす
 * - 専用関数は **引数なし** で全責任を持つ（DSL の汎用関数は引数あり、対比的）
 *
 * 例:
 *   ザラキ → builtin: zaraki   (成功率はレベル差ベース、耐性持ちは無効)
 *   ルーラ → builtin: ruula    (マップ状態を読み訪問済み町を返す)
 *   ザオリク → builtin: zaorik (蘇生 + HP 全回復、状態異常解除)
 *   ラリホー → builtin: rariho (グループ全体に sleep、ターン跨ぎ管理)
 *
 *   せかいじゅのしずく → builtin: world_tree_drop
 *   キメラのつばさ → builtin: wing_of_chimera
 *
 * 未実装の builtin ID は runtime で warning を出して no-op する（md 先行・
 * 段階開発しやすい設計）。本ファイルは Phase 1（戦闘プロト #173）の最小セット
 * のみ登録する。後続で #173 戦闘実装が進むに従って追加していく。
 */

import type { BattleEntity, EffectContext } from './spellDsl'
import { hasOwn } from './ownProperty'

/**
 * builtin 関数のシグネチャ。
 *
 * - 戻り値: 戦闘ログ用の人間可読な行。エンジン側で表示する
 * - 副作用: ctx.targets / ctx.caster の HP/MP/status/buffs を直接書き換えてよい
 * - rng: ctx.rng を使うこと（テストで決定論的に差し替え可能）
 */
export type BuiltinSpellFn = (ctx: EffectContext) => string[]
export type BuiltinItemFn = (ctx: EffectContext) => string[]

/** 呪文の専用関数レジストリ。spell.builtin の値で lookup する */
export const BUILTIN_SPELLS: Record<string, BuiltinSpellFn> = {
  /**
   * ザラキ: 敵全体に確率で即死。耐性持ちは無効、成功率は固定 0.5（プロト用、
   * 将来レベル差ベースに差し替え予定）。
   */
  zaraki: (ctx) => {
    const log: string[] = []
    for (const t of ctx.targets) {
      if (t.resist?.['death'] === 0) {
        log.push(`${t.name} には きかなかった！`)
        continue
      }
      if (ctx.rng() < 0.5) {
        t.hp = 0
        log.push(`${t.name} は しんでしまった！`)
      } else {
        log.push(`${t.name} には きかなかった。`)
      }
    }
    return log
  },

  /**
   * ルーラ: 訪問済み町ワープ。実装は #173 戦闘外（フィールドマップ）でやる前提だが、
   * 戦闘中に詠唱しても呼ばれない（target=マップ で対象選択をスキップ）想定なので
   * ここは戦闘内で誤呼びされたときの no-op 安全網として置く。
   */
  ruula: () => ['ここでは つかえない！'],

  /**
   * ザオリク: 死んでいる味方を 1 体蘇生し HP 全快、状態異常解除。
   */
  zaorik: (ctx) => {
    const log: string[] = []
    for (const t of ctx.targets) {
      if (t.hp > 0) continue
      t.hp = t.maxHp
      t.status = {}
      log.push(`${t.name} は 生き返った！`)
      return log // 1 体だけ
    }
    log.push('しかし 何も おこらなかった。')
    return log
  },
}

/** アイテムの専用関数レジストリ */
export const BUILTIN_ITEMS: Record<string, BuiltinItemFn> = {
  /**
   * せかいじゅのしずく: 味方全体を完全回復 + 全員蘇生。
   */
  world_tree_drop: (ctx) => {
    const log: string[] = []
    for (const t of ctx.targets) {
      const wasDead = t.hp === 0
      t.hp = t.maxHp
      if (wasDead) log.push(`${t.name} は 生き返った！`)
      else log.push(`${t.name} の HP が 全回復した！`)
    }
    return log
  },

  /**
   * キメラのつばさ: マップ脱出（戦闘外用、戦闘中は no-op）。
   */
  wing_of_chimera: () => ['ここでは つかえない！'],
}

/**
 * builtin 呪文を呼び出す。未登録なら warning + no-op ログを返す。
 */
export function invokeBuiltinSpell(builtinId: string, ctx: EffectContext): string[] {
  // own-property のみ見る (#368)。素朴な `BUILTIN_SPELLS[builtinId]` は Object.prototype も
  // 辿ってしまい、master データの spell.builtin が `constructor` 等と一致すると `!fn` ガードを
  // すり抜けて関数オブジェクトを呼び出してしまう。
  const fn = hasOwn(BUILTIN_SPELLS, builtinId) ? BUILTIN_SPELLS[builtinId] : undefined
  if (!fn) {
    console.warn(`[name-name] builtin spell '${builtinId}' is not implemented`)
    return [`(builtin spell '${builtinId}' は未実装)`]
  }
  return fn(ctx)
}

/**
 * builtin アイテムを呼び出す。未登録なら warning + no-op ログを返す。
 */
export function invokeBuiltinItem(builtinId: string, ctx: EffectContext): string[] {
  // own-property のみ見る (#368)。理由は invokeBuiltinSpell と同様。
  const fn = hasOwn(BUILTIN_ITEMS, builtinId) ? BUILTIN_ITEMS[builtinId] : undefined
  if (!fn) {
    console.warn(`[name-name] builtin item '${builtinId}' is not implemented`)
    return [`(builtin item '${builtinId}' は未実装)`]
  }
  return fn(ctx)
}

// 型 import を握っておく（lint で unused import を防ぐ。実用は invoke* の引数経由）
export type { BattleEntity }
