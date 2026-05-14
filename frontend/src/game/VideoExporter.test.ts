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
