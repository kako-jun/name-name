import { describe, it, expect } from 'vitest'
import type { BattleEntity } from '../game/spellDsl'
import debuggerGuide from '../../../docs/guide/debugger.md?raw'
import {
  DEFAULT_RESOLUTION_MODE,
  DEFAULT_SIZE_ID,
  MAX_ENEMIES,
  MAX_PARTY,
  SAMPLE_DEFAULT_PERSPECTIVE,
  SCREEN_SIZES,
  applyFormation,
  buildBattleSetup,
  defaultConfig,
  defaultEnemies,
  defaultParty,
  describeView,
  effectivePartyCount,
  extractConfigUrl,
  initialView,
  parseConfig,
  parseConfigText,
  pushView,
  resolveResolution,
  resolveSize,
  resolveUrl,
  swapView,
  viewsEqual,
  type BattleSampleConfig,
  type BattleSampleView,
  type BlinkHistory,
  type ScreenSizeId,
} from './config'

const BASE = 'https://example.com/dir/config.json'

function view(over: Partial<BattleSampleView> = {}): BattleSampleView {
  return {
    layout: 'side',
    spriteStyle: 'none',
    windowStyle: 'dark',
    backgroundTone: 'on',
    backgroundDof: 'off',
    logTypewriter: 'off',
    atb: 'off',
    atbMode: 'wait',
    backgroundOn: false,
    depth: 'off',
    foregroundOn: false,
    formation: 'config',
    partyCount: 4,
    enemyCount: 4,
    sizeId: '800x450',
    resolutionMode: 'main',
    ...over,
  }
}

/** party[0] を 1 件だけ指定して parse し、その結果の味方 0 番を返す */
function parseParty0(entity: Record<string, unknown>, base = BASE) {
  const r = parseConfig({ party: [entity] }, base)
  if (!r.ok) throw new Error(r.error)
  return r.value.party[0]
}

function parseOk(raw: unknown, base = BASE): BattleSampleConfig {
  const r = parseConfig(raw, base)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

function parseErr(raw: unknown, base = BASE): string {
  const r = parseConfig(raw, base)
  if (r.ok) throw new Error('エラーになるはずが ok')
  return r.error
}

describe('仕様固定値', () => {
  it('SCREEN_SIZES は 4 種で順序も固定', () => {
    expect(SCREEN_SIZES.map((s) => ({ ...s }))).toEqual([
      { id: '360x640', width: 360, height: 640 },
      { id: '800x450', width: 800, height: 450 },
      { id: '1280x720', width: 1280, height: 720 },
      { id: '640x360', width: 640, height: 360 },
    ])
  })

  it('各サイズの id は 幅x高さ と一致する', () => {
    for (const s of SCREEN_SIZES) expect(s.id).toBe(`${s.width}x${s.height}`)
  })

  it('既定サイズ id は 800x450', () => {
    expect(DEFAULT_SIZE_ID).toBe('800x450')
  })

  it('味方・敵の最大数は 4', () => {
    expect(MAX_PARTY).toBe(4)
    expect(MAX_ENEMIES).toBe(4)
  })

  it('既定の味方名', () => {
    expect(defaultParty().map((e) => e.name)).toEqual([
      'ゆうしゃ',
      'まほうつかい',
      'そうりょ',
      'せんし',
    ])
  })

  it('既定の敵名', () => {
    expect(defaultEnemies().map((e) => e.name)).toEqual([
      'スライム',
      'ドラキー',
      'ゴースト',
      'ドラゴン',
    ])
  })

  it('既定 id は party1..4 / enemy1..4 で全体ユニーク', () => {
    const ids = [...defaultParty(), ...defaultEnemies()].map((e) => e.id)
    expect(ids).toEqual([
      'party1',
      'party2',
      'party3',
      'party4',
      'enemy1',
      'enemy2',
      'enemy3',
      'enemy4',
    ])
    expect(new Set(ids).size).toBe(8)
  })

  it('既定の hp は maxHp 以下で sprite は未設定', () => {
    for (const e of [...defaultParty(), ...defaultEnemies()]) {
      expect(e.hp).toBeLessThanOrEqual(e.maxHp)
      expect(e.sprite).toBeUndefined()
      expect('sprite' in e).toBe(false)
    }
  })

  it('defaultParty() は呼ぶたびに別オブジェクト', () => {
    const a = defaultParty()
    const b = defaultParty()
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
    a[0].hp = 1
    expect(b[0].hp).toBe(30)
  })

  it('defaultConfig() は side / none / 背景なし', () => {
    const c = defaultConfig()
    expect(c.layout).toBe('side')
    expect(c.spriteStyle).toBe('none')
    expect(c.background).toBeNull()
    expect(c.party).toHaveLength(4)
    expect(c.enemies).toHaveLength(4)
  })

  it("defaultConfig() の windowStyle は 'dark'", () => {
    expect(defaultConfig().windowStyle).toBe('dark')
  })
})

describe('resolveUrl', () => {
  it('相対 URL を基準 URL から解決する', () => {
    expect(resolveUrl('a.png', BASE)).toBe('https://example.com/dir/a.png')
  })

  it('../ を解決する', () => {
    expect(resolveUrl('../a.png', BASE)).toBe('https://example.com/a.png')
  })

  it('絶対 URL はそのまま', () => {
    expect(resolveUrl('https://cdn.example.org/x.png', BASE)).toBe('https://cdn.example.org/x.png')
  })

  it('/ 始まりはオリジン直下', () => {
    expect(resolveUrl('/a.png', BASE)).toBe('https://example.com/a.png')
  })

  it('// 始まりはスキームを引き継ぐ', () => {
    expect(resolveUrl('//cdn/a.png', BASE)).toBe('https://cdn/a.png')
  })

  it('基準 URL が不正で相対指定なら null', () => {
    expect(resolveUrl('a.png', 'not a url')).toBeNull()
  })

  it('日本語パスは % エンコードされる', () => {
    expect(resolveUrl('画像/背.png', BASE)).toBe(
      'https://example.com/dir/%E7%94%BB%E5%83%8F/%E8%83%8C.png'
    )
  })
})

describe('extractConfigUrl', () => {
  it('?config=x.json を基準 URL で解決する', () => {
    expect(extractConfigUrl('?config=x.json', BASE)).toBe('https://example.com/dir/x.json')
  })

  it('config パラメータがなければ null', () => {
    expect(extractConfigUrl('?other=1', BASE)).toBeNull()
  })

  it('?config= （空）なら null', () => {
    expect(extractConfigUrl('?config=', BASE)).toBeNull()
  })

  it('?config=%20%20（空白のみ）なら null', () => {
    expect(extractConfigUrl('?config=%20%20', BASE)).toBeNull()
  })

  it('config が複数あれば先頭を使う', () => {
    expect(extractConfigUrl('?config=a.json&config=b.json', BASE)).toBe(
      'https://example.com/dir/a.json'
    )
  })

  it('他のパラメータが混在していても取り出せる', () => {
    expect(extractConfigUrl('?x=1&config=c.json&y=2', BASE)).toBe('https://example.com/dir/c.json')
  })

  it('search が空文字なら null', () => {
    expect(extractConfigUrl('', BASE)).toBeNull()
  })

  it('%2F はデコードされてパス区切りになる', () => {
    expect(extractConfigUrl('?config=a%2Fb.json', BASE)).toBe('https://example.com/dir/a/b.json')
  })
})

describe('parseConfig ルートと enum', () => {
  it.each([
    ['null', null],
    ['配列', []],
    ['文字列', 'x'],
    ['数値', 1],
  ])('ルートが %s ならエラー', (_label, raw) => {
    expect(parseErr(raw)).toContain('ルートはオブジェクト')
  })

  it('{} は defaultConfig と同値', () => {
    expect(parseOk({})).toEqual(defaultConfig())
  })

  it.each(['front', 'side'])('layout=%s を受理する', (layout) => {
    expect(parseOk({ layout }).layout).toBe(layout)
  })

  it.each([
    ['大文字違い', 'Front', '"Front"'],
    ['空文字', '', '""'],
    ['数値', 1, '1'],
    ['null', null, 'null'],
  ])('layout が不正（%s）ならエラーで、値が JSON 形式で文中に出る', (_l, v, shown) => {
    expect(parseErr({ layout: v })).toContain(`layout は "front" か "side": ${shown}`)
  })

  it.each(['none', 'acrylic'])('spriteStyle=%s を受理する', (spriteStyle) => {
    expect(parseOk({ spriteStyle }).spriteStyle).toBe(spriteStyle)
  })

  it.each([
    ['大文字違い', 'Acrylic', '"Acrylic"'],
    ['空文字', '', '""'],
    ['数値', 2, '2'],
    ['null', null, 'null'],
  ])('spriteStyle が不正（%s）ならエラーで、値が JSON 形式で文中に出る', (_l, v, shown) => {
    expect(parseErr({ spriteStyle: v })).toContain(`spriteStyle は "none" か "acrylic": ${shown}`)
  })

  it.each(['dark', 'ff-blue'])('windowStyle=%s を受理する', (windowStyle) => {
    expect(parseOk({ windowStyle }).windowStyle).toBe(windowStyle)
  })

  it("windowStyle 未指定は 'dark'", () => {
    expect(parseOk({}).windowStyle).toBe('dark')
    expect(parseOk({ windowStyle: undefined }).windowStyle).toBe('dark')
  })

  it.each([
    ['大文字違い Dark', 'Dark', '"Dark"'],
    ['大文字違い FF-BLUE', 'FF-BLUE', '"FF-BLUE"'],
    ['空文字', '', '""'],
    ['未知値', 'xxx', '"xxx"'],
    ['null', null, 'null'],
    ['数値', 1, '1'],
    ['真偽値', true, 'true'],
    ['オブジェクト', {}, '{}'],
    ['配列', [], '[]'],
  ])('windowStyle が不正（%s）ならエラーで、値が JSON 形式で文中に出る', (_l, v, shown) => {
    expect(parseErr({ windowStyle: v })).toContain(`windowStyle は "dark" か "ff-blue": ${shown}`)
  })
})

describe('parseConfig background', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空文字', ''],
  ])('background が %s なら背景なし', (_l, v) => {
    expect(parseOk({ background: v }).background).toBeNull()
  })

  it('background が空白のみなら背景なし（基準 URL に解決されない）', () => {
    expect(parseOk({ background: '   ' }).background).toBeNull()
  })

  it('background が数値ならエラー', () => {
    expect(parseErr({ background: 1 })).toContain('background は URL 文字列')
  })

  it('background がオブジェクトならエラー', () => {
    expect(parseErr({ background: {} })).toContain('background は URL 文字列')
  })

  it('相対 URL は絶対化される', () => {
    expect(parseOk({ background: 'bg.png' }).background).toBe('https://example.com/dir/bg.png')
  })

  it('前後の空白は trim される', () => {
    expect(parseOk({ background: '  bg.png  ' }).background).toBe('https://example.com/dir/bg.png')
  })

  it('解決できない URL はエラー', () => {
    expect(parseErr({ background: 'bg.png' }, 'not a url')).toContain(
      'background の URL を解決できません'
    )
  })
})

