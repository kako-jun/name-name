import { useEffect } from 'react'

/**
 * 動画エクスポートモーダル (#228)。
 * EditorScreen のプレビュー画面に重ねて表示する。
 */
interface VideoExportModalProps {
  isDark: boolean
  allSceneIds: string[]
  startSceneId: string
  endSceneId: string
  fps: number
  /** true なら録画開始時の flags をプレビュー中のものから引き継ぐ。false（既定）は空 flags で決定論 */
  inheritFlags: boolean
  status: string | null
  /** 録画進行中なら true。録画開始ボタンを disable する */
  isRunning: boolean
  onChangeStart: (id: string) => void
  onChangeEnd: (id: string) => void
  onChangeFps: (fps: number) => void
  onChangeInheritFlags: (inherit: boolean) => void
  onStart: () => void
  /** 録画を中止する (#780)。録画は破棄され、ファイルは保存されない */
  onAbort: () => void
  onClose: () => void
}

function VideoExportModal({
  isDark,
  allSceneIds,
  startSceneId,
  endSceneId,
  fps,
  inheritFlags,
  status,
  isRunning,
  onChangeStart,
  onChangeEnd,
  onChangeFps,
  onChangeInheritFlags,
  onStart,
  onAbort,
  onClose,
}: VideoExportModalProps) {
  // Esc キーで閉じる（録画中は閉じれないようにする = 進捗の見失い防止）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRunning) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, isRunning])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={() => {
        if (!isRunning) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-export-modal-title"
    >
      <div
        className={`max-w-md w-[90%] p-5 rounded-lg shadow-xl ${isDark ? 'bg-gray-800 text-gray-100' : 'bg-white text-gray-900'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="video-export-modal-title" className="text-lg font-bold mb-3">
          動画エクスポート (WebM)
        </h2>
        <p className="text-xs mb-3 opacity-70">
          シナリオ範囲を MediaRecorder
          でリアルタイム録画します。実時間がかかり、録画中はタブをアクティブにしておいてください。
        </p>
        <label className="block text-sm mb-2">
          開始シーン
          <select
            value={startSceneId}
            onChange={(e) => onChangeStart(e.target.value)}
            className={`mt-1 w-full px-2 py-1 rounded border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
          >
            {allSceneIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm mb-2">
          終了シーン
          <select
            value={endSceneId}
            onChange={(e) => onChangeEnd(e.target.value)}
            className={`mt-1 w-full px-2 py-1 rounded border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
          >
            {allSceneIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm mb-3">
          フレームレート
          <select
            value={fps}
            onChange={(e) => onChangeFps(Number(e.target.value))}
            className={`mt-1 w-full px-2 py-1 rounded border ${isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-300'}`}
          >
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm mb-3">
          <input
            type="checkbox"
            checked={inheritFlags}
            onChange={(e) => onChangeInheritFlags(e.target.checked)}
            disabled={isRunning}
            className="mt-1"
          />
          <span>
            プレビューの flags を引き継ぐ
            <span className="block text-xs opacity-70">
              OFF（既定）は flags を空にして録画します。毎回同じ映像になります。
            </span>
          </span>
        </label>
        {status && (
          <div className="text-xs mb-3 opacity-80 break-all whitespace-pre-wrap">{status}</div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={isRunning}
            className={`px-3 py-1 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed ${isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'}`}
          >
            閉じる
          </button>
          {isRunning && (
            <button
              type="button"
              onClick={onAbort}
              title="録画を止めて破棄します（ファイルは保存されません）"
              className={`px-3 py-1 rounded text-sm ${isDark ? 'bg-gray-600 hover:bg-gray-500' : 'bg-gray-300 hover:bg-gray-400'}`}
            >
              中止
            </button>
          )}
          <button
            type="button"
            onClick={onStart}
            disabled={isRunning}
            className="px-3 py-1 rounded text-sm bg-red-600 hover:bg-red-500 text-white disabled:bg-gray-500 disabled:cursor-not-allowed"
          >
            {isRunning ? '録画中…' : '録画開始'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default VideoExportModal
