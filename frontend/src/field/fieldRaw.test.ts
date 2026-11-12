// #1127 (S3d): buildFieldRaw の単体テスト。手組みの EventDocument を collectFieldNotation に通して FieldNotation を作り、
// 項目ごとの変換と警告文言を toEqual で固定する。実 wasm・同値性は fieldRawEquivalence.test.ts。
import { describe, expect, it } from 'vitest'
import type { Event, EventDocument, EventScene } from '../types'
import { collectFieldNotation, type FieldEntry, type FieldSourceDoc } from './fieldNotation'
import { buildFieldRaw, type BuildFieldRawInput } from './fieldRaw'

const ASSET = 'https://x.test/assets'

const map = (extra: Record<string, unknown> = {}): Event =>
  ({ FieldMap: { background: 'bg.webp', mask: 'm.webp', ...extra } }) as Event
const start: Event = { PlayerStart: { x: 10, y: 20, direction: 'Left' } }
const scene = (id: string, title: string, ...events: Event[]): EventScene => ({
  id,
  title,
  view: 'TopDown',
  events,
})
const mkDoc = (frontmatter: Record<string, unknown>, ...scenes: EventScene[]): EventDocument =>
  ({
    engine: 'name-name',
    ...frontmatter,
    chapters: [{ number: 1, title: 't', hidden: false, default_bgm: null, scenes }],
  }) as unknown as EventDocument

/** 主人公の歩行絵と人物の形態(必須)。場面 `cfg` に置く */
const baseCfg: Event[] = [
  { CharacterForms: { catalog: 'forms.json', assets: 'chars', weapon_assets: 'weapons' } },
  { FieldWalkSprite: { kind: 'Player', character: 'C001', form: 'adult' } },
]

interface Opts {
  /** 場面 s1 のイベント(FieldMap と PlayerStart は自動で足す) */
  s1?: Event[]
  /** 場面 s1 に FieldMap を自動で足さない */
  noMap?: boolean
  noStart?: boolean
  /** 作品全体の設定とマスター(場面 cfg) */
  cfg?: Event[]
  withCfg?: boolean
  frontmatter?: Record<string, unknown>
  extraScenes?: EventScene[]
  entry?: FieldEntry
  input?: Partial<BuildFieldRawInput>
}

function run(o: Opts = {}) {
  const s1 = scene(
    's1',
    '',
    ...(o.noMap ? [] : [map()]),
    ...(o.noStart ? [] : [start]),
    ...(o.s1 ?? [])
  )
  const docs: FieldSourceDoc[] = [
    { path: 'a.md', doc: mkDoc(o.frontmatter ?? {}, s1, ...(o.extraScenes ?? [])) },
    {
      path: 'data.md',
      doc: mkDoc({}, scene('cfg', '', ...((o.withCfg ?? true) ? baseCfg : []), ...(o.cfg ?? []))),
    },
  ]
  const { notation } = collectFieldNotation({
    docs,
    entryPath: 'a.md',
    entry: o.entry ?? { sceneId: 's1' },
  })
  const before = JSON.stringify(notation)
  const r = buildFieldRaw(notation, { assetBaseUrl: ASSET, ...o.input })
  // 入力は書き換えない
  expect(JSON.stringify(notation)).toBe(before)
  // JSON 化できる(関数・Map・undefined を含まない)
  if (r.ok) expect(JSON.parse(JSON.stringify(r.raw))).toEqual(r.raw)
  return r
}

function ok(o: Opts = {}) {
  const r = run(o)
  if (!r.ok) throw new Error(r.error)
  return r
}

const mon = (id: string, extra: Record<string, unknown> = {}): Event =>
  ({ Monster: { id, name: id, hp: 5, atk: 1, def: 1, agi: 1, exp: 2, gold: 3, ...extra } }) as Event
const member = (id: string, extra: Record<string, unknown> = {}): Event =>
  ({ PartyMember: { id, name: id, hp: 10, atk: 1, def: 1, agi: 1, ...extra } }) as Event

describe('buildFieldRaw: 最小の変換', () => {
  it('最小の世界の raw を全部固定する', () => {
    const r = ok()
    expect(r.warnings).toEqual([])
    expect(r.raw).toEqual({
      assetBaseUrl: ASSET,
      startScene: 's1',
      start: { x: 10, y: 20 },
      startFacing: 'left',
      characterForms: { root: 'chars', manifestUrl: `${ASSET}/forms.json`, weaponRoot: 'weapons' },
      player: { character: 'C001', form: 'adult' },
      monsters: {},
      spells: [],
      skills: [],
      items: [],
      statuses: [],
      scenes: { s1: { background: 'bg.webp', mask: 'm.webp' } },
      tiltShift: 'on',
      battle: { logicalSize: '1920x1080' },
    })
  })

  it('フィールド設定・操作画像・通貨名・歩行絵の指定が移る', () => {
    const r = ok({
      withCfg: false,
      cfg: [
        { CharacterForms: { catalog: 'forms.json', assets: 'chars', weapon_assets: 'weapons' } },
        {
          FieldSettings: {
            speed: 300,
            edge_threshold: 8,
            edge_contact: 'Foot',
            ms_per_char: 20,
          },
        },
        { UiImages: { hand: 'hand.webp', select_mark: 'cone.webp', scale: 3 } },
        { Currency: '円' },
        {
          FieldWalkSprite: {
            kind: 'Player',
            character: 'C001',
            form: 'adult',
            height: 90,
            frame_ms: 120,
            cycle: [0, 1, 2, 1],
            idle_frame: 1,
          },
        },
      ],
    })
    expect(r.warnings).toEqual([])
    expect(r.raw).toMatchObject({
      speed: 300,
      edgeThreshold: 8,
      edgeContact: 'foot',
      dialogMsPerChar: 20,
      ui: { handImage: 'hand.webp', selectMarkImage: 'cone.webp', markScale: 3 },
      battle: { currencyName: '円', logicalSize: '1920x1080' },
      player: {
        character: 'C001',
        form: 'adult',
        height: 90,
        frameMs: 120,
        cycle: [0, 1, 2, 1],
        idleFrame: 1,
      },
    })
  })
})

