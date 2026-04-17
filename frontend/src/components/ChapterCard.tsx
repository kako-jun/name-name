import { motion } from 'framer-motion'
import type { EventChapter, EventRef, Event } from '../types'
import SceneCard from './SceneCard'

interface ChapterCardProps {
  chapter: EventChapter
  chapterIdx: number
  isDark: boolean
  editingChapterIdx: number | null
  editingSceneRef: { chapterIdx: number; sceneIdx: number } | null
  editingEvent: EventRef | null
  selectedEvent: EventRef | null
  editingRef: React.RefObject<HTMLDivElement>
  draggedChapter: number | null
  chapterDropTarget: number | null
  draggedScene: { chapterIdx: number; sceneIdx: number } | null
  sceneDropTarget: { chapterIdx: number; position: number } | null
  draggedEvent: EventRef | null
  eventDropTarget: (EventRef & { position: number }) | null
  onChapterTitleChange: (chapterIdx: number, title: string) => void
  onDeleteChapter: (chapterIdx: number) => void
  onStartEditingChapter: (chapterIdx: number) => void
  onChapterDragStart: (chapterIdx: number) => void
  onChapterDragEnd: () => void
  onChapterDragOver: (e: React.DragEvent, position: number) => void
  onChapterDrop: (e: React.DragEvent) => void
  onAddChapter: (position: number) => void
  onAddScene: (chapterIdx: number, position: number) => void
  onSceneTitleChange: (chapterIdx: number, sceneIdx: number, title: string) => void
  onDeleteScene: (chapterIdx: number, sceneIdx: number) => void
  onStartEditingScene: (chapterIdx: number, sceneIdx: number) => void
  onSceneDragStart: (chapterIdx: number, sceneIdx: number) => void
  onSceneDragEnd: () => void
  onSceneDragOver: (e: React.DragEvent, chapterIdx: number, position: number) => void
  onSceneDrop: (e: React.DragEvent) => void
  onAddEvent: (chapterIdx: number, sceneIdx: number, position: number, variant: 'Dialog' | 'Narration') => void
  onEventChange: (chapterIdx: number, sceneIdx: number, eventIdx: number, newEvent: Event) => void
  onDeleteEvent: (chapterIdx: number, sceneIdx: number, eventIdx: number) => void
  onStartEditingEvent: (ref: EventRef) => void
  onSelectEvent: (ref: EventRef) => void
  onEventDragStart: (ref: EventRef) => void
  onEventDragEnd: () => void
  onEventDragOver: (e: React.DragEvent, chapterIdx: number, sceneIdx: number, position: number) => void
  onEventDrop: (e: React.DragEvent) => void
}

