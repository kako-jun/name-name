// #943: frontmatter `field_emotions` と脚本 `[感情:]` を、実パーサ（parseMarkdown。WASM 同梱）経由で
// Document にし、そこから吹き出し指示へ解決するまでを通しで縛る。
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import type { Event } from '../types'
import { EMOTION_MAX_DURATION_MS } from './fieldEmotion'
import { parseFieldEmotionsText, resolveEmotion } from './fieldEmotionScript'

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
