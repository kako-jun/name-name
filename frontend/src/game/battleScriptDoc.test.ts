/**
 * 脚本制御の戦闘 (#741 / #863) の「markdown → parser(wasm) → RPGProject → 組み立て → 戦闘」を通しで確認する。
 * 宣言（`[戦闘]` / `[戦闘: id]`）が wasm を生き残ること、組み立てが宣言どおりであること、書いた脚本のとおりに戦闘が進むこと。
 */
import { describe, expect, it, vi } from 'vitest'
import { emitMarkdown, parseMarkdown } from '../wasm/parser'
import { collectMasterData, rpgProjectFromDoc } from './rpgProjectFromDoc'
import { buildScriptedBattle, parsePartyIds, type FieldBattleRoster } from './fieldBattle'
import { BattleEngine } from './battleEngine'
import { partyDefToBattleEntity } from './fieldBattle'
import type { EventCommand } from '../types'

const MD = [
  '---',
  'engine: name-name',
  'chapter: 1',
  'title: t',
  'battle_layout: side',
  '---',
  '',
  '## map: village',
  '',
  '[マップ 3x2 タイル=32]',
  'GGG',
  'GGG',
  '[/マップ]',
  '',
  '[プレイヤー @1,1 向き=下]',
  '',
  '[モンスター water]',
  '名前: 水の召喚獣',
  'HP: 400',
  'ATK: 12',
  'DEF: 1',
  'AGI: 3',
  'EXP: 30',
  'GOLD: 10',
  '[/モンスター]',
  '',
  '[パーティ hero]',
  '名前: ぼく',
  'HP: 20',
  'ATK: 9',
  'DEF: 1',
  'AGI: 5',
  '[/パーティ]',
  '',
  '[パーティ osananajimi]',
  '名前: おさななじみ',
  'HP: 40',
  'ATK: 11',
  'DEF: 2',
  'AGI: 6',
  '[/パーティ]',
  '',
  '[戦闘 noto]',
  '名前: 能登の海',
  '敵: water',
  '味方: hero',
  'にげる: 不可',
  '固定: 結果=敗北 上限ターン=6',
  '下限: 対象=hero HP=1 条件=!参戦[osananajimi]',
  '台詞: 条件=開始 話者=水の召喚獣 文=……まだ、にげられると おもったか',
  '参戦: 条件=HP[hero]<=1 対象=osananajimi 文=おさななじみが とびこんできた！',
  '敗北時: フラグ=noto_lost=true 次=after_noto',
  '[/戦闘]',
  '',
  '[イベント start]',
  '海だ。',
  '[戦闘: noto]',
  '勝ったことになっている。',
  '[/イベント]',
  '',
  '[イベント after_noto]',
  '暗転した。',
  '[/イベント]',
  '',
].join('\n')

describe('markdown から戦闘まで', () => {
  it('[戦闘] の宣言と [戦闘: id] のコマンドが wasm の parse・normalize を生き残る', async () => {
    const doc = await parseMarkdown(MD)
    const master = collectMasterData(doc)
    expect(Object.keys(master.battleScripts)).toEqual(['noto'])
    const def = master.battleScripts.noto
    expect(def.enemies).toBe('water')
    expect(def.party).toEqual(['hero'])
    expect(def.name).toBe('能登の海')
    expect(def.rules).toHaveLength(6)
    expect(def.rules[0]).toBe('にげる: 不可')

    const project = rpgProjectFromDoc(doc)
    expect(project?.battleScripts?.noto.id).toBe('noto')
    const start = project?.rpgEvents?.find((e) => e.name === 'start')
    expect(start?.commands.map((c: EventCommand) => c.type)).toEqual(['Dialog', 'Battle', 'Dialog'])
    expect(start?.commands[1]).toEqual({ type: 'Battle', id: 'noto' })
  })

  it('[戦闘] を 1 つも書かないゲームの RPGProject には battleScripts が付かない', async () => {
    const doc = await parseMarkdown(MD.replace(/\[戦闘 noto\][\s\S]*?\[\/戦闘\]/, ''))
    expect(rpgProjectFromDoc(doc)?.battleScripts).toBeUndefined()
    expect(
      Object.prototype.hasOwnProperty.call(rpgProjectFromDoc(doc) ?? {}, 'battleScripts')
    ).toBe(false)
  })

  it('emit → parse で宣言が保たれる（往復）', async () => {
    const doc = await parseMarkdown(MD)
    const again = await parseMarkdown(await emitMarkdown(doc))
    expect(collectMasterData(again).battleScripts).toEqual(collectMasterData(doc).battleScripts)
  })

  it('組み立て: 敵・初期編成・途中参戦できる味方（side）。front は参戦者なし', async () => {
    const doc = await parseMarkdown(MD)
    const project = rpgProjectFromDoc(doc)
    if (!project) throw new Error('project')
    const roster: FieldBattleRoster = {
      party: project.party ?? {},
      order: project.partyOrder ?? [],
    }
    const def = project.battleScripts?.noto
    if (!def) throw new Error('def')
    const side = buildScriptedBattle(def, project.monsters ?? {}, roster, 'side', () => 0)
    expect(side?.enemies.map((e) => e.id)).toEqual(['water'])
    expect(side?.partyIds).toEqual(['hero'])
    expect(Object.keys(side?.script.joiners ?? {})).toEqual(['osananajimi'])
    expect(side?.script.id).toBe('noto')
    const front = buildScriptedBattle(def, project.monsters ?? {}, roster, 'front', () => 0)
    expect(Object.keys(front?.script.joiners ?? {})).toEqual([])
  })

  it('書いたとおりに進む: 負けが固定され、参戦し、結果に宣言したフラグと次のイベントが載る', async () => {
    const doc = await parseMarkdown(MD)
    const project = rpgProjectFromDoc(doc)
    if (!project) throw new Error('project')
    const roster: FieldBattleRoster = {
      party: project.party ?? {},
      order: project.partyOrder ?? [],
    }
    const def = project.battleScripts?.noto
    if (!def) throw new Error('def')
    const setup = buildScriptedBattle(def, project.monsters ?? {}, roster, 'side', () => 0)
    if (!setup) throw new Error('setup')
    const party = setup.partyIds.map((id) => partyDefToBattleEntity(roster.party[id], 'side'))
    const engine = new BattleEngine(party, setup.enemies, { rng: () => 0.5, script: setup.script })
    expect(engine.getState().log).toContain('水の召喚獣「……まだ、にげられると おもったか」')
    // にげられない
    engine.selectEscape()
    expect(engine.getState().phase).toBe('party-input')
    for (let i = 0; i < 50 && !engine.isOver(); i++) engine.selectAttack()
    const st = engine.getState()
    expect(st.phase).toBe('defeat')
    expect(st.script?.joined).toEqual(['osananajimi'])
    expect(st.enemies[0].hp).toBeGreaterThan(0) // 倒せない（下限 1）
    expect(engine.getResult()).toMatchObject({
      outcome: 'defeat',
      exp: 0,
      script: { id: 'noto', flags: { noto_lost: true }, next: 'after_noto' },
    })
  })

  it('不正な宣言があっても読み込みは落ちず、警告を出して続ける', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = await parseMarkdown(
      MD.replace('固定: 結果=敗北 上限ターン=6', '固定: 結果=ひきわけ')
    )
    const project = rpgProjectFromDoc(doc)
    const def = project?.battleScripts?.noto
    expect(def).toBeDefined()
    const roster: FieldBattleRoster = {
      party: project?.party ?? {},
      order: project?.partyOrder ?? [],
    }
    const setup = buildScriptedBattle(
      def ?? { id: 'x', rules: [] },
      project?.monsters ?? {},
      roster,
      'side',
      () => 0
    )
    const engine = new BattleEngine(
      (setup?.partyIds ?? []).map((id) => partyDefToBattleEntity(roster.party[id], 'side')),
      setup?.enemies ?? [],
      { rng: () => 0.5, script: setup?.script }
    )
    expect(engine.getState().phase).toBe('party-input')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('結果='))).toBe(true)
    warn.mockRestore()
  })
})