describe('parseConfig エンティティの HP', () => {
  // [maxHp 入力, hp 入力, 期待 maxHp, 期待 hp]（party[0] の既定 maxHp は 30）
  it.each([
    [undefined, undefined, 30, 30],
    [undefined, 20, 20, 20],
    [undefined, 0, 1, 0],
    [undefined, -5, 1, 0],
    [50, undefined, 50, 50],
    [50, 20, 50, 20],
    [50, 60, 50, 50],
    [0, undefined, 1, 1],
    [0, 5, 1, 1],
    ['50', 20, 20, 20],
    [NaN, 20, 20, 20],
    [Infinity, 20, 20, 20],
    [50, NaN, 50, 50],
  ])('maxHp=%s hp=%s -> maxHp=%s hp=%s', (maxHp, hp, expMax, expHp) => {
    const e = parseParty0({ maxHp, hp })
    expect(e.maxHp).toBe(expMax)
    expect(e.hp).toBe(expHp)
  })
})

describe('parseConfig エンティティの MP', () => {
  // [maxMp 入力, mp 入力, 期待 maxMp, 期待 mp]（party[0] の既定 maxMp は 12）
  it.each([
    [undefined, undefined, 12, 12],
    [undefined, 5, 5, 5],
    [10, undefined, 10, 10],
    [10, 4, 10, 4],
    [10, 20, 10, 10],
    [0, 5, 0, 0],
    [10, -3, 10, 0],
    [-4, undefined, 0, 0],
    [undefined, -2, 0, 0],
    ['10', 3, 3, 3],
    [NaN, 3, 3, 3],
  ])('maxMp=%s mp=%s -> maxMp=%s mp=%s', (maxMp, mp, expMax, expMp) => {
    const e = parseParty0({ maxMp, mp })
    expect(e.maxMp).toBe(expMax)
    expect(e.mp).toBe(expMp)
  })
})

