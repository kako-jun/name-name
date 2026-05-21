// #239 review: variant → desk-* クラスのマッピングが DESIGN.md §4.1 と乖離しないことを担保する。
// EventCard.tsx の variantToDeskClass() を実描画経由でテストする。
//
// 元の EventCard はドラッグハンドル等の依存が多いので、レンダー部分が落ちないことと、
// 出力 DOM に期待するクラスが含まれることだけ最小確認する。
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import EventCard from './EventCard'
import type { Event, EventRef } from '../types'

function renderCard(event: Event) {
  const ref: EventRef = { chapterIdx: 0, sceneIdx: 0, eventIdx: 0 }
  const editingRef = { current: null } as React.RefObject<HTMLDivElement>
  return render(
    <EventCard
      event={event}
      chapterIdx={ref.chapterIdx}
      sceneIdx={ref.sceneIdx}
      eventIdx={ref.eventIdx}
      isDark={false}
      isEditing={false}
      isSelected={false}
      editingRef={editingRef}
      isDragging={false}
      draggedEvent={null}
      dropTarget={null}
      onEventChange={vi.fn()}
      onDeleteEvent={vi.fn()}
      onStartEditing={vi.fn()}
      onSelectEvent={vi.fn()}
      onEventDragStart={vi.fn()}
      onEventDragEnd={vi.fn()}
      onEventDragOver={vi.fn()}
      onEventDrop={vi.fn()}
    />
  )
}

describe('EventCard variant → desk-* class mapping (#239)', () => {
  it('Dialog は原稿用紙 (desk-genko + desk-body)', () => {
    const { container } = renderCard({
      Dialog: { character: 'A', expression: null, position: null, text: ['hi'] },
    })
    const card = container.querySelector('.desk-genko')
    expect(card).not.toBeNull()
    expect(card?.className).toContain('desk-body')
  })

  it('Narration は原稿用紙 (desk-genko + desk-body)', () => {
    const { container } = renderCard({ Narration: { text: ['夜だった'] } })
    expect(container.querySelector('.desk-genko')).not.toBeNull()
  })

  it('Choice は青付箋 (desk-fusen + desk-fusen-b)', () => {
    const { container } = renderCard({
      Choice: { options: [{ text: 'はい', jump: '1-2' }] },
    })
    const card = container.querySelector('.desk-fusen-b')
    expect(card).not.toBeNull()
    expect(card?.className).toContain('desk-fusen')
  })

  it('Monster は緑付箋 (desk-fusen-g)', () => {
    const { container } = renderCard({
      Monster: {
        id: 's',
        name: 'スライム',
        hp: 10,
        mp: 0,
        atk: 1,
        def: 1,
        agi: 1,
        exp: 1,
        gold: 1,
      },
    })
    expect(container.querySelector('.desk-fusen-g')).not.toBeNull()
  })

  it('Npc は桃付箋 (desk-fusen-p)', () => {
    const { container } = renderCard({
      Npc: { id: 'a', name: 'A', x: 0, y: 0, color: 0, message: [] },
    })
    expect(container.querySelector('.desk-fusen-p')).not.toBeNull()
  })

  it('Bgm / Wait / Background など演出系は黄付箋 (desk-fusen のみ、修飾色なし)', () => {
    const { container } = renderCard({ Bgm: { path: 'b.ogg', action: 'Play' } })
    const card = container.querySelector('.desk-fusen')
    expect(card).not.toBeNull()
    // 色修飾子が付かないことを確認
    expect(card?.className).not.toMatch(/desk-fusen-[pbg]\b/)
  })

  it('SceneTransition (string event) も desk-fusen でレンダーされる', () => {
    const { container } = renderCard('SceneTransition')
    expect(container.querySelector('.desk-fusen')).not.toBeNull()
  })
})
