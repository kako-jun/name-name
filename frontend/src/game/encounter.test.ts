import { describe, it, expect, vi } from 'vitest'
import { rollEncounter } from './RaycastRenderer'
import type { MonsterDef } from '../types'

const slime: MonsterDef = {
  id: 'slime',
  name: 'スライム',
  hp: 10,
  mp: 0,
  atk: 3,
  def: 1,
  agi: 2,
  exp: 2,
  gold: 1,
}

const ghost: MonsterDef = {
  id: 'ghost',
  name: 'ゴースト',
  hp: 14,
  mp: 0,
  atk: 5,
  def: 2,
  agi: 6,
  exp: 4,
  gold: 3,
}

describe('rollEncounter: poses を BattleEntity に写す (#745)', () => {
  it('モンスター定義の poses を正規化して写す。未指定は poses なし', () => {
    const withPoses: MonsterDef = {
      ...slime,
      poses: { idle: 'm/i.png', Down: 'm/d.png', bogus: 'x.png' },
    }
    const input = {
      rate: 1,
      groups: ['slime+ghost'],
      masters: { slime: withPoses, ghost },
      rng: () => 0,
    }
    const [a, b] = rollEncounter(input)!
    expect(a.poses).toEqual({ idle: 'm/i.png', down: 'm/d.png' })
    expect('poses' in b).toBe(false)
  })
})

