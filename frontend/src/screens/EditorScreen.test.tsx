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
const parsedInputs: string[] = []
const getContentsMock = vi.hoisted(() => vi.fn())
const listScriptsMock = vi.hoisted(() => vi.fn())

vi.mock('../components/NovelPlayer', () => ({
  default: (props: Record<string, unknown>) => {
    playerProps.push(props)
    return <div data-testid="novel-player" />
  },
}))
// #778: onDocChange を外から叩けるようにする（編集のシミュレーション）
let editedDoc: EventDocument = makeDoc(['hub', 'S1'])
let emitted = ''
vi.mock('../components/CanvasEditor', () => ({
  default: (props: { onDocChange: (d: EventDocument) => void }) => (
    <button data-testid="edit-doc" onClick={() => props.onDocChange(editedDoc)} />
  ),
}))
vi.mock('../components/MapEditor', () => ({ default: () => <div /> }))
vi.mock('../components/NPCEditor', () => ({ default: () => <div /> }))
vi.mock('../components/RPGPlayer', () => ({ default: () => <div /> }))
vi.mock('../components/VideoExportModal', () => ({ default: () => <div /> }))
vi.mock('../wasm/parser', () => ({
  parseMarkdown: async (md: string) => {
    parsedInputs.push(md)
    return parsedByMarkdown.get(md) ?? parsed
  },
  emitMarkdown: async () => emitted,
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
    editedDoc = makeDoc(['hub', 'S1'])
    emitted = ''
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
    // 編集中の文書(script.md)は取りに行かない（#238 の他文書の先行取得が遅れて走るため、対象パスで絞る）
    expect(getContentsMock).not.toHaveBeenCalledWith('p', 'script.md', 'develop')
  })

  it('どの文書にも無いシーンは null（not-found）', async () => {
    const resolve = await openPreview()
    let scenes: EventScene[] | null = [] as EventScene[]
    await act(async () => {
      scenes = await resolve('nowhere')
    })
    expect(scenes).toBeNull()
  })

  it('ライブ再パース（編集）後も取得済みの他文書の索引が残る', async () => {
    parsedByMarkdown.set('# server-other', makeDoc(['O1']))
    const resolve = await openPreview()
    await act(async () => {
      await resolve('O1')
    })
    // 編集モードへ戻って doc を編集 → 再びプレビュー
    fireEvent.click(screen.getByRole('button', { name: /Edit Mode/i }))
    editedDoc = makeDoc(['hub', 'S1', 'S2'])
    emitted = '# edited'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(screen.getByRole('button', { name: /Play Mode/i }))
    await waitFor(() => {
      const index = playerProps[playerProps.length - 1].jumpSceneIndex as EventScene[]
      expect(index.map((x) => x.id)).toEqual(['hub', 'S1', 'S2', 'O1'])
    })
  })

  it('タブ切替をまたいだ古い取得結果は索引に入らず、解決は null になる', async () => {
    let release: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'third.md') {
        return new Promise((r) => {
          release = r
        })
      }
      return { content: path === 'other.md' ? '# server-other' : '# hub', sha: 'sha' }
    })
    listScriptsMock.mockImplementation(async () => [
      script('other.md'),
      script('script.md'),
      script('third.md'),
    ])
    parsedByMarkdown.set('# server-other', makeDoc(['O1']))
    parsedByMarkdown.set('# third', makeDoc(['T1']))
    renderEditor()
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /Play Mode/i }))
    await waitFor(() => expect(playerProps.length).toBeGreaterThan(0))
    const resolve = playerProps[playerProps.length - 1].onResolveMissingScene as Resolver
    let result: EventScene[] | null = [] as EventScene[]
    const pending = (async () => {
      result = await resolve('T1')
    })()
    // third.md の取得が止まっている間に other.md のタブへ切り替える
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    await act(async () => {
      release({ content: '# third', sha: 'sha' })
      await pending
    })
    expect(result).toBeNull()
    const index = playerProps[playerProps.length - 1].jumpSceneIndex as EventScene[]
    expect(index.map((x) => x.id)).not.toContain('T1')
  })

  it('タブ切替の直前 1 秒以内の編集も下書きとして localStorage に残る', async () => {
    renderEditor()
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalled())
    editedDoc = makeDoc(['hub', 'S1', 'S9'])
    emitted = '# edited-hub'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // デバウンス（1 秒）の満了を待たずに別タブへ切り替える
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    await waitFor(() =>
      expect(localStorage.getItem('name-name:editor-draft:p:script.md')).toBe('# edited-hub')
    )
  })
})

describe('EditorScreen: 遅延ロードの探索対象と継承 (#778)', () => {
  const script = (path: string, hidden = false) => ({
    path,
    sha: 's',
    size: 1,
    title: null,
    hidden,
  })
  beforeEach(() => {
    playerProps.length = 0
    parsedInputs.length = 0
    parsedByMarkdown.clear()
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async (_p: string, path: string) => ({
      content:
        path === 'script.md'
          ? '---\nengine: name-name\n---\n# hub'
          : `---\nengine: name-name\n---\n# ${path}`,
      sha: 'sha',
    }))
  })
  async function openResolver() {
    renderEditor()
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /Play Mode/i }))
    await waitFor(() => expect(playerProps.length).toBeGreaterThan(0))
    return playerProps[playerProps.length - 1].onResolveMissingScene as (
      id: string
    ) => Promise<EventScene[] | null>
  }

  it('hidden の .md は探索対象にしない', async () => {
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [script('data.md', true), script('script.md')])
    parsedByMarkdown.set('---\nengine: name-name\n---\n# data.md', makeDoc(['D1']))
    parsed = makeDoc(['hub'])
    const resolve = await openResolver()
    let r: EventScene[] | null = [] as EventScene[]
    await act(async () => {
      r = await resolve('D1')
    })
    expect(r).toBeNull()
  })

  it('script.md 以外の他文書は script.md の event_image_transition を継承してパースする', async () => {
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [script('other.md'), script('script.md')])
    parsed = { ...makeDoc(['hub']), event_image_transition: 'Pixelate' }
    const resolve = await openResolver()
    await act(async () => {
      await resolve('nowhere')
    })
    expect(
      parsedInputs.some(
        (m) => m.includes('# other.md') && m.includes('event_image_transition: "pixelate"')
      )
    ).toBe(true)
  })
})

describe('EditorScreen: 既定パスの先行ロード失敗トースト (#778 調査)', () => {
  it('script.md が無いプロジェクトでも、一覧から切り替えた先のロードに成功すれば読み込みエラーを残さない', async () => {
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'script.md') throw new Error('404')
      return { content: '# real', sha: 'sha' }
    })
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [
      { path: 'content/scripts/a.md', sha: 's', size: 1, title: null, hidden: false },
    ])
    renderEditor()
    await waitFor(() =>
      expect(getContentsMock).toHaveBeenCalledWith('p', 'content/scripts/a.md', 'develop')
    )
    // 成功ロードの完了（シーンの索引が出る = doc 確定）まで待ってから確認する
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByText(/読み込みに失敗/)).toBeNull()
  })
})
