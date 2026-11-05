// #1127 (S3d): 実 wasm の parseMarkdown 経由で md → collectFieldNotation → buildFieldRaw → expandCharacterForms → parseConfig が
// 警告 0 で通ること、および設計 §7-3 の最小の世界の同値性(手書き JSON → parseConfig と md 由来の raw → parseConfig の FieldConfig が同じ)を縛る。
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { parseConfig } from './config'
import { collectFieldNotation, type FieldSourceDoc } from './fieldNotation'
import { buildFieldRaw } from './fieldRaw'
import { CORE_POSES, expandCharacterForms, type CharacterFormsManifest } from './characterForms'

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

const script = [
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
  '## scene-b: 駅前',
  '',
  '[フィールドマップ 背景=bg-b.webp マスク=m-b.webp]',
  '[端 左 範囲=0..100 → scene-a]',
  '',
].join('\n')

const data = [
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
  characters: {
    C001: { forms: { adult: { poses: { plain: [...CORE_POSES] }, walk: true } } },
  },
}

/** 歩行絵 8 方向×3 コマ(命名規則 `chars/{C}/walk/{C}-{form}-walk-{dir}-{n}.webp` を、実装を使わずに書く) */
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

/** 同じ世界を手書きの `?config=` JSON で書いたもの */
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
  monsters: {
    slime: { name: 'スライム', hp: 5, atk: 2, def: 1, agi: 1, exp: 3, gold: 4 },
  },
  tiltShift: 'on',
  battle: { currencyName: '円', logicalSize: '1920x1080' },
}

async function build() {
  const docs: FieldSourceDoc[] = [
    { path: 'data.md', doc: await parseMarkdown(data) },
    { path: 'script.md', doc: await parseMarkdown(script) },
  ]
  const { notation, warnings: collectWarnings } = collectFieldNotation({
    docs,
    entryPath: 'script.md',
    entry: { sceneId: 'scene-a' },
  })
  const built = buildFieldRaw(notation, { assetBaseUrl: ASSET })
  if (!built.ok) throw new Error(built.error)
  const expanded = expandCharacterForms(built.raw, manifest)
  const parsed = parseConfig(expanded.raw, BASE, { scriptProvided: true })
  if (!parsed.ok) throw new Error(parsed.error)
  return { collectWarnings, built, expanded, parsed }
}

describe('実 wasm: md → collectFieldNotation → buildFieldRaw → parseConfig', () => {
  it('S2 の記法を含む md が、警告 0 で parseConfig まで通る', async () => {
    const { collectWarnings, built, expanded, parsed } = await build()
    expect(collectWarnings).toEqual([])
    expect(built.warnings).toEqual([])
    expect(expanded.warnings).toEqual([])
    expect(parsed.value.warnings).toBeUndefined()
    expect(parsed.value.startScene).toBe('scene-a')
    expect(Object.keys(parsed.value.scenes)).toEqual(['scene-a', 'scene-b'])
  })

  it('raw は JSON 化しても同じ(?config= に流せる)', async () => {
    const { built } = await build()
    expect(JSON.parse(JSON.stringify(built.raw))).toEqual(built.raw)
  })
})

describe('同値性(設計 §7-3 の最小の世界)', () => {
  it('手書き JSON から作った FieldConfig と md 由来の raw から作った FieldConfig が同じ', async () => {
    const { parsed } = await build()
    const hand = parseConfig(handWritten, BASE, { scriptProvided: true })
    if (!hand.ok) throw new Error(hand.error)
    expect(hand.value.warnings).toBeUndefined()
    // 意図した差は 0 件。toEqual は undefined のキーを無視するので、省略時の既定も同じことを縛る
    expect(parsed.value).toEqual(hand.value)
  })
})
