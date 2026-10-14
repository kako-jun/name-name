/**
 * EditorScreen: プレビューへのシーン索引の供給 (#734 PR4)。
 * EditorScreen は NovelPlayer に `events`（平坦化）だけでなく `jumpSceneIndex`（シーン索引）も渡す。
 * これが無いと renderer.allScenes が空で、動画書き出しの `startFrom({ sceneId })` が not-found になる。
 * 重い子コンポーネント・API・WASM パーサはモックし、NovelPlayer に渡る props だけを観測する。
 */
import { StrictMode, useEffect } from 'react'
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
// markdown に部分文字列を含むものを特定の doc にパースする（継承注入で本文が変わる場合用）
const parsedContains: Array<[string, EventDocument]> = []
let serverHasRootScript = true
const getContentsMock = vi.hoisted(() => vi.fn())
const listScriptsMock = vi.hoisted(() => vi.fn())
const putContentsMock = vi.hoisted(() => vi.fn())
const listProjectsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]))

vi.mock('../components/NovelPlayer', () => ({
  default: (props: Record<string, unknown>) => {
    playerProps.push(props)
    // 動画書き出しは renderer を要る (#780)。最小のフェークを渡す。
    const ready = props.onRendererReady as ((r: unknown) => void) | undefined
    useEffect(() => {
      ready?.({ getSnapshot: () => ({ flags: {} }) })
    }, [ready])
    return <div data-testid="novel-player" />
  },
}))
// #778: onDocChange を外から叩けるようにする（編集のシミュレーション）
let editedDoc: EventDocument = makeDoc(['hub', 'S1'])
let emitted = ''
// emitMarkdown を遅延させたいとき用（null なら即時）
let emitGate: Promise<void> | null = null
// true の間、emitMarkdown が失敗する
let emitFail = false
vi.mock('../components/CanvasEditor', () => ({
  default: (props: { onDocChange: (d: EventDocument) => void }) => (
    <button data-testid="edit-doc" onClick={() => props.onDocChange(editedDoc)} />
  ),
}))
vi.mock('../components/MapEditor', () => ({ default: () => <div /> }))
vi.mock('../components/NPCEditor', () => ({ default: () => <div /> }))
vi.mock('../components/RPGPlayer', () => ({ default: () => <div /> }))
vi.mock('../components/VideoExportModal', () => ({
  default: (props: {
    isRunning: boolean
    status: string | null
    onStart: () => void
    onAbort: () => void
  }) => (
    <div data-testid="video-export-modal">
      <span data-testid="export-running">{String(props.isRunning)}</span>
      <span data-testid="export-status">{props.status}</span>
      <button onClick={props.onStart}>テスト録画開始</button>
      <button onClick={props.onAbort}>テスト中止</button>
    </div>
  ),
}))
// 実録画はしない (#780)。exportVideo をテストが握る
const exportVideoMock = vi.hoisted(() => vi.fn())
vi.mock('../game/VideoExporter', async (importActual) => ({
  ...(await importActual<typeof import('../game/VideoExporter')>()),
  pickSupportedMimeType: () => 'video/webm',
  exportVideo: (...args: unknown[]) => exportVideoMock(...args),
  downloadBlob: vi.fn(),
}))
vi.mock('../wasm/parser', () => ({
  parseMarkdown: async (md: string) => {
    parsedInputs.push(md)
    for (const [sub, d] of parsedContains) if (md.includes(sub)) return d
    return parsedByMarkdown.get(md) ?? parsed
  },
  emitMarkdown: async () => {
    if (emitGate) await emitGate
    if (emitFail) throw new Error('emit failed')
    return emitted
  },
}))
vi.mock('../api/client', () => ({
  createApiClient: () => ({
    getContents: (...args: unknown[]) => getContentsMock(...args),
    listScripts: (...args: unknown[]) => listScriptsMock(...args),
    listProjects: () => listProjectsMock(),
    putContents: (...args: unknown[]) => putContentsMock(...args),
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
    parsedByMarkdown.set('# server-other', makeDoc(['O1']))
    const resolve = await openPreview()
    getContentsMock.mockClear()
    let scenes: EventScene[] | null = null
    await act(async () => {
      scenes = await resolve('S1')
    })
    // 先頭は編集中の文書。他文書は（先行取得済みなら）後ろに続く
    expect(scenes!.map((s: EventScene) => s.id).slice(0, 2)).toEqual(['hub', 'S1'])
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
    parsedContains.length = 0
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

  it('script.md の event_image_transition を編集で変えたら、継承して解析済みの他文書を捨てて取り直す', async () => {
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [script('other.md'), script('script.md')])
    parsed = { ...makeDoc(['hub']), event_image_transition: 'Pixelate' }
    parsedContains.push(['# other.md', makeDoc(['O1'])])
    const resolve = await openResolver()
    await act(async () => {
      await resolve('O1')
    })
    expect(parsedInputs.some((m) => m.includes('# other.md') && m.includes('pixelate'))).toBe(true)
    // script.md を Fade に編集 → 他文書のキャッシュが捨てられ、継承なしで取り直される
    fireEvent.click(screen.getByRole('button', { name: /Edit Mode/i }))
    editedDoc = { ...makeDoc(['hub']), event_image_transition: 'Fade' }
    emitted = '# e'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(screen.getByRole('button', { name: /Play Mode/i }))
    await waitFor(() => expect(playerProps.length).toBeGreaterThan(0))
    const resolve2 = playerProps[playerProps.length - 1].onResolveMissingScene as (
      id: string
    ) => Promise<EventScene[] | null>
    parsedInputs.length = 0
    await act(async () => {
      await resolve2('O1')
    })
    const reparsed = parsedInputs.filter((m) => m.includes('# other.md'))
    expect(reparsed.length).toBeGreaterThan(0)
    expect(reparsed.every((m) => !m.includes('pixelate'))).toBe(true)
  })

  it('継承元の script.md を開き直している間は、他文書を継承なしで解析・共有しない', async () => {
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [script('other.md'), script('script.md')])
    parsed = { ...makeDoc(['hub']), event_image_transition: 'Pixelate' }
    renderEditor()
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalled())
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^other\.md/ }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
    // script.md へ戻す。その取得を止めて「切替直後・doc 未確定」の状態を作る
    let release: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'script.md') {
        return new Promise((r) => {
          release = r
        })
      }
      return { content: `---\nengine: name-name\n---\n# ${path}`, sha: 'sha' }
    })
    await new Promise((r) => setTimeout(r, 50))
    parsedInputs.length = 0
    fireEvent.click(screen.getByRole('tab', { name: /^script\.md/ }))
    await new Promise((r) => setTimeout(r, 100))
    // 未確定の間は other.md を（継承なしで）解析しない
    expect(parsedInputs.filter((m) => m.includes('# other.md'))).toEqual([])
    await act(async () => {
      release({ content: '---\nengine: name-name\n---\n# hub', sha: 'sha' })
      await new Promise((r) => setTimeout(r, 100))
    })
    const after = parsedInputs.filter((m) => m.includes('# other.md'))
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((m) => m.includes('pixelate'))).toBe(true)
  })

  it('継承値の変更で破棄された進行中のジャンプ解決は、新しい状態で1回やり直して成功する', async () => {
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [script('other.md'), script('script.md')])
    parsed = { ...makeDoc(['hub']), event_image_transition: 'Pixelate' }
    parsedContains.push(['# other.md', makeDoc(['O1'])])
    let release: (v: { content: string; sha: string }) => void = () => {}
    let first = true
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'other.md' && first) {
        first = false
        return new Promise((r) => {
          release = r
        })
      }
      return { content: `---\nengine: name-name\n---\n# ${path}`, sha: 'sha' }
    })
    const resolve = await openResolver()
    let result: EventScene[] | null = null
    const pending = (async () => {
      result = await resolve('O1')
    })()
    // 取得待ちの間に script.md の継承値を編集で変える（他文書キャッシュの破棄）
    fireEvent.click(screen.getByRole('button', { name: /Edit Mode/i }))
    editedDoc = { ...makeDoc(['hub']), event_image_transition: 'Fade' }
    emitted = '# e'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    await act(async () => {
      release({ content: '---\nengine: name-name\n---\n# other.md', sha: 'sha' })
      await pending
    })
    expect(result).not.toBeNull()
    expect((result as unknown as EventScene[]).map((x) => x.id)).toContain('O1')
  })
})

