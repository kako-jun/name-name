/** 戦闘画面サンプルの設定 JSON のエフェクト重ね (#936): effects の検証（不正は警告して無視）、URL 解決、未宣言で従来と同一 */
import { describe, expect, it, vi } from 'vitest'
import effectsSample from '../../public/battle-sample/effects.json?raw'
import {
  buildBattleSetup,
  initialView,
  parseConfig,
  parseConfigText,
  assetsToUnload,
} from './config'

const BASE = 'https://example.com/dir/x.json'
const HERO = { id: 'hero', name: 'H', hp: 100, atk: 10, def: 1, agi: 5 }

describe('effects: 設定 JSON', () => {
  it('未指定は空で、BattleScreen のオプションにも effects が付かない（従来と同一）', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.effects).toEqual({})
    const setup = buildBattleSetup(r.value, initialView(r.value))
    expect('effects' in setup.options).toBe(false)
  })

  it('宣言を検証し、画像を設定 JSON の位置から解決して options に載せる', () => {
    const r = parseConfig(
      { party: [HERO], effects: { slash: { image: 'fx/s.png', frames: 6, frameMs: 40 } } },
      BASE
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.effects.slash).toMatchObject({
      image: 'https://example.com/dir/fx/s.png',
      frames: 6,
      columns: 6,
      frameMs: 40,
    })
    const setup = buildBattleSetup(r.value, initialView(r.value))
    expect(setup.options.effects?.slash?.frames).toBe(6)
  })

  it('不正な種類・値は読み込みを止めず、警告して無視する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = parseConfig(
      {
        effects: {
          slash: { image: 'a.png', frames: 0 },
          fire: { image: 'a.png', frames: 2 },
          magic: { image: 'm.png', frames: 2, columns: 2 },
        },
      },
      BASE
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value.effects)).toEqual(['magic'])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('effects がオブジェクトでなくても止まらない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = parseConfig({ effects: 3 }, BASE)
    expect(r.ok && r.value.effects).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('pixelArt の切り替えで、シート画像も解放の対象になる', () => {
    const r = parseConfig({ effects: { cast: { image: 'c.png', frames: 2 } } }, BASE)
    if (!r.ok) throw new Error('parse')
    const view = initialView(r.value)
    const urls = assetsToUnload('off', { ...view, pixelArt: 'on' }, r.value)
    expect(urls).toContain('https://example.com/dir/c.png')
  })

  it('同梱サンプル effects.json は ok で 5 種類すべてを宣言している', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = parseConfigText(effectsSample, 'http://localhost:7374/battle-sample/effects.json')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.value.effects).sort()).toEqual([
      'cast',
      'impact',
      'magic',
      'slash',
      'summon',
    ])
    expect(r.value.presentation).toBe('ff')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
