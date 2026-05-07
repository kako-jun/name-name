// kako-jun/name-name#109: JumpTopScreen の単体テスト。
//
// 検証ポイント:
//   - listProjects 成功時にタイル表示
//   - タイルクリックで onPlayProject(projectName) が呼ばれる
//   - 編集ボタンはログイン中（isEditor=true）のみ表示され、押すと
//     onEditProject(projectName) が呼ばれる（クリックは play に伝播しない）
//   - 矢印キーでアクティブタイルが移動、Enter で onPlayProject が呼ばれる
//   - listProjects 失敗時にエラー表示

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// API クライアントをモック化
const listProjectsMock = vi.fn()
vi.mock('../api/client', () => ({
  createApiClient: () => ({
    listProjects: listProjectsMock,
    getContents: vi.fn(),
    putContents: vi.fn(),
    listAssets: vi.fn(),
    uploadAsset: vi.fn(),
    getStatus: vi.fn(),
    commit: vi.fn(),
    discard: vi.fn(),
    getTags: vi.fn(),
  }),
}))

import JumpTopScreen from './JumpTopScreen'

beforeEach(() => {
  listProjectsMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const baseProps = {
  apiBaseUrl: 'http://api.test',
  isDark: false,
  onToggleDark: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenAdmin: vi.fn(),
}

describe('JumpTopScreen', () => {
  it('listProjects 成功時にタイル一覧を表示する', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
      { name: 'demo', title: 'demo', repo: 'kako-jun/demo' },
    ])
    render(
      <JumpTopScreen
        {...baseProps}
        onPlayProject={vi.fn()}
        onEditProject={vi.fn()}
        isEditor={() => false}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('game-tile')).toHaveLength(2)
    })
    expect(screen.getByText('友達 1930')).toBeInTheDocument()
    expect(screen.getByText('demo')).toBeInTheDocument()
  })

  it('タイルクリックで onPlayProject が呼ばれる', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
    ])
    const onPlay = vi.fn()
    render(
      <JumpTopScreen
        {...baseProps}
        onPlayProject={onPlay}
        onEditProject={vi.fn()}
        isEditor={() => false}
      />
    )

    const tile = await screen.findByTestId('game-tile')
    fireEvent.click(tile)
    expect(onPlay).toHaveBeenCalledWith('friday-1930')
  })

  it('非ログイン時は編集ボタンを表示しない', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
    ])
    render(
      <JumpTopScreen
        {...baseProps}
        onPlayProject={vi.fn()}
        onEditProject={vi.fn()}
        isEditor={() => false}
      />
    )
    await screen.findByTestId('game-tile')
    expect(screen.queryByRole('button', { name: /編集/ })).toBeNull()
  })

  it('ログイン時は編集ボタンが表示され、押下で onEditProject が呼ばれる', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
    ])
    const onPlay = vi.fn()
    const onEdit = vi.fn()
    render(
      <JumpTopScreen
        {...baseProps}
        onPlayProject={onPlay}
        onEditProject={onEdit}
        isEditor={() => true}
      />
    )

    const editBtn = await screen.findByRole('button', { name: /友達 1930 を編集/ })
    fireEvent.click(editBtn)
    expect(onEdit).toHaveBeenCalledWith('friday-1930')
    // 編集ボタンクリックは play に伝播しない（stopPropagation）
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('矢印キーでアクティブタイルが移動し Enter で onPlayProject が呼ばれる', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'a', title: 'A', repo: 'kako-jun/a' },
      { name: 'b', title: 'B', repo: 'kako-jun/b' },
      { name: 'c', title: 'C', repo: 'kako-jun/c' },
    ])
    const onPlay = vi.fn()
    render(
      <JumpTopScreen
        {...baseProps}
        onPlayProject={onPlay}
        onEditProject={vi.fn()}
        isEditor={() => false}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('game-tile')).toHaveLength(3)
    })

    // 初期 activeIndex=0 のタイル A が aria-pressed="true"
    const tiles = screen.getAllByTestId('game-tile')
    expect(tiles[0].getAttribute('aria-pressed')).toBe('true')

    // → を 2 回押すと C にフォーカスが移る
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(screen.getAllByTestId('game-tile')[2].getAttribute('aria-pressed')).toBe('true')
    })

    // Enter で onPlayProject('c')
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onPlay).toHaveBeenCalledWith('c')
  })

  it('listProjects 失敗時にエラーメッセージを表示する', async () => {
    listProjectsMock.mockRejectedValue(new Error('boom'))
    render(
      <JumpTopScreen
        {...baseProps}
        onPlayProject={vi.fn()}
        onEditProject={vi.fn()}
        isEditor={() => false}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('ゲーム一覧の取得に失敗しました')
    })
    expect(screen.queryByTestId('game-tile')).toBeNull()
  })
})
