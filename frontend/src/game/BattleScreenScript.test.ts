/** 脚本制御の戦闘 (#741 / #863) の画面側: 途中参戦の絵・行の追加、開始の台詞の再生、中断・敗北の閉じ方 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine, type BattleEngineOptions } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { BattleOutcome, BattleResult } from './loot'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 20,
    maxHp: 20,
    mp: 5,
    maxMp: 5,
    atk: 8,
    def: 1,
    agi: 5,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  partyViews: unknown[]
  statusTexts: unknown[]
  atbBars: unknown[]
  atbMarkers: unknown[]
  playback: { queue: unknown[]; active: { event: { label?: string; line?: boolean } } | null }
  messageText: { text: string; visible: boolean } | null
  seenEventTotal: number
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(
  rules: string[],
  opts: {
    party?: BattleEntity[]
    enemies?: BattleEntity[]
    engine?: Partial<BattleEngineOptions>
    screen?: Partial<BattleScreenOptions>
    joiners?: Record<string, BattleEntity>
  } = {}
) {
  const engine = new BattleEngine(
    opts.party ?? [entity('hero', { hp: 5, maxHp: 5 })],
    opts.enemies ?? [entity('boss', { hp: 200, maxHp: 200, atk: 30 })],
    {
      rng: () => 0.5,
      ...opts.engine,
      script: { id: 'sc', rules, ...(opts.joiners ? { joiners: opts.joiners } : {}) },
    }
  )
  const closed: { outcome: BattleOutcome; result: BattleResult }[] = []
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    onClose: (outcome, result) => closed.push({ outcome, result }),
    ...opts.screen,
  })
  created.push(s)
  return { s, engine, closed }
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
  vi.restoreAllMocks()
})

describe('途中参戦の見た目', () => {
  const joiners = { ally: entity('ally', { name: 'ALLY', hp: 30, maxHp: 30 }) }
  const rules = [
    '下限: 対象=hero HP=1',
    '参戦: 条件=HP[hero]<=1 対象=ally',
    '終了: 条件=ターン>=40 結果=中断',
  ]

  it('参戦すると、絵・HP の行が増える（ATB なら ATB のゲージ棒も）。落ちずに配置し直す', () => {
    const { s, engine } = setup(rules, { joiners })
    expect(I(s).partyViews).toHaveLength(1)
    expect(I(s).statusTexts).toHaveLength(1)
    engine.selectAttack()
    s.redraw(800, 450)
    expect(engine.getState().party).toHaveLength(2)
    expect(I(s).partyViews).toHaveLength(2)
    expect(I(s).statusTexts).toHaveLength(2)
    expect(I(s).atbBars).toHaveLength(0)
  })

  it('ATB: 参戦でゲージ棒と印が増える', () => {
    const { s, engine } = setup(rules, {
      joiners,
      party: [entity('hero', { hp: 5, maxHp: 5, agi: 10 })],
      enemies: [entity('boss', { hp: 200, maxHp: 200, atk: 6, agi: 10 })],
      engine: { atb: { mode: 'active' } },
    })
    expect(I(s).atbBars).toHaveLength(1)
    for (let i = 0; i < 100 && engine.getState().party.length < 2; i++) {
      if (engine.getState().phase === 'party-input') engine.selectAttack()
      else s.tick(200)
    }
    s.tick(1)
    expect(I(s).partyViews).toHaveLength(2)
    expect(I(s).atbBars).toHaveLength(2)
    expect(I(s).atbMarkers).toHaveLength(2)
  })

  it('front は先頭 1 人しか描かないので、参戦しても絵は増えない', () => {
    const { s, engine } = setup(rules, { joiners, screen: { layout: 'front' } })
    engine.selectAttack()
    s.redraw(800, 450)
    expect(engine.getState().party).toHaveLength(2)
    expect(I(s).partyViews).toHaveLength(0)
  })

  it('参戦のない戦闘では、味方の数は変わらず sync は何もしない', () => {
    const { s, engine } = setup(['台詞: 文=x'])
    engine.selectAttack()
    s.redraw(800, 450)
    expect(I(s).partyViews).toHaveLength(1)
  })
})

describe('開始の台詞（ff）', () => {
  it('戦闘の開始と同時に積まれた台詞は再生キューに入り、窓に出る。台詞の無い戦闘は従来どおり何も再生しない', () => {
    const { s } = setup(['台詞: 条件=開始 話者=ボス 文=かかってこい'], {
      screen: { presentation: 'ff' },
    })
    expect(I(s).playback.queue.length + (I(s).playback.active ? 1 : 0)).toBe(1)
    s.tick(1)
    expect(I(s).playback.active?.event.label).toBe('ボス「かかってこい」')
    expect(I(s).messageText?.text).toBe('ボス「かかってこい」')
    expect(I(s).messageText?.visible).toBe(true)

    const plain = new BattleEngine([entity('hero')], [entity('boss')], { rng: () => 0.5 })
    const ps = new BattleScreen(plain, 800, 450, { layout: 'side', presentation: 'ff' })
    created.push(ps)
    expect(I(ps).playback.queue.length + (I(ps).playback.active ? 1 : 0)).toBe(0)
  })

  it('台詞以外のイベントがすでにある（作り直した）画面は、過去を再生しない', () => {
    const engine = new BattleEngine(
      [entity('hero', { atk: 1 })],
      [entity('boss', { hp: 99, maxHp: 99, atk: 0 })],
      { rng: () => 0.5, script: { id: 'sc', rules: ['台詞: 条件=開始 文=はじまり'] } }
    )
    engine.selectAttack()
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
    created.push(s)
    expect(I(s).seenEventTotal).toBe(engine.getState().eventTotal)
    expect(I(s).playback.queue.length + (I(s).playback.active ? 1 : 0)).toBe(0)
  })
})

describe('終わり方', () => {
  it('中断（interrupted）は勝敗の待機なしで閉じ、結果に脚本のフラグと次が載る', () => {
    const { s, engine, closed } = setup(
      ['固定: 結果=中断 上限ターン=1', '中断時: フラグ=quake=true 次=field'],
      {
        enemies: [entity('boss', { hp: 500, maxHp: 500, atk: 0 })],
      }
    )
    engine.selectAttack()
    expect(engine.getState().phase).toBe('interrupted')
    s.tick(16)
    expect(closed).toHaveLength(1)
    expect(closed[0].outcome).toBe('interrupted')
    expect(closed[0].result.script).toEqual({ id: 'sc', flags: { quake: true }, next: 'field' })
    s.tick(16)
    expect(closed).toHaveLength(1) // 1 回だけ
  })

  it('脚本で決めた勝利・敗北は、通常の勝敗と同じ待機（読ませる時間）を経て閉じる', () => {
    const { s, engine, closed } = setup(['固定: 結果=敗北 上限ターン=1'], {
      party: [entity('hero', { hp: 99, maxHp: 99 })],
      enemies: [entity('boss', { hp: 99, maxHp: 99, atk: 0 })],
    })
    engine.selectAttack()
    expect(engine.getState().phase).toBe('defeat')
    s.tick(16)
    expect(closed).toHaveLength(0) // まだ読ませている
    s.tick(2000)
    expect(closed).toHaveLength(1)
    expect(closed[0].outcome).toBe('defeat')
  })
})
