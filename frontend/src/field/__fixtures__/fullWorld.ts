/**
 * S3e (#1129) の全部入りの世界(中立 ID)。同じ世界を 2 通りで書いてある。
 * - `fullWorldMd` … md から作る側(実 wasm で parse する)
 * - `handWrittenFullWorld` … `?config=` の手書き JSON から作る側(歩行絵・戦闘ポーズ・メニュー・売り物を全部明示。目録は通さない)
 *
 * 同値性テスト(fieldConfigFromDocs.test.ts)と、実機のライブ A/B(スクラッチの小さなスクリプト)で共有する。
 * テストでも実機でも、手書き側は「人が書く JSON」として独立に書いたまま(md 側の出力から写していない)。
 */
import { CORE_POSES, type CharacterFormsManifest } from '../characterForms'

const head = (title: string, extra: string[] = []) => [
  '---',
  'engine: name-name',
  'chapter: 1',
  `title: ${title}`,
  ...extra,
  '---',
  '',
]

export const fullWorldMd: Record<string, string> = {
  'script.md': [
    ...head('main', [
      'battle_layout: Side',
      'battle_presentation: ff',
      'window_style: ff-blue',
      'dialog_style: ff',
    ]),
    '## scene-a: 野原',
    '',
    '[フィールドマップ 背景=bg-a.webp マスク=m-a.webp 戦闘背景=bb-a.webp]',
    '[エンカウント率: 1/2]',
    '[エンカウント群: slime*2]',
    '[プレイヤー @300,800 向き=右]',
    '[端 右 範囲=500..900 → scene-b]',
    '[フラグ: opened = false]',
    '[NPC 長老 @900,800 id=elder sprite=npc-elder.webp 高さ=240 向き=左]',
    'こんにちは。ここは野原じゃ。',
    '[/NPC]',
    '[NPC 子 @1200,1000 id=kid 絵=npc-kid 高さ=200]',
    'あそぼう。',
    '[/NPC]',
    '',
  ].join('\n'),
  'town.md': [
    ...head('town'),
    '## scene-b: 駅前',
    '',
    '[フィールドマップ 背景=bg-b.webp マスク=m-b.webp]',
    '[端 左 範囲=500..900 → scene-a]',
    '[ワープ 改札 → scene-c @300,900 向き=上 演出=フェード 時間=200/100/200]',
    '[揺れ: 縦=4, 周期=500]',
    '[フラグ: shop_open = false]',
    '',
    '## scene-c: 店内',
    '',
    '[フィールドマップ 背景=bg-c.webp マスク=m-c.webp]',
    '[プレイヤー @300,900 向き=上]',
    '[端 右 範囲=500..900 → scene-b]',
    '',
  ].join('\n'),
  'data.md': [
    ...head('data'),
    '## setting: 設定',
    '',
    '[人物の形態 目録=forms.json 素材=chars]',
    '[歩行絵 主人公 人物=C001 形態=adult 高さ=260 周期=0,1,2,1 停止=1]',
    '[歩行絵 同行者 人物=C002 形態=adult 高さ=240 名前=ミナ]',
    '[補助通行 条件=opened 速度倍率=0.7 濃さ=0.5 後ろ=60 フェード=200]',
    '[フィールド設定 速度=420 刀の倍率=3]',
    '[操作画像 手=hand.png 選択マーク=cone.png 倍率=2]',
    '[通貨名: 円]',
    '[メニュー: item, magic, equip, appstore, save, config]',
    '[メニュー項目 save ラベル=きろく 理由=いまは使えない 時間制限=不可 時間制限の理由=急げ]',
    '[パーティ p1]',
    '名前: ぼく',
    'レベル: 2',
    'HP: 60',
    'MP: 20',
    'ATK: 40',
    'DEF: 5',
    'AGI: 9',
    '人物: C001',
    '形態: adult',
    '習得: Lv1 heal',
    '習得: Lv3 flame',
    '[/パーティ]',
    '[パーティ p2]',
    '名前: あかり',
    'HP: 50',
    'MP: 10',
    'ATK: 30',
    'DEF: 4',
    'AGI: 7',
    '人物: C003',
    '形態: adult',
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
    '[アイテム blade1]',
    '名前: 小烏丸',
    '種別: 武器',
    '売り物: 刀',
    '持ち主: C001',
    '基準額: 10',
    '装備時: atk+5',
    'わざ: slash',
    '[/アイテム]',
    '[アイテム armor1]',
    '名前: 胴着',
    '種別: 防具',
    '価格: 50',
    '売り物: 防具',
    '解禁: shop_open',
    '解禁前の文: まだ買えません',
    '[/アイテム]',
    '[モンスター slime]',
    '名前: スライム',
    'HP: 8',
    'ATK: 2',
    'DEF: 0',
    'AGI: 1',
    'EXP: 3',
    'GOLD: 40',
    'スプライト: mon-slime.webp',
    '[/モンスター]',
    '',
  ].join('\n'),
}

/** 人物の形態の目録(`forms.json` の中身) */
export const fullWorldManifest: CharacterFormsManifest = {
  characters: Object.fromEntries(
    ['C001', 'C002', 'C003'].map((c) => [
      c,
      { forms: { adult: { poses: { plain: [...CORE_POSES] }, walk: true } } },
    ])
  ),
}

const DIRS8 = ['up', 'down', 'left', 'right', 'upLeft', 'upRight', 'downLeft', 'downRight']
/** 歩行絵の命名規則 `chars/{C}/walk/{C}-{form}-walk-{dir}-{n}.webp` を、実装を使わずに書く */
const walk = (c: string, form: string, dirs: string[]) =>
  Object.fromEntries(
    dirs.map((k) => [
      k,
      [1, 2, 3].map((n) => `chars/${c}/walk/${c}-${form}-walk-${k.toLowerCase()}-${n}.webp`),
    ])
  )