function ChapterCard({
  chapter,
  chapterIdx,
  isDark,
  editingChapterIdx,
  editingSceneRef,
  editingEvent,
  selectedEvent,
  editingRef,
  draggedChapter,
  chapterDropTarget,
  draggedScene,
  sceneDropTarget,
  draggedEvent,
  eventDropTarget,
  onChapterTitleChange,
  onDeleteChapter,
  onStartEditingChapter,
  onChapterDragStart,
  onChapterDragEnd,
  onChapterDragOver,
  onChapterDrop,
  onAddChapter,
  onAddScene,
  onSceneTitleChange,
  onDeleteScene,
  onStartEditingScene,
  onSceneDragStart,
  onSceneDragEnd,
  onSceneDragOver,
  onSceneDrop,
  onAddEvent,
  onEventChange,
  onDeleteEvent,
  onStartEditingEvent,
  onSelectEvent,
  onEventDragStart,
  onEventDragEnd,
  onEventDragOver,
  onEventDrop,
}: ChapterCardProps) {
  const isEditingChapter = editingChapterIdx === chapterIdx
  const isBeingDragged = draggedChapter === chapterIdx
  const editingSceneIdxInThis =
    editingSceneRef !== null && editingSceneRef.chapterIdx === chapterIdx
      ? editingSceneRef.sceneIdx
      : null

  return (
    <>
      {/* 章の追加ボタン（章がドラッグされている時だけ表示） */}
      {draggedChapter !== null && (
        <div
          draggable={false}
          className={`group w-12 flex-shrink-0 flex items-start justify-center pt-8 transition-all rounded cursor-pointer ${
            chapterDropTarget === chapterIdx
              ? isDark
                ? 'bg-indigo-900/40 border-2 border-indigo-400'
                : 'bg-indigo-100 border-2 border-indigo-600'
              : isDark
                ? 'bg-gray-700/20 hover:bg-gray-700/40'
                : 'bg-gray-200/50 hover:bg-gray-200'
          }`}
          onClick={() => onAddChapter(chapterIdx)}
          onDragOver={(e) => onChapterDragOver(e, chapterIdx)}
          onDrop={onChapterDrop}
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

      <motion.div
        layout
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className={`flex-shrink-0 w-96 p-6 rounded-lg shadow-lg ${
          isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-300'
        } ${isBeingDragged ? 'opacity-50' : ''}`}
      >
        {/* 章のヘッダー */}
        <div className="relative mb-4">
          {/* ドラッグハンドル */}
          {!isEditingChapter && (
            <div
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                onChapterDragStart(chapterIdx)
              }}
              onDragEnd={onChapterDragEnd}
              onMouseDown={(e) => e.stopPropagation()}
              className={`absolute -top-2 -right-2 p-2 rounded cursor-grab active:cursor-grabbing opacity-30 hover:opacity-100 transition-opacity ${
                isDark ? 'text-gray-400' : 'text-gray-500'
              }`}
              title="ドラッグして移動"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 3h2v2H9V3zm0 4h2v2H9V7zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm4-16h2v2h-2V3zm0 4h2v2h-2V7zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z" />
              </svg>
            </div>
          )}

          {isEditingChapter ? (
            <div
              ref={editingRef}
              className="space-y-2"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={chapter.title}
                onChange={(e) => onChapterTitleChange(chapterIdx, e.target.value)}
                autoFocus
                placeholder="章のタイトル"
                className={`w-full px-3 py-2 text-xl font-bold rounded border ${
                  isDark
                    ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                    : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
                } focus:outline-none focus:ring-2 focus:ring-indigo-500`}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteChapter(chapterIdx)
                }}
                className={`w-full px-3 py-2 text-sm rounded transition-colors ${
                  isDark
                    ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70'
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                章を削除
              </button>
            </div>
          ) : (
            <div
              onClick={(e) => {
                e.stopPropagation()
                onStartEditingChapter(chapterIdx)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="cursor-pointer mb-4"
            >
              <div className="mb-2">
                <span
                  className={`inline-block px-3 py-1 text-sm rounded-full font-semibold ${
                    isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  第{chapter.number}章
                </span>
              </div>
              <div className={`font-bold text-xl ml-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {chapter.title}
              </div>
            </div>
          )}
        </div>

        {/* シーン一覧 */}
        <div className="space-y-2">
          {chapter.scenes.map((scene, sceneIdx) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              chapterIdx={chapterIdx}
              sceneIdx={sceneIdx}
              isDark={isDark}
              editingSceneIdx={editingSceneIdxInThis}
              editingEvent={editingEvent}
              selectedEvent={selectedEvent}
              editingRef={editingRef}
              draggedScene={draggedScene}
              sceneDropTarget={sceneDropTarget}
              draggedEvent={draggedEvent}
              eventDropTarget={eventDropTarget}
              onSceneTitleChange={onSceneTitleChange}
              onDeleteScene={onDeleteScene}
              onStartEditingScene={onStartEditingScene}
              onSceneDragStart={onSceneDragStart}
              onSceneDragEnd={onSceneDragEnd}
              onSceneDragOver={onSceneDragOver}
              onSceneDrop={onSceneDrop}
              onAddEvent={onAddEvent}
              onEventChange={onEventChange}
              onDeleteEvent={onDeleteEvent}
              onStartEditingEvent={onStartEditingEvent}
              onSelectEvent={onSelectEvent}
              onEventDragStart={onEventDragStart}
              onEventDragEnd={onEventDragEnd}
              onEventDragOver={onEventDragOver}
              onEventDrop={onEventDrop}
            />
          ))}

          {/* シーン追加ボタン（常に表示） */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAddScene(chapterIdx, chapter.scenes.length)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`w-full px-2 py-1 text-xs rounded transition-colors ${
              isDark
                ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
            }`}
          >
            + シーンを追加
          </button>

          {/* 最後のシーン追加ドロップ領域（場面がドラッグされている時だけ表示） */}
          {draggedScene !== null && (
            <div
              draggable={false}
              className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
                sceneDropTarget?.chapterIdx === chapterIdx &&
                sceneDropTarget?.position === chapter.scenes.length
                  ? isDark
                    ? 'bg-indigo-900/40 border border-indigo-400'
                    : 'bg-indigo-100 border border-indigo-600'
                  : isDark
                    ? 'bg-gray-700/20 hover:bg-gray-700/40'
                    : 'bg-gray-200/50 hover:bg-gray-200'
              }`}
              onDragOver={(e) => onSceneDragOver(e, chapterIdx, chapter.scenes.length)}
              onDrop={onSceneDrop}
            >
              <div
                className={`opacity-0 group-hover:opacity-100 transition-opacity text-xs ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`}
              >
                +
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </>
  )
}

export default ChapterCard
