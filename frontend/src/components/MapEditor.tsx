import { useState } from 'react'
import { MapData, TileType, TILE_COLORS } from '../types/rpg'

interface MapEditorProps {
  mapData: MapData
  onChange: (mapData: MapData) => void
  isDark: boolean
}

const TILE_NAMES = {
  [TileType.GRASS]: '草地',
  [TileType.ROAD]: '道',
  [TileType.TREE]: '木',
  [TileType.WATER]: '水',
}

function MapEditor({ mapData, onChange, isDark }: MapEditorProps) {
  const [selectedTile, setSelectedTile] = useState<TileType>(TileType.GRASS)
  const [isPainting, setIsPainting] = useState(false)

  const handleTileClick = (x: number, y: number) => {
    const newTiles = mapData.tiles.map((row, rowIndex) =>
      row.map((tile, colIndex) => (rowIndex === y && colIndex === x ? selectedTile : tile))
    )

    onChange({
      ...mapData,
      tiles: newTiles,
    })
  }

  const handleTileMouseDown = (x: number, y: number) => {
    setIsPainting(true)
    handleTileClick(x, y)
  }

  const handleTileMouseEnter = (x: number, y: number) => {
    if (isPainting) {
      handleTileClick(x, y)
    }
  }

  const handleMouseUp = () => {
    setIsPainting(false)
  }

  return (
    <div className="h-full flex flex-col">
      {/* タイルパレット */}
      <div
        className={`p-4 border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}
      >
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            タイル選択:
          </span>
          <div className="flex gap-2">
            {Object.entries(TILE_NAMES).map(([type, name]) => {
              const tileType = parseInt(type) as TileType
              return (
                <button
                  key={type}
                  onClick={() => setSelectedTile(tileType)}
                  className={`px-3 py-2 rounded flex items-center gap-2 transition-colors ${
                    selectedTile === tileType
                      ? isDark
                        ? 'bg-blue-600 text-white'
                        : 'bg-blue-500 text-white'
                      : isDark
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  <div
                    className="w-4 h-4 border border-black"
                    style={{ backgroundColor: TILE_COLORS[tileType] }}
                  />
                  <span className="text-sm">{name}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* マップグリッド */}
      <div className={`flex-1 overflow-auto p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        <div className="inline-block">
          <div
            className="border-2 border-gray-400"
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{
              display: 'grid',
              gridTemplateRows: `repeat(${mapData.height}, ${mapData.tileSize}px)`,
              gridTemplateColumns: `repeat(${mapData.width}, ${mapData.tileSize}px)`,
            }}
          >
            {mapData.tiles.map((row, y) =>
              row.map((tile, x) => (
                <div
                  key={`${x}-${y}`}
                  className="border border-gray-600 cursor-pointer hover:opacity-80 transition-opacity"
                  style={{
                    backgroundColor: TILE_COLORS[tile as TileType],
                  }}
                  onMouseDown={() => handleTileMouseDown(x, y)}
                  onMouseEnter={() => handleTileMouseEnter(x, y)}
                  title={`(${x}, ${y}): ${TILE_NAMES[tile as TileType]}`}
                />
              ))
            )}
          </div>
          <div className={`mt-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            マップサイズ: {mapData.width} x {mapData.height} タイル
          </div>
        </div>
      </div>
    </div>
  )
}

export default MapEditor
