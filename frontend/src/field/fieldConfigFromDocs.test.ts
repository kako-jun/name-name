// #1129 (S3e): fieldConfigFromDocs / loadFieldConfig。実 wasm の parseMarkdown 経由で、手書き JSON と同値になること・
// 追加ロード(上限・解消・未解決)・hidden な md・取得の失敗・順序の決定性・警告の言い換えを縛る。サンプルは中立 ID。
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { parseConfig } from './config'
import { CORE_POSES, type CharacterFormsManifest } from './characterForms'
import {
  MAX_SCENE_LOAD_ROUNDS,
  fieldConfigFromDocs,
  loadFieldConfig,
  type FieldLoadDeps,
  type FieldSourceDoc,
} from './fieldConfigFromDocs'
import { fullWorldManifest, fullWorldMd, handWrittenFullWorld } from './__fixtures__/fullWorld'

const ASSET = 'https://x.test/assets'
const BASE = 'https://x.test/field.html'

const head = (title: string) => [
  '---',
  'engine: name-name',
  'chapter: 1',
  `title: ${title}`,
  '---',
  '',
]

const scriptMd = [
  ...head('main'),
  '## scene-a: 野原',
  '',
  '[フィールドマップ 背景=bg-a.webp マスク=m-a.webp 戦闘背景=bb-a.webp]',
  '[エンカウント率: 1/5]',
  '[エンカウント群: slime*2]',
  '[プレイヤー @100,200 向き=右]',
  '[端 右 範囲=200..400 → scene-b]',
  '[NPC 長老 @500,700 id=elder sprite=elder.webp 高さ=80 向き=左]',
  'こんにちは。',
  '[/NPC]',
  '[NPC 子 @600,720 id=kid 絵=kid]',
  'あそぼう。',
  '[/NPC]',
  '',
].join('\n')

const otherMd = [
  ...head('other'),
  '## scene-b: 駅前',
  '',
  '[フィールドマップ 背景=bg-b.webp マスク=m-b.webp]',
  '[端 左 範囲=0..100 → scene-a]',
  '',
].join('\n')

const dataMd = [
  ...head('data'),
  '## setting: 設定',
  '',
  '[人物の形態 目録=forms.json 素材=chars]',
  '[歩行絵 主人公 人物=C001 形態=adult 高さ=96]',
  '[通貨名: 円]',
  '[パーティ p1]',
  '名前: ぼく',
  'HP: 10',
  'ATK: 3',
  'DEF: 2',
  'AGI: 4',
  '[/パーティ]',
  '[モンスター slime]',
  '名前: スライム',
  'HP: 5',
  'ATK: 2',
  'DEF: 1',
  'AGI: 1',
  'EXP: 3',
  'GOLD: 4',
  '[/モンスター]',
  '',
].join('\n')

const manifest: CharacterFormsManifest = {
  characters: { C001: { forms: { adult: { poses: { plain: [...CORE_POSES] }, walk: true } } } },
}
const manifestJson = {
  characters: { C001: { forms: { adult: { poses: { plain: [...CORE_POSES] }, walk: true } } } },
}

const walk = (c: string, form: string) =>
  Object.fromEntries(
    ['up', 'down', 'left', 'right', 'upLeft', 'upRight', 'downLeft', 'downRight'].map((k) => [
      k,
      [1, 2, 3].map((n) => `chars/${c}/walk/${c}-${form}-walk-${k.toLowerCase()}-${n}.webp`),
    ])
  )
const npcWalk = (name: string) =>
  Object.fromEntries(
    ['up', 'down', 'left', 'right'].map((d) => [
      d,
      [1, 2, 3].map((n) => `${name}-walk-${d}-${n}.webp`),
    ])
  )

const handWritten = {
  assetBaseUrl: ASSET,
  startScene: 'scene-a',
  start: { x: 100, y: 200 },
  startFacing: 'right',
  player: { sprites: walk('C001', 'adult'), height: 96, cycle: [0, 1, 2, 1], idleFrame: 1 },
  scenes: {
    'scene-a': {
      background: 'bg-a.webp',
      mask: 'm-a.webp',
      links: [{ edge: 'right', range: [200, 400], to: 'scene-b' }],
      encounter: { rate: 5, groups: ['slime*2'], background: 'bb-a.webp' },
      npcs: [
        {
          id: 'elder',
          name: '長老',
          x: 500,
          y: 700,
          sprite: 'elder.webp',
          height: 80,
          facing: 'left',
          line: 'こんにちは。',
        },
        { id: 'kid', name: '子', x: 600, y: 720, sprites: npcWalk('kid'), line: 'あそぼう。' },
      ],
    },
    'scene-b': {
      background: 'bg-b.webp',
      mask: 'm-b.webp',
      links: [{ edge: 'left', range: [0, 100], to: 'scene-a' }],
    },
  },
  party: [{ id: 'p1', name: 'ぼく', hp: 10, atk: 3, def: 2, agi: 4 }],
  monsters: { slime: { name: 'スライム', hp: 5, atk: 2, def: 1, agi: 1, exp: 3, gold: 4 } },
  tiltShift: 'on',
  battle: { currencyName: '円', logicalSize: '1920x1080' },
}

