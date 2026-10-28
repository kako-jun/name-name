// #943: RPG モード（TopDown）への感情吹き出しの接続。純関数・薄い関数と、実パーサ経路
// （parseMarkdown → rpgProjectFromDoc → EventRunner → emotionHost）を縛る。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container, Texture } from 'pixi.js'
import { parseMarkdown } from '../wasm/parser'
import { rpgProjectFromDoc } from './rpgProjectFromDoc'
import { EventRunner } from './eventRunner'
import { createFieldEmotionHost } from './fieldScript'
import { TopDownRenderer } from './TopDownRenderer'
import type { RPGProject } from '../types/rpg'
import type { DialogBox } from './DialogBox'
import {
  canShowTopDownEmotion,
  loadTopDownEmotionSheets,
  topDownEmotionContext,
  topDownEmotionHeads,
} from './topDownEmotion'

const SHEETS_JSON = JSON.stringify({
  びっくり: { image: 'fx/bikkuri.png', scale: 0.4 },
  はてな: { image: 'fx/hatena.png' },
})
const ok = (body: string) => () => Promise.resolve(new Response(body, { status: 200 }))

afterEach(() => vi.restoreAllMocks())

describe('loadTopDownEmotionSheets', () => {
  it('パス未指定は undefined（fetch しない）', async () => {
    const f = vi.fn()
    expect(await loadTopDownEmotionSheets(undefined, 'http://h/a', f)).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })
  it('JSON は assets ルート直下から読み、絵のパスは images/ 配下に解決する', async () => {
    const f = vi.fn(ok(SHEETS_JSON))
    const sheets = await loadTopDownEmotionSheets('data/emo.json', 'http://h/a/', f)
    expect(f).toHaveBeenCalledWith('http://h/a/data/emo.json')
    expect(Object.keys(sheets ?? {})).toEqual(['びっくり', 'はてな'])
    expect(sheets?.びっくり.image).toBe('http://h/a/images/fx/bikkuri.png')
    expect(sheets?.びっくり.scale).toBe(0.4)
  })
  it('HTTP エラー・不正 JSON・空の宣言は警告して undefined（ゲームは止めない）', async () => {
    const warn = vi.fn()
    expect(
      await loadTopDownEmotionSheets(
        'e.json',
        undefined,
        () => Promise.resolve(new Response('', { status: 404 })),
        warn
      )
    ).toBeUndefined()
    expect(await loadTopDownEmotionSheets('e.json', undefined, ok('{bad'), warn)).toBeUndefined()
    expect(await loadTopDownEmotionSheets('e.json', undefined, ok('{}'), warn)).toBeUndefined()
    expect(
      await loadTopDownEmotionSheets(
        'e.json',
        undefined,
        () => Promise.reject(new Error('net')),
        warn
      )
    ).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe('canShowTopDownEmotion', () => {
  const st = (over = {}) => ({ battleBusy: false, npcIds: new Set(['kid']), ...over })
  it('主人公・このマップの NPC は出せる。別マップの NPC・同行者は出せない', () => {
    expect(canShowTopDownEmotion('player', st())).toBe(true)
    expect(canShowTopDownEmotion('npc:kid', st())).toBe(true)
    expect(canShowTopDownEmotion('npc:ghost', st())).toBe(false)
    expect(canShowTopDownEmotion('companion', st())).toBe(false)
  })
  it('戦闘中は何も出せない', () => {
    expect(canShowTopDownEmotion('player', st({ battleBusy: true }))).toBe(false)
    expect(canShowTopDownEmotion('npc:kid', st({ battleBusy: true }))).toBe(false)
  })
})

describe('topDownEmotionHeads', () => {
  it('人物の中心から高さの半分だけ上（表示上端の中央）。NPC は npc:<id>', () => {
    const h = topDownEmotionHeads({ x: 100, y: 200, height: 28 }, [
      { id: 'kid', x: 50, y: 80, height: 40 },
    ])
    expect(h.player).toEqual({ x: 100, y: 186 })
    expect(h['npc:kid']).toEqual({ x: 50, y: 60 })
    expect(h.companion).toBeUndefined()
  })
  it('主人公が居なければ player は無い', () => {
    expect(topDownEmotionHeads(null, []).player).toBeUndefined()
  })
})

describe('実パーサ経路: parseMarkdown → rpgProjectFromDoc → EventRunner → emotionHost', () => {
  const md = (front: string) =>
    [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      front,
      '---',
      '',
      '## map: village',
      '',
      '[マップ 5x3 タイル=32]',
      'GGGGG',
      'GGGGG',
      'GGGGG',
      '[/マップ]',
      '',
      '[プレイヤー @1,1 向き=下]',
      '[NPC 近所の子 @3,1 色=#ff0000 scene=子の話]',
      '本文',
      '[/NPC]',
      '',
      '[イベント 子の話]',
      '[感情: 近所の子, びっくり]',
      '[感情: 主人公, はてな, 持続=900]',
      '[感情: 同行者, びっくり]',
      '[感情: アキラ, びっくり]',
      '[感情: 近所の子, 未宣言]',
      '[/イベント]',
      '',
    ].join('\n')

  async function run(front: string, sheets: Awaited<ReturnType<typeof loadTopDownEmotionSheets>>) {
    const doc = await parseMarkdown(md(front))
    const project = rpgProjectFromDoc(doc) as RPGProject
    const show = vi.fn(() => true)
    const warn = vi.fn()
    const host = createFieldEmotionHost(
      () =>
        topDownEmotionContext(
          sheets ?? {},
          project.protagonist,
          project.npcs.map((n) => ({ id: n.id, name: n.name }))
        ),
      show,
      warn,
      '[name-name]'
    )
    const dialog = {
      isTyping: () => false,
      skipTypewriter() {},
      isShowing: false,
      show() {},
      hide() {},
    }
    const runner = new EventRunner(
      dialog as unknown as DialogBox,
      { moveNpcTo: () => Promise.resolve() },
      undefined,
      host
    )
    const cmds = project.rpgEvents?.find((e) => e.name === '子の話')?.commands ?? []
    runner.run(cmds)
    return { project, show, warn, cmds }
  }

  it('field_emotions と protagonist が RPGProject に載り、NPC・主人公へ解決して持続も渡る', async () => {
    const sheets = await loadTopDownEmotionSheets('emo.json', undefined, ok(SHEETS_JSON))
    const { project, show, warn, cmds } = await run(
      'field_emotions: "emo.json"\nprotagonist: アキラ',
      sheets
    )
    expect(project.fieldEmotions).toBe('emo.json')
    expect(project.protagonist).toBe('アキラ')
    expect(cmds.filter((c) => c.type === 'Emotion')).toHaveLength(5)
    const id = project.npcs[0].id
    expect(show.mock.calls).toEqual([
      [`npc:${id}`, 'びっくり', undefined],
      ['player', 'はてな', 900],
      ['companion', 'びっくり', undefined], // 解決はされる（TopDown では canShow が false で出ない）
      ['player', 'びっくり', undefined], // 主人公の話者名（アキラ）
    ])
    // 未宣言の種類は警告して出さない
    expect(warn.mock.calls.flat().join('\n')).toContain('未宣言')
  })

  it('宣言なし（field_emotions 無し）の脚本は従来どおり: 吹き出しは出さず警告のみで最後まで進む', async () => {
    const { project, show, warn } = await run('', undefined)
    expect(project.fieldEmotions).toBeUndefined()
    expect(show).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})

describe('TopDownRenderer の配線（層は偽物）', () => {
  function field(npcs: RPGProject['npcs'], over: Partial<RPGProject> = {}) {
    const r = new TopDownRenderer()
    const i = r as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    i.app = { stage: new Container() }
    i.screenWidth = 800
    i.screenHeight = 600
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no net'))
    r.load({
      name: 't',
      version: '1',
      map: {
        width: 9,
        height: 9,
        tileSize: 32,
        tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
      },
      player: { x: 4, y: 4, direction: 'down' },
      npcs,
      view: 'topdown',
      ...over,
    } as RPGProject)
    i.initialized = true
    return i
  }
  const kid = { id: 'kid', name: '近所の子', x: 2, y: 2, message: 'm', color: 0xff0000 }
  const fakeLayer = () => ({
    show: vi.fn(() => true),
    tick: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
  })

  it('emotionHost: 主人公／NPC 名を解決して層に渡す。層が無ければ出さない（読み飛ばし）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const i = field([kid], { protagonist: 'アキラ' })
    const host = i.createEmotionHost()
    i.emotionSheets = { びっくり: {} }
    host.showEmotion('近所の子', 'びっくり', 500) // 層なし
    const layer = fakeLayer()
    i.emotionLayer = layer
    host.showEmotion('近所の子', 'びっくり', 500)
    host.showEmotion('アキラ', 'びっくり')
    host.showEmotion('同行者', 'びっくり')
    expect(layer.show.mock.calls).toEqual([
      ['npc:kid', 'びっくり', 500],
      ['player', 'びっくり', undefined],
    ])
  })

  it('tick: 人物の頭上へ置く。戦闘中は消して進めない。再 load で層を捨てる（NPC の吹き出しはマップごと）', () => {
    const i = field([kid])
    const layer = fakeLayer()
    i.emotionLayer = layer
    i.tickEmotions(16)
    const heads = layer.tick.mock.calls[0][1]
    expect(Object.keys(heads).sort()).toEqual(['npc:kid', 'player'])
    expect(heads['npc:kid'].y).toBeLessThan(i.npcs[0].container.y)
    // 主人公は中心から色四角の高さ（tileSize-4=28）の半分だけ上
    expect(heads.player.y).toBe(i.playerContainer.y - 14)
    layer.tick.mockClear()
    i.onTick() // 毎フレームの tick から吹き出しの時間が進む
    expect(layer.tick).toHaveBeenCalledOnce()
    i.battleScreen = {}
    layer.tick.mockClear()
    i.tickEmotions(16)
    expect(layer.clear).toHaveBeenCalledOnce()
    expect(layer.tick).not.toHaveBeenCalled()
    i.battleScreen = null
    i.load({ ...i.gameData })
    expect(layer.destroy).toHaveBeenCalledOnce()
    expect(i.emotionLayer).toBeNull()
  })
})

describe('TopDownRenderer: 読み込み中の [感情:]・世代・配線 (#943 レビュー)', () => {
  const EMO = JSON.stringify({ びっくり: { image: 'fx/b.png', durationMs: 3000 } })
  const flush = async () => {
    for (let n = 0; n < 8; n++) await new Promise((r) => setTimeout(r, 0))
  }
  const dialog = () => ({
    isTyping: () => false,
    skipTypewriter() {},
    isShowing: false,
    show() {},
    hide() {},
  })
  const kid = { id: 'kid', name: '近所の子', x: 2, y: 2, message: 'm', color: 0xff0000 }
  const proj = (over: Partial<RPGProject> = {}) =>
    ({
      name: 't',
      version: '1',
      map: {
        width: 9,
        height: 9,
        tileSize: 32,
        tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
      },
      player: { x: 4, y: 4, direction: 'down' },
      npcs: [kid],
      view: 'topdown',
      fieldEmotions: 'emo.json',
      rpgEvents: [
        {
          name: 'op',
          commands: [
            { type: 'Emotion', target: '近所の子', kind: 'びっくり' },
            { type: 'Emotion', target: '主人公', kind: 'びっくり', duration_ms: 500 },
          ],
        },
      ],
      triggers: [{ scene: 'op', auto: true }],
      ...over,
    }) as unknown as RPGProject
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function make(): { r: TopDownRenderer; i: Record<string, any> } {
    const r = new TopDownRenderer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i = r as unknown as Record<string, any>
    i.app = { stage: new Container(), ticker: { remove() {} }, renderer: {}, destroy() {} }
    i.screenWidth = 800
    i.screenHeight = 600
    i.loadEmotionTextures = async (sheets: Record<string, { image: string }>) =>
      new Map(Object.values(sheets).map((x) => [x.image, Texture.WHITE]))
    i.dialogBox = dialog()
    i.eventRunner = i.createEventRunner(i.dialogBox, { moveNpcTo: () => Promise.resolve() })
    i.initialized = true
    return { r, i }
  }
  /** 取得を手動で解決できる fetch */
  function deferredFetch() {
    const waiting: ((res: Response) => void)[] = []
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((res) => waiting.push(res)))
    return {
      f,
      resolveAll: (body = EMO, status = 200) =>
        waiting.forEach((w) => w(new Response(body, { status }))),
    }
  }

  it('M1: 読み込み中に走った auto トリガーの [感情:] を、層ができた時点で残りの持続で再生する。「未宣言」の誤警告は出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    const d = deferredFetch()
    r.load(proj()) // auto トリガーはここで同期的に走る（層はまだ無い）
    expect(i.emotionLayer).toBeNull()
    expect(i.pendingEmotions).toHaveLength(2)
    d.resolveAll()
    await flush()
    const act = i.emotionLayer.active()
    expect(Object.keys(act).sort()).toEqual(['npc:kid', 'player'])
    expect(act.player.kind).toBe('びっくり')
    expect(i.pendingEmotions).toHaveLength(0)
    expect(warn.mock.calls.flat().join('\n')).not.toContain('未宣言')
    expect(warn.mock.calls.flat().join('\n')).not.toContain('宣言がありません')
  })

  it('M1: 読み込み中に持続が過ぎた分は再生しない（残り持続）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    const d = deferredFetch()
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(1000)
    r.load(proj()) // 主人公は 500ms、NPC は宣言の 3000ms
    now.mockReturnValue(1700) // 700ms 経過
    d.resolveAll()
    await flush()
    expect(Object.keys(i.emotionLayer.active())).toEqual(['npc:kid']) // 主人公の 500ms は過ぎた
  })

  it('M1: 読み込み失敗は溜めた分を捨て、「読み込めなかった」警告を 1 回だけ出す（未宣言の誤警告なし）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    const d = deferredFetch()
    r.load(proj())
    d.resolveAll('', 404)
    await flush()
    expect(i.emotionLayer).toBeNull()
    expect(i.pendingEmotions).toHaveLength(0)
    const text = warn.mock.calls.map((c) => String(c[0]))
    expect(text.filter((t) => t.includes('読み込めなかったため'))).toHaveLength(1)
    expect(text.join('\n')).not.toContain('未宣言')
    // 読み込みが終わったあとの [感情:] は通常の経路（宣言なし＝未宣言の警告）
    i.eventRunner.run([{ type: 'Emotion', target: '主人公', kind: 'びっくり' }])
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('宣言がありません')
  })

  it('M1: 溜める件数に上限があり、load の世代が変わったら破棄する', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    deferredFetch()
    const many = Array.from({ length: 50 }, () => ({
      type: 'Emotion',
      target: '主人公',
      kind: 'びっくり',
    }))
    r.load(proj({ rpgEvents: [{ name: 'op', commands: many }] } as never))
    expect(i.pendingEmotions).toHaveLength(32)
    r.load(proj({ fieldEmotions: undefined, triggers: [] }))
    expect(i.pendingEmotions).toHaveLength(0)
    expect(i.emotionLoading).toBe(false)
  })

  it('S1: load(A) → load(B) → A の取得が後から解決しても、A の層は world に残らない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    const d = deferredFetch()
    r.load(proj({ triggers: [] }))
    r.load(proj({ fieldEmotions: undefined, triggers: [] })) // B は宣言なし
    d.resolveAll()
    await flush()
    expect(i.emotionLayer).toBeNull()
    expect(i.world.children.some((c: { label?: string }) => c.label === 'FieldEmotionLayer')).toBe(
      false
    )
  })

  it('S1: 取得は済んで絵の読み込み中に load し直されても、古い層は作らない（絵は読みにも行かない）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    const calls: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => (release = res))
    i.loadEmotionTextures = async (sheets: Record<string, { image: string }>) => {
      calls.push('load')
      await gate
      return new Map(Object.values(sheets).map((x) => [x.image, Texture.WHITE]))
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(EMO))
    r.load(proj({ triggers: [] }))
    await flush() // A: 取得済み・絵の読み込み待ち
    expect(calls).toEqual(['load'])
    r.load(proj({ fieldEmotions: undefined, triggers: [] }))
    release()
    await flush()
    expect(i.emotionLayer).toBeNull()
    // 取得中に load し直された場合は絵の読み込みにも進まない
    const d = deferredFetch()
    r.load(proj({ triggers: [] }))
    r.load(proj({ fieldEmotions: undefined, triggers: [] }))
    d.resolveAll()
    await flush()
    expect(calls).toEqual(['load'])
  })

  it('S1: destroy 中の取得が後から解決しても、層を作らない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    const d = deferredFetch()
    r.load(proj({ triggers: [] }))
    r.destroy()
    d.resolveAll()
    await flush()
    expect(i.emotionLayer).toBeNull()
    expect(i.world.children.some((c: { label?: string }) => c.label === 'FieldEmotionLayer')).toBe(
      false
    )
  })

  it('S2: 設定オーバーレイ中（isSuspended）は onTick を回しても吹き出しの時間が進まない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(EMO))
    r.load(proj({ triggers: [] }))
    await flush()
    i.emotionLayer.show('player', 'びっくり')
    i.lastTickMs = performance.now() - 100
    r.setInputSuspended(true)
    i.onTick()
    expect(i.emotionLayer.active().player.elapsed).toBe(0)
    r.setInputSuspended(false)
    i.lastTickMs = performance.now() - 100
    i.onTick()
    expect(i.emotionLayer.active().player.elapsed).toBeGreaterThan(0)
  })

  it('S4: createEventRunner が emotionHost を渡している（[感情:] が層まで届く）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r, i } = make()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(EMO))
    r.load(proj({ triggers: [] }))
    await flush()
    i.eventRunner.run([{ type: 'Emotion', target: '近所の子', kind: 'びっくり' }])
    expect(Object.keys(i.emotionLayer.active())).toEqual(['npc:kid'])
  })
})
