import { Dispatch, SetStateAction, useState } from 'react'
import { ScriptRow } from '../types'

interface ScriptEditorProps {
  scriptData: ScriptRow[]
  setScriptData: Dispatch<SetStateAction<ScriptRow[]>>
  selectedIndex: number
  setSelectedIndex: Dispatch<SetStateAction<number>>
  isDark: boolean
}

function ScriptEditor({
  scriptData,
  setScriptData,
  selectedIndex,
  setSelectedIndex,
  isDark,
}: ScriptEditorProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

  const handleCellChange = (id: number, field: keyof ScriptRow, value: string) => {
    setScriptData(scriptData.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  const handleAddRowAfter = (afterId: number) => {
    const newId = Math.max(...scriptData.map((row) => row.id), 0) + 1
    const index = scriptData.findIndex((row) => row.id === afterId)
    const newRow = { id: newId, character: '', text: '', expression: '' }
    const newData = [...scriptData.slice(0, index + 1), newRow, ...scriptData.slice(index + 1)]
    setScriptData(newData)
  }

  const handleDeleteRow = (id: number) => {
    if (scriptData.length > 1) {
      setScriptData(scriptData.filter((row) => row.id !== id))
    }
  }

  const handleDragStart = (index: number) => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== index) {
      setDropTargetIndex(index)
    }
  }

  const handleDragEnd = () => {
    if (draggedIndex !== null && dropTargetIndex !== null && draggedIndex !== dropTargetIndex) {
      const newData = [...scriptData]
      const [movedRow] = newData.splice(draggedIndex, 1)
      newData.splice(dropTargetIndex, 0, movedRow)
      setScriptData(newData)

      // 選択行のインデックスを更新
      if (selectedIndex === draggedIndex) {
        setSelectedIndex(dropTargetIndex)
      } else if (draggedIndex < selectedIndex && dropTargetIndex >= selectedIndex) {
        setSelectedIndex(selectedIndex - 1)
      } else if (draggedIndex > selectedIndex && dropTargetIndex <= selectedIndex) {
        setSelectedIndex(selectedIndex + 1)
      }
    }
    setDraggedIndex(null)
    setDropTargetIndex(null)
  }

  const handleDragLeave = () => {
    setDropTargetIndex(null)
  }

  return (
    <div className={`h-full overflow-auto ${isDark ? 'bg-gray-900' : 'bg-white'}`}>
      <div className="p-6">
        <div className="min-w-max">
          <table
            className={`w-full border-collapse border ${isDark ? 'border-gray-700' : 'border-slate-200'}`}
          >
            <thead className="sticky top-0 z-10">
              <tr
                className={
                  isDark
                    ? 'bg-gray-800 text-gray-200'
                    : 'bg-gradient-to-r from-slate-700 to-slate-800 text-white'
                }
              >
                <th
                  colSpan={3}
                  className={`px-2 py-2 text-center font-semibold text-sm border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  シーン
                </th>
                <th
                  rowSpan={2}
                  className={`px-4 py-3 text-center font-semibold text-sm w-32 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  キャラクター
                </th>
                <th
                  rowSpan={2}
                  className={`px-4 py-3 text-center font-semibold text-sm min-w-[250px] border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  テキスト
                </th>
                <th
                  rowSpan={2}
                  className={`px-4 py-3 text-center font-semibold text-sm w-24 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  ポーズ
                </th>
                <th
                  rowSpan={2}
                  className={`px-4 py-3 text-center font-semibold text-sm w-32 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  操作
                </th>
                <th
                  rowSpan={2}
                  className={`px-2 py-3 text-center font-semibold text-sm w-12 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  {/* つまみ列 */}
                </th>
              </tr>
              <tr
                className={
                  isDark
                    ? 'bg-gray-800 text-gray-200'
                    : 'bg-gradient-to-r from-slate-700 to-slate-800 text-white'
                }
              >
                <th
                  className={`px-2 py-2 text-center font-semibold text-xs w-12 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  章
                </th>
                <th
                  className={`px-2 py-2 text-center font-semibold text-xs w-12 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  場面
                </th>
                <th
                  className={`px-2 py-2 text-center font-semibold text-xs w-12 border ${
                    isDark ? 'border-gray-700' : 'border-slate-600'
                  }`}
                >
                  カット
                </th>
              </tr>
            </thead>
            <tbody className={isDark ? 'bg-gray-900' : 'bg-white'}>
              {scriptData.map((row, index) => (
                <tr
                  key={row.id}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  onDragLeave={handleDragLeave}
                  onClick={() => setSelectedIndex(index)}
                  className={`group cursor-pointer transition-colors duration-150 ${
                    selectedIndex === index
                      ? isDark
                        ? 'bg-indigo-900/40 border-l-4 border-indigo-400'
                        : 'bg-indigo-50 border-l-4 border-indigo-600'
                      : isDark
                        ? 'hover:bg-gray-800/50'
                        : 'hover:bg-indigo-50/30'
                  } ${draggedIndex === index ? 'opacity-50' : ''} ${
                    dropTargetIndex === index && draggedIndex !== index
                      ? isDark
                        ? 'border-t-2 border-t-indigo-400'
                        : 'border-t-2 border-t-indigo-600'
                      : ''
                  }`}
                >
                  <td
                    className={`px-2 py-2 text-center text-sm border ${isDark ? 'border-gray-700 text-gray-400' : 'border-slate-200 text-slate-500'}`}
                  >
                    1
                  </td>
                  <td
                    className={`px-2 py-2 text-center text-sm border ${isDark ? 'border-gray-700 text-gray-400' : 'border-slate-200 text-slate-500'}`}
                  >
                    1
                  </td>
                  <td
                    className={`px-2 py-2 text-center text-sm border ${isDark ? 'border-gray-700 text-gray-400' : 'border-slate-200 text-slate-500'}`}
                  >
                    {index + 1}
                  </td>
                  <td
                    className={`px-2 py-2 border ${isDark ? 'border-gray-700' : 'border-slate-200'}`}
                  >
                    <input
                      type="text"
                      value={row.character}
                      onChange={(e) => handleCellChange(row.id, 'character', e.target.value)}
                      placeholder="キャラクター名"
                      className={`w-full px-3 py-2 border border-transparent rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-transparent transition-all duration-150 ${
                        isDark
                          ? 'text-gray-200 placeholder-gray-500 hover:bg-gray-800 hover:border-gray-600'
                          : 'text-gray-900 hover:bg-white hover:border-slate-300'
                      }`}
                    />
                  </td>
                  <td
                    className={`px-2 py-2 border ${isDark ? 'border-gray-700' : 'border-slate-200'}`}
                  >
                    <textarea
                      value={row.text}
                      onChange={(e) => handleCellChange(row.id, 'text', e.target.value)}
                      placeholder="テキストを入力"
                      rows={2}
                      className={`w-full block px-3 py-2 border border-transparent rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-transparent resize-none transition-all duration-150 ${
                        isDark
                          ? 'text-gray-200 placeholder-gray-500 hover:bg-gray-800 hover:border-gray-600'
                          : 'text-gray-900 hover:bg-white hover:border-slate-300'
                      }`}
                    />
                  </td>
                  <td
                    className={`px-2 py-2 border ${isDark ? 'border-gray-700' : 'border-slate-200'}`}
                  >
                    <input
                      type="text"
                      value={row.expression}
                      onChange={(e) => handleCellChange(row.id, 'expression', e.target.value)}
                      placeholder="ポーズ"
                      className={`w-full px-3 py-2 border border-transparent rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-transparent transition-all duration-150 ${
                        isDark
                          ? 'text-gray-200 placeholder-gray-500 hover:bg-gray-800 hover:border-gray-600'
                          : 'text-gray-900 hover:bg-white hover:border-slate-300'
                      }`}
                    />
                  </td>
                  <td
                    className={`px-2 py-2 border ${isDark ? 'border-gray-700' : 'border-slate-200'}`}
                  >
                    <div className="flex flex-col items-center justify-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteRow(row.id)
                        }}
                        disabled={scriptData.length === 1}
                        title="削除"
                        className={`p-1.5 rounded-md disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-150 ${
                          isDark
                            ? 'text-gray-300 hover:bg-red-900/50'
                            : 'text-gray-700 hover:bg-red-100'
                        }`}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleAddRowAfter(row.id)
                        }}
                        title="この下に行を追加"
                        className={`px-2 py-1 rounded-md text-xs flex items-center gap-1 transition-colors duration-150 ${
                          isDark
                            ? 'text-gray-400 hover:text-gray-300 hover:bg-gray-700'
                            : 'text-gray-600 hover:text-gray-900 hover:bg-slate-200'
                        }`}
                      >
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4v16m8-8H4"
                          />
                        </svg>
                        <span>追加</span>
                      </button>
                    </div>
                  </td>
                  <td
                    className={`px-2 py-3 text-center border ${
                      draggedIndex === index ? 'cursor-grabbing' : 'cursor-grab'
                    } ${
                      isDark ? 'text-gray-500 border-gray-700' : 'text-slate-400 border-slate-200'
                    }`}
                  >
                    <svg className="w-4 h-4 mx-auto" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M9 3h2v2H9V3zm0 4h2v2H9V7zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm0 4h2v2H9v-2zm4-16h2v2h-2V3zm0 4h2v2h-2V7zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z" />
                    </svg>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default ScriptEditor
