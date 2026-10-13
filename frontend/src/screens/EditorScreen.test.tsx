/**
 * EditorScreen: プレビューへのシーン索引の供給 (#734 PR4)。
 * EditorScreen は NovelPlayer に `events`（平坦化）だけでなく `jumpSceneIndex`（シーン索引）も渡す。
 * これが無いと renderer.allScenes が空で、動画書き出しの `startFrom({ sceneId })` が not-found になる。
 * 重い子コンポーネント・API・WASM パーサはモックし、NovelPlayer に渡る props だけを観測する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
  parseMarkdown: async () => parsed,
  emitMarkdown: async () => '',
}))
vi.mock('../api/client', () => ({
  createApiClient: () => ({
    getContents: async () => ({ content: '# x', sha: 'sha' }),
    listScripts: async () => [],
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
    localStorage.clear()
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