describe('parseConfig エンティティのその他', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [1, 1],
  ])('atk=%s は %s（下限 0）', (atk, exp) => {
    expect(parseParty0({ atk }).atk).toBe(exp)
  })

  it('def / agi も -1 は 0、1 は 1', () => {
    expect(parseParty0({ def: -1, agi: -1 })).toMatchObject({ def: 0, agi: 0 })
    expect(parseParty0({ def: 1, agi: 1 })).toMatchObject({ def: 1, agi: 1 })
  })

  it('atk が文字列なら既定値（8）に戻る', () => {
    expect(parseParty0({ atk: '99' }).atk).toBe(8)
  })

  it('def / agi 未指定は既定値（4 / 5）', () => {
    expect(parseParty0({})).toMatchObject({ def: 4, agi: 5 })
  })

  it('余分なキーは出力に漏れない', () => {
    const e = parseParty0({ secret: 'x', foo: 1 })
    expect('secret' in e).toBe(false)
    expect('foo' in e).toBe(false)
  })

  it('敵の exp / gold は入力でなく既定から引き継ぐ（現状固定）', () => {
    const c = parseOk({ enemies: [{ exp: 99, gold: 99 }] })
    expect(c.enemies[0].exp).toBe(5)
    expect(c.enemies[0].gold).toBe(3)
  })

  it('name が数値ならエラー', () => {
    expect(parseErr({ party: [{ name: 1 }] })).toContain('party[0].name は文字列')
  })

  it('name が空文字なら既定名', () => {
    expect(parseParty0({ name: '' }).name).toBe('ゆうしゃ')
  })

  it('name が全角スペースのみならそのまま採用（現状固定）', () => {
    expect(parseParty0({ name: '　' }).name).toBe('　')
  })

  it('日本語・絵文字の name はそのまま保持', () => {
    expect(parseParty0({ name: 'アリス🐱' }).name).toBe('アリス🐱')
  })

  it('id が空文字なら既定 id', () => {
    expect(parseParty0({ id: '' }).id).toBe('party1')
  })

  it('id が数値なら既定 id', () => {
    expect(parseParty0({ id: 5 }).id).toBe('party1')
  })

  it('sprite が数値ならエラー', () => {
    expect(parseErr({ party: [{ sprite: 1 }] })).toContain('party[0].sprite は文字列')
  })

  it('sprite が空文字なら sprite キーなし', () => {
    expect('sprite' in parseParty0({ sprite: '' })).toBe(false)
  })

  it('sprite が空白のみなら sprite キーなし', () => {
    expect('sprite' in parseParty0({ sprite: '  ' })).toBe(false)
  })

  it('sprite の相対 URL は絶対化される', () => {
    expect(parseParty0({ sprite: 'p.png' }).sprite).toBe('https://example.com/dir/p.png')
  })

  it('sprite が解決できなければ party[1].sprite 形式の path 付きエラー', () => {
    const err = parseErr({ party: [{}, { sprite: 'p.png' }] }, 'not a url')
    expect(err).toContain('party[1].sprite の URL を解決できません')
  })

  it('enemies 側のエラー path は enemies[i]', () => {
    expect(parseErr({ enemies: [1] })).toContain('enemies[0] はオブジェクト')
  })
})

