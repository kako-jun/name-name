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
import type { FlagValue } from '../types'
import { computeDynamicRenderResolution, resolveDevicePixelRatio } from './novelLayout'
import {
  EXPORT_AUTO_CHOICE_DISPLAY_MS,
  EXPORT_CHOICE_HOLD_MS,
  EXPORT_MAX_AUTO_CHOICES,
  EXPORT_POLL_MS,
  EXPORT_STALL_TIMEOUT_MS,
  computeStallLimitMs,
  exportProgressSignature,
  createChoiceMemory,
  markChoiceSelected,
  pickAutoChoice,
  recordChoice,
  type ExportEndReason,
} from './videoExportPolicy'

export type { ExportEndReason } from './videoExportPolicy'

/** 書き出しを中止したときに exportVideo が reject するエラー。録画は破棄され、結果は返らない。 */
export class ExportAbortedError extends Error {
  constructor() {
    super('書き出しを中止しました')
    this.name = 'ExportAbortedError'
  }
}

export interface VideoExportOptions {
  /** 録画開始シーンID。新規開始（startFrom）でここから自動再生する */
  startSceneId: string
  /** 録画終了シーンID。このシーンの末尾イベント or 次シーンへの遷移で stop する */
  endSceneId: string
  /**
   * 録画開始時の flags（置換セマンティクス）。既定は空で、プレビューの状態に依らず決定論的に録れる (#734)。
   * プレビュー中の flags を引き継ぎたい呼び出し側は、明示的にコピーして渡す。使った flags は
   * `onProgress` に出る。
   */
  flags?: Record<string, FlagValue>
  /** フレームレート（24 / 30 を想定） */
  fps: number
  /** 出力 MIME。未指定なら最初にサポートされた候補を自動選択 */
  mimeType?: string
  /** 進捗ログ。状態文字列を都度通知（UI 表示用） */
  onProgress?: (status: string) => void
  /**
   * 新規開始（startFrom）と開始背景のロード完了の後、録画開始までの待機時間 ms。
   * 新規開始が canvas に新フレームを描画 + GPU 合成が flush されるまでの猶予。
   * 新規開始 → 背景ロード待ち → preRoll 待機 → recorder.start の順で、
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
  /**
   * シーン一覧の順序 (#780)。選択肢の遷移先が書き出し範囲（開始〜終了）内かを判定する。
   * 未指定（空）だと範囲内の遷移先が無いものとして扱い、選択肢に到達した時点で終端にする。
   */
  sceneOrder?: readonly string[]
  /** 中止用シグナル (#780)。abort すると録画を止めて破棄し、`ExportAbortedError` で reject する */
  signal?: AbortSignal
  /** 自動で選ぶ遷移先が無い選択肢を映してから録画を終えるまで ms (#780)。既定 EXPORT_CHOICE_HOLD_MS */
  choiceHoldMs?: number
  /** 本文が進まない状態がこの時間続いたら録画を終える ms (#780)。既定 EXPORT_STALL_TIMEOUT_MS。
   *  `[待機: N]` 中は N ms を加えた長さ、終わりのある動画の再生中は停滞とみなさない */
  stallTimeoutMs?: number
  /** 自動で選ぶ選択肢を、選ぶ前に映しておく時間 ms (#780)。既定 EXPORT_AUTO_CHOICE_DISPLAY_MS */
  autoChoiceDisplayMs?: number
}

export interface VideoExportResult {
  blob: Blob
  mimeType: string
  /** 録画した実時間 ms */
  durationMs: number
  /** 録画が終わった理由 (#780) */
  endReason: ExportEndReason
  /** 終わった理由の説明（UI 表示用）(#780) */
  endMessage: string
}

/** 開始シーンの背景ロード待ちの上限 ms。超えたら警告して録画を始める（書き出しを永久停止させない） */
const BACKGROUND_LOAD_TIMEOUT_MS = 10_000

/**
 * 書き出しに使う flags を決める (#734, ADR 0003 §8)。既定（`inheritPreview` false）は空で、
 * プレビューの状態に依らず決定論的に録れる。true ならプレビュー中の flags を複製して返す。
 */
export function resolveExportFlags(
  renderer: Pick<NovelRenderer, 'getSnapshot'>,
  inheritPreview: boolean
): Record<string, FlagValue> {
  return inheritPreview ? structuredClone(renderer.getSnapshot().flags) : {}
}

