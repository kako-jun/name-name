import { useState, useRef, useEffect, useMemo } from 'react'
import CanvasEditor from '../components/CanvasEditor'
import NovelPlayer from '../components/NovelPlayer'
import MapEditor from '../components/MapEditor'
import NPCEditor from '../components/NPCEditor'
import RPGPlayer from '../components/RPGPlayer'
import SaveDiscardButtons from '../components/SaveDiscardButtons'
import { Chapter, Mode, Event } from '../types'
import { RPGProject, MapData, NPCData } from '../types/rpg'
import { parseMarkdown } from '../wasm/parser'

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
  const [editorTab, setEditorTab] = useState<'novel' | 'rpg'>('novel')
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [selectedCutId, setSelectedCutId] = useState<number | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const saveTimeoutRef = useRef<number | null>(null)
  const initialChaptersRef = useRef<string>('')
  const [rawMarkdown, setRawMarkdown] = useState<string>('')
  const [wasmEvents, setWasmEvents] = useState<Event[]>([])
  const [wasmReady, setWasmReady] = useState(false)

  // RPGエディタ用の状態
  const [rpgProject, setRpgProject] = useState<RPGProject>(() => {
    const mapWidth = 25
    const mapHeight = 19
    return {
      name: projectName,
      version: '1.0.0',
      map: {
        width: mapWidth,
        height: mapHeight,
        tileSize: 32,
        tiles: Array.from({ length: mapHeight }, (_, y) =>
          Array.from({ length: mapWidth }, (_, x) =>
            x === 0 || x === mapWidth - 1 || y === 0 || y === mapHeight - 1 ? 2 : 0
          )
        ),
      },
      player: { x: 5, y: 5, direction: 'down' },
      npcs: [],
    }
  })
  const [rpgSubTab, setRpgSubTab] = useState<'map' | 'npc' | 'play'>('map')

  // WASMパース結果からフラットなEvent[]を組み立てる
  const flattenDocumentEvents = (doc: import('../types').EventDocument): Event[] => {
    const events: Event[] = []
    for (const chapter of doc.chapters) {
      for (let si = 0; si < chapter.scenes.length; si++) {
        if (events.length > 0) {
          events.push('SceneTransition')
        }
        events.push(...chapter.scenes[si].events)
      }
    }
    return events
  }

  // MarkdownをWASMでパースしてeventsを更新
  const parseAndSetEvents = async (markdown: string) => {
    if (!markdown.trim()) return
    try {
      const doc = await parseMarkdown(markdown)
      setWasmEvents(flattenDocumentEvents(doc))
      setWasmReady(true)
    } catch (parseError) {
      console.error('WASM parse failed:', parseError)
      setSaveError('Markdownのパースに失敗しました')
    }
  }

  // 初回ロード: APIからMarkdownを取得しWASMでパース
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
        if (!response.ok) {
          console.error(`Failed to load chapters: ${response.status}`)
          return
        }
        const data = await response.json()
        const markdown = data.content || ''
        setRawMarkdown(markdown)
        initialChaptersRef.current = markdown

        // WASMパースでEventsを生成
        await parseAndSetEvents(markdown)

        // 旧モデルへの変換（キャンバスエディタ用、後方互換）
        if (data.chapters) {
          setChapters(data.chapters)
        }

        // git statusをチェック
        const statusResponse = await fetch(`${apiBaseUrl}/api/projects/${projectName}/status`)
        if (statusResponse.ok) {
          const statusData = await statusResponse.json()
          setHasUnsavedChanges(statusData.has_uncommitted_changes)
        }
      } catch (error) {
        console.error('Failed to load chapters:', error)
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
          const hasLocalChanges =
            initialChaptersRef.current !== '' && rawMarkdown !== initialChaptersRef.current
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
  }, [apiBaseUrl, projectName, rawMarkdown])

  // Markdownの変更を検出（即座に反映）
  useEffect(() => {
    if (initialChaptersRef.current === '') return
    if (rawMarkdown !== initialChaptersRef.current) {
      setHasUnsavedChanges(true)
    }
  }, [rawMarkdown])

  // rawMarkdownが変更されたら自動的にワーキングディレクトリに保存
  useEffect(() => {
    if (!rawMarkdown || rawMarkdown === initialChaptersRef.current) return

    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: rawMarkdown }),
        })
        if (!response.ok) {
          console.error(`Failed to auto-save: ${response.status}`)
        }
      } catch (error) {
        console.error('Failed to auto-save:', error)
      }
    }, 1000)

    return () => {
      if (saveTimeoutRef.current !== null) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [rawMarkdown, apiBaseUrl, projectName])

  // 保存ボタン: Gitコミット・プッシュ
  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '原稿保存',
        }),
      })
      if (!response.ok) {
        console.error(`Failed to commit: ${response.status}`)
        setSaveError('保存に失敗しました')
        return
      }
      // 保存成功後、初期状態を更新
      initialChaptersRef.current = rawMarkdown
      setHasUnsavedChanges(false)
    } catch (error) {
      console.error('Failed to commit:', error)
      setSaveError('保存に失敗しました')
    } finally {
      setIsSaving(false)
    }
  }

  // 破棄ボタン: 未コミットの変更を破棄
  const handleDiscard = async () => {
    setShowDiscardConfirm(false)
    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/discard`, {
        method: 'POST',
      })
      if (!response.ok) {
        console.error(`Failed to discard: ${response.status}`)
        setSaveError('変更の破棄に失敗しました')
        return
      }
      // データを再読み込み
      const chaptersResponse = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
      if (chaptersResponse.ok) {
        const data = await chaptersResponse.json()
        const markdown = data.content || ''
        setRawMarkdown(markdown)
        initialChaptersRef.current = markdown
        if (data.chapters) {
          setChapters(data.chapters)
        }
        // WASMパースを再実行
        await parseAndSetEvents(markdown)
      }
      setHasUnsavedChanges(false)
    } catch (error) {
      console.error('Failed to discard changes:', error)
      setSaveError('変更の破棄に失敗しました')
    } finally {
      setIsSaving(false)
    }
  }

  const generateEventsFromChapters = (): Event[] => {
    const events: Event[] = []
    chapters.forEach((chapter, ci) => {
      chapter.scenes.forEach((scene, si) => {
        // シーン境界で SceneTransition を挿入（最初のシーン以外）
        if (ci > 0 || si > 0) {
          events.push('SceneTransition')
        }
        scene.cuts.forEach((cut) => {
          if (cut.character) {
            events.push({
              Dialog: {
                character: cut.character || null,
                expression: cut.expression || null,
                position: null,
                text: cut.text ? cut.text.split('\n') : [''],
              },
            })
          } else {
            events.push({
              Narration: {
                text: cut.text ? cut.text.split('\n') : [''],
              },
            })
          }
        })
      })
    })
    return events
  }

  // WASMパース結果を優先、フォールバックとして旧モデルからの変換
  const novelEvents = useMemo(
    () => (wasmReady && wasmEvents.length > 0 ? wasmEvents : generateEventsFromChapters()),
    [wasmReady, wasmEvents, chapters]
  )

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
              Name × Name{' '}
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- {projectName}</span>
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

        {/* エディタタブ（ノベル / RPG） */}
        <div
          className={`px-6 flex gap-1 border-t ${isDark ? 'border-gray-700' : 'border-blue-100'}`}
        >
          {(['novel', 'rpg'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setEditorTab(tab)}
              className={`px-4 py-1.5 text-sm font-medium rounded-t transition-colors ${
                editorTab === tab
                  ? isDark
                    ? 'bg-gray-700 text-white'
                    : 'bg-white text-gray-900 border border-b-white border-blue-200'
                  : isDark
                    ? 'text-gray-400 hover:text-gray-200'
                    : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'novel' ? 'ノベル' : 'RPG'}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {editorTab === 'novel' ? (
          // ノベルエディタ
          mode === 'edit' ? (
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
              events={novelEvents}
              assetBaseUrl={`${apiBaseUrl}/api/projects/${projectName}/assets`}
            />
          )
        ) : (
          // RPGエディタ
          <div className="h-full flex flex-col">
            {/* RPGサブタブ */}
            <div
              className={`flex gap-1 px-4 py-2 border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}
            >
              {(['map', 'npc', 'play'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setRpgSubTab(tab)}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    rpgSubTab === tab
                      ? isDark
                        ? 'bg-blue-600 text-white'
                        : 'bg-blue-500 text-white'
                      : isDark
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                  }`}
                >
                  {tab === 'map' ? 'マップ' : tab === 'npc' ? 'NPC' : 'プレイ'}
                </button>
              ))}
            </div>

            {/* RPGサブタブコンテンツ */}
            <div className="flex-1 overflow-hidden">
              {rpgSubTab === 'map' && (
                <MapEditor
                  mapData={rpgProject.map}
                  onChange={(mapData: MapData) => setRpgProject({ ...rpgProject, map: mapData })}
                  isDark={isDark}
                />
              )}
              {rpgSubTab === 'npc' && (
                <NPCEditor
                  npcs={rpgProject.npcs}
                  mapData={rpgProject.map}
                  onChange={(npcs: NPCData[]) => setRpgProject({ ...rpgProject, npcs })}
                  isDark={isDark}
                />
              )}
              {rpgSubTab === 'play' && <RPGPlayer gameData={rpgProject} />}
            </div>
          </div>
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

      {/* エラーメッセージ */}
      {saveError && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100]">
          <div
            className={`px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 ${
              isDark ? 'bg-red-900 text-red-200' : 'bg-red-100 text-red-800'
            }`}
          >
            <span className="text-sm">{saveError}</span>
            <button
              onClick={() => setSaveError(null)}
              className="ml-2 text-xs opacity-70 hover:opacity-100"
            >
              ✕
            </button>
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
        mode={editorTab === 'novel' ? mode : undefined}
        onModeChange={editorTab === 'novel' ? setMode : undefined}
      />
    </div>
  )
}

export default EditorScreen
