// #943: RPG モード（TopDown）への感情吹き出しの接続。純関数・薄い関数と、実パーサ経路
// （parseMarkdown → rpgProjectFromDoc → EventRunner → emotionHost）を縛る。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
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
