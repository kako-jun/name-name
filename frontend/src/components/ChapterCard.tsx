import { motion } from 'framer-motion'
import { Chapter, Cut } from '../types'
import SceneCard from './SceneCard'

interface ChapterCardProps {
  chapter: Chapter
  chapterIndex: number
  isDark: boolean
  editingChapterId: number | null
  editingSceneId: number | null
  editingCutId: number | null
  newlyAddedCutId: number | null
  selectedCutId: number | null
  editingRef: React.RefObject<HTMLDivElement>
  draggedChapter: number | null
  chapterDropTarget: number | null
  draggedScene: { chapterId: number; sceneId: number } | null
  sceneDropTarget: { chapterId: number; position: number } | null
  draggedCut: { chapterId: number; sceneId: number; cutId: number } | null
  dropTarget: { chapterId: number; sceneId: number; position: number } | null
  onChapterTitleChange: (chapterId: number, title: string) => void
  onDeleteChapter: (chapterId: number) => void
  onStartEditingChapter: (chapterId: number) => void
  onChapterDragStart: (chapterId: number) => void
  onChapterDragEnd: () => void
  onChapterDragOver: (e: React.DragEvent, position: number) => void
  onChapterDrop: (e: React.DragEvent) => void
  onAddChapter: (position: number) => void
  onAddScene: (chapterId: number, position: number) => void
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

function ChapterCard({
  chapter,
  chapterIndex,
  isDark,
  editingChapterId,
  editingSceneId,
  editingCutId,
  newlyAddedCutId,
  selectedCutId,
  editingRef,
  draggedChapter,
  chapterDropTarget,
  draggedScene,
  sceneDropTarget,
  draggedCut,
  dropTarget,
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
  onAddCut,
  onCutChange,
  onDeleteCut,
  onStartEditingCut,
  onSelectCut,
  onCutDragStart,
  onCutDragEnd,
  onCutDragOver,
  onCutDrop,
}: ChapterCardProps) {
  return (
    <>
      {/* 章の追加ボタン（章がドラッグされている時だけ表示） */}
      {draggedChapter !== null && (
        <div
          draggable={false}
          className={`group w-12 flex-shrink-0 flex items-start justify-center pt-8 transition-all rounded cursor-pointer ${
            chapterDropTarget === chapterIndex
              ? isDark
                ? 'bg-indigo-900/40 border-2 border-indigo-400'
                : 'bg-indigo-100 border-2 border-indigo-600'
              : isDark
                ? 'bg-gray-700/20 hover:bg-gray-700/40'
                : 'bg-gray-200/50 hover:bg-gray-200'
          }`}
          onClick={() => onAddChapter(chapterIndex)}
          onDragOver={(e) => onChapterDragOver(e, chapterIndex)}
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
        layoutId={`chapter-${chapter.id}`}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className={`flex-shrink-0 w-96 p-6 rounded-lg shadow-lg ${
          isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-300'
        } ${draggedChapter === chapter.id ? 'opacity-50' : ''}`}
      >
        {/* 章のヘッダー */}
        <div className="relative mb-4">
          {/* ドラッグハンドル */}
          {editingChapterId !== chapter.id && (
            <div
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                onChapterDragStart(chapter.id)
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

          {editingChapterId === chapter.id ? (
            <div
              ref={editingRef}
              className="space-y-2"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={chapter.title}
                onChange={(e) => onChapterTitleChange(chapter.id, e.target.value)}
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
                  onDeleteChapter(chapter.id)
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
                onStartEditingChapter(chapter.id)
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
                  第{chapterIndex + 1}章
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
          {chapter.scenes.map((scene, sceneIndex) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              chapterId={chapter.id}
              sceneIndex={sceneIndex}
              isDark={isDark}
              editingSceneId={editingSceneId}
              editingCutId={editingCutId}
              newlyAddedCutId={newlyAddedCutId}
              selectedCutId={selectedCutId}
              editingRef={editingRef}
              draggedScene={draggedScene}
              sceneDropTarget={sceneDropTarget}
              draggedCut={draggedCut}
              dropTarget={dropTarget}
              onSceneTitleChange={onSceneTitleChange}
              onDeleteScene={onDeleteScene}
              onStartEditingScene={onStartEditingScene}
              onSceneDragStart={onSceneDragStart}
              onSceneDragEnd={onSceneDragEnd}
              onSceneDragOver={onSceneDragOver}
              onSceneDrop={onSceneDrop}
              onAddCut={onAddCut}
              onCutChange={onCutChange}
              onDeleteCut={onDeleteCut}
              onStartEditingCut={onStartEditingCut}
              onSelectCut={onSelectCut}
              onCutDragStart={onCutDragStart}
              onCutDragEnd={onCutDragEnd}
              onCutDragOver={onCutDragOver}
              onCutDrop={onCutDrop}
            />
          ))}

          {/* 最後のシーン追加ボタン（場面がドラッグされている時だけ表示） */}
          {draggedScene !== null && (
            <div
              draggable={false}
              className={`group h-6 flex items-center justify-center transition-all rounded cursor-pointer ${
                sceneDropTarget?.chapterId === chapter.id &&
                sceneDropTarget?.position === chapter.scenes.length
                  ? isDark
                    ? 'bg-indigo-900/40 border border-indigo-400'
                    : 'bg-indigo-100 border border-indigo-600'
                  : isDark
                    ? 'bg-gray-700/20 hover:bg-gray-700/40'
                    : 'bg-gray-200/50 hover:bg-gray-200'
              }`}
              onClick={() => onAddScene(chapter.id, chapter.scenes.length)}
              onDragOver={(e) => onSceneDragOver(e, chapter.id, chapter.scenes.length)}
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
