/**
 * App: /edit/:projectName の切替でエディタが作り直されること (#795)。
 * 画面コンポーネントはスタブにし、EditorScreen のマウント・アンマウントだけを観測する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useEffect, useRef } from 'react'

const lifecycle: string[] = []
let instanceCounter = 0

vi.mock('./screens/EditorScreen', () => ({
  default: ({ projectName }: { projectName: string }) => {
    // マウントごとに採番する（props の更新だけなら番号は変わらない）
    const id = useRef(++instanceCounter).current
    useEffect(() => {
      lifecycle.push(`mount#${id}`)
      return () => {
        lifecycle.push(`unmount#${id}`)
      }
    }, [id])
    return <div data-testid="editor">{projectName}</div>
  },
}))
vi.mock('./screens/ProjectListScreen', () => ({ default: () => null }))
vi.mock('./screens/AssetsScreen', () => ({ default: () => null }))
vi.mock('./screens/PlayerScreen', () => ({ default: () => null }))
vi.mock('./screens/JumpTopScreen', () => ({ default: () => null }))

import App from './App'

describe('App: /edit/:projectName', () => {
  beforeEach(() => {
    lifecycle.length = 0
    instanceCounter = 0
  })

  it('プロジェクトが変わるとエディタを作り直す（前のプロジェクトの state を引きずらない）', async () => {
    window.history.pushState({}, '', '/edit/a')
    render(<App />)
    expect((await screen.findByTestId('editor')).textContent).toBe('a')
    await act(async () => {
      window.history.pushState({}, '', '/edit/b')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect((await screen.findByTestId('editor')).textContent).toBe('b')
    // 同じインスタンスの props 更新ではなく、別インスタンスに作り直されている
    expect(lifecycle).toEqual(['mount#1', 'unmount#1', 'mount#2'])
  })
})
