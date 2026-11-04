/**
 * 全画面メニューのフィールド側の配線 (#880 / fieldMenuHost.ts) のテスト。
 * 観点: 開き始めから busy／戻るで閉じた同じ pointerdown を遮る（back → close → pointerdown の順）／
 * contextmenu／キー振り分け／≡ ボタンの表示と当たりが同じ面を使う／開けない状態・読み込み中の状態変化。
 */
import { describe, expect, it, vi } from 'vitest'
import { FieldMenuHost, type FieldMenuHostDeps, type FieldMenuScreenLike } from './fieldMenuHost'
import { computeMenuButtonRect, DEFAULT_FIELD_MENU_ITEMS, type FieldMenuInfo } from './fieldMenu'
import { DEFAULT_MENU_TRANSITION } from './fieldMenuTransition'

class FakeScreen implements FieldMenuScreenLike {
  isOpen = false
  transitioning = false
  settings: Record<string, number> = {}
  keys: string[] = []
  ticks = 0
  infos: FieldMenuInfo[] = []
  onClose: () => void = () => {}
  handleKey(code: string): boolean {
    this.keys.push(code)
    // X / Esc で閉じる（最上位）
    if (code === 'KeyX' || code === 'Escape') {
      this.isOpen = false
      this.onClose()
    }
    return ['KeyX', 'Escape', 'KeyZ', 'ArrowDown'].includes(code)
  }
  open(): void {
    this.isOpen = true
  }
  resize = vi.fn()
  setTimed = vi.fn()
  setInfo(i: FieldMenuInfo): void {
    this.infos.push(i)
  }
  tick(): void {
    this.ticks++
  }
  /** 「◀戻る」・右クリック相当（Pixi のハンドラが pointerdown で閉じる） */
  closeByPointer(): void {
    this.isOpen = false
    this.onClose()
  }
}

function setup(over: Partial<FieldMenuHostDeps> = {}) {
  const screen = new FakeScreen()
  const log: string[] = []
  let release: (() => void) | null = null
  let fieldState = {
    battle: false,
    battleTransition: false,
    talking: false,
    transition: false,
    warp: false,
  }
  let info: FieldMenuInfo = { place: 'p', gold: 0, playMs: 0, steps: 0 }
  const buttons: Array<unknown> = []
  const face = { w: 1920, h: 1080, cssScale: 1 }
  const deps: FieldMenuHostDeps = {
    screen,
    config: { items: [...DEFAULT_FIELD_MENU_ITEMS], transition: { ...DEFAULT_MENU_TRANSITION } },
    face: () => face,
    fieldState: () => fieldState,
    prepare: () =>
      new Promise((res) => {
        log.push('prepare')
        release = () => res({ party: [], slots: [null, null, null] })
      }),
    info: () => info,
    timed: () => false,
    enterView: () => log.push('enter'),
    leaveView: () => log.push('leave'),
    drawButton: (r) => buttons.push(r),
    disposed: () => false,
    ...over,
  }
  const host = new FieldMenuHost(deps)
  screen.onClose = () => host.onScreenClosed()
  return {
    host,
    screen,
    log,
    buttons,
    face,
    release: () => release?.(),
    setField: (s: Partial<typeof fieldState>) => (fieldState = { ...fieldState, ...s }),
    setInfo: (i: FieldMenuInfo) => (info = i),
  }
}
const key = (code: string, over: object = {}) => ({
  code,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...over,
})
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('開き始めから busy', () => {
  it('キーで開き始めた時点（テクスチャ待ち）から busy。二重には開かない', async () => {
    const t = setup()
    expect(t.host.busy).toBe(false)
    const r = t.host.onKeyDown(key('KeyX'), false)
    expect(r.handled).toBe(true)
    expect(t.host.busy).toBe(true)
    expect(t.screen.isOpen).toBe(false)
    // 待っている間のキーはフィールドへ渡さない（stop）
    expect(t.host.onKeyDown(key('KeyW'), false).stop).toBe(true)
    // 待っている間の2度目の開くキーは prepare を増やさない
    t.host.onKeyDown(key('KeyM'), false)
    expect(t.log.filter((l) => l === 'prepare')).toHaveLength(1)
    t.release()
    await flush()
    expect(t.screen.isOpen).toBe(true)
    expect(t.log).toEqual(['prepare', 'enter'])
  })
  it('待っている間に会話・戦闘が始まったら開かない（busy も解ける）', async () => {
    const t = setup()
    void t.host.open()
    t.setField({ talking: true })
    t.release()
    await flush()
    expect(t.screen.isOpen).toBe(false)
    expect(t.host.busy).toBe(false)
    expect(t.log).not.toContain('enter')
  })
  it('開けない状態（戦闘中など）では開き始めない', async () => {
    const t = setup()
    t.setField({ battle: true })
    expect(await t.host.open()).toBe(false)
    expect(t.log).toEqual([])
    expect(t.host.onKeyDown(key('KeyX'), false).handled).toBe(false)
  })
  it('文字入力中・修飾キー・長押しでは開かない', () => {
    const t = setup()
    expect(t.host.onKeyDown(key('KeyX'), true).handled).toBe(false)
    expect(t.host.onKeyDown(key('KeyX', { ctrlKey: true }), false).handled).toBe(false)
    expect(t.host.onKeyDown(key('KeyX', { repeat: true }), false).handled).toBe(false)
    expect(t.host.busy).toBe(false)
  })
  it('tick: 開き始めからメニューが塞ぐ（true）。フィールドは止まる', async () => {
    const t = setup()
    expect(t.host.tick(16)).toBe(false)
    void t.host.open()
    expect(t.host.tick(16)).toBe(true)
    t.release()
    await flush()
    expect(t.host.tick(16)).toBe(true)
    expect(t.screen.ticks).toBe(1)
  })
})

