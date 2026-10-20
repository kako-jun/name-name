/** 状態異常 (#870) の宣言の解釈と純粋な判定関数 */
import { describe, it, expect } from 'vitest'
import type { StatusDef } from '../types'
import {
  activeStatusRules,
  blockingAction,
  buildStatusRules,
  DEFAULT_STATUS_TURNS,
  parseStatusDef,
  resolveRuleId,
  reversalOf,
  statusLabels,
  statusSuccessRate,
} from './statusEffects'
import { MAX_STATUS_CHANCE, MAX_STATUS_TURNS } from './battleLimits'

const def = (over: Partial<StatusDef> = {}): StatusDef => ({ id: 's', name: 'ステ', ...over })

describe('parseStatusDef: 持続', () => {
  it('省略は既定 3 ターン', () => {
    expect(parseStatusDef(def()).duration).toBe(DEFAULT_STATUS_TURNS)
    expect(DEFAULT_STATUS_TURNS).toBe(3)
  })
  it('1 以上の整数はそのまま。全角数字も読む', () => {
    expect(parseStatusDef(def({ duration: '5' })).duration).toBe(5)
    expect(parseStatusDef(def({ duration: '１２' })).duration).toBe(12)
    expect(parseStatusDef(def({ duration: '1' })).duration).toBe(1)
  })
  it('上限 99 を超えたら 99 に切って警告する（境界: 99 は警告なし・100 は警告）', () => {
    const at = parseStatusDef(def({ duration: String(MAX_STATUS_TURNS) }))
    expect(at.duration).toBe(MAX_STATUS_TURNS)
    expect(at.warnings).toEqual([])
    const over = parseStatusDef(def({ duration: String(MAX_STATUS_TURNS + 1) }))
    expect(over.duration).toBe(MAX_STATUS_TURNS)
    expect(over.warnings).toHaveLength(1)
    expect(parseStatusDef(def({ duration: '99999999999' })).duration).toBe(MAX_STATUS_TURNS)
  })
  it('0・負・小数・数字以外は既定に落として警告する', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '３ターン']) {
      const r = parseStatusDef(def({ duration: bad }))
      expect(r.duration, bad).toBe(DEFAULT_STATUS_TURNS)
      expect(r.warnings.length, bad).toBe(1)
    }
  })
})

describe('parseStatusDef: 継続ダメージ', () => {
  it('割合・固定幅・固定値', () => {
    expect(parseStatusDef(def({ tickDamage: '1/16' })).tick).toEqual({
      kind: 'fraction',
      num: 1,
      den: 16,
    })
    expect(parseStatusDef(def({ tickDamage: '１／８' })).tick).toEqual({
      kind: 'fraction',
      num: 1,
      den: 8,
    })
    expect(parseStatusDef(def({ tickDamage: '5..8' })).tick).toEqual({
      kind: 'range',
      min: 5,
      max: 8,
    })
    expect(parseStatusDef(def({ tickDamage: '8..5' })).tick).toEqual({
      kind: 'range',
      min: 5,
      max: 8,
    })
    expect(parseStatusDef(def({ tickDamage: '7' })).tick).toEqual({
      kind: 'range',
      min: 7,
      max: 7,
    })
    expect(parseStatusDef(def({ tickDamage: '0' })).tick).toEqual({
      kind: 'range',
      min: 0,
      max: 0,
    })
  })
  it('分母 0・分子 0・形式違いは無視して警告する', () => {
    for (const bad of ['1/0', '0/16', 'abc', '-3', '1/2/3', '']) {
      const r = parseStatusDef(def({ tickDamage: bad }))
      expect(r.tick, bad).toBeUndefined()
      expect(r.warnings.length, bad).toBe(1)
    }
  })
  it('書かなければ継続ダメージなし', () => {
    expect(parseStatusDef(def()).tick).toBeUndefined()
  })
})

