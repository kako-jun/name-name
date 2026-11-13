import { describe, expect, it } from 'vitest'
import {
  applyBattleExp,
  applyVictoryExp,
  currentExp,
  currentLevel,
  growPartyByExp,
  levelCap,
  levelForExp,
  splitExp,
  spellsForMember,
  type LevelUpDef,
} from './levelUp'
import { buildResultMessages, RESULT_TEXT } from './battleResult'
import { MAX_LEVEL } from './spellDsl'
import { carryOverBattleResult } from '../field/fieldResume'
import type { BattleEntity } from './spellDsl'

const hero = (over: Partial<BattleEntity> = {}): BattleEntity => ({
  id: 'hero',
  name: 'ゆうしゃ',
  hp: 20,
  maxHp: 20,
  mp: 5,
  maxMp: 5,
  atk: 5,
  def: 3,
  agi: 4,
  exp: 0,
  ...over,
})
const def: LevelUpDef = {
  expTable: [10, 30, 70],
  growth: 'hp+5, atk+1',
  learns: [
    { level: 2, spell: 'heal', name: 'ホイミ' },
    { level: 4, spell: 'fire' },
  ],
}

describe('levelUp', () => {
  it('表から Lv を決める。終端で頭打ち', () => {
    expect(levelForExp(def, 0)).toBe(1)
    expect(levelForExp(def, 10)).toBe(2)
    expect(levelForExp(def, 69)).toBe(3)
    expect(levelForExp(def, 9999)).toBe(4)
  })

  it('1 レベル上がると成長が足され、習得を覚える', () => {
    const r = applyBattleExp(hero(), def, 12)
    expect(r.gained).toEqual([2])
    expect(r.member).toMatchObject({ level: 2, exp: 12, maxHp: 25, hp: 25, atk: 6 })
    expect(r.learnedNames).toEqual(['ホイミ'])
  })

  it('複数 Lv が同時に上がる。成長は回数分、習得は越えた分すべて（名前が無ければ id）', () => {
    const r = applyBattleExp(hero(), def, 100)
    expect(r.gained).toEqual([2, 3, 4])
    expect(r.member).toMatchObject({ level: 4, maxHp: 35, atk: 8 })
    expect(r.learnedNames).toEqual(['ホイミ', 'fire'])
  })

  it('上限 Lv では上がらない。表が無い味方・exp 0 は変わらない', () => {
    const top = hero({ level: 4, exp: 70 })
    expect(applyBattleExp(top, def, 50).gained).toEqual([])
    expect(applyBattleExp(top, def, 50).member.level).toBe(4)
    expect(applyBattleExp(hero(), undefined, 50).member).toEqual(hero())
    expect(applyBattleExp(hero(), def, 0).member).toEqual(hero())
  })

  it('初期 Lv が 1 より大きい味方は、その Lv の累計から始まる', () => {
    const r = applyBattleExp(hero(), { ...def, level: 3 }, 40)
    expect(r.gained).toEqual([4])
  })

  it('生存者に等分・端数切り捨て。倒れている味方は変わらない', () => {
    expect(splitExp(10, 3)).toBe(3)
    expect(splitExp(10, 0)).toBe(0)
    const b = hero({ id: 'b', name: 'b' })
    const dead = hero({ id: 'c', name: 'c', hp: 0 })
    const r = applyVictoryExp([hero(), b, dead], { hero: def, b: def, c: def }, 50)
    expect(r.party[0].exp).toBe(25)
    expect(r.party[2]).toBe(dead)
    expect(r.levelUps).toBe(2)
  })

  it('持ち越し: 勝利のときだけ配る。敗北・逃走は変わらない。リザルト文言に差し込む', () => {
    const run = (outcome: string) =>
      carryOverBattleResult<BattleEntity>({
        outcome,
        earnedGold: 0,
        menuItems: [],
        partyAfter: [hero()],
        before: { inventory: {}, gold: 0, party: [hero()] },
        exp: 12,
        grow: growPartyByExp({ hero: def }),
      }).party[0]
    expect(run('victory').level).toBe(2)
    expect(run('defeat').level).toBeUndefined()
    expect(run('escaped').level).toBeUndefined()
    const lv = applyVictoryExp([hero()], { hero: def }, 12)
    expect(
      buildResultMessages({
        gold: 0,
        exp: 12,
        levelUps: lv.levelUps,
        levelLearnedSpellNames: lv.learnedNames,
        learnedSpellNames: [],
        lootNames: [],
      })
    ).toEqual(['戦いに勝った！', '12 けいけんち かくとく', 'レベルアップ', 'ホイミをおぼえた！'])
  })
})

