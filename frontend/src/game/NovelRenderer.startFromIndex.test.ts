/**
 * 動画書き出しの開始シーンがシーン索引（jumpSceneIndex）から引ける (#734 PR4)。
 * エディタのプレビューは events を平坦化して渡す。索引（setJumpSceneIndex）が無いと
 * `startFrom({ sceneId })` は not-found になり、書き出しは reject される。
 */
import { describe, it, expect, vi } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { EventScene } from '../types'

const scene = (id: string): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events: [{ Narration: { text: [id], voice_path: null, font_family: null } }],
})

function setup() {
  vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
  vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  const h = r as unknown as { render(): void; initialized: boolean }
  vi.spyOn(h, 'render').mockImplementation(() => {})
  h.initialized = true
  return r
}

describe('エディタのプレビュー: 開始シーンの引き当て (#734)', () => {
  const scenes = [scene('hub'), scene('S1')]
  const flat = scenes.flatMap((s) => s.events)

  it('索引なし（平坦な events だけ）では not-found になる', async () => {
    const r = setup()
    r.loadEvents(flat)
    expect(await r.startFrom({ sceneId: 'hub' })).toEqual({ status: 'failed', reason: 'not-found' })
  })

  it('索引あり（jumpSceneIndex）なら任意の開始シーンで entered になる', async () => {
    const r = setup()
    r.setJumpSceneIndex(scenes)
    r.loadEvents(flat)
    expect(await r.startFrom({ sceneId: 'hub' })).toEqual({ status: 'entered', sceneId: 'hub' })
    expect(await r.startFrom({ sceneId: 'S1' })).toEqual({ status: 'entered', sceneId: 'S1' })
    expect(r.getCurrentSceneId()).toBe('S1')
  })
})
