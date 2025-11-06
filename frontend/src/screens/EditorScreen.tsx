import { useState, useRef, useEffect } from 'react'
import CanvasEditor from '../components/CanvasEditor'
import NovelPlayer from '../components/NovelPlayer'
import { Chapter, Mode } from '../types'

interface ScriptRow {
  id: number
  character: string
  text: string
  expression: string
}

interface EditorScreenProps {
  projectName: string
  apiBaseUrl: string
  isDark: boolean
  onBack: () => void
  onToggleDark: () => void
  onOpenSettings: () => void
}

function EditorScreen({
  projectName,
  apiBaseUrl,
  isDark,
  onBack,
  onToggleDark,
  onOpenSettings,
}: EditorScreenProps) {
  const [mode, setMode] = useState<Mode>('edit')
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [selectedCutId, setSelectedCutId] = useState<number | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const saveTimeoutRef = useRef<number | null>(null)

  // 初回ロード: APIから章データを取得
  useEffect(() => {
    const loadChapters = async () => {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
      if (!response.ok) {
        throw new Error(`Failed to load chapters: ${response.status}`)
      }
      const data = await response.json()
      setChapters(data.chapters)
    }
    loadChapters()
  }, [apiBaseUrl, projectName])

  // 未コミットの変更があるかチェック
  useEffect(() => {
    const checkStatus = async () => {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/status`)
      if (!response.ok) {
        throw new Error(`Failed to check status: ${response.status}`)
      }
      const data = await response.json()
      setHasUnsavedChanges(data.has_uncommitted_changes)
    }
    checkStatus()
    const interval = setInterval(checkStatus, 5000)
    return () => clearInterval(interval)
  }, [apiBaseUrl, projectName])

  // 章データが変更されたら自動的にワーキングディレクトリに保存
  useEffect(() => {
    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapters: chapters,
          message: '自動保存',
        }),
      })
      if (!response.ok) {
        throw new Error(`Failed to auto-save: ${response.status}`)
      }
      setHasUnsavedChanges(true)
    }, 1000)

    return () => {
      if (saveTimeoutRef.current !== null) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [chapters, apiBaseUrl, projectName])

  // 保存ボタン: Gitコミット・プッシュ
  const handleSave = async () => {
    setIsSaving(true)
    const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '原稿保存',
      }),
    })
    if (!response.ok) {
      setIsSaving(false)
      throw new Error(`Failed to commit: ${response.status}`)
    }
    setHasUnsavedChanges(false)
    setIsSaving(false)
  }

  const generateScriptFromChapters = (): ScriptRow[] => {
    return chapters.flatMap((chapter) =>
      chapter.scenes.flatMap((scene) =>
        scene.cuts.map((cut) => ({
          id: cut.id,
          character: cut.character,
          text: cut.text,
          expression: cut.expression,
        }))
      )
    )
  }

  const getStartIndexFromSelectedCut = (): number => {
    if (selectedCutId === null) return 0
    const script = generateScriptFromChapters()
    const index = script.findIndex((row) => row.id === selectedCutId)
    return index !== -1 ? index : 0
  }

  return (
    <div className={`flex flex-col h-screen ${isDark ? 'dark bg-gray-900' : 'bg-white'}`}>
      <header
        className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
      >
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="プロジェクト一覧に戻る"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h1 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Name × Name <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- {projectName}</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleDark}
              className={`w-10 h-10 flex items-center justify-center rounded transition-colors ${
                isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
              }`}
              title={isDark ? 'Light Mode' : 'Dark Mode'}
            >
              {isDark ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                  />
                </svg>
              )}
            </button>
            <button
              onClick={onOpenSettings}
              className={`w-10 h-10 flex items-center justify-center rounded transition-colors ${
                isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end">
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
            onClick={() => setMode('edit')}
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
            onClick={() => setMode('play')}
            title="Play Mode"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>

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
          onClick={handleSave}
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
                d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
              />
            </svg>
          )}
        </button>
      </div>

      <main className="flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <CanvasEditor
            chapters={chapters}
            setChapters={setChapters}
            isDark={isDark}
            selectedCutId={selectedCutId}
            setSelectedCutId={setSelectedCutId}
          />
        ) : (
          <NovelPlayer
            scriptData={generateScriptFromChapters()}
            startIndex={getStartIndexFromSelectedCut()}
          />
        )}
      </main>
    </div>
  )
}

export default EditorScreen