describe('parseConfig 配列', () => {
  it('party 未指定なら既定の味方', () => {
    expect(parseOk({}).party).toEqual(defaultParty())
  })

  it('enemies 未指定なら既定の敵', () => {
    expect(parseOk({}).enemies).toEqual(defaultEnemies())
  })

  it('party が配列でなければエラー', () => {
    expect(parseErr({ party: {} })).toContain('party は配列')
  })

  it('party が空配列ならエラー', () => {
    expect(parseErr({ party: [] })).toContain('party は 1 件以上')
  })

  it('要素がオブジェクトでなければ path key[i] 付きでエラー', () => {
    expect(parseErr({ party: [{}, 'x'] })).toContain('party[1] はオブジェクト')
  })

  it('4 件は 4 件のまま', () => {
    expect(parseOk({ party: [{}, {}, {}, {}] }).party).toHaveLength(4)
  })

  it('5 件は先頭 4 件に切り詰める', () => {
    const c = parseOk({ party: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] })
    expect(c.party.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it.each([
    [3, 3],
    [4, 4],
    [5, 4],
  ])('party %s 件 -> %s 件', (n, exp) => {
    expect(parseOk({ party: Array.from({ length: n }, () => ({})) }).party).toHaveLength(exp)
  })

  it('enemies も 5 件は 4 件に切り詰める', () => {
    expect(parseOk({ enemies: [{}, {}, {}, {}, {}] }).enemies).toHaveLength(4)
  })

  it('id が重複したら 2 件目以降に -{index} が付く', () => {
    const c = parseOk({ party: [{ id: 'x' }, { id: 'x' }] })
    expect(c.party.map((e) => e.id)).toEqual(['x', 'x-1'])
  })

  it('id 省略なら party1, party2 が既定から振られる', () => {
    expect(parseOk({ party: [{}, {}] }).party.map((e) => e.id)).toEqual(['party1', 'party2'])
  })

  it('既定 id と同じ id を明示すると重複として -{index} が付く', () => {
    expect(parseOk({ party: [{}, { id: 'party1' }] }).party.map((e) => e.id)).toEqual([
      'party1',
      'party1-1',
    ])
  })

  it('重複 id の連鎖でも全 id がユニーク', () => {
    const c = parseOk({ party: [{ id: 'a' }, { id: 'a' }, { id: 'a-1' }] })
    expect(c.party.map((e) => e.id)).toEqual(['a', 'a-1', 'a-1-2'])
  })

  it('要素 2 件のとき 2 件目の補完は defaults[1]', () => {
    const c = parseOk({ party: [{}, {}] })
    expect(c.party[1].name).toBe('まほうつかい')
    expect(c.party[1].maxHp).toBe(30)
  })

  it('敵は 2 件目の補完が defaults[1]（ドラキー）', () => {
    const c = parseOk({ enemies: [{}, {}] })
    expect(c.enemies[1].name).toBe('ドラキー')
    expect(c.enemies[1].maxHp).toBe(30)
  })

  it('5 件目が不正でもエラーにならない（切り捨てるだけ。現状固定）', () => {
    const r = parseConfig({ party: [{}, {}, {}, {}, 'broken'] }, BASE)
    expect(r.ok).toBe(true)
  })

  it('party が不正なら enemies を見ずに party のエラーを返す', () => {
    const err = parseErr({ party: 'x', enemies: 'y' })
    expect(err).toContain('party は配列')
    expect(err).not.toContain('enemies')
  })
})

describe('parseConfigText', () => {
  it('正しい JSON は ok', () => {
    const r = parseConfigText('{"layout":"front"}', BASE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.layout).toBe('front')
  })

  it('壊れた JSON は ok:false で「JSON として読めません」', () => {
    const r = parseConfigText('{', BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON として読めません')
  })

  it('空文字は ok:false', () => {
    expect(parseConfigText('', BASE).ok).toBe(false)
  })

  it('"null" はルートエラー', () => {
    const r = parseConfigText('null', BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ルートはオブジェクト')
  })
})

describe('docs/guide/debugger.md の設定例', () => {
  it('JSON 例が parseConfigText を通り、件数と背景の絶対化が docs の記述どおり', () => {
    const md = debuggerGuide
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
    const sample = blocks.find((b) => b.includes('"spriteStyle"'))
    expect(sample).toBeDefined()
    const r = parseConfigText(sample as string, 'https://example.com/cfg/battle.json')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.layout).toBe('side')
    expect(r.value.spriteStyle).toBe('acrylic')
    expect(r.value.background).toBe('https://example.com/cfg/battle/background.png')
    expect(r.value.party).toHaveLength(2)
    expect(r.value.enemies).toHaveLength(1)
  })
})

describe('initialView / resolveSize', () => {
  it('background があれば backgroundOn=true', () => {
    const c = { ...defaultConfig(), background: 'https://example.com/b.png' }
    expect(initialView(c).backgroundOn).toBe(true)
  })

  it('background がなければ backgroundOn=false', () => {
    expect(initialView(defaultConfig()).backgroundOn).toBe(false)
  })

  it('partyCount / enemyCount は配列長', () => {
    const c = parseOk({ party: [{}, {}], enemies: [{}] })
    const v = initialView(c)
    expect(v.partyCount).toBe(2)
    expect(v.enemyCount).toBe(1)
  })

  it('sizeId は 800x450、layout / spriteStyle は設定から', () => {
    const v = initialView(parseOk({ layout: 'front', spriteStyle: 'acrylic' }))
    expect(v.sizeId).toBe('800x450')
    expect(v.layout).toBe('front')
    expect(v.spriteStyle).toBe('acrylic')
  })

  it('initialView の windowStyle は設定から（既定は dark）', () => {
    expect(initialView(parseOk({ windowStyle: 'ff-blue' })).windowStyle).toBe('ff-blue')
    expect(initialView(defaultConfig()).windowStyle).toBe('dark')
  })

  it.each([
    ['360x640', 360, 640],
    ['800x450', 800, 450],
    ['1280x720', 1280, 720],
    ['640x360', 640, 360],
  ] as const)('resolveSize(%s) は %sx%s', (id, w, h) => {
    expect(resolveSize(id)).toEqual({ width: w, height: h })
  })

  it('未知 id は 800x450 に戻る', () => {
    expect(resolveSize('999x999' as ScreenSizeId)).toEqual({ width: 800, height: 450 })
  })
})

describe('buildBattleSetup', () => {
  const BG = 'https://example.com/b.png'

  it.each([
    [true, BG, true],
    [true, null, false],
    [false, BG, false],
    [false, null, false],
  ])(
    'backgroundOn=%s config.background=%s のとき options.background キーあり=%s',
    (on, bg, has) => {
      const s = buildBattleSetup({ ...defaultConfig(), background: bg }, view({ backgroundOn: on }))
      expect('background' in s.options).toBe(has)
      if (has) expect(s.options.background).toBe(BG)
    }
  )

  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 4],
    [99, 4],
  ])('partyCount=%s は味方 %s 件', (n, exp) => {
    expect(buildBattleSetup(defaultConfig(), view({ partyCount: n })).party).toHaveLength(exp)
  })

  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 4],
    [99, 4],
  ])('enemyCount=%s は敵 %s 件', (n, exp) => {
    expect(buildBattleSetup(defaultConfig(), view({ enemyCount: n })).enemies).toHaveLength(exp)
  })

  it('config が 2 件で 4 件要求なら補完 id は party-extra3 / party-extra4', () => {
    const c = parseOk({ party: [{ id: 'a' }, { id: 'b' }] })
    const s = buildBattleSetup(c, view({ partyCount: 4 }))
    expect(s.party.map((e) => e.id)).toEqual(['a', 'b', 'party-extra3', 'party-extra4'])
  })

  it('敵の補完 id は enemy-extra2', () => {
    const c = parseOk({ enemies: [{ id: 'e' }] })
    const s = buildBattleSetup(c, view({ enemyCount: 2 }))
    expect(s.enemies.map((e) => e.id)).toEqual(['e', 'enemy-extra2'])
  })

  it('補完内容は defaultParty()[i % 4] と id 以外一致', () => {
    const c = parseOk({ party: [{ id: 'a' }, { id: 'b' }] })
    const s = buildBattleSetup(c, view({ partyCount: 4 }))
    expect(s.party[2]).toEqual({ ...defaultParty()[2], id: 'party-extra3' })
    expect(s.party[3]).toEqual({ ...defaultParty()[3], id: 'party-extra4' })
  })

  it('補完を含めても id はユニーク', () => {
    const c = parseOk({ party: [{ id: 'a' }] })
    const ids = buildBattleSetup(c, view({ partyCount: 4 })).party.map((e) => e.id)
    expect(new Set(ids).size).toBe(4)
  })

  it('返却を書き換えても config は変わらない', () => {
    const c = defaultConfig()
    const s = buildBattleSetup(c, view())
    s.party[0].hp = 1
    s.enemies[0].hp = 1
    expect(c.party[0].hp).toBe(30)
    expect(c.enemies[0].hp).toBe(20)
  })

  it('同一 config で 2 回呼んでも返却は独立', () => {
    const c = defaultConfig()
    const a = buildBattleSetup(c, view())
    const b = buildBattleSetup(c, view())
    expect(a.party[0]).not.toBe(b.party[0])
    a.party[0].hp = 1
    expect(b.party[0].hp).toBe(30)
  })

  it('layout / spriteStyle は view から反映される（config ではなく）', () => {
    const c = { ...defaultConfig(), layout: 'side' as const, spriteStyle: 'none' as const }
    const s = buildBattleSetup(c, view({ layout: 'front', spriteStyle: 'acrylic' }))
    expect(s.options.layout).toBe('front')
    expect(s.options.spriteStyle).toBe('acrylic')
  })

  it('windowStyle は view から反映される（config ではなく）', () => {
    const c = { ...defaultConfig(), windowStyle: 'dark' as const }
    expect(buildBattleSetup(c, view({ windowStyle: 'ff-blue' })).options.windowStyle).toBe(
      'ff-blue'
    )
    const c2 = { ...defaultConfig(), windowStyle: 'ff-blue' as const }
    expect(buildBattleSetup(c2, view({ windowStyle: 'dark' })).options.windowStyle).toBe('dark')
  })

  it.each([
    ['360x640', 360, 640],
    ['800x450', 800, 450],
    ['1280x720', 1280, 720],
    ['640x360', 640, 360],
  ] as const)('sizeId=%s は幅%s 高さ%s', (sizeId, w, h) => {
    const s = buildBattleSetup(defaultConfig(), view({ sizeId }))
    expect(s.width).toBe(w)
    expect(s.height).toBe(h)
  })

  it('sprite 付きエンティティは複製後も sprite を保持', () => {
    const c = parseOk({ party: [{ sprite: 'p.png' }] })
    const s = buildBattleSetup(c, view({ partyCount: 1 }))
    expect(s.party[0].sprite).toBe('https://example.com/dir/p.png')
  })
})

