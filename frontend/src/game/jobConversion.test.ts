import { afterEach, describe, expect, it, vi } from 'vitest'
import { convertEffect, convertForJob, parseConversions } from './jobConversion'
import { buildBattleMenuData, type FieldBattleRoster } from './fieldBattle'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { JobDef, SkillDef, SpellDef } from '../types'

afterEach(() => vi.restoreAllMocks())

describe('parseConversions (#876)', () => {
  it('<タグ> => <トークン…> を書いた順に解釈する', () => {
    expect(parseConversions(['ぬすむ => 回数=2', '火 => type=fire 確率=50'])).toEqual({
      conversions: [
        { tag: 'ぬすむ', tokens: ['回数=2'] },
        { tag: '火', tokens: ['type=fire', '確率=50'] },
      ],
      warnings: [],
    })
  })
  it.each([
    ['回数=2', '形ではありません'],
    [' => 回数=2', '形ではありません'],
    ['ぬすむ =>', 'トークンがありません'],
    ['ぬすむ => 倍', 'キー=値 の形ではない'],
  ])('不正な行 %s は警告して捨てる', (line, why) => {
    const r = parseConversions([line])
    expect(r.conversions).toEqual([])
    expect(r.warnings.join()).toContain(why)
  })
  it('キー=値でないトークンだけを捨て、ほかのトークンは生きる', () => {
    const r = parseConversions(['ぬすむ => 倍 回数=2'])
    expect(r.conversions).toEqual([{ tag: 'ぬすむ', tokens: ['回数=2'] }])
    expect(r.warnings).toHaveLength(1)
  })
})