const common = {
  entryPath: 'script.md',
  entry: { sceneId: 'scene-a' },
  assetBaseUrl: ASSET,
  baseUrl: BASE,
}

async function docsOf(...pairs: [string, string][]): Promise<FieldSourceDoc[]> {
  return Promise.all(pairs.map(async ([path, md]) => ({ path, doc: await parseMarkdown(md) })))
}

function makeDeps(over: Partial<FieldLoadDeps> & { all: FieldSourceDoc[] }) {
  const calls = { resolve: [] as string[], fetch: [] as string[] }
  const deps: FieldLoadDeps = {
    loadAllDocs: async () => over.all,
    resolveScene: async (id) => {
      calls.resolve.push(id)
      return over.resolveScene ? over.resolveScene(id) : null
    },
    fetchJson: async (url) => {
      calls.fetch.push(url)
      if (over.fetchJson) return over.fetchJson(url)
      if (url === `${ASSET}/forms.json`) return manifestJson
      throw new Error(`unexpected ${url}`)
    },
  }
  return { deps, calls }
}

describe('fieldConfigFromDocs(同期)', () => {
  it('手書き JSON から作った FieldConfig と同じになる(警告 0・config.warnings なし)', async () => {
    const docs = await docsOf(['data.md', dataMd], ['other.md', otherMd], ['script.md', scriptMd])
    const r = fieldConfigFromDocs({ ...common, docs, aux: { characterForms: manifest } })
    if (!r.ok) throw new Error(r.error)
    const hand = parseConfig(handWritten, BASE, { scriptProvided: true })
    if (!hand.ok) throw new Error(hand.error)
    expect(r.warnings).toEqual([])
    expect(r.value.config.warnings).toBeUndefined()
    expect(r.value.config).toEqual(hand.value)
    expect(r.value.missingScenes).toEqual([])
    expect(r.value.needs).toEqual({
      manifest: { path: 'forms.json', url: `${ASSET}/forms.json` },
      menuContents: [],
    })
    expect(JSON.parse(JSON.stringify(r.value.raw))).toEqual(r.value.raw)
  })

  it('docs の与え順を入れ替えても同じ', async () => {
    const a = await docsOf(['data.md', dataMd], ['other.md', otherMd], ['script.md', scriptMd])
    const b = [...a].reverse()
    const ra = fieldConfigFromDocs({ ...common, docs: a, aux: { characterForms: manifest } })
    const rb = fieldConfigFromDocs({ ...common, docs: b, aux: { characterForms: manifest } })
    expect(rb).toEqual(ra)
  })

  it('目録が無いと error(目録のパスを言う)', async () => {
    const docs = await docsOf(['data.md', dataMd], ['other.md', otherMd], ['script.md', scriptMd])
    const r = fieldConfigFromDocs({ ...common, docs })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("人物の形態の目録 'forms.json' を取得できません")
  })

  it('docs に無い行き先は missingScenes に出て、その端は警告つきで省かれる', async () => {
    const docs = await docsOf(['data.md', dataMd], ['script.md', scriptMd])
    const r = fieldConfigFromDocs({ ...common, docs, aux: { characterForms: manifest } })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.missingScenes).toEqual(['scene-b'])
    expect(r.warnings).toContain(
      '場面 scene-a（script.md）の [端 右 → scene-b] の行き先は場面が見つかりません（この端は省きます）'
    )
    expect(r.value.config.warnings).toEqual(r.warnings)
  })

  it('警告の言い換え: 防具の わざ: と 停止= だけの歩行絵が md の書き方で読める', async () => {
    const data2 = dataMd.replace(
      '[通貨名: 円]',
      [
        '[通貨名: 円]',
        '[アイテム armor1]',
        '名前: 胴着',
        '種別: 防具',
        '価格: 5000',
        '売り物: 防具',
        'わざ: slash',
        '[/アイテム]',
      ].join('\n')
    )
    const docs = await docsOf(['data.md', data2], ['other.md', otherMd], ['script.md', scriptMd])
    const r = fieldConfigFromDocs({ ...common, docs, aux: { characterForms: manifest } })
    if (!r.ok) throw new Error(r.error)
    const joined = r.warnings.join('\n')
    expect(joined).toContain('[アイテム armor1] の わざ:')
    expect(joined).not.toMatch(/gearShop\.entries|abilities/)
  })
})

