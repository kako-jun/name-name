import { afterEach, describe, expect, it } from 'vitest'
import { isEditableTarget, isHeldKeyBlocked, isSettingsOverlayOpen } from './inputGuards'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isEditableTarget', () => {
  it('INPUT / TEXTAREA / SELECT / contenteditable は true', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true)
    }
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    expect(isEditableTarget(div)).toBe(true)
  })
  it('通常の要素・null・undefined は false', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })
})

describe('isSettingsOverlayOpen', () => {
  it('設定ダイアログが DOM にあれば true、なければ false', () => {
    expect(isSettingsOverlayOpen()).toBe(false)
    const d = document.createElement('div')
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-label', '設定')
    document.body.appendChild(d)
    expect(isSettingsOverlayOpen()).toBe(true)
  })
  it('別のダイアログは対象外', () => {
    const d = document.createElement('div')
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-label', 'メニュー')
    document.body.appendChild(d)
    expect(isSettingsOverlayOpen()).toBe(false)
  })
})

describe('isHeldKeyBlocked', () => {
  it('開始時に押されていたキーだけ true', () => {
    const held = new Set(['ArrowUp'])
    expect(isHeldKeyBlocked(held, 'ArrowUp')).toBe(true)
    expect(isHeldKeyBlocked(held, 'ArrowLeft')).toBe(false)
    expect(isHeldKeyBlocked(new Set(), 'ArrowUp')).toBe(false)
  })
})
