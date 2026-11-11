// #1120 (S3c): collectFieldNotation の単体テスト。手組みの EventDocument と、実 wasm 経由の parseMarkdown の両方で見る。
import { describe, expect, it } from 'vitest'
import type { Event, EventDocument, EventScene } from '../types'
import { parseMarkdown } from '../wasm/parser'
import { collectFieldNotation, collectSceneMoveTargets, type FieldSourceDoc } from './fieldNotation'
import type { FieldScriptEvents } from '../game/fieldScript'

const map = (bg = 'bg.webp'): Event => ({ FieldMap: { background: bg, mask: 'm.webp' } })
const edge = (target: string): Event => ({
  FieldEdge: { direction: 'Right', range_from: 0, range_to: 10, target },
})
const warp = (name: string, target: string): Event => ({
  FieldWarp: { name, target, x: 1, y: 2 },
})
const scene = (id: string, ...events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})
const doc = (...scenes: EventScene[]): EventDocument =>
  ({
    engine: 'name-name',
    chapters: [{ number: 1, title: 't', hidden: false, default_bgm: null, scenes }],
  }) as unknown as EventDocument
const src = (path: string, ...scenes: EventScene[]): FieldSourceDoc => ({
  path,
  doc: doc(...scenes),
})
const party = (id: string): Event => ({
  PartyMember: { id, name: id, hp: 1, atk: 1, def: 1, agi: 1 } as never,
})
const item = (id: string, name: string): Event => ({ Item: { id, name } as never })

describe('collectFieldNotation: 到達閉包', () => {
  it('端・ワープで辿れる場面だけを集め、FieldMap の無い行き先は exits、docs に無い行き先は missingScenes', () => {
    const docs = [
      src(
        'a.md',
        scene('s1', map(), edge('s2'), warp('w', 's3')),
        scene('s2', map(), edge('novel1')),
        scene('s3', map(), edge('ghost')),
        scene('lonely', map())
      ),
      src('b.md', scene('novel1')),
    ]
    const { notation, warnings } = collectFieldNotation({
      docs,
      entryPath: 'a.md',
      entry: { sceneId: 's1' },
    })
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(notation.exits).toEqual(['novel1'])
    expect(notation.missingScenes).toEqual(['ghost'])
    expect(notation.warps.map((w) => w.name)).toEqual(['w'])
    expect(warnings).toEqual([])
  })

  it('循環していても止まる', () => {
    const { notation } = collectFieldNotation({
      docs: [src('a.md', scene('x', map(), edge('y')), scene('y', map(), edge('x')))],
      entryPath: 'a.md',
      entry: { sceneId: 'x' },
    })
    expect(notation.scenes.map((s) => s.id)).toEqual(['x', 'y'])
  })

  it('エントリ場面が docs に無ければ missingScenes、FieldMap が無ければ exits(致命にするかは後段)', () => {
    const a = collectFieldNotation({
      docs: [src('a.md', scene('n'))],
      entryPath: 'a.md',
      entry: { sceneId: 'zzz' },
    })
    expect(a.notation.missingScenes).toEqual(['zzz'])
    expect(a.notation.scenes).toEqual([])
    const b = collectFieldNotation({
      docs: [src('a.md', scene('n'))],
      entryPath: 'a.md',
      entry: { sceneId: 'n' },
    })
    expect(b.notation.exits).toEqual(['n'])
  })

  it('場面の中身(プレイヤー・端・揺れ・窓の景色・NPC)が入る', () => {
    const { notation } = collectFieldNotation({
      docs: [
        src(
          'a.md',
          scene(
            's1',
            map(),
            { PlayerStart: { x: 5, y: 6, direction: 'Down' } },
            edge('s1'),
            { FieldShake: { amplitude_y: 6 } },
            { FieldScroll: { image: 'sky.webp', speed: 30 } },
            { Npc: { id: 'npc1', name: 'n', x: 1, y: 2, color: 0, message: ['hi'] } }
          )
        ),
      ],
      entryPath: 'a.md',
      entry: { sceneId: 's1' },
    })
    const s = notation.scenes[0]
    expect(s.playerStart).toEqual({ x: 5, y: 6, direction: 'Down' })
    expect(s.edges).toHaveLength(1)
    expect(s.shake).toEqual({ amplitude_y: 6 })
    expect(s.scroll).toEqual({ image: 'sky.webp', speed: 30 })
    expect(s.npcs.map((n) => n.id)).toEqual(['npc1'])
  })
})

