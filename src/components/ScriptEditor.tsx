import { Dispatch, SetStateAction } from 'react'
import { ScriptRow } from '../types'

interface ScriptEditorProps {
  scriptData: ScriptRow[]
  setScriptData: Dispatch<SetStateAction<ScriptRow[]>>
  selectedIndex: number
  setSelectedIndex: Dispatch<SetStateAction<number>>
}

function ScriptEditor({
  scriptData,
  setScriptData,
  selectedIndex,
  setSelectedIndex,
}: ScriptEditorProps) {
  const handleCellChange = (id: number, field: keyof ScriptRow, value: string) => {
    setScriptData(scriptData.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  const handleAddRow = () => {
    const newId = Math.max(...scriptData.map((row) => row.id), 0) + 1
    setScriptData([...scriptData, { id: newId, character: '', text: '', expression: '' }])
  }

  const handleDeleteRow = (id: number) => {
    if (scriptData.length > 1) {
      setScriptData(scriptData.filter((row) => row.id !== id))
    }
  }

  const handleMoveRow = (id: number, direction: 'up' | 'down') => {
    const index = scriptData.findIndex((row) => row.id === id)
    if (
      (direction === 'up' && index === 0) ||
      (direction === 'down' && index === scriptData.length - 1)
    ) {
      return
    }

    const newData = [...scriptData]
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    ;[newData[index], newData[targetIndex]] = [newData[targetIndex], newData[index]]
    setScriptData(newData)
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100 px-6 py-4">
        <button
          onClick={handleAddRow}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-medium rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
        >
          <span className="text-lg">➕</span>
          行を追加
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="min-w-max">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gradient-to-r from-slate-700 to-slate-800 text-white">
                <th className="px-4 py-3 text-left font-semibold text-sm w-16 border-r border-slate-600">
                  シーン
                </th>
                <th className="px-4 py-3 text-left font-semibold text-sm w-40 border-r border-slate-600">
                  キャラクター
                </th>
                <th className="px-4 py-3 text-left font-semibold text-sm min-w-[400px] border-r border-slate-600">
                  セリフ/テキスト
                </th>
                <th className="px-4 py-3 text-left font-semibold text-sm w-32 border-r border-slate-600">
                  表情/ポーズ
                </th>
                <th className="px-4 py-3 text-center font-semibold text-sm w-32">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {scriptData.map((row, index) => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedIndex(index)}
                  className={`group cursor-pointer transition-colors duration-150 ${
                    selectedIndex === index
                      ? 'bg-indigo-100 border-l-4 border-indigo-600'
                      : 'hover:bg-indigo-50/50'
                  }`}
                >
                  <td className="px-4 py-3 text-center font-semibold text-slate-500 bg-slate-50 group-hover:bg-indigo-100/50 border-r border-slate-200">
                    {index + 1}
                  </td>
                  <td className="px-2 py-2 border-r border-slate-200">
                    <input
                      type="text"
                      value={row.character}
                      onChange={(e) => handleCellChange(row.id, 'character', e.target.value)}
                      placeholder="キャラクター名"
                      className="w-full px-3 py-2 border border-transparent rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-transparent hover:bg-white hover:border-slate-300 transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-2 border-r border-slate-200">
                    <textarea
                      value={row.text}
                      onChange={(e) => handleCellChange(row.id, 'text', e.target.value)}
                      placeholder="セリフやナレーションを入力"
                      rows={2}
                      className="w-full px-3 py-2 border border-transparent rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-transparent hover:bg-white hover:border-slate-300 resize-y min-h-[60px] transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-2 border-r border-slate-200">
                    <input
                      type="text"
                      value={row.expression}
                      onChange={(e) => handleCellChange(row.id, 'expression', e.target.value)}
                      placeholder="表情"
                      className="w-full px-3 py-2 border border-transparent rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-transparent hover:bg-white hover:border-slate-300 transition-all duration-150"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => handleMoveRow(row.id, 'up')}
                        disabled={index === 0}
                        title="上に移動"
                        className="p-1.5 rounded-md hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-150"
                      >
                        <span className="text-lg">⬆</span>
                      </button>
                      <button
                        onClick={() => handleMoveRow(row.id, 'down')}
                        disabled={index === scriptData.length - 1}
                        title="下に移動"
                        className="p-1.5 rounded-md hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-150"
                      >
                        <span className="text-lg">⬇</span>
                      </button>
                      <button
                        onClick={() => handleDeleteRow(row.id)}
                        disabled={scriptData.length === 1}
                        title="削除"
                        className="p-1.5 rounded-md hover:bg-red-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-150"
                      >
                        <span className="text-lg">🗑</span>
                      </button>
                    </div>
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
