/**
 * シーンジャンプでの BGM 持ち越しのテスト (#724)。
 *
 * BGM は「変えるまで鳴り続ける」: startScene 経由のシーン遷移（jumpToScene）では
 * resetAndStartEvents が stopBgm / currentBgmPath=null をスキップし、次シーン冒頭の同一曲 [BGM:] も
 * AudioManager.playBgm の同一 URL 継続で頭出ししない。setEvents / restart / endStory では従来どおり停止する。
 *
 * playBgm / stopBgm は AudioContext を伴い jsdom 対象外のため spy で差し替え、呼び出しと
 * 追跡フィールド（currentBgmPath, getSnapshot）で検証する。同一 URL 継続は AudioManager 単体で別途確認する。
 * 実音は CLAUDE.md ルール7 の実機 golden path に委ねる。
 */
import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { AudioManager } from './AudioManager'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function bgm(path: string): Event {
  return { Bgm: { path, action: 'Play' } }
}

function bgmStop(): Event {
  return { Bgm: { path: '', action: 'Stop' } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Spies {
  playBgm: MockInstance<AudioManager['playBgm']>
  stopBgm: MockInstance<AudioManager['stopBgm']>
}

function makeRenderer(scenes: EventScene[]): { r: NovelRenderer; spies: Spies } {
  const r = new NovelRenderer()
  const am = r.getAudioManager()
  vi.spyOn(am, 'ensureContext').mockImplementation(() => {})
  const playBgm = vi.spyOn(am, 'playBgm').mockImplementation(async () => {})
  const stopBgm = vi.spyOn(am, 'stopBgm').mockImplementation(() => {})
  r.setScenes(scenes)
  return { r, spies: { playBgm, stopBgm } }
}

function bgmPath(r: NovelRenderer): string | null {
  return r.getSnapshot().currentBgmPath
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer BGM 持ち越し (#724)', () => {
  it('1: ジャンプ後 stopBgm は呼ばれず currentBgmPath が保持される', () => {
    const { r, spies } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [narration('B')]),
    ])
    expect(bgmPath(r)).toBe('a.ogg')
    spies.stopBgm.mockClear()

    r.jumpToScene('b')

    expect(r.getCurrentSceneId()).toBe('b')
    expect(spies.stopBgm).not.toHaveBeenCalled()
    expect(bgmPath(r)).toBe('a.ogg')
  })

  it('2: ジャンプ先冒頭の同一 [BGM:] は同じ URL で playBgm に渡る（AudioManager 側で継続）', () => {
    const { r, spies } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [bgm('a.ogg'), narration('B')]),
    ])
    spies.playBgm.mockClear()
    spies.stopBgm.mockClear()

    r.jumpToScene('b')

    expect(spies.stopBgm).not.toHaveBeenCalled()
    expect(spies.playBgm).toHaveBeenCalledTimes(1)
    expect(String(spies.playBgm.mock.calls[0][0])).toContain('a.ogg')
    expect(bgmPath(r)).toBe('a.ogg')
  })

  it('3: ジャンプ先が別曲なら切り替わる', () => {
    const { r, spies } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [bgm('b.ogg'), narration('B')]),
    ])
    spies.playBgm.mockClear()

    r.jumpToScene('b')

    expect(String(spies.playBgm.mock.calls[0][0])).toContain('b.ogg')
    expect(bgmPath(r)).toBe('b.ogg')
  })

  it('4: ジャンプ先の [BGM停止] で停止し currentBgmPath が null になる', () => {
    const { r, spies } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [bgmStop(), narration('B')]),
    ])
    spies.stopBgm.mockClear()

    r.jumpToScene('b')

    expect(spies.stopBgm).toHaveBeenCalled()
    expect(bgmPath(r)).toBeNull()
  })

  it('5: BGM の無いジャンプ先でも BGM が鳴り続ける（連続ジャンプでも保持）', () => {
    const { r, spies } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [narration('B')]),
      scene('c', [narration('C')]),
    ])
    spies.stopBgm.mockClear()

    r.jumpToScene('b')
    r.jumpToScene('c')

    expect(spies.stopBgm).not.toHaveBeenCalled()
    expect(bgmPath(r)).toBe('a.ogg')
  })

  it('6: setEvents（新しいイベント列の開始）では従来どおり停止する（回帰）', () => {
    const { r, spies } = makeRenderer([scene('a', [bgm('a.ogg'), narration('A')])])
    expect(bgmPath(r)).toBe('a.ogg')
    spies.stopBgm.mockClear()

    r.setEvents([narration('new')])

    expect(spies.stopBgm).toHaveBeenCalledWith(0)
    expect(bgmPath(r)).toBeNull()
  })

  it('7: restart では停止し currentBgmPath が null になる（回帰）', () => {
    const { r, spies } = makeRenderer([
      scene('a', [narration('A')]),
      scene('b', [bgm('b.ogg'), narration('B')]),
    ])
    r.jumpToScene('b')
    expect(bgmPath(r)).toBe('b.ogg')
    spies.stopBgm.mockClear()

    r.restart()

    expect(spies.stopBgm).toHaveBeenCalledWith(0)
    expect(bgmPath(r)).toBeNull()
  })

  it('8: endStory では停止する（回帰）', () => {
    const { r, spies } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [narration('B')]),
    ])
    r.jumpToScene('b')
    spies.stopBgm.mockClear()

    r.setConfinedSceneIds(['a'])
    r.jumpToScene('out-of-confinement')

    expect(spies.stopBgm).toHaveBeenCalled()
    expect(bgmPath(r)).toBeNull()
  })

  it('9: ジャンプ後の snapshot が currentBgmPath を持ち、restoreSnapshot で復元される', () => {
    const { r } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [narration('B1', 'B2')]),
    ])
    r.jumpToScene('b')
    const snap = r.getSnapshot()
    expect(snap.currentBgmPath).toBe('a.ogg')

    const { r: r2, spies: spies2 } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [narration('B1', 'B2')]),
    ])
    spies2.playBgm.mockClear()
    r2.restoreSnapshot(snap)

    expect(String(spies2.playBgm.mock.calls[0][0])).toContain('a.ogg')
    expect(bgmPath(r2)).toBe('a.ogg')
  })

  it('10: ジャンプ後の seekTo（履歴巻き戻し）でも currentBgmPath が整合する', () => {
    const { r } = makeRenderer([
      scene('a', [bgm('a.ogg'), narration('A')]),
      scene('b', [narration('B1'), narration('B2')]),
    ])
    r.jumpToScene('b')
    const idx = (r as unknown as { history: unknown[] }).history.length - 1
    expect(idx).toBeGreaterThanOrEqual(0)

    r.seekTo(idx)

    expect(bgmPath(r)).toBe('a.ogg')
  })
})

describe('AudioManager.playBgm 同一 URL 継続 (#724 前提)', () => {
  it('同じ URL の playBgm は現在の BGM を止めず頭出ししない', async () => {
    const am = new AudioManager()
    const internals = am as unknown as { ctx: unknown; currentBgmUrl: string | null }
    internals.ctx = {}
    internals.currentBgmUrl = 'x/a.ogg'
    const imm = vi
      .spyOn(am as unknown as { stopBgmImmediate: () => void }, 'stopBgmImmediate')
      .mockImplementation(() => {})

    await am.playBgm('x/a.ogg')

    expect(imm).not.toHaveBeenCalled()
  })
})