describe('collectFieldNotation: 重複は先勝ち+警告', () => {
  it('場面 ID の重複(FieldMap のあるもの同士)は優先順の先頭を採る', () => {
    const { notation, warnings } = collectFieldNotation({
      docs: [src('b.md', scene('s1', map('b.webp'))), src('a.md', scene('s1', map('a.webp')))],
      entryPath: 'zz.md',
      entry: { sceneId: 's1' },
    })
    expect(notation.scenes[0].map.background).toBe('a.webp')
    expect(notation.scenes[0].path).toBe('a.md')
    expect(warnings).toContain(
      '場面 s1 が複数あります（a.md / b.md）。先頭の a.md のものを使い、b.md のものは無視します'
    )
  })

  it('エントリ md は path が後ろでも最優先', () => {
    const { notation } = collectFieldNotation({
      docs: [src('a.md', scene('s1', map('a.webp'))), src('z.md', scene('s1', map('z.webp')))],
      entryPath: 'z.md',
      entry: { sceneId: 's1' },
    })
    expect(notation.scenes[0].map.background).toBe('z.webp')
  })

  it('作品全体の設定の重複(補助通行・メニュー項目・通貨名ほか)', () => {
    const settings = (n: number): Event => ({ FieldSettings: { speed: n } })
    const { notation, warnings } = collectFieldNotation({
      docs: [
        src(
          'script.md',
          scene(
            's1',
            map(),
            settings(1),
            { Currency: '円' },
            { FieldMenuItem: { id: 'save', label: 'A' } }
          )
        ),
        src(
          'data.md',
          scene('d', settings(2), { Currency: 'G' }, { FieldMenuItem: { id: 'save', label: 'B' } })
        ),
      ],
      entryPath: 'script.md',
      entry: { sceneId: 's1' },
    })
    expect(notation.settings).toEqual({ speed: 1 })
    expect(notation.currency).toBe('円')
    expect(notation.menuItems).toEqual([{ id: 'save', label: 'A' }])
    expect(warnings).toContain(
      '[フィールド設定] が複数あります（script.md / data.md）。先頭の script.md のものを使い、data.md のものは無視します'
    )
    expect(warnings).toContain(
      '[通貨名:] が複数あります（script.md / data.md）。先頭の script.md のものを使い、data.md のものは無視します'
    )
    expect(warnings).toContain(
      '[メニュー項目 save] が複数あります（script.md / data.md）。先頭の script.md のものを使い、data.md のものは無視します'
    )
  })

  it('場面ごとの重複(フィールドマップ・プレイヤー・揺れ・窓の景色)と、ワープ名の重複', () => {
    const { notation, warnings } = collectFieldNotation({
      docs: [
        src(
          'a.md',
          scene(
            's1',
            map('1.webp'),
            map('2.webp'),
            { PlayerStart: { x: 1, y: 1, direction: 'Up' } },
            { PlayerStart: { x: 2, y: 2, direction: 'Up' } },
            { FieldShake: { amplitude_y: 1 } },
            { FieldShake: { amplitude_y: 2 } },
            { FieldScroll: { image: 'a', speed: 1 } },
            { FieldScroll: { image: 'b', speed: 2 } },
            warp('w', 's2'),
            warp('w', 's3')
          ),
          scene('s2', map()),
          scene('s3', map())
        ),
      ],
      entryPath: 'a.md',
      entry: { sceneId: 's1' },
    })
    const s = notation.scenes[0]
    expect(s.map.background).toBe('1.webp')
    expect(s.playerStart?.x).toBe(1)
    expect(s.shake?.amplitude_y).toBe(1)
    expect(s.scroll?.image).toBe('a')
    expect(notation.warps).toHaveLength(1)
    expect(notation.warps[0].target).toBe('s2')
    // 負けたワープの行き先も辿る(閉包は広め)
    expect(notation.scenes.map((x) => x.id)).toEqual(['s1', 's2', 's3'])
    for (const label of ['[フィールドマップ]', '[プレイヤー]', '[揺れ:]', '[窓の景色:]']) {
      expect(warnings).toContain(
        `場面 s1（a.md）の ${label} が複数あります。先頭のものを使い、残りは無視します`
      )
    }
    expect(warnings).toContain(
      '同じ a.md の中で [ワープ w] が複数あります。先頭のものを使い、残りは無視します'
    )
  })

  it('同じ path の md が重複して渡されたら 1 つだけ使って警告', () => {
    const { notation, warnings } = collectFieldNotation({
      docs: [src('a.md', scene('s1', map())), src('a.md', scene('s1', map()))],
      entryPath: 'a.md',
      entry: { sceneId: 's1' },
    })
    expect(warnings).toContain("md 'a.md' が複数渡されています。先頭のものを使い、残りは無視します")
    expect(notation.scenes).toHaveLength(1)
  })
})

