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
   * jumpToScene が canvas に新フレームを描画 + GPU 合成が flush されるまでの猶予。
   * jumpToScene 同期描画 → preRoll 待機 → recorder.start の順で、
   * 「前回プレビューの最終フレーム」が録画先頭に乗るリスクと、
   * 「BGM 開始イベントが録画前に発火して頭が欠ける」リスクの両方を最小化する。
   * 50ms はパイント flush (~16ms) + AudioContext のバッファ遅延 (20-50ms) を吸収する目安。
   * これより短くすると BGM 頭が欠けるリスクがある。
   */
  preRollMs?: number
  /**
   * 終了検知後、録画停止までの追加録音時間 ms。
   * AudioManager の BGM 既定フェード 1000ms をすべて録音するため、デフォルト 1200ms。
   * 短くすると終端で BGM がプチっと切れる事故になるため、変更時は要注意。
   */
  postRollMs?: number
  /**
   * 録画中だけ適用するレンダラ解像度 (#279)。captureStream は canvas の裏バッファを
   * そのまま録るため、書き出し解像度 = 論理サイズ × この値になる。未指定なら
   * `max(3, 現在の解像度)`（9:16=450×800 で 1350×2400、16:9=800×450 で 2400×1350 ＝
   * いずれも 1080×1920 以上）。録画後は元の解像度（device DPI）へ復元する。
   */
  exportResolution?: number
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

/** ファイル名に使えない文字を `_` に置換する。連続する不正文字は 1 つに圧縮する */
export function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '_')
}

/**
 * 多重 exportVideo 並行起動を防ぐモジュールスコープのフラグ (review round-2 S3)。
 * UI 側 (EditorScreen) は別途 React state で「録画中」を表現するので、ここは
 * VideoExporter 内部の防衛線専用（UI から状態を読む必要は無い）。
 */
