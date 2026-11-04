/**
 * docs/guide/examples/ の再開用セーブの例 (#1021) が、いまの設定（寺町サンプル）に対して実際に読めることを固定する。
 * 例が設定やセーブ形式の変更で古くなったら、ここで落ちる。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveManager, type SaveSlotData } from '../game/SaveManager'
import { parseConfigText } from './config'
import { FIELD_SAMPLE_DOC_KEY, loadResume, resumeBattleEngineOptions } from './fieldResume'
import { buildBattleEngineOptions } from './battleOptions'
import { BattleEngine } from '../game/battleEngine'
import { expandedTeramachiText } from './teramachiExpanded'
import exampleText from '../../../docs/guide/examples/teramachi-bathhouse-battle.save.json?raw'
import demoConfigText from '../../../docs/guide/examples/teramachi-enemy-level.config.json?raw'
import sampleText from './teramachi.sample.json?raw'
import demoEnemyListConfig from '../../../docs/guide/examples/demo-enemy-list.config.json?raw'
import demoEnemyListSave from '../../../docs/guide/examples/demo-enemy-list.save.json?raw'
import demoStatusesConfig from '../../../docs/guide/examples/demo-statuses.config.json?raw'
import demoStatusesSave from '../../../docs/guide/examples/demo-statuses.save.json?raw'
import demoGearConfig from '../../../docs/guide/examples/demo-gear.config.json?raw'
import demoGearSave from '../../../docs/guide/examples/demo-gear.save.json?raw'
import manifestText from '../../public/field-sample/sit-character-forms.json?raw'
import { buildBattleMenu } from './battleMenu'
import type { GearState } from '../game/gearShop'
import { expandCharacterForms, parseCharacterFormsManifest } from './characterForms'

const example = JSON.parse(exampleText) as SaveSlotData

beforeEach(() => localStorage.clear())

describe('寺町の途中局面（銭湯前・戦闘中）の例', () => {
  it('localStorage に書いて ?resume=0 で読むと、パーティ・所持品・現在地・戦闘中状態に解決する', () => {
    const cfg = parseConfigText(expandedTeramachiText(), 'http://localhost/')
    expect(cfg.ok).toBe(true)
    if (!cfg.ok) return
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, example)
    const r = loadResume('?resume=0', cfg.value)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    const { resolved } = r
    expect(resolved.warnings).toEqual([])
    expect(resolved.party.map((m) => [m.name, m.hp, m.maxHp])).toEqual([
      ['ナム', 22, 40],
      ['オットン', 9, 44],
      ['シャー', 46, 46],
      ['ペー子', 0, 34],
    ])
    expect(resolved.inventory).toEqual({ sit_herb_tea_heal: 1 })
    expect(resolved.gold).toBe(120)
    expect(resolved.field).toMatchObject({ sceneId: 'bathhouse', x: 768, y: 716, facing: 'up' })
    expect(resolved.battle!.enemies.map((e) => [e.name, e.hp, e.maxHp])).toEqual([
      ['石油ストーブ', 21, 30],
      ['扇風機・換気扇の羽根', 20, 20],
    ])
    expect(resolved.battle!.enemies[1].status).toEqual({ sleep: 2 })
    expect(resolved.battle!.atb!.queue).toEqual([0])
  })
})

describe('敵レベルとレベル即死の確認用設定（#1043）', () => {
  const parseDemo = () => {
    const m = parseCharacterFormsManifest(JSON.parse(manifestText))
    if (!m.ok) throw new Error(m.error)
    const raw = expandCharacterForms(JSON.parse(demoConfigText), m.value, {}).raw
    return parseConfigText(JSON.stringify(raw), 'http://localhost/')
  }

  it('parseConfig を通り、レベルが解決する', () => {
    const cfg = parseDemo()
    expect(cfg.ok).toBe(true)
    if (!cfg.ok) return
    expect(cfg.value.warnings ?? []).toEqual([])
    expect(cfg.value.battle.layout).toBe('side')
    const m = cfg.value.monsters
    expect(m.M149.level).toBe(50)
    expect(m.M147.level).toBe(3)
    expect(m.M145.level).toBeUndefined()
  })

  it('銭湯のセーブ例の敵（M149・M147）が、この設定でも解決する', () => {
    const cfg = parseDemo()
    if (!cfg.ok) throw new Error(cfg.error)
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, example)
    const r = loadResume('?resume=0', cfg.value)
    expect(r.kind).toBe('ok')
  })
})

const parseText = (text: string) => {
  const m = parseCharacterFormsManifest(JSON.parse(manifestText))
  if (!m.ok) throw new Error(m.error)
  const raw = expandCharacterForms(JSON.parse(text), m.value, {}).raw
  return parseConfigText(JSON.stringify(raw), 'http://localhost/')
}
const expandedRaw = (text: string) => {
  const m = parseCharacterFormsManifest(JSON.parse(manifestText))
  if (!m.ok) throw new Error(m.error)
  return expandCharacterForms(JSON.parse(text), m.value, {}).raw as Record<string, unknown>
}
/** 2 つの展開済み設定で、値が違うトップレベルのキー（`battle` は 1 段下まで見て `battle.<キー>` で返す） */
const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => {
  const out: string[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue
    if (k === 'battle') {
      const ba = a.battle as Record<string, unknown>
      const bb = b.battle as Record<string, unknown>
      for (const kk of new Set([...Object.keys(ba), ...Object.keys(bb)])) {
        if (JSON.stringify(ba[kk]) !== JSON.stringify(bb[kk])) out.push(`battle.${kk}`)
      }
    } else out.push(k)
  }
  return out.sort()
}
const REAL_PARTY = ['ナム', 'オットン', 'シャー', 'ペー子']
const resume = (cfgText: string, saveText: string) => {
  const cfg = parseText(cfgText)
  if (!cfg.ok) throw new Error(cfg.error)
  expect(cfg.value.warnings ?? []).toEqual([])
  new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, JSON.parse(saveText) as SaveSlotData)
  const r = loadResume('?resume=0', cfg.value)
  if (r.kind !== 'ok') throw new Error('resume failed')
  expect(r.resolved.warnings).toEqual([])
  expect(r.resolved.battle).toBeTruthy()
  expect(r.resolved.party.map((m) => m.name)).toEqual(REAL_PARTY)
  return { cfg: cfg.value, resolved: r.resolved }
}
const teramachiRaw = () => expandedRaw(sampleText)

