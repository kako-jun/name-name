// #943: frontmatter `field_emotions` と脚本 `[感情:]` を、実パーサ（parseMarkdown。WASM 同梱）経由で
// Document にし、そこから吹き出し指示へ解決するまでを通しで縛る。
import { describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import type { Event } from '../types'
import { EMOTION_MAX_DURATION_MS } from './fieldEmotion'
import {
  loadEmotionSheets,
  mergeEmotionSheets,
  parseFieldEmotionsText,
  resolveEmotion,
} from './fieldEmotionScript'

function md(frontmatterExtra: string, body: string): string {
  return `---\nengine: name-name\nchapter: 1\ntitle: t\n${frontmatterExtra}---\n\n## 1-1: s\n\n${body}\n`
}

const SHEETS = JSON.stringify({ びっくり: { image: 'e/bikkuri.png' }, '？': { image: 'e/q.png' } })

describe('parseMarkdown 経由の field_emotions / [感情:]', () => {
  it('frontmatter のパスが Document に出て、未指定は null', async () => {
    const doc = await parseMarkdown(
      md('field_emotions: data/emotions.json\n', '[感情: 主人公, びっくり]')
    )
    expect(doc.field_emotions).toBe('data/emotions.json')
    const none = await parseMarkdown(md('', '[感情: 主人公, びっくり]'))
    expect(none.field_emotions).toBeNull()
  })

  it('[感情:] は Emotion イベントになり、持続の有無が duration_ms に出る', async () => {
    const doc = await parseMarkdown(
      md('', '[感情: 主人公, びっくり]\n\n[感情: 花子, ？, 持続=1200]')
    )
    const emotions = doc.chapters[0].scenes[0].events.filter(
      (e): e is Extract<Event, { Emotion: unknown }> => typeof e === 'object' && 'Emotion' in e
    )
    expect(emotions.map((e) => e.Emotion)).toEqual([
      { target: '主人公', kind: 'びっくり', duration_ms: null },
      { target: '花子', kind: '？', duration_ms: 1200 },
    ])
  })

  it('Document → 解決まで通す: 主人公/protagonist/同行者名は対象、未宣言種類と未知の対象は警告して無視', async () => {
    const doc = await parseMarkdown(
      md(
        'protagonist: せお\nfield_emotions: x.json\n',
        '[感情: 主人公, びっくり]\n\n[感情: せお, ？, 持続=99999999]\n\n[感情: 花子, ？]\n\n[感情: 主人公, 未宣言]\n\n[感情: 太郎, ？]'
      )
    )
    const { emotions, warnings } = parseFieldEmotionsText(SHEETS)
    expect(warnings).toEqual([])
    const ctx = { emotions, protagonist: doc.protagonist, companionName: '花子' }
    const evs = doc.chapters[0].scenes[0].events.flatMap((e) =>
      typeof e === 'object' && 'Emotion' in e ? [e.Emotion] : []
    )
    const out = evs.map((e) => resolveEmotion(e, ctx))
    expect(out.map((r) => r.command)).toEqual([
      { target: 'player', kind: 'びっくり' },
      { target: 'player', kind: '？', durationMs: EMOTION_MAX_DURATION_MS },
      { target: 'companion', kind: '？' },
      null,
      null,
    ])
    expect(out[3].warnings[0]).toContain('未宣言')
    expect(out[4].warnings[0]).toContain('太郎')
  })
})

describe('parseFieldEmotionsText', () => {
  it('正しい JSON は parseEmotions と同じ検証を通る（不正な種類だけ警告して無視）', () => {
    const r = parseFieldEmotionsText(
      JSON.stringify({ ok: { image: 'a.png' }, bad: { image: 'a.png', frames: 0 } })
    )
    expect(Object.keys(r.emotions)).toEqual(['ok'])
    expect(r.warnings.length).toBe(1)
  })
  it('JSON でない・オブジェクトでないものは警告して空', () => {
    for (const t of ['{oops', '[]', '"x"', 'null']) {
      const r = parseFieldEmotionsText(t)
      expect(r.emotions).toEqual({})
      expect(r.warnings.length).toBe(1)
    }
  })
})

describe('resolveEmotion: Object.prototype のキーは未宣言として弾く', () => {
  it('toString / __proto__ / constructor', () => {
    const { emotions } = parseFieldEmotionsText(SHEETS)
    for (const kind of ['toString', '__proto__', 'constructor']) {
      const r = resolveEmotion({ target: '主人公', kind }, { emotions })
      expect(r.command, kind).toBeNull()
      expect(r.warnings[0], kind).toContain('宣言')
    }
  })
})

describe('mergeEmotionSheets (#946)', () => {
  const sheet = (image: string) => ({
    image,
    frames: 1,
    columns: 1,
    frameMs: 120,
    durationMs: 1000,
    offset: { x: 0, y: 0 },
    scale: 1,
    motion: 'none' as const,
  })
  it('同名はインラインが優先、別名は両方残る', () => {
    const m = mergeEmotionSheets(
      { '!': sheet('inline.png') },
      { '!': sheet('external.png'), '?': sheet('q.png') }
    )
    expect(m?.['!'].image).toBe('inline.png')
    expect(m?.['?'].image).toBe('q.png')
    expect(Object.keys(m ?? {}).sort()).toEqual(['!', '?'])
  })
  it('片方だけでも使える。どちらも空・未指定なら undefined', () => {
    expect(mergeEmotionSheets(undefined, { '?': sheet('q.png') })?.['?'].image).toBe('q.png')
    expect(mergeEmotionSheets({ '!': sheet('a.png') }, undefined)?.['!'].image).toBe('a.png')
    expect(mergeEmotionSheets(undefined, undefined)).toBeUndefined()
    expect(mergeEmotionSheets({}, {})).toBeUndefined()
  })
})

describe('resolveEmotion: NPC・同行者の固定名・持続の正規化 (#946)', () => {
  const { emotions } = parseFieldEmotionsText(SHEETS)
  const npcs = [
    { id: 'kid', name: '近所の子' },
    { id: 'kid2', name: '近所の子' },
    { id: 'gate', name: '門番' },
  ]
  it('NPC の話者名は npc:<id>（同名は先勝ち）。主人公・同行者が優先される', () => {
    expect(
      resolveEmotion({ target: '近所の子', kind: 'びっくり' }, { emotions, npcs }).command
    ).toEqual({
      target: 'npc:kid',
      kind: 'びっくり',
    })
    expect(resolveEmotion({ target: '門番', kind: '？' }, { emotions, npcs }).command?.target).toBe(
      'npc:gate'
    )
    // 同行者名が NPC 名と被ったら同行者
    expect(
      resolveEmotion({ target: '門番', kind: '？' }, { emotions, npcs, companionName: '門番' })
        .command?.target
    ).toBe('companion')
    expect(
      resolveEmotion({ target: '主人公', kind: '？' }, { emotions, npcs }).command?.target
    ).toBe('player')
  })
  it('固定の対象名 `同行者` は同行者名が無くても companion', () => {
    expect(resolveEmotion({ target: '同行者', kind: '？' }, { emotions }).command?.target).toBe(
      'companion'
    )
  })
  it('いない NPC は警告して無視', () => {
    const r = resolveEmotion({ target: '幽霊', kind: '？' }, { emotions, npcs })
    expect(r.command).toBeNull()
    expect(r.warnings[0]).toContain('幽霊')
  })
  it('持続: 0<d<1 は durationMs を付けない・小数は floor・null/0 も付けない', () => {
    const ctx = { emotions }
    const dur = (d: number | null | undefined) =>
      resolveEmotion({ target: '主人公', kind: '？', duration_ms: d }, ctx).command
    expect(dur(0.5)).toEqual({ target: 'player', kind: '？' })
    expect(dur(1200.9)).toEqual({ target: 'player', kind: '？', durationMs: 1200 })
    expect(dur(null)).toEqual({ target: 'player', kind: '？' })
    expect(dur(0)).toEqual({ target: 'player', kind: '？' })
  })
})

describe('loadEmotionSheets (#946: fetch → parse → merge・失敗時)', () => {
  const sheet = (image: string) => ({
    image,
    frames: 1,
    columns: 1,
    frameMs: 120,
    durationMs: 1000,
    offset: { x: 0, y: 0 },
    scale: 1,
    motion: 'none' as const,
  })
  const ok = (body: string) => () =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) })
  const source = {
    url: 'http://x/e.json',
    resolveImage: (u: string) => `http://x/${u}`,
  }

  it('外部 JSON を取得して画像 URL を解決し、インラインとマージする（同名はインライン優先）', async () => {
    const warn = vi.fn()
    const r = await loadEmotionSheets(
      { emotions: { '!': sheet('inline.png') }, emotionsSource: source },
      ok(JSON.stringify({ '!': { image: 'ext.png' }, '？': { image: 'q.png' } })),
      warn
    )
    expect(r?.['!'].image).toBe('inline.png')
    expect(r?.['？'].image).toBe('http://x/q.png')
    expect(warn).not.toHaveBeenCalled()
  })
  it('emotionsSource が無ければ fetch せずインラインだけ。どちらも無ければ undefined', async () => {
    const f = vi.fn()
    expect((await loadEmotionSheets({ emotions: { '!': sheet('a.png') } }, f))?.['!'].image).toBe(
      'a.png'
    )
    expect(await loadEmotionSheets({}, f)).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })
  it('HTTP エラー・fetch 例外・不正 JSON は警告してインラインだけで続ける', async () => {
    const inline = { emotions: { '!': sheet('inline.png') }, emotionsSource: source }
    for (const f of [
      () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }),
      () => Promise.reject(new Error('network')),
      ok('{ not json'),
    ]) {
      const warn = vi.fn()
      const r = await loadEmotionSheets(inline, f, warn)
      expect(Object.keys(r ?? {})).toEqual(['!'])
      expect(warn).toHaveBeenCalled()
    }
    // 外部だけで失敗したら undefined（層を作らない）
    expect(
      await loadEmotionSheets(
        { emotionsSource: source },
        () => Promise.reject(new Error('x')),
        () => {}
      )
    ).toBeUndefined()
  })
  it('外部 JSON の不正な種類は警告して、その種類だけ無視する', async () => {
    const warn = vi.fn()
    const r = await loadEmotionSheets(
      { emotionsSource: source },
      ok(JSON.stringify({ good: { image: 'g.png' }, bad: { frames: 0 } })),
      warn
    )
    expect(Object.keys(r ?? {})).toEqual(['good'])
    expect(warn.mock.calls[0][0]).toContain('emotionsUrl')
  })
})
