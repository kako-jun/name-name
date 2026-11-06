// FieldPlayer (#1135): 設定の組み立て・起動・dispose(二重起動なし)・ロードでの作り直し・エラー表示。
// loadFieldConfig / startFieldGame は PixiJS・fetch に依存するのでモックし、呼び出しの形を確認する。

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { FieldBuildResult } from '../field/fieldConfigFromDocs'
import type { StartFieldGameOptions } from '../field/startFieldGame'

const loadFieldConfigMock = vi.fn()
vi.mock('../field/fieldConfigFromDocs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../field/fieldConfigFromDocs')>()),
  loadFieldConfig: (...a: unknown[]) => loadFieldConfigMock(...a),
}))

const startFieldGameMock = vi.fn()
vi.mock('../field/startFieldGame', () => ({
  startFieldGame: (o: StartFieldGameOptions) => startFieldGameMock(o),
}))

import FieldPlayer from './FieldPlayer'

const npcEvents = { 'talk-1': [] }
const okResult = (warnings: string[] = []): FieldBuildResult =>
  ({
    ok: true,
    value: {
      config: { startScene: 'scene-a', tiltShift: 'on', warnings: [] },
      raw: {},
      npcEvents,
      needs: { menuContents: [] },
      missingScenes: [],
    },
    warnings,
  }) as unknown as FieldBuildResult

const loadAllDocs = vi.fn(() => Promise.resolve([]))
const resolveScene = vi.fn(() => Promise.resolve(null))
const entry = { sceneId: 'scene-a', x: 1, y: 2, facing: 'down' } as const
const element = (
  <FieldPlayer
    entry={entry}
    entryPath="script.md"
    docKey="demo"
    assetBaseUrl="http://api.test/api/projects/demo/assets/raw"
    loadAllDocs={loadAllDocs}
    resolveScene={resolveScene}
  />
)