describe('collectFieldNotation: 閉包外・エントリ欠落の警告', () => {
  it('閉包に入らない場面の ID が重複していても警告する(場面 ID の索引は全 md)', () => {
    const { notation, warnings } = collectFieldNotation({
      docs: [
        src('a.md', scene('s1', map()), scene('far', map('1.webp'))),
        src('b.md', scene('far', map('2.webp'))),
      ],
      entryPath: 'a.md',
      entry: { sceneId: 's1' },
    })
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1'])
    expect(warnings).toContain(
      '場面 far が複数あります（a.md / b.md）。先頭の a.md のものを使い、b.md のものは無視します'
    )
  })

  it('entryPath が docs に無ければ警告する', () => {
    const { warnings } = collectFieldNotation({
      docs: [src('a.md', scene('s1', map()))],
      entryPath: 'missing.md',
      entry: { sceneId: 's1' },
    })
    expect(warnings).toContain("エントリの md 'missing.md' が読み込まれていません")
  })
})

describe('collectFieldNotation: hidden な data.md 相当の doc に設定がある', () => {
  it('閉包に入らない doc の作品全体設定・マスター・フラグ・イベントも集まる', () => {
    const { notation, warnings } = collectFieldNotation({
      docs: [
        src('script.md', scene('s1', map())),
        src(
          'data.md',
          scene(
            'data',
            { FieldAssist: { conditions: ['f1'] } },
            { CharacterForms: { catalog: 'c.json', assets: 'chars/' } },
            { FieldWalkSprite: { kind: 'Player', character: 'C1' } },
            { FieldWalkSprite: { kind: 'Companion', character: 'C2', name: 'ミナ' } },
            { UiImages: { hand: 'h.webp' } },
            { FieldMenu: { items: ['item'] } },
            party('p1'),
            { Flag: { name: 'f1', value: { Bool: false } } },
            {
              Condition: { flag: 'f1', events: [{ Flag: { name: 'f2', value: { Bool: true } } }] },
            },
            { RpgEvent: { name: 'ev', commands: [{ type: 'FieldEnd' }] } }
          )
        ),
      ],
      entryPath: 'script.md',
      entry: { sceneId: 's1' },
    })
    expect(warnings).toEqual([])
    expect(notation.assist).toEqual({ conditions: ['f1'] })
    expect(notation.characterForms).toEqual({ catalog: 'c.json', assets: 'chars/' })
    expect(notation.playerWalk?.character).toBe('C1')
    expect(notation.companionWalk?.name).toBe('ミナ')
    expect(notation.uiImages).toEqual({ hand: 'h.webp' })
    expect(notation.menu).toEqual({ items: ['item'] })
    expect(notation.master.partyOrder).toEqual(['p1'])
    expect(notation.flags).toEqual(['f1', 'f2'])
    expect([...notation.npcEvents.keys()]).toEqual(['ev'])
    expect(notation.entryDoc).toBeDefined()
  })
})