describe('閉じた同じ pointerdown をフィールドへ抜けさせない', () => {
  async function opened() {
    const t = setup()
    void t.host.open()
    t.release()
    await flush()
    return t
  }
  it('開いている最中の pointerdown は、Pixi が先に閉じても bubble 側から見て塞がれている（back → close → pointerdown の順）', async () => {
    const t = await opened()
    // window capture: pointerdown の始まり（メニューは開いている）
    t.host.beginPointer()
    // canvas capture（Pixi）: 「◀戻る」の pointerdown で閉じる
    t.screen.closeByPointer()
    expect(t.host.busy).toBe(false)
    // canvas bubble（main.ts の onPointerDown）: 閉じ済みでも、この操作は塞がれている
    expect(t.host.isMenuBlocked).toBe(true)
    // 同じ操作の contextmenu（右クリックで戻った場合）も止める
    expect(t.host.onContextMenu()).toBe(true)
  })
  it('次の pointerdown（メニューが閉じてから始まる）は通る。右クリックのメニューも通常どおり', async () => {
    const t = await opened()
    t.host.beginPointer()
    t.screen.closeByPointer()
    t.host.beginPointer()
    expect(t.host.isMenuBlocked).toBe(false)
    expect(t.host.onContextMenu()).toBe(false)
  })
  it('メニューを使わない pointerdown は塞がない', () => {
    const t = setup()
    t.host.beginPointer()
    expect(t.host.isMenuBlocked).toBe(false)
  })
  it('開き始め（テクスチャ待ち）の pointerdown も塞ぐ', () => {
    const t = setup()
    void t.host.open()
    t.host.beginPointer()
    expect(t.host.isMenuBlocked).toBe(true)
  })
  it('キーで閉じても閉じ切り後は塞がない（pointer の記録は pointerdown だけが更新）', async () => {
    const t = await opened()
    expect(t.host.onKeyDown(key('KeyX'), false)).toEqual({ handled: true, stop: true })
    expect(t.host.busy).toBe(false)
    expect(t.log[t.log.length - 1]).toBe('leave')
    expect(t.host.isMenuBlocked).toBe(false)
  })
})

