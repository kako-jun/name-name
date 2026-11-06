/**
 * FieldMenuScreen の「ロード」配線 (#1131 / 親 #1096 S4a)。画面の遷移は純関数（fieldMenuScreens.test.ts）で縛り、
 * ここでは「確認窓ではいを選ぶと opts.onLoad がそのスロットで 1 回呼ばれる」「いいえ・空では呼ばれない」を縛る。
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FIELD_MENU_ITEMS } from './fieldMenu'
import { FieldMenuScreen } from './FieldMenuScreen'

function setup(slots: (string | null)[], slotLoadable?: boolean[], saveLoadable = true) {
  const onLoad = vi.fn()
  const onSave = vi.fn(() => ({ label: 'x', loadable: saveLoadable }))
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

const toScreen = (s: FieldMenuScreen, id: string) => {
  s.dispatch({ type: 'tap', index: DEFAULT_FIELD_MENU_ITEMS.findIndex((d) => d.id === id) })
  s.tick(10_000)
}
const backToTop = (s: FieldMenuScreen) => {
  s.dispatch({ type: 'back' })
  s.tick(10_000)
}

describe('FieldMenuScreen: 同じメニューでセーブしたあとのロード可否', () => {
  it('空き→セーブ→同じメニューでロード: 確認窓が出る', () => {
    const { s, onSave } = setup([null, null, null], [false, false, false])
    toScreen(s, 'save')
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    expect(onSave).toHaveBeenCalledWith(0)
    backToTop(s)
    toScreen(s, 'load')
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    expect(s.current).toMatchObject({ notice: null, nav: { focus: 'confirm', confirm: 1 } })
  })
  it('ロード不能スロットを上書き保存 → ロード可（確認窓が出る）', () => {
    const { s } = setup(['ノベル', null, null], [false, false, false])
    toScreen(s, 'save')
    s.dispatch({ type: 'select', target: 'list', index: 0 }) // 埋まっているので確認窓
    s.dispatch({ type: 'select', target: 'confirm', index: 0 }) // はい=上書き
    backToTop(s)
    toScreen(s, 'load')
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    expect(s.current).toMatchObject({ nav: { focus: 'confirm' } })
  })
  it('ロード可能スロットの上書き → ロード可のまま', () => {
    const { s } = setup(['要約', null, null], [true, false, false])
    toScreen(s, 'save')
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    s.dispatch({ type: 'select', target: 'confirm', index: 0 })
    backToTop(s)
    toScreen(s, 'load')
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    expect(s.current).toMatchObject({ nav: { focus: 'confirm' } })
  })
  it('保存した内容がロードできないと判定されたスロットは通知のまま（他のスロットは変えない）', () => {
    const { s } = setup(['要約', null, null], [true, false, false], false)
    toScreen(s, 'save')
    s.dispatch({ type: 'select', target: 'list', index: 1 })
    backToTop(s)
    toScreen(s, 'load')
    s.dispatch({ type: 'select', target: 'list', index: 1 })
    expect(s.current).toMatchObject({ notice: 'スロット2はロードできません' })
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    expect(s.current).toMatchObject({ nav: { focus: 'confirm' } })
  })
})

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
