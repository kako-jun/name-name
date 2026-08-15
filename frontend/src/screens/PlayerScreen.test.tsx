// kako-jun/name-name#108: PlayerScreen の単体テスト。
//
// 検証ポイント:
//   - listProjects / getContents が main ブランチ指定で呼ばれる
//   - 取得した script.md が WASM パーサに渡され、結果が NovelPlayer
//     (またはRPGシーン含有時 RPGPlayer) に流し込まれる
//   - 編集系 UI（保存・破棄・タブなど）が一切描画されない
//   - データ取得失敗時にエラーメッセージが表示される

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const {
  getCachedParsedScriptDocumentMock,
  getCachedScriptContentMock,
  putCachedParsedScriptDocumentMock,
  putCachedScriptContentMock,
} = vi.hoisted(() => ({
  getCachedParsedScriptDocumentMock: vi.fn(),
  getCachedScriptContentMock: vi.fn(),
  putCachedParsedScriptDocumentMock: vi.fn(),
  putCachedScriptContentMock: vi.fn(),
}))
vi.mock('../game/scriptContentCache', () => ({
  getCachedParsedScriptDocument: getCachedParsedScriptDocumentMock,
  getCachedScriptContent: getCachedScriptContentMock,
  putCachedParsedScriptDocument: putCachedParsedScriptDocumentMock,
  putCachedScriptContent: putCachedScriptContentMock,
}))

