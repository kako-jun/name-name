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

/**
 * #239 (manga-desk theme): variant ごとに「机の上の物」の見た目を割り当てる。
 * - Dialog / Narration → 原稿用紙 (desk-genko)
 * - Choice / Flag / Condition → 青ペンの分岐メモ (desk-fusen-b)
 * - Monster / Item / Spell / PartyMember → 資料の付箋 (desk-fusen-g)
 * - Npc / RpgMap / PlayerStart / RpgEvent / RpgTrigger → RPG メモ (desk-fusen-p)
 * - その他演出系 (Background, Bgm, Se, Wait, Animate, TextEffect, Underline, Shake, Flash, Fade, ...) → 黄付箋
 */
function variantToDeskClass(event: Event): string {
  if (typeof event === 'string') return 'desk-fusen' // SceneTransition
  if ('Dialog' in event || 'Narration' in event) return 'desk-genko desk-body'
  if ('Choice' in event || 'Flag' in event || 'Condition' in event) return 'desk-fusen desk-fusen-b'
  if ('Monster' in event || 'Item' in event || 'Spell' in event || 'PartyMember' in event)
    return 'desk-fusen desk-fusen-g'
  if (
    'Npc' in event ||
    'RpgMap' in event ||
    'PlayerStart' in event ||
    'RpgEvent' in event ||
    'RpgTrigger' in event
  )
    return 'desk-fusen desk-fusen-p'
  return 'desk-fusen' // 演出系 (Bgm / Se / Background / Wait / Animate / TextEffect / Underline / Shake / Flash / Fade / ...)
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
        // #239: variant 別の付箋色 / 原稿用紙風。Dialog / Narration はインクで書き込む
        //   原稿用紙、それ以外は変種別の付箋色（演出=黄、分岐=青、RPG=桃、マスター=緑）。
        className={`relative p-3 rounded border cursor-pointer transition-shadow ${
          isSelected ? 'ring-2 ring-offset-1' : ''
        } ${isDragging ? 'opacity-50' : ''} ${variantToDeskClass(event)}`}
        // #239 review N1: as never キャストは型エラー回避目的だが意図が読みづらいので
        //   React.CSSProperties に明示キャストし直す。CSS カスタムプロパティは
        //   React の型定義に無いがランタイム上は通る。
        style={
          {
            borderColor: isSelected ? 'var(--desk-akapen)' : 'var(--desk-rule)',
            '--tw-ring-color': 'var(--desk-akapen)',
          } as React.CSSProperties
        }
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
