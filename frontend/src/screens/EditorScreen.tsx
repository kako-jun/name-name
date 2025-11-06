import { useState, useRef, useEffect } from 'react'
import CanvasEditor from '../components/CanvasEditor'
import NovelPlayer from '../components/NovelPlayer'
import SaveDiscardButtons from '../components/SaveDiscardButtons'
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
  onNavigateToAssets: () => void
}

function EditorScreen({
  projectName,
  apiBaseUrl,
  isDark,
  onBack,
  onToggleDark,
  onOpenSettings,
  onNavigateToAssets,
}: EditorScreenProps) {
  const [mode, setMode] = useState<Mode>('edit')
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [selectedCutId, setSelectedCutId] = useState<number | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const saveTimeoutRef = useRef<number | null>(null)
  const initialChaptersRef = useRef<string>('')

  // 初回ロード: APIから章データを取得
  useEffect(() => {
    const loadChapters = async () => {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
      if (!response.ok) {
        throw new Error(`Failed to load chapters: ${response.status}`)
      }
      const data = await response.json()
      setChapters(data.chapters)
      // 初期状態を保存
      initialChaptersRef.current = JSON.stringify(data.chapters)

      // git statusをチェックして、未コミットの変更があればボタンを青くする
      const statusResponse = await fetch(`${apiBaseUrl}/api/projects/${projectName}/status`)
      if (statusResponse.ok) {
        const statusData = await statusResponse.json()
        setHasUnsavedChanges(statusData.has_uncommitted_changes)
      }
    }
    loadChapters()
  }, [apiBaseUrl, projectName])

  // 5秒ごとにgit statusをチェック（ただしフロント側の変更を優先）
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/status`)
        if (response.ok) {
          const data = await response.json()
          // フロント側で変更がない場合のみ、サーバー側の状態を反映
          const currentChapters = JSON.stringify(chapters)
          const hasLocalChanges = initialChaptersRef.current !== '' && currentChapters !== initialChaptersRef.current
          if (!hasLocalChanges) {
            setHasUnsavedChanges(data.has_uncommitted_changes)
          } else {
            // フロント側で変更がある場合は常にtrue
            setHasUnsavedChanges(true)
          }
        }
      } catch (error) {
        console.error('Failed to check status:', error)
      }
    }

    const interval = setInterval(checkStatus, 5000)
    return () => clearInterval(interval)
  }, [apiBaseUrl, projectName, chapters])

  // 章データの変更を検出（即座に反映）
  useEffect(() => {
    if (initialChaptersRef.current === '') return
    const currentChapters = JSON.stringify(chapters)
    const hasChanges = currentChapters !== initialChaptersRef.current
    if (hasChanges) {
      setHasUnsavedChanges(true)
    }
  }, [chapters])

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
    // 保存成功後、初期状態を更新
    initialChaptersRef.current = JSON.stringify(chapters)
    setHasUnsavedChanges(false)
    setIsSaving(false)
  }

  // 破棄ボタン: 未コミットの変更を破棄
  const handleDiscard = async () => {
    setShowDiscardConfirm(false)
    setIsSaving(true)
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/discard`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(`Failed to discard: ${response.status}`)
      }
      // データを再読み込み
      const chaptersResponse = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
      if (chaptersResponse.ok) {
        const data = await chaptersResponse.json()
        setChapters(data.chapters)
        initialChaptersRef.current = JSON.stringify(data.chapters)
      }
      setHasUnsavedChanges(false)
    } catch (error) {
      console.error('Failed to discard changes:', error)
    } finally {
      setIsSaving(false)
    }
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

      <main className="flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <CanvasEditor
            chapters={chapters}
            setChapters={setChapters}
            isDark={isDark}
            selectedCutId={selectedCutId}
            setSelectedCutId={setSelectedCutId}
            onNavigateToAssets={onNavigateToAssets}
          />
        ) : (
          <NovelPlayer
            scriptData={generateScriptFromChapters()}
            startIndex={getStartIndexFromSelectedCut()}
          />
        )}
      </main>

      {/* 破棄確認ダイアログ */}
      {showDiscardConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
          <div
            className={`p-6 rounded-lg shadow-xl max-w-md w-full ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
          >
            <h2 className="text-xl font-bold mb-4">変更を破棄しますか？</h2>
            <p className={`mb-6 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              未コミットの変更がすべて失われます。この操作は取り消せません。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDiscardConfirm(false)}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                キャンセル
              </button>
              <button
                onClick={handleDiscard}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-red-500 hover:bg-red-600 text-white'
                }`}
              >
                破棄
              </button>
            </div>
          </div>
        </div>
      )}

      {/* プレイモード切替 & セーブ/アンドゥボタン */}
      <SaveDiscardButtons
        hasUnsavedChanges={hasUnsavedChanges}
        isSaving={isSaving}
        isDark={isDark}
        onSave={handleSave}
        onDiscard={() => setShowDiscardConfirm(true)}
        mode={mode}
        onModeChange={setMode}
      />
    </div>
  )
}

export default EditorScreen