describe('levelUp: 境界値 (#206)', () => {
  it('levelForExp: 表の終端ちょうどで頭打ち・空表は Lv1・1 件だけなら Lv2 まで', () => {
    expect(levelForExp(def, 70)).toBe(4)
    expect(levelForExp({ expTable: [] }, 9999)).toBe(1)
    expect(levelForExp({}, 9999)).toBe(1)
    expect(levelForExp({ expTable: [10] }, 9)).toBe(1)
    expect(levelForExp({ expTable: [10] }, 10)).toBe(2)
    expect(levelForExp({ expTable: [10] }, 99999)).toBe(2)
  })

  it('MAX_LEVEL で頭打ち。表が MAX_LEVEL より長くても超えない', () => {
    const long = { expTable: Array.from({ length: 200 }, (_, i) => (i + 1) * 10) }
    expect(levelForExp(long, 1e9)).toBe(MAX_LEVEL)
    expect(levelCap(long)).toBe(MAX_LEVEL)
    expect(levelCap(def)).toBe(4)
    expect(levelCap({})).toBe(1)
    const r = applyBattleExp(hero(), long, 1e9)
    expect(r.member.level).toBe(MAX_LEVEL)
    expect(r.gained).toHaveLength(MAX_LEVEL - 1)
  })

  it('表が空・無い・1 件のみ', () => {
    expect(applyBattleExp(hero(), { expTable: [] }, 50).member).toEqual(hero())
    expect(applyBattleExp(hero(), { growth: 'hp+5' }, 50).member).toEqual(hero())
    const one = applyBattleExp(hero(), { expTable: [10], growth: 'atk+2' }, 500)
    expect(one.gained).toEqual([2])
    expect(one.member).toMatchObject({ level: 2, exp: 500, atk: 7 })
    // 上限 Lv に着いた後は exp も増えない（何も起きない）わけではなく、exp は積み上がるが Lv は上がらない
    const again = applyBattleExp(one.member, { expTable: [10], growth: 'atk+2' }, 5)
    expect(again.gained).toEqual([])
    expect(again.member).toMatchObject({ level: 2, exp: 505, atk: 7 })
  })

  it('exp が NaN / Infinity / 負数なら変わらない。小数は切り捨て', () => {
    for (const bad of [NaN, Infinity, -Infinity, -5, 0])
      expect(applyBattleExp(hero(), def, bad).member).toEqual(hero())
    expect(applyBattleExp(hero(), def, 9.9).member.exp).toBe(9)
    expect(applyBattleExp(hero(), def, 10.5).member).toMatchObject({ exp: 10, level: 2 })
  })

  it('入力の味方・定義を書き換えない', () => {
    const h = hero()
    const snapshot = JSON.parse(JSON.stringify(h))
    const dSnap = JSON.parse(JSON.stringify(def))
    applyBattleExp(h, def, 100)
    applyVictoryExp([h], { hero: def }, 100)
    expect(h).toEqual(snapshot)
    expect(def).toEqual(dSnap)
  })

  it('level 未設定のとき保存された exp を無視し、定義の初期 Lv の累計から始める', () => {
    // level 無し + exp あり（設定読み込みの 0 など）は「保存値」とみなさない
    const r = applyBattleExp(hero({ exp: 9999 }), def, 5)
    expect(r.member).toMatchObject({ exp: 5, level: 1 })
    expect(r.gained).toEqual([])
    // 初期 Lv 3 なら表の 2 件目 (30) から。exp は level 無しなので無視
    const r3 = applyBattleExp(hero({ exp: 9999 }), { ...def, level: 3 }, 5)
    expect(r3.member).toMatchObject({ exp: 35, level: 3 })
    expect(r3.gained).toEqual([])
    // level が付いていれば保存した exp を使う
    expect(currentExp(hero({ level: 2, exp: 17 }), def)).toBe(17)
    expect(currentExp(hero({ level: 2, exp: NaN }), def)).toBe(10)
    expect(currentExp(hero({ level: 1 }), { ...def, level: 3 })).toBe(0)
  })

  it('currentLevel: 保存 Lv → 初期 Lv → 1。0 以下・小数は丸める', () => {
    expect(currentLevel({ level: 3 }, { ...def, level: 5 })).toBe(3)
    expect(currentLevel({}, { ...def, level: 5 })).toBe(5)
    expect(currentLevel({}, def)).toBe(1)
    expect(currentLevel({}, undefined)).toBe(1)
    expect(currentLevel({ level: 0 })).toBe(1)
    expect(currentLevel({ level: 2.9 })).toBe(2)
  })

  it('保存した Lv が表の上限より高くても下げない', () => {
    const r = applyBattleExp(hero({ level: 50, exp: 0 }), def, 100)
    expect(r.member.level).toBe(50)
    expect(r.gained).toEqual([])
    expect(r.learnedNames).toEqual([])
  })

  it('初期 Lv が上限を超える定義でも壊れない（Lv は下がらず exp だけ積む）', () => {
    const r = applyBattleExp(hero(), { ...def, level: 50 }, 10)
    expect(r.member.level).toBe(50)
    expect(r.gained).toEqual([])
  })
})

