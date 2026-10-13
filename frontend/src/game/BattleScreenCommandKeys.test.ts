/**
 * BattleScreen の十字コマンド配置・矢印キー即決定・表示名の上書き (#204) の単体テスト（独立テスト担当）。
 * キーは globalThis に KeyboardEvent を dispatch して検証する。決定の有無は handleCommand の spy で見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import { COMMAND_DEFAULTS, type CommandId } from './battleCommands'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 4,
    maxMp: 4,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

interface Internals {
  commands: Array<{ id: string; hit: Container; text: Text }>
  destroyed: boolean
  commandLayout: string
  handleCommand(id: CommandId): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(
  opts: BattleScreenOptions = { layout: 'side', commandLayout: 'cross' },
  engineOpts: ConstructorParameters<typeof BattleEngine>[2] = { rng: () => 0 },
  party: BattleEntity[] = [ent('a')],
  enemies: BattleEntity[] = [ent('s')]
): { s: BattleScreen; engine: BattleEngine; handle: ReturnType<typeof vi.fn> } {
  const engine = new BattleEngine(party, enemies, engineOpts)
  const s = new BattleScreen(engine, 800, 450, opts)
  created.push(s)
  // 決定されたコマンドの id を記録するだけ（エンジンは進めない）
  const handle = vi.fn()
  I(s).handleCommand = handle as never
  return { s, engine, handle }
}
const ATB = (initial?: { party?: number[]; enemies?: number[] }) => ({
  atb: { mode: 'wait' as const, initialGauges: initial },
  rng: () => 0,
})

/** 押下して KeyboardEvent を返す（defaultPrevented を見るため cancelable） */
function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = globalThis as unknown as EventTarget
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

