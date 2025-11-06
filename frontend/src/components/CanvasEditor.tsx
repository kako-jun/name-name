import React, { useState, useRef, useEffect } from 'react'
import { Chapter, Viewport, Cut } from '../types'
import ChapterCard from './ChapterCard'

interface CanvasEditorProps {
  chapters: Chapter[]
  setChapters: (chapters: Chapter[]) => void
  isDark: boolean
  selectedCutId: number | null
  setSelectedCutId: (id: number | null) => void
  onNavigateToAssets: () => void
}

function CanvasEditor({
  chapters,
  setChapters,
  isDark,
  selectedCutId,
  setSelectedCutId,
  onNavigateToAssets,
}: CanvasEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })
  const [searchQuery, setSearchQuery] = useState('')
  const [editingCutId, setEditingCutId] = useState<number | null>(null)
  const [editingSceneId, setEditingSceneId] = useState<number | null>(null)
  const [editingChapterId, setEditingChapterId] = useState<number | null>(null)
  const [newlyAddedCutId, setNewlyAddedCutId] = useState<number | null>(null)
  const [newlyAddedSceneId, setNewlyAddedSceneId] = useState<number | null>(null)
  const [newlyAddedChapterId, setNewlyAddedChapterId] = useState<number | null>(null)
  const [draggedCut, setDraggedCut] = useState<{
    chapterId: number
    sceneId: number
    cutId: number
  } | null>(null)
  const [draggedScene, setDraggedScene] = useState<{
    chapterId: number
    sceneId: number
  } | null>(null)
  const [draggedChapter, setDraggedChapter] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    chapterId: number
    sceneId: number
    position: number
  } | null>(null)
  const [sceneDropTarget, setSceneDropTarget] = useState<{
    chapterId: number
    position: number
  } | null>(null)
  const [chapterDropTarget, setChapterDropTarget] = useState<number | null>(null)

  // 編集モード終了の検知
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (editingRef.current && !editingRef.current.contains(e.target as Node)) {
        handleEditingEnd()
      }
    }

    const handleEscKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleEditingEnd()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscKey)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscKey)
    }
  }, [
    editingCutId,
    editingSceneId,
    editingChapterId,
    newlyAddedCutId,
    newlyAddedSceneId,
    newlyAddedChapterId,
    chapters,
  ])

  // 編集モード終了時の処理
  const handleEditingEnd = () => {
    // 新規追加されたカットがデフォルト値のままなら削除
    if (newlyAddedCutId !== null) {
      const cut = chapters
        .flatMap((ch) => ch.scenes)
        .flatMap((sc) => sc.cuts)
        .find((c) => c.id === newlyAddedCutId)

      if (cut && cut.character === '' && cut.text === '' && cut.expression === '') {
        // デフォルト値のままなので削除
        const newChapters = chapters.map((chapter) => ({
          ...chapter,
          scenes: chapter.scenes.map((scene) => ({
            ...scene,
            cuts: scene.cuts.filter((c) => c.id !== newlyAddedCutId),
          })),
        }))
        setChapters(newChapters)
      }
      setNewlyAddedCutId(null)
    }

    // 新規追加されたシーンがデフォルト値のままなら削除
    if (newlyAddedSceneId !== null) {
      const scene = chapters.flatMap((ch) => ch.scenes).find((sc) => sc.id === newlyAddedSceneId)

      if (scene && scene.title === '新しいシーン' && scene.cuts.length === 0) {
        // デフォルト値のままなので削除
        const newChapters = chapters.map((chapter) => ({
          ...chapter,
          scenes: chapter.scenes.filter((sc) => sc.id !== newlyAddedSceneId),
        }))
        setChapters(newChapters)
      }
      setNewlyAddedSceneId(null)
    }

    // 新規追加された章がデフォルト値のままなら削除
    if (newlyAddedChapterId !== null) {
      const chapter = chapters.find((ch) => ch.id === newlyAddedChapterId)

      if (chapter && chapter.title === '新しい章' && chapter.scenes.length === 0) {
        // デフォルト値のままなので削除
        const newChapters = chapters.filter((ch) => ch.id !== newlyAddedChapterId)
        setChapters(newChapters)
      }
      setNewlyAddedChapterId(null)
    }

    setEditingCutId(null)
    setEditingSceneId(null)
    setEditingChapterId(null)
  }

  // カットの編集
  const handleCutChange = (
    chapterId: number,
    sceneId: number,
    cutId: number,
    field: 'character' | 'text' | 'expression',
    value: string
  ) => {
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => {
            if (scene.id === sceneId) {
              return {
                ...scene,
                cuts: scene.cuts.map((cut) => {
                  if (cut.id === cutId) {
                    return { ...cut, [field]: value }
                  }
                  return cut
                }),
              }
            }
            return scene
          }),
        }
      }
      return chapter
    })
    setChapters(newChapters)
  }

  // カットのドラッグ開始
  const handleDragStart = (chapterId: number, sceneId: number, cutId: number) => {
    setDraggedCut({ chapterId, sceneId, cutId })
  }

  // カットのドラッグオーバー
  const handleDragOver = (
    e: React.DragEvent,
    chapterId: number,
    sceneId: number,
    position: number
  ) => {
    e.preventDefault()
    setDropTarget({ chapterId, sceneId, position })
  }

  // カットのドロップ
  const handleDrop = (e: React.DragEvent) => {
    e.stopPropagation()
    if (!draggedCut || !dropTarget) return

    // ドラッグ元のカットを取得
    let draggedCutData: Cut | null = null
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === draggedCut.chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => {
            if (scene.id === draggedCut.sceneId) {
              const cutIndex = scene.cuts.findIndex((c) => c.id === draggedCut.cutId)
              if (cutIndex !== -1) {
                draggedCutData = scene.cuts[cutIndex]
                return {
                  ...scene,
                  cuts: scene.cuts.filter((c) => c.id !== draggedCut.cutId),
                }
              }
            }
            return scene
          }),
        }
      }
      return chapter
    })

    // ドロップ先にカットを挿入
    const finalChapters = newChapters.map((chapter) => {
      if (chapter.id === dropTarget.chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => {
            if (scene.id === dropTarget.sceneId) {
              const newCuts = [...scene.cuts]
              newCuts.splice(dropTarget.position, 0, draggedCutData)
              return {
                ...scene,
                cuts: newCuts,
              }
            }
            return scene
          }),
        }
      }
      return chapter
    })

    setChapters(finalChapters)
    setDraggedCut(null)
    setDropTarget(null)
  }

  // カットのドラッグ終了
  const handleDragEnd = () => {
    setDraggedCut(null)
    setDropTarget(null)
  }

  // シーンのドラッグ開始
  const handleSceneDragStart = (chapterId: number, sceneId: number) => {
    setDraggedScene({ chapterId, sceneId })
  }

  // シーンのドラッグオーバー
  const handleSceneDragOver = (e: React.DragEvent, chapterId: number, position: number) => {
    e.preventDefault()
    e.stopPropagation()
    setSceneDropTarget({ chapterId, position })
  }

  // シーンのドロップ
  const handleSceneDrop = (e: React.DragEvent) => {
    e.stopPropagation()
    if (!draggedScene || !sceneDropTarget) return

    // ドラッグ元のシーンを取得
    const draggedSceneData = chapters
      .find((ch) => ch.id === draggedScene.chapterId)
      ?.scenes.find((sc) => sc.id === draggedScene.sceneId)

    if (!draggedSceneData) return

    // ドラッグ元からシーンを削除
    let newChapters = chapters.map((chapter) => {
      if (chapter.id === draggedScene.chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.filter((sc) => sc.id !== draggedScene.sceneId),
        }
      }
      return chapter
    })

    // ドロップ先にシーンを挿入
    newChapters = newChapters.map((chapter) => {
      if (chapter.id === sceneDropTarget.chapterId) {
        const newScenes = [...chapter.scenes]
        newScenes.splice(sceneDropTarget.position, 0, draggedSceneData)
        return { ...chapter, scenes: newScenes }
      }
      return chapter
    })

    setChapters(newChapters)
    setDraggedScene(null)
    setSceneDropTarget(null)
  }

  // シーンのドラッグ終了
  const handleSceneDragEnd = () => {
    setDraggedScene(null)
    setSceneDropTarget(null)
  }

  // 章のドラッグ開始
  const handleChapterDragStart = (chapterId: number) => {
    setDraggedChapter(chapterId)
  }

  // 章のドラッグオーバー
  const handleChapterDragOver = (e: React.DragEvent, position: number) => {
    e.preventDefault()
    e.stopPropagation()
    setChapterDropTarget(position)
  }

  // 章のドロップ
  const handleChapterDrop = (e: React.DragEvent) => {
    e.stopPropagation()
    if (draggedChapter === null || chapterDropTarget === null) return

    const draggedChapterData = chapters.find((ch) => ch.id === draggedChapter)
    if (!draggedChapterData) return

    // ドラッグ元から章を削除
    const newChapters = chapters.filter((ch) => ch.id !== draggedChapter)

    // ドロップ先に章を挿入
    newChapters.splice(chapterDropTarget, 0, draggedChapterData)

    setChapters(newChapters)
    setDraggedChapter(null)
    setChapterDropTarget(null)
  }

  // 章のドラッグ終了
  const handleChapterDragEnd = () => {
    setDraggedChapter(null)
    setChapterDropTarget(null)
  }

  // カットを追加
  const handleAddCut = (chapterId: number, sceneId: number, position: number) => {
    const maxCutId = Math.max(
      ...chapters.flatMap((ch) => ch.scenes.flatMap((sc) => sc.cuts.map((c) => c.id))),
      0
    )
    const newCut = {
      id: maxCutId + 1,
      character: '',
      text: '',
      expression: '',
    }

    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => {
            if (scene.id === sceneId) {
              const newCuts = [...scene.cuts]
              newCuts.splice(position, 0, newCut)
              return {
                ...scene,
                cuts: newCuts,
              }
            }
            return scene
          }),
        }
      }
      return chapter
    })

    setChapters(newChapters)
    setEditingCutId(newCut.id)
    setNewlyAddedCutId(newCut.id)
  }

  // カットを削除
  const handleDeleteCut = (chapterId: number, sceneId: number, cutId: number) => {
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => {
            if (scene.id === sceneId) {
              return {
                ...scene,
                cuts: scene.cuts.filter((c) => c.id !== cutId),
              }
            }
            return scene
          }),
        }
      }
      return chapter
    })
    setChapters(newChapters)
    setEditingCutId(null)
  }

  // シーンを追加
  const handleAddScene = (chapterId: number, position: number) => {
    const maxSceneId = Math.max(...chapters.flatMap((ch) => ch.scenes.map((sc) => sc.id)), 0)
    const newScene = { id: maxSceneId + 1, title: '新しいシーン', cuts: [] }
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        const newScenes = [...chapter.scenes]
        newScenes.splice(position, 0, newScene)
        return { ...chapter, scenes: newScenes }
      }
      return chapter
    })
    setChapters(newChapters)
    setEditingSceneId(newScene.id)
    setNewlyAddedSceneId(newScene.id)
  }

  // シーンを削除
  const handleDeleteScene = (chapterId: number, sceneId: number) => {
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.filter((s) => s.id !== sceneId),
        }
      }
      return chapter
    })
    setChapters(newChapters)
    setEditingSceneId(null)
  }

  // シーンのタイトルを変更
  const handleSceneTitleChange = (chapterId: number, sceneId: number, newTitle: string) => {
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        return {
          ...chapter,
          scenes: chapter.scenes.map((scene) => {
            if (scene.id === sceneId) {
              return { ...scene, title: newTitle }
            }
            return scene
          }),
        }
      }
      return chapter
    })
    setChapters(newChapters)
  }

  // 章を追加
  const handleAddChapter = (position: number) => {
    const maxChapterId = Math.max(...chapters.map((ch) => ch.id), 0)
    const newChapter = { id: maxChapterId + 1, title: '新しい章', scenes: [] }
    const newChapters = [...chapters]
    newChapters.splice(position, 0, newChapter)
    setChapters(newChapters)
    setEditingChapterId(newChapter.id)
    setNewlyAddedChapterId(newChapter.id)
  }

  // 章を削除
  const handleDeleteChapter = (chapterId: number) => {
    const newChapters = chapters.filter((ch) => ch.id !== chapterId)
    setChapters(newChapters)
    setEditingChapterId(null)
  }

  // 章のタイトルを変更
  const handleChapterTitleChange = (chapterId: number, newTitle: string) => {
    const newChapters = chapters.map((chapter) => {
      if (chapter.id === chapterId) {
        return { ...chapter, title: newTitle }
      }
      return chapter
    })
    setChapters(newChapters)
  }

  // 章の編集を開始（他の編集モードを終了）
  const handleStartEditingChapter = (chapterId: number) => {
    setEditingCutId(null)
    setEditingSceneId(null)
    setEditingChapterId(chapterId)
  }

  // シーンの編集を開始（他の編集モードを終了）
  const handleStartEditingScene = (sceneId: number) => {
    setEditingCutId(null)
    setEditingChapterId(null)
    setEditingSceneId(sceneId)
  }

  // カットの編集を開始（他の編集モードを終了）
  const handleStartEditingCut = (cutId: number) => {
    setEditingChapterId(null)
    setEditingSceneId(null)
    setEditingCutId(cutId)
  }

  // カットの選択（編集モードを終了）
  const handleSelectCut = (cutId: number) => {
    setEditingChapterId(null)
    setEditingSceneId(null)
    setEditingCutId(null)
    setSelectedCutId(cutId)
  }

  // ホイールでズーム
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()

      const delta = e.deltaY
      const zoomFactor = delta > 0 ? 0.9 : 1.1
      const newZoom = Math.min(Math.max(viewport.zoom * zoomFactor, 0.1), 1)

      // ズームが実際に変化しない場合は何もしない
      if (newZoom === viewport.zoom) return

      // マウス位置を中心にズーム
      const rect = container.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const worldX = (mouseX - viewport.x) / viewport.zoom
      const worldY = (mouseY - viewport.y) / viewport.zoom

      const newX = mouseX - worldX * newZoom
      const newY = mouseY - worldY * newZoom

      setViewport({ x: newX, y: newY, zoom: newZoom })
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [viewport])

  // パン操作
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsPanning(true)
      setPanStart({ x: e.clientX - viewport.x, y: e.clientY - viewport.y })
      e.preventDefault()
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      const newX = e.clientX - panStart.x
      const newY = e.clientY - panStart.y
      setViewport({ ...viewport, x: newX, y: newY })
    }
  }

  const handleMouseUp = () => {
    setIsPanning(false)
  }

  // カーソルの変更
  const cursor = isPanning ? 'grabbing' : 'grab'

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor }}
    >
      {/* ズーム・パンが適用されるコンテンツ領域 */}
      <div
        style={{
          transform: `scale(${viewport.zoom}) translate(${viewport.x / viewport.zoom}px, ${viewport.y / viewport.zoom}px)`,
          transformOrigin: '0 0',
          transition: isPanning ? 'none' : 'transform 0.1s ease-out',
        }}
      >
        {/* 章ごとに横並びで表示 */}
        <div className="flex gap-8 p-8">
          {chapters.map((chapter, chapterIndex) => (
            <ChapterCard
              key={chapter.id}
              chapter={chapter}
              chapterIndex={chapterIndex}
              isDark={isDark}
              editingChapterId={editingChapterId}
              editingSceneId={editingSceneId}
              editingCutId={editingCutId}
              newlyAddedCutId={newlyAddedCutId}
              selectedCutId={selectedCutId}
              editingRef={editingRef}
              draggedChapter={draggedChapter}
              chapterDropTarget={chapterDropTarget}
              draggedScene={draggedScene}
              sceneDropTarget={sceneDropTarget}
              draggedCut={draggedCut}
              dropTarget={dropTarget}
              onChapterTitleChange={handleChapterTitleChange}
              onDeleteChapter={handleDeleteChapter}
              onStartEditingChapter={handleStartEditingChapter}
              onChapterDragStart={handleChapterDragStart}
              onChapterDragEnd={handleChapterDragEnd}
              onChapterDragOver={handleChapterDragOver}
              onChapterDrop={handleChapterDrop}
              onAddChapter={handleAddChapter}
              onAddScene={handleAddScene}
              onSceneTitleChange={handleSceneTitleChange}
              onDeleteScene={handleDeleteScene}
              onStartEditingScene={handleStartEditingScene}
              onSceneDragStart={handleSceneDragStart}
              onSceneDragEnd={handleSceneDragEnd}
              onSceneDragOver={handleSceneDragOver}
              onSceneDrop={handleSceneDrop}
              onAddCut={handleAddCut}
              onCutChange={handleCutChange}
              onDeleteCut={handleDeleteCut}
              onStartEditingCut={handleStartEditingCut}
              onSelectCut={handleSelectCut}
              onCutDragStart={handleDragStart}
              onCutDragEnd={handleDragEnd}
              onCutDragOver={handleDragOver}
              onCutDrop={handleDrop}
            />
          ))}

          {/* 最後の章の追加ボタン */}
          {draggedChapter !== null && (
            <div
              draggable={false}
              className={`group w-12 flex-shrink-0 flex items-start justify-center pt-8 transition-all rounded cursor-pointer ${
                chapterDropTarget === chapters.length
                  ? isDark
                    ? 'bg-indigo-900/40 border-2 border-indigo-400'
                    : 'bg-indigo-100 border-2 border-indigo-600'
                  : isDark
                    ? 'bg-gray-700/20 hover:bg-gray-700/40'
                    : 'bg-gray-200/50 hover:bg-gray-200'
              }`}
              onClick={() => handleAddChapter(chapters.length)}
              onDragOver={(e) => handleChapterDragOver(e, chapters.length)}
              onDrop={handleChapterDrop}
              title="章を追加"
            >
              <div
                className={`opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center gap-1 text-xs ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 左上: 検索バー */}
      <div className="absolute top-4 left-4">
        <div
          className={`flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg ${
            isDark
              ? 'bg-gray-800 border-gray-700 text-gray-300'
              : 'bg-white border-gray-300 text-gray-600'
          } border`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="正規表現で検索..."
            className={`w-64 bg-transparent outline-none text-sm ${
              isDark ? 'text-gray-200 placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'
            }`}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className={`p-1 rounded hover:bg-opacity-10 ${
                isDark ? 'hover:bg-white text-gray-300' : 'hover:bg-black text-gray-600'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 右上: アセット管理とズーム表示 */}
      <div className="absolute top-4 right-4 flex gap-2">
        <button
          onClick={onNavigateToAssets}
          className={`px-3 py-2 rounded-lg shadow-lg transition-colors ${
            isDark
              ? 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          } border cursor-pointer`}
          title="アセット管理"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </button>
        <button
          onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
          className={`px-4 py-2 rounded-lg shadow-lg text-sm transition-colors ${
            isDark
              ? 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          } border cursor-pointer`}
          title="クリックして100%にリセット"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
      </div>
    </div>
  )
}

export default CanvasEditor
