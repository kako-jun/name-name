/**
 * 召喚獣 (#750)。`[召喚獣 id]` の宣言を、魔石・特技の `召喚獣id:` から引き当てる純関数群。ブラウザ API にも PixiJS にも触れない。
 *
 * - 召喚獣は魔石の石と独立した「像」の宣言（画像・効果音・属性・想像の層と、召喚の中身の既定）。魔石（味方が呼ぶ）も味方の「わざ」（`召喚獣id` を持つ特技）も同じ口で参照する。敵は召喚獣を呼ばない（敵が使う特技の `cue` はエンジンが無視する）
 * - 参照の解決（`resolveSummonRefs`）: 参照側が `効果`/`builtin` を持たないときだけ、召喚獣の `対象`/`効果`/`builtin`/`メッセージ` を使う
 *   （持つなら参照側が優先。部分的に混ぜない＝どちらの中身かが 1 か所で分かる）。魔石に属性が無ければ召喚獣の属性、表示名が無ければ召喚獣の名前を使う
 * - 解決は宣言から導く純粋な写しで、`cue`（演出の元）を足した新しい定義を返す。`召喚獣id` を持たない定義は同じオブジェクトのまま（キーも増えない）
 * - 演出（`cue`）はエンジンが行動の記録（`BattleActionEvent.summon`）に載せ、画面が見せる。エンジンの状態・乱数は変えない
 */
import type { MagiciteDef, SkillDef, SummonCue, SummonDef } from '../types'
import { hasOwn, safeAssign } from './ownProperty'

/** 召喚獣 → 演出の元。空の画像・効果音は付けず、想像が偽なら `imaginary` も付けない（キーを増やさない） */
export function toSummonCue(beast: SummonDef): SummonCue {
  return {
    id: beast.id,
    name: beast.name,
    ...(beast.image !== undefined && beast.image !== '' ? { image: beast.image } : {}),
    ...(beast.facing === 'left' ? { faces: 'left' as const } : {}),
    ...(beast.se !== undefined && beast.se !== '' ? { se: beast.se } : {}),
    ...(beast.imaginary ? { imaginary: true } : {}),
  }
}

/** 参照側が自分の召喚の中身（`効果` か `builtin`）を持つか */
function hasOwnEffect(d: { effect?: string; builtin?: string }): boolean {
  return (
    (d.effect !== undefined && d.effect !== '') || (d.builtin !== undefined && d.builtin !== '')
  )
}

/** 召喚獣の中身の既定を参照側へ足す（参照側が持たないときだけ）。返すのは足す分だけ */
function inheritedBody(
  beast: SummonDef,
  ref: { effect?: string; builtin?: string }
): { target?: string; effect?: string; builtin?: string; message?: string } {
  if (hasOwnEffect(ref)) return {}
  return {
    ...(beast.target !== undefined ? { target: beast.target } : {}),
    ...(beast.effect !== undefined ? { effect: beast.effect } : {}),
    ...(beast.builtin !== undefined ? { builtin: beast.builtin } : {}),
    ...(beast.message !== undefined ? { message: beast.message } : {}),
  }
}

export interface SummonRefMaster {
  skills?: Record<string, SkillDef>
  magicites?: Record<string, MagiciteDef>
  summons?: Record<string, SummonDef>
}

export interface ResolvedSummonRefs {
  skills: Record<string, SkillDef> | undefined
  magicites: Record<string, MagiciteDef> | undefined
  warnings: string[]
}

/**
 * 魔石・特技の `召喚獣id` を `[召喚獣]` へ引き当てる。宣言の無い id は警告して無視する（`cue` を付けず、中身も継がない＝参照しなかったのと同じ）。
 * `召喚獣id` を持たない定義はそのまま（同じオブジェクト）。どの定義も参照しなければ入力と同じ 2 つのマップを返す
 */
export function resolveSummonRefs(master: SummonRefMaster): ResolvedSummonRefs {
  const warnings: string[] = []
  const summons = master.summons
  const find = (kind: string, owner: string, id: string): SummonDef | undefined => {
    if (summons && hasOwn(summons, id)) return summons[id]
    warnings.push(`${kind} '${owner}' の 召喚獣id '${id}' は宣言が無いため無視した`)
    return undefined
  }
  let skills = master.skills
  if (skills) {
    let out: Record<string, SkillDef> | undefined
    for (const [id, sk] of Object.entries(skills)) {
      if (sk.summonId === undefined || sk.summonId === '') continue
      const beast = find('特技', id, sk.summonId)
      if (!beast) continue
      out ??= { ...skills }
      safeAssign<SkillDef>(out, id, { ...sk, ...inheritedBody(beast, sk), cue: toSummonCue(beast) })
    }
    skills = out ?? skills
  }
  let magicites = master.magicites
  if (magicites) {
    let out: Record<string, MagiciteDef> | undefined
    for (const [id, st] of Object.entries(magicites)) {
      if (st.summonId === undefined || st.summonId === '') continue
      const beast = find('魔石', id, st.summonId)
      if (!beast) continue
      out ??= { ...magicites }
      safeAssign<MagiciteDef>(out, id, {
        ...st,
        ...inheritedBody(beast, st),
        // 表示名・属性は、石に無ければ召喚獣のものを使う
        ...(st.summon === undefined || st.summon === '' ? { summon: beast.name } : {}),
        ...((st.elements === undefined || st.elements.length === 0) &&
        beast.elements !== undefined &&
        beast.elements.length > 0
          ? { elements: [...beast.elements] }
          : {}),
        cue: toSummonCue(beast),
      })
    }
    magicites = out ?? magicites
  }
  return { skills, magicites, warnings }
}

const warnedSummons = new Set<string>()

/** 警告を 1 度だけ出す（同じ文面を戦闘のたびに繰り返さない） */
export function warnSummonOnce(warnings: readonly string[]): void {
  for (const w of warnings) {
    if (warnedSummons.has(w)) continue
    warnedSummons.add(w)
    console.warn(`[name-name] 召喚獣: ${w}`)
  }
}
