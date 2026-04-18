import { motion } from 'framer-motion'
import type { Event, EventRef } from '../types'
import EventDisplay from './EventDisplay'

interface EventCardProps {
  event: Event
  chapterIdx: number
  sceneIdx: number
  eventIdx: number
  isDark: boolean
  isEditing: boolean
  isSelected: boolean
  editingRef: React.RefObject<HTMLDivElement>
  isDragging: boolean
  draggedEvent: EventRef | null
  dropTarget: { chapterIdx: number; sceneIdx: number; position: number } | null
  onEventChange: (chapterIdx: number, sceneIdx: number, eventIdx: number, newEvent: Event) => void
  onDeleteEvent: (chapterIdx: number, sceneIdx: number, eventIdx: number) => void
  onStartEditing: (ref: EventRef) => void
  onSelectEvent: (ref: EventRef) => void
  onEventDragStart: (ref: EventRef) => void
  onEventDragEnd: () => void
  onEventDragOver: (
    e: React.DragEvent,
    chapterIdx: number,
    sceneIdx: number,
    position: number
  ) => void
  onEventDrop: (e: React.DragEvent) => void
}

/**
 * Event の variant をキー付けに使う安定なIDを返す。
 * 配列インデックスは再配置で変わるが、ある時点でのkeyとしては十分。
 */
function variantLabel(event: Event): string {
  if (typeof event === 'string') return event
  const k = Object.keys(event)[0]
  return k
}

function EventCard({
  event,
  chapterIdx,
  sceneIdx,
  eventIdx,
  isDark,
  isEditing,
  isSelected,
  editingRef,
  isDragging,
  draggedEvent,
  dropTarget,
  onEventChange,
  onDeleteEvent,
  onStartEditing,
  onSelectEvent,
  onEventDragStart,
  onEventDragEnd,
  onEventDragOver,
  onEventDrop,
}: EventCardProps) {
  const ref: EventRef = { chapterIdx, sceneIdx, eventIdx }
  const variant = variantLabel(event)
  const isDialog = typeof event !== 'string' && 'Dialog' in event
  const isNarration = typeof event !== 'string' && 'Narration' in event
  const editable = isDialog || isNarration

  const dropHere =
    dropTarget &&
    dropTarget.chapterIdx === chapterIdx &&
    dropTarget.sceneIdx === sceneIdx &&
    dropTarget.position === eventIdx

  return (
    <>
      {/* ドロップ領域（イベントがドラッグされている時だけ表示） */}
      {draggedEvent !== null && (
        <div
          className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
            dropHere
              ? isDark
                ? 'bg-indigo-900/40 border border-indigo-400'
                : 'bg-indigo-100 border border-indigo-600'
              : isDark
                ? 'bg-gray-700/20 hover:bg-gray-700/40'
                : 'bg-gray-200/50 hover:bg-gray-200'
          }`}
          onDragOver={(e) => onEventDragOver(e, chapterIdx, sceneIdx, eventIdx)}
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

      {/* イベント本体 */}
      <motion.div
        layout
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        onClick={(e) => {
          e.stopPropagation()
          if (isEditing) return
          if (isSelected && editable) {
            onStartEditing(ref)
          } else {
            onSelectEvent(ref)
          }
        }}
        className={`relative p-3 rounded border cursor-pointer ${
          isSelected
            ? isDark
              ? 'bg-indigo-900/50 border-indigo-500 ring-2 ring-indigo-500'
              : 'bg-indigo-50 border-indigo-500 ring-2 ring-indigo-500'
            : isDark
              ? 'bg-gray-800/50 border-gray-600 hover:border-gray-500'
              : 'bg-white border-gray-300 hover:border-gray-400'
        } ${isDragging ? 'opacity-50' : ''}`}
      >
        {/* ドラッグハンドル */}
        {!isEditing && (
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation()
              onEventDragStart(ref)
            }}
            onDragEnd={onEventDragEnd}
            onMouseDown={(e) => e.stopPropagation()}
            className={`absolute -top-1 -right-1 p-1 rounded cursor-grab active:cursor-grabbing opacity-30 hover:opacity-100 transition-opacity ${
              isDark ? 'text-gray-400' : 'text-gray-500'
            }`}
            title="ドラッグして移動"
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 3h2v2H9V3zm0 4h2v2H9V7zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm4-16h2v2h-2V3zm0 4h2v2h-2V7zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z" />
            </svg>
          </div>
        )}

        <div className="mb-2">
          <span
            className={`inline-block px-2 py-0.5 text-xs rounded-full ${
              isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
            }`}
          >
            {variant}
          </span>
        </div>

        {isEditing && isDialog && typeof event !== 'string' && 'Dialog' in event ? (
          <div
            ref={editingRef}
            className="space-y-2"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              value={event.Dialog.character ?? ''}
              onChange={(e) =>
                onEventChange(chapterIdx, sceneIdx, eventIdx, {
                  Dialog: {
                    ...event.Dialog,
                    character: e.target.value === '' ? null : e.target.value,
                  },
                })
              }
              autoFocus
              placeholder="キャラクター名"
              className={`w-full px-2 py-1 text-sm font-semibold rounded border ${
                isDark
                  ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                  : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
              } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
            />
            <textarea
              value={event.Dialog.text.join('\n')}
              onChange={(e) =>
                onEventChange(chapterIdx, sceneIdx, eventIdx, {
                  Dialog: {
                    ...event.Dialog,
                    text: e.target.value.split('\n'),
                  },
                })
              }
              placeholder="テキスト"
              rows={3}
              className={`w-full px-2 py-1 text-sm rounded border resize-none font-mono ${
                isDark
                  ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                  : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
              } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
            />
            <input
              type="text"
              value={event.Dialog.expression ?? ''}
              onChange={(e) =>
                onEventChange(chapterIdx, sceneIdx, eventIdx, {
                  Dialog: {
                    ...event.Dialog,
                    expression: e.target.value === '' ? null : e.target.value,
                  },
                })
              }
              placeholder="表情・ポーズ"
              className={`w-full px-2 py-1 text-sm rounded border ${
                isDark
                  ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                  : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
              } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
            />
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDeleteEvent(chapterIdx, sceneIdx, eventIdx)
              }}
              className={`w-full px-2 py-1 text-xs rounded transition-colors ${
                isDark
                  ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70'
                  : 'bg-red-100 text-red-700 hover:bg-red-200'
              }`}
            >
              イベントを削除
            </button>
          </div>
        ) : isEditing && isNarration && typeof event !== 'string' && 'Narration' in event ? (
          <div
            ref={editingRef}
            className="space-y-2"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <textarea
              value={event.Narration.text.join('\n')}
              onChange={(e) =>
                onEventChange(chapterIdx, sceneIdx, eventIdx, {
                  Narration: { text: e.target.value.split('\n') },
                })
              }
              autoFocus
              placeholder="ナレーション"
              rows={3}
              className={`w-full px-2 py-1 text-sm rounded border resize-none font-mono ${
                isDark
                  ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                  : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
              } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
            />
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDeleteEvent(chapterIdx, sceneIdx, eventIdx)
              }}
              className={`w-full px-2 py-1 text-xs rounded transition-colors ${
                isDark
                  ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70'
                  : 'bg-red-100 text-red-700 hover:bg-red-200'
              }`}
            >
              イベントを削除
            </button>
          </div>
        ) : (
          <EventDisplay event={event} isDark={isDark} />
        )}
      </motion.div>
    </>
  )
}

export default EventCard
