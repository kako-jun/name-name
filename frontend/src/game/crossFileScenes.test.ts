import { describe, it, expect, vi } from 'vitest'
import type { EventDocument, EventScene } from '../types'
import {
  resolveMissingSceneAcrossDocs,
  buildSceneIndex,
  inferScriptPathsForSceneId,
  withInheritedEventImageTransition,
} from './crossFileScenes'

const sc = (id: string): EventScene => ({ id, title: id, view: 'TopDown', events: [] })
const doc = (...ids: string[]): EventDocument => ({
  engine: 'name-name',
  chapters: [{ number: 1, title: 'c', hidden: false, default_bgm: null, scenes: ids.map(sc) }],
})

describe('buildSceneIndex', () => {
  it('エントリ → 残りの順で連結する', () => {
    const docs = new Map([
      ['b.md', doc('B')],
      ['a.md', doc('A')],
      ['hub.md', doc('H')],
    ])
    const ids = buildSceneIndex('hub.md', ['a.md', 'b.md', 'hub.md'], docs).map((s) => s.id)
    expect(ids).toEqual(['H', 'A', 'B'])
  })
})

describe('resolveMissingSceneAcrossDocs', () => {
  const sortedPaths = ['a.md', 'b.md', 'hub.md']

  it('既に索引にあれば取得しない', async () => {
    const docs = new Map([['hub.md', doc('H')]])
    const loadDoc = vi.fn()
    const r = await resolveMissingSceneAcrossDocs({
      sceneId: 'H',
      entryPath: 'hub.md',
      sortedPaths,
      docs: () => docs,
      loadDoc,
    })
    expect(r?.map((s) => s.id)).toEqual(['H'])
    expect(loadDoc).not.toHaveBeenCalled()
  })

  it('loadDoc が docs へ登録する契約で、取得後の索引から返す。エントリは取得対象から除外する', async () => {
    const docs = new Map([['hub.md', doc('H')]])
    const bodies: Record<string, EventDocument> = { 'a.md': doc('A'), 'b.md': doc('X') }
    const loaded: string[] = []
    const onIndexUpdated = vi.fn()
    const r = await resolveMissingSceneAcrossDocs({
      sceneId: 'X',
      entryPath: 'hub.md',
      sortedPaths,
      docs: () => docs,
      loadDoc: async (p) => {
        loaded.push(p)
        docs.set(p, bodies[p])
        return bodies[p]
      },
      onIndexUpdated,
    })
    expect(r?.map((s) => s.id)).toEqual(['H', 'A', 'X'])
    expect(loaded).toEqual(['a.md', 'b.md'])
    expect(onIndexUpdated).toHaveBeenCalledTimes(2)
  })

  it('sceneId から推定した候補 MD を先に試す', async () => {
    const docs = new Map([['hub.md', doc('H')]])
    const loaded: string[] = []
    await resolveMissingSceneAcrossDocs({
      sceneId: 'b',
      entryPath: 'hub.md',
      sortedPaths,
      docs: () => docs,
      loadDoc: async (p) => {
        loaded.push(p)
        const d = doc(p === 'b.md' ? 'b' : 'z')
        docs.set(p, d)
        return d
      },
    })
    expect(loaded).toEqual(['b.md'])
  })

  it('取得に失敗（null）しても次へ進み、全滅なら null。エントリは試さない', async () => {
    const docs = new Map([['hub.md', doc('H')]])
    const loadDoc = vi.fn(async () => null)
    const r = await resolveMissingSceneAcrossDocs({
      sceneId: 'nope',
      entryPath: 'hub.md',
      sortedPaths,
      docs: () => docs,
      loadDoc,
    })
    expect(r).toBeNull()
    expect(loadDoc).toHaveBeenCalledTimes(2)
  })

  it('isCancelled が true になったら以降の取得をやめて null', async () => {
    const docs = new Map([['hub.md', doc('H')]])
    let cancelled = false
    const loadDoc = vi.fn(async (p: string) => {
      cancelled = true
      const d = doc('Q')
      docs.set(p, d)
      return d
    })
    const r = await resolveMissingSceneAcrossDocs({
      sceneId: 'nope',
      entryPath: 'hub.md',
      sortedPaths,
      docs: () => docs,
      loadDoc,
      isCancelled: () => cancelled,
    })
    expect(r).toBeNull()
    expect(loadDoc).toHaveBeenCalledTimes(1)
  })

  it('docs は毎回 getter から読む（差し替えられても新しい Map に乗る）', async () => {
    let docs = new Map([['hub.md', doc('H')]])
    const r = await resolveMissingSceneAcrossDocs({
      sceneId: 'X',
      entryPath: 'hub.md',
      sortedPaths,
      docs: () => docs,
      loadDoc: async (p) => {
        const d = doc('X')
        docs = new Map([
          ['hub.md', doc('H')],
          [p, d],
        ])
        return d
      },
    })
    expect(r?.map((s) => s.id)).toContain('X')
  })
})

describe('inferScriptPathsForSceneId / withInheritedEventImageTransition', () => {
  it('route 形式の候補を返す（フォルダ名の部分一致は拾わない）', () => {
    expect(
      inferScriptPathsForSceneId('r09-01-x', ['route09/01-x.md', 'subroute09/01-x.md'])
    ).toEqual(['route09/01-x.md'])
  })
  it('Pixelate のときだけ frontmatter に注入し、ローカル宣言は尊重する', () => {
    const md = '---\nengine: name-name\n---\n# x'
    expect(withInheritedEventImageTransition(md, 'Pixelate')).toContain(
      'event_image_transition: "pixelate"'
    )
    expect(withInheritedEventImageTransition(md, 'Fade')).toBe(md)
    const own = '---\nevent_image_transition: "fade"\n---\n'
    expect(withInheritedEventImageTransition(own, 'Pixelate')).toBe(own)
  })
})
