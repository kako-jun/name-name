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

// ---------------------------------------------------------------------------
// 全部入りの世界(回帰)。手書き JSON との同値ではなく、FieldConfig への写りを期待値を明示して縛る(既定ラベルなどの再実装を避ける)
// ---------------------------------------------------------------------------

const fullHead = [
  '---',
  'engine: name-name',
  'chapter: 1',
  'title: main',
  'battle_layout: Side',
  'battle_presentation: ff',
  'window_style: ff-blue',
  'sprite_style: acrylic',
  'dialog_style: ff',
  'field_emotions: emo.json',
  '---',
  '',
]

const fullScript = [
  ...fullHead,
  '## scene-a: 野原',
  '',
  '[フィールドマップ 背景=bg-a.webp マスク=m-a.webp]',
  '[プレイヤー @100,200 向き=左]',
  '[端 右 範囲=200..400 → scene-b]',
  '[ワープ 改札 → scene-b @100,200 向き=左 演出=フラッシュ 時間=250/150/500]',
  '[揺れ: 縦=6, 周期=600]',
  '[窓の景色: sky.webp, 速度=-60, y=12]',
  '[フラグ: opened = false]',
  '[フラグ: blocked = false]',
  '[フラグ: ghosted = false]',
  '[フラグ: shop_open = false]',
  '',
  '## scene-b: 駅前',
  '',
  '[フィールドマップ 背景=bg-b.webp マスク=m-b.webp]',
  '[端 左 範囲=0..100 → scene-a]',
  '',
].join('\n')

const fullData = [
  ...head('data'),
  '## setting: 設定',
  '',
  '[人物の形態 目録=forms.json 素材=chars]',
  '[歩行絵 主人公 人物=C001 形態=adult 高さ=96]',
  '[歩行絵 同行者 人物=C002 形態=adult 名前=ミナ]',
  '[補助通行 条件=opened 除く=blocked 幽霊=ghosted 速度倍率=0.7 濃さ=0.5 後ろ=40 フェード=200]',
  '[フィールド設定 速度=300 端のしきい値=8 端の接触=足元 文字間隔=20 刀の倍率=3]',
  '[操作画像 手=hand.webp 選択マーク=cone.webp 倍率=3]',
  '[通貨名: 円]',
  '[メニュー: どうぐ, まほう, セーブ, しゅうり]',
  '[メニュー項目 save ラベル=きろく 無効=true 理由=いまは使えない 時間制限=不可 時間制限の理由=急げ]',
  '[メニュー項目 しゅうり ラベル=しゅうり]',
  '[パーティ p1]',
  '名前: ぼく',
  'レベル: 2',
  'HP: 10',
  'ATK: 3',
  'DEF: 2',
  'AGI: 4',
  '人物: C001',
  '形態: adult',
  '習得: Lv1 heal',
  '習得: Lv3 flame',
  '[/パーティ]',
  '[呪文 heal]',
  '名前: ホイミ',
  'MP: 4',
  '対象: 味方単体',
  '効果: heal 15..25',
  '説明: HP を回復する。',
  'フィールド使用: 可',
  '[/呪文]',
  '[呪文 flame]',
  '名前: ギラ',
  'MP: 6',
  '効果: damage 10..12',
  '[/呪文]',
  '[特技 slash]',
  '名前: きりさく',
  '対象: 相手単体',
  '効果: damage 45..45',
  '[/特技]',
  '[アイテム potion]',
  '名前: やくそう',
  '種別: 回復',
  '効果: heal 30',
  '初期所持: 3',
  '説明: HP を 30 回復する。',
  '区分: heal',
  'フィールド使用: 可',
  '[/アイテム]',
  '[アイテム key1]',
  '名前: かぎ',
  '種別: 鍵',
  '大切: はい',
  '[/アイテム]',
  '[アイテム blade1]',
  '名前: 小烏丸',
  '種別: 武器',
  '売り物: 刀',
  '持ち主: C001',
  '基準額: 10000',
  '装備時: atk+5',
  'わざ: slash',
  '[/アイテム]',
  '[アイテム armor1]',
  '名前: 胴着',
  '種別: 防具',
  '価格: 5000',
  '売り物: 防具',
  '解禁: shop_open',
  '解禁前の文: まだ買えません',
  '[/アイテム]',
  '[モンスター slime]',
  '名前: スライム',
  'HP: 5',
  'ATK: 2',
  'DEF: 1',
  'AGI: 1',
  '[/モンスター]',
  '',
].join('\n')

