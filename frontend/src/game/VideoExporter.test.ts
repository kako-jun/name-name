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
      setExporting: () => {},
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
        setExporting: () => {},
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

describe('exportVideo setExporting 復元（#350 F 群）', () => {
  // VideoExporter は録画開始で setExporting(true)・終了/失敗/例外の全経路で setExporting(false) を
  // 必ず呼び、SeekBar の書き出し抑制を確実に巻き戻す。ここでは setExporting の呼び出し列だけを
  // 観測し、Pixi 実描画や実 MediaRecorder の挙動には踏み込まない（jsdom 観測可能域に限定）。
  let savedMR: unknown
  let savedMS: unknown
  let savedDpr: number
  beforeEach(() => {
    savedMR = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    savedMS = (globalThis as unknown as { MediaStream?: unknown }).MediaStream
    // MediaStream は jsdom に無い。new MediaStream([...tracks]) を通すため最小スタブを置く。
    class FakeMediaStream {
      constructor(_tracks?: unknown) {}
    }
    ;(globalThis as unknown as { MediaStream?: unknown }).MediaStream = FakeMediaStream
    savedDpr = window.devicePixelRatio
  })
  afterEach(() => {
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = savedMR
    ;(globalThis as unknown as { MediaStream?: unknown }).MediaStream = savedMS
    window.devicePixelRatio = savedDpr
  })

  /** 録画完走をシミュレートできる制御可能な MediaRecorder。start で recording・stop で onstop 発火。 */
  function installRecordableMediaRecorder(onStarted: () => void) {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }
      state = 'inactive'
      ondataavailable: ((e: { data?: { size: number } }) => void) | null = null
      onstop: (() => void) | null = null
      onerror: ((e: Event) => void) | null = null
      constructor(_stream: unknown, _opts: unknown) {}
      start(_timeslice?: number) {
        this.state = 'recording'
        onStarted()
      }
      stop() {
        this.state = 'inactive'
        this.onstop?.()
      }
    }
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder
  }

  /** 成功経路用レンダラ。onEnd を捕捉し、enableCapture/captureStream を成功させる。 */
  function successRenderer(exportCalls: boolean[], captureOnEnd: (cb: () => void) => void) {
    return {
      getCanvas: () => ({ captureStream: () => ({ getVideoTracks: () => [] }) }),
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => ({ getAudioTracks: () => [] }),
        disableCapture: () => {},
      }),
      getRenderResolution: () => 3,
      setRenderResolution: () => {},
      setExporting: (e: boolean) => {
        exportCalls.push(e)
      },
      setOnSceneChange: () => {},
      setOnEnd: (cb: () => void) => captureOnEnd(cb),
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
      prepareVideosForExport: async () => {},
    } as unknown as Parameters<typeof import('./VideoExporter').exportVideo>[0]
  }

  // F-1: 正常完走で setExporting(true)→…→(false)。最終 false で、true→false の順を固定する。
  it('F-1: 録画完走で setExporting(true) → 最終 (false) を呼ぶ（true→false 順）', async () => {
    const { exportVideo } = await import('./VideoExporter')
    let started!: () => void
    const startedPromise = new Promise<void>((res) => {
      started = res
    })
    installRecordableMediaRecorder(() => started())

    const exportCalls: boolean[] = []
    let onEnd: (() => void) | null = null
    const renderer = successRenderer(exportCalls, (cb) => {
      onEnd = cb
    })

    const p = exportVideo(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      fps: 30,
      preRollMs: 0,
      postRollMs: 0,
    })
    await startedPromise // recorder.start まで到達＝録画開始済み
    onEnd!() // 全イベント完走 → finalize → stop → cleanup（setExporting(false)）
    await p
    expect(exportCalls).toEqual([true, false])
  })

  // F-2: audioStream 取得失敗（enableCapture→null）でも throw 前に setExporting(false) を呼び最終 false。
  it('F-2: audioStream 失敗時も throw 前に setExporting(false) を呼び最終 false', async () => {
    const { exportVideo } = await import('./VideoExporter')
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }
    }
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder

    const exportCalls: boolean[] = []
    const renderer = {
      getCanvas: () => ({ captureStream: () => ({ getVideoTracks: () => [] }) }),
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => null, // 失敗させる
        disableCapture: () => {},
      }),
      getRenderResolution: () => 3,
      setRenderResolution: () => {},
      setExporting: (e: boolean) => {
        exportCalls.push(e)
      },
      setOnSceneChange: () => {},
      setOnEnd: () => {},
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
    } as unknown as Parameters<typeof exportVideo>[0]

    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)
    expect(exportCalls).toEqual([true, false])
  })

  // F-3: recorder コンストラクタ throw でも catch 内 setExporting(false) で復元。2 回目 export でも対が揃う。
  it('F-3: recorder コンストラクタ throw でも setExporting(false) で復元し、2 回目も true/false 対が揃う', async () => {
    const { exportVideo } = await import('./VideoExporter')
    class ThrowingMediaRecorder {
      static isTypeSupported() {
        return true
      }
      constructor() {
        throw new Error('boom: recorder constructor failed')
      }
    }
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = ThrowingMediaRecorder

    function rendererWithAudio(exportCalls: boolean[]) {
      return {
        getCanvas: () => ({ captureStream: () => ({ getVideoTracks: () => [] }) }),
        getAudioManager: () => ({
          ensureContext: () => {},
          enableCapture: () => ({ getAudioTracks: () => [] }), // audioStream は成功
          disableCapture: () => {},
        }),
        getRenderResolution: () => 3,
        setRenderResolution: () => {},
        setExporting: (e: boolean) => {
          exportCalls.push(e)
        },
        setOnSceneChange: () => {},
        setOnEnd: () => {},
        takeOnEnd: () => null,
        takeOnSceneChange: () => null,
        jumpToScene: () => {},
        setAutoMode: () => {},
      } as unknown as Parameters<typeof exportVideo>[0]
    }

    const calls1: boolean[] = []
    await expect(
      exportVideo(rendererWithAudio(calls1), { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/boom/)
    expect(calls1).toEqual([true, false])

    // isExporting が戻っていれば 2 回目も同じ対を踏む（"already running" にならない）。
    const calls2: boolean[] = []
    await expect(
      exportVideo(rendererWithAudio(calls2), { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/boom/)
    expect(calls2).toEqual([true, false])
  })

  // F-4 (#455 セルフレビュー should対応): resolveCleanupResolution の3箇所目の呼び出し元
  // （正常 cleanup、`VideoExporter.ts` cleanup 内）を、F-1 と同じ
  // onEnd()→finalize→recorder.onstop→cleanup() の完走フローで直接踏み、実測幅からの
  // 再計算値が復元されることを確認する。F-1 の canvas mock には getBoundingClientRect が無く
  // フォールバック分岐しか踏めていなかった（セルフレビュー指摘）ため、ここでは
  // getBoundingClientRect あり・getScreenSize が displayWidth と異なる論理幅を返す
  // resize-aware な canvas/renderer を使う（#455 cleanup 解像度復元テスト群と同じ構図）。
  it('F-4: 正常完走のcleanupでも実測幅から再計算した解像度が復元される（#455 resolveCleanupResolution 正常系）', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2

    let started!: () => void
    const startedPromise = new Promise<void>((res) => {
      started = res
    })
    installRecordableMediaRecorder(() => started())

    const resolutionCalls: number[] = []
    let onEnd: (() => void) | null = null
    // prevResolution=2・displayWidth=1600・screenWidth=800・dpr=2 は #455 cleanup 解像度復元
    // テスト群と同じ組み合わせ。実測ベースの再計算値は 2*(1600/800)=4 になり、
    // prevResolution(2) とは異なる値（=リサイズを取りこぼしていない）ことを確認できる。
    const renderer = {
      getCanvas: () => ({
        captureStream: () => ({ getVideoTracks: () => [] }),
        getBoundingClientRect: () => ({ width: 1600 }),
      }),
      getScreenSize: () => ({ width: 800, height: 450 }),
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => ({ getAudioTracks: () => [] }),
        disableCapture: () => {},
      }),
      getRenderResolution: () => 2,
      setRenderResolution: (r: number) => {
        resolutionCalls.push(r)
      },
      setExporting: () => {},
      setOnSceneChange: () => {},
      setOnEnd: (cb: () => void) => {
        onEnd = cb
      },
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
      prepareVideosForExport: async () => {},
    } as unknown as Parameters<typeof exportVideo>[0]

    const p = exportVideo(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      fps: 30,
      preRollMs: 0,
      postRollMs: 0,
    })
    await startedPromise // recorder.start まで到達＝録画開始済み
    onEnd!() // 全イベント完走 → finalize → stop → cleanup（正常系の resolveCleanupResolution）
    await p

    // resolutionCalls[0] は bump（max(3, prev=2)）、[1] が正常 cleanup での復元値。
    expect(resolutionCalls).toEqual([3, 4])
    expect(resolutionCalls[1]).not.toBe(2) // prevResolution そのままではない（#455 本題の直接検証）
  })
})