describe('loadFieldConfig(非同期)', () => {
  it('hidden な data.md は loadAllDocs から、不足場面は resolveScene から取り、手書きと同値になる', async () => {
    const [data, other, script] = await docsOf(
      ['data.md', dataMd],
      ['other.md', otherMd],
      ['script.md', scriptMd]
    )
    const { deps, calls } = makeDeps({
      all: [data],
      resolveScene: async (id) => (id === 'scene-b' ? [other] : null),
    })
    const r = await loadFieldConfig({ ...common, docs: [script] }, deps)
    if (!r.ok) throw new Error(r.error)
    const hand = parseConfig(handWritten, BASE, { scriptProvided: true })
    if (!hand.ok) throw new Error(hand.error)
    expect(r.value.config).toEqual(hand.value)
    expect(r.warnings).toEqual([])
    expect(calls.resolve).toEqual(['scene-b'])
    expect(calls.fetch).toEqual([`${ASSET}/forms.json`])
    expect(r.value.missingScenes).toEqual([])
  })

  it('docs を渡さず loadAllDocs が全部返しても同じ。同じ path は先に渡した docs が勝つ', async () => {
    const all = await docsOf(['data.md', dataMd], ['other.md', otherMd], ['script.md', scriptMd])
    const { deps, calls } = makeDeps({ all: [...all].reverse() })
    const r = await loadFieldConfig(common, deps)
    if (!r.ok) throw new Error(r.error)
    expect(calls.resolve).toEqual([])
    expect(Object.keys(r.value.config.scenes)).toEqual(['scene-a', 'scene-b'])
    // 渡した docs の script.md が優先(中身が違う script.md を all に入れても採られない)
    const [data, other, script] = all
    const decoy = await parseMarkdown(scriptMd.replace('向き=右', '向き=左'))
    const { deps: deps2 } = makeDeps({ all: [data, other, { path: 'script.md', doc: decoy }] })
    const r2 = await loadFieldConfig({ ...common, docs: [script] }, deps2)
    if (!r2.ok) throw new Error(r2.error)
    expect(r2.value.config.startFacing).toBe('right')
  })

  it('解決できない場面は 1 回だけ試して止まる(警告は端を省く旨)', async () => {
    const [data, script] = await docsOf(['data.md', dataMd], ['script.md', scriptMd])
    const { deps, calls } = makeDeps({ all: [data], resolveScene: async () => null })
    const r = await loadFieldConfig({ ...common, docs: [script] }, deps)
    if (!r.ok) throw new Error(r.error)
    expect(calls.resolve).toEqual(['scene-b'])
    expect(r.warnings.some((w) => w.includes('場面が見つかりません'))).toBe(true)
  })

  it('追加ロードが上限で止まり、警告する', async () => {
    const scene = (n: number) =>
      [
        ...head(`s${n}`),
        `## s${n}: 場面${n}`,
        '',
        '[フィールドマップ 背景=b.webp マスク=m.webp]',
        '[プレイヤー @10,10]',
        `[端 右 範囲=0..100 → s${n + 1}]`,
        '',
      ].join('\n')
    const [data] = await docsOf(['data.md', dataMd])
    const s0 = { path: 'script.md', doc: await parseMarkdown(scene(0)) }
    const { deps, calls } = makeDeps({
      all: [data],
      resolveScene: async (id) => {
        const n = Number(id.slice(1))
        return [{ path: `s${n}.md`, doc: await parseMarkdown(scene(n)) }]
      },
    })
    const r = await loadFieldConfig({ ...common, entry: { sceneId: 's0' }, docs: [s0] }, deps)
    if (!r.ok) throw new Error(r.error)
    expect(calls.resolve).toHaveLength(MAX_SCENE_LOAD_ROUNDS)
    expect(r.warnings[0]).toContain(`上限（${MAX_SCENE_LOAD_ROUNDS} 回）`)
    expect(r.warnings[0]).toContain(`s${MAX_SCENE_LOAD_ROUNDS + 1}`)
    expect(r.value.config.warnings?.[0]).toBe(r.warnings[0])
    expect(Object.keys(r.value.config.scenes)).toHaveLength(MAX_SCENE_LOAD_ROUNDS + 1)
  })

  it('メニューの 中身= と battle_effects を取得して渡す。取得に失敗した分は警告で続行する', async () => {
    const data2 = dataMd.replace(
      '[通貨名: 円]',
      '[通貨名: 円]\n[メニュー: item, save]\n[メニュー項目 save 中身=menu/save.json]\n[メニュー項目 item 中身=menu/item.json]'
    )
    const withFx = scriptMd.replace('title: main', 'title: main\nbattle_effects: fx.json')
    const [data, other, script] = await docsOf(
      ['data.md', data2],
      ['other.md', otherMd],
      ['script.md', withFx]
    )
    const { deps, calls } = makeDeps({
      all: [data, other],
      fetchJson: async (url) => {
        if (url === `${ASSET}/forms.json`) return manifestJson
        if (url === `${ASSET}/menu/save.json`) return { title: 'save' }
        throw new Error('404')
      },
    })
    const r = await loadFieldConfig({ ...common, docs: [script] }, deps)
    if (!r.ok) throw new Error(r.error)
    expect(calls.fetch.sort()).toEqual(
      [
        `${ASSET}/forms.json`,
        `${ASSET}/fx.json`,
        `${ASSET}/menu/item.json`,
        `${ASSET}/menu/save.json`,
      ].sort()
    )
    expect(
      r.warnings.some((w) => w.includes("メニューの中身 'menu/item.json' を取得できませんでした"))
    ).toBe(true)
    expect(
      r.warnings.some((w) => w.includes("battle_effects 'fx.json' を取得できませんでした"))
    ).toBe(true)
    expect(r.value.config.menu?.items.map((i) => i.id)).toEqual(['item', 'save'])
    expect(r.value.config.warnings).toEqual(r.warnings)
  })

  it('目録を取得できないと error(取得失敗の理由つき)', async () => {
    const [data, other, script] = await docsOf(
      ['data.md', dataMd],
      ['other.md', otherMd],
      ['script.md', scriptMd]
    )
    const { deps } = makeDeps({
      all: [data, other],
      fetchJson: async () => {
        throw new Error('503')
      },
    })
    const r = await loadFieldConfig({ ...common, docs: [script] }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('人物の形態の目録')
      expect(r.warnings.some((w) => w.includes('503'))).toBe(true)
    }
  })

  it('目録の中身が不正でも error(不正の理由つき)', async () => {
    const [data, other, script] = await docsOf(
      ['data.md', dataMd],
      ['other.md', otherMd],
      ['script.md', scriptMd]
    )
    const { deps } = makeDeps({ all: [data, other], fetchJson: async () => ({ nope: 1 }) })
    const r = await loadFieldConfig({ ...common, docs: [script] }, deps)
    expect(r.ok).toBe(false)
    expect(r.warnings.some((w) => w.includes('が不正です'))).toBe(true)
  })

  it('loadAllDocs が失敗したら error', async () => {
    const { deps } = makeDeps({ all: [] })
    deps.loadAllDocs = async () => {
      throw new Error('boom')
    }
    const r = await loadFieldConfig(common, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('boom')
  })

  it('resolveScene が例外を投げても警告にして続行する', async () => {
    const [data, script] = await docsOf(['data.md', dataMd], ['script.md', scriptMd])
    const { deps } = makeDeps({
      all: [data],
      resolveScene: async () => {
        throw new Error('network')
      },
    })
    const r = await loadFieldConfig({ ...common, docs: [script] }, deps)
    if (!r.ok) throw new Error(r.error)
    expect(
      r.warnings.some((w) => w.includes("場面 'scene-b' を含む md を読めませんでした: network"))
    ).toBe(true)
  })
})

describe('同値性(全部入りの世界。手書き JSON と md 由来が同じ FieldConfig)', () => {
  async function build() {
    const docs = await docsOf(...Object.entries(fullWorldMd))
    const r = fieldConfigFromDocs({
      ...common,
      docs,
      aux: { characterForms: fullWorldManifest },
    })
    if (!r.ok) throw new Error(r.error)
    return r
  }

  it('警告 0 件で、手書き JSON から作った FieldConfig と toEqual で同じ', async () => {
    const r = await build()
    const hand = parseConfig(handWrittenFullWorld(ASSET), BASE, { scriptProvided: true })
    if (!hand.ok) throw new Error(hand.error)
    expect(hand.value.warnings).toBeUndefined()
    expect(r.warnings).toEqual([])
    // 意図した差は 0 件(手書き側はメニュー・売り物・歩行絵・ポーズまで全部明示している)
    expect(r.value.config).toEqual(hand.value)
  })

  it('md 由来の raw は JSON 化しても同じ(field.html?config= にそのまま渡せる)', async () => {
    const r = await build()
    expect(JSON.parse(JSON.stringify(r.value.raw))).toEqual(r.value.raw)
  })
})