describe('buildScriptedBattle の境界', () => {
  const roster: FieldBattleRoster = {
    party: {
      hero: { id: 'hero', name: 'H', level: 1, hp: 10, mp: 0, atk: 1, def_value: 0, agi: 1 },
      ally: { id: 'ally', name: 'A', level: 1, hp: 10, mp: 0, atk: 1, def_value: 0, agi: 1 },
    } as unknown as FieldBattleRoster['party'],
    order: ['hero', 'ally'],
  }
  const masters = {
    slime: { id: 'slime', name: 'S', hp: 5, mp: 0, atk: 1, def_value: 0, agi: 1, exp: 1, gold: 1 },
  } as unknown as Parameters<typeof buildScriptedBattle>[1]

  it('敵が無い・組み立てられない宣言は null（警告）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(buildScriptedBattle({ id: 'a', rules: [] }, masters, roster, 'side', () => 0)).toBeNull()
    expect(
      buildScriptedBattle(
        { id: 'b', enemies: 'ghost', rules: [] },
        masters,
        roster,
        'side',
        () => 0
      )
    ).toBeNull()
    expect(
      buildScriptedBattle({ id: 'c', enemies: '  ', rules: [] }, masters, roster, 'side', () => 0)
    ).toBeNull()
    expect(warn).toHaveBeenCalledTimes(4)
    warn.mockRestore()
  })

  it('味方の指定: 無い id は飛ばす・全部無ければ従来のパーティ（空）。カンマ区切り・複数行・重複', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mk = (party: string[]) =>
      buildScriptedBattle(
        { id: 'a', enemies: 'slime', party, rules: [] },
        masters,
        roster,
        'side',
        () => 0
      )
    expect(mk(['ally, hero', 'ally'])?.partyIds).toEqual(['ally', 'hero'])
    expect(mk(['ghost, hero'])?.partyIds).toEqual(['hero'])
    expect(mk(['ghost'])?.partyIds).toEqual([])
    expect(mk(['hero'])?.script.joiners).toHaveProperty('ally')
    // 初期編成が空（従来のパーティ = 全員）なら、参戦者はいない
    expect(Object.keys(mk(['ghost'])?.script.joiners ?? {})).toEqual([])
    warn.mockRestore()
  })

  it('敵グループの書式: `+` とカンマの連結、個数', () => {
    const mk = (enemies: string) =>
      buildScriptedBattle({ id: 'a', enemies, rules: [] }, masters, roster, 'side', () => 0)
    expect(mk('slime+slime')?.enemies).toHaveLength(2)
    expect(mk('slime, slime, slime')?.enemies).toHaveLength(3)
    expect(mk('slime*3')?.enemies).toHaveLength(3)
  })

  it('parsePartyIds: 空・全角カンマ・未指定', () => {
    expect(parsePartyIds(undefined)).toEqual([])
    expect(parsePartyIds(['', ' , '])).toEqual([])
    expect(parsePartyIds(['a、b，c'])).toEqual(['a', 'b', 'c'])
  })
})
