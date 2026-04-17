import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { EventDocument, EventChapter, EventScene, Event, EventRef, Viewport } from '../types'
import ChapterCard from './ChapterCard'

interface CanvasEditorProps {
  doc: EventDocument
  onDocChange: (doc: EventDocument) => void
  isDark: boolean
  selectedEvent: EventRef | null
  setSelectedEvent: (ref: EventRef | null) => void
  onNavigateToAssets: () => void
}

/**
 * ユニークなシーンIDを生成する。emitterが新たなIDを割り振るため
 * 一時的なものでよいが、Reactキーの衝突は避ける。
 */
function makeSceneId(): string {
  return `scene-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function CanvasEditor({
  doc,
  onDocChange,
  isDark,
  selectedEvent,
  setSelectedEvent,
  onNavigateToAssets,
}: CanvasEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })
  const [searchQuery, setSearchQuery] = useState('')
  const [editingEvent, setEditingEvent] = useState<EventRef | null>(null)
  const [editingSceneRef, setEditingSceneRef] = useState<{ chapterIdx: number; sceneIdx: number } | null>(null)
  const [editingChapterIdx, setEditingChapterIdx] = useState<number | null>(null)
  const [newlyAddedEvent, setNewlyAddedEvent] = useState<EventRef | null>(null)
  const [newlyAddedScene, setNewlyAddedScene] = useState<{ chapterIdx: number; sceneIdx: number } | null>(null)
  const [newlyAddedChapter, setNewlyAddedChapter] = useState<number | null>(null)
  const [draggedEvent, setDraggedEvent] = useState<EventRef | null>(null)
  const [draggedScene, setDraggedScene] = useState<{ chapterIdx: number; sceneIdx: number } | null>(null)
  const [draggedChapter, setDraggedChapter] = useState<number | null>(null)
  const [eventDropTarget, setEventDropTarget] = useState<(EventRef & { position: number }) | null>(null)
  const [sceneDropTarget, setSceneDropTarget] = useState<{ chapterIdx: number; position: number } | null>(null)
  const [chapterDropTarget, setChapterDropTarget] = useState<number | null>(null)

  // ドキュメントを更新する共通ヘルパー
  const updateDoc = useCallback(
    (updater: (d: EventDocument) => EventDocument) => {
      onDocChange(updater(doc))
    },
    [doc, onDocChange]
  )

  // 編集モード終了時の処理（新規追加されたものがデフォルト値のままなら削除）
  const handleEditingEnd = useCallback(() => {
    let newDoc = doc

    if (newlyAddedEvent !== null) {
      const { chapterIdx, sceneIdx, eventIdx } = newlyAddedEvent
      const event = newDoc.chapters[chapterIdx]?.scenes[sceneIdx]?.events[eventIdx]
      let shouldDelete = false
      if (event && typeof event !== 'string') {
        if ('Dialog' in event) {
          const d = event.Dialog
          if (
            (d.character === null || d.character === '') &&
            d.text.every((t) => t === '') &&
            (d.expression === null || d.expression === '')
          ) {
            shouldDelete = true
          }
        } else if ('Narration' in event) {
          if (event.Narration.text.every((t) => t === '')) {
            shouldDelete = true
          }
        }
      }
      if (shouldDelete) {
        newDoc = {
          ...newDoc,
          chapters: newDoc.chapters.map((ch, ci) =>
            ci === chapterIdx
              ? {
                  ...ch,
                  scenes: ch.scenes.map((sc, si) =>
                    si === sceneIdx
                      ? { ...sc, events: sc.events.filter((_, ei) => ei !== eventIdx) }
                      : sc
                  ),
                }
              : ch
          ),
        }
      }
      setNewlyAddedEvent(null)
    }

    if (newlyAddedScene !== null) {
      const { chapterIdx, sceneIdx } = newlyAddedScene
      const scene = newDoc.chapters[chapterIdx]?.scenes[sceneIdx]
      if (scene && scene.title === '新しいシーン' && scene.events.length === 0) {
        newDoc = {
          ...newDoc,
          chapters: newDoc.chapters.map((ch, ci) =>
            ci === chapterIdx
              ? { ...ch, scenes: ch.scenes.filter((_, si) => si !== sceneIdx) }
              : ch
          ),
        }
      }
      setNewlyAddedScene(null)
    }

    if (newlyAddedChapter !== null) {
      const chapter = newDoc.chapters[newlyAddedChapter]
      if (chapter && chapter.title === '新しい章' && chapter.scenes.length === 0) {
        newDoc = {
          ...newDoc,
          chapters: newDoc.chapters.filter((_, ci) => ci !== newlyAddedChapter),
        }
      }
      setNewlyAddedChapter(null)
    }

    if (newDoc !== doc) {
      onDocChange(newDoc)
    }

    setEditingEvent(null)
    setEditingSceneRef(null)
    setEditingChapterIdx(null)
  }, [doc, newlyAddedEvent, newlyAddedScene, newlyAddedChapter, onDocChange])

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
  }, [handleEditingEnd])

  // イベントの内容を変更
  const handleEventChange = useCallback(
    (chapterIdx: number, sceneIdx: number, eventIdx: number, newEvent: Event) => {
      updateDoc((d) => ({
        ...d,
        chapters: d.chapters.map((ch, ci) =>
          ci === chapterIdx
            ? {
                ...ch,
                scenes: ch.scenes.map((sc, si) =>
                  si === sceneIdx
                    ? {
                        ...sc,
                        events: sc.events.map((ev, ei) => (ei === eventIdx ? newEvent : ev)),
                      }
                    : sc
                ),
              }
            : ch
        ),
      }))
    },
    [updateDoc]
  )

  // イベントのドラッグ開始
  const handleEventDragStart = useCallback((ref: EventRef) => {
    setDraggedEvent(ref)
  }, [])

  const handleEventDragOver = useCallback(
    (e: React.DragEvent, chapterIdx: number, sceneIdx: number, position: number) => {
      e.preventDefault()
      setEventDropTarget({ chapterIdx, sceneIdx, eventIdx: position, position })
    },
    []
  )

  const handleEventDrop = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      if (!draggedEvent || !eventDropTarget) return

      const srcEvent =
        doc.chapters[draggedEvent.chapterIdx]?.scenes[draggedEvent.sceneIdx]?.events[
          draggedEvent.eventIdx
        ]
      if (!srcEvent) return

      // まず元から削除
      let newChapters = doc.chapters.map((ch, ci) =>
        ci === draggedEvent.chapterIdx
          ? {
              ...ch,
              scenes: ch.scenes.map((sc, si) =>
                si === draggedEvent.sceneIdx
                  ? { ...sc, events: sc.events.filter((_, ei) => ei !== draggedEvent.eventIdx) }
                  : sc
              ),
            }
          : ch
      )

      // 同シーン内の場合、挿入位置を補正（削除で詰まるぶん）
      let insertPos = eventDropTarget.position
      if (
        draggedEvent.chapterIdx === eventDropTarget.chapterIdx &&
        draggedEvent.sceneIdx === eventDropTarget.sceneIdx &&
        draggedEvent.eventIdx < insertPos
      ) {
        insertPos -= 1
      }

      // 挿入
      newChapters = newChapters.map((ch, ci) =>
        ci === eventDropTarget.chapterIdx
          ? {
              ...ch,
              scenes: ch.scenes.map((sc, si) => {
                if (si !== eventDropTarget.sceneIdx) return sc
                const newEvents = [...sc.events]
                newEvents.splice(insertPos, 0, srcEvent)
                return { ...sc, events: newEvents }
              }),
            }
          : ch
      )

      onDocChange({ ...doc, chapters: newChapters })
      setDraggedEvent(null)
      setEventDropTarget(null)
    },
    [draggedEvent, eventDropTarget, doc, onDocChange]
  )

  const handleEventDragEnd = useCallback(() => {
    setDraggedEvent(null)
    setEventDropTarget(null)
  }, [])

  // シーンのドラッグ
  const handleSceneDragStart = useCallback((chapterIdx: number, sceneIdx: number) => {
    setDraggedScene({ chapterIdx, sceneIdx })
  }, [])

  const handleSceneDragOver = useCallback(
    (e: React.DragEvent, chapterIdx: number, position: number) => {
      e.preventDefault()
      e.stopPropagation()
      setSceneDropTarget({ chapterIdx, position })
    },
    []
  )

  const handleSceneDrop = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      if (!draggedScene || !sceneDropTarget) return

      const srcScene = doc.chapters[draggedScene.chapterIdx]?.scenes[draggedScene.sceneIdx]
      if (!srcScene) return

      let newChapters = doc.chapters.map((ch, ci) =>
        ci === draggedScene.chapterIdx
          ? { ...ch, scenes: ch.scenes.filter((_, si) => si !== draggedScene.sceneIdx) }
          : ch
      )

      let insertPos = sceneDropTarget.position
      if (
        draggedScene.chapterIdx === sceneDropTarget.chapterIdx &&
        draggedScene.sceneIdx < insertPos
      ) {
        insertPos -= 1
      }

      newChapters = newChapters.map((ch, ci) => {
        if (ci !== sceneDropTarget.chapterIdx) return ch
        const newScenes = [...ch.scenes]
        newScenes.splice(insertPos, 0, srcScene)
        return { ...ch, scenes: newScenes }
      })

      onDocChange({ ...doc, chapters: newChapters })
      setDraggedScene(null)
      setSceneDropTarget(null)
    },
    [draggedScene, sceneDropTarget, doc, onDocChange]
  )

  const handleSceneDragEnd = useCallback(() => {
    setDraggedScene(null)
    setSceneDropTarget(null)
  }, [])

  // 章のドラッグ
  const handleChapterDragStart = useCallback((chapterIdx: number) => {
    setDraggedChapter(chapterIdx)
  }, [])

  const handleChapterDragOver = useCallback((e: React.DragEvent, position: number) => {
    e.preventDefault()
    e.stopPropagation()
    setChapterDropTarget(position)
  }, [])

  const handleChapterDrop = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      if (draggedChapter === null || chapterDropTarget === null) return

      const srcChapter = doc.chapters[draggedChapter]
      if (!srcChapter) return

      const remaining = doc.chapters.filter((_, ci) => ci !== draggedChapter)
      let insertPos = chapterDropTarget
      if (draggedChapter < insertPos) {
        insertPos -= 1
      }
      remaining.splice(insertPos, 0, srcChapter)

      // 章番号を振り直す（1始まり）
      const newChapters: EventChapter[] = remaining.map((ch, i) => ({
        ...ch,
        number: i + 1,
      }))

      onDocChange({ ...doc, chapters: newChapters })
      setDraggedChapter(null)
      setChapterDropTarget(null)
    },
    [draggedChapter, chapterDropTarget, doc, onDocChange]
  )

  const handleChapterDragEnd = useCallback(() => {
    setDraggedChapter(null)
    setChapterDropTarget(null)
  }, [])

  // イベントを追加
  const handleAddEvent = useCallback(
    (chapterIdx: number, sceneIdx: number, position: number, variant: 'Dialog' | 'Narration') => {
      const newEvent: Event =
        variant === 'Dialog'
          ? {
              Dialog: {
                character: '',
                expression: null,
                position: null,
                text: [''],
              },
            }
          : {
              Narration: { text: [''] },
            }

      const newChapters = doc.chapters.map((ch, ci) =>
        ci === chapterIdx
          ? {
              ...ch,
              scenes: ch.scenes.map((sc, si) => {
                if (si !== sceneIdx) return sc
                const newEvents = [...sc.events]
                newEvents.splice(position, 0, newEvent)
                return { ...sc, events: newEvents }
              }),
            }
          : ch
      )

      onDocChange({ ...doc, chapters: newChapters })
      const ref: EventRef = { chapterIdx, sceneIdx, eventIdx: position }
      setEditingEvent(ref)
      setNewlyAddedEvent(ref)
    },
    [doc, onDocChange]
  )

  // イベントを削除
  const handleDeleteEvent = useCallback(
    (chapterIdx: number, sceneIdx: number, eventIdx: number) => {
      const newChapters = doc.chapters.map((ch, ci) =>
        ci === chapterIdx
          ? {
              ...ch,
              scenes: ch.scenes.map((sc, si) =>
                si === sceneIdx
                  ? { ...sc, events: sc.events.filter((_, ei) => ei !== eventIdx) }
                  : sc
              ),
            }
          : ch
      )
      onDocChange({ ...doc, chapters: newChapters })
      setEditingEvent(null)
    },
    [doc, onDocChange]
  )

  // シーンを追加
  const handleAddScene = useCallback(
    (chapterIdx: number, position: number) => {
      const newScene: EventScene = { id: makeSceneId(), title: '新しいシーン', events: [] }
      const newChapters = doc.chapters.map((ch, ci) => {
        if (ci !== chapterIdx) return ch
        const newScenes = [...ch.scenes]
        newScenes.splice(position, 0, newScene)
        return { ...ch, scenes: newScenes }
      })
      onDocChange({ ...doc, chapters: newChapters })
      setEditingSceneRef({ chapterIdx, sceneIdx: position })
      setNewlyAddedScene({ chapterIdx, sceneIdx: position })
    },
    [doc, onDocChange]
  )

  // シーンを削除
  const handleDeleteScene = useCallback(
    (chapterIdx: number, sceneIdx: number) => {
      const newChapters = doc.chapters.map((ch, ci) =>
        ci === chapterIdx
          ? { ...ch, scenes: ch.scenes.filter((_, si) => si !== sceneIdx) }
          : ch
      )
      onDocChange({ ...doc, chapters: newChapters })
      setEditingSceneRef(null)
    },
    [doc, onDocChange]
  )

  // シーンのタイトル変更
  const handleSceneTitleChange = useCallback(
    (chapterIdx: number, sceneIdx: number, newTitle: string) => {
      const newChapters = doc.chapters.map((ch, ci) =>
        ci === chapterIdx
          ? {
              ...ch,
              scenes: ch.scenes.map((sc, si) =>
                si === sceneIdx ? { ...sc, title: newTitle } : sc
              ),
            }
          : ch
      )
      onDocChange({ ...doc, chapters: newChapters })
    },
    [doc, onDocChange]
  )

  // 章を追加
  const handleAddChapter = useCallback(
    (position: number) => {
      const newNumber = position + 1
      const newChapter: EventChapter = {
        number: newNumber,
        title: '新しい章',
        hidden: false,
        default_bgm: null,
        scenes: [],
      }
      const newChapters = [...doc.chapters]
      newChapters.splice(position, 0, newChapter)
      // 番号を振り直す
      const renumbered: EventChapter[] = newChapters.map((ch, i) => ({ ...ch, number: i + 1 }))
      onDocChange({ ...doc, chapters: renumbered })
      setEditingChapterIdx(position)
      setNewlyAddedChapter(position)
    },
    [doc, onDocChange]
  )

  // 章を削除
  const handleDeleteChapter = useCallback(
    (chapterIdx: number) => {
      const remaining = doc.chapters.filter((_, ci) => ci !== chapterIdx)
      const renumbered: EventChapter[] = remaining.map((ch, i) => ({ ...ch, number: i + 1 }))
      onDocChange({ ...doc, chapters: renumbered })
      setEditingChapterIdx(null)
    },
    [doc, onDocChange]
  )

  // 章のタイトル変更
  const handleChapterTitleChange = useCallback(
    (chapterIdx: number, newTitle: string) => {
      const newChapters = doc.chapters.map((ch, ci) =>
        ci === chapterIdx ? { ...ch, title: newTitle } : ch
      )
      onDocChange({ ...doc, chapters: newChapters })
    },
    [doc, onDocChange]
  )

  // 編集モード切り替え
  const handleStartEditingChapter = useCallback((chapterIdx: number) => {
    setEditingEvent(null)
    setEditingSceneRef(null)
    setEditingChapterIdx(chapterIdx)
  }, [])

  const handleStartEditingScene = useCallback((chapterIdx: number, sceneIdx: number) => {
    setEditingEvent(null)
    setEditingChapterIdx(null)
    setEditingSceneRef({ chapterIdx, sceneIdx })
  }, [])

  const handleStartEditingEvent = useCallback((ref: EventRef) => {
    setEditingChapterIdx(null)
    setEditingSceneRef(null)
    setEditingEvent(ref)
  }, [])

  const handleSelectEvent = useCallback(
    (ref: EventRef) => {
      setEditingChapterIdx(null)
      setEditingSceneRef(null)
      setEditingEvent(null)
      setSelectedEvent(ref)
    },
    [setSelectedEvent]
  )

  // ホイールでズーム
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()

      const delta = e.deltaY
      const zoomFactor = delta > 0 ? 0.9 : 1.1
      const newZoom = Math.min(Math.max(viewport.zoom * zoomFactor, 0.1), 1)

      if (newZoom === viewport.zoom) return

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

  const cursor = isPanning ? 'grabbing' : 'grab'

  // searchQuery は現時点では UI 表示のみ（既存挙動と同じ。将来のフィルタ用）
  void searchQuery

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
      <div
        style={{
          transform: `scale(${viewport.zoom}) translate(${viewport.x / viewport.zoom}px, ${viewport.y / viewport.zoom}px)`,
          transformOrigin: '0 0',
          transition: isPanning ? 'none' : 'transform 0.1s ease-out',
        }}
      >
        <div className="flex gap-8 p-8">
          {doc.chapters.map((chapter, chapterIdx) => (
            <ChapterCard
              key={`chapter-${chapterIdx}-${chapter.number}`}
              chapter={chapter}
              chapterIdx={chapterIdx}
              isDark={isDark}
              editingChapterIdx={editingChapterIdx}
              editingSceneRef={editingSceneRef}
              editingEvent={editingEvent}
              selectedEvent={selectedEvent}
              editingRef={editingRef}
              draggedChapter={draggedChapter}
              chapterDropTarget={chapterDropTarget}
              draggedScene={draggedScene}
              sceneDropTarget={sceneDropTarget}
              draggedEvent={draggedEvent}
              eventDropTarget={eventDropTarget}
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
              onAddEvent={handleAddEvent}
              onEventChange={handleEventChange}
              onDeleteEvent={handleDeleteEvent}
              onStartEditingEvent={handleStartEditingEvent}
              onSelectEvent={handleSelectEvent}
              onEventDragStart={handleEventDragStart}
              onEventDragEnd={handleEventDragEnd}
              onEventDragOver={handleEventDragOver}
              onEventDrop={handleEventDrop}
            />
          ))}

          {/* 末尾の章追加ボタン */}
          <div
            draggable={false}
            className={`group w-12 flex-shrink-0 flex items-start justify-center pt-8 transition-all rounded cursor-pointer ${
              chapterDropTarget === doc.chapters.length
                ? isDark
                  ? 'bg-indigo-900/40 border-2 border-indigo-400'
                  : 'bg-indigo-100 border-2 border-indigo-600'
                : isDark
                  ? 'bg-gray-700/20 hover:bg-gray-700/40'
                  : 'bg-gray-200/50 hover:bg-gray-200'
            }`}
            onClick={() => handleAddChapter(doc.chapters.length)}
            onDragOver={(e) => handleChapterDragOver(e, doc.chapters.length)}
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
