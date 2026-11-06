/**
 * FieldMenuScreen の「ロード」配線 (#1131 / 親 #1096 S4a)。画面の遷移は純関数（fieldMenuScreens.test.ts）で縛り、
 * ここでは「確認窓ではいを選ぶと opts.onLoad がそのスロットで 1 回呼ばれる」「いいえ・空では呼ばれない」を縛る。
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FIELD_MENU_ITEMS } from './fieldMenu'
import { FieldMenuScreen } from './FieldMenuScreen'

function setup(slots: (string | null)[], slotLoadable?: boolean[]) {
  const onLoad = vi.fn()
  const onSave = vi.fn(() => 'x')
  const s = new FieldMenuScreen({
    width: 1600,
    height: 900,
    acrylic: false,
    onClose: () => {},
    onLoad,
    onSave,
  })
  s.open({
    items: DEFAULT_FIELD_MENU_ITEMS,
    party: [],
    info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
    slots,
    ...(slotLoadable ? { slotLoadable } : {}),
  })
  return { s, onLoad, onSave }
}

const toLoadScreen = (s: FieldMenuScreen) => {
  const idx = DEFAULT_FIELD_MENU_ITEMS.findIndex((d) => d.id === 'load')
  s.dispatch({ type: 'tap', index: idx })
  s.tick(10_000) // 画面遷移を終わらせる
}

describe('FieldMenuScreen: onLoad の配線', () => {
  it('埋まったスロットで「はい」→ onLoad(slot)。成功通知は出さない', () => {
    const { s, onLoad, onSave } = setup([null, '要約', null])
    toLoadScreen(s)
    s.dispatch({ type: 'select', target: 'list', index: 1 } as never)
    s.dispatch({ type: 'select', target: 'confirm', index: 0 } as never)
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(onLoad).toHaveBeenCalledWith(1)
    expect(onSave).not.toHaveBeenCalled()
  })
  it('「いいえ」・空スロットでは onLoad を呼ばない', () => {
    const { s, onLoad } = setup([null, '要約', null])
    toLoadScreen(s)
    s.dispatch({ type: 'select', target: 'list', index: 1 } as never)
    s.dispatch({ type: 'select', target: 'confirm', index: 1 } as never)
    s.dispatch({ type: 'select', target: 'list', index: 0 } as never)
    expect(onLoad).not.toHaveBeenCalled()
  })
  it('ロードできないスロット(ノベルのセーブなど)は確認窓を出さず onLoad も呼ばない', () => {
    const { s, onLoad } = setup(['要約', '要約', null], [false, true, false])
    toLoadScreen(s)
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    expect(s.current).toMatchObject({ open: true, notice: 'スロット1はロードできません' })
    s.dispatch({ type: 'select', target: 'confirm', index: 0 })
    expect(onLoad).not.toHaveBeenCalled()
  })
  it('onLoad 未指定でも落ちない（項目は出る・何も起きない）', () => {
    const s = new FieldMenuScreen({
      width: 1600,
      height: 900,
      acrylic: false,
      onClose: () => {},
    })
    s.open({
      items: DEFAULT_FIELD_MENU_ITEMS,
      party: [],
      info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
      slots: ['要約', null, null],
    })
    toLoadScreen(s)
    s.dispatch({ type: 'select', target: 'list', index: 0 } as never)
    expect(() => s.dispatch({ type: 'select', target: 'confirm', index: 0 } as never)).not.toThrow()
  })
})