describe('buildFieldRaw: 開始位置と致命', () => {
  it('[フィールド:] の x,y と向きが優先され、無ければ [プレイヤー] を使う', () => {
    const r = ok({ entry: { sceneId: 's1', x: 1, y: 2, facing: 'up' } })
    expect(r.raw).toMatchObject({ start: { x: 1, y: 2 }, startFacing: 'up' })
    const r2 = ok({ entry: { sceneId: 's1', facing: 'right' } })
    expect(r2.raw).toMatchObject({ start: { x: 10, y: 20 }, startFacing: 'right' })
    const r3 = ok({ entry: { sceneId: 's1', x: 1, y: 2 } })
    expect(r3.raw).not.toHaveProperty('startFacing')
  })

  it('開始場面が一枚絵として見つからないのは致命', () => {
    expect(run({ noMap: true })).toEqual({
      ok: false,
      error:
        '[フィールド: s1] の場面が一枚絵のフィールド（[フィールドマップ] のある場面）として見つかりません',
      warnings: [],
    })
  })

  it('開始位置が決まらないのは致命', () => {
    expect(run({ noStart: true })).toEqual({
      ok: false,
      error:
        '開始位置が決まりません（[フィールド: s1 @x,y] か、場面 s1 の [プレイヤー @x,y] が必要です）',
      warnings: [],
    })
  })

  it('主人公の歩行絵・人物の形態が無いのは致命', () => {
    expect(run({ withCfg: false })).toMatchObject({
      ok: false,
      error: '主人公の歩行絵が決まりません（[歩行絵 主人公 人物=… 形態=…] が必要です）',
    })
    expect(
      run({
        withCfg: false,
        cfg: [{ FieldWalkSprite: { kind: 'Player', character: 'C001', form: 'adult' } }],
      })
    ).toMatchObject({
      ok: false,
      error:
        '[歩行絵 主人公] で人物を指すには [人物の形態 目録=… 素材=…] が必要です（歩行絵を導けません）',
    })
  })
})

describe('buildFieldRaw: 場面・端・ワープ・エンカウント', () => {
  it('場面の中身が移り、行き先が無い端・ワープは警告して落とす', () => {
    const r = ok({
      noStart: true,
      s1: [
        map({ foreground: 'fg.webp', battle_background: 'bb.webp' }),
        { FieldEdge: { direction: 'Right', range_from: 200, range_to: 400, target: 's2' } },
        { FieldEdge: { direction: 'Up', range_from: 0, range_to: 50, target: 'novel1' } },
        { FieldEdge: { direction: 'Down', range_from: 0, range_to: 50, target: 'ghost' } },
        { FieldShake: { amplitude_y: 6, period_ms: 600 } },
        { FieldScroll: { image: 'sky.webp', speed: -30, y: 4 } },
        {
          FieldWarp: {
            name: 'door',
            target: 's2',
            x: 1,
            y: 2,
            direction: 'Down',
            effect: 'Flash',
            timing_ms: [1, 2, 3],
          },
        },
        { FieldWarp: { name: 'plain', target: 's2', x: 3, y: 4 } },
        { FieldWarp: { name: 'bad', target: 'novel1', x: 3, y: 4 } },
        { PlayerStart: { x: 10, y: 20, direction: 'Left', height: 88 } },
      ],
      extraScenes: [scene('s2', '駅前', map()), scene('novel1', '物語')],
    })
    // FieldMap が 2 つ以上になるので重複の警告は S3c 側。ここでは S3d の警告だけ見る
    expect(r.warnings).toEqual([
      '場面 s1（a.md）の [端 上 → novel1] の行き先は一枚絵のフィールドではありません（ノベルへの出口は未対応です）（この端は省きます）',
      '場面 s1（a.md）の [端 下 → ghost] の行き先は場面が見つかりません（この端は省きます）',
      "[ワープ bad] の行き先 'novel1' は一枚絵のフィールドではありません（ノベルへの出口は未対応です）（このワープは省きます）",
    ])
    const s1 = (r.raw.scenes as Record<string, unknown>).s1
    expect(s1).toEqual({
      background: 'bg.webp',
      mask: 'm.webp',
      playerHeight: 88,
      shake: { amplitudeY: 6, periodMs: 600 },
      scroll: { image: 'sky.webp', speed: -30, y: 4 },
      links: [{ edge: 'right', range: [200, 400], to: 's2' }],
    })
    expect(r.raw.warps).toEqual({
      door: {
        to: 's2',
        at: { x: 1, y: 2 },
        facing: 'down',
        effect: 'flash',
        outMs: 1,
        holdMs: 2,
        inMs: 3,
      },
      plain: { to: 's2', at: { x: 3, y: 4 } },
    })
  })

  it('エンカウント: 率と群、片方だけ・未知のモンスター・不正な群は警告して落とす', () => {
    const enc = (extra: Record<string, unknown>) => [
      { FieldMap: { background: 'bg.webp', mask: 'm.webp', ...extra } } as Event,
    ]
    const w = (extra: Record<string, unknown>, id = 's1') =>
      run({
        noMap: true,
        s1: enc(extra),
        cfg: [mon('slime')],
        ...(id === 's1' ? {} : {}),
      })
    const scene1 = (r: ReturnType<typeof run>) =>
      r.ok ? (r.raw.scenes as Record<string, Record<string, unknown>>).s1 : undefined

    const good = w({
      encounter_rate: 5,
      encounter_groups: ['slime*2'],
      battle_background: 'bb.webp',
    })
    expect(good.ok && good.warnings).toEqual([])
    expect(scene1(good)?.encounter).toEqual({ rate: 5, groups: ['slime*2'], background: 'bb.webp' })

    const onlyRate = w({ encounter_rate: 5 })
    expect(onlyRate.warnings).toEqual([
      '場面 s1（a.md）の [エンカウント率:] だけで敵の群がありません（エンカウントなしにします）',
    ])
    expect(scene1(onlyRate)).not.toHaveProperty('encounter')

    const onlyGroups = w({ encounter_groups: ['slime'] })
    expect(onlyGroups.warnings).toEqual([
      '場面 s1（a.md）の 敵の群だけで [エンカウント率:] がありません（エンカウントなしにします）',
    ])

    const town = w({ encounter_rate: 0 })
    expect(town.warnings).toEqual([
      '場面 s1（a.md）の [エンカウント率:] だけで敵の群がありません（エンカウントなしにします）',
    ])

    const bad = w({ encounter_rate: 3, encounter_groups: ['slime', 'ghost*2', 'slime*x'] })
    expect(bad.warnings).toHaveLength(2)
    expect(bad.warnings[0]).toBe(
      '場面 s1（a.md）の 敵の群 "ghost*2" の \'ghost\' が [モンスター] にありません（この群は省きます）'
    )
    expect(bad.warnings[1]).toMatch(
      /^場面 s1（a\.md）の 敵の群 "slime\*x" は .+（この群は省きます）$/
    )
    expect(scene1(bad)?.encounter).toEqual({ rate: 3, groups: ['slime'] })
  })
})

