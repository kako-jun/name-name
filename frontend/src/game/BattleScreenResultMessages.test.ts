/**
 * 勝利リザルトのメッセージ送り (#1039) の BattleScreen 側の挙動。文言・時間計算は battleResult.test.ts。
 * ここは ff の勝利でメッセージが順に出て戦利品が最後になること・生き残りの味方の victory 交互・
 * 決定操作で全部飛ばせること・dq / front は従来どおり・0 件は窓なし 1500ms を確かめる。
 */
import { afterEach, describe, expect, it } from 'vitest'
import 'pixi.js/events'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  RESULT_HOLD_DQ_MS,
  RESULT_HOLD_FF_MS,
  RESULT_MESSAGE_STEP_MS,
  RESULT_SKIP_GUARD_MS,
  RESULT_TEXT,
  RESULT_VICTORY_FLIP_MS,
  resultHoldMs,
} from './battleResult'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 30,
    maxHp: 30,
    mp: 4,
    maxMp: 4,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  commands: { id: string; hit: Container }[]
  messageText: Text | null
  logPanel: Container
  resultElapsed: number | null
  resultMessages: string[]
  sampleEntity(
    side: 'party' | 'enemy',
    index: number
  ): { pose: string; forward: number; downProgress: number }
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
}
const tap = (s: BattleScreen, id: string) =>
  I(s)
    .commands.find((c) => c.id === id)!
    .hit.emit('pointertap', {} as never)
const tapScreen = (s: BattleScreen) => s.emit('pointertap', {} as never)
const press = (key: string) => globalThis.dispatchEvent(new KeyboardEvent('keydown', { key }))

/** gold 3 / exp 5 / 戦利品 potion。味方は生存 2 人 + 倒れた 1 人 */
function setup(opts: BattleScreenOptions = {}, enemy: Partial<BattleEntity> = {}) {
  const engine = new BattleEngine(
    [entity('hero', { atk: 999 }), entity('mage'), entity('dead', { hp: 0 })],
    [
      entity('slime', {
        hp: 1,
        maxHp: 1,
        exp: 5,
        gold: 3,
        loot: { drops: ['potion 確率=100'] },
        ...enemy,
      }),
    ],
    { rng: () => 0.5, itemNames: { potion: 'ポーション' } }
  )
  const closed: string[] = []
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    onClose: (o) => closed.push(o),
    ...opts,
  })
  created.push(s)
  return { s, engine, closed }
}
/** 攻撃して、リザルト待機が始まるまで進める（経過 0 付近で止まる） */
function toResult(s: BattleScreen) {
  tap(s, 'attack')
  let guard = 0
  while (I(s).resultElapsed === null && guard++ < 600) run(s, 16)
  expect(I(s).resultElapsed).not.toBeNull()
}

afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('ff 勝利: メッセージが順に出る (#1039)', () => {
  it('勝利の言葉 → お金 → 経験値 → 戦利品（最後）の順に 1 件ずつ出て、最後の件で止まる', () => {
    const { s } = setup({ presentation: 'ff' })
    toResult(s)
    const expected = [
      RESULT_TEXT.victory,
      RESULT_TEXT.gold(3),
      RESULT_TEXT.exp(5),
      RESULT_TEXT.loot('ポーション'),
    ]
    expect(I(s).resultMessages).toEqual(expected)
    const seen: string[] = []
    for (let i = 0; i < 40; i++) {
      const t = I(s).messageText!.text
      if (seen[seen.length - 1] !== t) seen.push(t)
      run(s, 100)
    }
    // 閉じる前まで観測（閉じても窓の最後の文字は残る）
    expect(seen).toEqual(expected)
    expect(I(s).messageText!.text).toBe(RESULT_TEXT.loot('ポーション'))
  })

  it('待機は件数ぶん伸び、その手前では閉じず、過ぎたら 1 回だけ閉じる', () => {
    const { s, closed } = setup({ presentation: 'ff' })
    toResult(s)
    const hold = resultHoldMs('ff', 4)
    expect(hold).toBe(4 * RESULT_MESSAGE_STEP_MS)
    const before = I(s).resultElapsed!
    run(s, hold - before - 32)
    expect(closed).toEqual([])
    run(s, 64)
    expect(closed).toEqual(['victory'])
  })

  it('味方の生き残りは victory と通常を交互に繰り返す（最初は victory）。倒れた味方は倒れたまま', () => {
    const { s } = setup({ presentation: 'ff' })
    toResult(s)
    const poses = () =>
      [0, 1, 2].map((i) => I(s).sampleEntity('party', i)) as {
        pose: string
        downProgress: number
      }[]
    const first = poses()
    expect(first[0].pose).toBe('victory')
    expect(first[1].pose).toBe('victory')
    expect(first[2].pose).not.toBe('victory')
    const downProgress = first[2].downProgress
    run(s, RESULT_VICTORY_FLIP_MS)
    const second = poses()
    expect(second[0].pose).not.toBe('victory')
    expect(second[1].pose).not.toBe('victory')
    expect(second[2].pose).not.toBe('victory')
    expect(second[2].downProgress).toBe(downProgress)
    run(s, RESULT_VICTORY_FLIP_MS)
    const third = poses()
    expect(third[0].pose).toBe('victory')
    expect(third[2].downProgress).toBe(downProgress)
  })

  it('決定操作（画面タップ・決定キー）で、全部のメッセージを飛ばして閉じる', () => {
    const a = setup({ presentation: 'ff' })
    toResult(a.s)
    run(a.s, RESULT_SKIP_GUARD_MS)
    expect(a.closed).toEqual([])
    expect(I(a.s).messageText!.text).toBe(RESULT_TEXT.victory) // まだ最初の件
    tapScreen(a.s)
    expect(a.closed).toEqual(['victory'])

    const b = setup({ presentation: 'ff' })
    toResult(b.s)
    run(b.s, RESULT_SKIP_GUARD_MS)
    press('Enter')
    expect(b.closed).toEqual(['victory'])
  })

  it('猶予内の決定操作では飛ばない', () => {
    const { s, closed } = setup({ presentation: 'ff' })
    toResult(s)
    tapScreen(s)
    expect(closed).toEqual([])
  })

  it('お金・経験値・戦利品なし: 勝利の言葉 1 件だけを出し、ff の最低待機 1500ms で閉じる', () => {
    const { s, closed } = setup({ presentation: 'ff' }, { exp: 0, gold: 0, loot: undefined })
    toResult(s)
    expect(I(s).resultMessages).toEqual([RESULT_TEXT.victory])
    expect(I(s).messageText!.visible).toBe(true)
    expect(I(s).messageText!.text).toBe(RESULT_TEXT.victory)
    const before = I(s).resultElapsed!
    run(s, RESULT_HOLD_FF_MS - before - 32)
    expect(closed).toEqual([])
    run(s, 64)
    expect(closed).toEqual(['victory'])
  })
})

describe('dq / front は従来どおり (#1039)', () => {
  it('dq: メッセージ列は空で、待機は RESULT_HOLD_DQ_MS。生き残りは victory のまま固定', () => {
    const { s, closed } = setup()
    tap(s, 'attack')
    expect(I(s).resultMessages).toEqual([])
    s.tick(RESULT_HOLD_DQ_MS - 1)
    expect(closed).toEqual([])
    s.tick(1)
    expect(closed).toEqual(['victory'])
  })

  it('front: ff を指定しても layout front なら dq 扱いで、メッセージ列は空・待機は dq と同じ', () => {
    const { s, closed } = setup({ presentation: 'ff', layout: 'front' })
    tap(s, 'attack')
    expect(I(s).resultMessages).toEqual([])
    s.tick(RESULT_HOLD_DQ_MS - 1)
    expect(closed).toEqual([])
    s.tick(1)
    expect(closed).toEqual(['victory'])
  })
})
