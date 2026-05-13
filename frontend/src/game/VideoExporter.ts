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
  /** 録画開始までの待機時間 ms。BGM 先頭が削れる軽減策。デフォルト 100ms */
  preRollMs?: number
  /** 録画停止後の追加録音時間 ms。終端の SE/BGM 余韻取り。デフォルト 300ms */
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

  // 既存のコールバックを退避（録画後に復元）
  // 注: setOnSceneChange は #228 で新設、onEnd は別経路で使われている可能性があるため
  // 上書きで横取りし、stop 時に null に戻す。完全な復元は呼び出し側責務。
  const startedAt = performance.now()

  let stopped = false
  let visitedEndScene = false

  const finalize = (status: string): Promise<VideoExportResult> => {
    if (stopped) {
      // 二重 stop ガード。既に Promise が解決済みでも待つ Promise を返してしまうと
      // 永遠 pending になるので、最終的に同じ blob を返すよう外側で resolve しておく。
      return resultPromise
    }
    stopped = true
    onProgress?.(status)
    return new Promise<VideoExportResult>((resolve, reject) => {
      const finish = () => {
        try {
          renderer.setOnSceneChange(null)
          renderer.onEnd(() => {})
          audio.disableCapture()
        } catch (e) {
          console.warn('[VideoExporter] cleanup failed', e)
        }
        const blob = new Blob(chunks, { type: mimeType })
        resolve({ blob, mimeType, durationMs: performance.now() - startedAt })
      }
      recorder.onstop = finish
      recorder.onerror = (e) => reject(e)
      // postRollMs の余韻録音
      setTimeout(() => {
        try {
          if (recorder.state !== 'inactive') recorder.stop()
          else finish()
        } catch (e) {
          reject(e)
        }
      }, postRollMs)
    })
  }

  // resultPromise を先に作って finalize の二重呼び出しに備える
  let resolveResult!: (r: VideoExportResult) => void
  let rejectResult!: (e: unknown) => void
  const resultPromise = new Promise<VideoExportResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  renderer.setOnSceneChange((sceneId) => {
    if (stopped) return
    if (sceneId === endSceneId) {
      visitedEndScene = true
      onProgress?.(`録画中: ${sceneId}`)
      return
    }
    onProgress?.(`録画中: ${sceneId}`)
    if (visitedEndScene) {
      // endSceneId を抜けた瞬間に stop
      finalize(`終端到達: ${sceneId}`).then(resolveResult).catch(rejectResult)
    }
  })

  renderer.onEnd(() => {
    if (stopped) return
    // 全イベント完走（endSceneId が最終シーンだった場合のフォールバック）
    finalize('全イベント完走').then(resolveResult).catch(rejectResult)
  })

  // 録画開始
  recorder.start(1000) // 1 秒ごとに dataavailable
  onProgress?.('録画開始')

  // preRoll 経過後にジャンプ（先頭の音切れを軽減）
  await new Promise((r) => setTimeout(r, preRollMs))

  // オートモード ON で自走させる（llll-ll-media は元々起動時 ON だが念のため）
  renderer.setAutoMode(true)
  renderer.jumpToScene(startSceneId)

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
  // revokeObjectURL は次フレームで（ダウンロードダイアログが開く前に剥がさない）
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
