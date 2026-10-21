/** 戦闘サンプルの設定 JSON の `script` (#741 / #863) と、同梱の脚本サンプル 4 本の通しの確認 */
import { describe, expect, it } from 'vitest'
import { BattleEngine } from '../game/battleEngine'
import {
  buildBattleSetup,
  describeBattleResult,
  initialView,
  parseConfig,
  parseConfigText,
  type BattleSampleConfig,
} from './config'
import loseEvent from '../../public/battle-sample/scripted-lose-event.json?raw'
import interrupt from '../../public/battle-sample/scripted-interrupt.json?raw'
import revive from '../../public/battle-sample/scripted-revive.json?raw'
import flee from '../../public/battle-sample/scripted-flee.json?raw'

const BASE = 'https://example.com/battle-sample/x.json'

function parse(text: string): BattleSampleConfig {
  const r = parseConfigText(text, BASE)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

function engineOf(config: BattleSampleConfig, atb?: boolean): BattleEngine {
  const view = {
    ...initialView(config),
    ...(atb ? { atb: 'on' as const, atbMode: 'active' as const } : {}),
  }
  const setup = buildBattleSetup(config, view)
  return new BattleEngine(setup.party, setup.enemies, {
    rng: () => 0.5,
    ...(setup.atb ? { atb: setup.atb } : {}),
    skills: setup.skills,
    statuses: setup.statuses,
    ...(setup.script ? { script: setup.script } : {}),
  })
}

/** 終わるまで通常攻撃で進める（ATB は時間も進める）。上限つき */
function playOut(e: BattleEngine, limit = 400): void {
  for (let i = 0; i < limit && !e.isOver(); i++) {
    if (e.getState().phase === 'party-input') e.selectAttack()
    else e.tick(500)
  }
}

describe('parseConfig: script', () => {
  it('script が無ければ null（従来の設定）。buildBattleSetup も script を持たない', () => {
    const c = parse('{}')
    expect(c.script).toBeNull()
    expect('script' in buildBattleSetup(c, initialView(c))).toBe(false)
  })

  it('rules・id・joiners を読む。id の既定は sample', () => {
    const c = parse(
      JSON.stringify({
        script: {
          rules: ['台詞: 文=x'],
          joiners: [{ id: 'ally', name: 'A', hp: 9, mp: 0, atk: 1, def: 0, agi: 1 }],
        },
      })
    )
    expect(c.script?.id).toBe('sample')
    expect(c.script?.rules).toEqual(['台詞: 文=x'])
    expect(Object.keys(c.script?.joiners ?? {})).toEqual(['ally'])
    expect(parse('{"script":{"id":"z","rules":[]}}').script).toEqual({ id: 'z', rules: [] })
  })

  it.each([
    ['script が配列', '{"script":[]}'],
    ['rules が無い', '{"script":{}}'],
    ['rules が文字列でない', '{"script":{"rules":[1]}}'],
    ['id が空', '{"script":{"id":"","rules":[]}}'],
    ['joiners が配列でない', '{"script":{"rules":[],"joiners":3}}'],
    ['joiners が空配列', '{"script":{"rules":[],"joiners":[]}}'],
  ])('不正: %s はエラーで、読み込みを止める', (_n, text) => {
    expect(parseConfigText(text, BASE).ok).toBe(false)
  })

  it('buildBattleSetup は script を複製して渡す（設定を共有しない）。参戦者の呪文も用意する', () => {
    const c = parse(
      JSON.stringify({
        script: {
          rules: [],
          joiners: [{ id: 'ally', name: 'A', hp: 9, mp: 0, atk: 1, def: 0, agi: 1 }],
        },
      })
    )
    const setup = buildBattleSetup(c, initialView(c))
    expect(setup.script).toEqual(c.script)
    expect(setup.script).not.toBe(c.script)
    expect(setup.script?.joiners?.ally).not.toBe(c.script?.joiners?.ally)
    expect(Object.keys(setup.options.menu.spells ?? {})).toContain('ally')
  })

  it('describeBattleResult: 脚本の結果（フラグ・次）を出す。脚本の無い結果は従来の文字列のまま', () => {
    const base = { outcome: 'victory' as const, exp: 1, gold: 2, loot: [], items: [] }
    expect(describeBattleResult(base)).toBe('結果: victory  exp=1  gold=2  戦利品: なし')
    expect(
      describeBattleResult({ ...base, script: { id: 's', flags: { a: true }, next: 'ev' } })
    ).toBe('結果: victory  exp=1  gold=2  戦利品: なし  脚本: s フラグ={"a":true} 次=ev')
    expect(describeBattleResult({ ...base, script: { id: 's', flags: {} } })).toContain('フラグ={}')
  })
})

describe('同梱の脚本サンプル（ターン制・ATB の両方で通しで動く）', () => {
  it.each([false, true])(
    'scripted-lose-event: 負けが固定され、参戦し、敗北時のフラグが返る (atb=%s)',
    (atb) => {
      const e = engineOf(parse(loseEvent), atb)
      expect(e.getState().log.some((l) => l.includes('かえすわけには'))).toBe(true)
      // にげられない
      e.selectEscape()
      expect(e.isOver()).toBe(false)
      playOut(e)
      const st = e.getState()
      expect(st.phase).toBe('defeat')
      expect(st.script?.joined).toEqual(['friend'])
      expect(st.enemies[0].hp).toBeGreaterThan(0)
      expect(st.script?.turn).toBeLessThanOrEqual(8)
      expect(e.getResult()?.script).toEqual({
        id: 'lose-event',
        flags: { noto_lost: true, hero_lost_leg: true },
        next: 'black_out',
      })
    }
  )

  it.each([false, true])(
    'scripted-interrupt: 4 人で戦い、高 HP の敵を倒せないまま中断される (atb=%s)',
    (atb) => {
      const c = parse(interrupt)
      const e = engineOf(c, atb)
      expect(e.getState().party).toHaveLength(4)
      for (let i = 0; i < 400 && !e.isOver(); i++) {
        if (e.getState().phase === 'party-input') {
          e.selectSpell({ name: 'メテオ', mp: 0, target: '敵全体', effect: 'damage 7000..9999' })
        } else e.tick(500)
      }
      const st = e.getState()
      expect(st.phase).toBe('interrupted')
      expect(st.enemies[0].hp).toBeGreaterThan(0)
      expect(e.getResult()).toMatchObject({
        outcome: 'interrupted',
        exp: 0,
        gold: 0,
        script: { flags: { play_interrupted: true }, next: 'field_first' },
      })
    }
  )

  it.each([false, true])(
    'scripted-revive: HP0 でゲームオーバーにならず 1 度だけ復活し、状態が付く (atb=%s)',
    (atb) => {
      const e = engineOf(parse(revive), atb)
      let revived = false
      for (let i = 0; i < 400 && !e.isOver(); i++) {
        if (e.getState().phase === 'party-input') e.selectAttack()
        else e.tick(500)
        // rules の 2 番目（index 1）が復活。0 番目は開始の台詞で、最初から発動済み
        if (!revived && e.getState().script?.fired.includes(1)) {
          revived = true
          expect(e.getState().party[0].hp).toBe(e.getState().party[0].maxHp)
          expect(e.getState().party[0].status).toEqual({ fire_will: 5 })
          expect(e.getState().phase).not.toBe('defeat')
        }
      }
      expect(e.isOver()).toBe(true)
      // 復活は一度だけ。2 度目に倒れれば敗北、勝てば勝利（どちらでも決着する）
      expect(['victory', 'defeat']).toContain(e.getState().phase)
    }
  )

  it.each([false, true])(
    'scripted-flee: 倒せない敵は盾役が倒れるまで残り、逃げて勝利。逃げた敵の報酬は入らない (atb=%s)',
    (atb) => {
      const e = engineOf(parse(flee), atb)
      playOut(e)
      const st = e.getState()
      expect(st.phase).toBe('victory')
      expect(st.script?.fled).toEqual([1])
      expect(st.earnedExp).toBe(5) // 敵の exp はサンプル設定では既定（5）固定。逃げたエラー細胞の分は入らない（盾役 1 体ぶんだけ）
      expect(st.earnedGold).toBe(3)
      expect(e.getResult()?.script).toEqual({
        id: 'error-cell',
        flags: { cell_escaped: true },
        next: 'stomach_after',
      })
    }
  )

  it('同梱の 4 本はすべて、読み込み時の警告（宣言の誤り）が無い', () => {
    for (const text of [loseEvent, interrupt, revive, flee]) {
      const c = parse(text)
      const e = engineOf(c)
      expect(e.getState().script).toBeDefined()
    }
    // rules の解釈で警告が出ない（誤記のサンプルを同梱しない）
    for (const text of [loseEvent, interrupt, revive, flee]) {
      const rules = parse(text).script?.rules ?? []
      const r = parseConfig({ script: { rules } }, BASE)
      expect(r.ok).toBe(true)
    }
  })
})
