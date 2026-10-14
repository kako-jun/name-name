import { describe, it, expect } from 'vitest'
import {
  DEFAULTS,
  findReturnLink,
  parseConfig,
  parseConfigText,
  type FieldSampleConfig,
} from './config'
import type { FieldLink } from '../game/fieldWalk'
import teramachiSample from './teramachi.sample.json?raw'

const BASE = 'https://example.com/field/config.json'

/** 1 項目ずつ壊すための、最小の有効設定（毎回新しいオブジェクトを返す） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>
function minimal(): Raw {
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]
  return {
    startScene: 'a',
    start: { x: 10, y: 20 },
    player: {
      sprites: {
        up: frames('up'),
        down: frames('down'),
        left: frames('left'),
        right: frames('right'),
      },
    },
    scenes: {
      a: { background: 'a.png', mask: 'a-mask.png' },
    },
  }
}

/** minimal() を 1 か所だけ変えた設定を作る */
function mutated(fn: (c: Raw) => void): Raw {
  const c = minimal()
  fn(c)
  return c
}

/** 戦闘ありの設定（モンスターとエンカウントを足す） */
function withEncounter(): Raw {
  const c = minimal()
  c.monsters = { slime: { name: 'スライム', hp: 10 } }
  c.scenes.a.encounter = { rate: 5, groups: ['slime'] }
  return c
}

function ok(raw: unknown): FieldSampleConfig {
  const r = parseConfig(raw, BASE)
  if (!r.ok) throw new Error(`ok のはずが失敗: ${r.error}`)
  return r.value
}

