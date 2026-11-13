/**
 * 戦闘後の経験値・レベルアップ (#206)。純関数のみ（DOM / PixiJS / 乱数に触れない）。
 *
 * 経験値は FF5 式: 戦闘で得た経験値の合計を、生き残った味方に等分する（端数は切り捨て）。
 * 味方ごとに `経験値表`（Lv1→2 から順に必要な累計 exp）で Lv を決め、上がった Lv の数だけ `成長`（魔石の `成長` と同じ書式）を能力値に足し、
 * `習得: Lv○ 呪文` を越えた分を覚える。リザルトの表示（`BattleScreen`）と持ち越し（`carryOverBattleResult`）は同じ `applyVictoryExp` を呼ぶ。
 * フィールド経路のみ。表を持たない味方は何も変わらない。
 */
import type { BattleEntity } from './spellDsl'
import { MAX_LEVEL } from './spellDsl'
import type { PartyMemberDef } from '../types'
import { addBonus, parseStatBonus, type StatBonus } from './magicite'
import { hasOwn } from './ownProperty'

/** レベルアップの定義（味方 1 人分）。`PartyMemberDef` の一部。`learns[].name` は呪文の表示名（無ければ `spellNames` → id） */
export type LevelUpDef = Pick<PartyMemberDef, 'level' | 'expTable' | 'growth'> & {
  learns?: ReadonlyArray<{ level: number; spell: string; name?: string }>
}

export interface LevelUpOptions {
  /** 呪文 id → 表示名 */
  spellNames?: Readonly<Record<string, string>>
}

export interface BattleExpResult {
  /** 経験値・Lv・能力値を反映した味方（入力は書き換えない） */
  member: BattleEntity
  /** 今回上がった Lv（上がった順。上がらなければ空） */
  gained: number[]
  /** 今回覚えた呪文の表示名（Lv の低い順） */
  learnedNames: string[]
}

/** 経験値表のあるキャラの上限 Lv（表の長さ + 1。`MAX_LEVEL` で頭打ち） */
export function levelCap(def: Pick<LevelUpDef, 'expTable'>): number {
  return Math.min(MAX_LEVEL, (def.expTable?.length ?? 0) + 1)
}

/** 累計 exp が届いている Lv（Lv1 から。表の終端・`MAX_LEVEL` で頭打ち） */
export function levelForExp(def: Pick<LevelUpDef, 'expTable'>, exp: number): number {
  const table = def.expTable ?? []
  let lv = 1
  while (lv - 1 < table.length && lv < MAX_LEVEL && exp >= table[lv - 1]) lv++
  return lv
}

/** その味方の現在の Lv（保存した Lv → 定義の初期 Lv → 1） */
export function currentLevel(member: Pick<BattleEntity, 'level'>, def?: LevelUpDef): number {
  const lv = member.level ?? def?.level ?? 1
  return Math.max(1, Math.floor(lv))
}

/** その味方の現在の累計 exp（保存した値 → 初期 Lv に必要な累計 → 0） */
export function currentExp(member: Pick<BattleEntity, 'exp' | 'level'>, def: LevelUpDef): number {
  // 味方の `exp` は設定の読み込みで 0 が入るので、Lv が付いている（= 一度でも経験値を足した）ときだけ保存値とみなす
  if (member.level !== undefined && typeof member.exp === 'number' && Number.isFinite(member.exp))
    return member.exp
  const lv = currentLevel(member, def)
  return lv > 1 ? (def.expTable?.[lv - 2] ?? 0) : 0
}

/**
 * 味方 1 人が経験値 `exp` を得る。表（`expTable`）が無い・`exp` が 0 以下なら何も変えない。
 * Lv が複数同時に上がっても、`成長` はその回数だけ足し、`習得` は越えた分をすべて覚える
 */
export function applyBattleExp(
  member: BattleEntity,
  def: LevelUpDef | undefined,
  exp: number,
  opts: LevelUpOptions = {}
): BattleExpResult {
  const unchanged: BattleExpResult = { member: { ...member }, gained: [], learnedNames: [] }
  if (!def || !def.expTable || def.expTable.length === 0) return unchanged
  if (!Number.isFinite(exp) || exp <= 0) return unchanged
  const before = currentLevel(member, def)
  const total = currentExp(member, def) + Math.floor(exp)
  // 保存した Lv が表の上限を超えていても下げない
  const after = Math.max(before, levelForExp(def, total))
  const next: BattleEntity = { ...member, exp: total, level: after }
  const gained: number[] = []
  for (let lv = before + 1; lv <= after; lv++) gained.push(lv)
  if (gained.length > 0) {
    let bonus: StatBonus = {}
    const per = parseStatBonus(def.growth).bonus
    for (let i = 0; i < gained.length; i++) bonus = addBonus(bonus, per)
    next.maxHp = Math.max(1, member.maxHp + (bonus.hp ?? 0))
    next.hp = Math.min(next.maxHp, Math.max(1, member.hp + (bonus.hp ?? 0)))
    next.maxMp = Math.max(0, member.maxMp + (bonus.mp ?? 0))
    next.mp = Math.min(next.maxMp, Math.max(0, member.mp + (bonus.mp ?? 0)))
    next.atk = Math.max(0, member.atk + (bonus.atk ?? 0))
    next.def = Math.max(0, member.def + (bonus.def ?? 0))
    next.agi = Math.max(0, member.agi + (bonus.agi ?? 0))
  }
  const learnedNames = (def.learns ?? [])
    .filter((l) => l.level > before && l.level <= after)
    .sort((a, b) => a.level - b.level)
    .map((l) =>
      opts.spellNames && hasOwn(opts.spellNames, l.spell)
        ? opts.spellNames[l.spell]
        : (l.name ?? l.spell)
    )
  return { member: next, gained, learnedNames }
}

/** 生存者 1 人あたりの経験値（FF5 式: 等分・端数切り捨て）。生存者 0 人は 0 */
export function splitExp(totalExp: number, survivors: number): number {
  if (!Number.isFinite(totalExp) || totalExp <= 0 || survivors <= 0) return 0
  return Math.floor(totalExp / survivors)
}

export interface VictoryExpResult {
  /** 経験値を反映した味方（入力と同じ順。入力は書き換えない） */
  party: BattleEntity[]
  /** レベルアップした人数 */
  levelUps: number
  /** 覚えた呪文の表示名（味方の並び順・Lv の低い順） */
  learnedNames: string[]
}

/**
 * 勝利時の経験値配分。生存者（HP > 0）に `totalExp` を等分して `applyBattleExp` を呼ぶ。倒れている味方・定義の無い味方は変わらない。
 * リザルトの表示と持ち越しが同じ入力でこれを呼ぶので、表示と確定は必ず一致する
 */
export function applyVictoryExp(
  party: readonly BattleEntity[],
  defs: Readonly<Record<string, LevelUpDef>>,
  totalExp: number,
  opts: LevelUpOptions = {}
): VictoryExpResult {
  const share = splitExp(totalExp, party.filter((m) => m.hp > 0).length)
  const out: BattleEntity[] = []
  let levelUps = 0
  const learnedNames: string[] = []
  for (const m of party) {
    if (m.hp <= 0 || share <= 0 || !hasOwn(defs, m.id)) {
      out.push(m)
      continue
    }
    const r = applyBattleExp(m, defs[m.id], share, opts)
    out.push(r.member)
    if (r.gained.length > 0) levelUps++
    learnedNames.push(...r.learnedNames)
  }
  return { party: out, levelUps, learnedNames }
}