describe('メニューが開いている間のキー', () => {
  it('対象キーはメニューが受けて止める。対象外は渡す。長押しは移動以外を受けつつ処理しない', async () => {
    const t = setup()
    void t.host.open()
    t.release()
    await flush()
    expect(t.host.onKeyDown(key('KeyZ'), false)).toEqual({ handled: true, stop: true })
    expect(t.host.onKeyDown(key('KeyQ'), false)).toEqual({ handled: false, stop: false })
    const before = t.screen.keys.length
    expect(t.host.onKeyDown(key('KeyZ', { repeat: true }), false)).toEqual({
      handled: true,
      stop: false,
    })
    expect(t.screen.keys).toHaveLength(before)
    expect(t.host.onKeyDown(key('ArrowDown', { repeat: true }), false).stop).toBe(true)
  })
  it('閉じるとき settings を持ち越し、次に開くとき渡す', async () => {
    const t = setup()
    const open = vi.spyOn(t.screen, 'open')
    void t.host.open()
    t.release()
    await flush()
    t.screen.settings = { bgm: 3 }
    t.host.onKeyDown(key('KeyX'), false)
    void t.host.open()
    t.release()
    await flush()
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { bgm: 3 } }))
  })
})

describe('≡ ボタン', () => {
  it('表示の矩形と当たりが同じ面（face）を使う', () => {
    const t = setup()
    t.face.cssScale = 0.25 // 縮小表示では 24 css px 下限で矩形が大きくなる
    t.host.syncButton()
    const r = computeMenuButtonRect(t.face.w, t.face.h, t.face.cssScale)
    expect(t.buttons[t.buttons.length - 1]).toEqual(r)
    // 矩形の内側（角）で当たり、外側は当たらない
    expect(t.host.tapButton({ x: r.x + 1, y: r.y + 1 })).toBe(true)
  })
  it('当たらない位置・開けない状態（会話中）では開かない。ボタンも隠れる', () => {
    const t = setup()
    expect(t.host.tapButton({ x: 5, y: 500 })).toBe(false)
    t.setField({ talking: true })
    const r = computeMenuButtonRect(1920, 1080, 1)
    expect(t.host.tapButton({ x: r.x + 1, y: r.y + 1 })).toBe(false)
    t.host.syncButton()
    expect(t.buttons[t.buttons.length - 1]).toBeNull()
  })
  it('開き始めたらボタンを隠す', async () => {
    const t = setup()
    void t.host.open()
    t.release()
    await flush()
    expect(t.buttons[t.buttons.length - 1]).toBeNull()
  })
})

describe('開いている間の情報帯（プレイ時間は進む）', () => {
  it('info が変わったら screen.setInfo に渡す。変わらなければ渡さない', async () => {
    const t = setup()
    void t.host.open()
    t.release()
    await flush()
    t.host.tick(16)
    const n = t.screen.infos.length
    t.host.tick(16)
    expect(t.screen.infos).toHaveLength(n)
    t.setInfo({ place: 'p', gold: 0, playMs: 5000, steps: 0 })
    t.host.tick(16)
    expect(t.screen.infos[t.screen.infos.length - 1]?.playMs).toBe(5000)
  })
})