describe('viewsEqual', () => {
  it('front では partyCount だけ違っても同一扱い', () => {
    expect(
      viewsEqual(view({ layout: 'front', partyCount: 1 }), view({ layout: 'front', partyCount: 3 }))
    ).toBe(true)
  })

  it('side では partyCount が違えば別扱い', () => {
    expect(
      viewsEqual(view({ layout: 'side', partyCount: 1 }), view({ layout: 'side', partyCount: 3 }))
    ).toBe(false)
  })

  it('全フィールド同一なら true', () => {
    expect(viewsEqual(view(), view())).toBe(true)
  })

  it('windowStyle も含めて同一なら true', () => {
    expect(viewsEqual(view({ windowStyle: 'ff-blue' }), view({ windowStyle: 'ff-blue' }))).toBe(
      true
    )
  })

  it.each([
    ['layout', { layout: 'front' }],
    ['spriteStyle', { spriteStyle: 'acrylic' }],
    ['windowStyle', { windowStyle: 'ff-blue' }],
    ['logTypewriter', { logTypewriter: 'on' }],
    ['backgroundOn', { backgroundOn: true }],
    ['partyCount', { partyCount: 3 }],
    ['enemyCount', { enemyCount: 3 }],
    ['sizeId', { sizeId: '360x640' }],
    ['resolutionMode', { resolutionMode: 'dpr' }],
  ] as [string, Partial<BattleSampleView>][])('%s だけ違えば false', (_k, over) => {
    expect(viewsEqual(view(), view(over))).toBe(false)
  })
})

describe('pushView / swapView', () => {
  const A = view({ layout: 'side' })
  const B = view({ layout: 'front' })
  const C = view({ layout: 'front', spriteStyle: 'acrylic' })

  it('異なる view を push すると current=新, previous=旧', () => {
    const h = pushView({ current: A, previous: null }, B)
    expect(h.current).toBe(B)
    expect(h.previous).toBe(A)
  })

  it('同一内容を push すると同一参照を返す', () => {
    const h: BlinkHistory = { current: A, previous: null }
    expect(pushView(h, view())).toBe(h)
  })

  it('A→B→C と push すると current=C, previous=B', () => {
    const h = pushView(pushView({ current: A, previous: null }, B), C)
    expect(h.current).toBe(C)
    expect(h.previous).toBe(B)
  })

  it('previous が null の swap は同一参照を返す', () => {
    const h: BlinkHistory = { current: A, previous: null }
    expect(swapView(h)).toBe(h)
  })

  it('swap は current と previous を入れ替える', () => {
    const h = swapView({ current: B, previous: A })
    expect(h.current).toBe(A)
    expect(h.previous).toBe(B)
  })

  it('swap を 2 回で元に戻る', () => {
    const h = swapView(swapView({ current: B, previous: A }))
    expect(h.current).toBe(B)
    expect(h.previous).toBe(A)
  })

  it('cur=B, prev=A で A を push すると cur=A, prev=B', () => {
    const h = pushView({ current: B, previous: A }, A)
    expect(h.current).toBe(A)
    expect(h.previous).toBe(B)
  })

  it('freeze 済みの履歴・view でも例外なく動く', () => {
    const fa = Object.freeze({ ...A })
    const fb = Object.freeze({ ...B })
    const h = Object.freeze({ current: fa, previous: fb })
    expect(() => swapView(h)).not.toThrow()
    expect(() => pushView(h, C)).not.toThrow()
  })

  it('windowStyle だけ違う view を push すると履歴に積まれる', () => {
    const dark = view()
    const blue = view({ windowStyle: 'ff-blue' })
    const h = pushView({ current: dark, previous: null }, blue)
    expect(h.current).toBe(blue)
    expect(h.previous).toBe(dark)
  })

  it('windowStyle が同じ view を push しても積まれない', () => {
    const h: BlinkHistory = { current: view({ windowStyle: 'ff-blue' }), previous: null }
    expect(pushView(h, view({ windowStyle: 'ff-blue' }))).toBe(h)
  })

  it('windowStyle の違う 2 view を swap で往復できる', () => {
    const dark = view()
    const blue = view({ windowStyle: 'ff-blue' })
    const h1 = swapView({ current: blue, previous: dark })
    expect(h1.current.windowStyle).toBe('dark')
    expect(h1.previous?.windowStyle).toBe('ff-blue')
    const h2 = swapView(h1)
    expect(h2.current.windowStyle).toBe('ff-blue')
    expect(h2.previous?.windowStyle).toBe('dark')
  })
})