describe('exportVideo cleanup 解像度復元 (#455 resolveCleanupResolution)', () => {
  // resolveCleanupResolution 自体は VideoExporter.ts 内の非 export ヘルパーなので、
  // exportVideo の cleanup 経路（`!audioStream` 早期throw）を通して間接的に検証する。
  // enableCapture が null を返す経路は #279 グループの既存テストと同じく、bump → cleanup を
  // 最短で踏める（recorder 完走をモックしなくて済む）ため、解像度復元ロジックの検証に使う。
  let savedMR: unknown
  let savedDpr: number
  beforeEach(() => {
    savedMR = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }
    }
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder
    savedDpr = window.devicePixelRatio
  })
  afterEach(() => {
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = savedMR
    window.devicePixelRatio = savedDpr
  })

  /**
   * `getBoundingClientRect` を持つ「本物らしい」canvas と `getScreenSize()` を実装した
   * renderer モックを作る。`displayWidth === undefined` なら `getBoundingClientRect` 自体を
   * 生やさない（既存 #279 系テストの canvas モック形を再現し、フォールバックを確認する用）。
   * `canvasGoneAtCleanup` を true にすると、2 回目以降の `getCanvas()`（cleanup 内の
   * resolveCleanupResolution から呼ばれる分）が null を返す（unmount 済み等を模擬）。
   */
  function makeResizeAwareRenderer(opts: {
    prevResolution: number
    displayWidth?: number
    screenWidth?: number
    screenHeight?: number
    canvasGoneAtCleanup?: boolean
    calls: number[]
  }) {
    const {
      prevResolution,
      displayWidth,
      screenWidth = 800,
      screenHeight = 450,
      canvasGoneAtCleanup = false,
      calls,
    } = opts
    let getCanvasCallCount = 0
    const canvasObj: Record<string, unknown> = {
      captureStream: () => ({ getVideoTracks: () => [] }),
    }
    if (displayWidth !== undefined) {
      canvasObj.getBoundingClientRect = () => ({ width: displayWidth })
    }
    return {
      getCanvas: () => {
        getCanvasCallCount += 1
        if (canvasGoneAtCleanup && getCanvasCallCount > 1) return null
        return canvasObj
      },
      getScreenSize: () => ({ width: screenWidth, height: screenHeight }),
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => null, // 早期失敗させ cleanup を即座に踏む
        disableCapture: () => {},
      }),
      getRenderResolution: () => prevResolution,
      setRenderResolution: (r: number) => {
        calls.push(r)
      },
      setExporting: () => {},
      setOnSceneChange: () => {},
      setOnEnd: () => {},
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
    } as unknown as Parameters<typeof import('./VideoExporter').exportVideo>[0]
  }

  // 核心: 書き出し中にリサイズが起きたケース（canvas実測幅≠書き出し開始時の論理幅相当）を
  // 模擬する。screenWidth=800, dpr=2 のとき「リサイズなし」なら実測幅は800付近になるはずだが、
  // ここでは1600（2倍に引き伸ばされた状態）を与える。復元値が prevResolution(2) のままでは
  // なく、実測値ベースの再計算値 computeDynamicRenderResolution(1600,800,450,2)=4 になることを
  // 確認する（#455 本題：修正前は prevResolution=2 に固着していた）。
  it('書き出し中にリサイズが起きたケース: 復元値がprevResolutionでなく実測幅からの再計算値になる', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2
    const calls: number[] = []
    const renderer = makeResizeAwareRenderer({ prevResolution: 2, displayWidth: 1600, calls })

    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)

    // calls[0] は bump（max(3, prev)）、calls[1] が cleanup での復元値。
    expect(calls[1]).toBe(4)
    expect(calls[1]).not.toBe(2) // prevResolution そのままではない
  })

  it('getBoundingClientRect().width === 0（レイアウト未確定）なら prevResolution にフォールバックする', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2
    const calls: number[] = []
    const renderer = makeResizeAwareRenderer({ prevResolution: 2, displayWidth: 0, calls })

    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)

    expect(calls[1]).toBe(2) // prevResolution のまま
  })

  it('canvasモックが getBoundingClientRect を持たない（既存テストダブルの形）場合も prevResolution にフォールバックする', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2
    const calls: number[] = []
    // displayWidth を渡さない = getBoundingClientRect 自体を生やさない
    const renderer = makeResizeAwareRenderer({ prevResolution: 2, calls })

    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)

    expect(calls[1]).toBe(2) // prevResolution のまま（既存 #279 系テストが素通りしていた経路）
  })

  it('getCanvas() が cleanup 時に null を返す（unmount 済み等）場合も prevResolution にフォールバックする', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2
    const calls: number[] = []
    const renderer = makeResizeAwareRenderer({
      prevResolution: 2,
      displayWidth: 1600, // 値があっても canvas 自体が無ければ使われない
      canvasGoneAtCleanup: true,
      calls,
    })

    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)

    expect(calls[1]).toBe(2) // prevResolution のまま
  })

  // 非回帰確認: 書き出し中にリサイズが一切起きなかった通常ケースでは、実測幅が論理幅と
  // 同じ引き伸ばし倍率のままなので、再計算値は prevResolution と実質一致する。
  it('リサイズが起きなかった通常ケース: 再計算値がprevResolutionと実質一致する（非回帰）', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2
    const calls: number[] = []
    // displayWidth === screenWidth なので引き伸ばし倍率=1、dpr=2 → 再計算値も2でprevと一致
    const renderer = makeResizeAwareRenderer({ prevResolution: 2, displayWidth: 800, calls })

    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow(/AudioManager could not provide MediaStream/)

    expect(calls[1]).toBe(2)
  })

  // 配線確認その2: recorder コンストラクタ throw 経路（#279 review S1 と同じ throw 元）でも
  // resolveCleanupResolution が実測値から再計算する。3箇所ある呼び出し元のうち
  // `!audioStream` 以外の早期throw経路でも同じロジックを通ることを確認する。
  it('recorder構築失敗の早期throw経路でも実測幅から再計算した値で復元する', async () => {
    const { exportVideo } = await import('./VideoExporter')
    window.devicePixelRatio = 2
    const calls: number[] = []
    const renderer = {
      getCanvas: () => ({
        captureStream: () => ({ getVideoTracks: () => [] }),
        getBoundingClientRect: () => ({ width: 1600 }),
      }),
      getScreenSize: () => ({ width: 800, height: 450 }),
      getAudioManager: () => ({
        ensureContext: () => {},
        enableCapture: () => ({ getAudioTracks: () => [] }), // audioStream 取得は成功させる
        disableCapture: () => {},
      }),
      getRenderResolution: () => 2,
      setRenderResolution: (r: number) => {
        calls.push(r)
      },
      setExporting: () => {},
      setOnSceneChange: () => {},
      setOnEnd: () => {},
      takeOnEnd: () => null,
      takeOnSceneChange: () => null,
      jumpToScene: () => {},
      setAutoMode: () => {},
    } as unknown as Parameters<typeof exportVideo>[0]

    // jsdom には MediaStream が無いため new MediaStream(...) が ReferenceError で throw する
    // （#279 review S1 の既存テストと同じ前提）。
    await expect(
      exportVideo(renderer, { startSceneId: 'a', endSceneId: 'b', fps: 30 })
    ).rejects.toThrow()

    expect(calls).toEqual([3, 4]) // bump(max(3,2)) → cleanupは実測ベースの再計算値
  })
})

