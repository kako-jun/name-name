/** ジョブ (#740): 解決・検査・転職の純関数（単体・境界） */
import { describe, expect, it } from 'vitest'
import type { JobDef, PartyMemberDef } from '../types'
import { candidateJobIds, changeJob, currentJobId, resolveMemberJob, type JobRoster } from './job'
import { resolveMemberEquipment } from './equipment'

const JOBS: Record<string, JobDef> = {
  nurse: { id: 'nurse', name: '看護師', equipBonus: 'def+3, hp+20' },
  diver: { id: 'diver', name: '海女', equipBonus: 'agi+2', elements: ['water'] },
  twin: { id: 'twin', name: '氷炎', elements: ['fire', 'ice'] },
  bad: { id: 'bad', name: 'こわれ', equipBonus: 'xx+3, atk+5' },
}

const def = (over: Partial<PartyMemberDef> = {}): Pick<PartyMemberDef, 'id' | 'jobs'> => ({
  id: 'hero',
  jobs: ['nurse', 'diver'],
  ...over,
})
const roster = (over: Partial<JobRoster> = {}): JobRoster => ({ jobs: JOBS, ...over })

describe('candidateJobIds / currentJobId', () => {
  it('就けるジョブは書いた順・重複なし。宣言の有無は見ない', () => {
    expect(candidateJobIds({ id: 'a', jobs: ['x', 'y', 'x'] })).toEqual(['x', 'y'])
    expect(candidateJobIds({ id: 'a' })).toEqual([])
  })

  it('現在のジョブは currentJobs が優先、無ければ先頭。空文字はジョブ無し', () => {
    expect(currentJobId(def(), roster())).toBe('nurse')
    expect(currentJobId(def(), roster({ currentJobs: { hero: 'diver' } }))).toBe('diver')
    expect(currentJobId(def(), roster({ currentJobs: { hero: '' } }))).toBeUndefined()
    // 他の味方の指定は影響しない
    expect(currentJobId(def(), roster({ currentJobs: { other: 'diver' } }))).toBe('nurse')
    expect(currentJobId({ id: 'a' }, roster())).toBeUndefined()
    expect(currentJobId(def(), undefined)).toBe('nurse')
  })

  it('"__proto__" や "constructor" の id でも prototype を引かない', () => {
    expect(currentJobId({ id: 'constructor' }, roster({ currentJobs: {} }))).toBeUndefined()
    const r = resolveMemberJob({ id: 'a', jobs: ['constructor'] }, roster())
    expect(r.job).toBeUndefined()
    expect(r.warnings[0]).toContain('宣言が無い')
  })
})

describe('resolveMemberJob', () => {
  it('ジョブを持たない味方は空の結果（警告なし）', () => {
    const r = resolveMemberJob({ id: 'a' }, roster())
    expect(r).toEqual({ job: undefined, bonus: {}, elements: [], warnings: [] })
    expect(resolveMemberJob({ id: 'a' }, undefined).job).toBeUndefined()
  })

  it('先頭のジョブの装備時と属性を返す', () => {
    const r = resolveMemberJob(def(), roster())
    expect(r.job?.id).toBe('nurse')
    expect(r.bonus).toEqual({ def: 3, hp: 20 })
    expect(r.elements).toEqual([])
    const d = resolveMemberJob(def(), roster({ currentJobs: { hero: 'diver' } }))
    expect(d.bonus).toEqual({ agi: 2 })
    expect(d.elements).toEqual(['water'])
  })

  it('宣言が無い・就けるジョブに入っていないジョブは警告して無視する（ジョブ無し）', () => {
    const unknown = resolveMemberJob(def({ jobs: ['ghost'] }), roster())
    expect(unknown.job).toBeUndefined()
    expect(unknown.warnings).toEqual(["hero: ジョブ 'ghost' は宣言が無いため就けない"])
    const notCand = resolveMemberJob(def(), roster({ currentJobs: { hero: 'twin' } }))
    expect(notCand.job).toBeUndefined()
    expect(notCand.bonus).toEqual({})
    expect(notCand.warnings[0]).toContain('就けるジョブ（ジョブ:）に含まれない')
    // マスターが無い（ジョブを宣言していないゲーム）でも落ちない
    expect(resolveMemberJob(def(), {}).warnings).toHaveLength(1)
  })

  it('読めないボーナスは警告して読めた分だけ使う', () => {
    const r = resolveMemberJob(def({ jobs: ['bad'] }), roster())
    expect(r.bonus).toEqual({ atk: 5 })
    expect(r.warnings.some((w) => w.includes("ジョブ 'bad'") && w.includes('xx+3'))).toBe(true)
  })
})