let isExporting = false

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
    preRollMs = 50,
    postRollMs = 1200,
    exportResolution: exportResolutionOpt,
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

  // 多重録画ガード (review S3)。同 NovelRenderer に対する並行 exportVideo は
  // takeOnEnd/takeOnSceneChange の前提（破壊的）を壊すため許可しない。
  // #279: 解像度 bump / captureStream など副作用の前に最初に弾く（並行起動が
  // 先行録画の解像度を巻き戻す事故を防ぐ）。
  if (isExporting) {
    throw new Error('VideoExporter is already running. Wait for the current export to finish.')
  }
  isExporting = true

  // #279: 録画中だけレンダラ解像度を上げて高解像度の WebM を得る。captureStream は
  // canvas の裏バッファを録るので、captureStream を作る前に resize しておく。
  // 録画後は cleanup で必ず元解像度へ戻す（通常プレイの表示・挙動を無回帰に保つ）。
  const prevResolution = renderer.getRenderResolution()
  const exportResolution = exportResolutionOpt ?? Math.max(3, prevResolution)
  renderer.setRenderResolution(exportResolution)

  const audio = renderer.getAudioManager()
  audio.ensureContext()
  const audioStream = audio.enableCapture()
  if (!audioStream) {
    // 解像度・録画フラグを必ず巻き戻してから throw（前段で副作用を起こしているため）。
    audio.disableCapture()
    renderer.setRenderResolution(prevResolution)
    isExporting = false
    throw new Error('AudioManager could not provide MediaStream (AudioContext init failed)')
  }

  // #279 (review S1): captureStream / MediaStream / MediaRecorder の同期コンストラクタが
  // throw すると、bump した解像度と isExporting フラグが戻らず固着する（cleanup は
  // recorder のコールバック経由でしか呼ばれないため）。ここで try/catch し、!audioStream
  // 経路と同じく副作用（capture / 解像度 / フラグ）を巻き戻してから rethrow する。
  let recorder!: MediaRecorder
  try {
    const videoStream = canvas.captureStream(fps)
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks(),
    ])
    recorder = new MediaRecorder(combined, { mimeType })
  } catch (e) {
    audio.disableCapture()
    renderer.setRenderResolution(prevResolution)
    isExporting = false
    throw e instanceof Error ? e : new Error(String(e))
  }

  const chunks: Blob[] = []
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
  let settled = false
  let visitedEndScene = false
  let startedAt = 0

  const cleanup = () => {
    try {
      // 元値が null だったら null に戻す（advance の onEndCallback?.() 挙動を完全復元）(round-2 S4)
      renderer.setOnSceneChange(prevOnSceneChange)
      renderer.setOnEnd(prevOnEnd)
      audio.disableCapture()
      // #279: 録画用に上げた解像度を元（device DPI）へ戻す。
      renderer.setRenderResolution(prevResolution)
    } catch (e) {
      console.warn('[VideoExporter] cleanup failed', e)
    }
    isExporting = false
  }

  const settleResolve = (durationMs: number) => {
    if (settled) return
    settled = true
    const blob = new Blob(chunks, { type: mimeType })
    resolveResult({ blob, mimeType, durationMs })
  }
  const settleReject = (err: Error) => {
    if (settled) return
    settled = true
    rejectResult(err)
  }

  const finalize = (status: string) => {
    if (stopped) return
    stopped = true
    onProgress?.(status)

    // postRoll の余韻録音 → recorder.stop() → onstop で chunks 確定。
    // recorder.onstop は stop() 呼び出し後に発火するので、stop 前に仕掛けて OK。
    recorder.onstop = () => {
      cleanup()
      settleResolve(performance.now() - startedAt)
    }
    setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop()
        } else {
          // すでに stop 済（recorder.onerror 経由等）。onstop は来ないので手動で確定。
          // settled フラグがあるので onstop と二重発火しても安全 (round-2 M2)。
          recorder.onstop = null
          cleanup()
          settleResolve(performance.now() - startedAt)
        }
      } catch (e) {
        cleanup()
        settleReject(e instanceof Error ? e : new Error(String(e)))
      }
    }, postRollMs)
  }

  recorder.onerror = (e: Event) => {
    // MediaRecorder の onerror は MediaRecorderErrorEvent を渡す。
    // e.error に DOMException が入っているので拾って原因究明に役立てる (round-2 S2)。
    const detail = (e as { error?: { name?: string; message?: string } }).error
    cleanup()
    settleReject(
      new Error(
        `MediaRecorder error: ${detail?.name ?? 'unknown'}${detail?.message ? ' ' + detail.message : ''}`
      )
    )
  }

  // startSceneId === endSceneId の単一シーン録画では、jumpToScene 直後の
  // setOnSceneChange 発火で visitedEndScene = true まで進むが、まだ
  // 「別シーンへの遷移」は起きていないので finalize は呼ばれない。OK。
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

  renderer.setOnEnd(() => {
    if (stopped) return
    finalize('全イベント完走')
  })

  // 順序 (M1 修正): jumpToScene で synchronously 新フレーム描画 + BGM 開始 →
  // 1 frame (16ms @60Hz) 待って GPU 合成 flush → recorder.start。
  // この順序で「前回プレビューの最終フレーム混入」と「BGM 頭欠け」の両方を最小化する。
  // jumpToScene 後すぐに recorder を立ち上げないと BGM の起点を取り逃す。
  renderer.setAutoMode(true)
  renderer.jumpToScene(startSceneId)
  onProgress?.('録画準備中')

  await new Promise((r) => setTimeout(r, preRollMs))

  // 動画入力レイヤ (#252): 録画開始前に表示中の動画を頭出し（currentTime=0）して
  // ready を待つ。これで録画の先頭から動画が正しく映る/鳴る。動画が無ければ即解決。
  onProgress?.('動画頭出し中')
  await renderer.prepareVideosForExport()

  startedAt = performance.now()
  recorder.start(1000) // 1 秒ごとに dataavailable。途中 error 時の partial 保存にも有効
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
