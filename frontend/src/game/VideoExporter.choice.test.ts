/**
 * 動画書き出し (#780): 選択肢の自動選択・終端、中止、停滞タイムアウト。
 * jsdom には captureStream / 実 MediaRecorder が無いため、最小のフェークで配線だけを観測する。
 * 時間はフェイクタイマーで進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportAbortedError, exportVideo } from './VideoExporter'
import {
  EXPORT_AUTO_CHOICE_DISPLAY_MS,
  EXPORT_CHOICE_HOLD_MS,
  EXPORT_MAX_AUTO_CHOICES,
  EXPORT_POLL_MS,
} from './videoExportPolicy'

type Exp = Parameters<typeof exportVideo>[0]
type Option = { jump: string; locked: boolean }

const recorders: Array<{ state: string; onstop: (() => void) | null }> = []

function installMediaRecorder(stops: string[]) {
  recorders.length = 0
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true
    }
    state = 'inactive'
    ondataavailable: ((e: { data?: { size: number } }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: ((e: Event) => void) | null = null
    constructor(_s: unknown, _o: unknown) {
      recorders.push(this)
    }
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
    /** 選択肢の位置とシーン（辺の記憶のキー） */
    pendingKey: 'k:0',
    pendingScene: 'a' as string | null,
    /** true なら選択のたびに位置が変わる（毎回別の選択肢に見える） */
    uniqueKeys: false,
    keySeq: 0,
    /** false を返すと、書き出し後始末がレンダラに触らない */
    ready: true,
    cancelPendingEntryCalls: 0,
    selected: [] as string[],
    positionCounter: 0,
    /** true なら本文が進む（署名が毎回変わる） */
    advancing: false,
    frameRequests: 0,
    /** `[待機: N]` で待っている ms（待っていなければ null） */
    waitMs: null as number | null,
    /** 終わりのある動画の再生中 */
    videoPlaying: false,
    /** selectPendingChoice の結果（false なら受け付けない） */
    acceptSelect: true,
    /** 選択時に呼ぶ（シーン遷移のシミュレーション用） */
    onSelect: null as ((jump: string) => void) | null,
    backgroundGate: null as Promise<void> | null,
    /** 選択後に次の選択肢を出し続ける（ループ用） */
    reoffer: null as Option[] | null,
    onSceneChange: null as ((id: string) => void) | null,
    onEnd: null as (() => void) | null,
    startFromGate: null as Promise<void> | null,
  }
  const renderer = {
    getCanvas: () => ({
      captureStream: () => ({ getVideoTracks: () => [{ requestFrame: () => h.frameRequests++ }] }),
    }),
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
    waitForBackgroundLoad: async () => {
      if (h.backgroundGate) await h.backgroundGate
    },
    isAutoMode: () => false,
    setAutoMode: () => {},
    prepareVideosForExport: async () => {},
    isReady: () => h.ready,
    cancelPendingEntry: () => {
      h.cancelPendingEntryCalls++
    },
    getPendingChoice: () =>
      h.pending ? { key: h.pendingKey, sceneId: h.pendingScene, ...h.pending } : null,
    selectPendingChoice: (jump: string) => {
      if (!h.acceptSelect) return false
      h.selected.push(jump)
      h.pending = h.reoffer ? { options: h.reoffer } : null
      if (h.uniqueKeys) h.pendingKey = `k:${++h.keySeq}`
      h.onSelect?.(jump)
      return true
    },
    getExportProgress: () => ({
      sceneId: 'a',
      eventIndex: h.advancing ? h.positionCounter++ : 0,
      textIndex: 0,
      sentenceIndex: 0,
      waitMs: h.waitMs,
      videoPlaying: h.videoPlaying,
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
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    })
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
    // 選ぶ前に選択肢を映す時間が経つまでは選ばない
    await vi.advanceTimersByTimeAsync(EXPORT_AUTO_CHOICE_DISPLAY_MS - EXPORT_POLL_MS * 2)
    expect(h.selected).toEqual([])
    await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 4)
    expect(h.selected).toEqual(['c'])
    // 後始末（多重起動ガードを残さない）
    h.pending = null
    h.onEnd?.()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
  })

  it('ハブ型: 毎回先頭を選び続けず、未訪問のルートを順に回って終了シーンで終わる', async () => {
    const { h, renderer } = makeRenderer()
    const hubOptions = [
      { jump: 'r1', locked: false },
      { jump: 'r2', locked: false },
      { jump: 'r3', locked: false },
    ]
    // 各ルートに入って（onSceneChange）ハブへ戻る。ハブは再び選択肢を出す。
    h.onSelect = (jump) => {
      h.onSceneChange?.(jump)
      h.onSceneChange?.('h')
      h.pending = { options: hubOptions }
    }
    const run = await startRecording(renderer, {
      startSceneId: 'h',
      endSceneId: 'r3',
      sceneOrder: ['h', 'r1', 'r2', 'r3'],
    })
    h.pending = { options: hubOptions }
    await vi.advanceTimersByTimeAsync((EXPORT_AUTO_CHOICE_DISPLAY_MS + EXPORT_POLL_MS * 2) * 6)
    await run.p
    expect(h.selected).toEqual(['r1', 'r2', 'r3'])
    expect(run.result?.endReason).toBe('scene-end')
  })

  it('同じ位置の選択肢で範囲内の辺をすべて選び終えたら、選択肢を映して終端にする', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
    })
    const back = [{ jump: 'a', locked: false }]
    h.reoffer = back // 選んでも同じ選択肢（同じ位置）に戻ってくる
    h.pending = { options: back }
    await vi.advanceTimersByTimeAsync(
      EXPORT_AUTO_CHOICE_DISPLAY_MS + EXPORT_CHOICE_HOLD_MS + EXPORT_POLL_MS * 6
    )
    await run.p
    expect(h.selected).toEqual(['a'])
    expect(run.result?.endReason).toBe('choice-end')
  })

  it('サブメニュー構成（h[m] → m[x,y] → 各ルート末尾で h へ）で x と y の両方を録る', async () => {
    const { h, renderer } = makeRenderer()
    const hubChoice = [{ jump: 'm', locked: false }]
    const menuChoice = [
      { jump: 'x', locked: false },
      { jump: 'y', locked: false },
    ]
    const show = (key: string, scene: string, options: Option[]) => {
      h.pendingKey = key
      h.pendingScene = scene
      h.pending = { options }
    }
    h.onSelect = (jump) => {
      h.onSceneChange?.(jump)
      if (jump === 'm') show('m:1', 'm', menuChoice)
      else {
        // x / y の末尾は [ジャンプ: h]。y が終了シーンなので、y を録り終えたら h に戻って終わる。
        h.onSceneChange?.('h')
        show('h:1', 'h', hubChoice)
      }
    }
    const run = await startRecording(renderer, {
      startSceneId: 'h',
      endSceneId: 'y',
      sceneOrder: ['h', 'm', 'x', 'y'],
    })
    show('h:1', 'h', hubChoice)
    await vi.advanceTimersByTimeAsync((EXPORT_AUTO_CHOICE_DISPLAY_MS + EXPORT_POLL_MS * 2) * 8)
    await run.p
    expect(h.selected).toEqual(['m', 'x', 'm', 'y'])
    expect(run.result?.endReason).toBe('scene-end')
  })

  it('選択肢を経由しない遷移（[ジャンプ:]）を挟む構成で、a と b の両方を録る', async () => {
    const { h, renderer } = makeRenderer()
    const hubChoice = [{ jump: 'r', locked: false }]
    const sChoice = [
      { jump: 'a', locked: false },
      { jump: 'b', locked: false },
    ]
    const show = (key: string, scene: string, options: Option[]) => {
      h.pendingKey = key
      h.pendingScene = scene
      h.pending = { options }
    }
    h.onSelect = (jump) => {
      h.onSceneChange?.(jump)
      if (jump === 'r') {
        // r に選択肢は無く、末尾 [ジャンプ: s]
        h.onSceneChange?.('s')
        show('c-s', 's', sChoice)
      } else {
        // a / b の末尾は [ジャンプ: h]。b が終了シーンなので、b を録り終えたら h に戻って終わる。
        h.onSceneChange?.('h')
        show('c-h', 'h', hubChoice)
      }
    }
    const run = await startRecording(renderer, {
      startSceneId: 'h',
      endSceneId: 'b',
      sceneOrder: ['h', 'r', 's', 'a', 'b'],
    })
    show('c-h', 'h', hubChoice)
    await vi.advanceTimersByTimeAsync((EXPORT_AUTO_CHOICE_DISPLAY_MS + EXPORT_POLL_MS * 2) * 8)
    await run.p
    expect(h.selected).toEqual(['r', 'a', 'r', 'b'])
    expect(run.result?.endReason).toBe('scene-end')
  })

  it('長い [待機: N] の直後に選択肢が来ても、停滞と誤判定せず選択肢を映して自動選択する', async () => {
    const { h, renderer } = makeRenderer()
    h.waitMs = 70_000
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'c',
      sceneOrder: ['a', 'b', 'c'],
      stallTimeoutMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(run.result).toBeUndefined()
    h.waitMs = null
    h.pending = { options: [{ jump: 'b', locked: false }] }
    await vi.advanceTimersByTimeAsync(EXPORT_AUTO_CHOICE_DISPLAY_MS + EXPORT_POLL_MS * 2)
    expect(run.result).toBeUndefined()
    expect(h.selected).toEqual(['b'])
    h.pending = null
    h.onEnd?.()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
  })

  it('長い [待機: N] の直後に自動選択できない選択肢が来たら、3 秒映して終端にする', async () => {
    const { h, renderer } = makeRenderer()
    h.waitMs = 70_000
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b', 'x'],
      stallTimeoutMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(70_000)
    h.waitMs = null
    h.pending = { options: [{ jump: 'x', locked: false }] }
    await vi.advanceTimersByTimeAsync(EXPORT_CHOICE_HOLD_MS + EXPORT_POLL_MS * 2)
    await run.p
    expect(run.result?.endReason).toBe('choice-end')
  })

  it('保険: 毎回別の選択肢が出続けても、自動選択は上限で止まる', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'c',
      sceneOrder: ['a', 'b', 'c'],
      stallTimeoutMs: 10 ** 9,
    })
    const loop = [{ jump: 'b', locked: false }]
    h.uniqueKeys = true
    h.reoffer = loop
    h.pending = { options: loop }
    await vi.advanceTimersByTimeAsync(
      (EXPORT_AUTO_CHOICE_DISPLAY_MS + EXPORT_POLL_MS * 2) * (EXPORT_MAX_AUTO_CHOICES + 2) +
        EXPORT_CHOICE_HOLD_MS +
        EXPORT_POLL_MS * 4
    )
    await run.p
    expect(h.selected.length).toBe(EXPORT_MAX_AUTO_CHOICES)
    expect(run.result?.endReason).toBe('choice-end')
  })

  it('選択肢が受け付けられず固まっても、停滞タイムアウトで終わる', async () => {
    const { h, renderer } = makeRenderer()
    h.acceptSelect = false
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'c',
      sceneOrder: ['a', 'b', 'c'],
      stallTimeoutMs: 5000,
    })
    h.pending = { options: [{ jump: 'b', locked: false }] }
    await vi.advanceTimersByTimeAsync(4000)
    expect(run.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(3000)
    await run.p
    expect(run.result?.endReason).toBe('stalled')
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

  it('[待機: N] で待っている間は、N ms を加えた長さまで停滞とみなさない', async () => {
    const { h, renderer } = makeRenderer()
    h.waitMs = 80_000
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      stallTimeoutMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(run.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(80_000)
    await run.p
    expect(run.result?.endReason).toBe('stalled')
  })

  it('終わりのある動画の再生中は停滞とみなさない', async () => {
    const { h, renderer } = makeRenderer()
    h.videoPlaying = true
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      stallTimeoutMs: 5000,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run.result).toBeUndefined()
    h.videoPlaying = false
    await vi.advanceTimersByTimeAsync(6000)
    await run.p
    expect(run.result?.endReason).toBe('stalled')
  })

  it('録画前の背景ロード待ちの途中でも、中止ですぐ reject する', async () => {
    const { h, renderer } = makeRenderer()
    h.backgroundGate = new Promise<void>(() => {}) // 永久に終わらない
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
    })
    ac.abort()
    await vi.advanceTimersByTimeAsync(1)
    await run.p
    expect(run.error).toBeInstanceOf(ExportAbortedError)
    expect(stops).toEqual([])
    expect(h.exportCalls).toEqual([true, false])
  })

  it('余韻録音（postRoll）の最中に中止しても、保存されず reject する（終了処理が二重に走らない）', async () => {
    const { h, renderer } = makeRenderer()
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
      postRollMs: 5000,
    })
    h.onEnd?.() // 終端検知 → 余韻録音に入る
    await vi.advanceTimersByTimeAsync(1000)
    ac.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    await run.p
    expect(run.result).toBeUndefined()
    expect(run.error).toBeInstanceOf(ExportAbortedError)
    expect(stops).toEqual(['stop'])
    expect(h.exportCalls).toEqual([true, false])
  })

  it('recorder が停止済み（onstop 前）の最中に中止しても、reject して後始末する', async () => {
    const { h, renderer } = makeRenderer()
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
    })
    recorders[0].state = 'inactive' // stop 済みで onstop がまだ来ていない状態
    ac.abort()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
    expect(run.error).toBeInstanceOf(ExportAbortedError)
    expect(stops).toEqual([])
    expect(h.exportCalls).toEqual([true, false])
  })

  it('静止画面でも冒頭が黒にならないよう、録画開始の直後に最初のフレームを要求する', async () => {
    const { h, renderer } = makeRenderer()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
    })
    expect(h.frameRequests).toBe(1)
    h.onEnd?.()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
  })

  it('録画前の中止では、遅延ロード中の入場を取り消す', async () => {
    const { h, renderer } = makeRenderer()
    h.backgroundGate = new Promise<void>(() => {})
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
    })
    ac.abort()
    await vi.advanceTimersByTimeAsync(1)
    await run.p
    expect(h.cancelPendingEntryCalls).toBe(1)
  })

  it('破棄済みのレンダラには、中止の後始末で触らない（次の書き出しはできる）', async () => {
    const { h, renderer } = makeRenderer()
    const ac = new AbortController()
    const run = await startRecording(renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
      signal: ac.signal,
    })
    h.ready = false // 画面を離れてレンダラが破棄された
    ac.abort()
    await vi.advanceTimersByTimeAsync(10)
    await run.p
    expect(run.error).toBeInstanceOf(ExportAbortedError)
    expect(h.exportCalls).toEqual([true]) // setExporting(false) などを呼ばない
    // 多重起動ガードは外れている
    const second = makeRenderer()
    const run2 = await startRecording(second.renderer, {
      startSceneId: 'a',
      endSceneId: 'b',
      sceneOrder: ['a', 'b'],
    })
    second.h.onEnd?.()
    await vi.advanceTimersByTimeAsync(10)
    await run2.p
    expect(run2.result?.endReason).toBe('story-end')
  })
})
