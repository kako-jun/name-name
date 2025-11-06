import { motion } from 'framer-motion'
import { Cut } from '../types'

interface CutCardProps {
  cut: Cut
  chapterId: number
  sceneId: number
  cutIndex: number
  isDark: boolean
  editingCutId: number | null
  newlyAddedCutId: number | null
  selectedCutId: number | null
  editingRef: React.RefObject<HTMLDivElement>
  draggedCut: { chapterId: number; sceneId: number; cutId: number } | null
  dropTarget: { chapterId: number; sceneId: number; position: number } | null
  onCutChange: (
    chapterId: number,
    sceneId: number,
    cutId: number,
    field: keyof Cut,
    value: string
  ) => void
  onDeleteCut: (chapterId: number, sceneId: number, cutId: number) => void
  onStartEditing: (cutId: number) => void
  onSelectCut: (cutId: number) => void
  onCutDragStart: (chapterId: number, sceneId: number, cutId: number) => void
  onCutDragEnd: () => void
  onCutDragOver: (e: React.DragEvent, chapterId: number, sceneId: number, position: number) => void
  onCutDrop: (e: React.DragEvent) => void
}

function CutCard({
  cut,
  chapterId,
  sceneId,
  cutIndex,
  isDark,
  editingCutId,
  newlyAddedCutId: _newlyAddedCutId,
  selectedCutId,
  editingRef,
  draggedCut,
  dropTarget,
  onCutChange,
  onDeleteCut,
  onStartEditing,
  onSelectCut,
  onCutDragStart,
  onCutDragEnd,
  onCutDragOver,
  onCutDrop,
}: CutCardProps) {
  return (
    <>
      {/* ドロップ領域（カットがドラッグされている時だけ表示） */}
      {draggedCut !== null && (
        <div
          className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
            dropTarget?.chapterId === chapterId &&
            dropTarget?.sceneId === sceneId &&
            dropTarget?.position === cutIndex
              ? isDark
                ? 'bg-indigo-900/40 border border-indigo-400'
                : 'bg-indigo-100 border border-indigo-600'
              : isDark
                ? 'bg-gray-700/20 hover:bg-gray-700/40'
                : 'bg-gray-200/50 hover:bg-gray-200'
          }`}
          onDragOver={(e) => onCutDragOver(e, chapterId, sceneId, cutIndex)}
          onDrop={onCutDrop}
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

      {/* カット本体 */}
      <motion.div
        layout
        layoutId={`cut-${cut.id}`}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        onClick={(e) => {
          e.stopPropagation()
          if (editingCutId === cut.id) {
            // 既に編集中なら何もしない
            return
          }
          if (selectedCutId === cut.id) {
            // 選択済みのカードをクリックしたら編集開始
            onStartEditing(cut.id)
          } else {
            // 未選択のカードをクリックしたら選択
            onSelectCut(cut.id)
          }
        }}
        className={`relative p-3 rounded border cursor-pointer ${
          selectedCutId === cut.id
            ? isDark
              ? 'bg-indigo-900/50 border-indigo-500 ring-2 ring-indigo-500'
              : 'bg-indigo-50 border-indigo-500 ring-2 ring-indigo-500'
            : isDark
              ? 'bg-gray-800/50 border-gray-600 hover:border-gray-500'
              : 'bg-white border-gray-300 hover:border-gray-400'
        } ${draggedCut?.cutId === cut.id ? 'opacity-50' : ''}`}
      >
        {/* ドラッグハンドル */}
        {editingCutId !== cut.id && (
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation()
              onCutDragStart(chapterId, sceneId, cut.id)
            }}
            onDragEnd={onCutDragEnd}
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
            カット{cutIndex + 1}
          </span>
        </div>

        {editingCutId === cut.id ? (
          <div
            ref={editingRef}
            className="space-y-2"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              value={cut.character}
              onChange={(e) => onCutChange(chapterId, sceneId, cut.id, 'character', e.target.value)}
              autoFocus
              placeholder="キャラクター名"
              className={`w-full px-2 py-1 text-sm font-semibold rounded border ${
                isDark
                  ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                  : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
              } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
            />
            <textarea
              value={cut.text}
              onChange={(e) => onCutChange(chapterId, sceneId, cut.id, 'text', e.target.value)}
              placeholder="テキスト"
              rows={3}
              className={`w-full px-2 py-1 text-sm rounded border resize-none ${
                isDark
                  ? 'bg-gray-700 text-gray-300 border-gray-600 focus:border-indigo-500'
                  : 'bg-white text-gray-700 border-gray-300 focus:border-indigo-500'
              } focus:outline-none focus:ring-1 focus:ring-indigo-500`}
            />
            <input
              type="text"
              value={cut.expression}
              onChange={(e) =>
                onCutChange(chapterId, sceneId, cut.id, 'expression', e.target.value)
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
                onDeleteCut(chapterId, sceneId, cut.id)
              }}
              className={`w-full px-2 py-1 text-xs rounded transition-colors ${
                isDark
                  ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70'
                  : 'bg-red-100 text-red-700 hover:bg-red-200'
              }`}
            >
              カットを削除
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <div
              className={`text-sm font-semibold ml-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
            >
              {cut.character || '（キャラクター名）'}
            </div>
            <div className={`text-xs ml-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {cut.text || '（テキスト）'}
            </div>
            {cut.expression && (
              <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                {cut.expression}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </>
  )
}

export default CutCard