describe('parseConfig 正常系 (Issue #807/#809)', () => {
  it('最小設定が ok で既定値が入る', () => {
    const c = ok(minimal())
    expect(c.startScene).toBe('a')
    expect(c.start).toEqual({ x: 10, y: 20 })
    expect(c.speed).toBe(DEFAULTS.speed)
    expect(c.edgeThreshold).toBe(DEFAULTS.edgeThreshold)
    expect(c.player.height).toBe(DEFAULTS.height)
    expect(c.player.frameMs).toBe(DEFAULTS.frameMs)
    expect(c.encounter).toEqual({
      stepDistance: DEFAULTS.stepDistance,
      minSteps: DEFAULTS.minSteps,
    })
    expect(c.battle).toEqual({
      layout: 'side',
      spriteStyle: 'none',
      width: DEFAULTS.battleWidth,
      height: DEFAULTS.battleHeight,
    })
    expect(c.scenes.a.links).toEqual([])
    expect(c.monsters).toEqual({})
  })

  it('同梱のサンプル teramachi.sample.json が ok', () => {
    const r = parseConfigText(teramachiSample, 'http://localhost:8780/teramachi.sample.json')
    if (!r.ok) throw new Error(r.error)
    expect(Object.keys(r.value.scenes).length).toBeGreaterThan(0)
  })

  it('相対 URL は baseUrl を基準に解決される', () => {
    const c = ok(minimal())
    expect(c.scenes.a.background).toBe('https://example.com/field/a.png')
    expect(c.scenes.a.mask).toBe('https://example.com/field/a-mask.png')
    expect(c.player.sprites.up[0]).toBe('https://example.com/field/up1.png')
  })

  it('絶対 URL はそのまま', () => {
    const c = ok(mutated((r) => (r.scenes.a.background = 'https://cdn.example.org/bg.png')))
    expect(c.scenes.a.background).toBe('https://cdn.example.org/bg.png')
  })

  it('assetBaseUrl があると `${base}/images/...` に解決される', () => {
    const c = ok(mutated((r) => (r.assetBaseUrl = 'https://cdn.example.com/game')))
    expect(c.scenes.a.background).toBe('https://cdn.example.com/game/images/a.png')
    expect(c.player.sprites.left[2]).toBe('https://cdn.example.com/game/images/left3.png')
  })

  it('空白だけの assetBaseUrl は無視される', () => {
    const c = ok(mutated((r) => (r.assetBaseUrl = '   ')))
    expect(c.scenes.a.background).toBe('https://example.com/field/a.png')
  })

  it('party 省略で hero が補完される', () => {
    const c = ok(minimal())
    expect(c.party).toHaveLength(1)
    expect(c.party[0].id).toBe('hero')
  })

  it('party が空配列でも hero が補完される', () => {
    const c = ok(mutated((r) => (r.party = [])))
    expect(c.party).toHaveLength(1)
    expect(c.party[0].id).toBe('hero')
  })

  it('party の sprite が URL に解決される', () => {
    const c = ok(
      mutated((r) => (r.party = [{ name: 'ゆうしゃ', hp: 20, sprite: 'hero/pose.png' }]))
    )
    expect(c.party[0].sprite).toBe('https://example.com/field/hero/pose.png')
    expect(c.party[0].name).toBe('ゆうしゃ')
    expect(c.party[0].hp).toBe(20)
    expect(c.party[0].maxHp).toBe(20)
  })

  it('monsters の exp / gold を省略すると 0', () => {
    const c = ok(withEncounter())
    expect(c.monsters.slime.exp).toBe(0)
    expect(c.monsters.slime.gold).toBe(0)
    expect(c.monsters.slime.id).toBe('slime')
  })

  it('encounter 省略のシーンは encounter が null', () => {
    expect(ok(minimal()).scenes.a.encounter).toBeNull()
  })

  it('encounter ありのシーンは rate と groups を持つ', () => {
    expect(ok(withEncounter()).scenes.a.encounter).toEqual({ rate: 5, groups: ['slime'] })
  })

  it('encounter.rate=0 と小数 0.5 は ok、groups が空配列も ok', () => {
    const c0 = ok(mutated((r) => (r.scenes.a.encounter = { rate: 0, groups: [] })))
    expect(c0.scenes.a.encounter?.rate).toBe(0)
    const c05 = ok(mutated((r) => (r.scenes.a.encounter = { rate: 0.5, groups: [] })))
    expect(c05.scenes.a.encounter?.rate).toBe(0.5)
  })

  it('encounter.minSteps=0 は ok', () => {
    const c = ok(mutated((r) => (r.encounter = { minSteps: 0 })))
    expect(c.encounter.minSteps).toBe(0)
  })

  it('range が a==b の link は ok', () => {
    const c = ok(
      mutated((r) => {
        r.scenes.b = { background: 'b.png', mask: 'b-mask.png' }
        r.scenes.a.links = [{ edge: 'right', range: [100, 100], to: 'b' }]
      })
    )
    expect(c.scenes.a.links[0]).toEqual({ edge: 'right', range: [100, 100], to: 'b' })
  })

  it('encounter.background と battle.background は URL に解決される', () => {
    const c = ok(
      mutated((r) => {
        r.scenes.a.encounter = { rate: 0, groups: [], background: 'enc.png' }
        r.battle = { background: 'battle.png', layout: 'front', spriteStyle: 'acrylic' }
      })
    )
    expect(c.scenes.a.encounter?.background).toBe('https://example.com/field/enc.png')
    expect(c.battle.background).toBe('https://example.com/field/battle.png')
    expect(c.battle.layout).toBe('front')
    expect(c.battle.spriteStyle).toBe('acrylic')
  })

  it('groups の `+` 連結で空白付きでも monsters にあれば ok', () => {
    const c = withEncounter()
    c.monsters.ghost = { name: 'ゴースト', hp: 14 }
    c.scenes.a.encounter = { rate: 3, groups: ['slime + ghost'] }
    expect(parseConfig(c, BASE).ok).toBe(true)
  })
})