/** エディタの書き出し UI の state から `VideoExportOptions` を組み立てる (#734)。 */
export function buildVideoExportOptions(
  renderer: Pick<NovelRenderer, 'getSnapshot'>,
  ui: {
    startSceneId: string
    endSceneId: string
    fps: number
    inheritFlags: boolean
    mimeType: string
    onProgress: (status: string) => void
  }
): VideoExportOptions {
  return {
    startSceneId: ui.startSceneId,
    endSceneId: ui.endSceneId,
    fps: ui.fps,
    flags: resolveExportFlags(renderer, ui.inheritFlags),
    mimeType: ui.mimeType,
    onProgress: ui.onProgress,
  }
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
 * 書き出し終了時にレンダラへ復元する解像度を決定する (#455)。
 *
 * `prevResolution`（書き出し開始時点の解像度）をそのまま復元する単純な設計だと、
 * 書き出し中にウィンドウリサイズが起きた場合に問題が起きる。NovelPlayer の自動追従
 * ResizeObserver（#446、containerRef の実表示サイズ変化を検知して setRenderResolution
 * を呼ぶ）は `renderer.isExporting() === true` の間スキップされるため、書き出し終了直後の
 * 解像度が「書き出し開始時点の表示サイズ」のまま stale になり、書き出し終了後に新たな
 * リサイズが一度も起きない限り自己修復しない（#455 本題）。
 *
 * `renderer.getCanvas()` で取得できる実際の `<canvas>` 要素は CSS で親要素
 * （containerRef）いっぱいに引き伸ばされる設計なので、`getBoundingClientRect().width` が
 * 「復元すべき実表示幅」として使える。これを `computeDynamicRenderResolution`
 * （#446、NovelPlayer の自動追従と同一の計算式）に通して再計算することで、書き出し中の
 * リサイズを取りこぼさず反映する。書き出し中にリサイズが一切起きなかった通常ケースでは
 * 実測幅 = 書き出し開始時の表示幅と一致するため、結果は従来どおり `prevResolution` と
 * 一致する（非回帰）。
 *
 * canvas が取得できない、unmount 済み等で width が測れない、または（テストダブル等）
 * `getBoundingClientRect` を持たない場合は安全側の `prevResolution` にフォールバックする
 * （`getBoundingClientRect?.()` によるオプショナル呼び出しでどちらの欠落も吸収する）。
 */
function resolveCleanupResolution(renderer: NovelRenderer, prevResolution: number): number {
  const canvas = renderer.getCanvas()
  const displayWidth = canvas?.getBoundingClientRect?.().width ?? 0
  if (!(displayWidth > 0)) return prevResolution
  const { width: screenWidth, height: screenHeight } = renderer.getScreenSize()
  const dpr = resolveDevicePixelRatio()
  return computeDynamicRenderResolution(displayWidth, screenWidth, screenHeight, dpr)
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
    flags = {},
    fps,
    mimeType: mimeTypeOpt,
    onProgress,
    preRollMs = 50,
    postRollMs = 1200,
    exportResolution: exportResolutionOpt,
    sceneOrder = [],
    signal,
    choiceHoldMs = EXPORT_CHOICE_HOLD_MS,
    stallTimeoutMs = EXPORT_STALL_TIMEOUT_MS,
    autoChoiceDisplayMs = EXPORT_AUTO_CHOICE_DISPLAY_MS,
  } = opts

  if (signal?.aborted) throw new ExportAbortedError()

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

  // #350: 録画中はシナリオスライダ(SeekBar)を抑制し、録画にスライダが焼き込まれないようにする。
  // 解像度 bump と同じく副作用なので、早期 throw / cleanup の全経路で必ず false に戻す。
  renderer.setExporting(true)

  const audio = renderer.getAudioManager()
  audio.ensureContext()
  const audioStream = audio.enableCapture()
  if (!audioStream) {
    // 解像度・SeekBar 抑制・録画フラグを必ず巻き戻してから throw（前段で副作用を起こしているため）。
    audio.disableCapture()
    renderer.setRenderResolution(resolveCleanupResolution(renderer, prevResolution))
    renderer.setExporting(false)
    isExporting = false
    throw new Error('AudioManager could not provide MediaStream (AudioContext init failed)')
  }

  // #279 (review S1): captureStream / MediaStream / MediaRecorder の同期コンストラクタが
  // throw すると、bump した解像度と isExporting フラグが戻らず固着する（cleanup は
  // recorder のコールバック経由でしか呼ばれないため）。ここで try/catch し、!audioStream
  // 経路と同じく副作用（capture / 解像度 / フラグ）を巻き戻してから rethrow する。
  let recorder!: MediaRecorder
  // captureStream は canvas が再描画されたときだけフレームを出す。静止した画面（選択肢のハブなど）では
  // 録画開始後しばらく最初のフレームが来ず、冒頭が黒になるため、録画開始の直後に1枚要求する。
  let requestFirstFrame: () => void = () => {}
  try {
    const videoStream = canvas.captureStream(fps)
    const videoTrack = videoStream.getVideoTracks()[0] as
      | (MediaStreamTrack & { requestFrame?: () => void })
      | undefined
    requestFirstFrame = () => {
      try {
        videoTrack?.requestFrame?.()
      } catch (e) {
        console.warn('[VideoExporter] requestFrame failed', e)
      }
    }
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks(),
    ])
    recorder = new MediaRecorder(combined, { mimeType })
  } catch (e) {
    audio.disableCapture()
    renderer.setRenderResolution(resolveCleanupResolution(renderer, prevResolution))
    renderer.setExporting(false)
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
  const prevAutoMode = renderer.isAutoMode()
  let startedAt = 0
  let recordingStarted = false
  let aborted = false
  let cleanedUp = false
  let monitorTimer: ReturnType<typeof setInterval> | undefined

  const stopMonitor = () => {
    if (monitorTimer !== undefined) clearInterval(monitorTimer)
    monitorTimer = undefined
  }

  // cleanup は「録画が終わる経路」が複数（正常終了・中止・recorder エラー）重なっても一度だけ走らせる。
  // 二重に走ると、次の書き出しが取った isExporting を先行の後始末が下ろしてしまう。
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    stopMonitor()
    signal?.removeEventListener('abort', onAbort)
    // 画面を離れて破棄済みのレンダラには触らない（警告ログと二重破棄を避ける）
    if (renderer.isReady?.() === false) {
      isExporting = false
      return
    }
    try {
      // 元値が null だったら null に戻す（advance の onEndCallback?.() 挙動を完全復元）(round-2 S4)
      renderer.setOnSceneChange(prevOnSceneChange)
      renderer.setOnEnd(prevOnEnd)
      audio.disableCapture()
      // #279: 録画用に上げた解像度を元（device DPI 相当）へ戻す。
      // #455: 書き出し中にリサイズが起きていた場合に備え、prevResolution をそのまま
      // 復元せず resolveCleanupResolution で実表示幅から再計算する（詳細は同関数の JSDoc）。
      renderer.setRenderResolution(resolveCleanupResolution(renderer, prevResolution))
      // #350: 録画中に抑制した SeekBar を元へ戻す（通常プレイで再びスライダが見える）。
      renderer.setExporting(false)
    } catch (e) {
      console.warn('[VideoExporter] cleanup failed', e)
    }
    // 書き出し前の autoMode へ戻す（書き出しのために入れたオートモードをプレビューへ残さない）。
    // 他の復元が例外で飛ばないよう独立した try で行う。
    try {
      renderer.setAutoMode(prevAutoMode)
    } catch (e) {
      console.warn('[VideoExporter] autoMode restore failed', e)
    }
    isExporting = false
  }

  let endReason: ExportEndReason = 'story-end'
  let endMessage = ''
  const settleResolve = (durationMs: number) => {
    if (settled) return
    settled = true
    const blob = new Blob(chunks, { type: mimeType })
    resolveResult({ blob, mimeType, durationMs, endReason, endMessage })
  }
  const settleReject = (err: Error) => {
    if (settled) return
    settled = true
    rejectResult(err)
  }

  const finalize = (status: string, reason: ExportEndReason) => {
    if (stopped) return
    stopped = true
    // 録画開始前の終端検知: timer は予約しない。本流の failIfStopped が唯一の後始末役になる
    // （timer が先に発火して cleanup が二重に走り、多重起動ガードが早く外れるのを防ぐ）。
    if (!recordingStarted) return
    stopMonitor()
    endReason = reason
    endMessage = status
    onProgress?.(status)

    // postRoll の余韻録音 → recorder.stop() → onstop で chunks 確定。
    // recorder.onstop は stop() 呼び出し後に発火するので、stop 前に仕掛けて OK。
    recorder.onstop = () => {
      cleanup()
      settleResolve(performance.now() - startedAt)
    }
    setTimeout(() => {
      if (aborted || settled) return
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

  // 中止 (#780)。録画前なら本流の failIfStopped が ExportAbortedError で後始末する。
  // 録画中・余韻録音中なら recorder を止めて破棄し、ExportAbortedError で reject する（保存しない）。
  function onAbort() {
    if (settled) return
    stopped = true
    stopMonitor()
    if (!recordingStarted) return
    aborted = true
    const finish = () => {
      cleanup()
      settleReject(new ExportAbortedError())
    }
    try {
      if (recorder.state !== 'inactive') {
        recorder.onstop = finish
        recorder.stop()
      } else {
        recorder.onstop = null
        finish()
      }
    } catch {
      finish()
    }
  }
  signal?.addEventListener('abort', onAbort)

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

  // startSceneId === endSceneId の単一シーン録画では、startFrom 直後の
  // setOnSceneChange 発火で visitedEndScene = true まで進むが、まだ
  // 「別シーンへの遷移」は起きていないので finalize は呼ばれない。OK。
  // 選択肢の辺（位置 × 遷移先）の記憶。自動選択は選んでいない辺を優先する (#780)。
  const choiceMemory = createChoiceMemory()
  renderer.setOnSceneChange((sceneId) => {
    if (stopped) return
    onProgress?.(`録画中: ${sceneId}`)
    if (sceneId === endSceneId) {
      visitedEndScene = true
      return
    }
    if (visitedEndScene) {
      finalize(`終端到達: ${sceneId}`, 'scene-end')
    }
  })

  renderer.setOnEnd(() => {
    if (stopped) return
    finalize('全イベント完走', 'story-end')
  })

  // 順序: 新規開始（startFrom）で synchronously 新フレーム描画 + BGM 開始 →
  // 開始シーンの背景のロード完了を待つ（新規開始は背景が地色から始まるため、未キャッシュだと
  // preRoll では間に合わず録画先頭の背景が欠ける）→ 1 frame (16ms @60Hz) 待って GPU 合成 flush →
  // recorder.start。「前回プレビューの最終フレーム混入」と「BGM 頭欠け」の両方を最小化する。
  // 新規開始は BGM・背景・flags・consecutiveJumps をプレビューから持ち越さない (#734, ADR 0003)。
  // 録画開始前の待ち中に終端（onEnd / end から次シーン）が来たら、録画せず失敗にする。
  // 録画前の待ち（背景ロード・動画頭出しなど最大数十秒）の途中でも、中止ですぐ抜ける。
  const raceAbort = <T>(p: Promise<T>): Promise<T> => {
    if (!signal) return p
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new ExportAbortedError())
        return
      }
      const onAbortRace = () => reject(new ExportAbortedError())
      signal.addEventListener('abort', onAbortRace, { once: true })
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbortRace)
          resolve(v)
        },
        (e) => {
          signal.removeEventListener('abort', onAbortRace)
          reject(e)
        }
      )
    })
  }
  const failIfStopped = () => {
    if (signal?.aborted) throw new ExportAbortedError()
    if (stopped) throw new Error('ended before recording started')
  }
  renderer.setAutoMode(true)
  onProgress?.(`録画準備中（flags: ${JSON.stringify(flags)}）`)
  try {
    const entry = await raceAbort(renderer.startFrom({ sceneId: startSceneId, flags }))
    if (entry.status !== 'entered') {
      const detail = entry.status === 'failed' ? `${entry.status}: ${entry.reason}` : entry.status
      throw new Error(`Could not start from scene "${startSceneId}" (${detail})`)
    }
    failIfStopped()
    onProgress?.('背景読み込み中')
    await raceAbort(waitForBackground(renderer))

    await raceAbort(new Promise((r) => setTimeout(r, preRollMs)))

    // 動画入力レイヤ (#252): 録画開始前に表示中の動画を頭出し（currentTime=0）して
    // ready を待つ。これで録画の先頭から動画が正しく映る/鳴る。動画が無ければ即解決。
    onProgress?.('動画頭出し中')
    await raceAbort(renderer.prepareVideosForExport())
    failIfStopped()
  } catch (e) {
    // 録画を始める前の失敗: 退避したリスナ・解像度・録画フラグ・isExporting を必ず戻す。
    // 中止なら、遅延ロード中の startFrom がこの後に解決してプレビューを書き換えないよう取り消す。
    if (e instanceof ExportAbortedError && renderer.isReady?.() !== false) {
      renderer.cancelPendingEntry?.()
    }
    stopped = true
    cleanup()
    throw e instanceof Error ? e : new Error(String(e))
  }

  recordingStarted = true
  startedAt = performance.now()
  recorder.start(1000) // 1 秒ごとに dataavailable。途中 error 時の partial 保存にも有効
  requestFirstFrame()
  onProgress?.('録画開始')

  // 選択肢への到達と停滞の見張り (#780)。録画開始後だけ回す。時計は performance.now。
  let autoChoices = 0
  let choiceSeenAt: number | null = null
  let lastSignature = ''
  let lastProgressAt = performance.now()
  monitorTimer = setInterval(() => {
    if (stopped) return
    const now = performance.now()
    const pending = renderer.getPendingChoice()
    if (pending) {
      // 選択肢の待機中は停滞の時計に触れない。受け付けられない状態が続けば、停滞として終わる。
      if (choiceSeenAt === null) {
        // 選択肢への到達は進行とみなす（長い [待機: N] の直後に停滞と誤判定しない）
        choiceSeenAt = now
        lastProgressAt = now
      }
      recordChoice(choiceMemory, pending.key, pending.sceneId, pending.options)
      const pick =
        autoChoices < EXPORT_MAX_AUTO_CHOICES
          ? pickAutoChoice(
              pending.options,
              startSceneId,
              endSceneId,
              sceneOrder,
              choiceMemory,
              pending.key
            )
          : null
      if (pick !== null) {
        // 範囲内の未訪問の遷移先があれば、選択肢を映してから先頭のものを自動で選ぶ。
        // 入場中などで受け付けられなければ次の tick で再試行（停滞の時計は進めない）。
        if (now - choiceSeenAt >= autoChoiceDisplayMs && renderer.selectPendingChoice(pick)) {
          autoChoices++
          markChoiceSelected(choiceMemory, pending.key, pick)
          choiceSeenAt = null
          lastProgressAt = now
          onProgress?.(`選択肢を自動選択: ${pick}`)
          return
        }
      } else if (now - choiceSeenAt >= choiceHoldMs) {
        // 範囲内の未訪問の遷移先が無い（または自動選択の上限）: 選択肢を映してから終端にする。
        finalize(
          autoChoices >= EXPORT_MAX_AUTO_CHOICES
            ? `選択肢の自動選択が上限(${EXPORT_MAX_AUTO_CHOICES}回)に達したため終了`
            : '選択肢に範囲内の未選択の遷移先が無いため終了',
          'choice-end'
        )
        return
      }
    } else {
      choiceSeenAt = null
      const progress = renderer.getExportProgress()
      const signature = exportProgressSignature(progress)
      if (signature !== lastSignature || progress.videoPlaying) {
        // 位置が動いた、または終わりのある動画を再生中は進行中
        lastSignature = signature
        lastProgressAt = now
        return
      }
      const limit = computeStallLimitMs(stallTimeoutMs, progress.waitMs)
      if (now - lastProgressAt >= limit) {
        finalize(`${Math.round(limit / 1000)}秒間進まなかったため終了`, 'stalled')
        return
      }
    }
    // 選択肢を受け付けられないまま長く経った場合は、停滞として終える
    if (pending && now - lastProgressAt >= stallTimeoutMs) {
      finalize(`${Math.round(stallTimeoutMs / 1000)}秒間進まなかったため終了`, 'stalled')
    }
  }, EXPORT_POLL_MS)

  return resultPromise
}

/** 背景ロード待ち。上限を超えたら警告して先へ進む（reject しない） */
async function waitForBackground(renderer: NovelRenderer): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), BACKGROUND_LOAD_TIMEOUT_MS)
  })
  try {
    const r = await Promise.race([
      renderer.waitForBackgroundLoad().then(() => 'done' as const),
      timeout,
    ])
    if (r === 'timeout') {
      console.warn(
        `[VideoExporter] 開始シーンの背景ロードが ${BACKGROUND_LOAD_TIMEOUT_MS}ms で終わらないため、待たずに録画を始めます`
      )
    }
  } finally {
    clearTimeout(timer)
  }
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
