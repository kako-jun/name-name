import { motion } from 'framer-motion'
import type { EventScene, EventRef, Event } from '../types'
import EventCard from './EventCard'

interface SceneCardProps {
  scene: EventScene
  chapterIdx: number
  sceneIdx: number
  isDark: boolean
  editingSceneIdx: number | null
  editingEvent: EventRef | null
  selectedEvent: EventRef | null
  editingRef: React.RefObject<HTMLDivElement>
  draggedScene: { chapterIdx: number; sceneIdx: number } | null
  sceneDropTarget: { chapterIdx: number; position: number } | null
  draggedEvent: EventRef | null
  eventDropTarget: (EventRef & { position: number }) | null
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

function SceneCard({
  scene,
  chapterIdx,
  sceneIdx,
  isDark,
  editingSceneIdx,
  editingEvent,
  selectedEvent,
  editingRef,
  draggedScene,
  sceneDropTarget,
  draggedEvent,
  eventDropTarget,
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
}: SceneCardProps) {
  const isEditingScene = editingSceneIdx === sceneIdx
  const isBeingDragged =
    draggedScene !== null &&
    draggedScene.chapterIdx === chapterIdx &&
    draggedScene.sceneIdx === sceneIdx

  return (
    <>
      {/* シーンのドロップ領域（場面がドラッグされている時だけ表示） */}
      {draggedScene !== null && (
        <div
          className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
            sceneDropTarget?.chapterIdx === chapterIdx && sceneDropTarget?.position === sceneIdx
              ? isDark
                ? 'bg-indigo-900/40 border border-indigo-400'
                : 'bg-indigo-100 border border-indigo-600'
              : isDark
                ? 'bg-gray-700/20 hover:bg-gray-700/40'
                : 'bg-gray-200/50 hover:bg-gray-200'
          }`}
          onDragOver={(e) => onSceneDragOver(e, chapterIdx, sceneIdx)}
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

      {/* シーン本体 */}
      <motion.div
        layout
        layoutId={`scene-${scene.id}`}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className={`mb-4 p-4 rounded-lg border ${
          isDark ? 'bg-gray-700/50 border-gray-600' : 'bg-gray-50 border-gray-300'
        } ${isBeingDragged ? 'opacity-50' : ''}`}
      >
        {/* シーンのヘッダー */}
        <div className="relative mb-2">
          {/* ドラッグハンドル */}
          {!isEditingScene && (
            <div
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                onSceneDragStart(chapterIdx, sceneIdx)
              }}
              onDragEnd={onSceneDragEnd}
              onMouseDown={(e) => e.stopPropagation()}
              className={`absolute -top-2 -right-2 p-1.5 rounded cursor-grab active:cursor-grabbing opacity-30 hover:opacity-100 transition-opacity ${
                isDark ? 'text-gray-400' : 'text-gray-500'
              }`}
              title="ドラッグして移動"
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 3h2v2H9V3zm0 4h2v2H9V7zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm4-16h2v2h-2V3zm0 4h2v2h-2V7zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z" />
              </svg>
            </div>
          )}

          {isEditingScene ? (
            <div
              ref={editingRef}
              className="space-y-2"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={scene.title}
                onChange={(e) => onSceneTitleChange(chapterIdx, sceneIdx, e.target.value)}
                autoFocus
                placeholder="シーンのタイトル"
                className={`w-full px-2 py-1 text-lg font-semibold rounded border ${
                  isDark
                    ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                    : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
                } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteScene(chapterIdx, sceneIdx)
                }}
                className={`w-full px-2 py-1 text-xs rounded transition-colors ${
                  isDark
                    ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70'
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                シーンを削除
              </button>
            </div>
          ) : (
            <div
              onClick={(e) => {
                e.stopPropagation()
                onStartEditingScene(chapterIdx, sceneIdx)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="cursor-pointer"
            >
              <div className="mb-1">
                <span
                  className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                    isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  シーン{sceneIdx + 1}
                </span>
              </div>
              <div
                className={`font-semibold text-lg ml-2 ${isDark ? 'text-gray-200' : 'text-gray-800'}`}
              >
                {scene.title}
              </div>
            </div>
          )}
        </div>

        {/* イベント一覧 */}
        <div className="space-y-2">
          {scene.events.map((event, eventIdx) => {
            const isEditingThis =
              editingEvent !== null &&
              editingEvent.chapterIdx === chapterIdx &&
              editingEvent.sceneIdx === sceneIdx &&
              editingEvent.eventIdx === eventIdx
            const isSelectedThis =
              selectedEvent !== null &&
              selectedEvent.chapterIdx === chapterIdx &&
              selectedEvent.sceneIdx === sceneIdx &&
              selectedEvent.eventIdx === eventIdx
            const isDraggedThis =
              draggedEvent !== null &&
              draggedEvent.chapterIdx === chapterIdx &&
              draggedEvent.sceneIdx === sceneIdx &&
              draggedEvent.eventIdx === eventIdx
            return (
              <EventCard
                key={`${chapterIdx}-${sceneIdx}-${eventIdx}`}
                event={event}
                chapterIdx={chapterIdx}
                sceneIdx={sceneIdx}
                eventIdx={eventIdx}
                isDark={isDark}
                isEditing={isEditingThis}
                isSelected={isSelectedThis}
                editingRef={editingRef}
                isDragging={isDraggedThis}
                draggedEvent={draggedEvent}
                dropTarget={eventDropTarget}
                onEventChange={onEventChange}
                onDeleteEvent={onDeleteEvent}
                onStartEditing={onStartEditingEvent}
                onSelectEvent={onSelectEvent}
                onEventDragStart={onEventDragStart}
                onEventDragEnd={onEventDragEnd}
                onEventDragOver={onEventDragOver}
                onEventDrop={onEventDrop}
              />
            )
          })}

          {/* イベント追加ボタン（ダイアログ/ナレーション） */}
          <div className="flex gap-2 mt-2">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onAddEvent(chapterIdx, sceneIdx, scene.events.length, 'Dialog')
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                isDark
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }`}
            >
              + ダイアログ
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onAddEvent(chapterIdx, sceneIdx, scene.events.length, 'Narration')
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                isDark
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }`}
            >
              + ナレーション
            </button>
          </div>

          {/* 最後のイベント追加ドロップ領域（イベントがドラッグされている時だけ表示） */}
          {draggedEvent !== null && (
            <div
              draggable={false}
              className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
                eventDropTarget?.chapterIdx === chapterIdx &&
                eventDropTarget?.sceneIdx === sceneIdx &&
                eventDropTarget?.position === scene.events.length
                  ? isDark
                    ? 'bg-indigo-900/40 border border-indigo-400'
                    : 'bg-indigo-100 border border-indigo-600'
                  : isDark
                    ? 'bg-gray-700/20 hover:bg-gray-700/40'
                    : 'bg-gray-200/50 hover:bg-gray-200'
              }`}
              onDragOver={(e) => onEventDragOver(e, chapterIdx, sceneIdx, scene.events.length)}
              onDrop={onEventDrop}
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

export default SceneCard