describe('parseConfig 異常系 (Issue #807/#809)', () => {
  it('JSON 構文エラーは ok=false', () => {
    const r = parseConfigText('{ not json', BASE)
    expect(r.ok).toBe(false)
  })

  it.each([
    ['配列', []],
    ['null', null],
    ['文字列', 'x'],
    ['数値', 3],
  ])('ルートが %s なら不正', (_n, raw) => {
    expect(parseConfig(raw, BASE).ok).toBe(false)
  })

  const bad: [string, (c: Raw) => void][] = [
    ['scenes が空', (c) => (c.scenes = {})],
    ['scenes が配列', (c) => (c.scenes = [])],
    ['scenes が欠落', (c) => delete c.scenes],
    ['startScene が未知', (c) => (c.startScene = 'zzz')],
    ['startScene が非文字列', (c) => (c.startScene = 1)],
    ['startScene が欠落', (c) => delete c.startScene],
    ['start が欠落', (c) => delete c.start],
    ['start.x が非数値', (c) => (c.start.x = 'a')],
    ['start.y が NaN', (c) => (c.start.y = NaN)],
    ['start.x が Infinity', (c) => (c.start.x = Infinity)],
    ['start が文字列', (c) => (c.start = '10,20')],
    ['speed が 0', (c) => (c.speed = 0)],
    ['speed が負', (c) => (c.speed = -1)],
    ['speed が NaN', (c) => (c.speed = NaN)],
    ['speed が文字列', (c) => (c.speed = '260')],
    ['edgeThreshold が 0', (c) => (c.edgeThreshold = 0)],
    ['edgeThreshold が負', (c) => (c.edgeThreshold = -3)],
    ['edgeThreshold が NaN', (c) => (c.edgeThreshold = NaN)],
    ['edgeThreshold が文字列', (c) => (c.edgeThreshold = '6')],
    ['player.height が 0', (c) => (c.player.height = 0)],
    ['player.height が負', (c) => (c.player.height = -1)],
    ['player.height が NaN', (c) => (c.player.height = NaN)],
    ['player.height が文字列', (c) => (c.player.height = '150')],
    ['player.frameMs が 0', (c) => (c.player.frameMs = 0)],
    ['player.frameMs が負', (c) => (c.player.frameMs = -1)],
    ['player.frameMs が NaN', (c) => (c.player.frameMs = NaN)],
    ['player.frameMs が文字列', (c) => (c.player.frameMs = '140')],
    ['player が欠落', (c) => delete c.player],
    ['player.sprites が欠落', (c) => delete c.player.sprites],
    ['sprites.up が配列でない', (c) => (c.player.sprites.up = 'up.png')],
    ['sprites.down が長さ 2', (c) => (c.player.sprites.down = ['a', 'b'])],
    ['sprites.left が長さ 4', (c) => (c.player.sprites.left = ['a', 'b', 'c', 'd'])],
    ['sprites.right が欠落', (c) => delete c.player.sprites.right],
    ['sprites の URL が空文字', (c) => (c.player.sprites.up[1] = '')],
    ['sprites の URL が空白のみ', (c) => (c.player.sprites.up[1] = '   ')],
    ['sprites の URL が非文字列', (c) => (c.player.sprites.up[2] = 5)],
    ['シーンがオブジェクトでない', (c) => (c.scenes.a = 'x')],
    ['シーンが配列', (c) => (c.scenes.a = [])],
    ['background が欠落', (c) => delete c.scenes.a.background],
    ['mask が欠落', (c) => delete c.scenes.a.mask],
    ['background が解決不能な URL', (c) => (c.scenes.a.background = 'http://')],
    ['links が配列でない', (c) => (c.scenes.a.links = {})],
    ['link がオブジェクトでない', (c) => (c.scenes.a.links = ['x'])],
    ['link.edge が不正', (c) => (c.scenes.a.links = [{ edge: 'middle', range: [0, 1], to: 'a' }])],
    ['link.edge が欠落', (c) => (c.scenes.a.links = [{ range: [0, 1], to: 'a' }])],
    ['range が非配列', (c) => (c.scenes.a.links = [{ edge: 'left', range: 5, to: 'a' }])],
    ['range の長さが 1', (c) => (c.scenes.a.links = [{ edge: 'left', range: [5], to: 'a' }])],
    ['range の長さが 3', (c) => (c.scenes.a.links = [{ edge: 'left', range: [1, 2, 3], to: 'a' }])],
    ['range が非数値', (c) => (c.scenes.a.links = [{ edge: 'left', range: ['1', '2'], to: 'a' }])],
    ['range が逆順', (c) => (c.scenes.a.links = [{ edge: 'left', range: [10, 5], to: 'a' }])],
    ['range に NaN', (c) => (c.scenes.a.links = [{ edge: 'left', range: [NaN, 5], to: 'a' }])],
    [
      'range に Infinity',
      (c) => (c.scenes.a.links = [{ edge: 'left', range: [0, Infinity], to: 'a' }]),
    ],
    [
      'link.to が未知のシーン',
      (c) => (c.scenes.a.links = [{ edge: 'left', range: [0, 1], to: 'zzz' }]),
    ],
    ['link.to が欠落', (c) => (c.scenes.a.links = [{ edge: 'left', range: [0, 1] }])],
    ['encounter がオブジェクトでない', (c) => (c.scenes.a.encounter = 5)],
    ['encounter.rate が負', (c) => (c.scenes.a.encounter = { rate: -1, groups: [] })],
    ['encounter.rate が NaN', (c) => (c.scenes.a.encounter = { rate: NaN, groups: [] })],
    ['encounter.rate が文字列', (c) => (c.scenes.a.encounter = { rate: '5', groups: [] })],
    ['encounter.rate が欠落', (c) => (c.scenes.a.encounter = { groups: [] })],
    ['encounter.groups が非配列', (c) => (c.scenes.a.encounter = { rate: 1, groups: 'slime' })],
    ['encounter.groups が欠落', (c) => (c.scenes.a.encounter = { rate: 1 })],
    [
      'encounter.groups に非文字列要素',
      (c) => (c.scenes.a.encounter = { rate: 1, groups: ['slime', 3] }),
    ],
    [
      'encounter.background の URL が不正',
      (c) => (c.scenes.a.encounter = { rate: 0, groups: [], background: '' }),
    ],
    [
      'encounter.background が解決不能',
      (c) => (c.scenes.a.encounter = { rate: 0, groups: [], background: 'http://' }),
    ],
    [
      'groups のモンスター id が monsters に無い',
      (c) => {
        c.monsters = {}
        c.scenes.a.encounter = { rate: 1, groups: ['slime'] }
      },
    ],
    [
      'groups の `+` 連結の途中に未知 id（空白付き）',
      (c) => {
        c.monsters = { slime: { name: 'スライム', hp: 10 } }
        c.scenes.a.encounter = { rate: 1, groups: ['slime + ghost'] }
      },
    ],
    ['encounter（全体）がオブジェクトでない', (c) => (c.encounter = 5)],
    ['encounter.stepDistance が 0', (c) => (c.encounter = { stepDistance: 0 })],
    ['encounter.stepDistance が負', (c) => (c.encounter = { stepDistance: -80 })],
    ['encounter.minSteps が負', (c) => (c.encounter = { minSteps: -1 })],
    ['encounter.minSteps が小数', (c) => (c.encounter = { minSteps: 1.5 })],
    ['encounter.minSteps が文字列', (c) => (c.encounter = { minSteps: '3' })],
    ['monsters がオブジェクトでない', (c) => (c.monsters = [])],
    ['monsters の要素がオブジェクトでない', (c) => (c.monsters = { slime: 'x' })],
    ['monsters の name が欠落', (c) => (c.monsters = { slime: { hp: 10 } })],
    ['monsters の name が空白', (c) => (c.monsters = { slime: { name: '  ', hp: 10 } })],
    ['monsters の hp が欠落', (c) => (c.monsters = { slime: { name: 's' } })],
    ['monsters の hp が負', (c) => (c.monsters = { slime: { name: 's', hp: -1 } })],
    ['monsters の hp が NaN', (c) => (c.monsters = { slime: { name: 's', hp: NaN } })],
    [
      'monsters の sprite が空文字',
      (c) => (c.monsters = { slime: { name: 's', hp: 1, sprite: '' } }),
    ],
    ['party が配列でない', (c) => (c.party = {})],
    ['party の要素の name が欠落', (c) => (c.party = [{ hp: 10 }])],
    ['party の要素の hp が負', (c) => (c.party = [{ name: 'a', hp: -5 }])],
    ['battle がオブジェクトでない', (c) => (c.battle = 'x')],
    ['battle.layout が不正', (c) => (c.battle = { layout: 'diagonal' })],
    ['battle.spriteStyle が不正', (c) => (c.battle = { spriteStyle: 'glass' })],
    ['battle.width が 0', (c) => (c.battle = { width: 0 })],
    ['battle.width が負', (c) => (c.battle = { width: -800 })],
    ['battle.height が 0', (c) => (c.battle = { height: 0 })],
    ['battle.height が負', (c) => (c.battle = { height: -1 })],
    ['battle.background の URL が不正', (c) => (c.battle = { background: '' })],
    ['battle.background が解決不能', (c) => (c.battle = { background: 'http://' })],
  ]

  it.each(bad)('%s なら不正', (_name, fn) => {
    const r = parseConfig(mutated(fn), BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  it('エラーメッセージが原因の項目名を含む（startScene）', () => {
    const r = parseConfig(
      mutated((c) => (c.startScene = 'zzz')),
      BASE
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('startScene')
  })
})

describe('parseConfig プロトタイプキー (B2, Issue #807/#809)', () => {
  it("startScene: 'constructor' は不正", () => {
    expect(
      parseConfig(
        mutated((c) => (c.startScene = 'constructor')),
        BASE
      ).ok
    ).toBe(false)
  })

  it("link の to: 'toString' は不正", () => {
    const c = mutated((r) => {
      r.scenes.a.links = [{ edge: 'left', range: [0, 10], to: 'toString' }]
    })
    expect(parseConfig(c, BASE).ok).toBe(false)
  })

  it("groups の 'constructor' は不正（monsters に無い）", () => {
    const c = mutated((r) => {
      r.monsters = { slime: { name: 'スライム', hp: 10 } }
      r.scenes.a.encounter = { rate: 1, groups: ['constructor'] }
    })
    expect(parseConfig(c, BASE).ok).toBe(false)
  })

  it("groups の `+` 連結の途中の 'toString' も不正", () => {
    const c = mutated((r) => {
      r.monsters = { slime: { name: 'スライム', hp: 10 } }
      r.scenes.a.encounter = { rate: 1, groups: ['slime+toString'] }
    })
    expect(parseConfig(c, BASE).ok).toBe(false)
  })
})

describe('findReturnLink (Issue #807)', () => {
  const toB: FieldLink = { edge: 'right', range: [0, 10], to: 'b' }

  function configOf(scenes: Record<string, FieldLink[]>): FieldSampleConfig {
    const raw = minimal()
    raw.scenes = {}
    for (const [id, links] of Object.entries(scenes)) {
      raw.scenes[id] = { background: `${id}.png`, mask: `${id}-m.png`, links }
    }
    raw.startScene = Object.keys(scenes)[0]
    return ok(raw)
  }

  it('遷移先に戻りリンクがあればそれを返す', () => {
    const back: FieldLink = { edge: 'left', range: [0, 10], to: 'a' }
    const c = configOf({ a: [toB], b: [back] })
    expect(findReturnLink(c, 'a', toB)).toEqual(back)
  })

  it('複数あれば反対側の辺を優先する', () => {
    const same: FieldLink = { edge: 'right', range: [0, 10], to: 'a' }
    const opposite: FieldLink = { edge: 'left', range: [20, 30], to: 'a' }
    const c = configOf({ a: [toB], b: [same, opposite] })
    expect(findReturnLink(c, 'a', toB)).toEqual(opposite)
  })

  it('反対側が無ければ最初の候補を返す', () => {
    const first: FieldLink = { edge: 'top', range: [0, 10], to: 'a' }
    const second: FieldLink = { edge: 'bottom', range: [0, 10], to: 'a' }
    const c = configOf({ a: [toB], b: [first, second] })
    expect(findReturnLink(c, 'a', toB)).toEqual(first)
  })

  it('戻りリンクが無ければ null（別シーンへのリンクしか無い場合も）', () => {
    const other: FieldLink = { edge: 'left', range: [0, 10], to: 'c' }
    const c = configOf({ a: [toB], b: [other], c: [] })
    expect(findReturnLink(c, 'a', toB)).toBeNull()
  })

  it('遷移先シーンが存在しなければ null', () => {
    const c = configOf({ a: [] })
    expect(findReturnLink(c, 'a', { edge: 'right', range: [0, 10], to: 'nowhere' })).toBeNull()
  })

  it('遷移先がプロトタイプキーでも null（hasOwn で守る）', () => {
    const c = configOf({ a: [] })
    expect(findReturnLink(c, 'a', { edge: 'right', range: [0, 10], to: 'constructor' })).toBeNull()
    expect(findReturnLink(c, 'a', { edge: 'right', range: [0, 10], to: 'toString' })).toBeNull()
  })
})
