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

const example = JSON.parse(exampleText) as SaveSlotData

beforeEach(() => localStorage.clear())

describe('寺町の途中局面（銭湯前・戦闘中）の例', () => {
  const load = () => {
    const cfg = parseConfigText(expandedTeramachiText(), 'http://localhost/')
    expect(cfg.ok).toBe(true)
    if (!cfg.ok) throw new Error(cfg.error)
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, example)
    const r = loadResume('?resume=0', cfg.value)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('resume failed')
    return { cfg: cfg.value, resolved: r.resolved }
  }

  it('localStorage に書いて ?resume=0 で読むと、パーティ・所持品・現在地・戦闘中状態に解決する', () => {
    const { resolved } = load()
    expect(resolved.warnings).toEqual([])
    expect(resolved.party.map((m) => [m.name, m.hp, m.maxHp])).toEqual([
      ['ナム', 22, 40],
      ['オットン', 9, 44],
      ['シャー', 46, 46],
      ['ペー子', 0, 34],
    ])
    expect(Object.values(resolved.inventory).every((n) => n === 0)).toBe(true)
    expect(resolved.gold).toBe(120)
    expect(resolved.field).toMatchObject({ sceneId: 'bathhouse', x: 768, y: 716, facing: 'up' })
    expect(resolved.battle!.enemies.map((e) => [e.name, e.hp, e.maxHp])).toEqual([
      ['石油ストーブ', 21, 30],
      ['扇風機・換気扇の羽根', 20, 20],
    ])
    expect(resolved.battle!.enemies[1].status).toBeUndefined()
    expect(resolved.battle!.atb!.queue).toEqual([0])
  })

  it('寺町の実際の設定の motion=snappy・effects 4 種・enemyList=window が解決する（#1051）', () => {
    const { cfg } = load()
    expect(cfg.battle.motion).toBe('snappy')
    expect(cfg.battle.enemyList).toBe('window')
    expect(Object.keys(cfg.battle.effects ?? {}).sort()).toEqual([
      'cast',
      'impact',
      'magic',
      'slash',
    ])
  })
})
