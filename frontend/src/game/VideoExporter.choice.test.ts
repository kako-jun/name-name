/**
 * 動画書き出し (#780): 選択肢の自動選択・終端、中止、停滞タイムアウト。
 * jsdom には captureStream / 実 MediaRecorder が無いため、最小のフェークで配線だけを観測する。
 * 時間はフェイクタイマーで進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportAbortedError, exportVideo } from './VideoExporter'
import { EXPORT_CHOICE_HOLD_MS, EXPORT_MAX_AUTO_CHOICES, EXPORT_POLL_MS } from './videoExportPolicy'

type Exp = Parameters<typeof exportVideo>[0]
type Option = { jump: string; locked: boolean }

function installMediaRecorder(stops: string[]) {
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true
    }
    state = 'inactive'
    ondataavailable: ((e: { data?: { size: number } }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: ((e: Event) => void) | null = null
    constructor(_s: unknown, _o: unknown) {}
    start() {
      this.state = 'recording'
    }
    stop() {
      stops.push('stop')
      this.state = 'inactive'
      this.onstop?.()
    }
  }
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder
}

function makeRenderer() {
  const h = {
    exportCalls: [] as boolean[],
    pending: null as { options: Option[] } | null,
    selected: [] as string[],
    positionCounter: 0,
    /** true なら本文が進む（署名が毎回変わる） */
    advancing: false,
    /** 選択後に次の選択肢を出し続ける（ループ用） */
    reoffer: null as Option[] | null,
    onSceneChange: null as ((id: string) => void) | null,
    onEnd: null as (() => void) | null,
    startFromGate: null as Promise<void> | null,
  }
  const renderer = {
    getCanvas: () => ({ captureStream: () => ({ getVideoTracks: () => [] }) }),
    getAudioManager: () => ({
      ensureContext: () => {},
      enableCapture: () => ({ getAudioTracks: () => [] }),
      disableCapture: () => {},
    }),
    getRenderResolution: () => 3,
    setRenderResolution: () => {},
    setExporting: (e: boolean) => h.exportCalls.push(e),
    setOnSceneChange: (cb: ((id: string) => void) | null) => {
      h.onSceneChange = cb
    },
    setOnEnd: (cb: (() => void) | null) => {
      h.onEnd = cb
    },
    takeOnEnd: () => null,
    takeOnSceneChange: () => null,
    startFrom: async () => {
      if (h.startFromGate) await h.startFromGate
      return { status: 'entered', sceneId: 'a' }
    },
    waitForBackgroundLoad: async () => {},
    isAutoMode: () => false,
    setAutoMode: () => {},
    prepareVideosForExport: async () => {},
    getPendingChoice: () => h.pending,
    selectPendingChoice: (jump: string) => {
      h.selected.push(jump)
      h.pending = h.reoffer ? { options: h.reoffer } : null
      return true
    },
    getSnapshot: () => ({
      sceneId: 'a',
      eventIndex: h.advancing ? h.positionCounter++ : 0,
      textIndex: 0,
      sentenceIndex: 0,
      flags: {},
    }),
  }
  return { h, renderer: renderer as unknown as Exp }
}

const base = { fps: 30, preRollMs: 0, postRollMs: 0 }