// NovelPlayer / RPGPlayer は PixiJS に依存し、jsdom では init できないため
// props だけ確認できる軽い擬似コンポーネントに差し替える。
//
// #284: PlayerScreen は通常再生を events=（エントリ doc の線形ストリーム）で、
//   クロスファイルのジャンプ索引を jumpSceneIndex=（全 MD の全シーン）で渡す。
//   data-scene-* は jumpSceneIndex から読む（旧 scenes= 経路は使わない）。
const novelPlayerProps = vi.fn()
// タイトル画面 (#628 フェーズ2b): 旧 DOM `TitleOverlay.tsx` は PlayerScreen の兄弟要素として
// 実体レンダーされていたが、`NovelRenderer.showTitleScreen`（PixiJS 描画、jsdom で検証不可）に
// 置き換わったのに伴い NovelPlayer の `titleScreen` prop へ移動した。NovelPlayer 自体は元々
// この mock で軽量スタブ化されている（PixiJS 依存のため）ため、`titleScreen` が非 null の間は
// 旧 `TitleOverlay.tsx` と同じ testid/role/文言の DOM を最小限描画し、既存テストの「タイトルが
// 出る/消える・ボタン押下で副作用が発火する」という検証意図をそのまま保つ（PixiJS 描画そのものの
// 正しさは TitleScreenOverlay/NovelRenderer 側の別テストが担う）。
vi.mock('../components/NovelPlayer', () => ({
  default: (props: {
    events: unknown
    scenes?: unknown
    jumpSceneIndex?: unknown
    onResolveMissingScene?: (sceneId: string) => Promise<EventScene[] | null>
    assetBaseUrl?: string
    pixelArt?: boolean | null
    titleScreen?: {
      title: string
      hasSaveData: boolean
      onNewGame: () => void
      onContinue: () => void
      onOpenSettings: () => void
      onBack: () => void
    } | null
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
      >
        {props.titleScreen && (
          <div data-testid="title-screen-stub">
            <img
              src="title.png"
              alt={props.titleScreen.title}
              style={props.pixelArt ? { imageRendering: 'pixelated' } : undefined}
            />
            <button onClick={props.titleScreen.onNewGame}>新規開始</button>
            <button
              onClick={props.titleScreen.onContinue}
              disabled={!props.titleScreen.hasSaveData}
            >
              つづきから
            </button>
            <button onClick={props.titleScreen.onOpenSettings}>設定</button>
            <button onClick={props.titleScreen.onBack}>終了</button>
          </div>
        )}
      </div>
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

// #392: iframe 埋め込み検知 isEmbedded() を stub する。純粋関数なので true/false を
// 切り替えるだけでヘッダ抑制ゲート（PlayerScreen: const embedded = isEmbedded() →
// {!embedded && <header>...}）を分岐できる（window.top 差し替えより堅牢）。既定値は
// 下の global beforeEach で false（standalone）に固定し、埋め込みテストだけ true に上書きする。
const { isEmbeddedMock } = vi.hoisted(() => ({ isEmbeddedMock: vi.fn() }))
vi.mock('../utils/isEmbedded', () => ({
  isEmbedded: isEmbeddedMock,
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  listProjectsMock.mockReset()
  listScriptsMock.mockReset()
  // 既定: エントリ script.md だけ（= 従来の単一 script 再生と等価）
  listScriptsMock.mockResolvedValue([
    { path: 'script.md', sha: 's', size: 1, title: null, hidden: false },
  ])
  getContentsMock.mockReset()
  getCachedParsedScriptDocumentMock.mockReset()
  getCachedParsedScriptDocumentMock.mockResolvedValue(null)
  getCachedScriptContentMock.mockReset()
  getCachedScriptContentMock.mockResolvedValue(null)
  putCachedParsedScriptDocumentMock.mockReset()
  putCachedParsedScriptDocumentMock.mockResolvedValue(undefined)
  putCachedScriptContentMock.mockReset()
  putCachedScriptContentMock.mockResolvedValue(undefined)
  parseMarkdownMock.mockReset()
  novelPlayerProps.mockReset()
  rpgPlayerProps.mockReset()
  isEmbeddedMock.mockReset()
  // 既定は standalone（非 iframe）。jsdom の本物 isEmbedded() も self===top で false を
  // 返すので後方互換。埋め込みを検証するテストだけ mockReturnValue(true) で上書きする。
  isEmbeddedMock.mockReturnValue(false)
  // #404: intermission.md 取得（assets/raw 経由の生 fetch）を 404（未配置）で既定応答させる。
  // title.png と違い <img> ではなく fetch() を直接叩くため、モックしないと jsdom で実ネットワーク
  // アクセスが発生して失敗し、無関係なテストの console.warn 検証を汚染する。intermission.md の
  // 取得/parse 自体を検証するテストは個別に上書きする。
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PlayerScreen', () => {
  it('#341: visualViewport.height を PlayerScreen の高さに使う', () => {
    const originalVisualViewport = window.visualViewport
    listProjectsMock.mockReturnValue(new Promise(() => {}))

    const visualViewport = new EventTarget() as VisualViewport
    Object.defineProperty(visualViewport, 'height', {
      configurable: true,
      value: 615,
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    })

    const { container } = render(
      <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
    )

    const root = container.firstElementChild as HTMLElement
    expect(root.style.height).toBe('615px')
    expect(root.style.minHeight).toBe('615px')

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    })
  })

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
      <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
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

  it('#314: hard reload の cold path を短くするため project 情報待ちと scripts 一覧取得を並列に始める', async () => {
    const projects = deferred<Array<{ name: string; title: string; repo: string }>>()
    listProjectsMock.mockReturnValue(projects.promise)
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 'entry-sha', size: 1, title: null, hidden: false },
    ])
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'entry-sha',
      content: 'entry-markdown',
    })
    parseMarkdownMock.mockResolvedValue({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes: [{ id: 'entry-scene', title: 'entry', view: 'TopDown', events: [] }],
        },
      ],
    })

    render(
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
    )

    await waitFor(() => {
      expect(listScriptsMock).toHaveBeenCalledWith('theo-hayami', 'main')
    })
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()

    await act(async () => {
      projects.resolve([{ name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' }])
    })

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })
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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
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

  it('#314 Phase 2: entry MD が IndexedDB cache hit なら contents API を呼ばない', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    listScriptsMock.mockResolvedValue([
      { path: 'content/scripts/script.md', sha: 'entry-sha', size: 1, title: null, hidden: false },
      { path: 'content/scripts/free/a.md', sha: 'a-sha', size: 1, title: null, hidden: false },
    ])
    getCachedScriptContentMock.mockImplementation(async ({ path }: { path: string }) =>
      path === 'content/scripts/script.md' ? 'cached-entry-markdown' : null
    )
    getContentsMock.mockResolvedValue({
      path: 'content/scripts/script.md',
      sha: 'entry-sha',
      content: 'network-entry-markdown',
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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })

    expect(getCachedScriptContentMock).toHaveBeenCalledWith({
      projectName: 'theo-hayami',
      ref: 'main',
      path: 'content/scripts/script.md',
      sha: 'entry-sha',
    })
    expect(getContentsMock).not.toHaveBeenCalled()
    expect(putCachedScriptContentMock).not.toHaveBeenCalled()
    expect(parseMarkdownMock).toHaveBeenCalledWith('cached-entry-markdown')
    expect(screen.getByTestId('novel-player').getAttribute('data-scene-ids')).toBe(
      'scene-cached-entry-markdown'
    )
  })

  it('#314 Phase 3: parse済み entry MD cache hit なら contents API も parseMarkdown も呼ばない', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    listScriptsMock.mockResolvedValue([
      { path: 'content/scripts/script.md', sha: 'entry-sha', size: 1, title: null, hidden: false },
    ])
    getCachedParsedScriptDocumentMock.mockResolvedValue({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes: [{ id: 'scene-parsed-cache', title: 'cached', view: 'TopDown', events: [] }],
        },
      ],
    })
    getContentsMock.mockResolvedValue({
      path: 'content/scripts/script.md',
      sha: 'entry-sha',
      content: 'network-entry-markdown',
    })

    render(
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })

    expect(getCachedParsedScriptDocumentMock).toHaveBeenCalledWith({
      projectName: 'theo-hayami',
      ref: 'main',
      path: 'content/scripts/script.md',
      sha: 'entry-sha',
    })
    expect(getCachedScriptContentMock).not.toHaveBeenCalled()
    expect(getContentsMock).not.toHaveBeenCalled()
    expect(parseMarkdownMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('novel-player').getAttribute('data-scene-ids')).toBe(
      'scene-parsed-cache'
    )
  })

  it('#314 Phase 2: cache miss なら contents API から取得して sha 付きで保存する', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 'listed-sha', size: 1, title: null, hidden: false },
    ])
    getCachedScriptContentMock.mockResolvedValue(null)
    getContentsMock.mockResolvedValue({
      path: 'script.md',
      sha: 'contents-sha',
      content: 'network-markdown',
    })
    parseMarkdownMock.mockResolvedValue({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes: [{ id: 'scene-network', title: 'network', view: 'TopDown', events: [] }],
        },
      ],
    })

    render(
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })

    expect(getContentsMock).toHaveBeenCalledWith('theo-hayami', 'script.md', 'main')
    expect(putCachedScriptContentMock).toHaveBeenCalledWith(
      {
        projectName: 'theo-hayami',
        ref: 'main',
        path: 'script.md',
        sha: 'listed-sha',
      },
      'network-markdown'
    )
    expect(putCachedParsedScriptDocumentMock).toHaveBeenCalled()
  })

  it('#314 Phase 2: cache hit した lazy MD も contents API を呼ばずに解決する', async () => {
    listProjectsMock.mockResolvedValue([
      { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
    ])
    listScriptsMock.mockResolvedValue([
      { path: 'script.md', sha: 'entry-sha', size: 1, title: null, hidden: false },
      { path: 'content/scripts/free/a.md', sha: 'a-sha', size: 1, title: null, hidden: false },
    ])
    getCachedScriptContentMock.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'script.md') return 'entry'
      if (path === 'content/scripts/free/a.md') return 'cached-a'
      return null
    })
    getContentsMock.mockResolvedValue({
      path: 'unused.md',
      sha: 'unused',
      content: 'unused',
    })
    parseMarkdownMock.mockImplementation(async (md: string) => ({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'c',
          hidden: false,
          default_bgm: null,
          scenes:
            md === 'entry'
              ? [{ id: 'entry-hub', title: 'hub', view: 'TopDown', events: [] }]
              : [{ id: 'far-scene', title: 'far', view: 'TopDown', events: [] }],
        },
      ],
    }))

    render(
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('novel-player')).toBeInTheDocument()
    })
    expect(getContentsMock).not.toHaveBeenCalled()

    const loadedScenes = await resolveMissingScene('far-scene')

    expect(loadedScenes?.some((s) => s.id === 'far-scene')).toBe(true)
    expect(getCachedScriptContentMock).toHaveBeenCalledWith({
      projectName: 'theo-hayami',
      ref: 'main',
      path: 'content/scripts/free/a.md',
      sha: 'a-sha',
    })
    expect(getContentsMock).not.toHaveBeenCalled()
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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
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

  describe('#607: event_image_transition のマルチファイル継承（サブMD自身が宣言していない場合、エントリの実効値をparse前に注入する）', () => {
    const entryMarkdown =
      '---\nengine: name-name\nevent_image_transition: "pixelate"\n---\n\n## entry-hub: hub\n'

    it('サブMDが event_image_transition を宣言していなければ、エントリの実効値(pixelate)が注入されてparseされる', async () => {
      listProjectsMock.mockResolvedValue([
        { name: 'gymnasia-like', title: 'g', repo: 'kako-jun/gymnasia-like' },
      ])
      listScriptsMock.mockResolvedValue([
        { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
        { path: 'route07/01.md', sha: 's1', size: 1, title: null, hidden: false },
      ])
      const subMarkdown = '---\nengine: name-name\n---\n\n## far-scene: far\n'
      getContentsMock.mockImplementation(async (_name: string, path: string) => ({
        path,
        sha: 'x',
        content: path === 'script.md' ? entryMarkdown : subMarkdown,
      }))
      parseMarkdownMock.mockImplementation(async (md: string) => {
        const isEntry = md.includes('## entry-hub')
        return {
          engine: 'name-name',
          // normalizeDocument（実運用）は常に具体値を埋めるので、モックでもそれに揃える。
          event_image_transition: isEntry ? 'Pixelate' : 'Fade',
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
        <PlayerScreen projectName="gymnasia-like" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })

      await resolveMissingScene('far-scene')

      const subCallArg = parseMarkdownMock.mock.calls
        .map((c) => c[0] as string)
        .find((md) => md.includes('## far-scene'))
      expect(subCallArg).toBeDefined()
      expect(subCallArg).toContain('event_image_transition: "pixelate"')
    })

    it('サブMDが自身で event_image_transition を宣言していれば、エントリの実効値で上書き注入しない', async () => {
      listProjectsMock.mockResolvedValue([
        { name: 'gymnasia-like', title: 'g', repo: 'kako-jun/gymnasia-like' },
      ])
      listScriptsMock.mockResolvedValue([
        { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
        { path: 'route07/01.md', sha: 's1', size: 1, title: null, hidden: false },
      ])
      const subMarkdown =
        '---\nengine: name-name\nevent_image_transition: "fade"\n---\n\n## far-scene: far\n'
      getContentsMock.mockImplementation(async (_name: string, path: string) => ({
        path,
        sha: 'x',
        content: path === 'script.md' ? entryMarkdown : subMarkdown,
      }))
      parseMarkdownMock.mockImplementation(async (md: string) => {
        const isEntry = md.includes('## entry-hub')
        return {
          engine: 'name-name',
          event_image_transition: isEntry ? 'Pixelate' : 'Fade',
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
        <PlayerScreen projectName="gymnasia-like" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })

      await resolveMissingScene('far-scene')

      const subCallArg = parseMarkdownMock.mock.calls
        .map((c) => c[0] as string)
        .find((md) => md.includes('## far-scene'))
      expect(subCallArg).toBeDefined()
      // 元の宣言（fade）のまま。二重注入・上書きが起きていない。
      expect(subCallArg).toBe(subMarkdown)
      expect(subCallArg?.match(/event_image_transition/g)?.length).toBe(1)
    })

    it('エントリの実効値が既定(fade)のときはサブMDへ注入しない(no-op)', async () => {
      listProjectsMock.mockResolvedValue([
        { name: 'plain-project', title: 'p', repo: 'kako-jun/plain-project' },
      ])
      listScriptsMock.mockResolvedValue([
        { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
        { path: 'route07/01.md', sha: 's1', size: 1, title: null, hidden: false },
      ])
      const plainEntryMarkdown = '---\nengine: name-name\n---\n\n## entry-hub: hub\n'
      const subMarkdown = '---\nengine: name-name\n---\n\n## far-scene: far\n'
      getContentsMock.mockImplementation(async (_name: string, path: string) => ({
        path,
        sha: 'x',
        content: path === 'script.md' ? plainEntryMarkdown : subMarkdown,
      }))
      parseMarkdownMock.mockImplementation(async (md: string) => {
        const isEntry = md.includes('## entry-hub')
        return {
          engine: 'name-name',
          event_image_transition: 'Fade',
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
        <PlayerScreen projectName="plain-project" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })

      await resolveMissingScene('far-scene')

      const subCallArg = parseMarkdownMock.mock.calls
        .map((c) => c[0] as string)
        .find((md) => md.includes('## far-scene'))
      expect(subCallArg).toBe(subMarkdown)
    })
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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
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

    render(<PlayerScreen projectName="demo" apiBaseUrl="http://api.test" onBack={() => {}} />)

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

    render(<PlayerScreen projectName="missing" apiBaseUrl="http://api.test" onBack={() => {}} />)

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

    render(<PlayerScreen projectName="missing" apiBaseUrl="http://api.test" onBack={() => {}} />)

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
      <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
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

  // #556: `routeNN/NN-slug.md` 命名規則（Gymnasia等）の候補パス解決。
  //
  // 検証の要点（旧実装でも brute-force フォールバックで最終的には解決していたため、
  // 「解決される」だけでは偽陰性になる）:
  //   - 正しい候補パスが**最初の試行で直接** fetch されること（getContents 呼び出し
  //     回数・呼び出し引数まで assert する）
  //   - 同名 basename を持つ他 route のファイルが誤って fetch されないこと
  //     （route01/02/05/06 の 02-life.md 衝突ケースが最重要）
  describe('PlayerScreen inferScriptPathsForSceneId: routeNN/NN-slug.md 命名規則の候補解決 (#556)', () => {
    const ROUTE_PROJECT_NAME = 'gymnasia-route-fixture'

    // sceneId → 実ファイルの対応表。02-life.md は route01/02/05/06 の 4 route に同名で
    // 存在する（Gymnasia 実データの同名 basename 衝突ケースを再現）。route9/x.md は
    // route 番号が 1 桁のケース、free/netami__makiya.md は route 形式(`r\d+-slug`)に
    // 一致しない theo-hayami パターンの decoy（デシジョンテーブル行5 用）。
    const SCENE_ID_BY_PATH: Record<string, string> = {
      'script.md': 'entry-hub',
      'route01/02-life.md': 'r01-02-life',
      'route02/02-life.md': 'r02-02-life',
      'route05/02-life.md': 'r05-02-life',
      'route06/02-life.md': 'r06-02-life',
      'route09/01-eyes-in-the-dark.md': 'r09-01-eyes-in-the-dark',
      'route9/x.md': 'r9-x',
      'free/netami__makiya.md': 'makiya-netami',
    }

    function mockRouteProject() {
      listProjectsMock.mockResolvedValue([
        { name: ROUTE_PROJECT_NAME, title: 'ルート検証', repo: 'kako-jun/gymnasia' },
      ])
      listScriptsMock.mockResolvedValue(
        Object.keys(SCENE_ID_BY_PATH).map((path, i) => ({
          path,
          sha: `s${i}`,
          size: 1,
          title: null,
          hidden: false,
        }))
      )
      getContentsMock.mockImplementation(async (_name: string, path: string) => ({
        path,
        sha: 'x',
        content: path,
      }))
      parseMarkdownMock.mockImplementation(async (md: string) => ({
        engine: 'name-name',
        chapters: [
          {
            number: 1,
            title: 'c',
            hidden: false,
            default_bgm: null,
            scenes: [{ id: SCENE_ID_BY_PATH[md], title: md, view: 'TopDown', events: [] }],
          },
        ],
      }))
    }

    /** ルート構成をレンダーして NovelPlayer マウントまで待ち、初期ロード（entry 取得）分の
     *  getContents 呼び出し履歴をクリアする。以降 resolveMissingScene() 経由の呼び出しだけを
     *  対象にアサーションできるようにする。 */
    async function renderRouteProject() {
      mockRouteProject()
      render(
        <PlayerScreen
          projectName={ROUTE_PROJECT_NAME}
          apiBaseUrl="http://api.test"
          onBack={() => {}}
        />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
      getContentsMock.mockClear()
    }

    it('r09-01-eyes-in-the-dark は route09/01-eyes-in-the-dark.md に一発で解決される（呼び出し回数1・スラッグ内の複数ハイフンも正しく分割）', async () => {
      await renderRouteProject()

      const scenes = await resolveMissingScene('r09-01-eyes-in-the-dark')

      expect(getContentsMock).toHaveBeenCalledTimes(1)
      expect(getContentsMock).toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'route09/01-eyes-in-the-dark.md',
        'main'
      )
      expect(findSceneById(scenes ?? [], 'r09-01-eyes-in-the-dark')).toBeDefined()
    })

    it('r02-02-life は route02/02-life.md にのみ解決され、同名basenameを持つ他routeの02-life.mdはfetchされない（同名basename排他）', async () => {
      await renderRouteProject()

      const scenes = await resolveMissingScene('r02-02-life')

      expect(getContentsMock).toHaveBeenCalledTimes(1)
      expect(getContentsMock).toHaveBeenCalledWith(ROUTE_PROJECT_NAME, 'route02/02-life.md', 'main')
      expect(getContentsMock).not.toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'route01/02-life.md',
        'main'
      )
      expect(getContentsMock).not.toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'route05/02-life.md',
        'main'
      )
      expect(getContentsMock).not.toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'route06/02-life.md',
        'main'
      )
      expect(findSceneById(scenes ?? [], 'r02-02-life')).toBeDefined()
    })

    it('route形式(r\\d+-slug)に一致しないsceneIdはroute候補を増やさずbasenameパターンのみで解決される（デシジョンテーブル行5）', async () => {
      await renderRouteProject()

      const scenes = await resolveMissingScene('makiya-netami')

      expect(getContentsMock).toHaveBeenCalledTimes(1)
      expect(getContentsMock).toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'free/netami__makiya.md',
        'main'
      )
      // route 候補が誤って混ざっていないこと（decoy の 02-life.md 群が fetch されない）
      expect(getContentsMock).not.toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'route02/02-life.md',
        'main'
      )
      expect(findSceneById(scenes ?? [], 'makiya-netami')).toBeDefined()
    })

    it('slugが空（r09-）のときは正規表現マッチ失敗としてroute候補を生成せずbasenameのみのbrute-forceフォールバックになる（境界値）', async () => {
      await renderRouteProject()

      const scenes = await resolveMissingScene('r09-')

      // route 候補が1つも成立しないため、未ロードの全 path (7件) を順に brute-force する
      expect(getContentsMock).toHaveBeenCalledTimes(7)
      expect(scenes).toBeNull()
    })

    it('route番号が1桁（r9-x）でもゼロ埋めせず正しくroute9/x.mdにマッチする（境界値）', async () => {
      await renderRouteProject()

      const scenes = await resolveMissingScene('r9-x')

      expect(getContentsMock).toHaveBeenCalledTimes(1)
      expect(getContentsMock).toHaveBeenCalledWith(ROUTE_PROJECT_NAME, 'route9/x.md', 'main')
      // ゼロ埋めして route09 と誤混同していないこと
      expect(getContentsMock).not.toHaveBeenCalledWith(
        ROUTE_PROJECT_NAME,
        'route09/01-eyes-in-the-dark.md',
        'main'
      )
      expect(findSceneById(scenes ?? [], 'r9-x')).toBeDefined()
    })

    it('route候補のgetContentsが404で失敗しても、次の候補（basename一致）に継続して解決する（catch→continueの回帰確認）', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { ApiError } = await import('../api/client')
      const FALLBACK_PROJECT_NAME = 'gymnasia-route-fallback-fixture'

      listProjectsMock.mockResolvedValue([
        { name: FALLBACK_PROJECT_NAME, title: 't', repo: 'kako-jun/gymnasia' },
      ])
      listScriptsMock.mockResolvedValue([
        { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
        // route 候補（route02/somefile.md）は 404 する想定。実体は basename 一致の
        // somefile__r02.md 側にある（route 推測が外れても basename 救済で解決できることを示す）。
        { path: 'route02/somefile.md', sha: 's1', size: 1, title: null, hidden: false },
        { path: 'somefile__r02.md', sha: 's2', size: 1, title: null, hidden: false },
      ])
      getContentsMock.mockImplementation(async (_name: string, path: string) => {
        if (path === 'route02/somefile.md') {
          throw new ApiError(404, { error: 'not found' }, 'Not Found')
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
            scenes: [
              {
                id: md === 'script.md' ? 'entry-hub' : 'r02-somefile',
                title: md,
                view: 'TopDown',
                events: [],
              },
            ],
          },
        ],
      }))

      render(
        <PlayerScreen
          projectName={FALLBACK_PROJECT_NAME}
          apiBaseUrl="http://api.test"
          onBack={() => {}}
        />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
      getContentsMock.mockClear()

      const scenes = await resolveMissingScene('r02-somefile')

      expect(getContentsMock).toHaveBeenCalledWith(
        FALLBACK_PROJECT_NAME,
        'route02/somefile.md',
        'main'
      )
      expect(getContentsMock).toHaveBeenCalledWith(
        FALLBACK_PROJECT_NAME,
        'somefile__r02.md',
        'main'
      )
      expect(findSceneById(scenes ?? [], 'r02-somefile')).toBeDefined()
    })

    it('sceneIdが空文字でもクラッシュせず解決失敗(null)を返す', async () => {
      await renderRouteProject()

      const scenes = await resolveMissingScene('')

      expect(scenes).toBeNull()
    })

    it('listScripts不能フォールバック時（sortedPaths=[]）にresolveMissingSceneを呼んでもクラッシュせずnullを返す（paths配列が空の境界値）', async () => {
      listProjectsMock.mockResolvedValue([
        { name: 'gymnasia-single-fixture', title: 'single', repo: 'kako-jun/gymnasia' },
      ])
      listScriptsMock.mockRejectedValue(new Error('listScripts unavailable'))
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
          projectName="gymnasia-single-fixture"
          apiBaseUrl="http://api.test"
          onBack={() => {}}
        />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
      getContentsMock.mockClear()

      const scenes = await resolveMissingScene('unreachable-scene')

      expect(scenes).toBeNull()
      // sortedPaths が空のため候補探索・brute-force フォールバックとも発火しない
      expect(getContentsMock).not.toHaveBeenCalled()
    })

    it('route候補による解決が成功したケースで、予期しないconsole.warn/errorが発生しない', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await renderRouteProject()

      await resolveMissingScene('r09-01-eyes-in-the-dark')

      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('routeサフィックスの単純endsWith一致だとディレクトリ境界を無視して誤マッチする（subroute02/notroute02のようなフォルダ名の decoy がfetchされないこと。#556 self-review S1）', async () => {
      const BOUNDARY_PROJECT_NAME = 'gymnasia-route-boundary-fixture'
      // route02 を末尾に含むが別フォルダである decoy（subroute02, notroute02）を並べる。
      // 単純な `path.endsWith(routeSuffix)` だとこれらも 'route02/02-life.md' 扱いで
      // 誤マッチしてしまう（ディレクトリ境界を認識しないため）。
      const BOUNDARY_SCENE_ID_BY_PATH: Record<string, string> = {
        'script.md': 'entry-hub',
        'route02/02-life.md': 'r02-02-life',
        'subroute02/02-life.md': 'decoy-subroute',
        'notroute02/02-life.md': 'decoy-notroute',
      }

      listProjectsMock.mockResolvedValue([
        { name: BOUNDARY_PROJECT_NAME, title: 't', repo: 'kako-jun/gymnasia' },
      ])
      listScriptsMock.mockResolvedValue(
        Object.keys(BOUNDARY_SCENE_ID_BY_PATH).map((path, i) => ({
          path,
          sha: `b${i}`,
          size: 1,
          title: null,
          hidden: false,
        }))
      )
      getContentsMock.mockImplementation(async (_name: string, path: string) => ({
        path,
        sha: 'x',
        content: path,
      }))
      parseMarkdownMock.mockImplementation(async (md: string) => ({
        engine: 'name-name',
        chapters: [
          {
            number: 1,
            title: 'c',
            hidden: false,
            default_bgm: null,
            scenes: [{ id: BOUNDARY_SCENE_ID_BY_PATH[md], title: md, view: 'TopDown', events: [] }],
          },
        ],
      }))

      render(
        <PlayerScreen
          projectName={BOUNDARY_PROJECT_NAME}
          apiBaseUrl="http://api.test"
          onBack={() => {}}
        />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
      getContentsMock.mockClear()

      const scenes = await resolveMissingScene('r02-02-life')

      expect(getContentsMock).toHaveBeenCalledTimes(1)
      expect(getContentsMock).toHaveBeenCalledWith(
        BOUNDARY_PROJECT_NAME,
        'route02/02-life.md',
        'main'
      )
      expect(getContentsMock).not.toHaveBeenCalledWith(
        BOUNDARY_PROJECT_NAME,
        'subroute02/02-life.md',
        'main'
      )
      expect(getContentsMock).not.toHaveBeenCalledWith(
        BOUNDARY_PROJECT_NAME,
        'notroute02/02-life.md',
        'main'
      )
      expect(findSceneById(scenes ?? [], 'r02-02-life')).toBeDefined()
    })
  })

  it('404 以外のデータ取得失敗はエラーメッセージを表示する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    listProjectsMock.mockResolvedValue([
      { name: 'broken', title: 'broken', repo: 'kako-jun/broken' },
    ])
    getContentsMock.mockRejectedValue(new Error('network down'))

    render(<PlayerScreen projectName="broken" apiBaseUrl="http://api.test" onBack={() => {}} />)

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
    render(<PlayerScreen projectName="x" apiBaseUrl="http://api.test" onBack={onBack} />)

    const backButton = await screen.findByLabelText('プロジェクト一覧に戻る')
    backButton.click()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  // --- #310: skip_enabled / debug_enabled を NovelPlayer に転送する ---

  /** skip_enabled / debug_enabled を持つ最小ドキュメントで NovelPlayer 再生に入らせる共通セットアップ。 */
  async function renderWithFrontmatter(frontmatter: {
    skip_enabled?: boolean | null
    debug_enabled?: boolean | null
    speaker_nudge?: boolean | null
    // standalone 再生時のプレイヤーヘッダ出し方 (#519)。normalizeHeaderMode の入力そのままを
    // 渡せるよう string | null | undefined を許容する（不正値・未指定のフォールバック検証用）。
    header?: string | null
    // ドット絵プロジェクトか (#553)。タイトル画面（#628 フェーズ2b で PixiJS 化。ここでは
    // NovelPlayer mock 内の title-screen-stub の <img>）に image-rendering: pixelated が
    // 伝播することの検証用。
    pixel_art?: boolean | null
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
      <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
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

  // --- #553: doc.pixel_art をタイトル画面のロゴ画像に反映する ---
  //
  // #628 フェーズ2b: 実装本体は DOM `<img>` から PixiJS（`NovelRenderer.showTitleScreen` →
  // `characterLayer.showImage()`）に置き換わった（PixiJS の実描画は jsdom で検証不可）。
  // ここでは PlayerScreen が pixelArt を NovelPlayer へ正しく転送していることを、
  // NovelPlayer mock（title-screen-stub）が描画する <img> の style（image-rendering）
  // 経由で間接的に確認する。EventImageLayer/CharacterLayer の setPixelArt（#466）と
  // 同じ frontmatter 由来の値。

  it('#553: doc.pixel_art が true のとき、タイトル画面のロゴ画像に image-rendering: pixelated が付く', async () => {
    await renderWithFrontmatter({ pixel_art: true })
    const img = document.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.style.imageRendering).toBe('pixelated')
  })

  it('#553: doc.pixel_art が false/未指定のとき、タイトル画面のロゴ画像に image-rendering は付かない（従来どおり補間あり）', async () => {
    await renderWithFrontmatter({ pixel_art: false })
    const imgFalse = document.querySelector('img') as HTMLImageElement
    expect(imgFalse).not.toBeNull()
    expect(imgFalse.style.imageRendering).toBe('')

    await renderWithFrontmatter({})
    const imgUnset = document.querySelector('img') as HTMLImageElement
    expect(imgUnset).not.toBeNull()
    expect(imgUnset.style.imageRendering).toBe('')
  })

  // --- #382: speaker_nudge を NovelPlayer に転送する ---

  it('#382: doc.speaker_nudge を NovelPlayer に speakerNudge として転送する（true/false）', async () => {
    await renderWithFrontmatter({ speaker_nudge: false })
    expect(lastNovelPlayerProps().speakerNudge).toBe(false)

    // 別レンダーで true も確認（doc.speaker_nudge がそのまま流れること）。
    await renderWithFrontmatter({ speaker_nudge: true })
    expect(lastNovelPlayerProps().speakerNudge).toBe(true)
  })

  it('#382: doc に speaker_nudge が無ければ null を転送する（?? null）', async () => {
    // frontmatter にキーが無い = undefined → PlayerScreen は `?? null` で null に正規化する。
    await renderWithFrontmatter({})
    expect(lastNovelPlayerProps().speakerNudge).toBeNull()
  })

  // --- #620: 「つづきから」は renderer.hasQuickSave() の真偽で restart() 呼び出しを分岐する ---
  //
  // #578 の自動 quickLoad により、renderer はマウント時点で既にクイックセーブの最終位置
  // まで復元済み。hasQuickSave()=true なら restart() を呼んではいけない（呼ぶと最初の
  // シーンへ巻き戻り、復元済みの位置を握りつぶす）。タイトルを閉じるだけでよい。
  // hasQuickSave()=false（#578 以前のレガシーセーブ等）は従来どおり startWithSkip を立てて
  // restart() する。renderer 未定義でも optional chaining で安全に動くことも確認する。
  // onNewGame（変更なし）が常に restart() を呼ぶことも非退行として併せて確認する。
  describe('#620: 「つづきから」の hasQuickSave() 分岐', () => {
    type MockRenderer = {
      audioManager: { ensureContext: ReturnType<typeof vi.fn> }
      restart: ReturnType<typeof vi.fn>
      hasQuickSave: ReturnType<typeof vi.fn>
      setDocKey: ReturnType<typeof vi.fn>
    }

    function installMockRenderer(hasQuickSave: boolean): MockRenderer {
      const renderer: MockRenderer = {
        audioManager: { ensureContext: vi.fn() },
        restart: vi.fn(),
        hasQuickSave: vi.fn().mockReturnValue(hasQuickSave),
        setDocKey: vi.fn(),
      }
      ;(window as unknown as { __renderer?: MockRenderer }).__renderer = renderer
      return renderer
    }

    // renderWithFrontmatter は常に projectName="friday-1930" で render する（docKey もこれ）。
    // hasSaveData（つづきからボタンの活性/非活性）は PlayerScreen マウント時に
    // hasAnyReadProgress(projectName) の localStorage 読み取りで一度だけ決まるため、
    // render 前に既読データを仕込んでおく必要がある。
    const READ_PROGRESS_KEY = 'name-name:read-progress:friday-1930'

    afterEach(() => {
      localStorage.removeItem(READ_PROGRESS_KEY)
      delete (window as unknown as { __renderer?: unknown }).__renderer
    })

    it('hasQuickSave()=true なら restart() を呼ばずタイトルを閉じるだけ（quickLoad 済み位置を保つ）', async () => {
      localStorage.setItem(READ_PROGRESS_KEY, JSON.stringify([1]))
      const renderer = installMockRenderer(true)

      await renderWithFrontmatter({})

      const continueButton = screen.getByRole('button', { name: 'つづきから' })
      expect(continueButton).toBeEnabled()
      fireEvent.click(continueButton)

      expect(renderer.audioManager.ensureContext).toHaveBeenCalledTimes(1)
      expect(renderer.hasQuickSave).toHaveBeenCalledTimes(1)
      expect(renderer.restart).not.toHaveBeenCalled()
      // タイトルが閉じる（タイトル画面固有の「新規開始」ボタンが消える）
      expect(screen.queryByRole('button', { name: '新規開始' })).toBeNull()
      // 復元済み位置を保つため、既読スキップモードは立てない
      expect(lastNovelPlayerProps().initialSkipMode).toBe(false)
    })

    it('hasQuickSave()=false なら従来どおり startWithSkip + restart() にフォールバックする', async () => {
      localStorage.setItem(READ_PROGRESS_KEY, JSON.stringify([1]))
      const renderer = installMockRenderer(false)

      await renderWithFrontmatter({})

      const continueButton = screen.getByRole('button', { name: 'つづきから' })
      fireEvent.click(continueButton)

      expect(renderer.hasQuickSave).toHaveBeenCalledTimes(1)
      expect(renderer.restart).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: '新規開始' })).toBeNull()
      expect(lastNovelPlayerProps().initialSkipMode).toBe(true)
    })

    it('window.__renderer が未定義でも例外にならず、フォールバック分岐で安全にタイトルを閉じる（optional chaining）', async () => {
      localStorage.setItem(READ_PROGRESS_KEY, JSON.stringify([1]))
      // installMockRenderer を呼ばない = window.__renderer は未設定のまま

      await renderWithFrontmatter({})

      const continueButton = screen.getByRole('button', { name: 'つづきから' })
      expect(() => fireEvent.click(continueButton)).not.toThrow()
      expect(screen.queryByRole('button', { name: '新規開始' })).toBeNull()
      expect(lastNovelPlayerProps().initialSkipMode).toBe(true)
    })

    it('onNewGame は今回の変更で非退行: 常に restart() を呼ぶ', async () => {
      const renderer = installMockRenderer(true)

      await renderWithFrontmatter({})

      const newGameButton = screen.getByRole('button', { name: '新規開始' })
      fireEvent.click(newGameButton)

      expect(renderer.audioManager.ensureContext).toHaveBeenCalledTimes(1)
      expect(renderer.restart).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: '新規開始' })).toBeNull()
    })
  })

  // --- #386: `?scene=<sceneId>` ディープリンク + confinement ---
  //
  // マルチ MD 構成（エントリ = hub、別 MD = 個別セル）で `?scene=` を解決し、
  // NovelPlayer に initialSceneId / confinedSceneIds として渡る配線を検証する。
  // findConfinedSceneIds は PlayerScreen 内の非公開関数なので、直接ではなく
  // lastNovelPlayerProps() 経由で観測する（既存の #310/#382 転送テストと同じ流儀）。
  describe('PlayerScreen `?scene=` ディープリンク + confinement (#386)', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/')
    })
    afterEach(() => {
      window.history.pushState({}, '', '/')
    })

    // マルチ MD 構成のプロジェクトタイトル。mock（listProjects）と #392 のヘッダ h1
    // アサーションで同じ定数を参照し、期待値の直書き・二重管理を避ける。
    const MULTI_DOC_TITLE = 'せおはやみ'

    /** hub(script.md) 1 シーン + 別 MD(cell) 2 シーンの標準的なマルチ MD 構成をセットアップする。 */
    function mockMultiDocProject() {
      listProjectsMock.mockResolvedValue([
        { name: 'theo-hayami', title: MULTI_DOC_TITLE, repo: 'kako-jun/theo-hayami' },
      ])
      listScriptsMock.mockResolvedValue([
        { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
        { path: 'content/scripts/free/a.md', sha: 's1', size: 1, title: null, hidden: false },
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
              scenes: isEntry
                ? [{ id: 'hub-scene', title: 'hub', view: 'TopDown', events: [] }]
                : [
                    { id: 'cell-scene-1', title: 'cell1', view: 'TopDown', events: [] },
                    { id: 'cell-scene-2', title: 'cell2', view: 'TopDown', events: [] },
                  ],
            },
          ],
        }
      })
    }

    async function renderMultiDocProject() {
      mockMultiDocProject()
      render(
        <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
    }

    it('40: ?scene=<別MDのcell sceneId> 指定時、initialSceneId が解決済み sceneId になる', async () => {
      window.history.pushState({}, '', '?scene=cell-scene-1')
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().initialSceneId).toBe('cell-scene-1')
    })

    it('41: 上記と同条件で、confinedSceneIds はその cell ファイル自身の sceneId 一覧のみ（hub の sceneId を含まない）', async () => {
      window.history.pushState({}, '', '?scene=cell-scene-1')
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().confinedSceneIds).toEqual(['cell-scene-1', 'cell-scene-2'])
    })

    it('42: ?scene= 未指定時、initialSceneId/confinedSceneIds はともに null のまま', async () => {
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().initialSceneId).toBeNull()
      expect(lastNovelPlayerProps().confinedSceneIds).toBeNull()
    })

    it('43: ?scene=<存在しない sceneId> 指定時、initialSceneId/confinedSceneIds ともに null にフォールバックする', async () => {
      window.history.pushState({}, '', '?scene=no-such-scene')
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().initialSceneId).toBeNull()
      expect(lastNovelPlayerProps().confinedSceneIds).toBeNull()
      // フォールバックであってエラー扱いにはならない
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('44【修正2】: ?scene=<entry(hub)自身の sceneId> 指定時、initialSceneId は解決されるが confinedSceneIds は null のまま（無制限フローへフォールバック）', async () => {
      window.history.pushState({}, '', '?scene=hub-scene')
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().initialSceneId).toBe('hub-scene')
      // hub 自身を confinement にすると hub→各お題への通常遷移まで即終劇になってしまうため、
      // findConfinedSceneIds は entry doc を候補から除外して null を返す（無制限フロー）。
      expect(lastNovelPlayerProps().confinedSceneIds).toBeNull()
    })

    it('45: listScripts 失敗（単一 script.md フォールバック）時、?scene= が entry 内で解決できても confinedSceneIds は常に null のままである', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      window.history.pushState({}, '', '?scene=only-scene')
      listProjectsMock.mockResolvedValue([
        { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
      ])
      listScriptsMock.mockRejectedValue(new Error('listScripts unavailable'))
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
        <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })

      expect(lastNovelPlayerProps().initialSceneId).toBe('only-scene')
      expect(lastNovelPlayerProps().confinedSceneIds).toBeNull()
    })

    it('46: ?scene= 解決に必要な別 MD の取得が失敗しても（resolveMissingScene が内部で catch して null を返す）クラッシュせず entry 再生にフォールバックする', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      window.history.pushState({}, '', '?scene=unreachable-scene')
      listProjectsMock.mockResolvedValue([
        { name: 'theo-hayami', title: 'せおはやみ', repo: 'kako-jun/theo-hayami' },
      ])
      listScriptsMock.mockResolvedValue([
        { path: 'script.md', sha: 's0', size: 1, title: null, hidden: false },
        { path: 'content/scripts/broken.md', sha: 's1', size: 1, title: null, hidden: false },
      ])
      getContentsMock.mockImplementation(async (_name: string, path: string) => {
        if (path === 'content/scripts/broken.md') {
          throw new Error('network down')
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
            scenes: [
              {
                id: md === 'script.md' ? 'hub-scene' : 'unreachable-scene',
                title: md,
                view: 'TopDown',
                events: [],
              },
            ],
          },
        ],
      }))

      render(
        <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })

      expect(screen.queryByRole('alert')).toBeNull()
      expect(lastNovelPlayerProps().initialSceneId).toBeNull()
      expect(lastNovelPlayerProps().confinedSceneIds).toBeNull()
    })

    it('47a: ?scene= 解決成功時、debugInfo に "scene param: ... → resolved" の行が入る', async () => {
      window.history.pushState({}, '', '?scene=cell-scene-1')
      await renderMultiDocProject()
      const debugInfo = lastNovelPlayerProps().debugInfo as string[]
      expect(debugInfo).toContain('scene param: cell-scene-1 → resolved')
    })

    it('47b: ?scene= 解決失敗時、debugInfo に "scene param: ... → not found (fallback to entry)" の行が入る', async () => {
      window.history.pushState({}, '', '?scene=no-such-scene')
      await renderMultiDocProject()
      const debugInfo = lastNovelPlayerProps().debugInfo as string[]
      expect(debugInfo).toContain('scene param: no-such-scene → not found (fallback to entry)')
    })

    // #388: ディープリンク解決時は タイトル画面を出さず該当シーンへ直行する。
    // タイトル画面の存在は「新規開始」ボタン（タイトル画面固有の文言）で判定する。
    it('48【#388】: ?scene= 解決時（deep-link モード）は タイトル画面（新規開始ボタン）を出さない', async () => {
      window.history.pushState({}, '', '?scene=cell-scene-1')
      await renderMultiDocProject()
      // 前提: deep-link が解決されている（initialSceneId 非 null）
      expect(lastNovelPlayerProps().initialSceneId).toBe('cell-scene-1')
      // タイトルは出ない＝startFrom(initialSceneId) の該当シーンをそのまま見せる
      expect(screen.queryByRole('button', { name: '新規開始' })).toBeNull()
    })

    it('49【#388】: ?scene= 未指定時（通常フロー）は従来どおり タイトル画面（新規開始ボタン）を出す', async () => {
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().initialSceneId).toBeNull()
      expect(screen.getByRole('button', { name: '新規開始' })).toBeInTheDocument()
    })

    it('50【#388】: ?scene=<entry(hub)自身の sceneId> でも解決されれば deep-link モードとして タイトル画面を出さない', async () => {
      // hub 自身指定は confinedSceneIds=null（無制限）にフォールバックするが、
      // initialSceneId は解決される（#386 修正2）。deep-link モード判定は startSceneId 非 null なので
      // この場合もタイトルは出さない（startFrom(hub-scene) の位置を保つ）。
      window.history.pushState({}, '', '?scene=hub-scene')
      await renderMultiDocProject()
      expect(lastNovelPlayerProps().initialSceneId).toBe('hub-scene')
      expect(screen.queryByRole('button', { name: '新規開始' })).toBeNull()
    })

    // --- #392: iframe 埋め込み表示時はプレイヤーヘッダ（戻る＋タイトル）を描画しない ---
    //
    // 抑制ゲートは iframe 埋め込み検知 isEmbedded()（PlayerScreen.tsx:
    // `const embedded = isEmbedded()` → `{!embedded && <header>...}`）。
    // isEmbedded は純粋関数なのでファイル先頭で vi.mock し、true/false を切り替えて分岐させる
    // （window.top 差し替えより堅牢）。既定は global beforeEach で false（standalone）に固定。
    // ヘッダの有無はユーザー可視要素で判定する:
    //   - 戻るボタン: aria-label='プロジェクト一覧に戻る'（ヘッダ固有。タイトル画面の
    //     終了ボタンは text '終了' で aria-label を持たないため衝突しない）
    //   - <header> 要素（暗黙 role=banner）内のタイトル h1
    // 埋め込み(true)で消え、standalone(false)で出ることを否定・肯定の両側で担保する。
    // ヘッダ抑制は `?scene=`（#388 の startSceneId ゲート）と直交する。
    describe('プレイヤーヘッダ（戻る/タイトル）の表示制御 (#392)', () => {
      it('standalone（isEmbedded()===false）は戻るボタンとタイトル h1 を持つヘッダを描画する', async () => {
        // 既定 false のまま（global beforeEach の mockReturnValue(false)）
        await renderMultiDocProject()
        // ヘッダ固有の戻るボタンが存在する
        expect(screen.queryByLabelText('プロジェクト一覧に戻る')).not.toBeNull()
        // <header>（banner）内にプロジェクトタイトルの h1 が出る（title.png は jsdom で
        // 読み込まれないため タイトル画面側にも h1 は出るが、banner スコープ内の 1 本を見る）
        const banner = screen.getByRole('banner')
        expect(within(banner).getByRole('heading', { level: 1 }).textContent).toBe(MULTI_DOC_TITLE)
      })

      it('埋め込み（isEmbedded()===true）はヘッダ（戻るボタン/banner）を描画しない', async () => {
        isEmbeddedMock.mockReturnValue(true)
        await renderMultiDocProject()
        expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
        expect(screen.queryByRole('banner')).toBeNull()
      })

      it('埋め込み時は ?scene=<cell の sceneId> ディープリンク有りでもヘッダを描画しない（?scene= 有無に依存しない＝直交の担保）', async () => {
        isEmbeddedMock.mockReturnValue(true)
        window.history.pushState({}, '', '?scene=cell-scene-1')
        await renderMultiDocProject()
        // 前提: ?scene= は実際に解決している（scene param が効いていることの確認）。
        // それでもヘッダ抑制は isEmbedded() が担い、startSceneId には依存しない。
        // 注: 旧 startSceneId 設計の回帰そのものは、この embedded×scene 条件では新旧どちらも
        // ヘッダが隠れて弁別しない。旧設計を射抜くのは embedded×no-scene の上の2ケース
        // （旧設計なら startSceneId===null でヘッダが出てしまい赤くなる）。本ケースの価値は
        // 「埋め込みなら ?scene= が有ってもヘッダを再表示させない」＝直交の担保。
        expect(lastNovelPlayerProps().initialSceneId).toBe('cell-scene-1')
        expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
        expect(screen.queryByRole('banner')).toBeNull()
      })

      it('standalone は ?scene=<cell の sceneId> ディープリンク有りでもヘッダを描画する（抑制は isEmbedded が担い ?scene= は無関係・4象限を閉じる）', async () => {
        // 既定 false（standalone）のまま。architecture.md の約束＝`?scene=` 標準タブ直開きは
        // ヘッダ有。抑制ゲートが isEmbedded() であり startSceneId/?scene= に依存しないことを
        // standalone 方向でも固定する（embedded×scene と対を成す）。
        window.history.pushState({}, '', '?scene=cell-scene-1')
        await renderMultiDocProject()
        // ?scene= は解決している（deep-link だが standalone なのでヘッダは出る）
        expect(lastNovelPlayerProps().initialSceneId).toBe('cell-scene-1')
        expect(screen.queryByLabelText('プロジェクト一覧に戻る')).not.toBeNull()
        const banner = screen.getByRole('banner')
        expect(within(banner).getByRole('heading', { level: 1 }).textContent).toBe(MULTI_DOC_TITLE)
      })

      it('埋め込み判定は #388 の タイトル画面ゲート（startSceneId）と直交する（埋め込みでヘッダは消えるが ?scene= 未指定なら タイトル画面の新規開始は従来どおり出る）', async () => {
        isEmbeddedMock.mockReturnValue(true)
        await renderMultiDocProject()
        // ヘッダは isEmbedded()===true で消える
        expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
        expect(screen.queryByRole('banner')).toBeNull()
        // 一方 タイトル画面は startSceneId===null（?scene= 未指定）なので従来どおり出る。
        // ＝ヘッダ抑制ゲート（isEmbedded）が タイトル画面表示ゲート（startSceneId）に
        // 影響しないことの担保。
        expect(lastNovelPlayerProps().initialSceneId).toBeNull()
        expect(screen.getByRole('button', { name: '新規開始' })).toBeInTheDocument()
      })
    })
  })

  // --- #519: frontmatter `header:` による standalone 再生時のプレイヤーヘッダ抑制 ---
  //
  // isEmbedded()（#392）とは独立の軸。normalizeHeaderMode(doc.header) が
  // 'hidden'/'collapsed' はそのまま透過・それ以外（未指定/不正値）は 'visible' に
  // フォールバックし、描画ゲートは `!loading && !embedded && headerMode==='visible'`（フルヘッダ）/
  // `!loading && !embedded && headerMode==='collapsed'`（ハンドル＋オーバーレイ）/ それ以外は非表示。
  // embedded===true は headerMode に関係なく常に非表示（両ブロックとも `!embedded` を含む）。
  // `!loading`（#519 セルフレビュー should, ケース12/13）: doc は初期値 null のため取得完了前は
  // normalizeHeaderMode(undefined) が既定 'visible' を返す。これが無いと header: "hidden"/
  // "collapsed" 設定時も取得完了までの一瞬フルヘッダーが見えてしまう（FOUC）ため、loading 中は
  // headerMode を問わず何も出さない。
  // renderWithFrontmatter（#310/#382 で定義済み）を再利用し、doc.header に直接値を注入する。
  describe('PlayerScreen header: hidden/collapsed による standalone ヘッダ抑制 (#519)', () => {
    it('1: standalone×header:"visible" は戻るボタンとtitle h1を持つ<header>(banner)が描画される', async () => {
      await renderWithFrontmatter({ header: 'visible' })
      const banner = screen.getByRole('banner')
      expect(within(banner).getByRole('heading', { level: 1 }).textContent).toBe('友達 1930')
      expect(screen.getByLabelText('プロジェクト一覧に戻る')).toBeInTheDocument()
    })

    it('2: standalone×header:"hidden" はbanner・戻るボタン・折りたたみハンドルのいずれも存在しない', async () => {
      await renderWithFrontmatter({ header: 'hidden' })
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
      expect(screen.queryByLabelText('ヘッダーを表示')).toBeNull()
      expect(screen.queryByLabelText('ヘッダーを閉じる')).toBeNull()
    })

    it('3: standalone×header:"collapsed" 初期状態は折りたたみハンドルのみ存在し、banner/戻るボタンは存在しない', async () => {
      await renderWithFrontmatter({ header: 'collapsed' })
      expect(screen.getByLabelText('ヘッダーを表示')).toBeInTheDocument()
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
    })

    it('4: standalone×header未指定はケース1と同じ結果になる（後方互換）', async () => {
      await renderWithFrontmatter({})
      const banner = screen.getByRole('banner')
      expect(within(banner).getByRole('heading', { level: 1 }).textContent).toBe('友達 1930')
      expect(screen.getByLabelText('プロジェクト一覧に戻る')).toBeInTheDocument()
    })

    it('5: embedded×header:"visible" は非表示（embedded優先の直接確認）', async () => {
      isEmbeddedMock.mockReturnValue(true)
      await renderWithFrontmatter({ header: 'visible' })
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
    })

    it('6: embedded×header:"hidden" は非表示', async () => {
      isEmbeddedMock.mockReturnValue(true)
      await renderWithFrontmatter({ header: 'hidden' })
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
    })

    it('7【最重要】: embedded×header:"collapsed" は折りたたみハンドルも含め何も描画されない（collapsed 機構自体が embedded で無効化される）', async () => {
      isEmbeddedMock.mockReturnValue(true)
      await renderWithFrontmatter({ header: 'collapsed' })
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
      expect(screen.queryByLabelText('ヘッダーを表示')).toBeNull()
      expect(screen.queryByLabelText('ヘッダーを閉じる')).toBeNull()
    })

    it('8: header:""（空文字）はvisibleフォールバックし、console.warn/errorが呼ばれない', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await renderWithFrontmatter({ header: '' })
      expect(screen.getByRole('banner')).toBeInTheDocument()
      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('9: header:"Hidden"（大文字混じり）はvisibleフォールバックする', async () => {
      await renderWithFrontmatter({ header: 'Hidden' })
      expect(screen.getByRole('banner')).toBeInTheDocument()
    })

    it('10: header:"foo"（未知の文字列）はvisibleフォールバックする', async () => {
      await renderWithFrontmatter({ header: 'foo' })
      expect(screen.getByRole('banner')).toBeInTheDocument()
    })

    it('11: header:null はvisibleフォールバックし、TypeErrorが発生しない', async () => {
      // normalizeHeaderMode(null) が例外を投げれば render 自体が失敗してこのテストが落ちる。
      await renderWithFrontmatter({ header: null })
      expect(screen.getByRole('banner')).toBeInTheDocument()
    })

    // --- FOUC防止（#519 セルフレビュー should）---
    //
    // headerMode = normalizeHeaderMode(doc?.header) は doc の初期値が null のため、entry MD の
    // 取得完了（loading=false）までの間は既定の 'visible' を返す。`!loading &&` ゲートが無いと、
    // header: "hidden"/"collapsed" を設定していても doc 取得完了までの一瞬だけ従来のフルヘッダー
    // （banner）が表示されてしまう（`hidden` を選ぶ動機＝外部に name-name だと気づかせない、と
    // 直接矛盾する）。api.getContents を deferred にして loading 中の状態を固定し、その間は
    // headerMode を問わず何も出ないこと・ロード完了後は従来どおり出ることを確認する。
    it('12: doc取得中（loading）はheader:"hidden"設定時と同様、既定headerMode="visible"でもヘッダーが一切表示されない', async () => {
      const content = deferred<{ path: string; sha: string; content: string }>()
      listProjectsMock.mockResolvedValue([
        { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
      ])
      getContentsMock.mockReturnValue(content.promise)
      parseMarkdownMock.mockResolvedValue({
        engine: 'name-name',
        // header 未指定＝既定 'visible'。loading 中に既に 'visible' 相当が漏れ出ないことを見る。
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
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )

      await waitFor(() => {
        expect(screen.getByText('読み込み中...')).toBeInTheDocument()
      })
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByLabelText('プロジェクト一覧に戻る')).toBeNull()
      expect(screen.queryByLabelText('ヘッダーを表示')).toBeNull()
      expect(screen.queryByLabelText('ヘッダーを閉じる')).toBeNull()

      await act(async () => {
        content.resolve({ path: 'script.md', sha: 'sha1', content: '# chapter' })
      })

      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
      // ロード完了後は headerMode="visible"（既定）どおりヘッダーが出る＝影響が無いことの確認。
      expect(screen.getByRole('banner')).toBeInTheDocument()
    })

    it('13: doc取得中（loading）はheader:"collapsed"設定時も折りたたみハンドルすら表示されない', async () => {
      const content = deferred<{ path: string; sha: string; content: string }>()
      listProjectsMock.mockResolvedValue([
        { name: 'friday-1930', title: '友達 1930', repo: 'kako-jun/friday-1930' },
      ])
      getContentsMock.mockReturnValue(content.promise)
      parseMarkdownMock.mockResolvedValue({
        engine: 'name-name',
        header: 'collapsed',
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
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )

      await waitFor(() => {
        expect(screen.getByText('読み込み中...')).toBeInTheDocument()
      })
      // collapsed の折りたたみハンドル自体も loading 中は出ない（普段は隠れている、を loading 中も守る）
      expect(screen.queryByLabelText('ヘッダーを表示')).toBeNull()
      expect(screen.queryByRole('banner')).toBeNull()

      await act(async () => {
        content.resolve({ path: 'script.md', sha: 'sha1', content: '# chapter' })
      })

      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
      // ロード完了後は headerMode="collapsed" どおりハンドルが出る。
      expect(screen.getByLabelText('ヘッダーを表示')).toBeInTheDocument()
      expect(screen.queryByRole('banner')).toBeNull()
    })

    // --- collapsed ハンドルの展開/自動折りたたみ操作 (#519) ---
    //
    // ハンドルの 3 秒自動折りたたみタイマー（window.setTimeout）を検証するため vi.useFakeTimers()
    // を使う。ただし renderWithFrontmatter 内の初期ロード待ち（await waitFor）は
    // @testing-library/dom が vitest の fake timers を検知できず（jest 専用の検知ロジックのため）
    // 内部ポーリングが進まず固まる。そのため各テストでは「初期ロードは real timers のまま waitFor
    // で待ち切り、ハンドル操作の直前で vi.useFakeTimers() に切り替える」順序にする
    // （3 秒タイマー自体は切り替え後に張られる setTimeout なので fake timers の対象になる）。
    describe('PlayerScreen header:"collapsed" ハンドルの展開/自動折りたたみ (#519)', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('14: collapsed初期状態でハンドルをタップするとheaderExpanded=true相当になりheaderが表示される', async () => {
        await renderWithFrontmatter({ header: 'collapsed' })
        vi.useFakeTimers()
        fireEvent.click(screen.getByLabelText('ヘッダーを表示'))
        expect(screen.getByRole('banner')).toBeInTheDocument()
        expect(screen.getByLabelText('ヘッダーを閉じる')).toBeInTheDocument()
      })

      it('15: 展開後、3秒経過すると自動的に折りたたまれる', async () => {
        await renderWithFrontmatter({ header: 'collapsed' })
        vi.useFakeTimers()
        fireEvent.click(screen.getByLabelText('ヘッダーを表示'))
        expect(screen.getByRole('banner')).toBeInTheDocument()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000)
        })

        expect(screen.queryByRole('banner')).toBeNull()
        expect(screen.getByLabelText('ヘッダーを表示')).toBeInTheDocument()
      })

      it('16: 展開後、3秒未満でハンドルを再タップすると即座に折りたたまれる（タイマー満了を待たない）', async () => {
        await renderWithFrontmatter({ header: 'collapsed' })
        vi.useFakeTimers()
        fireEvent.click(screen.getByLabelText('ヘッダーを表示'))
        expect(screen.getByRole('banner')).toBeInTheDocument()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        // 3秒未満なのでまだ自動折りたたみされていない
        expect(screen.getByRole('banner')).toBeInTheDocument()

        // 再タップで即座に折りたたむ（残り2秒のタイマー満了を待たない）
        fireEvent.click(screen.getByLabelText('ヘッダーを閉じる'))
        expect(screen.queryByRole('banner')).toBeNull()
        expect(screen.getByLabelText('ヘッダーを表示')).toBeInTheDocument()
      })

      it('17: 展開中にunmountされるとclearTimeoutが呼ばれ、unmount後に状態更新のエラーが出ない', async () => {
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
          header: 'collapsed',
          chapters: [
            {
              id: 'c1',
              title: 'chapter',
              default_bgm: null,
              scenes: [{ id: 's1', title: 'scene', events: [] }],
            },
          ],
        })

        const { unmount } = render(
          <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
        )
        await waitFor(() => {
          expect(screen.getByTestId('novel-player')).toBeInTheDocument()
        })
        vi.useFakeTimers()
        fireEvent.click(screen.getByLabelText('ヘッダーを表示'))
        expect(screen.getByRole('banner')).toBeInTheDocument()

        // ここから先だけを対象に検証する（初期ロード由来の無関係な warning を巻き込まない）。
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        unmount()
        expect(clearTimeoutSpy).toHaveBeenCalled()

        // unmount 後に本来のタイマー満了時刻を過ぎても、状態更新エラーが出ないこと。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000)
        })
        expect(errorSpy).not.toHaveBeenCalled()
      })
    })
  })

  // --- #394: プレイヤーの見た目テーマ（既定 dark・?theme=light で light）---
  //
  // App の darkMode（エディタ UI 用の isDark prop）ではなく `?theme=` で決まる。
  // playerDark はマウント時に `parseThemeQuery(window.location.search) === 'dark'` で
  // 一度だけ評価されるので、render 前に history.pushState で ?theme= を設定する（#386/#392
  // と同じ流儀）。loading 状態は listProjects を未解決のままにして固定する（#341 と同じ手法）。
  // 検証はルート div の className（背景テーマ）と、ローディング文字色（白フラッシュ防止）。
  describe('PlayerScreen プレイヤーテーマ (#394)', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/')
    })
    afterEach(() => {
      window.history.pushState({}, '', '/')
    })

    // 実装（PlayerScreen.tsx）と一致させる必要のあるクラス名。ここで一度だけ定義して各テストで
    // 共有し、期待値の散在・二重管理を避ける。
    const DARK_ROOT_CLASSES = ['dark', 'bg-black']
    const LIGHT_ROOT_CLASS = 'bg-white'
    const DARK_LOADING_TEXT_CLASS = 'text-gray-400'
    const LIGHT_LOADING_TEXT_CLASS = 'text-gray-600'

    /**
     * ローディング状態のまま固定して PlayerScreen を描画し、ルート div を返す。
     * listProjects を未解決 Promise にすると loading=true のまま（#341 と同じ手法）。
     * playerDark は window.location.search 依存なので、呼ぶ前に pushState で ?theme= を
     * 設定しておくこと。#394 で PlayerScreen は isDark prop を持たない＝プレイヤーの見た目は
     * App の darkMode トグルに一切依存せず ?theme（既定 dark）だけで決まる。
     */
    function renderLoadingRoot(): HTMLElement {
      listProjectsMock.mockReturnValue(new Promise(() => {}))
      const { container } = render(
        <PlayerScreen projectName="theo-hayami" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      return container.firstElementChild as HTMLElement
    }

    it('11: theme 未指定（既定 dark）はルート div が dark/bg-black を持ち bg-white を持たない', () => {
      // ?theme= 無し（beforeEach で '/' に戻し済み）＝既定の dark。
      const root = renderLoadingRoot()
      for (const cls of DARK_ROOT_CLASSES) {
        expect(root.classList.contains(cls)).toBe(true)
      }
      expect(root.classList.contains(LIGHT_ROOT_CLASS)).toBe(false)
    })

    it('12: ?theme=light はルート div が bg-white を持ち dark/bg-black を持たない', () => {
      window.history.pushState({}, '', '?theme=light')
      const root = renderLoadingRoot()
      expect(root.classList.contains(LIGHT_ROOT_CLASS)).toBe(true)
      for (const cls of DARK_ROOT_CLASSES) {
        expect(root.classList.contains(cls)).toBe(false)
      }
    })

    it('13: 既定 dark のローディング文字は明色（text-gray-400）＝黒地に可読で白フラッシュにならない', () => {
      // ?theme= 無し（既定 dark）。読み込み中の文字はルート背景（黒）に乗るので、明色でなければ
      // 白地×暗文字の白フラッシュになる。dark 用の明色クラスが当たっていることを固定する。
      renderLoadingRoot()
      const loading = screen.getByText('読み込み中...')
      expect(loading.classList.contains(DARK_LOADING_TEXT_CLASS)).toBe(true)
    })

    it('14: ?theme=light のローディング文字は暗色（text-gray-600）＝白地に可読', () => {
      // light 側のローディング文字色。白地に乗るので暗色（text-gray-600）でなければ読めない
      // （dark 側は test13 が明色 text-gray-400 を固定）。文字色も playerDark で分岐することの担保。
      window.history.pushState({}, '', '?theme=light')
      renderLoadingRoot()
      const loading = screen.getByText('読み込み中...')
      expect(loading.classList.contains(LIGHT_LOADING_TEXT_CLASS)).toBe(true)
      expect(loading.classList.contains(DARK_LOADING_TEXT_CLASS)).toBe(false)
    })
  })

  // #404 フェーズ2: intermission.md 専用シーンの取得・parse effect。
  // fetch は `${assetBaseUrl}/scripts/intermission.md` を叩く（beforeEach の既定は 404）。
  // 404 は「未配置」として黙ってスキップし、それ以外の失敗（ネットワーク例外・不正 md）は
  // console.warn してゲーム自体は続行する（doctrine: 完全後方互換・オプトイン機能が壊れても
  // 本編再生を止めない）。
  describe('PlayerScreen intermission.md 専用シーン取得 (#404 フェーズ2)', () => {
    const ENTRY_MD = 'ENTRY_MD'
    const INTERMISSION_MD = 'INTERMISSION_MD'

    /** 通常の entry doc（parseMarkdown 呼び出し）を1シーン・イベント無しで解決する既定応答。 */
    function entryDoc() {
      return {
        engine: 'name-name',
        chapters: [
          {
            number: 1,
            title: 'c',
            hidden: false,
            default_bgm: null,
            scenes: [{ id: 's1', title: 's', view: 'TopDown', events: [] }],
          },
        ],
      }
    }

    function setupEntryProject(name: string) {
      listProjectsMock.mockResolvedValue([{ name, title: name, repo: `kako-jun/${name}` }])
      getContentsMock.mockResolvedValue({ path: 'script.md', sha: 's1', content: ENTRY_MD })
    }

    /** intermission.md の GET だけ差し替え、それ以外の raw fetch は既定どおり 404 にする。 */
    function mockIntermissionFetch(impl: (url: string) => Promise<Response> | Response): void {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/scripts/intermission.md')) {
          return impl(url)
        }
        return { ok: false, status: 404 } as Response
      })
    }

    async function waitForNovelPlayer(): Promise<void> {
      await waitFor(() => {
        expect(screen.getByTestId('novel-player')).toBeInTheDocument()
      })
    }

    it('#404-1: fetch が 200 + 有効な md を返すと、NovelPlayer に intermissionEvents（非空配列）・fade 値が渡る', async () => {
      setupEntryProject('friday-1930')
      parseMarkdownMock.mockImplementation(async (md: string) => {
        if (md === INTERMISSION_MD) {
          return {
            engine: 'name-name',
            chapters: [
              {
                number: 1,
                title: 'im',
                hidden: false,
                default_bgm: null,
                scenes: [
                  {
                    id: 'im',
                    title: 'im',
                    view: 'TopDown',
                    events: [{ Narration: { text: ['つづく'] } }],
                  },
                ],
              },
            ],
            background_fade_ms: 900,
            character_fade_ms: 800,
          }
        }
        return entryDoc()
      })
      mockIntermissionFetch(
        async () => ({ ok: true, status: 200, text: async () => INTERMISSION_MD }) as Response
      )

      render(
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitForNovelPlayer()
      await waitFor(() => {
        expect(lastNovelPlayerProps().intermissionEvents).not.toBeNull()
      })

      const props = lastNovelPlayerProps()
      expect(props.intermissionEvents).toEqual([{ Narration: { text: ['つづく'] } }])
      expect(props.intermissionBackgroundFadeMs).toBe(900)
      expect(props.intermissionCharacterFadeMs).toBe(800)
    })

    it('#404-2: fetch が 404 のとき、NovelPlayer への intermissionEvents は null のまま・console.warn は呼ばれない（未配置はエラー扱いにしない）', async () => {
      setupEntryProject('friday-1930')
      parseMarkdownMock.mockResolvedValue(entryDoc())
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // fetch は beforeEach の既定（404）のまま上書きしない。

      render(
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitForNovelPlayer()

      expect(lastNovelPlayerProps().intermissionEvents).toBeNull()
      const intermissionWarns = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('intermission.md')
      )
      expect(intermissionWarns.length).toBe(0)
    })

    it('#404-3: fetch がネットワーク例外で reject すると、console.warn が1回呼ばれゲーム自体は続行する', async () => {
      setupEntryProject('friday-1930')
      parseMarkdownMock.mockResolvedValue(entryDoc())
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockIntermissionFetch(async () => {
        throw new Error('network down')
      })

      render(
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitForNovelPlayer() // ゲーム自体は続行し NovelPlayer が描画される

      await waitFor(() => {
        const intermissionWarns = warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes('intermission.md')
        )
        expect(intermissionWarns.length).toBe(1)
      })
      expect(lastNovelPlayerProps().intermissionEvents).toBeNull()
    })

    it('#404-4: fetch は 200 だが parseMarkdown が例外を投げる（不正 md）と、console.warn が1回呼ばれゲーム自体は続行する', async () => {
      setupEntryProject('friday-1930')
      parseMarkdownMock.mockImplementation(async (md: string) => {
        if (md === INTERMISSION_MD) throw new Error('parse error: 不正な md')
        return entryDoc()
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockIntermissionFetch(
        async () => ({ ok: true, status: 200, text: async () => INTERMISSION_MD }) as Response
      )

      render(
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitForNovelPlayer()

      await waitFor(() => {
        const intermissionWarns = warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes('intermission.md')
        )
        expect(intermissionWarns.length).toBe(1)
      })
      expect(lastNovelPlayerProps().intermissionEvents).toBeNull()
    })

    it('#404-5: fetch/parse は成功するが flattenDocumentEvents の結果が空配列のとき、intermissionEvents は null のまま渡る', async () => {
      setupEntryProject('friday-1930')
      parseMarkdownMock.mockImplementation(async (md: string) => {
        if (md === INTERMISSION_MD) {
          return {
            engine: 'name-name',
            chapters: [
              {
                number: 1,
                title: 'im',
                hidden: false,
                default_bgm: null,
                scenes: [{ id: 'im', title: 'im', view: 'TopDown', events: [] }], // イベント無し
              },
            ],
          }
        }
        return entryDoc()
      })
      mockIntermissionFetch(
        async () => ({ ok: true, status: 200, text: async () => INTERMISSION_MD }) as Response
      )

      render(
        <PlayerScreen projectName="friday-1930" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitForNovelPlayer()

      // 空配列判定は非同期 fetch/parse 完了後に確定するため、他の prop が届いた後の最終状態で確認する。
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lastNovelPlayerProps().intermissionEvents).toBeNull()
    })

    it('#404-6: assetBaseUrl が変わる（projectName 切替）と intermissionEvents は一旦 null にリセットされ、旧 fetch が遅れて解決しても無視される（stale response 防止）', async () => {
      listProjectsMock.mockResolvedValue([
        { name: 'proj-a', title: 'A', repo: 'kako-jun/proj-a' },
        { name: 'proj-b', title: 'B', repo: 'kako-jun/proj-b' },
      ])
      getContentsMock.mockResolvedValue({ path: 'script.md', sha: 's1', content: ENTRY_MD })
      parseMarkdownMock.mockImplementation(async (md: string) => {
        if (md === 'STALE_INTERMISSION_MD') {
          return {
            engine: 'name-name',
            chapters: [
              {
                number: 1,
                title: 'im',
                hidden: false,
                default_bgm: null,
                scenes: [
                  {
                    id: 'im',
                    title: 'im',
                    view: 'TopDown',
                    events: [{ Narration: { text: ['stale'] } }],
                  },
                ],
              },
            ],
          }
        }
        return entryDoc()
      })

      const staleFetch = deferred<Response>()
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/projects/proj-a/') && url.endsWith('/scripts/intermission.md')) {
          return staleFetch.promise // proj-a 分は意図的に pending のまま保持する
        }
        return { ok: false, status: 404 } as Response // proj-b 分（新 assetBaseUrl）は未配置
      })

      const { rerender } = render(
        <PlayerScreen projectName="proj-a" apiBaseUrl="http://api.test" onBack={() => {}} />
      )
      await waitForNovelPlayer()
      expect(lastNovelPlayerProps().assetBaseUrl).toBe(
        'http://api.test/api/projects/proj-a/assets/raw'
      )

      // projectName 切替＝assetBaseUrl 変化。新 effect 先頭で intermissionEvents は null にリセットされる
      // （proj-a の fetch がまだ pending の状態で切り替える）。
      rerender(<PlayerScreen projectName="proj-b" apiBaseUrl="http://api.test" onBack={() => {}} />)
      await waitFor(() => {
        expect(lastNovelPlayerProps().assetBaseUrl).toBe(
          'http://api.test/api/projects/proj-b/assets/raw'
        )
      })
      expect(lastNovelPlayerProps().intermissionEvents).toBeNull()

      // 古い proj-a 分の fetch が遅れて成功で解決しても、cancelled フラグにより無視される。
      await act(async () => {
        staleFetch.resolve({
          ok: true,
          status: 200,
          text: async () => 'STALE_INTERMISSION_MD',
        } as Response)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(lastNovelPlayerProps().intermissionEvents).toBeNull()
    })
  })
})
