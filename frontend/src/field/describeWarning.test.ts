import { describe, expect, it } from 'vitest'
import { describeWarning } from './describeWarning'

const raw = {
  scenes: {
    'scene-a': {
      npcs: [
        { id: 'elder', name: '長老' },
        { id: 'kid', name: '子' },
      ],
    },
    'a.b-1': {
      npcs: [
        { id: 'elder', name: '長老' },
        { id: 'kid', name: '子' },
      ],
    },
  },
  menu: { items: [{ id: 'item' }, { id: 'save' }] },
  gearShop: { entries: [{ id: 'blade1' }, { id: 'armor1' }] },
  items: [{ id: 'potion' }],
  party: [{ id: 'p1' }],
}

describe('describeWarning(JSON パス → 記法の言い方)', () => {
  const cases: [string, string][] = [
    [
      'gearShop.entries[1].abilities は刀だけが持てます（防具では無視します）',
      '[アイテム armor1] の わざ: は刀だけが持てます（防具では無視します）',
    ],
    [
      'gearShop.entries[0].owner は人物 id（文字列）にしてください（この項目は省きます）',
      '[アイテム blade1] の 持ち主: は人物 id（文字列）にしてください（この項目は省きます）',
    ],
    [
      'gearShop.entries[0].price は 刀では使いません（無視）',
      '[アイテム blade1] の 価格: は 刀では使いません（無視）',
    ],
    [
      'gearShop の刀 "blade1" の abilities "slash" は skills に無い特技です（戦闘のわざには出ません）',
      "[アイテム blade1] の わざ: に挙げた 'slash' が [特技] にありません（戦闘のわざには出ません）",
    ],
    [
      'skills の "bash" は gearShop のどの刀の abilities にも挙がっていません（意図でなければ刀に割り当ててください）',
      '[特技 bash] はどの刀の わざ: にも挙がっていません（意図でなければ刀に割り当ててください）',
    ],
    [
      'player.cycle だけで player.idleFrame がありません（立位は cycle と idleFrame を組で書いてください）',
      '[歩行絵 主人公] に 周期= だけで 停止= がありません（立位は 周期= と 停止= を組で書いてください）',
    ],
    [
      'companion.cycle は 0〜2 の整数を 1〜16 個並べた配列が必要です（無視します）',
      '[歩行絵 同行者] の 周期= は 0〜2 の整数を 1〜16 個並べた配列が必要です（無視します）',
    ],
    [
      'player の歩行絵 C001/adult がありません（目録に無い）',
      '[歩行絵 主人公] の歩行絵 C001/adult がありません（目録に無い）',
    ],
    [
      'party[0] (p1) に form がありません（絵の導出をしません）',
      '[パーティ p1] に 形態: がありません（絵の導出をしません）',
    ],
    [
      'companion に form（または同じ人物の味方の form）がありません（歩行絵の導出をしません）',
      '[歩行絵 同行者] に 形態=（または同じ人物の味方の 形態:）がありません（歩行絵の導出をしません）',
    ],
    [
      'scenes.scene-a.npcs[1].facing は up/down/left/right: "x"',
      '場面 scene-a の NPC \'子\' の 向き= は up/down/left/right: "x"',
    ],
    [
      'scenes.scene-a.npcs[0] .id "elder" が重複しています（この NPC は無視します）',
      '場面 scene-a の NPC \'長老\' .id "elder" が重複しています（この NPC は無視します）',
    ],
    [
      'menu.items[1].kind は a / b のどれかにしてください（無視します）',
      '[メニュー項目 save] の kind は a / b のどれかにしてください（無視します）',
    ],
    [
      'menu.items[0] の id "item" が重複しています（この項目は省きます）',
      '[メニュー項目 item] の id "item" が重複しています（この項目は省きます）',
    ],
    ['assist.speedFactor は 0 より大きい数値', '[補助通行] の 速度倍率= は 0 より大きい数値'],
    ['battle.currencyName は空でない文字列が必要です', '[通貨名:] は空でない文字列が必要です'],
    [
      'menu.items に有効な項目がありません（既定の項目を使います）',
      '[メニュー] に有効な項目がありません（既定の項目を使います）',
    ],
    ['scenes.a.b-1.npcs[1].facing は x', "場面 a.b-1 の NPC '子' の 向き= は x"],
    ['items[0].count は数値', '[アイテム potion] の count は数値'],
    [
      'scenes.scene-a.encounter.groups の "x": 不正',
      '場面 scene-a の [エンカウント率:] / [エンカウント群:]（groups） の "x": 不正',
    ],
  ]
  for (const [from, to] of cases)
    it(from, () => {
      expect(describeWarning(from, raw)).toBe(to)
    })

  it('表に無い文言・md 由来の警告は変えない', () => {
    for (const m of [
      'tiltShift は "on" か "off" のみ指定できます（無視します）',
      '[補助通行] が複数あります（script.md / data.md）。先頭の script.md のものを使います',
      "場面 scene-a（script.md）の NPC '子' は sprite= も 絵= もありません",
    ])
      expect(describeWarning(m, raw)).toBe(m)
  })

  it('raw に位置が無くても落ちない(番号で言う)', () => {
    expect(describeWarning('gearShop.entries[5].kind は', {})).toBe('売り物 6 件目 の 売り物: は')
  })
})
