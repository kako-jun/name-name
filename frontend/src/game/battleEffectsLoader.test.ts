// #941: frontmatter `battle_effects` を、実パーサ（parseMarkdown。WASM 同梱）→ Document → rpgProjectFromDoc → JSON 読み込み・検証まで
// 通しで縛る。未宣言のゲームは従来どおり（エフェクトなし）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { rpgProjectFromDoc } from './rpgProjectFromDoc'
import {
  loadBattleEffects,
  parseBattleEffectsText,
  resolveRpgDataPath,
} from './battleEffectsLoader'

function md(extra: string): string {
  return [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    'battle_layout: side',
    'battle_presentation: ff',
    extra.trimEnd(),
    '---',
    '',
    '## map: village',
    '',
    '[マップ 3x2 タイル=32]',
    'GGG',
    'GGG',
    '[/マップ]',
    '',
    '[プレイヤー @1,1 向き=下]',
    '',
  ].join('\n')
}

const JSON_OK = JSON.stringify({
  impact: { image: 'fx/hit.png', frames: 4 },
  cast: { image: 'fx/cast.png', frames: 6, frameMs: 80 },
})

afterEach(() => vi.restoreAllMocks())

describe('parseMarkdown → rpgProjectFromDoc 経由の battle_effects', () => {
  it('frontmatter のパスが Document と RPGProject に出る。未指定・空は出ない', async () => {
    const doc = await parseMarkdown(md('battle_effects: "data/effects.json"\n'))
    expect(doc.battle_effects).toBe('data/effects.json')
    expect(rpgProjectFromDoc(doc)).not.toBeNull()
    expect(rpgProjectFromDoc(doc)?.battleEffects).toBe('data/effects.json')
    for (const extra of ['', 'battle_effects:\n']) {
      const none = await parseMarkdown(md(extra))
      expect(none.battle_effects).toBeNull()
      expect(rpgProjectFromDoc(none)?.battleEffects).toBeUndefined()
    }
  })
})

describe('resolveRpgDataPath', () => {
  it('相対は assets ルート直下、絶対指定はそのまま、ベースが無ければそのまま', () => {
    expect(resolveRpgDataPath('http://h/a/', 'data/e.json')).toBe('http://h/a/data/e.json')
    expect(resolveRpgDataPath('http://h/a', '/x/e.json')).toBe('/x/e.json')
    expect(resolveRpgDataPath('http://h/a', 'https://c/e.json')).toBe('https://c/e.json')
    expect(resolveRpgDataPath(undefined, 'data/e.json')).toBe('data/e.json')
  })
})

describe('parseBattleEffectsText', () => {
  it('画像は images 配下へ解決される', () => {
    const { effects, warnings } = parseBattleEffectsText(JSON_OK, 'http://h/a')
    expect(warnings).toEqual([])
    expect(effects?.impact?.image).toBe('http://h/a/images/fx/hit.png')
    expect(effects?.cast?.frameMs).toBe(80)
  })
  it('JSON でない・オブジェクトでない・全種類が不正・空は、警告して undefined（空は警告なし）', () => {
    expect(parseBattleEffectsText('{', undefined).effects).toBeUndefined()
    expect(parseBattleEffectsText('{', undefined).warnings[0]).toContain('JSON として読めません')
    expect(parseBattleEffectsText('[1]', undefined).warnings).toHaveLength(1)
    const bad = parseBattleEffectsText('{"impact":{"image":"a.png","frames":0}}', undefined)
    expect(bad.effects).toBeUndefined()
    expect(bad.warnings.length).toBeGreaterThan(0)
    expect(parseBattleEffectsText('{}', undefined)).toEqual({ effects: undefined, warnings: [] })
  })
  it('一部の種類だけ不正なら、残りは生きる', () => {
    const { effects, warnings } = parseBattleEffectsText(
      '{"impact":{"image":"a.png","frames":4},"slash":{"frames":2}}',
      undefined
    )
    expect(Object.keys(effects ?? {})).toEqual(['impact'])
    expect(warnings.length).toBe(1)
  })
})

describe('loadBattleEffects', () => {
  const ok = (body: string) => async () => new Response(body, { status: 200 })
  it('未宣言は fetch せず undefined', async () => {
    const f = vi.fn()
    expect(await loadBattleEffects(undefined, 'http://h/a', f)).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })
  it('宣言のパスを assets 基準で取得して検証する', async () => {
    const f = vi.fn(ok(JSON_OK))
    const e = await loadBattleEffects('data/effects.json', 'http://h/a', f)
    expect(f).toHaveBeenCalledWith('http://h/a/data/effects.json')
    expect(e?.impact?.image).toBe('http://h/a/images/fx/hit.png')
  })
  it('404・ネットワーク失敗・不正 JSON は警告して undefined（例外にしない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      await loadBattleEffects('e.json', undefined, async () => new Response('', { status: 404 }))
    ).toBeUndefined()
    expect(
      await loadBattleEffects('e.json', undefined, async () => {
        throw new Error('down')
      })
    ).toBeUndefined()
    expect(await loadBattleEffects('e.json', undefined, ok('nope'))).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