describe('EditorScreen: 最初に開く文書の決め方 (#778 調査)', () => {
  const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
  beforeEach(() => {
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'script.md' && !serverHasRootScript) throw new Error('404')
      return { content: '# real', sha: 'sha' }
    })
    listScriptsMock.mockReset()
    serverHasRootScript = true
  })

  it('script.md が無いプロジェクトでは 404 を出さず、一覧の先頭を開く（トーストも出ない）', async () => {
    serverHasRootScript = false
    listScriptsMock.mockImplementation(async () => [info('content/scripts/a.md')])
    renderEditor()
    await waitFor(() =>
      expect(getContentsMock).toHaveBeenCalledWith('p', 'content/scripts/a.md', 'develop')
    )
    await new Promise((r) => setTimeout(r, 100))
    // 先行取得した script.md の 404 は捨てられ、トーストは出ない
    expect(screen.queryByText(/読み込みに失敗/)).toBeNull()
  })

  it('一覧に直下 script.md が無くても basename が script.md のものを優先して開く', async () => {
    serverHasRootScript = false
    listScriptsMock.mockImplementation(async () => [
      info('content/scripts/a.md'),
      info('content/scripts/script.md'),
    ])
    renderEditor()
    await waitFor(() =>
      expect(getContentsMock).toHaveBeenCalledWith('p', 'content/scripts/script.md', 'develop')
    )
    // 編集対象は basename 一致の script.md（タブの選択状態で見る）
    await waitFor(() =>
      expect(
        screen
          .getByRole('tab', { name: /^content\/scripts\/script\.md/ })
          .getAttribute('aria-selected')
      ).toBe('true')
    )
  })

  it('script.md があればそれを開く', async () => {
    listScriptsMock.mockImplementation(async () => [info('a.md'), info('script.md')])
    renderEditor()
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^script\.md/ }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
    // 先行取得の結果を採用する（script.md を二重に取りに行かない）
    const scriptCalls = getContentsMock.mock.calls.filter((c) => c[1] === 'script.md')
    expect(scriptCalls.length).toBe(1)
  })

  it('既定の script.md は listScripts の完了を待たず並列で先行して取りに行く', async () => {
    let finishList: (v: unknown[]) => void = () => {}
    listScriptsMock.mockImplementation(
      () =>
        new Promise((r) => {
          finishList = r
        })
    )
    renderEditor()
    // 一覧がまだ返っていない時点で、script.md の取得が始まっている
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('p', 'script.md', 'develop'))
    await act(async () => {
      finishList([info('a.md'), info('script.md')])
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(getContentsMock.mock.calls.filter((c) => c[1] === 'script.md').length).toBe(1)
  })

  it('listScripts が失敗したら従来どおり script.md を試す', async () => {
    listScriptsMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    renderEditor()
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('p', 'script.md', 'develop'))
  })

  it('個別タブのロード失敗後に別タブへ切り替えて成功したら、読み込みエラーを消す', async () => {
    listScriptsMock.mockImplementation(async () => [info('bad.md'), info('script.md')])
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'bad.md') throw new Error('404')
      return { content: '# real', sha: 'sha' }
    })
    renderEditor()
    fireEvent.click(await screen.findByRole('tab', { name: /^bad\.md/ }))
    expect(await screen.findByText(/読み込みに失敗/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^script\.md/ }))
    await waitFor(() => expect(screen.queryByText(/読み込みに失敗/)).toBeNull())
  })
})

