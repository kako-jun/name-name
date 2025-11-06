interface SaveDiscardButtonsProps {
  hasUnsavedChanges: boolean
  isSaving: boolean
  isDark: boolean
  onSave: () => void
  onDiscard: () => void
  // プレイモード関連（オプション）
  mode?: 'edit' | 'play'
  onModeChange?: (mode: 'edit' | 'play') => void
}

function SaveDiscardButtons({
  hasUnsavedChanges,
  isSaving,
  isDark,
  onSave,
  onDiscard,
  mode,
  onModeChange,
}: SaveDiscardButtonsProps) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end">
      {/* プレイモード切替（オプション） */}
      {mode && onModeChange && (
        <div className="flex gap-2">
          <button
            className={`w-12 h-12 flex items-center justify-center transition-colors rounded-lg shadow-md border ${
              mode === 'edit'
                ? isDark
                  ? 'bg-gray-700 text-white border-gray-600'
                  : 'bg-gray-900 text-white border-gray-800'
                : isDark
                  ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 border-gray-700'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border-gray-300'
            }`}
            onClick={() => onModeChange('edit')}
            title="Edit Mode"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          <button
            className={`w-12 h-12 flex items-center justify-center transition-colors rounded-lg shadow-md border ${
              mode === 'play'
                ? isDark
                  ? 'bg-gray-700 text-white border-gray-600'
                  : 'bg-gray-900 text-white border-gray-800'
                : isDark
                  ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 border-gray-700'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border-gray-300'
            }`}
            onClick={() => onModeChange('play')}
            title="Play Mode"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>
      )}

      {/* アンドゥ/セーブボタン */}
      <div className="flex gap-2">
      {/* アンドゥボタン */}
      <button
        className={`w-12 h-12 flex items-center justify-center transition-colors rounded-lg shadow-md border ${
          hasUnsavedChanges && !isSaving
            ? isDark
              ? 'bg-gray-700 text-white border-gray-600 hover:bg-gray-600'
              : 'bg-gray-400 text-white border-gray-300 hover:bg-gray-500'
            : isDark
              ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed'
              : 'bg-gray-200 text-gray-400 border-gray-300 cursor-not-allowed'
        }`}
        onClick={onDiscard}
        disabled={!hasUnsavedChanges || isSaving}
        title={hasUnsavedChanges ? '変更を破棄' : '変更なし'}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
          />
        </svg>
      </button>

      {/* セーブボタン */}
      <button
        className={`w-12 h-12 flex items-center justify-center transition-colors rounded-lg shadow-md border ${
          hasUnsavedChanges && !isSaving
            ? isDark
              ? 'bg-blue-600 text-white border-blue-500 hover:bg-blue-700'
              : 'bg-blue-500 text-white border-blue-400 hover:bg-blue-600'
            : isDark
              ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed'
              : 'bg-gray-200 text-gray-400 border-gray-300 cursor-not-allowed'
        }`}
        onClick={onSave}
        disabled={!hasUnsavedChanges || isSaving}
        title={hasUnsavedChanges ? 'Gitにコミット・プッシュ' : '保存済み'}
      >
        {isSaving ? (
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"
            />
            <polyline
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              points="17 21 17 13 7 13 7 21"
            />
            <polyline
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              points="7 3 7 8 15 8"
            />
          </svg>
        )}
      </button>
      </div>
    </div>
  )
}

export default SaveDiscardButtons
