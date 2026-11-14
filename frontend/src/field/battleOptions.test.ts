import { describe, expect, it } from 'vitest'
import { buildBattleEngineOptions, buildBattleScreenOptions } from './battleOptions'
import { parseConfig } from './config'
import { effectiveCommandLayout } from '../game/battleLayout'
import { motionTimingFor } from '../game/battleMotion'
import { BattleEngine } from '../game/battleEngine'
import { frontmatterRaw } from './fieldRawBattle'
import type { EventDocument } from '../types'
import type { BattleEntity } from '../game/spellDsl'

const b = { layout: 'side' as const }

describe('buildBattleEngineOptions statuses (#1051 段階3)', () => {
  it('空・未指定なら statuses を渡さない', () => {
    expect(buildBattleEngineOptions(b)).not.toHaveProperty('statuses')
    expect(buildBattleEngineOptions(b, {})).not.toHaveProperty('statuses')
  })

  it('宣言があればそのまま渡す', () => {
    const statuses = { poison: { id: 'poison', name: 'どく', tickDamage: '1/16' } }
    expect(buildBattleEngineOptions(b, statuses).statuses).toBe(statuses)
  })
})

describe('statuses が BattleEngine に渡り、付与の効果で状態が付く (#1051)', () => {
  const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
    id,
    name: id,
    hp: 100,
    maxHp: 100,
    mp: 9,
    maxMp: 9,
    atk: 1,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  })

  it('宣言した状態を「status <id>」の効果で敵に付けられる', () => {
    const statuses = { poison: { id: 'poison', name: 'poison', duration: '3', tickDamage: '1' } }
    const engine = new BattleEngine([ent('p1')], [ent('e1')], buildBattleEngineOptions(b, statuses))
    engine.selectSpell(
      { name: 's', mp: 1, target: '敵単体', effect: 'status poison' },
      engine.getState().enemies[0].id
    )
    expect(engine.getState().enemies[0].status).toHaveProperty('poison')
  })
})