describe('collectFieldNotation: マスター・イベント', () => {
  it('同 ID はエントリ md が勝ち、キー順・partyOrder は優先順で、別 md の重複は警告する', () => {
    const { notation, warnings } = collectFieldNotation({
      docs: [
        src(
          'a.md',
          scene('a', map(), item('i1', 'A1'), item('i2', 'A2'), party('p2'), party('p1'))
        ),
        src('data.md', scene('d', item('i0', 'D0'), item('i1', 'D1'), party('p3'), party('p1'))),
      ],
      entryPath: 'a.md',
      entry: { sceneId: 'a' },
    })
    expect(Object.keys(notation.master.items)).toEqual(['i1', 'i2', 'i0'])
    expect(notation.master.items.i1.name).toBe('A1')
    expect(notation.master.partyOrder).toEqual(['p2', 'p1', 'p3'])
    expect(warnings).toContain(
      '[アイテム i1] が複数の md にあります（a.md / data.md）。先頭の a.md のものを使います'
    )
    expect(warnings.some((w) => w.startsWith('[パーティ p1]'))).toBe(true)
  })

  it('[イベント] は全 md から集め、同名は先頭の md のものを使い、別 md の重複は警告', () => {
    const ev = (c: string): Event => ({
      RpgEvent: { name: 'x', commands: [{ type: 'Wait', ms: 1 } as never, { type: c } as never] },
    })
    const { notation, warnings } = collectFieldNotation({
      docs: [src('b.md', scene('b', ev('B'))), src('a.md', scene('a', map(), ev('A')))],
      entryPath: 'a.md',
      entry: { sceneId: 'a' },
    })
    expect(notation.npcEvents.get('x')?.[1].type).toBe('A')
    expect(warnings).toContain(
      '[イベント x] が複数の md にあります（a.md / b.md）。先頭の a.md のものを使い、b.md のものは無視します'
    )
  })
})

describe('collectFieldNotation: 決定性', () => {
  it('docs の与え順をどう入れ替えても同じ結果(警告も同じ)', () => {
    const docs = [
      src('script.md', scene('s1', map('s.webp'), edge('s2'), warp('w', 's3'), item('i1', 'S'))),
      src('b.md', scene('s2', map('b.webp'), { FieldSettings: { speed: 2 } }, party('p1'))),
      src('a.md', scene('s2', map('a.webp'), { FieldSettings: { speed: 1 } }, party('p1'))),
      src('data.md', scene('s3', map(), { Currency: 'G' }, item('i1', 'D'), warp('w', 's1'))),
    ]
    const run = (d: FieldSourceDoc[]) =>
      collectFieldNotation({ docs: d, entryPath: 'script.md', entry: { sceneId: 's1' } })
    const base = run(docs)
    const perms = [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]
    for (const p of perms) expect(run(p.map((i) => docs[i]))).toEqual(base)
    expect(base.notation.scenes.find((s) => s.id === 's2')?.map.background).toBe('a.webp')
  })
})