describe('buildFieldRaw: NPC', () => {
  const npc = (extra: Record<string, unknown>): Event =>
    ({
      Npc: { id: 'n1', name: '長老', x: 5, y: 6, color: 0, message: ['こんにちは'], ...extra },
    }) as Event
  const npcs = (r: ReturnType<typeof run>) =>
    r.ok ? (r.raw.scenes as Record<string, { npcs?: unknown }>).s1.npcs : undefined

  it('単一画像・歩行絵・高さ・向き・scene が移る', () => {
    const r = ok({
      s1: [
        npc({ sprite: 'elder.webp', height: 80, direction: 'Up', scene: '長老の話' }),
        npc({ id: 'n2', name: '子', walk_sprites: 'kid' }),
      ],
    })
    expect(r.warnings).toEqual([])
    expect(npcs(r)).toEqual([
      {
        id: 'n1',
        name: '長老',
        x: 5,
        y: 6,
        line: 'こんにちは',
        sprite: 'elder.webp',
        height: 80,
        facing: 'up',
        scene: '長老の話',
      },
      {
        id: 'n2',
        name: '子',
        x: 5,
        y: 6,
        line: 'こんにちは',
        sprites: {
          up: ['kid-walk-up-1.webp', 'kid-walk-up-2.webp', 'kid-walk-up-3.webp'],
          down: ['kid-walk-down-1.webp', 'kid-walk-down-2.webp', 'kid-walk-down-3.webp'],
          left: ['kid-walk-left-1.webp', 'kid-walk-left-2.webp', 'kid-walk-left-3.webp'],
          right: ['kid-walk-right-1.webp', 'kid-walk-right-2.webp', 'kid-walk-right-3.webp'],
        },
      },
    ])
  })

  it('sprite= と 絵= の併記は 絵= を採る', () => {
    const r = ok({ s1: [npc({ sprite: 'a.webp', walk_sprites: 'kid' })] })
    expect(r.warnings).toEqual([
      "場面 s1（a.md）の NPC '長老' は sprite= と 絵= の両方があります。絵=（4 方向）を使い sprite= は無視します",
    ])
    expect(npcs(r)).toEqual([expect.objectContaining({ sprites: expect.any(Object) })])
    expect((npcs(r) as Record<string, unknown>[])[0]).not.toHaveProperty('sprite')
  })

  it('画像が無い・台詞も scene も無い NPC は落とす。scene があれば台詞は …', () => {
    const r = ok({
      s1: [
        npc({}),
        npc({ id: 'n2', sprite: 'a.webp', message: [] }),
        npc({ id: 'n3', sprite: 'a.webp', message: ['  '], scene: 'ev' }),
      ],
    })
    expect(r.warnings).toEqual([
      "場面 s1（a.md）の NPC '長老' は sprite= も 絵= もありません（一枚絵のフィールドでは色の四角を描けないので、この NPC は省きます）",
      "場面 s1（a.md）の NPC '長老' は台詞も scene もありません（この NPC は省きます）",
    ])
    expect(npcs(r)).toEqual([
      { id: 'n3', name: '長老', x: 5, y: 6, line: '…', sprite: 'a.webp', scene: 'ev' },
    ])
  })
})