describe('convertEffect (#876)', () => {
  it('同じキーは値を置き換え、無ければ末尾に足す', () => {
    expect(convertEffect('steal', ['回数=2'], 'x')).toBe('steal 回数=2')
    expect(convertEffect('steal 回数=2 確率=30', ['回数=3'], 'x')).toBe('steal 回数=3 確率=30')
    expect(convertEffect('damage 5..9', ['type=fire'], 'x')).toBe('damage 5..9 type=fire')
    expect(convertEffect('damage 5..9 type=ice', ['type=fire'], 'x')).toBe('damage 5..9 type=fire')
  })
  it('効果が変わらない（同じ値）・変換できないトークンは undefined / 警告して無視', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(convertEffect('steal 回数=2', ['回数=2'], 'x')).toBeUndefined()
    // heal に 回数= は付かない（無視される修飾）
    expect(convertEffect('heal 10..20', ['回数=3'], 'x')).toBeUndefined()
    // 値が不正で解釈できない効果になる
    expect(convertEffect('steal', ['確率=abc'], 'x')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
  it('効くトークンだけ効き、変換できないものは飛ばす', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(convertEffect('damage 5..9', ['回数=3', 'zzz=1'], 'x2')).toBe('damage 5..9 回数=3 zzz=1')
  })
})

describe('convertForJob (#876)', () => {
  const job = { id: 'thief', name: '盗賊', conversions: ['ぬすむ => 回数=2'] }
  it('タグが合ったときだけ変換し、ジョブの名前を返す', () => {
    expect(convertForJob(job, ['ぬすむ'], 'steal', 'l')).toEqual({
      effect: 'steal 回数=2',
      convertedBy: '盗賊',
    })
  })
  it('ジョブ無し・変換なし・タグなし・タグ不一致・効果なし（builtin）は undefined（従来どおり）', () => {
    expect(convertForJob(undefined, ['ぬすむ'], 'steal', 'l')).toBeUndefined()
    expect(convertForJob({ id: 'j', name: 'j' }, ['ぬすむ'], 'steal', 'l')).toBeUndefined()
    expect(convertForJob(job, undefined, 'steal', 'l')).toBeUndefined()
    expect(convertForJob(job, [], 'steal', 'l')).toBeUndefined()
    expect(convertForJob(job, ['火'], 'steal', 'l')).toBeUndefined()
    expect(convertForJob(job, ['ぬすむ'], undefined, 'l')).toBeUndefined()
  })
  it('複数の変換が同じタグに当たれば順に重ねる', () => {
    const j = { id: 'j', name: 'J', conversions: ['a => 回数=2', 'a => 確率=40'] }
    expect(convertForJob(j, ['a'], 'steal', 'l')?.effect).toBe('steal 回数=2 確率=40')
  })
})

const skill = (id: string, effect: string, tags?: string[]): SkillDef => ({
  id,
  name: `わざ${id}`,
  target: '相手単体',
  effect,
  ...(tags ? { tags } : {}),
})
const spell = (id: string, effect: string, tags?: string[]): SpellDef => ({
  id,
  name: `まほう${id}`,
  mp: 1,
  target: '敵単体',
  effect,
  ...(tags ? { tags } : {}),
})
const THIEF: JobDef = {
  id: 'thief',
  name: '盗賊',
  conversions: ['ぬすむ => 回数=2', '火 => type=fire'],
}
const hero: BattleEntity = {
  id: 'hero',
  name: 'ゆうしゃ',
  hp: 99,
  maxHp: 99,
  mp: 9,
  maxMp: 9,
  atk: 5,
  def: 0,
  agi: 9,
}
const roster = (over: Partial<FieldBattleRoster> = {}): FieldBattleRoster => ({
  party: {
    hero: {
      id: 'hero',
      name: 'ゆうしゃ',
      hp: 99,
      atk: 5,
      def: 0,
      agi: 9,
      abilities: ['steal1', 'plain'],
      learns: [
        { level: 1, spell: 'fire' },
        { level: 1, spell: 'cure' },
      ],
      jobs: ['thief'],
    },
  },
  order: ['hero'],
  skills: { steal1: skill('steal1', 'steal', ['ぬすむ']), plain: skill('plain', 'damage 1..2') },
  spells: { fire: spell('fire', 'damage 5..9', ['火']), cure: spell('cure', 'heal 5..9') },
  jobs: { thief: THIEF },
  ...over,
})

describe('buildBattleMenuData: ジョブの変換 (#876)', () => {
  it('タグが合うわざ・呪文だけ変換され、印（convertedBy）が付く。タグなし・不一致は従来のまま', () => {
    const m = buildBattleMenuData(roster(), [hero])
    expect(m?.skills?.hero.map((s) => [s.id, s.effect, s.convertedBy])).toEqual([
      ['steal1', 'steal 回数=2', '盗賊'],
      ['plain', 'damage 1..2', undefined],
    ])
    expect(m?.spells?.hero.map((s) => [s.id, s.effect, s.convertedBy])).toEqual([
      ['fire', 'damage 5..9 type=fire', '盗賊'],
      ['cure', 'heal 5..9', undefined],
    ])
    // 変換しないものは convertedBy のキーも付かない
    expect('convertedBy' in (m?.skills?.hero[1] ?? {})).toBe(false)
  })
  it('ジョブ無し（currentJobs が空）・ジョブ宣言なしでは変換されない', () => {
    const none = buildBattleMenuData(roster({ currentJobs: { hero: '' } }), [hero])
    expect(none?.skills?.hero[0].effect).toBe('steal')
    expect('convertedBy' in (none?.skills?.hero[0] ?? {})).toBe(false)
    const noJobs = buildBattleMenuData(roster({ jobs: undefined }), [hero])
    expect(noJobs?.skills?.hero[0].effect).toBe('steal')
  })
  it('就いているジョブで変わる（別のジョブなら別の変換）。元のマスターは書き換えない', () => {
    const r = roster({
      jobs: {
        thief: THIEF,
        nurse: { id: 'nurse', name: '看護師', conversions: ['ぬすむ => 確率=90'] },
      },
    })
    r.party.hero.jobs = ['thief', 'nurse']
    const before = JSON.stringify(r)
    const m = buildBattleMenuData({ ...r, currentJobs: { hero: 'nurse' } }, [hero])
    expect(m?.skills?.hero[0]).toMatchObject({ effect: 'steal 確率=90', convertedBy: '看護師' })
    expect(JSON.stringify(r)).toBe(before)
  })
})

describe('BattleEngine: 変換した効果とログ (#876)', () => {
  const foe = (): BattleEntity => ({
    id: 'slime',
    name: 'スライム',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 0,
    def: 0,
    agi: 1,
    exp: 1,
    gold: 1,
    loot: { steal: ['potion', 'potion'], stealLimit: '2' },
  })
  const use = (withJob: boolean) => {
    const r = roster(withJob ? {} : { currentJobs: { hero: '' } })
    const entry = buildBattleMenuData(r, [hero])!.skills!.hero[0]
    const e = new BattleEngine([{ ...hero, hp: 999, maxHp: 999 }], [foe()], { rng: () => 0 })
    e.selectSkill(entry)
    return e.getState()
  }
  it('変換あり: ぬすむの回数が増え、ログに「(盗賊ジョブの 効果)」が出る。なしは従来どおりで出ない', () => {
    const on = use(true)
    const off = use(false)
    expect(on.loot?.length ?? 0).toBeGreaterThan(off.loot?.length ?? 0)
    expect(on.log).toContain('(盗賊ジョブの 効果)')
    expect(off.log.some((l) => l.includes('ジョブの 効果'))).toBe(false)
  })
})

describe('markdown: タグ・変換が wasm を生き残る (#876)', () => {
  it('[特技][呪文] の タグ: と [ジョブ] の 変換: が残り、emit → parse で保たれる', async () => {
    const { emitMarkdown, parseMarkdown } = await import('../wasm/parser')
    const { collectMasterData } = await import('./rpgProjectFromDoc')
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## data: マスター',
      '',
      '[特技 steal1]',
      '名前: ぬすむ',
      '効果: steal',
      'タグ: ぬすむ, 物理',
      '[/特技]',
      '',
      '[呪文 fire]',
      '名前: ファイア',
      'MP: 3',
      '効果: damage 5..9',
      'タグ: 火',
      '[/呪文]',
      '',
      '[ジョブ thief]',
      '名前: 盗賊',
      '変換: ぬすむ => 回数=2',
      '変換: 火 => type=fire',
      '[/ジョブ]',
      '',
    ].join('\n')
    const doc = await parseMarkdown(md)
    const m = collectMasterData(doc)
    expect(m.skills.steal1.tags).toEqual(['ぬすむ', '物理'])
    expect(m.spells.fire.tags).toEqual(['火'])
    expect(m.jobs.thief.conversions).toEqual(['ぬすむ => 回数=2', '火 => type=fire'])
    const again = collectMasterData(await parseMarkdown(await emitMarkdown(doc)))
    expect(again.skills.steal1.tags).toEqual(['ぬすむ', '物理'])
    expect(again.jobs.thief.conversions).toEqual(m.jobs.thief.conversions)
  })
})