describe('levelUp: 成長 (#206)', () => {
  it('負の成長でも hp / atk は下限を割らない（hp 1・atk 0）', () => {
    const weak = hero({ hp: 3, maxHp: 4, atk: 1, def: 0, mp: 1, maxMp: 1 })
    const r = applyBattleExp(
      weak,
      { expTable: [1, 2], growth: 'hp-5, atk-3, def-1, mp-9, agi-10' },
      10
    )
    expect(r.gained).toEqual([2, 3])
    expect(r.member).toMatchObject({ maxHp: 1, hp: 1, atk: 0, def: 0, maxMp: 0, mp: 0, agi: 0 })
  })

  it('読めない項目は無視して読める項目だけ効く。空・未指定・全部読めないなら能力値は変わらない', () => {
    const mixed = applyBattleExp(hero(), { expTable: [1], growth: 'foo+3, atk+2, hp' }, 5)
    expect(mixed.member).toMatchObject({ atk: 7, maxHp: 20, level: 2 })
    for (const g of [undefined, '', '   ', 'zzz', 'hp+', '+5']) {
      const r = applyBattleExp(hero(), { expTable: [1], growth: g }, 5)
      expect(r.gained).toEqual([2])
      expect(r.member).toMatchObject({
        maxHp: 20,
        hp: 20,
        atk: 5,
        def: 3,
        agi: 4,
        maxMp: 5,
        level: 2,
      })
    }
  })

  it('全角カンマ・読点・日本語名の成長も読む', () => {
    const r = applyBattleExp(hero(), { expTable: [1], growth: '攻撃+2，守備+1、素早さ+3' }, 5)
    expect(r.member).toMatchObject({ atk: 7, def: 4, agi: 7 })
  })

  it('hp が減っていても成長分だけ増える（全回復はしない）。MP も同様', () => {
    const r = applyBattleExp(hero({ hp: 4, mp: 0 }), { expTable: [1], growth: 'hp+5, mp+3' }, 5)
    expect(r.member).toMatchObject({ hp: 9, maxHp: 25, mp: 3, maxMp: 8 })
  })

  it('同時に複数 Lv 上がって習得も同時に出る。越えた分すべて・Lv 順・既に覚えた Lv は出ない', () => {
    const d: LevelUpDef = {
      expTable: [10, 20, 30, 40],
      growth: 'hp+2',
      learns: [
        { level: 5, spell: 'late', name: 'おそい' },
        { level: 2, spell: 'a', name: 'エー' },
        { level: 3, spell: 'b' },
        { level: 1, spell: 'init' },
      ],
    }
    const r = applyBattleExp(hero({ level: 2, exp: 10 }), d, 1000)
    expect(r.gained).toEqual([3, 4, 5])
    expect(r.member.maxHp).toBe(26)
    // Lv2 以下は既習。3,5 だけ。Lv 順
    expect(r.learnedNames).toEqual(['b', 'おそい'])
  })

  it('習得の表示名は spellNames を優先し、プロトタイプのキー名は引かない', () => {
    const d: LevelUpDef = {
      expTable: [1],
      learns: [
        { level: 2, spell: 'fire', name: 'ほのお' },
        { level: 2, spell: 'toString' },
      ],
    }
    const r = applyBattleExp(hero(), d, 5, { spellNames: { fire: 'ファイア' } })
    expect(r.learnedNames).toEqual(['ファイア', 'toString'])
  })
})

