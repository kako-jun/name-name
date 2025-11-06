import { motion } from 'framer-motion'
import { Scene, Cut } from '../types'
import CutCard from './CutCard'

interface SceneCardProps {
  scene: Scene
  chapterId: number
  sceneIndex: number
  isDark: boolean
  editingSceneId: number | null
  editingCutId: number | null
  newlyAddedCutId: number | null
  selectedCutId: number | null
  editingRef: React.RefObject<HTMLDivElement>
  draggedScene: { chapterId: number; sceneId: number } | null
  sceneDropTarget: { chapterId: number; position: number } | null
  draggedCut: { chapterId: number; sceneId: number; cutId: number } | null
  dropTarget: { chapterId: number; sceneId: number; position: number } | null
  onSceneTitleChange: (chapterId: number, sceneId: number, title: string) => void
  onDeleteScene: (chapterId: number, sceneId: number) => void
  onStartEditingScene: (sceneId: number) => void
  onSceneDragStart: (chapterId: number, sceneId: number) => void
  onSceneDragEnd: () => void
  onSceneDragOver: (e: React.DragEvent, chapterId: number, position: number) => void
  onSceneDrop: (e: React.DragEvent) => void
  onAddCut: (chapterId: number, sceneId: number, position: number) => void
  onCutChange: (
    chapterId: number,
    sceneId: number,
    cutId: number,
    field: keyof Cut,
    value: string
  ) => void
  onDeleteCut: (chapterId: number, sceneId: number, cutId: number) => void
  onStartEditingCut: (cutId: number) => void
  onSelectCut: (cutId: number) => void
  onCutDragStart: (chapterId: number, sceneId: number, cutId: number) => void
  onCutDragEnd: () => void
  onCutDragOver: (e: React.DragEvent, chapterId: number, sceneId: number, position: number) => void
  onCutDrop: (e: React.DragEvent) => void
}

function SceneCard({
  scene,
  chapterId,
  sceneIndex,
  isDark,
  editingSceneId,
  editingCutId,
  newlyAddedCutId,
  selectedCutId,
  editingRef,
  draggedScene,
  sceneDropTarget,
  draggedCut,
  dropTarget,
  onSceneTitleChange,
  onDeleteScene,
  onStartEditingScene,
  onSceneDragStart,
  onSceneDragEnd,
  onSceneDragOver,
  onSceneDrop,
  onAddCut,
  onCutChange,
  onDeleteCut,
  onStartEditingCut,
  onSelectCut,
  onCutDragStart,
  onCutDragEnd,
  onCutDragOver,
  onCutDrop,
}: SceneCardProps) {
  return (
    <>
      {/* シーンのドロップ領域（場面がドラッグされている時だけ表示） */}
      {draggedScene !== null && (
        <div
          className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
            sceneDropTarget?.chapterId === chapterId && sceneDropTarget?.position === sceneIndex
              ? isDark
                ? 'bg-indigo-900/40 border border-indigo-400'
                : 'bg-indigo-100 border border-indigo-600'
              : isDark
                ? 'bg-gray-700/20 hover:bg-gray-700/40'
                : 'bg-gray-200/50 hover:bg-gray-200'
          }`}
          onDragOver={(e) => onSceneDragOver(e, chapterId, sceneIndex)}
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
        } ${draggedScene?.sceneId === scene.id ? 'opacity-50' : ''}`}
      >
        {/* シーンのヘッダー */}
        <div className="relative mb-2">
          {/* ドラッグハンドル */}
          {editingSceneId !== scene.id && (
            <div
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                onSceneDragStart(chapterId, scene.id)
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

          {editingSceneId === scene.id ? (
            <div
              ref={editingRef}
              className="space-y-2"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={scene.title}
                onChange={(e) => onSceneTitleChange(chapterId, scene.id, e.target.value)}
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
                  onDeleteScene(chapterId, scene.id)
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
                onStartEditingScene(scene.id)
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
                  シーン{sceneIndex + 1}
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

        {/* カット一覧 */}
        <div className="space-y-2">
          {scene.cuts.map((cut, cutIndex) => (
            <CutCard
              key={cut.id}
              cut={cut}
              chapterId={chapterId}
              sceneId={scene.id}
              cutIndex={cutIndex}
              isDark={isDark}
              editingCutId={editingCutId}
              newlyAddedCutId={newlyAddedCutId}
              selectedCutId={selectedCutId}
              editingRef={editingRef}
              draggedCut={draggedCut}
              dropTarget={dropTarget}
              onCutChange={onCutChange}
              onDeleteCut={onDeleteCut}
              onStartEditing={onStartEditingCut}
              onSelectCut={onSelectCut}
              onCutDragStart={onCutDragStart}
              onCutDragEnd={onCutDragEnd}
              onCutDragOver={onCutDragOver}
              onCutDrop={onCutDrop}
            />
          ))}

          {/* 最後のカット追加ボタン（カットがドラッグされている時だけ表示） */}
          {draggedCut !== null && (
            <div
              draggable={false}
              className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
                dropTarget?.chapterId === chapterId &&
                dropTarget?.sceneId === scene.id &&
                dropTarget?.position === scene.cuts.length
                  ? isDark
                    ? 'bg-indigo-900/40 border border-indigo-400'
                    : 'bg-indigo-100 border border-indigo-600'
                  : isDark
                    ? 'bg-gray-700/20 hover:bg-gray-700/40'
                    : 'bg-gray-200/50 hover:bg-gray-200'
              }`}
              onClick={() => onAddCut(chapterId, scene.id, scene.cuts.length)}
              onDragOver={(e) => onCutDragOver(e, chapterId, scene.id, scene.cuts.length)}
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
        </div>
      </motion.div>
    </>
  )
}

export default SceneCard