const poses = (c: string, form: string) =>
  Object.fromEntries(CORE_POSES.map((p) => [p, `chars/${c}/poses/${c}-${form}-${p}.webp`]))
const npcWalk = (name: string) =>
  Object.fromEntries(
    ['up', 'down', 'left', 'right'].map((d) => [
      d,
      [1, 2, 3].map((n) => `${name}-walk-${d}-${n}.webp`),
    ])
  )

/** 同じ世界を手書きの `?config=` JSON で書いたもの */
export function handWrittenFullWorld(assetBaseUrl: string) {
  return {
    assetBaseUrl,
    startScene: 'scene-a',
    start: { x: 300, y: 800 },
    startFacing: 'right',
    speed: 420,
    player: {
      sprites: walk('C001', 'adult', DIRS8),
      height: 260,
      cycle: [0, 1, 2, 1],
      idleFrame: 1,
    },
    companion: {
      sprites: walk('C002', 'adult', DIRS8),
      height: 240,
      cycle: [0, 1, 2, 1],
      idleFrame: 1,
      name: 'ミナ',
    },
    assist: {
      requires: ['opened'],
      speedFactor: 0.7,
      ghostAlpha: 0.5,
      offset: 60,
      fadeMs: 200,
    },
    flags: { opened: false, shop_open: false },
    scenes: {
      'scene-a': {
        background: 'bg-a.webp',
        mask: 'm-a.webp',
        links: [{ edge: 'right', range: [500, 900], to: 'scene-b' }],
        encounter: { rate: 2, groups: ['slime*2'] },
        battleBackground: 'bb-a.webp',
        npcs: [
          {
            id: 'elder',
            name: '長老',
            x: 900,
            y: 800,
            sprite: 'npc-elder.webp',
            height: 240,
            facing: 'left',
            line: 'こんにちは。ここは野原じゃ。',
          },
          {
            id: 'kid',
            name: '子',
            x: 1200,
            y: 1000,
            sprites: npcWalk('npc-kid'),
            height: 200,
            line: 'あそぼう。',
          },
        ],
      },
      'scene-b': {
        background: 'bg-b.webp',
        mask: 'm-b.webp',
        links: [{ edge: 'left', range: [500, 900], to: 'scene-a' }],
        shake: { amplitudeY: 4, periodMs: 500 },
      },
      'scene-c': {
        background: 'bg-c.webp',
        mask: 'm-c.webp',
        links: [{ edge: 'right', range: [500, 900], to: 'scene-b' }],
      },
    },
    warps: {
      改札: {
        to: 'scene-c',
        at: { x: 300, y: 900 },
        facing: 'up',
        effect: 'fade',
        outMs: 200,
        holdMs: 100,
        inMs: 200,
      },
    },
    party: [
      {
        id: 'p1',
        name: 'ぼく',
        hp: 60,
        mp: 20,
        atk: 40,
        def: 5,
        agi: 9,
        poses: poses('C001', 'adult'),
      },
      {
        id: 'p2',
        name: 'あかり',
        hp: 50,
        mp: 10,
        atk: 30,
        def: 4,
        agi: 7,
        poses: poses('C003', 'adult'),
      },
    ],
    monsters: {
      slime: {
        name: 'スライム',
        hp: 8,
        atk: 2,
        def: 0,
        agi: 1,
        exp: 3,
        gold: 40,
        sprite: 'mon-slime.webp',
      },
    },
    spells: [
      {
        id: 'heal',
        name: 'ホイミ',
        mp: 4,
        target: '味方単体',
        effect: 'heal 15..25',
        description: 'HP を回復する。',
        fieldUse: true,
      },
    ],
    skills: [{ id: 'slash', name: 'きりさく', target: '相手単体', effect: 'damage 45..45' }],
    items: [
      {
        id: 'potion',
        name: 'やくそう',
        effect: 'heal 30',
        count: 3,
        description: 'HP を 30 回復する。',
        category: 'heal',
        fieldUse: true,
      },
    ],
    gearShop: {
      multiplier: 3,
      entries: [
        {
          id: 'blade1',
          kind: 'blade',
          name: '小烏丸',
          owner: 'p1',
          basePrice: 10,
          equipBonus: 'atk+5',
          abilities: ['slash'],
        },
        {
          id: 'armor1',
          kind: 'armor',
          name: '胴着',
          price: 50,
          unlockFlag: 'shop_open',
          lockedMessage: 'まだ買えません',
        },
      ],
    },
    menu: {
      items: [
        { id: 'item', label: 'どうぐ' },
        { id: 'magic', label: 'まほう' },
        { id: 'equip', label: 'そうび' },
        { id: 'appstore', label: 'アプリストア' },
        {
          id: 'save',
          label: 'きろく',
          disabledReason: 'いまは使えない',
          blockedWhileTimed: true,
          timedReason: '急げ',
        },
        { id: 'config', label: 'せってい' },
      ],
      placeNames: { 'scene-a': '野原', 'scene-b': '駅前', 'scene-c': '店内' },
    },
    ui: { handImage: 'hand.png', selectMarkImage: 'cone.png', markScale: 2 },
    dialogStyle: 'ff',
    tiltShift: 'on',
    battle: {
      layout: 'side',
      presentation: 'ff',
      windowStyle: 'ff-blue',
      currencyName: '円',
      logicalSize: '1920x1080',
    },
  }
}
