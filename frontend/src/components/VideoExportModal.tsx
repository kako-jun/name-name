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
  status: string | null
  onChangeStart: (id: string) => void
  onChangeEnd: (id: string) => void
  onChangeFps: (fps: number) => void
  onStart: () => void
  onClose: () => void
}

function VideoExportModal({
  isDark,
  allSceneIds,
  startSceneId,
  endSceneId,
  fps,
  status,
  onChangeStart,
  onChangeEnd,
  onChangeFps,
  onStart,
  onClose,
}: VideoExportModalProps) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className={`max-w-md w-[90%] p-5 rounded-lg shadow-xl ${isDark ? 'bg-gray-800 text-gray-100' : 'bg-white text-gray-900'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-3">動画エクスポート (WebM)</h2>
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
        {status && <div className="text-xs mb-3 opacity-80 break-all">{status}</div>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1 rounded text-sm ${isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'}`}
          >
            閉じる
          </button>
          <button
            type="button"
            onClick={onStart}
            className="px-3 py-1 rounded text-sm bg-red-600 hover:bg-red-500 text-white"
          >
            録画開始
          </button>
        </div>
      </div>
    </div>
  )
}

export default VideoExportModal
