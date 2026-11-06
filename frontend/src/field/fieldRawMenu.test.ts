/**
 * `buildMenuRaw` の「ロード」の解決 (#1131 / 親 #1096 S4a)。`DEFAULT_FIELD_MENU_ITEMS` に `load` が入ったので、
 * 裸の `[メニュー]` も `[メニュー: …, セーブ, ロード]` も警告なしで解決される。
 */
import { describe, expect, it } from 'vitest'
import { buildMenuRaw } from './fieldRawMenu'

const ids = (raw: Record<string, unknown> | undefined) =>
  ((raw?.items as { id: string }[] | undefined) ?? []).map((i) => i.id)

describe('buildMenuRaw: ロード', () => {
  it('ラベル「ロード」と ID load のどちらでも解決し、警告しない', () => {
    for (const name of ['ロード', 'load']) {
      const warnings: string[] = []
      const raw = buildMenuRaw({ items: ['セーブ', name] }, [], [], undefined, warnings)
      expect(warnings).toEqual([])
      expect(ids(raw)).toEqual(['save', 'load'])
      expect((raw?.items as Record<string, unknown>[])[1]).toMatchObject({
        id: 'load',
        label: 'ロード',
        blockedWhileTimed: true,
        timedReason: '時間制限中はロードできません',
      })
    }
  })
  it('裸の [メニュー] は既定の10項目で、セーブの次がロード', () => {
    const warnings: string[] = []
    const raw = buildMenuRaw({}, [], [], undefined, warnings)
    expect(warnings).toEqual([])
    const got = ids(raw)
    expect(got).toHaveLength(10)
    expect(got[got.indexOf('save') + 1]).toBe('load')
  })
})
