import { useState } from 'react'
import { NPCData, MapData, TILE_COLORS, TileType } from '../types/rpg'

interface NPCEditorProps {
  npcs: NPCData[]
  mapData: MapData
  onChange: (npcs: NPCData[]) => void
  isDark: boolean
}

function NPCEditor({ npcs, mapData, onChange, isDark }: NPCEditorProps) {
  const [selectedNPCId, setSelectedNPCId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newNPC, setNewNPC] = useState<Partial<NPCData>>({
    name: '',
    x: 5,
    y: 5,
    message: '',
    color: 0xff6b6b,
  })

  // IDから現在のNPCデータを引く（selectedNPCIdが古いデータを持ち続けるバグを防ぐ）
  const selectedNPC = selectedNPCId ? (npcs.find(n => n.id === selectedNPCId) ?? null) : null

  const handleAddNPC = () => {
    if (!newNPC.name || !newNPC.message) {
      alert('名前とメッセージを入力してください')
      return
    }

    const npc: NPCData = {
      id: `npc${Date.now()}`,
      name: newNPC.name!,
      x: newNPC.x ?? 5,
      y: newNPC.y ?? 5,
      message: newNPC.message!,
      color: newNPC.color ?? 0xff6b6b,
    }

    onChange([...npcs, npc])
    setNewNPC({ name: '', x: 5, y: 5, message: '', color: 0xff6b6b })
    setShowAddForm(false)
  }

  const handleDeleteNPC = (id: string) => {
    if (confirm('このNPCを削除しますか？')) {
      onChange(npcs.filter(n => n.id !== id))
      if (selectedNPCId === id) {
        setSelectedNPCId(null)
      }
    }
  }

  const handleUpdateNPC = (id: string, updates: Partial<NPCData>) => {
    onChange(npcs.map(n => (n.id === id ? { ...n, ...updates } : n)))
  }

  const handleMapClick = (x: number, y: number) => {
    if (selectedNPCId) {
      handleUpdateNPC(selectedNPCId, { x, y })
    }
  }

  return (
    <div className="h-full flex">
      {/* NPCリスト */}
      <div
        className={`w-80 border-r overflow-auto ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}
      >
        <div className={`p-4 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <h3 className={`font-semibold mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>NPCリスト</h3>
          <button
            onClick={() => setShowAddForm(true)}
            className={`w-full py-2 px-4 rounded font-medium transition-colors ${
              isDark
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
            }`}
          >
            + NPC追加
          </button>
        </div>

        <div className="p-2">
          {npcs.length === 0 ? (
            <p className={`text-center py-8 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              NPCがまだありません
            </p>
          ) : (
            npcs.map(npc => (
              <div
                key={npc.id}
                onClick={() => setSelectedNPCId(npc.id)}
                className={`p-3 mb-2 rounded cursor-pointer transition-colors ${
                  selectedNPCId === npc.id
                    ? isDark
                      ? 'bg-blue-900 border-blue-700'
                      : 'bg-blue-100 border-blue-300'
                    : isDark
                      ? 'bg-gray-700 hover:bg-gray-600'
                      : 'bg-gray-100 hover:bg-gray-200'
                } border`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{npc.name}</span>
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      handleDeleteNPC(npc.id)
                    }}
                    className={`text-xs px-2 py-1 rounded ${
                      isDark
                        ? 'bg-red-600 hover:bg-red-700 text-white'
                        : 'bg-red-500 hover:bg-red-600 text-white'
                    }`}
                  >
                    削除
                  </button>
                </div>
                <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  位置: ({npc.x}, {npc.y})
                </div>
                <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {npc.message.substring(0, 30)}
                  {npc.message.length > 30 ? '...' : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* マップビュー */}
      <div className={`flex-1 overflow-auto p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        {selectedNPC ? (
          <div className="mb-4">
            <div className={`text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              「{selectedNPC.name}」の配置: マップをクリックして位置を変更
            </div>
          </div>
        ) : (
          <div className={`mb-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            NPCを選択してマップ上に配置してください
          </div>
        )}

        <div className="inline-block">
          <div
            className="border-2 border-gray-400"
            style={{
              display: 'grid',
              gridTemplateRows: `repeat(${mapData.height}, ${mapData.tileSize}px)`,
              gridTemplateColumns: `repeat(${mapData.width}, ${mapData.tileSize}px)`,
            }}
          >
            {mapData.tiles.map((row, y) =>
              row.map((tile, x) => {
                const npcHere = npcs.find(n => n.x === x && n.y === y)
                const isSelected = selectedNPC && selectedNPC.x === x && selectedNPC.y === y

                return (
                  <div
                    key={`${x}-${y}`}
                    className={`border border-gray-600 cursor-pointer transition-all ${
                      isSelected ? 'ring-2 ring-blue-500' : ''
                    }`}
                    style={{
                      backgroundColor: npcHere
                        ? `#${npcHere.color.toString(16).padStart(6, '0')}`
                        : TILE_COLORS[tile as TileType] ?? TILE_COLORS[TileType.GRASS],
                    }}
                    onClick={() => handleMapClick(x, y)}
                    title={npcHere ? `${npcHere.name} (${x}, ${y})` : `(${x}, ${y})`}
                  >
                    {npcHere && (
                      <div className="flex items-center justify-center h-full text-white text-xs font-bold">
                        {npcHere.name[0] ?? '?'}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* NPC追加フォーム */}
      {showAddForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div
            className={`p-6 rounded-lg shadow-xl max-w-md w-full ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
          >
            <h2 className="text-xl font-bold mb-4">NPC追加</h2>
            <div className="space-y-4">
              <div>
                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  名前
                </label>
                <input
                  type="text"
                  value={newNPC.name}
                  onChange={e => setNewNPC({ ...newNPC, name: e.target.value })}
                  className={`w-full px-3 py-2 border rounded ${
                    isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                  }`}
                  placeholder="村人"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    X座標
                  </label>
                  <input
                    type="number"
                    value={newNPC.x}
                    onChange={e => setNewNPC({ ...newNPC, x: parseInt(e.target.value) ?? 0 })}
                    className={`w-full px-3 py-2 border rounded ${
                      isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                    }`}
                  />
                </div>
                <div>
                  <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    Y座標
                  </label>
                  <input
                    type="number"
                    value={newNPC.y}
                    onChange={e => setNewNPC({ ...newNPC, y: parseInt(e.target.value) ?? 0 })}
                    className={`w-full px-3 py-2 border rounded ${
                      isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                    }`}
                  />
                </div>
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  メッセージ
                </label>
                <textarea
                  value={newNPC.message}
                  onChange={e => setNewNPC({ ...newNPC, message: e.target.value })}
                  className={`w-full px-3 py-2 border rounded ${
                    isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                  }`}
                  rows={3}
                  placeholder="こんにちは！"
                />
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  色 (16進数)
                </label>
                <input
                  type="text"
                  value={`#${newNPC.color?.toString(16).padStart(6, '0')}`}
                  onChange={e => {
                    const hex = e.target.value.replace('#', '')
                    const num = parseInt(hex, 16)
                    if (!isNaN(num)) {
                      setNewNPC({ ...newNPC, color: num })
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded ${
                    isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                  }`}
                  placeholder="#ff6b6b"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setShowAddForm(false)}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                キャンセル
              </button>
              <button
                onClick={handleAddNPC}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-blue-500 hover:bg-blue-600 text-white'
                }`}
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default NPCEditor
