import { useEffect, useState } from 'react'
import { MapData, RPGProject, TileType, TILE_COLORS } from '../types/rpg'
import RPGPlayer from './RPGPlayer'

interface MapEditorProps {
  mapData: MapData
  rpgProject: RPGProject
  onChange: (mapData: MapData) => void
  isDark: boolean
}

const TILE_NAMES = {
  [TileType.GRASS]: '草地',
  [TileType.ROAD]: '道',
  [TileType.TREE]: '木',
  [TileType.WATER]: '水',
}

const PREVIEW_BUTTONS: ReadonlyArray<{
  view: 'raycast' | 'topdown'
  label: string
  darkClass: string
  lightClass: string
}> = [
  {
    view: 'raycast',
    label: 'Raycastでプレビュー',
    darkClass: 'bg-purple-700 text-white hover:bg-purple-600',
    lightClass: 'bg-purple-500 text-white hover:bg-purple-600',
  },
  {
    view: 'topdown',
    label: '見下ろしでプレビュー',
    darkClass: 'bg-emerald-700 text-white hover:bg-emerald-600',
    lightClass: 'bg-emerald-500 text-white hover:bg-emerald-600',
  },
]

function MapEditor({ mapData, rpgProject, onChange, isDark }: MapEditorProps) {
  const [selectedTile, setSelectedTile] = useState<TileType>(TileType.GRASS)
  const [isPainting, setIsPainting] = useState(false)
  const [previewView, setPreviewView] = useState<'topdown' | 'raycast' | null>(null)
  const isPreviewOpen = previewView !== null

  useEffect(() => {
    if (!isPreviewOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // IME 変換確定用の Esc でモーダルが閉じないようガード
      if (e.key === 'Escape' && !e.isComposing) {
        setPreviewView(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isPreviewOpen])

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
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            タイル選択:
          </span>
          <div className="flex gap-2">
            {Object.entries(TILE_NAMES).map(([type, name]) => {
              const tileType = parseInt(type) as TileType
              return (
                <button
                  key={type}
                  type="button"
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
          <div className="flex gap-2 ml-auto">
            {PREVIEW_BUTTONS.map((btn) => (
              <button
                key={btn.view}
                type="button"
                onClick={() => setPreviewView(btn.view)}
                className={`px-3 py-2 rounded text-sm transition-colors ${
                  isDark ? btn.darkClass : btn.lightClass
                }`}
              >
                {btn.label}
              </button>
            ))}
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

      {/* プレビューモーダル */}
      {previewView && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={previewView === 'raycast' ? 'Raycast プレビュー' : '見下ろし プレビュー'}
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewView(null)
          }}
        >
          <div
            className={`relative w-[90vw] h-[90vh] rounded-lg overflow-hidden ${isDark ? 'bg-gray-900' : 'bg-white'}`}
          >
            <button
              type="button"
              onClick={() => setPreviewView(null)}
              className="absolute top-2 right-2 z-10 px-3 py-1 rounded bg-gray-700 text-white hover:bg-gray-600"
              aria-label="プレビューを閉じる"
            >
              閉じる (Esc)
            </button>
            <div
              className={`absolute top-2 left-2 z-10 px-3 py-1 rounded text-sm ${isDark ? 'bg-gray-800 text-gray-200' : 'bg-gray-200 text-gray-800'}`}
            >
              {previewView === 'raycast' ? 'Raycast プレビュー' : '見下ろし プレビュー'}
            </div>
            <RPGPlayer gameData={rpgProject} view={previewView} />
          </div>
        </div>
      )}
    </div>
  )
}

export default MapEditor
