// kako-jun/name-name#108: PlayerScreen の単体テスト。
//
// 検証ポイント:
//   - listProjects / getContents が main ブランチ指定で呼ばれる
//   - 取得した script.md が WASM パーサに渡され、結果が NovelPlayer
//     (またはRPGシーン含有時 RPGPlayer) に流し込まれる
//   - 編集系 UI（保存・破棄・タブなど）が一切描画されない
//   - データ取得失敗時にエラーメッセージが表示される

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// API クライアントをモック化
const listProjectsMock = vi.fn()
const listScriptsMock = vi.fn()
const getContentsMock = vi.fn()
vi.mock('../api/client', async (importOriginal) => {
  // ApiError 等の本物のクラスは使い回したいので importOriginal で取り出す。
  const orig = await importOriginal<typeof import('../api/client')>()
  return {
    ...orig,
    createApiClient: () => ({
      listProjects: listProjectsMock,
      // #284: マルチ MD ロードで PlayerScreen が呼ぶ。既定は空配列
      //   （エントリ script.md だけの単一 script 相当）。個別テストで上書きする。
      listScripts: listScriptsMock,
      getContents: getContentsMock,
      putContents: vi.fn(),
      listAssets: vi.fn(),
      uploadAsset: vi.fn(),
      getStatus: vi.fn(),
      commit: vi.fn(),
      discard: vi.fn(),
      getTags: vi.fn(),
    }),
  }
})

// WASM パーサをモック化（jsdom で WASM 初期化はしたくない）
const parseMarkdownMock = vi.fn()
vi.mock('../wasm/parser', () => ({
  parseMarkdown: (md: string) => parseMarkdownMock(md),
  emitMarkdown: vi.fn(),
}))

// NovelPlayer / RPGPlayer は PixiJS に依存し、jsdom では init できないため
// props だけ確認できる軽い擬似コンポーネントに差し替える
const novelPlayerProps = vi.fn()
vi.mock('../components/NovelPlayer', () => ({
  default: (props: { events: unknown; scenes?: unknown; assetBaseUrl?: string }) => {
    novelPlayerProps(props)
    return (
      <div
        data-testid="novel-player"
        data-event-count={Array.isArray(props.events) ? props.events.length : 0}
        data-scene-count={Array.isArray(props.scenes) ? props.scenes.length : 0}
        data-scene-ids={
          Array.isArray(props.scenes)
            ? (props.scenes as Array<{ id: string }>).map((s) => s.id).join(',')
            : ''
        }
        data-asset-base-url={props.assetBaseUrl ?? ''}
      />
    )
  },
}))

const rpgPlayerProps = vi.fn()
vi.mock('../components/RPGPlayer', () => ({
  default: (props: { gameData?: unknown; view?: string }) => {
    rpgPlayerProps(props)
    return <div data-testid="rpg-player" data-view={props.view ?? ''} />
  },
}))

import PlayerScreen from './PlayerScreen'

