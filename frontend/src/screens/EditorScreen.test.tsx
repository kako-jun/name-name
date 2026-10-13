/**
 * EditorScreen: プレビューへのシーン索引の供給 (#734 PR4)。
 * EditorScreen は NovelPlayer に `events`（平坦化）だけでなく `jumpSceneIndex`（シーン索引）も渡す。
 * これが無いと renderer.allScenes が空で、動画書き出しの `startFrom({ sceneId })` が not-found になる。
 * 重い子コンポーネント・API・WASM パーサはモックし、NovelPlayer に渡る props だけを観測する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { EventDocument, EventScene } from '../types'

const sc = (id: string): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events: [{ Narration: { text: [id], voice_path: null, font_family: null } }],
})
const makeDoc = (ids: string[]): EventDocument => ({
  engine: 'name-name',
  chapters: [{ number: 1, title: 'c1', hidden: false, default_bgm: null, scenes: ids.map(sc) }],
})

const playerProps: Array<Record<string, unknown>> = []
let parsed: EventDocument = makeDoc(['hub', 'S1'])
// #778: markdown 文字列 → パース結果（無ければ parsed）。他文書の取得元（下書き/サーバ版）の判別に使う。
const parsedByMarkdown = new Map<string, EventDocument>()
const getContentsMock = vi.hoisted(() => vi.fn())
const listScriptsMock = vi.hoisted(() => vi.fn())

vi.mock('../components/NovelPlayer', () => ({
  default: (props: Record<string, unknown>) => {
    playerProps.push(props)
    return <div data-testid="novel-player" />
  },
}))
vi.mock('../components/CanvasEditor', () => ({ default: () => <div /> }))
vi.mock('../components/MapEditor', () => ({ default: () => <div /> }))
vi.mock('../components/NPCEditor', () => ({ default: () => <div /> }))
vi.mock('../components/RPGPlayer', () => ({ default: () => <div /> }))
vi.mock('../components/VideoExportModal', () => ({ default: () => <div /> }))
vi.mock('../wasm/parser', () => ({
  parseMarkdown: async (md: string) => parsedByMarkdown.get(md) ?? parsed,
  emitMarkdown: async () => '',
}))
vi.mock('../api/client', () => ({
  createApiClient: () => ({
    getContents: (...args: unknown[]) => getContentsMock(...args),
    listScripts: (...args: unknown[]) => listScriptsMock(...args),
    putContents: async () => ({}),
  }),
}))

import EditorScreen from './EditorScreen'

function renderEditor() {
  return render(
    <EditorScreen
      projectName="p"
      apiBaseUrl="http://api"
      isDark={false}
      onBack={() => {}}
      onToggleDark={() => {}}
      onOpenSettings={() => {}}
      onNavigateToAssets={() => {}}
    />
  )
}

describe('EditorScreen: NovelPlayer への jumpSceneIndex (#734)', () => {
  beforeEach(() => {
    playerProps.length = 0
    parsed = makeDoc(['hub', 'S1'])
    parsedByMarkdown.clear()
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async () => ({ content: '# x', sha: 'sha' }))
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [])
  })

  it('プレビューで doc の全シーンを jumpSceneIndex として渡す', async () => {
    renderEditor()
    const play = await screen.findByRole('button', { name: /プレイ|play/i })
    fireEvent.click(play)
    await waitFor(() => expect(playerProps.length).toBeGreaterThan(0))
    const last = playerProps[playerProps.length - 1]
    const index = last.jumpSceneIndex as EventScene[]
    expect(index.map((s) => s.id)).toEqual(['hub', 'S1'])
    expect(Array.isArray(last.events)).toBe(true)
  })
})

describe('EditorScreen: 他文書のシーンへの遅延ロード (#778)', () => {
  type Resolver = (id: string) => Promise<EventScene[] | null>
  const script = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })

  beforeEach(() => {
    playerProps.length = 0
    parsed = makeDoc(['hub', 'S1'])
    parsedByMarkdown.clear()
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async (_p: string, path: string) => ({
      content: path === 'other.md' ? '# server-other' : '# hub',
      sha: 'sha',
    }))
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [script('other.md'), script('script.md')])
    parsedByMarkdown.set('# hub', makeDoc(['hub', 'S1']))
  })

  async function openPreview(): Promise<Resolver> {
    renderEditor()
    // 一覧の取得（タブ構築）を待ってからプレビューを開く
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalled())
    const play = await screen.findByRole('button', { name: /プレイ|play/i })
    fireEvent.click(play)
    await waitFor(() => expect(playerProps.length).toBeGreaterThan(0))
    const last = playerProps[playerProps.length - 1]
    expect(typeof last.onResolveMissingScene).toBe('function')
    return last.onResolveMissingScene as Resolver
  }

  it('onResolveMissingScene を NovelPlayer に渡す', async () => {
    await openPreview()
  })

  it('開いていない文書は develop から取得し、jumpSceneIndex にも反映する', async () => {
    parsedByMarkdown.set('# server-other', makeDoc(['O1']))
    const resolve = await openPreview()
    let scenes: EventScene[] | null = null
    await act(async () => {
      scenes = await resolve('O1')
    })
    expect(scenes!.map((s: EventScene) => s.id)).toEqual(['hub', 'S1', 'O1'])
    expect(getContentsMock).toHaveBeenCalledWith('p', 'other.md', 'develop')
    await waitFor(() => {
      const index = playerProps[playerProps.length - 1].jumpSceneIndex as EventScene[]
      expect(index.map((s) => s.id)).toEqual(['hub', 'S1', 'O1'])
    })
  })

  it('他タブの未保存の下書きはサーバ版より優先される', async () => {
    localStorage.setItem('name-name:editor-draft:p:other.md', '# draft-other')
    parsedByMarkdown.set('# draft-other', makeDoc(['O1-draft']))
    parsedByMarkdown.set('# server-other', makeDoc(['O1-server']))
    const resolve = await openPreview()
    let scenes: EventScene[] | null = null
    await act(async () => {
      scenes = await resolve('O1-draft')
    })
    expect(scenes!.map((s: EventScene) => s.id)).toContain('O1-draft')
    let missing: EventScene[] | null = [] as EventScene[]
    await act(async () => {
      missing = await resolve('O1-server')
    })
    // サーバ版のシーンは索引に入らない（下書きが勝っている）
    expect(missing).toBeNull()
  })

  it('編集中の文書のシーンは取得せずに解決する', async () => {
    const resolve = await openPreview()
    getContentsMock.mockClear()
    let scenes: EventScene[] | null = null
    await act(async () => {
      scenes = await resolve('S1')
    })
    expect(scenes!.map((s: EventScene) => s.id)).toEqual(['hub', 'S1'])
    expect(getContentsMock).not.toHaveBeenCalled()
  })

  it('どの文書にも無いシーンは null（not-found）', async () => {
    const resolve = await openPreview()
    let scenes: EventScene[] | null = [] as EventScene[]
    await act(async () => {
      scenes = await resolve('nowhere')
    })
    expect(scenes).toBeNull()
  })
})
