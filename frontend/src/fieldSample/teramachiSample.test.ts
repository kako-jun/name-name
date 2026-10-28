// #943: 同梱の寺町サンプルの吹き出し宣言 JSON と脚本 .md の整合。
import { describe, expect, it } from 'vitest'
import emotionsText from '../../public/field-sample/teramachi-emotions.json?raw'
import sampleText from './teramachi.sample.json?raw'
import scriptText from '../../public/field-sample/teramachi-npc.md?raw'
import { parseFieldEmotionsText } from '../game/fieldEmotionScript'
import { collectFieldEvents } from '../game/fieldScript'
import { parseMarkdown } from '../wasm/parser'

describe('寺町サンプルの感情吹き出し', () => {
  it('同梱の teramachi-emotions.json は実物の parseEmotions を警告 0 で通り、3 種を宣言する', () => {
    const { emotions, warnings } = parseFieldEmotionsText(emotionsText, (u) => u)
    expect(warnings).toEqual([])
    expect(Object.keys(emotions).sort()).toEqual(['びっくり', 'はてな', '沈黙'].sort())
  })

  it('脚本の [感情:] が使う種類はすべて emotions JSON に宣言済み', () => {
    const { emotions } = parseFieldEmotionsText(emotionsText, (u) => u)
    const used = [...scriptText.matchAll(/^\[感情:\s*[^,\]]+,\s*([^,\]\s]+)/gm)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const kind of used) expect(Object.keys(emotions)).toContain(kind)
  })

  it('NPC の scene はすべて脚本の [イベント] に実在する', async () => {
    const sample = JSON.parse(sampleText) as {
      scenes: Record<string, { npcs?: { id: string; scene?: string }[] }>
    }
    const events = collectFieldEvents(await parseMarkdown(scriptText))
    const scenes = Object.values(sample.scenes)
      .flatMap((s) => s.npcs ?? [])
      .flatMap((n) => (n.scene ? [n.scene] : []))
    expect(scenes.length).toBeGreaterThan(1)
    for (const sc of scenes) expect(events.has(sc)).toBe(true)
  })
})