describe('EditorScreen: 起動時の先行取得とプロジェクト切替 (#778)', () => {
  const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
  beforeEach(() => {
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async () => ({ content: '# real', sha: 'sha' }))
    listScriptsMock.mockReset()
    listProjectsMock.mockReset()
    listProjectsMock.mockImplementation(async () => [])
  })

  it('scriptsDir を持つプロジェクトは、ルートの script.md ではなく scriptsDir/script.md を先行取得する', async () => {
    listProjectsMock.mockImplementation(async () => [
      { name: 'p', title: 'p', repo: 'o/p', scriptsDir: 'content/scripts/' },
    ])
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'script.md') throw new Error('404')
      return { content: '# real', sha: 'sha' }
    })
    listScriptsMock.mockImplementation(async () => [
      info('content/scripts/a.md'),
      info('content/scripts/script.md'),
    ])
    renderEditor()
    await waitFor(() =>
      expect(getContentsMock).toHaveBeenCalledWith('p', 'content/scripts/script.md', 'develop')
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(getContentsMock).not.toHaveBeenCalledWith('p', 'script.md', 'develop')
    // 先行取得を採用するので、同じファイルを二重に取らない
    expect(
      getContentsMock.mock.calls.filter((c) => c[1] === 'content/scripts/script.md').length
    ).toBe(1)
    expect(screen.queryByText(/読み込みに失敗/)).toBeNull()
  })

  it('listScripts も失敗し先行取得も 404 のときは、同じ取得を2回せずトーストは1回', async () => {
    getContentsMock.mockImplementation(async () => {
      throw new Error('404')
    })
    listScriptsMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    renderEditor()
    expect(await screen.findByText(/読み込みに失敗/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 100))
    expect(getContentsMock.mock.calls.filter((c) => c[1] === 'script.md').length).toBe(1)
    expect(screen.getAllByText(/読み込みに失敗/).length).toBe(1)
  })

  it('projectName が変わったら一覧を取り直し、新しいプロジェクトの文書を開く', async () => {
    listScriptsMock.mockImplementation(async (name: string) => [
      info(name === 'q' ? 'q-main.md' : 'script.md'),
    ])
    const view = renderEditor()
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('p', 'script.md', 'develop'))
    view.rerender(
      <EditorScreen
        projectName="q"
        apiBaseUrl="http://api"
        isDark={false}
        onBack={() => {}}
        onToggleDark={() => {}}
        onOpenSettings={() => {}}
        onNavigateToAssets={() => {}}
      />
    )
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalledWith('q', 'develop'))
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('q', 'q-main.md', 'develop'))
  })
})