describe('buildFieldRaw: マスターと範囲の規則', () => {
  const cfg: Event[] = [
    mon('slime', {
      mp: 2,
      sprite: 's.webp',
      poses: { idle: 'i.webp' },
      size: { w: 2, h: 1 },
      scale: 0.5,
      level: 3,
      actions: ['a1'],
      counters: ['c1'],
      onDeath: 'd1',
      affinity: { weak: ['fire'] },
      loot: { drops: ['potion'], stealLimit: '2' },
    }),
    member('p1', {
      mp: 4,
      level: 2,
      sprite: 'p.webp',
      row: 'back',
      learns: [
        { level: 1, spell: 'fire' },
        { level: 3, spell: 'ice' },
        { level: 1, spell: 'nope' },
      ],
      abilities: ['slash', 'nowaza'],
      magicites: ['m1'],
      equipment: ['e1'],
      jobs: ['j1'],
      character: 'C001',
      form: 'adult',
      weapon: 'muramasa',
    }),
    { Spell: { id: 'ice', name: 'ice', mp: 3, target: '敵単体' } } as Event,
    {
      Spell: {
        id: 'fire',
        name: 'fire',
        mp: 2,
        target: '敵単体',
        effect: 'damage 5',
        description: 'もえる',
        multiTarget: true,
        tags: ['t'],
        fieldUse: false,
      },
    } as Event,
    { Skill: { id: 'slash', name: 'slash', target: '相手単体', effect: 'damage 3' } } as Event,
    { Skill: { id: 'enemy-only', name: 'e', target: '相手単体' } } as Event,
    { Status: { id: 'poison', name: 'どく', duration: '3', tickDamage: '1/16' } } as Event,
    {
      Item: {
        id: 'potion',
        name: 'やくそう',
        kind: '回復',
        effect: 'heal 30',
        count: 2,
        description: 'なおる',
        category: 'heal',
        fieldUse: true,
        key: true,
        price: 10,
      },
    } as Event,
    {
      Item: {
        id: 'blade-1',
        name: '刀',
        kind: '武器',
        shopKind: 'blade',
        owner: 'p1',
        basePrice: 100,
      },
    } as Event,
  ]

  it('モンスター・味方・呪文・特技・アイテム・状態の変換', () => {
    const r = ok({ cfg })
    expect(r.raw.monsters).toEqual({
      slime: {
        name: 'slime',
        hp: 5,
        mp: 2,
        atk: 1,
        def: 1,
        agi: 1,
        exp: 2,
        gold: 3,
        sprite: 's.webp',
        poses: { idle: 'i.webp' },
        size: '2x1',
        scale: 0.5,
        level: 3,
        actions: ['a1'],
        counters: ['c1'],
        onDeath: 'd1',
        affinity: { weak: ['fire'] },
        loot: { drops: ['potion'], stealLimit: '2' },
      },
    })
    expect(r.raw.party).toEqual([
      {
        id: 'p1',
        name: 'p1',
        hp: 10,
        mp: 4,
        atk: 1,
        def: 1,
        agi: 1,
        sprite: 'p.webp',
        character: 'C001',
        form: 'adult',
        weapon: 'muramasa',
      },
    ])
    // 覚える: レベル 2 以下の fire だけ(ice は 3 なので入らない)。定義順
    expect(r.raw.spells).toEqual([
      {
        id: 'fire',
        name: 'fire',
        mp: 2,
        target: '敵単体',
        effect: 'damage 5',
        description: 'もえる',
        multiTarget: true,
        tags: ['t'],
        fieldUse: false,
      },
    ])
    // わざ: 味方の slash(敵専用の enemy-only は入らない)
    expect(r.raw.skills).toEqual([
      { id: 'slash', name: 'slash', target: '相手単体', effect: 'damage 3' },
    ])
    // 売り物(blade-1)は items に入れない
    expect(r.raw.items).toEqual([
      {
        id: 'potion',
        name: 'やくそう',
        effect: 'heal 30',
        count: 2,
        description: 'なおる',
        category: 'heal',
        fieldUse: true,
        key: true,
      },
    ])
    expect(r.raw.statuses).toEqual([
      { id: 'poison', name: 'どく', duration: '3', tickDamage: '1/16' },
    ])
    expect(r.warnings).toEqual([
      '[パーティ p1] の 隊列 は一枚絵フィールドでは使えません（無視します）',
      '[パーティ p1] の 魔石 は一枚絵フィールドでは使えません（無視します）',
      '[パーティ p1] の 装備 は一枚絵フィールドでは使えません（無視します）',
      '[パーティ p1] の ジョブ は一枚絵フィールドでは使えません（無視します）',
      "[パーティ p1] の 覚える 'nope' が [呪文] にありません（省きます）",
      "[パーティ p1] の わざ 'nowaza' が [特技] にありません（省きます）",
    ])
  })

  it('刀のわざは skills に入り、味方のわざと和集合になる', () => {
    const r = ok({
      cfg: [
        member('p1'),
        { Skill: { id: 'a', name: 'a', target: '相手単体' } } as Event,
        { Skill: { id: 'b', name: 'b', target: '相手単体' } } as Event,
        {
          Item: {
            id: 'bl',
            name: 'bl',
            kind: '武器',
            shopKind: 'blade',
            owner: 'p1',
            abilities: ['b'],
          },
        } as Event,
      ],
    })
    expect(r.raw.skills).toEqual([{ id: 'b', name: 'b', target: '相手単体' }])
    expect((r.raw.gearShop as { entries: unknown[] }).entries).toEqual([
      { id: 'bl', kind: 'blade', name: 'bl', owner: 'p1', abilities: ['b'] },
    ])
  })
})