describe('levelUp: 等分 (#206)', () => {
  const a = (id: string, over: Partial<BattleEntity> = {}) => hero({ id, name: id, ...over })

  it('splitExp: 不正値は 0', () => {
    expect(splitExp(NaN, 2)).toBe(0)
    expect(splitExp(-10, 2)).toBe(0)
    expect(splitExp(10, -1)).toBe(0)
    expect(splitExp(1, 2)).toBe(0)
    expect(splitExp(7, 2)).toBe(3)
  })

  it('生存者 0 人: 誰も変わらず levelUps 0', () => {
    const party = [a('hero', { hp: 0 }), a('b', { hp: 0 })]
    const r = applyVictoryExp(party, { hero: def, b: def }, 1000)
    expect(r.party).toEqual(party)
    expect(r.levelUps).toBe(0)
    expect(r.learnedNames).toEqual([])
  })

  it('端数切り捨てで 0 になるときは誰も変わらない', () => {
    const party = [a('hero'), a('b'), a('c')]
    const r = applyVictoryExp(party, { hero: def, b: def, c: def }, 2)
    expect(r.party.map((m) => m.exp)).toEqual([0, 0, 0])
    expect(r.party.map((m) => m.level)).toEqual([undefined, undefined, undefined])
  })

  it('倒れた味方は分母に入らず、定義の無い生存者の分は配られるだけ（他へ回さない）', () => {
    const party = [a('hero'), a('nodef'), a('dead', { hp: 0 })]
    const r = applyVictoryExp(party, { hero: def, dead: def }, 100)
    // 生存者 2 人 → 50 ずつ。nodef は定義が無く何も起きず、dead は倒れているので変わらない
    expect(r.party[0].exp).toBe(50)
    expect(r.party[1]).toBe(party[1])
    expect(r.party[2]).toBe(party[2])
  })

  it('入力順を保つ・習得名は味方の並び順・levelUps は上がった人数', () => {
    const d2: LevelUpDef = { expTable: [10], learns: [{ level: 2, spell: 'x', name: 'エックス' }] }
    const d3: LevelUpDef = { expTable: [1000] }
    const party = [a('p1'), a('p2'), a('p3')]
    const r = applyVictoryExp(party, { p1: def, p2: d3, p3: d2 }, 60)
    expect(r.party.map((m) => m.id)).toEqual(['p1', 'p2', 'p3'])
    expect(r.levelUps).toBe(2)
    expect(r.learnedNames).toEqual(['ホイミ', 'エックス'])
  })

  it('defs が Object.prototype のキー名の id でも引かない', () => {
    const party = [a('toString')]
    const r = applyVictoryExp(party, {}, 100)
    expect(r.party[0]).toBe(party[0])
  })

  it('経験値 0 / 負数の勝利は何も変わらない', () => {
    const party = [a('hero')]
    expect(applyVictoryExp(party, { hero: def }, 0).party[0]).toBe(party[0])
    expect(applyVictoryExp(party, { hero: def }, -50).party[0]).toBe(party[0])
  })
})