describe('changeJob', () => {
  it('就けるジョブへ転職できる。すでに就いているジョブも ok（変更なし）', () => {
    expect(changeJob(def(), roster(), 'diver')).toEqual({ ok: true, job: 'diver' })
    expect(changeJob(def(), roster(), 'nurse')).toEqual({ ok: true, job: 'nurse' })
  })

  it('宣言が無い・就けるジョブに入っていないときは失敗し、いまのジョブのまま', () => {
    const a = changeJob(def(), roster({ currentJobs: { hero: 'diver' } }), 'twin')
    expect(a.ok).toBe(false)
    expect(a.job).toBe('diver')
    expect(a.reason).toContain('就けるジョブ')
    const b = changeJob(def(), roster(), 'ghost')
    expect(b).toMatchObject({ ok: false, job: 'nurse' })
    expect(b.reason).toContain('宣言が無い')
  })

  it('入力を変えない。転職の結果を currentJobs に入れると装備の結果に反映される', () => {
    const r = roster({ currentJobs: { hero: 'nurse' } })
    const before = JSON.stringify(r)
    const c = changeJob(def(), r, 'diver')
    expect(JSON.stringify(r)).toBe(before)
    const after = roster({ currentJobs: { hero: c.job ?? '' } })
    const eq = resolveMemberEquipment(def(), after)
    expect(eq.job?.id).toBe('diver')
    expect(eq.affinity).toEqual({ halve: ['water'] })
    expect(eq.bonus).toEqual({ agi: 2 })
  })
})

describe('装備への統合（resolveMemberEquipment）', () => {
  const ITEMS = {
    robe: { id: 'robe', name: 'ふく', kind: '防具', elements: ['water'], equipBonus: 'def+1' },
    plate: { id: 'plate', name: 'よろい', kind: '防具', elements: ['fire'] },
  }

  it('ジョブを宣言しない・就かない味方は、結果が従来と同一（job のキーも出ない）', () => {
    const plain = resolveMemberEquipment({ id: 'a' }, { items: ITEMS })
    expect(Object.keys(plain)).not.toContain('job')
    expect(plain.bonus).toEqual({})
    // jobs のマスターがあっても、味方が就けるジョブを持たなければ同じ
    const withMaster = resolveMemberEquipment({ id: 'a' }, { items: ITEMS, jobs: JOBS })
    expect(withMaster).toEqual(plain)
  })

  it('ジョブのボーナスは装備のボーナスと足し合わさる', () => {
    const eq = resolveMemberEquipment(
      { id: 'hero', jobs: ['nurse'], equipment: ['robe'] },
      { items: ITEMS, jobs: JOBS }
    )
    expect(eq.bonus).toEqual({ def: 4, hp: 20 })
  })

  it('属性は耐性の層にだけ積まれ、攻撃の属性にはならない。同属性は装備と合わせて吸収', () => {
    const eq = resolveMemberEquipment(
      { id: 'hero', jobs: ['diver'], equipment: ['robe'] },
      { items: ITEMS, jobs: JOBS }
    )
    expect(eq.layers).toEqual(['water', 'water'])
    expect(eq.affinity).toEqual({ absorb: ['water'] })
    expect(eq.attackElements).toEqual([])
  })

  it('層は合計 2 まで。超えたらジョブの層が先に捨てられ、警告する', () => {
    const eq = resolveMemberEquipment(
      { id: 'hero', jobs: ['twin'], equipment: ['plate'] },
      { items: ITEMS, jobs: JOBS }
    )
    expect(eq.layers).toEqual(['fire', 'fire'])
    expect(eq.affinity).toEqual({ absorb: ['fire'] })
    expect(eq.warnings.some((w) => w.includes("'fire'") || w.includes("'ice'"))).toBe(true)
  })

  it('就けないジョブの警告は装備の警告と一緒に返る', () => {
    const eq = resolveMemberEquipment({ id: 'hero', jobs: ['ghost'] }, { items: ITEMS, jobs: JOBS })
    expect(eq.job).toBeUndefined()
    expect(eq.warnings).toEqual(["hero: ジョブ 'ghost' は宣言が無いため就けない"])
  })
})