describe('buildFieldRaw: 売り物', () => {
  const blade = (id: string, extra: Record<string, unknown>): Event =>
    ({ Item: { id, name: id, kind: '武器', shopKind: 'blade', ...extra } }) as Event

  it('持ち主を味方の ID にそろえ、いなければ落とす。解禁フラグは false で補う。倍率が移る', () => {
    const r = ok({
      cfg: [
        member('p1', { character: 'C001' }),
        blade('b1', {
          owner: 'C001',
          basePrice: 10000,
          image: 'b1.webp',
          lockedMessage: 'まだ',
          equipBonus: 'atk+5',
        }),
        blade('b2', { owner: 'p1', basePrice: 1 }),
        blade('b3', { owner: 'ghost', basePrice: 1 }),
        {
          Item: {
            id: 'ar',
            name: 'ar',
            kind: '鎧',
            shopKind: 'armor',
            price: 5000,
            unlockFlag: 'door',
          },
        } as Event,
        { FieldSettings: { weapon_scale: 3 } },
      ],
    })
    expect(r.warnings).toEqual([
      "刀 'b3' の持ち主 'ghost' が [パーティ] にいません（この売り物は省きます）",
      "売り物の 解禁 'door' がどの [フラグ:] にもありません（false として補います）",
    ])
    expect(r.raw.gearShop).toEqual({
      multiplier: 3,
      entries: [
        {
          id: 'b1',
          kind: 'blade',
          name: 'b1',
          owner: 'p1',
          basePrice: 10000,
          image: 'b1.webp',
          lockedMessage: 'まだ',
          equipBonus: 'atk+5',
        },
        { id: 'b2', kind: 'blade', name: 'b2', owner: 'p1', basePrice: 1 },
        { id: 'ar', kind: 'armor', name: 'ar', price: 5000, unlockFlag: 'door' },
      ],
    })
    expect(r.raw.flags).toEqual({ door: false })
  })

  it('売り物が無いのに 刀の倍率 を書くと警告', () => {
    const r = ok({ cfg: [{ FieldSettings: { weapon_scale: 2 } }] })
    expect(r.warnings).toEqual(['[フィールド設定] の 刀の倍率 は売り物が無いので無視します'])
    expect(r.raw).not.toHaveProperty('gearShop')
  })
})

describe('buildFieldRaw: フラグ・補助通行・同行者', () => {
  const flag = (name: string): Event => ({ Flag: { name, value: false } }) as unknown as Event

  it('補助通行が移り、宣言の無いフラグは false で補って警告、ホストの値は宣言済みだけに重なる', () => {
    const r = ok({
      s1: [flag('opened'), flag('ghosted')],
      cfg: [
        {
          FieldAssist: {
            conditions: ['opened', 'typo'],
            except: 'nope',
            ghost: 'ghosted',
            speed_scale: 0.7,
            opacity: 0.5,
            behind_px: 40,
            fade_ms: 200,
          },
        },
      ],
      input: { flags: { opened: true, ghosted: false, unknown: true } },
    })
    expect(r.warnings).toEqual([
      "[補助通行] の 条件= 'typo' がどの [フラグ:] にもありません（綴りを確認。false として扱います）",
      "[補助通行] の 除く= 'nope' がどの [フラグ:] にもありません（綴りを確認。false として扱います）",
    ])
    expect(r.raw.flags).toEqual({ opened: true, ghosted: false, typo: false, nope: false })
    expect(r.raw.assist).toEqual({
      requires: ['opened', 'typo'],
      unless: 'nope',
      ghostWhen: 'ghosted',
      speedFactor: 0.7,
      ghostAlpha: 0.5,
      offset: 40,
      fadeMs: 200,
    })
  })

  it('同行者は補助通行と一緒のときだけ。人物が無ければ落とす', () => {
    const companion = (extra: Record<string, unknown>): Event =>
      ({ FieldWalkSprite: { kind: 'Companion', ...extra } }) as Event
    const noAssist = ok({ cfg: [companion({ character: 'C002', form: 'adult' })] })
    expect(noAssist.warnings).toEqual([
      '[歩行絵 同行者] は [補助通行] が無いと使えません（同行者は省きます）',
    ])
    expect(noAssist.raw).not.toHaveProperty('companion')

    const assist: Event = { FieldAssist: { conditions: ['f'] } }
    const noChar = ok({ s1: [flag('f')], cfg: [assist, companion({ form: 'adult' })] })
    expect(noChar.warnings).toEqual(['[歩行絵 同行者] に 人物= がありません（同行者は省きます）'])

    const good = ok({
      s1: [flag('f')],
      cfg: [
        assist,
        companion({
          character: 'C002',
          form: 'adult',
          height: 80,
          name: 'ミナ',
          cycle: [0, 1],
          idle_frame: 1,
        }),
      ],
    })
    expect(good.warnings).toEqual([])
    expect(good.raw.companion).toEqual({
      character: 'C002',
      form: 'adult',
      height: 80,
      name: 'ミナ',
      cycle: [0, 1],
      idleFrame: 1,
    })
  })

  it('停止= だけ・味方の形態との食い違いを警告する', () => {
    const r = ok({
      withCfg: false,
      cfg: [
        { CharacterForms: { catalog: 'forms.json', assets: 'chars', weapon_assets: 'weapons' } },
        member('p1', { character: 'C001', form: 'elementary' }),
        { FieldWalkSprite: { kind: 'Player', character: 'C001', form: 'adult', idle_frame: 1 } },
      ],
    })
    expect(r.warnings).toEqual([
      '[歩行絵 主人公] に 停止= だけで 周期= がありません（人物の形態から歩行絵を導くとき、停止は周期の既定に合わせて上書きされます。周期= と 停止= を組で書いてください）',
      '[歩行絵 主人公] の形態 adult は、同じ人物の味方（[パーティ p1]）の形態 elementary が優先されます',
    ])
  })
})

