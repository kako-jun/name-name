import { describe, expect, it } from 'vitest'
import type { Event, EventDocument } from '../types'
import { EVENT_ROLE, fieldEntryOfDoc, roleOfEvent, type EventKey } from './fieldEntryOfDoc'

function docOf(...scenes: Event[][]): EventDocument {
  return {
    engine: 'name-name',
    chapters: [
      {
        number: 1,
        title: 't',
        hidden: false,
        default_bgm: null,
        scenes: scenes.map((events, i) => ({ id: `s${i}`, title: '', view: 'TopDown', events })),
      },
    ],
  } as unknown as EventDocument
}

const dialog: Event = {
  Dialog: { character: null, expression: null, position: null, text: ['a'] },
}
const field = (f: {
  scene: string
  x?: number
  y?: number
  direction?: 'Up' | 'Down' | 'Left' | 'Right'
}): Event => ({ Field: f })
const settings = { FieldSettings: {} } as unknown as Event
const map = { FieldMap: {} } as unknown as Event
const rpgMap = { RpgMap: {} } as unknown as Event
const monster = { Monster: {} } as unknown as Event

describe('fieldEntryOfDoc', () => {
  it('先頭が Field なら入口を返す', () => {
    expect(fieldEntryOfDoc(docOf([field({ scene: 'a' })]))).toEqual({ sceneId: 'a' })
  })
  it('先頭が台詞で後ろに Field ならノベル(null)', () => {
    expect(fieldEntryOfDoc(docOf([dialog, field({ scene: 'a' })]))).toBeNull()
  })
  it('Field が無ければ null', () => {
    expect(fieldEntryOfDoc(docOf([dialog]))).toBeNull()
    expect(fieldEntryOfDoc(docOf([settings, map]))).toBeNull()
  })
  it('RpgMap が先頭に同居しても no-op として読み飛ばす(RPG への振り分けは呼び出し側)', () => {
    expect(fieldEntryOfDoc(docOf([rpgMap, field({ scene: 'a' })]))).toEqual({ sceneId: 'a' })
  })
  it('先頭に設定・地図・マスターデータが並んでから Field', () => {
    expect(fieldEntryOfDoc(docOf([settings, map, monster, field({ scene: 'a' })]))).toEqual({
      sceneId: 'a',
    })
  })
  it('場面・章をまたいで線形に見る', () => {
    expect(fieldEntryOfDoc(docOf([settings], [map], [field({ scene: 'b' })]))).toEqual({
      sceneId: 'b',
    })
    expect(fieldEntryOfDoc(docOf([settings], [dialog], [field({ scene: 'b' })]))).toBeNull()
  })
  it('向き・座標を変換する(Direction → Facing)', () => {
    expect(
      fieldEntryOfDoc(docOf([field({ scene: 'a', x: 10, y: 20, direction: 'Left' })]))
    ).toEqual({
      sceneId: 'a',
      x: 10,
      y: 20,
      facing: 'left',
    })
    for (const [d, f] of [
      ['Up', 'up'],
      ['Down', 'down'],
      ['Left', 'left'],
      ['Right', 'right'],
    ] as const) {
      expect(fieldEntryOfDoc(docOf([field({ scene: 'a', direction: d })]))?.facing).toBe(f)
    }
  })
  it('x=0,y=0 は省略扱いにしない', () => {
    expect(fieldEntryOfDoc(docOf([field({ scene: 'a', x: 0, y: 0 })]))).toEqual({
      sceneId: 'a',
      x: 0,
      y: 0,
    })
  })
  it('空 doc・章なし・場面なし', () => {
    expect(fieldEntryOfDoc(docOf())).toBeNull()
    expect(fieldEntryOfDoc(docOf([]))).toBeNull()
    expect(fieldEntryOfDoc({ engine: 'name-name' } as unknown as EventDocument)).toBeNull()
  })
  it('文字列イベント(PageBreak)・演出・フロー制御は再生イベント', () => {
    expect(fieldEntryOfDoc(docOf(['PageBreak', field({ scene: 'a' })]))).toBeNull()
    expect(
      fieldEntryOfDoc(docOf([{ Flag: { name: 'x', value: true } }, field({ scene: 'a' })]))
    ).toBeNull()
    expect(
      fieldEntryOfDoc(
        docOf([{ Background: { path: 'x' } } as unknown as Event, field({ scene: 'a' })])
      )
    ).toBeNull()
  })
})

describe('EVENT_ROLE の分類(固定)', () => {
  const keysOf = (role: string): string[] =>
    Object.entries(EVENT_ROLE)
      .filter(([, r]) => r === role)
      .map(([k]) => k)
      .sort()

  it('field は Field のみ', () => {
    expect(keysOf('field')).toEqual(['Field'])
  })
  it('noop の一覧', () => {
    expect(keysOf('noop')).toEqual(
      [
        'BattleScript',
        'CharacterForms',
        'Currency',
        'Emotion',
        'FieldAssist',
        'FieldEdge',
        'FieldMap',
        'FieldMenu',
        'FieldMenuItem',
        'FieldScroll',
        'FieldSettings',
        'FieldShake',
        'FieldWalkSprite',
        'FieldWarp',
        'Item',
        'Job',
        'Magicite',
        'Monster',
        'Npc',
        'PartyMember',
        'PlayerStart',
        'RpgEvent',
        'RpgMap',
        'RpgTrigger',
        'Skill',
        'Spell',
        'Status',
        'Summon',
        'UiImages',
      ].sort()
    )
  })
  it('本文・フロー制御は play', () => {
    for (const k of [
      'Dialog',
      'Narration',
      'PageBreak',
      'Choice',
      'Condition',
      'Flag',
      'Jump',
      'Wait',
      'WaitDisplayComplete',
    ]) {
      expect(EVENT_ROLE[k as EventKey]).toBe('play')
    }
  })
  it('未知の種は play(安全側)', () => {
    expect(roleOfEvent({ NoSuchEvent: {} } as unknown as Event)).toBe('play')
    expect(roleOfEvent('NoSuchSignal' as unknown as Event)).toBe('play')
    expect(roleOfEvent({} as unknown as Event)).toBe('play')
  })
  it('Object.prototype の名前を種と誤認しない', () => {
    expect(roleOfEvent({ constructor: {} } as unknown as Event)).toBe('play')
  })
})