describe('全部入りの世界(実 wasm → parseConfig の回帰)', () => {
  const manifestFull: CharacterFormsManifest = {
    characters: {
      C001: { forms: { adult: { poses: { plain: [...CORE_POSES] }, walk: true } } },
      C002: { forms: { adult: { poses: { plain: [...CORE_POSES] }, walk: true } } },
    },
  }

  async function buildFull() {
    const docs: FieldSourceDoc[] = [
      { path: 'data.md', doc: await parseMarkdown(fullData) },
      { path: 'script.md', doc: await parseMarkdown(fullScript) },
    ]
    const { notation, warnings: collectWarnings } = collectFieldNotation({
      docs,
      entryPath: 'script.md',
      entry: { sceneId: 'scene-a' },
    })
    const built = buildFieldRaw(notation, { assetBaseUrl: ASSET })
    if (!built.ok) throw new Error(built.error)
    const expanded = expandCharacterForms(built.raw, manifestFull)
    const parsed = parseConfig(expanded.raw, BASE, { scriptProvided: true })
    if (!parsed.ok) throw new Error(parsed.error)
    return { collectWarnings, built, expanded, parsed, c: parsed.value }
  }

  it('警告が 0 件で parseConfig まで通る', async () => {
    const { collectWarnings, built, expanded, c } = await buildFull()
    expect(collectWarnings).toEqual([])
    expect(built.warnings).toEqual([])
    expect(expanded.warnings).toEqual([])
    expect(c.warnings).toBeUndefined()
  })

  it('補助通行・同行者・ワープ・揺れ・窓の景色・設定・操作画像・通貨が FieldConfig に写る', async () => {
    const { c } = await buildFull()
    expect(c.startFacing).toBe('left')
    expect(c).toMatchObject({
      speed: 300,
      edgeThreshold: 8,
      edgeContact: 'foot',
      dialogMsPerChar: 20,
    })
    expect(c.assist).toMatchObject({
      requires: ['opened'],
      unless: 'blocked',
      ghostWhen: 'ghosted',
      speedFactor: 0.7,
      ghostAlpha: 0.5,
      offset: 40,
      fadeMs: 200,
    })
    expect(c.flags).toEqual({ opened: false, blocked: false, ghosted: false, shop_open: false })
    expect(c.companion?.name).toBe('ミナ')
    expect(c.companion?.sprites.up[0]).toBe(
      `${ASSET}/images/chars/C002/walk/C002-adult-walk-up-1.webp`
    )
    expect(c.companion).toMatchObject({ cycle: [0, 1, 2, 1], idleFrame: 1 })
    expect(c.warps['改札']).toMatchObject({
      to: 'scene-b',
      at: { x: 100, y: 200 },
      facing: 'left',
      effect: 'flash',
      timing: { outMs: 250, holdMs: 150, inMs: 500 },
    })
    expect(c.scenes['scene-a'].shake).toEqual({ amplitudeY: 6, periodMs: 600 })
    expect(c.scenes['scene-a'].scroll).toEqual({
      image: `${ASSET}/images/sky.webp`,
      speed: -60,
      y: 12,
    })
    expect(c.ui).toEqual({
      handImage: `${ASSET}/images/hand.webp`,
      selectMarkImage: `${ASSET}/images/cone.webp`,
      markScale: 3,
    })
    expect(c.battle.currencyName).toBe('円')
  })

  it('メニュー(項目名の解決と上書き)', async () => {
    const { c } = await buildFull()
    expect(c.menu?.items).toEqual([
      { id: 'item', label: 'どうぐ' },
      { id: 'magic', label: 'まほう' },
      {
        id: 'save',
        label: 'きろく',
        enabled: false,
        disabledReason: 'いまは使えない',
        blockedWhileTimed: true,
        timedReason: '急げ',
      },
      { id: 'しゅうり', label: 'しゅうり' },
    ])
  })

  it('売り物・どうぐ・呪文(習得のレベル条件)・わざ', async () => {
    const { c } = await buildFull()
    expect(c.gearShop).toEqual({
      multiplier: 3,
      entries: [
        {
          id: 'blade1',
          kind: 'blade',
          name: '小烏丸',
          owner: 'p1',
          basePrice: 10000,
          equipBonus: 'atk+5',
          abilities: ['slash'],
        },
        {
          id: 'armor1',
          kind: 'armor',
          name: '胴着',
          price: 5000,
          unlockFlag: 'shop_open',
          lockedMessage: 'まだ買えません',
        },
      ],
    })
    // 売り物は items に入らない。key・初期所持・説明・区分・フィールド使用が移る
    expect(c.items).toEqual([
      {
        id: 'potion',
        name: 'やくそう',
        effect: 'heal 30',
        count: 3,
        description: 'HP を 30 回復する。',
        category: 'heal',
        fieldUse: true,
      },
      { id: 'key1', name: 'かぎ', key: true },
    ])
    // レベル 2 の味方は Lv3 の flame を覚えていない
    expect(c.spells.map((s) => s.id)).toEqual(['heal'])
    expect(c.spells[0]).toMatchObject({ name: 'ホイミ', mp: 4, fieldUse: true })
    expect(c.skills).toEqual([
      { id: 'slash', name: 'きりさく', target: '相手単体', effect: 'damage 45..45' },
    ])
    expect(c.party[0]).toMatchObject({ id: 'p1', name: 'ぼく', hp: 10 })
    expect(c.party[0].poses?.idle).toBe(`${ASSET}/images/chars/C001/poses/C001-adult-idle.webp`)
  })

  it('frontmatter(side・ff・acrylic・dialog_style・field_emotions)が写る', async () => {
    const { c } = await buildFull()
    expect(c.battle).toMatchObject({
      layout: 'side',
      presentation: 'ff',
      windowStyle: 'ff-blue',
      spriteStyle: 'acrylic',
    })
    expect(c.spriteStyle).toBe('acrylic')
    expect(c.dialogStyle).toBe('ff')
    expect(c.emotionsSource?.url).toBe(`${ASSET}/emo.json`)
    expect(c.tiltShift).toBe('on')
  })
})