beforeEach(() => {
  listProjectsMock.mockReset()
  listScriptsMock.mockReset()
  // 既定: エントリ script.md だけ（= 従来の単一 script 再生と等価）
  listScriptsMock.mockResolvedValue([
    { path: 'script.md', sha: 's', size: 1, title: null, hidden: false },
  ])
  getContentsMock.mockReset()
  parseMarkdownMock.mockReset()
  novelPlayerProps.mockReset()
  rpgPlayerProps.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PlayerScreen', () => {
  it('main ブランチから章データを取得して NovelPlayer に渡す', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
    ])
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'sha1',
      content: '# chapter\n\n## scene\n\n- dialog: hello',
    })
    parseMarkdownMock.mockResolvedValue({
      engine: 'name-name',
      chapters: [
        {
          id: 'c1',
          title: 'chapter',
          default_bgm: null,
          scenes: [
            {
              id: 's1',
              title: 'scene',
              events: [
                {
                  Dialog: {
                    character: null,
                    expression: null,
                    position: null,
                    text: 'hello',
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    render(
      <PlayerScreen
        projectName="friday-1930"
        apiBaseUrl="http://api.test"
        isDark={false}
        onBack={() => {}}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })

    // main ブランチ指定で取得していること
    expect(getContentsMock).toHaveBeenCalledWith('friday-1930', 'script.md', 'main')

    // パース結果が NovelPlayer に流れていること（dialog 1件→1イベント）
    const player = screen.getByTestId('novel-player')
    expect(player.getAttribute('data-event-count')).toBe('1')
    // assets ベース URL は Worker proxy 経由
    expect(player.getAttribute('data-asset-base-url')).toBe(
      'http://api.test/api/projects/friday-1930/assets/raw'
    )

    // タイトル表示（ヘッダーの h1 とタイトルオーバーレイの h1 の両方に表示される）
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings.some((h) => h.textContent === '友達 1930')).toBe(true)

    // 編集 UI が描画されていないこと（編集モード固有の文字列が無い）
    expect(screen.queryByText('保存')).toBeNull()
    expect(screen.queryByText('破棄')).toBeNull()
    expect(screen.queryByText('アセット管理')).toBeNull()
    expect(screen.queryByRole('button', { name: 'ノベル' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'RPG' })).toBeNull()
  })

  it('#284: 複数 MD のシーンを連結して scenes= で NovelPlayer に渡す（エントリ先頭）', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    // listScripts: エントリ + サブ MD 2 本（hidden は除外される）
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
      { path: 'content/scripts/free/a.md', sha: 's1', size: 1, title: null, hidden: false },
      { path: 'content/scripts/main/b.md', sha: 's2', size: 1, title: null, hidden: false },
      { path: 'content/scripts/secret.md', sha: 's3', size: 1, title: null, hidden: true },
    ])

    // getContents は path ごとに別の内容を返す
    getContentsMock.mockImplementation(async (_name: string, path: string) => ({
      path,
      sha: 'x',
      content: path,
    }))

    // parseMarkdown は path 文字列をシーン id にしてドキュメントを返す
    parseMarkdownMock.mockImplementation(async (md: string) => ({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes: [
            { id: `hub-${md}`, title: 't', view: 'TopDown', events: [] },
            { id: `scene2-${md}`, title: 't2', view: 'TopDown', events: [] },
          ],
        },
      ],
    }))

    render(
      <PlayerScreen
        projectName="theo-hayami"
        apiBaseUrl="http://api.test"
        isDark={false}
        onBack={() => {}}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })

    const player = screen.getByTestId('novel-player')
    // エントリ(script.md) 2 シーン + サブ 2 本 × 2 シーン = 6（hidden は除外）
    expect(player.getAttribute('data-scene-count')).toBe('6')

    // 連結順: エントリ script.md のシーンが先頭
    const ids = (player.getAttribute('data-scene-ids') ?? '').split(',')
    expect(ids[0]).toBe('hub-script.md')
    expect(ids[1]).toBe('scene2-script.md')
    // サブ MD のシーンも含まれる
    expect(ids).toContain('hub-content/scripts/free/a.md')
    expect(ids).toContain('hub-content/scripts/main/b.md')
    // hidden=true の secret.md は取得・連結されない
    expect(getContentsMock).not.toHaveBeenCalledWith(
      'theo-hayami',
      'content/scripts/secret.md',
      'main'
    )
    // エントリ以外の 2 本は main ブランチで取得される
    expect(getContentsMock).toHaveBeenCalledWith('theo-hayami', 'content/scripts/free/a.md', 'main')
  })

  it('RPG シーンを含むドキュメントは RPGPlayer に渡す', async () => {
    listProjectsMock.mockResolvedValue([{ name: 'demo', title: 'demo', repo: 'kako-jun/demo' }])
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'sha2',
      content: '# rpg',
    })
    parseMarkdownMock.mockResolvedValue({
      engine: 'name-name',
      chapters: [
        {
          id: 'c1',
          title: 'rpg chapter',
          default_bgm: null,
          scenes: [
            {
              id: 'rpg-map',
              title: 'rpg scene',
              events: [
                {
                  RpgMap: {
                    width: 3,
                    height: 2,
                    tile_size: 16,
                    tiles: [
                      [0, 0, 0],
                      [0, 0, 0],
                    ],
                    wall_heights: null,
                    floor_heights: null,
                    ceiling_heights: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    render(
      <PlayerScreen
        projectName="demo"
        apiBaseUrl="http://api.test"
        isDark={false}
        onBack={() => {}}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('rpg-player')).toBeInTheDocument()
    })

    // NovelPlayer は描画されないこと
    expect(screen.queryByTestId('novel-player')).toBeNull()
  })

  it('script.md がリポにまだ無い (404) 場合は「準備中」案内を表示する', async () => {
    const { ApiError } = await import('../api/client')
    listProjectsMock.mockResolvedValue([
      { name: 'missing', title: 'まだ無いゲーム', repo: 'kako-jun/missing' },
    ])
    getContentsMock.mockRejectedValue(new ApiError(404, { error: 'not found' }, 'Not Found'))

    render(
      <PlayerScreen
        projectName="missing"
        apiBaseUrl="http://api.test"
        isDark={false}
        onBack={() => {}}
      />
    )

    expect(await screen.findByText('まだ無いゲーム はまだ準備中です')).toBeInTheDocument()
    // エラー扱いではないので alert role は出ない
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('novel-player')).toBeNull()
    expect(screen.queryByTestId('rpg-player')).toBeNull()
  })

  it('404 以外のデータ取得失敗はエラーメッセージを表示する', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'broken', title: 'broken', repo: 'kako-jun/broken' },
    ])
    getContentsMock.mockRejectedValue(new Error('network down'))

    render(
      <PlayerScreen
        projectName="broken"
        apiBaseUrl="http://api.test"
        isDark={false}
        onBack={() => {}}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('ゲームデータの読み込みに失敗しました')
    })

    expect(screen.queryByTestId('novel-player')).toBeNull()
    expect(screen.queryByTestId('rpg-player')).toBeNull()
  })

  it('戻るボタンを押すと onBack が呼ばれる', async () => {
    listProjectsMock.mockResolvedValue([])
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'sha3',
      content: '',
    })
    parseMarkdownMock.mockResolvedValue({ engine: 'name-name', chapters: [] })

    const onBack = vi.fn()
    render(
      <PlayerScreen projectName="x" apiBaseUrl="http://api.test" isDark={false} onBack={onBack} />
    )

    const backButton = await screen.findByLabelText('プロジェクト一覧に戻る')
    backButton.click()
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