describe('collectFieldNotation: 実 wasm の parseMarkdown から', () => {
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
    '## field1: 野原',
    '',
    '[フィールドマップ 背景=bg1.webp マスク=m1.webp]',
    '[プレイヤー @100,200 向き=下]',
    '[端 右 範囲=200..400 → field2]',
    '[ワープ 扉 → field3 @1,2 演出=フラッシュ]',
    '[揺れ: 縦=6, 周期=600]',
    '[NPC 長老 @500,700 高さ=80]',
    'こんにちは。',
    '[/NPC]',
    '[フラグ: opened = false]',
    '',
    '[イベント 長老の話]',
    '[待機: 100]',
    '[/イベント]',
    '',
    '## field2: 駅前',
    '',
    '[フィールドマップ 背景=bg2.webp マスク=m2.webp]',
    '[端 左 範囲=0..100 → novel1]',
    '',
    '## novel1: 物語',
    '',
    '**A**:',
    'x',
    '',
    '## field3: 家',
    '',
    '[フィールドマップ 背景=bg3.webp マスク=m3.webp]',
    '',
  ].join('\n')
  const data = [
    ...head('data'),
    '## setting: 設定',
    '',
    '[補助通行 条件=opened 速度倍率=0.7]',
    '[フィールド設定 速度=260]',
    '[メニュー項目 save ラベル=きろく]',
    '[通貨名: 円]',
    '[歩行絵 主人公 人物=C001 形態=elementary]',
    '[パーティ p1]',
    '名前: ぼく',
    'HP: 10',
    'ATK: 1',
    'DEF: 1',
    'AGI: 1',
    '[/パーティ]',
    '',
  ].join('\n')

  it('S2 の記法を含む md 文字列から集まる(docs の順序を変えても同じ)', async () => {
    const docs: FieldSourceDoc[] = [
      { path: 'data.md', doc: await parseMarkdown(data) },
      { path: 'script.md', doc: await parseMarkdown(script) },
    ]
    const run = (d: FieldSourceDoc[]) =>
      collectFieldNotation({ docs: d, entryPath: 'script.md', entry: { sceneId: 'field1' } })
    const { notation, warnings } = run(docs)
    expect(warnings).toEqual([])
    expect(notation.scenes.map((s) => s.id)).toEqual(['field1', 'field2', 'field3'])
    expect(notation.exits).toEqual(['novel1'])
    expect(notation.missingScenes).toEqual([])
    const f1 = notation.scenes[0]
    expect(f1.map.background).toBe('bg1.webp')
    expect(f1.playerStart).toMatchObject({ x: 100, y: 200, direction: 'Down' })
    expect(f1.edges[0]).toMatchObject({ direction: 'Right', target: 'field2' })
    expect(f1.shake).toEqual({ amplitude_y: 6, period_ms: 600 })
    expect(f1.npcs[0]).toMatchObject({ name: '長老', height: 80 })
    expect(notation.warps).toMatchObject([{ name: '扉', target: 'field3', effect: 'Flash' }])
    expect(notation.assist).toMatchObject({ conditions: ['opened'], speed_scale: 0.7 })
    expect(notation.settings).toEqual({ speed: 260 })
    expect(notation.menuItems).toEqual([{ id: 'save', label: 'きろく' }])
    expect(notation.currency).toBe('円')
    expect(notation.playerWalk).toMatchObject({ character: 'C001', form: 'elementary' })
    expect(notation.master.partyOrder).toEqual(['p1'])
    expect(notation.flags).toEqual(['opened'])
    expect([...notation.npcEvents.keys()]).toEqual(['長老の話'])
    expect(run([...docs].reverse())).toEqual({ notation, warnings })
  })
})

