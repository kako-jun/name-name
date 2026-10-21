/**
 * ジョブ（職業。#740）。`[ジョブ id]` の宣言と、`[パーティ]` の `ジョブ:`（就けるジョブ）を、戦闘に出る味方の能力値・属性にする純関数群。
 * ブラウザ API にも PixiJS にも触れない。
 *
 * - ジョブは「アビリティを変化させるパッシブ」で、**アクティブなコマンド（わざ・まほう等）を持たない**。就いている間だけ
 *   `装備時`（能力値に足す。魔石・装備品と同じ書式・同じ解釈器 `parseStatBonus`）と `属性`（属性防御の層）が効く
 * - 就けるジョブ: `[パーティ]` の `ジョブ:`（書いた順。先頭が最初のジョブ）。現在のジョブは入力 `roster.currentJobs`（味方 id → ジョブ id）で、
 *   無ければ先頭。`''` は「ジョブ無し」（まだ転職が解放されていない時期など。`roster.equipment` の空配列と同じ）。
 *   宣言の無い id・就けるジョブに入っていない id は警告して無視する（ジョブ無しになる）
 * - 属性: 耐性の層にだけ積まれ、攻撃の属性にはならない。魔石 → 装備品 → ジョブの順で、合計 2 層まで（`equipment.ts` が積む。超えたらジョブの層が先に捨てられる）
 * - 転職の計算（`changeJob`）: 純関数。いつ転職できるか（フィールドのみ・戦闘中不可・費用）と、保存・メニュー UI は #738 / #880 の領分で、
 *   エンジンは「いま誰がどのジョブか」（`roster.currentJobs`）を入力に受けるだけ
 *
 * ジョブを宣言していない・就けるジョブを持たない味方は、ここを通っても `BattleEntity` が従来と同一（キーも増えない）。
 */
import type { JobDef, PartyMemberDef } from '../types'
import { parseStatBonus, type StatBonus } from './magicite'
import { hasOwn } from './ownProperty'

/** ジョブまわりの入力（`FieldBattleRoster` の一部。すべて省略可） */
export interface JobRoster {
  /** ジョブのマスター（`[ジョブ]`） */
  jobs?: Record<string, JobDef>
  /** 現在のジョブ（味方 id → ジョブ id）。無い味方は `ジョブ:` の先頭。`''` はジョブ無し。保存・メニュー UI は #738 / #880 */
  currentJobs?: Record<string, string>
}

type MemberDef = Pick<PartyMemberDef, 'id' | 'jobs'>

/** 戦闘への組み立て用: 味方 1 人のジョブまわりの結果 */
export interface MemberJob {
  /** 就いているジョブ。無ければ undefined */
  job: JobDef | undefined
  /** 能力値に足すボーナス（ジョブの `装備時`） */
  bonus: StatBonus
  /** 耐性の層に積む属性（ジョブの `属性`） */
  elements: string[]
  warnings: string[]
}

/** 味方が就けるジョブの id（`ジョブ:` を書いた順・重複なし。宣言の有無は見ない） */
export function candidateJobIds(def: MemberDef): string[] {
  const out: string[] = []
  for (const id of def.jobs ?? []) if (typeof id === 'string' && !out.includes(id)) out.push(id)
  return out
}

/** いま就いているジョブの id（`roster.currentJobs` が優先。無ければ `ジョブ:` の先頭）。ジョブ無しは undefined。検査はしない */
export function currentJobId(def: MemberDef, roster: JobRoster | undefined): string | undefined {
  if (roster?.currentJobs && hasOwn(roster.currentJobs, def.id)) {
    const id = roster.currentJobs[def.id]
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  return candidateJobIds(def)[0]
}

/** `id` を味方 `def` のジョブとして検査する。通れば宣言、通らなければ理由 */
function checkJob(
  def: MemberDef,
  roster: JobRoster | undefined,
  id: string
): { job: JobDef } | { reason: string } {
  const master = roster?.jobs
  if (!master || !hasOwn(master, id)) {
    return { reason: `${def.id}: ジョブ '${id}' は宣言が無いため就けない` }
  }
  if (!candidateJobIds(def).includes(id)) {
    return { reason: `${def.id}: ジョブ '${id}' は就けるジョブ（ジョブ:）に含まれないため就けない` }
  }
  return { job: master[id] }
}

/**
 * 味方 1 人のジョブを解決する。ジョブを持たない（`ジョブ:` も `currentJobs` も無い）味方は、`bonus` / `elements` は空・`job` は undefined。
 * 就けないジョブは警告して無視する（ジョブ無しとして扱う）
 */
export function resolveMemberJob(def: MemberDef, roster: JobRoster | undefined): MemberJob {
  const id = currentJobId(def, roster)
  if (id === undefined) return { job: undefined, bonus: {}, elements: [], warnings: [] }
  const checked = checkJob(def, roster, id)
  if ('reason' in checked) {
    return { job: undefined, bonus: {}, elements: [], warnings: [checked.reason] }
  }
  const warnings: string[] = []
  const parsed = parseStatBonus(checked.job.equipBonus)
  for (const w of parsed.warnings) warnings.push(`${def.id}: ジョブ '${id}': ${w}`)
  return {
    job: checked.job,
    bonus: parsed.bonus,
    elements: [...(checked.job.elements ?? [])],
    warnings,
  }
}

/** 転職の結果 */
export interface JobChange {
  /** 転職できたか。すでに就いているジョブを指定したときも「変更なし」で ok */
  ok: boolean
  /** 変更後の現在のジョブの id（失敗したときは変更前のまま。ジョブ無しは undefined）。`roster.currentJobs[def.id]` に入れる値（無しは `''`） */
  job: string | undefined
  /** 失敗した理由（`ok: false` のとき） */
  reason?: string
}

/**
 * 転職する（純関数。入力は変えない）。ジョブの宣言があり、味方の就けるジョブ（`ジョブ:`）に入っているときだけ変更後を返す。
 * いつ転職できるか・費用・保存・メニュー UI は呼び出し側（#738 / #880）の仕事
 */
export function changeJob(def: MemberDef, roster: JobRoster | undefined, id: string): JobChange {
  const before = currentJobId(def, roster)
  const checked = checkJob(def, roster, id)
  if ('reason' in checked) return { ok: false, job: before, reason: checked.reason }
  return { ok: true, job: id }
}