describe('describeView', () => {
  it('ff-blue 版の完全一致文字列', () => {
    expect(
      describeView(view({ sizeId: '360x640', windowStyle: 'ff-blue' }), 2, {
        width: 360,
        height: 640,
      })
    ).toBe(
      'layout=side  spriteStyle=none  windowStyle=ff-blue  backgroundTone=on  backgroundDof=off  logTypewriter=off  background=off  depth=off  foreground=off  formation=config  party=4  enemies=4  size=360x640  logical=360x640  DPR=2  physical=720x1280'
    )
  })

  it('DPR=2・360x640 の完全一致文字列', () => {
    expect(describeView(view({ sizeId: '360x640' }), 2, { width: 360, height: 640 })).toBe(
      'layout=side  spriteStyle=none  windowStyle=dark  backgroundTone=on  backgroundDof=off  logTypewriter=off  background=off  depth=off  foreground=off  formation=config  party=4  enemies=4  size=360x640  logical=360x640  DPR=2  physical=720x1280'
    )
  })

  it('backgroundOn=true は background=on 表記', () => {
    expect(describeView(view({ backgroundOn: true }), 1, { width: 800, height: 450 })).toContain(
      'background=on'
    )
  })

  it('backgroundOn=false は background=off 表記', () => {
    expect(describeView(view(), 1, { width: 800, height: 450 })).toContain('background=off')
  })

  it('DPR=1.5 の物理サイズは 540x960', () => {
    expect(describeView(view(), 1.5, { width: 360, height: 640 })).toContain('physical=540x960')
  })

  it('丸め境界 0.5×801=400.5 は 401（Math.round）', () => {
    expect(describeView(view(), 0.5, { width: 801, height: 450 })).toContain('physical=401x225')
  })

  it('DPR=1 では論理サイズ = 物理サイズ', () => {
    const s = describeView(view(), 1, { width: 1280, height: 720 })
    expect(s).toContain('logical=1280x720')
    expect(s).toContain('physical=1280x720')
  })
})

describe('解像度モード (S2)', () => {
  it('既定は本編相当 (main)', () => {
    expect(DEFAULT_RESOLUTION_MODE).toBe('main')
    expect(initialView(defaultConfig()).resolutionMode).toBe('main')
  })

  it.each([
    ['main', 2, 1],
    ['main', 1.5, 1],
    ['dpr', 2, 2],
    ['dpr', 1.5, 1.5],
    ['dpr', 0, 1],
    ['dpr', NaN, 1],
  ] as const)('mode=%s DPR=%s は resolution=%s', (mode, dpr, exp) => {
    expect(resolveResolution(mode, dpr)).toBe(exp)
  })

  it('describeView は DPR と renderer.resolution を併記し、physical は resolution 基準', () => {
    const s = describeView(view({ resolutionMode: 'main' }), 2, { width: 360, height: 640 }, 1)
    expect(s).toContain('DPR=2')
    expect(s).toContain('resolution=main(renderer.resolution=1)')
    expect(s).toContain('physical=360x640')
  })

  it('describeView dpr モードは physical が DPR 倍', () => {
    const s = describeView(view({ resolutionMode: 'dpr' }), 2, { width: 360, height: 640 }, 2)
    expect(s).toContain('resolution=dpr(renderer.resolution=2)')
    expect(s).toContain('physical=720x1280')
  })
})

describe('front は味方 1 人 (N2)', () => {
  it.each([1, 2, 3, 4])('layout=front は partyCount=%s でも 1', (n) => {
    expect(effectivePartyCount(view({ layout: 'front', partyCount: n }))).toBe(1)
    expect(
      buildBattleSetup(defaultConfig(), view({ layout: 'front', partyCount: n })).party
    ).toHaveLength(1)
  })

  it('front の味方は設定の先頭 1 人', () => {
    const c = parseConfig({ party: [{ id: 'hero1' }, { id: 'x2' }] }, BASE)
    if (!c.ok) throw new Error(c.error)
    const s = buildBattleSetup(c.value, view({ layout: 'front', partyCount: 2 }))
    expect(s.party.map((e) => e.id)).toEqual(['hero1'])
  })

  it('side は選択どおり', () => {
    expect(effectivePartyCount(view({ layout: 'side', partyCount: 3 }))).toBe(3)
    expect(effectivePartyCount(view({ layout: 'side', partyCount: 9 }))).toBe(4)
  })

  it('describeView の party= は実効人数', () => {
    expect(
      describeView(view({ layout: 'front', partyCount: 4 }), 1, { width: 1, height: 1 })
    ).toContain('party=1 ')
  })
})

describe('backgroundTone (#753)', () => {
  const base = 'http://localhost/'
  it("既定は 'on'。on/off を受理し、不正値はエラー", () => {
    expect(defaultConfig().backgroundTone).toBe('on')
    for (const v of ['on', 'off'] as const) {
      const r = parseConfig({ backgroundTone: v }, base)
      expect(r.ok && r.value.backgroundTone).toBe(v)
    }
    const bad = parseConfig({ backgroundTone: 'x' }, base)
    expect(bad.ok).toBe(false)
  })
  it('view から options に反映され、viewsEqual / describeView に含まれる', () => {
    const v = initialView(defaultConfig())
    const off = { ...v, backgroundTone: 'off' as const }
    expect(buildBattleSetup(defaultConfig(), off).options.backgroundTone).toBe('off')
    expect(viewsEqual(v, off)).toBe(false)
    expect(describeView(off, 1, { width: 800, height: 450 })).toContain('backgroundTone=off')
  })
})

describe('backgroundDof (#753)', () => {
  const base = 'http://localhost/'
  it("既定は 'off'。on/off を受理し、不正値はエラー", () => {
    expect(defaultConfig().backgroundDof).toBe('off')
    for (const v of ['on', 'off'] as const) {
      const r = parseConfig({ backgroundDof: v }, base)
      expect(r.ok && r.value.backgroundDof).toBe(v)
    }
    expect(parseConfig({ backgroundDof: 'x' }, base).ok).toBe(false)
  })
  it('view から options に反映され、viewsEqual / describeView に含まれ、彩度明度と独立', () => {
    const v = initialView(defaultConfig())
    const on = { ...v, backgroundDof: 'on' as const }
    expect(buildBattleSetup(defaultConfig(), on).options.backgroundDof).toBe('on')
    expect(buildBattleSetup(defaultConfig(), on).options.backgroundTone).toBe('on')
    expect(viewsEqual(v, on)).toBe(false)
    expect(describeView(on, 1, { width: 800, height: 450 })).toContain('backgroundDof=on')
  })
})

describe('backgroundTone / backgroundDof: 追加の観点 (#753)', () => {
  it.each(['backgroundTone', 'backgroundDof'] as const)(
    '%s の不正値エラーにキー名が含まれる',
    (key) => {
      const r = parseConfig({ [key]: 'foo' }, BASE)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(key)
    }
  )

  it.each([
    { tone: 'off', dof: 'on' },
    { tone: 'on', dof: 'off' },
  ] as const)(
    '背景なしでも buildBattleSetup は tone=$tone / dof=$dof を options に素通しする',
    ({ tone, dof }) => {
      const s = buildBattleSetup(
        defaultConfig(),
        view({ backgroundOn: false, backgroundTone: tone, backgroundDof: dof })
      )
      expect(s.options.background).toBeUndefined()
      expect(s.options.backgroundTone).toBe(tone)
      expect(s.options.backgroundDof).toBe(dof)
    }
  )
})