describe('rollEncounter (Issue #172)', () => {
  it('rate=0 で常に null（街・室内）', () => {
    expect(
      rollEncounter({
        rate: 0,
        groups: ['slime'],
        masters: { slime },
        rng: () => 0,
      })
    ).toBeNull()
  })

  it('groups 空で常に null', () => {
    expect(
      rollEncounter({
        rate: 1,
        groups: [],
        masters: { slime },
        rng: () => 0,
      })
    ).toBeNull()
  })

  it('rate=1 で毎歩確実発火（rng=0 でも発火）', () => {
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(1)
    expect(enemies![0].id).toBe('slime')
  })

  it('rate=16 で rng>=1/16 ならハズレ', () => {
    expect(
      rollEncounter({
        rate: 16,
        groups: ['slime'],
        masters: { slime },
        rng: () => 0.5,
      })
    ).toBeNull()
  })

  it('rate=16 で rng<1/16 なら当選', () => {
    const enemies = rollEncounter({
      rate: 16,
      groups: ['slime'],
      masters: { slime },
      rng: () => 0.01,
    })
    expect(enemies).not.toBeNull()
  })

  it('複合グループ "slime+ghost" で 2 体パーティ', () => {
    let i = 0
    const rngs = [0, 0] // 1回目: roll <1/1 で当選、2回目: groups[0] 選択
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime+ghost'],
      masters: { slime, ghost },
      rng: () => rngs[i++ % rngs.length],
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(2)
    expect(enemies!.map((e) => e.id)).toEqual(['slime', 'ghost'])
  })

  it('未定義 ID は warning + スキップ', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['unknown_monster'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // own-property ルックアップ修正の確認（#368）。id が Object.prototype のプロパティ名と
  // 一致しても「未定義 ID」と同じ warning + スキップ扱いになる（関数オブジェクトを敵として
  // 組み立てない）。
  it('修正確認: id が "constructor" でも未定義 ID と同じ warning + スキップになる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['constructor'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each(['toString', 'valueOf', '__proto__'])(
    '修正確認: id "%s" でも未定義 ID と同じ扱いになる',
    (name) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const enemies = rollEncounter({
        rate: 1,
        groups: [name],
        masters: { slime },
        rng: () => 0,
      })
      expect(enemies).toBeNull()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    }
  )

  it('複合グループ: 実在idとconstructorを混ぜてもconstructor以外で戦闘成立する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime+constructor'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(1)
    expect(enemies![0].id).toBe('slime')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('own-key regression: masters に own の "constructor" キーがあれば正しく敵を組み立てる', () => {
    const constructorMonster: MonsterDef = {
      id: 'constructor',
      name: 'コンストラクター',
      hp: 20,
      mp: 0,
      atk: 4,
      def: 2,
      agi: 3,
      exp: 5,
      gold: 2,
    }
    const enemies = rollEncounter({
      rate: 1,
      groups: ['constructor'],
      masters: { constructor: constructorMonster },
      rng: () => 0,
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(1)
    expect(enemies![0].id).toBe('constructor')
    expect(enemies![0].name).toBe('コンストラクター')
  })

  it('複合グループの一部が未定義でも残りで戦闘', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime+unknown'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(1)
    expect(enemies![0].id).toBe('slime')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('複数 groups から rng 値で重み均等選択', () => {
    let i = 0
    // 1回目: 抽選当選 (0.0 < 1/1), 2回目: groups[2] 選択 (0.99 * 3 = 2.97 → floor=2)
    const rngs = [0, 0.99]
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime', 'ghost', 'slime+ghost'],
      masters: { slime, ghost },
      rng: () => rngs[i++ % rngs.length],
    })
    expect(enemies).not.toBeNull()
    expect(enemies!.length).toBe(2) // 'slime+ghost' = 2 体
  })

  it('生成された BattleEntity は maxHp/maxMp が hp/mp と同値で full 状態', () => {
    const enemies = rollEncounter({
      rate: 1,
      groups: ['slime'],
      masters: { slime },
      rng: () => 0,
    })
    expect(enemies![0].hp).toBe(slime.hp)
    expect(enemies![0].maxHp).toBe(slime.hp)
    expect(enemies![0].mp).toBe(slime.mp)
    expect(enemies![0].maxMp).toBe(slime.mp)
    expect(enemies![0].exp).toBe(slime.exp)
    expect(enemies![0].gold).toBe(slime.gold)
  })
})

describe('rollEncounter: sprite の写し (#736)', () => {
  const roll = (groups: string[], masters: Record<string, MonsterDef>) =>
    rollEncounter({ rate: 1, groups, masters, rng: () => 0 })

  it('MonsterDef.sprite を指定すると BattleEntity.sprite に写る', () => {
    const enemies = roll(['slime'], { slime: { ...slime, sprite: 'monsters/slime.webp' } })
    expect(enemies![0].sprite).toBe('monsters/slime.webp')
  })

  it('MonsterDef.sprite 未指定なら BattleEntity.sprite は undefined', () => {
    const enemies = roll(['slime'], { slime })
    expect(enemies![0].sprite).toBeUndefined()
  })

  it('複数体の組では各体の sprite が個別に写る', () => {
    const enemies = roll(['slime+ghost'], {
      slime: { ...slime, sprite: 'm/slime.webp' },
      ghost: { ...ghost, sprite: 'm/ghost.webp' },
    })
    expect(enemies!.map((e) => e.sprite)).toEqual(['m/slime.webp', 'm/ghost.webp'])
  })

  it('片方だけ sprite 指定の組でも取り違えない', () => {
    const enemies = roll(['slime+ghost'], {
      slime,
      ghost: { ...ghost, sprite: 'm/ghost.webp' },
    })
    expect(enemies!.map((e) => e.sprite)).toEqual([undefined, 'm/ghost.webp'])
  })
})

describe('rollEncounter: actions を BattleEntity に写す (#835)', () => {
  it('モンスター定義の actions（生文字列）を複製して写す。未指定・空は actions なし', () => {
    const actions = ['条件=初手 候補=墨', '候補=こうげき']
    const input = {
      rate: 1,
      groups: ['slime+ghost+slime'],
      masters: { slime: { ...slime, actions }, ghost: { ...ghost, actions: [] } },
      rng: () => 0,
    }
    const [a, b] = rollEncounter(input)!
    expect(a.actions).toEqual(actions)
    expect(a.actions).not.toBe(actions)
    expect('actions' in b).toBe(false)
  })
})

describe('rollEncounter: サイズ・倍率・配置を BattleEntity.layout に写す (#839 段3)', () => {
  const roll = (groups: string[], masters: Record<string, MonsterDef>) =>
    rollEncounter({ rate: 1, groups, masters, rng: () => 0 })

  it('サイズ・倍率・配置のどれも無い敵は layout なし（従来どおり）', () => {
    const enemies = roll(['slime+ghost'], { slime, ghost })!
    for (const e of enemies) expect('layout' in e).toBe(false)
  })

  it('size だけ → 倍率 1。scale だけ → 1x1。両方 → そのまま', () => {
    const enemies = roll(['slime+ghost+slime'], {
      slime: { ...slime, size: { w: 2, h: 1 } },
      ghost: { ...ghost, scale: 0.5 },
    })!
    expect(enemies[0].layout).toEqual({ w: 2, h: 1, scale: 1 })
    expect(enemies[1].layout).toEqual({ w: 1, h: 1, scale: 0.5 })
    expect(enemies[2].layout).toEqual({ w: 2, h: 1, scale: 1 })
    const both = roll(['slime'], { slime: { ...slime, size: { w: 2, h: 2 }, scale: 0.75 } })!
    expect(both[0].layout).toEqual({ w: 2, h: 2, scale: 0.75 })
  })

  it('群の配置指定 @C1 は個数の先頭 1 体の layout.at に載る（サイズ未指定でも 1x1 の layout が付く）', () => {
    const enemies = roll(['slime*2@C1+ghost'], {
      slime: { ...slime, size: { w: 2, h: 2 } },
      ghost,
    })!
    expect(enemies.map((e) => e.id)).toEqual(['slime', 'slime', 'ghost'])
    expect(enemies[0].layout).toEqual({ w: 2, h: 2, scale: 1, at: { col: 2, row: 0 } })
    expect(enemies[1].layout).toEqual({ w: 2, h: 2, scale: 1 })
    expect('layout' in enemies[2]).toBe(false)
    const atOnly = roll(['ghost@A2'], { ghost })!
    expect(atOnly[0].layout).toEqual({ w: 1, h: 1, scale: 1, at: { col: 0, row: 1 } })
  })

  it('layout は定義と別物（敵の書き換えがマスターを汚さない）', () => {
    const size = { w: 2, h: 1 }
    const [e] = roll(['slime@C1'], { slime: { ...slime, size } })!
    e.layout!.w = 9
    expect(size.w).toBe(2)
    // 群の解析結果の at とも参照を共有しない（別の戦闘へ持ち越さない）
    const [e2, e3] = [roll(['slime@C1'], { slime })![0], roll(['slime@C1'], { slime })![0]]
    e2.layout!.at!.col = 9
    expect(e3.layout!.at).toEqual({ col: 2, row: 0 })
  })
})