describe('buildFieldRaw: メニュー', () => {
  const menu = (items?: string[], transition?: Record<string, number>): Event =>
    ({ FieldMenu: { ...(items ? { items } : {}), ...(transition ? { transition } : {}) } }) as Event
  const mi = (id: string, extra: Record<string, unknown> = {}): Event =>
    ({ FieldMenuItem: { id, ...extra } }) as Event

  it('[メニュー] が無ければメニューなし(項目の上書きは使われない警告)', () => {
    const r = ok({ cfg: [mi('save', { label: 'きろく' })] })
    expect(r.raw).not.toHaveProperty('menu')
    expect(r.warnings).toEqual(['[メニュー項目 save] は [メニュー] が無いので使われません'])
  })

  it('裸の [メニュー] は既定の項目。場面タイトルが placeNames になる', () => {
    const r = ok({ cfg: [menu()], extraScenes: [scene('x', 'ignored', map())] })
    const m = r.raw.menu as { items: { id: string }[]; placeNames?: unknown }
    expect(m.items.map((i) => i.id)).toEqual([
      'item',
      'magic',
      'equip',
      'appstore',
      'magicite',
      'job',
      'status',
      'save',
      'load',
      'config',
    ])
    expect(m.items[7]).toEqual({
      id: 'save',
      label: 'セーブ',
      blockedWhileTimed: true,
      timedReason: '時間制限中はセーブできません',
    })
    expect(m).not.toHaveProperty('placeNames')
    const r2 = ok({
      s1: [],
      cfg: [menu()],
      extraScenes: [],
    })
    expect(r2.warnings).toEqual([])
  })

  it('項目名は ID → ラベル → 宣言した新 ID の順で解決し、解決できない名・重複は警告', () => {
    const r = ok({
      cfg: [
        menu(['どうぐ', 'save', 'extra', 'しゅうり', 'item', 'noname', 'config'], {
          text_out_ms: 80,
          slide_ms: 140,
        }),
        mi('save', {
          label: 'きろく',
          disabled: true,
          reason: 'いまはだめ',
          time_limit_allowed: true,
        }),
        mi('extra', { label: 'おまけ', time_limit_allowed: false, time_limit_reason: 'じかん' }),
        mi('noname'),
        mi('orphan', { label: 'x' }),
        mi('config', { content: 'cfg.json' }),
      ],
      input: { aux: { menuContents: { 'cfg.json': { description: 'せってい' } } } },
    })
    expect(r.warnings).toEqual([
      "[メニュー] の項目 'しゅうり' はメニューにありません（この項目は省きます）",
      "[メニュー] の項目 'item' は既に並んでいます（2 つ目は省きます）",
      '[メニュー項目 noname] に ラベル= がありません（この項目は省きます）',
      '[メニュー項目 orphan] は [メニュー] の並びにありません（使われません）',
    ])
    expect(r.raw.menu).toEqual({
      items: [
        { id: 'item', label: 'どうぐ' },
        { id: 'save', label: 'きろく', enabled: false, disabledReason: 'いまはだめ' },
        { id: 'extra', label: 'おまけ', blockedWhileTimed: true, timedReason: 'じかん' },
        { id: 'config', label: 'せってい', content: { description: 'せってい' } },
      ],
      transition: { textOutMs: 80, slideMs: 140 },
    })
  })

  it('中身=が読めていなければ項目だけ残して警告。有効な項目が 0 なら既定へ', () => {
    const r = ok({ cfg: [menu(['status']), mi('status', { content: 'st.json' })] })
    expect(r.warnings).toEqual([
      '[メニュー項目 status] の 中身=st.json を読めていません（項目だけ残します）',
    ])
    expect(r.raw.menu).toEqual({ items: [{ id: 'status', label: 'ステータス' }] })

    const r2 = ok({ cfg: [menu(['zzz'])] })
    expect(r2.warnings).toEqual([
      "[メニュー] の項目 'zzz' はメニューにありません（この項目は省きます）",
      '[メニュー] に有効な項目がありません（既定の項目を使います）',
    ])
    expect(r2.raw.menu).toEqual({})
  })

  it('場面のタイトルが ID と違うものだけ placeNames に入る', () => {
    const r = ok({
      cfg: [menu(['item'])],
      s1: [{ FieldEdge: { direction: 'Right', range_from: 0, range_to: 1, target: 's2' } }],
      extraScenes: [scene('s2', '駅前', map())],
    })
    expect((r.raw.menu as { placeNames: unknown }).placeNames).toEqual({ s2: '駅前' })
  })
})

