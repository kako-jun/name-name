/**
 * 属性相性 (#872)。`[モンスター]` の `弱点:` / `半減:` / `無効:` / `吸収:`（`MonsterDef.affinity`）を戦闘で解決する。
 *
 * - 優先順位は 吸収 > 無効 > 半減 > 弱点。FF6 SNES のダメージ計算 Step 9a〜9e と同じく、該当した時点で打ち切る
 *   （sit-by-me `docs/ff-battle-rules.md` §1）。どの欄にも該当しなければ `normal`（呼び出し側が従来の `resist` へフォールバックする）
 * - 属性 id は自由記述の文字列で、parser が小文字・半角に寄せて渡す。技の `type=` 側も小文字にして比べる
 * - **無属性**（`type=` が無い・空）は相性判定の対象外で常に `normal`（耐性欄に無属性は書けない。parser が警告して捨てる）
 * - 即死は属性 id `death` として同じ欄に書く（`damage_full` と builtin `zaraki` が参照し、成功率を変える。`deathSuccessRate`）
 * - 倍率の適用（弱点 ×2・半減 ×½〈最低 1〉・無効 0・吸収 = 回復）は `applyAffinityToDamage`。
 *   防御との順序は FF6 SNES どおり「防御で軽減した後に属性」。呪文・特技・アイテムの `damage` は防御を使わないので、
 *   乱数で出した値にそのまま掛ける（通常攻撃は未対応で、この関数を通らない）
 */

/** 属性相性の 4 欄（属性 id の配列）。空の欄は省略可 */
export interface BattleAffinity {
  weak?: string[]
  halve?: string[]
  nullify?: string[]
  absorb?: string[]
}

export type AffinityKind = 'absorb' | 'nullify' | 'halve' | 'weak' | 'normal'

/** 即死耐性の属性 id (#872)。`death` の相性で即死の成功率が変わる（`deathSuccessRate`） */
export const DEATH_ATTRIBUTE = 'death'

/** 即死の成功率の上限 (#872)。弱点で成功率が上がるときの頭打ち（#877 で値を確定する想定。ここ 1 か所だけに置く） */
export const DEATH_CHANCE_CAP = 0.99

/**
 * 即死の成功率を `death` の相性で変える (#872)。`base` は効果の既定の成功率（0〜1。`damage_full` は 1、`zaraki` は 0.5）。
 * 吸収・無効 = 0（吸収でも回復しない）/ 半減 = ×0.5 / 弱点 = ×2 だが上限 `DEATH_CHANCE_CAP` で頭打ち。
 * 上限は「元より下がる方向」にだけ効く: 弱点でも `base` を下回らない（既定 100% の効果は弱点でも 100% のまま）。相性なしは `base` のまま。
 */
export function deathSuccessRate(kind: AffinityKind, base: number): number {
  switch (kind) {
    case 'absorb':
    case 'nullify':
      return 0
    case 'halve':
      return base * 0.5
    case 'weak':
      return Math.max(base, Math.min(base * 2, DEATH_CHANCE_CAP))
    default:
      return base
  }
}

/**
 * 即死の成功判定。成功率が 1 以上なら成功・0 以下なら失敗で、どちらも乱数を使わない
 * （相性なし・既定 100% の `damage_full` の乱数消費は従来と同じ）。0 < 率 < 1 のときだけ乱数を 1 回使う。
 */
export function rollDeath(rate: number, rng: () => number): boolean {
  if (rate >= 1) return true
  if (rate <= 0) return false
  return rng() < rate
}

function listHas(list: string[] | undefined, id: string): boolean {
  return Array.isArray(list) && list.includes(id)
}

/** 属性 `type` に対する相性を、吸収 > 無効 > 半減 > 弱点の順に判定する。相性なし・無属性・未登録は `normal` */
export function resolveAffinity(
  affinity: BattleAffinity | undefined,
  type: string | undefined
): AffinityKind {
  if (!affinity || !type) return 'normal'
  const id = type.trim().toLowerCase()
  if (id === '') return 'normal'
  if (listHas(affinity.absorb, id)) return 'absorb'
  if (listHas(affinity.nullify, id)) return 'nullify'
  if (listHas(affinity.halve, id)) return 'halve'
  if (listHas(affinity.weak, id)) return 'weak'
  return 'normal'
}

/**
 * 相性をダメージ量に当てる。戻りの `amount` は kind ごとに意味が違う:
 * `weak` = 2 倍 / `halve` = 半分（切り捨て、元が 1 以上なら最低 1）/ `nullify` = 0 /
 * `absorb` = 回復する量（元の値のまま）/ `normal` = 元の値のまま。
 */
export function applyAffinityToDamage(kind: AffinityKind, base: number): number {
  switch (kind) {
    case 'weak':
      return base * 2
    case 'halve':
      return base > 0 ? Math.max(1, Math.floor(base / 2)) : 0
    case 'nullify':
      return 0
    default:
      return base
  }
}

/**
 * `MonsterDef.affinity` を戦闘への組み立て用の `{ affinity }` にする。無い・全欄が空なら `{}`（書かない敵の `BattleEntity` は従来と同一）。
 */
export function affinityField(
  affinity: BattleAffinity | undefined
): { affinity: BattleAffinity } | Record<string, never> {
  if (!affinity) return {}
  const out: BattleAffinity = {}
  for (const key of ['weak', 'halve', 'nullify', 'absorb'] as const) {
    const list = affinity[key]
    if (Array.isArray(list) && list.length > 0) out[key] = [...list]
  }
  return Object.keys(out).length > 0 ? { affinity: out } : {}
}