describe('logTypewriter (#755)', () => {
  it('既定 off。on/off を受け付け、他はエラー', () => {
    expect(defaultConfig().logTypewriter).toBe('off')
    for (const v of ['on', 'off'] as const) {
      const r = parseConfig({ logTypewriter: v }, BASE)
      expect(r.ok && r.value.logTypewriter).toBe(v)
    }
    expect(parseConfig({ logTypewriter: 'x' }, BASE).ok).toBe(false)
  })

  it('view / setup / viewsEqual / describeView に反映される', () => {
    const on = { ...view(), logTypewriter: 'on' as const }
    expect(buildBattleSetup(defaultConfig(), on).options.logTypewriter).toBe('on')
    expect(viewsEqual(view(), on)).toBe(false)
    expect(describeView(on, 1, { width: 800, height: 450 })).toContain('logTypewriter=on')
  })
})

describe('logTypewriter: 追加の観点 (#755 QA)', () => {
  it('不正値エラーにキー名が含まれる', () => {
    const r = parseConfig({ logTypewriter: 'foo' }, BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('logTypewriter')
  })

  it.each([null, '', 'ON', true, 1, 0])('不正値 %j はエラー（off に黙って倒さない）', (v) => {
    expect(parseConfig({ logTypewriter: v }, BASE).ok).toBe(false)
  })

  it('未指定なら既定 off', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok && r.value.logTypewriter).toBe('off')
  })

  it('initialView は config の値を引き継ぐ', () => {
    const r = parseConfig({ logTypewriter: 'on' }, BASE)
    expect(r.ok && initialView(r.value).logTypewriter).toBe('on')
  })

  it('背景なしでも buildBattleSetup は logTypewriter を options に素通しする（on / off）', () => {
    for (const v of ['on', 'off'] as const) {
      const s = buildBattleSetup(defaultConfig(), view({ backgroundOn: false, logTypewriter: v }))
      expect(s.options.logTypewriter).toBe(v)
    }
  })

  it('describeView は on / off を出し分ける', () => {
    const size = { width: 800, height: 450 }
    expect(describeView(view({ logTypewriter: 'on' }), 1, size)).toContain('logTypewriter=on')
    expect(describeView(view({ logTypewriter: 'off' }), 1, size)).toContain('logTypewriter=off')
  })
})

describe('parseConfig horizon / perspective (#747)', () => {
  it('horizon / perspective 未指定は既定値（0.3 / 0.8）', () => {
    const c = parseOk({})
    expect(c.horizon).toBe(0.3)
    expect(c.perspective).toBe(0.8)
  })
  it('SAMPLE_DEFAULT_PERSPECTIVE は 0.8', () => {
    expect(SAMPLE_DEFAULT_PERSPECTIVE).toBe(0.8)
  })
  it.each(['horizon', 'perspective'] as const)('%s: -0.001 はエラー', (key) => {
    expect(parseErr({ [key]: -0.001 })).toContain(`${key} は 0〜1 の数値`)
  })
  it.each(['horizon', 'perspective'] as const)('%s: 0 は有効', (key) => {
    expect(parseOk({ [key]: 0 })[key]).toBe(0)
  })
  it.each(['horizon', 'perspective'] as const)('%s: 1 は有効', (key) => {
    expect(parseOk({ [key]: 1 })[key]).toBe(1)
  })
  it.each(['horizon', 'perspective'] as const)('%s: 1.001 はエラー', (key) => {
    expect(parseErr({ [key]: 1.001 })).toContain(`${key} は 0〜1 の数値`)
  })
  it.each(['horizon', 'perspective'] as const)('%s: 文字列 "0.5" はエラー', (key) => {
    expect(parseErr({ [key]: '0.5' })).toContain(`${key} は 0〜1 の数値`)
  })
  it.each(['horizon', 'perspective'] as const)('%s: null はエラー', (key) => {
    expect(parseErr({ [key]: null })).toContain(`${key} は 0〜1 の数値`)
  })
  it.each(['horizon', 'perspective'] as const)('%s: NaN / Infinity はエラー', (key) => {
    expect(parseErr({ [key]: NaN })).toContain(key)
    expect(parseErr({ [key]: Infinity })).toContain(key)
  })
})

describe('parseConfig party[].row (#747)', () => {
  it("'back' は row: back", () => {
    expect(parseParty0({ row: 'back' }).row).toBe('back')
  })
  it("'後衛' は row: back", () => {
    expect(parseParty0({ row: '後衛' }).row).toBe('back')
  })
  it("'front' は row キーなし", () => {
    expect('row' in parseParty0({ row: 'front' })).toBe(false)
  })
  it("'foo' は row キーなし", () => {
    expect('row' in parseParty0({ row: 'foo' })).toBe(false)
  })
  it('row 未指定は row キーなし', () => {
    expect('row' in parseParty0({})).toBe(false)
  })
  it('row が数値ならエラー', () => {
    expect(parseErr({ party: [{ row: 1 }] })).toContain('party[0].row は "front" か "back"')
  })
  it('row が null ならエラー', () => {
    expect(parseErr({ party: [{ row: null }] })).toContain('party[0].row は "front" か "back"')
  })
  it('row が配列ならエラー', () => {
    expect(parseErr({ party: [{ row: ['back'] }] })).toContain('party[0].row')
  })
})

describe('parseConfig foreground (#747)', () => {
  it.each([
    ['未指定', undefined],
    ['null', null],
    ['空文字', ''],
    ['空白のみ', '   '],
  ])('foreground が %s なら前景なし', (_l, v) => {
    expect(parseOk({ foreground: v }).foreground).toBeNull()
  })
  it('相対 URL は絶対化される', () => {
    expect(parseOk({ foreground: 'fg.png' }).foreground).toBe('https://example.com/dir/fg.png')
  })
  it('数値ならエラー', () => {
    expect(parseErr({ foreground: 1 })).toContain('foreground は URL 文字列')
  })
  it('解決できない URL はエラー', () => {
    expect(parseErr({ foreground: 'fg.png' }, 'not a url')).toContain(
      'foreground の URL を解決できません'
    )
  })
})