describe('EditorScreen: 古いロードの中断 (#794)', () => {
  const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
  const draftOther = 'name-name:editor-draft:p:other.md'
  beforeEach(() => {
    localStorage.clear()
    getContentsMock.mockReset()
    listScriptsMock.mockReset()
    listProjectsMock.mockReset()
    listProjectsMock.mockImplementation(async () => [])
    parsedByMarkdown.clear()
    parsedContains.length = 0
    parsed = makeDoc(['hub', 'S1'])
  })

  it('先行取得の待ち中にタブを切り替え、古い取得が後で完了しても、切替先の下書きと表示が保たれる', async () => {
    // script.md の取得は（先行取得・他文書としての取得を含め）全部止めておき、まとめて解放する
    const releases: Array<(v: { content: string; sha: string }) => void> = []
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'script.md') {
        return new Promise((r) => {
          releases.push(r)
        })
      }
      return { content: '# B-server', sha: 'sha' }
    })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    localStorage.setItem(draftOther, '# B-draft')
    renderEditor()
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('p', 'other.md', 'develop'))
    await new Promise((r) => setTimeout(r, 100))
    await act(async () => {
      for (const r of releases) r({ content: '# A-body', sha: 'shaA' })
    })
    await new Promise((r) => setTimeout(r, 1300))
    // 古い A のロードが B の下書きを消したり上書きしたりしない
    expect(localStorage.getItem(draftOther)).toBe('# B-draft')
    // B は下書き復元で未保存扱いのまま（A の基準で「保存済み」に戻されない）
    expect(screen.getByRole('button', { name: 'Gitにコミット・プッシュ' })).toBeTruthy()
  })

  it('旧プロジェクトの進行中のロードが、新プロジェクトの文書を上書きしない', async () => {
    let release: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (name: string, path: string) => {
      if (name === 'p' && path === 'script.md') {
        return new Promise((r) => {
          release = r
        })
      }
      return { content: '# Q-server', sha: 'sha' }
    })
    listScriptsMock.mockImplementation(async () => [info('script.md')])
    localStorage.setItem('name-name:editor-draft:q:script.md', '# Q-draft')
    const view = renderEditor()
    await waitFor(() => expect(listScriptsMock).toHaveBeenCalledWith('p', 'develop'))
    view.rerender(
      <EditorScreen
        projectName="q"
        apiBaseUrl="http://api"
        isDark={false}
        onBack={() => {}}
        onToggleDark={() => {}}
        onOpenSettings={() => {}}
        onNavigateToAssets={() => {}}
      />
    )
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('q', 'script.md', 'develop'))
    await new Promise((r) => setTimeout(r, 100))
    await act(async () => {
      release({ content: '# P-body', sha: 'shaP' })
    })
    await new Promise((r) => setTimeout(r, 1300))
    expect(localStorage.getItem('name-name:editor-draft:q:script.md')).toBe('# Q-draft')
    expect(screen.getByRole('button', { name: 'Gitにコミット・プッシュ' })).toBeTruthy()
  })

  it('StrictMode（dev の二重実行）でも、起動時に既定の script.md を二重に取得しない', async () => {
    getContentsMock.mockImplementation(async () => ({ content: '# real', sha: 'sha' }))
    listScriptsMock.mockImplementation(async () => [info('script.md')])
    render(
      <StrictMode>
        <EditorScreen
          projectName="p"
          apiBaseUrl="http://api"
          isDark={false}
          onBack={() => {}}
          onToggleDark={() => {}}
          onOpenSettings={() => {}}
          onNavigateToAssets={() => {}}
        />
      </StrictMode>
    )
    await waitFor(() => expect(getContentsMock).toHaveBeenCalledWith('p', 'script.md', 'develop'))
    await new Promise((r) => setTimeout(r, 150))
    expect(getContentsMock.mock.calls.filter((c) => c[1] === 'script.md').length).toBe(1)
  })
})

