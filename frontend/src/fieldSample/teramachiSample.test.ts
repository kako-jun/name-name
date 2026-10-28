// #943: 同梱の寺町サンプルの吹き出し宣言 JSON と脚本 .md の整合。
import { describe, expect, it } from 'vitest'
import emotionsText from '../../public/field-sample/teramachi-emotions.json?raw'
import scriptText from '../../public/field-sample/teramachi-npc.md?raw'
import { parseFieldEmotionsText } from '../game/fieldEmotionScript'

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
})
