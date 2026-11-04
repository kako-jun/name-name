/**
 * docs/guide/examples/ の再開用セーブの例 (#1021) が、いまの設定（寺町サンプル）に対して実際に読めることを固定する。
 * 例が設定やセーブ形式の変更で古くなったら、ここで落ちる。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveManager, type SaveSlotData } from '../game/SaveManager'
import { parseConfigText } from './config'
import { FIELD_SAMPLE_DOC_KEY, loadResume } from './fieldResume'
import { expandedTeramachiText } from './teramachiExpanded'
import exampleText from '../../../docs/guide/examples/teramachi-bathhouse-battle.save.json?raw'
import demoConfigText from '../../../docs/guide/examples/teramachi-enemy-level.config.json?raw'
import demoMotionConfig from '../../../docs/guide/examples/demo-motion.config.json?raw'
import demoMotionSave from '../../../docs/guide/examples/demo-motion.save.json?raw'
import demoEnemyListConfig from '../../../docs/guide/examples/demo-enemy-list.config.json?raw'
import demoEnemyListSave from '../../../docs/guide/examples/demo-enemy-list.save.json?raw'
import demoEffectsConfig from '../../../docs/guide/examples/demo-effects.config.json?raw'
import demoEffectsSave from '../../../docs/guide/examples/demo-effects.save.json?raw'
import manifestText from '../../public/field-sample/sit-character-forms.json?raw'
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

describe('motion / 敵名窓 / エフェクトの確認用設定（#1051）', () => {
  const parseText = (text: string) => {
    const m = parseCharacterFormsManifest(JSON.parse(manifestText))
    if (!m.ok) throw new Error(m.error)
    const raw = expandCharacterForms(JSON.parse(text), m.value, {}).raw
    return parseConfigText(JSON.stringify(raw), 'http://localhost/')
  }
  const resume = (cfgText: string, saveText: string) => {
    const cfg = parseText(cfgText)
    if (!cfg.ok) throw new Error(cfg.error)
    expect(cfg.value.warnings ?? []).toEqual([])
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, JSON.parse(saveText) as SaveSlotData)
    const r = loadResume('?resume=0', cfg.value)
    if (r.kind !== 'ok') throw new Error('resume failed')
    expect(r.resolved.warnings).toEqual([])
    expect(r.resolved.battle).toBeTruthy()
    return { cfg: cfg.value, resolved: r.resolved }
  }

  it('motion: snappy が反映され、戦闘中状態に解決する', () => {
    const { cfg, resolved } = resume(demoMotionConfig, demoMotionSave)
    expect(cfg.battle.motion).toBe('snappy')
    expect(resolved.battle!.enemies.map((e) => e.name)).toEqual(['タコ', 'イカ'])
  })

  it('敵名窓: window が反映され、同名の敵が複数並ぶ', () => {
    const { cfg, resolved } = resume(demoEnemyListConfig, demoEnemyListSave)
    expect(cfg.battle.enemyList).toBe('window')
    expect(resolved.battle!.enemies.map((e) => e.name)).toEqual([
      'スライム',
      'スライム',
      'スライム',
      'イカ',
    ])
  })

  it('エフェクト: cast / impact / slash / magic の 4 種類が解決する', () => {
    const { cfg } = resume(demoEffectsConfig, demoEffectsSave)
    expect(Object.keys(cfg.battle.effects ?? {}).sort()).toEqual([
      'cast',
      'impact',
      'magic',
      'slash',
    ])
  })
})
