/**
 * 文書供給（loadEvents / loadScenes / setJumpSceneIndex）後の currentSceneId と onSceneChange が、
 * SceneIndex 分離 (#823) の前後で変わらないことの回帰。`NovelRenderer.documentSupply.test.ts` と同じ最小構成。
 */
import { describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})
const SCENES = [scene('s1', [narration('1')]), scene('s2', [narration('2')])]

describe('文書供給と SceneIndex の結線 (#823)', () => {
  it('loadScenes は開始しない: currentSceneId も onSceneChange も動かず、startFrom({}) で scenes[0] に入る', async () => {
    const r = new NovelRenderer()
    const changed = vi.fn()
    r.setOnSceneChange(changed)
    r.loadScenes(SCENES)
    expect(changed).not.toHaveBeenCalled()
    expect(r.getCurrentSceneId()).toBeNull()
    await r.startFrom({})
    expect(r.getCurrentSceneId()).toBe('s1')
    expect(changed.mock.calls).toEqual([['s1']])
  })

  it('loadEvents→startFrom({}) は sceneId を持たないので onSceneChange を呼ばない', async () => {
    const r = new NovelRenderer()
    const changed = vi.fn()
    r.setOnSceneChange(changed)
    r.loadEvents([narration('x')])
    await r.startFrom({})
    expect(r.getCurrentSceneId()).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('setJumpSceneIndex は再生に触れず、以後のジャンプ解決だけに効く（置換）', async () => {
    const r = new NovelRenderer()
    const changed = vi.fn()
    r.setOnSceneChange(changed)
    await r.setEvents([narration('x')])
    r.setJumpSceneIndex(SCENES)
    expect(r.getCurrentSceneId()).toBeNull()
    expect(changed).not.toHaveBeenCalled()
    expect(r.getAllSceneIds()).toEqual(['s1', 's2'])

    r.jumpToScene('s2')
    expect(r.getCurrentSceneId()).toBe('s2')
    expect(changed.mock.calls).toEqual([['s2']])

    r.setJumpSceneIndex([scene('s3', [narration('3')])])
    expect(r.getAllSceneIds()).toEqual(['s3'])
    expect(r.getCurrentSceneId()).toBe('s2')
  })
})
