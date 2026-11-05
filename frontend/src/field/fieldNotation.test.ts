// #1120 (S3c): collectFieldNotation の単体テスト。手組みの EventDocument と、実 wasm 経由の parseMarkdown の両方で見る。
import { describe, expect, it } from 'vitest'
import type { Event, EventDocument, EventScene } from '../types'
import { parseMarkdown } from '../wasm/parser'
import { collectFieldNotation, type FieldSourceDoc } from './fieldNotation'

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
      "場面 ID 's1' が複数あります（a.md / b.md）。先頭の a.md のものを使い、b.md のものは無視します"
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
    expect(warnings.some((w) => w.startsWith('[通貨名:] が複数あります'))).toBe(true)
    expect(warnings.some((w) => w.startsWith('[メニュー項目 save] が複数あります'))).toBe(true)
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
        `場面 s1（a.md） に ${label} が複数あります。先頭のものを使い、残りは無視します`
      )
    }
    expect(warnings.some((w) => w.startsWith('[ワープ w] が複数あります'))).toBe(true)
  })

  it('同じ path の md が重複して渡されたら 1 つだけ使って警告', () => {
    const { warnings } = collectFieldNotation({
      docs: [src('a.md', scene('s1', map())), src('a.md', scene('s1', map()))],
      entryPath: 'a.md',
      entry: { sceneId: 's1' },
    })
    expect(warnings).toContain("md 'a.md' が複数渡されています。先頭のものを使い、残りは無視します")
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
