// #943: 同梱の寺町サンプルの吹き出し宣言 JSON と脚本 .md の整合。
import { describe, expect, it } from 'vitest'
import emotionsText from '../../public/field-sample/teramachi-emotions.json?raw'
import sampleText from './teramachi.sample.json?raw'
import scriptText from '../../public/field-sample/teramachi-npc.md?raw'
import { parseFieldEmotionsText } from '../game/fieldEmotionScript'
import { collectFieldEvents } from '../game/fieldScript'
import { parseMarkdown } from '../wasm/parser'
import { parseConfig } from './config'
import { buildBattleMenu } from './battleMenu'
import { buildBattleEngineOptions, buildBattleScreenOptions } from './battleOptions'
import { effectiveCommandLayout } from '../game/battleLayout'
import { motionTimingFor } from '../game/battleMotion'

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

// sit-by-me#54 / sit-by-me#56 / sit-by-me#57 / sit-by-me#62 / sit-by-me#65: 統合サンプル（寺町）が戦闘サンプルと同等の機能を実際に使っていること。
// 設定を外すと、実機で気づかないまま従来表示（先頭固定・格子なし・桁バウンスなし）へ戻るため、ここで固定する。
describe('寺町サンプルの戦闘設定（戦闘サンプルとの機能同等性）', () => {
  const load = () => {
    const r = parseConfig(JSON.parse(sampleText), 'http://localhost/field-sample/')
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('スキーマ検証が通り、警告も群エラーも出ない', () => {
    const c = load()
    expect(c.warnings).toBeUndefined()
    expect(c.groupErrors).toBeUndefined()
  })

  it('sit-by-me#57 ATB が有効（全員が満タン順に行動する）', () => {
    expect(load().battle.atb).toEqual({ mode: 'wait' })
  })

  it('sit-by-me#56 十字コマンドが実効になる（cross かつコマンド 4 つ）', () => {
    const b = load().battle
    expect(b.commandLayout).toBe('cross')
    expect(b.commands).toHaveLength(4)
    expect(effectiveCommandLayout(b.commandLayout, b.commands?.length ?? 0)).toBe('cross')
  })

  it('sit-by-me#54 敵グリッドと、2 マス以上の敵の size がある', () => {
    const c = load()
    expect(c.battle.enemyGrid).toBeDefined()
    const sizes = Object.values(c.monsters).map((m) => m.size)
    expect(sizes.every((s) => s !== undefined)).toBe(true)
    expect(sizes.some((s) => s && s.w * s.h >= 2)).toBe(true)
    // sit-by-me docs/monsters.md §3-7 の gridClass（M001=1x1, M008=1x2）
    expect(c.monsters.dragon.size).toEqual({ w: 1, h: 1 })
    expect(c.monsters.shachihoko.size).toEqual({ w: 1, h: 2 })
  })

  it('sit-by-me#65 commands の全コマンドが実際に機能する（死んだボタンがない）', () => {
    const c = load()
    const menu = buildBattleMenu(c)
    const has = (rows: Record<string, readonly unknown[]> | readonly unknown[] | undefined) =>
      Array.isArray(rows)
        ? rows.length > 0
        : !!rows && Object.values(rows).every((r) => (r as unknown[]).length > 0)
    const commands = c.battle.commands ?? []
    expect(commands.length).toBe(4)
    // たたかうを落とした退行の形を直接固定する
    expect(commands).toContain('attack')
    for (const id of commands) {
      if (id === 'attack' || id === 'escape') continue
      if (id === 'spell') expect(has(menu?.spells)).toBe(true)
      else if (id === 'item') expect(has(menu?.items)).toBe(true)
      else if (id === 'skill') expect(has(menu?.skills)).toBe(true)
      else throw new Error(`サンプルが機能を用意していないコマンド: ${id}`)
    }
    // 全味方が呪文を持つ
    expect(Object.keys(menu?.spells ?? {})).toHaveLength(c.party.length)
  })

  it('BattleScreen のオプションへ atb 以外の戦闘設定が漏れなく渡る', () => {
    const b = load().battle
    const o = buildBattleScreenOptions(b, { background: 'bg.webp' })
    expect(o.motion).toBe('snappy')
    expect(o.commandLayout).toBe('cross')
    expect(o.commands).toEqual(b.commands)
    expect(o.presentation).toBe('ff')
    expect(o.windowStyle).toBe('ff-blue')
    expect(o.enemyGrid).toEqual(b.enemyGrid)
    expect(o.background).toBe('bg.webp')
  })

  it('ATB の設定が BattleEngine のオプションへ渡る（未指定はターン制）', () => {
    expect(buildBattleEngineOptions(load().battle)).toEqual({ atb: { mode: 'wait' } })
    expect(buildBattleEngineOptions({})).toEqual({})
  })

  it('buildBattleScreenOptions: 未指定のキーは出さない（従来の既定）', () => {
    const o = buildBattleScreenOptions(
      { layout: 'side', spriteStyle: 'none', width: 800, height: 450 },
      {}
    )
    expect(Object.keys(o).sort()).toEqual(['layout', 'spriteStyle'])
  })

  it('sit-by-me#62 motion プリセットが ff 演出で有効になり、桁バウンスが付く', () => {
    const b = load().battle
    expect(b.presentation).toBe('ff')
    expect(b.motion).toBe('snappy')
    expect(motionTimingFor(b.motion).digitStaggerMs).toBeGreaterThan(0)
  })
})

describe('寺町サンプルの戦闘遷移 (sit-by-me#55)', () => {
  it('battle.transition は ff-mosaic', () => {
    const r = parseConfig(JSON.parse(sampleText), 'http://localhost:8780/field-sample/')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.battle.transition).toBe('ff-mosaic')
  })
})