describe('applyFormation (#747)', () => {
  const mk = (n: number, rowIdx: number[] = []): BattleEntity[] =>
    defaultParty()
      .slice(0, n)
      .map((p, i) => (rowIdx.includes(i) ? { ...p, row: 'back' as const } : p))
  const backIdx = (list: BattleEntity[]) => list.flatMap((p, i) => (p.row === 'back' ? [i] : []))

  it('config: 設定の row をそのまま保つ', () => {
    expect(backIdx(applyFormation(mk(4, [1, 3]), 'config'))).toEqual([1, 3])
  })
  it('front: 全員 row キーなし', () => {
    const out = applyFormation(mk(4, [1, 3]), 'front')
    expect(out.some((p) => 'row' in p)).toBe(false)
  })
  it.each([
    [1, []],
    [2, [1]],
    [3, [2]],
    [4, [2, 3]],
  ])('backHalf: %s 人 → 後衛 index %j', (n, idx) => {
    expect(backIdx(applyFormation(mk(n), 'backHalf'))).toEqual(idx)
  })
  it('backHalf: 設定の row は上書きされ、前衛側の back は消える', () => {
    expect(backIdx(applyFormation(mk(4, [0]), 'backHalf'))).toEqual([2, 3])
  })
  it('入力を変更しない（要素も配列も）', () => {
    const input = mk(4, [0])
    const snapshot = JSON.parse(JSON.stringify(input))
    applyFormation(input, 'backHalf')
    applyFormation(input, 'front')
    applyFormation(input, 'config')
    expect(input).toEqual(snapshot)
  })
  it('config は複製を返す（同一参照ではない）', () => {
    const input = mk(2)
    const out = applyFormation(input, 'config')
    expect(out[0]).not.toBe(input[0])
  })
})

describe('buildBattleSetup: 奥行き・前景・隊列 (#747)', () => {
  const FG = 'https://example.com/fg.png'
  const cfg = (over: Partial<BattleSampleConfig> = {}): BattleSampleConfig => ({
    ...defaultConfig(),
    horizon: 0.25,
    perspective: 0.6,
    ...over,
  })

  it('depth on → config の horizon / perspective が options.depth に入る', () => {
    const s = buildBattleSetup(cfg(), view({ depth: 'on' }))
    expect(s.options.depth).toEqual({ horizon: 0.25, perspective: 0.6 })
  })
  it('depth off → options.depth は null', () => {
    expect(buildBattleSetup(cfg(), view({ depth: 'off' })).options.depth).toBeNull()
  })
  it('foregroundOn かつ foreground あり → options.foreground', () => {
    const s = buildBattleSetup(cfg({ foreground: FG }), view({ foregroundOn: true }))
    expect(s.options.foreground).toBe(FG)
  })
  it('foregroundOn でも foreground なしなら foreground キーなし', () => {
    const s = buildBattleSetup(cfg({ foreground: null }), view({ foregroundOn: true }))
    expect('foreground' in s.options).toBe(false)
  })
  it('foregroundOn=false なら foreground ありでもキーなし', () => {
    const s = buildBattleSetup(cfg({ foreground: FG }), view({ foregroundOn: false }))
    expect('foreground' in s.options).toBe(false)
  })
  it('layout=side・formation=backHalf・4 人 → 後衛は index 2, 3', () => {
    const s = buildBattleSetup(cfg(), view({ formation: 'backHalf', partyCount: 4 }))
    expect(s.party.map((p) => p.row)).toEqual([undefined, undefined, 'back', 'back'])
  })
  it('layout=side・formation=front → 設定の row も消える', () => {
    const party = defaultParty().map((p) => ({ ...p, row: 'back' as const }))
    const s = buildBattleSetup(cfg({ party }), view({ formation: 'front', partyCount: 4 }))
    expect(s.party.some((p) => 'row' in p)).toBe(false)
  })
  it('layout=front なら formation（config / backHalf）を無視して row を持たない', () => {
    const party = defaultParty().map((p) => ({ ...p, row: 'back' as const }))
    for (const formation of ['config', 'backHalf'] as const) {
      const s = buildBattleSetup(cfg({ party }), view({ layout: 'front', formation }))
      expect(s.party).toHaveLength(1)
      expect('row' in s.party[0]).toBe(false)
    }
  })
  it('config.party は変更されない', () => {
    const c = cfg()
    const snapshot = JSON.parse(JSON.stringify(c.party))
    buildBattleSetup(c, view({ formation: 'backHalf', partyCount: 4 }))
    expect(c.party).toEqual(snapshot)
  })
})

describe('viewsEqual / initialView: 奥行き・前景・隊列 (#747)', () => {
  it('depth の差で false', () => {
    expect(viewsEqual(view({ depth: 'on' }), view({ depth: 'off' }))).toBe(false)
  })
  it('foregroundOn の差で false', () => {
    expect(viewsEqual(view({ foregroundOn: true }), view({ foregroundOn: false }))).toBe(false)
  })
  it('formation の差で false', () => {
    expect(viewsEqual(view({ formation: 'front' }), view({ formation: 'backHalf' }))).toBe(false)
  })
  it('同一 view は true', () => {
    expect(
      viewsEqual(
        view({ depth: 'on', formation: 'front' }),
        view({ depth: 'on', formation: 'front' })
      )
    ).toBe(true)
  })
  it('initialView の既定: depth off・formation config', () => {
    const v = initialView(defaultConfig())
    expect(v.depth).toBe('off')
    expect(v.formation).toBe('config')
  })
  it('initialView: foreground ありなら foregroundOn、なしなら false', () => {
    expect(
      initialView({ ...defaultConfig(), foreground: 'https://example.com/f.png' }).foregroundOn
    ).toBe(true)
    expect(initialView(defaultConfig()).foregroundOn).toBe(false)
  })
})

describe('ATB (#205)', () => {
  it('設定 JSON の atb / atbMode を検証して取り込む（既定は off / wait）', () => {
    const def = parseConfig({}, BASE)
    expect(def.ok && [def.value.atb, def.value.atbMode]).toEqual(['off', 'wait'])
    const on = parseConfig({ atb: 'on', atbMode: 'active' }, BASE)
    expect(on.ok && [on.value.atb, on.value.atbMode]).toEqual(['on', 'active'])
    expect(parseConfig({ atb: 'yes' }, BASE).ok).toBe(false)
    expect(parseConfig({ atbMode: 'x' }, BASE).ok).toBe(false)
  })

  it('buildBattleSetup は atb が on のときだけ atb 設定を返す', () => {
    const cfg = defaultConfig()
    expect(buildBattleSetup(cfg, view()).atb).toBeUndefined()
    expect(buildBattleSetup(cfg, view({ atb: 'on', atbMode: 'active' })).atb).toEqual({
      mode: 'active',
    })
  })

  it('atb / atbMode の違いはブリンク比較の別状態になる', () => {
    expect(viewsEqual(view(), view({ atb: 'on' }))).toBe(false)
    expect(viewsEqual(view(), view({ atbMode: 'active' }))).toBe(false)
  })
})