describe('parseStatusDef: 行動・反転・解除・満了', () => {
  it('行動: 不能 / 行動不能 / 混乱 / 通常。省略は通常', () => {
    expect(parseStatusDef(def()).action).toBe('normal')
    expect(parseStatusDef(def({ action: '不能' })).action).toBe('stun')
    expect(parseStatusDef(def({ action: '行動不能' })).action).toBe('stun')
    expect(parseStatusDef(def({ action: '混乱' })).action).toBe('confuse')
    expect(parseStatusDef(def({ action: '通常' })).action).toBe('normal')
    expect(parseStatusDef(def({ action: '通常' })).warnings).toEqual([])
  })
  it('行動の不正値は通常にして警告する', () => {
    const r = parseStatusDef(def({ action: 'ねむる' }))
    expect(r.action).toBe('normal')
    expect(r.warnings).toHaveLength(1)
  })
  it('反転: 回復 / ダメージ / 両方（区切りは , 、 空白）。不明な語は警告して無視', () => {
    expect(parseStatusDef(def()).reverseHeal).toBe(false)
    expect(parseStatusDef(def()).reverseDamage).toBe(false)
    const heal = parseStatusDef(def({ reverse: '回復' }))
    expect([heal.reverseHeal, heal.reverseDamage]).toEqual([true, false])
    const dmg = parseStatusDef(def({ reverse: 'ダメージ' }))
    expect([dmg.reverseHeal, dmg.reverseDamage]).toEqual([false, true])
    for (const both of ['回復, ダメージ', '回復、ダメージ', 'ダメージ 回復']) {
      const r = parseStatusDef(def({ reverse: both }))
      expect([r.reverseHeal, r.reverseDamage], both).toEqual([true, true])
    }
    const bad = parseStatusDef(def({ reverse: '回復, 魔力' }))
    expect(bad.reverseHeal).toBe(true)
    expect(bad.warnings).toHaveLength(1)
  })
  it('解除: 被ダメージ。それ以外は警告して無視', () => {
    expect(parseStatusDef(def({ cure: '被ダメージ' })).cureOnDamage).toBe(true)
    const bad = parseStatusDef(def({ cure: '時間' }))
    expect(bad.cureOnDamage).toBe(false)
    expect(bad.warnings).toHaveLength(1)
  })
  it('満了: 戦闘不能。それ以外は警告して無視', () => {
    expect(parseStatusDef(def({ expire: '戦闘不能' })).expireDeath).toBe(true)
    const bad = parseStatusDef(def({ expire: '爆発' }))
    expect(bad.expireDeath).toBe(false)
    expect(bad.warnings).toHaveLength(1)
  })
})

describe('buildStatusRules / resolveRuleId', () => {
  it('id をキーに規則の表を作る。"__proto__" の id でも own-property になる', () => {
    const rules = buildStatusRules({
      poison: def({ id: 'poison', name: 'どく' }),
      ['__proto__']: def({ id: '__proto__', name: 'ぷろと' }),
    })
    expect(rules.poison.name).toBe('どく')
    expect(Object.keys(rules)).toContain('__proto__')
    expect(Object.getPrototypeOf(rules)).toBe(Object.prototype)
  })
  it('未定義は空の表', () => {
    expect(buildStatusRules(undefined)).toEqual({})
  })
  it('同名 → 日本語の別名（毒 → poison）の順に引く。規則が無ければ null', () => {
    const rules = buildStatusRules({ poison: def({ id: 'poison' }), 毒: def({ id: '毒' }) })
    expect(resolveRuleId(rules, '毒')).toBe('毒') // 同名が優先
    expect(resolveRuleId(rules, 'poison')).toBe('poison')
    const only = buildStatusRules({ poison: def({ id: 'poison' }) })
    expect(resolveRuleId(only, '毒')).toBe('poison')
    expect(resolveRuleId(only, 'sleep')).toBeNull()
    expect(resolveRuleId(only, 'constructor')).toBeNull()
    expect(resolveRuleId(undefined, 'poison')).toBeNull()
  })
})

