// 高さ編集タブのグリッド描画。
// Issue #91。各セルは下地タイル色 + 他レイヤ半透明 + 現レイヤ不透明の三層構成。
import { useState } from 'react'
import { MapData, TILE_COLORS, TileType } from '../../types/rpg'
import {
  ensureHeightGrid,
  formatHeightLabel,
  HeightField,
  HEIGHT_FALLBACKS,
  heightToBackgroundColor,
} from './heightUtils'

interface HeightGridProps {
  mapData: MapData
  currentField: HeightField
  layerVisibility: Record<HeightField, boolean>
  onPaintCell: (x: number, y: number) => void
  isDark: boolean
}

const HEIGHT_FIELDS: readonly HeightField[] = ['wallHeights', 'floorHeights', 'ceilingHeights']

function resolveCell(
  grid: number[][] | undefined,
  field: HeightField,
  x: number,
  y: number
): number {
  if (grid === undefined) return HEIGHT_FALLBACKS[field]
  const row = grid[y]
  if (row === undefined) return HEIGHT_FALLBACKS[field]
  const v = row[x]
  if (v === undefined) return HEIGHT_FALLBACKS[field]
  return v
}

function HeightGrid({
  mapData,
  currentField,
  layerVisibility,
  onPaintCell,
  isDark,
}: HeightGridProps) {
  const [isPainting, setIsPainting] = useState(false)

  const handleMouseDown = (x: number, y: number) => {
    setIsPainting(true)
    onPaintCell(x, y)
  }

  const handleMouseEnter = (x: number, y: number) => {
    if (isPainting) {
      onPaintCell(x, y)
    }
  }

  const handleMouseUp = () => {
    setIsPainting(false)
  }

  // 他レイヤ（layerVisibility が true で、現タブ以外のもの）
  const otherLayers = HEIGHT_FIELDS.filter((f) => f !== currentField && layerVisibility[f])

  // タブ切替で先に onChange 済みなら grid 存在。それでも defensive に resolveCell で fallback。
  const gridsByField: Record<HeightField, number[][] | undefined> = {
    wallHeights:
      mapData.wallHeights ?? ensureHeightGrid('wallHeights', mapData.width, mapData.height),
    floorHeights:
      mapData.floorHeights ?? ensureHeightGrid('floorHeights', mapData.width, mapData.height),
    ceilingHeights:
      mapData.ceilingHeights ?? ensureHeightGrid('ceilingHeights', mapData.width, mapData.height),
  }

  const cellBorderClass = isDark ? 'border-gray-700' : 'border-gray-600'

  return (
    <div
      className={`border-2 ${isDark ? 'border-gray-500' : 'border-gray-400'}`}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{
        display: 'grid',
        gridTemplateRows: `repeat(${mapData.height}, ${mapData.tileSize}px)`,
        gridTemplateColumns: `repeat(${mapData.width}, ${mapData.tileSize}px)`,
      }}
    >
      {mapData.tiles.map((row, y) =>
        row.map((tile, x) => {
          const currentValue = resolveCell(gridsByField[currentField], currentField, x, y)
          const currentColor = heightToBackgroundColor(currentField, currentValue)
          const tileColor = TILE_COLORS[tile as TileType]

          return (
            <div
              key={`${x}-${y}`}
              className={`relative border ${cellBorderClass} cursor-pointer hover:opacity-90 transition-opacity overflow-hidden`}
              style={{
                backgroundColor: tileColor,
              }}
              onMouseDown={() => handleMouseDown(x, y)}
              onMouseEnter={() => handleMouseEnter(x, y)}
              title={`(${x}, ${y}) ${currentField}=${formatHeightLabel(currentValue)}`}
            >
              {/* 他レイヤ（半透明） */}
              {otherLayers.map((f) => {
                const v = resolveCell(gridsByField[f], f, x, y)
                return (
                  <div
                    key={f}
                    className="absolute inset-0"
                    style={{
                      backgroundColor: heightToBackgroundColor(f, v),
                      opacity: 0.3,
                      pointerEvents: 'none',
                    }}
                  />
                )
              })}
              {/* 現レイヤ（不透明寄り） */}
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: currentColor,
                  opacity: 0.85,
                  pointerEvents: 'none',
                }}
              />
              {/* 数値ラベル */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{
                  fontSize: '10px',
                  color: '#ffffff',
                  textShadow:
                    '0 0 2px #000, 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000',
                  fontWeight: 600,
                }}
              >
                {formatHeightLabel(currentValue)}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

export default HeightGrid