describe('collectFieldNotation: [トリガー]・[場面移動:] (#1072)', () => {
  const trig = (scene: string, extra: Record<string, unknown> = {}): Event => ({
    RpgTrigger: { scene, ...extra },
  })
  const rpgEvent = (name: string, ...targets: string[]): Event => ({
    RpgEvent: {
      name,
      commands: targets.map((t) => ({ type: 'SceneMove' as const, scene: t })),
    },
  })
  const npc = (id: string, sceneName?: string): Event => ({
    Npc: { id, name: id, x: 1, y: 2, color: 0, message: ['hi'], scene: sceneName } as never,
  })
  const collect = (docs: FieldSourceDoc[]) =>
    collectFieldNotation({ docs, entryPath: 'a.md', entry: { sceneId: 's1' } })

  it('場面の [トリガー] が書いた順に triggers へ入る', () => {
    const { notation, warnings } = collect([
      src(
        'a.md',
        scene(
          's1',
          map(),
          trig('first', { auto: true }),
          trig('second', { x: 10, y: 20, radius: 48, once: true }),
          trig('third', { x: 1, y: 2 })
        ),
        scene('s2', map())
      ),
    ])
    expect(notation.scenes[0].triggers.map((t) => t.scene)).toEqual(['first', 'second', 'third'])
    expect(notation.scenes[0].triggers[1]).toMatchObject({ x: 10, y: 20, radius: 48, once: true })
    expect(warnings).toEqual([])
  })

  it('トリガーが無い場面は triggers が空', () => {
    const { notation } = collect([src('a.md', scene('s1', map()))])
    expect(notation.scenes[0].triggers).toEqual([])
  })

  it('トリガー経由の [場面移動:] の行き先が閉包に入る', () => {
    const { notation, warnings } = collect([
      src(
        'a.md',
        scene('s1', map(), trig('go', { auto: true }), rpgEvent('go', 's2')),
        scene('s2', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(warnings).toEqual([])
  })

  it('NPC の scene= 経由の [場面移動:] の行き先も閉包に入る', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene('s1', map(), npc('n1', 'talk'), rpgEvent('talk', 's2')),
        scene('s2', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('別 doc に書かれたイベントの行き先も拾う', () => {
    const { notation } = collect([
      src('a.md', scene('s1', map(), trig('go', { auto: true }))),
      src('b.md', scene('s2', map()), scene('holder', rpgEvent('go', 's2'))),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('行き先に [フィールドマップ] が無い場面は exits、docs に無ければ missingScenes', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene('s1', map(), trig('go', { auto: true }), rpgEvent('go', 'novel', 'ghost')),
        scene('novel')
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1'])
    expect(notation.exits).toEqual(['novel'])
    expect(notation.missingScenes).toEqual(['ghost'])
  })

  it('存在しないイベント名を指していても閉包は壊れない', () => {
    const { notation } = collect([
      src('a.md', scene('s1', map(), trig('nope', { auto: true }), npc('n1', 'nope2'))),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1'])
    expect(notation.missingScenes).toEqual([])
  })

  it('同名イベントは先勝ちで、後のイベントの行き先は拾わない', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene('s1', map(), trig('go', { auto: true }), rpgEvent('go', 's2'), rpgEvent('go', 's3')),
        scene('s2', map()),
        scene('s3', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('場面移動の循環 A→B→A で無限ループしない', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene('s1', map(), trig('toB', { auto: true }), rpgEvent('toB', 's2')),
        scene('s2', map(), trig('toA', { auto: true }), rpgEvent('toA', 's1'))
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('実 wasm: [トリガー 半径=…] と [場面移動:] が閉包・triggers に反映される', async () => {
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: 一',
      '',
      '[フィールドマップ 背景=a.webp マスク=am.webp]',
      '[プレイヤー @1,2 向き=下]',
      '[トリガー @100,200 半径=48 scene=行く once=true]',
      '[トリガー auto scene=始まり]',
      '',
      '[イベント 行く]',
      '[場面移動: s2 @5,6 向き=上]',
      '[/イベント]',
      '',
      '[イベント 始まり]',
      '> はじまり。',
      '[/イベント]',
      '',
      '## s2: 二',
      '',
      '[フィールドマップ 背景=b.webp マスク=bm.webp]',
      '[プレイヤー @3,4 向き=下]',
      '',
    ].join('\n')
    const { notation, warnings } = collect([{ path: 'a.md', doc: await parseMarkdown(md) }])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(notation.scenes[0].triggers).toMatchObject([
      { x: 100, y: 200, radius: 48, scene: '行く', once: true },
      { auto: true, scene: '始まり' },
    ])
    expect(warnings).toEqual([])
  })
})

describe('collectSceneMoveTargets: 戦闘の 次= を辿る (#1143)', () => {
  type Cmd = FieldScriptEvents extends Map<string, infer V> ? V[number] : never
  const move = (s: string): Cmd => ({ type: 'SceneMove', scene: s }) as Cmd
  const battle = (id: string): Cmd => ({ type: 'Battle', id }) as Cmd
  const evs = (o: Record<string, Cmd[]>): FieldScriptEvents => new Map(Object.entries(o))
  const rules = (o: Record<string, string[]>) => new Map(Object.entries(o))

  it('場面移動だけのイベントは従来どおり行き先を返す', () => {
    expect(collectSceneMoveTargets(['a'], evs({ a: [move('B')] }), rules({}))).toEqual(['B'])
  })

  it.each([
    ['勝利時', '勝利時: 次=after'],
    ['敗北時', '敗北時: 次=after'],
    ['中断時', '中断時: 次=after'],
    ['逃走時', '逃走時: 次=after'],
  ])('%s の 次= が指すイベントの場面移動を拾う', (_n, line) => {
    const r = collectSceneMoveTargets(
      ['a'],
      evs({ a: [battle('b')], after: [move('B')] }),
      rules({ b: ['敵: x', line] })
    )
    expect(r).toEqual(['B'])
  })

  it('4 つの終わり方がそれぞれ別イベントを指すとき全部拾う', () => {
    const r = collectSceneMoveTargets(
      ['a'],
      evs({ a: [battle('b')], w: [move('W')], l: [move('L')], i: [move('I')], e: [move('E')] }),
      rules({ b: ['勝利時: 次=w', '敗北時: 次=l', '中断時: 次=i', '逃走時: 次=e'] })
    )
    expect([...r].sort()).toEqual(['E', 'I', 'L', 'W'])
  })

  it('次= が無い戦闘宣言は何も足さない', () => {
    const r = collectSceneMoveTargets(
      ['a'],
      evs({ a: [battle('b'), move('B')] }),
      rules({ b: ['勝利時: フラグ=f=true'] })
    )
    expect(r).toEqual(['B'])
  })

  it('連鎖 イベント→戦闘→イベント→戦闘→場面移動 を辿る', () => {
    const r = collectSceneMoveTargets(
      ['a'],
      evs({ a: [battle('b1')], mid: [battle('b2')], end: [move('Z')] }),
      rules({ b1: ['勝利時: 次=mid'], b2: ['中断時: 次=end'] })
    )
    expect(r).toEqual(['Z'])
  })

  it('互いに指す循環(イベント↔戦闘)で止まる', () => {
    const r = collectSceneMoveTargets(
      ['a'],
      evs({ a: [battle('b1'), move('A')], c: [battle('b2'), move('C')] }),
      rules({ b1: ['勝利時: 次=c'], b2: ['勝利時: 次=a'] })
    )
    expect([...r].sort()).toEqual(['A', 'C'])
  })

  it('自分自身を指す 次= でも止まる', () => {
    const r = collectSceneMoveTargets(
      ['a'],
      evs({ a: [battle('b')] }),
      rules({ b: ['敗北時: 次=a'] })
    )
    expect(r).toEqual([])
  })

  it('戦闘宣言が無い・次= の先のイベントが無いときは落ちずに無視する', () => {
    expect(
      collectSceneMoveTargets(['a'], evs({ a: [battle('none'), move('B')] }), rules({}))
    ).toEqual(['B'])
    expect(
      collectSceneMoveTargets(['a'], evs({ a: [battle('b')] }), rules({ b: ['勝利時: 次=ghost'] }))
    ).toEqual([])
    expect(collectSceneMoveTargets(['nope'], evs({}), rules({}))).toEqual([])
  })

  it('壊れた rules 行があっても落ちない', () => {
    expect(
      collectSceneMoveTargets(
        ['a'],
        evs({ a: [battle('b')] }),
        rules({ b: ['???', '勝利時: 次=', 'キー: 値'] })
      )
    ).toEqual([])
  })
})

describe('collectFieldNotation: 戦闘の 次= 経由の [場面移動:] (#1143)', () => {
  const rpgEvent = (name: string, ...cmds: Array<{ type: string; [k: string]: unknown }>): Event =>
    ({ RpgEvent: { name, commands: cmds } }) as unknown as Event
  const battleDef = (id: string, ...rules: string[]): Event =>
    ({ BattleScript: { id, rules } }) as unknown as Event
  const trig = (sceneName: string): Event => ({ RpgTrigger: { scene: sceneName, auto: true } })
  const npc = (id: string, sceneName: string): Event =>
    ({
      Npc: { id, name: id, x: 1, y: 2, color: 0, message: ['hi'], scene: sceneName },
    }) as never
  const mv = (s: string) => ({ type: 'SceneMove', scene: s })
  const bt = (id: string) => ({ type: 'Battle', id })
  const collect = (docs: FieldSourceDoc[]) =>
    collectFieldNotation({ docs, entryPath: 'a.md', entry: { sceneId: 's1' } })

  it('auto トリガー→戦闘→中断時 次= のイベントの [場面移動:] で B が scenes に入る', () => {
    const { notation, warnings } = collect([
      src(
        'a.md',
        scene(
          's1',
          map(),
          trig('start'),
          rpgEvent('start', bt('b')),
          battleDef('b', '敵: x', '中断時: 次=after'),
          rpgEvent('after', mv('B'))
        ),
        scene('B', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 'B'])
    expect(warnings).toEqual([])
  })

  it('NPC の scene= 経由でも同じ連鎖を辿る', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene(
          's1',
          map(),
          npc('n1', 'talk'),
          rpgEvent('talk', bt('b')),
          battleDef('b', '勝利時: 次=after'),
          rpgEvent('after', mv('B'))
        ),
        scene('B', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 'B'])
  })

  it('戦闘宣言・次= の先のイベントが別 md にあっても拾う', () => {
    const { notation } = collect([
      src('a.md', scene('s1', map(), trig('start'), rpgEvent('start', bt('b')))),
      src('b.md', scene('h1', battleDef('b', '敗北時: 次=after'))),
      src('c.md', scene('h2', rpgEvent('after', mv('B'))), scene('B', map())),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 'B'])
  })

  it('同 id の戦闘宣言は先勝ち(後の宣言の 次= は拾わない)', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene(
          's1',
          map(),
          trig('start'),
          rpgEvent('start', bt('b')),
          battleDef('b', '勝利時: 次=e1'),
          battleDef('b', '勝利時: 次=e2'),
          rpgEvent('e1', mv('B')),
          rpgEvent('e2', mv('C'))
        ),
        scene('B', map()),
        scene('C', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 'B'])
  })

  it('戦闘宣言が無い [戦闘: id] でも閉包は壊れない', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene('s1', map(), trig('start'), rpgEvent('start', bt('none'), mv('B'))),
        scene('B', map())
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 'B'])
  })

  it('行き先が閉包外のとき exits / missingScenes に入る', () => {
    const { notation } = collect([
      src(
        'a.md',
        scene(
          's1',
          map(),
          trig('start'),
          rpgEvent('start', bt('b')),
          battleDef('b', '勝利時: 次=e1', '敗北時: 次=e2'),
          rpgEvent('e1', mv('novel')),
          rpgEvent('e2', mv('ghost'))
        ),
        scene('novel')
      ),
    ])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1'])
    expect(notation.exits).toEqual(['novel'])
    expect(notation.missingScenes).toEqual(['ghost'])
  })

  it('実 wasm: [戦闘] の 中断時: 次=after → [場面移動:] の行き先が scenes に入る', async () => {
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: 一',
      '',
      '[フィールドマップ 背景=a.webp マスク=am.webp]',
      '[プレイヤー @1,2 向き=下]',
      '[トリガー auto scene=始まり]',
      '',
      '[戦闘 b]',
      '名前: 試合',
      '敵: x',
      '中断時: 次=後日談',
      '[/戦闘]',
      '',
      '[イベント 始まり]',
      '> 勝負。',
      '[戦闘: b]',
      '[/イベント]',
      '',
      '[イベント 後日談]',
      '[場面移動: s2 @5,6 向き=上]',
      '[/イベント]',
      '',
      '## s2: 二',
      '',
      '[フィールドマップ 背景=b.webp マスク=bm.webp]',
      '[プレイヤー @3,4 向き=下]',
      '',
    ].join('\n')
    const { notation } = collect([{ path: 'a.md', doc: await parseMarkdown(md) }])
    expect(notation.scenes.map((s) => s.id)).toEqual(['s1', 's2'])
  })
})