describe('activeStatusRules / blockingAction / reversalOf / statusLabels', () => {
  const rules = buildStatusRules({
    poison: def({ id: 'poison', name: 'どく' }),
    sleep: def({ id: 'sleep', name: 'ねむり', action: '不能' }),
    mad: def({ id: 'mad', name: 'こんらん', action: '混乱' }),
    zombie: def({ id: 'zombie', name: 'ゾンビ', reverse: '回復, ダメージ' }),
  })
  it('残りターン 1 以上の宣言済みの状態だけが働く（付いた順）', () => {
    const e = { status: { mad: 2, marker: 5, poison: 0, sleep: 1 } }
    expect(activeStatusRules(e, rules).map((r) => r.id)).toEqual(['mad', 'sleep'])
    expect(statusLabels(e, rules)).toEqual(['こんらん', 'ねむり'])
    expect(activeStatusRules({}, rules)).toEqual([])
    expect(activeStatusRules({ status: { poison: NaN } }, rules)).toEqual([])
  })
  it('行動不能が混乱に優先する', () => {
    expect(blockingAction({ status: { mad: 1, sleep: 1 } }, rules)?.action).toBe('stun')
    expect(blockingAction({ status: { mad: 1 } }, rules)?.action).toBe('confuse')
    expect(blockingAction({ status: { poison: 3 } }, rules)).toBeNull()
    expect(blockingAction({}, rules)).toBeNull()
    expect(blockingAction({ status: { sleep: 1 } }, undefined)).toBeNull()
  })
  it('反転: 宣言した状態のどれかが持っていれば有効', () => {
    expect(reversalOf({ status: { zombie: 1 } }, rules)).toMatchObject({ heal: true, damage: true })
    expect(reversalOf({ status: { poison: 1 } }, rules)).toEqual({ heal: false, damage: false })
    expect(reversalOf({ status: { zombie: 0 } }, rules)).toEqual({ heal: false, damage: false })
  })
})

describe('statusSuccessRate', () => {
  it('確率を書かず耐性もなければ必中（1）', () => {
    expect(statusSuccessRate('normal', undefined, undefined)).toBe(1)
    expect(statusSuccessRate('normal', undefined, 50)).toBe(1) // 必中には成長ぶんも効かない
  })
  it('確率は % で、99 を上限に頭打ち（成長ぶんを足した後も）', () => {
    expect(statusSuccessRate('normal', 60, undefined)).toBeCloseTo(0.6)
    expect(statusSuccessRate('normal', 60, 20)).toBeCloseTo(0.8)
    expect(statusSuccessRate('normal', 90, 50)).toBeCloseTo(MAX_STATUS_CHANCE / 100)
    expect(statusSuccessRate('normal', 99, 0)).toBeCloseTo(0.99)
    expect(statusSuccessRate('normal', 0, undefined)).toBe(0)
    expect(statusSuccessRate('normal', 10, -50)).toBe(0) // 負の成長ぶんでも 0 未満にならない
    // 非有限の成長ぶん: +Infinity は上限 99%、-Infinity は 0、NaN は成長なし（0 点）扱い
    expect(statusSuccessRate('normal', 10, Infinity)).toBeCloseTo(MAX_STATUS_CHANCE / 100)
    expect(statusSuccessRate('normal', 10, -Infinity)).toBe(0)
    expect(statusSuccessRate('normal', 60, NaN)).toBeCloseTo(0.6)
    expect(statusSuccessRate('normal', 50, NaN)).toBeCloseTo(0.5)
  })
  it('耐性: 無効・吸収は 0 / 半減は ×0.5 / 弱点は ×2（上限 99%・元より下がらない）', () => {
    expect(statusSuccessRate('nullify', 80, undefined)).toBe(0)
    expect(statusSuccessRate('absorb', undefined, undefined)).toBe(0)
    expect(statusSuccessRate('halve', 80, undefined)).toBeCloseTo(0.4)
    expect(statusSuccessRate('halve', undefined, undefined)).toBeCloseTo(0.5)
    expect(statusSuccessRate('weak', 30, undefined)).toBeCloseTo(0.6)
    expect(statusSuccessRate('weak', 80, undefined)).toBeCloseTo(0.99)
    expect(statusSuccessRate('weak', undefined, undefined)).toBe(1)
  })
})