afterEach(() => {
  for (const s of created.splice(0)) if (!I(s).destroyed) s.destroy({ children: true })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('十字キー: 方向とコマンドの対応', () => {
  it('cross+side: ArrowUp で たたかう(attack) を決定し、既定動作を止める', () => {
    const { handle } = build()
    const e = press('ArrowUp')
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('attack')
    expect(e.defaultPrevented).toBe(true)
  })

  it.each([
    ['ArrowLeft', 'spell'],
    ['ArrowRight', 'item'],
    ['ArrowDown', 'escape'],
  ] as const)('cross+side: %s で %s を決定', (key, id) => {
    const { handle } = build()
    press(key)
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith(id)
  })

  it.each(['a', 'Enter', ' ', 'w'])('矢印以外のキー(%j)は無反応で既定動作も止めない', (key) => {
    const { handle } = build()
    const e = press(key)
    expect(handle).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('キー 1 押しで handleCommand はちょうど 1 回', () => {
    const { handle } = build()
    press('ArrowUp')
    expect(handle).toHaveBeenCalledTimes(1)
  })
})

describe('十字キー: 無視する入力', () => {
  it.each(['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const)(
    '%s 付きの矢印キーは無視（ブラウザ/OS のショートカットを奪わない）',
    (mod) => {
      const { handle } = build()
      const e = press('ArrowUp', { [mod]: true })
      expect(handle).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    }
  )

  it('キーリピート(repeat:true)は無視（押しっぱなしで連打しない）', () => {
    const { handle } = build()
    press('ArrowUp', { repeat: true })
    expect(handle).not.toHaveBeenCalled()
  })

  it.each(['input', 'textarea', 'select'])(
    '<%s> 上の矢印キーはフォーム操作として奪わない',
    (tag) => {
      const { handle } = build()
      const el = document.createElement(tag)
      document.body.appendChild(el)
      const e = press('ArrowDown', {}, el)
      expect(handle).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    }
  )

  it('contentEditable 要素上の矢印キーは奪わない', () => {
    const { handle } = build()
    const el = document.createElement('div')
    // jsdom は isContentEditable を実装しないので、実ブラウザ同様に true を返すようにする
    Object.defineProperty(el, 'isContentEditable', { value: true })
    document.body.appendChild(el)
    press('ArrowDown', {}, el)
    expect(handle).not.toHaveBeenCalled()
  })

  it('普通の div 上の矢印キーは有効', () => {
    const { handle } = build()
    const el = document.createElement('div')
    document.body.appendChild(el)
    press('ArrowDown', {}, el)
    expect(handle).toHaveBeenCalledWith('escape')
  })

  it('入力不可フェーズ(enemy-turn)ではコマンドは無反応だが、ページのスクロールは止める', () => {
    const { handle, engine } = build()
    ;(engine.getState() as { phase: string }).phase = 'enemy-turn'
    const e = press('ArrowUp')
    expect(handle).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('cross 有効中は repeat の矢印キーも既定動作（スクロール）を止める。決定はしない', () => {
    const { handle } = build()
    const e = press('ArrowDown', { repeat: true })
    expect(handle).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('矢印以外のキーは既定動作を止めない', () => {
    const { handle } = build()
    const e = press('a')
    expect(handle).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('戦闘が終わった(closed)後は無反応', () => {
    const onClose = vi.fn()
    const engine = new BattleEngine([ent('a', { atk: 999 })], [ent('s', { hp: 1 })], {
      rng: () => 0,
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      commandLayout: 'cross',
      onClose,
    })
    created.push(s)
    press('ArrowUp') // 実際に たたかう が決定され勝利 → onClose
    expect(onClose).toHaveBeenCalledTimes(1)
    press('ArrowDown')
    press('ArrowUp')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(engine.getState().phase).toBe('victory')
  })
})

describe('十字キー: ATB のフェーズ別の有効状態', () => {
  it('atb-running(誰も待ちでない): ArrowDown(にげる)だけ発火。Up/Left/Right は無視', () => {
    const { handle } = build({ layout: 'side', commandLayout: 'cross' }, ATB())
    press('ArrowUp')
    press('ArrowLeft')
    press('ArrowRight')
    expect(handle).not.toHaveBeenCalled()
    press('ArrowDown')
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('escape')
  })

  it('party-input(ゲージ満タン): 4 方向すべて発火', () => {
    const { handle } = build({ layout: 'side', commandLayout: 'cross' }, ATB({ party: [1000] }))
    for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown']) press(k)
    expect(handle.mock.calls.map((c) => c[0])).toEqual(['attack', 'spell', 'item', 'escape'])
  })
})

describe('十字キー: リスナーのライフサイクル', () => {
  it('destroy でリスナーが外れ、以後のキーに反応しない', () => {
    const add = vi.spyOn(globalThis, 'addEventListener')
    const remove = vi.spyOn(globalThis, 'removeEventListener')
    const { s, handle } = build()
    const added = add.mock.calls.filter((c) => c[0] === 'keydown')
    expect(added).toHaveLength(1)
    s.destroy({ children: true })
    const removed = remove.mock.calls.filter((c) => c[0] === 'keydown')
    expect(removed).toHaveLength(1)
    expect(removed[0][1]).toBe(added[0][1])
    press('ArrowUp')
    expect(handle).not.toHaveBeenCalled()
  })

  it('作成→destroy→再作成で add/remove が釣り合い、1 押し 1 回（二重登録なし）', () => {
    const add = vi.spyOn(globalThis, 'addEventListener')
    const remove = vi.spyOn(globalThis, 'removeEventListener')
    const first = build()
    first.s.destroy({ children: true })
    const second = build()
    const keydown = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'keydown').length
    expect(keydown(add)).toBe(2)
    expect(keydown(remove)).toBe(1)
    press('ArrowUp')
    expect(first.handle).not.toHaveBeenCalled()
    expect(second.handle).toHaveBeenCalledTimes(1)
  })

  it('2 つ同時に生存しても、旧を destroy した後は新が 1 回だけ反応', () => {
    const a = build()
    const b = build()
    press('ArrowUp')
    expect(a.handle).toHaveBeenCalledTimes(1)
    expect(b.handle).toHaveBeenCalledTimes(1)
    a.s.destroy({ children: true })
    press('ArrowUp')
    expect(a.handle).toHaveBeenCalledTimes(1)
    expect(b.handle).toHaveBeenCalledTimes(2)
  })

  it('destroy を 2 回呼んでも例外にならない', () => {
    const { s } = build()
    s.destroy({ children: true })
    expect(() => s.destroy({ children: true })).not.toThrow()
  })

  it('globalThis.addEventListener が未定義でもコンストラクタは例外にならない', () => {
    const g = globalThis as unknown as { addEventListener?: unknown }
    const saved = g.addEventListener
    g.addEventListener = undefined
    try {
      expect(() => build()).not.toThrow()
    } finally {
      g.addEventListener = saved
    }
  })
})

describe('配置の有効条件', () => {
  it.each([
    ['grid', 'side'],
    [undefined, 'side'],
    ['diag', 'side'],
  ] as const)('commandLayout=%j (%s) はキーのリスナーを登録しない', (layout, mode) => {
    const add = vi.spyOn(globalThis, 'addEventListener')
    const { s, handle } = build({ layout: mode, commandLayout: layout as never })
    expect(add.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(0)
    expect(I(s).commandLayout).toBe('grid')
    press('ArrowUp')
    expect(handle).not.toHaveBeenCalled()
  })

  it('front+cross はリスナー無し・commandLayout は grid（十字は side 専用）', () => {
    const add = vi.spyOn(globalThis, 'addEventListener')
    const { s, handle } = build({ layout: 'front', commandLayout: 'cross' })
    expect(add.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(0)
    expect(I(s).commandLayout).toBe('grid')
    press('ArrowUp')
    expect(handle).not.toHaveBeenCalled()
  })

  it('side+cross の commandLayout は cross', () => {
    const { s } = build()
    expect(I(s).commandLayout).toBe('cross')
  })
})

describe('コマンド表示名の上書き', () => {
  const labels = (s: BattleScreen) => I(s).commands.map((c) => c.text.text)
  const ids = (s: BattleScreen) => I(s).commands.map((c) => c.id)
  const defaults = COMMAND_DEFAULTS.map((c) => c.label)

  it('commandLabels で表示テキストが変わり、id と並びは不変', () => {
    const { s } = build({
      layout: 'side',
      commandLabels: { attack: '斬る', spell: '魔石', item: '道具', escape: '逃走' },
    })
    expect(labels(s)).toEqual(['斬る', '魔石', '道具', '逃走'])
    expect(ids(s)).toEqual(COMMAND_DEFAULTS.map((c) => c.id))
  })

  it('未指定は既定の表示名', () => {
    const { s } = build({ layout: 'side' })
    expect(labels(s)).toEqual(defaults)
  })

  it('部分指定は指定した項目だけ差し替わる', () => {
    const { s } = build({ layout: 'front', commandLabels: { spell: '魔石' } })
    expect(labels(s)).toEqual([defaults[0], '魔石', defaults[2], defaults[3]])
  })
})

describe('キー処理の健全性', () => {
  it('4 方向を実エンジンで処理しても console.error / warn が出ない', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const engine = new BattleEngine([ent('a'), ent('b')], [ent('s', { hp: 9999 })], {
      rng: () => 0,
    })
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', commandLayout: 'cross' })
    created.push(s)
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) press(k)
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})

function release(key: string): void {
  globalThis.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
}

describe('十字キー: 戦闘開始時に押されていたキー (#204)', () => {
  it('initialHeldKeys のキーは、一度 keyup されるまで無視する（既定動作は止める）', () => {
    const { handle } = build({
      layout: 'side',
      commandLayout: 'cross',
      initialHeldKeys: ['ArrowUp'],
    })
    const e = press('ArrowUp')
    expect(handle).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
    press('ArrowUp', { repeat: true })
    expect(handle).not.toHaveBeenCalled()
    release('ArrowUp')
    press('ArrowUp')
    expect(handle).toHaveBeenCalledWith('attack')
  })

  it('押されていなかった別のキーは最初から有効', () => {
    const { handle } = build({
      layout: 'side',
      commandLayout: 'cross',
      initialHeldKeys: ['ArrowUp'],
    })
    press('ArrowLeft')
    expect(handle).toHaveBeenCalledWith('spell')
  })

  it('destroy で keyup リスナーも外れる', () => {
    const remove = vi.spyOn(globalThis, 'removeEventListener')
    const { s } = build()
    s.destroy({ children: true })
    expect(remove.mock.calls.filter((c) => c[0] === 'keyup')).toHaveLength(1)
  })
})

describe('十字キー: 設定オーバーレイが開いている間 (#204)', () => {
  it('設定ダイアログが開いている間は無視し、閉じると再び効く', () => {
    const { handle } = build()
    const d = document.createElement('div')
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-label', '設定')
    document.body.appendChild(d)
    const e = press('ArrowUp')
    expect(handle).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    d.remove()
    press('ArrowUp')
    expect(handle).toHaveBeenCalledWith('attack')
  })
})

describe('十字キー × ログのタイプ表示 (#755)', () => {
  it('logTypewriter=on・ATB off: 1 回目の ArrowUp は全文表示だけ、2 回目で attack が実行される', () => {
    const engine = new BattleEngine([ent('a')], [ent('s', { hp: 9999, maxHp: 9999 })], {
      rng: () => 0.5,
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      commandLayout: 'cross',
      logTypewriter: 'on',
    })
    created.push(s)
    const before = engine.getState().log.length
    press('ArrowUp')
    expect(engine.getState().log.length).toBe(before)
    press('ArrowUp')
    expect(engine.getState().log.length).toBeGreaterThan(before)
  })
})