describe('NovelRenderer#getScreenSize (#455)', () => {
  // resolveCleanupResolution が「論理サイズの分母」として使う getScreenSize() が、
  // 動画書き出しに絡まない通常のアスペクト比別コンストラクタでも正しい値を返すことを確認する。
  // 駆動方式は NovelRenderer.splitLayoutScrim.test.ts の
  // 「NovelRenderer コンストラクタの aspectRatio 解決」ブロックと同形（init() 不要）。
  it('16:9（デフォルト）: {width:800, height:450} を返す', async () => {
    const { NovelRenderer } = await import('./NovelRenderer')
    const renderer = new NovelRenderer()
    expect(renderer.getScreenSize()).toEqual({ width: 800, height: 450 })
  })

  it('9:16（縦長）: {width:450, height:800} を返す', async () => {
    const { NovelRenderer } = await import('./NovelRenderer')
    const renderer = new NovelRenderer({ aspectRatio: '9:16' })
    expect(renderer.getScreenSize()).toEqual({ width: 450, height: 800 })
  })

  it('4:3: {width:800, height:600} を返す', async () => {
    const { NovelRenderer } = await import('./NovelRenderer')
    const renderer = new NovelRenderer({ aspectRatio: '4:3' })
    expect(renderer.getScreenSize()).toEqual({ width: 800, height: 600 })
  })

  it('返り値は screenWidth/screenHeight のスナップショットであり、後から呼んでも同じ値を返す（construct時に固定・以後不変）', async () => {
    const { NovelRenderer } = await import('./NovelRenderer')
    const renderer = new NovelRenderer({ aspectRatio: '2:1' })
    const first = renderer.getScreenSize()
    const second = renderer.getScreenSize()
    expect(first).toEqual({ width: 900, height: 450 })
    expect(second).toEqual({ width: 900, height: 450 })
  })
})