/** startFieldGame が返す dispose を呼び出しごとに用意し、生きている数を数える */
let disposers: Array<ReturnType<typeof vi.fn>>
beforeEach(() => {
  disposers = []
  loadFieldConfigMock.mockReset()
  loadFieldConfigMock.mockResolvedValue(okResult())
  startFieldGameMock.mockReset()
  startFieldGameMock.mockImplementation(() => {
    const d = vi.fn()
    disposers.push(d)
    return Promise.resolve(d)
  })
  window.history.replaceState(null, '', '/play/demo')
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('FieldPlayer', () => {
  it('loadFieldConfig に entry・assetBase・deps を渡し、startFieldGame にステージ(mount=containHost)・scriptEvents・onLoadRequest を渡す', async () => {
    const { container } = render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    const [input, deps] = loadFieldConfigMock.mock.calls[0]
    expect(input).toMatchObject({
      entryPath: 'script.md',
      entry,
      assetBaseUrl: 'http://api.test/api/projects/demo/assets/raw',
      savedForms: {},
    })
    await deps.loadAllDocs()
    await deps.resolveScene('scene-b')
    expect(loadAllDocs).toHaveBeenCalledTimes(1)
    expect(resolveScene).toHaveBeenCalledWith('scene-b')
    expect(typeof deps.fetchJson).toBe('function')

    const opts = startFieldGameMock.mock.calls[0][0] as StartFieldGameOptions
    const stage = container.querySelector('.field-play-stage')
    expect(opts.mount).toBe(stage)
    expect(opts.containHost).toBe(stage)
    expect(opts.docKey).toBe('demo')
    expect(opts.search).toBe('')
    expect(opts.scriptEvents).toBe(npcEvents)
    expect(typeof opts.onLoadRequest).toBe('function')
    // 開発ツールバー・hud は渡さない
    expect(opts.devToolbar).toBeUndefined()
    expect(opts.hud).toBeUndefined()
    // チルトシフトは設定のまま(常時オン)
    expect(opts.config.tiltShift).toBe('on')
  })

  it('?debug_tilt=off のときだけ tiltShift を消す', async () => {
    window.history.replaceState(null, '', '/play/demo?debug_tilt=off')
    render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    expect((startFieldGameMock.mock.calls[0][0] as StartFieldGameOptions).config.tiltShift).toBe(
      undefined
    )
  })

  it('?resume= はマウント時の search としてそのまま渡る', async () => {
    window.history.replaceState(null, '', '/play/demo?resume=0')
    render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    expect((startFieldGameMock.mock.calls[0][0] as StartFieldGameOptions).search).toBe('?resume=0')
  })

  it('警告は console.warn のみで画面に出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadFieldConfigMock.mockResolvedValue(okResult(['歩行絵が足りません']))
    render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('歩行絵が足りません'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('設定が組めないときは画面内にエラーを出し、startFieldGame は呼ばない', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadFieldConfigMock.mockResolvedValue({
      ok: false,
      error: '人物の形態の目録を取得できません',
      warnings: [],
    })
    render(element)
    expect(await screen.findByRole('alert')).toHaveTextContent('人物の形態の目録を取得できません')
    expect(startFieldGameMock).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
  })

  it('startFieldGame が落ちたら画面内にエラーを出す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    startFieldGameMock.mockRejectedValue(new Error('画像が読めません'))
    render(element)
    expect(await screen.findByRole('alert')).toHaveTextContent('画像が読めません')
  })

  it('アンマウントで dispose する', async () => {
    const { unmount } = render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    expect(disposers[0]).not.toHaveBeenCalled()
    unmount()
    expect(disposers[0]).toHaveBeenCalledTimes(1)
  })

  it('StrictMode の二重 effect でも生きている起動は 1 つだけ', async () => {
    const { unmount } = render(<StrictMode>{element}</StrictMode>)
    await waitFor(() => expect(startFieldGameMock.mock.calls.length).toBeGreaterThanOrEqual(1))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const alive = disposers.filter((d) => d.mock.calls.length === 0)
    expect(alive).toHaveLength(1)
    unmount()
    expect(disposers.every((d) => d.mock.calls.length === 1)).toBe(true)
  })

  it('起動が終わる前にアンマウントしたら、起動完了後すぐ dispose する', async () => {
    let resolveStart: (d: () => void) => void = () => {}
    const d = vi.fn()
    startFieldGameMock.mockImplementation(() => new Promise<() => void>((r) => (resolveStart = r)))
    const { unmount } = render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    unmount()
    expect(d).not.toHaveBeenCalled()
    await act(async () => {
      resolveStart(d)
    })
    expect(d).toHaveBeenCalledTimes(1)
  })

  it('古い世代の onLoadRequest は何もしない', async () => {
    render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    const first = startFieldGameMock.mock.calls[0][0] as StartFieldGameOptions
    await act(async () => {
      first.onLoadRequest?.(1)
    })
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(2))
    await act(async () => {
      first.onLoadRequest?.(2)
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(startFieldGameMock).toHaveBeenCalledTimes(2)
    expect(loadFieldConfigMock).toHaveBeenCalledTimes(2)
  })

  it('読み込み中は案内を出し、起動完了・エラーで消える。ロードの作り直し中にも出る', async () => {
    let resolveStart: (d: () => void) => void = () => {}
    startFieldGameMock.mockImplementationOnce(
      () => new Promise<() => void>((r) => (resolveStart = r))
    )
    render(element)
    expect(screen.getByRole('status')).toHaveTextContent('読み込み中')
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveStart(vi.fn())
    })
    expect(screen.queryByRole('status')).toBeNull()
    // ロード(作り直し)中
    let resolve2: (d: () => void) => void = () => {}
    startFieldGameMock.mockImplementationOnce(() => new Promise<() => void>((r) => (resolve2 = r)))
    const first = startFieldGameMock.mock.calls[0][0] as StartFieldGameOptions
    await act(async () => {
      first.onLoadRequest?.(0)
    })
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toBeInTheDocument()
    await act(async () => {
      resolve2(vi.fn())
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('エラー時も読み込み中の案内は消える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    loadFieldConfigMock.mockResolvedValue({ ok: false, error: 'x', warnings: [] })
    render(element)
    await screen.findByRole('alert')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('onLoadRequest で前回を dispose して ?resume=<slot> の復元経路で作り直す(URL は書き換えない)', async () => {
    render(element)
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(1))
    const first = startFieldGameMock.mock.calls[0][0] as StartFieldGameOptions
    await act(async () => {
      first.onLoadRequest?.(2)
    })
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(2))
    expect(disposers[0]).toHaveBeenCalledTimes(1)
    expect(disposers[1]).not.toHaveBeenCalled()
    const second = startFieldGameMock.mock.calls[1][0] as StartFieldGameOptions
    expect(second.search).toBe('?resume=2')
    expect(second.mount).toBe(first.mount)
    expect(window.location.search).toBe('')
    // 作り直しの設定も saveForms を同じ search から読み直す
    expect(loadFieldConfigMock).toHaveBeenCalledTimes(2)
    // さらにもう一度ロードしても、生きているのは 1 つ
    await act(async () => {
      second.onLoadRequest?.(0)
    })
    await waitFor(() => expect(startFieldGameMock).toHaveBeenCalledTimes(3))
    expect(disposers.filter((d) => d.mock.calls.length === 0)).toHaveLength(1)
  })
})