describe('EditorScreen: 下書きの保存・破棄との整合 (#778)', () => {
  beforeEach(() => {
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async () => ({ content: '# hub', sha: 'sha' }))
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [])
    putContentsMock.mockReset()
    parsedByMarkdown.clear()
    parsedContains.length = 0
    parsed = makeDoc(['hub', 'S1'])
    editedDoc = makeDoc(['hub', 'S1', 'S2'])
    emitGate = null
    emitFail = false
  })
  const draftKey = 'name-name:editor-draft:p:script.md'

  it('保存中に追記された内容は、保存完了で下書きを消さず未保存のまま退避される', async () => {
    let finishPut: (v: { sha: string }) => void = () => {}
    putContentsMock.mockImplementation(
      () =>
        new Promise((r) => {
          finishPut = r
        })
    )
    renderEditor()
    emitted = '# v1'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(await screen.findByRole('button', { name: 'Gitにコミット・プッシュ' }))
    await waitFor(() => expect(putContentsMock).toHaveBeenCalled())
    // 保存の await 中にさらに編集
    emitted = '# v2'
    fireEvent.click(screen.getByTestId('edit-doc'))
    await act(async () => {
      finishPut({ sha: 'sha2' })
    })
    await waitFor(() => expect(localStorage.getItem(draftKey)).toBe('# v2'), { timeout: 3000 })
  })

  it('破棄の後に、保留中だった下書きが復活しない', async () => {
    renderEditor()
    emitted = '# edited'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(await screen.findByRole('button', { name: '変更を破棄' }))
    fireEvent.click(await screen.findByRole('button', { name: '破棄' }))
    await new Promise((r) => setTimeout(r, 1300))
    expect(localStorage.getItem(draftKey)).toBeNull()
  })

  it('保存中はタブを押しても切り替わらず、保存完了後は切り替えられる', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    getContentsMock.mockImplementation(async (_p: string, path: string) => ({
      content: path === 'other.md' ? '# B-body' : '# hub',
      sha: 'sha',
    }))
    let finishPut: (v: { sha: string }) => void = () => {}
    putContentsMock.mockImplementation(
      () =>
        new Promise((r) => {
          finishPut = r
        })
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderEditor()
    await screen.findByRole('tab', { name: /^other\.md/ })
    emitted = '# A-edit'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(await screen.findByRole('button', { name: 'Gitにコミット・プッシュ' }))
    await waitFor(() => expect(putContentsMock).toHaveBeenCalled())
    const other = screen.getByRole('tab', { name: /^other\.md/ }) as HTMLButtonElement
    expect(other.disabled).toBe(true)
    fireEvent.click(other)
    expect(screen.getByRole('tab', { name: /^script\.md/ }).getAttribute('aria-selected')).toBe(
      'true'
    )
    await act(async () => {
      finishPut({ sha: 'sha-after' })
    })
    await waitFor(() =>
      expect((screen.getByRole('tab', { name: /^other\.md/ }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('tab', { name: /^other\.md/ }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^other\.md/ }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
  })

  it('保存後の次の保存は、前回の保存で返った新しい sha で送られる', async () => {
    getContentsMock.mockImplementation(async () => ({ content: '# hub', sha: 'sha-0' }))
    putContentsMock.mockImplementation(async () => ({ sha: 'sha-1' }))
    renderEditor()
    emitted = '# v1'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(await screen.findByRole('button', { name: 'Gitにコミット・プッシュ' }))
    await waitFor(() => expect(putContentsMock).toHaveBeenCalledTimes(1))
    expect(putContentsMock.mock.calls[0][2].sha).toBe('sha-0')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存済み' })).toBeTruthy())
    putContentsMock.mockImplementation(async () => ({ sha: 'sha-2' }))
    emitted = '# v2'
    fireEvent.click(screen.getByTestId('edit-doc'))
    fireEvent.click(await screen.findByRole('button', { name: 'Gitにコミット・プッシュ' }))
    await waitFor(() => expect(putContentsMock).toHaveBeenCalledTimes(2))
    expect(putContentsMock.mock.calls[1][2].sha).toBe('sha-1')
  })

  it('parse 中にタブが切り替わっても、旧文書の本文が切替先の下書きキーに積まれない', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    getContentsMock.mockImplementation(async (_p: string, path: string) => ({
      content: path === 'other.md' ? '# B-server' : '# A-body',
      sha: 'sha',
    }))
    localStorage.setItem('name-name:editor-draft:p:other.md', '# B-draft')
    renderEditor()
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    await new Promise((r) => setTimeout(r, 1300))
    expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBe('# B-draft')
    expect(localStorage.getItem('name-name:editor-draft:p:script.md')).toBeNull()
  })

  it('切替先のロード中に旧文書を編集しても、切替先キーの下書きに旧文書の内容が入らない (#795)', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    let releaseB: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'other.md') {
        return new Promise((r) => {
          releaseB = r
        })
      }
      return { content: '# A-body', sha: 'sha' }
    })
    localStorage.setItem('name-name:editor-draft:p:other.md', '# B-draft')
    renderEditor()
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    // 切替先(other.md)のロードが終わる前に、まだ表示されている旧文書(script.md)を編集する
    editedDoc = makeDoc(['hub', 'S1', 'EDITED'])
    emitted = '# A-edited'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    // 下書きのデバウンス(1秒)を超えるまで切替先のロードを遅らせる
    await new Promise((r) => setTimeout(r, 1300))
    expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBe('# B-draft')
    await act(async () => {
      releaseB({ content: '# B-server', sha: 'shaB' })
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBe('# B-draft')
  })

  it('切替先のロード中は編集 UI が読み取り専用（inert + 表示）で、編集は受け付けず、完了後は編集できる (#795)', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    let releaseB: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'other.md') {
        return new Promise((r) => {
          releaseB = r
        })
      }
      return { content: '# A-body', sha: 'sha' }
    })
    renderEditor()
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    const overlay = await screen.findByTestId('doc-switching-overlay')
    expect(overlay.textContent).toContain('読み込み中')
    expect(document.querySelector('main')?.hasAttribute('inert')).toBe(true)
    // ロード中の編集は受け付けない（emit も走らず、保存対象にならない）
    editedDoc = makeDoc(['hub', 'EDITED'])
    emitted = '# A-edited'
    fireEvent.click(screen.getByTestId('edit-doc'))
    await new Promise((r) => setTimeout(r, 1300))
    expect(localStorage.getItem('name-name:editor-draft:p:script.md')).toBeNull()
    expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBeNull()
    // ロード完了後は編集できる
    await act(async () => {
      releaseB({ content: '# B-server', sha: 'shaB' })
    })
    await waitFor(() => expect(screen.queryByTestId('doc-switching-overlay')).toBeNull())
    expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false)
    emitted = '# B-edited'
    fireEvent.click(screen.getByTestId('edit-doc'))
    await waitFor(
      () => expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBe('# B-edited'),
      { timeout: 3000 }
    )
  })

  it('保存中は破棄確認モーダルの破棄ボタンが無効', async () => {
    getContentsMock.mockImplementation(async () => ({ content: '# hub', sha: 'sha' }))
    putContentsMock.mockImplementation(() => new Promise(() => {}))
    renderEditor()
    emitted = '# v1'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    // 破棄確認モーダルを開いたまま保存を始める
    fireEvent.click(await screen.findByRole('button', { name: '変更を破棄' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Gitにコミット・プッシュ' }))
    await waitFor(() => expect(putContentsMock).toHaveBeenCalled())
    const discard = (await screen.findByRole('button', { name: '破棄' })) as HTMLButtonElement
    expect(discard.disabled).toBe(true)
  })

  it('切替先のロード中は破棄できず、切替先の未保存の下書きが残る (#795)', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    let releaseB: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'other.md') {
        return new Promise((r) => {
          releaseB = r
        })
      }
      return { content: '# A-body', sha: 'sha' }
    })
    localStorage.setItem('name-name:editor-draft:p:other.md', '# B-draft')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderEditor()
    emitted = '# A-edit'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(await screen.findByRole('tab', { name: /^other\.md/ }))
    await screen.findByTestId('doc-switching-overlay')
    // 切替先のロード中は破棄ボタン（と保存ボタン）が無効で、title は「読み込み中…」
    const disabledButtons = screen.getAllByTitle('読み込み中…') as HTMLButtonElement[]
    expect(disabledButtons.length).toBe(2)
    for (const b of disabledButtons) {
      expect(b.disabled).toBe(true)
      fireEvent.click(b)
    }
    expect(screen.queryByText('変更を破棄しますか？')).toBeNull()
    await act(async () => {
      releaseB({ content: '# B-server', sha: 'shaB' })
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBe('# B-draft')
  })

  it('emit の await 中にタブが切り替わり、切替先が先に確定しても、旧文書の最後の編集が積み残されない', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    let releaseB: (v: { content: string; sha: string }) => void = () => {}
    getContentsMock.mockImplementation(async (_p: string, path: string) => {
      if (path === 'other.md') {
        return new Promise((r) => {
          releaseB = r
        })
      }
      return { content: '# A-body', sha: 'sha' }
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderEditor()
    await screen.findByRole('tab', { name: /^other\.md/ })
    // 旧文書の編集を始めるが、emit はまだ返らない
    let releaseEmit: () => void = () => {}
    emitGate = new Promise<void>((r) => {
      releaseEmit = r
    })
    emitted = '# A-last-edit'
    fireEvent.click(await screen.findByTestId('edit-doc'))
    // その間にタブを切り替え、emit が返った後で切替先のロードが完了する（1 秒以内）
    fireEvent.click(screen.getByRole('tab', { name: /^other\.md/ }))
    await act(async () => {
      releaseEmit()
    })
    await act(async () => {
      releaseB({ content: '# B-server', sha: 'shaB' })
    })
    await new Promise((r) => setTimeout(r, 1300))
    expect(localStorage.getItem('name-name:editor-draft:p:script.md')).toBe('# A-last-edit')
    expect(localStorage.getItem('name-name:editor-draft:p:other.md')).toBeNull()
  })

  it('動画書き出しのモーダルを開いている間はタブ切替が無効', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    getContentsMock.mockImplementation(async () => ({ content: '# hub', sha: 'sha' }))
    renderEditor()
    await screen.findByRole('tab', { name: /^other\.md/ })
    fireEvent.click(await screen.findByRole('button', { name: /Play Mode/i }))
    fireEvent.click(await screen.findByRole('button', { name: '動画エクスポート' }))
    const other = screen.getByRole('tab', { name: /^other\.md/ }) as HTMLButtonElement
    expect(other.disabled).toBe(true)
    fireEvent.click(other)
    expect(screen.getByRole('tab', { name: /^script\.md/ }).getAttribute('aria-selected')).toBe(
      'true'
    )
  })

  it('書き出しモーダルを開いたままモードを切り替えると閉じ、タブが押せる。play に戻ってもモーダルは閉じている', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    getContentsMock.mockImplementation(async () => ({ content: '# hub', sha: 'sha' }))
    renderEditor()
    await screen.findByRole('tab', { name: /^other\.md/ })
    fireEvent.click(await screen.findByRole('button', { name: /Play Mode/i }))
    fireEvent.click(await screen.findByRole('button', { name: '動画エクスポート' }))
    expect(screen.getByTestId('video-export-modal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Edit Mode/i }))
    await waitFor(() =>
      expect((screen.getByRole('tab', { name: /^other\.md/ }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: /Play Mode/i }))
    await screen.findByRole('button', { name: '動画エクスポート' })
    expect(screen.queryByTestId('video-export-modal')).toBeNull()
  })

  it('切替後に emit が失敗しても、切替先の表示を旧文書に戻さない', async () => {
    const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
    listScriptsMock.mockImplementation(async () => [info('other.md'), info('script.md')])
    getContentsMock.mockImplementation(async (_p: string, path: string) => ({
      content: path === 'other.md' ? '# B-server' : '# A-body',
      sha: 'sha',
    }))
    parsedByMarkdown.set('# B-server', makeDoc(['B1']))
    parsedByMarkdown.set('# A-body', makeDoc(['A1']))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderEditor()
    await screen.findByRole('tab', { name: /^other\.md/ })
    let releaseEmit: () => void = () => {}
    emitGate = new Promise<void>((r) => {
      releaseEmit = r
    })
    emitFail = true
    editedDoc = makeDoc(['A1', 'EDITED'])
    fireEvent.click(await screen.findByTestId('edit-doc'))
    fireEvent.click(screen.getByRole('tab', { name: /^other\.md/ }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^other\.md/ }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
    await new Promise((r) => setTimeout(r, 150))
    await act(async () => {
      releaseEmit()
    })
    await new Promise((r) => setTimeout(r, 50))
    // 切替先(other.md)の表示のまま: プレビューの索引は B1 だけ（A1 に戻されていない）
    fireEvent.click(screen.getByRole('button', { name: /Play Mode/i }))
    await waitFor(() => {
      const index = playerProps[playerProps.length - 1].jumpSceneIndex as EventScene[]
      expect(index.map((x) => x.id)).toEqual(['B1'])
    })
  })
})

describe('EditorScreen: 動画書き出し中の操作制限・中止 (#780, #797)', () => {
  const info = (path: string) => ({ path, sha: 's', size: 1, title: null, hidden: false })
  let finishExport: (v: unknown) => void
  let failExport: (e: unknown) => void
  let exportOpts: { signal?: AbortSignal; sceneOrder?: string[] } | undefined

  beforeEach(() => {
    playerProps.length = 0
    parsed = makeDoc(['hub', 'S1'])
    parsedByMarkdown.clear()
    localStorage.clear()
    getContentsMock.mockReset()
    getContentsMock.mockImplementation(async () => ({ content: '# hub', sha: 'sha' }))
    listScriptsMock.mockReset()
    listScriptsMock.mockImplementation(async () => [info('script.md')])
    exportVideoMock.mockReset()
    exportOpts = undefined
    exportVideoMock.mockImplementation(
      (_r: unknown, opts: { signal?: AbortSignal; sceneOrder?: string[] }) => {
        exportOpts = opts
        return new Promise((res, rej) => {
          finishExport = res
          failExport = rej
        })
      }
    )
  })

  let unmountEditor: () => void = () => {}
  function renderEditorForUnmount() {
    unmountEditor = renderEditor().unmount
  }

  async function openModalAndStart() {
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: /Play Mode/i }))
    fireEvent.click(await screen.findByRole('button', { name: '動画エクスポート' }))
    await waitFor(() => expect(exportVideoMock).not.toHaveBeenCalled())
    fireEvent.click(screen.getByText('テスト録画開始'))
    await waitFor(() => expect(exportVideoMock).toHaveBeenCalled())
  }
  const modeBtn = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
  const rpgTab = () => screen.getByRole('tab', { name: 'RPG' }) as HTMLButtonElement

  it('書き出し中はモード切替と RPG タブが押せず、終了後は押せる', async () => {
    await openModalAndStart()
    expect(screen.getByTestId('export-running').textContent).toBe('true')
    expect(modeBtn(/Edit Mode/i).disabled).toBe(true)
    expect(rpgTab().disabled).toBe(true)
    fireEvent.click(modeBtn(/Edit Mode/i))
    fireEvent.click(rpgTab())
    // 押しても切り替わらない（プレビューもモーダルも残る）
    expect(screen.getByTestId('video-export-modal')).toBeTruthy()
    expect(rpgTab().getAttribute('aria-selected')).toBe('false')

    await act(async () => {
      finishExport({
        blob: new Blob(['x']),
        mimeType: 'video/webm',
        durationMs: 1000,
        endReason: 'story-end',
        endMessage: '全イベント完走',
      })
    })
    await waitFor(() => expect(screen.getByTestId('export-running').textContent).toBe('false'))
    expect(modeBtn(/Edit Mode/i).disabled).toBe(false)
    expect(rpgTab().disabled).toBe(false)
    expect(screen.getByTestId('export-status').textContent).toContain('終了理由: 全イベント完走')
  })

  it('書き出しが失敗したあとも、モード切替と RPG タブが押せる', async () => {
    await openModalAndStart()
    await act(async () => {
      failExport(new Error('boom'))
    })
    await waitFor(() => expect(screen.getByTestId('export-running').textContent).toBe('false'))
    expect(modeBtn(/Edit Mode/i).disabled).toBe(false)
    expect(rpgTab().disabled).toBe(false)
    expect(screen.getByTestId('export-status').textContent).toContain('失敗: boom')
  })

  it('中止すると exportVideo の signal が abort され、保存せず中止と表示し、操作が戻る', async () => {
    await openModalAndStart()
    expect(exportOpts?.sceneOrder).toEqual(['hub', 'S1'])
    expect(exportOpts?.signal?.aborted).toBe(false)
    fireEvent.click(screen.getByText('テスト中止'))
    expect(exportOpts?.signal?.aborted).toBe(true)
    const { ExportAbortedError } = await import('../game/VideoExporter')
    await act(async () => {
      failExport(new ExportAbortedError())
    })
    await waitFor(() => expect(screen.getByTestId('export-running').textContent).toBe('false'))
    expect(screen.getByTestId('export-status').textContent).toContain('保存されていません')
    expect(modeBtn(/Edit Mode/i).disabled).toBe(false)
    expect(rpgTab().disabled).toBe(false)
  })

  it('書き出し中に画面を離れる（アンマウント）と、書き出しを中止する', async () => {
    renderEditorForUnmount()
    fireEvent.click(await screen.findByRole('button', { name: /Play Mode/i }))
    fireEvent.click(await screen.findByRole('button', { name: '動画エクスポート' }))
    fireEvent.click(screen.getByText('テスト録画開始'))
    await waitFor(() => expect(exportVideoMock).toHaveBeenCalled())
    expect(exportOpts?.signal?.aborted).toBe(false)
    unmountEditor()
    expect(exportOpts?.signal?.aborted).toBe(true)
  })

  it('タイムアウトで終わったときは、その理由を表示する', async () => {
    await openModalAndStart()
    await act(async () => {
      finishExport({
        blob: new Blob(['x']),
        mimeType: 'video/webm',
        durationMs: 1000,
        endReason: 'stalled',
        endMessage: '60秒間進まなかったため終了',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('export-status').textContent).toContain('タイムアウト')
    )
    expect(screen.getByTestId('export-status').textContent).toContain('60秒間進まなかった')
  })
})