describe('buildFieldRaw: frontmatter', () => {
  it('正しい値は battle / 最上位に移り、データパスは絶対化される', () => {
    const r = ok({
      frontmatter: {
        battle_layout: 'side',
        sprite_style: 'acrylic',
        window_style: 'ff-blue',
        battle_presentation: 'ff',
        battle_motion: 'snappy',
        battle_enemy_list: 'window',
        battle_command_layout: 'cross',
        battle_transition: 'ff-mosaic',
        battle_atb: 'on',
        battle_atb_mode: 'active',
        battle_enemy_grid: '6x2',
        battle_enemy_window_overlap: '0.3',
        battle_background: 'bg-battle.webp',
        battle_commands: 'skill, spell, item, escape',
        battle_command_labels: 'spell=まほう, skill＝わざ, bogus=x, item=',
        battle_effects: 'fx.json',
        field_emotions: 'emo.json',
        dialog_style: 'ff',
        aspect_ratio: '16:9',
      },
      input: { aux: { battleEffects: { hit: { image: 'h.webp' } } } },
    })
    expect(r.warnings).toEqual([])
    expect(r.raw).toMatchObject({
      spriteStyle: 'acrylic',
      dialogStyle: 'ff',
      emotionsUrl: `${ASSET}/emo.json`,
      battle: {
        layout: 'side',
        spriteStyle: 'acrylic',
        windowStyle: 'ff-blue',
        presentation: 'ff',
        motion: 'snappy',
        enemyList: 'window',
        commandLayout: 'cross',
        commandLabels: { spell: 'まほう', skill: 'わざ' },
        transition: 'ff-mosaic',
        atb: 'on',
        atbMode: 'active',
        enemyGrid: '6x2',
        enemyWindowOverlap: 0.3,
        background: 'bg-battle.webp',
        commands: ['skill', 'spell', 'item', 'escape'],
        effects: { hit: { image: 'h.webp' } },
        logicalSize: '1920x1080',
      },
    })
  })

  it('不正な値・効かないキー・16:9 以外は警告して出さない', () => {
    const r = ok({
      frontmatter: {
        battle_layout: 'wide',
        sprite_style: 'x',
        window_style: 'x',
        battle_presentation: 'x',
        battle_motion: 'x',
        battle_enemy_list: 'x',
        battle_command_layout: 'x',
        battle_transition: 'x',
        battle_atb: 'x',
        battle_atb_mode: 'x',
        battle_enemy_window_overlap: 'abc',
        battle_commands: 'attack, bogus, attack',
        battle_effects: 'fx.json',
        dialog_style: 'weird',
        aspect_ratio: '9:16',
        battle_background_tone: 'on',
        battle_background_dof: 'on',
        battle_log_typewriter: 'on',
        battle_horizon: '0.5',
        battle_perspective: '0.5',
        battle_foreground: 'f.webp',
        battle_command_labels: 'attack=x',
        pixel_art: true,
      },
    })
    const q = (k: string, v: string, allowed: string) =>
      `frontmatter の ${k} は ${allowed} のどれかにしてください: ${JSON.stringify(v)}（無視します）`
    expect(r.warnings).toEqual([
      q('battle_layout', 'wide', '"front" / "side"'),
      q('window_style', 'x', '"dark" / "ff-blue"'),
      q('battle_presentation', 'x', '"dq" / "ff"'),
      q('battle_motion', 'x', '"default" / "snappy"'),
      q('battle_enemy_list', 'x', '"off" / "window"'),
      q('battle_command_layout', 'x', '"grid" / "cross"'),
      q('battle_transition', 'x', '"none" / "ff" / "ff-mosaic"'),
      q('battle_atb', 'x', '"on" / "off"'),
      q('battle_atb_mode', 'x', '"wait" / "active"'),
      q('sprite_style', 'x', '"none" / "acrylic"'),
      'frontmatter の dialog_style は "ff" / "adv" / "novel" のどれかにしてください: "weird"（無視します）',
      "frontmatter の battle_commands の 'bogus' は未知のコマンドです（省きます）",
      "frontmatter の battle_commands の 'attack' は重複しています（省きます）",
      'frontmatter の battle_enemy_window_overlap は数値にしてください: "abc"（無視します）',
      "frontmatter の battle_effects 'fx.json' の中身を読めていません（戦闘のエフェクトは無効にします）",
      'frontmatter の aspect_ratio "9:16" は一枚絵フィールドでは使えません（16:9 の 1920x1080 で動きます）',
      'frontmatter の battle_background_tone は一枚絵フィールドでは効きません（無視します）',
      'frontmatter の battle_background_dof は一枚絵フィールドでは効きません（無視します）',
      'frontmatter の battle_log_typewriter は一枚絵フィールドでは効きません（無視します）',
      'frontmatter の battle_horizon は一枚絵フィールドでは効きません（無視します）',
      'frontmatter の battle_perspective は一枚絵フィールドでは効きません（無視します）',
      'frontmatter の battle_foreground は一枚絵フィールドでは効きません（無視します）',
      'frontmatter の pixel_art は一枚絵フィールドでは効きません（無視します）',
    ])
    expect(r.raw.battle).toEqual({
      logicalSize: '1920x1080',
      commands: ['attack'],
      commandLabels: { attack: 'x' },
    })
    expect(r.raw).not.toHaveProperty('spriteStyle')
    expect(r.raw).not.toHaveProperty('dialogStyle')
  })
})

