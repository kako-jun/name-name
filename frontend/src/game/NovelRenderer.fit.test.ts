/**
 * NovelRenderer 明示フィット（#294）の CPU 側ロジックテスト。
 *
 * 立ち絵フィットは脚本の話者行 `フィット` / `fit` 由来で、Dialog イベントの `fit` に乗る。
 * GameState（snapshot / セーブ）には持たない表示属性なので、復元時は resolveCharacterFit が
 * 現在イベント以前の最新 Dialog から fit を引き当てる。ここでは純粋ロジックだけを検証する:
 *   - getTextEvent が Dialog.fit を text イベントへ透過する（未指定 / false は false に正規化）
 *   - resolveCharacterFit が「直近の同一話者 Dialog の fit」を index 境界どおり返す
 * 実ピクセル（実際の scale 適用）は CharacterLayer.test.ts（computeFitScale / show({fit})）と
 * ライブ blink に委ねる（CLAUDE.md ルール7）。
 */
import { describe, it, expect } from 'vitest'
import { getTextEvent, resolveCharacterFit } from './NovelRenderer'
import type { Event } from '../types'

function dialog(character: string, fit?: boolean): Event {
  return {
    Dialog: {
      character,
      expression: 'normal',
      position: '中央',
      text: ['…'],
      fit,
    },
  } as Event
}

describe('getTextEvent は Dialog.fit を透過する (#294)', () => {
  it('fit=true はそのまま true', () => {
    const evt = getTextEvent(dialog('カコ', true))
    expect(evt?.type).toBe('dialog')
    expect(evt?.type === 'dialog' && evt.fit).toBe(true)
  })

  it('fit 未指定は false に正規化する', () => {
    const evt = getTextEvent(dialog('カコ'))
    expect(evt?.type === 'dialog' && evt.fit).toBe(false)
  })

  it('fit=false は false', () => {
    const evt = getTextEvent(dialog('カコ', false))
    expect(evt?.type === 'dialog' && evt.fit).toBe(false)
  })
})

describe('resolveCharacterFit は復元時に直近 Dialog の fit を引き当てる (#294)', () => {
  const events: Event[] = [
    dialog('カコ', true), // 0: カコ をフィットで登場
    dialog('トモ', false), // 1: トモ は原寸
    dialog('カコ', false), // 2: カコ を原寸に上書き
    dialog('トモ', true), // 3: トモ をフィットに上書き
  ]

  it('index=0 時点では カコ=true（最初のフィット登場）', () => {
    expect(resolveCharacterFit(events, 0, 'カコ')).toBe(true)
  })

  it('index=3 時点では カコ=false（index 2 の上書きが直近）', () => {
    expect(resolveCharacterFit(events, 3, 'カコ')).toBe(false)
  })

  it('index=3 時点では トモ=true（index 3 が直近）', () => {
    expect(resolveCharacterFit(events, 3, 'トモ')).toBe(true)
  })

  it('index=1 時点では トモ=false（index 1 が直近、index 3 はまだ未来なので見ない）', () => {
    expect(resolveCharacterFit(events, 1, 'トモ')).toBe(false)
  })

  it('登場していない話者は false', () => {
    expect(resolveCharacterFit(events, 3, 'いない人')).toBe(false)
  })

  it('eventIndex が範囲外（過大）でも末尾までで安全にクランプして探索する', () => {
    expect(resolveCharacterFit(events, 999, 'トモ')).toBe(true)
  })
})