describe('levelUp: 戦闘ごとの動作 (#206)', () => {
  const carry = (outcome: string, party: BattleEntity[], exp: number, defs = { hero: def }) =>
    carryOverBattleResult<BattleEntity>({
      outcome,
      earnedGold: 0,
      menuItems: [],
      partyAfter: party,
      before: { inventory: {}, gold: 0, party: [hero()] },
      exp,
      grow: (p, e) => applyVictoryExp(p, defs, e).party,
    }).party

  it('敗北・逃走では exp も Lv も変わらない。victory のみ配る', () => {
    expect(carry('defeat', [hero()], 999)[0]).toEqual(hero())
    expect(carry('escaped', [hero({ hp: 7 })], 999)[0]).toEqual(hero({ hp: 7 }))
    expect(carry('victory', [hero({ hp: 7 })], 999)[0]).toMatchObject({ level: 4, exp: 999 })
  })

  it('victory でも exp 0 / grow 無しなら配らない', () => {
    expect(carry('victory', [hero()], 0)[0]).toEqual(hero())
    const noGrow = carryOverBattleResult<BattleEntity>({
      outcome: 'victory',
      earnedGold: 0,
      menuItems: [],
      partyAfter: [hero()],
      before: { inventory: {}, gold: 0, party: [hero()] },
      exp: 999,
    }).party
    expect(noGrow[0]).toEqual(hero())
  })

  it('敗北では戦闘後の Lv・exp を捨てて戦闘前の Lv・exp に戻る（grow も呼ばれない）', () => {
    const lv2 = hero({ level: 2, exp: 12 })
    const r = carryOverBattleResult<BattleEntity>({
      outcome: 'defeat',
      earnedGold: 0,
      menuItems: [],
      partyAfter: [hero({ level: 4, exp: 999 })],
      before: { inventory: {}, gold: 0, party: [lv2] },
      exp: 999,
      grow: growPartyByExp({ hero: def }),
    })
    expect(r.party[0]).toEqual(lv2)
  })

  it('脚本制御戦闘(partial)で参戦した生存者にも等分される（partyAfter に居る生存者全員が分母）', () => {
    // 脚本で途中参戦した味方は partyAfter に入る。合流・離脱した後の「いま戦場にいる生存者」で割る
    const joined = hero({ id: 'guest', name: 'guest' })
    const out = carry('victory', [hero(), joined, hero({ id: 'down', hp: 0 })], 100, {
      hero: def,
      guest: def,
      down: def,
    } as never)
    expect(out.map((m) => m.exp)).toEqual([50, 50, 0])
    expect(out[2].hp).toBe(0)
  })

  it('表示（BattleScreen 側）と確定（carryOver）が同じ入力で一致する', () => {
    const party = [
      hero(),
      hero({ id: 'b', name: 'b', level: 2, exp: 15 }),
      hero({ id: 'c', hp: 0 }),
    ]
    const defs = { hero: def, b: { ...def, learns: [{ level: 3, spell: 'ice', name: 'こおり' }] } }
    const shown = applyVictoryExp(party, defs, 80, { spellNames: {} })
    const committed = carryOverBattleResult<BattleEntity>({
      outcome: 'victory',
      earnedGold: 0,
      menuItems: [],
      partyAfter: party,
      before: { inventory: {}, gold: 0, party },
      exp: 80,
      grow: (p, e) => applyVictoryExp(p, defs, e).party,
    }).party
    expect(committed).toEqual(shown.party)
    // 表示した人数・習得は確定した結果の Lv 差と一致
    const ups = committed.filter((m, i) => (m.level ?? 1) > (party[i].level ?? 1)).length
    expect(shown.levelUps).toBe(ups)
    expect(shown.learnedNames).toEqual(['ホイミ', 'こおり'])
  })
})