describe('open の失敗と pointer 記録の使い切り', () => {
  it('prepare が reject しても握り、busy を解く（キー経由でも unhandled にならない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ prepare: () => Promise.reject(new Error('boom')) })
    expect(await t.host.open()).toBe(false)
    expect(t.host.busy).toBe(false)
    t.host.onKeyDown(key('KeyX'), false)
    await flush()
    expect(t.host.busy).toBe(false)
    expect(t.log).toEqual([])
    warn.mockRestore()
  })
  it('prepare が同期 throw しても握る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({
      prepare: () => {
        throw new Error('sync')
      },
    })
    expect(await t.host.open()).toBe(false)
    expect(t.host.busy).toBe(false)
    warn.mockRestore()
  })
  it('enterView 後に screen.open が throw したら leaveView で戻す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup()
    t.screen.open = () => {
      throw new Error('x')
    }
    void t.host.open()
    t.release()
    await flush()
    expect(t.log).toEqual(['prepare', 'enter', 'leave'])
    expect(t.host.busy).toBe(false)
    warn.mockRestore()
  })
  it('contextmenu で一度使ったら記録を解除する（その後の右クリックは通る）', async () => {
    const t = setup()
    void t.host.open()
    t.release()
    await flush()
    t.host.beginPointer()
    t.screen.closeByPointer()
    expect(t.host.onContextMenu()).toBe(true)
    expect(t.host.isMenuBlocked).toBe(false)
    expect(t.host.onContextMenu()).toBe(false)
  })
})

describe('open 失敗後の ≡ ボタン', () => {
  it('表示を隠した後で失敗しても隠れたままにならず、次の syncButton で同じ位置に描き直す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup()
    t.screen.open = () => {
      throw new Error('boom')
    }
    t.host.syncButton()
    const r = t.buttons[t.buttons.length - 1]
    expect(r).not.toBeNull()
    void t.host.open()
    t.release()
    await flush()
    expect(t.buttons[t.buttons.length - 1]).toBeNull() // open の途中で隠した
    t.host.syncButton()
    expect(t.buttons[t.buttons.length - 1]).toEqual(r)
    warn.mockRestore()
  })
})

describe('開くときの項目・せってい（#880）', () => {
  it('items() を渡すとそれで開き、無ければ config.items のまま', async () => {
    const opened: unknown[] = []
    const t = setup({ items: () => [{ id: 'item', label: 'どうぐ（実状態）' }] })
    t.screen.open = ((d: unknown) => {
      opened.push(d)
      t.screen.isOpen = true
    }) as never
    const p = t.host.open()
    t.release()
    await p
    expect((opened[0] as { items: { label: string }[] }).items[0].label).toBe('どうぐ（実状態）')
    const t2 = setup()
    t2.screen.open = ((d: unknown) => {
      opened.push(d)
      t2.screen.isOpen = true
    }) as never
    const p2 = t2.host.open()
    t2.release()
    await p2
    expect((opened[1] as { items: unknown[] }).items).toHaveLength(DEFAULT_FIELD_MENU_ITEMS.length)
  })
  it('settings() を渡すと開くたびにそれを使う。無ければ前回閉じたときの値を持ち越す', async () => {
    const opened: { settings: Record<string, number> }[] = []
    let live = { cursor: 1 }
    const t = setup({ settings: () => live })
    t.screen.open = ((d: { settings: Record<string, number> }) => {
      opened.push(d)
      t.screen.isOpen = true
    }) as never
    const p = t.host.open()
    t.release()
    await p
    expect(opened[0].settings).toEqual({ cursor: 1 })
    live = { cursor: 0 }
    t.screen.settings = { keys: 1 }
    t.screen.closeByPointer()
    const p2 = t.host.open()
    t.release()
    await p2
    expect(opened[1].settings).toEqual({ cursor: 0 })
  })
  it('settings() が無いときは画面が持つ前回値を持ち越す', async () => {
    const opened: { settings: Record<string, number> }[] = []
    const t = setup()
    t.screen.open = ((d: { settings: Record<string, number> }) => {
      opened.push(d)
      t.screen.isOpen = true
    }) as never
    const p = t.host.open()
    t.release()
    await p
    t.screen.settings = { keys: 1 }
    t.screen.closeByPointer()
    const p2 = t.host.open()
    t.release()
    await p2
    expect(opened[1].settings).toEqual({ keys: 1 })
  })
})
