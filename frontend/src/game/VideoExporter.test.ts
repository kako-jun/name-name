import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickSupportedMimeType, sanitizeFilename } from './VideoExporter'

describe('sanitizeFilename', () => {
  it('keeps alphanumerics, underscore, dot and hyphen as is', () => {
    expect(sanitizeFilename('a-b_c.1')).toBe('a-b_c.1')
  })

  it('replaces slashes and other unsafe characters with underscore, collapsing runs', () => {
    expect(sanitizeFilename('foo/bar baz:qux*?')).toBe('foo_bar_baz_qux_')
  })

  it('collapses non-ASCII runs to a single underscore (so JIS path on Windows is safe)', () => {
    expect(sanitizeFilename('日本語file')).toBe('_file')
  })

  it('collapses a trailing run of unsafe characters into a single underscore', () => {
    expect(sanitizeFilename('foo?')).toBe('foo_')
  })

  it('collapses a leading run of unsafe characters into a single underscore', () => {
    expect(sanitizeFilename('?foo')).toBe('_foo')
  })

  it('reduces all-unsafe input to a single underscore', () => {
    expect(sanitizeFilename('??##')).toBe('_')
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeFilename('')).toBe('')
  })
})

describe('pickSupportedMimeType', () => {
  const realMR = (
    globalThis as unknown as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } }
  ).MediaRecorder

  afterEach(() => {
    if (realMR) {
      ;(globalThis as unknown as { MediaRecorder: typeof realMR }).MediaRecorder = realMR
    } else {
      delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    }
  })

  it('returns null when MediaRecorder is not defined', () => {
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    expect(pickSupportedMimeType()).toBeNull()
  })

  it('returns the first supported codec from the candidate list', () => {
    const isTypeSupported = vi.fn((mime: string) => mime === 'video/webm;codecs=vp8,opus')
    ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = { isTypeSupported }
    expect(pickSupportedMimeType()).toBe('video/webm;codecs=vp8,opus')
    // vp9,opus が先頭なので最低 1 回は試される
    expect(isTypeSupported).toHaveBeenCalledWith('video/webm;codecs=vp9,opus')
  })

  it('prefers vp9 over vp8 when both supported', () => {
    const isTypeSupported = vi.fn(() => true)
    ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = { isTypeSupported }
    expect(pickSupportedMimeType()).toBe('video/webm;codecs=vp9,opus')
  })

  it('returns null when no candidate is supported', () => {
    const isTypeSupported = vi.fn(() => false)
    ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = { isTypeSupported }
    expect(pickSupportedMimeType()).toBeNull()
  })
})

describe('exportVideo state machine (smoke)', () => {
  // jsdom には canvas.captureStream も MediaStreamAudioDestinationNode も無いため、
  // 真の E2E は実機ブラウザに任せる。ここでは「開始前に MediaRecorder 未サポートだと
  // 即 throw する」ことだけを担保する。
  let saved: unknown
  beforeEach(() => {
    saved = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
  })
  afterEach(() => {
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = saved
  })

  it('throws when MediaRecorder is not available', async () => {
    const { exportVideo } = await import('./VideoExporter')
    const fakeRenderer = {
      getCanvas: () => null,
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => null,
        disableCapture: () => {},
      }),
      getCurrentSceneId: () => null,
      getAllSceneIds: () => [],
      setOnSceneChange: () => {},
      onEnd: () => {},
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
    } as unknown as Parameters<typeof exportVideo>[0]

    await expect(
      exportVideo(fakeRenderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/MediaRecorder is not supported/)
  })
})

describe('exportVideo resolution bump (#279)', () => {
  let savedMR: unknown
  beforeEach(() => {
    savedMR = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }
    }
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder
  })
  afterEach(() => {
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = savedMR
  })

  // enableCapture が null を返す失敗経路で、解像度 bump → restore の順序だけを検証する
  // （MediaRecorder 本体の完走をモックせずに #279-B の核だけを突く）。
  function makeRenderer(prev: number, calls: number[]) {
    return {
      getCanvas: () => ({ captureStream: () => ({ getVideoTracks: () => [] }) }),
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => null, // bump 後に失敗させて restore を観測する
        disableCapture: () => {},
      }),
      getRenderResolution: () => prev,
      setRenderResolution: (r: number) => {
        calls.push(r)
      },
      setOnSceneChange: () => {},
      setOnEnd: () => {},
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
    } as unknown as Parameters<typeof import('./VideoExporter').exportVideo>[0]
  }

  it('bumps to max(3, prev) before capture and restores prev on failure', async () => {
    const { exportVideo } = await import('./VideoExporter')
    const calls: number[] = []
    await expect(
      exportVideo(makeRenderer(2, calls), { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)
    expect(calls).toEqual([3, 2])
  })

  it('honors an explicit exportResolution and still restores prev', async () => {
    const { exportVideo } = await import('./VideoExporter')
    const calls: number[] = []
    await expect(
      exportVideo(makeRenderer(1, calls), {
        startSceneId: 'a',
        endSceneId: 'b',
        fps: 30,
        exportResolution: 5,
      })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)
    expect(calls).toEqual([5, 1])
  })

  // review S1: bump 後〜recorder 配線前の同期コンストラクタ（captureStream / MediaStream /
  // MediaRecorder）が throw しても、解像度・isExporting が巻き戻り、次の export がガードで
  // 詰まらないこと。jsdom には MediaStream が無いため、その経路で実際に throw する。
  it('restores resolution and clears the in-progress flag if a stream/recorder constructor throws', async () => {
    const { exportVideo } = await import('./VideoExporter')

    function rendererWithAudio(prev: number, calls: number[]) {
      return {
        getCanvas: () => ({ captureStream: () => ({ getVideoTracks: () => [] }) }),
        getAudioManager: () => ({
          ensureContext: () => {},
          enableCapture: () => ({ getAudioTracks: () => [] }), // audioStream 取得は成功させる
          disableCapture: () => {},
        }),
        getRenderResolution: () => prev,
        setRenderResolution: (r: number) => {
          calls.push(r)
        },
        setOnSceneChange: () => {},
        setOnEnd: () => {},
        takeOnEnd: () => null,
        takeOnSceneChange: () => null,
        jumpToScene: () => {},
        setAutoMode: () => {},
      } as unknown as Parameters<typeof exportVideo>[0]
    }

    const calls1: number[] = []
    await expect(
      exportVideo(rendererWithAudio(2, calls1), { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow()
    expect(calls1).toEqual([3, 2]) // bump → restore

    // isExporting がリセットされている（さもないと2回目が "already running" になる）
    const calls2: number[] = []
    await expect(
      exportVideo(rendererWithAudio(2, calls2), { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow()
    expect(calls2).toEqual([3, 2])
  })
})
