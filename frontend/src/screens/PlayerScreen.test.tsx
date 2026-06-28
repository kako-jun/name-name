// kako-jun/name-name#108: PlayerScreen の単体テスト。
//
// 検証ポイント:
//   - listProjects / getContents が main ブランチ指定で呼ばれる
//   - 取得した script.md が WASM パーサに渡され、結果が NovelPlayer
//     (またはRPGシーン含有時 RPGPlayer) に流し込まれる
//   - 編集系 UI（保存・破棄・タブなど）が一切描画されない
//   - データ取得失敗時にエラーメッセージが表示される

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
// #284: NovelRenderer.jumpToScene が使う実シーン解決プリミティブ。
// PlayerScreen が連結した scenes に対してクロスファイルのジャンプが解決することを、
// 実装で実際に使われるこの純粋関数で確認する（Pixi/NovelRenderer は jsdom で init 不可）。
import { findSceneById } from '../game/novelLayout'
import type { EventScene } from '../types'

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
// props だけ確認できる軽い擬似コンポーネントに差し替える。
//
// #284: PlayerScreen は通常再生を events=（エントリ doc の線形ストリーム）で、
//   クロスファイルのジャンプ索引を jumpSceneIndex=（全 MD の全シーン）で渡す。
//   data-scene-* は jumpSceneIndex から読む（旧 scenes= 経路は使わない）。
const novelPlayerProps = vi.fn()
vi.mock('../components/NovelPlayer', () => ({
  default: (props: {
    events: unknown
    scenes?: unknown
    jumpSceneIndex?: unknown
    onResolveMissingScene?: (sceneId: string) => Promise<EventScene[] | null>
    assetBaseUrl?: string
  }) => {
    novelPlayerProps(props)
    return (
      <div
        data-testid="novel-player"
        data-event-count={Array.isArray(props.events) ? props.events.length : 0}
        data-scene-count={Array.isArray(props.jumpSceneIndex) ? props.jumpSceneIndex.length : 0}
        data-scene-ids={
          Array.isArray(props.jumpSceneIndex)
            ? (props.jumpSceneIndex as Array<{ id: string }>).map((s) => s.id).join(',')
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

/**
 * 最後に NovelPlayer へ渡された jumpSceneIndex（= NovelRenderer.allScenes に乗る索引）を取り出す。
 * （`Array.prototype.at` はビルドの lib(ES2020) 外なので index アクセスで末尾を取る）
 */
function lastJumpSceneIndex(): EventScene[] {
  const calls = novelPlayerProps.mock.calls
  const lastCall = calls[calls.length - 1]
  expect(lastCall).toBeDefined()
  return (lastCall[0] as { jumpSceneIndex: EventScene[] }).jumpSceneIndex
}

/**
 * 最後に NovelPlayer へ渡された props 全体を取り出す（#310: skipEnabled / debugEnabled の転送確認用）。
 */
function lastNovelPlayerProps(): Record<string, unknown> {
  const calls = novelPlayerProps.mock.calls
  const lastCall = calls[calls.length - 1]
  expect(lastCall).toBeDefined()
  return lastCall[0] as Record<string, unknown>
}

async function resolveMissingScene(sceneId: string): Promise<EventScene[] | null> {
  const resolver = lastNovelPlayerProps().onResolveMissingScene
  expect(typeof resolver).toBe('function')
  let result: EventScene[] | null = null
  await act(async () => {
    result = await (resolver as (id: string) => Promise<EventScene[] | null>)(sceneId)
  })
  return result
}

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

  it('#314: 初期ロードでは entry MD だけを取得して NovelPlayer に渡す', async () => {
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
    // 初期表示では entry(script.md) の 2 シーンだけ。サブ MD は選択後に lazy load する。
    expect(player.getAttribute('data-scene-count')).toBe('2')

    // 連結順: エントリ script.md のシーンが先頭
    const ids = (player.getAttribute('data-scene-ids') ?? '').split(',')
    expect(ids[0]).toBe('hub-script.md')
    expect(ids[1]).toBe('scene2-script.md')
    expect(ids).not.toContain('hub-content/scripts/free/a.md')
    expect(ids).not.toContain('hub-content/scripts/main/b.md')
    // hidden=true の secret.md とサブ MD は初期取得されない
    expect(getContentsMock).not.toHaveBeenCalledWith(
      'theo-hayami',
      'content/scripts/secret.md',
      'main'
    )
    expect(getContentsMock).not.toHaveBeenCalledWith(
      'theo-hayami',
      'content/scripts/free/a.md',
      'main'
    )
  })

  it('#314: 未ロード scene へのジャンプ時に別 MD を追加取得して解決する', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    // エントリ + 別 MD 1 本
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
      { path: 'content/scripts/free/a.md', sha: 's1', size: 1, title: null, hidden: false },
    ])
    getContentsMock.mockImplementation(async (_name: string, path: string) => ({
      path,
      sha: 'x',
      content: path,
    }))
    // エントリ script.md には開始シーン entry-hub、別 MD には別シーン far-scene を持たせる。
    parseMarkdownMock.mockImplementation(async (md: string) => {
      const isEntry = md === 'script.md'
      return {
        engine: 'name-name',
        chapters: [
          {
            number: 1,
            title: 'c',
            hidden: false,
            default_bgm: null,
            scenes: isEntry
              ? [{ id: 'entry-hub', title: 'hub', view: 'TopDown', events: [] }]
              : [{ id: 'far-scene', title: 'far', view: 'TopDown', events: [] }],
          },
        ],
      }
    })

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

    // 初期索引は entry のみ。
    const scenes = lastJumpSceneIndex()
    expect(scenes[0]?.id).toBe('entry-hub')
    expect(findSceneById(scenes, 'far-scene')).toBeUndefined()

    const loadedScenes = await resolveMissingScene('far-scene')
    expect(loadedScenes).not.toBeNull()
    expect(getContentsMock).toHaveBeenCalledWith('theo-hayami', 'content/scripts/free/a.md', 'main')

    const jumped = findSceneById(loadedScenes ?? [], 'far-scene')
    expect(jumped).toBeDefined()
    expect(jumped?.title).toBe('far')
    // 逆方向（別 MD → エントリ）も解決できる
    expect(findSceneById(loadedScenes ?? [], 'entry-hub')?.title).toBe('hub')

    getContentsMock.mockClear()
    const cachedScenes = await resolveMissingScene('far-scene')
    expect(cachedScenes).not.toBeNull()
    expect(getContentsMock).not.toHaveBeenCalled()
  })

  it('#284: listScripts が失敗したら単一 script.md 再生にフォールバックする', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    // listScripts が使えない / 失敗（旧 Worker・テストスタブ等）
    listScriptsMock.mockRejectedValue(new Error('listScripts unavailable'))
    // エントリ script.md だけは取得できる
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'sha-entry',
      content: 'script.md',
    })
    parseMarkdownMock.mockResolvedValue({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes: [{ id: 'only-scene', title: 'only', view: 'TopDown', events: [] }],
        },
      ],
    })

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
    // エントリ 1 本のシーンだけで再生継続（エラーにならない）
    expect(player.getAttribute('data-scene-count')).toBe('1')
    expect(player.getAttribute('data-scene-ids')).toBe('only-scene')
    // エラー表示は出ない
    expect(screen.queryByRole('alert')).toBeNull()
    // エントリ script.md は main で取得済み
    expect(getContentsMock).toHaveBeenCalledWith('theo-hayami', 'script.md', 'main')
  })

  it('#284: 個別 MD の取得/parse 失敗時は残りの MD で再生継続する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    // エントリ + 壊れた MD(bad) + 正常な MD(good)
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
      { path: 'content/scripts/bad.md', sha: 's1', size: 1, title: null, hidden: false },
      { path: 'content/scripts/good.md', sha: 's2', size: 1, title: null, hidden: false },
    ])
    // bad.md の getContents は失敗、それ以外は成功
    getContentsMock.mockImplementation(async (_name: string, path: string) => {
      if (path === 'content/scripts/bad.md') {
        throw new Error('failed to fetch bad.md')
      }
      return { path, sha: 'x', content: path }
    })
    parseMarkdownMock.mockImplementation(async (md: string) => ({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes: [{ id: `scene-${md}`, title: md, view: 'TopDown', events: [] }],
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
    const ids = (player.getAttribute('data-scene-ids') ?? '').split(',')
    // 初期表示では entry のみ。bad/good はまだ取得しない。
    expect(ids).toEqual(['scene-script.md'])
    expect(player.getAttribute('data-scene-count')).toBe('1')

    const loadedScenes = await resolveMissingScene('scene-content/scripts/good.md')
    const loadedIds = (loadedScenes ?? []).map((s) => s.id)
    // lazy fallback で bad.md の失敗を飛ばし、good.md を読み込む。
    expect(loadedIds).toContain('scene-script.md')
    expect(loadedIds).toContain('scene-content/scripts/good.md')
    expect(loadedIds).not.toContain('scene-content/scripts/bad.md')
    // 全体としてエラー表示にはならない
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('#284: シーン ID 重複時は先勝ち + warning を出す', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    // エントリと別 MD で同じシーン ID 'dup' を持つ
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
      { path: 'content/scripts/later.md', sha: 's1', size: 1, title: null, hidden: false },
    ])
    getContentsMock.mockImplementation(async (_name: string, path: string) => ({
      path,
      sha: 'x',
      content: path,
    }))
    parseMarkdownMock.mockImplementation(async (md: string) => {
      const isEntry = md === 'script.md'
      return {
        engine: 'name-name',
        chapters: [
          {
            number: 1,
            title: 'c',
            hidden: false,
            default_bgm: null,
            // 両方が id 'dup' を持つ。later は lazy load の target も併せ持つ。
            scenes: isEntry
              ? [{ id: 'dup', title: 'entry-dup', view: 'TopDown', events: [] }]
              : [
                  { id: 'dup', title: 'later-dup', view: 'TopDown', events: [] },
                  { id: 'later-only', title: 'later-only', view: 'TopDown', events: [] },
                ],
          },
        ],
      }
    })

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

    // 初期表示は entry のみなので、まだ重複は検出されない。
    expect(warnSpy).not.toHaveBeenCalled()

    const loadedScenes = await resolveMissingScene('later-only')

    // lazy load で later.md を足した時点で重複 ID を検出して warning を出す
    expect(warnSpy).toHaveBeenCalled()
    const warned = warnSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('dup')
    )
    expect(warned).toBe(true)

    // 先勝ち: findSceneById は先頭（エントリ）のシーンを返す
    expect(findSceneById(loadedScenes ?? [], 'dup')?.title).toBe('entry-dup')
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

  it('#284: listScripts が 0 件のときは「準備中」案内を表示する', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'missing', title: 'まだ無いゲーム', repo: 'kako-jun/missing' },
    ])
    // listScripts は応答するが再生対象 .md が 1 つも無い（= まだ原稿が投入されていない）。
    listScriptsMock.mockResolvedValue([])

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
    // 0 件なので個別 .md の取得には進まない
    expect(getContentsMock).not.toHaveBeenCalled()
  })

  it('#284: listScripts 不能 + 単一 script.md が 404 のときは「準備中」案内を表示する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ApiError } = await import('../api/client')
    listProjectsMock.mockResolvedValue([
      { name: 'missing', title: 'まだ無いゲーム', repo: 'kako-jun/missing' },
    ])
    // listScripts 自体が使えない（旧 Worker 等）→ 単一 script.md 直接取得にフォールバック。
    listScriptsMock.mockRejectedValue(new Error('listScripts unavailable'))
    // その単一 script.md も 404（リポにまだ原稿が無い）→ 準備中扱い。
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
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('novel-player')).toBeNull()
    // フォールバックは直下 script.md を取りに行く
    expect(getContentsMock).toHaveBeenCalledWith('missing', 'script.md', 'main')
  })

  it('#284: theo-hayami 実構成（直下 script.md 無し・content/scripts/script.md がエントリ）で再生に入る', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    // theo-hayami の実ファイル構成: リポ直下に script.md は無い。
    //   ハブ = content/scripts/script.md、各話 = content/scripts/free|main/*.md
    listScriptsMock.mockResolvedValue([
      { path: 'content/scripts/script.md', sha: 's0', size: 1, title: null, hidden: false },
      {
        path: 'content/scripts/free/netami__makiya.md',
        sha: 's1',
        size: 1,
        title: null,
        hidden: false,
      },
      { path: 'content/scripts/main/ep2.md', sha: 's2', size: 1, title: null, hidden: false },
    ])
    getContentsMock.mockImplementation(async (_name: string, path: string) => ({
      path,
      sha: 'x',
      content: path,
    }))
    // エントリ（basename === script.md）は開始シーン entry-hub を持つ。
    parseMarkdownMock.mockImplementation(async (md: string) => {
      const isEntry = md === 'content/scripts/script.md'
      const isMakiyaNetami = md === 'content/scripts/free/netami__makiya.md'
      return {
        engine: 'name-name',
        chapters: [
          {
            number: 1,
            title: 'c',
            hidden: false,
            default_bgm: null,
            scenes: isEntry
              ? [{ id: 'entry-hub', title: 'hub', view: 'TopDown', events: [] }]
              : [
                  {
                    id: isMakiyaNetami ? 'makiya-netami' : `scene-${md}`,
                    title: md,
                    view: 'TopDown',
                    events: [],
                  },
                ],
          },
        ],
      }
    })

    render(
      <PlayerScreen
        projectName="theo-hayami"
        apiBaseUrl="http://api.test"
        isDark={false}
        onBack={() => {}}
      />
    )

    // 「準備中」ではなく再生（NovelPlayer）に入る
    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })
    expect(screen.queryByText('せおはやみ はまだ準備中です')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    // 直下 script.md は取りに行かない（解決は listScripts の basename ベース）
    expect(getContentsMock).not.toHaveBeenCalledWith('theo-hayami', 'script.md', 'main')
    // 初期ロードではエントリ（content/scripts/script.md）だけを main で取得する
    expect(getContentsMock).toHaveBeenCalledWith('theo-hayami', 'content/scripts/script.md', 'main')
    expect(getContentsMock).not.toHaveBeenCalledWith(
      'theo-hayami',
      'content/scripts/free/netami__makiya.md',
      'main'
    )

    // ジャンプ索引: 初期はエントリ（content/scripts/script.md）のシーンだけ
    const scenes = lastJumpSceneIndex()
    expect(scenes[0]?.id).toBe('entry-hub')
    expect(findSceneById(scenes, 'makiya-netami')).toBeUndefined()
    // エントリは flatten された events= でも線形再生される（最低 1 シーン分のストリーム）
    const player = screen.getByTestId('novel-player')
    expect(player.getAttribute('data-scene-count')).toBe('1')

    const loadedScenes = await resolveMissingScene('makiya-netami')
    expect(getContentsMock).toHaveBeenCalledWith(
      'theo-hayami',
      'content/scripts/free/netami__makiya.md',
      'main'
    )
    expect(findSceneById(loadedScenes ?? [], 'makiya-netami')).toBeDefined()
  })

  it('404 以外のデータ取得失敗はエラーメッセージを表示する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
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

  // --- #310: skip_enabled / debug_enabled を NovelPlayer に転送する ---

  /** skip_enabled / debug_enabled を持つ最小ドキュメントで NovelPlayer 再生に入らせる共通セットアップ。 */
  async function renderWithFrontmatter(frontmatter: {
    skip_enabled?: boolean | null
    debug_enabled?: boolean | null
  }) {
    listProjectsMock.mockResolvedValue([
      { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
    ])
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'sha1',
      content: '# chapter',
    })
    parseMarkdownMock.mockResolvedValue({
      engine: 'name-name',
      // PlayerScreen は entry doc をそのまま doc state に置く（#284）。frontmatter フィールドが
      // doc に乗り、doc?.skip_enabled / doc?.debug_enabled として NovelPlayer に転送される。
      ...frontmatter,
      chapters: [
        {
          id: 'c1',
          title: 'chapter',
          default_bgm: null,
          scenes: [{ id: 's1', title: 'scene', events: [] }],
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
  }

  it('#310: doc.skip_enabled / debug_enabled を NovelPlayer に転送する（true/false）', async () => {
    await renderWithFrontmatter({ skip_enabled: false, debug_enabled: true })
    const props = lastNovelPlayerProps()
    expect(props.skipEnabled).toBe(false)
    expect(props.debugEnabled).toBe(true)
  })

  it('#310: doc に skip_enabled / debug_enabled が無ければ null を転送する（?? null）', async () => {
    // frontmatter にキーが無い = undefined → PlayerScreen は `?? null` で null に正規化する。
    await renderWithFrontmatter({})
    const props = lastNovelPlayerProps()
    expect(props.skipEnabled).toBeNull()
    expect(props.debugEnabled).toBeNull()
  })
})
