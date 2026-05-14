/**
 * 動画エクスポート Phase 1 (#228) — MediaRecorder リアルタイム録画。
 *
 * canvas.captureStream(fps) + AudioManager の MediaStreamAudioDestinationNode を統合し、
 * 開始シーンID〜終了シーンID の自動再生を録画する。実時間がかかる代わりに、
 * 既存ランタイムを virtual time 化せず音声も同時取得できる最小実装。
 *
 * Phase 2 で virtual time + ffmpeg.wasm 経路に置き換える際は本モジュールごと差し替える想定。
 */
import type { NovelRenderer } from './NovelRenderer'

export interface VideoExportOptions {
  /** 録画開始シーンID。jumpToScene でここから自動再生する */
  startSceneId: string
  /** 録画終了シーンID。このシーンの末尾イベント or 次シーンへの遷移で stop する */
  endSceneId: string
  /** フレームレート（24 / 30 を想定） */
  fps: number
  /** 出力 MIME。未指定なら最初にサポートされた候補を自動選択 */
  mimeType?: string
  /** 進捗ログ。状態文字列を都度通知（UI 表示用） */
  onProgress?: (status: string) => void
  /**
   * jumpToScene 後、録画開始までの待機時間 ms。
   * 経験則: PixiJS の Ticker 1〜2 周期 (~33ms) + 立ち絵 fade-in 余裕。100ms あれば
   * 「前回プレビューの最終フレーム」を確実にクリアして新シーン先頭が描画された状態で録画開始できる。
   */
  preRollMs?: number
  /**
   * 終了検知後、録画停止までの追加録音時間 ms。
   * 経験則: 終端の SE / BGM の自然なフェードアウトと、停止フラグから MediaRecorder.stop()
   * までのフレーム遅延を吸収する。300ms 程度で余韻が切れない。
   */
  postRollMs?: number
}

export interface VideoExportResult {
  blob: Blob
  mimeType: string
  /** 録画した実時間 ms */
  durationMs: number
}

const CODEC_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

/** 環境で利用可能な最初の `video/webm` codec を返す。何も無ければ null */
export function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of CODEC_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return null
}

/** ファイル名に使えない文字を `_` に置換する */
export function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

/**
 * シナリオ範囲を録画して `Blob` を返す。失敗時は throw する。
 *
 * 終了検出: 録画開始後に「currentSceneId が一度 endSceneId になり、その後別シーンに変わった」
 * もしくは renderer.onEnd（全イベント完走）が発火した時点で stop する。
 */
export async function exportVideo(
  renderer: NovelRenderer,
  opts: VideoExportOptions
): Promise<VideoExportResult> {
  const {
    startSceneId,
    endSceneId,
    fps,
    mimeType: mimeTypeOpt,
    onProgress,
    preRollMs = 100,
    postRollMs = 300,
  } = opts

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser')
  }

  const mimeType = mimeTypeOpt ?? pickSupportedMimeType()
  if (!mimeType) {
    throw new Error('No supported video/webm codec found')
  }

  const canvas = renderer.getCanvas()
  if (!canvas) {
    throw new Error('NovelRenderer canvas is not ready')
  }

  const audio = renderer.getAudioManager()
  audio.ensureContext()
  const audioStream = audio.enableCapture()
  if (!audioStream) {
    audio.disableCapture()
    throw new Error('AudioManager could not provide MediaStream (AudioContext init failed)')
  }

  const videoStream = canvas.captureStream(fps)
  const combined = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audioStream.getAudioTracks(),
  ])

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(combined, { mimeType })
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }

  // 録画中は setOnSceneChange / onEnd を VideoExporter が占有する。
  // 既存リスナがあれば退避し、cleanup 時に確実に復元する (review S1)。
  const prevOnEnd = renderer.takeOnEnd()
  const prevOnSceneChange = renderer.takeOnSceneChange()

  let resolveResult!: (r: VideoExportResult) => void
  let rejectResult!: (e: unknown) => void
  const resultPromise = new Promise<VideoExportResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let stopped = false
  let visitedEndScene = false
  let startedAt = 0

  const cleanup = () => {
    try {
      renderer.setOnSceneChange(prevOnSceneChange)
      renderer.onEnd(prevOnEnd ?? (() => {}))
      audio.disableCapture()
    } catch (e) {
      console.warn('[VideoExporter] cleanup failed', e)
    }
  }

  const finalize = (status: string) => {
    if (stopped) return
    stopped = true
    onProgress?.(status)

    // postRoll の余韻録音 → recorder.stop() → onstop で chunks 確定。
    // recorder.onstop は stop() 呼び出し後に発火するので、stop 前に仕掛けて OK。
    recorder.onstop = () => {
      cleanup()
      const blob = new Blob(chunks, { type: mimeType })
      resolveResult({ blob, mimeType, durationMs: performance.now() - startedAt })
    }
    setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop()
        } else {
          // すでに stop 済（recorder.onerror 経由等）。onstop は呼ばれないので手動で確定
          cleanup()
          const blob = new Blob(chunks, { type: mimeType })
          resolveResult({ blob, mimeType, durationMs: performance.now() - startedAt })
        }
      } catch (e) {
        cleanup()
        rejectResult(e instanceof Error ? e : new Error(String(e)))
      }
    }, postRollMs)
  }

  recorder.onerror = () => {
    cleanup()
    rejectResult(new Error('MediaRecorder error'))
  }

  renderer.setOnSceneChange((sceneId) => {
    if (stopped) return
    onProgress?.(`録画中: ${sceneId}`)
    if (sceneId === endSceneId) {
      visitedEndScene = true
      return
    }
    if (visitedEndScene) {
      finalize(`終端到達: ${sceneId}`)
    }
  })

  renderer.onEnd(() => {
    if (stopped) return
    finalize('全イベント完走')
  })

  // 先に jumpToScene でシーン先頭まで進めてから録画開始することで、
  // 「前回プレビューの最終フレーム」が録画先頭に混入するのを防ぐ (review M2)。
  renderer.setAutoMode(true)
  renderer.jumpToScene(startSceneId)
  onProgress?.('録画準備中')

  await new Promise((r) => setTimeout(r, preRollMs))

  startedAt = performance.now()
  recorder.start(1000) // 1 秒ごとに dataavailable
  onProgress?.('録画開始')

  return resultPromise
}

/** Blob をブラウザのダウンロード経由でファイル保存する */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Safari は <a download> のクリック直後に Blob URL を revoke するとダウンロード失敗するため
  // 1 秒の猶予を持たせる（Chrome/Firefox は 0ms でも動く）。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