describe('寺町の実際の設定+実際のセーブで motion / エフェクト（#1051）', () => {
  it('motion=snappy と effects 4 種が解決する', () => {
    const { cfg } = resume(sampleText, exampleText)
    expect(cfg.battle.motion).toBe('snappy')
    expect(Object.keys(cfg.battle.effects ?? {}).sort()).toEqual([
      'cast',
      'impact',
      'magic',
      'slash',
    ])
  })
})

describe('敵名窓の確認用設定（#1051）', () => {
  it('寺町の設定との差分は battle.enemyList だけ', () => {
    expect(diffKeys(teramachiRaw(), expandedRaw(demoEnemyListConfig))).toEqual(['battle.enemyList'])
  })

  it('window が反映され、実際の 4 人と台帳の敵（同名 3 体）に解決する', () => {
    const { cfg, resolved } = resume(demoEnemyListConfig, demoEnemyListSave)
    expect(cfg.battle.enemyList).toBe('window')
    expect(resolved.battle!.enemies.map((e) => e.name)).toEqual([
      '扇風機・換気扇の羽根',
      '扇風機・換気扇の羽根',
      '扇風機・換気扇の羽根',
      'ライター',
    ])
  })
})

describe('状態異常の確認用設定（#1051 段階3）', () => {
  const setup = () => {
    const { cfg, resolved } = resume(demoStatusesConfig, demoStatusesSave)
    const saved = resolved.battle!
    const engine = new BattleEngine(
      resolved.party.map((p) => structuredClone(p)),
      saved.enemies.map((e) => ({ ...e })),
      resumeBattleEngineOptions(buildBattleEngineOptions(cfg.battle, cfg.statuses), saved)
    )
    return { cfg, engine }
  }

  it('寺町の設定との差分は statuses と spells だけ（寺町の呪文は残る）', () => {
    expect(diffKeys(teramachiRaw(), expandedRaw(demoStatusesConfig))).toEqual([
      'spells',
      'statuses',
    ])
    const t = (teramachiRaw().spells as { id: string }[]).map((s) => s.id)
    const d = (expandedRaw(demoStatusesConfig).spells as { id: string }[]).map((s) => s.id)
    expect(d.slice(0, t.length)).toEqual(t)
  })

  it('statuses が読まれ、実際の 4 人と台帳の敵に解決する', () => {
    const { cfg, engine } = setup()
    expect(Object.keys(cfg.statuses)).toEqual(['poison', 'sleep', 'confusion', 'zombie', 'doom'])
    expect(engine.getState().enemies.map((e) => e.name)).toEqual([
      '扇風機・換気扇の羽根',
      '石油ストーブ',
    ])
  })

  it('エンジンに statuses が渡り、どくのこなで敵に毒の状態が付く', () => {
    const { cfg, engine } = setup()
    const spell = cfg.spells.find((s) => s.id === 'poisona')!
    const target = engine.getState().enemies[0]
    engine.selectSpell(spell, target.id)
    expect(engine.getState().enemies[0].status).toHaveProperty('poison')
  })
})

describe('刀のアビリティの確認用設定（#881 段階3）', () => {
  it('警告なしで読め、セーブ再開で装備中の刀のわざだけが出る。持ち替えで変わる', () => {
    const m = parseCharacterFormsManifest(JSON.parse(manifestText))
    if (!m.ok) throw new Error(m.error)
    const raw = expandCharacterForms(JSON.parse(demoGearConfig), m.value, {}).raw
    const cfg = parseConfigText(JSON.stringify(raw), 'http://localhost/')
    if (!cfg.ok) throw new Error(cfg.error)
    expect(cfg.value.warnings ?? []).toEqual([])
    const save = JSON.parse(demoGearSave) as SaveSlotData
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, save)
    const r = loadResume('?resume=0', cfg.value)
    if (r.kind !== 'ok') throw new Error('resume failed')
    expect(r.resolved.warnings).toEqual([])
    const shop = cfg.value.gearShop!
    const ids = (state: GearState, who: string) =>
      buildBattleMenu({
        party: r.resolved.party,
        spells: [],
        items: [],
        skills: cfg.value.skills,
        gear: { shop, state },
      })?.skills?.[who]?.map((s) => s.id)
    const gear = r.resolved.gear!
    expect(ids(gear, 'party1')).toEqual(['slashA'])
    expect(ids(gear, 'party2')).toEqual(['slashC'])
    expect(ids({ ...gear, blade: { ...gear.blade, party1: 'bladeB' } }, 'party1')).toEqual([
      'slashB',
    ])
  })
})

describe('デモ設定にダミー名を残さない', () => {
  it('demo_* の敵・ゆうしゃ等を使っていない', () => {
    for (const t of [
      demoEnemyListConfig,
      demoEnemyListSave,
      demoStatusesConfig,
      demoStatusesSave,
      demoGearConfig,
      demoGearSave,
    ]) {
      expect(t).not.toMatch(/demo_|ゆうしゃ|まほうつかい/)
    }
  })
})