describe('exportVideo: 選択肢・中止・停滞 (#780)', () => {
  let savedMR: unknown
  let savedMS: unknown
  let stops: string[]
  beforeEach(() => {
    vi.useFakeTimers()
    savedMR = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
    savedMS = (globalThis as unknown as { MediaStream?: unknown }).MediaStream
    ;(globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
      constructor(_t?: unknown) {}
    }
    stops = []
    installMediaRecorder(stops)
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = savedMR
    ;(globalThis as unknown as { MediaStream?: unknown }).MediaStream = savedMS
  })

  /** 録画開始まで進める */
  async function startRecording(renderer: Exp, opts: Record<string, unknown>) {
    let result: Awaited<ReturnType<typeof exportVideo>> | undefined
    let error: unknown
    const p = exportVideo(renderer, { ...base, ...opts } as Parameters<typeof exportVideo>[1]).then(
      (r) => {
        result = r
      },
      (e) => {
        error = e
      }
    )
    await vi.advanceTimersByTimeAsync(1)
    return {
      p,
      get result() {
        return result
      },
      get error() {
        return error
      },
    }
  }

  it('末尾が選択肢のハブを開始=終了で書き出すと、選択肢を映してから終わる（範囲内の遷移先が無い）', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'hub',
      endSceneId: 'hub',
      sceneOrder: ['hub', 'x', 'y'],
    })
    h.pending = {
      options: [
        { jump: 'x', locked: false },
        { jump: 'y', locked: false },
      ],
    }
    // 保持時間の前はまだ録画中
    await vi.advanceTimersByTimeAsync(EXPORT_CHOICE_HOLD_MS - EXPORT_POLL_MS * 2)
    expect(run.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 4)
    await run.p
    expect(run.result?.endReason).toBe('choice-end')
    expect(h.selected).toEqual([])
    expect(h.exportCalls).toEqual([true, false])
  })

  it('範囲内へ向かう選択肢は、ロックされていない先頭のものを自動で選ぶ', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'c',
      sceneOrder: ['a', 'b', 'c', 'd'],
    })
    h.pending = {
      options: [
        { jump: 'd', locked: false }, // 範囲外
        { jump: 'b', locked: true }, // 範囲内だがロック
        { jump: 'c', locked: false }, // 採用
      ],
    }
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 2)
    expect(h.selected).toEqual(['c'])
    // 後始末（多重起動ガードを残さない）
    h.pending = null
    h.onEnd?.()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
  })

  it('自動選択が上限に達したら、範囲内の遷移先があっても終端にする（ループで終わらなくなるのを防ぐ）', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      stallTimeoutMs: 10 ** 9,
    })
    const loop = [{ jump: 'a', locked: false }]
    h.reoffer = loop
    h.pending = { options: loop }
    await vi.advanceTimersByTimeAsync(
      EXPORT_POLL_MS * (EXPORT_MAX_AUTO_CHOICES + 2) + EXPORT_CHOICE_HOLD_MS + EXPORT_POLL_MS * 2
    )
    await run.p
    expect(h.selected.length).toBe(EXPORT_MAX_AUTO_CHOICES)
    expect(run.result?.endReason).toBe('choice-end')
  })

  it('中止すると録画を止めて破棄し、ExportAbortedError で reject する（後始末も走る）', async () => {
    const { h, renderer } = makeRenderer()
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
    })
    ac.abort()
    await run.p
    expect(run.result).toBeUndefined()
    expect(run.error).toBeInstanceOf(ExportAbortedError)
    expect(stops).toEqual(['stop'])
    expect(h.exportCalls).toEqual([true, false])
    // 中止後に監視が残って選択を始めない
    h.pending = { options: [{ jump: 'b', locked: false }] }
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 4)
    expect(h.selected).toEqual([])
  })

  it('録画開始前（準備中）の中止も ExportAbortedError で reject し、録画は始まらない', async () => {
    const { h, renderer } = makeRenderer()
    let release!: () => void
    h.startFromGate = new Promise<void>((r) => {
      release = r
    })
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
    })
    ac.abort()
    release()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
    expect(run.error).toBeInstanceOf(ExportAbortedError)
    expect(stops).toEqual([])
    expect(h.exportCalls).toEqual([true, false])
  })

  it('開始前から中止済みのシグナルなら、副作用なしで reject する', async () => {
    const { h, renderer } = makeRenderer()
    const ac = new AbortController()
    ac.abort()
    await expect(
      exportVideo(renderer, { ...base, startSceneId: 'a', endSceneId: 'b', signal: ac.signal })
    ).rejects.toBeInstanceOf(ExportAbortedError)
    expect(h.exportCalls).toEqual([])
  })

  it('本文が一定時間進まなければタイムアウトで録画を終える', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      stallTimeoutMs: 5000,
    })
    await vi.advanceTimersByTimeAsync(4000)
    expect(run.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    await run.p
    expect(run.result?.endReason).toBe('stalled')
    expect(run.result?.endMessage).toContain('5秒')
    expect(h.exportCalls).toEqual([true, false])
  })

  it('本文が進んでいる間はタイムアウトしない', async () => {
    const { h, renderer } = makeRenderer()
    h.advancing = true
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      stallTimeoutMs: 5000,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run.result).toBeUndefined()
    h.onEnd?.()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
    expect(run.result?.endReason).toBe('story-end')
  })
})
