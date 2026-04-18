import { useState, useRef, useEffect, useMemo } from 'react'
import CanvasEditor from '../components/CanvasEditor'
import NovelPlayer from '../components/NovelPlayer'
import MapEditor from '../components/MapEditor'
import NPCEditor from '../components/NPCEditor'
import RPGPlayer from '../components/RPGPlayer'
import SaveDiscardButtons from '../components/SaveDiscardButtons'
import type { Mode, Event, EventDocument, EventRef } from '../types'
import { RPGProject, MapData, NPCData } from '../types/rpg'
import { parseMarkdown, emitMarkdown } from '../wasm/parser'
import {
  rpgProjectFromDoc,
  applyRpgProjectToDoc,
  findRpgSceneIndex,
} from '../game/rpgProjectFromDoc'

interface EditorScreenProps {
  projectName: string
  apiBaseUrl: string
  isDark: boolean
  onBack: () => void
  onToggleDark: () => void
  onOpenSettings: () => void
  onNavigateToAssets: () => void
}

/**
 * EventDocument を「最初のシーン以外の前に SceneTransition を挟んだ」フラット Event[] に変換する。
 * NovelPlayer に食わせるための整形。
 */
function flattenDocumentEvents(doc: EventDocument): Event[] {
  const events: Event[] = []
  let first = true
  for (const chapter of doc.chapters) {
    for (const scene of chapter.scenes) {
      if (!first) {
        events.push('SceneTransition')
      }
      first = false
      events.push(...scene.events)
    }
  }
  return events
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
  const [doc, setDoc] = useState<EventDocument | null>(null)
  // CanvasEditor を再マウントしてエディタ内部 state を完全リセットするためのバージョン。
  // discard 成功時などにインクリメントする。
  const [docVersion, setDocVersion] = useState(0)
  const [selectedEvent, setSelectedEvent] = useState<EventRef | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const saveTimeoutRef = useRef<number | null>(null)
  const initialMarkdownRef = useRef<string>('')
  const [rawMarkdown, setRawMarkdown] = useState<string>('')
  const [rpgSubTab, setRpgSubTab] = useState<'map' | 'npc' | 'play'>('map')
  // 現在 RPG タブが編集対象としているシーン ID（doc 内の最初の RPG シーン）
  const [rpgSceneId, setRpgSceneId] = useState<string | null>(null)

  // doc から RPGProject を導出（メモ化）。見つかったシーン ID も rpgSceneId に同期。
  const rpgProject: RPGProject | null = useMemo(() => {
    if (!doc) return null
    const found = findRpgSceneIndex(doc)
    if (!found) return null
    const sceneIdForThisDoc =
      doc.chapters[found.chapterIndex]?.scenes[found.sceneIndex]?.id ?? null
    // シーン ID が変わったら state を同期（描画中は setState を直接呼ばず副作用で）
    if (sceneIdForThisDoc !== rpgSceneId) {
      // 次 tick で同期（render 中に setState すると警告が出るため）
      queueMicrotask(() => setRpgSceneId(sceneIdForThisDoc))
    }
    return rpgProjectFromDoc(doc, sceneIdForThisDoc ?? undefined, projectName)
  }, [doc, projectName, rpgSceneId])

  // ユーザー操作で doc が変わったら emit し、rawMarkdown を更新する。
  // rawMarkdown の更新は autosave useEffect 経由で backend に PUT される。
  // emit が失敗した場合は rawMarkdown と doc の desync を避けるため、doc を元に戻す。
  const handleDocChange = async (newDoc: EventDocument) => {
    const prev = doc
    setDoc(newDoc)
    try {
      const md = await emitMarkdown(newDoc)
      setRawMarkdown(md)
    } catch (err) {
      console.error('emitMarkdown failed:', err)
      setDoc(prev)
      setSaveError('Markdown生成に失敗したため変更を破棄しました')
    }
  }

  // Markdown を WASM でパースして doc を更新
  const parseAndSetDoc = async (markdown: string) => {
    try {
      const parsed = await parseMarkdown(markdown)
      setDoc(parsed)
    } catch (parseError) {
      console.error('WASM parse failed:', parseError)
      setSaveError('Markdownのパースに失敗しました')
      // 空のドキュメントでフォールバック
      setDoc({ engine: 'name-name', chapters: [] })
    }
  }

  // RPGProject の変更を doc に書き戻し、Markdown に反映する
  const persistRpgProject = async (updated: RPGProject) => {
    if (!doc) return
    // 既に doc 内で特定済みの RPG シーン ID を対象にする（未設定なら
    // applyRpgProjectToDoc 内のフォールバックで最初の RPG シーンに書き戻される）
    const targetSceneId = rpgSceneId ?? 'rpg-map'
    const newDoc = applyRpgProjectToDoc(doc, updated, targetSceneId)
    await handleDocChange(newDoc)
  }

  // 空の RPG シーンを追加する。doc がロード済みでない間は呼ばない（ボタン側で disabled）
  const addEmptyRpgScene = async () => {
    if (!doc) return
    const mapWidth = 20
    const mapHeight = 15
    const emptyProject: RPGProject = {
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
    const newSceneId = 'rpg-map'
    const newDoc = applyRpgProjectToDoc(doc, emptyProject, newSceneId)
    setRpgSceneId(newSceneId)
    await handleDocChange(newDoc)
  }

  // 初回ロード: APIからMarkdownを取得しWASMでパース
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
        if (!response.ok) {
          console.error(`Failed to load chapters: ${response.status}`)
          // ロード失敗時もエディタで操作を開始できるよう、空 doc にフォールバックする
          setDoc({ engine: 'name-name', chapters: [] })
          setSaveError('プロジェクトの読み込みに失敗しました')
          return
        }
        const data = await response.json()
        const markdown = data.content || ''
        setRawMarkdown(markdown)
        initialMarkdownRef.current = markdown

        await parseAndSetDoc(markdown)

        // git statusをチェック
        const statusResponse = await fetch(`${apiBaseUrl}/api/projects/${projectName}/status`)
        if (statusResponse.ok) {
          const statusData = await statusResponse.json()
          setHasUnsavedChanges(statusData.has_uncommitted_changes)
        }
      } catch (error) {
        console.error('Failed to load chapters:', error)
        setDoc({ engine: 'name-name', chapters: [] })
        setSaveError('プロジェクトの読み込みに失敗しました')
      }
    }
    loadChapters()
  }, [apiBaseUrl, projectName])

  // 5秒ごとにgit statusをチェック（フロント側の変更を優先）
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/status`)
        if (response.ok) {
          const data = await response.json()
          const hasLocalChanges =
            initialMarkdownRef.current !== '' && rawMarkdown !== initialMarkdownRef.current
          if (!hasLocalChanges) {
            setHasUnsavedChanges(data.has_uncommitted_changes)
          } else {
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

  // Markdownの変更を検出
  useEffect(() => {
    if (initialMarkdownRef.current === '') return
    if (rawMarkdown !== initialMarkdownRef.current) {
      setHasUnsavedChanges(true)
    }
  }, [rawMarkdown])

  // rawMarkdownが変更されたら自動的にワーキングディレクトリに保存
  useEffect(() => {
    if (!rawMarkdown || rawMarkdown === initialMarkdownRef.current) return

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
      initialMarkdownRef.current = rawMarkdown
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
      const chaptersResponse = await fetch(`${apiBaseUrl}/api/projects/${projectName}/chapters`)
      if (chaptersResponse.ok) {
        const data = await chaptersResponse.json()
        const markdown = data.content || ''
        setRawMarkdown(markdown)
        initialMarkdownRef.current = markdown
        await parseAndSetDoc(markdown)
      }
      // discard で doc が差し替わるため、選択状態・CanvasEditor 内部 state を完全リセット
      setSelectedEvent(null)
      setRpgSceneId(null)
      setDocVersion((v) => v + 1)
      setHasUnsavedChanges(false)
    } catch (error) {
      console.error('Failed to discard changes:', error)
      setSaveError('変更の破棄に失敗しました')
    } finally {
      setIsSaving(false)
    }
  }

  // プレイモード用のフラット Event[]
  const novelEvents = useMemo(() => (doc ? flattenDocumentEvents(doc) : []), [doc])

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
          mode === 'edit' ? (
            doc !== null ? (
              <CanvasEditor
                key={docVersion}
                doc={doc}
                onDocChange={handleDocChange}
                isDark={isDark}
                selectedEvent={selectedEvent}
                setSelectedEvent={setSelectedEvent}
                onNavigateToAssets={onNavigateToAssets}
              />
            ) : (
              <div
                className={`flex items-center justify-center h-full ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
              >
                読み込み中...
              </div>
            )
          ) : (
            <NovelPlayer
              events={novelEvents}
              assetBaseUrl={`${apiBaseUrl}/api/projects/${projectName}/assets`}
            />
          )
        ) : (
          // RPGエディタ
          <div className="h-full flex flex-col">
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

            <div className="flex-1 overflow-hidden">
              {rpgProject === null ? (
                <div className={`h-full flex flex-col items-center justify-center gap-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  <p className="text-sm">このプロジェクトにはまだRPGシーンがありません。</p>
                  <button
                    onClick={addEmptyRpgScene}
                    disabled={!doc}
                    className={`px-4 py-2 rounded font-medium transition-colors ${
                      !doc
                        ? isDark
                          ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                          : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : isDark
                          ? 'bg-blue-600 hover:bg-blue-700 text-white'
                          : 'bg-blue-500 hover:bg-blue-600 text-white'
                    }`}
                  >
                    + RPGシーンを追加
                  </button>
                </div>
              ) : (
                <>
                  {rpgSubTab === 'map' && (
                    <MapEditor
                      mapData={rpgProject.map}
                      onChange={(mapData: MapData) => {
                        void persistRpgProject({ ...rpgProject, map: mapData })
                      }}
                      isDark={isDark}
                    />
                  )}
                  {rpgSubTab === 'npc' && (
                    <NPCEditor
                      npcs={rpgProject.npcs}
                      mapData={rpgProject.map}
                      onChange={(npcs: NPCData[]) => {
                        void persistRpgProject({ ...rpgProject, npcs })
                      }}
                      isDark={isDark}
                    />
                  )}
                  {rpgSubTab === 'play' && <RPGPlayer gameData={rpgProject ?? undefined} />}
                </>
              )}
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
