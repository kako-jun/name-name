// #943: 同梱の寺町サンプルの吹き出し宣言 JSON と脚本 .md の整合。
import { describe, expect, it } from 'vitest'
import emotionsText from '../../public/field-sample/teramachi-emotions.json?raw'
import rawSampleText from './teramachi.sample.json?raw'
import { expandedTeramachiText } from './teramachiExpanded'
import scriptText from '../../public/field-sample/teramachi-npc.md?raw'
import { parseFieldEmotionsText } from '../game/fieldEmotionScript'
import { collectFieldEvents } from '../game/fieldScript'
import { parseMarkdown } from '../wasm/parser'
import { parseConfig } from './config'
import { buildBattleMenu } from './battleMenu'
import { buildBattleEngineOptions, buildBattleScreenOptions } from './battleOptions'
import { effectiveCommandLayout } from '../game/battleLayout'
import { motionTimingFor } from '../game/battleMotion'

const sampleText = expandedTeramachiText()

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
    // sit-by-me ledger/敵サイズ.yaml の グリッド種別（M149=1x1, M150=1x2, M148=2x1）
    expect(c.monsters.M149.size).toEqual({ w: 1, h: 1 })
    expect(c.monsters.M150.size).toEqual({ w: 1, h: 2 })
    expect(c.monsters.M148.size).toEqual({ w: 2, h: 1 })
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

  it('enemyList の指定は BattleScreen のオプションへ渡り、未指定は渡さない (#954)', () => {
    const base = { layout: 'side', spriteStyle: 'none', width: 800, height: 450 } as const
    expect(buildBattleScreenOptions({ ...base, enemyList: 'window' }, {}).enemyList).toBe('window')
    expect('enemyList' in buildBattleScreenOptions(base, {})).toBe(false)
  })

  it('ATB の設定が BattleEngine のオプションへ渡る（未指定はターン制）', () => {
    expect(buildBattleEngineOptions(load().battle)).toEqual({ atb: { mode: 'wait' } })
    expect(buildBattleEngineOptions({})).toEqual({})
  })

  it('#1043 同梱の寺町設定は enemyRow を持たず、モンスターに隊列・レベルも無い（本編相当は既定のまま）', () => {
    const c = load()
    expect(c.battle.enemyRow).toBeUndefined()
    expect(buildBattleEngineOptions(c.battle).enemyRow).toBeUndefined()
    for (const m of Object.values(c.monsters)) {
      expect('row' in m).toBe(false)
      expect('level' in m).toBe(false)
    }
  })

  it('buildBattleScreenOptions: 未指定のキーは出さない（従来の既定）', () => {
    const o = buildBattleScreenOptions(
      { layout: 'side', spriteStyle: 'none', width: 800, height: 450 },
      {}
    )
    expect(Object.keys(o).sort()).toEqual(['layout', 'spriteStyle'])
  })

  it('sit-by-me#52 寺町サンプルは 1920x1080 論理サイズで、UI スケール 2.4 が BattleScreen に渡る', () => {
    const b = load().battle
    expect(b.logicalSize).toBe('1920x1080')
    expect([b.width, b.height]).toEqual([1920, 1080])
    const o = buildBattleScreenOptions(b, { renderResolution: 2 })
    expect(o.uiScale).toBe(2.4)
    expect(o.renderResolution).toBe(2)
  })

  it('sit-by-me#52 logicalSize 未指定は uiScale / renderResolution を出さない（従来）', () => {
    const o = buildBattleScreenOptions(
      { layout: 'side', spriteStyle: 'none', width: 800, height: 450 },
      { renderResolution: 2 }
    )
    expect(o).not.toHaveProperty('uiScale')
    expect(o).not.toHaveProperty('renderResolution')
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

// #1020: 寺町の再開で、味方はアクスタ・poses つき、敵は寺町の台帳の敵だけ（汎用の試験敵を持ち込まない）
describe('寺町サンプルの人物・敵（#1020）', () => {
  const load = () => {
    const r = parseConfig(JSON.parse(sampleText), 'http://localhost/field-sample/')
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  const CORE = ['idle', 'ready', 'step', 'slash', 'cast', 'hurt', 'down', 'victory']

  it('歩行・戦闘とも spriteStyle acrylic', () => {
    const c = load()
    expect(c.spriteStyle).toBe('acrylic')
    expect(c.battle.spriteStyle).toBe('acrylic')
  })

  it('設定 JSON 自体に poses・歩行絵・味方の sprite を手書きしない（目録から導く）', () => {
    const raw = JSON.parse(rawSampleText) as {
      player: Record<string, unknown>
      party: Record<string, unknown>[]
    }
    expect(raw.player.sprites).toBeUndefined()
    for (const m of raw.party) {
      expect(m.poses).toBeUndefined()
      expect(m.sprite).toBeUndefined()
    }
  })

  it('味方 4 人の poses が 8 ポーズ全部そろう。人物単体版（-character）がある形態はそちらを使う', () => {
    const c = load()
    expect(c.party.map((m) => m.name)).toEqual(['ナム', 'オットン', 'シャー', 'ペー子'])
    // 基本 8 ポーズは必ずある（special・swing-* は絵のある形態だけ追加で入る）
    for (const m of c.party)
      expect(Object.keys(m.poses ?? {})).toEqual(expect.arrayContaining(CORE))
    const url = (i: number) => c.party[i].poses!.slash!
    expect(url(0)).toMatch(/C002\/poses\/C002-elementary-wheelchair-slash\.webp$/) // C002 に -character は無い
    expect(url(1)).toMatch(/C001\/poses\/C001-elementary-character-slash\.webp$/)
  })

  it('主人公（ナム C002 の小学生・車椅子）の歩行絵が 8 方向 3 コマ。車椅子なので歩行周期は既定のまま', () => {
    const c = load()
    expect(Object.keys(c.player.sprites)).toHaveLength(8)
    expect(c.player.sprites.up[0]).toMatch(
      /C002\/walk\/C002-elementary-wheelchair-walk-up-1\.webp$/
    )
    expect(c.player.cycle).toBeUndefined()
    expect(c.player.idleFrame).toBeUndefined()
  })

  it('エンカウントの敵は寺町の台帳の敵（M108/M148=well-merge、M145/M147/M149/M150/M151=sento）だけ', () => {
    const c = load()
    expect(Object.keys(c.monsters).sort()).toEqual(
      ['M108', 'M145', 'M147', 'M148', 'M149', 'M150', 'M151'].sort()
    )
    expect(c.monsters.dragon).toBeUndefined()
    expect(c.monsters.shachihoko).toBeUndefined()
    const ids = (scene: string) =>
      [...new Set(c.scenes[scene].encounter!.groups.flatMap((g) => g.split(/[+x×]/)))].sort()
    expect(ids('canal')).toEqual(['M108', 'M148'])
    expect(ids('bathhouse')).toEqual(['M145', 'M147', 'M149', 'M150', 'M151'])
    // barrier-free-ramp（TRM-10）は台帳でエンカウント 0
    expect(c.scenes.slope.encounter!.groups).toEqual([])
    for (const m of Object.values(c.monsters)) expect(m.sprite).toMatch(/\/enemies\/M\d+\.webp$/)
  })

  it('戦闘エフェクト（cast / impact / slash / magic）が配線されている', () => {
    expect(Object.keys(load().battle.effects ?? {}).sort()).toEqual(
      ['cast', 'impact', 'magic', 'slash'].sort()
    )
  })

  it('セーブの form で時期・車椅子が変わると、poses と歩行絵がその形態になり、立位は歩行周期が [0,1,2,1]', () => {
    const r = parseConfig(
      JSON.parse(expandedTeramachiText({ party1: 'teen-wheelchair', party2: 'uniform' })),
      'http://localhost/field-sample/'
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.value.party[0].poses!.idle).toMatch(/C002-teen-wheelchair-idle\.webp$/)
    expect(r.value.party[1].poses!.idle).toMatch(/C001-uniform-character-idle\.webp$/)
    expect(r.value.player.sprites.down[1]).toMatch(/C002-teen-wheelchair-walk-down-2\.webp$/)
    // 立位への切り替え（C002 の elementary は車椅子でない）
    const s = parseConfig(
      JSON.parse(expandedTeramachiText({ party1: 'elementary' })),
      'http://localhost/field-sample/'
    )
    if (!s.ok) throw new Error(s.error)
    expect(s.value.player.cycle).toEqual([0, 1, 2, 1])
    expect(s.value.player.idleFrame).toBe(1)
  })
})