// 戦闘設定の配線の検査 (#896 / #880 / #954 / sit-by-me#52 / #62。#1066 でサンプル設定を削除した際に最小の inline 設定へ移した)。
// 入力は parseConfig で作る最小のインライン設定（特定の作品データには依存しない）
describe('battle 設定がエンジン・BattleScreen のオプションへ渡る（配線）', () => {
  const BASE = 'http://localhost/field/'
  const load = (battle: Record<string, unknown>) => {
    const r = parseConfig(
      {
        startScene: 'a',
        start: { x: 10, y: 20 },
        player: {
          sprites: Object.fromEntries(
            ['up', 'down', 'left', 'right'].map((d) => [d, [`${d}1.png`, `${d}2.png`, `${d}3.png`]])
          ),
        },
        scenes: { a: { background: 'a.png', mask: 'a-mask.png' } },
        battle,
      },
      BASE
    )
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  const full = () =>
    load({
      layout: 'side',
      atb: 'on',
      presentation: 'ff',
      windowStyle: 'ff-blue',
      motion: 'snappy',
      commandLayout: 'cross',
      commands: ['skill', 'spell', 'item', 'escape'],
      commandLabels: { spell: 'まほう' },
      enemyGrid: '4x2',
      logicalSize: '1920x1080',
    }).battle

  it('BattleScreen のオプションへ atb 以外の戦闘設定が漏れなく渡る', () => {
    const b = full()
    const o = buildBattleScreenOptions(b, { background: 'bg.webp' })
    expect(o.motion).toBe('snappy')
    expect(o.commandLayout).toBe('cross')
    expect(o.commands).toEqual(b.commands)
    expect(o.commandLabels).toEqual({ spell: 'まほう' })
    expect(o.presentation).toBe('ff')
    expect(o.windowStyle).toBe('ff-blue')
    expect(o.enemyGrid).toEqual(b.enemyGrid)
    expect(o.background).toBe('bg.webp')
  })

  it('frontmatter battle_command_labels が parseConfig を経て BattleScreen のオプションに出る。未指定は出ない (#1154)', () => {
    const warnings: string[] = []
    const fm = frontmatterRaw(
      { battle_command_labels: 'spell=まほう, bogus=x' } as unknown as EventDocument,
      'http://localhost/a',
      undefined,
      warnings
    )
    expect(warnings).toEqual([])
    const o = buildBattleScreenOptions(load(fm.battle).battle, {})
    expect(o.commandLabels).toEqual({ spell: 'まほう' })
    const none = frontmatterRaw({} as unknown as EventDocument, 'http://localhost/a', undefined, [])
    expect('commandLabels' in buildBattleScreenOptions(load(none.battle).battle, {})).toBe(false)
  })

  it('enemyWindowOverlap はグリッドの有無と無関係に渡る (#1178)', () => {
    const b = load({ layout: 'side', enemyWindowOverlap: 0.3 }).battle
    expect(b.enemyGrid).toBeUndefined()
    expect(buildBattleScreenOptions(b, {}).enemyWindowOverlap).toBe(0.3)
  })

  it('enemyList の指定は BattleScreen のオプションへ渡り、未指定は渡さない (#954)', () => {
    const base = { layout: 'side', spriteStyle: 'none', width: 800, height: 450 } as const
    expect(buildBattleScreenOptions({ ...base, enemyList: 'window' }, {}).enemyList).toBe('window')
    expect('enemyList' in buildBattleScreenOptions(base, {})).toBe(false)
  })

  it('ATB の設定が BattleEngine のオプションへ渡る（未指定はターン制）。side + 敵グリッドは enemyRow (#896) も渡る', () => {
    expect(buildBattleEngineOptions(full())).toEqual({
      atb: { mode: 'wait' },
      enemyRow: { grid: { cols: 4, rows: 2 } },
    })
    expect(buildBattleEngineOptions({ layout: 'side' })).toEqual({})
    // front レイアウト・グリッド無しでは enemyRow を渡さない
    const b = full()
    expect(buildBattleEngineOptions({ ...b, layout: 'front' })).toEqual({ atb: { mode: 'wait' } })
    expect(buildBattleEngineOptions({ ...b, enemyGrid: undefined })).toEqual({
      atb: { mode: 'wait' },
    })
  })

  it('buildBattleScreenOptions: 未指定のキーは出さない（従来の既定）', () => {
    const o = buildBattleScreenOptions(
      { layout: 'side', spriteStyle: 'none', width: 800, height: 450 },
      {}
    )
    expect(Object.keys(o).sort()).toEqual(['layout', 'spriteStyle'])
  })

  it('十字コマンドが実効になる（cross かつコマンド 4 つ）', () => {
    const b = full()
    expect(b.commands).toHaveLength(4)
    expect(b.commandLayout).toBe('cross')
    expect(effectiveCommandLayout(b.commandLayout, b.commands?.length ?? 0)).toBe('cross')
  })

  it('motion プリセットは ff 演出で有効になり、桁バウンスが付く (sit-by-me#62)', () => {
    const b = full()
    expect(b.presentation).toBe('ff')
    expect(b.motion).toBe('snappy')
    expect(motionTimingFor(b.motion).digitStaggerMs).toBeGreaterThan(0)
  })

  it('1920x1080 論理サイズで UI スケール 2.4 と renderResolution が BattleScreen に渡る (sit-by-me#52)', () => {
    const b = full()
    expect(b.logicalSize).toBe('1920x1080')
    expect([b.width, b.height]).toEqual([1920, 1080])
    const o = buildBattleScreenOptions(b, { renderResolution: 2 })
    expect(o.uiScale).toBe(2.4)
    expect(o.renderResolution).toBe(2)
  })

  it('logicalSize 未指定は uiScale / renderResolution を出さない（従来） (sit-by-me#52)', () => {
    const o = buildBattleScreenOptions(
      { layout: 'side', spriteStyle: 'none', width: 800, height: 450 },
      { renderResolution: 2 }
    )
    expect(o).not.toHaveProperty('uiScale')
    expect(o).not.toHaveProperty('renderResolution')
  })

  it('せってい (#880): ATB の戦闘だけ mode と speed を上書きする。等倍の speed は渡さない', () => {
    const b = full()
    expect(buildBattleEngineOptions(b, undefined, { atbMode: 'active', atbSpeed: 2 }).atb).toEqual({
      mode: 'active',
      speed: 2,
    })
    expect(buildBattleEngineOptions(b, undefined, { atbSpeed: 1 }).atb).toEqual({ mode: 'wait' })
    expect(buildBattleEngineOptions(b, undefined, undefined).atb).toEqual({ mode: 'wait' })
  })

  it('せってい (#880): ターン制（atb なし）には上書きを渡さない', () => {
    expect(
      buildBattleEngineOptions({ layout: 'side' }, undefined, { atbMode: 'active', atbSpeed: 2 })
    ).toEqual({})
  })

  it('せってい (#880): cursorMemory は渡したときだけ BattleScreen のオプションへ', () => {
    const b = full()
    const mem = new Map<string, number>()
    expect(buildBattleScreenOptions(b, { cursorMemory: mem }).cursorMemory).toBe(mem)
    expect('cursorMemory' in buildBattleScreenOptions(b, {})).toBe(false)
  })
})

describe('uiImages の配線 (#1067・#1087)', () => {
  const cfg = (ui?: Record<string, unknown>) => {
    const r = parseConfig(
      {
        startScene: 'a',
        start: { x: 10, y: 20 },
        player: {
          sprites: Object.fromEntries(
            ['up', 'down', 'left', 'right'].map((d) => [d, [`${d}1.png`, `${d}2.png`, `${d}3.png`]])
          ),
        },
        scenes: { a: { background: 'a.png', mask: 'a-mask.png' } },
        battle: { layout: 'side' },
        ...(ui ? { ui } : {}),
      },
      'http://localhost/field/'
    )
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  it('設定の ui が指定のあるときだけ BattleScreen のオプションへ渡る（未指定はキーなし）', () => {
    const none = cfg()
    expect(buildBattleScreenOptions(none.battle, {})).not.toHaveProperty('uiImages')
    const c = cfg({ handImage: 'ui/h.webp', markScale: 3 })
    const o = buildBattleScreenOptions(c.battle, { uiImages: c.ui })
    expect(o.uiImages).toEqual({ handImage: 'http://localhost/field/ui/h.webp', markScale: 3 })
  })
})