describe('levelUp: リザルト文言の順序 (#206)', () => {
  const base = { gold: 0, exp: 0, learnedSpellNames: [] as string[], lootNames: [] as string[] }

  it('exp 行の直後にレベルアップ、続いて習得、ラーニングより先、戦利品が最後', () => {
    const m = buildResultMessages({
      gold: 5,
      exp: 20,
      levelUps: 2,
      levelLearnedSpellNames: ['ホイミ'],
      learnedSpellNames: ['ラーニング技'],
      lootNames: ['ポーション'],
    })
    expect(m).toEqual([
      RESULT_TEXT.victory,
      RESULT_TEXT.gold(5),
      RESULT_TEXT.exp(20),
      RESULT_TEXT.levelUp,
      RESULT_TEXT.levelUp,
      RESULT_TEXT.learned('ホイミ'),
      RESULT_TEXT.learned('ラーニング技'),
      RESULT_TEXT.loot('ポーション'),
    ])
  })

  it('levelUps 0 / 省略なら従来どおり。exp 0 でもレベルアップ行は出る（来ることは無いが並びは保つ）', () => {
    expect(buildResultMessages({ ...base, exp: 3 })).toEqual([
      RESULT_TEXT.victory,
      RESULT_TEXT.exp(3),
    ])
    expect(buildResultMessages({ ...base, exp: 3, levelUps: 0 })).toEqual([
      RESULT_TEXT.victory,
      RESULT_TEXT.exp(3),
    ])
    expect(RESULT_TEXT.levelUp).toBe('レベルアップ')
    expect(RESULT_TEXT.levelUp).not.toContain('　')
  })

  it('実際の配分結果から作る: 2 人上がり、習得は Lv 順、ラーニング無し', () => {
    const lv = applyVictoryExp([hero(), hero({ id: 'b', name: 'b' })], { hero: def, b: def }, 200)
    const m = buildResultMessages({
      ...base,
      exp: 200,
      levelUps: lv.levelUps,
      levelLearnedSpellNames: lv.learnedNames,
    })
    expect(m).toEqual([
      RESULT_TEXT.victory,
      RESULT_TEXT.exp(200),
      'レベルアップ',
      'レベルアップ',
      'ホイミをおぼえた！',
      'fireをおぼえた！',
      'ホイミをおぼえた！',
      'fireをおぼえた！',
    ])
  })
})

describe('spellsForMember (#1161)', () => {
  const spells = [{ id: 'fire' }, { id: 'cure' }, { id: 'bolt' }, { id: 'free' }]
  const defs: Record<string, LevelUpDef> = {
    a: {
      level: 1,
      expTable: [10],
      learns: [
        { level: 1, spell: 'fire' },
        { level: 3, spell: 'bolt' },
      ],
    },
    b: { level: 1, expTable: [10], learns: [{ level: 2, spell: 'cure' }] },
  }
  const ids = (l: { id: string }[]) => l.map((x) => x.id)
  it('習得 Lv 未満では並ばず、保存した Lv に達すると並ぶ', () => {
    expect(ids(spellsForMember(spells, defs, 'a', 1))).toEqual(['fire', 'free'])
    expect(ids(spellsForMember(spells, defs, 'a', 3))).toEqual(['fire', 'bolt', 'free'])
  })
  it('味方ごとに自分の習得だけ。Lv 未設定は初期 Lv', () => {
    expect(ids(spellsForMember(spells, defs, 'b', undefined))).toEqual(['free'])
    expect(ids(spellsForMember(spells, defs, 'b', 2))).toEqual(['cure', 'free'])
  })
  it('経験値表の無い味方は従来どおり初期 Lv の和集合、定義が無ければ全部', () => {
    expect(ids(spellsForMember(spells, defs, 'z', 9))).toEqual(['fire', 'free'])
    expect(ids(spellsForMember(spells, {}, 'a', 1))).toEqual(['fire', 'cure', 'bolt', 'free'])
  })
})
