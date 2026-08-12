// kako-jun/name-name#552: App.tsx のプロジェクトごとの favicon 動的切替の統合テスト。
//
// document.title の更新パターン（各 *Wrapper コンポーネントの useEffect）と同様に
// favicon も画面遷移のたびに切り替わることを、実際のルーティング（BrowserRouter）を
// 通して確認する。子スクリーン（JumpTopScreen/PlayerScreen/EditorScreen/AssetsScreen）は
// PixiJS や実 API 呼び出しに依存するため、PlayerScreen.test.tsx 等と同様に軽い擬似
// コンポーネントへ差し替える。
//
// 検証ポイント:
//   - プロジェクト一覧 (JumpTopScreen) 表示時は favicon が既定（無指定）
//   - /play/:projectName 表示時、favicon.png が存在すれば <link rel="icon"> を設定する
//   - favicon.png が存在しない(404)場合は既定のまま
//   - プレイ画面から戻ると favicon が既定に戻る
//   - /edit/:projectName (EditorScreen) / /edit/:projectName/assets (AssetsScreen)
//     表示時は favicon が既定のまま

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

interface JumpTopScreenStubProps {
  onPlayProject: (projectName: string) => void
  onEditProject: (projectName: string) => void
}
vi.mock('./screens/JumpTopScreen', () => ({
  default: (props: JumpTopScreenStubProps) => (
    <div data-testid="jump-top-screen">
      <button onClick={() => props.onPlayProject('testproject')}>play</button>
      <button onClick={() => props.onEditProject('testproject')}>edit</button>
    </div>
  ),
}))

interface PlayerScreenStubProps {
  projectName: string
  onBack: () => void
}
vi.mock('./screens/PlayerScreen', () => ({
  default: (props: PlayerScreenStubProps) => (
    <div data-testid="player-screen">
      {props.projectName}
      <button onClick={props.onBack}>back</button>
    </div>
  ),
}))

interface EditorScreenStubProps {
  projectName: string
}
vi.mock('./screens/EditorScreen', () => ({
  default: (props: EditorScreenStubProps) => (
    <div data-testid="editor-screen">{props.projectName}</div>
  ),
}))

interface AssetsScreenStubProps {
  projectName: string
}
vi.mock('./screens/AssetsScreen', () => ({
  default: (props: AssetsScreenStubProps) => (
    <div data-testid="assets-screen">{props.projectName}</div>
  ),
}))

vi.mock('./screens/ProjectListScreen', () => ({
  default: () => <div data-testid="project-list-screen" />,
}))

import App from './App'

function getFaviconHref(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  return link ? link.getAttribute('href') : null
}

beforeEach(() => {
  document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
})

describe('App favicon 切替 (#552)', () => {
  it('プロジェクト一覧 (JumpTopScreen) 表示時は favicon が既定（無指定）', () => {
    render(<App />)

    expect(screen.getByTestId('jump-top-screen')).toBeInTheDocument()
    expect(getFaviconHref()).toBeNull()
  })

  it('プロジェクトをプレイすると favicon.png が存在すれば <link rel="icon"> を設定する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    render(<App />)

    fireEvent.click(screen.getByText('play'))
    expect(await screen.findByTestId('player-screen')).toBeInTheDocument()

    await waitFor(() =>
      expect(getFaviconHref()).toBe(
        'http://localhost:8787/api/projects/testproject/assets/raw/images/favicon.png'
      )
    )
  })

  it('favicon.png が存在しない(404)場合は既定のまま', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 404 } as Response)
    render(<App />)

    fireEvent.click(screen.getByText('play'))
    expect(await screen.findByTestId('player-screen')).toBeInTheDocument()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(getFaviconHref()).toBeNull()
  })

  it('プレイ画面から戻ると favicon が既定に戻る', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    render(<App />)

    fireEvent.click(screen.getByText('play'))
    expect(await screen.findByTestId('player-screen')).toBeInTheDocument()
    await waitFor(() => expect(getFaviconHref()).not.toBeNull())

    fireEvent.click(screen.getByText('back'))

    expect(await screen.findByTestId('jump-top-screen')).toBeInTheDocument()
    expect(getFaviconHref()).toBeNull()
  })

  it('/edit/:projectName (EditorScreen) 表示時は favicon が既定のまま', () => {
    window.history.pushState({}, '', '/edit/testproject')
    render(<App />)

    expect(screen.getByTestId('editor-screen')).toBeInTheDocument()
    expect(getFaviconHref()).toBeNull()
  })

  it('/edit/:projectName/assets (AssetsScreen) 表示時は favicon が既定のまま', () => {
    window.history.pushState({}, '', '/edit/testproject/assets')
    render(<App />)

    expect(screen.getByTestId('assets-screen')).toBeInTheDocument()
    expect(getFaviconHref()).toBeNull()
  })
})