describe('buildFieldRaw: frontmatter の大小・空白と dialog_style', () => {
  it('列挙値は前後の空白と大小を無視して読み、raw には正規化後の値が出る', () => {
    const r = ok({
      frontmatter: {
        battle_layout: ' Side ',
        window_style: 'FF-Blue',
        sprite_style: 'Acrylic',
        battle_atb: 'ON',
      },
    })
    expect(r.warnings).toEqual([])
    expect(r.raw).toMatchObject({
      spriteStyle: 'acrylic',
      battle: { layout: 'side', windowStyle: 'ff-blue', spriteStyle: 'acrylic', atb: 'on' },
    })
  })

  it('dialog_style: adv・novel は黙り、ff は渡し、未知の値だけ警告する', () => {
    for (const v of ['adv', 'novel', 'Novel']) {
      const r = ok({ frontmatter: { dialog_style: v } })
      expect(r.warnings).toEqual([])
      expect(r.raw).not.toHaveProperty('dialogStyle')
    }
    const ff = ok({ frontmatter: { dialog_style: 'FF' } })
    expect(ff.warnings).toEqual([])
    expect(ff.raw).toMatchObject({ dialogStyle: 'ff' })
  })

  it('aux の中身はコピーして raw に入れる(参照共有しない)', () => {
    const effects = { hit: { image: 'h.webp' } }
    const content = { description: 'd' }
    const r = ok({
      frontmatter: { battle_effects: 'fx.json' },
      cfg: [
        { FieldMenu: { items: ['status'] } } as Event,
        { FieldMenuItem: { id: 'status', content: 'st.json' } } as Event,
      ],
      input: { aux: { battleEffects: effects, menuContents: { 'st.json': content } } },
    })
    const battle = r.raw.battle as { effects: unknown }
    expect(battle.effects).toEqual(effects)
    expect(battle.effects).not.toBe(effects)
    const item = (r.raw.menu as { items: { content: unknown }[] }).items[0]
    expect(item.content).toEqual(content)
    expect(item.content).not.toBe(content)
  })
})

describe('buildFieldRaw: トリガー (#1072)', () => {
  const trig = (extra: Record<string, unknown>): Event =>
    ({ RpgTrigger: { scene: 'ev', ...extra } }) as Event
  const triggers = (r: ReturnType<typeof run>) =>
    r.ok ? (r.raw.scenes as Record<string, { triggers?: unknown }>).s1.triggers : undefined

  it('トリガーが無い場面は triggers キーを作らない', () => {
    const r = ok()
    expect(triggers(r)).toBeUndefined()
    expect(r.raw.scenes as object).not.toHaveProperty('s1.triggers')
  })
  it('auto は { auto: true, event } だけ（once は無ければキー無し）', () => {
    const r = ok({ s1: [trig({ auto: true })] })
    expect(r.warnings).toEqual([])
    expect(triggers(r)).toEqual([{ auto: true, event: 'ev' }])
  })
  it('auto + once=true は once: true が付く', () => {
    const r = ok({ s1: [trig({ auto: true, once: true })] })
    expect(triggers(r)).toEqual([{ auto: true, event: 'ev', once: true }])
  })
  it('踏み込みは { x, y, event, radius? }（半径省略なら radius キー無し）', () => {
    const r = ok({ s1: [trig({ x: 100, y: 200 }), trig({ x: 1, y: 2, radius: 48, scene: 'e2' })] })
    expect(r.warnings).toEqual([])
    const t = triggers(r) as Record<string, unknown>[]
    expect(t[0]).toEqual({ x: 100, y: 200, event: 'ev' })
    expect(t[0]).not.toHaveProperty('radius')
    expect(t[1]).toEqual({ x: 1, y: 2, event: 'e2', radius: 48 })
  })
  it('踏み込み + once=true は once: true が付く', () => {
    const r = ok({ s1: [trig({ x: 1, y: 2, once: true })] })
    expect(triggers(r)).toEqual([{ x: 1, y: 2, event: 'ev', once: true }])
  })
  it('書いた順に並ぶ', () => {
    const r = ok({ s1: [trig({ scene: 'a', auto: true }), trig({ scene: 'b', x: 1, y: 2 })] })
    expect((triggers(r) as { event: string }[]).map((t) => t.event)).toEqual(['a', 'b'])
  })
  it('x/y も auto も無いデータは警告 1 件で省き、有効分は残る', () => {
    const r = ok({ s1: [trig({ scene: 'bad' }), trig({ scene: 'good', auto: true })] })
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('[トリガー scene=bad]')
    expect(triggers(r)).toEqual([{ auto: true, event: 'good' }])
  })
  it('x/y も auto も無いトリガーだけなら triggers キー自体が無い', () => {
    const r = ok({ s1: [trig({ scene: 'bad' })] })
    expect(r.warnings).toHaveLength(1)
    expect(triggers(r)).toBeUndefined()
  })
})
